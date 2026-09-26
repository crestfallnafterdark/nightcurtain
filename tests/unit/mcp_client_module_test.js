/**
 * @file tests/unit/mcp_client_module_test.js
 * @description Unit suite for the `mcpClient` module surface.
 *
 * Coverage:
 *  1. stdio typed refusal with zero transport activity.
 *  2. Plaintext credential refusal with zero transport activity and no
 *     credential leakage into the error.
 *  3. Option-shape validation (`TypeError` for programmer errors).
 *  4. Credential transmission as a bearer header on `https:` + frozen surface.
 *  5. Failure taxonomy at the `globalThis.fetch` seam: network, timeout,
 *     cancellation, authentication, protocol, malformed response.
 *  6. Frozen error dictionary and `McpClientError` shape.
 *  7. Session-wide abort signal cancellation.
 *
 * Zero-Mock Verification: the module and the official SDK client are real;
 * the only injected seam is the documented `globalThis.fetch` boundary, and
 * the stub is a frozen plain function returning real `Response` instances.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMcpClient,
  MCP_CLIENT_ERROR_CODES,
  McpClientError
} from '../../src/lib/sandbox/mcpClient/index.ts';

/** The process fetch implementation, restored after every seam test. */
const REAL_FETCH = globalThis.fetch;

/**
 * Builds a JSON `Response` for the fetch stub.
 *
 * @param {object} payload JSON-serializable payload.
 * @param {number} [status] HTTP status.
 * @returns {Response} Real Response instance.
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * Builds a frozen fetch stub that answers the MCP handshake and dispatches
 * per-RPC-method handlers.
 *
 * @param {Record<string, (record: object) => Response|Promise<Response>>} [handlers]
 *   Handlers keyed by JSON-RPC method; the record carries `{ requestMethod, rpcMethod, url, init, body }`.
 * @returns {Function & { calls: object[] }} Frozen stub with a live `calls` log.
 */
function createFetchStub(handlers = {}) {
  const calls = [];
  const stub = async (url, init = {}) => {
    const requestMethod = String(init.method ?? 'GET').toUpperCase();
    let body = null;
    if (typeof init.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = null;
      }
    }
    const rpcMethod = body && typeof body === 'object' && typeof body.method === 'string' ? body.method : null;
    const record = { requestMethod, rpcMethod, url: String(url), init, body };
    calls.push(record);

    const handler = rpcMethod !== null ? handlers[rpcMethod] : undefined;
    if (typeof handler === 'function') return handler(record);
    if (requestMethod === 'GET') return new Response('', { status: 405 });
    if (rpcMethod === 'initialize') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'unit-stub', version: '9.9.9' }
        }
      });
    }
    if (rpcMethod === 'notifications/initialized' || rpcMethod === 'notifications/cancelled') {
      return new Response('', { status: 202 });
    }
    if (rpcMethod === 'tools/list') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: { tools: [{ name: 'echo', description: 'Echo tool', inputSchema: { type: 'object' } }] }
      });
    }
    return jsonResponse({ jsonrpc: '2.0', id: body?.id ?? null, result: { content: [], isError: false } });
  };
  stub.calls = calls;
  return Object.freeze(stub);
}

/**
 * Installs a fetch stub for one test body and restores the process fetch after.
 *
 * @param {Function} stub Frozen fetch stub.
 * @param {() => Promise<unknown>} run Test body.
 * @returns {Promise<unknown>} Test body result.
 */
async function withFetchStub(stub, run) {
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

/**
 * Asserts that a rejection is an McpClientError with the expected code.
 *
 * @param {() => Promise<unknown>} fn Rejection-producing thunk.
 * @param {string} code Expected `MCP_CLIENT_ERROR_CODES` value.
 * @returns {Promise<McpClientError>} The asserted error.
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

test('1. stdio transport is refused without touching the transport seam', async () => {
  const stub = createFetchStub();
  await withFetchStub(stub, async () => {
    const error = await rejectsWithCode(
      () => createMcpClient({ transport: { kind: 'stdio', command: 'node', args: ['server.js'] } }),
      MCP_CLIENT_ERROR_CODES.TRANSPORT_UNSUPPORTED
    );
    assert.equal(error.name, 'McpClientError');
  });
  assert.equal(stub.calls.length, 0);
});

test('2. a credential on plaintext http is refused before any transport activity and never echoed', async () => {
  const stub = createFetchStub();
  const secret = 'unit-secret-value-never-log';
  await withFetchStub(stub, async () => {
    const error = await rejectsWithCode(
      () =>
        createMcpClient({
          transport: { kind: 'http', url: 'http://127.0.0.1:9/mcp' },
          credential: { id: 'unit-credential', secret }
        }),
      MCP_CLIENT_ERROR_CODES.PLAINTEXT_CREDENTIAL
    );
    const serialized = `${error.message} ${JSON.stringify(error.details ?? null)}`;
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes('unit-credential'));
  });
  assert.equal(stub.calls.length, 0);
});

test('3. malformed options fail with TypeError before any transport activity', async () => {
  const stub = createFetchStub();
  await withFetchStub(stub, async () => {
    await assert.rejects(() => createMcpClient(null), TypeError);
    await assert.rejects(
      () => createMcpClient({ transport: { kind: 'http', url: 'not-a-url' } }),
      TypeError
    );
    await assert.rejects(
      () => createMcpClient({ transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' }, requestTimeoutMs: 0 }),
      TypeError
    );
    await assert.rejects(
      () =>
        createMcpClient({
          transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' },
          credential: { id: 'unit-credential', secret: '' }
        }),
      TypeError
    );
    await assert.rejects(
      () => createMcpClient({ transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' }, signal: {} }),
      TypeError
    );
  });
  assert.equal(stub.calls.length, 0);
});

test('4. https credential rides a bearer header and the session surface is frozen', async () => {
  const stub = createFetchStub();
  const secret = 'unit-bearer-secret';
  await withFetchStub(stub, async () => {
    const session = await createMcpClient({
      transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' },
      credential: { id: 'unit-credential', secret }
    });
    try {
      assert.ok(Object.isFrozen(session));
      assert.deepEqual(session.serverInfo, { name: 'unit-stub', version: '9.9.9' });
      assert.equal(session.protocolVersion, '2025-06-18');

      const handshake = stub.calls.find(call => call.rpcMethod === 'initialize');
      assert.ok(handshake, 'initialize request must reach the fetch seam');
      const headers = new Headers(handshake.init.headers);
      assert.equal(headers.get('authorization'), `Bearer ${secret}`);

      const tools = await session.listTools();
      assert.ok(Object.isFrozen(tools));
      assert.ok(Object.isFrozen(tools[0]));
      assert.equal(tools[0].name, 'echo');
    } finally {
      await session.close();
    }
  });
});

test('5. a fetch TypeError maps to ERR_MCP_NETWORK', async () => {
  const stub = createFetchStub({
    initialize: () => {
      throw new TypeError('fetch failed');
    }
  });
  await withFetchStub(stub, async () => {
    const error = await rejectsWithCode(
      () => createMcpClient({ transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' } }),
      MCP_CLIENT_ERROR_CODES.NETWORK
    );
    assert.equal(error.details.causeName, 'TypeError');
  });
});

test('6. an elapsed request budget maps to ERR_MCP_TIMEOUT', async () => {
  const stub = createFetchStub({
    'tools/call': () => new Promise(() => {})
  });
  await withFetchStub(stub, async () => {
    const session = await createMcpClient({
      transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' },
      requestTimeoutMs: 100
    });
    try {
      const error = await rejectsWithCode(
        () => session.callTool('echo', {}),
        MCP_CLIENT_ERROR_CODES.TIMEOUT
      );
      assert.equal(error.details.timeoutMs, 100);
    } finally {
      await session.close();
    }
  });
});

test('7. an aborted call maps to ERR_MCP_CANCELLED', async () => {
  const stub = createFetchStub({
    'tools/call': () => new Promise(() => {})
  });
  await withFetchStub(stub, async () => {
    const session = await createMcpClient({
      transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' }
    });
    try {
      const controller = new AbortController();
      const pending = session.callTool('echo', {}, { signal: controller.signal });
      setTimeout(() => controller.abort(), 25);
      await rejectsWithCode(() => pending, MCP_CLIENT_ERROR_CODES.CANCELLED);
    } finally {
      await session.close();
    }
  });
});

test('8. an HTTP 401 maps to ERR_MCP_AUTH with the status detail', async () => {
  const stub = createFetchStub({
    initialize: () => new Response('unauthorized', { status: 401 })
  });
  await withFetchStub(stub, async () => {
    const error = await rejectsWithCode(
      () => createMcpClient({ transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' } }),
      MCP_CLIENT_ERROR_CODES.AUTH
    );
    assert.equal(error.details.httpStatus, 401);
  });
});

test('9. a JSON-RPC error maps to ERR_MCP_PROTOCOL with its code', async () => {
  const stub = createFetchStub({
    'tools/call': ({ body }) =>
      jsonResponse({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'stub failure' } })
  });
  await withFetchStub(stub, async () => {
    const session = await createMcpClient({
      transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' }
    });
    try {
      const error = await rejectsWithCode(
        () => session.callTool('fail', {}),
        MCP_CLIENT_ERROR_CODES.PROTOCOL
      );
      assert.equal(error.details.protocolCode, -32001);
    } finally {
      await session.close();
    }
  });
});

test('10. a malformed JSON body maps to ERR_MCP_INVALID_RESPONSE', async () => {
  const stub = createFetchStub({
    'tools/call': () =>
      new Response('{"jsonrpc":"2.0", "id": 1, "result": {', {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
  });
  await withFetchStub(stub, async () => {
    const session = await createMcpClient({
      transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' }
    });
    try {
      await rejectsWithCode(() => session.callTool('echo', {}), MCP_CLIENT_ERROR_CODES.INVALID_RESPONSE);
    } finally {
      await session.close();
    }
  });
});

test('11. the error dictionary and error shape are frozen and stable', () => {
  assert.ok(Object.isFrozen(MCP_CLIENT_ERROR_CODES));
  assert.equal(Object.keys(MCP_CLIENT_ERROR_CODES).length, 8);
  for (const code of Object.values(MCP_CLIENT_ERROR_CODES)) {
    assert.match(code, /^ERR_MCP_[A-Z_]+$/);
  }

  const error = new McpClientError('test message', MCP_CLIENT_ERROR_CODES.NETWORK, { httpStatus: 500 });
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'McpClientError');
  assert.equal(error.code, MCP_CLIENT_ERROR_CODES.NETWORK);
  assert.ok(Object.isFrozen(error.details));
  assert.deepEqual(error.details, { httpStatus: 500 });
});

test('12. aborting the session-wide signal cancels subsequent calls', async () => {
  const stub = createFetchStub();
  await withFetchStub(stub, async () => {
    const controller = new AbortController();
    const session = await createMcpClient({
      transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' },
      signal: controller.signal
    });
    try {
      controller.abort();
      await rejectsWithCode(() => session.callTool('echo', {}), MCP_CLIENT_ERROR_CODES.CANCELLED);
    } finally {
      await session.close();
    }
  });
});

test('13. a duck-typed signal without removeEventListener is rejected during validation', async () => {
  const stub = createFetchStub();
  await withFetchStub(stub, async () => {
    await assert.rejects(
      () =>
        createMcpClient({
          transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' },
          signal: { aborted: false, addEventListener() {} }
        }),
      err => {
        assert.ok(err instanceof TypeError, `expected TypeError, got ${String(err)}`);
        assert.match(err.message, /signal/);
        return true;
      }
    );
  });
  assert.equal(stub.calls.length, 0);
});

test('14. a throwing removeEventListener cannot break best-effort teardown', async () => {
  const stub = createFetchStub();
  await withFetchStub(stub, async () => {
    // The official client also invokes a caller signal's removeEventListener
    // during its own connect-request cleanup, so the throw is armed only after
    // the session is connected: this pins the module's own teardown path
    // (F1) without asserting shielding inside the third-party client.
    let armed = false;
    const session = await createMcpClient({
      transport: { kind: 'http', url: 'https://mcp.unit.test/mcp' },
      signal: {
        aborted: false,
        addEventListener() {},
        removeEventListener() {
          if (armed) throw new Error('boom');
        }
      }
    });
    assert.ok(Object.isFrozen(session));
    armed = true;
    assert.equal(await session.close(), undefined);
    assert.equal(await session.close(), undefined);
  });
});
