/**
 * Registry implementation for the `extensionRegistry` module: adapter-ingested
 * install records, validated CRUD with freeze/copy isolation, validated
 * attachment helpers, and the live resolution entry point.
 */

import { EXTENSION_REGISTRY_ERROR_CODES } from './errors.ts';
import { resolveExtensionRequests } from './resolve.ts';
import {
  assertAttachment,
  cloneInstallRecord,
  isRecord,
  normalizeInstallRecord,
  registryError
} from './validate.ts';
import type {
  ExtensionInstallRecord,
  ExtensionRegistry,
  ExtensionRegistryOptions,
  ExtensionRegistryStorageAdapter,
  ExtensionResolution,
  ExtensionResolutionRequest,
  RealmExtensionAttachment
} from './types.ts';

/**
 * Reads adapter-loaded records defensively; a missing adapter, a throwing
 * `load()`, or a non-array result all degrade to an empty list.
 *
 * @param storage - Injected adapter, when present
 * @returns The loaded candidate values, or an empty list
 */
function loadEntries(storage: ExtensionRegistryStorageAdapter | null): unknown[] {
  try {
    if (!storage || typeof storage.load !== 'function') return [];
    const loaded: unknown = storage.load();
    return Array.isArray(loaded) ? loaded : [];
  } catch {
    return [];
  }
}

/**
 * Compares two record maps for projection equality (ids and fixed-order
 * normalized fields), so a no-op reconcile never persists.
 *
 * @param left - First record map
 * @param right - Second record map
 * @returns `true` when both maps carry the same records in the same order
 */
function sameRecords(
  left: ReadonlyMap<string, ExtensionInstallRecord>,
  right: ReadonlyMap<string, ExtensionInstallRecord>
): boolean {
  if (left.size !== right.size) return false;
  const rightIds = [...right.keys()];
  let index = 0;
  for (const [id, record] of left) {
    if (rightIds[index] !== id) return false;
    const other = right.get(id);
    if (!other || JSON.stringify(other) !== JSON.stringify(record)) return false;
    index += 1;
  }
  return true;
}

/**
 * Builds a frozen attachment list from caller input, rejecting malformed
 * entries and duplicate extension ids.
 *
 * @param attachments - Candidate attachment list
 * @param label - Human-readable label used in error messages
 * @returns Frozen validated attachment copies
 */
function normalizeAttachmentList(
  attachments: readonly RealmExtensionAttachment[],
  label: string
): readonly RealmExtensionAttachment[] {
  if (!Array.isArray(attachments)) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT, `${label} must be an array`);
  }
  const seen = new Set<string>();
  const normalized: RealmExtensionAttachment[] = [];
  for (const candidate of attachments) {
    const attachment = assertAttachment(candidate, label);
    if (seen.has(attachment.extensionId)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
        `${label} carries duplicate attachment for extension '${attachment.extensionId}'`
      );
    }
    seen.add(attachment.extensionId);
    normalized.push(attachment);
  }
  return Object.freeze(normalized);
}

/**
 * Creates the extension registry service.
 *
 * Overlays adapter-loaded records by id (last-wins) and returns the frozen
 * CRUD, attachment, and resolution surface. All reads hand out frozen fresh
 * copies of frozen internal records, so callers never observe or mutate
 * registry state. The registry owns global install records only: realm
 * attachments are passed in by callers and stay realm-local data.
 *
 * @param options - Injected storage adapter, when present
 * @returns The frozen registry service
 */
export function createExtensionRegistry(options: ExtensionRegistryOptions = {}): ExtensionRegistry {
  const storage: ExtensionRegistryStorageAdapter | null = options && options.storage ? options.storage : null;
  const entries = new Map<string, ExtensionInstallRecord>();

  for (const candidate of loadEntries(storage)) {
    try {
      const record = normalizeInstallRecord(candidate);
      entries.set(record.id, record);
    } catch {
      // Malformed adapter entries are dropped; the remaining records stay usable.
    }
  }

  /**
   * Persists the full frozen install-record projection; adapter failures are
   * swallowed so the in-memory registry stays authoritative.
   */
  function persist(): void {
    if (!storage || typeof storage.save !== 'function') return;
    try {
      storage.save(listExtensions());
    } catch {
      // Persistence is best-effort; the in-memory registry remains authoritative.
    }
  }

  function listExtensions(): readonly ExtensionInstallRecord[] {
    return Object.freeze([...entries.values()].map((record) => cloneInstallRecord(record)));
  }

  function getExtension(id: string): ExtensionInstallRecord | null {
    const entry = typeof id === 'string' ? entries.get(id) : undefined;
    return entry ? cloneInstallRecord(entry) : null;
  }

  function installExtension(record: ExtensionInstallRecord): ExtensionInstallRecord {
    const parsed = normalizeInstallRecord(record);
    if (entries.has(parsed.id)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_DUPLICATE_ID,
        `installExtension refuses duplicate extension id '${parsed.id}'`
      );
    }
    entries.set(parsed.id, parsed);
    persist();
    return cloneInstallRecord(parsed);
  }

  function removeExtension(id: string): boolean {
    if (typeof id !== 'string' || !entries.has(id)) return false;
    entries.delete(id);
    persist();
    return true;
  }

  function reconcile(records: unknown): readonly ExtensionInstallRecord[] {
    const next = new Map<string, ExtensionInstallRecord>();
    if (Array.isArray(records)) {
      for (const candidate of records) {
        try {
          const record = normalizeInstallRecord(candidate);
          next.set(record.id, record);
        } catch {
          // Malformed snapshot entries are dropped individually.
        }
      }
    }
    if (!sameRecords(entries, next)) {
      entries.clear();
      for (const [id, record] of next) entries.set(id, record);
      persist();
    }
    return listExtensions();
  }

  function createAttachment(candidate: RealmExtensionAttachment): RealmExtensionAttachment {
    return assertAttachment(candidate, 'createAttachment');
  }

  function attachExtension(
    attachments: readonly RealmExtensionAttachment[],
    attachment: RealmExtensionAttachment
  ): readonly RealmExtensionAttachment[] {
    const normalized = normalizeAttachmentList(attachments, 'attachExtension attachments');
    const parsed = assertAttachment(attachment, 'attachExtension attachment');
    if (normalized.some((entry) => entry.extensionId === parsed.extensionId)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
        `attachExtension refuses duplicate attachment for extension '${parsed.extensionId}'`
      );
    }
    return Object.freeze([...normalized, parsed]);
  }

  function detachExtension(
    attachments: readonly RealmExtensionAttachment[],
    extensionId: string
  ): readonly RealmExtensionAttachment[] {
    const normalized = normalizeAttachmentList(attachments, 'detachExtension attachments');
    if (typeof extensionId !== 'string' || extensionId.trim().length === 0) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
        'detachExtension requires a non-empty extension id'
      );
    }
    return Object.freeze(normalized.filter((entry) => entry.extensionId !== extensionId));
  }

  function resolve(
    request: ExtensionResolutionRequest,
    attachments: readonly RealmExtensionAttachment[]
  ): ExtensionResolution {
    if (!isRecord(request)) {
      throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION, 'resolve requires a request object');
    }
    return resolveExtensionRequests({
      requests: request.requests,
      toolReferences: request.toolReferences,
      installs: listExtensions(),
      attachments
    });
  }

  return Object.freeze({
    listExtensions,
    getExtension,
    installExtension,
    removeExtension,
    reconcile,
    createAttachment,
    attachExtension,
    detachExtension,
    resolve
  });
}
