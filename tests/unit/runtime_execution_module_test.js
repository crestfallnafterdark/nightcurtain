/**
 * @file tests/unit/runtime_execution_module_test.js
 * @description Comprehensive isolated unit and contract test suite for Module 10: TurnExecutionEngine (`runtime_execution`).
 *
 * Verifies strict ICD compliance and architectural guarantees:
 *   1. Strict Export Whitelist & Constant Immutability (EXECUTION_STATUS, EXECUTION_ERROR_CODES)
 *   2. Single-Turn Concurrency Serialization & Non-Reentrancy (Invariant 1)
 *   3. Orchestrator Action Modes: directive, system, injection (Invariant 2)
 *   4. Autonomous Mail Intake & Auto-Trigger Skip Guard (Invariant 3)
 *   5. Next-Turn Precall Pipeline & Deduplication (Invariant 4)
 *   6. Multi-Turn Tool Loop & Terminal Summary Abstraction (Invariant 5)
 *   7. Deterministic Stream Cleanup & Cooperative Cancellation (Invariant 6)
 *   8. String Primitive Reasoning Content Invariant (Invariant 7 / INV-REASONING-STRING)
 *   9. Post-Turn Reactive Kick (Invariant 8)
 *  10. Telemetry Accounting, Error Taxonomy & Lifecycle State Machine Transitions
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import * as TurnExecutionModule from '../../src/lib/sandbox/runtime/turnExecutionEngine/index.ts';
import {
  TurnExecutionEngine,
  EXECUTION_STATUS,
  EXECUTION_ERROR_CODES
} from '../../src/lib/sandbox/runtime/turnExecutionEngine/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { SANDBOX_TOOLS } from '../../src/lib/sandbox/toolDefinitions/index.ts';

/**
 * Canonical registration key of a system-scope mock agent (no Realm
 * membership; Wave I, d57cbc1): the engine addresses bus partitions by this
 * key, so the mock bus stores and probes under it too.
 * @param {string} id - Mock agent id.
 * @returns {string} Canonical `system:<id>` identity key.
 */
const systemKey = (id) => createAgentIdentityKey(null, id);

// ============================================================================
// Test Mock Factories & Helpers
// ============================================================================

/**
 * Creates a mock LLM model instance with configurable stream / complete behaviors.
 */
function createMockModel(responses = []) {
  let responseIndex = 0;
  return {
    async *stream(options) {
      const resp = responses[responseIndex++] || { content: 'Default response' };
      if (resp.error) {
        throw resp.error;
      }
      if (resp.delayMs) {
        await new Promise(r => setTimeout(r, resp.delayMs));
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
        usage: resp.usage || { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
      };
    },
    async complete(options) {
      const resp = responses[responseIndex++] || { content: 'Default response' };
      if (resp.error) throw resp.error;
      return {
        content: resp.content || '',
        reasoning: resp.reasoning || '',
        toolCalls: resp.toolCalls || null,
        usage: resp.usage || { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
      };
    }
  };
}

/**
 * Creates a mock agent instance conforming to domain entity specs.
 */
function createMockAgent(id = 'agent_test_01', configOverrides = {}, modelResponses = []) {
  return {
    id,
    name: `Agent ${id}`,
    state: AGENT_STATES.IDLE,
    stateDetail: null,
    history: [],
    turnCount: 0,
    currentTurnPromise: null,
    abortController: null,
    lastError: null,
    lastSummary: null,
    lastInterruptedTurn: null,
    pendingPrecalls: [],
    currentStream: '',
    currentReasoning: '',
    activeToolCalls: [],
    redoStack: [],
    telemetry: {
      turnPromptTokens: 0,
      turnCompletionTokens: 0,
      turnTotalTokens: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      precallCount: 0,
      terminalStops: 0,
      injectedDeliveries: 0
    },
    config: {
      name: `Agent ${id}`,
      role: 'collaborator',
      privileged: false,
      allowedTools: ['*'],
      maxTurns: 5,
      identityHeader: false,
      ...configOverrides
    },
    model: createMockModel(modelResponses),
    updatedAt: Date.now()
  };
}

/**
 * Creates a mock runtime with agent registry, event emitter, and recycle bin.
 */
function createMockRuntime(agentsMap = new Map()) {
  const events = [];
  const recycleBin = new Set();
  return {
    agents: agentsMap,
    recycleBin,
    events,
    getAgent(id) {
      return agentsMap.get(id) || null;
    },
    hasRecycledAgent(id) {
      return recycleBin.has(id);
    },
    getRecycledAgent(id) {
      return recycleBin.has(id) ? { id } : null;
    },
    setAgentState(agent, newState, stateDetail = null) {
      agent.state = newState;
      agent.stateDetail = stateDetail;
      agent.updatedAt = Date.now();
    },
    _emit(event) {
      events.push(event);
    },
    createSubsystemEmitPort() {
      return { emit: (event) => events.push(event) };
    }
  };
}

/**
 * Creates a mock messaging bus.
 */
function createMockMessagingBus() {
  const inboxes = new Map();
  const sentMessages = [];
  return {
    sentMessages,
    inboxes,
    sendMessage({ from, to, content, metadata }) {
      const msg = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        from,
        to,
        content,
        metadata: metadata || {},
        timestamp: Date.now(),
        read: false
      };
      sentMessages.push(msg);
      if (!inboxes.has(to)) inboxes.set(to, []);
      inboxes.get(to).push(msg);
      return { success: true, messageId: msg.id };
    },
    getUnreadCount(agentId) {
      const list = inboxes.get(agentId) || [];
      return list.filter(m => !m.read).length;
    },
    listInbox(agentId, options = {}) {
      const list = inboxes.get(agentId) || [];
      if (options.unreadOnly) return list.filter(m => !m.read);
      return [...list];
    },
    drainInbox(agentId) {
      const list = inboxes.get(agentId) || [];
      const unread = list.filter(m => !m.read);
      for (const m of unread) {
        m.read = true;
      }
      return unread;
    }
  };
}

/**
 * Creates a mock trigger queue.
 */
function createMockTriggerQueue() {
  let tickCount = 0;
  return {
    get tickCount() { return tickCount; },
    async processTick() {
      tickCount++;
    }
  };
}

/**
 * Creates a mock VirtualFS.
 */
function createMockVirtualFS(files = {}) {
  const storage = new Map(Object.entries(files));
  return {
    async readFile(params) {
      const p = params?.file_path || params?.path;
      if (!storage.has(p)) {
        return { success: false, error: `File '${p}' not found`, code: 'FILE_NOT_FOUND' };
      }
      return { success: true, content: storage.get(p) };
    },
    async writeFile(params) {
      const p = params?.file_path || params?.path;
      const content = params?.content || '';
      storage.set(p, content);
      return { success: true, path: p, size: content.length };
    },
    async listFiles(params = {}) {
      const p = params?.path || params?.dir_path || '/';
      const matched = Array.from(storage.keys()).filter(k => k.startsWith(p));
      return { success: true, files: matched };
    }
  };
}

// ============================================================================
// 1. Strict Export Whitelist & Constant Immutability
// ============================================================================

test('1. Strict Export Whitelist & Constant Immutability', () => {
  const exported = Object.keys(TurnExecutionModule).sort();
  assert.deepStrictEqual(exported, [
    'EXECUTION_ERROR_CODES',
    'EXECUTION_STATUS',
    'TurnExecutionEngine'
  ].sort());

  // Verify EXECUTION_STATUS enums
  // Dead code removed: receipt statuses are terminal-only. Lifecycle states (`idle`/`running`/`errored`)
  // live on AGENT_STATES, and unhandled failures throw instead of resolving a receipt.
  assert.strictEqual(EXECUTION_STATUS.IDLE, undefined);
  assert.strictEqual(EXECUTION_STATUS.RUNNING, undefined);
  assert.strictEqual(EXECUTION_STATUS.COMPLETED, 'completed');
  assert.strictEqual(EXECUTION_STATUS.SKIPPED, 'skipped');
  assert.strictEqual(EXECUTION_STATUS.CANCELLED, 'cancelled');
  assert.strictEqual(EXECUTION_STATUS.ERRORED, undefined);
  assert.ok(Object.isFrozen(EXECUTION_STATUS), 'EXECUTION_STATUS must be frozen');

  // Verify EXECUTION_ERROR_CODES enums
  assert.strictEqual(EXECUTION_ERROR_CODES.INVALID_ARGUMENTS, 'INVALID_ARGUMENTS');
  assert.strictEqual(EXECUTION_ERROR_CODES.AGENT_NOT_FOUND, 'AGENT_NOT_FOUND');
  assert.strictEqual(EXECUTION_ERROR_CODES.AGENT_TERMINATED, 'AGENT_TERMINATED');
  // Dead code removed: concurrency always chains onto `agent.currentTurnPromise`,
  // so `AGENT_BUSY` was declared but never emitted.
  assert.strictEqual(EXECUTION_ERROR_CODES.AGENT_BUSY, undefined);
  assert.strictEqual(EXECUTION_ERROR_CODES.TURN_ABORTED, 'TURN_ABORTED');
  assert.strictEqual(EXECUTION_ERROR_CODES.MODEL_INVOCATION_ERROR, 'MODEL_INVOCATION_ERROR');
  assert.strictEqual(EXECUTION_ERROR_CODES.TOOL_EXECUTION_ERROR, 'TOOL_EXECUTION_ERROR');
  assert.strictEqual(EXECUTION_ERROR_CODES.FORBIDDEN_PRECALL, 'FORBIDDEN_PRECALL');
  assert.strictEqual(EXECUTION_ERROR_CODES.PRECALL_EXECUTION_ERROR, 'PRECALL_EXECUTION_ERROR');
  assert.strictEqual(EXECUTION_ERROR_CODES.MAX_TURNS_EXCEEDED, 'MAX_TURNS_EXCEEDED');
  assert.ok(Object.isFrozen(EXECUTION_ERROR_CODES), 'EXECUTION_ERROR_CODES must be frozen');

  // Verify mutations throw in strict mode
  assert.throws(() => {
    EXECUTION_STATUS.COMPLETED = 'mutated';
  }, TypeError);

  assert.throws(() => {
    EXECUTION_ERROR_CODES.AGENT_NOT_FOUND = 'mutated';
  }, TypeError);
});

// ============================================================================
// 2. Engine Constructor & Dependency Injection
// ============================================================================

test('2. Engine Constructor & Dependency Injection', () => {
  const runtime = createMockRuntime();
  const vfs = createMockVirtualFS();
  const bus = createMockMessagingBus();
  const triggerQueue = createMockTriggerQueue();

  const engine = new TurnExecutionEngine({
    runtime,
    virtualFs: vfs,
    messagingBus: bus,
    triggerQueue,
    mailboxAutonomy: true
  });

  // All injected dependencies are stored in true private fields (MOD10-C5-01)
  assert.strictEqual(engine.runtime, undefined);
  assert.strictEqual(engine.virtualFs, undefined);
  assert.strictEqual(engine.messagingBus, undefined);
  assert.strictEqual(engine.triggerQueue, undefined);
  assert.strictEqual(engine.worldClock, undefined);
  assert.strictEqual(engine.customTools, undefined);
  assert.strictEqual(engine.mailboxAutonomy, undefined);
  assert.strictEqual(engine.telemetryTracker, undefined);
  assert.strictEqual(engine.historyManager, undefined);

  // Default empty constructor
  const defaultEngine = new TurnExecutionEngine();
  assert.strictEqual(defaultEngine.runtime, undefined);
  assert.strictEqual(defaultEngine.virtualFs, undefined);
  assert.strictEqual(defaultEngine.messagingBus, undefined);
});

// ============================================================================
// 2b. MOD-20 turn-start preset materialization hook (mock-safe, once per turn)
// ============================================================================

test('2b. materializeEffectiveModel hook runs exactly once per turn; mock agents without it keep working', async () => {
  // Tool-loop turn: the inference loop iterates twice, materialization once.
  const agent = createMockAgent('materialize_agent', { allowedTools: ['read_file'] }, [
    {
      toolCalls: [{
        id: 'call_mt_01',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/story.txt"}' }
      }]
    },
    { content: 'Materialized summary.' }
  ]);
  let materializeCalls = 0;
  agent.materializeEffectiveModel = () => { materializeCalls += 1; return true; };

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS({ '/story.txt': 'Once upon a time...' });
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  const receipt = await engine.executeAgentTurn(agent.id, 'Summarize story');
  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Materialized summary.');
  assert.strictEqual(materializeCalls, 1, 'Exactly one materialization per turn, before the inference loop');

  // Mock agents without the optional hook keep completing turns.
  const bareAgent = createMockAgent('bare_agent', {}, [{ content: 'Bare output' }]);
  const bareRuntime = createMockRuntime(new Map([[bareAgent.id, bareAgent]]));
  const bareEngine = new TurnExecutionEngine({ runtime: bareRuntime });
  const bareReceipt = await bareEngine.executeAgentTurn(bareAgent.id, 'hello');
  assert.strictEqual(bareReceipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(bareReceipt.output, 'Bare output');
  assert.strictEqual(typeof bareAgent.materializeEffectiveModel, 'undefined');

  // A skipped auto-trigger (zero unread mail) never reaches the hook.
  const skipAgent = createMockAgent('materialize_skip_agent', {}, [{ content: 'Should not run' }]);
  let skipCalls = 0;
  skipAgent.materializeEffectiveModel = () => { skipCalls += 1; return true; };
  const skipRuntime = createMockRuntime(new Map([[skipAgent.id, skipAgent]]));
  const skipEngine = new TurnExecutionEngine({ runtime: skipRuntime, messagingBus: createMockMessagingBus() });
  const skipReceipt = await skipEngine.executeAgentTurn(skipAgent.id, null, { autoTrigger: true });
  assert.strictEqual(skipReceipt.status, EXECUTION_STATUS.SKIPPED);
  assert.strictEqual(skipCalls, 0, 'A skipped mail wake never materializes');
});

// ============================================================================
// 3. Single-Turn Concurrency Serialization & Non-Reentrancy (Invariant 1)
// ============================================================================

test('3. Single-Turn Concurrency Serialization & Non-Reentrancy', async () => {
  const agent = createMockAgent('concurrency_agent', {}, [
    { content: 'Turn 1 Response', delayMs: 40 },
    { content: 'Turn 2 Response', delayMs: 10 }
  ]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const triggerQueue = createMockTriggerQueue();
  const engine = new TurnExecutionEngine({ runtime, triggerQueue });

  assert.strictEqual(engine.isTurnRunning(agent.id), false);

  // Launch Turn 1 (takes 40ms)
  const turn1Promise = engine.executeAgentTurn(agent.id, 'Prompt 1');
  assert.strictEqual(engine.isTurnRunning(agent.id), true);

  // Launch Turn 2 while Turn 1 is in-flight (should queue/chain onto Turn 1)
  const turn2Promise = engine.executeAgentTurn(agent.id, 'Prompt 2');
  assert.strictEqual(engine.isTurnRunning(agent.id), true);

  const [res1, res2] = await Promise.all([turn1Promise, turn2Promise]);

  assert.strictEqual(res1.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(res1.output, 'Turn 1 Response');

  assert.strictEqual(res2.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(res2.output, 'Turn 2 Response');

  assert.strictEqual(engine.isTurnRunning(agent.id), false);
  assert.strictEqual(agent.turnCount, 2);

  // History order must strictly be Prompt 1 -> Response 1 -> Prompt 2 -> Response 2
  const userMessages = agent.history.filter(m => m.role === 'user').map(m => m.content);
  const astMessages = agent.history.filter(m => m.role === 'assistant').map(m => m.content);
  assert.deepStrictEqual(userMessages, ['Prompt 1', 'Prompt 2']);
  assert.deepStrictEqual(astMessages, ['Turn 1 Response', 'Turn 2 Response']);
});

// ============================================================================
// 4. Orchestrator Action Modes: directive, system, injection (Invariant 2)
// ============================================================================

test('4.1 Directive Mode: Standard prompt + piggybacked mail intake', async () => {
  const agent = createMockAgent('directive_agent', {}, [{ content: 'Directive output' }]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const bus = createMockMessagingBus();
  const engine = new TurnExecutionEngine({ runtime, messagingBus: bus });

  // Place an unread message in inbox before directive turn
  bus.sendMessage({ from: 'peer_1', to: systemKey(agent.id), content: 'Hey there' });
  assert.strictEqual(bus.getUnreadCount(systemKey(agent.id)), 1);

  const receipt = await engine.executeAgentTurn(agent.id, 'User directive prompt', {
    mode: 'directive',
    metadata: { traceId: 'tr_123' }
  });

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Directive output');
  assert.strictEqual(bus.getUnreadCount(systemKey(agent.id)), 0, 'Mailbox must be drained during directive turn');

  // Verify history contains user prompt and synthetic mail pair
  const userMsg = agent.history.find(m => m.role === 'user' && m.content === 'User directive prompt');
  assert.ok(userMsg);
  assert.strictEqual(userMsg.metadata?.traceId, 'tr_123');

  const astMsg = agent.history.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.ok(astMsg, 'Synthetic assistant tool call message must exist');
  assert.strictEqual(astMsg.tool_calls[0].function.name, 'messaging_readMessage');
});

test('4.2 System Mode: Injected as system role without mail drain', async () => {
  const agent = createMockAgent('system_agent', {}, [{ content: 'Acknowledged constraint' }]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const bus = createMockMessagingBus();
  const engine = new TurnExecutionEngine({ runtime, messagingBus: bus });

  bus.sendMessage({ from: 'peer_1', to: systemKey(agent.id), content: 'Pending mail' });

  const receipt = await engine.executeAgentTurn(agent.id, 'System operational rule', {
    mode: 'system',
    metadata: { ruleId: 'rule_99' }
  });

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(bus.getUnreadCount(systemKey(agent.id)), 1, 'System mode must NOT drain inbox');

  const sysMsg = agent.history.find(m => m.role === 'system');
  assert.ok(sysMsg);
  assert.strictEqual(sysMsg.content, 'System operational rule');
  assert.strictEqual(sysMsg.metadata?.ruleId, 'rule_99');
});

test('4.3 Injection Mode: Delivers to bus inbox and wakes agent', async () => {
  const agent = createMockAgent('injection_agent', {}, [{ content: 'Processed injection' }]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const bus = createMockMessagingBus();
  const engine = new TurnExecutionEngine({ runtime, messagingBus: bus });

  const receipt = await engine.executeAgentTurn(agent.id, {
    content: 'External event payload',
    sender: 'director_agent',
    metadata: { priority: 'high' }
  }, { mode: 'injection' });

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(bus.sentMessages.length, 1);
  assert.strictEqual(bus.sentMessages[0].from, 'director_agent');
  assert.strictEqual(bus.sentMessages[0].to, systemKey(agent.id), 'the engine addresses the canonical registration partition');
  assert.strictEqual(bus.sentMessages[0].content, 'External event payload');

  // Verify notification user message and synthetic tool call in history
  const notifUserMsg = agent.history.find(m => m.role === 'user' && m.content.startsWith('[MAIL NOTIFICATION]'));
  assert.ok(notifUserMsg);
  assert.strictEqual(notifUserMsg.metadata?.synthetic, true);
});

test('4.4 Seeded baked prologue is delivered to the model in declared order (7e6edae)', async () => {
  const requests = [];
  const capturingModel = {
    provider: { name: 'capture_provider', providerName: 'capture' },
    async *stream(options) {
      requests.push(options);
      yield { type: 'text', content: 'Prose continues.' };
      yield { type: 'reasoning', content: 'keeping continuity' };
      yield {
        type: 'finish',
        content: 'Prose continues.',
        reasoning: 'keeping continuity',
        toolCalls: null,
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 }
      };
    },
    async complete(options) {
      requests.push(options);
      return {
        content: 'Prose continues.',
        reasoning: '',
        toolCalls: null,
        usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 }
      };
    }
  };

  const agent = createMockAgent('seed_delivery_agent', { identityHeader: false }, []);
  agent.model = capturingModel;
  agent.history = [
    { id: 'sys_seed', role: 'system', content: 'You are the narrator.' },
    { id: 'assistant_seed', role: 'assistant', content: 'The gate groans open.', metadata: { source: 'template' } },
    { id: 'user_seed', role: 'user', content: 'I step through.' }
  ];

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const engine = new TurnExecutionEngine({ runtime });

  const receipt = await engine.executeAgentTurn(agent.id, 'What do I see?');
  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(requests.length, 1, 'exactly one model invocation for the first turn');

  const sent = requests[0].messages;
  assert.deepStrictEqual(
    sent.slice(0, 3).map((m) => m.content),
    ['You are the narrator.', 'The gate groans open.', 'I step through.'],
    'the seeded prologue is sent before the turn prompt, in declared order'
  );
  assert.strictEqual(sent[3].content, 'What do I see?', 'the directive prompt follows the seeded prologue');
  assert.deepStrictEqual(
    sent[1].metadata,
    { source: 'template' },
    'template provenance reaches the model-visible message'
  );
});

// ============================================================================
// 5. Autonomous Mail Intake & Auto-Trigger Skip Guard (Invariant 3)
// ============================================================================

test('5.1 Auto-Trigger Skip Guard: Skips turn when unread count is 0', async () => {
  const agent = createMockAgent('skip_guard_agent', {}, [{ content: 'Should not run' }]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const bus = createMockMessagingBus();
  const engine = new TurnExecutionEngine({ runtime, messagingBus: bus });

  const receipt = await engine.executeAgentTurn(agent.id, null, {
    triggerType: 'mail',
    autoTrigger: true
  });

  assert.strictEqual(receipt.status, EXECUTION_STATUS.SKIPPED);
  assert.strictEqual(receipt.skipped, true);
  assert.strictEqual(receipt.output, '');
  assert.deepStrictEqual(receipt.toolCalls, []);
  assert.strictEqual(agent.turnCount, 0, 'Skipped turn must not increment turnCount');
  assert.strictEqual(agent.history.length, 0, 'Skipped turn must not add messages');
});

test('5.2 Auto-Trigger Mail Intake: Drains mail and generates tool pairs', async () => {
  const agent = createMockAgent('auto_mail_agent', {}, [{ content: 'I got the message' }]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const bus = createMockMessagingBus();
  const engine = new TurnExecutionEngine({ runtime, messagingBus: bus });

  bus.sendMessage({ from: 'writer_01', to: systemKey(agent.id), content: 'Chapter 1 draft ready' });

  const receipt = await engine.executeAgentTurn(agent.id, null, {
    triggerType: 'mail',
    autoTrigger: true
  });

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'I got the message');
  assert.strictEqual(bus.getUnreadCount(systemKey(agent.id)), 0);
  assert.strictEqual(agent.telemetry.injectedDeliveries, 1);

  // History inspection
  const notifMsg = agent.history[0];
  assert.strictEqual(notifMsg.role, 'user');
  assert.ok(notifMsg.content.includes('Chapter 1') || notifMsg.content.includes('[MAIL NOTIFICATION]'));

  const synthAssistant = agent.history[1];
  assert.strictEqual(synthAssistant.role, 'assistant');
  assert.strictEqual(synthAssistant.reasoning_content, '');
  assert.strictEqual(synthAssistant.tool_calls.length, 1);

  const toolResp = agent.history[2];
  assert.strictEqual(toolResp.role, 'tool');
  assert.strictEqual(toolResp.name, 'messaging_readMessage');
});

// ============================================================================
// 6. Next-Turn Precall Pipeline & Deduplication (Invariant 4)
// ============================================================================

test('6.1 Precall Deduplication, Allowlist Validation & Coalescing', async () => {
  const agent = createMockAgent('precall_agent', {
    allowedTools: ['read_file', 'query_json', 'write_file', 'whoami']
  }, [{ content: 'Synthesized precall analysis' }]);

  // Stage 3 precalls: 2 valid identical read_file calls (deduped to 1), 1 forbidden write_file call
  agent.pendingPrecalls = [
    { name: 'read_file', arguments: { path: '/notes.md' } },
    { name: 'read_file', arguments: { path: '/notes.md' } }, // Duplicate -> should be dropped
    { name: 'write_file', arguments: { path: '/hack.txt', content: 'forbidden' } } // Mutating -> forbidden precall
  ];

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS({ '/notes.md': '# Important Notes' });
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  const receipt = await engine.executeAgentTurn(agent.id, 'Analyze notes');

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Synthesized precall analysis');
  assert.strictEqual(agent.pendingPrecalls.length, 0, 'Pending precalls must be cleared');

  // Verify synthetic assistant message in history
  const synthAst = agent.history.find(m => m.metadata?.precall === true);
  assert.ok(synthAst, 'Synthetic precall assistant message must exist');
  assert.strictEqual(typeof synthAst.reasoning_content, 'string');
  assert.strictEqual(synthAst.reasoning_content, '');
  // Deduplicated read_file + forbidden write_file = 2 tool calls
  assert.strictEqual(synthAst.tool_calls.length, 2);

  // Verify tool responses
  const toolResponses = agent.history.filter(m => m.role === 'tool');
  assert.strictEqual(toolResponses.length, 2);

  const readResp = toolResponses.find(r => r.name === 'read_file');
  assert.ok(readResp);
  assert.ok(readResp.content.includes('Important Notes'));

  const writeResp = toolResponses.find(r => r.name === 'write_file');
  assert.ok(writeResp);
  assert.strictEqual(writeResp.isError, true);
  assert.ok(writeResp.content.includes(EXECUTION_ERROR_CODES.FORBIDDEN_PRECALL));
});

test('6.2 Precall Fault Isolation: Subsystem errors do not halt turn', async () => {
  const agent = createMockAgent('precall_error_agent', {}, [{ content: 'Handled missing file' }]);
  agent.pendingPrecalls = [
    { name: 'read_file', arguments: { path: '/nonexistent.txt' } }
  ];

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS(); // Empty filesystem
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  const receipt = await engine.executeAgentTurn(agent.id, 'Read non-existent');

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Handled missing file');

  const toolResp = agent.history.find(m => m.role === 'tool');
  assert.ok(toolResp);
  assert.ok(toolResp.content.includes('not found') || toolResp.content.includes('false'));
});

test('6.3 R4 Gate Agreement: phantom precall time_now is denied before dispatch and never executed', async () => {
  // R4: 'time_now' is absent from the canonical master alias map, so the descriptor
  // gate fail-closes on it (tests/unit/precall_gate_adversarial_test.js). The
  // engine-local precall gate must agree instead of resolving it as a clock alias.
  const agent = createMockAgent('phantom_precall_agent', {
    allowedTools: ['read_file']
  }, [{ content: 'Phantom handled' }]);

  agent.pendingPrecalls = [
    { name: 'time_now', arguments: {} }
  ];

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS();
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  const receipt = await engine.executeAgentTurn(agent.id, 'Check time');

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Phantom handled');

  const toolResponses = agent.history.filter(m => m.role === 'tool');
  assert.strictEqual(toolResponses.length, 1, 'phantom precall must yield exactly one denial response');
  assert.strictEqual(toolResponses[0].name, 'time_now');
  assert.strictEqual(toolResponses[0].isError, true);
  assert.ok(
    toolResponses[0].content.includes(EXECUTION_ERROR_CODES.FORBIDDEN_PRECALL),
    'engine gate must deny time_now with FORBIDDEN_PRECALL, matching the descriptor gate'
  );
  assert.ok(
    !toolResponses[0].content.includes('TOOL_NOT_FOUND'),
    'phantom name must be stopped by the precall gate, not by dispatcher resolution'
  );
});

// ============================================================================
// 7. Multi-Turn Tool Loop & Terminal Summary Abstraction (Invariant 5)
// ============================================================================

test('7.1 Multi-Turn Tool Loop: Normal tool loop with prose termination', async () => {
  const agent = createMockAgent('loop_agent', {
    allowedTools: ['read_file']
  }, [
    // Turn 1: Emits tool call
    {
      toolCalls: [{
        id: 'call_rf_01',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/story.txt"}' }
      }]
    },
    // Turn 2: Returns final prose
    { content: 'Story summary complete.' }
  ]);

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS({ '/story.txt': 'Once upon a time...' });
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  const receipt = await engine.executeAgentTurn(agent.id, 'Summarize story');

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Story summary complete.');
  assert.strictEqual(receipt.toolCalls.length, 1);
  assert.strictEqual(receipt.toolCalls[0].name, 'read_file');
});

test('7.2 Terminal Batch Precall (Success Path): Terminates loop & queues next precalls', async () => {
  const agent = createMockAgent('terminal_agent', {
    allowedTools: ['read_file', 'batch_precall', 'runtime_batchPrecall']
  }, [
    {
      toolCalls: [
        {
          id: 'call_rf_02',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/data.json"}' }
        },
        {
          id: 'call_term_01',
          type: 'function',
          function: {
            name: 'runtime_batchPrecall',
            arguments: JSON.stringify({
              summary: 'Batch processed successfully.',
              calls: [
                { name: 'read_file', arguments: { path: '/next_step.md' } }
              ]
            })
          }
        }
      ]
    }
  ]);

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS({ '/data.json': '{"count": 42}' });
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  const receipt = await engine.executeAgentTurn(agent.id, 'Process data');

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Batch processed successfully.');
  assert.strictEqual(receipt.summary, 'Batch processed successfully.');
  assert.strictEqual(agent.lastSummary, 'Batch processed successfully.');

  // Next-turn precalls queued
  assert.strictEqual(agent.pendingPrecalls.length, 1);
  assert.strictEqual(agent.pendingPrecalls[0].name, 'read_file');
  assert.deepStrictEqual(agent.pendingPrecalls[0].arguments, { path: '/next_step.md' });

  assert.strictEqual(agent.telemetry.terminalStops, 1);

  // Terminal summary assistant message in history
  const lastAstMsg = agent.history[agent.history.length - 1];
  assert.strictEqual(lastAstMsg.role, 'assistant');
  assert.strictEqual(lastAstMsg.content, 'Batch processed successfully.');
  assert.strictEqual(lastAstMsg.reasoning_content, '');
  assert.strictEqual(lastAstMsg.metadata?.terminalSummary, true);
});

test('7.3 Terminal Batch Precall (Failure Path): Error continuation for self-healing', async () => {
  const agent = createMockAgent('healing_agent', {
    allowedTools: ['read_file', 'runtime_batchPrecall']
  }, [
    // Subturn 1: Sibling tool fails, batchPrecall emitted
    {
      toolCalls: [
        {
          id: 'call_rf_fail',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"/missing.txt"}' }
        },
        {
          id: 'call_term_fail',
          type: 'function',
          function: {
            name: 'runtime_batchPrecall',
            arguments: JSON.stringify({
              summary: 'Premature summary',
              calls: [{ name: 'read_file', arguments: { path: '/foo' } }]
            })
          }
        }
      ]
    },
    // Subturn 2: Self-healing prose response
    { content: 'Recovered from missing file error.' }
  ]);

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS(); // Empty -> read_file will fail
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  const receipt = await engine.executeAgentTurn(agent.id, 'Try read');

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Recovered from missing file error.');
  // Precalls should NOT have been queued from failed batch
  assert.strictEqual(agent.pendingPrecalls.length, 0);
});

test('7.4 maxTurns cap: exhausted tool loop throws MAX_TURNS_EXCEEDED', async () => {
  const agent = createMockAgent('maxturn_capped_agent', {
    maxTurns: 2,
    allowedTools: ['read_file']
  }, [
    {
      toolCalls: [{
        id: 'call_a',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/a.txt"}' }
      }]
    },
    {
      toolCalls: [{
        id: 'call_b',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/b.txt"}' }
      }]
    }
  ]);

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS({ '/a.txt': 'A', '/b.txt': 'B' });
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  await assert.rejects(
    () => engine.executeAgentTurn(agent.id, 'Keep calling tools'),
    (err) => {
      assert.strictEqual(err.code, EXECUTION_ERROR_CODES.MAX_TURNS_EXCEEDED);
      assert.ok(err.message.includes('maxTurns') || err.message.includes('turn limit'));
      return true;
    }
  );

  assert.strictEqual(agent.state, AGENT_STATES.ERRORED, 'capped turn must settle errored, not completed');
  assert.strictEqual(agent.turnCount, 0, 'capped turn must not count as a completed turn');
  assert.strictEqual(agent.currentTurnPromise, null);

  const errorEvent = runtime.events.find(e => e.type === 'error');
  assert.ok(errorEvent, 'capped turn must emit an error event');
  assert.strictEqual(errorEvent.payload.code, EXECUTION_ERROR_CODES.MAX_TURNS_EXCEEDED);
});

test('7.5 maxTurns cap: natural conclusion on the final permitted iteration still completes', async () => {
  const agent = createMockAgent('maxturn_ok_agent', {
    maxTurns: 2,
    allowedTools: ['read_file']
  }, [
    {
      toolCalls: [{
        id: 'call_c',
        type: 'function',
        function: { name: 'read_file', arguments: '{"path":"/c.txt"}' }
      }]
    },
    { content: 'Concluded within the budget.' }
  ]);

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const vfs = createMockVirtualFS({ '/c.txt': 'C' });
  const engine = new TurnExecutionEngine({ runtime, virtualFs: vfs });

  const receipt = await engine.executeAgentTurn(agent.id, 'Conclude');

  assert.strictEqual(receipt.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(receipt.output, 'Concluded within the budget.');
  assert.strictEqual(agent.state, AGENT_STATES.IDLE);
  assert.strictEqual(agent.turnCount, 1);
  assert.strictEqual(runtime.events.find(e => e.type === 'error'), undefined);
});

// ============================================================================
// 8. Deterministic Stream Cleanup & Cooperative Cancellation (Invariant 6)
// ============================================================================

test('8.1 cancelAgentTurn aborts in-flight turn cooperatively', async () => {
  const agent = createMockAgent('cancel_agent', {}, [
    { content: 'Partial stream output', delayMs: 100 }
  ]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const engine = new TurnExecutionEngine({ runtime });

  const turnPromise = engine.executeAgentTurn(agent.id, 'Long running prompt');

  // Let turn start running
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(engine.isTurnRunning(agent.id), true);

  const cancelled = engine.cancelAgentTurn(agent.id, 'User stopped generation');
  assert.strictEqual(cancelled, true);

  const receipt = await turnPromise;
  assert.strictEqual(receipt.status, EXECUTION_STATUS.CANCELLED);
  assert.strictEqual(receipt.cancelled, true);
  assert.strictEqual(receipt.code, EXECUTION_ERROR_CODES.TURN_ABORTED);
  assert.strictEqual(agent.state, AGENT_STATES.IDLE);
  assert.strictEqual(agent.currentStream, '');
  assert.strictEqual(agent.currentReasoning, '');
  assert.strictEqual(agent.abortController, null);
  assert.ok(agent.lastInterruptedTurn);
  assert.strictEqual(agent.lastInterruptedTurn.cancelled, true);
});

test('8.2 Pre-aborted AbortSignal returns CANCELLED immediately', async () => {
  const agent = createMockAgent('pre_abort_agent', {}, [{ content: 'Never run' }]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const engine = new TurnExecutionEngine({ runtime });

  const controller = new AbortController();
  controller.abort('Already cancelled');

  const receipt = await engine.executeAgentTurn(agent.id, 'Prompt', {
    signal: controller.signal
  });

  assert.strictEqual(receipt.status, EXECUTION_STATUS.CANCELLED);
  assert.strictEqual(receipt.cancelled, true);
  assert.strictEqual(receipt.code, EXECUTION_ERROR_CODES.TURN_ABORTED);
  assert.strictEqual(agent.history.length, 0);
});

// ============================================================================
// 9. String Primitive Reasoning Content Invariant (Invariant 7 / INV-REASONING-STRING)
// ============================================================================

test('9. String Primitive Reasoning Content Invariant across all assistant messages', async () => {
  const agent = createMockAgent('reasoning_agent', {
    allowedTools: ['read_file']
  }, [
    {
      reasoning: 'Analyzing query carefully',
      content: 'I have reasoned through this.'
    }
  ]);

  agent.pendingPrecalls = [
    { name: 'get_current_time', arguments: {} }
  ];

  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const engine = new TurnExecutionEngine({ runtime });

  await engine.executeAgentTurn(agent.id, 'Explain relativity');

  const assistantMessages = agent.history.filter(m => m.role === 'assistant');
  assert.ok(assistantMessages.length >= 2, 'Should have synthetic precall assistant and model assistant');

  for (const msg of assistantMessages) {
    assert.strictEqual(
      typeof msg.reasoning_content,
      'string',
      `reasoning_content must be string primitive, got: ${typeof msg.reasoning_content}`
    );
  }

  // Model assistant should have matching reasoning
  const modelMsg = assistantMessages.find(m => m.content === 'I have reasoned through this.');
  assert.ok(modelMsg);
  assert.strictEqual(modelMsg.reasoning_content, 'Analyzing query carefully');
});

// ============================================================================
// 10. Post-Turn Reactive Kick (Invariant 8)
// ============================================================================

test('10. Post-Turn Reactive Kick wakes TriggerQueue on all completion paths', async () => {
  const triggerQueue = createMockTriggerQueue();
  const agent = createMockAgent('kick_agent', {}, [
    { content: 'Turn complete' }
  ]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const bus = createMockMessagingBus();
  const engine = new TurnExecutionEngine({ runtime, messagingBus: bus, triggerQueue });

  assert.strictEqual(triggerQueue.tickCount, 0);

  // Path 1: Successful turn
  await engine.executeAgentTurn(agent.id, 'Prompt 1');
  assert.strictEqual(triggerQueue.tickCount, 1);

  // Path 2: Skipped turn
  await engine.executeAgentTurn(agent.id, null, { triggerType: 'mail', autoTrigger: true });
  assert.strictEqual(triggerQueue.tickCount, 2);

  // Path 3: Cancelled turn
  const ctrl = new AbortController();
  ctrl.abort();
  await engine.executeAgentTurn(agent.id, 'Prompt 3', { signal: ctrl.signal });
  assert.strictEqual(triggerQueue.tickCount, 3);
});

// ============================================================================
// 11. Error Taxonomy & Validation Guards
// ============================================================================

test('11.1 Missing or invalid agent ID throws INVALID_ARGUMENTS', async () => {
  const engine = new TurnExecutionEngine();
  await assert.rejects(
    async () => engine.executeAgentTurn(''),
    (err) => err.code === EXECUTION_ERROR_CODES.INVALID_ARGUMENTS
  );
  await assert.rejects(
    async () => engine.executeAgentTurn(null),
    (err) => err.code === EXECUTION_ERROR_CODES.INVALID_ARGUMENTS
  );
});

test('11.2 Agent not found throws AGENT_NOT_FOUND', async () => {
  const runtime = createMockRuntime(new Map());
  const engine = new TurnExecutionEngine({ runtime });
  await assert.rejects(
    async () => engine.executeAgentTurn('nonexistent_agent', 'Hello'),
    (err) => err.code === EXECUTION_ERROR_CODES.AGENT_NOT_FOUND
  );
});

test('11.3 Terminated agent in recycle bin throws AGENT_TERMINATED', async () => {
  const agent = createMockAgent('dead_agent');
  const runtime = createMockRuntime(new Map([[agent.id, agent]]));
  runtime.recycleBin.add(agent.id);
  const engine = new TurnExecutionEngine({ runtime });

  await assert.rejects(
    async () => engine.executeAgentTurn(agent.id, 'Hello dead agent'),
    (err) => err.code === EXECUTION_ERROR_CODES.AGENT_TERMINATED
  );
});

test('11.4 Terminated state throws AGENT_TERMINATED', async () => {
  const agent = createMockAgent('terminated_agent');
  agent.state = AGENT_STATES.TERMINATED;
  const runtime = createMockRuntime(new Map([[agent.id, agent]]));
  const engine = new TurnExecutionEngine({ runtime });

  await assert.rejects(
    async () => engine.executeAgentTurn(agent.id, 'Hello'),
    (err) => err.code === EXECUTION_ERROR_CODES.AGENT_TERMINATED
  );
});

test('11.5 Model error sets agent state to ERRORED and rethrows', async () => {
  const modelErr = new Error('Model provider rate limit exceeded');
  modelErr.code = 'RATE_LIMIT';

  const agent = createMockAgent('error_agent', {}, [
    { error: modelErr }
  ]);
  const agents = new Map([[agent.id, agent]]);
  const runtime = createMockRuntime(agents);
  const engine = new TurnExecutionEngine({ runtime });

  await assert.rejects(
    async () => engine.executeAgentTurn(agent.id, 'Trigger error'),
    (err) => err.message.includes('rate limit')
  );

  assert.strictEqual(agent.state, AGENT_STATES.ERRORED);
  assert.ok(agent.lastError.includes('rate limit'));

  const errorEvent = runtime.events.find(e => e.type === 'error');
  assert.ok(errorEvent);
  assert.strictEqual(errorEvent.agentId, agent.id);
});
