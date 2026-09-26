/**
 * @file tests/integration/extension_execution_test.js
 * @description Zero-Mock integration suite for the extension execution lane
 *   (P3.3): real store-owned runtime (with the store's pinned provider and
 *   execution ports), real `node:http` MCP fixture, real `mcpClient` session
 *   over real sockets, and a scripted model driving real turns. The only
 *   non-production object is the scripted model itself.
 *
 * Coverage:
 *  1. Full loop: connect → attach → granted member → a real turn calls a live
 *     extension tool → mapped receipt in history; schema exposure.
 *  2. Exposure mirrors authorization: a restricted member sees/succeeds only
 *     its granted names; an ungranted name denies before the server.
 *  3. `describe_tool` merged view documents granted extension tools and keeps
 *     ungranted names `TOOL_NOT_FOUND`.
 *  4. `batch_precall` stays frozen: extension names are `PRECALL_FORBIDDEN`.
 *  5. Disconnect tombstone: the call resolves `TOOL_NOT_FOUND` and the schema
 *     disappears; no connection state reaches the snapshot.
 *  6. Conflict: a conflicted extension's catalog delivers no descriptors, so
 *     its call names stay `TOOL_NOT_FOUND`.
 *  7. Safe-state sweep on catalog change: idle applies immediately, busy
 *     applies at the next `turn_complete`.
 *  8. Redaction: no secret/credential/base64 material in history, receipts, or
 *     the snapshot; protocol errors carry the fixed client taxonomy text.
 *  9. Typed client failures (timeout, JSON-RPC error) surface as redacted
 *     `EXECUTION_FAILED` receipts.
 * 10. Registration sweep on the real `spawn_agent` tool path: a tool-launched
 *     child receives the connected realm universe at registration (9327633).
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { SANDBOX_STORE_ERROR_CODES, SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createMcpFixtureServer } from '../fixtures/mcp/http_fixture_server.mjs';

/** Generic realm id (the seeded default every realm record carries). */
const GENERIC_REALM_ID = 'realm_generic';

/** Sentinel credential value: the redaction scan must never find it anywhere. */
const SECRET_SENTINEL = 'p33-sentinel-secret-value';

/** Fixture tool set used by most tests (all tool names are unreserved). */
const FIXTURE_TOOLS = Object.freeze([
  Object.freeze({
    name: 'echo',
    description: 'Echo the supplied arguments as a text block.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({ text: Object.freeze({ type: 'string', description: 'Text to echo.' }) })
    })
  }),
  Object.freeze({
    name: 'slow',
    description: 'Delays its response by delayMs.',
    inputSchema: Object.freeze({ type: 'object', properties: Object.freeze({ delayMs: Object.freeze({ type: 'number' }) }) })
  }),
  Object.freeze({
    name: 'fail',
    description: 'Always answers with a JSON-RPC error.'
  })
]);

/** A late-added advertised tool whose fixture behavior succeeds. */
const SSE_TOOL = Object.freeze({ name: 'sse', description: 'Answers through a request-scoped event stream.' });

/**
 * Builds one isolated store over its own store-owned runtime (the production
 * composition path that receives the extension provider/execution ports).
 *
 * @returns {SandboxStore} Fresh store without auto bootstrap/hydration.
 */
function createStore() {
  return new SandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
}

/**
 * Installs one MCP extension pointing at a fixture (plaintext, unauthenticated).
 *
 * @param {SandboxStore} store Store under test.
 * @param {string} id Extension id.
 * @param {{ url: string }} fixture Fixture handle.
 * @param {object} [overrides] Install-input overrides.
 * @returns {object} Frozen install record.
 */
function installMcp(store, id, fixture, overrides = {}) {
  return store.installExtension({
    id,
    kind: 'mcp',
    transportHint: { kind: 'http', url: fixture.url },
    ...overrides
  });
}

/**
 * Builds one OpenAI-style tool call for the scripted model.
 *
 * @param {string} id Tool call id.
 * @param {string} name Tool name.
 * @param {object} [args] Argument payload.
 * @returns {object} Tool call chunk payload.
 */
function toolCall(id, name, args = {}) {
  return {
    id,
    type: 'function',
    name,
    function: { name, arguments: JSON.stringify(args) }
  };
}

/**
 * Builds a provider-bearing scripted model. One script step is consumed per
 * model stream call (a tool-loop iteration); the last step repeats.
 *
 * @param {Array<{ content?: string, toolCalls?: object[] }>} steps Scripted steps.
 * @param {{ onFirstStream?: () => Promise<void>|void }} [hooks] First-stream hook (busy-gate tests).
 * @returns {object} Scripted model with captured stream options per iteration.
 */
function createScriptedModel(steps, { onFirstStream = null } = {}) {
  let iteration = 0;
  const provider = {
    id: 'scripted-provider',
    createModel: () => model,
    getEndpointUrl: () => 'http://localhost/scripted',
    checkBalance: async () => ({ balance: 1 }),
    listModels: async () => []
  };
  const model = {
    id: 'scripted-model',
    config: {},
    provider,
    streamOptions: [],
    async *stream(options = {}) {
      model.streamOptions.push(options);
      const index = iteration++;
      if (index === 0 && onFirstStream) await onFirstStream();
      const step = steps[Math.min(index, steps.length - 1)] || {};
      if (typeof step.content === 'string' && step.content) {
        if (typeof options.onChunk === 'function') {
          try { options.onChunk({ type: 'text', content: step.content }); } catch { /* ignore */ }
        }
        yield { type: 'text', content: step.content };
      }
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      if (toolCalls.length > 0) yield { type: 'tool_call', toolCalls };
      yield {
        type: 'finish',
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        content: step.content || '',
        toolCalls
      };
    }
  };
  return model;
}

/**
 * Extracts the model-facing tool names from one captured stream-options payload.
 *
 * @param {object} streamOptions Captured stream options.
 * @returns {string[]} Tool names.
 */
function schemaNames(streamOptions) {
  return (streamOptions?.tools || []).map((entry) => entry?.function?.name || entry?.name || '');
}

/**
 * Returns the tool-role receipts recorded in one store agent's history.
 *
 * @param {SandboxStore} store Store under test.
 * @param {string} agentId Agent id.
 * @returns {object[]} Tool-role history messages.
 */
function toolMessages(store, agentId) {
  const agent = store.agents.find((candidate) => candidate.id === agentId);
  return (agent?.history || []).filter((message) => message.role === 'tool');
}

/**
 * Parses one tool receipt's content.
 *
 * @param {object} message Tool-role message.
 * @returns {object} Parsed receipt.
 */
function receiptOf(message) {
  return JSON.parse(message.content);
}

/**
 * Spawns a granted member in the Generic realm with the scripted model.
 *
 * @param {SandboxStore} store Store under test.
 * @param {string} id Member id.
 * @param {object} model Scripted model.
 * @param {'all'|string[]} [extensionTools] Per-agent selector.
 * @returns {Promise<object>} Member snapshot.
 */
async function spawnMember(store, id, model, extensionTools = 'all') {
  return store.spawnAgent({
    id,
    name: id,
    role: 'observer',
    realmId: GENERIC_REALM_ID,
    allowedTools: ['read_file', 'describe_tool', 'batch_precall'],
    extensionTools
  }, model);
}

// ============================================================================
// 1. Full loop: a granted member executes a live extension tool
// ============================================================================

test('1. a granted member calls a live extension tool through a real turn and the receipt lands in history', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    const connection = await store.connectExtension('ext-a');
    assert.strictEqual(connection.status, 'connected');

    const model = createScriptedModel([
      { content: 'calling echo', toolCalls: [toolCall('c1', 'echo', { text: 'hello' })] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-runner', model);

    const turn = await store.triggerTurn('p33-runner', 'go');
    assert.strictEqual(turn.output, 'done');

    // The model saw exactly the baked surface plus the live catalog names.
    const names = schemaNames(model.streamOptions[0]);
    for (const expected of ['read_file', 'describe_tool', 'batch_precall', 'echo', 'slow']) {
      assert.ok(names.includes(expected), `schema list must include '${expected}'`);
    }

    // The extension call reached the fixture and the mapped receipt is in history.
    const calls = fixture.requests.filter((entry) => entry.method === 'tools/call');
    assert.deepStrictEqual(calls.map((entry) => entry.toolName), ['echo'], 'the real server call is observable');
    const [receiptMessage] = toolMessages(store, 'p33-runner');
    assert.ok(receiptMessage, 'the turn must record a tool receipt');
    const receipt = receiptOf(receiptMessage);
    assert.strictEqual(receipt.success, true);
    assert.strictEqual(receipt.content, JSON.stringify({ text: 'hello' }), 'the pass-through args reach the server and the mapped text returns');
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 2. Exposure mirrors authorization
// ============================================================================

test('2. a restricted selector sees and executes only its granted names; an ungranted live name denies before the server', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    const model = createScriptedModel([
      { content: 'calling slow', toolCalls: [toolCall('s1', 'slow', { delayMs: 1 })] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-restricted', model, ['echo']);

    const turn = await store.triggerTurn('p33-restricted', 'go');
    assert.strictEqual(turn.output, 'done');

    const names = schemaNames(model.streamOptions[0]);
    assert.ok(names.includes('echo'), 'the granted name is exposed');
    assert.ok(!names.includes('slow'), 'an ungranted catalog name is never exposed');

    const calls = fixture.requests.filter((entry) => entry.method === 'tools/call');
    assert.deepStrictEqual(calls, [], 'a denied call must never reach the third-party server');
    const receipt = receiptOf(toolMessages(store, 'p33-restricted')[0]);
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.code, 'PERMISSION_DENIED', 'authorization stays descriptor-exact');
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

test('2b. an exact grant for a catalog-less name stays TOOL_NOT_FOUND', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    // Seed the exact grant through the store's trusted extension-grants
    // channel (the same channel the template-launch loop uses): 'ghost_tool'
    // is on the caller's axis but in no live catalog, so the provider can
    // resolve no descriptor and the call resolves no binding.
    const ghostModel = createScriptedModel([
      { content: 'calling ghost', toolCalls: [toolCall('g1', 'ghost_tool', {})] },
      { content: 'done' }
    ]);
    await store.launchAgent({
      id: 'p33-ghost',
      name: 'p33-ghost',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: ['read_file'],
      extensionTools: []
    }, ghostModel, null, ['ghost_tool']);
    await store.triggerTurn('p33-ghost', 'go');
    const receipt = receiptOf(toolMessages(store, 'p33-ghost')[0]);
    assert.strictEqual(receipt.code, 'TOOL_NOT_FOUND', 'a granted name with no live descriptor resolves no binding');

    // Positive control for the same seed channel: an exact grant for a name
    // the live catalog does resolve executes (the selector would otherwise
    // grant nothing), proving the axis — not the catalog universe — was the
    // grant source for the ghost call above.
    const controlModel = createScriptedModel([
      { content: 'calling echo', toolCalls: [toolCall('g2', 'echo', { text: 'control' })] },
      { content: 'done' }
    ]);
    await store.launchAgent({
      id: 'p33-ghost-control',
      name: 'p33-ghost-control',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: ['read_file'],
      extensionTools: []
    }, controlModel, null, ['echo']);
    await store.triggerTurn('p33-ghost-control', 'go');
    const control = receiptOf(toolMessages(store, 'p33-ghost-control')[0]);
    assert.strictEqual(control.success, true, 'the same channel seeds a resolvable exact grant');
    assert.strictEqual(control.content, JSON.stringify({ text: 'control' }));
    assert.deepStrictEqual(
      fixture.requests.filter((entry) => entry.method === 'tools/call').map((entry) => entry.toolName),
      ['echo'],
      'the catalog-less grant never reaches the server'
    );
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 3. describe_tool merged view
// ============================================================================

test('3. describe_tool documents granted extension tools and keeps ungranted names TOOL_NOT_FOUND', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    const model = createScriptedModel([
      { content: 'describing', toolCalls: [toolCall('d1', 'describe_tool', { tool_name: 'echo' })] },
      { content: 'describing slow', toolCalls: [toolCall('d2', 'describe_tool', { tool_name: 'slow' })] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-describer', model, ['echo']);
    await store.triggerTurn('p33-describer', 'go');

    const receipts = toolMessages(store, 'p33-describer').map(receiptOf);
    assert.strictEqual(receipts[0].success, true, 'the granted descriptor is documented');
    assert.strictEqual(receipts[0].tool_name, 'echo');
    assert.match(receipts[0].description, /Echo the supplied arguments/);
    assert.ok(receipts[0].parameters.text, 'the projected schema properties are documented');
    assert.strictEqual(receipts[1].success, false, 'an ungranted extension name is not in the merged registry');
    assert.strictEqual(receipts[1].code, 'TOOL_NOT_FOUND');
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 4. batch_precall stays frozen
// ============================================================================

test('4. batch_precall denies extension names with PRECALL_FORBIDDEN and never executes them', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    const model = createScriptedModel([
      {
        content: 'precalling',
        toolCalls: [toolCall('p1', 'batch_precall', { calls: [{ name: 'echo', arguments: { text: 'precalled' } }] })]
      },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-precaller', model);
    await store.triggerTurn('p33-precaller', 'go');

    const receipt = receiptOf(toolMessages(store, 'p33-precaller')[0]);
    assert.strictEqual(receipt.success, true, 'the batch itself returns a structured batch receipt');
    assert.strictEqual(receipt.results[0].code, 'PRECALL_FORBIDDEN', 'extension names are never precallable');
    assert.deepStrictEqual(
      fixture.requests.filter((entry) => entry.method === 'tools/call'),
      [],
      'the forbidden precall never reaches the server'
    );
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 5. Disconnect tombstone; no connection state in the snapshot
// ============================================================================

test('5. disconnect makes the call TOOL_NOT_FOUND, drops the schema, and leaves no connection state in the snapshot', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    const model = createScriptedModel([
      { content: 'calling echo', toolCalls: [toolCall('e1', 'echo', { text: 'before' })] },
      { content: 'done' },
      { content: 'calling echo after', toolCalls: [toolCall('e2', 'echo', { text: 'after' })] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-disconnect', model);
    await store.triggerTurn('p33-disconnect', 'go');
    assert.strictEqual(receiptOf(toolMessages(store, 'p33-disconnect')[0]).success, true);

    const disconnected = await store.disconnectExtension('ext-a');
    assert.strictEqual(disconnected, true);

    await store.triggerTurn('p33-disconnect', 'again');
    const receipts = toolMessages(store, 'p33-disconnect').map(receiptOf);
    assert.strictEqual(receipts[1].code, 'TOOL_NOT_FOUND', 'the disconnected catalog resolves no binding');
    const secondTurnOptions = model.streamOptions[model.streamOptions.length - 2];
    assert.ok(!schemaNames(secondTurnOptions).includes('echo'), 'the disconnected name disappears from the schema');

    const snapshot = JSON.stringify(store.serialize());
    assert.ok(snapshot.includes('"ext-a"'), 'the install record persists');
    assert.ok(!snapshot.includes('"catalog"'), 'the live catalog never reaches the snapshot');
    assert.ok(!snapshot.includes('"serverInfo"'), 'the live session projection never reaches the snapshot');
    assert.ok(!snapshot.includes('extensionToolProvider'), 'the provider port never reaches the snapshot');
    assert.ok(!snapshot.includes('extensionExecutionPort'), 'the execution port never reaches the snapshot');
    assert.strictEqual(store.getExtensionConnection('ext-a'), null, 'the live connection is gone');
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 6. Conflict: a conflicted catalog delivers no descriptors
// ============================================================================

test('6. a conflicted extension catalog delivers no descriptors, so its unique call name stays TOOL_NOT_FOUND', async () => {
  sharedLocalStorage.clear();
  const fixtureA = await createMcpFixtureServer({
    tools: [
      { name: 'shared_tool', description: 'A shared' },
      { name: 'alpha_only', description: 'Alpha only' }
    ]
  });
  const fixtureB = await createMcpFixtureServer({
    tools: [
      { name: 'shared_tool', description: 'B shared' },
      { name: 'gamma_only', description: 'Gamma only' }
    ]
  });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixtureA);
    installMcp(store, 'ext-b', fixtureB);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    store.attachExtension(GENERIC_REALM_ID, 'ext-b');
    await store.connectExtension('ext-a');
    const loser = await store.connectExtension('ext-b');
    assert.strictEqual(loser.status, 'conflict', 'the later catalog loses the contested name');
    assert.deepStrictEqual(loser.conflicts.map((entry) => entry.callName), ['shared_tool']);

    // The winner still executes; the conflicted catalog's unique name is gone.
    const model = createScriptedModel([
      { content: 'calling gamma', toolCalls: [toolCall('x1', 'gamma_only', {})] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-conflict', model);
    await store.triggerTurn('p33-conflict', 'go');
    const receipt = receiptOf(toolMessages(store, 'p33-conflict')[0]);
    assert.strictEqual(receipt.code, 'TOOL_NOT_FOUND', 'a conflicted catalog contributes no descriptors');
    assert.ok(!schemaNames(model.streamOptions[0]).includes('gamma_only'), 'a conflicted name is never exposed');
    assert.ok(schemaNames(model.streamOptions[0]).includes('shared_tool'), 'the winner keeps the contested name');
  } finally {
    store.destroy();
    await fixtureA.close();
    await fixtureB.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 7. Safe-state sweep on catalog change: idle immediate / busy on completion
// ============================================================================

test('7a. a catalog change reauthorizes an idle member immediately at the mutation point', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    const model = createScriptedModel([
      { content: 'calling echo', toolCalls: [toolCall('i1', 'echo', { text: 'idle-before' })] },
      { content: 'done' },
      { content: 'calling sse', toolCalls: [toolCall('i2', 'sse', {})] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-idle', model);
    await store.triggerTurn('p33-idle', 'first');
    assert.ok(!schemaNames(model.streamOptions[0]).includes('sse'), 'the tool does not exist yet');

    // The idle member is mid-session but between turns: the sweep applies at
    // the mutation point (the reconnect), never mid-turn.
    fixture.setTools([...FIXTURE_TOOLS, SSE_TOOL]);
    await store.reconnectExtension('ext-a');

    await store.triggerTurn('p33-idle', 'second');
    const secondTurnSchema = model.streamOptions[model.streamOptions.length - 2];
    assert.ok(
      schemaNames(secondTurnSchema).includes('sse'),
      'the idle member is reauthorized immediately at the mutation point'
    );
    const receipts = toolMessages(store, 'p33-idle').map(receiptOf);
    assert.strictEqual(receipts[1].success, true, 'the newly exposed tool executes');
    assert.strictEqual(receipts[1].content, 'sse-mode-ok');
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

test('7b. a catalog change during a turn queues and applies at turn_complete, never mid-turn', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    let releaseGate = () => {};
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let markStarted = () => {};
    const started = new Promise((resolve) => { markStarted = resolve; });
    const model = createScriptedModel([
      { content: 'long turn', toolCalls: [toolCall('b1', 'sse', {})] },
      { content: 'done' },
      { content: 'calling sse', toolCalls: [toolCall('b2', 'sse', {})] },
      { content: 'done' }
    ], {
      onFirstStream: async () => {
        markStarted();
        await gate;
      }
    });
    await spawnMember(store, 'p33-busy', model);

    const busyTurn = store.triggerTurn('p33-busy', 'busy');
    await started;
    assert.ok(!schemaNames(model.streamOptions[0]).includes('sse'), 'the tool does not exist yet');

    // The member is mid-turn: the catalog change must queue, not apply.
    fixture.setTools([...FIXTURE_TOOLS, SSE_TOOL]);
    await store.reconnectExtension('ext-a');
    releaseGate();
    await busyTurn;

    const receipts = toolMessages(store, 'p33-busy').map(receiptOf);
    // Mid-turn non-widening: the model calls the newly cataloged tool while
    // the busy-member sweep is still queued, so the member's descriptor is
    // unchanged and the call is denied — never executed mid-turn.
    assert.strictEqual(receipts[0].success, false, 'the mid-turn call is denied');
    assert.strictEqual(receipts[0].code, 'PERMISSION_DENIED', 'the busy-member sweep never mutates mid-turn');
    const sseServerCalls = () => fixture.requests.filter(
      (entry) => entry.method === 'tools/call' && entry.toolName === 'sse'
    ).length;
    assert.strictEqual(sseServerCalls(), 0, 'the mid-turn denial never reaches the server');

    // The queued sweep applied on turn_complete: the next turn exposes and
    // executes 'sse'.
    await store.triggerTurn('p33-busy', 'after');
    const afterTurnSchema = model.streamOptions[model.streamOptions.length - 2];
    assert.ok(
      schemaNames(afterTurnSchema).includes('sse'),
      'the busy member is reauthorized at its next turn_complete'
    );
    const afterReceipts = toolMessages(store, 'p33-busy').map(receiptOf);
    assert.strictEqual(afterReceipts[1].success, true, 'the newly exposed tool executes after the safe-state sweep');
    assert.strictEqual(afterReceipts[1].content, 'sse-mode-ok');
    assert.strictEqual(sseServerCalls(), 1, 'exactly one server call, made after the safe state');
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 7c. Registration sweep on the real spawn_agent tool path (ticket 9327633)
// ============================================================================

test('7c. a child spawned through the spawn_agent tool receives the realm universe at registration', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  // Injected runtime keeps the identity projection observable; the grant
  // computation under test is store-side and independent of the execution
  // ports a store-owned runtime would add.
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    runtime,
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    // The parent holds the spawn capability; its first turn executes the real
    // `spawn_agent` descriptor, which launches through the lifecycle port with
    // no extension grants (ticket 9327633).
    const model = createScriptedModel([
      { content: 'spawning', toolCalls: [toolCall('sp1', 'spawn_agent', { id: 'p33-spawned' })] },
      { content: 'done' }
    ]);
    await store.launchAgent({
      id: 'p33-spawner',
      name: 'p33-spawner',
      role: 'observer',
      realmId: GENERIC_REALM_ID,
      allowedTools: ['read_file', 'spawn_agent'],
      extensionTools: 'all'
    }, model);
    await store.triggerTurn('p33-spawner', 'spawn a child');

    const receipt = toolMessages(store, 'p33-spawner').map(receiptOf)[0];
    assert.strictEqual(receipt.success, true, `the spawn tool must succeed: ${JSON.stringify(receipt)}`);
    assert.strictEqual(receipt.id, 'p33-spawned', 'the receipt carries the child handle');

    const child = runtime.getAgent('p33-spawned');
    assert.ok(child, 'the child registers through the tool lifecycle port');
    assert.strictEqual(child.config.realmId, GENERIC_REALM_ID, 'the child inherits the spawner realm');

    const identity = runtime.createAgentIdentityPort().getAgentIdentity('p33-spawned', { realmId: GENERIC_REALM_ID });
    assert.ok(identity, 'the child carries a canonical identity projection');
    assert.deepStrictEqual(
      [...identity.authority.extensions].sort(),
      ['echo', 'fail', 'slow'],
      'the registration sweep delivers the connected catalog as the realm universe'
    );
    // The parent's sibling grant (same realm) is untouched by the child sweep.
    const parentIdentity = runtime.createAgentIdentityPort().getAgentIdentity('p33-spawner', { realmId: GENERIC_REALM_ID });
    assert.deepStrictEqual([...parentIdentity.authority.extensions].sort(), ['echo', 'fail', 'slow']);
  } finally {
    store.destroy();
    runtime.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 8. Redaction
// ============================================================================

test('8. no secret, credential, or base64 material reaches history, receipts, or the snapshot', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    // A seeded vault credential proves the scan would catch the value; the
    // plaintext endpoint refuses it before any network activity.
    const vault = store.getCredentialVault();
    const credential = vault.addCredential({
      providerId: 'p33-secret-provider',
      label: 'P3.3 sentinel',
      apiKey: SECRET_SENTINEL
    });
    installMcp(store, 'ext-cred', fixture, { credentialId: credential.id });
    await assert.rejects(
      store.connectExtension('ext-cred'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_EXTENSION_PLAINTEXT_CREDENTIAL,
      'a credential over plaintext http is refused before any network activity'
    );

    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    const model = createScriptedModel([
      { content: 'calling echo', toolCalls: [toolCall('r1', 'echo', { text: 'hello' })] },
      { content: 'calling fail', toolCalls: [toolCall('r2', 'fail', {})] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-redaction', model);
    await store.triggerTurn('p33-redaction', 'go');

    const receipts = toolMessages(store, 'p33-redaction').map(receiptOf);
    assert.strictEqual(receipts[0].success, true);
    assert.strictEqual(receipts[1].success, false);
    assert.strictEqual(receipts[1].code, 'EXECUTION_FAILED');
    assert.ok(
      !String(receipts[1].error).includes('fixture tool failure'),
      'server-controlled text never crosses the error taxonomy'
    );

    const scanTargets = [
      typeof store.serialize === 'function' ? JSON.stringify(store.serialize()) : '',
      ...toolMessages(store, 'p33-redaction').map((message) => message.content)
    ];
    for (const [index, target] of scanTargets.entries()) {
      for (const forbidden of [SECRET_SENTINEL, 'Bearer', 'Authorization', 'data:', 'base64', 'aGVsbG8']) {
        assert.ok(!target.includes(forbidden), `snapshot/receipt ${index} must not contain '${forbidden}'`);
      }
    }
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 9. Typed client failures surface as redacted EXECUTION_FAILED receipts
// ============================================================================

test('9. timeout and JSON-RPC failures surface as redacted EXECUTION_FAILED receipts and the session stays usable', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a', { requestTimeoutMs: 150 });

    const model = createScriptedModel([
      { content: 'calling slow', toolCalls: [toolCall('t1', 'slow', { delayMs: 600 })] },
      { content: 'calling fail', toolCalls: [toolCall('t2', 'fail', {})] },
      { content: 'calling echo', toolCalls: [toolCall('t3', 'echo', { text: 'still-alive' })] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-errors', model);
    const turn = await store.triggerTurn('p33-errors', 'go');
    assert.strictEqual(turn.output, 'done', 'typed client failures never abort the turn');

    const receipts = toolMessages(store, 'p33-errors').map(receiptOf);
    assert.strictEqual(receipts[0].code, 'EXECUTION_FAILED', 'a request timeout is a redacted execution failure');
    assert.match(receipts[0].error, /timeout/i);
    assert.ok(!receipts[0].error.includes('slow-complete'), 'no server payload leaks through the failure');
    assert.strictEqual(receipts[1].code, 'EXECUTION_FAILED', 'a JSON-RPC error is a redacted execution failure');
    assert.ok(!receipts[1].error.includes('fixture tool failure'), 'the server message is not propagated');
    assert.strictEqual(receipts[2].success, true, 'the session survives typed failures');
    assert.strictEqual(receipts[2].content, JSON.stringify({ text: 'still-alive' }));
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});

test('9b. an aborted session mid-call surfaces as a redacted EXECUTION_FAILED receipt', async () => {
  sharedLocalStorage.clear();
  const fixture = await createMcpFixtureServer({ tools: FIXTURE_TOOLS });
  const store = createStore();
  try {
    installMcp(store, 'ext-a', fixture);
    store.attachExtension(GENERIC_REALM_ID, 'ext-a');
    await store.connectExtension('ext-a');

    const model = createScriptedModel([
      { content: 'calling slow', toolCalls: [toolCall('a1', 'slow', { delayMs: 3000 })] },
      { content: 'done' }
    ]);
    await spawnMember(store, 'p33-abort', model);

    const turnPromise = store.triggerTurn('p33-abort', 'go');
    const deadline = Date.now() + 2000;
    const callInFlight = () => fixture.requests.some(
      (entry) => entry.method === 'tools/call' && entry.toolName === 'slow'
    );
    while (Date.now() < deadline && !callInFlight()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(callInFlight(), 'the extension call is in flight');
    await store.disconnectExtension('ext-a');
    const turn = await turnPromise;
    assert.strictEqual(turn.output, 'done', 'the turn settles after the aborted call');

    const receipt = receiptOf(toolMessages(store, 'p33-abort')[0]);
    assert.strictEqual(receipt.success, false, 'the aborted call is a failure receipt');
    assert.strictEqual(receipt.code, 'EXECUTION_FAILED', 'the typed cancellation maps to a redacted failure');
    assert.ok(!String(receipt.error).includes('slow-complete'), 'no server payload leaks through the abort');
  } finally {
    store.destroy();
    await fixture.close();
    sharedLocalStorage.clear();
  }
});
