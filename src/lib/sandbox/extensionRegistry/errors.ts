/**
 * Typed error surface for the `extensionRegistry` module.
 *
 * The registry's typed entry points (`installExtension`, `reconcile`,
 * `createAttachment`, `attachExtension`, `resolveExtensionRequests`) fail
 * closed with an `ExtensionRegistryError` carrying a stable `code`, so callers
 * can branch on the failure class instead of matching message text.
 */

/**
 * Frozen dictionary of extension-registry error codes.
 *
 * @readonly
 */
export const EXTENSION_REGISTRY_ERROR_CODES: Readonly<{
  /** An install record shape, id, transport hint, or field value is invalid. */
  readonly ERR_EXTENSION_INVALID_RECORD: 'ERR_EXTENSION_INVALID_RECORD';
  /** `installExtension` targeted an id that is already installed. */
  readonly ERR_EXTENSION_DUPLICATE_ID: 'ERR_EXTENSION_DUPLICATE_ID';
  /** An attachment shape, tool selection, or duplicate attachment is invalid. */
  readonly ERR_EXTENSION_INVALID_ATTACHMENT: 'ERR_EXTENSION_INVALID_ATTACHMENT';
  /** A resolution request, reference, or context is invalid (including derived call-name collisions). */
  readonly ERR_EXTENSION_INVALID_RESOLUTION: 'ERR_EXTENSION_INVALID_RESOLUTION';
  /** A discovery catalog is malformed or derives a reserved tool call name; the whole catalog fails closed. */
  readonly ERR_EXTENSION_INVALID_CATALOG: 'ERR_EXTENSION_INVALID_CATALOG';
  /** An arbitration input is malformed (bad sequence, duplicate extension id, or duplicate catalog call name). */
  readonly ERR_EXTENSION_INVALID_ARBITRATION: 'ERR_EXTENSION_INVALID_ARBITRATION';
}> = Object.freeze({
  ERR_EXTENSION_INVALID_RECORD: 'ERR_EXTENSION_INVALID_RECORD',
  ERR_EXTENSION_DUPLICATE_ID: 'ERR_EXTENSION_DUPLICATE_ID',
  ERR_EXTENSION_INVALID_ATTACHMENT: 'ERR_EXTENSION_INVALID_ATTACHMENT',
  ERR_EXTENSION_INVALID_RESOLUTION: 'ERR_EXTENSION_INVALID_RESOLUTION',
  ERR_EXTENSION_INVALID_CATALOG: 'ERR_EXTENSION_INVALID_CATALOG',
  ERR_EXTENSION_INVALID_ARBITRATION: 'ERR_EXTENSION_INVALID_ARBITRATION'
} as const);

/**
 * Union of the registry's stable error codes.
 */
export type ExtensionRegistryErrorCode =
  (typeof EXTENSION_REGISTRY_ERROR_CODES)[keyof typeof EXTENSION_REGISTRY_ERROR_CODES];

/**
 * Domain error thrown by the registry's typed entry points.
 *
 * Carries a programmatic `code` (`ExtensionRegistryErrorCode`); the message is
 * the underlying failure description, so message-based assertions keep working
 * while callers gain a stable code.
 *
 * @example
 * ```typescript
 * import { ExtensionRegistryError, EXTENSION_REGISTRY_ERROR_CODES } from './extensionRegistry/index.ts';
 *
 * try {
 *   registry.installExtension({ id: '' });
 * } catch (error) {
 *   if (error instanceof ExtensionRegistryError) console.error(error.code);
 * }
 * ```
 */
export class ExtensionRegistryError extends Error {
  /** Stable registry error code identifying the failure class. */
  declare readonly code: ExtensionRegistryErrorCode;

  /**
   * Builds a typed registry error.
   *
   * @param message - Human-readable failure description.
   * @param code - Stable code from {@link EXTENSION_REGISTRY_ERROR_CODES}.
   */
  constructor(message: string, code: ExtensionRegistryErrorCode) {
    super(message);
    this.name = 'ExtensionRegistryError';
    this.code = code;
  }
}
