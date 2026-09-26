/**
 * Saved-payload library facade (ticket 874182b; persistence ticket 81d8267).
 *
 * The library names, lists, attaches, downloads, and deletes operator-held
 * hydration payloads. It is a plain module (no DOM, no runes) so both the
 * launcher and the Realm Manager's rehydrate flow read the same entries, and
 * `createRealmPayloadLibrary()` keeps returning isolated instances for
 * zero-mock tests. Payload digests are the catalog's canonical
 * `payloadDigest`, so a saved row and its download agree with launch
 * provenance.
 *
 * Two call forms share one `RealmPayloadLibrary` contract:
 * - `createRealmPayloadLibrary()` — an isolated session-only library (the
 *   original behavior; entries live until the instance is dropped).
 * - `createRealmPayloadLibrary(backend)` — every operation delegates to the
 *   backend. The module-level `realmPayloadLibrary` singleton delegates to the
 *   application `sandboxStore`, so saved payloads persist across reloads
 *   through the snapshot's additive `savedInstancePayloads` field; the
 *   store-backed form throws the store's coded errors (for example
 *   `ERR_STORE_INVALID_PARAMS`), while the session-only factory keeps
 *   `ERR_REALM_PAYLOAD_LIBRARY`.
 *
 * The facade computes the display summary (`inputSummary`) from the authored
 * payload on read, so the store never needs the UI helper.
 */

import { payloadDigest } from '../../sandbox/realmCatalog/index.ts';
import { getSandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
import type { SavedInstancePayload } from '../../sandbox/sandboxStore/index.svelte.ts';
import { describeRealmPayloadInputs, validateRealmSavedPayloadName } from './realmHydrationHelpers.ts';

/**
 * Input accepted by `saveRealmPayload()`.
 */
export interface RealmSavedPayloadDraft {
  /** Operator-chosen display name (non-empty, unique per library). */
  readonly name: string;
  /** Template id the payload targets. */
  readonly templateId: string;
  /** Effective template version the payload validated against (`sha256:<hex>`). */
  readonly templateVersion: string;
  /** Authored format-v2 payload value. */
  readonly payload: unknown;
}

/**
 * One saved payload entry (deep-frozen; the payload is the authored object).
 */
export interface RealmSavedPayload {
  /** Stable session id. */
  readonly id: string;
  /** Operator-chosen display name. */
  readonly name: string;
  /** Template id the payload targets. */
  readonly templateId: string;
  /** Effective template version the payload validated against. */
  readonly templateVersion: string;
  /** Canonical `payloadDigest` of the payload. */
  readonly digest: string;
  /** Input/file summary (`3 inputs · 2 files`). */
  readonly inputSummary: string;
  /** The authored payload value. */
  readonly payload: Readonly<Record<string, unknown>>;
  /** ISO-8601 save timestamp. */
  readonly savedAt: string;
}

/**
 * Saved-payload library surface.
 */
export interface RealmPayloadLibrary {
  /**
   * Saves one named payload.
   *
   * @param draft - Name, template id/version, and authored payload.
   * @returns The frozen saved entry.
   * @throws Error with code `'ERR_REALM_PAYLOAD_LIBRARY'` for a blank/duplicate name, a non-object payload, or an undigestible value (the session-only factory); a store-backed library surfaces the store's coded errors instead.
   */
  saveRealmPayload(draft: RealmSavedPayloadDraft): RealmSavedPayload;
  /**
   * Lists saved payloads in save order (frozen array, frozen entries).
   *
   * @returns The saved entries.
   */
  listRealmSavedPayloads(): readonly RealmSavedPayload[];
  /**
   * Resolves one saved payload by id.
   *
   * @param id - Entry id.
   * @returns The entry, or `null` when absent.
   */
  getRealmSavedPayload(id: string): RealmSavedPayload | null;
  /**
   * Deletes one saved payload by id.
   *
   * @param id - Entry id.
   * @returns `true` when an entry was removed.
   */
  deleteRealmSavedPayload(id: string): boolean;
  /** Removes every saved payload (session reset). */
  clearRealmSavedPayloads(): void;
  /**
   * Subscribes to library mutations.
   *
   * @param listener - Called after every save/delete/clear.
   * @returns Unsubscribe function.
   */
  subscribe(listener: () => void): () => void;
}

/**
 * Persistence backend accepted by the factory: the store's saved-payload
 * surface. `SandboxStore` satisfies this interface structurally, and the
 * module-level library wires it to the application singleton lazily (each call
 * resolves `getSandboxStore()`).
 */
export interface RealmPayloadLibraryBackend {
  /**
   * Saves one named payload into the backend library.
   *
   * @param draft - Name, template id/version, and authored payload.
   * @returns The stored entry.
   */
  saveInstancePayload(draft: RealmSavedPayloadDraft): SavedInstancePayload;
  /**
   * Lists the stored entries in save order.
   *
   * @returns The stored entries.
   */
  listSavedInstancePayloads(): readonly SavedInstancePayload[];
  /**
   * Resolves one stored entry by id.
   *
   * @param id - Entry id.
   * @returns The entry, or `null` when absent.
   */
  getSavedInstancePayload(id: string): SavedInstancePayload | null;
  /**
   * Deletes one stored entry by id.
   *
   * @param id - Entry id.
   * @returns `true` when an entry was removed.
   */
  deleteSavedInstancePayload(id: string): boolean;
  /** Removes every stored entry. */
  clearSavedInstancePayloads(): void;
  /**
   * Subscribes to backend library mutations.
   *
   * @param listener - Called after every backend mutation.
   * @returns Unsubscribe function.
   */
  subscribeSavedInstancePayloads(listener: () => void): () => void;
}

/** Coded failure raised by the saved-payload library. */
export const REALM_PAYLOAD_LIBRARY_ERROR_CODE = 'ERR_REALM_PAYLOAD_LIBRARY';

/**
 * Builds one coded library error.
 *
 * @param message - Failure text.
 * @returns The coded error.
 */
function libraryError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = REALM_PAYLOAD_LIBRARY_ERROR_CODE;
  return error;
}

/**
 * Copies an authored payload into a frozen plain record (one level of inputs
 * and fileset entries is copied so later caller mutation cannot alter the saved
 * bytes).
 *
 * @param payload - Authored payload value.
 * @returns Frozen plain payload.
 */
function freezePayload(payload: unknown): Readonly<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw libraryError('The payload must be a canonical authored payload object.');
  }
  const source = payload as Record<string, unknown>;
  const inputs = source.inputs && typeof source.inputs === 'object' && !Array.isArray(source.inputs)
    ? (source.inputs as Record<string, unknown>)
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
    ...source,
    ...(inputs ? { inputs: Object.freeze(copiedInputs) } : {})
  });
}

/**
 * Builds one isolated in-memory backend holding the session-only library
 * behavior of the original implementation (validate, digest, freeze, notify).
 *
 * @returns The in-memory backend.
 */
function createInMemorySavedPayloadBackend(): RealmPayloadLibraryBackend {
  const entries: SavedInstancePayload[] = [];
  const listeners = new Set<() => void>();
  let counter = 0;

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A failing listener never blocks a library mutation.
      }
    }
  };

  return {
    saveInstancePayload(draft: RealmSavedPayloadDraft): SavedInstancePayload {
      if (!draft || typeof draft !== 'object') {
        throw libraryError('Saving a payload requires a draft object.');
      }
      const templateId = typeof draft.templateId === 'string' ? draft.templateId.trim() : '';
      if (templateId.length === 0) {
        throw libraryError('The payload must name the template it targets.');
      }
      const templateVersion = typeof draft.templateVersion === 'string' ? draft.templateVersion.trim() : '';
      if (templateVersion.length === 0) {
        throw libraryError('The payload must carry the template version it was validated against.');
      }
      const nameCheck = validateRealmSavedPayloadName(
        draft.name,
        entries.map((entry) => entry.name)
      );
      if (!nameCheck.ok) throw libraryError(nameCheck.error);
      let digest = '';
      try {
        digest = payloadDigest(draft.payload);
      } catch (error) {
        throw libraryError(
          error instanceof Error && error.message ? error.message : 'The payload could not be digested.'
        );
      }
      const payload = freezePayload(draft.payload);
      counter += 1;
      const entry: SavedInstancePayload = Object.freeze({
        id: `saved_payload_${counter}`,
        name: nameCheck.name,
        templateId,
        templateVersion,
        digest,
        payload,
        savedAt: new Date().toISOString()
      });
      entries.push(entry);
      notify();
      return entry;
    },

    listSavedInstancePayloads(): readonly SavedInstancePayload[] {
      return Object.freeze([...entries]);
    },

    getSavedInstancePayload(id: string): SavedInstancePayload | null {
      if (typeof id !== 'string' || id.length === 0) return null;
      return entries.find((entry) => entry.id === id) ?? null;
    },

    deleteSavedInstancePayload(id: string): boolean {
      if (typeof id !== 'string' || id.length === 0) return false;
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      notify();
      return true;
    },

    clearSavedInstancePayloads(): void {
      if (entries.length === 0) return;
      entries.length = 0;
      notify();
    },

    subscribeSavedInstancePayloads(listener: () => void): () => void {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/**
 * Adapts one persistence backend to the `RealmPayloadLibrary` façade: entries
 * pass through verbatim and the display-only `inputSummary` is derived from
 * the authored payload on read.
 *
 * @param backend - Backend implementing the store's saved-payload surface.
 * @returns The library surface.
 */
function adaptBackend(backend: RealmPayloadLibraryBackend): RealmPayloadLibrary {
  const toEntry = (record: SavedInstancePayload): RealmSavedPayload => Object.freeze({
    id: record.id,
    name: record.name,
    templateId: record.templateId,
    templateVersion: record.templateVersion,
    digest: record.digest,
    inputSummary: describeRealmPayloadInputs(record.payload),
    payload: record.payload,
    savedAt: record.savedAt
  });

  return {
    saveRealmPayload(draft: RealmSavedPayloadDraft): RealmSavedPayload {
      return toEntry(backend.saveInstancePayload(draft));
    },

    listRealmSavedPayloads(): readonly RealmSavedPayload[] {
      return Object.freeze(backend.listSavedInstancePayloads().map(toEntry));
    },

    getRealmSavedPayload(id: string): RealmSavedPayload | null {
      const record = backend.getSavedInstancePayload(id);
      return record ? toEntry(record) : null;
    },

    deleteRealmSavedPayload(id: string): boolean {
      return backend.deleteSavedInstancePayload(id);
    },

    clearRealmSavedPayloads(): void {
      backend.clearSavedInstancePayloads();
    },

    subscribe(listener: () => void): () => void {
      if (typeof listener !== 'function') return () => {};
      return backend.subscribeSavedInstancePayloads(listener);
    }
  };
}

/**
 * Creates one saved-payload library over the requested backend, or one
 * isolated session-only library when no backend is given.
 *
 * @param backend - Optional persistence backend (a `SandboxStore` satisfies it structurally).
 * @returns The library surface.
 *
 * @example
 * ```typescript
 * const scratch = createRealmPayloadLibrary();
 * scratch.saveRealmPayload({ name: 'Act 1', templateId: 'session_zero', templateVersion: pin, payload }).digest;
 *
 * // Persisted form: delegates to the application store.
 * const persisted = createRealmPayloadLibrary(sandboxStore);
 * ```
 */
export function createRealmPayloadLibrary(backend?: RealmPayloadLibraryBackend | null): RealmPayloadLibrary {
  return adaptBackend(backend ?? createInMemorySavedPayloadBackend());
}

/**
 * Process-wide saved-payload library shared by the launcher and the Realm
 * Manager's rehydrate flow. It delegates lazily to the application
 * `sandboxStore`, so entries persist across reloads through the snapshot's
 * additive `savedInstancePayloads` field.
 */
export const realmPayloadLibrary: RealmPayloadLibrary = createRealmPayloadLibrary({
  saveInstancePayload: (draft) => getSandboxStore().saveInstancePayload(draft),
  listSavedInstancePayloads: () => getSandboxStore().listSavedInstancePayloads(),
  getSavedInstancePayload: (id) => getSandboxStore().getSavedInstancePayload(id),
  deleteSavedInstancePayload: (id) => getSandboxStore().deleteSavedInstancePayload(id),
  clearSavedInstancePayloads: () => getSandboxStore().clearSavedInstancePayloads(),
  subscribeSavedInstancePayloads: (listener) => getSandboxStore().subscribeSavedInstancePayloads(listener)
});
