/**
 * @packageDocumentation
 * Canonical Type Definitions for Runtime Scheduler & Trigger Dispatcher.
 *
 * Architectural Layer: Layer 2 (Runtime Coordination, Event Scheduling & Trigger Dispatch Subsystem)
 * @module runtime/runtimeScheduler
 * @mayImport ../triggerDispatcher/index.ts
 * @mayImport type-only ../../messagingBus/index.ts
 * @mayImport type-only ../index.ts
 * @mustNotImport ../turnExecutionEngine/index.ts
 * @invariant Timer expiry enqueues, never executes: `#executeTimerTrigger` submits an immutable `TRIGGER_TYPES.SCHEDULE` trigger to `TriggerQueue` and never calls `runtime.executeAgentTurn()`.
 * @invariant All activations follow the single `TriggerQueue` → `TriggerDispatcher.dispatchTrigger` dispatch path (direct engine calls remain only as the no-`TriggerQueue` fallbacks documented on `TriggerDispatcher`); queue-mediated ordering yields strict intra-agent FIFO serialization with inter-agent concurrency.
 * @invariant Message-driven early cancellation: `handleIncomingMessageForTimers` cancels pending timers for the target agent as soon as their `timerCondition` is satisfied — `'any'` for any non-system sender, or an exact `msg.from` match; `'never'` waits for expiry. A realm-bound sender (injected identity projection with a non-empty `realmId` and no `realmBypass`) satisfies only its own, same-realm, or realm-bypass-owned timers — foreign/unresolved owners are skipped, so no broadcast or direct message can early-cancel across a realm boundary.
 * @invariant Realm-confined wake and cancel: realm scope resolves exclusively from the injected identity projection (`realmId`/`realmBypass`, optional and additive — projections without them stay ungrouped) for the reference-validated `context.principal`. A realm-bound principal (non-empty `realmId`, no `realmBypass`) may `schedule()` only for itself, same-realm members, or realm-bypass peers, and unresolvable/ungrouped targets fail closed with `PERMISSION_DENIED`; it may `cancelSchedule()` only its own or same-realm-owned timers. The injected internal principal and `realmBypass` identities span every realm; ungrouped/anonymous callers keep the legacy scheduling contract (the agent-reachable tool surface pins its target to the dispatcher-bound caller). Realm/identity claims on `params`, `options`, or `context` never widen scope.
 * @invariant Realm-scoped listing: `listSchedules()` resolves visibility from the reference-validated principal plus the injected identity projection — an ordinary (unprivileged) caller sees only its own schedules, a realm-bound root (privileged) sees its own plus same-realm-owned schedules, the injected internal principal and `realmBypass` identities span every scope, and an ungrouped/system principal sees only its own realm-free scope. Foreign-realm projections (prompt text, target ids, timing) are fully withheld, and an `options.agentId` filter narrows but never widens the resolved scope.
 * @invariant Zero host timer leaks: every `setTimeout` handle created by `schedule()`/`importSchedules()` gets `.unref()` when supported, and `cancelSchedule()`, `teardownForAgent()`, `cancelAll()`, `importSchedules()`, `reset()`, and `destroy()` clear handles so no orphaned event-loop timers remain.
 * @invariant Encapsulated registry: `#scheduledTasks` is never exposed; `listSchedules()` returns frozen defensive `ScheduledTaskProjection` copies whose `remainingSeconds` is computed per call as `Math.max(0, Math.ceil((fireAt - now) / 1000))`.
 * @invariant Ownership default-deny: `listSchedules()` returns an empty list and `cancelSchedule()` returns `PERMISSION_DENIED` to callers whose `context.principal` is absent, forged, or not a trusted registry descriptor / injected `InternalPrincipal`; a non-privileged principal sees and cancels only its own schedules. Authority is derived exclusively from the reference-validated `context.principal`: flags, roles, reserved ids, and descriptor-shaped claims on `options`/`timerIdOrParams`/`maybeReason`/`context` are ignored, so callers cannot assert authority through data.
 * @invariant Snapshot fidelity: `exportSchedules()` emits canonical `SerializedScheduledTimer` records whose `agentId`/`targetAgentId` project the bare registered id and whose additive opaque `agentRef` carries the canonical dispatch reference (the host-facing snapshot stays realm-opaque; the canonical ownership/dispatch references are restored realm-exactly on import) and `importSchedules()` clears existing state, restores records, and re-arms only `pending` timers with `delayMs = Math.max(0, fireAt - now)`.
 * @invariant Canonical owner keying, opaque at registration: a schedule stores the opaque reference supplied as its target (the canonical `(realmId, agentId)` key under wiring) plus the canonical ownership key and bare id resolved through the injected identity port (falling back to the supplied reference). Ownership, visibility, early-cancel, and `teardownForAgent` match on the canonical ownership key — the same literal id armed in two Realms never shares an owner entry — `teardownForAgent` accepts the canonical key plus the record's bare id as an explicit additive option (matching the stored dispatch/ownership reference against either form, never the display `ownerId`), and `listSchedules()`/`cancelSchedule()` receipts, listings, and errors project the bare `id` only: no canonical key or realm vocabulary is ever echoed.
 * @invariant Caller identity resolution: the realm scope of a reference-validated principal resolves from the trusted internal `context.callerKey` through `listAgentIdentities()` key-match (accepted only when the registry resolver binds the key back to the same descriptor instance — the descriptor-binding check accepts the canonical key form, not only the bare subject), else from the registered subject by key-match, else by unique `getAgentIdentity(subject)` match; a bare subject matching several registrations resolves to no identity and fails closed for realm-scoped wake, cancel, and listing unless a trusted, registry-bound `callerKey` resolves the exact registration. Agent-supplied targets resolve by key-match, else within the caller's realm scope (`getAgentIdentity(target, { realmId: caller.realmId })`), so a bare id registered in two Realms resolves realm-locally while a foreign, ungrouped, or unresolvable target keeps the existing denial semantics (no existence oracle).
 * @invariant Opaque trigger addressing: a schedule stores the canonical registration key resolved through the injected identity port as its dispatch reference (`agentRef`) when one resolves, falling back to the supplied reference; expiry enqueues that reference as the `TRIGGER_TYPES.SCHEDULE` target, so the trigger substrate addresses the exact `(realmId, agentId)` registration; the trigger payload's `targetAgentId` is dispatch addressing, never an agent-facing label.
 * @invariant Error receipts, not exceptions: `schedule()` and `cancelSchedule()` report validation, ownership, and lifecycle failures as structured `ScheduleErrorReceipt` values carrying `SCHEDULER_ERROR_CODES`; they never throw — including for a non-serializable `prompt` (circular structure, `BigInt`), which is rejected as `INVALID_ARGUMENTS` rather than surfaced as a `TypeError` — while `importSchedules()` is the deliberate throwing surface for the destroyed-instance case and skips malformed snapshot records.
 * @decision Scheduler tools consume the frozen `LifecyclePort` (`schedule`/`listSchedules`/`cancelSchedule`) injected by the runtime facade instead of reaching into the `RuntimeScheduler` instance directly
 * @decision Scheduler ownership authorization is `{ principal }` — a reference-validated frozen `AuthorityDescriptor` for agents or the opaque engine `InternalPrincipal` for internal paths. The `SchedulerExecutionContext` flag bundle (`isPrivileged`/`isAdmin`/`privileged`/`callerRole`) is ignored and retained only for wire compatibility
 * @decision Live timer state is owned by the private `#scheduledTasks` map (no runtime-level `scheduledTimers` map) and persistence flows exclusively through `exportSchedules()`/`importSchedules()` arrays
 * @decision Realm confinement is additive to MOD-21 principal scoping: `context.principal` remains the sole authority source, realm scope rides the injected identity port (worldClock pattern), and bypass is the injected internal principal or a projection carrying `realmBypass: true`
 * @decision Scheduler owners key on a canonical ownership key resolved through the injected identity port at registration (the opaque supplied reference when unresolvable): the canonical dispatch reference, ownership key, and bare display id are stored alongside, so expiry triggers address the exact registration while receipts and listings project bare ids and `teardownForAgent` matches the canonical key plus the caller-supplied bare id form
 * @decision `listSchedules` is realm-scoped on top of principal scoping: ordinary callers see their own schedules only, a realm-bound root sees own + same-realm-owned schedules, the internal principal / `realmBypass` identities span every scope, and ungrouped/system principals see only their own realm-free scope; the `options.agentId` filter narrows but never widens
 */

import type {
  AuditLogFilter,
  ExecutionContext,
  ListInboxOptions,
  MessageEnvelope,
  MessageHeaderSummary,
  UnsubscribeFn
} from '../../messagingBus/index.ts';
import { TRIGGER_TYPES } from '../triggerDispatcher/index.ts';
import type { TriggerType } from '../triggerDispatcher/index.ts';
import type { AuthorityDescriptor, InternalPrincipal, SubsystemEmitPort, TurnInput } from '../index.ts';

export type { TriggerType };

// ============================================================================
// 1. Constants & Enumerations
// ============================================================================

/**
 * Canonical trigger categories supported by the sandbox trigger substrate.
 * Re-exported from `../triggerDispatcher/index.ts`, the single declaration site of the
 * frozen enumeration; this module does not declare a second object.
 *
 * - `MAIL`: Incoming asynchronous messages delivered via `MessagingBus`.
 * - `INVOCATION`: Delegated subagent execution turns dispatched via `InvocationEngine`.
 * - `SCHEDULE`: Time-deferred one-shot alarms from `RuntimeScheduler`.
 * - `USER`: Direct interactive user turns submitted via chat or UI gateways.
 *
 * @readonly
 * Enum of `string` values:
 * @example
 * ```typescript
 * import { TRIGGER_TYPES } from './runtimeScheduler/index.ts';
 *
 * triggerQueue.enqueue({
 *   type: TRIGGER_TYPES.SCHEDULE,
 *   targetAgentId: 'agent-writer',
 *   source: 'system:scheduler',
 *   payload: { timerId: 'timer_123', prompt: 'Check plot progression' }
 * });
 * ```
 */
export { TRIGGER_TYPES };

/**
 * Canonical lifecycle status states for scheduled tasks.
 * Guarantees uniform status reporting across UI stores, persistence snapshots, and tools.
 *
 * - `PENDING`: Task is armed and actively counting down to `fireAt`.
 * - `TRIGGERED`: Timer has expired and enqueued a trigger into `TriggerQueue`; terminal for a one-shot alarm.
 * - `CANCELLED`: Task was explicitly cancelled or satisfied an early message condition.
 *
 * @readonly
 * Enum of `string` values:
 * @example
 * ```typescript
 * import { SCHEDULER_STATUS } from './runtimeScheduler/index.ts';
 *
 * if (task.status === SCHEDULER_STATUS.PENDING) {
 *   console.log(`Task ${task.timerId} will fire at ${new Date(task.fireAt)}`);
 * }
 * ```
 */
export const SCHEDULER_STATUS: Readonly<{
  readonly PENDING: 'pending';
  readonly TRIGGERED: 'triggered';
  readonly CANCELLED: 'cancelled';
}> = Object.freeze({
  PENDING: 'pending',
  TRIGGERED: 'triggered',
  CANCELLED: 'cancelled'
});

/**
 * Type alias representing valid scheduled task lifecycle status strings.
 */
export type SchedulerStatus = typeof SCHEDULER_STATUS[keyof typeof SCHEDULER_STATUS];

/**
 * Programmatic error codes returned by `RuntimeScheduler` operations.
 * Returned in structured `ScheduleErrorReceipt` objects to avoid unhandled exceptions.
 *
 * - `INVALID_ARGUMENTS`: Required fields missing (e.g. `agentId`, `prompt`), an empty prompt, a `prompt` that is neither a string nor JSON-serializable (circular structure, `BigInt`), or a delay that is absent, non-numeric, or non-positive.
 * - `SCHEDULE_NOT_FOUND`: Target `timerId` does not exist in the registry (never registered, purged, or cleared). Expired timers stay registered as `triggered` and fail cancellation with `ALREADY_TRIGGERED` instead.
 * - `PERMISSION_DENIED`: Non-privileged caller attempted to cancel another agent's timer, or supplied no resolvable context identity (anonymous default-deny).
 * - `ALREADY_TRIGGERED`: Attempted to cancel a schedule that has already fired.
 * - `SCHEDULER_UNAVAILABLE`: Scheduler instance is destroyed; returned by `schedule()` and `cancelSchedule()`, and thrown by `importSchedules()`.
 *
 * @readonly
 * Enum of `string` values:
 * @example
 * ```typescript
 * import { SCHEDULER_ERROR_CODES } from './runtimeScheduler/index.ts';
 *
 * const receipt = scheduler.schedule({ prompt: '' }, context);
 * if (!receipt.success && receipt.code === SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS) {
 *   console.error('Validation failure:', receipt.error);
 * }
 * ```
 */
export const SCHEDULER_ERROR_CODES: Readonly<{
  readonly INVALID_ARGUMENTS: 'INVALID_ARGUMENTS';
  readonly SCHEDULE_NOT_FOUND: 'SCHEDULE_NOT_FOUND';
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED';
  readonly ALREADY_TRIGGERED: 'ALREADY_TRIGGERED';
  readonly SCHEDULER_UNAVAILABLE: 'SCHEDULER_UNAVAILABLE';
}> = Object.freeze({
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  SCHEDULE_NOT_FOUND: 'SCHEDULE_NOT_FOUND',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  ALREADY_TRIGGERED: 'ALREADY_TRIGGERED',
  SCHEDULER_UNAVAILABLE: 'SCHEDULER_UNAVAILABLE'
});

/**
 * Type alias representing valid scheduler error code strings.
 */
export type SchedulerErrorCode = typeof SCHEDULER_ERROR_CODES[keyof typeof SCHEDULER_ERROR_CODES];

/**
 * Canonical status values accepted from persisted snapshot records.
 * Any other present status is malformed and the record is skipped on import.
 */
const CANONICAL_SCHEDULER_STATUSES: ReadonlySet<string> = new Set(Object.values(SCHEDULER_STATUS));

/**
 * Early cancellation condition for scheduled timers (Invariant 3).
 *
 * - `'never'`: (Default) Timer unconditionally waits until expiry unless explicitly cancelled.
 * - `'any'`: Timer is cancelled early if ANY non-system message arrives for the target agent.
 * - `<senderId>`: Timer is cancelled early if a message arrives specifically from `<senderId>`.
 *
 * @example
 * ```typescript
 * // Unconditional 5-minute reminder
 * const condNever: TimerCondition = 'never';
 *
 * // Liveness watchdog: cancel if any peer replies before 30 seconds
 * const condAny: TimerCondition = 'any';
 *
 * // RPC timeout: cancel if 'editor-agent' sends a message before 60 seconds
 * const condSender: TimerCondition = 'editor-agent';
 * ```
 */
export type TimerCondition = 'never' | 'any' | string;

// ============================================================================
// 2. Data Models & Payloads
// ============================================================================

/**
 * Standard parameters for scheduling a deferred one-shot turn execution.
 * Accepts standardized camelCase properties alongside tool descriptor legacy aliases.
 *
 * @example
 * ```typescript
 * // One-shot deferred task
 * const params: ScheduleParams = {
 *   agentId: 'reviewer-agent',
 *   prompt: 'Analyze story consistency after scene 3',
 *   durationSeconds: 120,
 *   timerCondition: 'writer-agent'
 * };
 * ```
 */
export interface ScheduleParams {
  /** Target agent identifier (required unless resolvable from execution context) */
  readonly agentId?: string;
  /** Legacy alias for `agentId` */
  readonly targetAgentId?: string;
  /** Instruction prompt or command to execute upon timer trigger */
  readonly prompt: string;
  /** One-shot delay in seconds before triggering (must be \> 0) */
  readonly durationSeconds?: number;
  /** Tool descriptor snake_case alias for `durationSeconds` */
  readonly delay_seconds?: number;
  /** Tool descriptor camelCase alias for `durationSeconds` */
  readonly delaySeconds?: number;
  /** Early cancellation trigger condition ('never', 'any', or specific senderId) */
  readonly timerCondition?: TimerCondition;
  /** Tool descriptor alias for `timerCondition` */
  readonly condition?: TimerCondition;
}

/**
 * Successful receipt returned upon schedule registration.
 *
 * @example
 * ```typescript
 * const receipt: ScheduleSuccessReceipt = {
 *   success: true,
 *   timerId: 'timer_1710633600000_1',
 *   targetAgentId: 'agent-1',
 *   prompt: 'Perform health check',
 *   durationSeconds: 60,
 *   timerCondition: 'never',
 *   scheduledAt: 1710633600000,
 *   fireAt: 1710633660000
 * };
 * ```
 */
export interface ScheduleSuccessReceipt {
  /** Discriminant indicating success */
  readonly success: true;
  /** Unique generated identifier for the scheduled task (`timer_<timestamp>_<counter>`) */
  readonly timerId: string;
  /** Target agent identifier to receive the trigger */
  readonly targetAgentId: string;
  /** Normalized instruction prompt string */
  readonly prompt: string;
  /** One-shot delay duration in seconds */
  readonly durationSeconds?: number;
  /** Configured early cancellation condition */
  readonly timerCondition: TimerCondition;
  /** Timestamp (ms) when schedule was registered */
  readonly scheduledAt: number;
  /** Wall-clock timestamp (ms) when the timer is armed to fire: `scheduledAt + Math.round(durationSeconds * 1000)` when a delay is supplied, otherwise `scheduledAt` */
  readonly fireAt: number;
}

/**
 * Structured error receipt returned upon failed schedule or cancellation operation.
 * Guarantees zero unhandled runtime exceptions for caller validation failures.
 *
 * @example
 * ```typescript
 * const receipt: ScheduleErrorReceipt = {
 *   success: false,
 *   error: "Missing required 'prompt'",
 *   code: 'INVALID_ARGUMENTS'
 * };
 * ```
 */
export interface ScheduleErrorReceipt {
  /** Discriminant indicating failure */
  readonly success: false;
  /** Human-readable explanation of failure reason */
  readonly error: string;
  /** Programmatic error code categorization */
  readonly code: SchedulerErrorCode;
}

/**
 * Discriminated union receipt returned by `RuntimeScheduler.schedule()`.
 *
 * @example
 * ```typescript
 * const result = scheduler.schedule(params, context);
 * if (result.success) {
 *   console.log(`Scheduled timer: ${result.timerId}, fires at: ${result.fireAt}`);
 * } else {
 *   console.error(`Scheduling error [${result.code}]: ${result.error}`);
 * }
 * ```
 */
export type ScheduleReceipt = ScheduleSuccessReceipt | ScheduleErrorReceipt;

/**
 * Parameters for cancelling a pending or active schedule.
 * Accepts standardized camelCase properties alongside tool descriptor legacy aliases.
 *
 * @example
 * ```typescript
 * const cancelParams: CancelScheduleParams = {
 *   timerId: 'timer_1710633600000_1',
 *   reason: 'Task superseded by user action'
 * };
 * ```
 */
export interface CancelScheduleParams {
  /** Unique identifier of the scheduled task to cancel */
  readonly timerId?: string;
  /** Tool descriptor snake_case alias for `timerId` */
  readonly task_id?: string;
  /** Tool descriptor camelCase alias for `timerId` */
  readonly taskId?: string;
  /** Generic alias for `timerId` */
  readonly id?: string;
  /** Optional human-readable cancellation reason */
  readonly reason?: string;
  /**
   * Ignored: caller-controlled identity never authorizes or scopes a cancellation.
   * Ownership identity is read exclusively from the trusted `SchedulerExecutionContext` argument.
   * @deprecated Caller-asserted identity is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly callerAgentId?: string;
  /**
   * Ignored alias of `callerAgentId`; see that field.
   * @deprecated Caller-asserted identity is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly agentId?: string;
  /**
   * Ignored: privilege is derived exclusively from the `SchedulerExecutionContext` argument, never from the parameter object.
   * @deprecated Caller-asserted privilege is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly isPrivileged?: boolean;
  /**
   * Ignored alias of `isPrivileged`; see that field.
   * @deprecated Caller-asserted privilege is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly isAdmin?: boolean;
  /**
   * Ignored alias of `isPrivileged`; see that field.
   * @deprecated Caller-asserted privilege is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly privileged?: boolean;
}

/**
 * Successful receipt returned upon schedule cancellation.
 *
 * @example
 * ```typescript
 * const cancelReceipt: CancelScheduleSuccessReceipt = {
 *   success: true,
 *   timerId: 'timer_1710633600000_1',
 *   cancelledAt: 1710633630000,
 *   alreadyCancelled: false
 * };
 * ```
 */
export interface CancelScheduleSuccessReceipt {
  /** Discriminant indicating success */
  readonly success: true;
  /** Identifier of the cancelled task */
  readonly timerId: string;
  /** Timestamp (ms) of the cancellation; on idempotent success (`alreadyCancelled`) this is the original cancellation time */
  readonly cancelledAt: number;
  /** Flag indicating whether the task was already in cancelled state (idempotent success) */
  readonly alreadyCancelled?: boolean;
}

/**
 * Discriminated union receipt returned by `RuntimeScheduler.cancelSchedule()`.
 *
 * @example
 * ```typescript
 * const receipt = scheduler.cancelSchedule('timer_123', 'User requested cancel', context);
 * if (receipt.success) {
 *   console.log(`Cancelled timer ${receipt.timerId} at ${receipt.cancelledAt}`);
 * } else {
 *   console.error(`Cancellation failed [${receipt.code}]: ${receipt.error}`);
 * }
 * ```
 */
export type CancelScheduleReceipt = CancelScheduleSuccessReceipt | ScheduleErrorReceipt;

/**
 * Filtering options for querying scheduled tasks via `listSchedules()`.
 *
 * @example
 * ```typescript
 * const filter: ListSchedulesOptions = {
 *   agentId: 'writer-agent',
 *   status: 'pending'
 * };
 * ```
 */
export interface ListSchedulesOptions {
  /** Filter schedules by target agent ID (ignored for non-privileged callers, whose context identity wins) */
  readonly agentId?: string;
  /** Filter schedules by status ('all', 'pending', 'triggered', 'cancelled') */
  readonly status?: SchedulerStatus | 'all';
  /**
   * Ignored: caller-controlled identity never authorizes or scopes a listing.
   * Ownership identity is read exclusively from the trusted `SchedulerExecutionContext` argument;
   * non-privileged callers with no context identity receive an empty list.
   * @deprecated Caller-asserted identity is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly callerAgentId?: string;
  /**
   * Ignored: privilege is derived exclusively from the `SchedulerExecutionContext` argument, never from options.
   * @deprecated Caller-asserted privilege is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly isPrivileged?: boolean;
  /**
   * Ignored alias of `isPrivileged`; see that field.
   * @deprecated Caller-asserted privilege is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly isAdmin?: boolean;
  /**
   * Ignored alias of `isPrivileged`; see that field.
   * @deprecated Caller-asserted privilege is a deprecated compatibility field; the principal `AuthorityDescriptor` replaces it.
   */
  readonly privileged?: boolean;
}

/**
 * Defensive snapshot projection of a scheduled task (Invariant 5).
 * Object is deeply frozen and includes dynamically computed countdown fields.
 *
 * @example
 * ```typescript
 * const projection: ScheduledTaskProjection = {
 *   timerId: 'timer_1710633600000_1',
 *   agentId: 'agent-1',
 *   targetAgentId: 'agent-1',
 *   durationSeconds: 60,
 *   remainingSeconds: 45,
 *   countdownSeconds: 45,
 *   prompt: 'Perform deferred health audit',
 *   timerCondition: 'never',
 *   status: 'pending',
 *   scheduledAt: 1710633600000,
 *   fireAt: 1710633660000,
 *   triggeredAt: null,
 *   cancelledAt: null,
 *   cancelReason: null
 * };
 * ```
 */
export interface ScheduledTaskProjection {
  /** Unique task identifier */
  readonly timerId: string;
  /** Target agent ID */
  readonly agentId: string;
  /** Backward-compatible alias for `agentId` */
  readonly targetAgentId: string;
  /** Configured one-shot delay in seconds; snapshots restored without a recorded delay report `0` */
  readonly durationSeconds?: number;
  /** Remaining seconds until `fireAt`, recomputed on every call and rounded up to the nearest second (minimum 0) */
  readonly remainingSeconds: number;
  /** Alias for `remainingSeconds` */
  readonly countdownSeconds: number;
  /** Instruction prompt string */
  readonly prompt: string;
  /** Configured early cancellation condition */
  readonly timerCondition: TimerCondition;
  /** Lifecycle state of the scheduled task */
  readonly status: SchedulerStatus;
  /** Timestamp (ms) when schedule was registered */
  readonly scheduledAt: number;
  /** Timestamp (ms) when schedule will trigger (or triggered) */
  readonly fireAt: number;
  /** Timestamp (ms) when schedule triggered (null if pending/cancelled) */
  readonly triggeredAt: number | null;
  /** Timestamp (ms) when schedule was cancelled (null if pending/triggered) */
  readonly cancelledAt: number | null;
  /** Reason recorded upon cancellation (null if not cancelled) */
  readonly cancelReason: string | null;
}

/**
 * Serialized representation of a scheduled timer for persistence snapshots (Invariant 7).
 * Conforms to the canonical `SerializedScheduledTimer` schema in Module 6 (`persistence`).
 *
 * `exportSchedules()` additionally emits the optional backward-compatibility alias
 * fields declared at the end of this interface; `importSchedules()` accepts them
 * alongside the canonical names.
 *
 * @example
 * ```typescript
 * const serialized: SerializedScheduledTimer = {
 *   id: 'timer_1710633600000_1',
 *   agentId: 'agent-1',
 *   type: 'timeout',
 *   delayMs: 60000,
 *   payload: {
 *     prompt: 'Execute story checkpoint save',
 *     timerCondition: 'never'
 *   },
 *   createdAt: 1710633600000,
 *   nextRunAt: 1710633660000,
 *   status: 'pending',
 *   triggeredAt: null,
 *   cancelledAt: null
 * };
 * ```
 */
export interface SerializedScheduledTimer {
  /** Unique timer identifier */
  readonly id: string;
  /** Target agent identifier */
  readonly agentId: string;
  /**
   * Opaque dispatch reference of the schedule's registration (Wave I, ticket
   * d57cbc1): the internal `(realmId, agentId)` identity key when one resolved
   * at registration, else the supplied reference. Emitted by
   * `exportSchedules()` so `importSchedules()` restores the realm-exact
   * dispatch/ownership references losslessly even when the same literal id is
   * registered in two Realms; `agentId`/`targetAgentId` keep projecting the
   * bare id. Internal persistence metadata only — never surfaced to agents.
   */
  readonly agentRef?: string;
  /** Trigger category emitted by `exportSchedules()`: always `'timeout'` (the scheduler produces one-shot alarms only) */
  readonly type: 'timeout';
  /** Delay in milliseconds (`durationSeconds * 1000`, rounded) when a one-shot delay was configured */
  readonly delayMs?: number;
  /** Nested payload container for prompt and cancellation rules */
  readonly payload?: {
    readonly prompt: string;
    readonly timerCondition: TimerCondition;
  };
  /** Timestamp (ms) when schedule was created */
  readonly createdAt: number;
  /** Timestamp (ms) when schedule is next scheduled to run */
  readonly nextRunAt: number;
  /** Task lifecycle status */
  readonly status?: SchedulerStatus;
  /** Timestamp (ms) when task triggered */
  readonly triggeredAt?: number | null;
  /** Timestamp (ms) when task was cancelled */
  readonly cancelledAt?: number | null;
  /** Reason recorded upon cancellation (null if not cancelled) */
  readonly cancelReason?: string | null;

  // --------------------------------------------------------------------------
  // Backward-compatibility alias fields
  //
  // `exportSchedules()` emits these alongside every canonical record; they are
  // optional because legacy snapshots and external producers may omit them.
  // Clone-safe: records are plain objects with no live handles.
  // --------------------------------------------------------------------------

  /** Alias of `id` emitted by `exportSchedules()` */
  readonly timerId?: string;
  /** Alias of `agentId` emitted by `exportSchedules()` */
  readonly targetAgentId?: string;
  /** One-shot delay in seconds (`delayMs / 1000`) emitted alongside `delayMs` when a delay was configured */
  readonly durationSeconds?: number;
  /** Flat alias of `payload.prompt` emitted by `exportSchedules()` */
  readonly prompt?: string;
  /** Flat alias of `payload.timerCondition` emitted by `exportSchedules()` */
  readonly timerCondition?: TimerCondition;
  /** Alias of `createdAt` emitted by `exportSchedules()` */
  readonly scheduledAt?: number;
  /** Alias of `nextRunAt` emitted by `exportSchedules()` */
  readonly fireAt?: number;
}

// ============================================================================
// 3. Subsystem Dependency Interfaces
// ============================================================================

/**
 * Execution context passed to `listSchedules()`/`cancelSchedule()` (MOD-21 W3).
 *
 * Trust boundary: authority is derived exclusively from `principal` — the exact
 * injected `InternalPrincipal` reference for engine paths, or a frozen registry
 * `AuthorityDescriptor` whose `subject` is the principal subject. The injected
 * scheduler validates agent descriptors by reference through its registry
 * resolver; forged descriptor shapes, flag bundles, roles, and reserved ids
 * resolve to anonymous (default-deny).
 *
 * The legacy flag fields remain on the type for wire compatibility but are
 * IGNORED by the W3-enforced implementation.
 *
 * @example
 * ```typescript
 * const context: SchedulerExecutionContext = {
 *   principal: identityPort.getAgentIdentity('director')?.authority
 * };
 * ```
 */
export interface SchedulerExecutionContext {
  /**
   * Trusted principal: the exact injected `InternalPrincipal` (engine paths) or
   * a frozen registry `AuthorityDescriptor` (agents).
   */
  readonly principal?: InternalPrincipal | AuthorityDescriptor;
  /**
   * Canonical internal identity `key` of the caller (Wave I, ticket d57cbc1).
   *
   * Trusted internal hint only: the composition root / lifecycle port binds it
   * from trusted construction to disambiguate realm-local ids, and the
   * scheduler accepts it only when the registry authority resolver maps that
   * key back to the same `principal` reference — a caller-supplied or forged
   * key grants nothing and never widens scope. Internal-only: never echoed on a
   * receipt, listing, error, or payload.
   */
  readonly callerKey?: string;
  /**
   * Caller agent identifier.
   * @deprecated Not read by the scheduler; the facade resolves a `callerAgentId`
   * identity into `{ principal }` through the lifecycle registry before delegating.
   */
  readonly callerAgentId?: string;
  /**
   * Alias for `callerAgentId`.
   * @deprecated Not read by the scheduler; see `callerAgentId`.
   */
  readonly agentId?: string;
  /**
   * Privileged execution flag (bypasses ownership checks).
   * @deprecated Ignored by the W3-enforced scheduler; use `principal`.
   */
  readonly isPrivileged?: boolean;
  /**
   * Alias for `isPrivileged`.
   * @deprecated Ignored by the W3-enforced scheduler; use `principal`.
   */
  readonly isAdmin?: boolean;
  /**
   * Alias for `isPrivileged`.
   * @deprecated Ignored by the W3-enforced scheduler; use `principal`.
   */
  readonly privileged?: boolean;
  /**
   * Role string (e.g. 'admin', 'system').
   * @deprecated Ignored by the W3-enforced scheduler; roles carry no authority.
   */
  readonly callerRole?: string;
  /** Additional dynamic context properties */
  readonly [key: string]: unknown;
}

/**
 * Trusted identity projection consumed by the scheduler realm resolver.
 *
 * Structural mirror of the MOD-13 `AgentIdentityPort` projection; the canonical
 * definition lives in `runtime/index.ts`. The projection is trusted
 * construction output — callers never supply it.
 */
export interface SchedulerIdentityProjection {
  /** Registered agent identifier. */
  readonly id?: string;
  /**
   * Canonical internal identity key of the registration (Wave I, ticket
   * d57cbc1): `createAgentIdentityKey(realmId, id)`. Opaque to the scheduler —
   * it is only ever compared for equality, never parsed, and never surfaces on
   * an agent-facing receipt, listing, error, or payload.
   */
  readonly key?: string;
  /**
   * Realm membership resolved by the runtime identity projection (Realm wave A1).
   * Optional and additive: projections produced before the runtime wiring lands
   * carry no `realmId`, which resolves to the ungrouped (legacy) scope.
   */
  readonly realmId?: string | null;
  /**
   * Whether the subject bypasses Realm scoping (the injected internal principal
   * or the hardcoded system director). Optional and additive; absent means
   * realm-bound when `realmId` is present.
   */
  readonly realmBypass?: boolean;
}

/**
 * Trusted resolution scope accepted by {@link SchedulerIdentityPort}
 * (Wave I, ticket d57cbc1). Structural mirror of the runtime
 * `AgentIdentityScope`.
 *
 * - `{ realmId: <string> }` resolves exactly `(realmId, agentId)`.
 * - `{ realmId: null }` resolves exactly the bootstrap-only system scope.
 * - `{ realmBypass: true }` (or an omitted scope) resolves the unique match
 *   across every Realm, `null` when absent or ambiguous.
 */
export interface SchedulerIdentityScope {
  /** Realm membership to resolve exactly; `null` selects the system scope. */
  readonly realmId?: string | null;
  /** Resolve the unique match across every Realm. */
  readonly realmBypass?: boolean;
}

/**
 * Trusted identity resolver injected into the scheduler for Realm scope.
 * Structural mirror of the MOD-13 `AgentIdentityPort`; absent means no realm
 * information is available and the legacy, unscoped behavior applies.
 */
export interface SchedulerIdentityPort {
  /**
   * Resolves the identity projection of a registered agent, or `null` when no
   * trusted principal matches the subject.
   *
   * @param agentId - Realm-local identifier to resolve.
   * @param scope - Optional trusted resolution scope: realm-exact scopes
   *   resolve exactly that Realm's registration, while an omitted or bypass
   *   scope resolves the unique match across Realms (`null` when absent or
   *   ambiguous).
   * @returns Frozen identity projection or `null` (anonymous).
   */
  getAgentIdentity(agentId: string, scope?: SchedulerIdentityScope): SchedulerIdentityProjection | null;
  /**
   * Optional enumeration of the active registrations a scope can resolve
   * (Wave I, ticket d57cbc1): used for canonical `key` matching, so an owner
   * or caller reference that is a canonical key still resolves to its
   * projection and its bare `id`. Omitted ports keep unique-match behavior.
   *
   * @param scope - Optional trusted resolution scope; omitted enumerates all.
   * @returns Projections in registry order (possibly empty).
   */
  listAgentIdentities?(scope?: SchedulerIdentityScope): SchedulerIdentityProjection[];
}

/**
 * Minimal host runtime contract required by `RuntimeScheduler` and `TriggerDispatcher`.
 *
 * @example
 * ```typescript
 * const mockRuntime: AgentRuntimeHost = {
 *   getAgent: (id) => ({ id, name: 'Test Agent' }),
 *   isAgentTerminated: (id) => false,
 *   executeAgentTurn: async (id, prompt, opts) => ({ success: true }),
 *   createSubsystemEmitPort: () => ({ emit: (event) => console.log('Runtime event:', event.type) })
 * };
 * ```
 */
export interface AgentRuntimeHost {
  /** Retrieve active agent instance by ID */
  getAgent(agentId: string): unknown | null;
  /** Check if agent has been terminated or destroyed */
  isAgentTerminated(agentId: string): boolean;
  /** Execute an isolated serialized agent turn; the prompt is the real `TurnInput` domain type (string, structured object, message array, or `null`/`undefined` for mail wake) */
  executeAgentTurn(
    agentId: string,
    prompt: TurnInput,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  /** Build the canonical frozen emit port used when no `emit` option is injected */
  createSubsystemEmitPort?(): SubsystemEmitPort;
}

/**
 * Minimal messaging bus contract required by `RuntimeScheduler` and `TriggerDispatcher`.
 *
 * Signatures mirror the authoritative public API of `MessagingBus` (`messagingBus.d.ts`)
 * member-for-member, so a real bus instance satisfies this host contract without casts
 * (MOD11-C5-01 / MOD11-C5-02).
 *
 * @example
 * ```typescript
 * const mockBus: MessagingBusHost = {
 *   isRegistered: (id) => true,
 *   isAgentTerminated: (id) => false,
 *   getUnreadCount: (id) => 0,
 *   listInbox: (id) => [],
 *   subscribe: (recipient, cb) => () => {},
 *   getAuditLog: (filter) => []
 * };
 * ```
 */
export interface MessagingBusHost {
  /** Check if agent is registered on the messaging bus */
  isRegistered(agentId: string): boolean;
  /** Check if agent is terminated */
  isAgentTerminated(agentId: string): boolean;
  /** Count unread (active-queue) envelopes for the target agent */
  getUnreadCount(agentId: string): number;
  /**
   * Non-destructive unread inbox header projection for the target agent.
   * Mirrors `MessagingBus.listInbox`, where `agentId` and `recipient` are both accepted targeting aliases.
   */
  listInbox(
    agentIdOrParams: string | (ListInboxOptions & { agentId?: string; recipient?: string }),
    optionsOrContext?: ListInboxOptions | ExecutionContext
  ): MessageHeaderSummary[];
  /** Subscribe to incoming messages on a recipient channel or 'all' */
  subscribe(
    recipientFilter: string | 'all',
    handler: (message: MessageEnvelope) => void
  ): UnsubscribeFn;
  /** Read-only audit ledger accessor (replaces the removed `auditLog` array field) */
  getAuditLog?(filter?: AuditLogFilter): MessageEnvelope[];
}

/**
 * Minimal contract for the anti-HoL `TriggerQueue` required for decoupled trigger enqueuing.
 *
 * @example
 * ```typescript
 * const mockQueue: TriggerQueueHost = {
 *   enqueue: (triggerData) => `trig_${Date.now()}`
 * };
 * ```
 */
export interface TriggerQueueHost {
  /** Enqueue a typed trigger for anti-HoL serialized dispatch */
  enqueue(triggerData: {
    type: TriggerType;
    targetAgentId: string;
    source?: string;
    payload?: unknown;
  }): string;
}

/**
 * Minimal contract for `InvocationEngine`, declared for injection parity with
 * `TriggerDispatcher` options only. No runtime path consults it: `TriggerDispatcher` stores the
 * injected engine and never reads it, and invocation turns route through `TriggerQueue` and
 * `runtime` (see `TriggerDispatcherOptions.invocationEngine` in `../triggerDispatcher/index.ts`).
 *
 * @example
 * ```typescript
 * const mockInvoc: InvocationEngineHost = {
 *   invokeAgent: (invoker, target, prompt, opts) => ({ invocationId: 'inv_1' }),
 *   waitForInvocation: async (opts) => ({ result: 'done' })
 * };
 * ```
 */
export interface InvocationEngineHost {
  /** Invoke a subagent delegating a turn */
  invokeAgent(
    invokerIdOrParams: unknown,
    targetAgentId?: string,
    prompt?: string,
    options?: Record<string, unknown>
  ): unknown;
  /** Wait for an invocation to resolve */
  waitForInvocation(
    optionsOrIds: unknown,
    maybeOptions?: Record<string, unknown>
  ): Promise<unknown>;
}

// ============================================================================
// 4. Class Signatures
// ============================================================================

/**
 * Options for initializing `RuntimeScheduler`.
 *
 * @example
 * ```typescript
 * const scheduler = new RuntimeScheduler({
 *   runtime: agentRuntimeInstance,
 *   emit: agentRuntimeInstance.createSubsystemEmitPort(),
 *   triggerQueue: triggerQueueInstance
 * });
 * ```
 */
export interface RuntimeSchedulerOptions {
  /** Host runtime used only as the fallback source of `createSubsystemEmitPort()` when `emit` is not injected */
  readonly runtime?: AgentRuntimeHost | null;
  /** Injected canonical {@link SubsystemEmitPort}; falls back to `runtime.createSubsystemEmitPort()` */
  readonly emit?: SubsystemEmitPort | null;
  /** Centralized anti-HoL TriggerQueue for enqueuing expired timer triggers */
  readonly triggerQueue?: TriggerQueueHost | null;
  /**
   * Opaque engine principal injected by the composition root. Only this exact
   * frozen reference is trusted for internal privileged paths (telemetry,
   * message-driven early cancellation).
   */
  readonly internalPrincipal?: InternalPrincipal | null;
  /**
   * Registry authority resolver used to validate agent principals by reference:
   * returns the registered descriptor for an agent subject, or `null`. A
   * descriptor supplied as `context.principal` is trusted only when it IS the
   * registered instance.
   */
  readonly resolveAgentAuthority?: ((agentId: string) => AuthorityDescriptor | null) | null;
  /**
   * Trusted identity resolver used to resolve Realm scope (`realmId`/
   * `realmBypass`) for validated principals and schedule targets (Realm wave
   * A1). Optional and additive: without it no realm information is available
   * and the scheduler keeps the legacy, unscoped behavior.
   */
  readonly identityPort?: SchedulerIdentityPort | null;
}

// ============================================================================
// 5. Non-Exported Internal Records
// ============================================================================

/**
 * Cross-environment timer handle. Browser/Vite builds expose numeric handles
 * without `unref`; Node exposes an object handle that does. `unref` is probed
 * structurally before use so both environments are safe.
 */
type TimerHandle = ReturnType<typeof setTimeout> & { unref?: () => void };

/**
 * Internal live timer record for a registered one-shot schedule.
 * Never exposed: `listSchedules()` returns frozen defensive projections.
 *
 * Canonical owner keying (Wave I, ticket d57cbc1): `ownerKey` is the
 * registration's canonical identity key when the target resolved through the
 * injected identity port, else the opaque reference supplied at registration;
 * ownership, visibility, early-cancel, and teardown match on it, so the same
 * literal id owned in two Realms never shares an entry. `agentRef` is the
 * opaque dispatch reference exactly as supplied (trigger addressing), and
 * `ownerId` is the bare registered id used by agent-facing projections.
 */
interface ScheduledTask {
  timerId: string;
  /** Opaque dispatch reference supplied as the target (canonical key under wiring). */
  agentRef: string;
  /** Canonical identity key when resolvable, else the supplied reference. */
  ownerKey: string;
  /** Bare registered id for agent-facing projections, else the supplied reference. */
  ownerId: string;
  durationSeconds: number;
  prompt: string;
  timerCondition: TimerCondition;
  status: SchedulerStatus;
  scheduledAt: number;
  fireAt: number;
  triggeredAt: number | null;
  cancelledAt: number | null;
  cancelReason: string | null;
  timeoutHandle: TimerHandle | null;
}

/**
 * Reference-validated scheduler authorization identity resolved from
 * `context.principal` (MOD-21 default-deny).
 */
interface ResolvedPrincipal {
  /** Bare display identifier of the principal (receipts, listings, errors). */
  subject: string;
  /**
   * Opaque identity reference used for ownership matching and keyed
   * equivalence (Wave I, ticket d57cbc1): the canonical `key` when the
   * projection resolves, else the registered subject. Never surfaced.
   */
  identityRef: string;
  kind: 'internal' | 'agent';
  privileged: boolean;
  /** Non-empty realm id for realm-bound principals, else `null` (ungrouped). */
  realmId: string | null;
  /** Whether the principal spans every realm (internal principal / `realmBypass` projection). */
  realmBypass: boolean;
  /**
   * Whether the principal's own registration is ambiguous across Realms (the
   * bare subject matches several active registrations): realm scope is then
   * unknowable and realm-scoped wake/cancel/listing fails closed.
   */
  identityAmbiguous: boolean;
}

/**
 * Resolved Realm scope of an agent subject from the injected identity
 * projection. `realmId` is `null` for ungrouped subjects and for bypass
 * identities, exactly like the A0-3 worldClock resolver.
 */
interface ResolvedRealmScope {
  realmId: string | null;
  realmBypass: boolean;
}

/**
 * Internal runtime event payload accepted by {@link SubsystemEmitPort}.
 * `timestamp` is always a numeric epoch-millisecond value supplied by the emitter.
 */
interface SchedulerEvent {
  type: string;
  timestamp: number;
  payload?: unknown;
  [key: string]: unknown;
}

/**
 * RuntimeScheduler
 *
 * Primary time-deferred execution engine for Layer 2. Manages one-shot timers,
 * early message-driven cancellation conditions, snapshot persistence,
 * and leak-proof lifecycle teardown.
 *
 * Architectural Invariants:
 * - **Invariant 1 (Decoupled Turn Execution):** NEVER calls `runtime.executeAgentTurn()` directly.
 *   On timer expiry, enqueues `TRIGGER_TYPES.SCHEDULE` to `TriggerQueue`.
 * - **Invariant 3 (Early Cancellation):** Evaluates `timerCondition` against incoming mail envelopes.
 * - **Invariant 4 (Zero Host Leaks):** Calls `.unref()` on all Node.js `setTimeout` handles.
 * - **Invariant 5 (Encapsulated Registry):** Private `#scheduledTasks` Map; query via defensive projections.
 * - **Invariant 7 (Persistence Fidelity):** Deterministic snapshot export/import.
 *
 * @example
 * ```typescript
 * import { RuntimeScheduler } from './runtimeScheduler/index.ts';
 * import { TriggerQueue } from '../triggerQueue/index.ts';
 *
 * const queue = new TriggerQueue({ dispatchAction: async (t) => true });
 * const scheduler = new RuntimeScheduler({ triggerQueue: queue });
 *
 * // Schedule a 30-second reminder
 * const receipt = scheduler.schedule({
 *   agentId: 'writer-agent',
 *   prompt: 'Check character motivations',
 *   durationSeconds: 30,
 *   timerCondition: 'editor-agent'
 * });
 *
 * if (receipt.success) {
 *   console.log(`Registered timer ${receipt.timerId}, fires at ${new Date(receipt.fireAt)}`);
 * }
 * ```
 */
export class RuntimeScheduler {
  #triggerQueue: TriggerQueueHost | null;
  #emitPort: SubsystemEmitPort | null = null;
  #scheduledTasks: Map<string, ScheduledTask> = new Map();
  #timerCounter = 0;
  #destroyed = false;
  #internalPrincipal: InternalPrincipal | null = null;
  #resolveAgentAuthority: ((agentId: string) => AuthorityDescriptor | null) | null = null;
  #identityPort: SchedulerIdentityPort | null = null;

  /**
   * Initializes a new `RuntimeScheduler` instance.
   *
   * @param options - Configuration options and host subsystem dependencies. Defaults to `{}`.
   * `options.runtime` is the back-reference to `AgentRuntime`, `options.emit` the injected
   * `SubsystemEmitPort`, `options.triggerQueue` the centralized non-blocking `TriggerQueue`,
   * `options.internalPrincipal` the opaque engine principal injected by the composition root
   * (only this exact reference is trusted), `options.resolveAgentAuthority` the registry
   * resolver used to validate agent principals by reference, and `options.identityPort`
   * the trusted identity resolver used to resolve Realm scope (optional; absent keeps the
   * legacy unscoped behavior).
   */
  constructor({
    runtime = null,
    emit = null,
    triggerQueue = null,
    internalPrincipal = null,
    resolveAgentAuthority = null,
    identityPort = null
  }: RuntimeSchedulerOptions = {}) {
    this.#triggerQueue = triggerQueue;
    this.#emitPort = (emit && typeof emit.emit === 'function')
      ? emit
      : (runtime && typeof runtime.createSubsystemEmitPort === 'function' ? runtime.createSubsystemEmitPort() : null);
    this.#internalPrincipal = internalPrincipal || null;
    this.#resolveAgentAuthority = typeof resolveAgentAuthority === 'function' ? resolveAgentAuthority : null;
    this.#identityPort = (identityPort && typeof identityPort.getAgentIdentity === 'function') ? identityPort : null;
  }

  /**
   * Resolves the scheduler principal from the explicit `{ principal }` context.
   *
   * Trust rules (MOD-21, default-deny):
   * - the exact injected `InternalPrincipal` reference only;
   * - a frozen agent `AuthorityDescriptor` that IS the registry instance bound
   *   to its `subject` **or** to a trusted internal `callerKey` (forged
   *   descriptor shapes and forged keys are anonymous).
   *
   * Identity resolution (Wave I, ticket d57cbc1): the principal's realm scope
   * and canonical `key` resolve from the trusted internal `callerKey` (accepted
   * only when the registry resolver binds it to the same descriptor), else from
   * the registered subject by key-match, else by unique `getAgentIdentity`
   * match. A registered subject matching several registrations resolves to no
   * identity and is marked ambiguous — but a trusted `callerKey` bound by the
   * registry to the same descriptor resolves the exact registration even when
   * the bare subject is ambiguous across Realms.
   *
   * Flag bundles, roles, reserved ids, forged `callerKey`s, and unrecognized
   * objects resolve to `null` or stay unscoped — never widen.
   *
   * @param context - Trusted principal context
   */
  #resolvePrincipal(context: SchedulerExecutionContext | undefined): ResolvedPrincipal | null {
    const candidate = context && typeof context === 'object' ? context.principal : null;
    if (!candidate || typeof candidate !== 'object') return null;

    if (this.#internalPrincipal && candidate === this.#internalPrincipal) {
      const subject = typeof candidate.subject === 'string' && candidate.subject ? candidate.subject : 'internal';
      return {
        subject,
        identityRef: subject,
        kind: 'internal',
        privileged: true,
        realmId: null,
        realmBypass: true,
        identityAmbiguous: false
      };
    }

    if (this.#resolveAgentAuthority) {
      // Canonical key form first (Wave I, ticket d57cbc1): the descriptor
      // binding is accepted when the trusted callerKey maps back to the same
      // registry instance, so a same-literal-id caller whose bare subject is
      // ambiguous across Realms still resolves realm-exactly. A forged or
      // caller-supplied key resolves nothing; an unbound key falls through to
      // the bare-subject validation and stays fail-closed.
      const callerKey = this.#trustedCallerKey(context);
      let registered: AuthorityDescriptor | null = null;
      if (callerKey) {
        const byKey = this.#resolveAgentAuthority(callerKey);
        if (byKey && byKey === candidate) registered = byKey;
      }
      if (!registered && typeof candidate.subject === 'string' && candidate.subject) {
        const bySubject = this.#resolveAgentAuthority(candidate.subject);
        if (bySubject && bySubject === candidate) registered = bySubject;
      }
      if (registered) {
        const allow = registered.allow;
        // Caller identity (Wave I, ticket d57cbc1): resolve the exact
        // registration for realm scope and canonical key matching. Validated
        // descriptors whose identity cannot be resolved stay ungrouped (the
        // legacy additive behavior); a subject matching several registrations
        // is ambiguous and fails realm-scoped operations closed.
        const caller = this.#resolveCallerIdentity(context, registered.subject, registered);
        const projection = caller.projection;
        const projectionRealmId = projection ? this.#normalizeRealmId(projection.realmId) : null;
        const projectionBypass = projection ? projection.realmBypass === true : false;
        const realmScope = projection ? null : this.#resolveRealmScope(registered.subject);
        return {
          subject: projection && typeof projection.id === 'string' && projection.id ? projection.id : registered.subject,
          identityRef: projection && typeof projection.key === 'string' && projection.key ? projection.key : registered.subject,
          kind: 'agent',
          privileged: registered.visibility === 'all'
            || registered.visibility === 'system'
            || Boolean(allow && (allow.has('*') || allow.has('@lifecycle:authority'))),
          realmId: projection ? projectionRealmId : (realmScope ? realmScope.realmId : null),
          realmBypass: projection ? projectionBypass : (realmScope ? realmScope.realmBypass : false),
          identityAmbiguous: caller.ambiguous
        };
      }
    }

    return null;
  }

  /**
   * Reads the trusted internal `callerKey` hint from a scheduler context
   * (Wave I, ticket d57cbc1): a non-blank trimmed string, else `null`. The
   * value is a hint only — every acceptance path maps it back to the exact
   * registry descriptor through the injected authority resolver, so a
   * caller-supplied or forged key grants nothing and never widens scope.
   *
   * @param context - Trusted principal context
   * @returns The normalized canonical key hint, or `null`
   */
  #trustedCallerKey(context: SchedulerExecutionContext | undefined): string | null {
    const raw = context && typeof context === 'object' ? context.callerKey : null;
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  }

  /**
   * Resolves the trusted caller projection for a reference-validated agent
   * principal (Wave I, ticket d57cbc1).
   *
   * Order:
   * 1. `context.callerKey` matched against `listAgentIdentities()` `key`s,
   *    accepted only when the registry authority resolver binds the key back to
   *    the same descriptor reference (a forged key never widens scope);
   * 2. the registered subject by key-match (the wired facade passes canonical
   *    keys as the descriptor subject);
   * 3. the registered subject by unique `getAgentIdentity` match.
   *
   * Zero matches stay unresolved (legacy ungrouped behavior); several matches
   * make the caller's realm unknowable and are reported as ambiguous.
   *
   * @param context - Trusted principal context
   * @param registeredSubject - Subject carried by the validated descriptor
   * @param registered - The reference-validated registry descriptor
   * @returns The resolved projection (or `null`) plus the ambiguity flag
   */
  #resolveCallerIdentity(
    context: SchedulerExecutionContext | undefined,
    registeredSubject: string,
    registered: AuthorityDescriptor
  ): { projection: SchedulerIdentityProjection | null; ambiguous: boolean } {
    const callerKey = this.#trustedCallerKey(context);
    if (callerKey) {
      const projection = this.#projectionByKey(callerKey);
      if (projection && this.#callerKeyBindsPrincipal(callerKey, registeredSubject, registered)) {
        return { projection, ambiguous: false };
      }
    }

    const subjectProjection = this.#projectionByKey(registeredSubject) || this.#getIdentity(registeredSubject);
    if (subjectProjection) return { projection: subjectProjection, ambiguous: false };

    return { projection: null, ambiguous: this.#isIdentifierAmbiguous(registeredSubject) };
  }

  /**
   * Whether an internal `callerKey` hint is bound to the reference-validated
   * principal: either it already is the descriptor subject, or the registry
   * authority resolver maps that key to the same descriptor instance (Wave I,
   * ticket d57cbc1). A forged or caller-supplied key is never trusted.
   *
   * @param callerKey - Canonical key claimed by the trusted context
   * @param registeredSubject - Subject carried by the validated descriptor
   * @param registered - The reference-validated registry descriptor
   * @returns Whether the key identifies the principal
   */
  #callerKeyBindsPrincipal(
    callerKey: string,
    registeredSubject: string,
    registered: AuthorityDescriptor
  ): boolean {
    if (callerKey === registeredSubject) return true;
    if (!this.#resolveAgentAuthority) return false;
    try {
      return this.#resolveAgentAuthority(callerKey) === registered;
    } catch {
      return false;
    }
  }

  /**
   * Normalizes a projection realm id: a non-empty trimmed string, else `null`.
   *
   * @param rawRealmId - Raw projection value
   * @returns Normalized realm id or `null`
   */
  #normalizeRealmId(rawRealmId: unknown): string | null {
    return typeof rawRealmId === 'string' && rawRealmId.trim() ? rawRealmId.trim() : null;
  }

  /**
   * Resolves a projection by the canonical `key` of the injected identity port
   * (Wave I, ticket d57cbc1), enumerating `listAgentIdentities()` when the port
   * supports it. Returns `null` when no enumeration exists or no (or several)
   * projections carry the key.
   *
   * @param identifier - Candidate canonical identity key (opaque)
   * @returns The matching projection or `null`
   */
  #projectionByKey(identifier: string): SchedulerIdentityProjection | null {
    if (typeof identifier !== 'string' || !identifier) return null;
    const port = this.#identityPort;
    if (!port || typeof port.listAgentIdentities !== 'function') return null;
    try {
      const projections = port.listAgentIdentities();
      if (!Array.isArray(projections)) return null;
      let match: SchedulerIdentityProjection | null = null;
      for (const projection of projections) {
        if (!projection || typeof projection !== 'object') continue;
        if (projection.key !== identifier) continue;
        if (match) return null;
        match = projection;
      }
      return match;
    } catch {
      return null;
    }
  }

  /**
   * Resolves an agent identifier through the injected identity port: canonical
   * `key` match first, then the port's own `getAgentIdentity` resolution
   * (realm-exact when a scope is supplied, unique-match otherwise).
   *
   * @param identifier - Agent identifier or canonical key (opaque)
   * @param scope - Optional trusted resolution scope
   * @returns The resolved projection or `null`
   */
  #getIdentity(identifier: string, scope?: SchedulerIdentityScope): SchedulerIdentityProjection | null {
    if (typeof identifier !== 'string' || !identifier) return null;
    const port = this.#identityPort;
    if (!port) return null;
    const byKey = this.#projectionByKey(identifier);
    if (byKey) return byKey;
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
   * Resolves an opaque identifier to its projection (key-match first, then the
   * port's unique-match resolution).
   *
   * @param identifier - Agent identifier or canonical key (opaque)
   * @returns The resolved projection or `null`
   */
  #resolveProjection(identifier: string | null | undefined): SchedulerIdentityProjection | null {
    if (typeof identifier !== 'string' || !identifier.trim()) return null;
    return this.#getIdentity(identifier.trim());
  }

  /**
   * Whether a bare identifier matches several registrations the identity port
   * can enumerate (Wave I, ticket d57cbc1): a realm-local id that lives in more
   * than one Realm has no resolvable scope, so realm-scoped operations fail
   * closed rather than guess. Ports without enumeration report `false`.
   *
   * @param identifier - Bare agent identifier to test
   * @returns True when several active registrations share the id
   */
  #isIdentifierAmbiguous(identifier: string): boolean {
    if (typeof identifier !== 'string' || !identifier) return false;
    const port = this.#identityPort;
    if (!port || typeof port.listAgentIdentities !== 'function') return false;
    try {
      const projections = port.listAgentIdentities();
      if (!Array.isArray(projections)) return false;
      let matches = 0;
      for (const projection of projections) {
        if (projection && typeof projection === 'object' && projection.id === identifier) {
          matches += 1;
          if (matches > 1) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Resolves the Realm scope of an agent subject through the injected identity
   * port, failing closed (`null`) when no port is injected, the subject is
   * blank, the projection is not an object, or the port throws. Canonical keys
   * resolve exactly by `key` first (Wave I, ticket d57cbc1); projections
   * without the optional realm fields stay ungrouped — identical to the A0-3
   * worldClock resolver.
   *
   * @param agentId - Agent subject or canonical key to resolve
   * @returns Realm scope or `null` when no trusted projection resolves
   */
  #resolveRealmScope(agentId: string | null | undefined): ResolvedRealmScope | null {
    if (!this.#identityPort || typeof agentId !== 'string' || !agentId.trim()) return null;

    const identity = this.#getIdentity(agentId.trim());
    if (!identity) return null;

    const realmBypass = identity.realmBypass === true;
    const realmId = realmBypass ? null : this.#normalizeRealmId(identity.realmId);

    return { realmId, realmBypass };
  }

  /**
   * Whether a stored ownership key matches a caller-supplied listing filter
   * (Wave I, ticket d57cbc1): literal equality first, then canonical `key`
   * equivalence — the filter resolves globally, else within the caller's Realm
   * scope when it is realm-bound. A filter that resolves to no identity matches
   * nothing (it can only narrow).
   *
   * @param filter - Caller-supplied owner filter
   * @param ownerKey - Stored ownership key of a schedule
   * @param principal - Reference-validated caller principal
   * @returns Whether the schedule satisfies the filter
   */
  #filterMatchesOwner(filter: string, ownerKey: string, principal: ResolvedPrincipal): boolean {
    if (ownerKey === filter) return true;
    const filterProjection = this.#resolveProjection(filter)
      || (principal.realmId && !principal.realmBypass
        ? this.#getIdentity(filter, { realmId: principal.realmId })
        : null);
    if (!filterProjection || typeof filterProjection.key !== 'string' || !filterProjection.key) return false;
    if (ownerKey === filterProjection.key) return true;
    const ownerProjection = this.#resolveProjection(ownerKey);
    return Boolean(ownerProjection && ownerProjection.key === filterProjection.key);
  }

  /**
   * Whether an opaque owner/target reference names the given principal,
   * comparing canonical `key`s when both resolve and falling back to the bare
   * registered reference (Wave I, ticket d57cbc1). Never matches across
   * Realms: a canonical reference only matches the same canonical identity.
   *
   * @param reference - Stored owner reference or caller-supplied target
   * @param principal - Reference-validated caller principal
   * @param projection - Optional pre-resolved projection of the reference
   * @returns Whether the reference identifies the principal
   */
  #referenceMatchesPrincipal(
    reference: string,
    principal: ResolvedPrincipal,
    projection?: SchedulerIdentityProjection | null
  ): boolean {
    if (reference === principal.identityRef || reference === principal.subject) return true;
    const resolved = projection !== undefined ? projection : this.#resolveProjection(reference);
    if (resolved && typeof resolved.key === 'string' && resolved.key) {
      return resolved.key === principal.identityRef;
    }
    return false;
  }

  /**
   * Resolves an agent-supplied target reference for realm gating and display
   * (Wave I, ticket d57cbc1): canonical `key` match first, then a realm-scoped
   * resolution within the caller's Realm for realm-bound principals, else the
   * port's unique-match resolution. Returns `null` when the port cannot resolve
   * the ref — the caller keeps its existing denial semantics.
   *
   * @param rawTarget - Target identifier as supplied
   * @param principal - Reference-validated caller principal, or `null`
   * @returns The resolved projection or `null`
   */
  #resolveTargetIdentity(
    rawTarget: string,
    principal: ResolvedPrincipal | null
  ): SchedulerIdentityProjection | null {
    const byKey = this.#projectionByKey(rawTarget);
    if (byKey) return byKey;
    if (!this.#identityPort) return null;
    if (principal && !principal.realmBypass && principal.realmId) {
      return this.#getIdentity(rawTarget, { realmId: principal.realmId });
    }
    return this.#getIdentity(rawTarget);
  }

  /**
   * Whether a resolved principal may arm a new schedule for `targetAgentId`.
   *
   * Bypass principals (injected internal principal / `realmBypass` projection)
   * and ungrouped principals keep the legacy target semantics. A realm-bound
   * principal may target only itself, same-realm members, or realm-bypass peers
   * (the hardcoded system director); unresolvable, ungrouped, and
   * other-realm targets fail closed. A caller whose own registration is
   * ambiguous across Realms is denied (its realm is unknowable).
   *
   * Canonical keying (Wave I, ticket d57cbc1): the target's projection is
   * pre-resolved by {@link RuntimeScheduler.#resolveTargetIdentity}, so a
   * canonical key target or a bare id shared by two Realms compares by
   * canonical identity and realm — never by the literal string alone.
   *
   * @param principal - Reference-validated caller principal
   * @param targetAgentId - Resolved schedule target as supplied
   * @param targetIdentity - Pre-resolved target projection, or `null`
   * @returns Whether the realm boundary permits the wake
   */
  #isScheduleTargetRealmAllowed(
    principal: ResolvedPrincipal,
    targetAgentId: string,
    targetIdentity: SchedulerIdentityProjection | null
  ): boolean {
    if (principal.identityAmbiguous) return false;
    if (principal.realmBypass || !principal.realmId) return true;
    if (this.#referenceMatchesPrincipal(targetAgentId, principal, targetIdentity)) return true;
    if (!targetIdentity) return false;
    if (targetIdentity.realmBypass === true) return true;
    const targetRealmId = this.#normalizeRealmId(targetIdentity.realmId);
    return targetRealmId !== null && targetRealmId === principal.realmId;
  }

  /**
   * Whether a resolved principal may cancel a schedule owned by `ownerAgentId`.
   *
   * Stricter than scheduling because cancellation is destructive: a realm-bound
   * principal may cancel only its own or same-realm-owned timers. The
   * director's reserved system scope coalesces with no other scope (V20-F3,
   * ticket 6504af9): a bypass-owned timer is cancellable only by a bypass
   * principal — never from the ungrouped (shared `null`) scope — while
   * unresolvable or ungrouped owners keep the legacy ungrouped parity for
   * non-system owners. A caller whose own registration is ambiguous across
   * Realms is denied (its realm is unknowable).
   *
   * Canonical ownership (Wave I, ticket d57cbc1): the stored owner reference is
   * matched by canonical `key` equivalence when it resolves, so the same
   * literal id owned in two Realms stays realm-exact.
   *
   * @param principal - Reference-validated caller principal
   * @param ownerAgentId - Owner (target) reference of the registered schedule
   * @returns Whether the realm boundary permits the cancellation
   */
  #isTaskOwnerRealmAllowed(principal: ResolvedPrincipal, ownerAgentId: string): boolean {
    if (principal.identityAmbiguous) return false;
    if (principal.realmBypass) return true;
    if (this.#referenceMatchesPrincipal(ownerAgentId, principal)) return true;

    const owner = this.#resolveRealmScope(ownerAgentId);
    // The system scope is one-way: no non-bypass caller (the ungrouped scope
    // included) may cancel a bypass-owned timer.
    if (owner && owner.realmBypass) return false;
    // Ungrouped principal: legacy shared-null parity for non-system owners.
    if (!principal.realmId) return true;
    return Boolean(owner && owner.realmId === principal.realmId);
  }

  /**
   * Whether a resolved principal may see a schedule owned by `ownerAgentId` in
   * `listSchedules()` (R3, ticket 10eab05).
   *
   * Visibility matrix:
   * - `realmBypass` identities (injected internal principal / system director)
   *   span every scope;
   * - own schedules are always visible;
   * - an ordinary (unprivileged) caller sees only its own schedules;
   * - a realm-bound root (privileged) additionally sees same-realm-owned
   *   schedules — never foreign-realm, ungrouped, or bypass-owned ones;
   * - an ungrouped/system principal sees only its own realm-free scope (owners
   *   that resolve ungrouped or unresolvable), never a realm owner and never a
   *   bypass-owned one: the director's reserved system scope coalesces with no
   *   other scope (V20-F3, ticket 6504af9).
   *
   * Canonical ownership (Wave I, ticket d57cbc1): the stored owner reference is
   * matched by canonical `key` equivalence when it resolves, so same literal
   * ids in two Realms stay separated. A caller whose own registration is
   * ambiguous across Realms sees nothing.
   *
   * Listing conveys no wake/cancel capability, so this predicate gates
   * metadata disclosure only (prompt text, target ids, timing).
   *
   * @param principal - Reference-validated caller principal
   * @param ownerAgentId - Owner (target) reference of the registered schedule
   * @returns Whether the projection may include the schedule
   */
  #isTaskVisibleToPrincipal(principal: ResolvedPrincipal, ownerAgentId: string): boolean {
    if (principal.identityAmbiguous) return false;
    if (principal.realmBypass) return true;
    if (this.#referenceMatchesPrincipal(ownerAgentId, principal)) return true;
    if (!principal.privileged) return false;

    const owner = this.#resolveRealmScope(ownerAgentId);
    // The system scope is not part of any other scope: a bypass-owned timer is
    // visible only to a bypass caller (handled above).
    if (owner && owner.realmBypass) return false;

    const ownerRealmId = owner ? owner.realmId : null;

    if (principal.realmId) {
      return ownerRealmId !== null && ownerRealmId === principal.realmId;
    }

    // Ungrouped/system principal: its own realm-free (shared null) scope.
    return ownerRealmId === null;
  }

  /**
   * Helper to emit runtime events through the injected SubsystemEmitPort.
   * The canonical port requires every event to carry a numeric `timestamp`
   * (epoch milliseconds), supplied by this emitter.
   * @param event - Runtime event
   */
  #emit(event: SchedulerEvent): void {
    if (this.#emitPort) {
      try {
        this.#emitPort.emit(event);
      } catch (err) {
        console.error('Error in RuntimeScheduler event emission:', err);
      }
    }
  }

  /**
   * Private executor when a one-shot timer reaches expiration.
   * Strictly enqueues to TriggerQueue rather than invoking turn directly (Invariant 1).
   * The expiry is terminal: the task ends `triggered` and is never re-armed.
   * @param task - Live timer record to expire
   */
  #executeTimerTrigger(task: ScheduledTask): void {
    if (task.status !== SCHEDULER_STATUS.PENDING) return;
    task.status = SCHEDULER_STATUS.TRIGGERED;
    task.triggeredAt = Date.now();
    task.timeoutHandle = null;

    this.#emit({
      type: 'schedule_triggered',
      timestamp: task.triggeredAt,
      agentId: task.ownerId,
      timerId: task.timerId,
      payload: this.#taskEventPayload(task)
    });

    try {
      if (this.#triggerQueue && typeof this.#triggerQueue.enqueue === 'function') {
        // Opaque dispatch addressing: the trigger substrate addresses the
        // registration by the exact reference supplied at schedule time (the
        // canonical key under wiring), never by a parsed/rebuilt key.
        this.#triggerQueue.enqueue({
          type: TRIGGER_TYPES.SCHEDULE,
          targetAgentId: task.agentRef,
          source: 'system:scheduler',
          payload: {
            timerId: task.timerId,
            prompt: task.prompt,
            scheduledAt: task.scheduledAt,
            triggeredAt: task.triggeredAt
          }
        });
      }
    } catch (err) {
      console.error(`Scheduled timer ${task.timerId} execution error:`, err);
    }
  }

  /**
   * Builds the legacy event payload shape with bare-id owner labels (Wave I,
   * ticket d57cbc1): internal identity keys and dispatch references never leak
   * into emitted subsystem events. Field-for-field the shape the pre-canonical
   * `{ ...task }` spread produced.
   *
   * @param task - Live timer record.
   * @returns Plain event payload with bare owner ids.
   * @internal
   */
  #taskEventPayload(task: ScheduledTask): Record<string, unknown> {
    return {
      timerId: task.timerId,
      agentId: task.ownerId,
      targetAgentId: task.ownerId,
      durationSeconds: task.durationSeconds,
      prompt: task.prompt,
      timerCondition: task.timerCondition,
      status: task.status,
      scheduledAt: task.scheduledAt,
      fireAt: task.fireAt,
      triggeredAt: task.triggeredAt,
      cancelledAt: task.cancelledAt,
      cancelReason: task.cancelReason,
      timeoutHandle: task.timeoutHandle
    };
  }

  /**
   * Whether a resolved sender scope may satisfy a timer owned by
   * `ownerAgentId` (V20-F4, ticket af00a71). The system scope is one-way:
   * only a realm-bypass sender reaches a bypass-owned timer, while a bypass
   * sender spans every scope. A resolved realm-bound sender matches only
   * same-realm owners; a resolved ungrouped sender matches only ungrouped or
   * unresolvable owners; an unresolvable sender keeps the legacy matching
   * scope, minus the system scope.
   *
   * Canonical senders (Wave I, ticket d57cbc1): a sender reference that is a
   * canonical key resolves exactly like any other opaque reference. A bare
   * sender id carried by several Realms has no determinable scope and never
   * satisfies a timer (the legacy unresolvable-sender fallback applies only to
   * ids with zero registrations), so an ambiguous sender can never
   * early-cancel a foreign Realm's timer.
   *
   * @param sender - Envelope sender id (`msg.from`).
   * @param senderScope - Resolved sender scope, or `null` when unresolvable.
   * @param senderBypass - Whether the sender's projection carries `realmBypass`.
   * @param ownerKey - Ownership key of the candidate schedule.
   * @returns Whether the sender's scope may satisfy the timer.
   * @internal
   */
  #senderScopeMatchesTimer(
    sender: string | undefined,
    senderScope: { realmId: string | null; realmBypass: boolean } | null,
    senderBypass: boolean,
    ownerKey: string
  ): boolean {
    if (senderBypass) return true;
    const owner = this.#resolveRealmScope(ownerKey);
    if (owner && owner.realmBypass) return false;
    if (ownerKey === sender) return true;
    if (!senderScope) {
      // A bare sender id carried by several Realms has no determinable scope:
      // it can never satisfy a timer through the legacy unresolvable-sender
      // fallback, so no broadcast or direct message crosses a realm boundary.
      if (sender && this.#isIdentifierAmbiguous(sender)) return false;
      return true;
    }
    if (!owner) return senderScope.realmId === null;
    return owner.realmId === senderScope.realmId;
  }

  /**
   * Inspects incoming messaging bus envelopes to satisfy message-driven early cancellation conditions.
   *
   * Invariant 3: Iterates pending schedules and cancels each whose `timerCondition` is satisfied.
   * `'any'` cancels for any sender that does not start with `system:` (a missing `from` also cancels);
   * any other non-`'never'` condition cancels only on an exact `msg.from` match; `'never'` waits for expiry.
   * Matching is scope-local (V20-F4, ticket af00a71): a realm-bypass sender spans every
   * scope; a bypass-owned (system-scope) timer is satisfied **only** by a bypass sender;
   * a resolved realm-bound sender matches only its own or same-realm timers (never foreign,
   * ungrouped, or system timers); a resolved ungrouped sender matches only ungrouped or
   * unresolvable owners; a sender with no resolvable identity projection keeps the legacy
   * matching scope minus the system scope — except a bare sender id carried by several Realms
   * (Wave I, ticket d57cbc1), which satisfies no timer at all. Broadcasts
   * (`msg.to === 'all'`) follow the same rule.
   *
   * @param msg - Incoming message envelope.
   * - `msg.from` - Message sender ID matched against `timerCondition`.
   * - `msg.to` - Target agent selector; a schedule is considered only when its `agentId` equals
   *   `msg.to`, or when `msg.to` is `'all'` (broadcast to every agent).
   * A non-object message or one without `to` is ignored.
   *
   * @remarks
   * Matching cancellations route through `cancelSchedule()` with the reason
   * `Early cancellation satisfied by message from '<sender>'`, so they clear the timer handle and
   * emit `schedule_cancelled` exactly like an explicit cancellation.
   *
   * @example
   * ```typescript
   * // Connect MessagingBus subscription to early cancellation listener:
   * messagingBus.subscribe('all', (msg) => {
   *   scheduler.handleIncomingMessageForTimers(msg);
   * });
   * ```
   */
  handleIncomingMessageForTimers(msg: {
    from?: string;
    to?: string;
    [key: string]: unknown;
  }): void {
    if (!msg || !msg.to) return;
    const sender = msg.from;
    const recipient = msg.to;

    // Scope-local matching (Realm wave A1, ticket 61dae28; V20-F3/F4, tickets
    // 6504af9 + af00a71): a direct message or a broadcast can satisfy only a
    // timer in a scope the sender can reach. The director's reserved system
    // scope is one-way — a non-bypass sender (the ungrouped scope included)
    // never satisfies a bypass-owned timer — and realm boundaries are
    // absolute. Senders with no resolvable identity projection (`system:*`,
    // unknown ids) keep the legacy matching scope, minus the system scope.
    const senderScope = this.#resolveRealmScope(sender);
    const senderBypass = Boolean(senderScope && senderScope.realmBypass);

    for (const task of this.#scheduledTasks.values()) {
      if (task.status !== SCHEDULER_STATUS.PENDING) continue;
      // Recipient matching compares the bare owner id (the msg.to vocabulary)
      // and the ownership key for canonical recipients; the sender-scope check
      // below supplies the realm isolation, so a bare recipient only ever
      // satisfies timers its sender may reach (Wave I, ticket d57cbc1).
      if (task.ownerId !== recipient && task.ownerKey !== recipient && recipient !== 'all') continue;

      if (!this.#senderScopeMatchesTimer(sender, senderScope, senderBypass, task.ownerKey)) continue;

      const condition = task.timerCondition || 'never';
      let shouldCancel = false;

      if (condition === 'any' && sender !== 'system:scheduler' && (!sender || !sender.startsWith('system:'))) {
        shouldCancel = true;
      } else if (condition !== 'never' && condition === sender) {
        shouldCancel = true;
      }

      if (shouldCancel) {
        // Internal engine path: the opaque injected principal, never fake
        // `system` contexts or flag bundles.
        this.cancelSchedule(task.timerId, `Early cancellation satisfied by message from '${sender}'`, {
          principal: this.#internalPrincipal ?? undefined
        });
      }
    }
  }

  /**
   * Schedules a deferred one-shot agent turn execution.
   * Enforces pure 1-line tool delegation by accepting `(params, context)`.
   *
   * Invariant 1: Timer expiration enqueues `TRIGGER_TYPES.SCHEDULE` to `TriggerQueue`
   * rather than invoking agent execution directly.
   * Invariant 4: Host `setTimeout` handles have `.unref()` called to prevent Node.js process hangs.
   *
   * @param params - Scheduling parameters (agentId, prompt, durationSeconds, etc.).
   * The target agent is resolved from `agentId`, then `targetAgentId`, then `context.agentId`, then
   * `context.callerAgentId`; a missing or blank target, an absent or empty `prompt`, a `prompt` that
   * is neither a string nor JSON-serializable (circular structure, `BigInt`), or a delay that is
   * absent, non-numeric, `NaN`, or non-positive produces an `INVALID_ARGUMENTS` receipt. Other
   * non-string prompts are normalized with `JSON.stringify`.
   * @param context - Execution context carrying the trusted `{ principal }` and legacy identity
   * claims (ignored). Defaults to `{}`.
   * @returns `ScheduleSuccessReceipt` with the generated `timerId` on registration success, or
   * `ScheduleErrorReceipt` with `INVALID_ARGUMENTS` for validation failure, `PERMISSION_DENIED`
   * when a realm-bound principal targets a foreign/unresolvable realm, or `SCHEDULER_UNAVAILABLE`
   * after `destroy()`.
   *
   * @remarks
   * Registration emits `schedule_registered`, arms one host timer with
   * `delayMs = Math.max(0, fireAt - Date.now())`, and returns without executing a turn.
   * On expiry the task is marked `triggered` (terminal for the one-shot alarm; it is never
   * re-armed) and `schedule_triggered` is emitted. The
   * `TRIGGER_TYPES.SCHEDULE` envelope carrying `{ timerId, prompt, scheduledAt, triggeredAt }`
   * is then best-effort enqueued on the injected `TriggerQueue`, so listeners observe the
   * event before the final trigger is enqueued; enqueue failures are logged and never
   * propagated. With no `TriggerQueue` injected, expiry is still recorded but nothing is enqueued.
   *
   * @example
   * ```typescript
   * // Tool Handler Pure Delegation:
   * const handleSchedule = async (params, context) => {
   *   const receipt = scheduler.schedule(params, context);
   *   if (!receipt.success) {
   *     throw new Error(`Schedule failed [${receipt.code}]: ${receipt.error}`);
   *   }
   *   return receipt;
   * };
   * ```
   */
  schedule(
    params?: ScheduleParams,
    context: SchedulerExecutionContext = {}
  ): ScheduleReceipt {
    if (this.#destroyed) {
      return {
        success: false,
        error: 'RuntimeScheduler is destroyed or unavailable',
        code: SCHEDULER_ERROR_CODES.SCHEDULER_UNAVAILABLE
      };
    }

    const rawParams: Partial<ScheduleParams> | null = params === undefined ? {} : params;

    if (!rawParams || typeof rawParams !== 'object') {
      return {
        success: false,
        error: 'Invalid schedule parameters object',
        code: SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS
      };
    }

    const targetAgentId = rawParams.agentId || rawParams.targetAgentId || context?.agentId || context?.callerAgentId;
    if (!targetAgentId || typeof targetAgentId !== 'string' || targetAgentId.trim() === '') {
      return {
        success: false,
        error: "Missing required string 'agentId'",
        code: SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS
      };
    }

    const prompt = rawParams.prompt;
    if (prompt === undefined || prompt === null || prompt === '') {
      return {
        success: false,
        error: "Missing required 'prompt'",
        code: SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS
      };
    }

    const rawDelay = rawParams.durationSeconds ?? rawParams.delay_seconds ?? rawParams.delaySeconds;
    const timerCondition = rawParams.timerCondition || rawParams.condition || 'never';

    if (rawDelay === undefined || typeof rawDelay !== 'number' || rawDelay <= 0 || isNaN(rawDelay)) {
      return {
        success: false,
        error: "Argument 'durationSeconds' must be a positive number",
        code: SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS
      };
    }
    const durationSeconds = rawDelay;

    let stringPrompt: string | undefined;
    if (typeof prompt === 'string') {
      stringPrompt = prompt;
    } else {
      try {
        stringPrompt = JSON.stringify(prompt);
      } catch {
        stringPrompt = undefined;
      }
      if (typeof stringPrompt !== 'string') {
        return {
          success: false,
          error: "Argument 'prompt' must be a string or a JSON-serializable value",
          code: SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS
        };
      }
    }

    // Realm confinement (Realm wave A1, ticket 61dae28) with canonical keying
    // (Wave I, ticket d57cbc1): the wake target must be the caller itself, a
    // same-realm peer, or a realm-bypass peer unless the caller spans realms.
    // Scope comes exclusively from the reference-validated principal plus the
    // injected identity projection; realm/identity claims on `params`/`context`
    // are never read. The target ref resolves by canonical key first, else
    // within the caller's realm scope, so a bare id shared by two Realms
    // resolves realm-locally.
    const realmPrincipal = this.#resolvePrincipal(context);
    const targetIdentity = this.#resolveTargetIdentity(targetAgentId, realmPrincipal);
    const ownerId = targetIdentity && typeof targetIdentity.id === 'string' && targetIdentity.id
      ? targetIdentity.id
      : targetAgentId;
    if (realmPrincipal && !this.#isScheduleTargetRealmAllowed(realmPrincipal, targetAgentId, targetIdentity)) {
      return {
        success: false,
        error: `Caller '${realmPrincipal.subject}' is not authorized to schedule for '${ownerId}' across a realm boundary`,
        code: SCHEDULER_ERROR_CODES.PERMISSION_DENIED
      };
    }

    const timerId = `timer_${Date.now()}_${++this.#timerCounter}`;
    const now = Date.now();
    const fireAt = now + Math.round(durationSeconds * 1000);

    // Owner keying (Wave I, ticket d57cbc1): `ownerKey` is the canonical
    // `(realmId, agentId)` identity when the target resolved through the
    // injected port (else the supplied reference), so ownership, visibility,
    // early-cancel, and teardown match realm-exactly even when the same literal
    // id is registered in two Realms. `agentRef` is the canonical dispatch
    // address when the port resolved one (the same partition key every enqueue
    // path addresses; the supplied reference is the legacy fallback); `ownerId`
    // is the bare display label.
    const task: ScheduledTask = {
      timerId,
      agentRef: targetIdentity && typeof targetIdentity.key === 'string' && targetIdentity.key
        ? targetIdentity.key
        : targetAgentId,
      ownerKey: targetIdentity && typeof targetIdentity.key === 'string' && targetIdentity.key
        ? targetIdentity.key
        : targetAgentId,
      ownerId,
      durationSeconds,
      prompt: stringPrompt,
      timerCondition,
      status: SCHEDULER_STATUS.PENDING,
      scheduledAt: now,
      fireAt,
      triggeredAt: null,
      cancelledAt: null,
      cancelReason: null,
      timeoutHandle: null
    };

    const delayMs = Math.max(0, task.fireAt - Date.now());
    task.timeoutHandle = setTimeout(async () => {
      this.#executeTimerTrigger(task);
    }, delayMs);

    if (task.timeoutHandle && typeof task.timeoutHandle.unref === 'function') {
      task.timeoutHandle.unref();
    }

    this.#scheduledTasks.set(timerId, task);

    this.#emit({
      type: 'schedule_registered',
      timestamp: now,
      agentId: ownerId,
      timerId,
      payload: this.#taskEventPayload(task)
    });

    return {
      success: true,
      timerId,
      targetAgentId: ownerId,
      prompt: stringPrompt,
      durationSeconds,
      timerCondition: task.timerCondition,
      scheduledAt: now,
      fireAt
    };
  }

  /**
   * Lists scheduled tasks with caller privilege filtering, status filtering, and dynamic countdowns.
   *
   * Invariant 5: Returns frozen, defensive `ScheduledTaskProjection` copies with dynamically
   * computed `remainingSeconds = Math.max(0, Math.ceil((fireAt - now) / 1000))`, recomputed on every call.
   * Authority is principal-driven (MOD-21 W3, default-deny): `context.principal`
   * must be the exact injected `InternalPrincipal` or a frozen registry
   * `AuthorityDescriptor` (validated by reference); an absent/forged principal
   * receives an empty list.
   *
   * Realm scoping (R3, ticket 10eab05): visibility combines the principal
   * privilege with the injected identity projection. An ordinary (unprivileged)
   * caller receives only its own schedules; a realm-bound root (privileged)
   * receives its own plus same-realm-owned schedules; the injected internal
   * principal and `realmBypass` identities span every scope; an ungrouped/system
   * principal receives only its own realm-free scope. An explicit
   * `options.agentId` filter narrows the resolved scope, never widens it, and no
   * foreign-realm projection (prompt text, target ids, timing) is computed.
   *
   * @param options - Filter options (`agentId`, `status`) or a target agent ID string. Defaults to
   * `{}`. A `status` other than `'all'` matches case-insensitively against `task.status`; `'all'`
   * and omission disable status filtering. Privilege- and identity-looking keys on `options` are
   * ignored: caller data never widens visibility or asserts identity.
   * @param context - Trusted principal context (`{ principal }`). Defaults to `{}` (anonymous).
   * Flag bundles, roles, reserved ids, and forged descriptor shapes are ignored.
   * @returns Always `{ success: true, schedules }`; this method never throws and never returns an error receipt.
   * An anonymous caller receives `{ success: true, schedules: [] }` and no projection
   * is computed.
   *
   * @example
   * ```typescript
   * const identity = identityPort.getAgentIdentity('agent-1');
   * const result = scheduler.listSchedules({ status: 'pending' }, { principal: identity?.authority });
   * for (const sched of result.schedules) {
   *   console.log(`[${sched.timerId}] ${sched.prompt} (fires in ${sched.remainingSeconds}s)`);
   * }
   * ```
   */
  listSchedules(
    options: ListSchedulesOptions | string = {},
    context: SchedulerExecutionContext = {}
  ): { success: true; schedules: ScheduledTaskProjection[] } {
    let agentFilter: string | null = null;
    let statusFilter = 'all';

    if (typeof options === 'string') {
      agentFilter = options;
    } else if (options && typeof options === 'object') {
      agentFilter = options.agentId || null;
      if (options.status) {
        statusFilter = String(options.status).toLowerCase();
      }
    }

    const principal = this.#resolvePrincipal(context);

    if (!principal) {
      // Privacy default-deny: anonymous callers see no schedules.
      return { success: true, schedules: [] };
    }

    if (!principal.privileged) {
      // Caller-controlled filters never widen: a non-privileged caller is
      // narrowed to its own identity by the visibility predicate, so an
      // explicit `agentId` filter is dropped exactly as before.
      agentFilter = null;
    }

    const now = Date.now();
    const schedules: ScheduledTaskProjection[] = [];

    for (const task of this.#scheduledTasks.values()) {
      if (agentFilter && !this.#filterMatchesOwner(agentFilter, task.ownerKey, principal)) continue;

      // Realm-scoped visibility (R3, ticket 10eab05): foreign-realm schedules
      // are withheld entirely — no projection is computed for them.
      if (!this.#isTaskVisibleToPrincipal(principal, task.ownerKey)) continue;

      if (statusFilter !== 'all') {
        const taskStatus = typeof task.status === 'string' ? task.status.toLowerCase() : '';
        if (taskStatus !== statusFilter) continue;
      }

      const remainingSeconds = Number.isFinite(task.fireAt)
        ? Math.max(0, Math.ceil((task.fireAt - now) / 1000))
        : 0;

      const proj = Object.freeze({
        timerId: task.timerId,
        agentId: task.ownerId,
        targetAgentId: task.ownerId,
        ...(task.durationSeconds !== undefined ? { durationSeconds: task.durationSeconds } : {}),
        remainingSeconds,
        countdownSeconds: remainingSeconds,
        prompt: task.prompt,
        timerCondition: typeof task.timerCondition === 'string' && task.timerCondition ? task.timerCondition : 'never',
        status: task.status,
        scheduledAt: task.scheduledAt,
        fireAt: task.fireAt,
        triggeredAt: typeof task.triggeredAt === 'number' && Number.isFinite(task.triggeredAt) ? task.triggeredAt : null,
        cancelledAt: typeof task.cancelledAt === 'number' && Number.isFinite(task.cancelledAt) ? task.cancelledAt : null,
        cancelReason: typeof task.cancelReason === 'string' ? task.cancelReason : null
      });

      schedules.push(proj);
    }

    return {
      success: true,
      schedules
    };
  }

  /**
   * Cancels an active or pending scheduled task by `timerId`.
   * Validates task ownership and caller authorization before cancellation.
   *
   * Ownership is default-deny (MOD-21 W3): `context.principal` must be the exact
   * injected `InternalPrincipal` or a frozen registry `AuthorityDescriptor`
   * (validated by reference). A privileged principal bypasses ownership checks;
   * an unprivileged principal may cancel only schedules whose `agentId` matches
   * its subject; an absent/forged principal is rejected with `PERMISSION_DENIED`
   * before any lifecycle-state check.
   *
   * Realm confinement (Realm wave A1): a realm-bound principal (identity
   * projection with a non-empty `realmId` and no `realmBypass`) may cancel only
   * its own or same-realm-owned timers even when privileged; foreign,
   * ungrouped, unresolvable, and bypass-owned timers are rejected with
   * `PERMISSION_DENIED` before any lifecycle-state check.
   *
   * Invariant 4 & Invariant 5: Clears active host timeout handle, marks status as `CANCELLED`,
   * records `cancelledAt` timestamp, and emits `schedule_cancelled` event.
   * Returns idempotent success if task was already cancelled.
   *
   * @param timerIdOrParams - Target timer ID string or parameter object. Object IDs are resolved
   * from `timerId`, then `task_id`, then `taskId`, then `id`; a missing or non-string ID yields
   * `INVALID_ARGUMENTS`. Privilege- and identity-looking keys (`isPrivileged`/`isAdmin`/`privileged`,
   * `callerAgentId`/`agentId`) on the object form are ignored: authorization is read only
   * from the trusted `context.principal`.
   * @param maybeReason - Optional cancellation reason if first parameter is string. Defaults to `null`.
   * An object form contributes only its `reason` field; privilege- and identity-looking keys are ignored.
   * @param context - Trusted principal context (`{ principal }`). Defaults to `{}` (anonymous).
   * Flags, roles, reserved ids, and forged descriptor shapes grant nothing.
   * @returns `CancelScheduleSuccessReceipt`, or `ScheduleErrorReceipt` with `INVALID_ARGUMENTS`,
   * `SCHEDULE_NOT_FOUND`, `PERMISSION_DENIED` (anonymous caller, cross-agent non-privileged
   * caller, or a realm-bound principal reaching across its realm boundary), `ALREADY_TRIGGERED`,
   * or `SCHEDULER_UNAVAILABLE`.
   * An already-cancelled task returns success with `alreadyCancelled: true`.
   * No dedicated already-cancelled error code exists: idempotent success is the contract.
   *
   * @example
   * ```typescript
   * const authority = identityPort.getAgentIdentity('agent-1')?.authority;
   * const receipt = scheduler.cancelSchedule(
   *   'timer_1710633600000_1',
   *   'User cancelled task',
   *   { principal: authority }
   * );
   *
   * if (receipt.success) {
   *   console.log(`Cancelled task ${receipt.timerId}`);
   * } else if (receipt.code === 'PERMISSION_DENIED') {
   *   console.error('Cannot cancel another agent\'s schedule!');
   * }
   * ```
   */
  cancelSchedule(
    timerIdOrParams: string | CancelScheduleParams,
    maybeReason: string | CancelScheduleParams | null = null,
    context: SchedulerExecutionContext = {}
  ): CancelScheduleReceipt {
    if (this.#destroyed) {
      return {
        success: false,
        error: 'RuntimeScheduler is destroyed or unavailable',
        code: SCHEDULER_ERROR_CODES.SCHEDULER_UNAVAILABLE
      };
    }

    let actualTimerId: string | null = null;
    let actualReason: string | null = typeof maybeReason === 'string' ? maybeReason : null;

    if (maybeReason && typeof maybeReason === 'object') {
      if (maybeReason.reason) actualReason = maybeReason.reason;
    }

    const principal = this.#resolvePrincipal(context);

    if (typeof timerIdOrParams === 'string') {
      actualTimerId = timerIdOrParams;
    } else if (timerIdOrParams && typeof timerIdOrParams === 'object') {
      actualTimerId = timerIdOrParams.timerId || timerIdOrParams.task_id || timerIdOrParams.taskId || timerIdOrParams.id || null;
      actualReason = timerIdOrParams.reason || actualReason;
    }

    if (!actualTimerId || typeof actualTimerId !== 'string') {
      return {
        success: false,
        error: "Missing required string 'timerId'",
        code: SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS
      };
    }

    const task = this.#scheduledTasks.get(actualTimerId);
    if (!task) {
      return {
        success: false,
        error: `Schedule with timerId '${actualTimerId}' not found`,
        code: SCHEDULER_ERROR_CODES.SCHEDULE_NOT_FOUND
      };
    }

    if (!principal) {
      return {
        success: false,
        error: `Anonymous caller is not authorized to cancel schedule '${actualTimerId}'`,
        code: SCHEDULER_ERROR_CODES.PERMISSION_DENIED
      };
    }
    // Ownership matches by canonical identity (Wave I, ticket d57cbc1): a
    // privileged principal bypasses ownership; an unprivileged principal may
    // cancel only schedules whose ownership key names its own identity.
    if (!principal.privileged && !this.#referenceMatchesPrincipal(task.ownerKey, principal)) {
      return {
        success: false,
        error: `Caller '${principal.subject}' is not authorized to cancel schedule owned by '${task.ownerId}'`,
        code: SCHEDULER_ERROR_CODES.PERMISSION_DENIED
      };
    }
    // Realm confinement (Realm wave A1, ticket 61dae28): agent authority never
    // escapes its realm — even a privileged realm-bound principal may cancel
    // only its own or same-realm-owned timers; foreign and unresolvable owners
    // fail closed before any lifecycle-state check.
    if (!this.#isTaskOwnerRealmAllowed(principal, task.ownerKey)) {
      return {
        success: false,
        error: `Caller '${principal.subject}' is not authorized to cancel schedule '${actualTimerId}' owned by '${task.ownerId}' across a realm boundary`,
        code: SCHEDULER_ERROR_CODES.PERMISSION_DENIED
      };
    }

    if (task.status === SCHEDULER_STATUS.CANCELLED) {
      return {
        success: true,
        timerId: actualTimerId,
        cancelledAt: task.cancelledAt ?? Date.now(),
        alreadyCancelled: true
      };
    }

    if (task.status === SCHEDULER_STATUS.TRIGGERED) {
      return {
        success: false,
        error: `Cannot cancel schedule '${actualTimerId}' that has already triggered`,
        code: SCHEDULER_ERROR_CODES.ALREADY_TRIGGERED
      };
    }

    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle);
      task.timeoutHandle = null;
    }

    task.status = SCHEDULER_STATUS.CANCELLED;
    task.cancelledAt = Date.now();
    task.cancelReason = actualReason || null;

    this.#emit({
      type: 'schedule_cancelled',
      timestamp: task.cancelledAt,
      agentId: task.ownerId,
      timerId: actualTimerId,
      payload: { timerId: actualTimerId, cancelledAt: task.cancelledAt, reason: actualReason }
    });

    return {
      success: true,
      timerId: actualTimerId,
      cancelledAt: task.cancelledAt
    };
  }

  /**
   * Terminates all pending scheduled timers belonging to a specific agent.
   * Invoked by `AgentLifecycleManager` during agent termination, eviction, or permanent purge.
   *
   * Invariant 4: Clears timeout handles immediately to guarantee zero event loop leaks.
   *
   * Canonical keying (Wave I, ticket d57cbc1): the teardown reference is
   * matched opaquely against the stored ownership key and the opaque dispatch
   * reference — the canonical `(realmId, agentId)` key passed by the wired
   * lifecycle path matches exactly; when the reference resolves through the
   * identity port, its canonical `key` also matches stored ownership keys
   * (pre-wiring bare-id teardown). The wired lifecycle path additionally
   * supplies the terminated record's bare `id` in `options.bareId`: a schedule
   * armed for that agent before it existed keeps the bare reference as its
   * dispatch/ownership key, so it is torn down by the explicit bare form while
   * a same-literal-id task armed under its canonical key in another Realm is
   * untouched (the display `ownerId` is never a match source). A bare id
   * carried by several Realms resolves to no identity and tears down only
   * tasks whose dispatch reference is that exact bare id.
   *
   * @param agentId - Canonical identity key (or bare id) of the terminated agent.
   * @param reason - Teardown reason explanation. Defaults to `'Terminated'`.
   * @param purge - If true, permanently deletes entries from the internal registry. Defaults to `false`.
   * @param options - Additive teardown identity: `bareId` is the terminated
   *   record's bare registered id, matched as an explicit second form against
   *   the stored dispatch/ownership references. Optional; omitted keeps the
   *   canonical-key-only behavior.
   *
   * @remarks
   * For every task owned by `agentId` the host timeout handle is cleared immediately. Tasks still
   * `pending` are marked `cancelled` with `reason` and emit `schedule_cancelled`; tasks in any other
   * state keep their status. With `purge` set, matching entries are deleted after cancellation and
   * disappear from `listSchedules()`.
   *
   * @example
   * ```typescript
   * // Agent lifecycle termination hook
   * scheduler.teardownForAgent('system:agent-1', 'Agent evicted from sandbox', true, { bareId: 'agent-1' });
   * ```
   */
  teardownForAgent(
    agentId: string,
    reason = 'Terminated',
    purge = false,
    options: { readonly bareId?: string | null } = {}
  ): void {
    if (!agentId || !this.#scheduledTasks) return;

    // Explicit bare-id form (Wave I, ticket d57cbc1): the wired lifecycle path
    // knows both the canonical key and the record's bare id, so pre-wiring
    // bare-referenced schedules are matched without parsing the key. Never
    // match the stored display `ownerId`, which stays bare on canonical-keyed
    // tasks and would cross Realm boundaries.
    const bareReference = options && typeof options.bareId === 'string' && options.bareId.trim()
      ? options.bareId.trim()
      : null;
    const referenceProjection = this.#resolveProjection(agentId);
    const canonicalReference = referenceProjection && typeof referenceProjection.key === 'string' && referenceProjection.key
      ? referenceProjection.key
      : null;
    for (const [tId, task] of this.#scheduledTasks.entries()) {
      if (this.#taskOwnedByReference(task, agentId, canonicalReference, bareReference)) {
        if (task.timeoutHandle) {
          clearTimeout(task.timeoutHandle);
          task.timeoutHandle = null;
        }

        if (task.status === SCHEDULER_STATUS.PENDING) {
          task.status = SCHEDULER_STATUS.CANCELLED;
          task.cancelledAt = Date.now();
          task.cancelReason = reason;

          this.#emit({
            type: 'schedule_cancelled',
            timestamp: task.cancelledAt,
            agentId: task.ownerId,
            timerId: task.timerId,
            payload: { timerId: task.timerId, cancelledAt: task.cancelledAt, reason: task.cancelReason }
          });
        }

        if (purge) {
          this.#scheduledTasks.delete(tId);
        }
      }
    }
  }

  /**
   * Whether a stored task belongs to the teardown reference (Wave I, ticket
   * d57cbc1): the canonical ownership key matches the resolved teardown key,
   * and a task dispatched or owned under the exact opaque reference also
   * matches it (pre-wiring bare-id teardown). The caller-supplied bare form
   * (`bareReference`, when present) is a second explicit reference matched the
   * same way, so a schedule armed for an agent before it existed keeps the
   * bare dispatch/ownership reference and is still torn down. Realm-exact: a
   * foreign Realm's same-literal-id task carries a canonical dispatch/
   * ownership reference and never matches either form; the bare display
   * `ownerId` is deliberately not a match source.
   *
   * @param task - Stored schedule.
   * @param teardownReference - Reference passed to `teardownForAgent`.
   * @param canonicalReference - Canonical key of the teardown reference, or `null`.
   * @param bareReference - The terminated record's bare id, or `null`.
   * @returns Whether the schedule is owned by the reference.
   */
  #taskOwnedByReference(
    task: ScheduledTask,
    teardownReference: string,
    canonicalReference: string | null,
    bareReference: string | null
  ): boolean {
    const matchesReference = (reference: string): boolean => (
      reference === teardownReference
      || (canonicalReference !== null && reference === canonicalReference)
      || (bareReference !== null && reference === bareReference)
    );
    return matchesReference(task.agentRef) || matchesReference(task.ownerKey);
  }

  /**
   * Cancels all pending schedules across all agents.
   * Invoked during sandbox runtime shutdown or reset.
   *
   * Invariant 4: Clears all timeout handles and marks all pending schedules as `CANCELLED`.
   *
   * @remarks
   * Only `pending` tasks are affected: each `cancelledAt` is recorded with reason `'Runtime shutdown'`.
   * No events are emitted and non-pending entries are left untouched.
   *
   * @example
   * ```typescript
   * // Clean runtime shutdown
   * scheduler.cancelAll();
   * ```
   */
  cancelAll(): void {
    for (const task of this.#scheduledTasks.values()) {
      if (task.status === SCHEDULER_STATUS.PENDING) {
        if (task.timeoutHandle) {
          clearTimeout(task.timeoutHandle);
          task.timeoutHandle = null;
        }
        task.status = SCHEDULER_STATUS.CANCELLED;
        task.cancelledAt = Date.now();
        task.cancelReason = 'Runtime shutdown';
      }
    }
  }

  /**
   * Exports scheduled timers for deterministic snapshot persistence (Invariant 7).
   * Conforms to the `SerializedScheduledTimer` schema in Module 6 (`persistence`).
   *
   * @returns A new array with one plain (non-frozen) record per registry entry, in insertion order.
   * Records carry the canonical schema fields plus the backward-compatibility aliases declared on
   * {@link SerializedScheduledTimer} (`timerId`, `targetAgentId`, `durationSeconds`, flat
   * `prompt`/`timerCondition`, `scheduledAt`, `fireAt`, `cancelReason`) and are safe for callers to mutate.
   * This method never throws and leaves the registry unchanged.
   *
   * Canonical keying (Wave I, ticket d57cbc1): `agentId`/`targetAgentId`
   * project the bare registered id (`ownerId`), so the host-facing snapshot
   * stays realm-opaque, while the additive opaque `agentRef` carries the
   * canonical dispatch reference; `importSchedules()` prefers `agentRef` and
   * re-resolves the canonical ownership key/dispatch reference through the
   * injected identity port, so a registration round-trips losslessly — even
   * when the same literal id is registered in two Realms — and a schedule
   * armed under the bare dispatch reference keeps that exact reference.
   *
   * @example
   * ```typescript
   * const snapshot = scheduler.exportSchedules();
   * await persistence.saveSnapshot('sandbox_schedules', snapshot);
   * ```
   */
  exportSchedules(): SerializedScheduledTimer[] {
    const result: SerializedScheduledTimer[] = [];
    for (const task of this.#scheduledTasks.values()) {
      result.push({
        id: task.timerId,
        timerId: task.timerId,
        agentId: task.ownerId,
        targetAgentId: task.ownerId,
        agentRef: task.agentRef,
        type: 'timeout',
        delayMs: task.durationSeconds !== undefined ? Math.round(task.durationSeconds * 1000) : undefined,
        durationSeconds: task.durationSeconds,
        payload: {
          prompt: task.prompt,
          timerCondition: task.timerCondition || 'never'
        },
        prompt: task.prompt,
        timerCondition: task.timerCondition || 'never',
        createdAt: task.scheduledAt,
        scheduledAt: task.scheduledAt,
        nextRunAt: task.fireAt,
        fireAt: task.fireAt,
        status: task.status,
        triggeredAt: task.triggeredAt || null,
        cancelledAt: task.cancelledAt || null,
        cancelReason: task.cancelReason || null
      });
    }
    return result;
  }

  /**
   * Restores scheduled timers from a persisted snapshot (Invariant 7).
   * Clears existing timers, imports serialized tasks, and re-arms future pending timers.
   *
   * @param schedulesList - Array of serialized timer records. The same aliases that
   * `exportSchedules()` emits are accepted (`id`/`timerId`, `agentId`/`targetAgentId`,
   * `agentRef` (preferred opaque dispatch reference), `nextRunAt`/`fireAt`, `delayMs`,
   * and `payload.prompt`/`payload.timerCondition`).
   *
   * @remarks
   * This is a destructive replace, not a merge: every existing handle is cleared and the registry is
   * emptied before records are read. A non-array argument is silently ignored, and malformed records
   * are skipped: records missing or carrying a non-string ID or agent, records whose present `status` is not one of the
   * canonical `'pending' | 'triggered' | 'cancelled'` values, and records whose non-string `prompt`
   * cannot be `JSON.stringify`-ed (e.g. a circular structure). Omitted fields default to
   * `status: 'pending'`, `timerCondition: 'never'`,
   * `scheduledAt = item.scheduledAt ?? createdAt ?? now`, and
   * `durationSeconds = item.durationSeconds ?? delayMs / 1000 ?? 0`. Only records whose
   * restored status is `'pending'` are armed, each with `delayMs = Math.max(0, fireAt - now)` and
   * `.unref()` when available; other statuses are imported without a live handle. No events are emitted.
   * After `destroy()` the import is rejected instead of re-arming timers.
   *
   * @throws Error with `code: 'SCHEDULER_UNAVAILABLE'` when the scheduler has been destroyed; no
   * timer is cleared or re-armed in that case.
   *
   * @example
   * ```typescript
   * const snapshot = await persistence.loadSnapshot('sandbox_schedules');
   * scheduler.importSchedules(snapshot);
   * ```
   */
  importSchedules(schedulesList: SerializedScheduledTimer[]): void {
    if (this.#destroyed) {
      const err: Error & { code?: SchedulerErrorCode } = new Error('RuntimeScheduler is destroyed or unavailable');
      err.code = SCHEDULER_ERROR_CODES.SCHEDULER_UNAVAILABLE;
      throw err;
    }
    if (!Array.isArray(schedulesList)) return;

    for (const task of this.#scheduledTasks.values()) {
      if (task.timeoutHandle) {
        clearTimeout(task.timeoutHandle);
        task.timeoutHandle = null;
      }
    }
    this.#scheduledTasks.clear();

    const now = Date.now();
    for (const item of schedulesList) {
      if (!item) continue;
      const timerId = item.timerId || item.id;
      // Preferred opaque dispatch reference (Wave I, ticket d57cbc1): the
      // additive `agentRef` field carries the canonical identity key when one
      // resolved at registration, so a snapshot restores realm-exactly even
      // when two Realms share the literal id. Bare `agentId`/`targetAgentId`
      // then re-resolve through the identity port.
      const rawAgentRef = typeof item.agentRef === 'string' && item.agentRef ? item.agentRef : null;
      const agentId = rawAgentRef || item.agentId || item.targetAgentId;
      if (!timerId || !agentId) continue;
      // Malformed snapshot IDs are skipped rather than copied: typed projections and
      // exports would otherwise emit object/number IDs under `string` declarations.
      if (typeof timerId !== 'string' || typeof agentId !== 'string') continue;

      const prompt = item.prompt ?? item.payload?.prompt ?? '';
      const timerCondition = typeof item.timerCondition === 'string'
        ? item.timerCondition
        : (typeof item.payload?.timerCondition === 'string' ? item.payload.timerCondition : 'never');

      // Malformed snapshot statuses are skipped rather than copied: a non-canonical
      // value would otherwise crash status filtering and could arm unknown state.
      const rawStatus = item.status;
      if (rawStatus !== undefined && rawStatus !== null && !CANONICAL_SCHEDULER_STATUSES.has(rawStatus)) {
        continue;
      }
      const status = rawStatus ?? SCHEDULER_STATUS.PENDING;

      let stringPrompt: string | undefined;
      if (typeof prompt === 'string') {
        stringPrompt = prompt;
      } else {
        try {
          stringPrompt = JSON.stringify(prompt);
        } catch {
          stringPrompt = undefined;
        }
        if (typeof stringPrompt !== 'string') continue;
      }

      const rawScheduledAt = item.scheduledAt ?? item.createdAt;
      const scheduledAt = typeof rawScheduledAt === 'number' && Number.isFinite(rawScheduledAt)
        ? rawScheduledAt
        : now;
      const durationSeconds = typeof item.durationSeconds === 'number' && Number.isFinite(item.durationSeconds)
        ? item.durationSeconds
        : (typeof item.delayMs === 'number' && Number.isFinite(item.delayMs) ? item.delayMs / 1000 : 0);
      const rawFireAt = item.fireAt ?? item.nextRunAt;
      if (rawFireAt !== undefined && (typeof rawFireAt !== 'number' || !Number.isFinite(rawFireAt))) {
        continue;
      }
      const fireAt = typeof rawFireAt === 'number'
        ? rawFireAt
        : scheduledAt + Math.round(durationSeconds * 1000);
      if (!Number.isFinite(fireAt)) continue;
      const triggeredAt = typeof item.triggeredAt === 'number' && Number.isFinite(item.triggeredAt)
        ? item.triggeredAt
        : null;
      const cancelledAt = typeof item.cancelledAt === 'number' && Number.isFinite(item.cancelledAt)
        ? item.cancelledAt
        : (status === SCHEDULER_STATUS.CANCELLED ? now : null);
      const cancelReason = typeof item.cancelReason === 'string' ? item.cancelReason : null;

      // Rebuild canonical ownership (Wave I, ticket d57cbc1): a snapshot
      // reference that is a canonical key or a uniquely resolvable bare id
      // regains its ownership key, its canonical dispatch reference, and bare
      // display id; unresolvable or ambiguous references stay opaque and fail
      // closed on cross-realm checks (the wired teardown still matches them by
      // the explicit bare-id form).
      const identity = this.#resolveProjection(agentId);
      const canonicalRef = identity && typeof identity.key === 'string' && identity.key
        ? identity.key
        : agentId;
      const task: ScheduledTask = {
        timerId,
        agentRef: canonicalRef,
        ownerKey: canonicalRef,
        ownerId: identity && typeof identity.id === 'string' && identity.id ? identity.id : agentId,
        durationSeconds,
        prompt: stringPrompt,
        timerCondition,
        status,
        scheduledAt,
        fireAt,
        triggeredAt,
        cancelledAt,
        cancelReason,
        timeoutHandle: null
      };

      if (task.status === SCHEDULER_STATUS.PENDING) {
        const delayMs = Math.max(0, task.fireAt - Date.now());
        task.timeoutHandle = setTimeout(async () => {
          this.#executeTimerTrigger(task);
        }, delayMs);

        if (task.timeoutHandle && typeof task.timeoutHandle.unref === 'function') {
          task.timeoutHandle.unref();
        }
      }

      this.#scheduledTasks.set(task.timerId, task);
    }
  }

  /**
   * Clears all active timer handles and resets the internal schedule registry to empty.
   *
   * Invariant 4: Guarantees no lingering timeouts in the Node.js event loop.
   *
   * @remarks
   * Cleared tasks are discarded without being marked `cancelled` and without emitting events, so
   * they simply disappear from `listSchedules()`. `reset()` is not persistent: the scheduler remains
   * usable after it returns.
   *
   * @example
   * ```typescript
   * scheduler.reset();
   * ```
   */
  reset(): void {
    for (const task of this.#scheduledTasks.values()) {
      if (task.timeoutHandle) {
        clearTimeout(task.timeoutHandle);
        task.timeoutHandle = null;
      }
    }
    this.#scheduledTasks.clear();
  }

  /**
   * Permanently destroys the scheduler instance and cancels all running timers.
   * Subsequent calls to `schedule()` or `cancelSchedule()` return `SCHEDULER_UNAVAILABLE`,
   * and `importSchedules()` throws it.
   *
   * Invariant 4: Ensures total lifecycle isolation and test environment teardown.
   *
   * @remarks
   * Equivalent to `reset()` followed by permanently marking the instance unavailable; repeated calls
   * are safe. `schedule()` and `cancelSchedule()` inspect the destroyed flag and return a
   * `SCHEDULER_UNAVAILABLE` error receipt, while `importSchedules()` throws an `Error` carrying that
   * code instead of re-arming timers; `listSchedules()`, `exportSchedules()`, `reset()`, and
   * `teardownForAgent()` remain callable.
   *
   * @example
   * ```typescript
   * afterEach(() => {
   *   scheduler.destroy();
   * });
   * ```
   */
  destroy(): void {
    this.reset();
    this.#destroyed = true;
  }
}
