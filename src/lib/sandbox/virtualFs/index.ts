/**
 * @packageDocumentation
 * Module `virtualFs`.
 * Provides an isolated, multi-tenant POSIX-like virtual storage substrate.
 * Manages in-memory workspaces partitioned into private agent environments and a shared global workspace,
 * guaranteeing tenant isolation, fine-grained access control, surgical content manipulation,
 * structured AST/jq querying, RFC 6902 atomic JSON patching, byte/word-budgeted output truncation,
 * and prompt template expansion.
 *
 * @module virtualFs
 * @mayImport buffer
 * @mayImport fast-json-patch
 * @mayImport jsonpath-plus
 * @invariant Tenant isolation and ACL: a private workspace is accessible only when the caller id matches the workspace id or the caller holds a privileged principal; anonymous callers are denied (`PermissionDeniedError`); the `global`/`public` workspaces (including the legacy `global`/`public` id aliases) are shared, while a `/global/`/`/public/` path prefix never downgrades the ACL class of a foreign private workspace — the class derives from the effective workspace only; `readOnly` files reject mutation unless the caller is the file owner, a privileged principal, or supplies `force` in a private workspace; `readOnly`/`mode`/`permissions` mutation requires a resolvable caller with file-owner, workspace-owner, or privileged-principal authority (anonymous default-deny even in `global`), and owner reassignment additionally requires a privileged principal or current-owner authority; denied permission mutations leave `readOnly`/`mode`/`owner`/`permissions` untouched.
 * @invariant Tenant administration is principal-gated (MOD-21, default-deny): `deleteWorkspace`, `reset`, `exportSnapshot`, `importSnapshot`, and `forAgent` require the exact reference injected as `VirtualFSOptions.internalPrincipal` (`options.principal`) or an identity-port `AuthorityDescriptor` for `options.callerAgentId`/`options.agentId` granting cross-workspace authority; anonymous callers, caller-asserted flags, and plain lookalike principal objects are denied with `PermissionDeniedError` before any eviction, clear, disclosure, hydration, or proxy minting; an injected instance that never received the option binds the composition root's exact reference once via `bindInternalPrincipal` (first bind wins, never rebound).
 * @invariant Reserved workspace protection: `deleteWorkspace` refuses (returns `false`, no eviction) the shared `global`/`public` workspaces and every realm-global partition key shaped `realm:<realmId>:global`, even for an authorized internal principal, so agent-visible lifecycle eviction can never destroy shared or realm-scoped state; controlled Realm deletion belongs to the operator Realm path, not to this member. The vocabulary is owned here and exposed as the exported `isReservedWorkspaceKey` predicate, the single canonical source consulted by launch-side always-shadowed enforcement.
 * @invariant Realm boundary: a realm-bound caller (identity projection carrying a non-empty `realmId` with no `realmBypass`) resolves every shared alias (`global`, the retired unscoped `public`, and the `/global/`/`/public/` path prefixes) to its realm-global workspace `realm:<realmId>:global`, may access its own private workspace and its realm-global workspace (members write it), and may access same-realm member private workspaces only when it also resolves cross-workspace authority — its own realm and the realm-global key are the entire reachable scope, and every cross-realm target is denied with `PermissionDeniedError` unless the caller is the injected internal principal or carries a `realmBypass` projection; the same boundary gates the workspace-targeting tenant-administration members (`deleteWorkspace`, `forAgent`) and `listWorkspaces`/`hasWorkspace`/wildcard-`grep` enumeration, while the inherently all-workspace members stay operator-level: `reset` and `exportSnapshot` refuse realm-bound callers outright (clearing or exporting spans every realm's state, so even cross-workspace `*` authority cannot escape the realm), and `importSnapshot` inherits the refusal transitively through `reset`. A supplied-but-unresolvable caller context fails closed for enumeration (empty list / `false`), never falling back to the unscoped legacy span. Ungrouped callers (no `realmId` projection) keep the legacy ACL unchanged, and stored workspace keys are never renamed.
 * @invariant Realm-local identity keying: an agent's private workspace key resolves through the injected identity projection — an explicit `workspaceId` pin (a projected value differing from the bare id and the canonical key) is preserved verbatim, a realm-bound projection (non-empty `realmId`) keys on its canonical identity `key`, and ungrouped/system-scope projections keep the legacy bare agent id, so the same literal id in two realms owns two distinct private workspaces while single-realm sessions keep byte-identical stored keys; `/agents/<id>` mounts and workspace targeting resolve bare ids realm-exactly for realm-bound callers (a foreign or unresolvable id is not-found, no existence oracle), bypass/operator contexts resolve the unique match across realms, and every agent-visible surface masks canonical-key-shaped storage keys to the bare id through `publicWorkspaceKey`/`opaqueRealmText`. Legacy bare-key private workspaces keep working: legacy/ungrouped projections still key bare, and a realm-qualified caller recovers hydrated legacy bytes through `remapLegacyWorkspaceKeys`/`rekeyLegacyPrivateWorkspaces`, which rename bare keys onto the canonical identity without dropping any file — the store-hydration seam documented on those surfaces.
 * @invariant Canonical identity keys are internal-only: `realm:<realmId>:<agentId>` / `system:<agentId>` storage keys and the `callerKey` trusted-context channel never appear in a tool parameter, receipt, listing label, error, or payload; consumers that surface a workspace identity project the bare `id` (a projection-supplied `key` is matched, never echoed). `callerKey` is honored only from the trusted context (or an explicit host enumeration option) and a supplied-but-unresolvable key fails closed instead of falling back to the bare-id channel.
 * @invariant Resolved privilege rule (MOD-21, default-deny): cross-workspace authority comes only from (a) the exact reference injected as `VirtualFSOptions.internalPrincipal` at `options.principal`, or (b) `VirtualFSOptions.identityPort.getAgentIdentity(callerAgentId)` resolving a frozen `AuthorityDescriptor` whose `visibility` is `'all'`/`'system'` or whose `allow` set carries the `'*'` wildcard. Per-call `isAdmin`/`privileged`/`isPrivileged`/`callerRole` flags and descriptor-shaped claims are stripped from both the caller payload and the trailing context and confer nothing; a port projection carrying a descriptor without a grant fails closed, and the legacy projection `privileged` boolean is honored only as a fallback when the projection carries no `authority` descriptor.
 * @invariant Every path is canonicalized through `normalizeVirtualPath`: backslashes become `/`, a leading `/` is enforced, `.`/`..` segments resolve without escaping the virtual root, and empty/invalid input normalizes to `/`.
 * @invariant `patchJson` applies RFC 6902 operations atomically in memory with lenient auto-upsert for intermediate containers; a failing operation aborts the patch and the stored file is left byte-identical (zero changes persisted).
 * @invariant Read output is bounded by the instance byte budget (`defaultBudgetBytes`, default 20,000 bytes) unless `budgetBytes` is supplied; `offset`/`limit` and continuation `nextOffset` are measured in UTF-16 code units (not bytes); a supplied `maxWords` caps delivered content words and, absent `budgetBytes`, also acts as a conservative 6-bytes/word byte budget; truncation reports `truncated: true` with `nextOffset`/`nextLine` continuation cues; when the word budget is exhausted inside one long line the cut is mid-line and `nextLine` must be resumed together with `nextOffset`, while a cut exactly on a line boundary reports the first undelivered line with no `nextOffset`; every emitted continuation token strictly advances (structured/non-raw reads), while `raw: true` returns the bare string with no continuation metadata, bypasses the byte budget for whole-file reads (`budgetBytes`/`limit` are honored only when `offset` or `startLine` is supplied), and may truncate silently under a word budget.
 * @invariant `copyFile` checks read access on the source and write access on the destination, overwrites by default (only `overwrite: false` raises `FileExistsError`), and carries the source's `readOnly`/`mode`/`permissions` unless overridden.
 * @decision D1=A: `VirtualFS` stays a public, contracted substrate; the full instance may cross module boundaries as a sanctioned substrate handoff (e.g. `renderTemplateWithFiles`) instead of a narrow port
 * @decision Workspace-ACL authority resolves from a principal only: the frozen agent `AuthorityDescriptor` through the injected identity port, or the opaque `InternalPrincipal` reference injected as `VirtualFSOptions.internalPrincipal`; caller-asserted flags and reserved ids confer nothing
 * @decision `grep` with `workspaceId: '*'` is scoped by principal: privileged principals scan every workspace; unprivileged callers scan only their own workspace plus `'global'`
 * @decision ACL classification derives from the effective workspace id only: a `/global/`/`/public/` path prefix (or filter path) is never an ACL input, so a caller cannot reach a foreign private workspace by prefixing the path
 * @decision Tenant-administration members (`deleteWorkspace`, `reset`, `exportSnapshot`, `importSnapshot`, `forAgent`) resolve a principal from the trusted sources only and default-deny anonymous callers, so no caller can evict, replace, or read another tenant's workspace without the injected `internalPrincipal` reference or a cross-workspace identity-port descriptor
 * @decision Object-first caller identity is context-bound: when the trailing trusted context object is supplied (even one binding `callerAgentId: null`), the payload's `callerAgentId`/`caller_agent_id`/`agentId` keys never select or replace the identity a workspace ACL, wildcard-grep scope, or read-only owner check authorizes against — the effective caller is the context's own identity or `null`, so an anonymous context stays anonymous; context-less direct-API object calls keep the legacy payload identity channel, and VFS tool descriptors strip identity keys from sanitized parameters before delegating
 * @decision Identity-selecting VFS reads (`query_json`/`grep` object-first forms) authorize against the context-resolved caller only, so a payload identity claim can neither read a foreign private workspace nor widen the wildcard-grep scope
 * @decision Read-only owner checks in `replaceFileContent`/`patchJson` use the same context-resolved caller as every sibling mutation, so a payload identity claim cannot overwrite another owner's read-only file
 * @decision The reserved workspace-key vocabulary (`global`, `public`, `realm:<realmId>:global`) is owned by this module and exported as the `isReservedWorkspaceKey` predicate; consumers treat reserved shapes as always-shadowed through this single canonical source rather than duplicating the pattern
 * @decision The realm-global workspace key is `realm:<realmId>:global`, resolved from the injected identity projection: realm-bound callers alias `global`/`public` and the `/global/`/`/public/` path prefixes onto that key for both ACL and storage, while ungrouped callers keep the literal `global` — stored keys are never renamed
 * @decision The legacy unscoped `public` alias is retired: `public` is no longer a distinct shared namespace and folds into the caller's shared-global handling (`global`, or `realm:<realmId>:global` when realm-bound); `isReservedWorkspaceKey('public')` stays true so lifecycle eviction still cannot destroy legacy public bytes
 * @decision Enumeration surfaces (`listWorkspaces`, `hasWorkspace`) and wildcard-`grep` (`workspaceId: '*'`) are realm-confined for realm-bound callers — realm-global plus own workspace, plus same-realm member workspaces for cross-workspace authority holders — while context-free substrate calls and the injected internal principal / `realmBypass` projections keep the legacy unscoped span; a supplied-but-unresolvable caller context fails closed (empty list / `false`) rather than falling back to that span. The all-workspace snapshot pair remains operator-level and is not realm-scoped: `exportSnapshot` refuses realm-bound callers outright (a full snapshot spans every realm's bytes; internal principal and `realmBypass` only) and `importSnapshot` inherits the refusal through `reset`
 * @decision Realm-qualified private workspace storage: a realm-bound agent's default private workspace key is its canonical identity (`AgentIdentityProjection.key`), an explicit projected `workspaceId` pin stays verbatim, and ungrouped/system-scope agents keep the legacy bare id; explicit workspace references, `/agents` mounts, and tenant-administration targets resolve bare ids realm-exactly through the injected port (bypass/operator contexts resolve the unique match across realms and fail closed on ambiguity), while context-free and legacy bare-key workspaces stay literal. Legacy snapshots remap through the exported pure helper (`remapLegacyWorkspaceKeys`) or the in-memory operator method (`rekeyLegacyPrivateWorkspaces`), merging path-wise and never dropping a record
 */

import { Buffer } from 'buffer';
import * as jsonpatchModule from 'fast-json-patch';
const jsonpatch = jsonpatchModule.default || jsonpatchModule;
import { JSONPath } from 'jsonpath-plus';

// ============================================================================
// 0. Internal & JSON Types
// ============================================================================

/**
 * JSON-compatible value accepted and returned by the structured JSON surfaces:
 * RFC 6902 patch values, JSON writes, and query results.
 *
 * @example
 * ```typescript
 * const data: JsonValue = { title: 'Aria', skills: ['fire', 'heal'] };
 * ```
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Mutable file metadata stored in the per-workspace maps (public read shape: {@link FileRecord}). */
interface FileMetadata {
  path: string;
  workspaceId: string;
  content: string;
  size: number;
  updatedAt: number;
  readOnly: boolean;
  owner: string;
  mode?: string;
  permissions?: Record<string, unknown>;
}

/** Runtime listing entry: the public {@link FileListItem} plus the tenant tag emitted by `listFiles`. */
type FileListEntry = FileListItem & { workspaceId?: string };

/** Lexical token produced by {@link tokenizeJq}. */
interface JqToken {
  type: string;
  value?: string | number | boolean | null;
}

/** Path segment produced by the jq recursive-descent parser. */
type JqPathSegment =
  | { type: 'field'; name: string | number }
  | { type: 'index'; index: number }
  | { type: 'slice'; start: string | number; end?: number }
  | { type: 'iterator' };

/** Object-constructor entry produced by the jq parser. */
interface JqObjectEntry {
  key: string;
  value?: JqNode;
  shorthand: boolean;
}

/** AST node produced by {@link parseJq}. */
type JqNode =
  | { type: 'Identity' }
  | { type: 'Literal'; value: JsonValue }
  | { type: 'Path'; base?: JqNode; segments: JqPathSegment[] }
  | { type: 'ArrayConstructor'; expr: JqNode | null }
  | { type: 'ObjectConstructor'; entries: JqObjectEntry[] }
  | { type: 'Pipeline'; left: JqNode; right: JqNode }
  | { type: 'BinaryOp'; op: string; left: JqNode; right: JqNode }
  | { type: 'UnaryOp'; op: string; expr: JqNode }
  | { type: 'FunctionCall'; name: string; args: JqNode[] };

/** Dynamic (JSON-shaped) property read preserving JS property-access semantics. */
function dynamicGet(target: unknown, key: string | number | undefined): JsonValue | undefined {
  return (target as Record<string, JsonValue | undefined>)[String(key)];
}

/** Dynamic (JSON-shaped) property write preserving JS assignment semantics. */
function dynamicSet(target: unknown, key: string | number | undefined, value: JsonValue): void {
  (target as Record<string, JsonValue | undefined>)[String(key)] = value;
}

/** Dynamic (JSON-shaped) property delete preserving JS delete semantics. */
function dynamicDelete(target: unknown, key: string | number | undefined): void {
  delete (target as Record<string, JsonValue | undefined>)[String(key)];
}

/**
 * Extracts a human-readable message from an unknown thrown value without altering
 * the message a native `Error` would surface.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(err);
}

/**
 * Extracts a human-readable error name from an unknown thrown value, or `''` when
 * the value carries no string `name`.
 */
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

// ============================================================================
// 1. Core Storage & File Models
// ============================================================================

/**
 * Core representation of an individual file in virtual storage containing raw content and metadata.
 *
 * @example
 * ```typescript
 * const record: FileRecord = {
 *   path: '/lore/world_rules.md',
 *   workspaceId: 'global',
 *   content: '# World Rules\nMagic requires energy transfer.',
 *   size: 47,
 *   updatedAt: 1726531200000,
 *   readOnly: true,
 *   owner: 'director'
 * };
 * ```
 */
export interface FileRecord {
  /** Canonical normalized virtual path starting with a leading slash (e.g. '/lore/codex.json'). */
  readonly path: string;
  /** Workspace identifier where this file resides (e.g. 'global', 'agent_writer'). */
  readonly workspaceId: string;
  /** Raw text or string-serialized JSON content of the file. */
  readonly content: string;
  /** Byte size of UTF-8 encoded file content. */
  readonly size: number;
  /** Millisecond epoch timestamp of last modification. */
  readonly updatedAt: number;
  /** Whether this file is protected against overwriting by non-owner / unprivileged callers. */
  readonly readOnly: boolean;
  /** Identifier of the agent or system entity that owns this file. */
  readonly owner: string;
  /** Optional POSIX permission mode string (e.g. '0644') carried by the file metadata. */
  readonly mode?: string;
  /** Optional structured permission attributes carried by the file metadata. */
  readonly permissions?: Record<string, unknown>;
}

/**
 * Directory listing item representing either a regular file or a computed virtual directory.
 *
 * @example
 * ```typescript
 * const item: FileListItem = {
 *   path: '/lore/factions',
 *   name: 'factions',
 *   type: 'directory',
 *   size: 0,
 *   updatedAt: 1726531200000,
 *   readOnly: false,
 *   owner: 'system',
 *   childCount: 4
 * };
 * ```
 */
export interface FileListItem {
  /** Canonical normalized virtual path. */
  readonly path: string;
  /** Basename of the file or directory. */
  readonly name: string;
  /** Entry classification: 'file' for regular files, 'directory' for folder containers. */
  readonly type: 'file' | 'directory';
  /** Byte size of the file, or 0 for directories. */
  readonly size: number;
  /** Millisecond epoch timestamp of last update. */
  readonly updatedAt: number;
  /** Whether the item is protected against unauthorized mutations. */
  readonly readOnly: boolean;
  /** Identity of the owning agent or system. */
  readonly owner: string;
  /** Number of direct child items when `type === 'directory'`. */
  readonly childCount?: number;
}

/**
 * Full serializable state snapshot of all workspaces and their file maps.
 * Structured as `Record<workspaceId, Record<normalizedPath, FileRecord>>`.
 *
 * @example
 * ```typescript
 * const snapshot: VirtualFsSnapshot = virtualFs.exportSnapshot({ principal: internalPrincipal });
 * virtualFs.importSnapshot(snapshot, { principal: internalPrincipal });
 * ```
 */
export type VirtualFsSnapshot = Record<string, Record<string, FileRecord>>;

/**
 * Backward compatibility alias for {@link FileListItem}.
 */
export type VfsFileMetadata = FileListItem;

// ============================================================================
// 2. Options & Context Interfaces
// ============================================================================

/**
 * Base security context and tenant routing options passed to VirtualFS operations.
 *
 * @example
 * ```typescript
 * const opts: VirtualFsAccessOptions = {
 *   workspaceId: 'agent_storyteller',
 *   callerAgentId: 'agent_storyteller',
 *   callerRole: 'writer'
 * };
 * ```
 */
export interface VirtualFsAccessOptions {
  /** Target workspace identifier (defaults to 'global' if omitted or if path starts with '/global/'). */
  workspaceId?: string;
  /** Identity of the agent requesting the operation for access control verification. */
  callerAgentId?: string;
  /**
   * Role classification of the caller (e.g. 'director', 'writer', 'system').
   * @deprecated Role is metadata only and never confers workspace authority (MOD-21 W4); the principal model replaced authority-bearing roles.
   */
  callerRole?: string;
  /**
   * Engine-internal principal reference (MOD-21). Honored only when it is the
   * exact object injected as `VirtualFSOptions.internalPrincipal`; plain
   * objects, flag bundles, and reserved-id strings never satisfy it.
   */
  principal?: object;
  /**
   * Whether caller has administrative privileges bypassing tenant isolation and read-only locks.
   * @deprecated Caller-asserted privilege no longer confers any authority (MOD-21 W4); use the injected identity port or internal principal.
   */
  isAdmin?: boolean;
  /**
   * Synonym for `isAdmin`; no longer honored.
   * @deprecated Caller-asserted privilege no longer confers any authority (MOD-21 W4).
   */
  isPrivileged?: boolean;
  /** Whether to force mutation overriding non-global read-only flags. */
  force?: boolean;
}

/**
 * Principal options for the principal-gated tenant-administration members
 * (`deleteWorkspace`, `reset`, `exportSnapshot`, `importSnapshot`, `forAgent`).
 *
 * Interface `VirtualFsAdminOptions`.
 * - `principal` (`object`) - The exact reference injected as `VirtualFSOptions.internalPrincipal`; the only direct authority source.
 * - `callerAgentId` (`string`) - Claimed subject resolved through the injected identity port; only a descriptor granting cross-workspace authority authorizes.
 * - `agentId` (`string`) - Fallback alias for `callerAgentId`.
 *
 * @example
 * ```typescript
 * const snapshot = virtualFs.exportSnapshot({ principal: internalPrincipal });
 * ```
 */
export interface VirtualFsAdminOptions {
  /** Exact injected internal-principal reference; lookalike objects never authorize. */
  principal?: object;
  /** Claimed caller subject resolved through the injected identity port. */
  callerAgentId?: string;
  /** Fallback alias for `callerAgentId`. */
  agentId?: string;
}

/**
 * Caller context for the realm-scoped enumeration surfaces (`listWorkspaces`,
 * `hasWorkspace`) added by Realm wave A ticket 49cfc41.
 *
 * When a caller context is supplied and the caller resolves realm-bound through
 * the injected identity port, enumeration is confined to its realm scope
 * (realm-global plus own workspace, plus same-realm member workspaces for
 * cross-workspace authority holders). Context-free substrate calls keep the
 * legacy unscoped span, so engine/UI enumeration is unchanged. A supplied
 * context the identity port cannot resolve (unknown subject, port throw,
 * explicit `null`/empty claim, or a lookalike principal) fails closed: an
 * empty list from `listWorkspaces`, `false` from `hasWorkspace`.
 *
 * @example
 * ```typescript
 * const workspaces = virtualFs.listWorkspaces({ callerAgentId: 'agent_scout' });
 * ```
 */
export interface VirtualFsEnumerationOptions {
  /** Claimed caller subject resolved through the injected identity port. */
  callerAgentId?: string;
  /** Fallback alias for `callerAgentId`. */
  agentId?: string;
  /** Exact injected internal-principal reference; bypasses the realm confinement. */
  principal?: object;
}

/**
 * Options for reading files with offset slicing, line range selection, raw bypass, or element-aware output budgeting.
 *
 * @example
 * ```typescript
 * const opts: ReadFileOptions = {
 *   workspaceId: 'global',
 *   startLine: 1,
 *   endLine: 100,
 *   budgetBytes: 20000,
 *   raw: false
 * };
 * ```
 */
export interface ReadFileOptions extends VirtualFsAccessOptions {
  /** 0-indexed offset **in UTF-16 code units** (not bytes) at which to start reading. Combined with
   * `startLine` it resumes inside that line at the given offset (intra-line continuation); an
   * offset pointing at or past a line end resumes at the following line rather than re-reading it. */
  offset?: number;
  /** Maximum number of **UTF-16 code units** (not bytes) to return starting from `offset`. Ignored
   * by `raw: true` reads unless `offset` is also supplied. */
  limit?: number;
  /** 1-indexed start line number for line-based pagination. */
  startLine?: number;
  /** 1-indexed end line number (inclusive) for line-based pagination. */
  endLine?: number;
  /** Maximum byte budget before content is truncated (defaults to instance budget, e.g. 20,000 bytes).
   * Ignored by whole-file `raw: true` reads; supply `offset` or `startLine` to bound a raw read. */
  budgetBytes?: number;
  /**
   * Maximum word count budget. When supplied, delivered content words are capped to at most this
   * many whitespace-delimited words (`truncated: true` with a continuation pointer); line-number
   * prefixes never consume the budget. A positive budget always delivers at least one content word;
   * a zero budget delivers no content but still advances the continuation token. When `budgetBytes`
   * is absent it also acts as a conservative 6-bytes/word byte budget so that element-aware JSON
   * truncation stays bounded while preserving valid syntax. `budgetWords` and `max_words` are aliases.
   */
  maxWords?: number;
  /** If true, returns unformatted raw string without metadata envelope or line number formatting. Raw
   * reads carry no continuation token, so a supplied `maxWords` truncates silently; the
   * strictly-advancing continuation-token contract applies to structured reads only. A raw
   * whole-file read bypasses the byte budget and returns the full content; `budgetBytes`/`limit`
   * slice only when `offset` or `startLine` is supplied (`limit` alone is ignored). */
  raw?: boolean;
  /** If true and file is JSON, applies element-aware structural truncation preserving valid syntax. */
  structured?: boolean;
  /** Alias for `structured`; applies element-aware JSON truncation when true. */
  structuredJson?: boolean;
}

/**
 * Options for writing or creating files in a virtual workspace.
 *
 * @example
 * ```typescript
 * const opts: WriteFileOptions = {
 *   workspaceId: 'global',
 *   callerAgentId: 'director',
 *   readOnly: true,
 *   owner: 'director'
 * };
 * ```
 */
export interface WriteFileOptions extends VirtualFsAccessOptions {
  /** If true, marks file as read-only, preventing future writes unless caller is owner or a privileged principal. */
  readOnly?: boolean;
  /** Explicit owner identity override (defaults to callerAgentId or workspaceId). Denied without a
   * resolvable caller; requires a privileged principal, current-owner, or self-assignment authority. */
  owner?: string;
  /** Optional POSIX permission mode string (e.g. '0644'). */
  mode?: string;
  /** Caller-visible path of a source file whose raw content is written instead of inline `content`.
   * Resolved under the caller's existing workspace view with read rules; mutually exclusive with inline content. */
  sourceFile?: string;
  /** If true, appends the resolved content to the existing destination content instead of overwriting. */
  append?: boolean;
}

/**
 * Backward compatibility alias for {@link WriteFileOptions}.
 */
export type VfsWriteOptions = WriteFileOptions;

/**
 * Configuration for surgical string replacement operations.
 *
 * @example
 * ```typescript
 * const opts: ReplaceFileContentOptions = {
 *   workspaceId: 'agent_writer',
 *   replaceAll: true
 * };
 * ```
 */
export interface ReplaceFileContentOptions extends VirtualFsAccessOptions {
  /** If true, replaces every occurrence of the target string; if false (default), the target must match exactly once (multiple matches are rejected). */
  replaceAll?: boolean;
  /** Alias for `replaceAll`; replaces every occurrence when true. */
  allowMultiple?: boolean;
  /** Alias for `replaceAll`; replaces every occurrence when true. */
  all?: boolean;
  /** Caller-visible path of a source file whose raw content is used as the replacement string.
   * Mutually exclusive with inline `replacementContent`. */
  replacementSourceFile?: string;
}

/**
 * Configuration for intra- and cross-workspace file copy operations.
 *
 * @example
 * ```typescript
 * const opts: CopyFileOptions = {
 *   srcWorkspaceId: 'global',
 *   destWorkspaceId: 'agent_writer',
 *   overwrite: true
 * };
 * ```
 */
export interface CopyFileOptions extends VirtualFsAccessOptions {
  /** Source workspace identifier (defaults to options.workspaceId or 'global'). */
  srcWorkspaceId?: string;
  /** Destination workspace identifier (defaults to options.workspaceId or 'global'). */
  destWorkspaceId?: string;
  /** Whether to overwrite destination file if it already exists (defaults to true). */
  overwrite?: boolean;
  /** Read-only flag to assign to destination copy. */
  readOnly?: boolean;
  /** Explicit destination owner identity override. Denied without a resolvable caller; requires
   * a privileged principal, source/destination owner, or self-assignment authority. */
  owner?: string;
  /** POSIX permission mode string to assign to the destination copy (defaults to the source's `mode`). */
  mode?: string;
  /** Structured permission attributes to assign to the destination copy (defaults to a shallow copy
   * of the source's `permissions`). */
  permissions?: Record<string, unknown>;
}

/**
 * Backward compatibility alias for {@link CopyFileOptions}.
 */
export type VfsCopyOptions = CopyFileOptions;

/**
 * Options for deleting individual files or recursive directory trees.
 *
 * @example
 * ```typescript
 * const opts: DeleteFileOptions = {
 *   workspaceId: 'agent_writer',
 *   recursive: true
 * };
 * ```
 */
export interface DeleteFileOptions extends VirtualFsAccessOptions {
  /** If true, removes all files matching directory path prefix. */
  recursive?: boolean;
  /** If true, throws {@link FileNotFoundError} instead of returning false when the target does not exist. */
  throwIfNotFound?: boolean;
}

/**
 * Options for querying directory contents.
 *
 * @example
 * ```typescript
 * const opts: ListFilesOptions = {
 *   workspaceId: 'global',
 *   recursive: false
 * };
 * ```
 */
export interface ListFilesOptions extends VirtualFsAccessOptions {
  /** If true, recursively lists all nested descendant files. If false, returns immediate children with virtual subdirectories. */
  recursive?: boolean;
}

/**
 * Configuration for structured JSON writing.
 *
 * @example
 * ```typescript
 * const opts: WriteJsonOptions = {
 *   workspaceId: 'global',
 *   formatted: true,
 *   readOnly: false
 * };
 * ```
 */
export interface WriteJsonOptions extends VirtualFsAccessOptions {
  /** Whether to format output with 2-space indentation (defaults to true). */
  formatted?: boolean;
  /** If true, marks written JSON file as read-only. */
  readOnly?: boolean;
  /** Explicit owner identity override. Denied without a resolvable caller; requires a privileged
   * principal, current-owner, or self-assignment authority. */
  owner?: string;
  /** Caller-visible path of a JSON source file whose parsed value is written instead of inline `data`.
   * Mutually exclusive with inline data. */
  dataSourceFile?: string;
}

/**
 * Configuration for AST keypath and jq queries on JSON files.
 *
 * @example
 * ```typescript
 * const opts: QueryJsonOptions = {
 *   workspaceId: 'global',
 *   budgetBytes: 20000
 * };
 * ```
 */
export interface QueryJsonOptions extends VirtualFsAccessOptions {
  /** Maximum byte budget for query output before truncation is applied. */
  budgetBytes?: number;
  /** If true and the query result is a JSON object or array, applies element-aware structural truncation preserving valid JSON syntax. */
  structured?: boolean;
  /** Caller-visible destination path: when supplied, the full serialized query result is written to
   * this file (same write rules as `write_file`) and a {@link QueryJsonOutputReceipt} is returned
   * instead of the in-context value (the extract-to-file path, bounded by the plumbing caps). */
  outputFile?: string;
}

/**
 * Truncation envelope returned by {@link VirtualFS#queryJson} when the serialized query
 * result exceeds the byte budget; the payload is replaced by bounded content plus
 * continuation metadata.
 *
 * @example
 * ```typescript
 * const result = virtualFs.queryJson('/big.json', '.', { budgetBytes: 200 });
 * if (typeof result === 'object' && result !== null && 'truncated' in result && result.truncated) {
 *   console.log(result.content, result.nextOffset);
 * }
 * ```
 */
export interface QueryJsonTruncation {
  /** Total byte size of the complete serialized query result. */
  readonly total_bytes: number;
  /** Total line count of the complete serialized query result. */
  readonly total_lines: number;
  /** Total byte size of the complete serialized query result. */
  readonly totalBytes: number;
  /** Total line count of the complete serialized query result. */
  readonly totalLines: number;
  /** Always true on the truncation envelope. */
  readonly truncated: true;
  /** Bounded (possibly element-aware) serialized content slice. */
  readonly content: string;
  /** UTF-16 code-unit continuation offset for the next pull. */
  readonly nextOffset?: number;
  /** 1-indexed continuation line for the next pull. */
  readonly nextLine?: number;
  /** Remaining bytes not delivered in `content`. */
  readonly remainingBytes: number;
  /** Explanatory truncation note. */
  readonly notice?: string;
}

/**
 * Receipt returned by {@link VirtualFS#queryJson} when `output_file` is supplied: the full
 * serialized query result was written to the destination file and never transited context.
 *
 * @example
 * ```typescript
 * const receipt = virtualFs.queryJson('/src.json', '.items', { output_file: '/items.json' });
 * if (typeof receipt === 'object' && 'success' in receipt && receipt.success) {
 *   console.log(receipt.bytes_written, receipt.path);
 * }
 * ```
 */
export interface QueryJsonOutputReceipt {
  /** Indicates the extraction write succeeded. */
  readonly success: true;
  /** Canonical virtual path of the written output file. */
  readonly path: string;
  /** Workspace identifier where the output file was written. */
  readonly workspaceId: string;
  /** Caller-supplied output path (canonical snake_case echo). */
  readonly output_file: string;
  /** Byte size of the serialized result written to the output file. */
  readonly bytes_written: number;
  /** Line count of the serialized result written to the output file. */
  readonly lines_written: number;
  /** Always false: extract-to-file writes the complete result, so the return-cap truncation never applies. */
  readonly truncated: false;
  /** Human-readable success message. */
  readonly message: string;
}

/**
 * Result of {@link VirtualFS#queryJson}: the selected JSON value (or `undefined` when the
 * query selects nothing), a {@link QueryJsonTruncation} envelope when the serialized
 * result exceeded the byte budget, or a {@link QueryJsonOutputReceipt} when `output_file`
 * routed the full result to a file.
 */
export type QueryJsonResult = JsonValue | QueryJsonTruncation | QueryJsonOutputReceipt | undefined;

/**
 * Configuration for pure-JS jq-compatible in-place JSON transformations.
 *
 * @example
 * ```typescript
 * const opts: TransformJsonOptions = {
 *   workspaceId: 'global',
 *   callerAgentId: 'agent_writer'
 * };
 * ```
 */
export interface TransformJsonOptions extends VirtualFsAccessOptions {}

/**
 * RFC 6902 compliant JSON patch atomic operation descriptor.
 *
 * @example
 * ```typescript
 * const op: JsonPatchOperation = {
 *   op: 'replace',
 *   path: '/settings/theme',
 *   value: 'dark'
 * };
 * ```
 */
export interface JsonPatchOperation {
  /** Patch operation verb conforming to RFC 6902. */
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  /** JSON Pointer path (e.g. '/lore/characters/0/name'). */
  path: string;
  /** Source JSON Pointer path for 'move' and 'copy' operations. */
  from?: string;
  /** Value payload for 'add', 'replace', or 'test' operations. */
  value?: JsonValue;
  /** Caller-visible path of a JSON source file whose parsed value fills this operation's `value`.
   * Mutually exclusive with inline `value` (per operation). */
  value_file?: string;
  /** camelCase alias for `value_file`. */
  valueFile?: string;
}

/**
 * Options for atomic RFC 6902 JSON patching.
 *
 * @example
 * ```typescript
 * const opts: PatchJsonOptions = {
 *   workspaceId: 'global',
 *   callerAgentId: 'agent_writer'
 * };
 * ```
 */
export interface PatchJsonOptions extends VirtualFsAccessOptions {}

/**
 * Search options for string literal or regular expression grep scanning.
 *
 * @example
 * ```typescript
 * const opts: GrepOptions = {
 *   workspaceId: 'global',
 *   isRegex: true,
 *   caseInsensitive: true,
 *   maxMatches: 50
 * };
 * ```
 */
export interface GrepOptions extends VirtualFsAccessOptions {
  /**
   * Target workspace identifier (inherited default: `'global'`, or `'global'`
   * when the path starts with `/global/`).
   *
   * The wildcard `'*'` scans across workspaces; scope is principal-scoped
   * (MOD-21 W4): a privileged principal (injected internal principal reference
   * or identity-port descriptor with cross-workspace scope) scans every
   * workspace, while an unprivileged caller scans only their own workspace plus
   * `'global'`.
   */
  workspaceId?: string;
  /** If true, treats search pattern as a regular expression. */
  isRegex?: boolean;
  /** If true, performs case-insensitive pattern matching. */
  caseInsensitive?: boolean;
  /** Maximum number of matching lines to return (defaults to 100). */
  maxMatches?: number;
}

/**
 * Security and context options when updating permissions on virtual files.
 *
 * @example
 * ```typescript
 * const opts: SetPermissionsOptions = {
 *   workspaceId: 'global',
 *   callerAgentId: 'operator'
 * };
 * ```
 */
export interface SetPermissionsOptions extends VirtualFsAccessOptions {
  /** Updated read-only flag. */
  readOnly?: boolean;
  /** Updated owner identifier. Denied without a resolvable caller; requires a privileged principal or current-owner authority. */
  owner?: string;
  /** Updated POSIX permission mode string. */
  mode?: string;
}

/**
 * Payload defining updated permission attributes for a virtual file.
 *
 * @example
 * ```typescript
 * const payload: PermissionsPayload = {
 *   readOnly: true,
 *   owner: 'director'
 * };
 * ```
 */
export interface PermissionsPayload {
  /** Updated read-only flag. */
  readOnly?: boolean;
  /** Updated owner identifier. Denied without a resolvable caller; requires a privileged principal or current-owner authority. */
  owner?: string;
  /** Updated POSIX permission mode string. */
  mode?: string;
}

/**
 * Options for concatenating multiple virtual files into one destination file.
 *
 * @example
 * ```typescript
 * const opts: ConcatFilesOptions = {
 *   separator: '\n---\n',
 *   workspaceId: 'agent_writer',
 *   callerAgentId: 'agent_writer'
 * };
 * ```
 */
export interface ConcatFilesOptions extends VirtualFsAccessOptions {
  /** String inserted between source payloads (defaults to `''` — plain concatenation). */
  separator?: string;
}

/**
 * Object-first call form of {@link VirtualFS#concatFiles}:
 * `concatFiles({ sources, destination, separator?, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.concatFiles({
 *   sources: ['/parts/a.md', '/parts/b.md'],
 *   destination: '/combined.md',
 *   separator: '\n'
 * });
 * ```
 */
export interface ConcatFilesParams extends ConcatFilesOptions {
  /** Ordered caller-visible source paths, each resolved under the caller's workspace view with read rules. */
  sources?: readonly string[];
  /** Canonical snake_case alias for `sources`. */
  source_paths?: readonly string[];
  /** Canonical snake_case alias for `sources`. */
  files?: readonly string[];
  /** Destination path, resolved under the caller's workspace view with write rules. */
  destination?: string;
  /** Canonical snake_case alias for `destination`. */
  dest_path?: string;
  /** Alias for `destination`. */
  destination_path?: string;
  /** Canonical snake_case alias for `separator`. */
  delimiter?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: ConcatFilesOptions;
}

// ============================================================================
// 2b. Dual-API Named-Parameter Payloads
// ============================================================================

/**
 * Canonical security/execution context accepted as the optional trailing argument of every
 * object-first (named-parameter) call form. Values supplied here are merged over the payload's
 * own access options for routing and operation switches (read slicing, write flags, grep
 * switches); since MOD-21 W4 the authority fields (`isAdmin`/`privileged`/`isPrivileged`/
 * `callerRole`) are stripped and ignored here as well, and only the engine-internal
 * `principal` reference can confer cross-workspace authority. Since MOD-21 W9-A this context
 * is also the only identity source for object-first calls: the payload's `callerAgentId`/
 * `caller_agent_id`/`agentId` keys are ignored whenever a context object is supplied (even
 * one that binds no caller), so a forged payload identity can never widen the workspace ACL,
 * the wildcard-grep scope, or a read-only owner check.
 *
 * @example
 * ```typescript
 * virtualFs.readFile({ filePath: '/lore/world.md' }, { callerAgentId: 'agent_writer' });
 * ```
 */
export interface VirtualFsCallContext extends VirtualFsAccessOptions {
  /** Arbitrary additional option overrides merged into the call options at runtime; values are
   * untrusted and narrowed by the operation that consumes them. */
  readonly [key: string]: unknown;
}

/**
 * Object-first call form of {@link VirtualFS#readFile}:
 * `readFile({ filePath, workspaceId, startLine, ... }, context?)`.
 * Both canonical camelCase keys and the module's canonical snake_case tool aliases are accepted.
 *
 * @example
 * ```typescript
 * const result = virtualFs.readFile({
 *   filePath: '/lore/world.md',
 *   workspace_id: 'global',
 *   start_line: 1,
 *   end_line: 50
 * });
 * ```
 */
export interface ReadFileParams extends ReadFileOptions {
  /** Absolute POSIX virtual path. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Path-directive alias for `filePath`. */
  path_directive?: string;
  /** CamelCase alias for `path_directive`. */
  pathDirective?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Alias for `callerAgentId`. */
  agentId?: string;
  /** Snake_case alias for `agentId`. */
  agent_id?: string;
  /** Canonical snake_case alias for `startLine`. */
  start_line?: number;
  /** Canonical snake_case alias for `endLine`. */
  end_line?: number;
  /** Canonical snake_case alias for `offset` (UTF-16 code units). */
  byte_offset?: number;
  /** Canonical snake_case alias for `limit` (UTF-16 code units). */
  byte_limit?: number;
  /** Nested trusted options merged into the call options. */
  options?: ReadFileOptions;
}

/**
 * Object-first call form of {@link VirtualFS#writeFile}:
 * `writeFile({ filePath, content, workspaceId, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.writeFile({
 *   file_path: '/lore/heroes.json',
 *   content: { hero: 'Aria' },
 *   workspace_id: 'global'
 * });
 * ```
 */
export interface WriteFileParams extends WriteFileOptions {
  /** Absolute virtual path. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** String or JSON-serializable content (defaults to `''` when omitted). */
  content?: string | object;
  /** Alias for `content`. */
  data?: string | object;
  /** Canonical snake_case tool parameter: caller-visible source file whose raw content is written. */
  source_file?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Alias for `callerAgentId`. */
  agentId?: string;
  /** Canonical snake_case alias for `readOnly`. */
  read_only?: boolean;
  /** Nested trusted options merged into the call options. */
  options?: WriteFileOptions;
}

/**
 * Object-first call form of {@link VirtualFS#replaceFileContent}:
 * `replaceFileContent({ filePath, targetContent, replacementContent, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.replaceFileContent({
 *   file_path: '/drafts/ch1.txt',
 *   target_content: 'Old Name',
 *   replacement_content: 'New Name',
 *   replace_all: true
 * });
 * ```
 */
export interface ReplaceFileContentParams extends ReplaceFileContentOptions {
  /** Virtual path to file. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Exact string to locate. */
  targetContent?: string;
  /** Canonical snake_case alias for `targetContent`. */
  target_content?: string;
  /** Replacement string. */
  replacementContent?: string;
  /** Canonical snake_case alias for `replacementContent`. */
  replacement_content?: string;
  /** Canonical snake_case tool parameter: source file whose raw content is used as the replacement. */
  replacement_source_file?: string;
  /** Canonical snake_case alias for `replaceAll`. */
  replace_all?: boolean;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: ReplaceFileContentOptions;
}

/**
 * Object-first call form of {@link VirtualFS#writeJson}:
 * `writeJson({ filePath, data, workspaceId, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.writeJson({ file_path: '/state.json', data: { turn: 4 }, formatted: true });
 * ```
 */
export interface WriteJsonParams extends WriteJsonOptions {
  /** Virtual path to the JSON file. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Any JSON-serializable value or JSON-formatted string. */
  data?: JsonValue;
  /** Alias for `data`. */
  content?: JsonValue;
  /** Alias for `data`. */
  json?: JsonValue;
  /** Canonical snake_case tool parameter: JSON source file whose parsed value is written. */
  data_source_file?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Canonical snake_case alias for `readOnly`. */
  read_only?: boolean;
  /** Nested trusted options merged into the call options. */
  options?: WriteJsonOptions;
}

/**
 * Object-first call form of {@link VirtualFS#patchJson}:
 * `patchJson({ filePath, patch, workspaceId, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.patchJson({
 *   file_path: '/state.json',
 *   patch: [{ op: 'replace', path: '/ready', value: false }]
 * });
 * ```
 */
export interface PatchJsonParams extends PatchJsonOptions {
  /** Virtual path to the JSON file. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Array of RFC 6902 patch operations. */
  patch?: JsonPatchOperation[];
  /** Alias for `patch`. */
  operations?: JsonPatchOperation[];
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: PatchJsonOptions;
}

/**
 * Object-first call form of {@link VirtualFS#copyFile}:
 * `copyFile({ srcPath, destPath, srcWorkspaceId, destWorkspaceId, ... }, context?)`.
 * A single `workspaceId` applies to both sides when the per-side workspaces are omitted.
 *
 * @example
 * ```typescript
 * virtualFs.copyFile({
 *   src_path: '/templates/profile.json',
 *   dest_path: '/profile.json',
 *   dest_workspace_id: 'agent_1',
 *   overwrite: true
 * });
 * ```
 */
export interface CopyFileParams extends CopyFileOptions {
  /** Source virtual path. */
  srcPath?: string;
  /** Canonical snake_case alias for `srcPath`. */
  src_path?: string;
  /** Alias for `srcPath`. */
  sourcePath?: string;
  /** Alias for `srcPath`. */
  from?: string;
  /** Alias for `srcPath`. */
  filePath?: string;
  /** Destination virtual path. */
  destPath?: string;
  /** Canonical snake_case alias for `destPath`. */
  dest_path?: string;
  /** Alias for `destPath`. */
  destinationPath?: string;
  /** Alias for `destPath`. */
  to?: string;
  /** Alias for `destPath`. */
  targetPath?: string;
  /** Canonical snake_case alias for `srcWorkspaceId`. */
  src_workspace_id?: string;
  /** Alias for `srcWorkspaceId`. */
  sourceWorkspaceId?: string;
  /** Canonical snake_case alias for `destWorkspaceId`. */
  dest_workspace_id?: string;
  /** Alias for `destWorkspaceId`. */
  destinationWorkspaceId?: string;
  /** Canonical snake_case alias for `workspaceId` (applied to both sides when per-side workspaces are absent). */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: CopyFileOptions;
}

/**
 * Object-first call form of {@link VirtualFS#setPermissions}:
 * `setPermissions({ filePath, readOnly, mode, owner, permissions, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.setPermissions({ file_path: '/lore/canon.json', read_only: true });
 * ```
 */
export interface SetPermissionsParams extends SetPermissionsOptions {
  /** Virtual path to file. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Structured permission attributes to merge into the file metadata. */
  permissions?: PermissionsPayload;
  /** Canonical snake_case alias for `readOnly`. */
  read_only?: boolean;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: SetPermissionsOptions;
}

/**
 * Object-first call form of {@link VirtualFS#queryJson}:
 * `queryJson({ filePath, query, workspaceId, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.queryJson({ file_path: '/lore/codex.json', json_path: '.characters[0].name' });
 * ```
 */
export interface QueryJsonParams extends QueryJsonOptions {
  /** Path to the JSON file. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Query expression (keypath, JSONPath, or jq; defaults to `'.'`). */
  query?: string;
  /** Alias for `query`. */
  filter?: string;
  /** Alias for `query`. */
  keyPath?: string;
  /** Alias for `query`. */
  jsonPath?: string;
  /** Canonical snake_case alias for `query`. */
  json_path?: string;
  /** Canonical snake_case tool parameter: destination file for the full serialized query result. */
  output_file?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: QueryJsonOptions;
}

/**
 * Object-first call form of {@link VirtualFS#transformJson}:
 * `transformJson({ filePath, filter, workspaceId, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.transformJson({ file_path: '/state.json', filter: '.counter += 1' });
 * ```
 */
export interface TransformJsonParams extends TransformJsonOptions {
  /** Path to the JSON file. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** jq transform filter (defaults to `'.'`). */
  filter?: string;
  /** Alias for `filter`. */
  jqTransformFilter?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: TransformJsonOptions;
}

/**
 * Object-first call form of {@link VirtualFS#exists}:
 * `exists({ filePath, workspaceId, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.exists({ file_path: '/checkpoint.json', workspace_id: 'global' });
 * ```
 */
export interface ExistsParams extends VirtualFsAccessOptions {
  /** Virtual path. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: VirtualFsAccessOptions;
}

/**
 * Object-first call form of {@link VirtualFS#getFileRecord}:
 * `getFileRecord({ filePath, workspaceId, ... }, context?)`.
 *
 * @example
 * ```typescript
 * const record = virtualFs.getFileRecord({ file_path: '/config.json', workspace_id: 'global' });
 * ```
 */
export interface GetFileRecordParams extends VirtualFsAccessOptions {
  /** Virtual path. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: VirtualFsAccessOptions;
}

/**
 * Object-first call form of {@link VirtualFS#listFiles} and
 * {@link VirtualFS#listFilesWithContent}:
 * `listFiles({ directory_path, workspaceId, recursive, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.listFiles({ directory_path: '/lore', workspace_id: 'global', recursive: false });
 * ```
 */
export interface ListFilesParams extends ListFilesOptions {
  /** Directory path prefix (defaults to `'/'`). */
  dirPath?: string;
  /** Snake_case alias for `dirPath`. */
  dir_path?: string;
  /** Canonical snake_case alias for `dirPath`. */
  directory_path?: string;
  /** CamelCase alias for `directory_path`. */
  directoryPath?: string;
  /** Alias for `dirPath`. */
  path?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: ListFilesOptions;
}

/**
 * Object-first call form of {@link VirtualFS#listFilesWithContent}.
 * Alias of {@link ListFilesParams} for documentation parity.
 *
 * @example
 * ```typescript
 * const records = virtualFs.listFilesWithContent({ dirPath: '/lore', workspaceId: 'global' });
 * ```
 */
export type ListFilesWithContentParams = ListFilesParams;

/**
 * Object-first call form of {@link VirtualFS#deleteFile}:
 * `deleteFile({ filePath, workspaceId, recursive, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.deleteFile({ file_path: '/temp/scratch.txt', recursive: true });
 * ```
 */
export interface DeleteFileParams extends DeleteFileOptions {
  /** Virtual path to remove. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: DeleteFileOptions;
}

/**
 * Object-first call form of {@link VirtualFS#grep}:
 * `grep({ pattern, pathPrefix, workspaceId, ... }, context?)`.
 *
 * @example
 * ```typescript
 * virtualFs.grep({
 *   pattern: 'TODO',
 *   path_prefix: '/src',
 *   is_regex: true,
 *   case_insensitive: true
 * });
 * ```
 */
export interface GrepParams extends GrepOptions {
  /** String literal or RegExp pattern to find. */
  pattern?: string | RegExp;
  /** Alias for `pattern`. */
  query?: string;
  /** Directory scope (defaults to `'/'`). */
  pathPrefix?: string;
  /** Canonical snake_case alias for `pathPrefix`. */
  path_prefix?: string;
  /** Alias for `pathPrefix`. */
  path?: string;
  /** Alias for `pathPrefix`. */
  dirPath?: string;
  /** Canonical snake_case alias for `isRegex`. */
  is_regex?: boolean;
  /** Canonical snake_case alias for `caseInsensitive`. */
  case_insensitive?: boolean;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string;
  /** Nested trusted options merged into the call options. */
  options?: GrepOptions;
}

// ============================================================================
// 3. Receipts & Operation Results
// ============================================================================

/**
 * Structured delivery result of a budgeted or sliced file read operation.
 *
 * @example
 * ```typescript
 * const result: ReadFileResult = virtualFs.readFile('/lore/world.md', {
 *   startLine: 1,
 *   endLine: 50
 * });
 * console.log(`Read ${result.linesIncluded} lines (${result.bytesIncluded} bytes)`);
 * if (result.truncated) {
 *   console.log(`Next page starts at line ${result.nextLine}`);
 * }
 * ```
 */
export interface ReadFileResult {
  /** Sliced or budgeted text content (formatted with line numbers if line-sliced, unless raw: true). */
  readonly content: string;
  /** Total byte size of the complete underlying file. */
  readonly totalBytes: number;
  /** Total line count of the complete underlying file. */
  readonly totalLines: number;
  /** Total estimated word count of the complete underlying file. */
  readonly totalWords: number;
  /** Byte size of the included content slice. */
  readonly bytesIncluded: number;
  /** Number of lines included in this delivery slice. */
  readonly linesIncluded: number;
  /** Number of content words included in this delivery slice (line-number prefixes are excluded). */
  readonly wordsIncluded: number;
  /** Whether content was truncated due to budget constraints or range limits. */
  readonly truncated: boolean;
  /** Continuation offset **in UTF-16 code units** (not bytes) for subsequent page fetch, if truncated.
   * For a line-sliced read (`startLine`) whose word budget was exhausted inside one long line, this is
   * the exact intra-line resume offset; pass it together with `nextLine` as `startLine` + `offset`.
   * Every emitted continuation token strictly advances; zero-length slices (`limit: 0`, `maxWords: 0`)
   * either report an offset past the next word or, when the cut lands exactly on a line boundary,
   * report the first line not fully delivered (`nextLine`) with no offset. */
  readonly nextOffset?: number;
  /** Continuation 1-indexed line number for the subsequent read, if truncated. For line-range
   * reads this is the first line not fully delivered. For offset reads it is the line in which the
   * resumed read begins delivering: the line containing the resume point, or the following line
   * when that point sits at or past a line end. Resume intra-line cuts with `nextLine` +
   * `nextOffset`; a line-boundary cut carries no `nextOffset`. */
  readonly nextLine?: number;
  /** Explanatory note detailing pagination status and continuation guidance. */
  readonly deliveryNote: string;
}

/**
 * Acknowledgment receipt returned following a successful file creation or update.
 *
 * @example
 * ```typescript
 * const receipt: WriteReceipt = virtualFs.writeFile('/lore/heroes.json', { name: 'Aria' });
 * console.log(`Wrote ${receipt.size} bytes to ${receipt.path} in workspace ${receipt.workspaceId}`);
 * ```
 */
export interface WriteReceipt {
  /** Indicates whether the write operation succeeded. */
  readonly success: boolean;
  /** Canonical virtual path of written file. */
  readonly path: string;
  /** Workspace identifier where the file was written. */
  readonly workspaceId: string;
  /** Byte size of UTF-8 encoded written content. */
  readonly size: number;
  /** Total number of lines written. */
  readonly linesWritten: number;
  /** Millisecond epoch timestamp of the write operation. */
  readonly updatedAt: number;
  /** Read-only status of the file after write. */
  readonly readOnly: boolean;
  /** Owner identity assigned to the file. */
  readonly owner: string;
}

/**
 * Receipt returned following a structured JSON write ({@link VirtualFS#writeJson}),
 * carrying the canonical snake_case counter aliases alongside the write metadata.
 *
 * @example
 * ```typescript
 * const receipt: WriteJsonReceipt = virtualFs.writeJson('/state.json', { turn: 4 });
 * console.log(receipt.bytes_written, receipt.lines_written);
 * ```
 */
export interface WriteJsonReceipt {
  /** Indicates whether the write operation succeeded. */
  readonly success: boolean;
  /** Canonical virtual path of written file. */
  readonly path: string;
  /** Workspace identifier where the file was written. */
  readonly workspaceId: string;
  /** Byte size of the serialized JSON payload. */
  readonly bytes_written: number;
  /** Number of lines written after serialization. */
  readonly lines_written: number;
  /** Human-readable success message. */
  readonly message: string;
  /** Byte size of the serialized JSON payload. */
  readonly size: number;
  /** Owner identity assigned to the file. */
  readonly owner: string;
  /** Read-only status of the file after write. */
  readonly readOnly: boolean;
  /** Millisecond epoch timestamp of the write operation. */
  readonly updatedAt: number;
}

/**
 * Receipt returned following a {@link VirtualFS#concatFiles} concatenation.
 *
 * @example
 * ```typescript
 * const receipt: ConcatFilesReceipt = virtualFs.concatFiles(
 *   ['/parts/a.md', '/parts/b.md'],
 *   '/combined.md',
 *   { separator: '\n' }
 * );
 * console.log(`Joined ${receipt.source_count} files into ${receipt.path}`);
 * ```
 */
export interface ConcatFilesReceipt {
  /** Indicates whether the concatenation succeeded. */
  readonly success: boolean;
  /** Canonical virtual path of the destination file. */
  readonly path: string;
  /** Workspace identifier where the destination was written. */
  readonly workspaceId: string;
  /** Number of source files joined. */
  readonly source_count: number;
  /** Separator used between source payloads (`''` when omitted). */
  readonly separator: string;
  /** Aggregate UTF-8 byte size of the written destination content. */
  readonly bytes_written: number;
  /** Number of lines written to the destination. */
  readonly lines_written: number;
  /** Millisecond epoch timestamp of the write operation. */
  readonly updatedAt: number;
  /** Human-readable success message. */
  readonly message: string;
}

/**
 * Receipt returned following an in-place jq-compatible JSON transformation.
 *
 * @example
 * ```typescript
 * const receipt: TransformJsonReceipt = virtualFs.transformJson('/data/state.json', '.counter += 1', {
 *   workspaceId: 'global'
 * });
 * console.log(receipt.bytes_written, receipt.lines_written);
 * ```
 */
export interface TransformJsonReceipt {
  /** Indicates whether the transformation succeeded. */
  readonly success: boolean;
  /** Canonical virtual path of the transformed file. */
  readonly path: string;
  /** Workspace identifier containing the transformed file. */
  readonly workspaceId: string;
  /** Byte size of the transformed JSON payload. */
  readonly bytes_written: number;
  /** Number of lines written after transformation. */
  readonly lines_written: number;
  /** Byte size of the transformed JSON payload. */
  readonly size: number;
  /** Owner identity of the transformed file. */
  readonly owner: string;
  /** Read-only status of the transformed file. */
  readonly readOnly: boolean;
  /** Millisecond epoch timestamp of the transformation. */
  readonly updatedAt: number;
  /** Human-readable success message. */
  readonly message?: string;
}

/**
 * Receipt returned following surgical text replacement in a virtual file.
 *
 * @example
 * ```typescript
 * const receipt: ReplaceReceipt = virtualFs.replaceFileContent(
 *   '/drafts/ch1.txt',
 *   'Chapter 1',
 *   'Chapter 1: The Beginning'
 * );
 * console.log(`Made ${receipt.replacementsMade} replacements. Size: ${receipt.sizeBefore} -> ${receipt.sizeAfter}`);
 * ```
 */
export interface ReplaceReceipt {
  /** Indicates whether the replacement succeeded. */
  readonly success: boolean;
  /** Canonical virtual path of modified file. */
  readonly path: string;
  /** Workspace identifier containing the modified file. */
  readonly workspaceId: string;
  /** Number of text occurrences replaced. */
  readonly replacementsMade: number;
  /** Byte size of file prior to replacement. */
  readonly sizeBefore: number;
  /** Byte size of file following replacement. */
  readonly sizeAfter: number;
  /** Line count prior to replacement. */
  readonly linesBefore: number;
  /** Line count following replacement. */
  readonly linesAfter: number;
  /** Millisecond epoch timestamp of the replacement. */
  readonly updatedAt: number;
}

/**
 * Receipt confirming completion of a file copy operation.
 *
 * @example
 * ```typescript
 * const receipt: CopyReceipt = virtualFs.copyFile('/lore/rules.md', '/agent_1/rules.md', {
 *   destWorkspaceId: 'agent_1'
 * });
 * console.log(`Copied ${receipt.srcPath} -> ${receipt.destPath}`);
 * ```
 */
export interface CopyReceipt {
  /** Indicates whether the copy operation succeeded. */
  readonly success: boolean;
  /** Canonical source virtual path. */
  readonly srcPath: string;
  /** Canonical destination virtual path. */
  readonly destPath: string;
  /** Source workspace identifier. */
  readonly srcWorkspaceId: string;
  /** Destination workspace identifier. */
  readonly destWorkspaceId: string;
  /** Byte size of copied file. */
  readonly size: number;
  /** Millisecond epoch timestamp of the copy operation. */
  readonly updatedAt: number;
}

/**
 * Receipt acknowledging successful atomic application of RFC 6902 JSON patch operations.
 *
 * @example
 * ```typescript
 * const receipt: PatchReceipt = virtualFs.patchJson('/data/state.json', [
 *   { op: 'replace', path: '/phase', value: 'climax' }
 * ]);
 * console.log(`Applied ${receipt.operationsApplied} patch operations atomically.`);
 * ```
 */
export interface PatchReceipt {
  /** Indicates whether all patch operations applied successfully. */
  readonly success: boolean;
  /** Canonical virtual path of patched file. */
  readonly path: string;
  /** Workspace identifier containing the patched file. */
  readonly workspaceId: string;
  /** Total number of RFC 6902 patch operations applied. */
  readonly operationsApplied: number;
  /** Byte size before patch application. */
  readonly sizeBefore: number;
  /** Byte size after patch application. */
  readonly sizeAfter: number;
  /** Millisecond epoch timestamp of the patch operation. */
  readonly updatedAt: number;
}

/**
 * Search hit representation returned from workspace grep operations.
 *
 * @example
 * ```typescript
 * const match: GrepMatch = {
 *   filePath: '/lore/characters.json',
 *   lineNumber: 14,
 *   lineContent: '  "role": "protagonist",',
 *   match: 'protagonist'
 * };
 * ```
 */
export interface GrepMatch {
  /** Canonical virtual path where match occurred. */
  readonly filePath: string;
  /** Workspace identifier where the match occurred. */
  readonly workspaceId?: string;
  /** 1-indexed line number of the matching line. */
  readonly lineNumber: number;
  /** Full text content of the matching line. */
  readonly lineContent: string;
  /** Matched substring or regex capture. */
  readonly match: string;
}

/**
 * Receipt confirming updated file permission and ownership attributes.
 *
 * @example
 * ```typescript
 * const receipt: PermissionsReceipt = virtualFs.setPermissions('/lore/canon.json', { readOnly: true });
 * console.log(`File ${receipt.path} readOnly is now ${receipt.readOnly}`);
 * ```
 */
export interface PermissionsReceipt {
  /** Indicates whether permissions were updated successfully. */
  readonly success: boolean;
  /** Canonical virtual path of target file. */
  readonly path: string;
  /** Workspace identifier. */
  readonly workspaceId: string;
  /** Updated read-only protection status. */
  readonly readOnly: boolean;
  /** Updated owner identity. */
  readonly owner: string;
  /** Updated POSIX permission mode string. */
  readonly mode?: string;
  /** Updated structured permission attributes. */
  readonly permissions?: Record<string, unknown>;
  /** Millisecond epoch timestamp of the update. */
  readonly updatedAt: number;
}

/**
 * Options for rendering prompt templates with inline virtual file expansion and variable interpolation.
 *
 * Supply a `template` string for placeholder substitution, or omit it / pass `null` together with
 * `filePath` to use direct-file mode (file content is returned verbatim).
 *
 * @example
 * ```typescript
 * const opts: RenderTemplateOptions = {
 *   virtualFs,
 *   files: { LORE: '/lore/world.md' },
 *   variables: { protagonist: 'Aria' },
 *   workspaceId: 'global'
 * };
 * ```
 */
export interface RenderTemplateOptions {
  /** VirtualFS instance to resolve file references against. */
  readonly virtualFs: VirtualFS;
  /** Optional template file path in VFS to read template content from. Used only when `template`
   * is omitted or `null` (direct-file mode); ignored when a template string is supplied. */
  readonly filePath?: string;
  /** Map of bare placeholder keys to VFS file paths: each key `K` replaces `{{K}}` and
   * `{{files.K}}` in the template (e.g. `{ WORLD_LORE: '/lore/world.md' }`). Keys that already
   * contain braces (e.g. `'{{WORLD_LORE}}'`) never match and leave the placeholder in place. */
  readonly files?: Record<string, string>;
  /** Key-value variables for standard mustache/bracket replacement (e.g. `{ protagonist: 'Aria' }`). */
  readonly variables?: Record<string, unknown>;
  /** Default workspace identifier for relative file paths. */
  readonly workspaceId?: string;
  /** Caller agent identifier for access validation. */
  readonly callerAgentId?: string;
  /** Additional access options passed to underlying file reads. */
  readonly fsOpts?: VirtualFsAccessOptions;
}

/**
 * Successful result of a rendered prompt template with inlined virtual files.
 *
 * @example
 * ```typescript
 * const result = renderTemplateWithFiles('Context: {{LORE}}', {
 *   virtualFs,
 *   files: { LORE: '/lore/world.md' }
 * });
 * if (result.success) {
 *   console.log(result.renderedPrompt);
 * }
 * ```
 */
export interface RenderTemplateSuccess {
  /** Always true on the success envelope. */
  readonly success: true;
  /** Rendered template content (same as `renderedPrompt`). */
  readonly content: string;
  /** Rendered prompt string with all placeholders and variables expanded. */
  readonly renderedPrompt: string;
  /** Metadata on all virtual files inlined during rendering. */
  readonly inlinedFiles: Array<{
    readonly placeholder: string;
    readonly filePath: string;
    readonly workspaceId: string;
    readonly bytesInlined: number;
  }>;
  /** Total byte size of the rendered prompt. */
  readonly totalBytes: number;
  /** Total estimated word count of the rendered prompt. */
  readonly wordsCount: number;
}

/**
 * Failure result returned when inline file resolution fails (`success: false`); the payload
 * fields of {@link RenderTemplateSuccess} are absent.
 *
 * @example
 * ```typescript
 * const result = renderTemplateWithFiles('Context: {{file:/missing.txt}}', { virtualFs });
 * if (!result.success) {
 *   console.error(result.error, result.code);
 * }
 * ```
 */
export interface RenderTemplateFailure {
  /** Always false on the failure envelope. */
  readonly success: false;
  /** Human-readable error message. */
  readonly error: string;
  /** Error name (e.g. `FileNotFoundError`) or `INLINE_ERROR` when the error carries no name. */
  readonly code: string;
}

/**
 * Result of {@link renderTemplateWithFiles}: a success or failure envelope discriminated by `success`.
 */
export type RenderTemplateResult = RenderTemplateSuccess | RenderTemplateFailure;

// ============================================================================
// 4. Scoped Agent Proxy
// ============================================================================

/**
 * Scoped proxy interface providing agent-bound filesystem operations.
 * Automatically injects `callerAgentId` and defaults `workspaceId` to the agent's private workspace.
 *
 * @example
 * ```typescript
 * const proxy: AgentFsProxy = virtualFs.forAgent('agent_writer', { role: 'writer', principal: internalPrincipal });
 * proxy.writeFile('/draft.txt', 'Chapter 1...');
 * const content = proxy.readFile('/draft.txt');
 * const globalLore = proxy.readGlobal('/lore/world.md');
 * ```
 */
export interface AgentFsProxy {
  /** Identifier of the bound agent. */
  readonly agentId: string;
  /** Role classification of the bound agent. */
  readonly role?: string;
  /**
   * Read-only projection of the bound agent's resolved authority: `true` when
   * the injected identity port grants cross-workspace scope. The proxy itself
   * never confers authority (MOD-21 W4).
   */
  readonly isAdmin: boolean;
  /** Reference to the underlying raw VirtualFS instance. */
  readonly raw: VirtualFS;

  /**
   * Reads a file from the agent's private workspace (or global if path starts with '/global/').
   *
   * @param filePath - Virtual path to file.
   * @param options - Additional read options.
   * @returns Structured read result with pagination and budget metadata; raw string when `raw: true`.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If access is denied (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const res = agentProxy.readFile('/notes.txt', { startLine: 1, endLine: 20 });
   * console.log(res.content);
   * const raw = agentProxy.readFile('/notes.txt', { raw: true });
   * ```
   */
  readFile(filePath: string, options: ReadFileOptions & { raw: true }): string;

  /**
   * Reads a file from the agent's private workspace and returns the structured delivery
   * envelope with content and pagination metadata (`raw` omitted or false).
   */
  readFile(filePath: string, options?: ReadFileOptions): ReadFileResult;

  /**
   * Reads a file specifically from the shared 'global' workspace.
   *
   * @param filePath - Virtual path in global workspace.
   * @param options - Additional read options.
   * @returns Structured read result.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If access is denied (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const lore = agentProxy.readGlobal('/lore/factions.json');
   * ```
   */
  readGlobal(filePath: string, options?: ReadFileOptions): ReadFileResult;

  /**
   * Writes a file to the agent's private workspace.
   *
   * @param filePath - Destination virtual path.
   * @param content - String or JSON-serializable object.
   * @param options - Additional write options.
   * @returns Write receipt.
   * @throws If workspace is locked or read-only (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.writeFile('/drafts/scene1.md', '# Scene 1\nRain fell...');
   * ```
   */
  writeFile(filePath: string, content: string | object, options?: WriteFileOptions): WriteReceipt;

  /**
   * Writes a file directly into the shared 'global' workspace.
   *
   * @param filePath - Virtual path in global workspace.
   * @param content - String or JSON-serializable object.
   * @param options - Additional write options.
   * @returns Write receipt.
   * @throws If file is read-only and caller is not the owner or a privileged principal (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.writeGlobal('/shared/announcement.txt', 'Draft submitted.');
   * ```
   */
  writeGlobal(filePath: string, content: string | object, options?: WriteFileOptions): WriteReceipt;

  /**
   * Surgically modifies text in an existing file in the agent's workspace.
   *
   * @param filePath - Virtual path.
   * @param search - Target substring to find.
   * @param replace - Replacement substring.
   * @param options - Replacement configuration.
   * @returns Replace receipt.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If access is denied (`PERMISSION_DENIED`).
   * @throws `Error` - With code `'SEARCH_NOT_FOUND'` if search string is not found.
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.replaceFileContent('/draft.txt', 'draft', 'final', { replaceAll: true });
   * ```
   */
  replaceFileContent(filePath: string, search: string, replace: string, options?: ReplaceFileContentOptions): ReplaceReceipt;

  /**
   * Deletes a file or directory tree in the agent's workspace.
   *
   * @param filePath - Virtual path to remove.
   * @param options - Deletion options.
   * @returns True if at least one file was removed, false if not found.
   * @throws If file is read-only (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const removed = agentProxy.deleteFile('/temp/scratch.txt');
   * ```
   */
  deleteFile(filePath: string, options?: DeleteFileOptions): boolean;

  /**
   * Lists files and directories in the agent's private workspace.
   *
   * @param dirPath - Directory path (defaults to '/').
   * @param options - Listing options.
   * @returns Array of file and directory items.
   *
   * @example
   * ```typescript
   * const files = agentProxy.listFiles('/');
   * ```
   */
  listFiles(dirPath?: string, options?: ListFilesOptions): FileListItem[];

  /**
   * Serializes and writes JSON data in the agent's workspace.
   *
   * @param filePath - Virtual path.
   * @param data - Any JSON-serializable value.
   * @param options - Write options.
   * @returns Write receipt.
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.writeJson('/state.json', { ready: true });
   * ```
   */
  writeJson(filePath: string, data: JsonValue, options?: WriteJsonOptions): WriteJsonReceipt;

  /**
   * Queries a JSON document using keypaths, JSONPath, or jq expressions.
   *
   * @param filePath - Path to JSON file.
   * @param query - Query expression (defaults to '.').
   * @param options - Query options.
   * @returns Query payload.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   *
   * @example
   * ```typescript
   * const name = agentProxy.queryJson('/character.json', '.name');
   * ```
   */
  queryJson(filePath: string, query?: string, options?: QueryJsonOptions): QueryJsonResult;

  /**
   * Applies a jq-compatible transformation in place to a JSON file in the agent's workspace.
   *
   * @param filePath - Path to JSON file.
   * @param filter - jq transform filter (defaults to '.').
   * @param options - Transform options.
   * @returns Transform receipt with written byte and line counts.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If access is denied (`PERMISSION_DENIED`).
   * @throws `Error` - If the target file is not valid JSON.
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.transformJson('/state.json', '.counter += 1');
   * ```
   */
  transformJson(filePath: string, filter?: string, options?: TransformJsonOptions): TransformJsonReceipt;

  /**
   * Applies RFC 6902 JSON patch operations atomically to a file in the agent's workspace.
   *
   * @param filePath - Path to JSON file.
   * @param patch - Array of patch operations.
   * @param options - Patch options.
   * @returns Patch receipt.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.patchJson('/state.json', [{ op: 'replace', path: '/ready', value: false }]);
   * ```
   */
  patchJson(filePath: string, patch: JsonPatchOperation[], options?: PatchJsonOptions): PatchReceipt;

  /**
   * Concatenates multiple files in the bound agent's workspace into one destination file.
   *
   * @param sources - Ordered source paths (workspace-relative).
   * @param destination - Destination path.
   * @param options - Concatenation options (separator).
   * @returns Concatenation receipt.
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.concatFiles(['/parts/a.md', '/parts/b.md'], '/combined.md', { separator: '\n' });
   * ```
   */
  concatFiles(sources: readonly string[], destination: string, options?: ConcatFilesOptions): ConcatFilesReceipt;

  /**
   * Searches file contents in the agent's workspace.
   *
   * @param pattern - String or RegExp search pattern.
   * @param pathPrefix - Directory scope.
   * @param options - Grep options.
   * @returns Array of line match items.
   *
   * @example
   * ```typescript
   * const matches = agentProxy.grep('TODO', '/');
   * ```
   */
  grep(pattern: string | RegExp, pathPrefix?: string, options?: GrepOptions): GrepMatch[];

  /**
   * Privacy-preserving Unix epoch time query.
   *
   * @returns Object containing seconds and milliseconds timestamps.
   *
   * @example
   * ```typescript
   * const time = agentProxy.getCurrentTime();
   * console.log(`Epoch ms: ${time.epoch_ms}`);
   * ```
   */
  getCurrentTime(): { unix_timestamp: number; epoch_ms: number };

  /**
   * Copies a file within the agent's workspace or across workspaces.
   *
   * @param srcPath - Source path.
   * @param destPath - Destination path.
   * @param options - Copy options.
   * @returns Copy receipt.
   * @throws If source file does not exist (`FILE_NOT_FOUND`).
   * @throws If dest exists and overwrite is false (`FILE_EXISTS`).
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.copyFile('/draft.txt', '/backup/draft_v1.txt');
   * ```
   */
  copyFile(srcPath: string, destPath: string, options?: CopyFileOptions): CopyReceipt;

  /**
   * Updates permission attributes on a file in the agent's workspace.
   *
   * @param filePath - Virtual path.
   * @param permissions - Updated permission payload.
   * @param options - Options.
   * @returns Permissions receipt.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If caller is unauthorized (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const receipt = agentProxy.setPermissions('/final.txt', { readOnly: true });
   * ```
   */
  setPermissions(filePath: string, permissions: PermissionsPayload | boolean | string, options?: SetPermissionsOptions): PermissionsReceipt;

  /**
   * Checks if a file exists in the agent's workspace without throwing.
   *
   * @param filePath - Virtual path.
   * @param options - Options.
   * @returns True if file exists, false otherwise.
   *
   * @example
   * ```typescript
   * if (agentProxy.exists('/checkpoint.json')) { ... }
   * ```
   */
  exists(filePath: string, options?: VirtualFsAccessOptions): boolean;

  /**
   * Retrieves raw file record without pagination or budget truncation.
   *
   * @param filePath - Virtual path.
   * @param options - Options.
   * @returns FileRecord or null if not found.
   *
   * @example
   * ```typescript
   * const record = agentProxy.getFileRecord('/config.json');
   * ```
   */
  getFileRecord(filePath: string, options?: VirtualFsAccessOptions): FileRecord | null;
}

// ============================================================================
// 4b. Internal Dispatch Shapes (runtime-only compatibility aliases)
// ============================================================================

/**
 * Runtime delivery envelope of a file write: the public {@link WriteReceipt} plus the
 * legacy snake_case aliases emitted alongside it. The extra fields are always present
 * at runtime; they stay optional here so the public receipt remains a subtype.
 */
interface WriteFileDelivery extends WriteReceipt {
  /** Legacy alias for `size` (written bytes). */
  bytes_written?: number;
  /** Legacy alias for `linesWritten`. */
  lines_written?: number;
  /** Human-readable success message. */
  message?: string;
}

/**
 * Runtime delivery envelope of a sliced read: the public {@link ReadFileResult} plus the
 * legacy compatibility aliases emitted alongside it.
 */
interface ReadFileDelivery extends ReadFileResult {
  /** 1-indexed first line of the delivered slice (line-range reads). */
  startLine?: number;
  /** 1-indexed last line of the delivered slice (line-range reads). */
  endLine?: number;
  /** Number of delivered lines (offset reads). */
  lineCount?: number;
  /** Legacy alias for `totalLines`. */
  total_lines?: number;
  /** Legacy alias for `totalBytes`. */
  total_bytes?: number;
  /** Remaining bytes after the delivered slice. */
  remainingBytes?: number;
  /** Remaining words after the delivered slice (budgeted reads). */
  remainingWords?: number;
  /** Explanatory truncation/delivery note. */
  notice?: string;
  /** Applied offset (offset reads). */
  offset?: number;
  /** Applied limit (offset reads). */
  limit?: number;
  /** String coercion convenience returning the delivered content. */
  toString(): string;
  /** Value coercion convenience returning the delivered content. */
  valueOf(): unknown;
}

/**
 * Runtime delivery envelope of a surgical replacement: the public {@link ReplaceReceipt}
 * plus the legacy compatibility aliases emitted alongside it.
 */
interface ReplaceFileDelivery extends ReplaceReceipt {
  /** Canonical virtual path (legacy alias for `path`). */
  filePath?: string;
  /** Legacy alias for `sizeAfter`. */
  bytesWritten?: number;
  /** Legacy alias for `sizeAfter`. */
  bytes_written?: number;
  /** Number of lines carrying the replaced text. */
  lines_modified?: number;
  /** Legacy alias for `linesAfter`. */
  lines_written?: number;
  /** Millisecond epoch timestamp of the replacement. */
  modifiedAt?: number;
  /** Human-readable success message. */
  message?: string;
  /** Byte size after replacement (legacy alias for `sizeAfter`). */
  size?: number;
  /** Owner identity of the modified file. */
  owner?: string;
  /** Read-only status of the modified file. */
  readOnly?: boolean;
}

/**
 * Runtime delivery envelope of a file copy: the public {@link CopyReceipt} plus the
 * legacy compatibility aliases emitted alongside it.
 */
interface CopyFileDelivery extends CopyReceipt {
  /** Legacy alias for `size` (copied bytes). */
  bytesCopied?: number;
  /** Read-only status assigned to the destination copy. */
  readOnly?: boolean;
  /** Owner identity assigned to the destination copy. */
  owner?: string;
  /** Human-readable success message. */
  message?: string;
}

/**
 * Runtime delivery envelope of an atomic JSON patch: the public {@link PatchReceipt} plus
 * the legacy compatibility aliases emitted alongside it.
 */
interface PatchFileDelivery extends PatchReceipt {
  /** Canonical virtual path (legacy alias for `path`). */
  filePath?: string;
  /** Byte size after patch application (legacy alias for `sizeAfter`). */
  size?: number;
  /** Millisecond epoch timestamp of the patch operation (legacy alias for `updatedAt`). */
  modifiedAt?: number;
  /** Legacy alias for `sizeAfter`. */
  bytesWritten?: number;
  /** Legacy alias for `sizeAfter`. */
  bytes_written?: number;
  /** Human-readable success message. */
  message?: string;
}

/**
 * Runtime delivery envelope of a permission update: the public {@link PermissionsReceipt}
 * plus the legacy compatibility aliases emitted alongside it.
 */
interface PermissionsDelivery extends PermissionsReceipt {
  /** Canonical virtual path (legacy alias for `path`). */
  filePath?: string;
  /** Human-readable success message. */
  message?: string;
}

/**
 * Merged call-options bag produced by the sanitize/resolve helpers. Declared keys mirror
 * the accepted public option interfaces (camelCase plus the dual-API canonical snake_case
 * aliases); unrecognized extra keys remain `unknown` and are narrowed by the reader.
 */
type ResolvedCallOptions = {
  /** Target workspace identifier. */
  workspaceId?: string;
  /** Canonical snake_case alias for `workspaceId`. */
  workspace_id?: string;
  /** Caller identity, or `null` when a supplied context binds no caller. */
  callerAgentId?: string | null;
  /** Canonical snake_case alias for `callerAgentId`. */
  caller_agent_id?: string | null;
  /** Alias for `callerAgentId` (principal resolution). */
  agentId?: string;
  /** Role classification (metadata only, never authority). */
  callerRole?: string;
  /** Exact injected internal-principal reference. */
  principal?: object;
  /** Stripped caller-asserted privilege flag (always false after sanitization). */
  isAdmin?: boolean;
  /** Stripped caller-asserted privilege flag (always false after sanitization). */
  privileged?: boolean;
  /** Stripped caller-asserted privilege flag (always false after sanitization). */
  isPrivileged?: boolean;
  /** Whether to force mutation overriding non-global read-only flags. */
  force?: boolean;
  /** Read-only flag to assign. */
  readOnly?: boolean;
  /** Explicit owner identity override. */
  owner?: string;
  /** POSIX permission mode string. */
  mode?: string;
  /** Structured permission attributes to merge/assign. */
  permissions?: Record<string, unknown>;
  /** Absolute virtual path. */
  filePath?: string;
  /** Canonical snake_case alias for `filePath`. */
  file_path?: string;
  /** Alias for `filePath`. */
  path?: string;
  /** Directory path. */
  dirPath?: string;
  /** Canonical snake_case alias for `dirPath`. */
  dir_path?: string;
  /** Canonical snake_case alias for `dirPath`. */
  directory_path?: string;
  /** Directory scope prefix. */
  pathPrefix?: string;
  /** Source workspace identifier. */
  srcWorkspaceId?: string;
  /** Destination workspace identifier. */
  destWorkspaceId?: string;
  /** Alias for `srcWorkspaceId`. */
  sourceWorkspaceId?: string;
  /** Alias for `destWorkspaceId`. */
  destinationWorkspaceId?: string;
  /** Whether to overwrite an existing destination. */
  overwrite?: boolean;
  /** Whether to pretty-print serialized JSON. */
  formatted?: boolean;
  /** Raw/unformatted read flag. */
  raw?: boolean;
  /** Element-aware structured JSON truncation flag. */
  structured?: boolean;
  /** Alias for `structured`. */
  structuredJson?: boolean;
  /** Regex grep flag. */
  isRegex?: boolean;
  /** Case-insensitive grep flag. */
  caseInsensitive?: boolean;
  /** Maximum grep matches. */
  maxMatches?: number;
  /** Output byte budget. */
  budgetBytes?: number;
  /** Read offset in UTF-16 code units. */
  offset?: number;
  /** Read limit in UTF-16 code units. */
  limit?: number;
  /** 1-indexed read start line. */
  startLine?: number;
  /** 1-indexed read end line. */
  endLine?: number;
  /** Maximum delivered words. */
  maxWords?: number;
  /** Replace-all flag. */
  replaceAll?: boolean;
  /** Alias for `replaceAll`. */
  allowMultiple?: boolean;
  /** Alias for `replaceAll`. */
  all?: boolean;
  /** Unknown extra keys stay untrusted until narrowed at the read site. */
  [key: string]: unknown;
};

// ============================================================================
// 5. VirtualFS Subsystem Class
// ============================================================================

/**
 * Options for configuring a VirtualFS instance upon construction.
 *
 * @example
 * ```typescript
 * const fs = new VirtualFS({ defaultBudgetBytes: 30000 });
 * ```
 */
export interface VirtualFSOptions {
  /** Default byte budget threshold for `readFile` (defaults to 20,000 bytes). `queryJson` keeps its
   * own fixed 1,500-byte default and does not consult this option. */
  defaultBudgetBytes?: number;
  /**
   * Trusted identity resolver used to resolve agent authority descriptors
   * (MOD-21 W4). Injected by the composition root; when absent every agent is
   * default-deny and only `global`/`public` files and the caller's own
   * workspace are reachable through the public seam.
   */
  identityPort?: VirtualFsIdentityPort | null;
  /**
   * Opaque engine-internal principal reference (MOD-21). Only this exact
   * object — never a plain lookalike — authorizes cross-workspace engine
   * synchronization (e.g. WorldClock writes) and the tenant-administration
   * members (`deleteWorkspace`, `reset`, `exportSnapshot`, `importSnapshot`,
   * `forAgent`) when passed as `options.principal`. Injected substrates that
   * cannot receive this option bind it once via
   * {@link VirtualFS.bindInternalPrincipal}.
   */
  internalPrincipal?: object | null;
}

/**
 * Trusted identity projection consumed by the workspace ACL.
 *
 * Structural mirror of the MOD-13 `AgentIdentityPort` projection; the canonical
 * definition lives in the runtime module. The projection is trusted
 * construction output — callers never supply it.
 */
export interface VirtualFsIdentityProjection {
  /** Registered agent identifier. */
  readonly id?: string;
  /**
   * Canonical internal identity key of this registration (`realm:<realmId>:<agentId>`
   * for Realm-bound agents, `system:<agentId>` for the bootstrap-only system
   * scope), the same string the runtime key/identity helper owns (Wave I,
   * ticket d57cbc1). Substrate consumers key realm-qualified per-agent state
   * (the private workspace key) on this value so the same literal id in two
   * realms never shares an entry.
   *
   * Internal only: never a tool parameter, receipt, listing label, error, or
   * prompt. Projections produced before the runtime wiring landed omit it;
   * consumers then keep the legacy bare-id resolution, so single-realm
   * sessions behave exactly as before.
   */
  readonly key?: string;
  /**
   * Legacy boolean privilege projection.
   * @deprecated Honored only as a fallback when `authority` is absent; the frozen `AuthorityDescriptor` replaces it.
   */
  readonly privileged?: boolean;
  /** Frozen authority descriptor resolved by the identity port. */
  readonly authority?: {
    /** Stable principal identifier. */
    readonly subject: string;
    /** Principal class: a registered agent or an engine-internal path. */
    readonly kind: 'agent' | 'internal';
    /** Frozen set (or test-double array) of canonical tool/op names; `'*'` permits everything. */
    readonly allow: ReadonlySet<string> | readonly string[];
    /** Read/operation scope; `'all'` and `'system'` grant cross-workspace authority. */
    readonly visibility: 'self' | 'owned' | 'all' | 'system';
  };
  /**
   * Realm membership resolved by the runtime identity projection (Realm wave A
   * ticket 49cfc41). Optional and additive: projections produced before the
   * runtime wiring landed carry no `realmId`, which keeps the ungrouped legacy
   * `global` scope.
   */
  readonly realmId?: string | null;
  /**
   * Whether the subject bypasses Realm scoping (the injected internal principal
   * or the hardcoded system director). Optional and additive; absent means
   * realm-bound when `realmId` is present.
   */
  readonly realmBypass?: boolean;
  /**
   * The subject's resolved private workspace key (`config.workspaceId`, or the
   * plain agent id when no explicit key was configured), when the producer
   * projects it (Realm wave R ticket a50f109). Optional and additive: projects
   * that omit it fall back to the plain agent id, which is the composition
   * convention for default workspace keys, so a projection that never received
   * the field stays fully compatible.
   */
  readonly workspaceId?: string | null;
}

/**
 * Trusted resolution scope accepted by the identity port (Wave I, ticket
 * d57cbc1): structural mirror of the runtime `AgentIdentityScope`. Substrate
 * callers that know the caller's realm pass it explicitly so a bare id
 * resolves realm-exactly; callers that omit it keep the unique-match rule
 * (an id registered in more than one realm fails closed).
 */
export interface VirtualFsIdentityScope {
  /** Realm membership to resolve exactly; `null` selects the system scope. */
  readonly realmId?: string | null;
  /** Resolve the unique match across every Realm. */
  readonly realmBypass?: boolean;
}

/**
 * Trusted identity resolver injected into the VirtualFS (default-deny when absent).
 * Structural mirror of the MOD-13 `AgentIdentityPort`.
 */
export interface VirtualFsIdentityPort {
  /**
   * Resolves the identity projection of a registered agent, or `null` when no
   * trusted principal matches the subject.
   *
   * @param agentId - Claimed caller identity to resolve.
   * @param scope - Optional trusted resolution scope (Wave I, ticket d57cbc1);
   *   omitted scopes keep the legacy unique-match rule.
   * @returns Frozen identity projection or `null` (anonymous).
   */
  getAgentIdentity(agentId: string, scope?: VirtualFsIdentityScope): VirtualFsIdentityProjection | null;

  /**
   * Enumerates the active registrations a scope can resolve (Wave I, ticket
   * d57cbc1), used to match a canonical identity `key` back to its projection.
   * Optional and additive: legacy ports without it fall back to the local
   * canonical-key parser plus a scoped `getAgentIdentity`.
   *
   * @param scope - Optional trusted resolution scope; omitted scopes enumerate
   *   every active registration.
   * @returns Identity projections, or an empty array when none.
   */
  listAgentIdentities?(scope?: VirtualFsIdentityScope): VirtualFsIdentityProjection[];
}


/**
 * Standard budget limits (expanded to 20,000 bytes ~ 3,333 words)
 */
export const DEFAULT_BUDGET_BYTES: number = 20000;

/**
 * Default word budget (3,333 words) equivalent to the default 20,000-byte budget
 * at a conservative 6 bytes/word; word budgets are converted to bytes on that ratio.
 */
export const DEFAULT_WORD_BUDGET: number = 3333;

/**
 * Per-file byte cap applied to every file-sourced plumbing reference
 * (`write_file.source_file`, `replace_file_content.replacement_source_file`,
 * `write_json.data_source_file`, `json_patch[].value_file`,
 * `query_json.output_file` serialization, and each `concat_files` source).
 *
 * Mirrors the ratified Wave U per-file cap (2 MiB — git-bug `36f2763`, the
 * same value the template-import path uses) and keeps every plumbing read
 * bounded;
 * an oversize reference fails closed with a typed `FileTooLargeError` before
 * any destination mutation.
 */
export const FILE_PLUMBING_MAX_FILE_BYTES: number = 2 * 1024 * 1024;

/**
 * Aggregate byte cap for one file-plumbing operation (the joined
 * `concat_files` payload and the cumulative bytes read across its sources).
 *
 * Mirrors the ratified Wave U payload ceiling (8 MiB — git-bug `36f2763`).
 */
export const FILE_PLUMBING_MAX_TOTAL_BYTES: number = 8 * 1024 * 1024;

/**
 * Computes the UTF-8 byte length of a string with the same encoder the
 * read/write budget accounting uses.
 * @param content - String to measure
 * @returns UTF-8 byte length
 */
function utf8ByteLength(content: string): number {
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  return encoder ? encoder.encode(content).length : Buffer.byteLength(content, 'utf8');
}

/**
 * Builds a typed `INVALID_ARGUMENTS` failure for file-plumbing argument-shape
 * violations (inline/file mutual exclusion, malformed references). The code is
 * a member of the tool-system error vocabulary, so the dispatcher's error
 * shield preserves it in the failure receipt.
 * @param message - Descriptive failure message
 * @returns An `Error` carrying `code: 'INVALID_ARGUMENTS'`
 */
function invalidArgumentsError(message: string): Error {
  const err = new Error(message) as Error & { code: 'INVALID_ARGUMENTS' };
  err.code = 'INVALID_ARGUMENTS';
  return err;
}

/**
 * Builds a typed `INVALID_ARGUMENTS` failure for a file-sourced reference whose
 * bytes are not valid JSON (used by `data_source_file` and `value_file`).
 * @param label - Plumbing parameter label (e.g. `data_source_file`)
 * @param filePath - Referenced path
 * @param cause - Parse failure cause
 * @returns An `Error` carrying `code: 'INVALID_ARGUMENTS'`
 */
function invalidJsonSourceError(label: string, filePath: string, cause: unknown): Error {
  return invalidArgumentsError(`${label} '${filePath}' must contain valid JSON: ${errorMessage(cause)}`);
}

/**
 * Safe RegExp escaping utility to prevent syntax errors and ReDoS vulnerabilities.
 * @param str -
 * @returns
 */
function escapeRegExp(str: string): string {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Safely parses numbers and trimmed numeric strings to integers.
 * @param val -
 * @param defaultVal -
 * @returns
 */
function toInteger(val: unknown, defaultVal: number | undefined = undefined): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) {
    return Math.floor(val);
  }
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (trimmed.length > 0) {
      const parsed = parseInt(trimmed, 10);
      if (!isNaN(parsed) && Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return defaultVal;
}

/**
 * Parse a JSON pointer path into array of decoded segments.
 * @param path -
 * @returns
 */
function parseJsonPointer(path: string): string[] {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    return [];
  }
  return path.slice(1).split('/').map(segment => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
}

/**
 * Preprocesses RFC 6902 patch operations with lenient auto-upsert on object keys
 * and automatic intermediate container creation, then applies operations atomically.
 * @param originalDoc -
 * @param operations -
 * @returns
 */
function preprocessAndApplyPatch(originalDoc: JsonValue, operations: JsonPatchOperation[]): { newDocument: JsonValue; processedOperations: JsonPatchOperation[] } {
  let workingDoc: JsonValue = JSON.parse(JSON.stringify(originalDoc));
  const processedOps: JsonPatchOperation[] = [];

  for (let i = 0; i < operations.length; i++) {
    const rawOp = operations[i];
    if (!rawOp || typeof rawOp !== 'object') {
      const err: Error & { index?: number } = new Error(`Invalid patch operation at index ${i}`);
      err.index = i;
      throw err;
    }
    const opObj: JsonPatchOperation = { ...rawOp };
    const path = opObj.path;

    if (typeof path === 'string' && path.startsWith('/')) {
      const segments = parseJsonPointer(path);
      if (segments.length > 0) {
        const targetKey = segments[segments.length - 1];
        const parentSegments = segments.slice(0, -1);

        let curr: JsonValue | undefined = workingDoc;
        let canTraverse = true;

        for (let s = 0; s < parentSegments.length; s++) {
          const seg = parentSegments[s];
          if (curr !== null && curr !== undefined && typeof curr === 'object') {
            if (Array.isArray(curr)) {
              const idx: number = seg === '-' ? curr.length : parseInt(seg, 10);
              if (!isNaN(idx) && idx >= 0 && idx < curr.length) {
                curr = curr[idx];
              } else {
                canTraverse = false;
                break;
              }
            } else {
              if (Object.prototype.hasOwnProperty.call(curr, seg)) {
                curr = dynamicGet(curr, seg);
              } else {
                if (opObj.op === 'add' || opObj.op === 'replace') {
                  dynamicSet(curr, seg, {});
                  curr = dynamicGet(curr, seg);
                } else {
                  canTraverse = false;
                  break;
                }
              }
            }
          } else {
            canTraverse = false;
            break;
          }
        }

        if (canTraverse && curr !== null && curr !== undefined && typeof curr === 'object' && !Array.isArray(curr)) {
          if (opObj.op === 'replace') {
            if (!Object.prototype.hasOwnProperty.call(curr, targetKey)) {
              opObj.op = 'add';
            }
          }
        }
      }
    }

    processedOps.push(opObj);
    try {
      const opResult = jsonpatch.applyOperation(workingDoc, opObj as Parameters<typeof jsonpatch.applyOperation>[1], true, false);
      if (opResult.newDocument !== undefined) {
        workingDoc = opResult.newDocument;
      }
    } catch (opErr) {
      const err = opErr as Error & { index?: number; operation?: unknown };
      err.index = i;
      err.operation = opObj;
      throw err;
    }
  }

  return { newDocument: workingDoc, processedOperations: processedOps };
}

/**
 * Reads the first own property among `keys` from `obj`, never consulting the prototype chain.
 * Identity and ownership fields resolved through this helper cannot be spoofed by
 * `Object.prototype` pollution.
 * @param obj -
 * @param keys -
 * @returns
 */
function readOwn(obj: unknown, ...keys: string[]): unknown {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) return dynamicGet(obj, key);
  }
  return undefined;
}

/**
 * MOD-21 W4 authority predicate: reports whether a frozen `AuthorityDescriptor`
 * (resolved through the injected identity port) grants cross-workspace
 * authority to its principal.
 *
 * A descriptor grants cross-workspace authority when its `visibility` is
 * `'all'` or `'system'`, or when its `allow` set carries the `'*'` wildcard.
 * Every other shape (absent descriptor, `'self'`/`'owned'` visibility, explicit
 * tool list) is default-deny.
 * @param authority -
 * @returns
 */
function authorityGrantsSubstratePrivilege(authority: unknown): boolean {
  if (!authority || typeof authority !== 'object') return false;
  const descriptor = authority as { visibility?: unknown; allow?: unknown };
  if (descriptor.visibility === 'all' || descriptor.visibility === 'system') return true;
  const allow = descriptor.allow;
  if (allow instanceof Set) return allow.has('*');
  if (Array.isArray(allow)) return allow.includes('*');
  return false;
}

/**
 * Sanitizes VirtualFS caller options.
 *
 * MOD-21 W4: authority is never taken from per-call options — neither the
 * caller payload nor the trailing "trusted" context. The flag fields
 * (`isAdmin`/`privileged`/`isPrivileged`/`callerRole`) and descriptor-shaped
 * authority claims are stripped from both sources and forced to non-privileged
 * placeholders; only the injected identity port and the opaque injected
 * `internalPrincipal` reference (checked by reference downstream) can confer
 * authority. The returned options object has a null prototype, so inherited
 * `Object.prototype` keys can never surface as caller identity, owner, or
 * privilege fields.
 * @param untrustedPayload -
 * @param trustedOptions -
 * @returns
 */
function sanitizeFsOptions(untrustedPayload: unknown = {}, trustedOptions: unknown = {}): ResolvedCallOptions {
  const untrusted = typeof untrustedPayload === 'object' && untrustedPayload !== null ? untrustedPayload : {};
  const trusted = typeof trustedOptions === 'object' && trustedOptions !== null ? trustedOptions : {};

  const options = Object.assign(Object.create(null), untrusted, trusted);
  delete options.isAdmin;
  delete options.privileged;
  delete options.isPrivileged;
  delete options.callerRole;
  delete options.authority;
  delete options.authorityDescriptor;

  options.isAdmin = false;
  options.privileged = false;
  options.isPrivileged = false;
  options.callerRole = undefined;
  return options;
}

/**
 * Caller-payload identity keys that can never outrank a supplied trusted context.
 * MOD-21 W9-A (tickets 03c0e2c/7651555, 135e77c, f59fd2c).
 */
const PAYLOAD_IDENTITY_KEYS: ReadonlyArray<string> = Object.freeze(['callerAgentId', 'caller_agent_id', 'agentId', 'agent_id']);

/**
 * MOD-21 W9-A: binds the effective caller identity for an object-first call.
 *
 * When a trusted context object is supplied (the trailing argument of the
 * canonical object-first forms) it is the only identity source: the payload's
 * identity keys are removed from the merged options and the effective caller is
 * the context's own identity, or `null` when the context binds none (an
 * anonymous dispatcher stays anonymous). Context-less direct-API object calls
 * keep the legacy payload identity channel.
 * @param options - Sanitized options bag already merged with `trusted`
 * @param trusted - Trusted context / nested options, when supplied
 * @param contextSupplied - Whether the trailing call context object was supplied
 * @param payloadCallerId - Payload identity local (legacy fallback)
 * @returns The same options bag, identity-bound
 */
function applyTrustedIdentity(options: ResolvedCallOptions, trusted: unknown, contextSupplied: boolean, payloadCallerId: unknown): ResolvedCallOptions {
  if (!contextSupplied) {
    if (typeof payloadCallerId === 'string' && payloadCallerId && !options.callerAgentId) {
      options.callerAgentId = payloadCallerId;
    }
    return options;
  }
  for (const key of PAYLOAD_IDENTITY_KEYS) delete options[key];
  const trustedCaller = trusted ? readOwn(trusted, ...PAYLOAD_IDENTITY_KEYS) : undefined;
  options.callerAgentId = typeof trustedCaller === 'string' ? trustedCaller : null;
  // The canonical caller key (Wave I, ticket d57cbc1) is a trusted-context
  // channel exactly like the caller identity: a payload claim is stripped and
  // only the trusted source may bind it. It stays out of `callerAgentId` (the
  // value is internal vocabulary) and rides the attached provenance.
  delete options.callerKey;
  delete options.caller_key;
  const trustedKey = trusted ? readOwn(trusted, 'callerKey', 'caller_key') : undefined;
  if (typeof trustedKey === 'string' && trustedKey.trim()) options.callerKey = trustedKey.trim();
  return options;
}

/**
 * Sanitizes object-first call options and binds the effective caller identity
 * from the trusted context only (MOD-21 W9-A). Equivalent to
 * `applyTrustedIdentity(sanitizeFsOptions(payload, trusted), trusted, contextSupplied, payloadCallerId)`
 * with the trusted source selected from the trailing context or the payload's
 * nested `options` bag.
 * @param payload - Object-first named-parameter payload
 * @param context - Trailing trusted call context
 * @param payloadCallerId - Payload identity local (legacy fallback)
 * @returns
 */
function resolveObjectCallOptions(payload: object, context: unknown, payloadCallerId: unknown): ResolvedCallOptions {
  const contextSupplied = typeof context === 'object' && context !== null;
  const nestedOptions = readOwn(payload, 'options');
  const trusted = contextSupplied
    ? context
    : (typeof nestedOptions === 'object' && nestedOptions !== null ? nestedOptions : undefined);
  const options = sanitizeFsOptions(payload, trusted);
  applyTrustedIdentity(options, trusted, contextSupplied, payloadCallerId);
  return contextSupplied ? attachTrustedAgentContext(options, trusted) : options;
}

/**
 * Module-private symbol under which a call's trusted-context provenance is
 * attached to the resolved options bag. Symbol keys never serialize and are
 * never read from caller payloads, so provenance cannot be forged through
 * wire data. The property is enumerable so object spread keeps it across the
 * module's own delegating calls (`queryJson`/`transformJson`/`writeJson`).
 * @internal
 */
const TRUSTED_AGENT_CONTEXT_KEY: symbol = Symbol('virtualFs.trustedAgentContext');

/**
 * Trusted provenance of a call's trailing context / positional options
 * object: the caller identity the trusted source bound, the private-workspace
 * binding it carried, and whether the turn engine bound the workspace-view
 * token.
 * @internal
 */
interface TrustedAgentProvenance {
  /** Caller identity bound by the trusted source. */
  readonly callerAgentId: string;
  /**
   * Canonical identity key bound by the trusted source (Wave I, ticket
   * d57cbc1), when the internal context carries one. Resolved through the
   * identity port by `key` match so a same-literal-id realm pair resolves
   * realm-exactly; a supplied key that does not resolve fails the call closed.
   */
  readonly callerKey: string | null;
  /** Private-workspace binding carried by the trusted source, when present. */
  readonly workspaceId: string | null;
  /** Whether the engine bound the workspace-view token. */
  readonly viewToken: boolean;
}

/**
 * Attaches the trusted-context provenance to a resolved options bag.
 *
 * Provenance is captured only when the trusted source binds a non-empty
 * caller identity; a context that binds no caller stays anonymous and keeps
 * the legacy semantics. The private-workspace binding and the engine token
 * are read from the trusted source only.
 * @param options - Sanitized/merged options bag
 * @param trusted - Trailing context or positional options object
 * @returns The same options bag, provenance attached when resolvable
 */
function attachTrustedAgentContext(options: ResolvedCallOptions, trusted: unknown): ResolvedCallOptions {
  if (!trusted || typeof trusted !== 'object') return options;
  const rawCaller = readOwn(trusted, ...PAYLOAD_IDENTITY_KEYS);
  const callerAgentId = typeof rawCaller === 'string' && rawCaller.trim() ? rawCaller.trim() : null;
  if (!callerAgentId) return options;
  const rawWorkspace = readOwn(trusted, 'workspaceId', 'workspace_id');
  const workspaceId = typeof rawWorkspace === 'string' && rawWorkspace.trim() ? rawWorkspace.trim() : null;
  const viewToken = readOwn(trusted, 'agentWorkspaceView') === AGENT_WORKSPACE_VIEW_TOKEN;
  const rawCallerKey = readOwn(trusted, 'callerKey', 'caller_key');
  const callerKey = typeof rawCallerKey === 'string' && rawCallerKey.trim() ? rawCallerKey.trim() : null;
  const provenance: TrustedAgentProvenance = Object.freeze({ callerAgentId, callerKey, workspaceId, viewToken });
  Object.defineProperty(options, TRUSTED_AGENT_CONTEXT_KEY, {
    value: provenance,
    enumerable: true,
    configurable: true,
    writable: true
  });
  return options;
}

/**
 * Sanitizes a positional/options call and attaches its trusted provenance
 * (caller identity plus private-workspace binding) from the same source.
 * @param trusted - Positional options object
 * @returns Resolved options bag with provenance when resolvable
 */
function resolvePositionalCallOptions(trusted: unknown): ResolvedCallOptions {
  const options = sanitizeFsOptions(trusted, trusted);
  return attachTrustedAgentContext(options, trusted);
}

/**
 * Reads the trusted provenance attached by {@link attachTrustedAgentContext}.
 * @param options - Resolved options bag
 * @returns Provenance or null when the call had no trusted caller binding
 */
function readTrustedAgentContext(options: unknown): TrustedAgentProvenance | null {
  if (!options || typeof options !== 'object') return null;
  const provenance = (options as Record<string | symbol, unknown>)[TRUSTED_AGENT_CONTEXT_KEY];
  return provenance && typeof provenance === 'object' ? provenance as TrustedAgentProvenance : null;
}

/**
 * Canonical tool-parameter (snake_case) to VirtualFS named-argument (camelCase) aliases.
 * Tool descriptors sanitize incoming arguments to snake_case, so every named-argument
 * branch must accept the canonical schema keys in addition to the historical camelCase ones.
 */
const CANONICAL_PARAM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  file_path: 'filePath',
  src_path: 'srcPath',
  dest_path: 'destPath',
  src_workspace_id: 'srcWorkspaceId',
  dest_workspace_id: 'destWorkspaceId',
  json_path: 'query',
  target_content: 'targetContent',
  replacement_content: 'replacementContent',
  replacement_source_file: 'replacementSourceFile',
  source_file: 'sourceFile',
  data_source_file: 'dataSourceFile',
  output_file: 'outputFile',
  replace_all: 'replaceAll',
  read_only: 'readOnly',
  path_prefix: 'pathPrefix',
  is_regex: 'isRegex',
  case_insensitive: 'caseInsensitive',
  directory_path: 'dirPath',
  start_line: 'startLine',
  end_line: 'endLine',
  byte_offset: 'offset',
  byte_limit: 'limit',
  caller_agent_id: 'callerAgentId',
  workspace_id: 'workspaceId'
});

/**
 * Projects canonical snake_case tool parameters onto their camelCase counterparts
 * without mutating the caller payload. Existing camelCase keys always win.
 * @param params -
 * @returns
 */
function normalizeCanonicalParams<T>(params: T): T {
  if (!params || typeof params !== 'object' || Array.isArray(params) || params instanceof RegExp) {
    return params;
  }
  const normalized = Object.assign(Object.create(null), params);
  for (const [canonicalKey, camelKey] of Object.entries(CANONICAL_PARAM_ALIASES)) {
    if (normalized[camelKey] === undefined && normalized[canonicalKey] !== undefined) {
      normalized[camelKey] = normalized[canonicalKey];
    }
  }
  return normalized;
}

/**
 * Count whitespace-delimited words in a string.
 * @param str -
 * @returns
 */
function countWords(str: string): number {
  if (!str || typeof str !== 'string') return 0;
  return str.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Truncates text to at most `maxWords` whitespace-delimited words.
 * Whitespace interleaved between retained words is preserved; the returned
 * `endIndex` is the UTF-16 code-unit position where the retained prefix ends.
 * @param content -
 * @param maxWords -
 * @returns
 */
function truncateToWordBudget(content: string, maxWords: number): { content: string; endIndex: number; wordsIncluded: number; truncated: boolean } {
  const text = typeof content === 'string' ? content : '';
  const totalWords = countWords(text);
  const limit = typeof maxWords === 'number' && Number.isFinite(maxWords)
    ? Math.max(0, Math.floor(maxWords))
    : Number.MAX_SAFE_INTEGER;
  if (totalWords <= limit) {
    return { content: text, endIndex: text.length, wordsIncluded: totalWords, truncated: false };
  }
  let i = 0;
  let words = 0;
  const len = text.length;
  while (i < len && words < limit) {
    while (i < len && /\s/.test(text[i])) i++;
    if (i >= len) break;
    while (i < len && !/\s/.test(text[i])) i++;
    words++;
  }
  return { content: text.slice(0, i), endIndex: i, wordsIncluded: words, truncated: true };
}

/**
 * Advances past the next whitespace-delimited word starting at `from`, guaranteeing a
 * strictly greater result unless `from` already sits at (or past) end of string.
 * Used to keep word-budget continuations monotonic inside a single long line.
 * @param content -
 * @param from -
 * @returns
 */
function advancePastNextWord(content: string, from: number): number {
  const len = content.length;
  let i = Math.min(Math.max(0, from), len);
  while (i < len && /\s/.test(content[i])) i++;
  while (i < len && !/\s/.test(content[i])) i++;
  return i;
}

/**
 * Maps a content-space index (line text without `N: ` prefixes, lines joined by `\n`)
 * back to the absolute UTF-16 code-unit offset of the underlying file content.
 * Used to apply word budgets to delivered words rather than to rendered line-number prefixes.
 * @param parts -
 * @param contentIndex -
 * @returns
 */
function contentIndexToFileOffset(parts: Array<{ prefix: string; text: string; fileStart: number }>, contentIndex: number): number {
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const separatorLength = i > 0 ? 1 : 0;
    const segmentLength = separatorLength + part.text.length;
    if (contentIndex < cursor + segmentLength) {
      const local = contentIndex - cursor;
      if (local < separatorLength) return part.fileStart;
      return part.fileStart + (local - separatorLength);
    }
    cursor += segmentLength;
  }
  if (parts.length === 0) return 0;
  const last = parts[parts.length - 1];
  return last.fileStart + last.text.length;
}

/**
 * Locates the rendered slice cut index and the 1-indexed line number containing an
 * absolute file-content offset (the inverse of {@link contentIndexToFileOffset} in
 * rendered space).
 * @param parts -
 * @param startLineNumber -
 * @param fileOffset -
 * @returns
 */
function fileOffsetToRenderedCut(parts: Array<{ prefix: string; text: string; fileStart: number }>, startLineNumber: number, fileOffset: number): { renderedIndex: number; lineNumber: number } {
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const separatorLength = i > 0 ? 1 : 0;
    const textRenderedStart = cursor + separatorLength + part.prefix.length;
    const textFileStart = part.fileStart;
    const textFileEnd = part.fileStart + part.text.length;
    if (fileOffset <= textFileStart) {
      return { renderedIndex: cursor, lineNumber: startLineNumber + i };
    }
    if (fileOffset < textFileEnd) {
      return { renderedIndex: textRenderedStart + (fileOffset - textFileStart), lineNumber: startLineNumber + i };
    }
    if (i === parts.length - 1) {
      // Beyond the last delivered character: keep the final text, never a dangling prefix.
      return {
        renderedIndex: part.text.length > 0 ? textRenderedStart + part.text.length : cursor,
        lineNumber: startLineNumber + i
      };
    }
    cursor += separatorLength + part.prefix.length + part.text.length;
  }
  return { renderedIndex: cursor, lineNumber: startLineNumber + Math.max(0, parts.length - 1) };
}

/**
 * Element-aware and key-aware structured JSON truncation preventing raw byte-chopping syntax errors.
 * @param data - Parsed JSON object or array
 * @param budgetLimit - Maximum allowed bytes
 * @returns
 */
function truncateStructuredJson(data: JsonValue, budgetLimit: number = 1500): { truncated: boolean; content: string; totalBytes: number; remainingBytes: number; nextOffset?: number; notice?: string; itemsIncluded?: number; totalItems?: number; keysIncluded?: number; totalKeys?: number } {
  const fullStr = JSON.stringify(data, null, 2);
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const totalBytes = encoder ? encoder.encode(fullStr).length : Buffer.byteLength(fullStr, 'utf8');

  if (totalBytes <= budgetLimit) {
    return {
      truncated: false,
      content: fullStr,
      totalBytes,
      remainingBytes: 0
    };
  }

  if (Array.isArray(data)) {
    let low = 0;
    let high = data.length;
    let bestSlice: JsonValue[] = [];
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = data.slice(0, mid);
      const str = JSON.stringify(candidate, null, 2);
      const bytes = encoder ? encoder.encode(str).length : Buffer.byteLength(str, 'utf8');
      if (bytes <= budgetLimit) {
        bestSlice = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const truncatedContent = JSON.stringify(bestSlice, null, 2);
    const contentBytes = encoder ? encoder.encode(truncatedContent).length : Buffer.byteLength(truncatedContent, 'utf8');
    const remainingBytes = Math.max(0, totalBytes - contentBytes);
    return {
      truncated: true,
      content: truncatedContent,
      itemsIncluded: bestSlice.length,
      totalItems: data.length,
      totalBytes,
      remainingBytes,
      nextOffset: bestSlice.length,
      notice: `JSON output truncated at ${budgetLimit.toLocaleString()} bytes (${bestSlice.length}/${data.length} array items preserved).`
    };
  } else if (typeof data === 'object' && data !== null) {
    const keys = Object.keys(data);
    let low = 0;
    let high = keys.length;
    let bestKeys: string[] = [];
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidateKeys = keys.slice(0, mid);
      const candidate: Record<string, JsonValue> = {};
      for (const k of candidateKeys) {
        candidate[k] = data[k];
      }
      const str = JSON.stringify(candidate, null, 2);
      const bytes = encoder ? encoder.encode(str).length : Buffer.byteLength(str, 'utf8');
      if (bytes <= budgetLimit) {
        bestKeys = candidateKeys;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    const truncatedObj: Record<string, JsonValue> = {};
    for (const k of bestKeys) {
      truncatedObj[k] = data[k];
    }
    const truncatedContent = JSON.stringify(truncatedObj, null, 2);
    const contentBytes = encoder ? encoder.encode(truncatedContent).length : Buffer.byteLength(truncatedContent, 'utf8');
    const remainingBytes = Math.max(0, totalBytes - contentBytes);
    return {
      truncated: true,
      content: truncatedContent,
      keysIncluded: bestKeys.length,
      totalKeys: keys.length,
      totalBytes,
      remainingBytes,
      nextOffset: bestKeys.length,
      notice: `JSON output truncated at ${budgetLimit.toLocaleString()} bytes (${bestKeys.length}/${keys.length} keys preserved).`
    };
  }

  const truncatedContent = fullStr.slice(0, budgetLimit);
  return {
    truncated: true,
    content: truncatedContent,
    totalBytes,
    remainingBytes: Math.max(0, totalBytes - budgetLimit),
    nextOffset: budgetLimit,
    notice: `Output truncated at ${budgetLimit.toLocaleString()} bytes.`
  };
}

/**
 * Matches the realm-global partition namespace (`realm:<realmId>:global`,
 * Realm wave A convention) whose keys ordinary lifecycle eviction must never
 * delete, and which every agent-visible surface presents as the shared
 * `global` workspace.
 * @internal
 */
const REALM_GLOBAL_WORKSPACE_KEY_PATTERN = /^realm:.+:global$/;

/**
 * Percent-decodes one canonical-key segment, returning `null` on malformed
 * escape sequences instead of throwing.
 * @param segment - Encoded key segment.
 * @returns Decoded segment or null.
 * @internal
 */
function decodeIdentityKeySegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * Parses a canonical identity key into its `(realmId, agentId)` pair (Wave I,
 * ticket d57cbc1). Realm-global partition keys (`realm:<realmId>:global`) are
 * not identity keys and return `null` — the shared-global mapping owns them.
 * @param key - Candidate canonical identity key.
 * @returns The decoded pair, or `null` when the string is not well-formed.
 * @internal
 */
function parseCanonicalIdentityKey(key: string): { realmId: string | null; agentId: string } | null {
  if (typeof key !== 'string' || key === '') return null;
  if (REALM_GLOBAL_WORKSPACE_KEY_PATTERN.test(key)) return null;
  if (key.startsWith('system:')) {
    const agentId = decodeIdentityKeySegment(key.slice('system:'.length));
    return agentId === null || agentId === '' ? null : { realmId: null, agentId };
  }
  if (!key.startsWith('realm:')) return null;
  const rest = key.slice('realm:'.length);
  const separator = rest.indexOf(':');
  if (separator <= 0) return null;
  const realmId = decodeIdentityKeySegment(rest.slice(0, separator));
  const agentId = decodeIdentityKeySegment(rest.slice(separator + 1));
  if (realmId === null || realmId === '' || agentId === null || agentId === '') return null;
  return { realmId, agentId };
}

/**
 * Decodes the realm-local agent id carried by a canonical identity key
 * (`realm:<realmId>:<agentId>` for Realm-bound registrations, `system:<agentId>`
 * for the bootstrap-only system scope; Wave I, ticket d57cbc1) so agent-visible
 * surfaces can project the bare id.
 *
 * Realm-global partition keys (`realm:<realmId>:global`) are not identity keys
 * and decode to `null` — the shared-global mapping owns them. Malformed or
 * non-canonical strings decode to `null` and pass through untouched, so an
 * ordinary workspace key is never rewritten by the mask.
 *
 * @param key - Candidate canonical identity key.
 * @returns The decoded bare agent id, or `null` when the string is not a
 *   well-formed canonical non-shared identity key.
 * @internal
 */
function canonicalIdentityKeyAgentId(key: string): string | null {
  const parsed = parseCanonicalIdentityKey(key);
  return parsed ? parsed.agentId : null;
}

/**
 * Resolves the private workspace key an agent identity projection owns
 * (Wave I, ticket d57cbc1): an explicit projected pin (`workspaceId` differing
 * from both the bare id and the canonical key) is preserved verbatim, a
 * realm-bound projection keys on its canonical identity `key`, and every other
 * projection keeps the legacy bare agent id. Callers apply the reserved-key
 * filter themselves, exactly like the workspace-view resolution.
 *
 * This is the single owner of the rule: the VFS workspace view, mount
 * resolution, request remapping, and the legacy remap helper all consume it.
 *
 * @param projection - Trusted identity projection (or `null`).
 * @returns The resolved private workspace key, or `null` when the projection
 *   carries no bare id.
 *
 * @example
 * ```typescript
 * resolveAgentPrivateWorkspaceKey({ id: 'scout', key: 'realm:alpha:scout', realmId: 'alpha' });
 * // 'realm:alpha:scout'
 * resolveAgentPrivateWorkspaceKey({ id: 'scout', realmId: 'alpha', workspaceId: 'shared_ws' });
 * // 'shared_ws'
 * resolveAgentPrivateWorkspaceKey({ id: 'director' });
 * // 'director'
 * ```
 */
export function resolveAgentPrivateWorkspaceKey(
  projection: { readonly id?: string; readonly key?: string; readonly workspaceId?: string | null; readonly realmId?: string | null; readonly realmBypass?: boolean } | null | undefined
): string | null {
  if (!projection || typeof projection !== 'object') return null;
  const id = typeof projection.id === 'string' && projection.id.trim() ? projection.id.trim() : null;
  if (!id) return null;
  const key = typeof projection.key === 'string' && projection.key.trim() ? projection.key.trim() : null;
  const rawWorkspaceId = typeof projection.workspaceId === 'string' && projection.workspaceId.trim()
    ? projection.workspaceId.trim()
    : null;
  // An explicit pin is a projected workspace value that names neither the bare
  // id nor the canonical identity; it is preserved verbatim. A projection that
  // reports the canonical key (the wiring flip) or the bare id resolves through
  // the canonical/bare branches below instead.
  if (rawWorkspaceId && rawWorkspaceId !== id && rawWorkspaceId !== key) return rawWorkspaceId;
  const realmId = typeof projection.realmId === 'string' && projection.realmId.trim() ? projection.realmId.trim() : null;
  if (realmId && key) return key;
  return rawWorkspaceId || id;
}

/**
 * Maps a workspace key onto its realm-opaque public form: every realm-global
 * partition key (`realm:<realmId>:global`) is presented as the shared
 * `global` workspace, every canonical identity key
 * (`realm:<realmId>:<agentId>` / `system:<agentId>`) is presented as the bare
 * agent id, and every other key passes through unchanged. Applied to every
 * operation receipt, listing label, and error so no agent-visible surface can
 * observe the internal partition or canonical-key vocabulary.
 * @param workspaceId - Effective workspace key
 * @returns Public, realm-opaque workspace label
 */
function publicWorkspaceKey(workspaceId: string): string {
  if (REALM_GLOBAL_WORKSPACE_KEY_PATTERN.test(workspaceId)) return 'global';
  const agentId = canonicalIdentityKeyAgentId(workspaceId);
  return agentId !== null ? agentId : workspaceId;
}

/**
 * Replaces any internal realm-global workspace key or canonical identity key
 * embedded in a message with its opaque label (the shared `global` workspace,
 * or the bare agent id).
 * @param message - Error or notice text
 * @returns Realm-opaque text
 */
function opaqueRealmText(message: string): string {
  if (typeof message !== 'string') return message;
  return message
    .replace(/realm:[^'"\s]+:global/g, 'global')
    .replace(/realm:[^:'"\s]+:[^'"\s]+/g, (match) => {
      const agentId = canonicalIdentityKeyAgentId(match);
      return agentId !== null ? agentId : match;
    });
}

/**
 * Thrown when an agent attempts unauthorized cross-tenant workspace access or overwriting a read-only global file.
 * Consumers catch and inspect `err.code === 'PERMISSION_DENIED'`.
 *
 * @example
 * ```typescript
 * try {
 *   virtualFs.readFile('/secret.txt', { workspaceId: 'agent_private', callerAgentId: 'intruder' });
 * } catch (err) {
 *   if (err instanceof PermissionDeniedError) {
 *     console.error(`Permission denied: ${err.message} (code: ${err.code})`);
 *   }
 * }
 * ```
 */
export class PermissionDeniedError extends Error {
  /** Deterministic error code identifier. */
  declare readonly code: 'PERMISSION_DENIED';
  /** Target workspace identifier where access was rejected. */
  declare readonly workspaceId: string | null;
  /** Identity of the caller whose access was rejected. */
  declare readonly callerAgentId: string | null;
  /** Virtual file path where access was rejected. */
  declare readonly filePath: string | null;

  /**
   * Constructs a new PermissionDeniedError.
   *
   * @param message - Descriptive error message.
   * @param details - Contextual error details.
   */
  constructor(message: string, details: { workspaceId?: string; callerAgentId?: string | null; filePath?: string; code?: string } = {}) {
    super(opaqueRealmText(message));
    this.name = 'PermissionDeniedError';
    this.code = (details.code || 'PERMISSION_DENIED') as 'PERMISSION_DENIED';
    this.workspaceId = details.workspaceId ? publicWorkspaceKey(details.workspaceId) : null;
    this.callerAgentId = details.callerAgentId || null;
    this.filePath = details.filePath || null;
  }
}

/**
 * Thrown when an operation targets a non-existent file path in a workspace (`err.code === 'FILE_NOT_FOUND'`).
 *
 * @example
 * ```typescript
 * try {
 *   virtualFs.readFile('/nonexistent.txt', { workspaceId: 'global' });
 * } catch (err) {
 *   if (err instanceof FileNotFoundError) {
 *     console.error(`File not found: ${err.filePath} in workspace ${err.workspaceId}`);
 *   }
 * }
 * ```
 */
export class FileNotFoundError extends Error {
  /** Deterministic error code identifier. */
  declare readonly code: 'FILE_NOT_FOUND';
  /** Workspace identifier where file was missing. */
  declare readonly workspaceId: string | null;
  /** Missing virtual file path. */
  declare readonly filePath: string | null;

  /**
   * Constructs a new FileNotFoundError.
   *
   * @param message - Descriptive error message.
   * @param details - Contextual error details.
   */
  constructor(message: string, details: { workspaceId?: string; filePath?: string; code?: string } = {}) {
    super(opaqueRealmText(message));
    this.name = 'FileNotFoundError';
    this.code = (details.code || 'FILE_NOT_FOUND') as 'FILE_NOT_FOUND';
    this.workspaceId = details.workspaceId ? publicWorkspaceKey(details.workspaceId) : null;
    this.filePath = details.filePath || null;
  }
}

/**
 * Thrown during file copying or creation when `overwrite: false` and destination file already exists (`err.code === 'FILE_EXISTS'`).
 *
 * @example
 * ```typescript
 * try {
 *   virtualFs.copyFile('/src.txt', '/dest.txt', { overwrite: false });
 * } catch (err) {
 *   if (err instanceof FileExistsError) {
 *     console.error(`Destination exists: ${err.filePath}`);
 *   }
 * }
 * ```
 */
export class FileExistsError extends Error {
  /** Deterministic error code identifier. */
  declare readonly code: 'FILE_EXISTS';
  /** Workspace identifier where file exists. */
  declare readonly workspaceId: string | null;
  /** Existing virtual file path. */
  declare readonly filePath: string | null;

  /**
   * Constructs a new FileExistsError.
   *
   * @param message - Descriptive error message.
   * @param details - Contextual error details.
   */
  constructor(message: string, details: { workspaceId?: string; filePath?: string } = {}) {
    super(opaqueRealmText(message));
    this.name = 'FileExistsError';
    this.code = 'FILE_EXISTS';
    this.workspaceId = details.workspaceId ? publicWorkspaceKey(details.workspaceId) : null;
    this.filePath = details.filePath || null;
  }
}

/**
 * Thrown when a file-sourced plumbing reference exceeds the ratified cap
 * (`err.code === 'FILE_TOO_LARGE'`): the per-file 2 MiB limit
 * ({@link FILE_PLUMBING_MAX_FILE_BYTES}) or the 8 MiB aggregate limit
 * ({@link FILE_PLUMBING_MAX_TOTAL_BYTES}).
 *
 * Failures are pre-mutation and fail closed: the destination is never touched
 * when a source reference is rejected as oversize.
 *
 * @example
 * ```typescript
 * try {
 *   virtualFs.writeFile('/dest.bin', { sourceFile: '/huge.bin' });
 * } catch (err) {
 *   if (err instanceof FileTooLargeError) {
 *     console.error(`Source too large: ${err.actualBytes} > ${err.maxBytes}`);
 *   }
 * }
 * ```
 */
export class FileTooLargeError extends Error {
  /** Deterministic error code identifier. */
  declare readonly code: 'FILE_TOO_LARGE';
  /** Workspace identifier containing the oversize file. */
  declare readonly workspaceId: string | null;
  /** Oversize virtual file path. */
  declare readonly filePath: string | null;
  /** Applicable cap in bytes. */
  declare readonly maxBytes: number;
  /** Actual observed byte size (or cumulative size for aggregate caps). */
  declare readonly actualBytes: number;

  /**
   * Constructs a new FileTooLargeError.
   *
   * @param message - Descriptive error message.
   * @param details - Cap and context details.
   */
  constructor(message: string, details: { workspaceId?: string; filePath?: string; maxBytes?: number; actualBytes?: number } = {}) {
    super(opaqueRealmText(message));
    this.name = 'FileTooLargeError';
    this.code = 'FILE_TOO_LARGE';
    this.workspaceId = details.workspaceId ? publicWorkspaceKey(details.workspaceId) : null;
    this.filePath = details.filePath || null;
    this.maxBytes = typeof details.maxBytes === 'number' ? details.maxBytes : FILE_PLUMBING_MAX_FILE_BYTES;
    this.actualBytes = typeof details.actualBytes === 'number' ? details.actualBytes : 0;
  }
}

/**
 * Canonical POSIX path normalizer.
 * Resolves '.', '..', redundant slashes, and relative paths without escaping the virtual root '/'.
 *
 * @param filePath - Raw path string.
 * @returns Normalized absolute POSIX path.
 *
 * @example
 * ```typescript
 * normalizeVirtualPath('lore/../lore/codex.json'); // Returns '/lore/codex.json'
 * normalizeVirtualPath('/a/b/../../c');            // Returns '/c'
 * ```
 */
export function normalizeVirtualPath(filePath: string | null | undefined): string {
  if (!filePath || typeof filePath !== 'string') {
    return '/';
  }

  let p = filePath.replace(/\\/g, '/').trim();
  if (!p.startsWith('/')) {
    p = '/' + p;
  }

  const parts = p.split('/');
  const stack: string[] = [];

  for (const segment of parts) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      stack.pop();
    } else {
      stack.push(segment);
    }
  }

  return '/' + stack.join('/');
}

/**
 * Tokenizes keypath for safe JSON querying without eval.
 * Supports: 'foo.bar[0].baz', 'matrix[1][2]', 'items["nested.key"]', 'a/b/c', '$.user.name'.
 * @param path -
 * @returns
 */
function tokenizeKeyPath(path: string): Array<string | number> {
  if (path === null || path === undefined) return [];
  if (typeof path !== 'string') return [];

  let trimmed = path.trim();
  if (trimmed === '' || trimmed === '/' || trimmed === '$') return [];
  if (trimmed.startsWith('$/')) trimmed = trimmed.slice(2);
  else if (trimmed.startsWith('$.')) trimmed = trimmed.slice(2);
  else if (trimmed.startsWith('$')) trimmed = trimmed.slice(1);
  if (trimmed.startsWith('/')) trimmed = trimmed.slice(1);
  if (trimmed === '') return [];

  const tokens: Array<string | number> = [];
  let i = 0;
  const len = trimmed.length;

  while (i < len) {
    const ch = trimmed[i];

    if (ch === '.' || ch === '/') {
      i++;
      continue;
    }

    if (ch === '[') {
      i++; // skip '['
      while (i < len && /\s/.test(trimmed[i])) i++; // skip whitespace

      if (i < len && (trimmed[i] === "'" || trimmed[i] === '"')) {
        const quote = trimmed[i];
        i++; // skip open quote
        let key = '';
        while (i < len && trimmed[i] !== quote) {
          if (trimmed[i] === '\\' && i + 1 < len) {
            i++;
            key += trimmed[i];
          } else {
            key += trimmed[i];
          }
          i++;
        }
        if (i < len && trimmed[i] === quote) i++; // skip close quote
        while (i < len && trimmed[i] !== ']') i++; // advance to ']'
        if (i < len && trimmed[i] === ']') i++; // skip ']'
        tokens.push(key);
      } else {
        let indexStr = '';
        while (i < len && trimmed[i] !== ']') {
          indexStr += trimmed[i];
          i++;
        }
        if (i < len && trimmed[i] === ']') i++; // skip ']'
        indexStr = indexStr.trim();
        const num = Number(indexStr);
        if (!isNaN(num) && Number.isInteger(num) && String(num) === indexStr) {
          tokens.push(num);
        } else if (indexStr.length > 0) {
          tokens.push(indexStr);
        }
      }
      continue;
    }

    let prop = '';
    while (i < len && trimmed[i] !== '.' && trimmed[i] !== '[' && trimmed[i] !== '/') {
      prop += trimmed[i];
      i++;
    }

    if (prop.length > 0) {
      const num = Number(prop);
      if (!isNaN(num) && Number.isInteger(num) && String(num) === prop) {
        tokens.push(num);
      } else {
        tokens.push(prop);
      }
    }
  }

  return tokens;
}

/**
 * Resolves tokenized path against target data structure.
 * @param target -
 * @param tokens -
 * @returns
 */
function resolveTokens(target: JsonValue, tokens: Array<string | number>): JsonValue | undefined {
  let curr: JsonValue | undefined = target;
  for (const token of tokens) {
    if (curr === null || curr === undefined) {
      return undefined;
    }
    if (typeof curr !== 'object') {
      return undefined;
    }
    curr = dynamicGet(curr, token);
  }
  return curr;
}

/**
 * Deep structural equality helper for jq comparison operations.
 * @param a -
 * @param b -
 * @returns
 */
function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const objA = a as { [key: string]: JsonValue };
  const objB = b as { [key: string]: JsonValue };
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false;
    if (!deepEqual(dynamicGet(objA, k), dynamicGet(objB, k))) return false;
  }
  return true;
}

/**
 * Tokenize jq expression into structured lexical tokens.
 * @param filter -
 * @returns
 */
function tokenizeJq(filter: string): JqToken[] {
  if (typeof filter !== 'string') return [];
  const src = filter.trim();
  const tokens: JqToken[] = [];
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (i + 1 < len) {
      const two = src.slice(i, i + 2);
      if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '+=' || two === '-=' || two === '*=' || two === '/=') {
        tokens.push({ type: 'OPERATOR', value: two });
        i += 2;
        continue;
      }
    }

    if (ch === '|' || ch === ',' || ch === ':' || ch === ';' || ch === '[' || ch === ']' || ch === '(' || ch === ')' || ch === '{' || ch === '}') {
      tokens.push({ type: ch, value: ch });
      i++;
      continue;
    }

    if (ch === '=' || ch === '<' || ch === '>' || ch === '+' || ch === '*' || ch === '/') {
      tokens.push({ type: 'OPERATOR', value: ch });
      i++;
      continue;
    }

    if (ch === '-') {
      const prev = tokens.length > 0 ? tokens[tokens.length - 1] : null;
      const isUnary = !prev || prev.type === 'OPERATOR' || prev.type === '(' || prev.type === '[' || prev.type === '{' || prev.type === ',' || prev.type === '|' || prev.type === ':';
      if (isUnary && i + 1 < len && /[0-9]/.test(src[i + 1])) {
        let numStr = '-';
        i++;
        while (i < len && /[0-9.]/.test(src[i])) {
          numStr += src[i];
          i++;
        }
        tokens.push({ type: 'NUMBER', value: Number(numStr) });
        continue;
      }
      tokens.push({ type: 'OPERATOR', value: '-' });
      i++;
      continue;
    }

    if (ch === '.') {
      tokens.push({ type: '.', value: '.' });
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let str = '';
      while (i < len && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < len) {
          i++;
          const esc = src[i];
          if (esc === 'n') str += '\n';
          else if (esc === 't') str += '\t';
          else if (esc === 'r') str += '\r';
          else if (esc === '\\') str += '\\';
          else if (esc === '"') str += '"';
          else if (esc === "'") str += "'";
          else str += esc;
        } else {
          str += src[i];
        }
        i++;
      }
      if (i < len && src[i] === quote) i++;
      tokens.push({ type: 'STRING', value: str });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let numStr = '';
      while (i < len && /[0-9.]/.test(src[i])) {
        numStr += src[i];
        i++;
      }
      tokens.push({ type: 'NUMBER', value: Number(numStr) });
      continue;
    }

    if (/[a-zA-Z_$]/.test(ch)) {
      let ident = '';
      while (i < len && /[a-zA-Z0-9_$-]/.test(src[i])) {
        ident += src[i];
        i++;
      }
      if (ident === 'true') {
        tokens.push({ type: 'BOOLEAN', value: true });
      } else if (ident === 'false') {
        tokens.push({ type: 'BOOLEAN', value: false });
      } else if (ident === 'null') {
        tokens.push({ type: 'NULL', value: null });
      } else if (ident === 'and' || ident === 'or') {
        tokens.push({ type: 'OPERATOR', value: ident });
      } else {
        tokens.push({ type: 'IDENT', value: ident });
      }
      continue;
    }

    tokens.push({ type: ch, value: ch });
    i++;
  }

  return tokens;
}

/**
 * Pure JS recursive-descent parser building AST for jq syntax subset.
 * @param tokens -
 * @returns AST node
 */
function parseJq(tokens: JqToken[]): JqNode {
  let pos = 0;

  function peek(): JqToken | null {
    return tokens[pos] || null;
  }

  function next(): JqToken | null {
    return tokens[pos++] || null;
  }

  function match(type: string, value?: string | number | boolean | null) {
    const tok = peek();
    if (!tok) return false;
    if (tok.type !== type) return false;
    if (value !== undefined && tok.value !== value) return false;
    pos++;
    return true;
  }

  function parseExpression(): JqNode {
    return parsePipeline();
  }

  function parsePipeline(): JqNode {
    let left = parseLogicalOr();
    while (match('|')) {
      const right = parseLogicalOr();
      left = { type: 'Pipeline', left, right };
    }
    return left;
  }

  function parseLogicalOr(): JqNode {
    let left = parseLogicalAnd();
    while (peek()?.type === 'OPERATOR' && peek()?.value === 'or') {
      const op = next()!.value as string;
      const right = parseLogicalAnd();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseLogicalAnd(): JqNode {
    let left = parseEquality();
    while (peek()?.type === 'OPERATOR' && peek()?.value === 'and') {
      const op = next()!.value as string;
      const right = parseEquality();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseEquality(): JqNode {
    let left = parseRelational();
    while (peek()?.type === 'OPERATOR' && (peek()?.value === '==' || peek()?.value === '!=')) {
      const op = next()!.value as string;
      const right = parseRelational();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseRelational(): JqNode {
    let left = parseAdditive();
    while (peek()?.type === 'OPERATOR' && (peek()?.value === '<' || peek()?.value === '<=' || peek()?.value === '>' || peek()?.value === '>=')) {
      const op = next()!.value as string;
      const right = parseAdditive();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseAdditive(): JqNode {
    let left = parseMultiplicative();
    while (peek()?.type === 'OPERATOR' && (peek()?.value === '+' || peek()?.value === '-')) {
      const op = next()!.value as string;
      const right = parseMultiplicative();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseMultiplicative(): JqNode {
    let left = parseUnary();
    while (peek()?.type === 'OPERATOR' && (peek()?.value === '*' || peek()?.value === '/')) {
      const op = next()!.value as string;
      const right = parseUnary();
      left = { type: 'BinaryOp', op, left, right };
    }
    return left;
  }

  function parseUnary(): JqNode {
    if (peek()?.type === 'IDENT' && peek()?.value === 'not') {
      next();
      const expr = parseUnary();
      return { type: 'UnaryOp', op: 'not', expr };
    }
    if (peek()?.type === 'OPERATOR' && peek()?.value === '-') {
      next();
      const expr = parseUnary();
      return { type: 'UnaryOp', op: '-', expr };
    }
    return parsePostfix();
  }

  function parsePostfix(): JqNode {
    let node = parsePrimary();

    while (pos < tokens.length) {
      const tok = peek();
      if (!tok) break;

      if (tok.type === '.') {
        next(); // consume '.'
        const after = peek();
        if (!after) {
          break;
        }
        if (after.type === 'IDENT' || after.type === 'STRING') {
          const field = next()!.value as string;
          node = appendPathSegment(node, { type: 'field', name: field });
        } else if (after.type === '[') {
          const seg = parseBracketSegment();
          node = appendPathSegment(node, seg);
        } else {
          break;
        }
      } else if (tok.type === '[') {
        const seg = parseBracketSegment();
        node = appendPathSegment(node, seg);
      } else {
        break;
      }
    }

    return node;
  }

  function parseBracketSegment(): JqPathSegment {
    next(); // consume '['
    if (match(']')) {
      return { type: 'iterator' };
    }

    if (match(':')) {
      let end: number | undefined = undefined;
      if (peek()?.type === 'NUMBER') {
        end = next()!.value as number;
      }
      match(']');
      return { type: 'slice', start: 0, end };
    }

    let firstVal: string | number | undefined = undefined;
    if (peek()?.type === 'NUMBER') {
      firstVal = next()!.value as number;
    } else if (peek()?.type === 'STRING') {
      firstVal = next()!.value as string;
    } else if (peek()?.type === 'IDENT') {
      firstVal = next()!.value as string;
    }

    if (match(':')) {
      let end: number | undefined = undefined;
      if (peek()?.type === 'NUMBER') {
        end = next()!.value as number;
      }
      match(']');
      return { type: 'slice', start: firstVal ?? 0, end };
    }

    match(']');
    if (typeof firstVal === 'number') {
      return { type: 'index', index: firstVal };
    }
    return { type: 'field', name: firstVal ?? 'undefined' };
  }

  function appendPathSegment(node: JqNode, segment: JqPathSegment): JqNode {
    if (node && node.type === 'Path') {
      return { type: 'Path', segments: [...node.segments, segment] };
    }
    if (node && node.type === 'Identity') {
      return { type: 'Path', segments: [segment] };
    }
    return { type: 'Path', base: node, segments: [segment] };
  }

  function parsePrimary(): JqNode {
    const tok = peek();
    if (!tok) return { type: 'Identity' };

    if (tok.type === '.') {
      next();
      const after = peek();
      if (!after || after.type === '|' || after.type === ']' || after.type === ')' || after.type === '}' || after.type === ',' || after.type === ';' || after.type === 'OPERATOR') {
        return { type: 'Identity' };
      }
      if (after.type === 'IDENT' || after.type === 'STRING') {
        const field = next()!.value as string;
        return { type: 'Path', segments: [{ type: 'field', name: field }] };
      }
      if (after.type === '[') {
        const seg = parseBracketSegment();
        return { type: 'Path', segments: [seg] };
      }
      return { type: 'Identity' };
    }

    if (tok.type === 'NUMBER' || tok.type === 'STRING' || tok.type === 'BOOLEAN' || tok.type === 'NULL') {
      next();
      return { type: 'Literal', value: tok.value as JsonValue };
    }

    if (tok.type === '[') {
      next();
      if (match(']')) {
        return { type: 'ArrayConstructor', expr: null };
      }
      const expr = parseExpression();
      match(']');
      return { type: 'ArrayConstructor', expr };
    }

    if (tok.type === '{') {
      next();
      const entries: JqObjectEntry[] = [];
      while (peek() && peek()!.type !== '}') {
        const keyTok = next()!;
        const key = keyTok.value as string;
        if (match(':')) {
          const valExpr = parseExpression();
          entries.push({ key, value: valExpr, shorthand: false });
        } else {
          entries.push({ key, shorthand: true });
        }
        if (!match(',')) {
          break;
        }
      }
      match('}');
      return { type: 'ObjectConstructor', entries };
    }

    if (tok.type === '(') {
      next();
      const expr = parseExpression();
      match(')');
      return expr;
    }

    if (tok.type === 'IDENT') {
      const name = next()!.value as string;
      const builtins = ['keys', 'length', 'type', 'to_entries', 'from_entries', 'has', 'select', 'map', 'del'];
      if (builtins.includes(name)) {
        const args: JqNode[] = [];
        if (match('(')) {
          if (!match(')')) {
            while (true) {
              args.push(parseExpression());
              if (!match(',')) break;
            }
            match(')');
          }
        }
        return { type: 'FunctionCall', name, args };
      }
      return { type: 'Path', segments: [{ type: 'field', name }] };
    }

    next();
    return { type: 'Identity' };
  }

  return parseExpression();
}

function isTruthy(val: JsonValue | undefined): boolean {
  return val !== false && val !== null && val !== undefined;
}

/**
 * Evaluates an AST node against input data.
 * @param node -
 * @param data -
 * @param rootData -
 * @returns
 */
function evalNode(node: JqNode | null | undefined, data: JsonValue, rootData?: JsonValue): JsonValue[] {
  if (!node) return [data];
  if (rootData === undefined) rootData = data;

  switch (node.type) {
    case 'Identity':
      return [data];

    case 'Literal':
      return [node.value];

    case 'Path': {
      let currentItems: JsonValue[] = node.base ? evalNode(node.base, data, rootData) : [data];
      for (const seg of node.segments) {
        const nextItems: JsonValue[] = [];
        for (const item of currentItems) {
          if (item === null || item === undefined) {
            continue;
          }
          if (seg.type === 'field') {
            if (typeof item === 'object' && !Array.isArray(item)) {
              const found = dynamicGet(item, seg.name);
              if (found !== undefined) nextItems.push(found);
              else nextItems.push(null);
            } else if (Array.isArray(item)) {
              const found = dynamicGet(item, seg.name);
              if (found !== undefined) nextItems.push(found);
              else nextItems.push(null);
            }
          } else if (seg.type === 'index') {
            if (Array.isArray(item) || typeof item === 'string') {
              let idx = seg.index;
              if (idx < 0) idx = item.length + idx;
              const found = item[idx];
              if (found !== undefined) nextItems.push(found);
              else nextItems.push(null);
            } else if (typeof item === 'object') {
              const found = dynamicGet(item, seg.index);
              if (found !== undefined) nextItems.push(found);
              else nextItems.push(null);
            }
          } else if (seg.type === 'slice') {
            if (Array.isArray(item) || typeof item === 'string') {
              const start = seg.start !== undefined ? Number(seg.start) : 0;
              const end = seg.end !== undefined ? seg.end : item.length;
              nextItems.push(typeof item === 'string' ? item.slice(start, end) : item.slice(start, end));
            }
          } else if (seg.type === 'iterator') {
            if (Array.isArray(item)) {
              for (const elem of item) nextItems.push(elem);
            } else if (typeof item === 'object' && item !== null) {
              for (const val of Object.values(item)) nextItems.push(val);
            }
          }
        }
        currentItems = nextItems;
      }
      return currentItems;
    }

    case 'Pipeline': {
      const leftResults = evalNode(node.left, data, rootData);
      const pipeResults: JsonValue[] = [];
      for (const item of leftResults) {
        const rightResults = evalNode(node.right, item, rootData);
        pipeResults.push(...rightResults);
      }
      return pipeResults;
    }

    case 'ArrayConstructor': {
      if (!node.expr) return [[]];
      const items = evalNode(node.expr, data, rootData);
      return [items];
    }

    case 'ObjectConstructor': {
      const obj: { [key: string]: JsonValue } = {};
      for (const entry of node.entries) {
        const key = entry.key;
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        let val: JsonValue;
        if (entry.shorthand) {
          const res = evalNode({ type: 'Path', segments: [{ type: 'field', name: entry.key }] }, data, rootData);
          val = res.length > 0 ? res[0] : null;
        } else {
          const res = evalNode(entry.value, data, rootData);
          val = res.length > 0 ? res[0] : null;
        }
        dynamicSet(obj, key, val);
      }
      return [obj];
    }

    case 'BinaryOp': {
      const leftArr = evalNode(node.left, data, rootData);
      const rightArr = evalNode(node.right, data, rootData);
      const leftVal: JsonValue | undefined = leftArr.length > 0 ? leftArr[0] : null;
      const rightVal: JsonValue | undefined = rightArr.length > 0 ? rightArr[0] : null;

      switch (node.op) {
        case '==':
          return [deepEqual(leftVal, rightVal)];
        case '!=':
          return [!deepEqual(leftVal, rightVal)];
        case '<':
          return [leftVal! < rightVal!];
        case '<=':
          return [leftVal! <= rightVal!];
        case '>':
          return [leftVal! > rightVal!];
        case '>=':
          return [leftVal! >= rightVal!];
        case 'and':
          return [Boolean(isTruthy(leftVal) && isTruthy(rightVal))];
        case 'or':
          return [Boolean(isTruthy(leftVal) || isTruthy(rightVal))];
        case '+':
          if (Array.isArray(leftVal) && Array.isArray(rightVal)) {
            return [[...leftVal, ...rightVal]];
          }
          if (typeof leftVal === 'object' && leftVal !== null && typeof rightVal === 'object' && rightVal !== null) {
            const merged: { [key: string]: JsonValue } = {};
            for (const [k, v] of Object.entries(leftVal)) {
              if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
                merged[k] = v;
              }
            }
            for (const [k, v] of Object.entries(rightVal)) {
              if (k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
                merged[k] = v;
              }
            }
            return [merged];
          }
          if (typeof leftVal === 'string' || typeof rightVal === 'string') {
            return [String(leftVal ?? '') + String(rightVal ?? '')];
          }
          return [(leftVal as number) + (rightVal as number)];
        case '-':
          return [((leftVal ?? 0) as number) - ((rightVal ?? 0) as number)];
        case '*':
          return [((leftVal ?? 0) as number) * ((rightVal ?? 0) as number)];
        case '/':
          return [rightVal === 0 ? null : ((leftVal ?? 0) as number) / (rightVal as number)];
        default:
          return [null];
      }
    }

    case 'UnaryOp': {
      const valArr = evalNode(node.expr, data, rootData);
      const val: JsonValue | undefined = valArr.length > 0 ? valArr[0] : null;
      if (node.op === 'not') {
        return [!isTruthy(val)];
      }
      if (node.op === '-') {
        return [-(val as number)];
      }
      return [val as JsonValue];
    }

    case 'FunctionCall': {
      const name = node.name;
      if (name === 'keys') {
        if (Array.isArray(data)) {
          return [data.map((_, i) => i)];
        }
        if (typeof data === 'object' && data !== null) {
          return [Object.keys(data).sort()];
        }
        return [[]];
      }
      if (name === 'length') {
        if (data === null || data === undefined) return [0];
        if (typeof data === 'string' || Array.isArray(data)) return [data.length];
        if (typeof data === 'object') return [Object.keys(data).length];
        if (typeof data === 'number') return [Math.abs(data)];
        return [0];
      }
      if (name === 'type') {
        if (data === null) return ['null'];
        if (Array.isArray(data)) return ['array'];
        return [typeof data];
      }
      if (name === 'to_entries') {
        if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
          return [Object.entries(data).map(([k, v]) => ({ key: k, value: v }))];
        }
        if (Array.isArray(data)) {
          return [data.map((v, i) => ({ key: i, value: v }))];
        }
        return [[]];
      }
      if (name === 'from_entries') {
        if (Array.isArray(data)) {
          const res: { [key: string]: JsonValue } = {};
          for (const entry of data) {
            if (entry && typeof entry === 'object') {
              const k = dynamicGet(entry, 'key') !== undefined ? dynamicGet(entry, 'key') : (dynamicGet(entry, 'Key') !== undefined ? dynamicGet(entry, 'Key') : dynamicGet(entry, 'name'));
              const v = dynamicGet(entry, 'value') !== undefined ? dynamicGet(entry, 'value') : dynamicGet(entry, 'Value');
              if (k !== undefined && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') {
                dynamicSet(res, k as string | number | undefined, v as JsonValue);
              }
            }
          }
          return [res];
        }
        return [{}];
      }
      if (name === 'has') {
        const argArr = node.args && node.args.length > 0 ? evalNode(node.args[0], data, rootData) : [];
        const key = argArr.length > 0 ? argArr[0] : null;
        if (typeof data === 'object' && data !== null) {
          if (Array.isArray(data)) {
            return [typeof key === 'number' && key >= 0 && key < data.length];
          }
          return [Object.prototype.hasOwnProperty.call(data, key as PropertyKey)];
        }
        return [false];
      }
      if (name === 'select') {
        const condNode = node.args && node.args.length > 0 ? node.args[0] : null;
        if (!condNode) return [data];
        const resArr = evalNode(condNode, data, rootData);
        const condVal: JsonValue | undefined = resArr.length > 0 ? resArr[0] : null;
        if (isTruthy(condVal)) {
          return [data];
        }
        return [];
      }
      if (name === 'map') {
        const elemNode = node.args && node.args.length > 0 ? node.args[0] : null;
        if (!Array.isArray(data)) return [null];
        if (!elemNode) return [data];
        const mapped: JsonValue[] = [];
        for (const item of data) {
          const res = evalNode(elemNode, item, rootData);
          if (res.length > 0) {
            mapped.push(res[0]);
          }
        }
        return [mapped];
      }
      if (name === 'del') {
        const pathNode = node.args && node.args.length > 0 ? node.args[0] : null;
        if (!pathNode) return [data];
        const cloned: JsonValue = structuredClone ? structuredClone(data) : JSON.parse(JSON.stringify(data));
        deletePathFromData(cloned, pathNode);
        return [cloned];
      }
      return [null];
    }

    default:
      return [data];
  }
}

function extractPathTokens(pathNode: JqNode | null | undefined): Array<string | number | undefined> {
  if (!pathNode) return [];
  if (pathNode.type === 'Path') {
    return pathNode.segments.map((s): string | number | undefined => {
      if (s.type === 'index') return s.index;
      if (s.type === 'field') return s.name;
      return undefined;
    });
  }
  return [];
}

function deletePathFromData(data: JsonValue, pathNode: JqNode | null | undefined): void {
  const tokens = extractPathTokens(pathNode);
  if (tokens.length === 0) return;
  if (tokens.some(t => t === '__proto__' || t === 'constructor' || t === 'prototype')) return;
  let curr: JsonValue | undefined = data;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (curr === null || curr === undefined || typeof curr !== 'object') return;
    curr = dynamicGet(curr, t);
  }
  if (curr === null || curr === undefined || typeof curr !== 'object') return;
  const last = tokens[tokens.length - 1];
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
  if (Array.isArray(curr) && typeof last === 'number') {
    curr.splice(last, 1);
  } else {
    dynamicDelete(curr, last);
  }
}

/**
 * Pure JS jq-compatible query evaluator.
 * @param data -
 * @param filter -
 * @returns
 */
function evaluateJq(data: JsonValue, filter: string): JsonValue {
  if (filter === null || filter === undefined || filter === '' || filter === '.') {
    return data;
  }
  const trimmed = typeof filter === 'string' ? filter.trim() : String(filter);
  if (trimmed === '' || trimmed === '.') return data;

  try {
    const tokens = tokenizeJq(trimmed);
    const ast = parseJq(tokens);
    const results = evalNode(ast, data, data);
    if (results.length === 0) return null;
    if (results.length === 1) return results[0];
    return results;
  } catch (err) {
    try {
      const jp = trimmed.startsWith('$') ? trimmed : '$.' + trimmed;
      return JSONPath({ path: jp, json: data, wrap: false });
    } catch {
      throw err;
    }
  }
}

/**
 * Pure JS jq-compatible in-place transformer mutating a deep clone of data.
 * @param data -
 * @param filter -
 * @returns Transformed cloned data
 */
function transformJq(data: JsonValue, filter: string): JsonValue {
  if (data === null || data === undefined) return data;
  let current: JsonValue = structuredClone ? structuredClone(data) : JSON.parse(JSON.stringify(data));
  if (!filter || typeof filter !== 'string' || !filter.trim()) return current;

  const trimmed = filter.trim();
  const tokens = tokenizeJq(trimmed);

  const parts: JqToken[][] = [];
  let curTokens: JqToken[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === '(' || t.type === '[' || t.type === '{') depth++;
    else if (t.type === ')' || t.type === ']' || t.type === '}') depth--;
    if (depth === 0 && (t.type === ';' || t.type === '|')) {
      if (curTokens.length > 0) parts.push(curTokens);
      curTokens = [];
    } else {
      curTokens.push(t);
    }
  }
  if (curTokens.length > 0) parts.push(curTokens);

  for (const stmtTokens of parts) {
    if (stmtTokens.length === 0) continue;

    if (stmtTokens[0].type === 'IDENT' && stmtTokens[0].value === 'del') {
      const ast = parseJq(stmtTokens);
      const res = evalNode(ast, current, current);
      if (res.length > 0) current = res[0];
      continue;
    }

    let opIdx = -1;
    let op: string | null = null;
    let parenDepth = 0;
    for (let i = 0; i < stmtTokens.length; i++) {
      const t = stmtTokens[i];
      if (t.type === '(' || t.type === '[' || t.type === '{') parenDepth++;
      else if (t.type === ')' || t.type === ']' || t.type === '}') parenDepth--;
      if (parenDepth === 0 && t.type === 'OPERATOR' && typeof t.value === 'string' && ['=', '+=', '-=', '*=', '/='].includes(t.value)) {
        opIdx = i;
        op = t.value;
        break;
      }
    }

    if (opIdx !== -1) {
      const leftTokens = stmtTokens.slice(0, opIdx);
      const rightTokens = stmtTokens.slice(opIdx + 1);
      const leftAst = parseJq(leftTokens);
      const rightAst = parseJq(rightTokens);
      const rightVal: JsonValue | undefined = evalNode(rightAst, current, current)[0];

      const pathTokens = extractPathTokens(leftAst);
      if (pathTokens.length > 0) {
        if (pathTokens.some(t => t === '__proto__' || t === 'constructor' || t === 'prototype')) {
          continue;
        }
        let curr: JsonValue | undefined = current;
        for (let i = 0; i < pathTokens.length - 1; i++) {
          const t = pathTokens[i];
          const nextT = pathTokens[i + 1];
          const existing = dynamicGet(curr, t);
          if (existing === undefined || existing === null || typeof existing !== 'object') {
            dynamicSet(curr, t, typeof nextT === 'number' ? [] : {});
          }
          curr = dynamicGet(curr, t);
        }
        const last = pathTokens[pathTokens.length - 1];
        if (last === '__proto__' || last === 'constructor' || last === 'prototype') {
          continue;
        }
        const currentValue = dynamicGet(curr, last);

        if (op === '=') {
          dynamicSet(curr, last, rightVal as JsonValue);
        } else if (op === '+=') {
          if (Array.isArray(currentValue)) {
            if (Array.isArray(rightVal)) dynamicSet(curr, last, [...currentValue, ...rightVal]);
            else currentValue.push(rightVal as JsonValue);
          } else if (typeof currentValue === 'number') {
            dynamicSet(curr, last, currentValue + Number(rightVal));
          } else if (typeof currentValue === 'string') {
            dynamicSet(curr, last, currentValue + String(rightVal));
          } else if (typeof currentValue === 'object' && currentValue !== null) {
            dynamicSet(curr, last, { ...currentValue, ...(rightVal as { [key: string]: JsonValue }) });
          } else {
            dynamicSet(curr, last, rightVal as JsonValue);
          }
        } else if (op === '-=') {
          dynamicSet(curr, last, ((currentValue || 0) as number) - Number(rightVal));
        } else if (op === '*=') {
          dynamicSet(curr, last, ((currentValue || 0) as number) * Number(rightVal));
        } else if (op === '/=') {
          dynamicSet(curr, last, Number(rightVal) === 0 ? 0 : ((currentValue || 0) as number) / Number(rightVal));
        }
      }
    } else {
      const ast = parseJq(stmtTokens);
      const res = evalNode(ast, current, current);
      if (res.length > 0) current = res[0];
    }
  }

  return current;
}

/**
 * Canonical realm-global workspace key (Realm wave A ticket 49cfc41): the
 * shared global workspace of realm `realmId`, and the alias target every
 * realm-bound caller resolves `global`/`public` onto. The ungrouped/legacy
 * shared key remains the literal `global`.
 *
 * @param realmId - Non-empty realm identifier.
 * @returns The canonical `realm:<realmId>:global` workspace key.
 * @internal
 */
function realmGlobalWorkspaceKey(realmId: string): string {
  return `realm:${realmId}:global`;
}

/**
 * Resolved Realm scope of a caller (internal to the engine): the realm-global
 * alias target plus whether the caller bypasses Realm scoping.
 * @internal
 */
interface ResolvedRealmScope {
  /** Non-empty realm id for realm-bound callers, else `null`. */
  realmId: string | null;
  /** Whether the caller bypasses Realm scoping (internal principal / realm bypass). */
  realmBypass: boolean;
  /** Operating shared-global workspace key: the realm key or legacy `'global'`. */
  globalKey: string;
}

/**
 * Tests whether a workspace key is reserved: the shared ungrouped workspaces
 * (`global` and its `public` alias) and every realm-global partition key
 * (`realm:<realmId>:global`). Reserved keys are undeletable through ordinary
 * lifecycle eviction, and the vocabulary is the single canonical home for
 * consumers that must treat reserved shapes specially — the lifecycle launch
 * gate consults this predicate so a non-authority launch can never claim a
 * reserved shape before the partition is allocated (e6f10db).
 *
 * A reserved-key deletion attempt returns `false` without evicting anything,
 * exactly like the pre-existing exact-`global` precedent. Controlled Realm
 * deletion is owned by the operator Realm-deletion path (Realm wave A ticket
 * `49cfc41`), never by lifecycle teardown (f44da3e).
 *
 * @param workspaceId - Candidate workspace key.
 * @returns True when the key is reserved (undeletable and unclaimable by a
 *   non-authority launch), false when it is an ordinary private workspace key.
 *
 * @example
 * ```typescript
 * isReservedWorkspaceKey('global'); // true
 * isReservedWorkspaceKey('realm:alpha:global'); // true
 * isReservedWorkspaceKey('Global'); // false — case-sensitive near-miss
 * ```
 */
export function isReservedWorkspaceKey(workspaceId: string): boolean {
  return workspaceId === 'global' ||
    workspaceId === 'public' ||
    REALM_GLOBAL_WORKSPACE_KEY_PATTERN.test(workspaceId);
}

/**
 * Result of {@link remapLegacyWorkspaceKeys}: the remapped snapshot plus the
 * rename report. Every legacy record is preserved — a path already present
 * under the canonical key keeps the canonical copy and is reported as a
 * conflict — so hydration never drops a workspace or a file.
 */
export interface VirtualFsLegacyWorkspaceRemap {
  /** Snapshot with every remappable legacy key renamed to its canonical key. */
  readonly workspaces: VirtualFsSnapshot;
  /** Per-key rename report (`mergedConflictPaths` lists duplicate paths). */
  readonly remapped: ReadonlyArray<{ readonly from: string; readonly to: string; readonly mergedConflictPaths: string[] }>;
}

/**
 * Remaps legacy bare-id private workspace keys onto their canonical identity
 * keys (Wave I, ticket d57cbc1) for a persisted VirtualFS snapshot, without
 * data loss.
 *
 * Store hydration seam: after the runtime restore registers the agents (so the
 * identity port resolves their realm scope), the store passes the persisted
 * `virtualFs` snapshot (or the VFS's exported snapshot) and a resolver that
 * maps a bare workspace key to its agent identity projection — the store must
 * resolve per record scope (`getAgentIdentity(id, { realmId: record.config.realmId })`)
 * because a bare id may exist in several realms. This pure helper never
 * mutates its input.
 *
 * Only a key that (a) is not reserved, (b) is not already canonical, (c)
 * resolves to a projection whose bare `id` equals the key, and (d) resolves to
 * a different, non-reserved private workspace key is renamed. Files merge
 * path-wise onto the canonical key; an existing canonical path wins and is
 * reported, and the legacy workspace is never dropped wholesale.
 *
 * @param snapshot - Persisted `Record<workspaceId, Record<path, FileRecord>>` map.
 * @param resolveProjection - Trusted resolver from a bare workspace key to its identity projection.
 * @returns The remapped snapshot and the rename report.
 *
 * @example
 * ```typescript
 * const port = runtime.createAgentIdentityPort();
 * const { workspaces } = remapLegacyWorkspaceKeys(persisted, (id) => port.getAgentIdentity(id));
 * virtualFs.importSnapshot(workspaces, { principal: operatorPrincipal });
 * ```
 */
export function remapLegacyWorkspaceKeys(
  snapshot: VirtualFsSnapshot,
  resolveProjection: (bareId: string) => { readonly id?: string; readonly key?: string; readonly workspaceId?: string | null; readonly realmId?: string | null; readonly realmBypass?: boolean } | null | undefined
): VirtualFsLegacyWorkspaceRemap {
  const workspaces: VirtualFsSnapshot = {};
  const remapped: Array<{ from: string; to: string; mergedConflictPaths: string[] }> = [];
  if (!snapshot || typeof snapshot !== 'object') return { workspaces, remapped };
  const legacyEntries: Array<{ from: string; to: string; files: Record<string, FileRecord> }> = [];
  // First pass: copy every key that stays literal (including already-canonical
  // and reserved keys) so conflict detection sees canonical bytes that appear
  // later in the input's key order.
  for (const [key, files] of Object.entries(snapshot)) {
    if (!files || typeof files !== 'object') continue;
    const canonical = legacyWorkspaceRemapTarget(key, resolveProjection);
    if (!canonical) {
      workspaces[key] = { ...files };
      continue;
    }
    legacyEntries.push({ from: key, to: canonical, files });
  }
  // Second pass: merge each legacy workspace onto its canonical target.
  for (const entry of legacyEntries) {
    const target = workspaces[entry.to] || (workspaces[entry.to] = {});
    const mergedConflictPaths: string[] = [];
    for (const [filePath, record] of Object.entries(entry.files)) {
      if (target[filePath]) {
        mergedConflictPaths.push(filePath);
        continue;
      }
      target[filePath] = record && typeof record === 'object' && 'workspaceId' in record
        ? { ...(record as FileRecord), workspaceId: entry.to }
        : record;
    }
    remapped.push({ from: entry.from, to: entry.to, mergedConflictPaths });
  }
  return { workspaces, remapped };
}

/**
 * Resolves the canonical remap target of a legacy workspace key, or `null`
 * when the key must stay literal (reserved, already canonical, not naming a
 * bare agent id, or already the projection's private workspace key).
 * @param key - Candidate workspace key.
 * @param resolveProjection - Trusted resolver from a bare workspace key to its identity projection.
 * @returns Canonical target key or `null`.
 * @internal
 */
function legacyWorkspaceRemapTarget(
  key: string,
  resolveProjection: (bareId: string) => { readonly id?: string; readonly key?: string; readonly workspaceId?: string | null; readonly realmId?: string | null; readonly realmBypass?: boolean } | null | undefined
): string | null {
  if (!key || isReservedWorkspaceKey(key)) return null;
  if (canonicalIdentityKeyAgentId(key) !== null) return null;
  let projection: { readonly id?: string; readonly key?: string; readonly workspaceId?: string | null; readonly realmId?: string | null; readonly realmBypass?: boolean } | null | undefined;
  try {
    projection = resolveProjection(key);
  } catch {
    return null;
  }
  if (!projection || typeof projection !== 'object' || projection.id !== key) return null;
  const canonical = resolveAgentPrivateWorkspaceKey(projection);
  if (!canonical || canonical === key || isReservedWorkspaceKey(canonical)) return null;
  return canonical;
}

/**
 * Trusted-context marker bound by the turn execution engine alongside the
 * caller's resolved private workspace.
 *
 * A frozen module-private reference: every consumer that must be recognized
 * as engine agent context passes this exact object as `agentWorkspaceView`.
 * Tool arguments are JSON and can never carry an object reference, and the
 * dispatcher pins `workspaceId` out of per-call contexts, so the token only
 * ever marks construction-bound engine context. It tells the workspace view
 * that the bound `workspaceId` is the caller's own private workspace, which
 * keeps explicitly configured workspace keys reachable (default-key agents
 * are recognized through their plain caller identity even without it).
 *
 * @example
 * ```typescript
 * import { AGENT_WORKSPACE_VIEW_TOKEN } from '../../virtualFs/index.ts';
 * const dispatcher = createSandboxToolDispatcher({
 *   callerAgentId: agent.id,
 *   workspaceId: agent.config?.workspaceId || agent.id,
 *   agentWorkspaceView: AGENT_WORKSPACE_VIEW_TOKEN
 * });
 * ```
 */
export const AGENT_WORKSPACE_VIEW_TOKEN: Readonly<{ readonly kind: 'agent-workspace-view' }> =
  Object.freeze({ kind: 'agent-workspace-view' as const });

/**
 * Resolved trusted agent workspace view of a call (ticket a50f109): whether
 * the call carries a trusted caller identity, the caller's own private
 * workspace key, its realm scope, and whether the caller holds
 * cross-workspace authority.
 * @internal
 */
interface AgentViewContext {
  /** Whether the trusted source bound a caller identity. */
  active: boolean;
  /** Trusted caller identity, or `null` for legacy calls. */
  callerId: string | null;
  /**
   * Canonical caller identity key bound by the trusted context (Wave I,
   * ticket d57cbc1), when present; forwarded to scoped enumeration so a
   * same-literal-id realm pair stays resolvable.
   */
  callerKey: string | null;
  /** The caller's own private workspace key (`identity.workspaceId || callerId`). */
  privateWorkspaceId: string | null;
  /** Resolved realm scope of the caller. */
  scope: ResolvedRealmScope;
  /** Whether the caller holds cross-workspace authority (root/privileged). */
  crossWorkspace: boolean;
  /**
   * Whether the trusted context supplied a canonical caller key (Wave I,
   * ticket d57cbc1) the identity port could not resolve. An unresolvable key
   * claim fails the operation closed (no fallback to the bare-id channel), so
   * a stale engine binding can never select a wrong-realm workspace.
   */
  unresolved: boolean;
}

/**
 * Resolved storage target of a VFS path: the physical workspace key, the
 * mount-stripped storage path, read-compatibility lookup aliases, and the
 * agent-visible label.
 * @internal
 */
interface ResolvedFileTarget {
  /** Effective (physical) workspace key. */
  workspaceId: string;
  /** Canonical storage path inside the workspace (mount prefix stripped). */
  storagePath: string;
  /** Candidate record keys consulted by read/lookup, in priority order. */
  lookupPaths: string[];
  /** Whether the effective workspace is the shared global workspace. */
  shared: boolean;
  /** Whether the call resolved through the trusted agent workspace view. */
  viewActive: boolean;
  /** Whether the target is the caller's own private workspace. */
  viewOwn: boolean;
  /** Agent-visible workspace label (never an internal realm key). */
  viewLabel: string;
  /** Target class; `agents-root` is the mount directory, not a workspace. */
  mountKind: 'private' | 'shared' | 'peer' | 'legacy' | 'agents-root';
  /** Peer agent id for `/agents/<id>` targets. */
  peerId?: string;
}

/**
 * Core Virtual Filesystem subsystem class managing multi-tenant isolated in-memory workspaces.
 * Guarantees POSIX path normalization, deterministic permission checks, surgical replacements,
 * atomic RFC 6902 patching, jq/AST querying, and byte/word-budgeted output truncation.
 *
 * @example
 * ```typescript
 * const vfs = new VirtualFS();
 * vfs.writeFile('/lore/canon.json', { era: 'First Age' }, { workspaceId: 'global' });
 * const res = vfs.readFile('/lore/canon.json', { workspaceId: 'global' });
 * console.log(res.content);
 * ```
 */
export class VirtualFS {
  /**
   * Active default read budget in bytes, initialized from
   * {@link VirtualFSOptions.defaultBudgetBytes} and mutated by {@link setDefaultBudget}.
   *
   * Applied by `readFile` when no explicit `budgetBytes` option is supplied.
   *
   * @defaultValue 20000
   *
   * @example
   * ```typescript
   * const vfs = new VirtualFS({ defaultBudgetBytes: 30000 });
   * console.log(vfs.defaultBudgetBytes); // 30000
   * ```
   */
  declare defaultBudgetBytes: number;

  /**
   * Internal storage: `Map<workspaceId, Map<normalizedPath, FileMetadata>>`
   */
  #workspaces: Map<string, Map<string, FileMetadata>> = new Map();

  /**
   * Injected identity resolver (`AgentIdentityPort` shape) used to resolve an
   * agent subject into its trusted authority descriptor; null means no agent
   * authority is resolvable (default-deny).
   */
  #identityPort: VirtualFsIdentityPort | null;

  /**
   * Opaque engine-internal principal reference injected by the composition
   * root. Only this exact object grants internal authority; per-call
   * `options.principal` values are honored solely by reference equality.
   */
  #internalPrincipal: object | null;

  /**
   * Resolved `/agents/<id>` mount pairs observed on this instance (ticket
   * 9765b96): peer agent id → the private workspace key its identity
   * projection resolves to. The injected identity port exposes no
   * enumeration/reverse lookup, so custom-workspace peers enter the mount
   * table when a mount resolves them; entries are dropped once their
   * workspace is gone or their identity no longer resolves. Every listing and
   * access re-applies the caller's authority and realm-scope checks.
   */
  #observedMountTargets: Map<string, string>;

  /**
   * Initializes a new VirtualFS instance.
   *
   * @param options - Optional construction configuration.
   *
   * @example
   * ```typescript
   * const vfs = new VirtualFS({ defaultBudgetBytes: 20000 });
   * ```
   */
  constructor(options?: VirtualFSOptions);

  constructor(options: VirtualFSOptions = {}) {
    this.#workspaces = new Map();
    this.#observedMountTargets = new Map();
    this.defaultBudgetBytes = typeof options?.defaultBudgetBytes === 'number'
      ? options.defaultBudgetBytes
      : DEFAULT_BUDGET_BYTES;
    this.#identityPort = (options?.identityPort && typeof options.identityPort.getAgentIdentity === 'function')
      ? options.identityPort
      : null;
    this.#internalPrincipal = (options?.internalPrincipal && typeof options.internalPrincipal === 'object')
      ? options.internalPrincipal
      : null;
  }

  /**
   * Resolves the trusted authority of a caller (MOD-21 W4, default-deny).
   *
   * Trust rules:
   * - the exact injected `#internalPrincipal` reference (per-call
   *   `options.principal`);
   * - a projection resolved through the injected identity port for the claimed
   *   caller — the trusted context's canonical `callerKey` channel when
   *   present (Wave I, ticket d57cbc1), else the bare `callerAgentId` — granting
   *   cross-workspace authority when its `authority` descriptor `visibility` is
   *   `'all'`/`'system'` or its `allow` set carries the `'*'` wildcard.
   *
   * Per-call flags, descriptor-shaped claims, and reserved ids never confer
   * authority. A port projection carrying an `authority` descriptor without a
   * grant fails closed; the deprecated `privileged` projection boolean is
   * honored only when no descriptor is present.
   * @param callerAgentId -
   * @param options -
   * @returns
   */
  #isPrivilegedPrincipal(callerAgentId: unknown, options: { principal?: object; callerAgentId?: string | null; callerRole?: string } = {}): boolean {
    if (this.#internalPrincipal && options && options.principal === this.#internalPrincipal) {
      return true;
    }

    const identity = this.#resolveCallerIdentity(
      typeof callerAgentId === 'string' ? callerAgentId : null,
      options
    );
    if (identity) {
      if (identity.authority !== undefined && identity.authority !== null) {
        return authorityGrantsSubstratePrivilege(identity.authority);
      }
      if (identity.privileged === true) return true;
    }

    return false;
  }

  /**
   * Resolves a claimed caller identity through the injected identity port,
   * failing closed (null) when no port is injected, the subject is empty, or
   * the port throws.
   *
   * @param callerAgentId - Claimed caller identity.
   * @param scope - Optional trusted resolution scope (Wave I, ticket d57cbc1):
   *   realm-bound scopes resolve exactly `(scope.realmId, callerAgentId)`,
   *   bypass/omitted scopes keep the legacy unique-match rule.
   * @returns Trusted identity projection or null.
   */
  #resolveIdentity(callerAgentId: unknown, scope?: VirtualFsIdentityScope | null): VirtualFsIdentityProjection | null {
    const subject = typeof callerAgentId === 'string' && callerAgentId.trim() ? callerAgentId.trim() : null;
    if (!subject || !this.#identityPort) return null;
    try {
      const identity = scope
        ? this.#identityPort.getAgentIdentity(subject, scope)
        : this.#identityPort.getAgentIdentity(subject);
      return (identity && typeof identity === 'object') ? identity : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a canonical identity key back to its projection (Wave I, ticket
   * d57cbc1): the injected port's `listAgentIdentities()` is consulted and the
   * unique projection whose `key` equals the candidate is returned; zero or
   * multiple matches fail closed. Ports without enumeration fall back to the
   * local canonical-key parser plus a realm-exact `getAgentIdentity`, rejecting
   * a projection whose own `key` contradicts the candidate.
   *
   * @param key - Candidate canonical identity key (internal vocabulary).
   * @returns The matching projection or null.
   */
  #resolveIdentityByKey(key: string): VirtualFsIdentityProjection | null {
    const candidate = typeof key === 'string' && key.trim() ? key.trim() : null;
    if (!candidate || !this.#identityPort) return null;
    if (typeof this.#identityPort.listAgentIdentities === 'function') {
      let identities: unknown;
      try {
        identities = this.#identityPort.listAgentIdentities();
      } catch {
        return null;
      }
      if (!Array.isArray(identities)) return null;
      let match: VirtualFsIdentityProjection | null = null;
      for (const identity of identities) {
        if (!identity || typeof identity !== 'object') continue;
        if (identity.key !== candidate) continue;
        if (match) return null; // duplicate keys fail closed
        match = identity;
      }
      return match;
    }
    const parsed = parseCanonicalIdentityKey(candidate);
    if (!parsed) return null;
    const identity = this.#resolveIdentity(parsed.agentId, { realmId: parsed.realmId });
    if (!identity) return null;
    const identityKey = typeof identity.key === 'string' && identity.key ? identity.key : null;
    if (identityKey && identityKey !== candidate) return null;
    return identity;
  }

  /**
   * Resolves a token that may be either a canonical identity key or a bare
   * agent id: the exact `key` match wins, then the legacy unique-match bare-id
   * resolution. Used for storage keys whose provenance is unknown (mount target
   * keys, enumerated workspace keys).
   *
   * @param token - Canonical key or bare agent id.
   * @returns The matching projection or null.
   */
  #resolveAnyIdentityByKeyOrId(token: string): VirtualFsIdentityProjection | null {
    const byKey = this.#resolveIdentityByKey(token);
    return byKey || this.#resolveIdentity(token);
  }

  /**
   * Maps a resolved caller scope onto the scope argument handed to the identity
   * port (Wave I, ticket d57cbc1): realm-bound callers resolve exactly their
   * realm (`realmId: null` selects the system scope), while bypass callers keep
   * the unique-match rule.
   *
   * @param scope - Resolved caller Realm scope.
   * @returns Identity-port scope argument, or `undefined` for unique match.
   */
  #identityScopeArg(scope: ResolvedRealmScope | null): VirtualFsIdentityScope | undefined {
    if (!scope || scope.realmBypass) return undefined;
    return { realmId: scope.realmId };
  }

  /**
   * Resolves an agent-supplied bare ref (or canonical key) inside the caller's
   * scope (Wave I, ticket d57cbc1): realm-bound callers resolve realm-exactly
   * (a foreign id is not-found — never another realm's same-literal-id agent),
   * ungrouped callers keep the legacy unique match, and bypass callers span.
   * A canonical key match is exact and then scope-checked by the caller.
   *
   * @param token - Bare agent id or canonical identity key.
   * @param scope - Resolved caller Realm scope.
   * @returns The scoped projection or null.
   */
  #resolveSubjectInScope(token: string, scope: ResolvedRealmScope): VirtualFsIdentityProjection | null {
    const candidate = typeof token === 'string' && token.trim() ? token.trim() : null;
    if (!candidate) return null;
    const byKey = this.#resolveIdentityByKey(candidate);
    if (byKey) return byKey;
    return this.#resolveIdentity(candidate, this.#identityScopeArg(scope));
  }

  /**
   * Reads the canonical caller-key claim from a resolved call context: the
   * trusted-context provenance when attached (the only channel for object-first
   * forms), else an explicit host option. Payload claims never reach here.
   *
   * @param options - Resolved options bag or enumeration options.
   * @returns Trimmed canonical key or null.
   */
  #callerKeyClaim(options: unknown): string | null {
    const provenance = readTrustedAgentContext(options);
    if (provenance && provenance.callerKey) return provenance.callerKey;
    if (!options || typeof options !== 'object') return null;
    const raw = readOwn(options, 'callerKey', 'caller_key');
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  /**
   * Resolves the effective caller projection (Wave I, ticket d57cbc1).
   *
   * The canonical `callerKey` trusted-context channel wins when present: the
   * projection is matched by `key` so a same-literal-id realm pair resolves
   * realm-exactly, and a supplied-but-unresolvable key fails closed (never a
   * fallback to the bare-id channel, which could select a wrong-realm
   * workspace). Otherwise the bare claimed id resolves through the legacy
   * unique-match rule.
   *
   * @param callerAgentId - Claimed bare caller identity, when present.
   * @param options - Resolved options bag carrying the trusted context.
   * @returns The caller projection or null (fail closed).
   */
  #resolveCallerIdentity(callerAgentId: string | null, options: unknown = {}): VirtualFsIdentityProjection | null {
    const keyClaim = this.#callerKeyClaim(options);
    const bare = typeof callerAgentId === 'string' && callerAgentId.trim() ? callerAgentId.trim() : null;
    if (keyClaim) {
      const identity = this.#resolveIdentityByKey(keyClaim);
      if (!identity) return null;
      if (bare && identity.id !== bare) return null; // conflicting claims fail closed
      return identity;
    }
    if (!bare) return null;
    return this.#resolveIdentity(bare);
  }

  /**
   * Resolves the caller's own private workspace key from its projection (an
   * explicit pin verbatim, else the canonical identity key, else the legacy
   * bare id — {@link resolveAgentPrivateWorkspaceKey}).
   *
   * @param callerAgentId - Claimed bare caller identity.
   * @param options - Resolved options bag carrying the trusted context.
   * @returns Private workspace key or null when no identity resolves.
   */
  #callerPrivateWorkspaceKey(callerAgentId: unknown, options: unknown = {}): string | null {
    const identity = this.#resolveCallerIdentity(
      typeof callerAgentId === 'string' ? callerAgentId : null,
      options
    );
    return identity ? resolveAgentPrivateWorkspaceKey(identity) : null;
  }

  /**
   * Resolves the Realm scope of a caller (Realm wave A ticket 49cfc41; Wave I,
   * ticket d57cbc1 for the canonical key channel).
   *
   * The scope rides the same trusted projection as every other authority
   * input: a non-empty `realmId` without `realmBypass` binds the caller to its
   * realm and its shared-global alias target becomes
   * `realm:<realmId>:global`; the exact injected internal-principal reference
   * at `options.principal` and a `realmBypass` projection bypass Realm scoping.
   * Projections without the optional fields stay ungrouped (`global`). A
   * trusted `callerKey` that does not resolve yields no scope (the caller
   * fails closed downstream).
   *
   * @param callerAgentId - Claimed caller identity.
   * @param options - Per-call options (internal-principal reference / trusted key channel).
   * @returns Resolved Realm scope.
   */
  #resolveRealmScope(callerAgentId: unknown, options: unknown = {}): ResolvedRealmScope {
    const opts = (typeof options === 'object' && options !== null) ? options as { principal?: object } : {};
    const isEnginePrincipal = Boolean(this.#internalPrincipal && opts.principal === this.#internalPrincipal);
    const identity = this.#resolveCallerIdentity(typeof callerAgentId === 'string' ? callerAgentId : null, options);
    const realmBypass = isEnginePrincipal || identity?.realmBypass === true;
    const rawRealmId = identity?.realmId;
    const realmId = (!realmBypass && typeof rawRealmId === 'string' && rawRealmId.trim())
      ? rawRealmId.trim()
      : null;
    return {
      realmId,
      realmBypass,
      globalKey: realmId ? realmGlobalWorkspaceKey(realmId) : 'global'
    };
  }

  /**
   * Reports whether an enumeration call supplied a caller context.
   *
   * A context is supplied when the options carry any caller-identity or
   * principal claim — a present non-`undefined` `callerAgentId`, `agentId`,
   * `callerKey`, or `principal` key, including an explicit `null`/empty claim,
   * which is still a claim that must resolve or be denied. A missing options
   * object (or one without those keys) is a context-free substrate call and
   * keeps the legacy unscoped span (Realm wave A ticket 49cfc41, V11 F2; Wave
   * I, ticket d57cbc1 for the canonical key channel).
   *
   * @param options - Enumeration options.
   * @returns True when a caller context was supplied.
   */
  #hasSuppliedEnumerationContext(options: unknown): boolean {
    if (!options || typeof options !== 'object') return false;
    const opts = options as Record<string, unknown>;
    return opts.callerAgentId !== undefined ||
      opts.agentId !== undefined ||
      opts.callerKey !== undefined ||
      opts.caller_key !== undefined ||
      opts.principal !== undefined;
  }

  /**
   * Maps a requested workspace key onto the caller's shared-global alias: the
   * literal `global`, the retired unscoped `public` alias, and the
   * `/global/`/`/public/` prefix forms resolve to the caller's global key
   * (`realm:<realmId>:global` when realm-bound, else `global`). Every other
   * key passes through verbatim, so stored keys are never renamed.
   *
   * @param workspaceId - Requested workspace key or nullish.
   * @param scope - Resolved caller Realm scope.
   * @returns Effective workspace key.
   */
  #resolveWorkspaceAlias(workspaceId: string | null | undefined, scope: ResolvedRealmScope): string {
    if (typeof workspaceId !== 'string' || workspaceId === '') return scope.globalKey;
    if (workspaceId === 'global' ||
        workspaceId === 'public' ||
        workspaceId === '/global/' ||
        workspaceId === '/public/') {
      return scope.globalKey;
    }
    return workspaceId;
  }

  /**
   * Resolves an explicitly requested workspace key onto its effective storage
   * key for the caller (Wave I, ticket d57cbc1): shared aliases resolve to the
   * caller's global key, the caller's own bare id (and `/id`) resolves to its
   * private workspace key, and a same-scope bare agent id resolves to that
   * agent's private workspace key (canonical identity or explicit pin) — so
   * existing callers that target a workspace by agent id keep working while
   * two realms never share one partition. Reserved partitions and
   * already-canonical keys pass through verbatim, ungrouped callers keep the
   * legacy literal keys, and an unresolvable/foreign bare id passes through to
   * the ACL, which denies with the pre-existing semantics (no oracle).
   *
   * @param requested - Requested workspace key (or nullish for the default).
   * @param scope - Resolved caller Realm scope.
   * @param callerAgentId - Claimed caller identity (own-workspace resolution).
   * @param options - Per-call options (trusted key channel included).
   * @returns Effective storage key.
   */
  #resolveRequestedWorkspaceKey(requested: string | null | undefined, scope: ResolvedRealmScope, callerAgentId: unknown, options: unknown = {}): string {
    const base = this.#resolveWorkspaceAlias(requested, scope);
    if (!requested || base !== requested || isReservedWorkspaceKey(base)) return base;
    if (canonicalIdentityKeyAgentId(base) !== null) return base;
    const caller = typeof callerAgentId === 'string' && callerAgentId.trim() ? callerAgentId.trim() : null;
    if (caller && (base === caller || base === `/${caller}`)) {
      const own = this.#callerPrivateWorkspaceKey(caller, options);
      if (own && !isReservedWorkspaceKey(own)) return own;
    }
    if (!scope.realmBypass && !scope.realmId) {
      // Ungrouped callers keep the legacy literal workspace keys: a bare key is
      // never remapped to a canonical identity on their behalf.
      return base;
    }
    const identity = this.#resolveSubjectInScope(base, scope);
    if (!identity) return base;
    const privateKey = resolveAgentPrivateWorkspaceKey(identity);
    if (privateKey && !isReservedWorkspaceKey(privateKey)) return privateKey;
    return base;
  }

  /**
   * Reports whether a workspace key is a shared global workspace: the
   * ungrouped `global`/`public` keys or any realm-global partition key
   * (`realm:<realmId>:global`). The predicate drives the shared-workspace
   * read-only/owner semantics; cross-realm reachability is decided by the ACL,
   * not here.
   *
   * @param workspaceId - Effective workspace key.
   * @returns True for the shared global workspace class.
   */
  #isSharedGlobalWorkspace(workspaceId: string): boolean {
    return workspaceId === 'global' ||
      workspaceId === 'public' ||
      REALM_GLOBAL_WORKSPACE_KEY_PATTERN.test(workspaceId);
  }

  /**
   * Reports whether a resolved identity is inside the caller's scope (Realm
   * wave R tickets d587e1e/2185224): a realm-bypass caller (the system scope
   * and the operator principal) spans every scope; the reserved system scope
   * itself is never inside a non-bypass caller's scope; a realm-bound caller
   * reaches same-realm identities only; and an ungrouped caller reaches
   * ungrouped identities only — the legacy ungrouped scope never coalesces
   * with a realm or with the system scope.
   *
   * @param identity - Resolved identity projection.
   * @param scope - Resolved caller Realm scope.
   * @returns True when the identity shares the caller's scope.
   */
  #isIdentityInCallerScope(identity: VirtualFsIdentityProjection, scope: ResolvedRealmScope): boolean {
    if (scope.realmBypass) return true;
    if (identity.realmBypass === true) return false;
    const targetRealmId = typeof identity.realmId === 'string' ? identity.realmId.trim() : '';
    if (scope.realmId) return targetRealmId !== '' && targetRealmId === scope.realmId;
    return targetRealmId === '';
  }

  /**
   * Reports whether a target workspace key belongs to the caller's own realm
   * scope, by resolving the target key's identity projection (canonical key
   * match first, then a scoped bare-id resolution). Unknown subjects and
   * realm-bypass subjects fail closed (`false`); ungrouped callers reach
   * ungrouped subjects only.
   *
   * @param workspaceId - Effective workspace key.
   * @param scope - Resolved caller Realm scope.
   * @returns True when the target is a same-scope subject.
   */
  #isSameRealmWorkspaceSubject(workspaceId: string, scope: ResolvedRealmScope): boolean {
    return this.#isSameScopeSubject(workspaceId, scope);
  }

  /**
   * Reports whether a subject (agent id or canonical identity key) belongs to
   * the caller's own scope, by resolving it through the identity port (Wave I,
   * ticket d57cbc1): canonical keys match exactly, bare ids resolve
   * realm-exactly for realm-bound callers, so a same-literal-id agent in
   * another realm is never selected. Unknown subjects and realm-bypass
   * subjects fail closed (`false`); ungrouped callers reach ungrouped subjects
   * only. Mount targets resolve scope by the peer agent id, not by the peer's
   * physical workspace key (ticket 9765b96).
   *
   * @param subjectId - Agent id or canonical identity key to test.
   * @param scope - Resolved caller Realm scope.
   * @returns True when the subject shares the caller's scope.
   */
  #isSameScopeSubject(subjectId: string, scope: ResolvedRealmScope): boolean {
    if (scope.realmBypass) return true;
    const identity = this.#resolveSubjectInScope(subjectId, scope);
    if (!identity) return false;
    return this.#isIdentityInCallerScope(identity, scope);
  }

  /**
   * Reports whether a mount target's resolved workspace key is inside the
   * caller's scope (ticket 2185224; Wave I, ticket d57cbc1 for canonical keys):
   * a key that resolves to another agent's identity — by exact canonical key
   * or by a global bare-id match — must share the caller's scope, so a
   * same-scope peer projection cannot alias a cross-scope private workspace.
   * Keys that resolve to no identity are custom workspace keys whose scope was
   * already authorized through the peer identity; realm-bypass callers span.
   *
   * @param workspaceId - Resolved mount target workspace key.
   * @param scope - Resolved caller Realm scope.
   * @returns True when the resolved key is in the caller's scope.
   */
  #isMountTargetKeyInScope(workspaceId: string, scope: ResolvedRealmScope): boolean {
    if (scope.realmBypass) return true;
    const identity = this.#resolveAnyIdentityByKeyOrId(workspaceId);
    return identity === null || this.#isIdentityInCallerScope(identity, scope);
  }

  /**
   * Reports whether a workspace key is inside a caller's reachable scope:
   * realm-bypass/ungrouped callers span everything; realm-bound callers see
   * their realm-global workspace plus their own private workspace (its
   * canonical identity key or explicit pin, plus the legacy bare-id alias for
   * stored legacy data), and — with cross-workspace authority — same-realm
   * member private workspaces. Foreign realms and unresolvable subjects are
   * excluded.
   *
   * @param workspaceId - Workspace key to test.
   * @param scope - Resolved caller Realm scope.
   * @param callerAgentId - Claimed caller identity.
   * @param options - Per-call options (principal reference / authority source).
   * @returns True when the key is in the caller's enumerable scope.
   */
  #isWorkspaceInCallerScope(workspaceId: string, scope: ResolvedRealmScope, callerAgentId: unknown, options: unknown = {}): boolean {
    if (scope.realmBypass || !scope.realmId) return true;
    if (workspaceId === scope.globalKey) return true;
    const caller = typeof callerAgentId === 'string' ? callerAgentId.trim() : '';
    const ownPrivate = this.#callerPrivateWorkspaceKey(callerAgentId, options);
    if (ownPrivate && workspaceId === ownPrivate) return true;
    if (caller && (workspaceId === caller || workspaceId === `/${caller}`)) return true;
    if (!this.#isPrivilegedPrincipal(callerAgentId, options as { principal?: object })) return false;
    return this.#isSameRealmWorkspaceSubject(workspaceId, scope);
  }

  /**
   * Reports whether a bare agent id resolves to more than one active
   * registration through the injected port (Wave I, ticket d57cbc1). Ambiguous
   * bare-id callers cannot be mapped to a realm without a trusted canonical
   * key, so a workspace-view caller that presents only an ambiguous bare id
   * fails closed instead of silently sharing the bare-id partition — the
   * internal context must bind `callerKey`.
   *
   * @param agentId - Bare caller id to test.
   * @returns True when two or more registrations share the literal id.
   */
  #bareIdIsAmbiguous(agentId: string): boolean {
    const port = this.#identityPort;
    if (!port || typeof port.listAgentIdentities !== 'function') return false;
    try {
      const identities = port.listAgentIdentities();
      if (!Array.isArray(identities)) return false;
      let matches = 0;
      for (const identity of identities) {
        if (identity && typeof identity === 'object' && identity.id === agentId) {
          matches += 1;
          if (matches > 1) return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }

  /**
   * Resolves the trusted agent workspace view of a call (ticket a50f109; Wave
   * I, ticket d57cbc1 for realm-qualified private workspaces): whether the
   * trusted source bound a caller identity, the caller's own private workspace
   * key, its realm scope, and whether the caller holds cross-workspace
   * authority.
   *
   * The caller's own private workspace resolves through
   * {@link resolveAgentPrivateWorkspaceKey} (an explicit pin verbatim, else the
   * canonical identity key, else the legacy bare id); the engine-bound
   * workspace is additionally trusted when the frozen
   * {@link AGENT_WORKSPACE_VIEW_TOKEN} marks the context and the binding names
   * an ordinary (non-reserved) workspace key, so explicitly configured
   * workspace keys stay reachable. When the engine still binds the legacy
   * default (the bare id) for a realm-qualified identity, the canonical key
   * replaces it so two realms never share one storage partition. Calls without
   * a trusted caller identity resolve no view and keep the legacy semantics
   * exactly. A supplied canonical `callerKey` that does not resolve marks the
   * view unresolved and every targeting call fails closed.
   *
   * @param options - Resolved call options (trusted provenance attached)
   * @returns Resolved agent view context
   */
  #resolveAgentView(options: ResolvedCallOptions | undefined): AgentViewContext {
    const provenance = readTrustedAgentContext(options);
    const callerId = provenance && provenance.callerAgentId ? provenance.callerAgentId : null;
    const callerKey = provenance && provenance.callerKey ? provenance.callerKey : null;
    const identity = callerId ? this.#resolveCallerIdentity(callerId, options) : null;
    // A bare caller id shared by several realms cannot be mapped to a realm
    // without the trusted canonical key; fail closed instead of silently
    // sharing the bare-id partition (Wave I, ticket d57cbc1).
    const ambiguousBareCaller = !identity && !callerKey && callerId !== null && callerId !== '' && this.#bareIdIsAmbiguous(callerId);
    const unresolved = Boolean(callerKey && !identity) || ambiguousBareCaller;
    const identityWorkspace = identity ? resolveAgentPrivateWorkspaceKey(identity) : null;
    const engineBound = provenance && provenance.viewToken && provenance.workspaceId && !isReservedWorkspaceKey(provenance.workspaceId)
      ? provenance.workspaceId
      : null;
    let candidatePrivateWorkspace = engineBound || identityWorkspace || callerId || null;
    if (identity && identityWorkspace && engineBound === identity.id && identityWorkspace !== identity.id) {
      // Legacy engine binding (the bare default) for a realm-qualified
      // identity: resolve the realm-qualified key.
      candidatePrivateWorkspace = identityWorkspace;
    }
    // A reserved workspace key (`global`, `public`, `realm:<id>:global`) is
    // never a private workspace: a caller whose id happens to match one keeps
    // the legacy shared/alias routing instead of minting a private claim over
    // a reserved partition.
    const privateWorkspaceId = candidatePrivateWorkspace && !isReservedWorkspaceKey(candidatePrivateWorkspace)
      ? candidatePrivateWorkspace
      : null;
    return {
      active: Boolean(callerId),
      callerId,
      callerKey,
      privateWorkspaceId,
      scope: this.#resolveRealmScope(callerId, options),
      crossWorkspace: callerId ? this.#isPrivilegedPrincipal(callerId, options) : false,
      unresolved
    };
  }

  /**
   * Reports whether an explicit workspace binding names the caller's own
   * private workspace (its resolved key, the plain caller id, or the `/id`
   * alias), which activates the workspace view.
   * @param view - Resolved agent view context
   * @param workspaceId - Explicitly requested workspace key
   * @returns True when the binding is the caller's own private workspace
   */
  #bindingIsOwnWorkspace(view: AgentViewContext, workspaceId: string): boolean {
    if (!view.active || !view.privateWorkspaceId) return false;
    return workspaceId === view.privateWorkspaceId ||
      workspaceId === view.callerId ||
      workspaceId === `/${view.callerId}`;
  }

  /**
   * Classifies a normalized path through the agent workspace view: `/global`
   * (and the retired `/public` alias) is the shared mount, `/agents` is the
   * mount directory, `/agents/<id>/...` is an agent mount, and every other
   * path is the caller's private workspace with the mount prefix stripped.
   * @param normPath - Normalized virtual path
   * @returns View classification with the mount-stripped storage path
   */
  #classifyViewPath(normPath: string): { kind: 'private' | 'shared' | 'agents-root' | 'agent-mount'; storagePath: string; peerId?: string } {
    if (normPath === '/global' || normPath === '/public') {
      return { kind: 'shared', storagePath: '/' };
    }
    if (normPath.startsWith('/global/') || normPath.startsWith('/public/')) {
      return { kind: 'shared', storagePath: normPath.slice(7) || '/' };
    }
    if (normPath === '/agents') {
      return { kind: 'agents-root', storagePath: '/' };
    }
    if (normPath.startsWith('/agents/')) {
      const remainder = normPath.slice(8);
      const slash = remainder.indexOf('/');
      const peerId = slash === -1 ? remainder : remainder.slice(0, slash);
      const storagePath = slash === -1 ? '/' : (remainder.slice(slash) || '/');
      if (!peerId) return { kind: 'agents-root', storagePath: '/' };
      return { kind: 'agent-mount', peerId, storagePath };
    }
    return { kind: 'private', storagePath: normPath };
  }

  /**
   * Resolves the workspace key a `/agents/<id>` mount targets (ticket 9765b96;
   * Wave I, ticket d57cbc1 for realm-exact resolution): the subject's projected
   * private workspace key (an explicit pin verbatim, else its canonical
   * identity key, else the plain agent id), resolved inside the caller's scope
   * so a same-literal-id agent in another realm is never selected. Resolved
   * pairs are recorded as observed mount targets so the `/agents` listing can
   * surface custom-workspace peers even though the identity port cannot
   * enumerate.
   * @param peerId - Mounted agent id from the path
   * @param scope - Resolved caller Realm scope
   * @returns Target private workspace key
   */
  #resolveMountTargetWorkspace(peerId: string, scope: ResolvedRealmScope): string {
    const identity = this.#resolveSubjectInScope(peerId, scope);
    if (!identity) return peerId;
    const workspaceId = resolveAgentPrivateWorkspaceKey(identity) || peerId;
    this.#observedMountTargets.set(peerId, workspaceId);
    return workspaceId;
  }

  /**
   * Authorizes an `/agents/<peerId>` mount target (tickets 9765b96, d587e1e,
   * 2185224).
   *
   * The peer's realm scope resolves through its agent identity, never through
   * its physical workspace key, so a custom-workspace peer is a first-class
   * mount target. Requirements are: cross-workspace authority plus same
   * realm/scope for both the peer identity and the resolved workspace key (a
   * same-scope projection must not alias a cross-scope private workspace);
   * the realm-bypass director spans realms, while the system scope is never
   * reachable from a non-bypass caller and the ungrouped scope never
   * coalesces with a realm. Reserved resolved keys are refused, and denials
   * name the mount id only — never the peer's workspace key.
   *
   * @param peerId - Mounted agent id from the path
   * @param workspaceId - Resolved target workspace key
   * @param operation - Operation label for the denial message
   * @param view - Resolved agent view context
   * @throws If the caller lacks authority, the peer or resolved key is out of scope, or the resolved key is reserved.
   */
  #assertMountTargetAccess(peerId: string, workspaceId: string, operation: string, view: AgentViewContext): void {
    const deny = (): never => {
      throw new PermissionDeniedError(
        `Agent '${view.callerId}' is denied ${operation} access to mount '/agents/${peerId}' (cross-realm or out-of-realm target)`,
        { callerAgentId: view.callerId, filePath: `/agents/${peerId}`, code: 'PERMISSION_DENIED' }
      );
    };
    if (!view.crossWorkspace) deny();
    if (isReservedWorkspaceKey(workspaceId)) deny();
    if (!view.scope.realmBypass) {
      if (!this.#isSameScopeSubject(peerId, view.scope)) deny();
      if (!this.#isMountTargetKeyInScope(workspaceId, view.scope)) deny();
    }
  }

  /**
   * Resolves the effective storage target of a path, applying the trusted
   * agent workspace view when active and the legacy routing otherwise:
   *
   * - view: `/global`/`/global/...` is the caller's shared workspace with the
   *   mount prefix stripped; `/agents/<id>/...` is the mounted agent's private
   *   workspace (cross-workspace authority plus same realm/scope, enforced by
   *   the workspace ACL; `/agents/<self>/...` is the caller's own workspace);
   *   every other path is the caller's own private workspace;
   * - legacy (no trusted caller, or an explicit non-own workspace binding):
   *   the historical `global` default and `/global/`/`/public/` prefix routing.
   *
   * The workspace ACL is evaluated here, so callers must not re-check.
   *
   * @param args - Path, requested workspace, caller identity, options, operation
   * @returns Resolved target (workspace, storage path, lookup aliases, label)
   */
  #resolveWorkspaceTarget(args: {
    normPath: string;
    requestedWorkspaceId?: string | null;
    callerAgentId?: string | null;
    options?: ResolvedCallOptions;
    operation: string;
  }): ResolvedFileTarget {
    const { normPath, options, operation } = args;
    const explicitCaller = typeof args.callerAgentId === 'string' && args.callerAgentId ? args.callerAgentId : null;
    const requested = typeof args.requestedWorkspaceId === 'string' && args.requestedWorkspaceId ? args.requestedWorkspaceId : null;
    const view = this.#resolveAgentView(options);
    const scope = view.scope;
    if (view.unresolved) {
      // A trusted canonical caller key that does not resolve fails the call
      // closed: falling back to the bare id (or the default global workspace)
      // could select a wrong-realm partition (Wave I, ticket d57cbc1).
      throw new PermissionDeniedError(
        `Agent '${view.callerId || 'anonymous'}' is denied ${operation} access (unresolvable caller identity)`,
        { callerAgentId: view.callerId, filePath: normPath, code: 'PERMISSION_DENIED' }
      );
    }

    const legacyTarget = (): ResolvedFileTarget => {
      let rawWorkspaceId: string | null = requested;
      let storagePath = normPath;
      if (normPath.startsWith('/global/') || normPath.startsWith('/public/')) {
        rawWorkspaceId = 'global';
        storagePath = normPath.slice(7) || '/';
      }
      const workspaceId = this.#resolveRequestedWorkspaceKey(rawWorkspaceId, scope, explicitCaller, options);
      this.#checkWorkspaceAccess(workspaceId, explicitCaller, normPath, operation, options);
      const shared = this.#isSharedGlobalWorkspace(workspaceId);
      const lookupPaths = storagePath === '/'
        ? []
        : (shared ? [storagePath, '/global' + storagePath, normPath] : [storagePath, normPath]);
      return {
        workspaceId,
        storagePath,
        lookupPaths: Array.from(new Set(lookupPaths)),
        shared,
        viewActive: view.active,
        viewOwn: false,
        viewLabel: publicWorkspaceKey(workspaceId),
        mountKind: 'legacy'
      };
    };

    if (view.active && view.privateWorkspaceId && (!requested || this.#bindingIsOwnWorkspace(view, requested))) {
      const classified = this.#classifyViewPath(normPath);

      if (classified.kind === 'agents-root') {
        if (operation !== 'read') {
          throw new PermissionDeniedError(
            `Mount '${normPath}' is a directory and cannot be modified`,
            { callerAgentId: view.callerId, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
        return {
          workspaceId: view.privateWorkspaceId,
          storagePath: '/',
          lookupPaths: [],
          shared: false,
          viewActive: true,
          viewOwn: true,
          viewLabel: publicWorkspaceKey(view.privateWorkspaceId),
          mountKind: 'agents-root'
        };
      }

      if (classified.kind === 'shared') {
        if (classified.storagePath === '/' && operation !== 'read') {
          throw new PermissionDeniedError(
            `Mount '${normPath}' is a directory and cannot be modified`,
            { callerAgentId: view.callerId, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
        const workspaceId = scope.globalKey;
        this.#checkWorkspaceAccess(workspaceId, view.callerId, normPath, operation, options);
        return {
          workspaceId,
          storagePath: classified.storagePath,
          lookupPaths: classified.storagePath === '/' ? [] : [classified.storagePath, '/global' + classified.storagePath],
          shared: true,
          viewActive: true,
          viewOwn: false,
          viewLabel: 'global',
          mountKind: 'shared'
        };
      }

      if (classified.kind === 'agent-mount' && classified.peerId && !this.#isOwnMountId(view, classified.peerId)) {
        const peerId = classified.peerId;
        if (peerId.includes(':') || isReservedWorkspaceKey(peerId)) {
          throw new PermissionDeniedError(
            `Agent '${view.callerId}' is denied ${operation} access to mount '${normPath}' (invalid mount target)`,
            { callerAgentId: view.callerId, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
        const workspaceId = this.#resolveMountTargetWorkspace(peerId, scope);
        // Cross-workspace authority plus same realm/scope resolves through the
        // peer agent identity (never the physical workspace key), so custom
        // workspace keys are first-class mount targets (ticket 9765b96).
        this.#assertMountTargetAccess(peerId, workspaceId, operation, view);
        return {
          workspaceId,
          storagePath: classified.storagePath,
          lookupPaths: classified.storagePath === '/' ? [] : [classified.storagePath],
          shared: false,
          viewActive: true,
          viewOwn: false,
          viewLabel: publicWorkspaceKey(workspaceId),
          mountKind: 'peer',
          peerId
        };
      }

      // Everything else is the caller's own private workspace.
      return {
        workspaceId: view.privateWorkspaceId,
        storagePath: classified.storagePath,
        lookupPaths: classified.storagePath === '/' ? [] : [classified.storagePath, normPath],
        shared: false,
        viewActive: true,
        viewOwn: true,
        viewLabel: publicWorkspaceKey(view.privateWorkspaceId),
        mountKind: 'private'
      };
    }

    return legacyTarget();
  }

  /**
   * Reports whether a mount id names the caller itself (the self mount, which
   * behaves exactly like `/...`).
   * @param view - Resolved agent view context
   * @param mountId - Mount id from the path
   * @returns True for the caller's own id or private workspace key
   */
  #isOwnMountId(view: AgentViewContext, mountId: string): boolean {
    return mountId === view.callerId ||
      mountId === view.privateWorkspaceId ||
      mountId === `/${view.callerId}`;
  }

  /**
   * Finds a file record through a resolved target's lookup aliases: the
   * mount-stripped storage path first, then the legacy alias shapes (the
   * literal `/global/<path>` record and the unstripped view path).
   * @param ws - Physical workspace map
   * @param target - Resolved file target
   * @returns File metadata or undefined
   */
  #findWorkspaceFile(ws: Map<string, FileMetadata> | undefined, target: ResolvedFileTarget): FileMetadata | undefined {
    if (!ws) return undefined;
    for (const candidate of target.lookupPaths) {
      if (!candidate || candidate === '/') continue;
      const record = ws.get(candidate);
      if (record) return record;
    }
    return undefined;
  }

  /**
   * Resolves a file-sourced plumbing reference under the caller's existing
   * workspace view and returns its raw content.
   *
   * The reference goes through the exact read path (`operation: 'read'`,
   * same workspace-view classification, mount authority, and realm-scope ACL
   * checks as `readFile`), so a plumbing reference can never read more than the
   * caller could already read. A missing source fails `FileNotFoundError`, a
   * forbidden source fails `PermissionDeniedError`, and a source above the
   * per-file plumbing cap ({@link FILE_PLUMBING_MAX_FILE_BYTES}) fails
   * `FileTooLargeError` — all before any destination mutation.
   *
   * @param sourcePath - Caller-supplied source reference
   * @param options - Resolved call options (trusted identity/workspace binding)
   * @param label - Plumbing parameter label used in failure messages
   * @returns Raw source content
   * @throws `INVALID_ARGUMENTS` when the reference is not a non-empty string
   * @throws `PermissionDeniedError` when the caller may not read the source
   * @throws `FileNotFoundError` when the source does not exist
   * @throws `FileTooLargeError` when the source exceeds the per-file cap
   */
  #readPlumbingSource(sourcePath: unknown, options: ResolvedCallOptions, label: string): string {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      throw invalidArgumentsError(`'${label}' must be a non-empty string path`);
    }
    const normPath = normalizeVirtualPath(sourcePath);
    const target = this.#resolveWorkspaceTarget({
      normPath,
      requestedWorkspaceId: options.workspaceId || options.workspace_id,
      callerAgentId: options.callerAgentId,
      options,
      operation: 'read'
    });
    const file = this.#findWorkspaceFile(this.#workspaces.get(target.workspaceId), target);
    if (!file) {
      throw new FileNotFoundError(
        `Source file '${normPath}' not found in workspace '${target.workspaceId}'`,
        { workspaceId: target.workspaceId, filePath: normPath }
      );
    }
    const actualBytes = utf8ByteLength(file.content);
    if (actualBytes > FILE_PLUMBING_MAX_FILE_BYTES) {
      throw new FileTooLargeError(
        `Source file '${normPath}' is ${actualBytes} bytes and exceeds the ${FILE_PLUMBING_MAX_FILE_BYTES}-byte file plumbing cap`,
        { workspaceId: target.workspaceId, filePath: normPath, maxBytes: FILE_PLUMBING_MAX_FILE_BYTES, actualBytes }
      );
    }
    return file.content;
  }

  /**
   * Resolves per-operation `value_file` references to inline `value` payloads
   * before RFC 6902 application.
   *
   * Each reference is read through {@link VirtualFS#readPlumbingSource} (same
   * read scope and caps as every other plumbing reference) and parsed as JSON.
   * Inline `value` and `value_file` are mutually exclusive per operation; any
   * resolution failure aborts the whole patch before a single mutation, so the
   * document is never partially patched.
   *
   * @param operations - Raw patch operation array
   * @param options - Resolved call options (trusted identity/workspace binding)
   * @returns A resolved operation array with `value_file` folded into `value`
   * @throws `INVALID_ARGUMENTS` when an operation mixes `value` and `value_file`
   * @throws `INVALID_ARGUMENTS` when the referenced bytes are not valid JSON
   * @throws `PermissionDeniedError`/`FileNotFoundError`/`FileTooLargeError` per the source read
   */
  #resolvePatchOperationValues(operations: JsonPatchOperation[], options: ResolvedCallOptions): JsonPatchOperation[] {
    return operations.map((operation, index) => {
      if (!operation || typeof operation !== 'object' || Array.isArray(operation)) return operation;
      const rawOp = operation as JsonPatchOperation & { value_file?: unknown; valueFile?: unknown };
      const valueFile = rawOp.value_file !== undefined ? rawOp.value_file : rawOp.valueFile;
      if (valueFile === undefined) return operation;
      if (rawOp.value !== undefined) {
        throw invalidArgumentsError(
          `json_patch operation [${index}] cannot combine 'value' and 'value_file'`
        );
      }
      const sourcePath = typeof valueFile === 'string' ? valueFile : '';
      const rawValue = this.#readPlumbingSource(valueFile, options, `patch[${index}].value_file`);
      let parsedValue: JsonValue;
      try {
        parsedValue = JSON.parse(rawValue) as JsonValue;
      } catch (parseErr) {
        throw invalidJsonSourceError(`patch[${index}].value_file`, sourcePath, parseErr);
      }
      const resolved: JsonPatchOperation = { ...rawOp, value: parsedValue };
      delete (resolved as { value_file?: string }).value_file;
      delete (resolved as { valueFile?: string }).valueFile;
      return resolved;
    });
  }

  /**
   * Lists the agent mount targets visible to a root caller as
   * `{ id, workspaceId }` pairs: the caller's realm-confined workspace
   * enumeration plus observed custom-workspace mount pairs, excluding the
   * shared partitions, the caller's own private workspace, reserved
   * workspace keys, and targets outside the caller's realm scope. The peer
   * agent id is the mount id; the resolved workspace key drives child counts
   * (ticket 9765b96). The system scope is never listed to a non-bypass caller,
   * and a resolved key that aliases another scope's workspace is withheld so
   * the listing never becomes a cross-scope observation surface (tickets
   * d587e1e, 2185224).
   * @param view - Resolved agent view context
   * @param options - Resolved call options
   * @returns Visible mount targets (peer agent id + resolved workspace key)
   */
  #visibleMountTargets(view: AgentViewContext, options: ResolvedCallOptions | undefined): Array<{ id: string; workspaceId: string }> {
    if (!view.callerId) return [];
    const candidates = new Map<string, string>();
    const enumerated = this.listWorkspaces({
      callerAgentId: view.callerId,
      ...(view.callerKey ? { callerKey: view.callerKey } : {}),
      ...(options && options.principal ? { principal: options.principal } : {})
    });
    for (const key of enumerated) {
      if (key === view.privateWorkspaceId || key === view.callerId || isReservedWorkspaceKey(key)) continue;
      const identity = this.#resolveAnyIdentityByKeyOrId(key);
      if (!identity) continue;
      const peerId = typeof identity.id === 'string' && identity.id ? identity.id : key;
      const workspaceId = resolveAgentPrivateWorkspaceKey(identity) || key;
      candidates.set(peerId, workspaceId);
    }
    // Observed custom-workspace peers (ticket 9765b96): the identity port has
    // no enumeration surface, so a peer enters the mount table when a mount
    // resolved it; stale pairs drop when the workspace is gone or the identity
    // no longer resolves.
    for (const [peerId, workspaceId] of this.#observedMountTargets) {
      if (!this.#workspaces.has(workspaceId) || this.#resolveAnyIdentityByKeyOrId(peerId) === null) continue;
      candidates.set(peerId, workspaceId);
    }
    return [...candidates.entries()]
      .filter(([peerId, workspaceId]) =>
        peerId !== view.callerId &&
        workspaceId !== view.privateWorkspaceId &&
        !isReservedWorkspaceKey(workspaceId) &&
        (view.scope.realmBypass ||
          (this.#isSameScopeSubject(peerId, view.scope) && this.#isMountTargetKeyInScope(workspaceId, view.scope)))
      )
      .map(([id, workspaceId]) => ({ id, workspaceId }));
  }

  /**
   * Counts the immediate children (top-level entries) of a workspace.
   * @param workspaceId - Workspace key
   * @returns Immediate child count
   */
  #countImmediateChildren(workspaceId: string): number {
    const ws = this.#workspaces.get(workspaceId);
    if (!ws) return 0;
    let count = 0;
    for (const key of ws.keys()) {
      if (key.startsWith('/') && key.slice(1).indexOf('/') === -1) count++;
    }
    return count;
  }

  /**
   * Authorizes a tenant-administration operation (MOD-21 W8-D, default-deny).
   *
   * Administration members accept the same principal sources as every other
   * privileged operation: the exact reference injected as
   * `VirtualFSOptions.internalPrincipal` at `options.principal`, or an
   * identity-port `AuthorityDescriptor` for `options.callerAgentId` (or its
   * `agentId` alias) granting cross-workspace authority. Anonymous calls,
   * caller-asserted flags, and plain lookalike principal objects are denied
   * before any state mutation or disclosure.
   *
   * @param operation -
   * @param options -
   * @throws If no trusted principal is resolved (`PERMISSION_DENIED`).
   */
  #assertTenantAdminAuthority(operation: string, options: VirtualFsAdminOptions = {}): void {
    const opts = (options && typeof options === 'object') ? options : {};
    const callerAgentId = typeof opts.callerAgentId === 'string'
      ? opts.callerAgentId
      : (typeof opts.agentId === 'string' ? opts.agentId : undefined);
    if (this.#isPrivilegedPrincipal(callerAgentId, opts)) return;

    throw new PermissionDeniedError(
      `Anonymous/unauthenticated caller is denied '${operation}' on VirtualFS tenant administration`,
      { callerAgentId, code: 'PERMISSION_DENIED' }
    );
  }

  // Configuration
  /**
   * Configures the instance default read budget in bytes.
   *
   * @param bytes - Byte budget limit (\> 0).
   *
   * @example
   * ```typescript
   * virtualFs.setDefaultBudget(50000);
   * ```
   */
  setDefaultBudget(bytes: number): void;

  setDefaultBudget(bytes: number): void {
    if (typeof bytes === 'number' && bytes > 0) {
      this.defaultBudgetBytes = bytes;
    }
  }

  /**
   * Binds the engine-internal principal to this instance (composition-root
   * wiring for injected substrates; MOD-21 W8-D).
   *
   * First bind wins: an instance constructed with `internalPrincipal` (or
   * already bound) is never rebound, so no later caller can replace or forge
   * the engine principal. Only the exact bound reference authorizes
   * {@link deleteWorkspace}, {@link reset}, {@link exportSnapshot},
   * {@link importSnapshot}, and {@link forAgent} through `options.principal`.
   *
   * @param principal - The exact `InternalPrincipal` reference minted by the composition root.
   * @returns True when this call performed the one-time binding.
   *
   * @example
   * ```typescript
   * const injected = new VirtualFS();
   * injected.bindInternalPrincipal(internalPrincipal);
   * ```
   */
  bindInternalPrincipal(principal: object): boolean;

  bindInternalPrincipal(principal: object): boolean {
    if (this.#internalPrincipal) return false;
    if (!principal || typeof principal !== 'object') return false;
    this.#internalPrincipal = principal;
    return true;
  }

  /**
   * Resets all workspaces and clears all virtual files from memory.
   *
   * Tenant administration (MOD-21 W8-D): requires a trusted principal and
   * denies anonymous callers before any state is cleared.
   *
   * @param options - Principal options (`principal` reference or identity-port caller subject).
   * @throws If no trusted principal is resolved (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * virtualFs.reset({ principal: internalPrincipal });
   * ```
   */
  reset(options?: VirtualFsAdminOptions): void;

  reset(options: VirtualFsAdminOptions = {}): void {
    this.#assertTenantAdminAuthority('reset', options);
    const callerAgentId = typeof options.callerAgentId === 'string'
      ? options.callerAgentId
      : (typeof options.agentId === 'string' ? options.agentId : undefined);
    if (this.#resolveRealmScope(callerAgentId, options).realmId) {
      // `reset` clears every workspace, which is inherently an operator-level
      // all-realm operation; a realm-bound caller (even with cross-workspace
      // authority) can never span realms (Realm wave A ticket 49cfc41).
      throw new PermissionDeniedError(
        'Realm-bound callers are denied reset: clearing every workspace is an operator-level operation',
        { callerAgentId, code: 'PERMISSION_DENIED' }
      );
    }
    this.#workspaces.clear();
  }

  // Workspace Management
  /**
   * Lists all active workspace identifiers.
   *
   * Realm scoping (Realm wave A ticket 49cfc41): when a caller context is
   * supplied, a realm-bound caller sees only its reachable scope — its
   * realm-global workspace, its own private workspace, and (with
   * cross-workspace authority) same-realm member private workspaces. Foreign
   * realms are never enumerated; the injected internal principal /
   * `realmBypass` projections and context-free substrate calls span every
   * workspace (legacy behavior). A supplied caller context that does not
   * resolve through the injected identity port — including an explicit
   * `null`/empty claim or a lookalike principal — fails closed with an empty
   * list instead of falling back to the unscoped legacy span (V11 F2).
   *
   * @param options - Optional caller context for realm-confined enumeration.
   * @returns Array of workspace ID strings.
   *
   * @example
   * ```typescript
   * const workspaces = virtualFs.listWorkspaces();
   * console.log('Active workspaces:', workspaces);
   * ```
   */
  listWorkspaces(options?: VirtualFsEnumerationOptions): string[];

  listWorkspaces(options: VirtualFsEnumerationOptions = {}) {
    const opts = (options && typeof options === 'object') ? options : {};
    const callerAgentId = typeof opts.callerAgentId === 'string'
      ? opts.callerAgentId
      : (typeof opts.agentId === 'string' ? opts.agentId : undefined);
    const scope = this.#resolveRealmScope(callerAgentId, opts);
    const workspaces = Array.from(this.#workspaces.keys());
    if (scope.realmBypass) return workspaces;
    if (!scope.realmId) {
      if (!this.#hasSuppliedEnumerationContext(opts)) return workspaces;
      // A supplied caller context must resolve: an identity the port cannot
      // resolve (unknown subject, port throw, explicit null, unresolvable
      // canonical key) or a lookalike principal fails closed instead of
      // falling back to the unscoped legacy span; a resolvable ungrouped
      // identity keeps that legacy span (Realm wave A ticket 49cfc41, V11 F2;
      // Wave I, ticket d57cbc1 for the canonical key channel).
      return this.#resolveCallerIdentity(callerAgentId ?? null, opts) ? workspaces : [];
    }
    return workspaces.filter(workspaceId => this.#isWorkspaceInCallerScope(workspaceId, scope, callerAgentId, opts));
  }

  /**
   * Checks whether a specific workspace exists in memory.
   *
   * Realm scoping (Realm wave A ticket 49cfc41): when a caller context is
   * supplied, a realm-bound caller gets `false` for every workspace outside its
   * realm scope, so the predicate never becomes a cross-realm existence
   * oracle. Context-free calls keep the legacy literal existence check, while
   * a supplied-but-unresolvable caller context returns `false` (V11 F2).
   *
   * @param workspaceId - Workspace identifier.
   * @param options - Optional caller context for realm-confined enumeration.
   * @returns True if workspace exists, false otherwise.
   *
   * @example
   * ```typescript
   * const exists = virtualFs.hasWorkspace('agent_alpha');
   * ```
   */
  hasWorkspace(workspaceId: string, options?: VirtualFsEnumerationOptions): boolean;

  hasWorkspace(workspaceId: string, options: VirtualFsEnumerationOptions = {}): boolean {
    if (!workspaceId || typeof workspaceId !== 'string') return false;
    const opts = (options && typeof options === 'object') ? options : {};
    const callerAgentId = typeof opts.callerAgentId === 'string'
      ? opts.callerAgentId
      : (typeof opts.agentId === 'string' ? opts.agentId : undefined);
    const scope = this.#resolveRealmScope(callerAgentId, opts);
    const contextSupplied = this.#hasSuppliedEnumerationContext(opts);
    let target = workspaceId;
    if (contextSupplied && !this.#workspaces.has(target)) {
      // A bare agent-id reference resolves to the same-scope agent's private
      // workspace key (canonical identity or explicit pin); foreign or
      // unresolvable ids stay literal and the checks below deny.
      target = this.#resolveRequestedWorkspaceKey(workspaceId, scope, callerAgentId, opts);
    }
    if (!this.#workspaces.has(target)) return false;
    if (scope.realmBypass) return true;
    if (!scope.realmId) {
      if (!contextSupplied) return true;
      // Supplied-but-unresolvable contexts fail closed instead of becoming a
      // cross-workspace existence oracle (Realm wave A ticket 49cfc41,
      // V11 F2; Wave I, ticket d57cbc1 for the canonical key channel);
      // resolvable ungrouped identities keep the legacy literal check.
      return this.#resolveCallerIdentity(callerAgentId ?? null, opts) !== null;
    }
    return this.#isWorkspaceInCallerScope(target, scope, callerAgentId, opts);
  }

  /**
   * Initializes / ensures a workspace exists in memory.
   *
   * @param workspaceId - Workspace identifier.
   * @throws `Error` - If workspaceId is empty or not a string.
   *
   * @example
   * ```typescript
   * virtualFs.initWorkspace('agent_beta');
   * ```
   */
  initWorkspace(workspaceId: string): void;

  initWorkspace(workspaceId: string): void {
    if (!workspaceId || typeof workspaceId !== 'string') {
      throw new Error('Valid workspaceId is required for initWorkspace');
    }
    this.#getOrCreateWorkspace(workspaceId);
  }

  /**
   * Deletes a specific private workspace.
   * Reserved workspaces are protected: the shared `global`/`public`
   * workspaces and every realm-global partition key (`realm:<realmId>:global`)
   * return `false` without eviction, matching the exact-`global` precedent.
   * Per-Realm deletion is an operator Realm operation (Realm wave A ticket
   * 49cfc41), never a lifecycle-eviction side effect.
   *
   * Tenant administration (MOD-21 W8-D): requires a trusted principal and
   * denies anonymous callers before any eviction.
   *
   * @param workspaceId - Workspace identifier.
   * @param options - Principal options (`principal` reference or identity-port caller subject).
   * @returns True if workspace was deleted, false if not found or protected.
   * @throws If no trusted principal is resolved (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const deleted = virtualFs.deleteWorkspace('temp_ws', { principal: internalPrincipal });
   * ```
   */
  deleteWorkspace(workspaceId: string, options?: VirtualFsAdminOptions): boolean;

  deleteWorkspace(workspaceId: string, options: VirtualFsAdminOptions = {}): boolean {
    this.#assertTenantAdminAuthority('deleteWorkspace', options);
    if (!workspaceId || typeof workspaceId !== 'string') {
      return false;
    }
    if (isReservedWorkspaceKey(workspaceId)) {
      // Protected shared global/public workspaces and realm-global partitions.
      return false;
    }
    const callerAgentId = typeof options.callerAgentId === 'string'
      ? options.callerAgentId
      : (typeof options.agentId === 'string' ? options.agentId : undefined);
    const scope = this.#resolveRealmScope(callerAgentId, options);
    // A bare agent-id target resolves to the same-scope agent's current
    // private workspace key (canonical identity or explicit pin) so lifecycle
    // eviction and operator cleanup keep working after the realm-qualified
    // flip; a literal workspace that exists is always preferred (legacy
    // bytes), and foreign/unresolvable references stay literal and are denied
    // or missed exactly as before (Wave I, ticket d57cbc1).
    let target = workspaceId;
    if (!this.#workspaces.has(target)) {
      target = this.#resolveRequestedWorkspaceKey(workspaceId, scope, callerAgentId, options);
    }
    if (scope.realmId && !this.#isWorkspaceInCallerScope(target, scope, callerAgentId, options)) {
      // A realm-bound caller may only evict workspaces inside its realm scope:
      // its own workspace and — with cross-workspace authority — same-realm
      // member workspaces (Realm wave A ticket 49cfc41).
      throw new PermissionDeniedError(
        `Agent '${callerAgentId || 'anonymous'}' is denied deleteWorkspace '${workspaceId}' (cross-realm or out-of-realm target)`,
        { workspaceId, callerAgentId, code: 'PERMISSION_DENIED' }
      );
    }
    return this.#workspaces.delete(target);
  }

  /**
   * Helper to ensure workspace map exists.
   * @param workspaceId -
   * @returns
   */
  #getOrCreateWorkspace(workspaceId: string): Map<string, FileMetadata> {
    let ws = this.#workspaces.get(workspaceId);
    if (!ws) {
      ws = new Map();
      this.#workspaces.set(workspaceId, ws);
    }
    return ws;
  }

  /**
   * Validates access permissions for a workspace operation.
   *
   * Two ACL regimes (Realm wave A ticket 49cfc41):
   * - Realm-bound callers (resolved identity carries a non-empty `realmId`
   *   without `realmBypass`): only the caller's realm-global workspace
   *   (`realm:<realmId>:global`), its own private workspace, and — for callers
   *   with cross-workspace authority only — same-realm member private
   *   workspaces are reachable. Every cross-realm or unresolvable target is
   *   denied.
   * - Ungrouped callers: the legacy ACL; the ACL class is resolved from the
   *   effective workspace only, so a path prefix (`/global/`, `/public/`)
   *   never downgrades a foreign private-workspace request to public
   *   (cb9909f), and the retired `public` alias folds into the shared global
   *   handling before the check. Since Realm wave R (ticket d587e1e) the
   *   privileged exemption covers same-scope targets only: a resolved
   *   ungrouped caller never selects a realm-scoped workspace (identity or
   *   `realm:<id>:global` partition) or the system scope. Anonymous and
   *   operator-principal calls (no resolved agent identity, or the exact
   *   injected principal) keep the legacy host/API semantics.
   *
   * @param workspaceId - Effective (already resolved) workspace identifier.
   * @param callerAgentId - Caller identity or a caller-record object.
   * @param filePath - Normalized target path (diagnostics only; never an ACL input).
   * @param operation - Operation label for the denial message.
   * @param options - Per-call options (identity descriptor / principal reference).
   */
  #checkWorkspaceAccess(workspaceId: string, callerAgentId: unknown, filePath: string, operation: string = 'read', options: unknown = {}): void {
    const opts = typeof options === 'object' && options !== null ? options : (typeof callerAgentId === 'object' && callerAgentId !== null ? callerAgentId : {});
    const callerRecord = typeof callerAgentId === 'object' && callerAgentId !== null ? callerAgentId as Record<string, unknown> : null;
    const optsRecord = opts as Record<string, unknown>;
    const actualCallerId: unknown = typeof callerAgentId === 'string' ? callerAgentId : (callerRecord?.callerAgentId || optsRecord.callerAgentId);
    const scope = this.#resolveRealmScope(actualCallerId, opts);
    const isAdmin = this.#isPrivilegedPrincipal(actualCallerId, opts);

    // A trusted canonical caller key that does not resolve fails the call
    // closed before any ACL class is derived (Wave I, ticket d57cbc1).
    if (this.#callerKeyClaim(opts) && !this.#resolveCallerIdentity(typeof actualCallerId === 'string' ? actualCallerId : null, opts)) {
      throw new PermissionDeniedError(
        `Agent '${typeof actualCallerId === 'string' ? actualCallerId : 'anonymous'}' is denied ${operation} access (unresolvable caller identity)`,
        { workspaceId, callerAgentId: actualCallerId as string | undefined, filePath, code: 'PERMISSION_DENIED' }
      );
    }

    // ACL class and storage both derive from the alias-resolved effective
    // workspace: `global`/`public` and the `/global/`/`/public/` prefixes map
    // onto the caller's realm-global key for realm-bound callers.
    const effectiveWorkspaceId = this.#resolveWorkspaceAlias(workspaceId, scope);

    if (scope.realmId) {
      // Realm boundary (default-deny): the realm-global workspace (members may
      // write it), the caller's own private workspace (its canonical identity
      // key, explicit pin, or legacy bare-id alias), and same-realm member
      // private workspaces for same-realm cross-workspace authority only.
      if (effectiveWorkspaceId === scope.globalKey) return;
      const ownPrivate = this.#callerPrivateWorkspaceKey(actualCallerId, opts);
      if (ownPrivate && effectiveWorkspaceId === ownPrivate) return;
      if (actualCallerId && (effectiveWorkspaceId === actualCallerId || effectiveWorkspaceId === `/${actualCallerId}`)) return;
      if (isAdmin && this.#isSameRealmWorkspaceSubject(effectiveWorkspaceId, scope)) return;

      throw new PermissionDeniedError(
        `Agent '${actualCallerId || 'anonymous'}' is denied ${operation} access to workspace '${workspaceId}' for path '${filePath || '/'}' (cross-realm or out-of-realm target)`,
        { workspaceId, callerAgentId: actualCallerId as string | undefined, filePath, code: 'PERMISSION_DENIED' }
      );
    }

    // Legacy ungrouped ACL: shared global workspaces plus the caller's own
    // private workspace, or cross-workspace authority. The privileged
    // exemption is scope-local (Realm wave R ticket d587e1e, V20 O-1): a
    // resolved ungrouped caller — privileged included — reaches same-scope
    // targets only, never a realm-scoped workspace or the system scope.
    if (effectiveWorkspaceId !== 'global') {
      if (!scope.realmBypass && actualCallerId && this.#resolveCallerIdentity(typeof actualCallerId === 'string' ? actualCallerId : null, opts) !== null) {
        const targetIdentity = this.#resolveAnyIdentityByKeyOrId(effectiveWorkspaceId);
        const targetIsRealmScoped = REALM_GLOBAL_WORKSPACE_KEY_PATTERN.test(effectiveWorkspaceId);
        if (targetIsRealmScoped || (targetIdentity && !this.#isIdentityInCallerScope(targetIdentity, scope))) {
          throw new PermissionDeniedError(
            `Agent '${actualCallerId}' is denied ${operation} access to workspace '${workspaceId}' for path '${filePath || '/'}' (cross-realm or out-of-scope target)`,
            { workspaceId, callerAgentId: actualCallerId as string | undefined, filePath, code: 'PERMISSION_DENIED' }
          );
        }
      }
      // Private workspace: caller must be authenticated and match owner or hold a privileged principal
      if (!actualCallerId && !isAdmin) {
        throw new PermissionDeniedError(
          `Anonymous/unauthenticated caller is denied ${operation} access to private workspace '${workspaceId}' for path '${filePath || '/'}'`,
          { workspaceId, callerAgentId: actualCallerId as string | undefined, filePath, code: 'PERMISSION_DENIED' }
        );
      }
      const ownPrivate = this.#callerPrivateWorkspaceKey(actualCallerId, opts);
      if (actualCallerId !== effectiveWorkspaceId
        && effectiveWorkspaceId !== `/${actualCallerId}`
        && !(ownPrivate && effectiveWorkspaceId === ownPrivate)
        && !isAdmin) {
        throw new PermissionDeniedError(
          `Agent '${actualCallerId}' is denied ${operation} access to private workspace '${workspaceId}' for path '${filePath || '/'}'`,
          { workspaceId, callerAgentId: actualCallerId as string | undefined, filePath, code: 'PERMISSION_DENIED' }
        );
      }
    }
  }

  /**
   * Retrieves raw file record (content + metadata) without pagination or budget truncation.
   * Returns `null` if not found (does NOT throw `FileNotFoundError`).
   *
   * @param filePath - Virtual path.
   * @param options - Security context options.
   * @returns FileRecord or null if not found.
   * @throws If workspace read access is denied (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const record = virtualFs.getFileRecord('/lore/map.json', { workspaceId: 'global' });
   * if (record) {
   *   console.log(record.size, record.updatedAt);
   * }
   * ```
   */
  getFileRecord(params: GetFileRecordParams, context?: VirtualFsCallContext): FileRecord | null;

  /**
   * Positional record lookup: `getFileRecord(filePath, options?)`.
   */
  getFileRecord(filePath: string, options?: VirtualFsAccessOptions): FileRecord | null;

  getFileRecord(filePathOrParams: string | GetFileRecordParams, context?: unknown): FileRecord | null {
    filePathOrParams = normalizeCanonicalParams(filePathOrParams);
    let filePath;
    let opts;
    if (typeof filePathOrParams === 'object' && filePathOrParams !== null) {
      opts = resolveObjectCallOptions(filePathOrParams, context, readOwn(filePathOrParams, ...PAYLOAD_IDENTITY_KEYS));
      filePath = opts.filePath || opts.file_path || opts.path;
    } else {
      filePath = filePathOrParams;
      const trusted = typeof context === 'object' && context !== null ? context : {};
      opts = resolvePositionalCallOptions(trusted);
    }

    if (!filePath || typeof filePath !== 'string') return null;

    const normPath = normalizeVirtualPath(filePath);
    const target = this.#resolveWorkspaceTarget({
      normPath,
      requestedWorkspaceId: opts?.workspaceId || opts?.workspace_id,
      callerAgentId: opts?.callerAgentId,
      options: opts,
      operation: 'read'
    });

    const file = this.#findWorkspaceFile(this.#workspaces.get(target.workspaceId), target);
    if (!file) return null;

    return {
      path: normPath,
      workspaceId: target.viewActive ? target.viewLabel : target.workspaceId,
      content: file.content,
      size: file.size,
      updatedAt: file.updatedAt,
      readOnly: Boolean(file.readOnly),
      owner: file.owner
    };
  }

  /**
   * Returns all files under a directory prefix including full content.
   * Encapsulates internal workspace maps to avoid direct Map property traversal.
   *
   * @param dirPath - Directory path prefix (defaults to '/').
   * @param options - Listing options.
   * @returns Array of complete FileRecord items.
   * @throws If workspace read is unauthorized (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const records = virtualFs.listFilesWithContent('/lore', { workspaceId: 'global' });
   * records.forEach(r => console.log(r.path, r.content.length));
   * ```
   */
  listFilesWithContent(params: ListFilesWithContentParams, context?: VirtualFsCallContext): FileRecord[];

  /**
   * Positional listing form: `listFilesWithContent(dirPath?, options?)`.
   */
  listFilesWithContent(dirPath?: string, options?: ListFilesOptions): FileRecord[];

  listFilesWithContent(dirPath: string | ListFilesWithContentParams = '/', context?: unknown): FileRecord[] {
    dirPath = normalizeCanonicalParams(dirPath);
    let targetDir;
    let opts;
    if (typeof dirPath === 'object' && dirPath !== null) {
      opts = resolveObjectCallOptions(dirPath, context, readOwn(dirPath, ...PAYLOAD_IDENTITY_KEYS));
      targetDir = opts.dirPath || opts.dir_path || opts.directory_path || opts.path || '/';
    } else {
      targetDir = dirPath;
      const trusted = typeof context === 'object' && context !== null ? context : {};
      opts = resolvePositionalCallOptions(trusted);
    }
    const normDir = normalizeVirtualPath(targetDir || '/');
    const target = this.#resolveWorkspaceTarget({
      normPath: normDir,
      requestedWorkspaceId: opts?.workspaceId || opts?.workspace_id,
      callerAgentId: opts?.callerAgentId,
      options: opts,
      operation: 'read'
    });
    if (target.mountKind === 'agents-root') {
      // The mount directory is a synthetic view surface; content dumps list
      // no records for it (and an ordinary caller may not even see it).
      if (!this.#resolveAgentView(opts).crossWorkspace) {
        throw new PermissionDeniedError(
          `Agent '${opts?.callerAgentId}' is denied read access to mount '${normDir}' (cross-workspace authority required)`,
          { callerAgentId: opts?.callerAgentId as string | undefined, filePath: normDir, code: 'PERMISSION_DENIED' }
        );
      }
      return [];
    }

    const ws = this.#workspaces.get(target.workspaceId);
    if (!ws) return [];

    const results: FileRecord[] = [];
    const baseDir = target.storagePath;
    const prefix = baseDir === '/' ? '/' : baseDir + '/';

    for (const [path, metadata] of ws.entries()) {
      if (baseDir === '/' || path === baseDir || path.startsWith(prefix)) {
        results.push({
          path: metadata.path || path,
          workspaceId: target.viewActive ? target.viewLabel : (metadata.workspaceId || target.workspaceId),
          content: metadata.content,
          size: metadata.size,
          updatedAt: metadata.updatedAt,
          readOnly: Boolean(metadata.readOnly),
          owner: metadata.owner
        });
      }
    }

    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  /**
   * Creates or overwrites a file with string or JSON content.
   *
   * Invariants:
   * 1. Validates access permissions for workspace write.
   * 2. If file exists and `readOnly: true`, throws `PermissionDeniedError` unless caller is the owner or a privileged principal.
   * 3. Serializes objects to formatted JSON automatically.
   * 4. Updates or creates file metadata with byte size, line count, owner, and timestamp.
   *
   * @param filePath - Absolute virtual path.
   * @param content - String or JSON-serializable object.
   * @param options - Write options and security context.
   * @returns Write receipt confirming path, size, lines written, and metadata.
   * @throws If workspace write is unauthorized or file is read-only (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const receipt = virtualFs.writeFile('/lore/characters.json', { hero: 'Aria' }, {
   *   workspaceId: 'global',
   *   callerAgentId: 'author-agent',
   *   readOnly: false
   * });
   * console.log(receipt.success, receipt.size, receipt.linesWritten);
   * ```
   */
  writeFile(params: WriteFileParams, context?: VirtualFsCallContext): WriteReceipt;

  /**
   * Positional write form: `writeFile(filePath, content, options?)`.
   */
  writeFile(filePath: string, content: string | object, options?: WriteFileOptions): WriteReceipt;

  writeFile(arg1: string | WriteFileParams, arg2?: unknown, arg3?: unknown): WriteFileDelivery {
    arg1 = normalizeCanonicalParams(arg1);
    let filePath, content, payloadWorkspaceId, callerAgentId, options: ResolvedCallOptions;
    let inlineContentProvided;

    if (typeof arg1 === 'object' && arg1 !== null) {
      filePath = arg1.filePath || arg1.file_path || arg1.path;
      inlineContentProvided = arg1.content !== undefined || arg1.data !== undefined;
      content = arg1.content !== undefined ? arg1.content : (arg1.data !== undefined ? arg1.data : '');
      payloadWorkspaceId = arg1.workspaceId || arg1.workspace_id || (typeof arg2 === 'string' ? arg2 : undefined);
      callerAgentId = arg1.callerAgentId || arg1.caller_agent_id || arg1.agentId;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      filePath = arg1;
      inlineContentProvided = arg2 !== undefined;
      content = arg2;
      const trusted = typeof arg3 === 'object' && arg3 !== null ? arg3 : {};
      options = resolvePositionalCallOptions(trusted);
      payloadWorkspaceId = options.workspaceId || options.workspace_id;
    }

    if (!filePath || typeof filePath !== 'string') {
      throw new Error('filePath is required for writeFile');
    }

    const normPath = normalizeVirtualPath(filePath);
    const effectiveCallerId = options.callerAgentId;
    // The trusted context workspace binding wins over a payload claim; the
    // default is the caller's private workspace in the workspace view and the
    // shared global workspace only for legacy calls (ticket a50f109).
    const target = this.#resolveWorkspaceTarget({
      normPath,
      requestedWorkspaceId: options.workspaceId || options.workspace_id || payloadWorkspaceId,
      callerAgentId: effectiveCallerId,
      options,
      operation: 'write'
    });
    const effectiveWorkspaceId = target.workspaceId;

    const ws = this.#getOrCreateWorkspace(effectiveWorkspaceId);
    const existing = this.#findWorkspaceFile(ws, target);

    // File-sourced content (Wave U plumbing): inline content and `source_file`
    // are mutually exclusive, and both are resolved before any mutation so a
    // failure leaves the destination untouched.
    const sourceFileProvided = options.source_file !== undefined || options.sourceFile !== undefined;
    const sourceFileRef = options.source_file !== undefined ? options.source_file : options.sourceFile;
    if (sourceFileProvided && inlineContentProvided) {
      throw invalidArgumentsError(
        `write_file accepts either inline content or 'source_file', not both`
      );
    }

    // Validate read-only protection
    if (existing && existing.readOnly) {
      const isAdmin = this.#isPrivilegedPrincipal(effectiveCallerId, options);
      if (target.shared) {
        const isOwner = effectiveCallerId && (effectiveCallerId === existing.owner || isAdmin);
        if (!isOwner) {
          throw new PermissionDeniedError(
            `Cannot overwrite read-only file '${normPath}' in global workspace (owned by '${existing.owner || 'system'}')`,
            { workspaceId: effectiveWorkspaceId, callerAgentId: effectiveCallerId, filePath: normPath }
          );
        }
      } else {
        if (!isAdmin && !options.force) {
          throw new PermissionDeniedError(
            `Cannot overwrite read-only file '${normPath}' in workspace '${effectiveWorkspaceId}' (file is set to read-only; modify permissions first)`,
            { workspaceId: effectiveWorkspaceId, callerAgentId: effectiveCallerId, filePath: normPath }
          );
        }
      }
    }

    // Explicit owner assignment is an ownership mutation: require a resolvable caller
    // and owner/admin authority (default-deny anonymous claims, even in `global`).
    const requestedOwner = (typeof options.owner === 'string' && options.owner.trim()) ? options.owner : undefined;
    if (requestedOwner) {
      const isAdmin = this.#isPrivilegedPrincipal(effectiveCallerId, options);
      const ownerAssignmentAllowed = isAdmin
        || (effectiveCallerId && (effectiveCallerId === requestedOwner || (existing && effectiveCallerId === existing.owner)));
      if (!ownerAssignmentAllowed) {
        throw new PermissionDeniedError(
          effectiveCallerId
            ? `Agent '${effectiveCallerId}' cannot assign owner '${requestedOwner}' to '${normPath}' (must be admin, the current owner, or the assigned identity)`
            : `Anonymous caller is denied owner assignment on '${normPath}' (a resolvable caller identity is required)`,
          { workspaceId: effectiveWorkspaceId, callerAgentId: effectiveCallerId, filePath: normPath, code: 'PERMISSION_DENIED' }
        );
      }
    }

    // Prepare string content. A `source_file` reference is read under the
    // caller's read view only after the destination write was authorized, and
    // `append` folds the existing destination bytes in before the single
    // atomic `ws.set` below (no partial destination on failure).
    if (sourceFileProvided) {
      content = this.#readPlumbingSource(sourceFileRef, options, 'write_file source_file');
    }
    const appendRequested = Boolean(options.append);
    let stringContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    if (appendRequested && existing) {
      stringContent = existing.content + stringContent;
    }
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const size = encoder ? encoder.encode(stringContent).length : Buffer.byteLength(stringContent, 'utf8');
    const linesWritten = stringContent.split(/\r?\n/).length;

    const owner = requestedOwner || effectiveCallerId || (target.shared ? 'system' : effectiveWorkspaceId);
    const readOnly = Boolean(options.readOnly);
    const updatedAt = Date.now();

    const metadata = {
      path: target.storagePath,
      workspaceId: effectiveWorkspaceId,
      content: stringContent,
      size,
      updatedAt,
      readOnly,
      owner,
      mode: options.mode
    };

    ws.set(target.storagePath, metadata);

    return {
      success: true,
      path: normPath,
      workspaceId: publicWorkspaceKey(effectiveWorkspaceId),
      size,
      linesWritten,
      bytes_written: size,
      lines_written: linesWritten,
      message: appendRequested && existing
        ? `File '${normPath}' successfully appended (${size} bytes).`
        : `File '${normPath}' successfully written (${size} bytes).`,
      updatedAt,
      readOnly,
      owner
    };
  }

  // File Operations
  /**
   * Retrieves the text content of a file with pagination slicing, line range selection, or budget truncation.
   *
   * Invariants:
   * 1. Resolves workspace ('global' default or from path/options). If path starts with '/global/', workspace is 'global'.
   * 2. Enforces access permissions via caller identity (throws `PermissionDeniedError` if unauthorized).
   * 3. Throws `FileNotFoundError` if target path does not exist.
   * 4. If `raw: true`, returns the unformatted bare string without metadata envelope or continuation token; a word budget truncates silently in raw mode. A raw whole-file read bypasses the byte budget; `budgetBytes`/`limit` apply only when `offset` or `startLine` is supplied (`limit` alone is ignored in raw mode).
   * 5. Slices by UTF-16 code-unit offset (`offset`, `limit`) or 1-indexed line range (`startLine`, `endLine`); `offset` combined with `startLine` resumes inside that line, and an offset at/past a line end resumes at the next line.
   * 6. Truncates safely against `budgetBytes` (default 20,000 bytes) with `nextOffset`/`nextLine` continuation cues; a supplied `maxWords` caps delivered content words (prefixes excluded, at least one content word for a positive budget) and zero budgets still advance the token. When the word budget runs out inside one long line, the cut falls mid-line and `nextLine` + `nextOffset` must be passed together to resume; a cut exactly on a line boundary reports the first undelivered line with no `nextOffset`. For `offset`/`limit` reads, `nextLine` names the line in which the resumed read begins (the line containing the resume offset, or the following line when it sits at/past a line end). Every emitted continuation token strictly advances, so repeated structured pulls terminate.
   *
   * @param filePath - Absolute POSIX virtual path (e.g. '/lore/codex.json').
   * @param options - Read and pagination options.
   * @returns Structured read result with content and pagination metadata; raw unformatted string when `raw: true`.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If access is denied (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const result = virtualFs.readFile('/lore/world.md', {
   *   workspaceId: 'global',
   *   startLine: 1,
   *   endLine: 50,
   *   budgetBytes: 20000
   * });
   * console.log(result.content, result.truncated, result.nextLine);
   * const raw = virtualFs.readFile('/lore/world.md', { raw: true });
   * ```
   */
  readFile(params: ReadFileParams & { raw: true }, context?: VirtualFsCallContext): string;

  /**
   * Object-first read returning the structured delivery envelope (`raw` omitted or false).
   */
  readFile(params: ReadFileParams, context?: VirtualFsCallContext): ReadFileResult;

  /**
   * Positional read form returning the raw file string: `readFile(filePath, { raw: true })`.
   */
  readFile(filePath: string, options: ReadFileOptions & { raw: true }): string;

  /**
   * Positional read form returning the structured delivery envelope: `readFile(filePath, options?)`.
   */
  readFile(filePath: string, options?: ReadFileOptions): ReadFileResult;

  readFile(arg1: string | ReadFileParams, arg2?: unknown): string | ReadFileDelivery {
    arg1 = normalizeCanonicalParams(arg1);
    let filePath, payloadWorkspaceId, callerAgentId, options: ResolvedCallOptions;

    if (typeof arg1 === 'object' && arg1 !== null) {
      filePath = arg1.filePath || arg1.file_path || arg1.path || arg1.path_directive || arg1.pathDirective;
      payloadWorkspaceId = arg1.workspaceId || arg1.workspace_id;
      callerAgentId = arg1.callerAgentId || arg1.caller_agent_id || arg1.agentId || arg1.agent_id;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      filePath = arg1;
      const trusted = typeof arg2 === 'object' && arg2 !== null ? arg2 : {};
      options = resolvePositionalCallOptions(trusted);
      payloadWorkspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    const normPath = normalizeVirtualPath(filePath);
    const effectiveCallerId = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const target = this.#resolveWorkspaceTarget({
      normPath,
      requestedWorkspaceId: options.workspaceId || options.workspace_id || payloadWorkspaceId,
      callerAgentId: effectiveCallerId,
      options,
      operation: 'read'
    });

    const file = this.#findWorkspaceFile(this.#workspaces.get(target.workspaceId), target);

    if (!file) {
      throw new FileNotFoundError(
        `File '${normPath}' not found in workspace '${target.workspaceId}'`,
        { workspaceId: target.workspaceId, filePath: normPath }
      );
    }

    const rawOffset = options?.offset ?? options?.byte_offset ?? options?.byteOffset ?? options?.content_offset ?? options?.contentOffset ?? options?.ContentOffset ?? options?.start_offset ?? options?.startOffset;
    const rawLimit = options?.limit ?? options?.byte_limit ?? options?.byteLimit ?? options?.length;
    const rawStartLine = options?.startLine ?? options?.start_line ?? options?.StartLine ?? options?.from_line ?? options?.fromLine;
    const rawEndLine = options?.endLine ?? options?.end_line ?? options?.EndLine ?? options?.to_line ?? options?.toLine;
    const rawBudgetBytes = options?.budgetBytes ?? options?.budget_bytes ?? options?.max_bytes ?? options?.maxBytes;
    const rawMaxWords = options?.maxWords ?? options?.max_words ?? options?.budgetWords ?? options?.budget_words;
    const rawBudgetWords = options?.budgetWords ?? options?.budget_words;

    const offset = toInteger(rawOffset, undefined);
    const limit = toInteger(rawLimit, undefined);
    const startLine = toInteger(rawStartLine, undefined);
    const endLine = toInteger(rawEndLine, undefined);
    const budgetBytes = toInteger(rawBudgetBytes, undefined);
    const maxWords = toInteger(rawMaxWords, undefined);
    const budgetWords = toInteger(rawBudgetWords, undefined);
    const wordBudget = typeof maxWords === 'number'
      ? Math.max(0, maxWords)
      : (typeof budgetWords === 'number' ? Math.max(0, budgetWords) : undefined);
    const raw = Boolean(options?.raw);
    const structured = Boolean(options?.structured || options?.structuredJson);

    const fullContent = file.content;
    const lines = fullContent.split(/\r?\n/);
    const totalLines = lines.length;
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const totalBytes = encoder ? encoder.encode(fullContent).length : Buffer.byteLength(fullContent, 'utf8');

    // A supplied word budget caps delivered words directly (see truncateToWordBudget below)
    // and translates to a conservative byte budget (6 bytes/word) when `budgetBytes` is absent,
    // which keeps element-aware JSON cutoff valid while still bounding output.
    const effectiveBudgetBytes = typeof budgetBytes === 'number'
      ? Math.max(0, budgetBytes)
      : (typeof wordBudget === 'number'
          ? Math.max(0, wordBudget * 6)
          : (typeof this.defaultBudgetBytes === 'number'
              ? this.defaultBudgetBytes
              : DEFAULT_BUDGET_BYTES));

    // Case 1: Mid-file line slicing (startLine, endLine) [REQ-FS-01, AC-10, AC-EPIC14-06]
    //
    // Intra-line continuation: when the word budget is exhausted inside a single long
    // line, the line window cannot advance via `nextLine` alone. In that case the slice
    // is cut at a character position inside the line and `nextOffset` carries the exact
    // UTF-16 code-unit resume offset while `nextLine` names the line containing it.
    // Resuming requires passing both (`startLine: nextLine, offset: nextOffset`); every
    // emitted continuation token strictly advances (zero-length slices included), so
    // structured pagination always terminates. Raw reads emit no token and truncate silently.
    if (startLine !== undefined || endLine !== undefined) {
      let start = Math.max(1, startLine !== undefined ? startLine : 1);
      let end;
      let slicedLines: string[];

      // Absolute file offsets of every line start, enabling intra-line resume positions.
      const lineOffsets = new Array(totalLines);
      let lineCursor = 0;
      for (let i = 0; i < totalLines; i++) {
        lineOffsets[i] = lineCursor;
        lineCursor += lines[i].length;
        if (i < totalLines - 1) {
          lineCursor += fullContent.charCodeAt(lineCursor) === 13 ? 2 : 1;
        }
      }

      let intraLineStart = 0;
      if (start <= totalLines && typeof offset === 'number') {
        // A resume offset may sit at a line boundary or inside a later line: skip whole
        // lines until the one containing it, so a line is never re-delivered from its
        // start (an offset equal to a line end belongs to the next line).
        while (start < totalLines && offset >= lineOffsets[start - 1] + lines[start - 1].length) {
          start++;
        }
        const startLineOffset = lineOffsets[start - 1];
        const startLineEnd = startLineOffset + lines[start - 1].length;
        if (offset > startLineOffset && offset < startLineEnd) {
          intraLineStart = offset - startLineOffset;
        } else if (offset >= startLineEnd && start >= totalLines) {
          // Offset at/after the final line's end: deliver nothing rather than restarting the line.
          start = totalLines + 1;
        }
      }
      const takeLineText = (i: number) => (i === start - 1 && intraLineStart > 0 ? lines[i].slice(intraLineStart) : lines[i]);

      if (endLine !== undefined) {
        end = Math.min(totalLines, Math.max(start, endLine));
        slicedLines = (start <= end && start <= totalLines) ? lines.slice(start - 1, end) : [];
      } else {
        // Budgeted line slicing when startLine is given without endLine
        if (start > totalLines) {
          end = start;
          slicedLines = [];
        } else {
          let accumulatedBytes = 0;
          let includedCount = 0;
          for (let i = start - 1; i < totalLines; i++) {
            const lineNum = i + 1;
            const lineStr = raw ? takeLineText(i) : `${lineNum}: ${takeLineText(i)}`;
            const lineBytes = encoder ? encoder.encode(lineStr).length : Buffer.byteLength(lineStr, 'utf8');
            const separatorBytes = includedCount > 0 ? 1 : 0;
            if (includedCount > 0 && (accumulatedBytes + separatorBytes + lineBytes > effectiveBudgetBytes)) {
              break;
            }
            accumulatedBytes += separatorBytes + lineBytes;
            includedCount++;
          }
          if (includedCount === 0) {
            includedCount = 1;
          }
          end = start + includedCount - 1;
          slicedLines = lines.slice(start - 1, end);
        }
      }

      const displayLines = slicedLines.length > 0 && intraLineStart > 0
        ? [slicedLines[0].slice(intraLineStart), ...slicedLines.slice(1)]
        : slicedLines;

      if (raw === true) {
        const rawSlice = displayLines.join('\n');
        return wordBudget !== undefined ? truncateToWordBudget(rawSlice, wordBudget).content : rawSlice;
      }

      const parts = displayLines.map((line, idx) => ({
        prefix: `${start + idx}: `,
        text: line,
        fileStart: idx === 0 && intraLineStart > 0
          ? lineOffsets[start - 1] + intraLineStart
          : lineOffsets[start + idx - 1]
      }));
      let slicedContent = parts.map((part, idx) => `${idx > 0 ? '\n' : ''}${part.prefix}${part.text}`).join('');

      const deliveryStartFileOffset = parts.length > 0
        ? parts[0].fileStart
        : (totalLines > 0 ? lineOffsets[Math.min(start, totalLines) - 1] : 0);
      let wordCapped = false;
      let deliveredEndLine = end;
      let nextOffset;
      let nextLine;
      let hasMore = end < totalLines;

      if (wordBudget !== undefined) {
        // Apply the word budget in content space: line-number prefixes are scaffolding
        // and never counted against the budget, so a small budget cannot be consumed by
        // the `N: ` prefix and skip content words.
        const deliveredText = displayLines.join('\n');
        const wordCap = truncateToWordBudget(deliveredText, wordBudget);
        if (wordCap.truncated) {
          wordCapped = true;
          let cutFileOffset = wordBudget > 0
            ? contentIndexToFileOffset(parts, wordCap.endIndex)
            : deliveryStartFileOffset;
          if (wordBudget > 0 && cutFileOffset <= deliveryStartFileOffset) {
            // The cut landed at the slice start (leading whitespace): force at least one
            // content word so a positive budget always delivers content and advances.
            cutFileOffset = advancePastNextWord(fullContent, deliveryStartFileOffset);
          } else if (wordBudget === 0) {
            // A zero budget delivers no content but must still emit a strictly advancing token.
            cutFileOffset = advancePastNextWord(fullContent, deliveryStartFileOffset);
          }
          const cut = fileOffsetToRenderedCut(parts, start, cutFileOffset);
          slicedContent = wordBudget > 0 ? slicedContent.slice(0, cut.renderedIndex) : '';
          deliveredEndLine = cut.lineNumber;
          // Resolve the file line that actually contains the cut. The rendered cut line is
          // reliable while the cut stays inside the delivered slice, but a zero/negative word
          // budget force-advances to the end of the next word, which can land exactly on the
          // end of the line reported above. Resuming at that line without an offset would
          // restart the fully consumed line forever, so walk forward to the containing line.
          let cutLineIndex = Math.min(cut.lineNumber, totalLines) - 1;
          while (
            cutLineIndex + 1 < totalLines
            && cutFileOffset > lineOffsets[cutLineIndex] + lines[cutLineIndex].length
          ) {
            cutLineIndex++;
          }
          const cutLineStart = lineOffsets[cutLineIndex];
          const cutLineEnd = cutLineStart + lines[cutLineIndex].length;
          const cutIsMidLine = cutFileOffset > cutLineStart && cutFileOffset < cutLineEnd;
          hasMore = cutFileOffset < fullContent.length || end < totalLines;
          if (hasMore) {
            if (cutFileOffset <= cutLineStart) {
              // The cut sits exactly at a line start: the whole line is still undelivered.
              nextLine = cutLineIndex + 1;
              nextOffset = undefined;
            } else if (cutIsMidLine) {
              nextLine = cutLineIndex + 1;
              nextOffset = cutFileOffset;
            } else {
              // The cut consumed the line through its end: resume at the following line.
              nextLine = Math.min(cutLineIndex + 2, totalLines);
              nextOffset = undefined;
            }
          }
        }
      }

      const isTruncated = hasMore;
      if (!wordCapped && end < totalLines) {
        nextLine = end + 1;
      }
      const sliceBytes = encoder ? encoder.encode(slicedContent).length : Buffer.byteLength(slicedContent, 'utf8');
      const wordsInc = countWords(slicedContent.replace(/^\d+: /gm, ''));
      const linesInc = slicedContent === '' ? 0 : slicedContent.split('\n').length;
      const deliveryNote = isTruncated
        ? (wordCapped && wordBudget !== undefined
            ? `Output truncated at word budget of ${wordBudget.toLocaleString()} words (${wordsInc} words delivered). Next line: ${nextLine}${nextOffset !== undefined ? `, next offset: ${nextOffset} (resume with startLine and offset together inside a long line)` : ''}.`
            : `Showing lines ${start}-${end} of ${totalLines}. Next line: ${nextLine}.`)
        : 'Lines delivered in full.';

      return {
        truncated: isTruncated,
        content: slicedContent,
        totalBytes,
        totalLines,
        totalWords: countWords(fullContent),
        bytesIncluded: sliceBytes,
        linesIncluded: linesInc,
        wordsIncluded: wordsInc,
        nextOffset,
        nextLine,
        deliveryNote,
        // Compatibility aliases
        startLine: start,
        endLine: wordCapped ? deliveredEndLine : end,
        lineCount: linesInc,
        total_lines: totalLines,
        total_bytes: totalBytes,
        remainingBytes: Math.max(0, totalBytes - sliceBytes),
        notice: deliveryNote,
        toString(this: ReadFileDelivery) { return this.content; },
        valueOf(this: ReadFileDelivery) { return this.content; }
      };
    }

    // Case 2: Byte / character offset pagination (offset, limit) [REQ-FS-01, AC-11, AC-EPIC14-01, AC-EPIC14-02]
    if (offset !== undefined || (limit !== undefined && !raw)) {
      const off = Math.max(0, offset !== undefined ? offset : 0);
      const lim = Math.max(0, limit !== undefined ? limit : effectiveBudgetBytes);

      // Boundary condition: off >= totalBytes
      if (off >= totalBytes) {
        if (raw === true) {
          return '';
        }
        return {
          truncated: false,
          content: '',
          totalBytes,
          totalLines,
          totalWords: countWords(fullContent),
          bytesIncluded: 0,
          linesIncluded: 0,
          wordsIncluded: 0,
          nextOffset: undefined,
          nextLine: undefined,
          deliveryNote: 'Offset at or past end of file; 0 bytes delivered.',
          // Compatibility aliases
          offset: off,
          limit: lim,
          total_lines: totalLines,
          total_bytes: totalBytes,
          remainingBytes: 0,
          notice: undefined,
          toString(this: ReadFileDelivery) { return this.content; },
          valueOf(this: ReadFileDelivery) { return this.content; }
        };
      }

      let slicedContent = fullContent.slice(off, off + lim);
      let wordCapped = false;
      if (wordBudget !== undefined) {
        const wordCap = truncateToWordBudget(slicedContent, wordBudget);
        if (wordCap.truncated) {
          slicedContent = wordCap.content;
          wordCapped = true;
        }
      }
      const sliceBytes = encoder ? encoder.encode(slicedContent).length : Buffer.byteLength(slicedContent, 'utf8');
      let nextOffset = (off + slicedContent.length < fullContent.length) ? off + slicedContent.length : undefined;
      if (nextOffset !== undefined && nextOffset <= off) {
        // Any zero-advance continuation (e.g. `limit: 0`, `maxWords: 0`, or an
        // all-whitespace slice) would otherwise loop forever; force the token past the
        // next word so every emitted continuation strictly advances.
        const advanced = advancePastNextWord(fullContent, off);
        nextOffset = advanced < fullContent.length ? advanced : undefined;
      }
      const isTruncated = nextOffset !== undefined;
      const remainingBytes = Math.max(0, totalBytes - (off + sliceBytes));
      // The resume line is the first line whose end lies past `nextOffset` — the line the
      // resumed read begins delivering. An offset at or past a line end resumes at the
      // following line (see the offset semantics documented on ReadFileOptions), so reporting
      // the line after the cut would make the documented `nextLine` + `nextOffset` resume
      // silently skip the remainder of the cut line.
      let nextLine;
      if (isTruncated) {
        let resumeLineStart = 0;
        nextLine = totalLines;
        for (let i = 0; i < totalLines; i++) {
          const resumeLineEnd = resumeLineStart + lines[i].length;
          if (nextOffset! < resumeLineEnd) {
            nextLine = i + 1;
            break;
          }
          resumeLineStart = resumeLineEnd;
          if (i < totalLines - 1) {
            resumeLineStart += fullContent.charCodeAt(resumeLineStart) === 13 ? 2 : 1;
          }
        }
      }
      const wordsInc = countWords(slicedContent);
      const linesInc = slicedContent ? slicedContent.split(/\r?\n/).length : 0;
      const deliveryNote = wordCapped && wordBudget !== undefined
        ? `Output truncated at word budget of ${wordBudget.toLocaleString()} words (${wordsInc} words delivered). Next offset: ${nextOffset}.`
        : (isTruncated
            ? `Output sliced at offset ${off} (${sliceBytes} bytes). Next offset: ${nextOffset}.`
            : 'File slice delivered in full.');

      if (raw === true) {
        return slicedContent;
      }

      return {
        truncated: isTruncated,
        content: slicedContent,
        totalBytes,
        totalLines,
        totalWords: countWords(fullContent),
        bytesIncluded: sliceBytes,
        linesIncluded: linesInc,
        wordsIncluded: wordsInc,
        nextOffset,
        nextLine,
        deliveryNote,
        // Compatibility aliases
        offset: off,
        limit: lim,
        total_lines: totalLines,
        total_bytes: totalBytes,
        remainingBytes,
        notice: deliveryNote,
        toString(this: ReadFileDelivery) { return this.content; },
        valueOf(this: ReadFileDelivery) { return this.content; }
      };
    }

    if (raw === true) {
      return wordBudget !== undefined ? truncateToWordBudget(fullContent, wordBudget).content : fullContent;
    }

    // Case 3: Output budgeting with structured JSON cutoff [REQ-FS-02, AC-11]
    if (totalBytes > effectiveBudgetBytes) {
      const isJsonFile = normPath.endsWith('.json') || normPath.endsWith('.jsonc');
      let parsedJson = null;
      if (isJsonFile) {
        try {
          parsedJson = JSON.parse(fullContent);
        } catch {
          parsedJson = null;
        }
      }

      const totalWords = countWords(fullContent);

      if (parsedJson !== null && structured) {
        const structRes = truncateStructuredJson(parsedJson, effectiveBudgetBytes);
        const contentLines = structRes.content.split(/\r?\n/).length;
        const wordsIncluded = countWords(structRes.content);
        const bytesInc = encoder ? encoder.encode(structRes.content).length : Buffer.byteLength(structRes.content, 'utf8');
        const deliveryNote = structRes.notice || `JSON output truncated at ${effectiveBudgetBytes.toLocaleString()} bytes.`;
        return {
          content: structRes.content,
          totalBytes,
          totalLines,
          totalWords,
          bytesIncluded: bytesInc,
          linesIncluded: contentLines,
          wordsIncluded,
          truncated: true,
          nextOffset: structRes.nextOffset || effectiveBudgetBytes,
          nextLine: contentLines + 1,
          deliveryNote,
          // Compatibility aliases
          total_bytes: totalBytes,
          total_lines: totalLines,
          remainingWords: Math.max(0, totalWords - wordsIncluded),
          remainingBytes: structRes.remainingBytes,
          notice: deliveryNote,
          toString(this: ReadFileDelivery) { return this.content; },
          valueOf(this: ReadFileDelivery) { return this.content; }
        };
      }

      let truncatedContent = fullContent.slice(0, effectiveBudgetBytes);
      let wordCapped = false;
      if (wordBudget !== undefined) {
        const wordCap = truncateToWordBudget(truncatedContent, wordBudget);
        if (wordCap.truncated) {
          truncatedContent = wordCap.content;
          wordCapped = true;
        }
      }
      const contentLines = truncatedContent.split(/\r?\n/).length;
      const wordsIncluded = countWords(truncatedContent);
      const bytesInc = encoder ? encoder.encode(truncatedContent).length : Buffer.byteLength(truncatedContent, 'utf8');
      let nextOffset: number | undefined = truncatedContent.length;
      if (nextOffset <= 0) {
        // A zero-byte/zero-word budget can deliver nothing; advance the token past the
        // next word so repeated pulls strictly progress and terminate.
        const advanced = advancePastNextWord(fullContent, 0);
        nextOffset = advanced < fullContent.length ? advanced : undefined;
      }
      const nextLine = contentLines + 1;
      const deliveryNote = wordCapped && wordBudget !== undefined
        ? `Output truncated at word budget of ${wordBudget.toLocaleString()} words (${wordsIncluded} words delivered).${nextOffset !== undefined ? ` Next offset: ${nextOffset}.` : ''}`
        : `Output truncated at ${effectiveBudgetBytes.toLocaleString()} bytes.${nextOffset !== undefined ? ` Next offset: ${nextOffset}.` : ''}`;
      return {
        content: truncatedContent,
        totalBytes,
        totalLines,
        totalWords,
        bytesIncluded: bytesInc,
        linesIncluded: contentLines,
        wordsIncluded,
        truncated: true,
        nextOffset,
        nextLine,
        deliveryNote,
        // Compatibility aliases
        total_bytes: totalBytes,
        total_lines: totalLines,
        remainingWords: Math.max(0, totalWords - wordsIncluded),
        remainingBytes: Math.max(0, totalBytes - bytesInc),
        notice: deliveryNote,
        toString(this: ReadFileDelivery) { return this.content; },
        valueOf(this: ReadFileDelivery) { return this.content; }
      };
    }

    const totalWords = countWords(fullContent);
    if (wordBudget !== undefined) {
      const wordCap = truncateToWordBudget(fullContent, wordBudget);
      if (wordCap.truncated) {
        const contentLines = wordCap.content === '' ? 0 : wordCap.content.split(/\r?\n/).length;
        const bytesInc = encoder ? encoder.encode(wordCap.content).length : Buffer.byteLength(wordCap.content, 'utf8');
        const nextOffset = wordCap.endIndex;
        const nextLine = fullContent.slice(0, nextOffset).split(/\r?\n/).length + 1;
        const deliveryNote = `Output truncated at word budget of ${wordBudget.toLocaleString()} words (${wordCap.wordsIncluded} words delivered). Next offset: ${nextOffset}.`;
        return {
          content: wordCap.content,
          totalBytes,
          totalLines,
          totalWords,
          bytesIncluded: bytesInc,
          linesIncluded: contentLines,
          wordsIncluded: wordCap.wordsIncluded,
          truncated: true,
          nextOffset,
          nextLine,
          deliveryNote,
          // Compatibility aliases
          total_bytes: totalBytes,
          total_lines: totalLines,
          remainingWords: Math.max(0, totalWords - wordCap.wordsIncluded),
          remainingBytes: Math.max(0, totalBytes - bytesInc),
          notice: deliveryNote,
          toString(this: ReadFileDelivery) { return this.content; },
          valueOf(this: ReadFileDelivery) { return this.content; }
        };
      }
    }
    return {
      content: fullContent,
      totalBytes,
      totalLines,
      totalWords,
      bytesIncluded: totalBytes,
      linesIncluded: totalLines,
      wordsIncluded: totalWords,
      truncated: false,
      nextOffset: undefined,
      nextLine: undefined,
      deliveryNote: 'File delivered in full.',
      // Compatibility aliases
      total_bytes: totalBytes,
      total_lines: totalLines,
      remainingBytes: 0,
      remainingWords: 0,
      notice: 'File delivered in full.',
      toString(this: ReadFileDelivery) { return this.content; },
      valueOf(this: ReadFileDelivery) { return this.content; }
    };
  }

  /**
   * Surgically replaces target text within an existing file.
   *
   * Invariants:
   * 1. Verifies write permissions and read-only status.
   * 2. Throws `FileNotFoundError` if file does not exist.
   * 3. Throws an Error with `code: 'SEARCH_NOT_FOUND'` if `searchContent` is not found.
   * 4. If `replaceAll: true`, replaces all occurrences; otherwise replaces the single exact instance.
   *
   * @param filePath - Virtual path to file.
   * @param searchContent - Exact string to locate.
   * @param replaceContent - Replacement string.
   * @param options - Replacement options.
   * @returns Replace receipt with count of replacements and before/after sizes.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If file is read-only or workspace write denied (`PERMISSION_DENIED`).
   * @throws `Error` - With code `'SEARCH_NOT_FOUND'` if search text is not in file.
   *
   * @example
   * ```typescript
   * const receipt = virtualFs.replaceFileContent('/drafts/chapter1.txt', 'Old Name', 'New Name', {
   *   workspaceId: 'author_ws',
   *   callerAgentId: 'author-agent',
   *   replaceAll: true
   * });
   * console.log(`Replacements: ${receipt.replacementsMade}, New size: ${receipt.sizeAfter}`);
   * ```
   */
  replaceFileContent(params: ReplaceFileContentParams, context?: VirtualFsCallContext): ReplaceReceipt;

  /**
   * Positional replacement form:
   * `replaceFileContent(filePath, searchContent, replaceContent, options?)`.
   */
  replaceFileContent(filePath: string, searchContent: string, replaceContent: string, options?: ReplaceFileContentOptions): ReplaceReceipt;

  replaceFileContent(arg1: string | ReplaceFileContentParams, arg2?: unknown, arg3?: unknown, arg4?: unknown): ReplaceFileDelivery {
    arg1 = normalizeCanonicalParams(arg1);
    let filePath, targetContent, replacementContent: unknown, payloadWorkspaceId, callerAgentId, options: ResolvedCallOptions;

    if (typeof arg1 === 'object' && arg1 !== null) {
      // Named parameter object destructuring (REQ-FS-04, AC-13)
      filePath = arg1.filePath || arg1.path;
      targetContent = arg1.targetContent;
      replacementContent = arg1.replacementContent;
      payloadWorkspaceId = arg1.workspaceId || arg1.workspace_id;
      callerAgentId = arg1.callerAgentId;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (filePath, targetContent, replacementContent, options)
      filePath = arg1;
      targetContent = arg2;
      replacementContent = arg3;
      const trusted = typeof arg4 === 'object' && arg4 !== null ? arg4 : {};
      options = resolvePositionalCallOptions(trusted);
      payloadWorkspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new Error('filePath must be a non-empty string');
    }
    if (typeof targetContent !== 'string') {
      throw new Error('targetContent must be a string');
    }
    // File-sourced replacement (Wave U plumbing): inline replacement content
    // and `replacement_source_file` are mutually exclusive.
    const replacementSourceProvided = options.replacement_source_file !== undefined || options.replacementSourceFile !== undefined;
    const replacementSourceRef = options.replacement_source_file !== undefined ? options.replacement_source_file : options.replacementSourceFile;
    if (replacementSourceProvided && replacementContent !== undefined) {
      throw invalidArgumentsError(
        `replace_file_content accepts either 'replacement_content' or 'replacement_source_file', not both`
      );
    }
    if (!replacementSourceProvided && typeof replacementContent !== 'string') {
      throw new Error('replacementContent must be a string');
    }

    const normPath = normalizeVirtualPath(filePath);
    const effectiveCallerId = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const target = this.#resolveWorkspaceTarget({
      normPath,
      requestedWorkspaceId: options.workspaceId || options.workspace_id || payloadWorkspaceId,
      callerAgentId: effectiveCallerId,
      options,
      operation: 'write'
    });
    const effectiveWorkspaceId = target.workspaceId;

    const ws = this.#workspaces.get(effectiveWorkspaceId);
    if (!ws) {
      throw new FileNotFoundError(
        `File '${normPath}' not found in workspace '${effectiveWorkspaceId}'`,
        { workspaceId: effectiveWorkspaceId, filePath: normPath }
      );
    }
    const existing = this.#findWorkspaceFile(ws, target);

    if (!existing) {
      throw new FileNotFoundError(
        `File '${normPath}' not found in workspace '${effectiveWorkspaceId}'`,
        { workspaceId: effectiveWorkspaceId, filePath: normPath }
      );
    }

    if (existing.readOnly) {
      const isAdmin = this.#isPrivilegedPrincipal(effectiveCallerId, options);
      if (target.shared) {
        const isOwner = effectiveCallerId && (effectiveCallerId === existing.owner || isAdmin);
        if (!isOwner) {
          throw new PermissionDeniedError(
            `Cannot overwrite read-only file '${normPath}' in global workspace (owned by '${existing.owner || 'system'}')`,
            { workspaceId: effectiveWorkspaceId, callerAgentId: effectiveCallerId, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
      } else {
        if (!isAdmin && !options?.force) {
          throw new PermissionDeniedError(
            `Cannot overwrite read-only file '${normPath}' in workspace '${effectiveWorkspaceId}' (file is set to read-only; modify permissions first)`,
            { workspaceId: effectiveWorkspaceId, callerAgentId, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
      }
    }

    const existingContent = existing.content;
    // Read the file-sourced replacement only after the destination write is
    // authorized; the destination is mutated once at the end, so a source
    // failure leaves the target untouched (atomic).
    if (replacementSourceProvided) {
      replacementContent = this.#readPlumbingSource(replacementSourceRef, options, 'replace_file_content replacement_source_file');
    }
    // Narrowing guard: the exclusive-argument checks above guarantee a string
    // inline replacement when no source is provided, and the source read above
    // always yields a string. This exposes the validated type to the replace
    // calls below.
    if (typeof replacementContent !== 'string') {
      throw new Error('replacementContent must be a string');
    }

    // Count exact occurrences of targetContent in existingContent
    let count = 0;
    let pos = 0;
    while (true) {
      const idx = existingContent.indexOf(targetContent, pos);
      if (idx === -1) break;
      count++;
      pos = idx + targetContent.length;
      if (targetContent.length === 0) break;
    }

    if (count === 0) {
      const err: Error & { code?: string } = new Error(`Target content not found in '${normPath}'.`);
      err.code = 'SEARCH_NOT_FOUND';
      throw err;
    }
    const allowAll = Boolean(options?.replaceAll || options?.allowMultiple || options?.all);
    if (count > 1 && !allowAll) {
      throw new Error(`Target content matches multiple non-unique blocks (${count} occurrences) in '${normPath}'. Please provide a more specific, unique block.`);
    }

    const newContent = allowAll
      ? existingContent.replaceAll(targetContent, replacementContent)
      : existingContent.replace(targetContent, () => replacementContent);
    const replacementsMade = allowAll ? count : 1;
    const linesBefore = existingContent.split(/\r?\n/).length;
    const linesAfter = newContent.split(/\r?\n/).length;
    const linesModified = targetContent.split(/\r?\n/).length;
    const sizeBefore = existing.size;

    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const sizeAfter = encoder ? encoder.encode(newContent).length : Buffer.byteLength(newContent, 'utf8');

    const storagePath = target.storagePath;
    const updatedAt = Date.now();
    const metadata = {
      path: storagePath,
      workspaceId: effectiveWorkspaceId,
      content: newContent,
      size: sizeAfter,
      updatedAt,
      readOnly: existing.readOnly,
      owner: existing.owner
    };

    ws.set(storagePath, metadata);

    return {
      success: true,
      path: normPath,
      filePath: normPath,
      workspaceId: publicWorkspaceKey(effectiveWorkspaceId),
      replacementsMade,
      sizeBefore,
      sizeAfter,
      linesBefore,
      linesAfter,
      bytesWritten: sizeAfter,
      bytes_written: sizeAfter,
      lines_modified: linesModified,
      lines_written: linesAfter,
      modifiedAt: updatedAt,
      updatedAt,
      message: `File '${normPath}' successfully updated (${sizeAfter} bytes).`,
      size: sizeAfter,
      owner: existing.owner,
      readOnly: existing.readOnly
    };
  }

  /**
   * Serializes and writes structured JSON data.
   *
   * Invariants:
   * Formats JSON with 2-space indentation (unless `formatted: false`) and delegates to `writeFile`.
   *
   * @param filePath - Virtual path.
   * @param data - Any JSON-serializable value.
   * @param options - Write options.
   * @returns Write receipt.
   * @throws If write is unauthorized or target is read-only (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const receipt = virtualFs.writeJson('/data/state.json', { turn: 4, score: 100 }, {
   *   workspaceId: 'global',
   *   formatted: true
   * });
   * ```
   */
  writeJson(params: WriteJsonParams, context?: VirtualFsCallContext): WriteJsonReceipt;

  /**
   * Positional JSON write form: `writeJson(filePath, data, options?)`.
   */
  writeJson(filePath: string, data: JsonValue, options?: WriteJsonOptions): WriteJsonReceipt;

  writeJson(arg1: string | WriteJsonParams, arg2?: unknown, arg3?: unknown): WriteJsonReceipt {
    arg1 = normalizeCanonicalParams(arg1);
    let filePath, dataOrJsonString, workspaceId, callerAgentId, options: ResolvedCallOptions;
    let inlineDataProvided;
    if (typeof arg1 === 'object' && arg1 !== null) {
      filePath = arg1.filePath || arg1.path;
      inlineDataProvided = arg1.data !== undefined || arg1.content !== undefined || arg1.json !== undefined;
      dataOrJsonString = arg1.data !== undefined ? arg1.data : (arg1.content !== undefined ? arg1.content : arg1.json);
      workspaceId = arg1.workspaceId || arg1.workspace_id;
      callerAgentId = arg1.callerAgentId;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (filePath, data, options)
      filePath = arg1;
      inlineDataProvided = arg2 !== undefined;
      dataOrJsonString = arg2;
      const trusted = typeof arg3 === 'object' && arg3 !== null ? arg3 : {};
      options = resolvePositionalCallOptions(trusted);
      workspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    // File-sourced data (Wave U plumbing): inline data and `data_source_file`
    // are mutually exclusive; the referenced bytes are parsed as JSON and
    // serialized through the same formatting path as inline data.
    const dataSourceProvided = options.data_source_file !== undefined || options.dataSourceFile !== undefined;
    const dataSourceRef = options.data_source_file !== undefined ? options.data_source_file : options.dataSourceFile;
    if (dataSourceProvided && inlineDataProvided) {
      throw invalidArgumentsError(
        `write_json accepts either inline data or 'data_source_file', not both`
      );
    }

    let formattedJson;
    if (dataSourceProvided) {
      const rawSource = this.#readPlumbingSource(dataSourceRef, options, 'write_json data_source_file');
      let parsedSource: unknown;
      try {
        parsedSource = JSON.parse(rawSource);
      } catch (parseErr) {
        throw invalidJsonSourceError('write_json data_source_file', typeof dataSourceRef === 'string' ? dataSourceRef : '', parseErr);
      }
      try {
        formattedJson = options && options.formatted === false ? JSON.stringify(parsedSource) : JSON.stringify(parsedSource, null, 2);
        if (formattedJson === undefined) {
          throw new Error('JSON.stringify returned undefined');
        }
      } catch (serErr) {
        throw new Error(`Failed to serialize data_source_file payload for path '${filePath}': ${errorMessage(serErr)}`);
      }
    } else if (typeof dataOrJsonString === 'string') {
      try {
        const parsed = JSON.parse(dataOrJsonString);
        formattedJson = options && options.formatted === false ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
      } catch (parseErr) {
        throw new Error(`Invalid JSON syntax provided to writeJson for path '${filePath}': ${errorMessage(parseErr)}`);
      }
    } else {
      try {
        formattedJson = options && options.formatted === false ? JSON.stringify(dataOrJsonString) : JSON.stringify(dataOrJsonString, null, 2);
        if (formattedJson === undefined) {
          throw new Error('JSON.stringify returned undefined');
        }
      } catch (serErr) {
        throw new Error(`Failed to serialize data to JSON for path '${filePath}': ${errorMessage(serErr)}`);
      }
    }

    const targetWs = options.workspaceId || options.workspace_id || workspaceId;
    const effectiveCallerId = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const writeResult = this.writeFile(filePath as string, formattedJson, {
      ...options,
      ...(targetWs ? { workspaceId: targetWs } : {}),
      callerAgentId: effectiveCallerId as string | undefined
    });

    const linesWritten = formattedJson.split(/\r?\n/).length;
    return {
      success: true,
      path: writeResult.path,
      workspaceId: writeResult.workspaceId,
      bytes_written: writeResult.size,
      lines_written: linesWritten,
      message: `JSON file '${writeResult.path}' successfully written (${writeResult.size} bytes).`,
      size: writeResult.size,
      owner: writeResult.owner,
      readOnly: writeResult.readOnly,
      updatedAt: writeResult.updatedAt
    };
  }

  /**
   * Applies RFC 6902 JSON patch operations atomically.
   *
   * Invariants:
   * 1. Reads existing document and verifies write permissions.
   * 2. Applies patch operations sequentially and atomically in-memory with lenient auto-upsert for intermediate containers.
   * 3. If any operation fails, rolls back without modifying the file.
   * 4. Writes back updated document.
   *
   * @param filePath - Path to JSON file.
   * @param patch - Array of RFC 6902 patch operations.
   * @param options - Patch options.
   * @returns Patch receipt with count of operations applied and before/after sizes.
   * @throws If target JSON file does not exist (`FILE_NOT_FOUND`).
   * @throws If file is read-only or write unauthorized (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const receipt = virtualFs.patchJson('/data/config.json', [
   *   { op: 'replace', path: '/settings/theme', value: 'dark' },
   *   { op: 'add', path: '/settings/notifications/email', value: true }
   * ], { workspaceId: 'global' });
   * console.log(receipt.operationsApplied);
   * ```
   */
  patchJson(params: PatchJsonParams, context?: VirtualFsCallContext): PatchReceipt;

  /**
   * Positional patch form: `patchJson(filePath, patch, options?)`.
   */
  patchJson(filePath: string, patch: JsonPatchOperation[], options?: PatchJsonOptions): PatchReceipt;

  patchJson(filePathOrParams: string | PatchJsonParams, patch?: unknown, options: Record<string, unknown> = {}): PatchFileDelivery {
    filePathOrParams = normalizeCanonicalParams(filePathOrParams);
    let normFilePath, operations, targetWorkspace, caller, opts: ResolvedCallOptions;

    if (typeof filePathOrParams === 'object' && filePathOrParams !== null) {
      normFilePath = filePathOrParams.filePath || filePathOrParams.path;
      operations = filePathOrParams.patch || filePathOrParams.operations;
      const contextSupplied = typeof patch === 'object' && !Array.isArray(patch) && patch !== null;
      const trusted = contextSupplied
        ? patch
        : (typeof filePathOrParams.options === 'object' && filePathOrParams.options !== null
            ? filePathOrParams.options
            : (typeof options === 'object' && options !== null ? options : undefined));
      opts = sanitizeFsOptions(filePathOrParams, trusted);
      applyTrustedIdentity(opts, trusted, contextSupplied, filePathOrParams.callerAgentId);
      if (contextSupplied) attachTrustedAgentContext(opts, trusted);
      targetWorkspace = filePathOrParams.workspaceId || filePathOrParams.workspace_id || opts.workspaceId || opts.workspace_id;
      caller = opts.callerAgentId;
    } else {
      // Canonical positional: (filePath, patch, options)
      normFilePath = filePathOrParams;
      operations = patch;
      const trusted = typeof options === 'object' && options !== null ? options : {};
      opts = resolvePositionalCallOptions(trusted);
      targetWorkspace = opts.workspaceId || opts.workspace_id;
      caller = opts.callerAgentId || opts.caller_agent_id;
    }

    if (typeof normFilePath !== 'string' || !normFilePath.trim()) {
      throw new Error("Missing required 'filePath' for patchJson");
    }
    if (!Array.isArray(operations)) {
      throw new Error("patchJson requires an array of RFC 6902 patch operations");
    }

    const normPath = normalizeVirtualPath(normFilePath);
    const effectiveCallerId = opts.callerAgentId !== undefined ? opts.callerAgentId : caller;
    const target = this.#resolveWorkspaceTarget({
      normPath,
      requestedWorkspaceId: targetWorkspace,
      callerAgentId: effectiveCallerId,
      options: opts,
      operation: 'write'
    });
    const effectiveWorkspace = target.workspaceId;

    const ws = this.#workspaces.get(effectiveWorkspace);
    const existing = this.#findWorkspaceFile(ws, target);

    if (!existing) {
      throw new FileNotFoundError(
        `File '${normPath}' not found in workspace '${effectiveWorkspace}'`,
        { workspaceId: effectiveWorkspace, filePath: normPath }
      );
    }

    if (existing.readOnly) {
      const isAdmin = this.#isPrivilegedPrincipal(effectiveCallerId, opts);
      if (target.shared) {
        const isOwner = effectiveCallerId && (effectiveCallerId === existing.owner || isAdmin);
        if (!isOwner) {
          throw new PermissionDeniedError(
            `Cannot patch read-only file '${normPath}' in global workspace (owned by '${existing.owner || 'system'}')`,
            { workspaceId: effectiveWorkspace, callerAgentId: effectiveCallerId, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
      } else {
        if (!isAdmin && !opts?.force) {
          throw new PermissionDeniedError(
            `Cannot patch read-only file '${normPath}' in workspace '${effectiveWorkspace}' (file is set to read-only; modify permissions first)`,
            { workspaceId: effectiveWorkspace, callerAgentId: effectiveCallerId, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
      }
    }

    let originalDoc;
    try {
      originalDoc = JSON.parse(existing.content);
    } catch (parseErr) {
      throw new Error(`Failed to parse target JSON file '${normPath}' for patching: ${errorMessage(parseErr)}`);
    }

    // Resolve per-operation `value_file` references before any mutation: every
    // reference is read under the caller's read view and parsed up front, so a
    // failure leaves the document byte-identical (atomic).
    const resolvedOperations = this.#resolvePatchOperationValues(operations as JsonPatchOperation[], opts);

    // Atomic application using preprocessAndApplyPatch (lenient auto-upsert and intermediate container auto-creation)
    let patchResult;
    try {
      patchResult = preprocessAndApplyPatch(originalDoc, resolvedOperations);
    } catch (patchErr) {
      const err = patchErr as Error & { index?: number; operation?: unknown };
      const errIndex = err.index !== undefined ? err.index : 'unknown';
      const errOp = err.operation ? JSON.stringify(err.operation) : 'unknown';
      throw new Error(`RFC 6902 JSON Patch failed at operation [${errIndex}] ${errOp}: ${err.message || err.name}. Transaction rolled back atomically; zero changes persisted.`);
    }

    const sizeBefore = existing.size;
    const updatedDoc = patchResult.newDocument;
    const formattedJson = opts?.formatted === false ? JSON.stringify(updatedDoc) : JSON.stringify(updatedDoc, null, 2);
    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const sizeAfter = encoder ? encoder.encode(formattedJson).length : Buffer.byteLength(formattedJson, 'utf8');
    const updatedAt = Date.now();

    existing.content = formattedJson;
    existing.size = sizeAfter;
    existing.updatedAt = updatedAt;

    return {
      success: true,
      filePath: normPath,
      path: normPath,
      workspaceId: publicWorkspaceKey(effectiveWorkspace),
      operationsApplied: resolvedOperations.length,
      sizeBefore,
      sizeAfter,
      size: sizeAfter,
      modifiedAt: updatedAt,
      updatedAt,
      bytesWritten: sizeAfter,
      bytes_written: sizeAfter,
      message: `RFC 6902 JSON Patch successfully applied ${resolvedOperations.length} operation(s) to '${normPath}'.`
    };
  }

  /**
   * Concatenates multiple virtual files into one destination file (Wave U file
   * plumbing).
   *
   * Invariants:
   * 1. Every source is resolved under the caller's existing workspace view with
   *    read rules (`/` private, `/global/...` shared, `/agents/<id>/...` with
   *    cross-workspace authority) — plumbing grants no new read powers.
   * 2. Every source is capped at {@link FILE_PLUMBING_MAX_FILE_BYTES} and the
   *    joined payload at {@link FILE_PLUMBING_MAX_TOTAL_BYTES}; oversize
   *    references fail `FileTooLargeError`.
   * 3. All sources are read and joined in memory before a single
   *    {@link VirtualFS#writeFile} call, so a failure leaves the destination
   *    byte-identical (atomic; no partial destination).
   * 4. The destination follows the caller's write view and its usual
   *    read-only/owner rules.
   *
   * @param params - Object-first call form: `{ sources, destination, separator?, ... }`
   * @param context - Optional trusted call context
   * @returns Concatenation receipt with the destination path, source count, and byte counts
   * @throws `INVALID_ARGUMENTS` when `sources` is not a non-empty array or `destination` is missing
   * @throws `PermissionDeniedError`/`FileNotFoundError`/`FileTooLargeError` per the source reads
   *
   * @example
   * ```typescript
   * const receipt = virtualFs.concatFiles(
   *   ['/parts/intro.md', '/parts/body.md'],
   *   '/combined.md',
   *   { separator: '\n\n' }
   * );
   * console.log(receipt.source_count, receipt.bytes_written);
   * ```
   */
  concatFiles(params: ConcatFilesParams, context?: VirtualFsCallContext): ConcatFilesReceipt;

  /**
   * Positional concatenation form: `concatFiles(sources, destination, options?)`.
   */
  concatFiles(sources: readonly string[], destination: string, options?: ConcatFilesOptions): ConcatFilesReceipt;

  concatFiles(arg1: ConcatFilesParams | readonly string[], arg2?: unknown, arg3?: unknown): ConcatFilesReceipt {
    arg1 = normalizeCanonicalParams(arg1);
    let sources, destinationPath, payloadWorkspaceId, callerAgentId, options: ResolvedCallOptions;

    if (arg1 !== null && typeof arg1 === 'object' && !Array.isArray(arg1)) {
      const payload = arg1 as ConcatFilesParams;
      sources = payload.sources !== undefined
        ? payload.sources
        : (payload.source_paths !== undefined ? payload.source_paths : payload.files);
      destinationPath = payload.destination !== undefined
        ? payload.destination
        : (payload.dest_path !== undefined ? payload.dest_path : payload.destination_path);
      payloadWorkspaceId = payload.workspaceId || payload.workspace_id;
      callerAgentId = payload.callerAgentId || payload.caller_agent_id;
      options = resolveObjectCallOptions(payload, arg2, callerAgentId);
    } else {
      sources = arg1;
      destinationPath = arg2;
      const trusted = typeof arg3 === 'object' && arg3 !== null ? arg3 : {};
      options = resolvePositionalCallOptions(trusted);
      payloadWorkspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    if (!Array.isArray(sources) || sources.length === 0) {
      throw invalidArgumentsError(`concat_files requires a non-empty 'sources' array`);
    }
    if (typeof destinationPath !== 'string' || !destinationPath.trim()) {
      throw invalidArgumentsError(`concat_files requires a non-empty 'destination' path`);
    }
    const rawSeparator = options.separator !== undefined ? options.separator : options.delimiter;
    if (rawSeparator !== undefined && typeof rawSeparator !== 'string') {
      throw invalidArgumentsError(`concat_files 'separator' must be a string`);
    }
    const separator = typeof rawSeparator === 'string' ? rawSeparator : '';

    // Read and merge every source before the single atomic destination write.
    const parts: string[] = [];
    let cumulativeBytes = 0;
    for (let index = 0; index < sources.length; index++) {
      const part = this.#readPlumbingSource(sources[index], options, `concat_files sources[${index}]`);
      cumulativeBytes += utf8ByteLength(part);
      if (cumulativeBytes > FILE_PLUMBING_MAX_TOTAL_BYTES) {
        throw new FileTooLargeError(
          `concat_files payload exceeds the ${FILE_PLUMBING_MAX_TOTAL_BYTES}-byte aggregate plumbing cap after source[${index}]`,
          { maxBytes: FILE_PLUMBING_MAX_TOTAL_BYTES, actualBytes: cumulativeBytes }
        );
      }
      parts.push(part);
    }
    const joined = parts.join(separator);
    const joinedBytes = utf8ByteLength(joined);
    if (joinedBytes > FILE_PLUMBING_MAX_TOTAL_BYTES) {
      throw new FileTooLargeError(
        `concat_files payload is ${joinedBytes} bytes and exceeds the ${FILE_PLUMBING_MAX_TOTAL_BYTES}-byte aggregate plumbing cap`,
        { maxBytes: FILE_PLUMBING_MAX_TOTAL_BYTES, actualBytes: joinedBytes }
      );
    }

    const writeResult = this.writeFile(destinationPath, joined, {
      ...options,
      ...(options.workspaceId || options.workspace_id || payloadWorkspaceId
        ? { workspaceId: options.workspaceId || options.workspace_id || payloadWorkspaceId }
        : {}),
      callerAgentId: (options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId) as string | undefined
    });

    return {
      success: true,
      path: writeResult.path,
      workspaceId: writeResult.workspaceId,
      source_count: sources.length,
      separator,
      bytes_written: writeResult.size,
      lines_written: writeResult.linesWritten,
      updatedAt: writeResult.updatedAt,
      message: `Concatenated ${sources.length} file(s) into '${writeResult.path}' (${writeResult.size} bytes).`
    };
  }

  /**
   * Copies a file within or across workspaces.
   *
   * Invariants:
   * 1. Reads source file (validating source read permissions). Throws `FileNotFoundError` if source is missing.
   * 2. Checks destination exists. If destination exists and `options.overwrite === false`, throws `FileExistsError`.
   * 3. Writes copy to destination workspace with updated ownership and timestamp.
   *
   * @param srcPath - Source virtual path.
   * @param destPath - Destination virtual path.
   * @param options - Copy options and workspace routing.
   * @returns Copy receipt confirming destination path, workspace, and size.
   * @throws If source file does not exist (`FILE_NOT_FOUND`).
   * @throws If destination exists and overwrite is false (`FILE_EXISTS`).
   * @throws If read or write permissions are rejected (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const receipt = virtualFs.copyFile('/templates/profile.json', '/agent_1/profile.json', {
   *   srcWorkspaceId: 'global',
   *   destWorkspaceId: 'agent_1',
   *   callerAgentId: 'agent_1',
   *   overwrite: true
   * });
   * console.log(receipt.success, receipt.destPath);
   * ```
   */
  copyFile(params: CopyFileParams, context?: VirtualFsCallContext): CopyReceipt;

  /**
   * Positional copy form: `copyFile(srcPath, destPath, options?)`; a single
   * `workspaceId` option routes both sides when the per-side workspaces are omitted.
   */
  copyFile(srcPath: string, destPath: string, options?: CopyFileOptions): CopyReceipt;

  copyFile(arg1: string | CopyFileParams, arg2?: unknown, arg3?: unknown): CopyFileDelivery {
    arg1 = normalizeCanonicalParams(arg1);
    let srcPath, destPath, srcWorkspaceId, destWorkspaceId, callerAgentId, options: ResolvedCallOptions;

    if (typeof arg1 === 'object' && arg1 !== null) {
      srcPath = arg1.srcPath || arg1.sourcePath || arg1.from || arg1.filePath;
      destPath = arg1.destPath || arg1.destinationPath || arg1.to || arg1.targetPath;
      srcWorkspaceId = arg1.srcWorkspaceId || arg1.sourceWorkspaceId || arg1.workspaceId;
      destWorkspaceId = arg1.destWorkspaceId || arg1.destinationWorkspaceId || arg1.workspaceId;
      callerAgentId = arg1.callerAgentId;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (srcPath, destPath, options)
      srcPath = arg1;
      destPath = arg2;
      const trusted = typeof arg3 === 'object' && arg3 !== null ? arg3 : {};
      options = resolvePositionalCallOptions(trusted);
      srcWorkspaceId = options.srcWorkspaceId || options.sourceWorkspaceId || options.workspaceId;
      destWorkspaceId = options.destWorkspaceId || options.destinationWorkspaceId || options.workspaceId;
      callerAgentId = options.callerAgentId;
    }

    if (!srcPath || typeof srcPath !== 'string') {
      throw new Error("Missing required argument 'srcPath' for copyFile");
    }
    if (!destPath || typeof destPath !== 'string') {
      throw new Error("Missing required argument 'destPath' for copyFile");
    }

    if (srcPath.includes(':') && !srcPath.startsWith('/')) {
      const idx = srcPath.indexOf(':');
      srcWorkspaceId = srcPath.slice(0, idx);
      srcPath = srcPath.slice(idx + 1);
    }
    if (destPath.includes(':') && !destPath.startsWith('/')) {
      const idx = destPath.indexOf(':');
      destWorkspaceId = destPath.slice(0, idx);
      destPath = destPath.slice(idx + 1);
    }

    const normSrc = normalizeVirtualPath(srcPath);
    const normDest = normalizeVirtualPath(destPath);

    const srcCaller = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const destCaller = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;

    // The workspace view resolves both sides: mounts (`/global`, `/agents/...`)
    // and private defaults in trusted agent context, legacy routing otherwise.
    const srcTarget = this.#resolveWorkspaceTarget({
      normPath: normSrc,
      requestedWorkspaceId: options.srcWorkspaceId || options.sourceWorkspaceId || options.workspaceId || srcWorkspaceId,
      callerAgentId: srcCaller,
      options,
      operation: 'read'
    });
    const destTarget = this.#resolveWorkspaceTarget({
      normPath: normDest,
      requestedWorkspaceId: options.destWorkspaceId || options.destinationWorkspaceId || options.workspaceId || destWorkspaceId,
      callerAgentId: destCaller,
      options,
      operation: 'write'
    });

    const srcWs = this.#workspaces.get(srcTarget.workspaceId);
    const srcFile = this.#findWorkspaceFile(srcWs, srcTarget);
    if (!srcFile) {
      throw new FileNotFoundError(
        `Source file '${normSrc}' not found in workspace '${srcTarget.workspaceId}'`,
        { workspaceId: srcTarget.workspaceId, filePath: normSrc }
      );
    }

    const destWs = this.#getOrCreateWorkspace(destTarget.workspaceId);
    const existingDest = this.#findWorkspaceFile(destWs, destTarget);

    const overwrite = options.overwrite !== undefined ? Boolean(options.overwrite) : true;
    if (existingDest && !overwrite) {
      throw new FileExistsError(
        `Destination file '${normDest}' already exists in workspace '${destTarget.workspaceId}'`,
        { workspaceId: destTarget.workspaceId, filePath: normDest }
      );
    }

    if (existingDest && existingDest.readOnly) {
      const isAdmin = this.#isPrivilegedPrincipal(destCaller, options);
      if (destTarget.shared) {
        const isOwner = destCaller && (destCaller === existingDest.owner || isAdmin);
        if (!isOwner) {
          throw new PermissionDeniedError(
            `Cannot overwrite read-only file '${normDest}' in global workspace (owned by '${existingDest.owner || 'system'}')`,
            { workspaceId: destTarget.workspaceId, callerAgentId: destCaller, filePath: normDest, code: 'PERMISSION_DENIED' }
          );
        }
      } else {
        if (!isAdmin && !options.force) {
          throw new PermissionDeniedError(
            `Cannot overwrite read-only file '${normDest}' in workspace '${destTarget.workspaceId}' (file is set to read-only; modify permissions first)`,
            { workspaceId: destTarget.workspaceId, callerAgentId: destCaller, filePath: normDest, code: 'PERMISSION_DENIED' }
          );
        }
      }
    }

    // Explicit owner assignment is an ownership mutation: require a resolvable caller
    // and owner/admin authority (default-deny anonymous claims, even in `global`).
    const requestedOwner = (typeof options.owner === 'string' && options.owner.trim()) ? options.owner : undefined;
    if (requestedOwner) {
      const isAdmin = this.#isPrivilegedPrincipal(destCaller, options);
      const ownerAssignmentAllowed = isAdmin
        || (destCaller && (destCaller === requestedOwner
          || destCaller === srcFile.owner
          || (existingDest && destCaller === existingDest.owner)));
      if (!ownerAssignmentAllowed) {
        throw new PermissionDeniedError(
          destCaller
            ? `Agent '${destCaller}' cannot assign owner '${requestedOwner}' to '${normDest}' (must be admin, a current owner, or the assigned identity)`
            : `Anonymous caller is denied owner assignment on '${normDest}' (a resolvable caller identity is required)`,
          { workspaceId: destTarget.workspaceId, callerAgentId: destCaller, filePath: normDest, code: 'PERMISSION_DENIED' }
        );
      }
    }

    const owner = requestedOwner || destCaller || (destTarget.shared ? srcFile.owner || 'system' : destTarget.workspaceId);
    const readOnly = options.readOnly !== undefined ? Boolean(options.readOnly) : Boolean(srcFile.readOnly);
    const updatedAt = Date.now();

    const storageDest = destTarget.storagePath;
    const destMeta = {
      path: storageDest,
      workspaceId: destTarget.workspaceId,
      content: srcFile.content,
      size: srcFile.size,
      updatedAt,
      readOnly,
      owner,
      permissions: options.permissions ? { ...options.permissions } : (srcFile.permissions ? { ...srcFile.permissions } : undefined),
      mode: options.mode || srcFile.mode
    };

    destWs.set(storageDest, destMeta);

    return {
      success: true,
      srcPath: normSrc,
      destPath: normDest,
      srcWorkspaceId: publicWorkspaceKey(srcTarget.workspaceId),
      destWorkspaceId: publicWorkspaceKey(destTarget.workspaceId),
      bytesCopied: srcFile.size,
      size: srcFile.size,
      readOnly,
      owner,
      updatedAt,
      message: `File '${normSrc}' successfully copied to '${normDest}' (${srcFile.size} bytes).`
    };
  }

  /**
   * Updates permission attributes (readOnly, owner, mode) for an existing virtual file.
   *
   * Invariants:
   * Validates permissions and updates metadata. `readOnly`/`mode`/`permissions` mutation requires a
   * resolvable caller with file-owner, workspace-owner, or privileged-principal authority; anonymous
   * callers are denied even in `global`. Owner reassignment additionally requires a privileged
   * principal or current-owner authority; anonymous owner reassignment is denied. All authorization
   * runs before any state change, so a denied call leaves
   * `readOnly`/`mode`/`owner`/`permissions`/`updatedAt` untouched.
   *
   * @param filePath - Virtual path to file.
   * @param permissions - Updated permission payload.
   * @param options - Security context options.
   * @returns Permissions receipt.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If caller is unauthorized (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const receipt = virtualFs.setPermissions('/lore/canon.json', { readOnly: true }, {
   *   workspaceId: 'global',
   *   callerAgentId: 'operator'
   * });
   * console.log(`File is now readOnly: ${receipt.readOnly}`);
   * ```
   */
  setPermissions(params: SetPermissionsParams, context?: VirtualFsCallContext): PermissionsReceipt;

  /**
   * Positional permissions form:
   * `setPermissions(filePath, permissionsOrReadOnly, options?)`.
   */
  setPermissions(filePath: string, permissions: PermissionsPayload | boolean | string, options?: SetPermissionsOptions): PermissionsReceipt;

  setPermissions(arg1: string | SetPermissionsParams, arg2?: unknown, arg3?: unknown): PermissionsDelivery {
    arg1 = normalizeCanonicalParams(arg1);
    let filePath, permissionsOrReadOnly, payloadWorkspaceId, callerAgentId, options: ResolvedCallOptions;

    if (typeof arg1 === 'object' && arg1 !== null) {
      filePath = arg1.filePath || arg1.path;
      payloadWorkspaceId = arg1.workspaceId || arg1.workspace_id;
      callerAgentId = arg1.callerAgentId;
      permissionsOrReadOnly = arg1.permissions !== undefined ? arg1.permissions : (arg1.readOnly !== undefined ? arg1.readOnly : arg1.mode);
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (filePath, permissionsOrReadOnly, options)
      filePath = arg1;
      permissionsOrReadOnly = arg2;
      const trusted = typeof arg3 === 'object' && arg3 !== null ? arg3 : {};
      options = resolvePositionalCallOptions(trusted);
      payloadWorkspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    if (!filePath || typeof filePath !== 'string') {
      throw new Error("Missing required argument 'filePath' for setPermissions");
    }

    if (filePath.includes(':') && !filePath.startsWith('/')) {
      const idx = filePath.indexOf(':');
      payloadWorkspaceId = filePath.slice(0, idx);
      filePath = filePath.slice(idx + 1);
    }

    const normPath = normalizeVirtualPath(filePath);
    const effectiveCaller = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const target = this.#resolveWorkspaceTarget({
      normPath,
      requestedWorkspaceId: options.workspaceId || options.workspace_id || payloadWorkspaceId,
      callerAgentId: effectiveCaller,
      options,
      operation: 'write'
    });
    const effectiveWorkspaceId = target.workspaceId;

    const ws = this.#workspaces.get(effectiveWorkspaceId);
    const file = this.#findWorkspaceFile(ws, target);
    if (!file) {
      throw new FileNotFoundError(
        `File '${normPath}' not found in workspace '${effectiveWorkspaceId}'`,
        { workspaceId: effectiveWorkspaceId, filePath: normPath }
      );
    }

    const isAdmin = this.#isPrivilegedPrincipal(effectiveCaller, options);
    const hasResolvableCaller = typeof effectiveCaller === 'string' && effectiveCaller.length > 0;

    const isOwner = isAdmin || (hasResolvableCaller && (effectiveCaller === file.owner || effectiveCaller === effectiveWorkspaceId || (target.shared && !file.owner)));

    // Stage every requested permission change before any authorization decision: a denied
    // mutation must leave readOnly/mode/owner/permissions/updatedAt fully untouched.
    let readOnly = file.readOnly;
    let mode = file.mode;
    let payloadOwner;
    let readOnlyRequested = false;
    let modeRequested = false;

    const applyModeReadOnly = (value: unknown) => {
      const lower = String(value).toLowerCase();
      if (['r', 'ro', 'readonly', '444', '0444', '0o444'].includes(lower)) {
        readOnly = true;
      } else if (['rw', 'readwrite', '644', '0644', '0o644', '666', '0666', '0o666'].includes(lower)) {
        readOnly = false;
      }
    };

    if (typeof permissionsOrReadOnly === 'boolean') {
      readOnly = permissionsOrReadOnly;
      readOnlyRequested = true;
    } else if (typeof permissionsOrReadOnly === 'string') {
      mode = permissionsOrReadOnly;
      modeRequested = true;
      applyModeReadOnly(mode);
    } else if (typeof permissionsOrReadOnly === 'object' && permissionsOrReadOnly !== null) {
      const payloadReadOnly = readOwn(permissionsOrReadOnly, 'readOnly');
      if (payloadReadOnly !== undefined) {
        readOnly = Boolean(payloadReadOnly);
        readOnlyRequested = true;
      }
      const payloadOwnerValue = readOwn(permissionsOrReadOnly, 'owner');
      if (typeof payloadOwnerValue === 'string') {
        payloadOwner = payloadOwnerValue;
      }
      const payloadMode = readOwn(permissionsOrReadOnly, 'mode');
      if (payloadMode !== undefined) {
        mode = String(payloadMode);
        modeRequested = true;
        applyModeReadOnly(mode);
      }
    }

    if (options.readOnly !== undefined) {
      readOnly = Boolean(options.readOnly);
      readOnlyRequested = true;
    }
    if (options.mode !== undefined) {
      mode = String(options.mode);
      modeRequested = true;
      applyModeReadOnly(mode);
    }

    const requestedOwner = options.owner !== undefined ? options.owner : payloadOwner;
    const permissionsRequested = options.permissions !== undefined && options.permissions !== null && typeof options.permissions === 'object';
    const permissionMutationRequested = readOnlyRequested || modeRequested || permissionsRequested;

    // Authenticated non-owners are denied permission mutations; anonymous callers are denied
    // whenever a readOnly/mode/permissions mutation is requested, even in `global`.
    // (Owner reassignment below keeps its own default-deny.)
    if (!isOwner && (hasResolvableCaller || permissionMutationRequested)) {
      throw new PermissionDeniedError(
        hasResolvableCaller
          ? `Agent '${effectiveCaller}' is not authorized to modify permissions for '${normPath}' (must be file owner, workspace owner, or admin)`
          : `Anonymous caller is denied permission modification of '${normPath}' (a resolvable caller identity is required)`,
        { workspaceId: effectiveWorkspaceId, callerAgentId: effectiveCaller, filePath: normPath, code: 'PERMISSION_DENIED' }
      );
    }

    if (requestedOwner && typeof requestedOwner === 'string') {
      // Owner reassignment is an authorization boundary: default-deny without a
      // resolvable caller identity (even in `global`), consistent with workspace ACLs.
      if (!isAdmin && (!hasResolvableCaller || effectiveCaller !== file.owner)) {
        throw new PermissionDeniedError(
          !hasResolvableCaller
            ? `Anonymous caller is denied owner reassignment of '${normPath}' (a resolvable caller identity is required)`
            : `Agent '${effectiveCaller}' cannot reassign owner of '${normPath}' (must be admin or current owner)`,
          { workspaceId: effectiveWorkspaceId, callerAgentId: effectiveCaller, filePath: normPath, code: 'PERMISSION_DENIED' }
        );
      }
    }

    // All authorization passed: apply the staged changes atomically.
    file.readOnly = readOnly;
    file.mode = mode;
    if (requestedOwner && typeof requestedOwner === 'string') {
      file.owner = requestedOwner;
    }
    if (permissionsRequested) {
      file.permissions = { ...(file.permissions || {}), ...options.permissions };
    }

    file.updatedAt = Date.now();

    return {
      success: true,
      filePath: normPath,
      path: normPath,
      workspaceId: publicWorkspaceKey(effectiveWorkspaceId),
      readOnly: file.readOnly,
      mode: file.mode,
      owner: file.owner,
      permissions: file.permissions,
      updatedAt: file.updatedAt,
      message: `Permissions updated for '${normPath}' in workspace '${publicWorkspaceKey(effectiveWorkspaceId)}'.`
    };
  }

  /**
   * Queries a JSON document using keypaths (`user.profile.name`), JSONPath (`$.users[*]`), or jq pipelines (`.items[] | select(.id == 1)`).
   *
   * Invariants:
   * 1. Reads and parses target file. Throws `FileNotFoundError` if missing.
   * 2. Selects appropriate AST engine based on query syntax (jq parser or tokenized keypath resolver).
   * 3. Truncates output larger than `budgetBytes` (default 1,500 bytes); with `structured: true` the truncation is element-aware.
   *
   * @param filePath - Path to JSON file.
   * @param query - Query expression string (defaults to '.').
   * @param options - Query options and budget threshold.
   * @returns Query result payload (or truncated JSON result).
   * @throws If JSON file does not exist (`FILE_NOT_FOUND`).
   * @throws If workspace access is denied (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const characters = virtualFs.queryJson(
   *   '/lore/codex.json',
   *   '.characters[] | select(.role == "protagonist")',
   *   { workspaceId: 'global' }
   * );
   * ```
   */
  queryJson(params: QueryJsonParams, context?: VirtualFsCallContext): QueryJsonResult;

  /**
   * Positional query form: `queryJson(filePath, query?, options?)`.
   */
  queryJson(filePath: string, query?: string, options?: QueryJsonOptions): QueryJsonResult;

  /**
   * Positional query form with options in the second position: `queryJson(filePath, options)`.
   */
  queryJson(filePath: string, options: QueryJsonOptions): QueryJsonResult;

  queryJson(arg1: string | QueryJsonParams, arg2?: unknown, arg3?: unknown): QueryJsonResult {
    arg1 = normalizeCanonicalParams(arg1);
    let filePath, jqFilter, workspaceId, callerAgentId, options: ResolvedCallOptions;
    if (typeof arg1 === 'object' && arg1 !== null) {
      filePath = arg1.filePath || arg1.path;
      jqFilter = arg1.filter !== undefined ? arg1.filter : (arg1.keyPath !== undefined ? arg1.keyPath : (arg1.query !== undefined ? arg1.query : (arg1.jsonPath !== undefined ? arg1.jsonPath : '.')));
      workspaceId = arg1.workspaceId || arg1.workspace_id;
      callerAgentId = arg1.callerAgentId;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (filePath, query, options)
      filePath = arg1;
      jqFilter = typeof arg2 === 'string' ? arg2 : '.';
      const trusted = typeof arg3 === 'object' && arg3 !== null ? arg3 : (typeof arg2 === 'object' && arg2 !== null ? arg2 : {});
      options = resolvePositionalCallOptions(trusted);
      workspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    const targetWs = options.workspaceId || options.workspace_id || workspaceId;
    const effectiveCallerId = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const rawContent = this.readFile(filePath as string, {
      ...options,
      ...(targetWs ? { workspaceId: targetWs } : {}),
      callerAgentId: effectiveCallerId as string | undefined,
      raw: true
    });
    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (parseError) {
      throw new Error(`Failed to parse JSON file '${filePath}' in workspace '${publicWorkspaceKey(targetWs || 'global')}': ${errorMessage(parseError)}`);
    }

    const filterStr = typeof jqFilter === 'string' ? jqFilter.trim() : '';
    let result;

    if (filterStr === '' || filterStr === '.' || filterStr === '/' || filterStr === '$' || filterStr === '$.' || filterStr === '$/' || jqFilter === null || jqFilter === undefined) {
      result = parsed;
    } else if (filterStr.startsWith('$') || filterStr.startsWith('JSONPath:')) {
      const pathExp = filterStr.startsWith('JSONPath:') ? filterStr.slice(9).trim() : filterStr;
      try {
        result = JSONPath({ path: pathExp, json: parsed, wrap: false });
      } catch (jpErr) {
        throw new Error(`JSONPath query '${pathExp}' failed: ${errorMessage(jpErr)}`);
      }
    } else if (
      filterStr.includes('|') ||
      filterStr.includes('select(') ||
      filterStr.includes('map(') ||
      filterStr === 'keys' ||
      filterStr === 'length' ||
      filterStr === 'type' ||
      filterStr === 'to_entries' ||
      filterStr === 'from_entries' ||
      filterStr.startsWith('has(') ||
      filterStr.startsWith('del(') ||
      filterStr.includes('==') ||
      filterStr.includes('!=') ||
      filterStr.includes('<=') ||
      filterStr.includes('>=') ||
      filterStr.startsWith('{') ||
      filterStr.startsWith('[.') ||
      filterStr.startsWith('[ .')
    ) {
      result = evaluateJq(parsed, filterStr);
    } else {
      const tokens = tokenizeKeyPath(filterStr);
      if (tokens.length > 0) {
        result = resolveTokens(parsed, tokens);
      } else {
        try {
          result = JSONPath({ path: '$.' + filterStr, json: parsed, wrap: false });
        } catch {
          result = evaluateJq(parsed, filterStr);
        }
      }
    }

    // Extract-to-file (Wave U plumbing): the complete serialized result is
    // written server-side under the caller's write view and never transits
    // context. The payload is capped by the plumbing limit before the single
    // atomic write; the return-cap truncation does not apply to file output.
    const outputFileProvided = options.output_file !== undefined || options.outputFile !== undefined;
    if (outputFileProvided) {
      const outputRef = options.output_file !== undefined ? options.output_file : options.outputFile;
      if (typeof outputRef !== 'string' || !outputRef.trim()) {
        throw invalidArgumentsError(`'query_json output_file' must be a non-empty string path`);
      }
      const serialized = result === undefined ? 'null' : JSON.stringify(result, null, 2);
      const serializedBytes = utf8ByteLength(serialized);
      if (serializedBytes > FILE_PLUMBING_MAX_FILE_BYTES) {
        throw new FileTooLargeError(
          `query_json result for '${String(filePath)}' is ${serializedBytes} bytes and exceeds the ${FILE_PLUMBING_MAX_FILE_BYTES}-byte file plumbing cap`,
          { filePath: typeof filePath === 'string' ? filePath : undefined, maxBytes: FILE_PLUMBING_MAX_FILE_BYTES, actualBytes: serializedBytes }
        );
      }
      const writeResult = this.writeFile(outputRef, serialized, {
        ...options,
        callerAgentId: (options.callerAgentId ?? undefined) as string | undefined
      });
      const receipt: QueryJsonOutputReceipt = {
        success: true,
        path: writeResult.path,
        workspaceId: writeResult.workspaceId,
        output_file: outputRef,
        bytes_written: writeResult.size,
        lines_written: writeResult.linesWritten,
        truncated: false,
        message: `Query result written to '${writeResult.path}' (${writeResult.size} bytes).`
      };
      return receipt;
    }

    if (options && options.raw === true) {
      return result;
    }

    const budgetLimit = typeof options?.budgetBytes === 'number' ? options.budgetBytes : 1500;
    const outputStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (outputStr === undefined) {
      return result;
    }

    const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const byteLength = encoder ? encoder.encode(outputStr).length : Buffer.byteLength(outputStr, 'utf8');

    if (byteLength > budgetLimit) {
      if (options?.structured === true && result !== null && typeof result === 'object') {
        const structRes = truncateStructuredJson(result, budgetLimit);
        if (structRes.truncated) {
          const totalLines = outputStr.split(/\r?\n/).length;
          return {
            total_bytes: byteLength,
            total_lines: totalLines,
            totalBytes: byteLength,
            totalLines: totalLines,
            truncated: true,
            content: structRes.content,
            nextOffset: structRes.nextOffset,
            remainingBytes: structRes.remainingBytes,
            notice: structRes.notice
          };
        }
      }

      const truncatedContent = outputStr.slice(0, budgetLimit);
      const totalLines = outputStr.split(/\r?\n/).length;
      const contentLines = truncatedContent.split(/\r?\n/).length;
      return {
        total_bytes: byteLength,
        total_lines: totalLines,
        totalBytes: byteLength,
        totalLines: totalLines,
        truncated: true,
        content: truncatedContent,
        nextOffset: budgetLimit,
        nextLine: contentLines + 1,
        remainingBytes: Math.max(0, byteLength - budgetLimit),
        notice: `Output truncated at ${budgetLimit.toLocaleString()} bytes.`
      };
    }

    return result;
  }

  /**
   * Pure-JS jq-compatible in-place JSON transformer.
   *
   * Invariants:
   * 1. Reads and parses the target JSON file (throws if missing or invalid).
   * 2. Applies the jq transform filter and writes the serialized result back to the same path.
   *
   * @param filePath - Path to JSON file.
   * @param filter - jq transform filter (defaults to '.').
   * @param options - Transform options and security context.
   * @returns Transform receipt with written byte and line counts.
   * @throws If file does not exist (`FILE_NOT_FOUND`).
   * @throws If write access is denied (`PERMISSION_DENIED`).
   * @throws `Error` - If the target file is not valid JSON.
   *
   * @example
   * ```typescript
   * const receipt = virtualFs.transformJson('/data/state.json', '.counter += 1', {
   *   workspaceId: 'global'
   * });
   * console.log(receipt.bytes_written);
   * ```
   */
  transformJson(params: TransformJsonParams, context?: VirtualFsCallContext): TransformJsonReceipt;

  /**
   * Positional transform form: `transformJson(filePath, filter?, options?)`.
   */
  transformJson(filePath: string, filter?: string, options?: TransformJsonOptions): TransformJsonReceipt;

  /**
   * Positional transform form with options in the second position: `transformJson(filePath, options)`.
   */
  transformJson(filePath: string, options: TransformJsonOptions): TransformJsonReceipt;

  transformJson(arg1: string | TransformJsonParams, arg2?: unknown, arg3?: unknown): TransformJsonReceipt {
    arg1 = normalizeCanonicalParams(arg1);
    let filePath, jqTransformFilter, workspaceId, callerAgentId, options: ResolvedCallOptions;
    if (typeof arg1 === 'object' && arg1 !== null) {
      filePath = arg1.filePath || arg1.path;
      jqTransformFilter = arg1.filter !== undefined ? arg1.filter : (arg1.jqTransformFilter || '.');
      workspaceId = arg1.workspaceId || arg1.workspace_id;
      callerAgentId = arg1.callerAgentId;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (filePath, filter, options)
      filePath = arg1;
      jqTransformFilter = typeof arg2 === 'string' ? arg2 : '.';
      const trusted = typeof arg3 === 'object' && arg3 !== null ? arg3 : (typeof arg2 === 'object' && arg2 !== null ? arg2 : {});
      options = resolvePositionalCallOptions(trusted);
      workspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    const targetWs = options.workspaceId || options.workspace_id || workspaceId;
    const effectiveCallerId = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const rawContent = this.readFile(filePath as string, {
      ...options,
      ...(targetWs ? { workspaceId: targetWs } : {}),
      callerAgentId: effectiveCallerId as string | undefined,
      raw: true
    });
    let parsed;
    try {
      parsed = JSON.parse(rawContent);
    } catch (parseError) {
      throw new Error(`Failed to parse JSON file '${filePath}' in workspace '${publicWorkspaceKey(targetWs || 'global')}': ${errorMessage(parseError)}`);
    }

    const transformed = transformJq(parsed, jqTransformFilter);
    const jsonString = JSON.stringify(transformed, null, 2);

    const writeResult = this.writeFile(filePath as string, jsonString, {
      ...options,
      ...(targetWs ? { workspaceId: targetWs } : {}),
      callerAgentId: effectiveCallerId as string | undefined,
      readOnly: false
    });

    const linesWritten = jsonString.split(/\r?\n/).length;
    return {
      success: true,
      path: writeResult.path,
      workspaceId: writeResult.workspaceId,
      bytes_written: writeResult.size,
      lines_written: linesWritten,
      message: `File '${writeResult.path}' successfully transformed (${writeResult.size} bytes).`,
      size: writeResult.size,
      owner: writeResult.owner,
      readOnly: writeResult.readOnly,
      updatedAt: writeResult.updatedAt
    };
  }

  /**
   * Checks if a file exists at the given path in the resolved workspace without throwing `FileNotFoundError`.
   *
   * @param filePath - Virtual path.
   * @param options - Security context and workspace routing options.
   * @returns True if file exists and is accessible, false otherwise.
   * @throws If workspace read is unauthorized (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * if (virtualFs.exists('/lore/codex.json', { workspaceId: 'global' })) {
   *   // File is present
   * }
   * ```
   */
  exists(params: ExistsParams, context?: VirtualFsCallContext): boolean;

  /**
   * Positional existence check: `exists(filePath, options?)`.
   */
  exists(filePath: string, options?: VirtualFsAccessOptions): boolean;

  exists(arg1: string | ExistsParams, arg2?: unknown): boolean {
    arg1 = normalizeCanonicalParams(arg1);
    let workspaceId, filePath, callerAgentId, options: ResolvedCallOptions;
    if (typeof arg1 === 'object' && arg1 !== null) {
      filePath = arg1.filePath || arg1.path;
      workspaceId = arg1.workspaceId || arg1.workspace_id;
      callerAgentId = arg1.callerAgentId;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (filePath, options)
      filePath = arg1;
      const trusted = typeof arg2 === 'object' && arg2 !== null ? arg2 : {};
      options = resolvePositionalCallOptions(trusted);
      workspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    if (!filePath || typeof filePath !== 'string') return false;

    const normPath = normalizeVirtualPath(filePath);
    const effectiveCallerId = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    let target;
    try {
      target = this.#resolveWorkspaceTarget({
        normPath,
        requestedWorkspaceId: options.workspaceId || options.workspace_id || workspaceId,
        callerAgentId: effectiveCallerId,
        options,
        operation: 'read'
      });
    } catch (err) {
      if (err instanceof PermissionDeniedError) {
        throw err;
      }
      return false;
    }

    return Boolean(this.#findWorkspaceFile(this.#workspaces.get(target.workspaceId), target));
  }

  /**
   * Lists files and directories under a virtual path.
   *
   * Invariants:
   * 1. Validates read access to target workspace.
   * 2. If `recursive === false`, aggregates immediate child files and computed virtual subdirectories with `childCount`.
   * 3. If `recursive === true`, returns all descendant file items.
   *
   * @param dirPath - Directory path prefix (defaults to '/').
   * @param options - Listing options and security context.
   * @returns Array of file and directory metadata items.
   * @throws If access to workspace is denied (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const items = virtualFs.listFiles('/lore', {
   *   workspaceId: 'global',
   *   recursive: false
   * });
   * for (const item of items) {
   *   console.log(item.name, item.type, item.size, item.childCount);
   * }
   * ```
   */
  listFiles(params: ListFilesParams, context?: VirtualFsCallContext): FileListItem[];

  /**
   * Positional listing form: `listFiles(dirPath?, options?)`.
   */
  listFiles(dirPath?: string, options?: ListFilesOptions): FileListItem[];

  listFiles(arg1: string | ListFilesParams = '/', arg2?: unknown): FileListItem[] {
    arg1 = normalizeCanonicalParams(arg1);
    let workspaceId, dirPath, callerAgentId, options: ResolvedCallOptions;
    if (typeof arg1 === 'object' && arg1 !== null) {
      workspaceId = arg1.workspaceId || arg1.workspace_id;
      dirPath = arg1.directory_path || arg1.directoryPath || arg1.dirPath || arg1.dir_path || arg1.path || '/';
      callerAgentId = arg1.callerAgentId || arg1.caller_agent_id;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (dirPath, options)
      dirPath = typeof arg1 === 'string' ? arg1 : '/';
      const trusted = typeof arg2 === 'object' && arg2 !== null ? arg2 : {};
      options = resolvePositionalCallOptions(trusted);
      workspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    const normDir = normalizeVirtualPath(dirPath);
    const effectiveListCallerId = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const target = this.#resolveWorkspaceTarget({
      normPath: normDir,
      requestedWorkspaceId: options.workspaceId || options.workspace_id || workspaceId,
      callerAgentId: effectiveListCallerId,
      options,
      operation: 'read'
    });
    const view = this.#resolveAgentView(options);

    // `/agents` mount directory: a synthetic, root-only listing surface.
    if (target.mountKind === 'agents-root') {
      if (!view.active || !view.crossWorkspace) {
        throw new PermissionDeniedError(
          `Agent '${effectiveListCallerId || 'anonymous'}' is denied read access to mount '${normDir}' (cross-workspace authority required)`,
          { callerAgentId: effectiveListCallerId as string | undefined, filePath: normDir, code: 'PERMISSION_DENIED' }
        );
      }
      const now = Date.now();
      const mounts = this.#visibleMountTargets(view, options).map((mount): FileListEntry => ({
        path: `/agents/${mount.id}`,
        name: mount.id,
        type: 'directory',
        workspaceId: publicWorkspaceKey(mount.id),
        size: 0,
        updatedAt: now,
        readOnly: false,
        owner: 'system',
        childCount: this.#countImmediateChildren(mount.workspaceId)
      }));
      mounts.sort((a, b) => a.path.localeCompare(b.path));
      return mounts;
    }

    const ws = this.#workspaces.get(target.workspaceId) || new Map<string, FileMetadata>();

    const isRecursive = Boolean(options?.recursive);
    let results: FileListEntry[] = [];
    const baseDir = target.storagePath;
    const prefix = baseDir === '/' ? '/' : baseDir + '/';
    const labelFor = (metadata: { workspaceId?: string }): string =>
      target.viewActive ? target.viewLabel : (metadata.workspaceId || target.workspaceId);

    if (isRecursive) {
      for (const [path, metadata] of ws.entries()) {
        if (baseDir === '/' || path === baseDir || path.startsWith(prefix)) {
          const fileName = path.split('/').filter(Boolean).pop() || path;
          results.push({
            path: metadata.path || path,
            name: fileName,
            type: 'file',
            workspaceId: labelFor(metadata),
            size: metadata.size,
            updatedAt: metadata.updatedAt,
            readOnly: Boolean(metadata.readOnly),
            owner: metadata.owner
          });
        }
      }
    } else {
      const directFiles = new Map();
      const directDirs = new Map();

      for (const [path, metadata] of ws.entries()) {
        if (baseDir !== '/' && path !== baseDir && !path.startsWith(prefix)) {
          continue;
        }
        if (path === baseDir) {
          const fileName = path.split('/').filter(Boolean).pop() || path;
          directFiles.set(path, {
            path: metadata.path || path,
            name: fileName,
            type: 'file',
            workspaceId: labelFor(metadata),
            size: metadata.size,
            updatedAt: metadata.updatedAt,
            readOnly: Boolean(metadata.readOnly),
            owner: metadata.owner
          });
          continue;
        }

        const relative = baseDir === '/' ? path.slice(1) : path.slice(prefix.length);
        const segments = relative.split('/');

        if (segments.length === 1) {
          const fileName = segments[0];
          directFiles.set(path, {
            path: metadata.path || path,
            name: fileName,
            type: 'file',
            workspaceId: labelFor(metadata),
            size: metadata.size,
            updatedAt: metadata.updatedAt,
            readOnly: Boolean(metadata.readOnly),
            owner: metadata.owner
          });
        } else {
          const subDirName = segments[0];
          const subDirPath = baseDir === '/' ? `/${subDirName}` : `${baseDir}/${subDirName}`;
          if (!directDirs.has(subDirPath)) {
            directDirs.set(subDirPath, {
              path: subDirPath,
              name: subDirName,
              type: 'directory',
              workspaceId: labelFor(metadata),
              size: 0,
              updatedAt: metadata.updatedAt,
              readOnly: false,
              owner: metadata.owner || 'system',
              childrenSet: new Set([segments[1]])
            });
          } else {
            const dirMeta = directDirs.get(subDirPath);
            dirMeta.childrenSet.add(segments[1]);
            if (metadata.updatedAt > dirMeta.updatedAt) {
              dirMeta.updatedAt = metadata.updatedAt;
            }
          }
        }
      }

      for (const f of directFiles.values()) {
        results.push(f);
      }
      for (const d of directDirs.values()) {
        results.push({
          path: d.path,
          name: d.name,
          type: 'directory',
          workspaceId: d.workspaceId,
          size: 0,
          updatedAt: d.updatedAt,
          readOnly: d.readOnly,
          owner: d.owner,
          childCount: d.childrenSet.size
        });
      }

      // The caller's private root also mounts the synthetic `global/` entry,
      // plus `agents/` for cross-workspace authority holders.
      if (target.viewActive && target.viewOwn && baseDir === '/' && !isRecursive) {
        const now = Date.now();
        results.push({
          path: '/global',
          name: 'global',
          type: 'directory',
          workspaceId: 'global',
          size: 0,
          updatedAt: now,
          readOnly: false,
          owner: 'system',
          childCount: this.#countImmediateChildren(view.scope.globalKey)
        });
        if (view.crossWorkspace) {
          results.push({
            path: '/agents',
            name: 'agents',
            type: 'directory',
            workspaceId: target.viewLabel,
            size: 0,
            updatedAt: now,
            readOnly: false,
            owner: 'system',
            childCount: this.#visibleMountTargets(view, options).length
          });
        }
      }
    }

    // Present view listings at their mount paths (`/global/...`,
    // `/agents/<id>/...`) so entries are directly re-readable through the view.
    // The prefix applies at the mount root too: a `/global` listing returns
    // `/global/<file>` view paths, never storage-relative paths (0a17bdb).
    const mountPrefix = target.viewActive
      ? (target.mountKind === 'shared' ? '/global' : (target.mountKind === 'peer' && target.peerId ? `/agents/${target.peerId}` : ''))
      : '';
    if (mountPrefix) {
      results = results.map((item): FileListEntry => ({ ...item, path: `${mountPrefix}${item.path}` }));
    }

    // Sort by path for predictable determinism
    results.sort((a, b) => a.path.localeCompare(b.path));
    return results;
  }

  /**
   * Removes a file or directory tree from a workspace.
   *
   * Invariants:
   * 1. Validates write permissions for target workspace.
   * 2. If file is `readOnly: true`, throws `PermissionDeniedError` unless caller is the owner or a privileged principal.
   * 3. If `recursive: true`, deletes all files matching directory prefix.
   * 4. Returns `true` if at least one file was removed, `false` if target does not exist.
   *
   * @param filePath - Virtual path to remove.
   * @param options - Deletion options.
   * @returns True if file(s) removed, false if not found.
   * @throws If target is read-only and caller is unauthorized (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const deleted = virtualFs.deleteFile('/scratch/temp.txt', {
   *   workspaceId: 'agent_1',
   *   callerAgentId: 'agent_1'
   * });
   * ```
   */
  deleteFile(params: DeleteFileParams, context?: VirtualFsCallContext): boolean;

  /**
   * Positional delete form: `deleteFile(filePath, options?)`.
   */
  deleteFile(filePath: string, options?: DeleteFileOptions): boolean;

  deleteFile(arg1: string | DeleteFileParams, arg2?: unknown): boolean {
    arg1 = normalizeCanonicalParams(arg1);
    let workspaceId, filePath, callerAgentId, options: ResolvedCallOptions;

    if (typeof arg1 === 'object' && arg1 !== null) {
      filePath = arg1.filePath || arg1.file_path || arg1.path;
      workspaceId = arg1.workspaceId || arg1.workspace_id;
      callerAgentId = arg1.callerAgentId || arg1.caller_agent_id;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (filePath, options)
      filePath = arg1;
      const trusted = typeof arg2 === 'object' && arg2 !== null ? arg2 : {};
      options = resolvePositionalCallOptions(trusted);
      workspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    const normPath = normalizeVirtualPath(filePath);
    const effectiveDeleteCallerId = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const actualCaller = effectiveDeleteCallerId;
    const isAdmin = this.#isPrivilegedPrincipal(actualCaller, options);
    const target = this.#resolveWorkspaceTarget({
      normPath,
      requestedWorkspaceId: options.workspaceId || options.workspace_id || workspaceId,
      callerAgentId: effectiveDeleteCallerId,
      options,
      operation: 'delete'
    });
    const effectiveWorkspaceId = target.workspaceId;

    const ws = this.#workspaces.get(effectiveWorkspaceId);
    if (!ws) {
      if (options?.throwIfNotFound) {
        throw new FileNotFoundError(
          `File '${normPath}' not found in workspace '${effectiveWorkspaceId}'`,
          { workspaceId: effectiveWorkspaceId, filePath: normPath }
        );
      }
      return false;
    }
    const lookupPaths = target.lookupPaths;
    const existingKey = lookupPaths.find((candidate) => candidate !== '/' && ws.has(candidate));

    // Find child keys if this path represents a directory
    const childKeys: string[] = [];
    if (ws) {
      const dirPrefixes = lookupPaths
        .filter((candidate) => candidate && candidate !== '/')
        .map((candidate) => candidate + '/');
      if (normPath === '/') dirPrefixes.push('/');
      for (const k of ws.keys()) {
        if (lookupPaths.includes(k)) continue;
        if (dirPrefixes.some((dirPrefix) => k.startsWith(dirPrefix))) {
          childKeys.push(k);
        }
      }
    }

    if (childKeys.length > 0) {
      if (options?.recursive !== true) {
        throw new Error(`Directory '${normPath}' is not empty; specify recursive: true to delete`);
      }
      const allKeysToDelete = existingKey ? [...new Set([existingKey, ...childKeys])] : childKeys;
      for (const k of allKeysToDelete) {
        const fileMeta = ws.get(k);
        if (fileMeta && fileMeta.readOnly) {
          if (this.#isSharedGlobalWorkspace(effectiveWorkspaceId)) {
            const isOwner = actualCaller && (actualCaller === fileMeta.owner || isAdmin);
            if (!isOwner) {
              throw new PermissionDeniedError(
                `Cannot delete read-only file '${fileMeta.path || k}' in global workspace (owned by '${fileMeta.owner || 'system'}')`,
                { workspaceId: effectiveWorkspaceId, callerAgentId: actualCaller, filePath: fileMeta.path || k, code: 'PERMISSION_DENIED' }
              );
            }
          } else {
            if (!isAdmin && !options?.force) {
              throw new PermissionDeniedError(
                `Cannot delete read-only file '${fileMeta.path || k}' in workspace '${effectiveWorkspaceId}' (file is set to read-only; modify permissions first)`,
                { workspaceId: effectiveWorkspaceId, callerAgentId: actualCaller, filePath: fileMeta.path || k, code: 'PERMISSION_DENIED' }
              );
            }
          }
        }
      }
      for (const k of allKeysToDelete) {
        ws.delete(k);
      }
      return true;
    }

    if (!existingKey) {
      if (options?.throwIfNotFound) {
        throw new FileNotFoundError(
          `File '${normPath}' not found in workspace '${effectiveWorkspaceId}'`,
          { workspaceId: effectiveWorkspaceId, filePath: normPath }
        );
      }
      return false;
    }

    const existing = ws.get(existingKey);
    if (existing && existing.readOnly) {
      if (this.#isSharedGlobalWorkspace(effectiveWorkspaceId)) {
        const isOwner = actualCaller && (actualCaller === existing.owner || isAdmin);
        if (!isOwner) {
          throw new PermissionDeniedError(
            `Cannot delete read-only file '${normPath}' in global workspace (owned by '${existing.owner || 'system'}')`,
            { workspaceId: effectiveWorkspaceId, callerAgentId: actualCaller, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
      } else {
        if (!isAdmin && !options?.force) {
          throw new PermissionDeniedError(
            `Cannot delete read-only file '${normPath}' in workspace '${effectiveWorkspaceId}' (file is set to read-only; modify permissions first)`,
            { workspaceId: effectiveWorkspaceId, callerAgentId: actualCaller, filePath: normPath, code: 'PERMISSION_DENIED' }
          );
        }
      }
    }

    return ws.delete(existingKey);
  }

  /**
   * Searches file contents using string literal or regular expression matching.
   *
   * Invariants:
   * Scans readable files in the workspace, finds matching lines, and returns 1-indexed line snippets up to `maxMatches` (default 100).
   *
   * @param pattern - String literal or RegExp pattern to find.
   * @param pathPrefix - Subdirectory scope (defaults to '/').
   * @param options - Grep options.
   * @returns Array of search hit match items.
   * @throws If workspace read access is denied (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const matches = virtualFs.grep('TODO', '/src', {
   *   workspaceId: 'global',
   *   caseInsensitive: true
   * });
   * matches.forEach(m => console.log(`${m.filePath}:${m.lineNumber} - ${m.lineContent}`));
   * ```
   */
  grep(params: GrepParams, context?: VirtualFsCallContext): GrepMatch[];

  /**
   * Positional grep form: `grep(pattern, pathPrefix?, options?)`.
   */
  grep(pattern: string | RegExp, pathPrefix?: string, options?: GrepOptions): GrepMatch[];

  /**
   * Positional grep form with options in the second position: `grep(pattern, options)`.
   */
  grep(pattern: string | RegExp, options: GrepOptions): GrepMatch[];

  grep(arg1: string | RegExp | GrepParams, arg2?: unknown, arg3?: unknown): GrepMatch[] {
    arg1 = normalizeCanonicalParams(arg1);
    let workspaceId, pattern, callerAgentId, pathPrefix, options: ResolvedCallOptions;

    if (typeof arg1 === 'object' && arg1 !== null && !(arg1 instanceof RegExp)) {
      workspaceId = arg1.workspaceId || arg1.workspace_id;
      pattern = arg1.pattern !== undefined ? arg1.pattern : (arg1.query !== undefined ? arg1.query : '');
      pathPrefix = arg1.pathPrefix || arg1.path || arg1.dirPath || '/';
      callerAgentId = arg1.callerAgentId || arg1.caller_agent_id;
      options = resolveObjectCallOptions(arg1, arg2, callerAgentId);
    } else {
      // Canonical positional: (pattern, pathPrefix, options) or (pattern, options)
      pattern = arg1;
      if (typeof arg2 === 'string') {
        pathPrefix = arg2;
        const trusted = typeof arg3 === 'object' && arg3 !== null ? arg3 : {};
        options = resolvePositionalCallOptions(trusted);
      } else {
        const trusted = typeof arg2 === 'object' && arg2 !== null ? arg2 : {};
        options = resolvePositionalCallOptions(trusted);
        pathPrefix = options.pathPrefix || options.path || options.dirPath || '/';
      }
      workspaceId = options.workspaceId || options.workspace_id;
      callerAgentId = options.callerAgentId || options.caller_agent_id;
    }

    const normPathPrefix = normalizeVirtualPath(pathPrefix);
    const actualCaller = options.callerAgentId !== undefined ? options.callerAgentId : callerAgentId;
    const isAdmin = this.#isPrivilegedPrincipal(actualCaller, options);
    const realmScope = this.#resolveRealmScope(actualCaller, options);
    const view = this.#resolveAgentView(options);
    if (view.unresolved) {
      // A trusted caller identity that does not resolve (unresolvable canonical
      // key, or a bare id shared by several realms without a `callerKey`) fails
      // the scan closed (Wave I, ticket d57cbc1).
      throw new PermissionDeniedError(
        `Agent '${view.callerId || 'anonymous'}' is denied read access (unresolvable caller identity)`,
        { callerAgentId: view.callerId, filePath: normPathPrefix, code: 'PERMISSION_DENIED' }
      );
    }
    const requestedWorkspace = options.workspaceId || options.workspace_id || workspaceId;
    const maxMatches = typeof options?.maxMatches === 'number' ? options.maxMatches : 100;
    // In the workspace view, the path prefix selects the mount (mirroring every
    // other member); otherwise the prefix is a plain in-workspace filter.
    let scanPrefix = normPathPrefix;

    let targetPattern = pattern;
    if (typeof pattern === 'string') {
      if (pattern.length > 500) {
        throw new Error('Pattern exceeds maximum allowed length of 500 characters');
      }
      if (options.isRegex) {
        try {
          targetPattern = new RegExp(pattern, options.caseInsensitive ? 'i' : '');
        } catch (e) {
          throw new Error(`Invalid regular expression pattern '${pattern}': ${errorMessage(e)}`);
        }
      } else if (options.caseInsensitive) {
        targetPattern = pattern.toLowerCase();
      }
    }

    const targetWorkspaces: string[] = [];

    if (workspaceId === '*') {
      if (realmScope.realmId) {
        // Realm-confined wildcard: realm-global plus own workspace, plus
        // same-realm member workspaces for cross-workspace authority holders
        // (Realm wave A ticket 49cfc41). Foreign realms are never scanned.
        for (const wsId of this.#workspaces.keys()) {
          if (this.#isWorkspaceInCallerScope(wsId, realmScope, actualCaller, options)) {
            targetWorkspaces.push(wsId);
          }
        }
      } else if (!isAdmin) {
        // Limited to caller's own workspace and the shared global alias
        if (actualCaller && this.#workspaces.has(actualCaller)) targetWorkspaces.push(actualCaller);
        if (this.#workspaces.has(realmScope.globalKey)) targetWorkspaces.push(realmScope.globalKey);
      } else {
        // All workspaces
        for (const wsId of this.#workspaces.keys()) {
          targetWorkspaces.push(wsId);
        }
      }
    } else if (view.active && (!requestedWorkspace || this.#bindingIsOwnWorkspace(view, requestedWorkspace))) {
      // Workspace view: the path prefix selects the mount target.
      const target = this.#resolveWorkspaceTarget({
        normPath: normPathPrefix,
        requestedWorkspaceId: null,
        callerAgentId: actualCaller,
        options,
        operation: 'read'
      });
      if (target.mountKind !== 'agents-root' && this.#workspaces.has(target.workspaceId)) {
        targetWorkspaces.push(target.workspaceId);
        scanPrefix = target.storagePath;
      }
    } else {
      const effectiveWorkspaceId = this.#resolveRequestedWorkspaceKey(workspaceId || 'global', realmScope, actualCaller, options);
      this.#checkWorkspaceAccess(effectiveWorkspaceId, actualCaller, normPathPrefix, 'read', options);
      if (this.#workspaces.has(effectiveWorkspaceId)) {
        targetWorkspaces.push(effectiveWorkspaceId);
      }
    }

    const prefixWithSlash = scanPrefix === '/' ? '/' : scanPrefix + '/';
    const matches: GrepMatch[] = [];

    for (const wsId of targetWorkspaces) {
      const ws = this.#workspaces.get(wsId);
      if (!ws) continue;

      for (const [filePath, fileMeta] of ws.entries()) {
        if (scanPrefix !== '/' && filePath !== scanPrefix && !filePath.startsWith(prefixWithSlash)) {
          continue;
        }

        const lines = fileMeta.content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          let isMatch = false;
          let matchedStr = '';

          if (targetPattern instanceof RegExp) {
            targetPattern.lastIndex = 0;
            const regexRes = targetPattern.exec(line);
            if (regexRes) {
              isMatch = true;
              matchedStr = regexRes[0];
            }
          } else if (options.caseInsensitive) {
            isMatch = line.toLowerCase().includes(targetPattern);
            matchedStr = pattern as string;
          } else {
            isMatch = line.includes(targetPattern);
            matchedStr = String(targetPattern);
          }

          if (isMatch) {
            matches.push({
              filePath,
              workspaceId: view.active ? publicWorkspaceKey(wsId) : wsId,
              lineNumber: i + 1,
              lineContent: line,
              match: matchedStr
            });
            if (matches.length >= maxMatches) {
              return matches;
            }
          }
        }
      }
    }

    return matches;
  }

  /**
   * Returns the current Unix epoch time in seconds and milliseconds without timezone or location
   * data (reads the live wall clock; not a deterministic/frozen value).
   *
   * @returns Object containing seconds and milliseconds timestamps.
   *
   * @example
   * ```typescript
   * const time = virtualFs.getCurrentTime();
   * console.log(`Epoch ms: ${time.epoch_ms}`);
   * ```
   */
  getCurrentTime(): { unix_timestamp: number; epoch_ms: number };

  getCurrentTime() {
    const now = Date.now();
    return {
      unix_timestamp: Math.floor(now / 1000),
      epoch_ms: now
    };
  }

  // Snapshot Persistence
  /**
   * Exports a full serializable snapshot of all workspaces and files for persistence or state dumps.
   *
   * Tenant administration (MOD-21 W8-D): requires a trusted principal and
   * denies anonymous callers before any content is disclosed. Realm boundary
   * (Realm wave A ticket 49cfc41, V11 F1): the snapshot spans every workspace
   * and therefore every realm's bytes, so a realm-bound caller — even one
   * holding cross-workspace `*` authority — is refused outright; only the
   * exact internal principal and `realmBypass` identities export across
   * realms (ungrouped operator descriptors keep the legacy full export).
   *
   * @param options - Principal options (`principal` reference or identity-port caller subject).
   * @returns Serializable snapshot object.
   * @throws If no trusted principal is resolved, or the caller is realm-bound (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const snapshot = virtualFs.exportSnapshot({ principal: internalPrincipal });
   * const json = JSON.stringify(snapshot);
   * ```
   */
  exportSnapshot(options?: VirtualFsAdminOptions): VirtualFsSnapshot;

  exportSnapshot(options: VirtualFsAdminOptions = {}): VirtualFsSnapshot {
    this.#assertTenantAdminAuthority('exportSnapshot', options);
    const callerAgentId = typeof options.callerAgentId === 'string'
      ? options.callerAgentId
      : (typeof options.agentId === 'string' ? options.agentId : undefined);
    if (this.#resolveRealmScope(callerAgentId, options).realmId) {
      // A full snapshot spans every workspace (and therefore every realm's
      // bytes), so a realm-bound caller — even one holding cross-workspace
      // `*` authority — is refused outright, exactly like `reset`; only the
      // trusted operator/internal bypass paths export across realms
      // (Realm wave A ticket 49cfc41, V11 F1).
      throw new PermissionDeniedError(
        'Realm-bound callers are denied exportSnapshot: a full snapshot spans every realm and is an operator-level operation',
        { callerAgentId, code: 'PERMISSION_DENIED' }
      );
    }
    const snapshot: VirtualFsSnapshot = {};
    for (const [wsId, wsMap] of this.#workspaces.entries()) {
      snapshot[wsId] = {};
      for (const [filePath, metadata] of wsMap.entries()) {
        snapshot[wsId][filePath] = {
          path: metadata.path,
          workspaceId: metadata.workspaceId,
          content: metadata.content,
          size: metadata.size,
          updatedAt: metadata.updatedAt,
          readOnly: metadata.readOnly,
          owner: metadata.owner
        };
      }
    }
    return structuredClone ? structuredClone(snapshot) : JSON.parse(JSON.stringify(snapshot));
  }

  /**
   * Restores workspaces and files from a serialized snapshot object.
   *
   * Tenant administration (MOD-21 W8-D): requires a trusted principal and
   * denies anonymous callers before the existing state is cleared.
   *
   * @param snapshot - Serialized snapshot object.
   * @param options - Principal options (`principal` reference or identity-port caller subject).
   * @throws If no trusted principal is resolved (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * virtualFs.importSnapshot(snapshot, { principal: internalPrincipal });
   * ```
   */
  importSnapshot(snapshot: VirtualFsSnapshot, options?: VirtualFsAdminOptions): void;

  importSnapshot(snapshot: VirtualFsSnapshot, options: VirtualFsAdminOptions = {}): void {
    this.#assertTenantAdminAuthority('importSnapshot', options);
    this.reset(options);
    if (!snapshot || typeof snapshot !== 'object') return;

    for (const [wsId, files] of Object.entries(snapshot)) {
      if (!files || typeof files !== 'object') continue;
      // SEC-12: Reject prototype pollution keys and invalid workspace IDs
      if (wsId === '__proto__' || wsId === 'constructor' || wsId === 'prototype') continue;
      if (typeof wsId !== 'string' || !wsId.trim()) continue;

      const cleanWsId = wsId.trim();
      const ws = this.#getOrCreateWorkspace(cleanWsId);
      for (const [filePath, meta] of Object.entries(files)) {
        if (!meta || typeof meta !== 'object') continue;
        if (filePath === '__proto__' || filePath === 'constructor' || filePath === 'prototype') continue;
        const rawPath = filePath || meta.path;
        if (!rawPath || typeof rawPath !== 'string') continue;
        const normPath = normalizeVirtualPath(rawPath);
        if (!normPath || normPath.includes('..')) continue;

        // Enforce private workspace ownership integrity (SEC-12)
        let owner = meta.owner;
        if (cleanWsId !== 'global') {
          owner = cleanWsId; // Private workspace files are strictly owned by that workspace/agent
        } else {
          owner = (typeof owner === 'string' && owner.trim()) ? owner.trim() : 'system';
        }

        ws.set(normPath, {
          path: normPath,
          workspaceId: cleanWsId,
          content: typeof meta.content === 'string' ? meta.content : '',
          size: typeof meta.size === 'number' ? meta.size : (meta.content ? meta.content.length : 0),
          updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : Date.now(),
          readOnly: Boolean(meta.readOnly),
          owner
        });
      }
    }
  }

  /**
   * Remaps this instance's legacy bare-id private workspaces onto their
   * canonical identity keys, in memory, without data loss (Wave I, ticket
   * d57cbc1).
   *
   * Store hydration seam: after `restoreRuntimeEnvironment` has restored the
   * VFS snapshot and registered the agents, the store calls this once with a
   * resolver that maps a bare workspace key to its agent identity projection.
   * The store must resolve per record scope
   * (`identityPort.getAgentIdentity(id, { realmId: record.config.realmId })`)
   * because the same literal id may exist in several realms (`getAgentIdentity(id)`
   * alone fails closed on an ambiguous id). The pure
   * {@link remapLegacyWorkspaceKeys} helper covers the same contract for a
   * snapshot that has not been imported yet.
   *
   * Only workspace keys that are not reserved, not already canonical, and
   * resolve to a realm-qualified (or pinned) private workspace key are
   * renamed; every record is preserved and a path already present under the
   * canonical key is reported as a conflict (the canonical copy wins).
   *
   * @param resolveProjection - Trusted resolver from a bare workspace key to its identity projection.
   * @param options - Principal options; tenant administration default-denies anonymous callers.
   * @returns The rename report (`from`, `to`, `mergedConflictPaths`).
   *
   * @example
   * ```typescript
   * const port = runtime.createAgentIdentityPort();
   * virtualFs.rekeyLegacyPrivateWorkspaces(
   *   (id) => port.getAgentIdentity(id, { realmId: runtime.getAgent(id)?.config.realmId ?? null }),
   *   { principal: runtime.getOperatorPrincipal() }
   * );
   * ```
   */
  rekeyLegacyPrivateWorkspaces(
    resolveProjection: (bareId: string) => VirtualFsIdentityProjection | null | undefined,
    options?: VirtualFsAdminOptions
  ): Array<{ from: string; to: string; mergedConflictPaths: string[] }>;

  rekeyLegacyPrivateWorkspaces(
    resolveProjection: (bareId: string) => VirtualFsIdentityProjection | null | undefined,
    options: VirtualFsAdminOptions = {}
  ): Array<{ from: string; to: string; mergedConflictPaths: string[] }> {
    this.#assertTenantAdminAuthority('rekeyLegacyPrivateWorkspaces', options);
    const remapped: Array<{ from: string; to: string; mergedConflictPaths: string[] }> = [];
    for (const [key, ws] of Array.from(this.#workspaces.entries())) {
      const canonical = legacyWorkspaceRemapTarget(key, resolveProjection);
      if (!canonical) continue;
      const target = this.#getOrCreateWorkspace(canonical);
      const mergedConflictPaths: string[] = [];
      for (const [filePath, record] of Array.from(ws.entries())) {
        if (target.has(filePath)) {
          mergedConflictPaths.push(filePath);
          continue;
        }
        target.set(filePath, { ...record, workspaceId: canonical });
      }
      this.#workspaces.delete(key);
      remapped.push({ from: key, to: canonical, mergedConflictPaths });
    }
    return remapped;
  }

  // Scoped Accessor
  /**
   * Creates a scoped proxy bound to a specific agent identity for automated tenant routing.
   *
   * Tenant administration (MOD-21 W8-D): minting a proxy for a claimed agent id
   * requires a trusted principal; non-privileged and anonymous callers
   * default-deny. The proxy itself confers no authority of its own.
   *
   * @param agentId - Agent identifier.
   * @param options - Agent role plus principal options (`principal` reference or identity-port caller subject); a bare role string confers no authority.
   * @returns Scoped proxy interface.
   * @throws If no trusted principal is resolved (`PERMISSION_DENIED`).
   *
   * @example
   * ```typescript
   * const agentFs = virtualFs.forAgent('writer_1', { role: 'writer', principal: internalPrincipal });
   * agentFs.writeFile('/story.md', '# Chapter 1');
   * ```
   */
  forAgent(agentId: string, options?: ({ role?: string } & VirtualFsAdminOptions) | string): AgentFsProxy;

  forAgent(agentId: string, options: string | ({ role?: string } & VirtualFsAdminOptions) = {}): AgentFsProxy {
    if (!agentId) {
      throw new Error('agentId is required for forAgent()');
    }
    const opts: { role?: string } & VirtualFsAdminOptions = typeof options === 'string' ? { role: options } : (options || {});
    this.#assertTenantAdminAuthority('forAgent', opts);
    const callerAgentId = typeof opts.callerAgentId === 'string'
      ? opts.callerAgentId
      : (typeof opts.agentId === 'string' ? opts.agentId : undefined);
    const scope = this.#resolveRealmScope(callerAgentId, opts);
    if (scope.realmId && !this.#isWorkspaceInCallerScope(agentId, scope, callerAgentId, opts)) {
      // Minting a proxy for a foreign-realm agent would hand the caller that
      // agent's workspace identity; realm-bound callers may only mint proxies
      // for themselves and (with cross-workspace authority) same-realm members
      // (Realm wave A ticket 49cfc41).
      throw new PermissionDeniedError(
        `Agent '${callerAgentId || 'anonymous'}' is denied forAgent '${agentId}' (cross-realm or out-of-realm target)`,
        { callerAgentId, code: 'PERMISSION_DENIED' }
      );
    }
    const role = opts.role;
    // MOD-21 W4: the proxy confers no authority of its own; privilege is a
    // read-only projection of the bound agent's resolved descriptor. Wave I
    // (ticket d57cbc1): the proxy binds the target's canonical identity key
    // when it resolves (host options may also bind it explicitly), so a
    // same-literal-id realm pair stays resolvable through the proxy.
    const boundIdentity = this.#resolveSubjectInScope(agentId, scope);
    const boundKey = boundIdentity && typeof boundIdentity.key === 'string' && boundIdentity.key ? boundIdentity.key : null;
    const baseOpts = {
      callerAgentId: agentId,
      callerRole: role,
      ...(boundKey ? { callerKey: boundKey } : {})
    };
    const isAdmin = this.#isPrivilegedPrincipal(agentId, baseOpts);

    return {
      agentId,
      role,
      isAdmin,
      raw: this,
      writeFile: (filePath: string, content: string | object, options: WriteFileOptions = {}) =>
        this.writeFile(filePath, content, {
          workspaceId: options.workspaceId || agentId,
          ...options,
          ...baseOpts
        }),
      writeGlobal: (filePath: string, content: string | object, options: WriteFileOptions = {}) =>
        this.writeFile(filePath, content, {
          workspaceId: 'global',
          ...options,
          ...baseOpts
        }),
      readFile: ((filePath: string, workspaceIdOrOptions: unknown = agentId, options: ReadFileOptions = {}) => {
        let targetWs: unknown = workspaceIdOrOptions;
        let opt: ReadFileOptions = options;
        if (typeof workspaceIdOrOptions === 'object' && workspaceIdOrOptions !== null) {
          opt = workspaceIdOrOptions as ReadFileOptions;
          targetWs = opt.workspaceId || agentId;
        }
        const callOptions = { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts };
        return opt.raw === true
          ? this.readFile(filePath, callOptions as ReadFileOptions & { raw: true })
          : this.readFile(filePath, callOptions);
      }) as AgentFsProxy['readFile'],
      readGlobal: (filePath: string, options: ReadFileOptions = {}) =>
        this.readFile(filePath, { workspaceId: 'global', ...options, ...baseOpts }),
      exists: (filePath: string, workspaceId: unknown = agentId, options: VirtualFsAccessOptions = {}) => {
        let targetWs: unknown = workspaceId;
        let opt: VirtualFsAccessOptions = options;
        if (typeof workspaceId === 'object' && workspaceId !== null) {
          opt = workspaceId as VirtualFsAccessOptions;
          targetWs = opt.workspaceId || agentId;
        }
        return this.exists(filePath, { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts });
      },
      listFiles: (dirPath: string = '/', workspaceId: unknown = agentId, options: ListFilesOptions = {}) => {
        let targetWs: unknown = workspaceId;
        let opt: ListFilesOptions = options;
        if (typeof workspaceId === 'object' && workspaceId !== null) {
          opt = workspaceId as ListFilesOptions;
          targetWs = opt.workspaceId || agentId;
        }
        return this.listFiles(dirPath, { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts });
      },
      deleteFile: (filePath: string, workspaceId: unknown = agentId, options: DeleteFileOptions = {}) => {
        let targetWs: unknown = workspaceId;
        let opt: DeleteFileOptions = options;
        if (typeof workspaceId === 'object' && workspaceId !== null) {
          opt = workspaceId as DeleteFileOptions;
          targetWs = opt.workspaceId || agentId;
        }
        return this.deleteFile(filePath, { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts });
      },
      queryJson: (filePath: string, jqFilter: string = '.', workspaceId: unknown = agentId, options: QueryJsonOptions = {}) => {
        let targetWs: unknown = workspaceId;
        let opt: QueryJsonOptions = options;
        if (typeof workspaceId === 'object' && workspaceId !== null) {
          opt = workspaceId as QueryJsonOptions;
          targetWs = opt.workspaceId || agentId;
        }
        return this.queryJson(filePath, jqFilter, { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts });
      },
      transformJson: (filePath: string, jqTransformFilter: string = '.', workspaceId: unknown = agentId, options: TransformJsonOptions = {}) => {
        let targetWs: unknown = workspaceId;
        let opt: TransformJsonOptions = options;
        if (typeof workspaceId === 'object' && workspaceId !== null) {
          opt = workspaceId as TransformJsonOptions;
          targetWs = opt.workspaceId || agentId;
        }
        return this.transformJson(filePath, jqTransformFilter, { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts });
      },
      replaceFileContent: (filePath: string, targetContent: string, replacementContent: string, workspaceId: unknown = agentId, options: ReplaceFileContentOptions = {}) => {
        let targetWs: unknown = workspaceId;
        let opt: ReplaceFileContentOptions = options;
        if (typeof workspaceId === 'object' && workspaceId !== null) {
          opt = workspaceId as ReplaceFileContentOptions;
          targetWs = opt.workspaceId || agentId;
        }
        return this.replaceFileContent(filePath, targetContent, replacementContent, { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts });
      },
      writeJson: (filePath: string, data: JsonValue, workspaceId: unknown = agentId, options: WriteJsonOptions = {}) => {
        let targetWs: unknown = workspaceId;
        let opt: WriteJsonOptions = options;
        if (typeof workspaceId === 'object' && workspaceId !== null) {
          opt = workspaceId as WriteJsonOptions;
          targetWs = opt.workspaceId || agentId;
        }
        return this.writeJson(filePath, data, { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts });
      },
      patchJson: (filePath: string, patch: JsonPatchOperation[], workspaceId: unknown = agentId, options: PatchJsonOptions = {}) => {
        let targetWs: unknown = workspaceId;
        let opt: PatchJsonOptions = options;
        if (typeof workspaceId === 'object' && workspaceId !== null) {
          opt = workspaceId as PatchJsonOptions;
          targetWs = opt.workspaceId || agentId;
        }
        return this.patchJson(filePath, patch, { workspaceId: targetWs as string | undefined, ...opt, ...baseOpts });
      },
      concatFiles: (sources: readonly string[], destination: string, options: ConcatFilesOptions = {}) =>
        this.concatFiles(sources, destination, {
          workspaceId: options.workspaceId || agentId,
          ...options,
          ...baseOpts
        }),
      getCurrentTime: () => this.getCurrentTime(),
      copyFile: (srcPath: string, destPath: string, options: CopyFileOptions = {}) =>
        this.copyFile(srcPath, destPath, {
          srcWorkspaceId: options.srcWorkspaceId || options.workspaceId || agentId,
          destWorkspaceId: options.destWorkspaceId || options.workspaceId || agentId,
          ...options,
          ...baseOpts
        }),
      setPermissions: (filePath: string, permissions: PermissionsPayload | boolean | string, options: SetPermissionsOptions = {}) =>
        this.setPermissions(filePath, permissions, {
          workspaceId: options.workspaceId || agentId,
          ...options,
          ...baseOpts
        }),
      grep: (pattern: string | RegExp, pathPrefix: unknown = '/', options: GrepParams = {}) => {
        let prefix: unknown = pathPrefix;
        let opt: GrepParams = options;
        if (typeof pathPrefix === 'object' && pathPrefix !== null) {
          opt = pathPrefix as GrepParams;
          prefix = opt.pathPrefix || opt.path || '/';
        }
        return this.grep(pattern, prefix as string, {
          workspaceId: opt.workspaceId || agentId,
          ...opt,
          ...baseOpts
        });
      },
      getFileRecord: (filePath: string, options: VirtualFsAccessOptions = {}) =>
        this.getFileRecord(filePath, {
          workspaceId: options.workspaceId || agentId,
          ...options,
          ...baseOpts
        })
    };
  }
}

/**
 * Resolves placeholders and inlines virtual filesystem content and variables into agent prompt templates.
 *
 * With a `template` string, `{{file:/path}}`, `{{/path}}` and `<file path="..."/>` directives plus
 * `files`/`variables` keys are expanded. With `template` omitted or `null` and `options.filePath`
 * set, direct-file mode returns that file's content verbatim; a `template` and `filePath` together
 * silently ignore `filePath`.
 *
 * @param template - Template string with placeholder tokens (e.g. '\{\{LORE\}\}'), or `null`/omitted to read `options.filePath` directly.
 * @param options - Rendering and resolution options.
 * @returns Success envelope with rendered prompt and inlining metadata, or a `{ success: false, error, code }` failure envelope when an inlined file read fails.
 *
 * @example
 * ```typescript
 * const rendered = renderTemplateWithFiles('Story Context:\n{{WORLD}}\nProtagonist: {{hero}}', {
 *   virtualFs,
 *   files: { WORLD: '/lore/world.md' },
 *   variables: { hero: 'Aria' },
 *   workspaceId: 'global'
 * });
 * if (rendered.success) console.log(rendered.renderedPrompt);
 * ```
 */
export function renderTemplateWithFiles(template: string | null | undefined, options: RenderTemplateOptions): RenderTemplateResult;
export function renderTemplateWithFiles(template: unknown, options: Partial<RenderTemplateOptions> = {}): RenderTemplateResult {
  const {
    virtualFs,
    filePath,
    files = {},
    variables = {},
    workspaceId = 'global',
    callerAgentId,
    fsOpts = {}
  } = options;

  if (!virtualFs) {
    throw new Error('virtualFs instance is required for renderTemplateWithFiles');
  }
  const vfs = virtualFs;

  const inlinedFiles: Array<{ placeholder: string; filePath: string; workspaceId: string; bytesInlined: number }> = [];
  const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

  function readFileContent(pathInput: string, defaultWs?: string) {
    let targetWs = defaultWs || workspaceId || 'global';
    let rawPath = String(pathInput).trim();

    if (rawPath.includes(':') && !rawPath.startsWith('/')) {
      const idx = rawPath.indexOf(':');
      targetWs = rawPath.slice(0, idx);
      rawPath = rawPath.slice(idx + 1);
    }

    const normPath = normalizeVirtualPath(rawPath);
    if (normPath.startsWith('/global/') || normPath.startsWith('/public/')) {
      targetWs = 'global';
    }

    const readOptions = {
      ...fsOpts,
      callerAgentId: callerAgentId || fsOpts.callerAgentId,
      raw: true
    };

    const content = vfs.readFile({
      ...readOptions,
      filePath: normPath,
      workspaceId: targetWs,
      callerAgentId: callerAgentId || readOptions.callerAgentId
    });
    const stringContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const bytes = encoder ? encoder.encode(stringContent).length : Buffer.byteLength(stringContent, 'utf8');

    return {
      path: normPath,
      workspaceId: targetWs,
      content: stringContent,
      bytes
    };
  }

  try {
    let result = '';

    if (template === null || template === undefined) {
      if (filePath) {
        const fileInfo = readFileContent(filePath, workspaceId);
        inlinedFiles.push({
          placeholder: `(direct:${filePath})`,
          filePath: fileInfo.path,
          workspaceId: fileInfo.workspaceId,
          bytesInlined: fileInfo.bytes
        });
        result = fileInfo.content;
      } else if (files && typeof files === 'object' && Object.keys(files).length > 0) {
        const sections: string[] = [];
        for (const [key, p] of Object.entries(files)) {
          const fileInfo = readFileContent(p, workspaceId);
          inlinedFiles.push({
            placeholder: `{{${key}}}`,
            filePath: fileInfo.path,
            workspaceId: fileInfo.workspaceId,
            bytesInlined: fileInfo.bytes
          });
          sections.push(`<!-- FILE: ${fileInfo.path} (${key}) -->\n${fileInfo.content}`);
        }
        result = sections.join('\n\n');
      } else {
        result = '';
      }
    } else {
      result = String(template);

      // 1. Replace explicit variables: {{varName}} or {{variables.varName}}
      if (variables && typeof variables === 'object') {
        for (const [vKey, vVal] of Object.entries(variables)) {
          const valStr = typeof vVal === 'object' && vVal !== null ? JSON.stringify(vVal, null, 2) : String(vVal);
          const safeKey = escapeRegExp(vKey);
          const rx1 = new RegExp(`\\{\\{\\s*variables\\.${safeKey}\\s*\\}\\}`, 'g');
          const rx2 = new RegExp(`\\{\\{\\s*${safeKey}\\s*\\}\\}`, 'g');
          result = result.replace(rx1, valStr).replace(rx2, valStr);
        }
      }

      // 2. Replace mapped files: {{files.fileKey}} or {{fileKey}}
      if (files && typeof files === 'object') {
        for (const [fKey, fPath] of Object.entries(files)) {
          const fileInfo = readFileContent(fPath, workspaceId);
          inlinedFiles.push({
            placeholder: `{{${fKey}}}`,
            filePath: fileInfo.path,
            workspaceId: fileInfo.workspaceId,
            bytesInlined: fileInfo.bytes
          });
          const safeKey = escapeRegExp(fKey);
          const rx1 = new RegExp(`\\{\\{\\s*files\\.${safeKey}\\s*\\}\\}`, 'g');
          const rx2 = new RegExp(`\\{\\{\\s*${safeKey}\\s*\\}\\}`, 'g');
          result = result.replace(rx1, fileInfo.content).replace(rx2, fileInfo.content);
        }
      }

      // 3. Replace inline file directives: {{file:/path}} or {{file:workspaceId:/path}}
      result = result.replace(/\{\{\s*file:\s*([^}]+)\s*\}\}/g, (match, pathDirective) => {
        const fileInfo = readFileContent(pathDirective, workspaceId);
        inlinedFiles.push({
          placeholder: match,
          filePath: fileInfo.path,
          workspaceId: fileInfo.workspaceId,
          bytesInlined: fileInfo.bytes
        });
        return fileInfo.content;
      });

      // 4. Replace path directives: {{/path/to/file.ext}}
      result = result.replace(/\{\{\s*(\/[a-zA-Z0-9_./-]+)\s*\}\}/g, (match, rawPath) => {
        if (rawPath.includes('/') && (rawPath.includes('.') || rawPath.split('/').length > 2)) {
          const fileInfo = readFileContent(rawPath, workspaceId);
          inlinedFiles.push({
            placeholder: match,
            filePath: fileInfo.path,
            workspaceId: fileInfo.workspaceId,
            bytesInlined: fileInfo.bytes
          });
          return fileInfo.content;
        }
        return match;
      });

      // 5. Replace XML style directives: <file path="/path" /> or <include file="/path" />
      result = result.replace(/<(?:file|include)\s+(?:path|file)=["']([^"']+)["']\s*(?:\/>|><\/(?:file|include)>)/g, (match, pathDirective) => {
        const fileInfo = readFileContent(pathDirective, workspaceId);
        inlinedFiles.push({
          placeholder: match,
          filePath: fileInfo.path,
          workspaceId: fileInfo.workspaceId,
          bytesInlined: fileInfo.bytes
        });
        return fileInfo.content;
      });
    }

    const totalBytes = encoder ? encoder.encode(result).length : Buffer.byteLength(result, 'utf8');
    const wordsCount = countWords(result);

    return {
      success: true,
      content: result,
      renderedPrompt: result,
      inlinedFiles,
      totalBytes,
      wordsCount
    };
  } catch (err) {
    return {
      success: false,
      error: errorMessage(err) || String(err),
      code: errorName(err) || 'INLINE_ERROR'
    };
  }
}
