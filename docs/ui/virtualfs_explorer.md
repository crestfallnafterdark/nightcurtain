# Virtual Filesystem Explorer Architecture

**Status:** CANONICAL
**Last verified: 2026-09-22**

> [!NOTE]
> This document specifies the technical architecture, interactive file tree navigation, AST JSON keypath querying, regex line grep, USTAR archive packaging, and drag-and-drop ingestion within `VirtualFsExplorer.svelte`.

---

## 1. Architectural Overview

The **Virtual Filesystem Explorer** provides full multi-tenant workspace management, real-time file viewing, binary/JSON manipulation, structured AST querying, and archive export/import within the Studio UI.

```mermaid
flowchart TD
    subgraph ExplorerRoot ["VirtualFsExplorer.svelte"]
        WorkspaceBar["Workspace Selector Toolbar\n(Realm-grouped operator partitions:\nShared 'global' | <Realm> · global | <Realm> · <agent> | Workspaces)"]
        BulkBar["Bulk Action Bar (Selected Files: Archive | Separate | Delete | Clear)"]
        DragOverlay["Drag-and-Drop Upload Overlay (Full Viewport)"]
        TransferBanner["Archiving & Transfer Notification Banner"]
        StatusToast["Transfer Progress / Status Toast"]

        subgraph Panes ["Split-Pane Workstation"]
            subgraph LeftPane ["Left Pane: Workspace File List"]
                FileHeader["Select All Checkbox | Workspace Files Count | Upload/Archive Actions"]
                FilesTable["Files Table:\n- Checkbox Cell\n- Path & Read-Only Badge (RO)\n- Formatted Size (B / KB / MB)\n- Owner Badge\n- Actions (Download | Copy | Delete)"]
            end

            subgraph RightPanes ["Right Panes: Viewer & Tools"]
                ViewerCard["File Content Viewer Card:\n- Path, Size, Read-Only Tag\n- Format JSON Toggle\n- Monospaced Code View\n- Inline Download, Copy, Delete"]
                JsonWidget["Structured AST JSON KeyPath Query Widget:\n- KeyPath Input (e.g. $.targets[0].id)\n- Query KeyPath Action\n- Formatted Result Box"]
                GrepWidget["Regex & Text Line Grep Widget:\n- Pattern Input & Regex Toggle\n- Search Grep Action\n- Clickable Matches Feed (File:Line)"]
            end
        end

        subgraph Modals ["Modals"]
            NewFileModal["Create New File Modal (Path, Content, Read-Only)"]
            CopyFileModal["Copy / Duplicate File Modal (Target Workspace, Dest Path, Overwrite)"]
        end
    end

    WorkspaceBar --> Panes
    BulkBar --> Panes
    LeftPane <--> RightPanes
    ExplorerRoot -.-> NewFileModal
    ExplorerRoot -.-> CopyFileModal
```

---

## 2. Multi-Tenant Workspace Partitioning

The filesystem architecture enforces strict multi-tenant workspace isolation:

1. **`global` (Shared Workspace)**: Accessible by all agents for mission coordination, telemetry exchange, and shared status reports. Root configuration files can be marked **Read-Only** (`readOnly: true`).
2. **Realm-global partitions (`realm:<realmId>:global`)**: Each Realm's shared workspace. Realm-bound members resolve their `global` alias onto this partition; the operator explorer lists one partition per registered Realm (uploadable even while empty).
3. **Private Agent Workspaces**: Sandboxed per-agent storage directories, keyed by the resolved private workspace (a Realm-bound agent's canonical identity key, an explicit workspace pin, or the legacy bare agent id). Non-privileged agents cannot write across partitions without universal `sudo` authority.

### 2.1 Operator partition listing (ticket 7571ce5)

`VirtualFsExplorer.svelte` renders `sandboxStore.fsWorkspacePartitions` — the **operator-scoped** projection of the VirtualFS snapshot — instead of the agent-facing `allWorkspaces` labels:

- each entry carries `{ key, label, realmId, realmName, kind, fileCount }`: the internal snapshot key for exact addressing, a realm-qualified display label, the Realm scope, the partition kind (`global` | `realm-global` | `agent` | `workspace`), and the file count read from the resolved key (never from a projected label);
- realm-global partitions are selectable, viewable, uploadable, and downloadable — a Realm's `global` bytes no longer collide with the literal shared `global` workspace;
- the same bare agent id live in two Realms yields two distinct partitions (distinct realm-qualified labels, distinct keys, distinct counts);
- `groupFsPartitionsByRealm()` (`realmGroups.ts`) groups the listing into **Shared** → registered Realm groups (registry order) → unregistered/synthetic Realm groups → trailing **Workspaces** group; realm-global partitions sort before their agents, then by label;
- `sandboxStore.activeFsWorkspace` holds the selected **partition key**; `sandboxStore.activeFsPartition` exposes its descriptor. The agent-facing `allWorkspaces` projection stays realm-opaque and is not consumed by the explorer.

```mermaid
graph LR
    subgraph GlobalWS ["Workspace: 'global' (Shared)"]
        G1["/mission_report.json (owner: agent-scout)"]
        G2["/orders.json (owner: agent-commander)"]
        G3["/event_list.json (owner: system)"]
    end

    subgraph RealmGlobalWS ["Workspace: 'realm:alpha:global' (Realm alpha)"]
        R1["/source_tree/*.md (operator-seeded)"]
    end

    subgraph ScoutWS ["Workspace: 'realm:alpha:scout' (Private, Realm alpha)"]
        S1["/telemetry_raw.log"]
        S2["/sensor_cache.json"]
    end

    subgraph CommanderWS ["Workspace: 'agent-commander' (Private pin)"]
        C1["/tactical_matrix.json"]
    end

    GlobalWS <-->|Read & Write| ScoutWS
    RealmGlobalWS <-->|Realm-bound alias 'global'| ScoutWS
    ScoutWS -.->|Cross-Workspace Blocked without Sudo| CommanderWS
```

---

## 3. Reactive State & Properties

### 3.1 Local State Variables (`$state()`)

| State Variable | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `selectedFilePath` | `string \| null` | `null` | Absolute path of the currently inspected file. |
| `isFormattedJson` | `boolean` | `true` | When true, parses and pretty-prints JSON file contents. |
| `showCreateModal` | `boolean` | `false` | Controls visibility of the New File modal. |
| `newFilePath` | `string` | `'/data.json'` | Bound path input in the New File modal. |
| `newFileContent` | `string` | `{\n  "status": "ready"\n}` | Initial content in the New File modal. |
| `newFileReadOnly` | `boolean` | `false` | Read-only flag in the New File modal (for global workspace). |
| `showCopyModal` | `boolean` | `false` | Controls visibility of the Copy File modal. |
| `copySrcFile` | `FileMeta \| null` | `null` | Source file metadata object being duplicated. |
| `copyDestPath` | `string` | `''` | Destination file path for copy operations. |
| `copyDestWorkspace` | `string` | `'global'` | Destination workspace ID for copy operations. |
| `copyOverwrite` | `boolean` | `true` | Overwrite flag for copy operations. |
| `selectedFilePaths` | `Set<string>` | `new Set()` | Set of file paths selected for multi-file bulk operations. |
| `jsonKeyPath` | `string` | `''` | Bound AST JSON query expression (e.g. `$.targets[0].id`). |
| `jsonQueryResult` | `any` | `null` | Evaluated output of the AST JSON query. |
| `jsonQueryError` | `string \| null` | `null` | Diagnostic error message from AST evaluation. |
| `grepPattern` | `string` | `''` | Search string or regex pattern for line-by-line grep. |
| `grepIsRegex` | `boolean` | `false` | Flag toggling regex evaluation vs literal substring search. |
| `grepResults` | `Array<Match> \| null` | `null` | List of matching line objects with paths and line numbers. |
| `grepError` | `string \| null` | `null` | Diagnostic error message from regex evaluation. |
| `showDownloadMenu` | `boolean` | `false` | Dropdown visibility state for workspace export actions. |
| `showUploadMenu` | `boolean` | `false` | Dropdown visibility state for file/folder import actions. |
| `isTransferring` | `boolean` | `false` | True while an upload, download, or archive packaging is in progress. |
| `isDraggingOver` | `boolean` | `false` | True when files or folders are dragged over the viewport. |
| `transferStatus` | `string \| null` | `null` | Status string displayed in the floating toast. |
| `transferError` | `Object \| null` | `null` | Error payload displayed in the notification banner. |
| `transferProgress` | `{ current, total, file }` | `{ current: 0, total: 0, file: '' }` | Real-time progress counters for bulk downloads/uploads. |
| `fileInputRef` | `HTMLElement \| null` | `null` | DOM reference to the hidden multi-file `<input type="file">` used by `handleTriggerUploadFiles()`. |
| `folderInputRef` | `HTMLElement \| null` | `null` | DOM reference to the hidden folder input (`webkitdirectory`) used by `handleTriggerUploadFolder()`. |

### 3.2 Derived State (`$derived` / `$derived.by()`)

- **`currentWorkspace`**: `$derived(sandboxStore.activeFsWorkspace)` — the selected operator partition key.
- **`currentPartition`**: `$derived(sandboxStore.activeFsPartition)` — the selected partition descriptor (label, Realm, kind, file count).
- **`currentWorkspaceLabel`**: `$derived(currentPartition ? currentPartition.label : currentWorkspace)` — display-only label used by menus, confirmations, modals, and status toasts.
- **`snapshotKey`**: `$derived(currentPartition ? currentPartition.key : currentWorkspace)` — resolved internal key used for direct snapshot reads (a persisted legacy label resolves to its partition).
- **`partitionGroups`**: `$derived(groupFsPartitionsByRealm(sandboxStore.fsWorkspacePartitions, sandboxStore.realms))` — the realm-grouped pill projection.
- **`files`**: `$derived(sandboxStore.activeFsFiles)` (sorted alphabetically by file path).
- **`isAllSelected`**: `$derived(files.length > 0 && selectedFilePaths.size === files.length)`.
- **`selectedFile`**: Retrieves the full file object from `sandboxStore.fsSnapshot[snapshotKey][selectedFilePath]`.

---

## 4. Archiving, Export & Ingestion Engine (`fsDownloadUtils/index.ts`)

The Studio includes an archive creation and extraction engine that handles client-side file packaging and folder uploads.

```mermaid
flowchart TD
    subgraph Ingestion ["Upload & Ingestion Pipeline"]
        Drop["Drag & Drop / Folder Picker"] --> Extract["extractFilesFromDataTransfer()"]
        Extract --> Read["processUploadedFiles() (FileReader UTF-8 / Base64)"]
        Read --> StoreWrite["sandboxStore.uploadFiles()"]
        StoreWrite --> VFS["VirtualFS.writeFile()"]
    end

    subgraph Packaging ["Download & Export Pipeline"]
        UserReq["User Export Request\nhandleDownloadSelectedArchive()"] --> ArchiveBlob["downloadFolderAsArchive() → createArchiveBlob()\n(fsDownloadUtils/index.ts)"]
        ArchiveBlob -->|"ZIP engine exposes a callable createZipBlob (ZipWriter / zip.ZipWriter / JSZip / ZipArchive)"| ZipGen["Engine createZipBlob() (.zip)"]
        ArchiveBlob -->|"CompressionStream('gzip') available"| TarGen["createTarByteArray() (fsDownloadUtils/index.ts) → .tar.gz"]
        ArchiveBlob -->|None available| Fallback["downloadFilesSeparately() (Sequential Downloads)"]
        ZipGen --> Download["Trigger Browser File Download"]
        TarGen --> Download
    end
```

### 4.1 USTAR / `.tar.gz` Packaging Specification

When `CompressionStream('gzip')` is supported natively in modern browsers, files are packed into standard **POSIX USTAR (Uniform Standard Tape Archive)** blocks:

- **512-Byte Header Blocks**:
  - `0–99`: File name (null-padded string).
  - `100–107`: File mode (`0000644\0`).
  - `108–115`: Owner UID (`0000000\0`).
  - `116–123`: Group GID (`0000000\0`).
  - `124–135`: Octal file size in bytes (`00000000000\0`).
  - `136–147`: Modification timestamp in octal seconds.
  - `148–155`: Checksum calculated across header block with checksum field initialized to spaces.
  - `156`: Type flag (`0` for regular file).
  - `257–262`: USTAR magic string (`ustar\0`).
  - `263–264`: USTAR version (`00`).
- **Content Padding**: File data is padded with null bytes to align with 512-byte block boundaries.
- **Archive Trailer**: Terminated by two consecutive 512-byte null blocks.
- **Compression**: Piped through `new CompressionStream('gzip')` to produce standard `.tar.gz` archives.

---

## 5. Live Search & Structured Query Widgets

### 5.1 Structured AST JSON KeyPath Query Widget

Evaluates structured object paths without invoking JavaScript `eval()` or risking script injection:

- **Dot Notation**: `targets.0.id`, `sector`, `metadata.timestamp`.
- **JSONPath Syntax**: `$.targets[0].id`, `$.status`.
- **Root Query**: Empty path returns full formatted root object.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant Widget as VirtualFsExplorer.svelte
    participant Store as SandboxStore
    participant VFS as VirtualFS (virtualFs/)

    User->>Widget: Enters "$.targets[0].id" and clicks "Query KeyPath"
    Widget->>Store: queryJson(selectedFilePath, "$.targets[0].id", currentWorkspace)
    Store->>VFS: queryJson(workspaceId, filePath, keyPath)
    VFS->>VFS: AST Path Parse (Tokenizes brackets, dots, indices)
    VFS-->>Store: Returns evaluated value ("T-101")
    Store-->>Widget: jsonQueryResult = "T-101"
    Widget->>Widget: Displays formatted JSON output
```

### 5.2 Regex & Line Grep Widget

Scans all text and JSON files within the active workspace partition:

- **Pattern Matching**: Evaluates substring matches or regular expressions (`new RegExp(grepPattern)`).
- **Interactive Match List**: Displays matching lines with line numbers (`/orders.json:4`). Clicking any match automatically sets `selectedFilePath` to focus the target file in the viewer.

---

## 6. Two-Way Simulation State Synchronization

Modifying specific files triggers automated synchronization with the narrative simulation runtime:

- **`/event_list.json`**:
  - `writeFile()`: Synchronously syncs into `sandboxStore.worldClock.syncFromVirtualFs(workspaceId)`.
  - `deleteFile()`: Purges in-memory event registry partition via `worldClock.clearEvents()`.
- **`/world_clock.json`**:
  - `writeFile()`: Re-indexes narrative clock time in `worldClock`.
  - `deleteFile()`: Resets simulation time to `00:00:00 Day 1` via `worldClock.resetClock()`.

---

## 7. Interaction & Action Reference Table

| Action Trigger | Component Method | Description |
| :--- | :--- | :--- |
| Click Workspace Pill | `selectWorkspace(partitionKey)` | Switches the active operator partition (internal key from `fsWorkspacePartitions`), resets selection and query states. |
| Checkbox Toggle | `toggleSelectFile(path)` | Adds or removes file path from `selectedFilePaths` set. |
| Select All Checkbox | `toggleSelectAll()` | Selects or deselects all files in the current workspace. |
| Click Download Single | `handleDownloadSingleFile(f)` | Dispatches individual file download. |
| Click Copy File | `openCopyModal(f)` | Opens Copy File modal with prefilled duplicate path (`_copy.ext`). |
| Click Delete File | `handleDeleteFile(path)` | Confirms and removes file from VirtualFS. |
| Bulk Download Archive | `handleDownloadSelectedArchive()` | Packages selected files into a `.zip` or `.tar.gz` archive via `downloadFolderAsArchive()` → `createArchiveBlob()`. |
| Bulk Download Separate | `handleDownloadSelectedSeparately()` | Downloads each selected file sequentially with progress toast. |
| Bulk Delete Files | `handleDeleteSelected()` | Batch deletes selected files from the current workspace. |
| Upload Folder | `handleTriggerUploadFolder()` | Opens folder selection dialog (`webkitdirectory`). |
| Upload Files | `handleTriggerUploadFiles()` | Opens multiple file selection dialog. |
| Drop Files / Folders | `handleDrop(e)` | Recursively extracts files from DataTransfer and writes to workspace. |

---

## 8. Sibling Documentation Links

- [Studio Architecture Overview](./studio_overview.md) - Workstation layout and Svelte 5 runes.
- [Agent Inspector Architecture](./agent_inspector.md) - Telemetry and trace monitoring.
- [Chat Studio & Message Cards](./chat_and_message_cards.md) - Conversational message stream and tool cards.
- [Messaging Bus Viewer](./messaging_bus_viewer.md) - Inter-agent message traces and mailboxes.
- [Modals & Dialogs Architecture](./modals_and_dialogs.md) - Configuration modals and action inputs.
