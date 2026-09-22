/**
 * Typed error surface for the `realmCatalog` module.
 *
 * The catalog's format-v1 entry points (`parseTemplateBundle`,
 * `validateHydrationPackage`, `templateBundleVersion`) fail closed with a
 * `RealmCatalogError` carrying a stable `code`, so callers can branch on the
 * failure class (malformed transport, invalid template, invalid hydration
 * package, pinned-version mismatch) instead of matching message text. Internal
 * structural validators keep throwing plain `Error`s with the same descriptive
 * messages; the typed entry points wrap them.
 */

/**
 * Frozen dictionary of catalog error codes.
 *
 * @readonly
 */
export const REALM_CATALOG_ERROR_CODES: Readonly<{
  /** A template, agent spec, seed declaration, tool contract, or provider shape is invalid. */
  readonly ERR_TEMPLATE_INVALID: 'ERR_TEMPLATE_INVALID';
  /** The transport envelope is not the canonical `{ formatVersion, template, files }` shape. */
  readonly ERR_BUNDLE_FORMAT: 'ERR_BUNDLE_FORMAT';
  /** The hydration package shape or its slot matching is invalid. */
  readonly ERR_HYDRATION_PACKAGE: 'ERR_HYDRATION_PACKAGE';
  /** The package pins a different template version and the mismatch was not explicitly allowed. */
  readonly ERR_HYDRATION_VERSION_MISMATCH: 'ERR_HYDRATION_VERSION_MISMATCH';
}> = Object.freeze({
  ERR_TEMPLATE_INVALID: 'ERR_TEMPLATE_INVALID',
  ERR_BUNDLE_FORMAT: 'ERR_BUNDLE_FORMAT',
  ERR_HYDRATION_PACKAGE: 'ERR_HYDRATION_PACKAGE',
  ERR_HYDRATION_VERSION_MISMATCH: 'ERR_HYDRATION_VERSION_MISMATCH'
} as const);

/**
 * Union of the catalog's stable error codes.
 */
export type RealmCatalogErrorCode =
  (typeof REALM_CATALOG_ERROR_CODES)[keyof typeof REALM_CATALOG_ERROR_CODES];

/**
 * Domain error thrown by the catalog's typed format-v1 entry points.
 *
 * Carries a programmatic `code` (`RealmCatalogErrorCode`) and optional frozen
 * `details` metadata. The message is the underlying failure description, so
 * message-based assertions keep working while callers gain a stable code.
 *
 * @example
 * ```typescript
 * import { RealmCatalogError, REALM_CATALOG_ERROR_CODES } from './realmCatalog/index.ts';
 *
 * try {
 *   parseTemplateBundle({ formatVersion: 2 });
 * } catch (error) {
 *   if (error instanceof RealmCatalogError) console.error(error.code);
 * }
 * ```
 */
export class RealmCatalogError extends Error {
  /** Stable catalog error code identifying the failure class. */
  declare readonly code: RealmCatalogErrorCode;

  /** Optional structured diagnostics (frozen shallow copy); `undefined` when omitted. */
  declare readonly details?: Readonly<Record<string, unknown>>;

  /**
   * Builds a typed catalog error.
   *
   * @param message - Human-readable failure description (the underlying validator message).
   * @param code - Stable code from {@link REALM_CATALOG_ERROR_CODES}.
   * @param details - Optional diagnostic context, shallow-copied and frozen.
   */
  constructor(message: string, code: RealmCatalogErrorCode, details?: Record<string, unknown>) {
    super(message);
    this.name = 'RealmCatalogError';
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}

/**
 * Renders an unknown thrown value as a message string.
 *
 * @param error - Unknown thrown value
 * @returns The `Error` message, or the stringified value
 */
export function catalogErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Wraps a validation failure into a typed catalog error, preserving the
 * original message; an already-typed catalog error passes through unchanged.
 *
 * @param error - Unknown thrown value
 * @param code - Code to attach when wrapping
 * @param details - Optional diagnostic context
 * @returns A `RealmCatalogError` carrying the failure message
 */
export function toCatalogError(
  error: unknown,
  code: RealmCatalogErrorCode,
  details?: Record<string, unknown>
): RealmCatalogError {
  if (error instanceof RealmCatalogError) return error;
  return new RealmCatalogError(catalogErrorMessage(error), code, details);
}
