/**
 * @packageDocumentation
 * Formal TypeScript definitions and rich JSDoc documentation for TriggerQueue.
 * 
 * Centralized Non-Blocking Trigger Queue Subsystem (Layer 2).
 * Enforces Invariant 3 (Centralized Non-Blocking Trigger Queue) and Invariant 4 (All Agents are Auto).
 * 
 * ### Architectural Overview
 * In an autonomous multi-agent environment, agents receive activations from asynchronous,
 * heterogeneous sources:
 * 1. **Mail Envelopes** delivered across the asynchronous `MessagingBus`.
 * 2. **Subagent Invocations** requested synchronously or asynchronously by caller agents.
 * 3. **Scheduled Alarms & Crons** fired by `WorldClock` and `RuntimeScheduler`.
 * 4. **Interactive User Turns** submitted via the user interface.
 * 
 * `TriggerQueue` provides the centralized, non-blocking ingestion and evaluation substrate
 * for all agent wakeups across the sandbox runtime.
 * 
 * Architectural Guarantees:
 * 1. Centralized Trigger Ingestion: Handles all canonical trigger types ('mail', 'invocation', 'schedule', 'user').
 * 2. Scoped Non-Blocking Execution: Within one evaluation snapshot, triggers for busy agents never
 *    occupy a dispatch slot or delay triggers for idle agents; arrivals during an in-flight batch
 *    are coalesced and evaluated after that batch settles.
 * 3. Intra-Agent FIFO Ordering: Triggers targeting the same agent maintain arrival order.
 * 4. Automatic Processing Loop: Evaluates queue on tick interval, immediate microtasks, and turn completion signals.
 * 
 * @module triggerQueue
 * @mayImport ../runtime/triggerDispatcher/index.ts
 * @invariant Single canonical enum: `TRIGGER_TYPES`/`TriggerType` are re-exported from `./runtime/triggerDispatcher.js`, the sole declaration site; the queue holds no second frozen enumeration object.
 * @invariant Pure DI behavior: all collaboration enters through the injected `dispatchAction` and `isAgentBusy` hooks; the canonical trigger enumeration is the only import.
 * @invariant Busy-agent isolation: within one evaluation snapshot, a trigger targeting an occupied or stalled agent is deferred without occupying a dispatch slot or blocking triggers targeting idle agents; ready triggers dispatch concurrently, and triggers arriving while a batch is in flight are coalesced and evaluated after that batch settles.
 * @invariant Strict intra-agent FIFO: triggers for the same agent are evaluated and dispatched in arrival order, at most one per evaluation tick; a trigger whose dispatch resolves `false` is re-inserted at the head of that agent's pending run, and deferred triggers are re-prepended ahead of newly arrived ones.
 * @invariant Encapsulated queue with autonomous dispatch: `#pendingQueue` is `#`-private and callers never dequeue, pop, or manipulate queue buffers; evaluation is self-driven by a coalesced `enqueue` microtask, the recurring `startProcessing()` timer (`.unref()`'d under Node.js), and the public reentrant `processTick()` post-turn kick.
 * @invariant Frozen read projections: `getPendingTriggers()` returns a frozen array of frozen trigger copies in arrival order; mutating the returned array or records has no effect on internal queue state. These diagnostics are engine/operator-only surfaces: no tool descriptor or agent-reachable port exposes them, and any future agent-reachable exposure must gate them on operator authority.
 * @invariant Realm-confined dispatch: when an identity port is injected, a trigger whose `source` resolves to a realm-bound caller (non-empty `realmId`, no `realmBypass`) is dispatched only when its target is the source itself, a same-realm peer, or a realm-bypass peer; foreign, ungrouped, and unresolvable targets are dropped from the queue instead of waking anyone. Unresolvable sources (system paths, `'unknown'`, legacy no-port operation) and ungrouped sources keep the legacy dispatch semantics.
 * @invariant Canonical identity keys: per-agent queues key by the identifier the runtime supplies at registration/subscription — bare realm-local ids before canonical keying and canonical `(realmId, agentId)` keys after — and the string is treated as opaque. Source and target scopes resolve through the injected identity port with the explicit `sourceKey` (canonical `AgentIdentityProjection.key`) first, then an exact key match on the received identifier, then the bare unique-match lookup; a bare id registered in two Realms is ambiguous and fails closed, so the trigger is dropped exactly like a foreign target. The dispatch outcome (`dispatchAction`, `isAgentBusy`) receives the stored identifier unchanged; the operator diagnostics surface (`getPendingTriggers`) projects registered canonical keys back to their bare `id`.
 */

// ============================================================================
// 1. Canonical Trigger Types & Constants
// ============================================================================

import { TRIGGER_TYPES, type TriggerType } from '../runtime/triggerDispatcher/index.ts';

/**
 * Immutable enumeration object of canonical trigger types.
 * Re-exported from `./runtime/triggerDispatcher/index.ts`; `triggerQueue` does not declare a
 * second frozen object.
 *
 * @example
 * ```typescript
 * import { TRIGGER_TYPES, TriggerQueue } from './triggerQueue/index.ts';
 * 
 * const queue = new TriggerQueue();
 * queue.enqueue({
 *   type: TRIGGER_TYPES.MAIL,
 *   targetAgentId: 'agent-bob',
 *   source: 'agent-alice',
 *   payload: { subject: 'Status Report', text: 'Task completed.' }
 * });
 * ```
 */
export { TRIGGER_TYPES };

export type { TriggerType };

// ============================================================================
// 2. Error Codes & Domain Exceptions
// ============================================================================

/**
 * Standard programmatic error codes thrown by TriggerQueue validation operations.
 * 
 * - `INVALID_ARGUMENT`: The `triggerData` parameter was omitted, null, not an object, or an array.
 * - `INVALID_TARGET_AGENT`: The `targetAgentId` was missing, non-string, or empty/whitespace.
 * - `INVALID_TRIGGER_TYPE`: The `type` was omitted or did not match one of `TRIGGER_TYPES`.
 */
export type TriggerQueueErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_TARGET_AGENT'
  | 'INVALID_TRIGGER_TYPE';

/**
 * Immutable enumeration object of trigger queue error codes.
 * Use for programmatic error classification and assertions in catch blocks.
 * 
 * @example
 * ```typescript
 * import { TriggerQueue, TRIGGER_QUEUE_ERROR_CODES, TriggerQueueError } from './triggerQueue/index.ts';
 * 
 * try {
 *   queue.enqueue({ targetAgentId: 'agent-1', type: 'invalid_type' as any });
 * } catch (err) {
 *   if (err instanceof TriggerQueueError && err.code === TRIGGER_QUEUE_ERROR_CODES.INVALID_TRIGGER_TYPE) {
 *     console.error('Handled invalid trigger type error:', err.message);
 *   }
 * }
 * ```
 */
export const TRIGGER_QUEUE_ERROR_CODES: Readonly<{
  readonly INVALID_ARGUMENT: 'INVALID_ARGUMENT';
  readonly INVALID_TARGET_AGENT: 'INVALID_TARGET_AGENT';
  readonly INVALID_TRIGGER_TYPE: 'INVALID_TRIGGER_TYPE';
}> = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_TARGET_AGENT: 'INVALID_TARGET_AGENT',
  INVALID_TRIGGER_TYPE: 'INVALID_TRIGGER_TYPE'
});

/**
 * Domain-specific error class for TriggerQueue validation and runtime exceptions.
 * Encapsulates a programmatic `code` property (`TriggerQueueErrorCode`) and optional structured details.
 * 
 * @example
 * ```typescript
 * import { TriggerQueueError, TRIGGER_QUEUE_ERROR_CODES } from './triggerQueue/index.ts';
 * 
 * try {
 *   queue.enqueue(null as any);
 * } catch (err) {
 *   if (err instanceof TriggerQueueError) {
 *     console.error(`TriggerQueue error [${err.code}]: ${err.message}`);
 *     if (err.details) {
 *       console.error('Error details:', err.details);
 *     }
 *   }
 * }
 * ```
 */
export class TriggerQueueError extends Error {
  /** Programmatic error code identifying the validation failure category */
  declare readonly code: TriggerQueueErrorCode;

  /** Optional diagnostic details, stored as a shallow-frozen copy; `undefined` when omitted */
  declare readonly details?: Readonly<Record<string, unknown>>;

  /**
   * Constructs a new TriggerQueueError instance.
   * 
   * @param message - Human-readable diagnostic description of the failure.
   * @param code - Programmatic error code from `TRIGGER_QUEUE_ERROR_CODES`.
   * @param details - Optional dictionary of structured diagnostic context; when supplied it is shallow-copied and frozen.
   */
  constructor(message: string, code: TriggerQueueErrorCode, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TriggerQueueError';
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

// ============================================================================
// 3. Trigger Entities & Payload Interfaces
// ============================================================================

/**
 * Immutable representation of an enqueued trigger record stored inside the queue substrate.
 * 
 * @typeParam TPayload - Type of the attached domain-specific context payload.
 * 
 * @example
 * ```typescript
 * import type { AgentTrigger } from './triggerQueue/index.ts';
 * 
 * async function handleTrigger(trigger: AgentTrigger<{ text: string }>) {
 *   console.log(`Processing trigger ${trigger.triggerId} of type ${trigger.type}`);
 *   console.log(`Target: ${trigger.targetAgentId}, Source: ${trigger.source}`);
 *   console.log(`Payload content: ${trigger.payload?.text ?? '(none)'}`);
 *   console.log(`Queued at: ${new Date(trigger.timestamp).toISOString()}`);
 * }
 * ```
 */
export interface AgentTrigger<TPayload = unknown> {
  /** Unique trigger identifier prefixed with 'trig_'; UUID-based when `crypto.randomUUID` is available, otherwise epoch plus random suffix */
  readonly triggerId: string;

  /** Canonical trigger type ('mail' | 'invocation' | 'schedule' | 'user') */
  readonly type: TriggerType;

  /** Identifier of the target agent to be activated */
  readonly targetAgentId: string;

  /** Initiator or subsystem source (e.g. 'agent_scout', 'system:scheduler', 'user') */
  readonly source: string;

  /** Domain-specific payload associated with the wakeup (or `null` if not provided) */
  readonly payload: TPayload | null;

  /** Unix epoch timestamp in milliseconds when the trigger was ingested */
  readonly timestamp: number;
}

/**
 * Input arguments for enqueuing a new agent trigger into the queue.
 * 
 * @typeParam TPayload - Type of the optional attached payload data.
 * 
 * @example
 * ```typescript
 * import type { EnqueueTriggerOptions } from './triggerQueue/index.ts';
 * 
 * const mailOptions: EnqueueTriggerOptions = {
 *   type: 'mail',
 *   targetAgentId: 'agent-researcher',
 *   source: 'agent-coordinator',
 *   payload: { messageId: 'msg-101', subject: 'Query Results' }
 * };
 * ```
 */
export interface EnqueueTriggerOptions<TPayload = unknown> {
  /** Canonical trigger type ('mail' | 'invocation' | 'schedule' | 'user') */
  readonly type: TriggerType;

  /** Non-empty, trimmed target agent identifier */
  readonly targetAgentId: string;

  /** Source component, agent identifier, or subsystem initiator (trimmed; blank or non-string values default to 'unknown') */
  readonly source?: string;

  /**
   * Canonical internal identity key of the source (`AgentIdentityProjection.key`,
   * Wave I ticket d57cbc1) when the runtime has already resolved the source's
   * registration. Internal only: it is never stored on the trigger record nor
   * surfaced by diagnostics; dispatch uses it to resolve the source's Realm
   * scope ahead of the `source` identifier. An unresolvable key falls back to
   * the `source` value.
   */
  readonly sourceKey?: string;

  /** Optional domain-specific payload (defaults to null) */
  readonly payload?: TPayload;
}

/**
 * Trusted identity projection consumed by the TriggerQueue realm filter.
 *
 * Structural mirror of the MOD-13 `AgentIdentityPort` projection; the canonical
 * definition lives in `runtime/index.ts`. The projection is trusted
 * construction output — callers never supply it.
 */
export interface TriggerQueueIdentityProjection {
  /** Registered agent identifier (realm-local and opaque). */
  readonly id?: string;
  /**
   * Canonical internal identity key of this registration (Wave I, ticket
   * d57cbc1), supplied by the runtime producer; optional and additive for
   * injected ports (an absent key simply never matches an explicit
   * `sourceKey`). Internal only — never a diagnostic or receipt value.
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
 * Trusted resolution scope accepted by the queue's identity port (Wave I,
 * ticket d57cbc1). Structural mirror of the runtime `AgentIdentityScope`;
 * present for API symmetry and passed through only by internal callers.
 */
export interface TriggerQueueIdentityScope {
  /** Realm membership to resolve exactly; `null` selects the system scope. */
  readonly realmId?: string | null;
  /** Resolve the unique match across every Realm. */
  readonly realmBypass?: boolean;
}

/**
 * Trusted identity resolver injected into the queue for Realm dispatch scope.
 * Structural mirror of the MOD-13 `AgentIdentityPort`; absent means no realm
 * information is available and the legacy, unfiltered dispatch applies.
 */
export interface TriggerQueueIdentityPort {
  /**
   * Resolves the identity projection of a registered agent, or `null` when no
   * trusted principal matches the subject.
   *
   * @param agentId - Realm-local source/target identifier to resolve.
   * @param scope - Optional trusted resolution scope (Wave I, ticket d57cbc1).
   * @returns Frozen identity projection or `null` (anonymous/system).
   */
  getAgentIdentity(agentId: string, scope?: TriggerQueueIdentityScope): TriggerQueueIdentityProjection | null;
  /**
   * Enumerates the active registrations a scope can resolve (Wave I, ticket
   * d57cbc1). Optional and additive: without it, canonical-key resolution
   * falls back to the bare lookup.
   *
   * @param scope - Optional trusted resolution scope.
   * @returns Frozen identity projections in registry insertion order.
   */
  listAgentIdentities?(scope?: TriggerQueueIdentityScope): TriggerQueueIdentityProjection[];
}

// ============================================================================
// 4. Configuration & Operational Options
// ============================================================================

/**
 * Construction configuration options for `TriggerQueue`.
 * Supports dependency injection of dispatch hooks, busy predicates, and evaluation loop tuning.
 * 
 * @example
 * ```typescript
 * import type { TriggerQueueOptions } from './triggerQueue/index.ts';
 * 
 * const options: TriggerQueueOptions = {
 *   dispatchAction: async (trigger) => {
 *     console.log(`Dispatching ${trigger.triggerId} to ${trigger.targetAgentId}`);
 *     return true; // Successfully handled
 *   },
 *   isAgentBusy: (agentId) => runtime.isAgentBusy(agentId),
 *   tickIntervalMs: 25,
 *   autoStart: true
 * };
 * ```
 */
export interface TriggerQueueOptions {
  /**
   * Asynchronous dispatch hook invoked when a trigger is ready to be executed by an idle agent.
   * - Any resolved value other than `false` marks the trigger as handled and removes it from the queue.
   * - Resolving to exactly `false` re-inserts the trigger at the head of that agent's pending triggers for re-evaluation on a later tick.
   * - If the hook throws or rejects, the error is caught and logged to prevent crashing the tick loop, and the trigger is discarded rather than re-inserted.
   * 
   * Default: `async () => true`
   * 
   * @param trigger - The immutable agent trigger record ready for execution.
   * @returns Promise resolving to `false` to request re-insertion; any other resolved value is treated as handled.
   */
  readonly dispatchAction?: (trigger: AgentTrigger) => Promise<boolean>;

  /**
   * Synchronous query predicate checking whether a target agent is currently executing or occupied.
   * Triggers for busy agents are retained in the queue while strictly preserving intra-agent FIFO order.
   * 
   * Default: `() => false`
   * 
   * @param agentId - The identifier of the agent to check.
   * @returns `true` if the agent is currently occupied, `false` if idle and ready.
   */
  readonly isAgentBusy?: (agentId: string) => boolean;

  /**
   * Interval in milliseconds for the background recurring evaluation tick loop.
   * Numbers greater than 0 are used as-is; non-numeric or non-positive values fall back to the default.
   * 
   * Default: `25` ms.
   */
  readonly tickIntervalMs?: number;

  /**
   * Whether to automatically start the background interval loop upon instantiation.
   * Set to `false` for manual tick control in deterministic unit tests.
   * 
   * Default: `true`.
   */
  readonly autoStart?: boolean;

  /**
   * Trusted identity resolver used to resolve Realm scope (`realmId`/
   * `realmBypass`) for trigger sources at dispatch time (Realm wave A1).
   * Optional and additive: without it no realm information is available and
   * dispatch keeps the legacy, unfiltered behavior.
   */
  readonly identityPort?: TriggerQueueIdentityPort | null;
}

// ============================================================================
// 5. Centralized Trigger Queue Class
// ============================================================================

/**
 * Centralized Non-Blocking Trigger Queue Subsystem (Layer 2).
 * 
 * Governed by three architectural invariants:
 * 1. **Busy-Agent Isolation:** Within one evaluation snapshot, busy agents never block or delay activations for idle agents; arrivals during an in-flight batch are coalesced and evaluated after that batch settles.
 * 2. **Intra-Agent FIFO Serialization:** Arrival sequence for each individual agent is strictly preserved.
 * 3. **Autonomous Dispatch:** Evaluates queue asynchronously on tick interval, microtasks, and post-turn kicks.
 * 
 * @example
 * ```typescript
 * import { TriggerQueue, TRIGGER_TYPES } from './triggerQueue/index.ts';
 * 
 * // 1. Instantiate the queue with runtime hooks
 * const triggerQueue = new TriggerQueue({
 *   dispatchAction: async (trigger) => {
 *     console.log(`Waking agent ${trigger.targetAgentId} for trigger ${trigger.triggerId}`);
 *     await agentRuntime.executeTurn(trigger.targetAgentId, trigger);
 *     return true;
 *   },
 *   isAgentBusy: (agentId) => agentRuntime.isAgentExecuting(agentId),
 *   tickIntervalMs: 25,
 *   autoStart: true
 * });
 * 
 * // 2. Enqueue wakeups from heterogeneous sources
 * const triggerId = triggerQueue.enqueue({
 *   type: TRIGGER_TYPES.MAIL,
 *   targetAgentId: 'agent-bob',
 *   source: 'agent-alice',
 *   payload: { subject: 'Meeting', body: 'Let us sync.' }
 * });
 * 
 * // 3. Inspect diagnostics non-mutatively
 * console.log(`Pending for Bob: ${triggerQueue.getPendingCount('agent-bob')}`);
 * 
 * // 4. Clean lifecycle teardown
 * triggerQueue.dispose();
 * ```
 */
export class TriggerQueue {
  #pendingQueue: AgentTrigger[] = [];
  #dispatchAction: (trigger: AgentTrigger) => Promise<boolean>;
  #isAgentBusy: (agentId: string) => boolean;
  #tickIntervalMs: number;
  #timerHandle: (ReturnType<typeof setInterval> & { unref?: () => void })|null = null;
  #isProcessing = false;
  #isTicking = false;
  #hasPendingTick = false;
  #microtaskScheduled = false;
  #identityPort: TriggerQueueIdentityPort | null = null;
  /**
   * Private side-car of canonical source keys keyed by `triggerId` (Wave I,
   * ticket d57cbc1): the trusted `sourceKey` never rides the frozen
   * {@link AgentTrigger} record, so diagnostics and payloads cannot surface it.
   */
  #sourceKeys = new Map<string, string>();

  /**
   * Initializes TriggerQueue with dispatch hook, busy predicate, and evaluation loop.
   * 
   * @param options - Construction and operational configuration options.
   * 
   * @example
   * ```typescript
   * const queue = new TriggerQueue({
   *   dispatchAction: async (trigger) => {
   *     return await dispatchToAgent(trigger);
   *   },
   *   isAgentBusy: (agentId) => busyAgentSet.has(agentId),
   *   tickIntervalMs: 50,
   *   autoStart: true
   * });
   * ```
   */
  constructor(options: TriggerQueueOptions = {}) {
    this.#dispatchAction = typeof options.dispatchAction === 'function'
      ? options.dispatchAction
      : (async () => true);

    this.#isAgentBusy = typeof options.isAgentBusy === 'function'
      ? options.isAgentBusy
      : (() => false);

    this.#tickIntervalMs = typeof options.tickIntervalMs === 'number' && options.tickIntervalMs > 0
      ? options.tickIntervalMs
      : 25;

    this.#identityPort = (options.identityPort && typeof options.identityPort.getAgentIdentity === 'function')
      ? options.identityPort
      : null;

    if (options.autoStart !== false) {
      this.startProcessing();
    }
  }

  /**
   * Resolves a canonical identity key through the injected port's
   * `listAgentIdentities()` (Wave I, ticket d57cbc1), failing closed (`null`)
   * when the port exposes no enumeration, no registration matches, more than
   * one matches, or the port throws. The key is an opaque exact-match string.
   *
   * @param key - Candidate canonical identity key.
   * @returns Frozen identity projection or `null`.
   */
  #resolveProjectionByKey(key: string | null | undefined): TriggerQueueIdentityProjection | null {
    const port = this.#identityPort;
    if (!port || typeof port.listAgentIdentities !== 'function' || typeof key !== 'string' || !key) return null;
    try {
      const matches = port.listAgentIdentities().filter(
        (projection) => projection && typeof projection === 'object' && projection.key === key
      );
      return matches.length === 1 ? matches[0] : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a source/target identifier to its trusted identity projection
   * (Wave I, ticket d57cbc1): the explicit canonical `sourceKey` first, then an
   * exact key match on the received identifier (the runtime supplies canonical
   * keys after the wiring lane), then the legacy bare unique-match lookup.
   * Every failure mode — no port, blank subject, no match, ambiguous id,
   * throwing port — fails closed to `null`.
   *
   * @param identifier - Received source/target identifier (opaque).
   * @param explicitKey - Optional canonical key supplied by the runtime.
   * @returns Trusted identity projection or `null`.
   */
  #resolveProjection(
    identifier: string | null | undefined,
    explicitKey?: string | null
  ): TriggerQueueIdentityProjection | null {
    const port = this.#identityPort;
    if (!port || typeof identifier !== 'string' || !identifier.trim()) return null;
    const subject = identifier.trim();

    if (typeof explicitKey === 'string' && explicitKey.trim()) {
      const byExplicitKey = this.#resolveProjectionByKey(explicitKey.trim());
      if (byExplicitKey) return byExplicitKey;
    }

    const byIdentifierKey = this.#resolveProjectionByKey(subject);
    if (byIdentifierKey) return byIdentifierKey;

    let identity: TriggerQueueIdentityProjection | null | undefined;
    try {
      identity = port.getAgentIdentity(subject);
    } catch {
      return null;
    }
    return (identity && typeof identity === 'object') ? identity : null;
  }

  /**
   * Resolves the Realm scope of an agent subject through the injected identity
   * port, failing closed (`null`) when no port is injected, the subject is
   * blank, the projection is not an object, or the port throws. Projections
   * without the optional realm fields stay ungrouped — identical to the A0-3
   * worldClock resolver.
   *
   * Wave I (ticket d57cbc1): the projection also carries the canonical `key`
   * and bare `id` so self-recognition works across identifier forms.
   *
   * @param identifier - Received source/target identifier (opaque).
   * @param explicitKey - Optional canonical key supplied by the runtime.
   * @returns Realm scope plus resolved identities, or `null` when unresolved.
   */
  #resolveRealmScope(
    identifier: string | null | undefined,
    explicitKey?: string | null
  ): { realmId: string | null; realmBypass: boolean; key: string | null; id: string | null } | null {
    const identity = this.#resolveProjection(identifier, explicitKey);
    if (!identity) return null;

    const realmBypass = identity.realmBypass === true;
    const rawRealmId = identity.realmId;
    const realmId = (!realmBypass && typeof rawRealmId === 'string' && rawRealmId.trim())
      ? rawRealmId.trim()
      : null;

    return {
      realmId,
      realmBypass,
      key: (typeof identity.key === 'string' && identity.key.trim()) ? identity.key.trim() : null,
      id: (typeof identity.id === 'string' && identity.id.trim()) ? identity.id.trim() : null
    };
  }

  /**
   * Diagnostic label of a stored source/target identifier (Wave I, ticket
   * d57cbc1): a registered canonical key projects back to the projection's
   * bare `id`; every other identifier passes through unchanged.
   *
   * @param value - Stored source/target identifier.
   * @returns The bare-id label when the identifier is a registered key.
   */
  #identityLabel(value: string): string {
    if (typeof value !== 'string' || !value) return value;
    const identity = this.#resolveProjectionByKey(value);
    if (identity && typeof identity.id === 'string' && identity.id.trim()) return identity.id.trim();
    return value;
  }

  /**
   * Whether a pending trigger's stored target matches a diagnostic filter
   * value: the identifier received at registration (exact match, keeping the
   * queue keyed as supplied) or its projected bare-id label (Wave I, ticket
   * d57cbc1). A bare id shared by two Realms matches both registrations'
   * triggers — an accepted ambiguity of the operator-only diagnostics surface.
   *
   * @param trigger - Candidate trigger record.
   * @param normalized - Trimmed filter identifier.
   * @returns Whether the trigger belongs to the filter.
   */
  #matchesTarget(trigger: AgentTrigger, normalized: string): boolean {
    return trigger.targetAgentId === normalized || this.#identityLabel(trigger.targetAgentId) === normalized;
  }

  /**
   * Whether a pending trigger may be dispatched without crossing a realm
   * boundary (Realm wave A1; Wave I, ticket d57cbc1).
   *
   * Enforcement applies only when the trigger `source` resolves to a
   * realm-bound caller (non-empty `realmId`, no `realmBypass`). Such a source
   * may wake itself, a same-realm peer, or a realm-bypass peer; foreign,
   * ungrouped, and unresolvable targets fail closed. Self-recognition accepts
   * the identical identifier, the explicit `sourceKey`, or the same resolved
   * registration, so a queue keyed canonically and a source referenced by bare
   * id still recognise each other. Unresolvable or ungrouped sources — system
   * paths, `'unknown'`, and legacy no-port operation — keep the legacy
   * dispatch semantics.
   *
   * @param trigger - Candidate trigger record.
   * @returns `true` when dispatch is permitted.
   */
  #isRealmDispatchAllowed(trigger: AgentTrigger): boolean {
    const sourceKey = this.#sourceKeys.get(trigger.triggerId) ?? null;
    const sourceScope = this.#resolveRealmScope(trigger.source, sourceKey);
    if (!sourceScope || sourceScope.realmBypass || !sourceScope.realmId) return true;

    const targetScope = this.#resolveRealmScope(trigger.targetAgentId);

    if (trigger.targetAgentId === trigger.source) return true;
    if (sourceKey && trigger.targetAgentId === sourceKey) return true;
    if (sourceScope.key && targetScope && targetScope.key && targetScope.key === sourceScope.key) return true;

    if (!targetScope) return false;
    if (targetScope.realmBypass) return true;
    return targetScope.realmId === sourceScope.realmId;
  }

  /**
   * Indicates whether the background recurring evaluation interval loop is currently active.
   * 
   * @example
   * ```typescript
   * if (!queue.isProcessing) {
   *   queue.startProcessing();
   * }
   * ```
   */
  get isProcessing(): boolean {
    return this.#isProcessing;
  }

  /**
   * Configured evaluation tick interval in milliseconds.
   * 
   * @example
   * ```typescript
   * console.log(`Queue tick rate: ${queue.tickIntervalMs}ms`);
   * ```
   */
  get tickIntervalMs(): number {
    return this.#tickIntervalMs;
  }

  /**
   * Validates and enqueues a trigger for an agent.
   * Immediately schedules a coalesced microtask evaluation tick via `queueMicrotask` to ensure near-zero wakeup latency.
   * The stored trigger normalizes `targetAgentId` and `source` by trimming, defaults `source` to `'unknown'`, and defaults an omitted `payload` to `null`. The optional `sourceKey` (canonical Wave I identity key) is kept in a private side-car, never on the frozen trigger record.
   * 
   * @typeParam TPayload - Type of the attached context payload.
   * @param triggerData - Ingestion parameters including type, targetAgentId, optional source, and payload.
   * @returns Unique trigger identifier prefixed with `'trig_'`.
   * 
   * @throws `TriggerQueueError` - With code `'INVALID_ARGUMENT'` if `triggerData` is omitted, null, not an object, or an array.
   * @throws `TriggerQueueError` - With code `'INVALID_TARGET_AGENT'` if `targetAgentId` is missing, not a string, or blank.
   * @throws `TriggerQueueError` - With code `'INVALID_TRIGGER_TYPE'` if `type` is not one of `TRIGGER_TYPES`.
   * 
   * @example
   * ```typescript
   * // Enqueueing an asynchronous mail wakeup
   * const trigId = queue.enqueue({
   *   type: TRIGGER_TYPES.MAIL,
   *   targetAgentId: 'agent-writer',
   *   source: 'agent-editor',
   *   payload: { chapterId: 3, feedback: 'Great revision!' }
   * });
   * console.log(`Enqueued mail trigger: ${trigId}`);
   * ```
   */
  enqueue<TPayload = unknown>(triggerData: EnqueueTriggerOptions<TPayload>): string {
    if (!triggerData || typeof triggerData !== 'object' || Array.isArray(triggerData)) {
      throw new TriggerQueueError(
        'enqueue requires a valid triggerData object',
        TRIGGER_QUEUE_ERROR_CODES.INVALID_ARGUMENT
      );
    }

    const { type, targetAgentId, source, sourceKey, payload } = triggerData;

    if (typeof targetAgentId !== 'string' || !targetAgentId.trim()) {
      throw new TriggerQueueError(
        "enqueue requires a non-empty string 'targetAgentId'",
        TRIGGER_QUEUE_ERROR_CODES.INVALID_TARGET_AGENT
      );
    }

    const validTypes = Object.values(TRIGGER_TYPES);
    if (!type || !validTypes.includes(type)) {
      throw new TriggerQueueError(
        `Invalid trigger type '${type}'. Must be one of: ${validTypes.join(', ')}`,
        TRIGGER_QUEUE_ERROR_CODES.INVALID_TRIGGER_TYPE
      );
    }

    const triggerId = generateTriggerId('trig');
    const timestamp = Date.now();

    const trigger: AgentTrigger<TPayload> = Object.freeze({
      triggerId,
      type,
      targetAgentId: targetAgentId.trim(),
      source: typeof source === 'string' && source.trim() ? source.trim() : 'unknown',
      payload: payload !== undefined ? payload : null,
      timestamp
    });

    this.#pendingQueue.push(trigger);

    // Canonical source key side-car (Wave I, ticket d57cbc1): kept off the
    // frozen record so diagnostics and payloads never surface it.
    if (typeof sourceKey === 'string' && sourceKey.trim()) {
      this.#sourceKeys.set(triggerId, sourceKey.trim());
    }

    // Schedule immediate asynchronous evaluation
    if (!this.#microtaskScheduled) {
      this.#microtaskScheduled = true;
      queueMicrotask(() => {
        this.#microtaskScheduled = false;
        this.processTick().catch((err) => {
          console.error('TriggerQueue: microtask processTick error:', err);
        });
      });
    }

    return triggerId;
  }

  /**
   * Re-inserts an unhandled trigger into #pendingQueue at the head of that agent's pending triggers.
   * @param trigger - The unhandled trigger record to re-insert.
   */
  #reinsertAtHead(trigger: AgentTrigger): void {
    if (!trigger || typeof trigger !== 'object') return;
    const targetId = trigger.targetAgentId;
    const idx = this.#pendingQueue.findIndex(t => t.targetAgentId === targetId);
    if (idx !== -1) {
      this.#pendingQueue.splice(idx, 0, trigger);
    } else {
      this.#pendingQueue.unshift(trigger);
    }
  }

  /**
   * Evaluates pending triggers against agent busy states.
   * 
   * ### Algorithmic Behavior:
   * 1. Takes an atomic snapshot of the internal queue.
   * 2. Drops triggers whose source is realm-bound and whose target resolves outside that realm (Realm wave A1); dropped triggers are neither dispatched nor re-queued.
   * 3. Partitions the surviving triggers into `readyTriggers` (for idle agents) and `remainingTriggers` (for busy agents or agents already assigned a trigger this tick).
   * 4. Prepends `remainingTriggers` back to the front of the queue to strictly preserve intra-agent arrival FIFO order.
   * 5. Concurrently dispatches all `readyTriggers` via `Promise.allSettled(readyTriggers.map(...))`.
   * 6. If `dispatchAction` resolves to `false`, re-inserts the trigger at the head of that agent's pending queue.
   * 7. Catches and logs per-trigger dispatch errors; a rejected dispatch is discarded without aborting the remaining dispatches.
   * 
   * Safe for concurrent and reentrant invocations; calls made while a tick is active return immediately and coalesce into at most one follow-up microtask tick.
   * 
   * @returns Promise settling when all ready triggers for the current tick have settled their dispatch actions; a coalesced invocation resolves immediately.
   * 
   * @example
   * ```typescript
   * // Post-turn reactive kick from TurnExecutionEngine or AgentLifecycleManager
   * await queue.processTick();
   * ```
   */
  async processTick(): Promise<void> {
    if (this.#isTicking) {
      this.#hasPendingTick = true;
      return;
    }
    this.#isTicking = true;

    try {
      if (this.#pendingQueue.length === 0) {
        return;
      }

      const remainingTriggers: AgentTrigger[] = [];
      const readyTriggers: AgentTrigger[] = [];
      const busyAgentsThisTick = new Set<string>();

      // Snapshot current queue
      const snapshot = this.#pendingQueue;
      this.#pendingQueue = [];

      for (let i = 0; i < snapshot.length; i++) {
        const trigger = snapshot[i];
        const agentId = trigger.targetAgentId;

        // Realm-confined dispatch (Realm wave A1; Wave I, ticket d57cbc1): a
        // trigger whose source is realm-bound never wakes a target outside its
        // realm. Dropped triggers are discarded rather than re-queued, so a
        // denied wake cannot loop; the canonical-source side-car entry goes
        // with it.
        if (!this.#isRealmDispatchAllowed(trigger)) {
          this.#sourceKeys.delete(trigger.triggerId);
          continue;
        }

        const agentIsBusy = (typeof this.#isAgentBusy === 'function' && this.#isAgentBusy(agentId) === true) ||
          busyAgentsThisTick.has(agentId);

        if (agentIsBusy) {
          // Keep trigger in queue and mark agent busy for remaining items in this tick (preserves intra-agent FIFO)
          busyAgentsThisTick.add(agentId);
          remainingTriggers.push(trigger);
        } else {
          // Agent is ready for dispatch (ensuring at most ONE trigger per agent is dispatched in this tick)
          busyAgentsThisTick.add(agentId);
          readyTriggers.push(trigger);
        }
      }

      // Re-insert skipped triggers at head, ahead of any newly arrived triggers during iteration
      this.#pendingQueue = [...remainingTriggers, ...this.#pendingQueue];

      // Concurrently dispatch all ready triggers
      if (readyTriggers.length > 0) {
        await Promise.allSettled(
          readyTriggers.map(async (trigger) => {
            try {
              const handled = await this.#dispatchAction(trigger);
              if (handled === false) {
                this.#reinsertAtHead(trigger);
              } else {
                this.#sourceKeys.delete(trigger.triggerId);
              }
            } catch (err) {
              this.#sourceKeys.delete(trigger.triggerId);
              console.error(`TriggerQueue: dispatch failed for trigger ${trigger.triggerId}:`, err);
            }
          })
        );
      }
    } finally {
      this.#isTicking = false;
      if (this.#hasPendingTick) {
        this.#hasPendingTick = false;
        queueMicrotask(() => {
          this.processTick().catch((err) => {
            console.error('TriggerQueue: pending tick error:', err);
          });
        });
      }
    }
  }

  /**
   * Starts the background recurring interval evaluation loop at `tickIntervalMs`.
   * When running under Node.js, the internal timer handle is `.unref()`'d so it does not prevent process exit.
   * Idempotent if the loop is already running.
   * 
   * @example
   * ```typescript
   * queue.startProcessing();
   * console.log(queue.isProcessing); // true
   * ```
   */
  startProcessing(): void {
    if (this.#isProcessing) return;
    this.#isProcessing = true;
    this.#timerHandle = setInterval(() => {
      this.processTick().catch((err) => {
        console.error('TriggerQueue: periodic tick error:', err);
      });
    }, this.#tickIntervalMs);

    if (this.#timerHandle && typeof this.#timerHandle.unref === 'function') {
      this.#timerHandle.unref();
    }
  }

  /**
   * Stops the background recurring evaluation loop and clears active timer handles.
   * Idempotent if already stopped.
   * 
   * @example
   * ```typescript
   * queue.stopProcessing();
   * console.log(queue.isProcessing); // false
   * ```
   */
  stopProcessing(): void {
    this.#isProcessing = false;
    if (this.#timerHandle) {
      clearInterval(this.#timerHandle);
      this.#timerHandle = null;
    }
  }

  /**
   * Clears and discards all currently pending triggers from the internal queue buffer.
   * Does not halt the background interval timer.
   * 
   * @example
   * ```typescript
   * queue.clear();
   * console.log(queue.getPendingCount()); // 0
   * ```
   */
  clear(): void {
    this.#pendingQueue = [];
    this.#sourceKeys.clear();
  }

  /**
   * Complete lifecycle teardown.
   * Halts the background evaluation loop (`stopProcessing()`) and flushes all pending triggers (`clear()`).
   * 
   * @example
   * ```typescript
   * // In AgentRuntime.dispose():
   * queue.dispose();
   * ```
   */
  dispose(): void {
    this.stopProcessing();
    this.clear();
  }

  /**
   * Returns the count of pending triggers currently held in the queue.
   * 
   * @param agentId - Optional agent ID filter, matched after trimming against the identifier received at registration or its projected bare-id label (Wave I, ticket d57cbc1). Blank or non-string values are ignored and count all pending triggers.
   * @returns Total number of matching pending triggers ($O(N)$ non-mutating traversal).
   * 
   * @example
   * ```typescript
   * const totalPending = queue.getPendingCount();
   * const bobPending = queue.getPendingCount('agent-bob');
   * console.log(`Total: ${totalPending}, Bob: ${bobPending}`);
   * ```
   */
  getPendingCount(agentId?: string): number {
    if (typeof agentId === 'string' && agentId.trim()) {
      const normalized = agentId.trim();
      return this.#pendingQueue.filter(t => this.#matchesTarget(t, normalized)).length;
    }
    return this.#pendingQueue.length;
  }

  /**
   * Returns an immutable shallow snapshot of pending triggers in arrival sequence.
   * The returned array and every returned `AgentTrigger` record are frozen copies; mutating them has no effect on internal queue state.
   * `payload` values are shared by reference with the internal records and are not deep-frozen.
   * `targetAgentId` and `source` are projected to the registration's bare `id` when the stored identifier is a registered canonical key (Wave I, ticket d57cbc1).
   * 
   * @param agentId - Optional agent ID filter, matched after trimming against the identifier received at registration or its projected bare-id label. Blank or non-string values are ignored and return all pending triggers.
   * @returns Readonly frozen array of frozen `AgentTrigger` copies.
   * 
   * @example
   * ```typescript
   * const triggers = queue.getPendingTriggers('agent-alice');
   * for (const trigger of triggers) {
   *   console.log(`Pending trigger: ${trigger.triggerId} [${trigger.type}] from ${trigger.source}`);
   * }
   * ```
   */
  getPendingTriggers(agentId?: string): readonly Readonly<AgentTrigger>[] {
    let list: AgentTrigger[];
    if (typeof agentId === 'string' && agentId.trim()) {
      const normalized = agentId.trim();
      list = this.#pendingQueue.filter(t => this.#matchesTarget(t, normalized));
    } else {
      list = this.#pendingQueue;
    }
    // Operator diagnostics surface (Wave I, ticket d57cbc1): registered
    // canonical keys are projected to their bare ids; the stored records keep
    // the identifier received at registration for dispatch.
    return Object.freeze(list.map(t => Object.freeze({
      ...t,
      targetAgentId: this.#identityLabel(t.targetAgentId),
      source: this.#identityLabel(t.source)
    })));
  }
}

/**
 * Generates a unique trigger ID string.
 * UUID-based when `crypto.randomUUID` is available; otherwise epoch plus random suffix.
 * @param prefix - Prefix for the generated trigger ID.
 * @returns A unique trigger ID string.
 */
function generateTriggerId(prefix = 'trig') {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}
