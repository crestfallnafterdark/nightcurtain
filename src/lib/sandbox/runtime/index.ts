/**
 * @packageDocumentation
 * Interface Control Document — Module 13: runtime_coordinator
 * Canonical TypeScript Definitions
 *
 * Module 13 (`runtime_coordinator`) defines the canonical top-level execution facade
 * and integration engine for the multi-agent sandbox substrate. It consolidates foundational
 * Layer 0 primitives (`VirtualFS`, `MessagingBus`, `WorldClock`, `TriggerQueue`, `InvocationEngine`)
 * and Layer 2 runtime subsystems (`AgentLifecycleManager`, `TurnExecutionEngine`, `HistoryManager`,
 * `RuntimeScheduler`, `TriggerDispatcher`, `RuntimeTelemetryTracker`, `domain_director`) into a
 * unified, ergonomic, and strictly encapsulated API: `AgentRuntime`.
 *
 * Module `runtime_coordinator`.
 *
 * @module runtime
 * @mayImport ../domain/directorAgent/index.ts
 * @mayImport type-only ../credentialVault/index.ts
 * @mayImport type-only ../presetCatalog/index.ts
 * @invariant Facade-only access: `#agents`, `#recycleBin`, `#messageSubscriptions`, `#listeners`, and the subsystem engines are `#`-private; external consumers interact exclusively through validated `AgentRuntime` facade methods.
 * @invariant Realm-local identity: the active registry, recycle bin, per-agent message subscriptions, and telemetry are keyed by the canonical `(realmId, agentId)` identity key (`createAgentIdentityKey`), so the same literal id registers independently per Realm (system scope = its own namespace). Bare-id lookups (`getAgent`/`hasAgent`/lifecycle/`getAgentIdentity` without a scope) resolve the unique match across Realms and fail closed (`null`/not-found) when the id is ambiguous — never a wrong-Realm pick; `getAgentIdentity(agentId, scope)`/`listAgentIdentities(scope)` resolve and enumerate realm-exactly. Hydration computes each record's key from `config.realmId` and rejects a duplicate `(realmId, agentId)` with `ERR_SNAPSHOT_INVALID` before any state mutation. Wiring: the facade hands canonical keys to the bus lifecycle calls, the mail subscription, the trigger-queue enqueue paths (user turns, mail wakes, schedule expiry, invocation dispatch), and the scheduler/invocation teardown (`resolveAgentIdentityKey`), forwards a trusted `callerKey` through the scheduler and invocation caller contexts, and the turn engine binds `callerKey` plus the VFS-resolved private workspace on the tool execution context — so bus mailboxes, trigger partitions, scheduler owners, invocation records, VFS workspaces, and tool-boundary resolution all address the exact registration. Kill/purge pass the canonical key to `teardownForAgent`/`cancelPendingInvocationsForAgent`, and the runtime-constructed substrates receive the identity port at construction.
 * @invariant Realm-vocabulary agent ids: `launchAgent`/`spawnAgent` refuse any id carrying internal realm vocabulary (`realm:`/`system:` canonical-key segments, the seeded `realm_generic` registry id) with a uniform generic `PERMISSION_DENIED` for every caller — the denial never repeats the claim (no realm-existence oracle) — and the lifecycle descriptor projection omits the `workspace` label when the only value available would echo that vocabulary.
 * @invariant Snapshot export/import are synchronous and atomic over runtime state; malformed imports fail closed with `ERR_SNAPSHOT_INVALID`. Every direct import path normalizes hostile lifecycle claims (active entries hydrate IDLE; terminal/recycled claims route to the recycle bin) and re-derives authority default-deny: no record — the director included — is re-authorized from snapshot content. The composition root restores the persisted `realmBypass` grants explicitly through `restoreRealmBypassGrants` (the store owns the snapshot field). A hydrated config carrying a prototype-polluting key (`__proto__`/`constructor`/`prototype`, recursively) rejects the import without mutating the prior registry — the same policy the persistence validator enforces on the app restore path.
 * @invariant The `createSubsystemEmitPort` / `createPersistencePort` / `createLifecyclePort` / `createAgentIdentityPort` factories return frozen plain objects; no runtime or substrate instance is handed out.
 * @invariant Catalog subscription lifecycle (MOD-20): when a `ModelPresetSourcePort` is injected, the runtime subscribes exactly once after reaching READY; `reset()` unsubscribes and re-subscribes (the instance stays reusable), `destroy()` unsubscribes, and no path double-subscribes. The handler never rebuilds provider/model: `preset-updated` only marks every agent bound to that preset (active and recycled) dirty, and `preset-deleted` rewrites matching bindings to the catalog default and persists the rewrite, both materializing no earlier than the next turn start.
 * @decision `SubsystemEmitPort` is the frozen emit-only DI port handed to MOD-9/10/11/12 subsystem constructors; emit failures are swallowed and never propagate into subsystem execution
 * @decision `PersistencePort` is the frozen snapshot/import-only handoff from MOD-13 to MOD-6 via MOD-14; no mutation path beyond the declared import/restore calls
 * @decision `LifecyclePort` is the frozen facade-delegation port consumed by MOD-8 descriptors, including the `whoami`/`undoAgentTurn` additions
 * @decision `AgentIdentityPort` is the frozen identity-resolution surface injected as `ToolExecutionPort.getAgentIdentity` for MOD-8/MOD-10; it carries the agent's frozen registry `AuthorityDescriptor`, built once at launch from trusted config, never caller claims, plus the canonical `(realmId, agentId)` identity `key` and the realm-exact/bypass resolution scopes
 * @decision Realm scope rides the same frozen projection: every projection carries `realmId` (owner-controlled `config.realmId`, `null` = the bootstrap-only system scope) and `realmBypass`. `realmBypass` is `true` iff the registry authority inputs carry the `realmBypass` grant — the engine bootstrap's hardcoded composition or an operator grant through the lifecycle grant API — and is never derived from an agent id; the operator/engine branch of the locked bypass rule is the opaque `InternalPrincipal`, which substrates check by exact reference (it has no agent id and never appears here), and agent authority — including the wildcard `'*'` — never bypasses without a grant
 * @invariant Invocation and await Realm gates: the invocation engine receives the identity-port realm resolver and the opaque internal principal, so `invokeAgent` denies cross-scope pairs fail-closed (bypass principals span Realms) and `waitForInvocation` authenticates the facade/port-supplied caller as the invocation's invoker, its target, or a bypass principal; the agent-facing lifecycle port marks every wait as caller-scoped, so an unauthenticated wait fails closed, while `AgentRuntime.waitForInvocation` without a caller context stays the composition-root/host path. The operator/store listing path (`listAgents`/persistence port without a scope) stays unscoped.
 * @decision Authority is the frozen `AuthorityDescriptor` (`subject`/`kind`/`allow`/`visibility`/`realmBypass`) built once at construction from trusted config; there is no `privileged` boolean, admission is default-deny, reserved ids (`admin`/`director`/`system`) are ordinary identifiers, and every denial is uniform `PERMISSION_DENIED`
 * @decision Engine-internal privileged paths use the opaque branded `InternalPrincipal`: a plain object, a privilege-flag bundle, or a reserved id string cannot impersonate it
 * @decision Authority is never persisted: snapshots drop trust fields and restore re-derives descriptors from trusted config, downgrading tampered privilege claims to anonymous and failing closed on schema-invalid input
 * @decision Legacy caller-asserted authority (`isAdmin`/`isPrivileged`/`privileged` flags, authority-bearing `callerRole` values, reserved-id invocation magic) is ignored by the runtime core: lifecycle, invocation, and scheduler gates read only the registry `AuthorityDescriptor` / opaque `InternalPrincipal`, and only a `callerAgentId` identity claim is honored through registry resolution
 * @decision MOD-21 lifecycle gates are default-deny and mandatory: spawn capability selectors are sanitized, the descriptor `allow` surface is an immutable facade, parentage is authority-bearing, and purge/empty-recycle/cancel/restore/state/unstick/update resolve a trusted principal with engine paths bound to the internal principal
 * @decision Snapshot hydration is invariant-safe for lifecycle claims and authority-free: active/terminal claims are normalized before registry installation, every hydrated descriptor is default-deny (the director included — it is an ordinary id-holder and is adopted, never rebuilt or upgraded), and the composition root re-applies the persisted `realmBypass` grants through `restoreRealmBypassGrants`
 * @decision Agent snapshot (de)serialization consumes the MOD-9 entity contract `Agent.toSnapshot()`/`Agent.fromSnapshot()` instead of runtime-side agent-shape knowledge; consumers are MOD-6 and MOD-13 `importSnapshot`
 * @decision MOD-20 preset-source injection is additive plumbing: `AgentRuntimeOptions.presetSource` is stored and forwarded to every agent construction and hydration path, while a missing source or an unresolvable binding keeps the legacy settings-default resolution
 * @decision Preset-deleted rewrites are persisted through the lifecycle config-update path (`AgentLifecycleManager.updateAgentConfig`, emitting `agent_config_updated` for store autosave); recycled agents, unreachable through the active-registry update path, are persisted via a direct runtime emission of that same event, and the handler never calls `rebindModel()`
 * @decision The dead runtime-level `scheduledTimers` map was dropped; live timer state is `RuntimeScheduler.#scheduledTasks` and persistence flows through `exportSchedules()`/`importSchedules()` arrays
 */

/**
 * Modular Agent Runtime Subsystem Top-Level Engine Coordinator & Unified
 * Facade (Layer 2).
 *
 * Strictly exports `AgentRuntime`, `createAgentRuntime`, and `RUNTIME_STATUS`.
 */

import { VirtualFS } from '../virtualFs/index.ts';
import type { VirtualFsSnapshot } from '../virtualFs/index.ts';
import { MessagingBus } from '../messagingBus/index.ts';
import type { MessagingBusSnapshot } from '../messagingBus/index.ts';
import { WorldClock } from '../worldClock/index.ts';
import type { WorldClockSnapshot } from '../worldClock/index.ts';
import { TriggerQueue } from '../triggerQueue/index.ts';
import type { AgentTrigger } from '../triggerQueue/index.ts';
import { InvocationEngine } from '../invocationEngine/index.ts';

import { Agent } from './agent/index.ts';
import { createAgentIdentityKey, parseAgentIdentityKey } from './agent/index.ts';
import { AgentLifecycleManager } from './agentLifecycle/index.ts';
import { HistoryManager } from './historyManager/index.ts';
import { TurnExecutionEngine } from './turnExecutionEngine/index.ts';
import { RuntimeScheduler } from './runtimeScheduler/index.ts';
import { TriggerDispatcher, TRIGGER_TYPES } from './triggerDispatcher/index.ts';
import { RuntimeTelemetryTracker } from './runtimeTelemetry/index.ts';
import { ensureDirectorAgent } from '../domain/directorAgent/index.ts';

import type { CredentialResolverPort } from '../credentialVault/index.ts';
import type { ModelPresetSourcePort, PresetChangeEvent } from '../presetCatalog/index.ts';
import type { RealmPublishingPort } from '../toolDefinitions/index.ts';
import type { MessageEnvelope, WaitForMailOptions, WaitForMailResult } from '../messagingBus/index.ts';
import type {
  InvocationCallerContext,
  InvocationReceipt,
  InvokeAgentOptions,
  TurnExecutionContext,
  WaitForInvocationOptions,
  WaitForInvocationRequest,
  WaitForInvocationResult
} from '../invocationEngine/index.ts';
import type {
  AgentConfig,
  AgentDescriptor,
  AgentState,
  AgentTelemetry,
  HistoryMessage,
  LaunchAgentOptions,
  MessageUpdateFields,
  RedoTurnResult,
  SerializedAgent,
  UndoTurnResult
} from './agent/index.ts';
import type { UndoTurnSelectionFailure } from './historyManager/index.ts';
import type {
  CancelScheduleParams,
  CancelScheduleReceipt,
  ListSchedulesOptions,
  ScheduleParams,
  ScheduleReceipt,
  ScheduledTaskProjection,
  SerializedScheduledTimer
} from './runtimeScheduler/index.ts';
import type { AgentTelemetryMetrics, RuntimeTelemetry } from './runtimeTelemetry/index.ts';
import type {
  TurnExecutionOptions,
  TurnExecutionResult,
  TurnInput
} from './turnExecutionEngine/index.ts';
import type { DirectorRuntimeHost } from '../domain/directorAgent/index.ts';

// ============================================================================
// Public Type Re-exports (contract aliases)
// ============================================================================

/**
 * Canonical internal identity key helpers (Wave I, ticket d57cbc1): the single
 * owner of the composite `(realmId, agentId)` registration key that the
 * runtime, lifecycle, telemetry, and message-subscription registries key on.
 *
 * Internal engine vocabulary: substrate/store consumers derive keys from these
 * helpers (or read {@link AgentIdentityProjection.key}); the string is never
 * exposed on an agent-facing surface. Kept on the runtime module surface so
 * substrate sweep lanes never reimplement the encoding.
 */
export { createAgentIdentityKey, parseAgentIdentityKey } from './agent/index.ts';

/**
 * Re-exported canonical await envelope returned by `AgentRuntime.waitForInvocation`
 * (and `LifecyclePort.waitForInvocation`), so facade consumers can name the
 * documented result type without importing the leaf module directly.
 */
export type { WaitForInvocationResult } from '../invocationEngine/index.ts';

/**
 * Agent entity configuration declaration.
 *
 * Re-exported from the canonical domain contract (`runtime/agent`); this is the
 * exact configuration shape consumed by `launchAgent()` and `updateAgentConfig()`.
 */
export type { AgentConfig } from './agent/index.ts';

/**
 * Agent summary descriptor returned by `LifecyclePort.listAgentDescriptors`.
 *
 * Re-exported from the canonical domain contract (`runtime/agent`); the reduced
 * summary shape (`id`, `name`, `state`, `role`, `triggerPolicy`, `unreadCount`,
 * `allowedTools`, `workspace`) carries no entity internals (`history`, `config`,
 * `modelConfig`, `provider`, `model`).
 */
export type { AgentDescriptor } from './agent/index.ts';

/**
 * Re-exported agent state string type from agent domain module.
 */
export type { AgentState } from './agent/index.ts';

/**
 * Input payload supplied for turn execution. Can be a text prompt, structured
 * `TurnInputObject`, array of messages, or `null` for an autonomous mail wake.
 *
 * Re-exported from the canonical turn execution contract (`runtime/turnExecutionEngine`).
 */
export type { TurnInput } from './turnExecutionEngine/index.ts';

/**
 * Execution options passed when triggering an agent turn via `executeAgentTurn()`.
 *
 * Re-exported from the canonical turn execution contract (`runtime/turnExecutionEngine`):
 * supports `signal`, `mode`/`category`, `triggerType`, `autoTrigger`, `model`,
 * `sender`, `metadata`, `priority`, `depth`, and `onChunk`.
 */
export type { TurnExecutionOptions } from './turnExecutionEngine/index.ts';

/**
 * Result payload returned upon completion of an agent turn.
 *
 * Re-exported from the canonical turn execution contract (`runtime/turnExecutionEngine`):
 * `executeAgentTurn` either resolves a standardized receipt (`status`, `output`,
 * canonical `ToolCallRecord` list, `summary`, `metadata`) or rethrows the
 * underlying model or tool error unchanged.
 */
export type { TurnExecutionResult } from './turnExecutionEngine/index.ts';

/**
 * Public agent surface rendered by the turn execution engine.
 *
 * Re-exported from the canonical turn execution contract
 * (`runtime/turnExecutionEngine`) so facade consumers can name the agent
 * interface carried by `TurnExecutionResult.agent` and the engine's public
 * contracts without importing the leaf module directly.
 */
export type { TurnExecutionAgent } from './turnExecutionEngine/index.ts';

/**
 * Mutable fields supported when updating a history message in-place via `updateHistoryMessage()`.
 *
 * Re-exported from the canonical history contract (`runtime/agent`): updates
 * `content`, `reasoning_content` (alias `reasoning`), and shallow-merges `metadata`.
 */
export type { MessageUpdateFields } from './agent/index.ts';

/**
 * Canonical ledger message entity stored in an agent's history.
 *
 * Re-exported from the canonical domain contract (`runtime/agent`); this is the
 * exact object stored in `Agent.history` and returned by `updateHistoryMessage()`.
 */
export type { HistoryMessage } from './agent/index.ts';

/**
 * Trusted baked-history entry accepted by the unified `launchAgent` options
 * (Realm Template Format v1 §3.5; Wave T, ticket 7e6edae).
 *
 * Re-exported from the canonical domain contract (`runtime/agent`) so store and
 * UI consumers can name the declared-prologue shape without importing the leaf
 * module. Entries are seeded at launch as `[system, ...declared]` with
 * launch-generated ids and no model call.
 */
export type { LaunchHistoryEntry } from './agent/index.ts';

/**
 * Result returned by `undoAgentTurn()`.
 *
 * Alias of the canonical history contract `UndoTurnResult` (`runtime/agent`), the
 * exact value returned by `HistoryManager.undoAgentTurn`.
 */
export type { UndoTurnResult as UndoResult } from './agent/index.ts';

/**
 * Result returned by `redoAgentTurn()`.
 *
 * Alias of the canonical history contract `RedoTurnResult` (`runtime/agent`), the
 * exact value returned by `HistoryManager.redoAgentTurn`.
 */
export type { RedoTurnResult as RedoResult } from './agent/index.ts';

/**
 * Parameter descriptor for scheduling a deferred one-shot execution turn.
 *
 * Re-exported from the canonical scheduler contract (`runtime/runtimeScheduler`):
 * a `prompt` is required, one-shot delays use `durationSeconds` (aliases
 * `delay_seconds`/`delaySeconds`), and `timerCondition` controls message-driven
 * early cancellation. The target resolves from `agentId`, then `targetAgentId`.
 */
export type { ScheduleParams } from './runtimeScheduler/index.ts';

/**
 * Result returned by `schedule()`.
 *
 * Alias of the canonical scheduler receipt `ScheduleReceipt`
 * (`runtime/runtimeScheduler`). Narrow on `success`: the success variant carries
 * `timerId`/`fireAt`/`prompt`, while the failure variant carries `code`/`error`.
 */
export type { ScheduleReceipt as ScheduleResult } from './runtimeScheduler/index.ts';

/**
 * Parameter descriptor for cancelling a scheduled task.
 *
 * Re-exported from the canonical scheduler contract (`runtime/runtimeScheduler`);
 * the timer ID resolves from `timerId`, `task_id`, `taskId`, then `id`.
 */
export type { CancelScheduleParams } from './runtimeScheduler/index.ts';

/**
 * Result returned by `cancelSchedule()`.
 *
 * Alias of the canonical scheduler receipt `CancelScheduleReceipt`
 * (`runtime/runtimeScheduler`): the success variant carries `timerId` and
 * `cancelledAt` (with idempotent `alreadyCancelled`), the failure variant
 * carries `code`/`error`.
 */
export type { CancelScheduleReceipt as CancelScheduleResult } from './runtimeScheduler/index.ts';

/**
 * Filter criteria for querying scheduled tasks via `listSchedules()`.
 *
 * Alias of the canonical scheduler filter `ListSchedulesOptions`
 * (`runtime/runtimeScheduler`): `agentId` and `status` (`'all'` or a
 * `SchedulerStatus`).
 */
export type { ListSchedulesOptions as ScheduleFilterOptions } from './runtimeScheduler/index.ts';

/**
 * Serialized snapshot of an individual scheduled task for persistence.
 *
 * Alias of the canonical `SerializedScheduledTimer` record
 * (`runtime/runtimeScheduler`) emitted by `exportSchedules()` and accepted by
 * `importSchedules()`.
 */
export type { SerializedScheduledTimer as ScheduledTaskSnapshot } from './runtimeScheduler/index.ts';

/**
 * Options passed when initiating a subagent RPC invocation via `invokeAgent()`.
 *
 * Alias of the canonical invocation contract `InvokeAgentOptions`
 * (`invocationEngine`): `role`, `depth` (legacy `recursionDepth`), `timeoutMs`
 * (alias `timeout_ms`), and ignored authority flags
 * (`isPrivileged`/`privileged`, `isAdmin`, `callerRole`). Invoker authority
 * resolves solely from the registry `AuthorityDescriptor` (MOD-21 W3).
 */
export type { InvokeAgentOptions as InvocationOptions } from '../invocationEngine/index.ts';

/**
 * Options passed when awaiting subagent RPC invocations via `waitForInvocation()`.
 *
 * Re-exported from the canonical invocation contract (`invocationEngine`):
 * `timeoutMs` (alias `timeout_ms`), `requireAll` (alias `require_all`), and
 * `signal`.
 */
export type { WaitForInvocationOptions } from '../invocationEngine/index.ts';

/**
 * Structured request envelope accepted by `waitForInvocation()` for array and
 * alias ID forms (`invocationIds`, `invocationId`, `ids`, `id`) plus await options.
 *
 * Re-exported from the canonical invocation contract (`invocationEngine`).
 */
export type { WaitForInvocationRequest } from '../invocationEngine/index.ts';

/**
 * Options passed when awaiting mailbox message delivery via `waitForMail()`.
 *
 * Re-exported from the canonical messaging bus contract (`messagingBus`):
 * `senders` (`sender`/`from` aliases), `timeoutMs` (`timeout_ms`/`timeout`),
 * `requireAll` (`require_all`), `markAsRead` (`mark_as_read`), `includeRead`
 * (`include_read`), `since` (`sinceTimestamp`), and `signal` (`abortSignal`).
 */
export type { WaitForMailOptions } from '../messagingBus/index.ts';

/**
 * Result returned upon resolution of `waitForMail()`.
 *
 * Re-exported from the canonical messaging bus contract (`messagingBus`)
 * so the facade declaration matches the real bus return value: a discriminated
 * union on `success`. Narrow on `success` before reading delivery projection
 * fields (`messages`, `count`, `receivedSenders`, `missingSenders`); the
 * failure variant carries `code` and `error` instead.
 */
export type { WaitForMailResult } from '../messagingBus/index.ts';

/**
 * Cumulative token consumption and profiling telemetry for an individual agent.
 *
 * Alias of the canonical runtime telemetry snapshot `AgentTelemetryMetrics`
 * (`runtime/runtimeTelemetry`), the frozen object actually returned by
 * `getAgentTelemetry()` (including `toolExecutionCount`, `lastSentContext`,
 * and `lastUpdated`).
 */
export type { AgentTelemetryMetrics as AgentTelemetry } from './runtimeTelemetry/index.ts';

/**
 * Serialized representation of an individual agent for state snapshot persistence.
 *
 * Alias of the canonical entity snapshot `SerializedAgent` (`runtime/agent`)
 * produced by `Agent.toSnapshot()` and consumed by `Agent.fromSnapshot()`,
 * including the emitted `state`, `stateDetail`, and `lastSummary` fields.
 */
export type { SerializedAgent as AgentSnapshot } from './agent/index.ts';

// ============================================================================
// Authority Model
// ============================================================================

/**
 * Frozen authority descriptor — the single representation of authority for
 * every sandbox principal, agent or engine-internal.
 *
 * Ratified model (`MOD-21`, umbrella ticket `90ad905`):
 * - **Trusted construction only.** The descriptor is built once at construction
 *   from trusted configuration (agent config, operator grants, composition
 *   roots). It is never assembled from caller-supplied data and never mutated;
 *   `allow` is a frozen read-only snapshot-closure facade (own reads over a
 *   private member-name array; `Set.prototype` retained only for `instanceof`)
 *   on a frozen object.
 * - **No `privileged` boolean.** Authority is `subject` identity plus an
 *   explicit `allow` set of canonical tool/op names; the wildcard `'*'` permits
 *   every operation. The serialized allow-list keeps the name `allowedTools`.
 * - **Default-deny.** A missing, unknown, or unauthenticated principal is
 *   anonymous and receives no non-innate capability.
 * - **Uniform denial.** Every authorization failure surfaces as
 *   `PERMISSION_DENIED`; no differentiated channel exposes the check.
 * - **Reserved ids grant nothing.** `admin`, `director`, and `system` are
 *   ordinary identifier strings: the names carry no authority and no reserved
 *   meaning anywhere.
 * - **`realmBypass` is a grant, never id-derived.** The field records whether
 *   the principal spans every Realm scope (engine bootstrap or an operator
 *   grant/revoke through the lifecycle API); it is orthogonal to the
 *   `privileged`/`allow` capability axis and can never be set through a
 *   launch/spawn/update caller path.
 * - **Snapshots re-derive trust.** Authority fields are not persisted; restore
 *   rebuilds descriptors from trusted configuration, downgrades tampered
 *   privilege claims to anonymous, and fails closed on schema-invalid input.
 *
 * @example
 * ```typescript
 * const operator: AuthorityDescriptor = Object.freeze({
 *   subject: 'operator',
 *   kind: 'internal',
 *   allow: new Set(['*']),
 *   visibility: 'system',
 *   realmBypass: true
 * });
 * ```
 */
export interface AuthorityDescriptor {
  /** Stable principal identifier (`agent.id`, or an engine-owned internal name). */
  readonly subject: string;
  /** Principal class: a registered `agent` or an engine-internal path. */
  readonly kind: 'agent' | 'internal';
  /** Frozen read-only allow-set facade of canonical tool/op names the principal may invoke; the wildcard `'*'` permits everything. */
  readonly allow: ReadonlySet<string>;
  /** Read scope for descriptor and introspection surfaces: `self`, `owned`, `all`, or `system`. */
  readonly visibility: 'self' | 'owned' | 'all' | 'system';
  /**
   * Whether the principal spans every Realm scope (a `realmBypass` grant).
   *
   * Trusted construction output only: the engine bootstrap composes it on the
   * internal-principal launch path, and the lifecycle grant/revoke API
   * (`grantRealmBypass`/`revokeRealmBypass`) rebuilds the descriptor for
   * operator grants. The wildcard capability axis is orthogonal — an agent
   * with `'*'` and no grant stays Realm-bound, and a granted agent keeps its
   * capability set.
   */
  readonly realmBypass: boolean;
}

/**
 * Non-exported nominal brand for the opaque engine `InternalPrincipal`. It is
 * deliberately module-private: no consumer can construct a branded instance,
 * and subsystem trust checks compare by reference identity only.
 * @internal
 */
const INTERNAL_PRINCIPAL_BRAND: unique symbol = Symbol('sandbox.internal-principal');

/**
 * Opaque engine principal used by trusted internal paths (telemetry, timer
 * cancellation, clock ticks, virtual-filesystem sync).
 *
 * The brand symbol is intentionally not exported: a plain object, a
 * privilege-flag bundle, or a reserved `system` string cannot satisfy this type
 * or impersonate the principal at runtime. Composition roots hold the single
 * frozen instance and pass it by reference; `subject` is diagnostic only and
 * grants no authority.
 *
 * @example
 * ```typescript
 * function cancelAllForShutdown(principal: InternalPrincipal): void {
 *   // Only the injected instance is accepted; flags and `system` ids are not.
 *   scheduler.cancelAll(principal);
 * }
 * ```
 */
export interface InternalPrincipal {
  /** Non-exported nominal brand; plain objects cannot satisfy the type. */
  readonly [INTERNAL_PRINCIPAL_BRAND]: 'internal-principal';
  /** Principal class discriminator. */
  readonly kind: 'internal';
  /** Engine-owned internal subject name (diagnostic only; the name grants no authority). */
  readonly subject: string;
}

// ============================================================================
// 5.1 Enums & Literal Types
// ============================================================================

/**
 * Immutable lifecycle states for the top-level AgentRuntime engine.
 *
 * The runtime transitions deterministically through these states:
 * - `UNINITIALIZED`: Initial pre-construction state before subsystem wiring.
 * - `INITIALIZING`: Transient synchronous construction window while substrates and subsystems are wired; the constructor returns in `READY`, and Director auto-bootstrap (when enabled) starts only after `READY` is set.
 * - `READY`: Normal operational idle state; ready to launch agents and execute turns.
 * - `RUNNING`: One or more agents are actively executing turns or background trigger loops.
 * - `DESTROYED`: Engine permanently torn down; timers cancelled and subscriptions cleared.
 *
 * @readonly
 * @example
 * ```typescript
 * import { RUNTIME_STATUS, createAgentRuntime } from './runtime/index.ts';
 *
 * const runtime = createAgentRuntime();
 * if (runtime.status === RUNTIME_STATUS.READY) {
 *   console.log('Runtime engine is ready for agent execution.');
 * }
 * ```
 */
export const RUNTIME_STATUS: {
  readonly UNINITIALIZED: 'uninitialized';
  readonly INITIALIZING: 'initializing';
  readonly READY: 'ready';
  readonly RUNNING: 'running';
  readonly DESTROYED: 'destroyed';
} = Object.freeze({
  UNINITIALIZED: 'uninitialized',
  INITIALIZING: 'initializing',
  READY: 'ready',
  RUNNING: 'running',
  DESTROYED: 'destroyed'
});

/**
 * Type representing one of the canonical runtime engine lifecycle states.
 */
export type RuntimeStatus = typeof RUNTIME_STATUS[keyof typeof RUNTIME_STATUS];

/**
 * Standardized runtime error codes assigned by the `AgentRuntime` facade itself.
 *
 * Delegated subsystems assign their own canonical codes (for example the lifecycle
 * manager's `AGENT_NOT_FOUND`, `INVALID_CONFIG`, `AGENT_ALREADY_EXISTS`, and
 * `INVALID_STATE_TRANSITION` receipts); this union covers only the codes the
 * facade throws directly.
 *
 * - `ERR_RUNTIME_NOT_INITIALIZED`: Defensive guard on `invokeAgent`/`waitForInvocation`/`waitForMail` for a missing substrate reference. The constructor always wires both substrates, so this code is unreachable through the public API.
 * - `ERR_RUNTIME_NOT_READY`: Thrown by `executeAgentTurn`/`retryAgentTurn` when status is neither `READY` nor `RUNNING`, and by `launchAgent`/`ensureDirector` when status is `UNINITIALIZED` (both accept `READY`, `RUNNING`, and `INITIALIZING`).
 * - `ERR_RUNTIME_DESTROYED`: Thrown by the guarded lifecycle, scheduling, turn, history, and snapshot operations on a destroyed instance. Read-only queries (`getAgent`, `hasAgent`, `listAgents`, `getAgentCount`, `listRecycledAgents`, `getRuntimeMetrics`, `subscribe`/`on`) keep answering.
 * - `ERR_AGENT_NOT_FOUND`: Passing an agentId that does not exist to the facade's own `whoami` lookup.
 * - `ERR_SNAPSHOT_INVALID`: Passing corrupted, non-conforming, or unparseable snapshot data to importSnapshot; the prior registry is left untouched.
 */
export type RuntimeErrorCode =
  | 'ERR_RUNTIME_NOT_INITIALIZED'
  | 'ERR_RUNTIME_NOT_READY'
  | 'ERR_RUNTIME_DESTROYED'
  | 'ERR_AGENT_NOT_FOUND'
  | 'ERR_SNAPSHOT_INVALID';

/**
 * Error carrying an optional machine-readable runtime error code.
 */
type CodedError = Error & { code?: string };

/**
 * Internal helper to create standard Error instances with error codes.
 * @internal
 */
function createRuntimeError(message: string, code: string): CodedError {
  const error: CodedError = new Error(message);
  error.code = code;
  return error;
}

/**
 * Renders an unknown thrown value for an error message, preferring a truthy
 * `message` property when one is present (the previous dynamic behavior).
 * @internal
 */
function describeThrownValue(err: unknown): string {
  if (err && (typeof err === 'object' || typeof err === 'function') && 'message' in err) {
    const message = err.message;
    if (message) return String(message);
  }
  return String(err);
}

// ============================================================================
// 5.2 Input Options & Configuration Schemas
// ============================================================================

/**
 * Initialization options accepted by `createAgentRuntime` and the `AgentRuntime` constructor.
 * Allows dependency injection of shared Layer 0 primitives or custom tool descriptors.
 *
 * @example
 * ```typescript
 * import { createAgentRuntime } from './runtime/index.ts';
 * import { VirtualFS } from '../virtualFs/index.ts';
 * import { MessagingBus } from '../messagingBus/index.ts';
 *
 * const customFs = new VirtualFS({ defaultBudgetBytes: 50000 });
 * const customBus = new MessagingBus();
 *
 * const runtime = createAgentRuntime({
 *   virtualFs: customFs,
 *   messagingBus: customBus,
 *   autoBootstrapDirector: true,
 *   mailboxAutonomy: true
 * });
 * ```
 */
export interface AgentRuntimeOptions {
  /** Shared virtual filesystem instance (defaults to new VirtualFS(\{ defaultBudgetBytes: 20000 \})) */
  virtualFs?: VirtualFS | null;
  /** Shared messaging bus instance (defaults to new MessagingBus()) */
  messagingBus?: MessagingBus | null;
  /** Shared world clock instance (defaults to new WorldClock(\{ virtualFs \})) */
  worldClock?: WorldClock | null;
  /** Standalone invocation engine instance (defaults to new InvocationEngine()) */
  invocationEngine?: InvocationEngine | null;
  /** Flag controlling autonomous mailbox dequeue on agent idle (null to inherit default) */
  mailboxAutonomy?: boolean | null;
  /**
   * Optional registry of operator/host-registered custom tool handlers,
   * forwarded unchanged to the turn execution engine.
   *
   * Host-only contract (A0-5, ticket 0443865): custom tools are
   * operator/host-registered, never model-registered — provider function/JSON
   * input cannot add entries, and Realms never register custom tools (the
   * registry is operator-global, shared by every agent this runtime
   * provisions). Each custom-handler invocation is authorized by the turn
   * execution engine against the caller's frozen `AuthorityDescriptor`
   * (wildcard `'*'` or `'@lifecycle:authority'`, or an engine-internal
   * principal); a matching `allowedTools` entry does not authorize custom
   * execution. See `TurnExecutionEngineOptions.customTools` in
   * `runtime/turnExecutionEngine/index.ts`.
   */
  customTools?: Record<string, unknown> | null;
  /** If true, automatically provisions the Director meta-agent during initialization */
  autoBootstrapDirector?: boolean;
  /**
   * Optional read-only credential resolver (MOD-16) handed to every agent this
   * runtime provisions. When absent, provider construction proceeds with no
   * credentials — there is no singleton vault fallback.
   */
  credentialResolver?: CredentialResolverPort | null;
  /**
   * Optional MOD-20 preset-source projection handed to every agent this runtime
   * provisions and hydrates. When supplied, a resolvable `presetId` binding
   * determines the agent's effective model config (binding-only) and missing or
   * stale hydration bindings heal to the source default; when absent, agents
   * keep the legacy settings-default resolution.
   */
  presetSource?: ModelPresetSourcePort | null;
  /**
   * Optional Wave U host publishing port handed to the turn execution engine
   * and seeded into every tool dispatcher context (ticket 2518510). The
   * composition root (sandbox store) implements it over the real Wave T
   * template registry and session candidate surface; when absent, the
   * publishing meta tools fail closed with a missing-service error. The port
   * is trusted bound construction and is never replaceable from per-call
   * context.
   */
  realmPublishingPort?: RealmPublishingPort | null;
}

/**
 * Configuration payload for launching, spawning, or provisioning an agent in the runtime.
 *
 * Alias of the canonical lifecycle configuration `AgentConfig` (`runtime/agent`)
 * accepted by `AgentLifecycleManager.launchAgent`; model, tool, and creator
 * metadata resolution follows that contract.
 *
 * @example
 * ```typescript
 * const config: AgentLaunchConfig = {
 *   id: 'narrator_agent',
 *   name: 'Story Narrator',
 *   role: 'writer',
 *   systemPrompt: 'You are the principal storyteller for an epic adventure.',
 *   allowedTools: ['read_file', 'write_file', 'send_message'],
 *   workspaceId: 'narrator_ws',
 *   privileged: false,
 *   modelConfig: { temperature: 0.7, modelId: 'gpt-4o' }
 * };
 * await runtime.launchAgent(config);
 * ```
 */
export type AgentLaunchConfig = AgentConfig;

/**
 * Partial configuration for updating an existing agent's settings dynamically.
 */
export type AgentConfigUpdate = Partial<AgentConfig>;

/**
 * Filter criteria for querying registered active or recycled agents in the runtime.
 *
 * @example
 * ```typescript
 * const workers = runtime.listAgents({
 *   role: 'worker',
 *   state: 'idle',
 *   includeRecycled: false
 * });
 * ```
 */
export interface AgentFilterOptions {
  /** Filter by lifecycle state (e.g. 'idle', 'running', 'waiting_for_dependents') */
  state?: string;
  /** Filter by role (e.g. 'director', 'worker', 'reviewer') */
  role?: string;
  /**
   * Filter by creator ID. Matches either `config.spawnedBy` or
   * `config.creatorId`. A falsy value disables the filter (no creator-less
   * filter is exposed).
   */
  spawnedBy?: string;
  /**
   * Realm scope filter (Realm wave A, ticket 3487c56): when the property is
   * present, only agents whose resolved membership equals this value are
   * listed (`null` selects ungrouped agents). Omit the property for the
   * unscoped operator/store listing.
   */
  realmId?: string | null;
  /** If true, includes soft-killed / recycled agents in query */
  includeRecycled?: boolean;
}

/**
 * Identity and permission descriptor returned by `AgentRuntime.whoami()`.
 * Summarizes the agent's identifier, permissions, active workspace, and lifecycle state.
 *
 * @example
 * ```typescript
 * const identity = runtime.whoami('director');
 * console.log(`Agent ${identity.name} has role ${identity.role}, privileged: ${identity.privileged}`);
 * ```
 */
export interface AgentIdentityDescriptor {
  /** Unique agent identifier */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Role string */
  role: string;
  /**
   * Administrative privilege status.
   *
   * Legacy boolean projection of `config.privileged` retained for wire
   * compatibility; authority decisions read the runtime registry
   * `AuthorityDescriptor`, and this boolean remains the fallback only for hosts
   * whose identity projection lacks `authority`.
   */
  privileged: boolean;
  /** Assigned workspace directory identifier */
  workspaceId: string;
  /** List of permitted tool names */
  allowedTools: string[];
  /** Current FSM lifecycle state */
  state: string;
  /**
   * Creator agent ID (`config.spawnedBy`, falling back to `config.creatorId`);
   * `null` when the agent is creator-less (system/runtime-launched, e.g. the
   * root Director).
   */
  spawnedBy: string | null;
  /** Epoch millisecond creation timestamp */
  createdAt: number;
}

/**
 * Contextual metadata regarding the caller initiating an action, used for permission checks.
 *
 * Trust boundary (MOD-21 W3 enforced): this is caller-supplied data. The
 * authority-bearing flags below are IGNORED by the runtime — authority comes
 * only from the registry `AuthorityDescriptor` resolved for `callerAgentId` (or
 * from an explicit `{ principal }` trusted reference). Reserved ids and
 * authority-looking roles grant nothing.
 *
 * @example
 * ```typescript
 * const caller: CallerContext = {
 *   callerAgentId: 'director'
 * };
 * runtime.killAgent('rogue_worker', 'Unauthorized task', caller);
 * ```
 */
export interface CallerContext {
  /** Identifier of the calling agent; the registry descriptor for this id is the authority source */
  callerAgentId?: string;
  /**
   * Role of the calling agent.
   * @deprecated Ignored by the W3-enforced runtime; roles are metadata only.
   */
  callerRole?: string;
  /**
   * Whether caller holds administrative access.
   * @deprecated Ignored by the W3-enforced runtime; authority comes from the registry descriptor.
   */
  isAdmin?: boolean;
  /**
   * Whether caller holds privileged execution rights.
   * @deprecated Ignored by the W3-enforced runtime; authority comes from the registry descriptor.
   */
  isPrivileged?: boolean;
}

// ============================================================================
// 5.3 Turn Execution & History Types
// ============================================================================

/**
 * Result returned by emergency unstick routine `unstickAgent()`.
 */
export interface UnstickResult {
  /** True if agent unstick operation succeeded */
  success: boolean;
  /** Target agent instance */
  agent: Agent;
  /** State the agent occupied prior to unsticking */
  previousState: AgentState;
  /** Diagnostic reason provided for unsticking */
  reason: string;
}

// ============================================================================
// 5.4 Scheduling & Invocations
// ============================================================================

/**
 * Result returned by `listSchedules()`.
 *
 * Mirrors the canonical `RuntimeScheduler.listSchedules` envelope: always a
 * success envelope carrying defensive `ScheduledTaskProjection` copies
 * (frozen, with per-call `remainingSeconds` countdowns).
 */
export interface ScheduleListResult {
  /** Always `true`; `listSchedules` never returns a failure receipt. */
  readonly success: true;
  /** Matching defensive scheduled-task projections. */
  readonly schedules: ScheduledTaskProjection[];
}

// ============================================================================
// 5.5 Telemetry & Events
// ============================================================================

/**
 * System-wide aggregate performance and token metrics across all registered agents.
 *
 * @example
 * ```typescript
 * const metrics = runtime.getRuntimeMetrics();
 * console.log(`Active Agents: ${metrics.totalActiveAgents}, Total Turns: ${metrics.totalTurnsExecuted}`);
 * ```
 */
export interface RuntimeAggregateMetrics {
  /** Count of currently active registered agents */
  totalActiveAgents: number;
  /** Count of soft-killed agents residing in the recycle bin */
  totalRecycledAgents: number;
  /** Cumulative turn count across all agents */
  totalTurnsExecuted: number;
  /** Cumulative token count across all agents */
  totalTokensConsumed: number;
  /** Runtime engine uptime in seconds */
  uptimeSeconds: number;
  /** Count of currently active scheduled timers */
  activeTimersCount: number;
}

/**
 * Structured event payload emitted by the runtime event bus to subscribers.
 *
 * @example
 * ```typescript
 * runtime.subscribe((event) => {
 *   if (event.type === 'state_change') {
 *     console.log(`Agent ${event.agentId} changed state to ${event.payload?.currentState}`);
 *   }
 * });
 * ```
 */
export interface RuntimeEvent {
  /** Event identifier string (e.g. 'state_change', 'turn_complete', 'state_restored') */
  type: string;
  /** Epoch millisecond timestamp when event occurred */
  timestamp: number;
  /** Agent ID associated with event, if applicable */
  agentId?: string;
  /** Contextual event payload */
  payload?: Record<string, unknown>;
  /** Additional event-specific fields attached by the emitter; their shape varies by `type`. */
  [key: string]: unknown;
}

/**
 * Event listener callback invoked when runtime events are emitted.
 */
export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * Function returned by subscription methods to safely detach a listener.
 */
export type UnsubscribeFn = () => void;

// ============================================================================
// 5.6 Snapshot Persistence Schema
// ============================================================================

/**
 * Root serialized snapshot payload capturing complete runtime state for persistence and disaster recovery.
 *
 * @example
 * ```typescript
 * const snapshot = runtime.exportSnapshot();
 * localStorage.setItem('runtime_backup', JSON.stringify(snapshot));
 *
 * const restoredSnapshot = JSON.parse(localStorage.getItem('runtime_backup')!);
 * runtime.importSnapshot(restoredSnapshot);
 * ```
 */
export interface RuntimeSnapshot {
  /** Engine operational status at snapshot time */
  status: RuntimeStatus;
  /** Array of serialized active agent snapshots */
  agents: SerializedAgent[];
  /** Array of serialized recycled agent snapshots */
  recycleBin: SerializedAgent[];
  /**
   * Array of `exportSchedules()` records: the canonical `SerializedScheduledTimer`
   * schema plus backward-compatibility alias fields emitted by `RuntimeScheduler`
   * (`timerId`, `targetAgentId`, `durationSeconds`, `prompt`,
   * `timerCondition`, `scheduledAt`, `fireAt`, `cancelReason`). Consumers should
   * rely on the canonical fields; `importSchedules` accepts either form.
   */
  scheduledTimers: SerializedScheduledTimer[];
  /** Epoch millisecond export timestamp */
  exportedAt: number;
}

// ============================================================================
// 5.7 AgentRuntime Facade Interface
// ============================================================================

/**
 * Canonical frozen emitter port handed to internal runtime subsystems.
 * Subsystems emit through this port instead of reaching into `AgentRuntime`.
 */
export interface SubsystemEmitPort {
  /**
   * Emits an event to every listener registered through `AgentRuntime.subscribe`.
   * Delivery is synchronous and listener exceptions are caught and logged, so they
   * never propagate back into the emitting subsystem.
   *
   * @param event - Event to broadcast; `type` identifies the event and
   *   `timestamp` is an epoch millisecond value supplied by the emitter.
   */
  emit(event: { type: string; timestamp: number; payload?: unknown }): void;
}

/**
 * Canonical frozen persistence port; exposes only snapshot/import capabilities,
 * never the runtime instance.
 */
export interface PersistencePort {
  /**
   * Frozen runtime-state accessor. Delegates agent registry queries and
   * schedule/snapshot export-import to the facade without exposing the
   * `AgentRuntime` instance; malformed snapshots fail closed with
   * `ERR_SNAPSHOT_INVALID`.
   */
  runtime: {
    listAgents(): Agent[];
    listRecycledAgents(): Agent[];
    exportSchedules(): unknown[];
    importSchedules(schedules: unknown[]): void;
    importSnapshot(snapshot: unknown): void;
  };
  /** Frozen snapshot accessor for the shared `VirtualFS` substrate. */
  virtualFs: { exportSnapshot(): unknown; importSnapshot(snapshot: unknown): void };
  /** Frozen snapshot accessor for the shared `MessagingBus` substrate. */
  messagingBus: { exportSnapshot(): unknown; importSnapshot(snapshot: unknown): void };
  /** Frozen snapshot accessor for the shared `WorldClock` substrate. */
  worldClock: { exportSnapshot(): unknown; importSnapshot(snapshot: unknown): void };
}

/**
 * Canonical frozen lifecycle port consumed by tool descriptors.
 */
export interface LifecyclePort {
  /**
   * Schedules a deferred task via `AgentRuntime.schedule`, forwarding `params`
   * and the trusted `context` unchanged. Privilege, caller identity, and Realm
   * scope are read only from `context`.
   */
  schedule(params: object, context?: object): object;
  /**
   * Lists scheduled tasks via `AgentRuntime.listSchedules`, forwarding `options`
   * and the trusted `context` unchanged. Privilege and caller identity are read
   * only from `context`.
   */
  listSchedules(options?: object, context?: object): object;
  /**
   * Cancels a scheduled task via `AgentRuntime.cancelSchedule`, forwarding the
   * diagnostic `reason` and the trusted `context` unchanged. Privilege and
   * caller identity are read only from `context`.
   */
  cancelSchedule(timerIdOrParams: object | string, reason?: string | null, context?: object): object;
  /** Dispatches a subagent invocation via `AgentRuntime.invokeAgent`. */
  invokeAgent(invokerId: string, targetAgentId: string, prompt: string, options?: object): object;
  /**
   * Waits for invocation completion via `AgentRuntime.waitForInvocation`.
   *
   * Agent-facing port path (Realm wave A, ticket 3487c56): the trusted
   * `context` carries the identity-only caller scope. A call with no caller
   * context is caller-scoped but unresolved and therefore fails closed with
   * `PERMISSION_DENIED`; a resolved caller must be the invocation's invoker,
   * its target, or a Realm-bypass principal.
   */
  waitForInvocation(optionsOrIds: object | string[] | string, options?: object, context?: object): Promise<WaitForInvocationResult>;
  /** Launches an agent via `AgentRuntime.launchAgent`, forwarding any extra positional arguments after `config`. */
  launchAgent(config: object, ...rest: unknown[]): Promise<Agent>;
  /**
   * Kills an agent via `AgentRuntime.killAgent`, coercing a successful kill to `true`.
   * Unknown agents throw `NOT_FOUND`, invalid ids throw `INVALID_CONFIG`, and
   * unauthorized callers throw `PERMISSION_DENIED`; this member never returns `false`.
   */
  killAgent(agentId: string, reason?: string, callerContext?: object | null): boolean;
  /**
   * Lists active agents via `AgentRuntime.listAgents`.
   *
   * Operator/host calls (no `context`) forward `options` unchanged and stay
   * unscoped. Agent-facing calls (`context` supplied; Realm wave A, ticket
   * 3487c56) resolve the trusted caller from the identity port — the canonical
   * `callerKey` binding resolves a same-literal-id caller realm-exactly, even
   * when its bare subject is ambiguous across Realms (Wave I, ticket d57cbc1)
   * — and apply the same principal-driven visibility predicate as
   * `listAgentDescriptors` (scope-local self/children/members — the
   * system-scope director is never listed, Realm wave R ticket cf0e127); an
   * unresolvable caller receives `[]`. The exact injected internal principal
   * and a `realmBypass` caller span every scope.
   */
  listAgents(options?: object, context?: object): Agent[];
  /**
   * Lists agent summary descriptors visible to the trusted caller identity
   * under the principal-driven visibility predicate implemented by
   * `AgentLifecycleManager.listAgentDescriptors`: anonymous callers receive
   * `[]`, a realm-bound registry sudoer receives its same-scope members, and
   * an ordinary caller receives its own descriptor and its registry children.
   * The system-scope director is never listed to a non-bypass caller (scope
   * isolation, Realm wave R ticket cf0e127); a `realmBypass` caller sees every
   * descriptor.
   *
   * `options` is forwarded unchanged; authority is resolved by the lifecycle
   * manager from the frozen registry `AuthorityDescriptor` for `callerAgentId`
   * (or from an explicit trusted `principal`), never from caller-asserted
   * flags. Descriptors carry no entity internals (`history`, `config`,
   * `modelConfig`, `provider`, `model`).
   */
  listAgentDescriptors(options?: {
    /** Trusted principal: the exact injected `InternalPrincipal` or a frozen registry `AuthorityDescriptor`. */
    principal?: InternalPrincipal | AuthorityDescriptor;
    /** Registry-resolved caller identity; authority still comes from that agent's frozen descriptor. */
    callerAgentId?: string;
  }): AgentDescriptor[];
  /** Restores a recycled agent via `AgentRuntime.restoreAgent`, forwarding the caller context unchanged. */
  restoreAgent(agentId: string, callerContext?: object | null): Agent;
  /** Identity and permission descriptor for the given agent (mirrors `AgentRuntime.whoami`). */
  whoami(agentId: string): AgentIdentityDescriptor;
  /**
   * Undoes the most recent turn bundle for an agent, optionally targeting a
   * specific turn, and pushes it onto the redo stack.
   *
   * @param agentId - Identifier of the agent whose turn is undone.
   * @param targetTurnId - Optional turn selector matching a message `id` or
   *   `metadata.turnId`; blank values behave as "no target". Unmatched targets
   *   (including turns already on the redo stack) are returned as an
   *   {@link UndoTurnSelectionFailure} before any mutation or cancellation.
   * @returns The canonical {@link UndoTurnResult}, or an
   *   {@link UndoTurnSelectionFailure} when an explicit target cannot be selected.
   */
  undoAgentTurn(agentId: string, targetTurnId?: string | null): UndoTurnResult | UndoTurnSelectionFailure;
}

/**
 * Frozen identity projection returned by {@link AgentIdentityPort.getAgentIdentity}.
 *
 * The projection is trusted construction output: consumers must never derive
 * authority from caller-supplied data. The serialized allow-list keeps the name
 * `allowedTools`. Since MOD-21 W10 (5b585b7), `privileged`/`allowedTools` are
 * projected from the registry-owned authority inputs, so direct writes to the
 * public `Agent#config` object cannot widen the projection. When a registry
 * record exists its inputs are the only trusted source — a record with no
 * selector projects default-deny and never falls back to the live config, whose
 * getter-only projections remain the fallback only for entities without a
 * registry record (MOD-21 W11-A, 556636e).
 */
export interface AgentIdentityProjection {
  /** Registered agent identifier (realm-local, opaque: the same literal id may exist in several Realms). */
  readonly id: string;
  /**
   * Canonical internal identity key of this registration (Wave I, ticket
   * d57cbc1): the `(realmId, agentId)` composite owned by
   * `createAgentIdentityKey`. Substrate consumers key their per-agent state on
   * this value so the same literal id in two Realms never shares an entry.
   *
   * Internal only: never a tool parameter, receipt, error, listing label, or
   * prompt. Consumers that surface anything back to an agent must project the
   * bare `id`.
   */
  readonly key: string;
  /**
   * Legacy boolean privilege projection retained for wire compatibility;
   * {@link AgentIdentityProjection.authority} is the primary authority channel,
   * and this boolean remains the fallback only for hosts whose projection lacks
   * an `authority` descriptor.
   */
  readonly privileged: boolean;
  /** Defensive copy of the serialized `allowedTools` allow-list (`['*']` for the wildcard preset). */
  readonly allowedTools: string[];
  /**
   * Realm membership read from the entity's owner-controlled `config.realmId`
   * (Realm wave A, ticket f5d1ccc): a non-empty Realm id, or `null` for an
   * ungrouped agent. Realm-substrate consumers bind a non-bypassing caller
   * with a realm id to that Realm's scope; the field never grants authority.
   */
  readonly realmId: string | null;
  /**
   * Whether the subject bypasses Realm scoping (Realm wave A, ticket f5d1ccc;
   * Wave I, ticket c02d0b9).
   *
   * This projection carries the registry-owned `realmBypass` grant: `true`
   * iff the agent's frozen authority inputs record the engine-composed
   * bootstrap grant or an operator grant, and `false` for every other agent —
   * the literal id carries no meaning and the wildcard `'*'` capability never
   * bypasses by itself. The operator/engine branch (the opaque
   * `InternalPrincipal`) is not an agent id, so it cannot appear here:
   * substrates receive that principal by exact reference and OR their own
   * reference check with this field.
   */
  readonly realmBypass: boolean;
  /**
   * Resolved private workspace key (`agent.config.workspaceId`, or the
   * entity's own `workspaceId`, or the plain agent id), projected from
   * registry-owned state (Realm wave R, ticket 59e4673). Substrate consumers
   * that rebuild the caller identity from this port — such as the
   * messaging-bus inline-file VirtualFS read — resolve the caller's own
   * private workspace through this field. Optional and additive: a producer
   * that omits it keeps the historical plain-id fallback, and the field never
   * grants authority (it names storage placement, not capability).
   *
   * The field carries the *pin* (an explicit `config.workspaceId`/`workspace`
   * differing from the bare id) or the bare id — not the storage partition
   * itself. The VFS-owned `resolveAgentPrivateWorkspaceKey` rule consumes the
   * projection: an explicit pin is preserved verbatim, a Realm-bound
   * projection keys on its canonical {@link AgentIdentityProjection.key}, and
   * an ungrouped/system-scope projection keeps the legacy bare id (Wave I,
   * ticket d57cbc1).
   */
  readonly workspaceId?: string;
  /**
   * Frozen authority descriptor for the agent, built once at launch/restore
   * from trusted config and removed when the agent is recycled or purged. A
   * consumer that does not find it must default-deny non-innate capability.
   */
  readonly authority?: AuthorityDescriptor;
}

/**
 * Trusted resolution scope accepted by the frozen identity port (Wave I,
 * ticket d57cbc1). Host and substrate callers that already know the Realm
 * scope of the id they are resolving pass it explicitly; id-only callers omit
 * it and keep the legacy unique-match rule.
 *
 * - `{ realmId: <string> }` resolves exactly `(realmId, agentId)`.
 * - `{ realmId: null }` resolves exactly the bootstrap-only system scope.
 * - `{ realmBypass: true }` resolves the unique match across every Realm,
 *   `null` when absent or ambiguous.
 * - An omitted scope resolves the unique match across every Realm (`null` when
 *   absent or ambiguous) — single-Realm sessions behave exactly as before.
 */
export interface AgentIdentityScope {
  /** Realm membership to resolve exactly; `null` selects the system scope. */
  readonly realmId?: string | null;
  /** Resolve the unique match across every Realm (`realmId` then only narrows nothing). */
  readonly realmBypass?: boolean;
}

/**
 * Frozen identity resolver consumed by the tool execution layer
 * as `ToolExecutionPort.getAgentIdentity`.
 *
 * The port is trusted construction output handed to substrates. Agent-facing
 * consumers (tool descriptors) keep calling `getAgentIdentity(agentId)` with
 * no scope; the canonical `key` field and the scoped forms are for internal
 * substrate keying only and never reach an agent-visible surface.
 */
export interface AgentIdentityPort {
  /**
   * Resolves the identity and permissions of an active registered agent.
   *
   * @param agentId - Realm-local identifier of the agent to look up.
   * @param scope - Optional trusted resolution scope (Wave I, ticket
   *   d57cbc1): realm-bound scopes resolve exactly the composite
   *   `(scope.realmId, agentId)` pair, a bypass scope resolves the unique
   *   match across Realms, and an omitted scope keeps the legacy unique-match
   *   behavior (an id registered in more than one Realm resolves `null` — fail
   *   closed, never a wrong-Realm pick).
   * @returns A frozen {@link AgentIdentityProjection} carrying the agent's bare
   *   `id`, its canonical `key`, the legacy `privileged` flag, a defensive
   *   copy of its allowed tool names, Realm scope (`realmId`, `realmBypass`),
   *   and the registry `AuthorityDescriptor` when one is registered; `null`
   *   when no active agent matches the resolution (recycled agents are not
   *   resolved).
   */
  getAgentIdentity(agentId: string, scope?: AgentIdentityScope): AgentIdentityProjection | null;
  /**
   * Enumerates the active registrations a scope can resolve (Wave I, ticket
   * d57cbc1) — broadcasts, scoped listings, and substrate keying.
   *
   * @param scope - Optional trusted resolution scope: realm-bound scopes
   *   enumerate exactly that Realm's registrations (the system scope for
   *   `realmId: null`), while an omitted or bypass scope enumerates every
   *   active registration.
   * @returns Frozen {@link AgentIdentityProjection}s in registry insertion
   *   order; recycled registrations are never returned.
   */
  listAgentIdentities(scope?: AgentIdentityScope): AgentIdentityProjection[];
}

/**
 * Agent instance with optional dynamically attached identity metadata.
 * Mirrors the defensive fallbacks exercised by the coordinator registry queries.
 */
type AgentWithIdentity = Agent & { role?: string; workspaceId?: string; spawnedBy?: string | null };

/**
 * Pending user-turn waiter registered by `enqueueUserTurn` and settled by the
 * dispatcher-claimed execution of the queued user trigger.
 */
interface PendingUserTurnWaiter {
  agentKey: string;
  resolve: (result: TurnExecutionResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Facade-side caller context accepted by the scheduler-principal resolver.
 *
 * Trust boundary: `principal` is forwarded unchanged for the scheduler's
 * reference validation, and `callerAgentId`/`agentId` identity claims are
 * resolved through the lifecycle registry. Privilege- and role-looking flags
 * are ignored.
 */
interface SchedulerCallerContext {
  principal?: InternalPrincipal | AuthorityDescriptor;
  callerAgentId?: string;
  agentId?: string;
  /**
   * Trusted canonical identity key channel (Wave I, ticket d57cbc1): forwarded
   * to the scheduler so a same-literal-id caller resolves realm-exactly; the
   * scheduler honors it only when the registry authority resolver binds the
   * key to the same principal reference.
   */
  callerKey?: string;
  caller_key?: string;
}

/**
 * Identity projection over an interface shape. TypeScript withholds implicit
 * index signatures from interface types, so this mapped form lets
 * interface-shaped values satisfy `Record<string, unknown>` seams without
 * assertions or copies.
 * @internal
 */
type IndexableRecord<T> = { [K in keyof T]: T[K] };

/**
 * Creates the single frozen `InternalPrincipal` owned by a runtime instance
 * (composition root). Subsystems receive it by reference; a plain object with
 * the same shape cannot impersonate it.
 * @internal
 */
function createInternalPrincipal(subject = 'runtime-engine'): InternalPrincipal {
  const principal = Object.freeze({
    [INTERNAL_PRINCIPAL_BRAND]: 'internal-principal' as const,
    kind: 'internal' as const,
    subject
  });
  return principal;
}

/**
 * Unified AgentRuntime Facade Class.
 * Central engine coordinator for multi-agent sandbox execution, lifecycle management,
 * history tracking, scheduling, RPC invocations, and snapshot disaster recovery.
 *
 * All internal collections (`#agents`, `#recycleBin`, `#messageSubscriptions`, `#listeners`)
 * and subsystem engines (`lifecycleManager`, `turnExecutionEngine`,
 * `historyManager`, `runtimeScheduler`, `triggerDispatcher`, `telemetryTracker`) are strictly
 * encapsulated. External consumers interact exclusively through safe, validated facade methods.
 *
 * @example
 * ```typescript
 * import { AgentRuntime, createAgentRuntime, RUNTIME_STATUS } from './runtime/index.ts';
 *
 * const runtime = createAgentRuntime({ autoBootstrapDirector: true });
 *
 * // Provision an agent
 * const writer = await runtime.launchAgent({
 *   id: 'writer_1',
 *   name: 'Creative Writer',
 *   role: 'writer',
 *   systemPrompt: 'You write engaging sci-fi fiction.'
 * });
 *
 * // Execute a turn
 * const result = await runtime.executeAgentTurn('writer_1', 'Outline chapter 1');
 * console.log('Writer response:', result.output);
 *
 * // Query telemetry
 * const telemetry = runtime.getAgentTelemetry('writer_1');
 * console.log(`Tokens used: ${telemetry?.totalTokens}`);
 *
 * // Export snapshot for disaster recovery
 * const snapshot = runtime.exportSnapshot();
 * ```
 */
export class AgentRuntime {
  /** Current operational status of the runtime engine. */
  #status: RuntimeStatus = RUNTIME_STATUS.UNINITIALIZED;

  /** Epoch-millisecond start timestamp used for uptime reporting. */
  #startTime = 0;

  /** Number of in-flight execution turns across all agents. */
  #activeTurnsCount = 0;

  /** Underlying virtual filesystem substrate. */
  #virtualFs: VirtualFS;

  /** Underlying messaging bus substrate. */
  #messagingBus: MessagingBus;

  /** Underlying world clock substrate. */
  #worldClock: WorldClock;

  /** Underlying invocation engine substrate. */
  #invocationEngine: InvocationEngine;

  /** Centralized non-blocking trigger queue. */
  #triggerQueue: TriggerQueue;

  /** Mailbox autonomy flag; `null` inherits the configured default. */
  #mailboxAutonomy: boolean | null = null;

  /** Optional custom tool descriptor registry. */
  #customTools: Record<string, unknown> | null = null;

  /**
   * Optional Wave U host publishing port forwarded verbatim to the turn
   * execution engine (ticket 2518510). Never exposed on the runtime facade;
   * descriptor handlers read it from the trusted dispatcher context.
   */
  #realmPublishingPort: RealmPublishingPort | null = null;

  /** Optional read-only credential resolver forwarded to agent provisioning. */
  #credentialResolver: CredentialResolverPort | null = null;

  /** Optional MOD-20 preset-source projection forwarded to agent provisioning/hydration. */
  #presetSource: ModelPresetSourcePort | null = null;

  /** Unsubscriber for the MOD-20 preset-source catalog change subscription. */
  #presetUnsubscribe: (() => void) | null = null;

  /** Active agent registry, keyed by the canonical `(realmId, agentId)` identity key (Wave I, ticket d57cbc1). */
  #agents: Map<string, Agent> = new Map();

  /** Soft-killed / recycled agent registry, keyed by the canonical `(realmId, agentId)` identity key. */
  #recycleBin: Map<string, Agent> = new Map();

  /** Per-agent mailbox unsubscribers, keyed by the canonical `(realmId, agentId)` identity key. */
  #messageSubscriptions: Map<string, () => void> = new Map();

  /** Runtime event subscribers. */
  #listeners: Set<RuntimeEventListener> = new Set();

  /**
   * Pending user-turn waiters keyed by queue triggerId. `enqueueUserTurn`
   * registers a waiter, and `executeAgentTurn` claims it when the dispatcher
   * forwards the queued `TRIGGER_TYPES.USER` trigger, so the caller receives
   * the canonical turn receipt.
   */
  #userTurnWaiters: Map<string, PendingUserTurnWaiter> = new Map();

  /** Unsubscriber for the runtime-level bus timer listener. */
  #busTimerListener: (() => void) | null = null;

  /** Lifecycle manager subsystem. */
  #lifecycleManager: AgentLifecycleManager;

  /** Turn execution engine subsystem. */
  #turnExecutionEngine: TurnExecutionEngine;

  /** History manager subsystem. */
  #historyManager: HistoryManager;

  /** Runtime scheduler subsystem. */
  #runtimeScheduler: RuntimeScheduler;

  /** Trigger dispatcher subsystem. */
  #triggerDispatcher: TriggerDispatcher;

  /** Runtime telemetry tracker subsystem. */
  #telemetryTracker: RuntimeTelemetry;

  /**
   * The opaque engine principal owned by this runtime (composition root).
   * Subsystems trust it by reference; the composition root can obtain the same
   * reference through the frozen `getOperatorPrincipal()` accessor.
   */
  #internalPrincipal: InternalPrincipal;

  /**
   * Narrow DirectorRuntimeHost handed to Mod 7. Stable identity is required so
   * `ensureDirectorAgent`'s in-flight launch lock synchronizes concurrent calls.
   * The director bootstrap is an internal engine path: it passes the opaque
   * `InternalPrincipal` so the privileged spawn, the bootstrap-only system
   * scope, and the hardcoded `realmBypass` grant are composed without
   * caller-asserted flags.
   */
  #directorHost: DirectorRuntimeHost;

  /**
   * Initializes agent runtime with VirtualFS, MessagingBus, WorldClock, InvocationEngine,
   * TriggerQueue, and coordinated runtime subsystems.
   *
   * @param options - Configuration options and shared primitive injections.
   */
  constructor({
    virtualFs = null,
    messagingBus = null,
    worldClock = null,
    invocationEngine = null,
    mailboxAutonomy = null,
    customTools = null,
    autoBootstrapDirector = false,
    credentialResolver = null,
    presetSource = null,
    realmPublishingPort = null
  }: AgentRuntimeOptions = {}) {
    this.#status = RUNTIME_STATUS.INITIALIZING;
    this.#startTime = Date.now();
    this.#activeTurnsCount = 0;

    // Composition-root authority: the single opaque engine principal, created
    // before the substrates so it can be injected into them by reference.
    this.#internalPrincipal = createInternalPrincipal('runtime-engine');

    this.#virtualFs = virtualFs || new VirtualFS({
      defaultBudgetBytes: 20000,
      identityPort: this.createAgentIdentityPort(),
      internalPrincipal: this.#internalPrincipal
    });
    // Injected substrates could not receive the principal through their
    // constructor options, so the composition root binds the exact reference
    // once (first bind wins; W8-D interface, MOD-21 W8-D c6e24c0). Engine
    // tenant-administration calls then authorize, while a foreign VFS that was
    // constructed with a different principal stays isolated (bind refused).
    if (virtualFs && typeof this.#virtualFs.bindInternalPrincipal === 'function') {
      this.#virtualFs.bindInternalPrincipal(this.#internalPrincipal);
    }
    this.#messagingBus = messagingBus || new MessagingBus({
      identityPort: this.createAgentIdentityPort(),
      internalPrincipal: this.#internalPrincipal
    });
    // Injected buses could not receive the principal through their constructor
    // options, so the composition root binds the exact reference once (first
    // bind wins, Wave I ticket c02d0b9, mirroring the VirtualFS/WorldClock
    // wiring). Operator-attributed sends then resolve the bypass by reference
    // while a foreign bus bound elsewhere stays isolated.
    if (messagingBus && typeof this.#messagingBus.bindInternalPrincipal === 'function') {
      this.#messagingBus.bindInternalPrincipal(this.#internalPrincipal);
    }
    this.#mailboxAutonomy = mailboxAutonomy !== null && mailboxAutonomy !== undefined ? Boolean(mailboxAutonomy) : null;
    this.#worldClock = worldClock || new WorldClock({
      virtualFs: this.#virtualFs,
      identityPort: this.createAgentIdentityPort(),
      internalPrincipal: this.#internalPrincipal
    });
    // Injected clocks could not receive the principal through their constructor
    // options, so the composition root binds the exact reference once (first
    // bind wins; W10-C interface, MOD-21 a8472ed). Engine tenant-administration
    // snapshot calls then authorize, while a foreign clock constructed with a
    // different principal stays isolated (bind refused).
    if (worldClock && typeof this.#worldClock.bindInternalPrincipal === 'function') {
      this.#worldClock.bindInternalPrincipal(this.#internalPrincipal);
    }
    this.#customTools = customTools || null;
    this.#credentialResolver = credentialResolver || null;
    this.#presetSource = presetSource || null;
    this.#realmPublishingPort = realmPublishingPort || null;

    this.#agents = new Map();
    this.#recycleBin = new Map();
    this.#messageSubscriptions = new Map();
    this.#listeners = new Set();

    // Narrow DirectorRuntimeHost that injects the engine principal for the
    // bootstrap. The root system director is an ordinary agent with the
    // hardcoded `realmBypass` grant composed on the engine path and the
    // bootstrap-only system scope (`realmId: null`); the id itself carries no
    // meaning (Wave I, ticket c02d0b9). Wave U (ticket 2518510): the bootstrap
    // also engine-composes both explicit publishing authorities
    // (`@template:authority`/`@hydration:authority`), so the root director can
    // import templates and submit hydration packages without an operator
    // grant; no other agent is composed this way.
    this.#directorHost = Object.freeze({
      // System-scope adoption (defect 7d2c314): the bootstrap-only director
      // lives in the `system:<agentId>` namespace, so a realm-local agent whose
      // literal id equals the director id is never adopted as the system
      // director; when the system record is absent the domain re-provisions it.
      getAgent: (agentId: string) => this.getAgent(createAgentIdentityKey(null, agentId)),
      launchAgent: (
        config: AgentConfig,
        model: LaunchAgentOptions['model'] = null,
        provider: LaunchAgentOptions['provider'] = null,
        initialPrompt: string | null = null
      ) => {
        const bootstrapConfig: AgentConfig & {
          realmBypass?: boolean;
          templateAuthority?: boolean;
          hydrationAuthority?: boolean;
        } = {
          ...config,
          realmId: null,
          realmBypass: true,
          templateAuthority: true,
          hydrationAuthority: true
        };
        return this.launchAgent({
          config: bootstrapConfig,
          model,
          provider,
          initialPrompt,
          principal: this.#internalPrincipal
        });
      }
    });

    // Canonical DI port: subsystems emit through the facade, never reach into it.
    const emitPort = this.createSubsystemEmitPort();

    // Narrow telemetry accessor: Mod 12 reads/writes agent telemetry only through
    // this port; the Agent entity owns its own state via applyTelemetrySnapshot.
    const telemetryAgentAccessor = Object.freeze({
      getTelemetrySnapshot: (agentId: string) => {
        const agent = this.#agents.get(agentId) || this.#recycleBin.get(agentId) || null;
        if (!agent || !agent.telemetry || typeof agent.telemetry !== 'object') return null;
        return { ...agent.telemetry };
      },
      applyTelemetrySnapshot: (agentId: string, snapshot: Partial<AgentTelemetry>) => {
        const agent = this.#agents.get(agentId) || this.#recycleBin.get(agentId) || null;
        if (agent && typeof agent.applyTelemetrySnapshot === 'function') {
          agent.applyTelemetrySnapshot(snapshot);
        }
      }
    });

    // Composition-root engine authority: trusted subsystems bind lifecycle
    // mutations (state transitions, cancellation) to the opaque internal
    // principal instead of caller data (MOD-21 W8, f6be691).
    const engineAuthority = Object.freeze({ principal: this.#internalPrincipal });

    // Subsystem: HistoryManager. Undo/retry are engine paths; the narrow view
    // binds their state/cancel calls to the internal principal.
    const historyRuntimeView = Object.freeze({
      getAgent: (agentId: string) => this.getAgent(agentId),
      enqueueUserTurn: (agentId: string, input: TurnInput = null, options: TurnExecutionOptions | string = {}) => this.enqueueUserTurn(agentId, input, options),
      executeAgentTurn: (agentId: string, input: TurnInput = null, options: TurnExecutionOptions | string = {}) => this.executeAgentTurn(agentId, input, options),
      cancelAgent: (agentId: string, reason: string = 'Cancelled by user') => this.cancelAgent(agentId, reason, engineAuthority),
      setAgentState: (agentOrId: string | Agent, newState: string, stateDetail: string | null = null) => this.setAgentState(agentOrId, newState, stateDetail, engineAuthority)
    });
    this.#historyManager = new HistoryManager({ runtime: historyRuntimeView, emit: emitPort });

    // Subsystem: RuntimeTelemetryTracker
    this.#telemetryTracker = new RuntimeTelemetryTracker({
      emit: emitPort,
      agentAccessor: telemetryAgentAccessor
    });

    // Standalone Invocation Engine (INV-INVOKE & Invariant 2). Invoker authority
    // resolves through the lifecycle registry descriptor (wired below); the
    // closure defers resolution to call time, when the lifecycle manager exists.
    const getAgentAuthority = (agentId: string): AuthorityDescriptor | null => this.#lifecycleManager
      ? this.#lifecycleManager.getAuthorityDescriptor(agentId)
      : null;
    // Realm scope resolver for the invocation engine (Realm wave A, ticket
    // 3487c56): projects through the trusted identity port. The closure defers
    // resolution to call time, when the lifecycle registry exists.
    const invocationIdentityPort = this.createAgentIdentityPort();
    const getAgentRealmScope = (agentId: string) => {
      const projection = invocationIdentityPort.getAgentIdentity(agentId);
      return projection
        ? { realmId: projection.realmId, realmBypass: projection.realmBypass }
        : null;
    };
    this.#invocationEngine = invocationEngine || new InvocationEngine({
      executeTurn: (targetAgentId, prompt, options) => this.#executeTurnForInvocation(targetAgentId, prompt, options),
      getAgent: (agentId) => this.getAgent(agentId),
      isAgentTerminated: (agentId) => this.isAgentTerminated(agentId),
      getAgentAuthority,
      getAgentRealmScope,
      identityPort: invocationIdentityPort,
      internalPrincipal: this.#internalPrincipal
    });
    if (invocationEngine) {
      this.#invocationEngine.setRuntimeHooks({
        executeTurn: (targetAgentId, prompt, options) => this.#executeTurnForInvocation(targetAgentId, prompt, options),
        getAgent: (agentId) => this.getAgent(agentId),
        isAgentTerminated: (agentId) => this.isAgentTerminated(agentId),
        getAgentAuthority,
        getAgentRealmScope,
        identityPort: invocationIdentityPort,
        internalPrincipal: this.#internalPrincipal
      });
    }

    // Centralized Non-Blocking Trigger Queue (Invariant 3 & Invariant 4).
    // The composition root wires the trusted identity port here (Realm wave A1,
    // ticket 61dae28): both consumers read Realm scope exclusively from the
    // constructor-injected port, so without this injection their realm filters
    // stay inert in production. The port resolves agents lazily at call time.
    this.#triggerQueue = new TriggerQueue({
      dispatchAction: async (trigger) => this.#dispatchTrigger(trigger),
      isAgentBusy: (agentId) => this.isAgentBusy(agentId),
      identityPort: this.createAgentIdentityPort(),
      tickIntervalMs: 25
    });

    // Subsystem: RuntimeScheduler — receives the opaque engine principal, the
    // registry authority resolver for reference-validated agent principals, and
    // the trusted identity port that resolves Realm scope for the principal and
    // early-cancel sweep (Realm wave A1, ticket 61dae28).
    this.#runtimeScheduler = new RuntimeScheduler({
      runtime: this,
      emit: emitPort,
      triggerQueue: this.#triggerQueue,
      internalPrincipal: this.#internalPrincipal,
      identityPort: this.createAgentIdentityPort(),
      resolveAgentAuthority: (agentId) => this.#lifecycleManager
        ? this.#lifecycleManager.getAuthorityDescriptor(agentId)
        : null
    });

    // Subsystem: TriggerDispatcher
    this.#triggerDispatcher = new TriggerDispatcher({
      runtime: this,
      messagingBus: this.#messagingBus,
      triggerQueue: this.#triggerQueue,
      invocationEngine: this.#invocationEngine
    });

    // Subsystem: TurnExecutionEngine. Turn-driven state transitions are engine
    // paths; the narrow view binds `setAgentState` to the internal principal and
    // forwards the rest of the engine's surface.
    const turnEngineRuntimeView = Object.freeze({
      getAgent: (agentId: string) => this.getAgent(agentId),
      hasRecycledAgent: (agentId: string) => this.hasRecycledAgent(agentId),
      createSubsystemEmitPort: () => this.createSubsystemEmitPort(),
      createLifecyclePort: () => this.createLifecyclePort(),
      createAgentIdentityPort: () => this.createAgentIdentityPort(),
      getOperatorPrincipal: () => this.#internalPrincipal,
      setAgentState: (agentOrId: string | Agent, newState: string, stateDetail: string | null = null) => this.setAgentState(agentOrId, newState, stateDetail, engineAuthority)
    });
    // Custom tools are operator-global and host-only (A0-5, ticket 0443865):
    // the registry is forwarded verbatim to the engine, which gates every
    // custom-handler invocation on the caller's frozen authority descriptor.
    // Never model-registered, and Realms never register custom tools.
    this.#turnExecutionEngine = new TurnExecutionEngine({
      runtime: turnEngineRuntimeView,
      emit: emitPort,
      virtualFs: this.#virtualFs,
      messagingBus: this.#messagingBus,
      worldClock: this.#worldClock,
      triggerQueue: this.#triggerQueue,
      customTools: this.#customTools,
      realmPublishingPort: this.#realmPublishingPort,
      mailboxAutonomy: this.#mailboxAutonomy,
      telemetryTracker: this.#telemetryTracker,
      historyManager: this.#historyManager
    });

    // Canonical narrow port: lifecycle manager wires mail subscriptions through
    // the dispatcher without reaching into the facade.
    const triggerDispatcherPort = Object.freeze({
      setupAgentMailSubscription: (agentId: string) => this.#setupAgentMailSubscription(agentId)
    });

    // Subsystem: AgentLifecycleManager
    this.#lifecycleManager = new AgentLifecycleManager({
      runtime: this,
      emit: emitPort,
      triggerDispatcher: triggerDispatcherPort,
      messagingBus: this.#messagingBus,
      virtualFs: this.#virtualFs,
      invocationEngine: this.#invocationEngine,
      agents: this.#agents,
      recycleBin: this.#recycleBin,
      messageSubscriptions: this.#messageSubscriptions,
      credentialResolver: this.#credentialResolver,
      presetSource: this.#presetSource,
      internalPrincipal: this.#internalPrincipal
    });

    // Early cancellation listener for scheduled timers on MessagingBus
    this.#bindBusTimerListener();

    this.#status = RUNTIME_STATUS.READY;

    // MOD-20 catalog subscription: binds after READY so a catalog change can
    // never reach a partially constructed runtime.
    this.#bindPresetSource();

    if (autoBootstrapDirector) {
      this.ensureDirector().catch((err) => {
        console.error('Error auto-bootstrapping director agent:', err);
      });
    }
  }

  // ====================================================================
  // Status & Substrate Read-Only Getters
  // ====================================================================

  /**
   * Current operational status of the runtime engine.
   */
  get status(): RuntimeStatus {
    return this.#status;
  }

  /**
   * Returns the composition-root operator principal (the opaque
   * `InternalPrincipal` reference owned by this runtime).
   *
   * The host operator acts without any agent: the store/composition root
   * passes this exact reference as `{ principal }` to lifecycle, scheduler,
   * and substrate calls, and their reference-validated gates accept it. The
   * accessor exposes no other capability — a plain object with the same shape
   * is still rejected, and the reference confers only what the receiving
   * subsystem already grants to the engine path (Wave I, ticket c02d0b9).
   *
   * @returns The frozen `InternalPrincipal` reference minted by this runtime.
   *
   * @example
   * ```typescript
   * const runtime = createAgentRuntime();
   * const operator = runtime.getOperatorPrincipal();
   * runtime.emptyRecycleBin({ principal: operator });
   * ```
   */
  getOperatorPrincipal(): InternalPrincipal {
    return this.#internalPrincipal;
  }

  /**
   * Access to underlying virtual filesystem substrate.
   */
  get virtualFs(): VirtualFS {
    return this.#virtualFs;
  }

  /**
   * Access to underlying messaging bus substrate.
   */
  get messagingBus(): MessagingBus {
    return this.#messagingBus;
  }

  /**
   * Access to underlying world clock substrate.
   */
  get worldClock(): WorldClock {
    return this.#worldClock;
  }

  /**
   * Access to underlying invocation engine substrate.
   */
  get invocationEngine(): InvocationEngine {
    return this.#invocationEngine;
  }

  /**
   * Access to underlying trigger queue substrate.
   */
  get triggerQueue(): TriggerQueue {
    return this.#triggerQueue;
  }

  // ====================================================================
  // Internal Assertion Helpers
  // ====================================================================

  #assertNotDestroyed(): void {
    if (this.#status === RUNTIME_STATUS.DESTROYED) {
      throw createRuntimeError('AgentRuntime instance has been destroyed', 'ERR_RUNTIME_DESTROYED');
    }
  }

  #assertReadyOrRunning(): void {
    if (this.#status !== RUNTIME_STATUS.READY && this.#status !== RUNTIME_STATUS.RUNNING) {
      throw createRuntimeError(`AgentRuntime is not ready (current status: ${this.#status})`, 'ERR_RUNTIME_NOT_READY');
    }
  }

  // ====================================================================
  // Canonical Identity Helpers (Wave I, ticket d57cbc1)
  // ====================================================================

  /**
   * Resolves an agent record's Realm membership from the owner-controlled
   * config accessor (`null` = the bootstrap-only system scope).
   *
   * @param agent - Agent entity, or null.
   * @returns The Realm id, or `null` when ungrouped/absent.
   * @internal
   */
  #agentRealmId(agent: Agent | null | undefined): string | null {
    const raw = agent?.config?.realmId;
    return typeof raw === 'string' && raw ? raw : null;
  }

  /**
   * Canonical identity key of an agent record: the `(realmId, agentId)`
   * composite owned by `createAgentIdentityKey`. Every internal registry
   * (`#agents`, `#recycleBin`, `#messageSubscriptions`, telemetry) keys on it.
   *
   * @param agent - Agent entity.
   * @returns The canonical internal identity key.
   * @internal
   */
  #agentIdentityKeyOf(agent: Agent): string {
    return createAgentIdentityKey(this.#agentRealmId(agent), agent.id);
  }

  /**
   * Builds the telemetry address of an agent (Wave I, ticket d57cbc1): the
   * canonical `(realmId, agentId)` key plus the realm-local label the
   * telemetry tracker projects back onto public events/snapshots, so internal
   * keying is realm-exact while host-visible surfaces stay realm-opaque.
   *
   * @param agent - Agent entity.
   * @returns The telemetry address object.
   * @internal
   */
  #telemetryAddress(agent: Agent): { id: string; telemetryLabel: string } {
    return { id: this.#agentIdentityKeyOf(agent), telemetryLabel: agent.id };
  }

  /**
   * Reference resolution over the active registry (Wave I, ticket d57cbc1):
   * a canonical `(realmId, agentId)` identity key resolves its exact
   * registration first; every other reference keeps the unique-match bare-id
   * rule (an id registered in two Realms is ambiguous and resolves `null` —
   * fail closed, never a wrong-Realm pick).
   *
   * @param ref - Bare agent identifier or canonical identity key.
   * @returns The matching active agent, or `null`.
   * @internal
   */
  #activeByRef(ref: string): Agent | null {
    if (!ref || typeof ref !== 'string') return null;
    const byKey = this.#agents.get(ref);
    if (byKey) return byKey;
    return this.#activeByBareId(ref);
  }

  /**
   * Unique-match bare-id resolution over the active registry (Wave I, ticket
   * d57cbc1). A bare id is realm-local and opaque, so it resolves only while
   * exactly one active registration matches; zero or multiple matches resolve
   * `null` (fail closed — never a wrong-Realm pick).
   *
   * @param agentId - Bare agent identifier to resolve.
   * @returns The single matching active agent, or `null`.
   * @internal
   */
  #activeByBareId(agentId: string): Agent | null {
    if (!agentId || typeof agentId !== 'string') return null;
    let match: Agent | null = null;
    for (const agent of this.#agents.values()) {
      if (!agent || agent.id !== agentId) continue;
      if (match !== null) return null;
      match = agent;
    }
    return match;
  }

  /**
   * Reference resolution over the recycle bin (Wave I, ticket d57cbc1): a
   * canonical identity key resolves its exact recycled registration first;
   * every other reference keeps the unique-match bare-id rule.
   *
   * @param ref - Bare agent identifier or canonical identity key.
   * @returns The matching recycled agent, or `null`.
   * @internal
   */
  #recycledByRef(ref: string): Agent | null {
    if (!ref || typeof ref !== 'string') return null;
    const byKey = this.#recycleBin.get(ref);
    if (byKey) return byKey;
    return this.#recycledByBareId(ref);
  }

  /**
   * Unique-match bare-id resolution over the recycle bin.
   *
   * @param agentId - Bare agent identifier to resolve.
   * @returns The single matching recycled agent, or `null`.
   * @internal
   */
  #recycledByBareId(agentId: string): Agent | null {
    if (!agentId || typeof agentId !== 'string') return null;
    let match: Agent | null = null;
    for (const agent of this.#recycleBin.values()) {
      if (!agent || agent.id !== agentId) continue;
      if (match !== null) return null;
      match = agent;
    }
    return match;
  }

  /**
   * Reports whether a reference is Realm-ambiguous (Wave I, ticket d57cbc1;
   * fix lane G2): not an exact canonical identity key, and its bare id occurs
   * in more than one registration across the active registry and recycle bin.
   * Ambiguity-sensitive readers fail closed on such a ref instead of falling
   * through to a bare-keyed legacy entry.
   *
   * @param ref - Bare agent identifier or canonical identity key.
   * @returns True when the ref cannot address exactly one registration.
   * @internal
   */
  #isRealmAmbiguousRef(ref: string): boolean {
    if (!ref || typeof ref !== 'string') return true;
    if (this.#agents.has(ref) || this.#recycleBin.has(ref)) return false;
    let matches = 0;
    for (const agent of this.#agents.values()) {
      if (agent && agent.id === ref) matches++;
    }
    for (const agent of this.#recycleBin.values()) {
      if (agent && agent.id === ref) matches++;
    }
    return matches > 1;
  }

  /**
   * Projects a canonical identity key back to its bare realm-local label for
   * host-visible error text (Wave I, ticket d57cbc1; fix lane G2): the key is
   * internal-only and must never appear on an agent-facing surface. Non-key
   * refs pass through unchanged; codes and semantics are untouched.
   *
   * @param ref - Bare agent identifier or canonical identity key.
   * @returns Bare realm-local id for display.
   * @internal
   */
  #displayRef(ref: string): string {
    const parsed = typeof ref === 'string' ? parseAgentIdentityKey(ref) : null;
    return parsed ? parsed.agentId : ref;
  }

  // ====================================================================
  // Core Engine Lifecycle & Substrates
  // ====================================================================

  /**
   * Binds (or re-binds) the runtime-level MessagingBus listener that routes
   * incoming messages into the scheduler's early timer-cancellation handling.
   * Any previously held unsubscriber is invoked first so resets and snapshot
   * hydration never leak or orphan the subscription.
   */
  #bindBusTimerListener(): void {
    if (typeof this.#busTimerListener === 'function') {
      try {
        this.#busTimerListener();
      } catch {
        // Best-effort unbind; the listener slot is cleared regardless.
      }
      this.#busTimerListener = null;
    }

    if (this.#messagingBus && typeof this.#messagingBus.subscribe === 'function') {
      this.#busTimerListener = this.#messagingBus.subscribe('all', (msg) => {
        this.#handleIncomingMessageForTimers(msg);
      });
    }
  }

  /**
   * Binds the MOD-20 preset-source catalog change listener (idempotent).
   *
   * Any previously held unsubscriber is released first, so constructor,
   * reset-time re-bind, and double-bind paths can never leak or orphan a
   * listener. A source without a callable `subscribe` leaves the slot empty.
   */
  #bindPresetSource(): void {
    this.#unbindPresetSource();
    const source = this.#presetSource;
    if (!source || typeof source.subscribe !== 'function') return;
    try {
      const unsubscribe = source.subscribe((event) => this.#handlePresetChange(event));
      this.#presetUnsubscribe = typeof unsubscribe === 'function' ? unsubscribe : null;
    } catch {
      // A failing subscribe leaves the runtime unsubscribed; catalog reads
      // still work and the next bind can retry.
      this.#presetUnsubscribe = null;
    }
  }

  /**
   * Releases the MOD-20 preset-source catalog change subscription (idempotent;
   * a throwing unsubscriber is swallowed after the slot is cleared).
   */
  #unbindPresetSource(): void {
    if (typeof this.#presetUnsubscribe !== 'function') return;
    const unsubscribe = this.#presetUnsubscribe;
    this.#presetUnsubscribe = null;
    try {
      unsubscribe();
    } catch {
      // Best-effort unsubscribe; the listener slot is cleared regardless.
    }
  }

  /**
   * Applies one MOD-20 catalog change to the registered agents (active and
   * recycled). Never rebuilds provider/model mid-turn:
   *
   * - `preset-updated` marks every agent whose `config.presetId` names the
   *   saved preset dirty, so its next turn start re-materializes.
   * - `preset-deleted` rewrites matching bindings to the current catalog
   *   default and persists the rewrite (lifecycle config-update path for
   *   active agents, a direct `agent_config_updated` emission for recycled
   *   ones); materialization still happens only at the next turn start.
   *
   * Each agent operation is isolated so one failing entity cannot block the
   * remaining agents, mirroring the catalog's listener-exception policy.
   */
  #handlePresetChange(event: PresetChangeEvent | null | undefined): void {
    if (!event || typeof event !== 'object') return;
    const presetId = typeof event.presetId === 'string' ? event.presetId : '';
    if (!presetId) return;

    if (event.type === 'preset-updated') {
      for (const agent of this.listAgents({ includeRecycled: true })) {
        if (!agent || agent.config?.presetId !== presetId) continue;
        if (typeof agent.markPresetDirty !== 'function') continue;
        try {
          agent.markPresetDirty();
        } catch {
          // Listener isolation: one failing entity never blocks the rest.
        }
      }
      return;
    }

    if (event.type !== 'preset-deleted') return;
    const source = this.#presetSource;
    if (!source) return;
    const defaultPresetId = source.getDefaultPresetId();
    if (typeof defaultPresetId !== 'string' || !defaultPresetId) return;

    for (const agent of this.listAgents({ includeRecycled: true })) {
      if (!agent || agent.config?.presetId !== presetId) continue;
      if (typeof agent.rebindToDefaultPreset === 'function') {
        try {
          agent.rebindToDefaultPreset();
        } catch {
          // Listener isolation: one failing entity never blocks the rest.
        }
      }
      this.#persistPresetRebind(agent, defaultPresetId);
    }
  }

  /**
   * Persists a `preset-deleted` binding rewrite so store autosave sees it.
   *
   * Active agents go through the lifecycle update path, which merges
   * `presetId` and emits `agent_config_updated`; recycled agents are outside
   * that registry path, so the same event is emitted directly by the runtime.
   * Neither path rebuilds provider/model.
   */
  #persistPresetRebind(agent: Agent, presetId: string): void {
    if (this.#lifecycleManager && this.#agents.has(this.#agentIdentityKeyOf(agent))) {
      try {
        this.#lifecycleManager.updateAgentConfig(agent.id, { presetId }, { principal: this.#internalPrincipal });
        return;
      } catch {
        // Fall through to the direct emission so a lifecycle failure still
        // surfaces the rewrite to persistence consumers.
      }
    }
    this.#emit({
      type: 'agent_config_updated',
      timestamp: Date.now(),
      agentId: agent.id,
      payload: {
        agentId: agent.id,
        config: agent.config,
        updatedConfig: { presetId }
      }
    });
  }

  /**
   * Bootstraps or retrieves the root administrative Director meta-agent.
   * Delegates to Module 7 `domain_director.ensureDirectorAgent` with the frozen
   * narrow `#directorHost` (getAgent/launchAgent only, never the runtime instance).
   *
   * Keep-but-ordinary bootstrap (Wave I, ticket c02d0b9): the director id is an
   * ordinary identifier. Any live instance carrying it is adopted unchanged —
   * there is no id+spec trust gate, no snapshot body rebuild, and no
   * re-authorization from `DIRECTOR_SPEC`. A fresh launch happens only when the
   * record is absent, `terminated`, or `recycled`; that launch runs through the
   * `#directorHost` engine path, which composes the bootstrap-only system scope
   * (`realmId: null`) and the hardcoded `realmBypass` grant.
   *
   * Hydration never restores authority: a snapshot-restored director is adopted
   * as a default-deny record, and the composition root re-applies the persisted
   * bypass grant through {@link restoreRealmBypassGrants}.
   */
  async ensureDirector(): Promise<Agent> {
    this.#assertNotDestroyed();
    if (
      this.#status !== RUNTIME_STATUS.READY &&
      this.#status !== RUNTIME_STATUS.RUNNING &&
      this.#status !== RUNTIME_STATUS.INITIALIZING
    ) {
      throw createRuntimeError(`AgentRuntime is not ready (current status: ${this.#status})`, 'ERR_RUNTIME_NOT_READY');
    }

    return ensureDirectorAgent(this.#directorHost);
  }

  /**
   * Grants the `realmBypass` authority to an active agent (operator action).
   *
   * Authority-bearing: only the exact injected `InternalPrincipal` reference
   * (the composition-root operator, also returned by
   * {@link getOperatorPrincipal}) may grant; agent principals, caller-asserted
   * flags, and plain lookalike objects are denied with `PERMISSION_DENIED`
   * before any mutation. The grant is recorded in the frozen registry
   * authority inputs and the rebuilt descriptor, never derived from an id; it
   * spans Realm scoping and descriptor visibility but never moves Realm
   * membership and never widens the capability (`allow`) axis.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Trusted caller context carrying `{ principal }`.
   * @returns The rebuilt frozen descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  grantRealmBypass(
    agentId: string,
    callerContext: { principal?: InternalPrincipal | AuthorityDescriptor } | null = null
  ): AuthorityDescriptor | null {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.grantRealmBypass(agentId, callerContext);
  }

  /**
   * Revokes the `realmBypass` authority from an active agent (operator action).
   *
   * Same authority gate as {@link grantRealmBypass}: the exact injected
   * `InternalPrincipal` only. Revocation clears the grant in the frozen
   * authority inputs and the rebuilt descriptor; membership and capability are
   * untouched.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Trusted caller context carrying `{ principal }`.
   * @returns The rebuilt frozen descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  revokeRealmBypass(
    agentId: string,
    callerContext: { principal?: InternalPrincipal | AuthorityDescriptor } | null = null
  ): AuthorityDescriptor | null {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.revokeRealmBypass(agentId, callerContext);
  }

  /**
   * Lists the canonical `(realmId, agentId)` identity keys of the active
   * agents currently holding the `realmBypass` grant (Wave I, ticket
   * d57cbc1; fix lane G2).
   *
   * The listing is registry state, not authority: it lets the composition root
   * persist and restore grants across a snapshot cycle. Canonical keys make
   * the persisted list realm-exact, so a scoped grant on a same-id pair
   * survives the round-trip; the key is internal-only and never appears on an
   * agent-facing surface. Unknown and recycled ids never appear (a recycled
   * record carries no grant).
   *
   * @returns Canonical identity keys of the active granted agents.
   */
  listRealmBypassGrants(): string[] {
    return this.#lifecycleManager.listRealmBypassGrants();
  }

  /**
   * Restores persisted `realmBypass` grants after snapshot hydration.
   *
   * Engine-only path: the caller must present the exact injected
   * `InternalPrincipal` reference. Each entry is granted through the lifecycle
   * gate; ids that are unknown or not active are skipped (fail-closed), so a
   * tampered snapshot id can never mint a grant.
   *
   * Entries are canonical `(realmId, agentId)` identity keys as emitted by
   * {@link listRealmBypassGrants}, resolving their exact registration. Legacy
   * snapshots that persisted bare ids still hydrate through the unique-match
   * rule; an ambiguous bare id resolves no registration and is skipped, so a
   * legacy grant is never duplicated across two Realms.
   *
   * @param agentIds - Persisted granted agent refs (canonical keys or legacy bare ids).
   * @param callerContext - Trusted caller context carrying `{ principal }`.
   * @returns The refs that were granted (active agents only).
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  restoreRealmBypassGrants(
    agentIds: readonly string[],
    callerContext: { principal?: InternalPrincipal | AuthorityDescriptor } | null = null
  ): string[] {
    this.#assertNotDestroyed();
    const principal = callerContext && typeof callerContext === 'object' ? callerContext.principal : null;
    if (principal !== this.#internalPrincipal) {
      throw createRuntimeError(
        'Permission denied: only the composition-root operator principal may restore realmBypass grants',
        'PERMISSION_DENIED'
      );
    }
    const restored: string[] = [];
    if (!Array.isArray(agentIds)) return restored;
    for (const agentId of agentIds) {
      if (typeof agentId !== 'string' || !agentId) continue;
      const descriptor = this.#lifecycleManager.grantRealmBypass(agentId, { principal: this.#internalPrincipal });
      if (descriptor) restored.push(agentId);
    }
    return restored;
  }

  /**
   * Grants the explicit `@template:authority` publishing capability to an
   * active agent (Wave U, ticket 2518510).
   *
   * Authority-bearing: only the exact injected `InternalPrincipal` reference
   * (the composition-root operator, also returned by
   * {@link getOperatorPrincipal}) may grant; agent principals, caller-asserted
   * flags, and plain lookalike objects are denied with `PERMISSION_DENIED`
   * before any mutation. The grant is recorded in the frozen registry
   * authority inputs and rebuilt into the descriptor's allow set as the exact
   * authority id; the wildcard `'*'` and `privileged` never imply it, and the
   * scope/selector axes are untouched.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Trusted caller context carrying `{ principal }`.
   * @returns The rebuilt frozen descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  grantTemplateAuthority(
    agentId: string,
    callerContext: { principal?: InternalPrincipal | AuthorityDescriptor } | null = null
  ): AuthorityDescriptor | null {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.grantTemplateAuthority(agentId, callerContext);
  }

  /**
   * Revokes the `@template:authority` publishing capability from an active
   * agent (operator action, Wave U ticket 2518510).
   *
   * Same authority gate as {@link grantTemplateAuthority}: the exact injected
   * `InternalPrincipal` only.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Trusted caller context carrying `{ principal }`.
   * @returns The rebuilt frozen descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  revokeTemplateAuthority(
    agentId: string,
    callerContext: { principal?: InternalPrincipal | AuthorityDescriptor } | null = null
  ): AuthorityDescriptor | null {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.revokeTemplateAuthority(agentId, callerContext);
  }

  /**
   * Grants the explicit `@hydration:authority` publishing capability to an
   * active agent (Wave U, ticket 2518510).
   *
   * Same authority gate and semantics as {@link grantTemplateAuthority}.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Trusted caller context carrying `{ principal }`.
   * @returns The rebuilt frozen descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  grantHydrationAuthority(
    agentId: string,
    callerContext: { principal?: InternalPrincipal | AuthorityDescriptor } | null = null
  ): AuthorityDescriptor | null {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.grantHydrationAuthority(agentId, callerContext);
  }

  /**
   * Revokes the `@hydration:authority` publishing capability from an active
   * agent (operator action, Wave U ticket 2518510).
   *
   * Same authority gate as {@link grantHydrationAuthority}: the exact injected
   * `InternalPrincipal` only.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Trusted caller context carrying `{ principal }`.
   * @returns The rebuilt frozen descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  revokeHydrationAuthority(
    agentId: string,
    callerContext: { principal?: InternalPrincipal | AuthorityDescriptor } | null = null
  ): AuthorityDescriptor | null {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.revokeHydrationAuthority(agentId, callerContext);
  }

  /**
   * Lists the canonical `(realmId, agentId)` identity keys of the active
   * agents currently holding the Wave U publishing-authority grants (ticket
   * 2518510).
   *
   * The listing is registry state, not authority: it lets the composition root
   * persist and restore grants across a snapshot cycle. Canonical keys make
   * the persisted lists realm-exact; they are internal-only and never appear
   * on an agent-facing surface.
   *
   * @returns Canonical identity keys per publishing authority.
   */
  listMetaAuthorityGrants(): { template: string[]; hydration: string[] } {
    return this.#lifecycleManager.listMetaAuthorityGrants();
  }

  /**
   * Restores persisted Wave U publishing-authority grants after snapshot
   * hydration (ticket 2518510).
   *
   * Engine-only path: the caller must present the exact injected
   * `InternalPrincipal` reference. Each entry is granted through the lifecycle
   * gate; ids that are unknown or not active are skipped (fail-closed), so a
   * tampered snapshot id can never mint a grant. Entries are canonical
   * `(realmId, agentId)` identity keys as emitted by
   * {@link listMetaAuthorityGrants}; legacy bare ids still hydrate through the
   * unique-match rule, and an ambiguous bare id is skipped rather than
   * duplicated across Realms.
   *
   * @param grants - Persisted granted refs per publishing authority.
   * @param callerContext - Trusted caller context carrying `{ principal }`.
   * @returns The refs that were granted (active agents only), per authority.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  restoreMetaAuthorityGrants(
    grants: { template?: readonly string[]; hydration?: readonly string[] } | null | undefined,
    callerContext: { principal?: InternalPrincipal | AuthorityDescriptor } | null = null
  ): { template: string[]; hydration: string[] } {
    this.#assertNotDestroyed();
    const principal = callerContext && typeof callerContext === 'object' ? callerContext.principal : null;
    if (principal !== this.#internalPrincipal) {
      throw createRuntimeError(
        'Permission denied: only the composition-root operator principal may restore publishing-authority grants',
        'PERMISSION_DENIED'
      );
    }
    const restored: { template: string[]; hydration: string[] } = { template: [], hydration: [] };
    if (!grants || typeof grants !== 'object') return restored;
    const templateIds = Array.isArray(grants.template) ? grants.template : [];
    for (const agentId of templateIds) {
      if (typeof agentId !== 'string' || !agentId) continue;
      const descriptor = this.#lifecycleManager.grantTemplateAuthority(agentId, { principal: this.#internalPrincipal });
      if (descriptor) restored.template.push(agentId);
    }
    const hydrationIds = Array.isArray(grants.hydration) ? grants.hydration : [];
    for (const agentId of hydrationIds) {
      if (typeof agentId !== 'string' || !agentId) continue;
      const descriptor = this.#lifecycleManager.grantHydrationAuthority(agentId, { principal: this.#internalPrincipal });
      if (descriptor) restored.hydration.push(agentId);
    }
    return restored;
  }

  /**
   * Flushes active runtime state: cancels in-flight turns, clears agent registries,
   * unbinds bus subscriptions, and resets underlying primitives.
   */
  reset(): void {
    this.#assertNotDestroyed();
    this.#rejectUserTurnWaiters(
      null,
      createRuntimeError('Runtime reset before the queued user turn was dispatched', 'ERR_RUNTIME_NOT_READY')
    );
    this.cancelAll('Runtime reset', { principal: this.#internalPrincipal });

    // MOD-20: drop the catalog subscription across the reset so no listener
    // fires against a half-cleared registry; it is re-bound below.
    this.#unbindPresetSource();

    for (const unsub of this.#messageSubscriptions.values()) {
      try {
        unsub();
      } catch {
        // Best-effort unsubscribe; the subscription map is cleared regardless.
      }
    }
    this.#messageSubscriptions.clear();

    if (this.#runtimeScheduler) {
      this.#runtimeScheduler.reset();
    }

    this.#agents.clear();
    this.#recycleBin.clear();
    this.#listeners.clear();
    if (this.#lifecycleManager) {
      this.#lifecycleManager.clearAuthorityRegistry();
    }

    if (this.#virtualFs && typeof this.#virtualFs.reset === 'function') {
      this.#virtualFs.reset({ principal: this.#internalPrincipal });
    }
    if (this.#messagingBus && typeof this.#messagingBus.reset === 'function') {
      this.#messagingBus.reset();
    }
    this.#bindBusTimerListener();
    if (this.#worldClock && typeof this.#worldClock.importSnapshot === 'function') {
      this.#worldClock.importSnapshot(
        { totalSeconds: 0, date: 'Day 1', events: [] },
        { principal: this.#internalPrincipal }
      );
    }

    this.#status = RUNTIME_STATUS.READY;

    // MOD-20: re-bind so the reset runtime remains reusable for catalog events.
    this.#bindPresetSource();
  }

  /**
   * Completely tears down runtime: cancels timers, unbinds bus listeners,
   * clears all subscribers, and sets status to DESTROYED.
   */
  destroy(): void {
    if (this.#status === RUNTIME_STATUS.DESTROYED) {
      return;
    }

    // MOD-20: the catalog subscription dies with the runtime.
    this.#unbindPresetSource();

    this.#rejectUserTurnWaiters(
      null,
      createRuntimeError('Runtime destroyed before the queued user turn was dispatched', 'ERR_RUNTIME_DESTROYED')
    );

    if (this.#busTimerListener && typeof this.#busTimerListener === 'function') {
      try {
        this.#busTimerListener();
      } catch {
        // Best-effort unbind; the listener slot is cleared regardless.
      }
      this.#busTimerListener = null;
    }

    if (this.#runtimeScheduler && typeof this.#runtimeScheduler.destroy === 'function') {
      this.#runtimeScheduler.destroy();
    }

    this.cancelAll('Runtime destroyed', { principal: this.#internalPrincipal });

    for (const unsub of this.#messageSubscriptions.values()) {
      try {
        unsub();
      } catch {
        // Best-effort unsubscribe; the subscription map is cleared regardless.
      }
    }
    this.#messageSubscriptions.clear();

    this.#agents.clear();
    this.#recycleBin.clear();
    this.#listeners.clear();
    if (this.#lifecycleManager) {
      this.#lifecycleManager.clearAuthorityRegistry();
    }

    if (this.#virtualFs && typeof this.#virtualFs.reset === 'function') {
      try {
        this.#virtualFs.reset({ principal: this.#internalPrincipal });
      } catch {
        // Best-effort reset; the runtime is marked destroyed regardless.
      }
    }
    if (this.#messagingBus && typeof this.#messagingBus.reset === 'function') {
      try {
        this.#messagingBus.reset();
      } catch {
        // Best-effort reset; the runtime is marked destroyed regardless.
      }
    }

    this.#status = RUNTIME_STATUS.DESTROYED;
  }

  // ====================================================================
  // Agent Provisioning & Registry (Lifecycle Manager Delegation)
  // ====================================================================

  /**
   * Launches and registers a new agent instance in the runtime.
   * Enforces universal AgentModelConfig resolution and security gating.
   *
   * The unified options object may declare a trusted baked prologue
   * (`history`): the lifecycle composes `[system message, ...declared entries]`
   * with launch-generated ids (INV-7) and no model call — only `initialPrompt`
   * triggers a turn. Legacy positional launches carry no declared history.
   *
   * @param config - Unified `LaunchAgentOptions` object (optionally carrying `principal`) or `AgentConfig`
   * @param arg2 - Legacy positional bridge (pre-instantiated model instance or initial prompt)
   * @param arg3 - Legacy positional bridge (pre-instantiated provider instance)
   * @param arg4 - Legacy positional bridge (initial prompt)
   */
  async launchAgent(
    config: (LaunchAgentOptions & { principal?: InternalPrincipal | AuthorityDescriptor }) | AgentConfig,
    arg2: unknown = null,
    arg3: unknown = null,
    arg4: unknown = null
  ): Promise<Agent> {
    this.#assertNotDestroyed();
    if (
      this.#status !== RUNTIME_STATUS.READY &&
      this.#status !== RUNTIME_STATUS.RUNNING &&
      this.#status !== RUNTIME_STATUS.INITIALIZING
    ) {
      throw createRuntimeError(`AgentRuntime is not ready to launch agents (current status: ${this.#status})`, 'ERR_RUNTIME_NOT_READY');
    }
    return this.#lifecycleManager.launchAgent(config, arg2, arg3, arg4);
  }

  /**
   * Retrieves an active agent by its identifier. Returns null if not found.
   *
   * Bare-id resolution is unique-match (Wave I, ticket d57cbc1): the same
   * literal id registered in two Realms is ambiguous and resolves `null` (fail
   * closed — never a wrong-Realm pick). Scoped consumers resolve through the
   * identity port with an explicit scope.
   */
  getAgent(agentId: string): Agent | null {
    return this.#lifecycleManager.getAgent(agentId);
  }

  /**
   * Returns true if exactly one active agent carries the given identifier
   * (an id registered in two Realms resolves `false` — fail closed); a
   * canonical identity key resolves its exact registration (Wave I, ticket
   * d57cbc1).
   */
  hasAgent(agentId: string): boolean {
    return this.#activeByRef(agentId) !== null;
  }

  /**
   * Returns a defensive list of currently active registered agents.
   * Optionally filtered by criteria.
   *
   * Realm wave A, ticket 3487c56: the additive `realmId` filter is applied
   * verbatim (`null`/empty selects ungrouped agents); the operator/store path
   * passes no scope and stays unscoped.
   */
  listAgents(options: AgentFilterOptions = {}): Agent[] {
    let list: AgentWithIdentity[] = Array.from(this.#agents.values());
    if (options?.includeRecycled) {
      list = list.concat(Array.from(this.#recycleBin.values()));
    }
    if (options && typeof options === 'object') {
      if (options.state) {
        list = list.filter((a) => a.state === options.state);
      }
      if (options.role) {
        list = list.filter((a) => a.config?.role === options.role || a.role === options.role);
      }
      if (options.spawnedBy) {
        list = list.filter((a) => a.config?.spawnedBy === options.spawnedBy || a.config?.creatorId === options.spawnedBy || a.spawnedBy === options.spawnedBy);
      }
      if (options.realmId !== undefined) {
        const realmFilter = typeof options.realmId === 'string' && options.realmId ? options.realmId : null;
        list = list.filter((a) => {
          const raw = a.config?.realmId;
          const realm = typeof raw === 'string' && raw ? raw : null;
          return realm === realmFilter;
        });
      }
    }
    return list;
  }

  /**
   * Returns the total count of active agents currently registered.
   */
  getAgentCount(): number {
    return this.#agents.size;
  }

  /**
   * Retrieves a soft-killed / recycled agent from the recycle bin.
   */
  getRecycledAgent(agentId: string): Agent | null {
    return this.#lifecycleManager.getRecycledAgent(agentId);
  }

  /**
   * Returns true if exactly one recycled agent carries the given identifier
   * (an id recycled in two Realms resolves `false` — fail closed); a canonical
   * identity key resolves its exact registration (Wave I, ticket d57cbc1).
   */
  hasRecycledAgent(agentId: string): boolean {
    return this.#recycledByRef(agentId) !== null;
  }

  /**
   * Returns a defensive list of all agents currently residing in the recycle bin.
   */
  listRecycledAgents(): Agent[] {
    return this.#lifecycleManager.listRecycledAgents();
  }

  /**
   * Checks if an agent is dead, terminated, or in the recycle bin.
   */
  isAgentTerminated(agentId: string): boolean {
    return this.#lifecycleManager.isAgentTerminated(agentId);
  }

  /**
   * Checks if an agent has an in-flight turn promise or is in running,
   * waiting_for_message, waiting_for_input, waiting_for_dependents, or canceling.
   */
  isAgentBusy(agentId: string): boolean {
    return this.#lifecycleManager.isAgentBusy(agentId);
  }

  /**
   * Transitions an agent to a new lifecycle state with strict FSM validation.
   *
   * Authority gate (MOD-21 W8, default-deny): a principal is mandatory; sudoer,
   * parent creator, or the agent itself may transition. Engine subsystems call
   * through the internal-principal-bound view wired at construction.
   *
   * @param agentOrId - Target agent ID or Agent instance
   * @param newState - Target FSM state string
   * @param stateDetail - Optional diagnostic detail string
   * @param callerContext - Caller context carrying `principal` or a registry `callerAgentId` identity
   */
  setAgentState(
    agentOrId: string | Agent,
    newState: string,
    stateDetail: string | null = null,
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.setAgentState(
      agentOrId,
      newState as AgentState,
      stateDetail,
      callerContext
    );
  }

  /**
   * Dynamically updates an agent's configuration, prompt directives, and model bindings.
   *
   * Authority-bearing fields (`privileged`, privilege flags, `admin`/`system`
   * role claims) require `callerContext` to resolve to a principal whose frozen
   * registry `AuthorityDescriptor` allows `@lifecycle:authority`. Anonymous and
   * unprivileged callers are denied before mutation.
   */
  updateAgentConfig(
    agentId: string,
    updatedConfig: Partial<AgentLaunchConfig>,
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.updateAgentConfig(agentId, updatedConfig, callerContext);
  }

  /**
   * Introspects the identity, permissions, and status of an agent.
   */
  whoami(agentId: string): AgentIdentityDescriptor {
    if (!agentId || typeof agentId !== 'string') {
      throw createRuntimeError("Valid string 'agentId' is required for whoami", 'ERR_AGENT_NOT_FOUND');
    }
    const agent = this.getAgent(agentId) as AgentWithIdentity | null;
    if (!agent) {
      throw createRuntimeError(`Agent '${this.#displayRef(agentId)}' not found`, 'ERR_AGENT_NOT_FOUND');
    }
    const isPrivileged = Boolean(agent.config?.privileged);
    const allowedTools = Array.isArray(agent.config?.allowedTools)
      ? [...agent.config.allowedTools]
      : (Array.isArray(agent.config?.tools)
        ? [...agent.config.tools]
        : (agent.config?.allowedTools === '*' || agent.config?.tools === '*' ? ['*'] : []));

    return {
      id: agent.id,
      name: agent.name || agent.config?.name || agent.id,
      role: agent.config?.role || agent.role || (isPrivileged ? 'admin' : 'user'),
      privileged: isPrivileged,
      workspaceId: agent.config?.workspaceId || agent.workspaceId || agent.id,
      allowedTools,
      state: agent.state || 'idle',
      spawnedBy: agent.config?.spawnedBy || agent.config?.creatorId || agent.spawnedBy || null,
      createdAt: agent.createdAt || Date.now()
    };
  }

  // ====================================================================
  // Agent Teardown & Lifecycle Control
  // ====================================================================

  /**
   * Soft-kills an active agent, moving it to the recycle bin and cancelling in-flight work.
   *
   * Authorization runs first: the lifecycle manager validates the caller before any
   * state mutation, so a denied kill leaves the victim's timers, messages, and
   * mailbox untouched. Scheduled-timer teardown runs only after the kill succeeds.
   */
  killAgent(
    agentId: string,
    reason: string = 'Terminated',
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent | null {
    this.#assertNotDestroyed();
    const killedAgent = this.#lifecycleManager.killAgent(agentId, reason, callerContext);
    const teardownKey = killedAgent
      ? this.#agentIdentityKeyOf(killedAgent)
      : this.#lifecycleManager.resolveAgentIdentityKey(agentId, callerContext);
    if (teardownKey && this.#runtimeScheduler && typeof this.#runtimeScheduler.teardownForAgent === 'function') {
      // Canonical teardown key (Wave I, ticket d57cbc1): the scheduler matches
      // its owner key realm-exactly, so a same-id registration in another
      // Realm keeps its timers. The record's bare id rides along as the
      // explicit second form, so a schedule armed before the agent existed
      // (stored under the bare dispatch reference) is torn down too.
      const teardownBareId = killedAgent && typeof killedAgent.id === 'string' && killedAgent.id
        ? killedAgent.id
        : undefined;
      this.#runtimeScheduler.teardownForAgent(
        teardownKey,
        reason || 'Terminated',
        false,
        teardownBareId ? { bareId: teardownBareId } : undefined
      );
    }
    this.#rejectUserTurnWaiters(
      killedAgent ? this.#agentIdentityKeyOf(killedAgent) : null,
      createRuntimeError(`Agent '${this.#displayRef(agentId)}' was terminated before its queued user turn was dispatched`, 'AGENT_TERMINATED')
    );
    return killedAgent;
  }

  /**
   * Restores an agent from the recycle bin back to active idle status.
   *
   * Authority gate (MOD-21 W8, default-deny): a principal is mandatory; a
   * record whose live-construction descriptor would regain authority
   * (`privileged` or wildcard tools) requires lifecycle authority.
   */
  restoreAgent(
    agentId: string,
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.restoreAgent(agentId, callerContext);
  }

  /**
   * Permanently purges an agent from the runtime, recycle bin, messaging bus, and VFS.
   *
   * Authority gate (MOD-21 W8, default-deny): purge is irreversible and
   * sudoer-only; authorization runs before any scheduler teardown, so a denied
   * purge leaves the victim's timers untouched. A missing id returns `false`.
   */
  purgeAgent(
    agentId: string,
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): boolean {
    this.#assertNotDestroyed();
    // Resolve the canonical teardown key BEFORE the purge removes the record
    // (Wave I, ticket d57cbc1), using the same mutation resolution the purge
    // itself applies (realm-scoped for realm-bound callers). Its bare id is
    // resolved from the same surviving record so the scheduler can match
    // schedules armed under the bare dispatch reference before the agent
    // existed or while it sat in the recycle bin.
    const teardownKey = this.#lifecycleManager.resolveAgentIdentityKey(agentId, callerContext);
    const teardownRecord = teardownKey
      ? (this.getRecycledAgent(teardownKey) || this.getAgent(teardownKey))
      : null;
    const purged = this.#lifecycleManager.purgeAgent(agentId, callerContext);
    if (purged) {
      if (teardownKey && this.#runtimeScheduler && typeof this.#runtimeScheduler.teardownForAgent === 'function') {
        const teardownBareId = teardownRecord && typeof teardownRecord.id === 'string' && teardownRecord.id
          ? teardownRecord.id
          : undefined;
        this.#runtimeScheduler.teardownForAgent(
          teardownKey,
          'Purged permanently',
          true,
          teardownBareId ? { bareId: teardownBareId } : undefined
        );
      }
      this.#rejectUserTurnWaiters(
        null,
        createRuntimeError(`Agent '${this.#displayRef(agentId)}' was purged before its queued user turn was dispatched`, 'AGENT_NOT_FOUND')
      );
    }
    return purged;
  }

  /**
   * Permanently purges all agents currently residing in the recycle bin.
   *
   * Authority gate (MOD-21 W8, default-deny): sudoer-only.
   *
   * Each purged record routes through `purgeAgent`, which resolves the
   * canonical identity key and the record's bare id before the record is
   * removed and hands both to the scheduler teardown (Wave I, ticket
   * d57cbc1) — so a schedule armed under the bare dispatch reference before
   * the agent existed, or while it sat in the recycle bin, is torn down too
   * (INV-PURGE).
   */
  emptyRecycleBin(
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): number {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.emptyRecycleBin(callerContext);
  }

  /**
   * Emergency unstick engine: cancels stuck promises and resets agent state to 'idle'.
   *
   * Authority gate (MOD-21 W8, default-deny): a principal is mandatory; sudoer,
   * parent creator, or the agent itself may unstick.
   */
  unstickAgent(
    agentId: string,
    reason: string = 'Unstuck by user',
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): UnstickResult {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.unstickAgent(agentId, reason, callerContext);
  }

  /**
   * Aborts an in-flight execution turn for a specific agent via AbortController.
   *
   * Authority gate (MOD-21 W8, default-deny): a principal is mandatory; sudoer,
   * parent creator, or the agent itself may cancel. Unknown agents stay `false`.
   */
  cancelAgent(
    agentId: string,
    reason: string = 'Cancelled by user',
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): boolean {
    this.#assertNotDestroyed();
    return this.#lifecycleManager.cancelAgent(agentId, reason, callerContext);
  }

  /**
   * Aborts in-flight execution turns across all active agents.
   *
   * Authority gate (MOD-21 W8, default-deny): sudoer-only; authorization runs
   * before any scheduler cancellation, so a denied call leaves timers intact.
   */
  cancelAll(
    reason: string = 'Cancelled all agents',
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): void {
    this.#lifecycleManager.cancelAll(reason, callerContext);
    if (this.#runtimeScheduler && typeof this.#runtimeScheduler.cancelAll === 'function') {
      this.#runtimeScheduler.cancelAll();
    }
  }

  // ====================================================================
  // Turn Execution (Turn Execution Engine Delegation)
  // ====================================================================

  /**
   * Triggers an execution turn for a specific agent through the turn execution pipeline.
   * Handles token streaming, tool call dispatching, and precall deduplication.
   */
  async executeAgentTurn(
    agentId: string,
    input: TurnInput = null,
    options: TurnExecutionOptions | string = {}
  ): Promise<TurnExecutionResult> {
    this.#assertNotDestroyed();
    this.#assertReadyOrRunning();

    this.#activeTurnsCount++;
    if (this.#status === RUNTIME_STATUS.READY) {
      this.#status = RUNTIME_STATUS.RUNNING;
    }

    // A queued user trigger reaches this method through TriggerDispatcher; claim
    // its waiter so `enqueueUserTurn` settles with the same receipt.
    const userTurnWaiter = this.#claimUserTurnWaiter(options);

    try {
      const result = await this.#turnExecutionEngine.executeAgentTurn(agentId, input, options);
      if (userTurnWaiter) userTurnWaiter.resolve(result);
      return result;
    } catch (err) {
      if (userTurnWaiter) userTurnWaiter.reject(err);
      throw err;
    } finally {
      this.#activeTurnsCount--;
      if (this.#activeTurnsCount === 0 && this.#status === RUNTIME_STATUS.RUNNING) {
        this.#status = RUNTIME_STATUS.READY;
      }
    }
  }

  /**
   * Enqueues a user-initiated turn on the centralized TriggerQueue and resolves
   * with the canonical receipt of the dispatched turn.
   *
   * The queue stays the single dispatch point: `TriggerDispatcher.dispatchTrigger`
   * unpacks the `TRIGGER_TYPES.USER` trigger and executes it through
   * `executeAgentTurn`; this facade correlates that delegated execution by the
   * queue-assigned `triggerId` and settles the caller's promise with the same
   * `TurnExecutionResult` a direct call would return. Falls back to a direct
   * `executeAgentTurn` only when no TriggerQueue is available.
   */
  enqueueUserTurn(
    agentId: string,
    input: TurnInput = null,
    options: TurnExecutionOptions | string = {}
  ): Promise<TurnExecutionResult> {
    this.#assertNotDestroyed();
    this.#assertReadyOrRunning();

    if (typeof agentId !== 'string' || !agentId.trim()) {
      throw createRuntimeError("Valid string 'agentId' is required to enqueue a user turn", 'INVALID_ARGUMENTS');
    }

    const queue = this.#triggerQueue;
    if (!queue || typeof queue.enqueue !== 'function') {
      return this.executeAgentTurn(agentId, input, options);
    }

    const activeAgent = this.#activeByRef(agentId);
    if (!activeAgent) {
      const recycled = this.#recycledByRef(agentId) !== null;
      const refLabel = this.#displayRef(agentId);
      throw createRuntimeError(
        recycled ? `Agent '${refLabel}' is terminated` : `Agent '${refLabel}' not found`,
        recycled ? 'AGENT_TERMINATED' : 'AGENT_NOT_FOUND'
      );
    }
    const agentKey = this.#agentIdentityKeyOf(activeAgent);

    const turnOptions: TurnExecutionOptions = typeof options === 'string'
      ? { category: options }
      : (options && typeof options === 'object' && !Array.isArray(options) ? options : {});
    const source = typeof turnOptions.sender === 'string' && turnOptions.sender.trim()
      ? turnOptions.sender
      : 'user';

    return new Promise<TurnExecutionResult>((resolve, reject) => {
      let triggerId;
      try {
        // Canonical dispatch address (Wave I, ticket d57cbc1): the queue
        // partitions per registration, so two Realms' same-id agents never
        // share a queue or an intra-agent ordering slot.
        triggerId = queue.enqueue({
          type: TRIGGER_TYPES.USER,
          targetAgentId: agentKey,
          source,
          payload: { input, options: turnOptions }
        });
      } catch (err) {
        reject(err);
        return;
      }
      this.#userTurnWaiters.set(triggerId, { agentKey, resolve, reject });
    });
  }

  // ====================================================================
  // History Management & Undo/Redo (History Manager Delegation)
  // ====================================================================

  /**
   * Updates an existing message in an agent's history in-place.
   */
  updateHistoryMessage(
    agentId: string,
    messageIndexOrId: number | string,
    updatedFields: string | MessageUpdateFields
  ): HistoryMessage {
    return this.#historyManager.updateHistoryMessage(agentId, messageIndexOrId, updatedFields);
  }

  /**
   * Deletes a message from an agent's history with tool-pairing cascading cleanup.
   */
  deleteHistoryMessage(agentId: string, messageIndexOrId: number | string): boolean {
    return this.#historyManager.deleteHistoryMessage(agentId, messageIndexOrId);
  }

  /**
   * Undoes the most recent turn bundle for an agent, pushing to the redo stack.
   * An explicit `targetTurnId` (message `id` or `metadata.turnId`) selects an
   * earlier turn in place; blank values behave as "no target" and an unmatched
   * target returns a structured `{ success: false, reason, targetTurnId }`
   * failure without mutating history.
   */
  undoAgentTurn(agentId: string, targetTurnId: string | null = null): UndoTurnResult | UndoTurnSelectionFailure {
    return this.#historyManager.undoAgentTurn(agentId, targetTurnId);
  }

  /**
   * Redoes the most recently undone turn bundle for an agent from the redo stack.
   */
  redoAgentTurn(agentId: string): RedoTurnResult {
    return this.#historyManager.redoAgentTurn(agentId);
  }

  /**
   * Retries the most recent user turn for an agent, re-running execution.
   */
  async retryAgentTurn(agentId: string): Promise<TurnExecutionResult> {
    this.#assertNotDestroyed();
    this.#assertReadyOrRunning();
    return this.#historyManager.retryAgentTurn(agentId) as Promise<TurnExecutionResult>;
  }

  /**
   * Checks if an agent has an interrupted turn awaiting resumption.
   */
  isAgentInterrupted(agentId: string): boolean {
    return this.#historyManager.isAgentInterrupted(agentId);
  }

  // ====================================================================
  // Multi-Agent RPC & Coordination (Invocation Engine & Bus Delegation)
  // ====================================================================

  /**
   * Dispatches a direct subagent RPC invocation. Returns an InvocationReceipt.
   */
  invokeAgent(invokerId: string, targetAgentId: string, prompt: string, options: InvokeAgentOptions = {}): InvocationReceipt {
    this.#assertNotDestroyed();
    if (!this.#invocationEngine) {
      throw createRuntimeError('InvocationEngine is not available on AgentRuntime', 'ERR_RUNTIME_NOT_INITIALIZED');
    }
    return this.#invocationEngine.invokeAgent(invokerId, targetAgentId, prompt, options);
  }

  /**
   * Turn-level await primitive: halts caller execution until specified invocations resolve.
   *
   * Realm wave A, ticket 3487c56: the facade/port path may supply a trusted
   * `callerContext` (identity-only). When supplied, the invocation engine
   * requires the caller to be the invocation's invoker, its target, or a
   * Realm-bypass principal (the exact injected internal principal or an agent
   * holding the registry `realmBypass` grant — Wave I, ticket c02d0b9); an
   * unresolvable caller or an unrelated resolved caller fails closed with
   * `PERMISSION_DENIED`. Omitted on the composition-root/host path (legacy
   * behavior).
   */
  async waitForInvocation(
    optionsOrIds: string | string[] | WaitForInvocationRequest,
    maybeOptions: WaitForInvocationOptions = {},
    callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Promise<WaitForInvocationResult> {
    this.#assertNotDestroyed();
    if (!this.#invocationEngine) {
      throw createRuntimeError('InvocationEngine is not available on AgentRuntime', 'ERR_RUNTIME_NOT_INITIALIZED');
    }
    return this.#invocationEngine.waitForInvocation(
      optionsOrIds as string | readonly string[],
      maybeOptions,
      this.#resolveInvocationCallerContext(callerContext)
    );
  }

  /**
   * Normalizes a facade/port caller context into the identity-only engine
   * context. Returns `null` when the facade was called without any caller
   * channel (host/engine path); a supplied-but-empty/forged context resolves to
   * `{}`, which the invocation engine fails closed.
   *
   * @param callerContext - Facade/port-supplied caller context.
   * @returns Identity-only engine caller context, or `null` for the host path.
   */
  #resolveInvocationCallerContext(callerContext: unknown): InvocationCallerContext | null {
    if (!callerContext || typeof callerContext !== 'object') return null;
    const source = callerContext as { principal?: InternalPrincipal | AuthorityDescriptor; callerAgentId?: unknown; agentId?: unknown; callerKey?: unknown };
    const resolved: { callerAgentId?: string; callerKey?: string; principal?: InternalPrincipal | AuthorityDescriptor } = {};
    const principal = source.principal;
    if (principal && typeof principal === 'object') {
      resolved.principal = principal;
    }
    // Trusted canonical key channel (Wave I, ticket d57cbc1): forwarded so the
    // engine can resolve a same-literal-id caller realm-exactly; the engine
    // honors it only when the registry authority resolver binds the key (a
    // forged key grants nothing).
    if (typeof source.callerKey === 'string' && source.callerKey) {
      resolved.callerKey = source.callerKey;
    }
    const claimed = typeof source.callerAgentId === 'string' && source.callerAgentId
      ? source.callerAgentId
      : (typeof source.agentId === 'string' && source.agentId ? source.agentId : null);
    if (claimed) {
      resolved.callerAgentId = claimed;
    }
    return resolved;
  }

  /**
   * Halts caller execution until specified sender(s) deliver messages to the target agent inbox.
   */
  async waitForMail(
    recipientId: string,
    optionsOrSenders: string | string[] | WaitForMailOptions = {},
    maybeOptions: WaitForMailOptions = {}
  ): Promise<WaitForMailResult> {
    this.#assertNotDestroyed();
    if (!this.#messagingBus) {
      throw createRuntimeError('MessagingBus is not available on AgentRuntime', 'ERR_RUNTIME_NOT_INITIALIZED');
    }
    return this.#messagingBus.waitForMail(recipientId, optionsOrSenders, maybeOptions);
  }

  // ====================================================================
  // Scheduling & Timers (Runtime Scheduler Delegation)
  // ====================================================================

  /**
   * Schedules a deferred execution turn or world clock event for an agent.
   *
   * Trust boundary: authority and Realm scope are principal-based. An explicit
   * `context.principal` is forwarded unchanged for the scheduler's reference
   * validation; a `callerAgentId`/`agentId` identity claim is registry-resolved
   * through `#resolveSchedulerPrincipalContext`. Privilege/role/realm flags in
   * `params` or `context` are never consulted.
   *
   * @param params - Scheduling parameters (`agentId`, `prompt`, `durationSeconds`, `timerCondition`).
   * @param context - Trusted caller context carrying an optional `{ principal }`.
   * @returns The scheduler receipt unchanged.
   */
  schedule(params: ScheduleParams, context: object = {}): ScheduleReceipt {
    this.#assertNotDestroyed();
    return this.#runtimeScheduler.schedule(params, this.#resolveSchedulerPrincipalContext(context));
  }

  /**
   * Translates a facade caller context into the scheduler's `{ principal }`
   * authority context. An explicit `context.principal` is forwarded unchanged
   * for the scheduler's reference validation; a `callerAgentId`/`agentId`
   * identity claim is resolved through the lifecycle registry so authority
   * still comes from the frozen descriptor. All privilege- and role-looking
   * flags are dropped.
   */
  #resolveSchedulerPrincipalContext(context: unknown): { principal?: InternalPrincipal | AuthorityDescriptor; callerKey?: string } {
    if (!context || typeof context !== 'object') return {};
    const callerContext = context as SchedulerCallerContext;
    const resolved: { principal?: InternalPrincipal | AuthorityDescriptor; callerKey?: string } = {};
    // Trusted canonical key channel (Wave I, ticket d57cbc1): forwarded
    // alongside the reference-validated principal so the scheduler resolves a
    // same-literal-id caller realm-exactly. The scheduler accepts it only when
    // the registry authority resolver binds the key to the same descriptor.
    if (typeof callerContext.callerKey === 'string' && callerContext.callerKey) {
      resolved.callerKey = callerContext.callerKey;
    }
    if (callerContext.principal && typeof callerContext.principal === 'object') {
      resolved.principal = callerContext.principal;
      return resolved;
    }
    const claimedId = typeof callerContext.callerAgentId === 'string' && callerContext.callerAgentId
      ? callerContext.callerAgentId
      : (typeof callerContext.agentId === 'string' && callerContext.agentId ? callerContext.agentId : null);
    if (claimedId && this.#lifecycleManager) {
      const descriptor = this.#lifecycleManager.getAuthorityDescriptor(claimedId);
      if (descriptor) resolved.principal = descriptor;
    }
    return resolved;
  }

  /**
   * Resolves the trusted Realm scope of an agent-facing port caller (Realm
   * wave A, ticket 3487c56): the exact injected internal principal is the
   * operator bypass; an explicit principal is honored only when it IS the
   * registered descriptor instance — by bare subject, or by a trusted
   * `callerKey` the registry binds to that same descriptor (Wave I, ticket
   * d57cbc1), so a same-literal-id caller resolves even when its bare subject
   * is ambiguous across Realms; a `callerAgentId`/`agentId` claim is resolved
   * through the registry, but a supplied `callerKey` that resolves nothing (or
   * conflicts with the bare claim) fails closed — the bare claim is never its
   * fallback, so a stale key left over from a recycled holder cannot retarget
   * the other Realm's same-literal-id twin (fix lane G5, residual R2).
   * Identity-only: privilege/role flags are dropped.
   * Returns `null` when no trusted caller resolves.
   *
   * @param context - Port caller context.
   * @returns Resolved scope (with the caller's canonical key when one
   * resolved), or `null` (fail-closed) when unauthenticated.
   */
  #resolveBoundCallerScope(context: unknown): { subject: string | null; realmId: string | null; bypass: boolean; callerKey?: string } | null {
    if (!context || typeof context !== 'object') return null;
    const callerContext = context as SchedulerCallerContext;
    const callerKey = typeof callerContext.callerKey === 'string' && callerContext.callerKey ? callerContext.callerKey : null;
    const principal = callerContext.principal;
    if (principal && typeof principal === 'object') {
      if (principal === this.#internalPrincipal) {
        return { subject: null, realmId: null, bypass: true };
      }
      if (!this.#lifecycleManager || principal.kind !== 'agent' || typeof principal.subject !== 'string' || !principal.subject) {
        return null;
      }
      // Canonical key channel (Wave I, ticket d57cbc1) before the bare-subject
      // check: when the trusted key binds this exact descriptor instance, the
      // scope projects realm-exactly instead of failing closed on an ambiguous
      // bare subject. The descriptor remains the sole authority anchor.
      if (callerKey && this.#lifecycleManager.getAuthorityDescriptor(callerKey) === principal) {
        return this.#projectCallerScope(callerKey);
      }
      const registered = this.#lifecycleManager.getAuthorityDescriptor(principal.subject);
      if (!registered || registered !== principal) return null;
      return this.#projectCallerScope(principal.subject);
    }
    const claimedId = typeof callerContext.callerAgentId === 'string' && callerContext.callerAgentId
      ? callerContext.callerAgentId
      : (typeof callerContext.agentId === 'string' && callerContext.agentId ? callerContext.agentId : null);
    if (!this.#lifecycleManager) return null;
    if (callerKey) {
      const keyDescriptor = this.#lifecycleManager.getAuthorityDescriptor(callerKey);
      if (keyDescriptor) {
        if (!claimedId) return this.#projectCallerScope(callerKey);
        if (this.#lifecycleManager.getAuthorityDescriptor(claimedId) === keyDescriptor) {
          return this.#projectCallerScope(callerKey);
        }
      }
      // Supplied-but-unresolvable pinned key (Wave I, ticket d57cbc1; fix lane
      // G5, residual R2): fail closed — the bare id claim is never a fallback
      // for a stale/forged key, so a recycled holder's key cannot retarget the
      // other Realm's same-literal-id twin.
      return null;
    }
    if (!claimedId) return null;
    if (!this.#lifecycleManager.getAuthorityDescriptor(claimedId)) return null;
    return this.#projectCallerScope(claimedId);
  }

  /**
   * Projects a registered caller subject through the trusted identity port
   * (Realm wave A, ticket 3487c56; Wave I, ticket d57cbc1): the reference may
   * be a bare id (unique match) or a canonical identity key (exact match). The
   * resolved projection's registry-owned canonical key rides along as the
   * scope's `callerKey` when one resolves, so downstream visibility lookups
   * address the exact registration even when the bare id is ambiguous.
   *
   * @param ref - Registered agent subject (bare id or canonical identity key).
   * @returns The caller's Realm scope projection (with `callerKey` when resolved).
   */
  #projectCallerScope(ref: string): { subject: string; realmId: string | null; bypass: boolean; callerKey?: string } {
    const projection = this.createAgentIdentityPort().getAgentIdentity(ref);
    const scope: { subject: string; realmId: string | null; bypass: boolean; callerKey?: string } = {
      subject: projection && typeof projection.id === 'string' && projection.id ? projection.id : ref,
      realmId: projection ? projection.realmId : null,
      bypass: projection ? projection.realmBypass : false
    };
    if (projection && typeof projection.key === 'string' && projection.key) {
      scope.callerKey = projection.key;
    }
    return scope;
  }

  /**
   * Lists agents for an agent-facing port caller (Realm wave A, ticket
   * 3487c56; Wave I, ticket d57cbc1). Operator/host calls (`context` omitted)
   * forward `options` unchanged and stay unscoped; caller-scoped calls apply
   * the same principal-driven visibility predicate as `listAgentDescriptors`
   * (anonymous/unresolvable callers receive `[]`; realm-bound callers see
   * same-scope visible members; the director/operator bypass sees all active
   * agents).
   *
   * Realm confinement is by registration, not by bare id (Wave I, ticket
   * d57cbc1): the unscoped list is filtered to the caller's own scope before
   * the descriptor-id visibility test, so a visible `scout` in the caller's
   * Realm can never leak the other Realm's same-id `scout` into the view.
   *
   * @param options - Agent filter options forwarded to {@link listAgents}.
   * @param context - Port caller context, or `undefined` for the host path.
   * @returns The matching agents under the resolved scope.
   */
  #listAgentsForCaller(options: AgentFilterOptions = {}, context?: object): Agent[] {
    const filtered = this.listAgents(options);
    if (context === undefined) return filtered;
    const scope = this.#resolveBoundCallerScope(context);
    if (!scope) return [];
    if (scope.bypass) return filtered;
    if (!scope.subject || !this.#lifecycleManager) return [];
    const sameScope = filtered.filter((agent) => this.#agentRealmId(agent) === scope.realmId);
    // Canonical visibility reference (Wave I, ticket d57cbc1): the caller's
    // registry-owned identity key resolves the exact descriptor downstream, so
    // a same-literal-id caller receives its own Realm's members instead of the
    // fail-closed empty view an ambiguous bare subject would produce. The
    // registry maps a foreign/forged key to no descriptor.
    const visibilityRef = scope.callerKey || scope.subject;
    const visible = new Set(
      this.#lifecycleManager
        .listAgentDescriptors({ callerAgentId: visibilityRef })
        .map((descriptor) => descriptor.id)
    );
    return sameScope.filter((agent) => visible.has(agent.id));
  }

  /**
   * Cancels a pending scheduled task by timerId.
   *
   * Trust boundary: authority is principal-based. `context.principal` must be
   * the injected engine principal or a frozen registry `AuthorityDescriptor`;
   * a `callerAgentId` identity claim is registry-resolved. Privilege/role flags
   * in `context`, `timerIdOrParams`, or `maybeReason` are ignored.
   */
  cancelSchedule(
    timerIdOrParams: string | CancelScheduleParams,
    maybeReason: string | null = null,
    context: object = {}
  ): CancelScheduleReceipt {
    return this.#runtimeScheduler.cancelSchedule(
      timerIdOrParams,
      maybeReason,
      this.#resolveSchedulerPrincipalContext(context)
    );
  }

  /**
   * Lists scheduled tasks with optional status and agent filtering.
   *
   * Trust boundary: authority is principal-based (see `cancelSchedule`).
   * Privilege/role flags are ignored; `options` contributes only target-agent
   * and status filters.
   */
  listSchedules(options: ListSchedulesOptions | string = {}, context: object = {}): ScheduleListResult {
    return this.#runtimeScheduler.listSchedules(options, this.#resolveSchedulerPrincipalContext(context));
  }

  /**
   * Exports raw scheduled timers for snapshot persistence.
   */
  exportSchedules(): SerializedScheduledTimer[] {
    return this.#runtimeScheduler.exportSchedules();
  }

  /**
   * Hydrates scheduled timers from a persisted snapshot.
   */
  importSchedules(schedulesList: SerializedScheduledTimer[]): void {
    return this.#runtimeScheduler.importSchedules(schedulesList);
  }

  // ====================================================================
  // Telemetry & Metrics (Runtime Telemetry Delegation)
  // ====================================================================

  /**
   * Retrieves token consumption and profiling telemetry for a specific agent.
   * Metrics are created on first read, so an unknown (unambiguous) id yields a
   * zeroed snapshot rather than null; `null` is returned only for a
   * missing/blank id or a Realm-ambiguous bare id.
   *
   * Bare-id resolution is unique-match (Wave I, ticket d57cbc1; fix lane G2):
   * a uniquely registered agent's metrics are read under its canonical
   * identity key (where the turn engine records them), and a bare id
   * registered in two Realms resolves `null` — never the other Realm's
   * counters and never a zeroed snapshot that masks the ambiguity.
   */
  getAgentTelemetry(agentId: string): AgentTelemetryMetrics | null {
    if (!agentId || typeof agentId !== 'string') return null;
    // Several active/recycled registrations for one bare id (or one of each)
    // are Realm-ambiguous: fail closed.
    if (this.#isRealmAmbiguousRef(agentId)) return null;
    const active = this.#activeByRef(agentId);
    if (active) return this.#telemetryTracker.getAgentTelemetry(this.#telemetryAddress(active));
    const recycled = this.#recycledByRef(agentId);
    if (recycled) return this.#telemetryTracker.getAgentTelemetry(this.#telemetryAddress(recycled));
    // Unknown ids keep the legacy zeroed-snapshot behavior.
    return this.#telemetryTracker.getAgentTelemetry(agentId);
  }

  /**
   * Clears cumulative token telemetry for a specific agent (unique-match
   * bare-id resolution; a Realm-ambiguous id clears nothing and returns
   * `false`).
   */
  clearAgentTelemetry(agentId: string): boolean {
    if (!agentId || typeof agentId !== 'string') return false;
    if (this.#isRealmAmbiguousRef(agentId)) return false;
    const active = this.#activeByRef(agentId);
    if (active) return this.#telemetryTracker.clearAgentTelemetry(this.#telemetryAddress(active));
    const recycled = this.#recycledByRef(agentId);
    if (recycled) return this.#telemetryTracker.clearAgentTelemetry(this.#telemetryAddress(recycled));
    return this.#telemetryTracker.clearAgentTelemetry(agentId);
  }

  /**
   * Clears the diagnostic error banner on an active or recycled agent without
   * mutating conversational history.
   *
   * Canonical-key resolution (defect 7d2c314): the lifecycle lookup only
   * resolves bare ids, so the facade resolves the exact registration first —
   * a canonical `(realmId, agentId)` identity key clears its own record even
   * when the same literal id is live in another Realm — and clears through
   * the entity's public `clearLastError` seam (the same call the lifecycle
   * method makes). An unresolvable reference falls back to the lifecycle
   * lookup, keeping the legacy bare-id semantics byte-compatible.
   */
  clearAgentLastError(agentId: string): boolean {
    if (!agentId || typeof agentId !== 'string') return false;
    const resolved = this.#activeByRef(agentId) || this.#recycledByRef(agentId);
    if (resolved && typeof resolved.clearLastError === 'function') {
      resolved.clearLastError();
      return true;
    }
    return this.#lifecycleManager.clearAgentLastError(agentId);
  }

  /**
   * Retrieves aggregate system-wide performance and token metrics across all agents.
   * Pending timers are counted through an internal privileged scheduler query; the
   * public `listSchedules()` default-deny for anonymous callers is unaffected.
   */
  getRuntimeMetrics(): RuntimeAggregateMetrics {
    let totalTurnsExecuted = 0;
    let totalTokensConsumed = 0;

    for (const agent of this.#agents.values()) {
      totalTurnsExecuted += (agent.turnCount || agent.telemetry?.turnCount || 0);
      totalTokensConsumed += (agent.telemetry?.totalTokens || 0);
    }
    for (const agent of this.#recycleBin.values()) {
      totalTurnsExecuted += (agent.turnCount || agent.telemetry?.turnCount || 0);
      totalTokensConsumed += (agent.telemetry?.totalTokens || 0);
    }

    // Internal telemetry is privileged through the opaque engine principal;
    // the public front door stays default-deny for anonymous callers.
    const activeTimersCount = (
      this.#runtimeScheduler.listSchedules({ status: 'all' }, { principal: this.#internalPrincipal }).schedules || []
    )
      .filter((task) => task.status === 'pending' || (task.status as string) === 'active')
      .length;

    return {
      totalActiveAgents: this.#agents.size,
      totalRecycledAgents: this.#recycleBin.size,
      totalTurnsExecuted,
      totalTokensConsumed,
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - this.#startTime) / 1000)),
      activeTimersCount
    };
  }

  // ====================================================================
  // Event Subscription & Pub/Sub
  // ====================================================================

  /**
   * Subscribes to all runtime events emitted across all subsystems.
   */
  subscribe(listener: RuntimeEventListener): UnsubscribeFn {
    if (typeof listener !== 'function') {
      throw new Error('AgentRuntime subscription listener must be a function');
    }
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Subscribes to a specific event type, or all events if eventType is '*'.
   */
  on(eventType: string | RuntimeEventListener, listener?: RuntimeEventListener): UnsubscribeFn {
    let actualType = eventType;
    let actualListener = listener;

    if (typeof eventType === 'function') {
      actualListener = eventType;
      actualType = '*';
    }

    if (typeof actualListener !== 'function') {
      throw new Error('AgentRuntime event listener must be a function');
    }

    const wrappedListener = (event: RuntimeEvent) => {
      if (event && (event.type === actualType || actualType === '*')) {
        actualListener(event);
      }
    };
    return this.subscribe(wrappedListener);
  }

  /**
   * Emits a runtime event to all registered subscribers.
   */
  #emit(event: RuntimeEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Error in AgentRuntime event listener:', err);
      }
    }
  }

  /**
   * Builds the canonical frozen SubsystemEmitPort handed to internal subsystems.
   * Subsystems emit through this port instead of reaching into the facade.
   */
  createSubsystemEmitPort(): SubsystemEmitPort {
    return Object.freeze({
      emit: (event: RuntimeEvent) => this.#emit(event)
    });
  }

  /**
   * Builds the canonical frozen PersistencePort. Exposes only snapshot/import
   * capabilities, never the runtime.
   */
  createPersistencePort(): PersistencePort {
    return Object.freeze({
      runtime: Object.freeze({
        listAgents: () => this.listAgents(),
        listRecycledAgents: () => this.listRecycledAgents(),
        exportSchedules: () => this.exportSchedules(),
        importSchedules: (schedules: SerializedScheduledTimer[]) => this.importSchedules(schedules),
        importSnapshot: (snapshot: RuntimeSnapshot) => this.importSnapshot(snapshot)
      }),
      // VFS snapshot members are tenant administration (MOD-21 W8-D): the
      // composition root authorizes them with the opaque internal principal.
      virtualFs: Object.freeze({
        exportSnapshot: () => this.#virtualFs.exportSnapshot({ principal: this.#internalPrincipal }),
        importSnapshot: (snapshot: unknown) => this.#virtualFs.importSnapshot(snapshot as VirtualFsSnapshot, { principal: this.#internalPrincipal })
      }),
      messagingBus: Object.freeze({
        exportSnapshot: () => this.#messagingBus.exportSnapshot(),
        importSnapshot: (snapshot: unknown) => this.#messagingBus.importSnapshot(snapshot as MessagingBusSnapshot)
      }),
      // WorldClock snapshot members are tenant administration (MOD-21 W10-C):
      // the composition root authorizes them with the opaque internal principal.
      worldClock: Object.freeze({
        exportSnapshot: () => this.#worldClock.exportSnapshot({ principal: this.#internalPrincipal }),
        importSnapshot: (snapshot: unknown) => this.#worldClock.importSnapshot(snapshot as WorldClockSnapshot, { principal: this.#internalPrincipal })
      })
    });
  }

  /**
   * Builds the canonical frozen LifecyclePort for tool descriptors.
   * Scheduler calls forward the explicit `context` argument so descriptor trust is
   * never conflated with caller-supplied option flags.
   */
  createLifecyclePort(): LifecyclePort {
    return Object.freeze({
      schedule: (params: ScheduleParams, context: object = {}) => this.schedule(params, context),
      listSchedules: (options?: ListSchedulesOptions | string, context?: object) => this.listSchedules(options, context),
      cancelSchedule: (timerIdOrParams: string | CancelScheduleParams, reason: string | null = null, context: object = {}) => this.cancelSchedule(timerIdOrParams, reason, context),
      invokeAgent: (invokerId: string, targetAgentId: string, prompt: string, options: InvokeAgentOptions = {}) => this.invokeAgent(invokerId, targetAgentId, prompt, options),
      // Agent-facing port path (Realm wave A, ticket 3487c56): the port call is
      // caller-scoped even when the descriptor forwards no identity, so an
      // unauthenticated wait fails closed in the invocation engine instead of
      // silently taking the composition-root/host path. An explicit `null`
      // context is coerced to the empty (unauthenticated) caller scope.
      waitForInvocation: (optionsOrIds: string | string[] | WaitForInvocationRequest, maybeOptions: WaitForInvocationOptions = {}, context?: object | null) =>
        this.waitForInvocation(optionsOrIds, maybeOptions, context ?? {}),
      launchAgent: (config: (LaunchAgentOptions & { principal?: InternalPrincipal | AuthorityDescriptor }) | AgentConfig, ...rest: unknown[]) => this.launchAgent(config, ...rest),
      killAgent: (agentId: string, reason: string = 'Terminated', callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null) => Boolean(this.killAgent(agentId, reason, callerContext)),
      // Operator/host calls (no context) forward `options` unchanged and stay
      // unscoped; agent-facing calls confine the listing to the caller's Realm
      // scope (scope-local members only — no always-visible director clause;
      // Realm wave R, ticket cf0e127).
      listAgents: (options: AgentFilterOptions = {}, context?: object) => this.#listAgentsForCaller(options, context),
      // Additive descriptor projection (ticket 9133495): forwards the
      // identity-only caller scope unchanged; the lifecycle manager resolves
      // visibility from the registry descriptor, never from caller claims.
      listAgentDescriptors: (options: { principal?: InternalPrincipal | AuthorityDescriptor; callerAgentId?: string } = {}) =>
        this.#lifecycleManager.listAgentDescriptors(options),
      restoreAgent: (agentId: string, callerContext: (CallerContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null) => this.restoreAgent(agentId, callerContext),
      whoami: (agentId: string) => this.whoami(agentId),
      undoAgentTurn: (agentId: string, targetTurnId: string | null = null) => this.#historyManager.undoAgentTurn(agentId, targetTurnId)
    });
  }

  /**
   * Builds the frozen AgentIdentityPort consumed by the tool execution layer
   * as `ToolExecutionPort.getAgentIdentity`.
   *
   * Every projection carries the Realm scope fields (`realmId`, `realmBypass`,
   * Realm wave A, ticket f5d1ccc; `realmBypass` reflects the registry-owned
   * grant, never the literal id — Wave I, ticket c02d0b9), the canonical
   * `(realmId, agentId)` identity `key` (Wave I, ticket d57cbc1), and the
   * resolved private workspace key (`workspaceId`, Realm wave R, ticket
   * 59e4673) so substrate paths rebuild the caller identity faithfully.
   *
   * Resolution (Wave I, ticket d57cbc1):
   * - `scope` omitted: unique match across Realms — single-Realm sessions keep
   *   the historical behavior, and an id registered in two Realms resolves
   *   `null` (fail closed; never a wrong-Realm pick).
   * - `{ realmId }` (string or `null`): exact `(realmId, agentId)` match.
   * - `{ realmBypass: true }`: unique match across Realms.
   * - `listAgentIdentities(scope)`: enumeration for broadcasts/scoped listings
   *   (realm-bound scopes enumerate exactly that Realm; omitted/bypass scopes
   *   enumerate every active registration).
   */
  createAgentIdentityPort(): AgentIdentityPort {
    return Object.freeze({
      getAgentIdentity: (agentId: string, scope?: AgentIdentityScope): AgentIdentityProjection | null => {
        const agent = this.#resolveActiveAgentByIdentity(agentId, scope);
        if (!agent) return null;
        return this.#buildIdentityProjection(agent);
      },
      listAgentIdentities: (scope?: AgentIdentityScope): AgentIdentityProjection[] => {
        const exactRealm = this.#scopeExactRealmId(scope);
        const projections: AgentIdentityProjection[] = [];
        for (const agent of this.#agents.values()) {
          if (exactRealm !== undefined && this.#agentRealmId(agent) !== exactRealm) continue;
          projections.push(this.#buildIdentityProjection(agent));
        }
        return projections;
      }
    });
  }

  /**
   * Reports whether a scope carries an explicit `realmId` constraint (any
   * value, `null` included) rather than the unique-match/bypass rule.
   *
   * @param scope - Trusted resolution scope.
   * @returns True when the scope is realm-exact.
   * @internal
   */
  #isExactScope(scope?: AgentIdentityScope): boolean {
    return Boolean(scope && typeof scope === 'object' && 'realmId' in scope && scope.realmBypass !== true);
  }

  /**
   * Normalizes a realm-exact scope to its Realm id (`null` = system scope), or
   * `undefined` when the scope is not realm-exact.
   *
   * @param scope - Trusted resolution scope.
   * @returns Realm id, or `undefined` for unique-match/bypass scopes.
   * @internal
   */
  #scopeExactRealmId(scope?: AgentIdentityScope): string | null | undefined {
    if (!this.#isExactScope(scope)) return undefined;
    const raw = (scope as AgentIdentityScope).realmId;
    return typeof raw === 'string' && raw ? raw : null;
  }

  /**
   * Resolves the single active registration an identity lookup addresses
   * (Wave I, ticket d57cbc1): realm-exact scopes go straight to the canonical
   * registry key, while unique-match/bypass scopes resolve the unique bare-id
   * match across Realms and fail closed (`null`) when ambiguous.
   *
   * @param agentId - Realm-local identifier to resolve.
   * @param scope - Trusted resolution scope.
   * @returns The resolved active agent, or `null`.
   * @internal
   */
  #resolveActiveAgentByIdentity(agentId: string, scope?: AgentIdentityScope): Agent | null {
    if (!agentId || typeof agentId !== 'string') return null;
    const exactRealm = this.#scopeExactRealmId(scope);
    if (exactRealm !== undefined) {
      return this.#agents.get(createAgentIdentityKey(exactRealm, agentId)) || null;
    }
    // Canonical identity key first (Wave I, ticket d57cbc1): a keyed lookup is
    // realm-exact even when the same literal id is registered in two Realms;
    // every other reference keeps the unique-match bare-id rule.
    const byKey = this.#agents.get(agentId);
    if (byKey) return byKey;
    return this.#activeByBareId(agentId);
  }

  /**
   * Builds the frozen identity projection of an active registration.
   *
   * Authority reads registry-owned inputs (MOD-21 W10, 5b585b7), never the
   * live entity config: direct config writes cannot widen the descriptor or
   * the legacy `privileged`/`allowedTools` channels. When a registry record
   * exists, its inputs are the only trusted source — a record with no selector
   * is default-deny, never a live-config fallback (MOD-21 W11-A, 556636e).
   * The config accessors remain the fallback only for entities without a
   * registry record.
   *
   * @param agent - Resolved active agent.
   * @returns The frozen projection.
   * @internal
   */
  #buildIdentityProjection(agent: Agent): AgentIdentityProjection {
    const identityKey = this.#agentIdentityKeyOf(agent);
    const authority = this.#lifecycleManager
      ? this.#lifecycleManager.getAuthorityDescriptorByKey(identityKey)
      : null;
    const inputs = this.#lifecycleManager
      ? this.#lifecycleManager.getAuthorityInputsByKey(identityKey)
      : null;
    const rawAllowed = inputs
      ? inputs.allowedTools
      : (agent.config?.allowedTools ?? agent.config?.tools);
    const allowedTools: string[] = [];
    if (Array.isArray(rawAllowed)) {
      for (let i = 0; i < rawAllowed.length; i++) allowedTools[allowedTools.length] = rawAllowed[i];
    } else if (rawAllowed === '*') {
      allowedTools[allowedTools.length] = '*';
    }
    const privileged = inputs
      ? inputs.privileged === true
      : Boolean(agent.config?.privileged);
    // Realm scope (Realm wave A, ticket f5d1ccc): membership is read from
    // the entity's owner-controlled `config.realmId` accessor — the value
    // is private-state backed, so no direct config write can move an agent
    // between Realms, and hydration keeps persisted membership (a scope
    // constraint, not a grant). Bypass is the registry-owned `realmBypass`
    // grant (Wave I, ticket c02d0b9): the engine bootstrap composes it on
    // the internal-principal launch path and the operator grant/revoke API
    // rebuilds it, so the literal id is never consulted. Wildcard/privileged
    // agents stay realm-bound; the operator/engine `InternalPrincipal` has
    // no agent id and is checked by exact reference inside each substrate.
    const realmId = this.#agentRealmId(agent);
    const realmBypass = inputs ? inputs.realmBypass === true : false;
    // Resolved private workspace key (Realm wave R, ticket 59e4673): the
    // substrate paths that rebuild the caller identity from this port
    // (e.g. the messaging-bus inline-file VirtualFS read) resolve the
    // caller's own private workspace through this field instead of falling
    // back to the plain agent id. Not authority-bearing — it only names
    // where the caller's private bytes live, derived from owner-controlled
    // config/entity state, never from caller-supplied data. The field carries
    // the *pin* (an explicit `config.workspaceId`/`workspace` differing from
    // the bare id) or the bare id; the VFS-owned
    // `resolveAgentPrivateWorkspaceKey` rule turns a realm-bound projection
    // into its canonical `key` partition and preserves a pin verbatim
    // (Wave I, ticket d57cbc1).
    const workspaceId = agent.config?.workspaceId || (agent as AgentWithIdentity).workspaceId || agent.id;
    return Object.freeze({
      id: agent.id,
      key: identityKey,
      privileged,
      allowedTools,
      realmId,
      realmBypass,
      workspaceId,
      ...(authority ? { authority } : {})
    });
  }

  // ====================================================================
  // Internal Trigger & Mail Hooks
  // ====================================================================

  /**
   * Executes an invocation turn routing through TriggerQueue for non-blocking execution.
   *
   * Canonical dispatch addressing (Wave I, ticket d57cbc1): the target
   * reference resolves through the identity port and dispatches under its
   * canonical `key` when one exists, so every enqueue path for a registration
   * shares one queue partition and one intra-agent ordering slot. When the
   * invoker's display source is a bare id, its canonical key is forwarded as
   * the trigger `sourceKey` so the queue's realm gate resolves the sender
   * realm-exactly instead of failing closed on a same-literal-id pair.
   */
  async #executeTurnForInvocation(
    targetAgentId: string,
    prompt: string,
    options: IndexableRecord<TurnExecutionContext>
  ): Promise<unknown> {
    const port = this.createAgentIdentityPort();
    const targetProjection = typeof targetAgentId === 'string' && targetAgentId
      ? port.getAgentIdentity(targetAgentId)
      : null;
    const dispatchTarget = targetProjection && typeof targetProjection.key === 'string' && targetProjection.key
      ? targetProjection.key
      : targetAgentId;
    const optionView = options as { sender?: unknown; invokerId?: unknown; sourceKey?: unknown };
    const source = typeof optionView?.sender === 'string' && optionView.sender
      ? optionView.sender
      : (typeof optionView?.invokerId === 'string' && optionView.invokerId ? optionView.invokerId : null);
    let sourceKey: string | null = null;
    if (source && source !== dispatchTarget && typeof optionView?.sourceKey !== 'string') {
      const sourceProjection = port.getAgentIdentity(source);
      if (sourceProjection && typeof sourceProjection.key === 'string' && sourceProjection.key) {
        sourceKey = sourceProjection.key;
      }
    }
    return this.#triggerDispatcher.executeTurnForInvocation(
      dispatchTarget,
      prompt,
      sourceKey ? { ...options, sourceKey } : options
    );
  }

  /**
   * Dispatches a queued trigger to its target agent.
   */
  async #dispatchTrigger(trigger: AgentTrigger): Promise<boolean> {
    return this.#triggerDispatcher.dispatchTrigger(trigger);
  }

  /**
   * Claims the pending `enqueueUserTurn` waiter correlated with a
   * dispatcher-forwarded user turn, if any.
   */
  #claimUserTurnWaiter(options: unknown): PendingUserTurnWaiter | null {
    if (!options || typeof options !== 'object') return null;
    const candidate = options as { triggerType?: unknown; triggerId?: unknown };
    if (candidate.triggerType !== TRIGGER_TYPES.USER) return null;
    const triggerId = candidate.triggerId;
    if (typeof triggerId !== 'string' || !this.#userTurnWaiters.has(triggerId)) return null;
    const waiter = this.#userTurnWaiters.get(triggerId) || null;
    if (waiter) this.#userTurnWaiters.delete(triggerId);
    return waiter;
  }

  /**
   * Rejects and removes pending user-turn waiters, optionally scoped to one agent.
   *
   * @param agentKey - Restrict rejection to this canonical `(realmId, agentId)`
   *   identity key (Wave I, ticket d57cbc1), or `null` for all.
   * @param error - Rejection reason forwarded to each waiter.
   */
  #rejectUserTurnWaiters(agentKey: string | null, error: Error): void {
    for (const [triggerId, waiter] of this.#userTurnWaiters) {
      if (agentKey && waiter.agentKey !== agentKey) continue;
      this.#userTurnWaiters.delete(triggerId);
      try {
        waiter.reject(error);
      } catch {
        // Best-effort rejection; the waiter is already removed from the map.
      }
    }
  }

  /**
   * Set up reactive agent mail subscription routing into TriggerQueue.
   * @param agentKey - Canonical `(realmId, agentId)` registration key.
   * @returns Unsubscribe function
   */
  #setupAgentMailSubscription(agentKey: string): () => void {
    return this.#triggerDispatcher.setupAgentMailSubscription(agentKey);
  }

  /**
   * Handles incoming bus messages to check for early timer cancellations.
   */
  #handleIncomingMessageForTimers(msg: IndexableRecord<MessageEnvelope>) {
    return this.#runtimeScheduler.handleIncomingMessageForTimers(msg);
  }

  // ====================================================================
  // Snapshot Persistence & Disaster Recovery
  // ====================================================================

  /**
   * Synchronously exports an atomic, fully serializable snapshot of the runtime.
   */
  exportSnapshot(): RuntimeSnapshot {
    this.#assertNotDestroyed();

    const activeAgentSnapshots: SerializedAgent[] = [];
    for (const agent of this.#agents.values()) {
      activeAgentSnapshots.push(agent.toSnapshot());
    }

    const recycledAgentSnapshots: SerializedAgent[] = [];
    for (const agent of this.#recycleBin.values()) {
      recycledAgentSnapshots.push(agent.toSnapshot());
    }

    const schedules = this.exportSchedules();

    return {
      status: this.#status,
      agents: activeAgentSnapshots,
      recycleBin: recycledAgentSnapshots,
      scheduledTimers: schedules,
      exportedAt: Date.now()
    };
  }

  /**
   * Atomically restores runtime state from a serialized snapshot (fail-closed).
   * Validates and hydrates every entity before mutating the current registry, so
   * a malformed snapshot leaves prior runtime state intact and surfaces
   * `ERR_SNAPSHOT_INVALID`.
   *
   * Hydrated authority is default-deny for every record (a snapshot contributes
   * no grant, the director included): the persisted body hydrates through the
   * entity snapshot contract, and the composition root re-applies persisted
   * `realmBypass` grants explicitly through `restoreRealmBypassGrants` (Wave I,
   * ticket c02d0b9). Active lifecycle claims are normalized before hydration:
   * active entries hydrate IDLE and terminal/recycled claims route to the
   * recycle bin (d5b583d).
   */
  importSnapshot(snapshot: RuntimeSnapshot): void {
    this.#assertNotDestroyed();

    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.agents)) {
      throw createRuntimeError(
        'Invalid snapshot structure: expected object with an agents array',
        'ERR_SNAPSHOT_INVALID'
      );
    }

    // Legacy snapshots may omit recycleBin entirely; normalize consistently with
    // validateSandboxState (BUG-ENC-008). A present, non-array value is malformed.
    if (snapshot.recycleBin !== undefined && snapshot.recycleBin !== null && !Array.isArray(snapshot.recycleBin)) {
      throw createRuntimeError(
        "Invalid snapshot structure: 'recycleBin' must be an array when present",
        'ERR_SNAPSHOT_INVALID'
      );
    }
    const recycleBinData: SerializedAgent[] = Array.isArray(snapshot.recycleBin) ? snapshot.recycleBin : [];

    // Normalize hostile lifecycle claims on every direct import path (d5b583d,
    // MOD-21 W8-B): an active entry hydrates IDLE with no busy state, while a
    // recycled/terminated claim (or any `recycledAt`) routes to the recycle bin.
    // Authority-bearing selectors are withheld here as defense in depth; the
    // entity-owned `Agent.fromSnapshot` contract also strips them.
    const activeAgentData: SerializedAgent[] = [];
    const routedRecycledData: SerializedAgent[] = [...recycleBinData];
    for (const entry of snapshot.agents) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        activeAgentData.push(entry);
        continue;
      }
      const claimsTerminalLifecycle = entry.state === 'recycled'
        || entry.state === 'terminated'
        || Boolean(entry.recycledAt);
      if (claimsTerminalLifecycle) {
        routedRecycledData.push(entry);
        continue;
      }
      const copy = { ...entry };
      delete copy.state;
      delete copy.stateDetail;
      delete copy.recycledAt;
      delete copy.recycleReason;
      if (copy.config && typeof copy.config === 'object' && !Array.isArray(copy.config)) {
        copy.config = { ...copy.config };
        delete copy.config.allowedTools;
        delete copy.config.tools;
      }
      activeAgentData.push(copy);
    }

    // Fail-closed pre-validation: hydrate every entity into local collections
    // BEFORE mutating runtime state. Any construction/config failure aborts the
    // import with ERR_SNAPSHOT_INVALID and the prior registry is left untouched.
    const hydratedActive: Agent[] = [];
    const hydratedRecycled: Agent[] = [];
    try {
      // Every record — the director included — hydrates through the entity
      // snapshot contract. No id carries reserved meaning, so there is no
      // engine-composed rebuild and no body upgrade (Wave I, ticket c02d0b9).
      for (const agentData of activeAgentData) {
        if (!agentData || !agentData.id) continue;
        hydratedActive.push(Agent.fromSnapshot(agentData, { credentialResolver: this.#credentialResolver, presetSource: this.#presetSource }));
      }
      for (const agentData of routedRecycledData) {
        if (!agentData || !agentData.id) continue;
        hydratedRecycled.push(Agent.fromSnapshot(agentData, { recycled: true, credentialResolver: this.#credentialResolver, presetSource: this.#presetSource }));
      }
    } catch (err) {
      const invalid = createRuntimeError(
        `Invalid snapshot: agent hydration failed (${describeThrownValue(err)})`,
        'ERR_SNAPSHOT_INVALID'
      );
      invalid.cause = err;
      throw invalid;
    }

    // Snapshot identity rekey (Wave I, ticket d57cbc1): each record's canonical
    // key is computed from its persisted `config.realmId`, and a duplicate
    // `(realmId, agentId)` pair anywhere in the snapshot fails the import
    // closed before any runtime state is mutated. Distinct Realms may carry
    // the same literal id (that is the contract); the same Realm twice may
    // not. All records and workspace bytes are preserved verbatim — legacy
    // bare-key workspace data remapping belongs to the VFS/store lanes.
    const activeWithKeys: Array<[string, Agent]> = [];
    const recycledWithKeys: Array<[string, Agent]> = [];
    const seenIdentityKeys = new Set<string>();
    try {
      for (const agent of hydratedActive) {
        const identityKey = this.#agentIdentityKeyOf(agent);
        if (seenIdentityKeys.has(identityKey)) {
          throw new Error(`duplicate registration for agent id '${agent.id}'`);
        }
        seenIdentityKeys.add(identityKey);
        activeWithKeys.push([identityKey, agent]);
      }
      for (const agent of hydratedRecycled) {
        const identityKey = this.#agentIdentityKeyOf(agent);
        if (seenIdentityKeys.has(identityKey)) {
          throw new Error(`duplicate registration for agent id '${agent.id}'`);
        }
        seenIdentityKeys.add(identityKey);
        recycledWithKeys.push([identityKey, agent]);
      }
    } catch (err) {
      const invalid = createRuntimeError(
        `Invalid snapshot: duplicate agent identity (${describeThrownValue(err)})`,
        'ERR_SNAPSHOT_INVALID'
      );
      invalid.cause = err;
      throw invalid;
    }

    // 1. Abort in-flight turns & operations
    this.#rejectUserTurnWaiters(
      null,
      createRuntimeError('Runtime state was replaced before the queued user turn was dispatched', 'ERR_RUNTIME_NOT_READY')
    );
    this.cancelAll('Disaster recovery snapshot hydration', { principal: this.#internalPrincipal });

    // 2. Unbind existing message subscriptions
    for (const unsub of this.#messageSubscriptions.values()) {
      try {
        unsub();
      } catch {
        // Best-effort unsubscribe; the subscription map is cleared regardless.
      }
    }
    this.#messageSubscriptions.clear();

    // 3. Clear active & recycled registries
    this.#agents.clear();
    this.#recycleBin.clear();

    try {
      // 4. Install pre-hydrated active agents via the entity-owned snapshot
      // contract. The runtime's credential resolver is forwarded to hydration
      // above so persisted agents (whose secrets are stripped from snapshots)
      // can re-resolve vault credentials. Installation keys canonically
      // (Wave I, ticket d57cbc1), so a same-id registration in another Realm
      // stays a distinct record.
      for (const [identityKey, agent] of activeWithKeys) {
        this.#telemetryTracker.initializeTelemetry({ id: identityKey, telemetryLabel: agent.id }, agent.telemetry);

        if (this.#messagingBus && typeof this.#messagingBus.registerAgent === 'function') {
          this.#messagingBus.registerAgent(identityKey);
        }
        const unsub = this.#triggerDispatcher.setupAgentMailSubscription(identityKey);
        this.#messageSubscriptions.set(identityKey, unsub);

        // Re-derive the frozen authority descriptor for the restored agent
        // default-deny: a snapshot contributes no grant (MOD-21 W5/W7).
        this.#lifecycleManager.registerHydratedAgent(agent);

        this.#agents.set(identityKey, agent);
      }

      // 5. Install pre-hydrated recycled agents via the entity-owned snapshot contract
      for (const [identityKey, agent] of recycledWithKeys) {
        this.#telemetryTracker.initializeTelemetry({ id: identityKey, telemetryLabel: agent.id }, agent.telemetry);

        if (this.#messagingBus && typeof this.#messagingBus.markAgentTerminated === 'function') {
          this.#messagingBus.markAgentTerminated(identityKey);
        }

        // Bind the owner-controlled authority channel before exposure (MOD-21
        // W10, 5b585b7) so a later gated operator grant can reach the hydrated
        // record; first bind wins, so a public caller cannot claim it.
        this.#lifecycleManager.bindAgentAuthorityChannel(agent);

        this.#recycleBin.set(identityKey, agent);
      }

      // 6. Hydrate scheduled timers
      if (Array.isArray(snapshot.scheduledTimers)) {
        this.importSchedules(snapshot.scheduledTimers);
      }
    } catch (err) {
      const invalid = createRuntimeError(
        `Invalid snapshot: state installation failed (${describeThrownValue(err)})`,
        'ERR_SNAPSHOT_INVALID'
      );
      invalid.cause = err;
      throw invalid;
    }

    // 7. Re-bind early-cancellation bus listener after hydration
    this.#bindBusTimerListener();

    // 8. Update status to READY
    this.#status = RUNTIME_STATUS.READY;

    // 9. Emit state restored event
    this.#emit({
      type: 'state_restored',
      timestamp: Date.now(),
      payload: { snapshot }
    });
  }
}

// ============================================================================
// 5.8 Canonical Factory Function
// ============================================================================

/**
 * Canonical factory function that creates and initializes a new `AgentRuntime` instance
 * with validated defaults and dependency injection.
 *
 * @param options - Optional initialization options and shared primitive instances.
 * @returns Fully constructed and initialized AgentRuntime instance.
 *
 * @example
 * ```typescript
 * import { createAgentRuntime } from './runtime/index.ts';
 *
 * const runtime = createAgentRuntime({
 *   autoBootstrapDirector: true,
 *   mailboxAutonomy: true
 * });
 * console.log(`Runtime ready: ${runtime.status}`);
 * ```
 */
export function createAgentRuntime(options: AgentRuntimeOptions = {}): AgentRuntime {
  return new AgentRuntime(options);
}
