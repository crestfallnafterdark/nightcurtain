/**
 * @packageDocumentation
 * Agent Domain Entity, Language Model Dependency Injection & Core Lifecycle Types.
 *
 * Agent Domain Entity & Language Model Dependency Injection (Layer 2).
 *
 * Core Guarantees:
 * 1. Pure AgentModelConfig Composition: Inherits global defaults, holding zero raw secrets.
 * 2. Non-null ModelInterface & ProviderInterface bindings.
 * 3. Formal state encapsulation.
 *
 * @module runtime/agent
 * @mayImport ../../inference/index.ts
 * @mayImport type-only ../../inference/ProviderInterface/index.ts
 * @mayImport ../../modelConfig/index.ts
 * @mayImport type-only ../../credentialVault/index.ts
 * @mayImport type-only ../../presetCatalog/index.ts
 * @mayImport type-only ../index.ts
 * @invariant `Agent` holds no raw secret material: `modelConfig` carries `keyId` references only, and credentials resolve inside provider construction through the injected `CredentialResolverPort`.
 * @invariant `credentialResolver` is nullable and defaults to `null`; when null, `createProvider` receives no resolver and resolves no credentials — there is no singleton or ambient vault fallback.
 * @invariant `provider` and `model` are always bound after construction, `rebindModel()`, and `updateModel()`; an injected model without a resolvable provider is rejected with `PROVIDER_INIT_FAILED`.
 * @invariant `AGENT_STATES` is the frozen nine-state enumeration backing the `AgentState` union; `Agent.state` is a plain mutable field defaulting to `idle`, and transition validity is enforced by the lifecycle manager (`agentLifecycle`), not by the entity.
 * @invariant Realm-local identity key: `createAgentIdentityKey(realmId, agentId)` is the single owner of the composite `(realmId, agentId)` registration key (`realm:<realmId>:<agentId>` for Realm-bound registrations, `system:<agentId>` for the bootstrap-only null system scope; segments percent-encoded). The runtime and lifecycle registries, authority descriptors/inputs, telemetry, and message subscriptions key canonically through it, so the same literal `agentId` registers independently per Realm; the string is internal-only and never appears on an agent-facing surface.
 * @invariant `toSnapshot()` returns a plain JSON-serializable snapshot with `config`, `telemetry`, `history`, `redoStack`, `pendingPrecalls`, `lastInterruptedTurn`, and `lastError` deep-copied, so serialization never shares mutable references with the entity; `redoStack` entries are self-contained `TurnBundle`s (dual-stack undo/redo, INV-6).
 * @invariant `toSnapshot()` drops caller-asserted authority fields (`privileged`, `isPrivileged`, `isAdmin`) from the copied config: authority is derived state and is never persisted.
 * @invariant `fromSnapshot()` hydrates a fresh entity through the constructor path — snapshot consumers never write internal fields — and a recycled snapshot or `deps.recycled: true` hydrates in `recycled` state.
 * @invariant `fromSnapshot()` never honors snapshot authority: boolean `true` privilege claims are downgraded to anonymous and recorded on `authorityDowngrade`; non-boolean claims reject the snapshot with `INVALID_CONFIG` (fail closed); the authority descriptor is re-derived default-deny from runtime policy, and the persisted capability selectors (`allowedTools`/`tools`) and parentage fields (`spawnedBy`/`creatorId`) are withheld from the hydrated config so neither a legacy tool gate nor a lifecycle parent check can re-grant from snapshot data. The values remain serialized data only until a trusted operator grant/repair lands. A snapshot config carrying an own prototype-polluting key (`__proto__`/`constructor`/`prototype`, recursively) rejects with `INVALID_CONFIG` — the direct `importSnapshot` facade surfaces `ERR_SNAPSHOT_INVALID` and leaves the prior registry intact.
 * @invariant The live config is built pollution-safely on every adoption path (constructor, `config` setter, `updateConfig` merge, authority apply): entries are installed as own data properties and prototype-mutating key names are dropped, so a config's own `__proto__` data key can never become its `[[Prototype]]`.
 * @invariant `Agent.authority` is a frozen `AuthorityDescriptor` built once at construction from trusted config: it carries no `privileged` boolean, its non-writable property cannot be reassigned, and its `allow` set is a frozen read-only snapshot-closure facade — every read (`has`, `size`, `values`, `keys`, `entries`, iteration, `forEach`) is an own indexed closure over a private member-name array instead of a `Set` internal slot (`Array.prototype` methods are likewise never delegated to), `add`/`delete`/`clear` are neutralized, `Set.prototype` is retained only so `instanceof Set` holds, and the `Set` prototype-call vector (`Set.prototype.add.call(allow, …)`) throws because the facade has no `[[SetData]]` slot, so authority can never widen live.
 * @invariant Authority-bearing config fields (`privileged`, `allowedTools`/`tools`, `role`, `spawnedBy`/`creatorId`, `realmId`) are owner-controlled read-only projections backed by private entity state: direct assignment, `Object.assign`, `defineProperty`, deletion, and whole-object config replacement cannot change them; the live config object is non-extensible, and a snapshot-hydrated config never grows a withheld field. Only `AgentLifecycleManager` may change authority state, through the opaque reference-identity `authorityChannel` injected at construction and consumed by {@link Agent.applyAuthorityConfig}.
 * @invariant Preset binding (MOD-20): when a `ModelPresetSourcePort` is supplied, the constructor binds the effective `modelConfig` from the catalog preset alone — binding-only, so `config.modelConfig` and `config.settings.modelConfig` never form an override layer — with `keyId` set to the provider's active credential id (fallback `canonical_<providerId>`); a missing or unknown `presetId` binds `getDefaultPresetId()`, and only a source-less construction keeps the legacy settings-default plus explicit-overlay blend.
 * @invariant Preset snapshot self-heal (MOD-20): `fromSnapshot` keeps a `presetId` that resolves through the supplied source, re-points a missing, non-string, or stale id at `getDefaultPresetId()`, and adopts the persisted config unchanged when no source is supplied; healing is in-memory only and never rewrites persisted state.
 * @invariant Turn-start-only materialization (MOD-20): a bound agent's cached `modelConfig` is non-authoritative — the `updateConfig` modelConfig branch records the request into the cache and marks the binding dirty without re-instantiating provider/model; `markPresetDirty()` does the same for `preset-updated`; and `materializeEffectiveModel()` alone composes the effective config and regenerates provider/model. A dirty mark forces re-resolution of the effective config/binding, but provider/model re-initialize only when that re-resolution actually differs key-wise (`keyId` included) or the binding id healed; a dirty mark whose re-resolved config and binding are byte-identical is consumed (cleared) without provider churn, so a no-op `preset-updated` save never regenerates. It is never called mid-turn: the turn engine invokes it exactly once per turn before its inference loop.
 * @invariant Binding rewrite (MOD-20): `rebindToDefaultPreset()` re-points a bound agent's `presetId` at `getDefaultPresetId()` and marks it dirty without rebuilding provider/model; the runtime persists the rewrite through the lifecycle config-update path.
 * @decision Authority is never persisted: snapshots drop trust fields and restore re-derives the descriptor from trusted construction only
 * @decision Preset binding is binding-only and additive: a resolved preset replaces the override layer at construction while unbound agents retain the legacy resolution path, and the effective config materializes the provider-active credential reference at construction time
 * @decision Turn-start-only materialization: for a bound agent the `updateConfig` modelConfig branch is a non-authoritative cache write plus dirty mark with no mid-turn provider swap, `preset-updated` only marks the binding dirty, and the effective config plus provider/model regenerate solely in `materializeEffectiveModel()` (once per turn, before the engine loop); dirty means re-resolve — provider/model regenerate only when the resolved config (compared key-wise including `keyId`) or the binding id actually changed, and an unchanged dirty mark is consumed without provider churn; binding-only, so per-agent `modelConfig` edits never form an override layer
 * @decision Caller-supplied options/config objects are snapshotted exactly once before authorize + apply, so a stateful Proxy cannot answer the authority gate differently from the application phase
 * @decision `AgentModelConfig`'s single home is the inference contract (`inference/ProviderInterface.js`); this module imports and re-exports it type-only
 * @decision `Agent.toSnapshot()` / `Agent.fromSnapshot()` are the entity-owned agent snapshot contract consumed by serialize/restore and `importSnapshot`; consumers do not duplicate agent-shape knowledge
 * @decision `spawnedBy` / `creatorId` are `string | null`: a null creator is a creator-less trusted system/root caller, and the lifecycle manager normalizes absent values to `null` for constructed entities — never `undefined`; snapshot hydration withholds both fields entirely
 * @decision `realmId` is `string | null` Realm membership (`null` is the bootstrap-only system scope composed by the engine director launch): realm membership is immutable after launch — `updateAgentConfig` refuses any `realmId` write (`null` included, same-value writes included) for EVERY caller before the authority verdict, the injected internal principal included — so changing realms means terminate + relaunch into the target realm, and, unlike capability selectors and parentage, it is deliberately **retained** by snapshot hydration because membership is a constraint, not a grant (nothing is authorized by it) and persisted membership must survive a restart. Launch composition is `config.realmId ?? resolvedCreator.config.realmId ?? realm_generic`, inherits the RESOLVED creator's realm, and never reads caller-asserted parentage/realm fields
 * @decision `getGlobalModelConfig` reads only explicit settings supplied by the caller: with no explicit `modelConfig` it falls back to the model-catalog master default (`modelConfig/index.ts`, `getDefaultModelConfig()`); the sandbox never reads host globals such as `window.gameState`
 */

import { createProvider } from '../../inference/index.ts';
import { getDefaultModelConfig } from '../../modelConfig/index.ts';

import type { AgentModelConfig, ProviderInterface, ModelInterface } from '../../inference/ProviderInterface/index.ts';
import type { CredentialResolverPort } from '../../credentialVault/index.ts';
import type { ModelPresetSourcePort } from '../../presetCatalog/index.ts';
import type { AuthorityDescriptor } from '../index.ts';

// ============================================================================
// 0. Realm-Local Identity Key (Wave I, ticket d57cbc1)
// ============================================================================

/**
 * Namespace prefix of the engine-reserved system scope (the bootstrap-only
 * `realmId: null` membership). The system scope keys live in their own
 * internal namespace, parallel to — and never colliding with — any Realm.
 * @internal
 */
const SYSTEM_IDENTITY_KEY_PREFIX = 'system:';

/**
 * Builds the canonical internal identity key of an agent registration
 * `(realmId, agentId)` (Wave I, ticket d57cbc1).
 *
 * Realm-local agent identity is the composite `(realmId, agentId)`: the
 * literal `agentId` is realm-local and opaque, and the same literal id may be
 * registered independently in two Realms. Every runtime registry (active
 * agents, recycle bin, authority descriptors/inputs, telemetry, message
 * subscriptions) keys on this canonical string so two Realms never share an
 * entry; the system scope (`realmId: null`) gets its own namespace.
 *
 * The string representation is **internal only**: no agent-facing surface
 * (tool parameters, receipts, errors, listings, prompts) may carry it. The
 * format is `realm:<realmId>:<agentId>` for Realm-bound registrations and
 * `system:<agentId>` for the system scope; both segments are percent-encoded
 * so no `:`-bearing realm/agent id can make two distinct pairs collide, and
 * the encoding never rewrites the ids of ordinary identifiers.
 *
 * @param realmId - Realm membership (`null`/absent = the system scope).
 * @param agentId - Realm-local agent identifier.
 * @returns The canonical internal identity key.
 *
 * @example
 * ```typescript
 * import { createAgentIdentityKey } from './agent/index.ts';
 *
 * createAgentIdentityKey('alpha', 'scout'); // 'realm:alpha:scout'
 * createAgentIdentityKey(null, 'director'); // 'system:director'
 * ```
 */
export function createAgentIdentityKey(realmId: string | null | undefined, agentId: string): string {
  const normalizedAgentId = typeof agentId === 'string' ? agentId : '';
  const normalizedRealmId = typeof realmId === 'string' && realmId ? realmId : null;
  if (normalizedRealmId === null) {
    return `${SYSTEM_IDENTITY_KEY_PREFIX}${encodeURIComponent(normalizedAgentId)}`;
  }
  return `realm:${encodeURIComponent(normalizedRealmId)}:${encodeURIComponent(normalizedAgentId)}`;
}

/**
 * Parses a canonical identity key back into its `(realmId, agentId)` pair
 * (Wave I, ticket d57cbc1). Symmetric with {@link createAgentIdentityKey};
 * returns `null` for any string that is not a well-formed key.
 *
 * Internal engine surface only: consumers use it to rebuild a scoped identity
 * from keyed substrate state (for example snapshot remapping); the pair is
 * never projected onto an agent-facing surface.
 *
 * @param key - Candidate canonical identity key.
 * @returns The decoded pair, or `null` when the key is malformed.
 *
 * @example
 * ```typescript
 * import { parseAgentIdentityKey } from './agent/index.ts';
 *
 * parseAgentIdentityKey('realm:alpha:scout'); // { realmId: 'alpha', agentId: 'scout' }
 * ```
 */
export function parseAgentIdentityKey(key: string): { realmId: string | null; agentId: string } | null {
  if (typeof key !== 'string' || key === '') return null;
  try {
    if (key.startsWith(SYSTEM_IDENTITY_KEY_PREFIX)) {
      const agentId = decodeURIComponent(key.slice(SYSTEM_IDENTITY_KEY_PREFIX.length));
      return { realmId: null, agentId };
    }
    if (!key.startsWith('realm:')) return null;
    const rest = key.slice('realm:'.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) return null;
    const realmId = decodeURIComponent(rest.slice(0, separator));
    const agentId = decodeURIComponent(rest.slice(separator + 1));
    if (!realmId) return null;
    return { realmId, agentId };
  } catch {
    return null;
  }
}

// ============================================================================
// 1. Canonical State Enums & Types
// ============================================================================

/**
 * Formal 9-State Lifecycle Machine Enum.
 *
 * Canonical enumeration of valid states for autonomous agents:
 * - `IDLE`: Resting state, ready to accept new conversational turns or trigger activations.
 * - `RUNNING`: Actively generating model completions or executing tool calls.
 * - `WAITING_FOR_INPUT`: Paused awaiting external human feedback or interactive user input.
 * - `WAITING_FOR_DEPENDENTS`: Blocked waiting on child subagent invocation completion.
 * - `WAITING_FOR_MESSAGE`: Blocked awaiting reactive mail delivery from the MessagingBus.
 * - `CANCELING`: Abort signal emitted, unwinding tool executions and stream buffers.
 * - `ERRORED`: Turn execution halted due to unhandled exceptions or inference failure.
 * - `TERMINATED`: Hard-killed or permanently purged from active runtime execution.
 * - `RECYCLED`: Soft-killed and moved to the recycle bin; workspace evicted and mail unsubscribed.
 *
 * @example
 * ```typescript
 * import { AGENT_STATES } from './agent/index.ts';
 *
 * if (agent.state === AGENT_STATES.IDLE) {
 *   console.log(`Agent ${agent.id} is ready for execution.`);
 * }
 * ```
 */
export const AGENT_STATES: {
  readonly IDLE: 'idle';
  readonly RUNNING: 'running';
  readonly WAITING_FOR_INPUT: 'waiting_for_input';
  readonly WAITING_FOR_DEPENDENTS: 'waiting_for_dependents';
  readonly WAITING_FOR_MESSAGE: 'waiting_for_message';
  readonly CANCELING: 'canceling';
  readonly ERRORED: 'errored';
  readonly TERMINATED: 'terminated';
  readonly RECYCLED: 'recycled';
} = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING_FOR_INPUT: 'waiting_for_input',
  WAITING_FOR_DEPENDENTS: 'waiting_for_dependents',
  WAITING_FOR_MESSAGE: 'waiting_for_message',
  CANCELING: 'canceling',
  ERRORED: 'errored',
  TERMINATED: 'terminated',
  RECYCLED: 'recycled'
});

/**
 * Valid state string union derived from {@link AGENT_STATES}.
 */
export type AgentState = typeof AGENT_STATES[keyof typeof AGENT_STATES];

/**
 * Legacy trigger-policy label stored on agent config and echoed by descriptors.
 *
 * Trigger policy is inert metadata since the AC-ALL-AUTO abolition: every agent
 * reacts automatically to incoming mail and schedule ticks, and no execution
 * path gates, queues, or defers a turn on this value. `launchAgent` stores the
 * supplied label verbatim (defaulting to `'auto'`) and `whoami` /
 * `listAgentDescriptors` / the `[IDENTITY]` preamble echo it back. Historical
 * labels include `'auto'`, `'manual'`, `'semi-auto'`, and `'queued'`; the
 * runtime accepts any string.
 *
 * @example
 * ```typescript
 * const policy: TriggerPolicy = 'auto';
 * ```
 */
export type TriggerPolicy = 'auto' | 'manual' | 'semi-auto' | 'queued' | (string & {});

/**
 * Canonical error codes raised by the lifecycle and history subsystems.
 *
 * - `INVALID_CONFIG`: Missing required configuration fields (e.g. empty or invalid `id`).
 * - `AGENT_NOT_FOUND`: Target agent ID does not exist in active registry or recycle bin.
 * - `AGENT_ALREADY_EXISTS`: An agent with the specified ID is already registered and active.
 * - `INVALID_STATE_TRANSITION`: State change violates the formal FSM transition matrix.
 * - `PERMISSION_DENIED`: Caller lacks sudoer authority or violates privilege invariants (SEC-1, SEC-2).
 * - `MESSAGE_NOT_FOUND`: Target message index or UUID was not found in conversational history.
 * - `INDEX_OUT_OF_BOUNDS`: History index exceeds valid range bounds.
 * - `EMPTY_REDO_STACK`: Attempted redo operation when agent `redoStack` is empty.
 * - `PROVIDER_INIT_FAILED`: Failed to instantiate ProviderInterface or ModelInterface.
 * - `INVALID_ARGUMENTS`: Supplied argument is well-formed but semantically rejected (e.g. unknown `toolPreset`).
 * - `NOT_FOUND`: Lookup miss raised by `killAgent` for an agent absent from both the active registry and recycle bin.
 */
export type RuntimeLifecycleErrorCode =
  | 'INVALID_CONFIG'
  | 'AGENT_NOT_FOUND'
  | 'AGENT_ALREADY_EXISTS'
  | 'INVALID_STATE_TRANSITION'
  | 'PERMISSION_DENIED'
  | 'MESSAGE_NOT_FOUND'
  | 'INDEX_OUT_OF_BOUNDS'
  | 'EMPTY_REDO_STACK'
  | 'PROVIDER_INIT_FAILED'
  | 'INVALID_ARGUMENTS'
  | 'NOT_FOUND';

// ============================================================================
// 2. Configuration & Model Specifications
// ============================================================================

export type { AgentModelConfig } from '../../inference/ProviderInterface/index.ts';

/**
 * Agent Entity Configuration Declaration.
 *
 * Input specification used to launch or update an agent. The runtime also
 * accepts a set of legacy aliases (snake_case and short-name selectors); the
 * canonical member wins whenever both spellings are supplied — except
 * `initialPrompt`, where the snake_case `initial_prompt` alias is consulted
 * first (see `initial_prompt` below).
 *
 * @example
 * ```typescript
 * const config: AgentConfig = {
 *   id: 'coder',
 *   name: 'Software Architect',
 *   role: 'developer',
 *   systemPrompt: 'You are an expert TypeScript engineer.',
 *   temperature: 0.2,
 *   allowedTools: ['read_file', 'write_to_file', 'run_command'],
 *   modelConfig: {
 *     providerId: 'openai',
 *     modelId: 'gpt-4o'
 *   }
 * };
 * ```
 */
export interface AgentConfig {
  /** Unique, non-empty identifier for the agent (immutable identity) */
  readonly id: string;
  /** Human-readable display name */
  name?: string;
  /** Role description or archetype (e.g., 'developer', 'director', 'admin') */
  role?: string;
  /** Base system prompt defining agent character directives */
  systemPrompt?: string;
  /** Snake_case alias for `systemPrompt`; consulted only when `systemPrompt` is absent */
  system_prompt?: string;
  /** Default sampling temperature override */
  temperature?: number;
  /** Maximum turns permitted per conversation lifecycle */
  maxTurns?: number;
  /**
   * Legacy trigger-policy label stored verbatim for display/echo only
   * (defaults to `'auto'`). It has zero effect on execution: no activation
   * path gates, queues, or defers turns on this value (AC-ALL-AUTO).
   */
  triggerPolicy?: TriggerPolicy;
  /**
   * Whether the agent has elevated/sudo privileges (SEC-1, SEC-2).
   *
   * Trusted construction input: `launchAgent`/`updateAgentConfig` reject
   * `true` unless the caller resolves to lifecycle authority, and the frozen
   * `AuthorityDescriptor` derives its wildcard grant from this field. Snapshots
   * never restore it: `toSnapshot()` drops the field from serialized config and
   * `fromSnapshot()` ignores it (boolean `true` claims downgrade, non-boolean
   * claims reject), so authority is always re-derived from trusted
   * construction, never from a snapshot (MOD-21 W5/W8).
   */
  privileged?: boolean;
  /** Private VirtualFS workspace tenant identifier (defaults to agent `id`) */
  workspaceId?: string;
  /** Alias for `workspaceId`; consulted only when `workspaceId` is absent */
  workspace?: string;
  /** Whitelist of permitted tool names or wildcard `'*'` */
  allowedTools?: string[] | '*';
  /** Alias for `allowedTools` */
  tools?: string[] | '*';
  /**
   * Tool preset selector consulted when neither `allowedTools` nor `tools` is
   * supplied; resolved by `resolveToolPreset` and validated at launch (an
   * unknown preset throws `INVALID_ARGUMENTS`). Known presets: `'all'`,
   * `'manager'`, `'collaborator'`, `'readonly_collaborator'`, `'readonly'`;
   * `'*'` grants every tool.
   */
  toolPreset?: 'all' | 'manager' | 'collaborator' | 'readonly_collaborator' | 'readonly' | '*';
  /** Snake_case alias for `toolPreset`; consulted only when `toolPreset` is absent */
  tool_preset?: 'all' | 'manager' | 'collaborator' | 'readonly_collaborator' | 'readonly' | '*';
  /**
   * Legacy mailbox-autonomy flag. It does not gate mailbox processing (all
   * agents auto-react); the turn execution engine only consults it when
   * deciding whether to inject the `[IDENTITY]` preamble.
   */
  mailboxAutonomy?: boolean | null;
  /**
   * Controls the `[IDENTITY]` preamble injected into the first model message
   * by the turn execution engine. `true` forces the preamble, `false`
   * suppresses it, and when absent the engine enables it heuristically
   * (mailbox autonomy, autonomy tools, or a non-`user`/non-`admin` role).
   */
  identityHeader?: boolean;
  /**
   * Host-registered custom tool handler registry keyed by tool name (a direct
   * handler function or a `{ handler }` wrapper).
   *
   * Host-only contract (A0-5, ticket 0443865): custom tools are
   * operator/host-registered, never model-registered — provider function/JSON
   * input cannot add entries (the spawn sanitizer renames agent-supplied
   * `custom_tools` to an inert alias that launch composition never reads), and
   * Realms never register custom tools; the registry is operator-global.
   * Handlers receive raw substrate handles and execute before the dispatcher
   * capability gate, so the turn execution engine authorizes every invocation
   * against the caller's frozen `AuthorityDescriptor` (wildcard `'*'` or
   * `'@lifecycle:authority'`, or an engine-internal principal); an
   * `allowedTools` entry that merely matches the handler name does not
   * authorize execution, and anonymous callers are denied.
   */
  customTools?: Record<string, unknown> | null;
  /**
   * Custom tool JSON-schema definitions exposed to the model alongside
   * {@link AgentConfig.customTools} for this agent.
   *
   * Host-only contract (A0-5, ticket 0443865): definitions are
   * operator/host-registered and never model-supplied. The turn execution
   * engine exposes them only to callers whose frozen `AuthorityDescriptor`
   * grants custom execution; ungranted and anonymous callers receive no custom
   * schemas.
   */
  customToolSchemas?: Record<string, unknown> | null;
  /**
   * Realm membership: the id of the Realm this agent belongs to, or `null`
   * when ungrouped.
   *
   * Realm membership is an authority-bearing config field (Realm wave A,
   * ticket f5d1ccc) that is **immutable after launch** (Realm wave R, ticket
   * 56ba4b9): `updateAgentConfig` refuses any realm change (`null` ungrouping
   * included) with `PERMISSION_DENIED` for EVERY caller — the exact injected
   * internal principal and the hardcoded system director identity included;
   * agent authority, the wildcard `'*'` included, never moves an agent between
   * Realms (no self-move, no self-ungroup, no peer move, no operator move).
   * Changing realms means terminate + relaunch into the target realm. At
   * launch, an explicit value is honored only for a lifecycle-authority or
   * principal-less host/operator caller; every other launch ignores
   * caller-supplied `realmId` and inherits the RESOLVED creator's realm.
   * Non-director launches resolve to a Realm (the Generic default when no
   * explicit or inherited membership exists); `null` is reserved for the
   * director/system bootstrap.
   *
   * Unlike capability selectors and parentage, membership is deliberately
   * persisted and hydrated: it is a constraint (scope), not a grant, and
   * `toSnapshot()`/`fromSnapshot()` round-trip it unchanged. Absent/`undefined`
   * and non-string values normalize to `null`.
   */
  realmId?: string | null;
  /**
   * ID of parent agent that spawned this agent.
   *
   * `null` (or absent/`undefined`, which the lifecycle manager normalizes to
   * `null`) means creator-less: the agent was launched directly by the runtime
   * or system, not by another agent (e.g. the root Director bootstrap). A
   * `null` creator is treated as a trusted system/root caller by permission
   * checks; it is never persisted as `undefined`.
   */
  spawnedBy?: string | null;
  /**
   * Alias for `spawnedBy`. When omitted, the lifecycle manager falls back to
   * `spawnedBy`; both are `null` only when no creator was supplied either way.
   */
  creatorId?: string | null;
  /**
   * Legacy caller reference inspected only as an untrusted snapshot claim:
   * `Agent.fromSnapshot` walks `callerAgent` and `callerAgent.config` for
   * caller-asserted authority fields (`privileged`/`isPrivileged`/`isAdmin`),
   * records valid `true` claims as an `authorityDowngrade`, and rejects
   * non-boolean claims with `INVALID_CONFIG`.
   *
   * It never supplies `spawnedBy`/`creatorId` parentage and never contributes
   * privilege inheritance: launch parentage comes only from
   * `spawnedBy`/`creatorId`, and authority only from the trusted registry
   * descriptor (`agentLifecycle/index.ts`).
   *
   * @deprecated Retained solely as the snapshot claim-inspection site; no
   * removal scheduled (the field is already ignored for parentage and
   * inheritance).
   */
  callerAgent?: { id?: string; config?: { privileged?: boolean } | null } | null;
  /** Additional custom runtime settings */
  settings?: Record<string, unknown> | null;
  /** Partial model configuration override */
  modelConfig?: Partial<AgentModelConfig>;
  /**
   * Bound catalog preset id (MOD-20 live preset binding).
   *
   * When a `ModelPresetSourcePort` is injected, the entity binds an effective
   * `presetId` at construction — the supplied id when it resolves, else the
   * source's `getDefaultPresetId()` — materializes its effective `modelConfig`
   * from that catalog preset, and ignores `modelConfig`/`settings.modelConfig`
   * as an override layer (binding-only, OPEN-1). The id is carried by
   * `toSnapshot()`; `fromSnapshot()` heals a missing or stale id to the
   * source's default in memory. Without a source, `presetId` is inert metadata
   * and the legacy settings-default plus explicit-overlay resolution applies.
   */
  presetId?: string;
  /**
   * Initial prompt read from a config object by `launchAgent`; ignored when an
   * explicit positional or options-object prompt is supplied.
   */
  initialPrompt?: string | null;
  /** Snake_case alias for `initialPrompt`; consulted first, so it wins when both spellings are supplied (`agentLifecycle/index.ts:249-250`) */
  initial_prompt?: string | null;
  /**
   * Security context read from a config object by `launchAgent`; ignored when
   * an explicit `callerContext` argument is supplied. Identity-only
   * compatibility channel: only `callerAgentId` is consumed (authority is then
   * resolved through the registry descriptor of that id); its privilege and
   * role flags are never consulted. `Agent.fromSnapshot` also inspects it for
   * caller-asserted authority claims when validating a snapshot.
   * @deprecated Retained for wire compatibility; no removal scheduled.
   */
  callerContext?: AgentSecurityContext | null;
}

/**
 * Security context for permission gating and privilege verification (SEC-1, SEC-2).
 *
 * @example
 * ```typescript
 * const securityContext: AgentSecurityContext = {
 *   callerAgentId: 'director',
 *   callerRole: 'admin',
 *   isPrivileged: true,
 *   isAdmin: true
 * };
 * ```
 */
export interface AgentSecurityContext {
  /** Identifier of the invoking agent */
  readonly callerAgentId?: string;
  /** Alias for `callerAgentId`; when both are supplied, `callerAgentId` wins */
  readonly agentId?: string;
  /**
   * Role string of the invoking agent.
   * @deprecated Metadata only; roles never grant authority — authority is the
   * frozen registry `AuthorityDescriptor` resolved from `callerAgentId`.
   */
  readonly callerRole?: string;
  /**
   * Whether the invoking agent holds privileged permissions.
   * @deprecated Caller-asserted privilege is never consulted; authority comes
   * only from the frozen registry `AuthorityDescriptor` resolved for
   * `callerAgentId`.
   */
  readonly isPrivileged?: boolean;
  /**
   * Alias for `isPrivileged`; `true` asserts caller sudo authority.
   * @deprecated Caller-asserted privilege is never consulted; authority comes
   * only from the frozen registry `AuthorityDescriptor`.
   */
  readonly privileged?: boolean;
  /**
   * Whether the invoking agent holds administrator status.
   * @deprecated Caller-asserted privilege is never consulted; authority comes
   * only from the frozen registry `AuthorityDescriptor`.
   */
  readonly isAdmin?: boolean;
}

/**
 * Owner-controlled authority-bearing config patch accepted by
 * {@link Agent.applyAuthorityConfig} (MOD-21 W10). Only the lifecycle manager
 * holds the opaque channel reference this method requires; the entity channel
 * (`Agent.updateConfig`) denies the same fields outright. Absent keys are not
 * applied; `null` parentage clears the relation.
 */
export interface AgentAuthorityPatch {
  /** Sudo/wildcard capability flag; `true` grants the wildcard descriptor */
  privileged?: boolean;
  /** Capability selector in any accepted alias form (`'*'` or a name list) */
  allowedTools?: string[] | '*' | null;
  /** Alias for `allowedTools` */
  tools?: string[] | '*' | null;
  /** Role description or archetype (e.g. `'admin'`, `'director'`, `'writer'`) */
  role?: string;
  /** Registry/entity parentage creator id; `null` clears it */
  spawnedBy?: string | null;
  /** Registry/entity parentage creator id; `null` clears it */
  creatorId?: string | null;
  /** Realm membership; a non-empty realm id binds the agent, `null` ungroups it */
  realmId?: string | null;
}

/**
 * One trusted baked-history entry accepted by {@link LaunchAgentOptions.history}
 * (Realm Template Format v1 §3.5; Wave T, ticket 7e6edae).
 *
 * A declared entry is prologue content carried by a realm template: it is
 * seeded into the launched agent's history **before the first turn** and never
 * runs a model call. Message ids are generated at launch through
 * `generateMessageId` (INV-7) — callers never supply ids.
 *
 * @example
 * ```typescript
 * const opener: LaunchHistoryEntry = {
 *   role: 'assistant',
 *   content: 'The gate groans open. You are already inside.',
 *   source: 'template'
 * };
 * ```
 */
export interface LaunchHistoryEntry {
  /** Message author role: `'user'` (operator-attributed) or `'assistant'` (the agent itself) */
  readonly role: 'user' | 'assistant';
  /** Non-empty message text */
  readonly content: string;
  /**
   * Provenance tag for the entry. `'template'` marks a baked template
   * prologue; when declared, the seeded message carries
   * `metadata: { source: 'template' }`.
   */
  readonly source?: 'template';
}

/**
 * Preferred unified parameter object for launching or spawning an agent.
 * `AgentLifecycleManager.launchAgent` also still accepts the legacy positional
 * forms `(config, model?, provider?, initialPrompt?)` and
 * `(config, initialPrompt?)`; this object is the preferred spelling, not an
 * exclusive one.
 *
 * @example
 * ```typescript
 * const launchOptions: LaunchAgentOptions = {
 *   config: {
 *     id: 'story-editor',
 *     name: 'Story Editor',
 *     role: 'writer',
 *     systemPrompt: 'You refine narrative prose and dialogue.'
 *   },
 *   initialPrompt: 'Review the opening scene of chapter 1.',
 *   history: [
 *     { role: 'assistant', content: 'The manuscript lands on your desk.', source: 'template' }
 *   ],
 *   callerContext: {
 *     callerAgentId: 'director',
 *     isPrivileged: true
 *   }
 * };
 * ```
 */
export interface LaunchAgentOptions {
  /** Complete agent configuration */
  readonly config: AgentConfig;
  /** Optional pre-instantiated concrete ModelInterface instance */
  readonly model?: ModelInterface | null;
  /** Optional pre-instantiated concrete ProviderInterface instance */
  readonly provider?: ProviderInterface | null;
  /** Optional initial prompt to trigger immediate turn execution upon launch */
  readonly initialPrompt?: string | null;
  /**
   * Trusted baked prologue seeded at launch, composed as
   * `[system message (when a system prompt exists), ...declared entries]` in
   * declared order with launch-generated message ids (INV-7) and **no model
   * call**. Entries are validated fail-closed (roles `user`/`assistant` only,
   * non-empty string content, unknown fields rejected) and are only read from
   * the unified options object — legacy positional launches never carry them.
   */
  readonly history?: readonly LaunchHistoryEntry[];
  /**
   * Security context of the invoking agent. The authority-bearing fields on it
   * are the deprecated compatibility channel; the caller principal resolved
   * from the frozen `AuthorityDescriptor` replaces them.
   */
  readonly callerContext?: AgentSecurityContext | null;
}

// ============================================================================
// 3. Conversational History & Turn Bundle Interfaces
// ============================================================================

/**
 * Structured tool call representation in conversational history conforming to LLM standards.
 *
 * @example
 * ```typescript
 * const toolCall: HistoryToolCall = {
 *   id: 'call_read_01',
 *   type: 'function',
 *   function: {
 *     name: 'read_file',
 *     arguments: '{"path": "package.json"}'
 *   }
 * };
 * ```
 */
export interface HistoryToolCall {
  /** Unique tool call identifier generated by the LLM inference engine */
  id: string;
  /** Tool call type (always 'function') */
  type: 'function';
  /** Function name and JSON stringified argument payload */
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Structured conversational message conforming to OpenAI/Anthropic chat completion standards.
 *
 * @example
 * ```typescript
 * const message: HistoryMessage = {
 *   id: 'msg_01928374-65ab-7cde-8f01-23456789abcd',
 *   role: 'assistant',
 *   content: 'I will inspect the workspace files now.',
 *   tool_calls: [
 *     {
 *       id: 'call_list_01',
 *       type: 'function',
 *       function: { name: 'list_dir', arguments: '{"DirectoryPath": "/workspace"}' }
 *     }
 *   ],
 *   reasoning_content: 'User asked for workspace files; listing root directory.',
 *   createdAt: 1773700000000,
 *   updatedAt: 1773700000000
 * };
 * ```
 */
export interface HistoryMessage {
  /** Deterministic string identifier (`msg_<uuid>`, `sys_<uuid>`, `turn_<uuid>`) */
  id: string;
  /** Message author role */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Text content of the message */
  content: string;
  /** Optional author or function name */
  name?: string;
  /** Tool call identifier linking this tool response to the assistant tool call */
  tool_call_id?: string;
  /** Tool invocations emitted by the assistant */
  tool_calls?: HistoryToolCall[];
  /** Internal chain-of-thought or reasoning text extracted from thinking models */
  reasoning_content?: string;
  /** Epoch millisecond creation timestamp */
  createdAt?: number;
  /** Epoch millisecond update timestamp */
  updatedAt?: number;
  /** Arbitrary metadata tags (e.g. terminal summary flags, UI badges) */
  metadata?: Record<string, unknown>;
}

/**
 * Updatable fields for an existing history message via {@link HistoryManager.updateHistoryMessage}.
 *
 * @example
 * ```typescript
 * const updates: MessageUpdateFields = {
 *   content: 'Updated prompt instructions.',
 *   reasoning_content: 'Refined reasoning steps.',
 *   metadata: { reviewed: true }
 * };
 * ```
 */
export interface MessageUpdateFields {
  /** New message text content */
  content?: string;
  /** New reasoning/thinking content */
  reasoning_content?: string;
  /** Alias for `reasoning_content` */
  reasoning?: string;
  /** Metadata key-values to shallow-merge */
  metadata?: Record<string, unknown>;
}

/**
 * Self-contained turn snapshot bundle stored on `agent.redoStack` (INV-6 / INV-UNDO-BUNDLE).
 * Captures all messages belonging to a conversational turn for atomic undo/redo restoration.
 *
 * @example
 * ```typescript
 * const bundle: TurnBundle = {
 *   turnId: 'turn_a1b2c3d4',
 *   timestamp: Date.now(),
 *   userPrompt: 'Summarize the log output.',
 *   userMessage: { id: 'msg_u1', role: 'user', content: 'Summarize the log output.' },
 *   assistantMessages: [{ id: 'msg_a1', role: 'assistant', content: 'Here is the summary...' }],
 *   toolMessages: [],
 *   allPoppedMessages: [
 *     { id: 'msg_u1', role: 'user', content: 'Summarize the log output.' },
 *     { id: 'msg_a1', role: 'assistant', content: 'Here is the summary...' }
 *   ],
 *   finalOutput: 'Here is the summary...',
 *   turnCountDelta: 1,
 *   restoredPrompt: 'Summarize the log output.'
 * };
 * ```
 */
export interface TurnBundle {
  /** Unique turn identifier */
  readonly turnId: string;
  /** Epoch timestamp when turn bundle was assembled */
  readonly timestamp: number;
  /** Raw text of the initiating user prompt */
  readonly userPrompt: string | null;
  /** Initiating user message instance */
  readonly userMessage: HistoryMessage | null;
  /** All assistant messages emitted during the turn */
  readonly assistantMessages: HistoryMessage[];
  /** All tool response messages emitted during the turn */
  readonly toolMessages: HistoryMessage[];
  /** All messages popped during undo in chronological order */
  readonly allPoppedMessages: HistoryMessage[];
  /** Final assistant text output produced by the turn */
  readonly finalOutput: string;
  /** Number of turns to decrement during undo / increment during redo */
  readonly turnCountDelta: number;
  /** Prompt string restored to the user input box */
  readonly restoredPrompt: string;
  /**
   * Zero-based history position the turn occupied before removal, recorded only
   * by a targeted undo of an earlier (non-tail) turn. `redoAgentTurn` re-inserts
   * `allPoppedMessages` at this index (clamped to the current history length) so
   * redo cannot reorder history; conventional tail-undone bundles omit it and
   * redo appends at the tail.
   */
  readonly insertionIndex?: number;
}

/**
 * Return signature of {@link HistoryManager.undoAgentTurn}.
 *
 * @example
 * ```typescript
 * const result: UndoTurnResult = {
 *   undoneUserContent: 'Generate a plot outline.',
 *   undoneAssistantContent: 'Outline: Act 1...',
 *   count: 2,
 *   restoredPrompt: 'Generate a plot outline.'
 * };
 * ```
 */
export interface UndoTurnResult {
  /** Content of the undone user message */
  readonly undoneUserContent: string | null;
  /** Content of the undone final assistant message */
  readonly undoneAssistantContent: string | null;
  /** Total number of messages popped from history */
  readonly count: number;
  /** Prompt text restored for user editing */
  readonly restoredPrompt: string;
}

/**
 * Return signature of {@link HistoryManager.redoAgentTurn}.
 *
 * @example
 * ```typescript
 * const result: RedoTurnResult = {
 *   success: true,
 *   restoredPrompt: 'Generate a plot outline.',
 *   turnCount: 3
 * };
 * ```
 */
export interface RedoTurnResult {
  /** Whether the redo operation succeeded */
  readonly success: boolean;
  /** Failure reason code if unsuccessful (e.g. `'EMPTY_REDO_STACK'`) */
  readonly reason?: 'EMPTY_REDO_STACK' | string;
  /** Restored user prompt text */
  readonly restoredPrompt?: string;
  /** Updated agent turn count */
  readonly turnCount?: number;
}

/**
 * Interrupted-turn recovery record stored on `agent.lastInterruptedTurn`.
 *
 * The turn execution engine writes the record when an in-flight turn is aborted
 * or cancelled; `HistoryManager` reads and clears it during undo and retry.
 * `toSnapshot()` deep-copies and serializes the record and `fromSnapshot()`
 * restores it, so an interrupted turn survives a persistence round-trip.
 *
 * @example
 * ```typescript
 * const interrupted: InterruptedTurn = {
 *   input: 'Draft the opening scene',
 *   mode: 'chat',
 *   timestamp: 1773700000000,
 *   cancelled: true
 * };
 * ```
 */
export interface InterruptedTurn {
  /** Input the interrupted turn was executing with (prompt string, message object/array, or null) */
  readonly input: unknown;
  /** Execution mode the turn was started with; absent/null when no mode was supplied */
  readonly mode?: string | null;
  /** Epoch millisecond timestamp when the turn was interrupted */
  readonly timestamp: number;
  /** Whether the interruption was a cooperative cancel/abort */
  readonly cancelled: boolean;
}

// ============================================================================
// 4. Telemetry & Introspection Interfaces
// ============================================================================

/**
 * Plain, JSON-serializable Agent snapshot produced by `Agent.toSnapshot()` and
 * consumed by `Agent.fromSnapshot()`.
 */
export interface SerializedAgent {
  /** Unique agent identifier; takes precedence over `config.id` during hydration */
  id: string;
  /** Display name; hydration falls back to `config.name`, then `id` */
  name: string;
  /**
   * Deep-copied configuration snapshot, including the resolved `modelConfig`.
   * Caller-asserted authority fields (`privileged`, `isPrivileged`, `isAdmin`)
   * are stripped before serialization (MOD-21 W5); restore re-derives the
   * authority descriptor from trusted construction only.
   */
  config: AgentConfig;
  /** Lifecycle state captured at snapshot time; defaults to `'idle'` when absent */
  state?: AgentState;
  /** Human-readable detail for `state`; `null` when none was recorded */
  stateDetail?: string | null;
  /** Cumulative completed conversational turn count; defaults to `0` when absent */
  turnCount: number;
  /** Telemetry counters captured at snapshot time */
  telemetry: AgentTelemetry;
  /** Epoch millisecond creation timestamp */
  createdAt: number;
  /** Epoch millisecond last-update timestamp */
  updatedAt: number;
  /** Most recent context summary text, if any */
  lastSummary?: string | null;
  /**
   * Diagnostic message from the last failed turn (`null` when healthy).
   * `toSnapshot()` emits the field and `fromSnapshot()` restores it; the
   * persistence layer remains responsible for redacting stored copies.
   */
  lastError?: string | null;
  /** ISO string timestamp of the soft-kill that moved the agent to the recycle bin */
  recycledAt?: string | null;
  /** Reason recorded for the soft-kill; `null` when active */
  recycleReason?: string | null;
  /** Deep-copied conversational history; hydration backfills missing message IDs */
  history: HistoryMessage[];
  /** Deep-copied atomic turn bundles (runtime `TurnBundle` objects) for undo/redo */
  redoStack: unknown[];
  /** Deep-copied queue of pending precall hooks */
  pendingPrecalls?: unknown[];
  /**
   * Deep-copied interrupted-turn recovery record; `toSnapshot()` always emits
   * the field (`null` when no interrupted turn is recorded), and `fromSnapshot()`
   * restores it when present.
   */
  lastInterruptedTurn?: InterruptedTurn | null;
}

/**
 * Token and execution telemetry counters for a single agent.
 *
 * Metrics are produced by the runtime telemetry subsystem and applied to
 * `Agent.telemetry` through `Agent.applyTelemetrySnapshot()`; token counters are
 * cumulative, while `last*` fields describe the most recent turn.
 */
export interface AgentTelemetry {
  /** Cumulative prompt tokens processed */
  inputTokens: number;
  /** Cumulative completion tokens generated */
  outputTokens: number;
  /** Total tokens consumed (input + output) */
  totalTokens: number;
  /** Total completed conversational turns */
  turnCount: number;
  /** Prompt tokens in the most recent turn */
  lastPromptTokens: number;
  /** Completion tokens in the most recent turn */
  lastCompletionTokens: number;
  /** Number of turns terminated via stop conditions */
  terminalStops: number;
  /** Injected trigger deliveries */
  injectedDeliveries: number;
  /** Tool precall hook invocations */
  precallCount: number;
  /** Context snapshot sent in the most recent LLM request */
  lastSentContext: unknown[];
}

/**
 * Identity and permission descriptor returned by `whoami(agentId)`.
 *
 * @example
 * ```typescript
 * const identity: AgentIdentityDescriptor = {
 *   success: true,
 *   agentId: 'coder',
 *   name: 'Coder Agent',
 *   role: 'developer',
 *   privileged: false,
 *   workspace: 'coder',
 *   triggerPolicy: 'auto',
 *   allowedTools: ['read_file', 'write_to_file']
 * };
 * ```
 */
export interface AgentIdentityDescriptor {
  /** Operation status */
  readonly success: boolean;
  /** Unique agent identifier */
  readonly agentId: string;
  /** Display name */
  readonly name: string;
  /** Role string */
  readonly role: string;
  /**
   * Whether agent has sudo/privileged status.
   *
   * Legacy boolean projection of `config.privileged` retained for wire
   * compatibility; authority decisions read the runtime registry
   * `AuthorityDescriptor`, and this boolean remains the fallback only for hosts
   * whose identity projection lacks `authority`.
   */
  readonly privileged: boolean;
  /** Private VirtualFS workspace identifier */
  readonly workspace: string;
  /** Stored legacy trigger-policy label (display only; does not gate execution) */
  readonly triggerPolicy: TriggerPolicy;
  /** Allowed tool names */
  readonly allowedTools: string[];
}

/**
 * Agent summary descriptor for introspection and UI state binding.
 *
 * @example
 * ```typescript
 * const descriptor: AgentDescriptor = {
 *   id: 'coder',
 *   name: 'Coder Agent',
 *   state: 'idle',
 *   role: 'developer',
 *   triggerPolicy: 'auto',
 *   unreadCount: 0,
 *   allowedTools: ['read_file'],
 *   workspace: 'coder'
 * };
 * ```
 */
export interface AgentDescriptor {
  /** Agent identifier */
  readonly id: string;
  /** Display name */
  readonly name: string;
  /** Current FSM lifecycle state */
  readonly state: AgentState;
  /** Role description */
  readonly role: string;
  /** Stored legacy trigger-policy label (display only; does not gate execution) */
  readonly triggerPolicy: TriggerPolicy;
  /** Unread mailbox message count */
  readonly unreadCount: number;
  /** Whitelisted tool names */
  readonly allowedTools: string[];
  /**
   * Private VirtualFS workspace label, or absent when no realm-opaque label
   * exists.
   *
   * The label is the configured workspace (`config.workspaceId`) or the bare
   * agent id; it is omitted when the only available value would echo internal
   * realm vocabulary (`realm:`/`system:` canonical shapes and the engine-known
   * realm-registry id), so an id that fails the realm-opacity helper never
   * becomes a workspace label fallback (Wave I, ticket d57cbc1; folded defect
   * eab4e51). Reserved partition shapes (`global`, `public`,
   * `realm:<realmId>:global`) stay present; agent-facing projections mask them
   * (`global`).
   */
  readonly workspace?: string;
}

/**
 * Provenance record written by `Agent.fromSnapshot()` when a snapshot's
 * caller-asserted privilege claim was ignored during hydration.
 *
 * The record is transient restore provenance: authority is never persisted, so
 * the field is not part of the `SerializedAgent` contract. A clean hydration
 * leaves `Agent.authorityDowngrade` at `null`.
 *
 * @example
 * ```typescript
 * const restored = Agent.fromSnapshot(tamperedSnapshot);
 * if (restored.authorityDowngrade) {
 *   console.warn('Ignored snapshot privilege claims:', restored.authorityDowngrade.fields);
 * }
 * ```
 */
export interface AuthorityDowngradeRecord {
  /** Fixed reason code for the only supported downgrade path. */
  readonly reason: 'SNAPSHOT_AUTHORITY_CLAIM_IGNORED';
  /** Canonical config paths of the dropped claims (e.g. `'privileged'` or `'callerContext.isAdmin'`). */
  readonly fields: readonly string[];
  /** Epoch millisecond timestamp when the downgrade was recorded. */
  readonly at: number;
}

// ============================================================================
// 5. Agent Domain Entity Class
// ============================================================================

/**
 * Error carrying an optional machine-readable lifecycle error code.
 */
interface CodedError extends Error {
  code?: string;
}

/**
 * Owner-controlled authority-bearing state backing the read-only config and
 * instance projections.
 */
interface AuthorityState {
  privileged: boolean;
  allowedTools: readonly string[];
  role: string;
  spawnedBy: string | null;
  creatorId: string | null;
  realmId: string | null;
}

/**
 * Caller-asserted authority field names (MOD-21). Any occurrence in serialized
 * agent configuration is a trust claim, never configuration: `toSnapshot()`
 * drops these keys and `fromSnapshot()` ignores them (tampered claims downgrade,
 * schema-invalid claims reject the snapshot).
 */
const AUTHORITY_CLAIM_FIELDS = Object.freeze(['privileged', 'isPrivileged', 'isAdmin']);

/**
 * Authority-bearing config fields that the entity channel must never apply.
 * `Agent#updateConfig` is reachable through the public `runtime.getAgent()`
 * entity reference without a principal, while the lifecycle authority gate
 * lives in `AgentLifecycleManager.updateAgentConfig` (MOD-21 W8, 4eaf2cc).
 * The gated manager strips these fields before delegating the non-authority
 * merge and is the only writer for them.
 * @internal
 */
const AUTHORITY_BEARING_UPDATE_FIELDS = Object.freeze([
  'privileged',
  'isAdmin',
  'isPrivileged',
  'allowedTools',
  'tools',
  'toolPreset',
  'tool_preset',
  'role',
  'spawnedBy',
  'creatorId',
  'realmId',
  'realmBypass'
]);

/**
 * Authority-bearing config fields projected as owner-controlled read-only
 * accessors over private authority state (MOD-21 W10, 5b585b7). A field is
 * projected only when it was present at trusted construction or explicitly
 * granted through the owner-controlled channel; a snapshot-hydrated config
 * (whose selectors/parentage are withheld) never grows the accessor, so the
 * `hasOwnProperty` hydration contract holds. The live config object itself is
 * non-extensible, so a hostile caller cannot add an authority key that no
 * accessor shadows.
 * @internal
 */
const AUTHORITY_CONFIG_PROJECTION_FIELDS = Object.freeze([
  'privileged',
  'allowedTools',
  'tools',
  'role',
  'spawnedBy',
  'creatorId',
  'realmId'
] as const);

/**
 * Key names that mutate an assignment target's prototype instead of creating
 * an own data property. A config tree is data only: these names are never
 * adopted into the live config (the persistence validator rejects the same
 * names on the app restore path), and an untrusted snapshot config carrying one
 * is rejected fail-closed at hydration (MOD-21 W11-A, 556636e).
 * @internal
 */
const PROTOTYPE_POLLUTION_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/**
 * Tests whether a key name is prototype-mutating.
 */
function isPrototypePollutionKey(key: string): boolean {
  for (let i = 0; i < PROTOTYPE_POLLUTION_KEYS.length; i++) {
    if (PROTOTYPE_POLLUTION_KEYS[i] === key) return true;
  }
  return false;
}

/**
 * Recursively finds the first own prototype-mutating key in a plain data tree
 * (the same policy as the persistence validator, `deepHasPrototypePollution`).
 * `Object.getOwnPropertyNames` is used so a non-enumerable own `__proto__` is
 * detected too. Returns the offending key name, or `null` when clean.
 */
function findPrototypePollutionKey(target: unknown, seen: Set<unknown> = new Set()): string | null {
  if (!target || typeof target !== 'object') return null;
  if (seen.has(target)) return null;
  seen.add(target);

  const names = Object.getOwnPropertyNames(target);
  for (let i = 0; i < names.length; i++) {
    if (isPrototypePollutionKey(names[i])) return names[i];
  }

  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      const nested = findPrototypePollutionKey(target[i], seen);
      if (nested) return nested;
    }
    return null;
  }

  for (let i = 0; i < names.length; i++) {
    const value = (target as Record<string, unknown>)[names[i]];
    if (value && typeof value === 'object') {
      const nested = findPrototypePollutionKey(value, seen);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Tests whether a config field name is authority-bearing.
 */
function isAuthorityBearingConfigField(field: string): boolean {
  for (let i = 0; i < AUTHORITY_BEARING_UPDATE_FIELDS.length; i++) {
    if (AUTHORITY_BEARING_UPDATE_FIELDS[i] === field) return true;
  }
  return false;
}

/**
 * Normalizes an allowed-tool selector into distinct canonical names using
 * indexed reads only: `Array.prototype` methods (`includes`, iterators) are
 * in-realm patchable, and this input feeds the frozen authority descriptor
 * (MOD-21 W10, 4300b06).
 */
function normalizeAllowedToolNames(rawAllowed: unknown): string[] {
  if (rawAllowed === '*') return ['*'];
  if (!Array.isArray(rawAllowed)) return [];
  const names: string[] = [];
  for (let i = 0; i < rawAllowed.length; i++) {
    const name = rawAllowed[i];
    if (typeof name !== 'string' || !name) continue;
    let seen = false;
    for (let j = 0; j < names.length; j++) {
      if (names[j] === name) {
        seen = true;
        break;
      }
    }
    if (!seen) names[names.length] = name;
  }
  return names;
}

/**
 * Reads a caller-supplied options object exactly once into plain data before
 * any authorization or application step (MOD-21 W10, 7db884b). A stateful
 * `Proxy` cannot answer the authority-gate reads differently from the apply
 * reads when both consume this snapshot. Data descriptors contribute their
 * recorded `value`; accessor descriptors are read once through [[Get]].
 * Non-object input yields an empty snapshot. Entries are defined as own data
 * properties (never assigned), so an own `__proto__` key cannot mutate the
 * snapshot's prototype (MOD-21 W11-A, 556636e).
 */
function snapshotCallerObject(input: unknown): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  if (!input || typeof input !== 'object') return snapshot;
  const keys = Object.keys(input);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor) continue;
    Object.defineProperty(snapshot, key, {
      value: 'value' in descriptor ? descriptor.value : (input as Record<string, unknown>)[key],
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return snapshot;
}

/**
 * Builds the permission-denied error used by the entity authority gates.
 */
function createEntityPermissionDeniedError(message: string): CodedError {
  const err: CodedError = new Error(message);
  err.name = 'PermissionDeniedError';
  err.code = 'PERMISSION_DENIED';
  return err;
}

/**
 * Builds a frozen, duplicate-free member-name copy using indexed reads only.
 * `Array.prototype` methods are in-realm patchable, so the authority facade
 * must never route its backing-data construction through them (MOD-21 W10,
 * 4300b06).
 */
function freezeAuthorityMemberNames(names: unknown): ReadonlyArray<string> {
  const members: string[] = [];
  if (Array.isArray(names)) {
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (typeof name !== 'string' || name === '') continue;
      let seen = false;
      for (let j = 0; j < members.length; j++) {
        if (members[j] === name) {
          seen = true;
          break;
        }
      }
      if (!seen) members[members.length] = name;
    }
  } else if (typeof names === 'string' && names !== '') {
    members[members.length] = names;
  }
  return Object.freeze(members);
}

/**
 * Builds a genuinely immutable `ReadonlySet` facade for an authority
 * descriptor's `allow` set. `Object.freeze(new Set())` does not block
 * `Set`-internal mutation (`Set.prototype.add.call(allow, ...)` bypasses an
 * own-property shadow), so the facade is a frozen plain object built over a
 * snapshot of the member names: every read (`has`, `size`, `values`, `keys`,
 * `entries`, iteration, `forEach`) is an own indexed closure over that private
 * array, and `add`/`delete`/`clear` are neutralized.
 *
 * The facade keeps `Set.prototype` as its prototype so `instanceof Set`
 * consumers keep working, but it never delegates a read to any prototype
 * method — neither `Set.prototype` (adf6cf0) nor `Array.prototype`
 * (MOD-21 W10, 4300b06): membership, iteration and pair production are own
 * indexed loops, so patching `Array.prototype.includes`/`map`/
 * `[Symbol.iterator]` can neither capture nor widen membership. Prototype
 * mutation forms (`Set.prototype.add.call(allow, ...)`) throw because the
 * facade has no `[[SetData]]` internal slot, and `forEach` passes the frozen
 * facade itself as the callback's third argument (916b052), so no exposed
 * method ever hands out the backing collection.
 */
function createReadonlyAuthorityAllow(names: unknown): Set<string> {
  const members = freezeAuthorityMemberNames(names);
  const buildIterator = (entries: boolean): IterableIterator<string | string[]> => {
    let index = 0;
    const iterator = {
      next(): IteratorResult<string | string[]> {
        if (index < members.length) {
          const member = members[index];
          index += 1;
          return { value: entries ? [member, member] : member, done: false };
        }
        return { value: undefined, done: true };
      },
      [Symbol.iterator]() {
        return iterator;
      }
    };
    return iterator;
  };
  const facade = {
    get size() {
      return members.length;
    },
    has(value: string): boolean {
      for (let i = 0; i < members.length; i++) {
        if (members[i] === value) return true;
      }
      return false;
    },
    values() {
      return buildIterator(false);
    },
    keys() {
      return buildIterator(false);
    },
    entries() {
      return buildIterator(true);
    },
    forEach(callback: (value: string, value2: string, set: unknown) => void, thisArg?: unknown): void {
      if (typeof callback !== 'function') {
        throw new TypeError('callback must be a function');
      }
      for (let i = 0; i < members.length; i++) {
        callback.call(thisArg, members[i], members[i], facade);
      }
    },
    [Symbol.iterator]() {
      return buildIterator(false);
    },
    add: undefined,
    delete: undefined,
    clear: undefined
  };
  Object.setPrototypeOf(facade, Set.prototype);
  return Object.freeze(facade) as unknown as Set<string>;
}

/**
 * Builds an agent's frozen authority descriptor once at construction from
 * trusted configuration only (MOD-21 `AuthorityDescriptor`).
 *
 * Derivation policy:
 * - `config.privileged === true` grants the wildcard `'*'` (every tool/op) and
 *   `visibility: 'all'`; every other value is default-deny.
 * - Unprivileged agents get exactly their configured `allowedTools` names and
 *   `visibility: 'owned'` (self plus descendants).
 * - Authority is never assembled from caller context, snapshot data, or a
 *   reserved id; the id is the descriptor subject only.
 */
function buildAgentAuthority(id: string, config: Record<string, unknown> | null): AuthorityDescriptor {
  const privileged = config?.privileged === true;
  const rawAllowed = config?.allowedTools !== undefined ? config.allowedTools : config?.tools;
  const names = normalizeAllowedToolNames(rawAllowed);
  if (privileged) {
    let hasWildcard = false;
    for (let i = 0; i < names.length; i++) {
      if (names[i] === '*') {
        hasWildcard = true;
        break;
      }
    }
    if (!hasWildcard) names[names.length] = '*';
  }
  return Object.freeze({
    subject: id,
    kind: 'agent',
    allow: createReadonlyAuthorityAllow(names),
    visibility: privileged ? 'all' : 'owned',
    // The entity-level descriptor never carries the scope grant: `realmBypass`
    // is registry-owned (engine bootstrap / operator grant) and reaches
    // consumers through the runtime identity projection (Wave I, c02d0b9).
    realmBypass: false
  });
}

/**
 * Recursively deletes caller-asserted authority fields from a plain
 * JSON-shaped object tree. Mutates the given tree (callers pass a copy).
 */
function stripAuthorityClaims(target: unknown, seen: Set<unknown> = new Set()): unknown {
  if (!target || typeof target !== 'object') return target;
  if (seen.has(target)) return target;
  seen.add(target);

  if (Array.isArray(target)) {
    for (const entry of target) stripAuthorityClaims(entry, seen);
    return target;
  }

  const record = target as Record<string, unknown>;
  for (const field of AUTHORITY_CLAIM_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) delete record[field];
  }
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value && typeof value === 'object') stripAuthorityClaims(value, seen);
  }
  return target;
}

/**
 * Deep-copies a serialized agent config so hydration never mutates
 * caller-owned snapshot objects. Serialized configs are pure JSON; a
 * function-valued programmatic input falls back to a shallow copy.
 */
function cloneSerializedConfig(config: object): Record<string, unknown> {
  try {
    return (typeof structuredClone === 'function' ? structuredClone(config) : JSON.parse(JSON.stringify(config))) as Record<string, unknown>;
  } catch {
    return { ...config };
  }
}

/**
 * Inspects untrusted snapshot config for caller-asserted authority claims.
 * Boolean `true` values are tampered grants to drop (and record during
 * hydration); non-boolean values are schema-invalid and fail closed. The
 * canonical claim sites are the top-level config plus the legacy caller
 * references (`config.callerContext`, `config.callerAgent[.config]`).
 */
function inspectAuthorityClaims(config: unknown): { claimed: string[]; invalid: string[] } {
  const claimed: string[] = [];
  const invalid: string[] = [];

  const inspect = (holder: unknown, prefix: string): void => {
    if (!holder || typeof holder !== 'object' || Array.isArray(holder)) return;
    const record = holder as Record<string, unknown>;
    for (const field of AUTHORITY_CLAIM_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
      const value = record[field];
      if (typeof value !== 'boolean') {
        invalid.push(`${prefix}${field}`);
      } else if (value === true) {
        claimed.push(`${prefix}${field}`);
      }
    }
  };

  if (config && typeof config === 'object') {
    const record = config as Record<string, unknown>;
    inspect(record, '');
    inspect(record.callerContext, 'callerContext.');
    inspect(record.callerAgent, 'callerAgent.');
    const callerAgent = record.callerAgent;
    if (callerAgent && typeof callerAgent === 'object') {
      inspect((callerAgent as Record<string, unknown>).config, 'callerAgent.config.');
    }
  }

  return { claimed, invalid };
}

/**
 * Normalizes a partial telemetry snapshot into a complete {@link AgentTelemetry}
 * record, applying the same whitelist and coercion policy as
 * {@link Agent.applyTelemetrySnapshot}: only declared fields are copied (no
 * expandos), non-finite numeric values become `0`, and `lastSentContext` is
 * copied member-wise (defaulting to `[]`). Missing fields take the entity's
 * exact defaults (all counters `0`, `lastSentContext: []`).
 *
 * The constructor and `applyTelemetrySnapshot` share this normalizer, so a
 * caller-supplied `Partial<AgentTelemetry>` can never leave `Agent.telemetry`
 * with `undefined` fields that its declared type promises.
 *
 * @param snapshot - Partial telemetry values; `null`/`undefined` yields defaults
 * @returns A fresh, complete {@link AgentTelemetry} record
 * @internal
 */
function normalizeAgentTelemetry(snapshot: Partial<AgentTelemetry> | null | undefined): AgentTelemetry {
  const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value)) ? value : 0;
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    inputTokens: asNumber(source.inputTokens),
    outputTokens: asNumber(source.outputTokens),
    totalTokens: asNumber(source.totalTokens),
    turnCount: asNumber(source.turnCount),
    lastPromptTokens: asNumber(source.lastPromptTokens),
    lastCompletionTokens: asNumber(source.lastCompletionTokens),
    terminalStops: asNumber(source.terminalStops),
    injectedDeliveries: asNumber(source.injectedDeliveries),
    precallCount: asNumber(source.precallCount),
    lastSentContext: Array.isArray(source.lastSentContext)
      ? source.lastSentContext.map(m => (m && typeof m === 'object' ? { ...m } : m))
      : []
  };
}

/**
 * Resolves the effective model configuration and bound preset id for a new
 * entity (MOD-20 aware).
 *
 * A source-bearing construction always binds (ICD §6: every agent persists
 * `config.presetId`): the caller's id when it resolves, otherwise the current
 * catalog `getDefaultPresetId()`. The resolved preset is binding-only (OPEN-1):
 * its credential-free `modelConfig` is authoritative and the caller's explicit
 * `modelConfig`/`settings.modelConfig` never forms an override layer. Because
 * presets carry no `keyId` (OPEN-2), the provider's active credential id is
 * re-attached here, falling back to the `canonical_<providerId>` reference when
 * no resolver or active credential is available. A source-less construction
 * keeps the legacy blend of explicit settings default plus explicit overlay
 * (defensively, so does a source whose catalog resolves neither the requested
 * id nor its default).
 *
 * @param config - Candidate agent configuration
 * @param presetSource - Optional MOD-20 preset source projection
 * @param credentialResolver - Optional read-only credential resolver
 * @returns The effective, fully populated `AgentModelConfig` plus the bound
 *   `presetId` (`null` when the construction is unbound)
 * @internal
 */
function resolveInitialModelConfig(
  config: {
    settings?: Record<string, unknown> | null;
    modelConfig?: Partial<AgentModelConfig>;
    presetId?: string;
  },
  presetSource: ModelPresetSourcePort | null | undefined,
  credentialResolver: CredentialResolverPort | null | undefined
): { modelConfig: AgentModelConfig; presetId: string | null } {
  const requestedPresetId = typeof config.presetId === 'string' ? config.presetId.trim() : '';
  const legacyModelConfig = {
    ...getGlobalModelConfig(config.settings),
    ...(config.modelConfig || {})
  };
  if (!presetSource) {
    return { modelConfig: legacyModelConfig, presetId: requestedPresetId || null };
  }

  const presetId = requestedPresetId && presetSource.getPreset(requestedPresetId)
    ? requestedPresetId
    : presetSource.getDefaultPresetId();
  const preset = typeof presetId === 'string' && presetId ? presetSource.getPreset(presetId) : null;
  const providerId = preset && typeof preset.modelConfig.providerId === 'string'
    ? preset.modelConfig.providerId.trim()
    : '';
  const modelId = preset && typeof preset.modelConfig.modelId === 'string'
    ? preset.modelConfig.modelId.trim()
    : '';
  if (preset && providerId && modelId) {
    const keyId = credentialResolver?.getActiveCredential(providerId)?.id || `canonical_${providerId}`;
    return { modelConfig: { ...preset.modelConfig, providerId, modelId, keyId }, presetId };
  }

  // Source present but the catalog resolved nothing usable (violates the
  // default-validity invariant): keep the binding for a later turn-start
  // retry and degrade to the legacy blend.
  return {
    modelConfig: legacyModelConfig,
    presetId: (typeof presetId === 'string' && presetId) || requestedPresetId || null
  };
}

/**
 * Compares two effective model configurations key-wise by strict value
 * equality (all `AgentModelConfig` values are scalars, so the credential
 * reference `keyId` participates like any other key and a vault rotation is a
 * detected change). Used by `materializeEffectiveModel` to detect a catalog or
 * credential change, so a no-op turn or a byte-identical `preset-updated` save
 * does not regenerate provider/model.
 *
 * @param left - Candidate effective configuration
 * @param right - Currently materialized configuration
 * @returns True when both carry the same own keys with strictly equal values
 * @internal
 */
function modelConfigsEqual(left: AgentModelConfig, right: AgentModelConfig): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    const key = leftKeys[i];
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * Heals a hydrated snapshot's preset binding in memory (MOD-20 self-heal).
 *
 * A `presetId` that resolves through the supplied source is kept (trimmed); a
 * missing, non-string, or stale/unknown id is re-pointed at
 * `getDefaultPresetId()`. Without a source the persisted config is adopted
 * unchanged so legacy hydration keeps its exact behavior. The healed value is
 * entity state only: this path never rewrites persisted state.
 *
 * @param config - Hydrated, mutable config record
 * @param presetSource - Optional MOD-20 preset source projection
 * @internal
 */
function healSnapshotPresetBinding(
  config: Record<string, unknown>,
  presetSource: ModelPresetSourcePort | null | undefined
): void {
  if (!presetSource) return;
  const presetId = typeof config.presetId === 'string' ? config.presetId.trim() : '';
  if (presetId && presetSource.getPreset(presetId)) {
    config.presetId = presetId;
  } else {
    config.presetId = presetSource.getDefaultPresetId();
  }
}

/**
 * Agent Domain Entity.
 *
 * Represents an autonomous agent in the multi-agent sandbox runtime.
 * Encapsulates language model dependency injection, conversational history,
 * finite state machine status, telemetry metrics, and dual-stack undo/redo.
 *
 * Architectural Invariants:
 * 1. Pure AgentModelConfig Composition (INV-1): Holds zero raw credentials.
 * 2. Non-null ModelInterface & ProviderInterface bindings.
 * 3. Formal state encapsulation.
 *
 * @example
 * ```typescript
 * import { Agent } from './agent/index.ts';
 *
 * const agent = new Agent({
 *   id: 'researcher',
 *   name: 'Research Assistant',
 *   role: 'analyst',
 *   systemPrompt: 'You analyze scientific datasets and summarize findings.',
 *   allowedTools: ['read_file', 'search_web']
 * });
 *
 * console.log(`Agent ${agent.id} initialized in state: ${agent.state}`);
 * ```
 */
export class Agent {
  /** Unique immutable agent identifier */
  declare readonly id: string;
  /** Human-readable display name */
  declare name: string;
  /**
   * Resolved model configuration with global fallbacks applied
   */
  declare modelConfig: AgentModelConfig;
  /** Bound ProviderInterface instance */
  declare provider: ProviderInterface;
  /** Bound ModelInterface instance */
  declare model: ModelInterface;
  /**
   * Optional read-only credential resolver (`../credentialVault/index.ts`). When
   * `null`, provider construction resolves no credentials — there is no
   * singleton or ambient vault fallback.
   */
  declare credentialResolver: CredentialResolverPort | null;

  /**
   * Frozen authority descriptor (MOD-21), built once at construction from
   * trusted config and never mutated or persisted: `subject` is the agent id,
   * `kind` is `'agent'`, `allow` is the configured tool/op allow-set (`'*'`
   * wildcard for privileged construction), and `visibility` is `'all'` when
   * constructed privileged, `'owned'` otherwise. The property is non-writable
   * and `allow` is a read-only snapshot-closure facade whose reads are own
   * indexed closures over a private member-name array (`Array.prototype` is
   * never delegated to, 4300b06): mutators are neutralized, `Set.prototype` is
   * retained only so `instanceof Set` holds, and the `Set` prototype-call
   * vector throws because the facade has no `[[SetData]]` slot.
   */
  declare readonly authority: AuthorityDescriptor;

  /**
   * Transient provenance record set when `fromSnapshot()` ignored a snapshot's
   * caller-asserted authority claim; `null` for constructed and cleanly
   * hydrated agents.
   */
  declare authorityDowngrade: AuthorityDowngradeRecord | null;

  /** Current FSM lifecycle state */
  declare state: AgentState;
  /** Detail description of current state or error reason */
  declare stateDetail: string | null;
  /** Chronological conversational history array */
  declare history: HistoryMessage[];
  /** Redo stack holding atomic TurnBundles for undo/redo */
  declare redoStack: TurnBundle[];

  /** Ephemeral active streaming text buffer */
  declare currentStream: string;
  /** Ephemeral active thinking/reasoning text buffer */
  declare currentReasoning: string;
  /** In-flight tool calls currently executing */
  declare activeToolCalls: unknown[];
  /** Cumulative completed conversational turn count */
  declare turnCount: number;
  /** Most recent context summary text */
  declare lastSummary: string | null;
  /** Queued precall hooks */
  declare pendingPrecalls: unknown[];
  /** Execution and token usage telemetry */
  declare telemetry: AgentTelemetry;

  /** Epoch millisecond creation timestamp */
  declare createdAt: number;
  /** Epoch millisecond update timestamp */
  declare updatedAt: number;
  /** ISO string timestamp when soft-killed and moved to recycle bin */
  declare recycledAt?: string | null;
  /** Reason string provided upon soft-kill */
  declare recycleReason?: string | null;

  /**
   * Diagnostic message from the most recent failed turn (`null` when healthy);
   * the turn execution engine stores the message string, not an `Error` instance.
   */
  declare lastError: string | null;
  /**
   * Interrupted-turn record for error recovery; `null` when no aborted turn awaits retry.
   *
   * The turn execution engine writes `{ input, mode, timestamp, cancelled }` when an
   * active turn aborts, and `historyManager` reads and clears it during undo/retry.
   * The entity owns hydration and serialization: `toSnapshot()` deep-copies and
   * serializes the field (`null` when unset), and `fromSnapshot()` restores it.
   */
  declare lastInterruptedTurn: InterruptedTurn | null;
  /** AbortController controlling active turn execution */
  declare abortController: AbortController | null;
  /** Promise representing the currently executing turn */
  declare currentTurnPromise: Promise<unknown> | null;

  #config: Record<string, unknown> = {};
  /**
   * Injected MOD-20 preset source (fixed for the entity lifetime). `null`
   * keeps the legacy settings-default plus explicit-overlay resolution and
   * makes dirty marking / materialization no-ops.
   */
  #presetSource: ModelPresetSourcePort | null = null;
  /**
   * Binding dirty flag (MOD-20): set by `markPresetDirty()` (`preset-updated`),
   * `rebindToDefaultPreset()` (`preset-deleted`), and the bound-agent
   * `updateConfig` modelConfig/presetId branches. It means "re-resolve at the
   * next turn start", not "force regenerate": `materializeEffectiveModel()`
   * always recomputes the effective config/binding when it is set, but
   * regenerates provider/model only when that re-resolution differs key-wise
   * (`keyId` included) or the binding id healed. Either way the flag is
   * consumed — a byte-identical re-resolution clears it and returns `false`
   * without provider churn (ICD §9 W3).
   */
  #presetDirty = false;
  #authorityState: AuthorityState;
  #authorityFieldPresence: Record<string, boolean> = {};
  #authorityChannel: object | null = null;
  #authorityProvenance: 'construction' | 'snapshot' = 'construction';

  /**
   * Live configuration object (MOD-21 W10). Authority-bearing fields
   * (`privileged`, `allowedTools`/`tools`, `role`, `spawnedBy`/`creatorId`,
   * `realmId`) are getter-only projections of private owner-controlled state,
   * and the object is non-extensible: direct assignment, `Object.assign`,
   * `defineProperty`, deletion, and whole-object replacement cannot change
   * authority. The
   * setter re-adopts plain data only (authority keys ignored), so legitimate
   * whole-object replacement (e.g. `modelConfig` re-pinning) keeps working.
   */
  get config(): AgentConfig {
    return this.#config as AgentConfig & Record<string, unknown>;
  }

  /**
   * Whole-object config replacement (plain data only; authority keys are
   * ignored and the owner-controlled projections are reinstalled).
   */
  set config(next: AgentConfig) {
    this.#setConfigObject(next);
  }

  /**
   * Owner-controlled authority projection (MOD-21 W10): getter-only,
   * non-enumerable instance mirror of `config.privileged`. Writes throw.
   */
  get privileged(): boolean {
    return this.#authorityState.privileged;
  }

  /** Owner-controlled capability projection mirror of `config.allowedTools` (frozen array). */
  get allowedTools(): readonly string[] {
    return this.#authorityState.allowedTools;
  }

  /** Alias projection of `allowedTools`. */
  get tools(): readonly string[] {
    return this.#authorityState.allowedTools;
  }

  /** Owner-controlled role projection mirror of `config.role`. */
  get role(): string {
    return this.#authorityState.role;
  }

  /** Owner-controlled parentage projection mirror of `config.spawnedBy`. */
  get spawnedBy(): string | null {
    return this.#authorityState.spawnedBy;
  }

  /** Owner-controlled parentage projection mirror of `config.creatorId`. */
  get creatorId(): string | null {
    return this.#authorityState.creatorId;
  }

  /**
   * Owner-controlled provenance of the authority-bearing `config` fields:
   * `'construction'` for a live entity (config validated at launch or by an
   * operator edit) and `'snapshot'` for an entity hydrated from persisted
   * state. Snapshot provenance marks the config authority fields as untrusted
   * data: downstream re-derivations (recycle-bin restore, registry
   * registration) default-deny until a trusted operator grant lands. Not
   * serialized. The instance shadows the prototype reader with an own
   * non-configurable accessor, and only `Agent.fromSnapshot` writes the private
   * state, so a public field write cannot drive authority-bearing branches
   * (MOD-21 W11-A, 26a65c5).
   */
  get authorityProvenance(): 'construction' | 'snapshot' {
    return this.#authorityProvenance;
  }

  /**
   * Constructs a new Agent domain entity.
   *
   * Validates `config.id`, resolves `modelConfig` by blending global defaults,
   * instantiates or binds `provider` and `model`, and initializes history with
   * root system directive if `systemPrompt` is configured.
   *
   * @param config - Agent configuration specifying id, name, systemPrompt, tools, modelConfig,
   *   the legacy aliases declared on {@link AgentConfig}, and the optional entity hydration
   *   fields (`state`, `stateDetail`, `history`, `redoStack`, `turnCount`, `lastSummary`,
   *   `pendingPrecalls`, `telemetry`, `createdAt`, `updatedAt`, `recycledAt`, `recycleReason`,
   *   `lastInterruptedTurn`) read directly by the constructor (agent/index.ts:148-185)
   * @param model - Optional pre-instantiated concrete ModelInterface instance
   * @param provider - Optional pre-instantiated concrete ProviderInterface instance
   * @param credentialResolver - Optional read-only credential resolver injected into
   *   `createProvider`; when absent, provider construction resolves no credentials
   * @param authorityChannel - Optional opaque owner-controlled authority-write channel
   *   (reference identity only). The lifecycle manager injects its private channel so
   *   gated authority updates can reach the entity; public consumers cannot forge it.
   *   A snapshot-hydrated entity is bound by the manager before exposure
   *   (`bindAuthorityChannel`, first bind wins).
   * @param presetSource - Optional MOD-20 preset-source projection. When
   *   supplied the construction always binds: the requested `presetId` when it
   *   resolves, else `getDefaultPresetId()`; the preset's config determines the
   *   effective `modelConfig` (binding-only) with the provider-active credential
   *   re-attached. When absent, the legacy settings-default blend applies
   * @throws `Error` - With code `'INVALID_CONFIG'` if config is invalid or `id` is empty
   * @throws `Error` - With code `'PROVIDER_INIT_FAILED'` if model is provided without a valid provider
   *
   * @example
   * ```typescript
   * const agent = new Agent({
   *   id: 'reviewer',
   *   role: 'critic',
   *   systemPrompt: 'Provide constructive code review comments.'
   * });
   * ```
   */
  constructor(
    config: AgentConfig & {
      state?: AgentState;
      stateDetail?: string | null;
      history?: HistoryMessage[];
      redoStack?: TurnBundle[];
      turnCount?: number;
      lastSummary?: string | null;
      pendingPrecalls?: unknown[];
      telemetry?: Partial<AgentTelemetry> | null;
      createdAt?: number;
      updatedAt?: number;
      recycledAt?: string | null;
      recycleReason?: string | null;
      lastInterruptedTurn?: InterruptedTurn | null;
    },
    model?: ModelInterface | null,
    provider?: ProviderInterface | null,
    credentialResolver?: CredentialResolverPort | null,
    authorityChannel?: object | null,
    presetSource?: ModelPresetSourcePort | null
  );
  constructor(
    config: Partial<AgentConfig> & {
      state?: AgentState;
      stateDetail?: string | null;
      history?: HistoryMessage[];
      redoStack?: TurnBundle[];
      turnCount?: number;
      lastSummary?: string | null;
      pendingPrecalls?: unknown[];
      telemetry?: Partial<AgentTelemetry> | null;
      createdAt?: number;
      updatedAt?: number;
      recycledAt?: string | null;
      recycleReason?: string | null;
      lastInterruptedTurn?: InterruptedTurn | null;
    } = {},
    model: ModelInterface | null = null,
    provider: ProviderInterface | null = model?.provider || null,
    credentialResolver: CredentialResolverPort | null = null,
    authorityChannel: object | null = null,
    presetSource: ModelPresetSourcePort | null = null
  ) {
    if (!config || typeof config !== 'object') {
      const err: CodedError = new Error('Agent constructor requires a valid config object');
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    if (!config.id || typeof config.id !== 'string') {
      const err: CodedError = new Error("Agent constructor requires a valid string 'id' in config");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    this.id = config.id.trim();
    if (!this.id) {
      const err: CodedError = new Error("Agent constructor requires a non-empty string 'id' in config");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    this.name = config.name || this.id;

    // Owner-controlled authority state (MOD-21 W10, 5b585b7): the live config
    // exposes authority-bearing fields as read-only accessors backed by this
    // private state, so direct writes, `Object.assign`, and define/replace
    // attacks through a public entity reference cannot mint authority. Only
    // the opaque channel injected by the lifecycle manager may change it.
    this.#authorityChannel = authorityChannel || null;
    const authorityPresence: Record<string, boolean> = {};
    for (let i = 0; i < AUTHORITY_CONFIG_PROJECTION_FIELDS.length; i++) {
      const field = AUTHORITY_CONFIG_PROJECTION_FIELDS[i];
      authorityPresence[field] = Object.prototype.hasOwnProperty.call(config, field);
    }
    this.#authorityFieldPresence = authorityPresence;
    const rawConstructionAllowed = config.allowedTools !== undefined ? config.allowedTools : config.tools;
    this.#authorityState = {
      privileged: config.privileged === true,
      allowedTools: Object.freeze(normalizeAllowedToolNames(rawConstructionAllowed)),
      role: typeof config.role === 'string' ? config.role : '',
      spawnedBy: typeof config.spawnedBy === 'string' && config.spawnedBy ? config.spawnedBy : null,
      creatorId: typeof config.creatorId === 'string' && config.creatorId ? config.creatorId : null,
      realmId: typeof config.realmId === 'string' && config.realmId ? config.realmId : null
    };

    // Resolve the effective model config (MOD-20 aware): a source-bearing
    // construction always binds — the requested `presetId` when it resolves,
    // else the catalog default — binding-only and with the provider-active
    // credential reference re-attached; only a source-less construction keeps
    // the legacy settings-default plus explicit-overlay blend. See
    // `resolveInitialModelConfig`.
    const resolvedModel = resolveInitialModelConfig(config, presetSource, credentialResolver);
    this.modelConfig = resolvedModel.modelConfig;
    this.#presetSource = presetSource || null;

    const adoptedConfig: Record<string, unknown> = {
      ...config,
      modelConfig: { ...this.modelConfig }
    };
    if (resolvedModel.presetId) {
      adoptedConfig.presetId = resolvedModel.presetId;
    }
    this.#adoptConfig(adoptedConfig);

    Object.defineProperty(this, 'config', {
      get: () => this.#config,
      set: (next) => { this.#setConfigObject(next); },
      enumerable: true,
      configurable: false
    });
    this.#installInstanceAuthorityProjection();

    // Frozen authority descriptor (MOD-21): built once from trusted construction
    // config, then locked non-writable for the life of the entity. Snapshot
    // hydration never reaches this path with privilege claims (see `fromSnapshot`).
    this.authority = buildAgentAuthority(this.id, this.#config);
    Object.defineProperty(this, 'authority', {
      writable: false,
      configurable: false,
      enumerable: true
    });

    /**
     * Provenance record set by `Agent.fromSnapshot` when a caller-asserted
     * authority claim was ignored during hydration (`null` when clean).
     */
    this.authorityDowngrade = null;

    /**
     * Provenance of the authority-bearing `config` fields (MOD-21 W7):
     * `'construction'` for a live entity (config validated at launch or by an
     * operator edit) and `'snapshot'` for an entity hydrated from persisted
     * state (config authority fields are untrusted data and never re-grant).
     * Not serialized; `toSnapshot()` ignores it. Owner-controlled (MOD-21
     * W11-A, 26a65c5): an own non-configurable getter shadows the prototype
     * reader, and only `Agent.fromSnapshot` writes the private state, so a
     * public caller cannot drive authority-bearing branches.
     */
    this.#authorityProvenance = 'construction';
    Object.defineProperty(this, 'authorityProvenance', {
      get: () => this.#authorityProvenance,
      enumerable: true,
      configurable: false
    });

    this.credentialResolver = credentialResolver || null;

    if (model) {
      this.model = model;
      const resolvedProvider = provider || model.provider || null;
      if (!resolvedProvider) {
        const err: CodedError = new Error(`Injected model for agent '${this.id}' must have an associated provider.`);
        err.code = 'PROVIDER_INIT_FAILED';
        throw err;
      }
      this.provider = resolvedProvider;
    } else {
      this.#initProviderAndModel();
    }

    // Runtime Lifecycle State
    this.state = config.state || AGENT_STATES.IDLE;
    this.stateDetail = config.stateDetail || null;
    this.history = Array.isArray(config.history) ? [...config.history] : [];
    const rootSystemPrompt = config.systemPrompt || config.system_prompt;
    if (this.history.length === 0 && rootSystemPrompt) {
      this.history.push({
        id: generateMessageId('sys'),
        role: 'system',
        content: rootSystemPrompt
      });
    }
    ensureHistoryMessageIds(this.history);
    this.redoStack = Array.isArray(config.redoStack) ? [...config.redoStack] : [];
    this.currentStream = '';
    this.currentReasoning = '';
    this.activeToolCalls = [];
    this.turnCount = typeof config.turnCount === 'number' ? config.turnCount : 0;
    this.lastSummary = config.lastSummary || null;
    this.pendingPrecalls = Array.isArray(config.pendingPrecalls) ? [...config.pendingPrecalls] : [];
    this.telemetry = normalizeAgentTelemetry(config.telemetry);
    this.createdAt = config.createdAt || Date.now();
    this.updatedAt = config.updatedAt || Date.now();
    this.recycledAt = config.recycledAt || null;
    this.recycleReason = config.recycleReason || null;
    this.lastError = null;
    this.lastInterruptedTurn = config.lastInterruptedTurn
      ? JSON.parse(JSON.stringify(config.lastInterruptedTurn))
      : null;
    this.abortController = null;
    this.currentTurnPromise = null;

    // MOD-21 W11-A (18f43d6): freeze the entity's [[Prototype]] slot and its
    // property set. `Object.preventExtensions` makes a later
    // `Object.setPrototypeOf(entity, …)` throw (the same guarantee the live
    // config already has), so a public entity reference cannot shadow the
    // authority methods with a capture shim. Every legitimate field is defined
    // above; the lifecycle manager reaches authority state only through the
    // intrinsic prototype methods.
    Object.preventExtensions(this);
  }

  /**
   * Instantiates provider and model instances from this.modelConfig.
   */
  #initProviderAndModel() {
    this.provider = createProvider(this.modelConfig, this.credentialResolver ?? undefined);
    this.model = this.provider.createModel(this.modelConfig.modelId, this.modelConfig);
  }

  /**
   * Re-runs provider/model binding from the current modelConfig.
   */
  rebindModel() {
    this.#initProviderAndModel();
    this.updatedAt = Date.now();
  }

  /**
   * Marks a bound agent's preset binding dirty (MOD-20 `preset-updated`).
   *
   * The next {@link materializeEffectiveModel} re-resolves the bound preset
   * (config plus provider-active `keyId`, so a catalog save that rotates tuning
   * or credentials regenerates provider/model); a dirty mark whose re-resolved
   * config and binding are byte-identical is consumed without regenerating
   * (ICD §9 W3). No-op for an agent without an injected
   * `ModelPresetSourcePort`; this method never rebuilds provider/model, so a
   * catalog update landing mid-turn cannot swap the live model.
   */
  markPresetDirty(): void {
    if (!this.#presetSource) return;
    this.#presetDirty = true;
  }

  /**
   * Materializes the bound preset's effective model config (MOD-20 W3-B2).
   *
   * Turn-start-only by contract: the turn engine calls this exactly once per
   * turn before its inference loop, after staging, so directive, mail,
   * auto-trigger, and tool-loop turns all observe the freshly materialized
   * model. For a bound agent the flow is:
   *
   * 1. Resolve the effective preset id — the current `config.presetId` when it
   *    resolves, else `getDefaultPresetId()` (stale/deleted bindings heal).
   * 2. Compose the effective `AgentModelConfig`: preset fields plus normalized
   *    `providerId`/`modelId` and a refreshed `keyId` from the provider's
   *    active credential (OPEN-2), falling back to `canonical_<providerId>`.
   * 3. When the effective config differs key-wise from the current
   *    `modelConfig` (including `keyId`, so a vault rotation regenerates) or
   *    the binding id healed: adopt the new cache (`config.modelConfig` +
   *    `config.presetId`), re-initialize provider/model
   *    (`#initProviderAndModel()`), clear dirty, refresh `updatedAt`, and
   *    return `true`. A dirty mark alone only forces the re-resolution of steps
   *    1–2: an unchanged result clears the flag and returns `false` without
   *    regenerating provider/model (ICD §9 W3).
   *
   * Unbound agents (no source) and unresolvable catalogs are no-ops returning
   * `false`; per-agent `modelConfig` edits never form an override layer
   * (binding-only, OPEN-1).
   *
   * @returns True when provider/model were regenerated, false when nothing
   *   materialized
   */
  materializeEffectiveModel(): boolean {
    const source = this.#presetSource;
    if (!source) return false;

    const currentPresetId = typeof this.#config.presetId === 'string' ? this.#config.presetId.trim() : '';
    const presetId = currentPresetId && source.getPreset(currentPresetId)
      ? currentPresetId
      : source.getDefaultPresetId();
    if (typeof presetId !== 'string' || !presetId) return false;

    const preset = source.getPreset(presetId);
    const providerId = preset && typeof preset.modelConfig.providerId === 'string'
      ? preset.modelConfig.providerId.trim()
      : '';
    const modelId = preset && typeof preset.modelConfig.modelId === 'string'
      ? preset.modelConfig.modelId.trim()
      : '';
    if (!preset || !providerId || !modelId) return false;

    const keyId = this.credentialResolver?.getActiveCredential(providerId)?.id || `canonical_${providerId}`;
    const effective: AgentModelConfig = { ...preset.modelConfig, providerId, modelId, keyId };
    const configChanged = !modelConfigsEqual(effective, this.modelConfig);
    const bindingChanged = presetId !== currentPresetId;
    if (!configChanged && !bindingChanged) {
      // Dirty means "re-resolve", not "force regenerate" (ICD §9 W3): the
      // re-resolution above found a byte-identical effective config (key-wise,
      // `keyId` included) and an unchanged binding, so consume the mark
      // without provider churn — a no-op `preset-updated` save must not
      // regenerate provider/model.
      if (this.#presetDirty) this.#presetDirty = false;
      return false;
    }

    // Re-adoption keeps the live config pollution-safe and installs
    // `presetId`/`modelConfig` as own data properties even though the previous
    // config object is non-extensible.
    this.modelConfig = effective;
    this.#adoptConfig({ ...this.#config, modelConfig: { ...effective }, presetId });
    this.#presetDirty = false;
    this.#initProviderAndModel();
    this.updatedAt = Date.now();
    return true;
  }

  /**
   * Re-points a bound agent's `presetId` at the current catalog default
   * (MOD-20 `preset-deleted`).
   *
   * The rewrite is in-memory and turn-start-only: `presetId` is rewritten and
   * the binding marked dirty, but provider/model are not rebuilt, so a deletion
   * landing mid-turn cannot swap the live model. The runtime persists the
   * rewrite through the lifecycle config-update path (or a direct
   * `agent_config_updated` emission for recycled agents).
   *
   * @returns The new bound preset id, or `null` for an unbound agent / an
   *   unusable catalog default
   */
  rebindToDefaultPreset(): string | null {
    const source = this.#presetSource;
    if (!source) return null;
    const defaultPresetId = source.getDefaultPresetId();
    if (typeof defaultPresetId !== 'string' || !defaultPresetId) return null;
    this.#adoptConfig({ ...this.#config, presetId: defaultPresetId });
    this.#presetDirty = true;
    this.updatedAt = Date.now();
    return defaultPresetId;
  }

  /**
   * Whole-object config replacement shared by the prototype and own-instance
   * `config` setters (MOD-21 W10): re-adopts plain data only, so authority
   * fields in the assigned object are ignored and the owner-controlled
   * accessors are reinstalled from private state.
   */
  #setConfigObject(next: unknown) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      const err: CodedError = new Error('Agent config must be assigned a plain object');
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    this.#adoptConfig({ ...next });
  }

  /**
   * Adopts a plain config object as the live config (MOD-21 W10). Authority
   * fields are stripped unconditionally — their state lives in private
   * storage — owner-controlled read-only accessors are reinstalled, and the
   * object is made non-extensible so a hostile caller cannot add an authority
   * key that no accessor shadows.
   *
   * Construction is pollution-safe (MOD-21 W11-A, 556636e): prototype-mutating
   * key names are dropped, and the remaining entries are installed as own data
   * properties via `Object.defineProperty` (never assignment, which would
   * invoke an inherited setter or the `__proto__` mutator).
   */
  #adoptConfig(next: Record<string, unknown>) {
    const clean: Record<string, unknown> = {};
    const keys = Object.keys(next);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (isAuthorityBearingConfigField(key) || isPrototypePollutionKey(key)) continue;
      Object.defineProperty(clean, key, {
        value: next[key],
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
    this.#config = clean;
    this.#installAuthorityAccessors();
    Object.preventExtensions(clean);
  }

  /**
   * Installs getter-only accessors for the owner-controlled fields present in
   * the entity authority state (MOD-21 W10). A field withheld during snapshot
   * hydration never receives an accessor, preserving the hydration contract
   * that hydrates without `allowedTools`/`tools`/parentage own properties.
   */
  #installAuthorityAccessors() {
    const state = this.#authorityState;
    const presence = this.#authorityFieldPresence;
    const descriptors: PropertyDescriptorMap = {};
    for (let i = 0; i < AUTHORITY_CONFIG_PROJECTION_FIELDS.length; i++) {
      const field = AUTHORITY_CONFIG_PROJECTION_FIELDS[i];
      if (!presence[field]) continue;
      descriptors[field] = {
        get: () => (field === 'tools' ? state.allowedTools : state[field]),
        enumerable: true,
        configurable: false
      };
    }
    if (Object.keys(descriptors).length > 0) {
      Object.defineProperties(this.#config, descriptors);
    }
  }

  /**
   * Projects the owner-controlled fields onto the entity instance as
   * non-enumerable getter-only properties (MOD-21 W10). Legacy consumers read
   * `agent.spawnedBy`/`agent.creatorId` (invocationEngine) and `agent.role`;
   * without the projection a direct instance write would re-open the parentage
   * forgery channel.
   */
  #installInstanceAuthorityProjection() {
    const state = this.#authorityState;
    const descriptors: PropertyDescriptorMap = {};
    for (let i = 0; i < AUTHORITY_CONFIG_PROJECTION_FIELDS.length; i++) {
      const field = AUTHORITY_CONFIG_PROJECTION_FIELDS[i];
      descriptors[field] = {
        get: () => (field === 'tools' ? state.allowedTools : state[field]),
        enumerable: false,
        configurable: false
      };
    }
    Object.defineProperties(this, descriptors);
  }

  /**
   * Binds the opaque owner-controlled authority-write channel (MOD-21 W10).
   * First bind wins: a snapshot-hydrated entity is bound by the lifecycle
   * manager before it is exposed through the public registry, so a hostile
   * caller can never claim it with a channel of their own.
   *
   * The prototype descriptor is locked non-writable/non-configurable at module
   * load and the entity instances are non-extensible (MOD-21 W11-A, 18f43d6),
   * so a caller cannot substitute a capture shim for this method; the lifecycle
   * manager additionally invokes the intrinsic
   * `Agent.prototype.bindAuthorityChannel`.
   *
   * @param channel - Opaque channel object (reference identity only)
   * @returns True when this call performed the bind; false when refused (invalid
   *   channel or an earlier bind already owns the entity)
   */
  bindAuthorityChannel(channel: object | null): boolean {
    if (!channel || typeof channel !== 'object') return false;
    if (this.#authorityChannel) return false;
    this.#authorityChannel = channel;
    return true;
  }

  /**
   * Applies authority-bearing configuration through the owner-controlled
   * channel (MOD-21 W10). The entity channel (`updateConfig`) denies these
   * fields outright; this method throws `PERMISSION_DENIED` unless the exact
   * injected channel reference is presented, then snapshots the patch once and
   * installs the owner-controlled projections. Only the lifecycle manager
   * holds the channel.
   *
   * The prototype descriptor is locked non-writable/non-configurable at module
   * load and the entity instances are non-extensible (MOD-21 W11-A, 18f43d6):
   * a hostile prototype or own-property shadow can neither receive the manager
   * channel from the manager nor intercept its authority updates, because the
   * manager dispatches through the intrinsic method reference.
   *
   * @param patch - Authority patch (`privileged`, `allowedTools`/`tools`, `role`, parentage, realm membership)
   * @param channel - The exact channel reference injected at construction/bind time
   * @returns This agent
   * @throws `Error` - With code `'PERMISSION_DENIED'` when the channel does not match
   */
  applyAuthorityConfig(patch: AgentAuthorityPatch, channel: object | null = null): Agent {
    if (!this.#authorityChannel || channel !== this.#authorityChannel) {
      throw createEntityPermissionDeniedError(
        `Permission denied: agent '${this.id}' authority updates require the lifecycle authority channel`
      );
    }
    const update = snapshotCallerObject(patch || {});
    const state = this.#authorityState;
    const presence = this.#authorityFieldPresence;
    if (update.privileged !== undefined) {
      state.privileged = update.privileged === true;
      presence.privileged = true;
    }
    if (update.role !== undefined) {
      state.role = typeof update.role === 'string' ? update.role : '';
      presence.role = true;
    }
    if (update.allowedTools !== undefined || update.tools !== undefined) {
      const rawAllowed = update.allowedTools !== undefined ? update.allowedTools : update.tools;
      state.allowedTools = Object.freeze(normalizeAllowedToolNames(rawAllowed));
      presence.allowedTools = true;
      presence.tools = true;
    }
    if (update.spawnedBy !== undefined) {
      state.spawnedBy = typeof update.spawnedBy === 'string' && update.spawnedBy ? update.spawnedBy : null;
      presence.spawnedBy = true;
    }
    if (update.creatorId !== undefined) {
      state.creatorId = typeof update.creatorId === 'string' && update.creatorId ? update.creatorId : null;
      presence.creatorId = true;
    }
    if (update.realmId !== undefined) {
      state.realmId = typeof update.realmId === 'string' && update.realmId ? update.realmId : null;
      presence.realmId = true;
    }
    this.#adoptConfig(this.#config);
    this.updatedAt = Date.now();
    return this;
  }

  /**
   * Serializes this agent into a pure, plain JSON-serializable snapshot object.
   *
   * Caller-asserted authority fields (`privileged`, `isPrivileged`, `isAdmin`)
   * are dropped from the copied config (MOD-21 W5); the frozen `authority`
   * descriptor is not part of the snapshot contract, so a snapshot can never
   * grant privilege on restore.
   */
  toSnapshot(): SerializedAgent {
    const configCopy = this.config ? JSON.parse(JSON.stringify(this.config)) : { id: this.id };
    stripAuthorityClaims(configCopy);
    return {
      id: this.id,
      name: this.name || this.config?.name || this.id,
      config: configCopy,
      state: this.state || AGENT_STATES.IDLE,
      stateDetail: this.stateDetail || null,
      turnCount: this.turnCount || 0,
      telemetry: this.telemetry ? JSON.parse(JSON.stringify(this.telemetry)) : {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turnCount: 0,
        lastPromptTokens: 0,
        lastCompletionTokens: 0,
        precallCount: 0,
        terminalStops: 0,
        injectedDeliveries: 0,
        lastSentContext: []
      },
      createdAt: this.createdAt || Date.now(),
      updatedAt: this.updatedAt || Date.now(),
      lastSummary: this.lastSummary || null,
      lastError: this.lastError || null,
      lastInterruptedTurn: this.lastInterruptedTurn ? JSON.parse(JSON.stringify(this.lastInterruptedTurn)) : null,
      recycledAt: this.recycledAt || null,
      recycleReason: this.recycleReason || null,
      history: Array.isArray(this.history) ? JSON.parse(JSON.stringify(this.history)) : [],
      redoStack: Array.isArray(this.redoStack) ? JSON.parse(JSON.stringify(this.redoStack)) : [],
      pendingPrecalls: Array.isArray(this.pendingPrecalls) ? JSON.parse(JSON.stringify(this.pendingPrecalls)) : []
    };
  }

  /**
   * Hydrates an Agent instance from a serialized snapshot (entity-owned hydration).
   *
   * Snapshot authority is untrusted (MOD-21 W5/W10): caller-asserted privilege
   * fields are dropped before construction and the authority descriptor is
   * re-derived default-deny (empty `allow`, `visibility: 'owned'`) regardless
   * of the persisted capability selectors and parentage, which are withheld
   * from the hydrated config so neither a legacy tool gate nor a lifecycle
   * parent check can grant from snapshot data (0a87141); an operator
   * grant/repair is the only re-grant path. A boolean `true` claim is recorded
   * on `authorityDowngrade`, and a schema-invalid (non-boolean) claim rejects
   * the snapshot. `lastInterruptedTurn` and `lastError` round-trip unchanged.
   * Realm membership (`config.realmId`) is deliberately **not** withheld: it
   * is a scope constraint rather than a grant, so persisted membership
   * hydrates with the config and remains immutable after launch — no caller,
   * the injected internal principal and the system director identity included,
   * may change it (Realm wave R, ticket 56ba4b9; supersedes the f5d1ccc /
   * f8fc8476 move gate); membership changes only by terminate + relaunch.
   *
   * @param snapshot - Serialized agent snapshot
   * @param deps - Optional dependency overrides; `recycled: true` forces recycle-bin
   *   hydration, `credentialResolver` is forwarded to provider construction so
   *   hydrated agents can resolve vault credentials (serialized secrets are
   *   stripped), and `presetSource` heals the MOD-20 preset binding (a resolving
   *   `presetId` is kept; a missing or stale id binds `getDefaultPresetId()`)
   * @returns A newly constructed Agent hydrated from the snapshot
   * @throws `Error` - With code `'INVALID_CONFIG'` if the snapshot lacks a non-empty string `id`, carries a schema-invalid authority claim, or carries a prototype-polluting config key (`__proto__`/`constructor`/`prototype`, recursively — the direct facade surfaces `ERR_SNAPSHOT_INVALID`)
   * @throws `Error` - With code `'PROVIDER_INIT_FAILED'` if `deps.model` has no resolvable provider
   */
  static fromSnapshot(
    snapshot: SerializedAgent & { role?: string | null },
    deps: {
      model?: ModelInterface | null;
      provider?: ProviderInterface | null;
      credentialResolver?: CredentialResolverPort | null;
      recycled?: boolean;
      presetSource?: ModelPresetSourcePort | null;
    } = {}
  ): Agent {
    if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.id !== 'string' || !snapshot.id.trim()) {
      const err: CodedError = new Error("Agent.fromSnapshot requires a valid snapshot with a string 'id'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    // Canonicalize the identifier at the hydration boundary (1398527/38a64ae):
    // the constructor trims `this.id`, so a padded snapshot id must never
    // survive into `config.id` or an identity/reserved-id comparison could run
    // against a different id than the entity actually uses.
    const canonicalId = snapshot.id.trim();

    const config: Record<string, unknown> = snapshot.config && typeof snapshot.config === 'object'
      ? cloneSerializedConfig(snapshot.config)
      : { id: canonicalId, name: snapshot.name, role: snapshot.role };
    config.id = canonicalId;

    // Prototype-polluting config keys are schema-invalid snapshot data
    // (MOD-21 W11-A, 556636e): the persistence path rejects them on the app
    // restore path (`deepHasPrototypePollution`), and the direct
    // `importSnapshot` facade enforces the same policy here, fail-closed. The
    // clone is a plain data tree, so only own keys are inspected.
    const pollutionKey = findPrototypePollutionKey(config);
    if (pollutionKey) {
      const err: CodedError = new Error(
        `Agent.fromSnapshot rejected prototype-polluting config key '${pollutionKey}'`
      );
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const claims = inspectAuthorityClaims(config);
    if (claims.invalid.length > 0) {
      const err: CodedError = new Error(
        `Agent.fromSnapshot rejected schema-invalid authority claim(s): ${claims.invalid.join(', ')}`
      );
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    stripAuthorityClaims(config);

    // Authority is never restored: withhold every capability selector from the
    // hydrated config so no legacy gate (`turnExecutionEngine` ->
    // `createSandboxToolDispatcher`) can grant from snapshot data. Persisted
    // selectors stay serialized data only; the re-derived descriptor is
    // default-deny until a trusted operator grant supplies new selectors.
    delete config.allowedTools;
    delete config.tools;

    // Snapshot parentage is equally untrusted (MOD-21 W10, 0a87141): lifecycle
    // authorization resolves parent authority from these fields, so a tampered
    // snapshot must never re-grant `killAgent`/`invokeAgent`/`restoreAgent`
    // authority to a named subject. A hydrated agent carries no parent until a
    // trusted operator repair.
    delete config.spawnedBy;
    delete config.creatorId;

    // Realm membership is the deliberate exception (Realm wave A, ticket
    // f5d1ccc): `config.realmId` survives hydration because membership is a
    // scope constraint, not a grant — nothing is authorized by it, and
    // persisted membership must survive a restart. On the hydrated entity it
    // is adopted into owner-controlled private state like every other
    // authority-bearing field; membership is immutable after launch (Realm
    // wave R, ticket 56ba4b9) — no caller, the injected internal principal and
    // the system director identity included, may change it (supersedes the
    // f5d1ccc/f8fc8476 move gate).

    // MOD-20 hydration self-heal: a missing, non-string, or stale preset id is
    // re-pointed at the active catalog default in memory; a resolving id is
    // kept. Persisted state is never rewritten by hydration.
    healSnapshotPresetBinding(config, deps.presetSource);

    const agent = new Agent(
      config as AgentConfig & Record<string, unknown>,
      deps.model || null,
      deps.provider || null,
      deps.credentialResolver || null,
      null,
      deps.presetSource || null
    );

    const isRecycled = deps.recycled === true || snapshot.state === AGENT_STATES.RECYCLED || Boolean(snapshot.recycledAt);

    agent.name = snapshot.name || (config.name as string | undefined) || agent.id;
    agent.state = isRecycled ? AGENT_STATES.RECYCLED : (snapshot.state || AGENT_STATES.IDLE);
    agent.stateDetail = isRecycled
      ? (snapshot.recycleReason || 'Recycled')
      : (snapshot.stateDetail || null);
    agent.createdAt = snapshot.createdAt || Date.now();
    agent.updatedAt = snapshot.updatedAt || Date.now();
    agent.turnCount = typeof snapshot.turnCount === 'number' ? snapshot.turnCount : 0;
    agent.history = Array.isArray(snapshot.history) ? JSON.parse(JSON.stringify(snapshot.history)) : [];
    agent.redoStack = Array.isArray(snapshot.redoStack) ? JSON.parse(JSON.stringify(snapshot.redoStack)) : [];
    agent.pendingPrecalls = Array.isArray(snapshot.pendingPrecalls) ? JSON.parse(JSON.stringify(snapshot.pendingPrecalls)) : [];
    agent.lastSummary = snapshot.lastSummary || null;
    agent.lastError = typeof snapshot.lastError === 'string' && snapshot.lastError
      ? snapshot.lastError
      : null;
    agent.lastInterruptedTurn = snapshot.lastInterruptedTurn
      ? JSON.parse(JSON.stringify(snapshot.lastInterruptedTurn))
      : null;

    if (isRecycled) {
      agent.recycledAt = snapshot.recycledAt || new Date().toISOString();
      agent.recycleReason = snapshot.recycleReason || 'Recycled';
    } else {
      agent.recycledAt = snapshot.recycledAt || null;
      agent.recycleReason = snapshot.recycleReason || null;
    }

    if (snapshot.telemetry && typeof snapshot.telemetry === 'object') {
      agent.telemetry = normalizeAgentTelemetry(snapshot.telemetry);
    }

    ensureHistoryMessageIds(agent.history);

    if (claims.claimed.length > 0) {
      agent.authorityDowngrade = Object.freeze({
        reason: 'SNAPSHOT_AUTHORITY_CLAIM_IGNORED' as const,
        fields: Object.freeze([...claims.claimed]),
        at: Date.now()
      });
    }

    // Authority-bearing config data from a snapshot is untrusted regardless of
    // claim validity: downstream re-derivations (recycle-bin restore, registry
    // registration) must default-deny until a trusted operator grant lands.
    // The static method is inside the class body, so it writes the private
    // provenance state directly; the public reader is getter-only (MOD-21
    // W11-A, 26a65c5).
    agent.#authorityProvenance = 'snapshot';

    return agent;
  }

  /**
   * Replaces this agent's telemetry with a whitelisted metrics snapshot.
   * Only declared `AgentTelemetry` fields are applied (no expandos). Non-object
   * input is ignored; non-finite numeric values become `0`, `lastSentContext`
   * is copied member-wise (defaulting to `[]`), and `updatedAt` is refreshed.
   */
  applyTelemetrySnapshot(snapshot: Partial<AgentTelemetry>): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    this.telemetry = normalizeAgentTelemetry(snapshot);
    this.updatedAt = Date.now();
  }

  /**
   * Clears the diagnostic `lastError` banner without mutating conversational history.
   *
   * @returns True when a previously stored error was cleared, false when already clear.
   *
   * @example
   * ```typescript
   * agent.clearLastError();
   * ```
   */
  clearLastError(): boolean {
    const hadError = this.lastError !== null && this.lastError !== undefined;
    this.lastError = null;
    return hadError;
  }

  /**
   * Updates the bound Model and Provider instances for this agent.
   *
   * @param model - New concrete ModelInterface instance
   * @param provider - New concrete ProviderInterface instance (defaults to `model.provider`)
   * @throws `Error` - With code `'PROVIDER_INIT_FAILED'` if no provider can be resolved
   *
   * @example
   * ```typescript
   * agent.updateModel(newModel, newProvider);
   * ```
   */
  updateModel(model: ModelInterface, provider: ProviderInterface | null = model?.provider || null): void {
    const resolvedProvider = provider || model?.provider || null;
    if (!resolvedProvider) {
      const err: CodedError = new Error('Model update requires an associated provider.');
      err.code = 'PROVIDER_INIT_FAILED';
      throw err;
    }
    this.model = model;
    this.provider = resolvedProvider;
    this.updatedAt = Date.now();
  }

  /**
   * Updates configuration metadata and re-instantiates provider and model bindings if modelConfig changed.
   *
   * MOD-20 bound agents (`ModelPresetSourcePort` injected) are binding-only
   * (OPEN-1) and turn-start-only: a `modelConfig` update is recorded in the
   * non-authoritative cache and marks the binding dirty, and a `presetId`
   * rewrite does the same, but provider/model are re-instantiated only when
   * `materializeEffectiveModel()` runs at the next turn start. Unbound agents
   * keep the legacy immediate provider swap.
   *
   * The entity's frozen `authority` descriptor is built once at construction
   * from trusted config and is never rebuilt or widened by `updateConfig`;
   * registry authority is rebuilt only by `AgentLifecycleManager.updateConfig`
   * under its lifecycle-authority gate (MOD-21). Authority-bearing fields are
   * denied with `PERMISSION_DENIED` (4eaf2cc), and the caller object is
   * snapshotted exactly once before the deny check and merge, so a stateful
   * `Proxy` cannot TOCTOU the gate (MOD-21 W10, 7db884b).
   *
   * @param updates - Configuration updates (may include partial `modelConfig`, `name`, etc.)
   * @param settings - Optional global settings override for model config resolution
   * @throws `Error` - With code `'PERMISSION_DENIED'` when authority-bearing fields are supplied
   *
   * @example
   * ```typescript
   * agent.updateConfig({
   *   name: 'Senior Architect',
   *   modelConfig: { temperature: 0.1 }
   * });
   * ```
   */
  updateConfig(updates: Partial<AgentConfig> = {}, settings: Record<string, unknown> | null = null): void {
    const update = snapshotCallerObject(updates);
    const denied: string[] = [];
    for (let i = 0; i < AUTHORITY_BEARING_UPDATE_FIELDS.length; i++) {
      const field = AUTHORITY_BEARING_UPDATE_FIELDS[i];
      if (update[field] !== undefined) denied[denied.length] = field;
    }
    if (denied.length > 0) {
      throw createEntityPermissionDeniedError(
        `Permission denied: authority-bearing config field(s) '${denied.join("', '")}' require the lifecycle authority gate`
      );
    }
    // The merge is pollution-safe too (MOD-21 W11-A, 556636e): entries are
    // defined as own data properties and prototype-mutating names are dropped.
    const merged: Record<string, unknown> = {};
    const currentKeys = Object.keys(this.#config);
    for (let i = 0; i < currentKeys.length; i++) {
      const key = currentKeys[i];
      Object.defineProperty(merged, key, {
        value: this.#config[key],
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
    const updateKeys = Object.keys(update);
    for (let i = 0; i < updateKeys.length; i++) {
      const key = updateKeys[i];
      if (isAuthorityBearingConfigField(key) || isPrototypePollutionKey(key)) continue;
      Object.defineProperty(merged, key, {
        value: update[key],
        writable: true,
        enumerable: true,
        configurable: true
      });
    }
    this.#adoptConfig(merged);
    if (update.name) {
      this.name = update.name as string;
    }
    if (update.modelConfig) {
      if (this.#presetSource) {
        // MOD-20 W3-B2 (binding-only, OPEN-1): a bound agent's cached
        // `modelConfig` is non-authoritative. The merge above recorded the
        // request in the cache; mark the binding dirty so the next turn start
        // materializes the bound preset instead. Provider/model are never
        // re-instantiated mid-turn.
        this.#presetDirty = true;
      } else {
        this.modelConfig = {
          ...getGlobalModelConfig(settings || this.#config.settings),
          ...(update.modelConfig as Partial<AgentModelConfig> || {})
        };
        this.#config.modelConfig = { ...this.modelConfig };
        this.#initProviderAndModel();
      }
    } else if (this.#presetSource && update.presetId !== undefined) {
      // A binding rewrite (preset switch) is likewise turn-start-only: the
      // merge updated the cache; mark dirty so the next turn re-materializes
      // from the newly bound preset without a mid-turn provider swap.
      this.#presetDirty = true;
    }
    this.updatedAt = Date.now();
  }
}

// MOD-21 W11-A (18f43d6): the authority-write surface is intrinsic-only. The
// lifecycle manager calls these through `Agent.prototype` references, and
// locking the descriptors non-writable/non-configurable keeps a hostile caller
// from substituting a capture shim on the shared prototype. Instance-level
// shadows are blocked by the constructor's `Object.preventExtensions`.
for (const authorityMethodName of ['bindAuthorityChannel', 'applyAuthorityConfig']) {
  const descriptor = Object.getOwnPropertyDescriptor(Agent.prototype, authorityMethodName);
  if (descriptor && typeof descriptor.value === 'function') {
    Object.defineProperty(Agent.prototype, authorityMethodName, {
      value: descriptor.value,
      writable: false,
      enumerable: descriptor.enumerable === true,
      configurable: false
    });
  }
}

// ============================================================================
// 6. Utility Functions
// ============================================================================

/**
 * Generates a unique, collision-free UUID string with a given prefix (INV-MSG-IDENTITY).
 * Uses `crypto.randomUUID()` when available, falling back to timestamp + random entropy.
 *
 * @param prefix - String prefix (defaults to `'msg'`; e.g., `'turn'`, `'sys'`, `'sched'`)
 * @returns Formatted identifier string (e.g., `'msg_01928374-65ab-7cde-8f01-23456789abcd'`)
 *
 * @example
 * ```typescript
 * const messageId = generateMessageId('msg');
 * const turnId = generateMessageId('turn');
 * ```
 */
export function generateMessageId(prefix = 'msg'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Normalizes and backfills deterministic string IDs and reasoning content across message history arrays (INV-MSG-IDENTITY).
 * Operates in-place without overwriting existing non-empty IDs. For assistant messages
 * lacking `reasoning_content`, the value is derived from `reasoning`, then `thought`, else `''`.
 *
 * @param history - Array of conversational history messages; non-array input yields `[]`
 * @returns The same history array with backfilled IDs and normalized reasoning content
 *
 * @example
 * ```typescript
 * const normalizedHistory = ensureHistoryMessageIds(agent.history);
 * ```
 */
export function ensureHistoryMessageIds(
  history: Array<HistoryMessage & { reasoning?: string; thought?: string }>
): HistoryMessage[] {
  if (!Array.isArray(history)) return [];
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (msg && typeof msg === 'object') {
      if (!msg.id || typeof msg.id !== 'string' || !msg.id.trim()) {
        msg.id = generateMessageId(msg.role || 'msg');
      }
      if (msg.role === 'assistant' && (msg.reasoning_content === undefined || msg.reasoning_content === null)) {
        msg.reasoning_content = msg.reasoning ? String(msg.reasoning) : (msg.thought ? String(msg.thought) : '');
      }
    }
  }
  return history;
}

/**
 * Resolves the base model configuration from explicit sandbox settings only.
 * With no explicit settings, falls back to the model-catalog master default;
 * the sandbox never reads host globals.
 *
 * @param explicitSettings - Optional explicit settings container
 * @returns Resolved baseline {@link AgentModelConfig}
 *
 * @example
 * ```typescript
 * const globalConfig = getGlobalModelConfig();
 * ```
 */
export function getGlobalModelConfig(explicitSettings: unknown = null): AgentModelConfig {
  const explicit = explicitSettings as { modelConfig?: AgentModelConfig } | null;
  return explicit?.modelConfig || getDefaultModelConfig();
}
