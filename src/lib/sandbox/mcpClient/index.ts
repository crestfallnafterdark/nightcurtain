/**
 * @packageDocumentation
 * Browser-safe MCP client session factory.
 *
 * The module wraps the official `@modelcontextprotocol/client` package behind a
 * narrow session port: callers receive server identity, the negotiated
 * protocol revision, tool listing, tool invocation, and idempotent close,
 * while the SDK stays confined to the HTTP adapter and loads only on demand.
 *
 * ### Failure taxonomy
 * Every operational failure rejects with {@link McpClientError} carrying one
 * frozen `MCP_CLIENT_ERROR_CODES` value: unsupported transport, plaintext
 * credential refusal, authentication, protocol, timeout, cancellation,
 * network, and invalid response.
 *
 * ### Security posture
 * A credential is transmitted only as an `Authorization: Bearer` header over
 * an `https:` endpoint; a credential supplied for any other scheme is refused
 * before the transport is constructed or any network activity happens, and no
 * failure path embeds credential material or server-controlled message text.
 *
 * @module mcpClient
 * @invariant Dynamic SDK loading: the only runtime reference to the `@modelcontextprotocol/client` package is a cached awaited dynamic import inside the HTTP adapter; module evaluation performs no SDK load, and no static value import of the package (or of the retired v1 `@modelcontextprotocol/sdk` line) exists.
 * @invariant Browser-safe graph: no Node built-in import appears anywhere in the module; the stdio transport kind is refused as unsupported before any process, socket, or SDK call.
 * @invariant Plaintext credential gate: a supplied credential is refused with `ERR_MCP_PLAINTEXT_CREDENTIAL` unless the endpoint URL scheme is `https:`; refusals happen before transport construction, and neither error details nor method results ever carry credential material.
 * @invariant Bounded operations: the handshake and every request carry `McpClientOptions.requestTimeoutMs` (default 30000); caller signals propagate to the SDK, abort classifies as `ERR_MCP_CANCELLED`, an elapsed budget classifies as `ERR_MCP_TIMEOUT`, and every teardown the adapter initiates attaches a rejection handler.
 * @invariant Frozen session surface: `createMcpClient` resolves a frozen session object whose tool listings, call results, server info, and error details are frozen fresh projections; the underlying SDK client and transport handles stay closure-private.
 * @invariant Redacted failure taxonomy: every operational failure rejects with `McpClientError` carrying exactly one `MCP_CLIENT_ERROR_CODES` code and fixed per-code message; underlying SDK messages are not propagated, so server-controlled text cannot reflect request material back through an error channel.
 * @decision The official `@modelcontextprotocol/client` package (pinned 2.1.0) is the wire implementation behind the session factory; the retired v1 `@modelcontextprotocol/sdk` line is deliberately not used
 * @decision The stdio transport is a typed refusal in this contract; a future host bridge would be a separate module implementing the same session port
 * @decision Credentials ride a static `Authorization: Bearer` header on `https:` endpoints only; plaintext local endpoints connect unauthenticated
 */

import { MCP_CLIENT_ERROR_MESSAGES, MCP_CLIENT_ERROR_CODES, McpClientError } from './errors.ts';
import { DEFAULT_MCP_REQUEST_TIMEOUT_MS, openSdkHttpSession } from './httpAdapter.ts';
import { MCP_TRANSPORT_KINDS } from './types.ts';
import type { McpClientCredential, McpClientOptions, McpClientSession, McpHttpTransportHint } from './types.ts';

export { MCP_CLIENT_ERROR_CODES, McpClientError } from './errors.ts';
export type { McpClientErrorCode } from './errors.ts';
export { MCP_TRANSPORT_KINDS } from './types.ts';
export type {
  McpClientCallOptions,
  McpClientCredential,
  McpClientOptions,
  McpClientServerInfo,
  McpClientSession,
  McpClientTool,
  McpClientToolCallResult,
  McpClientTransportHint,
  McpHttpTransportHint,
  McpStdioTransportHint
} from './types.ts';

/**
 * Runtime guard for the HTTP transport hint.
 *
 * @param value - Candidate transport hint.
 * @returns `true` when the value is an object carrying `kind: 'http'`.
 */
function isHttpTransportHint(value: unknown): value is McpHttpTransportHint {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === MCP_TRANSPORT_KINDS.HTTP
  );
}

/**
 * Validates the credential option and returns it unchanged or `null`.
 *
 * @param value - Candidate credential from the public options.
 * @returns The credential, or `null` when absent.
 * @throws `TypeError` - When a present credential lacks non-empty `id`/`secret` strings.
 */
function normalizeCredential(value: McpClientOptions['credential']): McpClientCredential | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'object' ||
    typeof value.id !== 'string' ||
    value.id.trim() === '' ||
    typeof value.secret !== 'string' ||
    value.secret === ''
  ) {
    throw new TypeError("McpClientOptions.credential must carry non-empty 'id' and 'secret' strings");
  }
  return value;
}

/**
 * Resolves the effective request timeout.
 *
 * @param value - Candidate timeout in milliseconds.
 * @returns The supplied positive finite value, or the module default.
 * @throws `TypeError` - When a present value is not a positive finite number.
 */
function normalizeRequestTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MCP_REQUEST_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError('McpClientOptions.requestTimeoutMs must be a positive finite number');
  }
  return value;
}

/**
 * Validates the optional session signal through duck typing.
 *
 * @param value - Candidate signal from the public options.
 * @returns The signal, or `null` when absent.
 * @throws `TypeError` - When a present value is not abort-signal shaped.
 */
function normalizeSignal(value: AbortSignal | undefined): AbortSignal | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'object' ||
    typeof value.aborted !== 'boolean' ||
    typeof value.addEventListener !== 'function'
  ) {
    throw new TypeError('McpClientOptions.signal must be an AbortSignal');
  }
  return value;
}

/**
 * Creates and connects one MCP session over the HTTP transport.
 *
 * Options are validated first: non-HTTP transport kinds are refused with
 * `ERR_MCP_TRANSPORT_UNSUPPORTED`, a credential on a non-`https:` endpoint
 * with `ERR_MCP_PLAINTEXT_CREDENTIAL`, and malformed option values with
 * `TypeError`. Only then is the official client loaded through its dynamic
 * import and the connection attempted.
 *
 * Sessions currently establish the official client's default legacy
 * `initialize` handshake; protocol-era negotiation is not part of this
 * contract.
 *
 * @param options - Transport hint plus optional credential, timeout, and session signal.
 * @returns Promise of the connected, frozen session.
 * @throws `McpClientError` - Classified operational failure from the frozen taxonomy.
 * @throws `TypeError` - Programmer error in the options object.
 *
 * @example
 * ```typescript
 * import { createMcpClient, MCP_CLIENT_ERROR_CODES, McpClientError } from './mcpClient/index.ts';
 *
 * const session = await createMcpClient({
 *   transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
 *   requestTimeoutMs: 15000
 * });
 * try {
 *   for (const tool of await session.listTools()) {
 *     console.log(tool.name);
 *   }
 *   const result = await session.callTool('echo', { text: 'hello' });
 *   console.log(result.content);
 * } catch (err) {
 *   if (err instanceof McpClientError && err.code === MCP_CLIENT_ERROR_CODES.TIMEOUT) {
 *     console.error('MCP call exceeded its budget');
 *   }
 * } finally {
 *   await session.close();
 * }
 * ```
 */
export async function createMcpClient(options: McpClientOptions): Promise<McpClientSession> {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createMcpClient requires an options object');
  }
  if (!isHttpTransportHint(options.transport)) {
    throw new McpClientError(
      MCP_CLIENT_ERROR_MESSAGES.TRANSPORT_UNSUPPORTED,
      MCP_CLIENT_ERROR_CODES.TRANSPORT_UNSUPPORTED
    );
  }
  if (typeof options.transport.url !== 'string' || options.transport.url.trim() === '') {
    throw new TypeError("McpClientOptions.transport.url must be a non-empty string");
  }
  let url: URL;
  try {
    url = new URL(options.transport.url);
  } catch {
    throw new TypeError('McpClientOptions.transport.url must be an absolute URL');
  }

  const credential = normalizeCredential(options.credential);
  if (credential !== null && url.protocol !== 'https:') {
    throw new McpClientError(
      MCP_CLIENT_ERROR_MESSAGES.PLAINTEXT_CREDENTIAL,
      MCP_CLIENT_ERROR_CODES.PLAINTEXT_CREDENTIAL
    );
  }

  const requestTimeoutMs = normalizeRequestTimeout(options.requestTimeoutMs);
  const signal = normalizeSignal(options.signal);

  return openSdkHttpSession({ url, requestTimeoutMs, credential, signal });
}
