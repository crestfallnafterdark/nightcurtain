/**
 * Registry implementation for the `realmRegistry` module: adapter-ingested
 * state, validated CRUD with freeze/copy isolation, synchronous change events,
 * and adapter-failure resilience.
 */

import { normalizeRealmExtensionAttachment } from '../extensionRegistry/index.ts';
import { REALM_CHANGE_TYPES } from './types.ts';
import type {
  RealmChangeEvent,
  RealmExtensionAttachment,
  RealmInstanceProvenance,
  RealmRecord,
  RealmRegistry,
  RealmRegistryOptions,
  RealmRegistryStorageAdapter,
  RealmUpdatePatch
} from './types.ts';

/**
 * Optional realm-record fields copied verbatim when present. Order is fixed so
 * persisted projections are deterministic.
 */
const OPTIONAL_REALM_FIELDS = ['description', 'color', 'templateId'] as const;

/**
 * Narrows an unknown value to a plain record.
 *
 * @param value - Candidate value
 * @returns `true` when the value is a non-null, non-array object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses an unknown value into a plain string-valued record, or `null` when any
 * value is not a string.
 *
 * @param value - Candidate record
 * @returns A fresh string record, or `null` when invalid
 */
function parseStringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const parsed: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    if (typeof value[key] !== 'string') return null;
    parsed[key] = value[key];
  }
  return parsed;
}

/**
 * Freezes one instance-provenance record, copying the nested maps/arrays so a
 * caller can never mutate registry state through a returned reference.
 *
 * @param instance - Provenance record to copy
 * @returns A new deeply frozen provenance record
 */
function freezeInstanceProvenance(instance: RealmInstanceProvenance): RealmInstanceProvenance {
  return Object.freeze({
    templateId: instance.templateId,
    templateVersion: instance.templateVersion,
    ...(instance.packageDigest !== undefined ? { packageDigest: instance.packageDigest } : {}),
    inputHashes: Object.freeze({ ...instance.inputHashes }),
    seedPaths: Object.freeze([...instance.seedPaths]),
    launchedAt: instance.launchedAt,
    ...(instance.resolvedTools !== undefined
      ? { resolvedTools: Object.freeze({ ...instance.resolvedTools }) }
      : {}),
    ...(instance.missingExtensions !== undefined
      ? { missingExtensions: Object.freeze([...instance.missingExtensions]) }
      : {})
  });
}

/**
 * Freezes one realm attachment list as a fresh frozen copy of validated
 * records.
 *
 * @param extensions - Attachment list to copy
 * @returns A new frozen attachment list with valid entries only
 */
function freezeRealmExtensions(
  extensions: readonly RealmExtensionAttachment[]
): readonly RealmExtensionAttachment[] {
  const frozen: RealmExtensionAttachment[] = [];
  for (const candidate of extensions) {
    const attachment = normalizeRealmExtensionAttachment(candidate);
    if (attachment) frozen.push(attachment);
  }
  return Object.freeze(frozen);
}

/**
 * Parses an optional instance-provenance value.
 *
 * `undefined` means "absent"; `null` means "present but invalid" and makes the
 * enclosing realm record invalid (closed-shape strictness for caller input and
 * adapter-loaded entries). Unknown sub-fields are dropped; the canonical shape
 * is `templateId`/`templateVersion`/`launchedAt` (non-empty strings),
 * `inputHashes` (string record), `seedPaths` (string array), and optional
 * `packageDigest` (non-empty string), `resolvedTools` (string record), and
 * `missingExtensions` (array of non-empty strings).
 *
 * @param value - Candidate provenance value
 * @returns The frozen provenance record, `undefined` when absent, or `null` when invalid
 */
function parseInstanceProvenance(
  value: unknown
): RealmInstanceProvenance | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;

  const { templateId, templateVersion, launchedAt } = value;
  if (typeof templateId !== 'string' || templateId.trim().length === 0) return null;
  if (typeof templateVersion !== 'string' || templateVersion.trim().length === 0) return null;
  if (typeof launchedAt !== 'string' || launchedAt.trim().length === 0) return null;

  const inputHashes = parseStringRecord(value.inputHashes);
  if (inputHashes === null) return null;
  if (!Array.isArray(value.seedPaths) || value.seedPaths.some((path) => typeof path !== 'string')) return null;

  let packageDigest: string | undefined;
  if (value.packageDigest !== undefined) {
    if (typeof value.packageDigest !== 'string' || value.packageDigest.trim().length === 0) return null;
    packageDigest = value.packageDigest;
  }

  let resolvedTools: Record<string, string> | undefined;
  if (value.resolvedTools !== undefined) {
    const parsedTools = parseStringRecord(value.resolvedTools);
    if (parsedTools === null) return null;
    resolvedTools = parsedTools;
  }

  let missingExtensions: string[] | undefined;
  if (value.missingExtensions !== undefined) {
    if (!Array.isArray(value.missingExtensions)) return null;
    const parsedMissing: string[] = [];
    for (const candidate of value.missingExtensions) {
      if (typeof candidate !== 'string' || candidate.trim().length === 0) return null;
      parsedMissing.push(candidate);
    }
    missingExtensions = parsedMissing;
  }

  return freezeInstanceProvenance({
    templateId,
    templateVersion,
    ...(packageDigest !== undefined ? { packageDigest } : {}),
    inputHashes,
    seedPaths: value.seedPaths as string[],
    launchedAt,
    ...(resolvedTools !== undefined ? { resolvedTools } : {}),
    ...(missingExtensions !== undefined ? { missingExtensions } : {})
  });
}

/**
 * Builds a frozen registry record carrying only the canonical fields; unknown
 * fields are dropped and absent optional fields stay absent.
 *
 * @param realm - Record to copy and freeze
 * @returns A new frozen record
 */
function freezeRealm(realm: RealmRecord): RealmRecord {
  return Object.freeze({
    id: realm.id,
    name: realm.name,
    ...(realm.description !== undefined ? { description: realm.description } : {}),
    ...(realm.color !== undefined ? { color: realm.color } : {}),
    ...(realm.templateId !== undefined ? { templateId: realm.templateId } : {}),
    ...(realm.instance !== undefined ? { instance: freezeInstanceProvenance(realm.instance) } : {}),
    ...(realm.extensions !== undefined ? { extensions: freezeRealmExtensions(realm.extensions) } : {}),
    createdAt: realm.createdAt
  });
}

/**
 * Parses an optional realm attachment list on an ingested record. A non-array
 * container drops the field; malformed entries are dropped individually while
 * the enclosing realm record survives (attachments are descriptive realm
 * metadata, never identity).
 *
 * @param value - Candidate `extensions` value
 * @returns The frozen attachment list, or `undefined` when absent/dropped
 */
function parseRealmExtensions(
  value: unknown
): readonly RealmExtensionAttachment[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const parsed: RealmExtensionAttachment[] = [];
  for (const candidate of value) {
    const attachment = normalizeRealmExtensionAttachment(candidate);
    if (attachment) parsed.push(attachment);
  }
  return parsed.length > 0 ? Object.freeze(parsed) : undefined;
}

/**
 * Strictly validates a caller-supplied attachment list for
 * `RealmRegistry.updateRealm()`: every entry must be a valid attachment record
 * and attachment ids must be unique, otherwise the whole patch is refused.
 *
 * @param value - Candidate attachment list
 * @returns The frozen validated attachment list
 */
function assertRealmExtensions(value: unknown): readonly RealmExtensionAttachment[] {
  if (!Array.isArray(value)) {
    throw new Error("updateRealm requires an array or null for 'extensions'");
  }
  const parsed: RealmExtensionAttachment[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const attachment = normalizeRealmExtensionAttachment(candidate);
    if (!attachment) {
      throw new Error("updateRealm requires valid extension attachments for 'extensions'");
    }
    if (seen.has(attachment.extensionId)) {
      throw new Error(`updateRealm refuses duplicate extension attachment '${attachment.extensionId}'`);
    }
    seen.add(attachment.extensionId);
    parsed.push(attachment);
  }
  return Object.freeze(parsed);
}

/**
 * Parses an unknown value into a frozen registry record.
 *
 * @param value - Candidate record (adapter value or caller input)
 * @returns The frozen record, or `null` when the shape is invalid
 */
function parseRealm(value: unknown): RealmRecord | null {
  if (!isRecord(value)) return null;
  const { id, name, createdAt } = value;
  if (typeof id !== 'string' || id.trim().length === 0) return null;
  if (typeof name !== 'string' || name.trim().length === 0) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;

  const optional: { description?: string; color?: string; templateId?: string } = {};
  for (const field of OPTIONAL_REALM_FIELDS) {
    const candidate = value[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'string') return null;
    optional[field] = candidate;
  }

  const instance = parseInstanceProvenance(value.instance);
  if (instance === null) return null;

  const extensions = parseRealmExtensions(value.extensions);

  return freezeRealm({
    id,
    name,
    ...optional,
    ...(instance !== undefined ? { instance } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
    createdAt
  });
}

/**
 * Reads adapter-loaded records defensively; a missing adapter, a throwing
 * `load()`, or a non-array result all degrade to an empty list.
 *
 * @param storage - Injected adapter, when present
 * @returns The loaded candidate values, or an empty list
 */
function loadEntries(storage: RealmRegistryStorageAdapter | null): unknown[] {
  try {
    if (!storage || typeof storage.load !== 'function') return [];
    const loaded: unknown = storage.load();
    return Array.isArray(loaded) ? loaded : [];
  } catch {
    return [];
  }
}

/**
 * Creates the realm registry service.
 *
 * Overlays adapter-loaded records by id (last-wins) and returns the frozen
 * CRUD/events surface. All reads hand out frozen copies of frozen internal
 * records, so callers never observe or mutate registry state. Ids listed in
 * `options.protectedIds` are additionally non-removable: `removeRealm` treats
 * them as a `false` no-op (no persist, no event) while every other management
 * operation stays available.
 *
 * @param options - Injected storage adapter and optional protected ids
 * @returns The frozen registry service
 */
export function createRealmRegistry(options: RealmRegistryOptions): RealmRegistry {
  const storage: RealmRegistryStorageAdapter | null = (options && options.storage) || null;
  const protectedIds = new Set<string>();
  if (options && Array.isArray(options.protectedIds)) {
    for (const candidate of options.protectedIds) {
      if (typeof candidate === 'string' && candidate.length > 0) protectedIds.add(candidate);
    }
  }

  const entries = new Map<string, RealmRecord>();
  const listeners = new Set<(event: RealmChangeEvent) => void>();

  for (const candidate of loadEntries(storage)) {
    const parsed = parseRealm(candidate);
    if (parsed) entries.set(parsed.id, parsed);
  }

  /**
   * Persists the full registry projection; adapter failures are swallowed so
   * the in-memory registry stays authoritative.
   */
  function persist(): void {
    if (!storage || typeof storage.save !== 'function') return;
    try {
      storage.save([...entries.values()].map(entry => freezeRealm(entry)));
    } catch {
      // Persistence is best-effort; the in-memory registry remains authoritative.
    }
  }

  /**
   * Publishes one change event to a snapshot of the listener set, isolating
   * listener exceptions from the emitter and from each other.
   *
   * @param event - Mutation kind and affected realm id
   */
  function emit(event: RealmChangeEvent): void {
    const frozen = Object.freeze({ ...event });
    for (const listener of [...listeners]) {
      try {
        listener(frozen);
      } catch {
        // Listener failures are isolated; the mutation result is unaffected.
      }
    }
  }

  function listRealms(): readonly RealmRecord[] {
    return Object.freeze([...entries.values()].map(entry => freezeRealm(entry)));
  }

  function getRealm(id: string): RealmRecord | null {
    const entry = typeof id === 'string' ? entries.get(id) : undefined;
    return entry ? freezeRealm(entry) : null;
  }

  function addRealm(realm: RealmRecord): RealmRecord {
    const parsed = parseRealm(realm);
    if (!parsed) {
      throw new Error(
        'addRealm requires a realm with a non-empty string id and name and a finite numeric createdAt'
      );
    }
    if (entries.has(parsed.id)) {
      throw new Error(`addRealm refuses duplicate realm id '${parsed.id}'`);
    }
    entries.set(parsed.id, parsed);
    persist();
    emit({ type: REALM_CHANGE_TYPES.ADDED, realmId: parsed.id });
    return parsed;
  }

  function updateRealm(id: string, patch: RealmUpdatePatch): RealmRecord {
    const existing = typeof id === 'string' ? entries.get(id) : undefined;
    if (!existing) {
      throw new Error(`updateRealm requires an existing realm id (received '${String(id)}')`);
    }
    if (!isRecord(patch)) {
      throw new Error('updateRealm requires a patch object');
    }

    const next: RealmRecord = {
      id: existing.id,
      name: existing.name,
      ...(existing.description !== undefined ? { description: existing.description } : {}),
      ...(existing.color !== undefined ? { color: existing.color } : {}),
      ...(existing.templateId !== undefined ? { templateId: existing.templateId } : {}),
      ...(existing.instance !== undefined ? { instance: existing.instance } : {}),
      ...(existing.extensions !== undefined ? { extensions: existing.extensions } : {}),
      createdAt: existing.createdAt
    };

    if ('name' in patch) {
      if (typeof patch.name !== 'string' || patch.name.trim().length === 0) {
        throw new Error('updateRealm requires a non-empty string name when name is patched');
      }
      next.name = patch.name;
    }

    for (const field of OPTIONAL_REALM_FIELDS) {
      if (!(field in patch)) continue;
      const value = patch[field];
      if (value === null) {
        delete next[field];
        continue;
      }
      if (typeof value !== 'string') {
        throw new Error(`updateRealm requires a string or null value for '${field}'`);
      }
      next[field] = value;
    }

    // Launch provenance (Wave T, ticket 0df20ae): a valid record replaces the
    // previous provenance, `null` clears it, and any other shape is refused.
    if ('instance' in patch) {
      if (patch.instance === null) {
        delete next.instance;
      } else {
        const parsedInstance = parseInstanceProvenance(patch.instance);
        if (parsedInstance === null || parsedInstance === undefined) {
          throw new Error("updateRealm requires a valid instance provenance object or null for 'instance'");
        }
        next.instance = parsedInstance;
      }
    }

    // Realm-local extension attachments (extension wave): a valid list
    // replaces the previous attachments, `null` clears them, and every entry
    // must validate — a malformed list never partially applies.
    if ('extensions' in patch) {
      if (patch.extensions === null) {
        delete next.extensions;
      } else {
        const parsedExtensions = assertRealmExtensions(patch.extensions);
        if (parsedExtensions.length === 0) {
          delete next.extensions;
        } else {
          next.extensions = parsedExtensions;
        }
      }
    }

    const parsed = parseRealm(next);
    if (!parsed) {
      throw new Error('updateRealm produced an invalid realm record');
    }
    entries.set(parsed.id, parsed);
    persist();
    emit({ type: REALM_CHANGE_TYPES.UPDATED, realmId: parsed.id });
    return parsed;
  }

  function removeRealm(id: string): boolean {
    if (typeof id !== 'string' || !entries.has(id)) return false;
    if (protectedIds.has(id)) return false;
    entries.delete(id);
    persist();
    emit({ type: REALM_CHANGE_TYPES.REMOVED, realmId: id });
    return true;
  }

  function subscribe(listener: (event: RealmChangeEvent) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('subscribe requires a listener function');
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  return Object.freeze({
    listRealms,
    getRealm,
    addRealm,
    updateRealm,
    removeRealm,
    subscribe
  });
}
