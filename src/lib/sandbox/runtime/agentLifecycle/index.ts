/**
 * @packageDocumentation
 * Agent Lifecycle Management Subsystem Type Definitions (Module 9: runtime_lifecycle).
 *
 * Owns the runtime agent registry: launch/spawn, the 9-state lifecycle FSM,
 * privilege gating, recycle-bin soft-kill/restore/purge, emergency unsticking,
 * in-flight cancellation, and live configuration synchronization.
 *
 * @module runtime/agentLifecycle
 * @mayImport ../agent/index.ts
 * @mayImport ../../tools/constants/index.ts
 * @mayImport ../../virtualFs/index.ts
 * @mayImport type-only ../../messagingBus/index.ts
 * @mayImport type-only ../../invocationEngine/index.ts
 * @mayImport type-only ../triggerDispatcher/index.ts
 * @mayImport type-only ../index.ts
 * @mayImport type-only ../../credentialVault/index.ts
 * @mayImport type-only ../../presetCatalog/index.ts
 * @invariant INV-2: Lifecycle state is governed by the frozen 9-state transition matrix (`VALID_TRANSITIONS`); an illegal transition throws an Error coded `INVALID_STATE_TRANSITION`, and a missing agent throws `AGENT_NOT_FOUND` before any mutation.
 * @invariant SEC-1 (MOD-21, default-deny): spawn authority derives only from the frozen `AuthorityDescriptor` of the resolved principal (the exact injected `InternalPrincipal` reference, a registry descriptor object, or a registry-resolved `callerAgentId` identity). `config.privileged: true` requires `@lifecycle:authority` (or the wildcard `'*'`); the `realmBypass` grant is composed only on the exact injected `InternalPrincipal` path (engine bootstrap) and can never be claimed by any other caller — a caller-supplied `realmBypass` in a launch/spawn config is ignored. Every agent id is ordinary: `admin`, `director`, and `system` are identifier strings with no reserved meaning. Caller-asserted flags, roles, and id strings grant nothing, and an omitted context is anonymous.
 * @invariant SEC-2: spawned `allowedTools` are clamped to the creator's resolved tool set, and a principal without lifecycle authority can never place `'*'` or `'@lifecycle:authority'` (or any preset alias expanding to them) into the composed whitelist or the frozen registry descriptor — wildcard tool access is capability data, not authority.
 * @invariant SEC-3: a resolved principal without lifecycle authority cannot pin a spawned agent's workspace to an arbitrary key — an explicit `workspaceId`/`workspace` is honored only when it equals the new agent id, the creator's own resolved workspace key, or the creator's bare id (the legacy shared-workspace spelling), and every other pin (reserved `global`/`public`/`realm:<id>:global` keys, peer workspaces) is refused with `PERMISSION_DENIED` before any registration so no partially-launched child exists; authority and internal (host/operator) creators keep full pinning, while principal-less direct engine/host launches (not agent- or tool-reachable) keep the legacy behavior. The confinement also covers the resolved key: for a Realm-bound launch the default resolved key is the canonical `(realmId, agentId)` identity (a declared pin stays verbatim, an ungrouped launch keeps the bare id), and it is refused when any other registered record (active or recycled) resolves to it, when it is the own-id default while a VFS workspace with either the canonical or the legacy bare key already exists, or when it matches the VirtualFS reserved-key predicate (`global`, `public`, `realm:<realmId>:global`) — reserved shapes are always-shadowed regardless of `hasWorkspace`, and a bare id naming a reserved workspace key is refused as well, so a child can neither adopt a peer's/co-claimant's workspace, shadow a pre-existing/orphan one, nor claim a reserved partition before it is allocated, and spawn+self-kill can never destroy bytes the child does not own.
 * @invariant Realm-local identity wiring: every registry, authority descriptor/inputs, and message subscription keys on the canonical `(realmId, agentId)` identity key (`createAgentIdentityKey`), so the same literal id registered in two Realms never shares an entry. Launch/kill/restore/purge register, terminate, unmark, and purge the bus under that key; the mail subscription filter is the same key; `listAgentDescriptors` reads unread counts by key; lookup surfaces (`getAgent`/`getRecycledAgent`/`isAgentTerminated`/`isAgentBusy`/`getAuthorityDescriptor`/`getAuthorityInputs`) resolve a canonical key exactly first and keep the unique-match bare-id rule otherwise; `resolveAgentIdentityKey` exposes the keyed mutation resolution for facade scheduler/invocation teardown; a trusted `callerKey` identity channel resolves callers realm-exactly and a supplied-but-unresolvable key fails closed — the bare id claim is never a fallback, so a stale key can neither retarget another Realm's same-literal-id twin nor degrade to the anonymous host path (mutation targets resolve nothing and `launchAgent` denies with `PERMISSION_DENIED`); and the teardown eviction key is the canonical private workspace for a realm-bound default (`#resolveWorkspaceKey`). A bare id registered in more than one Realm stays ambiguous and fails closed everywhere.
 * @invariant Realm-vocabulary agent ids: `launchAgent` (and therefore `spawnAgent`) refuses any id carrying internal realm vocabulary — a `realm:`/`system:` canonical-key segment or the seeded `realm_generic` registry id — with a uniform generic `PERMISSION_DENIED` for every caller before any authorization, registration, or recycle-bin capture; the denial text never repeats the claim, so it is not a realm-existence oracle. `listAgentDescriptors` omits the `workspace` label when the only available value would echo that vocabulary. Ids stay ordinary otherwise (SEC-1).
 * @invariant INV-AUTH-REGISTRY: each active agent's descriptor is built once at launch/restore from trusted config as a frozen `{subject, kind, allow, visibility, realmBypass}` object and removed on kill/purge/reset; `getAuthorityDescriptor` returns `null` for unknown, recycled, or purged ids, so consumers must default-deny. The registry also owns the frozen authority inputs (`privileged` + capability selector + `realmBypass` grant) that produced the descriptor (`getAuthorityInputs`), which the identity projection reads instead of the live entity config. The `allow` surface is an immutable facade: mutators are hidden, prototype-call forms (`Set.prototype.*.call`) throw, every read is an own indexed loop over the frozen member array with no `Array.prototype` delegation, iteration yields only member strings, and no exposed method (including `forEach`'s third argument) ever hands out the backing collection.
 * @invariant INV-KILL: Soft-kill is a destructive filesystem-eviction capability as well as a registry mutation: it atomically aborts the in-flight turn, clears the promise lock, evicts the target's resolved private workspace key (`config.workspaceId || config.workspace || agent id`, preserving `/global`) only when no other registered record (active or recycled) resolves to that key (last-claimant cleanup), unsubscribes mail, marks the agent terminated on the bus, cancels pending invocations, records `recycledAt`/`recycleReason`, and migrates the agent to the recycle bin; recycled agents never receive reactive trigger wakeups.
 * @invariant INV-RESTORE: Restore migrates a recycled agent back to the active registry in `IDLE` state, clears recycle metadata, re-registers it on the bus, and rewires its mail subscription. A resolved principal is mandatory; restoring a record whose live-construction descriptor would regain authority (`privileged` or wildcard/lifecycle tool selectors) requires lifecycle authority.
 * @invariant INV-PURGE: Purge (single agent or `emptyRecycleBin`) removes the agent from both the active registry and the recycle bin and wipes its bus registrations/inboxes, mail subscription, and resolved private workspace key (`config.workspaceId || config.workspace || agent id`) only when the purged record is that key's last registered claimant (co-claimed workspace bytes survive purge); scheduler-timer teardown is owned by `AgentRuntime` around the call. Both operations are sudoer-only and authorize before any teardown.
 * @invariant INV-LIFECYCLE-GATE (MOD-21, default-deny): every lifecycle mutation (`setAgentState`/`transitionAgentState`, `killAgent`, `restoreAgent`, `purgeAgent`, `emptyRecycleBin`, `unstickAgent`, `cancelAgent`, `cancelAll`, `updateAgentConfig` authority-bearing fields and capability selectors) resolves a trusted principal first. `purgeAgent`/`emptyRecycleBin`/`cancelAll` are sudoer-only; state transition/cancel/unstick admit the sudoer, the registry parent creator, or the agent itself. Engine subsystems run through the composition-root binding to the opaque `InternalPrincipal`.
 * @invariant INV-REALM-GATE: every lifecycle mutation on a target agent — kill/restore/cancel/purge/unstick and `updateAgentConfig` (authority-bearing and ordinary fields alike) — is confined to the caller's Realm scope — `config.realmId` equality, with the bootstrap-only `null` system scope for the engine-launched root director while every other agent resolves a Realm (the seeded Generic default) — and a cross-scope target is denied with `PERMISSION_DENIED` before any mutation, even for lifecycle authority (the wildcard `'*'` included). The exact injected `InternalPrincipal` and an agent holding the registry `realmBypass` grant bypass the gate by principal, never by id; a registered realm-bound caller cannot kill/restore/cancel/purge/unstick/update an agent of another Realm or the system scope, and vice versa. The principal-less host/API path keeps its legacy unscoped semantics (no agent-facing config-update tool exists).
 * @invariant Descriptor visibility Realm scoping: `listAgentDescriptors` layers Realm scope equality on the MOD-21 visibility predicate — a realm-bound caller sees only its own scope plus itself and its registry children; a sudoer sees same-scope members plus itself; an ordinary caller sees same-scope self/children. The `null` system scope is bootstrap-only, so only the engine-launched root director occupies it; invisibility is a consequence of scope equality, never an id clause. The exact injected `InternalPrincipal` and an agent holding the `realmBypass` grant see every descriptor. Anonymous callers still receive `[]`.
 * @invariant Parentage immutability: `spawnedBy`/`creatorId` are authority-bearing config fields — `updateAgentConfig` denies anonymous/unprivileged rewrites with `PERMISSION_DENIED` before any mutation, since `killAgent`/`invokeAgent` treat registered parentage as an authorized-caller relation. At launch, the stored parentage is the RESOLVED creator principal for a resolved non-authority creator — caller-supplied `spawnedBy`/`creatorId` are ignored, so forged parentage confers neither visibility nor parent authority — while a lifecycle-authority principal or a principal-less host/operator launch keeps the explicit composition. The entity config projections are getter-only and the live config is non-extensible, so direct writes/`Object.assign`/replacement cannot graft parentage; snapshot hydration withholds both fields entirely, so a persisted save never re-grants parent authority.
 * @invariant Realm-membership immutability: `realmId` is an authority-bearing config field of the same family as parentage — `launchAgent` composes it from the RESOLVED creator's realm and never from caller-asserted parentage (an explicit caller value is honored only for a lifecycle-authority or principal-less host/operator caller), and `updateAgentConfig` refuses any realm change (`null` included, even a same-value write) with `PERMISSION_DENIED` before any mutation for EVERY caller — the injected `InternalPrincipal` included — because realms are absolute boundaries: membership is fixed at launch and changing it means terminate + relaunch. Every other authority-bearing field keeps the generic lifecycle-authority gate. Launch composition is `config.realmId ?? resolvedCreator.config.realmId ?? realm_generic`, so every ordinary launch lands in a Realm while only the engine bootstrap (the exact `InternalPrincipal` composing an explicit `realmId: null`) keeps the bootstrap-only null system scope; `null` config values fall through for every other caller and never mint an ungrouped agent. Unlike capability selectors and parentage, membership is a scope constraint rather than a grant, so snapshot hydration deliberately keeps `config.realmId` (persisted membership survives a restart) while the entity still projects it read-only from owner-controlled state. `realmBypass` is a grant of the same authority family: it is never caller-settable (launch configs ignore it for every non-engine caller; `updateAgentConfig` denies the key for every caller) and is applied only through the engine bootstrap or the operator grant/revoke API.
 * @invariant Caller-input read-once: `updateAgentConfig` snapshots the caller-supplied object exactly once before the authority gate and the application phase, so a stateful `Proxy` cannot answer the gate with `undefined` and the merge with an authority value. Snapshot entries are defined as own data properties, so an own `__proto__` key cannot mutate the snapshot's prototype.
 * @invariant Authority-channel writes: authority-bearing entity updates are applied exclusively through the manager-owned opaque channel (`Agent#applyAuthorityConfig`); hydrated entities are bound to that channel (`bindAgentAuthorityChannel`, first bind wins) before exposure, and a public entity reference cannot forge it. Every channel-bearing call is intrinsic dispatch — `Agent.prototype.updateConfig`/`Agent.prototype.applyAuthorityConfig`/`Agent.prototype.bindAuthorityChannel` — never a dynamically resolved entity method, so a replaced entity prototype or own-property shadow can neither capture the channel nor run attacker code inside a gated update.
 * @invariant INV-UNSTICK: Unstick synchronously aborts the turn, wipes streaming buffers and the promise lock, transitions to `IDLE` unless the agent is `TERMINATED`/`RECYCLED`, kicks the trigger queue, and emits `stream_reset`.
 * @invariant INV-CONFIG-SYNC: `updateAgentConfig` applies live config mutations in-memory and synchronizes a new system prompt in place at `history[0]` when a system message exists; otherwise it unshifts one only when the new prompt is non-empty (an empty prompt never inserts a system message).
 * @invariant Credential isolation: the injected `CredentialResolverPort` is forwarded to every constructed `Agent`; when absent, agents resolve no credentials — no singleton-vault fallback.
 * @invariant Baked-history seeding (Realm Template Format v1 §5): the unified options object may declare a trusted prologue, validated fail-closed (roles `user`/`assistant` only, non-empty string content, unknown fields rejected with `INVALID_CONFIG` before any registration) and composed as `[system message, ...declared entries in order]` with launch-generated ids (INV-7) and optional `metadata.source='template'`; seeding never runs a turn or a model call, only `initialPrompt` triggers one, and legacy positional launch forms carry no declared history.
 * @invariant Preset binding forwarding (MOD-20): the injected `ModelPresetSourcePort` is forwarded to every `Agent` this manager constructs, and `presetId` survives config composition on launch and update so the binding round-trips unchanged.
 * @decision Launch composition preserves the caller's binding and never invents one: `composedConfig.presetId` is carried only when the caller supplied it, and the default-preset binding for unbound launches is resolved by the runtime/turn path, not by this manager
 * @decision Launch, kill, update, and descriptor-visibility authority is the frozen registry `AuthorityDescriptor` resolved from a trusted principal (rejected as anonymous when absent); caller-asserted `AgentSecurityContext` flags and authority-bearing roles are ignored, and only the `callerAgentId` identity claim is honored through registry resolution
 * @decision `updateAgentConfig` rejects authority-bearing fields (`privileged`, `isAdmin`/`isPrivileged`, `admin`/`system` roles, the parentage fields `spawnedBy`/`creatorId`, the Realm membership field `realmId`, and capability selectors whose resolved allow set carries the wildcard `'*'` or `@lifecycle:authority` — `allowedTools`/`tools`/`toolPreset`/`role` aliases included) with `PERMISSION_DENIED` unless the caller principal holds `@lifecycle:authority`; authority edits are operator-API-only. Realm membership is strictly immutable: any `realmId` key is denied for every caller before the authority verdict — the injected `InternalPrincipal` included — so membership changes only by terminate + relaunch into the target realm. The `realmBypass` key is likewise denied for every caller before the authority verdict; grants are applied only through the engine bootstrap or the operator grant/revoke API
 * @decision `realmBypass` is a revocable operator/engine grant recorded in the frozen registry authority inputs (`AuthorityInputRecord.realmBypass`) and rebuilt into the `AuthorityDescriptor`; `grantRealmBypass`/`revokeRealmBypass` accept only the exact injected `InternalPrincipal` reference and only active agents, emit an audit event, and never move Realm membership or touch the capability axis. Killing/purging drops the grant with the authority inputs, so a recycled record carries no grant; hydration restores grants only through the composition root's `restoreRealmBypassGrants`
 * @invariant INV-META-AUTHORITY: the explicit publishing authorities `@template:authority`/`@hydration:authority` are revocable operator/engine grants recorded in the frozen registry authority inputs (`AuthorityInputRecord.templateAuthority`/`hydrationAuthority`) and rebuilt into the `AuthorityDescriptor` allow set as the exact ids; `grantTemplateAuthority`/`revokeTemplateAuthority`/`grantHydrationAuthority`/`revokeHydrationAuthority` accept only the exact injected `InternalPrincipal` reference and only active agents, emit audit events (`template_authority_granted`/`revoked`, `hydration_authority_granted`/`revoked`), and never touch the scope axis or the capability selector axis. The root system director is engine-composed with both grants on the bootstrap path. Killing/purging drops the grants with the authority inputs, so a recycled record carries none; hydration restores them only through the composition-root `restoreMetaAuthorityGrants`. The wildcard `'*'` and `privileged` never imply either authority, and no selector path (launch, spawn, `reauthorizeAgent`, `updateAgentConfig`) can place the ids
 * @decision Registry-owned authority inputs (`privileged` + capability selector) are the identity projection source of truth; the live entity config is a getter-only projection for the uneditable legacy consumers only
 * @decision The injected `SubsystemEmitPort` replaces `runtime._emit` reach-backs and their `typeof` guards; the manager emits only through the port (or the `runtime.createSubsystemEmitPort()` fallback)
 * @decision `killAgent` throws an Error coded `NOT_FOUND` for an unknown agent instead of returning a null sentinel; an already-recycled id returns that agent idempotently
 * @decision Lifecycle operations, including the `whoami`/`undoAgentTurn` surface, are consumed through the frozen `LifecyclePort` facade rather than direct manager reaches
 * @decision MOD-21 closes the wildcard-authority, allow-set leak, parentage-forgery, and ungated-mutation findings: capability sanitization at spawn, an immutable `allow` facade, parentage as an authority-bearing field, and a mandatory principal on every lifecycle mutation with the composition-root `InternalPrincipal` for engine paths
 * @decision Lifecycle teardown is a destructive filesystem-eviction capability, not a registry mutation only: `killAgent` and `purgeAgent` delete the target's resolved VirtualFS workspace key (`config.workspaceId || config.workspace || agent id`) through the engine-bound internal principal. Eviction authority is therefore relationship-based — lifecycle authority (sudoer), registered parent creator, or the agent itself for kill; sudoer-only for purge — and never a caller write/delete tool grant; a workspace named after the raw lookup id is never the eviction target when the agent was launched into an explicit workspace
 * @decision Spawn/launch workspace pinning is authority-gated for attributable callers: only a lifecycle-authority (or internal/operator) creator may compose an arbitrary child `workspaceId`; a resolved non-authority creator is confined to the child's own id or its own resolved workspace, so spawn+kill can never be used to evict a reserved (`global`/`public`/`realm:<id>:global`) or foreign workspace, while principal-less direct engine/host launches keep the legacy behavior
 * @decision Lifecycle workspace claims are resolution-based, never configured: every registered record (active or recycled) claims the key teardown would resolve for it — an explicit pin verbatim, else the canonical `(realmId, agentId)` identity key for a Realm-bound record, else the legacy bare id. A non-authority launch refuses a resolved key claimed by any record other than the creator or the new agent, and refuses an own-id default that already exists in the VFS (canonical or legacy bare key; no shadowing of pre-existing/orphan workspaces); kill/purge/`emptyRecycleBin` evict a resolved key only for its last registered claimant, so creator-shared child workspaces and co-claimed keys survive until the final claimant is torn down
 * @decision Reserved workspace-key shapes (`global`, `public`, `realm:<realmId>:global`) are always-shadowed for a resolved non-authority launch: the gate consults the VirtualFS-exported reserved-key predicate on the resolved key (`workspaceId || workspace || agentId`) and denies with `PERMISSION_DENIED` before registration or recycle-bin capture, independent of `hasWorkspace`, so a reserved partition can never be claimed before it is allocated; authority/internal/principal-less pinning to reserved keys is unchanged
 */

import {
  Agent,
  AGENT_STATES,
  createAgentIdentityKey,
  generateMessageId,
  ensureHistoryMessageIds,
  parseAgentIdentityKey
} from '../agent/index.ts';
import type {
  AgentAuthorityPatch,
  AgentConfig,
  AgentDescriptor,
  AgentIdentityDescriptor,
  AgentSecurityContext,
  AgentState,
  HistoryMessage,
  LaunchAgentOptions,
  LaunchHistoryEntry
} from '../agent/index.ts';
import { resolveToolPreset, TOOL_PRESETS } from '../../tools/constants/index.ts';
import { AGENT_AUTHORITIES } from '../../realmCatalog/index.ts';
import { isReservedWorkspaceKey } from '../../virtualFs/index.ts';
import type { VirtualFS } from '../../virtualFs/index.ts';
import type { MessagingBus } from '../../messagingBus/index.ts';
import type { InvocationEngine } from '../../invocationEngine/index.ts';
import type { AuthorityDescriptor, InternalPrincipal, SubsystemEmitPort } from '../index.ts';
import type { TriggerDispatcher } from '../triggerDispatcher/index.ts';
import type { CredentialResolverPort } from '../../credentialVault/index.ts';
import type { ModelPresetSourcePort } from '../../presetCatalog/index.ts';

export type {
  Agent,
  AgentConfig,
  AgentState,
  AgentSecurityContext,
  AgentIdentityDescriptor,
  AgentDescriptor,
  LaunchAgentOptions,
  LaunchHistoryEntry
} from '../agent/index.ts';

export { AGENT_STATES };

/**
 * Error carrying an optional machine-readable lifecycle error code.
 * @internal
 */
type CodedError = Error & { code?: string };

/**
 * Resolved trusted principal: the opaque composition-root `InternalPrincipal`
 * reference or a frozen registry `AuthorityDescriptor`. Anonymous callers
 * resolve to `null`.
 * @internal
 */
type LifecyclePrincipal = InternalPrincipal | AuthorityDescriptor;

/**
 * Legacy positional model value (`launchAgent(config, model)`): the facade
 * contract declares the position `unknown`; the entity constructor is the
 * shape authority for whatever is forwarded.
 * @internal
 */
type LaunchModel = Exclude<LaunchAgentOptions['model'], undefined>;

/**
 * Legacy positional provider value (`launchAgent(config, model, provider)`).
 * @internal
 */
type LaunchProvider = Exclude<LaunchAgentOptions['provider'], undefined>;

/**
 * Internal runtime event envelope emitted by this manager. The injected
 * `SubsystemEmitPort` owns delivery; the manager forwards envelopes as-is and
 * never stamps a `timestamp` of its own.
 * @internal
 */
interface LifecycleEvent {
  type: string;
  agentId?: string;
  payload?: unknown;
}

/**
 * Emit port as consumed by this manager: the canonical `SubsystemEmitPort`
 * (or the `runtime.createSubsystemEmitPort()` fallback) is accepted and only
 * `emit` is ever called.
 * @internal
 */
interface LifecycleEmitPort {
  emit(event: LifecycleEvent): void;
}

/**
 * Structural view of the `AgentRuntime` facade members this manager uses. The
 * `runtime` option is publicly declared `unknown` and partial duck-typed hosts
 * are supported, so every member is optional.
 * @internal
 */
interface LifecycleRuntimeHost {
  messagingBus?: MessagingBus | null;
  virtualFs?: VirtualFS | null;
  invocationEngine?: InvocationEngine | null;
  triggerQueue?: { processTick(): Promise<unknown> } | null;
  executeAgentTurn?: (agentId: string, input: unknown) => Promise<unknown>;
  enqueueUserTurn?: (agentId: string, input: unknown) => Promise<unknown>;
  purgeAgent?: (agentId: string, callerContext?: unknown) => boolean;
  createSubsystemEmitPort?: () => SubsystemEmitPort;
}

/**
 * Legacy positional launch payload (`launchAgent(config, arg2, arg3, arg4)`).
 * Values are caller-supplied and unvalidated; the entity constructor is the
 * shape authority.
 * @internal
 */
interface LegacyLaunchArgument {
  model?: LaunchModel;
  provider?: LaunchProvider;
  initialPrompt?: string | null;
  callerContext?: AgentSecurityContext | null;
  principal?: LifecyclePrincipal | null;
}

/**
 * Unified first-argument shape of `launchAgent`: the options form
 * (`{ config, model, provider, initialPrompt, callerContext, principal }`) or a
 * flat legacy config that may carry ad-hoc `model`/`provider`/`principal`.
 * @internal
 */
interface LaunchConfigInput extends Partial<AgentConfig> {
  config?: AgentConfig | null;
  model?: LaunchModel;
  provider?: LaunchProvider;
  initialPrompt?: string | null;
  callerContext?: AgentSecurityContext | null;
  principal?: LifecyclePrincipal | null;
  /**
   * Trusted baked-history entries read from the unified options object only
   * (Wave T, ticket 7e6edae). Validated fail-closed by
   * {@link normalizeLaunchHistory}; legacy positional launch forms never
   * carry them.
   */
  history?: readonly LaunchHistoryEntry[] | null;
  /**
   * Engine-path `realmBypass` grant composition (Wave I, ticket c02d0b9).
   * Honored only when the resolved principal is the exact injected
   * `InternalPrincipal`; ignored for every other caller.
   */
  realmBypass?: boolean;
  /**
   * Engine-path `@template:authority` publishing grant composition (Wave U,
   * ticket 2518510). Honored only when the resolved principal is the exact
   * injected `InternalPrincipal` (the root system director bootstrap); ignored
   * for every other caller.
   */
  templateAuthority?: boolean;
  /**
   * Engine-path `@hydration:authority` publishing grant composition (Wave U,
   * ticket 2518510). Honored only when the resolved principal is the exact
   * injected `InternalPrincipal` (the root system director bootstrap); ignored
   * for every other caller.
   */
  hydrationAuthority?: boolean;
}

/**
 * Plain-data snapshot of a caller-supplied config-update object (MOD-21 W10).
 * Known `AgentConfig` fields keep their declared types; legacy authority
 * aliases (`isAdmin`/`isPrivileged`) and any other caller keys remain reachable
 * as `unknown` through the index signature.
 * @internal
 */
interface ConfigUpdateSnapshot extends Partial<AgentConfig> {
  [key: string]: unknown;
}

/**
 * Narrows an unknown value to a plain own-property record for dynamic reads.
 * @internal
 */
function isObjectLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

/**
 * Adopts the opaque `runtime` constructor option as the structural host view
 * this manager duck-types. Non-object hosts behave exactly as before (all
 * member reads fall back to `undefined`).
 * @internal
 */
function toLifecycleRuntimeHost(value: unknown): LifecycleRuntimeHost | null {
  return isObjectLike(value) ? (value as LifecycleRuntimeHost) : null;
}

/**
 * Names the documented legacy positional launch fields of an object argument.
 * Field values remain unvalidated.
 * @internal
 */
function asLegacyLaunchArgument(value: object): LegacyLaunchArgument {
  return value as LegacyLaunchArgument;
}

/**
 * Adopts the opaque positional model value per the documented legacy contract.
 * @internal
 */
function asLaunchModel(value: unknown): LaunchModel {
  return (value as LaunchModel) || null;
}

/**
 * Adopts the opaque positional provider value per the documented legacy contract.
 * @internal
 */
function asLaunchProvider(value: unknown): LaunchProvider {
  return (value as LaunchProvider) || null;
}

/**
 * Builds a coded validation error for the `history` launch option.
 * @internal
 */
function invalidLaunchHistoryError(detail: string): CodedError {
  const err: CodedError = new Error(`launchAgent 'history' option is invalid: ${detail}`);
  err.code = 'INVALID_CONFIG';
  return err;
}

/**
 * Narrows an unknown value to a declared baked-history role.
 * @internal
 */
function isLaunchHistoryRole(value: unknown): value is 'user' | 'assistant' {
  return value === 'user' || value === 'assistant';
}

/**
 * Validates and defensively copies declared baked-history entries (Realm
 * Template Format v1 §3.5; Wave T, ticket 7e6edae).
 *
 * Fail-closed contract: `undefined`/`null` declare no entries; anything else
 * must be an array of plain objects carrying only `role`, `content`, and the
 * optional `source`. Roles are restricted to `'user'`/`'assistant'` (the
 * system message is the composed prompt, never a declared entry), `content`
 * must be a non-empty string, `source` must be `'template'` when present, and
 * an unknown field — a caller-supplied `id`/`metadata` included — rejects the
 * launch with `INVALID_CONFIG` before any registration. Caller objects are
 * copied so later mutation cannot alter the seeded history.
 *
 * @param value - Raw `history` option value from the unified options object
 * @returns Defensive copy of the validated entries (empty when none declared)
 * @throws `Error` - With code `'INVALID_CONFIG'` when the value is not a
 *   conforming `LaunchHistoryEntry` array
 * @internal
 */
function normalizeLaunchHistory(value: unknown): readonly LaunchHistoryEntry[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw invalidLaunchHistoryError('expected an array of { role, content, source? } entries');
  }
  const entries: LaunchHistoryEntry[] = [];
  for (let index = 0; index < value.length; index++) {
    const raw: unknown = value[index];
    if (!isObjectLike(raw) || Array.isArray(raw)) {
      throw invalidLaunchHistoryError(`entry ${index} must be a plain object`);
    }
    for (const key of Object.keys(raw)) {
      if (key !== 'role' && key !== 'content' && key !== 'source') {
        throw invalidLaunchHistoryError(`entry ${index} has unknown field '${key}'`);
      }
    }
    const role: unknown = raw.role;
    const content: unknown = raw.content;
    const source: unknown = raw.source;
    if (!isLaunchHistoryRole(role)) {
      throw invalidLaunchHistoryError(`entry ${index} role must be 'user' or 'assistant'`);
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw invalidLaunchHistoryError(`entry ${index} content must be a non-empty string`);
    }
    if (source !== undefined && source !== 'template') {
      throw invalidLaunchHistoryError(`entry ${index} source must be 'template' when present`);
    }
    entries.push(source === 'template'
      ? { role, content, source: 'template' }
      : { role, content });
  }
  return entries;
}

// ============================================================================
// 1. Manager Options Specification
// ============================================================================

/**
 * Options for instantiating {@link AgentLifecycleManager}.
 *
 * Supports dependency injection of runtime subsystems, enabling clean isolation
 * and mockability in headless or testing environments.
 *
 * @example
 * ```typescript
 * const options: AgentLifecycleManagerOptions = {
 *   runtime: agentRuntime,
 *   messagingBus: messagingBusInstance,
 *   virtualFs: virtualFsInstance,
 *   invocationEngine: invocationEngineInstance
 * };
 * const lifecycleManager = new AgentLifecycleManager(options);
 * ```
 */
export interface AgentLifecycleManagerOptions {
  /** Back-reference to the parent AgentRuntime coordinator */
  runtime?: unknown;
  /** Injected canonical {@link SubsystemEmitPort}; falls back to `runtime.createSubsystemEmitPort()` */
  emit?: SubsystemEmitPort | null;
  /** Injected mail-subscription port implemented by {@link TriggerDispatcher} (`setupAgentMailSubscription`) */
  triggerDispatcher?: Pick<TriggerDispatcher, 'setupAgentMailSubscription'> | null;
  /** Shared MessagingBus instance for cross-agent communication */
  messagingBus?: MessagingBus | null;
  /** Shared VirtualFS instance for private workspace isolation */
  virtualFs?: VirtualFS | null;
  /** Standalone InvocationEngine for child agent sub-invocations */
  invocationEngine?: InvocationEngine | null;
  /** Active agents registry map */
  agents?: Map<string, Agent> | null;
  /** Soft-killed recycled agents map */
  recycleBin?: Map<string, Agent> | null;
  /** Active message subscriptions unsubscribe handlers map */
  messageSubscriptions?: Map<string, () => void> | null;
  /**
   * Optional read-only credential resolver (MOD-16) forwarded to every
   * `Agent` constructed by this manager. When absent, agents resolve no
   * credentials (no singleton vault fallback).
   */
  credentialResolver?: CredentialResolverPort | null;
  /**
   * Optional MOD-20 preset-source projection forwarded to every `Agent` this
   * manager constructs. When absent, agents keep the legacy model-config
   * resolution blend and no preset binding is materialized.
   */
  presetSource?: ModelPresetSourcePort | null;
  /**
   * Opaque engine principal injected by the composition root. Only this exact
   * frozen reference is trusted for lifecycle authority; a plain object with
   * the same shape is anonymous.
   */
  internalPrincipal?: InternalPrincipal | null;
}

/**
 * Frozen registry-owned authority input record (MOD-21 W10, 5b585b7): the
 * trusted `privileged` flag and normalized capability selector that produced
 * the active `AuthorityDescriptor`. Identity projections read this record
 * instead of the live entity config; entries are removed with the descriptor.
 */
export interface AuthorityInputRecord {
  /** Trusted privilege flag the descriptor was built from */
  readonly privileged: boolean;
  /** Normalized capability selector (`null` when none was supplied) */
  readonly allowedTools: readonly string[] | null;
  /**
   * Whether the `realmBypass` grant is active (Wave I, ticket c02d0b9).
   * Composed only on the engine bootstrap path or through the operator
   * grant/revoke API; never from a launch/spawn/update caller value.
   */
  readonly realmBypass: boolean;
  /**
   * Whether the explicit `@template:authority` publishing grant is active
   * (Wave U, ticket 2518510). Recorded only through the operator grant/revoke
   * API (or the engine bootstrap for the root system director) and rebuilt
   * into the descriptor's allow set; a capability selector can never place
   * the authority string.
   */
  readonly templateAuthority: boolean;
  /**
   * Whether the explicit `@hydration:authority` publishing grant is active
   * (Wave U, ticket 2518510). Recorded only through the operator grant/revoke
   * API (or the engine bootstrap for the root system director) and rebuilt
   * into the descriptor's allow set.
   */
  readonly hydrationAuthority: boolean;
}

/**
 * Canonical lifecycle authority capability. A principal whose frozen
 * `allow` set contains this op (or the wildcard `'*'`) may spawn privileged
 * agents and mutate authority-bearing agent config. The `realmBypass` grant
 * is never reachable through this capability — it requires the exact injected
 * `InternalPrincipal` reference (Wave I, ticket c02d0b9).
 * @internal
 */
const LIFECYCLE_AUTHORITY_CAPABILITY = '@lifecycle:authority';

/**
 * Fixed id of the seeded default Realm ("Generic", Wave R ticket 56ba4b9):
 * every non-director launch without an explicit or inherited membership lands
 * in it. The store seeds the matching registry record (`realm_generic`,
 * display "Generic", renamable, non-deletable); the literal is mirrored here
 * because the runtime must not import the composition root, and the equality
 * is pinned by the store/lifecycle suites.
 * @internal
 */
const GENERIC_REALM_ID = 'realm_generic';

/**
 * Internal realm vocabulary denied in agent identifiers (Wave I, ticket
 * d57cbc1; folded defect eab4e51): the canonical-key segments (`realm:` /
 * `system:`) and the engine-known reachable realm-registry id (`realm_generic`,
 * the seeded Generic default mirrored as `GENERIC_REALM_ID`). An identifier
 * carrying this vocabulary would echo internal scope state onto agent-visible
 * receipts, listings, and paths, so launch and spawn reject it with a uniform
 * denial that never repeats the claim (no existence oracle; every caller,
 * host/operator included, is refused). The predicate is lexical only — the
 * runtime never consults realm state, so the denial cannot reveal whether a
 * realm exists.
 * @internal
 */
const REALM_VOCABULARY_ID_PATTERN = /realm:|^system:/;

/**
 * Tests whether an agent identifier carries internal realm vocabulary.
 *
 * @param agentId - Candidate realm-local agent identifier.
 * @returns True when the id must be refused as realm vocabulary.
 * @internal
 */
function isRealmVocabularyId(agentId: string): boolean {
  if (typeof agentId !== 'string' || !agentId) return false;
  return REALM_VOCABULARY_ID_PATTERN.test(agentId) || agentId === GENERIC_REALM_ID;
}

/**
 * Authority-bearing config fields. The entity channel (`Agent#updateConfig`)
 * denies every one of them outright (4eaf2cc); the gated manager strips them
 * before delegating the non-authority merge and remains their only writer.
 * @internal
 */
const AUTHORITY_UPDATE_FIELDS: ReadonlyArray<string> = Object.freeze([
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
  'realmBypass',
  'templateAuthority',
  'hydrationAuthority'
]);

/**
 * Builds a frozen, duplicate-free member-name copy using indexed reads only.
 * `Array.prototype` methods are in-realm patchable, so the authority facade
 * must never route its backing-data construction through them (MOD-21 W10,
 * 4300b06).
 *
 * @param names - Candidate member names to freeze.
 * @returns A frozen, duplicate-free member-name copy.
 * @internal
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
 * Explicit publishing-authority ids (Wave U, ticket 2518510) that are never
 * selectable capability data: a launch/spawn/update selector can never place
 * them into the composed allowlist or the frozen descriptor. Grants are
 * recorded only through the dedicated operator API or the engine bootstrap.
 * @internal
 */
const META_AUTHORITY_IDS: ReadonlySet<string> = new Set<string>([
  AGENT_AUTHORITIES.TEMPLATE,
  AGENT_AUTHORITIES.HYDRATION
]);

/**
 * Normalizes trusted authority-input selector data for the registry record
 * (MOD-21 W10). Uses indexed reads only; `null` means "no selector supplied".
 * Publishing-authority strings are stripped: they are grants, never selector
 * capability data (Wave U, ticket 2518510).
 *
 * @param allowedTools - Trusted capability selector.
 * @returns Normalized member names, or `null` when no selector was supplied.
 * @internal
 */
function normalizeAuthorityInputAllowedTools(allowedTools: unknown): ReadonlyArray<string> | null {
  if (allowedTools === '*') return Object.freeze(['*']);
  if (!Array.isArray(allowedTools)) return null;
  const members = freezeAuthorityMemberNames(allowedTools);
  const filtered: string[] = [];
  for (let i = 0; i < members.length; i++) {
    if (!META_AUTHORITY_IDS.has(members[i])) filtered[filtered.length] = members[i];
  }
  return Object.freeze(filtered);
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
 *
 * @param input - Caller-supplied object to snapshot.
 * @returns A plain-data snapshot of the caller object's own properties.
 * @internal
 */
function snapshotCallerObject(input: unknown): ConfigUpdateSnapshot {
  const snapshot: ConfigUpdateSnapshot = {};
  if (!isObjectLike(input)) return snapshot;
  const source = input;
  const keys = Object.keys(source);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    Object.defineProperty(snapshot, key, {
      value: 'value' in descriptor ? descriptor.value : source[key],
      writable: true,
      enumerable: true,
      configurable: true
    });
  }
  return snapshot;
}

/**
 * Builds a genuinely immutable `ReadonlySet` facade for an authority
 * descriptor's `allow` set. `Object.freeze(new Set())` does not block `add`,
 * so the facade is a frozen plain object built over a snapshot of the member
 * names: every read (`has`, `size`, `values`, `keys`, `entries`, iteration,
 * `forEach`) is an own indexed closure over that private array, and
 * `add`/`delete`/`clear` are neutralized.
 *
 * The facade keeps `Set.prototype` as its prototype so `instanceof Set`
 * consumers keep working, but it never delegates a read to the prototype:
 * the backing data is a closure-scoped array, so patching a `Set.prototype`
 * read method (adf6cf0) can neither capture nor widen membership. Every read
 * is also independent of `Array.prototype` (MOD-21 W10, 4300b06): membership,
 * iteration and pair production are own indexed loops, so patched
 * `Array.prototype.includes`/`map`/`[Symbol.iterator]` cannot widen the
 * allow-set. Prototype mutation forms (`Set.prototype.add.call(allow, ...)`)
 * throw because the facade has no `[[SetData]]` internal slot, and `forEach`
 * passes the frozen facade itself as the callback's third argument (16a8489),
 * so no exposed method ever hands out the backing collection.
 *
 * @param names - Candidate member names.
 * @returns A frozen immutable `ReadonlySet` facade over a private member snapshot.
 * @internal
 */
function createReadonlyAllowSet(names: unknown): ReadonlySet<string> {
  const members = freezeAuthorityMemberNames(names);
  const buildIterator = (entries: boolean): IterableIterator<string | string[]> => {
    let index = 0;
    const iterator: IterableIterator<string | string[]> = {
      next() {
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
    has(value: unknown) {
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
    forEach(callback: (value: string, key: string, set: unknown) => void, thisArg?: unknown) {
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
  return Object.freeze(facade) as unknown as ReadonlySet<string>;
}

/**
 * Builds a frozen agent `AuthorityDescriptor` from trusted construction input.
 *
 * The capability axis (`privileged`/`allowedTools` → `allow`, wildcard and
 * lifecycle capability) and the scope axis (`realmBypass` → `visibility: 'all'`)
 * are orthogonal: a wildcard agent without the grant stays `'self'`-scoped, and
 * a granted agent keeps its capability set while spanning every Realm (Wave I,
 * ticket c02d0b9).
 *
 * Wave U publishing authorities (ticket 2518510) are explicit-only capability
 * data: `templateAuthority`/`hydrationAuthority` flags append the exact
 * `@template:authority`/`@hydration:authority` ids to the allow set, while the
 * selector-derived members are stripped of those ids, so only the dedicated
 * grant API (or the engine bootstrap) can ever place them. The wildcard `'*'`
 * never implies a publishing authority — the tool gate checks the exact id.
 *
 * @param subject - Principal subject (agent id).
 * @param options - Trusted privilege flag, capability selector, bypass grant, and publishing-authority flags.
 * @returns The frozen authority descriptor.
 * @internal
 */
function createAgentAuthorityDescriptor(
  subject: string,
  {
    privileged = false,
    allowedTools = null,
    realmBypass = false,
    templateAuthority = false,
    hydrationAuthority = false
  }: {
    privileged?: boolean;
    allowedTools?: string[] | '*' | null;
    realmBypass?: boolean;
    templateAuthority?: boolean;
    hydrationAuthority?: boolean;
  } = {}
): AuthorityDescriptor {
  let names: string[];
  if (privileged) {
    names = ['*'];
  } else if (Array.isArray(allowedTools)) {
    names = [...(normalizeAuthorityInputAllowedTools(allowedTools) ?? [])];
  } else {
    names = allowedTools === '*' ? ['*'] : [];
  }
  const authoritativeNames: string[] = [...names];
  if (templateAuthority === true) authoritativeNames[authoritativeNames.length] = AGENT_AUTHORITIES.TEMPLATE;
  if (hydrationAuthority === true) authoritativeNames[authoritativeNames.length] = AGENT_AUTHORITIES.HYDRATION;
  return Object.freeze({
    subject,
    kind: 'agent',
    allow: createReadonlyAllowSet(authoritativeNames),
    visibility: (privileged || realmBypass) ? 'all' : 'self',
    realmBypass: realmBypass === true
  });
}

/**
 * Tests whether a resolved principal holds lifecycle authority: engine-internal
 * principals always do; agent descriptors holding the wildcard `'*'` or the
 * explicit `@lifecycle:authority` capability do.
 *
 * @param principal - Resolved principal, or `null` when anonymous.
 * @returns True when the principal holds lifecycle authority.
 * @internal
 */
function principalHasLifecycleAuthority(principal: { kind?: string; allow?: ReadonlySet<string> } | null): boolean {
  if (!principal || typeof principal !== 'object') return false;
  if (principal.kind === 'internal') return true;
  const allow = principal.allow;
  return Boolean(allow && (allow.has('*') || allow.has(LIFECYCLE_AUTHORITY_CAPABILITY)));
}

/**
 * PermissionDeniedError
 * @internal
 */
class PermissionDeniedError extends Error {
  code: string;

  workspaceId: string | null;

  callerAgentId: string | null;

  filePath: string | null;

  /**
   * Constructs a new AgentLifecycleManager coordinator instance.
   *
   * @param options - Optional subsystem dependencies and registry maps
   *
   * @example
   * ```typescript
   * const manager = new AgentLifecycleManager({ messagingBus, virtualFs });
   * ```
   */

  constructor(
    message: string,
    details: { code?: string; workspaceId?: string | null; callerAgentId?: string | null; filePath?: string | null; requestedId?: string } = {}
  ) {
    super(message);
    this.name = 'PermissionDeniedError';
    this.code = details.code || 'PERMISSION_DENIED';
    this.workspaceId = details.workspaceId || null;
    this.callerAgentId = details.callerAgentId || null;
    this.filePath = details.filePath || null;
  }
}

/**
 * Valid state transitions mapping for INV-STATE validation.
 * Private internal implementation invariant.
 */
const VALID_TRANSITIONS: Record<string, string[]> = Object.freeze({
  idle: ['running', 'idle', 'terminated', 'recycled'],
  running: ['idle', 'waiting_for_input', 'waiting_for_dependents', 'waiting_for_message', 'canceling', 'errored', 'running', 'terminated', 'recycled'],
  waiting_for_input: ['running', 'idle', 'canceling', 'errored', 'terminated', 'recycled'],
  waiting_for_dependents: ['running', 'idle', 'canceling', 'errored', 'terminated', 'recycled'],
  waiting_for_message: ['running', 'idle', 'waiting_for_message', 'canceling', 'errored', 'terminated', 'recycled'],
  canceling: ['idle', 'errored', 'terminated', 'recycled'],
  errored: ['idle', 'running', 'terminated', 'recycled'],
  terminated: ['idle', 'running', 'recycled'],
  recycled: ['idle', 'terminated', 'recycled']
});

/**
 * Agent Lifecycle Management Subsystem (Module 9: runtime_lifecycle).
 *
 * Coordinates the full lifecycle of autonomous agents: registration, 9-state formal FSM
 * transitions, privilege escalation verification, reactive mailbox subscriptions, soft-kill
 * recycling, workspace eviction, restoration, permanent purging, emergency unsticking, and live
 * configuration synchronization.
 *
 * Architectural Invariants:
 * - INV-2: Encapsulated Finite State Machine Governance.
 * - SEC-1 & SEC-2: Universal Privilege Escalation Prevention.
 * - INV-KILL & INV-PURGE: Atomic Subsystem Teardown.
 * - INV-CONFIG-SYNC: Synchronous Live System Prompt Synchronization.
 *
 * @example
 * ```typescript
 * import { AgentLifecycleManager } from './agentLifecycle/index.ts';
 *
 * const lifecycle = new AgentLifecycleManager({ runtime: agentRuntime });
 * const agent = await lifecycle.launchAgent({
 *   config: {
 *     id: 'story-architect',
 *     name: 'Story Architect',
 *     role: 'director',
 *     systemPrompt: 'You design multi-chapter adventure narratives.',
 *     privileged: true
 *   }
 * });
 * console.log(`Launched agent ${agent.id} in state ${agent.state}`);
 * ```
 */
export class AgentLifecycleManager {
  #runtime: LifecycleRuntimeHost | null = null;

  #messagingBus: MessagingBus | null = null;

  #virtualFs: VirtualFS | null = null;

  #invocationEngine: InvocationEngine | null = null;

  #agents: Map<string, Agent>;

  #recycleBin: Map<string, Agent>;

  #messageSubscriptions: Map<string, () => void>;

  #emitPort: LifecycleEmitPort | null;

  #mailPort: Pick<TriggerDispatcher, 'setupAgentMailSubscription'> | null;

  #credentialResolver: CredentialResolverPort | null = null;

  #presetSource: ModelPresetSourcePort | null = null;

  #internalPrincipal: InternalPrincipal | null = null;
  /**
   * Frozen agent `AuthorityDescriptor`s built once at construction (launch) from
   * trusted config. Never reassembled from caller data; recycled/purged
   * registrations are removed so a stale descriptor reference grants nothing.
   */
  #authorityRegistry: Map<string, AuthorityDescriptor> = new Map();

  /**
   * Registry-owned authority inputs (privileged + allowedTools selector) that
   * produced each active descriptor. Identity projections read these instead
   * of the live entity config; entries are removed with the descriptor
   * (MOD-21 W10, 5b585b7).
   */
  #authorityInputs: Map<string, AuthorityInputRecord> = new Map();

  /**
   * Opaque owner-controlled channel injected into every entity this manager
   * constructs and presented when gated authority updates are applied
   * (MOD-21 W10). A public entity reference cannot forge it.
   */
  #authorityChannel: object = Object.freeze({});

  /**
   * @param options - Constructor options bag. All fields are optional and
   *   default to `null`: `runtime` (back-reference to `AgentRuntime`), `emit`
   *   (`SubsystemEmitPort`), `triggerDispatcher` (`TriggerDispatcher` port,
   *   `setupAgentMailSubscription`), `messagingBus` (shared `MessagingBus`),
   *   `virtualFs` (shared `VirtualFS`), `invocationEngine` (standalone
   *   `InvocationEngine`), `agents` (active agents map), `recycleBin` (recycled
   *   agents map), `messageSubscriptions` (subscriptions map),
   *   `credentialResolver` (optional read-only credential resolver forwarded to
   *   `Agent` construction), `presetSource` (optional MOD-20 preset-source
   *   projection forwarded to `Agent` construction), and `internalPrincipal`
   *   (opaque engine principal injected by the composition root; only this
   *   exact reference is trusted).
   */
  constructor({
    runtime = null,
    emit = null,
    triggerDispatcher = null,
    messagingBus = null,
    virtualFs = null,
    invocationEngine = null,
    agents = null,
    recycleBin = null,
    messageSubscriptions = null,
    credentialResolver = null,
    presetSource = null,
    internalPrincipal = null
  }: AgentLifecycleManagerOptions = {}) {
    this.#runtime = toLifecycleRuntimeHost(runtime);
    this.#messagingBus = messagingBus || this.#runtime?.messagingBus || null;
    this.#virtualFs = virtualFs || this.#runtime?.virtualFs || null;
    this.#invocationEngine = invocationEngine || this.#runtime?.invocationEngine || null;

    this.#agents = agents || new Map();
    this.#recycleBin = recycleBin || new Map();
    this.#messageSubscriptions = messageSubscriptions || new Map();
    this.#emitPort = (emit && typeof emit.emit === 'function')
      ? emit
      : (this.#runtime && typeof this.#runtime.createSubsystemEmitPort === 'function' ? this.#runtime.createSubsystemEmitPort() : null);
    this.#mailPort = (triggerDispatcher && typeof triggerDispatcher.setupAgentMailSubscription === 'function')
      ? triggerDispatcher
      : null;
    this.#credentialResolver = credentialResolver || null;
    this.#presetSource = presetSource || null;
    this.#internalPrincipal = internalPrincipal || null;
  }

  /**
   * Resolves caller-supplied context into a trusted principal.
   *
   * Trust rules (MOD-21, default-deny):
   * - the exact injected `InternalPrincipal` reference only;
   * - a frozen agent descriptor that IS the registry instance for its subject;
   * - a `{ callerAgentId }`/`{ agentId }` identity claim resolved through the
   *   registry descriptor of that id (flags are never consulted);
   * - a trusted `callerKey`/`caller_key` canonical identity key that the
   *   authority registry binds — and only then: a supplied-but-unresolvable
   *   key fails closed (`null`) and the bare id claim is never consulted
   *   (Wave I, ticket d57cbc1; fix lane G5, residual R2), so a stale key left
   *   over from a recycled holder can neither retarget another Realm's
   *   same-literal-id twin nor degrade the caller to anonymous;
   * - `{ principal }` wrappers recurse on the wrapped value.
   *
   * Everything else — plain objects, flag bundles, reserved id strings, forged
   * descriptor shapes — resolves to `null` (anonymous).
   *
   * @param candidate - Caller-supplied principal candidate.
   * @returns The trusted principal, or `null` when anonymous.
   */
  #resolvePrincipal(candidate: unknown): LifecyclePrincipal | null {
    if (!candidate || typeof candidate !== 'object') return null;
    const source = candidate as Record<string, unknown>;

    if (this.#internalPrincipal && candidate === this.#internalPrincipal) {
      return this.#internalPrincipal;
    }

    if (source.kind === 'agent' && typeof source.subject === 'string') {
      const registered = this.#authorityByBareId(source.subject);
      return registered && registered === candidate ? registered : null;
    }

    if (source.principal && typeof source.principal === 'object' && source.principal !== candidate) {
      return this.#resolvePrincipal(source.principal);
    }

    // Canonical identity key (Wave I, ticket d57cbc1): a trusted internal
    // context may carry the caller's canonical key alongside (or instead of)
    // the bare id, so a same-literal-id realm pair resolves its exact
    // descriptor. The key is registry-owned — a forged key resolves nothing.
    const callerKey = typeof source.callerKey === 'string' && source.callerKey
      ? source.callerKey
      : (typeof source.caller_key === 'string' && source.caller_key ? source.caller_key : null);
    if (callerKey) {
      // Fail closed on a supplied-but-unresolvable pinned key (Wave I, ticket
      // d57cbc1; fix lane G5, residual R2): the bare id claim is never a
      // fallback for a stale key, so a recycled holder's key cannot retarget
      // the other Realm's same-literal-id twin and cannot degrade the caller
      // to the anonymous host path.
      return this.#authorityRegistry.get(callerKey) || null;
    }

    const claimedId = typeof source.callerAgentId === 'string' && source.callerAgentId
      ? source.callerAgentId
      : (typeof source.agentId === 'string' && source.agentId ? source.agentId : null);
    if (claimedId) {
      return this.#authorityRegistry.get(claimedId) || this.#authorityByBareId(claimedId);
    }

    return null;
  }

  /**
   * Resolves a trusted caller principal from the explicit `principal` option,
   * the `callerContext` argument/option, or a config-smuggled identity-only
   * caller context (flags ignored; authority always comes from the registry).
   * @param input - Explicit `principal` and/or `callerContext` candidates.
   * @returns The trusted principal, or `null` when anonymous.
   */
  #resolveCallerPrincipal({ principal = null, callerContext = null }: { principal?: unknown; callerContext?: unknown } = {}): LifecyclePrincipal | null {
    if (principal && typeof principal === 'object') {
      return this.#resolvePrincipal(principal);
    }
    if (callerContext && typeof callerContext === 'object') {
      return this.#resolvePrincipal(callerContext);
    }
    return null;
  }

  /**
   * Extracts a supplied trusted-caller-key claim from a caller context or
   * principal candidate (Wave I, ticket d57cbc1; fix lane G5, residual R2).
   *
   * A supplied canonical key is a strong identity claim: consumers that would
   * otherwise take the principal-less host/anonymous path must fail closed
   * when the key resolves no live registry descriptor, rather than falling
   * back to the bare id claim (or to the anonymous engine path). The
   * traversal mirrors `#resolvePrincipal` — the `callerKey`/`caller_key`
   * aliases on the candidate and any nested `principal` wrapper — so
   * detection and resolution agree on which key was supplied. A valid
   * principal still wins over the key, exactly as in resolution.
   *
   * @param candidate - Caller-supplied principal/context candidate.
   * @returns The claimed canonical identity key, or `null` when none was supplied.
   * @internal
   */
  #callerKeyClaim(candidate: unknown): string | null {
    if (!candidate || typeof candidate !== 'object') return null;
    const source = candidate as Record<string, unknown>;
    const claimed = typeof source.callerKey === 'string' && source.callerKey
      ? source.callerKey
      : (typeof source.caller_key === 'string' && source.caller_key ? source.caller_key : null);
    if (claimed) return claimed;
    if (source.principal && typeof source.principal === 'object' && source.principal !== candidate) {
      return this.#callerKeyClaim(source.principal);
    }
    return null;
  }

  /**
   * Requires lifecycle authority (the exact injected `InternalPrincipal` or a
   * registry `AuthorityDescriptor` holding `'*'`/`'@lifecycle:authority'`).
   * Anonymous and forged contexts are denied with `PERMISSION_DENIED` before
   * any mutation.
   * @param callerContext - Caller context candidate.
   * @param action - Verb phrase used in the denial message.
   * @returns The resolved principal.
   */
  #requireSudoer(callerContext: unknown, action: string): LifecyclePrincipal {
    const principal = this.#resolveCallerPrincipal({ callerContext });
    if (principal && principalHasLifecycleAuthority(principal)) return principal;
    const callerId = principal && principal.kind === 'agent' ? principal.subject : null;
    throw new PermissionDeniedError(
      `Permission denied: ${callerId ? `agent '${callerId}'` : 'anonymous caller'} cannot ${action}`,
      { callerAgentId: callerId || null, code: 'PERMISSION_DENIED' }
    );
  }

  /**
   * Authorizes a lifecycle mutation on a specific agent under the ratified
   * default-deny model (MOD-21 W8): a principal is mandatory; sudoer authority
   * comes from the registry descriptor; self and parent-creator relationships
   * come from registry parentage (`spawnedBy`/`creatorId`). Caller flags and
   * reserved ids grant nothing.
   *
   * @param agentId - Target agent id.
   * @param callerContext - Caller context candidate.
   * @param options - Action label, optional target agent, and sudoer-only flag.
   * @returns The resolved principal, caller id, and sudoer verdict.
   */
  #authorizeLifecycleMutation(
    agentId: string,
    callerContext: unknown,
    { action, targetAgent = null, requireSudoer = false }: { action: string; targetAgent?: Agent | null; requireSudoer?: boolean }
  ): { principal: LifecyclePrincipal | null; callerId: string | null; isSudoer: boolean } {
    // Agent-facing denial text projects a canonical identity key back to its
    // bare realm-local id (Wave I, ticket d57cbc1; fix lane G2); the reference
    // itself stays untouched for resolution and authorization.
    const targetLabel = this.#displayAgentId(agentId, targetAgent || null);

    if (requireSudoer) {
      const principal = this.#requireSudoer(callerContext, `${action} agent '${targetLabel}'`);
      const callerId = principal && principal.kind === 'agent' ? principal.subject : null;
      const agent = targetAgent || this.#uniqueByBareId(this.#agents, agentId) || this.#uniqueByBareId(this.#recycleBin, agentId) || null;
      this.#assertRealmScope(principal, agent, action, agentId);
      return { principal, callerId, isSudoer: true };
    }

    const principal = this.#resolveCallerPrincipal({ callerContext });
    const callerId = principal && principal.kind === 'agent' ? principal.subject : null;
    const isSudoer = principalHasLifecycleAuthority(principal);
    const agent = targetAgent || this.#uniqueByBareId(this.#agents, agentId) || this.#uniqueByBareId(this.#recycleBin, agentId) || null;
    // Realm confinement runs before the authority verdict (Realm wave A,
    // ticket 3487c56): a cross-scope target is denied even for wildcard
    // authority, while same-scope callers keep the legacy self/parent/sudoer
    // semantics untouched.
    this.#assertRealmScope(principal, agent, action, agentId);
    const isSelf = Boolean(callerId) && callerId === agentId;
    const isParent = Boolean(callerId) && agent !== null &&
      (agent.config?.spawnedBy === callerId || agent.config?.creatorId === callerId);

    if (!isSudoer && !isSelf && !isParent) {
      throw new PermissionDeniedError(
        `Permission denied: ${callerId ? `agent '${callerId}'` : 'anonymous caller'} cannot ${action} agent '${targetLabel}' (must be sudoer, parent creator, or the agent itself)`,
        { callerAgentId: callerId || null, code: 'PERMISSION_DENIED' }
      );
    }

    return { principal, callerId, isSudoer };
  }

  /**
   * Resolves an agent record's Realm membership from the owner-controlled
   * config accessor (`null` = ungrouped). Registry records in the recycle bin
   * keep their membership for teardown/restore gating.
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
   * Canonical internal identity key of an agent record (Wave I, ticket
   * d57cbc1): the composite `(realmId, agentId)` registration key owned by
   * `createAgentIdentityKey`. Every registry in this manager keys on it, so
   * the same literal id registered in two Realms never shares an entry.
   *
   * @param agent - Agent record (its owner-controlled `config.realmId` is the
   *   membership source; a missing record yields the system-scope key of '').
   * @returns The canonical identity key.
   * @internal
   */
  #agentIdentityKeyOf(agent: Agent | null | undefined): string {
    return createAgentIdentityKey(this.#agentRealmId(agent), agent && typeof agent.id === 'string' ? agent.id : '');
  }

  /**
   * Unique-match bare-id lookup over a canonically keyed registry (Wave I,
   * ticket d57cbc1). A bare id is realm-local and opaque: it resolves only
   * while exactly one registration matches. Zero matches resolve `null`
   * (not-found) and more than one — the same literal id in more than one Realm
   * — resolves `null` too (fail closed, never a wrong-Realm pick).
   *
   * @param records - Canonically keyed registry (active agents or recycle bin).
   * @param agentId - Bare agent identifier to resolve.
   * @returns The single matching agent, or `null` (absent or ambiguous).
   * @internal
   */
  #uniqueByBareId(records: Map<string, Agent>, agentId: string): Agent | null {
    if (!agentId || typeof agentId !== 'string') return null;
    let match: Agent | null = null;
    for (const agent of records.values()) {
      if (!agent || agent.id !== agentId) continue;
      // A second match means the id is ambiguous across scopes: fail closed.
      if (match !== null) return null;
      match = agent;
    }
    return match;
  }

  /**
   * Counts the registrations matching a bare agent id in a canonically keyed
   * registry (Wave I, ticket d57cbc1). Ambiguity (more than one) is a
   * fail-closed signal for id-only consumers.
   *
   * @param records - Canonically keyed registry (active agents or recycle bin).
   * @param agentId - Bare agent identifier to count.
   * @returns Number of matching registrations.
   * @internal
   */
  #countByBareId(records: Map<string, Agent>, agentId: string): number {
    if (!agentId || typeof agentId !== 'string') return 0;
    let count = 0;
    for (const agent of records.values()) {
      if (agent && agent.id === agentId) count += 1;
    }
    return count;
  }

  /**
   * Resolves the frozen registry authority descriptor of a bare agent id by
   * unique match (Wave I, ticket d57cbc1). The same literal id in two Realms
   * carries two descriptors with the same `subject`, so an ambiguous lookup
   * fails closed with `null`; consumers must default-deny.
   *
   * @param agentId - Bare agent identifier.
   * @returns The single matching descriptor, or `null` (absent or ambiguous).
   * @internal
   */
  #authorityByBareId(agentId: string): AuthorityDescriptor | null {
    if (!agentId || typeof agentId !== 'string') return null;
    let match: AuthorityDescriptor | null = null;
    for (const descriptor of this.#authorityRegistry.values()) {
      if (descriptor.subject !== agentId) continue;
      if (match !== null) return null;
      match = descriptor;
    }
    return match;
  }

  /**
   * Reverse-resolves the canonical identity key of a frozen registry
   * descriptor (Wave I, ticket d57cbc1): the descriptor instance is
   * registry-owned, so the mapping is exact even when several Realms register
   * the same literal subject. A forged (non-registry) descriptor resolves
   * `null` — callers must default-deny.
   *
   * @param descriptor - Candidate registry descriptor.
   * @returns The canonical identity key owning the descriptor, or `null`.
   * @internal
   */
  #identityKeyForDescriptor(descriptor: AuthorityDescriptor | null | undefined): string | null {
    if (!descriptor || typeof descriptor !== 'object') return null;
    for (const [identityKey, registered] of this.#authorityRegistry) {
      if (registered === descriptor) return identityKey;
    }
    return null;
  }

  /**
   * Tests whether a resolved principal bypasses Realm scoping (Realm wave A,
   * ticket 3487c56; Wave I, ticket c02d0b9): the exact injected engine
   * `InternalPrincipal` (the operator/engine path) or an agent whose frozen
   * registry descriptor carries the `realmBypass` grant. Agent capability —
   * the wildcard `'*'` included — never bypasses without the grant, and no id
   * is ever consulted.
   *
   * @param principal - Resolved principal, or `null` when anonymous.
   * @returns True when the principal spans every Realm.
   * @internal
   */
  #principalBypassesRealm(principal: LifecyclePrincipal | null): boolean {
    if (!principal || typeof principal !== 'object') return false;
    if (principal.kind === 'internal') return true;
    return principal.kind === 'agent' && principal.realmBypass === true;
  }

  /**
   * Resolves the Realm membership of a resolved caller principal: the agent
   * subject's registry record (active or recycled), or `null` for the
   * operator/engine principal and anonymous callers.
   *
   * @param principal - Resolved principal, or null.
   * @returns The caller's Realm id, or `null` when ungrouped.
   * @internal
   */
  #principalRealmId(principal: LifecyclePrincipal | null): string | null {
    if (!principal || principal.kind !== 'agent') return null;
    // Canonical reverse lookup (Wave I, ticket d57cbc1): a registry descriptor
    // resolves its exact registration, so the realm is known even when the
    // same literal subject is registered in two Realms.
    const identityKey = this.#identityKeyForDescriptor(principal);
    if (identityKey) {
      const record = this.#agents.get(identityKey) || this.#recycleBin.get(identityKey) || null;
      if (record) return this.#agentRealmId(record);
    }
    const record = this.#uniqueByBareId(this.#agents, principal.subject) || this.#uniqueByBareId(this.#recycleBin, principal.subject) || null;
    return this.#agentRealmId(record);
  }

  /**
   * Projects a lifecycle reference back to its bare realm-local label for
   * agent-facing denial text (Wave I, ticket d57cbc1; fix lane G2). A
   * canonical `(realmId, agentId)` identity key decodes to its `agentId`
   * segment — the string is internal-only and must never appear on an
   * agent-facing surface — while any other reference passes through
   * unchanged. Message projection only: codes and authorization semantics are
   * untouched.
   *
   * @param agentId - Bare id or canonical identity key.
   * @param targetAgent - Resolved target record whose bare id is authoritative, when available.
   * @returns The bare realm-local id for display.
   * @internal
   */
  #displayAgentId(agentId: string, targetAgent?: Agent | null): string {
    if (targetAgent && typeof targetAgent.id === 'string' && targetAgent.id) return targetAgent.id;
    const parsed = typeof agentId === 'string' ? parseAgentIdentityKey(agentId) : null;
    return parsed ? parsed.agentId : agentId;
  }

  /**
   * Realm confinement gate (Realm wave A, ticket 3487c56; Realm wave R,
   * ticket cf0e127; Wave I, ticket c02d0b9): a lifecycle operation on a target
   * outside the caller's own Realm scope is denied fail-closed with
   * `PERMISSION_DENIED`, even for lifecycle authority (the wildcard `'*'`
   * included). The exact injected internal principal and a registry
   * `realmBypass` grant bypass the gate by principal; every other caller
   * passes only on `config.realmId` equality, with the bootstrap-only `null`
   * system scope shared by ungrouped subjects exactly like any other scope.
   *
   * @param principal - Resolved caller principal, or null.
   * @param targetAgent - Target agent record (active or recycled).
   * @param action - Verb phrase used in the denial message.
   * @param agentId - Target agent id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` on a cross-scope target.
   * @internal
   */
  #assertRealmScope(
    principal: LifecyclePrincipal | null,
    targetAgent: Agent | null | undefined,
    action: string,
    agentId: string
  ): void {
    if (this.#principalBypassesRealm(principal)) return;
    if (this.#principalRealmId(principal) === this.#agentRealmId(targetAgent)) return;
    const callerId = principal && principal.kind === 'agent' ? principal.subject : null;
    const targetLabel = this.#displayAgentId(agentId, targetAgent);
    throw new PermissionDeniedError(
      `Permission denied: ${callerId ? `agent '${callerId}'` : 'anonymous caller'} cannot ${action} agent '${targetLabel}' across Realm scopes (same Realm or Realm bypass required)`,
      { callerAgentId: callerId || null, code: 'PERMISSION_DENIED' }
    );
  }

  /**
   * Resolves the registration a lifecycle mutation addresses (Wave I, ticket
   * d57cbc1): a realm-bound caller's bare id resolves inside the caller's own
   * Realm first — the same literal id registered in two Realms addresses the
   * caller's own registration, never the other Realm's — and only falls
   * through to the unique-match rule when the caller's Realm carries no such
   * id, so the existing realm gate keeps its uniform `PERMISSION_DENIED` for a
   * foreign-only target (never a wrong-Realm mutation). Operator/internal
   * (bypass) callers and anonymous/host callers use unique-match; an ambiguous
   * bare id fails closed there.
   *
   * A supplied-but-unresolvable pinned caller key resolves no registration at
   * all (Wave I, ticket d57cbc1; fix lane G5, residual R2): the stale key is a
   * fail-closed signal, never a fall-through to the canonical-key direct hit,
   * the caller-scoped key, or the unique-match bare id.
   *
   * @param agentId - Bare target id supplied by the caller.
   * @param callerContext - Caller context (trusted-principal resolution only).
   * @returns The matching active and recycled records (`null` when absent).
   * @internal
   */
  #resolveMutationTarget(agentId: string, callerContext: unknown): { active: Agent | null; recycled: Agent | null } {
    const principal = this.#resolveCallerPrincipal({ callerContext });
    if (this.#callerKeyClaim(callerContext) && !principal) {
      return { active: null, recycled: null };
    }
    // Canonical target key (Wave I, ticket d57cbc1): an exact registration key
    // addresses its record directly; the realm gate still confines a
    // realm-bound caller to its own scope.
    const activeByKey = this.#agents.get(agentId) || null;
    const recycledByKey = this.#recycleBin.get(agentId) || null;
    if (activeByKey || recycledByKey) {
      return { active: activeByKey, recycled: activeByKey ? null : recycledByKey };
    }
    if (principal && principal.kind === 'agent' && !this.#principalBypassesRealm(principal)) {
      const scopedKey = createAgentIdentityKey(this.#principalRealmId(principal), agentId);
      const scopedActive = this.#agents.get(scopedKey) || null;
      const scopedRecycled = this.#recycleBin.get(scopedKey) || null;
      if (scopedActive || scopedRecycled) {
        return { active: scopedActive, recycled: scopedActive ? null : scopedRecycled };
      }
    }
    return {
      active: this.#uniqueByBareId(this.#agents, agentId),
      recycled: this.#uniqueByBareId(this.#recycleBin, agentId)
    };
  }

  /**
   * Reports whether restoring a record would re-derive an authority-bearing
   * registry descriptor. Snapshot-provenance records always re-derive
   * default-deny; live-construction records may carry `privileged` or
   * wildcard/lifecycle capability tool selectors (MOD-21 W8).
   * @param agent - Candidate recycled agent entity.
   * @returns True when restoring the record would re-derive an authority-bearing descriptor.
   */
  #wouldRestoreAuthority(agent: Agent): boolean {
    if (!agent || agent.authorityProvenance === 'snapshot') return false;
    const config = agent.config || {};
    if (config.privileged === true) return true;
    const tools = config.allowedTools;
    if (tools === '*') return true;
    if (Array.isArray(tools)) {
      return tools.some((tool) => tool === '*' || tool === LIFECYCLE_AUTHORITY_CAPABILITY);
    }
    return false;
  }

  /**
   * Resolves the VirtualFS workspace key whose lifecycle belongs to an agent
   * (Wave I, ticket d57cbc1).
   *
   * Launch composition pins `config.workspaceId` to
   * `config.workspaceId || config.workspace || agentId`; hydrated or legacy
   * records may carry the canonical field, the legacy `workspace` alias, or
   * neither. Resolution mirrors the VFS-owned rule
   * (`resolveAgentPrivateWorkspaceKey`): an explicit pin — a declared value
   * differing from the bare agent id — is preserved verbatim, a realm-bound
   * record resolves its canonical `(realmId, agentId)` identity key (the same
   * partition the VFS workspace view keys), and an ungrouped/system-scope
   * record keeps the legacy bare id. Teardown (`killAgent`/`purgeAgent`)
   * evicts exactly this key — never a workspace named after the raw lookup id
   * when the agent was launched into an explicit workspace (ticket 4e9e0c8),
   * and never another Realm's same-id partition (Wave I). This resolution also
   * defines an agent's workspace claim: launch refuses a non-authority
   * resolved key that another registered record claims, and teardown evicts
   * the key only for its last registered claimant (ticket 26c3913).
   *
   * @param agent - Target agent entity, or null when unavailable.
   * @param fallbackId - Id to evict when no workspace is declared.
   * @returns The resolved workspace key to evict.
   */
  #resolveWorkspaceKey(agent: Agent | null | undefined, fallbackId: string): string {
    const agentId = agent && typeof agent.id === 'string' && agent.id ? agent.id : fallbackId;
    const workspaceId = agent?.config?.workspaceId;
    if (typeof workspaceId === 'string' && workspaceId.trim() && workspaceId !== agentId) return workspaceId;
    const legacyWorkspace = agent?.config?.workspace;
    if (typeof legacyWorkspace === 'string' && legacyWorkspace.trim() && legacyWorkspace !== agentId) return legacyWorkspace;
    const realmId = this.#agentRealmId(agent);
    return realmId ? createAgentIdentityKey(realmId, agentId) : agentId;
  }

  /**
   * Resolves the effective private workspace key of a not-yet-registered
   * launch (Wave I, ticket d57cbc1): the requested pin when it differs from
   * the new agent's own id, else the canonical identity key for a Realm-bound
   * launch, else the legacy bare id. Mirrors the private workspace-key
   * resolution (`resolveWorkspaceKey`) so the launch confinement
   * claim/existence checks compare against exactly the key teardown will evict.
   *
   * @param realmId - Composed Realm membership (`null` = system scope).
   * @param agentId - New agent's realm-local id.
   * @param requestedWorkspacePin - Explicit `config.workspaceId`/`workspace` pin, or null.
   * @returns The resolved workspace key.
   * @internal
   */
  #resolveLaunchWorkspaceKey(realmId: string | null, agentId: string, requestedWorkspacePin: string | null): string {
    if (requestedWorkspacePin && requestedWorkspacePin !== agentId) return requestedWorkspacePin;
    return realmId ? createAgentIdentityKey(realmId, agentId) : agentId;
  }

  /**
   * Collects the resolved workspace keys claimed by the registered agent
   * records — the active registry and the recycle bin — excluding the given
   * canonical identity keys.
   *
   * A record claims the key teardown would resolve for it
   * (`config.workspaceId || config.workspace || agent id`); the set is the
   * authority for the claim-aware launch and eviction decisions (ticket
   * 26c3913): a non-authority child may not adopt a key claimed by another
   * registered record, and a resolved key is evicted only by its last
   * registered claimant.
   *
   * @param excludeIdentityKeys - Canonical `(realmId, agentId)` keys whose
   *   claims must not count (the creator and the new agent at launch; the
   *   record being torn down at eviction).
   * @returns Resolved workspace keys claimed by the remaining records.
   */
  #collectClaimedWorkspaceKeys(excludeIdentityKeys: ReadonlySet<string>): Set<string> {
    const claimed = new Set<string>();
    for (const records of [this.#agents, this.#recycleBin]) {
      for (const [identityKey, record] of records) {
        if (excludeIdentityKeys.has(identityKey)) continue;
        claimed.add(this.#resolveWorkspaceKey(record, record.id));
      }
    }
    return claimed;
  }

  /**
   * Tests whether a resolved workspace key is still claimed by a registered
   * record (active registry or recycle bin) other than the given agent.
   * Teardown skips the VFS eviction while this returns true, so bytes shared
   * with another record — an active creator or a recycled co-claimant — are
   * deleted only by the last claimant's teardown (ticket 26c3913).
   *
   * @param workspaceKey - Resolved workspace key considered for eviction.
   * @param claimantIdentityKey - Canonical identity key of the record being torn down.
   * @returns True when another registered record resolves to the same key.
   */
  #isWorkspaceKeyClaimedByOther(workspaceKey: string, claimantIdentityKey: string): boolean {
    return this.#collectClaimedWorkspaceKeys(new Set<string>([claimantIdentityKey])).has(workspaceKey);
  }

  /**
   * Applies a validated state transition and emits the `state_change` event.
   * Callers must have authorized the mutation before invoking this helper.
   * @param agent - Target agent entity.
   * @param newState - Destination lifecycle state.
   * @param stateDetail - Optional transition detail.
   * @returns The updated agent entity.
   */
  #applyStateTransition(agent: Agent, newState: AgentState, stateDetail: string | null = null): Agent {
    const currentState = agent.state;
    const allowed = VALID_TRANSITIONS[currentState] || [];

    if (!allowed.includes(newState)) {
      const err: CodedError = new Error(
        `Invalid state transition: cannot transition agent '${agent.id}' from '${currentState}' to '${newState}'`
      );
      err.code = 'INVALID_STATE_TRANSITION';
      throw err;
    }

    const previousState = currentState;
    agent.state = newState;
    agent.stateDetail = stateDetail !== undefined ? stateDetail : agent.stateDetail;
    agent.updatedAt = Date.now();

    this.#emit({
      type: 'state_change',
      agentId: agent.id,
      payload: {
        from: previousState,
        to: newState,
        previousState,
        currentState: newState,
        stateDetail: agent.stateDetail
      }
    });

    return agent;
  }

  /**
   * Builds and registers the frozen `AuthorityDescriptor` for an agent from
   * trusted construction input.
   * @param identityKey - Canonical `(realmId, agentId)` identity key owning the entry.
   * @param subject - Bare registered agent id carried on the descriptor.
   * @param input - Trusted privilege flag, capability selector, bypass grant, and publishing-authority grants.
   * @returns The frozen registered descriptor.
   */
  #registerAgentAuthority(
    identityKey: string,
    subject: string,
    {
      privileged = false,
      allowedTools = null,
      realmBypass = false,
      templateAuthority = false,
      hydrationAuthority = false
    }: {
      privileged?: boolean;
      allowedTools?: string[] | '*' | null;
      realmBypass?: boolean;
      templateAuthority?: boolean;
      hydrationAuthority?: boolean;
    } = {}
  ): AuthorityDescriptor {
    const descriptor = createAgentAuthorityDescriptor(subject, {
      privileged,
      allowedTools,
      realmBypass,
      templateAuthority,
      hydrationAuthority
    });
    this.#authorityRegistry.set(identityKey, descriptor);
    this.#authorityInputs.set(identityKey, Object.freeze({
      privileged: privileged === true,
      allowedTools: normalizeAuthorityInputAllowedTools(allowedTools),
      realmBypass: realmBypass === true,
      templateAuthority: templateAuthority === true,
      hydrationAuthority: hydrationAuthority === true
    }));
    return descriptor;
  }

  /**
   * Copies the registry-owned capability inputs of an active agent into the
   * shape `#registerAgentAuthority` accepts, preserving the current grant
   * state. Used by descriptor rebuilds that must not touch the scope or
   * publishing-authority axes.
   *
   * @param identityKey - Canonical identity key owning the entry.
   * @returns Trusted capability inputs with the current grants.
   */
  #currentAuthorityInputs(identityKey: string): {
    privileged: boolean;
    allowedTools: string[] | null;
    realmBypass: boolean;
    templateAuthority: boolean;
    hydrationAuthority: boolean;
  } {
    const inputs = this.#authorityInputs.get(identityKey);
    return {
      privileged: Boolean(inputs && inputs.privileged === true),
      allowedTools: inputs && inputs.allowedTools ? [...inputs.allowedTools] : null,
      realmBypass: Boolean(inputs && inputs.realmBypass === true),
      templateAuthority: Boolean(inputs && inputs.templateAuthority === true),
      hydrationAuthority: Boolean(inputs && inputs.hydrationAuthority === true)
    };
  }

  /**
   * Sets the `realmBypass` grant state for an active agent (Wave I, ticket
   * c02d0b9).
   *
   * Authority-bearing operator action: only the exact injected
   * `InternalPrincipal` reference resolves; every other caller — agent
   * principals, caller-asserted flags, plain lookalike objects — is denied
   * with `PERMISSION_DENIED` before any mutation. The grant is recorded in the
   * frozen authority inputs and rebuilt into the descriptor; the capability
   * axis and the agent's Realm membership are untouched. An audit event is
   * emitted for both directions.
   *
   * Target resolution is canonical-capable (Wave I, ticket d57cbc1; fix lane
   * F3): a canonical identity key addresses its exact registration, and a
   * realm-bound caller context resolves inside its own scope first; the bare
   * unique-match rule remains the fallback and an ambiguous bare id fails
   * closed with `null`.
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key).
   * @param enabled - Desired grant state.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  #setRealmBypass(
    agentId: string,
    enabled: boolean,
    callerContext: unknown
  ): AuthorityDescriptor | null {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("realmBypass operation requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    const principal = this.#resolveCallerPrincipal({ callerContext });
    if (!principal || principal.kind !== 'internal') {
      throw new PermissionDeniedError(
        `Permission denied: only the composition-root operator principal may ${enabled ? 'grant' : 'revoke'} realmBypass on agent '${this.#displayAgentId(agentId)}'`,
        {
          callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null,
          code: 'PERMISSION_DENIED'
        }
      );
    }
    // Active agents only: a recycled or unknown id never carries a grant.
    // Canonical-capable resolution (Wave I, ticket d57cbc1; fix lane F3): a
    // canonical identity key addresses its exact registration, while the
    // ambiguous bare-id fallback stays unique-match and fails closed with
    // `null` — the same literal id in two Realms without a scope is never a
    // wrong-Realm pick.
    const agent = this.#resolveMutationTarget(agentId, callerContext).active;
    if (!agent) return null;
    const identityKey = this.#agentIdentityKeyOf(agent);

    const descriptor = this.#registerAgentAuthority(identityKey, agent.id, {
      ...this.#currentAuthorityInputs(identityKey),
      realmBypass: enabled === true
    });

    // The audit event carries the bare realm-local id only (Realm opacity):
    // a keyed or scoped lookup must never echo the canonical key.
    this.#emit({
      type: enabled ? 'realm_bypass_granted' : 'realm_bypass_revoked',
      agentId: agent.id,
      payload: {
        agentId: agent.id,
        realmBypass: enabled === true,
        by: principal.subject
      }
    });

    return descriptor;
  }

  /**
   * Grants the `realmBypass` scope grant to an active agent.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  grantRealmBypass(agentId: string, callerContext: unknown = null): AuthorityDescriptor | null {
    return this.#setRealmBypass(agentId, true, callerContext);
  }

  /**
   * Revokes the `realmBypass` scope grant from an active agent.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  revokeRealmBypass(agentId: string, callerContext: unknown = null): AuthorityDescriptor | null {
    return this.#setRealmBypass(agentId, false, callerContext);
  }

  /**
   * Lists the canonical `(realmId, agentId)` identity keys of the active
   * agents currently holding the `realmBypass` grant (Wave I, ticket
   * d57cbc1; fix lane G2).
   *
   * Canonical keys are the persistence currency: a grant list carrying the
   * same literal id from two Realms round-trips exactly, because
   * `restoreRealmBypassGrants` resolves each key to its own registration.
   * Legacy bare-id snapshots still restore through the unique-match rule (an
   * ambiguous bare id is skipped fail-closed, never escalated to a Realm).
   * The listing itself is registry state, not authority, and the key is
   * internal-only — it never reaches an agent-facing surface.
   *
   * @returns Canonical identity keys of the granted active agents.
   */
  listRealmBypassGrants(): string[] {
    const granted: string[] = [];
    for (const identityKey of this.#agents.keys()) {
      const inputs = this.#authorityInputs.get(identityKey);
      if (inputs && inputs.realmBypass === true) granted.push(identityKey);
    }
    return granted;
  }

  /**
   * Sets one explicit Wave U publishing-authority grant state for an active
   * agent (ticket 2518510).
   *
   * Authority-bearing operator action: only the exact injected
   * `InternalPrincipal` reference resolves; every other caller — agent
   * principals, caller-asserted flags, plain lookalike objects — is denied
   * with `PERMISSION_DENIED` before any mutation. The grant is recorded in the
   * frozen authority inputs and rebuilt into the descriptor's allow set as the
   * exact `@template:authority`/`@hydration:authority` id; the capability
   * selector axis, the scope axis, and Realm membership are untouched. An audit
   * event is emitted for both directions.
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key).
   * @param authority - Exact publishing-authority id to set.
   * @param enabled - Desired grant state.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  #setMetaAuthority(
    agentId: string,
    authority: string,
    enabled: boolean,
    callerContext: unknown
  ): AuthorityDescriptor | null {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error('meta-authority operation requires a valid string \'agentId\'');
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    const isTemplateAuthority = authority === AGENT_AUTHORITIES.TEMPLATE;
    if (!isTemplateAuthority && authority !== AGENT_AUTHORITIES.HYDRATION) {
      const err: CodedError = new Error(`Unknown publishing authority '${String(authority)}'`);
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    const principal = this.#resolveCallerPrincipal({ callerContext });
    if (!principal || principal.kind !== 'internal') {
      throw new PermissionDeniedError(
        `Permission denied: only the composition-root operator principal may ${enabled ? 'grant' : 'revoke'} `
        + `${authority} on agent '${this.#displayAgentId(agentId)}'`,
        {
          callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null,
          code: 'PERMISSION_DENIED'
        }
      );
    }
    // Active agents only: a recycled or unknown id never carries a grant.
    const agent = this.#resolveMutationTarget(agentId, callerContext).active;
    if (!agent) return null;
    const identityKey = this.#agentIdentityKeyOf(agent);

    const descriptor = this.#registerAgentAuthority(identityKey, agent.id, {
      ...this.#currentAuthorityInputs(identityKey),
      ...(isTemplateAuthority
        ? { templateAuthority: enabled === true }
        : { hydrationAuthority: enabled === true })
    });

    // The audit event carries the bare realm-local id only (Realm opacity).
    this.#emit({
      type: isTemplateAuthority
        ? (enabled ? 'template_authority_granted' : 'template_authority_revoked')
        : (enabled ? 'hydration_authority_granted' : 'hydration_authority_revoked'),
      agentId: agent.id,
      payload: {
        agentId: agent.id,
        authority,
        enabled: enabled === true,
        by: principal.subject
      }
    });

    return descriptor;
  }

  /**
   * Grants the `@template:authority` publishing capability to an active agent.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  grantTemplateAuthority(agentId: string, callerContext: unknown = null): AuthorityDescriptor | null {
    return this.#setMetaAuthority(agentId, AGENT_AUTHORITIES.TEMPLATE, true, callerContext);
  }

  /**
   * Revokes the `@template:authority` publishing capability from an active agent.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  revokeTemplateAuthority(agentId: string, callerContext: unknown = null): AuthorityDescriptor | null {
    return this.#setMetaAuthority(agentId, AGENT_AUTHORITIES.TEMPLATE, false, callerContext);
  }

  /**
   * Grants the `@hydration:authority` publishing capability to an active agent.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  grantHydrationAuthority(agentId: string, callerContext: unknown = null): AuthorityDescriptor | null {
    return this.#setMetaAuthority(agentId, AGENT_AUTHORITIES.HYDRATION, true, callerContext);
  }

  /**
   * Revokes the `@hydration:authority` publishing capability from an active agent.
   *
   * @param agentId - Active agent identifier.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'PERMISSION_DENIED'` for non-operator callers.
   */
  revokeHydrationAuthority(agentId: string, callerContext: unknown = null): AuthorityDescriptor | null {
    return this.#setMetaAuthority(agentId, AGENT_AUTHORITIES.HYDRATION, false, callerContext);
  }

  /**
   * Lists the canonical `(realmId, agentId)` identity keys of the active agents
   * currently holding the Wave U publishing-authority grants (ticket 2518510).
   *
   * Canonical keys are the persistence currency: a grant list carrying the
   * same literal id from two Realms round-trips exactly, because the
   * composition-root restore resolves each key to its own registration. The
   * listing itself is registry state, not authority, and the keys are
   * internal-only — they never reach an agent-facing surface.
   *
   * @returns Canonical identity keys per publishing authority.
   */
  listMetaAuthorityGrants(): { template: string[]; hydration: string[] } {
    const template: string[] = [];
    const hydration: string[] = [];
    for (const identityKey of this.#agents.keys()) {
      const inputs = this.#authorityInputs.get(identityKey);
      if (!inputs) continue;
      if (inputs.templateAuthority === true) template.push(identityKey);
      if (inputs.hydrationAuthority === true) hydration.push(identityKey);
    }
    return { template, hydration };
  }

  /**
   * Returns the frozen `AuthorityDescriptor` registered for an active agent, or
   * `null` for an unknown, recycled, or purged id. Consumers must default-deny
   * non-innate capability when `null`.
   *
   * Bare-id resolution is unique-match (Wave I, ticket d57cbc1): the same
   * literal id registered in two Realms resolves `null` (fail closed) rather
   * than a descriptor from the wrong Realm. Scoped consumers that already hold
   * the canonical identity key use {@link getAuthorityDescriptorByKey}.
   *
   * @param agentId - Registered agent identifier
   * @returns The frozen authority descriptor, or `null`
   *
   * @example
   * ```typescript
   * const authority = lifecycleManager.getAuthorityDescriptor('director');
   * const isOperator = Boolean(authority?.allow.has('@lifecycle:authority'));
   * ```
   */

  getAuthorityDescriptor(agentId: string): AuthorityDescriptor | null {
    if (!agentId || typeof agentId !== 'string') return null;
    // Canonical identity key (Wave I, ticket d57cbc1): the exact registration
    // resolves realm-exactly; a bare id keeps the unique-match rule.
    return this.#authorityRegistry.get(agentId) || this.#authorityByBareId(agentId);
  }

  /**
   * Returns the frozen `AuthorityDescriptor` registered under a canonical
   * `(realmId, agentId)` identity key (Wave I, ticket d57cbc1).
   *
   * Internal keyed surface consumed by the runtime identity projection, which
   * already resolves the exact registration and must not fall back to an
   * ambiguous bare id. Never agent-facing: the key is internal vocabulary.
   *
   * @param identityKey - Canonical identity key from `createAgentIdentityKey`.
   * @returns The frozen authority descriptor, or `null`
   */
  getAuthorityDescriptorByKey(identityKey: string): AuthorityDescriptor | null {
    if (!identityKey || typeof identityKey !== 'string') return null;
    return this.#authorityRegistry.get(identityKey) || null;
  }

  /**
   * Returns the frozen registry-owned authority inputs (`privileged` +
   * capability selector) that produced the active descriptor, or `null` for an
   * unknown, recycled, or purged id (MOD-21 W10, 5b585b7). Identity projections
   * read this record instead of the live entity config; consumers must
   * default-deny when it is `null`.
   *
   * Bare-id resolution is unique-match (Wave I, ticket d57cbc1): an id
   * registered in two Realms resolves `null` rather than foreign inputs.
   *
   * @param agentId - Registered agent identifier
   * @returns The frozen authority input record, or `null`
   *
   * @example
   * ```typescript
   * const inputs = lifecycleManager.getAuthorityInputs('director');
   * const privileged = inputs?.privileged === true;
   * ```
   */

  getAuthorityInputs(agentId: string): AuthorityInputRecord | null {
    if (!agentId || typeof agentId !== 'string') return null;
    const byKey = this.#authorityInputs.get(agentId);
    if (byKey) return byKey;
    const agent = this.#uniqueByBareId(this.#agents, agentId);
    if (!agent) return null;
    return this.#authorityInputs.get(this.#agentIdentityKeyOf(agent)) || null;
  }

  /**
   * Returns the frozen registry-owned authority inputs registered under a
   * canonical `(realmId, agentId)` identity key (Wave I, ticket d57cbc1).
   * Internal keyed counterpart of {@link getAuthorityInputs} for consumers
   * that already resolved the exact registration.
   *
   * @param identityKey - Canonical identity key from `createAgentIdentityKey`.
   * @returns The frozen authority input record, or `null`
   */
  getAuthorityInputsByKey(identityKey: string): AuthorityInputRecord | null {
    if (!identityKey || typeof identityKey !== 'string') return null;
    return this.#authorityInputs.get(identityKey) || null;
  }

  /**
   * Binds this manager's opaque authority-write channel to a hydrated entity
   * (first bind wins, MOD-21 W10). The composition root calls this before a
   * hydrated agent is exposed through the public registry, so a later bind
   * attempt cannot claim the entity; the channel is what lets a gated operator
   * grant reach a restored entity.
   *
   * The bind runs through the intrinsic `Agent.prototype.bindAuthorityChannel`
   * (MOD-21 W11-A, 18f43d6): a caller-substituted method — a replaced entity
   * prototype or an own property — never receives the manager channel. Non-
   * `Agent` input is refused with `false`.
   *
   * @param agent - Hydrated agent entity
   * @returns True when the channel was bound by this call; false when refused
   */

  bindAgentAuthorityChannel(agent: Agent): boolean {
    if (!(agent instanceof Agent)) return false;
    return Agent.prototype.bindAuthorityChannel.call(agent, this.#authorityChannel);
  }

  /**
   * Registers the re-derived frozen authority descriptor for a hydrated agent
   * during snapshot restore. A snapshot contributes no grant — the persisted
   * `allowedTools` whitelist and `spawnedBy`/`creatorId` parentage round-trip
   * as config data only — so the descriptor is default-deny until a trusted
   * operator grant lands (MOD-21 W5/W7/W10). The entity's authority-write
   * channel is bound here (first bind wins) so later gated operator grants can
   * reach the hydrated entity.
   *
   * @param agent - Hydrated agent entity
   * @returns The registered descriptor, or `null` when the agent shape is invalid
   */

  registerHydratedAgent(agent: Agent): AuthorityDescriptor | null {
    if (!agent || typeof agent.id !== 'string' || !agent.id) return null;
    this.bindAgentAuthorityChannel(agent);
    return this.#registerAgentAuthority(this.#agentIdentityKeyOf(agent), agent.id, {});
  }

  /**
   * Re-registers the frozen authority descriptor for an agent from trusted
   * engine input (MOD-21 W7). Hydration never restores authority, so a
   * composition root can re-assert a trusted descriptor here.
   *
   * This is a capability re-assertion path only: any input carrying the
   * `realmBypass` key — `false` included — is rejected fail-closed with
   * `PERMISSION_DENIED` before any mutation, for every caller (the exact
   * injected `InternalPrincipal` and wildcard/authority descriptors included),
   * because the scope grant is applied solely through the engine bootstrap or
   * `grantRealmBypass`/`revokeRealmBypass`. An omitted key preserves the
   * current grant state (Wave I, ticket c02d0b9; I1-F).
   *
   * Authority gate: the caller must resolve to lifecycle authority — the exact
   * injected `InternalPrincipal` reference or a registry `AuthorityDescriptor`
   * holding `'*'`/`'@lifecycle:authority'`; everything else is denied with
   * `PERMISSION_DENIED` before any mutation. The agent config is not touched.
   *
   * @param agentId - Registered active agent identifier
   * @param input - Trusted capability inputs (`privileged`/`allowedTools`); any `realmBypass` key is rejected
   * @param callerContext - Caller context carrying `principal` or a registry `callerAgentId` identity
   * @returns The registered descriptor, or `null` for an unknown id
   * @throws `Error` - With code `'PERMISSION_DENIED'` when the caller lacks lifecycle authority or supplied a `realmBypass` key
   */

  reauthorizeAgent(
    agentId: string,
    input: {
      privileged?: boolean;
      allowedTools?: string[] | '*' | null;
      realmBypass?: boolean;
      templateAuthority?: boolean;
      hydrationAuthority?: boolean;
    } = {},
    callerContext: object | null = null
  ): AuthorityDescriptor | null {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("reauthorizeAgent requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    const principal = this.#resolveCallerPrincipal({ callerContext });
    if (!principalHasLifecycleAuthority(principal)) {
      throw new PermissionDeniedError(
        `Permission denied: caller lacks lifecycle authority to reauthorize agent '${agentId}'`,
        { callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null, code: 'PERMISSION_DENIED' }
      );
    }
    // The scope grant is never composable here (Wave I, ticket c02d0b9;
    // I1-F): any `realmBypass` key — `false` included — is rejected fail-closed
    // for every caller, so a lifecycle-authority descriptor cannot widen its
    // own scope through this path. Only the dedicated grant/revoke API
    // changes the grant.
    if (input && typeof input === 'object' && input.realmBypass !== undefined) {
      throw new PermissionDeniedError(
        `Permission denied: agent '${agentId}' realmBypass is an operator grant, never a reauthorize input (use grantRealmBypass/revokeRealmBypass)`,
        { callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null, code: 'PERMISSION_DENIED' }
      );
    }
    // Wave U publishing authorities are likewise operator-API-only (ticket
    // 2518510): any claim through this capability path is denied for every
    // caller — the exact injected principal included — so authority can only
    // flow through grantTemplateAuthority/grantHydrationAuthority (or the
    // engine bootstrap).
    if (input && typeof input === 'object'
      && (input.templateAuthority !== undefined || input.hydrationAuthority !== undefined)) {
      throw new PermissionDeniedError(
        `Permission denied: agent '${agentId}' publishing authorities are operator grants, never a reauthorize input `
        + '(use grantTemplateAuthority/revokeTemplateAuthority/grantHydrationAuthority/revokeHydrationAuthority)',
        { callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null, code: 'PERMISSION_DENIED' }
      );
    }
    const activeAgent = this.#uniqueByBareId(this.#agents, agentId);
    // Unknown, recycled, or Realm-ambiguous ids never carry a descriptor.
    if (!activeAgent) return null;
    const identityKey = this.#agentIdentityKeyOf(activeAgent);
    // A capability reauthorize never touches the scope or publishing-authority
    // axes: the current grant states ride along unchanged (the dedicated API is
    // their only writer).
    return this.#registerAgentAuthority(identityKey, agentId, {
      ...this.#currentAuthorityInputs(identityKey),
      privileged: input?.privileged === true,
      allowedTools: input?.allowedTools ?? null
    });
  }

  /**
   * Clears every registered authority descriptor. Called by the facade on
   * `reset()`/`destroy()` so stale descriptor references authorize nothing.
   */

  clearAuthorityRegistry(): void {
    this.#authorityRegistry.clear();
    this.#authorityInputs.clear();
  }

  /**
   * Routes agent mail-subscription setup through the injected TriggerDispatcher port.
   * @param identityKey - Canonical `(realmId, agentId)` registration key to subscribe.
   * @returns Unsubscribe function.
   */
  #setupMailSubscription(identityKey: string): () => void {
    if (!this.#mailPort) return () => {};
    return this.#mailPort.setupAgentMailSubscription(identityKey);
  }

  /**
   * Helper to emit runtime events through the injected SubsystemEmitPort.
   * @param event - Runtime event envelope.
   */
  #emit(event: LifecycleEvent): void {
    if (this.#emitPort) {
      try {
        this.#emitPort.emit(event);
      } catch (err) {
        console.error('Error in AgentLifecycleManager event emission:', err);
      }
    }
  }

  /**
   * Launches and registers a new agent into the runtime.
   *
   * Unified options signature (preferred):
   * `launchAgent({ config, model?, provider?, initialPrompt?, history?, callerContext? })`.
   * Positional polymorphism (backwards compatible):
   * `launchAgent(config, model?, provider?, initialPrompt?)` and
   * `launchAgent(config, initialPrompt?)`.
   *
   * Operational Contract:
   * 1. Validates `config.id` is non-empty; a matching entry that is neither
   *    `TERMINATED` nor `RECYCLED` raises `AGENT_ALREADY_EXISTS`, while a
   *    terminated/recycled entry may be replaced on relaunch. A declared
   *    `history` array is validated fail-closed (roles `user`/`assistant`
   *    only, non-empty string content, unknown fields rejected) with
   *    `INVALID_CONFIG` before any authorization or registration.
   * 2. Enforces Privilege Escalation Prevention (SEC-1, SEC-2, default-deny):
   *    - Every agent id is ordinary (Wave I, ticket c02d0b9): there is no
   *      reserved namespace, and the literal id grants nothing. An
   *      absent/forged caller context is anonymous and cannot spawn
   *      `privileged: true` agents.
   *    - Authority requires a principal whose frozen registry `AuthorityDescriptor`
   *      allows `@lifecycle:authority` (or the wildcard `'*'`): the exact injected
   *      `InternalPrincipal`, a registry descriptor object, or a `callerAgentId`
   *      identity resolved through the registry. Caller-asserted flags and roles
   *      are ignored; id names grant nothing.
   *    - The `realmBypass` grant is composed only when the resolved principal is
   *      the exact injected `InternalPrincipal`; a caller-supplied value is
   *      ignored for every other caller.
   *    - Child agent `allowedTools` are clamped to a subset of the creator's allowed tools.
   *    - A resolved non-authority creator may pin the child workspace only to
   *      the child's own id or to the creator's own resolved workspace key;
   *      reserved keys (`global`, `public`, `realm:<id>:global`) and peer
   *      workspaces are refused with `PERMISSION_DENIED` before any registration
   *      (f44da3e).
   *    - The implicitly resolved key (`workspaceId || workspace || agentId`) is
   *      refused for a non-authority creator when any other registered record
   *      (active or recycled) claims it, and an own-id resolved key is refused
   *      while a VFS workspace with that key already exists (no shadowing of
   *      peer/orphan workspaces), so spawn+self-kill cannot destroy bytes the
   *      child does not own (26c3913).
   * 3. Validates a `toolPreset` selector. A prior recycled entry for this ID is
   *    captured only after the authorization/preset gates and consumed at the
   *    start of the registration phase; if any later step fails, that exact
   *    record is restored — so denied and failed relaunches both leave the
   *    recycled record intact and restorable (b8b94f1).
   * 4. Forwards `config.modelConfig` (when present) to the {@link Agent} entity, which
   *    resolves it against the global model defaults.
   * 5. Binds parentage to the trusted resolver (ticket fc74c52) and composes
   *    Realm membership (`config.realmId`, Realm wave A, f5d1ccc; Realm wave R,
   *    ticket 56ba4b9): for a resolved non-authority creator the stored
   *    `spawnedBy`/`creatorId` are the RESOLVED creator subject and
   *    caller-supplied parentage fields are ignored; a lifecycle-authority
   *    principal or a principal-less host/operator launch keeps the explicit
   *    composition. An explicit `realmId` is honored only for a
   *    lifecycle-authority principal or a principal-less host/operator launch;
   *    a resolved non-authority creator always inherits the RESOLVED creator's
   *    realm (never caller-asserted parentage/realm). Composition is
   *    `config.realmId ?? resolvedCreator.config.realmId ?? realm_generic`, so
   *    every ordinary launch lands in a Realm while an explicit `null` falls
   *    through; only the engine bootstrap (the exact `InternalPrincipal`
   *    composing an explicit `realmId: null`) keeps the bootstrap-only `null`
   *    system scope.
   * 6. Instantiates {@link Agent} domain entity with initial state `AGENT_STATES.IDLE`
   *    and seeds history as `[system message, ...declared entries]` (the system
   *    message first when a system prompt is composed): message ids are
   *    generated at launch through `generateMessageId` (INV-7), an entry
   *    declaring `source: 'template'` carries `metadata.source='template'`
   *    verbatim, and seeding runs no turn and no model call.
   * 7. Registers agent on `MessagingBus` with privilege flag.
   * 8. Sets up reactive mail subscription routing into `TriggerQueue`.
   * 9. Stores agent in internal registry and emits `'state_change'` event (`to: 'idle'`).
   * 10. If `initialPrompt` is provided, awaits the initial conversational turn
   *    before resolving: when the runtime exposes the queue-backed
   *    `enqueueUserTurn` entry the launch directive is dispatched through the
   *    centralized `TriggerQueue` (`TRIGGER_TYPES.USER`, MOD-21 W7); hosts
   *    without a `TriggerQueue` use `runtime.executeAgentTurn` directly.
   *
   * If a later step fails, partial registrations (registry entry, mail
   * subscription, bus registration) are unwound and any consumed recycled entry
   * is restored byte-identically before the error is rethrown.
   *
   * @param optionsOrConfig - Unified {@link LaunchAgentOptions} object (optionally carrying `principal`) or {@link AgentConfig}
   * @param legacyArg2 - Legacy model instance or initial prompt string
   * @param legacyArg3 - Legacy provider value; positional objects are never promoted to caller contexts
   * @param legacyArg4 - Legacy initial prompt string
   * @returns Promise resolving to the newly launched {@link Agent} instance
   * @throws `Error` - With code `'INVALID_CONFIG'` if configuration is invalid, a declared history entry does not conform, or ID is empty
   * @throws `Error` - With code `'AGENT_ALREADY_EXISTS'` if a non-terminated, non-recycled agent with this ID is registered
   * @throws `Error` - With code `'PERMISSION_DENIED'` if privilege escalation invariants are violated
   * @throws `Error` - With code `'INVALID_ARGUMENTS'` if a `toolPreset` selector names no known preset
   *
   * @example
   * ```typescript
   * // Preferred LaunchAgentOptions pattern (registry-resolved identity):
   * const agent = await lifecycleManager.launchAgent({
   *   config: {
   *     id: 'code-reviewer',
   *     name: 'Code Reviewer',
   *     role: 'reviewer',
   *     systemPrompt: 'Perform thorough TypeScript code reviews.',
   *     allowedTools: ['read_file']
   *   },
   *   initialPrompt: 'Review the latest commit diff.',
   *   callerContext: { callerAgentId: 'director' }
   * });
   *
   * // Engine composition root (trusted construction injection):
   * await lifecycleManager.launchAgent({ config: { id: 'system' }, principal: internalPrincipal });
   * ```
   */

  async launchAgent(
    optionsOrConfig: (LaunchAgentOptions & { principal?: InternalPrincipal | AuthorityDescriptor }) | AgentConfig,
    legacyArg2: unknown = null,
    legacyArg3: unknown = null,
    legacyArg4: unknown = null
  ): Promise<Agent> {
    const options: LaunchConfigInput = optionsOrConfig;
    const legacy2: unknown = legacyArg2;
    const legacy3: unknown = legacyArg3;
    const legacy4: unknown = legacyArg4;
    if (!options || typeof options !== 'object') {
      const err: CodedError = new Error('launchAgent requires a valid options or config object');
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    let config: LaunchConfigInput;
    let model: LaunchModel = null;
    let provider: LaunchProvider = null;
    let initialPrompt: string | null = null;
    let callerContext: AgentSecurityContext | null = null;
    let principal: LifecyclePrincipal | null = null;
    // Declared baked history (Wave T, ticket 7e6edae) is read from the unified
    // options object only; legacy positional forms never carry it.
    let historyInput: unknown = null;

    // Detect if optionsOrConfig is LaunchAgentOptions: { config: {...}, model?, provider?, initialPrompt?, history?, callerContext?, principal? }
    if (options.config && typeof options.config === 'object' && typeof options.config.id === 'string') {
      config = { ...options.config };
      model = options.model || null;
      provider = options.provider || model?.provider || null;
      initialPrompt = options.initialPrompt || null;
      callerContext = options.callerContext || null;
      principal = options.principal || null;
      historyInput = options.history ?? null;
    } else {
      config = { ...options };

      if (typeof legacy2 === 'string') {
        initialPrompt = legacy2;
      } else if (isObjectLike(legacy2)) {
        if ('initialPrompt' in legacy2 || 'callerContext' in legacy2 || 'principal' in legacy2) {
          const legacyOptions = asLegacyLaunchArgument(legacy2);
          model = legacyOptions.model || null;
          provider = legacyOptions.provider || model?.provider || null;
          initialPrompt = legacyOptions.initialPrompt || null;
          callerContext = legacyOptions.callerContext || null;
          principal = legacyOptions.principal || null;
        } else {
          model = asLaunchModel(legacy2);
          if (typeof legacy3 === 'string') {
            provider = model?.provider || null;
            initialPrompt = legacy3;
          } else if (isObjectLike(legacy3)) {
            provider = asLaunchProvider(legacy3);
            if (typeof legacy4 === 'string') {
              initialPrompt = legacy4;
            }
          } else {
            provider = model?.provider || null;
            if (typeof legacy4 === 'string') {
              initialPrompt = legacy4;
            }
          }
        }
      } else {
        if (config.model && typeof config.model === 'object') {
          model = config.model;
          provider = config.provider || config.model.provider || null;
        }
        if (typeof legacy3 === 'string') {
          initialPrompt = legacy3;
        } else if (isObjectLike(legacy3)) {
          provider = asLaunchProvider(legacy3);
        }
        if (typeof legacy4 === 'string') {
          initialPrompt = legacy4;
        }
      }
    }

    // Support snake_case aliases on config
    if (!config.systemPrompt && config.system_prompt) {
      config.systemPrompt = config.system_prompt;
    }
    if (!initialPrompt && (config.initial_prompt || config.initialPrompt)) {
      initialPrompt = config.initial_prompt || config.initialPrompt || null;
    }
    // Identity-only compatibility: a config-carried caller context contributes
    // its `callerAgentId` identity, never its authority flags. Authority is
    // always resolved through the registry descriptor of the claimed id.
    if (!callerContext && config.callerContext && typeof config.callerContext === 'object') {
      callerContext = config.callerContext;
    }

    // Declared baked history is validated fail-closed before any authorization,
    // registration, or recycle-bin capture (Wave T, ticket 7e6edae): a
    // malformed entry can never produce a partially launched agent.
    const declaredHistory = normalizeLaunchHistory(historyInput);

    if (!config.id || typeof config.id !== 'string') {
      const err: CodedError = new Error("launchAgent requires a valid string 'id' in config");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const agentId = config.id.trim();
    if (!agentId) {
      const err: CodedError = new Error("launchAgent requires a non-empty 'id' in config");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    // Realm-vocabulary id gate (Wave I, ticket d57cbc1; folded defect
    // eab4e51): an id carrying internal realm vocabulary is refused before any
    // authorization, registration, or recycle-bin capture, for EVERY caller
    // (host/operator included) and with a uniform denial that never repeats
    // the claim — the denial text is a generic phrase, so it can never leak a
    // `realm:`/`system:`/realm-registry-id oracle. The id stays ordinary
    // otherwise: no reserved namespace exists (Wave I, ticket c02d0b9).
    if (isRealmVocabularyId(agentId)) {
      throw new PermissionDeniedError(
        'Agent identifier is refused: the requested id carries internal realm vocabulary',
        { code: 'PERMISSION_DENIED' }
      );
    }

    const triggerPolicy = config.triggerPolicy || 'auto';

    // Universal default-deny authority gating (SEC-1, SEC-2, MOD-21; Wave I,
    // ticket c02d0b9): no caller context => anonymous; `privileged: true`
    // requires lifecycle authority from the registry descriptor of the resolved
    // principal. Every agent id is ordinary — no reserved namespace exists —
    // and caller-asserted flags grant nothing. The `realmBypass` grant is
    // composed only on the exact injected `InternalPrincipal` (engine
    // bootstrap) path below.
    const resolvedPrincipal = this.#resolveCallerPrincipal({ principal, callerContext });
    // Stale pinned caller key (Wave I, ticket d57cbc1; fix lane G5, residual
    // R2): a supplied-but-unresolvable canonical key must fail closed before
    // any realm/workspace composition — never fall through to the anonymous
    // host path, which would launch the child into the seeded Generic default
    // with full workspace pinning. The key claim is read from the same
    // candidates principal resolution consumes, so only callers that actually
    // supplied one are denied; a truly principal-less host launch keeps its
    // legacy semantics.
    const suppliedCallerKey = this.#callerKeyClaim(principal) || this.#callerKeyClaim(callerContext);
    if (!resolvedPrincipal && suppliedCallerKey) {
      throw new PermissionDeniedError(
        'Permission denied: the supplied caller identity could not be resolved',
        { code: 'PERMISSION_DENIED' }
      );
    }
    const hasLifecycleAuthority = principalHasLifecycleAuthority(resolvedPrincipal);
    const isEnginePrincipal = Boolean(resolvedPrincipal && resolvedPrincipal.kind === 'internal');
    const creatorId = resolvedPrincipal && resolvedPrincipal.kind === 'agent' ? resolvedPrincipal.subject : null;
    // Realm-exact creator record (Wave I, ticket d57cbc1; I2-V F1): a
    // descriptor resolved through the trusted canonical caller key reverse-
    // resolves to its exact `(realmId, agentId)` registration, so the
    // composition consumes the caller's own realm record (realm inheritance,
    // SEC-2 clamp, creator-workspace composition) instead of a bare-id
    // unique-match that fails closed on a same-literal-id pair and silently
    // degrades every one of them to the defaults. The bare-id path stays for
    // descriptor-less legacy constructions.
    const creatorIdentityKey = resolvedPrincipal && resolvedPrincipal.kind === 'agent'
      ? this.#identityKeyForDescriptor(resolvedPrincipal)
      : null;
    const creatorAgent = creatorIdentityKey
      ? (this.#agents.get(creatorIdentityKey) || null)
      : (creatorId ? this.getAgent(creatorId) : null);

    if (!hasLifecycleAuthority) {
      if (config.privileged === true) {
        throw new PermissionDeniedError('Caller lacks lifecycle authority to spawn a privileged agent', {
          callerAgentId: creatorId,
          code: 'PERMISSION_DENIED'
        });
      }
    }

    // Realm membership composition (Realm wave A, ticket f5d1ccc; Realm wave R,
    // ticket 56ba4b9; Wave I, ticket c02d0b9). Membership is authority-bearing:
    // a caller-supplied `config.realmId` is honored only for a
    // lifecycle-authority principal or a principal-less host/operator launch
    // (the same trusted classes that keep full workspace pinning), and is
    // ignored for every resolved non-authority creator, which inherits the
    // realm of the RESOLVED creator instead. Parentage claims
    // (`spawnedBy`/`creatorId`) never select the realm — inheritance always
    // resolves through the registry subject (`resolvedPrincipal.subject`), so a
    // forged parent cannot hand a child a foreign Realm scope. Composition is
    // `config.realmId ?? resolvedCreator.config.realmId ?? realm_generic`:
    // every ordinary launch lands in a Realm, and `null` config values fall
    // through. The bootstrap-only null system scope is an engine composition,
    // never an id claim: only the exact injected `InternalPrincipal` may pass
    // an explicit `realmId: null` (the `#directorHost` bootstrap does so).
    //
    // Composition runs before the duplicate check (Wave I, ticket d57cbc1):
    // registration identity is the composite `(realmId, agentId)`, so the
    // same literal id in another Realm is a distinct registration and must
    // launch, while a same-Realm duplicate stays denied.
    const requestedRealmId = typeof config.realmId === 'string' && config.realmId.trim()
      ? config.realmId.trim()
      : null;
    const creatorRealmId = creatorAgent
      && typeof creatorAgent.config?.realmId === 'string'
      && creatorAgent.config.realmId
      ? creatorAgent.config.realmId
      : null;
    const isExplicitSystemScope = config.realmId === null && isEnginePrincipal;
    const realmId = isExplicitSystemScope
      ? null
      : ((hasLifecycleAuthority || !resolvedPrincipal)
          ? (requestedRealmId ?? creatorRealmId ?? GENERIC_REALM_ID)
          : (creatorRealmId ?? GENERIC_REALM_ID));

    // `realmBypass` grant composition (Wave I, ticket c02d0b9): a
    // caller-supplied value is ignored for every non-engine caller; only the
    // exact injected `InternalPrincipal` (the bootstrap path) may compose the
    // hardcoded grant, and operator grants/revokes flow through the dedicated
    // API. The grant never moves membership.
    const realmBypass = isEnginePrincipal && config.realmBypass === true;

    // Wave U publishing-authority composition (ticket 2518510): same engine
    // rule as `realmBypass`. The root system director bootstrap composes both
    // authorities; every other caller's config value is ignored and operator
    // grant/revoke flows exclusively through the dedicated API. Neither grant
    // touches the capability selector or the scope axis.
    const templateAuthority = isEnginePrincipal && config.templateAuthority === true;
    const hydrationAuthority = isEnginePrincipal && config.hydrationAuthority === true;

    // Canonical identity key (Wave I, ticket d57cbc1): the single registry key
    // for this registration. Registry/lookup surfaces stay bare-id (the
    // composite is internal-only), but every map entry keys canonically so a
    // same-id registration in another Realm is a distinct record.
    const identityKey = createAgentIdentityKey(realmId, agentId);

    const existingAgent = this.#agents.get(identityKey);
    if (existingAgent && existingAgent.state !== AGENT_STATES.TERMINATED && existingAgent.state !== AGENT_STATES.RECYCLED) {
      const err: CodedError = new Error(`Agent with ID '${agentId}' is already registered in runtime`);
      err.code = 'AGENT_ALREADY_EXISTS';
      throw err;
    }

    // Spawn workspace confinement (tickets f44da3e, 26c3913, INV-KILL): a
    // resolved principal without lifecycle authority cannot pin or adopt an
    // arbitrary workspace key. Without this gate, a manager-preset agent could
    // spawn a child into any key (`config.workspaceId`/`config.workspace`) — the
    // reserved shared workspaces (`global`, `public`, `realm:<id>:global`) or a
    // peer's private workspace — and then have the child self-kill, evicting
    // that workspace under the engine-bound internal principal. A non-authority
    // pin is honored only when it is the new agent's own id (the default
    // composition) or the creator's own resolved workspace key
    // (shared-workspace composition); every other pin fails closed here, before
    // any registration, so a denied spawn leaves no partially-launched agent.
    // Authority and internal (host/operator) creators keep full pinning.
    //
    // The confinement also covers the resolved key when no pin is supplied
    // (26c3913): a child named after a peer's workspace key, or after a
    // pre-existing/orphan VFS workspace, would otherwise silently adopt that
    // workspace and evict it at self-kill. The resolved key is refused when any
    // other registered record (active or recycled) claims it, and an own-id
    // resolved key is refused while a VFS workspace with that key already
    // exists. Both checks run in the same synchronous pre-registration window
    // as the explicit-pin rule.
    //
    // Reserved key shapes are always-shadowed (e6f10db): the substrate's
    // canonical reserved predicate (`global`, `public`, `realm:<id>:global`,
    // exported by the VirtualFS module as `isReservedWorkspaceKey`) is
    // consulted on the resolved key before the claim/existence checks. An
    // existence-based shadow check alone left a window while the partition was
    // still absent from the VFS — an own-id launch could claim it before
    // allocation and gain read/write ownership of the reserved workspace. The
    // denial fails closed in the same pre-registration window, so a refused
    // launch never captures or consumes a recycled record for the id.
    //
    // Principal-less (anonymous) launches keep the legacy engine/host API
    // behavior: they are not attributable to an agent, are not tool-reachable
    // (the dispatcher always binds the caller identity when one exists), and
    // the pre-existing suite drives direct anonymous `launchAgent` with an
    // explicit workspace (`runtime_coordinator_module_test.js`). Reserved-key
    // destruction stays blocked independently in `deleteWorkspace`.
    const requestedWorkspacePin = typeof config.workspaceId === 'string' && config.workspaceId
      ? config.workspaceId
      : (typeof config.workspace === 'string' && config.workspace ? config.workspace : null);
    const resolvedWorkspaceKey = this.#resolveLaunchWorkspaceKey(realmId, agentId, requestedWorkspacePin);
    if (resolvedPrincipal && !hasLifecycleAuthority) {
      // Reserved shapes are undeletable shared/partition state; they are
      // always-shadowed for a non-authority resolved key, whether or not a
      // workspace with that key currently exists in the VFS. A bare id that
      // names a reserved workspace key is refused too (Wave I, ticket
      // d57cbc1): the id no longer resolves that partition for a Realm-bound
      // launch, but reserved workspace vocabulary must stay unclaimable as an
      // identifier (e6f10db).
      if (isReservedWorkspaceKey(resolvedWorkspaceKey) || isReservedWorkspaceKey(agentId)) {
        throw new PermissionDeniedError(
          `Caller lacks lifecycle authority to spawn agent '${agentId}' into a reserved workspace key`,
          {
            callerAgentId: creatorId,
            workspaceId: resolvedWorkspaceKey,
            requestedId: agentId,
            code: 'PERMISSION_DENIED'
          }
        );
      }

      const creatorWorkspaceKey = creatorId && creatorAgent
        ? this.#resolveWorkspaceKey(creatorAgent, creatorId)
        : null;
      if (
        requestedWorkspacePin &&
        requestedWorkspacePin !== agentId &&
        requestedWorkspacePin !== creatorWorkspaceKey &&
        requestedWorkspacePin !== creatorId
      ) {
        throw new PermissionDeniedError(
          `Caller lacks lifecycle authority to pin a workspace for agent '${agentId}'`,
          {
            callerAgentId: creatorId,
            workspaceId: requestedWorkspacePin,
            requestedId: agentId,
            code: 'PERMISSION_DENIED'
          }
        );
      }

      const excludedClaimantKeys = new Set<string>([identityKey]);
      if (creatorAgent) excludedClaimantKeys.add(this.#agentIdentityKeyOf(creatorAgent));
      if (this.#collectClaimedWorkspaceKeys(excludedClaimantKeys).has(resolvedWorkspaceKey)) {
        throw new PermissionDeniedError(
          `Caller lacks lifecycle authority to spawn agent '${agentId}' into a workspace claimed by another registered agent`,
          {
            callerAgentId: creatorId,
            workspaceId: resolvedWorkspaceKey,
            requestedId: agentId,
            code: 'PERMISSION_DENIED'
          }
        );
      }
      // Own-id shadowing (26c3913; Wave I, ticket d57cbc1): the default
      // resolved key is the canonical identity for a Realm-bound launch, so
      // both that partition and the legacy bare-id partition it may later be
      // remapped onto are checked — a pre-existing/orphan workspace can never
      // be silently adopted, whatever storage generation it belongs to.
      const ownResolvedKey = resolvedWorkspaceKey === agentId || resolvedWorkspaceKey === identityKey;
      if (
        ownResolvedKey &&
        this.#virtualFs &&
        typeof this.#virtualFs.hasWorkspace === 'function' &&
        (this.#virtualFs.hasWorkspace(resolvedWorkspaceKey) || this.#virtualFs.hasWorkspace(agentId))
      ) {
        throw new PermissionDeniedError(
          `Caller lacks lifecycle authority to spawn agent '${agentId}' into a pre-existing workspace`,
          {
            callerAgentId: creatorId,
            workspaceId: resolvedWorkspaceKey,
            requestedId: agentId,
            code: 'PERMISSION_DENIED'
          }
        );
      }
    }

    const privileged = hasLifecycleAuthority && Boolean(config.privileged);

    // Parentage binding (ticket fc74c52). For a resolved non-authority creator
    // the stored parentage is the RESOLVED creator principal — the caller's
    // `spawnedBy`/`creatorId` fields are ignored, so an unprivileged creator
    // cannot inject a child into a third party's visibility scope or graft
    // parent lifecycle authority onto a forged parent. Lifecycle authority and
    // principal-less host/operator launches keep the explicit composition (the
    // operator/director composition path and the legacy host API drive
    // explicit parentage; see `runtime_coordinator_module_test` and the
    // `9133495` repro).
    const parentageIsCallerSelectable = hasLifecycleAuthority || !resolvedPrincipal;
    const composedParentage = parentageIsCallerSelectable
      ? {
          spawnedBy: config.spawnedBy || null,
          creatorId: config.creatorId || config.spawnedBy || null
        }
      : { spawnedBy: creatorId, creatorId };

    // Spawn preset validation (BUG-ENC-011): when `toolPreset` is the effective
    // tool selector it must name a known preset or '*'.
    const presetSelector = config.toolPreset !== undefined ? config.toolPreset : config.tool_preset;
    if (
      presetSelector !== undefined &&
      config.allowedTools === undefined &&
      config.tools === undefined
    ) {
      const normalizedPreset = typeof presetSelector === 'string' ? presetSelector.trim().toLowerCase() : '';
      const isValidPreset = normalizedPreset === '*' || Object.prototype.hasOwnProperty.call(TOOL_PRESETS, normalizedPreset);
      if (!isValidPreset) {
        const err: CodedError = new Error(`Invalid toolPreset '${presetSelector}'. Expected a known preset identifier.`);
        err.code = 'INVALID_ARGUMENTS';
        throw err;
      }
    }

    // Capture any recycled record for this (realm, id) registration (b8b94f1).
    // Deliberately after every authorization/preset gate: a denied relaunch
    // must leave the recycled record byte-identical and restorable. The lookup
    // is scoped to the canonical identity key (Wave I, ticket d57cbc1), so a
    // recycled record of the same literal id in another Realm is never
    // consumed by this launch. Consumption is deferred to the relaunch try
    // below, whose catch restores this exact record if any later step fails.
    const previousRecycledAgent = this.#recycleBin.get(identityKey) || null;

    const rawTools = config.allowedTools !== undefined
      ? config.allowedTools
      : (config.tools !== undefined
        ? config.tools
        : (config.toolPreset !== undefined
          ? config.toolPreset
          : (config.tool_preset !== undefined ? config.tool_preset : config.role)));
    let allowedTools = resolveToolPreset(rawTools);

    // If creator is unprivileged, clamp allowedTools to creator's allowedTools subset (SEC-2)
    if (creatorAgent && !hasLifecycleAuthority && creatorAgent.config?.allowedTools) {
      const creatorTools = resolveToolPreset(creatorAgent.config.allowedTools);
      if (Array.isArray(creatorTools) && !creatorTools.includes('*')) {
        const creatorToolSet = new Set(creatorTools);
        if (Array.isArray(allowedTools)) {
          if (allowedTools.includes('*')) {
            allowedTools = [...creatorTools];
          } else {
            allowedTools = allowedTools.filter(t => creatorToolSet.has(t));
          }
        } else {
          allowedTools = [...creatorTools];
        }
      }
    }

    // Capability sanitization (0c49cba, MOD-21 W8): wildcard tool access is not
    // authority. A principal without lifecycle authority cannot place the
    // wildcard `'*'` or the `'@lifecycle:authority'` capability into the
    // composed whitelist (and therefore into the frozen registry descriptor),
    // regardless of whether the selector arrived as `allowedTools`, `tools`,
    // `toolPreset`, or a `role` alias. The operator path may still grant them.
    if (!hasLifecycleAuthority && Array.isArray(allowedTools)) {
      allowedTools = allowedTools.filter(
        (tool) => tool !== '*' && tool !== LIFECYCLE_AUTHORITY_CAPABILITY
      );
    }

    // Publishing authorities are grants, never selector data (Wave U, ticket
    // 2518510): the explicit `@template:authority`/`@hydration:authority` ids
    // are stripped from every composed selector for every caller, so no
    // launch/spawn config can smuggle them into the frozen descriptor. The
    // dedicated operator grant API and the engine bootstrap are their only
    // writers (and the descriptor rebuild strips them again as defense in
    // depth).
    if (Array.isArray(allowedTools)) {
      allowedTools = allowedTools.filter((tool) => !META_AUTHORITY_IDS.has(tool));
    }

    const composedConfig = {
      id: agentId,
      name: config.name || agentId,
      role: config.role || (privileged ? 'admin' : ''),
      systemPrompt: config.systemPrompt || '',
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.3,
      maxTurns: typeof config.maxTurns === 'number' ? Math.max(1, config.maxTurns) : undefined,
      triggerPolicy,
      privileged,
      workspaceId: config.workspaceId || config.workspace || agentId,
      allowedTools,
      tools: allowedTools,
      mailboxAutonomy: config.mailboxAutonomy !== undefined ? Boolean(config.mailboxAutonomy) : null,
      customTools: config.customTools || null,
      customToolSchemas: config.customToolSchemas || null,
      spawnedBy: composedParentage.spawnedBy,
      creatorId: composedParentage.creatorId,
      realmId,
      settings: config.settings || null,
      modelConfig: (config.modelConfig && typeof config.modelConfig === 'object')
        ? { ...config.modelConfig }
        : undefined,
      // MOD-20 binding passthrough: the caller's preset id (when supplied) is
      // composed verbatim so the entity can materialize the bound preset.
      ...(typeof config.presetId === 'string' && config.presetId
        ? { presetId: config.presetId }
        : {})
    };

    // Seed composition (Realm Template Format v1 §5 step 4; Wave T, ticket
    // 7e6edae): `[system message (as today), ...declared entries in declared
    // order]`. Ids are generated at launch through `generateMessageId` (INV-7);
    // an entry declaring `source: 'template'` carries `metadata.source`
    // verbatim. Seeding is pure composition — it never runs a turn or a model
    // call; only `initialPrompt` triggers one (below).
    const initialHistory: HistoryMessage[] = [];
    if (composedConfig.systemPrompt) {
      initialHistory.push({
        id: generateMessageId('sys'),
        role: 'system',
        content: composedConfig.systemPrompt
      });
    }
    for (const entry of declaredHistory) {
      const seededMessage: HistoryMessage = {
        id: generateMessageId(entry.role),
        role: entry.role,
        content: entry.content
      };
      if (entry.source === 'template') {
        seededMessage.metadata = { source: 'template' };
      }
      initialHistory.push(seededMessage);
    }

    const agentInstance = new Agent(
      {
        ...composedConfig,
        history: initialHistory,
        state: AGENT_STATES.IDLE,
        stateDetail: 'Agent launched'
      },
      model,
      provider,
      this.#credentialResolver,
      this.#authorityChannel,
      this.#presetSource
    );

    try {
      // Consume the prior recycled record at the start of the relaunch phase;
      // the catch below restores it byte-identically on any failure so
      // `restoreAgent(id)` can be retried.
      this.#recycleBin.delete(identityKey);

      // Build the frozen authority descriptor once at construction from the
      // trusted composed config (never from caller data). `realmBypass` and
      // the Wave U publishing grants are the engine-composed values only; a
      // caller-supplied value was ignored above for every non-engine
      // principal.
      this.#registerAgentAuthority(identityKey, agentId, {
        privileged,
        allowedTools: composedConfig.allowedTools,
        realmBypass,
        templateAuthority,
        hydrationAuthority
      });

      // Register on MessagingBus under the canonical registration key (Wave
      // I, ticket d57cbc1): the bus partitions on the opaque identifier, so a
      // same-id registration in another Realm never shares a mailbox.
      if (this.#messagingBus && typeof this.#messagingBus.registerAgent === 'function') {
        this.#messagingBus.registerAgent(identityKey, {
          privileged
        });
      }

      // Cleanup previous subscription if any
      const prevSub = this.#messageSubscriptions.get(identityKey);
      if (prevSub) {
        try {
          prevSub();
        } catch {
          // Best-effort unsubscribe; the subscription entry is deleted regardless.
        }
        this.#messageSubscriptions.delete(identityKey);
      }

      // Setup reactive wakeup subscription routing through TriggerQueue
      const unsub = this.#setupMailSubscription(identityKey);
      this.#messageSubscriptions.set(identityKey, unsub);

      this.#agents.set(identityKey, agentInstance);

      // Emit initial registration state
      this.#emit({
        type: 'state_change',
        agentId,
        payload: {
          from: null,
          to: AGENT_STATES.IDLE,
          previousState: null,
          currentState: AGENT_STATES.IDLE,
          stateDetail: 'Agent launched'
        }
      });

      // If initial prompt provided, execute initial turn. The launch directive
      // is user-initiated: prefer the queue-backed `enqueueUserTurn` entry so it
      // enters the centralized TriggerQueue (MOD-21 W7 single dispatch point);
      // hosts without a TriggerQueue fall back to the direct turn engine. The
      // turn is addressed by the launched agent's canonical identity key (Wave
      // I, ticket d57cbc1; fix lane G2): the launch path already knows the key,
      // while a bare id is Realm-ambiguous for a lawful same-id pair and fails
      // closed (`AGENT_NOT_FOUND`) — the second same-id launch with an initial
      // prompt would roll back otherwise.
      if (initialPrompt !== null && initialPrompt !== undefined && initialPrompt !== '') {
        if (this.#runtime && typeof this.#runtime.executeAgentTurn === 'function') {
          await (typeof this.#runtime.enqueueUserTurn === 'function'
            ? this.#runtime.enqueueUserTurn(identityKey, initialPrompt)
            : this.#runtime.executeAgentTurn(identityKey, initialPrompt));
        }
      }

      return agentInstance;
    } catch (err) {
      // Spawn failure cleanup: unwind partial registrations
      this.#agents.delete(identityKey);
      this.#authorityRegistry.delete(identityKey);
      this.#authorityInputs.delete(identityKey);
      const sub = this.#messageSubscriptions.get(identityKey);
      if (sub) {
        try { sub(); } catch { /* Best-effort cleanup; the partial launch failure below is authoritative. */ }
        this.#messageSubscriptions.delete(identityKey);
      }
      try {
        if (this.#messagingBus && typeof this.#messagingBus.unregisterAgent === 'function') {
          this.#messagingBus.unregisterAgent(identityKey);
        }
      } catch {
        // Bus unregistration is best-effort; the original launch error is rethrown below.
      }
      // Restore the consumed recycled record byte-identically (failed-relaunch
      // regression): a failed relaunch must not destroy the recycle-bin entry.
      if (previousRecycledAgent) {
        this.#recycleBin.set(identityKey, previousRecycledAgent);
      }
      throw err;
    }
  }

  /**
   * Dynamically spawn a new agent instance (alias for launchAgent).
   * 
  /**
   * Dynamic spawn alias for {@link launchAgent}.
   * Spawns a new subagent with identical privilege validation and registration hooks.
   *
   * @param optionsOrConfig - Unified {@link LaunchAgentOptions} or {@link AgentConfig}
   * @param legacyArg2 - Legacy parameter bridge
   * @param legacyArg3 - Legacy parameter bridge
   * @param legacyArg4 - Legacy parameter bridge
   * @returns Promise resolving to the spawned {@link Agent} instance
   * @throws `Error` - With the same codes as {@link launchAgent} (validation, privilege, and preset errors)
   * @see launchAgent
   *
   * @example
   * ```typescript
   * const childAgent = await lifecycleManager.spawnAgent({
   *   config: { id: 'worker-1', role: 'helper' },
   *   callerContext: { callerAgentId: 'parent-agent', isPrivileged: false }
   * });
   * ```
   */

  async spawnAgent(
    optionsOrConfig: LaunchAgentOptions | AgentConfig,
    legacyArg2: unknown = null,
    legacyArg3: unknown = null,
    legacyArg4: unknown = null
  ): Promise<Agent> {
    return this.launchAgent(optionsOrConfig, legacyArg2, legacyArg3, legacyArg4);
  }

  /**
   * Retrieves an active agent instance by ID or canonical identity key.
   *
   * Reference resolution (Wave I, ticket d57cbc1): a canonical
   * `(realmId, agentId)` key resolves its exact registration first; every
   * other reference keeps the unique-match bare-id rule (an id registered in
   * two Realms is ambiguous and resolves `null` — fail closed, never a
   * wrong-Realm pick).
   *
   * @param agentId - Unique agent identifier, or a canonical identity key.
   * @returns The active {@link Agent} instance, or `null` if not found in active registry
   *
   * @example
   * ```typescript
   * const agent = lifecycleManager.getAgent('coder');
   * if (agent) {
   *   console.log(`Agent state: ${agent.state}`);
   * }
   * ```
   */

  getAgent(agentId: string): Agent | null {
    if (!agentId || typeof agentId !== 'string') return null;
    const byKey = this.#agents.get(agentId);
    if (byKey) return byKey;
    return this.#uniqueByBareId(this.#agents, agentId);
  }

  /**
   * Retrieves a soft-killed / recycled agent instance by ID or canonical
   * identity key from the recycle bin.
   *
   * Reference resolution (Wave I, ticket d57cbc1): a canonical key resolves
   * its exact recycled registration first; every other reference keeps the
   * unique-match bare-id rule (ambiguous ids resolve `null`).
   *
   * @param agentId - Unique agent identifier, or a canonical identity key.
   * @returns The recycled {@link Agent} instance, or `null` if not in recycle bin
   *
   * @example
   * ```typescript
   * const recycledAgent = lifecycleManager.getRecycledAgent('old-worker');
   * ```
   */

  getRecycledAgent(agentId: string): Agent | null {
    if (!agentId || typeof agentId !== 'string') return null;
    const byKey = this.#recycleBin.get(agentId);
    if (byKey) return byKey;
    return this.#uniqueByBareId(this.#recycleBin, agentId);
  }

  /**
   * Checks if an agent is dead, terminated, or currently in the recycle bin.
   *
   * @param agentId - Unique agent identifier
   * @returns `true` if terminated, recycled, or absent from runtime; `false` otherwise
   *
   * @example
   * ```typescript
   * if (lifecycleManager.isAgentTerminated('worker-1')) {
   *   console.log('Worker is not available for tasks.');
   * }
   * ```
   */

  isAgentTerminated(agentId: string): boolean {
    if (!agentId || typeof agentId !== 'string') return true;
    // Canonical identity key (Wave I, ticket d57cbc1): the exact registration
    // resolves realm-exactly; an ambiguous bare id keeps failing closed.
    const byKey = this.#agents.get(agentId);
    if (byKey) {
      return byKey.state === AGENT_STATES.TERMINATED || byKey.state === AGENT_STATES.RECYCLED;
    }
    if (this.#recycleBin.has(agentId)) return true;
    // Ambiguous bare ids fail closed (Wave I, ticket d57cbc1): when the same
    // literal id is registered in more than one scope, no id-only consumer can
    // know which record is meant, so the id reports terminated and substrates
    // skip it rather than act on a guess. A recycled match anywhere also
    // reports terminated (there is no per-scope routing on a bare id yet).
    if (this.#countByBareId(this.#recycleBin, agentId) > 0) return true;
    if (this.#countByBareId(this.#agents, agentId) !== 1) return true;
    const agent = this.#uniqueByBareId(this.#agents, agentId);
    return agent === null || agent.state === AGENT_STATES.TERMINATED || agent.state === AGENT_STATES.RECYCLED;
  }

  /**
   * Checks if an agent is currently busy executing a turn or in a waiting/canceling state.
   *
   * Returns `true` if `agent.currentTurnPromise` is active, or state is `RUNNING`,
   * `WAITING_FOR_MESSAGE`, `WAITING_FOR_INPUT`, `WAITING_FOR_DEPENDENTS`, or `CANCELING`.
   *
   * @param agentId - Unique agent identifier
   * @returns `true` if busy executing or blocked; `false` if idle or absent
   *
   * @example
   * ```typescript
   * if (!lifecycleManager.isAgentBusy('coder')) {
   *   await runtime.executeAgentTurn('coder', 'Next prompt');
   * }
   * ```
   */

  isAgentBusy(agentId: string): boolean {
    if (!agentId || typeof agentId !== 'string') return false;
    const agent = this.#agents.get(agentId) || this.#uniqueByBareId(this.#agents, agentId);
    if (!agent) return false;
    return Boolean(
      agent.currentTurnPromise ||
      agent.state === AGENT_STATES.RUNNING ||
      agent.state === AGENT_STATES.WAITING_FOR_MESSAGE ||
      agent.state === AGENT_STATES.WAITING_FOR_INPUT ||
      agent.state === AGENT_STATES.WAITING_FOR_DEPENDENTS ||
      agent.state === AGENT_STATES.CANCELING
    );
  }

  /**
   * Transitions an agent to a new lifecycle state with strict FSM matrix validation (INV-2).
   *
   * State Transition Matrix:
   * - `idle` -\> `running`, `idle`, `terminated`, `recycled`
   * - `running` -\> `idle`, `waiting_for_input`, `waiting_for_dependents`, `waiting_for_message`, `canceling`, `errored`, `running`, `terminated`, `recycled`
   * - `waiting_for_input` -\> `running`, `idle`, `canceling`, `errored`, `terminated`, `recycled`
   * - `waiting_for_dependents` -\> `running`, `idle`, `canceling`, `errored`, `terminated`, `recycled`
   * - `waiting_for_message` -\> `running`, `idle`, `waiting_for_message`, `canceling`, `errored`, `terminated`, `recycled`
   * - `canceling` -\> `idle`, `errored`, `terminated`, `recycled`
   * - `errored` -\> `idle`, `running`, `terminated`, `recycled`
   * - `terminated` -\> `idle`, `running`, `recycled`
   * - `recycled` -\> `idle`, `terminated`, `recycled`
   *
   * Emits `'state_change'` event with `{ from, to, previousState, currentState, stateDetail }`.
   *
   * Authority gate (MOD-21 W8, default-deny): a resolved principal is mandatory.
   * Sudoer authority comes from the frozen registry descriptor; self/parent
   * eligibility comes from registry parentage (`spawnedBy`/`creatorId`). Engine
   * subsystems transition through the composition-root `InternalPrincipal`
   * binding; anonymous and unprivileged non-parent callers are denied with
   * `PERMISSION_DENIED` before any mutation.
   *
   * @param agentOrId - Target Agent instance or agent ID string
   * @param newState - Desired destination state from {@link AGENT_STATES}
   * @param stateDetail - Optional descriptive detail or reason for the transition
   * @param callerContext - Caller context carrying either `principal` (the exact
   *   injected `InternalPrincipal` or a frozen registry `AuthorityDescriptor`) or a
   *   `callerAgentId`/`agentId` identity claim resolved through the registry
   * @returns The updated {@link Agent} instance
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if target agent does not exist
   * @throws `Error` - With code `'INVALID_STATE_TRANSITION'` if transition is illegal under FSM matrix
   * @throws `Error` - With code `'PERMISSION_DENIED'` if the caller is anonymous or lacks self/parent/sudoer authority
   *
   * @example
   * ```typescript
   * import { AGENT_STATES } from './agent/index.ts';
   *
   * lifecycleManager.transitionAgentState(
   *   'coder',
   *   AGENT_STATES.RUNNING,
   *   'Executing turn 3',
   *   { callerAgentId: 'coder' }
   * );
   * ```
   */

  transitionAgentState(
    agentOrId: string | Agent,
    newState: AgentState,
    stateDetail: string | null = null,
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent {
    let agent: Agent | null;
    if (typeof agentOrId === 'string') {
      // Realm-scoped resolution (Wave I, ticket d57cbc1): a realm-bound caller
      // addresses its own registration first; foreign-only ids fall through to
      // the realm gate, and ambiguous ids fail closed.
      const resolved = this.#resolveMutationTarget(agentOrId, callerContext);
      agent = resolved.active || resolved.recycled;
    } else {
      agent = agentOrId;
    }
    if (!agent) {
      const err: CodedError = new Error(`Cannot set state: agent '${agentOrId}' not found`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    this.#authorizeLifecycleMutation(agent.id, callerContext, {
      action: 'transition the state of',
      targetAgent: agent
    });

    return this.#applyStateTransition(agent, newState, stateDetail);
  }

  /**
   * Backwards-compatible alias for {@link transitionAgentState}.
   *
   * @param agentOrId - Target Agent instance or agent ID string
   * @param newState - Desired destination state from {@link AGENT_STATES}
   * @param stateDetail - Optional descriptive detail or reason
   * @param callerContext - Caller context carrying `principal` or a registry-resolved `callerAgentId` identity
   * @returns The updated {@link Agent} instance
   *
   * @example
   * ```typescript
   * lifecycleManager.setAgentState('coder', AGENT_STATES.IDLE, 'Turn complete', { callerAgentId: 'coder' });
   * ```
   */

  setAgentState(
    agentOrId: string | Agent,
    newState: AgentState,
    stateDetail: string | null = null,
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent {
    return this.transitionAgentState(agentOrId, newState, stateDetail, callerContext);
  }

  /**
   * Soft-kills an agent (INV-KILL).
   *
   * Destructive capability: a successful kill also permanently evicts the
   * target's private VirtualFS workspace — a filesystem deletion, not just the
   * registry mutation. Authorization is therefore relationship-based, never
   * capability-based: it does not consult the caller's write/delete tool
   * grants. A trusted principal is mandatory; only lifecycle authority
   * (sudoer), the registered parent creator, or the agent itself may kill. The
   * eviction key is the target's resolved workspace
   * (`config.workspaceId || config.workspace || agent id`), so an agent
   * launched into an explicit workspace evicts exactly that workspace; a
   * workspace named after the raw agent id is never touched unless it is the
   * resolved key (ticket 4e9e0c8).
   *
   * Operational Flow (Atomic Teardown):
   * 1. Validates authority before any mutation (default-deny): a principal is
   *    mandatory — an omitted context is anonymous and denied. Sudoer authority
   *    comes from the principal's registry `AuthorityDescriptor` (`allow` set
   *    containing `'*'` or `'@lifecycle:authority'`, or the exact injected
   *    `InternalPrincipal`); self and parent-creator kills come from registry
   *    parentage (`spawnedBy`/`creatorId`). Caller-asserted `isAdmin`/
   *    `isPrivileged`/`privileged` flags and reserved ids grant nothing.
   *    Authorization precedes the idempotent recycled short-circuit, so an
   *    unauthorized caller receives `PERMISSION_DENIED` and no facade timer
   *    teardown occurs (f016a6b).
   * 2. Immediately aborts in-flight turn execution via `agent.abortController` and clears promise lock.
   * 3. Evicts the private tenant workspace resolved as
   *    `config.workspaceId || config.workspace || agent id` from VirtualFS
   *    (`deleteWorkspace(resolvedKey)`), preserving `/global`; the eviction is
   *    skipped while another registered record (active or recycled) resolves
   *    to the same key — last-claimant cleanup (26c3913).
   * 4. Unsubscribes mailbox listener and marks agent terminated on `MessagingBus`.
   * 5. Cancels pending invocations via `InvocationEngine.cancelPendingInvocationsForAgent` using the
   *    resolved reason: `'Terminated'` when the caller omits one, and `'AGENT_TERMINATED'` only when
   *    the caller explicitly passes an empty/null reason.
   * 6. Sets state to `AGENT_STATES.RECYCLED`, recording `recycledAt` and `recycleReason`, and clears
   *    ephemeral state (`currentStream`, `currentReasoning`, `activeToolCalls`, `pendingPrecalls`, `lastSummary`).
   * 7. Migrates agent from active registry to `recycleBin`.
   * 8. Emits `'state_change'`, `'agent_recycled'`, and `'agent_killed'` events.
   *
   * Zero Zombie Invariant: Soft-killed recycled agents NEVER receive reactive trigger wakeups.
   * Scheduled-timer teardown is not performed here: `AgentRuntime.killAgent` runs
   * `RuntimeScheduler.teardownForAgent` only after this authorization + recycle flow
   * succeeds, so a denied kill leaves the victim's timers untouched.
   *
   * @param agentId - Target agent identifier to soft-kill
   * @param reason - Termination reason description (defaults to `'Terminated'`)
   * @param callerContext - Caller context carrying either `principal` (the exact
   *   injected `InternalPrincipal` or a frozen registry `AuthorityDescriptor`) or a
   *   `callerAgentId`/`agentId` identity claim resolved through the registry.
   *   Authority flags on this object are ignored.
   * @returns The recycled {@link Agent} instance; an authorized already-recycled ID
   *   returns its recycle-bin entry unchanged
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is empty or invalid
   * @throws `Error` - With code `'NOT_FOUND'` if the ID is absent from both the active registry and the recycle bin
   * @throws `Error` - With code `'PERMISSION_DENIED'` if the caller lacks a principal or authority to kill the agent
   *
   * @example
   * ```typescript
   * const recycled = lifecycleManager.killAgent('worker-1', 'Task finished', {
   *   callerAgentId: 'director'
   * });
   * ```
   */

  killAgent(
    agentId: string,
    reason: string = 'Terminated',
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("killAgent requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const target = this.#resolveMutationTarget(agentId, callerContext);
    const agent = target.active;
    // Resolve the recycle-bin record up front (f016a6b) so the authorization gate
    // below runs before the idempotent recycled short-circuit. Otherwise an
    // unauthorized caller would receive a success receipt and the facade would
    // tear down the recycled agent's timers.
    const recycledAgent = agent ? null : target.recycled;
    if (!agent && !recycledAgent) {
      // BUG-ENC-015: unknown agent must surface NOT_FOUND, not success/null.
      const err: CodedError = new Error(`Agent '${this.#displayAgentId(agentId)}' not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    // Security Authority Governance [INV-ADMIN] & [INV-KILL] — default-deny.
    // A principal is mandatory: an omitted context is anonymous and denied.
    // Sudoer authority comes from the registry `AuthorityDescriptor`; self and
    // parent-creator relationships come from registry parentage. Caller flags
    // and reserved ids grant nothing.
    const principal = this.#resolveCallerPrincipal({ callerContext });
    const targetAgent = agent || recycledAgent;
    const callerId = principal && principal.kind === 'agent' ? principal.subject : null;
    const isSudoer = principalHasLifecycleAuthority(principal);
    const isSelf = Boolean(callerId) && callerId === agentId;
    const isParent = Boolean(callerId) && (targetAgent?.config?.spawnedBy === callerId || targetAgent?.config?.creatorId === callerId);

    // Realm confinement (Realm wave A, ticket 3487c56) runs before the
    // authority verdict: a cross-scope target is denied fail-closed even for
    // wildcard/privileged callers, while the same-scope self/parent/sudoer
    // relationships keep their existing semantics.
    this.#assertRealmScope(principal, targetAgent, 'terminate', agentId);

    if (!isSudoer && !isSelf && !isParent) {
      const error = new PermissionDeniedError(
        `Permission denied: ${callerId ? `agent '${callerId}'` : 'anonymous caller'} cannot terminate agent '${this.#displayAgentId(agentId, targetAgent)}' (must be sudoer, parent creator, or the agent itself)`,
        {
          callerAgentId: callerId || null,
          code: 'PERMISSION_DENIED'
        }
      );
      error.code = 'PERMISSION_DENIED';
      throw error;
    }

    // Idempotent soft-kill of an already-recycled agent (authorized above):
    // return the existing record unchanged.
    if (!agent) {
      return recycledAgent as Agent;
    }

    const previousState = agent.state;
    const identityKey = this.#agentIdentityKeyOf(agent);

    // 1. Immediately abort active in-flight turn if executing
    if (agent.abortController) {
      try {
        agent.abortController.abort(reason || 'Terminated');
      } catch {
        // Abort is best-effort; teardown below proceeds regardless.
      }
    }
    agent.currentTurnPromise = null;

    // 2. Private Workspace Eviction [REQ-LIFECYCLE-02]: evict the resolved
    // workspace key (never the raw agent id when config.workspaceId differs),
    // preserving /global. The eviction is claim-aware (26c3913): while another
    // registered record — an active peer or a recycled co-claimant, including
    // the creator of a child that shares its workspace — resolves to the same
    // key, the bytes are shared and survive until the last claimant's teardown.
    // Tenant administration is an engine path: the opaque internal principal
    // authorizes the VFS eviction (MOD-21 W8-D, 4e9e0c8).
    const killWorkspaceKey = this.#resolveWorkspaceKey(agent, agentId);
    if (
      this.#virtualFs &&
      typeof this.#virtualFs.deleteWorkspace === 'function' &&
      !this.#isWorkspaceKeyClaimedByOther(killWorkspaceKey, identityKey)
    ) {
      this.#virtualFs.deleteWorkspace(
        killWorkspaceKey,
        { principal: this.#internalPrincipal ?? undefined }
      );
    }

    // 3. Unregister messaging bus subscriptions & mark mailbox dead/inactive
    const unsub = this.#messageSubscriptions.get(identityKey);
    if (unsub) {
      try {
        unsub();
      } catch {
        // Best-effort unsubscribe; the subscription entry is removed regardless.
      }
      this.#messageSubscriptions.delete(identityKey);
    }

    if (this.#messagingBus && typeof this.#messagingBus.markAgentTerminated === 'function') {
      this.#messagingBus.markAgentTerminated(identityKey);
    } else if (this.#messagingBus && typeof this.#messagingBus.unregisterAgent === 'function') {
      this.#messagingBus.unregisterAgent(identityKey);
    }

    // 4. Invocations Teardown [AC-EPIC08-04]: cancel in-flight invocations immediately with AGENT_TERMINATED
    if (this.#invocationEngine && typeof this.#invocationEngine.cancelPendingInvocationsForAgent === 'function') {
      this.#invocationEngine.cancelPendingInvocationsForAgent(identityKey, reason || 'AGENT_TERMINATED');
    } else if (this.#runtime?.invocationEngine && typeof this.#runtime.invocationEngine.cancelPendingInvocationsForAgent === 'function') {
      this.#runtime.invocationEngine.cancelPendingInvocationsForAgent(identityKey, reason || 'AGENT_TERMINATED');
    }

    // 5. State & Metadata Mutation
    const recycledTimestamp = new Date().toISOString();
    agent.state = AGENT_STATES.RECYCLED;
    agent.recycledAt = recycledTimestamp;
    agent.recycleReason = reason || 'Terminated';
    agent.stateDetail = reason || 'Terminated';
    agent.updatedAt = Date.now();
    agent.abortController = null;
    agent.currentStream = '';
    agent.currentReasoning = '';
    agent.activeToolCalls = [];
    agent.pendingPrecalls = [];
    agent.lastSummary = null;

    // 6. Map Migration: Remove from active agents and insert into recycleBin.
    // The authority descriptor dies with the active registration so a cached
    // descriptor reference can no longer authorize anything.
    this.#agents.delete(identityKey);
    this.#authorityRegistry.delete(identityKey);
    this.#authorityInputs.delete(identityKey);
    this.#recycleBin.set(identityKey, agent);

    // 7. Event Emissions
    this.#emit({
      type: 'state_change',
      agentId: agent.id,
      payload: {
        from: previousState,
        to: AGENT_STATES.RECYCLED,
        previousState,
        currentState: AGENT_STATES.RECYCLED,
        stateDetail: agent.stateDetail
      }
    });

    this.#emit({
      type: 'agent_recycled',
      agentId: agent.id,
      payload: {
        agentId: agent.id,
        reason: agent.recycleReason,
        recycledAt: agent.recycledAt
      }
    });

    this.#emit({
      type: 'agent_killed',
      agentId: agent.id,
      payload: {
        agentId: agent.id,
        reason: agent.recycleReason,
        recycledAt: agent.recycledAt
      }
    });

    return agent;
  }

  /**
   * Restores a soft-killed agent from the recycle bin back to active status in `IDLE` state (INV-RESTORE).
   *
   * Operational Flow:
   * 1. Validates agent exists in `recycleBin`.
   * 2. Authorizes the restore: a resolved principal is mandatory; a
   *    live-construction record whose descriptor would regain authority
   *    (`privileged` or wildcard/lifecycle capability tool selectors) requires
   *    lifecycle authority, otherwise sudoer, parent creator, or the agent
   *    itself may restore. Snapshot-provenance records re-enter default-deny
   *    and never require a sudoer (f6be691).
   * 3. Migrates agent from `recycleBin` to active registry.
   * 4. Clears `recycledAt` and `recycleReason`, transitioning state to `AGENT_STATES.IDLE`.
   * 5. Re-registers agent on `MessagingBus` (`unmarkAgentTerminated`, `registerAgent`).
   * 6. Re-wires reactive mail subscription routing into `TriggerQueue`.
   * 7. Emits `'state_change'` and `'agent_restored'` events.
   *
   * @param agentId - Unique identifier of agent in recycle bin
   * @param callerContext - Caller context carrying either `principal` (the exact
   *   injected `InternalPrincipal` or a frozen registry `AuthorityDescriptor`) or a
   *   `callerAgentId`/`agentId` identity claim resolved through the registry
   * @returns The restored {@link Agent} instance
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is empty or invalid
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if agent is not present in recycle bin
   * @throws `Error` - With code `'PERMISSION_DENIED'` if the caller is anonymous or lacks restore authority
   *
   * @example
   * ```typescript
   * const restoredAgent = lifecycleManager.restoreAgent('worker-1', { callerAgentId: 'director' });
   * console.log(`Agent restored in state: ${restoredAgent.state}`);
   * ```
   */

  restoreAgent(
    agentId: string,
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("restoreAgent requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const agent = this.#resolveMutationTarget(agentId, callerContext).recycled;
    if (!agent) {
      const err: CodedError = new Error(`Agent '${this.#displayAgentId(agentId)}' not found in recycle bin`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }
    const identityKey = this.#agentIdentityKeyOf(agent);

    this.#authorizeLifecycleMutation(agentId, callerContext, {
      action: 'restore',
      targetAgent: agent,
      requireSudoer: this.#wouldRestoreAuthority(agent)
    });

    // 1. Move from recycleBin to active agents and re-derive the frozen
    // authority descriptor. Config authority fields are trusted only for a
    // live-construction entity; a record hydrated from a snapshot re-enters
    // default-deny regardless of persisted `allowedTools`/privilege data
    // (MOD-21 W5/W7). The `realmBypass` grant died with the kill (the
    // authority inputs were dropped), so a restored record carries no grant;
    // an operator re-grants explicitly (Wave I, ticket c02d0b9). The descriptor
    // subject is always the record's bare realm-local id — never the
    // caller-supplied ref — so a canonical-key restore cannot pollute
    // `authority.subject` (fix lane G7, residual R5; precedent
    // `#setRealmBypass`).
    this.#recycleBin.delete(identityKey);
    this.#agents.set(identityKey, agent);
    const authorityTrusted = agent.authorityProvenance !== 'snapshot';
    this.#registerAgentAuthority(identityKey, agent.id, authorityTrusted
      ? {
        privileged: Boolean(agent.config?.privileged),
        allowedTools: agent.config?.allowedTools ?? null
      }
      : {});

    // 2. Clear soft-kill metadata
    const previousState = agent.state;
    agent.state = AGENT_STATES.IDLE;
    agent.stateDetail = 'Agent restored from recycle bin';
    agent.recycledAt = null;
    agent.recycleReason = null;
    agent.updatedAt = Date.now();

    // 3. Re-register on MessagingBus under the canonical registration key
    // (Wave I, ticket d57cbc1).
    const isPrivileged = Boolean(agent.config?.privileged);
    if (this.#messagingBus) {
      if (typeof this.#messagingBus.unmarkAgentTerminated === 'function') {
        this.#messagingBus.unmarkAgentTerminated(identityKey);
      }
      if (typeof this.#messagingBus.registerAgent === 'function') {
        this.#messagingBus.registerAgent(identityKey, {
          privileged: isPrivileged
        });
      }
    }

    // 4. Re-setup mail subscription routing into TriggerQueue
    const unsub = this.#setupMailSubscription(identityKey);
    this.#messageSubscriptions.set(identityKey, unsub);

    // 5. Emit events
    this.#emit({
      type: 'state_change',
      agentId: agent.id,
      payload: {
        from: previousState,
        to: AGENT_STATES.IDLE,
        previousState,
        currentState: AGENT_STATES.IDLE,
        stateDetail: agent.stateDetail
      }
    });

    this.#emit({
      type: 'agent_restored',
      agentId: agent.id,
      payload: {
        agentId: agent.id,
        restoredAt: new Date().toISOString()
      }
    });

    return agent;
  }

  /**
   * Resolves the canonical `(realmId, agentId)` identity key of the record a
   * lifecycle mutation addresses (Wave I, ticket d57cbc1).
   *
   * Keyed-mutation surface consumed by the runtime facade: kill/purge must
   * hand the scheduler and invocation substrates the exact registration key
   * (the same resolution the mutation itself uses — realm-scoped for a
   * realm-bound caller, unique-match otherwise, canonical key direct), so
   * same-id registrations in two Realms tear down their own timers and
   * invocations only. An absent or ambiguous target resolves `null`.
   *
   * @param agentId - Target agent id (bare or canonical identity key).
   * @param callerContext - Caller context (trusted-principal resolution only).
   * @returns The canonical identity key, or `null` when no record resolves.
   */
  resolveAgentIdentityKey(
    agentId: string,
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): string | null {
    if (!agentId || typeof agentId !== 'string') return null;
    const target = this.#resolveMutationTarget(agentId, callerContext);
    const agent = target.active || target.recycled;
    return agent ? this.#agentIdentityKeyOf(agent) : null;
  }

  /**
   * Permanently purges an agent from the runtime, recycle bin, messaging bus, and VFS workspace (INV-PURGE).
   *
   * Destructive capability: like kill, purge permanently deletes the target's
   * private VirtualFS workspace in addition to the registry/bus teardown. It is
   * sudoer-only and authorizes before any teardown; the eviction key is the
   * target's resolved workspace
   * (`config.workspaceId || config.workspace || agent id`), never the raw
   * lookup id when the two differ — an agent launched into an explicit
   * workspace evicts exactly that workspace (ticket 4e9e0c8).
   *
   * Operational Flow:
   * 1. Authorizes sudoer-only authority before any teardown; anonymous and
   *    non-sudoer callers receive `PERMISSION_DENIED` while the target and its
   *    scheduler timers remain untouched. An invalid or absent id stays a
   *    `false` receipt without requiring authority (f6be691).
   * 2. Aborts in-flight execution if active and clears `pendingPrecalls`/`lastSummary`.
   * 3. Deletes agent from both active registry and `recycleBin`.
   * 4. Unsubscribes mailbox listeners.
   * 5. Calls `MessagingBus.purgeAgent(agentId)` to wipe inboxes, archives, and policies
   *    (falls back to `unregisterAgent` when the bus does not implement `purgeAgent`).
   * 6. Evicts the private VirtualFS workspace resolved as
   *    `config.workspaceId || config.workspace || agent id` through the
   *    engine-bound principal, skipping the eviction while another registered
   *    record (active or recycled) resolves to the same key — last-claimant
   *    cleanup (26c3913).
   * 7. Emits `'agent_purged'` event.
   *
   * Scheduled-timer teardown is not performed here: `AgentRuntime.purgeAgent` runs
   * `RuntimeScheduler.teardownForAgent(agentId, 'Purged permanently', true)` only after
   * this purge succeeds.
   *
   * @param agentId - Unique identifier of agent to purge
   * @param callerContext - Caller context carrying `principal` or a registry-resolved `callerAgentId` identity
   * @returns `true` if agent was found and purged; `false` if the ID is invalid or the
   *   agent is absent from both registries
   * @throws `Error` - With code `'PERMISSION_DENIED'` if the caller is not a sudoer
   *
   * @example
   * ```typescript
   * const purged = lifecycleManager.purgeAgent('temp-worker', { callerAgentId: 'director' });
   * if (purged) {
   *   console.log('Agent permanently purged.');
   * }
   * ```
   */
  purgeAgent(
    agentId: string,
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): boolean {
    if (!agentId || typeof agentId !== 'string') {
      return false;
    }

    // Realm-scoped resolution (Wave I, ticket d57cbc1): a realm-bound caller
    // addresses its own registration first; an absent or Realm-ambiguous bare
    // id has no resolvable record and fails closed with `false`.
    const target = this.#resolveMutationTarget(agentId, callerContext);
    const agent = target.active || target.recycled;
    if (!agent) return false;

    return this.#purgeAgentRecord(agent, agentId, callerContext);
  }

  /**
   * Record-scoped purge core (Wave I, ticket d57cbc1): the exact registration
   * is already resolved, so map mutations, bus teardown, and the claim-aware
   * workspace eviction address the canonical identity key while agent-facing
   * labels stay the bare id. Used by `purgeAgent` and `emptyRecycleBin` (the
   * latter for scope-ambiguous bare ids that the id-only facade cannot route).
   *
   * @param agent - Resolved record to purge.
   * @param agentId - Bare id used for bus teardown and diagnostic labels.
   * @param callerContext - Caller context (sudoer gate runs first).
   * @returns `true` once the record is purged.
   * @internal
   */
  #purgeAgentRecord(agent: Agent, agentId: string, callerContext: unknown): boolean {
    const identityKey = this.#agentIdentityKeyOf(agent);

    this.#authorizeLifecycleMutation(agentId, callerContext, {
      action: 'purge',
      targetAgent: agent,
      requireSudoer: true
    });

    // Abort if active
    if (agent?.abortController) {
      try { agent.abortController.abort('Purged permanently'); } catch { /* Abort is best-effort; the purge proceeds below. */ }
    }
    if (agent) {
      agent.pendingPrecalls = [];
      agent.lastSummary = null;
    }

    // Remove from maps and drop the authority descriptor (purge is terminal)
    this.#recycleBin.delete(identityKey);
    this.#agents.delete(identityKey);
    this.#authorityRegistry.delete(identityKey);
    this.#authorityInputs.delete(identityKey);

    // Unsubscribe bus listeners
    const unsub = this.#messageSubscriptions.get(identityKey);
    if (unsub) {
      try { unsub(); } catch { /* Best-effort unsubscribe; the entry is deleted regardless. */ }
      this.#messageSubscriptions.delete(identityKey);
    }

    // Wipe MessagingBus registrations, inboxes, terminated status (canonical
    // registration key, Wave I ticket d57cbc1)
    if (this.#messagingBus) {
      if (typeof this.#messagingBus.purgeAgent === 'function') {
        this.#messagingBus.purgeAgent(identityKey);
      } else {
        if (typeof this.#messagingBus.unregisterAgent === 'function') {
          this.#messagingBus.unregisterAgent(identityKey);
        }
      }
    }

    // Wipe the resolved private workspace only when the purged record is its
    // last registered claimant (26c3913); a key still resolved by another
    // active or recycled record carries shared bytes and is left in place.
    // Engine path; the internal principal authorizes VFS tenant administration
    // (MOD-21 W8-D, 4e9e0c8).
    const purgeWorkspaceKey = this.#resolveWorkspaceKey(agent, agentId);
    if (
      this.#virtualFs &&
      typeof this.#virtualFs.deleteWorkspace === 'function' &&
      !this.#isWorkspaceKeyClaimedByOther(purgeWorkspaceKey, identityKey)
    ) {
      this.#virtualFs.deleteWorkspace(
        purgeWorkspaceKey,
        { principal: this.#internalPrincipal ?? undefined }
      );
    }

    this.#emit({
      type: 'agent_purged',
      agentId,
      payload: {
        agentId,
        purgedAt: new Date().toISOString()
      }
    });

    return true;
  }

  /**
   * Permanently purges all agents currently residing in the recycle bin.
   *
   * Authority gate (MOD-21 W8, default-deny): sudoer-only; an omitted/forged
   * context is denied with `PERMISSION_DENIED` before any purge.
   *
   * Each recycled id is purged through `AgentRuntime.purgeAgent` when the
   * manager is attached to a runtime, so the facade-owned scheduler-timer
   * teardown (`RuntimeScheduler.teardownForAgent(id, 'Purged permanently', true)`)
   * runs for every purged agent (INV-PURGE).
   *
   * @param callerContext - Caller context carrying `principal` or a registry-resolved `callerAgentId` identity
   * @returns Total number of agents purged
   * @throws `Error` - With code `'PERMISSION_DENIED'` if the caller is not a sudoer
   *
   * @example
   * ```typescript
   * const count = lifecycleManager.emptyRecycleBin({ callerAgentId: 'director' });
   * console.log(`Purged ${count} recycled agents.`);
   * ```
   */

  emptyRecycleBin(
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): number {
    this.#requireSudoer(callerContext, 'empty the recycle bin');
    const recycledAgents = Array.from(this.#recycleBin.values());
    const runtime = this.#runtime;
    let count = 0;
    for (const record of recycledAgents) {
      // A bare id that is unique and absent from the active registry routes
      // through the facade so its scheduler-timer teardown runs (INV-PURGE);
      // a scope-ambiguous id (same literal id recycled in two Realms) has no
      // single timer owner, so the record-scoped manager purge runs instead
      // and the id-only scheduler teardown is skipped — the safe degradation
      // until the scheduler lane keys canonically (Wave I, ticket d57cbc1).
      const resolvable = this.#countByBareId(this.#recycleBin, record.id) === 1
        && this.#countByBareId(this.#agents, record.id) === 0;
      const purged = runtime && resolvable && typeof runtime.purgeAgent === 'function'
        ? runtime.purgeAgent(record.id, callerContext)
        : this.#purgeAgentRecord(record, record.id, callerContext);
      if (purged) {
        count++;
      }
    }
    return count;
  }

  /**
   * Emergency unstick engine recovering agents hung in infinite loops, deadlocks, or stranded states (INV-UNSTICK).
   *
   * Operational Flow:
   * 1. Synchronously aborts active turn execution via `agent.abortController`.
   * 2. Wipes ephemeral streaming buffers (`currentStream = ''`, `currentReasoning = ''`, `activeToolCalls = []`).
   * 3. Clears promise lock (`currentTurnPromise = null`) and resets `abortController = null`.
   * 4. If agent is not `TERMINATED` or `RECYCLED`, transitions state cleanly to `AGENT_STATES.IDLE`.
   * 5. Enqueues a microtask to kick `TriggerQueue.processTick()` (when a trigger queue is available).
   * 6. Emits `'stream_reset'` event.
   *
   * A recycled ID is also accepted: its buffers and locks are reset, but its
   * `RECYCLED` state is preserved.
   *
   * Authority gate (MOD-21 W8, default-deny): a resolved principal is
   * mandatory; sudoer, parent creator, or the agent itself may unstick.
   *
   * @param agentId - Unique identifier of stuck agent
   * @param reason - Reason for unsticking (defaults to `'Unstuck by user'`)
   * @param callerContext - Caller context carrying `principal` or a registry-resolved `callerAgentId` identity
   * @returns Object containing `success: true`, the reset {@link Agent} instance, the
   *   `previousState` captured immediately before the reset, and the diagnostic `reason`
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is empty or invalid
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if agent does not exist in runtime
   * @throws `Error` - With code `'PERMISSION_DENIED'` if the caller is anonymous or lacks self/parent/sudoer authority
   *
   * @example
   * ```typescript
   * const { success, agent, previousState } = lifecycleManager.unstickAgent(
   *   'coder', 'UI timeout unstick', { callerAgentId: 'coder' }
   * );
   * console.log(`Coder recovered from ${previousState}: ${success}, state: ${agent.state}`);
   * ```
   */

  unstickAgent(
    agentId: string,
    reason: string = 'Unstuck by user',
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): { success: boolean; agent: Agent; previousState: AgentState; reason: string } {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("unstickAgent requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    const resolved = this.#resolveMutationTarget(agentId, callerContext);
    const agent = resolved.active || resolved.recycled;
    if (!agent) {
      const err: CodedError = new Error(`Agent '${this.#displayAgentId(agentId)}' not found in runtime`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    this.#authorizeLifecycleMutation(agentId, callerContext, {
      action: 'unstick',
      targetAgent: agent
    });

    // Capture the pre-unstick state before any mutation so the receipt is truthful.
    const previousState = agent.state;

    // 1. Synchronously abort active turn
    if (agent.abortController) {
      try {
        agent.abortController.abort(reason);
      } catch {
        // Abort is best-effort; the unstick path continues below.
      }
    }

    // 2. Synchronously wipe streaming buffers and break promise lock
    agent.currentStream = '';
    agent.currentReasoning = '';
    agent.activeToolCalls = [];
    agent.abortController = null;
    agent.currentTurnPromise = null;

    // 3. Transition cleanly to IDLE if not terminated or recycled
    if (agent.state !== AGENT_STATES.TERMINATED && agent.state !== AGENT_STATES.RECYCLED) {
      this.#applyStateTransition(agent, AGENT_STATES.IDLE, reason);
    }

    if (this.#runtime?.triggerQueue && typeof this.#runtime.triggerQueue.processTick === 'function') {
      queueMicrotask(() => {
        this.#runtime?.triggerQueue?.processTick().catch(() => {});
      });
    }

    // 4. Emit stream_reset event with a narrow descriptor (never the mutable Agent)
    this.#emit({
      type: 'stream_reset',
      agentId: agent.id,
      payload: {
        agentId: agent.id,
        reason,
        descriptor: {
          id: agent.id,
          state: agent.state,
          stateDetail: agent.stateDetail
        }
      }
    });

    return { success: true, agent, previousState, reason };
  }

  /**
   * Aborts an in-flight turn for an agent, transitioning state to `CANCELING` and triggering abort signal.
   *
   * Authority gate (MOD-21 W8, default-deny): a resolved principal is mandatory
   * before any cancellation; sudoer, parent creator, or the agent itself may
   * cancel. An unknown agent stays a `false` receipt without requiring
   * authority.
   *
   * @param agentId - Unique identifier of agent to cancel
   * @param reason - Optional cancellation reason (defaults to `'Cancelled by user'`)
   * @param callerContext - Caller context carrying `principal` or a registry-resolved `callerAgentId` identity
   * @returns `true` when the agent exists and was actively cancelled; `false` when the
   *   agent is unknown or had no cancellable in-flight/waiting state
   * @throws `Error` - With code `'PERMISSION_DENIED'` if the caller is anonymous or lacks self/parent/sudoer authority
   *
   * @example
   * ```typescript
   * const cancelled = lifecycleManager.cancelAgent(
   *   'long-running-analyst', 'User clicked Stop', { callerAgentId: 'long-running-analyst' }
   * );
   * ```
   */

  cancelAgent(
    agentId: string,
    reason: string = 'Cancelled by user',
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): boolean {
    const agent = this.#resolveMutationTarget(agentId, callerContext).active;
    if (!agent) return false;
    return this.#cancelAgentRecord(agent, reason, callerContext);
  }

  /**
   * Record-scoped cancellation core (Wave I, ticket d57cbc1): the exact active
   * registration is already resolved, so `cancelAll` can cancel every agent
   * without a bare-id re-resolution (which fails closed for a scope-ambiguous
   * id).
   *
   * @param agent - Resolved active record.
   * @param reason - Cancellation reason.
   * @param callerContext - Caller context (authority gate runs first).
   * @returns `true` when the agent had a cancellable in-flight/waiting state.
   * @internal
   */
  #cancelAgentRecord(
    agent: Agent,
    reason: string,
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null
  ): boolean {
    this.#authorizeLifecycleMutation(agent.id, callerContext, {
      action: 'cancel',
      targetAgent: agent
    });

    if (
      agent.state === AGENT_STATES.RUNNING ||
      agent.state === AGENT_STATES.WAITING_FOR_INPUT ||
      agent.state === AGENT_STATES.WAITING_FOR_DEPENDENTS ||
      agent.state === AGENT_STATES.WAITING_FOR_MESSAGE
    ) {
      this.#applyStateTransition(agent, AGENT_STATES.CANCELING, reason);
      if (agent.abortController) {
        try {
          agent.abortController.abort(reason);
        } catch {
          // Abort is best-effort; the CANCELING transition above is authoritative.
        }
      }
      return true;
    }

    return false;
  }

  /**
   * Cancels all active agents across the entire runtime, propagating the caller's reason
   * to each per-agent cancellation.
   *
   * Authority gate (MOD-21 W8, default-deny): sudoer-only; authorization runs
   * before any scheduler cancellation, so a denied call leaves timers intact.
   *
   * @param reason - Optional cancellation reason (defaults to `'Cancelled all agents'`)
   * @param callerContext - Caller context carrying `principal` or a registry-resolved `callerAgentId` identity
   * @throws `Error` - With code `'PERMISSION_DENIED'` if the caller is not a sudoer
   *
   * @example
   * ```typescript
   * lifecycleManager.cancelAll('Emergency shutdown', { callerAgentId: 'director' });
   * ```
   */

  cancelAll(
    reason: string = 'Cancelled all agents',
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): void {
    this.#requireSudoer(callerContext, 'cancel all agents');
    for (const agent of this.#agents.values()) {
      this.#cancelAgentRecord(agent, reason, callerContext);
    }
  }

  /**
   * Introspects identity, permissions, role, workspace, and tool whitelists of an active agent (whoami).
   *
   * @param agentId - Unique identifier of agent
   * @returns {@link AgentIdentityDescriptor} containing permissions and identity metadata
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId is empty or invalid
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if the agent is not in the active registry
   *
   * @example
   * ```typescript
   * const identity = lifecycleManager.whoami('coder');
   * console.log(`Agent ${identity.name} has tools: ${identity.allowedTools.join(', ')}`);
   * ```
   */

  whoami(agentId: string): AgentIdentityDescriptor {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error('Valid string agentId is required for whoami');
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    const agent = this.getAgent(agentId);
    if (!agent) {
      const err: CodedError = new Error(`Agent '${this.#displayAgentId(agentId)}' not found`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }
    const isPrivileged = Boolean(agent.config?.privileged);
    const allowedTools = Array.isArray(agent.config?.allowedTools)
      ? [...agent.config.allowedTools]
      : (agent.config?.allowedTools === '*' ? ['*'] : []);
    return {
      success: true,
      agentId: agent.id,
      name: agent.name || agent.config?.name || agent.id,
      role: agent.config?.role || (isPrivileged ? 'admin' : 'user'),
      privileged: isPrivileged,
      workspace: agent.config?.workspaceId || agent.id,
      triggerPolicy: agent.config?.triggerPolicy || 'auto',
      allowedTools
    };
  }

  /**
   * Clears the diagnostic error banner on an active or recycled agent without
   * mutating conversational history.
   *
   * @param agentId - Unique identifier of agent
   * @returns True when the agent exists and its error banner was cleared.
   */

  clearAgentLastError(agentId: string): boolean {
    if (!agentId || typeof agentId !== 'string') return false;
    const agent = this.#uniqueByBareId(this.#agents, agentId) || this.#uniqueByBareId(this.#recycleBin, agentId) || null;
    if (!agent || typeof agent.clearLastError !== 'function') return false;
    agent.clearLastError();
    return true;
  }

  /**
   * Lists all currently registered active agents.
   *
   * @param _options - Accepted for signature compatibility; ignored by this implementation
   * @returns Array of active {@link Agent} instances in registry insertion order
   *
   * @example
   * ```typescript
   * const activeAgents = lifecycleManager.listAgents();
   * console.log(`Active count: ${activeAgents.length}`);
   * ```
   */

  listAgents(_options?: unknown): Agent[] {
    return Array.from(this.#agents.values());
  }

  /**
   * Backwards-compatible alias for {@link listAgents}.
   *
   * @param options - Accepted for signature compatibility; ignored by this implementation
   * @returns Array of active {@link Agent} instances
   *
   * @example
   * ```typescript
   * const agents = lifecycleManager.list_agents();
   * ```
   */

  list_agents(options: unknown = {}): Agent[] {
    return this.listAgents(options);
  }

  /**
   * Lists all soft-killed agents currently residing in the recycle bin.
   *
   * @returns Array of recycled {@link Agent} instances
   *
   * @example
   * ```typescript
   * const recycled = lifecycleManager.listRecycledAgents();
   * ```
   */

  listRecycledAgents(): Agent[] {
    return Array.from(this.#recycleBin.values());
  }

  /**
   * Lists agent summary descriptors under the principal-driven visibility
   * predicate (MOD-21). Computes unread mailbox counts, workspace mappings, and
   * resolved tool whitelists.
   *
   * Exact predicate:
   * - Anonymous (no resolvable principal, including forged flag-only contexts):
   *   returns `[]`.
   * - Realm bypass (the exact injected internal principal, or an agent whose
   *   registry descriptor carries the `realmBypass` grant): returns every
   *   active descriptor.
   * - Registry sudoer (descriptor `allow` contains `'*'`/`'@lifecycle:authority'`):
   *   returns every active descriptor whose Realm scope equals the caller's
   *   own scope, plus the caller.
   * - Unprivileged principal: returns only the principal's own descriptor and
   *   descriptors whose `config.spawnedBy`/`config.creatorId` equals the
   *   principal subject (registry children) AND share the caller's Realm
   *   scope. Realm membership never moves (Wave R, ticket 56ba4b9), so a child
   *   raised in another scope is never visible to a foreign-scope parent.
   *
   * Realm scope is `config.realmId` equality, with the bootstrap-only `null`
   * scope for the engine-launched root director (every other launch resolves a
   * Realm — the seeded Generic default when none is named): scope-bound
   * callers never see agents outside their scope and vice versa; only the
   * bypass principals span scopes. Visibility is a consequence of scope
   * equality — no id-specific clause exists (Wave I, ticket c02d0b9).
   *
   * Privilege flags (`isPrivileged`/`isAdmin`/`privileged`) on `options` are
   * ignored.
   *
   * @param options - Principal context (`{ principal }` or a registry-resolved `callerAgentId`)
   * @returns Array of {@link AgentDescriptor} objects (empty for anonymous callers)
   *
   * @example
   * ```typescript
   * const descriptors = lifecycleManager.listAgentDescriptors({
   *   callerAgentId: 'worker-1'
   * });
   * ```
   */

  listAgentDescriptors(options: {
    /** Trusted principal: the exact injected `InternalPrincipal` or a frozen registry `AuthorityDescriptor`. */
    principal?: InternalPrincipal | AuthorityDescriptor;
    /** Registry-resolved caller identity; authority still comes from that agent's frozen descriptor. */
    callerAgentId?: string;
    /** @deprecated Ignored caller claim; the principal descriptor decides visibility (MOD-21 W3 enforcement). */
    isPrivileged?: boolean;
    /** @deprecated Ignored caller claim; the principal descriptor decides visibility (MOD-21 W3 enforcement). */
    isAdmin?: boolean;
    /** @deprecated Ignored caller claim; the principal descriptor decides visibility (MOD-21 W3 enforcement). */
    privileged?: boolean;
  } = {}): AgentDescriptor[] {
    const principal = this.#resolveCallerPrincipal({
      principal: options?.principal || null,
      callerContext: options
    });
    if (!principal) return [];

    const isSudoer = principalHasLifecycleAuthority(principal);
    const callerAgentId = principal.kind === 'agent' ? principal.subject : null;

    // Realm scope (Realm wave A, ticket 3487c56; Realm wave R, tickets
    // cf0e127 + 56ba4b9; Wave I, ticket c02d0b9): the existing
    // principal-driven visibility predicate is confined to the caller's own
    // Realm scope — scope equality, with the bootstrap-only `null` scope for
    // the engine-launched root director. There is no always-visible id clause:
    // the operator/engine internal principal or an agent holding the
    // `realmBypass` grant sees every descriptor, and every other caller sees
    // exactly its same-scope visible set. A registered caller whose record
    // carries no membership (a legacy or hydrated null) resolves to the null
    // scope.
    const callerBypass = this.#principalBypassesRealm(principal);
    const callerRealmId = callerBypass ? null : this.#principalRealmId(principal);

    const descriptors: AgentDescriptor[] = [];
    for (const agent of this.#agents.values()) {
      if (!callerBypass) {
        const isSelf = callerAgentId === agent.id;
        const isChild = agent.config?.spawnedBy === callerAgentId || agent.config?.creatorId === callerAgentId;
        const sameScope = this.#agentRealmId(agent) === callerRealmId;
        if (!(sameScope && (isSudoer || isSelf || isChild))) {
          continue;
        }
      }

      // Unread counts address the exact registration (Wave I, ticket
      // d57cbc1): the canonical identity key resolves the mailbox partition
      // realm-exactly, where a bare id shared by two Realms would fail closed.
      const identityKey = this.#agentIdentityKeyOf(agent);
      const unreadCount = typeof this.#messagingBus?.getUnreadCount === 'function'
        ? this.#messagingBus.getUnreadCount(identityKey)
        : (this.#messagingBus?.listInbox(identityKey, { unreadOnly: true })?.length || 0);

      const allowedTools = Array.isArray(agent.config?.allowedTools)
        ? [...agent.config.allowedTools]
        : (agent.config?.allowedTools === '*' ? ['*'] : []);

      // Workspace label (Wave I, ticket d57cbc1; folded defect eab4e51): the
      // configured workspace or the bare id, omitted when that value would
      // echo internal realm vocabulary. Reserved partition shapes stay present
      // for the agent-facing projection to mask (`global`).
      const configuredWorkspace = typeof agent.config?.workspaceId === 'string' && agent.config.workspaceId
        ? agent.config.workspaceId
        : null;
      const workspaceLabel = configuredWorkspace
        || (isRealmVocabularyId(agent.id) ? null : agent.id);
      const visibleWorkspace = workspaceLabel && !isReservedWorkspaceKey(workspaceLabel) && isRealmVocabularyId(workspaceLabel)
        ? null
        : workspaceLabel;

      descriptors.push({
        id: agent.id,
        name: agent.name || agent.config?.name || agent.id,
        state: agent.state,
        role: agent.config?.role || (agent.config?.privileged ? 'admin' : 'user'),
        triggerPolicy: agent.config?.triggerPolicy || 'auto',
        unreadCount,
        allowedTools,
        ...(visibleWorkspace ? { workspace: visibleWorkspace } : {})
      });
    }

    return descriptors;
  }

  /**
   * Dynamically updates an agent's configuration and character directives in-memory (INV-CONFIG-SYNC).
   *
   * Operational Flow:
   * 1. Delegates to `Agent.updateConfig`, which merges the partial config and
   *    re-instantiates the model/provider bindings when `modelConfig` changes.
   * 2. Updates name, role, maxTurns, allowedTools (resolved via presets), privileged status, triggerPolicy.
   *    A privileged-status change re-registers the agent on the bus with the new flag.
   *    Authority-bearing fields (`privileged`, `isAdmin`/`isPrivileged`, the
   *    `'admin'`/`'system'` role claims, the parentage fields
   *    `spawnedBy`/`creatorId`, and capability selectors resolving to the
   *    wildcard `'*'` or `@lifecycle:authority` through any alias —
   *    `allowedTools`/`tools`/`toolPreset`/`role`) require a principal whose
   *    frozen `AuthorityDescriptor` allows `@lifecycle:authority` (or `'*'`);
   *    anonymous and unprivileged callers receive `PERMISSION_DENIED` before any
   *    mutation (self-elevation, parentage forgery, and wildcard capability
   *    expansion are impossible). The Realm membership field `realmId` is
   *    immutable for every caller — the injected `InternalPrincipal` and the
   *    system director identity included — and any `realmId` key is denied
   *    outright (Realm wave R, ticket 56ba4b9). A resolved agent principal may
   *    only update a target in its own Realm scope: a cross-scope target is
   *    denied fail-closed with `PERMISSION_DENIED` before any mutation, even
   *    for wildcard lifecycle authority — the exact `InternalPrincipal` and a
   *    `realmBypass`-granted agent span scopes, the principal-less host path
   *    keeps its legacy semantics (Realm wave A, ticket 3487c56; fix lane G5,
   *    residual R1). The frozen descriptor is rebuilt
   *    whenever privilege or tool capability changes. The caller-supplied
   *    object is
   *    snapshotted exactly once before the gate and the application phase, so a
   *    stateful `Proxy` cannot TOCTOU the gate (MOD-21 W10, 7db884b); applied
   *    authority values reach the entity only through the manager-owned
   *    authority channel (5b585b7), and the entity delegation and channel
   *    apply use intrinsic `Agent.prototype` methods rather than dynamic
   *    lookup, so a public entity reference cannot substitute a capture shim
   *    (MOD-21 W11-A, 18f43d6).
   * 3. Live System Prompt Synchronization: If `updatedConfig.systemPrompt` is supplied:
   *    - Updates `agent.config.systemPrompt`.
   *    - Ensures deterministic IDs across history.
   *    - If `agent.history[0]?.role === 'system'`, updates its content in-place and refreshes `updatedAt`.
   *    - If absent, unshifts a new system directive at index 0 only when the new prompt is non-empty.
   *    - Preserves prompt cache stability and aligns character updates immediately.
   * 4. Emits `'agent_config_updated'` event.
   *
   * @param agentId - Unique identifier of agent to update
   * @param updatedConfig - Partial configuration object containing updated fields,
   *   including the MOD-20 `presetId` binding (carried through the non-authority
   *   merge; the entity channel materializes the effective config)
   * @param callerContext - Caller context carrying `principal` or a registry-resolved `callerAgentId` identity; required for authority-bearing fields
   * @returns The updated {@link Agent} instance
   * @throws `Error` - With code `'INVALID_CONFIG'` if agentId or updatedConfig is invalid
   * @throws `Error` - With code `'AGENT_NOT_FOUND'` if the agent is not in the active registry
   * @throws `Error` - With code `'PERMISSION_DENIED'` if authority-bearing fields are updated without lifecycle authority
   *
   * @example
   * ```typescript
   * const updated = lifecycleManager.updateAgentConfig('coder', {
   *   systemPrompt: 'You are an expert full-stack TypeScript and Rust developer.',
   *   temperature: 0.1,
   *   allowedTools: ['read_file', 'write_to_file', 'run_command']
   * });
   * console.log(`Synchronized system prompt: ${updated.history[0]?.content}`);
   * ```
   */

  updateAgentConfig(
    agentId: string,
    updatedConfig: Partial<AgentConfig>,
    callerContext: (AgentSecurityContext & { principal?: InternalPrincipal | AuthorityDescriptor }) | null = null
  ): Agent {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error("updateAgentConfig requires a valid string 'agentId'");
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    if (!updatedConfig || typeof updatedConfig !== 'object') {
      const err: CodedError = new Error("updateAgentConfig requires a valid updatedConfig object");
      err.code = 'INVALID_CONFIG';
      throw err;
    }

    // MOD-21 W10 (7db884b): read the caller object exactly once. Every gate and
    // application read below consumes this plain snapshot, so a stateful Proxy
    // cannot pass the gate and then present authority values to the merge.
    const update = snapshotCallerObject(updatedConfig);

    const agent = this.#resolveMutationTarget(agentId, callerContext).active;
    if (!agent) {
      const err: CodedError = new Error(`Agent '${this.#displayAgentId(agentId)}' not found in runtime`);
      err.code = 'AGENT_NOT_FOUND';
      throw err;
    }

    // Realm confinement (Realm wave A, ticket 3487c56; Wave I, ticket d57cbc1;
    // fix lane G5, residual R1): a resolved agent principal may only update a
    // target inside its own Realm scope — cross-Realm config writes are denied
    // fail-closed before any mutation, exactly like kill/restore/purge/cancel,
    // even for wildcard lifecycle authority. The exact `InternalPrincipal`
    // (operator) or an agent holding the `realmBypass` grant spans scopes via
    // the shared gate; the principal-less host/API path keeps its legacy
    // unscoped semantics (there is no agent-facing config-update tool).
    const callerPrincipal = this.#resolveCallerPrincipal({ callerContext });
    if (callerPrincipal) {
      this.#assertRealmScope(callerPrincipal, agent, 'update the configuration of', agentId);
    }

    // Authority gate: authority-bearing edits require lifecycle authority.
    const roleClaim = typeof update.role === 'string'
      && ['admin', 'system'].includes(update.role.trim().toLowerCase());
    // Parentage (`spawnedBy`/`creatorId`) is authority-bearing: `killAgent` and
    // `invokeAgent` treat a registered parent as an authorized caller, so an
    // anonymous rewrite would graft arbitrary kill/invoke authority (85f1f5f).
    const parentageClaim = update.spawnedBy !== undefined || update.creatorId !== undefined;
    // Realm membership is authority-bearing too (Realm wave A, f5d1ccc): moving
    // an agent between Realms is an operator/system-director action under the
    // locked bypass rule, so any `realmId` key is gated below regardless of
    // value (`null` included) and wildcard agent authority does not admit it.
    const realmClaim = update.realmId !== undefined;
    // The `realmBypass` scope grant is operator-API-only (Wave I, ticket
    // c02d0b9): any `realmBypass` key — `false` included — is denied for EVERY
    // caller before the generic authority verdict. Grants and revocations flow
    // exclusively through `grantRealmBypass`/`revokeRealmBypass`.
    const realmBypassClaim = update.realmBypass !== undefined;
    // Wave U publishing authorities are operator-API-only too (ticket
    // 2518510): any `templateAuthority`/`hydrationAuthority` key is denied for
    // EVERY caller before the generic authority verdict.
    const metaAuthorityClaim = update.templateAuthority !== undefined || update.hydrationAuthority !== undefined;
    // Capability selectors feed the frozen registry `AuthorityDescriptor`, so a
    // selector resolving to the wildcard `'*'`, the `@lifecycle:authority`
    // capability, or a Wave U publishing authority is an authority-bearing edit
    // regardless of which alias carried it (`allowedTools`/`tools`/`toolPreset`/
    // `role`). Resolve the effective selector before any mutation so
    // anonymous/forged callers are denied with the state untouched
    // (f34d50f / 32ec133); ordinary non-authority tool-set edits stay available
    // to non-sudoer callers.
    const rawTools = update.allowedTools !== undefined
      ? update.allowedTools
      : (update.tools !== undefined
        ? update.tools
        : (update.toolPreset !== undefined
          ? update.toolPreset
          : (update.tool_preset !== undefined ? update.tool_preset : update.role)));
    const resolvedTools = rawTools !== undefined ? resolveToolPreset(rawTools) : undefined;
    const capabilityClaim = Array.isArray(resolvedTools)
      && resolvedTools.some((tool) => (
        tool === '*'
        || tool === LIFECYCLE_AUTHORITY_CAPABILITY
        || META_AUTHORITY_IDS.has(tool)
      ));
    const authorityClaim = update.privileged !== undefined
      || update.isAdmin !== undefined
      || update.isPrivileged !== undefined
      || roleClaim
      || parentageClaim
      || realmClaim
      || realmBypassClaim
      || metaAuthorityClaim
      || capabilityClaim;

    if (authorityClaim) {
      // Single resolution (the realm gate above): the authority verdict reads
      // the same trusted principal, so a stateful caller context cannot answer
      // the gates with two different identities.
      const principal = callerPrincipal;
      // Realm membership is immutable for EVERY caller (Realm wave R, ticket
      // 56ba4b9): realms are absolute boundaries, membership is fixed at
      // launch, and even the exact injected internal principal cannot change
      // or clear it through a config update. Changing an agent's realm means
      // terminate + relaunch into the target realm, so any `realmId` key (an
      // explicit `null` included) is denied before the generic authority
      // verdict.
      const targetLabel = this.#displayAgentId(agentId, agent);
      if (realmClaim) {
        throw new PermissionDeniedError(
          `Permission denied: agent '${targetLabel}' Realm membership is immutable (realms are fixed at launch; terminate the agent and relaunch it into the target Realm)`,
          { callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null, code: 'PERMISSION_DENIED' }
        );
      }
      // The `realmBypass` grant is never a config-update field: the key is
      // denied for every caller, the operator principal included (Wave I,
      // ticket c02d0b9). Use the grant/revoke API instead.
      if (realmBypassClaim) {
        throw new PermissionDeniedError(
          `Permission denied: agent '${targetLabel}' realmBypass is an operator grant, never a config-update field (use grantRealmBypass/revokeRealmBypass)`,
          { callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null, code: 'PERMISSION_DENIED' }
        );
      }
      // Wave U publishing authorities follow the same operator-API-only rule
      // (ticket 2518510): the keys are denied for every caller, so a
      // config-update path can never grant or smuggle them.
      if (metaAuthorityClaim) {
        throw new PermissionDeniedError(
          `Permission denied: agent '${targetLabel}' publishing authorities are operator grants, never a config-update field `
          + '(use grantTemplateAuthority/revokeTemplateAuthority/grantHydrationAuthority/revokeHydrationAuthority)',
          { callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null, code: 'PERMISSION_DENIED' }
        );
      }
      if (!principalHasLifecycleAuthority(principal)) {
        throw new PermissionDeniedError(
          `Permission denied: caller lacks lifecycle authority to update authority-bearing fields on agent '${targetLabel}'`,
          { callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null, code: 'PERMISSION_DENIED' }
        );
      }
    }

    // Delegate non-authority config updates & provider/model re-instantiation
    // to the Agent domain entity. The entity channel denies authority-bearing
    // fields outright (4eaf2cc), so this gated manager strips them here and
    // applies them exclusively through the owner-controlled channel below.
    const entityUpdates = { ...update };
    for (const field of AUTHORITY_UPDATE_FIELDS) delete entityUpdates[field];
    // Intrinsic dispatch (MOD-21 W11-A, 18f43d6): resolving these from the
    // entity would let a caller-substituted method capture the manager channel
    // or run attacker code inside a gated update.
    Agent.prototype.updateConfig.call(agent, entityUpdates, null);

    // Authority-bearing fields are applied through the owner-controlled channel
    // (5b585b7): direct config writes cannot reach the entity authority state.
    const authorityPatch: AgentAuthorityPatch = {};
    if (update.privileged !== undefined) authorityPatch.privileged = update.privileged === true;
    if (update.role !== undefined) authorityPatch.role = String(update.role);
    if (rawTools !== undefined) authorityPatch.allowedTools = Array.isArray(resolvedTools) ? resolvedTools : [];
    if (update.spawnedBy !== undefined) authorityPatch.spawnedBy = update.spawnedBy === null ? null : String(update.spawnedBy);
    if (update.creatorId !== undefined) authorityPatch.creatorId = update.creatorId === null ? null : String(update.creatorId);
    // `realmId` is never applied: the immutability gate above denies the key
    // for every caller (Realm wave R, ticket 56ba4b9), so no authority patch
    // may carry it. It stays in AUTHORITY_UPDATE_FIELDS so the entity channel
    // keeps denying it outright.
    if (Object.keys(authorityPatch).length > 0) {
      Agent.prototype.applyAuthorityConfig.call(agent, authorityPatch, this.#authorityChannel);
    }

    // 1. Display Name
    if (update.name !== undefined) {
      agent.config.name = String(update.name);
      agent.name = agent.config.name;
    }

    // 2. Max Turns
    if (typeof update.maxTurns === 'number') {
      agent.config.maxTurns = Math.max(1, update.maxTurns);
    }

    // 3. Privileged / Sudo Mode (authorized above)
    if (update.privileged !== undefined) {
      // Canonical registration key (Wave I, ticket d57cbc1): re-registration
      // must address the exact record, not an ambiguous bare id.
      const identityKey = this.#agentIdentityKeyOf(agent);
      if (typeof this.#messagingBus?.registerAgent === 'function' && this.#messagingBus.isRegistered(identityKey)) {
        this.#messagingBus.registerAgent(identityKey, {
          privileged: agent.config?.privileged === true
        });
      }
    }

    // The frozen authority descriptor is rebuilt whenever the trusted capability
    // inputs change; a stale descriptor reference immediately loses authority.
    // The `realmBypass` grant and the Wave U publishing-authority grants ride
    // along unchanged — a capability update never grants or revokes scope or
    // authority (Wave I, ticket c02d0b9; Wave U, ticket 2518510).
    if (update.privileged !== undefined || rawTools !== undefined) {
      const identityKey = this.#agentIdentityKeyOf(agent);
      this.#registerAgentAuthority(identityKey, agent.id, {
        ...this.#currentAuthorityInputs(identityKey),
        privileged: agent.config?.privileged === true,
        allowedTools: agent.config?.allowedTools ?? agent.config?.tools ?? null
      });
    }

    // 4. System Prompt & Live History Synchronization (INV-CONFIG-SYNC)
    if (update.systemPrompt !== undefined) {
      const newPrompt = String(update.systemPrompt);
      agent.config.systemPrompt = newPrompt;

      ensureHistoryMessageIds(agent.history);

      if (agent.history.length > 0 && agent.history[0]?.role === 'system') {
        agent.history[0].content = newPrompt;
        agent.history[0].updatedAt = Date.now();
      } else if (newPrompt) {
        agent.history.unshift({
          id: generateMessageId('sys'),
          role: 'system',
          content: newPrompt,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
    }

    // 5. Trigger Policy Configuration
    if (update.triggerPolicy !== undefined) {
      agent.config.triggerPolicy = update.triggerPolicy;
    }

    agent.updatedAt = Date.now();

    this.#emit({
      type: 'agent_config_updated',
      agentId: agent.id,
      payload: {
        agentId: agent.id,
        config: agent.config,
        updatedConfig: update
      }
    });

    return agent;
  }
}
