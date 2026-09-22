/**
 * @packageDocumentation
 * Type definitions and rich JSDoc API contracts for the WorldClock Layer 0 simulation engine.
 * Maintains partitioned, granular in-universe simulation narrative time and chronological event registries,
 * fully isolated per agent persona and synchronized bidirectionally with VirtualFS.
 *
 * @module worldClock
 * @invariant Narrative time (`totalSeconds`, `date`) changes only through explicit step operations (`advanceClock`, `setTime`, `resetClock`) or hydration (`importSnapshot`, `syncFromVirtualFs`); the optional ticker advances by an explicit `stepSeconds` per injected timer tick, and host wall-clock (`Date.now()`) feeds `lastSync`/`createdAtRealTime` metadata only — never the time state.
 * @invariant Partition isolation: unprivileged callers can read or mutate only their own partition (plus public global events); cross-partition or all-partition operations require a privileged principal and are denied with `PERMISSION_DENIED` before any state mutation. Realm confinement: realm-prefixed partitions (`realm:<realmId>:global`) are invisible to every non-bypass caller regardless of privilege — realm-bound callers see only their realm scope, ungrouped legacy callers see only non-realm partitions, and every single-target operation on an out-of-scope partition is denied (`PERMISSION_DENIED`) or silently narrowed (`getTime`/`queryEvents`, which have no failure branch) before any read or mutation.
 * @invariant Tenant administration is principal-gated (MOD-21, default-deny): the all-partition snapshot pair (`exportSnapshot`, `importSnapshot`) requires the exact reference injected as `WorldClockOptions.internalPrincipal` (`context.principal`) or an identity-port `AuthorityDescriptor` for `context.callerAgentId` granting cross-partition authority; anonymous callers, caller-asserted flags, and plain lookalike principal objects receive a `PERMISSION_DENIED` receipt before any disclosure, clear, or replacement; an injected instance that never received the option binds the composition root's exact reference once via `bindInternalPrincipal` (first bind wins, never rebound).
 * @invariant Resolved privilege rule (MOD-21, default-deny): a caller is privileged only when (a) the execution context carries the exact reference injected as `WorldClockOptions.internalPrincipal` at `context.principal`, or (b) the injected `WorldClockOptions.identityPort.getAgentIdentity(callerAgentId)` resolves a frozen `AuthorityDescriptor` whose `visibility` is `'all'`/`'system'` or whose `allow` set carries the `'*'` wildcard. Caller-asserted `isAdmin`/`isPrivileged`/`callerRole` values and reserved ids (`system`/`admin`/`director`) confer nothing; a descriptor present without a grant fails closed, and the legacy `identityPort` projection `privileged` boolean is honored only as a fallback when the projection carries no `authority` descriptor.
 * @invariant Uniform tool entry seam: every tool-facing method (`getTime`, `advanceClock`, `setTime`, `resetClock`, `registerEvent`, `queryEvents`, `resolveEvent`, `cancelEvent`, `updateEvent`, `clearEvents`) accepts a params object plus an execution context, letting tool dispatchers delegate without per-method adapters; the optional agent-visible adapters (`getCurrentTime`, `handleClockTool`, `handleEventTool`) mirror that descriptor dispatch and sanitize the receipt for the agent surface (opacity); non-tool infrastructure members keep narrower signatures (`getAllClocks(context)`, `start`/`startTicker`/`stop`/`stopTicker`, the `isRunning` getter, `syncToVirtualFs(targetAgentId, context?)`, `syncFromVirtualFs(targetWorkspace, context?)`), while the tenant-administration snapshot pair adds a trailing execution context (`exportSnapshot(context)`, `importSnapshot(snapshot, context)`); the optional sync context scopes full sync/hydration enumeration to a realm-bound caller and defaults to the engine-wide span, while an explicit sync target is admitted only inside the caller's realm scope (context-free targets keep the engine-wide span).
 * @invariant Realm scoping: a realm-bound caller (injected identity projection carrying a non-empty `realmId` with no `realmBypass`) operates the shared global partition through its realm key `realm:<realmId>:global` — implicit global targets, realm-global event ownership, sync writes, and scoped enumeration resolve to that key, and the VirtualFS sync target is the same key. Agent partitions stay keyed by agent id. Enumeration for a realm-bound caller is restricted to the realm (own partition plus realm-global, plus same-realm member partitions for privileged principals), while the injected internal principal and `realmBypass` identities span every partition. Cross-realm/other-partition operations keep requiring the existing privileged/internal authority; a realm binding never widens it. Realm confinement: an identified ungrouped caller (privileged or not) is confined to the legacy non-realm partitions — it never enumerates, queries, or targets a `realm:`-prefixed partition; `getTime`/`queryEvents` silently narrow a foreign-realm target to the caller's own scope, mutations and event-by-id operations deny with `PERMISSION_DENIED`, and only the injected internal principal, a `realmBypass` projection, or a context-free engine call spans every partition.
 * @invariant Canonical identity keys: partition and event-ownership keys are exactly the identifier the runtime supplies, used verbatim as opaque strings — bare realm-local ids before canonical keying and canonical `(realmId, agentId)` keys (`AgentIdentityProjection.key`) after — and worldClock never parses, splits, or composites them. The caller projection resolves from `context.callerKey` first (matching `key` through the injected `listAgentIdentities()`), then from the claimed `callerAgentId`/`agentId` (unique match across Realms; zero or multiple matches fail closed to anonymous/default-deny). Realm-scoped enumeration and same-realm single-target resolution run through the identity port's realm scope (`listAgentIdentities({ realmId })` / `getAgentIdentity(subject, { realmId })`) and never cross Realms except for `realmBypass` principals; single-target receipt identifier fields and out-of-scope error messages project a registered canonical key back to the projection's bare `id`, so no agent-facing value carries a canonical key or realm vocabulary. Container keys (`clocks` maps) and persistence payloads (snapshots, VirtualFS files) keep the internal partition key they address.
 * @invariant Internal state (`#agentClocks`, `#agentEvents`) is private; callers receive only frozen `TimeState` projections or fresh result objects, and every returned {@link WorldEvent} (including `queryEvents`, `triggeredEvents`, snapshot events, and the `event`/`nextEvent` receipts) is a defensive copy.
 * @invariant Leaf module: zero imports, and VirtualFS synchronization runs only through the injected duck-typed `virtualFs` instance (`WorldClockOptions.virtualFs`); sync is best-effort so in-memory operations never fail on VirtualFS errors.
 * @decision Caller identity and privilege are trusted only from the execution context; `params` claims are ignored and the legacy positional auth channels have been removed
 * @decision WorldClock privileged operations resolve authority from the frozen `AuthorityDescriptor` (through the injected identity port) or the opaque `InternalPrincipal` reference injected as `WorldClockOptions.internalPrincipal`; caller-asserted flags and reserved `system`/`admin`/`director` ids confer nothing
 * @decision The all-partition snapshot pair is tenant administration: `exportSnapshot`/`importSnapshot` resolve authority from the trusted principal sources only and default-deny anonymous callers with a `PERMISSION_DENIED` receipt before any disclosure, validation, clear, or replacement; an injected clock instance receives the composition-root reference once via `bindInternalPrincipal`
 * @decision Engine steps bypass the caller gate: the background ticker and VirtualFS synchronization run through `#advanceAllPartitions`/`#syncOptions` with the injected principal, so no reserved-id context or flag bundle is ever fabricated internally
 * @decision Host timer scheduling is injected through `WorldClockOptions.setInterval`/`clearInterval` (defaults `globalThis`) so the ticker lifecycle stays host-independent and testable
 * @decision Event-returning APIs hand out defensive copies (`structuredClone` with a shallow-metadata fallback); mutating a receipt can never corrupt the private event registry
 * @decision `resolveEvent` rejects already resolved or cancelled events with `INVALID_ARGUMENTS` before any mutation, and recurrence cleanup drops a stale `triggeredAtWorldTime` from the spawned `nextEvent`
 * @decision The dead `CLOCK_UNAVAILABLE` code was removed; `CORRUPTED_SNAPSHOT` is now emitted through `importSnapshot`/`syncFromVirtualFs` result receipts instead of being silently swallowed. Undeclared input aliases (`setTime`, `writeToFs`, `eventId`, `type`, numeric `start` interval) are declared rather than removed, keeping behavior unchanged
 * @decision `importSnapshot` pre-validates every clock and event entry (the legacy flat `events` array is validated even when `agentEvents` is present, but is imported only when `agentEvents` is absent) and rejects the whole snapshot atomically with `CORRUPTED_SNAPSHOT`; structural rejects (non-object snapshot or malformed section types) carry `error`/`code` only, while validated top-level scalar and per-entry problems are enumerated in `details`. A present blank-string `date` is accepted and normalized to `'Day 1'` by `importSnapshot`, whereas `syncFromVirtualFs` reports a present blank `date` as malformed; `syncFromVirtualFs` reports each malformed payload in `details` while still importing valid entries, so malformed entries are never dropped silently
 * @decision The unobservable `QueryEventsResult.error`/`code` fields and the unused `ExecutionContext.workspaceId` field were removed; `queryEvents` has no failure branch and worldClock never consumes workspace identity
 * @decision The realm-global partition key is `realm:<realmId>:global` (the ungrouped/legacy shared key stays `global`), resolved from the injected identity port and used verbatim as the VirtualFS sync workspace, so a realm-bound caller's sync writes land in its realm workspace only; scoped enumeration covers the caller's realm while the injected internal principal / `realmBypass` identities span all partitions
 * @decision Agent-visible tool receipts are realm-opaque: the optional adapters (`getCurrentTime`, `handleClockTool`, `handleEventTool`) mirror the `world_clock`/`event_list`/`get_current_time` descriptor dispatch and rewrite the internal `realm:<realmId>:global` partition key to `global` in partition/owner fields (`agentId`/`targetAgentId`/`ownerId`/`createdBy`) and in `clocks` map keys, leaving agent-authored content and the direct host/API surface unchanged
 * @decision Realm confinement is total for non-bypass callers: the scoped-partition resolver never returns the unscoped span for an identified caller — realm-bound callers resolve to their realm scope and ungrouped callers exclude every `realm:`-prefixed partition (ungrouped unprivileged callers keep their byte-identical own-partition-plus-`global` legacy span) — and the same resolver gates single-target operations (`setTime`/`getTime`/`advanceClock`/`resetClock`/`registerEvent`/`queryEvents`/`clearEvents`/event-by-id resolution/`syncFromVirtualFs`/`syncToVirtualFs`), where `getTime` and `queryEvents` silently narrow because their receipts have no failure branch; the unscoped span remains only for the injected internal principal, `realmBypass` projections, and context-free engine calls (constructor/store/persistence hydration)
 * @decision Realm-local identity keying: the caller projection resolves `context.callerKey` (canonical `AgentIdentityProjection.key`) ahead of the claimed bare id, realm-scoped enumeration and same-realm targets resolve through the identity port's realm scope (`listAgentIdentities({ realmId })`, `getAgentIdentity(subject, { realmId })`), partition/event-ownership keys stay exactly the runtime-supplied identifier (opaque: never parsed or recomposed), same-realm bare refs prefer an existing partition of the resolution, and single-target receipts plus out-of-scope errors project registered canonical keys back to the bare `id` while container keys and persistence payloads keep the internal partition key
 * @decision VirtualFS hydration adopts a finite persisted `updatedAt` as `lastSync` and normalizes an absent or non-finite `updatedAt` to `Date.now()`, keeping the sync stamp finite rather than propagating a malformed value
 */

// ============================================================================
// 1. Core Primitives & Error Codes
// ============================================================================

/**
 * Standardized, frozen machine-readable error codes for predictable error handling
 * across tool dispatchers, runtime engines, and test assertions.
 *
 * @example
 * ```typescript
 * import { WORLD_CLOCK_ERROR_CODES } from './worldClock/index.ts';
 *
 * const result = clock.advanceClock({ targetAgentId: 'agent_bob' }, { callerAgentId: 'agent_alice' });
 * if (!result.success && result.code === WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED) {
 *   console.error('Agent alice lacks permission to advance agent bob clock:', result.error);
 * }
 * ```
 */
export const WORLD_CLOCK_ERROR_CODES: {
  /** Parameters failed schema validation, missing required field (e.g. event name), or malformed type. */
  readonly INVALID_ARGUMENTS: 'INVALID_ARGUMENTS';
  /** Unprivileged principal attempted cross-partition mutation, global event registration, reset without a privileged authority descriptor, or tenant-administration snapshot disclosure/replacement (`exportSnapshot`/`importSnapshot`). */
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED';
  /** Target event identifier does not exist in any partition registry; lookups scan all partitions. */
  readonly EVENT_NOT_FOUND: 'EVENT_NOT_FOUND';
  /** Deserialization failed due to malformed JSON, a corrupted snapshot schema, a malformed top-level scalar/per-entry value, or an unreadable VirtualFS payload; reported through `importSnapshot`/`syncFromVirtualFs` receipts, where `details` names the offending fields for validated scalar/per-entry problems and the unreadable file paths for read/exists failures (structural `importSnapshot` rejects carry `error`/`code` only). */
  readonly CORRUPTED_SNAPSHOT: 'CORRUPTED_SNAPSHOT';
} = Object.freeze({
  INVALID_ARGUMENTS: 'INVALID_ARGUMENTS',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  EVENT_NOT_FOUND: 'EVENT_NOT_FOUND',
  CORRUPTED_SNAPSHOT: 'CORRUPTED_SNAPSHOT'
});

/**
 * Union type representing all standardized error code strings emitted by the WorldClock engine.
 *
 * @example
 * ```typescript
 * function handleClockError(code: WorldClockErrorCode, message?: string) {
 *   switch (code) {
 *     case 'PERMISSION_DENIED':
 *       throw new Error(`Unauthorized clock operation: ${message}`);
 *     case 'EVENT_NOT_FOUND':
 *       console.warn(`Event missing: ${message}`);
 *       break;
 *     default:
 *       console.error(`Clock error [${code}]: ${message}`);
 *   }
 * }
 * ```
 */
export type WorldClockErrorCode = typeof WORLD_CLOCK_ERROR_CODES[keyof typeof WORLD_CLOCK_ERROR_CODES];

/**
 * Priority levels for world simulation events.
 *
 * @example
 * ```typescript
 * const priority: EventPriority = 'critical';
 * ```
 */
export type EventPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Lifecycle status of a narrative simulation event.
 *
 * - `pending`: Scheduled for a future timestamp and waiting to trigger.
 * - `active`: Trigger timestamp reached or passed; currently active in the simulation.
 * - `resolved`: Successfully resolved or completed by an agent or narrative beat.
 * - `cancelled`: Aborted prior to or during execution without resolution.
 *
 * @example
 * ```typescript
 * const status: EventStatus = 'active';
 * ```
 */
export type EventStatus = 'pending' | 'active' | 'resolved' | 'cancelled';

/**
 * Visibility and access scope for world events.
 *
 * - `agent`: Event is isolated to a specific agent's partition and only visible to that agent (and privileged principals).
 * - `global`: Public event visible to all agents across the simulation.
 *
 * @example
 * ```typescript
 * const scope: EventScope = 'global';
 * ```
 */
export type EventScope = 'agent' | 'global';

// ============================================================================
// 2. Caller Execution & Security Context
// ============================================================================

/**
 * Execution and security context passed from tool dispatchers, runtime engines, or director agents.
 * Identifies the invoking agent and optionally carries the engine-internal principal reference.
 *
 * Authority is resolved (default-deny) from the injected principal sources only:
 * the identity port for the claimed `callerAgentId`/`agentId`, or the exact
 * `context.principal` reference injected as `WorldClockOptions.internalPrincipal`.
 *
 * @example
 * ```typescript
 * const context: ExecutionContext = {
 *   callerAgentId: 'agent_scout'
 * };
 * ```
 */
export interface ExecutionContext {
  /** Identifier of the agent invoking the operation. Used for partition isolation and permission verification. */
  readonly callerAgentId?: string;
  /** Legacy alias for `callerAgentId`. */
  readonly agentId?: string;
  /**
   * Canonical internal identity key of the invoking agent (Wave I, ticket
   * d57cbc1): the `(realmId, agentId)` composite owned by the runtime
   * (`AgentIdentityProjection.key`), supplied by the internal runtime/tool
   * seam that already resolved the caller's registration. It is trusted
   * construction input, resolved here through the injected identity port's
   * `listAgentIdentities()`; a key that matches no registration falls back to
   * the claimed bare `callerAgentId`.
   *
   * Internal only: the key is never surfaced in receipts, listings, errors, or
   * payloads — those project the projection's bare `id`.
   */
  readonly callerKey?: string;
  /**
   * Engine-internal principal reference (MOD-21). Honored only when it is the
   * exact object injected as `WorldClockOptions.internalPrincipal`; plain
   * objects, flag bundles, and reserved-id strings never satisfy it.
   */
  readonly principal?: object;
  /**
   * Whether caller holds administrative access.
   * @deprecated Caller-asserted privilege no longer confers any authority (MOD-21 W4); kept only so legacy call sites remain type-valid. Use the injected principal sources instead.
   */
  readonly isAdmin?: boolean;
  /**
   * Whether caller holds privileged execution rights.
   * @deprecated Caller-asserted privilege no longer confers any authority (MOD-21 W4); reserved ids (`system`/`admin`/`director`) grant nothing either.
   */
  readonly isPrivileged?: boolean;
  /** Arbitrary execution metadata or contextual dependencies (worldClock itself reads only `callerAgentId`/`agentId`/`callerKey` and the `principal` reference). */
  readonly [key: string]: unknown;
}

// ============================================================================
// 3. Domain Entities & State Shapes
// ============================================================================

/**
 * Complete, immutable representation of a partition's chronological time and event metrics.
 *
 * @example
 * ```typescript
 * const state: TimeState = {
 *   agentId: 'agent_scout',
 *   totalSeconds: 36900,
 *   totalMinutes: 615,
 *   day: 1,
 *   hour: 10,
 *   minute: 15,
 *   second: 0,
 *   formatted: '10:15:00',
 *   shortFormatted: '10:15',
 *   time_string: '10:15:00',
 *   date: 'Day 1',
 *   lastSync: 1726500000000,
 *   activeEventsCount: 2,
 *   pendingEventsCount: 5,
 *   resolvedEventsCount: 1
 * };
 * ```
 */
export interface TimeState {
  /** Target partition identifier ('global' or specific agent ID). */
  readonly agentId: string;
  /** Total elapsed simulation seconds from epoch (non-negative integer). */
  readonly totalSeconds: number;
  /** Total elapsed simulation minutes (`Math.floor(totalSeconds / 60)`). */
  readonly totalMinutes: number;
  /** 1-indexed simulation day number (`Math.floor(totalSeconds / 86400) + 1`). */
  readonly day: number;
  /** Current hour within the day (0-23). */
  readonly hour: number;
  /** Current minute within the hour (0-59). */
  readonly minute: number;
  /** Current second within the minute (0-59). */
  readonly second: number;
  /** Canonical 24-hour formatted time string: `"HH:MM:SS"` (e.g., `"14:30:00"`). */
  readonly formatted: string;
  /** Short 24-hour formatted time string without seconds: `"HH:MM"` (e.g., `"14:30"`). */
  readonly shortFormatted: string;
  /** Exact canonical match for `get_current_time` tool descriptor: `"HH:MM:SS"`. */
  readonly time_string: string;
  /** Descriptive narrative era / date string (e.g., `"Day 1"`, `"Year 2 Autumn"`). */
  readonly date: string;
  /** Epoch millisecond timestamp of the last clock-state change (init, hydration, advance, set, or reset); event-only mutations do not refresh it. */
  readonly lastSync: number;
  /** Number of active events visible in this partition, including merged global events for agent partitions. */
  readonly activeEventsCount: number;
  /** Number of pending events visible in this partition, including merged global events for agent partitions. */
  readonly pendingEventsCount: number;
  /** Number of resolved events visible in this partition, including merged global events for agent partitions. */
  readonly resolvedEventsCount: number;
}

/**
 * Backward-compatible type alias for {@link TimeState}.
 */
export type WorldClockTime = TimeState;

/**
 * In-universe chronological narrative simulation event entity.
 *
 * @example
 * ```typescript
 * const event: WorldEvent = {
 *   id: 'evt_solar_eclipse',
 *   name: 'Solar Eclipse',
 *   description: 'Twin suns align over the citadel.',
 *   triggerTime: 36900,
 *   triggerFormatted: '10:15:00',
 *   category: 'celestial',
 *   priority: 'high',
 *   status: 'active',
 *   scope: 'global',
 *   public: true,
 *   ownerId: 'global',
 *   createdBy: 'director',
 *   createdAtWorldTime: 0,
 *   createdAtRealTime: 1726490000000,
 *   metadata: { intensity: 0.8 },
 *   repeatMinutes: null,
 *   repeatSeconds: null,
 *   resolvedAt: null,
 *   resolvedAtFormatted: null,
 *   resolvedBy: null,
 *   resolutionNote: null,
 *   cancelledAt: null,
 *   cancelledBy: null,
 *   cancellationReason: null,
 *   triggeredAtWorldTime: 36900
 * };
 * ```
 */
export interface WorldEvent {
  /** Unique event identifier (e.g. `"evt_m1a2b3_xyz"`). */
  readonly id: string;
  /** Human-readable event title or name. */
  name: string;
  /** Detailed description of the narrative beat or task (defaults to `name` when omitted). */
  description: string;
  /** Absolute trigger world time in simulation seconds. */
  triggerTime: number;
  /** Canonical formatted trigger time string (`"HH:MM:SS"`). */
  triggerFormatted: string;
  /** Narrative category classification (e.g. `"narrative"`, `"combat"`, `"celestial"`). */
  category: string;
  /** Event priority level (`'low' | 'normal' | 'high' | 'critical'`). */
  priority: EventPriority;
  /** Current lifecycle status (`'pending' | 'active' | 'resolved' | 'cancelled'`). */
  status: EventStatus;
  /** Visibility scope (`'agent' | 'global'`). */
  scope: EventScope;
  /** Whether the event is publicly visible to all agents. */
  public: boolean;
  /** Owning agent partition ID or `'global'`. */
  ownerId: string;
  /** Agent ID or system identifier that registered the event. */
  createdBy: string;
  /** Total simulation seconds at the time the event was registered. */
  createdAtWorldTime: number;
  /** Wall-clock epoch millisecond timestamp when registered. */
  createdAtRealTime: number;
  /** Arbitrary domain-specific metadata. */
  metadata: Record<string, unknown>;
  /** Optional recurrence interval in simulation minutes (triggers repeat on resolution). */
  repeatMinutes: number | null;
  /** Optional recurrence interval in simulation seconds. */
  repeatSeconds: number | null;
  /** Simulation seconds when the event was marked resolved (null if unresolved). */
  resolvedAt: number | null;
  /** Formatted world time string when resolved (`"HH:MM:SS"` or null). */
  resolvedAtFormatted: string | null;
  /** Agent ID that resolved the event (null if unresolved). */
  resolvedBy: string | null;
  /** Resolution explanation note or completion summary. */
  resolutionNote: string | null;
  /** Simulation seconds when cancelled (null if not cancelled). */
  cancelledAt: number | null;
  /** Agent ID that cancelled the event. */
  cancelledBy: string | null;
  /** Justification for cancellation. */
  cancellationReason: string | null;
  /** World seconds when the event transitioned from pending to active. */
  triggeredAtWorldTime?: number;
}

/**
 * Backward-compatible type alias for {@link WorldEvent}.
 */
export type NarrativeEvent = WorldEvent;

// ============================================================================
// 4. Persistence Snapshot Contract
// ============================================================================

/**
 * Serialized persistence snapshot for an individual agent timeline partition.
 *
 * @example
 * ```typescript
 * const partitionSnapshot: PartitionClockSnapshot = {
 *   totalSeconds: 3600,
 *   date: 'Day 1 Morning',
 *   lastSync: 1726500000000
 * };
 * ```
 */
export interface PartitionClockSnapshot {
  /** Elapsed simulation seconds in partition. */
  totalSeconds: number;
  /** Narrative era / date string. */
  date: string;
  /** Epoch timestamp of last synchronization. */
  lastSync: number;
}

/**
 * Complete serializable JSON-safe snapshot capturing global simulation state,
 * all partition clocks, and all registered events.
 *
 * @example
 * ```typescript
 * const snapshot: WorldClockSnapshot = {
 *   totalSeconds: 3600,
 *   date: 'Day 1',
 *   events: [],
 *   agentClocks: {
 *     global: { totalSeconds: 3600, date: 'Day 1', lastSync: Date.now() },
 *     agent_scout: { totalSeconds: 3600, date: 'Day 1', lastSync: Date.now() }
 *   },
 *   agentEvents: {
 *     agent_scout: []
 *   }
 * };
 * ```
 */
export interface WorldClockSnapshot {
  /** Simulation seconds for the primary / global timeline; must be finite (rejected as `CORRUPTED_SNAPSHOT` otherwise, absent falls back to `0`). */
  totalSeconds: number;
  /** Primary narrative date string; non-string values are rejected, absent falls back to `'Day 1'`, and a present blank string is accepted by `importSnapshot` (normalized to `'Day 1'`) while `syncFromVirtualFs` reports it as malformed. */
  date: string;
  /** Flat array of all registered world events (legacy and merged view). */
  events: WorldEvent[];
  /** Map of partition IDs to partition clock snapshots. */
  agentClocks?: Record<string, PartitionClockSnapshot>;
  /** Map of partition IDs to arrays of partitioned world events. */
  agentEvents?: Record<string, WorldEvent[]>;
}

/**
 * Receipt returned by {@link WorldClock.importSnapshot} after attempting to hydrate state.
 *
 * @example
 * ```typescript
 * const receipt = clock.importSnapshot(restoredSnapshot);
 * if (!receipt.success && receipt.code === 'CORRUPTED_SNAPSHOT') {
 *   console.error(receipt.error);
 * }
 * ```
 */
export interface ImportSnapshotResult {
  /** Whether hydration succeeded. */
  success: boolean;
  /** Human-readable error message when the snapshot was rejected as corrupted or the caller resolved no tenant-administration principal. */
  error?: string;
  /** Machine-readable error code; `CORRUPTED_SNAPSHOT` when hydration was rejected, or `PERMISSION_DENIED` when the caller resolved no tenant-administration principal before validation. */
  code?: WorldClockErrorCode;
  /** Validated top-level scalar (`totalSeconds`, `date`) and per-entry problems when hydration was rejected; each entry names the offending field or snapshot path and the malformed value. Absent for structural rejects (non-object snapshot or malformed section types), which carry `error`/`code` only. */
  details?: string[];
}

/**
 * Receipt returned by {@link WorldClock.syncFromVirtualFs} after attempting to hydrate state from VirtualFS.
 *
 * @example
 * ```typescript
 * const receipt = clock.syncFromVirtualFs('agent_scout');
 * if (!receipt.success && receipt.code === 'CORRUPTED_SNAPSHOT') {
 *   console.error(receipt.error);
 * }
 * ```
 */
export interface SyncFromVirtualFsResult {
  /** Whether hydration succeeded (valid state or no persisted state at all). */
  success: boolean;
  /** Human-readable error message when persisted payloads were malformed. */
  error?: string;
  /** Machine-readable error code; `CORRUPTED_SNAPSHOT` when persisted payloads were malformed. */
  code?: WorldClockErrorCode;
  /** Unreadable file locations (VirtualFS path and workspace id) and malformed payload locations (entry index or clock field) encountered during best-effort hydration; valid payloads, entries, and clock fields are still imported. */
  details?: string[];
}

// ============================================================================
// 5. Method Parameter & Result Interfaces
// ============================================================================

/**
 * Trusted identity projection consumed by the WorldClock authority resolver.
 *
 * Structural mirror of the MOD-13 `AgentIdentityPort` projection; the canonical
 * definition lives in the runtime module. The projection is trusted
 * construction output — callers never supply it.
 */
export interface WorldClockIdentityProjection {
  /** Registered agent identifier (realm-local and opaque: the same literal id may exist in several Realms). */
  readonly id?: string;
  /**
   * Canonical internal identity key of this registration (Wave I, ticket
   * d57cbc1): the `(realmId, agentId)` composite owned by the runtime identity
   * layer. Supplied by the runtime producer; optional and additive for
   * injected third-party ports (absent keys simply never match a canonical
   * `callerKey`). Internal only — never a receipt, listing, error, or payload;
   * those project the bare `id`.
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
    /** Read/operation scope; `'all'` and `'system'` grant cross-partition authority. */
    readonly visibility: 'self' | 'owned' | 'all' | 'system';
  };
  /**
   * Realm membership resolved by the runtime identity projection.
   *
   * Promoted to required once the runtime producer landed (Realm wave A,
   * ticket f5d1ccc): every `AgentIdentityPort.getAgentIdentity()` projection
   * carries `realmId` (`null` = ungrouped, which resolves to the legacy
   * `global` partition). An injected third-party identity port must supply the
   * field as well (`null` for ungrouped subjects).
   */
  readonly realmId: string | null;
  /**
   * Whether the subject bypasses Realm scoping because it holds the
   * `realmBypass` grant (the engine bootstrap's hardcoded composition or an
   * operator grant recorded in the registry authority inputs) — never a
   * property of an agent id.
   *
   * Promoted to required alongside `realmId` (Realm wave A, ticket f5d1ccc).
   * The runtime projection sets it from the frozen `realmBypass` grant state;
   * the operator/engine principal bypass is supplied by the caller context's
   * exact injected-principal reference. An injected identity port must supply
   * the field (`false` for every non-bypassing subject).
   */
  readonly realmBypass: boolean;
}

/**
 * Trusted resolution scope accepted by the WorldClock identity port (Wave I,
 * ticket d57cbc1). Structural mirror of the runtime `AgentIdentityScope`:
 * `{ realmId: <string> }` resolves exactly that Realm, `{ realmId: null }` the
 * bootstrap-only system scope, `{ realmBypass: true }` the unique match across
 * every Realm, and an omitted scope keeps the legacy unique-match rule.
 */
export interface WorldClockIdentityScope {
  /** Realm membership to resolve exactly; `null` selects the system scope. */
  readonly realmId?: string | null;
  /** Resolve the unique match across every Realm. */
  readonly realmBypass?: boolean;
}

/**
 * Trusted identity resolver injected into the WorldClock (default-deny when absent).
 * Structural mirror of the MOD-13 `AgentIdentityPort`.
 */
export interface WorldClockIdentityPort {
  /**
   * Resolves the identity projection of a registered agent, or `null` when no
   * trusted principal matches the subject.
   *
   * @param agentId - Claimed realm-local caller identity to resolve.
   * @param scope - Optional trusted resolution scope (Wave I, ticket d57cbc1):
   *   realm-bound scopes resolve exactly the composite
   *   `(scope.realmId, agentId)`, a bypass scope resolves the unique match
   *   across Realms, and an omitted scope keeps the legacy unique-match
   *   behavior (an id registered in more than one Realm resolves `null` — fail
   *   closed).
   * @returns Frozen identity projection or `null` (anonymous).
   */
  getAgentIdentity(agentId: string, scope?: WorldClockIdentityScope): WorldClockIdentityProjection | null;
  /**
   * Enumerates the active registrations a scope can resolve (Wave I, ticket
   * d57cbc1). Optional and additive: an injected port without it keeps the
   * legacy per-partition bare lookup.
   *
   * @param scope - Optional trusted resolution scope: realm-bound scopes
   *   enumerate exactly that Realm's registrations, an omitted or bypass scope
   *   enumerates every active registration.
   * @returns Frozen identity projections in registry insertion order.
   */
  listAgentIdentities?(scope?: WorldClockIdentityScope): WorldClockIdentityProjection[];
}

/**
 * Minimal structural view of the duck-typed VirtualFS adapter consumed through
 * `WorldClockOptions.virtualFs`.
 *
 * `writeFile`/`readFile` are the synchronization capabilities the engine calls
 * directly once synchronization is enabled; `exists`/`listWorkspaces` are
 * capability probes guarded by `typeof` checks, so partial doubles are accepted.
 */
interface WorldClockVirtualFsAdapter {
  /**
   * Writes a serialized payload to a workspace-relative path.
   *
   * @param path - Workspace-relative file path.
   * @param content - Serialized UTF-8 payload.
   * @param options - Per-call workspace/principal options.
   * @returns Host-defined write receipt.
   */
  writeFile(path: string, content: string, options?: object): unknown;
  /**
   * Reads a workspace-relative path, optionally in raw payload mode.
   *
   * @param path - Workspace-relative file path.
   * @param options - Per-call workspace/principal options.
   * @returns Host-defined payload (string, object, or `{ content }` wrapper).
   */
  readFile(path: string, options?: object): unknown;
  /**
   * Optional existence probe used before reading a payload.
   *
   * @param path - Workspace-relative file path.
   * @param options - Per-call workspace/principal options.
   * @returns Whether the path exists.
   */
  exists?(path: string, options?: object): boolean;
  /**
   * Optional workspace enumeration used for full hydration.
   *
   * @returns Known workspace identifiers.
   */
  listWorkspaces?(): readonly string[];
}

/**
 * Initialization options for creating a {@link WorldClock} instance.
 *
 * @example
 * ```typescript
 * const options: WorldClockOptions = {
 *   virtualFs: vfsInstance,
 *   initialSeconds: 28800, // 08:00:00
 *   date: 'Day 1',
 *   autoSyncFs: true
 * };
 * ```
 */
export interface WorldClockOptions {
  /** Optional VirtualFS adapter for bidirectional disk/memory synchronization. */
  virtualFs?: WorldClockVirtualFsAdapter | null;
  /** Starting world time in simulation seconds (default: 0). */
  initialSeconds?: number;
  /** Starting descriptive narrative date string (default: 'Day 1'). */
  date?: string;
  /** Whether state writes to VirtualFS are enabled (default: true); when false, mutation syncs and explicit `syncToVirtualFs` calls are no-ops. */
  autoSyncFs?: boolean;
  /**
   * Optional host timer scheduler injected for the background ticker.
   * Defaults to the current global `setInterval` when omitted.
   */
  setInterval?: (handler: () => void, timeoutMs: number) => TickerInterval;
  /**
   * Optional host timer canceller injected for the background ticker.
   * Defaults to the current global `clearInterval` when omitted.
   */
  clearInterval?: (handle: TickerInterval) => void;
  /**
   * Trusted identity resolver used to resolve agent authority descriptors
   * (MOD-21 W4). Injected by the composition root; when absent every agent is
   * default-deny and only `global` operations and the caller's own partition
   * are permitted through the public seam.
   */
  identityPort?: WorldClockIdentityPort | null;
  /**
   * Opaque engine-internal principal reference (MOD-21). Only this exact
   * object — never a plain lookalike — authorizes internal VirtualFS
   * synchronization; the composition root must inject the same reference into
   * the VirtualFS that WorldClock writes through.
   */
  internalPrincipal?: object | null;
}

/**
 * Discriminated failure branch shared by WorldClock mutation results.
 *
 * Returned when an operation is rejected (e.g. permission denied) before any
 * state mutation is performed. Success-only fields are intentionally absent.
 *
 * @example
 * ```typescript
 * const result = clock.setTime({ time: '12:00:00', targetAgentId: 'agent_bob' }, { callerAgentId: 'agent_alice' });
 * if (!result.success) {
 *   console.error(result.code, result.error);
 * }
 * ```
 */
export interface WorldClockOperationFailure {
  /** Operation failed. */
  success: false;
  /** Human-readable error message describing the failure. */
  error: string;
  /** Machine-readable error code describing the failure. */
  code: WorldClockErrorCode;
}

// getTime
/**
 * Parameter payload for querying world clock time.
 *
 * @example
 * ```typescript
 * const params: GetTimeParams = {
 *   targetAgentId: 'agent_scout'
 * };
 * ```
 */
export interface GetTimeParams {
  /** Privileged/Admin only: target agent partition identifier. */
  agentId?: string;
  /** Privileged/Admin only: target agent partition identifier (preferred alias). */
  targetAgentId?: string;
  /** If true and caller is privileged, returns time states for all partitions. */
  all?: boolean;
}

/**
 * Result structure returned when querying all partitions with `all: true`.
 *
 * @example
 * ```typescript
 * const allClocks: GetAllClocksResult = {
 *   success: true,
 *   all: true,
 *   clocks: {
 *     global: timeStateGlobal,
 *     agent_scout: timeStateScout
 *   }
 * };
 * ```
 */
export interface GetAllClocksResult {
  /** Operation success status. */
  success: true;
  /** Indicator that all partitions are included. */
  all: true;
  /** Map of partition IDs to their corresponding {@link TimeState}. */
  clocks: Record<string, TimeState>;
}

// advanceClock
/**
 * Parameter payload for advancing simulation time and triggering scheduled events.
 *
 * @example
 * ```typescript
 * const advanceParams: AdvanceClockParams = {
 *   minutes: 45,
 *   date: 'Day 1 Afternoon'
 * };
 * ```
 */
export interface AdvanceClockParams {
  /** Direct seconds offset to add. */
  seconds?: number;
  /** Alias for `seconds`. */
  offsetSeconds?: number;
  /** Minutes offset to add. */
  minutes?: number;
  /** Alias for `minutes`. */
  offsetMinutes?: number;
  /** Hours offset to add. */
  hours?: number;
  /** Alias for `hours`. */
  offsetHours?: number;
  /** Natural duration shorthand (e.g., `"1h 30m"`, `"45m"`, `"90s"`) or numeric seconds. */
  time?: string | number;
  /** Optional new narrative date/era string. */
  date?: string;
  /** Privileged/Admin only: Specific partition to advance. */
  targetAgentId?: string;
  /** Privileged/Admin only: Advance all active agent partitions and global simultaneously. */
  all?: boolean;
}

/**
 * Result structure returned after advancing world clock time.
 *
 * @example
 * ```typescript
 * const advanceResult: AdvanceClockResult = {
 *   success: true,
 *   agentId: 'agent_scout',
 *   previousSeconds: 28800,
 *   previousFormatted: '08:00:00',
 *   currentSeconds: 31500,
 *   currentFormatted: '08:45:00',
 *   shortFormatted: '08:45',
 *   advancedBySeconds: 2700,
 *   advancedByMinutes: 45,
 *   day: 1,
 *   hour: 8,
 *   minute: 45,
 *   second: 0,
 *   date: 'Day 1',
 *   triggeredEvents: [],
 *   triggeredCount: 0,
 *   activeEventsCount: 0,
 *   pendingEventsCount: 2
 * };
 * ```
 */
export interface AdvanceClockSuccess {
  /** Whether the advance operation succeeded. */
  success: true;
  /** Partition ID that was advanced (or undefined if multiple). */
  agentId?: string;
  /** Simulation seconds before advancement. */
  previousSeconds?: number;
  /** Formatted world time string before advancement (`"HH:MM:SS"`). */
  previousFormatted?: string;
  /** Current simulation seconds after advancement. */
  currentSeconds: number;
  /** Current formatted world time string (`"HH:MM:SS"`). */
  currentFormatted: string;
  /** Short formatted world time string (`"HH:MM"`). */
  shortFormatted: string;
  /** Total seconds advanced in this step. */
  advancedBySeconds: number;
  /** Total minutes advanced in this step (`advancedBySeconds / 60`, rounded to two decimals). */
  advancedByMinutes: number;
  /** 1-indexed simulation day number. */
  day: number;
  /** Current hour within the day (0-23). */
  hour: number;
  /** Current minute within the hour (0-59). */
  minute: number;
  /** Current second within the minute (0-59). */
  second: number;
  /** Narrative date string. */
  date: string;
  /** Array of defensive-copy {@link WorldEvent} entities triggered by this time progression. */
  triggeredEvents: WorldEvent[];
  /** Number of events triggered by this time advancement. */
  triggeredCount: number;
  /** Number of active events visible in the partition (own plus merged global events); absent when `all: true`. */
  activeEventsCount?: number;
  /** Number of pending events visible in the partition (own plus merged global events); absent when `all: true`. */
  pendingEventsCount?: number;
  /** Present when `all: true` was requested. */
  all?: boolean;
  /** Map of all partition states when `all: true` was requested. */
  clocks?: Record<string, TimeState>;
}

/**
 * Result of {@link WorldClock.advanceClock}: successful advancement or a
 * discriminated {@link WorldClockOperationFailure} branch.
 */
export type AdvanceClockResult = AdvanceClockSuccess | WorldClockOperationFailure;

// setTime
/**
 * Parameter payload for setting absolute world time and narrative date.
 *
 * @example
 * ```typescript
 * const setParams: SetTimeParams = {
 *   time: '14:30:00',
 *   date: 'Day 2'
 * };
 * ```
 */
export interface SetTimeParams {
  /** Absolute time string (`"HH:MM"`, `"HH:MM:SS"`, `"D:HH:MM:SS"`) or total seconds; ignored when `setTime` is provided. */
  time?: string | number;
  /** Alias for `time`, taking precedence when both are provided. */
  setTime?: string | number;
  /** Direct total seconds setter; ignored when `setTime` or `time` is provided. */
  totalSeconds?: number;
  /** Hour component (0-23) to update current day time. */
  hour?: number;
  /** Minute component (0-59) to update current day time. */
  minute?: number;
  /** Second component (0-59) to update current day time. */
  second?: number;
  /** Narrative date string to set. */
  date?: string;
  /** Privileged/Admin only: Target partition to set. */
  targetAgentId?: string;
}

/**
 * Result structure returned after setting absolute world time.
 *
 * @example
 * ```typescript
 * const setResult: SetTimeResult = {
 *   success: true,
 *   agentId: 'agent_scout',
 *   previousSeconds: 28800,
 *   currentSeconds: 52200,
 *   currentFormatted: '14:30:00',
 *   shortFormatted: '14:30',
 *   day: 1,
 *   hour: 14,
 *   minute: 30,
 *   second: 0,
 *   date: 'Day 2',
 *   activeEventsCount: 1,
 *   pendingEventsCount: 3
 * };
 * ```
 */
export interface SetTimeSuccess {
  /** Whether the set operation succeeded. */
  success: true;
  /** Partition ID that was updated. */
  agentId: string;
  /** Simulation seconds before modification. */
  previousSeconds: number;
  /** Current simulation seconds after modification. */
  currentSeconds: number;
  /** Current formatted world time string (`"HH:MM:SS"`). */
  currentFormatted: string;
  /** Short formatted world time string (`"HH:MM"`). */
  shortFormatted: string;
  /** 1-indexed simulation day number. */
  day: number;
  /** Current hour (0-23). */
  hour: number;
  /** Current minute (0-59). */
  minute: number;
  /** Current second (0-59). */
  second: number;
  /** Narrative date string. */
  date: string;
  /** Number of active events visible in the partition (own plus merged global events). */
  activeEventsCount: number;
  /** Number of pending events visible in the partition (own plus merged global events). */
  pendingEventsCount: number;
}

/**
 * Result of {@link WorldClock.setTime}: successful absolute-time projection or
 * a discriminated {@link WorldClockOperationFailure} branch.
 */
export type SetTimeResult = SetTimeSuccess | WorldClockOperationFailure;

// resetClock
/**
 * Parameter payload for resetting world clock to epoch (`Day 1, 00:00:00`).
 *
 * @example
 * ```typescript
 * const resetParams: ResetClockParams = {
 *   targetAgentId: 'agent_scout',
 *   syncFs: true
 * };
 * ```
 */
export interface ResetClockParams {
  /** Target partition to reset ('global', agent ID, or 'all'). */
  targetAgentId?: string;
  /** Privileged/Admin only: Reset all partitions simultaneously. */
  all?: boolean;
  /** Whether to sync reset state to VirtualFS (default: true). */
  syncFs?: boolean;
  /** Alias for `syncFs`; either flag set to `false` suppresses synchronization. */
  writeToFs?: boolean;
}

/**
 * Result structure returned after resetting world clock.
 *
 * @example
 * ```typescript
 * const resetResult: ResetClockResult = {
 *   success: true,
 *   agentId: 'agent_scout',
 *   previousSeconds: 52200,
 *   totalSeconds: 0,
 *   currentSeconds: 0,
 *   formatted: '00:00:00',
 *   shortFormatted: '00:00',
 *   currentFormatted: '00:00:00',
 *   day: 1,
 *   hour: 0,
 *   minute: 0,
 *   second: 0,
 *   date: 'Day 1',
 *   activeEventsCount: 0,
 *   pendingEventsCount: 4
 * };
 * ```
 */
export interface ResetClockSuccess {
  /** Whether reset succeeded. */
  success: true;
  /** Partition ID reset. */
  agentId?: string;
  /** Total simulation seconds before reset. */
  previousSeconds?: number;
  /** Constant 0 total seconds after reset. */
  totalSeconds: 0;
  /** Constant 0 current seconds after reset. */
  currentSeconds: 0;
  /** Formatted world time string (`"00:00:00"`). */
  formatted: '00:00:00';
  /** Short formatted world time string (`"00:00"`). */
  shortFormatted: '00:00';
  /** Current formatted world time string (`"00:00:00"`). */
  currentFormatted: '00:00:00';
  /** Reset day number (1). */
  day: 1;
  /** Reset hour (0). */
  hour: 0;
  /** Reset minute (0). */
  minute: 0;
  /** Reset second (0). */
  second: 0;
  /** Reset date string ('Day 1'). */
  date: 'Day 1';
  /** Number of active events after status recalculation (own plus merged global events); absent when `all: true`. */
  activeEventsCount?: number;
  /** Number of pending events after status recalculation (own plus merged global events); absent when `all: true`. */
  pendingEventsCount?: number;
  /** Present when `all: true` was requested. */
  all?: boolean;
  /** Map of all partition states when `all: true` was requested. */
  clocks?: Record<string, TimeState>;
}

/**
 * Result of {@link WorldClock.resetClock}: successful epoch reset or a
 * discriminated {@link WorldClockOperationFailure} branch.
 */
export type ResetClockResult = ResetClockSuccess | WorldClockOperationFailure;

// registerEvent
/**
 * Parameter payload for registering a narrative simulation event.
 *
 * @example
 * ```typescript
 * const eventParams: RegisterEventParams = {
 *   name: 'Guard Patrol Shift',
 *   description: 'Relieve guards at the north gate.',
 *   offsetMinutes: 30,
 *   category: 'security',
 *   priority: 'normal'
 * };
 * ```
 */
export interface RegisterEventParams {
  /** Optional custom unique event identifier. Generated automatically if omitted. */
  id?: string;
  /** Alias for `id`; `id` takes precedence when both are provided. */
  eventId?: string;
  /** Event title / name (required unless title or description provided). */
  name?: string;
  /** Alias for `name`. */
  title?: string;
  /** Narrative description of the event. */
  description?: string;
  /** Absolute trigger world time in simulation seconds or formatted string (`"HH:MM:SS"`). */
  triggerTime?: number | string;
  /** Relative trigger offset in minutes from the owner partition's current time. */
  offsetMinutes?: number;
  /** Tool schema alias for `offsetMinutes`. */
  trigger_minutes?: number;
  /** Alias for `offsetMinutes`. */
  inMinutes?: number;
  /** Relative trigger offset in seconds from the owner partition's current time. */
  offsetSeconds?: number;
  /** Alias for `offsetSeconds`. */
  inSeconds?: number;
  /** Narrative category classification (default: `'narrative'`). */
  category?: string;
  /** Alias for `category`; `category` takes precedence when both are provided. */
  type?: string;
  /** Event priority level (default: `'normal'`). */
  priority?: EventPriority;
  /** Privileged/Admin only: Target agent partition to own this event. */
  targetAgentId?: string;
  /** Privileged/Admin only: Visibility scope (`'agent' | 'global'`). */
  scope?: EventScope;
  /** Privileged/Admin only: Whether public to all agents. */
  public?: boolean;
  /** Arbitrary domain metadata. */
  metadata?: Record<string, unknown>;
  /** Optional recurrence interval in minutes (spawns next event on resolution). */
  repeatMinutes?: number | null;
  /** Optional recurrence interval in seconds. */
  repeatSeconds?: number | null;
}

/**
 * Result structure returned after registering an event.
 *
 * @example
 * ```typescript
 * const regResult: RegisterEventResult = {
 *   success: true,
 *   event: registeredEvent
 * };
 * ```
 */
export interface RegisterEventResult {
  /** Whether event registration succeeded. */
  success: boolean;
  /** Registered {@link WorldEvent} entity (defensive copy) if successful. */
  event?: WorldEvent;
  /** Error message if registration failed. */
  error?: string;
  /** Machine-readable error code if registration failed. */
  code?: WorldClockErrorCode;
}

// queryEvents
/**
 * Parameter payload for filtering and querying simulation events.
 *
 * @example
 * ```typescript
 * const queryParams: QueryEventsParams = {
 *   status: 'active',
 *   category: 'security',
 *   search: 'gate'
 * };
 * ```
 */
export interface QueryEventsParams {
  /** Filter by event status (`'pending' | 'active' | 'resolved' | 'cancelled' | 'all'`). */
  status?: EventStatus | 'all';
  /** Shorthand to filter only active events (`status: 'active'`). */
  activeOnly?: boolean;
  /** Filter by narrative category. */
  category?: string;
  /** Filter by priority level. */
  priority?: EventPriority;
  /** Case-insensitive substring match against event name and description. */
  search?: string;
  /** Alias for `search`. */
  query?: string;
  /** Query specific event by ID. */
  eventId?: string;
  /** Alias for `eventId`. */
  id?: string;
  /** Privileged/Admin only: Specific agent partition to query. */
  targetAgentId?: string;
  /** Privileged/Admin only: Query events across all agent partitions simultaneously. */
  all?: boolean;
}

/**
 * Result structure returned when querying events.
 *
 * @example
 * ```typescript
 * const queryResult: QueryEventsResult = {
 *   success: true,
 *   clock: callingPartitionTimeState,
 *   count: 2,
 *   events: [event1, event2],
 *   activeEvents: [event1],
 *   activeCount: 1,
 *   pendingCount: 1,
 *   resolvedCount: 0
 * };
 * ```
 */
export interface QueryEventsResult {
  /** Always `true`; event queries have no failure branch because unauthorized scopes are silently narrowed. */
  success: true;
  /** Reference partition's current {@link TimeState} (the privileged `targetAgentId` when given, otherwise the caller's partition). */
  clock: TimeState;
  /** Total number of events matching the filter criteria. */
  count: number;
  /** Array of matching {@link WorldEvent} entities (defensive copies). */
  events: WorldEvent[];
  /** Convenience array of matching events that are currently active (defensive copies). */
  activeEvents: WorldEvent[];
  /** Total active events in the queried scope before filter criteria are applied. */
  activeCount: number;
  /** Total pending events in the queried scope before filter criteria are applied. */
  pendingCount: number;
  /** Total resolved events in the queried scope before filter criteria are applied. */
  resolvedCount: number;
}

// resolveEvent
/**
 * Parameter payload for resolving an event upon task completion.
 *
 * @example
 * ```typescript
 * const resolveParams: ResolveEventParams = {
 *   eventId: 'evt_patrol_123',
 *   resolutionNote: 'North gate patrol completed with no incidents.'
 * };
 * ```
 */
export interface ResolveEventParams {
  /** Identifier of the event to resolve. */
  eventId?: string;
  /** Alias for `eventId`. */
  id?: string;
  /** Tool schema alias for `eventId`. */
  event_id?: string;
  /** Explanatory note or outcome summary (defaults to `'Marked resolved by agent'`). */
  resolutionNote?: string;
  /** Alias for `resolutionNote`. */
  resolution?: string;
  /** Alias for `resolutionNote`. */
  note?: string;
}

/**
 * Result structure returned after resolving an event.
 *
 * @example
 * ```typescript
 * const resResult: ResolveEventResult = {
 *   success: true,
 *   resolved: true,
 *   event: resolvedEvent,
 *   nextEvent: nextRecurringOccurrence
 * };
 * ```
 */
export interface ResolveEventResult {
  /** Whether the resolution operation succeeded. */
  success: boolean;
  /** Boolean indicating the event was resolved. */
  resolved?: boolean;
  /** Resolved {@link WorldEvent} entity (defensive copy). */
  event?: WorldEvent;
  /** Newly scheduled {@link WorldEvent} instance (defensive copy, no stale `triggeredAtWorldTime`) if the resolved event had recurrence configured. */
  nextEvent?: WorldEvent | null;
  /** Error message if resolution failed. */
  error?: string;
  /** Machine-readable error code if resolution failed. */
  code?: WorldClockErrorCode;
}

// cancelEvent
/**
 * Parameter payload for cancelling an event without resolution.
 *
 * @example
 * ```typescript
 * const cancelParams: CancelEventParams = {
 *   eventId: 'evt_patrol_123',
 *   reason: 'Patrol stood down due to heavy blizzard.'
 * };
 * ```
 */
export interface CancelEventParams {
  /** Identifier of the event to cancel. */
  eventId?: string;
  /** Alias for `eventId`. */
  id?: string;
  /** Tool schema alias for `eventId`. */
  event_id?: string;
  /** Explanation or justification for cancellation (defaults to `'Cancelled'`). */
  reason?: string;
  /** Alias for `reason`. */
  cancellationReason?: string;
  /** Tool schema alias for `reason`. */
  description?: string;
}

/**
 * Result structure returned after cancelling an event.
 *
 * @example
 * ```typescript
 * const cancelResult: CancelEventResult = {
 *   success: true,
 *   cancelled: true,
 *   event: cancelledEvent
 * };
 * ```
 */
export interface CancelEventResult {
  /** Whether cancellation succeeded. */
  success: boolean;
  /** Boolean indicating cancellation state. */
  cancelled?: boolean;
  /** Cancelled {@link WorldEvent} entity (defensive copy). */
  event?: WorldEvent;
  /** Error message if cancellation failed. */
  error?: string;
  /** Machine-readable error code if cancellation failed. */
  code?: WorldClockErrorCode;
}

// updateEvent
/**
 * Parameter payload for modifying mutable fields of an existing event.
 *
 * @example
 * ```typescript
 * const updateParams: UpdateEventParams = {
 *   eventId: 'evt_patrol_123',
 *   priority: 'high',
 *   description: 'Increased goblin activity reported near the gate.'
 * };
 * ```
 */
export interface UpdateEventParams {
  /** Target event identifier. */
  eventId?: string;
  /** Alias for `eventId`. */
  id?: string;
  /** Tool schema alias for `eventId`. */
  event_id?: string;
  /** Updated title / name. */
  name?: string;
  /** Updated description. */
  description?: string;
  /** Updated priority level. */
  priority?: EventPriority;
  /** Updated narrative category. */
  category?: string;
  /** Updated metadata payload (merged into existing metadata). */
  metadata?: Record<string, unknown>;
}

/**
 * Result structure returned after updating an event.
 *
 * @example
 * ```typescript
 * const updateResult: UpdateEventResult = {
 *   success: true,
 *   updated: true,
 *   event: updatedEvent
 * };
 * ```
 */
export interface UpdateEventResult {
  /** Whether update succeeded. */
  success: boolean;
  /** Boolean indicating update state. */
  updated?: boolean;
  /** Updated {@link WorldEvent} entity (defensive copy). */
  event?: WorldEvent;
  /** Error message if update failed. */
  error?: string;
  /** Machine-readable error code if update failed. */
  code?: WorldClockErrorCode;
}

// clearEvents
/**
 * Parameter payload for purging events from partitions.
 *
 * @example
 * ```typescript
 * const clearParams: ClearEventsParams = {
 *   targetAgentId: 'agent_scout',
 *   writeToFs: true
 * };
 * ```
 */
export interface ClearEventsParams {
  /** Target partition to clear ('global', agent ID, or 'all'). */
  targetAgentId?: string;
  /** Privileged/Admin only: Clear events across all partitions. */
  all?: boolean;
  /** Whether to sync cleared state to VirtualFS (default: true). */
  writeToFs?: boolean;
}

/**
 * Result structure returned after clearing events.
 *
 * @example
 * ```typescript
 * const clearResult: ClearEventsResult = {
 *   success: true,
 *   cleared: 5,
 *   agentId: 'agent_scout'
 * };
 * ```
 */
export interface ClearEventsResult {
  /** Whether the clear operation succeeded. */
  success: boolean;
  /** Number of events purged from memory. */
  cleared: number;
  /** Partition ID that was cleared. */
  agentId?: string;
  /** Present when `all: true` was requested. */
  all?: boolean;
  /** Error message if clearing failed. */
  error?: string;
  /** Machine-readable error code if clearing failed. */
  code?: WorldClockErrorCode;
}

// start / stop ticker
/**
 * Options for starting continuous simulation clock progression.
 *
 * @example
 * ```typescript
 * const tickerOptions: TickerOptions = {
 *   intervalMs: 1000,
 *   stepSeconds: 60 // 1 real second = 1 simulation minute
 * };
 * ```
 */
export interface TickerOptions {
  /** Real-world wall-clock interval in milliseconds between ticks (minimum 10, default 1000). */
  intervalMs?: number;
  /** Simulation seconds to advance per tick (default: 1). */
  stepSeconds?: number;
}

/**
 * Status receipt returned when starting or stopping the background ticker.
 *
 * @example
 * ```typescript
 * const receipt: TickerReceipt = {
 *   success: true,
 *   running: true,
 *   intervalMs: 1000,
 *   stepSeconds: 1
 * };
 * ```
 */
export interface TickerReceipt {
  /** Whether the ticker operation succeeded. */
  success: boolean;
  /** Boolean indicating if the ticker is currently running. */
  running: boolean;
  /** Real-world interval in milliseconds between ticks. */
  intervalMs?: number;
  /** Simulation seconds advanced per tick. */
  stepSeconds?: number;
}

// ============================================================================
// 6. Internal Typing Helpers & Private Helper Functions
// ============================================================================

/**
 * Minimal structural handle for the ticker interval returned by the injected
 * host scheduler. Browser-style timers are numeric values, while Node-style
 * timers may expose an optional `unref()` detach hook.
 */
interface TickerIntervalHandle {
  /** Optional host-timer detach hook; absent on browser-style numeric handles. */
  unref?: () => void;
}

/**
 * Handle returned by the injected host interval scheduler: a DOM-style numeric
 * id or a structural timer object carrying the optional `unref()` detach hook.
 */
type TickerInterval = TickerIntervalHandle | number;

/**
 * Legacy flat snapshot event entry; `targetAgentId` is an undeclared historical
 * owner fallback read only when importing a flat `events` array.
 */
type LegacySnapshotEvent = WorldEvent & { targetAgentId?: string };

/**
 * Query-parameter compatibility aliases historically read by `queryEvents`
 * (`type` mirrors `category`, `agentId` mirrors `targetAgentId`) but not part
 * of its declared parameter contract.
 */
type QueryEventsCompatParams = QueryEventsParams & { type?: string; agentId?: string };

/**
 * Discriminated outcome of a best-effort VirtualFS JSON payload read.
 */
type VirtualFsJsonPayload =
  | { status: 'empty' }
  | { status: 'corrupted'; detail: string }
  | { status: 'ok'; data: Record<string, unknown> };

/**
 * Declared serialization schema of `/event_list.json` as written by
 * `syncToVirtualFs`: file-header fields plus the persisted {@link WorldEvent}
 * records. Persisted JSON is untrusted; hydration validates only each entry's
 * string `id` before import and trusts the remaining declared fields exactly as
 * persisted (best-effort hydration contract).
 */
interface PersistedEventListPayload {
  /** Persisted event records. */
  events?: WorldEvent[];
  /** File-header fields (`version`, `agentId`, `worldTimeSeconds`, ...). */
  [key: string]: unknown;
}

/**
 * Tests whether an untrusted value is a plain JSON object (non-null, non-array).
 *
 * @param value - Value to inspect
 * @returns Whether the value is a plain object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Format total seconds into structured world time strings.
 *
 * @param totalSeconds - Total elapsed seconds from epoch
 * @param includeSeconds - Whether to include seconds in formatted string
 * @returns Structured world time components plus formatted strings
 */
function formatWorldTime(totalSeconds: number, includeSeconds?: boolean): {
  formatted: string;
  shortFormatted: string;
  day: number;
  hour: number;
  minute: number;
  second: number;
};
function formatWorldTime(totalSeconds: 0, includeSeconds?: true): {
  formatted: '00:00:00';
  shortFormatted: '00:00';
  day: 1;
  hour: 0;
  minute: 0;
  second: 0;
};
function formatWorldTime(totalSeconds: number, includeSeconds = true): {
  formatted: string;
  shortFormatted: string;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const safeSec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const day = Math.floor(safeSec / 86400) + 1; // 1-indexed days
  const hour = Math.floor((safeSec % 86400) / 3600);
  const minute = Math.floor((safeSec % 3600) / 60);
  const second = safeSec % 60;

  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  const ss = String(second).padStart(2, '0');

  const shortFormatted = `${hh}:${mm}`;
  const formatted = includeSeconds ? `${hh}:${mm}:${ss}` : shortFormatted;

  return {
    formatted,
    shortFormatted,
    day,
    hour,
    minute,
    second
  };
}

/**
 * Parse time input into total seconds.
 * Supports numbers (seconds), strings ("HH:MM", "HH:MM:SS", "D:HH:MM:SS", "15m", "90s", "2h").
 *
 * @param input - Numeric seconds or a supported time/duration string
 * @returns Parsed total seconds (0 for unsupported input)
 */
function parseTimeString(input: number | string): number {
  if (typeof input === 'number') {
    return Math.max(0, Math.floor(input));
  }
  if (!input || typeof input !== 'string') {
    return 0;
  }

  const str = input.trim().toLowerCase();

  // Pure numeric string
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }

  // Duration shorthand e.g. "1h 30m", "45m", "90s"
  let durationSec = 0;
  let matchedShorthand = false;
  const dMatch = str.match(/(\d+)\s*d(?:ays?)?/);
  const hMatch = str.match(/(\d+)\s*h(?:ours?|rs?)?/);
  const mMatch = str.match(/(\d+)\s*m(?:in(?:utes?)?)?/);
  const sMatch = str.match(/(\d+)\s*s(?:ec(?:onds?)?)?/);

  if (dMatch) { durationSec += parseInt(dMatch[1], 10) * 86400; matchedShorthand = true; }
  if (hMatch) { durationSec += parseInt(hMatch[1], 10) * 3600; matchedShorthand = true; }
  if (mMatch) { durationSec += parseInt(mMatch[1], 10) * 60; matchedShorthand = true; }
  if (sMatch) { durationSec += parseInt(sMatch[1], 10); matchedShorthand = true; }

  if (matchedShorthand) {
    return durationSec;
  }

  // Digital clock format "HH:MM" or "HH:MM:SS" or "D:HH:MM:SS"
  const parts = str.split(':').map(p => parseInt(p.trim(), 10) || 0);
  if (parts.length === 2) {
    // HH:MM
    return parts[0] * 3600 + parts[1] * 60;
  } else if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 4) {
    // D:HH:MM:SS
    return (parts[0] - 1) * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
  }

  return 0;
}

/**
 * Generate a clean unique event ID.
 *
 * @param prefix - ID prefix (defaults to `'evt'`)
 * @returns Unique event identifier
 */
function generateEventId(prefix = 'evt'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36);
  return `${prefix}_${ts}_${rand}`;
}

/**
 * MOD-21 W4 authority predicate: reports whether a frozen `AuthorityDescriptor`
 * grants substrate-level (cross-partition) authority to its principal.
 *
 * A descriptor grants cross-partition authority when its `visibility` is
 * `'all'` or `'system'`, or when its `allow` set carries the `'*'` wildcard.
 * Every other shape (absent descriptor, `'self'`/`'owned'` visibility, explicit
 * tool list) is default-deny.
 *
 * @param authority - Candidate authority descriptor resolved from the injected identity port
 * @returns Whether the descriptor grants cross-partition authority
 */
function authorityGrantsSubstratePrivilege(authority: WorldClockIdentityProjection['authority']): boolean {
  if (!authority || typeof authority !== 'object') return false;
  if (authority.visibility === 'all' || authority.visibility === 'system') return true;
  const allow = authority.allow;
  if (allow instanceof Set) return allow.has('*');
  if (Array.isArray(allow)) return allow.includes('*');
  return false;
}

/**
 * Produce a defensive copy of an event entity so callers can never mutate internal registry state.
 *
 * @param event - Event entity to copy
 * @returns Independent copy of the event
 */
function copyEvent(event: WorldEvent): WorldEvent {
  if (!event || typeof event !== 'object') return event;
  try {
    return structuredClone(event);
  } catch {
    return {
      ...event,
      metadata: event.metadata && typeof event.metadata === 'object' ? { ...event.metadata } : {}
    };
  }
}

// ============================================================================
// 7. WorldClock Class Definition
// ============================================================================

/**
 * Canonical realm-global partition key (Realm wave A0): the shared global
 * partition of realm `realmId`, and the VirtualFS workspace its sync payloads
 * are written to. The ungrouped/legacy shared key remains `global`.
 *
 * @param realmId - Non-empty realm identifier.
 * @returns The canonical `realm:<realmId>:global` partition key.
 */
function realmGlobalKeyFor(realmId: string): string {
  return `realm:${realmId}:global`;
}

/**
 * Tests whether a partition/workspace key belongs to the reserved Realm family
 * (`realm:<realmId>:global`). Realm-prefixed keys are visible only to the
 * injected internal principal, `realmBypass` projections, and the engine's
 * context-free calls; every identified non-bypass caller — realm-bound or
 * legacy ungrouped — is confined away from the whole family (V10 F-V10-1).
 *
 * @param key - Candidate partition or workspace key.
 * @returns Whether the key carries the reserved `realm:` prefix.
 */
function isRealmPartitionKey(key: string): boolean {
  return key.startsWith('realm:');
}

/**
 * Partition/owner receipt fields rewritten by the agent-visible tool-seam
 * opacity sanitizer (R3, ticket 10eab05). Partition-keyed maps (`clocks`) are
 * handled separately by key.
 */
const AGENT_VISIBLE_PARTITION_FIELDS: ReadonlySet<string> = new Set([
  'agentId',
  'targetAgentId',
  'ownerId',
  'createdBy'
]);

/**
 * Exact shape of the internal realm-global partition key
 * (`realm:<realmId>:global`). The agent-visible label for it is `global`.
 */
const REALM_GLOBAL_PARTITION_KEY_PATTERN = /^realm:[^:]+:global$/;

/**
 * Maps an internal partition key to the agent-visible label: a registered
 * canonical identity key (`AgentIdentityProjection.key`) is projected to its
 * bare `id` through the bound receipt-label resolver, the realm-global
 * partition key (`realm:<realmId>:global`) is labeled `global`, and every
 * other identifier passes through unchanged (R3 ticket 10eab05; Wave I ticket
 * d57cbc1).
 *
 * @param value - Candidate partition or owner identifier.
 * @param resolveLabel - Optional resolver projecting a canonical key to its bare id.
 * @returns The agent-visible label.
 */
function toAgentVisiblePartitionKey(value: string, resolveLabel?: (key: string) => string): string {
  const resolved = typeof resolveLabel === 'function' ? resolveLabel(value) : value;
  return REALM_GLOBAL_PARTITION_KEY_PATTERN.test(resolved) ? 'global' : resolved;
}

/**
 * Deep-copies an agent-visible tool receipt, rewriting the internal
 * `realm:<realmId>:global` partition key to `global` and projecting registered
 * canonical identity keys to their bare `id` in the partition/owner fields
 * (`agentId`, `targetAgentId`, `ownerId`, `createdBy`) and in the keys of a
 * `clocks` partition map (R3 ticket 10eab05; Wave I ticket d57cbc1).
 *
 * Agent-authored content (prompts, descriptions, metadata, notes) is never
 * rewritten, and this function is applied only at the tool-adapter seam — the
 * direct host/API surface keeps the internal partition key.
 *
 * @param value - Receipt value to sanitize.
 * @param fieldName - Parent object key of a primitive value (dispatch only).
 * @param resolveLabel - Optional resolver projecting a canonical key to its bare id.
 * @returns A sanitized deep copy.
 */
function sanitizeAgentVisibleReceipt(
  value: unknown,
  fieldName?: string,
  resolveLabel?: (key: string) => string
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAgentVisibleReceipt(entry, undefined, resolveLabel));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'clocks' && entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const clocks: Record<string, unknown> = {};
        for (const [clockKey, state] of Object.entries(entry as Record<string, unknown>)) {
          clocks[toAgentVisiblePartitionKey(clockKey, resolveLabel)] = sanitizeAgentVisibleReceipt(state, undefined, resolveLabel);
        }
        out.clocks = clocks;
      } else {
        out[key] = sanitizeAgentVisibleReceipt(entry, key, resolveLabel);
      }
    }
    return out;
  }
  if (typeof value === 'string' && fieldName && AGENT_VISIBLE_PARTITION_FIELDS.has(fieldName)) {
    return toAgentVisiblePartitionKey(value, resolveLabel);
  }
  return value;
}

/**
 * Resolved caller authentication plus Realm scope (internal to the engine).
 */
interface ResolvedCallerScope {
  /** Claimed caller identity (defaults to `'global'` for anonymous callers). */
  callerAgentId: string;
  /**
   * Canonical identity key of the resolved caller registration, when the
   * runtime supplied one (`context.callerKey`) or the claimed identifier was
   * itself a canonical key; `null` when only a bare id resolved (Wave I,
   * ticket d57cbc1).
   */
  callerKey: string | null;
  /**
   * Partition key of the caller's own partition: the runtime-supplied
   * canonical key when one resolved, else the claimed bare identifier (Wave I,
   * ticket d57cbc1). Operational reads/writes target this key.
   */
  callerPartitionKey: string;
  /** Whether the caller resolves cross-partition authority. */
  isPrivileged: boolean;
  /** Legacy admin alias of `isPrivileged`. */
  isAdmin: boolean;
  /** Non-empty realm id for realm-bound callers, else `null`. */
  realmId: string | null;
  /** Whether the caller bypasses Realm scoping (internal principal / realm bypass). */
  realmBypass: boolean;
  /** Operating shared-global partition key: the realm key or legacy `'global'`. */
  globalKey: string;
  /**
   * Whether the execution context identified a caller (a `callerAgentId`/
   * `agentId`/`callerKey` claim or a `principal` key). Context-free calls are
   * engine operations (constructor/store/persistence hydration) and keep the
   * legacy unscoped span; an identified ungrouped caller never sees realm
   * partitions.
   */
  hasCaller: boolean;
}

/**
 * Layer 0 Foundation Primitive: WorldClock simulation engine.
 *
 * Manages partitioned in-universe simulation narrative time, event scheduling,
 * and automatic synchronization with VirtualFS (`/world_clock.json` and `/event_list.json`).
 *
 * @example
 * ```typescript
 * import { WorldClock } from './worldClock/index.ts';
 *
 * const clock = new WorldClock({ initialSeconds: 28800, date: 'Day 1' });
 *
 * // Agent queries local time
 * const time = clock.getTime({}, { callerAgentId: 'agent_scout' });
 * console.log(`Scout time: ${(time as TimeState).formatted}`);
 *
 * // Advance time by 30 minutes
 * const advanceRes = clock.advanceClock({ minutes: 30 }, { callerAgentId: 'agent_scout' });
 * if (advanceRes.success) {
 *   console.log(`Advanced to: ${advanceRes.currentFormatted}`);
 * } else {
 *   console.error(`Advance failed: ${advanceRes.code}`);
 * }
 * ```
 */
export class WorldClock {
  /**
   * Map of agent ID (or 'global') to clock state: `{ totalSeconds, date, lastSync }`.
   */
  #agentClocks: Map<string, PartitionClockSnapshot>;

  /**
   * Map of agent ID (or 'global') to Map of event ID to WorldEvent.
   */
  #agentEvents: Map<string, Map<string, WorldEvent>>;

  /**
   * Injected VirtualFS adapter used for bidirectional synchronization.
   */
  #virtualFs: WorldClockVirtualFsAdapter | null;

  /**
   * Whether state mutations are automatically written to VirtualFS.
   */
  #autoSyncFs: boolean;

  /**
   * Injected host interval scheduler.
   */
  #hostSetInterval: (handler: () => void, timeoutMs: number) => TickerInterval;

  /**
   * Injected host interval canceller. Defaults to the global `clearInterval`
   * applied reflectively, because the DOM declaration types only numeric
   * handles while hosts may return timer objects.
   */
  #hostClearInterval: (handle: TickerInterval) => void;

  /**
   * Host interval handle for the automatic ticker.
   */
  #intervalId: TickerInterval | null;

  /**
   * Whether the automatic ticker is currently running.
   */
  #isRunning: boolean;

  /**
   * Injected identity resolver (`AgentIdentityPort` shape) used to resolve an
   * agent subject into its trusted authority descriptor; null means no agent
   * authority is resolvable (default-deny).
   */
  #identityPort: WorldClockIdentityPort | null;

  /**
   * Opaque engine-internal principal reference injected by the composition
   * root. Only this exact object grants internal authority; per-call
   * `context.principal` values are honored solely by reference equality.
   */
  #internalPrincipal: object | null;

  /**
   * Instantiates the WorldClock simulation engine.
   *
   * @param options - Initialization options (VirtualFS adapter, starting seconds, date, auto-sync).
   *
   * @example
   * ```typescript
   * const clock = new WorldClock({
   *   virtualFs: vfs,
   *   initialSeconds: 32400, // 09:00:00
   *   date: 'Day 1 Morning',
   *   autoSyncFs: true
   * });
   * ```
   */
  constructor({
    virtualFs = null,
    initialSeconds = 0,
    date = 'Day 1',
    autoSyncFs = true,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    identityPort = null,
    internalPrincipal = null
  }: WorldClockOptions = {}) {
    this.#virtualFs = virtualFs;
    this.#autoSyncFs = autoSyncFs !== false;
    this.#identityPort = (identityPort && typeof identityPort.getAgentIdentity === 'function') ? identityPort : null;
    this.#internalPrincipal = (internalPrincipal && typeof internalPrincipal === 'object') ? internalPrincipal : null;
    this.#hostSetInterval = typeof setIntervalFn === 'function'
      ? setIntervalFn
      : (handler, ms) => globalThis.setInterval(handler, ms);
    this.#hostClearInterval = typeof clearIntervalFn === 'function'
      ? clearIntervalFn
      : (handle) => { Reflect.apply(globalThis.clearInterval, globalThis, [handle]); };

    this.#agentClocks = new Map();
    this.#agentEvents = new Map();

    const initSec = Math.max(0, Math.floor(Number(initialSeconds) || 0));
    const initDate = typeof date === 'string' && date.trim() ? date.trim() : 'Day 1';

    // Initialize global partition
    this.#agentClocks.set('global', {
      totalSeconds: initSec,
      date: initDate,
      lastSync: Date.now()
    });

    this.#intervalId = null;
    this.#isRunning = false;

    // Hydrate existing state from virtualFs if available, or sync initial state
    if (this.#virtualFs && this.#autoSyncFs) {
      this.syncFromVirtualFs();
      this.syncToVirtualFs();
    }
  }

  /**
   * Binds the engine-internal principal to this instance (composition-root
   * wiring for injected substrates; MOD-21 W10-C).
   *
   * The runtime mints its opaque principal in its own constructor, so an
   * injected `WorldClock` instance can never receive it through
   * `WorldClockOptions.internalPrincipal`. The composition root binds that
   * exact reference here immediately after accepting the injection, mirroring
   * {@link VirtualFS.bindInternalPrincipal}. First bind wins: an instance
   * constructed with `internalPrincipal` (or already bound) is never rebound,
   * and a non-object candidate is rejected. The bind validates no further
   * shape or branding — any accepted object reference becomes the trusted
   * principal — so only the exact composition-root reference should ever be
   * passed. Only the exact bound reference authorizes the tenant-administration
   * snapshot pair; the binding method itself confers no other authority.
   *
   * @param principal - The exact `InternalPrincipal` reference minted by the composition root.
   * @returns True when this call performed the one-time binding.
   *
   * @example
   * ```typescript
   * const clock = new WorldClock({ autoSyncFs: false });
   * clock.bindInternalPrincipal(internalPrincipal); // true
   * clock.bindInternalPrincipal(otherPrincipal); // false (never rebound)
   * ```
   */
  bindInternalPrincipal(principal: object): boolean {
    if (this.#internalPrincipal) return false;
    if (!principal || typeof principal !== 'object') return false;
    this.#internalPrincipal = principal;
    return true;
  }

  /**
   * Helper to extract normalized authentication, caller credentials, and Realm
   * scope.
   *
   * MOD-21 W4 resolved privilege rule (default-deny): a caller is privileged
   * only when (a) the execution context carries the exact injected
   * `internalPrincipal` reference at `context.principal`, or (b) the injected
   * identity port resolves the claimed `callerAgentId`/`agentId` to an
   * authority descriptor that grants cross-partition scope (`visibility`
   * `'all'`/`'system'` or the `'*'` wildcard in `allow`). Caller-asserted
   * `isAdmin`/`isPrivileged`/`callerRole` values and reserved ids
   * (`system`/`admin`/`director`) confer nothing.
   *
   * Realm scope (Realm wave A0) resolves from the same trusted projection: a
   * non-empty `realmId` without `realmBypass` binds the caller's operating
   * shared-global partition (and sync target) to `realm:<realmId>:global`.
   * Projections without the optional fields stay ungrouped (`global`).
   *
   * Wave I (ticket d57cbc1): the canonical `context.callerKey` projection is
   * resolved first through the port's `listAgentIdentities()` (an exact `key`
   * match); the claimed `callerAgentId`/`agentId` — which may itself be the
   * canonical key the runtime supplied — resolves next. The caller's own
   * partition is keyed by the runtime-supplied identifier (the canonical key
   * when one resolved, else the bare id), so partition state stays keyed
   * exactly as the runtime supplies it.
   *
   * The returned `hasCaller` flag distinguishes an identified caller (a
   * `callerAgentId`/`agentId`/`callerKey` claim or a `principal` key) from a
   * context-free engine call; only the latter keeps the legacy unscoped span
   * (V10 F-V10-1).
   *
   * @param context - Execution and security context of the invoking caller
   * @returns Normalized caller identity, resolved privilege flags, and realm scope
   */
  #extractAuth(context: ExecutionContext = {}): ResolvedCallerScope {
    const ctx = (context && typeof context === 'object') ? context : {};

    let suppliedAgentId = 'global';
    if (ctx.callerAgentId || ctx.agentId) {
      suppliedAgentId = String(ctx.callerAgentId || ctx.agentId).trim() || 'global';
    }
    const suppliedKey = (typeof ctx.callerKey === 'string' && ctx.callerKey.trim())
      ? ctx.callerKey.trim()
      : '';
    const hasCaller = Boolean(ctx.callerAgentId || ctx.agentId || suppliedKey || 'principal' in ctx);

    const isEnginePrincipal = Boolean(this.#internalPrincipal && ctx.principal === this.#internalPrincipal);

    // Canonical-key resolution first (Wave I, d57cbc1): the explicit
    // `callerKey` is authoritative; a claimed identifier that is itself a
    // canonical key resolves the same way; the bare unique-match lookup is the
    // final fallback (zero/multiple matches fail closed to anonymous).
    let identity: WorldClockIdentityProjection | null = null;
    let callerPartitionKey = '';
    let resolvedBySuppliedKey = false;
    if (suppliedKey) {
      const byKey = this.#resolveIdentityByKey(suppliedKey);
      if (byKey) {
        identity = byKey;
        callerPartitionKey = suppliedKey;
        resolvedBySuppliedKey = true;
      }
    }
    if (!identity) {
      const byIdentifierKey = this.#resolveIdentityByKey(suppliedAgentId);
      if (byIdentifierKey) {
        identity = byIdentifierKey;
        callerPartitionKey = suppliedAgentId;
      }
    }
    if (!identity) {
      identity = this.#resolveIdentity(suppliedAgentId);
    }
    if (!callerPartitionKey) callerPartitionKey = suppliedAgentId;

    const callerAgentId = (identity && typeof identity.id === 'string' && identity.id.trim())
      ? identity.id.trim()
      : suppliedAgentId;
    // The canonical caller key is trusted only when the identity actually
    // resolved through a key (the port's `key` field or the supplied key that
    // matched it); an unmatched claim never widens self-targeting.
    const callerKey = (identity && typeof identity.key === 'string' && identity.key.trim())
      ? identity.key.trim()
      : (resolvedBySuppliedKey ? suppliedKey : null);

    const isPrivileged = this.#resolvePrivilege(ctx, callerAgentId, identity);

    const realmBypass = isEnginePrincipal || identity?.realmBypass === true;
    const rawRealmId = identity?.realmId;
    const realmId = (!realmBypass && typeof rawRealmId === 'string' && rawRealmId.trim())
      ? rawRealmId.trim()
      : null;

    return {
      callerAgentId,
      callerKey,
      callerPartitionKey,
      isPrivileged,
      isAdmin: isPrivileged,
      realmId,
      realmBypass,
      globalKey: realmId ? realmGlobalKeyFor(realmId) : 'global',
      hasCaller
    };
  }

  /**
   * Resolves a claimed caller identity through the injected identity port,
   * failing closed (null) when no port is injected, the subject is empty, or
   * the port throws.
   *
   * @param callerAgentId - Claimed realm-local caller identity
   * @returns Trusted identity projection or null
   */
  #resolveIdentity(callerAgentId: string | null | undefined): WorldClockIdentityProjection | null {
    if (!this.#identityPort || !callerAgentId) return null;
    try {
      const identity = this.#identityPort.getAgentIdentity(callerAgentId);
      return (identity && typeof identity === 'object') ? identity : null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a canonical internal identity key (`AgentIdentityProjection.key`,
   * Wave I ticket d57cbc1) through the injected port's
   * `listAgentIdentities()`, failing closed (`null`) when the port exposes no
   * enumeration, no registration matches, more than one matches, or the port
   * throws. The key is treated as an opaque exact-match string — never parsed.
   *
   * @param key - Candidate canonical identity key
   * @returns Trusted identity projection or null
   */
  #resolveIdentityByKey(key: string | null | undefined): WorldClockIdentityProjection | null {
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
   * Resolves an agent subject inside one Realm scope (Wave I, ticket
   * d57cbc1): a canonical key resolves by exact key match, a bare realm-local
   * id through the scoped `getAgentIdentity(subject, { realmId })`. Foreign or
   * ambiguous subjects resolve `null` — the caller's Realm is never left and
   * no existence oracle is exposed.
   *
   * @param subject - Partition/agent identifier (canonical key or bare id)
   * @param realmId - Caller's non-empty Realm id
   * @returns Trusted identity projection inside that Realm or null
   */
  #resolveIdentityInRealm(subject: string | null | undefined, realmId: string): WorldClockIdentityProjection | null {
    if (!this.#identityPort || typeof subject !== 'string' || !subject.trim()) return null;
    const trimmed = subject.trim();
    const byKey = this.#resolveIdentityByKey(trimmed);
    if (byKey) return byKey;
    try {
      const identity = this.#identityPort.getAgentIdentity(trimmed, { realmId });
      return (identity && typeof identity === 'object') ? identity : null;
    } catch {
      return null;
    }
  }

  /**
   * Enumerates the partition-key candidates registered in one Realm through
   * the injected port's `listAgentIdentities({ realmId })` (Wave I, ticket
   * d57cbc1). Each projection contributes both its canonical `key` and its
   * bare `id`, so partition maps keyed either way (pre-wiring vs canonical)
   * are recognised. Returns `null` when the injected port exposes no
   * enumeration (legacy per-partition lookup applies).
   *
   * @param realmId - Realm id to enumerate
   * @returns Candidate partition keys or null when unsupported
   */
  #listRealmMemberKeys(realmId: string): Set<string> | null {
    const port = this.#identityPort;
    if (!port || typeof port.listAgentIdentities !== 'function') return null;
    try {
      const members = port.listAgentIdentities({ realmId });
      if (!Array.isArray(members)) return null;
      const keys = new Set<string>();
      for (const member of members) {
        if (!member || typeof member !== 'object') continue;
        if (typeof member.key === 'string' && member.key.trim()) keys.add(member.key.trim());
        if (typeof member.id === 'string' && member.id.trim()) keys.add(member.id.trim());
      }
      return keys;
    } catch {
      return null;
    }
  }

  /**
   * Receipt label of a partition key (Wave I, ticket d57cbc1): a key that
   * resolves to a registered identity key projects back to the projection's
   * bare `id`; every other value (bare ids, realm-global keys, `global`,
   * system paths) passes through unchanged. Applied to single-target receipt
   * identifier fields and denial messages only — container keys and
   * persistence payloads keep the internal partition key they address.
   *
   * @param value - Partition or owner identifier
   * @returns The agent-visible label
   */
  #receiptLabel(value: string): string {
    if (typeof value !== 'string' || !value) return value;
    const identity = this.#resolveIdentityByKey(value);
    if (identity && typeof identity.id === 'string' && identity.id.trim()) return identity.id.trim();
    return value;
  }

  /**
   * Defensive receipt copy of an event with partition identifiers projected to
   * their bare registration ids (Wave I, ticket d57cbc1). Internal snapshot
   * exports keep the raw {@link copyEvent} form so persisted owner keys
   * round-trip.
   *
   * @param event - Event entity to copy
   * @returns Independent receipt copy with projected attribution fields
   */
  #receiptEvent(event: WorldEvent): WorldEvent {
    const copy = copyEvent(event);
    if (copy && typeof copy === 'object') {
      copy.ownerId = this.#receiptLabel(copy.ownerId);
      if (typeof copy.createdBy === 'string') copy.createdBy = this.#receiptLabel(copy.createdBy);
      if (typeof copy.resolvedBy === 'string') copy.resolvedBy = this.#receiptLabel(copy.resolvedBy);
      if (typeof copy.cancelledBy === 'string') copy.cancelledBy = this.#receiptLabel(copy.cancelledBy);
    }
    return copy;
  }

  /**
   * Sanitizes a tool receipt for the agent-visible surface (R3 ticket 10eab05;
   * Wave I ticket d57cbc1): registered canonical identity keys are projected
   * to their bare `id` through the bound receipt label, and the internal
   * `realm:<realmId>:global` partition key is labeled `global`.
   *
   * @param value - Receipt value to sanitize
   * @returns Sanitized deep copy
   */
  #sanitizeAgentVisible(value: unknown): unknown {
    return sanitizeAgentVisibleReceipt(value, undefined, (key) => this.#receiptLabel(key));
  }

  /**
   * Resolves a caller's substrate authority from trusted sources only: the
   * injected internal principal reference or the injected identity port; the
   * resolved Realm scope rides the same projection (Realm wave A0).
   *
   * @param context - Object-shaped execution context
   * @param callerAgentId - Claimed caller identity
   * @param identity - Optional pre-resolved identity projection (avoids a second port lookup)
   * @returns Whether the caller resolves cross-partition authority
   */
  #resolvePrivilege(
    context: ExecutionContext,
    callerAgentId: string,
    identity?: WorldClockIdentityProjection | null
  ): boolean {
    if (this.#internalPrincipal && context.principal === this.#internalPrincipal) {
      return true;
    }

    const resolved = identity !== undefined ? identity : this.#resolveIdentity(callerAgentId);
    if (resolved) {
      if (resolved.authority !== undefined && resolved.authority !== null) {
        return authorityGrantsSubstratePrivilege(resolved.authority);
      }
      // Deprecated compatibility projection; removed once the enforcement
      // waves populate `authority` everywhere.
      if (resolved.privileged === true) return true;
    }

    return false;
  }

  /**
   * Maps a requested partition key onto the caller's operating scope.
   *
   * The literal shared key `'global'` resolves to the caller's realm-global key
   * for realm-bound callers. Partition and ownership keys are otherwise the
   * identifier the runtime supplies, used verbatim as opaque strings (Wave I,
   * ticket d57cbc1): bare ids before the wiring lane, canonical
   * `(realmId, agentId)` keys after.
   *
   * A realm-bound caller's bare reference resolves inside its own Realm
   * through the identity port: an existing partition of the resolved
   * registration wins (either the canonical or the bare form), the caller's
   * own reference resolves to the caller's own partition key, and — when the
   * runtime supplied the caller in canonical-key form — an untouched same-realm
   * peer resolves to its canonical key. Unknown or foreign references pass
   * through unchanged, where the existing scope gate denies or narrows them
   * (no existence oracle).
   *
   * @param auth - Resolved caller scope
   * @param partitionKey - Requested partition key or nullish
   * @returns Effective partition key
   */
  #resolvePartitionKey(auth: ResolvedCallerScope, partitionKey: string | null | undefined): string {
    if (typeof partitionKey !== 'string' || !partitionKey.trim()) return auth.globalKey;
    const trimmed = partitionKey.trim();
    if (trimmed === 'global') return auth.globalKey;
    if (
      trimmed === auth.globalKey
      || trimmed === auth.callerPartitionKey
      || (auth.callerKey !== null && trimmed === auth.callerKey)
    ) {
      // Self references always operate the caller's own partition, whichever
      // identifier form the runtime keys it by.
      return trimmed === auth.globalKey ? trimmed : auth.callerPartitionKey;
    }
    if (!auth.realmId) return trimmed;

    const identity = this.#resolveIdentityInRealm(trimmed, auth.realmId);
    if (!identity) return trimmed;

    const identityKey = typeof identity.key === 'string' && identity.key.trim() ? identity.key.trim() : '';
    const identityId = typeof identity.id === 'string' && identity.id.trim() ? identity.id.trim() : '';
    if (identityKey && this.#partitionExists(identityKey)) return identityKey;
    if (identityId && this.#partitionExists(identityId)) return identityId;
    if (identityId && identityId === auth.callerAgentId) return auth.callerPartitionKey;
    // The identifier form the runtime keys the caller by tells which form an
    // untouched same-realm peer's partition would use.
    const canonicalMode = auth.callerPartitionKey !== auth.callerAgentId;
    if (canonicalMode && identityKey) return identityKey;
    return identityId || trimmed;
  }

  /**
   * Whether a partition key currently has clock or event state.
   *
   * @param key - Candidate partition key
   * @returns Whether the partition exists in either registry
   */
  #partitionExists(key: string): boolean {
    return this.#agentClocks.has(key) || this.#agentEvents.has(key);
  }

  /**
   * Resolves the partition keys a caller may enumerate in one scope.
   *
   * Returns `null` only for the engine-wide span: the injected internal
   * principal, `realmBypass` identity projections, and context-free engine
   * calls (constructor/store/persistence hydration). Every identified
   * non-bypass caller gets an exact scope:
   *
   * - Realm-bound callers: their realm-global key plus their own partition,
   *   plus — when privileged — every same-realm member partition. Membership
   *   resolves through the identity port: `listAgentIdentities({ realmId })`
   *   contributes each same-realm registration's canonical key and bare id
   *   (Wave I, ticket d57cbc1), and the per-partition realm check remains the
   *   fallback for ports without enumeration. Other realms are never included.
   * - Ungrouped callers (privileged or not): the legacy non-realm keys only —
   *   `global` plus the caller's own partition, plus every existing legacy
   *   partition for privileged principals. A `realm:`-prefixed partition is
   *   never part of the scope (V10 F-V10-1), so an ungrouped wildcard caller
   *   cannot enumerate or query any realm.
   *
   * @param auth - Resolved caller scope
   * @returns Scoped partition keys or `null` for the engine-wide span
   */
  #scopedPartitionKeys(auth: ResolvedCallerScope): string[] | null {
    if (auth.realmBypass) return null;

    if (auth.realmId) {
      const keys = new Set<string>();
      keys.add(auth.globalKey);
      if (auth.callerPartitionKey && auth.callerPartitionKey !== 'global') {
        keys.add(auth.callerPartitionKey);
      }

      if (auth.isPrivileged) {
        const memberKeys = this.#listRealmMemberKeys(auth.realmId);
        const allKeys = new Set([...this.#agentClocks.keys(), ...this.#agentEvents.keys()]);
        for (const key of allKeys) {
          if (keys.has(key)) continue;
          if (memberKeys) {
            if (memberKeys.has(key)) {
              keys.add(key);
              continue;
            }
          }
          const identity = this.#resolveIdentityInRealm(key, auth.realmId);
          if (identity && typeof identity.realmId === 'string' && identity.realmId.trim() === auth.realmId) {
            keys.add(key);
          }
        }
      }

      return [...keys];
    }

    // Context-free engine calls keep the legacy unscoped span; an anonymous
    // caller that somehow resolves privilege through a legacy identity port is
    // still confined to the non-realm partitions.
    if (!auth.hasCaller && !auth.isPrivileged) return null;

    const keys = new Set<string>(['global']);
    if (auth.callerPartitionKey && auth.callerPartitionKey !== 'global' && !isRealmPartitionKey(auth.callerPartitionKey)) {
      keys.add(auth.callerPartitionKey);
    }

    if (auth.isPrivileged) {
      const allKeys = new Set([...this.#agentClocks.keys(), ...this.#agentEvents.keys()]);
      for (const key of allKeys) {
        if (!isRealmPartitionKey(key)) keys.add(key);
      }
    }

    return [...keys];
  }

  /**
   * Single-target admission predicate: whether an identified caller may name
   * `key` as the explicit target of a clock/event operation (V10 F-V10-1).
   *
   * - `realmBypass` principals and context-free engine calls admit every key.
   * - Realm-bound callers admit their realm-global key, their own partition
   *   (any identifier form), and — when privileged — any partition whose
   *   identity-port projection resolves inside the caller's Realm (a canonical
   *   key by exact key match, a bare id through the scoped lookup; lazily
   *   created same-realm member partitions are admitted even before their
   *   partition exists). Other realms resolve `null` and are denied.
   * - Identified ungrouped callers admit every non-realm key (the legacy
   *   per-method ownership gates still restrict unprivileged callers to their
   *   own partition); the reserved `realm:` family is denied.
   *
   * @param auth - Resolved caller scope
   * @param key - Effective target partition key
   * @returns Whether the caller may target the partition
   */
  #isTargetInScope(auth: ResolvedCallerScope, key: string): boolean {
    if (auth.realmBypass) return true;

    if (auth.realmId) {
      if (
        key === auth.globalKey
        || key === auth.callerPartitionKey
        || key === auth.callerAgentId
        || (auth.callerKey !== null && key === auth.callerKey)
      ) {
        return true;
      }
      if (!auth.isPrivileged) return false;
      const identity = this.#resolveIdentityInRealm(key, auth.realmId);
      return Boolean(
        identity
        && typeof identity.realmId === 'string'
        && identity.realmId.trim() === auth.realmId
      );
    }

    if (!auth.hasCaller && !auth.isPrivileged) return true;
    return !isRealmPartitionKey(key);
  }

  /**
   * Standard denial receipt for a single-target operation whose resolved
   * partition lies outside the caller's realm scope (V10 F-V10-1). The
   * rejected identifier is projected through the bare-id receipt label so a
   * registered canonical key never appears in an error message (Wave I,
   * ticket d57cbc1).
   *
   * @param key - Rejected target partition key
   * @returns `PERMISSION_DENIED` failure receipt
   */
  #outOfScopeFailure(key: string): WorldClockOperationFailure {
    return {
      success: false,
      error: `Permission denied: partition '${this.#receiptLabel(key)}' is outside the caller's realm scope`,
      code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
    };
  }

  /**
   * Helper to retrieve or lazily create an agent clock partition.
   *
   * @param agentId - Partition key (defaults to `'global'`)
   * @returns Mutable internal clock state for the partition
   */
  #getOrCreateClock(agentId = 'global'): PartitionClockSnapshot {
    const key = (typeof agentId === 'string' && agentId.trim()) ? agentId.trim() : 'global';
    let clock = this.#agentClocks.get(key);
    if (!clock) {
      clock = {
        totalSeconds: 0,
        date: 'Day 1',
        lastSync: Date.now()
      };
      this.#agentClocks.set(key, clock);
    }
    return clock;
  }

  /**
   * Helper to retrieve or lazily create an agent event partition.
   *
   * @param agentId - Partition key (defaults to `'global'`)
   * @returns Mutable internal event registry for the partition
   */
  #getOrCreatePartition(agentId = 'global'): Map<string, WorldEvent> {
    const key = (typeof agentId === 'string' && agentId.trim()) ? agentId.trim() : 'global';
    let partition = this.#agentEvents.get(key);
    if (!partition) {
      partition = new Map();
      this.#agentEvents.set(key, partition);
    }
    return partition;
  }

  /**
   * Helper to locate an event and its containing partition by ID across all
   * partitions.
   *
   * When a resolved caller scope is supplied (Wave I, ticket d57cbc1), a
   * partition inside that scope wins over an earlier partition outside it:
   * the same event id can legitimately exist in two Realms, and a realm-bound
   * caller must reach its own Realm's event without the foreign partition's
   * earlier insertion order shadowing it. A foreign-only match is still
   * returned so the scope gate keeps its existing denial semantics.
   *
   * @param eventId - Event identifier to locate
   * @param auth - Optional resolved caller scope for in-scope preference
   * @returns Located event with its partition and owner key, or null when absent
   */
  #findEvent(
    eventId: string,
    auth?: ResolvedCallerScope
  ): { event: WorldEvent; partition: Map<string, WorldEvent>; agentId: string } | null {
    if (!eventId) return null;
    const id = String(eventId).trim();
    const matches: Array<{ event: WorldEvent; partition: Map<string, WorldEvent>; agentId: string }> = [];
    for (const [agentId, partition] of this.#agentEvents.entries()) {
      const event = partition.get(id);
      if (event) {
        matches.push({ event, partition, agentId });
      }
    }
    if (matches.length === 0) return null;
    if (matches.length === 1 || !auth) return matches[0];
    const inScope = matches.find((match) => this.#isTargetInScope(auth, match.agentId));
    return inScope || matches[0];
  }

  /**
   * Retrieve refreshed partition events and update dynamic statuses.
   *
   * @param agentId - Partition key (defaults to `'global'`)
   * @returns Refreshed events visible to the partition (own plus merged global)
   */
  #getPartitionEvents(agentId = 'global'): WorldEvent[] {
    const key = (typeof agentId === 'string' && agentId.trim()) ? agentId.trim() : 'global';
    const map = new Map<string, WorldEvent>();

    const part = this.#agentEvents.get(key);
    if (part) {
      for (const [id, ev] of part.entries()) {
        map.set(id, ev);
      }
    }

    if (key !== 'global') {
      const globalPart = this.#agentEvents.get('global');
      if (globalPart) {
        for (const [id, ev] of globalPart.entries()) {
          map.set(id, ev);
        }
      }
    }

    const events = Array.from(map.values());
    for (const ev of events) {
      if (ev.status !== 'resolved' && ev.status !== 'cancelled') {
        const ownerClock = this.#getOrCreateClock(ev.ownerId || 'global');
        if (ev.triggerTime <= ownerClock.totalSeconds) {
          ev.status = 'active';
        } else {
          ev.status = 'pending';
        }
      }
    }

    return events;
  }

  /**
   * Build immutable TimeState representation for a partition.
   *
   * @param agentId - Partition key (defaults to `'global'`)
   * @returns Frozen immutable time-state projection for the partition
   */
  #buildTimeState(agentId = 'global'): TimeState {
    const key = (typeof agentId === 'string' && agentId.trim()) ? agentId.trim() : 'global';
    const clock = this.#getOrCreateClock(key);
    const formattedData = formatWorldTime(clock.totalSeconds);
    const partitionEvents = this.#getPartitionEvents(key);

    const activeEventsCount = partitionEvents.filter(ev => ev.status === 'active').length;
    const pendingEventsCount = partitionEvents.filter(ev => ev.status === 'pending').length;
    const resolvedEventsCount = partitionEvents.filter(ev => ev.status === 'resolved').length;

    return Object.freeze({
      agentId: this.#receiptLabel(key),
      totalSeconds: clock.totalSeconds,
      totalMinutes: Math.floor(clock.totalSeconds / 60),
      day: formattedData.day,
      hour: formattedData.hour,
      minute: formattedData.minute,
      second: formattedData.second,
      formatted: formattedData.formatted,
      shortFormatted: formattedData.shortFormatted,
      time_string: formattedData.formatted,
      date: clock.date,
      lastSync: clock.lastSync,
      activeEventsCount,
      pendingEventsCount,
      resolvedEventsCount
    });
  }

  /**
   * Queries current chronological world time and event metrics for an agent or global partition.
   *
   * - Normalizes string inputs: `clock.getTime('agent_scout')` normalizes to `{ agentId: 'agent_scout' }`; the target is honored only for privileged callers.
   * - If `params.all === true` and caller is privileged, returns {@link GetAllClocksResult} scoped to the caller's visible partitions.
   * - Target partition resolution order:
   *   1. Privileged callers: `params.targetAgentId` || `params.agentId` || the caller's own partition key (`context.callerKey` when supplied, else `context.callerAgentId`) || the caller's global key.
   *   2. Unprivileged callers: strictly the caller's own partition key || the caller's global key.
   * - The caller's own partition key is the runtime-supplied `context.callerKey` when one resolved (canonical Wave I keying), else the claimed bare id (Wave I, ticket d57cbc1).
   * - The caller's global key is `realm:<realmId>:global` for realm-bound callers and the shared `'global'` otherwise (Realm wave A0).
   * - A resolved target outside the caller's realm scope (a foreign-realm partition for a non-bypass caller) silently narrows to the caller's own partition: `getTime` has no failure branch, so denial means non-disclosure (V10 F-V10-1).
   *
   * @param params - Target partition options or partition identifier string.
   * @param context - Execution and security context of the invoking caller.
   * @returns Detailed {@link TimeState} projection or {@link GetAllClocksResult} if `all: true`.
   *
   * @example
   * ```typescript
   * const time = clock.getTime({}, { callerAgentId: 'agent_scout' }) as TimeState;
   * console.log(`Current time for scout: ${time.formatted} on ${time.date}`);
   * ```
   */
  getTime(
    params: GetTimeParams | string = {},
    context: ExecutionContext = {}
  ): TimeState | GetAllClocksResult {
    const p: GetTimeParams = (typeof params === 'string') ? { agentId: params } : (params || {});
    const auth = this.#extractAuth(context);

    if (p.all === true && auth.isPrivileged) {
      return {
        success: true,
        all: true,
        clocks: this.getAllClocks(context)
      };
    }

    const requestedKey = auth.isPrivileged
      ? this.#resolvePartitionKey(auth, p.targetAgentId || p.agentId || auth.callerPartitionKey || auth.globalKey)
      : this.#resolvePartitionKey(auth, auth.callerPartitionKey || auth.globalKey);
    // Out-of-scope targets (foreign realms for a non-bypass caller) silently
    // narrow instead of disclosing: getTime has no failure branch.
    const targetKey = this.#isTargetInScope(auth, requestedKey)
      ? requestedKey
      : this.#resolvePartitionKey(auth, auth.callerPartitionKey || auth.globalKey);

    return this.#buildTimeState(targetKey);
  }

  /**
   * Advances simulation time by specified offsets and triggers scheduled events.
   *
   * Calculation:
   * `Δsec = (hours * 3600) + (minutes * 60) + seconds + parseDelta(time)`
   *
   * Event Trigger Mechanics:
   * For each target partition, identifies events where `status === 'pending'` and `triggerTime <= newTotalSeconds`.
   * Mutates status to `'active'`, records `triggeredAtWorldTime = newTotalSeconds`, and emits them into `triggeredEvents`.
   *
   * Access Control:
   * - Unprivileged callers can only advance their own partition (keyed by the runtime-supplied `context.callerKey`, else `context.callerAgentId`).
   * - Advancing all partitions (`all: true`) or another agent (`targetAgentId` outside the caller's own partition) requires a privileged principal (`internalPrincipal` reference or `identityPort` descriptor with cross-partition scope); caller flags and reserved ids confer nothing.
   * - Realm binding (Realm wave A0): a realm-bound caller's literal `'global'` target is its realm-global partition, an `all: true` advance touches only the caller's realm scope, and the injected internal principal / `realmBypass` identities span every partition.
   * - Realm confinement (V10 F-V10-1): a single-target advance outside the caller's realm scope denies with `PERMISSION_DENIED` before any mutation, and an `all: true` advance enumerates only the caller's scope.
   *
   * Side Effects:
   * Synchronizes modified partition(s) to VirtualFS (`/{agentId}/world_clock.json` and `/{agentId}/event_list.json`; the realm-global workspace for realm-bound callers).
   *
   * @param params - Time advancement parameters (offsets in seconds, minutes, hours, or shorthand).
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with updated timestamps, delta metrics, and triggered events.
   *
   * @throws Never throws directly; returns `{ success: false, error, code: 'PERMISSION_DENIED' }`.
   *
   * @example
   * ```typescript
   * const result = clock.advanceClock(
   *   { minutes: 45 },
   *   { callerAgentId: 'guard_captain' }
   * );
   * if (result.success) {
   *   console.log(`Advanced to: ${result.currentFormatted}, triggered: ${result.triggeredCount}`);
   * } else {
   *   console.error(`Advance denied: ${result.code}`);
   * }
   * ```
   */
  advanceClock(
    params: AdvanceClockParams = {},
    context: ExecutionContext = {}
  ): AdvanceClockResult {
    const auth = this.#extractAuth(context);
    const { callerAgentId, callerPartitionKey, isPrivileged } = auth;

    if (params.all === true && !isPrivileged) {
      return {
        success: false,
        error: 'Permission denied: cannot advance clocks for all agents without administrator privileges',
        code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
      };
    }

    if (params.targetAgentId && params.targetAgentId !== callerAgentId && params.targetAgentId !== callerPartitionKey && !isPrivileged) {
      return {
        success: false,
        error: 'Permission denied: cannot advance clocks for other agents without administrator privileges',
        code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
      };
    }

    const min = Number(params.offsetMinutes !== undefined ? params.offsetMinutes : (params.minutes || 0)) || 0;
    const sec = Number(params.offsetSeconds !== undefined ? params.offsetSeconds : (params.seconds || 0)) || 0;
    const hrs = Number(params.offsetHours !== undefined ? params.offsetHours : (params.hours || 0)) || 0;
    const timeDelta = (params.time !== undefined && params.time !== null) ? parseTimeString(params.time) : 0;
    const deltaSec = Math.floor(sec + min * 60 + hrs * 3600 + timeDelta);

    // Advance the caller's scope when requested; the caller gate above already
    // established authority (or the engine ticker invoked the private path).
    // Realm-bound callers advance only their realm scope; the engine ticker and
    // realm-bypass/internal principals span every partition.
    if (params.all === true) {
      return this.#advanceAllPartitions(deltaSec, params, this.#scopedPartitionKeys(auth) ?? undefined);
    }

    // Single partition advancement
    const targetKey = isPrivileged
      ? this.#resolvePartitionKey(auth, params.targetAgentId ? params.targetAgentId.trim() : (callerPartitionKey || auth.globalKey))
      : this.#resolvePartitionKey(auth, callerPartitionKey || auth.globalKey);

    if (!this.#isTargetInScope(auth, targetKey)) {
      return this.#outOfScopeFailure(targetKey);
    }

    const clock = this.#getOrCreateClock(targetKey);
    const prevSeconds = clock.totalSeconds;
    const prevFormatted = formatWorldTime(prevSeconds);

    if (deltaSec < 0 && Math.abs(deltaSec) > clock.totalSeconds) {
      clock.totalSeconds = 0;
    } else {
      clock.totalSeconds = Math.max(0, clock.totalSeconds + deltaSec);
    }

    if (typeof params.date === 'string' && params.date.trim()) {
      clock.date = params.date.trim();
    }
    clock.lastSync = Date.now();

    const curFormatted = formatWorldTime(clock.totalSeconds);

    const triggeredEvents: WorldEvent[] = [];
    const partition = this.#agentEvents.get(targetKey);
    if (partition) {
      for (const event of partition.values()) {
        if (event.status !== 'resolved' && event.status !== 'cancelled') {
          const trigTime = event.triggerTime;
          if (trigTime <= clock.totalSeconds) {
            if (event.status === 'pending' || (trigTime > prevSeconds && trigTime <= clock.totalSeconds)) {
              event.status = 'active';
              event.triggeredAtWorldTime = clock.totalSeconds;
              triggeredEvents.push(this.#receiptEvent(event));
            }
          }
        }
      }
    }

    this.syncToVirtualFs(targetKey);

    const partitionEvents = this.#getPartitionEvents(targetKey);
    const activeEventsCount = partitionEvents.filter(ev => ev.status === 'active').length;
    const pendingEventsCount = partitionEvents.filter(ev => ev.status === 'pending').length;

    return {
      success: true,
      agentId: this.#receiptLabel(targetKey),
      previousSeconds: prevSeconds,
      previousFormatted: prevFormatted.formatted,
      currentSeconds: clock.totalSeconds,
      currentFormatted: curFormatted.formatted,
      shortFormatted: curFormatted.shortFormatted,
      advancedBySeconds: deltaSec,
      advancedByMinutes: parseFloat((deltaSec / 60).toFixed(2)),
      day: curFormatted.day,
      hour: curFormatted.hour,
      minute: curFormatted.minute,
      second: curFormatted.second,
      date: clock.date,
      triggeredEvents,
      triggeredCount: triggeredEvents.length,
      activeEventsCount,
      pendingEventsCount
    };
  }

  /**
   * Engine-internal all-partition advancement. This is the private authority
   * path used by the background ticker: it never consults caller flags or the
   * identity port, because it is not reachable from the public tool seam.
   *
   * @param deltaSec - Simulation seconds to add to every targeted partition
   * @param params - Optional `date` string applied to every targeted partition
   * @param keys - Explicit partition keys to advance (realm-scoped caller);
   *   omitted advances every partition (engine ticker / realm-bypass principal).
   *   The first key is the primary partition whose state feeds the top-level result.
   * @returns AdvanceClockResult with `all: true`
   */
  #advanceAllPartitions(deltaSec: number, params: AdvanceClockParams = {}, keys?: readonly string[]): AdvanceClockSuccess {
    const allTriggered: WorldEvent[] = [];
    const updatedClocks: Record<string, TimeState> = {};
    const primaryKey = keys && keys.length > 0 ? keys[0] : 'global';

    this.#getOrCreateClock(primaryKey);
    const targets = keys && keys.length > 0 ? keys : [...this.#agentClocks.keys()];

    for (const agentKey of targets) {
      const clock = this.#getOrCreateClock(agentKey);
      const prevSec = clock.totalSeconds;
      if (deltaSec < 0 && Math.abs(deltaSec) > clock.totalSeconds) {
        clock.totalSeconds = 0;
      } else {
        clock.totalSeconds = Math.max(0, clock.totalSeconds + deltaSec);
      }
      if (typeof params.date === 'string' && params.date.trim()) {
        clock.date = params.date.trim();
      }
      clock.lastSync = Date.now();

      const partition = this.#agentEvents.get(agentKey);
      if (partition) {
        for (const event of partition.values()) {
          if (event.status !== 'resolved' && event.status !== 'cancelled') {
            const trigTime = event.triggerTime;
            if (trigTime <= clock.totalSeconds) {
              if (event.status === 'pending' || (trigTime > prevSec && trigTime <= clock.totalSeconds)) {
                event.status = 'active';
                event.triggeredAtWorldTime = clock.totalSeconds;
                allTriggered.push(this.#receiptEvent(event));
              }
            }
          }
        }
      }
      this.syncToVirtualFs(agentKey);
      updatedClocks[agentKey] = this.#buildTimeState(agentKey);
    }

    const primaryClock = this.#getOrCreateClock(primaryKey);
    const curFormatted = formatWorldTime(primaryClock.totalSeconds);

    return {
      success: true,
      all: true,
      currentSeconds: primaryClock.totalSeconds,
      currentFormatted: curFormatted.formatted,
      shortFormatted: curFormatted.shortFormatted,
      advancedBySeconds: deltaSec,
      advancedByMinutes: parseFloat((deltaSec / 60).toFixed(2)),
      day: curFormatted.day,
      hour: curFormatted.hour,
      minute: curFormatted.minute,
      second: curFormatted.second,
      date: primaryClock.date,
      triggeredEvents: allTriggered,
      triggeredCount: allTriggered.length,
      clocks: updatedClocks
    };
  }

  /**
   * Sets absolute simulation time and/or narrative date string for a partition.
   *
   * Event State Recalculation:
   * - Pending events with `triggerTime <= newSeconds` transition to `'active'`.
   * - Active events with `triggerTime > newSeconds` revert to `'pending'`.
   * - Resolved and cancelled events remain immutable.
   *
   * Access Control:
   * Setting another agent's partition or global timeline requires a privileged principal resolved from the injected identity port or the injected internal principal; caller-asserted flags are ignored.
   * Realm confinement (V10 F-V10-1): a resolved target outside the caller's realm scope (a foreign-realm partition for any non-bypass caller) denies with `PERMISSION_DENIED` before any mutation; `realmBypass` principals and context-free engine calls span every partition.
   *
   * Side Effects:
   * Writes updated state to VirtualFS.
   *
   * @param params - Absolute time parameters (`time` string/number, discrete `hour`/`minute`/`second`, `date`).
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with updated time and active/pending event counts.
   *
   * @throws Never throws directly; returns `{ success: false, error, code: 'PERMISSION_DENIED' }` on unauthorized access.
   *
   * @example
   * ```typescript
   * const result = clock.setTime(
   *   { time: '14:30:00', date: 'Day 2' },
   *   { callerAgentId: 'operator' }
   * );
   * if (result.success) {
   *   console.log(`Time set to: ${result.currentFormatted} on ${result.date}`);
   * } else {
   *   console.error(`Set denied: ${result.code}`);
   * }
   * ```
   */
  setTime(
    params: SetTimeParams = {},
    context: ExecutionContext = {}
  ): SetTimeResult {
    const auth = this.#extractAuth(context);
    const { callerAgentId, callerPartitionKey, isPrivileged } = auth;

    if (params.targetAgentId && params.targetAgentId !== callerAgentId && params.targetAgentId !== callerPartitionKey && !isPrivileged) {
      return {
        success: false,
        error: 'Permission denied: cannot set clock for another agent without administrator privileges',
        code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
      };
    }

    const targetKey = isPrivileged
      ? this.#resolvePartitionKey(auth, params.targetAgentId ? params.targetAgentId.trim() : (callerPartitionKey || auth.globalKey))
      : this.#resolvePartitionKey(auth, callerPartitionKey || auth.globalKey);

    if (!this.#isTargetInScope(auth, targetKey)) {
      return this.#outOfScopeFailure(targetKey);
    }

    const clock = this.#getOrCreateClock(targetKey);
    const prevSeconds = clock.totalSeconds;

    const rawTime = params.setTime !== undefined
      ? params.setTime
      : (params.time !== undefined ? params.time : params.totalSeconds);

    if (rawTime !== undefined && rawTime !== null) {
      clock.totalSeconds = parseTimeString(rawTime);
    } else if (params.hour !== undefined || params.minute !== undefined || params.second !== undefined) {
      const current = formatWorldTime(clock.totalSeconds);
      const h = params.hour !== undefined ? Math.max(0, Math.min(23, Number(params.hour) || 0)) : current.hour;
      const m = params.minute !== undefined ? Math.max(0, Math.min(59, Number(params.minute) || 0)) : current.minute;
      const s = params.second !== undefined ? Math.max(0, Math.min(59, Number(params.second) || 0)) : current.second;
      const d = current.day - 1;
      clock.totalSeconds = d * 86400 + h * 3600 + m * 60 + s;
    }

    if (typeof params.date === 'string' && params.date.trim()) {
      clock.date = params.date.trim();
    }
    clock.lastSync = Date.now();

    const partition = this.#agentEvents.get(targetKey);
    if (partition) {
      for (const event of partition.values()) {
        if (event.status !== 'resolved' && event.status !== 'cancelled') {
          if (event.triggerTime <= clock.totalSeconds) {
            event.status = 'active';
          } else {
            event.status = 'pending';
          }
        }
      }
    }

    this.syncToVirtualFs(targetKey);

    const formattedData = formatWorldTime(clock.totalSeconds);
    const partitionEvents = this.#getPartitionEvents(targetKey);

    return {
      success: true,
      agentId: this.#receiptLabel(targetKey),
      previousSeconds: prevSeconds,
      currentSeconds: clock.totalSeconds,
      currentFormatted: formattedData.formatted,
      shortFormatted: formattedData.shortFormatted,
      day: formattedData.day,
      hour: formattedData.hour,
      minute: formattedData.minute,
      second: formattedData.second,
      date: clock.date,
      activeEventsCount: partitionEvents.filter(ev => ev.status === 'active').length,
      pendingEventsCount: partitionEvents.filter(ev => ev.status === 'pending').length
    };
  }

  /**
   * Resets simulation clock to epoch (0 seconds, 'Day 1', '00:00:00').
   *
   * Access Control:
   * - Unprivileged callers can strictly reset their own partition.
   * - Resetting all partitions (`all: true`) or another agent requires privileged context.
   * - Realm confinement (V10 F-V10-1): the `all: true` path resets only the caller's realm scope, and a single-target reset outside that scope denies with `PERMISSION_DENIED` before any mutation; only `realmBypass` principals and context-free engine calls span every partition.
   *
   * Side Effects:
   * Sets `totalSeconds = 0`, `date = 'Day 1'`, recalculates event statuses, and updates VirtualFS.
   *
   * @param params - Reset options (`targetAgentId`, `all`, `syncFs`) or partition ID string / `'all'`.
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with reset confirmation and zeroed time state.
   *
   * @throws Never throws directly; returns `{ success: false, error, code: 'PERMISSION_DENIED' }` on violation.
   *
   * @example
   * ```typescript
   * const result = clock.resetClock(
   *   { targetAgentId: 'agent_scout' },
   *   { callerAgentId: 'agent_scout' }
   * );
   * if (result.success) {
   *   console.log(`Reset formatted: ${result.formatted}`);
   * } else {
   *   console.error(`Reset denied: ${result.code}`);
   * }
   * ```
   */
  resetClock(
    params: ResetClockParams | string = {},
    context: ExecutionContext = {}
  ): ResetClockResult {
    const p: ResetClockParams = (typeof params === 'string') ? { targetAgentId: params } : (params || {});
    const auth = this.#extractAuth(context);
    const { callerAgentId, callerPartitionKey, isPrivileged } = auth;

    const isAll = p.all === true || p.targetAgentId === 'all';
    const target = p.targetAgentId;

    if (isAll || (target && target !== callerAgentId && target !== callerPartitionKey)) {
      if (!isPrivileged) {
        return {
          success: false,
          error: 'Permission denied: cannot reset clocks for all or other agents without administrator privileges',
          code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
        };
      }
    }

    const shouldWriteToFs = p.syncFs !== false && p.writeToFs !== false;

    if (isAll) {
      const resetClocks: Record<string, TimeState> = {};
      // Realm-bound callers reset only their realm scope; realm-bypass
      // principals and the engine reset every partition.
      const allKeys = this.#scopedPartitionKeys(auth) ?? [...this.#agentClocks.keys()];
      for (const agentKey of allKeys) {
        const clock = this.#getOrCreateClock(agentKey);
        clock.totalSeconds = 0;
        clock.date = 'Day 1';
        clock.lastSync = Date.now();

        const partition = this.#agentEvents.get(agentKey);
        if (partition) {
          for (const event of partition.values()) {
            if (event.status !== 'resolved' && event.status !== 'cancelled') {
              event.status = event.triggerTime <= 0 ? 'active' : 'pending';
            }
          }
        }

        if (shouldWriteToFs) {
          this.syncToVirtualFs(agentKey);
        }
        resetClocks[agentKey] = this.#buildTimeState(agentKey);
      }

      const formattedData = formatWorldTime(0);
      return {
        success: true,
        all: true,
        totalSeconds: 0,
        currentSeconds: 0,
        formatted: formattedData.formatted,
        shortFormatted: formattedData.shortFormatted,
        currentFormatted: formattedData.formatted,
        day: 1,
        hour: 0,
        minute: 0,
        second: 0,
        date: 'Day 1',
        clocks: resetClocks
      };
    }

    const effectiveTarget = this.#resolvePartitionKey(
      auth,
      (isPrivileged ? (target || callerPartitionKey) : callerPartitionKey) || auth.globalKey
    );

    if (!this.#isTargetInScope(auth, effectiveTarget)) {
      return this.#outOfScopeFailure(effectiveTarget);
    }

    const clock = this.#getOrCreateClock(effectiveTarget);
    const prevSeconds = clock.totalSeconds;
    clock.totalSeconds = 0;
    clock.date = 'Day 1';
    clock.lastSync = Date.now();

    const partition = this.#agentEvents.get(effectiveTarget);
    if (partition) {
      for (const event of partition.values()) {
        if (event.status !== 'resolved' && event.status !== 'cancelled') {
          event.status = event.triggerTime <= 0 ? 'active' : 'pending';
        }
      }
    }

    if (shouldWriteToFs) {
      this.syncToVirtualFs(effectiveTarget);
    }

    const formattedData = formatWorldTime(0);
    const partitionEvents = this.#getPartitionEvents(effectiveTarget);

    return {
      success: true,
      agentId: this.#receiptLabel(effectiveTarget),
      previousSeconds: prevSeconds,
      totalSeconds: 0,
      currentSeconds: 0,
      formatted: formattedData.formatted,
      shortFormatted: formattedData.shortFormatted,
      currentFormatted: formattedData.formatted,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      date: 'Day 1',
      activeEventsCount: partitionEvents.filter(ev => ev.status === 'active').length,
      pendingEventsCount: partitionEvents.filter(ev => ev.status === 'pending').length
    };
  }

  /**
   * Administrative inspection method returning current time states for all active partitions.
   *
   * Access Control:
   * - Ungrouped privileged callers receive every legacy partition, never a `realm:`-prefixed one (V10 F-V10-1).
   * - Ungrouped unprivileged callers receive only their own partition and `'global'`.
   * - Realm-bound callers are scoped to their realm (Realm wave A0): their
   *   realm-global key plus their own partition, plus same-realm member
   *   partitions when privileged (membership resolves through the injected
   *   identity port's realm listing, Wave I ticket d57cbc1). Other realms are
   *   never enumerated; the injected internal principal / `realmBypass`
   *   identities span every partition.
   *
   * The returned map is keyed by the internal partition key it addresses,
   * while each {@link TimeState} value projects the registration's bare `id`;
   * the agent-visible tool adapter labels canonical keys and the realm-global
   * key for the agent surface.
   *
   * @param context - Execution and security context of the invoking caller.
   * @returns Record mapping partition IDs to their respective {@link TimeState} objects.
   *
   * @example
   * ```typescript
   * const clocks = clock.getAllClocks({ callerAgentId: 'operator' });
   * Object.entries(clocks).forEach(([agentId, state]) => {
   *   console.log(`${agentId}: ${state.formatted}`);
   * });
   * ```
   */
  getAllClocks(context: ExecutionContext = {}): Record<string, TimeState> {
    const auth = this.#extractAuth(context);
    const result: Record<string, TimeState> = {};
    const scoped = this.#scopedPartitionKeys(auth);

    if (scoped) {
      for (const key of scoped) {
        result[key] = this.#buildTimeState(key);
      }
    } else if (auth.isPrivileged) {
      this.#getOrCreateClock('global');
      for (const key of this.#agentClocks.keys()) {
        result[key] = this.#buildTimeState(key);
      }
    } else {
      result[auth.globalKey] = this.#buildTimeState(auth.globalKey);
      if (auth.callerPartitionKey && auth.callerPartitionKey !== auth.globalKey) {
        result[auth.callerPartitionKey] = this.#buildTimeState(auth.callerPartitionKey);
      }
    }
    return result;
  }

  /**
   * Registers an in-universe narrative simulation event synchronized with world time.
   *
   * Trigger Time Calculation:
   * - Relative offset (`offsetMinutes`, `trigger_minutes`, `offsetSeconds`):
   *   `triggerTime = ownerClock.totalSeconds + (offsetMinutes * 60) + offsetSeconds`
   * - Absolute `triggerTime`: Parsed from numeric seconds or `"HH:MM:SS"` string.
   * - Default: Immediate execution at `ownerClock.totalSeconds`.
   *
   * Initial Status:
   * - If `triggerTime <= ownerClock.totalSeconds` -\> `'active'`.
   * - If `triggerTime > ownerClock.totalSeconds` -\> `'pending'`.
   *
   * Access Control:
   * - Unprivileged callers own their event (`ownerId` = the caller's own partition key, `scope = 'agent'`).
   * - Creating `scope = 'global'` or setting `public = true` requires privileged context.
   * - Realm-bound privileged callers create realm-global events in `realm:<realmId>:global`; a literal `'global'` target resolves to that realm key (Realm wave A0).
   * - Realm confinement (V10 F-V10-1): a resolved owner partition outside the caller's realm scope denies with `PERMISSION_DENIED` before any registration; only `realmBypass` principals and context-free engine calls span every partition.
   *
   * Side Effects:
   * Stores event in partition and synchronizes to `/{ownerId}/event_list.json` (the realm-global workspace for a realm-bound caller).
   *
   * @param params - Event registration configuration (name, trigger offset, category, priority, recurrence).
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with the registered {@link WorldEvent}.
   *
   * @throws Never throws directly; returns `{ success: false, error, code: 'INVALID_ARGUMENTS' | 'PERMISSION_DENIED' }`.
   *
   * @example
   * ```typescript
   * const res = clock.registerEvent({
   *   name: 'Guard Patrol Shift',
   *   description: 'Relieve guards at the north gate.',
   *   offsetMinutes: 30,
   *   category: 'security'
   * }, { callerAgentId: 'guard_captain' });
   * console.log(`Registered event ID: ${res.event?.id}, status: ${res.event?.status}`);
   * ```
   */
  registerEvent(params: RegisterEventParams = {}, context: ExecutionContext = {}): RegisterEventResult {
    if (!params || typeof params !== 'object') {
      return { success: false, error: 'Event data must be an object', code: WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS };
    }

    const name = (params.name || params.title || params.description || '').trim();
    if (!name) {
      return { success: false, error: "Missing required field 'name' or 'description' for event", code: WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS };
    }

    const eventId = (params.id || params.eventId || generateEventId()).trim();
    const auth = this.#extractAuth(context);
    const { callerAgentId, callerPartitionKey, isPrivileged } = auth;

    if (!isPrivileged && params.targetAgentId && params.targetAgentId !== callerAgentId && params.targetAgentId !== callerPartitionKey) {
      return { success: false, error: 'Permission denied: cannot register event for another agent', code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED };
    }

    const effectiveOwner = isPrivileged
      ? this.#resolvePartitionKey(auth, params.targetAgentId
          ? params.targetAgentId.trim()
          : (params.scope === 'global' || params.public ? auth.globalKey : callerPartitionKey))
      : this.#resolvePartitionKey(auth, callerPartitionKey || auth.globalKey);

    if (!this.#isTargetInScope(auth, effectiveOwner)) {
      return this.#outOfScopeFailure(effectiveOwner);
    }

    const isGlobalScope = Boolean(isPrivileged && (params.scope === 'global' || params.public || effectiveOwner === auth.globalKey));

    const ownerClock = this.#getOrCreateClock(effectiveOwner);

    let triggerTime;
    const relMin = params.offsetMinutes !== undefined
      ? params.offsetMinutes
      : (params.trigger_minutes !== undefined ? params.trigger_minutes : params.inMinutes);
    const relSec = params.offsetSeconds !== undefined
      ? params.offsetSeconds
      : params.inSeconds;

    if (relMin !== undefined || relSec !== undefined) {
      const deltaSec = (Number(relMin) || 0) * 60 + (Number(relSec) || 0);
      triggerTime = Math.max(0, ownerClock.totalSeconds + deltaSec);
    } else if (params.triggerTime !== undefined && params.triggerTime !== null) {
      triggerTime = parseTimeString(params.triggerTime);
    } else {
      triggerTime = ownerClock.totalSeconds;
    }

    const triggerFormatted = formatWorldTime(triggerTime);
    const isNowActive = triggerTime <= ownerClock.totalSeconds;

    const eventObj: WorldEvent = {
      id: eventId,
      name,
      description: params.description ? String(params.description).trim() : name,
      triggerTime,
      triggerFormatted: triggerFormatted.formatted,
      category: params.category || params.type || 'narrative',
      priority: params.priority || 'normal',
      status: isNowActive ? 'active' : 'pending',
      scope: isGlobalScope ? 'global' : 'agent',
      public: isGlobalScope,
      ownerId: effectiveOwner,
      createdBy: callerAgentId || 'global',
      createdAtWorldTime: ownerClock.totalSeconds,
      createdAtRealTime: Date.now(),
      metadata: params.metadata && typeof params.metadata === 'object' ? { ...params.metadata } : {},
      repeatMinutes: typeof params.repeatMinutes === 'number' ? params.repeatMinutes : null,
      repeatSeconds: typeof params.repeatSeconds === 'number' ? params.repeatSeconds : null,
      resolvedAt: null,
      resolvedAtFormatted: null,
      resolvedBy: null,
      resolutionNote: null,
      cancelledAt: null,
      cancelledBy: null,
      cancellationReason: null
    };

    const partition = this.#getOrCreatePartition(effectiveOwner);
    partition.set(eventId, eventObj);
    this.syncToVirtualFs(effectiveOwner);

    return {
      success: true,
      event: this.#receiptEvent(eventObj)
    };
  }

  /**
   * Queries registered events across partitions with filter criteria.
   *
   * Partition Scoping:
   * - Unprivileged callers: Restricted strictly to the caller's own partition (keyed by the runtime-supplied `context.callerKey`, else `context.callerAgentId`) + public events of the caller's global key (`'global'`, or `realm:<realmId>:global` for realm-bound callers).
   * - Privileged callers: Can specify `all: true` to query every partition in their scope or `targetAgentId` for a specific agent. Realm-bound callers never enumerate other realms (Realm wave A0), and ungrouped callers never enumerate `realm:`-prefixed partitions (V10 F-V10-1).
   * - An explicit `targetAgentId` outside the caller's realm scope silently narrows to the caller's own scope: `queryEvents` has no failure branch, so denial means non-disclosure (V10 F-V10-1).
   * - The `all: true` listing merges partitions by partition-qualified event key (Wave I, ticket d57cbc1), so the same event id existing in two realms is listed once per realm instead of collapsing.
   *
   * Filtering Capabilities:
   * - `status`: `'active' | 'pending' | 'resolved' | 'cancelled' | 'all'`.
   * - `category`: Exact match on category.
   * - `priority`: Exact match on priority level.
   * - `search`: Case-insensitive substring match against `name` and `description`.
   * - `eventId`: Query single event by ID.
   *
   * Status Refresh:
   * Dynamically refreshes event statuses against current partition clocks before filtering.
   *
   * @param params - Filter criteria and query options.
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with matching events, count, and partition metrics.
   *
   * @throws Never throws; unauthorized scopes are silently narrowed to the caller-visible events and `{ success: true }` is returned.
   *
   * @example
   * ```typescript
   * const queryRes = clock.queryEvents(
   *   { status: 'active', category: 'security' },
   *   { callerAgentId: 'guard_captain' }
   * );
   * console.log(`Active security events: ${queryRes.count}`);
   * ```
   */
  queryEvents(
    params: QueryEventsParams = {},
    context: ExecutionContext = {}
  ): QueryEventsResult {
    const activeOnly = params.activeOnly === true || params.status === 'active';
    const statusFilter = params.status || (activeOnly ? 'active' : null);
    const categoryFilter = params.category || (params as QueryEventsCompatParams).type;
    const priorityFilter = params.priority;
    const searchFilter = params.search || params.query;
    const specificId = params.eventId || params.id;

    const auth = this.#extractAuth(context);
    const { callerPartitionKey, isPrivileged, globalKey } = auth;
    const candidateMap = new Map();
    // Realm-bound callers read their realm-global partition (Realm wave A0);
    // ungrouped callers keep the legacy shared `'global'` partition.
    const scoped = this.#scopedPartitionKeys(auth);

    if (isPrivileged) {
      if (params.all === true) {
        const keys = scoped ?? [...this.#agentEvents.keys()];
        for (const key of keys) {
          const partition = this.#agentEvents.get(key);
          if (!partition) continue;
          for (const [id, ev] of partition.entries()) {
            // Partition-qualified key (Wave I, ticket d57cbc1): after realm-local
            // ids, the same event id may legally exist in two realms, and an
            // all-partition listing must not collapse one realm's event onto
            // the other's.
            candidateMap.set(`${key}\u0000${id}`, ev);
          }
        }
      } else {
        const requestedTarget = this.#resolvePartitionKey(
          auth,
          params.targetAgentId || (params as QueryEventsCompatParams).agentId || callerPartitionKey || globalKey
        );
        // An explicit out-of-scope target (a foreign-realm partition for a
        // non-bypass caller) silently narrows to the caller's own scope:
        // queryEvents has no failure branch (V10 F-V10-1).
        const target = this.#isTargetInScope(auth, requestedTarget)
          ? requestedTarget
          : this.#resolvePartitionKey(auth, callerPartitionKey || globalKey);
        const targetPart = this.#agentEvents.get(target);
        if (targetPart) {
          for (const [id, ev] of targetPart.entries()) {
            candidateMap.set(id, ev);
          }
        }
        // Merge the caller's global partition for same-scope targets; an
        // explicit out-of-scope target was narrowed above instead of widened.
        if (target !== globalKey) {
          const globalPart = this.#agentEvents.get(globalKey);
          if (globalPart) {
            for (const [id, ev] of globalPart.entries()) {
              candidateMap.set(id, ev);
            }
          }
        }
      }
    } else {
      const effectiveCaller = callerPartitionKey || globalKey;
      const callerPart = this.#agentEvents.get(effectiveCaller);
      if (callerPart) {
        for (const [id, ev] of callerPart.entries()) {
          candidateMap.set(id, ev);
        }
      }
      if (effectiveCaller !== globalKey) {
        const globalPart = this.#agentEvents.get(globalKey);
        if (globalPart) {
          for (const [id, ev] of globalPart.entries()) {
            if (ev.public || ev.scope === 'global' || ev.ownerId === globalKey) {
              candidateMap.set(id, ev);
            }
          }
        }
      }
    }

    const allEvents = Array.from(candidateMap.values());
    const requestedClockTarget = isPrivileged
      ? this.#resolvePartitionKey(auth, params.targetAgentId || callerPartitionKey || globalKey)
      : this.#resolvePartitionKey(auth, callerPartitionKey || globalKey);
    const effectiveClockTarget = this.#isTargetInScope(auth, requestedClockTarget)
      ? requestedClockTarget
      : this.#resolvePartitionKey(auth, callerPartitionKey || globalKey);
    const clockInfo = this.#buildTimeState(effectiveClockTarget);

    for (const ev of allEvents) {
      if (ev.status !== 'resolved' && ev.status !== 'cancelled') {
        const ownerClock = this.#getOrCreateClock(ev.ownerId || 'global');
        if (ev.triggerTime <= ownerClock.totalSeconds) {
          ev.status = 'active';
        } else {
          ev.status = 'pending';
        }
      }
    }

    const filtered = allEvents.filter(ev => {
      if (specificId && ev.id !== specificId) return false;
      if (statusFilter && statusFilter !== 'all') {
        if (ev.status !== statusFilter) return false;
      }
      if (categoryFilter && ev.category !== categoryFilter) return false;
      if (priorityFilter && ev.priority !== priorityFilter) return false;
      if (searchFilter) {
        const text = `${ev.name} ${ev.description}`.toLowerCase();
        if (!text.includes(String(searchFilter).toLowerCase())) return false;
      }
      return true;
    });

    const events = filtered.map(ev => this.#receiptEvent(ev));
    const activeEvents = events.filter(ev => ev.status === 'active');
    const activeCount = allEvents.filter(ev => ev.status === 'active').length;
    const pendingCount = allEvents.filter(ev => ev.status === 'pending').length;
    const resolvedCount = allEvents.filter(ev => ev.status === 'resolved').length;

    return {
      success: true,
      clock: clockInfo,
      count: events.length,
      events,
      activeEvents,
      activeCount,
      pendingCount,
      resolvedCount
    };
  }

  /**
   * Marks an event as resolved upon task or narrative beat completion.
   *
   * Recurrence Automation:
   * If the event has `repeatMinutes` or `repeatSeconds` (\> 0), automatically schedules the next occurrence:
   * `nextTrigger = ownerClock.totalSeconds + (repeatMinutes * 60) + repeatSeconds`
   * Spawns new event with status `'pending'` and returns it in `nextEvent`.
   *
   * Terminal-State Guard:
   * Already `'resolved'` or `'cancelled'` events are rejected with `INVALID_ARGUMENTS` before any mutation,
   * so a terminal event can never be re-resolved or spawn a second recurrence.
   *
   * Access Control:
   * Caller must be the event owner, creator, a privileged principal (identity-port descriptor or injected internal principal), or the event must be global-owned.
   *
   * Realm confinement (V10 F-V10-1): an event in a partition outside the
   * caller's realm scope denies with `PERMISSION_DENIED` before any mutation;
   * only `realmBypass` principals and context-free engine calls reach every partition.
   *
   * Side Effects:
   * Updates status to `'resolved'`, stamps `resolvedAt` and `resolvedBy`, and mirrors to VirtualFS.
   * Returned `event`/`nextEvent` are defensive copies; `nextEvent` never inherits a stale `triggeredAtWorldTime`.
   *
   * @param params - Resolution parameters (`eventId`, `resolutionNote`) or event ID string.
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with resolved event and optional next recurring event instance.
   *
   * @throws Never throws directly; returns `{ success: false, error, code: 'INVALID_ARGUMENTS' | 'EVENT_NOT_FOUND' | 'PERMISSION_DENIED' }`.
   *
   * @example
   * ```typescript
   * const res = clock.resolveEvent({
   *   eventId: 'evt_patrol_123',
   *   resolutionNote: 'Patrol shift completed safely.'
   * }, { callerAgentId: 'guard_captain' });
   * if (res.nextEvent) {
   *   console.log(`Next patrol scheduled at: ${res.nextEvent.triggerFormatted}`);
   * }
   * ```
   */
  resolveEvent(
    params: ResolveEventParams | string,
    context: ExecutionContext = {}
  ): ResolveEventResult {
    let id = '';
    let resolutionNote = 'Marked resolved by agent';

    if (typeof params === 'object' && params !== null) {
      id = String(params.eventId || params.id || params.event_id || '').trim();
      resolutionNote = params.resolutionNote || params.resolution || params.note || resolutionNote;
    } else if (typeof params === 'string') {
      id = params.trim();
    }

    if (!id) {
      return { success: false, error: "Missing required argument 'eventId' for resolveEvent", code: WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS };
    }

    const auth = this.#extractAuth(context);
    // Scope-aware lookup (Wave I, ticket d57cbc1): the same event id may exist
    // in two Realms, so an in-scope partition wins over earlier foreign
    // insertion order; a foreign-only match keeps the existing denial path.
    const found = this.#findEvent(id, auth);
    if (!found) {
      return { success: false, error: `Event '${id}' not found in registry`, code: WORLD_CLOCK_ERROR_CODES.EVENT_NOT_FOUND };
    }

    const { event, partition, agentId: ownerPartitionKey } = found;

    // Realm confinement (V10 F-V10-1): an event owned by a partition outside
    // the caller's realm scope is unreachable even for a privileged caller.
    if (!this.#isTargetInScope(auth, ownerPartitionKey)) {
      return this.#outOfScopeFailure(ownerPartitionKey);
    }
    const { callerAgentId, callerPartitionKey, isPrivileged, globalKey } = auth;
    const isOwner = event.ownerId === callerAgentId
      || event.ownerId === callerPartitionKey
      || event.createdBy === callerAgentId
      || event.createdBy === callerPartitionKey
      || event.ownerId === globalKey;

    if (!isPrivileged && !isOwner) {
      return {
        success: false,
        error: "Permission denied: cannot modify another agent's event",
        code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
      };
    }

    if (event.status === 'resolved' || event.status === 'cancelled') {
      return {
        success: false,
        error: `Event '${event.id}' is already ${event.status}`,
        code: WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS
      };
    }

    const ownerClock = this.#getOrCreateClock(ownerPartitionKey);

    event.status = 'resolved';
    event.resolvedAt = ownerClock.totalSeconds;
    event.resolvedAtFormatted = formatWorldTime(ownerClock.totalSeconds).formatted;
    event.resolvedBy = callerAgentId || 'global';
    event.resolutionNote = resolutionNote;

    let nextEvent: WorldEvent | null = null;
    if (event.repeatMinutes || event.repeatSeconds) {
      const repeatDelta = (Number(event.repeatMinutes) || 0) * 60 + (Number(event.repeatSeconds) || 0);
      if (repeatDelta > 0) {
        const nextId = generateEventId(event.id.split('_')[0] || 'evt');
        const nextTrigger = ownerClock.totalSeconds + repeatDelta;
        nextEvent = {
          ...event,
          id: nextId,
          triggerTime: nextTrigger,
          triggerFormatted: formatWorldTime(nextTrigger).formatted,
          status: 'pending',
          resolvedAt: null,
          resolvedAtFormatted: null,
          resolvedBy: null,
          resolutionNote: null,
          cancelledAt: null,
          cancelledBy: null,
          cancellationReason: null
        };
        delete nextEvent.triggeredAtWorldTime;
        partition.set(nextId, nextEvent);
      }
    }

    this.syncToVirtualFs(ownerPartitionKey);

    return {
      success: true,
      resolved: true,
      event: this.#receiptEvent(event),
      nextEvent: nextEvent ? this.#receiptEvent(nextEvent) : null
    };
  }

  /**
   * Cancels an event without resolving or triggering recurring occurrences.
   *
   * Access Control:
   * Requires event owner, creator, privileged-principal authorization, or a global-owned event.
   *
   * Realm confinement (V10 F-V10-1): an event in a partition outside the
   * caller's realm scope denies with `PERMISSION_DENIED` before any mutation;
   * only `realmBypass` principals and context-free engine calls reach every partition.
   *
   * Side Effects:
   * Sets `status = 'cancelled'`, records `cancelledAt` and `cancellationReason`. Syncs to VirtualFS.
   *
   * @param params - Cancellation parameters (`eventId`, `reason`) or event ID string.
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with cancelled event confirmation.
   *
   * @throws Never throws directly; returns `{ success: false, error, code: 'INVALID_ARGUMENTS' | 'EVENT_NOT_FOUND' | 'PERMISSION_DENIED' }`.
   *
   * @example
   * ```typescript
   * const res = clock.cancelEvent({
   *   eventId: 'evt_patrol_123',
   *   reason: 'Shift cancelled due to weather.'
   * }, { callerAgentId: 'guard_captain' });
   * console.log(`Cancelled: ${res.cancelled}`);
   * ```
   */
  cancelEvent(
    params: CancelEventParams | string,
    context: ExecutionContext = {}
  ): CancelEventResult {
    let id = '';
    let effectiveReason = 'Cancelled';

    if (typeof params === 'object' && params !== null) {
      id = String(params.eventId || params.id || params.event_id || '').trim();
      effectiveReason = params.reason || params.cancellationReason || params.description || effectiveReason;
    } else if (typeof params === 'string') {
      id = params.trim();
    }

    if (!id) {
      return { success: false, error: "Missing required argument 'eventId' for cancelEvent", code: WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS };
    }

    const auth = this.#extractAuth(context);
    // Scope-aware lookup (Wave I, ticket d57cbc1): an in-scope partition wins
    // over earlier foreign insertion order for a duplicated event id.
    const found = this.#findEvent(id, auth);
    if (!found) {
      return { success: false, error: `Event '${id}' not found`, code: WORLD_CLOCK_ERROR_CODES.EVENT_NOT_FOUND };
    }

    const { event, agentId: ownerPartitionKey } = found;

    // Realm confinement (V10 F-V10-1): an event owned by a partition outside
    // the caller's realm scope is unreachable even for a privileged caller.
    if (!this.#isTargetInScope(auth, ownerPartitionKey)) {
      return this.#outOfScopeFailure(ownerPartitionKey);
    }
    const { callerAgentId, callerPartitionKey, isPrivileged, globalKey } = auth;
    const isOwner = event.ownerId === callerAgentId
      || event.ownerId === callerPartitionKey
      || event.createdBy === callerAgentId
      || event.createdBy === callerPartitionKey
      || event.ownerId === globalKey;

    if (!isPrivileged && !isOwner) {
      return {
        success: false,
        error: "Permission denied: cannot modify another agent's event",
        code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
      };
    }

    const ownerClock = this.#getOrCreateClock(ownerPartitionKey);

    event.status = 'cancelled';
    event.cancelledAt = ownerClock.totalSeconds;
    event.cancelledBy = callerAgentId || 'global';
    event.cancellationReason = effectiveReason;

    this.syncToVirtualFs(ownerPartitionKey);
    return { success: true, cancelled: true, event: this.#receiptEvent(event) };
  }

  /**
   * Updates mutable fields (`name`, `description`, `priority`, `category`, `metadata`) of an existing event.
   *
   * Access Control:
   * Requires event owner, creator, privileged authorization, or a global-owned event.
   *
   * Realm confinement (V10 F-V10-1): an event in a partition outside the
   * caller's realm scope denies with `PERMISSION_DENIED` before any mutation;
   * only `realmBypass` principals and context-free engine calls reach every partition.
   *
   * Side Effects:
   * Mutates event in place and synchronizes changes to VirtualFS.
   *
   * @param params - Event update payload (`eventId` and fields to modify).
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with updated event confirmation.
   *
   * @throws Never throws directly; returns `{ success: false, error, code: 'INVALID_ARGUMENTS' | 'EVENT_NOT_FOUND' | 'PERMISSION_DENIED' }`.
   *
   * @example
   * ```typescript
   * const res = clock.updateEvent({
   *   eventId: 'evt_patrol_123',
   *   priority: 'high',
   *   description: 'Escalated patrol priority.'
   * }, { callerAgentId: 'guard_captain' });
   * console.log(`Updated priority: ${res.event?.priority}`);
   * ```
   */
  updateEvent(
    params: UpdateEventParams = {},
    context: ExecutionContext = {}
  ): UpdateEventResult {
    const id = String(params.eventId || params.id || params.event_id || '').trim();
    if (!id) {
      return { success: false, error: "Missing required argument 'eventId' for updateEvent", code: WORLD_CLOCK_ERROR_CODES.INVALID_ARGUMENTS };
    }

    const auth = this.#extractAuth(context);
    // Scope-aware lookup (Wave I, ticket d57cbc1): an in-scope partition wins
    // over earlier foreign insertion order for a duplicated event id.
    const found = this.#findEvent(id, auth);
    if (!found) {
      return { success: false, error: `Event '${id}' not found`, code: WORLD_CLOCK_ERROR_CODES.EVENT_NOT_FOUND };
    }

    const { event, agentId: ownerPartitionKey } = found;

    // Realm confinement (V10 F-V10-1): an event owned by a partition outside
    // the caller's realm scope is unreachable even for a privileged caller.
    if (!this.#isTargetInScope(auth, ownerPartitionKey)) {
      return this.#outOfScopeFailure(ownerPartitionKey);
    }
    const { callerAgentId, callerPartitionKey, isPrivileged, globalKey } = auth;
    const isOwner = event.ownerId === callerAgentId
      || event.ownerId === callerPartitionKey
      || event.createdBy === callerAgentId
      || event.createdBy === callerPartitionKey
      || event.ownerId === globalKey;

    if (!isPrivileged && !isOwner) {
      return {
        success: false,
        error: "Permission denied: cannot modify another agent's event",
        code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
      };
    }

    if (params.name) event.name = params.name;
    if (params.description) event.description = params.description;
    if (params.priority) event.priority = params.priority;
    if (params.category) event.category = params.category;
    if (params.metadata && typeof params.metadata === 'object') {
      event.metadata = { ...event.metadata, ...params.metadata };
    }

    this.syncToVirtualFs(ownerPartitionKey);
    return { success: true, updated: true, event: this.#receiptEvent(event) };
  }

  /**
   * Purges events for a partition or all partitions.
   *
   * Access Control:
   * Clearing `'all'` partitions requires a privileged principal (identity-port descriptor with cross-partition scope or the injected internal principal).
   * Realm confinement (V10 F-V10-1): an `'all'` clear enumerates only the caller's realm scope, and a single-target clear outside that scope denies with `PERMISSION_DENIED` before any purge; only `realmBypass` principals and context-free engine calls span every partition.
   *
   * Side Effects:
   * Clears in-memory partition Map and updates VirtualFS (unless `writeToFs: false`).
   *
   * @param params - Clear options (`targetAgentId`, `all`, `writeToFs`) or partition ID string / `'all'`.
   * @param context - Execution and security context of the invoking caller.
   * @returns Result structure with count of cleared events.
   *
   * @throws Never throws directly; returns `{ success: false, error, code: 'PERMISSION_DENIED' }` on violation.
   *
   * @example
   * ```typescript
   * const res = clock.clearEvents(
   *   { targetAgentId: 'agent_scout' },
   *   { callerAgentId: 'agent_scout' }
   * );
   * console.log(`Cleared ${res.cleared} events for scout.`);
   * ```
   */
  clearEvents(
    params: ClearEventsParams | string = {},
    context: ExecutionContext = {}
  ): ClearEventsResult {
    const auth = this.#extractAuth(context);
    const { callerAgentId, callerPartitionKey, isPrivileged } = auth;

    let isAll = false;
    let target: string | null = null;
    let shouldWriteToFs = true;

    if (typeof params === 'string') {
      if (params === 'all') {
        isAll = true;
      } else {
        target = params.trim();
      }
    } else if (typeof params === 'object' && params !== null) {
      if (params.all === true || params.targetAgentId === 'all') {
        isAll = true;
      } else if (params.targetAgentId) {
        target = params.targetAgentId.trim();
      }
      if (params.writeToFs === false) {
        shouldWriteToFs = false;
      }
    }

    if (isAll || (target && target !== callerAgentId && target !== callerPartitionKey)) {
      if (!isPrivileged) {
        return {
          success: false,
          error: 'Permission denied: cannot clear events for all or other agents without administrator privileges',
          code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED,
          cleared: 0
        };
      }
    }

    if (isAll) {
      let totalCleared = 0;
      // Realm-bound callers clear only their realm scope; realm-bypass
      // principals span every partition (Realm wave A0).
      const keys = this.#scopedPartitionKeys(auth) ?? [...this.#agentEvents.keys()];
      for (const key of keys) {
        const partition = this.#agentEvents.get(key);
        if (!partition) continue;
        totalCleared += partition.size;
        partition.clear();
        if (shouldWriteToFs) {
          this.syncToVirtualFs(key);
        }
      }
      return { success: true, cleared: totalCleared, all: true };
    }

    const effectiveTarget = this.#resolvePartitionKey(auth, target || callerPartitionKey || auth.globalKey);

    if (!this.#isTargetInScope(auth, effectiveTarget)) {
      return {
        ...this.#outOfScopeFailure(effectiveTarget),
        cleared: 0
      };
    }

    const partition = this.#agentEvents.get(effectiveTarget);
    const count = partition ? partition.size : 0;
    if (partition) {
      partition.clear();
    }

    if (shouldWriteToFs) {
      this.syncToVirtualFs(effectiveTarget);
    }

    return {
      success: true,
      cleared: count,
      agentId: this.#receiptLabel(effectiveTarget)
    };
  }

  /**
   * Agent-visible adapter for the `get_current_time` tool descriptor.
   *
   * Mirrors the descriptor fallback (`getTime` plus a canonical `time_string`)
   * and sanitizes the receipt for the agent surface: the internal
   * `realm:<realmId>:global` partition key is labeled `global` (R3, ticket
   * 10eab05). The direct API surface (`getTime`) is unchanged.
   *
   * @param params - Target partition options or partition identifier string.
   * @param context - Execution and security context of the invoking caller.
   * @returns The agent-visible {@link TimeState} (or scoped `all` result) with `time_string`.
   */
  getCurrentTime(
    params: GetTimeParams | string = {},
    context: ExecutionContext = {}
  ): TimeState | GetAllClocksResult {
    const visible = sanitizeAgentVisibleReceipt(
      this.getTime(params, context),
      undefined,
      (value) => this.#receiptLabel(value)
    ) as TimeState | GetAllClocksResult;
    if ('clocks' in visible) return visible;

    const time = visible as TimeState;
    const timeString = typeof time.formatted === 'string' && time.formatted
      ? time.formatted
      : `${time.hour ?? 0}:${time.minute ?? 0}:${time.second ?? 0}`;
    return { ...time, time_string: timeString };
  }

  /**
   * Agent-visible adapter for the `world_clock` tool descriptor.
   *
   * Mirrors the descriptor's action dispatch (`advance`/`set`/`reset`/`query`)
   * and sanitizes every receipt through {@link sanitizeAgentVisibleReceipt}, so
   * neither the internal `realm:<realmId>:global` partition key nor a
   * registered canonical identity key reaches the agent surface (R3 ticket
   * 10eab05; Wave I ticket d57cbc1). Non-tool callers keep the direct methods.
   *
   * @param params - Sanitized canonical tool parameters (`action`, `minutes`, `hours`, `seconds`, `time`).
   * @param context - Execution and security context of the invoking caller.
   * @returns The agent-visible clock receipt.
   */
  handleClockTool(
    params: Record<string, unknown> = {},
    context: ExecutionContext = {}
  ): unknown {
    const p = params && typeof params === 'object' ? params : {};
    const action = String(p.action || 'query').toLowerCase();

    switch (action) {
      case 'advance':
        return this.#sanitizeAgentVisible(this.advanceClock({
          minutes: typeof p.minutes === 'number' ? p.minutes : undefined,
          hours: typeof p.hours === 'number' ? p.hours : undefined,
          seconds: typeof p.seconds === 'number' ? p.seconds : undefined
        }, context));
      case 'set':
        return this.#sanitizeAgentVisible(this.setTime({
          time: (typeof p.time === 'string' || typeof p.time === 'number') ? p.time : undefined,
          minute: typeof p.minutes === 'number' ? p.minutes : undefined,
          hour: typeof p.hours === 'number' ? p.hours : undefined,
          second: typeof p.seconds === 'number' ? p.seconds : undefined
        }, context));
      case 'reset':
        return this.#sanitizeAgentVisible(this.resetClock({}, context));
      case 'query':
      default:
        return this.#sanitizeAgentVisible(this.getTime({}, context));
    }
  }

  /**
   * Agent-visible adapter for the `event_list` tool descriptor.
   *
   * Mirrors the descriptor's action dispatch (`register`/`resolve`/`cancel`/
   * `query`) and sanitizes every receipt through
   * {@link sanitizeAgentVisibleReceipt}, so event `ownerId`/`createdBy` fields,
   * `clock` projections, and `clocks` map keys never carry the internal
   * `realm:<realmId>:global` partition key or a registered canonical identity
   * key (R3 ticket 10eab05; Wave I ticket d57cbc1). Non-tool callers keep the
   * direct methods.
   *
   * @param params - Sanitized canonical tool parameters (`action`, `event_id`, `name`, `trigger_minutes`, `category`, `description`).
   * @param context - Execution and security context of the invoking caller.
   * @returns The agent-visible event receipt.
   */
  handleEventTool(
    params: Record<string, unknown> = {},
    context: ExecutionContext = {}
  ): unknown {
    const p = params && typeof params === 'object' ? params : {};
    const action = String(p.action || 'query').toLowerCase();

    switch (action) {
      case 'register':
        return this.#sanitizeAgentVisible(this.registerEvent({
          id: typeof p.event_id === 'string' ? p.event_id : undefined,
          name: typeof p.name === 'string' ? p.name : undefined,
          description: typeof p.description === 'string' ? p.description : undefined,
          offsetMinutes: typeof p.trigger_minutes === 'number' ? p.trigger_minutes : undefined,
          category: typeof p.category === 'string' ? p.category : undefined
        }, context));
      case 'resolve':
        return this.#sanitizeAgentVisible(this.resolveEvent(
          typeof p.event_id === 'string' ? p.event_id : '',
          context
        ));
      case 'cancel':
        return this.#sanitizeAgentVisible(this.cancelEvent(
          typeof p.event_id === 'string' ? p.event_id : '',
          context
        ));
      case 'query':
      default:
        return this.#sanitizeAgentVisible(this.queryEvents(p as QueryEventsParams, context));
    }
  }

  /**
   * Starts background continuous simulation clock progression.
   *
   * Each tick advances `'global'` and every known agent partition through the
   * private engine path (`#advanceAllPartitions`, `stepSeconds` per tick) with
   * VirtualFS synchronization; no caller context, flags, or reserved id is
   * fabricated internally.
   *
   * Automatically terminates any prior ticker interval before starting a new one to prevent leaks.
   * The host interval handle is `unref()`-ed when the injected scheduler supports it.
   *
   * @param options - Ticker configuration (`intervalMs`, `stepSeconds`) or a numeric real-world interval in milliseconds (`stepSeconds` defaults to 1).
   * @returns Status receipt with running state and timing intervals.
   *
   * @example
   * ```typescript
   * const receipt = clock.start({ intervalMs: 1000, stepSeconds: 60 });
   * console.log(`Ticker running: ${receipt.running}`);
   * ```
   */
  start(options: TickerOptions | number = {}): TickerReceipt {
    if (this.#intervalId) {
      this.stop();
    }
    this.#isRunning = true;
    let ms = 1000;
    let step = 1;

    if (typeof options === 'object' && options !== null) {
      ms = Math.max(10, Number(options.intervalMs) || 1000);
      step = Number(options.stepSeconds) || 1;
    } else if (typeof options === 'number') {
      ms = Math.max(10, options);
    }

    this.#intervalId = this.#hostSetInterval(() => {
      // Engine step: private authority path, no caller context or flags.
      this.#advanceAllPartitions(step, {});
    }, ms);

    const intervalHandle = this.#intervalId;
    if (intervalHandle && typeof intervalHandle === 'object' && typeof intervalHandle.unref === 'function') {
      intervalHandle.unref();
    }
    return { success: true, running: true, intervalMs: ms, stepSeconds: step };
  }

  /**
   * Convenience alias for {@link start}.
   *
   * @param options - Ticker configuration (`intervalMs`, `stepSeconds`) or a numeric real-world interval in milliseconds (`stepSeconds` defaults to 1).
   * @returns Status receipt with running state and timing intervals.
   *
   * @example
   * ```typescript
   * const receipt = clock.startTicker({ intervalMs: 1000, stepSeconds: 1 });
   * ```
   */
  startTicker(options: TickerOptions | number = {}): TickerReceipt {
    return this.start(options);
  }

  /**
   * Stops background continuous simulation clock progression.
   *
   * Clears active interval handle and sets running state to false.
   *
   * @returns Status receipt confirming the ticker is stopped (`running: false`).
   *
   * @example
   * ```typescript
   * const receipt = clock.stop();
   * console.log(`Ticker stopped: ${!receipt.running}`);
   * ```
   */
  stop(): TickerReceipt {
    if (this.#intervalId) {
      this.#hostClearInterval(this.#intervalId);
      this.#intervalId = null;
    }
    this.#isRunning = false;
    return { success: true, running: false };
  }

  /**
   * Convenience alias for {@link stop}.
   *
   * @returns Status receipt confirming the ticker is stopped (`running: false`).
   *
   * @example
   * ```typescript
   * const receipt = clock.stopTicker();
   * ```
   */
  stopTicker(): TickerReceipt {
    return this.stop();
  }

  /**
   * Indicates whether the background continuous simulation ticker is currently active.
   *
   * @example
   * ```typescript
   * if (clock.isRunning) {
   *   console.log('Simulation clock is ticking.');
   * }
   * ```
   */
  get isRunning(): boolean {
    return Boolean(this.#isRunning);
  }

  /**
   * Builds the per-call VirtualFS option bundle for engine synchronization.
   *
   * Authority is the injected internal principal reference only; reserved
   * `system` ids and caller flags are never sent. Without an injected
   * principal, private-workspace sync is denied by the VirtualFS ACL
   * (best-effort sync swallows the denial), while the shared `global`
   * workspace stays readable/writable for every caller.
   *
   * @param workspaceId - Workspace partition the sync targets
   * @param force - Whether to force the write through the VirtualFS ACL cache
   * @returns Per-call VirtualFS option bundle
   */
  #syncOptions(workspaceId: string, force = false): { workspaceId: string; principal?: object; callerAgentId?: string; force?: boolean } {
    const options: { workspaceId: string; principal?: object; callerAgentId?: string; force?: boolean } = { workspaceId };
    if (this.#internalPrincipal) {
      options.principal = this.#internalPrincipal;
      const principal = this.#internalPrincipal as { subject?: unknown };
      const subject = principal.subject;
      if (typeof subject === 'string' && subject.trim()) {
        options.callerAgentId = subject.trim();
      }
    }
    if (force) options.force = true;
    return options;
  }

  /**
   * Serializes in-memory partition clock and event states to VirtualFS files:
   * - `/{agentId}/world_clock.json`
   * - `/{agentId}/event_list.json`
   *
   * If `targetAgentId` is omitted or null, synchronizes every known agent
   * partition plus the operating global key: `'global'` for ungrouped and
   * realm-bypass callers, or the caller's realm scope when a realm-bound caller
   * context is supplied (Realm wave A0). Each partition is written to the
   * workspace of the same id, so a realm-global partition lands in
   * `realm:<realmId>:global` only.
   * No-op when `autoSyncFs` is false or no `virtualFs` instance was provided.
   * Private-workspace writes carry the injected `WorldClockOptions.internalPrincipal`
   * reference (never reserved ids or flags); without an injected principal the
   * VirtualFS ACL denies private-workspace writes and best-effort sync swallows
   * the denial, while `'global'` remains writable.
   *
   * Realm confinement (V10 F-V10-1): an explicit `targetAgentId` outside the
   * caller's realm scope is a silent no-op (this method returns no receipt),
   * and the full-scope path enumerates only the caller's scope; context-free
   * engine syncs keep the legacy unscoped span.
   *
   * @param targetAgentId - Target partition to serialize, or null for the caller's full scope.
   * @param context - Execution and security context; omission spans every partition (engine sync).
   *
   * @example
   * ```typescript
   * clock.syncToVirtualFs('agent_scout');
   * ```
   */
  syncToVirtualFs(targetAgentId: string | null = null, context: ExecutionContext = {}): void {
    if (!this.#autoSyncFs || !this.#virtualFs) return;

    try {
      const buildClockPayload = (agentKey: string) => {
        const clock = this.#getOrCreateClock(agentKey);
        const partitionEvents = this.#getPartitionEvents(agentKey);
        const formattedData = formatWorldTime(clock.totalSeconds);
        return {
          agentId: agentKey,
          totalSeconds: clock.totalSeconds,
          totalMinutes: Math.floor(clock.totalSeconds / 60),
          day: formattedData.day,
          hour: formattedData.hour,
          minute: formattedData.minute,
          second: formattedData.second,
          formatted: formattedData.formatted,
          shortFormatted: formattedData.shortFormatted,
          date: clock.date,
          updatedAt: clock.lastSync || Date.now(),
          activeEventsCount: partitionEvents.filter(ev => ev.status === 'active').length,
          pendingEventsCount: partitionEvents.filter(ev => ev.status === 'pending').length
        };
      };

      const buildEventPayload = (agentKey: string, eventsList: WorldEvent[]) => {
        const clock = this.#getOrCreateClock(agentKey);
        return {
          version: '1.0',
          agentId: agentKey,
          worldTimeSeconds: clock.totalSeconds,
          worldTimeFormatted: formatWorldTime(clock.totalSeconds).formatted,
          date: clock.date,
          updatedAt: Date.now(),
          events: eventsList
        };
      };

      if (targetAgentId) {
        const auth = this.#extractAuth(context);
        const effectiveKey = this.#resolvePartitionKey(auth, targetAgentId.trim());
        // Realm confinement (V10 F-V10-1): an explicit target outside the
        // caller's realm scope is a silent no-op; this is a void method, and
        // every internal mutation call passes an already-resolved key with no
        // caller context (engine span).
        if (!this.#isTargetInScope(auth, effectiveKey)) return;
        this.#virtualFs.writeFile('/world_clock.json', JSON.stringify(buildClockPayload(effectiveKey), null, 2), this.#syncOptions(effectiveKey, true));
        const partition = this.#agentEvents.get(effectiveKey);
        const eventsList = partition ? Array.from(partition.values()) : [];
        this.#virtualFs.writeFile('/event_list.json', JSON.stringify(buildEventPayload(effectiveKey, eventsList), null, 2), this.#syncOptions(effectiveKey, true));
      } else {
        // Full-scope sync: the caller's realm scope when realm-bound, otherwise
        // every known partition (engine / realm-bypass principals).
        const scoped = this.#scopedPartitionKeys(this.#extractAuth(context));
        const allAgentKeys = scoped
          ? scoped
          : ['global', ...[...new Set([...this.#agentClocks.keys(), ...this.#agentEvents.keys()])].filter(key => key !== 'global')];

        for (const agentKey of allAgentKeys) {
          this.#virtualFs.writeFile('/world_clock.json', JSON.stringify(buildClockPayload(agentKey), null, 2), this.#syncOptions(agentKey, true));
          const partition = this.#agentEvents.get(agentKey);
          const agentEvents = partition ? Array.from(partition.values()) : [];
          this.#virtualFs.writeFile('/event_list.json', JSON.stringify(buildEventPayload(agentKey, agentEvents), null, 2), this.#syncOptions(agentKey, true));
        }
      }
    } catch {
      // In-memory operation never fails even if VFS write throws
    }
  }

  /**
   * Hydrates clock and event partitions from VirtualFS files if they exist.
   * Resilient to JSON formatting variations, missing files (a `FileNotFoundError`
   * is treated as absent state, not corruption), or budget truncations; an
   * unreadable file — a failed `exists()` inspection or a `readFile()` throw other
   * than a missing file — and malformed payloads (a non-finite `totalSeconds` or a
   * present but non-string/blank `date` on a clock payload, and individual event
   * entries without a valid string `id`) are reported through a `CORRUPTED_SNAPSHOT`
   * receipt instead of being swallowed, with `details` listing each unreadable file
   * path and each malformed entry/clock-field location while the remaining valid
   * payloads are still imported (best-effort sync). A clock payload with a
   * non-finite `totalSeconds` is not applied and leaves the target clock unchanged;
   * a valid `totalSeconds` is imported even when a malformed `date` is reported (the
   * previous date is kept).
   * No-op success receipt when no `virtualFs` with a `readFile` method is available.
   *
   * When `targetWorkspace` is omitted and a realm-bound caller context is
   * supplied, only that caller's realm-scoped workspaces are enumerated and
   * hydrated (Realm wave A0); omitting the context spans every workspace
   * (engine/persistence hydration), and the injected internal principal or a
   * `realmBypass` identity may span all. An explicit `targetWorkspace` outside
   * the caller's realm scope is denied with a `PERMISSION_DENIED` receipt
   * before any read; context-free explicit targets keep the legacy unscoped
   * span (V10 F-V10-1).
   *
   * @param targetWorkspace - Optional workspace directory or partition identifier to hydrate.
   * @param context - Execution and security context; omission spans every workspace.
   * @returns Hydration receipt; `success: false` with code `CORRUPTED_SNAPSHOT` and per-payload `details` when persisted payloads were malformed or unreadable.
   *
   * @example
   * ```typescript
   * clock.syncFromVirtualFs();
   * ```
   */
  syncFromVirtualFs(targetWorkspace: string | null = null, context: ExecutionContext = {}): SyncFromVirtualFsResult {
    const virtualFs = this.#virtualFs;
    if (!virtualFs || typeof virtualFs.readFile !== 'function') {
      return { success: true };
    }

    let corrupted = false;
    const corruptionDetails: string[] = [];
    const markCorrupted = (detail: string): void => {
      corrupted = true;
      if (detail) corruptionDetails.push(detail);
    };

    const describeError = (err: unknown): string => {
      if (err && typeof err === 'object' && 'message' in err && typeof err.message === 'string' && err.message.trim()) {
        return err.message.trim();
      }
      return String(err);
    };

    const isMissingFileError = (err: unknown): boolean => {
      if (!err || typeof err !== 'object') return false;
      return (
        ('name' in err && err.name === 'FileNotFoundError')
        || ('code' in err && (err.code === 'FILE_NOT_FOUND' || err.code === 'ENOENT'))
      );
    };

    const readJsonPayload = (raw: unknown, label: string): VirtualFsJsonPayload => {
      if (raw === undefined || raw === null) return { status: 'empty' };
      let data: unknown = raw;
      if (typeof data === 'object' && data !== null && 'content' in data && typeof data.content === 'string') {
        data = data.content;
      }
      if (typeof data === 'string') {
        if (!data.trim()) return { status: 'empty' };
        try {
          data = JSON.parse(data);
        } catch {
          return { status: 'corrupted', detail: `${label}: invalid JSON` };
        }
      }
      if (!isPlainObject(data)) {
        return { status: 'corrupted', detail: `${label}: expected a JSON object` };
      }
      return { status: 'ok', data };
    };

    const syncWorkspace = (wsId: string): void => {
      const clockLabel = `/world_clock.json@${wsId}`;
      const eventLabel = `/event_list.json@${wsId}`;
      let hasClockFile: boolean;
      try {
        if (typeof virtualFs.exists === 'function') {
          hasClockFile = virtualFs.exists('/world_clock.json', this.#syncOptions(wsId));
        } else {
          hasClockFile = true;
        }
      } catch (err) {
        hasClockFile = false;
        markCorrupted(`${clockLabel}: unreadable file (exists check failed: ${describeError(err)})`);
      }

      if (hasClockFile) {
        try {
          const raw = virtualFs.readFile('/world_clock.json', { ...this.#syncOptions(wsId), raw: true });
          const parsedResult = readJsonPayload(raw, clockLabel);
          if (parsedResult.status === 'corrupted') {
            markCorrupted(parsedResult.detail);
          } else if (parsedResult.status === 'ok') {
            const parsed = parsedResult.data;
            const rawTotal = parsed.totalSeconds;
            const finiteTotal = typeof rawTotal === 'number' && Number.isFinite(rawTotal);
            if (!finiteTotal) {
              markCorrupted(`/world_clock.json@${wsId}: "totalSeconds" must be a finite number`);
            }
            const rawDate = parsed.date;
            const hasDate = rawDate !== undefined;
            const validDate = hasDate && typeof rawDate === 'string' && rawDate.trim().length > 0;
            if (hasDate && !validDate) {
              markCorrupted(`/world_clock.json@${wsId}: "date" must be a non-empty string`);
            }
            if (finiteTotal) {
              const clock = this.#getOrCreateClock(wsId);
              clock.totalSeconds = Math.max(0, Math.floor(rawTotal));
              if (validDate) {
                clock.date = rawDate.trim();
              }
              const rawUpdatedAt = parsed.updatedAt;
              clock.lastSync = typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : Date.now();
            }
          }
        } catch (err) {
          if (!isMissingFileError(err)) {
            markCorrupted(`${clockLabel}: unreadable file (${describeError(err)})`);
          }
        }
      }

      let hasEventFile: boolean;
      try {
        if (typeof virtualFs.exists === 'function') {
          hasEventFile = virtualFs.exists('/event_list.json', this.#syncOptions(wsId));
        } else {
          hasEventFile = true;
        }
      } catch (err) {
        hasEventFile = false;
        markCorrupted(`${eventLabel}: unreadable file (exists check failed: ${describeError(err)})`);
      }

      if (hasEventFile) {
        try {
          const raw = virtualFs.readFile('/event_list.json', { ...this.#syncOptions(wsId), raw: true });
          const parsedResult = readJsonPayload(raw, eventLabel);
          if (parsedResult.status === 'corrupted') {
            markCorrupted(parsedResult.detail);
          } else if (parsedResult.status === 'ok') {
            const parsed = parsedResult.data as PersistedEventListPayload;
            if (Array.isArray(parsed.events)) {
              const partition = this.#getOrCreatePartition(wsId);
              partition.clear();
              for (let index = 0; index < parsed.events.length; index++) {
                const ev = parsed.events[index];
                if (!ev || typeof ev !== 'object' || Array.isArray(ev) || typeof ev.id !== 'string' || !ev.id.trim()) {
                  markCorrupted(`/event_list.json@${wsId}: events[${index}] is missing a valid string "id"`);
                  continue;
                }
                const owner = ev.ownerId || wsId;
                partition.set(ev.id, {
                  ...ev,
                  ownerId: owner,
                  createdBy: ev.createdBy || owner,
                  metadata: ev.metadata && typeof ev.metadata === 'object' ? { ...ev.metadata } : {},
                  repeatMinutes: typeof ev.repeatMinutes === 'number' ? ev.repeatMinutes : null,
                  repeatSeconds: typeof ev.repeatSeconds === 'number' ? ev.repeatSeconds : null,
                  resolvedAt: ev.resolvedAt !== undefined ? ev.resolvedAt : null,
                  resolvedAtFormatted: ev.resolvedAtFormatted !== undefined ? ev.resolvedAtFormatted : null,
                  resolvedBy: ev.resolvedBy !== undefined ? ev.resolvedBy : null,
                  resolutionNote: ev.resolutionNote !== undefined ? ev.resolutionNote : null,
                  cancelledAt: ev.cancelledAt !== undefined ? ev.cancelledAt : null,
                  cancelledBy: ev.cancelledBy !== undefined ? ev.cancelledBy : null,
                  cancellationReason: ev.cancellationReason !== undefined ? ev.cancellationReason : null
                });
              }
            } else {
              markCorrupted(`/event_list.json@${wsId}: "events" must be an array`);
            }
          }
        } catch (err) {
          if (!isMissingFileError(err)) {
            markCorrupted(`${eventLabel}: unreadable file (${describeError(err)})`);
          }
        }
      }
    };

    try {
      if (targetWorkspace) {
        const auth = this.#extractAuth(context);
        const effectiveWorkspace = this.#resolvePartitionKey(auth, targetWorkspace);
        // Realm confinement (V10 F-V10-1): an explicit workspace outside the
        // caller's realm scope is denied before any read/hydration; only
        // `realmBypass` principals and context-free engine calls (store and
        // persistence fallback hydration) span every workspace.
        if (!this.#isTargetInScope(auth, effectiveWorkspace)) {
          return {
            success: false,
            error: `Permission denied: workspace '${this.#receiptLabel(effectiveWorkspace)}' is outside the caller's realm scope`,
            code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
          };
        }
        syncWorkspace(effectiveWorkspace);
      } else {
        // Realm-bound callers hydrate only their realm scope; the engine,
        // internal principal, and realm-bypass identities span every workspace.
        const scoped = this.#scopedPartitionKeys(this.#extractAuth(context));
        if (scoped) {
          for (const wsId of scoped) {
            syncWorkspace(wsId);
          }
        } else {
          syncWorkspace('global');

          if (typeof virtualFs.listWorkspaces === 'function') {
            try {
              const workspaces = virtualFs.listWorkspaces();
              for (const wsId of workspaces) {
                if (wsId !== 'global') {
                  syncWorkspace(wsId);
                }
              }
            } catch {
              /* Workspace enumeration is best-effort: a failing workspace is skipped, remaining workspaces still hydrate. */
            }
          }
        }
      }
    } catch {
      // Ignore hydration errors, fall back to initial memory state
    }

    if (corrupted) {
      return {
        success: false,
        error: 'Corrupted snapshot: failed to deserialize world clock state from VirtualFS',
        code: WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT,
        details: corruptionDetails
      };
    }

    return { success: true };
  }

  /**
   * Produces a complete serializable JSON-safe snapshot capturing global state,
   * all partition clocks, and all registered events.
   *
   * Tenant administration (MOD-21 W10-C, default-deny): the snapshot discloses
   * every partition, so a trusted principal is required — the exact
   * `context.principal` reference injected as
   * `WorldClockOptions.internalPrincipal`, or an identity-port
   * `AuthorityDescriptor` for `context.callerAgentId` granting cross-partition
   * authority. Anonymous callers, caller-asserted flags, and plain lookalike
   * principal objects receive a `PERMISSION_DENIED` failure receipt carrying
   * `error`/`code` only, with no partition state attached.
   *
   * Realm scope (Realm wave A0): a realm-bound caller (no `realmBypass`)
   * discloses only its realm partitions, and the top-level `totalSeconds`/`date`
   * mirror its realm-global clock; the internal principal / `realmBypass`
   * identities span every partition.
   *
   * @param context - Execution and security context of the invoking caller.
   * @returns Complete {@link WorldClockSnapshot} object, or a `PERMISSION_DENIED` {@link WorldClockOperationFailure} receipt for unauthorized callers.
   *
   * @example
   * ```typescript
   * const snapshot = clock.exportSnapshot({ principal: internalPrincipal });
   * localStorage.setItem('world_clock_backup', JSON.stringify(snapshot));
   * ```
   */
  exportSnapshot(
    context: ExecutionContext = {}
  ): WorldClockSnapshot | WorldClockOperationFailure {
    const auth = this.#extractAuth(context);
    if (!auth.isPrivileged) {
      return {
        success: false,
        error: 'Permission denied: exportSnapshot requires a privileged principal (tenant administration)',
        code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
      };
    }

    const scoped = this.#scopedPartitionKeys(auth);
    const inScope = (key: string): boolean => !scoped || scoped.includes(key);

    const allEvents: WorldEvent[] = [];
    const agentEventsObj: Record<string, WorldEvent[]> = {};
    const agentClocksObj: Record<string, PartitionClockSnapshot> = {};

    for (const [agentKey, clock] of this.#agentClocks.entries()) {
      if (!inScope(agentKey)) continue;
      agentClocksObj[agentKey] = {
        totalSeconds: clock.totalSeconds,
        date: clock.date,
        lastSync: clock.lastSync
      };
    }

    for (const [agentKey, partition] of this.#agentEvents.entries()) {
      if (!inScope(agentKey)) continue;
      agentEventsObj[agentKey] = Array.from(partition.values()).map(ev => copyEvent(ev));
      for (const ev of partition.values()) {
        allEvents.push(copyEvent(ev));
      }
    }

    const globalClock = this.#getOrCreateClock(scoped ? auth.globalKey : 'global');

    return {
      totalSeconds: globalClock.totalSeconds,
      date: globalClock.date,
      events: allEvents,
      agentClocks: agentClocksObj,
      agentEvents: agentEventsObj
    };
  }

  /**
   * Restores all clock partitions and event registries from a persistence snapshot.
   *
   * Tenant administration (MOD-21 W10-C, default-deny): the snapshot replaces
   * every partition, so a trusted principal is required — the exact
   * `context.principal` reference injected as
   * `WorldClockOptions.internalPrincipal`, or an identity-port
   * `AuthorityDescriptor` for `context.callerAgentId` granting cross-partition
   * authority. Anonymous callers, caller-asserted flags, and plain lookalike
   * principal objects receive a `PERMISSION_DENIED` receipt before the snapshot
   * is validated and before any state is cleared or replaced.
   *
   * Backward Compatibility:
   * Automatically partitions legacy flat event arrays by `ownerId`, `createdBy`, or `'global'`.
   * Directly synchronizes restored state to VirtualFS.
   *
   * Realm scope (Realm wave A0): a realm-bound caller (no `realmBypass`) replaces
   * and hydrates only its realm partitions, with the top-level `totalSeconds`/
   * `date` seeding its realm-global clock; the internal principal / `realmBypass`
   * identities replace every partition.
   *
   * Corruption Handling:
   * The snapshot is validated in full before any mutation. Structural problems — a non-object
   * snapshot or malformed `agentClocks`/`agentEvents`/`events` section types — reject the
   * snapshot atomically with a `CORRUPTED_SNAPSHOT` receipt carrying `error`/`code` only and
   * no `details`. Validated top-level scalar problems (a present non-finite `totalSeconds`
   * or a present non-string `date`) and per-entry problems (non-object clock entries,
   * non-finite `totalSeconds`/non-string `date` on a clock entry, non-array event partitions,
   * event entries without a valid string `id`) likewise reject the snapshot atomically with
   * `CORRUPTED_SNAPSHOT`, and `details` enumerates each offending field/entry. Absent
   * top-level scalars fall back to the legacy defaults (`0` / `'Day 1'`); a present
   * blank-string `date` is accepted and normalized to `'Day 1'`, whereas `syncFromVirtualFs`
   * reports a present blank `date` as malformed (and keeps the previous date).
   * The legacy flat `events` array is validated even when `agentEvents` is present, but is
   * imported only when `agentEvents` is absent (`agentEvents` takes precedence).
   *
   * @param snapshot - Serializable snapshot previously created by {@link exportSnapshot}.
   * @param context - Execution and security context of the invoking caller.
   * @returns Hydration receipt; `success: false` with code `PERMISSION_DENIED` for unauthorized callers (before validation), or code `CORRUPTED_SNAPSHOT` with `details` for validated scalar/per-entry problems and `error`/`code` only for structural rejects.
   *
   * @example
   * ```typescript
   * const snapshot = JSON.parse(localStorage.getItem('world_clock_backup')!);
   * clock.importSnapshot(snapshot, { principal: internalPrincipal });
   * ```
   */
  importSnapshot(
    snapshot: WorldClockSnapshot,
    context: ExecutionContext = {}
  ): ImportSnapshotResult {
    const auth = this.#extractAuth(context);
    if (!auth.isPrivileged) {
      return {
        success: false,
        error: 'Permission denied: importSnapshot requires a privileged principal (tenant administration)',
        code: WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED
      };
    }

    const scoped = this.#scopedPartitionKeys(auth);
    const inScope = (key: string): boolean => !scoped || scoped.includes(key);
    const primaryKey = scoped ? auth.globalKey : 'global';

    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return {
        success: false,
        error: 'Corrupted snapshot: expected a snapshot object',
        code: WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT
      };
    }

    if (
      (snapshot.agentClocks !== undefined && !isPlainObject(snapshot.agentClocks))
      || (snapshot.agentEvents !== undefined && !isPlainObject(snapshot.agentEvents))
      || (snapshot.events !== undefined && !Array.isArray(snapshot.events))
    ) {
      return {
        success: false,
        error: 'Corrupted snapshot: malformed clock or event section',
        code: WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT
      };
    }

    const problems: string[] = [];
    if (snapshot.totalSeconds !== undefined && !Number.isFinite(snapshot.totalSeconds)) {
      problems.push('totalSeconds: expected a finite number');
    }
    if (snapshot.date !== undefined && typeof snapshot.date !== 'string') {
      problems.push('date: expected a string');
    }
    const validateEventEntries = (label: string, eventList: readonly WorldEvent[]): void => {
      for (let index = 0; index < eventList.length; index++) {
        const ev = eventList[index];
        if (!isPlainObject(ev)) {
          problems.push(`${label}[${index}]: expected an event object`);
        } else if (typeof ev.id !== 'string' || !ev.id.trim()) {
          problems.push(`${label}[${index}]: missing or invalid "id"`);
        }
      }
    };

    if (snapshot.agentClocks !== undefined) {
      for (const [agentKey, clockData] of Object.entries(snapshot.agentClocks)) {
        if (!inScope(agentKey)) continue;
        if (!isPlainObject(clockData)) {
          problems.push(`agentClocks["${agentKey}"]: expected a clock object`);
          continue;
        }
        if (clockData.totalSeconds !== undefined && !Number.isFinite(clockData.totalSeconds)) {
          problems.push(`agentClocks["${agentKey}"].totalSeconds: expected a finite number`);
        }
        if (clockData.date !== undefined && typeof clockData.date !== 'string') {
          problems.push(`agentClocks["${agentKey}"].date: expected a string`);
        }
      }
    }

    if (snapshot.agentEvents !== undefined) {
      for (const [agentKey, eventList] of Object.entries(snapshot.agentEvents)) {
        if (!inScope(agentKey)) continue;
        if (!Array.isArray(eventList)) {
          problems.push(`agentEvents["${agentKey}"]: expected an array of events`);
          continue;
        }
        validateEventEntries(`agentEvents["${agentKey}"]`, eventList);
      }
    }

    if (Array.isArray(snapshot.events)) {
      validateEventEntries('events', snapshot.events);
    }

    if (problems.length > 0) {
      return {
        success: false,
        error: `Corrupted snapshot: rejected ${problems.length} malformed snapshot ${problems.length === 1 ? 'entry' : 'entries'}`,
        code: WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT,
        details: problems
      };
    }

    if (scoped) {
      // Realm-bound replacement touches only the caller's realm partitions.
      for (const key of scoped) {
        this.#agentClocks.delete(key);
        this.#agentEvents.delete(key);
      }
    } else {
      this.#agentClocks.clear();
      this.#agentEvents.clear();
    }

    const globalTotalSec = snapshot.totalSeconds !== undefined
      ? Math.max(0, Math.floor(snapshot.totalSeconds))
      : 0;
    const globalDate = typeof snapshot.date === 'string' && snapshot.date.trim()
      ? snapshot.date.trim()
      : 'Day 1';

    // Hydrate agentClocks (entries were validated above)
    if (snapshot.agentClocks !== undefined) {
      for (const [agentKey, clockData] of Object.entries(snapshot.agentClocks)) {
        if (!inScope(agentKey)) continue;
        this.#agentClocks.set(agentKey, {
          totalSeconds: Math.max(0, Math.floor(Number(clockData.totalSeconds) || 0)),
          date: typeof clockData.date === 'string' && clockData.date.trim() ? clockData.date.trim() : 'Day 1',
          lastSync: clockData.lastSync || Date.now()
        });
      }
    }

    // Ensure the primary (global or realm-global) clock exists
    if (!this.#agentClocks.has(primaryKey)) {
      this.#agentClocks.set(primaryKey, {
        totalSeconds: globalTotalSec,
        date: globalDate,
        lastSync: Date.now()
      });
    }

    // Hydrate agentEvents (entries were validated above)
    if (snapshot.agentEvents !== undefined) {
      for (const [agentKey, eventList] of Object.entries(snapshot.agentEvents)) {
        if (!inScope(agentKey)) continue;
        const partition = this.#getOrCreatePartition(agentKey);
        for (const ev of eventList) {
          partition.set(ev.id, {
            ...ev,
            ownerId: ev.ownerId || agentKey,
            createdBy: ev.createdBy || agentKey,
            metadata: ev.metadata && typeof ev.metadata === 'object' ? { ...ev.metadata } : {},
            repeatMinutes: typeof ev.repeatMinutes === 'number' ? ev.repeatMinutes : null,
            repeatSeconds: typeof ev.repeatSeconds === 'number' ? ev.repeatSeconds : null,
            resolvedAt: ev.resolvedAt !== undefined ? ev.resolvedAt : null,
            resolvedAtFormatted: ev.resolvedAtFormatted !== undefined ? ev.resolvedAtFormatted : null,
            resolvedBy: ev.resolvedBy !== undefined ? ev.resolvedBy : null,
            resolutionNote: ev.resolutionNote !== undefined ? ev.resolutionNote : null,
            cancelledAt: ev.cancelledAt !== undefined ? ev.cancelledAt : null,
            cancelledBy: ev.cancelledBy !== undefined ? ev.cancelledBy : null,
            cancellationReason: ev.cancellationReason !== undefined ? ev.cancellationReason : null
          });
        }
      }
    } else if (Array.isArray(snapshot.events)) {
      for (const ev of snapshot.events) {
        const owner = ev.ownerId ||
          (ev.scope === 'global' || ev.public ? primaryKey : (ev.createdBy || (ev as LegacySnapshotEvent).targetAgentId || primaryKey));
        if (!inScope(owner)) continue;
        const partition = this.#getOrCreatePartition(owner);
        partition.set(ev.id, {
          ...ev,
          ownerId: owner,
          createdBy: ev.createdBy || owner,
          metadata: ev.metadata && typeof ev.metadata === 'object' ? { ...ev.metadata } : {},
          repeatMinutes: typeof ev.repeatMinutes === 'number' ? ev.repeatMinutes : null,
          repeatSeconds: typeof ev.repeatSeconds === 'number' ? ev.repeatSeconds : null,
          resolvedAt: ev.resolvedAt !== undefined ? ev.resolvedAt : null,
          resolvedAtFormatted: ev.resolvedAtFormatted !== undefined ? ev.resolvedAtFormatted : null,
          resolvedBy: ev.resolvedBy !== undefined ? ev.resolvedBy : null,
          resolutionNote: ev.resolutionNote !== undefined ? ev.resolutionNote : null,
          cancelledAt: ev.cancelledAt !== undefined ? ev.cancelledAt : null,
          cancelledBy: ev.cancelledBy !== undefined ? ev.cancelledBy : null,
          cancellationReason: ev.cancellationReason !== undefined ? ev.cancellationReason : null
        });
      }
    }

    this.syncToVirtualFs(null, context);
    return { success: true };
  }
}
