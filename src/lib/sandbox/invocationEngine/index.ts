/**
 * @packageDocumentation
 * Immutable Type Definitions & Comprehensive JSDoc Specifications for the `InvocationEngine`.
 *
 * The `InvocationEngine` is the deterministic execution substrate for direct subagent Remote Procedure Calls (RPCs)
 * and isolated secondary token streaming within the `ai-story` sandbox. It decouples high-frequency synchronous and
 * turn-level agent delegations from the user-facing chat and messaging subsystem.
 *
 * @module invocationEngine
 * @mustNotImport ../messagingBus/index.ts
 * @decision Invocation authority is the frozen `AuthorityDescriptor` of the resolved invoker (supplied by the injected `getAgentAuthority` registry resolver); magic invoker ids (`director`/`admin`), caller-asserted privilege flags, and authority-bearing roles grant nothing
 * @decision Realm-local identifiers: invoker/target references are opaque; the optional injected `identityPort` resolves canonical `key`s for self/parent/await comparisons and bare display ids, the injected `getAgentRealmScope` hook remains the sole Realm-scope channel, records key by invocation UUID and strip the private identity refs from public copies, and no receipt/list/event leaks a key
 * @invariant Invocations never route through or pollute `MessagingBus` mailboxes or its audit log; direct invocations are independent RPCs, not chat messages.
 * @invariant Invocations are not messages: each record carries strict calling semantics (`invokerId`/`targetAgentId`, `inv_` invocation UUID, recursion depth, lifecycle status) distinct from peer-to-peer messaging.
 * @invariant Subagent streaming tokens emit only on the dedicated `onInvocationChunk` channel, tagged with `invocationId` and `targetAgentId`, isolated from primary user chat streams.
 * @invariant Invocations are permitted only for an invoker whose registry `AuthorityDescriptor` allows `'*'` or `'@lifecycle:authority'` (resolved through the injected `getAgentAuthority` resolver), the parent creator (`spawnedBy`/`creatorId`), or the target itself; any other caller — including magic ids (`director`/`admin`), privilege flags, and role aliases — is rejected synchronously with `PERMISSION_DENIED` (default-deny).
 * @invariant `waitForInvocation` supports `requireAll: true` barrier and `requireAll: false` first-arrival modes, timeout fallback that preserves arrived partial results, and `AbortSignal` cancellation resolving with `ABORTED` for waits that are not already satisfied (targets already settled in history resolve with results first).
 * @invariant Await authorization: when the trusted caller channel is present (the agent-facing lifecycle port or facade), the caller must be the invocation's invoker, its target, or a Realm-bypass principal (the exact injected internal principal or the hardcoded system director resolved through the injected realm-scope hook); a caller-scoped request whose identity cannot be resolved as a registered subject fails closed with `PERMISSION_DENIED` before any ledger read, and an unrelated resolved caller is denied for every requested invocation. Caller-supplied option keys are never an identity channel: only the facade/port-supplied `InvocationCallerContext` argument is consulted.
 * @invariant Realm-scoped invocation, one-way bypass: when the injected `getAgentRealmScope` hook resolves both invoker and target, a cross-scope pair (`realmId` differs) is rejected with `PERMISSION_DENIED` even for wildcard/privileged invokers, and a non-bypass invoker can never target a bypass subject (no reply path into the system scope). Equal scopes (including the shared ungrouped `null` scope) keep legacy behavior, a `realmBypass` invoker (operator/director) spans every scope, and an absent scope projection (standalone engine hosts) keeps the legacy unscoped gate.
 * @invariant Recursion guard (max depth 5): incoming `depth >= MAX_INVOCATION_DEPTH` or resulting `depth > MAX_INVOCATION_DEPTH` is rejected with `RECURSION_DEPTH_EXCEEDED`; a present numeric `depth` that is not a non-negative integer (negative, fractional, `NaN`) is rejected with `INVALID_ARGUMENTS`, and a non-numeric `depth` falls back to `recursionDepth` when numeric, otherwise to `0`, so the resulting record depth is always within 1–5.
 * @invariant `InvokeAgentOptions.role` is the turn-role selector only: `'system'` selects a system turn, every other value (including `'admin'`) executes as `'user'`. Neither `role` nor `callerRole` carries authority in the MOD-21 model; authority comes solely from the invoker's registry `AuthorityDescriptor`.
 * @invariant `cancelPendingInvocationsForAgent` settles every in-flight invocation where the agent is caller or target as `cancelled`/`AGENT_TERMINATED` and releases pending waiters immediately; cancellation is final — any armed per-invocation timeout is cleared, late turn results are suppressed, and no further streaming chunks emit.
 * @invariant Invocation ledgers (`#activeInvocations`, `#invocationHistory`, `#pendingWaiters`, `#dispatchControls`) and listener sets are `#`-private; callers observe state only through defensive copies from `getInvocation`, `getActiveInvocations`, `getInvocationHistory`.
 * @invariant Leaf: zero imports; turn execution, agent lookup, and termination checks enter only through injected hooks (`executeTurn`, `getAgent`, `isAgentTerminated`).
 * @invariant Synchronous dispatch rejections and await aborts surface as canonical `INVOCATION_ERROR_CODES` on receipts/results — never as thrown exceptions.
 * @invariant Canonical identifiers, opaque pass-through: the invoker and target identifiers are accepted exactly as supplied — the canonical `(realmId, agentId)` key once the facade passes keys, a bare id otherwise — and are never parsed or split. Internal authorization/self/parent comparisons resolve through the optional injected identity port (`key` match first, then `getAgentIdentity`) so a canonical pair still compares as one identity; the realm gate continues to resolve scope exclusively through the injected `getAgentRealmScope` hook, and injected hooks (`executeTurn`/`getAgent`/`isAgentTerminated`/`getAgentAuthority`) receive the identifiers unchanged.
 * @invariant Bare-id projections: receipts, invocation records, streamed events, and await results expose the bare registered `id` only — never the canonical `key`, never realm vocabulary. Records keep the opaque supplied references privately for authorization and strip them from every defensive copy.
 * @invariant Ambiguous display references fail closed: a canonical reference that the identity port cannot resolve never falls back to a cross-Realm bare-id match for authenticated awaits or cancellations.
 */

// ============================================================================
// 1. Constants & Enums
// ============================================================================

/**
 * Hard architectural limit on nested subagent invocation recursion depth.
 * Calls where incoming depth \>= 5 or resulting depth \> 5 are rejected with `RECURSION_DEPTH_EXCEEDED`.
 *
 * Value: `5`.
 * @example
 * ```typescript
 * import { MAX_INVOCATION_DEPTH } from './index.ts';
 *
 * if (currentDepth >= MAX_INVOCATION_DEPTH) {
 *   console.error(`Cannot nest invocations beyond depth ${MAX_INVOCATION_DEPTH}`);
 * }
 * ```
 */
export const MAX_INVOCATION_DEPTH = 5;

/**
 * Default timeout in milliseconds for turn-level await operations (`waitForInvocation`).
 * Defaults to 10,000 ms (10 seconds).
 *
 * Value: `10000`.
 * @example
 * ```typescript
 * import { DEFAULT_INVOCATION_TIMEOUT_MS } from './index.ts';
 *
 * const effectiveTimeout = customTimeout ?? DEFAULT_INVOCATION_TIMEOUT_MS;
 * ```
 */
export const DEFAULT_INVOCATION_TIMEOUT_MS = 10000;

/**
 * Canonical lifecycle statuses for subagent invocations.
 * Prevents status string divergence across UI, runtime, and telemetry.
 *
 * @readonly
 * Enum of `string` values:
 * @example
 * ```typescript
 * import { INVOCATION_STATUS } from './index.ts';
 *
 * if (record.status === INVOCATION_STATUS.COMPLETED) {
 *   renderOutput(record.output);
 * }
 * ```
 */
export const INVOCATION_STATUS: {
  /** Invocation has been registered in the active ledger and queued for microtask dispatch. */
  readonly PENDING: 'pending';
  /** Invocation microtask is currently executing the agent's turn. */
  readonly RUNNING: 'running';
  /** Invocation completed successfully and produced terminal output. */
  readonly COMPLETED: 'completed';
  /** Invocation turn executor threw an unhandled error. */
  readonly ERROR: 'error';
  /** Invocation timed out during execution. */
  readonly TIMED_OUT: 'timed_out';
  /** Invocation was cancelled because the agent was terminated or recycled (emergency unstick does not cancel in-flight invocations). */
  readonly CANCELLED: 'cancelled';
} = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  ERROR: 'error',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled'
});

/**
 * Union type of all valid invocation lifecycle statuses.
 *
 * @example
 * ```typescript
 * import type { InvocationStatus } from './index.ts';
 *
 * function isSettled(status: InvocationStatus): boolean {
 *   return status === 'completed' || status === 'error' || status === 'timed_out' || status === 'cancelled';
 * }
 * ```
 */
export type InvocationStatus = typeof INVOCATION_STATUS[keyof typeof INVOCATION_STATUS];

/**
 * Canonical, immutable error code dictionary for subagent invocation operations.
 * Eliminates magic strings across runtime validation, tool descriptors, and telemetry.
 *
 * Only codes the engine itself emits on receipts and await results are listed.
 * Coordinator-level unavailability (a facade without a wired `InvocationEngine`)
 * is reported by `AgentRuntime` as `ERR_RUNTIME_NOT_INITIALIZED`, never here.
 *
 * @readonly
 * Enum of `string` values:
 * @example
 * ```typescript
 * import { INVOCATION_ERROR_CODES } from './index.ts';
 *
 * if (receipt.code === INVOCATION_ERROR_CODES.PERMISSION_DENIED) {
 *   console.warn('Caller lacked registry authority or parent authorization.');
 * }
 * ```
 */
export const INVOCATION_ERROR_CODES: {
  /** Missing required parameters such as `invokerId`, `targetAgentId`, `prompt`, or empty target IDs. */
  readonly INVALID_ARGUMENTS: 'INVALID_ARGUMENTS';
  /** The specified target agent does not exist in the agent registry. */
  readonly AGENT_NOT_FOUND: 'AGENT_NOT_FOUND';
  /** The target agent is terminated, recycled, or killed during in-flight turn execution. */
  readonly AGENT_TERMINATED: 'AGENT_TERMINATED';
  /** Caller is not authorized to invoke the target agent (must hold registry authority, be the parent creator, or be the target itself). */
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED';
  /** Nested subagent invocation depth exceeds `MAX_INVOCATION_DEPTH` (5). */
  readonly RECURSION_DEPTH_EXCEEDED: 'RECURSION_DEPTH_EXCEEDED';
  /** Turn-level await operation was explicitly aborted via `AbortSignal`. */
  readonly ABORTED: 'ABORTED';
} = Object.freeze({
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGENT_TERMINATED: 'AGENT_TERMINATED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  RECURSION_DEPTH_EXCEEDED: 'RECURSION_DEPTH_EXCEEDED',
  ABORTED: 'ABORTED'
});

/**
 * Union type of all valid invocation error codes.
 *
 * @example
 * ```typescript
 * import type { InvocationErrorCode } from './index.ts';
 *
 * function handleError(code: InvocationErrorCode): void {
 *   console.error(`Invocation failed with code: ${code}`);
 * }
 * ```
 */
export type InvocationErrorCode = typeof INVOCATION_ERROR_CODES[keyof typeof INVOCATION_ERROR_CODES];

// ============================================================================
// 2. Core Entities & Records
// ============================================================================

/**
 * Immutable snapshot of an invocation record stored in active or history ledgers.
 * Returned as defensive copies by `getInvocation`, `getActiveInvocations`, and `getInvocationHistory`.
 *
 * @example
 * ```typescript
 * import type { InvocationRecord } from './index.ts';
 *
 * const record: InvocationRecord = {
 *   invocationId: 'inv_10a2b3c4',
 *   invokerId: 'director',
 *   targetAgentId: 'critic',
 *   prompt: 'Review chapter 2',
 *   role: 'user',
 *   depth: 1,
 *   status: 'completed',
 *   startedAt: Date.now() - 2000,
 *   completedAt: Date.now(),
 *   output: 'The pacing is excellent.'
 * };
 * ```
 */
export interface InvocationRecord {
  /** Unique invocation UUID prefixed with `inv_`. */
  readonly invocationId: string;
  /** Agent ID of the invoker / caller initiating the invocation. */
  readonly invokerId: string;
  /** Agent ID of the target subroutine agent executing the prompt. */
  readonly targetAgentId: string;
  /** Instruction prompt dispatched to the target agent. */
  readonly prompt: string;
  /** Turn role assigned to the invocation context (`'user'` or `'system'`). */
  readonly role: 'user' | 'system';
  /** Recursion depth of this invocation (1 to 5). */
  readonly depth: number;
  /** Current lifecycle status of the invocation. */
  readonly status: InvocationStatus;
  /** Unix epoch timestamp (ms) when the invocation was created. */
  readonly startedAt: number;
  /** Unix epoch timestamp (ms) when the invocation settled (completed, errored, timed out, or cancelled). */
  readonly completedAt?: number;
  /** Terminal output string generated by the target agent upon successful completion. */
  readonly output?: string;
  /** Error message string if the invocation failed, timed out, or was cancelled. */
  readonly error?: string;
  /** Canonical error code string if the invocation was cancelled (e.g. `AGENT_TERMINATED`). */
  readonly code?: string;
}

/**
 * Minimal Agent Descriptor required by `InvocationEngine` for authority governance and lifecycle validation.
 *
 * @example
 * ```typescript
 * import type { AgentDescriptor } from './index.ts';
 *
 * const agent: AgentDescriptor = {
 *   id: 'analyst_1',
 *   state: 'idle',
 *   privileged: false,
 *   spawnedBy: 'director',
 *   role: 'worker'
 * };
 * ```
 */
export interface AgentDescriptor {
  /** Unique identifier of the agent. */
  readonly id: string;
  /** Lifecycle state string (e.g. `'idle'`, `'running'`, `'terminated'`, `'recycled'`). */
  readonly state?: string;
  /** Status string (e.g. `'active'`, `'terminated'`). */
  readonly status?: string;
  /** Boolean flag indicating if the agent has been terminated. */
  readonly terminated?: boolean;
  /**
   * Boolean flag indicating if the agent has elevated administrative/sudoer privileges.
   * @deprecated Legacy boolean privilege projection; ignored by the engine — authority resolves only through the injected `getAgentAuthority` registry resolver.
   */
  readonly privileged?: boolean;
  /** Agent role identifier (e.g. `'admin'`, `'director'`, `'worker'`); the name grants no authority. */
  readonly role?: string;
  /** Agent ID of the parent agent that spawned this agent (`null` when creator-less). */
  readonly spawnedBy?: string | null;
  /** Agent ID of the creator agent (`null` when creator-less). */
  readonly creatorId?: string | null;
  /** Nested configuration dictionary containing agent metadata. */
  readonly config?: {
    readonly role?: string;
    /** @deprecated Legacy boolean privilege input; ignored by the engine — authority resolves only through the injected `getAgentAuthority` registry resolver. */
    readonly privileged?: boolean;
    readonly spawnedBy?: string | null;
    readonly creatorId?: string | null;
  };
}

// ============================================================================
// 3. Dispatch & Execution Types
// ============================================================================

/**
 * Canonical options for configuring subagent invocation execution, authority, depth, and timeouts.
 *
 * @example
 * ```typescript
 * import type { InvokeAgentOptions } from './index.ts';
 *
 * const options: InvokeAgentOptions = {
 *   role: 'user',
 *   depth: 0,
 *   timeoutMs: 5000,
 *   isPrivileged: true
 * };
 * ```
 */
export interface InvokeAgentOptions {
  /**
   * Turn role assigned to the invocation execution context (metadata only).
   *
   * `'system'` selects a system turn; every other value (including `'admin'`)
   * executes as `'user'` and grants no authority. The invoker's registry
   * `AuthorityDescriptor` is the sole authority channel (MOD-21 W3).
   *
   * @defaultValue 'user'
   */
  readonly role?: 'user' | 'system' | 'admin';

  /**
   * Current caller recursion depth. Target agent executes at `depth + 1`.
   * A numeric value must be a non-negative integer; a non-numeric value falls back to
   * `recursionDepth` when numeric, otherwise to `0`.
   * @defaultValue 0
   */
  readonly depth?: number;

  /**
   * Legacy alias for `depth`, consulted only when `depth` is not numeric.
   */
  readonly recursionDepth?: number;

  /**
   * Optional timeout in milliseconds for the asynchronous microtask execution.
   * If the target does not finish within this duration, the invocation transitions to `'timed_out'`.
   * Only values greater than `0` arm the timer; `0` or negative values disable it.
   */
  readonly timeoutMs?: number;

  /**
   * Snake_case alias for `timeoutMs`.
   */
  readonly timeout_ms?: number;

  /**
   * Ignored: caller-asserted privilege grants no authority.
   * @deprecated Retained for wire compatibility; the frozen `AuthorityDescriptor` of the resolved invoker is the only authority channel (MOD-21 W3 enforcement).
   */
  readonly isPrivileged?: boolean;

  /**
   * Ignored alias of `isPrivileged`.
   * @deprecated Retained for wire compatibility; the frozen `AuthorityDescriptor` of the resolved invoker is the only authority channel (MOD-21 W3 enforcement).
   */
  readonly privileged?: boolean;

  /**
   * Ignored: the magic administrator claim grants no authority.
   * @deprecated Retained for wire compatibility; the frozen `AuthorityDescriptor` of the resolved invoker is the only authority channel (MOD-21 W3 enforcement).
   */
  readonly isAdmin?: boolean;

  /**
   * Ignored: caller-asserted roles grant no authority (role is metadata only).
   * @deprecated Retained for wire compatibility; the frozen `AuthorityDescriptor` of the resolved invoker is the only authority channel (MOD-21 W3 enforcement).
   */
  readonly callerRole?: string;
}

/**
 * Parameters when invoking a subagent via a single structured object.
 *
 * @example
 * ```typescript
 * import type { InvokeAgentParams } from './index.ts';
 *
 * const params: InvokeAgentParams = {
 *   invokerId: 'director',
 *   targetAgentId: 'critic',
 *   prompt: 'Critique the latest scene outline.',
 *   role: 'user',
 *   depth: 0
 * };
 * ```
 */
export interface InvokeAgentParams extends InvokeAgentOptions {
  /** Agent ID of the caller initiating the invocation. */
  readonly invokerId: string;
  /** Agent ID of the target subroutine agent to invoke. */
  readonly targetAgentId: string;
  /** Instruction or prompt to execute in the subagent's turn. */
  readonly prompt: string;
}

/**
 * Receipt returned on successful non-blocking dispatch of an invocation.
 *
 * @example
 * ```typescript
 * import type { InvocationReceiptSuccess } from './index.ts';
 *
 * const receipt: InvocationReceiptSuccess = {
 *   success: true,
 *   invocationId: 'inv_10a2b3c4',
 *   targetAgentId: 'critic',
 *   status: 'dispatched'
 * };
 * ```
 */
export interface InvocationReceiptSuccess {
  /** Indicates successful dispatch. */
  readonly success: true;
  /** Generated invocation identifier prefixed with `inv_`. */
  readonly invocationId: string;
  /** Target agent ID. */
  readonly targetAgentId: string;
  /** Immediate dispatch status. */
  readonly status: 'dispatched';
}

/**
 * Receipt returned when invocation dispatch is immediately rejected by pre-validation or security gates.
 *
 * @example
 * ```typescript
 * import type { InvocationReceiptFailure } from './index.ts';
 *
 * const failure: InvocationReceiptFailure = {
 *   success: false,
 *   error: 'Permission denied: caller not authorized',
 *   code: 'PERMISSION_DENIED'
 * };
 * ```
 */
export interface InvocationReceiptFailure {
  /** Indicates dispatch failure. */
  readonly success: false;
  /** Descriptive error message explaining rejection reason. */
  readonly error: string;
  /** Canonical error code (e.g. `INVALID_ARGUMENTS`, `AGENT_NOT_FOUND`, `AGENT_TERMINATED`, `PERMISSION_DENIED`, `RECURSION_DEPTH_EXCEEDED`). */
  readonly code: InvocationErrorCode;
}

/**
 * Discriminated union receipt returned synchronously by `invokeAgent`.
 *
 * @example
 * ```typescript
 * import type { InvocationReceipt } from './index.ts';
 *
 * function processReceipt(receipt: InvocationReceipt): void {
 *   if (receipt.success) {
 *     console.log(`Dispatched ${receipt.invocationId}`);
 *   } else {
 *     console.error(`Rejected: ${receipt.error} (${receipt.code})`);
 *   }
 * }
 * ```
 */
export type InvocationReceipt = InvocationReceiptSuccess | InvocationReceiptFailure;

// ============================================================================
// 4. Turn-Level Await Types
// ============================================================================

/**
 * Configuration options for the turn-level await primitive `waitForInvocation`.
 *
 * @example
 * ```typescript
 * import type { WaitForInvocationOptions } from './index.ts';
 *
 * const options: WaitForInvocationOptions = {
 *   timeoutMs: 5000,
 *   requireAll: true
 * };
 * ```
 */
export interface WaitForInvocationOptions {
  /**
   * Timeout in milliseconds before resolving with arrived partial results.
   * Non-negative integer. Negative, `NaN`, or non-numeric values fall back to `DEFAULT_INVOCATION_TIMEOUT_MS`.
   * @defaultValue 10000 (10 seconds)
   */
  readonly timeoutMs?: number;

  /**
   * Snake_case alias for `timeoutMs`.
   */
  readonly timeout_ms?: number;

  /**
   * If `true`, waits until all specified target invocations finish (barrier synchronization).
   * If `false`, resolves immediately upon the first completed/settled invocation (race / first-arrival).
   * @defaultValue true
   */
  readonly requireAll?: boolean;

  /**
   * Snake_case alias for `requireAll`.
   */
  readonly require_all?: boolean;

  /**
   * Cooperative cancellation signal. If the wait is still pending when the signal aborts, it resolves
   * immediately with `code: 'ABORTED'`. Already-satisfied waits take precedence: when all requested
   * targets (or at least one, with `requireAll: false`) are already settled in history at call time,
   * the wait resolves with those results even if the signal is already aborted.
   */
  readonly signal?: AbortSignal | null;
}

/**
 * Structured request envelope for `waitForInvocation`, supporting target ID property aliases.
 * ID aliases are consulted in the order `invocationIds`, `invocationId`, `ids`, `id`.
 *
 * @example
 * ```typescript
 * import type { WaitForInvocationRequest } from './index.ts';
 *
 * const request: WaitForInvocationRequest = {
 *   invocationIds: ['inv_1', 'inv_2'],
 *   timeoutMs: 8000,
 *   requireAll: true
 * };
 * ```
 */
export interface WaitForInvocationRequest extends WaitForInvocationOptions {
  /** Array of invocation IDs or single ID string to wait for. */
  readonly invocationIds?: string | readonly string[];
  /** Singular alias for `invocationIds`. */
  readonly invocationId?: string;
  /** Short array alias for `invocationIds`. */
  readonly ids?: readonly string[];
  /** Short singular alias for `invocationIds`. */
  readonly id?: string;
}

/**
 * Result outcome for an individual invocation target within `WaitForInvocationResult`.
 *
 * @example
 * ```typescript
 * import type { InvocationSingleResult } from './index.ts';
 *
 * const itemResult: InvocationSingleResult = {
 *   invocationId: 'inv_10a2b3c4',
 *   targetAgentId: 'critic',
 *   output: 'Plot structure is consistent.',
 *   status: 'completed',
 *   timedOut: false
 * };
 * ```
 */
export interface InvocationSingleResult {
  /** Invocation identifier. */
  readonly invocationId: string;
  /** Target agent ID that executed the invocation. */
  readonly targetAgentId: string;
  /** Generated output content from the subagent. Empty string if failed or timed out. */
  readonly output: string;
  /** Settled lifecycle status (`'completed'`, `'error'`, `'timed_out'`, `'cancelled'`). */
  readonly status: InvocationStatus;
  /** Flag indicating if this specific invocation timed out. */
  readonly timedOut: boolean;
  /** Error message if this invocation failed, timed out, or was cancelled. */
  readonly error?: string;
  /** Canonical error code if this invocation was cancelled (e.g. `AGENT_TERMINATED`). */
  readonly code?: string;
}

/**
 * Comprehensive turn-level await resolution envelope returned by `waitForInvocation`.
 * Preserves arrived partial results even if the timeout expires.
 *
 * @example
 * ```typescript
 * import type { WaitForInvocationResult } from './index.ts';
 *
 * const result: WaitForInvocationResult = {
 *   success: true,
 *   results: [{
 *     invocationId: 'inv_1',
 *     targetAgentId: 'critic',
 *     output: 'Approved.',
 *     status: 'completed',
 *     timedOut: false
 *   }],
 *   count: 1,
 *   timedOut: false,
 *   receivedIds: ['inv_1'],
 *   missingIds: []
 * };
 * ```
 */
export interface WaitForInvocationResult {
  /**
   * True if wait completed or timed out with partial results; false if invalid arguments or aborted.
   * Individual failed, timed-out, or cancelled results do not clear `success`.
   */
  readonly success: boolean;
  /** Array of individual invocation results that settled before resolution. */
  readonly results: readonly InvocationSingleResult[];
  /** Number of resolved invocation results. */
  readonly count: number;
  /** True if the operation timed out before all requested invocations finished. */
  readonly timedOut: boolean;
  /** Array of invocation IDs that were successfully received/resolved. */
  readonly receivedIds: readonly string[];
  /** Array of invocation IDs that did not finish before timeout or abort. */
  readonly missingIds: readonly string[];
  /** Error message if the operation failed, aborted, or contained errors. */
  readonly error?: string;
  /** Canonical error code (e.g. `INVALID_ARGUMENTS`, `ABORTED`, `AGENT_TERMINATED`). */
  readonly code?: string;
}

// ============================================================================
// 5. Streaming & Lifecycle Events
// ============================================================================

/**
 * Event payload emitted immediately when an invocation is initiated and queued.
 *
 * @example
 * ```typescript
 * import type { InvocationStartEvent } from './index.ts';
 *
 * function handleStart(evt: InvocationStartEvent): void {
 *   console.log(`Started ${evt.invocationId} for target ${evt.targetAgentId} at ${evt.timestamp}`);
 * }
 * ```
 */
export interface InvocationStartEvent {
  /** Unique invocation UUID. */
  readonly invocationId: string;
  /** Invoker agent ID. */
  readonly invokerId: string;
  /** Target agent ID. */
  readonly targetAgentId: string;
  /** Prompt dispatched to the target. */
  readonly prompt: string;
  /** Turn role (`'user'` | `'system'`). */
  readonly role: 'user' | 'system';
  /** Unix epoch timestamp (ms) when dispatched. */
  readonly timestamp: number;
}

/**
 * Event payload emitted on the dedicated secondary streaming channel when a subagent produces a token chunk.
 * Tagged strictly with `invocationId` to prevent mixing with user chat streams.
 *
 * @example
 * ```typescript
 * import type { InvocationChunkEvent } from './index.ts';
 *
 * function handleChunk(evt: InvocationChunkEvent): void {
 *   process.stdout.write(`[${evt.invocationId}] ${evt.chunk}`);
 * }
 * ```
 */
export interface InvocationChunkEvent {
  /** Unique invocation UUID. */
  readonly invocationId: string;
  /** Target agent ID generating the chunk. */
  readonly targetAgentId: string;
  /** Streamed text delta/chunk. */
  readonly chunk: string;
  /** Unix epoch timestamp (ms) when chunk was emitted. */
  readonly timestamp: number;
}

/**
 * Event payload emitted when an invocation reaches a terminal state (`completed`, `error`, `timed_out`, `cancelled`).
 *
 * @example
 * ```typescript
 * import type { InvocationCompleteEvent } from './index.ts';
 *
 * function handleComplete(evt: InvocationCompleteEvent): void {
 *   console.log(`Invocation ${evt.invocationId} settled with status ${evt.status}`);
 * }
 * ```
 */
export interface InvocationCompleteEvent {
  /** Unique invocation UUID. */
  readonly invocationId: string;
  /** Target agent ID. */
  readonly targetAgentId: string;
  /** Generated output content. */
  readonly output: string;
  /** Settled status. */
  readonly status: InvocationStatus;
  /** Unix epoch timestamp (ms) when settled. */
  readonly timestamp: number;
  /** Error message if failed, timed out, or cancelled. */
  readonly error?: string;
  /** Error code if the invocation was cancelled (e.g. `AGENT_TERMINATED`). */
  readonly code?: string;
}

/**
 * Idempotent unsubscribe function returned by event listener registrations.
 *
 * @example
 * ```typescript
 * const unsub = engine.onInvocationChunk(handler);
 * // Later when disposing:
 * unsub();
 * ```
 */
export type UnsubscribeFn = () => void;

// ============================================================================
// 6. Engine Configuration & Runtime Hooks
// ============================================================================

/**
 * Execution context passed to the `executeTurn` runtime hook during subagent execution.
 *
 * @example
 * ```typescript
 * import type { TurnExecutionContext } from './index.ts';
 *
 * async function customExecutor(targetId: string, prompt: string, ctx: TurnExecutionContext) {
 *   ctx.onChunk('Thinking...');
 *   return { output: `Completed for ${ctx.sender}` };
 * }
 * ```
 */
export interface TurnExecutionContext {
  /** Agent ID of the invoker. */
  readonly sender: string;
  /** Role of the turn (`'user'` or `'system'`). */
  readonly role: 'user' | 'system';
  /** Recursion depth of the target execution turn. */
  readonly depth: number;
  /** Execution metadata attached to the turn. */
  readonly metadata: {
    readonly invocationId: string;
    readonly invokerId: string;
    readonly depth: number;
    readonly [key: string]: unknown;
  };
  /**
   * Secondary streaming callback. Invoking this emits `InvocationChunkEvent` tagged with `invocationId`.
   * Calls after the invocation has settled are ignored.
   * @param chunk - Text chunk generated by LLM provider.
   */
  readonly onChunk: (chunk: string) => void;
}

/**
 * Async turn executor hook signature implemented by the runtime turn execution engine.
 *
 * @param targetAgentId - Target agent ID to execute.
 * @param prompt - Prompt instruction for the subagent.
 * @param context - Execution context with secondary streaming callback and depth metadata.
 * @returns Promise resolving to any result value. The engine normalizes the settled value:
 *   an object with `output` / `content` is preferred, then a raw string, then `String(result)`.
 * @example
 * ```typescript
 * import type { InvocationTurnExecutor } from './index.ts';
 *
 * const executor: InvocationTurnExecutor = async (targetId, prompt, ctx) => {
 *   ctx.onChunk('Working...');
 *   return { output: `Done: ${prompt}` };
 * };
 * ```
 */
export type InvocationTurnExecutor = (
  targetAgentId: string,
  prompt: string,
  context: TurnExecutionContext
) => Promise<unknown>;

/**
 * Agent lookup hook signature used for authority governance and lifecycle state validation.
 *
 * @param agentId - Agent ID to look up.
 * @returns AgentDescriptor or null if the agent does not exist.
 * @example
 * ```typescript
 * import type { AgentLookupFn } from './index.ts';
 *
 * const lookup: AgentLookupFn = (agentId) => registry.get(agentId) ?? null;
 * ```
 */
export type AgentLookupFn = (agentId: string) => AgentDescriptor | null;

/**
 * Agent lifecycle check hook signature to verify if an agent has been terminated.
 *
 * @param agentId - Agent ID to check.
 * @returns True if the agent is terminated, recycled, or dead; false otherwise.
 * @example
 * ```typescript
 * import type { AgentTerminatedFn } from './index.ts';
 *
 * const isTerminated: AgentTerminatedFn = (agentId) => terminatedSet.has(agentId);
 * ```
 */
export type AgentTerminatedFn = (agentId: string) => boolean;

/**
 * Registry authority resolver hook signature (MOD-21 W3).
 *
 * Returns the frozen `AuthorityDescriptor` registered for an invoker subject
 * (`allow` contains `'*'` or `'@lifecycle:authority'` for sudoer authority), or
 * `null` when the subject is unregistered/unknown (default-deny). Typed
 * structurally to keep this module a zero-import leaf.
 *
 * @example
 * ```typescript
 * import type { AgentAuthorityResolverFn } from './index.ts';
 *
 * const resolveAuthority: AgentAuthorityResolverFn =
 *   (agentId) => lifecycleManager.getAuthorityDescriptor(agentId);
 * ```
 */
export type AgentAuthorityResolverFn = (agentId: string) => {
  readonly subject?: string;
  readonly kind?: string;
  readonly allow?: ReadonlySet<string>;
  readonly visibility?: string;
} | null;

/**
 * Trusted Realm scope projection for one agent, resolved by the injected
 * `getAgentRealmScope` hook (Realm wave A, ticket 3487c56).
 *
 * Structural mirror declared locally to keep this module a zero-import leaf.
 * `realmId` is `null` for ungrouped (legacy) subjects and `realmBypass` is true
 * only for the hardcoded system director; the operator/engine branch of the
 * locked bypass rule is the opaque internal principal, matched by exact
 * reference through {@link InvocationEngineHooks.internalPrincipal}.
 *
 * @example
 * ```typescript
 * const scope: InvocationRealmScope = { realmId: 'story-a', realmBypass: false };
 * ```
 */
export interface InvocationRealmScope {
  /** Realm membership read from the trusted identity projection (`null` = ungrouped). */
  readonly realmId: string | null;
  /** True when the subject bypasses Realm scoping (hardcoded system director only). */
  readonly realmBypass: boolean;
}

/**
 * Realm scope resolver hook signature (Realm wave A).
 *
 * Implemented by the runtime facade over the injected identity port; returns
 * the trusted scope projection for an active agent id, or `null` when the
 * subject is unknown/recycled or no identity projection is wired. An absent
 * hook keeps the engine's legacy unscoped behavior.
 *
 * @example
 * ```typescript
 * const resolveRealmScope: AgentRealmScopeResolverFn = (agentId) => {
 *   const projection = identityPort.getAgentIdentity(agentId);
 *   return projection ? { realmId: projection.realmId, realmBypass: projection.realmBypass } : null;
 * };
 * ```
 */
export type AgentRealmScopeResolverFn = (agentId: string) => InvocationRealmScope | null;

/**
 * Trusted caller context for agent-facing awaits (Realm wave A, ticket
 * 3487c56). Identity-only: the facade/lifecycle port supplies it from trusted
 * construction, authority flags inside it are ignored, a `callerAgentId` is
 * resolved through the registry, and a `principal` is trusted only when it is
 * the exact injected internal principal or the registered descriptor instance
 * for its subject. Caller-supplied tool parameters can never mint one.
 *
 * @example
 * ```typescript
 * const caller: InvocationCallerContext = { callerAgentId: 'worker-1' };
 * ```
 */
export interface InvocationCallerContext {
  /** Registry-resolved caller subject claim; resolved through `getAgentAuthority` (default-deny when unknown). */
  readonly callerAgentId?: string;
  /**
   * Canonical internal identity `key` of the caller (Wave I, ticket d57cbc1).
   *
   * Trusted internal hint only: the facade/lifecycle port binds it from trusted
   * construction to disambiguate realm-local ids. It is resolved through the
   * injected `identityPort` (`listAgentIdentities()` `key` match), and the
   * caller is still authenticated through `getAgentAuthority`, so a forged key
   * grants nothing. Internal-only: never echoed to an agent.
   */
  readonly callerKey?: string;
  /** Trusted principal: the exact injected internal principal or a frozen registry `AuthorityDescriptor` instance. */
  readonly principal?: { readonly kind?: string; readonly subject?: string } | null;
}

/**
 * Structural mirror of the runtime `AgentIdentityProjection` consumed by the
 * invocation engine for bare-id projection and canonical identity comparison
 * (Wave I, ticket d57cbc1). Declared locally to keep this module a zero-import
 * leaf.
 */
export interface InvocationIdentityProjection {
  /** Registered (bare) agent identifier. */
  readonly id?: string;
  /** Canonical internal `(realmId, agentId)` key; opaque, compared only for equality. */
  readonly key?: string;
  /** Realm membership (`null` = ungrouped/system scope). */
  readonly realmId?: string | null;
  /** Whether the subject spans every Realm scope. */
  readonly realmBypass?: boolean;
}

/**
 * Optional trusted resolution scope for the injected `identityPort`. Structural
 * mirror of the runtime `AgentIdentityScope`.
 */
export interface InvocationIdentityScope {
  /** Realm membership to resolve exactly; `null` selects the system scope. */
  readonly realmId?: string | null;
  /** Resolve the unique match across every Realm. */
  readonly realmBypass?: boolean;
}

/**
 * Trusted identity resolver the composition root may inject for realm-local
 * identifier projection and canonical comparison (Wave I, ticket d57cbc1).
 * Structural mirror of the runtime `AgentIdentityPort`; absent keeps the
 * legacy bare-identifier behavior.
 */
export interface InvocationIdentityPort {
  /**
   * Resolves the identity projection of an agent identifier.
   *
   * @param agentId - Realm-local identifier or canonical key (opaque).
   * @param scope - Optional trusted resolution scope.
   * @returns Frozen projection or `null`.
   */
  getAgentIdentity(agentId: string, scope?: InvocationIdentityScope): InvocationIdentityProjection | null;
  /**
   * Optional enumeration used for canonical `key` matching; omitted ports keep
   * unique-match behavior.
   *
   * @param scope - Optional trusted resolution scope.
   * @returns Projections in registry order.
   */
  listAgentIdentities?(scope?: InvocationIdentityScope): InvocationIdentityProjection[];
}

/**
 * Dynamic runtime hook configuration for `InvocationEngine`.
 *
 * @example
 * ```typescript
 * import type { InvocationEngineHooks } from './index.ts';
 *
 * const hooks: InvocationEngineHooks = {
 *   executeTurn: async (targetId, prompt, ctx) => ({ output: 'OK' }),
 *   getAgent: (id) => ({ id, state: 'idle' }),
 *   isAgentTerminated: (id) => false,
 *   getAgentAuthority: (id) => registry.getAuthority(id)
 * };
 * ```
 */
export interface InvocationEngineHooks {
  /** Async turn execution engine hook. */
  readonly executeTurn?: InvocationTurnExecutor | null;
  /** Agent registry lookup hook. */
  readonly getAgent?: AgentLookupFn | null;
  /** Agent termination lifecycle check hook. */
  readonly isAgentTerminated?: AgentTerminatedFn | null;
  /** Registry authority resolver hook; absent means every invoker is anonymous (self/parent invocation only). */
  readonly getAgentAuthority?: AgentAuthorityResolverFn | null;
  /**
   * Realm scope resolver hook (Realm wave A, ticket 3487c56). Absent keeps the
   * legacy unscoped invocation and await behavior; when present, invocation
   * pairs are confined to one scope and await callers can resolve the
   * hardcoded director's `realmBypass`.
   */
  readonly getAgentRealmScope?: AgentRealmScopeResolverFn | null;
  /**
   * Trusted identity resolver for realm-local identifier projection (Wave I,
   * ticket d57cbc1). Optional and additive: absent keeps the legacy
   * bare-identifier behavior. When present, canonical keys resolve to their
   * bare `id` for receipts/records/events, and self/parent/await identity
   * comparisons match on `key` instead of the literal string.
   */
  readonly identityPort?: InvocationIdentityPort | null;
  /**
   * Exact injected engine principal (Realm wave A). Only this reference
   * satisfies the operator/engine branch of the locked Realm bypass rule in
   * {@link InvocationCallerContext.principal}; plain objects can never
   * impersonate it.
   */
  readonly internalPrincipal?: object | null;
}

/**
 * Construction options for `InvocationEngine`.
 *
 * @example
 * ```typescript
 * import type { InvocationEngineOptions } from './index.ts';
 *
 * const options: InvocationEngineOptions = {
 *   executeTurn: async (targetId, prompt, ctx) => ({ output: 'Done' }),
 *   getAgent: (id) => registry.get(id)
 * };
 * ```
 */
export interface InvocationEngineOptions extends InvocationEngineHooks {}

// ============================================================================
// 7. Public InvocationEngine Class
// ============================================================================

/**
 * Internal mutable projection of {@link InvocationRecord} used by the instance ledgers before
 * defensive copies are handed out; the public surface stays the readonly contract type.
 */
type MutableInvocationRecord = { -readonly [Key in keyof InvocationRecord]: InvocationRecord[Key] };

/**
 * Internal invocation record (Wave I, ticket d57cbc1): the public, agent-facing
 * fields (`invokerId`/`targetAgentId`) project the bare registered ids, while
 * the private opaque references supplied at dispatch are kept for
 * authorization, cancellation, and await authentication. The private fields are
 * stripped by every defensive copy accessor and never serialized to a receipt,
 * listing, event, or await result.
 */
interface EngineInvocationRecord extends MutableInvocationRecord {
  /** Opaque invoker reference as supplied (canonical key under wiring). */
  invokerIdentity: string;
  /** Opaque target reference as supplied (canonical key under wiring). */
  targetIdentity: string;
}

/**
 * Internal mutable projection of {@link WaitForInvocationResult} used while assembling the await envelope.
 */
type MutableWaitForInvocationResult = { -readonly [Key in keyof WaitForInvocationResult]: WaitForInvocationResult[Key] };

/**
 * Narrows a polymorphic await input to the structured request envelope form.
 * @param value - Candidate await input.
 * @returns True when `value` is a non-array object envelope.
 */
function isWaitRequestEnvelope(
  value: string | readonly string[] | WaitForInvocationRequest
): value is WaitForInvocationRequest {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a thrown value into a record error message: a non-empty string `message`
 * property wins, otherwise the value is stringified.
 *
 * @param err - Value caught from a failed turn execution.
 * @returns Human-readable error message.
 */
function resolveErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const message: unknown = err.message;
    if (typeof message === 'string' && message) return message;
  }
  return String(err);
}

/**
 * Builds the fail-closed await envelope returned when the trusted caller
 * channel denies the wait (Realm wave A, ticket 3487c56).
 *
 * @param error - Human-readable denial message.
 * @returns A `PERMISSION_DENIED` await result with empty result arrays.
 * @internal
 */
function deniedWaitResult(error: string): WaitForInvocationResult {
  return {
    success: false,
    error,
    code: INVOCATION_ERROR_CODES.PERMISSION_DENIED,
    results: [],
    count: 0,
    timedOut: false,
    receivedIds: [],
    missingIds: []
  };
}

/**
 * Standalone Subagent Invocation Engine & Secondary Streaming Subsystem.
 *
 * Enforces the sandbox invocation invariants — invocations are not messages and never route through
 * `MessagingBus`, and `waitForInvocation` is the turn-level await primitive — within the ai-story
 * sandbox architecture.
 *
 * @example Basic Invocation & Turn-Level Await Workflow
 * ```typescript
 * import { InvocationEngine, INVOCATION_STATUS } from './index.ts';
 *
 * const engine = new InvocationEngine({
 *   getAgent: (id) => ({ id, state: 'idle', privileged: id === 'director' }),
 *   executeTurn: async (targetId, prompt, ctx) => {
 *     ctx.onChunk('Processing...');
 *     return { output: `Analysis complete for: ${prompt}` };
 *   }
 * });
 *
 * // Subscribe to isolated secondary token stream
 * const unsub = engine.onInvocationChunk((evt) => {
 *   console.log(`[Stream] ${evt.invocationId}: ${evt.chunk}`);
 * });
 *
 * // Dispatch invocation non-blockingly
 * const receipt = engine.invokeAgent({
 *   invokerId: 'director',
 *   targetAgentId: 'researcher',
 *   prompt: 'Summarize scene 3'
 * });
 *
 * if (receipt.success) {
 *   // Await resolution in turn execution
 *   const result = await engine.waitForInvocation(receipt.invocationId, { timeoutMs: 5000 });
 *   console.log('Output:', result.results[0]?.output);
 * }
 * unsub();
 * ```
 */
export class InvocationEngine {
  #executeTurn: InvocationTurnExecutor | null = null;

  #getAgent: AgentLookupFn | null = null;

  #isAgentTerminated: AgentTerminatedFn | null = null;

  #getAgentAuthority: AgentAuthorityResolverFn | null = null;

  #getAgentRealmScope: AgentRealmScopeResolverFn | null = null;

  #identityPort: InvocationIdentityPort | null = null;

  #internalPrincipal: object | null = null;

  #activeInvocations: Map<string, EngineInvocationRecord> = new Map();

  #invocationHistory: Map<string, EngineInvocationRecord> = new Map();

  #chunkListeners: Set<(chunkEvent: InvocationChunkEvent) => void>;

  #completeListeners: Set<(completeEvent: InvocationCompleteEvent) => void>;

  #startListeners: Set<(startEvent: InvocationStartEvent) => void>;

  #pendingWaiters: Map<string, Set<(completeEvent: InvocationCompleteEvent) => void>> = new Map();

  #dispatchControls: Map<string, { settle: () => void }> = new Map();

  /**
   * Initializes a new `InvocationEngine` instance with optional runtime hooks.
   *
   * @param options - Initial hooks and configuration.
   * @example
   * ```typescript
   * const engine = new InvocationEngine({
   *   getAgent: (id) => registry.get(id),
   *   isAgentTerminated: (id) => registry.isTerminated(id),
   *   executeTurn: (targetId, prompt, ctx) => turnEngine.execute(targetId, prompt, ctx)
   * });
   * ```
   */
  constructor(options: InvocationEngineOptions = {}) {
    this.#executeTurn = options.executeTurn || null;
    this.#getAgent = options.getAgent || null;
    this.#isAgentTerminated = options.isAgentTerminated || null;
    this.#getAgentAuthority = options.getAgentAuthority || null;
    this.#getAgentRealmScope = options.getAgentRealmScope || null;
    this.#identityPort = options.identityPort && typeof options.identityPort.getAgentIdentity === 'function'
      ? options.identityPort
      : null;
    this.#internalPrincipal = options.internalPrincipal || null;

    this.#activeInvocations = new Map();

    this.#invocationHistory = new Map();

    this.#chunkListeners = new Set();

    this.#completeListeners = new Set();

    this.#startListeners = new Set();

    this.#pendingWaiters = new Map();

    this.#dispatchControls = new Map();
  }

  /**
   * Dynamically configures or updates runtime execution hooks.
   * Only properties present in `hooks` (not `undefined`) are applied; setting a property to `null`
   * clears the corresponding hook, and a non-object argument is ignored.
   *
   * @param hooks - Updated runtime hooks (`executeTurn`, `getAgent`, `isAgentTerminated`).
   * @returns void
   * @example
   * ```typescript
   * engine.setRuntimeHooks({
   *   executeTurn: async (targetId, prompt, ctx) => {
   *     return { output: `Processed: ${prompt}` };
   *   }
   * });
   * ```
   */
  setRuntimeHooks(hooks: InvocationEngineHooks = {}) {
    if (hooks && typeof hooks === 'object') {
      if (hooks.executeTurn !== undefined) this.#executeTurn = hooks.executeTurn;
      if (hooks.getAgent !== undefined) this.#getAgent = hooks.getAgent;
      if (hooks.isAgentTerminated !== undefined) this.#isAgentTerminated = hooks.isAgentTerminated;
      if (hooks.getAgentAuthority !== undefined) this.#getAgentAuthority = hooks.getAgentAuthority;
      if (hooks.getAgentRealmScope !== undefined) this.#getAgentRealmScope = hooks.getAgentRealmScope;
      if (hooks.identityPort !== undefined) this.#identityPort = hooks.identityPort;
      if (hooks.internalPrincipal !== undefined) this.#internalPrincipal = hooks.internalPrincipal;
    }
  }

  /**
   * Resolves the trusted Realm scope projection for an agent through the
   * injected hook (Realm wave A, ticket 3487c56).
   *
   * @param agentId - Agent subject to resolve.
   * @returns The normalized scope projection, or `null` when no hook is wired,
   *   the projection is absent, or the hook throws (legacy unscoped behavior).
   * @internal
   */
  #resolveAgentRealmScope(agentId: string): InvocationRealmScope | null {
    if (typeof this.#getAgentRealmScope !== 'function') return null;
    try {
      const scope = this.#getAgentRealmScope(agentId);
      if (!scope || typeof scope !== 'object') return null;
      const rawRealmId = scope.realmId;
      return {
        realmId: typeof rawRealmId === 'string' && rawRealmId ? rawRealmId : null,
        realmBypass: scope.realmBypass === true
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolves a registry `AuthorityDescriptor` for a subject through the
   * injected resolver, reporting failures as `null` (default-deny).
   *
   * @param agentId - Agent subject to resolve.
   * @returns The registered descriptor instance, or `null` when unknown.
   * @internal
   */
  #resolveRegisteredAuthority(agentId: string): { readonly kind?: string; readonly subject?: string } | null {
    if (typeof this.#getAgentAuthority !== 'function') return null;
    try {
      const descriptor = this.#getAgentAuthority(agentId);
      return descriptor && typeof descriptor === 'object' ? descriptor : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves an identifier through the optional injected identity port
   * (Wave I, ticket d57cbc1): canonical `key` match over
   * `listAgentIdentities()` first, then the port's own `getAgentIdentity`
   * resolution. Returns `null` when no port is wired or nothing resolves.
   *
   * @param identifier - Agent identifier or canonical key (opaque)
   * @param scope - Optional trusted resolution scope
   * @returns The resolved projection or `null`
   * @internal
   */
  #resolveIdentity(identifier: string, scope?: InvocationIdentityScope): InvocationIdentityProjection | null {
    if (typeof identifier !== 'string' || !identifier) return null;
    const port = this.#identityPort;
    if (!port) return null;
    if (typeof port.listAgentIdentities === 'function') {
      try {
        const projections = port.listAgentIdentities();
        if (Array.isArray(projections)) {
          let match: InvocationIdentityProjection | null = null;
          for (const projection of projections) {
            if (!projection || typeof projection !== 'object') continue;
            if (projection.key !== identifier) continue;
            if (match) return null;
            match = projection;
          }
          if (match) return match;
        }
      } catch {
        // Fall through to the port's own resolution.
      }
    }
    if (typeof port.getAgentIdentity !== 'function') return null;
    try {
      const projection = scope === undefined
        ? port.getAgentIdentity(identifier)
        : port.getAgentIdentity(identifier, scope);
      return projection && typeof projection === 'object' ? projection : null;
    } catch {
      return null;
    }
  }

  /**
   * Projects the bare registered id of an opaque identifier for receipts,
   * records, and streamed events (Wave I, ticket d57cbc1): the already-resolved
   * descriptor id, else the identity port's projection `id`, else the registry
   * lookup, else the reference verbatim (legacy/standalone hosts).
   *
   * @param reference - Opaque identifier as supplied
   * @param descriptor - Optional already-fetched agent descriptor
   * @returns The bare registered id, or the reference verbatim
   * @internal
   */
  #displayAgentId(reference: string, descriptor?: AgentDescriptor | null): string {
    if (descriptor && typeof descriptor.id === 'string' && descriptor.id) return descriptor.id;
    const projection = this.#resolveIdentity(reference);
    if (projection && typeof projection.id === 'string' && projection.id) return projection.id;
    if (typeof this.#getAgent === 'function') {
      try {
        const agent = this.#getAgent(reference);
        if (agent && typeof agent.id === 'string' && agent.id) return agent.id;
      } catch {
        // Best-effort display resolution only.
      }
    }
    return reference;
  }

  /**
   * Whether two opaque identifiers name the same agent (Wave I, ticket
   * d57cbc1): literal equality first, then canonical `key` equality through
   * the identity port. Without a port (or without projections) only the
   * literal rule applies, preserving the legacy behavior.
   *
   * @param first - First opaque identifier
   * @param second - Second opaque identifier
   * @returns Whether both identify the same registration
   * @internal
   */
  #sameAgentIdentity(first: string, second: string): boolean {
    if (first === second) return true;
    const firstProjection = this.#resolveIdentity(first);
    if (!firstProjection || typeof firstProjection.key !== 'string' || !firstProjection.key) return false;
    const secondProjection = this.#resolveIdentity(second);
    return Boolean(secondProjection && secondProjection.key === firstProjection.key);
  }

  /**
   * Whether a descriptor-carried family reference (e.g. `spawnedBy`) names the
   * given invoker identity, comparing canonical keys when the identity port can
   * resolve both (Wave I, ticket d57cbc1).
   *
   * @param reference - Descriptor reference value (may be absent)
   * @param invoker - Opaque invoker identifier
   * @returns Whether the reference identifies the invoker
   * @internal
   */
  #referenceIsInvoker(reference: unknown, invoker: string): boolean {
    return typeof reference === 'string' && reference !== '' && this.#sameAgentIdentity(reference, invoker);
  }

  /**
   * Resolves the trusted await caller from the facade/port-supplied context.
   *
   * Trust rules (identity-only, default-deny):
   * - the exact injected `internalPrincipal` reference is the operator/engine
   *   bypass;
   * - a `principal` carrying `kind: 'agent'` is honored only when it IS the
   *   registered descriptor instance for its subject;
   * - a `callerKey` is honored only when the registry authority resolver
   *   resolves it (a forged key grants nothing), falling back to a
   *   `callerAgentId` the registry resolves;
   * - everything else (empty/forged contexts, unknown ids, flag bundles)
   *   resolves to `null` and fails the caller-scoped await closed.
   *
   * Canonical projection (Wave I, ticket d57cbc1): the resolved caller carries
   * the opaque identity reference used for record comparison plus the bare
   * `displayId`; `strict` marks a caller reference the identity port resolved
   * as a canonical key, so the bare-display fallback never authorizes a
   * cross-Realm same-literal-id match.
   *
   * @param callerContext - Facade/port-supplied trusted caller context.
   * @returns The resolved caller, or `null` when unauthenticated.
   * @internal
   */
  #resolveAwaitCaller(
    callerContext: InvocationCallerContext
  ): { identityRef: string | null; displayId: string | null; strict: boolean; bypass: boolean } | null {
    const principal = callerContext.principal;
    if (principal && typeof principal === 'object' && this.#internalPrincipal && principal === this.#internalPrincipal) {
      return { identityRef: null, displayId: null, strict: true, bypass: true };
    }

    let claimed: string;
    if (principal && typeof principal === 'object' && principal.kind === 'agent' && typeof principal.subject === 'string' && principal.subject) {
      const registered = this.#resolveRegisteredAuthority(principal.subject);
      if (!registered || registered !== principal) return null;
      claimed = principal.subject;
    } else {
      const callerKey = typeof callerContext.callerKey === 'string' && callerContext.callerKey ? callerContext.callerKey : '';
      if (callerKey && this.#resolveRegisteredAuthority(callerKey)) {
        claimed = callerKey;
      } else {
        const callerAgentId = typeof callerContext.callerAgentId === 'string' ? callerContext.callerAgentId : '';
        if (!callerAgentId || !this.#resolveRegisteredAuthority(callerAgentId)) return null;
        claimed = callerAgentId;
      }
    }

    const projection = this.#resolveIdentity(claimed);
    const strict = Boolean(projection && typeof projection.key === 'string' && projection.key === claimed);
    const displayId = projection && typeof projection.id === 'string' && projection.id ? projection.id : claimed;
    const scope = this.#resolveAgentRealmScope(claimed);
    return { identityRef: claimed, displayId, strict, bypass: scope?.realmBypass === true };
  }

  /**
   * Dispatches a subagent invocation non-blockingly using a structured parameter object.
   *
   * Synchronously evaluates pre-conditions and security authority gates, in this order:
   * 1. **Argument Check:** `invokerId` and `targetAgentId` must be non-empty strings; `prompt` must not be `undefined`, `null`, or a blank string (any other value, including a non-string, is accepted and coerced later with `String()`). Rejects with `INVALID_ARGUMENTS`.
   * 2. **Lifecycle Check:** Target must not be terminated or recycled. Rejects with `AGENT_TERMINATED`.
   * 3. **Agent Existence:** Target must exist in registry if `getAgent` hook configured. Rejects with `AGENT_NOT_FOUND`.
   * 4. **Authority Security Check:** The invoker's registry `AuthorityDescriptor` (via the injected `getAgentAuthority` resolver) must allow `'*'` or `'@lifecycle:authority'`, or the caller must be the parent creator (`spawnedBy`/`creatorId`) or the target itself. Magic ids, flags, and roles grant nothing. Rejects with `PERMISSION_DENIED`.
   * 5. **Hard Recursion Guard:** The effective incoming depth is `depth` when numeric, otherwise `recursionDepth` when numeric, otherwise `0`. A numeric value must be a non-negative integer (`0`–`4`) and satisfy `depth < 5` and `depth + 1 <= 5`. Rejects with `INVALID_ARGUMENTS` for a malformed numeric depth and `RECURSION_DEPTH_EXCEEDED` for the limit.
   *
   * On successful validation, returns an immediate `{ success: true, invocationId, targetAgentId, status: 'dispatched' }`
   * receipt and queues turn execution on the microtask queue.
   *
   * Never throws; every synchronous rejection is returned as a failure receipt.
   *
   * @param params - Structured invocation parameters.
   * @returns Immediate invocation receipt (success or failure).
   *
   * @example
   * ```typescript
   * const receipt = engine.invokeAgent({
   *   invokerId: 'director',
   *   targetAgentId: 'critic',
   *   prompt: 'Critique the draft',
   *   role: 'user',
   *   depth: 0,
   *   timeoutMs: 8000
   * });
   * if (!receipt.success) {
   *   console.error(`Dispatch failed: ${receipt.error} [${receipt.code}]`);
   * }
   * ```
   */
  invokeAgent(params: InvokeAgentParams): InvocationReceipt;

  /**
   * Dispatches a subagent invocation non-blockingly using positional arguments.
   *
   * @param invokerId - Agent ID of the caller initiating the invocation.
   * @param targetAgentId - Agent ID of the target subroutine agent to invoke.
   * @param prompt - Instruction or prompt to execute in the subagent turn.
   * @param options - Optional execution options (depth, role, timeout, authority).
   * @returns Immediate invocation receipt (success or failure).
   *
   * @example
   * ```typescript
   * const receipt = engine.invokeAgent('director', 'editor', 'Proofread chapter 1', {
   *   isPrivileged: true,
   *   depth: 1
   * });
   * ```
   */
  invokeAgent(
    invokerId: string,
    targetAgentId: string,
    prompt: string,
    options?: InvokeAgentOptions
  ): InvocationReceipt;

  invokeAgent(
    invokerIdOrParams: InvokeAgentParams | string,
    targetAgentId?: string,
    prompt?: string,
    options: InvokeAgentOptions = {}
  ): InvocationReceipt {
    let invokerId = invokerIdOrParams;
    let actualTargetAgentId = targetAgentId;
    let actualPrompt = prompt;
    let actualOptions = options;

    if (invokerIdOrParams && typeof invokerIdOrParams === 'object') {
      invokerId = invokerIdOrParams.invokerId;
      actualTargetAgentId = invokerIdOrParams.targetAgentId;
      actualPrompt = invokerIdOrParams.prompt;
      actualOptions = invokerIdOrParams;
    }

    if (!invokerId || typeof invokerId !== 'string' || !invokerId.trim()) {
      return {
        success: false,
        error: "Missing required string 'invokerId'",
        code: INVOCATION_ERROR_CODES.INVALID_ARGUMENTS
      };
    }
    if (!actualTargetAgentId || typeof actualTargetAgentId !== 'string' || !actualTargetAgentId.trim()) {
      return {
        success: false,
        error: "Missing required string 'targetAgentId'",
        code: INVOCATION_ERROR_CODES.INVALID_ARGUMENTS
      };
    }
    if (actualPrompt === undefined || actualPrompt === null || (typeof actualPrompt === 'string' && !actualPrompt.trim())) {
      return {
        success: false,
        error: "Missing required 'prompt'",
        code: INVOCATION_ERROR_CODES.INVALID_ARGUMENTS
      };
    }

    // Bare-id projection (Wave I, ticket d57cbc1): every agent-facing message
    // and receipt below reports the bare registered id, never the opaque
    // (possibly canonical) reference that reached this engine.
    const targetDisplayId = this.#displayAgentId(actualTargetAgentId);
    const invokerDisplayId = this.#displayAgentId(invokerId);

    // Agent lifecycle check: terminated status
    if (typeof this.#isAgentTerminated === 'function' && this.#isAgentTerminated(actualTargetAgentId)) {
      return {
        success: false,
        error: `Cannot invoke terminated agent '${targetDisplayId}'`,
        code: INVOCATION_ERROR_CODES.AGENT_TERMINATED
      };
    }

    let targetAgent: AgentDescriptor | null = null;
    if (typeof this.#getAgent === 'function') {
      targetAgent = this.#getAgent(actualTargetAgentId);
      if (!targetAgent) {
        return {
          success: false,
          error: `Target agent '${targetDisplayId}' not found`,
          code: INVOCATION_ERROR_CODES.AGENT_NOT_FOUND
        };
      }
      if (
        targetAgent.state === 'terminated' ||
        targetAgent.state === 'recycled' ||
        targetAgent.terminated === true ||
        (typeof targetAgent.status === 'string' && targetAgent.status.toLowerCase() === 'terminated')
      ) {
        return {
          success: false,
          error: `Cannot invoke terminated agent '${targetDisplayId}'`,
          code: INVOCATION_ERROR_CODES.AGENT_TERMINATED
        };
      }
    }

    // Security Authority Governance (MOD-21, default-deny): invoker authority
    // comes exclusively from the registry `AuthorityDescriptor` of the resolved
    // invoker. Magic invoker ids (`director`/`admin`), caller-supplied roles,
    // and privilege flags grant nothing.
    const invokerAuthority = typeof this.#getAgentAuthority === 'function'
      ? this.#getAgentAuthority(invokerId)
      : null;
    const invokerAllow = invokerAuthority?.allow;

    const isSudoer = Boolean(
      invokerAllow && (invokerAllow.has('*') || invokerAllow.has('@lifecycle:authority'))
    );

    // Identity comparison (Wave I, ticket d57cbc1): literal equality first, then
    // canonical `key` equality through the optional injected identity port, so
    // a canonical invoker/target pair still resolves self and parent relations.
    const isSelf = this.#sameAgentIdentity(actualTargetAgentId, invokerId);

    const isParent = Boolean(
      targetAgent && (
        this.#referenceIsInvoker(targetAgent.config?.spawnedBy, invokerId) ||
        this.#referenceIsInvoker(targetAgent.config?.creatorId, invokerId) ||
        this.#referenceIsInvoker(targetAgent.spawnedBy, invokerId) ||
        this.#referenceIsInvoker(targetAgent.creatorId, invokerId)
      )
    );

    if (!isSudoer && !isSelf && !isParent) {
      return {
        success: false,
        error: `Permission denied: agent '${invokerDisplayId}' cannot invoke arbitrary peer agent '${targetDisplayId}' (must be sudoer or parent creator. Use 'messaging_sendMessage' to message peer agents)`,
        code: INVOCATION_ERROR_CODES.PERMISSION_DENIED
      };
    }

    // Realm confinement, one-way bypass (Realm wave A, ticket 3487c56; Realm
    // wave R, ticket cf0e127): a cross-scope pair is denied fail-closed even
    // for wildcard/privileged invokers. Self/parent relations inside one scope
    // are unaffected; the ungrouped `null` scope is shared by legacy subjects;
    // a `realmBypass` invoker (operator/director) spans every scope, while a
    // non-bypass invoker can never target a bypass subject — there is no reply
    // path into the system scope. An absent scope projection keeps the legacy
    // unscoped behavior.
    const invokerRealmScope = this.#resolveAgentRealmScope(invokerId);
    const targetRealmScope = this.#resolveAgentRealmScope(actualTargetAgentId);
    if (
      invokerRealmScope && targetRealmScope
      && invokerRealmScope.realmBypass !== true
      && (targetRealmScope.realmBypass === true || invokerRealmScope.realmId !== targetRealmScope.realmId)
    ) {
      return {
        success: false,
        error: `Permission denied: agent '${invokerDisplayId}' cannot invoke agent '${targetDisplayId}' across Realm scopes`,
        code: INVOCATION_ERROR_CODES.PERMISSION_DENIED
      };
    }

    // Recursion Depth Guard (lower bound 0, resulting depth 1 to 5)
    const incomingDepth = typeof actualOptions?.depth === 'number'
      ? actualOptions.depth
      : (typeof actualOptions?.recursionDepth === 'number' ? actualOptions.recursionDepth : 0);
    if (!Number.isInteger(incomingDepth) || incomingDepth < 0) {
      return {
        success: false,
        error: "Invalid 'depth': must be a non-negative integer",
        code: INVOCATION_ERROR_CODES.INVALID_ARGUMENTS
      };
    }
    const depth = incomingDepth + 1;
    if (incomingDepth >= MAX_INVOCATION_DEPTH || depth > MAX_INVOCATION_DEPTH) {
      return {
        success: false,
        error: `Recursion depth limit exceeded (max ${MAX_INVOCATION_DEPTH})`,
        code: INVOCATION_ERROR_CODES.RECURSION_DEPTH_EXCEEDED
      };
    }

    const invocationId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? `inv_${crypto.randomUUID()}`
      : `inv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const role = (actualOptions?.role === 'system') ? 'system' : 'user';
    const startedAt = Date.now();

    const record: EngineInvocationRecord = {
      invocationId,
      invokerId: invokerDisplayId,
      targetAgentId: targetDisplayId,
      prompt: String(actualPrompt),
      role,
      depth,
      status: INVOCATION_STATUS.PENDING,
      startedAt,
      invokerIdentity: invokerId,
      targetIdentity: actualTargetAgentId
    };

    this.#activeInvocations.set(invocationId, record);

    this.#emitStart({
      invocationId,
      invokerId: invokerDisplayId,
      targetAgentId: targetDisplayId,
      prompt: record.prompt,
      role: record.role,
      timestamp: startedAt
    });

    const invocationTimeoutMs = typeof actualOptions?.timeoutMs === 'number'
      ? actualOptions.timeoutMs
      : (typeof actualOptions?.timeout_ms === 'number' ? actualOptions.timeout_ms : null);

    // Asynchronous non-blocking dispatch via microtask
    queueMicrotask(async () => {
      let isSettled = false;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      /** Cancellation may land at any point; never resurrect the record. */
      const isCancelled = () => record.status === INVOCATION_STATUS.CANCELLED;

      // Cancellation may land before the microtask runs; never resurrect the record.
      if (!this.#activeInvocations.has(invocationId) || isCancelled()) return;

      const settleDispatch = () => {
        isSettled = true;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        this.#dispatchControls.delete(invocationId);
      };

      this.#dispatchControls.set(invocationId, { settle: settleDispatch });

      if (typeof invocationTimeoutMs === 'number' && invocationTimeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          if (isSettled || !this.#activeInvocations.has(invocationId) || isCancelled()) return;
          settleDispatch();
          record.status = INVOCATION_STATUS.TIMED_OUT;
          record.error = `Invocation timed out after ${invocationTimeoutMs}ms`;
          record.completedAt = Date.now();

          this.#activeInvocations.delete(invocationId);
          this.#invocationHistory.set(invocationId, { ...record });

          this.#emitComplete({
            invocationId,
            targetAgentId: record.targetAgentId,
            output: '',
            error: record.error,
            status: INVOCATION_STATUS.TIMED_OUT,
            timestamp: record.completedAt
          });
        }, invocationTimeoutMs);
      }

      record.status = INVOCATION_STATUS.RUNNING;

      try {
        let output = '';
        if (typeof this.#executeTurn === 'function') {
          const turnResult: unknown = await this.#executeTurn(actualTargetAgentId, record.prompt, {
            sender: invokerId,
            role: record.role,
            depth,
            metadata: { invocationId, invokerId, depth },
            onChunk: (chunk) => {
              if (isSettled || !this.#activeInvocations.has(invocationId) || isCancelled()) return;
              this.#emitChunk({
                invocationId,
                targetAgentId: record.targetAgentId,
                chunk,
                timestamp: Date.now()
              });
            }
          });

          if (turnResult && (typeof turnResult === 'object' || typeof turnResult === 'function')) {
            if ('output' in turnResult && turnResult.output !== undefined && turnResult.output !== null) {
              output = String(turnResult.output);
            } else if ('content' in turnResult && turnResult.content !== undefined && turnResult.content !== null) {
              output = String(turnResult.content);
            } else {
              output = String(turnResult);
            }
          } else if (typeof turnResult === 'string') {
            output = turnResult;
          } else if (turnResult !== undefined && turnResult !== null) {
            output = String(turnResult);
          }
        }

        if (isSettled || !this.#activeInvocations.has(invocationId) || isCancelled()) return;
        settleDispatch();

        record.status = INVOCATION_STATUS.COMPLETED;
        record.output = output;
        record.completedAt = Date.now();

        this.#activeInvocations.delete(invocationId);
        this.#invocationHistory.set(invocationId, { ...record });

        this.#emitComplete({
          invocationId,
          targetAgentId: record.targetAgentId,
          output,
          status: INVOCATION_STATUS.COMPLETED,
          timestamp: record.completedAt
        });
      } catch (err) {
        if (isSettled || !this.#activeInvocations.has(invocationId) || isCancelled()) return;
        settleDispatch();

        record.status = INVOCATION_STATUS.ERROR;
        record.error = resolveErrorMessage(err);
        record.completedAt = Date.now();

        this.#activeInvocations.delete(invocationId);
        this.#invocationHistory.set(invocationId, { ...record });

        this.#emitComplete({
          invocationId,
          targetAgentId: record.targetAgentId,
          output: '',
          error: record.error,
          status: INVOCATION_STATUS.ERROR,
          timestamp: record.completedAt
        });
      }
    });

    return {
      success: true,
      invocationId,
      targetAgentId: targetDisplayId,
      status: 'dispatched'
    };
  }

  /**
   * Cancels all pending/active invocations involving an agent (as invoker or target).
   * Called during agent termination and recycling; emergency unstick does not
   * call this method and settles in-flight invocations through the turn abort
   * path instead.
   *
   * Settles cancelled records with `status: 'cancelled'`, `code: 'AGENT_TERMINATED'`, and moves them
   * to history while notifying any pending waiters immediately. Cancellation is final: the armed
   * per-invocation timeout (if any) is cleared, and late turn results or streaming chunks are suppressed.
   *
   * @param agentId - Agent ID (or canonical identity key) of the terminated or
   *   recycled agent; non-string or blank values match nothing. Matching is
   *   realm-exact when the reference is canonical: the stored opaque identity
   *   refs are compared first (Wave I, ticket d57cbc1), and only when the
   *   reference is not itself a stored identity ref does the bare-display
   *   fallback apply for legacy/pre-wiring callers.
   * @param reason - Optional cancellation reason string. When supplied and different from `AGENT_TERMINATED`,
   *   it becomes the cancelled record's `error` message; otherwise the default message is used.
   * @returns Array of cancelled invocation IDs; empty when no matching invocation is in flight.
   *
   * @example
   * ```typescript
   * const cancelledIds = engine.cancelPendingInvocationsForAgent('crashed_agent', 'Unresponsive agent killed');
   * console.log(`Cancelled ${cancelledIds.length} in-flight invocations.`);
   * ```
   */
  cancelPendingInvocationsForAgent(agentId: string, reason: string = INVOCATION_ERROR_CODES.AGENT_TERMINATED) {
    if (!agentId || typeof agentId !== 'string') return [];
    const cancelledIds: string[] = [];
    const normalizedId = agentId.trim();
    const referenceProjection = this.#resolveIdentity(normalizedId);
    const canonicalReference = referenceProjection && typeof referenceProjection.key === 'string'
      ? referenceProjection.key
      : null;

    for (const [invId, record] of this.#activeInvocations.entries()) {
      // Canonical identity refs match first and realm-exactly. The bare-display
      // fallback applies only to records that were themselves dispatched with a
      // bare reference (legacy/pre-wiring callers), so a bare teardown can never
      // reach a record whose identity is a canonical key of another Realm.
      const legacyMatch =
        (record.invokerIdentity === record.invokerId && record.invokerId === normalizedId)
        || (record.targetIdentity === record.targetAgentId && record.targetAgentId === normalizedId);
      const namesAgent = record.targetIdentity === normalizedId
        || record.invokerIdentity === normalizedId
        || (canonicalReference !== null && (record.targetIdentity === canonicalReference || record.invokerIdentity === canonicalReference))
        || legacyMatch;
      if (namesAgent) {
        // Settle the dispatch closure first: marks it settled and clears any armed timeout timer.
        const control = this.#dispatchControls.get(invId);
        if (control) control.settle();

        this.#activeInvocations.delete(invId);
        record.status = INVOCATION_STATUS.CANCELLED;
        record.error = typeof reason === 'string' && reason !== INVOCATION_ERROR_CODES.AGENT_TERMINATED
          ? reason
          : 'Agent terminated (AGENT_TERMINATED)';
        record.code = INVOCATION_ERROR_CODES.AGENT_TERMINATED;
        record.completedAt = Date.now();
        this.#invocationHistory.set(invId, { ...record });

        this.#emitComplete({
          invocationId: invId,
          targetAgentId: record.targetAgentId,
          output: '',
          error: record.error,
          code: INVOCATION_ERROR_CODES.AGENT_TERMINATED,
          status: INVOCATION_STATUS.CANCELLED,
          timestamp: record.completedAt
        });
        cancelledIds.push(invId);
      }
    }
    return cancelledIds;
  }

  /**
   * Turn-level await primitive. Halts caller turn execution until designated in-flight invocation(s) complete,
   * timeout expires, or operation is aborted via `AbortSignal`.
   *
   * ### Behavioral Guarantees:
   * - **Instant History Resolution:** If targets are already settled in `invocationHistory`, resolves on next tick without timers.
   * - **Timeout Safety Valve:** If `timeoutMs` expires before all finish, `success` remains `true`, arrived results are preserved
   *   in `results` / `receivedIds`, and uncompleted IDs are listed in `missingIds`.
   * - **Abort Handling:** If `signal` aborts while the wait is pending, resolves with `{ success: false, code: 'ABORTED' }`.
   *   The already-satisfied fast path wins: a wait over settled history targets resolves with results even when
   *   the signal was already aborted at call time.
   * - **Invalid Targets:** If no non-empty invocation IDs are supplied, resolves immediately with
   *   `{ success: false, code: 'INVALID_ARGUMENTS' }` and empty result arrays.
   * - **Error Propagation:** Individual failed, timed-out, or cancelled results do not clear `success`;
   *   when the wait is not aborted, the envelope mirrors the `code` and `error` of the first requested
   *   result that carries a `code`.
   * - **Memory Leak Prevention:** All internal waiter callbacks are automatically pruned from `pendingWaiters`.
   *
   * @param optionsOrIds - Single invocation ID, array of IDs, or structured request envelope.
   * @param maybeOptions - Await configuration options (timeoutMs, requireAll, signal).
   * @param callerContext - Trusted, facade/port-supplied caller identity (identity-only; Realm wave A, ticket 3487c56). Omit on the composition-root/engine path; when present, the caller must be the invocation's invoker, its target, or a Realm-bypass principal, and an unresolvable caller fails closed with `PERMISSION_DENIED`.
   * @returns Turn-level await resolution envelope.
   *
   * @example Barrier Await (requireAll: true)
   * ```typescript
   * const result = await engine.waitForInvocation(['inv_1', 'inv_2'], {
   *   timeoutMs: 10000,
   *   requireAll: true
   * });
   * if (result.timedOut) {
   *   console.warn(`Partial results: ${result.results.length}/${result.count}`);
   * }
   * for (const item of result.results) {
   *   console.log(`${item.targetAgentId} output:`, item.output);
   * }
   * ```
   *
   * @example First-Arrival Race (requireAll: false)
   * ```typescript
   * const result = await engine.waitForInvocation(['inv_fast', 'inv_slow'], {
   *   requireAll: false,
   *   timeoutMs: 5000
   * });
   * console.log('Fastest agent output:', result.results[0]?.output);
   * ```
   */
  async waitForInvocation(
    optionsOrIds: string | readonly string[] | WaitForInvocationRequest,
    maybeOptions: WaitForInvocationOptions = {},
    callerContext: InvocationCallerContext | null = null
  ): Promise<WaitForInvocationResult> {
    let targetIds: string[] = [];
    let opts: WaitForInvocationRequest = {};

    if (typeof optionsOrIds === 'string') {
      targetIds = [optionsOrIds];
      if (maybeOptions && typeof maybeOptions === 'object') {
        opts = maybeOptions;
      }
    } else if (Array.isArray(optionsOrIds)) {
      targetIds = [...optionsOrIds];
      if (maybeOptions && typeof maybeOptions === 'object') {
        opts = maybeOptions;
      }
    } else if (isWaitRequestEnvelope(optionsOrIds)) {
      opts = optionsOrIds;
      const rawIds = opts.invocationIds || opts.invocationId || opts.ids || opts.id;
      if (typeof rawIds === 'string') {
        targetIds = [rawIds];
      } else if (Array.isArray(rawIds)) {
        targetIds = [...rawIds];
      }
    }

    targetIds = [...new Set(targetIds.filter(id => typeof id === 'string' && id.trim().length > 0))];

    // Await authorization (Realm wave A, ticket 3487c56; canonical refs Wave I,
    // ticket d57cbc1): only the trusted facade/port channel is authenticated
    // (callerContext supplied). The caller must be the invocation's invoker, its
    // target, or a Realm-bypass principal (exact internal principal or hardcoded
    // system director). An unresolvable identity and an unrelated resolved
    // caller both fail closed before any ledger read — including the
    // settled-history fast path. Identity refs compare first (realm-exact when
    // canonical); the bare-display fallback applies only to legacy callers whose
    // reference the identity port did not resolve as a canonical key.
    if (callerContext !== null && callerContext !== undefined) {
      const caller = this.#resolveAwaitCaller(callerContext);
      if (!caller) {
        return deniedWaitResult('Permission denied: await caller identity is not a registered agent');
      }
      if (!caller.bypass) {
        for (const id of targetIds) {
          const record = this.#activeInvocations.get(id) || this.#invocationHistory.get(id);
          if (!record) continue;
          const namesInvoker = record.invokerIdentity === caller.identityRef;
          const namesTarget = record.targetIdentity === caller.identityRef;
          const namesLegacyDisplay = !caller.strict
            && (record.invokerId === caller.displayId || record.targetAgentId === caller.displayId);
          if (!namesInvoker && !namesTarget && !namesLegacyDisplay) {
            return deniedWaitResult(
              `Permission denied: agent '${caller.displayId}' cannot await invocation '${id}' (must be its invoker, its target, or a Realm-bypass principal)`
            );
          }
        }
      }
    }

    let timeoutMs = typeof opts.timeoutMs === 'number'
      ? opts.timeoutMs
      : (typeof opts.timeout_ms === 'number'
        ? opts.timeout_ms
        : DEFAULT_INVOCATION_TIMEOUT_MS);
    if (typeof timeoutMs !== 'number' || isNaN(timeoutMs) || timeoutMs < 0) {
      timeoutMs = DEFAULT_INVOCATION_TIMEOUT_MS;
    }

    const requireAll = opts.requireAll !== undefined
      ? Boolean(opts.requireAll)
      : (opts.require_all !== undefined ? Boolean(opts.require_all) : true);

    const signal = opts.signal;

    // Fast path: empty targets
    if (targetIds.length === 0) {
      return {
        success: false,
        error: "Missing or invalid invocation target IDs",
        code: INVOCATION_ERROR_CODES.INVALID_ARGUMENTS,
        results: [],
        count: 0,
        timedOut: false,
        receivedIds: [],
        missingIds: []
      };
    }

    // Check if already completed in history
    const resultsMap = new Map<string, InvocationSingleResult>();
    for (const id of targetIds) {
      const rec = this.#invocationHistory.get(id);
      if (rec) {
        resultsMap.set(id, {
          invocationId: id,
          targetAgentId: rec.targetAgentId,
          output: rec.output || '',
          status: rec.status,
          timedOut: rec.status === INVOCATION_STATUS.TIMED_OUT,
          ...(rec.error ? { error: rec.error } : {}),
          ...(rec.code ? { code: rec.code } : {})
        });
      }
    }

    const isSatisfied = (requireAll && resultsMap.size === targetIds.length) ||
      (!requireAll && resultsMap.size > 0);

    if (isSatisfied) {
      const results = targetIds.filter(id => resultsMap.has(id)).map(id => resultsMap.get(id)!);
      const receivedIds = results.map(r => r.invocationId);
      const missingIds = targetIds.filter(id => !resultsMap.has(id));
      const res: MutableWaitForInvocationResult = {
        success: true,
        results,
        count: results.length,
        timedOut: false,
        receivedIds,
        missingIds
      };
      const firstWithCode = results.find(r => r.code);
      if (firstWithCode) {
        res.code = firstWithCode.code;
        if (firstWithCode.error) res.error = firstWithCode.error;
      }
      return res;
    }

    if (signal?.aborted) {
      const results = targetIds.filter(id => resultsMap.has(id)).map(id => resultsMap.get(id)!);
      const receivedIds = results.map(r => r.invocationId);
      const missingIds = targetIds.filter(id => !resultsMap.has(id));
      return {
        success: false,
        results,
        count: results.length,
        timedOut: false,
        receivedIds,
        missingIds,
        code: INVOCATION_ERROR_CODES.ABORTED,
        error: 'Operation aborted'
      };
    }

    // Asynchronous wait
    return new Promise((resolve) => {
      let resolved = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let unsub: UnsubscribeFn | null = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (typeof unsub === 'function') {
          unsub();
          unsub = null;
        }
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
        // Remove waiter callbacks from pendingWaiters and delete empty keys (AC-EPIC10-03)
        for (const id of targetIds) {
          const waiterSet = this.#pendingWaiters.get(id);
          if (waiterSet) {
            waiterSet.delete(waiterCallback);
            if (waiterSet.size === 0) {
              this.#pendingWaiters.delete(id);
            }
          }
        }
      };

      /**
       * Resolve the waiting promise exactly once with the aggregated result.
       * @param timedOut - Whether the wait settled through its timeout fallback.
       * @param code - Optional machine-readable invocation error code.
       * @param error - Optional human-readable error message.
       */
      const finish = (timedOut = false, code?: string, error?: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();

        const results = targetIds.filter(id => resultsMap.has(id)).map(id => resultsMap.get(id)!);
        const receivedIds = results.map(r => r.invocationId);
        const missingIds = targetIds.filter(id => !resultsMap.has(id));

        const isAborted = code === INVOCATION_ERROR_CODES.ABORTED;
        const res: MutableWaitForInvocationResult = {
          success: !isAborted,
          results,
          count: results.length,
          timedOut,
          receivedIds,
          missingIds
        };
        if (code) res.code = code;
        if (error) res.error = error;
        if (!res.code) {
          const firstWithCode = results.find(r => r.code);
          if (firstWithCode) {
            res.code = firstWithCode.code;
            if (firstWithCode.error && !res.error) res.error = firstWithCode.error;
          }
        }

        resolve(res);
      };

      const onAbort = () => {
        finish(false, INVOCATION_ERROR_CODES.ABORTED, 'Operation aborted');
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const waiterCallback = (completeEvent: InvocationCompleteEvent) => {
        if (resolved) return;
        const id = completeEvent.invocationId;
        if (targetIds.includes(id)) {
          resultsMap.set(id, {
            invocationId: id,
            targetAgentId: completeEvent.targetAgentId,
            output: completeEvent.output || '',
            status: completeEvent.status,
            timedOut: completeEvent.status === INVOCATION_STATUS.TIMED_OUT,
            ...(completeEvent.error ? { error: completeEvent.error } : {}),
            ...(completeEvent.code ? { code: completeEvent.code } : {})
          });

          const ready = (requireAll && resultsMap.size === targetIds.length) ||
            (!requireAll && resultsMap.size > 0);

          if (ready) {
            finish(false);
          }
        }
      };

      // Register waiter callback in pendingWaiters Map/Set per targetId (AC-EPIC10-03)
      for (const id of targetIds) {
        let waiterSet = this.#pendingWaiters.get(id);
        if (!waiterSet) {
          waiterSet = new Set();
          this.#pendingWaiters.set(id, waiterSet);
        }
        waiterSet.add(waiterCallback);
      }

      unsub = this.onInvocationComplete(waiterCallback);

      if (typeof timeoutMs === 'number' && timeoutMs >= 0) {
        timer = setTimeout(() => {
          finish(true);
        }, timeoutMs);
      }
    });
  }

  /**
   * Subscribes to the isolated secondary token streaming channel.
   * Chunks are tagged strictly with `invocationId` and `targetAgentId`, completely decoupled from user chat.
   *
   * @param handler - Callback invoked when a stream token arrives.
   * @returns Idempotent unsubscribe function.
   *
   * @example
   * ```typescript
   * const unsub = engine.onInvocationChunk((evt) => {
   *   console.log(`[Invocation ${evt.invocationId}] chunk from ${evt.targetAgentId}: ${evt.chunk}`);
   * });
   * // Later:
   * unsub();
   * ```
   */
  onInvocationChunk(handler: (event: InvocationChunkEvent) => void): UnsubscribeFn {
    if (typeof handler !== 'function') return () => {};
    this.#chunkListeners.add(handler);
    return () => {
      this.#chunkListeners.delete(handler);
    };
  }

  /**
   * Subscribes to invocation completion events emitted when an invocation settles (completed, error, timed_out, cancelled).
   *
   * @param handler - Callback invoked on terminal resolution.
   * @returns Idempotent unsubscribe function.
   *
   * @example
   * ```typescript
   * const unsub = engine.onInvocationComplete((evt) => {
   *   console.log(`Invocation ${evt.invocationId} finished with status: ${evt.status}`);
   * });
   * ```
   */
  onInvocationComplete(handler: (event: InvocationCompleteEvent) => void): UnsubscribeFn {
    if (typeof handler !== 'function') return () => {};
    this.#completeListeners.add(handler);
    return () => {
      this.#completeListeners.delete(handler);
    };
  }

  /**
   * Subscribes to invocation start events emitted when an invocation is queued.
   *
   * @param handler - Callback invoked on invocation dispatch.
   * @returns Idempotent unsubscribe function.
   *
   * @example
   * ```typescript
   * const unsub = engine.onInvocationStart((evt) => {
   *   console.log(`Invocation ${evt.invocationId} started for ${evt.targetAgentId}`);
   * });
   * ```
   */
  onInvocationStart(handler: (event: InvocationStartEvent) => void): UnsubscribeFn {
    if (typeof handler !== 'function') return () => {};
    this.#startListeners.add(handler);
    return () => {
      this.#startListeners.delete(handler);
    };
  }

  /**
   * Retrieves an active or historical invocation record by ID.
   * Returns a defensive shallow copy or `null` if not found.
   *
   * @param invocationId - Unique invocation UUID to query.
   * @returns Defensive copy of the invocation record, or null.
   *
   * @example
   * ```typescript
   * const record = engine.getInvocation('inv_123');
   * if (record && record.status === INVOCATION_STATUS.COMPLETED) {
   *   console.log('Result:', record.output);
   * }
   * ```
   */
  getInvocation(invocationId: string): InvocationRecord | null {
    if (!invocationId || typeof invocationId !== 'string') return null;
    const active = this.#activeInvocations.get(invocationId);
    if (active) return this.#toPublicRecord(active);
    const history = this.#invocationHistory.get(invocationId);
    if (history) return this.#toPublicRecord(history);
    return null;
  }

  /**
   * Retrieves defensive copies of all currently active in-flight invocations.
   *
   * @returns Array of active invocation records.
   *
   * @example
   * ```typescript
   * const active = engine.getActiveInvocations();
   * console.log(`Currently running ${active.length} invocations.`);
   * ```
   */
  getActiveInvocations(): InvocationRecord[] {
    return Array.from(this.#activeInvocations.values()).map(r => this.#toPublicRecord(r));
  }

  /**
   * Retrieves defensive copies of all settled historical invocations.
   *
   * @returns Array of completed/settled invocation records.
   *
   * @example
   * ```typescript
   * const history = engine.getInvocationHistory();
   * const errors = history.filter(rec => rec.status === INVOCATION_STATUS.ERROR);
   * ```
   */
  getInvocationHistory(): InvocationRecord[] {
    return Array.from(this.#invocationHistory.values()).map(r => this.#toPublicRecord(r));
  }

  /**
   * Builds the agent-facing defensive copy of an internal record (Wave I,
   * ticket d57cbc1): the private opaque identity refs are stripped so no
   * canonical `key` can leak through `getInvocation`/`getActiveInvocations`/
   * `getInvocationHistory`.
   *
   * @param record - Internal record with private identity refs.
   * @returns A shallow public `InvocationRecord` copy.
   * @internal
   */
  #toPublicRecord(record: EngineInvocationRecord): InvocationRecord {
    const { invokerIdentity: _invokerIdentity, targetIdentity: _targetIdentity, ...publicRecord } = record;
    return publicRecord;
  }

  /**
   * Clears all active invocations, historical records, pending waiters, and registered event listeners.
   * Used for state resets between runtime sessions or unit tests.
   *
   * @returns void
   * @example
   * ```typescript
   * engine.reset();
   * ```
   */
  reset(): void {
    this.#activeInvocations.clear();
    this.#invocationHistory.clear();
    this.#chunkListeners.clear();
    this.#completeListeners.clear();
    this.#startListeners.clear();
    this.#pendingWaiters.clear();
  }

  #emitStart(event: InvocationStartEvent): void {
    for (const listener of this.#startListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[InvocationEngine] Error in start listener:', err);
      }
    }
  }

  #emitChunk(event: InvocationChunkEvent): void {
    for (const listener of this.#chunkListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[InvocationEngine] Error in chunk listener:', err);
      }
    }
  }

  #emitComplete(event: InvocationCompleteEvent): void {
    for (const listener of this.#completeListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[InvocationEngine] Error in complete listener:', err);
      }
    }
  }
}
