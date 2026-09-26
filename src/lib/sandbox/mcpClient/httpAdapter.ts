/**
 * HTTP session adapter for the `mcpClient` module.
 *
 * This is the module's only reference site for the official
 * `@modelcontextprotocol/client` package. The package is loaded exclusively
 * through a cached awaited dynamic import; no static value import exists and
 * module evaluation performs no SDK work. All failure classification happens
 * here so the public surface only ever rejects with {@link McpClientError}.
 */

import { MCP_CLIENT_ERROR_MESSAGES, MCP_CLIENT_ERROR_CODES, McpClientError } from './errors.ts';
import type {
  McpClientCallOptions,
  McpClientCredential,
  McpClientServerInfo,
  McpClientSession,
  McpClientTool,
  McpClientToolCallResult
} from './types.ts';

/**
 * Default per-connection and per-request timeout budget in milliseconds.
 * Callers override it with `McpClientOptions.requestTimeoutMs`.
 */
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 30_000;

/** Client identity advertised during the MCP handshake. */
const MCP_CLIENT_INFO = Object.freeze({
  name: 'nightcurtain-mcp-client',
  version: '1.0.0'
});

/** Dynamically imported SDK module shape; erased at runtime. */
type SdkModule = typeof import('@modelcontextprotocol/client');

/** Cached dynamic-import promise; reset on failure so a later attempt can retry. */
let sdkModulePromise: Promise<SdkModule> | null = null;

/**
 * Loads the official client package through a cached dynamic import.
 *
 * @returns Promise of the SDK module namespace (never evaluated at module load).
 */
function loadSdkModule(): Promise<SdkModule> {
  if (sdkModulePromise === null) {
    sdkModulePromise = import('@modelcontextprotocol/client').catch((error: unknown) => {
      sdkModulePromise = null;
      throw error;
    });
  }
  return sdkModulePromise;
}

/**
 * Normalized, validated HTTP connection input derived from the public options.
 */
export interface NormalizedMcpHttpOptions {
  /** Parsed endpoint URL (scheme already vetted against the credential policy). */
  readonly url: URL;

  /** Bounded timeout budget applied to the handshake and every request. */
  readonly requestTimeoutMs: number;

  /** Credential to transmit as a bearer header, or `null` for anonymous. */
  readonly credential: McpClientCredential | null;

  /** Session-wide abort signal, or `null` when the caller supplied none. */
  readonly signal: AbortSignal | null;
}

/** Extracts a safe error-class label for diagnostics; never returns a message. */
function errorName(error: unknown): string {
  if (error instanceof Error && typeof error.name === 'string' && error.name) return error.name;
  return typeof error === 'string' ? 'string' : 'unknown';
}

/**
 * Whether an error already is (or contains) an abort signal rejection.
 *
 * @param error - Thrown value to inspect.
 * @returns `true` when the value is an AbortError-shaped rejection.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Classifies any SDK/transport failure into the frozen error taxonomy.
 *
 * Abort state wins over every other signal so a cancelled request never
 * masquerades as a timeout (the SDK surfaces both as its internal
 * `REQUEST_TIMEOUT` code). Server-controlled message text is never
 * propagated: only safe machine fields (HTTP status, SDK code, JSON-RPC
 * code, timeout, timeout budget) reach `details`.
 *
 * @param error - Thrown value from the SDK or transport.
 * @param sdk - Loaded SDK module namespace used for brand-matched checks.
 * @param callSignal - Per-call signal, when one was supplied.
 * @param sessionAborted - Whether the session-wide signal has aborted.
 * @param requestTimeoutMs - Configured timeout budget for diagnostics.
 * @returns A classified McpClientError (or the original McpClientError).
 */
function mapSdkFailure(
  error: unknown,
  sdk: SdkModule,
  callSignal: AbortSignal | null | undefined,
  sessionAborted: boolean,
  requestTimeoutMs: number
): McpClientError {
  if (error instanceof McpClientError) return error;

  if (sessionAborted || callSignal?.aborted === true || isAbortError(error)) {
    return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.CANCELLED, MCP_CLIENT_ERROR_CODES.CANCELLED);
  }

  if (error instanceof sdk.SdkHttpError) {
    const status = error.status;
    if (status === 401 || status === 403) {
      return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.AUTH, MCP_CLIENT_ERROR_CODES.AUTH, {
        httpStatus: status,
        sdkCode: error.code
      });
    }
    return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.NETWORK, MCP_CLIENT_ERROR_CODES.NETWORK, {
      httpStatus: status,
      sdkCode: error.code
    });
  }

  if (error instanceof sdk.UnauthorizedError) {
    return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.AUTH, MCP_CLIENT_ERROR_CODES.AUTH);
  }

  if (error instanceof sdk.ProtocolError) {
    return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.PROTOCOL, MCP_CLIENT_ERROR_CODES.PROTOCOL, {
      protocolCode: error.code
    });
  }

  if (error instanceof sdk.SdkError) {
    if (error.code === sdk.SdkErrorCode.RequestTimeout) {
      return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.TIMEOUT, MCP_CLIENT_ERROR_CODES.TIMEOUT, {
        timeoutMs: requestTimeoutMs
      });
    }
    if (
      error.code === sdk.SdkErrorCode.InvalidResult ||
      error.code === sdk.SdkErrorCode.ClientHttpUnexpectedContent ||
      error.code === sdk.SdkErrorCode.UnsupportedResultType
    ) {
      return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.INVALID_RESPONSE, MCP_CLIENT_ERROR_CODES.INVALID_RESPONSE, {
        sdkCode: error.code
      });
    }
    if (error.code === sdk.SdkErrorCode.EraNegotiationFailed) {
      return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.PROTOCOL, MCP_CLIENT_ERROR_CODES.PROTOCOL, {
        sdkCode: error.code
      });
    }
    return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.NETWORK, MCP_CLIENT_ERROR_CODES.NETWORK, {
      sdkCode: error.code
    });
  }

  if (error instanceof SyntaxError || errorName(error) === 'ZodError') {
    return new McpClientError(
      MCP_CLIENT_ERROR_MESSAGES.INVALID_RESPONSE,
      MCP_CLIENT_ERROR_CODES.INVALID_RESPONSE,
      { causeName: errorName(error) }
    );
  }

  if (error instanceof TypeError) {
    return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.NETWORK, MCP_CLIENT_ERROR_CODES.NETWORK, {
      causeName: 'TypeError'
    });
  }

  return new McpClientError(MCP_CLIENT_ERROR_MESSAGES.NETWORK, MCP_CLIENT_ERROR_CODES.NETWORK, {
    causeName: errorName(error)
  });
}

/**
 * Replacement marker for every exact credential occurrence found in a tool
 * result.
 */
const REDACTED_SECRET = '[redacted]';

/**
 * Maximum number of result nodes the scrub walk visits per `callTool` call.
 * A hostile server can return an arbitrarily large or nested result; once the
 * budget is exhausted the remaining subtree is replaced by the marker instead
 * of being traversed further, so the scrub always terminates.
 */
const MAX_SCRUB_NODES = 10_000;

/**
 * Maximum container depth the scrub walk descends before replacing the
 * remaining subtree with the marker (pairs with `MAX_SCRUB_NODES`).
 */
const MAX_SCRUB_DEPTH = 64;

/**
 * Deep-copies a JSON-shaped tool-result value, replacing every exact
 * occurrence of `secret` in strings (keys included) with `[redacted]`.
 *
 * Non-string scalars pass through unchanged, so a result without the secret
 * serializes byte-for-byte identically. Object keys are copied as own data
 * properties (`__proto__` included), so a wire-derived key can never alter
 * the copy's prototype. The walk is bounded by
 * `MAX_SCRUB_NODES`/`MAX_SCRUB_DEPTH`: over-budget subtrees become the
 * marker, guaranteeing termination without leaving an unscanned branch that
 * could still carry the secret.
 *
 * @param value - Candidate result value.
 * @param secret - Non-empty credential secret to redact.
 * @param depth - Current container depth.
 * @param budget - Shared remaining-node budget for the call.
 * @returns Scrubbed copy (or the marker when the budget is exhausted).
 */
function scrubSecretValue(value: unknown, secret: string, depth: number, budget: { remaining: number }): unknown {
  if (budget.remaining <= 0 || depth > MAX_SCRUB_DEPTH) return REDACTED_SECRET;
  budget.remaining -= 1;
  if (typeof value === 'string') {
    return value.includes(secret) ? value.split(secret).join(REDACTED_SECRET) : value;
  }
  if (Array.isArray(value)) {
    return value.map(item => scrubSecretValue(item, secret, depth + 1, budget));
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const scrubbedKey = key.includes(secret) ? key.split(secret).join(REDACTED_SECRET) : key;
      // Own data properties only: a wire-derived `__proto__` key must stay a
      // data key on the copy, never become its prototype (or be dropped).
      Object.defineProperty(copy, scrubbedKey, {
        value: scrubSecretValue(entry, secret, depth + 1, budget),
        enumerable: true,
        writable: true,
        configurable: true
      });
    }
    return copy;
  }
  return value;
}

/**
 * Opens a real HTTP MCP session through the dynamically imported official client.
 *
 * The handshake and every request share the supplied timeout budget; the
 * session-wide signal aborts in-flight work and tears the connection down.
 * The returned session is frozen and its handles stay closure-private.
 *
 * @param options - Normalized HTTP connection input (scheme and credential already vetted).
 * @returns Promise of the connected, frozen session.
 * @throws `McpClientError` - Classified operational failure from the frozen taxonomy.
 */
export async function openSdkHttpSession(options: NormalizedMcpHttpOptions): Promise<McpClientSession> {
  const { url, requestTimeoutMs, credential, signal } = options;

  /** Reads the session signal's abort state without narrowing the parameter. */
  const isSessionAborted = (): boolean => signal !== null && signal.aborted === true;

  if (isSessionAborted()) {
    throw new McpClientError(MCP_CLIENT_ERROR_MESSAGES.CANCELLED, MCP_CLIENT_ERROR_CODES.CANCELLED);
  }

  let sdk: SdkModule;
  try {
    sdk = await loadSdkModule();
  } catch (error) {
    throw new McpClientError(MCP_CLIENT_ERROR_MESSAGES.NETWORK, MCP_CLIENT_ERROR_CODES.NETWORK, {
      causeName: errorName(error)
    });
  }

  const requestInit =
    credential !== null
      ? { headers: Object.freeze({ Authorization: `Bearer ${credential.secret}` }) }
      : undefined;
  const transport = new sdk.StreamableHTTPClientTransport(url, {
    ...(requestInit !== undefined ? { requestInit } : {})
  });
  const client = new sdk.Client(MCP_CLIENT_INFO, { capabilities: {} });

  let closed = false;
  let aborted = false;
  let closePromise: Promise<void> | null = null;

  /**
   * Idempotent teardown: removes the session abort listener and attempts the
   * SDK close once. Close failures are swallowed (best-effort teardown), so a
   * closing session can never leak an unhandled rejection.
   *
   * @returns Promise settling when teardown has been attempted.
   */
  const teardown = (): Promise<void> => {
    if (closePromise === null) {
      closed = true;
      if (signal !== null) {
        try {
          signal.removeEventListener('abort', onAbort);
        } catch {
          // Best-effort teardown: a throwing signal implementation must not break close().
        }
      }
      closePromise = client.close().catch(() => undefined);
    }
    return closePromise;
  };

  /** Session abort handler: marks the session cancelled and tears it down. */
  const onAbort = (): void => {
    aborted = true;
    void teardown();
  };

  if (signal !== null) signal.addEventListener('abort', onAbort, { once: true });

  try {
    await client.connect(transport, {
      timeout: requestTimeoutMs,
      ...(signal !== null ? { signal } : {})
    });
  } catch (error) {
    void teardown();
    throw mapSdkFailure(error, sdk, null, isSessionAborted(), requestTimeoutMs);
  }

  /** Rejects when the session is no longer usable. */
  const ensureActive = (): void => {
    if (aborted) {
      throw new McpClientError(MCP_CLIENT_ERROR_MESSAGES.CANCELLED, MCP_CLIENT_ERROR_CODES.CANCELLED);
    }
    if (closed) {
      throw new McpClientError(MCP_CLIENT_ERROR_MESSAGES.NETWORK, MCP_CLIENT_ERROR_CODES.NETWORK, {
        causeName: 'SessionClosed'
      });
    }
  };

  const rawServerInfo = client.getServerVersion();
  const serverInfo: McpClientServerInfo | null = rawServerInfo
    ? Object.freeze({
        name: String(rawServerInfo.name),
        version: String(rawServerInfo.version),
        ...(rawServerInfo.title !== undefined ? { title: String(rawServerInfo.title) } : {})
      })
    : null;
  const protocolVersion = client.getNegotiatedProtocolVersion() ?? null;

  const session: McpClientSession = {
    serverInfo,
    protocolVersion,

    async listTools(callSignal?: AbortSignal): Promise<readonly McpClientTool[]> {
      ensureActive();
      try {
        const result = await client.listTools(undefined, {
          timeout: requestTimeoutMs,
          ...(callSignal !== undefined ? { signal: callSignal } : {})
        });
        return Object.freeze(
          result.tools.map(tool =>
            Object.freeze({
              name: tool.name,
              ...(tool.title !== undefined ? { title: tool.title } : {}),
              ...(tool.description !== undefined ? { description: tool.description } : {}),
              ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
              ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {})
            })
          )
        );
      } catch (error) {
        throw mapSdkFailure(error, sdk, callSignal, aborted, requestTimeoutMs);
      }
    },

    async callTool(
      name: string,
      args: Readonly<Record<string, unknown>>,
      callOptions?: McpClientCallOptions
    ): Promise<McpClientToolCallResult> {
      ensureActive();
      const callSignal = callOptions?.signal;
      try {
        const result = await client.callTool(
          { name, arguments: args },
          {
            timeout: requestTimeoutMs,
            ...(callSignal !== undefined ? { signal: callSignal } : {})
          }
        );
        const secret = credential?.secret ?? null;
        if (secret === null) {
          return Object.freeze({
            content: Object.freeze([...result.content]),
            isError: result.isError === true,
            ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {})
          });
        }
        const budget = { remaining: MAX_SCRUB_NODES };
        return Object.freeze({
          content: Object.freeze(result.content.map(block => scrubSecretValue(block, secret, 0, budget))),
          isError: result.isError === true,
          ...(result.structuredContent !== undefined
            ? { structuredContent: scrubSecretValue(result.structuredContent, secret, 0, budget) }
            : {})
        });
      } catch (error) {
        throw mapSdkFailure(error, sdk, callSignal, aborted, requestTimeoutMs);
      }
    },

    async close(): Promise<void> {
      await teardown();
    }
  };

  return Object.freeze(session);
}
