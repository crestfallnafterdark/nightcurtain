/**
 * @packageDocumentation
 * Extension Registry — the host's global extension install records, the
 * realm-local attachment vocabulary, and the pure resolution projection that
 * binds a template's requested extensions and `<providerId>::<serverToolName>`
 * tool references to installed, attached extensions.
 *
 * The registry owns global install state: which MCP servers and tool packs the
 * operator has installed, with the non-secret metadata needed to review them
 * (`transportHint`, optional `credentialId`, status, install source, approved
 * URL, normalization warnings). Realm attachments are realm-local data carried
 * on the realm registry's record; this module owns their shape, validation,
 * and the attach/detach list helpers, so one validated vocabulary is used by
 * the realm record, snapshots, and resolution. Resolution is pure and exact:
 * only installed records with an `active` realm attachment resolve, narrowed
 * `toolSelection` lists exclude the tools they do not name, and everything —
 * listings, attachments, `resolvedTools` keys, missing lists — is produced in
 * declared order with frozen outputs.
 *
 * Catalog logic is the module's other pure half: `indexExtensionCatalog`
 * projects one discovery into a frozen call-name catalog (reserved-name
 * rejection, intra-server first-wins shadowing, deterministic digest),
 * `arbitrateExtensionCatalogs` resolves extension↔extension call-name
 * conflicts by explicit connection-completion sequence, and
 * `diffExtensionCatalogs` discloses reconnect drift. This module still never
 * dials anything: the caller hands it discovery output, and connection
 * lifecycle (sessions, sequences, live catalogs) belongs to the composition
 * root.
 *
 * ### Responsibilities
 * - Global install-record CRUD: validated install/remove/list/get with freeze/copy isolation and a snapshot-authoritative reconcile path.
 * - Attachment vocabulary: shape validation (`toolSelection`, status, approval stamp) plus pure attach/detach list helpers.
 * - Resolution: requests + `<providerId>::<serverToolName>` references → `resolvedTools` (sanitized call name → extension id), missing extensions, and missing tools.
 * - Pure catalog logic: discovery indexing + reserved-name/collision hygiene, deterministic arbitration, and reconnect drift diffs.
 * - Adapter-ingested install records overlaid by id, with invalid entries dropped.
 *
 * ### Non-responsibilities
 * No network access, no transport dialing, no connection lifecycle (sessions,
 * operator connect/disconnect, sequence assignment), no execution, no
 * realm-record storage, no runtime authorization, no credentials (a
 * `credentialId` is an id, never a secret), no UI presentation, and no
 * ambient I/O: persistence lives behind the injected adapter, and connection
 * state lives only in memory at the composition root.
 *
 * @module extensionRegistry
 * @invariant INV-PURITY: No ambient I/O, no import-time side effects, deterministic outputs; persistence flows only through the injected adapter, whose failures never propagate to callers.
 * @invariant INV-IMMUTABILITY: Internal install records are frozen; list/get/install/reconcile and every resolution projection return frozen fresh copies, never internal references.
 * @invariant INV-COMPLETENESS: Every stored install record carries a non-empty id, a known kind/status/installSource, a kind-compatible transport hint, and a finite numeric createdAt; invalid input is rejected and adapter-loaded entries are dropped individually.
 * @invariant INV-IDENTITY: Install ids are unique per registry: installExtension refuses a duplicate id, removeExtension of an unknown id is a `false` no-op, and attachments are unique per extension id.
 * @invariant INV-CALL-NAME-HYGIENE: Attachment tool selections carry unique sanitized call names that are neither the internal wildcard nor a reserved baked/publishing name; resolution derives call names the same way and fails closed on reserving or colliding derivations.
 * @invariant INV-EXACT-RESOLUTION: A tool reference resolves only when its extension is installed AND carries an active attachment AND the attachment's tool selection covers the derived call name; missing extensions and missing tools are reported in declared order and never auto-satisfied.
 * @invariant INV-CATALOG-DETERMINISM: Indexing walks server order once and is a pure function of the discovery output: reserved derived names fail the catalog closed, intra-server duplicates resolve first-wins with the shadow recorded, the digest covers the canonical ordered tools+shadows projection and is stable across key order.
 * @invariant INV-ARBITRATION-DETERMINISM: Arbitration processes catalogs by ascending explicit connection-completion sequence (ties broken by extension id) and never by insertion order; the first active extension keeps every contested call name and every later conflicting extension is not activated at all.
 * @decision The global install registry owns installation records only and carries no tool catalog or connection state; realm attachments stay realm-local records validated through this module's attachment normalizer, and realm deletion carries them without a parallel store map
 * @decision Resolution reads host state passed by the caller (installs + attachments) and returns `resolvedTools` as a call name → extension id projection only; conflict arbitration between two active extensions that provide one call name is pure catalog-time logic in this module, while the live connection state that feeds it stays at the composition root
 */

export { createExtensionRegistry } from './registry.ts';
export { resolveExtensionRequests } from './resolve.ts';
export {
  EXTENSION_CATALOG_DIGEST_PREFIX,
  arbitrateExtensionCatalogs,
  diffExtensionCatalogs,
  indexExtensionCatalog
} from './catalog.ts';
export {
  isRealmExtensionAttachment,
  normalizeAttachment as normalizeRealmExtensionAttachment,
  normalizeInstallRecord as normalizeExtensionInstallRecord
} from './validate.ts';
export {
  EXTENSION_REGISTRY_ERROR_CODES,
  ExtensionRegistryError
} from './errors.ts';
export { EXTENSION_KINDS } from './types.ts';
export type { ExtensionRegistryErrorCode } from './errors.ts';

export type {
  ExtensionAttachmentStatus,
  ExtensionCatalog,
  ExtensionCatalogArbitration,
  ExtensionCatalogArbitrationInput,
  ExtensionCatalogConflict,
  ExtensionCatalogDiff,
  ExtensionCatalogDiscoveryTool,
  ExtensionCatalogIndexInput,
  ExtensionCatalogShadow,
  ExtensionCatalogTool,
  ExtensionHttpTransportHint,
  ExtensionInstallRecord,
  ExtensionInstallSource,
  ExtensionInstallStatus,
  ExtensionKind,
  ExtensionPackTransportHint,
  ExtensionRegistry,
  ExtensionRegistryOptions,
  ExtensionRegistryStorageAdapter,
  ExtensionRequest,
  ExtensionResolution,
  ExtensionResolutionInput,
  ExtensionResolutionRequest,
  ExtensionStdioTransportHint,
  ExtensionToolSelection,
  ExtensionTransportHint,
  MissingExtension,
  MissingExtensionReason,
  MissingExtensionTool,
  MissingExtensionToolReason,
  RealmExtensionAttachment
} from './types.ts';
