/**
 * @file tests/fixtures/mcp/http_fixture_server.mjs
 * @description Real `node:http` MCP fixture server for the `mcpClient`
 *   integration suite.
 *
 * The fixture speaks the legacy MCP `initialize` handshake and implements
 * `tools/list` and `tools/call` for four behavior tools:
 *
 *  - `echo`: JSON response carrying the arguments back as text content;
 *  - `fail`: JSON-RPC error response (protocol-level failure);
 *  - `slow`: no response before the caller's timeout/abort (`delayMs` arg);
 *  - `sse`: request-scoped Server-Sent Events response;
 *  - `malformed`: 200 `application/json` body that is not valid JSON.
 *
 * Every response carries CORS headers (including an `OPTIONS` preflight) so the
 * same fixture can back a browser-targeted spec later. It is importable
 * (`createMcpFixtureServer`) and standalone-startable
 * (`node tests/fixtures/mcp/http_fixture_server.mjs`).
 *
 * No secrets are handled anywhere in this file: only method names and tool
 * names are recorded, never request bodies, headers, or credentials.
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Protocol revision replayed by the legacy handshake. */
export const MCP_FIXTURE_PROTOCOL_VERSION = '2025-06-18';

/** Server identity replayed during the handshake. */
export const MCP_FIXTURE_SERVER_INFO = Object.freeze({
  name: 'mcp-http-fixture',
  version: '1.0.0'
});

/** Session id emitted on the handshake response and expected on later requests. */
export const MCP_FIXTURE_SESSION_ID = 'fixture-session-1';

/** Tool names advertised by `tools/list`. */
export const MCP_FIXTURE_TOOL_NAMES = Object.freeze(['echo', 'fail', 'slow', 'sse', 'malformed']);

/** CORS headers applied to every fixture response. */
const CORS_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '600'
});

/** Tool descriptors advertised by `tools/list`. */
const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'echo',
    description: 'Returns the supplied text argument as a text content block.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ text: Object.freeze({ type: 'string' }) }),
      required: Object.freeze(['text'])
    })
  }),
  Object.freeze({
    name: 'fail',
    description: 'Always answers with a JSON-RPC error.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
      additionalProperties: false
    })
  }),
  Object.freeze({
    name: 'slow',
    description: 'Delays its response by the requested delayMs.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ delayMs: Object.freeze({ type: 'number' }) })
    })
  }),
  Object.freeze({
    name: 'sse',
    description: 'Answers through a request-scoped text/event-stream response.',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}) })
  }),
  Object.freeze({
    name: 'malformed',
    description: 'Answers with an application/json body that is not valid JSON.',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({}) })
  })
]);

/**
 * Applies the CORS headers to a response before its status line is written.
 *
 * @param {import('node:http').ServerResponse} res Response to decorate.
 */
function applyCors(res) {
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(name, value);
  }
}

/**
 * Writes a JSON response with the fixture's CORS headers.
 *
 * @param {import('node:http').ServerResponse} res Response to write.
 * @param {number} status HTTP status code.
 * @param {unknown} payload JSON-serializable payload.
 * @param {Record<string, string>} [extraHeaders] Additional headers.
 */
function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

/**
 * Writes a JSON-RPC error response.
 *
 * @param {import('node:http').ServerResponse} res Response to write.
 * @param {string|number|null} id Request id to echo.
 * @param {number} code JSON-RPC error code.
 * @param {string} message Error message.
 * @param {unknown} [data] Optional error data.
 */
function sendJsonRpcError(res, id, code, message, data) {
  sendJson(res, 200, {
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) }
  });
}

/**
 * Reads the full request body as UTF-8 text.
 *
 * @param {import('node:http').IncomingMessage} req Incoming request.
 * @returns {Promise<string>} Request body text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Handles one `tools/call` request.
 *
 * @param {import('node:http').ServerResponse} res Response to write.
 * @param {object} message Parsed JSON-RPC request.
 * @param {{ pendingTimers: Set<ReturnType<typeof setTimeout>>, requests: object[] }} state Fixture state.
 */
function handleToolCall(res, message, state) {
  const name = message.params?.name;
  const args = message.params?.arguments ?? {};
  state.requests.push({ method: 'tools/call', toolName: typeof name === 'string' ? name : '(missing)' });

  if (name === 'echo') {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(args) }],
        isError: false
      }
    });
    return;
  }

  if (name === 'fail') {
    sendJsonRpcError(res, message.id, -32000, 'fixture tool failure', { kind: 'fixture-tool-error' });
    return;
  }

  if (name === 'slow') {
    const requested = Number(args.delayMs);
    const delayMs = Number.isFinite(requested) && requested >= 0 ? requested : 2000;
    const timer = setTimeout(() => {
      state.pendingTimers.delete(timer);
      sendJson(res, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: 'slow-complete' }],
          isError: false
        }
      });
    }, delayMs);
    state.pendingTimers.add(timer);
    return;
  }

  if (name === 'sse') {
    if (res.writableEnded || res.destroyed) return;
    const event = {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [{ type: 'text', text: 'sse-mode-ok' }],
        isError: false
      }
    };
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`event: message\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
    return;
  }

  if (name === 'malformed') {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end('{"jsonrpc":"2.0", "id": 1, "result": {');
    return;
  }

  sendJsonRpcError(res, message.id, -32602, `Unknown tool: ${String(name)}`);
}

/**
 * Handles one parsed JSON-RPC message.
 *
 * @param {import('node:http').ServerResponse} res Response to write.
 * @param {object} message Parsed JSON-RPC message.
 * @param {{ pendingTimers: Set<ReturnType<typeof setTimeout>>, requests: object[] }} state Fixture state.
 */
function handleMessage(res, message, state) {
  if (message === null || typeof message !== 'object' || typeof message.method !== 'string') {
    sendJsonRpcError(res, null, -32600, 'Invalid Request');
    return;
  }

  if (message.method === 'initialize') {
    state.requests.push({ method: 'initialize' });
    sendJson(
      res,
      200,
      {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: MCP_FIXTURE_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { ...MCP_FIXTURE_SERVER_INFO }
        }
      },
      { 'Mcp-Session-Id': MCP_FIXTURE_SESSION_ID }
    );
    return;
  }

  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    state.requests.push({ method: message.method });
    if (!res.writableEnded && !res.destroyed) {
      res.writeHead(202, CORS_HEADERS);
      res.end();
    }
    return;
  }

  if (message.method === 'tools/list') {
    state.requests.push({ method: 'tools/list' });
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: TOOL_DEFINITIONS.map(tool => ({ ...tool })) }
    });
    return;
  }

  if (message.method === 'tools/call') {
    handleToolCall(res, message, state);
    return;
  }

  sendJsonRpcError(res, message.id, -32601, `Method not found: ${message.method}`);
}

/**
 * Creates and starts the MCP fixture server.
 *
 * @param {object} [options] Fixture options.
 * @param {number} [options.port] Listen port (`0` selects an ephemeral port).
 * @param {string} [options.host] Listen host.
 * @returns {Promise<{ url: string, port: number, requests: object[], close: () => Promise<void> }>}
 *   Fixture handle; `requests` records `{ method, toolName? }` entries only.
 */
export async function createMcpFixtureServer(options = {}) {
  const port = Number.isInteger(options.port) ? options.port : 0;
  const host = typeof options.host === 'string' && options.host ? options.host : '127.0.0.1';
  const state = { pendingTimers: new Set(), requests: [] };

  const server = http.createServer((req, res) => {
    applyCors(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET') {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('SSE stream not offered by the fixture');
      }
      return;
    }
    if (req.method === 'DELETE') {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
      return;
    }
    if (req.method !== 'POST') {
      if (!res.writableEnded && !res.destroyed) {
        res.writeHead(405, { 'Content-Type': 'text/plain' });
        res.end('Method not allowed');
      }
      return;
    }

    readBody(req)
      .then(bodyText => {
        let parsed;
        try {
          parsed = JSON.parse(bodyText);
        } catch {
          sendJsonRpcError(res, null, -32700, 'Parse error');
          return;
        }
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        for (const message of messages) {
          handleMessage(res, message, state);
        }
      })
      .catch(() => {
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Bad request');
        }
      });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://${host}:${boundPort}/mcp`,
    port: boundPort,
    requests: state.requests,
    /**
     * Stops the server, clears pending slow-tool timers, and severs open
     * connections.
     *
     * @returns {Promise<void>} Resolves once the listener is closed.
     */
    async close() {
      for (const timer of state.pendingTimers) clearTimeout(timer);
      state.pendingTimers.clear();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}

/**
 * Standalone entry: `node tests/fixtures/mcp/http_fixture_server.mjs`.
 * Honors `MCP_FIXTURE_PORT` (default `8791`) and prints the endpoint URL.
 */
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  const port = Number.parseInt(process.env.MCP_FIXTURE_PORT ?? '', 10);
  const fixture = await createMcpFixtureServer({ port: Number.isInteger(port) ? port : 8791 });
  console.log(`MCP http fixture listening on ${fixture.url}`);
}
