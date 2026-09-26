/**
 * @file tests/integration/mcp_client_http_fixture_test.js
 * @description Zero-Mock integration suite: real `mcpClient` sessions driven
 *   over real sockets against the `node:http` MCP fixture.
 *
 * Coverage:
 *  1. Handshake: serverInfo + negotiated protocol revision + frozen session.
 *  2. `listTools`: full fixture tool set, frozen projections, raw schema.
 *  3. `callTool` JSON round-trip: content blocks, isError, frozen result.
 *  4. `callTool` request-scoped SSE response.
 *  5. Server-error mapping (JSON-RPC error → ERR_MCP_PROTOCOL).
 *  6. Timeout mapping (ERR_MCP_TIMEOUT + timeout budget detail).
 *  7. Cancellation mapping (ERR_MCP_CANCELLED; session stays usable).
 *  8. Malformed-response mapping (ERR_MCP_INVALID_RESPONSE).
 *  9. CORS headers + preflight from the fixture.
 * 10. Idempotent close and post-close refusal.
 * 11. Session-wide abort signal.
 *
 * The only non-production object is the fixture's tool behavior itself; the
 * client, SDK transport, sockets, and fixture server are all real.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMcpClient,
  MCP_CLIENT_ERROR_CODES,
  McpClientError
} from '../../src/lib/sandbox/mcpClient/index.ts';
import {
  createMcpFixtureServer,
  MCP_FIXTURE_PROTOCOL_VERSION,
  MCP_FIXTURE_SERVER_INFO,
  MCP_FIXTURE_TOOL_NAMES
} from '../fixtures/mcp/http_fixture_server.mjs';

/**
 * Asserts that a rejection is an McpClientError carrying the expected code.
 *
 * @param {() => Promise<unknown>} fn Rejection-producing thunk.
 * @param {string} code Expected `MCP_CLIENT_ERROR_CODES` value.
 * @returns {Promise<McpClientError>} The asserted error (for detail checks).
 */
async function rejectsWithCode(fn, code) {
  let captured = null;
  await assert.rejects(fn, err => {
    assert.ok(err instanceof McpClientError, `expected McpClientError, got ${String(err)}`);
    assert.equal(err.code, code);
    captured = err;
    return true;
  });
  return captured;
}

/**
 * Boots the fixture and connects a real session to it.
 *
 * @param {object} [overrides] `McpClientOptions` overrides.
 * @returns {Promise<{ fixture: object, session: object }>} Connected harness.
 */
async function connectSession(overrides = {}) {
  const fixture = await createMcpFixtureServer();
  let session;
  try {
    session = await createMcpClient({
      transport: { kind: 'http', url: fixture.url },
      requestTimeoutMs: 5000,
      ...overrides
    });
  } catch (err) {
    await fixture.close();
    throw err;
  }
  return { fixture, session };
}

test('1. handshake exposes server identity, protocol revision, and a frozen session', async () => {
  const { fixture, session } = await connectSession();
  try {
    assert.deepEqual(session.serverInfo, { ...MCP_FIXTURE_SERVER_INFO });
    assert.equal(session.protocolVersion, MCP_FIXTURE_PROTOCOL_VERSION);
    assert.ok(Object.isFrozen(session));
    assert.ok(fixture.requests.some(entry => entry.method === 'initialize'));
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('2. listTools returns the full tool set as frozen projections with raw schemas', async () => {
  const { fixture, session } = await connectSession();
  try {
    const tools = await session.listTools();
    assert.deepEqual(
      tools.map(tool => tool.name).sort(),
      [...MCP_FIXTURE_TOOL_NAMES].sort()
    );
    assert.ok(Object.isFrozen(tools));
    for (const tool of tools) assert.ok(Object.isFrozen(tool));

    const echo = tools.find(tool => tool.name === 'echo');
    assert.equal(typeof echo.description, 'string');
    assert.equal(echo.inputSchema.type, 'object');
    assert.deepEqual(echo.inputSchema.required, ['text']);
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('3. callTool round-trips arguments as frozen content blocks', async () => {
  const { fixture, session } = await connectSession();
  try {
    const result = await session.callTool('echo', { text: 'hello fixture' });
    assert.equal(result.isError, false);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.content));
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    assert.deepEqual(JSON.parse(result.content[0].text), { text: 'hello fixture' });
    assert.ok(fixture.requests.some(entry => entry.method === 'tools/call' && entry.toolName === 'echo'));
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('4. callTool consumes a request-scoped SSE response', async () => {
  const { fixture, session } = await connectSession();
  try {
    const result = await session.callTool('sse', {});
    assert.equal(result.isError, false);
    assert.equal(result.content[0].type, 'text');
    assert.equal(result.content[0].text, 'sse-mode-ok');
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('5. a server JSON-RPC error maps to ERR_MCP_PROTOCOL with its code', async () => {
  const { fixture, session } = await connectSession();
  try {
    const error = await rejectsWithCode(() => session.callTool('fail', {}), MCP_CLIENT_ERROR_CODES.PROTOCOL);
    assert.equal(error.details.protocolCode, -32000);
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('6. an elapsed request budget maps to ERR_MCP_TIMEOUT', async () => {
  const { fixture, session } = await connectSession({ requestTimeoutMs: 250 });
  try {
    const error = await rejectsWithCode(
      () => session.callTool('slow', { delayMs: 5000 }),
      MCP_CLIENT_ERROR_CODES.TIMEOUT
    );
    assert.equal(error.details.timeoutMs, 250);
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('7. an aborted call maps to ERR_MCP_CANCELLED and leaves the session usable', async () => {
  const { fixture, session } = await connectSession();
  try {
    const controller = new AbortController();
    const pending = session.callTool('slow', { delayMs: 5000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await rejectsWithCode(() => pending, MCP_CLIENT_ERROR_CODES.CANCELLED);

    const echoed = await session.callTool('echo', { text: 'still alive' });
    assert.deepEqual(JSON.parse(echoed.content[0].text), { text: 'still alive' });
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('8. a malformed response body maps to ERR_MCP_INVALID_RESPONSE', async () => {
  const { fixture, session } = await connectSession();
  try {
    await rejectsWithCode(
      () => session.callTool('malformed', {}),
      MCP_CLIENT_ERROR_CODES.INVALID_RESPONSE
    );
  } finally {
    await session.close();
    await fixture.close();
  }
});

test('9. the fixture exposes CORS headers and answers preflight', async () => {
  const fixture = await createMcpFixtureServer();
  try {
    const preflight = await fetch(fixture.url, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /Mcp-Session-Id/i);
    assert.match(preflight.headers.get('access-control-expose-headers') ?? '', /Mcp-Session-Id/i);
  } finally {
    await fixture.close();
  }
});

test('10. close is idempotent and post-close calls are refused', async () => {
  const { fixture, session } = await connectSession();
  try {
    assert.equal(await session.close(), undefined);
    assert.equal(await session.close(), undefined);
    await rejectsWithCode(() => session.callTool('echo', {}), MCP_CLIENT_ERROR_CODES.NETWORK);
  } finally {
    await fixture.close();
  }
});

test('11. aborting the session-wide signal cancels the session', async () => {
  const fixture = await createMcpFixtureServer();
  const controller = new AbortController();
  const session = await createMcpClient({
    transport: { kind: 'http', url: fixture.url },
    signal: controller.signal
  });
  try {
    controller.abort();
    await rejectsWithCode(() => session.callTool('echo', {}), MCP_CLIENT_ERROR_CODES.CANCELLED);
  } finally {
    await session.close();
    await fixture.close();
  }
});
