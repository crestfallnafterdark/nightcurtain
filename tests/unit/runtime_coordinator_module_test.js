/**
 * @file tests/unit/runtime_coordinator_module_test.js
 * @description Comprehensive isolated unit test suite for Module 13: `runtime_coordinator`.
 *
 * Verifies strict ICD-MOD13-RTC compliance and architectural guarantees:
 *   1. Contract Invariants & Strict Whitelist Proof (E \ D = ∅)
 *   2. Factory Creation & Dependency Injections
 *   3. Core Engine Lifecycle & Substrates (reset, destroy, ensureDirector)
 *   4. Agent Provisioning & Registry Governance (launch, list, whoami, updateConfig)
 *   5. Agent Teardown, Recycling, Restoration & Emergency Unstick
 *   6. Turn Execution Engine Integration & Status State Machine (READY -> RUNNING -> READY)
 *   7. History Management & Dual-Stack Undo/Redo
 *   8. Multi-Agent Direct RPC & Turn-Level Await Coordination (invokeAgent, waitForInvocation, waitForMail)
 *   9. Runtime Scheduling, Deferred Timers & Early Cancellation Routing
 *  10. Telemetry & Aggregate System Metrics
 *  11. Event Pub/Sub Routing (subscribe, on)
 *  12. State Snapshot Persistence & Disaster Recovery (exportSnapshot, importSnapshot)
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as RuntimeIndexModule from '../../src/lib/sandbox/runtime/index.ts';
import {
  AgentRuntime,
  createAgentRuntime,
  createAgentIdentityKey,
  RUNTIME_STATUS
} from '../../src/lib/sandbox/runtime/index.ts';

import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';
import { InvocationEngine } from '../../src/lib/sandbox/invocationEngine/index.ts';
import { TriggerQueue } from '../../src/lib/sandbox/triggerQueue/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';

/**
 * Converted module contract source (`runtime/index.ts`); `WaitForInvocationResult`
 * is a type-only export, so the naming assertion below is necessarily a static
 * contract check.
 */
const RUNTIME_CONTRACT_PATH = path.resolve(
  import.meta.dirname,
  '../../src/lib/sandbox/runtime/index.ts'
);

// ============================================================================
// Test Mock Factories & Helpers
// ============================================================================

/**
 * Creates a mock LLM model instance with configurable stream / complete behaviors.
 * @param {Array<Object>} responses
 */
function createMockModel(responses = []) {
  let responseIndex = 0;
  const mockProvider = { name: 'mock_provider', providerName: 'mock' };
  return {
    provider: mockProvider,
    async *stream(options) {
      const resp = responses[responseIndex++] || { content: 'Default mock response' };
      if (resp.error) {
        throw resp.error;
      }
      if (resp.delayMs) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, resp.delayMs);
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              const abortErr = new Error('AbortError');
              abortErr.name = 'AbortError';
              reject(abortErr);
            }, { once: true });
          }
        });
      }
      if (resp.reasoning) {
        yield { type: 'reasoning', content: resp.reasoning };
      }
      if (resp.content) {
        yield { type: 'text', content: resp.content };
      }
      if (resp.toolCalls) {
        yield { type: 'tool_call', toolCalls: resp.toolCalls };
      }
      if (resp.usage) {
        yield { type: 'usage', usage: resp.usage };
      }
      yield {
        type: 'finish',
        content: resp.content || '',
        reasoning: resp.reasoning || '',
        toolCalls: resp.toolCalls || null,
        usage: resp.usage || { promptTokens: 15, completionTokens: 25, totalTokens: 40 }
      };
    },
    async complete(options) {
      const resp = responses[responseIndex++] || { content: 'Default mock response' };
      if (resp.error) throw resp.error;
      return {
        content: resp.content || '',
        reasoning: resp.reasoning || '',
        toolCalls: resp.toolCalls || null,
        usage: resp.usage || { promptTokens: 15, completionTokens: 25, totalTokens: 40 }
      };
    }
  };
}

// ============================================================================
// 1. Contract Invariants & Strict Whitelist Proof (E \ D = ∅)
// ============================================================================

test('1. Contract Invariants: Export Whitelist & RUNTIME_STATUS Immutability', () => {
  const exportedKeys = Object.keys(RuntimeIndexModule).sort();
  assert.deepStrictEqual(exportedKeys, [
    'AgentRuntime',
    'RUNTIME_STATUS',
    'createAgentIdentityKey',
    'createAgentRuntime',
    'parseAgentIdentityKey'
  ]);

  // RUNTIME_STATUS validation
  assert.ok(Object.isFrozen(RUNTIME_STATUS), 'RUNTIME_STATUS must be frozen');
  assert.strictEqual(RUNTIME_STATUS.UNINITIALIZED, 'uninitialized');
  assert.strictEqual(RUNTIME_STATUS.INITIALIZING, 'initializing');
  assert.strictEqual(RUNTIME_STATUS.READY, 'ready');
  assert.strictEqual(RUNTIME_STATUS.RUNNING, 'running');
  assert.strictEqual(RUNTIME_STATUS.DESTROYED, 'destroyed');
  assert.strictEqual(RUNTIME_STATUS.PAUSED, undefined, 'PAUSED is never assigned and was removed from the contract');
  assert.strictEqual(RUNTIME_STATUS.STOPPED, undefined, 'STOPPED is never assigned and was removed from the contract');
});

test('1b. Contract: WaitForInvocationResult is re-exported by the facade contract', () => {
  const contractSource = fs.readFileSync(RUNTIME_CONTRACT_PATH, 'utf-8');

  assert.match(
    contractSource,
    /export\s+type\s*\{\s*WaitForInvocationResult\s*\}\s*from\s*['"]\.\.\/invocationEngine\/index\.ts['"]/,
    'runtime/index.ts must re-export WaitForInvocationResult so consumers can name the documented return type'
  );
});

test('2. Contract Invariants: Substrate Read-Only Getters', () => {
  const runtime = createAgentRuntime();
  try {
    assert.strictEqual(runtime.status, RUNTIME_STATUS.READY);
    assert.ok(runtime.virtualFs instanceof VirtualFS);
    assert.ok(runtime.messagingBus instanceof MessagingBus);
    assert.ok(runtime.worldClock instanceof WorldClock);
    assert.ok(runtime.invocationEngine instanceof InvocationEngine);
    assert.ok(runtime.triggerQueue instanceof TriggerQueue);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Factory Creation & Dependency Injections
// ============================================================================

test('3. Factory: Dependency Injection and Custom Substrates', async () => {
  const customVfs = new VirtualFS({ defaultBudgetBytes: 50000 });
  const customBus = new MessagingBus();
  const customClock = new WorldClock({ virtualFs: customVfs });
  const customInvocationEngine = new InvocationEngine();

  const runtime = createAgentRuntime({
    virtualFs: customVfs,
    messagingBus: customBus,
    worldClock: customClock,
    invocationEngine: customInvocationEngine,
    mailboxAutonomy: true,
    customTools: { custom_echo: { name: 'custom_echo', execute: async () => 'echoed' } },
    autoBootstrapDirector: false
  });

  try {
    assert.strictEqual(runtime.virtualFs, customVfs);
    assert.strictEqual(runtime.messagingBus, customBus);
    assert.strictEqual(runtime.worldClock, customClock);
    assert.strictEqual(runtime.invocationEngine, customInvocationEngine);
    assert.strictEqual(runtime.status, RUNTIME_STATUS.READY);

    // MOD-21 W8-D: the composition root binds its opaque principal into an
    // injected VFS (first bind wins) so engine tenant administration keeps
    // working; without the bind the eviction below would default-deny.
    await runtime.launchAgent({ id: 'injected_vfs_worker' });
    runtime.killAgent('injected_vfs_worker', 'Engine eviction probe', { callerAgentId: 'injected_vfs_worker' });
    assert.strictEqual(runtime.hasRecycledAgent('injected_vfs_worker'), true, 'engine eviction on an injected VFS is authorized');
  } finally {
    runtime.destroy();
  }
});

test('4. Factory: Auto-Bootstrap Director Meta-Agent', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: true });
  try {
    const director = await runtime.ensureDirector();
    assert.ok(director);
    assert.strictEqual(director.id, 'director');
    assert.strictEqual(director.config.role, 'director');
    assert.strictEqual(director.config.privileged, true);
    assert.ok(runtime.hasAgent('director'));

    const identity = runtime.whoami('director');
    assert.strictEqual(identity.role, 'director');
    assert.strictEqual(identity.privileged, true);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 3. Core Engine Lifecycle & Substrates (reset, destroy, ensureDirector)
// ============================================================================

test('5. Lifecycle: ensureDirector Idempotency and Governance', async () => {
  const runtime = createAgentRuntime();
  try {
    const d1 = await runtime.ensureDirector();
    const d2 = await runtime.ensureDirector();
    assert.strictEqual(d1, d2, 'ensureDirector must return the singleton instance');
    assert.strictEqual(d1.id, 'director');
    assert.strictEqual(runtime.getAgentCount(), 1);
  } finally {
    runtime.destroy();
  }
});

test('6. Lifecycle: Reset Flushes State Cleanly', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'worker_1', role: 'writer' });
    await runtime.launchAgent({ id: 'worker_2', role: 'reviewer' });
    assert.strictEqual(runtime.getAgentCount(), 2);

    runtime.schedule({
      targetAgentId: 'worker_1',
      durationSeconds: 60,
      prompt: 'Pending task'
    });
    assert.strictEqual(runtime.getRuntimeMetrics().activeTimersCount, 1);

    runtime.reset();

    assert.strictEqual(runtime.getAgentCount(), 0);
    assert.strictEqual(runtime.listAgents().length, 0);
    assert.strictEqual(runtime.listRecycledAgents().length, 0);
    assert.strictEqual(runtime.getRuntimeMetrics().activeTimersCount, 0);
    assert.strictEqual(runtime.status, RUNTIME_STATUS.READY);
  } finally {
    runtime.destroy();
  }
});

test('7. Lifecycle: Destroy Tears Down Subsystems & Locks Facade', async () => {
  const runtime = createAgentRuntime();
  await runtime.launchAgent({ id: 'worker_1', role: 'worker' });

  runtime.destroy();

  assert.strictEqual(runtime.status, RUNTIME_STATUS.DESTROYED);
  assert.strictEqual(runtime.getAgentCount(), 0);

  // Calling methods after destroy must throw ERR_RUNTIME_DESTROYED
  assert.throws(() => runtime.reset(), { code: 'ERR_RUNTIME_DESTROYED' });
  assert.throws(() => runtime.exportSnapshot(), { code: 'ERR_RUNTIME_DESTROYED' });
  assert.throws(() => runtime.importSnapshot({ agents: [], recycleBin: [] }), { code: 'ERR_RUNTIME_DESTROYED' });
  await assert.rejects(async () => runtime.launchAgent({ id: 'new_worker' }), { code: 'ERR_RUNTIME_DESTROYED' });
  await assert.rejects(async () => runtime.ensureDirector(), { code: 'ERR_RUNTIME_DESTROYED' });
  await assert.rejects(async () => runtime.executeAgentTurn('worker_1', 'Hello'), { code: 'ERR_RUNTIME_DESTROYED' });
  assert.throws(() => runtime.schedule({ targetAgentId: 'worker_1', prompt: 'test' }), { code: 'ERR_RUNTIME_DESTROYED' });
});

// ============================================================================
// 4. Agent Provisioning & Registry Governance
// ============================================================================

test('8. Agent Provisioning: Launch, Query and List Filtering', async () => {
  const runtime = createAgentRuntime();
  try {
    const agent1 = await runtime.launchAgent({
      id: 'writer_alpha',
      name: 'Alpha Writer',
      role: 'writer',
      systemPrompt: 'You write stories.',
      tools: ['fs_read', 'fs_write'],
      spawnedBy: 'director'
    });

    const agent2 = await runtime.launchAgent({
      id: 'critic_beta',
      name: 'Beta Critic',
      role: 'critic',
      systemPrompt: 'You review stories.',
      tools: ['fs_read'],
      spawnedBy: 'director'
    });

    assert.strictEqual(runtime.getAgentCount(), 2);
    assert.strictEqual(runtime.hasAgent('writer_alpha'), true);
    assert.strictEqual(runtime.hasAgent('critic_beta'), true);
    assert.strictEqual(runtime.hasAgent('unknown'), false);

    assert.strictEqual(runtime.getAgent('writer_alpha'), agent1);
    assert.strictEqual(runtime.getAgent('critic_beta'), agent2);
    assert.strictEqual(runtime.getAgent('unknown'), null);

    // List filtering
    const all = runtime.listAgents();
    assert.strictEqual(all.length, 2);

    const writers = runtime.listAgents({ role: 'writer' });
    assert.strictEqual(writers.length, 1);
    assert.strictEqual(writers[0].id, 'writer_alpha');

    const byDirector = runtime.listAgents({ spawnedBy: 'director' });
    assert.strictEqual(byDirector.length, 2);

    const idleAgents = runtime.listAgents({ state: 'idle' });
    assert.strictEqual(idleAgents.length, 2);
  } finally {
    runtime.destroy();
  }
});

test('8b. Agent Provisioning: baked history passes through the facade with no model call (7e6edae)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    let modelCalls = 0;
    const probeModel = {
      provider: { name: 'seed_probe_provider', providerName: 'seed_probe' },
      async *stream() {
        modelCalls++;
        yield { type: 'finish', content: '', reasoning: '', toolCalls: null, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      },
      async complete() {
        modelCalls++;
        return { content: '', reasoning: '', toolCalls: null, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
      }
    };

    const agent = await runtime.launchAgent({
      config: { id: 'seeded_writer', role: 'writer', systemPrompt: 'You write.' },
      history: [
        { role: 'assistant', content: 'Chapter one is already written.', source: 'template' },
        { role: 'user', content: 'Continue where it stopped.' }
      ],
      model: probeModel
    });

    assert.strictEqual(modelCalls, 0, 'seeding history runs no model call');
    assert.strictEqual(agent.state, AGENT_STATES.IDLE, 'the seeded agent stays idle');
    assert.deepStrictEqual(
      agent.history.map((m) => [m.role, m.content]),
      [
        ['system', 'You write.'],
        ['assistant', 'Chapter one is already written.'],
        ['user', 'Continue where it stopped.']
      ],
      'the facade passes declared history through to the composed seed in order'
    );
    assert.deepStrictEqual(agent.history[1].metadata, { source: 'template' });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(agent.history[2], 'metadata'), false);

    // Fail-closed validation surfaces the typed error through the facade.
    await assert.rejects(
      () => runtime.launchAgent({
        config: { id: 'bad_seed' },
        history: [{ role: 'system', content: 'never a declared entry' }]
      }),
      (err) => err.code === 'INVALID_CONFIG'
    );
    assert.strictEqual(runtime.hasAgent('bad_seed'), false, 'a rejected seed never registers');

    // Legacy positional signature (config, model) carries no declared history
    // and still runs no turn without an initial prompt.
    const positional = await runtime.launchAgent(
      { id: 'legacy_positional', role: 'worker', systemPrompt: 'Legacy.' },
      probeModel
    );
    assert.strictEqual(modelCalls, 0, 'a positional launch calls no model');
    assert.deepStrictEqual(
      positional.history.map((m) => [m.role, m.content]),
      [['system', 'Legacy.']],
      'the positional form seeds only the system message'
    );
  } finally {
    runtime.destroy();
  }
});

test('9. Agent Provisioning: Config Validation & Duplicate Prevention', async () => {
  const runtime = createAgentRuntime();
  try {
    // Missing ID
    await assert.rejects(
      async () => runtime.launchAgent({ name: 'No ID' }),
      (err) => err.code === 'INVALID_CONFIG' || err.code === 'ERR_INVALID_CONFIG'
    );

    // Initial launch
    await runtime.launchAgent({ id: 'unique_agent', role: 'worker' });

    // Duplicate launch
    await assert.rejects(
      async () => runtime.launchAgent({ id: 'unique_agent', role: 'worker' }),
      (err) => err.code === 'AGENT_ALREADY_EXISTS' || err.code === 'ERR_AGENT_ALREADY_EXISTS'
    );
  } finally {
    runtime.destroy();
  }
});

test('10. Agent Registry: whoami Identity & Permission Inspection', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({
      id: 'researcher_1',
      name: 'Lead Researcher',
      role: 'researcher',
      privileged: false,
      tools: ['fs_read', 'fs_search'],
      workspaceId: 'research_ws',
      spawnedBy: 'director'
    });

    const identity = runtime.whoami('researcher_1');
    assert.strictEqual(identity.id, 'researcher_1');
    assert.strictEqual(identity.name, 'Lead Researcher');
    assert.strictEqual(identity.role, 'researcher');
    assert.strictEqual(identity.privileged, false);
    assert.strictEqual(identity.workspaceId, 'research_ws');
    assert.deepStrictEqual(identity.allowedTools, ['fs_read', 'fs_search']);
    assert.strictEqual(identity.state, 'idle');
    assert.strictEqual(identity.spawnedBy, 'director');
    assert.ok(typeof identity.createdAt === 'number');

    // Invalid agentId
    assert.throws(() => runtime.whoami('non_existent'), { code: 'ERR_AGENT_NOT_FOUND' });
    assert.throws(() => runtime.whoami(''), { code: 'ERR_AGENT_NOT_FOUND' });
  } finally {
    runtime.destroy();
  }
});

test('11. Agent Registry: Dynamic State & Configuration Updates', async () => {
  const runtime = createAgentRuntime();
  try {
    const agent = await runtime.launchAgent({
      id: 'dynamic_worker',
      role: 'worker',
      systemPrompt: 'Initial prompt'
    });

    // setAgentState (MOD-21 W8: self principal authorizes its own transitions)
    runtime.setAgentState('dynamic_worker', AGENT_STATES.RUNNING, 'Executing turn', { callerAgentId: 'dynamic_worker' });
    assert.strictEqual(agent.state, AGENT_STATES.RUNNING);

    runtime.setAgentState('dynamic_worker', AGENT_STATES.IDLE, null, { callerAgentId: 'dynamic_worker' });
    assert.strictEqual(agent.state, AGENT_STATES.IDLE);

    // updateAgentConfig
    runtime.updateAgentConfig('dynamic_worker', {
      systemPrompt: 'Updated prompt directive',
      modelConfig: { temperature: 0.8 }
    });
    assert.strictEqual(agent.config.systemPrompt, 'Updated prompt directive');
    assert.strictEqual(agent.config.modelConfig.temperature, 0.8);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 5. Agent Teardown, Recycling, Restoration & Emergency Unstick
// ============================================================================

test('12. Agent Teardown: Soft-Kill, Recycling & Restoration', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'temp_worker', role: 'helper' });
    assert.strictEqual(runtime.hasAgent('temp_worker'), true);
    assert.strictEqual(runtime.isAgentTerminated('temp_worker'), false);

    // Soft-kill (registry sudoer principal)
    const killed = runtime.killAgent('temp_worker', 'Completed temporary job', { callerAgentId: 'director' });
    assert.ok(killed);
    assert.strictEqual(runtime.hasAgent('temp_worker'), false);
    assert.strictEqual(runtime.hasRecycledAgent('temp_worker'), true);
    assert.strictEqual(runtime.isAgentTerminated('temp_worker'), true);
    assert.strictEqual(runtime.listRecycledAgents().length, 1);

    // Restore (MOD-21 W8: a resolved principal is required)
    const restored = runtime.restoreAgent('temp_worker', { callerAgentId: 'director' });
    assert.strictEqual(restored.id, 'temp_worker');
    assert.strictEqual(restored.state, AGENT_STATES.IDLE);
    assert.strictEqual(runtime.hasAgent('temp_worker'), true);
    assert.strictEqual(runtime.hasRecycledAgent('temp_worker'), false);
    assert.strictEqual(runtime.isAgentTerminated('temp_worker'), false);
  } finally {
    runtime.destroy();
  }
});

test('13. Agent Teardown: Permanent Purge & Recycle Bin Emptying', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'worker_a', role: 'helper' });
    await runtime.launchAgent({ id: 'worker_b', role: 'helper' });

    runtime.killAgent('worker_a', 'Task done', { callerAgentId: 'director' });
    runtime.killAgent('worker_b', 'Task done', { callerAgentId: 'director' });
    assert.strictEqual(runtime.listRecycledAgents().length, 2);

    const emptiedCount = runtime.emptyRecycleBin({ callerAgentId: 'director' });
    assert.strictEqual(emptiedCount, 2);
    assert.strictEqual(runtime.listRecycledAgents().length, 0);

    // Launch and purge directly (MOD-21 W8: purge is sudoer-only)
    await runtime.launchAgent({ id: 'worker_c', role: 'helper' });
    const purged = runtime.purgeAgent('worker_c', { callerAgentId: 'director' });
    assert.strictEqual(purged, true);
    assert.strictEqual(runtime.hasAgent('worker_c'), false);
  } finally {
    runtime.destroy();
  }
});

test('14. Agent Teardown: Emergency Unstick Engine', async () => {
  const runtime = createAgentRuntime();
  try {
    const agent = await runtime.launchAgent({ id: 'stuck_agent', role: 'worker' });
    runtime.setAgentState('stuck_agent', AGENT_STATES.RUNNING, null, { callerAgentId: 'stuck_agent' });

    const unstickResult = runtime.unstickAgent('stuck_agent', 'Watchdog timeout', { callerAgentId: 'stuck_agent' });
    assert.strictEqual(unstickResult.success, true);
    assert.strictEqual(unstickResult.agent.state, AGENT_STATES.IDLE);
    assert.strictEqual(unstickResult.previousState, AGENT_STATES.RUNNING);
    assert.strictEqual(unstickResult.reason, 'Watchdog timeout');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 6. Turn Execution Engine Integration & Status State Machine
// ============================================================================

test('15. Turn Execution: Basic Turn & Runtime Status Transitions', async () => {
  const mockModel = createMockModel([
    { content: 'Hello from mock LLM!', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } }
  ]);

  const runtime = createAgentRuntime();
  try {
    const agent = await runtime.launchAgent({
      id: 'speaker',
      role: 'assistant'
    }, mockModel);

    assert.strictEqual(runtime.status, RUNTIME_STATUS.READY);

    const turnResult = await runtime.executeAgentTurn('speaker', 'Hello assistant');
    assert.strictEqual(turnResult.output, 'Hello from mock LLM!');
    assert.strictEqual(agent.history.length >= 2, true);
    assert.strictEqual(runtime.status, RUNTIME_STATUS.READY);

    // Telemetry updated
    const telemetry = runtime.getAgentTelemetry('speaker');
    assert.ok(telemetry);
    assert.strictEqual(telemetry.totalTokens, 20);
    assert.strictEqual(telemetry.turnCount, 1);
  } finally {
    runtime.destroy();
  }
});

test('15b. enqueueUserTurn: user turns route through the TriggerQueue and resolve the canonical receipt', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'queued_user', role: 'assistant' }, createMockModel([
      { content: 'queued reply one' }
    ]));

    const enqueuedTriggers = [];
    const realEnqueue = runtime.triggerQueue.enqueue.bind(runtime.triggerQueue);
    runtime.triggerQueue.enqueue = (trigger) => {
      const triggerId = realEnqueue(trigger);
      enqueuedTriggers.push({ ...trigger, triggerId });
      return triggerId;
    };

    const executedTurns = [];
    const realExecute = runtime.executeAgentTurn.bind(runtime);
    runtime.executeAgentTurn = (agentId, input, options) => {
      executedTurns.push({ agentId, input, options });
      return realExecute(agentId, input, options);
    };

    const result = await runtime.enqueueUserTurn('queued_user', 'hello queue', { mode: 'directive' });
    assert.strictEqual(result.output, 'queued reply one');
    assert.strictEqual(result.agent.id, 'queued_user');

    const userTriggers = enqueuedTriggers.filter((t) => t.type === 'user');
    assert.strictEqual(userTriggers.length, 1, 'enqueueUserTurn must enqueue exactly one USER trigger');
    assert.strictEqual(
      userTriggers[0].targetAgentId,
      createAgentIdentityKey('realm_generic', 'queued_user'),
      'the USER trigger addresses the canonical registration key (Wave I, d57cbc1)'
    );

    assert.strictEqual(executedTurns.length, 1, 'turn execution must be reached through the queue dispatch');
    assert.strictEqual(executedTurns[0].options.triggerType, 'user');
    assert.strictEqual(
      executedTurns[0].options.triggerId,
      userTriggers[0].triggerId,
      'dispatched turn must carry the queue-assigned triggerId'
    );
  } finally {
    runtime.destroy();
  }
});

test('15c. enqueueUserTurn: per-agent FIFO and busy-agent retention', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'fifo_agent', role: 'assistant' }, createMockModel([
      { delayMs: 80, content: 'reply one' },
      { content: 'reply two' }
    ]));

    const firstPromise = runtime.enqueueUserTurn('fifo_agent', 'one');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(runtime.isAgentBusy('fifo_agent'), true, 'first queued turn must be in flight');
    assert.strictEqual(
      runtime.triggerQueue.getPendingCount('fifo_agent'),
      0,
      'in-flight turn must not remain pending in the queue'
    );

    const secondPromise = runtime.enqueueUserTurn('fifo_agent', 'two');
    assert.strictEqual(
      runtime.triggerQueue.getPendingCount('fifo_agent'),
      1,
      'second user trigger must be retained while the agent is busy'
    );

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    assert.strictEqual(first.output, 'reply one', 'first queued turn settles first (intra-agent FIFO)');
    assert.strictEqual(second.output, 'reply two', 'second queued turn settles after the first');
    assert.strictEqual(runtime.triggerQueue.getPendingCount('fifo_agent'), 0);
  } finally {
    runtime.destroy();
  }
});

test('15d. enqueueUserTurn: cancellation still settles the queued turn as cancelled', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'queued_cancel', role: 'assistant' }, createMockModel([
      { delayMs: 150, content: 'late reply' }
    ]));

    const pendingTurn = runtime.enqueueUserTurn('queued_cancel', 'cancel me');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(runtime.cancelAgent('queued_cancel', 'User pressed Stop', { callerAgentId: 'queued_cancel' }), true);
    const result = await pendingTurn;
    assert.strictEqual(result.cancelled, true, 'queued turn cancellation must surface the cancelled receipt');
  } finally {
    runtime.destroy();
  }
});

test('15e. enqueueUserTurn: pending waiter rejects when its target is killed before dispatch', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'queued_kill', role: 'assistant' }, createMockModel([
      { delayMs: 150, content: 'blocker reply' }
    ]));

    const blocker = runtime.executeAgentTurn('queued_kill', 'blocking turn');
    const queuedTurn = runtime.enqueueUserTurn('queued_kill', 'never dispatched');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(runtime.triggerQueue.getPendingCount('queued_kill'), 1);

    runtime.killAgent('queued_kill', 'User killed the agent', { callerAgentId: 'director' });
    await assert.rejects(
      () => queuedTurn,
      (err) => err.code === 'AGENT_TERMINATED',
      'killed agent must reject its pending user-turn waiter'
    );
    await blocker.catch(() => {});
  } finally {
    runtime.destroy();
  }
});

test('16. Turn Execution: Cooperative Cancellation via cancelAgent', async () => {
  const mockModel = createMockModel([
    { delayMs: 150, content: 'Delayed response' }
  ]);

  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'slow_agent', role: 'worker' }, mockModel);

    const turnPromise = runtime.executeAgentTurn('slow_agent', 'Start long operation');
    // Wait briefly for turn to start
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(runtime.cancelAgent('slow_agent', 'User aborted', { callerAgentId: 'slow_agent' }), true, 'Running agent cancellation returns true');
    assert.strictEqual(runtime.cancelAgent('unknown_agent', 'User aborted'), false, 'Unknown agent cancellation returns false');

    const result = await turnPromise;
    assert.strictEqual(result.cancelled, true);
    assert.strictEqual(runtime.status, RUNTIME_STATUS.READY);
  } finally {
    runtime.destroy();
  }
});

test('16b. Cancellation Contract: cancelAll(reason) propagation & idle receipts', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'bulk_a', role: 'worker' });
    await runtime.launchAgent({ id: 'bulk_b', role: 'worker' });

    // Idle agents have no active turn: false receipt, no state mutation
    assert.strictEqual(runtime.cancelAgent('bulk_a', 'Idle attempt', { callerAgentId: 'bulk_a' }), false);
    assert.strictEqual(runtime.getAgent('bulk_a').state, AGENT_STATES.IDLE);

    const stateChangeReasons = [];
    const unsub = runtime.on('state_change', (evt) => {
      stateChangeReasons.push(evt.payload?.stateDetail);
    });

    runtime.setAgentState('bulk_a', AGENT_STATES.RUNNING, 'Busy', { callerAgentId: 'bulk_a' });
    runtime.setAgentState('bulk_b', AGENT_STATES.RUNNING, 'Busy', { callerAgentId: 'bulk_b' });
    runtime.cancelAll('Emergency shutdown', { callerAgentId: 'director' });

    unsub();

    assert.strictEqual(runtime.getAgent('bulk_a').state, AGENT_STATES.CANCELING);
    assert.strictEqual(runtime.getAgent('bulk_b').state, AGENT_STATES.CANCELING);
    assert.strictEqual(
      stateChangeReasons.filter((r) => r === 'Emergency shutdown').length,
      2,
      'cancelAll reason reaches both per-agent cancellations'
    );
  } finally {
    runtime.destroy();
  }
});

test('17. Turn Execution: Rejects Terminated and Non-Existent Agents', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'doomed_agent', role: 'worker' });
    runtime.killAgent('doomed_agent', 'Terminated', { callerAgentId: 'director' });

    await assert.rejects(
      async () => runtime.executeAgentTurn('doomed_agent', 'Hello'),
      (err) => err.code === 'AGENT_NOT_FOUND' || err.code === 'AGENT_TERMINATED' || err.code === 'ERR_AGENT_NOT_FOUND' || err.code === 'ERR_AGENT_TERMINATED'
    );

    await assert.rejects(
      async () => runtime.executeAgentTurn('non_existent', 'Hello'),
      (err) => err.code === 'AGENT_NOT_FOUND' || err.code === 'ERR_AGENT_NOT_FOUND'
    );
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 7. History Management & Dual-Stack Undo/Redo
// ============================================================================

test('18. History Management: In-Place Update & Cascading Deletion', async () => {
  const mockModel = createMockModel([
    { content: 'Original response' }
  ]);

  const runtime = createAgentRuntime();
  try {
    const agent = await runtime.launchAgent({ id: 'history_agent', role: 'writer' }, mockModel);
    await runtime.executeAgentTurn('history_agent', 'Original user prompt');

    assert.strictEqual(agent.history.length >= 2, true);
    const userMsg = agent.history[0];

    // Update message
    const updated = runtime.updateHistoryMessage('history_agent', userMsg.id, {
      content: 'Edited user prompt',
      metadata: { edited: true }
    });
    assert.strictEqual(updated.content, 'Edited user prompt');
    assert.strictEqual(agent.history[0].content, 'Edited user prompt');

    // Delete message
    const deleted = runtime.deleteHistoryMessage('history_agent', agent.history[1].id);
    assert.strictEqual(deleted, true);
  } finally {
    runtime.destroy();
  }
});

test('19. History Management: Dual-Stack Undo and Redo', async () => {
  const mockModel = createMockModel([
    { content: 'Turn 1 answer' },
    { content: 'Turn 2 answer' }
  ]);

  const runtime = createAgentRuntime();
  try {
    const agent = await runtime.launchAgent({ id: 'undo_agent', role: 'writer' }, mockModel);
    await runtime.executeAgentTurn('undo_agent', 'Question 1');
    await runtime.executeAgentTurn('undo_agent', 'Question 2');

    assert.strictEqual(agent.turnCount, 2);

    // Undo turn 2
    const undoResult = runtime.undoAgentTurn('undo_agent');
    assert.ok(undoResult.count >= 1);
    assert.strictEqual(agent.redoStack.length, 1);
    assert.strictEqual(agent.turnCount, 1);

    // Redo turn 2
    const redoResult = runtime.redoAgentTurn('undo_agent');
    assert.strictEqual(redoResult.success, true);
    assert.strictEqual(agent.turnCount, 2);

    // Targeted undo through the facade forwards the optional turn selector
    const rolesBeforeTargetedUndo = agent.history.map((m) => m.role);
    const firstUser = agent.history.find((m) => m.role === 'user');
    const firstUserIndex = agent.history.indexOf(firstUser);
    const targetedUndo = runtime.undoAgentTurn('undo_agent', firstUser.id);
    assert.strictEqual(targetedUndo.undoneUserContent, 'Question 1');
    assert.strictEqual(targetedUndo.count, 2);
    assert.strictEqual(agent.redoStack.length, 1);
    assert.strictEqual(agent.redoStack[0].insertionIndex, firstUserIndex);

    const targetedRedo = runtime.redoAgentTurn('undo_agent');
    assert.strictEqual(targetedRedo.success, true);
    assert.deepStrictEqual(agent.history.map((m) => m.role), rolesBeforeTargetedUndo);

    // Unmatched selector surfaces the structured failure without mutation
    const missingUndo = runtime.undoAgentTurn('undo_agent', 'missing_turn');
    assert.strictEqual(missingUndo.success, false);
    assert.strictEqual(missingUndo.reason, 'TURN_NOT_FOUND');
    assert.strictEqual(missingUndo.targetTurnId, 'missing_turn');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 8. Multi-Agent Direct RPC & Turn-Level Await Coordination
// ============================================================================

test('20. Multi-Agent RPC: invokeAgent and waitForInvocation', async () => {
  const criticModel = createMockModel([
    { content: 'Chapter review: well structured.', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } }
  ]);

  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();

    await runtime.launchAgent({
      id: 'critic_subagent',
      name: 'Story Critic',
      role: 'critic',
      spawnedBy: 'director'
    }, criticModel);

    // Director invokes subagent
    const receipt = runtime.invokeAgent('director', 'critic_subagent', 'Critique the scene', {
      depth: 0
    });

    assert.strictEqual(receipt.success, true);
    assert.ok(receipt.invocationId);
    assert.strictEqual(receipt.targetAgentId, 'critic_subagent');

    // Await invocation
    const waitResult = await runtime.waitForInvocation(receipt.invocationId, {
      timeoutMs: 5000
    });

    assert.strictEqual(waitResult.success, true);
    assert.strictEqual(waitResult.results.length, 1);
    assert.strictEqual(waitResult.results[0].output, 'Chapter review: well structured.');
  } finally {
    runtime.destroy();
  }
});

test('21. Multi-Agent Messaging: waitForMail Delivery', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'receiver_agent', role: 'worker' });
    await runtime.launchAgent({ id: 'sender_agent', role: 'worker' });

    // Initiate waitForMail in background
    const waitPromise = runtime.waitForMail('receiver_agent', {
      senderIds: ['sender_agent'],
      timeoutMs: 5000
    });

    // Send mail via bus
    runtime.messagingBus.sendMessage({
      from: 'sender_agent',
      to: 'receiver_agent',
      content: 'Here is your task input'
    });

    const mailResult = await waitPromise;
    assert.strictEqual(mailResult.success, true);
    assert.strictEqual(mailResult.messages.length, 1);
    assert.strictEqual(mailResult.messages[0].content, 'Here is your task input');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 9. Runtime Scheduling, Deferred Timers & Early Cancellation Routing
// ============================================================================

test('22. Scheduling: One-Shot Timer & Schedule Listing', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'scheduled_agent', role: 'worker' });

    const schedResult = runtime.schedule({
      targetAgentId: 'scheduled_agent',
      durationSeconds: 10,
      prompt: 'Perform health check'
    });

    assert.strictEqual(schedResult.success, true);
    assert.ok(schedResult.timerId);
    assert.strictEqual(schedResult.targetAgentId, 'scheduled_agent');

    // List schedules
    const listResult = runtime.listSchedules({ agentId: 'scheduled_agent' }, { callerAgentId: 'director' });
    assert.strictEqual(listResult.success, true);
    assert.strictEqual(listResult.schedules.length, 1);
    assert.strictEqual(listResult.schedules[0].timerId, schedResult.timerId);

    // Caller identity in the object form is caller-controlled and ignored: the
    // forged ownership claim is denied and the timer is untouched.
    const forgedCancel = runtime.cancelSchedule({
      timerId: schedResult.timerId,
      reason: 'Forged identity',
      callerAgentId: 'scheduled_agent'
    });
    assert.strictEqual(forgedCancel.success, false);
    assert.strictEqual(forgedCancel.code, 'PERMISSION_DENIED');

    // The trusted context identity authorizes the owner cancellation.
    const cancelResult = runtime.cancelSchedule(
      { timerId: schedResult.timerId, reason: 'Not needed' },
      null,
      { callerAgentId: 'scheduled_agent' }
    );
    assert.strictEqual(cancelResult.success, true);
  } finally {
    runtime.destroy();
  }
});

test('22b. Scheduling authority is principal-driven, not caller-assertable (MOD-21)', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'manager_agent', role: 'worker' });
    await runtime.launchAgent({ id: 'peer_agent', role: 'worker' });

    const managerTimer = runtime.schedule({
      targetAgentId: 'manager_agent',
      durationSeconds: 120,
      prompt: 'Manager timer'
    });
    const peerTimer = runtime.schedule({
      targetAgentId: 'peer_agent',
      durationSeconds: 120,
      prompt: 'Peer timer'
    });
    assert.strictEqual(managerTimer.success, true);
    assert.strictEqual(peerTimer.success, true);

    // Privilege-looking option flags on the public facade are ignored: an
    // anonymous caller still sees nothing and can never widen visibility.
    assert.deepStrictEqual(runtime.listSchedules({ isPrivileged: true }).schedules, []);
    assert.deepStrictEqual(runtime.listSchedules({ isAdmin: true }).schedules, []);
    assert.deepStrictEqual(runtime.listSchedules({ privileged: true, all: true }).schedules, []);

    // A manager agent sees only its own schedules through the trusted identity context.
    const managerList = runtime.listSchedules({}, { callerAgentId: 'manager_agent' });
    assert.strictEqual(managerList.schedules.length, 1);
    assert.strictEqual(managerList.schedules[0].timerId, managerTimer.timerId);

    // Privilege-looking option flags combined with a trusted identity cannot widen scope.
    const managerScoped = runtime.listSchedules(
      { isPrivileged: true, isAdmin: true, privileged: true },
      { callerAgentId: 'manager_agent' }
    );
    assert.strictEqual(managerScoped.schedules.length, 1);
    assert.strictEqual(managerScoped.schedules[0].timerId, managerTimer.timerId);

    // The explicit admin context path lists all schedules.
    const adminList = runtime.listSchedules({}, { callerAgentId: 'director' });
    assert.strictEqual(adminList.schedules.length, 2);

    // Cancellation privilege smuggled through the object form is ignored...
    const forgedCancel = runtime.cancelSchedule({ timerId: managerTimer.timerId, isPrivileged: true });
    assert.strictEqual(forgedCancel.success, false);
    assert.strictEqual(forgedCancel.code, 'PERMISSION_DENIED');

    // ...while the explicit trusted context still grants privileged cancellation.
    const privilegedCancel = runtime.cancelSchedule(peerTimer.timerId, null, { callerAgentId: 'director' });
    assert.strictEqual(privilegedCancel.success, true);

    // The forged attempt left the victim timer pending.
    const stillPending = runtime.listSchedules({}, { callerAgentId: 'director' }).schedules
      .find((s) => s.timerId === managerTimer.timerId);
    assert.ok(stillPending);
    assert.strictEqual(stillPending.status, 'pending');
  } finally {
    runtime.destroy();
  }
});

test('23. Scheduling: Early Timer Cancellation on Bus Message Arrival', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'waiting_worker', role: 'worker' });
    await runtime.launchAgent({ id: 'boss_agent', role: 'director' });

    const schedResult = runtime.schedule({
      targetAgentId: 'waiting_worker',
      durationSeconds: 60,
      prompt: 'Fallback wake up if boss does not respond',
      timerCondition: 'boss_agent'
    });

    assert.strictEqual(schedResult.success, true);

    // Send message from boss_agent to satisfy condition
    runtime.messagingBus.sendMessage({
      from: 'boss_agent',
      to: 'waiting_worker',
      content: 'Here is the early update'
    });

    // Check timer status was cancelled early
    const schedules = runtime.listSchedules({ agentId: 'waiting_worker' }, { principal: runtime.createAgentIdentityPort().getAgentIdentity('waiting_worker').authority });
    const targetTimer = schedules.schedules.find((s) => s.timerId === schedResult.timerId);
    assert.ok(targetTimer);
    assert.strictEqual(targetTimer.status, 'cancelled');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 10. Telemetry & Aggregate System Metrics
// ============================================================================

test('24. Telemetry & System Metrics Accounting', async () => {
  const mockModel = createMockModel([
    { content: 'Turn 1', usage: { promptTokens: 10, completionTokens: 15, totalTokens: 25 } },
    { content: 'Turn 2', usage: { promptTokens: 20, completionTokens: 30, totalTokens: 50 } }
  ]);

  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'metrics_agent', role: 'worker' }, mockModel);

    await runtime.executeAgentTurn('metrics_agent', 'Do turn 1');
    await runtime.executeAgentTurn('metrics_agent', 'Do turn 2');

    const agentTelem = runtime.getAgentTelemetry('metrics_agent');
    assert.strictEqual(agentTelem.turnCount, 2);
    assert.strictEqual(agentTelem.totalTokens, 75);

    const runtimeMetrics = runtime.getRuntimeMetrics();
    assert.strictEqual(runtimeMetrics.totalActiveAgents, 1);
    assert.strictEqual(runtimeMetrics.totalTurnsExecuted, 2);
    assert.strictEqual(runtimeMetrics.totalTokensConsumed, 75);
    assert.ok(typeof runtimeMetrics.uptimeSeconds === 'number');

    // Clear telemetry
    const cleared = runtime.clearAgentTelemetry('metrics_agent');
    assert.strictEqual(cleared, true);
    const telemAfter = runtime.getAgentTelemetry('metrics_agent');
    assert.strictEqual(telemAfter.totalTokens, 0);

    // Realm-ambiguous bare ids fail closed (Wave I, ticket d57cbc1; fix lane
    // G2): telemetry is keyed canonically, so a bare id registered in two
    // Realms returns null — never a zeroed snapshot that masks the ambiguity
    // and never the other Realm's counters — while the canonical key still
    // reads the zeroed snapshot.
    await runtime.launchAgent({ id: 'dual_metrics', realmId: 'realm_telem_a' }, createMockModel());
    await runtime.launchAgent({ id: 'dual_metrics', realmId: 'realm_telem_b' }, createMockModel());
    assert.strictEqual(runtime.getAgentTelemetry('dual_metrics'), null, 'an ambiguous bare id yields null telemetry');
    assert.strictEqual(runtime.clearAgentTelemetry('dual_metrics'), false, 'an ambiguous bare id clears nothing');
    const dualAlpha = runtime.createAgentIdentityPort().getAgentIdentity('dual_metrics', { realmId: 'realm_telem_a' });
    assert.ok(dualAlpha, 'the fixture resolves its realm-exact registration');
    assert.strictEqual(
      runtime.getAgentTelemetry(dualAlpha.key).turnCount,
      0,
      'the canonical key still reads a zeroed snapshot'
    );
  } finally {
    runtime.destroy();
  }
});

test('24b. Telemetry: activeTimersCount counts pending schedules while anonymous listSchedules stays empty', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent({ id: 'timer_metrics_agent', role: 'worker' });

    const sched = runtime.schedule({
      targetAgentId: 'timer_metrics_agent',
      durationSeconds: 120,
      prompt: 'Pending timer counted by telemetry'
    });
    assert.strictEqual(sched.success, true);

    assert.strictEqual(
      runtime.getRuntimeMetrics().activeTimersCount,
      1,
      'activeTimersCount must count live pending schedules through the internal privileged path'
    );

    // The public front door remains default-deny for anonymous callers.
    const anonymous = runtime.listSchedules();
    assert.strictEqual(anonymous.success, true);
    assert.deepStrictEqual(anonymous.schedules, []);

    const cancel = runtime.cancelSchedule(
      { timerId: sched.timerId, reason: 'Cleanup' },
      null,
      { callerAgentId: 'timer_metrics_agent' }
    );
    assert.strictEqual(cancel.success, true);
    assert.strictEqual(runtime.getRuntimeMetrics().activeTimersCount, 0);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 11. Event Pub/Sub Routing
// ============================================================================

test('25. Pub/Sub: Global Subscription and Typed on() Listeners', async () => {
  const runtime = createAgentRuntime();
  try {
    const allEvents = [];
    const stateChangeEvents = [];

    const unsubAll = runtime.subscribe((evt) => {
      allEvents.push(evt);
    });

    const unsubTyped = runtime.on('state_change', (evt) => {
      stateChangeEvents.push(evt);
    });

    await runtime.launchAgent({ id: 'event_agent', role: 'worker' });
    runtime.setAgentState('event_agent', AGENT_STATES.RUNNING, 'User running', { callerAgentId: 'event_agent' });

    assert.ok(allEvents.length >= 2, 'Should have received agent launch and state change events');
    assert.ok(stateChangeEvents.length >= 1, 'Should have received state_change events');

    unsubAll();
    unsubTyped();

    const countBefore = allEvents.length;
    runtime.setAgentState('event_agent', AGENT_STATES.IDLE, null, { callerAgentId: 'event_agent' });
    assert.strictEqual(allEvents.length, countBefore, 'Unsubscribed listeners should not receive events');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 12. State Snapshot Persistence & Disaster Recovery
// ============================================================================

test('26. Persistence: Export and Import Snapshot Disaster Recovery', async () => {
  const mockModel = createMockModel([
    { content: 'Historical answer', usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } }
  ]);

  const runtime1 = createAgentRuntime();
  let snapshotJson = '';
  try {
    const agent1 = await runtime1.launchAgent({
      id: 'narrator_1',
      name: 'Story Narrator',
      role: 'writer',
      systemPrompt: 'You write stories.'
    }, mockModel);

    await runtime1.launchAgent({
      id: 'recycled_worker',
      role: 'helper',
      spawnedBy: 'narrator_1'
    });
    runtime1.killAgent('recycled_worker', 'Obsolete', { callerAgentId: 'narrator_1' });

    await runtime1.executeAgentTurn('narrator_1', 'Introduce the protagonist.');

    runtime1.schedule({
      targetAgentId: 'narrator_1',
      durationSeconds: 120,
      prompt: 'Remind narrator to wrap chapter'
    });

    const snapshot = runtime1.exportSnapshot();
    assert.strictEqual(snapshot.agents.length, 1);
    assert.strictEqual(snapshot.agents[0].id, 'narrator_1');
    assert.strictEqual(snapshot.recycleBin.length, 1);
    assert.strictEqual(snapshot.recycleBin[0].id, 'recycled_worker');
    assert.strictEqual(snapshot.scheduledTimers.length, 1);

    snapshotJson = JSON.stringify(snapshot);
  } finally {
    runtime1.destroy();
  }

  // Restore into a fresh runtime instance
  const runtime2 = createAgentRuntime();
  try {
    const restoredEvents = [];
    runtime2.on('state_restored', (evt) => {
      restoredEvents.push(evt);
    });

    const parsedSnapshot = JSON.parse(snapshotJson);
    runtime2.importSnapshot(parsedSnapshot);

    assert.strictEqual(restoredEvents.length, 1);
    assert.strictEqual(runtime2.status, RUNTIME_STATUS.READY);
    assert.strictEqual(runtime2.hasAgent('narrator_1'), true);
    assert.strictEqual(runtime2.hasRecycledAgent('recycled_worker'), true);

    const narrator = runtime2.getAgent('narrator_1');
    assert.strictEqual(narrator.name, 'Story Narrator');
    assert.strictEqual(narrator.turnCount, 1);
    assert.strictEqual(narrator.history.length >= 2, true);

    const schedules = runtime2.listSchedules({}, { callerAgentId: 'narrator_1' });
    assert.strictEqual(schedules.schedules.length, 1);
    assert.strictEqual(schedules.schedules[0].targetAgentId, 'narrator_1');
  } finally {
    runtime2.destroy();
  }
});

test('26b. Persistence: seeded baked history round-trips export/import exactly (7e6edae)', async () => {
  const source = createAgentRuntime();
  let snapshotJson = '';
  let seededIds = [];
  try {
    await source.launchAgent({
      config: { id: 'seeded_narrator', role: 'writer', systemPrompt: 'Narrate.' },
      history: [
        { role: 'assistant', content: 'Cold open.', source: 'template' },
        { role: 'user', content: 'And then?' }
      ]
    });
    seededIds = source.getAgent('seeded_narrator').history.map((m) => m.id);
    snapshotJson = JSON.stringify(source.exportSnapshot());
  } finally {
    source.destroy();
  }

  const restored = createAgentRuntime();
  try {
    restored.importSnapshot(JSON.parse(snapshotJson));
    const agent = restored.getAgent('seeded_narrator');
    assert.ok(agent, 'the seeded agent hydrates');
    assert.deepStrictEqual(
      agent.history.map((m) => [m.role, m.content, m.metadata?.source ?? null]),
      [
        ['system', 'Narrate.', null],
        ['assistant', 'Cold open.', 'template'],
        ['user', 'And then?', null]
      ],
      'roles, content, and provenance round-trip through the runtime snapshot'
    );
    assert.deepStrictEqual(agent.history.map((m) => m.id), seededIds, 'seeded ids round-trip byte-identically (INV-7)');
    assert.deepStrictEqual(agent.history[1].metadata, { source: 'template' });
    assert.strictEqual(agent.history[2].metadata, undefined, 'a provenance-free entry stays provenance-free');
  } finally {
    restored.destroy();
  }
});

test('27. Persistence: importSnapshot Validates Schema and Rejects Malformed Data', () => {
  const runtime = createAgentRuntime();
  try {
    assert.throws(
      () => runtime.importSnapshot(null),
      { code: 'ERR_SNAPSHOT_INVALID' }
    );
    assert.throws(
      () => runtime.importSnapshot({}),
      { code: 'ERR_SNAPSHOT_INVALID' }
    );
    assert.throws(
      () => runtime.importSnapshot({ agents: 'invalid', recycleBin: [] }),
      { code: 'ERR_SNAPSHOT_INVALID' }
    );
  } finally {
    runtime.destroy();
  }
});

test('28. Persistence: importSnapshot re-derives authority and fails closed on schema-invalid claims (MOD-21 W5)', () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({
      agents: [
        {
          id: 'tampered_agent',
          name: 'Tampered Agent',
          config: { id: 'tampered_agent', privileged: true, allowedTools: ['*'] },
          history: []
        }
      ],
      recycleBin: []
    });

    const tampered = runtime.getAgent('tampered_agent');
    assert.ok(tampered, 'crafted agent must hydrate');
    assert.notStrictEqual(tampered.config.privileged, true, 'tampered privilege claim must downgrade');
    assert.strictEqual(tampered.authority.allow.size, 0, 'restored authority is re-derived default-deny');
    assert.strictEqual(runtime.whoami('tampered_agent').privileged, false);
    assert.strictEqual(tampered.authorityProvenance, 'snapshot', 'hydrated entities are marked snapshot provenance');

    // The registry descriptor is the authority surface; a persisted wildcard
    // whitelist must not seed it either (MOD-21 W7).
    const restoredAuthority = runtime.createAgentIdentityPort().getAgentIdentity('tampered_agent').authority;
    assert.strictEqual(restoredAuthority.allow.size, 0, 'registry descriptor is re-derived default-deny');
    assert.deepStrictEqual(
      runtime.listSchedules({}, { callerAgentId: 'tampered_agent' }).schedules,
      [],
      'a crafted snapshot cannot assert sudoer schedule visibility'
    );

    assert.throws(
      () => runtime.importSnapshot({
        agents: [
          {
            id: 'schema_invalid_agent',
            name: 'Schema Invalid Agent',
            config: { id: 'schema_invalid_agent', privileged: 'yes' },
            history: []
          }
        ],
        recycleBin: []
      }),
      { code: 'ERR_SNAPSHOT_INVALID' },
      'schema-invalid authority claims fail closed'
    );
    assert.strictEqual(runtime.getAgent('schema_invalid_agent'), null);
    assert.ok(runtime.getAgent('tampered_agent'), 'rejected import leaves the prior registry intact');
  } finally {
    runtime.destroy();
  }
});

test('29. Persistence: hydration re-derives authority default-deny for every record; grants restore explicitly (MOD-21 W7; Wave I c02d0b9)', async () => {
  const source = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await source.ensureDirector();
    await source.launchAgent({ id: 'worker', role: 'worker' });
    const snapshot = source.exportSnapshot();

    const restored = createAgentRuntime({ autoBootstrapDirector: false });
    try {
      restored.importSnapshot(snapshot);
      const workerAuthority = restored.createAgentIdentityPort().getAgentIdentity('worker').authority;
      assert.strictEqual(workerAuthority.allow.size, 0, 'ordinary hydrated agents stay default-deny');

      const directorIdentity = restored.createAgentIdentityPort().getAgentIdentity('director');
      assert.strictEqual(
        directorIdentity.authority.allow.has('*'),
        false,
        'hydration never re-asserts authority for any id — the director included'
      );
      assert.strictEqual(
        directorIdentity.realmBypass,
        false,
        'a hydrated director carries no bypass grant until the composition root restores it'
      );

      // The id is ordinary: ensureDirector adopts the live hydrated record
      // unchanged instead of rebuilding or upgrading it.
      const adopted = await restored.ensureDirector();
      assert.strictEqual(adopted, restored.getAgent('director'), 'ensureDirector adopts the live id-holder unchanged');

      // The operator principal acts without any agent authority.
      restored.killAgent('worker', 'Operator kill', { principal: restored.getOperatorPrincipal() });
      assert.strictEqual(restored.getAgent('worker'), null, 'the operator principal operates without agent authority');

      // The composition root restores the persisted bypass grant explicitly.
      const restoredGrants = restored.restoreRealmBypassGrants(['director'], { principal: restored.getOperatorPrincipal() });
      assert.deepStrictEqual(restoredGrants, ['director'], 'the active granted id is restored');
      assert.strictEqual(
        restored.createAgentIdentityPort().getAgentIdentity('director').realmBypass,
        true,
        'the restored grant surfaces in the identity projection'
      );
    } finally {
      restored.destroy();
    }
  } finally {
    source.destroy();
  }
});
