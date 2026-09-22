# Product Requirements Document (PRD): Origin Private File System (OPFS) Storage Pivot & Transactional Turn Rollback

**Status:** RATIFIED  
**Last verified: 2026-09-17**  
**Version:** 1.0  
**Date:** 2026-09-14  
**Scope Owner:** Product Owner & Core System Architect  
**Related Systems:** `src/lib/sandbox/storage/`, `src/lib/sandbox/virtualFs/index.ts`, `src/lib/sandbox/runtime/index.ts`, `src/lib/sandbox/sandboxStore/index.svelte.ts`, `src/lib/components/sandbox/`

---

## 1. Executive Summary & Objective

This document codifies the requirements for migrating the current in-memory dictionary-backed `VirtualFS` to a high-performance, browser-native **Origin Private File System (OPFS)** storage subsystem.

> **Target-state (not implemented) — 2026-09-17:** The `src/lib/sandbox/storage/` driver layer, the `IStorageDriver` abstraction, and the turn snapshot journal have not landed. `src/lib/sandbox/virtualFs/index.ts` remains in-memory. The requirements below describe the intended target state; delivered behavior is limited to the turn-level undo/redo message rollback.

### Key Strategic Objectives
1. **Eliminate Heap RAM Bloat & 5MB Quota Limits**: Move files from in-memory JavaScript string graphs to disk-backed browser OPFS storage, supporting multi-gigabyte files (world bibles, transcripts, datasets) without memory exhaustion.
2. **Native Random-Access Byte Slicing**: Enable zero-copy `file.slice(offset, offset + limit)` for $O(1)$ memory pagination of large files.
3. **Turn-Level File Mutation Rollback (Undo/Redo)**: Implement Write-Ahead Turn Snapshot Journaling so that `undoAgentTurn` restores modified files, recreates deleted files, and purges newly created files in lockstep with message history.
4. **100% Zero-Mock Node.js Test Suite Compatibility**: Provide a unified `IStorageDriver` interface backed by `OpfsStorageDriver` (in browsers) and `NodeFsStorageDriver` (using `node:fs/promises` in `os.tmpdir()`), ensuring all existing CLI test suites (`npm test`) execute against real disk storage with zero mock objects.
5. **Svelte 5 Lazy UI Loading**: Modernize `sandboxStore/index.svelte.ts` to hold metadata-only manifests, lazily fetching file contents only when selected in the editor.

---

## 2. System Architecture & Component Model

```mermaid
graph TD
    subgraph UI_And_Runtime ["Application & Agent Runtime Layer"]
        AR[AgentRuntime / Dispatcher]
        SS[sandboxStore/index.svelte.ts]
        VFE[VirtualFsExplorer.svelte]
    end

    subgraph Domain_VirtualFS ["Layer 2: Domain VirtualFS (High-Level Engine)"]
        VFS[VirtualFS Core]
        JSON[JSON Keypath & RFC 6902 Patch]
        BUDGET[Token/Byte Output Budgeting & Slicing]
        PERM[Permission & Workspace ACL Validator]
        JOURNAL[Turn Rollback & WAL Journal Manager]
    end

    subgraph Storage_Engine ["Layer 1: StorageEngine (Path & Directory Abstraction)"]
        SE[StorageEngine]
        CAT[Metadata Catalog & Cache]
    end

    subgraph Storage_Drivers ["Layer 0: Pluggable Storage Drivers (IStorageDriver)"]
        OPFS_D[OpfsStorageDriver<br/>(Browser OPFS / W3C Handles)]
        NODE_D[NodeFsStorageDriver<br/>(Node.js node:fs/promises)]
        MEM_D[MemoryStorageDriver<br/>(Headless Fast Unit Tests)]
    end

    AR --> VFS
    SS --> VFS
    VFE -.->|Lazy Read| VFS
    VFS --> PERM
    VFS --> BUDGET
    VFS --> JSON
    VFS --> JOURNAL
    VFS --> SE
    SE --> CAT
    SE --> OPFS_D
    SE --> NODE_D
    SE --> MEM_D
```

---

## 3. Directory Layout & Partitioning

```
OPFS Root (/):
├── .system/
│   ├── metadata/
│   │   └── catalog.json              # System ACLs, file ownership, readOnly flags
│   └── journals/
│       └── {agentId}/
│           └── {turnId}/
│               ├── pre/              # Pre-turn snapshots of modified/deleted files
│               └── post/             # Post-turn snapshots for redo
├── global/                           # Shared / public workspace (/global/*, /public/*)
│   ├── world_lore.md
│   └── timeline.json
└── workspaces/                       # Private agent workspaces
    ├── agent_alice/
    │   └── draft_chapter_1.md
    └── agent_bob/
        └── critique.json
```

---

## 4. Functional Requirements

### 4.1 Universal Storage Driver Abstraction (`IStorageDriver`)

* **DRV-1 — Universal Driver Interface**:
  All storage drivers must implement the standardized asynchronous interface:
  * `init()`: Initializes root directories and checks storage health.
  * `exists(workspaceId, filePath)`: Returns boolean existence.
  * `readFile(workspaceId, filePath, options)`: Returns UTF-8 string or binary `Uint8Array`.
  * `readSlice(workspaceId, filePath, offset, length)`: Returns sliced byte slice directly without loading the full file.
  * `writeFile(workspaceId, filePath, content, options)`: Atomic stream write with `createWritable()`.
  * `deleteFile(workspaceId, filePath)`: Deletes individual file.
  * `deleteDirectory(workspaceId, dirPath, options)`: Recursively deletes folder.
  * `listEntries(workspaceId, dirPath)`: Returns directory children `{ name, isDirectory, size, updatedAt }`.
  * `copyFile(srcWs, srcPath, destWs, destPath)`: Fast file copying.
  * `clearWorkspace(workspaceId)`: Clears all files in a specific workspace.

* **DRV-2 — Pluggable Multi-Environment Drivers**:
  1. **`OpfsStorageDriver`**: Native browser implementation using `navigator.storage.getDirectory()`, `FileSystemDirectoryHandle`, `FileSystemFileHandle`, and `createWritable()`.
  2. **`NodeFsStorageDriver`**: Native Node.js disk implementation using `node:fs/promises` in `node:os.tmpdir()` for 100% zero-mock CLI test execution.
  3. **`MemoryStorageDriver`**: In-memory byte-buffer implementation for fast volatile unit test isolation.

---

### 4.2 Turn-Level File Undo/Redo & Rollback (ROLLBACK)

* **ROLL-1 — Write-Ahead Turn Snapshot Journaling**:
  * When an agent turn begins, `AgentRuntime` initializes a turn journal session (`beginTurn(agentId, turnId)`).
  * Before any mutating tool (`writeFile`, `replaceFileContent`, `jsonPatch`, `deleteFile`, `copyFile`) alters a file:
    * If the file exists: snapshot its pre-mutation state into `/.system/journals/{agentId}/{turnId}/pre/`.
    * If the file is newly created: record `{ operation: 'create', filePath, workspaceId }`.
  * Upon turn completion, the journal manifest is attached to `turnBundle.fileJournal`.

* **ROLL-2 — Atomic Turn Undo (`undoAgentTurn`)**:
  * When `undoAgentTurn(agentId)` is invoked:
    * Files newly created during that turn are **deleted**.
    * Files modified or deleted during that turn are **restored verbatim** from the turn pre-snapshot.
    * Post-undo states are preserved in `/.system/journals/{agentId}/{turnId}/post/` to enable redo.

* **ROLL-3 — Atomic Turn Redo (`redoAgentTurn`)**:
  * When `redoAgentTurn(agentId)` is invoked:
    * Re-applies all post-turn file snapshots in lockstep with redone conversation messages.

* **ROLL-4 — Journal Garbage Collection**:
  * When a new prompt is sent, discarded redo stacks are purged and their OPFS journal snapshots are asynchronously deleted.

---

### 4.3 Off-Heap Byte Slicing & Pagination (PAGINATION)

* **PAGE-1 — True Disk Slicing**:
  * Slicing large files (e.g. 50MB lore documents) uses native browser blob slicing:
    ```javascript
    const file = await fileHandle.getFile();
    const sliceBlob = file.slice(offset, offset + limit);
    const text = await sliceBlob.text();
    ```
  * Allocates only the requested byte window into JavaScript heap memory ($O(\text{slice})$ complexity).
* **PAGE-2 — Pagination Metadata**:
  * Accurately calculates `totalBytes`, `bytesRead`, `remainingBytes`, `truncated: true`, and `nextOffset` from disk file metadata.

---

### 4.4 Centralized Metadata & Security ACLs (SECURITY)

* **SEC-1 — Central Metadata Catalog**:
  * File permissions (`readOnly`, `owner`, `createdAt`, `updatedAt`, `version`) are stored in `/.system/metadata/catalog.json` and cached in memory.
* **SEC-2 — Universal Read-Only Protection**:
  * Modifying or deleting a read-only global file throws `PermissionDeniedError`.
* **SEC-3 — Path Normalization & POSIX Jailing**:
  * Normalizes `/global/` vs `/public/` aliases and prevents directory traversal attacks (`..`, prototype pollution keys `__proto__`, `constructor`).

---

### 4.5 Reactive UI Store Modernization (UI)

* **UI-1 — Metadata-Only Manifest in Store**:
  * `sandboxStore.fsManifest` holds file metadata only, preventing megabytes of file contents from cloning into Svelte 5 reactive proxies.
* **UI-2 — Lazy File Loading in `VirtualFsExplorer.svelte`**:
  * Clicking a file in the explorer lazily reads its content on-demand via `sandboxStore.readFileContent(path)`.
* **UI-3 — Streaming File Downloads**:
  * File and workspace downloads stream directly from OPFS via `URL.createObjectURL(fileBlob)` without loading text into the store.

---

## 5. Acceptance Criteria

1. **[AC-OPFS-01] Universal Driver Parity**: `OpfsStorageDriver`, `NodeFsStorageDriver`, and `MemoryStorageDriver` pass 100% of driver interface compliance tests.
2. **[AC-OPFS-02] Zero-Mock Node.js Execution**: All existing and new test suites pass cleanly under `NodeFsStorageDriver` with zero mock objects.
3. **[AC-OPFS-03] Turn Rollback on Undo**: Calling `undoAgentTurn` after file creation/modification restores the exact pre-turn filesystem state.
4. **[AC-OPFS-04] Turn Restoration on Redo**: Calling `redoAgentTurn` re-applies all file states corresponding to the redone turn.
5. **[AC-OPFS-05] Off-Heap Slicing**: Reading a 50MB file with `offset: 20000, limit: 10000` loads only 10KB into JavaScript heap memory.
6. **[AC-OPFS-06] Atomic Writes**: Interrupted file writes leave existing files intact via atomic swap files.
7. **[AC-OPFS-07] Universal Read-Only Enforcement**: Non-privileged attempts to modify read-only files in global or private workspaces are denied.
8. **[AC-OPFS-08] Lazy UI Explorer**: `VirtualFsExplorer` renders directory trees from metadata and fetches file text lazily upon selection.
9. **[AC-OPFS-09] Clean Build & Regression Gate**: `npm run build` exits 0 and all cumulative regression tests pass with 0 failures.
