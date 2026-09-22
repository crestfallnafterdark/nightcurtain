/**
 * Module-local browser LocalStorage access for the sandboxPersistence module.
 * Private implementation detail of the `sandboxPersistence` module; the public surface is `index.ts`.
 *
 * Owns the canonical sandbox snapshot key and mirrors the JSON semantics,
 * availability probe, and error handling of the retired legacy storage facade,
 * so persisted snapshots stay byte-identical and backward compatible.
 */

/**
 * Canonical browser LocalStorage key for persisted sandbox state.
 * The value is frozen for storage compatibility: existing saved sessions must
 * keep loading through this exact key and JSON shape.
 */
export const SANDBOX_STATE_STORAGE_KEY: string = 'ai_storyteller_sandbox_state_v1';

/**
 * LocalStorage probe key used by the availability round-trip check.
 */
const STORAGE_AVAILABILITY_PROBE_KEY = '__ai_story_storage_test__';

/**
 * Resolves the active LocalStorage handle.
 *
 * Prefers the bare `localStorage` global under a `typeof` guard (browser and
 * worker scopes, where the module must never throw on import or access), then
 * the `window.localStorage` binding used by DOM test environments, then
 * `globalThis.localStorage`.
 *
 * @returns LocalStorage handle when the environment exposes one; `null` otherwise.
 */
export function getRawLocalStorage(): Storage | null {
  if (typeof localStorage !== 'undefined' && localStorage) return localStorage;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  if (typeof globalThis !== 'undefined' && globalThis.localStorage) return globalThis.localStorage;
  return null;
}

/**
 * Availability probe mirroring the retired legacy `storage.isAvailable()`:
 * a set/remove round-trip on a dedicated probe key that never throws.
 *
 * @returns True when LocalStorage is readable and writable; false otherwise.
 */
export function isSandboxLocalStorageAvailable(): boolean {
  try {
    const ls = getRawLocalStorage();
    if (!ls) return false;
    ls.setItem(STORAGE_AVAILABILITY_PROBE_KEY, STORAGE_AVAILABILITY_PROBE_KEY);
    ls.removeItem(STORAGE_AVAILABILITY_PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deserializes the persisted sandbox state entry with the retired legacy
 * `storage.getSandboxState()` semantics: absent, empty, or unparseable entries
 * return `null` and never throw into the load path. Raw-entry quarantine and
 * recovery reporting remain owned by `index.ts`.
 *
 * @returns Parsed snapshot payload when present; `null` when absent or unreadable.
 */
export function readSandboxStateEntry(): unknown | null {
  if (!isSandboxLocalStorageAvailable()) return null;
  try {
    const ls = getRawLocalStorage();
    if (!ls) return null;
    const raw = ls.getItem(SANDBOX_STATE_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as unknown;
  } catch (err) {
    console.warn('[SandboxPersistence] Failed to parse persisted sandbox state:', err);
    return null;
  }
}

/**
 * Serializes and writes a sandbox state snapshot under the canonical key with
 * the retired legacy `storage.saveSandboxState()` semantics: string payloads
 * are written verbatim, object payloads through `JSON.stringify`, and every
 * write failure (quota, disabled storage) is caught and reported as `false`.
 *
 * @param state - Snapshot object or pre-serialized JSON string to persist.
 * @returns `true` when the write succeeded; `false` otherwise.
 */
export function writeSandboxStateEntry(state: unknown): boolean {
  if (!isSandboxLocalStorageAvailable() || !state) return false;
  try {
    const ls = getRawLocalStorage();
    if (!ls) return false;
    const serialized = typeof state === 'string' ? state : JSON.stringify(state);
    ls.setItem(SANDBOX_STATE_STORAGE_KEY, serialized);
    return true;
  } catch (err) {
    console.error('[SandboxPersistence] Failed to save sandbox state:', err);
    return false;
  }
}

/**
 * Removes the canonical sandbox state entry with the retired legacy
 * `storage.clearSandboxState()` semantics.
 *
 * @returns `true` when the entry was removed; `false` when storage is unavailable or removal failed.
 */
export function removeSandboxStateEntry(): boolean {
  if (!isSandboxLocalStorageAvailable()) return false;
  try {
    const ls = getRawLocalStorage();
    if (!ls) return false;
    ls.removeItem(SANDBOX_STATE_STORAGE_KEY);
    return true;
  } catch (err) {
    console.error('[SandboxPersistence] Failed to clear sandbox state:', err);
    return false;
  }
}

/**
 * Fast presence check for a non-empty canonical entry, mirroring the retired
 * legacy `storage.hasSandboxState()` facade (no JSON parsing).
 *
 * @returns `true` when the canonical key holds a truthy raw value; `false` otherwise.
 */
export function hasSandboxStateEntry(): boolean {
  if (!isSandboxLocalStorageAvailable()) return false;
  try {
    const ls = getRawLocalStorage();
    if (!ls) return false;
    return Boolean(ls.getItem(SANDBOX_STATE_STORAGE_KEY));
  } catch {
    return false;
  }
}
