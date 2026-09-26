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
 * @mayImport ../../tools/normalizers/index.ts
 * @mayImport ../../realmCatalog/index.ts
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
 * @invariant INV-META-AUTHORITY: the explicit authorities (the publishing pair `@template:authority`/`@hydration:authority` and the meta-plane ids of `AUTHORITY_IDS`) are revocable operator/engine grants recorded in the frozen registry authority inputs (`AuthorityInputRecord.authorities`, one frozen `{id, scope?}` record per grant) and rebuilt into the `AuthorityDescriptor` allow set as the exact ids. One grant core (`#setAuthority`) serves every id: it accepts only the exact injected `InternalPrincipal` reference and only active agents, validates the id against `AUTHORITY_IDS` and the registry-side scope against the id-class vocabulary, rebuilds descriptor + inputs atomically, and never touches the capability selector axis or Realm membership. Audit keeps the legacy event names for the publishing pair (`template_authority_granted`/`revoked`, `hydration_authority_granted`/`revoked`) and emits `authority_granted`/`authority_revoked` `{authorityId, enabled, by, scopePresent}` for every other id. The root system director is engine-composed with its bootstrap grants. Killing/purging drops the grants with the authority inputs, so a recycled record carries none; hydration restores them only through the composition-root `restoreAuthorityGrants`. The wildcard `'*'` and `privileged` never imply any id, no selector path (launch, spawn, `reauthorizeAgent`, `updateAgentConfig`) can place the ids, and scopes are registry-side only (read through `getAuthorityGrants`) — the frozen descriptor shape never changes and the identity projection never carries scope data.
 * @invariant INV-META-AGENT (M2): `inspect_agent`/`update_agent` are the only agent-facing config surface. Authorization resolves registry-side per target: self-inspection, the inherent parental tier (same Realm + stored direct parentage), or an exact scoped `@agent:inspect`/`@agent:edit` grant (`targets`/`ownSpawns`/`realmMembers` bounded by `realms`/own Realm; `fields` narrows the A18 token set). Every resolution failure — unknown, recycled, ambiguous, non-child, cross-Realm, out-of-scope — shares one uniform static `PERMISSION_DENIED` per tool, so no target-existence/relationship oracle exists; receipts, audits, and denials carry bare ids only and never scope values, canonical keys, workspace keys, or realm vocabulary. Updates validate a closed patch (denied keys fail the whole call; unknown keys/malformed values `INVALID_ARGUMENTS`), evaluate the ≤-editor bound B1–B4 on the RESULTING state before any mutation (a resulting `privileged: true` counts as TOP), apply through the same intrinsic channel as `updateAgentConfig`, and defer a busy target into a bounded runtime-owned latest-wins queue flushed at `turn_complete` (dropped on kill/recycle/purge, re-authorized at flush, exception-shielded). Self-target updates are denied.
 * @decision M2 meta grants are operator-minted records only; launch/spawn/update/reauthorize paths cannot place them, and scopes are read exclusively through `getAuthorityGrants`. The parental tier is inherent to registered direct spawns — no grant, no id, no caller claim.
 * @decision Scoped grants persist through the additive `authorityGrants` snapshot field as `{ ref, scope }` entries (`listAuthorityGrantRecords`; unscoped grants keep the legacy keys-only string), so a narrowed grant survives save/hydrate instead of silently widening (M1 finding F3).
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
import { getCanonToolName, toSnakeCase } from '../../tools/normalizers/index.ts';
import {
  AGENT_AUTHORITIES,
  AUTHORITY_IDS,
  AUTHORITY_SCOPE_FIELDS
} from '../../realmCatalog/index.ts';
import type { AuthorityGrantRecord, AuthorityGrantSnapshotEntry, AuthorityScopeRecord } from '../../realmCatalog/index.ts';
import { isReservedWorkspaceKey } from '../../virtualFs/index.ts';
import type { VirtualFS } from '../../virtualFs/index.ts';
import type { MessagingBus } from '../../messagingBus/index.ts';
import type { InvocationEngine } from '../../invocationEngine/index.ts';
import type { AuthorityDescriptor, InternalPrincipal, SubsystemEmitPort } from '../index.ts';
import type { AgentAuthoritySummary, AgentInspectProjection, AgentUpdateReceipt } from '../index.ts';
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
interface LaunchConfigInput extends Omit<Partial<AgentConfig>, 'extensionTools'> {
  config?: AgentConfig | null;
  model?: LaunchModel;
  provider?: LaunchProvider;
  initialPrompt?: string | null;
  /**
   * Trusted initial-turn policy read from the unified options object only
   * (ticket 4692014): `'detach'` queues the prompt and resolves immediately,
   * `'await'` (default) waits for the completed turn.
   */
  initialTurnMode?: 'await' | 'detach';
  callerContext?: AgentSecurityContext | null;
  principal?: LifecyclePrincipal | null;
  /**
   * Engine-path authority grant composition (M1): honored only when the
   * resolved principal is the exact injected `InternalPrincipal` (the engine
   * bootstrap); every other caller's value is ignored like the legacy alias
   * keys. Entries are authority ids or `{ id, scope? }` records; ids outside
   * `AUTHORITY_IDS` are skipped fail-closed and malformed scopes drop the
   * record, so engine composition never widens the vocabulary.
   */
  authorities?: unknown;
  /**
   * Trusted baked-history entries read from the unified options object only
   * (Wave T, ticket 7e6edae). Validated fail-closed by
   * {@link normalizeLaunchHistory}; legacy positional launch forms never
   * carry them.
   */
  history?: readonly LaunchHistoryEntry[] | null;
  /**
   * Trusted store-computed effective extension grant set (extension wave):
   * sanitized extension call names resolved against the Realm's operator
   * attachments and the agent's selector. Read from the unified options object
   * only and forwarded one-way into descriptor construction (the same trusted
   * channel as `allowedTools`); legacy positional launch forms and
   * `config.extensionTools` never grant an extension entry.
   *
   * The flat legacy config form may also carry the per-agent selector here
   * (`'all'` or an explicit list) — state only, normalized to the entity's
   * `'all'` default; the trusted effective grant list always arrives through
   * the unified options object shape (`{ config, extensionTools }`).
   */
  extensionTools?: 'all' | readonly string[] | null;
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
   * Trusted effective extension grant set (sanitized call names) the
   * descriptor's `extensions` axis was built from (`null` when none was
   * supplied). Computed by the composition root from the operator's Realm
   * attachments and the per-agent selector; never derived from `privileged`,
   * `allow`, or any legacy channel.
   */
  readonly extensionTools: readonly string[] | null;
  /**
   * Whether the `realmBypass` grant is active (Wave I, ticket c02d0b9).
   * Composed only on the engine bootstrap path or through the operator
   * grant/revoke API; never from a launch/spawn/update caller value.
   */
  readonly realmBypass: boolean;
  /**
   * Explicit authority grants active for this registration (M1 authority-set
   * generalization): one frozen `{id, scope?}` record per grant, in grant
   * order. Recorded only through the operator grant/revoke API (or the engine
   * bootstrap) and rebuilt into the descriptor's allow set as the exact ids; a
   * capability selector can never place an authority string, and the optional
   * registry-side scope never leaves this record (host-only accessor
   * `AgentRuntime.getAuthorityGrants`). Replaced by the legacy per-authority
   * booleans of the publishing pair; a grant-free record is an empty array.
   */
  readonly authorities: readonly AuthorityGrantRecord[];
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
  'extensionTools',
  'toolPreset',
  'tool_preset',
  'role',
  'spawnedBy',
  'creatorId',
  'realmId',
  'realmBypass',
  'templateAuthority',
  'hydrationAuthority',
  'authorities',
  ...AUTHORITY_IDS
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
 * Runtime authority vocabulary set (M1). Every known id — the publishing pair
 * and the meta-plane ids — is never selectable capability data: a
 * launch/spawn/update selector can never place one into the composed allowlist
 * or the frozen descriptor. Grants are recorded only through the dedicated
 * operator API (`#setAuthority`) or the engine bootstrap. Derived
 * table-driven from `AUTHORITY_IDS` so a future id cannot be forgotten.
 * @internal
 */
const AUTHORITY_ID_SET: ReadonlySet<string> = new Set<string>(AUTHORITY_IDS);

/**
 * Agent-class authority ids whose scopes accept the agent-target keys:
 * `targets` (bare realm-local agent ids) and the `realms` bound. The Wave U
 * publishing pair is deliberately excluded: its dispatch path is realm-bound
 * and does not consult a scope in M1, so accepting one would advertise a
 * narrowing that is not enforced — a publishing grant stays unscoped.
 * @internal
 */
const AGENT_CLASS_AUTHORITY_IDS: ReadonlySet<string> = new Set<string>([
  AGENT_AUTHORITIES.AGENT_INSPECT,
  AGENT_AUTHORITIES.AGENT_EDIT
]);

/**
 * `@agent:*` authority ids whose scopes additionally accept the `ownSpawns`
 * and `realmMembers` selectors.
 * @internal
 */
const AGENT_SELECTOR_AUTHORITY_IDS: ReadonlySet<string> = new Set<string>([
  AGENT_AUTHORITIES.AGENT_INSPECT,
  AGENT_AUTHORITIES.AGENT_EDIT
]);

/**
 * Realm-class authority ids (`@realm:*`/`@extensions:*`) whose scopes accept
 * `targets` as realm ids only.
 * @internal
 */
const REALM_CLASS_AUTHORITY_IDS: ReadonlySet<string> = new Set<string>([
  AGENT_AUTHORITIES.REALM_INSPECT,
  AGENT_AUTHORITIES.REALM_EDIT,
  AGENT_AUTHORITIES.EXTENSIONS
]);

/**
 * Identifier names that may never appear as scope list entries or keys: they
 * are prototype vocabulary and would route through the object prototype chain
 * rather than plain data.
 * @internal
 */
const AUTHORITY_SCOPE_FORBIDDEN_NAMES: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype'
]);

/**
 * Uniform target-resolution denial of the M2 `inspect_agent` surface
 * (meta-plane spec §1.4): unknown, recycled, ambiguous, non-child, and
 * cross-realm targets share this one static receipt — it never echoes the
 * target claim, parentage, capability values, canonical keys, or realm
 * vocabulary, so no target-existence/relationship oracle exists.
 * @internal
 */
const META_AGENT_INSPECT_DENIED_MESSAGE = 'Agent inspection is not permitted for the requested target.';

/**
 * Uniform target-resolution denial of the M2 `update_agent` surface. Distinct
 * from the bound denial below (one receipt per failure class per tool), and
 * equally free of target state, canonical keys, and realm vocabulary.
 * @internal
 */
const META_AGENT_EDIT_DENIED_MESSAGE = 'The requested agent edit is not permitted for the requested target.';

/**
 * Uniform field/bound denial of the M2 `update_agent` surface: a denied-key
 * presence, a field token outside the caller's tier, or a failed B1-B4 bound
 * produces this one distinct receipt, never echoing capability values.
 * @internal
 */
const META_AGENT_EDIT_BOUND_DENIED_MESSAGE = 'The requested agent edit exceeds the permitted scope for this caller.';

/**
 * The A18 parental editable field-token set (decision A18): tools, privilege,
 * trigger policy, and system prompt. The parental tier always carries all four;
 * a meta-tier `@agent:edit` grant narrows them through `scope.fields`.
 * @internal
 */
const PARENTAL_EDIT_FIELD_TOKENS: readonly string[] = Object.freeze(['tools', 'privilege', 'policy', 'prompt']);

/**
 * Editable `update_agent` patch key → ratified field token. `name` rides the
 * prompt token (identity/content presentation) and `maxTurns` the policy token
 * (operational policy), so a `scope.fields`-narrowed grant never silently
 * reaches a field its token set does not cover.
 * @internal
 */
const EDIT_FIELD_TOKEN_BY_PATCH_KEY: Readonly<Record<string, string>> = Object.freeze({
  allowedTools: 'tools',
  tools: 'tools',
  toolPreset: 'tools',
  tool_preset: 'tools',
  privileged: 'privilege',
  triggerPolicy: 'policy',
  maxTurns: 'policy',
  systemPrompt: 'prompt',
  name: 'prompt'
});

/**
 * Operator-only / escalation-adjacent patch keys the M2 edit surface never
 * accepts: presence — `false`/`null` values included — fails the whole call
 * with the uniform bound denial and zero partial mutation (§1.4, §3.1). Any
 * exact `AUTHORITY_IDS` member is denied by the separate exact-id check.
 * @internal
 */
const META_EDIT_DENIED_PATCH_KEYS: ReadonlySet<string> = new Set<string>([
  'modelConfig',
  'presetId',
  'workspaceId',
  'workspace',
  'extensionTools',
  'settings',
  'customTools',
  'customToolSchemas',
  'role',
  'isAdmin',
  'isPrivileged',
  'spawnedBy',
  'creatorId',
  'realmId',
  'realmBypass',
  'templateAuthority',
  'hydrationAuthority',
  'authorities'
]);

/**
 * Bound on the runtime-owned pending-edit queue (M2 safe state): one
 * latest-wins entry per target identity key, oldest-evicted beyond the cap.
 * @internal
 */
const META_PENDING_EDITS_CAP = 128;

/**
 * One deferred parental/meta edit (M2 safe state): the exact actor and target
 * registrations plus the frozen patch and its ratified field tokens. The queue
 * is runtime-owned and never persisted or projected; a flush re-resolves the
 * actor and re-evaluates the verdict against the current state before applying.
 * @internal
 */
interface PendingAgentEdit {
  readonly targetId: string;
  readonly actorId: string;
  readonly actorKey: string;
  readonly tier: 'parental' | 'meta';
  readonly patch: ConfigUpdateSnapshot;
  readonly fields: readonly string[];
}

/**
 * Result of the M2 tier verdict for a resolved target: which tier authorized
 * the caller and the effective field-token set for an update.
 * @internal
 */
type MetaAgentVerdict =
  | { readonly tier: 'self'; readonly fields: readonly string[] }
  | { readonly tier: 'parental'; readonly fields: readonly string[] }
  | { readonly tier: 'meta'; readonly fields: readonly string[] };

/**
 * Tests whether a patch key is an operator-only / escalation-adjacent key the
 * M2 edit surface never accepts (exact spelling, snake_case spelling, or an
 * exact `AUTHORITY_IDS` member in either spelling).
 *
 * @param key - Candidate sanitized patch key.
 * @returns True when the key must fail the whole call with the bound denial.
 * @internal
 */
function isDeniedMetaEditPatchKey(key: string): boolean {
  if (META_EDIT_DENIED_PATCH_KEYS.has(key)) return true;
  if (AUTHORITY_ID_SET.has(key)) return true;
  const snake = toSnakeCase(key);
  if (snake && snake !== key) {
    if (META_EDIT_DENIED_PATCH_KEYS.has(snake)) return true;
    if (AUTHORITY_ID_SET.has(snake)) return true;
  }
  return false;
}

/**
 * Canonicalizes an effective tool-name collection for the M2 ≤-editor bound
 * (meta-plane spec §1.3): each member resolves through the alias normalizer
 * (`getCanonToolName(m) ?? m`), authority ids are stripped (they are grants,
 * never selector capability), and the wildcard `'*'` is preserved as the TOP
 * marker. The result is a fresh mutable `Set` used only for subset probes.
 *
 * @param names - Effective tool names from a descriptor `allow` set or a resolved patch selector.
 * @returns The canonicalized capability set.
 * @internal
 */
function canonicalEffectiveToolNames(names: Iterable<string>): Set<string> {
  const canonical = new Set<string>();
  for (const name of names) {
    if (typeof name !== 'string' || !name) continue;
    if (name === '*') {
      canonical.add('*');
      continue;
    }
    if (AUTHORITY_ID_SET.has(name)) continue;
    const canon = getCanonToolName(name);
    canonical.add(typeof canon === 'string' && canon ? canon : name);
  }
  return canonical;
}

/**
 * Tests `left ⊆ right` over effective capability sets; the TOP marker `'*'`
 * on the right absorbs everything.
 *
 * @param left - Candidate subset.
 * @param right - Candidate superset.
 * @returns True when every member of `left` is in `right` (or `right` is TOP).
 * @internal
 */
function isEffectiveToolSubset(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (right.has('*')) return true;
  for (const name of left) {
    if (!right.has(name)) return false;
  }
  return true;
}

/**
 * Validates and deep-freezes one authority scope record for its id (M1; spec
 * §1.2). Unknown keys, non-array/non-boolean shapes, empty/duplicate/
 * prototype-vocabulary entries, class-invalid keys (`ownSpawns`/`realmMembers`
 * outside `@agent:*`, `realms` outside agent scopes, `fields` outside the
 * id's declared token vocabulary) all reject with `INVALID_CONFIG` before any
 * mutation.
 *
 * @param authorityId - Exact `AUTHORITY_IDS` member the scope narrows.
 * @param scope - Candidate scope object.
 * @returns The deeply frozen scope record.
 * @throws `Error` - With code `'INVALID_CONFIG'` for any malformed scope.
 * @internal
 */
function validateAuthorityScope(authorityId: string, scope: unknown): AuthorityScopeRecord {
  function invalid(message: string): never {
    const err: CodedError = new Error(`Invalid authority scope for '${authorityId}': ${message}`);
    err.code = 'INVALID_CONFIG';
    throw err;
  }
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    invalid('the scope must be a plain object');
  }
  const record = scope as Record<string, unknown>;
  const agentClass = AGENT_CLASS_AUTHORITY_IDS.has(authorityId);
  const realmClass = REALM_CLASS_AUTHORITY_IDS.has(authorityId);
  const allowedKeys: Record<string, boolean> = Object.create(null);
  if (agentClass) {
    allowedKeys.targets = true;
    allowedKeys.realms = true;
  } else if (realmClass) {
    allowedKeys.targets = true;
  }
  if (AGENT_SELECTOR_AUTHORITY_IDS.has(authorityId)) {
    allowedKeys.ownSpawns = true;
    allowedKeys.realmMembers = true;
  }
  const fieldTokens = AUTHORITY_SCOPE_FIELDS[authorityId];
  if (fieldTokens) allowedKeys.fields = true;

  const keys = Object.keys(record);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!allowedKeys[key]) invalid(`unknown or class-invalid scope key '${key}'`);
  }

  const normalizeList = (key: string): readonly string[] | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) invalid(`'${key}' must be an array`);
    const members: string[] = [];
    for (let i = 0; i < value.length; i++) {
      const entry = value[i];
      if (typeof entry !== 'string' || !entry.trim()) invalid(`'${key}' entries must be non-empty strings`);
      const member = entry.trim();
      if (AUTHORITY_SCOPE_FORBIDDEN_NAMES.has(member)) invalid(`'${key}' entries must not carry prototype vocabulary`);
      for (let j = 0; j < members.length; j++) {
        if (members[j] === member) invalid(`'${key}' entries must be unique`);
      }
      members[members.length] = member;
    }
    return Object.freeze(members);
  };
  const normalizeFlag = (key: string): boolean | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') invalid(`'${key}' must be a boolean`);
    return value;
  };

  const targets = normalizeList('targets');
  const ownSpawns = normalizeFlag('ownSpawns');
  const realmMembers = normalizeFlag('realmMembers');
  const realms = normalizeList('realms');
  let fields: readonly string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(record, 'fields')) {
    if (!fieldTokens) invalid('\'fields\' is not declared for this authority id');
    const normalizedFields = normalizeList('fields') ?? [];
    for (let i = 0; i < normalizedFields.length; i++) {
      const token = normalizedFields[i];
      let known = false;
      for (let j = 0; j < fieldTokens.length; j++) {
        if (fieldTokens[j] === token) {
          known = true;
          break;
        }
      }
      if (!known) invalid(`'fields' entry '${token}' is outside the id vocabulary`);
    }
    fields = normalizedFields;
  }

  const normalized: {
    targets?: readonly string[];
    ownSpawns?: boolean;
    realmMembers?: boolean;
    realms?: readonly string[];
    fields?: readonly string[];
  } = {};
  if (targets) normalized.targets = targets;
  if (ownSpawns !== undefined) normalized.ownSpawns = ownSpawns;
  if (realmMembers !== undefined) normalized.realmMembers = realmMembers;
  if (realms) normalized.realms = realms;
  if (fields) normalized.fields = fields;
  return Object.freeze(normalized) as AuthorityScopeRecord;
}

/**
 * Builds one frozen authority grant record, validating the id against
 * `AUTHORITY_IDS` and the optional scope against the id-class vocabulary.
 *
 * @param id - Candidate authority id.
 * @param scope - Optional candidate scope (absent = the id's default scope).
 * @returns The frozen grant record.
 * @throws `Error` - With code `'INVALID_CONFIG'` for unknown ids or malformed scopes.
 * @internal
 */
function createAuthorityGrantRecord(id: unknown, scope: unknown = undefined): AuthorityGrantRecord {
  if (typeof id !== 'string' || !AUTHORITY_ID_SET.has(id)) {
    const err: CodedError = new Error(`Unknown authority id '${String(id)}'`);
    err.code = 'INVALID_CONFIG';
    throw err;
  }
  if (scope === undefined || scope === null) return Object.freeze({ id });
  return Object.freeze({ id, scope: validateAuthorityScope(id, scope) });
}

/**
 * Fail-closed normalizes trusted authority grant input (engine composition and
 * descriptor rebuilds): non-array input yields an empty list, unknown ids and
 * malformed scopes drop the single record, duplicates keep the first
 * occurrence. Unlike the grant core this never throws — it is the
 * registry-record normalizer, not caller-facing validation.
 *
 * @param authorities - Candidate grant list.
 * @returns Frozen grant records.
 * @internal
 */
function normalizeAuthorityGrantRecords(authorities: unknown): ReadonlyArray<AuthorityGrantRecord> {
  if (!Array.isArray(authorities)) return Object.freeze([]);
  const records: AuthorityGrantRecord[] = [];
  for (let i = 0; i < authorities.length; i++) {
    const candidate = authorities[i];
    let id: unknown = candidate;
    let scope: unknown;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const record = candidate as { id?: unknown; scope?: unknown };
      id = record.id;
      scope = record.scope;
    }
    if (typeof id !== 'string' || !AUTHORITY_ID_SET.has(id)) continue;
    let seen = false;
    for (let j = 0; j < records.length; j++) {
      if (records[j].id === id) {
        seen = true;
        break;
      }
    }
    if (seen) continue;
    let grant: AuthorityGrantRecord;
    try {
      grant = createAuthorityGrantRecord(id, scope === undefined ? null : scope);
    } catch {
      // Fail closed: a malformed scope never grants the id unscoped.
      continue;
    }
    records[records.length] = grant;
  }
  return Object.freeze(records);
}

/**
 * Tests whether a config-update / reauthorize input claims an authority grant
 * key: the generic `authorities` key, a legacy publishing alias, or any exact
 * `AUTHORITY_IDS` key (M1). Such keys are operator-API-only on every
 * capability-update path.
 *
 * @param input - Candidate caller-supplied object.
 * @returns True when an authority grant key is present (any value, `false`/`null` included).
 * @internal
 */
function hasAuthorityGrantInputKey(input: Record<string, unknown>): boolean {
  if (input.authorities !== undefined) return true;
  if (input.templateAuthority !== undefined || input.hydrationAuthority !== undefined) return true;
  for (let i = 0; i < AUTHORITY_IDS.length; i++) {
    if (input[AUTHORITY_IDS[i]] !== undefined) return true;
  }
  return false;
}

/**
 * Composes the engine-path authority grants of a launch config (M1): the
 * `authorities` list (ids or `{id, scope?}` records) plus the migration-window
 * legacy aliases `templateAuthority`/`hydrationAuthority`, deduplicated by id.
 * Only called for the exact injected `InternalPrincipal`; every other caller's
 * values are ignored before this point.
 *
 * @param config - Trusted engine launch config.
 * @returns Frozen grant records (unknown ids and malformed scopes skipped).
 * @internal
 */
function composeEngineAuthorityGrants(config: {
  authorities?: unknown;
  templateAuthority?: boolean;
  hydrationAuthority?: boolean;
}): ReadonlyArray<AuthorityGrantRecord> {
  const records: AuthorityGrantRecord[] = [];
  const push = (grant: AuthorityGrantRecord): void => {
    for (let i = 0; i < records.length; i++) {
      if (records[i].id === grant.id) return;
    }
    records[records.length] = grant;
  };
  const declared = normalizeAuthorityGrantRecords(config.authorities);
  for (let i = 0; i < declared.length; i++) push(declared[i]);
  if (config.templateAuthority === true) push(Object.freeze({ id: AGENT_AUTHORITIES.TEMPLATE }));
  if (config.hydrationAuthority === true) push(Object.freeze({ id: AGENT_AUTHORITIES.HYDRATION }));
  return Object.freeze(records);
}

/**
 * Normalizes trusted authority-input selector data for the registry record
 * (MOD-21 W10). Uses indexed reads only; `null` means "no selector supplied".
 * Every authority id is stripped table-driven from `AUTHORITY_IDS`: they are
 * grants, never selector capability data.
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
    if (!AUTHORITY_ID_SET.has(members[i])) filtered[filtered.length] = members[i];
  }
  return Object.freeze(filtered);
}

/**
 * Normalizes trusted authority-input extension grant data for the registry
 * record (extension wave). Only sanitized model-facing call names pass:
 * non-strings, empty strings, duplicates, the wildcard `'*'`, `@`-authority
 * spellings, and any name outside `[A-Za-z0-9_]` are dropped fail-closed, so
 * no selector spelling, alias, or authority id can ever land on the
 * exact-membership `extensions` axis.
 *
 * @param extensions - Trusted effective extension grant list.
 * @returns Frozen sanitized member names, or `null` when no list was supplied.
 * @internal
 */
function normalizeAuthorityInputExtensions(extensions: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(extensions)) return null;
  const members = freezeAuthorityMemberNames(extensions);
  const filtered: string[] = [];
  for (let i = 0; i < members.length; i++) {
    const name = members[i];
    if (name === '*' || name.charAt(0) === '@') continue;
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    filtered[filtered.length] = name;
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
 * Explicit authority grants (M1) are explicit-only capability data: each
 * frozen `{id, scope?}` record appends its exact id to the allow set, while the
 * selector-derived members are stripped of every `AUTHORITY_IDS` id, so only
 * the dedicated grant core (or the engine bootstrap) can ever place them. The
 * scope is stored registry-side only and never appears on the descriptor; the
 * wildcard `'*'` never implies an authority id — the tool gate checks the
 * exact id.
 *
 * @param subject - Principal subject (agent id).
 * @param options - Trusted privilege flag, capability selector, extension grant set, bypass grant, and authority grant records.
 * @returns The frozen authority descriptor.
 * @internal
 */
function createAgentAuthorityDescriptor(
  subject: string,
  {
    privileged = false,
    allowedTools = null,
    extensionTools = null,
    realmBypass = false,
    authorities = []
  }: {
    privileged?: boolean;
    allowedTools?: string[] | '*' | null;
    extensionTools?: readonly string[] | null;
    realmBypass?: boolean;
    authorities?: readonly AuthorityGrantRecord[];
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
  const grants = normalizeAuthorityGrantRecords(authorities);
  for (let i = 0; i < grants.length; i++) {
    authoritativeNames[authoritativeNames.length] = grants[i].id;
  }
  // Extension grants are their own exact-membership axis (extension wave):
  // the trusted store-computed call names are frozen onto `extensions` and are
  // deliberately NOT derived from `privileged`, the wildcard `'*'`, the
  // selector members, or the authority grants — no legacy channel can widen
  // this axis, and an empty/absent list denies every extension call.
  const authoritativeExtensions = normalizeAuthorityInputExtensions(extensionTools) ?? [];
  return Object.freeze({
    subject,
    kind: 'agent',
    allow: createReadonlyAllowSet(authoritativeNames),
    extensions: createReadonlyAllowSet(authoritativeExtensions),
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
 * Resolves the default child capability set for a spawning agent caller with
 * no explicit selector (ratified contract, ticket 1eca963): the
 * `readonly_collaborator` preset intersected with the spawner's own effective
 * tool set. When the intersection is empty (the spawner holds no read-only
 * tool at all), the child inherits the spawner's exact effective set —
 * equivalent access, never a zero-tool child while the spawner has tools. A
 * zero-tool spawner still yields a zero-tool child (equivalence holds).
 *
 * @param creatorAgent - Resolved spawner entity, or `null`.
 * @returns The default child tool list.
 * @internal
 */
function resolveAgentCallerDefaultTools(creatorAgent: { config?: { allowedTools?: unknown } } | null): string[] {
  const spawnerTools = resolveToolPreset(creatorAgent?.config?.allowedTools as string | string[] | null | undefined);
  if (spawnerTools.includes('*')) return [...TOOL_PRESETS.readonly_collaborator];
  const spawnerSet = new Set(spawnerTools);
  const intersection = TOOL_PRESETS.readonly_collaborator.filter((tool) => spawnerSet.has(tool));
  if (intersection.length > 0) return [...intersection];
  return [...spawnerTools];
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
   * Runtime-owned pending-edit queue of the M2 parental/meta `update_agent`
   * surface: one latest-wins entry per target identity key, flushed at the
   * target's `turn_complete` (or explicitly) and dropped on kill/recycle/purge.
   * Bounded by `META_PENDING_EDITS_CAP` with oldest-eviction; entries are
   * re-authorized against the current actor and target state at flush.
   */
  #pendingAgentEdits: Map<string, PendingAgentEdit> = new Map();

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
   * @param input - Trusted privilege flag, capability selector, bypass grant, and authority grant records.
   * @returns The frozen registered descriptor.
   */
  #registerAgentAuthority(
    identityKey: string,
    subject: string,
    {
      privileged = false,
      allowedTools = null,
      extensionTools = null,
      realmBypass = false,
      authorities = []
    }: {
      privileged?: boolean;
      allowedTools?: string[] | '*' | null;
      extensionTools?: readonly string[] | null;
      realmBypass?: boolean;
      authorities?: readonly AuthorityGrantRecord[];
    } = {}
  ): AuthorityDescriptor {
    const grants = normalizeAuthorityGrantRecords(authorities);
    const descriptor = createAgentAuthorityDescriptor(subject, {
      privileged,
      allowedTools,
      extensionTools,
      realmBypass,
      authorities: grants
    });
    this.#authorityRegistry.set(identityKey, descriptor);
    this.#authorityInputs.set(identityKey, Object.freeze({
      privileged: privileged === true,
      allowedTools: normalizeAuthorityInputAllowedTools(allowedTools),
      extensionTools: normalizeAuthorityInputExtensions(extensionTools),
      realmBypass: realmBypass === true,
      authorities: grants
    }));
    return descriptor;
  }

  /**
   * Copies the registry-owned capability inputs of an active agent into the
   * shape `#registerAgentAuthority` accepts, preserving the current grant
   * state. Used by descriptor rebuilds that must not touch the scope or
   * authority-grant axes.
   *
   * @param identityKey - Canonical identity key owning the entry.
   * @returns Trusted capability inputs with the current grants.
   */
  #currentAuthorityInputs(identityKey: string): {
    privileged: boolean;
    allowedTools: string[] | null;
    extensionTools: string[] | null;
    realmBypass: boolean;
    authorities: readonly AuthorityGrantRecord[];
  } {
    const inputs = this.#authorityInputs.get(identityKey);
    return {
      privileged: Boolean(inputs && inputs.privileged === true),
      allowedTools: inputs && inputs.allowedTools ? [...inputs.allowedTools] : null,
      extensionTools: inputs && inputs.extensionTools ? [...inputs.extensionTools] : null,
      realmBypass: Boolean(inputs && inputs.realmBypass === true),
      authorities: inputs ? [...inputs.authorities] : Object.freeze([])
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
   * Sets one explicit authority grant state for an active agent (M1; the one
   * grant core behind every authority id).
   *
   * Authority-bearing operator action: only the exact injected
   * `InternalPrincipal` reference resolves; every other caller — agent
   * principals, caller-asserted flags, plain lookalike objects — is denied
   * with `PERMISSION_DENIED` before any mutation. The id is validated against
   * `AUTHORITY_IDS` and the optional registry-side scope against the id-class
   * vocabulary (`INVALID_CONFIG` on any unknown id or malformed scope); the
   * grant is recorded in the frozen authority inputs as one frozen
   * `{id, scope?}` record and rebuilt into the descriptor's allow set as the
   * exact id, atomically with the inputs record. The capability selector axis,
   * the extension axis, and Realm membership are untouched.
   *
   * Audit keeps the legacy event names for the publishing pair
   * (`template_authority_granted`/`revoked`,
   * `hydration_authority_granted`/`revoked`, payload retained verbatim) and
   * emits `authority_granted`/`authority_revoked` with
   * `{authorityId, enabled, by, scopePresent}` for every other id. The payload
   * carries bare ids only — never scope values or realm vocabulary.
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key).
   * @param authority - Exact `AUTHORITY_IDS` member to set.
   * @param scope - Optional narrowed scope (absent = the id's default scope).
   * @param enabled - Desired grant state.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'INVALID_CONFIG'` for unknown ids or malformed scopes, `'PERMISSION_DENIED'` for non-operator callers.
   */
  #setAuthority(
    agentId: string,
    authority: string,
    scope: AuthorityScopeRecord | null,
    enabled: boolean,
    callerContext: unknown
  ): AuthorityDescriptor | null {
    if (!agentId || typeof agentId !== 'string') {
      const err: CodedError = new Error('authority operation requires a valid string \'agentId\'');
      err.code = 'INVALID_CONFIG';
      throw err;
    }
    const grant = createAuthorityGrantRecord(authority, scope);
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

    const current = this.#currentAuthorityInputs(identityKey);
    const next: AuthorityGrantRecord[] = [];
    for (let i = 0; i < current.authorities.length; i++) {
      if (current.authorities[i].id !== authority) next[next.length] = current.authorities[i];
    }
    if (enabled) next[next.length] = grant;
    const descriptor = this.#registerAgentAuthority(identityKey, agent.id, {
      ...current,
      authorities: next
    });

    // The audit event carries the bare realm-local id only (Realm opacity);
    // the publishing pair keeps its legacy event names and payload verbatim.
    const isPublishing = authority === AGENT_AUTHORITIES.TEMPLATE || authority === AGENT_AUTHORITIES.HYDRATION;
    if (isPublishing) {
      const isTemplateAuthority = authority === AGENT_AUTHORITIES.TEMPLATE;
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
    } else {
      this.#emit({
        type: enabled ? 'authority_granted' : 'authority_revoked',
        agentId: agent.id,
        payload: {
          authorityId: authority,
          enabled: enabled === true,
          by: principal.subject,
          scopePresent: grant.scope !== undefined
        }
      });
    }

    return descriptor;
  }

  /**
   * Grants one explicit authority id (with an optional registry-side scope) to
   * an active agent (M1 generic grant API).
   *
   * @param agentId - Active agent identifier.
   * @param authority - Exact `AUTHORITY_IDS` member.
   * @param scope - Optional narrowed scope; absent/null = the id's default scope.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'INVALID_CONFIG'` for unknown ids or malformed scopes, `'PERMISSION_DENIED'` for non-operator callers.
   */
  grantAuthority(
    agentId: string,
    authority: string,
    scope: AuthorityScopeRecord | null = null,
    callerContext: unknown = null
  ): AuthorityDescriptor | null {
    return this.#setAuthority(agentId, authority, scope, true, callerContext);
  }

  /**
   * Revokes one explicit authority id from an active agent (M1 generic grant
   * API). Revocation ignores any stored scope: the whole grant record is
   * removed.
   *
   * @param agentId - Active agent identifier.
   * @param authority - Exact `AUTHORITY_IDS` member.
   * @param callerContext - Caller context carrying the exact `principal`.
   * @returns The rebuilt descriptor, or `null` for an unknown/recycled id.
   * @throws `Error` - With code `'INVALID_CONFIG'` for unknown ids, `'PERMISSION_DENIED'` for non-operator callers.
   */
  revokeAuthority(
    agentId: string,
    authority: string,
    callerContext: unknown = null
  ): AuthorityDescriptor | null {
    return this.#setAuthority(agentId, authority, null, false, callerContext);
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
    return this.#setAuthority(agentId, AGENT_AUTHORITIES.TEMPLATE, null, true, callerContext);
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
    return this.#setAuthority(agentId, AGENT_AUTHORITIES.TEMPLATE, null, false, callerContext);
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
    return this.#setAuthority(agentId, AGENT_AUTHORITIES.HYDRATION, null, true, callerContext);
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
    return this.#setAuthority(agentId, AGENT_AUTHORITIES.HYDRATION, null, false, callerContext);
  }

  /**
   * Lists the canonical `(realmId, agentId)` identity keys of the active agents
   * currently holding explicit authority grants (M1), grouped per authority
   * id. Ids with no holder are omitted.
   *
   * Canonical keys are the persistence currency: a grant list carrying the
   * same literal id from two Realms round-trips exactly, because the
   * composition-root restore resolves each key to its own registration. The
   * listing itself is registry state, not authority, and the keys are
   * internal-only — they never reach an agent-facing surface. The projection
   * drops scopes; use {@link listAuthorityGrantRecords} when persisting a
   * narrowed grant.
   *
   * @returns Canonical identity keys per authority id (declaration order).
   */
  listAuthorityGrants(): Record<string, string[]> {
    const records = this.listAuthorityGrantRecords();
    const listing: Record<string, string[]> = {};
    for (const authorityId of Object.keys(records)) {
      const refs: string[] = [];
      for (let i = 0; i < records[authorityId].length; i++) {
        const entry = records[authorityId][i];
        refs[refs.length] = typeof entry === 'string' ? entry : entry.ref;
      }
      listing[authorityId] = refs;
    }
    return listing;
  }

  /**
   * Lists the exportable authority-grant entries of the active agents (M2),
   * grouped per authority id: an unscoped grant stays a bare canonical
   * identity-key string (the legacy keys-only form), a scoped grant becomes a
   * frozen `{ ref, scope }` record. This is the persistence currency of the
   * additive `authorityGrants` snapshot field, so a narrowed grant survives a
   * save/hydrate restart instead of silently restoring unscoped (M1
   * finding F3).
   *
   * Host-only surface: scopes never reach a descriptor, an identity
   * projection, a model-facing schema, a receipt, or an audit payload.
   *
   * @returns Frozen export entries per authority id (declaration order).
   */
  listAuthorityGrantRecords(): Record<string, readonly AuthorityGrantSnapshotEntry[]> {
    const perId: Record<string, AuthorityGrantSnapshotEntry[]> = Object.create(null);
    for (let i = 0; i < AUTHORITY_IDS.length; i++) perId[AUTHORITY_IDS[i]] = [];
    for (const identityKey of this.#agents.keys()) {
      const inputs = this.#authorityInputs.get(identityKey);
      if (!inputs) continue;
      for (let i = 0; i < inputs.authorities.length; i++) {
        const grant = inputs.authorities[i];
        // An absent or empty scope is semantically the id's default scope;
        // emit the legacy keys-only form so no snapshot grows a no-op object.
        const scopeIsEmpty = grant.scope === undefined
          || Object.keys(grant.scope).length === 0;
        const entry: AuthorityGrantSnapshotEntry = scopeIsEmpty
          ? identityKey
          : Object.freeze({ ref: identityKey, scope: grant.scope });
        perId[grant.id][perId[grant.id].length] = entry;
      }
    }
    const listing: Record<string, readonly AuthorityGrantSnapshotEntry[]> = {};
    for (let i = 0; i < AUTHORITY_IDS.length; i++) {
      const id = AUTHORITY_IDS[i];
      if (perId[id].length > 0) listing[id] = Object.freeze(perId[id]);
    }
    return listing;
  }

  /**
   * Lists the canonical `(realmId, agentId)` identity keys of the active agents
   * currently holding the publishing-authority grants (`@template:authority` /
   * `@hydration:authority`), as a source-compatible projection of
   * {@link listAuthorityGrants}.
   *
   * @returns Canonical identity keys per publishing authority.
   */
  listMetaAuthorityGrants(): { template: string[]; hydration: string[] } {
    const listing = this.listAuthorityGrants();
    return {
      template: listing[AGENT_AUTHORITIES.TEMPLATE] ? [...listing[AGENT_AUTHORITIES.TEMPLATE]] : [],
      hydration: listing[AGENT_AUTHORITIES.HYDRATION] ? [...listing[AGENT_AUTHORITIES.HYDRATION]] : []
    };
  }

  /**
   * Returns the frozen authority grant records registered for an active agent
   * (M1) — the registry-side source for *how far* each held capability reaches.
   *
   * Host-only surface: scopes never reach the identity projection, a
   * model-facing schema, a receipt, or an audit payload. Resolution is
   * canonical-key-capable with the unique-match bare-id fallback; unknown,
   * recycled, purged, or ambiguous refs resolve the empty list.
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key).
   * @returns Frozen grant records (empty when none).
   */
  getAuthorityGrants(agentId: string): readonly AuthorityGrantRecord[] {
    if (!agentId || typeof agentId !== 'string') return Object.freeze([]);
    const byKey = this.#authorityInputs.get(agentId);
    if (byKey) return byKey.authorities;
    const agent = this.#uniqueByBareId(this.#agents, agentId);
    if (!agent) return Object.freeze([]);
    const inputs = this.#authorityInputs.get(this.#agentIdentityKeyOf(agent));
    return inputs ? inputs.authorities : Object.freeze([]);
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
   * `grantRealmBypass`/`revokeRealmBypass`. Present-key replacement semantics
   * apply to the capability axis (extension wave): each supplied key replaces
   * its axis, every omitted key preserves its current value — so the store's
   * extension sweep can reauthorize the `extensions` axis alone without
   * clearing `privileged` or `allowedTools`.
   *
   * Authority gate: the caller must resolve to lifecycle authority — the exact
   * injected `InternalPrincipal` reference or a registry `AuthorityDescriptor`
   * holding `'*'`/`'@lifecycle:authority'`; everything else is denied with
   * `PERMISSION_DENIED` before any mutation. The agent config is not touched.
   *
   * @param agentId - Registered active agent identifier
   * @param input - Trusted capability inputs (`privileged`/`allowedTools`/`extensionTools`); any `realmBypass` or authority-grant key is rejected
   * @param callerContext - Caller context carrying `principal` or a registry `callerAgentId` identity
   * @returns The registered descriptor, or `null` for an unknown id
   * @throws `Error` - With code `'PERMISSION_DENIED'` when the caller lacks lifecycle authority or supplied a `realmBypass`/authority-grant key
   */

  reauthorizeAgent(
    agentId: string,
    input: {
      privileged?: boolean;
      allowedTools?: string[] | '*' | null;
      extensionTools?: readonly string[] | null;
      realmBypass?: boolean;
      /** @deprecated Operator-API-only; rejected when present. */
      templateAuthority?: boolean;
      /** @deprecated Operator-API-only; rejected when present. */
      hydrationAuthority?: boolean;
      /** Operator-API-only grant records; rejected when present. */
      authorities?: unknown;
      /** Exact authority-id keys are operator-API-only; rejected when present. */
      [authorityIdKey: string]: unknown;
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
    // Every authority id is likewise operator-API-only (M1; the publishing
    // pair included): any `authorities` key, legacy alias key, or exact-id key
    // through this capability path is denied for every caller — the exact
    // injected principal included — so authority can only flow through
    // grantAuthority/revokeAuthority (or the engine bootstrap). The denial
    // names the vocabulary, never a realm or scope value.
    if (input && typeof input === 'object' && hasAuthorityGrantInputKey(input)) {
      throw new PermissionDeniedError(
        `Permission denied: agent '${agentId}' authorities (${AUTHORITY_IDS.join(', ')}) are operator grants, `
        + 'never a reauthorize input (use grantAuthority/revokeAuthority)',
        { callerAgentId: principal && principal.kind === 'agent' ? principal.subject : null, code: 'PERMISSION_DENIED' }
      );
    }
    // Canonical-capable target resolution (extension wave): an exact
    // `(realmId, agentId)` identity key addresses its registration, a
    // realm-bound caller resolves inside its own scope first, and the bare
    // unique-match rule stays the fail-closed fallback.
    const activeAgent = this.#resolveMutationTarget(agentId, callerContext).active;
    // Unknown, recycled, or Realm-ambiguous ids never carry a descriptor.
    if (!activeAgent) return null;
    const identityKey = this.#agentIdentityKeyOf(activeAgent);
    // A capability reauthorize never touches the scope or publishing-authority
    // axes: the current grant states ride along unchanged (the dedicated API is
    // their only writer). The extension axis is replaced only when the trusted
    // `extensionTools` key is present; an omitted key preserves the current
    // effective grant set (extension wave).
    const currentInputs = this.#currentAuthorityInputs(identityKey);
    // Present-key replacement semantics: only the keys supplied by the trusted
    // caller replace their axis; every omitted axis keeps its current value.
    // The store's extension sweep supplies only `extensionTools`, so it can
    // never clear the capability selector or privilege as a side effect.
    return this.#registerAgentAuthority(identityKey, activeAgent.id, {
      ...currentInputs,
      ...(input && input.privileged !== undefined ? { privileged: input.privileged === true } : {}),
      ...(input && input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
      ...(input && input.extensionTools !== undefined ? { extensionTools: input.extensionTools } : {})
    });
  }

  // ====================================================================
  // M2 meta plane: parental inspect/edit + runtime safe-state queue
  // ====================================================================

  /**
   * Resolves the M2 caller: a registered agent descriptor with its exact
   * canonical identity key, realm membership, and trusted authority inputs.
   * Anonymous callers, the engine-internal principal, and unresolvable
   * identities resolve `null` (the caller must fail closed).
   *
   * @param callerContext - Trusted caller context (`{ callerAgentId, callerKey }`).
   * @returns The resolved caller facts, or `null`.
   * @internal
   */
  #resolveMetaAgentCaller(callerContext: unknown): {
    principal: AuthorityDescriptor;
    callerId: string;
    callerKey: string;
    callerRealmId: string | null;
    inputs: AuthorityInputRecord | null;
  } | null {
    const principal = this.#resolveCallerPrincipal({ callerContext });
    if (!principal || principal.kind !== 'agent') return null;
    const callerKey = this.#identityKeyForDescriptor(principal);
    if (!callerKey) return null;
    const record = this.#agents.get(callerKey);
    if (!record) return null;
    return {
      principal,
      callerId: principal.subject,
      callerKey,
      callerRealmId: this.#agentRealmId(record),
      inputs: this.#authorityInputs.get(callerKey) || null
    };
  }

  /**
   * Resolves the M2 target: an active registration addressed by canonical key
   * or unique bare id. Unknown, recycled, ambiguous, and realm-vocabulary refs
   * resolve `null` — every one of them shares the caller's uniform denial, so
   * no target-existence or relationship oracle exists.
   *
   * @param targetRef - Caller-supplied target reference.
   * @returns The active target record, or `null`.
   * @internal
   */
  #resolveMetaEditTarget(targetRef: string): Agent | null {
    if (typeof targetRef !== 'string' || !targetRef) return null;
    if (isRealmVocabularyId(targetRef)) return null;
    const byKey = this.#agents.get(targetRef);
    if (byKey) return byKey;
    return this.#uniqueByBareId(this.#agents, targetRef);
  }

  /**
   * Reports whether the target records the caller as its direct parent
   * (registry parentage only, never a caller claim).
   *
   * @param targetAgent - Resolved target record.
   * @param callerId - Bare caller id.
   * @returns True for a direct spawn of the caller.
   * @internal
   */
  #isDirectChildOf(targetAgent: Agent, callerId: string): boolean {
    return Boolean(callerId) && (
      targetAgent.config?.spawnedBy === callerId || targetAgent.config?.creatorId === callerId
    );
  }

  /**
   * Tests whether one `@agent:*` grant scope matches the concrete target
   * (meta-plane spec §1.2/§1.3): the `realms` bound (or the caller's own realm
   * when absent) confines the target, then `targets` / `ownSpawns` /
   * `realmMembers` select it. An absent or selector-free scope uses the id's
   * default (`ownSpawns`).
   *
   * @param scope - Grant scope record, or undefined.
   * @param targetAgent - Resolved target record.
   * @param targetRealmId - Target realm membership.
   * @param callerId - Bare caller id.
   * @param callerRealmId - Caller realm membership.
   * @returns True when the scope reaches the target.
   * @internal
   */
  #authorityScopeMatchesAgent(
    scope: AuthorityScopeRecord | undefined,
    targetAgent: Agent,
    targetRealmId: string | null,
    callerId: string,
    callerRealmId: string | null
  ): boolean {
    if (scope && Array.isArray(scope.realms)) {
      if (!scope.realms.includes(targetRealmId || '')) return false;
    } else if (targetRealmId !== callerRealmId) {
      return false;
    }
    const isChild = this.#isDirectChildOf(targetAgent, callerId);
    const hasExplicitSelector = Boolean(
      scope && (Array.isArray(scope.targets) || scope.ownSpawns === true || scope.realmMembers === true)
    );
    if (!hasExplicitSelector) return isChild;
    if (scope && Array.isArray(scope.targets) && scope.targets.includes(targetAgent.id)) return true;
    if (scope && scope.ownSpawns === true && isChild) return true;
    if (scope && scope.realmMembers === true) return true;
    return false;
  }

  /**
   * Resolves the M2 tier verdict for one caller/target pair (spec §3.2):
   * self-inspection, the inherent parental tier (same realm + registered
   * direct parentage), or the exact scoped meta grant. Every other
   * combination — non-child peers, other-realm targets, out-of-scope grants —
   * resolves `null` and shares the caller's uniform denial.
   *
   * @param caller - Resolved caller facts.
   * @param targetAgent - Resolved target record.
   * @param operation - `'inspect'` or `'edit'`.
   * @param targetRealmId - Target realm membership.
   * @returns The verdict, or `null` when the caller is unauthorized.
   * @internal
   */
  #resolveMetaAgentVerdict(
    caller: {
      principal: AuthorityDescriptor;
      callerId: string;
      callerKey: string;
      callerRealmId: string | null;
      inputs: AuthorityInputRecord | null;
    },
    targetAgent: Agent,
    operation: 'inspect' | 'edit',
    targetRealmId: string | null
  ): MetaAgentVerdict | null {
    if (operation === 'inspect' && targetAgent.id === caller.callerId) {
      return { tier: 'self', fields: [] };
    }
    if (this.#isDirectChildOf(targetAgent, caller.callerId) && targetRealmId === caller.callerRealmId) {
      return { tier: 'parental', fields: PARENTAL_EDIT_FIELD_TOKENS };
    }
    const authorityId = operation === 'inspect' ? AGENT_AUTHORITIES.AGENT_INSPECT : AGENT_AUTHORITIES.AGENT_EDIT;
    const allow = caller.principal.allow;
    if (!allow || typeof allow.has !== 'function' || !allow.has(authorityId)) return null;
    const grants = caller.inputs ? caller.inputs.authorities : [];
    let grant: AuthorityGrantRecord | null = null;
    for (let i = 0; i < grants.length; i++) {
      if (grants[i].id === authorityId) {
        grant = grants[i];
        break;
      }
    }
    // The grant record is the trusted source for *how far*; a descriptor that
    // allows the id without a matching registry record is inconsistent and
    // fails closed rather than widening to the default scope.
    if (!grant) return null;
    if (!this.#authorityScopeMatchesAgent(grant.scope, targetAgent, targetRealmId, caller.callerId, caller.callerRealmId)) {
      return null;
    }
    if (operation === 'inspect') return { tier: 'meta', fields: [] };
    const fields = grant.scope && Array.isArray(grant.scope.fields)
      ? grant.scope.fields
      : PARENTAL_EDIT_FIELD_TOKENS;
    return { tier: 'meta', fields };
  }

  /**
   * Builds the host-side authority summary of one registration (audit/receipt
   * payload): canonical baked list, trusted privilege flag, extension call
   * names, and held authority ids. Never carries scopes, realm ids, or
   * workspace keys.
   *
   * @param identityKey - Canonical identity key.
   * @returns The frozen authority summary.
   * @internal
   */
  #authoritySummaryOf(identityKey: string): AgentAuthoritySummary {
    const descriptor = this.#authorityRegistry.get(identityKey) || null;
    const inputs = this.#authorityInputs.get(identityKey) || null;
    if (!descriptor) {
      return Object.freeze({ baked: Object.freeze([]), privileged: false, extensions: Object.freeze([]), authorities: Object.freeze([]) });
    }
    const baked: string[] = [];
    if (descriptor.allow.has('*')) {
      baked[baked.length] = '*';
    } else {
      const canonical = canonicalEffectiveToolNames(descriptor.allow);
      for (const name of canonical) baked[baked.length] = name;
    }
    const extensions: string[] = [];
    for (const name of descriptor.extensions) extensions[extensions.length] = name;
    const authorities: string[] = [];
    if (inputs) {
      for (let i = 0; i < inputs.authorities.length; i++) authorities[authorities.length] = inputs.authorities[i].id;
    }
    return Object.freeze({
      baked: Object.freeze(baked),
      privileged: Boolean(inputs && inputs.privileged === true) || descriptor.allow.has('*'),
      extensions: Object.freeze(extensions),
      authorities: Object.freeze(authorities)
    });
  }

  /**
   * Builds the bounded host-side inspection projection of an authorized target
   * (spec §3.3). The `spawnedBy` link is exposed only to the parent or a
   * meta-scoped caller; a self-inspection carries the caller's own authority
   * ids (never scopes). The raw workspace label is masked by the tool boundary.
   *
   * @param targetAgent - Resolved target record.
   * @param targetKey - Canonical target identity key.
   * @param verdict - Resolved tier verdict.
   * @returns The bounded projection.
   * @internal
   */
  #buildAgentInspectProjection(
    targetAgent: Agent,
    targetKey: string,
    verdict: MetaAgentVerdict
  ): AgentInspectProjection {
    const descriptor = this.#authorityRegistry.get(targetKey) || null;
    const inputs = this.#authorityInputs.get(targetKey) || null;
    const baked: string[] = [];
    if (descriptor) {
      if (descriptor.allow.has('*')) {
        baked[baked.length] = '*';
      } else {
        const canonical = canonicalEffectiveToolNames(descriptor.allow);
        for (const name of canonical) baked[baked.length] = name;
      }
    }
    const extensions: string[] = descriptor ? [...descriptor.extensions] : [];
    const config = targetAgent.config || {};
    const model: { presetId?: string; modelId?: string; providerId?: string } = {};
    if (typeof config.presetId === 'string' && config.presetId) model.presetId = config.presetId;
    const modelConfig = config.modelConfig;
    if (modelConfig && typeof modelConfig === 'object') {
      const record = modelConfig as Record<string, unknown>;
      if (typeof record.modelId === 'string' && record.modelId) model.modelId = record.modelId;
      if (typeof record.providerId === 'string' && record.providerId) model.providerId = record.providerId;
    }
    const identityKey = targetKey;
    const unreadCount = typeof this.#messagingBus?.getUnreadCount === 'function'
      ? this.#messagingBus.getUnreadCount(identityKey)
      : (this.#messagingBus?.listInbox(identityKey, { unreadOnly: true })?.length || 0);
    const projection: {
      id: string;
      name: string;
      role: string;
      state: string;
      stateDetail?: string | null;
      privileged: boolean;
      tools: { baked: readonly string[]; extensions: readonly string[] };
      model: { presetId?: string; modelId?: string; providerId?: string };
      workspace: string | null;
      spawnedBy?: string | null;
      turns: number;
      unreadCount: number;
      createdAt: number | null;
      authorities?: readonly string[];
    } = {
      id: targetAgent.id,
      name: targetAgent.name || config.name || targetAgent.id,
      role: config.role || (config.privileged ? 'admin' : 'user'),
      state: targetAgent.state,
      stateDetail: targetAgent.stateDetail || null,
      privileged: Boolean(inputs && inputs.privileged === true) || Boolean(descriptor && descriptor.allow.has('*')),
      tools: { baked: Object.freeze(baked), extensions },
      model,
      workspace: typeof config.workspaceId === 'string' && config.workspaceId ? config.workspaceId : targetAgent.id,
      turns: typeof targetAgent.turnCount === 'number' ? targetAgent.turnCount : 0,
      unreadCount,
      createdAt: typeof targetAgent.createdAt === 'number' ? targetAgent.createdAt : null
    };
    if (verdict.tier === 'parental' || verdict.tier === 'meta') {
      projection.spawnedBy = config.spawnedBy || config.creatorId || null;
    }
    if (verdict.tier === 'self') {
      const authorities: string[] = [];
      if (inputs) {
        for (let i = 0; i < inputs.authorities.length; i++) authorities[authorities.length] = inputs.authorities[i].id;
      }
      projection.authorities = Object.freeze(authorities);
    }
    return Object.freeze(projection) as AgentInspectProjection;
  }

  /**
   * Reads and validates one M2 update patch: a non-empty plain object whose
   * keys are either editable (maps to a ratified field token) or explicitly
   * denied (uniform bound denial). Unknown keys and malformed values reject
   * with `INVALID_ARGUMENTS` before any mutation; denied-key presence fails
   * the whole call with the uniform bound denial.
   *
   * @param patch - Caller-supplied patch candidate.
   * @returns The frozen patch snapshot and its field tokens.
   * @throws `Error` - Code `PERMISSION_DENIED` (denied key) or `INVALID_ARGUMENTS` (malformed patch).
   * @internal
   */
  #normalizeMetaAgentPatch(patch: unknown): { update: ConfigUpdateSnapshot; fields: readonly string[] } {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      const err: CodedError = new Error('update_agent requires a patch object with at least one editable field');
      err.code = 'INVALID_ARGUMENTS';
      throw err;
    }
    const update = snapshotCallerObject(patch);
    const keys = Object.keys(update);
    if (keys.length === 0) {
      const err: CodedError = new Error('update_agent requires a patch object with at least one editable field');
      err.code = 'INVALID_ARGUMENTS';
      throw err;
    }
    for (let i = 0; i < keys.length; i++) {
      if (isDeniedMetaEditPatchKey(keys[i])) {
        const err: CodedError = new Error(META_AGENT_EDIT_BOUND_DENIED_MESSAGE);
        err.code = 'PERMISSION_DENIED';
        throw err;
      }
    }
    const fields: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const token = EDIT_FIELD_TOKEN_BY_PATCH_KEY[key];
      if (!token) {
        const err: CodedError = new Error(`update_agent does not accept the field '${key}'`);
        err.code = 'INVALID_ARGUMENTS';
        throw err;
      }
      if (!fields.includes(token)) fields[fields.length] = token;
    }
    const invalidValue = (detail: string): never => {
      const err: CodedError = new Error(`update_agent rejected a field value: ${detail}`);
      err.code = 'INVALID_ARGUMENTS';
      throw err;
    };
    if (update.privileged !== undefined && typeof update.privileged !== 'boolean') invalidValue('privileged must be a boolean');
    if (update.maxTurns !== undefined && (typeof update.maxTurns !== 'number' || !Number.isFinite(update.maxTurns))) {
      invalidValue('maxTurns must be a finite number');
    }
    for (const key of ['systemPrompt', 'name', 'triggerPolicy', 'toolPreset']) {
      const value = (update as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== 'string') invalidValue(`${key} must be a string`);
    }
    for (const key of ['tools', 'allowedTools']) {
      const value = (update as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (typeof value === 'string') continue;
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        invalidValue(`${key} must be an array of tool names`);
      }
    }
    return { update, fields: Object.freeze(fields) };
  }

  /**
   * Tests whether a patch's tool selector claims authority vocabulary: an
   * exact `AUTHORITY_IDS` member, a case/space spelling of one, or the
   * lifecycle-authority capability. Such a selector is a grant attempt, never
   * capability data, and fails the whole edit.
   *
   * @param update - Patch snapshot.
   * @returns True when the selector claims authority vocabulary.
   * @internal
   */
  #patchClaimsAuthoritySelector(update: ConfigUpdateSnapshot): boolean {
    const rawTools = update.allowedTools !== undefined
      ? update.allowedTools
      : (update.tools !== undefined
        ? update.tools
        : (update.toolPreset !== undefined
          ? update.toolPreset
          : (update.tool_preset !== undefined ? update.tool_preset : undefined)));
    if (rawTools === undefined) return false;
    const resolved = resolveToolPreset(rawTools as string | readonly string[] | ReadonlySet<string> | null);
    for (let i = 0; i < resolved.length; i++) {
      const entry = resolved[i];
      if (typeof entry !== 'string') continue;
      if (entry === LIFECYCLE_AUTHORITY_CAPABILITY) return true;
      if (AUTHORITY_ID_SET.has(entry)) return true;
      const trimmed = entry.trim().toLowerCase();
      if (trimmed && AUTHORITY_ID_SET.has(trimmed)) return true;
    }
    return false;
  }

  /**
   * Evaluates the ≤-editor bound B1-B4 on the resulting state (spec §1.3):
   * the resulting baked set must be a subset of the editor's (a resulting
   * `privileged: true` counts as TOP), the target's extension grants and held
   * authorities must be subsets of the editor's, and every requested field
   * token must be in the editor's tier field set. The check runs before any
   * mutation.
   *
   * @param caller - Resolved caller facts.
   * @param verdict - Resolved tier verdict.
   * @param targetKey - Canonical target identity key.
   * @param targetDescriptor - Target frozen descriptor.
   * @param update - Patch snapshot.
   * @param requestedFields - Field tokens the patch touches.
   * @returns True when the resulting state stays within the editor's bounds.
   * @internal
   */
  #evaluateMetaAgentEditBound(
    caller: { principal: AuthorityDescriptor; inputs: AuthorityInputRecord | null },
    verdict: MetaAgentVerdict,
    targetKey: string,
    targetDescriptor: AuthorityDescriptor | null,
    update: ConfigUpdateSnapshot,
    requestedFields: readonly string[]
  ): boolean {
    for (let i = 0; i < requestedFields.length; i++) {
      if (!verdict.fields.includes(requestedFields[i])) return false;
    }
    if (this.#patchClaimsAuthoritySelector(update)) return false;
    if (!targetDescriptor) return false;
    const editorBaked = canonicalEffectiveToolNames(caller.principal.allow);
    let resultingBaked: Set<string>;
    if (update.privileged === true) {
      resultingBaked = new Set<string>(['*']);
    } else {
      const rawTools = update.allowedTools !== undefined
        ? update.allowedTools
        : (update.tools !== undefined
          ? update.tools
          : (update.toolPreset !== undefined
            ? update.toolPreset
            : (update.tool_preset !== undefined ? update.tool_preset : undefined)));
      resultingBaked = rawTools === undefined
        ? canonicalEffectiveToolNames(targetDescriptor.allow)
        : canonicalEffectiveToolNames(resolveToolPreset(rawTools as string | readonly string[] | ReadonlySet<string> | null));
    }
    if (!isEffectiveToolSubset(resultingBaked, editorBaked)) return false;
    const editorExtensions = caller.principal.extensions;
    for (const name of targetDescriptor.extensions) {
      if (!editorExtensions || typeof editorExtensions.has !== 'function' || !editorExtensions.has(name)) return false;
    }
    const targetInputs = this.#authorityInputs.get(targetKey) || null;
    const editorAuthorities: string[] = [];
    if (caller.inputs) {
      for (let i = 0; i < caller.inputs.authorities.length; i++) editorAuthorities[editorAuthorities.length] = caller.inputs.authorities[i].id;
    }
    if (targetInputs) {
      for (let i = 0; i < targetInputs.authorities.length; i++) {
        if (!editorAuthorities.includes(targetInputs.authorities[i].id)) return false;
      }
    }
    return true;
  }

  /**
   * Emits the uniform `agent_edit_denied` audit event and throws the M2
   * permission error. Resolution failures carry only the bare actor id (never
   * the target claim); bound/field failures may carry the bare target id.
   *
   * @param message - The tool's uniform denial message.
   * @param actorId - Bare actor id, when resolvable.
   * @param targetId - Bare target id, when resolved.
   * @throws `Error` - Code `PERMISSION_DENIED`.
   * @internal
   */
  #denyMetaAgentEdit(message: string, actorId: string | null, targetId: string | null = null): never {
    const payload: Record<string, unknown> = {};
    if (actorId) payload.actorId = actorId;
    if (targetId) payload.targetId = targetId;
    this.#emit({
      type: 'agent_edit_denied',
      ...(targetId ? { agentId: targetId } : {}),
      payload
    });
    throw new PermissionDeniedError(message, { callerAgentId: actorId || null, code: 'PERMISSION_DENIED' });
  }

  /**
   * Inspects one target agent under the M2 parental (inherent, direct spawns
   * only) or meta (exact scoped `@agent:inspect`) tier. Self-inspection is
   * allowed. Every resolution failure shares one uniform, realm-opaque
   * denial, so no target-existence or relationship oracle exists.
   *
   * @param targetRef - Target reference (bare realm-local id or canonical key).
   * @param callerContext - Trusted caller context (`{ callerAgentId, callerKey }`).
   * @returns The bounded inspection projection.
   * @throws `Error` - Code `'PERMISSION_DENIED'` for every unauthorized target.
   */
  inspectAgent(targetRef: string, callerContext: unknown = null): AgentInspectProjection {
    const caller = this.#resolveMetaAgentCaller(callerContext);
    const target = caller ? this.#resolveMetaEditTarget(targetRef) : null;
    if (!caller || !target) throw this.#denyInspect(caller ? caller.callerId : null);
    const targetKey = this.#agentIdentityKeyOf(target);
    const verdict = this.#resolveMetaAgentVerdict(caller, target, 'inspect', this.#agentRealmId(target));
    if (!verdict) throw this.#denyInspect(caller.callerId);
    const projection = this.#buildAgentInspectProjection(target, targetKey, verdict);
    this.#emit({
      type: 'agent_inspected',
      agentId: target.id,
      payload: { actorId: caller.callerId, targetId: target.id, tier: verdict.tier }
    });
    return projection;
  }

  /** Uniform `inspect_agent` denial: no audit event and no target echo. @internal */
  #denyInspect(actorId: string | null): PermissionDeniedError {
    return new PermissionDeniedError(META_AGENT_INSPECT_DENIED_MESSAGE, {
      callerAgentId: actorId || null,
      code: 'PERMISSION_DENIED'
    });
  }

  /**
   * Updates one target agent's editable settings under the M2 parental/meta
   * tiers. The patch is validated (denied keys fail the whole call; unknown
   * keys and malformed values reject), the ≤-editor bound is evaluated on the
   * resulting state, and the edit either applies immediately through the same
   * intrinsic channel as `updateAgentConfig` or is queued for the target's
   * next safe state. Self-target updates are denied.
   *
   * @param targetRef - Target reference (bare realm-local id or canonical key).
   * @param patch - Editable patch (`tools`/`allowedTools`/`toolPreset`, `privileged`, `triggerPolicy`, `systemPrompt`, `maxTurns`, `name`).
   * @param callerContext - Trusted caller context (`{ callerAgentId, callerKey }`).
   * @returns The applied/deferred receipt with before/after summaries.
   * @throws `Error` - Code `'PERMISSION_DENIED'` for unauthorized targets, denied keys, or bound violations; `'INVALID_ARGUMENTS'` for malformed patches.
   */
  updateAgent(targetRef: string, patch: unknown, callerContext: unknown = null): AgentUpdateReceipt {
    const caller = this.#resolveMetaAgentCaller(callerContext);
    const target = caller ? this.#resolveMetaEditTarget(targetRef) : null;
    if (!caller || !target || target.id === caller.callerId) {
      this.#denyMetaAgentEdit(META_AGENT_EDIT_DENIED_MESSAGE, caller ? caller.callerId : null, null);
    }
    const targetKey = this.#agentIdentityKeyOf(target);
    const targetRealmId = this.#agentRealmId(target);
    const verdict = this.#resolveMetaAgentVerdict(caller, target, 'edit', targetRealmId);
    if (!verdict || verdict.tier === 'self') this.#denyMetaAgentEdit(META_AGENT_EDIT_DENIED_MESSAGE, caller.callerId, null);
    const { update, fields } = this.#normalizeMetaAgentPatch(patch);
    const targetDescriptor = this.#authorityRegistry.get(targetKey) || null;
    if (!this.#evaluateMetaAgentEditBound(caller, verdict, targetKey, targetDescriptor, update, fields)) {
      this.#denyMetaAgentEdit(META_AGENT_EDIT_BOUND_DENIED_MESSAGE, caller.callerId, target.id);
    }
    const before = this.#authoritySummaryOf(targetKey);
    // Safe state: a busy target queues the edit (latest-wins, bounded); the
    // flush re-authorizes against the current actor and target state.
    if (this.#isBusyAgentRecord(target)) {
      this.#queuePendingAgentEdit(targetKey, {
        targetId: target.id,
        actorId: caller.callerId,
        actorKey: caller.callerKey,
        tier: verdict.tier,
        patch: Object.freeze({ ...update }),
        fields
      });
      this.#emit({
        type: 'agent_edit_deferred',
        agentId: target.id,
        payload: { actorId: caller.callerId, targetId: target.id, fields, reason: 'target_busy' }
      });
      return Object.freeze({
        success: true,
        target: target.id,
        tier: verdict.tier,
        applied: false,
        deferred: true,
        fields,
        before,
        after: null
      });
    }
    return this.#applyMetaAgentEdit(target, targetKey, update, fields, caller.callerId, verdict);
  }

  /**
   * Applies one already-authorized edit immediately and audits the transition.
   *
   * @param target - Resolved target record.
   * @param targetKey - Canonical target identity key.
   * @param update - Validated patch snapshot.
   * @param fields - Ratified field tokens.
   * @param actorId - Bare actor id.
   * @param verdict - Resolved tier verdict.
   * @returns The applied receipt.
   * @internal
   */
  #applyMetaAgentEdit(
    target: Agent,
    targetKey: string,
    update: ConfigUpdateSnapshot,
    fields: readonly string[],
    actorId: string,
    verdict: { readonly tier: 'parental' | 'meta'; readonly fields: readonly string[] }
  ): AgentUpdateReceipt {
    const before = this.#authoritySummaryOf(targetKey);
    this.#applyConfigUpdate(target, update, null, verdict.tier);
    const after = this.#authoritySummaryOf(targetKey);
    this.#emit({
      type: 'agent_edit_applied',
      agentId: target.id,
      payload: { actorId, targetId: target.id, tier: verdict.tier, fields, before, after }
    });
    return Object.freeze({
      success: true,
      target: target.id,
      tier: verdict.tier,
      applied: true,
      deferred: false,
      fields,
      before,
      after
    });
  }

  /**
   * Reports whether a record is busy executing a turn (the safe-state gate):
   * an in-flight turn promise or a running/waiting/canceling state.
   *
   * @param agent - Candidate record.
   * @returns True when an edit must be deferred.
   * @internal
   */
  #isBusyAgentRecord(agent: Agent): boolean {
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
   * Reports whether a record's lifecycle state is busy executing a turn (the
   * flush-time safe-state gate): `turn_complete` fires after the engine has
   * already moved the agent to `IDLE`, so the flush checks state only — the
   * in-flight turn promise may still be settling at emission time and is not a
   * reason to defer an already-safe edit.
   *
   * @param agent - Candidate record.
   * @returns True when the edit must wait for a later safe state.
   * @internal
   */
  #isAgentStateBusy(agent: Agent): boolean {
    if (!agent) return false;
    return agent.state === AGENT_STATES.RUNNING
      || agent.state === AGENT_STATES.WAITING_FOR_MESSAGE
      || agent.state === AGENT_STATES.WAITING_FOR_INPUT
      || agent.state === AGENT_STATES.WAITING_FOR_DEPENDENTS
      || agent.state === AGENT_STATES.CANCELING;
  }

  /**
   * Queues one pending edit with per-target latest-wins semantics, bounded by
   * `META_PENDING_EDITS_CAP` (oldest entry evicted first). Re-setting an
   * existing target moves it to the newest position.
   *
   * @param targetKey - Canonical target identity key.
   * @param entry - Pending edit record.
   * @internal
   */
  #queuePendingAgentEdit(targetKey: string, entry: PendingAgentEdit): void {
    if (this.#pendingAgentEdits.has(targetKey)) this.#pendingAgentEdits.delete(targetKey);
    this.#pendingAgentEdits.set(targetKey, Object.freeze(entry));
    while (this.#pendingAgentEdits.size > META_PENDING_EDITS_CAP) {
      const oldest = this.#pendingAgentEdits.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.#pendingAgentEdits.get(oldest);
      this.#pendingAgentEdits.delete(oldest);
      // Bounded queue: the oldest edit is evicted fail-closed and audited, so
      // a dropped edit is never silent.
      if (evicted) this.#dropPendingAgentEdit(evicted, 'queue_full');
    }
  }

  /**
   * Flushes the pending edits queued for one target bare id (called by the
   * runtime on the target's `turn_complete`): each entry is re-authorized
   * against the current actor and target state, applied through the intrinsic
   * channel when still valid, and dropped fail-closed otherwise. A target that
   * is somehow still busy re-queues its entry rather than losing it.
   * Exception-shielded: a flush failure drops the entry with an audit event.
   *
   * @param agentId - Bare realm-local target id.
   * @returns Number of entries applied.
   */
  flushPendingAgentEdits(agentId: string): number {
    if (!agentId || typeof agentId !== 'string') return 0;
    if (this.#pendingAgentEdits.size === 0) return 0;
    let applied = 0;
    const entries = [...this.#pendingAgentEdits.entries()];
    for (let i = 0; i < entries.length; i++) {
      const [targetKey, entry] = entries[i];
      if (entry.targetId !== agentId) continue;
      this.#pendingAgentEdits.delete(targetKey);
      if (this.#flushPendingAgentEdit(targetKey, entry)) applied += 1;
    }
    return applied;
  }

  /**
   * Drops every pending edit queued for one target bare id (called by the
   * runtime on kill/recycle/purge): a terminated registration never receives a
   * deferred edit.
   *
   * @param agentId - Bare realm-local target id.
   * @returns Number of entries dropped.
   */
  dropPendingAgentEdits(agentId: string): number {
    if (!agentId || typeof agentId !== 'string') return 0;
    let dropped = 0;
    const entries = [...this.#pendingAgentEdits.entries()];
    for (let i = 0; i < entries.length; i++) {
      const [targetKey, entry] = entries[i];
      if (entry.targetId !== agentId) continue;
      this.#pendingAgentEdits.delete(targetKey);
      this.#dropPendingAgentEdit(entry, 'target_terminated');
      dropped += 1;
    }
    return dropped;
  }

  /**
   * Flushes one queued edit against the current state (see
   * {@link flushPendingAgentEdits}); returns true only when the edit applied.
   *
   * @param targetKey - Canonical target identity key.
   * @param entry - Pending edit record.
   * @returns True when the edit applied.
   * @internal
   */
  #flushPendingAgentEdit(targetKey: string, entry: PendingAgentEdit): boolean {
    try {
      const target = this.#agents.get(targetKey) || null;
      if (!target) return this.#dropPendingAgentEdit(entry, 'target_gone');
      const actorRecord = this.#agents.get(entry.actorKey) || null;
      const actorPrincipal = this.#authorityRegistry.get(entry.actorKey) || null;
      if (!actorRecord || !actorPrincipal || actorPrincipal.kind !== 'agent') {
        return this.#dropPendingAgentEdit(entry, 'actor_gone');
      }
      const caller = {
        principal: actorPrincipal,
        callerId: entry.actorId,
        callerKey: entry.actorKey,
        callerRealmId: this.#agentRealmId(actorRecord),
        inputs: this.#authorityInputs.get(entry.actorKey) || null
      };
      const verdict = this.#resolveMetaAgentVerdict(caller, target, 'edit', this.#agentRealmId(target));
      if (!verdict || verdict.tier === 'self') return this.#dropPendingAgentEdit(entry, 'unauthorized');
      if (this.#isAgentStateBusy(target)) {
        // Still busy (for example a cancellation race): keep the edit queued
        // rather than applying mid-turn or losing it.
        this.#queuePendingAgentEdit(targetKey, entry);
        return false;
      }
      const targetDescriptor = this.#authorityRegistry.get(targetKey) || null;
      if (!this.#evaluateMetaAgentEditBound(caller, verdict, targetKey, targetDescriptor, entry.patch, entry.fields)) {
        return this.#dropPendingAgentEdit(entry, 'bound_changed');
      }
      this.#applyMetaAgentEdit(target, targetKey, entry.patch, entry.fields, entry.actorId, verdict);
      return true;
    } catch {
      try {
        this.#dropPendingAgentEdit(entry, 'flush_failed');
      } catch {
        // Best-effort audit; the entry is already removed from the queue.
      }
      return false;
    }
  }

  /**
   * Drops one queued edit and audits it.
   *
   * @param entry - Pending edit record.
   * @param reason - Machine-readable drop reason.
   * @returns Always false (helper return shape).
   * @internal
   */
  #dropPendingAgentEdit(entry: PendingAgentEdit, reason: string): false {
    this.#emit({
      type: 'agent_edit_dropped',
      agentId: entry.targetId,
      payload: { actorId: entry.actorId, targetId: entry.targetId, fields: entry.fields, reason }
    });
    return false;
  }

  /**
   * Clears every registered authority descriptor. Called by the facade on
   * `reset()`/`destroy()` so stale descriptor references authorize nothing.
   */

  clearAuthorityRegistry(): void {
    this.#authorityRegistry.clear();
    this.#authorityInputs.clear();
    this.#pendingAgentEdits.clear();
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
   *    - Child agent `allowedTools` are clamped to a subset of the creator's
   *      effective tools for EVERY resolved agent creator — lifecycle-authority
   *      holders included (ratified child ⊆ spawner invariant, ticket 1eca963);
   *      a `'*'` creator is equivalent to any requested set. Capability comes
   *      only from `allowedTools`/`tools` or `toolPreset`/`tool_preset` —
   *      `role` is a pure label. With neither selector and a resolved agent
   *      caller, the default is `readonly_collaborator ∩ creator tools`, or the
   *      creator's own effective set when that intersection is empty (never a
   *      zero-tool child while the creator has tools). Principal-less
   *      host/operator launches keep the legacy default (`[]`) and full
   *      pinning.
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
   * 10. If `initialPrompt` is provided, dispatches the initial conversational
   *    turn according to the trusted `initialTurnMode` option (ratified prompt
   *    contract, ticket 4692014). `'await'` (the direct-launch default) waits
   *    for the completed turn and rethrows a turn failure to the caller;
   *    `'detach'` (the model-facing `spawn_agent` default) queues the prompt
   *    and resolves the launch immediately, recording a later failure on the
   *    child (`lastError`/state detail) without unwinding it. When the runtime
   *    exposes the queue-backed `enqueueUserTurn` entry the launch directive is
   *    dispatched through the centralized `TriggerQueue` (`TRIGGER_TYPES.USER`,
   *    MOD-21 W7); hosts without a `TriggerQueue` use
   *    `runtime.executeAgentTurn` directly.
   *
   * If a registration-phase step fails, partial registrations (registry entry,
   * mail subscription, bus registration) are unwound and any consumed recycled
   * entry is restored byte-identically before the error is rethrown. The
   * initial-prompt turn phase runs after registration and never unwinds the
   * registered child, whatever the turn outcome.
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
   * @throws `Error` - The child turn error in `'await'` mode (the child stays registered)
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
    // Initial-turn policy (ratified prompt contract, ticket 4692014): the
    // trusted unified-options channel chooses `'detach'` (queue the prompt and
    // resolve the launch immediately) or `'await'` (wait for the completed
    // first turn). Direct/legacy launches default to `'await'`; the
    // model-facing `spawn_agent` tool selects `'detach'` by default.
    let initialTurnMode: 'await' | 'detach' = 'await';
    // Declared baked history (Wave T, ticket 7e6edae) is read from the unified
    // options object only; legacy positional forms never carry it.
    let historyInput: unknown = null;
    // Trusted store-computed extension grant set (extension wave) is likewise
    // read from the unified options object only: the effective extension axis
    // is never derived from `config.extensionTools` (a selector), from
    // `privileged`, or from any legacy channel.
    let extensionToolsInput: unknown = null;

    // Detect if optionsOrConfig is LaunchAgentOptions: { config: {...}, model?, provider?, initialPrompt?, history?, callerContext?, principal? }
    if (options.config && typeof options.config === 'object' && typeof options.config.id === 'string') {
      config = { ...options.config };
      model = options.model || null;
      provider = options.provider || model?.provider || null;
      initialPrompt = options.initialPrompt || null;
      callerContext = options.callerContext || null;
      principal = options.principal || null;
      historyInput = options.history ?? null;
      extensionToolsInput = options.extensionTools ?? null;
      initialTurnMode = options.initialTurnMode === 'detach' ? 'detach' : 'await';
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

    // Explicit authority-grant composition (M1): same engine rule as
    // `realmBypass`. Only the exact injected `InternalPrincipal` (the engine
    // bootstrap) may compose grants; every other caller's `authorities` list
    // and legacy `templateAuthority`/`hydrationAuthority` aliases are ignored
    // (never denied — ignored, like `realmBypass`). Operator grants/revokes
    // flow exclusively through the generic grant API. Composition maps through
    // `AUTHORITY_IDS` fail-closed (unknown ids skipped, malformed scopes drop
    // the record), so engine input never widens the vocabulary.
    const composedAuthorities: readonly AuthorityGrantRecord[] = isEnginePrincipal
      ? composeEngineAuthorityGrants(config)
      : Object.freeze([]);

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

    // Capability selection (ratified contract, ticket 1eca963): the child's
    // tools come from an explicit list (`allowedTools`/`tools`) or a preset
    // (`toolPreset`/`tool_preset`) only — `role` stays a pure label and is
    // never a capability fallback. With neither given, a resolved agent caller
    // defaults to `readonly_collaborator ∩ spawner tools` (the spawner's own
    // effective set when that intersection is empty), so a spawn never
    // registers an inert zero-tool child while the spawner has tools;
    // principal-less host/operator/engine launches keep the legacy
    // `resolveToolPreset(undefined)` → `[]` behavior.
    const requestedTools = config.allowedTools !== undefined
      ? config.allowedTools
      : (config.tools !== undefined ? config.tools : presetSelector);
    let allowedTools: string[];
    if (requestedTools !== undefined) {
      allowedTools = resolveToolPreset(requestedTools);
    } else if (resolvedPrincipal && resolvedPrincipal.kind === 'agent') {
      allowedTools = resolveAgentCallerDefaultTools(creatorAgent);
    } else {
      allowedTools = resolveToolPreset(undefined);
    }

    // Child ⊆ spawner invariant (ratified contract; the SEC-2 clamp is the
    // documented rule, not a silent surprise): every spawning agent —
    // lifecycle-authority holders included — can only produce a child with
    // less-or-equivalent tool access. A `'*'` spawner is equivalent to any
    // requested set, so a `'*'` child from a `'*'` spawner stays allowed; a
    // restricted spawner intersects. Principal-less host/operator launches
    // keep full pinning.
    if (creatorAgent) {
      const creatorTools = resolveToolPreset(creatorAgent.config?.allowedTools);
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

    // Authority ids are grants, never selector data (M1; the publishing pair
    // included): every `AUTHORITY_IDS` member is stripped from each composed
    // selector for every caller, so no launch/spawn config can smuggle one
    // into the frozen descriptor. The dedicated operator grant API and the
    // engine bootstrap are their only writers (and the descriptor rebuild
    // strips them again as defense in depth).
    if (Array.isArray(allowedTools)) {
      allowedTools = allowedTools.filter((tool) => !AUTHORITY_ID_SET.has(tool));
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
      // Per-agent extension selector state (extension wave): the effective
      // descriptor axis is composed separately from the trusted unified-option
      // `extensionTools` channel, never from this selector. `null`/invalid
      // input normalizes to the entity's `'all'` default.
      extensionTools: (config.extensionTools === 'all'
        ? 'all'
        : (Array.isArray(config.extensionTools) ? [...config.extensionTools] : undefined)) as AgentConfig['extensionTools'],
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
      // the explicit authority grants are the engine-composed values only; a
      // caller-supplied value was ignored above for every non-engine
      // principal. The extension grant set (extension wave) comes only from
      // the trusted unified-options channel — the config selector is state,
      // never a grant.
      this.#registerAgentAuthority(identityKey, agentId, {
        privileged,
        allowedTools: composedConfig.allowedTools,
        extensionTools: Array.isArray(extensionToolsInput) ? extensionToolsInput : null,
        realmBypass,
        authorities: composedAuthorities
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

      // NOTE: the initial prompt turn phase is deliberately outside this
      // registration try/catch (ratified prompt contract, ticket 4692014):
      // destructive rollback covers registration-time failures only, so a
      // failed child turn can never unwind a registered child. The turn phase
      // runs after this block resolves.
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

    // Initial-prompt turn phase (ratified prompt contract, ticket 4692014).
    // The launch directive is user-initiated: prefer the queue-backed
    // `enqueueUserTurn` entry so it enters the centralized TriggerQueue
    // (MOD-21 W7 single dispatch point); hosts without a TriggerQueue fall back
    // to the direct turn engine. The turn is addressed by the launched agent's
    // canonical identity key (Wave I, ticket d57cbc1; fix lane G2): the launch
    // path already knows the key, while a bare id is Realm-ambiguous for a
    // lawful same-id pair and fails closed (`AGENT_NOT_FOUND`).
    //
    // `'detach'` (the model-facing `spawn_agent` default) queues the turn and
    // resolves the launch immediately; a later turn failure is recorded on the
    // child and never unwinds it — no unhandled rejection escapes. `'await'`
    // (the blocking `await_completion` opt-in, and the legacy direct-launch
    // default) surfaces the turn outcome to the caller; on failure the error
    // propagates BUT the registered child stays (the destructively rolled-back
    // registration window closed above).
    if (initialPrompt !== null && initialPrompt !== undefined && initialPrompt !== '') {
      const runInitialTurn = (): Promise<unknown> => {
        if (!this.#runtime || typeof this.#runtime.executeAgentTurn !== 'function') {
          return Promise.resolve(null);
        }
        return typeof this.#runtime.enqueueUserTurn === 'function'
          ? Promise.resolve(this.#runtime.enqueueUserTurn(identityKey, initialPrompt) as Promise<unknown>)
          : Promise.resolve(this.#runtime.executeAgentTurn(identityKey, initialPrompt) as Promise<unknown>);
      };
      if (initialTurnMode === 'detach') {
        try {
          void runInitialTurn().catch((err: unknown) => {
            this.#recordInitialTurnFailure(agentInstance, err);
          });
        } catch (err) {
          this.#recordInitialTurnFailure(agentInstance, err);
        }
      } else {
        try {
          await runInitialTurn();
        } catch (err) {
          this.#recordInitialTurnFailure(agentInstance, err);
          throw err;
        }
      }
    }

    return agentInstance;
  }

  /**
   * Records a detached/blocking initial-turn failure observably on the child
   * (ratified prompt contract, ticket 4692014): the diagnostic `lastError`
   * banner and the state detail are the existing observable surfaces — no mail
   * is invented and the child is never unwound. Best-effort: a frozen or
   * exotic entity must not mask the original failure.
   *
   * @param agentInstance - The registered child.
   * @param err - The failed initial-turn error.
   * @internal
   */
  #recordInitialTurnFailure(agentInstance: Agent, err: unknown): void {
    const failure = err && typeof err === 'object' ? err as { message?: unknown } : null;
    const message = failure && typeof failure.message === 'string' && failure.message
      ? failure.message
      : 'Initial prompt turn failed';
    try {
      agentInstance.lastError = message;
      agentInstance.stateDetail = 'Initial prompt turn failed';
      agentInstance.updatedAt = Date.now();
    } catch {
      // Best-effort observability only; the child registration is authoritative.
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
    // M2: a holder's own authority ids are inspectable; scopes never surface.
    const inputs = this.#authorityInputs.get(this.#agentIdentityKeyOf(agent)) || null;
    const authorities: string[] = [];
    if (inputs) {
      for (let i = 0; i < inputs.authorities.length; i++) {
        authorities[authorities.length] = inputs.authorities[i].id;
      }
    }
    return {
      success: true,
      agentId: agent.id,
      name: agent.name || agent.config?.name || agent.id,
      role: agent.config?.role || (isPrivileged ? 'admin' : 'user'),
      privileged: isPrivileged,
      workspace: agent.config?.workspaceId || agent.id,
      triggerPolicy: agent.config?.triggerPolicy || 'auto',
      allowedTools,
      authorities: Object.freeze(authorities)
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
    // Every authority id is operator-API-only too (M1): the generic
    // `authorities` key, a legacy `templateAuthority`/`hydrationAuthority`
    // alias, or any exact `AUTHORITY_IDS` key is denied for EVERY caller
    // before the generic authority verdict.
    const authorityGrantClaim = hasAuthorityGrantInputKey(update);
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
        || AUTHORITY_ID_SET.has(tool)
      ));
    // The per-agent extension tool selector is authority-bearing too
    // (extension wave): it decides which third-party tools the agent may be
    // reauthorized for, so it is gated exactly like a capability selector
    // even though the descriptor axis itself is recomputed store-side.
    const extensionSelectorClaim = update.extensionTools !== undefined;
    const authorityClaim = update.privileged !== undefined
      || update.isAdmin !== undefined
      || update.isPrivileged !== undefined
      || roleClaim
      || parentageClaim
      || realmClaim
      || realmBypassClaim
      || authorityGrantClaim
      || capabilityClaim
      || extensionSelectorClaim;

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
      // Every authority id follows the same operator-API-only rule (M1; the
      // publishing pair included): the keys are denied for every caller, so a
      // config-update path can never grant or smuggle them.
      if (authorityGrantClaim) {
        throw new PermissionDeniedError(
          `Permission denied: agent '${targetLabel}' authority grants (${AUTHORITY_IDS.join(', ')}) are operator grants, `
          + 'never a config-update field (use grantAuthority/revokeAuthority)',
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

    // Authorized: the apply phase is the shared intrinsic writer (also used by
    // the M2 parental/meta path), so the two surfaces can never diverge into
    // parallel writers.
    this.#applyConfigUpdate(agent, update, callerPrincipal, 'operator');
    return agent;
  }

  /**
   * Applies one authorized config update through the intrinsic entity
   * channels (M2 refactor of `updateAgentConfig`'s apply phase): the
   * non-authority merge and model/provider re-instantiation run through
   * `Agent.prototype.updateConfig`, authority-bearing fields through
   * `Agent.prototype.applyAuthorityConfig` + `#registerAgentAuthority`, the bus
   * is re-registered on a privilege change, INV-CONFIG-SYNC synchronizes the
   * system prompt in place, and `agent_config_updated` is emitted exactly
   * once. Authorization stays with the caller of this method — it is private
   * and only ever reached after a gate (operator lifecycle authority or the
   * M2 parental/meta verdict).
   *
   * @param agent - Resolved active target record.
   * @param update - Snapshot of the authorized update.
   * @param principal - Authorizing principal (carried for call-site clarity; the intrinsic channel gates the write).
   * @param tier - Authorizing tier label (carried for call-site clarity).
   * @internal
   */
  #applyConfigUpdate(agent: Agent, update: ConfigUpdateSnapshot, principal: LifecyclePrincipal | null, tier: string): void {
    // Signature parity with the ratified shared-apply shape; the intrinsic
    // authority channel — not these labels — owns write authorization.
    void principal;
    void tier;

    const rawTools = update.allowedTools !== undefined
      ? update.allowedTools
      : (update.tools !== undefined
        ? update.tools
        : (update.toolPreset !== undefined
          ? update.toolPreset
          : (update.tool_preset !== undefined ? update.tool_preset : undefined)));
    const resolvedTools = rawTools !== undefined ? resolveToolPreset(rawTools) : undefined;

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
    if (update.extensionTools !== undefined) {
      // Selector state only: the descriptor's effective `extensions` axis is
      // recomputed store-side (realm resolved tools × selector) and lands
      // through `reauthorizeAgent` at the next safe state; a config edit never
      // grants an extension entry directly.
      authorityPatch.extensionTools = Array.isArray(update.extensionTools)
        ? (update.extensionTools as string[])
        : 'all';
    }
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
    // The `realmBypass` grant and the authority grants ride along unchanged —
    // a capability update never grants or revokes scope or authority (Wave I,
    // ticket c02d0b9; Wave U, ticket 2518510; M1, ticket 3c6197f).
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
  }
}
