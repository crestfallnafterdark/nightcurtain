/**
 * @packageDocumentation
 * Module `tools/constants`.
 * Master tool constants, canonical tool enumerations, innate tool collections,
 * standardized machine-readable error codes, and capability preset definitions for the Sandbox Tool System.
 *
 * @module tools/constants
 * @invariant Leaf: zero imports (including type-only); all exports are deterministic with no import-time side effects, and `TOOL_SYSTEM_ERROR_CODES`, `SANDBOX_TOOLS`, `INNATE_TOOLS`, `TOOL_PRESETS`, and every nested preset array are frozen.
 * @invariant Canonical taxonomy: `SANDBOX_TOOLS` enumerates exactly 35 unique `snake_case` tool names grouped across 7 substrate domains — VFS (12), messaging/mailbox (8), agent lifecycle (5), synchronous invocation (2), runtime scheduler (3), world clock & events (3), precall & reflection (2).
 * @invariant Innate baseline primitives: `INNATE_TOOLS` is the frozen four-name list — `whoami`, `get_current_time`, `describe_tool`, `batch_precall` — augmented with a non-enumerable `has()` lookup.
 * @invariant Frozen error-code dictionary: `TOOL_SYSTEM_ERROR_CODES` freezes the canonical machine-readable codes (`TOOL_NOT_FOUND`, `PERMISSION_DENIED`, `INVALID_ARGUMENTS`, `SERVICE_UNAVAILABLE`, `PRECALL_FORBIDDEN`, `EXECUTION_FAILED`, `AGENT_ALREADY_EXISTS`); the dispatcher's universal error shield constrains every emitted failure receipt to this vocabulary, normalizing downstream subsystem codes outside it to `EXECUTION_FAILED`.
 * @invariant Tool-family taxonomy: `TOOL_FAMILIES` declares exactly one primary family — from the frozen 11-family vocabulary (`vfs.read`, `vfs.write`, `messaging.send`, `mailbox.read`, `mailbox.consume`, `lifecycle`, `invocation`, `scheduler`, `clock`, `world`, `precall`) — for every canonical `SANDBOX_TOOLS` entry; `FAMILY_TIER_PLAN` maps each family to its named tiers, and `TOOL_TIER_EXPOSURE` carries the explicit never/override decisions (an absent tool defaults to `'family'`).
 * @invariant Retired-selector window: `RETIRED_TOOL_SELECTORS` freezes the canonical `subagent_management` selector expansion (`spawn_agent`, `kill_agent`, `invoke_agent`, `undo_turn`, fixed legacy order), and `expandRetiredToolSelector` is a pure fail-closed lookup keyed by the canonical selector id only — spellings resolve through the alias normalizer.
 * @invariant Capability tiers: exactly five presets (`all`, `manager`, `collaborator`, `readonly_collaborator`, `readonly`), each a frozen string array; `all` is exactly `['*']`. The named tiers are generated once from the family taxonomy (innate baseline + `FAMILY_TIER_PLAN`/`TOOL_TIER_EXPOSURE`, canonical declaration order, duplicate-free) — no hand-enumerated member list exists, no tier carries the retired `subagent_management` selector, and every `INNATE_TOOLS` primitive (including `describe_tool`) is a member of every named tier. `includeReflection: false` still removes `describe_tool` from emitted schemas without changing tier membership.
 * @invariant Preset values are allowlist strings only: no execution-context or infrastructure configuration (model, provider, temperature, privilege/whitelist flags) is represented in the preset definitions.
 * @invariant Mutation-capability vocabulary: `MUTATING_TOOLS` and `READ_ONLY_TOOLS` partition every canonical `SANDBOX_TOOLS` entry exactly once (disjoint, union = the 35-name canonical set) as frozen arrays in canonical declaration order, and `isMutatingTool` is a pure membership probe over that vocabulary. The clock/event tools (`world_clock`, `event_list`) classify as mutating because they step simulation time and mutate VFS-backed event registries.
 * @invariant Publishing-tool vocabulary: `PUBLISHING_TOOLS` freezes the two publishing tool names (`import_realm_template`, `submit_hydration_package`) outside the canonical taxonomy — they are explicit-grant-only meta tools, never wildcard-implied capabilities.
 * @invariant `resolveToolPreset` is a pure resolver: `null`/`undefined`/empty input returns `[]`, the wildcard string returns exactly `['*']`, named presets resolve case-insensitively to fresh copies (never the frozen stored arrays), comma-separated strings are split and trimmed, Sets/arrays are copied without mutation, and every entry whose canonical form is a retired selector expands in place to that selector's frozen tool list (fixed legacy order, no de-duplication).
 */

// ============================================================================
// 1. Standardized Error Codes & Types
// ============================================================================

/**
 * Standardized Machine-Readable Error Codes for the Sandbox Tool System.
 *
 * Used across the table-driven dispatcher, permission gates, parameter sanitizers, and LLM retry loops.
 *
 * @readonly
 * Enum of `string` values:
 * @example
 * ```typescript
 * import { TOOL_SYSTEM_ERROR_CODES } from './constants/index.ts';
 *
 * if (result.code === TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED) {
 *   console.error(`Access denied: ${result.error}`);
 * } else if (result.code === TOOL_SYSTEM_ERROR_CODES.TOOL_NOT_FOUND) {
 *   console.warn(`Unrecognized tool requested: ${result.error}`);
 * }
 * ```
 */
export const TOOL_SYSTEM_ERROR_CODES: {
  /**
   * Tool name failed to resolve against the canonical registry or alias map (404 Category).
   * Triggered when an LLM requests an unrecognized tool or unmapped hallucinated function name.
   */
  readonly TOOL_NOT_FOUND: 'TOOL_NOT_FOUND';

  /**
   * Calling agent lacks capability authorization for the requested tool (403 Category).
   * Triggered when a tool is not in the agent's `allowedTools` preset/whitelist and caller is unprivileged.
   */
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED';

  /**
   * Tool arguments payload is malformed, invalid JSON, or violates required schema constraints (400 Category).
   *
   * Reachable triggers: a malformed `batch_precall` call item, and downstream engine receipts that
   * already carry `INVALID_ARGUMENTS` (passed through unchanged because the code is in-dictionary).
   * Dispatcher sanitizer/handler failures normalize to `EXECUTION_FAILED`; parameter sanitization
   * itself never fails (malformed JSON is swallowed, non-object input receives defaults).
   */
  readonly INVALID_ARGUMENTS: 'INVALID_ARGUMENTS';

  /**
   * Reserved code for a missing required Layer 0/context service (503 Category).
   *
   * Descriptor handlers currently throw plain `Error` when required services (`virtualFs`,
   * `messagingBus`, `worldClock`, `lifecyclePort`, `executeTool`, `toolRegistry`, etc.) are not
   * provided, and the dispatcher's universal error shield normalizes those receipts to
   * `EXECUTION_FAILED`. Handlers never emit `SERVICE_UNAVAILABLE` themselves.
   */
  readonly SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE';

  /**
   * A tool outside the ratified precall allowlist was invoked within a `batch_precall` invocation
   * list (403 Category).
   *
   * The `batch_precall` descriptor emits this code; the turn-execution precall gate denies the
   * same condition with its own `FORBIDDEN_PRECALL` code (declared by `turnExecutionEngine`).
   *
   * Precalls are **not** restricted to read-only, non-mutating primitives: the allowlist admits
   * limited state changes — `read_message`/`get_inbox` may consume mail (mark-as-read/drain) and
   * `world_clock`/`event_list` may step the clock and register/resolve/cancel events. What is
   * forbidden is every tool outside the allowlist: VFS writes and mutations, agent lifecycle
   * mutations (`spawn_agent`/`kill_agent`/`undo_turn`; `list_agents` is allowlisted), scheduler
   * mutations, outbound messaging, and direct invocation.
   */
  readonly PRECALL_FORBIDDEN: 'PRECALL_FORBIDDEN';

  /**
   * Downstream subsystem threw an unhandled runtime exception during tool execution (500 Category).
   * Universal error shielding captures the exception and returns this code with the error message.
   * This is also the normalization target for any downstream failure code outside this dictionary
   * (thrown or returned), including missing codes and engine codes such as `FILE_NOT_FOUND` or `TIMEOUT`.
   */
  readonly EXECUTION_FAILED: 'EXECUTION_FAILED';

  /**
   * The requested agent id is already registered as an active agent (409 Category).
   *
   * Emitted by the `spawn_agent` boundary when the lifecycle's own
   * `AGENT_ALREADY_EXISTS` conflict surfaces; kept as its own code so a model
   * can distinguish an id collision from a generic execution fault.
   */
  readonly AGENT_ALREADY_EXISTS: 'AGENT_ALREADY_EXISTS';
} = Object.freeze({
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PRECALL_FORBIDDEN: 'PRECALL_FORBIDDEN',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
  AGENT_ALREADY_EXISTS: 'AGENT_ALREADY_EXISTS'
});

/**
 * Union type representing all valid machine-readable tool system error codes.
 *
 * @example
 * ```typescript
 * function handleToolError(code: ToolSystemErrorCode, message: string) {
 *   switch (code) {
 *     case 'TOOL_NOT_FOUND':
 *     case 'PERMISSION_DENIED':
 *     case 'INVALID_ARGUMENTS':
 *     case 'SERVICE_UNAVAILABLE':
 *     case 'PRECALL_FORBIDDEN':
 *     case 'EXECUTION_FAILED':
 *       return { handled: true, code, message };
 *   }
 * }
 * ```
 */
export type ToolSystemErrorCode = typeof TOOL_SYSTEM_ERROR_CODES[keyof typeof TOOL_SYSTEM_ERROR_CODES];

// ============================================================================
// 2. Canonical Tool Enumeration (35 Tools)
// ============================================================================

/**
 * Master Sandbox Tools Enum (Canonical `snake_case` names for all 35 tools).
 * Eliminates magic strings across turn execution engines, lifecycle managers, UI components, and test suites.
 *
 * Grouped across 7 substrate domains:
 * - **Virtual Filesystem (VFS)** (12 tools): `read_file`, `write_file`, `replace_file_content`, `copy_file`,
 *   `delete_file`, `list_files`, `write_json`, `query_json`, `json_patch`, `grep`, `set_permissions`,
 *   `concat_files`
 * - **Messaging & Mailbox** (8 tools): `send_message`, `wait_for_mail`, `list_inbox`, `read_message`,
 *   `get_archive`, `inline_file_in_message`, `get_inbox`, `drain_inbox`
 * - **Agent Lifecycle Management** (5 tools): `spawn_agent`, `kill_agent`, `list_agents`, `whoami`, `undo_turn`
 * - **Synchronous Invocation** (2 tools): `invoke_agent`, `wait_for_invocation`
 * - **Runtime Scheduler** (3 tools): `schedule`, `list_schedules`, `cancel_schedule`
 * - **World Clock & Events** (3 tools): `world_clock`, `event_list`, `get_current_time`
 * - **Precall & Reflection** (2 tools): `batch_precall`, `describe_tool`
 *
 * @readonly
 * Enum of `string` values:
 * @example
 * ```typescript
 * import { SANDBOX_TOOLS } from './constants/index.ts';
 *
 * const toolName = SANDBOX_TOOLS.READ_FILE; // 'read_file'
 * if (toolName === SANDBOX_TOOLS.SEND_MESSAGE) {
 *   // Handle message dispatch
 * }
 * ```
 */
export const SANDBOX_TOOLS: {
  // Virtual Filesystem (VFS) Primitives (12 Tools)
  /** Reads file content from a virtual file with line or offset pagination and output budgeting. */
  readonly READ_FILE: 'read_file';
  /** Writes or overwrites text content in a virtual file path. */
  readonly WRITE_FILE: 'write_file';
  /** Replaces a literal target substring in a virtual file, optionally replacing every occurrence. */
  readonly REPLACE_FILE_CONTENT: 'replace_file_content';
  /** Copies a single file between virtual workspace paths. */
  readonly COPY_FILE: 'copy_file';
  /** Deletes a virtual file or directory recursively. */
  readonly DELETE_FILE: 'delete_file';
  /** Lists directory contents with metadata and recursive scanning options. */
  readonly LIST_FILES: 'list_files';
  /** Serializes and writes a structured JavaScript object or JSON string to a file. */
  readonly WRITE_JSON: 'write_json';
  /** Queries JSON file contents using AST-based jq-like path expressions. */
  readonly QUERY_JSON: 'query_json';
  /** Applies atomic RFC 6902 JSON Patch operations to a target JSON document. */
  readonly JSON_PATCH: 'json_patch';
  /** Searches workspace files matching regex or literal string patterns. */
  readonly GREP: 'grep';
  /** Sets read-only protection flags or ownership on a virtual file. */
  readonly SET_PERMISSIONS: 'set_permissions';
  /** Concatenates multiple virtual files (resolved under the caller's workspace view) into a destination file with an optional separator. */
  readonly CONCAT_FILES: 'concat_files';

  // Messaging & Mailbox Primitives (8 Tools)
  /** Dispatches an asynchronous direct message or broadcast to an agent recipient. */
  readonly SEND_MESSAGE: 'send_message';
  /** Halts caller turn execution until a new message arrives or timeout expires. */
  readonly WAIT_FOR_MAIL: 'wait_for_mail';
  /** Lists message headers in the calling agent's inbox with unread filters. */
  readonly LIST_INBOX: 'list_inbox';
  /** Reads full body and metadata of a specific message by message ID. */
  readonly READ_MESSAGE: 'read_message';
  /** Queries historical message archive with offset/limit pagination. */
  readonly GET_ARCHIVE: 'get_archive';
  /** Inlines a virtual file's content directly into an outgoing message. */
  readonly INLINE_FILE_IN_MESSAGE: 'inline_file_in_message';
  /** Retrieves a batch of pending unread messages from the caller's inbox (with optional mark-as-read). */
  readonly GET_INBOX: 'get_inbox';
  /** Atomically reads and marks all messages in the caller's inbox as read. */
  readonly DRAIN_INBOX: 'drain_inbox';

  // Agent Lifecycle Management Primitives (5 Tools)
  /** Spawns a new subagent worker with domain persona, role, and system prompt. */
  readonly SPAWN_AGENT: 'spawn_agent';
  /** Terminates an active agent worker and releases its allocated runtime resources. */
  readonly KILL_AGENT: 'kill_agent';
  /** Lists all active or registered agents within the sandbox session. */
  readonly LIST_AGENTS: 'list_agents';
  /** Returns the calling agent's identity, role, workspace, and security context. */
  readonly WHOAMI: 'whoami';
  /** Undoes the calling agent's most recent conversational turn, cancelling in-flight work and moving it to the redo stack. */
  readonly UNDO_TURN: 'undo_turn';

  // Synchronous Invocation Primitives (2 Tools)
  /** Initiates a direct synchronous RPC invocation to a subagent worker. */
  readonly INVOKE_AGENT: 'invoke_agent';
  /** Halts turn execution until specified subagent invocation promises resolve. */
  readonly WAIT_FOR_INVOCATION: 'wait_for_invocation';

  // Runtime Scheduler Primitives (3 Tools)
  /** Schedules a deferred one-shot turn execution or timer, with an optional early-cancellation condition. */
  readonly SCHEDULE: 'schedule';
  /** Lists all active scheduled one-shot timers and their lifecycle status. */
  readonly LIST_SCHEDULES: 'list_schedules';
  /** Cancels an active scheduled one-shot timer by task ID. */
  readonly CANCEL_SCHEDULE: 'cancel_schedule';

  // World Clock & Events Primitives (3 Tools)
  /** Queries, advances, sets, or resets the simulation world clock time. */
  readonly WORLD_CLOCK: 'world_clock';
  /** Queries, registers, resolves, or cancels world timeline simulation events. */
  readonly EVENT_LIST: 'event_list';
  /** Returns the current world clock state: elapsed seconds, day/hour/minute/second fields, and formatted time strings. */
  readonly GET_CURRENT_TIME: 'get_current_time';

  // Precall & Reflection Primitives (2 Tools)
  /** Executes an ordered batch of allowlisted pre-computation tool calls prior to conversational actions; not restricted to read-only — the allowlist admits mail consumption and clock/event stepping, while VFS writes, agent lifecycle mutations, scheduler mutations, outbound messaging, and direct invocation stay forbidden. */
  readonly BATCH_PRECALL: 'batch_precall';
  /** Returns OpenAI JSON schema and semantic documentation for a tool by name. */
  readonly DESCRIBE_TOOL: 'describe_tool';
} = Object.freeze({
  READ_FILE: 'read_file',
  WRITE_FILE: 'write_file',
  REPLACE_FILE_CONTENT: 'replace_file_content',
  COPY_FILE: 'copy_file',
  DELETE_FILE: 'delete_file',
  LIST_FILES: 'list_files',
  WRITE_JSON: 'write_json',
  QUERY_JSON: 'query_json',
  JSON_PATCH: 'json_patch',
  GREP: 'grep',
  SET_PERMISSIONS: 'set_permissions',
  CONCAT_FILES: 'concat_files',

  SEND_MESSAGE: 'send_message',
  WAIT_FOR_MAIL: 'wait_for_mail',
  LIST_INBOX: 'list_inbox',
  READ_MESSAGE: 'read_message',
  GET_ARCHIVE: 'get_archive',
  INLINE_FILE_IN_MESSAGE: 'inline_file_in_message',
  GET_INBOX: 'get_inbox',
  DRAIN_INBOX: 'drain_inbox',

  SPAWN_AGENT: 'spawn_agent',
  KILL_AGENT: 'kill_agent',
  LIST_AGENTS: 'list_agents',
  WHOAMI: 'whoami',
  UNDO_TURN: 'undo_turn',

  INVOKE_AGENT: 'invoke_agent',
  WAIT_FOR_INVOCATION: 'wait_for_invocation',

  SCHEDULE: 'schedule',
  LIST_SCHEDULES: 'list_schedules',
  CANCEL_SCHEDULE: 'cancel_schedule',

  WORLD_CLOCK: 'world_clock',
  EVENT_LIST: 'event_list',
  GET_CURRENT_TIME: 'get_current_time',

  BATCH_PRECALL: 'batch_precall',
  DESCRIBE_TOOL: 'describe_tool'
});

/**
 * Union type representing all 35 canonical sandbox tool names.
 *
 * @example
 * ```typescript
 * function isVfsTool(name: SandboxToolName): boolean {
 *   return name === 'read_file' || name === 'write_file' || name === 'list_files';
 * }
 * ```
 */
export type SandboxToolName = typeof SANDBOX_TOOLS[keyof typeof SANDBOX_TOOLS];

// ============================================================================
// 3. Mutation-Capability Vocabulary
// ============================================================================

/**
 * Canonical tool names that mutate sandbox state (frozen).
 *
 * This is the honest write-capability vocabulary consumed by template/UI
 * capability displays (Realm Wave B): a tool is listed here when invoking it may
 * change state the caller can observe later — VFS writes/deletes/permission
 * changes, outbound/consumed mail, agent lifecycle and invocation, scheduler
 * entries, clock stepping, event registration/resolution, and nested precall
 * batches. `world_clock` and `event_list` are mutating because they step
 * simulation time and rewrite their VFS-backed payloads.
 *
 * @readonly
 * Type: `readonly SandboxToolName[]`.
 * @example
 * ```typescript
 * import { MUTATING_TOOLS } from './constants/index.ts';
 *
 * if (MUTATING_TOOLS.includes('world_clock')) {
 *   console.log('Granting world_clock grants write capability.');
 * }
 * ```
 */
export const MUTATING_TOOLS: readonly SandboxToolName[] = Object.freeze([
  // Virtual Filesystem (8 of 12)
  SANDBOX_TOOLS.WRITE_FILE,
  SANDBOX_TOOLS.REPLACE_FILE_CONTENT,
  SANDBOX_TOOLS.COPY_FILE,
  SANDBOX_TOOLS.DELETE_FILE,
  SANDBOX_TOOLS.WRITE_JSON,
  SANDBOX_TOOLS.JSON_PATCH,
  SANDBOX_TOOLS.SET_PERMISSIONS,
  SANDBOX_TOOLS.CONCAT_FILES,
  // Messaging & Mailbox (6 of 8)
  SANDBOX_TOOLS.SEND_MESSAGE,
  SANDBOX_TOOLS.WAIT_FOR_MAIL,
  SANDBOX_TOOLS.READ_MESSAGE,
  SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE,
  SANDBOX_TOOLS.GET_INBOX,
  SANDBOX_TOOLS.DRAIN_INBOX,
  // Agent Lifecycle Management (3 of 5)
  SANDBOX_TOOLS.SPAWN_AGENT,
  SANDBOX_TOOLS.KILL_AGENT,
  SANDBOX_TOOLS.UNDO_TURN,
  // Synchronous Invocation (1 of 2)
  SANDBOX_TOOLS.INVOKE_AGENT,
  // Runtime Scheduler (2 of 3)
  SANDBOX_TOOLS.SCHEDULE,
  SANDBOX_TOOLS.CANCEL_SCHEDULE,
  // World Clock & Events (2 of 3)
  SANDBOX_TOOLS.WORLD_CLOCK,
  SANDBOX_TOOLS.EVENT_LIST,
  // Precall & Reflection (1 of 2; nested calls may mutate)
  SANDBOX_TOOLS.BATCH_PRECALL
] as const);

/**
 * Canonical tool names that only observe sandbox state (frozen).
 *
 * The exact complement of {@link MUTATING_TOOLS} over `SANDBOX_TOOLS`: every
 * listed tool is side-effect free with respect to sandbox state (reads,
 * mailbox/archive listings, agent/roster inspection, schedule inspection, time
 * queries, and tool reflection).
 *
 * @readonly
 * Type: `readonly SandboxToolName[]`.
 * @example
 * ```typescript
 * import { READ_ONLY_TOOLS } from './constants/index.ts';
 *
 * const canPreviewSafely = READ_ONLY_TOOLS.includes('grep');
 * ```
 */
export const READ_ONLY_TOOLS: readonly SandboxToolName[] = Object.freeze([
  // Virtual Filesystem (4 of 12)
  SANDBOX_TOOLS.READ_FILE,
  SANDBOX_TOOLS.LIST_FILES,
  SANDBOX_TOOLS.QUERY_JSON,
  SANDBOX_TOOLS.GREP,
  // Messaging & Mailbox (2 of 8)
  SANDBOX_TOOLS.LIST_INBOX,
  SANDBOX_TOOLS.GET_ARCHIVE,
  // Agent Lifecycle Management (2 of 5)
  SANDBOX_TOOLS.LIST_AGENTS,
  SANDBOX_TOOLS.WHOAMI,
  // Synchronous Invocation (1 of 2)
  SANDBOX_TOOLS.WAIT_FOR_INVOCATION,
  // Runtime Scheduler (1 of 3)
  SANDBOX_TOOLS.LIST_SCHEDULES,
  // World Clock & Events (1 of 3)
  SANDBOX_TOOLS.GET_CURRENT_TIME,
  // Precall & Reflection (1 of 2)
  SANDBOX_TOOLS.DESCRIBE_TOOL
] as const);

/**
 * Module-private O(1) lookup set backing {@link isMutatingTool}; never exported
 * or mutated after initialization.
 */
const mutatingToolLookup: ReadonlySet<string> = new Set(MUTATING_TOOLS);

/**
 * Pure membership probe over {@link MUTATING_TOOLS} (canonical names only;
 * aliases resolve before this vocabulary is consulted).
 *
 * @param toolName - Canonical `snake_case` tool name.
 * @returns True when invoking the tool may mutate sandbox state.
 *
 * @example
 * ```typescript
 * import { isMutatingTool } from './constants/index.ts';
 *
 * isMutatingTool('world_clock'); // true
 * isMutatingTool('get_current_time'); // false
 * ```
 */
export function isMutatingTool(toolName: string): boolean {
  return mutatingToolLookup.has(toolName);
}

// ============================================================================
// 3b. Publishing Tool Names (Wave U, lane U-P)
// ============================================================================

/**
 * Frozen vocabulary of the Wave U publishing tool names.
 *
 * These two meta tools are **not** part of the canonical `SANDBOX_TOOLS`
 * taxonomy and are never implied by the wildcard capability or `privileged`:
 * capability comes from the explicit, per-agent `@template:authority` /
 * `@hydration:authority` grants (Wave U lane U-P). The names ship here first
 * so the vocabulary is frozen ahead of the descriptors and handlers.
 *
 * @readonly
 * @example
 * ```typescript
 * import { PUBLISHING_TOOLS } from './constants/index.ts';
 *
 * const importName = PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE; // 'import_realm_template'
 * ```
 */
export const PUBLISHING_TOOLS: {
  /** Imports a realm template transport bundle (`{ formatVersion, template, files }`). */
  readonly IMPORT_REALM_TEMPLATE: 'import_realm_template';
  /** Submits a hydration package for a template instance. */
  readonly SUBMIT_HYDRATION_PACKAGE: 'submit_hydration_package';
} = Object.freeze({
  IMPORT_REALM_TEMPLATE: 'import_realm_template',
  SUBMIT_HYDRATION_PACKAGE: 'submit_hydration_package'
});

// ============================================================================
// 4. Innate Tools Collection
// ============================================================================

/**
 * Interface representing the innate tools collection: an immutable array of tool names
 * augmented with a non-enumerable `.has(toolName)` convenience lookup — a linear
 * `Array.prototype.includes` scan (O(n) over the frozen four-name list), not a hash lookup.
 */
export interface InnateToolsList extends ReadonlyArray<SandboxToolName> {
  /**
   * Checks whether the specified tool name is in the innate tools collection.
   *
   * @param tool - Tool name to check (e.g. 'whoami', 'get_current_time')
   * @returns True if the tool is an innate tool, false otherwise
   */
  has(tool: string): boolean;
}

const innateToolsList: SandboxToolName[] = [
  SANDBOX_TOOLS.WHOAMI,
  SANDBOX_TOOLS.GET_CURRENT_TIME,
  SANDBOX_TOOLS.DESCRIBE_TOOL,
  SANDBOX_TOOLS.BATCH_PRECALL
];
Object.defineProperty(innateToolsList, 'has', {
  value: function(this: readonly string[], tool: string): boolean {
    return this.includes(tool);
  },
  enumerable: false,
  writable: false,
  configurable: false
});

/**
 * Immutable list of baseline primitives permitted for all agents by default.
 * Contains: `whoami`, `get_current_time`, `describe_tool`, and `batch_precall`
 * (which may perform the limited mutations its own allowlist admits).
 *
 * @readonly
 * Type: `InnateToolsList`.
 * @example
 * ```typescript
 * import { INNATE_TOOLS } from './constants/index.ts';
 *
 * if (INNATE_TOOLS.has('whoami')) {
 *   console.log('whoami is an innate tool and always permitted.');
 * }
 * ```
 */
export const INNATE_TOOLS: InnateToolsList = Object.freeze(innateToolsList) as InnateToolsList;

// ============================================================================
// 5. Capability Presets & Preset Types
// ============================================================================

// ----------------------------------------------------------------------------
// 5a. Tool-family taxonomy (ticket 5efc129)
// ----------------------------------------------------------------------------

/**
 * Canonical tool-family vocabulary (frozen, ticket 5efc129).
 *
 * Each baked tool declares exactly one primary family in {@link TOOL_FAMILIES};
 * families are a declaration-time grouping only — they never cross the
 * authority (publishing/meta), extension, or mutation axes. `inline_file_in_message`
 * stays in `messaging.send` and carries an explicit tier override instead of a
 * dedicated family.
 */
export type ToolFamily =
  | 'vfs.read' | 'vfs.write' | 'messaging.send' | 'mailbox.read' | 'mailbox.consume'
  | 'lifecycle' | 'invocation' | 'scheduler' | 'clock' | 'world' | 'precall';

/**
 * Tool-family assignment for every canonical `SANDBOX_TOOLS` entry (frozen).
 *
 * This is the **only** place a baked tool's family is written: the named
 * capability tiers are derived from it through {@link FAMILY_TIER_PLAN} and
 * {@link TOOL_TIER_EXPOSURE}, so adding or re-familying a tool updates the
 * right tiers automatically. Mutation class is not duplicated here — it stays
 * the existing `MUTATING_TOOLS`/`READ_ONLY_TOOLS` partition.
 *
 * @readonly
 * Type: `Readonly<Record<SandboxToolName, ToolFamily>>` (exactly 35 keys).
 * @example
 * ```typescript
 * import { TOOL_FAMILIES } from './constants/index.ts';
 *
 * TOOL_FAMILIES.read_file; // 'vfs.read'
 * ```
 */
export const TOOL_FAMILIES: Readonly<Record<SandboxToolName, ToolFamily>> = Object.freeze({
  [SANDBOX_TOOLS.READ_FILE]: 'vfs.read',
  [SANDBOX_TOOLS.WRITE_FILE]: 'vfs.write',
  [SANDBOX_TOOLS.REPLACE_FILE_CONTENT]: 'vfs.write',
  [SANDBOX_TOOLS.COPY_FILE]: 'vfs.write',
  [SANDBOX_TOOLS.DELETE_FILE]: 'vfs.write',
  [SANDBOX_TOOLS.LIST_FILES]: 'vfs.read',
  [SANDBOX_TOOLS.WRITE_JSON]: 'vfs.write',
  [SANDBOX_TOOLS.QUERY_JSON]: 'vfs.read',
  [SANDBOX_TOOLS.JSON_PATCH]: 'vfs.write',
  [SANDBOX_TOOLS.GREP]: 'vfs.read',
  [SANDBOX_TOOLS.SET_PERMISSIONS]: 'vfs.write',
  [SANDBOX_TOOLS.CONCAT_FILES]: 'vfs.write',
  [SANDBOX_TOOLS.SEND_MESSAGE]: 'messaging.send',
  [SANDBOX_TOOLS.WAIT_FOR_MAIL]: 'mailbox.consume',
  [SANDBOX_TOOLS.LIST_INBOX]: 'mailbox.read',
  [SANDBOX_TOOLS.READ_MESSAGE]: 'mailbox.consume',
  [SANDBOX_TOOLS.GET_ARCHIVE]: 'mailbox.read',
  [SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE]: 'messaging.send',
  [SANDBOX_TOOLS.GET_INBOX]: 'mailbox.consume',
  [SANDBOX_TOOLS.DRAIN_INBOX]: 'mailbox.consume',
  [SANDBOX_TOOLS.SPAWN_AGENT]: 'lifecycle',
  [SANDBOX_TOOLS.KILL_AGENT]: 'lifecycle',
  [SANDBOX_TOOLS.LIST_AGENTS]: 'lifecycle',
  [SANDBOX_TOOLS.WHOAMI]: 'lifecycle',
  [SANDBOX_TOOLS.UNDO_TURN]: 'lifecycle',
  [SANDBOX_TOOLS.INVOKE_AGENT]: 'invocation',
  [SANDBOX_TOOLS.WAIT_FOR_INVOCATION]: 'invocation',
  [SANDBOX_TOOLS.SCHEDULE]: 'scheduler',
  [SANDBOX_TOOLS.LIST_SCHEDULES]: 'scheduler',
  [SANDBOX_TOOLS.CANCEL_SCHEDULE]: 'scheduler',
  [SANDBOX_TOOLS.WORLD_CLOCK]: 'clock',
  [SANDBOX_TOOLS.EVENT_LIST]: 'world',
  [SANDBOX_TOOLS.GET_CURRENT_TIME]: 'clock',
  [SANDBOX_TOOLS.BATCH_PRECALL]: 'precall',
  [SANDBOX_TOOLS.DESCRIBE_TOOL]: 'precall'
});

/**
 * Family → named-tier membership plan (frozen, ticket 5efc129).
 *
 * Each family lists the named capability tiers whose composition includes its
 * tools; `clock`, `world`, and `precall` are intentionally empty (their
 * members arrive through the innate baseline, and `world_clock`/`event_list`
 * stay wildcard/custom-only). `all`/`'*'` is never family-derived.
 *
 * @readonly
 * Type: `Readonly<Record<ToolFamily, readonly ToolPresetName[]>>`.
 * @example
 * ```typescript
 * import { FAMILY_TIER_PLAN } from './constants/index.ts';
 *
 * FAMILY_TIER_PLAN['vfs.write']; // ['collaborator', 'manager']
 * ```
 */
export const FAMILY_TIER_PLAN: Readonly<Record<ToolFamily, readonly ToolPresetName[]>> = Object.freeze({
  'vfs.read': Object.freeze(['readonly', 'readonly_collaborator', 'collaborator', 'manager'] as const),
  'vfs.write': Object.freeze(['collaborator', 'manager'] as const),
  'messaging.send': Object.freeze(['readonly_collaborator', 'collaborator', 'manager'] as const),
  'mailbox.read': Object.freeze(['readonly', 'readonly_collaborator', 'collaborator', 'manager'] as const),
  'mailbox.consume': Object.freeze(['readonly', 'readonly_collaborator', 'collaborator', 'manager'] as const),
  lifecycle: Object.freeze(['manager'] as const),
  invocation: Object.freeze(['manager'] as const),
  scheduler: Object.freeze(['collaborator', 'manager'] as const),
  clock: Object.freeze([] as const),
  world: Object.freeze([] as const),
  precall: Object.freeze([] as const)
});

/**
 * Exposure policy for one baked tool (frozen vocabulary, ticket 5efc129).
 *
 * - `'family'` — default for every tool not listed in {@link TOOL_TIER_EXPOSURE};
 *   joins the tiers in `FAMILY_TIER_PLAN[family]`.
 * - `'never'` — the tool never auto-joins a named tier (wildcard/custom-grant
 *   only); every use is a documented orphan decision.
 * - `readonly ToolPresetName[]` — explicit tier membership overriding the
 *   family plan (only `inline_file_in_message` uses this).
 */
export type ToolExposure = 'family' | 'never' | readonly ToolPresetName[];

/**
 * Per-tool exposure overrides over {@link FAMILY_TIER_PLAN} (frozen).
 *
 * Only overrides are listed — an absent tool defaults to `'family'`. The
 * `'never'` entries are the documented orphan decisions: `concat_files` and
 * `drain_inbox` (explicit-grant plumbing) and `world_clock`/`event_list`
 * (operator stepping). `inline_file_in_message` carries the historical
 * `collaborator+` override (the read-only collaborator keeps plain
 * `send_message` and never attachment sends).
 *
 * @readonly
 * Type: `Readonly<Partial<Record<SandboxToolName, ToolExposure>>>`.
 * @example
 * ```typescript
 * import { TOOL_TIER_EXPOSURE } from './constants/index.ts';
 *
 * TOOL_TIER_EXPOSURE.drain_inbox; // 'never'
 * ```
 */
export const TOOL_TIER_EXPOSURE: Readonly<Partial<Record<SandboxToolName, ToolExposure>>> = Object.freeze({
  [SANDBOX_TOOLS.CONCAT_FILES]: 'never',
  [SANDBOX_TOOLS.DRAIN_INBOX]: 'never',
  [SANDBOX_TOOLS.WORLD_CLOCK]: 'never',
  [SANDBOX_TOOLS.EVENT_LIST]: 'never',
  [SANDBOX_TOOLS.INLINE_FILE_IN_MESSAGE]: Object.freeze(['collaborator', 'manager'] as const)
});

/** Canonical tool declaration order (`SANDBOX_TOOLS` value order, frozen). */
const CANONICAL_TOOL_ORDER: readonly SandboxToolName[] = Object.freeze(Object.values(SANDBOX_TOOLS));

/**
 * Derives one named capability tier's canonical-order member list (frozen).
 *
 * Every tier starts from the innate baseline and then joins each canonical
 * tool per its exposure: `'never'` skips, `'family'` joins when
 * `FAMILY_TIER_PLAN[family]` includes the tier, an explicit array joins when it
 * includes the tier. The member set is filtered through the canonical
 * declaration order, so generated arrays are duplicate-free and stable.
 *
 * @param tier - Named capability tier to derive
 * @returns The frozen canonical-order tier array
 */
function generateTier(tier: ToolPresetName): readonly string[] {
  const members = new Set<SandboxToolName>(INNATE_TOOLS);
  for (const tool of CANONICAL_TOOL_ORDER) {
    const exposure = TOOL_TIER_EXPOSURE[tool] ?? 'family';
    if (exposure === 'never') continue;
    if (exposure === 'family') {
      if (FAMILY_TIER_PLAN[TOOL_FAMILIES[tool]].includes(tier)) members.add(tool);
      continue;
    }
    if (exposure.includes(tier)) members.add(tool);
  }
  return Object.freeze(CANONICAL_TOOL_ORDER.filter((tool) => members.has(tool)));
}

/**
 * Generates the five-key capability catalog from the frozen family taxonomy
 * (ticket 5efc129).
 *
 * Key order is `all`, `manager`, `collaborator`, `readonly_collaborator`,
 * `readonly` — the spawn `toolPreset` enum order is unchanged. `all` is
 * exactly `['*']` and is never family-derived.
 *
 * Module-private: {@link TOOL_PRESETS} is the only exported catalog and is
 * built from this generator exactly once.
 *
 * @returns A frozen preset catalog (`all` wildcard plus the four named tiers)
 */
function generateToolPresets(): {
  readonly all: readonly ['*'];
  readonly manager: readonly string[];
  readonly collaborator: readonly string[];
  readonly readonly_collaborator: readonly string[];
  readonly readonly: readonly string[];
} {
  return Object.freeze({
    all: Object.freeze(['*'] as const),
    manager: generateTier('manager'),
    collaborator: generateTier('collaborator'),
    readonly_collaborator: generateTier('readonly_collaborator'),
    readonly: generateTier('readonly')
  });
}

// ----------------------------------------------------------------------------
// 5b. Retired tool selectors (deprecated alias window, ticket 5efc129)
// ----------------------------------------------------------------------------

/**
 * Frozen retired-tool-selector window (deprecated).
 *
 * The canonical `subagent_management` selector id maps to the fixed legacy
 * expansion `spawn_agent`, `kill_agent`, `invoke_agent`, `undo_turn` (in that
 * order). The map keys only the canonical selector id; the historical
 * spellings (`manage_subagents`, `subagents`, `subagent_tools`) keep resolving
 * through the alias normalizer. The window exists so persisted/hydrated
 * descriptor grants written against the retired sentinel keep exactly their
 * effective authorization; unknown names fail closed.
 *
 * @readonly
 * @example
 * ```typescript
 * import { RETIRED_TOOL_SELECTORS } from './constants/index.ts';
 *
 * RETIRED_TOOL_SELECTORS.subagent_management; // ['spawn_agent', 'kill_agent', 'invoke_agent', 'undo_turn']
 * ```
 */
export const RETIRED_TOOL_SELECTORS: Readonly<Record<string, readonly SandboxToolName[]>> = Object.freeze({
  subagent_management: Object.freeze([
    SANDBOX_TOOLS.SPAWN_AGENT,
    SANDBOX_TOOLS.KILL_AGENT,
    SANDBOX_TOOLS.INVOKE_AGENT,
    SANDBOX_TOOLS.UNDO_TURN
  ])
});

/**
 * Pure fail-closed expansion for a retired selector id (deprecated window).
 *
 * Only the canonical selector id (as produced by the alias normalizer) is a
 * valid key: any other input — including the alias spellings, unknown names,
 * and prototype-chain names — resolves `null` and grants nothing.
 *
 * @param canonical - Candidate canonical selector id
 * @returns The frozen expansion array, or `null` when the id is not a retired selector
 *
 * @example
 * ```typescript
 * import { expandRetiredToolSelector } from './constants/index.ts';
 *
 * expandRetiredToolSelector('subagent_management'); // ['spawn_agent', 'kill_agent', 'invoke_agent', 'undo_turn']
 * expandRetiredToolSelector('unknown'); // null
 * ```
 */
export function expandRetiredToolSelector(canonical: string): readonly SandboxToolName[] | null {
  if (!Object.prototype.hasOwnProperty.call(RETIRED_TOOL_SELECTORS, canonical)) return null;
  return RETIRED_TOOL_SELECTORS[canonical];
}

// ----------------------------------------------------------------------------
// 5c. Capability preset catalog
// ----------------------------------------------------------------------------

/**
 * Standard capability presets defining tool permission tiers for agents.
 *
 * Generated once (frozen) from the tool-family taxonomy: every named tier is
 * the innate baseline plus its family members under
 * {@link FAMILY_TIER_PLAN}/{@link TOOL_TIER_EXPOSURE}, filtered into canonical
 * `SANDBOX_TOOLS` declaration order and duplicate-free — no hand-enumerated
 * member list exists. The retired `subagent_management` selector is never a
 * member; it is accepted only through the deprecated selector window
 * ({@link RETIRED_TOOL_SELECTORS}) and expands to its four legacy tools.
 *
 * - `all`: Full access to all 35 sandbox tools (`['*']`).
 * - `manager`: VFS manipulation, messaging, scheduling, subagent lifecycle, invocation, clock, and precall.
 * - `collaborator`: Full VFS, messaging, scheduling, clock, and precall (no lifecycle/invocation).
 * - `readonly_collaborator`: Read-only VFS, mailbox tools plus `send_message` (mail can be consumed by `read_message`/`get_inbox`), clock, and precall.
 * - `readonly`: Read-only VFS, mailbox tools (mail can be consumed by `read_message`/`get_inbox`; no `send_message`), whoami, clock, and precall.
 *
 * @readonly
 * @example
 * ```typescript
 * import { TOOL_PRESETS } from './constants/index.ts';
 *
 * const managerTools = TOOL_PRESETS.manager;
 * const isAll = TOOL_PRESETS.all.includes('*');
 * ```
 */
export const TOOL_PRESETS: {
  /** Full access to all 35 sandbox tools wildcard */
  readonly all: readonly ['*'];
  /** Manager tier: Full VFS, messaging, scheduler, subagent lifecycle, invocation, clock, and precall */
  readonly manager: readonly string[];
  /** Collaborator tier: Full VFS, messaging, scheduler, clock, and precall */
  readonly collaborator: readonly string[];
  /** Read-only collaborator tier: Read-only VFS, mailbox tools plus send_message, clock, and precall (mail can be consumed by read_message/get_inbox) */
  readonly readonly_collaborator: readonly string[];
  /** Read-only tier: Read-only VFS, mailbox tools, whoami, clock, and precall (mail can be consumed by read_message/get_inbox; no send_message) */
  readonly readonly: readonly string[];
} = Object.freeze(generateToolPresets());

/**
 * Union type representing standard capability preset names.
 */
export type ToolPresetName = keyof typeof TOOL_PRESETS;

// ============================================================================
// 6. Preset Resolver Utility
// ============================================================================

function isToolPresetName(value: string): value is ToolPresetName {
  return Object.prototype.hasOwnProperty.call(TOOL_PRESETS, value);
}

/**
 * Expands every entry whose canonical form is a retired selector in place,
 * preserving entry order (deprecated window, module-private). Non-selector
 * entries — including the alias spellings, unknown names, and non-strings —
 * pass through unchanged.
 *
 * @param entries - Resolved entry list
 * @returns A new list with retired selectors expanded
 */
function expandRetiredSelectorEntries(entries: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const entry of entries) {
    const retired = typeof entry === 'string'
      ? expandRetiredToolSelector(entry.trim().toLowerCase())
      : null;
    if (retired) {
      expanded.push(...retired);
      continue;
    }
    expanded.push(entry);
  }
  return expanded;
}

/**
 * Resolves a tool preset identifier, tool array, Set, or comma-separated string
 * into a canonical array of permitted tool names or wildcard patterns.
 *
 * Supports:
 * - Preset strings: `'manager'`, `'collaborator'`, `'readonly_collaborator'`, `'readonly'`, `'all'`
 * - Wildcard string: `'*'` -\> `['*']`
 * - Retired selector (deprecated window): `'subagent_management'` -\> `['spawn_agent', 'kill_agent', 'invoke_agent', 'undo_turn']`
 * - Comma-separated strings: `'read_file, write_file, send_message'` -\> `['read_file', 'write_file', 'send_message']`
 * - Arrays of tool names or presets: `['read_file', 'write_file']`
 * - Sets of tool names: `new Set(['read_file', 'whoami'])`
 * - Null or undefined: returns `[]`
 *
 * @param input - Preset name, tool array, Set, or CSV string
 * @returns Canonical array of tool names or wildcard patterns
 *
 * @example
 * ```typescript
 * import { resolveToolPreset } from './constants/index.ts';
 *
 * // Resolve a preset tier
 * const tools = resolveToolPreset('collaborator');
 * // => ['read_file', 'write_file', ..., 'batch_precall']
 *
 * // Resolve comma-separated tool list
 * const customTools = resolveToolPreset('read_file, write_file, whoami');
 * // => ['read_file', 'write_file', 'whoami']
 *
 * // Resolve Set
 * const setTools = resolveToolPreset(new Set(['read_file', 'get_current_time']));
 * // => ['read_file', 'get_current_time']
 * ```
 */
export function resolveToolPreset(
  input?: string | readonly string[] | ReadonlySet<string> | null
): string[] {
  if (!input) return [];
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return [];
    const lower = trimmed.toLowerCase();
    if (isToolPresetName(lower)) {
      return [...TOOL_PRESETS[lower]];
    }
    if (trimmed === '*') {
      return ['*'];
    }
    if (trimmed.includes(',')) {
      const parsed = trimmed.split(',').map(s => s.trim()).filter(Boolean);
      return parsed.length > 0 ? expandRetiredSelectorEntries(parsed) : [];
    }
    return expandRetiredSelectorEntries([trimmed]);
  }
  if (input instanceof Set) {
    return expandRetiredSelectorEntries(Array.from(input));
  }
  if (Array.isArray(input)) {
    if (input.length === 0) return [];
    if (input.length === 1 && typeof input[0] === 'string') {
      const single = input[0].trim().toLowerCase();
      if (isToolPresetName(single)) {
        return [...TOOL_PRESETS[single]];
      }
    }
    return expandRetiredSelectorEntries([...input]);
  }
  return [];
}
