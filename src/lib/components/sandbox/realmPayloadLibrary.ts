/**
 * Session-scoped saved-payload library (ticket 874182b candidate lifecycle).
 *
 * The library names, lists, attaches, downloads, and deletes operator-held
 * hydration payloads for the current session. It is a plain module store (no
 * DOM, no runes) so both the launcher and the Realm Manager's rehydrate flow
 * read the same entries, and `createRealmPayloadLibrary()` returns isolated
 * instances for zero-mock tests. Payload digests are the catalog's canonical
 * `payloadDigest`, so a saved row and its download agree with launch provenance.
 *
 * Persistence boundary: entries are session-only by design. Persisting them
 * across reloads requires an additive snapshot field and a store surface; that
 * interface is proposed to the program lead (ticket 874182b) rather than
 * invented here, so the library never writes storage it does not own.
 */

import { payloadDigest } from '../../sandbox/realmCatalog/index.ts';
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
   * @throws Error with code `'ERR_REALM_PAYLOAD_LIBRARY'` for a blank/duplicate name, a non-object payload, or an undigestible value.
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
 * Creates one isolated saved-payload library (session-scoped, no persistence).
 *
 * @returns The library surface.
 *
 * @example
 * ```typescript
 * const library = createRealmPayloadLibrary();
 * library.saveRealmPayload({ name: 'Act 1', templateId: 'session_zero', templateVersion: pin, payload }).digest;
 * ```
 */
export function createRealmPayloadLibrary(): RealmPayloadLibrary {
  const entries: RealmSavedPayload[] = [];
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
    saveRealmPayload(draft: RealmSavedPayloadDraft): RealmSavedPayload {
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
      const entry: RealmSavedPayload = Object.freeze({
        id: `saved_payload_${counter}`,
        name: nameCheck.name,
        templateId,
        templateVersion,
        digest,
        inputSummary: describeRealmPayloadInputs(payload),
        payload,
        savedAt: new Date().toISOString()
      });
      entries.push(entry);
      notify();
      return entry;
    },

    listRealmSavedPayloads(): readonly RealmSavedPayload[] {
      return Object.freeze([...entries]);
    },

    getRealmSavedPayload(id: string): RealmSavedPayload | null {
      if (typeof id !== 'string' || id.length === 0) return null;
      return entries.find((entry) => entry.id === id) ?? null;
    },

    deleteRealmSavedPayload(id: string): boolean {
      if (typeof id !== 'string' || id.length === 0) return false;
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      entries.splice(index, 1);
      notify();
      return true;
    },

    clearRealmSavedPayloads(): void {
      if (entries.length === 0) return;
      entries.length = 0;
      notify();
    },

    subscribe(listener: () => void): () => void {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

/**
 * Process-wide saved-payload library shared by the launcher and the Realm
 * Manager's rehydrate flow (session-only).
 */
export const realmPayloadLibrary: RealmPayloadLibrary = createRealmPayloadLibrary();
