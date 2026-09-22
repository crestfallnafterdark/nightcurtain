/**
 * @packageDocumentation
 * Realm Registry — the authoritative registry of Realm records for the sandbox.
 *
 * The registry owns the canonical in-memory list of Realms (isolated agent
 * groupings), ingests persisted records through an injected storage adapter,
 * exposes validated CRUD with freeze/copy isolation, and publishes synchronous
 * change events. It is the single source of truth for Realm identity and
 * metadata; membership itself lives on `AgentConfig.realmId`.
 *
 * ### Responsibilities
 * - Validated Realm CRUD (`listRealms`/`getRealm`/`addRealm`/`updateRealm`/`removeRealm`).
 * - Adapter-ingested records overlaid by id, with invalid entries dropped.
 * - Synchronous change notification after every registry mutation.
 * - Frozen records and fresh frozen copies on every read.
 * - Protected-id refusal configured by the composition root (e.g. the Generic default): declared ids are never removed while their other management operations stay available.
 *
 * ### Non-responsibilities
 * No agent membership or lifecycle, no filesystem/messaging/clock scoping, no
 * template materialization, no UI presentation, and no ambient I/O:
 * persistence lives behind the injected adapter.
 *
 * @module realmRegistry
 * @invariant INV-IMMUTABILITY: Internal records are frozen; listRealms/getRealm and the adapter projection return frozen fresh copies, never internal references.
 * @invariant INV-COMPLETENESS: Every stored record carries a non-empty id and name and a finite numeric createdAt; addRealm/updateRealm reject invalid input and adapter-loaded entries are dropped when invalid.
 * @invariant INV-IDENTITY: Realm ids are immutable and unique per registry: addRealm refuses duplicate ids, updateRealm never rewrites id or createdAt, and removeRealm of an unknown id is a `false` no-op.
 * @invariant INV-PROTECTION: ids declared protected at construction are never removed: removeRealm returns a `false` no-op without persisting or emitting, while list/get/add/update stay fully available for them.
 * @invariant INV-EVENTS: addRealm/updateRealm/removeRealm emit synchronously after the mutation; listeners observe the post-mutation state, listener exceptions are isolated, and unsubscribe is idempotent.
 * @invariant INV-PURITY: No ambient I/O, no import-time side effects, deterministic outputs; persistence flows only through the injected adapter, whose failures never propagate to callers.
 * @invariant INV-CLOSED-SHAPE: Only the canonical fields id/name/description/color/templateId/createdAt are retained; unknown fields on ingested records are dropped instead of stored.
 * @decision Realm records are plain data with string-only descriptive fields and a finite numeric createdAt; add/update validation is exact-shape and the registry never interprets color/templateId semantics
 * @decision storage.save receives the full frozen registry projection after every mutation; adapter load overlays records by id (last-wins), appends unknown ids, and load/save failures degrade to the in-memory registry
 */

export { createRealmRegistry } from './registry.ts';

export type {
  RealmInstanceProvenance,
  RealmRecord,
  RealmUpdatePatch,
  RealmChangeType,
  RealmChangeEvent,
  RealmRegistryStorageAdapter,
  RealmRegistryOptions,
  RealmRegistry
} from './types.ts';
