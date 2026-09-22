/**
 * Plain types for the `realmRegistry` module: the realm record shape, the
 * injected storage wiring, the update patch, and the change-event vocabulary.
 */

/**
 * Launch provenance recorded on a Realm record when the Realm was launched
 * from a Realm template (Realm Template Format v1 §5 step 5; Wave T, ticket
 * 0df20ae).
 *
 * Provenance is descriptive metadata, never authority: it records *which*
 * template revision an instance came from and *what* launch inputs it was
 * hydrated with, as hashes only — raw input values and template/package
 * content are never copied onto the record. `resolvedTools` is reserved for
 * the providers wave (Wave P): it persists and hydrates when present but this
 * wave never sets it.
 */
export interface RealmInstanceProvenance {
  /** Template id the Realm was launched from. */
  readonly templateId: string;
  /** Effective template bundle content version (`sha256:<hex>`) at launch. */
  readonly templateVersion: string;
  /** Content hash of the canonical hydration-package serialization, when a package was attached. */
  readonly packageDigest?: string;
  /** Per-input content hashes keyed by declared input id (no raw values). */
  readonly inputHashes: Readonly<Record<string, string>>;
  /** Template-seed destination paths written at launch, in write order (empty when no seed ran). */
  readonly seedPaths: readonly string[];
  /** ISO-8601 timestamp of the launch. */
  readonly launchedAt: string;
  /**
   * Reserved for Wave P: resolved capability id → provider binding
   * (`requirement → publisher/pack@version#hash`). Persisted and hydrated
   * verbatim when present; this wave never sets it.
   */
  readonly resolvedTools?: Readonly<Record<string, string>>;
}

/**
 * One Realm record: an isolated agent grouping owned by the registry.
 *
 * Records are closed-shape plain data (the registry copies only the canonical
 * fields listed here) and are always handed out frozen, so consumers can never
 * mutate registry state through a returned reference.
 */
export interface RealmRecord {
  /** Stable registry key; non-empty and unique per registry. */
  id: string;
  /** User-visible display name; non-empty. */
  name: string;
  /** Optional operator description. */
  description?: string;
  /** Optional UI accent color; presentation-only, never engine semantics. */
  color?: string;
  /** Optional template id the Realm was launched from (template wave). */
  templateId?: string;
  /**
   * Optional launch provenance for template-launched Realms (Wave T, ticket
   * 0df20ae): template revision, package digest, input hashes, seeded paths,
   * and the launch timestamp. Frozen plain data; never authority.
   */
  instance?: RealmInstanceProvenance;
  /** Epoch milliseconds when the Realm record was created. */
  createdAt: number;
}

/**
 * Patch accepted by `RealmRegistry.updateRealm()`. Only the provided fields
 * change; `null` clears an optional field; `id` and `createdAt` are immutable.
 */
export interface RealmUpdatePatch {
  /** Replacement display name; must be a non-empty string when present. */
  name?: string;
  /** Replacement description, or `null` to clear it. */
  description?: string | null;
  /** Replacement accent color, or `null` to clear it. */
  color?: string | null;
  /** Replacement template id, or `null` to clear it. */
  templateId?: string | null;
  /** Replacement launch provenance, or `null` to clear it. */
  instance?: RealmInstanceProvenance | null;
}

/**
 * Runtime vocabulary of registry mutation kinds. `RealmChangeType` is its
 * compile-time mirror; the two are proven exact mirrors below.
 */
export const REALM_CHANGE_TYPES = Object.freeze({
  /** An add completed. */
  ADDED: 'realm-added',
  /** An update completed. */
  UPDATED: 'realm-updated',
  /** A remove completed. */
  REMOVED: 'realm-removed'
} as const);

/** Registry mutation kind carried by {@link RealmChangeEvent}. */
export type RealmChangeType = 'realm-added' | 'realm-updated' | 'realm-removed';

/**
 * Compile-time proof that {@link RealmChangeType} mirrors `REALM_CHANGE_TYPES`
 * in both directions; a drifted vocabulary or union makes the assertion alias
 * fail its constraint.
 */
type _RealmChangeTypeValues = (typeof REALM_CHANGE_TYPES)[keyof typeof REALM_CHANGE_TYPES];

type _RealmChangeTypesInSync = [RealmChangeType] extends [_RealmChangeTypeValues]
  ? [_RealmChangeTypeValues] extends [RealmChangeType]
    ? true
    : false
  : false;

type _AssertTrue<T extends true> = T;

type _RealmChangeTypesSyncCheck = _AssertTrue<_RealmChangeTypesInSync>;

/** Synchronous notification published after a registry mutation. */
export interface RealmChangeEvent {
  /** Mutation kind. */
  type: RealmChangeType;
  /** Id of the added, updated, or removed realm. */
  realmId: string;
}

/** Persistence seam supplied by the composition root. */
export interface RealmRegistryStorageAdapter {
  /** Returns the persisted realm records; unknown or invalid values are dropped. */
  load(): RealmRecord[];
  /** Receives the full registry projection after every mutation. */
  save(realms: RealmRecord[]): void;
}

/** Construction options for `realmRegistry.createRealmRegistry()`. */
export interface RealmRegistryOptions {
  /** Injected persistence adapter for the realm records. */
  storage: RealmRegistryStorageAdapter;
  /**
   * Ids the registry refuses to remove (the composition root's protected
   * records, e.g. the Generic default). `removeRealm` returns `false` for a
   * protected id exactly like for an unknown one — no mutation, no persist, no
   * event — while every other management operation (list/get/add/update) stays
   * available. Ids are matched exactly; absent or empty means no protection.
   */
  protectedIds?: readonly string[];
}

/**
 * Registry service returned by `realmRegistry.createRealmRegistry()`.
 *
 * Every read resolves from the live in-memory registry and returns frozen
 * copies; mutations validate first, persist through the injected adapter, and
 * publish a synchronous {@link RealmChangeEvent}.
 */
export interface RealmRegistry {
  /** Frozen copies of every record, in registry order. */
  listRealms(): readonly RealmRecord[];
  /** Frozen copy of one record, or `null` when unknown. */
  getRealm(id: string): RealmRecord | null;
  /** Adds a new record (rejects duplicate ids) and publishes `realm-added`. */
  addRealm(realm: RealmRecord): RealmRecord;
  /** Patches an existing record and publishes `realm-updated`. */
  updateRealm(id: string, patch: RealmUpdatePatch): RealmRecord;
  /** Removes a record; returns `true` when one existed and was removed and publishes `realm-removed`. Unknown ids and ids declared protected at construction are a `false` no-op (no persist, no event). */
  removeRealm(id: string): boolean;
  /** Subscribes to registry changes; returns an idempotent unsubscribe. */
  subscribe(listener: (event: RealmChangeEvent) => void): () => void;
}
