/**
 * Structural port types for the `mcpClient` module.
 *
 * The types mirror only the wire-facing facts this module exposes; they never
 * reference the official client package's declarations, so consumers stay
 * decoupled from the SDK and the SDK can be swapped behind the same surface.
 */

/**
 * Frozen runtime vocabulary of the transport discriminators; the `kind`
 * literals of {@link McpHttpTransportHint} and {@link McpStdioTransportHint}
 * are its compile-time mirrors. The constants exist so callers can build and
 * compare hints without spelling the string literals.
 *
 * @example
 * ```typescript
 * import { MCP_TRANSPORT_KINDS } from './mcpClient/index.ts';
 *
 * if (hint.kind === MCP_TRANSPORT_KINDS.HTTP) {
 *   console.log('Streamable HTTP endpoint:', hint.url);
 * }
 * ```
 */
export const MCP_TRANSPORT_KINDS: Readonly<{
  /** The Streamable HTTP transport family. */
  readonly HTTP: 'http';
  /** The child-process stdio transport kind (refused by this module). */
  readonly STDIO: 'stdio';
}> = Object.freeze({
  HTTP: 'http',
  STDIO: 'stdio'
} as const);


/**
 * HTTP transport hint: a Streamable HTTP MCP endpoint URL.
 *
 * The URL scheme carries the credential policy: `https:` may carry a
 * credential, any other scheme is unauthenticated by contract.
 */
export interface McpHttpTransportHint {
  /** Discriminator for the HTTP transport family. */
  readonly kind: 'http';

  /** Absolute endpoint URL (`https:` for credentialed endpoints). */
  readonly url: string;
}

/**
 * stdio transport hint.
 *
 * The shape is declared so callers and frozen records can carry it, but this
 * module refuses it with `ERR_MCP_TRANSPORT_UNSUPPORTED`; no child-process
 * capability is reachable from the browser-safe graph.
 */
export interface McpStdioTransportHint {
  /** Discriminator for the stdio transport kind. */
  readonly kind: 'stdio';

  /** Executable that would be launched. */
  readonly command: string;

  /** Optional argument vector for the executable. */
  readonly args?: readonly string[];
}

/**
 * Transport hint accepted by {@link McpClientOptions}.
 *
 * @example
 * ```typescript
 * import type { McpClientTransportHint } from './mcpClient/index.ts';
 *
 * const hint: McpClientTransportHint = { kind: 'http', url: 'https://mcp.example.com/mcp' };
 * ```
 */
export type McpClientTransportHint = McpHttpTransportHint | McpStdioTransportHint;

/**
 * Credential material resolved by the caller (typically from the sandbox
 * credential vault) for a single connection.
 *
 * The `id` identifies the vault entry the caller resolved; only `secret` is
 * transmitted, as an `Authorization: Bearer` header over `https:`.
 */
export interface McpClientCredential {
  /** Opaque vault identifier the secret was resolved from; never transmitted. */
  readonly id: string;

  /** Secret token transmitted as the bearer credential. */
  readonly secret: string;
}

/**
 * Construction options for one MCP session.
 *
 * @example
 * ```typescript
 * import type { McpClientOptions } from './mcpClient/index.ts';
 *
 * const options: McpClientOptions = {
 *   transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
 *   credential: { id: 'mcp_acme', secret: 'vault-provided' },
 *   requestTimeoutMs: 15000
 * };
 * ```
 */
export interface McpClientOptions {
  /** Transport hint selecting the endpoint to connect to. */
  readonly transport: McpClientTransportHint;

  /**
   * Optional credential for the endpoint. Supplying one for a non-`https:`
   * URL is refused with `ERR_MCP_PLAINTEXT_CREDENTIAL`; `null` and omission
   * both mean unauthenticated.
   */
  readonly credential?: McpClientCredential | null;

  /**
   * Per-connection and per-request timeout budget in milliseconds. Must be a
   * positive finite number when present.
   *
   * Default: `30000`.
   */
  readonly requestTimeoutMs?: number;

  /**
   * Session-wide abort signal. Aborting it cancels in-flight work (classified
   * as `ERR_MCP_CANCELLED`) and tears the connection down.
   */
  readonly signal?: AbortSignal;
}

/**
 * Per-call options accepted by {@link McpClientSession.callTool}.
 */
export interface McpClientCallOptions {
  /** Per-call abort signal; aborting classifies the rejection as `ERR_MCP_CANCELLED`. */
  readonly signal?: AbortSignal;
}

/**
 * Server identity reported during connection establishment.
 */
export interface McpClientServerInfo {
  /** Server-reported program name. */
  readonly name: string;

  /** Server-reported program version. */
  readonly version: string;

  /** Optional server-reported display title. */
  readonly title?: string;
}

/**
 * One tool advertised by the connected server.
 *
 * Schemas are surfaced verbatim as received JSON; projecting them into the
 * sandbox tool schema dialect is a separate concern owned downstream.
 */
export interface McpClientTool {
  /** Wire tool name. */
  readonly name: string;

  /** Optional server-reported display title. */
  readonly title?: string;

  /** Optional human-readable description. */
  readonly description?: string;

  /** Raw JSON Schema of the tool input, when the server supplied one. */
  readonly inputSchema?: unknown;

  /** Raw JSON Schema of the tool structured output, when supplied. */
  readonly outputSchema?: unknown;
}

/**
 * One tool invocation result.
 */
export interface McpClientToolCallResult {
  /** Raw MCP content blocks returned by the server (frozen array, shared block references). */
  readonly content: readonly unknown[];

  /** Whether the server marked the invocation as a tool-level failure. */
  readonly isError: boolean;

  /** Optional structured result payload, when the server supplied one. */
  readonly structuredContent?: unknown;
}

/**
 * Connected MCP session handle.
 *
 * The object is frozen; every method result is a frozen fresh projection, and
 * the underlying SDK client/transport handles stay closure-private. A session
 * is single-connection: `close()` is idempotent, and calls after close (or
 * after a session-wide abort) reject with a typed error.
 *
 * @example
 * ```typescript
 * import { createMcpClient } from './mcpClient/index.ts';
 *
 * const session = await createMcpClient({
 *   transport: { kind: 'http', url: 'https://mcp.example.com/mcp' }
 * });
 * try {
 *   const tools = await session.listTools();
 *   const result = await session.callTool('echo', { text: 'hello' });
 *   console.log(tools.length, result.content.length);
 * } finally {
 *   await session.close();
 * }
 * ```
 */
export interface McpClientSession {
  /** Server identity from the handshake, or `null` when the server reported none. */
  readonly serverInfo: McpClientServerInfo | null;

  /** Negotiated protocol revision, or `null` when the connection reported none. */
  readonly protocolVersion: string | null;

  /**
   * Lists every tool the server currently advertises (all pages aggregated by
   * the client), as frozen projections.
   *
   * @param signal - Optional per-call abort signal.
   * @returns Frozen array of frozen tool projections.
   */
  listTools(signal?: AbortSignal): Promise<readonly McpClientTool[]>;

  /**
   * Invokes one tool by wire name.
   *
   * @param name - Wire tool name as advertised by the server.
   * @param args - JSON-serializable argument object (empty object for no-arg tools).
   * @param options - Optional per-call signal.
   * @returns Frozen invocation result with frozen content array.
   */
  callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options?: McpClientCallOptions
  ): Promise<McpClientToolCallResult>;

  /**
   * Closes the session (best-effort teardown; never throws) and releases the
   * underlying connection. Idempotent.
   *
   * @returns Promise settling when teardown has been attempted.
   */
  close(): Promise<void>;
}
