/// <reference types="svelte" />
/**
 * @packageDocumentation
 * Module `sandboxStore`.
 * Type definitions for the `sandboxStore` module contract.
 * 
 * Canonical Layer 3 reactive bridge uniting underlying asynchronous domain runtime engines
 * (`AgentRuntime`, `VirtualFS`, `MessagingBus`, `WorldClock`, `sandboxPersistence`) with the Svelte 5
 * rune-based user interface (`$state`, `$derived`). It serves as the single source of truth for the
 * Agentic Sandbox Studio, Conversational Workspace, Inspector Drawers, and Disaster Recovery utilities.
 * 
 * @module sandboxStore
 * @mayImport ../runtime/agentLifecycle/index.ts
 * @mayImport ../tools/extensionTools/index.ts
 * @invariant Total engine encapsulation: `#runtime`, `#virtualFs`, `#messagingBus`, `#worldClock`, `#credentialVault`, and every ticker/subscription handle are `#`-private; no engine instance is exposed as a public property.
 * @invariant Unidirectional reactive data flow: UI state is exposed exclusively through Svelte 5 `$state` fields and derived getters; engine changes enter only through the runtime/bus subscriptions and private `#sync*` helpers.
 * @invariant Automated synchronization: there are no public manual sync methods — runtime events (`#handleRuntimeEvent`) and bus messages (`#handleBusMessage`) automatically propagate state changes into the reactive projections.
 * @invariant Isolated draft buffers: per-agent prompt drafts live in `agentDraftInputs`, persist with the session, are restored into the draft by `undoAgentTurn`, and are cleared by `redoAgentTurn` (or on a successful `submitChatTurn`).
 * @invariant Emergency unsticking: `unstickAgent` synchronously delegates to the runtime's unstick path — abort the in-flight turn, flush streaming buffers, emit `stream_reset`, transition to `IDLE`, unfreeze subsequent submissions — and returns its result unchanged.
 * @invariant Soft-kill recycle bin: `killAgent` archives the agent's full conversational history and redo stack in `recycleBin` until `restoreAgent` or explicit purge (`purgeAgent`/`emptyRecycleBin`).
 * @invariant Credential-vault composition root: the store constructs the MOD-16 `CredentialVault` over an injected `CredentialStoragePort`, hands the runtime only the frozen least-privilege `CredentialResolverPort` from `createResolverPort()`, and exposes the full vault only through `getCredentialVault()`.
 * @invariant MOD-20 preset composition root: the store owns the single `presetCatalog` instance over a snapshot-backed `{ load, save }` adapter, mirrors the active pointer and custom preset entries as snapshot state, persists catalog mutations through the existing debounced save, and hands the owned runtime only the frozen `ModelPresetSourcePort`.
 * @invariant Realm composition root: the store owns the single `realmRegistry` instance over a snapshot-backed `{ load, save }` adapter, mirrors the realm records into the reactive `realms` projection and the snapshot `realms` field, and persists registry mutations through the existing debounced save. Every store seeds the protected Generic default (`realm_generic`, display "Generic", renamable, non-deletable) at init and hands the registry its protected-id set, so removal is refused on every public surface; reconciliation keeps the seeded default in place — first — and a reset restores its pristine metadata, so the registry is never empty and every non-director launch has a Realm.
 * @invariant Realm launch atomicity: `launchRealmFromTemplate` creates the Realm record first and, when materialization, any member launch, a placement write, or a directive delivery fails, rolls the whole operation back (launched members purged, record removed, placement files already written best-effort evicted) before throwing a coded failure — a failed call never leaves a half-realm, and template lookup, preset binding, payload/input validation, and placement validation are all fail-closed.
 * @invariant H1 reload capability heal: on hydration completion the store runs an operator-context heal pass that restores only the persisted tool grants (`allowedTools`/`tools`/`toolPreset`) plus the per-agent extension selector (`extensionTools`) onto the restored agents; `privileged`, parentage (`spawnedBy`/`creatorId`), and realm membership are never restored from a snapshot — privilege and parentage stay default-deny/unbound (template-backed privilege is re-derived from trusted template specs) while membership hydrates through the runtime's scope-constraint path. The pass is idempotent (a second run reports `unchanged` and mutates nothing) and observable through the reactive `capabilityHealReport`. A legacy snapshot without the extension selector heals to the fail-closed empty selector — never the `'all'` default.
 * @invariant Hydration is storage-read-only: the whole `hydrateFromStorage` flow (catalog reconciliation, fingerprint heal, capability heal, runtime restore, resyncs, legacy-workspace remap) runs under an internal suppression guard so no catalog-adapter or pointer write can schedule the debounced autosave — a failed restore leaves the raw persisted bytes byte-identical and a successful one never rewrites them.
 * @invariant Realm-local store identity: agent-facing projections (`agents`, `recycleBin`, receipts, listings) always carry bare realm-local ids — canonical `(realmId, agentId)` keys and Realm vocabulary never surface; internal mailbox and clock-partition lookups resolve the canonical key through the runtime identity port realm-exactly, and an id registered in more than one Realm fails closed (zero unread, no wrong-Realm pick) instead of silently using the first registration. The store's late-bound identity bridge forwards the full `(agentId, scope)` resolution and enumeration so store-constructed substrates can resolve multi-Realm identities and fire the ambiguity guard.
 * @decision Downloads consume public VirtualFS APIs (`getFileRecord` for single files, `listFilesWithContent` for archives) instead of reaching into private VFS internals
 * @decision Cancel/unstick delegate to the runtime's truthful contract and surface its `UnstickResult` unchanged; the store synthesizes no cancellation state
 * @decision `rebindProviderCredentials` re-binds only legacy/unbound agents of the alias-normalized provider — rewriting `modelConfig.keyId` (deleting it when unpinned) and re-running `rebindModel()` — while preset-bound agents are skipped because credential rotation materializes at the next turn start through the preset resolver; per-agent re-init failures are swallowed and the re-bound count is returned
 * @decision Vault mutations (set active / add / update / delete credential) re-bind provider agents through `rebindProviderCredentials` so no agent keeps a stale pinned credential
 * @decision The store is the MOD-20 preset composition root: it builds one catalog over a `{ load, save }` adapter backed by the sandbox snapshot (custom presets plus active pointer), seeds it from the persisted fields before constructing the owned runtime, and hands that runtime only `createPresetSourcePort()`; a caller-injected runtime stays caller-owned and is never re-wired
 * @decision Hydration and reset reconcile the in-memory catalog with the snapshot through the public catalog API only: persisted entries are saved, stale custom entries deleted, and a missing or unknown active pointer falls back to the master default; hydration suppresses the debounced autosave for the duration of the flow so persisted bytes are never rewritten, and the fallback pointer write is skipped when the effective pointer already resolves to that default
 * @decision Hydration fingerprint-heals every snapshot agent binding before restore: a resolving `presetId` is kept, otherwise `modelConfig.{providerId,modelId}` is matched against the catalog (enumeration lives only here) and an unmatched fingerprint binds the catalog default; only the in-memory snapshot copy is mutated
 * @decision `modelConfig` is a derived read-only projection of the active catalog preset: the catalog is the single writer, and the value is never persisted independently nor edited through the store
 * @decision The store is the realm composition root: it builds one registry over a `{ load, save }` adapter backed by the sandbox snapshot (`realms`), seeds it from the persisted field plus the protected Generic default before construction, reconciles hydration by upsert-and-prune through the public registry API (the registry refuses removal of the protected Generic, so a missing default is re-seeded in place and stays first; a reset restores its pristine metadata), and exposes create/update/delete methods that validate input and schedule the existing debounced save; a failed or pruned hydrate never rewrites persisted bytes
 * @decision Realm membership is immutable: the store never moves or clears `realmId` (the restore-time ungrouping hygiene is retired because deletion now refuses non-empty realms). `deleteRealm` refuses a Realm with active or recycled members by default (`ERR_STORE_REALM_NOT_EMPTY`, "terminate or delete members first"), the explicit `{ recursive: true }` override purges every active member and empties every recycled member under the operator principal before removing the record, a per-member purge failure fails closed with a frozen `RealmDeletionReport` on `ERR_STORE_REALM_DELETE_FAILED` (the record survives), and the Generic default is always refused with `ERR_STORE_REALM_PROTECTED`
 * @decision Realm deletion counts memberships with the same trim semantics as the realm grouping/resolution (`resolveMemberRealmId`): a hydrated `'  realm_x  '` member blocks the default deletion of `realm_x` and is purged by the recursive override, so a padded membership can never be orphaned by a removed record
 * @decision Generic protection is enforced at the registry boundary: the store constructs the registry with `protectedIds: [realm_generic]`, so `removeRealm(realm_generic)` is a `false` no-op on every public surface including the raw `getRealmRegistry()` API, while renames and every other management operation stay available and reconciliation can never prune the seeded default
 * @decision The H1 heal reads only the persisted capability selectors as data and applies them through the runtime's gated config-update path with the store's operator principal (the runtime's host principal), while the snapshot privilege/parentage claims are ignored entirely — capability is restored, authority is never re-derived from the snapshot
 * @decision Template launch resolves baked templates by id and fails closed for unknown ids; member launch partitions the materialized plan grants — internal canonical/alias/wildcard names travel as `allowedTools`, resolved extension-derived call names travel as the member's effective `extensionTools` grant set (the whole Realm universe for an unrestricted member, exactly the referenced names for a restricted one), and unresolved references only ride the missing-tool disclosure — the declared preset name as inert `toolPreset` metadata, and the per-key preset binding (winning over the spec `modelPresetId`) as `presetId` resolved through the owned preset catalog — no model literals
 * @decision A failed template launch rolls back by purging every active member of the freshly created Realm under the operator principal and then removing the record through the recursive `deleteRealm` override (so a leftover member from a failed purge is retried by the same route); the thrown `ERR_STORE_REALM_LAUNCH_FAILED` error carries the original failure as `cause` plus the rollback report (`realmId`, `templateId`, `failedAgentId`, `rolledBack`, `terminatedMembers`, `evictedSeedFiles`, `rollbackFailures`), so a half-realm is never left un-described
 * @decision `launchRealmFromTemplate` applies a template's resolved launch plan inside the same atomic try: placement writes group by target in first-appearance order (one `seedRealm` call per target, reusing its fail-closed path/target validation and per-target write record), then every directive is delivered independently as an operator-attributed `source: 'realm_seed'` mailbox message addressed realm-exactly, `seed: false` skips placements and directives entirely, and a failure in either phase rolls back exactly like a member failure — including best-effort eviction of the files already written, reported as `evictedSeedFiles` (member private workspaces are evicted by the member purge; a realm-global partition is a VFS-reserved key, so its seeded files are deleted individually and an empty container key can remain)
 * @decision The launch catalog exposes the normalized format-v2 template (`normalizeTemplate` of the authored bundle template) through `listRealmTemplates`/`getRealmTemplateBundle`, so the launcher/review surfaces see declared inputs, placements, and directives; the authored form stays the identity source — imports persist and export re-emit their authored transport payload verbatim, shipped bundles re-serialize their authored template + files, and the effective template version is the authored-form pin (the import's parsed version, else `templateBundleVersion`), never a hash of the normalized model
 * @decision `RealmTemplateBundle` is the authored bundle seam (a format-v1 or format-v2 template plus bundle file bodies): host/pipeline injection may supply either format, the store normalizes once for exposure/launch, and the content pipeline can supply real bundle files without restructuring the launch flow
 * @decision The default launch catalog is sourced from `realmCatalog`'s baked bundles — the demo fixture first, then the embedded `templates/**` bundles generated by `scripts/embed_realm_content.mjs` — so `listRealmTemplates()` and `getRealmTemplateBundle()` share one embedded source; per-instance `realmTemplateBundles` still extend and override it in place (an injected id matching a baked id replaces it), and the store adds no new module-level exports
 * @decision Agent ids are realm-opaque: template ids materialize as literal plain ids (the `{realm}` placeholder is retired at validation), the realm id never prefixes an agent id, and a resolved member id already registered — in the target realm or, while the registry stays globally keyed, in any other realm — is denied at launch time with an `AGENT_ALREADY_EXISTS` cause and is never auto-suffixed; realm-local id namespacing is a follow-up
 * @decision The store's operator principal is the runtime's host operator principal (`runtime.getOperatorPrincipal()`, exact-reference validated): every operator-scoped store action — runtime lifecycle/scheduler calls, substrate calls, and manual-send attribution — carries that principal, never an agent id or a director descriptor, so operator actions work with zero agents and never depend on the director's lifecycle
 * @decision `realmBypass` is a user-facing operator grant: `grantRealmBypass`/`revokeRealmBypass` validate the agent id, delegate to the runtime under the operator principal, and schedule the debounced save; targeting is additive — a canonical identity key or a realm-exact `{ realmId }` scope addresses the exact same-id registration (composed to the canonical key store-side), while a bare id keeps the unique-match rule and fails closed on ambiguity; the active grant list persists as the additive top-level snapshot field `realmBypassGrants` — canonical identity keys emitted by the lifecycle listing, so a scoped grant on a same-id pair round-trips realm-exactly — and is re-applied at hydration, after the agents are registered, through `restoreRealmBypassGrants`, which drops unknown/recycled refs fail-closed and still hydrates legacy bare-id snapshots through unique-match (an ambiguous bare id is skipped, never duplicated across realms); grant-free snapshots keep every existing field and byte
 * @decision Authority grants and trust: generic `grantAuthority`/`revokeAuthority`/`listAuthorityGrants` are operator actions delegating to the runtime under the store principal; the Wave U publishing wrappers keep their names and delegate. Grants persist additively — the publishing pair through the legacy `metaAuthorityGrants` field (canonical identity keys; unchanged bytes for publishing-only sessions) and every other authority id through the additive `authorityGrants` field (omitted when empty; a scoped grant rides as a `{ ref, scope }` entry so the narrowing survives a restart — M1 finding F3) — and hydration merges both fields (generic wins per id) into one operator-gated `restoreAuthorityGrants` call that skips unknown ids and unknown/recycled/malformed-scope entries. `launchRealmFromTemplate` validates every approval against the template's declared pairs before any side effect, applies approved grants under the operator principal, and — only on a fully successful launch with `trustAuthorities: true` — persists the effective approved declared set as `templateAuthorityTrust`; later launches auto-approve exact matches only, `clearTemplateAuthorityTrust` removes the override without revoking already-applied grants, and pending instance payloads stay session-only
 * @decision Saved hydration-payload library (ticket 81d8267): the store owns the operator's named authored payloads — `saveInstancePayload`/`listSavedInstancePayloads`/`getSavedInstancePayload`/`deleteSavedInstancePayload`/`clearSavedInstancePayloads` validate fail-closed (`ERR_STORE_INVALID_PARAMS`, `ERR_STORE_PAYLOAD_LIBRARY_FULL` at the entry cap, `ERR_STORE_PAYLOAD_LIBRARY_TOO_LARGE` at the byte cap), freeze an isolated payload copy, digest it with the catalog's canonical `payloadDigest`, and persist additively as `savedInstancePayloads` (field omitted when empty; payloads re-validate only at attach). Hydration is snapshot-authoritative (malformed entries dropped, legacy snapshots without the field hydrate empty, the id counter seeds past restored numeric suffixes, and the suppression guard never rewrites persisted bytes); reset/factory-reset clears the library and its field
 * @decision `seedRealm` writes validated files through the operator-context VFS surface into the target member's resolved private workspace (or `realm:<realmId>:global` when no target), rejects traversal, reserved workspace targets, the reserved `global`/`public` seed path roots (rejected, never re-rooted, so the legacy VirtualFS prefix routing can never divert a write into the ungrouped shared workspace under a receipt that names the selected one), and empty or duplicate file lists before the first write, and delivers the directive as an operator-attributed mailbox message (the non-agent `'human'` label routes through the host operator principal by exact reference) that requires an explicit member target — never a realm-wide fan-out
 * @decision Seed targets resolve realm-scoped: a named member target is an ACTIVE member of the requested Realm by `(realmId, agentId)` — a same-literal-id registration in another Realm is never selected (only it yields the historical membership error) — and the write addresses that exact registration's private storage key (explicit pin, canonical identity key, or legacy bare id) while the directive addresses its canonical mailbox; receipt labels stay realm-opaque/bare
 * @decision Seed-target membership compares under the store trim semantics: the target lookup resolves a padded hydrated `config.realmId` to the same realm the grouping and `deleteRealm` resolve, a same-id registration in another Realm stays excluded (ambiguous registrations never fall back to a bare ghost workspace when an identity port exists), and the canonical write key is re-normalized to the resolved (trimmed) realm's identity while explicit pins stay verbatim
 * @invariant Template registry resolution: the effective launch catalog resolves shipped (baked demo/embedded bundles plus the `realmTemplateBundles` host injection) → runtime imports, replacing in place by template id, with re-import replacing the previous import so every id has exactly one effective entry; `listRealmTemplates`/`getRealmTemplateBundle`/`launchRealmFromTemplate`/`exportRealmTemplate` all read that one catalog and `listRealmTemplateSources` labels each entry's origin (`shipped`/`imported`/`replacesShipped`).
 * @invariant Template registry honesty: `importRealmTemplate`/`deleteRealmTemplate` mutate the effective catalog and persist the snapshot synchronously; a failed write (quota/unavailable storage) rolls the mutation back and surfaces the typed `ERR_STORE_TEMPLATE_PERSIST_FAILED`, so the registry is never silently in-memory-only. Imports are capped at 2 MiB per bundle and 3 MiB total (`ERR_STORE_TEMPLATE_TOO_LARGE`), persisted as canonical transport payloads, and re-parsed/re-capped fail-closed on hydration without ever rewriting persisted bytes. `previewRealmTemplateImport` runs the identical parse → cap → label pipeline with zero side effects (`dry_run`), so preview and import can never disagree.
 * @invariant Publishing surface: the store is the host-side realm publishing composition root — it exposes the frozen `RealmPublishingPort` (real import path, effective-catalog resolution, session candidate store, plus the M5b bounded read projections over the effective catalog and the pending/saved payload stores — ids, versions, digests, and timestamps only, never bundle or payload bodies) to the store-owned runtime; pending instance payloads are session-only and cleared by a reset; approved template authorities are applied under the operator principal as ordinary registry grants (`metaAuthorityGrants`, canonical identity keys, hydration re-applied) and a `templateAuthorityTrust` record auto-approves only exact declared matches at a later launch. A template declaring an authority id unknown to this host fails the launch closed (`ERR_TEMPLATE_AUTHORITY_UNSUPPORTED`), approvals beyond declarations and malformed approvals are rejected (`ERR_STORE_INVALID_PARAMS`), and grant-free/trust-free snapshots keep every existing field and byte.
 * @invariant Realm launch resolution: a provider-bearing template launches — the retired providers gate no longer refuses it — and its requested extensions plus `<providerId>::<serverToolName>` references resolve against the global install registry and the Realm's attachments: installed-and-approved requests attach under the operator principal, unresolved requests ride the receipt's missing-extension disclosure and `instance.missingExtensions`, resolved tools are recorded as `instance.resolvedTools` (sanitized call name → extension id), and an attached payload/package (or the operator-assembled explicit inputs) is still validated against the effective template contract — including the pinned version — before the Realm record exists, so launch mismatches only with the explicit `allowVersionMismatch` confirmation, which rides the receipt as a warning.
 * @invariant Extension surface: the store is the extension composition root — global install records live in one injected registry persisted additively as `extensions`, realm attachments ride the realm records, install/remove/attach/detach validate and emit `extension_installed`/`extension_removed`/`extension_attached`/`extension_detached` audit events on the runtime stream, `removeExtension` refuses an extension any Realm still attaches (and drops its live session), an `active` attachment for an unknown extension degrades to `unavailable` and returns to `active` once the extension is installed again while the install-only heal never rewrites a `conflict` attachment, and install/attachment records alone never connect, discover a catalog, or grant runtime authorization.
 * @decision Instance provenance is hashes, paths, and resolved tool ids only: a successful template launch records `RealmRecord.instance` with the authored `templateVersion`, the canonical payload digest (`payloadDigest` over the attached payload, when one was attached), per-input hashes over each supplied value's canonical tagged JSON, the placement paths the launch actually wrote, `launchedAt`, the resolved extension tools (`resolvedTools`: sanitized call name → extension id) and the unresolved requested extension ids (`missingExtensions`); raw input values, package content, and credentials never reach the record
 * @decision The store is the extension composition root: it builds one install registry over a `{ load, save }` adapter backed by the sandbox snapshot (`extensions`), seeds it from the persisted field before construction, reconciles hydration through the registry's validated `reconcile` path, and exposes install/remove (global) plus attach/detach (realm) methods that validate against installed records and schedule the existing debounced save; realm attachments are realm-local `RealmRecord.extensions` entries, so realm deletion, rollback, and persistence carry them without a parallel store map
 * @decision `launchRealmFromTemplate` extension approvals mirror the Wave U authority approvals: `extensionApprovals` entries must match a declared template request exactly, absent approval is a decline, only installed-and-approved requests attach (an approval of an uninstalled request attaches nothing and stays disclosed), attachments are written only on a fully successful launch with the operator approval stamp and the realm-level `'all'` selection, and the effective extension grants are forwarded into the launched members' descriptors through the trusted unified-options channel (resolved names plus the actively connected catalogs' call names of the realm's attached, active extensions, each capped by its attachment's `toolSelection` — execution then flows through the store's provider/execution ports)
 * @invariant Safe-state extension reauthorization (extension wave, P2.4): the store owns the queue — attach/detach and per-agent `extensionTools` selector edits recompute each affected member's effective grant set and apply it through the operator-gated `reauthorizeAgent` at the next safe point: an idle member synchronously at the mutation point, a busy member queued and applied on its next `turn_complete` (never mid-turn). A queued member that terminates is dropped. Selector names that resolve to nothing are dropped fail-closed and warned, never granted.
 * @invariant Extension authority is descriptor-exact: the effective grants computed here feed `AuthorityDescriptor.extensions`; realm attachment or selector state alone never authorizes a call, the wildcard `'*'`/privilege/selectors/aliases never imply an extension entry, and the runtime's dispatcher extension branch authorizes only exact membership against the frozen synthesized descriptor it resolves from the store's provider port.
 * @invariant Extension execution composition (extension wave, P3.3): the store builds one frozen provider port (descriptor-backed `resolveTool`/`resolveDescriptor`) and one frozen execution port (`execute` → the extension's live session `callTool`) over the in-memory connection catalogs, passes both into the store-owned runtime's construction, rebuilds the descriptor registry on every connect/disconnect/reconnect/conflict/drift re-arbitration, and clears it with the connection teardown. A catalog-less, conflicted, or refused-projection call name resolves no descriptor and no binding (`TOOL_NOT_FOUND` at the dispatcher); per-call context can never substitute either port.
 * @invariant Extension connections are session-only and operator-initiated: live sessions, discovered catalogs, and arbitration state live in-memory (`#extensionConnections` plus the reactive `extensionConnections` projection), are never persisted (not in install records, not in realm records, not in the snapshot), are dropped at hydration/reset/destroy, and are only ever created by an explicit `connectExtension`/`reconnectExtension` call — never at load, hydration, or launch.
 * @invariant Extension connection approval boundary: when an install record carries an explicit `approvedUrl`, it must parse as an absolute URL and be URL-equal (`href`) to the transport URL; a stale or inconsistent approval is refused with `ERR_STORE_EXTENSION_INVALID_ENDPOINT` before the plaintext gate, any vault read, and any network activity, and a connection only ever dials `transportHint.url`.
 * @invariant Extension connection credential gate: a `credentialId` on a non-`https:` endpoint is refused with `ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL` before any vault read or network activity, a bound credential the vault cannot resolve fails closed with `ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED` before any network activity, plaintext local servers with no `credentialId` connect unauthenticated, and connection projections/audits/errors carry no credential material.
 * @invariant Extension catalog arbitration: live catalogs arbitrate only by explicit connection-completion sequence (never map insertion order), the earlier `active` extension keeps every contested call name, each later conflicting extension is `conflict` and not activated until a re-arbitration clears it, re-arbitration runs on every connect/disconnect/reconnect and audits conflict transitions, and realm attachment statuses follow the live state (`connected` → `active`, `conflict` → `conflict`, disconnected/`error` → `unavailable`) through the existing safe-state reauthorization sweep.
 * @invariant Realm-admin port (M3, ticket 094de1b): the store is the host-side realm-admin composition root — `getRealmAdminPort()` returns the frozen `RealmAdminPort` whose `inspectRealm`/`updateRealm` resolve the actor's exact scoped grant registry-side from the dispatcher-pinned reference (missing/unknown/grant-less actors and unknown/ambiguous/out-of-scope labels throw one uniform `PERMISSION_DENIED`, so a direct store call can never run under the operator principal without an actor record — R6) and whose edits apply only through the existing registry update, `attachExtension`, and `setExtensionToolSelection` internals. `setExtensionToolSelection` validates the attachment exists and every explicit call name against the extension's live conflict-free catalog (fail closed, never silently regranted), emits `extension_tool_selection_updated`, and schedules the P2.4 safe-state sweep; non-operator audit sources require a non-empty actor id; receipts and audits carry display labels and bare ids only, never realm ids, `realm:` paths, transport URLs, or credential material.
 * @invariant Extension-admin port methods (M4, ticket a02bce7): the same frozen `RealmAdminPort` carries `listExtensions`/`attachExtension` under the exact `@extensions:authority` grant — the actor's registry-side scope resolves own-realm target candidates exactly like M3 (uniform `PERMISSION_DENIED` for every resolution failure), `listExtensions` projects only install metadata + live state + call names (never transport URLs, credentials, or realm ids) and audits `extensions_inspected`, and `attachExtension` requires the extension installed + connected with any explicit ceiling inside the live conflict-free catalog, attaches realm-wide through the shared `attachExtension` internals (`source:'privileged-agent'` + actor id), sweeps members at their safe state, and returns an idempotent `applied:false` no-op (no mutation, no duplicate audit) when the realm already attaches it. It never installs, dials, disconnects, detaches, or touches credentials.
 * 
 * @example
 * ```typescript
 * import { sandboxStore, getSandboxStore, createSandboxStore } from './index.svelte.ts';
 * 
 * // Select an agent and submit a conversational turn
 * sandboxStore.selectAgent('director');
 * const result = await sandboxStore.submitChatTurn('Develop chapter outline for Arc 1', {
 *   mode: 'directive'
 * });
 * console.log('Turn output:', result.output);
 * 
 * // Observe reactive properties
 * console.log('Active agents count:', sandboxStore.agents.length);
 * console.log('Active workspace files:', sandboxStore.activeFsFiles);
 * console.log('Aggregate telemetry stats:', sandboxStore.stats);
 * ```
 */

import { AgentRuntime, createAgentIdentityKey, parseAgentIdentityKey } from '../runtime/index.ts';
import type { AgentConfig, AgentConfigUpdate, AgentIdentityPort, AgentIdentityProjection, AgentIdentityScope, AgentState, AuthorityDescriptor, InternalPrincipal, LaunchHistoryEntry, RealmSliceImportInput, ScheduleResult, TurnExecutionOptions, TurnExecutionResult, TurnInput, UnsubscribeFn } from '../runtime/index.ts';
import type { Agent, TurnBundle } from '../runtime/agent/index.ts';
import type { ModelInterface, ProviderInterface } from '../inference/index.ts';
import { AGENT_STATES } from '../runtime/agentLifecycle/index.ts';
import { VirtualFS, isReservedWorkspaceKey, normalizeVirtualPath, resolveAgentPrivateWorkspaceKey } from '../virtualFs/index.ts';
import type { FileRecord, WriteReceipt, CopyReceipt, GrepMatch, GrepOptions, VfsWriteOptions, VfsCopyOptions, VirtualFsSnapshot } from '../virtualFs/index.ts';
import { MessagingBus } from '../messagingBus/index.ts';
import type { BusMessageEnvelope, InboxHeader, InboxListOptions, ReadMessageResult, SendMessageReceipt } from '../messagingBus/index.ts';
import { WorldClock } from '../worldClock/index.ts';
import type { AdvanceClockSuccess, NarrativeEvent, PartitionClockSnapshot, TimeState, WorldClockSnapshot, WorldEvent } from '../worldClock/index.ts';
import { CredentialVault, createBrowserCredentialStorage, normalizeProviderId } from '../credentialVault/index.ts';
import type { CredentialResolverPort, CredentialStoragePort } from '../credentialVault/index.ts';
import { createPresetCatalog } from '../presetCatalog/index.ts';
import type { ModelPreset, ModelPresetSourcePort, PresetCatalog, PresetModelConfig } from '../presetCatalog/index.ts';
import { createRealmRegistry } from '../realmRegistry/index.ts';
import type { RealmInstanceProvenance, RealmRecord, RealmRegistry, RealmUpdatePatch } from '../realmRegistry/index.ts';
import {
  ExtensionRegistryError,
  arbitrateExtensionCatalogs,
  createExtensionRegistry,
  diffExtensionCatalogs,
  indexExtensionCatalog,
  normalizeRealmExtensionAttachment
} from '../extensionRegistry/index.ts';
import type {
  ExtensionCatalog,
  ExtensionCatalogConflict,
  ExtensionCatalogDiff,
  ExtensionInstallRecord,
  ExtensionKind,
  ExtensionRegistry,
  ExtensionRequest,
  ExtensionResolution,
  ExtensionTransportHint,
  RealmExtensionAttachment
} from '../extensionRegistry/index.ts';
import {
  MCP_CLIENT_ERROR_CODES,
  McpClientError,
  createMcpClient
} from '../mcpClient/index.ts';
import type {
  McpClientCredential,
  McpClientServerInfo,
  McpClientSession
} from '../mcpClient/index.ts';
import {
  AGENT_AUTHORITIES,
  AUTHORITY_IDS,
  BAKED_TEMPLATE_BUNDLES,
  REALM_ADMIN_DENIED_PATCH_KEYS,
  REALM_ADMIN_PATCH_FIELD_TOKENS,
  hashText,
  materializeTemplate,
  normalizeTemplate,
  parseTemplateBundle,
  payloadDigest,
  serializeTemplateBundle,
  templateBundleVersion,
  templateUnsupportedAuthorities,
  validatePayload
} from '../realmCatalog/index.ts';
import type {
  AuthorityGrantSnapshotEntry,
  AuthorityScopeRecord,
  PendingInstancePayload,
  RealmInputValues,
  RealmInputValue,
  RealmLaunchAgentPlan,
  RealmResolvedDirective,
  RealmResolvedPlacement,
  RealmTemplate,
  RealmTemplateInput
} from '../realmCatalog/index.ts';
import { resolveToolPreset } from '../toolDefinitions/index.ts';
import type {
  ExtensionAttachReceipt,
  ExtensionToolProviderPort,
  ExtensionsAdminAttachmentView,
  ExtensionsAdminInstalledView,
  ExtensionsInspectReceipt,
  PendingInstancePayloadSummary,
  RealmAdminAttachmentView,
  RealmAdminMemberView,
  RealmAdminPatch,
  RealmAdminPort,
  RealmAdminProvenanceView,
  RealmAdminRealmSummary,
  RealmAdminToolSelection,
  RealmEffectiveTemplateSummary,
  RealmInspectReceipt,
  RealmPublishingPort,
  RealmUpdateReceipt,
  SavedInstancePayloadSummary
} from '../toolDefinitions/index.ts';
import { synthesizeExtensionToolDescriptor } from '../tools/extensionTools/index.ts';
import type {
  ExtensionExecutionPort,
  ExtensionToolDescriptor,
  ExtensionToolExecutionRequest
} from '../tools/extensionTools/index.ts';
import { createDebouncedSave, saveSandboxState, loadSandboxState, clearSandboxState, hasPersistedState, serializeRuntimeEnvironment, restoreRuntimeEnvironment, SAVED_INSTANCE_PAYLOAD_MAX_BYTES, SAVED_INSTANCE_PAYLOAD_MAX_ENTRIES } from '../sandboxPersistence/index.ts';
import type { DebouncedSaveCoordinator, PersistedImportedRealmTemplate, PersistedSavedInstancePayload, SandboxPersistedState } from '../sandboxPersistence/index.ts';
import {
  REALM_ARCHIVE_FORMAT,
  buildRealmArchiveFilename,
  parseRealmArchive,
  serializeRealmArchive,
  serializeRealmArchiveAgent,
  serializeRealmArchiveRecycledAgent,
  SANDBOX_PERSISTENCE_VERSION
} from '../sandboxPersistence/index.ts';
import type {
  RealmArchiveAuthorityHostGrant,
  RealmArchiveAuthorityMemberProjection,
  RealmArchiveEnvelope,
  VirtualFsPersistedFile
} from '../sandboxPersistence/index.ts';
import { downloadSingleFile, downloadFilesSeparately, downloadFolderAsArchive, processUploadedFiles } from '../fsDownloadUtils/index.ts';
import type { ArchiveDownloadReceipt, BatchDownloadFailure, CreateArchiveOptions, DownloadReceipt, ProcessUploadOptions } from '../fsDownloadUtils/index.ts';

/**
 * Error carrying an optional machine-readable sandbox store error code.
 */
type CodedError = Error & { code?: string; cause?: unknown };

/**
 * Deeply mutable projection of the store's readonly snapshot types, used only
 * by the in-place stream-mirror patch (the reactive projection is mutated
 * field-by-field instead of being rebuilt per stream chunk).
 */
type DeepMutable<T> = T extends ReadonlyArray<infer U>
  ? Array<DeepMutable<U>>
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

/**
 * Additive sandbox-snapshot view carrying the persisted operator grant and
 * trust fields (Wave I ticket c02d0b9; Wave U ticket 2518510):
 *
 * - `realmBypassGrants`: the `realmBypass` grant list;
 * - `metaAuthorityGrants`: canonical identity keys per explicit publishing
 *   authority (`@template:authority`/`@hydration:authority`);
 * - `templateAuthorityTrust`: template id → agent key → previously approved
 *   authority ids.
 *
 * The store owns all three: each is emitted only when non-empty, so grant-free
 * and legacy sessions keep their persisted bytes unchanged, and hydration
 * reads them as optional data.
 */
type AuthorityGrantSnapshot = SandboxPersistedState & {
  readonly realmBypassGrants?: readonly string[];
  readonly metaAuthorityGrants?: {
    readonly template?: readonly string[];
    readonly hydration?: readonly string[];
  };
  /**
   * Additive generic authority-grant field (M1; scoped entries M2): authority
   * id → export entries. An entry is a canonical identity-key string (the
   * legacy keys-only form, restored unscoped) or a `{ ref, scope }` record
   * carrying the registry-side narrowing, so a narrowed grant survives the
   * restart instead of silently widening (M1 finding F3). Emitted
   * only when at least one non-publishing grant is active, so publishing-only
   * and grant-free sessions keep every existing field and byte; hydration
   * reads it own-property-only and delegates to the runtime's operator-gated
   * generic restore.
   */
  readonly authorityGrants?: Readonly<Record<string, readonly AuthorityGrantSnapshotEntry[]>>;
  readonly templateAuthorityTrust?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
};

/**
 * Explicit authority ids owned by the legacy publishing snapshot partition
 * (M1): these stay in `metaAuthorityGrants`; every other id rides the additive
 * `authorityGrants` field.
 * @internal
 */
const PUBLISHING_AUTHORITY_ID_SET: ReadonlySet<string> = new Set<string>([
  AGENT_AUTHORITIES.TEMPLATE,
  AGENT_AUTHORITIES.HYDRATION
]);

// ============================================================================
// 1. Error Codes Constant
// ============================================================================

/**
 * Standardized error code dictionary for the sandbox store module contract.
 * Provides frozen programmatic error constants to eliminate brittle string matching in error handlers.
 * 
 * Codes:
 * - `ERR_STORE_AGENT_NOT_FOUND`: Target agent ID does not exist in active registry or recycle bin.
 * - `ERR_STORE_NO_AGENT_SELECTED`: Conversational action invoked when `selectedAgentId === null`.
 * - `ERR_STORE_TURN_FAILED`: LLM inference stream, provider gateway, or tool execution threw an uncaught error.
 * - `ERR_STORE_INVALID_PARAMS`: Invalid arguments passed to store methods (e.g. a missing agent config `id`, a non-positive timer duration, or an unresolvable timer target agent).
 * - `ERR_STORE_VFS_FAILED`: VirtualFS operation failed due to quota limit, path permission, or missing source file.
 * - `ERR_STORE_REALM_NOT_EMPTY`: `deleteRealm` was called on a Realm that still has active or recycled members (Wave R; use the recursive override).
 * - `ERR_STORE_REALM_PROTECTED`: `deleteRealm` targeted the seeded Generic default Realm, which can never be deleted.
 * - `ERR_STORE_REALM_DELETE_FAILED`: a recursive Realm deletion could not purge every member, so the record was left in place (fail-closed; the error carries a report).
 * - `ERR_STORE_REALM_LAUNCH_FAILED`: a template launch failed after the Realm record existed (materialization, a member launch, a placement write, or a directive delivery), so the record and its members were rolled back first; the error carries the rollback report and the original failure as `cause`.
 * - `ERR_STORE_REALM_NOT_FOUND`: `exportRealmArchive` targeted a realm id the registry does not hold (nothing was read or written).
 * - `ERR_TEMPLATE_PROVIDERS_UNSUPPORTED`: retired providers-gate code; `launchRealmFromTemplate` no longer emits it (provider-bearing templates resolve against installed and attached extensions and launch with missing-extension disclosure).
 * - `ERR_TEMPLATE_AUTHORITY_UNSUPPORTED`: `launchRealmFromTemplate` targeted a template declaring a publishing authority id unknown to this host; launch is blocked fail-closed while import/validation/review accept the declaration (providers precedent).
 * - `ERR_STORE_TEMPLATE_TOO_LARGE`: `importRealmTemplate` exceeded the per-bundle or total imported-template byte budget.
 * - `ERR_STORE_TEMPLATE_PERSIST_FAILED`: the registry mutation could not be persisted (storage quota/unavailable), so it was rolled back — an import/delete is never silently in-memory-only.
 * - `ERR_STORE_EXTENSION_ALREADY_INSTALLED`: `installExtension` targeted an id that already has a global install record.
 * - `ERR_STORE_EXTENSION_NOT_INSTALLED`: `attachExtension`/`connectExtension`/`disconnectExtension`/`reconnectExtension` named an extension with no global install record.
 * - `ERR_STORE_EXTENSION_ALREADY_ATTACHED`: `attachExtension` targeted a Realm that already attaches the extension.
 * - `ERR_STORE_EXTENSION_ATTACHED`: `removeExtension` targeted an extension still attached to at least one Realm; detach it first.
 * - `ERR_STORE_EXTENSION_NOT_CONNECTABLE`: `connectExtension` targeted a `pack` extension, which has no connectable transport.
 * - `ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED`: `connectExtension` targeted an MCP record carrying the host-only `stdio` transport hint.
 * - `ERR_STORE_EXTENSION_INVALID_ENDPOINT`: `connectExtension` targeted a record whose transport URL is not an absolute URL, or whose explicitly approved URL (`approvedUrl`) is not an absolute URL or does not match the transport URL after URL normalization — a stale or inconsistent approval never dials.
 * - `ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL`: `connectExtension` targeted a `credentialId`-bearing record on a non-`https:` endpoint — refused before any vault read or network activity.
 * - `ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED`: `connectExtension` targeted a `credentialId` the vault cannot resolve (deleted/unknown id) — fail closed, no network activity.
 * - `ERR_STORE_EXTENSION_CONNECT_FAILED`: the error code of an unclassified operational connection failure (a classified MCP client failure keeps its own `ERR_MCP_*` code); never thrown by the pre-connection gates.
 * - `ERR_STORE_PAYLOAD_LIBRARY_FULL`: `saveInstancePayload` targeted a library already holding `SAVED_INSTANCE_PAYLOAD_MAX_ENTRIES` entries; delete one before saving another.
 * - `ERR_STORE_PAYLOAD_LIBRARY_TOO_LARGE`: `saveInstancePayload` targeted a payload whose serialized size exceeds `SAVED_INSTANCE_PAYLOAD_MAX_BYTES`.
 * - `ERR_STORE_ARCHIVE_FAILED`: a realm archive export failed unexpectedly while projecting live state (read-only; nothing was mutated).
 * - `ERR_STORE_REALM_IMPORT_FAILED`: a realm archive import failed after validation; the error carries a rollback report (`realmId`, `failedStage`, `rolledBack`, `terminatedMembers`, `evictedFiles`, `failures`).
 * 
 * @example
 * ```typescript
 * import { SANDBOX_STORE_ERROR_CODES } from './index.svelte.ts';
 * 
 * try {
 *   await sandboxStore.submitChatTurn('Hello');
 * } catch (err) {
 *   if (err.message === SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED) {
 *     console.warn('Please select or launch an agent first.');
 *   }
 * }
 * ```
 */
export const SANDBOX_STORE_ERROR_CODES: {
  readonly ERR_STORE_AGENT_NOT_FOUND: 'ERR_STORE_AGENT_NOT_FOUND';
  readonly ERR_STORE_NO_AGENT_SELECTED: 'ERR_STORE_NO_AGENT_SELECTED';
  readonly ERR_STORE_TURN_FAILED: 'ERR_STORE_TURN_FAILED';
  readonly ERR_STORE_INVALID_PARAMS: 'ERR_STORE_INVALID_PARAMS';
  readonly ERR_STORE_VFS_FAILED: 'ERR_STORE_VFS_FAILED';
  readonly ERR_STORE_REALM_NOT_EMPTY: 'ERR_STORE_REALM_NOT_EMPTY';
  readonly ERR_STORE_REALM_PROTECTED: 'ERR_STORE_REALM_PROTECTED';
  readonly ERR_STORE_REALM_DELETE_FAILED: 'ERR_STORE_REALM_DELETE_FAILED';
  readonly ERR_STORE_REALM_LAUNCH_FAILED: 'ERR_STORE_REALM_LAUNCH_FAILED';
  readonly ERR_STORE_REALM_NOT_FOUND: 'ERR_STORE_REALM_NOT_FOUND';
  /**
   * @deprecated The providers launch gate was removed: provider-bearing
   * templates resolve against installed and attached extensions and launch
   * with missing-extension disclosure, so this code is never emitted.
   */
  readonly ERR_TEMPLATE_PROVIDERS_UNSUPPORTED: 'ERR_TEMPLATE_PROVIDERS_UNSUPPORTED';
  readonly ERR_TEMPLATE_AUTHORITY_UNSUPPORTED: 'ERR_TEMPLATE_AUTHORITY_UNSUPPORTED';
  readonly ERR_STORE_TEMPLATE_TOO_LARGE: 'ERR_STORE_TEMPLATE_TOO_LARGE';
  readonly ERR_STORE_TEMPLATE_PERSIST_FAILED: 'ERR_STORE_TEMPLATE_PERSIST_FAILED';
  readonly ERR_STORE_EXTENSION_ALREADY_INSTALLED: 'ERR_STORE_EXTENSION_ALREADY_INSTALLED';
  readonly ERR_STORE_EXTENSION_NOT_INSTALLED: 'ERR_STORE_EXTENSION_NOT_INSTALLED';
  readonly ERR_STORE_EXTENSION_ALREADY_ATTACHED: 'ERR_STORE_EXTENSION_ALREADY_ATTACHED';
  readonly ERR_STORE_EXTENSION_ATTACHED: 'ERR_STORE_EXTENSION_ATTACHED';
  readonly ERR_STORE_EXTENSION_NOT_CONNECTABLE: 'ERR_STORE_EXTENSION_NOT_CONNECTABLE';
  readonly ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED: 'ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED';
  readonly ERR_STORE_EXTENSION_INVALID_ENDPOINT: 'ERR_STORE_EXTENSION_INVALID_ENDPOINT';
  readonly ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL: 'ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL';
  readonly ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED: 'ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED';
  readonly ERR_STORE_EXTENSION_CONNECT_FAILED: 'ERR_STORE_EXTENSION_CONNECT_FAILED';
  readonly ERR_STORE_PAYLOAD_LIBRARY_FULL: 'ERR_STORE_PAYLOAD_LIBRARY_FULL';
  readonly ERR_STORE_PAYLOAD_LIBRARY_TOO_LARGE: 'ERR_STORE_PAYLOAD_LIBRARY_TOO_LARGE';
  readonly ERR_STORE_ARCHIVE_FAILED: 'ERR_STORE_ARCHIVE_FAILED';
  readonly ERR_STORE_REALM_IMPORT_FAILED: 'ERR_STORE_REALM_IMPORT_FAILED';
} = Object.freeze({
  ERR_STORE_AGENT_NOT_FOUND: 'ERR_STORE_AGENT_NOT_FOUND',
  ERR_STORE_NO_AGENT_SELECTED: 'ERR_STORE_NO_AGENT_SELECTED',
  ERR_STORE_TURN_FAILED: 'ERR_STORE_TURN_FAILED',
  ERR_STORE_INVALID_PARAMS: 'ERR_STORE_INVALID_PARAMS',
  ERR_STORE_VFS_FAILED: 'ERR_STORE_VFS_FAILED',
  ERR_STORE_REALM_NOT_EMPTY: 'ERR_STORE_REALM_NOT_EMPTY',
  ERR_STORE_REALM_PROTECTED: 'ERR_STORE_REALM_PROTECTED',
  ERR_STORE_REALM_DELETE_FAILED: 'ERR_STORE_REALM_DELETE_FAILED',
  ERR_STORE_REALM_LAUNCH_FAILED: 'ERR_STORE_REALM_LAUNCH_FAILED',
  ERR_STORE_REALM_NOT_FOUND: 'ERR_STORE_REALM_NOT_FOUND',
  ERR_TEMPLATE_PROVIDERS_UNSUPPORTED: 'ERR_TEMPLATE_PROVIDERS_UNSUPPORTED',
  ERR_TEMPLATE_AUTHORITY_UNSUPPORTED: 'ERR_TEMPLATE_AUTHORITY_UNSUPPORTED',
  ERR_STORE_TEMPLATE_TOO_LARGE: 'ERR_STORE_TEMPLATE_TOO_LARGE',
  ERR_STORE_TEMPLATE_PERSIST_FAILED: 'ERR_STORE_TEMPLATE_PERSIST_FAILED',
  ERR_STORE_EXTENSION_ALREADY_INSTALLED: 'ERR_STORE_EXTENSION_ALREADY_INSTALLED',
  ERR_STORE_EXTENSION_NOT_INSTALLED: 'ERR_STORE_EXTENSION_NOT_INSTALLED',
  ERR_STORE_EXTENSION_ALREADY_ATTACHED: 'ERR_STORE_EXTENSION_ALREADY_ATTACHED',
  ERR_STORE_EXTENSION_ATTACHED: 'ERR_STORE_EXTENSION_ATTACHED',
  ERR_STORE_EXTENSION_NOT_CONNECTABLE: 'ERR_STORE_EXTENSION_NOT_CONNECTABLE',
  ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED: 'ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED',
  ERR_STORE_EXTENSION_INVALID_ENDPOINT: 'ERR_STORE_EXTENSION_INVALID_ENDPOINT',
  ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL: 'ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL',
  ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED: 'ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED',
  ERR_STORE_EXTENSION_CONNECT_FAILED: 'ERR_STORE_EXTENSION_CONNECT_FAILED',
  ERR_STORE_PAYLOAD_LIBRARY_FULL: 'ERR_STORE_PAYLOAD_LIBRARY_FULL',
  ERR_STORE_PAYLOAD_LIBRARY_TOO_LARGE: 'ERR_STORE_PAYLOAD_LIBRARY_TOO_LARGE',
  ERR_STORE_ARCHIVE_FAILED: 'ERR_STORE_ARCHIVE_FAILED',
  ERR_STORE_REALM_IMPORT_FAILED: 'ERR_STORE_REALM_IMPORT_FAILED'
});

/**
 * Type representing one of the standardized sandbox store error codes.
 */
export type SandboxStoreErrorCode = typeof SANDBOX_STORE_ERROR_CODES[keyof typeof SANDBOX_STORE_ERROR_CODES];

/**
 * Primary navigation tabs available in the Sandbox Studio workstation interface.
 * - `'chat'`: Main conversational studio view.
 * - `'settings'`: Provider, model, and sandbox configuration panel.
 * - `'inspector'`: Telemetry, clock, event logs, and agent inspection drawer.
 * - `'filesystem'`: Multi-tenant VirtualFS file explorer and archive manager.
 * - `'messaging'`: Multi-agent messaging bus audit viewer and manual injector.
 */
export type SandboxTabId = 'chat' | 'settings' | 'inspector' | 'filesystem' | 'messaging';

// ============================================================================
// Normalized State Snapshot Types
// ============================================================================

/**
 * Aggregate telemetry counters and token usage metrics for a specific agent.
 * 
 * @example
 * ```typescript
 * const telemetry: AgentTelemetrySnapshot = {
 *   inputTokens: 1250,
 *   cachedInputTokens: 300,
 *   outputTokens: 420,
 *   totalTokens: 1970,
 *   turnCount: 3,
 *   lastPromptTokens: 450,
 *   lastCachedPromptTokens: 120,
 *   lastCompletionTokens: 150,
 *   terminalStops: 0,
 *   injectedDeliveries: 1,
 *   precallCount: 2,
 *   lastSentContext: []
 * };
 * ```
 */
export interface AgentTelemetrySnapshot {
  /** Cumulative uncached input (prompt) tokens consumed across all turns. */
  readonly inputTokens: number;
  /** Cumulative cached input (prompt) tokens consumed across all turns. */
  readonly cachedInputTokens: number;
  /** Cumulative output (completion) tokens generated across all turns. */
  readonly outputTokens: number;
  /** Total tokens consumed by this agent (`inputTokens + cachedInputTokens + outputTokens`). */
  readonly totalTokens: number;
  /** Total number of conversational execution turns completed. */
  readonly turnCount: number;
  /** Uncached prompt token count for the most recently completed turn. */
  readonly lastPromptTokens: number;
  /** Cached prompt token count for the most recently completed turn. */
  readonly lastCachedPromptTokens: number;
  /** Completion token count for the most recently completed turn. */
  readonly lastCompletionTokens: number;
  /** Number of times turn execution terminated via terminal stop conditions. */
  readonly terminalStops: number;
  /** Number of async messages injected into context during turn execution. */
  readonly injectedDeliveries: number;
  /** Total count of precall tools executed prior to LLM generation. */
  readonly precallCount: number;
  /**
   * Formatted chat-completion messages captured for the most recent inference
   * call. Overwritten on every send (latest-wins), so consumers always read the
   * context that was actually sent last.
   */
  readonly lastSentContext: ReadonlyArray<FormattedContextMessage>;
}

/**
 * Sanitized chat-completion message captured in `AgentTelemetrySnapshot.lastSentContext`.
 *
 * Mirrors the tool-hygiene formatter output immediately before inference: `system`/`user`
 * text entries, `assistant` entries (optionally declaring `tool_calls`), and `tool`
 * responses linked by `tool_call_id`. Entries may carry the source message `id` and a
 * shallow copy of the source `metadata`.
 *
 * @example
 * ```typescript
 * const context: FormattedContextMessage[] = [
 *   { role: 'system', content: 'You are a test assistant.' },
 *   { role: 'user', content: 'Read /report.json.', id: 'msg_001' },
 *   { role: 'assistant', content: '', reasoning_content: 'Planned a tool call.', tool_calls: [
 *     { id: 'call_1', type: 'function', function: { name: 'vfs_read_file', arguments: '{"filePath":"/report.json"}' } }
 *   ] },
 *   { role: 'tool', tool_call_id: 'call_1', content: '{"status":"ok"}' }
 * ];
 * ```
 */
export type FormattedContextMessage =
  | {
      /** Message author role for a plain conversational entry. */
      readonly role: 'system' | 'user';
      /** Normalized text content of the entry. */
      readonly content: string;
      /** Source message identifier, when one was present. */
      readonly id?: string;
      /** Shallow copy of the source message metadata, when present. */
      readonly metadata?: Record<string, unknown>;
    }
  | {
      /** Message author role for a model-generated entry. */
      readonly role: 'assistant';
      /** Normalized text content; `null` when the model emitted only tool calls. */
      readonly content: string | null;
      /** Chain-of-thought text; blanked once the turn is historical. */
      readonly reasoning_content: string;
      /** Source message identifier, when one was present. */
      readonly id?: string;
      /** Shallow copy of the source message metadata, when present. */
      readonly metadata?: Record<string, unknown>;
      /** Tool invocations declared by the assistant entry. */
      readonly tool_calls?: ReadonlyArray<ToolCallSnapshot>;
    }
  | {
      /** Message author role for a tool response entry. */
      readonly role: 'tool';
      /** Identifier of the assistant tool call this entry answers. */
      readonly tool_call_id: string;
      /** Serialized tool response payload. */
      readonly content: string;
      /** Source message identifier, when one was present. */
      readonly id?: string;
      /** Registered tool name, when it could be resolved. */
      readonly name?: string;
      /** Shallow copy of the source message metadata, when present. */
      readonly metadata?: Record<string, unknown>;
    };

/**
 * Tool call invocation captured in agent history, active-turn buffers, and turn results.
 *
 * Normalized by the turn execution engine to carry both the OpenAI `function` projection
 * and the flat `name`/`args` aliases. Synthetic mail/precall tool calls may omit the flat
 * aliases and rely on the `function` projection alone.
 * 
 * @example
 * ```typescript
 * const toolCall: ToolCallSnapshot = {
 *   id: 'call_abc123',
 *   type: 'function',
 *   name: 'vfs_read_file',
 *   args: { filePath: '/world_clock.json' },
 *   function: { name: 'vfs_read_file', arguments: '{"filePath":"/world_clock.json"}' }
 * };
 * ```
 */
export interface ToolCallSnapshot {
  /** Unique identifier for the tool call instance. */
  readonly id: string;
  /** Tool call classification (always `'function'`). */
  readonly type: 'function';
  /** Flat tool name alias; omitted on synthetic mail/precall tool calls. */
  readonly name?: string;
  /** Parsed tool arguments; omitted on synthetic mail/precall tool calls. */
  readonly args?: Record<string, unknown>;
  /** OpenAI-compatible function projection of the tool call. */
  readonly function: {
    /** Registered name of the tool function. */
    readonly name: string;
    /** JSON-stringified argument payload. */
    readonly arguments: string;
  };
}

/**
 * Representation of a historical conversational message in an agent's dialog history.
 *
 * Mirrors the canonical runtime message ledger entity with snake_case tool fields
 * (`tool_call_id`, `tool_calls`, `reasoning_content`); the store projection copies the
 * runtime history array verbatim.
 * 
 * @example
 * ```typescript
 * const msg: HistoryMessage = {
 *   id: 'msg_001',
 *   role: 'assistant',
 *   content: 'Exploring sector 4 now.',
 *   reasoning_content: 'User asked for reconnaissance; listing files first.',
 *   tool_calls: [
 *     {
 *       id: 'call_1',
 *       type: 'function',
 *       name: 'vfs_list_files',
 *       args: { workspaceId: 'global' },
 *       function: { name: 'vfs_list_files', arguments: '{"workspaceId":"global"}' }
 *     }
 *   ],
 *   createdAt: 1726531200000,
 *   updatedAt: 1726531200000
 * };
 * ```
 */
export interface HistoryMessage {
  /** Unique message identifier (`msg_`/`sys_`/`turn_`/`ast_`/`tool_` prefixed). */
  readonly id: string;
  /** Role of the message sender (`'user'`, `'assistant'`, `'system'`, `'tool'`). */
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  /** Normalized text content of the message. */
  readonly content: string;
  /** Optional display name or function name of the author. */
  readonly name?: string;
  /** Tool call identifier linking a `'tool'` result message to its calling assistant message. */
  readonly tool_call_id?: string;
  /** Tool call requests declared by an assistant message. */
  readonly tool_calls?: ReadonlyArray<ToolCallSnapshot>;
  /** Chain-of-thought or reasoning text extracted from thinking models. */
  readonly reasoning_content?: string;
  /** Millisecond epoch timestamp when the message was created. */
  readonly createdAt?: number;
  /** Millisecond epoch timestamp when the message was last mutated. */
  readonly updatedAt?: number;
  /** Arbitrary metadata tags attached to the message. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * Payload for modifying fields of an existing historical message in-place.
 * 
 * @example
 * ```typescript
 * const update: HistoryMessageUpdate = {
 *   content: 'Updated prompt with corrected instructions.',
 *   reasoning_content: 'Re-evaluated the corrected prompt.',
 *   metadata: { editedAt: Date.now() }
 * };
 * ```
 */
export interface HistoryMessageUpdate {
  /** New text content to replace existing message content. */
  content?: string;
  /** New reasoning/thinking content (`reasoning_content` ledger field). */
  reasoning_content?: string;
  /** Alias for `reasoning_content`, applied only when `reasoning_content` is omitted. */
  reasoning?: string;
  /** Optional metadata properties to shallow-merge into the message. */
  metadata?: Record<string, unknown>;
}

/**
 * Dismissible recovery notice raised when persisted sandbox state could not be
 * loaded and the studio fell back to a fresh session (QA-013).
 * 
 * @example
 * ```typescript
 * const notice: SandboxHydrationNotice | null = sandboxStore.hydrationNotice;
 * if (notice) {
 *   console.warn(notice.message, notice.reason);
 * }
 * ```
 */
export interface SandboxHydrationNotice {
  /** User-facing recovery message (e.g. `'Saved session could not be loaded — starting fresh'`). */
  readonly message: string;
  /** Epoch ms timestamp when the notice was raised. */
  readonly at: number;
  /** Machine-readable recovery cause (`'unparseable'`, `'invalid-schema'`, `'unreadable'`, or `'hydration-failed'` when a critical subsystem rejected its snapshot). */
  readonly reason: string;
}

/**
 * Normalized reactive state snapshot of an active agent in runtime.
 * 
 * @example
 * ```typescript
 * const agentSnapshot: AgentStateSnapshot = {
 *   id: 'agent-writer',
 *   identityKey: 'realm:realm_generic:agent-writer',
 *   name: 'Lead Writer',
 *   config: { id: 'agent-writer', name: 'Lead Writer', role: 'Author' },
 *   state: 'idle',
 *   history: [],
 *   redoStack: [],
 *   currentStream: '',
 *   currentReasoning: '',
 *   activeToolCalls: [],
 *   turnCount: 0,
 *   lastSummary: null,
 *   pendingPrecalls: [],
 *   telemetry: { ... },
 *   createdAt: 1726531200000,
 *   updatedAt: 1726531200000,
 *   lastError: null,
 *   unreadCount: 0
 * };
 * ```
 */
export interface AgentStateSnapshot {
  /** Unique agent identifier string (e.g. `'director'`, `'agent-scout'`). */
  readonly id: string;
  /**
   * Canonical `(realmId, agentId)` identity key of this registration
   * (`createAgentIdentityKey`; defect 7d2c314). Internal-only addressing
   * reference: selection, lifecycle actions, and clock/event partitions
   * resolve it realm-exactly, so the same literal id registered in another
   * Realm is never shadowed.
   */
  readonly identityKey: string;
  /** Human-readable display name of the agent. */
  readonly name: string;
  /** Immutable launch and model configuration for this agent. */
  readonly config: Readonly<AgentConfig>;
  /** Current FSM lifecycle state of the agent (`'idle'`, `'running'`, `'waiting'`, etc.). */
  readonly state: AgentState;
  /** Detail string providing additional context on the current state, or `null` when none. */
  readonly stateDetail: string | null;
  /** Chronological array of conversational messages in this agent's history. */
  readonly history: ReadonlyArray<HistoryMessage>;
  /** Atomic turn bundles previously undone and available for redo. */
  readonly redoStack: ReadonlyArray<TurnBundle>;
  /** In-flight prose token stream currently being generated. */
  readonly currentStream: string;
  /** In-flight reasoning / thinking token stream currently being generated. */
  readonly currentReasoning: string;
  /** Array of active tool calls currently executing in the in-flight turn. */
  readonly activeToolCalls: ReadonlyArray<ToolCallSnapshot>;
  /** Number of conversational turns completed by this agent. */
  readonly turnCount: number;
  /** Most recent context summary text, or `null` if no summarization has occurred. */
  readonly lastSummary: string | null;
  /** Array of queued precall tool definitions pending execution before the next turn. */
  readonly pendingPrecalls: ReadonlyArray<unknown>;
  /** Aggregate telemetry metrics and token consumption counters for this agent. */
  readonly telemetry: AgentTelemetrySnapshot;
  /** Millisecond epoch timestamp when the agent was provisioned. */
  readonly createdAt: number;
  /** Millisecond epoch timestamp when the agent was last mutated. */
  readonly updatedAt: number;
  /** Last error message recorded during turn execution, or `null` if healthy. */
  readonly lastError: string | null;
  /** Number of unread messages currently pending in this agent's inbox. */
  readonly unreadCount: number;
}

/**
 * Normalized reactive snapshot of a soft-killed agent currently residing in the recycle bin.
 * Preserves the complete conversational history and redo stack; the agent's private workspace
 * is evicted from VirtualFS at kill time and is not part of this snapshot.
 *
 * Intentionally omits the live-turn projection fields (`currentStream`, `currentReasoning`,
 * `activeToolCalls`) and `unreadCount`, which are absent from the recycle-bin projection.
 * 
 * @example
 * ```typescript
 * const recycled: RecycledAgentStateSnapshot = {
 *   id: 'agent-scout',
 *   identityKey: 'realm:realm_generic:agent-scout',
 *   name: 'Scout Unit',
 *   config: { id: 'agent-scout', name: 'Scout Unit', role: 'Recon' },
 *   state: 'recycled',
 *   stateDetail: 'Mission completed',
 *   recycledAt: '2026-09-18T08:00:00.000Z',
 *   recycleReason: 'Mission completed',
 *   history: [],
 *   redoStack: [],
 *   turnCount: 3,
 *   lastSummary: null,
 *   pendingPrecalls: [],
 *   telemetry: { ... },
 *   createdAt: 1726531200000,
 *   updatedAt: 1726531300000,
 *   lastError: null
 * };
 * ```
 */
export interface RecycledAgentStateSnapshot {
  /** Unique agent identifier string (e.g. `'agent-scout'`). */
  readonly id: string;
  /**
   * Canonical `(realmId, agentId)` identity key of this recycled
   * registration (`createAgentIdentityKey`; defect 7d2c314), so restore and
   * purge address the exact record even when the literal id is live in
   * another Realm.
   */
  readonly identityKey: string;
  /** Human-readable display name of the agent. */
  readonly name: string;
  /** Immutable launch and model configuration for this agent. */
  readonly config: Readonly<AgentConfig>;
  /** FSM lifecycle state of the recycled agent (`'recycled'`). */
  readonly state: AgentState;
  /** Detail string recorded on soft-kill (typically the kill reason), or `null`. */
  readonly stateDetail: string | null;
  /** ISO-8601 timestamp of the soft-kill, or `null` when none was recorded. */
  readonly recycledAt: string | null;
  /** Reason recorded for the soft-kill, or `null` when none was supplied. */
  readonly recycleReason: string | null;
  /** Chronological array of conversational messages preserved from before the kill. */
  readonly history: ReadonlyArray<HistoryMessage>;
  /** Atomic turn bundles preserved for post-restore redo capability. */
  readonly redoStack: ReadonlyArray<TurnBundle>;
  /** Number of conversational turns completed by this agent before the kill. */
  readonly turnCount: number;
  /** Most recent context summary text, or `null` if no summarization occurred. */
  readonly lastSummary: string | null;
  /** Array of queued precall tool definitions preserved from before the kill. */
  readonly pendingPrecalls: ReadonlyArray<unknown>;
  /** Aggregate telemetry metrics and token consumption counters for this agent. */
  readonly telemetry: AgentTelemetrySnapshot;
  /** Millisecond epoch timestamp when the agent was provisioned. */
  readonly createdAt: number;
  /** Millisecond epoch timestamp when the agent was last mutated. */
  readonly updatedAt: number;
  /** Last error message recorded before the kill, or `null` if healthy. */
  readonly lastError: string | null;
}

/**
 * Normalized snapshot of a scheduled deferred turn execution with live countdown tracking.
 * 
 * @example
 * ```typescript
 * const timer: ScheduledTimerSnapshot = {
 *   timerId: 'timer_123',
 *   agentId: 'agent-scout',
 *   targetAgentId: 'agent-scout',
 *   durationSeconds: 60,
 *   remainingSeconds: 45,
 *   scheduledAt: 1726531200000,
 *   fireAt: 1726531260000,
 *   prompt: 'Check recon sensor feeds',
 *   timerCondition: 'never',
 *   status: 'pending',
 *   triggeredAt: null,
 *   cancelledAt: null
 * };
 * ```
 */
export interface ScheduledTimerSnapshot {
  /** Unique identifier for the scheduled timer. */
  readonly timerId: string;
  /** Agent ID that scheduled or owns the timer. */
  readonly agentId: string;
  /** Target agent ID that will receive and execute the prompt turn upon expiration. */
  readonly targetAgentId: string;
  /** Total duration in seconds configured for the timer. */
  readonly durationSeconds: number;
  /** Live countdown of remaining seconds until timer fires. Updated every 1s. */
  readonly remainingSeconds: number;
  /** Millisecond epoch timestamp when the timer was registered. */
  readonly scheduledAt: number;
  /** Millisecond epoch timestamp when the timer will fire. */
  readonly fireAt: number;
  /** Prompt text to submit to the target agent when the timer expires. */
  readonly prompt: string;
  /** Early cancellation condition (`'never'`, `'any'`, or specific sender agent ID). */
  readonly timerCondition: 'never' | 'any' | string;
  /** Current lifecycle status of the timer (`pending`, `triggered`, or `cancelled`, mirroring the scheduler's `SCHEDULER_STATUS`). */
  readonly status: 'pending' | 'triggered' | 'cancelled';
  /** Millisecond epoch timestamp when the timer triggered, or `null` if not triggered. */
  readonly triggeredAt: number | null;
  /** Millisecond epoch timestamp when the timer was cancelled, or `null` if not cancelled. */
  readonly cancelledAt: number | null;
}

/**
 * Aggregate telemetry KPIs and system-wide statistics across all active agents and subsystems.
 * 
 * @example
 * ```typescript
 * const stats: SandboxTelemetryStats = sandboxStore.stats;
 * console.log(`Active agents: ${stats.total}, Running: ${stats.running}, Files: ${stats.totalFiles}`);
 * ```
 */
export interface SandboxTelemetryStats {
  /** Total number of active agents in runtime. */
  readonly total: number;
  /** Number of agents currently in `RUNNING` state. */
  readonly running: number;
  /** Number of agents currently in `IDLE` state. */
  readonly idle: number;
  /** Number of agents currently in `ERRORED` state. */
  readonly errored: number;
  /** Number of agents currently in a `waiting` state (e.g. awaiting subagent or timer). */
  readonly waiting: number;
  /** Number of agents in `TERMINATED` state. */
  readonly terminated: number;
  /** Total number of messages recorded in the MessagingBus audit log. */
  readonly totalMessages: number;
  /** Total number of virtual files across all workspaces (`global` and agent-private). */
  readonly totalFiles: number;
  /** Number of scheduled timers currently in `pending` status. */
  readonly activeTimers: number;
  /** Total number of scheduled timers recorded (pending, triggered, and cancelled). */
  readonly totalTimers: number;
  /** Cumulative count of terminal stop events across all agents. */
  readonly terminalStops: number;
  /** Cumulative count of async bus messages injected into turns across all agents. */
  readonly injectedDeliveries: number;
  /** Cumulative count of precall tool executions across all agents. */
  readonly precallCount: number;
  /** Cumulative uncached input (prompt) tokens consumed across all agents and history. */
  readonly cumulativeInputTokens: number;
  /** Cumulative cached input (prompt) tokens consumed across all agents and history. */
  readonly cumulativeCachedInputTokens: number;
  /** Cumulative output (completion) tokens generated across all agents and history. */
  readonly cumulativeOutputTokens: number;
  /** Cumulative total tokens consumed across the sandbox (`uncached input + cached input + output`). */
  readonly cumulativeTotalTokens: number;
}

/**
 * Structured narrative clock snapshot representing in-universe time for a partition or global.
 * 
 * @example
 * ```typescript
 * const clock: AgentClockState = {
 *   totalSeconds: 3661,
 *   formattedTime: '01:01:01',
 *   day: 1,
 *   hour: 1,
 *   minute: 1,
 *   second: 1
 * };
 * ```
 */
export interface AgentClockState {
  /** Total elapsed narrative seconds from zero epoch. */
  readonly totalSeconds: number;
  /** Formatted string representation of narrative time (e.g. `'01:01:01'`). */
  readonly formattedTime: string;
  /** Current 1-indexed narrative day number. */
  readonly day: number;
  /** Current hour of the day (0-23). */
  readonly hour: number;
  /** Current minute of the hour (0-59). */
  readonly minute: number;
  /** Current second of the minute (0-59). */
  readonly second: number;
}

/**
 * Reactive query result containing narrative events registered in WorldClock for an agent partition.
 * 
 * @example
 * ```typescript
 * const eventsQuery: AgentEventsQueryState = sandboxStore.selectedAgentEvents;
 * console.log(`Total events: ${eventsQuery.count}, Active: ${eventsQuery.activeCount}`);
 * ```
 */
export interface AgentEventsQueryState {
  /** Array of all narrative events registered for the partition. */
  readonly events: ReadonlyArray<NarrativeEvent>;
  /** Array of currently active (triggered/firing) narrative events. */
  readonly activeEvents: ReadonlyArray<NarrativeEvent>;
  /** Count of narrative events matching the query filters. */
  readonly count: number;
  /** Count of currently active events. */
  readonly activeCount: number;
  /** Count of pending (scheduled but not yet triggered) events. */
  readonly pendingCount: number;
}

/**
 * Structured log entry for the PRD multi-agent handshake collaboration demonstration.
 * 
 * @example
 * ```typescript
 * const log: DemoLogEntry = {
 *   timestamp: Date.now(),
 *   step: '4. Scout Reconnaissance',
 *   message: 'Scout Unit Alpha wrote /mission_report.json to global workspace.',
 *   type: 'info'
 * };
 * ```
 */
export interface DemoLogEntry {
  /** Millisecond epoch timestamp when the log entry was generated. */
  readonly timestamp: number;
  /** Human-readable name or milestone phase of the demo step. */
  readonly step: string;
  /** Detailed log description of actions taken during the step. */
  readonly message: string;
  /** Classification type of the log entry (`'info'`, `'success'`, `'error'`, `'warning'`). */
  readonly type: 'info' | 'success' | 'error' | 'warning';
}

// ============================================================================
// Action Parameter & Receipt Types
// ============================================================================

/**
 * Options configuring conversational turn submission or programmatic execution.
 * 
 * @example
 * ```typescript
 * const options: TurnOptions = {
 *   mode: 'directive',
 *   callerAgentId: 'director',
 *   metadata: { priority: 'urgent' }
 * };
 * ```
 */
export interface TurnOptions {
  /**
   * Action mode governing how the turn engine ingests the prompt:
   * - `'system'`: The prompt is pushed to the agent history as a system message.
   * - `'injection'`: The prompt is delivered to the target agent as a MessagingBus message.
   * - `'directive'`: Standard user turn (default).
   *
   * The legacy narrative category strings `'do'`, `'say'`, and `'story'` are
   * accepted for call-site compatibility, but the turn engine assigns them no
   * narrative semantics: any value other than `'system'` or `'injection'`
   * executes as a directive turn.
   */
  mode?: 'directive' | 'system' | 'injection' | 'do' | 'say' | 'story';
  /**
   * Accepted for callers that attribute a turn to a particular agent. The turn
   * engine never reads this field, so it does not affect routing, attribution,
   * or execution.
   */
  callerAgentId?: string;
  /** Custom metadata key-value dictionary attached to the turn. */
  metadata?: Record<string, unknown>;
  /** Abort signal allowing client-side cancellation of in-flight LLM inference. */
  signal?: AbortSignal;
}

/**
 * Complete result returned upon the successful completion of an agent execution turn.
 * 
 * @example
 * ```typescript
 * const result: TurnResult = await sandboxStore.submitChatTurn('Write opening scene');
 * console.log('Generated prose:', result.output);
 * console.log('Tools executed:', result.toolCalls.length);
 * ```
 */
export interface TurnResult {
  /**
   * Agent after turn completion: the reactive state snapshot when the agent is
   * still registered, otherwise the live turn-result agent projection.
   */
  agent: AgentStateSnapshot | TurnExecutionResult['agent'];
  /** Final generated text output or completion prose from the turn. */
  output: string;
  /** Array of tool calls executed and completed during this turn. */
  toolCalls: ReadonlyArray<ToolCallSnapshot>;
}

/**
 * Receipt returned upon executing the emergency turn unsticking primitive (`unstickAgent`).
 *
 * The store surfaces the runtime's unstick receipt unchanged; only `success` is guaranteed
 * because a missing target agent ID short-circuits to `{ success: false }` before the
 * runtime is consulted.
 * 
 * @example
 * ```typescript
 * const receipt: UnstickResult = sandboxStore.unstickAgent('agent-scout');
 * if (receipt.success && receipt.agent) {
 *   console.log(`Agent ${receipt.agent.id} reset from ${receipt.previousState} to idle: ${receipt.reason}`);
 * }
 * ```
 */
export interface UnstickResult {
  /** Whether the agent was successfully unstuck and reset to `IDLE`. */
  success: boolean;
  /** The unstuck runtime agent instance; absent when no target agent ID was resolved. */
  agent?: Agent;
  /** FSM state the agent occupied before unsticking; absent when no target was resolved. */
  previousState?: AgentState;
  /** Diagnostic reason supplied to the runtime unstick path; absent when no target was resolved. */
  reason?: string;
}

/**
 * Result returned upon undoing the last conversational turn for an agent (`undoAgentTurn`).
 * 
 * @example
 * ```typescript
 * const undoResult: UndoTurnResult | null = sandboxStore.undoAgentTurn();
 * if (undoResult) {
 *   console.log('Restored prompt into draft:', undoResult.restoredPrompt);
 * }
 * ```
 */
export interface UndoTurnResult {
  /** The user prompt content removed from history and pushed to redo stack. */
  undoneUserContent: string | Record<string, unknown> | null;
  /** The assistant response content removed from history and pushed to redo stack. */
  undoneAssistantContent: string | Record<string, unknown> | null;
  /** Number of messages popped from conversational history (typically 2). */
  count: number;
  /** Undone user prompt text automatically restored into the agent's draft input buffer. */
  restoredPrompt: string;
}

/**
 * Result returned upon redoing the last undone conversational turn (`redoAgentTurn`).
 * 
 * @example
 * ```typescript
 * const redoResult: RedoTurnResult | null = sandboxStore.redoAgentTurn();
 * if (redoResult?.success) {
 *   console.log('Redone turn completed. Turn count:', redoResult.turnCount);
 * }
 * ```
 */
export interface RedoTurnResult {
  /** Whether the redo operation succeeded. */
  success: boolean;
  /** Optional error reason if redo failed (e.g. empty redo stack). */
  reason?: string;
  /** Restored prompt text associated with the reinstated turn. */
  restoredPrompt?: string;
  /** Total turn count for the agent after redoing. */
  turnCount?: number;
}

/**
 * Parameters for registering a scheduled deferred turn execution (`scheduleTimer`).
 * 
 * @example
 * ```typescript
 * const params: ScheduleTimerParams = {
 *   durationSeconds: 300,
 *   prompt: 'Perform periodic health scan on sector grid',
 *   timerCondition: 'never',
 *   agentId: 'agent-scout'
 * };
 * ```
 */
export interface ScheduleTimerParams {
  /** Delay duration in seconds before the timer triggers. */
  durationSeconds: number;
  /** Prompt message to submit to the target agent when the timer expires. */
  prompt: string;
  /**
   * Condition under which timer is cancelled early before expiration:
   * - `'never'`: Unconditionally fires after `durationSeconds` unless explicitly cancelled.
   * - `'any'`: Automatically cancelled early if ANY message is received by the target agent.
   * - `<senderId>`: Cancelled early only if a message is received from that specific agent ID.
   */
  timerCondition?: 'never' | 'any' | string;
  /** Target agent ID to execute the prompt (defaults to `selectedAgentId`). */
  agentId?: string | null;
}

/**
 * Receipt returned upon registering a scheduled timer (`scheduleTimer`).
 *
 * Alias of the runtime scheduler's `ScheduleReceipt` union: narrow on `success`.
 * The success variant carries `timerId`, `targetAgentId`, `prompt`, `fireAt`, and
 * `scheduledAt`; the failure variant carries `error` and `code` only (no
 * `timerId`/`fireAt`).
 *
 * @example
 * ```typescript
 * const receipt: ScheduleTimerReceipt = await sandboxStore.scheduleTimer({
 *   durationSeconds: 60,
 *   prompt: 'Wake up and check status'
 * });
 * if (receipt.success) {
 *   console.log(`Timer ${receipt.timerId} will fire at ${new Date(receipt.fireAt)}`);
 * } else {
 *   console.warn(`Timer not scheduled [${receipt.code}]: ${receipt.error}`);
 * }
 * ```
 */
export type ScheduleTimerReceipt = ScheduleResult;

/**
 * Aggregate receipt returned upon batch deleting files from VirtualFS (`deleteFiles`).
 * 
 * @example
 * ```typescript
 * const receipt: BatchDeleteReceipt = sandboxStore.deleteFiles(['/temp.txt', '/cache.json']);
 * console.log(`Deleted ${receipt.count} files:`, receipt.deleted);
 * ```
 */
export interface BatchDeleteReceipt {
  /** Whether the batch deletion operation completed. */
  success: boolean;
  /** Count of files successfully deleted. */
  count: number;
  /** Array of virtual file paths that were deleted. */
  deleted: string[];
}

/**
 * Input descriptor for uploading text or JSON content to a virtual file path.
 * 
 * @example
 * ```typescript
 * const input: UploadFileInput = {
 *   path: '/notes/plan.md',
 *   content: '# Operational Plan\n1. Recon\n2. Strike'
 * };
 * ```
 */
export interface UploadFileInput {
  /** Relative or absolute virtual path where content should be written. */
  path: string;
  /** Text content of the file to write. */
  content: string;
}

/**
 * Options configuring browser file upload processing into VirtualFS (`uploadFiles`).
 * 
 * @example
 * ```typescript
 * const options: UploadOptions = {
 *   overwrite: true,
 *   callerAgentId: 'director'
 * };
 * ```
 */
export interface UploadOptions {
  /** Whether to overwrite existing files at target paths without throwing errors. */
  overwrite?: boolean;
  /** ID of the caller agent initiating upload for access control and ownership. */
  callerAgentId?: string;
}

/**
 * Receipt returned upon uploading files into VirtualFS (`uploadFiles`).
 * 
 * @example
 * ```typescript
 * const receipt: UploadReceipt = await sandboxStore.uploadFiles(fileList);
 * console.log(`Uploaded ${receipt.count} files:`, receipt.files);
 * ```
 */
export interface UploadReceipt {
  /** Whether the upload operation completed successfully. */
  success: boolean;
  /** Number of files uploaded and written to VirtualFS. */
  count: number;
  /** Array of normalized virtual file paths written. */
  files: string[];
}

/**
 * Receipt returned when downloading workspace files individually
 * (`downloadWorkspaceFilesSeparately`, `downloadAllWorkspacesFilesSeparately`).
 *
 * Mirrors the runtime `BatchDownloadReceipt` produced by `fsDownloadUtils`
 * verbatim: successful entries are counted in `count` and named in `files`,
 * while failed entries are collected in `failures` instead of rejecting the
 * batch. `success` is `false` whenever `failures` is non-empty.
 * 
 * @example
 * ```typescript
 * const receipt: SeparateDownloadReceipt = await sandboxStore.downloadWorkspaceFilesSeparately();
 * console.log(`Downloaded ${receipt.count} files.`);
 * if (receipt.failures.length > 0) {
 *   console.warn(`${receipt.failures.length} files could not be downloaded.`);
 * }
 * ```
 */
export interface SeparateDownloadReceipt {
  /** Whether every file in the batch downloaded successfully. */
  success: boolean;
  /** Total number of files successfully triggered for browser download. */
  count: number;
  /** Filenames of the successfully downloaded files. */
  files: string[];
  /** Per-entry failures captured while processing the batch; empty when every entry succeeded. */
  failures: BatchDownloadFailure[];
}

/**
 * Progress callback invoked during multi-file download batches.
 * 
 * @param current - Current 1-indexed file number being processed.
 * @param total - Total count of files in the download queue.
 * @param fileName - File path or name currently being downloaded.
 * 
 * @example
 * ```typescript
 * const onProgress: ProgressCallback = (current, total, fileName) => {
 *   console.log(`Downloading [${current}/${total}]: ${fileName}`);
 * };
 * ```
 */
export type ProgressCallback = (current: number, total: number, fileName: string) => void;

/**
 * Partition kind of one operator-facing VirtualFS workspace entry
 * (ticket 7571ce5): the literal shared `global` workspace, a Realm's
 * realm-global partition (`realm:<realmId>:global`), an active agent's
 * resolved private workspace, or any other literal/pinned/orphaned workspace
 * key carried by the snapshot.
 */
export type FsWorkspacePartitionKind = 'global' | 'realm-global' | 'agent' | 'workspace';

/**
 * One operator-facing VirtualFS workspace partition (ticket 7571ce5): the
 * resolved internal snapshot key an operator surface must address, a
 * realm-qualified display label, the Realm the partition belongs to, the
 * partition kind, and the file count read from the resolved key.
 *
 * This is the operator projection of the VirtualFS snapshot: unlike the
 * agent-facing `allWorkspaces` labels it deliberately carries the internal
 * storage key (and the Realm id/name) so the operator explorer can select,
 * view, upload into, and download a specific partition — including
 * realm-global partitions and the same bare agent id live in two Realms.
 * Agent-visible listings and receipts must never consume this projection.
 *
 * @example
 * ```typescript
 * for (const partition of sandboxStore.fsWorkspacePartitions) {
 *   console.log(`${partition.label} [${partition.kind}] — ${partition.fileCount} file(s)`);
 * }
 * ```
 */
export interface FsWorkspacePartition {
  /** Internal VirtualFS snapshot key; operator addressing only, never agent-visible. */
  readonly key: string;
  /** Operator display label (realm-qualified for Realm-scoped partitions). */
  readonly label: string;
  /** Realm membership of the partition, or `null` for shared/literal workspaces. */
  readonly realmId: string | null;
  /** Registered Realm display name when resolvable, else `null`. */
  readonly realmName: string | null;
  /** Partition kind. */
  readonly kind: FsWorkspacePartitionKind;
  /** File count of the resolved partition (`key`), never of a projected label. */
  readonly fileCount: number;
}

/**
 * Receipt returned upon resetting narrative events for a partition (`resetAgentEvents`).
 * 
 * @example
 * ```typescript
 * const receipt: NarrativeResetReceipt = sandboxStore.resetAgentEvents('agent-scout');
 * console.log(`Cleared ${receipt.cleared} narrative events.`);
 * ```
 */
export interface NarrativeResetReceipt {
  /** Whether the events were successfully cleared from WorldClock. */
  success: boolean;
  /** Number of narrative events removed from the partition. */
  cleared: number;
}

/**
 * Receipt returned upon resetting the narrative world clock (`resetAgentClock`).
 * 
 * @example
 * ```typescript
 * const receipt: ClockResetReceipt = sandboxStore.resetAgentClock('global');
 * console.log('Clock reset success:', receipt.success);
 * ```
 */
export interface ClockResetReceipt {
  /** Whether the world clock was successfully reset to 0 seconds and 'Day 1'. */
  success: boolean;
}

/**
 * Result returned upon completing the automated multi-agent handshake scenario (`runHandshakeDemo`).
 * 
 * @example
 * ```typescript
 * const result: DemoResult = await sandboxStore.runHandshakeDemo();
 * console.log('Demo completed successfully:', result.success);
 * console.log('Total demo logs:', result.logs.length);
 * ```
 */
export interface DemoResult {
  /** Whether the end-to-end handshake demo completed without unhandled errors. */
  success: boolean;
  /** Array of chronological structured log entries emitted during the demo. */
  logs: ReadonlyArray<DemoLogEntry>;
  /** Error message string if the demo failed during execution. */
  error?: string;
}

/**
 * Query options for filtering narrative events in WorldClock (`queryAgentEvents`).
 * 
 * @example
 * ```typescript
 * const options: EventQueryOptions = { activeOnly: true };
 * const activeEvents = sandboxStore.queryAgentEvents(options);
 * ```
 */
export interface EventQueryOptions {
  /** If true, queries narrative events across all agent partitions simultaneously (the store issues the query under the host operator principal, which spans every partition). */
  all?: boolean;
  /** If true, filters query to only events that are currently active/triggered. */
  activeOnly?: boolean;
}

// ============================================================================
// Store Constructor Options
// ============================================================================

/**
 * One launchable Realm template bundle (the authored seam): the template —
 * format v1 or format v2 — plus the bundle file bodies its `file` prompt
 * parts, placement `file` sources, and input `defaultFile` prefills resolve
 * against.
 *
 * The bundle is the store's launch seam: host/pipeline injection registers
 * authored bundles through {@link SandboxStoreOptions.realmTemplateBundles},
 * and the store normalizes each template once for exposure and launch
 * ({@link RealmTemplateBundleView}). The baked catalog ships the demo bundle
 * with no files; the store freezes the bundle container and a copy of the
 * file map, while the template itself is used as supplied (baked/injected
 * templates are validated at catalog resolution).
 */
export interface RealmTemplateBundle {
  /** Authored template the bundle launches (format v1 or format v2). */
  readonly template: RealmTemplate;
  /** Bundle file bodies keyed by bundle-relative path (empty for file-less bundles). */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * One effective launch bundle as the launcher and review surfaces see it: the
 * normalized format-v2 template ({@link normalizeTemplate} of the authored
 * bundle template) plus the bundle file bodies.
 *
 * Exposure is normalized so the launcher can read declared inputs, placements,
 * and directives without a format branch; the authored form stays the identity
 * and round-trip source (imports persist/export their authored payload,
 * shipped bundles re-serialize their authored template, and the effective
 * template version is the authored-form pin).
 */
export interface RealmTemplateBundleView {
  /** Normalized format-v2 template (frozen). */
  readonly template: RealmTemplate;
  /** Bundle file bodies keyed by bundle-relative path (the authored file map). */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Effective-catalog source label for one launch template (Wave T, ticket
 * 0df20ae): what the launcher picker needs to label an entry `shipped`,
 * `imported`, or `imported · replaces shipped`.
 *
 * `shipped` covers the store's build/host catalog — the `realmCatalog` baked
 * bundles plus any per-instance `realmTemplateBundles` injection (host-provided
 * content is shipped content for this store instance). `imported` covers
 * runtime imports persisted through {@link SandboxStore.importRealmTemplate};
 * `replacesShipped` is `true` when an imported entry shadows a shipped id and
 * `false` for imports of new ids (and always `false` for shipped entries).
 */
export interface RealmTemplateSourceInfo {
  /** Template id of the effective catalog entry. */
  readonly templateId: string;
  /** Effective source of the entry: `shipped` (build/host catalog) or `imported` (runtime import). */
  readonly source: 'shipped' | 'imported';
  /** True when an imported entry shadows a shipped entry of the same id. */
  readonly replacesShipped: boolean;
  /** Effective bundle content version (`sha256:<hex>`), or `null` when the bundle cannot be versioned (malformed host injection). */
  readonly templateVersion: string | null;
}

/**
 * Receipt returned by `SandboxStore.importRealmTemplate()`.
 *
 * The import already persisted synchronously when the receipt is returned: a
 * storage failure throws `ERR_STORE_TEMPLATE_PERSIST_FAILED` instead and the
 * registry is rolled back, so an accepted receipt always means the effective
 * catalog and the persisted snapshot agree.
 */
export interface RealmTemplateImportReceipt {
  /** Imported template id. */
  readonly templateId: string;
  /** Per-bundle content version (`sha256:<hex>`) of the imported bundle. */
  readonly templateVersion: string;
  /** Always `'imported'`: the receipt describes a runtime import. */
  readonly source: 'imported';
  /** True when the import shadows a shipped entry of the same id. */
  readonly replacesShipped: boolean;
  /** True when the import replaced a previous import of the same id. */
  readonly replacedImport: boolean;
  /** Effective imported-template content bytes across every import after this one. */
  readonly totalImportedBytes: number;
  /** Parser warnings (empty when none). */
  readonly warnings: readonly string[];
  /**
   * Present and `true` only on a preview receipt produced by
   * `previewRealmTemplateImport()` / the publishing port's dry run; real
   * import receipts omit the field so their wire shape is unchanged.
   */
  readonly dryRun?: true;
}

/**
 * Draft accepted by `SandboxStore.saveInstancePayload()` (ticket 81d8267):
 * the operator-supplied name plus the authored payload envelope and the
 * template binding it was validated against.
 */
export interface SavedInstancePayloadDraft {
  /** Operator-chosen display name (non-empty, unique per library, case-insensitive). */
  readonly name: string;
  /** Template id the payload targets. */
  readonly templateId: string;
  /** Effective template version the payload validated against (`sha256:<hex>`). */
  readonly templateVersion: string;
  /** Authored format-v2 payload value (plain finite JSON object). */
  readonly payload: unknown;
}

/**
 * One frozen entry of the store's saved hydration-payload library (ticket
 * 81d8267). The payload is descriptive data: it is persisted additively in the
 * snapshot (`savedInstancePayloads`) and re-validated against the effective
 * template contract only when a launch attaches it.
 */
export interface SavedInstancePayload {
  /** Stable library id (`saved_payload_<n>`), unique within the library. */
  readonly id: string;
  /** Operator-chosen display name (trimmed). */
  readonly name: string;
  /** Template id the payload targets. */
  readonly templateId: string;
  /** Effective template version the payload validated against (`sha256:<hex>`). */
  readonly templateVersion: string;
  /** Canonical `payloadDigest` of the authored payload. */
  readonly digest: string;
  /** The authored payload value (frozen, caller-mutation-isolated copy). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** ISO-8601 save timestamp. */
  readonly savedAt: string;
}

/**
 * Configuration options for creating or initializing a `SandboxStore` instance.
 * Allows dependency injection for test isolation and multi-tenant environments.
 * 
 * @example
 * ```typescript
 * const options: SandboxStoreOptions = {
 *   autoBootstrapDirector: true,
 *   autoHydrate: true
 * };
 * const customStore = new SandboxStore(options);
 * ```
 */
export interface SandboxStoreOptions {
  /** Optional custom VirtualFS instance. If omitted, a fresh instance with 20KB budget is created. */
  virtualFs?: VirtualFS;
  /** Optional custom MessagingBus instance. If omitted, a fresh instance is created. */
  messagingBus?: MessagingBus;
  /**
   * Optional custom AgentRuntime instance. If omitted, a fresh instance is created and
   * receives the store's MOD-20 preset source; a caller-injected runtime is caller-owned
   * and is never re-wired (no `presetSource` injection).
   */
  runtime?: AgentRuntime;
  /**
   * Optional custom `CredentialStoragePort` for the owned MOD-16 credential vault
   * (`{ get, set, remove }`). If omitted or `null`, the declared browser adapter
   * (`createBrowserCredentialStorage()`) is used. Primarily for test isolation.
   */
  credentialStorage?: CredentialStoragePort | null;
  /**
   * Whether to automatically provision the root Director Meta-Agent if absent.
   * Defaults to `true` for default runtime, or `false` when a custom runtime is provided.
   */
  autoBootstrapDirector?: boolean | null;
  /**
   * Whether to auto-hydrate store state from LocalStorage on initialization if persisted state exists.
   * Defaults to `true` when `autoBootstrapDirector` is enabled.
   */
  autoHydrate?: boolean | null;
  /**
   * Optional additional launch bundles for this store instance (host/pipeline
   * injection): each entry extends the baked catalog (demo fixture plus the
   * embedded template bundles), and an entry whose template id matches a baked
   * bundle replaces it in place. Malformed entries are rejected at
   * construction. Tests inject isolated fixtures here; the embedded pipeline
   * bundles arrive through the baked catalog, not through this seam.
   */
  realmTemplateBundles?: readonly RealmTemplateBundle[] | null;
}

/**
 * Draft accepted by `SandboxStore.createRealm()`: the store assigns the id
 * (when absent) and the creation timestamp, so callers provide only descriptive
 * fields.
 */
export interface RealmDraft {
  /** Optional explicit registry id; a `realm_*` id is generated when absent. */
  id?: string;
  /** Non-empty display name of the Realm. */
  name: string;
  /** Optional operator description. */
  description?: string;
  /** Optional UI accent color; presentation-only. */
  color?: string;
  /** Optional template id the Realm was launched from. */
  templateId?: string;
}

/**
 * Options accepted by `SandboxStore.deleteRealm()`.
 *
 * The default (no options) deletion refuses a Realm that still carries active
 * or recycled members; `recursive: true` is the explicit operator override
 * that permanently purges those members under the operator principal before
 * the record is removed (Wave R, ticket 56ba4b9).
 */
export interface RealmDeleteOptions {
  /** Permanently purge every active/recycled member before removing the Realm. */
  readonly recursive?: boolean;
}

/**
 * One member the recursive deletion override could not purge.
 */
export interface RealmDeletionFailure {
  /** Member agent id. */
  readonly agentId: string;
  /** Which projection the member lived in when the purge was attempted. */
  readonly state: 'active' | 'recycled';
  /** Sanitized failure reason. */
  readonly reason: string;
}

/**
 * Fail-closed report attached to a failed recursive Realm deletion
 * (`ERR_STORE_REALM_DELETE_FAILED`): the record was NOT removed and the
 * failing members are listed with the members that were already purged.
 */
export interface RealmDeletionReport {
  /** Realm the deletion targeted. */
  readonly realmId: string;
  /** Whether the recursive override was requested. */
  readonly recursive: boolean;
  /** Active member ids purged before the failure was detected. */
  readonly purgedActive: readonly string[];
  /** Recycled member ids emptied before the failure was detected. */
  readonly purgedRecycled: readonly string[];
  /** Members that could not be purged (the reason the record survived). */
  readonly failures: readonly RealmDeletionFailure[];
}

/**
 * Shape of the typed `ERR_STORE_REALM_NOT_EMPTY` refusal: the known member
 * counts an operator needs to decide between termination and the recursive
 * override.
 * @internal
 */
type RealmNotRemovableError = CodedError & {
  realmId: string;
  activeMembers: number;
  recycledMembers: number;
};

/**
 * Shape of the typed `ERR_STORE_REALM_DELETE_FAILED` failure: the record
 * survived and the report describes the purge outcome.
 * @internal
 */
type RealmDeletionFailedError = CodedError & {
  realmId: string;
  report: RealmDeletionReport;
};

/**
 * Options accepted by `SandboxStore.launchRealmFromTemplate()`.
 */
export interface RealmLaunchFromTemplateOptions {
  /** Display name override; the template name is used when absent. */
  name?: string;
  /** UI accent color; omitted from the record when absent (presentation-only). */
  color?: string;
  /** Operator description override; the template description is used when absent. */
  description?: string;
  /**
   * Per-agent model-preset override keyed by template agent key; wins over the
   * spec's `modelPresetId`. Every referenced key must name a template agent and
   * every value must resolve through the owned preset catalog.
   */
  presetBindings?: Readonly<Record<string, string>>;
  /** Per-agent id override keyed by template agent key; wins over `idPattern`. */
  idOverrides?: Readonly<Record<string, string>>;
  /**
   * Legacy launch-level text input values keyed by declared input id (one
   * value per input, shared by every referencing agent). Keys must name
   * declared `text`-shape inputs and values must be strings; an explicit empty
   * string stays launch-sourced (it blocks a `required` input instead of
   * falling back to the declared default). A key naming a `files`-shape input
   * fails closed with a message directing the caller to `inputs`/`payload`.
   */
  inputValues?: Readonly<Record<string, string>>;
  /**
   * Operator-assembled supplied input values keyed by declared input id, in
   * the shape-tagged format-v2 form (`{ shape: 'text', text }` or
   * `{ shape: 'files', files }`). The explicit launch/review value wins per
   * key over an attached payload's value; supplying the same input id in both
   * `inputs` and the legacy `inputValues` fails closed (one value per input).
   */
  inputs?: RealmInputValues;
  /**
   * Optional instance payload: a format-v2 payload object (an envelope
   * carrying `formatVersion: 2`, `templateId`, `templateVersion`, and
   * `inputs`) or a legacy format-v1 hydration package, validated against the
   * effective template contract before any Realm record exists. Payload inputs
   * are the base and `inputs`/`inputValues` win per key; the payload's pinned
   * template version is compared against the effective authored template
   * version (a mismatch fails closed unless `allowVersionMismatch` explicitly
   * confirms it).
   */
  payload?: unknown;
  /**
   * Whether to apply the template's resolved placements and directives after
   * every member launches. Defaults to `true`; `false` skips both entirely
   * (launcher toggle) so the operator can seed manually afterwards.
   */
  seed?: boolean;
  /**
   * Legacy alias of {@link RealmLaunchFromTemplateOptions.payload}: the
   * instance content a hydrator produced. Supplying both `payload` and
   * `package` fails closed.
   */
  package?: unknown;
  /**
   * Explicit confirmation that a payload pinning a different template version
   * may attach: without it a version mismatch fails closed with
   * `ERR_HYDRATION_VERSION_MISMATCH`; with it the mismatch is reported as a
   * receipt warning and the launch proceeds.
   */
  allowVersionMismatch?: boolean;
  /**
   * Per-agent publishing-authority approvals (Wave U, ticket 2518510): each
   * entry approves one declared `(agentKey, authority)` pair. The pair must
   * match a declaration in the template exactly — an unknown agent key or an
   * undeclared authority rejects the launch (typed
   * `ERR_STORE_INVALID_PARAMS`); absent approval means the request is declined
   * and the launched agent simply lacks the authority. Approved grants are
   * applied under the operator principal as ordinary revocable grants recorded
   * in the registry (`listMetaAuthorityGrants`), so hydration restores them.
   */
  authorityApprovals?: readonly { agentKey: string; authority: string }[];
  /**
   * "Trust this template" override (Wave U, ticket 2518510): when `true`, the
   * exact `(agentKey, authority)` set effective for this launch is persisted as
   * this template's trust record. Later launches auto-approve only exact
   * matches of that set — a newly declared authority re-prompts — and
   * `clearTemplateAuthorityTrust(templateId)` removes the override. Trust is
   * operator intent, never authority: grants are still applied through the
   * operator grant registry.
   */
  trustAuthorities?: boolean;
  /**
   * Per-extension attach approvals (extension wave): each entry approves
   * attaching one declared template-requested extension to the Realm being
   * created. The id must match a declared `providers` request exactly — an
   * undeclared id rejects the launch with `ERR_STORE_INVALID_PARAMS`; absent
   * approval means the requested extension is not attached and rides the
   * receipt's missing-extension disclosure. Approved extensions attach only
   * when they carry a global install record; installed-and-approved extensions
   * are attached under the operator principal with the approval stamp and the
   * approved subset is recorded on the Realm record. Nothing connects: the
   * approval is recorded state only.
   */
  extensionApprovals?: readonly { extensionId: string }[];
}

/**
 * One pending instance payload (candidate) list entry, aliased from the
 * `realmCatalog` format shape for store consumers.
 */
export type PendingInstancePayloadView = PendingInstancePayload;

/**
 * Preview receipt of `SandboxStore.previewRealmTemplateImport()`: the exact
 * receipt a real import would return, computed without any mutation.
 */
export type RealmTemplateImportPreview = RealmTemplateImportReceipt & { readonly dryRun: true };

/**
 * Realm-opaque member projection carried by {@link RealmLaunchReceipt}
 * (defect 7d2c314): the normalized `AgentStateSnapshot` shape minus the
 * internal canonical `identityKey`, so an operator launch receipt never
 * carries canonical-key vocabulary. Receipt consumers use `{ id, name }` and
 * counts; exact addressing stays on the store's selection/action surfaces.
 */
export type RealmLaunchReceiptAgent = Omit<AgentStateSnapshot, 'identityKey'>;

/**
 * Successful result of `SandboxStore.launchRealmFromTemplate()`.
 */
export interface RealmLaunchReceipt {
  /** Frozen registry record created for the launch (including recorded `instance` provenance). */
  readonly realm: RealmRecord;
  /** Active member snapshots in template launch order (realm-opaque projections). */
  readonly agents: ReadonlyArray<RealmLaunchReceiptAgent>;
  /** Hydration warnings collected during launch (present only when non-empty; e.g. an allowed version mismatch). */
  readonly warnings?: readonly string[];
}

/**
 * Draft accepted by `SandboxStore.installExtension()`: the operator-supplied
 * extension identity and non-secret metadata. The store stamps `createdAt` and
 * defaults `status` to `'installed'` and `installSource` to `'operator'`.
 */
export interface ExtensionInstallInput {
  /** Host-unique extension id. */
  readonly id: string;
  /** Extension kind: MCP server or tool pack. */
  readonly kind: ExtensionKind;
  /** Optional operator-facing display name. */
  readonly displayName?: string;
  /** Transport hint the record is installed with (never dialed here). */
  readonly transportHint: ExtensionTransportHint;
  /** Optional vault credential id bound to the record (an id, never a secret). */
  readonly credentialId?: string;
  /** Optional initial status; defaults to `'installed'`. */
  readonly status?: 'installed' | 'unavailable' | 'error';
  /** Optional install source; defaults to `'operator'`. */
  readonly installSource?: 'operator' | 'template-assist';
  /** Optional operator-approved server URL. */
  readonly approvedUrl?: string;
  /** Optional non-fatal normalization findings recorded at install time. */
  readonly normalizationWarnings?: readonly string[];
}

/**
 * Audit attribution accepted by the extension mutation methods when the
 * mutation originates from a non-operator path (the M3 realm-admin port or a
 * future privileged agent path). The `actorId` is mandatory for every
 * non-operator source, so an agent-originated mutation can never be recorded
 * as an anonymous operator act (R6, meta-plane spec §4).
 */
export interface ExtensionAuditAttribution {
  /**
   * Mutation origin; defaults to `'operator'`. `'meta-realm-edit'` is the M3
   * realm-admin port path and `'privileged-agent'` is reserved for M4.
   */
  readonly source?: 'operator' | 'privileged-agent' | 'meta-realm-edit';
  /** Bare id of the acting agent; required for every non-operator source. */
  readonly actorId?: string;
}

/**
 * Options accepted by `SandboxStore.attachExtension()`: the realm-level tool
 * selection of the new attachment. Defaults to `'all'` (every tool the
 * extension provides), plus the optional audit attribution for non-operator
 * callers.
 */
export interface ExtensionAttachOptions extends ExtensionAuditAttribution {
  /** Realm-level tool selection: `'all'` or explicit sanitized call names. */
  readonly toolSelection?: 'all' | readonly string[];
}

/**
 * Options accepted by `SandboxStore.connectExtension()` /
 * `SandboxStore.reconnectExtension()`.
 */
export interface ExtensionConnectOptions {
  /**
   * Per-connection and per-request timeout budget in milliseconds; must be a
   * positive finite number when present. Omitted → the `mcpClient` default.
   */
  readonly requestTimeoutMs?: number;
}

/**
 * Lifecycle status of one live extension connection. `connecting` is a
 * session in flight, `connected` an arbitration-active catalog, `conflict` a
 * catalog that lost a call-name race (not activated), and `error` a failed or
 * dropped session.
 */
export type ExtensionConnectionStatus = 'connecting' | 'connected' | 'conflict' | 'error';

/**
 * Secret-free error projection of a failed connection attempt: a classified
 * `ERR_MCP_*` code (with the client's safe details) when the failure came from
 * the MCP client, the typed `ERR_EXTENSION_*` code of a discovery-time catalog
 * failure, otherwise the store's `ERR_STORE_EXTENSION_CONNECT_FAILED`. Never
 * carries credential material or server-controlled message text.
 */
export interface ExtensionConnectionError {
  /** Programmatic failure code. */
  readonly code: string;
  /** Optional safe machine-readable context supplied by the failure classification. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * One catalog entry of a connected extension, keyed by the sanitized
 * model-facing call name: the owning extension id plus the wire tool name and
 * the server-supplied description/input schema.
 */
export interface ExtensionConnectionCatalogEntry {
  /** Owning extension id. */
  readonly extensionId: string;
  /** Wire tool name exactly as the server advertised it. */
  readonly serverToolName: string;
  /** Optional server-supplied description. */
  readonly description?: string;
  /** Raw (deep-frozen) JSON Schema of the tool input, when supplied. */
  readonly inputSchema?: unknown;
}

/**
 * Frozen, secret-free live projection of one extension connection, consumed by
 * the UI and by tests. Catalogs are session state: the projection is rebuilt
 * on every connection-state change and is never persisted.
 */
export interface ExtensionConnectionProjection {
  /** Host-unique extension id. */
  readonly extensionId: string;
  /** Current connection lifecycle status. */
  readonly status: ExtensionConnectionStatus;
  /** Server identity from the handshake, or `null` before/without a session. */
  readonly serverInfo: McpClientServerInfo | null;
  /** Negotiated protocol revision, or `null` before/without a session. */
  readonly protocolVersion: string | null;
  /** Call name → catalog entry, or `null` when no catalog was discovered. */
  readonly catalog: Readonly<Record<string, ExtensionConnectionCatalogEntry>> | null;
  /** Intra-server shadowed tools, in server order. */
  readonly shadows: readonly { readonly callName: string; readonly serverToolName: string }[];
  /** Extension↔extension conflicts from the last arbitration; empty when active. */
  readonly conflicts: readonly ExtensionCatalogConflict[];
  /** Drift disclosure of the last reconnect, or `null` when none was computed. */
  readonly drift: ExtensionCatalogDiff | null;
  /** Secret-free failure projection, or `null` when the last attempt succeeded. */
  readonly error: ExtensionConnectionError | null;
  /** Epoch ms the catalog completed (session connected), or `null`. */
  readonly connectedAt: number | null;
  /** Epoch ms the catalog was discovered, or `null`. */
  readonly discoveredAt: number | null;
  /** Catalog digest, or `null` when no catalog was discovered. */
  readonly digest: string | null;
}

/**
 * Internal live connection record (composition-root state, never persisted).
 * `sequence` is the explicit connection-completion order the arbitration reads;
 * `pending` carries the single-flight promise while a session is connecting.
 */
type LiveExtensionConnection = {
  extensionId: string;
  status: ExtensionConnectionStatus;
  sequence: number;
  session: McpClientSession | null;
  abortController: AbortController;
  catalog: ExtensionCatalog | null;
  serverInfo: McpClientServerInfo | null;
  protocolVersion: string | null;
  conflicts: readonly ExtensionCatalogConflict[];
  drift: ExtensionCatalogDiff | null;
  error: ExtensionConnectionError | null;
  connectedAt: number | null;
  discoveredAt: number | null;
  pending: Promise<ExtensionConnectionProjection> | null;
};

/**
 * One file to seed through `SandboxStore.seedRealm()`.
 */
export interface RealmSeedFile {
  /**
   * Virtual path (absolute or relative; normalized to absolute on write).
   * Workspace-relative by contract: paths addressing the reserved `global`
   * or `public` workspace roots are rejected, never re-rooted.
   */
  readonly path: string;
  /** File content. */
  readonly content: string;
}

/**
 * Seed request accepted by `SandboxStore.seedRealm()`.
 */
export interface RealmSeedInput {
  /** Registered Realm id to seed. */
  readonly realmId: string;
  /** Non-empty list of files to write. */
  readonly files: ReadonlyArray<RealmSeedFile>;
  /**
   * Optional directive delivered to the target as an operator-attributed
   * mailbox message (the target's mail wake dispatches the turn); requires an
   * explicit `targetAgentId`.
   */
  readonly directive?: string;
  /**
   * Target member agent id; the Realm-global workspace
   * (`realm:<realmId>:global`) is used when absent.
   */
  readonly targetAgentId?: string;
}

/**
 * Receipt returned by `SandboxStore.seedRealm()`.
 */
export interface RealmSeedReceipt {
  /** Realm the seed ran against. */
  readonly realmId: string;
  /** Workspace the files were written to (Realm-global or member private). */
  readonly workspace: string;
  /** Normalized absolute paths written, in input order. */
  readonly writtenPaths: ReadonlyArray<string>;
  /** Whether an operator-attributed directive was delivered to the target. */
  readonly directiveDelivered: boolean;
}

/**
 * Receipt returned by `SandboxStore.exportRealmArchive()` (S2 realm-export
 * lane, ticket 3fe5221). `success: false` carries one of the typed codes
 * `ERR_STORE_REALM_NOT_FOUND` / `ERR_STORE_INVALID_PARAMS` /
 * `ERR_STORE_ARCHIVE_FAILED` and never throws for a read-only projection.
 */
export interface RealmArchiveExportResult {
  /** True when the archive was serialized. */
  readonly success: boolean;
  /** Archive id (present on success). */
  readonly archiveId?: string;
  /** Canonical archive JSON text (present on success). */
  readonly json?: string;
  /** Suggested download filename (present on success). */
  readonly filename?: string;
  /** Export-time completeness disclosures. */
  readonly warnings: readonly string[];
  /** Typed failure code when `success` is false. */
  readonly code?: string;
}

/**
 * One dropped-authority record of a realm archive import: the bare member id
 * plus every descriptive authority item the archive carried but import never
 * re-applied (the operator re-grants through the ordinary grant APIs).
 */
export interface RealmArchiveDroppedAuthority {
  /** Bare realm-local member id. */
  readonly memberId: string;
  /** Dropped items (`'privileged'`, `'realmBypass'`, `'*'`, exact authority ids). */
  readonly authorities: readonly string[];
}

/**
 * Receipt returned by `SandboxStore.importRealmArchive()` (S2 realm-export
 * lane, ticket 3fe5221): the fresh realm plus per-section import counters and
 * every dropped authority / disclosure. Post-validation failures throw an
 * `ERR_STORE_REALM_IMPORT_FAILED` error carrying a rollback report instead.
 */
export interface RealmArchiveImportReceipt {
  /** True when the realm slice was installed. */
  readonly success: boolean;
  /** Fresh realm id the slice was remapped onto. */
  readonly realmId: string | null;
  /** Fresh realm display name. */
  readonly realmName: string | null;
  /** Source archive id. */
  readonly archiveId: string | null;
  /** Count of imported ACTIVE members. */
  readonly membersImported: number;
  /** Count of imported recycled members. */
  readonly membersRecycled: number;
  /** Count of VFS files written. */
  readonly filesImported: number;
  /** Count of merged scheduled timers. */
  readonly schedulesImported: number;
  /** Count of realm extension attachments re-attached. */
  readonly attachmentsImported: number;
  /** Count of attachments skipped (extension not installed locally). */
  readonly attachmentsSkipped: number;
  /** True when the archive's template payload was imported. */
  readonly templateImported: boolean;
  /** Count of imported saved hydration payloads. */
  readonly payloadsImported: number;
  /** Descriptive authority items the archive carried but import never re-applied. */
  readonly droppedAuthority: readonly RealmArchiveDroppedAuthority[];
  /** Import-time disclosures (skipped attachments, wildcard drops, ...). */
  readonly warnings: readonly string[];
  /** Typed failure code reserved for receipt-shaped failure surfaces. */
  readonly code?: string;
}

/**
 * Rollback report carried by an `ERR_STORE_REALM_IMPORT_FAILED` error
 * (mirrors the realm deletion/launch rollback reports).
 */
export interface RealmArchiveImportRollbackReport {
  /** Target realm id (`null` for preflight failures before the record existed). */
  readonly realmId: string | null;
  /** Stage that failed (`vfs-preflight`, `vfs`, `template`, `payloads`, `runtime-slice`, ...). */
  readonly failedStage: string;
  /** True when every mutation was rolled back. */
  readonly rolledBack: boolean;
  /** Member ids terminated/purged by the rollback. */
  readonly terminatedMembers: readonly string[];
  /** File paths evicted by the rollback. */
  readonly evictedFiles: readonly string[];
  /** Rollback failures (best-effort steps that could not complete). */
  readonly failures: readonly string[];
}

/**
 * Outcome of one agent's persisted capability-grant reconcile inside the H1
 * reload capability heal. `'restored'` means the grant was applied,
 * `'unchanged'` that the live grant already matched (idempotent re-run),
 * `'skipped'` that the pass could not apply the grant (agent not restored, or
 * the grant needs operator authority that is not registered), and `'failed'`
 * that the runtime rejected an attempted update.
 */
export interface CapabilityHealEntry {
  /** Agent whose persisted grants were reconciled. */
  readonly agentId: string;
  /** Machine-readable outcome of the reconcile. */
  readonly outcome: 'restored' | 'unchanged' | 'skipped' | 'failed';
  /** Effective grant list the pass resolved from the persisted config. */
  readonly allowedTools: readonly string[];
  /** Machine-readable skip/failure cause, or `null` for `'restored'`/`'unchanged'`. */
  readonly reason: string | null;
}

/**
 * Observable report of the H1 reload capability heal: per-agent outcomes plus
 * aggregate counters and the pass timestamp. Published on every hydration and
 * on each manual `healRestoredCapabilities()` call; `null` when no persisted
 * grants were captured.
 */
export interface CapabilityHealReport {
  /** Epoch ms timestamp of the heal pass. */
  readonly at: number;
  /** Count of agents whose grants were applied. */
  readonly restored: number;
  /** Count of agents whose grants already matched. */
  readonly unchanged: number;
  /** Count of agents the pass could not apply (missing agent / lacking operator authority). */
  readonly skipped: number;
  /** Count of agents the runtime rejected during the pass. */
  readonly failed: number;
  /** Per-agent outcomes in persisted-snapshot order. */
  readonly entries: readonly CapabilityHealEntry[];
}

/**
 * One legacy private-workspace remap performed during hydration (Wave I,
 * ticket d57cbc1): a bare-keyed private workspace was rekeyed onto its
 * canonical realm-qualified storage key. The entry is realm-opaque by
 * construction — the legacy key and the bare agent id coincide, so only the
 * bare id is reported, never the canonical destination key.
 */
export interface LegacyWorkspaceRemapEntry {
  /** Bare realm-local agent id whose legacy private workspace was rekeyed. */
  readonly agentId: string;
  /**
   * File paths the canonical workspace already owned (the canonical bytes win
   * and the duplicate legacy path is reported, never overwritten or dropped
   * silently).
   */
  readonly mergedConflictPaths: readonly string[];
}

/**
 * Observable report of the last hydration-time legacy private-workspace remap
 * (Wave I, ticket d57cbc1). Published only when a hydration pass found legacy
 * bare-keyed private workspace bytes (or the remap could not run), so
 * remap-free sessions keep the field `null` and hydration stays silent on the
 * console during normal operation.
 */
export interface LegacyWorkspaceRemapReport {
  /** Per-workspace remaps in snapshot key order; ids are bare realm-local labels. */
  readonly remapped: readonly LegacyWorkspaceRemapEntry[];
  /** Count of legacy private workspaces rekeyed onto their canonical key. */
  readonly remappedCount: number;
  /** Total count of duplicate paths the canonical workspace already owned. */
  readonly conflictCount: number;
  /** True when the remap pass could not run (missing substrate authority or method). */
  readonly failed: boolean;
}

/**
 * Leading+trailing throttle window (ms) for mirroring high-frequency live turn
 * mutations (stream tokens, reasoning deltas) into the reactive `agents`
 * projection. Keeps in-flight UI prompt without cloning the agent list per token.
 */
const STREAM_MIRROR_THROTTLE_MS = 75;

/**
 * Fixed id of the seeded default Realm ("Generic", Wave R ticket 56ba4b9)
 * exported as the canonical engine-side home of the constant. The store seeds
 * the record at init and marks it protected in the owned registry, so removal
 * is refused on every public surface and reconciliation keeps it in place
 * (Wave R hardening, ticket 0fe25fd); the UI helper (`realmGroups.ts`) mirrors
 * the literal for its store-free projections, and the runtime's launch
 * composition mirrors it for the Generic fallback —
 * `sandbox_store_module_test` pins the UI mirror, and the runtime composition
 * is pinned behaviorally by the launch-default assertions.
 */
export const GENERIC_REALM_ID = 'realm_generic';

/** Display name of the seeded default Realm; renamable like any record. */
const GENERIC_REALM_NAME = 'Generic';

/**
 * Per-agent extension grant helpers (extension wave, P2.4). The store is the
 * trusted computer of the effective extension grant set; these pure functions
 * own the P2 semantics so launch, the safe-state sweep, and the UI helper
 * cannot disagree:
 *
 * - the **realm universe** is the Realm record's `resolvedTools` keys (the
 *   declared extension references resolved at launch, whose resolution already
 *   honored the attachment selection) filtered to extensions the Realm still
 *   attaches with an `active` status, plus the call names of every attached,
 *   active extension's live conflict-free catalog **capped by that
 *   attachment's `toolSelection`** (`'all'` keeps the whole catalog; an
 *   explicit list keeps only the listed names) — attaching a new extension
 *   adds its selected tools once connected, while detaching removes its tools;
 * - the **selector** is the per-agent `config.extensionTools` value: `'all'`
 *   (the default) selects the whole universe, an explicit list intersects it;
 * - unknown selector entries are dropped, never granted (fail closed), and
 *   reported to the caller so the store can warn.
 *
 * Authority is never derived here: the produced list feeds the trusted
 * `reauthorizeAgent`/`LaunchAgentOptions.extensionTools` channel, and the
 * descriptor's exact-membership gate remains the only capability source.
 */

/**
 * Normalizes a per-agent extension selector: `'all'` (the default for absent
 * or invalid input), or a frozen, duplicate-free list of non-empty names.
 *
 * @param value - Candidate selector.
 * @returns The normalized selector.
 */
function normalizeExtensionSelector(value: unknown): 'all' | readonly string[] {
  if (value === 'all') return 'all';
  if (!Array.isArray(value)) return 'all';
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) continue;
    if (!names.includes(entry)) names.push(entry);
  }
  return Object.freeze(names);
}

/**
 * Resolves the extension ids a Realm currently attaches with `active` status.
 *
 * @param realm - Realm record (null-safe).
 * @returns The active attachment extension ids.
 */
function resolveActiveExtensionIds(realm: RealmRecord | null): Set<string> {
  const ids = new Set<string>();
  const attachments = realm && Array.isArray(realm.extensions) ? realm.extensions : [];
  for (const attachment of attachments) {
    if (
      attachment
      && attachment.status === 'active'
      && typeof attachment.extensionId === 'string'
      && attachment.extensionId
    ) {
      ids.add(attachment.extensionId);
    }
  }
  return ids;
}

/**
 * Resolves the tool selection of every extension a Realm currently attaches
 * with `active` status: `'all'` (the whole catalog) or the frozen selection
 * list. Used by the catalog-driven grant universe so a realm-level attachment
 * selection caps what a connected catalog can contribute.
 *
 * @param realm - Realm record (null-safe).
 * @returns Active attachment extension id → normalized selection.
 */
function resolveActiveExtensionSelections(realm: RealmRecord | null): Map<string, 'all' | readonly string[]> {
  const selections = new Map<string, 'all' | readonly string[]>();
  const attachments = realm && Array.isArray(realm.extensions) ? realm.extensions : [];
  for (const attachment of attachments) {
    if (
      attachment
      && attachment.status === 'active'
      && typeof attachment.extensionId === 'string'
      && attachment.extensionId
    ) {
      selections.set(
        attachment.extensionId,
        Array.isArray(attachment.toolSelection) ? attachment.toolSelection : 'all'
      );
    }
  }
  return selections;
}

/**
 * Computes a Realm's extension tool universe: the sanitized `resolvedTools` keys
 * whose extension the Realm still attaches as `active`, in declared record
 * order, plus the call names of every attached, active extension's live
 * (conflict-free, sequence-ordered) catalog — so connecting an attached
 * extension lights up its catalog before any declared reference exists. The
 * catalog contribution is capped by the attachment's own `toolSelection`
 * (`'all'` keeps the whole catalog; an explicit list keeps only the listed
 * names), so a realm-level selection can never be widened by a connect. A
 * detached (or non-active) extension contributes no tool; a record without
 * provenance contributes none.
 *
 * @param realm - Realm record (null-safe).
 * @param liveCatalogs - Live catalogs in connection-completion sequence order
 *   (`{ extensionId, callNames }`), conflict-free only.
 * @returns The resolved-and-attached call names.
 */
function resolveRealmExtensionToolUniverse(
  realm: RealmRecord | null,
  liveCatalogs: readonly { readonly extensionId: string; readonly callNames: readonly string[] }[] = []
): string[] {
  const resolved = realm && realm.instance ? realm.instance.resolvedTools : undefined;
  const activeIds = resolveActiveExtensionIds(realm);
  const selections = resolveActiveExtensionSelections(realm);
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string): void => {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  if (resolved && typeof resolved === 'object') {
    for (const callName of Object.keys(resolved)) {
      const extensionId = resolved[callName];
      if (typeof extensionId !== 'string' || !activeIds.has(extensionId)) continue;
      push(callName);
    }
  }
  for (const catalog of liveCatalogs) {
    if (!catalog || typeof catalog.extensionId !== 'string') continue;
    const selection = selections.get(catalog.extensionId);
    if (selection === undefined) continue;
    for (const callName of catalog.callNames) {
      if (selection === 'all' || selection.includes(callName)) push(callName);
    }
  }
  return names;
}

/**
 * Intersects a per-agent selector with the Realm's extension tool universe.
 *
 * @param universe - Resolved-and-attached call names.
 * @param selector - Normalized per-agent selector.
 * @returns The effective grants (universe order) plus the selector names that
 *   matched nothing (dropped fail-closed, never granted).
 */
function computeEffectiveExtensionGrants(
  universe: readonly string[],
  selector: 'all' | readonly string[]
): { grants: readonly string[]; dropped: readonly string[] } {
  if (selector === 'all') {
    return { grants: Object.freeze([...universe]), dropped: Object.freeze([]) };
  }
  const universeSet = new Set(universe);
  const grants: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const name of selector) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (universeSet.has(name)) grants.push(name);
    else dropped.push(name);
  }
  return { grants: Object.freeze(grants), dropped: Object.freeze(dropped) };
}

/**
 * Compares two effective extension grant sets for the heal idempotence check
 * (order-insensitive; both are normalized unique name lists).
 *
 * @param current - Current descriptor grant names.
 * @param next - Candidate effective grant names.
 * @returns True when both carry exactly the same names.
 */
function extensionGrantsEqual(current: readonly string[], next: readonly string[]): boolean {
  if (current.length !== next.length) return false;
  const expected = new Set(next);
  for (const name of current) {
    if (!expected.has(name)) return false;
  }
  return true;
}

/**
 * Compares two normalized per-agent extension selectors (order-insensitive for
 * explicit lists).
 *
 * @param a - One normalized selector.
 * @param b - The other normalized selector.
 * @returns True when both select the same names (or both are `'all'`).
 */
function extensionSelectorsEqual(
  a: 'all' | readonly string[],
  b: 'all' | readonly string[]
): boolean {
  if (a === 'all' || b === 'all') return a === b;
  return extensionGrantsEqual(a, b);
}

/**
 * Classifies one operational connection failure into the secret-free
 * projection shape: a classified `McpClientError` keeps its `ERR_MCP_*` code
 * and safe details; anything else maps to the store's unclassified
 * `ERR_STORE_EXTENSION_CONNECT_FAILED` (no message text is ever propagated).
 *
 * @param error - Thrown value from the connection attempt.
 * @returns Frozen secret-free error projection.
 */
function classifyExtensionConnectError(error: unknown): ExtensionConnectionError {
  if (error instanceof McpClientError) {
    return Object.freeze({
      code: error.code,
      ...(error.details !== undefined ? { details: Object.freeze({ ...error.details }) } : {})
    });
  }
  if (error instanceof ExtensionRegistryError) {
    // A discovery-time catalog failure (for example a reserved derived call
    // name) keeps its typed registry code; the message stays out of the
    // projection.
    return Object.freeze({ code: error.code });
  }
  return Object.freeze({ code: SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_CONNECT_FAILED });
}

/**
 * Whether a reconnect drift diff carries a disclosure: any added/removed/
 * changed/shadow call name or a common-name reorder. Digest-only changes are
 * already covered, since a canonical tool change lands in `changed`.
 *
 * @param diff - Drift diff.
 * @returns `true` when the diff must be disclosed.
 */
function extensionCatalogDiffIsEmpty(diff: ExtensionCatalogDiff): boolean {
  return diff.added.length === 0
    && diff.removed.length === 0
    && diff.changed.length === 0
    && diff.shadowedAdded.length === 0
    && diff.shadowedRemoved.length === 0
    && !diff.reordered;
}

/**
 * Redacts credential-shaped substrings from diagnostic error text and caps its
 * length so UI surfaces never render secrets or raw provider payloads.
 * Mirrored by the persistence-layer redactor in `sandboxPersistence`; keep
 * both implementations behaviorally identical.
 *
 * @param value - Error message or thrown value.
 * @param maxLength - Maximum retained characters (defaults to `320`).
 * @returns Sanitized single-line diagnostic string ('' when empty).
 */
function sanitizeDiagnosticError(value: unknown, maxLength: number = 320): string {
  if (value === null || value === undefined) return '';
  const candidate = value as { message?: unknown } | null | undefined;
  let text = typeof value === 'string' ? value : String(candidate?.message || value);
  text = text.replace(/[\r\n\t]+/g, ' ').trim();
  text = text.replace(/(bearer\s+)[a-z0-9._~+/=-]{8,}/gi, '$1[redacted]');
  text = text.replace(/(authorization|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|password|token|bearer|kek)\s*[:=]\s*["']?[^\s"',;}\]]+/gi, '$1=[redacted]');
  text = text.replace(/\b(sk|gsk|xai|pk|api|key)[-_][A-Za-z0-9_-]{12,}\b/g, '[redacted]');
  text = text.replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted]');
  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength).trimEnd()}…`;
  }
  return text;
}

/**
 * Reads the `message` field of an unknown thrown value with the legacy
 * `err.message` access semantics: `undefined` for values without such a field.
 *
 * @param value - Caught or surfaced thrown value.
 * @returns The raw `message` field when present.
 */
function thrownMessageField(value: unknown): unknown {
  return (value as { message?: unknown } | null | undefined)?.message;
}

/**
 * Resolves a non-empty string `message` from an unknown thrown value, falling
 * back to the supplied text — the behavior the store previously obtained from
 * the `err.message || fallback` idiom.
 *
 * @param value - Caught or surfaced thrown value.
 * @param fallback - Text used when no non-empty string message is present.
 * @returns Human-readable diagnostic text.
 */
function thrownMessage(value: unknown, fallback: string): string {
  const message = thrownMessageField(value);
  return typeof message === 'string' && message ? message : fallback;
}

/**
 * Sanitizes a caller launch configuration before it reaches the runtime
 * (Wave I, ticket c02d0b9):
 * - a `realmBypass` claim is stripped — the grant is an explicit operator
 *   action through `grantRealmBypass`, never a spawn field;
 * - an explicit `realmId: null` is dropped so composition falls through to the
 *   Generic default — the null system scope is the engine bootstrap's, never a
 *   user launch choice.
 *
 * Returns the input reference when neither key needs removal.
 *
 * @param config - Caller launch configuration.
 * @returns Launch configuration without a `realmBypass` or system-scope claim.
 */
function sanitizeLaunchConfig(config: AgentConfig): AgentConfig {
  const hasBypassClaim = 'realmBypass' in (config as object);
  const hasSystemScopeClaim = (config as { realmId?: unknown }).realmId === null;
  if (!hasBypassClaim && !hasSystemScopeClaim) return config;
  const copy = { ...(config as AgentConfig & { realmBypass?: unknown; realmId?: string | null }) };
  delete copy.realmBypass;
  if (copy.realmId === null) delete copy.realmId;
  return copy;
}

/**
 * Resolves the runtime delegation ref for an operator `realmBypass`
 * grant/revoke (Wave I, ticket d57cbc1; fix lane F3).
 *
 * A realm-exact scope (`{ realmId }`, `null` = the bootstrap-only system
 * scope) composes the target's canonical `(realmId, agentId)` identity key, so
 * the runtime setter mutates exactly that registration — never another
 * Realm's same-id agent. Every other scope form (omitted, or a
 * `{ realmBypass: true }` unique-match scope) keeps the legacy bare ref, and a
 * canonical identity key passed as the id is forwarded unchanged for exact
 * resolution. The store stays realm-opaque on agent-facing surfaces: the
 * composed key is internal delegation state only.
 *
 * @param agentId - Trimmed bare realm-local id or canonical identity key.
 * @param scope - Optional trusted resolution scope.
 * @returns The delegation ref handed to the runtime.
 */
function resolveRealmBypassTargetRef(agentId: string, scope?: AgentIdentityScope): string {
  if (!scope || typeof scope !== 'object' || scope.realmBypass === true || !('realmId' in scope)) {
    return agentId;
  }
  return createAgentIdentityKey(scope.realmId, agentId);
}

/**
 * Deep-freezes a copy of one registry-side authority scope for the operator
 * projection (ticket 62d89b8): the record object and every list array are
 * copies, so nothing the caller receives aliases registry state. Unknown keys
 * are dropped exactly like the grant-core validator's normalized shape.
 *
 * @param scope - Registry-side scope record (trusted runtime state).
 * @returns A deep-frozen copy carrying only the schema's known keys.
 */
function freezeAuthorityScopeCopy(scope: AuthorityScopeRecord): AuthorityScopeRecord {
  const copy: {
    targets?: readonly string[];
    ownSpawns?: boolean;
    realmMembers?: boolean;
    realms?: readonly string[];
    fields?: readonly string[];
  } = {};
  if (Array.isArray(scope.targets)) copy.targets = Object.freeze(scope.targets.slice());
  if (typeof scope.ownSpawns === 'boolean') copy.ownSpawns = scope.ownSpawns;
  if (typeof scope.realmMembers === 'boolean') copy.realmMembers = scope.realmMembers;
  if (Array.isArray(scope.realms)) copy.realms = Object.freeze(scope.realms.slice());
  if (Array.isArray(scope.fields)) copy.fields = Object.freeze(scope.fields.slice());
  return Object.freeze(copy) as AuthorityScopeRecord;
}

/**
 * Structural guard for a MOD-20 catalog preset loaded from a persisted
 * snapshot: non-empty string `id`/`name`, boolean `isCustom`, and a
 * `modelConfig` object with non-empty string `providerId`/`modelId`.
 *
 * @param value - Candidate preset value from persisted storage.
 * @returns True when the value round-trips as a catalog preset.
 */
function isModelPresetShape(value: unknown): value is ModelPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const preset = value as { id?: unknown; name?: unknown; isCustom?: unknown; modelConfig?: unknown };
  if (typeof preset.id !== 'string' || !preset.id.trim()) return false;
  if (typeof preset.name !== 'string' || !preset.name.trim()) return false;
  if (typeof preset.isCustom !== 'boolean') return false;
  const modelConfig = preset.modelConfig;
  if (!modelConfig || typeof modelConfig !== 'object' || Array.isArray(modelConfig)) return false;
  const config = modelConfig as { providerId?: unknown; modelId?: unknown };
  return typeof config.providerId === 'string' && config.providerId.trim().length > 0
    && typeof config.modelId === 'string' && config.modelId.trim().length > 0;
}

/**
 * Copies a catalog preset entry into a plain snapshot record so persisted
 * state never aliases a catalog-internal reference.
 *
 * @param preset - Catalog preset entry.
 * @returns Fresh plain preset record.
 */
function cloneModelPreset(preset: ModelPreset): ModelPreset {
  return {
    id: preset.id,
    name: preset.name,
    isCustom: preset.isCustom,
    modelConfig: { ...preset.modelConfig }
  };
}

/**
 * Structural guard for a Realm record loaded from a persisted snapshot:
 * non-empty string `id`/`name`, a finite numeric `createdAt`, and optional
 * `description`/`color`/`templateId` fields that are strings when present.
 *
 * @param value - Candidate realm value from persisted storage.
 * @returns True when the value round-trips as a registry realm record.
 */
function isRealmRecordShape(value: unknown): value is RealmRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const realm = value as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    color?: unknown;
    templateId?: unknown;
    createdAt?: unknown;
  };
  if (typeof realm.id !== 'string' || !realm.id.trim()) return false;
  if (typeof realm.name !== 'string' || !realm.name.trim()) return false;
  if (typeof realm.createdAt !== 'number' || !Number.isFinite(realm.createdAt)) return false;
  for (const field of ['description', 'color', 'templateId'] as const) {
    const candidate = realm[field];
    if (candidate !== undefined && typeof candidate !== 'string') return false;
  }
  return true;
}

/**
 * Structural guard for a persisted Realm launch-provenance value (Wave T,
 * ticket 0df20ae): non-empty string `templateId`/`templateVersion`/
 * `launchedAt`, a string-valued `inputHashes` record, a string `seedPaths`
 * array, and optional non-empty `packageDigest` / string-valued
 * `resolvedTools` / non-empty-string `missingExtensions`.
 *
 * @param value - Candidate provenance value from persisted storage.
 * @returns True when the value round-trips as provenance metadata.
 */
function isRealmInstanceProvenanceShape(value: unknown): value is RealmInstanceProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const instance = value as Record<string, unknown>;
  for (const field of ['templateId', 'templateVersion', 'launchedAt']) {
    const candidate = instance[field];
    if (typeof candidate !== 'string' || !candidate.trim()) return false;
  }
  const inputHashes = instance.inputHashes;
  if (!inputHashes || typeof inputHashes !== 'object' || Array.isArray(inputHashes)) return false;
  if (Object.values(inputHashes).some((hash) => typeof hash !== 'string')) return false;
  if (!Array.isArray(instance.seedPaths) || instance.seedPaths.some((path) => typeof path !== 'string')) return false;
  if (instance.packageDigest !== undefined
    && (typeof instance.packageDigest !== 'string' || !instance.packageDigest.trim())) return false;
  const resolvedTools = instance.resolvedTools;
  if (resolvedTools !== undefined) {
    if (!resolvedTools || typeof resolvedTools !== 'object' || Array.isArray(resolvedTools)) return false;
    if (Object.values(resolvedTools).some((binding) => typeof binding !== 'string')) return false;
  }
  const missingExtensions = instance.missingExtensions;
  if (missingExtensions !== undefined) {
    if (!Array.isArray(missingExtensions)) return false;
    if (missingExtensions.some((id) => typeof id !== 'string' || !id.trim())) return false;
  }
  return true;
}

/**
 * Copies a Realm launch-provenance record into a plain snapshot record
 * (nested maps/arrays fresh) so persisted state never aliases a
 * registry-internal reference.
 *
 * @param instance - Valid provenance record.
 * @returns Fresh plain provenance record.
 */
function cloneRealmInstanceProvenance(instance: RealmInstanceProvenance): RealmInstanceProvenance {
  return {
    templateId: instance.templateId,
    templateVersion: instance.templateVersion,
    ...(instance.packageDigest !== undefined ? { packageDigest: instance.packageDigest } : {}),
    inputHashes: { ...instance.inputHashes },
    seedPaths: [...instance.seedPaths],
    launchedAt: instance.launchedAt,
    ...(instance.resolvedTools !== undefined ? { resolvedTools: { ...instance.resolvedTools } } : {}),
    ...(instance.missingExtensions !== undefined ? { missingExtensions: [...instance.missingExtensions] } : {})
  };
}

/**
 * Copies a Realm extension-attachment list into plain snapshot records,
 * dropping malformed entries (attachments are descriptive metadata; a
 * malformed entry never invalidates the Realm record).
 *
 * @param extensions - Registry attachment list.
 * @returns Fresh plain attachment records.
 */
function cloneRealmExtensions(
  extensions: readonly RealmExtensionAttachment[]
): readonly RealmExtensionAttachment[] {
  const cloned: RealmExtensionAttachment[] = [];
  for (const candidate of extensions) {
    const attachment = normalizeRealmExtensionAttachment(candidate);
    if (attachment) cloned.push(attachment);
  }
  return Object.freeze(cloned);
}

/**
 * Copies one global extension install record into a plain snapshot record
 * (nested hint/warnings fresh) so the snapshot mirror never aliases a
 * registry-internal reference.
 *
 * @param record - Registry install record.
 * @returns Fresh plain install record.
 */
function cloneExtensionInstallRecord(record: ExtensionInstallRecord): ExtensionInstallRecord {
  const hint = record.transportHint;
  const transportHint: ExtensionTransportHint = hint.kind === 'http'
    ? { kind: 'http', url: hint.url }
    : hint.kind === 'stdio'
      ? { kind: 'stdio', command: hint.command, ...(hint.args !== undefined ? { args: [...hint.args] } : {}) }
      : { kind: 'pack', source: hint.source };
  return {
    id: record.id,
    kind: record.kind,
    ...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
    transportHint,
    ...(record.credentialId !== undefined ? { credentialId: record.credentialId } : {}),
    status: record.status,
    installSource: record.installSource,
    ...(record.approvedUrl !== undefined ? { approvedUrl: record.approvedUrl } : {}),
    ...(record.normalizationWarnings !== undefined
      ? { normalizationWarnings: [...record.normalizationWarnings] }
      : {}),
    createdAt: record.createdAt
  };
}

/**
 * Copies a Realm record into a plain snapshot record so persisted state never
 * aliases a registry-internal reference; absent optional fields stay absent.
 * A malformed `instance` provenance block or malformed attachment entries are
 * dropped (provenance and attachments are descriptive metadata, never
 * identity) while the Realm record survives.
 *
 * @param realm - Registry realm record.
 * @returns Fresh plain realm record.
 */
function cloneRealmRecord(realm: RealmRecord): RealmRecord {
  return {
    id: realm.id,
    name: realm.name,
    ...(realm.description !== undefined ? { description: realm.description } : {}),
    ...(realm.color !== undefined ? { color: realm.color } : {}),
    ...(realm.templateId !== undefined ? { templateId: realm.templateId } : {}),
    ...(realm.instance !== undefined && isRealmInstanceProvenanceShape(realm.instance)
      ? { instance: cloneRealmInstanceProvenance(realm.instance) }
      : {}),
    ...(realm.extensions !== undefined ? { extensions: cloneRealmExtensions(realm.extensions) } : {}),
    createdAt: realm.createdAt
  };
}

/**
 * Resolves an agent's Realm membership with the same trim semantics as the
 * realm grouping/resolution used by the UI (`resolveAgentRealmId` in
 * `realmGroups.ts`): a trimmed non-empty `config.realmId`, otherwise `null`.
 * Deletion member counting uses this resolver, so a hydrated
 * `'  realm_x  '` membership can never be missed while grouping renders it
 * under `realm_x` (Wave R hardening, ticket 0fe25fd).
 *
 * @param agent - Agent snapshot (active or recycled) or structural equivalent.
 * @returns Trimmed membership id, or `null` when absent/blank.
 */
function resolveMemberRealmId(
  agent: { readonly config?: { readonly realmId?: string | null } | null } | null | undefined
): string | null {
  const value = agent && agent.config ? agent.config.realmId : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * O(1) view of the authority-id vocabulary (`AUTHORITY_IDS`): the realm-admin
 * member projection never surfaces a grant id as a baked tool, and the patch
 * scanner treats every id as reserved operator vocabulary.
 */
const AUTHORITY_ID_SET: ReadonlySet<string> = new Set(AUTHORITY_IDS);

/**
 * Realm-partition masking patterns mirrored from the M2 descriptor mask
 * (`tools/descriptors/lifecycleTools.ts`): `realm:<id>:global` renders as
 * `global` and every other key carrying internal realm/system vocabulary
 * (`realm:`, the `system:` prefix, the seeded `realm_generic` id) is withheld,
 * so an operator-pinned internal-shaped workspace key is never surfaced.
 * Mirrored rather than imported so the composition root keeps its narrow
 * surface imports.
 */
const REALM_GLOBAL_WORKSPACE_PATTERN = /^realm:.+:global$/;
const INTERNAL_ID_VOCABULARY_PATTERN = /realm:|^system:/;
const SEEDED_GENERIC_REALM_ID = 'realm_generic';

/** Maps one internal workspace key onto its realm-opaque agent-visible label. */
function toAgentVisibleWorkspaceKey(value: string | null): string | null {
  if (!value) return null;
  if (REALM_GLOBAL_WORKSPACE_PATTERN.test(value)) return 'global';
  if (carriesInternalRealmVocabulary(value)) return null;
  return value;
}

/** Reports whether an identifier carries internal realm/system vocabulary. */
function carriesInternalRealmVocabulary(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  return INTERNAL_ID_VOCABULARY_PATTERN.test(value) || value === SEEDED_GENERIC_REALM_ID;
}

/** Projects one internal agent reference onto its realm-opaque bare id. */
function toAgentVisibleAgentReference(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('realm:')) {
    const rest = value.slice('realm:'.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) return null;
    try {
      const agentId = decodeURIComponent(rest.slice(separator + 1));
      return agentId && !carriesInternalRealmVocabulary(agentId) ? agentId : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith('system:')) return null;
  return carriesInternalRealmVocabulary(value) ? null : value;
}

/**
 * Uniform realm-admin denials (M3; meta-plane spec §1.4): one static receipt
 * per operation for every resolution failure (missing actor record, missing
 * grant, unknown/ambiguous/out-of-scope label), plus a distinct static bound
 * denial for field-token violations. None of them echoes target state, realm
 * ids, canonical keys, or capability values.
 */
const REALM_ADMIN_INSPECT_DENIED_MESSAGE = 'Realm inspection is not permitted for the requested realm.';
const REALM_ADMIN_EDIT_DENIED_MESSAGE = 'The requested realm edit is not permitted for the requested realm.';
const REALM_ADMIN_EDIT_BOUND_DENIED_MESSAGE = 'The requested realm edit is not permitted for the requested fields.';
const EXTENSIONS_ADMIN_DENIED_MESSAGE = 'Extension administration is not permitted for the requested realm.';

/**
 * Builds one coded store error for the realm-admin port path (the dispatcher
 * maps the code onto the tool-system vocabulary).
 */
function realmAdminCodedError(message: string, code: string): Error & { code?: string } {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

/**
 * Tests whether one sanitized realm patch key is operator-only: the shared
 * `REALM_ADMIN_DENIED_PATCH_KEYS` vocabulary plus every exact authority id.
 */
function isDeniedRealmAdminPatchKey(key: string): boolean {
  if (REALM_ADMIN_DENIED_PATCH_KEYS.includes(key)) return true;
  return AUTHORITY_ID_SET.has(key);
}

/** Accepted nested key set of the `attach` patch container (closed at depth). */
const REALM_ADMIN_ATTACH_KEYS: ReadonlySet<string> = new Set<string>(['extensionId', 'toolSelection']);

/** Accepted nested key set of the `toolSelection` patch container (closed at depth). */
const REALM_ADMIN_TOOL_SELECTION_KEYS: ReadonlySet<string> = new Set<string>(['extensionId', 'selection']);

/**
 * Re-validates the `attach` / `toolSelection` patch containers at depth
 * (tool-boundary parity, spec AC-M3-04/§1.4): an operator-only nested key
 * throws the uniform bound denial, an unknown nested key throws
 * `INVALID_ARGUMENTS` — never silently dropped by the known-key reads below.
 * Malformed container shapes are left to the value validation that follows.
 *
 * @param patch - Caller-supplied patch record.
 * @throws `Error` - Code `'PERMISSION_DENIED'` or `'INVALID_ARGUMENTS'`.
 */
function assertRealmAdminNestedPatchKeys(patch: Record<string, unknown>): void {
  const containers: Array<{ value: unknown; allowed: ReadonlySet<string> }> = [];
  if (patch.attach !== undefined) {
    containers[containers.length] = { value: patch.attach, allowed: REALM_ADMIN_ATTACH_KEYS };
  }
  if (patch.toolSelection !== undefined) {
    containers[containers.length] = { value: patch.toolSelection, allowed: REALM_ADMIN_TOOL_SELECTION_KEYS };
  }
  // Denied presence across both containers first, exactly like the top-level
  // scan: the uniform bound denial wins over unknown-key reporting.
  for (let i = 0; i < containers.length; i++) {
    const value = containers[i].value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const nestedKeys = Object.keys(value as Record<string, unknown>);
    for (let j = 0; j < nestedKeys.length; j++) {
      if (isDeniedRealmAdminPatchKey(nestedKeys[j])) {
        throw realmAdminCodedError(REALM_ADMIN_EDIT_BOUND_DENIED_MESSAGE, 'PERMISSION_DENIED');
      }
    }
  }
  for (let i = 0; i < containers.length; i++) {
    const value = containers[i].value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const nestedKeys = Object.keys(value as Record<string, unknown>);
    for (let j = 0; j < nestedKeys.length; j++) {
      if (!containers[i].allowed.has(nestedKeys[j])) {
        throw realmAdminCodedError('update_realm does not accept unknown fields.', 'INVALID_ARGUMENTS');
      }
    }
  }
}

/**
 * Normalizes one realm tool-ceiling selection: `'all'` or a frozen non-empty
 * deduplicated list of call names. Shape violations throw `INVALID_ARGUMENTS`
 * (the store methods wrap them in the store error vocabulary).
 */
function normalizeRealmAdminSelection(value: unknown): 'all' | readonly string[] {
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.length === 0) {
    throw realmAdminCodedError("The tool selection must be 'all' or a non-empty array of call names.", 'INVALID_ARGUMENTS');
  }
  const names: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (typeof entry !== 'string' || !entry.trim()) {
      throw realmAdminCodedError("The tool selection must be 'all' or a non-empty array of call names.", 'INVALID_ARGUMENTS');
    }
    const name = entry.trim();
    if (names.includes(name)) {
      throw realmAdminCodedError('The tool selection carries duplicate call names.', 'INVALID_ARGUMENTS');
    }
    names[names.length] = name;
  }
  return Object.freeze(names);
}

/**
 * Generates a registry-unique realm id: UUID-based when `crypto.randomUUID` is
 * available, otherwise an epoch plus random suffix.
 *
 * @returns Fresh `realm_*` identifier.
 */
function generateRealmId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `realm_${crypto.randomUUID()}`;
  }
  return `realm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Baked launch bundles available to `SandboxStore.launchRealmFromTemplate()`.
 *
 * The catalog module owns baked content (schema + embedded bundles): the
 * `realmCatalog` demo fixture first, then the embedded `templates/**` bundles
 * generated by the content pipeline (`scripts/embed_realm_content.mjs`), which
 * the catalog exposes through {@link BAKED_TEMPLATE_BUNDLES}. This store
 * registers exactly that baked catalog and layers per-instance injection on top
 * through {@link SandboxStoreOptions.realmTemplateBundles}; the picker
 * (`listRealmTemplates`) and bundle reads (`getRealmTemplateBundle`) share the
 * same source.
 */
const BAKED_REALM_TEMPLATE_BUNDLES: readonly RealmTemplateBundle[] = BAKED_TEMPLATE_BUNDLES;

/**
 * Validates and freezes the effective launch-bundle catalog: the baked catalog
 * first, then any per-instance injection (an injected entry whose template id
 * matches an existing bundle replaces it in place).
 *
 * The bundle container is validated here (template id, file map shape) and
 * every template is normalized once (format v1 through the read shim, format
 * v2 directly) so a malformed host injection fails at construction instead of
 * surfacing on a later picker/launch read; the authored template itself stays
 * on the internal bundle (export, versioning, and the publishing port use it),
 * while the normalized view feeds exposure and launch.
 *
 * @param extra - Per-instance bundles from the store options.
 * @returns Frozen effective bundle catalog.
 * @throws `TypeError` - When an injected entry is malformed or its template cannot be normalized.
 */
function resolveRealmTemplateBundles(
  extra: readonly RealmTemplateBundle[] | null | undefined
): readonly RealmTemplateBundle[] {
  if (extra === undefined || extra === null) {
    for (const bundle of BAKED_REALM_TEMPLATE_BUNDLES) resolveTemplateBundleView(bundle);
    return BAKED_REALM_TEMPLATE_BUNDLES;
  }
  if (!Array.isArray(extra)) {
    throw new TypeError('realmTemplateBundles must be an array of template bundles');
  }
  const byId: Map<string, RealmTemplateBundle> = new Map();
  for (const bundle of [...BAKED_REALM_TEMPLATE_BUNDLES, ...extra]) {
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
      throw new TypeError('realmTemplateBundles entries must be { template, files } objects');
    }
    const template = bundle.template;
    if (!template || typeof template !== 'object' || typeof template.id !== 'string' || !template.id.trim()) {
      throw new TypeError('realmTemplateBundles entries must carry a template with a non-empty string id');
    }
    const files = bundle.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      throw new TypeError(`realmTemplateBundles['${template.id}'].files must be a record of bundle path to string`);
    }
    for (const key of Object.keys(files)) {
      if (typeof (files as Record<string, unknown>)[key] !== 'string') {
        throw new TypeError(`realmTemplateBundles['${template.id}'].files['${key}'] must be a string`);
      }
    }
    const frozen = Object.freeze({ template, files: Object.freeze({ ...files }) });
    try {
      resolveTemplateBundleView(frozen);
    } catch (error) {
      throw new TypeError(
        `realmTemplateBundles['${template.id}'].template is not a valid format-v1/v2 template: `
        + `${error instanceof Error ? error.message : String(error)}`
      );
    }
    byId.set(template.id, frozen);
  }
  return Object.freeze([...byId.values()]);
}

/**
 * Per-bundle serialized size cap for runtime template imports (Wave T, ticket
 * 0df20ae, decision 3.4): the canonical transport JSON text of one imported
 * bundle may not exceed 2 MiB. Content-heavy templates stay file/package
 * transport; an oversized import fails closed with
 * `ERR_STORE_TEMPLATE_TOO_LARGE` before anything is mutated.
 */
export const REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES: number = 2 * 1024 * 1024;

/**
 * Total serialized size cap across every runtime template import for one
 * store (Wave T, ticket 0df20ae, decision 3.4): the summed canonical transport
 * JSON text may not exceed 3 MiB, so imports cannot crowd the shared
 * localStorage snapshot quota. Enforced at import (and re-checked
 * defensively on hydration); violations fail closed with
 * `ERR_STORE_TEMPLATE_TOO_LARGE`.
 */
export const REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES: number = 3 * 1024 * 1024;

/**
 * UTF-8 byte length of a string, computed without platform APIs so the size
 * caps are identical in every runtime (the same accounting
 * `realmCatalog`'s bundle version uses).
 *
 * @param text - Source text.
 * @returns The UTF-8 byte length.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Renders a JSON-safe value with recursively sorted object keys and no
 * insignificant whitespace — the canonical form a hydration package is hashed
 * in for instance provenance (`packageDigest`). Only used for hashing, never
 * for transport (the catalog owns canonical bundle transport).
 *
 * @param value - JSON-safe value.
 * @returns Deterministic canonical JSON text.
 */
function canonicalJsonForDigest(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonForDigest(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonForDigest(record[key])}`).join(',')}}`;
}

/**
 * Module-level cache of computed bundle content versions. Bundles are frozen
 * plain data, so a version is stable for the object's lifetime; caching keeps
 * the launcher's source labels cheap even for multi-megabyte imports.
 */
const realmTemplateVersionCache: WeakMap<object, string> = new WeakMap();

/**
 * Module-level cache of normalized bundle views keyed by the internal authored
 * bundle object. Normalization validates the whole template (the v1 read shim
 * included) and is deterministic, so the view is stable for the bundle's
 * lifetime; caching keeps picker/launch reads from re-validating large
 * templates.
 */
const realmTemplateViewCache: WeakMap<object, RealmTemplateBundleView> = new WeakMap();

/**
 * Resolves the normalized exposure view of an authored bundle: the format-v2
 * template (`normalizeTemplate` — a format-v1 bundle goes through the read
 * shim) plus the authored file map.
 *
 * @param bundle - Authored bundle to normalize.
 * @returns The frozen normalized view.
 * @throws `Error` - When the bundle template is not a valid format-v1/v2 template.
 */
function resolveTemplateBundleView(bundle: RealmTemplateBundle): RealmTemplateBundleView {
  const cached = realmTemplateViewCache.get(bundle);
  if (cached !== undefined) return cached;
  const view: RealmTemplateBundleView = Object.freeze({
    // Top-level freeze so callers can never replace the exposed declaration
    // sets; nested author data is the authored bundle's (deep-frozen for baked
    // and parsed/imported bundles).
    template: Object.freeze(normalizeTemplate(bundle.template)),
    files: bundle.files
  });
  realmTemplateViewCache.set(bundle, view);
  return view;
}

/**
 * Resolves a shipped bundle's authored-form content version
 * (`templateBundleVersion` over the authored template + files), caching the
 * result per bundle object. Imported bundles carry their parsed authored pin
 * (passed as `pinnedVersion`) and are never re-hashed. A malformed
 * host-injected bundle cannot be versioned yet; the label reports `null`
 * instead of throwing.
 *
 * @param bundle - Authored bundle to version.
 * @param pinnedVersion - The import's parsed authored version, when known.
 * @returns The canonical `sha256:<hex>` version, or `null` when uncomputable.
 */
function resolveTemplateBundleVersion(bundle: RealmTemplateBundle, pinnedVersion?: string): string | null {
  if (pinnedVersion !== undefined) return pinnedVersion;
  const cached = realmTemplateVersionCache.get(bundle);
  if (cached !== undefined) return cached;
  try {
    const version = templateBundleVersion({ template: bundle.template, files: bundle.files });
    realmTemplateVersionCache.set(bundle, version);
    return version;
  } catch {
    return null;
  }
}

/**
 * Resolves the effective launch catalog: shipped (build/host) bundles first,
 * then runtime imports, replacing in place by template id. Re-importing an id
 * replaces its previous import, so every id resolves to exactly one effective
 * entry; a deleted import reveals the shipped revision at its original
 * position.
 *
 * @param shipped - Frozen build/host catalog for this store instance.
 * @param imported - Runtime imports in import order (one entry per id).
 * @returns Frozen effective catalog.
 */
function resolveEffectiveRealmTemplateBundles(
  shipped: readonly RealmTemplateBundle[],
  imported: readonly RealmTemplateBundle[]
): readonly RealmTemplateBundle[] {
  const byId: Map<string, RealmTemplateBundle> = new Map();
  const order: string[] = [];
  for (const bundle of [...shipped, ...imported]) {
    const id = bundle.template.id;
    if (!byId.has(id)) order.push(id);
    byId.set(id, bundle);
  }
  return Object.freeze(order.map((id) => byId.get(id) as RealmTemplateBundle));
}

/**
 * Hashes launch input values for instance provenance: one `sha256:<hex>`
 * content hash per supplied input id over the canonical JSON of the tagged
 * value (sorted keys, no insignificant whitespace; declared inputs only, as
 * validated by the launch/payload paths), keyed in sorted order. Raw values
 * never reach the provenance record.
 *
 * @param values - Effective supplied input values, or `undefined` when none.
 * @returns Frozen id → hash record (empty when no values were supplied).
 */
function hashRealmInputValues(
  values: RealmInputValues | undefined
): Readonly<Record<string, string>> {
  const hashes: Record<string, string> = {};
  if (!values) return Object.freeze(hashes);
  for (const key of Object.keys(values).sort()) {
    hashes[key] = hashText(canonicalJsonForDigest(values[key]));
  }
  return Object.freeze(hashes);
}

/**
 * Structural validation of the operator-supplied explicit input values — the
 * shape-tagged `inputs` option and the legacy `inputValues` string record —
 * against the normalized template declarations. Store-level argument errors
 * fail with `ERR_STORE_INVALID_PARAMS`; the shape-tagged values are then
 * re-validated by `validatePayload` through the launch's single payload
 * validation path.
 *
 * Rules: every key must name a declared input; the legacy record may only fill
 * `text`-shape inputs (a `files` declaration fails closed with a message
 * directing the caller to `inputs`/`payload`); shape-tagged values must match
 * the declaration's shape (exactly one of `{ shape: 'text', text }` /
 * `{ shape: 'files', files }`); and one input id may not be supplied through
 * both records.
 *
 * @param template - Normalized effective template.
 * @param inputs - Shape-tagged supplied values, or `undefined`.
 * @param inputValues - Legacy string-valued supplied values, or `undefined`.
 * @returns A fresh shape-tagged record, or `undefined` when neither was supplied.
 * @throws Error with code `'ERR_STORE_INVALID_PARAMS'` when a key, value, shape, or duplicate is invalid.
 */
function resolveExplicitInputValues(
  template: RealmTemplate,
  inputs: unknown,
  inputValues: unknown
): RealmInputValues | undefined {
  if (inputs === undefined && inputValues === undefined) return undefined;
  const declarations: ReadonlyMap<string, RealmTemplateInput> = new Map(
    (template.inputs ?? []).map((declaration) => [declaration.id, declaration] as const)
  );
  const resolved: Record<string, RealmInputValue> = {};

  if (inputValues !== undefined) {
    if (!inputValues || typeof inputValues !== 'object' || Array.isArray(inputValues)) {
      throw invalidRealmParams('launchRealmFromTemplate inputValues must be a record of input id to string');
    }
    const record = inputValues as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const declaration = declarations.get(key);
      if (!declaration) {
        throw invalidRealmParams(`launchRealmFromTemplate inputValues names unknown input '${key}'`);
      }
      if (declaration.shape !== 'text') {
        throw invalidRealmParams(
          `launchRealmFromTemplate inputValues['${key}'] targets files input '${key}' — `
          + "string inputValues fill text inputs only; pass the fileset through inputs (or a payload) as { shape: 'files', files: [...] }"
        );
      }
      const value = record[key];
      if (typeof value !== 'string') {
        throw invalidRealmParams(`launchRealmFromTemplate inputValues['${key}'] must be a string`);
      }
      resolved[key] = { shape: 'text', text: value };
    }
  }

  if (inputs !== undefined) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
      throw invalidRealmParams('launchRealmFromTemplate inputs must be a record of input id to shape-tagged values');
    }
    const record = inputs as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const declaration = declarations.get(key);
      if (!declaration) {
        throw invalidRealmParams(`launchRealmFromTemplate inputs names unknown input '${key}'`);
      }
      if (Object.prototype.hasOwnProperty.call(resolved, key)) {
        throw invalidRealmParams(
          `launchRealmFromTemplate input '${key}' was supplied through both inputs and inputValues — supply one value per input`
        );
      }
      const value = record[key];
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidRealmParams(
          `launchRealmFromTemplate inputs['${key}'] must be a shape-tagged value ({ shape, ... })`
        );
      }
      const tagged = value as Record<string, unknown>;
      if (declaration.shape === 'text') {
        if (tagged.shape !== 'text' || typeof tagged.text !== 'string') {
          throw invalidRealmParams(
            `launchRealmFromTemplate inputs['${key}'] must be { shape: 'text', text } for the declared text input`
          );
        }
        resolved[key] = { shape: 'text', text: tagged.text };
        continue;
      }
      if (tagged.shape !== 'files' || !Array.isArray(tagged.files)) {
        throw invalidRealmParams(
          `launchRealmFromTemplate inputs['${key}'] must be { shape: 'files', files: [...] } for the declared files input`
        );
      }
      const files: { path: string; content: string }[] = [];
      for (let index = 0; index < tagged.files.length; index += 1) {
        const entry = tagged.files[index] as Record<string, unknown> | null;
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw invalidRealmParams(`launchRealmFromTemplate inputs['${key}'].files[${index}] must be a { path, content } object`);
        }
        if (typeof entry.path !== 'string' || typeof entry.content !== 'string') {
          throw invalidRealmParams(`launchRealmFromTemplate inputs['${key}'].files[${index}] requires string path and content`);
        }
        files.push({ path: entry.path, content: entry.content });
      }
      resolved[key] = { shape: 'files', files };
    }
  }

  return Object.freeze(resolved);
}

/**
 * Converts validated shape-tagged input values into the authored payload value
 * form (`{ text }` / `{ files }`) so they can re-enter `validatePayload`'s
 * single validation path.
 *
 * @param values - Validated shape-tagged values.
 * @returns Fresh authored-form input record.
 */
function toAuthoredInputValues(
  values: RealmInputValues
): Record<string, { text: string } | { files: readonly { path: string; content: string }[] }> {
  const authored: Record<string, { text: string } | { files: readonly { path: string; content: string }[] }> = {};
  for (const key of Object.keys(values)) {
    const value = values[key];
    authored[key] = value.shape === 'text' ? { text: value.text } : { files: value.files };
  }
  return authored;
}

/**
 * Collects each template agent's declared publishing authorities as a map of
 * template agent key → declared authority set (Wave U ticket 2518510).
 *
 * @param template - Effective template being launched.
 * @returns Declared authorities per agent key (absent when none declared).
 */
function collectDeclaredAuthorities(template: RealmTemplate): Map<string, Set<string>> {
  const declared = new Map<string, Set<string>>();
  for (const spec of template.agents) {
    const authorities = new Set<string>();
    if (Array.isArray(spec.authorities)) {
      for (const authority of spec.authorities) {
        if (typeof authority === 'string' && authority.trim()) authorities.add(authority);
      }
    }
    if (authorities.size > 0) declared.set(spec.key, authorities);
  }
  return declared;
}

/**
 * Resolves the effective approved `(agentKey, authority)` set for a launch
 * (Wave U ticket 2518510): explicit approvals must match a declared pair
 * exactly (unknown keys or undeclared authorities fail closed with
 * `ERR_STORE_INVALID_PARAMS`), and a persisted trust record auto-approves only
 * exact declared matches.
 *
 * @param declared - Declared authorities per agent key.
 * @param approvals - Caller-supplied explicit approvals, or `undefined`.
 * @param trusted - Persisted trust record for this template, or `null`.
 * @returns Approved authorities per agent key.
 * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When an approval is malformed or references an undeclared pair.
 */
function resolveApprovedAuthorities(
  declared: ReadonlyMap<string, ReadonlySet<string>>,
  approvals: unknown,
  trusted: ReadonlyMap<string, readonly string[]> | null
): Map<string, Set<string>> {
  const approved = new Map<string, Set<string>>();
  const add = (agentKey: string, authority: string): void => {
    let forAgent = approved.get(agentKey);
    if (!forAgent) {
      forAgent = new Set<string>();
      approved.set(agentKey, forAgent);
    }
    forAgent.add(authority);
  };
  if (approvals !== undefined) {
    if (!Array.isArray(approvals)) {
      throw invalidRealmParams('launchRealmFromTemplate authorityApprovals must be an array of { agentKey, authority }');
    }
    approvals.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw invalidRealmParams(`launchRealmFromTemplate authorityApprovals[${index}] must be an object`);
      }
      // Closed-shape discipline (ticket be7714b item 2): an approval entry
      // accepts exactly `{ agentKey, authority }` — any other key is inert
      // data that could mask a typo, so it is refused fail-closed.
      const unknownKeys = Object.keys(entry).filter((key) => key !== 'agentKey' && key !== 'authority');
      if (unknownKeys.length > 0) {
        throw invalidRealmParams(
          `launchRealmFromTemplate authorityApprovals[${index}] contains unknown key(s): ${unknownKeys.join(', ')}`
        );
      }
      const record = entry as { agentKey?: unknown; authority?: unknown };
      const agentKey = typeof record.agentKey === 'string' ? record.agentKey.trim() : '';
      const authority = typeof record.authority === 'string' ? record.authority.trim() : '';
      if (!agentKey || !authority) {
        throw invalidRealmParams(
          `launchRealmFromTemplate authorityApprovals[${index}] requires non-empty agentKey and authority`
        );
      }
      const declaredForAgent = declared.get(agentKey);
      if (!declaredForAgent) {
        throw invalidRealmParams(
          `launchRealmFromTemplate authorityApprovals[${index}] names agent '${agentKey}' which declares no authorities`
        );
      }
      if (!declaredForAgent.has(authority)) {
        throw invalidRealmParams(
          `launchRealmFromTemplate authorityApprovals[${index}] approves undeclared authority '${authority}' `
          + `on agent '${agentKey}'`
        );
      }
      add(agentKey, authority);
    });
  }
  if (trusted) {
    for (const [agentKey, authorities] of trusted) {
      const declaredForAgent = declared.get(agentKey);
      if (!declaredForAgent) continue;
      for (const authority of authorities) {
        if (declaredForAgent.has(authority)) add(agentKey, authority);
      }
    }
  }
  return approved;
}

/**
 * Canonical Realm-global workspace key (`realm:<realmId>:global`, the VirtualFS
 * Realm alias convention): the shared workspace a Realm seed writes to when no
 * member target is named. Realm-bound members resolve their `global` alias onto
 * this same key.
 *
 * @param realmId - Registered Realm id.
 * @returns Canonical Realm-global workspace key.
 */
function realmGlobalWorkspaceKey(realmId: string): string {
  return `realm:${realmId}:global`;
}

/**
 * Builds a `CodedError` carrying the store's invalid-parameters code.
 *
 * @param message - Human-readable diagnostic text.
 * @returns Coded invalid-parameters error.
 */
function invalidRealmParams(message: string): CodedError {
  const err: CodedError = new Error(message);
  err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
  return err;
}

/**
 * Builds a `CodedError` carrying one of the standardized store codes.
 *
 * @param code - Standardized store error code.
 * @param message - Human-readable diagnostic text.
 * @returns Coded error.
 */
function codedStoreError(code: SandboxStoreErrorCode, message: string): CodedError {
  const err: CodedError = new Error(message);
  err.code = code;
  return err;
}

/**
 * Copies an authored saved payload into a frozen plain record (ticket
 * 81d8267): one level of `inputs` entries and their `files` arrays is copied
 * so later caller mutation cannot alter the stored bytes. The caller has
 * already digested the value, so only plain JSON data reaches this copy; the
 * component-side library facade keeps its own equivalent copy for the
 * session-only branch (sandbox modules never import component helpers).
 *
 * @param payload - Authored payload object that passed `payloadDigest`.
 * @returns Frozen plain payload.
 */
function freezeSavedInstancePayloadValue(payload: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const inputs = payload.inputs && typeof payload.inputs === 'object' && !Array.isArray(payload.inputs)
    ? (payload.inputs as Record<string, unknown>)
    : null;
  const copiedInputs: Record<string, unknown> = {};
  if (inputs) {
    for (const [inputId, value] of Object.entries(inputs)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        copiedInputs[inputId] = value;
        continue;
      }
      const entry = value as Record<string, unknown>;
      copiedInputs[inputId] = Array.isArray(entry.files)
        ? {
            ...entry,
            files: Object.freeze(entry.files.map((file) => (
              file && typeof file === 'object' ? Object.freeze({ ...(file as Record<string, unknown>) }) : file
            )))
          }
        : { ...entry };
    }
  }
  return Object.freeze({
    ...payload,
    ...(inputs ? { inputs: Object.freeze(copiedInputs) } : {})
  });
}

/**
 * Renders the missing-extension disclosure warnings for a launch receipt, in
 * declared request order: a not-installed request points at the install flow,
 * a not-attached request points at the attach approval.
 *
 * @param missing - Resolved missing extensions from the launch resolution.
 * @returns Human-readable warning lines in input order.
 */
function renderMissingExtensionWarnings(
  missing: readonly { readonly extensionId: string; readonly reason: 'not-installed' | 'not-attached' }[]
): string[] {
  const warnings: string[] = [];
  for (const entry of missing) {
    warnings.push(entry.reason === 'not-installed'
      ? `Requested extension '${entry.extensionId}' is not installed — its tools stay unavailable in this Realm`
      : `Requested extension '${entry.extensionId}' is installed but not attached — approve it to enable its tools`);
  }
  return warnings;
}

/**
 * Collects the template's requested extensions from its `providers` block, in
 * declared order with first-wins deduplication (the catalog accepts a
 * repeated provider id; the request list keeps one entry per id).
 *
 * @param template - Effective template being launched.
 * @returns Frozen requested extensions with transport hints.
 */
function collectExtensionRequests(template: RealmTemplate): readonly ExtensionRequest[] {
  const providers = Array.isArray(template.providers) ? template.providers : [];
  const requests: ExtensionRequest[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') continue;
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    let transportHint: ExtensionTransportHint | undefined;
    if (provider.kind === 'mcp') {
      const transport = provider.transport;
      if (transport && transport.kind === 'http') {
        transportHint = Object.freeze({ kind: 'http', url: transport.url });
      } else if (transport && transport.kind === 'stdio') {
        transportHint = Object.freeze({
          kind: 'stdio',
          command: transport.command,
          ...(Array.isArray(transport.args) ? { args: Object.freeze([...transport.args]) } : {})
        });
      }
    } else if (provider.kind === 'pack' && typeof provider.source === 'string' && provider.source.trim().length > 0) {
      transportHint = Object.freeze({ kind: 'pack', source: provider.source });
    }
    requests.push(Object.freeze({
      id: provider.id,
      kind: provider.kind,
      ...(transportHint !== undefined ? { transportHint } : {})
    }));
  }
  return Object.freeze(requests);
}

/**
 * Collects every `<providerId>::<serverToolName>` extension tool reference
 * declared across the template's agent tool profiles, in declared order with
 * exact-duplicate deduplication. Non-reference entries (canonical names,
 * aliases, legacy requirement ids, the wildcard) are ignored.
 *
 * @param template - Effective template being launched.
 * @returns Frozen reference strings.
 */
function collectExtensionToolReferences(template: RealmTemplate): readonly string[] {
  const references: string[] = [];
  const agents = Array.isArray(template.agents) ? template.agents : [];
  for (const spec of agents) {
    const tools = spec && spec.toolProfile ? spec.toolProfile.tools : undefined;
    if (!Array.isArray(tools)) continue;
    for (const entry of tools) {
      if (typeof entry !== 'string') continue;
      if (entry.indexOf('::') === -1) continue;
      if (!references.includes(entry)) references.push(entry);
    }
  }
  return Object.freeze(references);
}

/**
 * Resolves the effective approved extension-id set for a launch (extension
 * wave): explicit approvals must match a declared template request exactly
 * (unknown ids fail closed with `ERR_STORE_INVALID_PARAMS`), and absent
 * approval is a decline.
 *
 * @param declared - Requested extensions in declared order.
 * @param approvals - Caller-supplied explicit approvals, or `undefined`.
 * @returns Approved extension ids.
 * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When an approval is malformed or references an undeclared request.
 */
function resolveApprovedExtensions(
  declared: readonly ExtensionRequest[],
  approvals: unknown
): ReadonlySet<string> {
  const declaredIds = new Set(declared.map((request) => request.id));
  const approved = new Set<string>();
  if (approvals === undefined) return approved;
  if (!Array.isArray(approvals)) {
    throw invalidRealmParams('launchRealmFromTemplate extensionApprovals must be an array of { extensionId }');
  }
  approvals.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidRealmParams(`launchRealmFromTemplate extensionApprovals[${index}] must be an object`);
    }
    // Closed-shape discipline (ticket be7714b item 2): an approval entry
    // accepts exactly `{ extensionId }` — any other key is inert data that
    // could mask a typo, so it is refused fail-closed.
    const unknownKeys = Object.keys(entry).filter((key) => key !== 'extensionId');
    if (unknownKeys.length > 0) {
      throw invalidRealmParams(
        `launchRealmFromTemplate extensionApprovals[${index}] contains unknown key(s): ${unknownKeys.join(', ')}`
      );
    }
    const extensionId = typeof (entry as { extensionId?: unknown }).extensionId === 'string'
      ? ((entry as { extensionId: string }).extensionId).trim()
      : '';
    if (!extensionId) {
      throw invalidRealmParams(`launchRealmFromTemplate extensionApprovals[${index}] requires a non-empty extensionId`);
    }
    if (!declaredIds.has(extensionId)) {
      throw invalidRealmParams(
        `launchRealmFromTemplate extensionApprovals[${index}] approves undeclared extension '${extensionId}'`
      );
    }
    approved.add(extensionId);
  });
  return approved;
}

/**
 * Builds the typed refusal of a launch whose template declares a publishing
 * authority id unknown to this host (Wave U, ticket 2518510).
 *
 * Import, parse, validation, and review accept the declaration; only launch
 * fails closed (providers precedent), so a bundle authored for a newer host is
 * inspectable without ever granting an authority this host cannot enforce.
 *
 * @param templateId - Template declaring the unknown authority.
 * @param unsupported - Declared-but-unknown authority ids.
 * @returns Coded `ERR_TEMPLATE_AUTHORITY_UNSUPPORTED` error.
 */
function templateAuthorityUnsupportedError(templateId: string, unsupported: readonly string[]): CodedError {
  const err: CodedError = new Error(
    `launchRealmFromTemplate: template '${templateId}' declares publishing authorit`
    + `${unsupported.length === 1 ? 'y' : 'ies'} unknown to this host `
    + `(${unsupported.join(', ')}) — launch is blocked fail-closed`
  );
  err.code = SANDBOX_STORE_ERROR_CODES.ERR_TEMPLATE_AUTHORITY_UNSUPPORTED;
  return err;
}

/**
 * Builds the typed over-budget refusal of a template import (Wave T decision
 * 3.4): the canonical payload exceeds the per-bundle cap or the total imported
 * budget, so nothing is mutated.
 *
 * @param message - Human-readable budget detail.
 * @returns Coded `ERR_STORE_TEMPLATE_TOO_LARGE` error.
 */
function templateImportTooLargeError(message: string): CodedError {
  const err: CodedError = new Error(message);
  err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_TOO_LARGE;
  return err;
}

/**
 * Builds the typed persistence failure of a template-registry mutation: the
 * synchronous snapshot write failed (quota/unavailable storage) and the
 * mutation was rolled back, so the registry is never silently in-memory-only.
 *
 * @param message - Human-readable failure detail.
 * @param cause - Original storage-layer failure witness, when available.
 * @returns Coded `ERR_STORE_TEMPLATE_PERSIST_FAILED` error.
 */
function templatePersistFailedError(message: string, cause?: unknown): CodedError {
  const err: CodedError = new Error(message);
  err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_PERSIST_FAILED;
  if (cause !== undefined) err.cause = cause;
  return err;
}

/**
 * One in-memory runtime template import: the frozen effective bundle with its
 * normalized format-v2 template, the canonical authored transport JSON payload
 * (persisted and exported verbatim), the authored-form content version, and
 * the payload byte size used for the total budget.
 *
 * @internal
 */
interface RealmTemplateImportRecord {
  /** Frozen effective bundle of the import (normalized v2 template + files). */
  readonly bundle: RealmTemplateBundle;
  /** Canonical authored transport JSON text persisted for the import. */
  readonly payload: string;
  /** Authored-form content version returned by `parseTemplateBundle` (`sha256:<hex>`). */
  readonly version: string;
  /** Payload UTF-8 byte length. */
  readonly bytes: number;
}

/**
 * One completed template-seed write group, recorded for launch rollback.
 *
 * @internal
 */
interface RealmSeedWriteGroup {
  /** Workspace key the files were written to. */
  workspace: string;
  /** Normalized absolute paths written, in write order. */
  writtenPaths: string[];
}

/**
 * Rollback outcome of a failed template launch.
 */
interface RealmLaunchRollback {
  /** Member ids permanently purged by the rollback. */
  terminatedMembers: string[];
  /** Absolute paths of template-seed files evicted by the rollback. */
  evictedSeedFiles: string[];
  /** Human-readable rollback failures (member id, seed-file eviction, or realm-record removal). */
  rollbackFailures: string[];
}

/**
 * Coded error carrying the diagnostic fields of a rolled-back Realm launch.
 */
type RealmLaunchFailureError = CodedError & {
  realmId: string;
  templateId: string;
  failedAgentId: string | null;
  rolledBack: boolean;
  terminatedMembers: string[];
  evictedSeedFiles: string[];
  rollbackFailures: string[];
};

/**
 * Builds the typed failure thrown by `SandboxStore.launchRealmFromTemplate()`
 * after a rolled-back partial launch: the original failure is preserved as
 * `cause`, and the rollback report travels on the error so a half-realm is
 * never left un-described.
 *
 * @param template - Template the launch resolved.
 * @param realmId - Registry id of the removed Realm.
 * @param failedAgentId - Agent whose launch failed, or `null` for materialization/seed failures.
 * @param failure - Original thrown value.
 * @param rollback - Rollback report from `#rollbackRealmLaunch`.
 * @returns Coded launch failure.
 */
function createRealmLaunchFailure(
  template: RealmTemplate,
  realmId: string,
  failedAgentId: string | null,
  failure: unknown,
  rollback: RealmLaunchRollback
): CodedError {
  const detail = sanitizeDiagnosticError(thrownMessage(failure, 'unknown failure')) || 'unknown failure';
  const rollbackSummary = rollback.rollbackFailures.length === 0
    ? 'the realm record removal succeeded'
    : `the realm record removal reported ${rollback.rollbackFailures.length} failure(s)`;
  const evictionSummary = rollback.evictedSeedFiles.length > 0
    ? `, evicted ${rollback.evictedSeedFiles.length} seeded file(s)`
    : '';
  const error = new Error(
    `launchRealmFromTemplate: realm '${realmId}' from template '${template.id}' failed`
    + `${failedAgentId ? ` at agent '${failedAgentId}'` : ''}: ${detail}; `
    + `rollback purged ${rollback.terminatedMembers.length} member(s)${evictionSummary} and ${rollbackSummary}`
  ) as RealmLaunchFailureError;
  error.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_LAUNCH_FAILED;
  error.realmId = realmId;
  error.templateId = template.id;
  error.failedAgentId = failedAgentId;
  error.rolledBack = rollback.rollbackFailures.length === 0;
  error.terminatedMembers = rollback.terminatedMembers;
  error.evictedSeedFiles = rollback.evictedSeedFiles;
  error.rollbackFailures = rollback.rollbackFailures;
  error.cause = failure;
  return error;
}

/**
 * Builds the launch-time duplicate-id denial for a template-launch member
 * (Wave R ticket ff2202a; Wave I, ticket d57cbc1).
 *
 * Agent ids are realm-opaque plain ids: the realm id never prefixes them, and
 * an id colliding with an active registration in the target realm is denied
 * before the member launches. The same literal id in another realm is a
 * distinct registration — agent identity is the composite `(realmId, agentId)`
 * — so the denial is realm-local, never cross-realm. The denial is explicit
 * (no auto-suffix) and carries the canonical `AGENT_ALREADY_EXISTS` code so
 * callers can detect it through the rolled-back launch failure's `cause`.
 *
 * @param agentId - Resolved member id that collided.
 * @returns Coded duplicate-id error.
 */
function duplicateRealmMemberIdError(agentId: string): CodedError {
  const err: CodedError = new Error(
    `agent id '${agentId}' is already registered in the target realm; agent ids are realm-local `
    + 'and a duplicate in the same realm is denied — the id was not auto-suffixed'
  );
  err.code = 'AGENT_ALREADY_EXISTS';
  return err;
}

/**
 * Store VFS failure carrying the paths seeded before the failing write.
 */
type SeedWriteFailure = CodedError & { writtenPaths?: string[] };

/**
 * Compares two canonical capability-grant lists element-wise (order-sensitive),
 * the idempotence probe of the H1 heal pass: a live grant equal to the
 * persisted one is left untouched.
 *
 * @param a - First grant list.
 * @param b - Second grant list.
 * @returns True when both lists carry the same entries in the same order.
 */
function capabilityGrantsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ============================================================================
// 2. SandboxStore Class Definition
// ============================================================================

/**
 * Canonical Svelte 5 Reactive Sandbox Store for Conversational Studio & Observability (Layer 3).
 * Encapsulates multi-agent lifecycle state, conversational chat stream synchronization,
 * virtual filesystem workspaces, messaging bus audit logs, AST JSON querying, regex line grep,
 * debounced auto-persistence, startup auto-hydration, emergency unsticking, and orchestrator action modes.
 *
 * The store is the human operator surface (MOD-21 W6; Wave I, ticket
 * c02d0b9): operator-scoped actions (agent kill, authority edits, scheduler
 * visibility/cancellation, and cross-workspace filesystem actions) run under
 * the runtime's host operator principal (`runtime.getOperatorPrincipal()`,
 * exact-reference validated), so they work with zero registered agents and
 * never depend on the director existing. Caller-declared privilege flags
 * (`isAdmin`, `isPrivileged`, `privileged`) never grant anything.
 *
 * @example
 * ```typescript
 * import { SandboxStore } from './index.svelte.ts';
 * 
 * const store = new SandboxStore();
 * await store.launchAgent({
 *   id: 'scout',
 *   name: 'Scout Unit',
 *   role: 'Reconnaissance'
 * });
 * const turn = await store.submitChatTurn('Scan sector Alpha');
 * console.log('Agent response:', turn.output);
 * ```
 */
export class SandboxStore {
  // --- Svelte 5 $state fields ---
  /**
   * Reactive list of all active agents in runtime with normalized FSM states, token telemetry,
   * unread badge counts, and launch configurations.
   * Read-only to consumers; mutated exclusively via store actions.
   * 
   * @example
   * ```typescript
   * for (const agent of sandboxStore.agents) {
   *   console.log(`${agent.name} [${agent.state}] - ${agent.turnCount} turns`);
   * }
   * ```
   */
  agents = $state<AgentStateSnapshot[]>([]);
  /**
   * Reactive list of soft-killed agents currently residing in the recycle bin.
   * Preserves complete conversational history and redo stacks; private workspaces are evicted
   * from VirtualFS at kill time.
   * 
   * @example
   * ```typescript
   * console.log(`Agents in recycle bin: ${sandboxStore.recycleBin.length}`);
   * ```
   */
  recycleBin = $state<RecycledAgentStateSnapshot[]>([]);
  /**
   * Canonical `(realmId, agentId)` identity key of the currently selected /
   * focused agent across Chat Studio and Agent Inspector, or `null` when no
   * agent is selected. The single source of truth for selection (defect
   * 7d2c314): a realm-local agent whose literal id equals another scope's id
   * is addressed realm-exactly and never shadowed by a bare-id match.
   * 
   * @example
   * ```typescript
   * console.log('Currently focused agent key:', sandboxStore.selectedAgentKey);
   * ```
   */
  selectedAgentKey = $state<string | null>(null);
  /**
   * Complete chronological audit log of all messages routed through the `MessagingBus`.
   * Includes point-to-point, broadcast, and system delivery envelopes.
   * 
   * @example
   * ```typescript
   * console.log(`Total bus messages routed: ${sandboxStore.messages.length}`);
   * ```
   */
  messages = $state<BusMessageEnvelope[]>([]);
  /**
   * Reactive list of deferred timer executions with live 1s countdown tracking (`remainingSeconds`).
   * 
   * @example
   * ```typescript
   * for (const timer of sandboxStore.scheduledTimers) {
   *   console.log(`Timer ${timer.timerId} fires in ${timer.remainingSeconds}s for ${timer.agentId}`);
   * }
   * ```
   */
  scheduledTimers = $state<ScheduledTimerSnapshot[]>([]);
  /**
   * Reactive snapshot of all virtual files across all workspaces (`global` and agent-private).
   * Mirrors `VirtualFS.exportSnapshot()` verbatim: `Record<workspaceId, Record<normalizedPath, FileRecord>>`,
   * where each record carries `path`, `workspaceId`, `content`, `size`, `updatedAt`, `readOnly`, and `owner`.
   * Exported through the runtime persistence port, whose VFS members carry the
   * composition-root `InternalPrincipal` binding (MOD-21 W8-D/W8-F); without an
   * authorized route the projection stays empty.
   * 
   * @example
   * ```typescript
   * const globalFiles = sandboxStore.fsSnapshot['global'] || {};
   * console.log('Global files count:', Object.keys(globalFiles).length);
   * ```
   */
  fsSnapshot = $state<Record<string, Record<string, FileRecord>>>({});
  /**
   * Currently focused workspace identifier in the VirtualFS Explorer tab (e.g. `'global'`, `'director'`).
   * 
   * @example
   * ```typescript
   * console.log('Active VFS workspace:', sandboxStore.activeFsWorkspace);
   * ```
   */
  activeFsWorkspace = $state<string>('global');
  /**
   * Currently active workstation tab (`'chat'`, `'settings'`, `'inspector'`, `'filesystem'`, `'messaging'`).
   * 
   * @example
   * ```typescript
   * console.log('Current workstation tab:', sandboxStore.activeTab);
   * ```
   */
  activeTab = $state<SandboxTabId>('inspector'); // 'inspector' | 'chat' | 'filesystem' | 'messaging'
  /**
   * Read-only reactive dictionary mapping agent IDs to their persistent prompt draft text.
   * Guarantees form state preservation across agent switching and session reloads.
   * 
   * @example
   * ```typescript
   * const draft = sandboxStore.agentDraftInputs['director'] || '';
   * ```
   */
  agentDraftInputs = $state<Record<string, string>>({});
  /**
   * Reactive dictionary of narrative clock states across agent partitions and global.
   * Structured as `Record<partitionId, AgentClockState>`.
   * 
   * @example
   * ```typescript
   * const globalClock = sandboxStore.clockSnapshot['global'];
   * console.log('Global time:', globalClock?.formattedTime);
   * ```
   */
  clockSnapshot = $state<Record<string, AgentClockState>>({});

  /**
   * Boolean indicator whether the PRD collaboration handshake demo is currently executing.
   * 
   * @example
   * ```typescript
   * if (sandboxStore.isDemoRunning) {
   *   console.log('Demo step:', sandboxStore.demoStep);
   * }
   * ```
   */
  isDemoRunning = $state<boolean>(false);
  /**
   * Current human-readable milestone step of the running handshake scenario.
   * 
   * @example
   * ```typescript
   * console.log('Current demo phase:', sandboxStore.demoStep);
   * ```
   */
  demoStep = $state<string>('');
  /**
   * Structured chronological logs of the handshake demo execution.
   * 
   * @example
   * ```typescript
   * console.log('Demo logs emitted:', sandboxStore.demoLogs.length);
   * ```
   */
  demoLogs = $state<DemoLogEntry[]>([]);
  /**
   * In-flight loading indicator when provisioning a new agent instance (`launchAgent`).
   * 
   * @example
   * ```typescript
   * if (sandboxStore.isLaunchingAgent) {
   *   console.log('Provisioning agent in progress...');
   * }
   * ```
   */
  isLaunchingAgent = $state<boolean>(false);
  /**
   * Top-level store error message for UI alert banners and toasts, or `null` if healthy.
   * 
   * @example
   * ```typescript
   * if (sandboxStore.error) {
   *   console.error('Store alert:', sandboxStore.error);
   * }
   * ```
   */
  error = $state<string | null>(null);
  /**
   * Dismissible persisted-state recovery notice raised during hydration when the
   * stored snapshot was unreadable and a fresh session was started (QA-013).
   * `null` when no recovery occurred or the notice has been dismissed.
   * 
   * @example
   * ```typescript
   * if (sandboxStore.hydrationNotice) {
   *   console.warn('Recovered from unreadable state:', sandboxStore.hydrationNotice.reason);
   * }
   * ```
   */
  hydrationNotice = $state<SandboxHydrationNotice | null>(null);

  /**
   * Reactive projection of the store-owned realm registry, in registry order.
   * Read-only to consumers; mutated exclusively through registry changes
   * (store CRUD methods or direct registry calls). Empty when no Realms exist.
   *
   * @example
   * ```typescript
   * for (const realm of sandboxStore.realms) {
   *   console.log(`${realm.name} [${realm.color ?? 'default'}]`);
   * }
   * ```
   */
  realms = $state<RealmRecord[]>([]);

  /**
   * Observable report of the last H1 reload capability heal: per-agent
   * outcomes plus aggregate counters, published on every hydration and on each
   * manual `healRestoredCapabilities()` call. `null` before any hydration with
   * captured grants.
   *
   * @example
   * ```typescript
   * const report = sandboxStore.capabilityHealReport;
   * if (report && report.restored > 0) {
   *   console.info(`Capability heal restored ${report.restored} agent grant(s).`);
   * }
   * ```
   */
  capabilityHealReport = $state<CapabilityHealReport | null>(null);

  /**
   * Observable report of the last hydration-time legacy private-workspace
   * remap (Wave I, ticket d57cbc1): every legacy bare-keyed private workspace
   * that was rekeyed onto its canonical storage key, with the duplicate paths
   * the canonical copy already owned. `null` when the last hydration found no
   * legacy private workspaces; a remap that could not run reports
   * `failed: true`. Conflict detail is the only signal — hydration never
   * console-logs remap noise.
   *
   * @example
   * ```typescript
   * const report = sandboxStore.legacyWorkspaceRemapReport;
   * if (report && report.conflictCount > 0) {
   *   console.warn(`Recovered ${report.remappedCount} legacy workspace(s) with ${report.conflictCount} duplicate path(s).`);
   * }
   * ```
   */
  legacyWorkspaceRemapReport = $state<LegacyWorkspaceRemapReport | null>(null);

  /**
   * Reactive extension-connection projection for the UI (extension wave,
   * P3.1): one frozen, secret-free entry per live connection in
   * connection-completion sequence order (in-flight connects last, by
   * extension id). Always `[]` before any operator connect — nothing
   * auto-connects at load, hydration, or launch — and never persisted.
   *
   * @example
   * ```typescript
   * for (const connection of sandboxStore.extensionConnections) {
   *   console.log(connection.extensionId, connection.status, connection.digest);
   * }
   * ```
   */
  extensionConnections = $state<readonly ExtensionConnectionProjection[]>(Object.freeze([]));

  // --- Strict #private engine & coordinator instances ---
  #virtualFs: VirtualFS;
  #messagingBus: MessagingBus;
  #runtime: AgentRuntime;
  #worldClock: WorldClock;
  /**
   * Runtime identity resolver used to tell a registered agent sender label
   * apart from an operator presentation label on the manual-send surface, to
   * resolve canonical `(realmId, agentId)` mailbox/partition keys for
   * realm-local store operations, and to let the substrates this store
   * constructs resolve agent authority by subject. Wave I (ticket d57cbc1):
   * resolution is scope-aware (`getAgentIdentity(subject, scope)`) with
   * enumeration (`listAgentIdentities(scope)`) for ambiguity checks.
   */
  #identityPort: AgentIdentityPort | null = null;
  #credentialVault: CredentialVault;
  /**
   * Frozen least-privilege resolver port handed to the runtime after the
   * vault creates it.
   */
  #credentialResolver: CredentialResolverPort;
  /**
   * Interval handle for the 1-second scheduled-timer countdown ticker
   * (optionally `unref`-able under Node).
   */
  #timerTicker: (ReturnType<typeof setInterval> & { unref?: () => void }) | null = null;
  /** Debounced snapshot-save coordinator (300ms). */
  #debouncedSave: DebouncedSaveCoordinator | null = null;
  /**
   * Hydration suppression guard: while true (for the whole synchronous
   * `hydrateFromStorage` flow), snapshot-backed adapter and pointer writes may
   * still update in-memory catalog/state but must never schedule the debounced
   * autosave — hydration never rewrites persisted bytes (stale snapshots are
   * ignored, not rewritten).
   */
  #hydrating = false;
  /** Runtime lifecycle/streaming event subscription handle. */
  #unsubRuntime: UnsubscribeFn | null = null;
  /** MessagingBus broadcast subscription handle. */
  #unsubBus: UnsubscribeFn | null = null;
  #autoBootstrapDirector = false;
  /** Pending trailing-edge stream-mirror timer (leading/trailing throttle). */
  #streamMirrorTimer: ReturnType<typeof setTimeout> | null = null;
  #lastStreamMirrorAt = 0;
  /** Owned MOD-20 preset catalog (composition root); the single source of preset truth. */
  #presetCatalog: PresetCatalog;
  /** Frozen MOD-20 projection handed to the owned runtime. */
  #presetSource: ModelPresetSourcePort;
  /** Snapshot-backed custom preset mirror (the catalog adapter's persistence write-through). */
  #customPresets: ModelPreset[] = [];
  /** Snapshot-backed active preset pointer; an empty string lets the catalog resolve its default. */
  #activePresetId = '';
  /** Owned Wave A realm registry (composition root); the single source of realm truth. */
  #realmRegistry: RealmRegistry;
  /** Snapshot-backed realm mirror (the registry adapter's persistence write-through). */
  #realmRecords: RealmRecord[] = [];
  /** Realm registry change subscription handle (keeps the projection in sync). */
  #unsubRealms: UnsubscribeFn | null = null;
  /** Owned extension registry (composition root); the single source of global install truth. */
  #extensionRegistry: ExtensionRegistry;
  /** Snapshot-backed install-record mirror (the registry adapter's persistence write-through). */
  #extensionRecords: ExtensionInstallRecord[] = [];
  /**
   * Live extension connections (extension wave, P3.1): sessions, discovered
   * catalogs, and arbitration state. Strictly session-only in-memory state —
   * never written to an install record, a realm record, or the snapshot — and
   * only ever populated by an explicit operator connect/reconnect.
   */
  #extensionConnections: Map<string, LiveExtensionConnection> = new Map();
  /**
   * Monotonic connection-completion sequence: assigned when a catalog
   * completes discovery and the only ordering authority the arbitration
   * reads (never map insertion order).
   */
  #extensionConnectionSequence = 0;
  /**
   * Active call-name → `{ extensionId, serverToolName }` resolver map
   * (P3.1 resolution projection): rebuilt by every re-arbitration from the
   * arbitration-active catalogs in sequence order. The P3.3 execution seam is
   * the descriptor-backed provider port below; this map remains the public
   * catalog-resolution projection.
   */
  #extensionCallNameResolver: Map<string, { extensionId: string; serverToolName: string }> = new Map();
  /**
   * Frozen synthesized descriptor registry (extension wave, P3.3): the active
   * catalogs' call names → {@link ExtensionToolDescriptor}, rebuilt by every
   * re-arbitration and cleared with the connection teardown. A refused schema
   * projection contributes no descriptor, so the tool is unavailable
   * (`TOOL_NOT_FOUND`) and disclosed by the fidelity summary. Null-prototype
   * and frozen: lookups can never read through the prototype chain.
   */
  #extensionDescriptors: Readonly<Record<string, ExtensionToolDescriptor>> = Object.freeze(Object.create(null));
  /**
   * Frozen provider-registry port handed to the store-owned runtime (extension
   * wave, P3.3): resolves a sanitized call name to its binding (descriptor-
   * backed, so a catalog-less or refused name resolves nothing) and to the
   * frozen synthesized descriptor. Trusted bound construction; never exposed
   * through agent-facing state.
   */
  #extensionToolProvider: ExtensionToolProviderPort = Object.freeze({
    resolveTool: (callName: string) => {
      const descriptor = this.#lookupExtensionDescriptor(callName);
      if (!descriptor) return null;
      return Object.freeze({
        callName: descriptor.name,
        extensionId: descriptor.source.extensionId,
        serverToolName: descriptor.source.serverToolName
      });
    },
    resolveDescriptor: (callName: string) => this.#lookupExtensionDescriptor(callName)
  });
  /**
   * Frozen execution port handed to the store-owned runtime (extension wave,
   * P3.3): performs one live `tools/call` against the extension's current
   * session. A missing/disconnected session throws a typed secret-free
   * `McpClientError` (the dispatcher maps it to a redacted
   * `EXECUTION_FAILED` receipt); credential handling and transport concerns
   * stay inside the session, so no secret ever crosses this interface.
   */
  #extensionExecutionPort: ExtensionExecutionPort = Object.freeze({
    execute: async (request: ExtensionToolExecutionRequest) => {
      const extensionId = request && typeof request.extensionId === 'string' ? request.extensionId : '';
      const serverToolName = request && typeof request.serverToolName === 'string' ? request.serverToolName : '';
      const args = request && request.args && typeof request.args === 'object' ? request.args : {};
      const entry = this.#extensionConnections.get(extensionId);
      const session = entry && entry.status === 'connected' && entry.session ? entry.session : null;
      if (!session) {
        throw new McpClientError(
          'Extension tool execution is unavailable: the extension session is not connected.',
          MCP_CLIENT_ERROR_CODES.CANCELLED
        );
      }
      return session.callTool(serverToolName, args);
    }
  });
  /**
   * In-memory explicit-disconnect markers (extension wave, P3.1/F1): extension
   * ids whose realm attachment must not be healed back to `active` by the
   * install-only heal after an operator disconnect (or a reconnect/removal
   * close) — the heal consults the marker as a live-state constraint until an
   * explicit successful connect clears it. Session state only: never
   * persisted, dropped by hydration/reset/destroy, and cleared by a fresh
   * operator approval (install/attach) or record removal.
   */
  #extensionDisconnected: Set<string> = new Set();
  /**
   * Frozen shipped launch catalog for this store instance: the baked demo
   * fixture plus embedded `templates/**` bundles, layered with any per-instance
   * `realmTemplateBundles` injection (both are "shipped" for this store).
   * Imports shadow entries here without mutating this layer.
   */
  #hostRealmTemplateBundles: readonly RealmTemplateBundle[] = BAKED_REALM_TEMPLATE_BUNDLES;
  /**
   * Runtime template imports by template id, in import order (one entry per
   * id; re-importing an id replaces its record in place). Persisted as
   * canonical payloads and re-parsed from the snapshot on hydration.
   */
  #realmTemplateImports: Map<string, RealmTemplateImportRecord> = new Map();
  /**
   * Effective launch-bundle catalog for this store: the shipped catalog with
   * runtime imports layered on top (in-place replacement by id), frozen at
   * resolution. The template list the launcher UI reads and the bundle files
   * `launchRealmFromTemplate` / `getRealmTemplateBundle` resolve both come from
   * here.
   */
  #realmTemplateBundles: readonly RealmTemplateBundle[] = BAKED_REALM_TEMPLATE_BUNDLES;
  /**
   * Frozen normalized template projection of `#realmTemplateBundles` (picker
   * order); rebuilt by `#resolveRealmTemplateCatalog` before any read.
   */
  #realmTemplates: readonly RealmTemplate[] = [];
  /**
   * Capability grants captured from the persisted snapshot at hydration start
   * (`allowedTools`/`tools`/`toolPreset` resolved through the sandbox preset
   * resolver). The H1 heal pass reconciles these onto the restored agents;
   * privilege and parentage are never captured. The per-agent extension
   * selector rides along as `extensionSelector`: the persisted value when the
   * snapshot carries one, otherwise the fail-closed empty selector (a legacy
   * snapshot granted nothing before the extension wave). The selector is
   * state; the effective grant set is recomputed from the live Realm universe
   * by the extension sweep after the attachment heal.
   *
   * The captured `realmId` is identity targeting only (ticket 5f34f18): the
   * heal resolves each grant through the canonical `(realmId, agentId)` key so
   * a same-literal-id member in another Realm is healed realm-exactly instead
   * of resolving ambiguous and being skipped. It is never applied back as a
   * membership write — membership hydrates through the runtime's own
   * scope-constraint path and is immutable at the API.
   */
  #capabilityHealGrants: ReadonlyArray<{
    agentId: string;
    realmId: string | null;
    allowedTools: readonly string[];
    extensionSelector: 'all' | readonly string[];
  }> = [];

  /**
   * Safe-state extension reauthorize queue (extension wave, P2.4): identity
   * keys of members whose effective extension grant set changed while they
   * were busy. A queued member is reauthorized on its next `turn_complete`
   * (the pinned safe state) — never mid-turn; idle members are reauthorized
   * synchronously at the mutation point.
   */
  #pendingExtensionReauthorize: Set<string> = new Set();

  /**
   * Fail-closed guard for the extension sweep (extension wave, P2.4):
   * identity keys whose captured selector could not be re-applied during the
   * capability heal. A blocked member is never swept (its descriptor stays
   * default-deny) until an operator selector edit succeeds, so a failed heal
   * can never silently resolve the default `'all'` against the Realm universe.
   */
  #extensionSweepBlocked: Set<string> = new Set();

  /**
   * Registration-diff baseline (ticket 9327633): the canonical identity keys
   * observed by the previous `#syncAgents()` pass. A key that newly enters the
   * active set is a fresh registration regardless of which launch path created
   * it — including a child launched through the `spawn_agent` tool's lifecycle
   * port, which never passes the store's grant-composing launch path — so
   * `#handleRuntimeEvent` can sweep it with the Realm universe.
   */
  #knownAgentIdentityKeys: Set<string> = new Set();

  /**
   * Registrations that entered the active set and await their Realm-universe
   * grant sweep (ticket 9327633). Populated by the `#syncAgents()` diff and
   * drained by `#handleRuntimeEvent` through `#queueExtensionReauthorize`
   * (idle members apply immediately, busy members apply at `turn_complete`).
   */
  #pendingRegistrationSweep: Set<string> = new Set();

  /**
   * Registration-time sweep suppression (ticket 9327633): canonical identity
   * keys whose launch already passed the store-computed effective extension
   * grant set through the runtime's trusted unified-options channel. The
   * registration diff consumes the mark instead of queueing a redundant sweep
   * — which, for a template launch, would race its post-success attachment and
   * provenance write (the Realm universe is not yet readable at registration).
   */
  #storeLaunchGrantedKeys: Set<string> = new Set();

  /**
   * Session-only pending instance payloads (Wave U candidates, ticket
   * 2518510), keyed by template id. Never persisted: a restarted session
   * re-submits. The Wave T launch attach path (`{ package }`) stays the only
   * attach mechanism.
   */
  #pendingInstancePayloads: Map<string, PendingInstancePayload> = new Map();

  /**
   * Wave U per-template authority trust (ticket 2518510): template id → agent
   * key → previously approved authority ids. Operator intent only — a later
   * launch auto-approves exact declared matches; it never grants anything
   * directly.
   */
  #templateAuthorityTrust: Map<string, Map<string, readonly string[]>> = new Map();

  /**
   * Persisted saved hydration-payload library (ticket 81d8267): the operator's
   * named authored payloads, restored from and emitted into the additive
   * snapshot field `savedInstancePayloads`. Bounded by
   * `SAVED_INSTANCE_PAYLOAD_MAX_ENTRIES` and `SAVED_INSTANCE_PAYLOAD_MAX_BYTES`;
   * payloads stay descriptive data and are re-validated only when a launch
   * attaches them.
   */
  #savedInstancePayloads: SavedInstancePayload[] = [];

  /**
   * Monotonic counter backing the `saved_payload_<n>` library ids. Hydration
   * seeds it past the highest persisted numeric suffix so new saves can never
   * collide with restored entries; a reset restores it to zero.
   */
  #savedInstancePayloadCounter = 0;

  /** Saved-payload library mutation listeners (the UI facade forwards these). */
  #savedInstancePayloadListeners: Set<() => void> = new Set();

  /**
   * Frozen Wave U host publishing port (ticket 2518510) seeded into the
   * store-owned runtime and exposed through {@link getRealmPublishingPort}.
   */
  #realmPublishingPort: RealmPublishingPort | null = null;

  /**
   * M3 realm-admin port (ticket 094de1b): the store is the host-side
   * implementation over its owned realm registry, the extension live state,
   * and the runtime rosters. Built before the runtime so the store-owned
   * runtime seeds it into every tool dispatcher; a caller-injected runtime is
   * caller-owned and keeps its own wiring (tests may bind the same port from
   * `getRealmAdminPort()`).
   */
  #realmAdminPort: RealmAdminPort | null = null;

  /**
   * Constructs a new isolated `SandboxStore` instance with private domain engines and reactive state.
   * 
   * @param options - Optional custom engine instances and hydration flags for dependency injection.
   * 
   * @example
   * ```typescript
   * const store = new SandboxStore({ autoBootstrapDirector: true, autoHydrate: true });
   * ```
   */
  constructor({ virtualFs, messagingBus, runtime, credentialStorage = null, autoBootstrapDirector = null, autoHydrate = null, realmTemplateBundles = null }: SandboxStoreOptions = {}) {
    const isCustomRuntime = Boolean(runtime);
    const resolvedAutoBootstrap = autoBootstrapDirector !== null ? Boolean(autoBootstrapDirector) : !isCustomRuntime;
    const shouldAutoHydrate = autoHydrate !== null ? Boolean(autoHydrate) : resolvedAutoBootstrap;
    this.#autoBootstrapDirector = resolvedAutoBootstrap;

    // Launch-bundle seam (C4) plus the Wave T runtime import registry: the
    // shipped catalog is validated/frozen before any engine is built (a
    // malformed host injection fails construction), persisted imports are
    // seeded for an auto-hydrating store, and the effective catalog resolves
    // shipped → imported with in-place replacement by id before anything
    // reads it.
    this.#hostRealmTemplateBundles = resolveRealmTemplateBundles(realmTemplateBundles);
    if (shouldAutoHydrate) {
      this.#loadPersistedRealmTemplateFields();
    }
    this.#resolveRealmTemplateCatalog();

    // MOD-20 composition root (ICD v1.1.0 13.2): seed the snapshot-backed
    // preset fields before the catalog is built so the catalog's adapter load
    // resolves custom presets and the active pointer from the persisted
    // session. Only an auto-hydrating store touches storage at construction.
    if (shouldAutoHydrate) {
      this.#loadPersistedPresetFields();
    }
    this.#presetCatalog = createPresetCatalog({
      storage: {
        load: () => this.#customPresets.map((preset) => cloneModelPreset(preset)),
        save: (presets) => {
          this.#customPresets = presets
            .filter((preset) => preset.isCustom)
            .map((preset) => cloneModelPreset(preset));
          this.#scheduleAutoSave();
        }
      },
      getActivePresetId: () => this.#activePresetId,
      setActivePresetId: (id) => {
        this.#activePresetId = id;
        this.#scheduleAutoSave();
      }
    });
    this.#presetSource = this.#presetCatalog.createPresetSourcePort();

    // Wave A realm composition root: seed the snapshot-backed realm mirror
    // from the persisted session before the registry loads it, then build the
    // registry over a `{ load, save }` adapter backed by that mirror and keep
    // the reactive projection in sync through the registry change events. Only
    // an auto-hydrating store touches storage here.
    if (shouldAutoHydrate) {
      this.#loadPersistedRealmFields();
    }
    // Wave R (ticket 56ba4b9): every store seeds the Generic default record
    // before the registry loads the mirror, so the registry is never empty and
    // a missing Generic in the persisted bytes is re-seeded. The mirror is
    // seeded directly (no adapter `save`) so construction never schedules an
    // autosave and a hydration pass stays storage-read-only.
    this.#seedGenericRealmRecord();
    this.#realmRegistry = createRealmRegistry({
      storage: {
        load: () => this.#realmRecords.map((realm) => cloneRealmRecord(realm)),
        save: (realms) => {
          this.#realmRecords = realms.map((realm) => cloneRealmRecord(realm));
          this.#scheduleAutoSave();
        }
      },
      // Wave R hardening (ticket 0fe25fd): the registry itself refuses to
      // remove the protected Generic default, so no public surface — the raw
      // `getRealmRegistry()` management API included — can leave a launch
      // binding to a dangling Realm.
      protectedIds: [GENERIC_REALM_ID]
    });
    this.#unsubRealms = this.#realmRegistry.subscribe(() => {
      this.#syncRealms();
    });
    this.#syncRealms();

    // Extension composition root: seed the snapshot-backed install mirror from
    // the persisted session before the registry loads it, then build the
    // registry over a `{ load, save }` adapter backed by that mirror. The
    // registry owns global install records only; realm attachments ride the
    // realm records. Only an auto-hydrating store touches storage here.
    if (shouldAutoHydrate) {
      this.#loadPersistedExtensionFields();
    }
    this.#extensionRegistry = createExtensionRegistry({
      storage: {
        load: () => this.#extensionRecords.map((record) => cloneExtensionInstallRecord(record)),
        save: (records) => {
          this.#extensionRecords = records.map((record) => cloneExtensionInstallRecord(record));
          this.#scheduleAutoSave();
          // In-session attachment heal: every registry mutation (install,
          // remove, reconcile — the raw registry surface included) passes
          // through this persistence seam, so an `unavailable` attachment
          // returns to `active` as soon as its extension is installed again,
          // while a `conflict` attachment is never rewritten. Hydration is
          // excluded here because the hydrate pass heals explicitly after the
          // realm topology is reconciled.
          if (!this.#hydrating) {
            this.#healRealmExtensionAttachments();
          }
        }
      }
    });

    // Saved hydration-payload library (ticket 81d8267): seed the in-memory
    // library from the persisted session before any consumer reads it. Only an
    // auto-hydrating store touches storage here; the later hydrate pass
    // replaces the library with the same snapshot-authoritative set. Seeding
    // never schedules a save (hydration stays storage-read-only).
    if (shouldAutoHydrate) {
      this.#loadPersistedSavedInstancePayloadFields();
    }

    // Late-bound identity bridge: substrates the store constructs resolve agent
    // authority through the runtime registry once the runtime exists (MOD-21
    // W4/W6). Without it, store-created substrates would default-deny every
    // principal, including the operator. Wave I (ticket d57cbc1): the bridge
    // forwards the trusted resolution scope and exposes enumeration, so
    // store-constructed substrates resolve multi-Realm identities realm-exactly
    // and fail closed on an ambiguous bare id instead of picking a Realm.
    const identityBridge = {
      getAgentIdentity: (agentId: string, scope?: AgentIdentityScope) => (
        this.#identityPort ? this.#identityPort.getAgentIdentity(agentId, scope) : null
      ),
      listAgentIdentities: (scope?: AgentIdentityScope) => (
        this.#identityPort ? this.#identityPort.listAgentIdentities(scope) : []
      )
    };
    this.#virtualFs = virtualFs || new VirtualFS({ defaultBudgetBytes: 20000, identityPort: identityBridge });
    this.#messagingBus = messagingBus || new MessagingBus({ identityPort: identityBridge });
    this.#credentialVault = new CredentialVault({
      storage: credentialStorage ?? createBrowserCredentialStorage()
    });
    this.#credentialResolver = this.#credentialVault.createResolverPort();
    // Wave U publishing port (ticket 2518510): the store is the host-side
    // implementation over its real Wave T template registry and session
    // candidate surface. Built before the runtime so the store-owned runtime
    // seeds it into every tool dispatcher; a caller-injected runtime is
    // caller-owned and keeps its own wiring (tests may bind the same port from
    // `getRealmPublishingPort()`).
    this.#realmPublishingPort = this.#createRealmPublishingPort();
    // M3 realm-admin port (ticket 094de1b): the same composition-root pattern
    // over the store-owned realm registry, extension live state, and runtime
    // rosters.
    this.#realmAdminPort = this.#createRealmAdminPort();
    // Only the store-owned runtime receives the MOD-20 preset source. A
    // caller-injected runtime is caller-owned (and constructor-immutable), so
    // no injection is attempted; its agents resolve presets only if the caller
    // wired a source itself.
    // Extension execution ports (extension wave, P3.3): the store is the
    // composition root over its live connection catalogs/sessions. Built as
    // frozen fields before the runtime so the store-owned runtime seeds them
    // into every tool dispatcher; a caller-injected runtime is caller-owned
    // and keeps its own wiring.
    this.#runtime = runtime || new AgentRuntime({
      virtualFs: this.#virtualFs,
      messagingBus: this.#messagingBus,
      credentialResolver: this.#credentialResolver,
      presetSource: this.#presetSource,
      realmPublishingPort: this.#realmPublishingPort,
      realmAdminPort: this.#realmAdminPort,
      extensionToolProvider: this.#extensionToolProvider,
      extensionExecutionPort: this.#extensionExecutionPort
    });
    this.#identityPort = typeof this.#runtime.createAgentIdentityPort === 'function'
      ? this.#runtime.createAgentIdentityPort()
      : null;
    this.#worldClock = this.#runtime.worldClock || new WorldClock({ virtualFs: this.#virtualFs, identityPort: identityBridge });

    // I1-F (Wave I, ticket c02d0b9): a caller-injected runtime mints its opaque
    // operator principal in its own constructor, so the substrates this store
    // constructed (no `virtualFs`/`messagingBus` injection, no runtime clock)
    // could never receive the exact reference through their own options. Bind
    // it once on each store-constructed substrate that exposes the one-time
    // `bindInternalPrincipal` seam, so operator-attributed sends and
    // tenant-administration calls authorize by exact reference. Caller-injected
    // substrates stay caller-owned; for a store-created runtime the runtime
    // constructor already performed this binding (first bind wins makes the
    // repeat a no-op).
    const operatorPrincipal = typeof this.#runtime.getOperatorPrincipal === 'function'
      ? this.#runtime.getOperatorPrincipal()
      : null;
    if (operatorPrincipal && typeof operatorPrincipal === 'object') {
      if (!virtualFs && typeof this.#virtualFs.bindInternalPrincipal === 'function') {
        this.#virtualFs.bindInternalPrincipal(operatorPrincipal);
      }
      if (!messagingBus && typeof this.#messagingBus.bindInternalPrincipal === 'function') {
        this.#messagingBus.bindInternalPrincipal(operatorPrincipal);
      }
      if (!this.#runtime.worldClock && typeof this.#worldClock.bindInternalPrincipal === 'function') {
        this.#worldClock.bindInternalPrincipal(operatorPrincipal);
      }
    }

    // Debounced save coordinator (300ms)
    this.#debouncedSave = createDebouncedSave((state) => saveSandboxState(state), 300);

    // Subscribe to AgentRuntime lifecycle and streaming events
    this.#unsubRuntime = this.#runtime.subscribe(this.#handleRuntimeEvent.bind(this));

    // Subscribe to MessagingBus broadcasts
    this.#unsubBus = this.#messagingBus.subscribe('all', this.#handleBusMessage.bind(this));

    // Auto-hydration from persisted snapshot if present (INV-STORE-PERSIST)
    if (shouldAutoHydrate && hasPersistedState()) {
      const ok = this.hydrateFromStorage();
      if (!ok) {
        this.#syncAgents();
        this.#syncRecycleBin();
        this.#syncMessages();
        this.#syncFsSnapshot();
        this.#syncScheduledTimers();
        this.#syncClockSnapshot();
      }
    } else {
      this.#syncAgents();
      this.#syncRecycleBin();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncScheduledTimers();
      this.#syncClockSnapshot();
    }

    // Auto-bootstrap Director Meta-Agent if enabled and absent
    if (this.#autoBootstrapDirector && !this.#runtime.getAgent('director')) {
      this.ensureDirector().catch((err) => {
        console.error('Failed to ensure Director agent on SandboxStore boot:', err);
      });
    }
  }

  // ==========================================================================
  // Derived Reactive Accessors ($derived)
  // ==========================================================================

  /**
   * Pure derived count of soft-killed agents currently residing in the recycle bin.
   * 
   * @example
   * ```typescript
   * console.log(`Recycle bin badge count: ${sandboxStore.recycleBinCount}`);
   * ```
   */
  get recycleBinCount(): number {
    return this.recycleBin.length;
  }

  /**
   * Derived, read-only MOD-20 model configuration of the active catalog preset
   * (the `settings.modelConfig` compatibility value, OPEN-4). Sources
   * `getPreset(getActivePresetId())` through the frozen source port, so a stale
   * pointer resolves to the catalog default and the credential-free preset config
   * is returned. Never persisted as an independent channel and never editable
   * through the store: the catalog is the single writer.
   *
   * @example
   * ```typescript
   * const cfg = sandboxStore.modelConfig;
   * console.log(`Active preset model: ${cfg?.providerId}/${cfg?.modelId}`);
   * ```
   */
  get modelConfig(): PresetModelConfig | null {
    const activePresetId = this.#presetSource.getDefaultPresetId();
    const preset = this.#presetSource.getPreset(activePresetId);
    return preset ? preset.modelConfig : null;
  }

  /**
   * Pure derived getter returning the full normalized agent snapshot for
   * `selectedAgentKey`, or `null` if no agent is selected.
   *
   * Resolution (defect 7d2c314): an exact canonical `identityKey` match wins;
   * otherwise a unique bare-id match keeps the legacy behavior for a raw
   * reference (a pre-fix persisted selection or an explicit bare-id select);
   * an ambiguous bare id resolves `null` (fail closed — never a wrong-Realm
   * pick).
   * 
   * @example
   * ```typescript
   * const current = sandboxStore.selectedAgent;
   * if (current) {
   *   console.log(`Focused on ${current.name} (${current.state})`);
   * }
   * ```
   */
  get selectedAgent(): AgentStateSnapshot | null {
    if (!this.selectedAgentKey) return null;
    const exact = this.agents.find((agent) => agent.identityKey === this.selectedAgentKey);
    if (exact) return exact;
    const matches = this.agents.filter((agent) => agent.id === this.selectedAgentKey);
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Derived bare realm-local id of the selected agent, or `null` when no
   * agent is selected. Legacy read surface: selection is keyed by
   * `selectedAgentKey`, so two same-literal-id registrations resolve
   * independently through the key while this getter stays the realm-opaque
   * display/label form.
   * 
   * @example
   * ```typescript
   * console.log('Currently focused agent:', sandboxStore.selectedAgentId);
   * ```
   */
  get selectedAgentId(): string | null {
    return this.selectedAgent?.id ?? null;
  }

  /**
   * Pure derived conversational message history for the currently selected agent.
   * 
   * @example
   * ```typescript
   * const history = sandboxStore.agentMessages;
   * console.log(`Selected agent has ${history.length} messages.`);
   * ```
   */
  get agentMessages(): ReadonlyArray<HistoryMessage> {
    return this.selectedAgent?.history || [];
  }

  /**
   * Pure derived boolean returning `true` if the selected agent is actively generating text,
   * thinking/reasoning, or executing tools (`state === RUNNING` or active stream buffers).
   * 
   * @example
   * ```typescript
   * if (sandboxStore.isAgentStreaming) {
   *   console.log('Agent is actively generating tokens...');
   * }
   * ```
   */
  get isAgentStreaming(): boolean {
    if (!this.selectedAgent) return false;
    return (
      this.selectedAgent.state === AGENT_STATES.RUNNING ||
      Boolean(this.selectedAgent.currentStream) ||
      Boolean(this.selectedAgent.currentReasoning)
    );
  }

  /**
   * In-flight prose token stream currently being generated by the selected agent.
   * Returns empty string `""` when idle.
   * 
   * @example
   * ```typescript
   * console.log('Live prose bubble:', sandboxStore.streamingProse);
   * ```
   */
  get streamingProse(): string {
    return this.selectedAgent?.currentStream || '';
  }

  /**
   * In-flight thinking / reasoning token stream currently being generated by the selected agent.
   * Returns empty string `""` when idle.
   * 
   * @example
   * ```typescript
   * console.log('Live reasoning accordion:', sandboxStore.streamingReasoning);
   * ```
   */
  get streamingReasoning(): string {
    return this.selectedAgent?.currentReasoning || '';
  }

  /**
   * Active tool calls currently executing in the selected agent's turn.
   * 
   * @example
   * ```typescript
   * const toolCalls = sandboxStore.activeToolCalls;
   * for (const tc of toolCalls) {
   *   console.log(`Executing tool ${tc.name} with args:`, tc.args);
   * }
   * ```
   */
  get activeToolCalls(): ReadonlyArray<ToolCallSnapshot> {
    return this.selectedAgent?.activeToolCalls || [];
  }

  /**
   * Alphabetically sorted list of `FileRecord` entries (with `content`, `workspaceId`, and
   * full metadata) residing in `activeFsWorkspace`.
   * 
   * @example
   * ```typescript
   * for (const file of sandboxStore.activeFsFiles) {
   *   console.log(`File: ${file.path} (${file.size} bytes)`);
   * }
   * ```
   */
  get activeFsFiles(): ReadonlyArray<FileRecord> {
    const ws = this.fsSnapshot[this.#resolveFsSnapshotKey(this.activeFsWorkspace)];
    if (!ws) return [];
    return Object.values(ws).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Operator-facing partition listing of the VirtualFS snapshot (ticket
   * 7571ce5): the literal shared `global` workspace, every registered Realm's
   * realm-global partition, every active registration's resolved private
   * workspace, and every remaining literal/pinned/orphaned snapshot key. Each
   * entry carries the internal snapshot key for exact addressing, a
   * realm-qualified display label, the Realm id/name, the partition kind, and
   * the file count read from the resolved key.
   *
   * The agent-facing `allWorkspaces` projection stays separate and
   * realm-opaque; operator surfaces (the Virtual Filesystem explorer) consume
   * this listing instead, so realm-global partitions are reachable and the
   * same bare agent id live in two Realms yields two distinct partitions.
   * Realm-global and empty agent partitions are listed even when the snapshot
   * carries no bytes yet, so they can be selected and uploaded into.
   *
   * @example
   * ```typescript
   * for (const partition of sandboxStore.fsWorkspacePartitions) {
   *   console.log(`${partition.label} [${partition.kind}] — ${partition.fileCount} file(s)`);
   * }
   * ```
   */
  get fsWorkspacePartitions(): ReadonlyArray<FsWorkspacePartition> {
    const partitions: FsWorkspacePartition[] = [];
    const seen = new Set<string>();
    const register = (key: string, label: string, realmId: string | null, kind: FsWorkspacePartitionKind): void => {
      if (!key || seen.has(key)) return;
      seen.add(key);
      partitions.push(Object.freeze({
        key,
        label,
        realmId,
        realmName: realmId ? this.#realmDisplayName(realmId) : null,
        kind,
        fileCount: this.#fsPartitionFileCount(key)
      }));
    };

    // Active registrations first: the projected private workspace key (an
    // explicit pin, the canonical identity key, or the legacy bare id) labels
    // the snapshot key it actually owns. The agent projection is read as the
    // reactive dependency of this listing (the identity port itself is not
    // reactive), and it doubles as the active-registration guard.
    const activeIds = new Set(this.agents.map((agent) => (agent && typeof agent.id === 'string' ? agent.id : '')).filter(Boolean));
    const projections = (this.#identityPort ? this.#identityPort.listAgentIdentities() : [])
      .filter((projection) => Boolean(projection) && activeIds.has(projection.id));
    const projectionByKey = new Map<string, AgentIdentityProjection>();
    for (const projection of projections) {
      const key = resolveAgentPrivateWorkspaceKey(projection);
      if (!key || isReservedWorkspaceKey(key) || projectionByKey.has(key)) continue;
      projectionByKey.set(key, projection);
    }

    register('global', 'global', null, 'global');

    for (const key of Object.keys(this.fsSnapshot)) {
      if (key === 'global') continue;
      const projection = projectionByKey.get(key);
      if (projection) {
        register(key, this.#agentPartitionLabel(projection), this.#projectionRealmId(projection), 'agent');
        continue;
      }
      const realmGlobalRealmId = this.#realmGlobalPartitionRealmId(key);
      if (realmGlobalRealmId) {
        register(key, `${this.#realmDisplayName(realmGlobalRealmId)} · global`, realmGlobalRealmId, 'realm-global');
        continue;
      }
      const canonical = parseAgentIdentityKey(key);
      if (canonical) {
        // Orphaned canonical key (a recycled/removed registration): keep its
        // bytes reachable for the operator instead of collapsing them onto
        // the shared `global` label.
        register(
          key,
          canonical.realmId ? `${this.#realmDisplayName(canonical.realmId)} · ${canonical.agentId}` : canonical.agentId,
          canonical.realmId,
          'agent'
        );
        continue;
      }
      // Ordinary literal/pinned workspace key: pass through verbatim.
      register(key, key, null, 'workspace');
    }

    // Upload targets with no bytes yet: every active registration's partition
    // and every registered Realm's realm-global partition.
    for (const projection of projections) {
      const key = resolveAgentPrivateWorkspaceKey(projection);
      if (!key || isReservedWorkspaceKey(key)) continue;
      register(key, this.#agentPartitionLabel(projection), this.#projectionRealmId(projection), 'agent');
    }
    // Legacy/identity-port-less registrations: the bare id is the private
    // workspace key when no projection resolved one, keeping the pre-Wave-I
    // pill parity for hosts without an identity port.
    const projectedIds = new Set(projections.map((projection) => projection.id));
    for (const agent of this.agents) {
      const id = agent && typeof agent.id === 'string' ? agent.id : '';
      if (!id || projectedIds.has(id)) continue;
      const rawRealm = agent.config && typeof agent.config.realmId === 'string' ? agent.config.realmId.trim() : '';
      const realmId = rawRealm || null;
      register(id, realmId ? `${this.#realmDisplayName(realmId)} · ${id}` : id, realmId, 'agent');
    }
    for (const realm of this.realms) {
      register(realmGlobalWorkspaceKey(realm.id), `${realm.name} · global`, realm.id, 'realm-global');
    }

    return partitions;
  }

  /**
   * Operator partition descriptor of `activeFsWorkspace` (ticket 7571ce5):
   * the listed partition the current selection addresses, or `null` when the
   * selection resolves to no listed partition (a stale literal label).
   *
   * @example
   * ```typescript
   * const partition = sandboxStore.activeFsPartition;
   * console.log(partition ? `${partition.label} (${partition.fileCount})` : 'unlisted workspace');
   * ```
   */
  get activeFsPartition(): FsWorkspacePartition | null {
    const key = this.#resolveFsSnapshotKey(this.activeFsWorkspace) || 'global';
    return this.fsWorkspacePartitions.find((partition) => partition.key === key) ?? null;
  }

  /**
   * Set of all available workspace IDs across the sandbox (`'global'`, active agent IDs, partitioned directories).
   * 
   * @example
   * ```typescript
   * console.log('Available workspaces:', sandboxStore.allWorkspaces);
   * ```
   */
  get allWorkspaces(): ReadonlyArray<string> {
    const set = new Set(['global']);
    for (const agent of this.agents) {
      set.add(agent.id);
    }
    // Wave I (ticket d57cbc1): the snapshot stays keyed by internal storage
    // keys, but the user-visible list projects each one to its realm-opaque
    // label — a canonical identity key becomes the bare agent id and a
    // realm-global partition key becomes `global`.
    for (const wsId of Object.keys(this.fsSnapshot)) {
      set.add(this.#publicWorkspaceKey(wsId));
    }
    return Array.from(set);
  }

  /**
   * Aggregate telemetry statistics (agent counts by state, token totals, file counts, message volume).
   * 
   * @example
   * ```typescript
   * const stats = sandboxStore.stats;
   * console.log(`Total tokens used across studio: ${stats.cumulativeTotalTokens}`);
   * ```
   */
  get stats(): SandboxTelemetryStats {
    let running = 0;
    let idle = 0;
    let errored = 0;
    let waiting = 0;
    let terminated = 0;

    for (const agent of this.agents) {
      if (agent.state === AGENT_STATES.RUNNING) running++;
      else if (agent.state === AGENT_STATES.IDLE) idle++;
      else if (agent.state === AGENT_STATES.ERRORED) errored++;
      else if (agent.state === AGENT_STATES.TERMINATED) terminated++;
      else if (agent.state && agent.state.startsWith('waiting')) waiting++;
    }

    let totalFiles = 0;
    for (const ws of Object.values(this.fsSnapshot)) {
      if (ws && typeof ws === 'object') {
        totalFiles += Object.keys(ws).length;
      }
    }

    const activeTimers = this.scheduledTimers.filter(t => t.status === 'pending').length;

    let cumulativeInputTokens = 0;
    let cumulativeCachedInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let cumulativeTotalTokens = 0;
    let terminalStops = 0;
    let injectedDeliveries = 0;
    let precallCount = 0;

    const allTrackedAgents = [...this.agents, ...this.recycleBin];
    for (const agent of allTrackedAgents) {
      if (agent.telemetry) {
        cumulativeInputTokens += agent.telemetry.inputTokens || 0;
        cumulativeCachedInputTokens += agent.telemetry.cachedInputTokens || 0;
        cumulativeOutputTokens += agent.telemetry.outputTokens || 0;
        cumulativeTotalTokens += agent.telemetry.totalTokens || 0;
        terminalStops += agent.telemetry.terminalStops || 0;
        injectedDeliveries += agent.telemetry.injectedDeliveries || 0;
        precallCount += agent.telemetry.precallCount || 0;
      }
    }

    return {
      total: this.agents.length,
      running,
      idle,
      errored,
      waiting,
      terminated,
      totalMessages: this.messages.length,
      totalFiles,
      activeTimers,
      totalTimers: this.scheduledTimers.length,
      terminalStops,
      injectedDeliveries,
      precallCount,
      cumulativeInputTokens,
      cumulativeCachedInputTokens,
      cumulativeOutputTokens,
      cumulativeTotalTokens
    };
  }

  /**
   * Narrative clock state (`totalSeconds`, `formattedTime`, `day`) for the selected agent partition or global.
   * 
   * @example
   * ```typescript
   * const clock = sandboxStore.selectedAgentClock;
   * console.log(`In-universe time: Day ${clock?.day}, ${clock?.formattedTime}`);
   * ```
   */
  get selectedAgentClock(): AgentClockState | null {
    // Defect 7d2c314: the selected registration's canonical partition is
    // addressed exactly; the legacy bare fallback would collide for a
    // same-literal-id pair.
    const targetId = this.selectedAgent?.identityKey || 'global';
    return this.clockSnapshot[this.#agentPartitionKey(targetId)] || this.clockSnapshot['global'] || null;
  }

  /**
   * Narrative events list and counts for the selected agent partition or global.
   * 
   * @example
   * ```typescript
   * const events = sandboxStore.selectedAgentEvents;
   * console.log(`Active narrative events: ${events.activeCount}/${events.count}`);
   * ```
   */
  get selectedAgentEvents(): AgentEventsQueryState {
    if (!this.#worldClock || typeof this.#worldClock.queryEvents !== 'function') {
      return {
        events: [],
        activeEvents: [],
        count: 0,
        activeCount: 0,
        pendingCount: 0
      };
    }
    const targetId = this.selectedAgent?.identityKey || 'global';
    // Self-scope read: the selected agent's own partition plus public global
    // events; caller-declared privilege flags never widen visibility. Wave I
    // (ticket d57cbc1): the agent-scoped context forwards the canonical
    // `callerKey` once the runtime keys partitions canonically.
    const res = this.#worldClock.queryEvents({}, this.#agentScopedClockContext(targetId));
    return {
      events: res.events || [],
      activeEvents: res.activeEvents || [],
      count: res.count || 0,
      activeCount: res.activeCount || 0,
      pendingCount: res.pendingCount || 0
    };
  }

  // ==========================================================================
  // Agent Lifecycle Management
  // ==========================================================================

  /**
   * Ergonomic alias for {@link launchAgent}. Provisions and selects a new agent instance.
   * 
   * @param config - Complete launch configuration for the agent.
   * @param initialPrompt - Optional initial prompt message to execute immediately upon launch.
   * @returns Promise resolving to the normalized `AgentStateSnapshot` of the spawned agent.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} If configuration is invalid.
   * 
   * @example
   * ```typescript
   * const writer = await sandboxStore.spawnAgent({
   *   id: 'agent-writer',
   *   name: 'World Writer',
   *   role: 'Author'
   * });
   * ```
   */
  async spawnAgent(config: AgentConfig, initialPrompt: string | object | null = null): Promise<AgentStateSnapshot> {
    return this.launchAgent(config, initialPrompt);
  }

  /**
   * Provisions, registers, and automatically selects a new agent instance in runtime.
   * Schedules debounced auto-persistence upon successful creation.
   *
   * Operator authority (MOD-21 W6; Wave I, ticket c02d0b9): the store injects
   * the runtime's host operator principal as the launch principal, so
   * `privileged: true` launches are validated operator grant requests — never
   * self-grants — and work with zero registered agents (no director needed).
   * The launch config is sanitized first: a `realmBypass` claim is stripped
   * (the grant is the explicit `grantRealmBypass` action only) and an explicit
   * `realmId: null` falls through to the Generic default (the null system scope
   * is the engine bootstrap's).
   *
   * @param config - Complete launch configuration defining agent id, name, role, system prompt, and model hyper-parameters.
   * @param initialPrompt - Optional initial prompt message to execute immediately upon launch; a pre-instantiated model instance is accepted here for legacy positional compatibility.
   * @param history - Optional trusted baked-history entries (Wave T, ticket 0df20ae) seeded at launch through the runtime's unified `history` option: `[system, ...declared]` with launch-generated ids and no model call. Read from the unified launch path only; the legacy positional path ignores it.
   * @param extensionGrants - Trusted effective extension grant set (extension wave, P2.4) precomputed by an internal caller that already holds the resolution (the template-launch loop); `null`/omitted computes it from the member's Realm universe × `config.extensionTools`. Never read from caller claims.
   * @returns Promise resolving to the normalized `AgentStateSnapshot` of the launched agent.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} If configuration is missing required fields.
   * @throws Error with code `'PERMISSION_DENIED'` when a privileged spawn lacks operator lifecycle authority.
   *
   * @example
   * ```typescript
   * const scout = await sandboxStore.launchAgent({
   *   id: 'agent-scout',
   *   name: 'Scout Unit Alpha',
   *   role: 'Field Reconnaissance',
   *   systemPrompt: 'You collect sector telemetry and deposit it in global /mission_report.json.',
   *   modelConfig: { modelId: 'deepseek-v4-flash' }
   * });
   * console.log(`Launched ${scout.name} with ID: ${scout.id}`);
   * ```
   */
  async launchAgent(
    config: AgentConfig,
    initialPrompt: string | object | null = null,
    history: readonly LaunchHistoryEntry[] | null = null,
    extensionGrants: readonly string[] | null = null
  ): Promise<AgentStateSnapshot> {
    if (!config || typeof config !== 'object' || !config.id) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }
    this.isLaunchingAgent = true;
    this.error = null;

    try {
      // Human operator launch (MOD-21 W6; Wave I, ticket c02d0b9): the store
      // injects the runtime's host operator principal so the runtime validates
      // any `privileged: true` grant request against it. The principal exists
      // with zero agents, so a privileged spawn needs no director.
      // Legacy positional bridge: callers historically pass a pre-instantiated
      // model as the second argument, so an object there is treated as the model.
      const operatorContext = this.#operatorContext();
      const modelFromSecondArg = initialPrompt !== null && typeof initialPrompt === 'object';
      const configWithRuntimeBindings = config as AgentConfig & { model?: ModelInterface | null; provider?: ProviderInterface | null };
      // Wave I (ticket c02d0b9): the grant is never a launch field and the
      // null system scope is never a user launch choice — the store strips a
      // caller-supplied `realmBypass` claim (only the explicit
      // `grantRealmBypass` operator action can mint it) and drops an explicit
      // `realmId: null` so composition falls through to the Generic default.
      const launchConfig = sanitizeLaunchConfig(config);
      // Extension wave: the effective extension grant set is computed
      // store-side from the member's Realm universe (declared resolved tools
      // plus the attached extensions' live conflict-free catalogs capped by
      // each attachment's `toolSelection`, in sequence order) and its
      // selector, then forwarded through the runtime's trusted unified-options
      // channel. The template-launch loop passes the set it already resolved
      // (the realm record's provenance is not written until that launch
      // completes).
      const effectiveExtensionGrants: readonly string[] = extensionGrants !== null
        ? Object.freeze([...extensionGrants])
        : computeEffectiveExtensionGrants(
            resolveRealmExtensionToolUniverse(
              this.#realmRegistry.getRealm(
                typeof launchConfig.realmId === 'string' && launchConfig.realmId.trim()
                  ? launchConfig.realmId.trim()
                  : GENERIC_REALM_ID
              ),
              this.#listLiveExtensionCatalogCallNames()
            ),
            normalizeExtensionSelector(launchConfig.extensionTools)
          ).grants;
      const injectedModel: ModelInterface | null = configWithRuntimeBindings.model
        || (modelFromSecondArg ? initialPrompt as ModelInterface : null);
      const prompt = typeof initialPrompt === 'string' ? initialPrompt : null;
      // Registration-time sweep suppression (ticket 9327633): the unified
      // launch channel below already carries the store-computed effective
      // grant set, so the registration diff must not queue a redundant
      // realm-universe sweep for this key (a template launch has not yet
      // written the attachments the sweep reads). The mark is consumed by the
      // next `#syncAgents()` diff, or released here when the launch fails.
      const launchGrantKey = typeof config.id === 'string'
        ? createAgentIdentityKey(
            typeof launchConfig.realmId === 'string' && launchConfig.realmId.trim()
              ? launchConfig.realmId.trim()
              : GENERIC_REALM_ID,
            config.id.trim()
          )
        : null;
      if (launchGrantKey) this.#storeLaunchGrantedKeys.add(launchGrantKey);
      let agent: Awaited<ReturnType<AgentRuntime['launchAgent']>>;
      try {
        agent = typeof config.id === 'string'
          ? await this.#runtime.launchAgent({
              config: launchConfig,
              model: injectedModel,
              provider: configWithRuntimeBindings.provider || injectedModel?.provider || null,
              initialPrompt: prompt,
              ...(history !== null && history.length > 0 ? { history } : {}),
              // Trusted store-computed effective grants (extension wave).
              extensionTools: effectiveExtensionGrants,
              ...operatorContext
            })
          : await this.#runtime.launchAgent(launchConfig, initialPrompt);
      } catch (launchErr) {
        if (launchGrantKey) this.#storeLaunchGrantedKeys.delete(launchGrantKey);
        throw launchErr;
      }
      this.#syncAgents();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      const launchedSnapshot = this.#requireAgentSnapshot(agent.id, agent.config?.realmId ?? null);
      // A fresh launch re-derives the extension grants through the trusted
      // launch channel, so any stale safe-state queue entry or failed-heal
      // block for this registration is dropped (a relaunch of a recycled id
      // must not inherit an earlier session's guard).
      this.#dropPendingExtensionReauthorize(launchedSnapshot.identityKey);
      this.#extensionSweepBlocked.delete(launchedSnapshot.identityKey);
      this.selectAgent(launchedSnapshot.identityKey);
      this.#scheduleAutoSave();
      return launchedSnapshot;
    } catch (err) {
      this.error = thrownMessage(err, String(err));
      throw err;
    } finally {
      this.isLaunchingAgent = false;
    }
  }

  /**
   * Soft-kills an active agent, moves it to the `recycleBin` array, and terminates bus routing.
   * Preserves the complete conversational history and redo stack; evicts the agent's private
   * workspace from VirtualFS (`'global'` files survive). Re-killing an already recycled agent
   * is idempotent and reports success.
   *
   * The kill runs under the store's operator principal — the runtime's host
   * operator principal (Wave I, ticket c02d0b9) — so the human operator can
   * terminate any agent with zero agents registered. Caller-declared privilege
   * flags never authorize.
   * 
   * @param agentId - Unique ID of the agent to soft-kill.
   * @param reason - Optional human-readable reason for termination. Defaults to `'Terminated by user'`.
   * @param callerContext - Deprecated legacy fallback, ignored while the host operator principal exists; the runtime ignores its authority flags.
   * @returns `true` once the agent resides in the recycle bin.
   * @throws Error with code `'NOT_FOUND'` when the agent ID is unknown (surfaced unchanged from the runtime).
   *
   * @example
   * ```typescript
   * const success = sandboxStore.killAgent('agent-scout', 'Mission completed');
   * console.log('Agent recycled:', success);
   * ```
   */
  killAgent(agentId: string, reason: string = 'Terminated by user', callerContext: object | null = null): boolean {
    // Operator-mediated teardown (MOD-21 W6; Wave I, ticket c02d0b9): the
    // host operator principal authorizes the kill. The legacy `callerContext`
    // argument is ignored while that principal exists, and its authority flags
    // are never honored by the runtime.
    const operatorContext = this.#operatorContext();
    const authority = operatorContext.principal ? operatorContext : callerContext;
    // Action-boundary normalization (defect 7d2c314): a canonical identity
    // key or a unique bare id resolves to the exact registration; an
    // ambiguous or unresolvable reference is forwarded raw and the runtime
    // fails closed.
    const targetRef = this.#canonicalRef(agentId) || agentId;
    const selectedBefore = this.selectedAgent;
    const killed = this.#runtime.killAgent(targetRef, reason, authority);
    this.#syncAgents();
    this.#syncRecycleBin();
    this.#syncMessages();
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    if (selectedBefore && (selectedBefore.identityKey === targetRef || selectedBefore.id === agentId)) {
      this.selectAgent(this.agents.length > 0 ? this.agents[0].identityKey : null);
    }
    this.#scheduleAutoSave();
    return Boolean(killed);
  }

  /**
   * Restores a soft-killed agent from the recycle bin back into active `agents` in `IDLE` state.
   * Conversational history and the redo stack remain intact; the private workspace evicted at
   * kill time is not recreated.
   * Operator-mediated (MOD-21 W8; Wave I, ticket c02d0b9): the store forwards
   * the runtime's host operator principal, which exists with zero agents.
   * 
   * @param agentId - Unique ID of the recycled agent to restore.
   * @returns The restored `AgentStateSnapshot`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND} If agent is not found in the recycle bin.
   * 
   * @example
   * ```typescript
   * const restored = sandboxStore.restoreAgent('agent-scout');
   * console.log(`Restored ${restored.name} to active agents in ${restored.state} state.`);
   * ```
   */
  restoreAgent(agentId: string): AgentStateSnapshot {
    // Action-boundary normalization (defect 7d2c314): a canonical identity
    // key or a unique bare id resolves the exact recycled registration.
    const targetRef = this.#canonicalRef(agentId) || agentId;
    if (!targetRef || !this.#recycledSnapshotForRef(targetRef)) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND;
      throw err;
    }
    const restored = this.#runtime.restoreAgent(targetRef, this.#lifecycleAuthorityContext(targetRef));
    // Wave R (ticket 56ba4b9): membership never moves, so restore never
    // re-groups. Deletion now refuses non-empty realms and the recursive
    // override empties recycled members, so a restored member can no longer
    // carry a stale deleted-realm id by construction.
    this.#syncAgents();
    this.#syncRecycleBin();
    this.#syncMessages();
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    const restoredSnapshot = this.#requireAgentSnapshot(restored.id, restored.config?.realmId ?? null);
    // Extension wave (P2.4-F2): a restore re-registers the frozen descriptor
    // from the trusted config, and the extension axis is not part of that
    // re-registration — recompute it from the live Realm universe + the
    // member's selector and re-apply at the safe state (a restored member is
    // idle, so the sweep applies immediately; never a manual nudge).
    this.#queueExtensionReauthorize(restoredSnapshot.identityKey);
    this.selectAgent(restoredSnapshot.identityKey);
    this.#scheduleAutoSave();
    return restoredSnapshot;
  }

  /**
   * Permanently deletes a recycled or active agent, its inboxes, private workspace, and history
   * from runtime memory; the resulting removal is persisted by the store's auto-save.
   * Operator-mediated (MOD-21 W8; Wave I, ticket c02d0b9): purge is
   * sudoer-only; the store forwards the runtime's host operator principal.
   * 
   * @param agentId - Unique ID of the recycled agent to permanently purge.
   * @returns `true` if purged; `false` if agent was not found.
   * 
   * @example
   * ```typescript
   * const purged = sandboxStore.purgeAgent('agent-scout');
   * console.log('Permanently purged:', purged);
   * ```
   */
  purgeAgent(agentId: string): boolean {
    // Action-boundary normalization (defect 7d2c314): a canonical identity
    // key or a unique bare id resolves the exact registration.
    const targetRef = this.#canonicalRef(agentId) || agentId;
    const selectedBefore = this.selectedAgent;
    const purged = this.#runtime.purgeAgent(targetRef, this.#operatorContext());
    this.#syncAgents();
    this.#syncRecycleBin();
    this.#syncMessages();
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    if (selectedBefore && (selectedBefore.identityKey === targetRef || selectedBefore.id === agentId)) {
      this.selectAgent(this.agents.length > 0 ? this.agents[0].identityKey : null);
    }
    this.#scheduleAutoSave();
    return purged;
  }

  /**
   * Permanently purges all agents currently residing in the recycle bin.
   * Operator-mediated (MOD-21 W8; Wave I, ticket c02d0b9): sudoer-only; the
   * store forwards the runtime's host operator principal.
   * 
   * @returns Count of agents permanently purged.
   * 
   * @example
   * ```typescript
   * const count = sandboxStore.emptyRecycleBin();
   * console.log(`Purged ${count} agents from recycle bin.`);
   * ```
   */
  emptyRecycleBin(): number {
    const count = this.#runtime.emptyRecycleBin(this.#operatorContext());
    this.#syncAgents();
    this.#syncRecycleBin();
    this.#syncMessages();
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return count;
  }

  /**
   * Returns the reactive array of all soft-killed agent snapshots currently in the recycle bin
   * (the same reference exposed as `recycleBin`).
   * 
   * @returns Read-only array of `RecycledAgentStateSnapshot` objects.
   * 
   * @example
   * ```typescript
   * const recycledList = sandboxStore.listRecycledAgents();
   * console.log('Recycled agents count:', recycledList.length);
   * ```
   */
  listRecycledAgents(): ReadonlyArray<RecycledAgentStateSnapshot> {
    return this.recycleBin;
  }

  /**
   * Retrieves a specific soft-killed agent snapshot by ID from the recycle bin.
   * 
   * @param agentId - Unique ID of the recycled agent.
   * @returns The `RecycledAgentStateSnapshot`, or `null` if not found in the recycle bin.
   * 
   * @example
   * ```typescript
   * const agent = sandboxStore.getRecycledAgent('agent-scout');
   * if (agent) {
   *   console.log(`Found recycled agent: ${agent.name}, reason: ${agent.recycleReason}`);
   * }
   * ```
   */
  getRecycledAgent(agentId: string): RecycledAgentStateSnapshot | null {
    // Defect 7d2c314: a canonical identity key addresses its exact recycled
    // registration; the bare-id fallback keeps the legacy first-match read.
    const exact = this.recycleBin.find((agent) => agent.identityKey === agentId);
    if (exact) return exact;
    return this.recycleBin.find(a => a.id === agentId) || null;
  }

  /**
   * Updates agent name, role, system prompt, or model hyper-parameters live in-memory.
   *
   * Operator authority (MOD-21 W6; Wave I, ticket c02d0b9): the update carries
   * the runtime's host operator principal. Authority-bearing fields
   * (`privileged`, privilege flags, authority-bearing roles) and tool
   * allow-list changes are validated by the runtime against that principal before
   * any mutation — they are the explicit operator grant path, never applied
   * silently through an anonymous update.
   *
   * Realm membership (`realmId`) is immutable for every caller, the store's
   * operator principal included (Wave R, ticket 56ba4b9): changing an agent's
   * realm means terminate + relaunch into the target realm.
   *
   * @param agentId - ID of the agent to update (or empty to use `selectedAgentId`).
   * @param updatedConfig - Partial configuration update containing fields to modify.
   * @returns The updated `AgentStateSnapshot`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND} If target agent does not exist.
   * @throws Error with code `'PERMISSION_DENIED'` when an authority-bearing field lacks operator lifecycle authority.
   *
   * @example
   * ```typescript
   * const updated = sandboxStore.updateAgentConfig('director', {
   *   temperature: 0.7,
   *   systemPrompt: 'Updated high-level character directive.'
   * });
   * console.log('Updated agent config for:', updated.name);
   * ```
   */
  updateAgentConfig(agentId: string, updatedConfig: AgentConfigUpdate): AgentStateSnapshot {
    // Action-boundary normalization (defect 7d2c314): the target resolves to
    // the exact active registration (identity key first, unique bare id
    // otherwise); an empty ref falls back to the selected registration.
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef || !this.#activeSnapshotForRef(targetRef)) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND;
      throw err;
    }
    // Operator-mediated update (MOD-21 W6; Wave I, ticket c02d0b9):
    // authority-bearing fields (`privileged`, privilege flags, authority
    // roles) are validated by the runtime against the host operator principal
    // before any mutation; they are never applied silently through an
    // anonymous update.
    const updated = this.#runtime.updateAgentConfig(targetRef, updatedConfig, this.#operatorContext());
    // Safe-state extension sweep (extension wave, P2.4): a per-agent extension
    // selector edit recomputes the effective grant set. The selector state was
    // applied by the runtime update above; the descriptor axis follows at the
    // next safe state — immediately for an idle member, on the next
    // `turn_complete` for a busy one — never mid-turn.
    if (
      updatedConfig
      && typeof updatedConfig === 'object'
      && (updatedConfig as { extensionTools?: unknown }).extensionTools !== undefined
    ) {
      // A successful operator selector edit clears a failed-heal block: the
      // live selector is now the operator's explicit intent.
      this.#extensionSweepBlocked.delete(targetRef);
      this.#queueExtensionReauthorize(targetRef);
    }
    this.#syncAgents();
    this.#scheduleAutoSave();
    return this.#requireAgentSnapshot(updated.id, updated.config?.realmId ?? null);
  }

  /**
   * Grants the cross-Realm `realmBypass` authority to one active agent (user
   * operator action, Wave I ticket c02d0b9).
   *
   * The store delegates to the runtime under its host operator principal by
   * exact reference; the runtime records the grant in the agent's frozen
   * authority inputs and rebuilds the descriptor, so the identity projection
   * reports the bypass — never an id. The grant is per-agent (never ambient)
   * and never moves Realm membership (immutable). The debounced autosave is
   * scheduled so the active grant list persists with the session snapshot.
   *
   * Targeting is additive (Wave I, ticket d57cbc1; fix lane F3): a canonical
   * identity key passed as `agentId` resolves its exact registration, and an
   * optional realm-exact `scope` (`{ realmId }`) composes that key, so the
   * same literal id registered in two Realms is addressable without ambiguity.
   * A bare id without a scope keeps the unique-match rule and fails closed
   * (`null`) when it is ambiguous.
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key; trimmed).
   * @param scope - Optional trusted resolution scope (`{ realmId }` targets realm-exactly).
   * @returns The rebuilt frozen authority descriptor, or `null` for an unknown or recycled id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When `agentId` is not a non-empty string.
   *
   * @example
   * ```typescript
   * const descriptor = await sandboxStore.grantRealmBypass('agent-scout');
   * const scoped = await sandboxStore.grantRealmBypass('scout', { realmId: 'realm_alpha' });
   * console.log('Bypass granted:', descriptor?.realmBypass === true);
   * ```
   */
  async grantRealmBypass(agentId: string, scope?: AgentIdentityScope): Promise<AuthorityDescriptor | null> {
    const targetId = typeof agentId === 'string' ? agentId.trim() : '';
    if (!targetId) {
      const err: CodedError = new Error(
        `${SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS}: grantRealmBypass requires a non-empty agent id`
      );
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }
    const descriptor = this.#runtime.grantRealmBypass(resolveRealmBypassTargetRef(targetId, scope), this.#operatorContext());
    this.#scheduleAutoSave();
    return descriptor;
  }

  /**
   * Revokes the cross-Realm `realmBypass` authority from one active agent
   * (user operator action, Wave I ticket c02d0b9).
   *
   * Same authority, validation, and additive targeting contract as
   * {@link grantRealmBypass}: the store delegates to the runtime under its
   * host operator principal, membership and capability are untouched, and the
   * revocation persists through the debounced autosave. A canonical identity
   * key or a realm-exact `scope` addresses the exact same-id registration.
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key; trimmed).
   * @param scope - Optional trusted resolution scope (`{ realmId }` targets realm-exactly).
   * @returns The rebuilt frozen authority descriptor, or `null` for an unknown or recycled id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When `agentId` is not a non-empty string.
   *
   * @example
   * ```typescript
   * const descriptor = await sandboxStore.revokeRealmBypass('agent-scout');
   * const scoped = await sandboxStore.revokeRealmBypass('scout', { realmId: 'realm_alpha' });
   * console.log('Bypass revoked:', descriptor?.realmBypass === false);
   * ```
   */
  async revokeRealmBypass(agentId: string, scope?: AgentIdentityScope): Promise<AuthorityDescriptor | null> {
    const targetId = typeof agentId === 'string' ? agentId.trim() : '';
    if (!targetId) {
      const err: CodedError = new Error(
        `${SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS}: revokeRealmBypass requires a non-empty agent id`
      );
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }
    const descriptor = this.#runtime.revokeRealmBypass(resolveRealmBypassTargetRef(targetId, scope), this.#operatorContext());
    this.#scheduleAutoSave();
    return descriptor;
  }

  /**
   * Grants one explicit authority id (with an optional registry-side scope) to
   * one active agent (operator action, M1 generic grant API).
   *
   * Same authority, validation, and additive targeting contract as
   * {@link grantRealmBypass}: the store delegates to the runtime under its host
   * operator principal, the id and scope are validated by the runtime grant
   * core (`INVALID_CONFIG` for unknown ids or malformed scopes), the capability
   * selector and Realm membership are untouched, and the grant persists
   * additively (publishing pair → legacy `metaAuthorityGrants`; every other id
   * → `authorityGrants`) so hydration re-applies it. A canonical identity key
   * or a realm-exact `identityScope` addresses the exact same-id registration.
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key; trimmed).
   * @param authorityId - Exact `AUTHORITY_IDS` member to grant.
   * @param scope - Optional registry-side scope narrowed to the id's class vocabulary.
   * @param identityScope - Optional trusted resolution scope (`{ realmId }` targets realm-exactly).
   * @returns The rebuilt frozen authority descriptor, or `null` for an unknown or recycled id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When `agentId` is not a non-empty string.
   */
  async grantAuthority(
    agentId: string,
    authorityId: string,
    scope: AuthorityScopeRecord | null = null,
    identityScope?: AgentIdentityScope
  ): Promise<AuthorityDescriptor | null> {
    const targetId = typeof agentId === 'string' ? agentId.trim() : '';
    if (!targetId) {
      const err: CodedError = new Error(
        `${SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS}: grantAuthority requires a non-empty agent id`
      );
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }
    const descriptor = this.#runtime.grantAuthority(
      resolveRealmBypassTargetRef(targetId, identityScope),
      authorityId,
      scope,
      this.#operatorContext()
    );
    this.#scheduleAutoSave();
    return descriptor;
  }

  /**
   * Revokes one explicit authority id from one active agent (operator action,
   * M1 generic grant API).
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key; trimmed).
   * @param authorityId - Exact `AUTHORITY_IDS` member to revoke.
   * @param identityScope - Optional trusted resolution scope (`{ realmId }` targets realm-exactly).
   * @returns The rebuilt frozen authority descriptor, or `null` for an unknown or recycled id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When `agentId` is not a non-empty string.
   */
  async revokeAuthority(
    agentId: string,
    authorityId: string,
    identityScope?: AgentIdentityScope
  ): Promise<AuthorityDescriptor | null> {
    const targetId = typeof agentId === 'string' ? agentId.trim() : '';
    if (!targetId) {
      const err: CodedError = new Error(
        `${SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS}: revokeAuthority requires a non-empty agent id`
      );
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }
    const descriptor = this.#runtime.revokeAuthority(
      resolveRealmBypassTargetRef(targetId, identityScope),
      authorityId,
      this.#operatorContext()
    );
    this.#scheduleAutoSave();
    return descriptor;
  }

  /**
   * Grants the explicit `@template:authority` publishing capability to one
   * active agent (operator action, Wave U ticket 2518510; delegates to
   * {@link grantAuthority}, persisting through the legacy
   * `metaAuthorityGrants` partition).
   *
   * A canonical identity key or a realm-exact `scope` addresses the exact
   * same-id registration.
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key; trimmed).
   * @param scope - Optional trusted resolution scope (`{ realmId }` targets realm-exactly).
   * @returns The rebuilt frozen authority descriptor, or `null` for an unknown or recycled id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When `agentId` is not a non-empty string.
   */
  async grantTemplateAuthority(agentId: string, scope?: AgentIdentityScope): Promise<AuthorityDescriptor | null> {
    return this.grantAuthority(agentId, AGENT_AUTHORITIES.TEMPLATE, null, scope);
  }

  /**
   * Revokes the explicit `@template:authority` publishing capability from one
   * active agent (operator action, Wave U ticket 2518510; delegates to
   * {@link revokeAuthority}).
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key; trimmed).
   * @param scope - Optional trusted resolution scope (`{ realmId }` targets realm-exactly).
   * @returns The rebuilt frozen authority descriptor, or `null` for an unknown or recycled id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When `agentId` is not a non-empty string.
   */
  async revokeTemplateAuthority(agentId: string, scope?: AgentIdentityScope): Promise<AuthorityDescriptor | null> {
    return this.revokeAuthority(agentId, AGENT_AUTHORITIES.TEMPLATE, scope);
  }

  /**
   * Grants the explicit `@hydration:authority` publishing capability to one
   * active agent (operator action, Wave U ticket 2518510; delegates to
   * {@link grantAuthority}).
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key; trimmed).
   * @param scope - Optional trusted resolution scope (`{ realmId }` targets realm-exactly).
   * @returns The rebuilt frozen authority descriptor, or `null` for an unknown or recycled id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When `agentId` is not a non-empty string.
   */
  async grantHydrationAuthority(agentId: string, scope?: AgentIdentityScope): Promise<AuthorityDescriptor | null> {
    return this.grantAuthority(agentId, AGENT_AUTHORITIES.HYDRATION, null, scope);
  }

  /**
   * Revokes the explicit `@hydration:authority` publishing capability from one
   * active agent (operator action, Wave U ticket 2518510; delegates to
   * {@link revokeAuthority}).
   *
   * @param agentId - Active agent identifier (bare realm-local id or canonical identity key; trimmed).
   * @param scope - Optional trusted resolution scope (`{ realmId }` targets realm-exactly).
   * @returns The rebuilt frozen authority descriptor, or `null` for an unknown or recycled id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When `agentId` is not a non-empty string.
   */
  async revokeHydrationAuthority(agentId: string, scope?: AgentIdentityScope): Promise<AuthorityDescriptor | null> {
    return this.revokeAuthority(agentId, AGENT_AUTHORITIES.HYDRATION, scope);
  }

  /**
   * Lists the active agents currently holding explicit authority grants (M1),
   * as frozen canonical `(realmId, agentId)` identity keys per authority id.
   * Ids with no holder are omitted.
   *
   * The listing is registry state, not authority: the UI uses it to render the
   * operator authority toggles, and the store uses it to persist grants. Keys
   * are internal-only and never reach an agent-facing surface.
   *
   * @returns Frozen canonical identity keys per authority id.
   */
  listAuthorityGrants(): Readonly<Record<string, readonly string[]>> {
    const listing = this.#runtime.listAuthorityGrants();
    const frozen: Record<string, readonly string[]> = {};
    for (const authorityId of Object.keys(listing)) {
      Object.defineProperty(frozen, authorityId, {
        value: Object.freeze([...listing[authorityId]]),
        writable: false,
        enumerable: true,
        configurable: false
      });
    }
    return Object.freeze(frozen);
  }

  /**
   * Lists the exportable authority-grant entries of the active agents with
   * their registry-side scopes (M2 projection; ticket 62d89b8 operator
   * authority editor): per authority id, frozen `{ ref, scope }` details where
   * a legacy unscoped grant (the bare canonical identity-key string) is
   * normalized to `scope: null`. This is the scope-aware companion of
   * `listAuthorityGrants` that lets the Agent Settings authority editor
   * render and round-trip existing narrowings; every entry is preserved — a
   * scoped grant is never flattened and an unscoped grant is never widened.
   *
   * Host/operator-only surface: scopes are registry-side data — they never
   * reach an agent-facing receipt, listing, error, descriptor, schema, or
   * audit payload. The returned record, every entry, and every scope (with its
   * list arrays) are deep-frozen copies, so a caller can never mutate registry
   * state through this projection.
   *
   * @returns Frozen `{ ref, scope }` entries per authority id (declaration order; ids with no holder omitted).
   */
  listAuthorityGrantDetails(): Readonly<
    Record<string, readonly { ref: string; scope: AuthorityScopeRecord | null }[]>
  > {
    const listing = this.#runtime.listAuthorityGrantRecords();
    const frozen: Record<string, readonly { ref: string; scope: AuthorityScopeRecord | null }[]> = {};
    for (const authorityId of Object.keys(listing)) {
      const entries = listing[authorityId];
      const projected: { ref: string; scope: AuthorityScopeRecord | null }[] = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (typeof entry === 'string') {
          projected[projected.length] = Object.freeze({ ref: entry, scope: null });
          continue;
        }
        const hasScope = Boolean(entry.scope) && Object.keys(entry.scope as AuthorityScopeRecord).length > 0;
        projected[projected.length] = Object.freeze({
          ref: entry.ref,
          scope: hasScope ? freezeAuthorityScopeCopy(entry.scope as AuthorityScopeRecord) : null
        });
      }
      Object.defineProperty(frozen, authorityId, {
        value: Object.freeze(projected),
        writable: false,
        enumerable: true,
        configurable: false
      });
    }
    return Object.freeze(frozen);
  }

  /**
   * Lists the active agents currently holding the Wave U publishing-authority
   * grants (Wave U ticket 2518510), as canonical `(realmId, agentId)` identity
   * keys per authority — the source-compatible projection of the `template`/
   * `hydration` slice of {@link listAuthorityGrants}.
   *
   * @returns Canonical identity keys per publishing authority (frozen copies).
   */
  listMetaAuthorityGrants(): { template: readonly string[]; hydration: readonly string[] } {
    const listing = this.listAuthorityGrants();
    return Object.freeze({
      template: Object.freeze([...(listing[AGENT_AUTHORITIES.TEMPLATE] ?? [])]),
      hydration: Object.freeze([...(listing[AGENT_AUTHORITIES.HYDRATION] ?? [])])
    });
  }

  /**
   * Lists the persisted per-template authority trust records (Wave U ticket
   * 2518510): template id → agent key → previously approved authority ids.
   *
   * Trust is operator intent only: a later launch auto-approves exact declared
   * matches; it never grants authority by itself. The returned record is a
   * frozen copy.
   *
   * @returns Frozen trust record keyed by template id.
   */
  listTemplateAuthorityTrust(): Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> {
    const listing: Record<string, Record<string, readonly string[]>> = Object.create(null);
    for (const [templateId, agents] of this.#templateAuthorityTrust) {
      const agentRecord: Record<string, readonly string[]> = Object.create(null);
      for (const [agentKey, authorities] of agents) {
        Object.defineProperty(agentRecord, agentKey, {
          value: Object.freeze([...authorities]),
          enumerable: true,
          writable: false,
          configurable: false
        });
      }
      Object.defineProperty(listing, templateId, {
        value: Object.freeze(agentRecord),
        enumerable: true,
        writable: false,
        configurable: false
      });
    }
    return Object.freeze(listing);
  }

  /**
   * Clears the "trust this template" override for one template id (Wave U
   * ticket 2518510).
   *
   * Clearing removes the persisted trust record, so future launches of the
   * template no longer auto-approve its exact previously approved set — every
   * declared authority re-prompts. Already-applied grants are ordinary
   * registry grants and stay revocable through the grant methods; clearing
   * trust never revokes them implicitly.
   *
   * @param templateId - Template id whose trust record is removed.
   * @returns `true` when a record existed and was removed; `false` otherwise.
   */
  clearTemplateAuthorityTrust(templateId: string): boolean {
    if (typeof templateId !== 'string' || templateId.trim().length === 0) return false;
    const id = templateId;
    if (!this.#templateAuthorityTrust.has(id)) return false;
    this.#templateAuthorityTrust.delete(id);
    this.#scheduleAutoSave();
    return true;
  }

  /**
   * Idempotently verifies and provisions the root Director Meta-Agent if absent.
   * 
   * @returns Promise resolving to the Director's `AgentStateSnapshot`.
   * 
   * @example
   * ```typescript
   * const director = await sandboxStore.ensureDirector();
   * console.log(`Director confirmed: ${director.id}`);
   * ```
   */
  async ensureDirector(): Promise<AgentStateSnapshot> {
    const director = await this.#runtime.ensureDirector();
    this.#syncAgents();
    this.#syncClockSnapshot();
    // System-scope resolution (defect 7d2c314): the adopted director is the
    // bootstrap-only `realmId: null` registration, never a realm-local
    // same-literal-id member.
    return this.#requireAgentSnapshot(director.id, director.config?.realmId ?? null);
  }

  /**
   * Changes the focused agent for chat conversation, action input, and telemetry inspection.
   * Persists selection preference to storage.
   *
   * Resolution (defect 7d2c314): an exact canonical `identityKey` match wins;
   * otherwise the reference is filtered by bare id (plus Realm when `realmId`
   * is supplied) and a unique match selects its canonical key. An unresolvable
   * or ambiguous reference is stored raw — `selectedAgent` then resolves it
   * only while it is unique and otherwise fails closed.
   * 
   * @param agentId - Canonical identity key, bare agent id, or `null` to clear selection.
   * @param realmId - Optional Realm scope for a bare id (`null` = system scope).
   * 
   * @example
   * ```typescript
   * sandboxStore.selectAgent('agent-scout');
   * sandboxStore.selectAgent('director', null);
   * console.log('Selected agent:', sandboxStore.selectedAgent?.name);
   * ```
   */
  selectAgent(agentId: string | null, realmId?: string | null): void {
    const ref = typeof agentId === 'string' && agentId ? agentId : null;
    if (!ref) {
      this.selectedAgentKey = null;
      this.#scheduleAutoSave();
      return;
    }
    const exact = this.agents.find((agent) => agent.identityKey === ref);
    if (exact) {
      this.selectedAgentKey = exact.identityKey;
      this.#scheduleAutoSave();
      return;
    }
    const scoped = realmId !== undefined;
    const candidates = this.agents.filter((agent) => agent.id === ref
      && (!scoped || (agent.config?.realmId ?? null) === (realmId ?? null)));
    if (candidates.length === 1) {
      this.selectedAgentKey = candidates[0].identityKey;
      this.#scheduleAutoSave();
      return;
    }
    // An explicit Realm scope is authoritative: a scoped miss fails closed
    // instead of falling through to another scope's same-literal-id twin.
    this.selectedAgentKey = scoped ? null : ref;
    this.#scheduleAutoSave();
  }

  // ==========================================================================
  // Turn Execution & Conversational Resilience
  // ==========================================================================

  /**
   * Submits a conversational prompt turn to the currently selected agent.
   * Accepts orchestrator action modes (`'directive'`, `'system'`, `'injection'`) and the
   * legacy category strings `'do'`, `'say'`, and `'story'`, which execute as directives.
   * Clears the agent's persistent draft input upon successful submission.
   *
   * When the runtime exposes its `TriggerQueue`, the turn is enqueued as a
   * `TRIGGER_TYPES.USER` trigger and dispatched by `TriggerDispatcher` (single
   * dispatch point, per-agent FIFO); a direct `executeAgentTurn` call remains
   * only as the no-queue fallback.
   * 
   * @param text - Prompt or message text content.
   * @param options - ActionTurnOptions object or mode/category string (defaults to `'directive'`).
   * @returns Promise resolving to `TurnResult` containing updated agent snapshot, generated output, and tool calls.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED} If no agent is currently selected (`selectedAgentId === null`).
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED} If LLM generation or tool execution fails.
   * 
   * @example
   * ```typescript
   * const result = await sandboxStore.submitChatTurn('Analyze the sensor anomalies in Sector 4', {
   *   mode: 'directive'
   * });
   * console.log('Agent response:', result.output);
   * ```
   */
  async submitChatTurn(text: string, options: TurnOptions | string = 'directive'): Promise<TurnResult> {
    // Defect 7d2c314: the turn targets the selected registration exactly; an
    // unresolved/ambiguous selection reports NO_AGENT_SELECTED instead of
    // letting a bare-id fallback retarget another Realm's twin.
    const selected = this.selectedAgent;
    if (!selected) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED;
      throw err;
    }
    const agentRef = selected.identityKey;
    const result = await this.triggerTurn(agentRef, text, options);
    this.clearAgentDraft(agentRef);
    return result;
  }

  /**
   * Triggers an execution turn for a specific target agent.
   *
   * When the runtime exposes its `TriggerQueue`, the turn is enqueued as a
   * `TRIGGER_TYPES.USER` trigger and dispatched by `TriggerDispatcher` (single
   * dispatch point, per-agent FIFO); a direct `executeAgentTurn` call remains
   * only as the no-queue fallback.
   * 
   * @param agentId - Target agent ID to execute turn (or empty to use `selectedAgentId`).
   * @param prompt - Optional prompt text string or structured prompt object.
   * @param options - ActionTurnOptions object or mode string.
   * @returns Promise resolving to `TurnResult`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED} If no agent ID is supplied and no agent is selected.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND} If target agent does not exist.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED} If execution fails.
   * 
   * @example
   * ```typescript
   * const result = await sandboxStore.triggerTurn('agent-commander', 'Authorize mission parameters', {
   *   mode: 'directive'
   * });
   * ```
   */
  async triggerTurn(agentId: string, prompt: TurnInput = null, options: TurnOptions | string = {}): Promise<TurnResult> {
    // Action-boundary normalization (defect 7d2c314): identity key or unique
    // bare id resolves the exact registration; an empty ref uses the
    // selected registration.
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED;
      throw err;
    }
    if (!this.#activeSnapshotForRef(targetRef)) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND;
      throw err;
    }

    this.error = null;
    // In-flight reactivity bridge: mirror live streaming mutations into the
    // reactive `agents` projection as chunks arrive. The turn engine already
    // forwards every chunk to `options.onChunk` (its `#runTurnCore` wires
    // `normalizedOptions.onChunk` into the model stream), so no new engine hook
    // is required. Throttled inside the mirror helper.
    const turnOptions: TurnOptions & { category?: string; onChunk?: (chunk: unknown) => void } = typeof options === 'string'
      ? { category: options }
      : { ...options };
    const upstreamOnChunk = typeof turnOptions.onChunk === 'function' ? turnOptions.onChunk : null;
    turnOptions.onChunk = (chunk: unknown) => {
      if (upstreamOnChunk) {
        try { upstreamOnChunk(chunk); } catch {
          /* Best-effort forwarding: an upstream onChunk throw must not break the live mirror. */
        }
      }
      this.#mirrorAgentLiveFields(targetRef);
    };
    // The runtime's `TurnExecutionOptions.mode` narrows to the canonical
    // orchestrator actions, while its turn engine also accepts the legacy
    // narrative strings documented on `TurnOptions` (`'do'`/`'say'`/`'story'`
    // execute as directives) and echoes the received value on turn events.
    // Bridge the documented compatibility surface unchanged at this boundary.
    const forwardedOptions = turnOptions as TurnExecutionOptions;
    try {
      // Single dispatch point: when the runtime exposes a TriggerQueue, the user
      // turn is enqueued as a TRIGGER_TYPES.USER trigger and executed by
      // TriggerDispatcher; the direct call remains only as a no-queue fallback.
      const result = (this.#runtime.triggerQueue && typeof this.#runtime.enqueueUserTurn === 'function')
        ? await this.#runtime.enqueueUserTurn(targetRef, prompt, forwardedOptions)
        : await this.#runtime.executeAgentTurn(targetRef, prompt, forwardedOptions);
      this.#syncAgents();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      this.#scheduleAutoSave();
      const updatedAgent = this.#activeSnapshotForRef(targetRef) || result?.agent;
      return {
        agent: updatedAgent,
        output: result?.output ?? '',
        toolCalls: result?.toolCalls ?? []
      };
    } catch (err) {
      const safeMessage = sanitizeDiagnosticError(thrownMessageField(err)) || SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED;
      this.error = safeMessage;
      this.#syncAgents();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      this.#scheduleAutoSave();
      const turnErr: CodedError = new Error(safeMessage);
      turnErr.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED;
      turnErr.cause = err;
      throw turnErr;
    }
  }

  /**
   * Emergency unstick engine primitive: synchronously aborts any pending in-flight turn,
   * purges streaming prose/reasoning buffers, emits `stream_reset`, transitions agent to `IDLE`,
   * and unfreezes subsequent turn submissions (INV-UNSTICK).
   * Operator-mediated (MOD-21 W8; Wave I, ticket c02d0b9): the store forwards
   * the runtime's host operator principal, which exists with zero agents.
   * 
   * @param agentId - Target agent ID to unstick (defaults to `selectedAgentId`).
   * @returns The runtime's `UnstickResult` receipt (`success`, `agent`, `previousState`, `reason`), or `{ success: false }` when no target was resolved.
   * 
   * @example
   * ```typescript
   * const unstickResult = sandboxStore.unstickAgent();
   * if (unstickResult.success) {
   *   console.log(`Unstuck agent ${unstickResult.agent?.id} from ${unstickResult.previousState}: ${unstickResult.reason}`);
   * }
   * ```
   */
  unstickAgent(agentId: string | null = null): UnstickResult {
    // Action-boundary normalization (defect 7d2c314): identity key or unique
    // bare id resolves the exact registration; an empty ref uses the
    // selected registration.
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef) return { success: false };

    const result = this.#runtime.unstickAgent(targetRef, undefined, this.#lifecycleAuthorityContext(targetRef));
    this.#syncAgents();
    this.#syncMessages();
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return result;
  }

  /**
   * Convenience alias to abort/unstick the active in-flight turn for the currently selected agent.
   * 
   * @example
   * ```typescript
   * // Triggered by UI "Stop" / "Unstick" button
   * sandboxStore.cancelActiveTurn();
   * ```
   */
  cancelActiveTurn(): void {
    if (this.selectedAgentKey) {
      this.unstickAgent(this.selectedAgentKey);
    }
  }

  /**
   * Cancels an in-flight execution turn for a specific agent.
   * Operator-mediated (MOD-21 W8; Wave I, ticket c02d0b9): the store forwards
   * the runtime's host operator principal, which exists with zero agents.
   * 
   * @param agentId - Unique ID of the agent whose turn should be cancelled.
   * 
   * @example
   * ```typescript
   * sandboxStore.cancelAgent('agent-scout');
   * ```
   */
  cancelAgent(agentId: string): void {
    // Action-boundary normalization (defect 7d2c314).
    const targetRef = this.#canonicalRef(agentId) || agentId;
    this.#runtime.cancelAgent(targetRef, undefined, this.#lifecycleAuthorityContext(targetRef));
    this.#syncAgents();
    this.#scheduleAutoSave();
  }

  /**
   * Immediately halts and cancels all active in-flight turns across all agents in runtime.
   * Operator-mediated (MOD-21 W8; Wave I, ticket c02d0b9): sudoer-only; the
   * store forwards the runtime's host operator principal.
   * 
   * @example
   * ```typescript
   * // Global emergency stop
   * sandboxStore.cancelAll();
   * ```
   */
  cancelAll(): void {
    this.#runtime.cancelAll(undefined, this.#operatorContext());
    this.#syncAgents();
    this.#scheduleAutoSave();
  }

  /**
   * Retries / resends the last failed or interrupted turn for an agent without retyping.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @returns Promise resolving to `TurnResult`, or `null` when no agent ID is supplied and no agent is selected.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED} If retry fails.
   * 
   * @example
   * ```typescript
   * const retryResult = await sandboxStore.retryAgentTurn();
   * if (retryResult) {
   *   console.log('Retried output:', retryResult.output);
   * }
   * ```
   */
  async retryAgentTurn(agentId: string | null = null): Promise<TurnResult | null> {
    // Action-boundary normalization (defect 7d2c314): identity key or unique
    // bare id resolves the exact registration; an empty ref uses the
    // selected registration.
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef) return null;
    this.error = null;
    try {
      const res = await this.#runtime.retryAgentTurn(targetRef);
      this.#syncAgents();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      this.#scheduleAutoSave();
      const updatedAgent = this.#activeSnapshotForRef(targetRef) || res?.agent;
      return {
        agent: updatedAgent,
        output: res?.output ?? '',
        toolCalls: res?.toolCalls ?? []
      };
    } catch (err) {
      const safeMessage = sanitizeDiagnosticError(thrownMessageField(err)) || SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED;
      this.error = safeMessage;
      this.#syncAgents();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      this.#scheduleAutoSave();
      const retryErr: CodedError = new Error(safeMessage);
      retryErr.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED;
      retryErr.cause = err;
      throw retryErr;
    }
  }

  /**
   * Pops the last user/assistant turn from conversational history, pushes it to the redo stack,
   * and atomically restores the undone user prompt text into the agent's draft input buffer.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @returns `UndoTurnResult` containing undone content and restored prompt, or `null` if nothing to undo.
   * 
   * @example
   * ```typescript
   * const undoResult = sandboxStore.undoAgentTurn();
   * if (undoResult) {
   *   console.log('Undone turn. Prompt restored to input:', undoResult.restoredPrompt);
   * }
   * ```
   */
  undoAgentTurn(agentId: string | null = null): UndoTurnResult | null {
    // Action-boundary normalization (defect 7d2c314).
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef) return null;
    const runtimeRes = this.#runtime.undoAgentTurn(targetRef);
    if ('success' in runtimeRes) {
      // Selection failures require an explicit turn selector; this surface
      // never forwards one, so the runtime always returns a successful receipt.
      return null;
    }
    const res: UndoTurnResult = runtimeRes;
    if (res) {
      const restoredText = res.restoredPrompt || (typeof res.undoneUserContent === 'string' ? res.undoneUserContent : String(res.undoneUserContent?.content || ''));
      if (restoredText) {
        this.setAgentDraft(targetRef, restoredText);
      }
    }
    this.#syncAgents();
    this.#syncMessages();
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return res;
  }

  /**
   * Reinstates the last undone turn from the redo stack by re-appending its recorded messages;
   * no new model inference is performed.
   * Automatically clears the agent's draft input when it still matches the reinstated prompt text.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @returns `RedoTurnResult` detailing success status, or `null` if redo stack is empty.
   * 
   * @example
   * ```typescript
   * const redoResult = sandboxStore.redoAgentTurn();
   * if (redoResult?.success) {
   *   console.log('Successfully redone turn.');
   * }
   * ```
   */
  redoAgentTurn(agentId: string | null = null): RedoTurnResult | null {
    // Action-boundary normalization (defect 7d2c314).
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef) return null;
    const res = this.#runtime.redoAgentTurn(targetRef);
    if (res && res.success) {
      const currentDraft = this.getAgentDraft(targetRef);
      if (currentDraft && currentDraft === res.restoredPrompt) {
        this.clearAgentDraft(targetRef);
      }
    }
    this.#syncAgents();
    this.#syncMessages();
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return res;
  }

  /**
   * Checks if an agent has an uncompleted or interrupted turn awaiting retry.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @returns `true` if an interrupted turn exists; `false` otherwise.
   * 
   * @example
   * ```typescript
   * if (sandboxStore.isAgentInterrupted()) {
   *   console.log('Selected agent has an interrupted turn that can be retried.');
   * }
   * ```
   */
  isAgentInterrupted(agentId: string | null = null): boolean {
    // Action-boundary normalization (defect 7d2c314).
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef) return false;
    return this.#runtime.isAgentInterrupted(targetRef);
  }

  /**
   * Clears the diagnostic error banner on an agent without mutating conversational history.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * 
   * @example
   * ```typescript
   * sandboxStore.clearAgentLastError();
   * ```
   */
  clearAgentLastError(agentId: string | null = null): void {
    // Action-boundary normalization (defect 7d2c314); the runtime resolves a
    // canonical key realm-exactly over active and recycled registrations.
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef || !this.#runtime) return;
    this.#runtime.clearAgentLastError(targetRef);
    this.#syncAgents();
    this.#scheduleAutoSave();
  }

  /**
   * Resets cumulative token counters and call metrics for an agent.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @returns `true` when a target agent is resolved and the reset is attempted; `false` when no
   * target or no active agent is found.
   * 
   * @example
   * ```typescript
   * sandboxStore.clearAgentTelemetry('agent-scout');
   * ```
   */
  clearAgentTelemetry(agentId: string | null = null): boolean {
    // Action-boundary normalization (defect 7d2c314).
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef || !this.#runtime) return false;
    const res = this.#runtime.clearAgentTelemetry(targetRef);
    const agent = this.#snapshotForRef(targetRef);
    this.#syncAgents();
    this.#scheduleAutoSave();
    return Boolean(res || agent);
  }

  // ==========================================================================
  // Draft Buffer Management
  // ==========================================================================

  /**
   * Retrieves the in-progress draft prompt for a specific agent ID.
   * 
   * @param agentId - Unique agent identifier.
   * @returns The draft prompt string, or `""` if empty.
   * 
   * @example
   * ```typescript
   * const draft = sandboxStore.getAgentDraft('director');
   * console.log('Director draft:', draft);
   * ```
   */
  getAgentDraft(agentId: string): string {
    if (!agentId) return '';
    // Defect 7d2c314: an identity-key ref resolves to the snapshot's bare id
    // (the persisted draft map key contract), so UI call sites passing
    // `identityKey` keep reading their own agent's draft.
    const key = this.#draftKeyForRef(agentId);
    return this.agentDraftInputs[key] || '';
  }

  /**
   * Sets the draft prompt text for an agent and schedules debounced auto-persistence.
   * 
   * @param agentId - Unique agent identifier.
   * @param text - Draft prompt text to store.
   * 
   * @example
   * ```typescript
   * sandboxStore.setAgentDraft('director', 'Outline the main characters for chapter 2');
   * ```
   */
  setAgentDraft(agentId: string, text: string): void {
    if (!agentId) return;
    // Defect 7d2c314: normalize an identity-key ref onto the snapshot's bare
    // id (the persisted draft map key contract) and migrate a legacy
    // bare-keyed entry so no stale shared draft survives the write.
    const key = this.#draftKeyForRef(agentId);
    const next = { ...this.agentDraftInputs };
    if (key !== agentId) delete next[agentId];
    next[key] = String(text ?? '');
    this.agentDraftInputs = next;
    this.#scheduleAutoSave();
  }

  /**
   * Clears the draft prompt buffer for an agent.
   * 
   * @param agentId - Unique agent identifier.
   * 
   * @example
   * ```typescript
   * sandboxStore.clearAgentDraft('director');
   * ```
   */
  clearAgentDraft(agentId: string): void {
    if (!agentId) return;
    // Defect 7d2c314: clear both the resolved bare-id key and the raw ref so
    // an identity-key call clears the legacy entry too.
    const key = this.#draftKeyForRef(agentId);
    const next = { ...this.agentDraftInputs };
    delete next[key];
    if (key !== agentId) delete next[agentId];
    this.agentDraftInputs = next;
    this.#scheduleAutoSave();
  }

  // ==========================================================================
  // History & Message Editing
  // ==========================================================================

  /**
   * Modifies an existing historical message in-place for a given agent with cascade safety.
   * 
   * @param agentId - Target agent ID (or empty for `selectedAgentId`).
   * @param messageIndexOrId - 0-indexed numeric position or string UUID of the message.
   * @param updatedFields - Fields to modify (`content` or `metadata`).
   * @returns The updated `HistoryMessage`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND} If agent is not found.
   * 
   * @example
   * ```typescript
   * const updated = sandboxStore.updateHistoryMessage('director', 'msg_001', {
   *   content: 'Refined instructions for scene 1'
   * });
   * ```
   */
  updateHistoryMessage(agentId: string, messageIndexOrId: string | number, updatedFields: HistoryMessageUpdate): HistoryMessage {
    // Action-boundary normalization (defect 7d2c314).
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef || !this.#activeSnapshotForRef(targetRef)) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND;
      throw err;
    }
    const updated = this.#runtime.updateHistoryMessage(targetRef, messageIndexOrId, updatedFields);
    this.#syncAgents();
    this.#scheduleAutoSave();
    return updated;
  }

  /**
   * Convenience helper editing a message in the selected agent's conversational history.
   * 
   * @param messageId - 0-indexed numeric position or string UUID of the message.
   * @param newContent - New string content for the message.
   * @returns The updated `HistoryMessage`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED} If no agent is selected.
   * 
   * @example
   * ```typescript
   * sandboxStore.editAgentMessage('msg_002', 'Corrected assistant response.');
   * ```
   */
  editAgentMessage(messageId: string | number, newContent: string): HistoryMessage {
    if (!this.selectedAgentKey) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED;
      throw err;
    }
    return this.updateHistoryMessage(this.selectedAgentKey, messageId, { content: newContent });
  }

  /**
   * Deletes a message from agent history with tool-call hygiene.
   * 
   * @param agentId - Target agent ID (or empty for `selectedAgentId`).
   * @param messageIndexOrId - 0-indexed numeric position or string UUID of the message.
   * @returns `true` if deleted; `false` otherwise.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND} If agent is not found.
   * 
   * @example
   * ```typescript
   * const deleted = sandboxStore.deleteHistoryMessage('director', 'msg_003');
   * console.log('Message deleted:', deleted);
   * ```
   */
  deleteHistoryMessage(agentId: string, messageIndexOrId: string | number): boolean {
    // Action-boundary normalization (defect 7d2c314).
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef || !this.#activeSnapshotForRef(targetRef)) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND;
      throw err;
    }
    const deleted = this.#runtime.deleteHistoryMessage(targetRef, messageIndexOrId);
    this.#syncAgents();
    this.#scheduleAutoSave();
    return deleted;
  }

  /**
   * Convenience helper deleting a message from the selected agent's history.
   * 
   * @param messageIndexOrId - 0-indexed numeric position or string UUID of the message.
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @returns `true` if deleted; `false` otherwise.
   * 
   * @example
   * ```typescript
   * sandboxStore.deleteAgentMessage('msg_004');
   * ```
   */
  deleteAgentMessage(messageIndexOrId: string | number, agentId: string | null = null): boolean {
    // Action-boundary normalization (defect 7d2c314).
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED;
      throw err;
    }
    return this.deleteHistoryMessage(targetRef, messageIndexOrId);
  }

  // ==========================================================================
  // Messaging Bus Operations
  // ==========================================================================

  /**
   * Injects a manual point-to-point or broadcast message into the `MessagingBus`.
   * An unregistered recipient that is not marked terminated is auto-registered
   * before delivery. The store does not verify that the recipient exists as an
   * active runtime agent, so a phantom recipient id is accepted and delivered to
   * instead of following the bus `RECIPIENT_NOT_FOUND` dead-letter path.
   *
   * Operator attribution (ticket 99faaf1; Wave I, ticket c02d0b9): the store
   * is the human-operator surface, so a `from` label that does not resolve to
   * a registered agent identity (e.g. the `MessagingBusViewer` default
   * `'human'`) is sent through a store-built execution context carrying the
   * runtime's host operator principal by exact reference — the bypass is the
   * principal, never an id, and the label stays presentation only. Agent-
   * labelled sends keep the agent's own identity and Realm scope.
   *
   * @param from - Sender agent ID, or an operator label for a non-agent sender.
   * @param to - Recipient agent ID, or `'all'` for broadcast.
   * @param content - String message content or structured payload.
   * @param metadata - Optional key-value metadata dictionary attached to envelope.
   * @returns The bus delivery receipt (including the assigned `id` and failure `code` on rejection).
   * 
   * @example
   * ```typescript
   * const receipt = sandboxStore.sendMessage('agent-scout', 'agent-commander', 'Recon data deposited in /mission_report.json', {
   *   priority: 'HIGH'
   * });
   * if (receipt.success) {
   *   console.log(`Dispatched message ${receipt.id}`);
   * }
   * ```
   */
  sendMessage(from: string, to: string, content: string | object, metadata: Record<string, unknown> = {}): SendMessageReceipt {
    if (to !== 'all' && typeof this.#messagingBus.isRegistered === 'function' && !this.#messagingBus.isRegistered(to)) {
      if (typeof this.#messagingBus.isAgentTerminated !== 'function' || !this.#messagingBus.isAgentTerminated(to)) {
        // Wave I (ticket d57cbc1): resolve the recipient's canonical identity
        // key so the auto-registered mailbox is the realm-exact partition the
        // runtime uses; an ambiguous bare id mints no shadow mailbox (the bus
        // denies the delivery fail-closed instead), and an unresolvable
        // phantom keeps the legacy bare-id registration.
        const registrationRef = this.#resolveMailboxRegistrationRef(to);
        if (registrationRef) this.#messagingBus.registerAgent(registrationRef);
      }
    }
    const operatorContext = this.#resolveSendOperatorContext(from);
    const message = operatorContext
      ? this.#messagingBus.sendMessage({ from, to, content, metadata }, operatorContext)
      : this.#messagingBus.sendMessage({
        from,
        to,
        content,
        metadata
      });
    this.#syncMessages();
    this.#syncAgents();
    this.#scheduleAutoSave();
    return message;
  }

  /**
   * Returns the count of unread messages pending in an agent's active queue.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @returns Unread message count.
   * 
   * @example
   * ```typescript
   * const unread = sandboxStore.getAgentUnreadCount('agent-commander');
   * console.log('Unread messages for commander:', unread);
   * ```
   */
  getAgentUnreadCount(agentId: string | null = null): number {
    const targetId = agentId || this.selectedAgentId;
    if (!targetId) return 0;
    // Wave I (ticket d57cbc1): a bare id registered in more than one Realm is
    // ambiguous — fail closed to zero rather than reporting the first
    // registration's badge (no wrong-Realm pick). The unique/no-match cases
    // keep the legacy behavior byte-compatible.
    const projections = this.#agentProjectionsFor(targetId);
    if (projections.length > 1) return 0;
    const projection = projections.length === 1 ? projections[0] : null;
    const agent = this.agents.find(a => a.id === targetId);
    if (agent && agent.unreadCount !== undefined) return agent.unreadCount;
    const canonicalKey = projection && typeof projection.key === 'string' && projection.key ? projection.key : null;
    return this.#busUnreadCountFor(targetId, canonicalKey);
  }

  /**
   * Non-destructively peeks at message headers in an agent's inbox.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @param options - Optional filtering options (e.g. `unreadOnly: true`).
   * @returns Array of `InboxHeader` objects.
   * 
   * @example
   * ```typescript
   * const headers = sandboxStore.listAgentInbox('agent-commander', { unreadOnly: true });
   * for (const h of headers) {
   *   console.log(`From: ${h.from}, Subject: ${h.preview}`);
   * }
   * ```
   */
  listAgentInbox(agentId: string | null = null, options: InboxListOptions = {}): ReadonlyArray<InboxHeader> {
    const targetId = agentId || this.selectedAgentId;
    if (!targetId || !this.#messagingBus) return [];
    return this.#messagingBus.listInbox(targetId, options);
  }

  /**
   * Consumes a message by ID from an agent's inbox, dequeuing it to historical archives if marked read.
   * 
   * @param agentId - Target agent ID (or empty for `selectedAgentId`).
   * @param messageId - Unique message ID to consume.
   * @param markAsRead - Whether to mark message as read (defaults to `true`).
   * @returns The bus read receipt (`success`, `status`, and the retrieved `message` envelope).
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND} If agent is not found.
   * 
   * @example
   * ```typescript
   * const receipt = sandboxStore.readAgentMessage('agent-commander', 'msg_100', true);
   * if (receipt.success) {
   *   console.log(`[${receipt.status}] Message body:`, receipt.message?.content);
   * }
   * ```
   */
  readAgentMessage(agentId: string, messageId: string, markAsRead: boolean = true): ReadMessageResult {
    const targetId = agentId || this.selectedAgentId;
    if (!targetId || !this.agents.some(a => a.id === targetId)) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND;
      throw err;
    }
    const result = this.#messagingBus.readMessage(targetId, messageId, { markAsRead });
    this.#syncAgents();
    this.#syncMessages();
    this.#scheduleAutoSave();
    return result;
  }

  /**
   * Marks an inbox envelope as read.
   * 
   * @param agentId - Target agent ID.
   * @param messageId - Unique message ID.
   * @returns The bus read receipt (`success`, `status`, and the read `message` envelope).
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND} If agent is not found.
   * 
   * @example
   * ```typescript
   * const receipt = sandboxStore.markMessageRead('agent-commander', 'msg_100');
   * console.log('Marked read:', receipt.success, receipt.message?.read);
   * ```
   */
  markMessageRead(agentId: string, messageId: string): ReadMessageResult {
    return this.readAgentMessage(agentId, messageId, true);
  }

  /**
   * Consumes all pending unread messages in an agent's inbox queue and marks them read.
   * 
   * @param agentId - Target agent ID (defaults to `selectedAgentId`).
   * @returns Array of drained `BusMessageEnvelope` objects.
   * 
   * @example
   * ```typescript
   * const allMessages = sandboxStore.drainAgentInbox('agent-commander');
   * console.log(`Drained ${allMessages.length} messages.`);
   * ```
   */
  drainAgentInbox(agentId: string | null = null): ReadonlyArray<BusMessageEnvelope> {
    const targetId = agentId || this.selectedAgentId;
    if (!targetId || !this.#messagingBus) return [];
    const drained = this.#messagingBus.drainInbox(targetId);
    this.#syncAgents();
    this.#syncMessages();
    this.#scheduleAutoSave();
    return drained;
  }

  // ==========================================================================
  // Scheduled Timers
  // ==========================================================================

  /**
   * Enqueues a deferred turn execution with live countdown tracking.
   * Starts internal 1-second countdown interval ticker if not already running.
   * 
   * @param params - Schedule timer parameters (durationSeconds, prompt, timerCondition, agentId).
   * @returns Promise resolving to the `ScheduleTimerReceipt` (`ScheduleReceipt`) union: narrow on
   * `success` (success carries `timerId`/`fireAt`; failure carries `error`/`code`).
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} If duration is invalid or target agent is missing.
   * 
   * @example
   * ```typescript
   * const receipt = await sandboxStore.scheduleTimer({
   *   durationSeconds: 120,
   *   prompt: 'Re-check sector radar signals',
   *   timerCondition: 'never',
   *   agentId: 'agent-scout'
   * });
   * console.log(`Timer scheduled with ID: ${receipt.timerId}`);
   * ```
   */
  async scheduleTimer({ durationSeconds, prompt, timerCondition = 'never', agentId = null }: ScheduleTimerParams = {} as ScheduleTimerParams): Promise<ScheduleTimerReceipt> {
    if (typeof durationSeconds !== 'number' || isNaN(durationSeconds) || durationSeconds <= 0) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }
    // Action-boundary normalization (defect 7d2c314): identity key or unique
    // bare id resolves the exact active registration; an empty ref uses the
    // selected registration.
    const targetRef = agentId ? this.#canonicalRef(agentId) : this.selectedAgentKey;
    if (!targetRef || !this.#activeSnapshotForRef(targetRef)) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }
    const result = this.#runtime.schedule({
      agentId: targetRef,
      durationSeconds,
      prompt,
      timerCondition
    });
    this.#syncScheduledTimers();
    this.#syncAgents();
    this.#scheduleAutoSave();
    return result;
  }

  /**
   * Cancels a pending scheduled timer and stops countdown tracking.
   * The store is the human operator surface, so it passes the runtime's host
   * operator principal as the scheduler authority context (MOD-21 W6; Wave I,
   * ticket c02d0b9). Caller-declared privilege flags never authorize.
   *
   * @param timerId - Unique ID of the timer to cancel.
   * @param reason - Optional cancellation reason.
   * @returns `true` if cancelled successfully; `false` otherwise.
   *
   * @example
   * ```typescript
   * const cancelled = sandboxStore.cancelScheduledTimer('timer_123', 'No longer needed');
   * console.log('Timer cancelled:', cancelled);
   * ```
   */
  cancelScheduledTimer(timerId: string, reason: string | null = null): boolean {
    if (!timerId) return false;
    const result = this.#runtime.cancelSchedule(timerId, reason, this.#operatorContext());
    this.#syncScheduledTimers();
    this.#syncAgents();
    this.#scheduleAutoSave();
    return Boolean(result && result.success);
  }

  // ==========================================================================
  // Virtual Filesystem & Archive Downloads
  // ==========================================================================

  /**
   * Changes the active workspace filter in the VirtualFS Explorer tab.
   *
   * Operator surfaces pass a partition key from `fsWorkspacePartitions` (an
   * internal snapshot key) so a realm-global partition or a same-id agent in
   * two Realms is addressed exactly (ticket 7571ce5). Legacy callers keep the
   * historical verbatim behavior: a public label is stored as-is and the read
   * paths (`activeFsFiles`, `activeFsPartition`) resolve it through the unique
   * registration when one exists.
   * 
   * @param workspaceId - Partition key or workspace label to focus (e.g. `'global'`, `'realm:<id>:global'`).
   * 
   * @example
   * ```typescript
   * sandboxStore.setActiveFsWorkspace('global');
   * ```
   */
  setActiveFsWorkspace(workspaceId: string): void {
    this.activeFsWorkspace = workspaceId || 'global';
    this.#scheduleAutoSave();
  }

  /**
   * Writes a file to VirtualFS, updates reactive snapshot, and performs two-way sync with WorldClock if clock/event files are touched.
   * 
   * @param filePath - Virtual file path starting with `/` (e.g. `'/mission_report.json'`).
   * @param content - String or structured object content to write.
   * @param options - Write options (`workspaceId`, `readOnly`, `owner`, `mode`, caller identity and authority fields).
   * @returns The `WriteReceipt` produced by VirtualFS (`success`, `path`, `workspaceId`, `size`, `linesWritten`, `updatedAt`, `readOnly`, `owner`).
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED} If quota is exceeded or permissions deny write.
   * 
   * @example
   * ```typescript
   * const meta = sandboxStore.writeFile('/notes/summary.txt', 'Sector 7 is clear.', {
   *   workspaceId: 'global'
   * });
   * console.log(`Wrote ${meta.size} bytes to ${meta.path}`);
   * ```
   */
  writeFile(filePath: string, content: string | object, options: VfsWriteOptions = {}): WriteReceipt {
    try {
      const targetWorkspace = options.workspaceId || this.activeFsWorkspace;
      const meta = this.#virtualFs.writeFile({
        filePath,
        content,
        ...this.#operatorSubstrateContext(),
        ...options,
        workspaceId: targetWorkspace
      });

      // Two-way sync: If event_list.json or world_clock.json was written, sync into in-memory WorldClock
      const norm = String(filePath || '').trim().toLowerCase();
      if (
        norm === '/event_list.json' || norm === 'event_list.json' || norm.endsWith('/event_list.json') ||
        norm === '/world_clock.json' || norm === 'world_clock.json' || norm.endsWith('/world_clock.json')
      ) {
        if (this.#worldClock && typeof this.#worldClock.syncFromVirtualFs === 'function') {
          this.#worldClock.syncFromVirtualFs(targetWorkspace);
        }
      }

      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      this.#scheduleAutoSave();
      return meta;
    } catch (err) {
      const vfsErr: CodedError = new Error(thrownMessage(err, SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED));
      vfsErr.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED;
      vfsErr.cause = err;
      throw vfsErr;
    }
  }

  /**
   * Deletes a single file from VirtualFS and refreshes reactive snapshots.
   * Synchronizes WorldClock state if clock/event files are deleted.
   * 
   * @param filePath - Virtual file path to delete.
   * @param workspaceId - Target workspace ID (defaults to `activeFsWorkspace`).
   * @returns `true` if deleted; `false` if file did not exist.
   * 
   * @example
   * ```typescript
   * const deleted = sandboxStore.deleteFile('/temp.json', 'global');
   * console.log('File deleted:', deleted);
   * ```
   */
  deleteFile(filePath: string, workspaceId: string | null = null): boolean {
    const targetWorkspace = workspaceId || this.activeFsWorkspace;
    const deleted = this.#virtualFs.deleteFile({ filePath, workspaceId: targetWorkspace, ...this.#operatorSubstrateContext() });

    // Two-way sync: If event_list.json or world_clock.json was deleted, clear in-memory partition without recreating file
    const norm = String(filePath || '').trim().toLowerCase();
    const partitionKey = this.#agentPartitionKey(targetWorkspace);
    if (norm === '/event_list.json' || norm === 'event_list.json' || norm.endsWith('/event_list.json')) {
      if (this.#worldClock) {
        this.#worldClock.clearEvents({ targetAgentId: partitionKey, writeToFs: false }, this.#clockAuthorityContext(targetWorkspace));
      }
    } else if (norm === '/world_clock.json' || norm === 'world_clock.json' || norm.endsWith('/world_clock.json')) {
      if (this.#worldClock) {
        this.#worldClock.resetClock({ targetAgentId: partitionKey, writeToFs: false }, this.#clockAuthorityContext(targetWorkspace));
      }
    }

    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return deleted;
  }

  /**
   * Batch deletes multiple files from VirtualFS with aggregate receipt.
   * 
   * @param filePaths - Array of virtual file paths to delete.
   * @param workspaceId - Target workspace ID (defaults to `activeFsWorkspace`).
   * @returns `BatchDeleteReceipt` detailing count and deleted file list.
   * 
   * @example
   * ```typescript
   * const receipt = sandboxStore.deleteFiles(['/file1.txt', '/file2.txt'], 'global');
   * console.log(`Deleted ${receipt.count} files.`);
   * ```
   */
  deleteFiles(filePaths: string[] = [], workspaceId: string | null = null): BatchDeleteReceipt {
    const targetWorkspace = workspaceId || this.activeFsWorkspace;
    const deleted: string[] = [];
    for (const path of filePaths) {
      try {
        if (this.#virtualFs.deleteFile({ filePath: path, workspaceId: targetWorkspace, ...this.#operatorSubstrateContext() })) {
          deleted.push(path);
          const norm = String(path || '').trim().toLowerCase();
          const partitionKey = this.#agentPartitionKey(targetWorkspace);
          if (norm === '/event_list.json' || norm === 'event_list.json' || norm.endsWith('/event_list.json')) {
            if (this.#worldClock) {
              this.#worldClock.clearEvents({ targetAgentId: partitionKey, writeToFs: false }, this.#clockAuthorityContext(targetWorkspace));
            }
          } else if (norm === '/world_clock.json' || norm === 'world_clock.json' || norm.endsWith('/world_clock.json')) {
            if (this.#worldClock) {
              this.#worldClock.resetClock({ targetAgentId: partitionKey, writeToFs: false }, this.#clockAuthorityContext(targetWorkspace));
            }
          }
        }
      } catch {
        // Skip files that fail or lack permissions
      }
    }
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return {
      success: true,
      count: deleted.length,
      deleted
    };
  }

  /**
   * Copies a file within or between workspaces.
   * 
   * @param srcPath - Source virtual file path.
   * @param destPath - Destination virtual file path.
   * @param options - Copy options (srcWorkspaceId, destWorkspaceId, overwrite).
   * @returns `CopyReceipt` detailing the copied file.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED} If source file not found or quota exceeded.
   * 
   * @example
   * ```typescript
   * const copyReceipt = sandboxStore.copyFile('/template.md', '/chapter1.md', {
   *   srcWorkspaceId: 'global',
   *   destWorkspaceId: 'agent-writer'
   * });
   * console.log('File copied:', copyReceipt.success);
   * ```
   */
  copyFile(srcPath: string, destPath: string, options: VfsCopyOptions & { srcWorkspace?: string; destWorkspace?: string } = {}): CopyReceipt {
    try {
      const srcWorkspaceId = options.srcWorkspaceId || options.srcWorkspace || this.activeFsWorkspace;
      const destWorkspaceId = options.destWorkspaceId || options.destWorkspace || srcWorkspaceId;
      const receipt = this.#virtualFs.copyFile({
        srcPath,
        destPath,
        srcWorkspaceId,
        destWorkspaceId,
        ...this.#operatorSubstrateContext(),
        ...options,
        overwrite: options.overwrite !== undefined ? options.overwrite : true
      });

      const norm = String(destPath || '').trim().toLowerCase();
      if (
        norm === '/event_list.json' || norm === 'event_list.json' || norm.endsWith('/event_list.json') ||
        norm === '/world_clock.json' || norm === 'world_clock.json' || norm.endsWith('/world_clock.json')
      ) {
        if (this.#worldClock && typeof this.#worldClock.syncFromVirtualFs === 'function') {
          this.#worldClock.syncFromVirtualFs(destWorkspaceId);
        }
      }

      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      this.#scheduleAutoSave();
      return receipt;
    } catch (err) {
      const vfsErr: CodedError = new Error(thrownMessage(err, SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED));
      vfsErr.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED;
      vfsErr.cause = err;
      throw vfsErr;
    }
  }

  /**
   * Evaluates structured JSON queries safely without `eval` or unsafe execution.
   * 
   * @param filePath - Virtual JSON file path.
   * @param keyPath - Dot-separated key path or JSONPath expression (e.g. `'targets.0.id'`).
   * @param workspaceId - Target workspace ID (defaults to `activeFsWorkspace`).
   * @returns Extracted value or query result.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED} If file not found or invalid JSON.
   * 
   * @example
   * ```typescript
   * const targetId = sandboxStore.queryJson('/mission_report.json', 'targets.0.id', 'global');
   * console.log('Primary target ID:', targetId);
   * ```
   */
  queryJson(filePath: string, keyPath: string = '', workspaceId: string | null = null): unknown {
    try {
      const targetWorkspace = workspaceId || this.activeFsWorkspace;
      return this.#virtualFs.queryJson({ filePath, query: keyPath, workspaceId: targetWorkspace, ...this.#operatorSubstrateContext() });
    } catch (err) {
      const vfsErr: CodedError = new Error(thrownMessage(err, SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED));
      vfsErr.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED;
      vfsErr.cause = err;
      throw vfsErr;
    }
  }

  /**
   * Regex or literal text search across files in a workspace.
   * 
   * @param pattern - Regex string pattern or literal search term.
   * @param workspaceId - Target workspace ID (defaults to `activeFsWorkspace`).
   * @param options - Grep options (`isRegex`, `caseInsensitive`, `maxMatches`).
   * @returns Array of `GrepMatch` objects.
   * 
   * @example
   * ```typescript
   * const matches = sandboxStore.grep('threat: SEVERE', 'global');
   * for (const m of matches) {
   *   console.log(`Match in ${m.file} line ${m.lineNumber}: ${m.line}`);
   * }
   * ```
   */
  grep(pattern: string, workspaceId: string | null = null, options: GrepOptions = {}): GrepMatch[] {
    const targetWorkspace = workspaceId || this.activeFsWorkspace;
    return this.#virtualFs.grep({
      pattern,
      ...options,
      workspaceId: targetWorkspace
    }, this.#operatorSubstrateContext());
  }

  /**
   * Processes browser file uploads into VirtualFS.
   * 
   * @param filesInput - FileList, File array, or structured UploadFileInput array.
   * @param workspaceId - Target workspace ID (defaults to `activeFsWorkspace`).
   * @param options - Upload options (overwrite, callerAgentId).
   * @returns Promise resolving to `UploadReceipt`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED} If file reading or write fails.
   * 
   * @example
   * ```typescript
   * const receipt = await sandboxStore.uploadFiles(fileInputList, 'global', { overwrite: true });
   * console.log(`Uploaded ${receipt.count} files.`);
   * ```
   */
  async uploadFiles(filesInput: FileList | File[] | UploadFileInput[], workspaceId: string | null = null, options: UploadOptions = {}): Promise<UploadReceipt> {
    try {
      const targetWorkspace = workspaceId || this.activeFsWorkspace;
      const files = Array.isArray(filesInput) && filesInput.length > 0 && typeof (filesInput[0] as { content?: unknown })?.content === 'string'
        ? (filesInput as UploadFileInput[])
        : await processUploadedFiles(filesInput, options as ProcessUploadOptions);

      const uploaded: string[] = [];
      for (const file of files) {
        this.#virtualFs.writeFile({
          filePath: file.path,
          content: file.content,
          ...this.#operatorSubstrateContext(),
          ...options,
          workspaceId: targetWorkspace
        });
        uploaded.push(file.path);
        const norm = String(file.path || '').trim().toLowerCase();
        if (
          norm === '/event_list.json' || norm === 'event_list.json' || norm.endsWith('/event_list.json') ||
          norm === '/world_clock.json' || norm === 'world_clock.json' || norm.endsWith('/world_clock.json')
        ) {
          if (this.#worldClock && typeof this.#worldClock.syncFromVirtualFs === 'function') {
            this.#worldClock.syncFromVirtualFs(targetWorkspace);
          }
        }
      }

      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      this.#scheduleAutoSave();

      return {
        success: true,
        count: uploaded.length,
        files: uploaded
      };
    } catch (err) {
      const vfsErr: CodedError = new Error(thrownMessage(err, SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED));
      vfsErr.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED;
      vfsErr.cause = err;
      throw vfsErr;
    }
  }

  /**
   * Triggers browser download of a single virtual file.
   * 
   * @param filePath - Virtual file path to download.
   * @param workspaceId - Target workspace ID (defaults to `activeFsWorkspace`).
   * @returns The `DownloadReceipt` produced by `downloadSingleFile` (`success`, `filename`, `size`, `simulated`).
   * @throws Error if file is not found in target workspace.
   * 
   * @example
   * ```typescript
   * const receipt = sandboxStore.downloadFile('/mission_report.json', 'global');
   * console.log(`Downloaded ${receipt.filename} (${receipt.size} bytes)`);
   * ```
   */
  downloadFile(filePath: string, workspaceId: string | null = null): DownloadReceipt {
    const wsId = workspaceId || this.activeFsWorkspace;
    const fileMeta = this.#virtualFs.getFileRecord(filePath, {
      workspaceId: wsId,
      ...this.#operatorSubstrateContext()
    });
    if (!fileMeta) {
      throw new Error(`File '${filePath}' not found in workspace '${wsId}'`);
    }
    return downloadSingleFile({
      path: fileMeta.path,
      content: fileMeta.content,
      workspaceId: wsId,
      readOnly: fileMeta.readOnly
    });
  }

  /**
   * Bundles an entire workspace as a `.zip` or `.tar.gz` download archive.
   * 
   * @param workspaceId - Target workspace ID (defaults to `activeFsWorkspace`).
   * @returns Promise resolving to the runtime `ArchiveDownloadReceipt` (`success`, `filename?`, `format?`, `capability?`, `error?`, `message?`, `filesCount`).
   * 
   * @example
   * ```typescript
   * const receipt = await sandboxStore.downloadWorkspaceArchive('global');
   * if (receipt.success) {
   *   console.log(`Downloaded ${receipt.filename} (${receipt.filesCount} files)`);
   * }
   * ```
   */
  async downloadWorkspaceArchive(workspaceId: string | null = null): Promise<ArchiveDownloadReceipt> {
    const wsId = workspaceId || this.activeFsWorkspace;
    const files = this.#getWorkspaceFilesWithContent(wsId);
    return downloadFolderAsArchive(files, {
      archiveName: `${wsId}_workspace`,
      workspaceId: wsId
    } as CreateArchiveOptions);
  }

  /**
   * Downloads workspace files individually with progress tracking.
   * 
   * @param workspaceId - Target workspace ID (defaults to `activeFsWorkspace`).
   * @param onProgress - Optional callback invoked per file downloaded.
   * @returns Promise resolving to `SeparateDownloadReceipt`.
   * 
   * @example
   * ```typescript
   * const receipt = await sandboxStore.downloadWorkspaceFilesSeparately('global', (curr, total, name) => {
   *   console.log(`[${curr}/${total}] Downloaded ${name}`);
   * });
   * ```
   */
  async downloadWorkspaceFilesSeparately(workspaceId: string | null = null, onProgress: ProgressCallback | null = null): Promise<SeparateDownloadReceipt> {
    const wsId = workspaceId || this.activeFsWorkspace;
    const files = this.#getWorkspaceFilesWithContent(wsId);
    return downloadFilesSeparately(files, {
      prefixWorkspace: false,
      ...(onProgress ? { onProgress } : {})
    });
  }

  /**
   * Bundles all workspaces across the sandbox into a single archive download.
   * 
   * @returns Promise resolving to the runtime `ArchiveDownloadReceipt`.
   * 
   * @example
   * ```typescript
   * const receipt = await sandboxStore.downloadAllWorkspacesArchive();
   * if (receipt.success) {
   *   console.log('Downloaded full sandbox archive:', receipt.filename);
   * }
   * ```
   */
  downloadAllWorkspacesArchive(): Promise<ArchiveDownloadReceipt> {
    const files = this.#getAllFilesWithContent();
    return downloadFolderAsArchive(files, {
      archiveName: 'sandbox_all_workspaces',
      baseFolder: ''
    });
  }

  /**
   * Downloads all files across all workspaces individually with progress tracking.
   * 
   * @param onProgress - Optional callback invoked per file downloaded.
   * @returns Promise resolving to `SeparateDownloadReceipt`.
   * 
   * @example
   * ```typescript
   * const receipt = await sandboxStore.downloadAllWorkspacesFilesSeparately((curr, total, name) => {
   *   console.log(`Downloaded ${name} (${curr}/${total})`);
   * });
   * ```
   */
  async downloadAllWorkspacesFilesSeparately(onProgress: ProgressCallback | null = null): Promise<SeparateDownloadReceipt> {
    const files = this.#getAllFilesWithContent();
    return downloadFilesSeparately(files, {
      prefixWorkspace: true,
      ...(onProgress ? { onProgress } : {})
    });
  }

  // ==========================================================================
  // World Clock & Narrative Events
  // ==========================================================================

  /**
   * Clears all registered narrative events for an agent partition or global.
   * 
   * @param agentId - Target agent ID partition (defaults to `selectedAgentId` or `'global'`).
   * @returns `NarrativeResetReceipt` containing count of cleared events.
   * 
   * @example
   * ```typescript
   * const receipt = sandboxStore.resetAgentEvents('global');
   * console.log(`Cleared ${receipt.cleared} events.`);
   * ```
   */
  resetAgentEvents(agentId: string | null = null): NarrativeResetReceipt {
    // Defect 7d2c314: identity key or unique bare id resolves the exact
    // registration before the existing `#agentPartitionKey` canonicalization
    // (never bypassed).
    const targetId = this.#canonicalRef(agentId || this.selectedAgentKey) || 'global';
    if (!this.#worldClock) return { success: false, cleared: 0 };
    const result = this.#worldClock.clearEvents(this.#agentPartitionKey(targetId), this.#clockAuthorityContext(targetId));
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return {
      success: Boolean(result && result.success),
      cleared: result.cleared || 0
    };
  }

  /**
   * Resets world clock to 0 seconds and 'Day 1' for an agent partition or global.
   * 
   * @param agentId - Target agent ID partition (defaults to `selectedAgentId` or `'global'`).
   * @returns `ClockResetReceipt` detailing success status.
   * 
   * @example
   * ```typescript
   * const receipt = sandboxStore.resetAgentClock('global');
   * console.log('Clock reset:', receipt.success);
   * ```
   */
  resetAgentClock(agentId: string | null = null): ClockResetReceipt {
    // Defect 7d2c314: identity key or unique bare id resolves the exact
    // registration before the existing `#agentPartitionKey` canonicalization
    // (never bypassed).
    const targetId = this.#canonicalRef(agentId || this.selectedAgentKey) || 'global';
    if (!this.#worldClock) return { success: false };
    const result = this.#worldClock.resetClock(this.#agentPartitionKey(targetId), this.#clockAuthorityContext(targetId));
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return { success: Boolean(result && result.success) };
  }

  /**
   * Advances narrative time by N seconds for an agent partition.
   * 
   * @param seconds - Number of seconds to advance narrative clock.
   * @param agentId - Target agent ID partition (defaults to `selectedAgentId` or `'global'`).
   * @returns Updated `AgentClockState`.
   * 
   * @example
   * ```typescript
   * const newClock = sandboxStore.advanceAgentClock(3600, 'global');
   * console.log('Advanced time to:', newClock.formattedTime);
   * ```
   */
  advanceAgentClock(seconds: number, agentId: string | null = null): AgentClockState {
    // Defect 7d2c314: identity key or unique bare id resolves the exact
    // registration before the existing `#agentPartitionKey` canonicalization
    // (never bypassed).
    const targetId = this.#canonicalRef(agentId || this.selectedAgentKey) || 'global';
    if (!this.#worldClock) {
      return this.getAgentClock(targetId);
    }
    const res = this.#worldClock.advanceClock(
      { seconds, targetAgentId: this.#agentPartitionKey(targetId) },
      this.#clockAuthorityContext(targetId)
    ) as Partial<AdvanceClockSuccess>;
    this.#syncFsSnapshot();
    this.#syncClockSnapshot();
    this.#scheduleAutoSave();
    return {
      totalSeconds: res.currentSeconds ?? 0,
      formattedTime: res.currentFormatted ?? res.shortFormatted ?? '00:00:00',
      day: res.day ?? 1,
      hour: res.hour ?? 0,
      minute: res.minute ?? 0,
      second: res.second ?? 0
    };
  }

  /**
   * Retrieves current formatted narrative clock time for an agent partition.
   *
   * Reads the reactive `clockSnapshot` cache first. On a cache miss the call
   * delegates to the WorldClock engine's `getTime` without a privileged caller
   * context, so per the WorldClock contract a partition absent from the cache
   * resolves to the `'global'` partition — an unknown agent therefore yields the
   * global clock. Returns a zeroed `'Day 1'` clock when no WorldClock is attached.
   * 
   * @param agentId - Target agent ID partition (defaults to `selectedAgentId` or `'global'`).
   * @returns Current `AgentClockState`.
   * 
   * @example
   * ```typescript
   * const clock = sandboxStore.getAgentClock('agent-scout');
   * console.log(`Scout time: Day ${clock.day}, ${clock.formattedTime}`);
   * ```
   */
  getAgentClock(agentId: string | null = null): AgentClockState {
    // Defect 7d2c314: identity key or unique bare id resolves the exact
    // registration before the existing `#agentPartitionKey` canonicalization
    // (never bypassed).
    const targetId = this.#canonicalRef(agentId || this.selectedAgentKey) || 'global';
    // Wave I (ticket d57cbc1): resolve the partition form the runtime currently
    // keys by (canonical once wiring lands, bare otherwise) so a realm-bound
    // agent's own clock is found instead of silently falling back to global.
    const partitionKey = this.#agentPartitionKey(targetId);
    if (this.clockSnapshot[partitionKey]) {
      return this.clockSnapshot[partitionKey];
    }
    if (!this.#worldClock) {
      return {
        totalSeconds: 0,
        formattedTime: '00:00:00',
        day: 1,
        hour: 0,
        minute: 0,
        second: 0
      };
    }
    const state = this.#worldClock.getTime(partitionKey) as TimeState;
    return {
      totalSeconds: state.totalSeconds ?? 0,
      formattedTime: state.formatted ?? state.shortFormatted ?? '00:00:00',
      day: state.day ?? 1,
      hour: state.hour ?? 0,
      minute: state.minute ?? 0,
      second: state.second ?? 0
    };
  }

  /**
   * Queries narrative events cleanly through store boundary.
   * 
   * @param options - Event query options (all, activeOnly).
   * @param agentId - Target agent ID partition (defaults to `selectedAgentId` or `'global'`).
   * @returns `AgentEventsQueryState` containing event list and counts.
   * 
   * @example
   * ```typescript
   * const query = sandboxStore.queryAgentEvents({ activeOnly: true }, 'global');
   * console.log('Active events count:', query.activeCount);
   * ```
   */
  queryAgentEvents(options: EventQueryOptions = {}, agentId: string | null = null): AgentEventsQueryState {
    // Defect 7d2c314: identity key or unique bare id resolves the exact
    // registration before the existing `#agentPartitionKey` canonicalization
    // (never bypassed).
    const targetId = this.#canonicalRef(agentId || this.selectedAgentKey) || 'global';
    if (!this.#worldClock || typeof this.#worldClock.queryEvents !== 'function') {
      return {
        events: [],
        activeEvents: [],
        count: 0,
        activeCount: 0,
        pendingCount: 0
      };
    }
    // Cross-partition `all` queries run under the operator principal; ordinary
    // reads stay self-scoped to the selected agent's partition, forwarding the
    // canonical `callerKey` once the runtime keys partitions canonically
    // (Wave I, ticket d57cbc1).
    const context = options?.all === true
      ? this.#operatorSubstrateContext()
      : this.#agentScopedClockContext(targetId);
    const res = this.#worldClock.queryEvents(options, context);
    return {
      events: res.events || [],
      activeEvents: res.activeEvents || [],
      count: res.count || 0,
      activeCount: res.activeCount || 0,
      pendingCount: res.pendingCount || 0
    };
  }

  // ==========================================================================
  // Credential Vault (MOD-16)
  // ==========================================================================

  /**
   * Retrieves the credential vault owned by this store (composition root for MOD-16).
   * Exposes the management contract to UI call sites (`addCredential`, `updateCredential`,
   * `deleteCredential`, `getCredentialsForProvider`, `setActiveCredential`,
   * `exportCredentials`, ...).
   *
   * @returns The `CredentialVault` instance backing this store's runtime and UI.
   *
   * @example
   * ```typescript
   * const vault = sandboxStore.getCredentialVault();
   * const entry = vault.addCredential({ providerId: 'runware', label: 'Main', apiKey: 'sk-...' });
   * vault.setActiveCredential('runware', entry.id);
   * ```
   */
  getCredentialVault(): CredentialVault {
    return this.#credentialVault;
  }

  /**
   * Retrieves the frozen least-privilege `CredentialResolverPort` handed to the runtime.
   * Intended for provider-construction call sites that need credential lookups/projections.
   * The port exposes no enumeration or listing, but it is not entirely write-free: a lookup
   * miss for a canonical provider id may lazily create and persist that canonical credential
   * (the sole mutating read path, per the `CredentialResolverPort` contract in `credentialVault`).
   *
   * @returns The frozen `CredentialResolverPort` shared with the runtime.
   *
   * @example
   * ```typescript
   * const resolver = sandboxStore.getCredentialResolver();
   * const active = resolver.getActiveCredential('deepseek');
   * ```
   */
  getCredentialResolver(): CredentialResolverPort {
    return this.#credentialResolver;
  }

  // ==========================================================================
  // Model Preset Catalog (MOD-20)
  // ==========================================================================

  /**
   * Retrieves the MOD-20 preset catalog owned by this store (composition root).
   * Exposes the management contract to UI call sites (`listPresets`,
   * `getPreset`, `savePreset`, `deletePreset`, `setActivePresetId`,
   * `subscribe`, `createPresetSourcePort`). Catalog mutations persist through
   * the snapshot adapter and schedule the existing debounced save; the active
   * pointer and custom entries live in the sandbox snapshot.
   *
   * @returns The `PresetCatalog` instance backing this store's presets and UI.
   *
   * @example
   * ```typescript
   * const catalog = sandboxStore.getPresetCatalog();
   * catalog.savePreset({ id: 'preset_custom_1', name: 'My Preset', isCustom: true, modelConfig: { providerId: 'deepseek', modelId: 'deepseek-chat' } });
   * catalog.setActivePresetId('preset_custom_1');
   * ```
   */
  getPresetCatalog(): PresetCatalog {
    return this.#presetCatalog;
  }

  // ==========================================================================
  // Realm Registry (Wave A)
  // ==========================================================================

  /**
   * Retrieves the Wave A realm registry owned by this store (composition
   * root). Exposes the management contract to UI call sites (`listRealms`,
   * `getRealm`, `addRealm`, `updateRealm`, `removeRealm`, `subscribe`).
   * The protected Generic default (`realm_generic`) is refused by
   * `removeRealm` on this raw surface too — a `false` no-op without a change
   * event — while renames and every other management operation stay available
   * (Wave R hardening, ticket 0fe25fd). Registry mutations persist through the
   * snapshot adapter, schedule the existing debounced save, and update the
   * reactive `realms` projection through the registry change subscription.
   *
   * @returns The `RealmRegistry` instance backing this store's Realms and UI.
   *
   * @example
   * ```typescript
   * const registry = sandboxStore.getRealmRegistry();
   * registry.listRealms().forEach(realm => console.log(realm.name));
   * ```
   */
  getRealmRegistry(): RealmRegistry {
    return this.#realmRegistry;
  }

  /**
   * Resolves one Realm record through the owned registry.
   *
   * @param id - Registry realm id.
   * @returns The frozen realm record, or `null` when no Realm carries the id.
   *
   * @example
   * ```typescript
   * const realm = sandboxStore.getRealm('realm_demo');
   * ```
   */
  getRealm(id: string): RealmRecord | null {
    return this.#realmRegistry.getRealm(id);
  }

  /**
   * Creates a Realm through the owned registry. The store assigns the id
   * (a `realm_*` identifier) when the draft omits one and stamps `createdAt`
   * with the current time; the registry validates the record and rejects a
   * duplicate id. The mutation persists through the snapshot adapter and
   * schedules the debounced autosave.
   *
   * @param input - Realm draft: a non-empty name plus optional id, description, color, and templateId.
   * @returns The frozen created realm record.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} If the draft or its name is invalid.
   *
   * @example
   * ```typescript
   * const realm = sandboxStore.createRealm({ name: 'Story Realm', color: '#88aaff' });
   * console.log(realm.id);
   * ```
   */
  createRealm(input: RealmDraft): RealmRecord {
    if (!input || typeof input !== 'object') {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }
    if (typeof input.name !== 'string' || input.name.trim().length === 0) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
      throw err;
    }

    const optional: { description?: string; color?: string; templateId?: string } = {};
    for (const field of ['description', 'color', 'templateId'] as const) {
      const candidate = input[field];
      if (candidate === undefined) continue;
      if (typeof candidate !== 'string') {
        const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS);
        err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS;
        throw err;
      }
      optional[field] = candidate;
    }

    const id = typeof input.id === 'string' && input.id.trim().length > 0 ? input.id : generateRealmId();
    return this.#realmRegistry.addRealm({
      id,
      name: input.name,
      ...optional,
      createdAt: Date.now()
    });
  }

  /**
   * Patches an existing Realm through the owned registry; `id` and `createdAt`
   * are immutable, `null` clears an optional field, and unknown fields are
   * ignored. The mutation persists through the snapshot adapter, schedules the
   * debounced autosave, and refreshes the reactive `realms` projection.
   *
   * @param id - Registry realm id.
   * @param patch - Fields to change (`name`, `description`, `color`, `templateId`).
   * @returns The frozen updated realm record.
   * @throws Error When the id is unknown or a patched field is invalid.
   *
   * @example
   * ```typescript
   * sandboxStore.updateRealm('realm_demo', { color: '#ffcc00', description: null });
   * ```
   */
  updateRealm(id: string, patch: RealmUpdatePatch): RealmRecord {
    return this.#realmRegistry.updateRealm(id, patch);
  }

  /**
   * Removes a Realm through the owned registry under the Wave R realm model
   * (ticket 56ba4b9): membership never moves, so deletion never re-groups
   * anybody. Member counting resolves each membership with the same trim
   * semantics as the realm grouping (`resolveMemberRealmId`), so a hydrated
   * `'  realm_x  '` member still blocks the deletion of `realm_x` (Wave R
   * hardening, ticket 0fe25fd). The default (non-recursive) deletion refuses a
   * Realm that still carries ACTIVE or RECYCLED members with the typed
   * `ERR_STORE_REALM_NOT_EMPTY`
   * error ("terminate or delete members first") and leaves the record and every
   * membership intact. The explicit recursive override
   * (`deleteRealm(id, { recursive: true })`) permanently purges every active
   * member and empties every recycled member of the Realm under the host
   * operator principal (Wave I, ticket c02d0b9 — always present, so no
   * director is required), then removes the record. If
   * any member cannot be purged the call fails closed: the record survives and
   * the thrown `ERR_STORE_REALM_DELETE_FAILED` error carries a
   * {@link RealmDeletionReport} describing the purged members and the failures.
   *
   * The seeded Generic default (`realm_generic`) is always refused with
   * `ERR_STORE_REALM_PROTECTED`, recursive override included. Unknown ids are a
   * `false` no-op.
   *
   * @param id - Registry realm id.
   * @param options - Optional `{ recursive: true }` operator override.
   * @returns `true` when a record was removed; `false` for an unknown id.
   * @throws Error with code `'ERR_STORE_REALM_NOT_EMPTY'` when members block the default deletion.
   * @throws Error with code `'ERR_STORE_REALM_PROTECTED'` when the Generic default is targeted.
   * @throws Error with code `'ERR_STORE_REALM_DELETE_FAILED'` when a recursive purge fails for a member; the error carries `report`.
   *
   * @example
   * ```typescript
   * const removed = sandboxStore.deleteRealm('realm_demo', { recursive: true });
   * ```
   */
  deleteRealm(id: string, options: RealmDeleteOptions = {}): boolean {
    const realm = this.#realmRegistry.getRealm(id);
    if (!realm) return false;

    if (id === GENERIC_REALM_ID) {
      const err: CodedError = new Error(
        `deleteRealm: the Generic realm ('${GENERIC_REALM_ID}') is the sandbox default and can never be deleted`
      );
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_PROTECTED;
      throw err;
    }

    const recursive = options !== null && typeof options === 'object' && options.recursive === true;
    // Wave R hardening (ticket 0fe25fd): count memberships with the same trim
    // semantics the realm grouping/resolution uses, so a hydrated
    // `'  realm_x  '` member blocks (or is purged by) the deletion of
    // `realm_x` instead of being orphaned by a removed record.
    const activeMembers = this.agents.filter((agent) => resolveMemberRealmId(agent) === id);
    const recycledMembers = this.recycleBin.filter((agent) => resolveMemberRealmId(agent) === id);
    const memberCount = activeMembers.length + recycledMembers.length;

    if (memberCount === 0) {
      return this.#realmRegistry.removeRealm(id);
    }

    if (!recursive) {
      const err: CodedError = new Error(
        `deleteRealm: realm '${id}' still has ${activeMembers.length} active and ${recycledMembers.length} recycled member(s) — terminate or delete members first, or pass { recursive: true } to purge them with the realm`
      );
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_NOT_EMPTY;
      (err as RealmNotRemovableError).realmId = id;
      (err as RealmNotRemovableError).activeMembers = activeMembers.length;
      (err as RealmNotRemovableError).recycledMembers = recycledMembers.length;
      throw err;
    }

    // Recursive override: purge every member under the operator principal.
    // A missing operator denies the whole call before any purge (fail-closed);
    // a per-member purge failure aborts the record removal and travels on the
    // typed error report.
    const operator = this.#operatorContext();
    if (!operator.principal) {
      const err: CodedError = new Error(
        'Permission denied: purging Realm members requires the operator principal'
      );
      err.code = 'PERMISSION_DENIED';
      throw err;
    }

    const report = {
      realmId: id,
      recursive: true,
      purgedActive: [] as string[],
      purgedRecycled: [] as string[],
      failures: [] as Array<{ agentId: string; state: 'active' | 'recycled'; reason: string }>
    };
    for (const member of activeMembers) {
      try {
        if (this.purgeAgent(member.id)) {
          report.purgedActive.push(member.id);
        } else {
          report.failures.push({ agentId: member.id, state: 'active', reason: 'member was not purged' });
        }
      } catch (err) {
        report.failures.push({
          agentId: member.id,
          state: 'active',
          reason: sanitizeDiagnosticError(thrownMessage(err, 'purge failed'))
        });
      }
    }
    for (const member of recycledMembers) {
      try {
        if (this.purgeAgent(member.id)) {
          report.purgedRecycled.push(member.id);
        } else {
          report.failures.push({ agentId: member.id, state: 'recycled', reason: 'member was not purged' });
        }
      } catch (err) {
        report.failures.push({
          agentId: member.id,
          state: 'recycled',
          reason: sanitizeDiagnosticError(thrownMessage(err, 'purge failed'))
        });
      }
    }

    if (report.failures.length > 0) {
      const err: CodedError = new Error(
        `deleteRealm: ${report.failures.length} member(s) of realm '${id}' could not be deleted — the realm record was not removed`
      );
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_DELETE_FAILED;
      (err as RealmDeletionFailedError).realmId = id;
      (err as RealmDeletionFailedError).report = Object.freeze({
        realmId: report.realmId,
        recursive: true,
        purgedActive: Object.freeze([...report.purgedActive]),
        purgedRecycled: Object.freeze([...report.purgedRecycled]),
        failures: Object.freeze(report.failures.map((failure) => Object.freeze({ ...failure })))
      });
      throw err;
    }

    return this.#realmRegistry.removeRealm(id);
  }

  // ==========================================================================
  // Realm Archive Export / Import (S2 realm-export lane, ticket 3fe5221)
  // ==========================================================================

  /**
   * Exports one Realm as a complete, portable `RealmArchiveEnvelope` v1
   * archive (operator-only; a read-only projection with zero mutation).
   *
   * The slice follows the D0b completeness checklist: the realm record +
   * provenance + attachments; active and recycled member entity snapshots
   * (histories, redo stacks, telemetry, interrupted turns, pending precalls,
   * member configs); the realm's bus partitions and attributable audit trail;
   * per-agent schedules; member + realm-global world-clock partitions/events;
   * the realm-global VFS container plus resolved member workspaces (explicit
   * pins verbatim); the launch template payload; realm-scoped saved payloads;
   * and a **descriptive-only** authority projection. Redaction reuses the
   * persistence strip set plus archive-only drops (model-config `keyId`,
   * credential-shaped endpoint URLs, extension install records, host session
   * state, foreign-realm keys/bytes). Unknown template ids export without a
   * `template` section and disclose a warning instead of failing.
   *
   * @param realmId - Registered Realm id to export.
   * @returns Export receipt: canonical JSON text, filename, and disclosures.
   *
   * @example
   * ```typescript
   * const result = sandboxStore.exportRealmArchive('realm_demo');
   * if (result.success) downloadText(result.filename, result.json);
   * ```
   */
  exportRealmArchive(realmId: string): RealmArchiveExportResult {
    try {
      const id = typeof realmId === 'string' ? realmId.trim() : '';
      if (!id) {
        return Object.freeze({
          success: false,
          warnings: Object.freeze([]),
          code: SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        });
      }
      const realm = this.#realmRegistry.getRealm(id);
      if (!realm) {
        return Object.freeze({
          success: false,
          warnings: Object.freeze([]),
          code: SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_NOT_FOUND
        });
      }
      const { envelope, warnings } = this.#buildRealmArchiveEnvelope(realm);
      const json = serializeRealmArchive(envelope);
      return Object.freeze({
        success: true,
        archiveId: envelope.archiveId,
        json,
        filename: buildRealmArchiveFilename(realm.name, envelope.archiveId),
        warnings: Object.freeze([...warnings])
      });
    } catch (err) {
      console.warn('[SandboxStore] realm archive export failed:', sanitizeDiagnosticError(err) || 'export-failed');
      return Object.freeze({
        success: false,
        warnings: Object.freeze([]),
        code: SANDBOX_STORE_ERROR_CODES.ERR_STORE_ARCHIVE_FAILED
      });
    }
  }

  /**
   * Imports one realm archive into the live session as a **fresh realm**
   * (operator-only, additive; D0b import semantics).
   *
   * Every canonical key is remapped from the archive's source realm id onto a
   * newly minted realm id; bare member ids and explicit workspace pins are
   * preserved. Member hydration is default-deny — archived privilege,
   * `realmBypass`, publishing grants, and wildcard authority are never
   * consumed (they are receipted through `droppedAuthority` for the operator
   * to re-grant) — while archived tool selectors are re-applied through the
   * operator capability path. Import validates fail-closed, preflights member
   * ids/keys/workspace collisions before any mutation, and rolls the whole
   * slice back (record, files, template, payloads; runtime pre-state restored
   * internally) on a post-validation failure. Re-importing the same archive
   * mints an independent realm each time.
   *
   * @param text - Archive JSON text emitted by {@link SandboxStore.exportRealmArchive}.
   * @param options - Optional realm display-name override.
   * @returns Import receipt (fresh realm id, counters, dropped authority, warnings).
   * @throws Error with code `'ERR_STORE_INVALID_PARAMS'` for malformed archives and `'ERR_STORE_REALM_IMPORT_FAILED'` for post-validation failures (the error carries `report`).
   *
   * @example
   * ```typescript
   * const receipt = sandboxStore.importRealmArchive(archiveJson, { name: 'Imported Realm' });
   * console.log(receipt.realmId, receipt.membersImported, receipt.droppedAuthority);
   * ```
   */
  importRealmArchive(text: string, options: { name?: string } = {}): RealmArchiveImportReceipt {
    const parsed = parseRealmArchive(text);
    if (!parsed.valid || !parsed.envelope) {
      throw invalidRealmParams(`importRealmArchive: ${parsed.error ?? 'invalid realm archive'}`);
    }
    const envelope = parsed.envelope;
    const sourceRealmId = envelope.source.realmId;
    const warnings: string[] = [];

    // ---- Preflight (zero mutation) -----------------------------------------
    const memberIds = new Set<string>();
    for (const entry of [...envelope.members.active, ...envelope.members.recycled]) {
      const memberId = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!memberId) throw invalidRealmParams('importRealmArchive: member entry carries an empty id');
      if (memberIds.has(memberId)) {
        throw invalidRealmParams(`importRealmArchive: duplicate member id '${memberId}' inside the archive`);
      }
      memberIds.add(memberId);
    }
    this.#assertRealmArchiveSliceKeys(envelope, memberIds);

    // Workspace preflight: source-key resolution + pin collisions. Target keys
    // are composed after the fresh realm id exists.
    const pendingMembers: Array<{
      memberId: string;
      pinned: string | null;
      sourceKey: string | null;
    }> = [];
    const claimedSourceKeys = new Set<string>();
    const pinnedOpaqueKeys = new Set<string>();
    const pinnedCanonicalTargets = new Set<string>();
    for (const entry of [...envelope.members.active, ...envelope.members.recycled]) {
      const memberId = entry.id.trim();
      const config = (entry.config ?? {}) as Record<string, unknown>;
      const candidates = this.#realmArchiveWorkspaceCandidates(config, memberId, sourceRealmId);
      const sourceKey = candidates.find((key) => envelope.vfs.members[key] !== undefined) ?? null;
      const pinned = this.#realmArchiveMemberPin(config, memberId);
      if (pinned && isReservedWorkspaceKey(pinned)) {
        throw invalidRealmParams(`importRealmArchive: member '${memberId}' resolves to the reserved workspace '${pinned}'`);
      }
      if (pinned) {
        const parsedPin = parseAgentIdentityKey(pinned);
        if (parsedPin) {
          // Canonical pins are remapped into the fresh realm namespace. A pin
          // referencing a realm/agent outside the archive realm scope is
          // refused fail-closed up front — never resolved against live
          // workspace materialization, which is lazy and therefore absent for
          // an unclaimed victim workspace (S2 verifier F-4).
          if (parsedPin.realmId !== sourceRealmId || !memberIds.has(parsedPin.agentId)) {
            throw invalidRealmParams(
              `importRealmArchive: member '${memberId}' pins workspace '${pinned}' outside the archive realm scope`
            );
          }
          if (pinnedCanonicalTargets.has(parsedPin.agentId)) {
            throw invalidRealmParams(`importRealmArchive: members share the workspace key '${pinned}' — refusing to merge tenants`);
          }
          pinnedCanonicalTargets.add(parsedPin.agentId);
        } else {
          if (pinnedOpaqueKeys.has(pinned)) {
            throw invalidRealmParams(`importRealmArchive: members share the workspace key '${pinned}' — refusing to merge tenants`);
          }
          if (this.#virtualFs.hasWorkspace(pinned)) {
            const err = this.#realmArchiveImportFailure(
              `importRealmArchive: pinned workspace '${pinned}' already exists — refusing to merge tenants`,
              'vfs-preflight',
              null,
              false
            );
            throw err;
          }
          pinnedOpaqueKeys.add(pinned);
        }
      }
      if (sourceKey) claimedSourceKeys.add(sourceKey);
      pendingMembers.push({ memberId, pinned, sourceKey });
    }
    for (const key of Object.keys(envelope.vfs.members)) {
      if (!claimedSourceKeys.has(key)) {
        throw invalidRealmParams(`importRealmArchive: vfs.members['${key}'] does not resolve to a slice member`);
      }
    }

    // ---- Reserve the fresh realm record ------------------------------------
    const requestedName = typeof options?.name === 'string' && options.name.trim()
      ? options.name.trim()
      : envelope.realm.name;
    const newRealm = this.createRealm({
      name: this.#uniqueRealmName(requestedName),
      ...(typeof envelope.realm.description === 'string' ? { description: envelope.realm.description } : {}),
      ...(typeof envelope.realm.color === 'string' ? { color: envelope.realm.color } : {}),
      ...(envelope.template?.id || envelope.realm.templateId
        ? { templateId: envelope.template?.id ?? envelope.realm.templateId }
        : {})
    });
    const newRealmId = newRealm.id;

    // Target workspace plan: canonical source-family pins remap onto the fresh
    // realm id, opaque pins are preserved verbatim, and unpinned members use
    // the fresh realm's canonical member key.
    const workspacePlan = pendingMembers
      .filter((member) => member.sourceKey !== null)
      .map((member) => ({
        memberId: member.memberId,
        targetKey: this.#realmArchiveTargetWorkspaceKey(member.pinned, sourceRealmId, newRealmId)
          ?? createAgentIdentityKey(newRealmId, member.memberId),
        files: Object.values(envelope.vfs.members[member.sourceKey as string] ?? {})
      }));

    const writtenFiles: Array<{ path: string; workspaceId: string }> = [];
    const importedPayloadIds: string[] = [];
    let importedTemplateId: string | null = null;
    let tornDown = false;

    try {
      // ---- Provenance + VFS writes (per-file operator writes; VFS lands
      // before the clock import, which syncs world_clock.json/event_list.json
      // into workspaces) -----------------------------------------------------
      try {
        if (envelope.realm.instance) {
          this.#realmRegistry.updateRealm(newRealmId, {
            instance: cloneRealmInstanceProvenance(
              envelope.realm.instance as unknown as RealmInstanceProvenance
            )
          });
        }
        const realmGlobalKey = realmGlobalWorkspaceKey(newRealmId);
        for (const plan of workspacePlan) {
          for (const file of plan.files) {
            this.writeFile(file.path, file.content, {
              workspaceId: plan.targetKey,
              ...(typeof file.readOnly === 'boolean' ? { readOnly: file.readOnly } : {}),
              ...(typeof file.owner === 'string' && file.owner ? { owner: file.owner } : {})
            });
            writtenFiles.push({ path: file.path, workspaceId: plan.targetKey });
          }
        }
        for (const file of Object.values(envelope.vfs.realmGlobal)) {
          this.writeFile(file.path, file.content, {
            workspaceId: realmGlobalKey,
            ...(typeof file.readOnly === 'boolean' ? { readOnly: file.readOnly } : {}),
            ...(typeof file.owner === 'string' && file.owner ? { owner: file.owner } : {})
          });
          writtenFiles.push({ path: file.path, workspaceId: realmGlobalKey });
        }
      } catch (err) {
        const rolledBack = this.#rollbackRealmArchiveImport({
          realmId: newRealmId,
          writtenFiles,
          importedPayloadIds: [],
          importedTemplateId: null,
          terminatedMembers: [],
          failures: []
        });
        throw this.#realmArchiveImportFailure(
          `importRealmArchive: VFS import failed (${thrownMessage(err, 'vfs-failed')})`,
          'vfs',
          newRealmId,
          rolledBack,
          [],
          writtenFiles.map((written) => written.path)
        );
      }

      // ---- Template: import only when the id is absent locally ---------------
      let templateImported = false;
      if (envelope.template) {
        if (this.getRealmTemplateBundle(envelope.template.id)) {
          warnings.push(`template '${envelope.template.id}' is already known locally — the local revision was kept`);
        } else {
          try {
            this.importRealmTemplate(envelope.template.payload);
            importedTemplateId = envelope.template.id;
            templateImported = true;
          } catch (err) {
            throw this.#realmArchiveImportFailure(
              `importRealmArchive: template import failed (${thrownMessage(err, 'template-failed')})`,
              'template',
              newRealmId,
              false
            );
          }
        }
      }

      // ---- Saved payloads (name collisions suffixed) -------------------------
      for (const payload of envelope.savedPayloads ?? []) {
        try {
          const saved = this.saveInstancePayload({
            name: this.#uniqueSavedPayloadName(payload.name),
            templateId: payload.templateId,
            templateVersion: payload.templateVersion,
            payload: payload.payload as Record<string, unknown>
          });
          importedPayloadIds.push(saved.id);
        } catch (err) {
          throw this.#realmArchiveImportFailure(
            `importRealmArchive: saved-payload import failed (${thrownMessage(err, 'payload-failed')})`,
            'payloads',
            newRealmId,
            false
          );
        }
      }

      // ---- Runtime slice install (members + bus + schedules + clock) ---------
      try {
        this.#runtime.importRealmSlice(
          this.#buildRealmSliceImportInput(envelope, newRealmId),
          this.#operatorContext()
        );
      } catch (err) {
        tornDown = true;
        const installedMembers = [...envelope.members.active, ...envelope.members.recycled].map((entry) => entry.id);
        const rolledBack = this.#rollbackRealmArchiveImport({
          realmId: newRealmId,
          writtenFiles,
          importedPayloadIds,
          importedTemplateId,
          terminatedMembers: [...installedMembers],
          failures: []
        });
        throw this.#realmArchiveImportFailure(
          `importRealmArchive: runtime slice install failed (${thrownMessage(err, 'slice-failed')})`,
          'runtime-slice',
          newRealmId,
          rolledBack,
          installedMembers
        );
      }

      // ---- Extension attachments (locally resolvable only) -------------------
      let attachmentsImported = 0;
      let attachmentsSkipped = 0;
      for (const attachment of envelope.realm.extensions ?? []) {
        if (this.#extensionRegistry.getExtension(attachment.extensionId)) {
          try {
            this.attachExtension(newRealmId, attachment.extensionId, {
              toolSelection: attachment.toolSelection
            });
            attachmentsImported += 1;
          } catch (err) {
            attachmentsSkipped += 1;
            warnings.push(
              `extension '${attachment.extensionId}' could not be re-attached (${thrownMessage(err, 'attach-failed')})`
            );
          }
        } else {
          attachmentsSkipped += 1;
          warnings.push(`extension '${attachment.extensionId}' is not installed locally — the attachment was skipped`);
        }
      }

      // ---- Capability re-application (R5, operator path only) ----------------
      this.#reapplyRealmArchiveMemberSelectors(envelope, newRealmId, warnings, attachmentsSkipped === 0);

      // ---- Receipt + reactive projections ------------------------------------
      const droppedAuthority = this.#computeDroppedRealmArchiveAuthority(envelope);
      this.#syncAgents();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncClockSnapshot();
      this.#syncRealms();
      this.#syncScheduledTimers();
      this.#scheduleAutoSave();

      return Object.freeze({
        success: true,
        realmId: newRealmId,
        realmName: this.#realmRegistry.getRealm(newRealmId)?.name ?? newRealm.name,
        archiveId: envelope.archiveId,
        membersImported: envelope.members.active.length,
        membersRecycled: envelope.members.recycled.length,
        filesImported: writtenFiles.length,
        schedulesImported: envelope.schedules.length,
        attachmentsImported,
        attachmentsSkipped,
        templateImported,
        payloadsImported: importedPayloadIds.length,
        droppedAuthority: Object.freeze(
          droppedAuthority.map((entry) => Object.freeze({
            memberId: entry.memberId,
            authorities: Object.freeze([...entry.authorities])
          }))
        ),
        warnings: Object.freeze([...warnings])
      });
    } catch (err) {
      const typed = Boolean(
        err
        && typeof err === 'object'
        && (err as { code?: string }).code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_IMPORT_FAILED
      );
      let rolledBack = false;
      if (!tornDown && this.#realmRegistry.getRealm(newRealmId)) {
        rolledBack = this.#rollbackRealmArchiveImport({
          realmId: newRealmId,
          writtenFiles,
          importedPayloadIds,
          importedTemplateId,
          terminatedMembers: [],
          failures: []
        });
      }
      if (typed) {
        const coded = err as Error & { report?: RealmArchiveImportRollbackReport };
        if (coded.report) {
          coded.report = Object.freeze({
            ...coded.report,
            rolledBack: coded.report.rolledBack || rolledBack
          });
        }
        throw coded;
      }
      throw this.#realmArchiveImportFailure(
        `importRealmArchive: ${thrownMessage(err, 'import-failed')}`,
        'import',
        newRealmId,
        rolledBack,
        [],
        writtenFiles.map((written) => written.path)
      );
    }
  }

  /**
   * Builds the descriptive archive envelope for one realm record. Read-only.
   *
   * @param realm - Frozen realm record to project.
   * @returns Envelope plus export-time disclosures.
   * @internal
   */
  #buildRealmArchiveEnvelope(realm: RealmRecord): { envelope: RealmArchiveEnvelope; warnings: string[] } {
    const realmId = realm.id;
    const warnings: string[] = [];
    const realmGlobalKey = realmGlobalWorkspaceKey(realmId);
    const inRealmFamily = (key: string): boolean => {
      if (key === realmGlobalKey) return true;
      const parsed = parseAgentIdentityKey(key);
      return parsed ? parsed.realmId === realmId : false;
    };

    const liveActive = this.#runtime.listAgents().filter((agent) => resolveMemberRealmId(agent) === realmId);
    const liveRecycled = this.#runtime.listRecycledAgents().filter((agent) => resolveMemberRealmId(agent) === realmId);
    const active = liveActive.map((agent) => serializeRealmArchiveAgent(agent));
    const recycled = liveRecycled.map((agent) => serializeRealmArchiveRecycledAgent(agent));
    const memberIds = new Set(active.map((entry) => entry.id));

    // Authority (descriptive only).
    const hostGrants: RealmArchiveAuthorityHostGrant[] = [];
    const hostGrantKeys = new Set<string>();
    const pushHostGrant = (authorityId: string, ref: string): void => {
      const parsed = parseAgentIdentityKey(ref);
      if (!parsed || parsed.realmId !== realmId || !memberIds.has(parsed.agentId)) return;
      const dedupeKey = `${authorityId}\u0000${parsed.agentId}`;
      if (hostGrantKeys.has(dedupeKey)) return;
      hostGrantKeys.add(dedupeKey);
      hostGrants.push({ authorityId, memberId: parsed.agentId });
    };
    for (const [authorityId, refs] of Object.entries(this.#runtime.listAuthorityGrants())) {
      for (const ref of refs) pushHostGrant(authorityId, ref);
    }
    for (const ref of this.#runtime.listRealmBypassGrants()) pushHostGrant('realmBypass', ref);
    const authorityMembers: Record<string, RealmArchiveAuthorityMemberProjection> = {};
    for (const agent of liveActive) {
      const projection = this.#identityPort
        ? this.#identityPort.getAgentIdentity(agent.id, { realmId })
        : null;
      const descriptor = projection?.authority;
      const allowedTools = Array.isArray(agent.config?.allowedTools) ? agent.config.allowedTools : [];
      authorityMembers[agent.id] = {
        kind: descriptor ? descriptor.kind : 'agent',
        visibility: descriptor ? descriptor.visibility : 'self',
        privileged: projection ? projection.privileged === true : agent.config?.privileged === true,
        allow: descriptor ? [...descriptor.allow] : [...allowedTools],
        extensions: descriptor ? [...descriptor.extensions] : [],
        realmBypass: projection ? projection.realmBypass === true : false
      };
    }

    // Messaging slice.
    const bus = this.#messagingBus.exportSnapshot();
    const inRealmKey = (key: string): boolean => {
      const parsed = parseAgentIdentityKey(key);
      return parsed ? parsed.realmId === realmId : memberIds.has(key);
    };
    const pickQueues = (map: Record<string, BusMessageEnvelope[]> | undefined): Record<string, BusMessageEnvelope[]> => {
      const picked: Record<string, BusMessageEnvelope[]> = {};
      for (const [key, list] of Object.entries(map ?? {})) {
        if (inRealmKey(key) && Array.isArray(list)) picked[key] = list;
      }
      return picked;
    };
    const activeQueues = pickQueues(bus.activeQueues);
    const archives = pickQueues(bus.archives);
    const registeredAgents = Object.keys(bus.registeredAgents ?? {}).filter(inRealmKey);
    const terminatedAgents = (bus.terminatedAgents ?? []).filter((key) => typeof key === 'string' && inRealmKey(key));
    const exportedMessageIds = new Set<string>();
    for (const list of [...Object.values(activeQueues), ...Object.values(archives)]) {
      for (const envelope of list) {
        if (typeof envelope?.id === 'string') exportedMessageIds.add(envelope.id);
        if (typeof envelope?.messageId === 'string') exportedMessageIds.add(envelope.messageId);
      }
    }
    const auditLog = (bus.auditLog ?? []).filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (exportedMessageIds.has(entry.id) || exportedMessageIds.has(entry.messageId)) return true;
      if (!this.#identityPort || typeof entry.to !== 'string' || typeof entry.from !== 'string') return false;
      // Fail-closed attribution: the recipient must resolve realm-exactly and
      // the sender must resolve unambiguously into the same realm. An
      // ambiguous same-literal-id sender (two realms) excludes the entry —
      // never mis-attributed to the source realm.
      const recipient = this.#identityPort.getAgentIdentity(entry.to, { realmId });
      if (!recipient) return false;
      const sender = this.#identityPort.getAgentIdentity(entry.from);
      return sender !== null && sender.realmId === realmId;
    });

    // Schedules slice.
    const schedules = this.#runtime.exportSchedules().filter((schedule) => {
      const ref = typeof schedule?.agentRef === 'string' && schedule.agentRef ? schedule.agentRef : '';
      const parsed = ref ? parseAgentIdentityKey(ref) : null;
      if (parsed) return parsed.realmId === realmId;
      return memberIds.has(schedule?.agentId);
    });

    // World-clock slice.
    const clockRaw = this.#worldClock.exportSnapshot(this.#operatorSubstrateContext());
    if (!clockRaw || (clockRaw as { success?: boolean }).success === false) {
      throw new Error('realm archive export: the world clock refused its snapshot');
    }
    const clockSnapshot = clockRaw as WorldClockSnapshot;
    const clocks: Record<string, PartitionClockSnapshot> = {};
    for (const [key, clock] of Object.entries(clockSnapshot.agentClocks ?? {})) {
      if (inRealmFamily(key)) clocks[key] = clock;
    }
    const events: Record<string, WorldEvent[]> = {};
    for (const [key, list] of Object.entries(clockSnapshot.agentEvents ?? {})) {
      if (inRealmFamily(key)) events[key] = list;
    }
    const globalClock = clocks[realmGlobalKey] ?? {
      totalSeconds: typeof clockSnapshot.totalSeconds === 'number' ? clockSnapshot.totalSeconds : 0,
      date: typeof clockSnapshot.date === 'string' && clockSnapshot.date ? clockSnapshot.date : 'Day 1',
      lastSync: Date.now()
    };

    // VFS slice.
    const vfsSnapshot: VirtualFsSnapshot = this.#virtualFs.exportSnapshot(this.#operatorSubstrateContext());
    const realmGlobalFiles: Record<string, VirtualFsPersistedFile> = {};
    for (const file of Object.values(vfsSnapshot[realmGlobalKey] ?? {})) {
      realmGlobalFiles[file.path] = file;
    }
    const memberFiles: Record<string, Record<string, VirtualFsPersistedFile>> = {};
    for (const entry of [...active, ...recycled]) {
      const candidates = this.#realmArchiveWorkspaceCandidates(
        (entry.config ?? {}) as Record<string, unknown>,
        entry.id,
        realmId
      );
      // Reserved shared workspaces (global/public, realm-global partitions)
      // and canonical keys outside the source realm family never leave the
      // host (D0b §3.1 "excluded", §3.2 assertion 3): they are filtered before
      // any bytes are collected, and each omission is disclosed.
      for (const key of candidates) {
        if (key === realmGlobalKey || vfsSnapshot[key] === undefined) continue;
        if (isReservedWorkspaceKey(key) || !this.#realmArchiveWorkspaceKeyInRealmFamily(key, realmId)) {
          warnings.push(
            `member '${entry.id}' workspace '${key}' is outside the exportable workspace scope — its bytes were not exported`
          );
        }
      }
      const present = candidates.filter((key) => key !== realmGlobalKey
        && !isReservedWorkspaceKey(key)
        && this.#realmArchiveWorkspaceKeyInRealmFamily(key, realmId)
        && vfsSnapshot[key] !== undefined);
      const chosen = present.find((key) => Object.keys(vfsSnapshot[key] ?? {}).length > 0) ?? null;
      if (!chosen) continue;
      if (chosen === entry.id && chosen !== candidates[0]) {
        warnings.push(`member '${entry.id}' only has a legacy bare-key workspace '${chosen}' — exported with a fallback warning`);
      }
      if (memberFiles[chosen]) {
        warnings.push(`members share the workspace '${chosen}' — exported once`);
        continue;
      }
      const files: Record<string, VirtualFsPersistedFile> = {};
      for (const file of Object.values(vfsSnapshot[chosen] ?? {})) {
        files[file.path] = file;
      }
      memberFiles[chosen] = files;
    }

    // Template slice (absent + warned when unresolvable).
    let template: RealmArchiveEnvelope['template'];
    if (typeof realm.templateId === 'string' && realm.templateId.trim()) {
      const templateId = realm.templateId.trim();
      const version = this.#effectiveTemplateVersion(templateId);
      if (version === null) {
        warnings.push(`template '${templateId}' is not resolvable in the effective catalog — the template section was omitted`);
      } else {
        try {
          template = { id: templateId, version, payload: this.exportRealmTemplate(templateId) };
        } catch (err) {
          warnings.push(`template '${templateId}' could not be exported (${thrownMessage(err, 'template-export-failed')})`);
        }
      }
    }

    // Realm-scoped saved payloads (S1 library), only for the realm template.
    const savedPayloads = typeof realm.templateId === 'string' && realm.templateId
      ? this.#savedInstancePayloads
        .filter((entry) => entry.templateId === realm.templateId)
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          templateId: entry.templateId,
          templateVersion: entry.templateVersion,
          savedAt: entry.savedAt,
          payload: entry.payload
        }))
      : [];

    const archiveId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `archive_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    const envelope: RealmArchiveEnvelope = {
      format: REALM_ARCHIVE_FORMAT,
      formatVersion: 1,
      archiveId,
      exportedAt: new Date().toISOString(),
      persistenceVersion: SANDBOX_PERSISTENCE_VERSION,
      source: { realmId },
      realm: {
        id: realm.id,
        name: realm.name,
        ...(typeof realm.description === 'string' ? { description: realm.description } : {}),
        ...(typeof realm.color === 'string' ? { color: realm.color } : {}),
        ...(typeof realm.templateId === 'string' ? { templateId: realm.templateId } : {}),
        ...(realm.instance ? { instance: realm.instance } : {}),
        ...(realm.extensions ? { extensions: realm.extensions } : {}),
        createdAt: realm.createdAt
      },
      ...(template ? { template } : {}),
      ...(savedPayloads.length > 0 ? { savedPayloads } : {}),
      members: { active, recycled },
      authority: { hostGrants, members: authorityMembers },
      messaging: { activeQueues, archives, registeredAgents, terminatedAgents, auditLog },
      schedules,
      worldClock: { global: globalClock, clocks, events },
      vfs: { realmGlobal: realmGlobalFiles, members: memberFiles },
      ...(warnings.length > 0 ? { warnings } : {})
    };
    return { envelope, warnings };
  }

  /**
   * Resolves the workspace-key candidates of one archived member, most
   * specific first: an explicit pin (verbatim), the realm-qualified canonical
   * key, then the legacy bare id.
   *
   * @param config - Member config projection.
   * @param memberId - Bare member id.
   * @param realmId - Realm id used to compose the canonical key.
   * @returns Ordered unique candidate keys.
   * @internal
   */
  #realmArchiveWorkspaceCandidates(config: Record<string, unknown>, memberId: string, realmId: string): string[] {
    const pin = this.#realmArchiveMemberPin(config, memberId);
    const canonical = createAgentIdentityKey(realmId, memberId);
    const candidates: string[] = [];
    for (const candidate of [pin, canonical, memberId]) {
      if (typeof candidate === 'string' && candidate && !candidates.includes(candidate)) candidates.push(candidate);
    }
    return candidates;
  }

  /**
   * Extracts an explicit member workspace pin (`config.workspaceId` or the
   * `config.workspace` alias), or `null`. A value equal to the bare member id
   * is the entity's normalized fallback, not an explicit pin (the VFS-owned
   * `resolveAgentPrivateWorkspaceKey` rule: only a value differing from the
   * bare id is preserved verbatim; otherwise the realm-qualified canonical key
   * is used).
   *
   * @param config - Member config projection.
   * @param memberId - Bare member id.
   * @returns Explicit pin string, or `null`.
   * @internal
   */
  #realmArchiveMemberPin(config: Record<string, unknown>, memberId: string): string | null {
    const workspaceId = config?.workspaceId;
    if (typeof workspaceId === 'string' && workspaceId && workspaceId !== memberId) return workspaceId;
    const workspace = config?.workspace;
    if (typeof workspace === 'string' && workspace && workspace !== memberId) return workspace;
    return null;
  }

  /**
   * Tests whether one archived member workspace key is exportable from the
   * source realm: opaque legacy/bare keys and canonical identity keys that
   * belong to the source realm pass; canonical keys of any other realm (or the
   * system scope) are foreign and must never leave the host (S2 verifier F-4
   * export-side exclusion). Reserved shared keys are classified separately by
   * `isReservedWorkspaceKey`.
   *
   * @param workspaceKey - Candidate workspace key.
   * @param realmId - Source realm id.
   * @returns True when the key is inside the source realm family.
   * @internal
   */
  #realmArchiveWorkspaceKeyInRealmFamily(workspaceKey: string, realmId: string): boolean {
    const parsed = parseAgentIdentityKey(workspaceKey);
    if (!parsed) return true;
    return parsed.realmId === realmId;
  }

  /**
   * Resolves the import-time target workspace key of one explicit member pin:
   * a canonical key inside the source realm family is remapped onto the fresh
   * realm id (never preserved as a stale source key that could name another
   * live realm's workspace); opaque pins are preserved verbatim. Out-of-scope
   * canonical pins are rejected in preflight, so only in-family canonical keys
   * reach the remap branch here.
   *
   * @param pinned - Explicit member pin, or `null`.
   * @param sourceRealmId - Archive source realm id.
   * @param newRealmId - Fresh target realm id.
   * @returns Target workspace key, or `null` when the member carries no pin.
   * @internal
   */
  #realmArchiveTargetWorkspaceKey(pinned: string | null, sourceRealmId: string, newRealmId: string): string | null {
    if (!pinned) return null;
    const parsed = parseAgentIdentityKey(pinned);
    if (parsed && parsed.realmId === sourceRealmId) return createAgentIdentityKey(newRealmId, parsed.agentId);
    return pinned;
  }

  /**
   * Fail-closed preflight of the archive's messaging/clock/schedule keys:
   * every partition key must resolve to a slice member (active or recycled) or
   * the source realm-global key.
   *
   * @param envelope - Validated archive envelope.
   * @param memberIds - Slice member ids.
   * @internal
   */
  #assertRealmArchiveSliceKeys(envelope: RealmArchiveEnvelope, memberIds: ReadonlySet<string>): void {
    const sourceRealmId = envelope.source.realmId;
    const globalKey = realmGlobalWorkspaceKey(sourceRealmId);
    const resolves = (key: string): boolean => {
      if (key === globalKey) return true;
      const parsed = parseAgentIdentityKey(key);
      if (parsed) return parsed.realmId === sourceRealmId && memberIds.has(parsed.agentId);
      return memberIds.has(key);
    };
    const keys = [
      ...Object.keys(envelope.messaging.activeQueues),
      ...Object.keys(envelope.messaging.archives),
      ...envelope.messaging.registeredAgents,
      ...envelope.messaging.terminatedAgents,
      ...Object.keys(envelope.worldClock.clocks),
      ...Object.keys(envelope.worldClock.events)
    ];
    for (const key of keys) {
      if (typeof key !== 'string' || !resolves(key)) {
        throw invalidRealmParams(`importRealmArchive: slice key '${String(key)}' does not resolve to a slice member`);
      }
    }
    for (const schedule of envelope.schedules) {
      const ref = typeof schedule.agentRef === 'string' && schedule.agentRef ? schedule.agentRef : schedule.agentId;
      if (!resolves(ref)) {
        throw invalidRealmParams(`importRealmArchive: schedule '${schedule.id}' does not resolve to a slice member`);
      }
    }
  }

  /**
   * Builds the runtime slice input from an archive envelope, remapping every
   * source canonical key onto the fresh realm id (bare member ids and pins
   * preserved; envelope fields never passed through raw).
   *
   * @param envelope - Validated archive envelope.
   * @param newRealmId - Fresh target realm id.
   * @returns Remapped runtime slice input.
   * @internal
   */
  #buildRealmSliceImportInput(envelope: RealmArchiveEnvelope, newRealmId: string): RealmSliceImportInput {
    const sourceRealmId = envelope.source.realmId;
    const remapKey = (key: string): string => {
      const parsed = parseAgentIdentityKey(key);
      if (parsed && parsed.realmId === sourceRealmId) return createAgentIdentityKey(newRealmId, parsed.agentId);
      return key;
    };
    const remapMember = (entry: RealmArchiveEnvelope['members']['active'][number]): RealmArchiveEnvelope['members']['active'][number] => {
      const config: Record<string, unknown> = { ...(entry.config ?? {}), realmId: newRealmId };
      // Canonical workspace pins inside the source family are remapped with
      // every other canonical key so the hydrated member resolves exactly the
      // fresh-namespace workspace its files were written to.
      for (const alias of ['workspaceId', 'workspace']) {
        const pin = config[alias];
        if (typeof pin !== 'string' || !pin) continue;
        const parsedPin = parseAgentIdentityKey(pin);
        if (parsedPin && parsedPin.realmId === sourceRealmId) {
          config[alias] = createAgentIdentityKey(newRealmId, parsedPin.agentId);
        }
      }
      return { ...entry, config: config as typeof entry.config };
    };
    const remapQueues = (
      map: Readonly<Record<string, readonly BusMessageEnvelope[]>>
    ): Record<string, BusMessageEnvelope[]> => {
      const remapped: Record<string, BusMessageEnvelope[]> = {};
      for (const [key, list] of Object.entries(map ?? {})) remapped[remapKey(key)] = [...list];
      return remapped;
    };
    const remapClocks = (
      map: Readonly<Record<string, PartitionClockSnapshot>>
    ): Record<string, PartitionClockSnapshot> => {
      const remapped: Record<string, PartitionClockSnapshot> = {};
      for (const [key, clock] of Object.entries(map ?? {})) remapped[remapKey(key)] = clock;
      return remapped;
    };
    const remapEvents = (
      map: Readonly<Record<string, readonly WorldEvent[]>>
    ): Record<string, WorldEvent[]> => {
      const remapped: Record<string, WorldEvent[]> = {};
      for (const [key, list] of Object.entries(map ?? {})) {
        remapped[remapKey(key)] = list.map((event) => this.#remapRealmArchiveEventKeys(event, remapKey));
      }
      return remapped;
    };
    return {
      realmId: newRealmId,
      members: {
        // Persistence and runtime declare structurally equivalent
        // `SerializedAgent` projections; the persistence copy's `modelConfig`
        // widening is narrowed here at the module seam.
        active: envelope.members.active.map(remapMember) as unknown as RealmSliceImportInput['members']['active'],
        recycled: envelope.members.recycled.map(remapMember) as unknown as RealmSliceImportInput['members']['recycled']
      },
      messaging: {
        activeQueues: remapQueues(envelope.messaging.activeQueues),
        archives: remapQueues(envelope.messaging.archives),
        registeredAgents: envelope.messaging.registeredAgents.map(remapKey),
        terminatedAgents: envelope.messaging.terminatedAgents.map(remapKey),
        auditLog: [...envelope.messaging.auditLog]
      },
      schedules: envelope.schedules.map((schedule) => ({
        ...schedule,
        ...(typeof schedule.agentRef === 'string' && schedule.agentRef ? { agentRef: remapKey(schedule.agentRef) } : {})
      })),
      worldClock: {
        global: envelope.worldClock.global,
        clocks: remapClocks(envelope.worldClock.clocks),
        events: remapEvents(envelope.worldClock.events)
      }
    };
  }

  /**
   * Remaps the canonical-key-bearing owner fields of one archived world event
   * (`ownerId`/`createdBy`/`resolvedBy`/`cancelledBy`); bare member ids and
   * non-key labels pass through verbatim. Event metadata is user-authored
   * content and stays verbatim (delivered-content fidelity).
   *
   * @param event - Archived event record.
   * @param remapKey - Canonical-key remap function.
   * @returns Event copy with remapped ownership references.
   * @internal
   */
  #remapRealmArchiveEventKeys(event: WorldEvent, remapKey: (key: string) => string): WorldEvent {
    const remapRef = (value: unknown): unknown => (typeof value === 'string' && value ? remapKey(value) : value);
    return {
      ...event,
      ownerId: remapRef(event.ownerId) as string,
      createdBy: remapRef(event.createdBy) as string,
      resolvedBy: remapRef(event.resolvedBy) as string | null,
      cancelledBy: remapRef(event.cancelledBy) as string | null
    };
  }

  /**
   * Re-applies archived capability selectors for imported active members
   * through the operator-gated capability path (R5): `allowedTools`/`tools`/
   * `toolPreset` resolve to concrete tool names (the wildcard `'*'` is never
   * re-minted), and the per-agent `extensionTools` selector is re-applied only
   * when every archived attachment resolved locally. Failures and drops are
   * disclosed, never fatal.
   *
   * @param envelope - Validated archive envelope.
   * @param newRealmId - Fresh realm id.
   * @param warnings - Warning accumulator.
   * @param extensionSelectorsSafe - True when no archived attachment was skipped.
   * @internal
   */
  #reapplyRealmArchiveMemberSelectors(
    envelope: RealmArchiveEnvelope,
    newRealmId: string,
    warnings: string[],
    extensionSelectorsSafe: boolean
  ): void {
    for (const member of envelope.members.active) {
      const config = (member.config ?? {}) as Record<string, unknown>;
      const rawSelector = config.allowedTools !== undefined
        ? config.allowedTools
        : (config.tools !== undefined
          ? config.tools
          : (config.toolPreset !== undefined ? config.toolPreset : config.tool_preset));
      const targetRef = createAgentIdentityKey(newRealmId, member.id);
      try {
        if (typeof rawSelector === 'string' || Array.isArray(rawSelector)) {
          const resolved = resolveToolPreset(rawSelector as string | readonly string[]);
          const concrete = resolved.filter((tool) => tool !== '*');
          if (resolved.includes('*')) {
            warnings.push(`member '${member.id}' wildcard tool selector was not re-applied (capability is operator-granted, never archive-restored)`);
          }
          if (concrete.length > 0) {
            this.#runtime.updateAgentConfig(targetRef, { allowedTools: [...concrete] }, this.#operatorContext());
          }
        }
        const selector = config.extensionTools;
        const selectorValid = selector === 'all' || Array.isArray(selector);
        if (selectorValid && extensionSelectorsSafe) {
          this.#runtime.updateAgentConfig(
            targetRef,
            { extensionTools: selector === 'all' ? 'all' : [...(selector as unknown[])].map((entry) => String(entry)) },
            this.#operatorContext()
          );
        } else if (selectorValid && !extensionSelectorsSafe) {
          warnings.push(`member '${member.id}' extension selector was not re-applied (an archived attachment is missing locally)`);
        }
      } catch (err) {
        warnings.push(`member '${member.id}' capability selectors were not re-applied (${thrownMessage(err, 'selector-failed')})`);
      }
    }
  }

  /**
   * Computes the descriptive authority items import never re-applied, per
   * member: `privileged`, `realmBypass`, the wildcard `'*'`, exact authority
   * ids in the archived descriptor allow set, and every archived host grant.
   *
   * @param envelope - Validated archive envelope.
   * @returns Per-member dropped authority records (members with drops only).
   * @internal
   */
  #computeDroppedRealmArchiveAuthority(
    envelope: RealmArchiveEnvelope
  ): Array<{ memberId: string; authorities: string[] }> {
    const dropped: Array<{ memberId: string; authorities: string[] }> = [];
    for (const [memberId, projection] of Object.entries(envelope.authority.members)) {
      const authorities = new Set<string>();
      if (projection.privileged) authorities.add('privileged');
      if (projection.realmBypass) authorities.add('realmBypass');
      for (const entry of projection.allow) {
        if (entry === '*') authorities.add('*');
        else if (typeof entry === 'string' && entry.startsWith('@')) authorities.add(entry);
      }
      for (const grant of envelope.authority.hostGrants) {
        if (grant.memberId === memberId) authorities.add(grant.authorityId);
      }
      if (authorities.size > 0) dropped.push({ memberId, authorities: [...authorities] });
    }
    return dropped;
  }

  /**
   * Suffixes a realm name until it is unique in the registry (`Name (2)`, ...).
   *
   * @param baseName - Requested display name.
   * @returns Unique realm display name.
   * @internal
   */
  #uniqueRealmName(baseName: string): string {
    const existing = new Set(this.#realmRegistry.listRealms().map((realm) => realm.name));
    if (!existing.has(baseName)) return baseName;
    let suffix = 2;
    while (existing.has(`${baseName} (${suffix})`)) suffix += 1;
    return `${baseName} (${suffix})`;
  }

  /**
   * Suffixes a saved-payload name until the library has no case-insensitive
   * collision (`Name (2)`, ...).
   *
   * @param baseName - Archived payload name.
   * @returns Unique library name.
   * @internal
   */
  #uniqueSavedPayloadName(baseName: string): string {
    const used = new Set(this.#savedInstancePayloads.map((entry) => entry.name.toLowerCase()));
    if (!used.has(baseName.toLowerCase())) return baseName;
    let suffix = 2;
    while (used.has(`${baseName} (${suffix})`.toLowerCase())) suffix += 1;
    return `${baseName} (${suffix})`;
  }

  /**
   * Best-effort rollback of a failed realm import: the record (recursive purge
   * of any member that slipped in), every written file, imported payloads, and
   * the imported template. Never throws.
   *
   * @param params - Rollback inventory.
   * @returns True when every rollback step completed.
   * @internal
   */
  #rollbackRealmArchiveImport(params: {
    realmId: string | null;
    writtenFiles: ReadonlyArray<{ path: string; workspaceId: string }>;
    importedPayloadIds: readonly string[];
    importedTemplateId: string | null;
    terminatedMembers: readonly string[];
    failures: string[];
  }): boolean {
    let rolledBack = true;
    if (params.realmId && this.#realmRegistry.getRealm(params.realmId)) {
      try {
        this.deleteRealm(params.realmId, { recursive: true });
      } catch (err) {
        rolledBack = false;
        params.failures.push(`realm rollback failed: ${thrownMessage(err, 'delete-failed')}`);
      }
    }
    for (const written of params.writtenFiles) {
      try {
        this.deleteFile(written.path, written.workspaceId);
      } catch (err) {
        rolledBack = false;
        params.failures.push(`file rollback failed for '${written.path}': ${thrownMessage(err, 'delete-failed')}`);
      }
    }
    for (const payloadId of params.importedPayloadIds) {
      try {
        this.deleteSavedInstancePayload(payloadId);
      } catch (err) {
        rolledBack = false;
        params.failures.push(`payload rollback failed for '${payloadId}': ${thrownMessage(err, 'delete-failed')}`);
      }
    }
    if (params.importedTemplateId) {
      try {
        this.deleteRealmTemplate(params.importedTemplateId);
      } catch (err) {
        rolledBack = false;
        params.failures.push(`template rollback failed for '${params.importedTemplateId}': ${thrownMessage(err, 'delete-failed')}`);
      }
    }
    return rolledBack;
  }

  /**
   * Builds the typed `ERR_STORE_REALM_IMPORT_FAILED` error with its rollback
   * report (the store passes the report through to the caller unchanged).
   *
   * @param message - Human-readable failure message.
   * @param failedStage - Stage label the failure occurred at.
   * @param realmId - Target realm id, or `null` for preflight failures.
   * @param rolledBack - Whether the mutations were rolled back.
   * @param terminatedMembers - Member ids the rollback purged.
   * @param evictedFiles - File paths the rollback evicted (optional).
   * @returns Coded error carrying the frozen report.
   * @internal
   */
  #realmArchiveImportFailure(
    message: string,
    failedStage: string,
    realmId: string | null,
    rolledBack: boolean,
    terminatedMembers: readonly string[] = [],
    evictedFiles: readonly string[] = []
  ): Error & { code: string; report: RealmArchiveImportRollbackReport } {
    const err = new Error(message) as Error & {
      code: string;
      report: RealmArchiveImportRollbackReport;
    };
    err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_IMPORT_FAILED;
    err.report = Object.freeze({
      realmId,
      failedStage,
      rolledBack,
      terminatedMembers: Object.freeze([...terminatedMembers]),
      evictedFiles: Object.freeze([...evictedFiles]),
      failures: Object.freeze([])
    });
    return err;
  }

  // ==========================================================================
  // Extension Registry (extension wave)
  // ==========================================================================

  /**
   * Retrieves the extension registry owned by this store (composition root).
   * Exposes the management contract to UI call sites (`listExtensions`,
   * `getExtension`, `installExtension`, `removeExtension`, `reconcile`,
   * `createAttachment`, `attachExtension`, `detachExtension`, `resolve`).
   * Registry mutations persist through the snapshot adapter and schedule the
   * existing debounced save; realm attachments ride the realm records, so they
   * persist through the realm registry adapter.
   *
   * @returns The `ExtensionRegistry` instance backing this store's global install records.
   *
   * @example
   * ```typescript
   * const registry = sandboxStore.getExtensionRegistry();
   * registry.listExtensions().forEach(record => console.log(record.id, record.status));
   * ```
   */
  getExtensionRegistry(): ExtensionRegistry {
    return this.#extensionRegistry;
  }

  /**
   * Lists the global extension install records in registry order.
   *
   * @returns Frozen install records (fresh copies).
   */
  listExtensions(): readonly ExtensionInstallRecord[] {
    return this.#extensionRegistry.listExtensions();
  }

  /**
   * Resolves one global extension install record.
   *
   * @param extensionId - Extension id.
   * @returns The frozen install record, or `null` when nothing is installed under the id.
   */
  getExtension(extensionId: string): ExtensionInstallRecord | null {
    return this.#extensionRegistry.getExtension(extensionId);
  }

  /**
   * Installs one global extension record under the operator principal: the
   * store stamps `createdAt`, defaults `status` to `'installed'` and
   * `installSource` to `'operator'`, validates the record through the owned
   * registry, and emits the `extension_installed` audit event. Installing an
   * id that already has a record fails closed; nothing connects.
   *
   * @param input - Extension identity and non-secret metadata.
   * @returns The frozen installed record.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When the input or record shape is invalid.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_ALREADY_INSTALLED} When the id already has an install record.
   *
   * @example
   * ```typescript
   * sandboxStore.installExtension({
   *   id: 'acme-scoring',
   *   kind: 'mcp',
   *   transportHint: { kind: 'http', url: 'https://mcp.example.com' }
   * });
   * ```
   */
  installExtension(input: ExtensionInstallInput): ExtensionInstallRecord {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalidRealmParams('installExtension requires an input object');
    }
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id) {
      throw invalidRealmParams('installExtension requires a non-empty extension id');
    }
    if (this.#extensionRegistry.getExtension(input.id)) {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_ALREADY_INSTALLED,
        `installExtension refuses extension '${input.id}' — it is already installed`
      );
    }
    const candidate: ExtensionInstallRecord = {
      id: input.id,
      kind: input.kind,
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      transportHint: input.transportHint,
      ...(input.credentialId !== undefined ? { credentialId: input.credentialId } : {}),
      status: input.status ?? 'installed',
      installSource: input.installSource ?? 'operator',
      ...(input.approvedUrl !== undefined ? { approvedUrl: input.approvedUrl } : {}),
      ...(input.normalizationWarnings !== undefined
        ? { normalizationWarnings: input.normalizationWarnings }
        : {}),
      createdAt: Date.now()
    };
    let record: ExtensionInstallRecord;
    try {
      record = this.#extensionRegistry.installExtension(candidate);
    } catch (error) {
      throw invalidRealmParams(
        `installExtension rejected extension '${input.id}' — ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // A fresh install is a new operator approval: no stale disconnect marker
    // may constrain the (re)installed record.
    this.#extensionDisconnected.delete(record.id);
    this.#emitExtensionAuditEvent('extension_installed', {
      extensionId: record.id,
      kind: record.kind,
      installSource: record.installSource
    });
    return record;
  }

  /**
   * Removes one global extension install record and emits the
   * `extension_removed` audit event. The removal fails closed while any Realm
   * still attaches the extension: detach it from every Realm first, so an
   * attachment can never dangle. Unknown ids are a `false` no-op (no event).
   *
   * @param extensionId - Extension id.
   * @returns `true` when a record existed and was removed.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_ATTACHED} When at least one Realm still attaches the extension.
   *
   * @example
   * ```typescript
   * sandboxStore.removeExtension('acme-scoring');
   * ```
   */
  removeExtension(extensionId: string): boolean {
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw invalidRealmParams('removeExtension requires a non-empty extension id');
    }
    const attachedRealmIds = this.#realmRegistry.listRealms()
      .filter((realm) => (realm.extensions ?? []).some((attachment) => attachment.extensionId === extensionId))
      .map((realm) => realm.id);
    if (attachedRealmIds.length > 0) {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_ATTACHED,
        `removeExtension refuses extension '${extensionId}' — still attached to ${attachedRealmIds.length} Realm(s): ${attachedRealmIds.join(', ')}`
      );
    }
    const removed = this.#extensionRegistry.removeExtension(extensionId);
    if (removed) {
      this.#emitExtensionAuditEvent('extension_removed', { extensionId });
      // Extension wave (P3.1): a removed install record has no live session
      // either — drop it best-effort and re-arbitrate the survivors.
      const live = this.#extensionConnections.get(extensionId);
      if (live) {
        void this.#closeExtensionConnection(live, 'removed').catch(() => undefined);
      }
      // The record is gone: no marker may outlive it.
      this.#extensionDisconnected.delete(extensionId);
    }
    return removed;
  }

  /**
   * Lists one Realm's extension attachments in record order.
   *
   * @param realmId - Registered Realm id.
   * @returns Frozen attachment records (fresh copies).
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When the Realm is unknown.
   */
  listRealmExtensions(realmId: string): readonly RealmExtensionAttachment[] {
    const realm = this.#realmRegistry.getRealm(realmId);
    if (!realm) {
      throw invalidRealmParams(`listRealmExtensions: unknown realm '${String(realmId)}'`);
    }
    return realm.extensions ?? Object.freeze([]);
  }

  /**
   * Attaches one globally installed extension to a Realm under the operator
   * principal: the store validates the Realm and the install record, stamps the
   * approval (`approvedAt`, `approvedBy: 'operator'`), writes the attachment on
   * the Realm record, and emits the `extension_attached` audit event. The
   * extension must be installed (an unknown id fails closed) and must not
   * already be attached to that Realm. Nothing connects: the attachment is
   * recorded state only.
   *
   * @param realmId - Registered Realm id.
   * @param extensionId - Id of the globally installed extension.
   * @param options - Realm-level tool selection; defaults to `'all'`.
   * @returns The frozen updated Realm record.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When the Realm is unknown, the selection is invalid, or the install record is malformed.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_INSTALLED} When no install record carries the id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_ALREADY_ATTACHED} When the Realm already attaches the extension.
   *
   * @example
   * ```typescript
   * sandboxStore.attachExtension('realm_demo', 'acme-scoring');
   * ```
   */
  attachExtension(
    realmId: string,
    extensionId: string,
    options: ExtensionAttachOptions = {}
  ): RealmRecord {
    const realm = this.#realmRegistry.getRealm(realmId);
    if (!realm) {
      throw invalidRealmParams(`attachExtension: unknown realm '${String(realmId)}'`);
    }
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw invalidRealmParams('attachExtension requires a non-empty extension id');
    }
    if (!this.#extensionRegistry.getExtension(extensionId)) {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_INSTALLED,
        `attachExtension: extension '${extensionId}' is not installed — install it first`
      );
    }
    const existing = realm.extensions ?? [];
    if (existing.some((attachment) => attachment.extensionId === extensionId)) {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_ALREADY_ATTACHED,
        `attachExtension: realm '${realmId}' already attaches extension '${extensionId}'`
      );
    }
    const attribution = this.#normalizeExtensionAuditAttribution(options);
    const toolSelection = options && options.toolSelection !== undefined ? options.toolSelection : 'all';
    let attachment: RealmExtensionAttachment;
    try {
      attachment = this.#extensionRegistry.createAttachment({
        extensionId,
        toolSelection,
        status: 'active',
        approvedAt: new Date().toISOString(),
        approvedBy: 'operator'
      });
    } catch (error) {
      throw invalidRealmParams(
        `attachExtension: invalid attachment — ${error instanceof Error ? error.message : String(error)}`
      );
    }
    let next: readonly RealmExtensionAttachment[];
    try {
      next = this.#extensionRegistry.attachExtension(existing, attachment);
    } catch (error) {
      throw invalidRealmParams(
        `attachExtension: failed to attach — ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const updated = this.#realmRegistry.updateRealm(realmId, { extensions: next });
    // A fresh attach is a new operator approval: it resets the connection-state
    // constraint so the attach's `active` status cannot churn against a stale
    // disconnect marker on the next install-only heal.
    this.#extensionDisconnected.delete(extensionId);
    this.#emitExtensionAuditEvent('extension_attached', {
      realmId,
      extensionId,
      source: attribution.source,
      ...(attribution.actorId ? { actorId: attribution.actorId } : {})
    });
    // Safe-state extension sweep (extension wave, P2.4): re-attaching an
    // extension can re-activate resolved tools that were dropped while it was
    // detached; members recompute at idle or on their next turn completion.
    this.#sweepRealmExtensionAuthorizations(realmId);
    return updated;
  }

  /**
   * Detaches one extension from a Realm under the operator principal and emits
   * the `extension_detached` audit event. Detaching an extension the Realm does
   * not attach is an idempotent no-op that returns the unchanged record (no
   * event, no persist); the global install record survives.
   *
   * @param realmId - Registered Realm id.
   * @param extensionId - Extension id.
   * @returns The frozen updated (or unchanged) Realm record.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When the Realm is unknown or the id is empty.
   *
   * @example
   * ```typescript
   * sandboxStore.detachExtension('realm_demo', 'acme-scoring');
   * ```
   */
  detachExtension(realmId: string, extensionId: string): RealmRecord {
    const realm = this.#realmRegistry.getRealm(realmId);
    if (!realm) {
      throw invalidRealmParams(`detachExtension: unknown realm '${String(realmId)}'`);
    }
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw invalidRealmParams('detachExtension requires a non-empty extension id');
    }
    const existing = realm.extensions ?? [];
    if (!existing.some((attachment) => attachment.extensionId === extensionId)) {
      return realm;
    }
    const next = this.#extensionRegistry.detachExtension(existing, extensionId);
    const updated = this.#realmRegistry.updateRealm(realmId, { extensions: next });
    this.#emitExtensionAuditEvent('extension_detached', { realmId, extensionId });
    // Safe-state extension sweep (extension wave, P2.4): detaching an
    // extension removes its tools from the Realm universe, so every active
    // member's effective grant set is recomputed; idle members are
    // reauthorized immediately, busy members queue until their next turn
    // completion.
    this.#sweepRealmExtensionAuthorizations(realmId);
    return updated;
  }

  /**
   * Validates one extension-audit attribution (M3 R6): the default is the
   * operator source; every non-operator source requires a non-empty actor id,
   * so an agent-originated mutation can never be recorded as an anonymous
   * operator act.
   *
   * @param options - Candidate attribution options.
   * @returns The frozen normalized attribution.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When the source or actor is malformed.
   */
  #normalizeExtensionAuditAttribution(options: ExtensionAuditAttribution | null | undefined): {
    readonly source: 'operator' | 'privileged-agent' | 'meta-realm-edit';
    readonly actorId: string | null;
  } {
    const source = options && options.source !== undefined ? options.source : 'operator';
    if (source !== 'operator' && source !== 'privileged-agent' && source !== 'meta-realm-edit') {
      throw invalidRealmParams(`extension audit source must be 'operator'/'privileged-agent'/'meta-realm-edit'`);
    }
    const rawActor = options && typeof options.actorId === 'string' ? options.actorId.trim() : '';
    if (source !== 'operator' && !rawActor) {
      throw invalidRealmParams('a non-operator extension audit source requires a non-empty actorId');
    }
    return Object.freeze({ source, actorId: rawActor || null });
  }

  /**
   * Replaces one attachment's realm-level tool ceiling (M3 ticket 094de1b).
   *
   * The attachment must already exist on the Realm and the selection must
   * resolve against the extension's **live** catalog: `'all'` always resolves,
   * while an explicit list must be a non-empty duplicate-free list of
   * currently active call names — any name the live catalog does not carry
   * fails the call closed, never silently granting or dropping something else.
   * The updated attachment is written through the realm registry, an
   * `extension_tool_selection_updated` audit event is emitted, and the
   * safe-state sweep reauthorizes the Realm members exactly like an attach
   * (idle members synchronously, busy members at their next `turn_complete`).
   *
   * @param realmId - Registered Realm id.
   * @param extensionId - Id of an extension the Realm already attaches.
   * @param selection - Replacement ceiling (`'all'` or explicit live call names).
   * @param options - Optional audit attribution (non-operator sources require an actor id).
   * @returns The frozen updated Realm record.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When the Realm/attachment is unknown, the selection is malformed, or a name is outside the live catalog.
   *
   * @example
   * ```typescript
   * sandboxStore.setExtensionToolSelection('realm_demo', 'acme-scoring', ['score_text']);
   * ```
   */
  setExtensionToolSelection(
    realmId: string,
    extensionId: string,
    selection: 'all' | readonly string[],
    options: ExtensionAuditAttribution = {}
  ): RealmRecord {
    const realm = this.#realmRegistry.getRealm(realmId);
    if (!realm) {
      throw invalidRealmParams(`setExtensionToolSelection: unknown realm '${String(realmId)}'`);
    }
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw invalidRealmParams('setExtensionToolSelection requires a non-empty extension id');
    }
    const attribution = this.#normalizeExtensionAuditAttribution(options);
    const existing = realm.extensions ?? [];
    const index = existing.findIndex((attachment) => attachment.extensionId === extensionId);
    if (index === -1) {
      throw invalidRealmParams(
        `setExtensionToolSelection: realm '${realmId}' does not attach extension '${extensionId}'`
      );
    }
    let normalized: 'all' | readonly string[];
    try {
      normalized = normalizeRealmAdminSelection(selection);
    } catch (error) {
      throw invalidRealmParams(
        `setExtensionToolSelection: invalid selection — ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (normalized !== 'all') {
      const liveNames = this.#connectedExtensionCatalogCallNames(extensionId);
      if (!liveNames) {
        throw invalidRealmParams(
          `setExtensionToolSelection: extension '${extensionId}' is not connected — explicit call names cannot resolve against the live catalog`
        );
      }
      for (let i = 0; i < normalized.length; i++) {
        if (!liveNames.includes(normalized[i])) {
          throw invalidRealmParams(
            `setExtensionToolSelection: '${normalized[i]}' is outside extension '${extensionId}' live catalog`
          );
        }
      }
    }
    const next = existing.map((attachment) => (
      attachment.extensionId === extensionId
        ? Object.freeze({ ...attachment, toolSelection: normalized })
        : attachment
    ));
    const updated = this.#realmRegistry.updateRealm(realmId, { extensions: next });
    this.#emitExtensionAuditEvent('extension_tool_selection_updated', {
      realmId,
      extensionId,
      toolSelection: normalized,
      source: attribution.source,
      ...(attribution.actorId ? { actorId: attribution.actorId } : {})
    });
    // Safe-state extension sweep: a narrower ceiling removes tools from the
    // Realm universe, a wider one restores them; members recompute at idle or
    // on their next turn completion exactly like the attach/detach sweeps.
    this.#sweepRealmExtensionAuthorizations(realmId);
    return updated;
  }

  /**
   * Live, conflict-free catalog call names of one connected extension, or
   * `null` when the extension has no active catalog (not installed, not
   * connected, or conflicted). Shared by the ceiling validation and the
   * realm-admin attach/ceiling pre-checks with `#listActiveCatalogEntries`
   * semantics.
   *
   * @param extensionId - Extension id.
   * @returns Frozen call names, or `null`.
   */
  #connectedExtensionCatalogCallNames(extensionId: string): readonly string[] | null {
    const entry = this.#extensionConnections.get(extensionId);
    if (!entry || entry.status !== 'connected' || entry.conflicts.length > 0 || !entry.catalog) return null;
    const names: string[] = [];
    for (const tool of entry.catalog.tools) names[names.length] = tool.callName;
    return Object.freeze(names);
  }

  // ==========================================================================
  // Extension Connections (extension wave, P3.1)
  // ==========================================================================

  /**
   * Connects one installed MCP extension over the HTTP transport and discovers
   * its tool catalog — the explicit operator connection act (nothing
   * auto-connects at load, hydration, or launch).
   *
   * Pre-connection gates run first and fail closed: an unknown id rejects with
   * `ERR_STORE_EXTENSION_NOT_INSTALLED`, a `pack` record with
   * `ERR_STORE_EXTENSION_NOT_CONNECTABLE`, a `stdio` transport hint with
   * `ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED`, and an unparseable transport
   * URL — or a present `approvedUrl` that is unparseable or not URL-equal to
   * the transport URL — with `ERR_STORE_EXTENSION_INVALID_ENDPOINT`. A `credentialId` on a non-`https:`
   * endpoint is refused with `ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL`
   * **before any vault read or network activity** (plaintext local servers
   * connect unauthenticated when no `credentialId` is bound); a bound
   * credential the vault cannot resolve fails closed with
   * `ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED` before any network activity.
   *
   * The session is single-flight: a concurrent call while the same extension is
   * `connecting` returns the in-flight promise, and a call on an already
   * `connected`/`conflict` extension resolves the current projection without a
   * second session. A successful discovery indexes the catalog, assigns the
   * connection-completion sequence, re-arbitrates every live catalog, syncs the
   * affected realm attachment statuses through the safe-state sweep, and emits
   * `extension_connected` (plus `extension_conflict` when the new catalog lost
   * a call-name race). An operational failure (unreachable endpoint, protocol,
   * timeout, cancellation, auth) resolves with status `'error'` and emits
   * `extension_connect_failed`; it never throws after the gates.
   *
   * @param extensionId - Id of a globally installed MCP extension.
   * @param options - Optional per-connection timeout budget.
   * @returns Promise of the frozen, secret-free connection projection.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_INSTALLED} When no install record carries the id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_CONNECTABLE} When the record is a `pack`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED} When the record carries the `stdio` transport hint.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_INVALID_ENDPOINT} When the transport URL is not an absolute URL, or the record's explicit `approvedUrl` is invalid or not URL-equal to the transport URL.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL} When a `credentialId` is bound to a non-`https:` endpoint.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED} When the bound credential is not in the vault.
   *
   * @example
   * ```typescript
   * const connection = await sandboxStore.connectExtension('acme-scoring');
   * if (connection.status === 'connected') {
   *   console.log(Object.keys(connection.catalog ?? {}));
   * }
   * ```
   */
  async connectExtension(
    extensionId: string,
    options: ExtensionConnectOptions = {}
  ): Promise<ExtensionConnectionProjection> {
    return this.#startExtensionConnection(extensionId, options, null);
  }

  /**
   * Disconnects one extension: aborts any in-flight connect, closes the live
   * session best-effort, drops the catalog and its call-name claims, re-
   * arbitrates the remaining catalogs (a formerly conflicted extension may
   * activate), syncs the affected realm attachment statuses through the
   * safe-state sweep, and emits `extension_disconnected`.
   *
   * A disconnect of an installed extension that has no live connection is an
   * idempotent `false` no-op (no event); an unknown id fails closed.
   *
   * @param extensionId - Id of a globally installed extension.
   * @returns `true` when a live connection existed and was closed.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_INSTALLED} When no install record carries the id.
   *
   * @example
   * ```typescript
   * await sandboxStore.disconnectExtension('acme-scoring');
   * ```
   */
  async disconnectExtension(extensionId: string): Promise<boolean> {
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw invalidRealmParams('disconnectExtension requires a non-empty extension id');
    }
    if (!this.#extensionRegistry.getExtension(extensionId)) {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_INSTALLED,
        `disconnectExtension: extension '${extensionId}' is not installed`
      );
    }
    const entry = this.#extensionConnections.get(extensionId);
    if (!entry) return false;
    await this.#closeExtensionConnection(entry, 'operator');
    return true;
  }

  /**
   * Reconnects one extension as an explicit re-discovery: the previous catalog
   * is captured, the live session is closed, a fresh connection discovers the
   * current catalog, and the resulting drift (`added`/`removed`/`changed` call
   * names, shadow changes, order, digest pair) is recorded on the projection
   * and disclosed through an `extension_catalog_drift` audit event when
   * non-empty. Re-arbitration runs on both catalog changes, and realm
   * attachment statuses follow. Grants are never silently mutated here: grant
   * reconciliation still flows through the P2.4 safe-state sweep.
   *
   * Reconnecting an extension with no live connection is a plain connect (no
   * drift). Pre-connection gates are identical to
   * {@link SandboxStore.connectExtension}.
   *
   * @param extensionId - Id of a globally installed MCP extension.
   * @param options - Optional per-connection timeout budget.
   * @returns Promise of the frozen connection projection.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_INSTALLED} When no install record carries the id.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_CONNECTABLE} When the record is a `pack`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED} When the record carries the `stdio` transport hint.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_INVALID_ENDPOINT} When the transport URL is not an absolute URL, or the record's explicit `approvedUrl` is invalid or not URL-equal to the transport URL.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL} When a `credentialId` is bound to a non-`https:` endpoint.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED} When the bound credential is not in the vault.
   *
   * @example
   * ```typescript
   * const connection = await sandboxStore.reconnectExtension('acme-scoring');
   * console.log(connection.drift?.added ?? []);
   * ```
   */
  async reconnectExtension(
    extensionId: string,
    options: ExtensionConnectOptions = {}
  ): Promise<ExtensionConnectionProjection> {
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw invalidRealmParams('reconnectExtension requires a non-empty extension id');
    }
    // F2: every gate (record, transport, approved-URL boundary, options,
    // plaintext, credential resolution) runs before the previous session is
    // touched, so a rejected reconnect leaves the live connection, catalog,
    // and resolver entry fully intact.
    const target = this.#resolveExtensionConnectionTarget(extensionId, options);
    const existing = this.#extensionConnections.get(extensionId);
    const previousCatalog = existing && existing.catalog ? existing.catalog : null;
    if (existing) {
      await this.#closeExtensionConnection(existing, 'reconnect');
    }
    return this.#startExtensionConnection(extensionId, options, previousCatalog, target);
  }

  /**
   * Returns one frozen, secret-free live connection projection.
   *
   * @param extensionId - Extension id.
   * @returns The frozen projection, or `null` when the extension is not connected.
   */
  getExtensionConnection(extensionId: string): ExtensionConnectionProjection | null {
    const entry = this.#extensionConnections.get(extensionId);
    return entry ? this.#projectExtensionConnection(entry) : null;
  }

  /**
   * Lists every frozen live connection projection in connection-completion
   * sequence order; an in-flight (`connecting`) entry has no sequence yet and
   * sorts last by extension id.
   *
   * @returns Frozen connection projections.
   */
  listExtensionConnections(): readonly ExtensionConnectionProjection[] {
    return Object.freeze(this.#listExtensionConnectionProjections());
  }

  /**
   * Resolves one arbitration-active call name to its owning extension and wire
   * tool name — the P3.1 catalog-resolution projection consumed by surfaces
   * that need the live mapping. Execution does not read this map: the
   * dispatcher consumes the descriptor-backed provider port, so a name whose
   * descriptor was refused contributes no binding. Call names of conflicted,
   * errored, or disconnected extensions resolve to `null`.
   *
   * @param callName - Sanitized model-facing call name.
   * @returns Frozen `{ extensionId, serverToolName }`, or `null` when unresolved.
   */
  resolveExtensionCallName(callName: string): { extensionId: string; serverToolName: string } | null {
    const resolved = this.#extensionCallNameResolver.get(callName);
    return resolved ? Object.freeze({ ...resolved }) : null;
  }

  /**
   * Runs every pre-connection gate and resolves the dial target for one
   * extension connection: record existence and kind, transport kind and URL
   * parsing, the approved-URL boundary, options validation, the
   * plaintext-credential gate, and vault credential resolution. The method is
   * synchronous and touches no live connection state, so callers may validate
   * before tearing a previous session down.
   *
   * @param extensionId - Extension id.
   * @param options - Connection options.
   * @returns The validated dial target (`url`, `credential`, `requestTimeoutMs`).
   */
  #resolveExtensionConnectionTarget(
    extensionId: string,
    options: ExtensionConnectOptions
  ): { url: URL; credential: McpClientCredential | null; requestTimeoutMs: number | null } {
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw invalidRealmParams('connectExtension requires a non-empty extension id');
    }
    const record = this.#extensionRegistry.getExtension(extensionId);
    if (!record) {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_INSTALLED,
        `connectExtension: extension '${extensionId}' is not installed — install it first`
      );
    }
    if (record.kind !== 'mcp') {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_NOT_CONNECTABLE,
        `connectExtension refuses extension '${extensionId}' — kind '${record.kind}' carries no connectable transport`
      );
    }
    const hint = record.transportHint;
    if (hint.kind !== 'http') {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_TRANSPORT_UNSUPPORTED,
        `connectExtension refuses extension '${extensionId}' — stdio is a host-only transport and is not supported`
      );
    }
    let url: URL;
    try {
      url = new URL(hint.url);
    } catch {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_INVALID_ENDPOINT,
        `connectExtension refuses extension '${extensionId}' — the transport URL is not an absolute URL`
      );
    }

    // Approval boundary: an explicitly approved URL is an operator statement
    // that must agree with the transport URL. A present `approvedUrl` is
    // parsed and URL-normalized-compared before the plaintext gate, any vault
    // read, the single-flight check, and any network activity; a stale or
    // inconsistent approval never dials anything.
    if (record.approvedUrl !== undefined) {
      let approvedUrl: URL;
      try {
        approvedUrl = new URL(record.approvedUrl);
      } catch {
        throw codedStoreError(
          SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_INVALID_ENDPOINT,
          `connectExtension refuses extension '${extensionId}' — the approved URL is not an absolute URL`
        );
      }
      if (approvedUrl.href !== url.href) {
        throw codedStoreError(
          SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_INVALID_ENDPOINT,
          `connectExtension refuses extension '${extensionId}' — the approved URL '${record.approvedUrl}' does not match the transport URL '${hint.url}'`
        );
      }
    }

    const requestTimeoutMs = options && options.requestTimeoutMs !== undefined ? options.requestTimeoutMs : null;
    if (
      requestTimeoutMs !== null
      && (typeof requestTimeoutMs !== 'number' || !Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0)
    ) {
      throw invalidRealmParams('connectExtension options.requestTimeoutMs must be a positive finite number');
    }

    // Plaintext-credential gate: refuse BEFORE any vault read or network
    // activity. Plaintext local servers connect unauthenticated (no
    // credentialId bound), never with a credential.
    if (record.credentialId !== undefined && url.protocol !== 'https:') {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL,
        `connectExtension refuses extension '${extensionId}' — a credential is never sent over '${url.protocol}'`
      );
    }

    // Credential resolution happens only after the plaintext gate passed and
    // only over https; an unresolvable id fails closed before any network.
    let credential: McpClientCredential | null = null;
    if (record.credentialId !== undefined) {
      const resolved = this.#credentialResolver.getCredential(record.credentialId);
      const secret = resolved && typeof resolved.apiKey === 'string' ? resolved.apiKey : '';
      if (!secret) {
        throw codedStoreError(
          SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_CREDENTIAL_UNRESOLVED,
          `connectExtension refuses extension '${extensionId}' — the bound credential is not resolvable in the vault`
        );
      }
      credential = Object.freeze({ id: record.credentialId, secret });
    }

    return { url, credential, requestTimeoutMs };
  }

  /**
   * Shared implementation of connect/reconnect: target resolution,
   * single-flight, and session open. `previousCatalog` is non-null only on a
   * reconnect re-discovery, where the drift diff is disclosed. A caller that
   * already validated the target (reconnect validates before tearing the
   * previous session down) passes `resolvedTarget` instead of resolving again.
   *
   * @param extensionId - Extension id.
   * @param options - Connection options.
   * @param previousCatalog - Catalog captured before the reconnect, or `null`.
   * @param resolvedTarget - Precomputed validated target, or `null` to resolve here.
   * @returns Promise of the frozen connection projection.
   */
  async #startExtensionConnection(
    extensionId: string,
    options: ExtensionConnectOptions,
    previousCatalog: ExtensionCatalog | null,
    resolvedTarget: { url: URL; credential: McpClientCredential | null; requestTimeoutMs: number | null } | null = null
  ): Promise<ExtensionConnectionProjection> {
    const target = resolvedTarget ?? this.#resolveExtensionConnectionTarget(extensionId, options);
    const { url, credential, requestTimeoutMs } = target;

    // Single-flight: one live session per extension. A concurrent connect
    // returns the in-flight promise; an already-connected extension keeps its
    // session (re-discovery is an explicit reconnect).
    const existing = this.#extensionConnections.get(extensionId);
    if (existing) {
      if (existing.status === 'connecting' && existing.pending) {
        return existing.pending;
      }
      if ((existing.status === 'connected' || existing.status === 'conflict') && existing.session) {
        return this.#projectExtensionConnection(existing);
      }
    }

    const entry: LiveExtensionConnection = {
      extensionId,
      status: 'connecting',
      sequence: 0,
      session: null,
      abortController: new AbortController(),
      catalog: null,
      serverInfo: null,
      protocolVersion: null,
      conflicts: Object.freeze([]),
      drift: null,
      error: null,
      connectedAt: null,
      discoveredAt: null,
      pending: null
    };
    this.#extensionConnections.set(extensionId, entry);
    this.#syncExtensionConnections();
    const pending = this.#openExtensionConnection(entry, url, credential, requestTimeoutMs, previousCatalog);
    entry.pending = pending;
    return pending;
  }

  /**
   * Opens and discovers one live session for a `connecting` entry. Operational
   * failures resolve with an `error` projection and an
   * `extension_connect_failed` audit event; an entry that was disconnected or
   * replaced while awaiting is abandoned silently and reported as cancelled.
   *
   * @param entry - The live connection entry (already registered).
   * @param url - Validated endpoint URL.
   * @param credential - Resolved vault credential, or `null` for anonymous.
   * @param requestTimeoutMs - Validated timeout budget, or `null` for the default.
   * @param previousCatalog - Catalog captured before a reconnect, or `null`.
   * @returns Promise of the frozen connection projection.
   */
  async #openExtensionConnection(
    entry: LiveExtensionConnection,
    url: URL,
    credential: McpClientCredential | null,
    requestTimeoutMs: number | null,
    previousCatalog: ExtensionCatalog | null
  ): Promise<ExtensionConnectionProjection> {
    try {
      const session = await createMcpClient({
        transport: { kind: 'http', url: url.href },
        ...(credential !== null ? { credential } : {}),
        ...(requestTimeoutMs !== null ? { requestTimeoutMs } : {}),
        signal: entry.abortController.signal
      });
      if (!this.#isCurrentExtensionConnection(entry)) {
        entry.status = 'error';
        entry.error = Object.freeze({ code: MCP_CLIENT_ERROR_CODES.CANCELLED });
        await session.close();
        return this.#projectExtensionConnection(entry);
      }
      entry.session = session;
      entry.serverInfo = session.serverInfo;
      entry.protocolVersion = session.protocolVersion;
      const discovered = await session.listTools();
      if (!this.#isCurrentExtensionConnection(entry)) {
        entry.status = 'error';
        entry.error = Object.freeze({ code: MCP_CLIENT_ERROR_CODES.CANCELLED });
        await session.close();
        return this.#projectExtensionConnection(entry);
      }
      const catalog = indexExtensionCatalog({ extensionId: entry.extensionId, tools: discovered });
      entry.catalog = catalog;
      entry.sequence = this.#extensionConnectionSequence + 1;
      this.#extensionConnectionSequence = entry.sequence;
      entry.connectedAt = Date.now();
      entry.discoveredAt = entry.connectedAt;
      entry.error = null;
      const drift = previousCatalog !== null ? diffExtensionCatalogs(previousCatalog, catalog) : null;
      entry.drift = drift;
      // Arbitration assigns the final `connected`/`conflict` status, rebuilds
      // the call-name resolver, syncs attachment statuses, and emits any
      // conflict-transition events.
      this.#rearbitrateExtensionCatalogs([entry.extensionId]);
      // A successful discovery clears any explicit-disconnect marker: from
      // here on the live entry itself constrains the attachment status.
      this.#extensionDisconnected.delete(entry.extensionId);
      this.#emitExtensionAuditEvent('extension_connected', {
        extensionId: entry.extensionId,
        status: entry.status,
        sequence: entry.sequence,
        digest: catalog.digest,
        toolCount: catalog.tools.length,
        shadowedCount: catalog.shadowedTools.length,
        protocolVersion: entry.protocolVersion
      });
      if (drift !== null && !extensionCatalogDiffIsEmpty(drift)) {
        this.#emitExtensionAuditEvent('extension_catalog_drift', {
          extensionId: entry.extensionId,
          previousDigest: drift.digests.previous,
          digest: drift.digests.next,
          added: [...drift.added],
          removed: [...drift.removed],
          changed: [...drift.changed],
          shadowedAdded: [...drift.shadowedAdded],
          shadowedRemoved: [...drift.shadowedRemoved],
          reordered: drift.reordered
        });
      }
      return this.#projectExtensionConnection(entry);
    } catch (error) {
      const openedSession = entry.session;
      entry.session = null;
      if (!this.#isCurrentExtensionConnection(entry)) {
        if (openedSession) {
          try {
            await openedSession.close();
          } catch {
            /* Best-effort teardown of the abandoned session. */
          }
        }
        return this.#projectExtensionConnection(entry);
      }
      entry.catalog = null;
      entry.serverInfo = null;
      entry.protocolVersion = null;
      entry.status = 'error';
      entry.error = classifyExtensionConnectError(error);
      this.#rearbitrateExtensionCatalogs([entry.extensionId]);
      this.#emitExtensionAuditEvent('extension_connect_failed', {
        extensionId: entry.extensionId,
        code: entry.error.code,
        ...(entry.error.details !== undefined ? { details: entry.error.details } : {})
      });
      if (openedSession) {
        try {
          await openedSession.close();
        } catch {
          /* Best-effort teardown; the failed connection never leaks a session. */
        }
      }
      return this.#projectExtensionConnection(entry);
    } finally {
      entry.pending = null;
      this.#syncExtensionConnections();
    }
  }

  /**
   * Closes and drops one live connection: the entry leaves the map immediately
   * (so any in-flight discovery is abandoned and reported cancelled), the
   * session is aborted and closed best-effort, the remaining catalogs re-
   * arbitrate, the affected attachment statuses sync, and the disconnect is
   * audited.
   *
   * @param entry - Live connection entry to drop.
   * @param reason - Audit reason (`operator`, `reconnect`, or `removed`).
   */
  async #closeExtensionConnection(
    entry: LiveExtensionConnection,
    reason: 'operator' | 'reconnect' | 'removed'
  ): Promise<void> {
    entry.status = 'error';
    entry.error = Object.freeze({ code: MCP_CLIENT_ERROR_CODES.CANCELLED });
    this.#extensionConnections.delete(entry.extensionId);
    // The explicit-disconnect marker keeps the attachment `unavailable` across
    // the install-only heal until an explicit successful connect clears it.
    this.#extensionDisconnected.add(entry.extensionId);
    entry.abortController.abort();
    const session = entry.session;
    entry.session = null;
    entry.catalog = null;
    entry.pending = null;
    this.#rearbitrateExtensionCatalogs([entry.extensionId]);
    this.#emitExtensionAuditEvent('extension_disconnected', { extensionId: entry.extensionId, reason });
    if (session) {
      try {
        await session.close();
      } catch {
        /* Best-effort teardown; a failed close never fails the disconnect. */
      }
    }
    this.#syncExtensionConnections();
  }

  /**
   * Re-arbitrates every live catalog by explicit connection-completion
   * sequence, updates each entry's `connected`/`conflict` status and conflict
   * list, emits `extension_conflict` on conflict transitions (both entering
   * and clearing), rebuilds the call-name resolver, and syncs the affected
   * realm attachment statuses through the safe-state sweep.
   *
   * @param affectedExtensionIds - Extension ids whose connection state changed
   *   (removed ids included, since they no longer appear in the map).
   */
  #rearbitrateExtensionCatalogs(affectedExtensionIds: readonly string[]): void {
    const entries: Array<{ entry: LiveExtensionConnection; catalog: ExtensionCatalog }> = [];
    for (const entry of this.#extensionConnections.values()) {
      if (entry.catalog) entries.push({ entry, catalog: entry.catalog });
    }
    const outcomes = arbitrateExtensionCatalogs(entries.map(({ entry, catalog }) => ({
      extensionId: entry.extensionId,
      sequence: entry.sequence,
      catalog
    })));
    const outcomeById = new Map(outcomes.map((outcome) => [outcome.extensionId, outcome]));
    for (const { entry } of entries) {
      const outcome = outcomeById.get(entry.extensionId);
      if (!outcome) continue;
      const wasConflicted = entry.status === 'conflict';
      entry.conflicts = outcome.conflicts;
      entry.status = outcome.status === 'active' ? 'connected' : 'conflict';
      if (!wasConflicted && entry.status === 'conflict') {
        this.#emitExtensionAuditEvent('extension_conflict', {
          extensionId: entry.extensionId,
          status: 'conflict',
          conflicts: outcome.conflicts.map((conflict) => ({
            callName: conflict.callName,
            otherExtensionId: conflict.otherExtensionId
          }))
        });
      } else if (wasConflicted && entry.status === 'connected') {
        this.#emitExtensionAuditEvent('extension_conflict', {
          extensionId: entry.extensionId,
          status: 'active',
          conflicts: []
        });
      }
    }
    this.#rebuildExtensionCallNameResolver();
    this.#rebuildExtensionDescriptors();
    const affected = new Set<string>(affectedExtensionIds);
    for (const entry of this.#extensionConnections.values()) affected.add(entry.extensionId);
    const statusSwept = this.#syncExtensionAttachmentStatuses(affected);
    // Catalog changes can alter the grant universe without a status
    // transition (reconnect drift, a fresh connect of an attached extension):
    // sweep every remaining realm that attaches an affected extension so
    // members reauthorize at the next safe state.
    this.#sweepRealmsForExtensionCatalogChange(affected, statusSwept);
    this.#syncExtensionConnections();
  }

  /**
   * Rebuilds the active call-name resolver from the arbitration-active
   * catalogs in connection-completion sequence order. The first active
   * extension to expose a call name keeps it (arbitration already guarantees
   * exclusivity; the claim check is defense-in-depth).
   */
  #rebuildExtensionCallNameResolver(): void {
    const resolver = new Map<string, { extensionId: string; serverToolName: string }>();
    for (const { entry, catalog } of this.#listActiveCatalogEntries()) {
      for (const tool of catalog.tools) {
        if (!resolver.has(tool.callName)) {
          resolver.set(tool.callName, Object.freeze({
            extensionId: entry.extensionId,
            serverToolName: tool.serverToolName
          }));
        }
      }
    }
    this.#extensionCallNameResolver = resolver;
  }

  /**
   * Lists the arbitration-active catalogs in connection-completion sequence
   * order (ties by extension id): `connected`, conflict-free entries only.
   * The single ordering authority shared by the call-name resolver, the
   * synthesized descriptor registry, and the catalog-driven grant-universe
   * expansion.
   *
   * @returns Active catalog entries in deterministic order.
   */
  #listActiveCatalogEntries(): Array<{ entry: LiveExtensionConnection; catalog: ExtensionCatalog }> {
    const entries: Array<{ entry: LiveExtensionConnection; catalog: ExtensionCatalog }> = [];
    for (const entry of this.#extensionConnections.values()) {
      if (entry.status === 'connected' && entry.conflicts.length === 0 && entry.catalog) {
        entries.push({ entry, catalog: entry.catalog });
      }
    }
    entries.sort((a, b) => (
      a.entry.sequence - b.entry.sequence
      || (a.entry.extensionId < b.entry.extensionId ? -1 : a.entry.extensionId > b.entry.extensionId ? 1 : 0)
    ));
    return entries;
  }

  /**
   * Projects the active catalogs' call names for the catalog-driven grant
   * universe (extension wave, P3.3): `{ extensionId, callNames }` in
   * connection-completion sequence order, server order within a catalog.
   *
   * @returns Live catalog call names by extension.
   */
  #listLiveExtensionCatalogCallNames(): Array<{ extensionId: string; callNames: readonly string[] }> {
    return this.#listActiveCatalogEntries().map(({ entry, catalog }) => ({
      extensionId: entry.extensionId,
      callNames: catalog.tools.map((tool) => tool.callName)
    }));
  }

  /**
   * Rebuilds the frozen synthesized descriptor registry from the active
   * catalogs (extension wave, P3.3). One descriptor per call name via
   * `synthesizeExtensionToolDescriptor`; a refused schema projection yields no
   * descriptor (the tool stays unavailable and is disclosed by the fidelity
   * summary), a malformed catalog entry is skipped without poisoning the rest,
   * and the resulting null-prototype record is frozen.
   */
  #rebuildExtensionDescriptors(): void {
    const registry: Record<string, ExtensionToolDescriptor> = Object.create(null);
    for (const { entry, catalog } of this.#listActiveCatalogEntries()) {
      for (const tool of catalog.tools) {
        if (Object.prototype.hasOwnProperty.call(registry, tool.callName)) continue;
        try {
          const { descriptor } = synthesizeExtensionToolDescriptor({
            extensionId: entry.extensionId,
            callName: tool.callName,
            serverToolName: tool.serverToolName,
            ...(tool.description !== undefined ? { description: tool.description } : {}),
            ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {})
          });
          if (descriptor) registry[tool.callName] = descriptor;
        } catch {
          // A malformed/reserved catalog entry contributes no descriptor; the
          // tool stays unavailable instead of poisoning the registry.
        }
      }
    }
    this.#extensionDescriptors = Object.freeze(registry);
  }

  /**
   * Own-property descriptor lookup over the frozen null-prototype registry.
   *
   * @param callName - Sanitized model-facing call name.
   * @returns The frozen descriptor, or `null` when the name is not executable.
   */
  #lookupExtensionDescriptor(callName: string): ExtensionToolDescriptor | null {
    if (typeof callName !== 'string' || callName === '') return null;
    if (!Object.prototype.hasOwnProperty.call(this.#extensionDescriptors, callName)) return null;
    const descriptor = this.#extensionDescriptors[callName];
    return descriptor || null;
  }

  /**
   * Sweeps every realm that attaches any affected extension after a catalog
   * change (extension wave, P3.3): the catalog-driven grant universe can
   * change without an attachment-status transition (a reconnect that adds or
   * removes tools, a fresh connect of an already-attached extension), so the
   * P2.4 safe-state reauthorize runs for those realms too — idle members
   * immediately, busy members at their next `turn_complete`.
   *
   * @param extensionIds - Extension ids whose catalog state changed.
   * @param alreadySwept - Realms the attachment-status sync already swept.
   */
  #sweepRealmsForExtensionCatalogChange(
    extensionIds: ReadonlySet<string>,
    alreadySwept: ReadonlySet<string>
  ): void {
    const impacted = new Set<string>();
    for (const realm of this.#realmRegistry.listRealms()) {
      if (alreadySwept.has(realm.id)) continue;
      const attachments = realm.extensions;
      if (!attachments || attachments.length === 0) continue;
      for (const attachment of attachments) {
        if (extensionIds.has(attachment.extensionId)) {
          impacted.add(realm.id);
          break;
        }
      }
    }
    for (const realmId of impacted) {
      this.#sweepRealmExtensionAuthorizations(realmId);
    }
  }

  /**
   * Syncs the realm attachment status of every affected extension to its live
   * connection state — `connected` → `active`, `conflict` → `conflict`,
   * `error`/`disconnected` → `unavailable` — and invokes the P2.4 safe-state
   * sweep for every realm whose attachment actually changed. A `connecting`
   * entry never churns attachment state.
   *
   * @param extensionIds - Extension ids whose connection state changed.
   * @returns The ids of the realms whose attachment status was rewritten (and
   *   therefore swept) — empty when no attachment changed.
   */
  #syncExtensionAttachmentStatuses(extensionIds: ReadonlySet<string>): ReadonlySet<string> {
    const impactedRealms = new Set<string>();
    if (extensionIds.size === 0) return impactedRealms;
    const desired = new Map<string, 'active' | 'conflict' | 'unavailable'>();
    for (const extensionId of extensionIds) {
      const entry = this.#extensionConnections.get(extensionId);
      if (entry && entry.status === 'connecting') continue;
      if (entry && entry.status === 'connected') {
        desired.set(extensionId, 'active');
      } else if (entry && entry.status === 'conflict') {
        desired.set(extensionId, 'conflict');
      } else {
        desired.set(extensionId, 'unavailable');
      }
    }
    if (desired.size === 0) return impactedRealms;

    for (const realm of this.#realmRegistry.listRealms()) {
      const attachments = realm.extensions;
      if (!attachments || attachments.length === 0) continue;
      let changed = false;
      const synced = attachments.map((attachment) => {
        const next = desired.get(attachment.extensionId);
        if (next === undefined || attachment.status === next) return attachment;
        changed = true;
        return Object.freeze({ ...attachment, status: next });
      });
      if (!changed) continue;
      try {
        this.#realmRegistry.updateRealm(realm.id, { extensions: synced });
        impactedRealms.add(realm.id);
      } catch {
        // A rejected sync leaves the persisted attachment state untouched.
      }
    }
    for (const realmId of impactedRealms) {
      this.#sweepRealmExtensionAuthorizations(realmId);
    }
    return impactedRealms;
  }

  /**
   * Live attachment status of one extension, or `null` when no live state
   * constrains it: no live connection, or a `connecting` session (transient).
   * Used by the attachment heal so a disconnected extension is not healed back
   * to `active` while its live state says otherwise.
   *
   * @param extensionId - Extension id.
   * @returns The live status, or `null` when unconstrained.
   */
  #liveAttachmentStatus(extensionId: string): 'active' | 'conflict' | 'unavailable' | null {
    const entry = this.#extensionConnections.get(extensionId);
    if (entry && entry.status === 'connected') return 'active';
    if (entry && entry.status === 'conflict') return 'conflict';
    if (entry && entry.status === 'error') return 'unavailable';
    // A `connecting` session (transient) or no live entry imposes no
    // constraint — except when an explicit disconnect marker is present: a
    // disconnected extension stays `unavailable` across install-only heals
    // until an explicit successful connect clears the marker.
    return this.#extensionDisconnected.has(extensionId) ? 'unavailable' : null;
  }

  /**
   * Whether a live entry is still the map's current registration for its id.
   *
   * @param entry - Candidate entry.
   * @returns `true` when the entry is current.
   */
  #isCurrentExtensionConnection(entry: LiveExtensionConnection): boolean {
    return this.#extensionConnections.get(entry.extensionId) === entry;
  }

  /**
   * Builds one frozen, secret-free connection projection.
   *
   * @param entry - Live connection entry.
   * @returns Frozen projection.
   */
  #projectExtensionConnection(entry: LiveExtensionConnection): ExtensionConnectionProjection {
    const catalog = entry.catalog;
    let catalogProjection: Record<string, ExtensionConnectionCatalogEntry> | null = null;
    const shadows: Array<{ callName: string; serverToolName: string }> = [];
    if (catalog) {
      catalogProjection = {};
      for (const tool of catalog.tools) {
        catalogProjection[tool.callName] = Object.freeze({
          extensionId: entry.extensionId,
          serverToolName: tool.serverToolName,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {})
        });
      }
      for (const shadow of catalog.shadowedTools) {
        shadows.push(Object.freeze({ callName: shadow.callName, serverToolName: shadow.serverToolName }));
      }
    }
    return Object.freeze({
      extensionId: entry.extensionId,
      status: entry.status,
      serverInfo: entry.serverInfo,
      protocolVersion: entry.protocolVersion,
      catalog: catalogProjection ? Object.freeze(catalogProjection) : null,
      shadows: Object.freeze(shadows),
      conflicts: entry.conflicts,
      drift: entry.drift,
      error: entry.error,
      connectedAt: entry.connectedAt,
      discoveredAt: entry.discoveredAt,
      digest: catalog ? catalog.digest : null
    });
  }

  /**
   * Lists every connection projection in completion-sequence order (in-flight
   * connects last, by extension id).
   *
   * @returns Projections in deterministic order.
   */
  #listExtensionConnectionProjections(): ExtensionConnectionProjection[] {
    return [...this.#extensionConnections.values()]
      .sort((a, b) => {
        const aOrder = a.sequence > 0 ? a.sequence : Number.MAX_SAFE_INTEGER;
        const bOrder = b.sequence > 0 ? b.sequence : Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.extensionId < b.extensionId ? -1 : a.extensionId > b.extensionId ? 1 : 0;
      })
      .map((entry) => this.#projectExtensionConnection(entry));
  }

  /**
   * Mirrors the live connection map into the reactive `extensionConnections`
   * projection.
   */
  #syncExtensionConnections(): void {
    this.extensionConnections = Object.freeze(this.#listExtensionConnectionProjections());
  }

  /**
   * Drops every live connection without audit (hydration/reset/destroy
   * teardown): aborts in-flight connects, fires best-effort session closes,
   * and clears the resolver map and the reactive projection.
   */
  #teardownExtensionConnections(): void {
    const entries = [...this.#extensionConnections.values()];
    this.#extensionConnections.clear();
    this.#extensionCallNameResolver.clear();
    this.#extensionDescriptors = Object.freeze(Object.create(null));
    this.#extensionDisconnected.clear();
    this.extensionConnections = Object.freeze([]);
    for (const entry of entries) {
      // In-flight connect callers observe a cancelled projection, never a
      // stale `connecting` one.
      entry.status = 'error';
      entry.error = Object.freeze({ code: MCP_CLIENT_ERROR_CODES.CANCELLED });
      entry.abortController.abort();
      const session = entry.session;
      if (session) {
        void session.close().catch(() => undefined);
      }
    }
  }

  // ==========================================================================
  // Extension Authorization Sweep (extension wave, P2.4)
  // ==========================================================================

  /**
   * Recomputes one agent's effective extension grant set from live store state:
   * the Realm's resolved-and-attached tool universe (the Realm record's
   * `resolvedTools` keys whose extension still carries an `active` attachment,
   * plus each attached-active extension's live conflict-free catalog call
   * names capped by that attachment's `toolSelection`) intersected with the
   * agent's normalized `config.extensionTools` selector.
   *
   * The realm scope of a member resolves through the same trim semantics as
   * realm grouping; an explicit `realmIdOverride` is used for the launch-time
   * computation when the member's realm is still being composed.
   *
   * @param agentRef - Active agent reference (identity key or bare id).
   * @param realmIdOverride - Trusted realm id override, or `null` to read the member's own membership.
   * @returns Effective grants, dropped selector names, and the normalized selector; `null` for an unknown agent.
   */
  #effectiveExtensionGrantsFor(
    agentRef: string,
    realmIdOverride: string | null = null
  ): {
    grants: readonly string[];
    dropped: readonly string[];
    selector: 'all' | readonly string[];
  } | null {
    const live = this.#runtime.getAgent(agentRef);
    if (!live) return null;
    const realmId = realmIdOverride ?? resolveMemberRealmId(live) ?? GENERIC_REALM_ID;
    const realm = this.#realmRegistry.getRealm(realmId);
    const universe = resolveRealmExtensionToolUniverse(realm, this.#listLiveExtensionCatalogCallNames());
    // Selector resolution (fail closed): a *launched* agent carries the
    // selector as an own config property (`'all'` when no explicit list was
    // composed). A hydrated agent whose selector was withheld and could not be
    // healed by store state has no such property — the sweep then treats it as
    // an empty selector (nothing granted, never the `'all'` default).
    const hasSelector = live.config
      ? Object.prototype.hasOwnProperty.call(live.config, 'extensionTools')
      : false;
    const selector = hasSelector
      ? normalizeExtensionSelector(live.config.extensionTools)
      : Object.freeze([] as string[]);
    const { grants, dropped } = computeEffectiveExtensionGrants(universe, selector);
    return { grants, dropped, selector };
  }

  /**
   * Applies one member's effective extension grant set through the runtime's
   * operator-gated `reauthorizeAgent` and clears its queue entry. Unknown or
   * recycled members are dropped silently; a rejected reauthorize leaves the
   * previous descriptor in place (fail closed) and only warns.
   *
   * @param agentRef - Active agent reference (identity key or bare id).
   */
  #applyExtensionReauthorize(agentRef: string): void {
    const resolved = this.#effectiveExtensionGrantsFor(agentRef);
    this.#pendingExtensionReauthorize.delete(agentRef);
    if (!resolved) return;
    const live = this.#runtime.getAgent(agentRef);
    if (resolved.dropped.length > 0) {
      // Fail closed is not silent: selector names that resolved to nothing are
      // dropped, never granted, and surfaced here.
      console.warn(
        `[SandboxStore] extension selector names not granted for agent '${live ? live.id : 'unknown'}': `
        + resolved.dropped.join(', ')
      );
    }
    try {
      this.#runtime.reauthorizeAgent(
        agentRef,
        { extensionTools: resolved.grants },
        this.#operatorContext()
      );
    } catch (err) {
      console.warn(
        '[SandboxStore] extension reauthorize failed:',
        sanitizeDiagnosticError(err) || 'update-rejected'
      );
    }
  }

  /**
   * Safe-state extension reauthorize for one member (extension wave, P2.4):
   * an idle member is reauthorized synchronously at the mutation point; a busy
   * member (in-flight turn or waiting/canceling state) queues, and its sweep
   * applies on the next `turn_complete` — never mid-turn.
   *
   * @param agentRef - Active agent reference (identity key or bare id).
   */
  #queueExtensionReauthorize(agentRef: string): void {
    if (this.#extensionSweepBlocked.has(agentRef)) return;
    if (!this.#runtime.getAgent(agentRef)) {
      this.#pendingExtensionReauthorize.delete(agentRef);
      return;
    }
    if (this.#runtime.isAgentBusy(agentRef)) {
      this.#pendingExtensionReauthorize.add(agentRef);
      return;
    }
    this.#applyExtensionReauthorize(agentRef);
  }

  /**
   * Recomputes and reauthorizes every active member of one Realm (attach/
   * detach sweep). Deferred members stay queued for their next turn boundary.
   *
   * @param realmId - Registered Realm id.
   */
  #sweepRealmExtensionAuthorizations(realmId: string): void {
    for (const member of this.#runtime.listAgents()) {
      const memberRealmId = resolveMemberRealmId(member);
      if (memberRealmId !== realmId) continue;
      this.#queueExtensionReauthorize(createAgentIdentityKey(memberRealmId, member.id));
    }
  }

  /**
   * Recomputes and reauthorizes every active member across all Realms
   * (hydration sweep: the attachment heal may have changed a Realm's universe
   * after the capability heal ran). Reads the live registry, so it does not
   * depend on the reactive projection timing.
   */
  #sweepAllExtensionAuthorizations(): void {
    for (const member of this.#runtime.listAgents()) {
      this.#queueExtensionReauthorize(createAgentIdentityKey(resolveMemberRealmId(member), member.id));
    }
  }

  /**
   * Drops one member's queued safe-state sweep (kill/purge/recycle): a
   * terminated registration is never reauthorized later.
   *
   * @param agentRef - Agent reference that left the active registry.
   */
  #dropPendingExtensionReauthorize(agentRef: string): void {
    this.#pendingExtensionReauthorize.delete(agentRef);
    // A registration that left the active set before its first sweep is never
    // swept later (ticket 9327633).
    this.#pendingRegistrationSweep.delete(agentRef);
  }

  // ==========================================================================
  // Realm Launch from Template & Seed (Wave B)
  // ==========================================================================

  /**
   * Lists the Realm launch templates this store can launch, in bundle
   * registration order.
   *
   * The store owns the launch catalog (the templates `launchRealmFromTemplate`
   * resolves against), so the launcher UI reads its picker options here instead
   * of importing fixtures directly. Every entry is the normalized format-v2
   * template (`normalizeTemplate` of the authored bundle template), so the
   * picker and review surfaces can read declared inputs, placements, and
   * directives without a format branch. The catalog is the effective catalog:
   * the baked catalog (the `realmCatalog` demo fixture plus the embedded
   * template bundles generated by the content pipeline), any per-instance
   * injection ({@link SandboxStoreOptions.realmTemplateBundles}), and runtime
   * imports layered on top — an imported bundle whose id matches a shipped id
   * replaces it in place, so every id resolves exactly once
   * ({@link SandboxStore.listRealmTemplateSources} labels the origin); the
   * returned array and every template are frozen.
   *
   * @returns Frozen normalized launch templates, in effective bundle order.
   *
   * @example
   * ```typescript
   * const templates = sandboxStore.listRealmTemplates();
   * console.log(templates.map((template) => template.id));
   * ```
   */
  listRealmTemplates(): readonly RealmTemplate[] {
    return this.#realmTemplates;
  }

  /**
   * Resolves the launch bundle behind one template id: the normalized
   * format-v2 template plus the bundle file bodies its prompt parts, placement
   * `file` sources, and input `defaultFile` prefills resolve against.
   *
   * The launcher preview reads the same normalized template and bundle files
   * the launch materializes with, so a previewed prompt can never disagree
   * with the launched system prompt. Unknown ids return `null`; the returned
   * bundle and template are frozen.
   *
   * @param templateId - Template id from `listRealmTemplates()`.
   * @returns The frozen normalized bundle view, or `null` for an unknown id.
   *
   * @example
   * ```typescript
   * const bundle = sandboxStore.getRealmTemplateBundle('demo');
   * console.log(bundle?.template.formatVersion, Object.keys(bundle?.files ?? {}).length);
   * ```
   */
  getRealmTemplateBundle(templateId: string): RealmTemplateBundleView | null {
    if (typeof templateId !== 'string' || templateId.trim().length === 0) return null;
    const bundle = this.#realmTemplateBundles.find((entry) => entry.template.id === templateId);
    return bundle ? resolveTemplateBundleView(bundle) : null;
  }

  /**
   * Lists the origin label of every effective launch template for the launcher
   * UI (Wave T, ticket 0df20ae): `shipped` for the store's build/host catalog,
   * `imported` for runtime imports, plus a `replacesShipped` flag so an import
   * that shadows a shipped id renders as `imported · replaces shipped`.
   *
   * Entries follow the effective catalog order (`listRealmTemplates()` order),
   * one entry per template id, and are frozen. `templateVersion` is `null` only
   * for a malformed host injection that cannot be versioned yet.
   *
   * @returns Frozen per-template source labels, in effective catalog order.
   *
   * @example
   * ```typescript
   * const labels = sandboxStore.listRealmTemplateSources();
   * const shadowed = labels.find((entry) => entry.replacesShipped);
   * ```
   */
  listRealmTemplateSources(): readonly RealmTemplateSourceInfo[] {
    const shippedIds: ReadonlySet<string> = new Set(
      this.#hostRealmTemplateBundles.map((bundle) => bundle.template.id)
    );
    return Object.freeze(this.#realmTemplateBundles.map((bundle) => {
      const imported = this.#realmTemplateImports.has(bundle.template.id);
      return Object.freeze({
        templateId: bundle.template.id,
        source: imported ? 'imported' as const : 'shipped' as const,
        replacesShipped: imported && shippedIds.has(bundle.template.id),
        templateVersion: this.#effectiveTemplateVersion(bundle.template.id)
      });
    }));
  }

  /**
   * Resolves the origin label of one effective launch template, or `null` for
   * an unknown id. See {@link SandboxStore.listRealmTemplateSources}.
   *
   * @param templateId - Template id from `listRealmTemplates()`.
   * @returns The frozen source label, or `null` for an unknown id.
   */
  getRealmTemplateSource(templateId: string): RealmTemplateSourceInfo | null {
    if (typeof templateId !== 'string' || templateId.trim().length === 0) return null;
    return this.listRealmTemplateSources().find((entry) => entry.templateId === templateId) ?? null;
  }

  /**
   * Imports a Realm template bundle into the runtime registry (Wave T, ticket
   * 0df20ae): parses and validates the canonical transport payload through
   * `realmCatalog` (typed `RealmCatalogError` on malformed input), enforces the
   * per-bundle and total byte budgets, replaces any previous import of the same
   * id (in place — one effective entry per id), and persists the registry
   * synchronously.
   *
   * Shadowing: an imported id matching a shipped (baked/injected) bundle
   * replaces that entry in the effective catalog, so future launches resolve
   * the import while the shipped revision stays untouched; deleting the import
   * reveals the shipped revision again. The launcher labels the entry through
   * {@link SandboxStore.listRealmTemplateSources}.
   *
   * Persistence honesty: the write is synchronous and not debounced. When the
   * snapshot write fails (quota, unavailable storage), the import is rolled
   * back before the typed `ERR_STORE_TEMPLATE_PERSIST_FAILED` is thrown —
   * an accepted receipt always means the persisted snapshot agrees with the
   * effective catalog.
   *
   * @param payload - Canonical transport object or JSON text (`{ formatVersion, template, files }`).
   * @returns Receipt: id, content version, shadow status, and effective import budget.
   * @throws `RealmCatalogError` with code `ERR_BUNDLE_FORMAT`/`ERR_TEMPLATE_INVALID` when the payload is malformed.
   * @throws Error with code `'ERR_STORE_TEMPLATE_TOO_LARGE'` when the bundle or the total import budget exceeds its cap (nothing is mutated).
   * @throws Error with code `'ERR_STORE_TEMPLATE_PERSIST_FAILED'` when the snapshot write fails (the registry was rolled back).
   *
   * @example
   * ```typescript
   * const receipt = sandboxStore.importRealmTemplate(jsonText);
   * console.log(receipt.templateId, receipt.replacesShipped);
   * ```
   */
  importRealmTemplate(payload: string | object): RealmTemplateImportReceipt {
    return this.#importRealmTemplateInternal(payload, false);
  }

  /**
   * Computes the would-be receipt of an import without mutating anything (Wave
   * U, ticket 2518510): parses and validates the canonical transport payload
   * through `realmCatalog`, applies the same per-bundle and total byte budgets,
   * and reports the shadow labels and effective budget a real import would
   * produce — with zero side effects (no registry mutation, no persistence, no
   * trust change). This is the `dry_run` pipeline behind
   * `import_realm_template`, so validation can never drift from the real call.
   *
   * @param payload - Canonical transport object or JSON text.
   * @returns The would-be import receipt (carrying `dryRun: true`).
   * @throws `RealmCatalogError` on a malformed payload; over-budget payloads fail with `ERR_STORE_TEMPLATE_TOO_LARGE`.
   */
  previewRealmTemplateImport(payload: string | object): RealmTemplateImportPreview {
    return this.#importRealmTemplateInternal(payload, true) as RealmTemplateImportPreview;
  }

  /**
   * Shared parse → cap → (optionally mutate+persist) import pipeline.
   *
   * @param payload - Canonical transport object or JSON text.
   * @param dryRun - When `true`, computes the receipt and stops before any mutation.
   * @returns Import receipt (or preview receipt when `dryRun`).
   * @internal
   */
  #importRealmTemplateInternal(payload: string | object, dryRun: boolean): RealmTemplateImportReceipt {
    const parsed = parseTemplateBundle(payload);
    const canonicalPayload = parsed.serialized;
    const bytes = utf8ByteLength(canonicalPayload);
    const templateId = parsed.template.id;

    if (bytes > REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES) {
      throw templateImportTooLargeError(
        `importRealmTemplate: bundle '${templateId}' is ${bytes} bytes, exceeding the per-bundle cap of `
        + `${REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES} bytes — content-heavy templates must travel as files/packages`
      );
    }

    const previous = this.#realmTemplateImports.get(templateId);
    const previousTotal = this.#totalImportedRealmTemplateBytes();
    const nextTotal = previousTotal - (previous?.bytes ?? 0) + bytes;
    if (nextTotal > REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES) {
      throw templateImportTooLargeError(
        `importRealmTemplate: importing '${templateId}' would raise the imported-template total to ${nextTotal} bytes, `
        + `exceeding the total budget of ${REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES} bytes`
      );
    }

    const shippedIds: ReadonlySet<string> = new Set(
      this.#hostRealmTemplateBundles.map((bundle) => bundle.template.id)
    );
    const receipt = {
      templateId,
      templateVersion: parsed.version,
      source: 'imported' as const,
      replacesShipped: shippedIds.has(templateId),
      replacedImport: previous !== undefined,
      totalImportedBytes: nextTotal,
      warnings: Object.freeze([...parsed.warnings])
    };
    if (dryRun) {
      return Object.freeze({ ...receipt, dryRun: true as const });
    }

    const previousImports = new Map(this.#realmTemplateImports);
    this.#realmTemplateImports.set(templateId, Object.freeze({
      bundle: Object.freeze({ template: parsed.template, files: parsed.files }),
      payload: canonicalPayload,
      version: parsed.version,
      bytes
    }));
    this.#resolveRealmTemplateCatalog();
    try {
      this.#persistRealmTemplateRegistry();
    } catch (err) {
      this.#realmTemplateImports = previousImports;
      this.#resolveRealmTemplateCatalog();
      throw err;
    }

    return Object.freeze({ ...receipt, totalImportedBytes: this.#totalImportedRealmTemplateBytes() });
  }

  /**
   * Exports one effective launch template as canonical transport JSON (Wave T,
   * ticket 0df20ae): the exact authored bundle future launches resolve — an
   * import when one shadows the id (its persisted canonical transport payload
   * is re-emitted verbatim), otherwise the shipped revision rendered by
   * `realmCatalog.serializeTemplateBundle` (recursively sorted keys, no
   * insignificant whitespace), so re-importing the output reproduces the same
   * authored content version.
   *
   * @param templateId - Template id from `listRealmTemplates()`.
   * @returns Canonical transport JSON text.
   * @throws Error with code `'ERR_STORE_INVALID_PARAMS'` for an unknown or blank id.
   *
   * @example
   * ```typescript
   * const json = sandboxStore.exportRealmTemplate('consensus_test');
   * ```
   */
  exportRealmTemplate(templateId: string): string {
    if (typeof templateId !== 'string' || templateId.trim().length === 0) {
      throw invalidRealmParams(`exportRealmTemplate: unknown realm template '${String(templateId)}'`);
    }
    const imported = this.#realmTemplateImports.get(templateId);
    if (imported) return imported.payload;
    const bundle = this.#realmTemplateBundles.find((entry) => entry.template.id === templateId);
    if (!bundle) {
      throw invalidRealmParams(`exportRealmTemplate: unknown realm template '${String(templateId)}'`);
    }
    return serializeTemplateBundle({ template: bundle.template, files: bundle.files });
  }

  /**
   * Deletes a runtime template import (Wave T, ticket 0df20ae). Only imports
   * are deletable: shipped (baked/host-injected) templates have no delete path
   * here, so this method returns `false` when the id carries no import and the
   * shipped revision keeps resolving.
   *
   * Deleting an import that shadowed a shipped id reveals the shipped revision
   * in place. Like import, the removal persists synchronously; a failed write
   * rolls the deletion back and throws
   * `ERR_STORE_TEMPLATE_PERSIST_FAILED`.
   *
   * @param templateId - Template id to reveal the shipped revision for.
   * @returns `true` when an import was removed; `false` when the id carries no import (unknown/blank included).
   * @throws Error with code `'ERR_STORE_TEMPLATE_PERSIST_FAILED'` when the snapshot write fails (the import survives).
   *
   * @example
   * ```typescript
   * const removed = sandboxStore.deleteRealmTemplate('demo');
   * ```
   */
  deleteRealmTemplate(templateId: string): boolean {
    if (typeof templateId !== 'string' || templateId.trim().length === 0) return false;
    const id = templateId;
    if (!this.#realmTemplateImports.has(id)) return false;

    const previousImports = new Map(this.#realmTemplateImports);
    this.#realmTemplateImports.delete(id);
    this.#resolveRealmTemplateCatalog();
    try {
      this.#persistRealmTemplateRegistry();
    } catch (err) {
      this.#realmTemplateImports = previousImports;
      this.#resolveRealmTemplateCatalog();
      throw err;
    }
    return true;
  }

  /**
   * Lists the session-only pending instance payloads (Wave U candidates,
   * ticket 2518510) in submission order.
   *
   * Candidates are produced by `submit_hydration_package` after validation
   * against the effective catalog template; they are never persisted, and the
   * existing launch attach path (`{ package }`) stays the only attach
   * mechanism. Each entry is frozen.
   *
   * @returns Frozen candidate list.
   */
  listPendingInstancePayloads(): readonly PendingInstancePayload[] {
    return Object.freeze([...this.#pendingInstancePayloads.values()]);
  }

  /**
   * Resolves one pending instance payload by template id (Wave U ticket
   * 2518510).
   *
   * @param templateId - Template id the candidate targets.
   * @returns The frozen candidate, or `null` when none is pending.
   */
  getPendingInstancePayload(templateId: string): PendingInstancePayload | null {
    if (typeof templateId !== 'string' || templateId.trim().length === 0) return null;
    return this.#pendingInstancePayloads.get(templateId) ?? null;
  }

  /**
   * Clears the pending instance payload for one template id (Wave U ticket
   * 2518510). Session-only surface: nothing was persisted, so clearing cannot
   * leave storage behind.
   *
   * @param templateId - Template id whose candidate is removed.
   * @returns `true` when a candidate existed and was removed; `false` otherwise.
   */
  clearPendingInstancePayload(templateId: string): boolean {
    if (typeof templateId !== 'string' || templateId.trim().length === 0) return false;
    return this.#pendingInstancePayloads.delete(templateId);
  }

  /**
   * Saves one named payload into the persisted hydration-payload library
   * (ticket 81d8267).
   *
   * The draft is validated fail-closed (`ERR_STORE_INVALID_PARAMS`) and the
   * entry is persisted through the existing debounced snapshot save as the
   * additive `savedInstancePayloads` field. The saved bytes are an isolated
   * frozen copy; the payload itself is re-validated against the effective
   * template contract only when a launch attaches it — never here.
   *
   * @param draft - Name, template id/version, and authored payload.
   * @returns The frozen saved entry.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When the draft is malformed, the name is blank or duplicate, or the payload is not digestible.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_PAYLOAD_LIBRARY_TOO_LARGE} When the serialized payload exceeds `SAVED_INSTANCE_PAYLOAD_MAX_BYTES`.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_PAYLOAD_LIBRARY_FULL} When the library already holds `SAVED_INSTANCE_PAYLOAD_MAX_ENTRIES` entries.
   *
   * @example
   * ```typescript
   * const entry = sandboxStore.saveInstancePayload({
   *   name: 'Act 1',
   *   templateId: 'session_zero',
   *   templateVersion: version,
   *   payload
   * });
   * ```
   */
  saveInstancePayload(draft: SavedInstancePayloadDraft): SavedInstancePayload {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
      throw invalidRealmParams('Saving a payload requires a draft object.');
    }
    const name = typeof draft.name === 'string' ? draft.name.trim() : '';
    if (!name) {
      throw invalidRealmParams('Name the payload before saving it.');
    }
    if (this.#savedInstancePayloads.some((entry) => entry.name.toLowerCase() === name.toLowerCase())) {
      throw invalidRealmParams(`A payload named "${name}" is already saved — pick another name.`);
    }
    const templateId = typeof draft.templateId === 'string' ? draft.templateId.trim() : '';
    if (!templateId) {
      throw invalidRealmParams('The payload must name the template it targets.');
    }
    const templateVersion = typeof draft.templateVersion === 'string' ? draft.templateVersion.trim() : '';
    if (!templateVersion) {
      throw invalidRealmParams('The payload must carry the template version it was validated against.');
    }
    const payload = draft.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw invalidRealmParams('The payload must be a canonical authored payload object.');
    }
    let digest: string;
    let serializedBytes: number;
    try {
      digest = payloadDigest(payload);
      const serialized = JSON.stringify(payload);
      serializedBytes = utf8ByteLength(typeof serialized === 'string' ? serialized : '');
    } catch (error) {
      throw invalidRealmParams(
        error instanceof Error && error.message ? error.message : 'The payload could not be digested.'
      );
    }
    if (serializedBytes > SAVED_INSTANCE_PAYLOAD_MAX_BYTES) {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_PAYLOAD_LIBRARY_TOO_LARGE,
        `The payload serializes to ${serializedBytes} bytes and exceeds the ${SAVED_INSTANCE_PAYLOAD_MAX_BYTES}-byte saved-payload cap.`
      );
    }
    if (this.#savedInstancePayloads.length >= SAVED_INSTANCE_PAYLOAD_MAX_ENTRIES) {
      throw codedStoreError(
        SANDBOX_STORE_ERROR_CODES.ERR_STORE_PAYLOAD_LIBRARY_FULL,
        `The saved-payload library already holds the maximum of ${SAVED_INSTANCE_PAYLOAD_MAX_ENTRIES} payloads — delete one before saving another.`
      );
    }
    this.#savedInstancePayloadCounter += 1;
    const entry: SavedInstancePayload = Object.freeze({
      id: `saved_payload_${this.#savedInstancePayloadCounter}`,
      name,
      templateId,
      templateVersion,
      digest,
      payload: freezeSavedInstancePayloadValue(payload as Record<string, unknown>),
      savedAt: new Date().toISOString()
    });
    this.#savedInstancePayloads.push(entry);
    this.#notifySavedInstancePayloads();
    this.#scheduleAutoSave();
    return entry;
  }

  /**
   * Lists the persisted saved hydration payloads in save order (ticket
   * 81d8267).
   *
   * @returns Frozen saved entries, oldest first.
   */
  listSavedInstancePayloads(): readonly SavedInstancePayload[] {
    return Object.freeze([...this.#savedInstancePayloads]);
  }

  /**
   * Resolves one saved hydration payload by id (ticket 81d8267).
   *
   * @param id - Entry id.
   * @returns The frozen entry, or `null` when absent.
   */
  getSavedInstancePayload(id: string): SavedInstancePayload | null {
    if (typeof id !== 'string' || id.length === 0) return null;
    return this.#savedInstancePayloads.find((entry) => entry.id === id) ?? null;
  }

  /**
   * Deletes one saved hydration payload by id (ticket 81d8267). The deletion
   * is persisted through the existing debounced snapshot save.
   *
   * @param id - Entry id.
   * @returns `true` when an entry was removed; `false` otherwise.
   */
  deleteSavedInstancePayload(id: string): boolean {
    if (typeof id !== 'string' || id.length === 0) return false;
    const index = this.#savedInstancePayloads.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.#savedInstancePayloads.splice(index, 1);
    this.#notifySavedInstancePayloads();
    this.#scheduleAutoSave();
    return true;
  }

  /**
   * Removes every saved hydration payload (ticket 81d8267). An empty library
   * is a no-op; a non-empty clear persists through the existing debounced
   * snapshot save, so the field is omitted from the next snapshot.
   */
  clearSavedInstancePayloads(): void {
    if (this.#savedInstancePayloads.length === 0) return;
    this.#savedInstancePayloads = [];
    this.#notifySavedInstancePayloads();
    this.#scheduleAutoSave();
  }

  /**
   * Subscribes to saved-payload library mutations (ticket 81d8267).
   *
   * Listeners fire after save, delete, clear, and after a hydration/reset
   * pass replaced the library. A failing listener never blocks a mutation.
   *
   * @param listener - Called after every library mutation.
   * @returns Unsubscribe function.
   */
  subscribeSavedInstancePayloads(listener: () => void): () => void {
    if (typeof listener !== 'function') return () => {};
    this.#savedInstancePayloadListeners.add(listener);
    return () => {
      this.#savedInstancePayloadListeners.delete(listener);
    };
  }

  /**
   * Returns the frozen Wave U host publishing port (ticket 2518510).
   *
   * The port is the store's host-side implementation over the real Wave T
   * template registry (import/preview/effective-catalog resolution) and the
   * session candidate surface; the store-owned runtime already receives it,
   * and consumers with a caller-injected runtime can bind it explicitly.
   *
   * @returns The frozen publishing port.
   */
  getRealmPublishingPort(): RealmPublishingPort {
    if (!this.#realmPublishingPort) {
      this.#realmPublishingPort = this.#createRealmPublishingPort();
    }
    return this.#realmPublishingPort;
  }

  /**
   * Returns the frozen M3 realm-admin port (ticket 094de1b).
   *
   * The port is the store's host-side implementation over the realm registry,
   * extension live state, and runtime rosters; the store-owned runtime already
   * receives it as pinned construction, and consumers with a caller-injected
   * runtime can bind it explicitly. Every method resolves the caller's grant
   * scope registry-side from the dispatcher-pinned actor reference and fails
   * closed when no matching active grant record exists.
   *
   * @returns The frozen realm-admin port.
   */
  getRealmAdminPort(): RealmAdminPort {
    if (!this.#realmAdminPort) {
      this.#realmAdminPort = this.#createRealmAdminPort();
    }
    return this.#realmAdminPort;
  }

  /**
   * Launches a Realm from a launch template in one call: creates the registry
   * record, materializes the template into resolved launch plans, launches
   * every member under the store's operator principal with the resolved Realm
   * membership, agent ids, tool grants, and model-preset bindings, then applies
   * the template-declared seed when it declares one.
   *
   * Resolution rules:
   * - the template resolves by id against the effective launch catalog
   *   (shipped baked/injected bundles with runtime imports layered on top) and
   *   an unknown id fails closed before any record or member exists; the stored
   *   template is the normalized format-v2 model and the launch materializes it
   *   through `materializeTemplate`. A template requesting extensions
   *   (`providers`) or carrying extension tool references launches normally:
   *   the requested extensions and `<providerId>::<serverToolName>` references
   *   resolve against the global install registry plus the extensions this
   *   launch attaches, and the unresolved ones ride the receipt's
   *   missing-extension disclosure instead of refusing the launch (the
   *   retired providers gate);
   * - supplied values arrive either as an attached `payload` (or its legacy
   *   alias `package`) or as operator-assembled explicit values (`inputs`
   *   shape-tagged, plus the legacy `inputValues` string record). Every supplied
   *   value validates through `validatePayload` against the effective template
   *   contract: payload inputs are the base and explicit values win per key,
   *   a legacy record may only fill `text`-shape inputs, and the payload's
   *   pinned template version is compared against the effective authored
   *   version — a mismatch fails closed unless `allowVersionMismatch` explicitly
   *   confirms it, in which case the warning rides the receipt;
   * - agent ids resolve as literal realm-opaque plain ids from `idPattern` with
   *   per-key `idOverrides` winning over the pattern; the realm id is
   *   membership metadata and never prefixes an agent id (Wave R ticket
   *   ff2202a);
   * - launch-time duplicate detection is realm-local (Wave I, ticket
   *   d57cbc1): a resolved id already registered inside the target realm is
   *   denied with a clear `AGENT_ALREADY_EXISTS` cause and is never
   *   auto-suffixed, while the same literal id in another realm launches its
   *   own registration — agent identity is the composite
   *   `(realmId, agentId)`, so realms are independent id namespaces;
   * - each member's resolved internal grant list travels as `allowedTools`
   *   (retired-selector entries expand to their concrete tools through the
   *   preset resolver; extension-bound derived call names are excluded because
   *   they belong to the extension grant channel), the declared preset name as
   *   inert `toolPreset` metadata,
   *   and the effective preset id — a per-key `presetBindings` override winning
   *   over the spec's `modelPresetId` — as `presetId` resolved through the
   *   owned preset catalog (no model literals);
   * - `privileged`, `role`, `name`, and the composed `systemPrompt` are
   *   forwarded from the plan, and the plan's `initialPrompt` triggers the
   *   member's first turn when declared;
   * - `seed: false` skips the resolved placements and directives entirely.
   * - Wave U publishing authorities (ticket 2518510): a template declaring an
   *   authority id unknown to this host fails the launch closed with
   *   `ERR_TEMPLATE_AUTHORITY_UNSUPPORTED` before any side effect; every other
   *   declaration stays inert unless `authorityApprovals` approves that exact
   *   `(agentKey, authority)` pair (an unknown pair rejects the call with
   *   `ERR_STORE_INVALID_PARAMS`; absent = declined), and a persisted
   *   `templateAuthorityTrust` record auto-approves only exact declared
   *   matches. Approved grants are applied to the launched agents under the
   *   operator principal and recorded in the grant registry; when
   *   `trustAuthorities` is true the effective approved declared set is
   *   persisted after a fully successful launch (an empty set clears the
   *   record).
   *
   * Launch plan application: when `seed` is not `false`, the resolved placement
   * writes are grouped by target in first-appearance order and written through
   * `seedRealm` — one operator-context call per target, so every resolved path
   * passes the same reserved-root/traversal/duplicate validation as an operator
   * seed (`'realm'` writes to `realm:<realmId>:global`, `{ agent: key }` to the
   * launched member's realm-exact private workspace). Directives are then
   * delivered independently, in declared order, as operator-attributed
   * `source: 'realm_seed'` mailbox messages addressed realm-exactly (the same
   * addressing path `seedRealm` uses); member targets resolve through the
   * template agent key to the launched member id. Declared history is seeded
   * through the runtime's trusted `history` launch option without a model call
   * (`[system, ...declared]`, launch-generated ids).
   *
   * Provenance: a successful launch records the frozen
   * {@link RealmInstanceProvenance} on the Realm record (`templateId`, authored
   * `templateVersion`, canonical `packageDigest` when a payload was attached,
   * per-input hashes over the canonical tagged values, placement destination
   * paths actually written, `launchedAt`, `resolvedTools` mapping each
   * resolved sanitized call name to its extension id, and `missingExtensions`
   * listing the requested extension ids that did not resolve) — hashes, paths,
   * and ids only, never raw input values or secrets — and the receipt carries
   * the updated record. Extensions attached by this launch are written on the
   * same record as `extensions`. Nothing connects: the effective extension
   * grants are forwarded into each member's frozen descriptor through the
   * trusted unified-options channel, while third-party tool execution remains
   * P3 work.
   *
   * Partial-failure policy: when materialization, any member launch, a
   * placement write, or a directive delivery fails, every active member of the
   * freshly created Realm is permanently purged, the placement files already
   * written are best-effort evicted, and the record is removed, then a coded
   * `ERR_STORE_REALM_LAUNCH_FAILED` error is thrown carrying `realmId`,
   * `templateId`, `failedAgentId`, `rolledBack`, `terminatedMembers`,
   * `evictedSeedFiles`, `rollbackFailures`, and the original failure as
   * `cause`. A failed call never leaves a half-realm; a member-bearing rollback
   * without the operator principal reports its failures instead of silently
   * stranding the record. Member private workspaces are evicted by the purge;
   * a realm-global partition is a VFS-reserved key, so its seeded files are
   * deleted individually and an empty container key can remain.
   *
   * @param templateId - Launch template id (`'demo'` for the baked fixture).
   * @param options - Optional name/color/description overrides, per-key preset bindings, per-key id overrides, operator-assembled `inputs`/legacy `inputValues`, an attached `payload` (or legacy alias `package`), the `allowVersionMismatch` confirmation, the seed toggle, publishing-authority approvals/trust, and extension attach approvals.
   * @returns The created Realm record (with `instance` provenance and any launch attachments) plus the launched member snapshots in template order and any payload/missing-extension warnings.
   * @throws Error with code `'ERR_STORE_INVALID_PARAMS'` when the template id, options, preset bindings, supplied inputs, seed toggle, payload/package alias pair, or `allowVersionMismatch` flag are invalid (nothing is created).
   * @throws Error with code `'ERR_STORE_INVALID_PARAMS'` when an extension approval is malformed or names an undeclared template request, or when extension resolution itself fails closed (nothing is created).
   * @throws Error with code `'ERR_TEMPLATE_AUTHORITY_UNSUPPORTED'` when the template declares a publishing authority unknown to this host (nothing is created).
   * @throws Error with code `'ERR_STORE_INVALID_PARAMS'` when an authority approval is malformed or references an undeclared `(agentKey, authority)` pair (nothing is created).
   * @throws `RealmCatalogError` (`ERR_HYDRATION_PACKAGE`/`ERR_HYDRATION_VERSION_MISMATCH`) when the payload/package or the operator-assembled inputs are malformed or pin a version that was not explicitly allowed (nothing is created).
   * @throws Error with code `'ERR_STORE_REALM_LAUNCH_FAILED'` when materialization, a member launch, a placement write, or a directive delivery fails — a member id already registered in the target realm is denied at launch time with an `AGENT_ALREADY_EXISTS` `cause` and no auto-suffix (the same literal id in another realm is a distinct realm-local registration); the realm record, any launched members, and the placement files already written were rolled back first.
   *
   * @example
   * ```typescript
   * const receipt = await sandboxStore.launchRealmFromTemplate('demo', { name: 'My Realm' });
   * console.log(receipt.realm.id, receipt.agents.map(agent => agent.id));
   * ```
   */
  async launchRealmFromTemplate(
    templateId: string,
    options: RealmLaunchFromTemplateOptions = {}
  ): Promise<RealmLaunchReceipt> {
    if (typeof templateId !== 'string' || templateId.trim().length === 0) {
      throw invalidRealmParams('launchRealmFromTemplate requires a non-empty template id');
    }
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw invalidRealmParams('launchRealmFromTemplate options must be an object');
    }
    const bundle = this.getRealmTemplateBundle(templateId);
    if (!bundle) {
      throw invalidRealmParams(`launchRealmFromTemplate: unknown realm template '${templateId}'`);
    }
    const template = bundle.template;
    // Extension resolution (extension wave): the template's requested
    // extensions and `<providerId>::<serverToolName>` references resolve
    // against the global install registry plus the attachments this launch
    // approves; a provider-bearing template launches with missing-extension
    // disclosure instead of the retired providers gate. Attachments are
    // written only after a fully successful launch, and no grant is handed to
    // the runtime in this wave.
    const extensionRequests = collectExtensionRequests(template);
    const extensionToolReferences = collectExtensionToolReferences(template);
    const approvedExtensionIds = resolveApprovedExtensions(extensionRequests, options.extensionApprovals);
    const launchAttachments: RealmExtensionAttachment[] = [];
    let extensionResolution: ExtensionResolution;
    try {
      if (extensionRequests.length > 0) {
        const approvedAt = new Date().toISOString();
        for (const request of extensionRequests) {
          if (!approvedExtensionIds.has(request.id)) continue;
          // Approving an uninstalled request attaches nothing: the extension
          // stays on the missing disclosure until the operator installs it.
          if (!this.#extensionRegistry.getExtension(request.id)) continue;
          launchAttachments.push(this.#extensionRegistry.createAttachment({
            extensionId: request.id,
            toolSelection: 'all',
            status: 'active',
            approvedAt,
            approvedBy: 'operator'
          }));
        }
      }
      extensionResolution = this.#extensionRegistry.resolve(
        { requests: extensionRequests, toolReferences: extensionToolReferences },
        launchAttachments
      );
    } catch (error) {
      const failure = invalidRealmParams(
        `launchRealmFromTemplate: template '${template.id}' extension resolution failed — `
        + `${error instanceof Error ? error.message : String(error)}`
      );
      failure.cause = error;
      throw failure;
    }
    // Extension grant partition (extension wave, P2.4): extension-derived
    // call names are separated from the internal allowlist — internal
    // canonical/alias/wildcard names stay `allowedTools`, resolved extension
    // names become the member's `extensionTools` (the effective grant set),
    // and unresolved references only ride the existing missing-tool
    // disclosure (never granted, never masquerading as an internal tool).
    const extensionResolvedCallNames = new Set<string>(Object.keys(extensionResolution.resolvedTools));
    const extensionUnresolvedCallNames = new Set<string>(
      extensionResolution.missingTools.map((tool) => tool.callName)
    );
    // The realm universe for this launch: every resolved tool is granted to a
    // member without its own extension references (the operator default);
    // resolved names are all attached by this launch, so no detach filter is
    // needed here.
    const realmExtensionUniverse = Object.freeze([...extensionResolvedCallNames]);
    // Wave U publishing-authority gate (ticket 2518510): a template declaring
    // an authority id this host cannot enforce fails the launch closed before
    // any side effect (providers precedent), while import/validation/review
    // accept it.
    const unsupportedAuthorities = templateUnsupportedAuthorities(template);
    if (unsupportedAuthorities.length > 0) {
      throw templateAuthorityUnsupportedError(template.id, unsupportedAuthorities);
    }
    // The effective version is the authored-form pin (an import's parsed
    // version, else `templateBundleVersion` over the authored template +
    // files): launch provenance and payload version checks use it, and it is
    // never a hash of the normalized model.
    const effectiveTemplateVersion = this.#effectiveTemplateVersion(template.id);
    if (effectiveTemplateVersion === null) {
      throw invalidRealmParams(
        `launchRealmFromTemplate: template '${template.id}' cannot be versioned — the bundle is malformed`
      );
    }
    for (const field of ['name', 'color', 'description'] as const) {
      const value = options[field];
      if (value !== undefined && typeof value !== 'string') {
        throw invalidRealmParams(`launchRealmFromTemplate ${field} must be a string`);
      }
    }
    if (options.name !== undefined && options.name.trim().length === 0) {
      throw invalidRealmParams('launchRealmFromTemplate name must be a non-empty string');
    }
    if (options.seed !== undefined && typeof options.seed !== 'boolean') {
      throw invalidRealmParams('launchRealmFromTemplate seed must be a boolean');
    }
    if (options.allowVersionMismatch !== undefined && typeof options.allowVersionMismatch !== 'boolean') {
      throw invalidRealmParams('launchRealmFromTemplate allowVersionMismatch must be a boolean');
    }
    if (options.trustAuthorities !== undefined && typeof options.trustAuthorities !== 'boolean') {
      throw invalidRealmParams('launchRealmFromTemplate trustAuthorities must be a boolean');
    }

    // Wave U approval resolution (ticket 2518510): explicit approvals must
    // match declared (agentKey, authority) pairs exactly, and a persisted trust
    // record auto-approves only exact declared matches. Everything validates
    // before any Realm record or member exists; absent approval is a decline.
    const declaredAuthorities = collectDeclaredAuthorities(template);
    const approvedAuthorities = resolveApprovedAuthorities(
      declaredAuthorities,
      options.authorityApprovals,
      this.#templateAuthorityTrust.get(template.id) ?? null
    );
    // The trust record persisted by `trustAuthorities: true` is exactly the
    // set effective-approved this launch, restricted to still-declared pairs:
    // newly declared unapproved authorities are excluded, so they re-prompt.
    const nextTrustRecord = new Map<string, readonly string[]>();
    if (options.trustAuthorities === true) {
      for (const [agentKey, authorities] of declaredAuthorities) {
        const approvedForAgent = approvedAuthorities.get(agentKey);
        if (!approvedForAgent || approvedForAgent.size === 0) continue;
        const keep: string[] = [];
        for (const authority of authorities) {
          if (approvedForAgent.has(authority)) keep.push(authority);
        }
        if (keep.length > 0) nextTrustRecord.set(agentKey, Object.freeze(keep));
      }
    }

    // Resolve every effective preset id up front (a presetBindings entry wins
    // over the spec's modelPresetId, both resolved through the owned catalog):
    // an unknown key or unresolvable preset id rejects the call before any
    // Realm record or member exists.
    const presetIdByKey = this.#resolveRealmPresetBindings(template, options.presetBindings);

    // Operator-assembled supplied values (`inputs` shape-tagged plus the legacy
    // `inputValues` string record) validate structurally first; an attached
    // payload (or its legacy alias `package`) is then validated through the
    // catalog's single `validatePayload` path. One value per input: the same
    // key through both records fails closed, and supplying both `payload` and
    // `package` fails closed.
    const explicitInputs = resolveExplicitInputValues(template, options.inputs, options.inputValues);
    const payloadSupplied = options.payload !== undefined && options.payload !== null;
    const packageSupplied = options.package !== undefined && options.package !== null;
    if (payloadSupplied && packageSupplied) {
      throw invalidRealmParams(
        'launchRealmFromTemplate accepts either payload or its legacy alias package, not both'
      );
    }
    const payloadValue = payloadSupplied ? options.payload : packageSupplied ? options.package : undefined;
    const allowVersionMismatch = options.allowVersionMismatch === true;
    const warnings: string[] = [];
    let effectiveInputs: RealmInputValues | undefined;
    if (payloadValue !== undefined) {
      // The attached payload validates against the effective contract: required
      // inputs present, unknown keys/shape mismatches rejected, and the pinned
      // version compared against the authored effective version.
      const payloadResolution = validatePayload(template, payloadValue, {
        currentVersion: effectiveTemplateVersion,
        ...(allowVersionMismatch ? { allowVersionMismatch: true } : {})
      });
      warnings.push(...payloadResolution.warnings);
      if (explicitInputs !== undefined) {
        // Explicit launch/review values win per key over the payload base; the
        // merged record re-enters `validatePayload` so the merged result is
        // checked against the same contract (required inputs included).
        const merged = validatePayload(template, {
          formatVersion: 2,
          templateId: template.id,
          templateVersion: payloadResolution.templateVersion,
          inputs: {
            ...toAuthoredInputValues(payloadResolution.inputs),
            ...toAuthoredInputValues(explicitInputs)
          }
        }, {
          currentVersion: effectiveTemplateVersion,
          ...(allowVersionMismatch ? { allowVersionMismatch: true } : {})
        });
        warnings.push(...merged.warnings);
        effectiveInputs = merged.inputs;
      } else {
        effectiveInputs = payloadResolution.inputs;
      }
    } else if (explicitInputs !== undefined) {
      // No payload attached: synthesize the canonical payload shape from the
      // operator-assembled values and run the same validation path, so a
      // missing required input or a bad fileset fails closed before any record
      // exists.
      effectiveInputs = validatePayload(template, {
        formatVersion: 2,
        templateId: template.id,
        templateVersion: effectiveTemplateVersion,
        inputs: toAuthoredInputValues(explicitInputs)
      }, { currentVersion: effectiveTemplateVersion }).inputs;
    }

    const realm = this.createRealm({
      name: options.name !== undefined ? options.name : template.name,
      description: options.description !== undefined ? options.description : template.description,
      ...(options.color !== undefined ? { color: options.color } : {}),
      templateId: template.id
    });

    const launched: AgentStateSnapshot[] = [];
    const seedWrites: RealmSeedWriteGroup[] = [];
    let failedAgentId: string | null = null;
    try {
      const plan = materializeTemplate(template, {
        realmId: realm.id,
        ...(options.idOverrides !== undefined ? { idOverrides: options.idOverrides } : {}),
        ...(effectiveInputs !== undefined ? { inputs: effectiveInputs } : {}),
        bundleFiles: bundle.files
      });

      for (const agentPlan of plan.agents) {
        failedAgentId = agentPlan.agentId;
        // Realm-local uniqueness (Wave I, ticket d57cbc1): agent identity is
        // the composite `(realmId, agentId)`, so only a member id already
        // registered in the target realm is denied here, before that member
        // launches; the same literal id in another realm is a distinct
        // registration and launches normally. No id is auto-suffixed.
        if (this.agents.some((agent) => agent.id === agentPlan.agentId && agent.config.realmId === realm.id)) {
          throw duplicateRealmMemberIdError(agentPlan.agentId);
        }
        const presetId = presetIdByKey[agentPlan.key];
        // Extension grant partition (extension wave, P2.4): extension-bound
        // call names (resolved or not) are excluded from the internal
        // allowlist and split into the member's extension scope. A member that
        // declared at least one extension reference is *restricted* — its
        // scope is exactly its resolved references (empty when none resolved,
        // fail closed; unresolved names only ride the missing disclosure). A
        // member without references gets the whole Realm universe (the
        // operator default) with the `'all'` selector.
        const memberExtensionDeclared = agentPlan.toolProfile.tools
          .filter((tool) => extensionResolvedCallNames.has(tool) || extensionUnresolvedCallNames.has(tool));
        const memberExtensionGrants = agentPlan.toolProfile.tools
          .filter((tool) => extensionResolvedCallNames.has(tool));
        const internalAllowedTools = agentPlan.toolProfile.tools
          .filter((tool) => !extensionResolvedCallNames.has(tool) && !extensionUnresolvedCallNames.has(tool));
        const memberRestricted = memberExtensionDeclared.length > 0;
        const effectiveMemberExtensionGrants: readonly string[] = memberRestricted
          ? Object.freeze([...memberExtensionGrants])
          : realmExtensionUniverse;
        const config: AgentConfig = {
          id: agentPlan.agentId,
          name: agentPlan.name,
          role: agentPlan.role,
          systemPrompt: agentPlan.systemPrompt,
          realmId: realm.id,
          privileged: agentPlan.privileged,
          // The resolved grant list is the authoritative launch selector
          // (retired selectors arrive expanded as concrete tools through the
          // preset resolver); the declared preset name rides along as inert
          // metadata (the composed config consults `allowedTools` first) for
          // consumers that display the declared selector.
          allowedTools: [...internalAllowedTools],
          // Per-agent extension selector state: the member's resolved
          // references when restricted, else the `'all'` default. The
          // effective grant set travels through the trusted launch option
          // below; this selector is persisted state consumed by the heal and
          // the tuning UI.
          extensionTools: memberRestricted
            ? Object.freeze([...memberExtensionGrants])
            : 'all',
          ...(agentPlan.toolProfile.preset !== null ? { toolPreset: agentPlan.toolProfile.preset } : {}),
          ...(presetId !== undefined ? { presetId } : {}),
          ...(agentPlan.triggerPolicy !== undefined ? { triggerPolicy: agentPlan.triggerPolicy } : {})
        };
        // Declared baked history (Wave T, ticket 7e6edae) seeds through the
        // runtime's trusted `history` launch option: `[system, ...declared]`
        // with launch-generated ids and no model call.
        const history: readonly LaunchHistoryEntry[] | null = agentPlan.history.length > 0
          ? agentPlan.history
          : null;
        const snapshot = await this.launchAgent(config, agentPlan.initialPrompt ?? null, history, effectiveMemberExtensionGrants);
        launched.push(snapshot);
      }

      // Wave U approved grants (ticket 2518510): every approved pair was
      // validated against the template's declarations before the Realm record
      // existed, so only the two known authority ids can appear here. Grants
      // are applied under the operator principal and recorded in the ordinary
      // grant registry (persisted additively as `metaAuthorityGrants`), which
      // makes them revocable through the grant methods and re-applied by
      // hydration.
      if (approvedAuthorities.size > 0) {
        for (const agentPlan of plan.agents) {
          const approvedForAgent = approvedAuthorities.get(agentPlan.key);
          if (!approvedForAgent || approvedForAgent.size === 0) continue;
          // Canonical identity key: the same literal id may already be
          // registered in another Realm (an earlier launch of this template),
          // so a bare-id grant would resolve ambiguous and be skipped.
          const memberKey = createAgentIdentityKey(realm.id, agentPlan.agentId);
          for (const authority of approvedForAgent) {
            if (authority === AGENT_AUTHORITIES.TEMPLATE) {
              this.#runtime.grantTemplateAuthority(memberKey, this.#operatorContext());
            } else {
              this.#runtime.grantHydrationAuthority(memberKey, this.#operatorContext());
            }
          }
        }
      }

      // The member phase completed; a failure from here on is a placement or
      // directive failure, not an agent-launch failure, so the rollback report
      // names no agent. Placements write first (grouped per target, through the
      // operator seed path), then directives deliver independently.
      failedAgentId = null;
      if (options.seed !== false) {
        if (plan.placements.length > 0) {
          this.#applyTemplatePlacements(realm.id, plan.placements, plan.agents, seedWrites);
        }
        if (plan.directives.length > 0) {
          this.#deliverTemplateDirectives(realm.id, plan.directives, plan.agents);
        }
      }

      // Instance provenance (Wave T decision 4): recorded on the Realm record
      // after a fully successful launch — hashes, paths, and resolved tool ids
      // only, never raw values. `seedPaths` records the placement destination
      // paths this launch actually wrote; a skipped seed records none. The
      // payload digest covers the attached payload (operator-assembled inputs
      // carry no digest), `inputHashes` hash each supplied value's canonical
      // tagged JSON, and the launch extension resolution writes
      // `resolvedTools`/`missingExtensions` below when they are non-empty.
      const seedPaths: string[] = [];
      for (const group of seedWrites) {
        for (const path of group.writtenPaths) {
          if (!seedPaths.includes(path)) seedPaths.push(path);
        }
      }
      const packageDigest = payloadValue !== undefined ? payloadDigest(payloadValue) : undefined;
      const resolvedToolCount = Object.keys(extensionResolution.resolvedTools).length;
      const missingExtensionIds = extensionResolution.missingExtensions.map((entry) => entry.extensionId);
      const instance: RealmInstanceProvenance = Object.freeze({
        templateId: template.id,
        templateVersion: effectiveTemplateVersion,
        ...(packageDigest !== undefined ? { packageDigest } : {}),
        inputHashes: hashRealmInputValues(effectiveInputs),
        seedPaths: Object.freeze(seedPaths),
        launchedAt: new Date().toISOString(),
        ...(resolvedToolCount > 0
          ? { resolvedTools: Object.freeze({ ...extensionResolution.resolvedTools }) }
          : {}),
        ...(missingExtensionIds.length > 0 ? { missingExtensions: Object.freeze(missingExtensionIds) } : {})
      });
      const launchedRealm = this.#realmRegistry.updateRealm(realm.id, {
        instance,
        // Approved-and-installed extensions attach here, on the same
        // fully-successful-launch write as the provenance: the attachment
        // records the operator approval stamp and the realm-level `'all'`
        // selection. Nothing connects.
        ...(launchAttachments.length > 0 ? { extensions: launchAttachments } : {})
      });
      for (const attachment of launchAttachments) {
        this.#emitExtensionAuditEvent('extension_attached', {
          realmId: launchedRealm.id,
          extensionId: attachment.extensionId,
          source: 'launch'
        });
      }
      warnings.push(...renderMissingExtensionWarnings(extensionResolution.missingExtensions));

      // Wave U trust override (ticket 2518510): persisted only after a fully
      // successful launch, and only when requested. The record is exactly the
      // declared subset effective-approved this launch; an empty set clears
      // any prior record. Trust is operator intent — the grants themselves are
      // already in the operator grant registry.
      if (options.trustAuthorities === true) {
        if (nextTrustRecord.size > 0) {
          this.#templateAuthorityTrust.set(template.id, nextTrustRecord);
        } else {
          this.#templateAuthorityTrust.delete(template.id);
        }
        this.#scheduleAutoSave();
      }

      const uniqueWarnings = [...new Set(warnings)];
      // Defect 7d2c314: the receipt is realm-opaque — strip the internal
      // canonical identity key from each member projection (a shallow copy
      // per member). Exact addressing lives on the store's selection/action
      // surfaces, never on the receipt.
      const receiptAgents: RealmLaunchReceiptAgent[] = launched.map((snapshot) => {
        const { identityKey: _identityKey, ...realmOpaque } = snapshot;
        return realmOpaque;
      });
      return {
        realm: launchedRealm,
        agents: receiptAgents,
        ...(uniqueWarnings.length > 0 ? { warnings: Object.freeze(uniqueWarnings) } : {})
      };
    } catch (failure) {
      const rollback = this.#rollbackRealmLaunch(realm.id, seedWrites);
      const launchError = createRealmLaunchFailure(template, realm.id, failedAgentId, failure, rollback);
      this.error = launchError.message;
      throw launchError;
    }
  }

  /**
   * Seeds a Realm: validates the request, writes operator-supplied files into
   * the chosen workspace through the operator-context VirtualFS surface, then
   * optionally delivers an operator-attributed directive to a member.
   *
   * Workspace selection: with a `targetAgentId` the files land in that active
   * member's private workspace; without a target they land in the Realm-global
   * workspace `realm:<realmId>:global`, the same alias a realm-bound member
   * resolves `global` onto.
   *
   * Realm-scoped resolution (defect adcc133): the named target is resolved
   * WITHIN the requested Realm — an active member whose literal id matches and
   * whose membership names that Realm. Agent identity is the composite
   * `(realmId, agentId)`, so a same-literal-id member in another Realm is
   * never selected, and the write targets that exact registration's storage
   * key (explicit pin, canonical identity key, or legacy bare id) instead of
   * resolving a bare workspace id across Realms. Membership compares under the
   * store's trim semantics (`resolveMemberRealmId`, defect 3595f6a), so a
   * padded hydrated membership resolves to the same Realm the grouping and
   * deletion paths resolve, and its write key is re-normalized to that
   * resolved Realm's canonical identity. The receipt keeps the realm-opaque
   * member label (its configured `workspaceId`, else its agent id), and the
   * directive is addressed to the exact registration's mailbox (envelope
   * labels stay bare).
   *
   * Fail-closed validation runs before the first write: the Realm must be
   * registered, a named target must be an ACTIVE member of that Realm and must
   * not resolve to a reserved workspace key, the file list must be non-empty
   * with string contents and unique normalized paths, every path must be free
   * of null bytes and `..` traversal segments, and no path may address the
   * reserved `global`/`public` workspace roots. Those roots are rejected,
   * never re-rooted: the legacy VirtualFS prefix routing would otherwise
   * divert the write to the ungrouped shared workspace while the receipt
   * still named the selected one. A directive requires an explicit member
   * target (there is no realm-wide fan-out), and a directive that is an
   * empty/whitespace string counts as absent.
   *
   * The directive is delivered as a mailbox message from a non-agent sender
   * label, so the store attributes the host operator principal by exact
   * reference (Wave I, ticket c02d0b9) exactly like the manual send surface
   * (ticket 99faaf1); the target's mail wake then dispatches the
   * turn. `directiveDelivered` mirrors the bus receipt (`success === true`):
   * a delivery the bus rejects — for example its fail-closed cross-Realm
   * `PERMISSION_DENIED` — comes back as `false` rather than silently
   * succeeding.
   *
   * @param input - Realm id, file list, optional directive, and optional target member id.
   * @returns Seed receipt: realm id, workspace, normalized written paths, and directive delivery outcome.
   * @throws Error with code `'ERR_STORE_AGENT_NOT_FOUND'` when a named target is not an active agent (nothing is written).
   * @throws Error with code `'ERR_STORE_INVALID_PARAMS'` when the realm, target membership, directive, or file list is invalid (nothing is written).
   * @throws Error with code `'ERR_STORE_VFS_FAILED'` when a write fails; the error carries `writtenPaths` with the files already written.
   *
   * @example
   * ```typescript
   * const receipt = sandboxStore.seedRealm({
   *   realmId: receipt.realm.id,
   *   files: [{ path: '/notes/brief.md', content: 'Seed brief' }],
   *   targetAgentId: 'realm-1-coordinator',
   *   directive: 'Begin the session.'
   * });
   * ```
   */
  seedRealm(input: RealmSeedInput): RealmSeedReceipt {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw invalidRealmParams('seedRealm requires an input object');
    }
    const realmId = typeof input.realmId === 'string' ? input.realmId.trim() : '';
    if (!realmId) {
      throw invalidRealmParams('seedRealm requires a non-empty realmId');
    }
    if (!this.#realmRegistry.getRealm(realmId)) {
      throw invalidRealmParams(`seedRealm: realm '${realmId}' is not registered`);
    }
    if (!Array.isArray(input.files) || input.files.length === 0) {
      throw invalidRealmParams('seedRealm requires a non-empty files array');
    }

    // Target resolution (defect adcc133): the target resolves WITHIN the
    // requested Realm — an ACTIVE member whose literal id matches and whose
    // membership names that Realm. Agent identity is the composite
    // `(realmId, agentId)`, so the same literal id registered in another Realm
    // is a distinct registration and is never selected; when only a
    // foreign-Realm registration carries the id, the historical membership
    // error is kept. No target names the realm-global partition.
    const requestedTarget = typeof input.targetAgentId === 'string' ? input.targetAgentId.trim() : '';
    let targetAgent: AgentStateSnapshot | null = null;
    let workspace: string;
    let writeWorkspace: string;
    if (requestedTarget) {
      const target = this.#findActiveRealmMember(requestedTarget, realmId);
      if (!target) {
        if (this.agents.some((agent) => agent.id === requestedTarget)) {
          throw invalidRealmParams(`seedRealm: target agent '${requestedTarget}' is not an active member of realm '${realmId}'`);
        }
        const err: CodedError = new Error(`seedRealm: target agent '${requestedTarget}' is not an active agent`);
        err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND;
        throw err;
      }
      // The receipt keeps the realm-opaque member label, while the write
      // targets the exact registration's storage key (explicit pin, canonical
      // identity key, or legacy bare id): the same literal id in another Realm
      // can never share or steal the partition.
      const effectiveWorkspace = this.#resolveMemberPrivateWorkspaceKey(target.id, realmId);
      if (isReservedWorkspaceKey(effectiveWorkspace)) {
        throw invalidRealmParams(`seedRealm: target agent '${target.id}' resolves to the reserved workspace '${effectiveWorkspace}'`);
      }
      workspace = this.#resolveMemberWorkspaceKey(target.id, realmId);
      writeWorkspace = effectiveWorkspace;
      targetAgent = target;
    } else {
      workspace = realmGlobalWorkspaceKey(realmId);
      writeWorkspace = workspace;
    }

    // Directive: optional, operator-attributed, and member-scoped. An empty or
    // whitespace-only string counts as absent; any other non-string rejects.
    if (input.directive !== undefined && input.directive !== null && typeof input.directive !== 'string') {
      throw invalidRealmParams('seedRealm directive must be a string');
    }
    const directive = typeof input.directive === 'string' && input.directive.trim().length > 0
      ? input.directive
      : null;
    if (directive !== null && !targetAgent) {
      throw invalidRealmParams('seedRealm directive requires a targetAgentId (the operator-attributed recipient)');
    }

    // File validation before the first write: shape, traversal, root, and
    // duplicate protection against the normalized path space.
    const normalizedPaths: string[] = [];
    const seenPaths: Set<string> = new Set();
    for (let index = 0; index < input.files.length; index += 1) {
      const file = input.files[index] as RealmSeedFile | null;
      if (!file || typeof file !== 'object' || Array.isArray(file)) {
        throw invalidRealmParams(`seedRealm files[${index}] must be an object`);
      }
      const rawPath = typeof file.path === 'string' ? file.path.trim() : '';
      if (!rawPath) {
        throw invalidRealmParams(`seedRealm files[${index}].path must be a non-empty string`);
      }
      if (rawPath.includes('\0')) {
        throw invalidRealmParams(`seedRealm files[${index}].path must not contain null bytes`);
      }
      if (rawPath.replace(/\\/g, '/').split('/').includes('..')) {
        throw invalidRealmParams(`seedRealm files[${index}].path '${rawPath}' attempts path traversal`);
      }
      const normalized = normalizeVirtualPath(rawPath);
      if (normalized === '/') {
        throw invalidRealmParams(`seedRealm files[${index}].path '${rawPath}' resolves to the workspace root`);
      }
      // Reserved workspace vocabulary: the legacy VirtualFS prefix routing
      // diverts any `/global/...` or `/public/...` write to the ungrouped
      // shared `global` workspace regardless of the requested workspace. Such
      // a seed path is rejected (never re-rooted), because accepting it would
      // report the selected workspace on the receipt while the bytes landed
      // elsewhere; seed paths are workspace-relative by contract.
      const rootSegment = normalized.split('/')[1] ?? '';
      if (rootSegment === 'global' || rootSegment === 'public') {
        throw invalidRealmParams(
          `seedRealm files[${index}].path '${rawPath}' addresses the reserved workspace prefix '/${rootSegment}' — seed paths are workspace-relative and reserved roots are rejected, never re-rooted`
        );
      }
      if (seenPaths.has(normalized)) {
        throw invalidRealmParams(`seedRealm files[${index}].path '${normalized}' duplicates an earlier file`);
      }
      if (typeof file.content !== 'string') {
        throw invalidRealmParams(`seedRealm files[${index}].content must be a string`);
      }
      seenPaths.add(normalized);
      normalizedPaths.push(normalized);
    }

    const writtenPaths: string[] = [];
    for (let index = 0; index < normalizedPaths.length; index += 1) {
      try {
        this.writeFile(normalizedPaths[index], input.files[index].content, { workspaceId: writeWorkspace });
        writtenPaths.push(normalizedPaths[index]);
      } catch (err) {
        const seedError = err as SeedWriteFailure;
        seedError.writtenPaths = [...writtenPaths];
        throw seedError;
      }
    }

    let directiveDelivered = false;
    if (directive !== null && targetAgent) {
      // The non-agent `'human'` label routes through `#resolveSendOperatorContext`:
      // the store attributes the trusted operator subject through the identity
      // projection (ticket 99faaf1), never a caller-asserted realm claim.
      // Realm-exact addressing (defect adcc133): the bus resolves the target's
      // canonical identity key to the exact `(realmId, agentId)` mailbox and
      // still stamps the envelope with the bare id; an unresolvable key falls
      // back to the legacy bare ref.
      const directiveRecipient = this.#canonicalAgentKeyInRealm(targetAgent.id, realmId) ?? targetAgent.id;
      const receipt = this.sendMessage('human', directiveRecipient, directive, { source: 'realm_seed', realmId });
      directiveDelivered = receipt.success === true;
    }

    return { realmId, workspace, writtenPaths, directiveDelivered };
  }

  /**
   * Resolves the effective model-preset id for every template agent key: a
   * `presetBindings` override wins over the spec's `modelPresetId`, and both
   * resolve through the owned preset catalog. Unknown binding keys, invalid
   * values, and unresolvable preset ids throw before any Realm is created.
   *
   * @param template - Template whose agent keys the bindings must name.
   * @param bindings - Optional per-key preset overrides from the launch options.
   * @returns Resolved preset ids keyed by template agent key (absent keys omitted).
   */
  #resolveRealmPresetBindings(
    template: RealmTemplate,
    bindings: Readonly<Record<string, string>> | undefined
  ): Record<string, string> {
    if (bindings !== undefined && (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings))) {
      throw invalidRealmParams('launchRealmFromTemplate presetBindings must be a record of agent key to preset id');
    }
    const knownKeys: ReadonlySet<string> = new Set(template.agents.map((spec) => spec.key));
    const resolved: Record<string, string> = {};
    if (bindings) {
      for (const key of Object.keys(bindings)) {
        if (!knownKeys.has(key)) {
          throw invalidRealmParams(`launchRealmFromTemplate presetBindings names unknown agent key '${key}'`);
        }
        const candidate = bindings[key];
        if (typeof candidate !== 'string' || candidate.trim().length === 0) {
          throw invalidRealmParams(`launchRealmFromTemplate presetBindings['${key}'] must be a non-empty preset id`);
        }
        const preset = this.#presetCatalog.getPreset(candidate.trim());
        if (!preset) {
          throw invalidRealmParams(`launchRealmFromTemplate presetBindings['${key}'] preset '${candidate}' is not a known catalog preset`);
        }
        resolved[key] = preset.id;
      }
    }
    for (const spec of template.agents) {
      if (spec.modelPresetId === undefined) continue;
      const preset = this.#presetCatalog.getPreset(spec.modelPresetId);
      if (!preset) {
        throw invalidRealmParams(`launchRealmFromTemplate: template agent '${spec.key}' modelPresetId '${spec.modelPresetId}' is not a known catalog preset`);
      }
      if (resolved[spec.key] === undefined) {
        resolved[spec.key] = preset.id;
      }
    }
    return resolved;
  }

  /**
   * Finds the ACTIVE member registration of a bare agent id inside one Realm
   * (defect adcc133): identity is the composite `(realmId, agentId)`, so the
   * same literal id registered in another Realm is never matched.
   *
   * Membership compares under the store's trim semantics
   * ({@link resolveMemberRealmId}, defect 3595f6a): a hydrated
   * `'  realm_pad  '` membership resolves to `realm_pad` exactly like the
   * grouping and `deleteRealm` paths resolve it, so the seed target lookup can
   * never disagree with deletion counting.
   *
   * @param agentId - Realm-local agent id.
   * @param realmId - Realm the member must belong to.
   * @returns The active member snapshot, or `null`.
   */
  #findActiveRealmMember(agentId: string, realmId: string): AgentStateSnapshot | null {
    return this.agents.find(
      (agent) => agent.id === agentId && resolveMemberRealmId(agent) === realmId
    ) ?? null;
  }

  /**
   * Resolves a launched member's realm-opaque seed workspace label: its
   * configured `workspaceId` when present, else its agent id. With a `realmId`
   * the lookup is realm-scoped (defect adcc133), so a same-literal-id member in
   * another Realm can never contribute a foreign pin; the label is shared by
   * the `seedRealm` receipt and the template-seed rollback record.
   *
   * @param agentId - Active member id.
   * @param realmId - Realm the member belongs to (scopes the lookup when given).
   * @returns Effective workspace label.
   */
  #resolveMemberWorkspaceKey(agentId: string, realmId?: string): string {
    const agent = realmId !== undefined
      ? this.#findActiveRealmMember(agentId, realmId)
      : (this.agents.find((entry) => entry.id === agentId) ?? null);
    const configured = agent?.config?.workspaceId;
    return typeof configured === 'string' && configured ? configured : agentId;
  }

  /**
   * Resolves the exact VirtualFS storage key of a member's private workspace
   * inside one Realm (defect adcc133): the identity port resolves the
   * registration realm-exactly and the VFS-owned
   * `resolveAgentPrivateWorkspaceKey` rule maps it to the explicit pin, the
   * canonical identity key, or the legacy bare id.
   *
   * The canonical key is re-normalized onto the realm id the store's trim
   * semantics resolved (defect 3595f6a): a padded hydrated membership encodes
   * into the runtime's identity key, while the store treats the member as
   * `realmId`'s — so the seed writes to the same trimmed canonical workspace
   * the grouping sees, an explicit pin stays verbatim, and an unresolvable
   * registration with an identity port never falls back to a bare ghost
   * workspace. Host wiring without an identity port keeps the label fallback.
   *
   * @param agentId - Realm-local member id.
   * @param realmId - Realm the member belongs to (trimmed).
   * @returns Effective storage key for the member's private workspace.
   */
  #resolveMemberPrivateWorkspaceKey(agentId: string, realmId: string): string {
    const canonicalKey = createAgentIdentityKey(realmId, agentId);
    const projection = this.#memberIdentityInRealm(agentId, realmId);
    if (projection) {
      const resolved = resolveAgentPrivateWorkspaceKey(projection);
      if (resolved && resolved !== projection.key && resolved !== agentId) {
        return resolved; // Explicit pin, preserved verbatim by the VFS rule.
      }
      return canonicalKey;
    }
    if (!this.#identityPort) {
      return this.#resolveMemberWorkspaceKey(agentId, realmId);
    }
    return canonicalKey;
  }

  /**
   * Resolves the realm-exact identity projection of one active registration
   * (defect adcc133): the scope pins `(realmId, agentId)`, so a
   * same-literal-id registration in another Realm is never selected; an
   * unresolvable registration or a failing identity port yields `null`.
   *
   * @param agentId - Realm-local agent id.
   * @param realmId - Realm membership to resolve exactly.
   * @returns The frozen identity projection, or `null`.
   */
  #realmExactAgentProjection(agentId: string, realmId: string): AgentIdentityProjection | null {
    const identityPort = this.#identityPort;
    if (!identityPort || typeof identityPort.getAgentIdentity !== 'function') return null;
    try {
      return identityPort.getAgentIdentity(agentId, { realmId });
    } catch {
      return null;
    }
  }

  /**
   * Resolves the member's active identity projection for one realm under the
   * store's trim semantics (defect 3595f6a): the exact-scope lookup wins;
   * otherwise a unique bare-id projection whose trimmed membership equals the
   * realm is accepted (a padded hydrated membership), while an ambiguous
   * (same id in several Realms) or foreign-realm registration resolves `null`
   * — never a wrong-realm pick.
   *
   * @param agentId - Realm-local member id.
   * @param realmId - Trimmed realm the member belongs to.
   * @returns The frozen identity projection, or `null`.
   */
  #memberIdentityInRealm(agentId: string, realmId: string): AgentIdentityProjection | null {
    const exact = this.#realmExactAgentProjection(agentId, realmId);
    if (exact) return exact;
    const unique = this.#resolveUniqueAgentProjection(agentId);
    if (!unique) return null;
    const membership = typeof unique.realmId === 'string' ? unique.realmId.trim() : '';
    return membership === realmId ? unique : null;
  }

  /**
   * Canonical identity key of the member's realm-exact (or trim-normalized)
   * registration, or `null` when the identity port cannot resolve it (defects
   * adcc133/3595f6a). Used for realm-exact directive addressing; callers fall
   * back to the bare id, which the bus resolves uniquely when unambiguous.
   *
   * @param agentId - Realm-local agent id.
   * @param realmId - Realm membership to resolve under the trim semantics.
   * @returns Canonical `(realmId, agentId)` registration key, or `null`.
   */
  #canonicalAgentKeyInRealm(agentId: string, realmId: string): string | null {
    const projection = this.#memberIdentityInRealm(agentId, realmId);
    return projection && typeof projection.key === 'string' && projection.key ? projection.key : null;
  }

  /**
   * Applies a materialized launch plan's placements through the operator
   * `seedRealm` path: resolved writes group by target in first-appearance order
   * (one `seedRealm` call per target), member targets resolve through the
   * template agent key to the launched member id, and `'realm'` targets write
   * to the Realm-global workspace. Every resolved path therefore passes the
   * same reserved-root/traversal/duplicate validation an operator seed enforces
   * before the first write of its group.
   *
   * Every completed write group is recorded on `writes` so a later failure can
   * best-effort evict the files already written; when a `seedRealm` call fails
   * partway, its partial `writtenPaths` are recorded too before the original
   * error is rethrown.
   *
   * @param realmId - Registry id of the freshly created Realm.
   * @param placements - Resolved placements from the launch plan, in declared order.
   * @param agentPlans - Materialized agent plans (template keys to member ids).
   * @param writes - Rollback record appended in write order.
   * @throws `Error` - Propagates the failing `seedRealm` error unchanged.
   */
  #applyTemplatePlacements(
    realmId: string,
    placements: readonly RealmResolvedPlacement[],
    agentPlans: readonly RealmLaunchAgentPlan[],
    writes: RealmSeedWriteGroup[]
  ): void {
    interface PlacementGroup {
      agentKey: string | null;
      agentId: string | null;
      workspace: string;
      files: RealmSeedFile[];
    }
    const groups: PlacementGroup[] = [];
    const groupIndex: Map<string, number> = new Map();
    for (const placement of placements) {
      const agentKey = placement.target === 'realm' ? null : placement.target.agent;
      const groupKey = agentKey ?? '';
      let index = groupIndex.get(groupKey);
      if (index === undefined) {
        const agentPlan = agentKey === null
          ? null
          : agentPlans.find((entry) => entry.key === agentKey) ?? null;
        if (agentKey !== null && !agentPlan) {
          // Unreachable through materialization (placement targets are validated
          // against template agent keys); kept fail-closed for hand-built plans.
          throw invalidRealmParams(`launchRealmFromTemplate: placement targets unknown agent key '${agentKey}'`);
        }
        index = groups.length;
        groupIndex.set(groupKey, index);
        groups.push({
          agentKey,
          agentId: agentPlan ? agentPlan.agentId : null,
          workspace: agentPlan ? this.#resolveMemberWorkspaceKey(agentPlan.agentId, realmId) : realmGlobalWorkspaceKey(realmId),
          files: []
        });
      }
      groups[index].files.push({ path: placement.path, content: placement.content });
    }

    for (const group of groups) {
      try {
        const receipt = this.seedRealm({
          realmId,
          files: group.files,
          ...(group.agentId !== null ? { targetAgentId: group.agentId } : {})
        });
        writes.push({ workspace: receipt.workspace, writtenPaths: [...receipt.writtenPaths] });
      } catch (err) {
        const partial = (err as { writtenPaths?: unknown } | null)?.writtenPaths;
        if (Array.isArray(partial) && partial.length > 0) {
          writes.push({
            workspace: group.workspace,
            writtenPaths: partial.filter((path): path is string => typeof path === 'string')
          });
        }
        throw err;
      }
    }
  }

  /**
   * Delivers a materialized launch plan's directives, independently and in
   * declared order: each resolved directive becomes one operator-attributed
   * mailbox message (`source: 'realm_seed'`) addressed realm-exactly through
   * the same canonical-key resolution `seedRealm`'s directive uses (bare-id
   * fallback when the identity port cannot resolve the registration). Member
   * targets resolve through the template agent key to the launched member id.
   *
   * Delivery runs after every placement write, so a write failure never leaves
   * a directive behind; like `seedRealm`, a bus rejection (`success !== true`)
   * is not rethrown — the launch receipt has no per-directive outcome surface
   * and the envelope archive records the outcome.
   *
   * @param realmId - Registry id of the freshly created Realm.
   * @param directives - Resolved directives from the launch plan, in declared order.
   * @param agentPlans - Materialized agent plans (template keys to member ids).
   * @throws `Error` - With code `'ERR_STORE_INVALID_PARAMS'` when a directive targets an unknown agent key.
   */
  #deliverTemplateDirectives(
    realmId: string,
    directives: readonly RealmResolvedDirective[],
    agentPlans: readonly RealmLaunchAgentPlan[]
  ): void {
    for (const directive of directives) {
      const agentPlan = agentPlans.find((entry) => entry.key === directive.targetAgentKey) ?? null;
      if (!agentPlan) {
        // Unreachable through materialization (directive targets are validated
        // against template agent keys); kept fail-closed for hand-built plans.
        throw invalidRealmParams(
          `launchRealmFromTemplate: directive targets unknown agent key '${directive.targetAgentKey}'`
        );
      }
      const recipient = this.#canonicalAgentKeyInRealm(agentPlan.agentId, realmId) ?? agentPlan.agentId;
      this.sendMessage('human', recipient, directive.text, { source: 'realm_seed', realmId });
    }
  }

  /**
   * Best-effort rollback of a failed template launch: permanently purges every
   * active agent whose membership names the freshly created Realm, evicts the
   * template-seed files already written, then removes the Realm record through
   * the recursive `deleteRealm(realmId, { recursive: true })` override, which
   * purges any member a failed purge left behind so no half-realm record
   * survives while the operator principal is registered. Purging (not
   * recycling) keeps the rollback out of the recycle bin; membership is never
   * moved (Wave R, ticket 56ba4b9). Every rollback failure is collected instead
   * of thrown so the caller receives the complete report on the launch error.
   *
   * Seed eviction runs after the member purge (which evicts each member's
   * private workspace, seeded files included) and removes every recorded path
   * individually: a realm-global partition key (`realm:<realmId>:global`) is a
   * VFS-reserved workspace that `deleteWorkspace` refuses by design, so the
   * files are deleted one by one and an empty container key can remain. A
   * missing file (`false`) is not a failure — the purge already removed it.
   *
   * @param realmId - Registry id of the Realm being rolled back.
   * @param seedWrites - Seed write groups recorded by `#applyTemplatePlacements`.
   * @returns Purged member ids, evicted seed paths, and human-readable rollback failures.
   */
  #rollbackRealmLaunch(
    realmId: string,
    seedWrites: readonly RealmSeedWriteGroup[] = []
  ): RealmLaunchRollback {
    const terminatedMembers: string[] = [];
    const evictedSeedFiles: string[] = [];
    const rollbackFailures: string[] = [];
    const members = this.agents.filter((agent) => agent.config?.realmId === realmId);
    for (const member of members) {
      try {
        if (this.purgeAgent(member.id)) {
          terminatedMembers.push(member.id);
        } else {
          rollbackFailures.push(`${member.id}: member was not purged`);
        }
      } catch (err) {
        rollbackFailures.push(`${member.id}: ${sanitizeDiagnosticError(thrownMessage(err, 'purge failed'))}`);
      }
    }
    for (const group of seedWrites) {
      for (const path of group.writtenPaths) {
        try {
          if (this.deleteFile(path, group.workspace)) {
            evictedSeedFiles.push(path);
          }
        } catch (err) {
          rollbackFailures.push(
            `seed file '${path}' in '${group.workspace}': ${sanitizeDiagnosticError(thrownMessage(err, 'eviction failed'))}`
          );
        }
      }
    }
    try {
      this.deleteRealm(realmId, { recursive: true });
    } catch (err) {
      rollbackFailures.push(`realm record: ${sanitizeDiagnosticError(thrownMessage(err, 'removal failed'))}`);
    }
    return { terminatedMembers, evictedSeedFiles, rollbackFailures };
  }

  /**
   * Runs the H1 reload capability heal on demand: reconciles the tool grants
   * captured from the persisted snapshot at hydration onto the currently
   * registered agents, under the store's operator context. Only capability
   * selectors (`allowedTools`/`tools`/`toolPreset`, resolved through the
   * sandbox preset resolver) are applied — `privileged`, parentage, and realm
   * membership are never read from the snapshot. The pass is idempotent (a
   * second run reports `unchanged` and mutates nothing) and publishes its
   * outcome on `capabilityHealReport`.
   *
   * The method is a safe retry point for the wildcard-grant case: when the
   * operator principal was not yet registered at hydration time those grants
   * are reported as `'skipped'` and stay default-deny; calling this method
   * after the operator exists restores them.
   *
   * @returns The heal report, or `null` when no persisted grants were captured (no hydration yet or no capability selectors in the snapshot).
   *
   * @example
   * ```typescript
   * const report = sandboxStore.healRestoredCapabilities();
   * console.log(`Restored ${report?.restored ?? 0} agent grant(s).`);
   * ```
   */
  healRestoredCapabilities(): CapabilityHealReport | null {
    const report = this.#runCapabilityHeal();
    // Extension wave (P2.4): after the selector/allowedTools reconcile,
    // recompute the effective extension grant set for every active member
    // (idle members apply immediately; busy members queue). This is the safe
    // retry point that also recovers a member blocked by an earlier failed
    // selector heal.
    this.#sweepAllExtensionAuthorizations();
    return report;
  }

  /**
   * Re-binds legacy/unbound agents of a provider to a vault credential
   * (QA-022 compatibility path). Rewrites each matching agent's
   * `modelConfig.keyId` and re-runs provider/model initialization. A falsy
   * `credentialId` clears the pin so provider construction resolves the vault's
   * active credential.
   *
   * Preset-bound agents are skipped by design (MOD-20 OPEN-2): presets carry no
   * pinned credential, and credential rotation materializes at the next turn
   * start through the preset resolver, so the legacy walk must not rewrite
   * their `modelConfig`, `keyId`, or re-initialize their provider mid-life.
   *
   * Safe to call with no matching agents; never throws.
   *
   * @param providerId - Provider whose unbound agents are re-bound (alias-normalized).
   * @param credentialId - Vault credential id, or null to unpin.
   * @returns Count of re-bound (legacy/unbound) agents.
   *
   * @example
   * ```typescript
   * const vault = sandboxStore.getCredentialVault();
   * const entry = vault.getActiveCredential('deepseek');
   * sandboxStore.rebindProviderCredentials('deepseek', entry.id);
   * ```
   */
  rebindProviderCredentials(providerId: string, credentialId: string | null = null): number {
    const normProviderId = normalizeProviderId(providerId);
    const candidates = [
      ...(this.#runtime && typeof this.#runtime.listAgents === 'function' ? this.#runtime.listAgents() : []),
      ...(this.#runtime && typeof this.#runtime.listRecycledAgents === 'function' ? this.#runtime.listRecycledAgents() : [])
    ];

    let reboundCount = 0;
    for (const agent of candidates) {
      if (!agent || !agent.modelConfig) continue;
      if (normalizeProviderId(agent.modelConfig.providerId) !== normProviderId) continue;

      // MOD-20 de-emphasis (OPEN-2): a non-empty preset binding marks the agent
      // as preset-resolved; credential rotation reaches it at the next turn
      // start, never through this legacy rewrite walk.
      const presetId = typeof agent.config?.presetId === 'string' ? agent.config.presetId.trim() : '';
      if (presetId) continue;

      const nextModelConfig = { ...agent.modelConfig };
      if (credentialId) {
        nextModelConfig.keyId = credentialId;
      } else {
        // Un-pinning removes `keyId` so provider construction resolves the
        // vault's active credential, even though the contract declares it required.
        delete (nextModelConfig as { keyId?: string }).keyId;
      }
      agent.modelConfig = nextModelConfig;
      agent.config = { ...(agent.config || {}), modelConfig: { ...nextModelConfig } };

      if (typeof agent.rebindModel === 'function') {
        try {
          agent.rebindModel();
          reboundCount += 1;
        } catch {
          // A single failed re-init must not abort the store-wide rebind walk.
        }
      }
    }

    this.#syncAgents();
    this.#syncRecycleBin();
    this.#scheduleAutoSave();
    return reboundCount;
  }

  // ==========================================================================
  // Persistence & App Lifecycle
  // ==========================================================================

  /**
   * Serializes complete store, runtime, VirtualFS, MessagingBus, clock, and UI metadata snapshot.
   *
   * Wave I (ticket c02d0b9; fix lane G2): the active operator `realmBypass`
   * grants (`runtime.listRealmBypassGrants()`, canonical identity keys) ride
   * the additive top-level `realmBypassGrants` field; it is omitted when empty,
   * so grant-free and legacy snapshots keep every existing field and byte.
   *
   * Wave U (ticket 2518510) + M1: the publishing pair's grants ride the
   * additive `metaAuthorityGrants` field (canonical identity keys per
   * authority), every non-publishing grant rides the additive
   * `authorityGrants` field (authority id → canonical identity keys), and the
   * per-template trust record rides `templateAuthorityTrust`; all are omitted
   * when empty, so grant-free, publishing-only, and legacy snapshots stay
   * byte-identical.
   *
   * Extension wave: the global install records ride the additive `extensions`
   * field (the registry's frozen projection) and each realm record carries its
   * own attachments; both are omitted when empty, so install-free and legacy
   * snapshots keep every existing field and byte.
   *
   * Ticket 81d8267: the saved hydration-payload library rides the additive
   * `savedInstancePayloads` field, omitted when empty, so a library-free
   * session keeps every existing field and byte.
   *
   * @returns `SandboxPersistedState` ready for LocalStorage or JSON export.
   * 
   * @example
   * ```typescript
   * const snapshot = sandboxStore.serialize();
   * console.log('Serialized snapshot agents:', snapshot.agents.length);
   * ```
   */
  serialize(): SandboxPersistedState {
    const snapshot: AuthorityGrantSnapshot = serializeRuntimeEnvironment(this.#runtime, {
      activeAgentId: this.selectedAgentId,
      // Defect 7d2c314: the canonical selection key rides the additive
      // `activeAgentKey` field so hydration restores the exact registration
      // (the bare `activeAgentId` stays the legacy realm-opaque display form).
      activeAgentKey: this.selectedAgentKey,
      activeFsWorkspace: this.activeFsWorkspace,
      activeTab: this.activeTab,
      agentDraftInputs: { ...this.agentDraftInputs },
      activePresetId: this.#activePresetId,
      customPresets: this.#customPresets.map((preset) => cloneModelPreset(preset)),
      realms: this.#realmRecords.map((realm) => cloneRealmRecord(realm)),
      extensions: this.#extensionRegistry.listExtensions().map((record) => cloneExtensionInstallRecord(record)),
      importedRealmTemplates: this.#serializeRealmTemplateImports(),
      // Ticket 81d8267: the operator's saved-payload library rides the
      // additive `savedInstancePayloads` field (persistence copies it, caps
      // it, and omits it when empty, so a saved-free session keeps every
      // existing field and byte).
      savedInstancePayloads: this.#savedInstancePayloads.map((entry) => ({
        id: entry.id,
        name: entry.name,
        templateId: entry.templateId,
        templateVersion: entry.templateVersion,
        savedAt: entry.savedAt,
        payload: entry.payload
      }))
    });
    let withAdditions: AuthorityGrantSnapshot = snapshot;
    const grants = this.#runtime.listRealmBypassGrants();
    if (Array.isArray(grants) && grants.length > 0) {
      withAdditions = { ...withAdditions, realmBypassGrants: [...grants] };
    }
    // Wave U (ticket 2518510): the publishing pair's grant lists are emitted
    // only when non-empty, so grant-free and legacy sessions keep every
    // existing field and byte. M1: the publishing pair keeps this legacy
    // partition byte-identically; every non-publishing grant rides the additive
    // `authorityGrants` field (also omitted when empty), and a mixed session
    // emits both. M2 (finding F3): the generic entries carry the registry-side
    // scope (`{ ref, scope }` for a narrowed grant; a bare key string for the
    // unscoped form) so a narrowed grant never widens across a restart.
    const authorityGrants = this.#runtime.listAuthorityGrantRecords();
    const refOnly = (entries: readonly AuthorityGrantSnapshotEntry[]): string[] => {
      const refs: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        refs[refs.length] = typeof entry === 'string' ? entry : entry.ref;
      }
      return refs;
    };
    const templateGrantKeys = Array.isArray(authorityGrants[AGENT_AUTHORITIES.TEMPLATE])
      ? refOnly(authorityGrants[AGENT_AUTHORITIES.TEMPLATE])
      : [];
    const hydrationGrantKeys = Array.isArray(authorityGrants[AGENT_AUTHORITIES.HYDRATION])
      ? refOnly(authorityGrants[AGENT_AUTHORITIES.HYDRATION])
      : [];
    if (templateGrantKeys.length > 0 || hydrationGrantKeys.length > 0) {
      withAdditions = {
        ...withAdditions,
        metaAuthorityGrants: {
          ...(templateGrantKeys.length > 0 ? { template: [...templateGrantKeys] } : {}),
          ...(hydrationGrantKeys.length > 0 ? { hydration: [...hydrationGrantKeys] } : {})
        }
      };
    }
    const genericGrants: Record<string, readonly AuthorityGrantSnapshotEntry[]> = {};
    let genericGrantCount = 0;
    for (const authorityId of Object.keys(authorityGrants)) {
      if (PUBLISHING_AUTHORITY_ID_SET.has(authorityId)) continue;
      const entries = authorityGrants[authorityId];
      if (!Array.isArray(entries) || entries.length === 0) continue;
      genericGrants[authorityId] = [...entries];
      genericGrantCount += 1;
    }
    if (genericGrantCount > 0) {
      withAdditions = { ...withAdditions, authorityGrants: genericGrants };
    }
    const trust = this.#serializeTemplateAuthorityTrust();
    if (trust !== null) {
      withAdditions = { ...withAdditions, templateAuthorityTrust: trust };
    }
    return withAdditions;
  }

  /**
   * Flushes debounced saves and writes complete state snapshot immediately to LocalStorage.
   * 
   * @returns `true` if saved successfully; `false` if storage quota exceeded or failed.
   * 
   * @example
   * ```typescript
   * const saved = sandboxStore.saveToStorage();
   * console.log('Saved to LocalStorage:', saved);
   * ```
   */
  saveToStorage(): boolean {
    if (this.#debouncedSave) {
      this.#debouncedSave.flush();
    }
    const snapshot = this.serialize();
    return saveSandboxState(snapshot);
  }

  /**
   * Hydrates store and domain engines from stored LocalStorage snapshot.
   * Satisfies the Zero Zombie Invariant by resetting running agents to `IDLE`.
   *
   * A `RestoreResult` object counts as success only when `restored.success` is
   * true. If a critical subsystem rejects its snapshot, the store still mirrors
   * the partially hydrated engine, raises a `hydrationNotice` with reason
   * `'hydration-failed'`, and returns `false` — it never reports success.
   * 
   * @returns `true` if hydrated from existing stored snapshot; `false` if absent or if hydration failed.
   * 
   * @example
   * ```typescript
   * const hydrated = sandboxStore.hydrateFromStorage();
   * if (hydrated) {
   *   console.log('Restored previous sandbox session from storage.');
   * } else if (sandboxStore.hydrationNotice) {
   *   console.warn('Hydration notice:', sandboxStore.hydrationNotice.reason);
   * }
   * ```
   */
  hydrateFromStorage(): boolean {
    // Load-time reconciliation and restore may write in-memory catalog/state
    // (adapter `save` closures, pointer closure), but must never schedule the
    // debounced autosave: hydration leaves persisted bytes untouched, so a
    // failed restore cannot overwrite them and a successful one cannot rewrite
    // them (healing is in-memory only).
    this.#hydrating = true;
    // Extension wave (P2.4): a hydration pass rebuilds the active registry, so
    // the safe-state sweep queue and the fail-closed guard start clean.
    // Ticket 9327633: the registration diff's baseline and pending sweep are
    // rebuilt by the sync passes below (hydration owns the restored members'
    // grant application through its explicit sweep).
    this.#pendingExtensionReauthorize.clear();
    this.#extensionSweepBlocked.clear();
    this.#pendingRegistrationSweep.clear();
    this.#storeLaunchGrantedKeys.clear();
    // Extension wave (P3.1): hydration is a restore boundary — live sessions
    // and catalogs belong to the topology being replaced, and the restored
    // state is by contract not-connected (no auto-connect here or later).
    this.#teardownExtensionConnections();
    try {
      const persistedState = loadSandboxState({
        onRecovery: (info) => {
          this.hydrationNotice = {
            message: 'Saved session could not be loaded — starting fresh',
            at: Date.now(),
            reason: info?.reason || 'unreadable'
          };
        }
      });
      if (!persistedState) {
        this.#capabilityHealGrants = [];
        this.capabilityHealReport = null;
        this.legacyWorkspaceRemapReport = null;
        this.#pendingExtensionReauthorize.clear();
        this.#extensionSweepBlocked.clear();
        this.#pendingRegistrationSweep.clear();
        this.#storeLaunchGrantedKeys.clear();
        this.#restoreSavedInstancePayloads(null);
        this.#syncAgents();
        this.#syncRecycleBin();
        this.#syncMessages();
        this.#syncFsSnapshot();
        this.#syncScheduledTimers();
        this.#syncClockSnapshot();
        return false;
      }

      // MOD-20: the loaded snapshot is authoritative for the catalog before
      // any agent is restored — persisted custom entries are reconciled first,
      // then every agent binding is fingerprint-healed against the
      // reconciled catalog (enumeration is available only in the store).
      this.#reconcilePresetCatalog(persistedState);
      this.#healSnapshotPresetBindings(persistedState);
      // Extension wave: the persisted install topology is applied through the
      // registry's validated reconcile path first, so the realm reconcile and
      // the attachment heal that follow read the current install state.
      this.#reconcileExtensionRegistry(persistedState);
      this.#reconcileRealmRegistry(persistedState);
      // Wave T (ticket 0df20ae): the persisted import topology re-resolves the
      // effective launch catalog in memory; hydration never rewrites the bytes
      // it read (the suppression guard keeps autosave inert).
      this.#reconcileRealmTemplateImports(persistedState);
      // Ticket 81d8267: the persisted saved-payload library is
      // snapshot-authoritative — restored verbatim (re-digested, malformed
      // entries dropped) or emptied by a legacy snapshot without the field.
      // The suppression guard keeps autosave inert here too.
      this.#restoreSavedInstancePayloads(persistedState);
      // H1: capture the persisted capability selectors as data BEFORE restore;
      // the runtime withholds them from the hydrated configs, so the store is
      // the only layer that can hand them back through the gated operator path.
      this.#captureCapabilityHealGrants(persistedState);

      const restored = restoreRuntimeEnvironment(persistedState, this.#runtime);
      // H1: reconcile the captured grants onto whatever the runtime restored.
      // The pass never reads privilege/parentage and never schedules a save
      // while `#hydrating` is set.
      this.#runCapabilityHeal();
      // Wave I (ticket c02d0b9): re-apply the persisted operator bypass grants
      // after the agents are registered. The runtime grants only active ids and
      // drops unknown/recycled ones fail-closed; an absent field leaves the
      // grant list empty, so legacy snapshots hydrate unchanged.
      this.#restorePersistedRealmBypassGrants(persistedState);
      // Wave U (ticket 2518510) + M1: re-apply the persisted publishing and
      // generic authority grants through the same operator-gated restore
      // (unknown ids and unknown/recycled refs skipped), and seed the
      // per-template trust record that future launches consult for exact-match
      // auto-approval. Both grant fields are absent on legacy snapshots, so
      // hydration stays byte-identical.
      this.#restorePersistedAuthorityGrants(persistedState);
      this.#seedTemplateAuthorityTrustFrom(persistedState);
      // Extension wave: attachment status degrades/recovers against the
      // reconciled install records (a tampered snapshot attachment for an
      // unknown extension becomes `unavailable`, never dangles silently). The
      // pass is in-memory only: the suppression guard keeps autosave inert, so
      // persisted bytes are never rewritten here.
      this.#healRealmExtensionAttachments();
      // Extension wave (P2.4): after the attachment heal settles which
      // extensions are genuinely active, recompute every member's effective
      // extension grant set from the live Realm universe × its healed
      // selector. Restored members are idle, so the sweep applies immediately
      // through the operator-gated reauthorize path; a member whose selector
      // heal failed stays blocked (default-deny) rather than silently
      // resolving the default `'all'`.
      this.#sweepAllExtensionAuthorizations();
      // Wave I (ticket d57cbc1): recover legacy bare-keyed private workspace
      // bytes onto each record's canonical realm-qualified key. Runs after the
      // runtime restore (so the identity port resolves the restored records)
      // and before every resync; the in-memory VFS only — persisted bytes are
      // never rewritten here (the suppression guard keeps autosave inert).
      this.#rekeyLegacyPrivateWorkspacesOnHydrate(persistedState);
      if (restored && restored.success) {
        this.#worldClock = this.#runtime.worldClock || this.#worldClock;
        if (this.#worldClock && typeof this.#worldClock.syncFromVirtualFs === 'function') {
          this.#worldClock.syncFromVirtualFs();
        }
        if (this.#messagingBus && typeof this.#messagingBus.subscribe === 'function') {
          if (typeof this.#unsubBus === 'function') {
            try { this.#unsubBus(); } catch {
              /* Best-effort unsubscribe; the old subscription is replaced below. */
            }
          }
          this.#unsubBus = this.#messagingBus.subscribe('all', this.#handleBusMessage.bind(this));
        }

        this.#syncAgents();
        this.#syncRecycleBin();
        this.#syncMessages();
        this.#syncFsSnapshot();
        this.#syncScheduledTimers();
        this.#syncClockSnapshot();
        // Defect 7d2c314: prefer the persisted canonical selection key; a
        // legacy snapshot without it falls back to the bare `activeAgentId`
        // (unique-match resolution or none).
        const persistedSelectionKey = typeof persistedState.activeAgentKey === 'string' && persistedState.activeAgentKey
          ? persistedState.activeAgentKey
          : null;
        if (persistedSelectionKey) {
          this.selectAgent(persistedSelectionKey);
        } else if (persistedState.activeAgentId) {
          this.selectAgent(persistedState.activeAgentId);
        }
        if (persistedState.activeFsWorkspace) {
          this.activeFsWorkspace = persistedState.activeFsWorkspace;
        }
        if (persistedState.activeTab) {
          this.activeTab = persistedState.activeTab as SandboxTabId;
        }
        if (persistedState.agentDraftInputs && typeof persistedState.agentDraftInputs === 'object') {
          this.agentDraftInputs = { ...persistedState.agentDraftInputs };
        }
        return true;
      }

      // Partial/degraded hydration: a RestoreResult object is not success — a
      // critical subsystem rejected its snapshot and its receipt must surface.
      if (restored && !restored.success) {
        const detailSuffix = Array.isArray(restored.details) && restored.details.length > 0
          ? ` (${restored.details.length} malformed ${restored.details.length === 1 ? 'entry' : 'entries'})`
          : '';
        this.hydrationNotice = {
          message: `Saved session could not be fully restored — ${restored.error || 'subsystem hydration failed'}${detailSuffix}`,
          at: Date.now(),
          reason: 'hydration-failed'
        };
      }
      this.#syncAgents();
      this.#syncRecycleBin();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncScheduledTimers();
      this.#syncClockSnapshot();
      return false;
    } catch (err) {
      console.warn('[SandboxStore] Auto-hydration failed:', err);
      this.#syncAgents();
      this.#syncRecycleBin();
      this.#syncMessages();
      this.#syncFsSnapshot();
      this.#syncScheduledTimers();
      this.#syncClockSnapshot();
      return false;
    } finally {
      this.#hydrating = false;
    }
  }

  /**
   * Dismisses the persisted-state recovery notice (`hydrationNotice`) after the
   * user acknowledges that the previous session could not be loaded (QA-013).
   * 
   * @example
   * ```typescript
   * sandboxStore.dismissHydrationNotice();
   * ```
   */
  dismissHydrationNotice(): void {
    this.hydrationNotice = null;
  }

  /**
   * Factory Reset: Clears persisted storage, cancels pending debounced saves,
   * resets VirtualFS and MessagingBus, and restores fresh Director Meta-Agent.
   * 
   * @example
   * ```typescript
   * // Triggered by UI "Reset Sandbox" button
   * sandboxStore.factoryReset();
   * ```
   */
  factoryReset(): void {
    if (this.#debouncedSave) {
      this.#debouncedSave.cancel();
    }
    clearSandboxState();
    // Clock snapshot import is tenant administration (MOD-21 W10-C): prefer the
    // runtime persistence port, which carries the composition-root
    // InternalPrincipal binding; the direct call stays only as a fallback for
    // runtimes without a persistence port and runs under the store's operator
    // context (the runtime's host operator principal).
    const runtimeClockPort = this.#runtime && typeof this.#runtime.createPersistencePort === 'function'
      ? this.#runtime.createPersistencePort()?.worldClock
      : null;
    if (runtimeClockPort && typeof runtimeClockPort.importSnapshot === 'function') {
      runtimeClockPort.importSnapshot({ totalSeconds: 0, date: 'Day 1', events: [] });
    } else if (this.#worldClock && typeof this.#worldClock.importSnapshot === 'function') {
      this.#worldClock.importSnapshot(
        { totalSeconds: 0, date: 'Day 1', events: [] },
        this.#clockAuthorityContext('global')
      );
    }
    this.reset();
    if (this.#autoBootstrapDirector) {
      this.ensureDirector().catch((err) => {
        console.error('Failed to ensure Director agent during factory reset:', err);
      });
    }
  }

  /**
   * Synchronously clears all in-memory reactive state and cancels countdown tickers.
   * 
   * @example
   * ```typescript
   * sandboxStore.reset();
   * ```
   */
  reset(): void {
    this.#stopTimerTicker();
    this.#cancelStreamMirror();
    // MOD-20: an in-memory reset drops the snapshot-backed preset topology —
    // custom entries are deleted through the catalog API and the active
    // pointer falls back to the master default.
    this.#reconcilePresetCatalog(null);
    // Wave A: an in-memory reset drops the snapshot-backed realm topology —
    // every unprotected record is removed through the registry API and the
    // protected Generic default is restored to its pristine seed metadata
    // (Wave R hardening, ticket 0fe25fd).
    this.#reconcileRealmRegistry(null);
    // Extension wave: an in-memory reset drops the snapshot-backed global
    // install topology too (realm attachments went with the realm records).
    this.#reconcileExtensionRegistry(null);
    // Wave T: an in-memory reset also drops the runtime template imports, so
    // the effective catalog returns to the shipped revision.
    this.#reconcileRealmTemplateImports(null);
    // Wave U (ticket 2518510): a reset drops the session-only pending instance
    // payloads and every per-template trust record.
    this.#pendingInstancePayloads.clear();
    this.#templateAuthorityTrust.clear();
    // Ticket 81d8267: a reset drops the persisted saved-payload library too
    // (the counter returns to zero, so the next save starts a fresh session
    // numbering).
    this.#restoreSavedInstancePayloads(null);
    // H1: a reset drops the captured hydration grants and the last heal report.
    this.#capabilityHealGrants = [];
    this.capabilityHealReport = null;
    // Extension wave: a reset drops the safe-state sweep queue and the
    // fail-closed sweep guard (no agent survives a runtime reset), and it
    // tears down every live extension connection (session-only state never
    // outlives the topology it was opened against). Ticket 9327633: the
    // registration baseline/pending sets are rebuilt by the sync below and no
    // launch mark can survive the reset.
    this.#pendingExtensionReauthorize.clear();
    this.#extensionSweepBlocked.clear();
    this.#pendingRegistrationSweep.clear();
    this.#storeLaunchGrantedKeys.clear();
    this.#teardownExtensionConnections();
    // Wave I: a reset drops the last legacy-workspace remap report too.
    this.legacyWorkspaceRemapReport = null;
    this.#runtime.reset();
    // `runtime.reset()` clears all runtime event listeners; restore the store's
    // subscription so live mirror updates (turn state, streaming, telemetry)
    // keep flowing after a factory reset.
    if (typeof this.#unsubRuntime === 'function') {
      try { this.#unsubRuntime(); } catch {
        /* Best-effort unsubscribe; the runtime subscription is re-established below. */
      }
    }
    this.#unsubRuntime = this.#runtime.subscribe(this.#handleRuntimeEvent.bind(this));
    this.agents = [];
    this.recycleBin = [];
    this.selectedAgentKey = null;
    this.messages = [];
    this.scheduledTimers = [];
    this.fsSnapshot = {};
    this.activeFsWorkspace = 'global';
    this.activeTab = 'inspector';
    this.agentDraftInputs = {};
    this.clockSnapshot = {};
    this.isDemoRunning = false;

    this.demoStep = '';
    this.demoLogs = [];
    this.isLaunchingAgent = false;
    this.error = null;
    this.hydrationNotice = null;

    this.#syncAgents();
    this.#syncRecycleBin();
    this.#syncMessages();
    this.#syncFsSnapshot();
    this.#syncScheduledTimers();
    this.#syncClockSnapshot();
  }

  /**
   * Cleanly tears down store subscriptions, MessagingBus listeners, auto-save timers, and tickers.
   * Essential for component unmount and test suite teardown.
   * 
   * @example
   * ```typescript
   * // Inside Svelte onDestroy hook
   * store.destroy();
   * ```
   */
  destroy(): void {
    // Extension wave (P3.1): no live session may outlive the store — abort
    // in-flight connects and fire best-effort closes before the runtime
    // subscription goes away.
    this.#teardownExtensionConnections();
    if (typeof this.#unsubRuntime === 'function') {
      this.#unsubRuntime();
      this.#unsubRuntime = null;
    }
    if (typeof this.#unsubBus === 'function') {
      this.#unsubBus();
      this.#unsubBus = null;
    }
    if (typeof this.#unsubRealms === 'function') {
      this.#unsubRealms();
      this.#unsubRealms = null;
    }
    this.#stopTimerTicker();
    this.#cancelStreamMirror();
    if (this.#debouncedSave && typeof this.#debouncedSave.destroy === 'function') {
      this.#debouncedSave.destroy();
    }
  }

  // ==========================================================================
  // UI Workstation & Demonstration
  // ==========================================================================

  /**
   * Changes the workstation view tab (`'chat'`, `'settings'`, `'inspector'`, `'filesystem'`, `'messaging'`).
   * 
   * @param tab - Target tab identifier.
   * 
   * @example
   * ```typescript
   * sandboxStore.setActiveTab('filesystem');
   * ```
   */
  setActiveTab(tab: SandboxTabId): void {
    this.activeTab = tab;
    this.#scheduleAutoSave();
  }

  /**
   * Executes the multi-agent handshake collaboration scenario (PRD AC #5).
   * Provisions Scout Unit Alpha and HQ Commander, writes `/mission_report.json`
   * and `/orders.json` to the shared `global` workspace, dispatches the alert and
   * order messages across the MessagingBus, and returns `success: true` when no
   * step throws. The scenario performs no cross-workspace isolation or
   * mutual-synchronization assertions.
   * 
   * @returns Promise resolving to `DemoResult` with execution logs.
   * 
   * @example
   * ```typescript
   * const demoResult = await sandboxStore.runHandshakeDemo();
   * if (demoResult.success) {
   *   console.log('Handshake demo passed with logs:', demoResult.logs);
   * }
   * ```
   */
  async runHandshakeDemo(): Promise<DemoResult> {
    this.reset();
    this.isDemoRunning = true;
    this.demoLogs = [];
    this.error = null;

    const log = (step: string, message: string, type: DemoLogEntry['type'] = 'info') => {
      this.demoStep = step;
      this.demoLogs = [...this.demoLogs, { timestamp: Date.now(), step, message, type }];
    };

    try {
      log('1. Initializing Demo', 'Sandbox environment reset. Provisioning agents...');

      // 1. Provision Scout Agent
      log('2. Provisioning Scout', 'Launching Scout Agent (agent-scout)...');
      await this.launchAgent({
        id: 'agent-scout',
        name: 'Scout Unit Alpha',
        role: 'Field Reconnaissance & Telemetry Collector',
        systemPrompt: 'You are Scout Unit Alpha. You perform field reconnaissance and deposit structured telemetry into the shared global workspace for Commander review.'
      });

      // 2. Provision Commander Agent
      log('3. Provisioning Commander', 'Launching HQ Commander (agent-commander)...');
      await this.launchAgent({
        id: 'agent-commander',
        name: 'HQ Commander',
        role: 'Tactical Mission Command',
        systemPrompt: 'You are HQ Commander. You monitor the global workspace for scout reports, formulate strategic directives, and dispatch mission orders.'
      });

      this.selectAgent('agent-scout');

      // 3. Scout performs recon and writes file to global workspace
      log('4. Scout Reconnaissance', 'Scout Unit Alpha gathering sector data and writing /mission_report.json to global workspace...');
      const reportData = {
        sector: 'Quadrant 7',
        status: 'Hostile signal detected',
        targets: [
          { id: 'T-101', signature: 'High-energy core', threat: 'SEVERE' },
          { id: 'T-102', signature: 'Shield generator', threat: 'MODERATE' }
        ],
        timestamp: Date.now()
      };

      this.#virtualFs.writeFile({
        filePath: '/mission_report.json',
        content: JSON.stringify(reportData, null, 2),
        workspaceId: 'global',
        callerAgentId: 'agent-scout',
        owner: 'agent-scout'
      });
      this.#syncFsSnapshot();
      this.#syncClockSnapshot();

      // 4. Scout sends message to Commander via MessagingBus
      log('5. Scout Dispatch', 'Scout Unit Alpha dispatching mission alert to HQ Commander via MessagingBus...');
      this.sendMessage('agent-scout', 'agent-commander', 'Reconnaissance completed in Quadrant 7. Full telemetry deposited in global /mission_report.json. Awaiting authorization.', {
        priority: 'HIGH',
        reportPath: '/mission_report.json'
      });

      // 5. Commander processes report and writes orders
      log('6. Commander Processing', 'HQ Commander reading /mission_report.json, formulating tactical response...');
      const readReport = this.#virtualFs.readFile({ filePath: '/mission_report.json', workspaceId: 'global', callerAgentId: 'agent-commander', raw: true });
      const parsedReport: typeof reportData = JSON.parse(readReport);

      const ordersData = {
        missionId: 'OP-PHOENIX-07',
        directive: 'Establish defensive perimeter and hold Quadrant 7 until reinforcement arrival.',
        authorizationCode: 'CMD-9942-ALPHA',
        issuedTo: 'agent-scout',
        approvedTargets: parsedReport.targets ? parsedReport.targets.map(t => t.id) : ['T-101'],
        timestamp: Date.now()
      };

      this.#virtualFs.writeFile({
        filePath: '/orders.json',
        content: JSON.stringify(ordersData, null, 2),
        workspaceId: 'global',
        callerAgentId: 'agent-commander',
        owner: 'agent-commander'
      });
      this.#syncFsSnapshot();
      this.#syncClockSnapshot();

      // 6. Commander replies to Scout
      log('7. Orders Dispatched', 'HQ Commander transmitting tactical authorization back to Scout Unit Alpha...');
      this.sendMessage('agent-commander', 'agent-scout', 'Operation Phoenix Authorized. Directives stored in global /orders.json. Secure perimeter.', {
        directiveId: 'OP-PHOENIX-07'
      });

      // 7. Complete Handshake
      log('8. Handshake Complete', 'Multi-Agent collaboration handshake completed successfully! Both agents synced and verified.', 'success');
      this.demoStep = 'Handshake Complete';
      this.#scheduleAutoSave();
      return { success: true, logs: this.demoLogs };
    } catch (err) {
      const message = String(thrownMessageField(err));
      log('Demo Failed', `Handshake execution encountered error: ${message}`, 'error');
      this.error = message;
      return { success: false, error: message, logs: this.demoLogs };
    } finally {
      this.isDemoRunning = false;
    }
  }

  // ==========================================================================
  // Strict #private Internal Helpers & Event Handlers
  // ==========================================================================

  /**
   * Collect all files in a given workspace with their full contents.
   *
   * @param workspaceId - Workspace partition to read.
   * @returns File records with content for the workspace.
   */
  #getWorkspaceFilesWithContent(workspaceId: string): FileRecord[] {
    return this.#virtualFs.listFilesWithContent('/', {
      workspaceId,
      ...this.#operatorSubstrateContext()
    });
  }

  /**
   * Collect all files across all workspaces with their contents.
   *
   * @returns File records with content for every workspace.
   */
  #getAllFilesWithContent(): FileRecord[] {
    const allFiles: FileRecord[] = [];
    // Iterate the internal snapshot keys (not the realm-opaque public labels):
    // an ambiguous bare label must never fail an all-workspaces download.
    for (const wsId of Object.keys(this.fsSnapshot)) {
      allFiles.push(...this.#getWorkspaceFilesWithContent(wsId));
    }
    return allFiles;
  }

  /**
   * Authority context for runtime facade lifecycle and scheduler APIs: the
   * runtime's host operator principal by exact reference (Wave I, ticket
   * c02d0b9). The principal is host-side and agent-independent — operator
   * actions work with zero registered agents and never depend on the director
   * existing. The runtime validates the reference against the single instance
   * it minted; plain lookalike objects default-deny.
   *
   * @returns Runtime authority context carrying the operator principal.
   */
  #operatorContext(): { principal: InternalPrincipal } {
    return { principal: this.#runtime.getOperatorPrincipal() };
  }

  /**
   * Authority context for substrate APIs (VirtualFS/WorldClock/MessagingBus,
   * Wave I ticket c02d0b9): each substrate was bound to the runtime's operator
   * principal by exact reference, so carrying the principal authorizes host
   * operations (and Realm bypass) without naming any agent.
   *
   * @returns Substrate authority context carrying the operator principal.
   */
  #operatorSubstrateContext(): { principal: InternalPrincipal } {
    return { principal: this.#runtime.getOperatorPrincipal() };
  }

  /**
   * Resolves the operator execution context for a store send whose `from`
   * label is not an agent identity (ticket 99faaf1): the `MessagingBusViewer`
   * manual-send default (`'human'`) and any other presentation label denote
   * the human operator. The context carries the runtime's host operator
   * principal by exact reference (Wave I, ticket c02d0b9) so the bus grants
   * operator Realm bypass; the label remains presentation only and confers
   * nothing.
   *
   * Returns `null` for registered agent identities (the bus then resolves the
   * agent's own identity/Realm scope), for ambiguous ids registered in more
   * than one Realm (agent-labelled, never operator-attributed — the bus fails
   * closed), and for recycled agent labels; the principal always exists, so
   * every non-agent label runs as an operator send.
   *
   * @param from - Caller-supplied sender label of the store send.
   * @returns Operator execution context, or `null` for the agent-scoped path.
   */
  #resolveSendOperatorContext(from: string): { callerAgentId: string; principal: InternalPrincipal } | null {
    if (!from || typeof from !== 'string') return null;

    let identity: unknown = null;
    if (this.#identityPort) {
      try {
        identity = this.#identityPort.getAgentIdentity(from);
      } catch {
        identity = null;
      }
    }
    if (identity) return null;

    // Wave I (ticket d57cbc1): a bare id registered in two Realms resolves no
    // unique identity, but it is still an agent label — never an operator
    // label. Attributing it to the operator principal would hand an ambiguous
    // agent send the operator bypass; the bus resolves the sender within the
    // delivery scope and fails closed on the ambiguity instead.
    if (this.#agentProjectionsFor(from).length > 1) return null;

    if (typeof this.#runtime.hasRecycledAgent === 'function' && this.#runtime.hasRecycledAgent(from)) {
      return null;
    }

    return { callerAgentId: from, principal: this.#runtime.getOperatorPrincipal() };
  }

  /**
   * Enumerates the active identity projections registered under a bare
   * realm-local id (Wave I, ticket d57cbc1) through the runtime identity port:
   * zero for an unknown/phantom ref, one for a realm-unique registration, and
   * several when the same literal id is live in multiple Realms. Enumeration
   * failures fail closed to no projections, so callers keep the legacy
   * bare-id path instead of a wrong-Realm pick.
   *
   * @param bareId - Realm-local agent id to enumerate.
   * @returns Matching active projections (empty on unknown/ambiguous/failure).
   */
  #agentProjectionsFor(bareId: string): AgentIdentityProjection[] {
    const identityPort = this.#identityPort;
    if (!identityPort || !bareId || typeof bareId !== 'string') return [];
    try {
      if (typeof identityPort.listAgentIdentities === 'function') {
        return identityPort.listAgentIdentities().filter((projection) => Boolean(projection) && projection.id === bareId);
      }
      const projection = identityPort.getAgentIdentity(bareId);
      return projection ? [projection] : [];
    } catch {
      return [];
    }
  }

  /**
   * Resolves the unique active registration of a bare realm-local id (Wave I,
   * ticket d57cbc1). Unlike the projection enumeration helper, an id
   * registered in more than one Realm resolves `null` — the port's
   * unique-match rule — so callers fail closed instead of picking the first
   * registration.
   *
   * @param bareId - Realm-local agent id to resolve.
   * @returns The unique active projection, or `null`.
   */
  #resolveUniqueAgentProjection(bareId: string): AgentIdentityProjection | null {
    const identityPort = this.#identityPort;
    if (!identityPort || !bareId || typeof bareId !== 'string') return null;
    try {
      return identityPort.getAgentIdentity(bareId);
    } catch {
      return null;
    }
  }

  /**
   * Canonical `(realmId, agentId)` key of a unique active registration, or
   * `null` when the bare id is unknown or ambiguous (Wave I, ticket d57cbc1).
   *
   * @param bareId - Realm-local agent id.
   * @returns Canonical identity key, or `null`.
   */
  #canonicalAgentKeyFor(bareId: string): string | null {
    const projection = this.#resolveUniqueAgentProjection(bareId);
    return projection && typeof projection.key === 'string' && projection.key ? projection.key : null;
  }

  /**
   * Resolves the reactive snapshot a selection/action reference addresses
   * (defect 7d2c314): an exact canonical `(realmId, agentId)` identity key
   * wins over active then recycled registrations; otherwise exactly one bare
   * match across both registries resolves (an id registered in more than one
   * scope fails closed), and an unresolvable reference resolves `null`.
   *
   * @param ref - Canonical identity key or bare realm-local agent id.
   * @returns The matching snapshot, or `null`.
   */
  #snapshotForRef(ref: string | null | undefined): AgentStateSnapshot | RecycledAgentStateSnapshot | null {
    if (!ref || typeof ref !== 'string') return null;
    const exact = this.agents.find((agent) => agent.identityKey === ref)
      || this.recycleBin.find((agent) => agent.identityKey === ref);
    if (exact) return exact;
    const matches: Array<AgentStateSnapshot | RecycledAgentStateSnapshot> = [
      ...this.agents.filter((agent) => agent.id === ref),
      ...this.recycleBin.filter((agent) => agent.id === ref)
    ];
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Resolves the active snapshot a selection/action reference addresses
   * (defect 7d2c314): an exact canonical identity key first, then a unique
   * bare-id match; ambiguous or recycled references resolve `null`.
   *
   * @param ref - Canonical identity key or bare realm-local agent id.
   * @returns The matching active snapshot, or `null`.
   */
  #activeSnapshotForRef(ref: string | null | undefined): AgentStateSnapshot | null {
    if (!ref || typeof ref !== 'string') return null;
    const exact = this.agents.find((agent) => agent.identityKey === ref);
    if (exact) return exact;
    const matches = this.agents.filter((agent) => agent.id === ref);
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Resolves the recycled snapshot a restore/purge reference addresses
   * (defect 7d2c314): an exact canonical identity key first, then a unique
   * bare-id match inside the recycle bin.
   *
   * @param ref - Canonical identity key or bare realm-local agent id.
   * @returns The matching recycled snapshot, or `null`.
   */
  #recycledSnapshotForRef(ref: string | null | undefined): RecycledAgentStateSnapshot | null {
    if (!ref || typeof ref !== 'string') return null;
    const exact = this.recycleBin.find((agent) => agent.identityKey === ref);
    if (exact) return exact;
    const matches = this.recycleBin.filter((agent) => agent.id === ref);
    return matches.length === 1 ? matches[0] : null;
  }

  /**
   * Canonical action-boundary reference (defect 7d2c314): the exact
   * `identityKey` of the snapshot a reference resolves to, the raw reference
   * when nothing resolves (the runtime's own fail-closed resolution is
   * preserved), or `null` for an absent reference.
   *
   * @param ref - Canonical identity key or bare realm-local agent id.
   * @returns Canonical identity key, raw reference, or `null`.
   */
  #canonicalRef(ref: string | null | undefined): string | null {
    if (!ref || typeof ref !== 'string') return null;
    const snapshot = this.#snapshotForRef(ref);
    return snapshot ? snapshot.identityKey : ref;
  }

  /**
   * Draft-buffer map key of a reference (defect 7d2c314): the resolved
   * snapshot's bare realm-local id (the persisted `agentDraftInputs` key
   * contract) for either a canonical identity key or a bare id, else the raw
   * reference. Keeps identity-key UI call sites working against the legacy
   * bare-id draft map without rewriting persisted bytes.
   *
   * @param ref - Canonical identity key or bare realm-local agent id.
   * @returns Draft map key.
   */
  #draftKeyForRef(ref: string): string {
    const snapshot = this.#snapshotForRef(ref);
    return snapshot ? snapshot.id : ref;
  }

  /**
   * Registration ref the manual-send auto-register path should use (Wave I,
   * ticket d57cbc1): the recipient's canonical identity key when it resolves
   * uniquely, the bare id for an unresolvable phantom ref (legacy behavior),
   * and `null` for a bare id live in more than one Realm — minting a shadow
   * bare mailbox for an ambiguous agent would corrupt routing, so the send
   * fails closed on the bus instead.
   *
   * @param to - Recipient ref supplied to `sendMessage`.
   * @returns Registration ref to create, or `null` when none may be minted.
   */
  #resolveMailboxRegistrationRef(to: string): string | null {
    const projections = this.#agentProjectionsFor(to);
    if (projections.length > 1) return null;
    const projection = projections.length === 1 ? projections[0] : null;
    const canonicalKey = projection && typeof projection.key === 'string' && projection.key ? projection.key : null;
    return canonicalKey || to;
  }

  /**
   * Raw unread count of one mailbox ref through the bus (Wave I, ticket
   * d57cbc1): the bus resolves both bare ids and canonical registration keys.
   *
   * @param ref - Mailbox ref to query.
   * @returns Unread envelope count.
   */
  #busUnreadCount(ref: string): number {
    if (!this.#messagingBus) return 0;
    if (typeof this.#messagingBus.getUnreadCount === 'function') {
      return this.#messagingBus.getUnreadCount(ref);
    }
    if (typeof this.#messagingBus.listInbox === 'function') {
      return this.#messagingBus.listInbox(ref, { unreadOnly: true }).length;
    }
    return 0;
  }

  /**
   * Unread count for one agent's mailbox (Wave I, ticket d57cbc1). The
   * canonical partition is authoritative whenever it holds messages; when it
   * is absent (pre-wiring bare registrations) the bare ref is used, which the
   * bus resolves through the identity port. `exactOnly` never consults the
   * bare ref — used for a bare id live in more than one Realm, where the bare
   * mailbox is shared/ambiguous and would attribute another Realm's mail.
   *
   * @param bareId - Realm-local agent id.
   * @param canonicalKey - Resolved canonical key, or `null`.
   * @param exactOnly - When true, only the canonical partition is queried.
   * @returns Unread envelope count.
   */
  #busUnreadCountFor(bareId: string, canonicalKey: string | null, exactOnly: boolean = false): number {
    if (!canonicalKey || canonicalKey === bareId) {
      return this.#busUnreadCount(canonicalKey || bareId);
    }
    const canonicalCount = this.#busUnreadCount(canonicalKey);
    if (exactOnly || canonicalCount > 0) return canonicalCount;
    return this.#busUnreadCount(bareId);
  }

  /**
   * Realm-opaque public label of a VirtualFS workspace key (Wave I, ticket
   * d57cbc1): a canonical identity key projects to its bare agent id, every
   * other reserved realm-global partition key projects to the shared `global`
   * label, and ordinary keys (legacy bare ids, explicit pins, `global`) pass
   * through verbatim. Host projections keep internal storage keys; every
   * user-visible workspace list goes through here.
   *
   * @param workspaceId - Internal workspace key.
   * @returns Bare/public workspace label.
   */
  #publicWorkspaceKey(workspaceId: string): string {
    if (!workspaceId || typeof workspaceId !== 'string') return workspaceId;
    const identityPort = this.#identityPort;
    if (identityPort && typeof identityPort.listAgentIdentities === 'function') {
      try {
        for (const projection of identityPort.listAgentIdentities()) {
          if (!projection || projection.key !== workspaceId) continue;
          if (typeof projection.id === 'string' && projection.id) return projection.id;
        }
      } catch {
        /* Fall through to the literal key. */
      }
    }
    if (workspaceId !== 'global' && workspaceId !== 'public' && isReservedWorkspaceKey(workspaceId)) return 'global';
    return workspaceId;
  }

  /**
   * Internal VirtualFS snapshot key addressed by a public workspace label
   * (Wave I, ticket d57cbc1): the unique agent's canonical storage key when the
   * snapshot carries it, else the label verbatim (legacy bare and pinned
   * workspaces keep working unchanged).
   *
   * @param publicLabel - Public workspace label (`allWorkspaces` entry).
   * @returns Internal snapshot key to read.
   */
  #resolveFsSnapshotKey(publicLabel: string): string {
    const projection = this.#resolveUniqueAgentProjection(publicLabel);
    const canonicalKey = projection && typeof projection.key === 'string' && projection.key ? projection.key : null;
    if (canonicalKey && canonicalKey !== publicLabel && this.fsSnapshot[canonicalKey]) return canonicalKey;
    return publicLabel;
  }

  /**
   * File count of one operator partition key (ticket 7571ce5): the number of
   * entries in the snapshot container addressed by the internal key itself,
   * never the count of a projected label.
   *
   * @param workspaceKey - Internal VirtualFS snapshot key.
   * @returns File count of the resolved partition.
   */
  #fsPartitionFileCount(workspaceKey: string): number {
    const container = this.fsSnapshot[workspaceKey];
    return container && typeof container === 'object' ? Object.keys(container).length : 0;
  }

  /**
   * Registered Realm display name of one realm id (ticket 7571ce5), falling
   * back to the raw id when the registry no longer carries a record.
   *
   * @param realmId - Realm id.
   * @returns Display name, or the raw realm id.
   */
  #realmDisplayName(realmId: string): string {
    const record = this.realms.find((realm) => realm.id === realmId);
    return record && typeof record.name === 'string' && record.name ? record.name : realmId;
  }

  /**
   * Trimmed Realm membership of an identity projection, or `null` when the
   * registration is ungrouped/system-scope (ticket 7571ce5).
   *
   * @param projection - Frozen identity projection.
   * @returns Realm id, or `null`.
   */
  #projectionRealmId(projection: AgentIdentityProjection): string | null {
    const raw = typeof projection.realmId === 'string' ? projection.realmId.trim() : '';
    return raw || null;
  }

  /**
   * Operator display label of one active registration's partition (ticket
   * 7571ce5): realm-qualified (`<realmName> · <agentId>`) for a Realm-bound
   * registration, the bare agent id otherwise. Two same-id registrations in
   * different Realms therefore never share a pill label.
   *
   * @param projection - Frozen identity projection.
   * @returns Realm-qualified display label.
   */
  #agentPartitionLabel(projection: AgentIdentityProjection): string {
    const realmId = this.#projectionRealmId(projection);
    return realmId ? `${this.#realmDisplayName(realmId)} · ${projection.id}` : projection.id;
  }

  /**
   * Realm id encoded in a realm-global partition key
   * (`realm:<realmId>:global`, the VirtualFS alias convention), or `null` for
   * every other key (ticket 7571ce5).
   *
   * @param workspaceKey - Candidate internal workspace key.
   * @returns Realm id, or `null`.
   */
  #realmGlobalPartitionRealmId(workspaceKey: string): string | null {
    const prefix = 'realm:';
    const suffix = ':global';
    if (!workspaceKey.startsWith(prefix) || !workspaceKey.endsWith(suffix)) return null;
    const realmId = workspaceKey.slice(prefix.length, workspaceKey.length - suffix.length);
    return realmId || null;
  }

  /**
   * Clock/event partition key a bare agent ref addresses (Wave I, ticket
   * d57cbc1): the canonical identity key once the runtime keys substrate state
   * canonically, the legacy bare id otherwise. The synced clock snapshot is
   * checked first (an existing partition is never split), then the bus
   * registration form is used as the transition probe; a bare id that does not
   * resolve uniquely keeps the legacy bare form.
   *
   * @param agentId - Realm-local agent id (or a non-agent partition label).
   * @returns Partition key to address.
   */
  #agentPartitionKey(agentId: string): string {
    const canonicalKey = this.#canonicalAgentKeyFor(agentId);
    if (!canonicalKey || canonicalKey === agentId) return agentId;
    if (this.clockSnapshot[canonicalKey]) return canonicalKey;
    if (this.clockSnapshot[agentId]) return agentId;
    try {
      if (this.#messagingBus && typeof this.#messagingBus.isRegistered === 'function' && this.#messagingBus.isRegistered(canonicalKey)) {
        return canonicalKey;
      }
    } catch {
      /* Fall back to the legacy bare form. */
    }
    return agentId;
  }

  /**
   * Trusted agent-scoped clock context for a bare agent ref (Wave I, ticket
   * d57cbc1): forwards the resolved canonical `callerKey` once the runtime
   * keys substrate state canonically, so the clock resolves the caller's own
   * partition exactly; before the wiring flip the legacy bare channel is kept
   * (the clock derives the canonical key from the port itself). Operator/host
   * contexts stay principal-only; agent-scoped targets resolve through
   * `#clockAuthorityContext` separately.
   *
   * @param agentId - Realm-local agent id.
   * @returns Agent-scoped execution context (never a principal context).
   */
  #agentScopedClockContext(agentId: string): { callerAgentId: string; callerKey?: string } {
    const partitionKey = this.#agentPartitionKey(agentId);
    const canonicalKey = this.#canonicalAgentKeyFor(agentId);
    if (canonicalKey && partitionKey === canonicalKey) {
      return { callerAgentId: partitionKey, callerKey: canonicalKey };
    }
    return { callerAgentId: partitionKey };
  }

  /**
   * Authority context for agent-scoped lifecycle primitives (restore/unstick/
   * cancel): the operator principal by exact reference. Sudoer-only operations
   * (purge/emptyRecycleBin/cancelAll) use `#operatorContext()` directly; both
   * resolve the same host principal, which exists with zero agents.
   *
   * @param _targetId - Unused legacy fallback (the principal is always present).
   * @returns Lifecycle authority context for the requested operation.
   */
  #lifecycleAuthorityContext(_targetId: string | null): { principal: InternalPrincipal } {
    return this.#operatorContext();
  }

  /**
   * Clock/event authority for a target partition: the operator principal by
   * exact reference (cross-partition authority), which exists with zero
   * agents. Wave I (ticket d57cbc1): when the target names a realm-unique
   * agent and the runtime already keys substrate state canonically, the
   * resolved canonical `callerKey` rides along so the clock identifies the
   * exact realm-local partition; before that flip the context stays
   * principal-only and byte-compatible with the legacy bare-id keying.
   *
   * @param targetId - Target partition label (agent id or non-agent label).
   * @returns Clock authority context for the requested partition.
   */
  #clockAuthorityContext(targetId: string): { principal: InternalPrincipal; callerAgentId?: string; callerKey?: string } {
    const canonicalKey = this.#canonicalAgentKeyFor(targetId);
    if (canonicalKey && canonicalKey !== targetId && this.#agentPartitionKey(targetId) === canonicalKey) {
      return { ...this.#operatorSubstrateContext(), callerAgentId: targetId, callerKey: canonicalKey };
    }
    return this.#operatorSubstrateContext();
  }

  /**
   * Schedules a debounced snapshot save to storage. The hydration suppression
   * guard makes load-time adapter/pointer writes inert: during
   * `hydrateFromStorage` no scheduled save may fire, so a failed restore cannot
   * overwrite the raw persisted bytes and a successful one cannot rewrite them.
   */
  #scheduleAutoSave(): void {
    if (this.#hydrating) return;
    if (this.#debouncedSave) {
      this.#debouncedSave.schedule(() => this.serialize());
    }
  }

  /**
   * Seeds the snapshot-backed MOD-20 preset fields (active pointer plus custom
   * entries) from persisted storage before the catalog is constructed. Only an
   * auto-hydrating store reads storage here; absent or unreadable state leaves
   * the seed-only catalog. The recovery notice is raised here because the later
   * hydrate pass observes the already-quarantined entry.
   */
  #loadPersistedPresetFields(): void {
    try {
      const persisted = loadSandboxState({
        onRecovery: (info) => {
          this.hydrationNotice = {
            message: 'Saved session could not be loaded — starting fresh',
            at: Date.now(),
            reason: info?.reason || 'unreadable'
          };
        }
      });
      if (!persisted) return;
      if (typeof persisted.activePresetId === 'string' && persisted.activePresetId.trim()) {
        this.#activePresetId = persisted.activePresetId.trim();
      }
      if (Array.isArray(persisted.customPresets)) {
        this.#customPresets = persisted.customPresets
          .filter(isModelPresetShape)
          .map((preset) => cloneModelPreset(preset));
      }
    } catch {
      // Preset seeding is best-effort; the seed-only catalog stays usable.
    }
  }

  /**
   * Seeds the snapshot-backed realm mirror from persisted storage before the
   * registry is constructed. Only an auto-hydrating store reads storage here;
   * absent or unreadable state leaves the empty registry unchanged. The
   * recovery notice is raised here because the later hydrate pass observes the
   * already-quarantined entry.
   */
  #loadPersistedRealmFields(): void {
    try {
      const persisted = loadSandboxState({
        onRecovery: (info) => {
          this.hydrationNotice = {
            message: 'Saved session could not be loaded — starting fresh',
            at: Date.now(),
            reason: info?.reason || 'unreadable'
          };
        }
      });
      if (!persisted) return;
      if (Array.isArray(persisted.realms)) {
        this.#realmRecords = persisted.realms
          .filter(isRealmRecordShape)
          .map((realm) => cloneRealmRecord(realm));
      }
    } catch {
      // Realm seeding is best-effort; the empty registry stays usable.
    }
  }

  /**
   * Seeds the snapshot-backed extension install mirror from persisted storage
   * before the extension registry is constructed. Only an auto-hydrating store
   * reads storage here; absent or unreadable state leaves the empty registry
   * unchanged, and the registry drops malformed entries on load. Nothing
   * connects: seeding restores records only.
   */
  #loadPersistedExtensionFields(): void {
    try {
      const persisted = loadSandboxState({
        onRecovery: (info) => {
          this.hydrationNotice = {
            message: 'Saved session could not be loaded — starting fresh',
            at: Date.now(),
            reason: info?.reason || 'unreadable'
          };
        }
      });
      if (!persisted) return;
      if (Array.isArray(persisted.extensions)) {
        this.#extensionRecords = persisted.extensions.map((record) => cloneExtensionInstallRecord(record));
      }
    } catch {
      // Extension seeding is best-effort; the empty registry stays usable.
    }
  }

  /**
   * Seeds the runtime template-import mirror from persisted storage before the
   * effective catalog is resolved. Only an auto-hydrating store reads storage
   * here; absent or unreadable state leaves the shipped catalog unchanged. The
   * recovery notice is raised here because the later hydrate pass observes the
   * already-quarantined entry.
   */
  #loadPersistedRealmTemplateFields(): void {
    try {
      const persisted = loadSandboxState({
        onRecovery: (info) => {
          this.hydrationNotice = {
            message: 'Saved session could not be loaded — starting fresh',
            at: Date.now(),
            reason: info?.reason || 'unreadable'
          };
        }
      });
      if (!persisted) return;
      this.#reconcileRealmTemplateImports(persisted);
      // Wave U (ticket 2518510): the persisted operator trust record seeds the
      // launch auto-approval surface before any launch can read it. Structurally
      // invalid entries were already rejected by the snapshot validator.
      this.#seedTemplateAuthorityTrustFrom(persisted);
    } catch {
      // Import seeding is best-effort; the shipped catalog stays usable.
    }
  }

  /**
   * Rebuilds the in-memory template-import registry from a persisted snapshot
   * (or clears it on reset). Every entry is re-parsed through the catalog (the
   * payload is the canonical transport JSON written at import time), matched
   * against its recorded id, and re-checked against the byte budget; entries
   * that do not parse or exceed a cap are dropped fail-closed so a hostile or
   * corrupt snapshot can never widen the effective catalog. Duplicate ids
   * resolve last-wins in place, exactly like import order.
   *
   * @param persisted - Snapshot whose import topology wins, or null to drop every import.
   */
  #reconcileRealmTemplateImports(persisted: SandboxPersistedState | null): void {
    const imports: Map<string, RealmTemplateImportRecord> = new Map();
    if (persisted && Array.isArray(persisted.importedRealmTemplates)) {
      let totalBytes = 0;
      for (const candidate of persisted.importedRealmTemplates) {
        if (!candidate || typeof candidate !== 'object') continue;
        const id = typeof candidate.id === 'string' && candidate.id.trim().length > 0 ? candidate.id : '';
        const payload = typeof candidate.payload === 'string' ? candidate.payload : '';
        if (!id || !payload) continue;
        let parsed: ReturnType<typeof parseTemplateBundle>;
        try {
          parsed = parseTemplateBundle(payload);
        } catch {
          continue; // Malformed payload: drop the import, keep the shipped catalog.
        }
        if (parsed.template.id !== id) continue; // Id/payload mismatch: fail closed.
        const bytes = utf8ByteLength(payload);
        if (bytes > REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES) continue;
        if (totalBytes + bytes > REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES) continue;
        totalBytes += bytes;
        imports.set(id, Object.freeze({
          bundle: Object.freeze({ template: parsed.template, files: parsed.files }),
          payload,
          version: parsed.version,
          bytes
        }));
      }
    }
    this.#realmTemplateImports = imports;
    this.#resolveRealmTemplateCatalog();
  }

  /**
   * Builds the frozen Wave U host publishing port over the store's own
   * surfaces (ticket 2518510): the real Wave T import path (mutating and
   * preview variants share one pipeline), effective-catalog resolution with
   * the canonical content version, and the session candidate store.
   *
   * @returns The frozen publishing port.
   */
  // ==========================================================================
  // Realm Admin Port (M3 meta plane, ticket 094de1b)
  // ==========================================================================

  /**
   * Builds the frozen M3 realm-admin port over the store's own surfaces: the
   * realm registry, the extension install/attachment/live-connection state,
   * and the runtime rosters. The port resolves the caller's exact grant scope
   * registry-side from the dispatcher-pinned actor reference (never a caller
   * claim), mutates only through the existing attach/ceiling + safe-state
   * sweep internals, and attributes every audit event to the actor id (R6).
   *
   * @returns The frozen realm-admin port.
   */
  #createRealmAdminPort(): RealmAdminPort {
    return Object.freeze({
      inspectRealm: (input: { actorRef: string | null; realmLabel: string | null }) => this.#inspectRealmForAdmin(input),
      updateRealm: (input: { actorRef: string | null; realmLabel: string | null; patch: RealmAdminPatch }) =>
        this.#updateRealmForAdmin(input),
      listExtensions: (input: { actorRef: string | null }) => this.#listExtensionsForAdmin(input),
      attachExtension: (input: {
        actorRef: string | null;
        extensionId: string;
        toolSelection?: RealmAdminToolSelection;
      }) => this.#attachExtensionForAdmin(input)
    });
  }

  /**
   * Resolves the registry-side realm-admin scope for one actor, or throws the
   * operation's uniform denial. The verdict stays dispatcher-side; this check
   * only guarantees that a direct port call can never run without a matching
   * active grant record and that the scope bounds the target.
   *
   * @param actorRef - Dispatcher-pinned actor reference (canonical key or bare id).
   * @param authorityId - Exact realm-class authority id.
   * @param denialMessage - The operation's uniform static denial message.
   * @returns The resolved scope.
   * @throws `Error` - Code `'PERMISSION_DENIED'`.
   */
  #resolveRealmAdminScopeOrDeny(
    actorRef: string | null,
    authorityId: string,
    denialMessage: string
  ): NonNullable<ReturnType<AgentRuntime['resolveRealmAdminScope']>> {
    const actor = typeof actorRef === 'string' && actorRef ? actorRef : null;
    const scope = actor ? this.#runtime.resolveRealmAdminScope(actor, authorityId) : null;
    if (!scope) throw realmAdminCodedError(denialMessage, 'PERMISSION_DENIED');
    return scope;
  }

  /**
   * Resolves the addressed realm within the grant's candidate set: omitted or
   * blank label means the actor's own realm (which must be inside the
   * candidate set), an explicit label must match exactly one candidate realm
   * display label. Zero or ambiguous matches throw the uniform denial, so no
   * realm-existence or scope oracle exists.
   *
   * @param scope - Resolved grant scope.
   * @param realmLabel - Caller-supplied display label, or `null` for own realm.
   * @param denialMessage - The operation's uniform static denial message.
   * @returns The resolved frozen realm record.
   * @throws `Error` - Code `'PERMISSION_DENIED'`.
   */
  #resolveRealmAdminRealm(
    scope: { readonly realmId: string | null; readonly candidateRealmIds: readonly string[] },
    realmLabel: string | null,
    denialMessage: string
  ): RealmRecord {
    const label = typeof realmLabel === 'string' && realmLabel.trim() ? realmLabel.trim() : null;
    let realmId: string | null = null;
    if (label === null) {
      if (scope.realmId) {
        for (let i = 0; i < scope.candidateRealmIds.length; i++) {
          if (scope.candidateRealmIds[i] === scope.realmId) {
            realmId = scope.realmId;
            break;
          }
        }
      }
    } else {
      const matches: string[] = [];
      for (let i = 0; i < scope.candidateRealmIds.length; i++) {
        const candidate = this.#realmRegistry.getRealm(scope.candidateRealmIds[i]);
        if (candidate && candidate.name === label) matches[matches.length] = candidate.id;
      }
      if (matches.length === 1) realmId = matches[0];
    }
    const realm = realmId ? this.#realmRegistry.getRealm(realmId) : null;
    if (!realm) throw realmAdminCodedError(denialMessage, 'PERMISSION_DENIED');
    return realm;
  }

  /**
   * Builds the bounded realm inspection receipt (spec §4.2): label-only realm
   * metadata, the realm-exact member roster with effective capability,
   * attachments with ceiling + live connection state, launch provenance, and
   * the missing-extension disclosure. No realm ids, transport URLs, or
   * credential material.
   *
   * @param realm - Resolved realm record.
   * @returns The frozen bounded projection.
   */
  #buildRealmAdminInspectReceipt(realm: RealmRecord): RealmInspectReceipt {
    const members: RealmAdminMemberView[] = [];
    const allAgents = this.#runtime.listAgents();
    for (let i = 0; i < allAgents.length; i++) {
      const member = allAgents[i];
      if (resolveMemberRealmId(member) !== realm.id) continue;
      members[members.length] = this.#projectRealmAdminMember(member);
    }
    const attachments: RealmAdminAttachmentView[] = [];
    const realmAttachments = realm.extensions ?? [];
    for (let i = 0; i < realmAttachments.length; i++) {
      attachments[attachments.length] = this.#projectRealmAdminAttachment(realmAttachments[i]);
    }
    const missingExtensions: string[] = [];
    const provenance = realm.instance ? this.#projectRealmAdminProvenance(realm.instance) : null;
    if (provenance && provenance.missingExtensions) {
      for (let i = 0; i < provenance.missingExtensions.length; i++) {
        if (!missingExtensions.includes(provenance.missingExtensions[i])) {
          missingExtensions[missingExtensions.length] = provenance.missingExtensions[i];
        }
      }
    }
    // An attachment whose install record disappeared is disclosed too: the
    // stored record survives but its tools are unavailable until reinstalled.
    for (let i = 0; i < realmAttachments.length; i++) {
      const extensionId = realmAttachments[i].extensionId;
      if (this.#extensionRegistry.getExtension(extensionId)) continue;
      if (!missingExtensions.includes(extensionId)) missingExtensions[missingExtensions.length] = extensionId;
    }
    const receipt: {
      success: true;
      realm: { label: string; createdAt: number; memberCount: number };
      members: readonly RealmAdminMemberView[];
      attachments: readonly RealmAdminAttachmentView[];
      provenance?: RealmAdminProvenanceView;
      disclosure: { missingExtensions: readonly string[] };
    } = {
      success: true,
      realm: { label: realm.name, createdAt: realm.createdAt, memberCount: members.length },
      members: Object.freeze(members),
      attachments: Object.freeze(attachments),
      disclosure: Object.freeze({ missingExtensions: Object.freeze(missingExtensions) })
    };
    if (provenance) receipt.provenance = provenance;
    return Object.freeze(receipt) as RealmInspectReceipt;
  }

  /**
   * Projects one realm member onto the bounded roster view: bare id/name/role/
   * state, effective privilege, effective baked tools (authority ids stripped)
   * plus granted extension call names, the realm-opaque parent reference, the
   * masked workspace label, and the turn count.
   *
   * @param member - Active agent record.
   * @returns The frozen member view.
   */
  #projectRealmAdminMember(member: Agent): RealmAdminMemberView {
    const config = (member.config || {}) as unknown as Record<string, unknown>;
    const rawRealm = typeof config.realmId === 'string' && config.realmId ? config.realmId : null;
    const identityKey = createAgentIdentityKey(rawRealm, member.id);
    const identity = this.#identityPort ? this.#identityPort.getAgentIdentity(identityKey) : null;
    const descriptor = identity ? identity.authority : null;
    const baked: string[] = [];
    const seen = new Set<string>();
    if (descriptor && descriptor.allow && typeof descriptor.allow.has === 'function') {
      if (descriptor.allow.has('*')) {
        baked[baked.length] = '*';
      } else {
        for (const entry of descriptor.allow) {
          if (typeof entry !== 'string' || !entry || entry === '*') continue;
          if (AUTHORITY_ID_SET.has(entry) || seen.has(entry)) continue;
          seen.add(entry);
          baked[baked.length] = entry;
        }
      }
    }
    const extensions: string[] = [];
    if (descriptor) {
      for (const name of descriptor.extensions) extensions[extensions.length] = name;
    }
    const privileged = Boolean(identity && identity.privileged === true)
      || Boolean(descriptor && descriptor.allow.has('*'));
    const view: {
      id: string;
      name: string;
      role: string;
      state: string;
      privileged: boolean;
      tools: { baked: readonly string[]; extensions: readonly string[] };
      parent?: string | null;
      workspace?: string;
      turns: number;
    } = {
      id: member.id,
      name: (typeof member.name === 'string' && member.name)
        || (typeof config.name === 'string' && config.name)
        || member.id,
      role: (typeof config.role === 'string' && config.role) || (privileged ? 'admin' : 'user'),
      state: member.state,
      privileged,
      tools: { baked: Object.freeze(baked), extensions: Object.freeze(extensions) },
      turns: typeof member.turnCount === 'number' ? member.turnCount : 0
    };
    const parent = toAgentVisibleAgentReference(config.spawnedBy || config.creatorId || null);
    if (parent) view.parent = parent;
    const rawWorkspace = typeof config.workspaceId === 'string' && config.workspaceId ? config.workspaceId : member.id;
    const workspace = toAgentVisibleWorkspaceKey(rawWorkspace);
    if (workspace) view.workspace = workspace;
    return Object.freeze(view) as RealmAdminMemberView;
  }

  /**
   * Projects one realm attachment onto the bounded view: install display
   * metadata, stored status, ceiling, live connection state (connected /
   * disconnected / conflict / error / unavailable), and the ids it currently
   * conflicts with. Never the transport URL, credential id, or raw catalog.
   *
   * @param attachment - Realm attachment record.
   * @returns The frozen attachment view.
   */
  #projectRealmAdminAttachment(attachment: RealmExtensionAttachment): RealmAdminAttachmentView {
    const install = this.#extensionRegistry.getExtension(attachment.extensionId);
    const entry = this.#extensionConnections.get(attachment.extensionId);
    let live: RealmAdminAttachmentView['live'];
    if (!install) {
      live = 'unavailable';
    } else if (entry && entry.status === 'connected' && entry.conflicts.length === 0 && entry.catalog) {
      live = 'connected';
    } else if (entry && entry.status === 'conflict') {
      live = 'conflict';
    } else if (entry && entry.status === 'error') {
      live = 'error';
    } else if (entry && entry.status === 'connecting') {
      live = 'disconnected';
    } else if (this.#extensionDisconnected.has(attachment.extensionId)) {
      live = 'disconnected';
    } else if (attachment.status === 'conflict') {
      live = 'conflict';
    } else if (attachment.status === 'unavailable') {
      live = 'unavailable';
    } else {
      live = 'disconnected';
    }
    const view: {
      extensionId: string;
      displayName?: string;
      kind: string;
      status: RealmAdminAttachmentView['status'];
      toolSelection: RealmAdminToolSelection;
      live: RealmAdminAttachmentView['live'];
      conflictWith?: readonly string[];
    } = {
      extensionId: attachment.extensionId,
      kind: install ? install.kind : 'unknown',
      status: attachment.status,
      toolSelection: attachment.toolSelection,
      live
    };
    if (install && install.displayName) view.displayName = install.displayName;
    if (entry && entry.conflicts.length > 0) {
      const conflictedWith: string[] = [];
      for (let i = 0; i < entry.conflicts.length; i++) {
        const other = entry.conflicts[i].otherExtensionId;
        if (typeof other === 'string' && other && !conflictedWith.includes(other)) {
          conflictedWith[conflictedWith.length] = other;
        }
      }
      if (conflictedWith.length > 0) view.conflictWith = Object.freeze(conflictedWith);
    }
    return Object.freeze(view) as RealmAdminAttachmentView;
  }

  /**
   * Projects one realm launch provenance record (hashes and paths only; the
   * record already carries no raw input values).
   *
   * @param instance - Realm instance provenance.
   * @returns The frozen provenance view.
   */
  #projectRealmAdminProvenance(instance: RealmInstanceProvenance): RealmAdminProvenanceView {
    const view: {
      templateId: string;
      templateVersion: string;
      packageDigest?: string;
      inputHashes: Readonly<Record<string, string>>;
      seedPaths: readonly string[];
      launchedAt: string;
      resolvedTools?: Readonly<Record<string, string>>;
      missingExtensions?: readonly string[];
    } = {
      templateId: instance.templateId,
      templateVersion: instance.templateVersion,
      inputHashes: Object.freeze({ ...(instance.inputHashes || {}) }),
      seedPaths: Object.freeze([...(instance.seedPaths || [])]),
      launchedAt: instance.launchedAt
    };
    if (instance.packageDigest) view.packageDigest = instance.packageDigest;
    if (instance.resolvedTools) view.resolvedTools = Object.freeze({ ...instance.resolvedTools });
    if (instance.missingExtensions) view.missingExtensions = Object.freeze([...instance.missingExtensions]);
    return Object.freeze(view) as RealmAdminProvenanceView;
  }

  /**
   * Builds the label-only realm summary used by the update receipt's
   * before/after pair (display metadata plus attachment ids and ceilings).
   *
   * @param realm - Realm record.
   * @returns The frozen summary.
   */
  #realmAdminSummary(realm: RealmRecord): RealmAdminRealmSummary {
    const attachments: Array<{ extensionId: string; toolSelection: RealmAdminToolSelection }> = [];
    const realmAttachments = realm.extensions ?? [];
    for (let i = 0; i < realmAttachments.length; i++) {
      attachments[attachments.length] = Object.freeze({
        extensionId: realmAttachments[i].extensionId,
        toolSelection: realmAttachments[i].toolSelection
      });
    }
    const summary: {
      name: string;
      description?: string | null;
      color?: string | null;
      attachments: readonly { extensionId: string; toolSelection: RealmAdminToolSelection }[];
    } = {
      name: realm.name,
      attachments: Object.freeze(attachments)
    };
    if (realm.description !== undefined) summary.description = realm.description;
    if (realm.color !== undefined) summary.color = realm.color;
    return Object.freeze(summary) as RealmAdminRealmSummary;
  }

  /**
   * Reads and validates one realm-admin update patch (port-side re-validation;
   * the tool boundary already scanned top-level and nested keys): denied keys
   * throw the uniform bound denial, unknown top-level or nested keys or
   * malformed values throw `INVALID_ARGUMENTS`, and the requested field tokens
   * are returned in patch declaration order.
   *
   * @param patch - Caller-supplied patch.
   * @returns The frozen patch snapshot with its requested field tokens.
   * @throws `Error` - Code `'PERMISSION_DENIED'` or `'INVALID_ARGUMENTS'`.
   */
  #normalizeRealmAdminPatch(patch: unknown): {
    readonly update: RealmAdminPatch;
    readonly fields: readonly string[];
  } {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw realmAdminCodedError('update_realm requires a patch object with at least one editable field.', 'INVALID_ARGUMENTS');
    }
    const snapshot = { ...(patch as Record<string, unknown>) };
    const keys = Object.keys(snapshot);
    if (keys.length === 0) {
      throw realmAdminCodedError('update_realm requires a patch object with at least one editable field.', 'INVALID_ARGUMENTS');
    }
    for (let i = 0; i < keys.length; i++) {
      if (isDeniedRealmAdminPatchKey(keys[i])) {
        throw realmAdminCodedError(REALM_ADMIN_EDIT_BOUND_DENIED_MESSAGE, 'PERMISSION_DENIED');
      }
    }
    const fields: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const token = REALM_ADMIN_PATCH_FIELD_TOKENS[keys[i]];
      if (!token) {
        throw realmAdminCodedError('update_realm does not accept unknown fields.', 'INVALID_ARGUMENTS');
      }
      fields[fields.length] = token;
    }
    assertRealmAdminNestedPatchKeys(snapshot);
    const update: Record<string, unknown> = {};
    if (snapshot.name !== undefined) {
      if (typeof snapshot.name !== 'string' || !snapshot.name.trim()) {
        throw realmAdminCodedError("update_realm: 'name' must be a non-empty string.", 'INVALID_ARGUMENTS');
      }
      update.name = snapshot.name.trim();
    }
    for (const key of ['description', 'color']) {
      const value = snapshot[key];
      if (value === undefined) continue;
      if (value !== null && typeof value !== 'string') {
        throw realmAdminCodedError(`update_realm: '${key}' must be a string or null.`, 'INVALID_ARGUMENTS');
      }
      update[key] = value;
    }
    if (snapshot.attach !== undefined) {
      const attach = snapshot.attach;
      if (!attach || typeof attach !== 'object' || Array.isArray(attach)) {
        throw realmAdminCodedError("update_realm: 'attach' must be an object.", 'INVALID_ARGUMENTS');
      }
      const attachRecord = attach as Record<string, unknown>;
      const extensionId = typeof attachRecord.extensionId === 'string' ? attachRecord.extensionId.trim() : '';
      if (!extensionId) {
        throw realmAdminCodedError("update_realm: 'attach.extensionId' must be a non-empty string.", 'INVALID_ARGUMENTS');
      }
      const entry: { extensionId: string; toolSelection?: 'all' | readonly string[] } = { extensionId };
      if (attachRecord.toolSelection !== undefined) {
        entry.toolSelection = normalizeRealmAdminSelection(attachRecord.toolSelection);
      }
      update.attach = Object.freeze(entry);
    }
    if (snapshot.toolSelection !== undefined) {
      const ceiling = snapshot.toolSelection;
      if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling)) {
        throw realmAdminCodedError("update_realm: 'toolSelection' must be an object.", 'INVALID_ARGUMENTS');
      }
      const ceilingRecord = ceiling as Record<string, unknown>;
      const extensionId = typeof ceilingRecord.extensionId === 'string' ? ceilingRecord.extensionId.trim() : '';
      if (!extensionId) {
        throw realmAdminCodedError("update_realm: 'toolSelection.extensionId' must be a non-empty string.", 'INVALID_ARGUMENTS');
      }
      if (ceilingRecord.selection === undefined) {
        throw realmAdminCodedError("update_realm: 'toolSelection.selection' is required.", 'INVALID_ARGUMENTS');
      }
      update.toolSelection = Object.freeze({
        extensionId,
        selection: normalizeRealmAdminSelection(ceilingRecord.selection)
      });
    }
    return { update: Object.freeze(update) as RealmAdminPatch, fields: Object.freeze(fields) };
  }

  /**
   * Inspects one realm under the caller's exact scoped `@realm:inspect`
   * grant: registry-side scope resolution, label resolution within the
   * candidate set, bounded projection, and the `realm_inspected` audit event
   * (bare actor id + display label only).
   *
   * @param input - Trusted port input.
   * @returns The frozen bounded inspection receipt.
   * @throws `Error` - Code `'PERMISSION_DENIED'` for every resolution failure.
   */
  #inspectRealmForAdmin(input: { actorRef: string | null; realmLabel: string | null }): RealmInspectReceipt {
    const scope = this.#resolveRealmAdminScopeOrDeny(
      input?.actorRef ?? null,
      AGENT_AUTHORITIES.REALM_INSPECT,
      REALM_ADMIN_INSPECT_DENIED_MESSAGE
    );
    const realm = this.#resolveRealmAdminRealm(scope, input?.realmLabel ?? null, REALM_ADMIN_INSPECT_DENIED_MESSAGE);
    const receipt = this.#buildRealmAdminInspectReceipt(realm);
    this.#emitExtensionAuditEvent('realm_inspected', { actorId: scope.actorId, realmLabel: realm.name });
    return receipt;
  }

  /**
   * Applies one realm edit under the caller's exact scoped `@realm:edit`
   * grant: scope + label resolution, closed patch validation, field-token
   * bound, complete pre-validation of every attach/ceiling precondition
   * (installed + connected + live-catalog selection) before any mutation, then
   * the metadata / attach / ceiling writes through the existing internals. The
   * `realm_updated` audit event carries the bare actor id, the resulting
   * label, the field tokens, and label-only before/after summaries.
   *
   * @param input - Trusted port input.
   * @returns The frozen update receipt.
   * @throws `Error` - Code `'PERMISSION_DENIED'` for resolution/bound failures, `'INVALID_ARGUMENTS'` for malformed patches or live-catalog violations.
   */
  #updateRealmForAdmin(input: {
    actorRef: string | null;
    realmLabel: string | null;
    patch: RealmAdminPatch;
  }): RealmUpdateReceipt {
    const scope = this.#resolveRealmAdminScopeOrDeny(
      input?.actorRef ?? null,
      AGENT_AUTHORITIES.REALM_EDIT,
      REALM_ADMIN_EDIT_DENIED_MESSAGE
    );
    const realm = this.#resolveRealmAdminRealm(scope, input?.realmLabel ?? null, REALM_ADMIN_EDIT_DENIED_MESSAGE);
    const { update, fields } = this.#normalizeRealmAdminPatch(input?.patch);
    for (let i = 0; i < fields.length; i++) {
      if (!scope.fields.includes(fields[i])) {
        throw realmAdminCodedError(REALM_ADMIN_EDIT_BOUND_DENIED_MESSAGE, 'PERMISSION_DENIED');
      }
    }
    // Complete pre-validation before any mutation: an attach requires the
    // extension installed and currently connected with its selection inside
    // the live catalog; a ceiling change requires the attachment to exist
    // with its selection inside the live catalog. Nothing is applied on a
    // single precondition failure.
    const existing = realm.extensions ?? [];
    if (update.attach) {
      const extensionId = update.attach.extensionId;
      if (!this.#extensionRegistry.getExtension(extensionId)) {
        throw realmAdminCodedError(
          `update_realm: extension '${extensionId}' is not installed.`,
          'INVALID_ARGUMENTS'
        );
      }
      const liveNames = this.#connectedExtensionCatalogCallNames(extensionId);
      if (!liveNames) {
        throw realmAdminCodedError(
          `update_realm: extension '${extensionId}' is not connected.`,
          'INVALID_ARGUMENTS'
        );
      }
      if (existing.some((attachment) => attachment.extensionId === extensionId)) {
        throw realmAdminCodedError(
          `update_realm: realm already attaches extension '${extensionId}'.`,
          'INVALID_ARGUMENTS'
        );
      }
      const selection = update.attach.toolSelection === undefined ? 'all' : update.attach.toolSelection;
      if (selection !== 'all') {
        for (let i = 0; i < selection.length; i++) {
          if (!liveNames.includes(selection[i])) {
            throw realmAdminCodedError(
              `update_realm: '${selection[i]}' is outside extension '${extensionId}' live catalog.`,
              'INVALID_ARGUMENTS'
            );
          }
        }
      }
    }
    if (update.toolSelection) {
      const extensionId = update.toolSelection.extensionId;
      if (!existing.some((attachment) => attachment.extensionId === extensionId)) {
        throw realmAdminCodedError(
          `update_realm: realm does not attach extension '${extensionId}'.`,
          'INVALID_ARGUMENTS'
        );
      }
      const selection = update.toolSelection.selection;
      if (selection !== 'all') {
        const liveNames = this.#connectedExtensionCatalogCallNames(extensionId);
        if (!liveNames) {
          throw realmAdminCodedError(
            `update_realm: extension '${extensionId}' is not connected; explicit call names cannot resolve.`,
            'INVALID_ARGUMENTS'
          );
        }
        for (let i = 0; i < selection.length; i++) {
          if (!liveNames.includes(selection[i])) {
            throw realmAdminCodedError(
              `update_realm: '${selection[i]}' is outside extension '${extensionId}' live catalog.`,
              'INVALID_ARGUMENTS'
            );
          }
        }
      }
    }

    const before = this.#realmAdminSummary(realm);
    const metadata: RealmUpdatePatch = {};
    if (update.name !== undefined) metadata.name = update.name;
    if (update.description !== undefined) metadata.description = update.description;
    if (update.color !== undefined) metadata.color = update.color;
    if (Object.keys(metadata).length > 0) {
      this.#realmRegistry.updateRealm(realm.id, metadata);
    }
    if (update.attach) {
      this.attachExtension(realm.id, update.attach.extensionId, {
        ...(update.attach.toolSelection !== undefined ? { toolSelection: update.attach.toolSelection } : {}),
        source: 'meta-realm-edit',
        actorId: scope.actorId
      });
    }
    if (update.toolSelection) {
      this.setExtensionToolSelection(realm.id, update.toolSelection.extensionId, update.toolSelection.selection, {
        source: 'meta-realm-edit',
        actorId: scope.actorId
      });
    }
    const updatedRealm = this.#realmRegistry.getRealm(realm.id) || realm;
    const after = this.#realmAdminSummary(updatedRealm);
    this.#emitExtensionAuditEvent('realm_updated', {
      actorId: scope.actorId,
      realmLabel: after.name,
      fields,
      before,
      after
    });
    return Object.freeze({
      success: true,
      realm: after.name,
      fields,
      applied: true,
      before,
      after
    }) as RealmUpdateReceipt;
  }

  /**
   * Lists the installed extensions and the caller realm's attachments under
   * the caller's exact scoped `@extensions:authority` grant (M4, ticket
   * a02bce7): registry-side scope + own-realm resolution, then a bounded
   * projection of the host install records (id/display name/kind/status/live/
   * attached) and the realm's attachments (the M3 view plus live call names).
   * The `extensions_inspected` audit event carries the bare actor id and the
   * display label only; transport URLs, credential ids, and realm ids never
   * appear.
   *
   * @param input - Trusted port input (dispatcher-pinned actor reference only).
   * @returns The frozen bounded listing receipt.
   * @throws `Error` - Code `'PERMISSION_DENIED'` for every resolution failure.
   */
  #listExtensionsForAdmin(input: { actorRef: string | null }): ExtensionsInspectReceipt {
    const scope = this.#resolveRealmAdminScopeOrDeny(
      input?.actorRef ?? null,
      AGENT_AUTHORITIES.EXTENSIONS,
      EXTENSIONS_ADMIN_DENIED_MESSAGE
    );
    const realm = this.#resolveRealmAdminRealm(scope, null, EXTENSIONS_ADMIN_DENIED_MESSAGE);
    const attachments = realm.extensions ?? [];
    const attachedIds = new Set<string>();
    for (let i = 0; i < attachments.length; i++) attachedIds.add(attachments[i].extensionId);
    const installed: ExtensionsAdminInstalledView[] = [];
    const records = this.#extensionRegistry.listExtensions();
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const names = this.#connectedExtensionCatalogCallNames(record.id);
      const view: {
        id: string;
        displayName?: string;
        kind: string;
        status: string;
        connected: boolean;
        attached: boolean;
        tools?: readonly string[];
      } = {
        id: record.id,
        kind: record.kind,
        status: record.status,
        connected: names !== null,
        attached: attachedIds.has(record.id)
      };
      if (record.displayName) view.displayName = record.displayName;
      if (names) view.tools = names;
      installed[installed.length] = Object.freeze(view) as ExtensionsAdminInstalledView;
    }
    const attachmentViews: ExtensionsAdminAttachmentView[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const base = this.#projectRealmAdminAttachment(attachments[i]);
      const names = this.#connectedExtensionCatalogCallNames(attachments[i].extensionId);
      attachmentViews[attachmentViews.length] = Object.freeze({
        ...base,
        ...(names ? { tools: names } : {})
      }) as ExtensionsAdminAttachmentView;
    }
    const receipt = Object.freeze({
      success: true,
      realm: realm.name,
      installed: Object.freeze(installed),
      attachments: Object.freeze(attachmentViews)
    }) as ExtensionsInspectReceipt;
    this.#emitExtensionAuditEvent('extensions_inspected', { actorId: scope.actorId, realmLabel: realm.name });
    return receipt;
  }

  /**
   * Attaches one installed+connected extension to the caller's realm under
   * the caller's exact scoped `@extensions:authority` grant (M4, ticket
   * a02bce7): registry-side scope + own-realm resolution, shape validation,
   * the installed+connected gates, the live-catalog selection bound, and —
   * when the realm already attaches the extension — an idempotent no-op
   * receipt (no mutation, no duplicate audit, the stored ceiling wins). A
   * fresh attach goes through the shared `attachExtension` internals with
   * `source:'privileged-agent'` + actor id and therefore follows the P2.4
   * member sweep. Never installs, dials, disconnects, detaches, or touches
   * credentials.
   *
   * @param input - Trusted port input (dispatcher-pinned actor reference, extension id, optional ceiling).
   * @returns The frozen attach receipt (`applied:false` on the idempotent path).
   * @throws `Error` - Code `'PERMISSION_DENIED'` for resolution failures, `'INVALID_ARGUMENTS'` for malformed inputs or gate failures.
   */
  #attachExtensionForAdmin(input: {
    actorRef: string | null;
    extensionId: string;
    toolSelection?: RealmAdminToolSelection;
  }): ExtensionAttachReceipt {
    const scope = this.#resolveRealmAdminScopeOrDeny(
      input?.actorRef ?? null,
      AGENT_AUTHORITIES.EXTENSIONS,
      EXTENSIONS_ADMIN_DENIED_MESSAGE
    );
    const realm = this.#resolveRealmAdminRealm(scope, null, EXTENSIONS_ADMIN_DENIED_MESSAGE);
    const rawExtensionId = input?.extensionId;
    if (typeof rawExtensionId !== 'string' || rawExtensionId.trim().length === 0) {
      throw realmAdminCodedError(
        "attach_extension: 'extensionId' is required and must be a non-empty string.",
        'INVALID_ARGUMENTS'
      );
    }
    const extensionId = rawExtensionId;
    let selection: 'all' | readonly string[];
    try {
      selection = input?.toolSelection === undefined ? 'all' : normalizeRealmAdminSelection(input.toolSelection);
    } catch (error) {
      throw realmAdminCodedError(
        `attach_extension: invalid tool selection — ${error instanceof Error ? error.message : String(error)}`,
        'INVALID_ARGUMENTS'
      );
    }
    if (!this.#extensionRegistry.getExtension(extensionId)) {
      throw realmAdminCodedError(`attach_extension: extension '${extensionId}' is not installed.`, 'INVALID_ARGUMENTS');
    }
    const liveNames = this.#connectedExtensionCatalogCallNames(extensionId);
    if (!liveNames) {
      throw realmAdminCodedError(`attach_extension: extension '${extensionId}' is not connected.`, 'INVALID_ARGUMENTS');
    }
    if (selection !== 'all') {
      for (let i = 0; i < selection.length; i++) {
        if (!liveNames.includes(selection[i])) {
          throw realmAdminCodedError(
            `attach_extension: '${selection[i]}' is outside extension '${extensionId}' live catalog.`,
            'INVALID_ARGUMENTS'
          );
        }
      }
    }
    const existing = (realm.extensions ?? []).find((attachment) => attachment.extensionId === extensionId);
    if (existing) {
      // Idempotent: the realm-wide uniform set already carries the extension.
      // No mutation, no duplicate audit, no sweep — the stored ceiling wins.
      return Object.freeze({
        success: true,
        realm: realm.name,
        extensionId,
        toolSelection: existing.toolSelection,
        applied: false,
        alreadyAttached: true
      }) as ExtensionAttachReceipt;
    }
    this.attachExtension(realm.id, extensionId, {
      toolSelection: selection,
      source: 'privileged-agent',
      actorId: scope.actorId
    });
    return Object.freeze({
      success: true,
      realm: realm.name,
      extensionId,
      toolSelection: selection,
      applied: true,
      alreadyAttached: false
    }) as ExtensionAttachReceipt;
  }

  #createRealmPublishingPort(): RealmPublishingPort {
    return Object.freeze({
      importTemplate: (canonicalPayload: string) => this.importRealmTemplate(canonicalPayload),
      previewTemplateImport: (canonicalPayload: string) => this.previewRealmTemplateImport(canonicalPayload),
      getEffectiveTemplateBundle: (templateId: string) => {
        if (typeof templateId !== 'string' || templateId.trim().length === 0) return null;
        const bundle = this.#authoredTemplateBundle(templateId);
        if (!bundle) return null;
        const version = this.#effectiveTemplateVersion(templateId);
        if (version === null) return null;
        // The port view predates the format-v2 migration (the publishing tools
        // lane migrates separately): shipped entries are authored format-v1
        // templates and keep working unchanged, while a format-v2 import is
        // passed through as its authored document and fails the tools'
        // format-v1 validation closed until they migrate.
        return Object.freeze({
          template: bundle.template as RealmTemplate,
          files: bundle.files,
          version
        });
      },
      storePendingInstancePayload: (candidate: PendingInstancePayload) => {
        this.#storePendingInstancePayload(candidate);
      },
      listEffectiveTemplates: () => this.#listEffectiveTemplateSummaries(),
      listPendingInstancePayloads: () => this.#listPendingInstancePayloadViews(),
      listSavedInstancePayloads: () => this.#listSavedInstancePayloadViews()
    });
  }

  /**
   * Projects the effective launch catalog into the bounded M5b template
   * summaries (id, name, effective version, description, exposed format
   * version, launchability). Never bundle bodies or host paths; a versionless
   * entry (malformed host injection) reports `version: null` and stays
   * non-launchable.
   *
   * @returns Frozen template summaries in effective catalog order.
   */
  #listEffectiveTemplateSummaries(): readonly RealmEffectiveTemplateSummary[] {
    const versions = new Map(
      this.listRealmTemplateSources().map((source) => [source.templateId, source.templateVersion] as const)
    );
    return Object.freeze(this.#realmTemplates.map((template) => {
      const version = versions.get(template.id) ?? null;
      return Object.freeze({
        templateId: template.id,
        name: template.name,
        version,
        description: template.description,
        formatVersion: template.formatVersion,
        launchable: version !== null && Array.isArray(template.agents) && template.agents.length > 0
      });
    }));
  }

  /**
   * Projects the session-only pending candidates into the bounded M5b digest
   * views (template id, pinned version, canonical payload digest, resolution
   * timestamp). A candidate whose payload cannot be digested is omitted rather
   * than reported with a fabricated digest.
   *
   * @returns Frozen pending-payload views in submission order.
   */
  #listPendingInstancePayloadViews(): readonly PendingInstancePayloadSummary[] {
    const views: PendingInstancePayloadSummary[] = [];
    for (const entry of this.#pendingInstancePayloads.values()) {
      try {
        views.push(Object.freeze({
          templateId: entry.templateId,
          templateVersion: entry.templateVersion,
          digest: payloadDigest(entry.payload),
          resolvedAt: entry.resolvedAt
        }));
      } catch {
        // A hostile direct-port candidate is omitted, never fabricated.
      }
    }
    return Object.freeze(views);
  }

  /**
   * Projects the saved hydration-payload library into the bounded M5b views
   * (library id/name, template binding, canonical digest, save timestamp).
   *
   * @returns Frozen saved-payload views in library order.
   */
  #listSavedInstancePayloadViews(): readonly SavedInstancePayloadSummary[] {
    return Object.freeze(this.#savedInstancePayloads.map((entry) => Object.freeze({
      id: entry.id,
      name: entry.name,
      templateId: entry.templateId,
      templateVersion: entry.templateVersion,
      digest: entry.digest,
      savedAt: entry.savedAt
    })));
  }

  /**
   * Validates and stores (or replaces) one session-only pending instance
   * payload for a template id (Wave U ticket 2518510).
   *
   * The candidate crosses the publishing port seam, so the shape is validated
   * fail-closed with `ERR_STORE_INVALID_PARAMS` before anything is stored. The
   * stored entry is frozen; nothing is persisted, and a reset clears it.
   *
   * @param candidate - Candidate produced by a validated submission.
   * @throws {@link SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS} When the candidate shape is malformed.
   */
  #storePendingInstancePayload(candidate: PendingInstancePayload): void {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw invalidRealmParams('storePendingInstancePayload requires a candidate object');
    }
    const templateId = typeof candidate.templateId === 'string' ? candidate.templateId.trim() : '';
    const templateVersion = typeof candidate.templateVersion === 'string' ? candidate.templateVersion.trim() : '';
    const resolvedAt = typeof candidate.resolvedAt === 'string' ? candidate.resolvedAt.trim() : '';
    const payload = candidate.payload;
    if (!templateId) {
      throw invalidRealmParams('storePendingInstancePayload requires a non-empty templateId');
    }
    if (!templateVersion) {
      throw invalidRealmParams('storePendingInstancePayload requires a non-empty templateVersion');
    }
    if (!resolvedAt) {
      throw invalidRealmParams('storePendingInstancePayload requires a non-empty resolvedAt');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw invalidRealmParams('storePendingInstancePayload requires an object payload');
    }
    this.#pendingInstancePayloads.set(templateId, Object.freeze({
      templateId,
      templateVersion,
      payload: Object.freeze({ ...(payload as Record<string, unknown>) }),
      resolvedAt
    }));
  }

  /**
   * Seeds the saved hydration-payload library from persisted storage before
   * any consumer reads it (ticket 81d8267). Only an auto-hydrating store reads
   * storage here; absent or unreadable state leaves the empty library
   * unchanged. The recovery notice is raised here because the later hydrate
   * pass observes the already-quarantined entry.
   */
  #loadPersistedSavedInstancePayloadFields(): void {
    try {
      const persisted = loadSandboxState({
        onRecovery: (info) => {
          this.hydrationNotice = {
            message: 'Saved session could not be loaded — starting fresh',
            at: Date.now(),
            reason: info?.reason || 'unreadable'
          };
        }
      });
      if (!persisted) return;
      this.#restoreSavedInstancePayloads(persisted);
    } catch {
      // Library seeding is best-effort; the empty library stays usable.
    }
  }

  /**
   * Rebuilds the in-memory saved-payload library from a persisted snapshot, or
   * clears it when `persisted` is `null` (ticket 81d8267). The snapshot is
   * authoritative: entries absent from it are pruned, and a legacy snapshot
   * without the field hydrates empty.
   *
   * Every candidate is re-checked defensively (own-property read, non-empty
   * string fields, plain-object payload, unique id and case-insensitive
   * unique name) and re-digested; a candidate that fails any check — or whose
   * payload is not plain finite JSON data — is dropped fail-closed, so a
   * hostile or corrupt snapshot can never widen or poison the library. The id
   * counter is seeded past the highest persisted `saved_payload_<n>` suffix so
   * later saves cannot collide with restored entries.
   *
   * @param persisted - Snapshot whose library wins, or null to drop every entry.
   */
  #restoreSavedInstancePayloads(persisted: SandboxPersistedState | null): void {
    const restored: SavedInstancePayload[] = [];
    const seenIds = new Set<string>();
    const seenNames = new Set<string>();
    let maxCounter = 0;
    const source = persisted && Object.prototype.hasOwnProperty.call(persisted, 'savedInstancePayloads')
      ? persisted.savedInstancePayloads
      : undefined;
    if (Array.isArray(source)) {
      for (const candidate of source) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const record = candidate as PersistedSavedInstancePayload;
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        const name = typeof record.name === 'string' ? record.name.trim() : '';
        const templateId = typeof record.templateId === 'string' ? record.templateId.trim() : '';
        const templateVersion = typeof record.templateVersion === 'string' ? record.templateVersion.trim() : '';
        const savedAt = typeof record.savedAt === 'string' ? record.savedAt.trim() : '';
        const payload = record.payload;
        if (!id || !name || !templateId || !templateVersion || !savedAt) continue;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
        if (seenIds.has(id) || seenNames.has(name.toLowerCase())) continue;
        let digest: string;
        try {
          digest = payloadDigest(payload);
        } catch {
          continue; // Not plain JSON data: drop the entry, keep the library.
        }
        seenIds.add(id);
        seenNames.add(name.toLowerCase());
        const counterMatch = /^saved_payload_(\d+)$/.exec(id);
        if (counterMatch) {
          maxCounter = Math.max(maxCounter, Number.parseInt(counterMatch[1], 10));
        }
        restored.push(Object.freeze({
          id,
          name,
          templateId,
          templateVersion,
          digest,
          payload: freezeSavedInstancePayloadValue(payload as Record<string, unknown>),
          savedAt
        }));
      }
    }
    this.#savedInstancePayloads = restored.slice(0, SAVED_INSTANCE_PAYLOAD_MAX_ENTRIES);
    this.#savedInstancePayloadCounter = maxCounter;
    this.#notifySavedInstancePayloads();
  }

  /**
   * Notifies every saved-payload library listener (ticket 81d8267). A failing
   * listener never blocks a mutation.
   */
  #notifySavedInstancePayloads(): void {
    for (const listener of [...this.#savedInstancePayloadListeners]) {
      try {
        listener();
      } catch {
        // A failing listener never blocks a library mutation.
      }
    }
  }

  /**
   * Seeds the in-memory per-template authority trust map from a persisted
   * snapshot (or clears it on reset), reading only own properties and dropping
   * every malformed entry fail-closed (ticket 2518510). The snapshot validator
   * has already rejected wrong-shaped records; the defensive reads here keep a
   * hostile object graph from smuggling a value through the prototype chain
   * (defect cc2b4e8): a prototype-carried record is never seeded.
   *
   * @param persisted - Snapshot whose trust record wins, or null to drop every record.
   */
  #seedTemplateAuthorityTrustFrom(persisted: SandboxPersistedState | null): void {
    const trust = new Map<string, Map<string, readonly string[]>>();
    const hasTrust = persisted
      && Object.prototype.hasOwnProperty.call(persisted, 'templateAuthorityTrust');
    const record = hasTrust
      && typeof persisted.templateAuthorityTrust === 'object'
      && persisted.templateAuthorityTrust !== null
      && !Array.isArray(persisted.templateAuthorityTrust)
      ? persisted.templateAuthorityTrust as Record<string, unknown>
      : null;
    if (record) {
      for (const templateId of Object.keys(record)) {
        if (typeof templateId !== 'string' || !templateId.trim()) continue;
        const agents = record[templateId];
        if (!agents || typeof agents !== 'object' || Array.isArray(agents)) continue;
        const agentMap = new Map<string, readonly string[]>();
        const agentRecord = agents as Record<string, unknown>;
        for (const agentKey of Object.keys(agentRecord)) {
          if (typeof agentKey !== 'string' || !agentKey.trim()) continue;
          const authorities = agentRecord[agentKey];
          if (!Array.isArray(authorities)) continue;
          const cleaned: string[] = [];
          for (const authority of authorities) {
            if (typeof authority !== 'string' || !authority.trim()) continue;
            if (!cleaned.includes(authority)) cleaned.push(authority);
          }
          if (cleaned.length > 0) agentMap.set(agentKey, Object.freeze(cleaned));
        }
        if (agentMap.size > 0) trust.set(templateId, agentMap);
      }
    }
    this.#templateAuthorityTrust = trust;
  }

  /**
   * Re-applies persisted authority grants after snapshot hydration (Wave U
   * ticket 2518510; M1 generic path), delegating to the runtime's
   * operator-gated `restoreAuthorityGrants`: only active agents are granted
   * and unknown authority ids plus unknown, recycled, or realm-ambiguous refs
   * are skipped fail-closed, so a tampered snapshot id can never mint a grant.
   *
   * Both fields are read as own properties only (defect cc2b4e8): a
   * prototype-carried grants record is ignored. The legacy
   * `metaAuthorityGrants` field maps its `template`/`hydration` partitions to
   * the publishing ids; the additive generic `authorityGrants` field carries
   * every other id, and a generic entry wins per id over a legacy entry for the
   * same id. An absent field leaves the grant lists empty, so legacy snapshots
   * hydrate unchanged.
   *
   * @param persisted - Restored snapshot carrying the additive grant fields (read-only).
   * @returns The refs the runtime actually restored, per authority id.
   */
  #restorePersistedAuthorityGrants(persisted: SandboxPersistedState): Record<string, string[]> {
    const merged: Record<string, (string | { ref: string; scope?: AuthorityScopeRecord })[]> = Object.create(null);
    const collect = (value: unknown): (string | { ref: string; scope?: AuthorityScopeRecord })[] => {
      if (!Array.isArray(value)) return [];
      const entries: (string | { ref: string; scope?: AuthorityScopeRecord })[] = [];
      const seen: string[] = [];
      for (const raw of value) {
        if (typeof raw === 'string') {
          const trimmed = raw.trim();
          if (!trimmed || seen.includes(trimmed)) continue;
          seen.push(trimmed);
          entries.push(trimmed);
          continue;
        }
        // M2 scoped entry: `{ ref, scope? }`. A malformed record or a present
        // non-object scope is dropped here (absent/null keeps the legacy
        // unscoped meaning); the runtime grant core re-validates the scope per
        // id and skips a malformed entry fail-closed (never unscoped).
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const record = raw as { ref?: unknown; scope?: unknown };
        if (typeof record.ref !== 'string') continue;
        const trimmed = record.ref.trim();
        if (!trimmed || seen.includes(trimmed)) continue;
        seen.push(trimmed);
        let scope: AuthorityScopeRecord | undefined;
        if (record.scope !== undefined && record.scope !== null) {
          if (typeof record.scope !== 'object' || Array.isArray(record.scope)) continue;
          scope = record.scope as AuthorityScopeRecord;
        }
        entries.push(scope === undefined ? trimmed : { ref: trimmed, scope });
      }
      return entries;
    };
    const legacy = Object.prototype.hasOwnProperty.call(persisted, 'metaAuthorityGrants')
      ? (persisted as AuthorityGrantSnapshot).metaAuthorityGrants
      : undefined;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
      const template = collect(legacy.template);
      const hydration = collect(legacy.hydration);
      if (template.length > 0) merged[AGENT_AUTHORITIES.TEMPLATE] = template;
      if (hydration.length > 0) merged[AGENT_AUTHORITIES.HYDRATION] = hydration;
    }
    const generic = Object.prototype.hasOwnProperty.call(persisted, 'authorityGrants')
      ? (persisted as AuthorityGrantSnapshot).authorityGrants
      : undefined;
    if (generic && typeof generic === 'object' && !Array.isArray(generic)) {
      for (const authorityId of Object.keys(generic)) {
        if (typeof authorityId !== 'string' || !authorityId.trim()) continue;
        const refs = collect((generic as Record<string, unknown>)[authorityId]);
        // Generic wins per id: an own key replaces the legacy list (even an
        // empty one), so a mixed/tampered snapshot never double-grants.
        merged[authorityId.trim()] = refs;
      }
    }
    if (Object.keys(merged).length === 0) return {};
    try {
      return this.#runtime.restoreAuthorityGrants(merged, { principal: this.#runtime.getOperatorPrincipal() });
    } catch (err) {
      // Fail-closed: a malformed grant record never fails hydration.
      console.warn('[SandboxStore] Failed to restore authority grants:', err);
      return {};
    }
  }

  /**
   * Renders the persisted mirror of the in-memory per-template authority trust
   * map as a frozen plain record (proto-safe: entries are defined as own data
   * properties), or `null` when no trust is recorded so the snapshot field is
   * omitted and legacy bytes are unchanged (ticket 2518510).
   *
   * @returns Frozen trust record, or `null` when empty.
   */
  #serializeTemplateAuthorityTrust(): Record<string, Record<string, readonly string[]>> | null {
    if (this.#templateAuthorityTrust.size === 0) return null;
    const listing: Record<string, Record<string, readonly string[]>> = Object.create(null);
    for (const [templateId, agents] of this.#templateAuthorityTrust) {
      const agentRecord: Record<string, readonly string[]> = Object.create(null);
      for (const [agentKey, authorities] of agents) {
        Object.defineProperty(agentRecord, agentKey, {
          value: Object.freeze([...authorities]),
          enumerable: true,
          writable: false,
          configurable: false
        });
      }
      Object.defineProperty(listing, templateId, {
        value: Object.freeze(agentRecord),
        enumerable: true,
        writable: false,
        configurable: false
      });
    }
    return listing;
  }

  /**
   * Re-resolves the effective launch catalog: shipped bundles first, then the
   * import registry (in-place replacement by id). The bundle list and the
   * normalized template projection are rebuilt and frozen; callers must invoke
   * this after any host/import mutation before reading the catalog.
   */
  #resolveRealmTemplateCatalog(): void {
    const imported = [...this.#realmTemplateImports.values()].map((record) => record.bundle);
    this.#realmTemplateBundles = resolveEffectiveRealmTemplateBundles(this.#hostRealmTemplateBundles, imported);
    this.#realmTemplates = Object.freeze(
      this.#realmTemplateBundles.map((bundle) => resolveTemplateBundleView(bundle).template)
    );
  }

  /**
   * Resolves the effective authored-form content version of one catalog entry:
   * an import's parsed authored pin (never re-hashed) or a shipped bundle's
   * `templateBundleVersion` over the authored template + files. `null` means
   * the entry cannot be versioned (malformed host injection).
   *
   * @param templateId - Effective catalog template id.
   * @returns The canonical `sha256:<hex>` version, or `null`.
   */
  #effectiveTemplateVersion(templateId: string): string | null {
    const imported = this.#realmTemplateImports.get(templateId);
    if (imported) return imported.version;
    const bundle = this.#realmTemplateBundles.find((entry) => entry.template.id === templateId);
    if (!bundle) return null;
    return resolveTemplateBundleVersion(bundle);
  }

  /**
   * Resolves one catalog entry's internal authored bundle (the authored
   * template + file map). Imports keep their normalized template in the
   * registry, so the authored form is recovered by re-parsing the persisted
   * canonical payload; shipped entries return their authored bundle directly.
   *
   * @param templateId - Effective catalog template id.
   * @returns The authored bundle, or `null` for an unknown/unparseable id.
   */
  #authoredTemplateBundle(templateId: string): RealmTemplateBundle | null {
    const imported = this.#realmTemplateImports.get(templateId);
    if (imported) {
      try {
        const envelope = JSON.parse(imported.payload) as { template?: RealmTemplate } | null;
        if (!envelope || typeof envelope !== 'object' || !envelope.template) return null;
        return { template: envelope.template, files: imported.bundle.files };
      } catch {
        return null;
      }
    }
    return this.#realmTemplateBundles.find((entry) => entry.template.id === templateId) ?? null;
  }

  /**
   * Sums the canonical payload bytes of every runtime template import.
   *
   * @returns Total imported-template bytes.
   */
  #totalImportedRealmTemplateBytes(): number {
    let total = 0;
    for (const record of this.#realmTemplateImports.values()) {
      total += record.bytes;
    }
    return total;
  }

  /**
   * Returns the persisted mirror of the runtime template-import registry: the
   * canonical payload of every import, in import order (the snapshot contract
   * is `{ id, payload }`; versions are recomputed on hydration). Empty while no
   * import exists so legacy snapshots stay byte-identical.
   *
   * @returns Fresh persisted import records.
   */
  #serializeRealmTemplateImports(): PersistedImportedRealmTemplate[] {
    return [...this.#realmTemplateImports.values()].map((record) => Object.freeze({
      id: record.bundle.template.id,
      payload: record.payload
    }));
  }

  /**
   * Persists the template-import registry synchronously (no debounce): any
   * pending autosave is flushed first, then the current snapshot is written
   * immediately, so a failed write surfaces as a typed
   * `ERR_STORE_TEMPLATE_PERSIST_FAILED` from the mutating method and the
   * registry can be rolled back — an import/delete is never silently
   * in-memory-only. During hydration the guard returns without writing
   * (hydration never rewrites persisted bytes).
   *
   * @throws Error with code `'ERR_STORE_TEMPLATE_PERSIST_FAILED'` when the write fails.
   */
  #persistRealmTemplateRegistry(): void {
    if (this.#hydrating) return;
    if (this.#debouncedSave) {
      this.#debouncedSave.flush();
    }
    let saved: boolean;
    try {
      saved = saveSandboxState(this.serialize());
    } catch (err) {
      throw templatePersistFailedError(
        `template registry: the snapshot write failed (${sanitizeDiagnosticError(thrownMessage(err, 'storage failure'))}) — the mutation was rolled back`,
        err
      );
    }
    if (!saved) {
      throw templatePersistFailedError(
        'template registry: the snapshot write failed (storage quota exceeded or unavailable) — the mutation was rolled back'
      );
    }
  }

  /**
   * Seeds the protected Generic default into the snapshot-backed mirror before
   * the registry is constructed (Wave R, ticket 56ba4b9). The mirror is written
   * directly, never through the registry adapter, so construction schedules no
   * autosave; a persisted Generic record keeps its operator-edited metadata and
   * a missing one is prepended as the first registry record — the position is
   * stable for the store's lifetime because the registry refuses its removal
   * (Wave R hardening, ticket 0fe25fd).
   */
  #seedGenericRealmRecord(): void {
    if (this.#realmRecords.some((realm) => realm.id === GENERIC_REALM_ID)) return;
    this.#realmRecords = [
      { id: GENERIC_REALM_ID, name: GENERIC_REALM_NAME, createdAt: Date.now() },
      ...this.#realmRecords
    ];
  }

  /**
   * Ensures the protected Generic default is registered after a reconciliation
   * pass (Wave R, tickets 56ba4b9/0fe25fd). The registry refuses removal of the
   * protected id, so a missing record can only mean the registry was built
   * without the seed (defensive path): it is re-added through the public API.
   * With `pristine` set (an in-memory reset), the record survives the prune in
   * place and its operator-editable metadata is restored to the pristine seed;
   * `id` and `createdAt` stay immutable by registry contract. During hydration
   * the adapter save is suppressed, so persisted bytes stay untouched; a reset
   * schedules the fresh topology as usual.
   *
   * @param pristine - Restore the pristine seed metadata (reset) instead of keeping the current one.
   */
  #ensureGenericRealm(pristine = false): void {
    const existing = this.#realmRegistry.getRealm(GENERIC_REALM_ID);
    if (!existing) {
      this.#realmRegistry.addRealm({
        id: GENERIC_REALM_ID,
        name: GENERIC_REALM_NAME,
        createdAt: Date.now()
      });
      return;
    }
    if (!pristine) return;
    if (
      existing.name === GENERIC_REALM_NAME &&
      existing.description === undefined &&
      existing.color === undefined &&
      existing.templateId === undefined &&
      existing.instance === undefined &&
      existing.extensions === undefined
    ) {
      return; // Already pristine — never schedule a no-op save.
    }
    this.#realmRegistry.updateRealm(GENERIC_REALM_ID, {
      name: GENERIC_REALM_NAME,
      description: null,
      color: null,
      templateId: null,
      instance: null,
      extensions: null
    });
  }

  /**
   * Reconciles the in-memory catalog with the preset topology of a persisted
   * snapshot (or with an empty topology on reset), using the catalog's public
   * management API only:
   * 1. every structurally valid persisted entry is saved (add/overwrite by id);
   * 2. custom entries absent from the snapshot are deleted;
   * 3. the active pointer is re-pointed at the persisted id when it names a
   *    catalog entry, otherwise it falls back to the master default.
   *
   * Catalog mutations persist through the snapshot adapter and schedule the
   * existing debounced save.
   *
   * @param persisted - Snapshot whose topology wins, or null to drop custom entries.
   */
  #reconcilePresetCatalog(persisted: SandboxPersistedState | null): void {
    const catalog = this.#presetCatalog;
    const incoming: ModelPreset[] = [];
    if (persisted && Array.isArray(persisted.customPresets)) {
      for (const candidate of persisted.customPresets) {
        if (isModelPresetShape(candidate)) incoming.push(cloneModelPreset(candidate));
      }
    }
    const incomingIds = new Set(incoming.map((preset) => preset.id));

    for (const preset of incoming) {
      try {
        catalog.savePreset(preset);
      } catch {
        // Rejected by the catalog despite passing the structural guard; skip.
      }
    }

    for (const existing of catalog.listPresets()) {
      if (!existing.isCustom || incomingIds.has(existing.id)) continue;
      try {
        catalog.deletePreset(existing.id);
      } catch {
        // The undeletable fallback default refuses deletion; skip it.
      }
    }

    const persistedActiveId = persisted && typeof persisted.activePresetId === 'string'
      ? persisted.activePresetId.trim()
      : '';
    if (persistedActiveId && catalog.getPreset(persistedActiveId)) {
      try {
        catalog.setActivePresetId(persistedActiveId);
      } catch {
        // Best-effort pointer write; reads fall back to the default.
      }
      return;
    }

    // Missing/unknown persisted pointer: fall back to the master default. The
    // closure state is cleared first so `getDefaultPresetId()` cannot echo a
    // stale in-memory pointer. When the previous pointer already resolved to
    // that default (empty, explicit default, or stale), the fallback is a
    // no-op and is synchronized in memory only: it must not mark the snapshot
    // dirty by scheduling a pointer write.
    const previousPointer = this.#activePresetId;
    this.#activePresetId = '';
    const fallbackId = this.#presetSource.getDefaultPresetId();
    if (previousPointer && previousPointer !== fallbackId && catalog.getPreset(previousPointer)) {
      if (fallbackId && catalog.getPreset(fallbackId)) {
        try {
          catalog.setActivePresetId(fallbackId);
        } catch {
          // Best-effort pointer write; reads fall back to the default.
        }
      }
      return;
    }
    this.#activePresetId = fallbackId;
  }

  /**
   * Fingerprint-heals MOD-20 preset bindings on the in-memory snapshot copy
   * before runtime restore (the runtime port has no catalog enumeration):
   * a resolving `presetId` is kept; otherwise the agent's
   * `modelConfig.{providerId,modelId}` is matched against the reconciled
   * catalog and the matched id is bound; an unmatched fingerprint binds
   * `getDefaultPresetId()`. Active and recycled agents are walked, and storage
   * is never rewritten here.
   *
   * @param persisted - Validated snapshot about to be restored (mutated in memory only).
   */
  #healSnapshotPresetBindings(persisted: SandboxPersistedState): void {
    const defaultId = this.#presetSource.getDefaultPresetId();
    const entries = this.#presetCatalog.listPresets();

    for (const list of [persisted.agents, persisted.recycleBin]) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const config = (entry as { config?: unknown }).config;
        if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
        const record = config as Record<string, unknown>;

        const existingId = typeof record.presetId === 'string' ? record.presetId.trim() : '';
        if (existingId && this.#presetCatalog.getPreset(existingId)) {
          record.presetId = existingId;
          continue;
        }

        const modelConfig = record.modelConfig && typeof record.modelConfig === 'object' && !Array.isArray(record.modelConfig)
          ? record.modelConfig as Record<string, unknown>
          : null;
        const providerId = modelConfig && typeof modelConfig.providerId === 'string'
          ? modelConfig.providerId.trim()
          : '';
        const modelId = modelConfig && typeof modelConfig.modelId === 'string'
          ? modelConfig.modelId.trim()
          : '';
        const matched = providerId && modelId
          ? entries.find((preset) => preset.modelConfig.providerId === providerId && preset.modelConfig.modelId === modelId)
          : undefined;
        record.presetId = matched ? matched.id : defaultId;
      }
    }
  }

  /**
   * Reconciles the in-memory extension registry with the install topology of a
   * persisted snapshot (or clears it on reset) through the registry's
   * snapshot-authoritative `reconcile` path: every structurally valid persisted
   * record is applied, malformed entries are dropped individually, and
   * duplicate ids resolve last-wins in place. A no-op reconcile never
   * persists, so a hydration that finds the already-seeded records leaves
   * storage untouched. Nothing connects.
   *
   * @param persisted - Snapshot whose install topology wins, or null to drop every record.
   */
  #reconcileExtensionRegistry(persisted: SandboxPersistedState | null): void {
    const incoming = persisted && Array.isArray(persisted.extensions) ? persisted.extensions : [];
    this.#extensionRegistry.reconcile(incoming);
  }

  /**
   * Heals the realm-attachment topology: an `active` attachment whose extension
   * carries no install record degrades to `unavailable` (the attachment and its
   * approval stamp are never dropped), and an `unavailable` attachment whose
   * extension is installed returns to `active`. A live connection constraints
   * the status when one exists: `connected` → `active`, `conflict` →
   * `conflict`, `error` → `unavailable`; a `connecting` session (transient) and
   * a disconnected extension impose no constraint, so P2 install-only healing
   * still applies after hydration. When no live connection constrains the
   * attachment, a `conflict` attachment is never rewritten in either direction
   * — conflict resolution belongs to catalog-time work. The sweep runs after
   * hydration and after every in-session registry mutation (the
   * install/reconcile paths flow through the registry's persistence seam);
   * during hydration the suppression guard keeps the debounced autosave inert,
   * so persisted bytes are never rewritten by the hydration pass.
   */
  #healRealmExtensionAttachments(): void {
    for (const realm of this.#realmRegistry.listRealms()) {
      const attachments = realm.extensions;
      if (!attachments || attachments.length === 0) continue;
      let changed = false;
      const healed = attachments.map((attachment) => {
        const live = this.#liveAttachmentStatus(attachment.extensionId);
        if (live !== null) {
          if (attachment.status === live) return attachment;
          changed = true;
          return Object.freeze({ ...attachment, status: live });
        }
        const installed = this.#extensionRegistry.getExtension(attachment.extensionId) !== null;
        if (!installed && attachment.status === 'active') {
          changed = true;
          return Object.freeze({ ...attachment, status: 'unavailable' as const });
        }
        if (installed && attachment.status === 'unavailable') {
          changed = true;
          return Object.freeze({ ...attachment, status: 'active' as const });
        }
        return attachment;
      });
      if (!changed) continue;
      try {
        this.#realmRegistry.updateRealm(realm.id, { extensions: healed });
      } catch {
        // A rejected heal leaves the persisted attachment state untouched.
      }
    }
  }

  /**
   * Reconciles the in-memory realm registry with the realm topology of a
   * persisted snapshot (or clears it on reset), using the registry's public
   * management API only:
   * 1. every structurally valid persisted record is added, or updated in place
   *    when its id already exists (the snapshot is authoritative for every
   *    field except `id`/`createdAt`);
   * 2. registry records absent from the snapshot are removed — except the
   *    protected Generic default, whose removal the registry refuses: it
   *    survives in place (first, per the prepended seed order) and a reset
   *    restores its pristine metadata (Wave R, tickets 56ba4b9/0fe25fd);
   * 3. the reactive `realms` projection is resynced.
   *
   * Registry mutations persist through the snapshot adapter and schedule the
   * existing debounced save, which the hydration suppression guard keeps inert
   * for the duration of `hydrateFromStorage`.
   *
   * @param persisted - Snapshot whose realm topology wins, or null to drop every record (Generic excepted).
   */
  #reconcileRealmRegistry(persisted: SandboxPersistedState | null): void {
    const incoming: RealmRecord[] = [];
    if (persisted && Array.isArray(persisted.realms)) {
      for (const candidate of persisted.realms) {
        if (isRealmRecordShape(candidate)) incoming.push(cloneRealmRecord(candidate));
      }
    }
    const incomingIds = new Set(incoming.map((realm) => realm.id));

    for (const realm of incoming) {
      try {
        if (this.#realmRegistry.getRealm(realm.id)) {
          this.#realmRegistry.updateRealm(realm.id, {
            name: realm.name,
            description: realm.description ?? null,
            color: realm.color ?? null,
            templateId: realm.templateId ?? null,
            instance: realm.instance ?? null,
            extensions: realm.extensions ?? null
          });
        } else {
          this.#realmRegistry.addRealm(realm);
        }
      } catch {
        // Rejected by the registry despite passing the structural guard; skip.
      }
    }

    // A record absent from the snapshot is pruned; the registry refuses the
    // protected Generic default, so it survives in place (first, keeping the
    // prepended seed order) instead of being removed and appended last. A
    // snapshot that carries its (possibly renamed) Generic keeps it because it
    // is incoming. A reset (`persisted === null`) then restores the pristine
    // seed metadata, since the protected record can never be re-created.
    for (const existing of this.#realmRegistry.listRealms()) {
      if (incomingIds.has(existing.id)) continue;
      this.#realmRegistry.removeRealm(existing.id);
    }
    this.#ensureGenericRealm(persisted === null);

    this.#syncRealms();
  }

  /**
   * Captures the persisted tool grants of a snapshot's ACTIVE agents as plain
   * data for the H1 heal pass: `allowedTools` (or the `tools` alias, or a
   * `toolPreset`/`tool_preset` selector when no explicit list is present) is
   * resolved through the sandbox preset resolver — retired-selector entries
   * expand to their concrete tool list through the deprecated window — so the
   * later reconcile compares canonical lists. Entries with no selector or an
   * empty resolved grant are skipped (default-deny stays the baseline).
   * Deliberately never reads `privileged`, `spawnedBy`/`creatorId`, or
   * `realmId` as capability data — authority and membership are not grants.
   * The persisted membership is captured alongside purely as an identity
   * targeting scope (ticket 5f34f18), so the heal resolves each same-literal-id
   * registration realm-exactly; it is never applied back as a membership write.
   *
   * @param persisted - Snapshot the heal pass reconciles from (read-only).
   */
  #captureCapabilityHealGrants(persisted: SandboxPersistedState): void {
    const grants: Array<{
      agentId: string;
      realmId: string | null;
      allowedTools: readonly string[];
      extensionSelector: 'all' | readonly string[];
    }> = [];
    const entries = Array.isArray(persisted.agents) ? persisted.agents : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const agentId = typeof entry.id === 'string' ? entry.id.trim() : '';
      if (!agentId) continue;
      const config = (entry as { config?: unknown }).config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
      const record = config as Record<string, unknown>;
      const hasAllowedField = record.allowedTools !== undefined
        || record.tools !== undefined
        || record.toolPreset !== undefined
        || record.tool_preset !== undefined;
      const raw = record.allowedTools !== undefined
        ? record.allowedTools
        : (record.tools !== undefined
          ? record.tools
          : (record.toolPreset !== undefined ? record.toolPreset : record.tool_preset));
      const resolved = (typeof raw === 'string' || Array.isArray(raw))
        ? resolveToolPreset(raw as string | readonly string[])
        : [];
      // Extension wave (P2.4): the per-agent selector is capability data too,
      // captured from the persisted snapshot. A legacy snapshot without the
      // field captures an empty selector — fail closed (nothing was granted
      // before the extension wave), never the `'all'` default. An agent with
      // no capability selector of any kind contributes no entry (its sweep
      // selector stays fail-closed-empty on the absent config property).
      const hasExtensionField = Object.prototype.hasOwnProperty.call(record, 'extensionTools');
      if (!hasAllowedField && !hasExtensionField) continue;
      // The persisted selector is honored only as the literal `'all'` or an
      // array. Every other persisted value (`null`, a foreign string, a
      // number, an object) captures the empty fail-closed selector: a
      // tampered or malformed snapshot heals default-deny and must never
      // resolve the `'all'` default against the Realm universe (F1).
      const rawPersistedSelector = record.extensionTools;
      const persistedSelectorIsValid = rawPersistedSelector === 'all' || Array.isArray(rawPersistedSelector);
      const persistedRealmId = typeof record.realmId === 'string' && record.realmId.trim()
        ? record.realmId.trim()
        : null;
      grants.push({
        agentId,
        realmId: persistedRealmId,
        allowedTools: Object.freeze(resolved),
        extensionSelector: hasExtensionField && persistedSelectorIsValid
          ? normalizeExtensionSelector(rawPersistedSelector)
          : Object.freeze([])
      });
    }
    this.#capabilityHealGrants = grants;
  }

  /**
   * Re-applies the persisted operator `realmBypass` grants after snapshot
   * hydration (Wave I, ticket c02d0b9; fix lane G2). The additive
   * `realmBypassGrants` field is optional: an absent or malformed value leaves
   * the grant list empty and never fails hydration. Entries are canonical
   * identity keys as emitted by `listRealmBypassGrants`; legacy bare ids are
   * still accepted and restored unique-match. Non-string and empty entries are
   * ignored here; the runtime grants each remaining ref through the
   * operator-principal gate and drops unknown, non-active, or Realm-ambiguous
   * refs fail-closed, returning only the refs it actually restored.
   *
   * @param persisted - Restored snapshot carrying the additive grant list (read-only).
   * @returns The refs the runtime actually restored (empty for legacy/grant-free snapshots).
   */
  #restorePersistedRealmBypassGrants(persisted: SandboxPersistedState): string[] {
    const grants = (persisted as AuthorityGrantSnapshot).realmBypassGrants;
    if (!Array.isArray(grants)) return [];
    const ids: string[] = [];
    for (const id of grants) {
      if (typeof id !== 'string') continue;
      const trimmed = id.trim();
      if (trimmed && !ids.includes(trimmed)) ids.push(trimmed);
    }
    if (ids.length === 0) return [];
    try {
      return this.#runtime.restoreRealmBypassGrants(ids, { principal: this.#runtime.getOperatorPrincipal() });
    } catch (err) {
      // Fail-closed: a malformed grant list never fails hydration.
      console.warn('[SandboxStore] Failed to restore realmBypass grants:', err);
      return [];
    }
  }

  /**
   * Remaps legacy bare-keyed private workspaces onto each record's canonical
   * realm-qualified key after a snapshot restore (Wave I, ticket d57cbc1).
   *
   * Runs on the runtime's VirtualFS (the substrate the restore imported into)
   * under the runtime's host operator principal, resolving each bare legacy
   * workspace key through the persisted record's own Realm scope
   * (`getAgentIdentity(id, { realmId: record.config.realmId })`) so a
   * bare id registered under two Realms is never moved to the wrong Realm.
   * A bare id absent from the records, or ambiguous across records, stays
   * literal — no data is ever dropped, and the canonical copy wins a
   * duplicate path (reported, not overwritten).
   *
   * In-memory only: this pass never schedules the debounced autosave (the
   * hydration suppression guard is active), so the raw persisted bytes are
   * left byte-identical; the remapped state reaches storage only through the
   * next regular save. Conflicts surface on `legacyWorkspaceRemapReport` —
   * no console noise in normal operation.
   *
   * @param persisted - Snapshot restored in this hydration (read-only).
   */
  #rekeyLegacyPrivateWorkspacesOnHydrate(persisted: SandboxPersistedState): void {
    const identityPort = this.#identityPort;
    const vfs = this.#runtime && typeof this.#runtime.virtualFs === 'object'
      ? this.#runtime.virtualFs
      : this.#virtualFs;
    if (!identityPort || !vfs || typeof vfs.rekeyLegacyPrivateWorkspaces !== 'function') return;

    // Realm scope per persisted record (active and recycled alike): the legacy
    // bare key can only be attributed while exactly one record carries the id.
    const realmsByBareId = new Map<string, Set<string | null>>();
    const recordLists: ReadonlyArray<unknown>[] = [persisted.agents, persisted.recycleBin];
    for (const records of recordLists) {
      if (!Array.isArray(records)) continue;
      for (const entry of records) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as { id?: unknown; config?: unknown };
        const id = typeof record.id === 'string' ? record.id.trim() : '';
        if (!id) continue;
        const config = record.config && typeof record.config === 'object'
          ? record.config as Record<string, unknown>
          : null;
        const rawRealm = config ? config.realmId : undefined;
        const realmId = typeof rawRealm === 'string' && rawRealm ? rawRealm : null;
        const bucket = realmsByBareId.get(id);
        if (bucket) bucket.add(realmId);
        else realmsByBareId.set(id, new Set([realmId]));
      }
    }

    const resolveProjection = (bareId: string): AgentIdentityProjection | null => {
      const realms = realmsByBareId.get(bareId);
      if (!realms || realms.size !== 1) return null;
      const realmId = realms.values().next().value ?? null;
      try {
        return identityPort.getAgentIdentity(bareId, { realmId });
      } catch {
        return null;
      }
    };

    try {
      const remapped = vfs.rekeyLegacyPrivateWorkspaces(resolveProjection, {
        principal: this.#runtime.getOperatorPrincipal()
      });
      if (!Array.isArray(remapped) || remapped.length === 0) {
        this.legacyWorkspaceRemapReport = null;
        return;
      }
      const entries: LegacyWorkspaceRemapEntry[] = [];
      let conflictCount = 0;
      for (const entry of remapped) {
        const conflicts = Array.isArray(entry?.mergedConflictPaths) ? [...entry.mergedConflictPaths] : [];
        conflictCount += conflicts.length;
        const rawAgentId = typeof entry?.from === 'string' ? entry.from.trim() : '';
        if (!rawAgentId) continue;
        entries.push(Object.freeze({
          agentId: rawAgentId,
          mergedConflictPaths: Object.freeze(conflicts)
        }));
      }
      this.legacyWorkspaceRemapReport = Object.freeze({
        remapped: Object.freeze(entries),
        remappedCount: entries.length,
        conflictCount,
        failed: false
      });
    } catch {
      // Fail-closed: an unauthorized/unbound substrate never fails hydration.
      // The report is the only signal (no console noise in normal operation).
      this.legacyWorkspaceRemapReport = Object.freeze({
        remapped: Object.freeze([]),
        remappedCount: 0,
        conflictCount: 0,
        failed: true
      });
    }
  }

  /**
   * Runs the H1 reload capability heal over the grants captured at hydration
   * (or the last capture) and publishes the outcome on `capabilityHealReport`:
   * 1. agents missing from the active registry are `'skipped'`
   *    (`'agent-not-restored'`);
   * 2. a live grant equal to the captured one is `'unchanged'` (idempotence);
   * 3. differing grants are applied through the runtime's gated
   *    `updateAgentConfig` path with the store's operator context — a
   *    PERMISSION_DENIED (wildcard grant with no registered operator) is
   *    `'skipped'` (`'operator-authority-required'`), any other rejection is
   *    `'failed'`.
   *
   * Only capability selectors are applied: `privileged`, parentage, and realm
   * membership are never read from the snapshot. The pass never schedules the
   * debounced autosave by itself; while hydrating the suppression guard makes
   * any event-driven schedule inert, and a manual run persists through the
   * normal `agent_config_updated` event.
   *
   * @returns The published report, or `null` when no grants were captured.
   */
  #runCapabilityHeal(): CapabilityHealReport | null {
    const grants = this.#capabilityHealGrants;
    if (!Array.isArray(grants) || grants.length === 0) {
      this.capabilityHealReport = null;
      return null;
    }

    const operator = this.#operatorContext();
    const entries: CapabilityHealEntry[] = [];
    let restored = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;

    for (const grant of grants) {
      // Realm-exact targeting (ticket 5f34f18): the captured membership
      // resolves the canonical `(realmId, agentId)` registration, so a
      // same-literal-id member in another Realm heals its own grant instead of
      // resolving ambiguous and being skipped as not-restored.
      const targetRef = createAgentIdentityKey(grant.realmId, grant.agentId);
      const live = typeof this.#runtime.getAgent === 'function' ? this.#runtime.getAgent(targetRef) : null;
      if (!live) {
        skipped += 1;
        entries.push({
          agentId: grant.agentId,
          outcome: 'skipped',
          allowedTools: grant.allowedTools,
          reason: 'agent-not-restored'
        });
        continue;
      }

      // Extension wave (P2.4): re-apply the captured per-agent selector state
      // before the descriptor sweep. Snapshot hydration withholds it, so this
      // is the only path that restores a template-restricted member's scope;
      // a failed apply blocks the sweep for this member (fail closed — the
      // default `'all'` must never silently resolve on a failed heal).
      const memberKey = createAgentIdentityKey(resolveMemberRealmId(live), live.id);
      const hasSelector = live.config
        ? Object.prototype.hasOwnProperty.call(live.config, 'extensionTools')
        : false;
      const currentSelector = normalizeExtensionSelector(live.config?.extensionTools);
      if (!hasSelector || !extensionSelectorsEqual(currentSelector, grant.extensionSelector)) {
        try {
          this.#runtime.updateAgentConfig(targetRef, { extensionTools: grant.extensionSelector }, operator);
          this.#extensionSweepBlocked.delete(memberKey);
        } catch (err) {
          this.#extensionSweepBlocked.add(memberKey);
          console.warn(
            '[SandboxStore] extension selector heal failed:',
            sanitizeDiagnosticError(err) || 'update-rejected'
          );
        }
      } else {
        this.#extensionSweepBlocked.delete(memberKey);
      }

      const current = Array.isArray(live.config?.allowedTools)
        ? live.config.allowedTools.map((tool) => String(tool))
        : [];
      if (capabilityGrantsEqual(current, grant.allowedTools)) {
        unchanged += 1;
        entries.push({
          agentId: grant.agentId,
          outcome: 'unchanged',
          allowedTools: grant.allowedTools,
          reason: null
        });
        continue;
      }

      try {
        this.#runtime.updateAgentConfig(targetRef, { allowedTools: [...grant.allowedTools] }, operator);
        restored += 1;
        entries.push({
          agentId: grant.agentId,
          outcome: 'restored',
          allowedTools: grant.allowedTools,
          reason: null
        });
      } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'PERMISSION_DENIED') {
          skipped += 1;
          entries.push({
            agentId: grant.agentId,
            outcome: 'skipped',
            allowedTools: grant.allowedTools,
            reason: 'operator-authority-required'
          });
        } else {
          failed += 1;
          entries.push({
            agentId: grant.agentId,
            outcome: 'failed',
            allowedTools: grant.allowedTools,
            reason: sanitizeDiagnosticError(err) || 'update-rejected'
          });
        }
      }
    }

    const report: CapabilityHealReport = Object.freeze({
      at: Date.now(),
      restored,
      unchanged,
      skipped,
      failed,
      entries: Object.freeze(entries)
    });
    this.capabilityHealReport = report;
    if (restored > 0) {
      this.#syncAgents();
    }
    return report;
  }

  /**
   * Mirror high-frequency live fields (state, streaming buffers, tool calls,
   * telemetry totals, appended history) of a runtime agent into the reactive
   * `agents` projection. Patches the existing clone in place — it never rebuilds
   * the agent list — and applies a leading+trailing throttle so token streaming
   * cannot stall the UI or trigger a full clone per chunk.
   *
   * @param agentId - Runtime agent whose live fields are mirrored.
   */
  #mirrorAgentLiveFields(agentId: string): void {
    if (!agentId || !this.#runtime || typeof this.#runtime.getAgent !== 'function') return;
    const live = this.#runtime.getAgent(agentId);
    if (!live) return;

    const apply = () => {
      this.#streamMirrorTimer = null;
      this.#lastStreamMirrorAt = Date.now();
      // Defect 7d2c314: mirror by exact identity key first (the turn bridge
      // addresses the canonical registration), then by a unique bare id for
      // runtime events that carry the realm-opaque label.
      const exact = this.agents.find(a => a.identityKey === agentId);
      const bareMatches = exact ? null : this.agents.filter(a => a.id === agentId);
      const mirrored = (exact ?? (bareMatches && bareMatches.length === 1 ? bareMatches[0] : undefined)) as DeepMutable<AgentStateSnapshot> | undefined;
      if (!mirrored) return;
      mirrored.state = live.state;
      mirrored.stateDetail = live.stateDetail;
      mirrored.currentStream = live.currentStream || '';
      mirrored.currentReasoning = live.currentReasoning || '';
      mirrored.activeToolCalls = Array.isArray(live.activeToolCalls) ? [...live.activeToolCalls] as ToolCallSnapshot[] : [];
      mirrored.updatedAt = live.updatedAt;
      if (
        Array.isArray(mirrored.history) &&
        Array.isArray(live.history) &&
        mirrored.history.length !== live.history.length
      ) {
        mirrored.history = [...live.history];
      }
      if (mirrored.telemetry && live.telemetry) {
        mirrored.telemetry.inputTokens = live.telemetry.inputTokens || 0;
        mirrored.telemetry.cachedInputTokens = live.telemetry.cachedInputTokens || 0;
        mirrored.telemetry.outputTokens = live.telemetry.outputTokens || 0;
        mirrored.telemetry.totalTokens = live.telemetry.totalTokens || 0;
        mirrored.telemetry.turnCount = live.telemetry.turnCount || 0;
        mirrored.telemetry.lastPromptTokens = live.telemetry.lastPromptTokens || 0;
        mirrored.telemetry.lastCachedPromptTokens = live.telemetry.lastCachedPromptTokens || 0;
      }
    };

    const elapsed = Date.now() - this.#lastStreamMirrorAt;
    if (elapsed >= STREAM_MIRROR_THROTTLE_MS) {
      if (this.#streamMirrorTimer) {
        clearTimeout(this.#streamMirrorTimer);
        this.#streamMirrorTimer = null;
      }
      apply();
      return;
    }
    if (!this.#streamMirrorTimer) {
      this.#streamMirrorTimer = setTimeout(apply, STREAM_MIRROR_THROTTLE_MS - elapsed);
    }
  }

  /**
   * Cancels any pending throttled stream mirror update.
   */
  #cancelStreamMirror(): void {
    if (this.#streamMirrorTimer) {
      clearTimeout(this.#streamMirrorTimer);
      this.#streamMirrorTimer = null;
    }
    this.#lastStreamMirrorAt = 0;
  }

  /**
   * Resolve the reactive normalized `AgentStateSnapshot` projection for an agent
   * ID that a preceding `#syncAgents()` pass has copied from the runtime
   * registry. Returns the plain reactive projection, never the raw runtime
   * `Agent`, so no engine instance can leak through a lifecycle result.
   *
   * Wave I (ticket d57cbc1): pass `realmId` when the caller knows the exact
   * registration — a launch must return its own Realm's snapshot, never a
   * same-literal-id registration from another Realm — and the lookup then
   * matches the composite `(realmId, agentId)`. Without a Realm hint the
   * historical bare-id match is kept; callers whose target the runtime has
   * already resolved fail closed on an ambiguous bare id before reaching here.
   *
   * @param agentId - Agent whose reactive projection is required.
   * @param realmId - Optional exact Realm membership of the target registration.
   * @returns Normalized reactive agent snapshot.
   */
  #requireAgentSnapshot(agentId: string, realmId?: string | null): AgentStateSnapshot {
    const exact = realmId !== undefined;
    const snapshot = this.agents.find(a => a.id === agentId
      && (!exact || (a.config.realmId ?? null) === (realmId ?? null)));
    if (!snapshot) {
      const err: CodedError = new Error(SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND);
      err.code = SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND;
      throw err;
    }
    return snapshot;
  }

  /**
   * Synchronize reactive agents array with runtime state.
   */
  #syncAgents(): void {
    const rawList = this.#runtime.listAgents();
    // Wave I (ticket d57cbc1): resolve each record's canonical mailbox key
    // realm-exactly (one port enumeration per sync) so two Realms sharing a
    // literal id keep independent unread badges; without an enumerable port
    // the bare id stays the lookup ref (legacy behavior).
    const canonicalKeys = new Map<string, string>();
    const bareIdCounts = new Map<string, number>();
    const identityPort = this.#identityPort;
    if (identityPort && typeof identityPort.listAgentIdentities === 'function') {
      try {
        for (const projection of identityPort.listAgentIdentities()) {
          if (!projection || typeof projection.id !== 'string' || typeof projection.key !== 'string' || !projection.key) continue;
          const realmId = typeof projection.realmId === 'string' && projection.realmId ? projection.realmId : '';
          canonicalKeys.set(`${realmId}\u0000${projection.id}`, projection.key);
          bareIdCounts.set(projection.id, (bareIdCounts.get(projection.id) || 0) + 1);
        }
      } catch {
        /* Identity enumeration unavailable: keep the legacy bare-id badges. */
      }
    }
    // Clone properties to ensure reactive propagation
    const currentIdentityKeys = new Set<string>();
    this.agents = rawList.map(agent => {
      const rawRealmId = typeof agent.config?.realmId === 'string' && agent.config.realmId ? agent.config.realmId : '';
      const canonicalKey = canonicalKeys.get(`${rawRealmId}\u0000${agent.id}`) || null;
      // A literal id live in more than one Realm must read only its own
      // canonical partition: the bare mailbox is shared/ambiguous.
      const exactOnly = (bareIdCounts.get(agent.id) || 0) > 1;
      const unreadCount = this.#busUnreadCountFor(agent.id, canonicalKey, exactOnly);
      // Defect 7d2c314: the canonical registration key rides the snapshot
      // (the same map the mailbox badge resolution already builds), so
      // selection and actions address this exact registration.
      const identityKey = canonicalKey || createAgentIdentityKey(rawRealmId || null, agent.id);
      currentIdentityKeys.add(identityKey);

      return {
        id: agent.id,
        identityKey,
        name: agent.name,
        config: { ...agent.config },
        state: agent.state,
        stateDetail: agent.stateDetail,
        history: [...agent.history],
        redoStack: Array.isArray(agent.redoStack) ? [...agent.redoStack] : [],
        currentStream: agent.currentStream,
        currentReasoning: agent.currentReasoning,
        activeToolCalls: [...agent.activeToolCalls] as ToolCallSnapshot[],
        turnCount: agent.turnCount,
        lastSummary: agent.lastSummary || null,
        pendingPrecalls: Array.isArray(agent.pendingPrecalls) ? [...agent.pendingPrecalls] : [],
        telemetry: agent.telemetry ? {
          inputTokens: agent.telemetry.inputTokens || 0,
          cachedInputTokens: agent.telemetry.cachedInputTokens || 0,
          outputTokens: agent.telemetry.outputTokens || 0,
          totalTokens: agent.telemetry.totalTokens || 0,
          turnCount: agent.telemetry.turnCount || 0,
          lastPromptTokens: agent.telemetry.lastPromptTokens || 0,
          lastCachedPromptTokens: agent.telemetry.lastCachedPromptTokens || 0,
          lastCompletionTokens: agent.telemetry.lastCompletionTokens || 0,
          terminalStops: agent.telemetry.terminalStops || 0,
          injectedDeliveries: agent.telemetry.injectedDeliveries || 0,
          precallCount: agent.telemetry.precallCount || 0,
          lastSentContext: Array.isArray(agent.telemetry.lastSentContext) ? [...agent.telemetry.lastSentContext] as FormattedContextMessage[] : []
        } : {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          turnCount: 0,
          lastPromptTokens: 0,
          lastCachedPromptTokens: 0,
          lastCompletionTokens: 0,
          terminalStops: 0,
          injectedDeliveries: 0,
          precallCount: 0,
          lastSentContext: []
        },
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        lastError: sanitizeDiagnosticError(agent.lastError) || null,
        unreadCount
      };
    });

    // Registration diff (ticket 9327633): a canonical key that newly enters
    // the active set is a fresh registration regardless of its launch path —
    // including a child launched through the `spawn_agent` tool's lifecycle
    // port, which never passes the store's grant-composing launch path. A
    // store-launched registration is consumed by its launch mark (its grants
    // already traveled the trusted unified-options channel, and a template
    // launch has not yet written the Realm attachments/provenance the sweep
    // reads); a hydration rebuild primes the baseline only, because the
    // explicit hydration sweep owns restored members' grants.
    for (const memberKey of currentIdentityKeys) {
      if (this.#knownAgentIdentityKeys.has(memberKey)) continue;
      const storeLaunched = this.#storeLaunchGrantedKeys.delete(memberKey);
      if (storeLaunched || this.#hydrating) continue;
      this.#pendingRegistrationSweep.add(memberKey);
    }
    this.#knownAgentIdentityKeys = currentIdentityKeys;

    // Selection reconciliation (defect 7d2c314): `selectedAgent` already
    // resolves the key exactly (or a unique legacy bare ref); when nothing
    // resolves (fresh store, killed/purged selection, stale key), fall back
    // to the first active registration — the legacy auto-selection parity.
    if (!this.selectedAgent && this.agents.length > 0) {
      this.selectedAgentKey = this.agents[0].identityKey;
    }
  }

  /**
   * Synchronize reactive recycleBin array with runtime state.
   */
  #syncRecycleBin(): void {
    if (!this.#runtime) {
      this.recycleBin = [];
      return;
    }
    const rawRecycled = this.#runtime.listRecycledAgents();

    this.recycleBin = rawRecycled.map(agent => {
      // Defect 7d2c314: the recycled snapshot carries its canonical
      // registration key so restore/purge address the exact record.
      const rawRealmId = typeof agent.config?.realmId === 'string' && agent.config.realmId ? agent.config.realmId : '';
      return {
      id: agent.id,
      identityKey: createAgentIdentityKey(rawRealmId || null, agent.id),
      name: agent.name,
      config: { ...agent.config },
      state: agent.state,
      stateDetail: agent.stateDetail,
      recycledAt: agent.recycledAt || null,
      recycleReason: agent.recycleReason || agent.stateDetail || null,
      history: Array.isArray(agent.history) ? [...agent.history] : [],
      redoStack: Array.isArray(agent.redoStack) ? [...agent.redoStack] : [],
      turnCount: agent.turnCount || 0,
      lastSummary: agent.lastSummary || null,
      pendingPrecalls: Array.isArray(agent.pendingPrecalls) ? [...agent.pendingPrecalls] : [],
      telemetry: agent.telemetry ? {
        inputTokens: agent.telemetry.inputTokens || 0,
        cachedInputTokens: agent.telemetry.cachedInputTokens || 0,
        outputTokens: agent.telemetry.outputTokens || 0,
        totalTokens: agent.telemetry.totalTokens || 0,
        turnCount: agent.telemetry.turnCount || 0,
        lastPromptTokens: agent.telemetry.lastPromptTokens || 0,
        lastCachedPromptTokens: agent.telemetry.lastCachedPromptTokens || 0,
        lastCompletionTokens: agent.telemetry.lastCompletionTokens || 0,
        terminalStops: agent.telemetry.terminalStops || 0,
        injectedDeliveries: agent.telemetry.injectedDeliveries || 0,
        precallCount: agent.telemetry.precallCount || 0,
        lastSentContext: Array.isArray(agent.telemetry.lastSentContext) ? [...agent.telemetry.lastSentContext] as FormattedContextMessage[] : []
      } : {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turnCount: 0,
        lastPromptTokens: 0,
        lastCachedPromptTokens: 0,
        lastCompletionTokens: 0,
        terminalStops: 0,
        injectedDeliveries: 0,
        precallCount: 0,
        lastSentContext: []
      },
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      lastError: agent.lastError || null
      };
    });
  }

  /**
   * Synchronize reactive scheduledTimers array with AgentRuntime.
   * The store is the human operator surface and passes the runtime's host
   * operator principal as the scheduler authority context (MOD-21 W6; Wave I,
   * ticket c02d0b9), so the projection is the operator's full scheduler view.
   */
  #syncScheduledTimers(): void {
    if (!this.#runtime || typeof this.#runtime.listSchedules !== 'function') {
      this.scheduledTimers = [];
      this.#stopTimerTicker();
      return;
    }

    const result = this.#runtime.listSchedules({ status: 'all' }, this.#operatorContext());
    const schedules = Array.isArray(result?.schedules) ? result.schedules : [];

    this.scheduledTimers = schedules.map(t => ({
      timerId: t.timerId,
      agentId: t.agentId || t.targetAgentId,
      targetAgentId: t.targetAgentId || t.agentId,
      durationSeconds: t.durationSeconds ?? 0,
      remainingSeconds: t.remainingSeconds ?? Math.max(0, Math.ceil((t.fireAt - Date.now()) / 1000)),
      scheduledAt: t.scheduledAt,
      fireAt: t.fireAt,
      prompt: t.prompt,
      timerCondition: t.timerCondition || 'never',
      status: t.status,
      triggeredAt: t.triggeredAt || null,
      cancelledAt: t.cancelledAt || null
    }));

    const hasPending = this.scheduledTimers.some(t => t.status === 'pending');
    if (hasPending) {
      this.#startTimerTicker();
    } else {
      this.#stopTimerTicker();
    }
  }

  /**
   * Starts 1-second interval ticker for live countdowns.
   */
  #startTimerTicker(): void {
    if (this.#timerTicker) return;
    this.#timerTicker = setInterval(() => {
      const now = Date.now();
      let anyPending = false;
      this.scheduledTimers = this.scheduledTimers.map(t => {
        if (t.status === 'pending') {
          anyPending = true;
          const remaining = Math.max(0, Math.ceil((t.fireAt - now) / 1000));
          return { ...t, remainingSeconds: remaining };
        }
        return t;
      });
      if (!anyPending) {
        this.#stopTimerTicker();
      }
    }, 1000);
    if (typeof this.#timerTicker?.unref === 'function') {
      this.#timerTicker.unref();
    }
  }

  /**
   * Stops 1-second interval ticker.
   */
  #stopTimerTicker(): void {
    if (this.#timerTicker) {
      clearInterval(this.#timerTicker);
      this.#timerTicker = null;
    }
  }

  /**
   * Synchronize reactive messages array with MessagingBus audit log.
   */
  #syncMessages(): void {
    this.messages = this.#messagingBus.getAuditLog();
  }

  /**
   * Synchronize reactive fsSnapshot with VirtualFS.
   *
   * Snapshot export is tenant administration (MOD-21 W8-D/W8-F): the store
   * routes through the runtime persistence port, whose VFS members carry the
   * composition-root `InternalPrincipal` binding. The direct export fallback
   * (runtimes without a persistence port) runs under the resolved
   * operator/substrate context; an unauthorized export leaves the projection
   * empty instead of throwing through the event loop.
   */
  #syncFsSnapshot(): void {
    const vfsPort = typeof this.#runtime?.createPersistencePort === 'function'
      ? this.#runtime.createPersistencePort()?.virtualFs
      : null;
    if (vfsPort && typeof vfsPort.exportSnapshot === 'function') {
      this.fsSnapshot = vfsPort.exportSnapshot() as Record<string, Record<string, FileRecord>>;
      return;
    }
    try {
      this.fsSnapshot = this.#virtualFs.exportSnapshot(this.#operatorSubstrateContext());
    } catch {
      this.fsSnapshot = {};
    }
  }

  /**
   * Synchronize the reactive `realms` projection with the owned registry.
   * Records are cloned so persisted snapshots never alias registry-internal
   * references; reactive state is replaced wholesale (registry order is stable).
   */
  #syncRealms(): void {
    this.realms = this.#realmRegistry.listRealms().map((realm) => cloneRealmRecord(realm));
  }

  /**
   * Synchronize reactive clockSnapshot with WorldClock.
   */
  #syncClockSnapshot(): void {
    if (!this.#worldClock || typeof this.#worldClock.getAllClocks !== 'function') {
      this.clockSnapshot = {};
      return;
    }
    const allClocks = this.#worldClock.getAllClocks(this.#operatorSubstrateContext());
    const snapshot: Record<string, AgentClockState> = {};
    for (const [key, state] of Object.entries(allClocks || {})) {
      snapshot[key] = {
        totalSeconds: state.totalSeconds ?? 0,
        formattedTime: state.formatted ?? state.shortFormatted ?? '00:00:00',
        day: state.day ?? 1,
        hour: state.hour ?? 0,
        minute: state.minute ?? 0,
        second: state.second ?? 0
      };
    }
    if (!snapshot['global'] && typeof this.#worldClock.getTime === 'function') {
      const globalState = this.#worldClock.getTime('global') as TimeState;
      snapshot['global'] = {
        totalSeconds: globalState.totalSeconds ?? 0,
        formattedTime: globalState.formatted ?? globalState.shortFormatted ?? '00:00:00',
        day: globalState.day ?? 1,
        hour: globalState.hour ?? 0,
        minute: globalState.minute ?? 0,
        second: globalState.second ?? 0
      };
    }
    this.clockSnapshot = snapshot;
  }

  /**
   * Emits one store audit event on the runtime event stream (the same channel
   * the publishing-grant events use): extension lifecycle/connection events
   * and the M3 realm-admin inspection/update events, so host subscribers
   * observe install/attach/detach and realm decisions. Emission is
   * observational: a missing or throwing emit port never fails the mutation,
   * and the payload carries ids, display labels, and non-secret metadata only.
   *
   * @param type - Event type (`extension_installed`/`extension_removed`/`extension_attached`/`extension_detached`/`extension_tool_selection_updated`/`realm_inspected`/`realm_updated`).
   * @param payload - Non-secret event payload.
   */
  #emitExtensionAuditEvent(type: string, payload: Record<string, unknown>): void {
    try {
      const port = this.#runtime && typeof this.#runtime.createSubsystemEmitPort === 'function'
        ? this.#runtime.createSubsystemEmitPort()
        : null;
      if (!port || typeof port.emit !== 'function') return;
      port.emit({ type, timestamp: Date.now(), payload });
    } catch {
      // Audit emission is observational; it never fails the mutation.
    }
  }

  /**
   * Handle runtime event emission.
   *
   * @param event - Runtime event forwarded by the subscription.
   */
  #handleRuntimeEvent(event: { type: string; agentId?: string | null }): void {
    // High-frequency streaming tokens: patch only the mutated agent fields with
    // a throttle instead of rebuilding the whole agent list per chunk.
    if (event && event.type === 'stream' && event.agentId) {
      this.#mirrorAgentLiveFields(event.agentId);
      return;
    }
    // Safe-state extension sweep (extension wave, P2.4): a member whose
    // effective grant set changed while it was busy applies at its next turn
    // boundary — immediately after `turn_complete`, never mid-turn.
    if (event && event.type === 'turn_complete' && event.agentId) {
      const memberKey = this.#canonicalRef(event.agentId) || event.agentId;
      if (this.#pendingExtensionReauthorize.has(memberKey)) {
        this.#applyExtensionReauthorize(memberKey);
      }
    }
    // A registration that leaves the active set is never reauthorized later.
    if (
      event
      && (event.type === 'agent_killed' || event.type === 'agent_purged' || event.type === 'agent_recycled')
      && event.agentId
    ) {
      this.#dropPendingExtensionReauthorize(this.#canonicalRef(event.agentId) || event.agentId);
    }
    this.#syncAgents();
    this.#syncRecycleBin();
    // Registration sweep (ticket 9327633): a registration that newly entered
    // the active set — including a child launched through the `spawn_agent`
    // tool's lifecycle port, which never passes the store's grant-composing
    // launch path — receives its Realm-universe grants at its first safe
    // state (an idle registration applies now; a busy one waits for its
    // `turn_complete`). Store-launched and hydration-rebuilt registrations are
    // consumed/primed by the diff and never queue here.
    if (this.#pendingRegistrationSweep.size > 0) {
      const pendingRegistrations = [...this.#pendingRegistrationSweep];
      this.#pendingRegistrationSweep.clear();
      for (const memberKey of pendingRegistrations) {
        this.#queueExtensionReauthorize(memberKey);
      }
    }
    if (
      event.type === 'schedule_registered' ||
      event.type === 'schedule_triggered' ||
      event.type === 'schedule_cancelled' ||
      event.type === 'schedules_imported'
    ) {
      this.#syncScheduledTimers();
      this.#syncAgents();
      this.#syncRecycleBin();
      this.#scheduleAutoSave();
      return;
    }

    if (
      event.type === 'tool_end' ||
      event.type === 'turn_complete' ||
      event.type === 'turn_undone' ||
      event.type === 'turn_redone' ||
      event.type === 'stream_reset' ||
      event.type === 'message_updated' ||
      event.type === 'message_deleted' ||
      event.type === 'agent_config_updated' ||
      event.type === 'state_restored' ||
      event.type === 'agent_recycled' ||
      event.type === 'agent_restored' ||
      event.type === 'agent_purged' ||
      event.type === 'agent_killed' ||
      event.type === 'recycle_bin_emptied'
    ) {
      this.#syncFsSnapshot();
      this.#syncMessages();
      this.#syncScheduledTimers();
      this.#syncRecycleBin();
      this.#syncClockSnapshot();
      this.#scheduleAutoSave();
    }
  }

  /**
   * Handle bus message arrival (envelope payload is intentionally not needed:
   * the store re-projects full state on any bus event).
   */
  #handleBusMessage(): void {
    this.#syncMessages();
    this.#syncAgents();
    this.#scheduleAutoSave();
  }
}

// ============================================================================
// 3. Module Top-Level Factory & Accessor Exports (Strict Whitelist)
// ============================================================================

let defaultStoreInstance: SandboxStore | null = null;

/**
 * Canonical accessor returning the application-wide singleton `SandboxStore` instance.
 * Lazy-initializes the instance on first access.
 * 
 * @returns The application-wide singleton `SandboxStore` instance.
 * 
 * @example
 * ```typescript
 * import { getSandboxStore } from './index.svelte.ts';
 * 
 * const store = getSandboxStore();
 * ```
 */
export function getSandboxStore(): SandboxStore {
  if (!defaultStoreInstance) {
    defaultStoreInstance = new SandboxStore();
  }
  return defaultStoreInstance;
}

/**
 * Factory creating an isolated, fully configured `SandboxStore` instance.
 * Essential for dependency injection, test isolation, and multi-tenancy without leaking global singleton state.
 * 
 * @param options - Optional custom domain engines and auto-hydration flags.
 * @returns A fresh, fully initialized `SandboxStore` instance.
 * 
 * @example
 * ```typescript
 * import { createSandboxStore } from './index.svelte.ts';
 * 
 * const testStore = createSandboxStore({
 *   autoBootstrapDirector: false,
 *   autoHydrate: false
 * });
 * ```
 */
export function createSandboxStore(options: SandboxStoreOptions = {}): SandboxStore {
  return new SandboxStore(options);
}

/**
 * Convenience default singleton instance of `SandboxStore` for direct Svelte 5 component script imports.
 * 
 * @example
 * ```svelte
 * <script>
 *   import { sandboxStore } from '$lib/sandbox/sandboxStore/index.svelte.ts';
 * </script>
 * 
 * <div>Active agents: {sandboxStore.agents.length}</div>
 * ```
 */
export const sandboxStore: SandboxStore = getSandboxStore();
