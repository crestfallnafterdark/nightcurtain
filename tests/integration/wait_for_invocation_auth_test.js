/**
 * @file tests/integration/wait_for_invocation_auth_test.js
 * @description Realm wave A-2 (ticket 3487c56): the `wait_for_invocation` tool
 * descriptor must forward the trusted bound caller scope to the lifecycle port
 * as its third argument, so the invocation engine authenticates tool-path
 * awaits end-to-end through the real dispatcher seam:
 *   1. the invoker awaits its own invocation and receives the result;
 *   2. the target may await its own invocation;
 *   3. the director (Realm bypass) may await any invocation;
 *   4. an unrelated same-Realm peer and a cross-Realm peer are denied;
 *   5. an unregistered / anonymous caller fails closed in the engine;
 *   6. forged per-call identity params stay inert (dispatcher-pinned only);
 *   7. ungrouped legacy parity: an ungrouped invoker awaits its own invocation.
 *
 * Real classes only (Zero-Mock Verification): a real `AgentRuntime` with real
 * substrates and the real `createSandboxToolDispatcher`; the only stub is the
 * LLM model.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';

/** Tools granted to fixture invokers. */
const INVOKER_TOOLS = Object.freeze(['invoke_agent', 'wait_for_invocation']);
/** Tools granted to fixture waiters. */
const WAITER_TOOLS = Object.freeze(['wait_for_invocation']);

/**
 * Minimal stream/complete mock model so invocation turns settle without a
 * provider network.
 *
 * @param {Function} fn - Response factory receiving the stream options.
 * @param {string} [modelId] - Model identifier.
 * @returns {object} Model-like object accepted by `launchAgent`.
 */
function createMockModel(fn, modelId = 'wait-auth-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'wait-auth-provider',
      createModel: (id) => createMockModel(fn, id),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: modelId, name: modelId }]
    },
    async *stream(options = {}) {
      const res = await fn({ ...options });
      const content = res && typeof res === 'object' ? (res.content || res.text || 'ok') : (res || 'ok');
      if (typeof options.onChunk === 'function') {
        try { options.onChunk(content); } catch { /* best-effort chunk delivery */ }
      }
      yield { type: 'text', content };
      yield { type: 'finish', finishReason: 'stop', content, toolCalls: [] };
    },
    async complete(options = {}) {
      return await fn(options);
    }
  };
}

/**
 * Builds the Realm fixture through real launches:
 * - director (ungrouped bypass);
 * - realm `R1`: ordinary `r1_invoker` with child/waiter `r1_target` and
 *   unrelated ordinary `r1_peer`;
 * - realm `R2`: unrelated ordinary `r2_peer`;
 * - ungrouped: ordinary `loose_invoker` with child/waiter `loose_target`.
 *
 * @returns {Promise<AgentRuntime>} Live runtime.
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();

  await runtime.launchAgent(
    { config: { id: 'r1_invoker', realmId: 'R1', allowedTools: [...INVOKER_TOOLS] } },
    createMockModel(async () => ({ content: 'r1 target turn complete' }))
  );
  await runtime.launchAgent({
    config: { id: 'r1_target', allowedTools: [...WAITER_TOOLS] },
    callerContext: { callerAgentId: 'r1_invoker' },
    model: createMockModel(async () => ({ content: 'r1 target turn complete' }))
  });
  await runtime.launchAgent(
    { config: { id: 'r1_peer', realmId: 'R1', allowedTools: [...WAITER_TOOLS] } },
    createMockModel(async () => ({ content: 'r1 peer turn complete' }))
  );
  await runtime.launchAgent(
    { config: { id: 'r2_peer', realmId: 'R2', allowedTools: [...WAITER_TOOLS] } },
    createMockModel(async () => ({ content: 'r2 peer turn complete' }))
  );
  await runtime.launchAgent(
    { id: 'loose_invoker', allowedTools: [...INVOKER_TOOLS] },
    createMockModel(async () => ({ content: 'loose target turn complete' }))
  );
  await runtime.launchAgent({
    config: { id: 'loose_target', allowedTools: [...WAITER_TOOLS] },
    callerContext: { callerAgentId: 'loose_invoker' },
    model: createMockModel(async () => ({ content: 'loose target turn complete' }))
  });

  return runtime;
}

/**
 * Builds a dispatcher bound to one fixture agent.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} agentId - Bound caller identity.
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, agentId) {
  return createSandboxToolDispatcher({ runtime, agentId });
}

// ============================================================================
// 1. Authorized awaits through the tool path
// ============================================================================

test('1. the invoker awaits its own invocation through the tool path and receives the result', async () => {
  const runtime = await createFixture();
  try {
    const invoker = dispatcherFor(runtime, 'r1_invoker');
    const invokeReceipt = await invoker.executeTool('invoke_agent', {
      agent_id: 'r1_target',
      prompt: 'collect report'
    });
    assert.equal(invokeReceipt.success, true, `invoke_agent failed: ${invokeReceipt.error}`);
    const invocationId = invokeReceipt.invocationId;
    assert.equal(typeof invocationId, 'string');

    const waitReceipt = await invoker.executeTool('wait_for_invocation', {
      invocation_ids: [invocationId],
      timeout_ms: 5000
    });
    assert.equal(
      waitReceipt.success,
      true,
      `the invoker must be able to await its own invocation: ${waitReceipt.error}`
    );
    assert.deepStrictEqual(waitReceipt.receivedIds, [invocationId]);
    assert.equal(waitReceipt.results[0].output, 'r1 target turn complete');
  } finally {
    runtime.destroy();
  }
});

test('2. the target awaits its own invocation through the tool path', async () => {
  const runtime = await createFixture();
  try {
    const receipt = runtime.invokeAgent({
      invokerId: 'r1_invoker',
      targetAgentId: 'r1_target',
      prompt: 'collect report'
    });
    assert.equal(receipt.success, true, `invoke failed: ${receipt.error}`);

    const waitReceipt = await dispatcherFor(runtime, 'r1_target').executeTool('wait_for_invocation', {
      invocation_ids: [receipt.invocationId],
      timeout_ms: 5000
    });
    assert.equal(
      waitReceipt.success,
      true,
      `the target must be able to await its own invocation: ${waitReceipt.error}`
    );
    assert.equal(waitReceipt.results[0].output, 'r1 target turn complete');
  } finally {
    runtime.destroy();
  }
});

test('3. the director (Realm bypass) may await any invocation through the tool path', async () => {
  const runtime = await createFixture();
  try {
    const receipt = runtime.invokeAgent({
      invokerId: 'r1_invoker',
      targetAgentId: 'r1_target',
      prompt: 'collect report'
    });
    assert.equal(receipt.success, true, `invoke failed: ${receipt.error}`);

    const waitReceipt = await dispatcherFor(runtime, 'director').executeTool('wait_for_invocation', {
      invocation_ids: [receipt.invocationId],
      timeout_ms: 5000
    });
    assert.equal(
      waitReceipt.success,
      true,
      `the director bypass must await any invocation: ${waitReceipt.error}`
    );
  } finally {
    runtime.destroy();
  }
});

test('4. ungrouped legacy parity: an ungrouped invoker awaits its own invocation', async () => {
  const runtime = await createFixture();
  try {
    const invoker = dispatcherFor(runtime, 'loose_invoker');
    const invokeReceipt = await invoker.executeTool('invoke_agent', {
      agent_id: 'loose_target',
      prompt: 'legacy task'
    });
    assert.equal(invokeReceipt.success, true, `invoke_agent failed: ${invokeReceipt.error}`);

    const waitReceipt = await invoker.executeTool('wait_for_invocation', {
      invocation_ids: [invokeReceipt.invocationId],
      timeout_ms: 5000
    });
    assert.equal(
      waitReceipt.success,
      true,
      `an ungrouped invoker keeps the legacy ability to await its own invocation: ${waitReceipt.error}`
    );
    assert.equal(waitReceipt.results[0].output, 'loose target turn complete');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Denials through the tool path
// ============================================================================

test('5. unrelated callers are denied fail-closed: same-Realm peer and cross-Realm peer', async () => {
  const runtime = await createFixture();
  try {
    const receipt = runtime.invokeAgent({
      invokerId: 'r1_invoker',
      targetAgentId: 'r1_target',
      prompt: 'collect report'
    });
    assert.equal(receipt.success, true, `invoke failed: ${receipt.error}`);

    const sameRealm = await dispatcherFor(runtime, 'r1_peer').executeTool('wait_for_invocation', {
      invocation_ids: [receipt.invocationId],
      timeout_ms: 50
    });
    assert.equal(sameRealm.success, false, 'a same-Realm peer is not the invoker or the target');
    assert.equal(sameRealm.code, 'PERMISSION_DENIED');
    assert.equal(sameRealm.count, 0, 'a denied wait leaks no results');

    const crossRealm = await dispatcherFor(runtime, 'r2_peer').executeTool('wait_for_invocation', {
      invocation_ids: [receipt.invocationId],
      timeout_ms: 50
    });
    assert.equal(crossRealm.success, false, 'a cross-Realm peer is denied too');
    assert.equal(crossRealm.code, 'PERMISSION_DENIED');
    assert.equal(crossRealm.count, 0);
  } finally {
    runtime.destroy();
  }
});

test('6. forged per-call identity claims never authenticate a tool-path wait', async () => {
  const runtime = await createFixture();
  try {
    const receipt = runtime.invokeAgent({
      invokerId: 'r1_invoker',
      targetAgentId: 'r1_target',
      prompt: 'collect report'
    });
    assert.equal(receipt.success, true, `invoke failed: ${receipt.error}`);

    const forged = await dispatcherFor(runtime, 'r2_peer').executeTool('wait_for_invocation', {
      invocation_ids: [receipt.invocationId],
      timeout_ms: 50,
      caller_agent_id: 'r1_invoker',
      callerAgentId: 'r1_invoker',
      agent_id: 'r1_invoker',
      principal: { kind: 'agent', subject: 'r1_invoker' },
      isPrivileged: true
    });
    assert.equal(forged.success, false, 'caller params are caller data, never an identity channel');
    assert.equal(forged.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('7. unregistered and anonymous callers fail closed in the invocation engine', async () => {
  const runtime = await createFixture();
  try {
    const receipt = runtime.invokeAgent({
      invokerId: 'r1_invoker',
      targetAgentId: 'r1_target',
      prompt: 'collect report'
    });
    assert.equal(receipt.success, true, `invoke failed: ${receipt.error}`);

    const unregistered = await createSandboxToolDispatcher({
      runtime,
      agentId: 'ghost_agent',
      allowedTools: 'all'
    }).executeTool('wait_for_invocation', {
      invocation_ids: [receipt.invocationId],
      timeout_ms: 50
    });
    assert.equal(unregistered.success, false, 'an unregistered bound caller cannot authenticate');
    assert.equal(unregistered.code, 'PERMISSION_DENIED');
    assert.match(
      unregistered.error,
      /registered agent/,
      'the denial comes from the engine fail-closed caller channel'
    );

    const anonymous = await createSandboxToolDispatcher({ runtime, allowedTools: 'all' }).executeTool(
      'wait_for_invocation',
      { invocation_ids: [receipt.invocationId], timeout_ms: 50 }
    );
    assert.equal(anonymous.success, false, 'an anonymous dispatcher cannot authenticate');
    assert.equal(anonymous.code, 'PERMISSION_DENIED');
    assert.match(anonymous.error, /registered agent/);
  } finally {
    runtime.destroy();
  }
});
