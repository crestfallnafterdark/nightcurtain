/**
 * Error taxonomy for the `mcpClient` module.
 *
 * Every operational failure surfaced by `createMcpClient` rejects with an
 * {@link McpClientError} carrying exactly one frozen `MCP_CLIENT_ERROR_CODES`
 * value. Underlying SDK error messages are deliberately not propagated: a
 * server controls its own response text, so echoing it could reflect request
 * headers back through an error channel.
 */

/**
 * Frozen enumeration of the programmatic MCP client error codes.
 *
 * - `ERR_MCP_TRANSPORT_UNSUPPORTED`: the requested transport kind is not the
 *   HTTP transport (the stdio kind is refused before any capability is used).
 * - `ERR_MCP_PLAINTEXT_CREDENTIAL`: a credential was supplied for a non-https
 *   endpoint; the refusal happens before any network activity.
 * - `ERR_MCP_AUTH`: the endpoint rejected the request as unauthorized
 *   (HTTP 401/403 or the SDK's authentication error).
 * - `ERR_MCP_PROTOCOL`: the endpoint answered at the protocol layer with a
 *   JSON-RPC error or a failed protocol-era connection.
 * - `ERR_MCP_TIMEOUT`: the configured request budget elapsed first.
 * - `ERR_MCP_CANCELLED`: a caller or session abort signal cancelled the work.
 * - `ERR_MCP_NETWORK`: the transport failed below the protocol layer (fetch
 *   rejection, connection closed, non-auth HTTP failure, SDK runtime
 *   unavailable, or any unclassified failure).
 * - `ERR_MCP_INVALID_RESPONSE`: a response could not be consumed as MCP
 *   (malformed JSON, schema validation failure, unexpected content type).
 *
 * @example
 * ```typescript
 * import { MCP_CLIENT_ERROR_CODES } from './mcpClient/index.ts';
 *
 * if (err instanceof McpClientError && err.code === MCP_CLIENT_ERROR_CODES.TIMEOUT) {
 *   console.error('MCP request exceeded its budget');
 * }
 * ```
 */
export const MCP_CLIENT_ERROR_CODES: Readonly<{
  readonly TRANSPORT_UNSUPPORTED: 'ERR_MCP_TRANSPORT_UNSUPPORTED';
  readonly PLAINTEXT_CREDENTIAL: 'ERR_MCP_PLAINTEXT_CREDENTIAL';
  readonly AUTH: 'ERR_MCP_AUTH';
  readonly PROTOCOL: 'ERR_MCP_PROTOCOL';
  readonly TIMEOUT: 'ERR_MCP_TIMEOUT';
  readonly CANCELLED: 'ERR_MCP_CANCELLED';
  readonly NETWORK: 'ERR_MCP_NETWORK';
  readonly INVALID_RESPONSE: 'ERR_MCP_INVALID_RESPONSE';
}> = Object.freeze({
  TRANSPORT_UNSUPPORTED: 'ERR_MCP_TRANSPORT_UNSUPPORTED',
  PLAINTEXT_CREDENTIAL: 'ERR_MCP_PLAINTEXT_CREDENTIAL',
  AUTH: 'ERR_MCP_AUTH',
  PROTOCOL: 'ERR_MCP_PROTOCOL',
  TIMEOUT: 'ERR_MCP_TIMEOUT',
  CANCELLED: 'ERR_MCP_CANCELLED',
  NETWORK: 'ERR_MCP_NETWORK',
  INVALID_RESPONSE: 'ERR_MCP_INVALID_RESPONSE'
});

/**
 * Fixed per-code error messages used by the module. Kept internal to the
 * module folder: messages never embed server-controlled or credential text,
 * so they are safe to surface anywhere an error may travel.
 */
export const MCP_CLIENT_ERROR_MESSAGES: Readonly<Record<keyof typeof MCP_CLIENT_ERROR_CODES, string>> =
  Object.freeze({
    TRANSPORT_UNSUPPORTED: 'MCP transport kind is not supported by this client; only the HTTP transport is available',
    PLAINTEXT_CREDENTIAL: 'MCP credentials are refused for plaintext http endpoints; local servers connect unauthenticated',
    AUTH: 'MCP endpoint rejected the request as unauthorized',
    PROTOCOL: 'MCP endpoint returned a protocol-level error',
    TIMEOUT: 'MCP request exceeded its timeout budget',
    CANCELLED: 'MCP request was cancelled',
    NETWORK: 'MCP transport failed',
    INVALID_RESPONSE: 'MCP endpoint returned a response that could not be consumed'
  });

/**
 * Union of every programmatic error code emitted by the `mcpClient` module.
 *
 * @example
 * ```typescript
 * import type { McpClientErrorCode } from './mcpClient/index.ts';
 *
 * function isRetryable(code: McpClientErrorCode): boolean {
 *   return code === 'ERR_MCP_NETWORK' || code === 'ERR_MCP_TIMEOUT';
 * }
 * ```
 */
export type McpClientErrorCode = typeof MCP_CLIENT_ERROR_CODES[keyof typeof MCP_CLIENT_ERROR_CODES];

/**
 * Domain error raised by every operational `mcpClient` failure.
 *
 * The class carries a stable {@link McpClientErrorCode} plus optional
 * structured `details` (shallow-copied and frozen). Messages are fixed
 * per-code descriptions and never embed server-controlled text or credential
 * material, so an error can safely reach logs, receipts, or snapshots.
 *
 * @example
 * ```typescript
 * import { McpClientError, MCP_CLIENT_ERROR_CODES } from './mcpClient/index.ts';
 *
 * try {
 *   await session.callTool('echo', { text: 'hi' });
 * } catch (err) {
 *   if (err instanceof McpClientError && err.code === MCP_CLIENT_ERROR_CODES.TIMEOUT) {
 *     console.error(`MCP call budget elapsed (${String(err.details?.timeoutMs)}ms)`);
 *   }
 * }
 * ```
 */
export class McpClientError extends Error {
  /** Programmatic error code identifying the failure category. */
  declare readonly code: McpClientErrorCode;

  /** Optional diagnostic context, shallow-copied and frozen; `undefined` when omitted. */
  declare readonly details?: Readonly<Record<string, unknown>>;

  /**
   * Constructs a new McpClientError.
   *
   * @param message - Fixed human-readable description of the failure category.
   * @param code - Programmatic code from `MCP_CLIENT_ERROR_CODES`.
   * @param details - Optional safe machine-readable context (HTTP status, SDK code, timeout); shallow-copied and frozen.
   */
  constructor(message: string, code: McpClientErrorCode, details?: Record<string, unknown>) {
    super(message);
    this.name = 'McpClientError';
    this.code = code;
    if (details !== undefined) {
      this.details = Object.freeze({ ...details });
    }
  }
}
