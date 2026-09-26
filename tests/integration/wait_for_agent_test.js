/**
 * @file tests/integration/wait_for_agent_test.js
 * @description Wave 2 completion pipe (tickets 3b70d8d, 17b5c47): the manager
 * tier exposes the child observation/await surface without wildcard tools,
 * `invoke_agent` stops advertising an await, and the 36th canonical tool
 * `wait_for_agent` delivers agent-addressed completion:
 *   1. surface: 36th tool registered, invocation family, manager-only, manager
 *      schema carries `list_agents`/`wait_for_invocation`/`wait_for_agent`
 *      without `'*'`;
 *   2. description truth: `invoke_agent` returns an invocation id immediately
 *      and points at `wait_for_invocation`;
 *   3. manager flow: spawn -> invoke -> await child output, no wildcard tools;
 *   4. wait mode: next-settled-turn resolution, immediate-quiescent status,
 *      timeout partial, bounded output;
 *   5. notify mode: one-shot queue wake (INV-3), zero mailbox envelopes
 *      (INV-1/INV-2), bare-id-only prompt, busy watcher queues;
 *   6. lifecycle: killed watcher drops its registration;
 *   7. authorization matrix: self / parent / `@lifecycle:authority` / denied
 *      peer / realm confinement / unresolved caller.
 *
 * Real classes only (Zero-Mock Verification): real `AgentRuntime` with real
 * substrates and the real `createSandboxToolDispatcher`; the only stub is the
 * LLM model.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import {
  createSandboxToolDispatcher,
  getSandboxToolsSchema,
  SANDBOX_TOOLS
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import {
  ALL_TOOL_DESCRIPTORS,
  TOOL_REGISTRY,
  invokeAgentDescriptor
} from '../../src/lib/sandbox/tools/descriptors/index.ts';
import { getCanonToolName } from '../../src/lib/sandbox/tools/normalizers/index.ts';
import {
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  TOOL_FAMILIES,
  TOOL_PRESETS,
  resolveToolPreset
} from '../../src/lib/sandbox/tools/constants/index.ts';

/** Upper bound for the completion result carried by a wait receipt / wake prompt. */
const OUTPUT_BOUND = 4000;

/**
 * Minimal stream/complete mock model so turns settle without a provider network.
 *
 * @param {Function} fn - Response factory receiving the stream options.
 * @param {string} [modelId] - Model identifier.
 * @returns {object} Model-like object accepted by `launchAgent`.
 */
function createMockModel(fn, modelId = 'wait-for-agent-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'wait-for-agent-provider',
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

/** Deferred promise handle for gated turns. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * Polls a predicate until it holds or the budget elapses.
 *
 * @param {Function} predicate - Synchronous predicate under test.
 * @param {number} [timeoutMs] - Polling budget in milliseconds.
 * @returns {Promise<void>} Resolves when the predicate holds.
 */
async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'waitUntil predicate must hold before the budget elapses');
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

/**
 * Launches an ordinary agent with an explicit scripted model.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} id - Agent id.
 * @param {object} model - Scripted model.
 * @param {{ parentId?: string, realmId?: string, tools?: string[] }} [options] - Launch overrides.
 * @returns {Promise<object>} The launched agent.
 */
async function launchAgent(runtime, id, model, options = {}) {
  const config = { id, allowedTools: options.tools || ['readonly'] };
  if (options.realmId) config.realmId = options.realmId;
  const launchOptions = { config, model };
  if (options.parentId) launchOptions.callerContext = { callerAgentId: options.parentId };
  return await runtime.launchAgent(launchOptions);
}

/** Canonical identity key of a registered agent through the trusted port. */
function identityKeyOf(runtime, agentId) {
  return runtime.createAgentIdentityPort().getAgentIdentity(agentId).key;
}

/** Counts `[AGENT COMPLETE]` user turns in an agent's history. */
function completionWakeCount(runtime, agentId) {
  return runtime.getAgent(agentId).history.filter(
    (message) => message.role === 'user'
      && typeof message.content === 'string'
      && message.content.startsWith('[AGENT COMPLETE]')
  ).length;
}

// ============================================================================
// 1. Surface: the 36th canonical tool and the manager grants
// ============================================================================

test('1. wait_for_agent is the 36th canonical tool, invocation family, manager-only', () => {
  assert.equal(SANDBOX_TOOLS.WAIT_FOR_AGENT, 'wait_for_agent');
  assert.equal(Object.keys(SANDBOX_TOOLS).length, 36, 'the canonical taxonomy is 36 tools');
  assert.equal(ALL_TOOL_DESCRIPTORS.length, 36, 'the descriptor catalog carries all 36 tools');
  assert.ok(TOOL_REGISTRY.wait_for_agent, 'the frozen registry resolves wait_for_agent');
  assert.equal(TOOL_FAMILIES.wait_for_agent, 'invocation', 'wait_for_agent is an invocation tool');
  assert.ok(READ_ONLY_TOOLS.includes('wait_for_agent'), 'wait_for_agent is read-only');
  assert.ok(!MUTATING_TOOLS.includes('wait_for_agent'), 'wait_for_agent never mutates sandbox state');
  assert.equal(getCanonToolName('waitForAgent'), 'wait_for_agent', 'the camelCase spelling resolves');
  assert.equal(getCanonToolName('runtime_waitForAgent'), 'wait_for_agent', 'the runtime-prefixed spelling resolves');

  const manager = resolveToolPreset('manager');
  assert.ok(manager.includes('wait_for_agent'), 'the manager tier carries the agent-addressed wait');
  assert.equal(manager.includes('*'), false, 'the manager tier is never a wildcard');
  assert.ok(
    manager.indexOf('wait_for_agent') > manager.indexOf('wait_for_invocation'),
    'wait_for_agent appends after its id-addressed sibling'
  );
  for (const tier of ['collaborator', 'readonly_collaborator', 'readonly']) {
    assert.ok(!TOOL_PRESETS[tier].includes('wait_for_agent'), `'${tier}' never carries wait_for_agent`);
  }

  const managerSchemaNames = getSandboxToolsSchema('manager').map((def) => def.function.name);
  for (const name of ['list_agents', 'wait_for_invocation', 'wait_for_agent']) {
    assert.ok(managerSchemaNames.includes(name), `the manager schema exposes '${name}'`);
  }
  assert.equal(getSandboxToolsSchema('all').length, 36, 'the wildcard surface exposes 36 schemas');
});

test('2. invoke_agent stops advertising an await and points at the wait primitive', () => {
  const description = invokeAgentDescriptor.description;
  assert.ok(/immediately/.test(description), 'the fire-and-forget return is stated');
  assert.ok(!/and await/i.test(description), `invoke_agent must not promise an in-call await: '${description}'`);
  assert.ok(!/await completion/i.test(description), 'the old await-completion claim is gone');
  assert.ok(/wait_for_invocation/.test(description), 'the id-addressed await follow-up is named');
  assert.ok(/wait_for_agent/.test(description), 'the agent-addressed await follow-up is named');
});

test('3. a manager dispatcher exposes the grants without wildcard tools', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'manager', allowedTools: ['manager'] } });
    const dispatcher = dispatcherFor(runtime, 'manager');

    const listing = await dispatcher.executeTool('list_agents', {});
    assert.equal(listing.success, true, `the manager list grant must work: ${listing.error}`);

    const denial = await dispatcher.executeTool('world_clock', { action: 'query' });
    assert.equal(denial.success, false, 'an orphan tool outside the manager tier stays denied');
    assert.equal(denial.code, 'PERMISSION_DENIED');

    const selfWait = await dispatcher.executeTool('wait_for_agent', { agent_id: 'manager', timeout_ms: 50 });
    assert.equal(selfWait.success, true, `the manager wait grant must work: ${selfWait.error}`);
    assert.equal(selfWait.agentId, 'manager', 'the receipt carries the target bare id');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Manager flow: spawn -> invoke -> await
// ============================================================================

test('4. a manager spawns, invokes, and obtains its child output without wildcard tools', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'manager', allowedTools: ['manager'] } });
    // Child launched under the manager principal (the spawn contract's trusted
    // parentage) with a scripted model.
    await launchAgent(runtime, 'flow_child', createMockModel(async () => ({ content: 'child report v1' })), {
      parentId: 'manager'
    });

    const dispatcher = dispatcherFor(runtime, 'manager');
    const spawned = await dispatcher.executeTool('spawn_agent', { id: 'flow_spawned', toolPreset: 'readonly' });
    assert.equal(spawned.success, true, `the manager must be able to spawn: ${spawned.error}`);
    const spawnedAgent = runtime.getAgent(spawned.id);
    assert.ok(
      spawnedAgent.config.spawnedBy === 'manager' || spawnedAgent.config.creatorId === 'manager',
      'the tool-spawned child records the manager as creator'
    );

    const listing = await dispatcher.executeTool('list_agents', {});
    assert.ok(
      listing.result.map((entry) => entry.id).includes('flow_child'),
      'the manager sees its child in the roster'
    );

    const invoked = await dispatcher.executeTool('invoke_agent', { agent_id: 'flow_child', prompt: 'report' });
    assert.equal(invoked.success, true, `invoke_agent failed: ${invoked.error}`);
    assert.equal(invoked.status, 'dispatched', 'invoke_agent returns immediately with a dispatched receipt');
    assert.equal(typeof invoked.invocationId, 'string', 'the awaitable invocation id is returned');

    const awaited = await dispatcher.executeTool('wait_for_agent', { agent_id: 'flow_child', timeout_ms: 5000 });
    assert.equal(awaited.success, true, `wait_for_agent failed: ${awaited.error}`);
    assert.equal(awaited.output, 'child report v1', 'the child output is delivered to the manager');

    const idAwaited = await dispatcher.executeTool('wait_for_invocation', {
      invocation_ids: [invoked.invocationId],
      timeout_ms: 5000
    });
    assert.equal(idAwaited.success, true, `wait_for_invocation failed: ${idAwaited.error}`);
    assert.equal(idAwaited.results[0].output, 'child report v1', 'the id-addressed sibling sees the same result');

    const deniedWildcard = await dispatcher.executeTool('event_list', { action: 'query' });
    assert.equal(deniedWildcard.code, 'PERMISSION_DENIED', 'the manager never holds a wildcard');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 3. Wait mode: settle / immediate-quiescent / timeout / bounds
// ============================================================================

test('5. wait_for_agent resolves on the target next settled turn with its bounded output', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'manager', allowedTools: ['manager'] } });
    const gate = deferred();
    await launchAgent(runtime, 'child', createMockModel(async () => {
      await gate.promise;
      return { content: 'late child report' };
    }), { parentId: 'manager' });

    const childTurn = runtime.enqueueUserTurn('child', 'long child work');
    await waitUntil(() => runtime.isAgentBusy('child'));

    const waitPromise = runtime.waitForAgent('child', { timeout_ms: 3000 }, { callerAgentId: 'manager' });
    gate.resolve();
    const result = await waitPromise;
    await childTurn;

    assert.equal(result.success, true, `wait failed: ${result.error}`);
    assert.equal(result.agentId, 'child');
    assert.equal(result.status, 'completed');
    assert.equal(result.output, 'late child report');
    assert.equal(result.outputTruncated, false);
    assert.equal(result.timedOut, false);
    assert.ok(result.turnCount >= 1, 'the receipt carries the cumulative turn count');
  } finally {
    runtime.destroy();
  }
});

test('6. wait_for_agent resolves immediately when the target is already quiescent', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'manager', allowedTools: ['manager'] } });
    await launchAgent(runtime, 'child', createMockModel(async () => ({ content: 'settled child output' })), {
      parentId: 'manager'
    });
    await runtime.executeAgentTurn('child', 'first child turn');

    const result = await runtime.waitForAgent('child', { timeout_ms: 3000 }, { callerAgentId: 'manager' });
    assert.equal(result.success, true);
    assert.equal(result.alreadySettled, true, 'a quiescent target resolves without registering');
    assert.equal(result.timedOut, false);
    assert.equal(result.output, 'settled child output');
  } finally {
    runtime.destroy();
  }
});

test('7. wait_for_agent times out with a partial status while the target is running', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'manager', allowedTools: ['manager'] } });
    const gate = deferred();
    await launchAgent(runtime, 'child', createMockModel(async () => {
      await gate.promise;
      return { content: 'eventual output' };
    }), { parentId: 'manager' });

    const childTurn = runtime.enqueueUserTurn('child', 'gated child work');
    await waitUntil(() => runtime.isAgentBusy('child'));

    const result = await runtime.waitForAgent('child', { timeout_ms: 30 }, { callerAgentId: 'manager' });
    assert.equal(result.success, true);
    assert.equal(result.timedOut, true, 'a running target produces a partial timeout receipt');
    assert.equal(result.agentId, 'child');
    assert.equal(result.status, 'running');

    gate.resolve();
    await childTurn;
  } finally {
    runtime.destroy();
  }
});

test('8. wait_for_agent bounds oversized output at 4000 characters', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'manager', allowedTools: ['manager'] } });
    await launchAgent(runtime, 'child', createMockModel(async () => ({ content: 'x'.repeat(5000) })), {
      parentId: 'manager'
    });
    await runtime.executeAgentTurn('child', 'big child turn');

    const result = await runtime.waitForAgent('child', { timeout_ms: 1000 }, { callerAgentId: 'manager' });
    assert.equal(result.success, true);
    assert.equal(result.outputTruncated, true, 'an oversized output is flagged');
    assert.ok(result.output.length <= OUTPUT_BOUND + 32, 'the delivered output is bounded');
    assert.ok(result.output.includes('[truncated]'), 'the truncation marker is present');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 4. Notify mode: one-shot queue wake, no mailbox envelopes
// ============================================================================

test('9. notify registers a one-shot completion wake with bare ids and zero mailbox envelopes', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'watcher', allowedTools: ['manager'] } });
    const gate = deferred();
    await launchAgent(runtime, 'target', createMockModel(async () => {
      await gate.promise;
      return { content: 'target completion payload' };
    }), { parentId: 'watcher' });

    const targetTurn = runtime.enqueueUserTurn('target', 'gated target work');
    await waitUntil(() => runtime.isAgentBusy('target'));

    const registration = await runtime.waitForAgent('target', { notify: true }, { callerAgentId: 'watcher' });
    assert.equal(registration.success, true, `notify failed: ${registration.error}`);
    assert.equal(registration.mode, 'notify');
    assert.equal(typeof registration.subscriptionId, 'string');
    assert.equal(registration.alreadySettled, false, 'a busy target registers a future settle wake');

    gate.resolve();
    await targetTurn;

    await waitUntil(() => completionWakeCount(runtime, 'watcher') === 1, 3000);
    const wake = runtime.getAgent('watcher').history.find(
      (message) => message.role === 'user' && message.content.startsWith('[AGENT COMPLETE]')
    );
    assert.ok(wake.content.includes("'target'"), 'the wake names the target bare id');
    assert.ok(wake.content.includes('target completion payload'), 'the wake carries the result token');
    assert.ok(!wake.content.includes('realm:'), 'the wake never carries realm vocabulary');
    assert.ok(!wake.content.includes('system:'), 'the wake never carries system-scope vocabulary');

    const bus = runtime.messagingBus;
    for (const agentId of ['watcher', 'target']) {
      assert.equal(bus.getUnreadCount(agentId), 0, `'${agentId}' unread stays zero`);
      assert.equal(bus.listInbox(agentId).length, 0, `'${agentId}' inbox stays empty`);
      assert.equal(bus.getArchive(agentId).length, 0, `'${agentId}' archive stays empty`);
    }

    // One-shot: a later target turn never fires the spent registration.
    await runtime.executeAgentTurn('target', 'second target turn');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(completionWakeCount(runtime, 'watcher'), 1, 'no every-turn subscription survives');
  } finally {
    runtime.destroy();
  }
});

test('10. an already-quiescent notify fire queues the wake immediately', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'watcher', allowedTools: ['manager'] } });
    await launchAgent(runtime, 'target', createMockModel(async () => ({ content: 'already done' })), {
      parentId: 'watcher'
    });
    await runtime.executeAgentTurn('target', 'first target turn');

    const registration = await runtime.waitForAgent('target', { notify: true }, { callerAgentId: 'watcher' });
    assert.equal(registration.success, true);
    assert.equal(registration.alreadySettled, true, 'a quiescent target fires without racing a future turn');

    await waitUntil(() => completionWakeCount(runtime, 'watcher') === 1, 3000);
    const wake = runtime.getAgent('watcher').history.find(
      (message) => message.role === 'user' && message.content.startsWith('[AGENT COMPLETE]')
    );
    assert.ok(wake.content.includes('already done'), 'the immediate wake carries the latest output');
  } finally {
    runtime.destroy();
  }
});

test('11. a busy watcher queues the wake behind its turn (INV-3)', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    const managerGate = deferred();
    let watcherCalls = 0;
    await runtime.launchAgent({
      config: { id: 'watcher', allowedTools: ['manager'] },
      model: createMockModel(async () => {
        watcherCalls += 1;
        if (watcherCalls === 1) await managerGate.promise;
        return { content: `watcher turn ${watcherCalls}` };
      })
    });
    await launchAgent(runtime, 'target', createMockModel(async () => ({ content: 'target done' })), {
      parentId: 'watcher'
    });
    await runtime.executeAgentTurn('target', 'first target turn');

    const watcherTurn = runtime.enqueueUserTurn('watcher', 'long watcher work');
    await waitUntil(() => runtime.isAgentBusy('watcher'));

    const registration = await runtime.waitForAgent('target', { notify: true }, { callerAgentId: 'watcher' });
    assert.equal(registration.success, true);
    assert.equal(registration.alreadySettled, true, 'the quiescent target fires the wake immediately');

    const watcherKey = identityKeyOf(runtime, 'watcher');
    assert.equal(runtime.triggerQueue.getPendingCount(watcherKey), 1, 'the busy watcher holds the wake in the queue');
    assert.equal(completionWakeCount(runtime, 'watcher'), 0, 'no mid-turn wake is injected');

    managerGate.resolve();
    await watcherTurn;
    await waitUntil(() => completionWakeCount(runtime, 'watcher') === 1, 3000);
    assert.equal(runtime.triggerQueue.getPendingCount(watcherKey), 0, 'the wake leaves the queue once dispatched');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 5. Lifecycle drop and authorization matrix
// ============================================================================

test('12. killing the watcher drops its registration: the settle fires no wake', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'watcher', allowedTools: ['manager'] } });
    const gate = deferred();
    await launchAgent(runtime, 'target', createMockModel(async () => {
      await gate.promise;
      return { content: 'orphaned target output' };
    }), { parentId: 'watcher' });

    const targetTurn = runtime.enqueueUserTurn('target', 'gated target work');
    await waitUntil(() => runtime.isAgentBusy('target'));

    const watcherKey = identityKeyOf(runtime, 'watcher');
    const registration = await runtime.waitForAgent('target', { notify: true }, { callerAgentId: 'watcher' });
    assert.equal(registration.success, true);
    assert.equal(registration.alreadySettled, false);

    runtime.killAgent('watcher', 'test kill', { callerAgentId: 'watcher' });
    assert.equal(runtime.isAgentTerminated('watcher'), true, 'the watcher is terminated');

    gate.resolve();
    await targetTurn;
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(runtime.triggerQueue.getPendingCount(watcherKey), 0, 'the dropped registration queues no wake');
  } finally {
    runtime.destroy();
  }
});

test('13. authorization matrix: self / parent / @lifecycle:authority / denied peer / realm confinement', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    const operator = runtime.getOperatorPrincipal();
    await runtime.launchAgent({ config: { id: 'manager', allowedTools: ['manager'] } });
    await launchAgent(runtime, 'child', createMockModel(async () => ({ content: 'child output' })), {
      parentId: 'manager'
    });
    await runtime.launchAgent({
      config: { id: 'authority_agent', allowedTools: ['@lifecycle:authority'] },
      principal: operator
    });
    await runtime.launchAgent({ config: { id: 'peer', allowedTools: ['read_file'] } });
    await runtime.launchAgent({
      config: { id: 'alpha_root', allowedTools: ['*'], realmId: 'realm_alpha_wfa' },
      principal: operator
    });
    await runtime.launchAgent({
      config: { id: 'beta_worker', allowedTools: ['read_file'], realmId: 'realm_beta_wfa' },
      principal: operator
    });

    // Self: an agent may watch its own next settle.
    const self = await runtime.waitForAgent('authority_agent', { timeout_ms: 50 }, { callerAgentId: 'authority_agent' });
    assert.equal(self.success, true, `self watch must be allowed: ${self.error}`);

    // Parent: the registered creator may watch its child.
    const parent = await runtime.waitForAgent('child', { timeout_ms: 50 }, { callerAgentId: 'manager' });
    assert.equal(parent.success, true, `parent watch must be allowed: ${parent.error}`);

    // `@lifecycle:authority`: an authority holder may watch a same-realm peer.
    const authority = await runtime.waitForAgent('peer', { timeout_ms: 50 }, { callerAgentId: 'authority_agent' });
    assert.equal(authority.success, true, `authority watch must be allowed: ${authority.error}`);

    // Denied: an ordinary peer may not watch another peer.
    const denied = await runtime.waitForAgent('authority_agent', { timeout_ms: 50 }, { callerAgentId: 'peer' });
    assert.equal(denied.success, false, 'an ordinary peer watch is denied');
    assert.equal(denied.code, 'PERMISSION_DENIED');

    // Realm confinement: even a wildcard realm-bound caller never watches across realms.
    const crossRealm = await runtime.waitForAgent('beta_worker', { timeout_ms: 50 }, { callerAgentId: 'alpha_root' });
    assert.equal(crossRealm.success, false, 'cross-realm watch is denied');
    assert.equal(crossRealm.code, 'PERMISSION_DENIED');

    // Host path: no caller context is the composition-root/operator path.
    const host = await runtime.waitForAgent('peer', { timeout_ms: 50 });
    assert.equal(host.success, true, `the host watch path must stay open: ${host.error}`);
  } finally {
    runtime.destroy();
  }
});

test('14. terminated targets and unresolved callers fail closed', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'manager', allowedTools: ['manager'] } });
    await launchAgent(runtime, 'child', createMockModel(async () => ({ content: 'child output' })), {
      parentId: 'manager'
    });
    runtime.killAgent('child', 'test termination', { callerAgentId: 'manager' });

    const terminated = await runtime.waitForAgent('child', {}, { callerAgentId: 'manager' });
    assert.equal(terminated.success, false, 'a terminated target cannot be watched');
    assert.equal(terminated.code, 'AGENT_TERMINATED');

    const missing = await runtime.waitForAgent('no_such_agent', {}, { callerAgentId: 'manager' });
    assert.equal(missing.success, false, 'an unknown target cannot be watched');
    assert.equal(missing.code, 'AGENT_NOT_FOUND');

    const unresolved = await runtime.waitForAgent('manager', {}, {});
    assert.equal(unresolved.success, false, 'an unresolved caller fails closed');
    assert.equal(unresolved.code, 'PERMISSION_DENIED');

    const ambiguousNotify = await runtime.waitForAgent('manager', { notify: true });
    assert.equal(ambiguousNotify.success, false, 'notify needs a resolved watcher agent');
    assert.equal(ambiguousNotify.code, 'INVALID_ARGUMENTS');
  } finally {
    runtime.destroy();
  }
});
