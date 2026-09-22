/**
 * Deep-freeze helper shared by the `realmCatalog` module.
 *
 * The helper is internal to the module and never re-exported from the module
 * surface.
 */

/**
 * Recursively freezes every plain object reachable from the value.
 *
 * Already-frozen branches are skipped, so the call is idempotent and safe on
 * the module's own frozen constants. Callers pass values built by this module,
 * never caller-owned graphs.
 *
 * @param value - Value to freeze in place
 * @returns The same value reference, deeply frozen
 */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      deepFreeze(record[key]);
    }
    Object.freeze(value);
  }
  return value;
}
