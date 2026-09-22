/**
 * @file tests/unit/sandbox_store_module_test.js
 * @description Comprehensive isolated unit test suite for Module 14: Sandbox Store.
 * 
 * Invariants Tested:
 * 1. Strict Contract Header Export Whitelist (0 Leaked Exports, E \ D = ∅)
 * 2. Store Instantiation & Substrate Dependency Injection
 * 3. Reactive State Projection ($state) & Pure Accessors ($derived)
 * 4. Agent Lifecycle Operations (Launch, Kill, Restore, Purge, Empty Recycle Bin, Update Config)
 * 5. Conversational Turn Execution, Dual-Stack Undo/Redo & Per-Agent Draft Buffers
 * 6. Emergency Turn Unsticking (INV-UNSTICK) & Interrupted Retries
 * 7. History & Message Mutation with Safety
 * 8. MessagingBus Mailbox Integration & Unread Badges
 * 9. Scheduled Timers Live Countdowns & Cancellation
 * 10. VirtualFS Workspace Observation, Two-Way Clock Sync, JSON Query & Grep
 * 11. World Clock & Narrative Event Partition Management
 * 12. Storage Persistence Serialization, Auto-Save Debouncing & Zero-Zombie Auto-Hydration
 * 13. End-to-End Handshake Demonstration (runHandshakeDemo)
 * 14. Standardized Error Code Enforcement (SANDBOX_STORE_ERROR_CODES)
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as SandboxStoreModule from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import {
  GENERIC_REALM_ID,
  REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES,
  REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES,
  SANDBOX_STORE_ERROR_CODES,
  SandboxStore,
  createSandboxStore,
  getSandboxStore,
  sandboxStore
} from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { GENERIC_REALM_ID as UI_GENERIC_REALM_ID } from '../../src/lib/components/sandbox/realmGroups.ts';

import { AgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import {
  BAKED_TEMPLATE_BUNDLES,
  DEMO_TEMPLATE,
  RealmCatalogError,
  hashText,
  serializeTemplateBundle,
  templateBundleVersion
} from '../../src/lib/sandbox/realmCatalog/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';
import { CredentialVault } from '../../src/lib/sandbox/credentialVault/index.ts';

const CONTRACT_PATH = new URL('../../src/lib/sandbox/sandboxStore/index.svelte.ts', import.meta.url);

/**
 * Creates an isolated mock model for testing turn execution and LLM streams.
 */
function createMockModel(responses = []) {
  let responseIndex = 0;
  return {
    id: 'mock-model',
    config: {},
    provider: {
      id: 'mock-provider',
      createModel: () => createMockModel(responses),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: 'mock-model', name: 'Mock Model' }]
    },
    async *stream(options = {}) {
      const resp = responses[responseIndex++] || { content: 'Default mock response text' };
      if (resp.error) {
        throw resp.error;
      }
      if (resp.reasoning) {
        if (typeof options.onReasoningChunk === 'function') {
          options.onReasoningChunk(resp.reasoning);
        }
        yield { type: 'reasoning', content: resp.reasoning };
      }
      if (resp.content) {
        if (typeof options.onChunk === 'function') {
          options.onChunk(resp.content);
        }
        yield { type: 'text', content: resp.content };
      }
      if (resp.toolCalls) {
        yield { type: 'tool_call', toolCalls: resp.toolCalls };
      }
      yield {
        type: 'finish',
        content: resp.content || '',
        reasoning: resp.reasoning || '',
        toolCalls: resp.toolCalls || null,
        usage: resp.usage || { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
      };
    },
    async complete(options = {}) {
      const resp = responses[responseIndex++] || { content: 'Default mock response text' };
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
 * Creates a streaming mock model that emits one chunk, then blocks on a gate
 * after each chunk until the matching `release*()` is called — lets tests
 * observe the store in a stable mid-turn state without racing completion.
 */
function createGatedStreamModel() {
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  return {
    releaseFirst,
    releaseSecond,
    model: {
      id: 'gated-stream-model',
      config: {},
      provider: {
        id: 'mock-provider',
        createModel: () => createGatedStreamModel().model,
        getEndpointUrl: () => 'http://localhost/test',
        checkBalance: async () => ({ balance: 100 }),
        listModels: async () => [{ id: 'gated-stream-model', name: 'Gated Stream Model' }]
      },
      async *stream(options = {}) {
        const first = { type: 'text', content: 'Streaming chunk one. ' };
        options.onChunk?.(first);
        yield first;
        await firstGate;
        const second = { type: 'text', content: 'Streaming chunk two. ' };
        options.onChunk?.(second);
        yield second;
        await secondGate;
        yield {
          type: 'finish',
          content: '',
          reasoning: '',
          toolCalls: null,
          usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }
        };
      }
    }
  };
}

/**
 * Creates an isolated store with the Director meta-agent bootstrapped as the
 * operator principal (MOD-21 W6). Operator-scoped actions (kill, authority
 * grants, scheduler visibility/cancellation, cross-workspace downloads) run
 * under its frozen registry `AuthorityDescriptor`; caller-declared privilege
 * flags never grant anything.
 * @param {Object} [options={}]
 * @returns {Promise<SandboxStore>}
 */
async function createOperatorStore(options = {}) {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false, ...options });
  await store.ensureDirector();
  return store;
}

/**
 * Polls a predicate until it is truthy or the timeout elapses.
 */
async function waitFor(predicate, timeoutMs = 1500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Boolean(predicate());
}

/**
 * Synchronously flushes the module-level singleton's pending debounced autosave
 * (e.g. left by test 24, which drives `getSandboxStore()` and is never
 * destroyed), so a seeded snapshot can be observed without cross-test write
 * noise. Callers clear storage immediately after.
 */
function drainPendingAutosaves() {
  sandboxStore.saveToStorage();
}

// ============================================================================
// 1. Strict Export Whitelist & Constant Verification
// ============================================================================
test('1. Strict Export Whitelist & Constant Types', () => {
  const exportedKeys = Object.keys(SandboxStoreModule).sort();
  const expectedKeys = [
    'GENERIC_REALM_ID',
    'REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES',
    'REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES',
    'SANDBOX_STORE_ERROR_CODES',
    'SandboxStore',
    'createSandboxStore',
    'getSandboxStore',
    'sandboxStore'
  ].sort();

  assert.deepStrictEqual(exportedKeys, expectedKeys, 'Exported symbols must strictly match contract');

  // Verify Error Codes Dictionary (dead codes removed per f1a36b4)
  assert.ok(Object.isFrozen(SANDBOX_STORE_ERROR_CODES), 'SANDBOX_STORE_ERROR_CODES must be frozen');
  assert.deepStrictEqual(
    Object.keys(SANDBOX_STORE_ERROR_CODES).sort(),
    [
      'ERR_STORE_AGENT_NOT_FOUND',
      'ERR_STORE_INVALID_PARAMS',
      'ERR_STORE_NO_AGENT_SELECTED',
      'ERR_STORE_REALM_DELETE_FAILED',
      'ERR_STORE_REALM_NOT_EMPTY',
      'ERR_STORE_REALM_PROTECTED',
      'ERR_STORE_TEMPLATE_PERSIST_FAILED',
      'ERR_STORE_TEMPLATE_TOO_LARGE',
      'ERR_STORE_TURN_FAILED',
      'ERR_STORE_VFS_FAILED',
      'ERR_TEMPLATE_AUTHORITY_UNSUPPORTED',
      'ERR_TEMPLATE_PROVIDERS_UNSUPPORTED'
    ].sort(),
    'Error code dictionary must contain exactly the live codes'
  );
  // Wave T (ticket 0df20ae) budgets are documented frozen constants.
  assert.strictEqual(
    SandboxStoreModule.REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES,
    2 * 1024 * 1024,
    'per-bundle import cap is 2 MiB'
  );
  assert.strictEqual(
    SandboxStoreModule.REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES,
    3 * 1024 * 1024,
    'total imported-template cap is 3 MiB'
  );
  assert.ok(!('ERR_STORE_NOT_INITIALIZED' in SANDBOX_STORE_ERROR_CODES), 'Dead ERR_STORE_NOT_INITIALIZED must be removed');
  assert.ok(!('ERR_STORE_STORAGE_FAILED' in SANDBOX_STORE_ERROR_CODES), 'Dead ERR_STORE_STORAGE_FAILED must be removed');
  assert.strictEqual(SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND, 'ERR_STORE_AGENT_NOT_FOUND');
  assert.strictEqual(SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED, 'ERR_STORE_NO_AGENT_SELECTED');
  assert.strictEqual(SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED, 'ERR_STORE_TURN_FAILED');
  assert.strictEqual(SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS, 'ERR_STORE_INVALID_PARAMS');
  assert.strictEqual(SANDBOX_STORE_ERROR_CODES.ERR_STORE_VFS_FAILED, 'ERR_STORE_VFS_FAILED');

  // Verify Singletons and Factories
  assert.ok(typeof createSandboxStore === 'function', 'createSandboxStore must be a function');
  assert.ok(typeof getSandboxStore === 'function', 'getSandboxStore must be a function');
  assert.ok(sandboxStore instanceof SandboxStore, 'sandboxStore must be an instance of SandboxStore');
  assert.strictEqual(getSandboxStore(), sandboxStore, 'getSandboxStore() must return the canonical singleton');
});

// ============================================================================
// 2. Store Instantiation & Substrate Dependency Injection
// ============================================================================

test('2. Store Instantiation with default vs custom substrate injection', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus });

  const customStore = new SandboxStore({
    virtualFs: vfs,
    messagingBus: bus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  assert.ok(customStore instanceof SandboxStore);
  assert.strictEqual(customStore.agents.length, 0);
  assert.strictEqual(customStore.recycleBin.length, 0);
  assert.strictEqual(customStore.selectedAgentId, null);
  assert.strictEqual(customStore.selectedAgent, null);
  assert.strictEqual(customStore.activeFsWorkspace, 'global');
  assert.strictEqual(customStore.activeTab, 'inspector');

  customStore.destroy();
});

// ============================================================================
// 3. Reactive State Projection ($state) & Pure Accessors ($derived)
// ============================================================================

test('3. Reactive State Projection and Derived Getters Verification', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  // Initial State
  assert.strictEqual(store.agents.length, 0);
  assert.strictEqual(store.recycleBinCount, 0);
  assert.strictEqual(store.selectedAgent, null);
  assert.deepStrictEqual(store.agentMessages, []);
  assert.strictEqual(store.isAgentStreaming, false);
  assert.strictEqual(store.streamingProse, '');
  assert.strictEqual(store.streamingReasoning, '');
  assert.deepStrictEqual(store.activeToolCalls, []);
  assert.ok(store.allWorkspaces.includes('global'));

  // Stats verification
  const initialStats = store.stats;
  assert.strictEqual(initialStats.total, 0);
  assert.strictEqual(initialStats.running, 0);
  assert.strictEqual(initialStats.idle, 0);
  assert.strictEqual(initialStats.cumulativeTotalTokens, 0);

  // Tab switching
  store.setActiveTab('chat');
  assert.strictEqual(store.activeTab, 'chat');
  store.setActiveTab('filesystem');
  assert.strictEqual(store.activeTab, 'filesystem');

  // Launch agent and verify projection
  const agent = await store.launchAgent({
    id: 'test-agent',
    name: 'Test Agent',
    role: 'tester',
    systemPrompt: 'You are a test assistant'
  });

  assert.strictEqual(store.agents.length, 1);
  assert.strictEqual(store.selectedAgentId, 'test-agent');
  assert.strictEqual(store.selectedAgent?.id, 'test-agent');
  assert.strictEqual(store.selectedAgent?.name, 'Test Agent');
  assert.strictEqual(store.selectedAgent?.state, AGENT_STATES.IDLE);
  assert.strictEqual(store.stats.total, 1);
  assert.strictEqual(store.stats.idle, 1);

  store.destroy();
});

// ============================================================================
// 4. Agent Lifecycle Operations (Launch, Kill, Restore, Purge, Config)
// ============================================================================

test('4. Agent Lifecycle Management: soft-kill recycle bin, restore, purge, config update', async () => {
  // Operator store: the director principal authorizes the kill path (MOD-21 W6).
  const store = await createOperatorStore();

  // 1. Launch Agent
  const agent = await store.spawnAgent({
    id: 'agent-writer',
    name: 'Lead Writer',
    role: 'Author',
    systemPrompt: 'Draft high-quality prose',
    model: createMockModel([{ content: 'Draft ready.' }])
  });
  assert.strictEqual(agent.id, 'agent-writer');
  assert.strictEqual(store.selectedAgentId, 'agent-writer');

  // 2. Update Agent Config
  const updated = store.updateAgentConfig('agent-writer', {
    systemPrompt: 'Updated instructions for chapter 1',
    temperature: 0.8
  });
  assert.strictEqual(updated.config.systemPrompt, 'Updated instructions for chapter 1');
  assert.strictEqual(store.selectedAgent?.config.systemPrompt, 'Updated instructions for chapter 1');

  // 3. Soft-kill Agent -> Moves to Recycle Bin
  const killed = store.killAgent('agent-writer', 'Task completed');
  assert.strictEqual(killed, true);
  assert.strictEqual(store.agents.length, 1, 'only the operator director remains active');
  assert.strictEqual(store.recycleBinCount, 1);
  assert.strictEqual(store.recycleBin[0].id, 'agent-writer');
  assert.strictEqual(store.recycleBin[0].recycleReason, 'Task completed');
  assert.strictEqual(store.selectedAgentId, 'director', 'selection falls back to the remaining operator agent');

  // Recycled projection shape: ISO recycledAt + actual preserved fields only
  const recycledSnapshot = store.recycleBin[0];
  assert.strictEqual(recycledSnapshot.state, AGENT_STATES.RECYCLED, 'Recycled projection must expose the RECYCLED state');
  assert.strictEqual(typeof recycledSnapshot.recycledAt, 'string', 'recycledAt must be an ISO-8601 string');
  assert.ok(!Number.isNaN(Date.parse(recycledSnapshot.recycledAt)), 'recycledAt must parse as a valid date');
  assert.strictEqual(typeof recycledSnapshot.turnCount, 'number');
  assert.ok(Array.isArray(recycledSnapshot.redoStack), 'Recycled projection must expose the turn-bundle redo stack');
  assert.ok(recycledSnapshot.telemetry && Array.isArray(recycledSnapshot.telemetry.lastSentContext));
  assert.ok(!('currentStream' in recycledSnapshot), 'Recycled projection must not claim live-turn stream fields');
  assert.ok(!('currentReasoning' in recycledSnapshot), 'Recycled projection must not claim live-turn reasoning fields');
  assert.ok(!('activeToolCalls' in recycledSnapshot), 'Recycled projection must not claim live-turn tool fields');
  assert.ok(!('unreadCount' in recycledSnapshot), 'Recycled projection must not claim inbox badge counts');

  // List & Get Recycled Agent
  const recycledList = store.listRecycledAgents();
  assert.strictEqual(recycledList.length, 1);
  const foundRecycled = store.getRecycledAgent('agent-writer');
  assert.strictEqual(foundRecycled?.name, 'Lead Writer');

  // 4. Restore Agent from Recycle Bin
  const restored = store.restoreAgent('agent-writer');
  assert.strictEqual(restored.id, 'agent-writer');
  assert.strictEqual(restored.state, AGENT_STATES.IDLE);
  assert.strictEqual(store.agents.length, 2, 'restored agent joins the operator director');
  assert.strictEqual(store.recycleBinCount, 0);
  assert.strictEqual(store.selectedAgentId, 'agent-writer');

  // 5. Re-kill and Permanently Purge
  store.killAgent('agent-writer', 'Purge test');
  assert.strictEqual(store.recycleBinCount, 1);
  const purged = store.purgeAgent('agent-writer');
  assert.strictEqual(purged, true);
  assert.strictEqual(store.recycleBinCount, 0);

  // 6. Multiple Agents Empty Recycle Bin
  await store.launchAgent({ id: 'agent-1', name: 'Agent 1', role: 'Role 1', model: createMockModel() });
  await store.launchAgent({ id: 'agent-2', name: 'Agent 2', role: 'Role 2', model: createMockModel() });
  store.killAgent('agent-1');
  store.killAgent('agent-2');
  assert.strictEqual(store.recycleBinCount, 2);

  const emptyCount = store.emptyRecycleBin();
  assert.strictEqual(emptyCount, 2);
  assert.strictEqual(store.recycleBinCount, 0);

  store.destroy();
});

// ============================================================================
// 5. Conversational Turn Execution, Dual-Stack Undo/Redo & Draft Buffers
// ============================================================================

test('5. Conversational Turn Execution, Undo/Redo dual-stack, and Draft buffers', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  const mockModel = createMockModel([
    { content: 'I am your test assistant ready to help.' },
    { content: 'Redone response from assistant.' }
  ]);

  await store.launchAgent({
    id: 'bot',
    name: 'Bot',
    role: 'Assistant',
    systemPrompt: 'You are a test assistant',
    model: mockModel
  });

  // Draft buffer management
  store.setAgentDraft('bot', 'Draft text before sending');
  assert.strictEqual(store.getAgentDraft('bot'), 'Draft text before sending');

  // Submit Turn (should clear draft)
  const turnResult = await store.submitChatTurn('Hello assistant', { mode: 'directive' });
  assert.ok(turnResult);
  assert.strictEqual(turnResult.agent.id, 'bot');
  assert.strictEqual(turnResult.output, 'I am your test assistant ready to help.');
  assert.strictEqual(store.getAgentDraft('bot'), '', 'Draft must be cleared after successful turn submission');

  // Verify conversation history
  assert.ok(store.agentMessages.length >= 2, 'History must contain messages');
  const userMsg = store.agentMessages.find(m => m.role === 'user');
  assert.ok(userMsg);
  assert.strictEqual(userMsg.content, 'Hello assistant');

  // Undo Turn (should restore user prompt into draft buffer)
  const initialCount = store.agentMessages.length;
  const undoResult = store.undoAgentTurn('bot');
  assert.ok(undoResult);
  assert.strictEqual(undoResult.restoredPrompt, 'Hello assistant');
  assert.strictEqual(store.getAgentDraft('bot'), 'Hello assistant', 'Undone prompt must be restored to draft buffer');
  assert.strictEqual(store.agentMessages.length, initialCount - 2, 'User and assistant messages popped from history');

  // Redo Turn (should re-execute turn and clear draft if matched)
  const redoResult = store.redoAgentTurn('bot');
  assert.ok(redoResult?.success);
  assert.strictEqual(store.getAgentDraft('bot'), '', 'Draft must be cleared after redo matching prompt');
  assert.strictEqual(store.agentMessages.length, initialCount, 'Messages must be restored to history after redo');

  store.destroy();
});

// ============================================================================
// 5b. User Turn Queue Routing (single dispatch point)
// ============================================================================

test('5b. User turns route through the runtime TriggerQueue', async () => {
  const runtime = new AgentRuntime();
  const store = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });

  await store.launchAgent({
    id: 'queued-chat',
    name: 'Queued Chat',
    role: 'Assistant',
    model: createMockModel([
      { content: 'queued reply one' },
      { content: 'queued reply two' }
    ])
  });

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

  const first = await store.submitChatTurn('hello queue');
  assert.strictEqual(first.output, 'queued reply one');
  assert.strictEqual(first.agent.id, 'queued-chat');

  const direct = await store.triggerTurn('queued-chat', 'second queued turn');
  assert.strictEqual(direct.output, 'queued reply two');

  const userTriggers = enqueuedTriggers.filter(t => t.type === 'user');
  assert.strictEqual(userTriggers.length, 2, 'store user turns must enqueue USER triggers');
  const queuedChatKey = createAgentIdentityKey('realm_generic', 'queued-chat');
  assert.deepStrictEqual(
    userTriggers.map(t => t.targetAgentId),
    [queuedChatKey, queuedChatKey],
    'store user triggers must target the canonical registration key of the requested agent in arrival order'
  );

  assert.strictEqual(executedTurns.length, 2, 'turns must be dispatched through the queue, not called directly');
  for (const executed of executedTurns) {
    assert.strictEqual(executed.options.triggerType, 'user', 'queue-dispatched turns must carry triggerType user');
    assert.ok(executed.options.triggerId, 'queue-dispatched turns must carry the queue triggerId');
  }
  assert.deepStrictEqual(
    executedTurns.map(e => e.options.triggerId),
    userTriggers.map(t => t.triggerId),
    'execution order must follow queue trigger order (intra-agent FIFO)'
  );

  store.destroy();
});

// ============================================================================
// 6. Emergency Turn Unsticking (INV-UNSTICK) & Retries
// ============================================================================

test('6. Emergency Turn Unsticking and Turn Retries', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  await store.launchAgent({
    id: 'stuck-agent',
    name: 'Stuck Agent',
    role: 'Worker',
    model: createMockModel()
  });

  // Test unstickAgent when agent is idle: the runtime receipt is surfaced unchanged
  const unstickRes = store.unstickAgent('stuck-agent');
  assert.strictEqual(unstickRes.success, true);
  assert.strictEqual(unstickRes.agent.id, 'stuck-agent');
  assert.strictEqual(unstickRes.previousState, AGENT_STATES.IDLE);
  assert.strictEqual(unstickRes.reason, 'Unstuck by user');
  assert.ok(!('agentId' in unstickRes), 'Unstick receipt must not synthesize an agentId alias');
  assert.strictEqual(store.selectedAgent?.state, AGENT_STATES.IDLE);

  // Missing target short-circuits to a bare failure receipt (no runtime fields)
  store.selectAgent(null);
  assert.deepStrictEqual(store.unstickAgent(null), { success: false });

  // Test cancelActiveTurn and cancelAll. cancelAll is sudoer-only (MOD-21 W8):
  // bootstrap the operator principal before the global stop.
  store.cancelActiveTurn();
  await store.ensureDirector();
  store.cancelAll();

  // Test isAgentInterrupted
  assert.strictEqual(store.isAgentInterrupted('stuck-agent'), false);

  // Clear Last Error and Telemetry
  store.clearAgentLastError('stuck-agent');
  const telemetryCleared = store.clearAgentTelemetry('stuck-agent');
  assert.strictEqual(telemetryCleared, true);

  store.destroy();
});

// ============================================================================
// 7. Conversational Message History Editing & Deletion
// ============================================================================

test('7. History Message Mutation and Deletion', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  await store.launchAgent({
    id: 'narrator',
    name: 'Narrator',
    role: 'Narrative Voice',
    model: createMockModel([{ content: 'Deep space is vast and silent.' }])
  });
  await store.submitChatTurn('Tell me a story about space');

  const history = store.agentMessages;
  assert.ok(history.length >= 2);
  const msgId = history[0].id;

  // Edit Message
  const edited = store.editAgentMessage(msgId, 'Tell me a story about deep sea exploration');
  assert.strictEqual(edited.content, 'Tell me a story about deep sea exploration');
  assert.strictEqual(store.agentMessages[0].content, 'Tell me a story about deep sea exploration');

  // Update History Message directly
  const updatedMsg = store.updateHistoryMessage('narrator', msgId, {
    content: 'Final edited prompt'
  });
  assert.strictEqual(updatedMsg.content, 'Final edited prompt');

  // Delete message
  const delSuccess = store.deleteAgentMessage(msgId);
  assert.strictEqual(delSuccess, true);
  assert.ok(!store.agentMessages.some(m => m.id === msgId));

  store.destroy();
});

// ============================================================================
// 8. Messaging Bus Integration & Mailbox Operations
// ============================================================================

test('8. Messaging Bus Integration: Send, Unread counts, List, Read, Drain', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  await store.launchAgent({ id: 'agent-alice', name: 'Alice', role: 'Sender', model: createMockModel() });
  await store.launchAgent({ id: 'agent-bob', name: 'Bob', role: 'Receiver', model: createMockModel() });

  // 1. Send Message Alice -> Bob (bus delivery receipt, not an envelope)
  const receipt = store.sendMessage('agent-alice', 'agent-bob', 'Status report ready', { priority: 'HIGH' });
  assert.strictEqual(receipt.success, true);
  assert.ok(receipt.id);
  assert.strictEqual(receipt.from, 'agent-alice');
  assert.strictEqual(receipt.to, 'agent-bob');
  assert.strictEqual(store.messages.length, 1);

  // 2. Unread count and Inbox listing for Bob
  const unreadCount = store.getAgentUnreadCount('agent-bob');
  assert.strictEqual(unreadCount, 1);

  const inbox = store.listAgentInbox('agent-bob', { unreadOnly: true });
  assert.strictEqual(inbox.length, 1);
  assert.strictEqual(inbox[0].from, 'agent-alice');

  // 3. Mark Message Read: the store surfaces the bus read receipt unchanged
  const readReceipt = store.markMessageRead('agent-bob', receipt.id);
  assert.strictEqual(readReceipt.success, true);
  assert.strictEqual(readReceipt.status, 'inbox');
  assert.strictEqual(readReceipt.message.id, receipt.id);
  assert.strictEqual(readReceipt.message.read, true);
  assert.strictEqual(store.getAgentUnreadCount('agent-bob'), 0);

  // Re-reading a consumed message resolves from the archive receipt
  const archivedReceipt = store.readAgentMessage('agent-bob', receipt.id, false);
  assert.strictEqual(archivedReceipt.success, true);
  assert.strictEqual(archivedReceipt.status, 'archived');
  assert.strictEqual(archivedReceipt.message.id, receipt.id);

  // Unknown message IDs yield a failure receipt (never throw)
  const missingReceipt = store.readAgentMessage('agent-bob', 'msg_does_not_exist');
  assert.strictEqual(missingReceipt.success, false);
  assert.strictEqual(missingReceipt.code, 'MESSAGE_NOT_FOUND');

  // Unknown recipients still raise the store error code
  assert.throws(
    () => store.readAgentMessage('missing-agent', receipt.id),
    (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND
  );

  // 4. Drain Inbox
  store.sendMessage('agent-alice', 'agent-bob', 'Follow up 1');
  store.sendMessage('agent-alice', 'agent-bob', 'Follow up 2');
  assert.strictEqual(store.getAgentUnreadCount('agent-bob'), 2);

  const drained = store.drainAgentInbox('agent-bob');
  assert.strictEqual(drained.length, 2);
  assert.strictEqual(store.getAgentUnreadCount('agent-bob'), 0);

  store.destroy();
});

// ============================================================================
// 9. Scheduled Timers & Live Countdowns
// ============================================================================

test('9. Scheduled Timers Registration, Tracking, and Cancellation', async () => {
  // Operator store: scheduler visibility/cancellation requires a principal (MOD-21 W6).
  const store = await createOperatorStore();

  await store.launchAgent({ id: 'timer-bot', name: 'Timer Bot', role: 'Worker', model: createMockModel() });

  // Schedule a timer
  const receipt = await store.scheduleTimer({
    durationSeconds: 10,
    prompt: 'Check periodic status',
    timerCondition: 'never',
    agentId: 'timer-bot'
  });

  assert.ok(receipt.success);
  assert.ok(receipt.timerId);
  assert.strictEqual(store.scheduledTimers.length, 1);
  const timer = store.scheduledTimers[0];
  assert.strictEqual(timer.timerId, receipt.timerId);
  assert.strictEqual(timer.agentId, 'timer-bot');
  assert.strictEqual(timer.status, 'pending');
  assert.ok(timer.remainingSeconds <= 10 && timer.remainingSeconds >= 0);

  // Cancel the scheduled timer
  const cancelled = store.cancelScheduledTimer(receipt.timerId, 'Cancelled in test');
  assert.strictEqual(cancelled, true);
  assert.strictEqual(store.scheduledTimers[0].status, 'cancelled');

  store.destroy();
});

// ============================================================================
// 10. VirtualFS Workspace Observation, Two-Way Clock Sync, JSON Query & Grep
// ============================================================================

test('10. VirtualFS Operations, WorldClock two-way sync, JSON queries, grep and file batching', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  // Write file to global workspace
  const meta = store.writeFile('/report.json', JSON.stringify({ status: 'ok', score: 98 }, null, 2));
  assert.strictEqual(meta.path, '/report.json');
  assert.ok(store.activeFsFiles.some(f => f.path === '/report.json'));

  // Query JSON
  const score = store.queryJson('/report.json', 'score', 'global');
  assert.strictEqual(score, 98);

  // Grep
  const grepMatches = store.grep('"score": 98', 'global');
  assert.strictEqual(grepMatches.length, 1);
  assert.strictEqual(grepMatches[0].filePath, '/report.json');

  // Copy File
  const copyReceipt = store.copyFile('/report.json', '/report_backup.json');
  assert.strictEqual(copyReceipt.success, true);
  assert.ok(store.activeFsFiles.some(f => f.path === '/report_backup.json'));

  // Upload Files mock
  const uploadReceipt = await store.uploadFiles([
    { path: '/notes.txt', content: 'Sample notes text' }
  ], 'global');
  assert.strictEqual(uploadReceipt.success, true);
  assert.strictEqual(uploadReceipt.count, 1);

  // Two-way sync: Writing /world_clock.json updates clock snapshot
  store.writeFile('/world_clock.json', JSON.stringify({ totalSeconds: 7200, date: 'Day 2' }), { workspaceId: 'global' });
  const clock = store.getAgentClock('global');
  assert.strictEqual(clock.totalSeconds, 7200);

  // Batch delete files
  const deleteReceipt = store.deleteFiles(['/report.json', '/report_backup.json', '/notes.txt'], 'global');
  assert.strictEqual(deleteReceipt.success, true);
  assert.strictEqual(deleteReceipt.count, 3);

  // Single delete
  const delOne = store.deleteFile('/world_clock.json', 'global');
  assert.strictEqual(delOne, true);

  store.destroy();
});

// ============================================================================
// 11. World Clock & Narrative Event Partition Management
// ============================================================================

test('11. World Clock narrative time advancement and event queries', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  // Advance clock
  const advanced = store.advanceAgentClock(3661, 'global');
  assert.strictEqual(advanced.totalSeconds, 3661);
  assert.strictEqual(advanced.hour, 1);
  assert.strictEqual(advanced.minute, 1);
  assert.strictEqual(advanced.second, 1);

  // Reset clock
  const resetReceipt = store.resetAgentClock('global');
  assert.strictEqual(resetReceipt.success, true);
  assert.strictEqual(store.getAgentClock('global').totalSeconds, 0);

  // Query events
  const events = store.queryAgentEvents({}, 'global');
  assert.ok(Array.isArray(events.events));
  assert.strictEqual(events.count, 0);

  // Reset events
  const resetEvents = store.resetAgentEvents('global');
  assert.strictEqual(resetEvents.success, true);

  store.destroy();
});

// ============================================================================
// 12. Storage Persistence Serialization, Auto-Save & Zero-Zombie Auto-Hydration
// ============================================================================

test('12. Storage Persistence serialization, debounced save, hydration, and factory reset', async () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await store.launchAgent({ id: 'writer-persisted', name: 'Persisted Writer', role: 'Writer', model: createMockModel() });
  store.setAgentDraft('writer-persisted', 'Saved draft for recovery');
  store.setActiveTab('filesystem');
  store.setActiveFsWorkspace('writer-persisted');

  // 1. Serialization
  const snapshot = store.serialize();
  assert.strictEqual(snapshot.version, '1.0.0');
  assert.strictEqual(snapshot.activeAgentId, 'writer-persisted');
  assert.strictEqual(snapshot.activeTab, 'filesystem');
  assert.strictEqual(snapshot.activeFsWorkspace, 'writer-persisted');
  assert.strictEqual(snapshot.agentDraftInputs['writer-persisted'], 'Saved draft for recovery');

  // 2. Save to Storage
  const saved = store.saveToStorage();
  assert.strictEqual(saved, true);

  // 3. Hydrate into fresh store
  const hydratedStore = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  assert.strictEqual(hydratedStore.agents.length, 1);
  assert.strictEqual(hydratedStore.agents[0].id, 'writer-persisted');
  assert.strictEqual(hydratedStore.selectedAgentId, 'writer-persisted');
  assert.strictEqual(hydratedStore.activeTab, 'filesystem');
  assert.strictEqual(hydratedStore.activeFsWorkspace, 'writer-persisted');
  assert.strictEqual(hydratedStore.getAgentDraft('writer-persisted'), 'Saved draft for recovery');

  // Zero-Zombie Policy: Restored agents must be in IDLE state
  assert.strictEqual(hydratedStore.agents[0].state, AGENT_STATES.IDLE);

  // 4. Factory Reset
  hydratedStore.factoryReset();
  assert.strictEqual(hydratedStore.agents.length, 0);
  assert.strictEqual(hydratedStore.recycleBin.length, 0);
  assert.strictEqual(hydratedStore.messages.length, 0);

  store.destroy();
  hydratedStore.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 13. End-to-End Multi-Agent Handshake Scenario (runHandshakeDemo)
// ============================================================================

test('13. Multi-Agent Collaboration Handshake Demo (runHandshakeDemo)', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  const result = await store.runHandshakeDemo();
  assert.strictEqual(result.success, true);
  assert.ok(result.logs.length >= 7, 'Handshake demo must emit step logs');
  assert.strictEqual(store.demoStep, 'Handshake Complete');
  assert.strictEqual(store.isDemoRunning, false);

  // Verify created agents and files
  assert.ok(store.agents.some(a => a.id === 'agent-scout'));
  assert.ok(store.agents.some(a => a.id === 'agent-commander'));

  const globalFiles = store.fsSnapshot['global'] || {};
  assert.ok(globalFiles['/mission_report.json'], 'Scout must have written /mission_report.json');
  assert.ok(globalFiles['/orders.json'], 'Commander must have written /orders.json');

  // Verify bus messages exchanged
  assert.ok(store.messages.some(m => m.from === 'agent-scout' && m.to === 'agent-commander'));
  assert.ok(store.messages.some(m => m.from === 'agent-commander' && m.to === 'agent-scout'));

  store.destroy();
});

// ============================================================================
// 14. Standardized Error Codes & Edge Case Parameter Handling
// ============================================================================

test('14. Standardized Error Codes & Edge Cases Validation', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  // 1. Submit turn with no agent selected -> ERR_STORE_NO_AGENT_SELECTED
  await assert.rejects(
    async () => { await store.submitChatTurn('Hello without agent'); },
    (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED || err.message === SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED
  );

  // 2. Edit message with no agent selected -> ERR_STORE_NO_AGENT_SELECTED
  assert.throws(
    () => { store.editAgentMessage('msg_1', 'New content'); },
    (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED || err.message === SANDBOX_STORE_ERROR_CODES.ERR_STORE_NO_AGENT_SELECTED
  );

  // 3. Launch agent with invalid params -> ERR_STORE_INVALID_PARAMS
  await assert.rejects(
    async () => { await store.launchAgent(null); },
    (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS || err.message === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
  );

  // 4. Restore non-existent agent -> ERR_STORE_AGENT_NOT_FOUND
  assert.throws(
    () => { store.restoreAgent('non-existent-agent'); },
    (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND || err.message === SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND
  );

  // 5. Update config for non-existent agent -> ERR_STORE_AGENT_NOT_FOUND
  assert.throws(
    () => { store.updateAgentConfig('non-existent-agent', { name: 'Ghost' }); },
    (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND || err.message === SANDBOX_STORE_ERROR_CODES.ERR_STORE_AGENT_NOT_FOUND
  );

  // 6. Schedule timer with invalid duration -> ERR_STORE_INVALID_PARAMS
  await assert.rejects(
    async () => { await store.scheduleTimer({ durationSeconds: -5, prompt: 'Negative timer' }); },
    (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS || err.message === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
  );

  store.destroy();
});

// ============================================================================
// 15. In-Flight Turn Mirror Bridge (QA-009)
// ============================================================================

test('15. In-flight turn mirror bridge: state, stream buffers and KPIs update mid-turn', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  const gated = createGatedStreamModel();
  await store.launchAgent({
    id: 'live-turn-agent',
    name: 'Live Turn Agent',
    role: 'Writer',
    systemPrompt: 'Stream a story',
    model: gated.model
  });

  const turnPromise = store.submitChatTurn('Tell me a long story', { mode: 'directive' });

  // The model yields one chunk then blocks on the gate, so a correctly wired
  // mirror must expose in-flight state before the turn resolves.
  const sawFirstChunk = await waitFor(() => Boolean(store.selectedAgent?.currentStream));
  assert.ok(sawFirstChunk, 'Mirror must observe the first streamed chunk mid-turn');

  assert.strictEqual(store.selectedAgent?.state, AGENT_STATES.RUNNING, 'Agent state must be running mid-turn');
  assert.strictEqual(store.isAgentStreaming, true, 'isAgentStreaming must be true mid-turn (Stop control reachable)');
  assert.strictEqual(store.streamingProse, 'Streaming chunk one. ', 'streamingProse must expose in-flight prose');
  assert.strictEqual(store.stats.running, 1, 'Running KPI must count the in-flight turn');
  assert.ok(
    store.agentMessages.some(m => m.role === 'user' && m.content === 'Tell me a long story'),
    'User directive must be visible mid-turn'
  );

  // Patch-in-place guard: further chunks must not rebuild/clone the agent list.
  const mirroredRef = store.agents.find(a => a.id === 'live-turn-agent');
  gated.releaseFirst();
  const sawSecondChunk = await waitFor(() => store.selectedAgent?.currentStream.includes('chunk two'));
  assert.ok(sawSecondChunk, 'Mirror must observe later streamed chunks mid-turn');
  assert.strictEqual(
    store.agents.find(a => a.id === 'live-turn-agent'),
    mirroredRef,
    'Stream mirroring must patch the existing clone, not rebuild the agent list per chunk'
  );
  assert.strictEqual(store.isAgentStreaming, true, 'Agent stays streaming until completion');

  gated.releaseSecond();
  const result = await turnPromise;
  assert.strictEqual(result.output, 'Streaming chunk one. Streaming chunk two. ');
  assert.strictEqual(store.selectedAgent?.state, AGENT_STATES.IDLE, 'Agent returns to idle after completion');
  assert.strictEqual(store.stats.running, 0, 'Running KPI returns to 0 after completion');

  store.destroy();
});

// ============================================================================
// 16. Runtime Subscription Survives Store Reset (QA-009 root cause)
// ============================================================================

test('16. Runtime event subscription is restored after store reset/factory reset', async () => {
  const runtime = new AgentRuntime();
  const store = new SandboxStore({
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  await store.launchAgent({
    id: 'reset-probe',
    name: 'Reset Probe',
    role: 'Worker',
    model: createMockModel([{ content: 'ok' }])
  });

  // store.reset() calls runtime.reset(), which clears every runtime event
  // listener. The store must re-subscribe so the mirror keeps tracking events.
  store.reset();

  await store.launchAgent({
    id: 'reset-probe-2',
    name: 'Reset Probe 2',
    role: 'Worker',
    model: createMockModel([{ content: 'ok' }])
  });

  const liveAgent = runtime.getAgent('reset-probe-2');
  assert.ok(liveAgent, 'Runtime must expose the relaunched agent');
  runtime.setAgentState(liveAgent, AGENT_STATES.RUNNING, 'Probe transition', { callerAgentId: 'reset-probe-2' });

  const mirrored = store.agents.find(a => a.id === 'reset-probe-2');
  assert.strictEqual(
    mirrored?.state,
    AGENT_STATES.RUNNING,
    'Store mirror must receive runtime state events after reset (subscription restored)'
  );
  assert.strictEqual(store.stats.running, 1, 'Running KPI must reflect the post-reset state event');

  store.destroy();
});

// ============================================================================
// 17. Unified Error Surface & Hydration Recovery (QA-012 / QA-013)
// ============================================================================

test('17. lastError is redacted, survives reload, and corrupted state raises a dismissible notice', async () => {
  sharedLocalStorage.clear();

  // --- QA-012: failed chat turn exposes a sanitized per-agent reason ---
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const failingModel = createMockModel([
    { error: new Error('Provider 401: invalid api_key=sk-test-live-secret-abcdef1234567890') }
  ]);
  await store.launchAgent({ id: 'qa12-agent', name: 'QA-012 Agent', role: 'tester', model: failingModel });

  await assert.rejects(
    () => store.submitChatTurn('Trigger a failing turn'),
    (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_TURN_FAILED
  );

  const projected = store.selectedAgent;
  assert.ok(projected.lastError, 'Store projection must expose the failure reason');
  assert.ok(projected.lastError.includes('401'), 'Provider reason must be surfaced');
  assert.ok(
    !projected.lastError.includes('sk-test-live-secret-abcdef1234567890'),
    'Secrets must be redacted before rendering'
  );
  assert.strictEqual(
    store.isAgentInterrupted('qa12-agent'),
    true,
    'A failed tail turn must remain retryable through the interrupted affordances'
  );

  // --- QA-012 reload coherence: the redacted reason is restored on the idle agent ---
  assert.strictEqual(store.saveToStorage(), true);
  const reloaded = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  const restoredAgent = reloaded.agents.find(a => a.id === 'qa12-agent');
  assert.ok(restoredAgent, 'Reloaded store must restore the agent');
  assert.strictEqual(restoredAgent.state, AGENT_STATES.IDLE, 'Zero-Zombie hydration resets state to idle');
  assert.ok(
    restoredAgent.lastError && restoredAgent.lastError.includes('401'),
    'Failure reason must survive reload so the chat card stays coherent'
  );
  assert.ok(
    !restoredAgent.lastError.includes('sk-test-live-secret-abcdef1234567890'),
    'Restored diagnostic must remain redacted'
  );

  reloaded.destroy();
  store.destroy();
  sharedLocalStorage.clear();

  // --- QA-013: unreadable persisted state raises a dismissible notice ---
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', '{broken json');
  const recovering = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  assert.ok(recovering.hydrationNotice, 'Recovery notice must be raised on unreadable state');
  assert.strictEqual(recovering.hydrationNotice.message, 'Saved session could not be loaded — starting fresh');
  assert.strictEqual(recovering.hydrationNotice.reason, 'unparseable');
  assert.strictEqual(recovering.agents.length, 0, 'Studio must fall back to fresh default state');
  assert.strictEqual(
    sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'),
    null,
    'Unreadable entry must be cleared instead of silently overwritten'
  );

  recovering.dismissHydrationNotice();
  assert.strictEqual(recovering.hydrationNotice, null, 'Dismiss must clear the recovery notice');
  recovering.destroy();

  sharedLocalStorage.clear();
});

// ============================================================================
// 18. Vault Credential Rebind Walk (QA-022 RC-1)
// ============================================================================

test('18. rebindProviderCredentials re-pins legacy agents and skips preset-bound agents (OPEN-2)', async () => {
  const backing = new Map();
  const vault = new CredentialVault({
    storage: {
      get: (key) => backing.get(key) ?? null,
      set: (key, value) => { backing.set(key, value); },
      remove: (key) => { backing.delete(key); }
    },
    storageKey: 'qa022_rebind_vault'
  });
  const resolver = vault.createResolverPort();
  const runtime = new AgentRuntime({ credentialResolver: resolver, autoBootstrapDirector: false });
  const store = await createOperatorStore({ runtime });

  const bogus = vault.addCredential({ providerId: 'custom', label: 'Bogus', apiKey: 'bogus-key' });
  const good = vault.addCredential({ providerId: 'custom', label: 'Good', apiKey: 'good-key' });
  vault.setActiveCredential('custom', good.id);

  // Store-owned custom preset so the bound probe shares the walked provider.
  store.getPresetCatalog().savePreset({
    id: 'preset_custom_rebind18',
    name: 'Rebind Probe Preset',
    isCustom: true,
    modelConfig: { providerId: 'custom', url: 'https://api.example.test/v1', modelId: 'test-model' }
  });

  const baseConfig = () => ({
    modelConfig: {
      providerId: 'custom',
      url: 'https://api.example.test/v1',
      modelId: 'test-model',
      keyId: bogus.id
    }
  });

  await store.launchAgent({ id: 'rebind-live', name: 'Rebind Live', ...baseConfig() });
  await store.launchAgent({ id: 'rebind-recycled', name: 'Rebind Recycled', ...baseConfig() });
  // Preset-bound (MOD-20 OPEN-2): credential rotation reaches this agent at the
  // next turn start through the preset resolver, never through the legacy walk.
  await store.launchAgent({
    id: 'rebind-bound',
    name: 'Rebind Bound',
    presetId: 'preset_custom_rebind18',
    ...baseConfig()
  });
  await store.launchAgent({
    id: 'rebind-other',
    name: 'Rebind Other',
    modelConfig: { providerId: 'openai', url: 'https://api.other.test/v1', modelId: 'other-model', keyId: 'canonical_openai' }
  });
  store.killAgent('rebind-recycled', 'Recycled for rebind coverage');

  const live = runtime.getAgent('rebind-live');
  const recycled = runtime.getRecycledAgent('rebind-recycled');
  const bound = runtime.getAgent('rebind-bound');
  const other = runtime.getAgent('rebind-other');
  assert.strictEqual(live.provider.credentialId, bogus.id);
  assert.strictEqual(live.provider.getEffectiveApiKey(), 'bogus-key');
  const liveProviderBefore = live.provider;
  const boundProviderBefore = bound.provider;
  const boundKeyIdBefore = bound.modelConfig.keyId;
  const boundModelConfigBefore = { ...bound.config.modelConfig };
  assert.strictEqual(bound.config.presetId, 'preset_custom_rebind18', 'The probe must stay preset-bound');

  // Vault mutation alone does not heal a live legacy agent that pins the stale credential.
  vault.setActiveCredential('custom', good.id);
  assert.strictEqual(live.provider.getEffectiveApiKey(), 'bogus-key', 'Baseline: pinned live agent ignores the new active credential');

  const reboundCount = store.rebindProviderCredentials('custom', good.id);
  assert.strictEqual(reboundCount, 2, 'Rebind walk must cover only the legacy active + recycled agents');
  assert.strictEqual(live.modelConfig.keyId, good.id);
  assert.strictEqual(live.provider.credentialId, good.id);
  assert.notStrictEqual(live.provider, liveProviderBefore, 'Provider/model initialization must run again');
  assert.strictEqual(live.provider.getEffectiveApiKey(), 'good-key');
  assert.strictEqual(recycled.modelConfig.keyId, good.id);
  assert.strictEqual(recycled.provider.credentialId, good.id);
  assert.strictEqual(recycled.provider.getEffectiveApiKey(), 'good-key');
  assert.strictEqual(other.modelConfig.keyId, 'canonical_openai', 'Other providers must not be re-pinned');
  assert.strictEqual(other.provider.credentialId, 'canonical_openai');

  // Preset-bound agent is untouched: no modelConfig/keyId rewrite, no re-init.
  assert.strictEqual(bound.modelConfig.keyId, boundKeyIdBefore, 'Preset-bound keyId must not be rewritten');
  assert.deepStrictEqual({ ...bound.config.modelConfig }, boundModelConfigBefore, 'Preset-bound config must not be rewritten');
  assert.strictEqual(bound.provider, boundProviderBefore, 'Preset-bound provider must not be re-initialized');

  // Clearing with a falsy credential id unpins keyId so active resolution owns the binding.
  assert.strictEqual(store.rebindProviderCredentials('custom', null), 2);
  assert.strictEqual(live.modelConfig.keyId, undefined);
  assert.strictEqual(live.provider.credentialId, good.id, 'Unpinned provider resolves the vault active credential');
  assert.strictEqual(live.provider.getEffectiveApiKey(), 'good-key');
  assert.strictEqual(bound.modelConfig.keyId, boundKeyIdBefore, 'Preset-bound agent stays untouched across unpin walks');

  // No matches and missing args must be safe no-ops.
  assert.strictEqual(store.rebindProviderCredentials('runware', 'canonical_runware'), 0);
  assert.doesNotThrow(() => store.rebindProviderCredentials());

  store.destroy();
});

// ============================================================================
// 19. Declaration Truth: History, Tool-Call & Context Projection Shapes (f1a36b4)
// ============================================================================

test('19. History, tool-call and lastSentContext projections expose the runtime shapes', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  const mockModel = createMockModel([
    {
      content: 'Reading the report now.',
      reasoning: 'I should inspect the requested file first.',
      toolCalls: [
        {
          id: 'call_shape_1',
          type: 'function',
          function: { name: 'vfs_read_file', arguments: '{"filePath":"/missing.txt"}' }
        }
      ]
    },
    { content: 'The report is unavailable.' }
  ]);

  await store.launchAgent({
    id: 'shape-agent',
    name: 'Shape Agent',
    role: 'Inspector',
    systemPrompt: 'Inspect files',
    model: mockModel
  });

  const turn = await store.submitChatTurn('Read /missing.txt');
  assert.ok(Array.isArray(turn.toolCalls) && turn.toolCalls.length === 1, 'Turn receipt must expose the executed tool call');

  // Normalized tool-call projection: flat aliases + OpenAI function projection
  const toolCall = turn.toolCalls[0];
  assert.strictEqual(toolCall.id, 'call_shape_1');
  assert.strictEqual(toolCall.type, 'function');
  assert.strictEqual(toolCall.name, 'vfs_read_file');
  assert.strictEqual(toolCall.args.filePath, '/missing.txt');
  assert.strictEqual(toolCall.function.name, 'vfs_read_file');
  assert.strictEqual(typeof toolCall.function.arguments, 'string');
  assert.ok(!('status' in toolCall), 'Tool-call projection must not invent execution-status fields');
  assert.ok(!('result' in toolCall), 'Tool-call projection must not invent result fields');

  // History projection: snake_case tool fields, no camelCase/timestamp aliases
  const assistantMsg = store.agentMessages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.ok(assistantMsg, 'Assistant history entry must declare snake_case tool_calls');
  assert.strictEqual(assistantMsg.tool_calls[0].function.name, 'vfs_read_file');
  assert.strictEqual(typeof assistantMsg.reasoning_content, 'string', 'Assistant history entry must expose reasoning_content');
  assert.ok(!('timestamp' in assistantMsg), 'History projection must not claim a timestamp field');
  assert.ok(!('toolCalls' in assistantMsg), 'History projection must not claim camelCase toolCalls');
  assert.ok(!('toolCallId' in assistantMsg), 'History projection must not claim camelCase toolCallId');

  const toolMsg = store.agentMessages.find(m => m.role === 'tool');
  assert.ok(toolMsg, 'Tool response must be recorded in history');
  assert.strictEqual(toolMsg.tool_call_id, 'call_shape_1');
  assert.ok(!('toolCallId' in toolMsg), 'Tool response must use snake_case tool_call_id');

  // Telemetry context projection: formatted messages captured before inference
  const telemetryContext = store.selectedAgent.telemetry.lastSentContext;
  assert.ok(Array.isArray(telemetryContext) && telemetryContext.length > 0, 'lastSentContext must capture formatted messages');
  const contextUser = telemetryContext.find(m => m.role === 'user');
  assert.ok(contextUser, 'Formatted context must retain the user entry');
  assert.strictEqual(contextUser.content, 'Read /missing.txt');
  for (const entry of telemetryContext) {
    assert.ok(['system', 'user', 'assistant', 'tool'].includes(entry.role), 'Context entries must use canonical roles');
    assert.ok(!('toolCalls' in entry), 'Formatted context must not claim camelCase toolCalls');
    if (entry.role === 'assistant') {
      assert.strictEqual(typeof entry.reasoning_content, 'string', 'Assistant context entries must expose reasoning_content');
      if (Array.isArray(entry.tool_calls)) {
        for (const contextToolCall of entry.tool_calls) {
          assert.strictEqual(typeof contextToolCall.id, 'string');
          assert.strictEqual(contextToolCall.type, 'function');
          assert.strictEqual(typeof contextToolCall.function.name, 'string');
          assert.strictEqual(typeof contextToolCall.function.arguments, 'string');
        }
      }
    }
    if (entry.role === 'tool') {
      assert.strictEqual(typeof entry.tool_call_id, 'string', 'Tool context entries must expose tool_call_id');
    }
  }

  store.destroy();
});

// ============================================================================
// 20. Separate download receipt shape (aa46d4e)
// ============================================================================

test('20. SeparateDownloadReceipt matches the runtime batch receipt shape', async () => {
  // Static contract check: declared fields must be exactly the runtime fields.
  const contractSource = fs.readFileSync(CONTRACT_PATH, 'utf-8');
  const receiptBlock = contractSource.match(/export interface SeparateDownloadReceipt \{[\s\S]*?\n\}/);
  assert.ok(receiptBlock, 'SeparateDownloadReceipt must be declared in the store contract');
  assert.match(receiptBlock[0], /\bcount: number;/, 'SeparateDownloadReceipt must declare count');
  assert.match(receiptBlock[0], /\bfiles: string\[\];/, 'SeparateDownloadReceipt must declare files');
  assert.match(receiptBlock[0], /\bfailures:/, 'SeparateDownloadReceipt must declare failures');
  assert.doesNotMatch(receiptBlock[0], /downloadedCount/, 'SeparateDownloadReceipt must not declare downloadedCount');
  assert.doesNotMatch(receiptBlock[0], /totalFiles/, 'SeparateDownloadReceipt must not declare totalFiles');

  // Runtime receipt check: the store returns the fsDownloadUtils batch receipt unchanged.
  // Use a dedicated workspace so the runtime-seeded global files do not skew counts.
  const store = await createOperatorStore();
  const wsAuth = { workspaceId: 'receipt-ws', callerAgentId: 'receipt-ws' };
  store.writeFile('/alpha.txt', 'alpha content', wsAuth);
  store.writeFile('/beta.json', JSON.stringify({ beta: true }), wsAuth);

  const receipt = await store.downloadWorkspaceFilesSeparately('receipt-ws');
  assert.deepStrictEqual(
    Object.keys(receipt).sort(),
    ['count', 'failures', 'files', 'success'],
    'Runtime receipt must expose exactly success/count/files/failures'
  );
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.count, 2);
  assert.deepStrictEqual([...receipt.files].sort(), ['alpha.txt', 'beta.json']);
  assert.deepStrictEqual(receipt.failures, []);
  assert.ok(!('downloadedCount' in receipt), 'Runtime receipt must not expose downloadedCount');
  assert.ok(!('totalFiles' in receipt), 'Runtime receipt must not expose totalFiles');

  const allReceipt = await store.downloadAllWorkspacesFilesSeparately();
  assert.deepStrictEqual(
    Object.keys(allReceipt).sort(),
    ['count', 'failures', 'files', 'success'],
    'All-workspaces receipt must expose the same batch shape'
  );
  assert.ok(allReceipt.count >= 2, 'All-workspaces receipt must count the dedicated workspace files');
  assert.ok(
    allReceipt.files.includes('receipt-ws_alpha.txt'),
    'All-workspaces receipt must use workspace-prefixed filenames'
  );
  assert.deepStrictEqual(allReceipt.failures, []);

  store.destroy();
});

// ============================================================================
// 21. Restore Failure Surfacing (9c496da)
// ============================================================================

test('21. hydrateFromStorage reports failure and raises a notice when a critical subsystem rejects its snapshot', async () => {
  sharedLocalStorage.clear();

  const customPreset = {
    id: 'preset_custom_store21',
    name: 'Store 21',
    isCustom: true,
    modelConfig: { providerId: 'custom', url: 'https://api.example.test/v1', modelId: 'store-21-model' }
  };
  const corruptState = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: null,
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [],
    recycleBin: [],
    virtualFs: {},
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    // Schema-valid but rejected atomically by WorldClock.importSnapshot
    worldClock: { totalSeconds: 0, date: 'Day 1', events: [{ name: 'Missing id event' }] },
    agentDraftInputs: {},
    // Snapshot-backed preset topology: load-time reconciliation must update
    // in-memory state but must never schedule an autosave that rewrites these
    // bytes (the failed-restore data-loss regression).
    activePresetId: customPreset.id,
    customPresets: [customPreset]
  };
  // Drain any pending autosave left by earlier tests before seeding, so the
  // deferred no-write check observes only this store's hydration path.
  drainPendingAutosaves();
  sharedLocalStorage.clear();
  const seededRaw = JSON.stringify(corruptState);
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', seededRaw);

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });

  assert.strictEqual(store.hydrateFromStorage(), false, 'A rejected restore result must not count as success');
  assert.ok(store.hydrationNotice, 'Store must surface the failed restore');
  assert.strictEqual(store.hydrationNotice.reason, 'hydration-failed');
  assert.match(store.hydrationNotice.message, /Saved session could not be fully restored/);
  assert.match(store.hydrationNotice.message, /worldClock: Corrupted snapshot/);
  assert.match(store.hydrationNotice.message, /1 malformed entry/);

  store.dismissHydrationNotice();
  assert.strictEqual(store.hydrationNotice, null);

  // F1 regression: the failed-hydration branch schedules no write at all. Wait
  // past the 300ms debounce window (real timers) and require the raw bytes to
  // deep-equal the seeded snapshot.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepStrictEqual(
    JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1')),
    JSON.parse(seededRaw),
    'A failed hydration must leave raw persisted bytes untouched (no deferred autosave)'
  );

  store.destroy();
});

// ============================================================================
// 22. turn_redone Runtime Event Dispatch (ade8fb6)
// ============================================================================

test('22. turn_redone runtime events trigger the history/fs/clock/autosave re-sync', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });

  await store.launchAgent({
    id: 'redo-probe',
    name: 'Redo Probe',
    role: 'Worker',
    model: createMockModel([{ content: 'first response' }])
  });
  await store.submitChatTurn('prompt one');
  store.undoAgentTurn('redo-probe');

  // Out-of-band clock mutation: no runtime event fires, so the store projection
  // stays stale until the next dispatched event runs #syncClockSnapshot.
  runtime.worldClock.advanceClock({ seconds: 3600 }, {});
  assert.strictEqual(
    store.clockSnapshot.global.totalSeconds,
    0,
    'Clock projection must be stale before the redo event is dispatched'
  );

  const redoRes = runtime.redoAgentTurn('redo-probe');
  assert.strictEqual(redoRes.success, true, 'Runtime redo must succeed so turn_redone is emitted');

  assert.strictEqual(
    store.clockSnapshot.global.totalSeconds,
    3600,
    'turn_redone dispatch must re-sync the clock projection (alongside fs/messages/timers/autosave)'
  );

  store.destroy();
});

// ============================================================================
// 23. Archive download / VFS record contract truth (9de5e18, ebc34b2)
// ============================================================================

test('23. ArchiveDownloadReceipt, fsSnapshot/activeFsFiles, and downloadFile match the runtime shapes', async () => {
  const contractSource = fs.readFileSync(CONTRACT_PATH, 'utf-8');

  // The store re-uses the runtime receipt type instead of redeclaring a fictional one.
  assert.match(
    contractSource,
    /import type \{[^}]*ArchiveDownloadReceipt[^}]*\} from '\.\.\/fsDownloadUtils\/index\.ts';/,
    'ArchiveDownloadReceipt must be imported type-only from fsDownloadUtils'
  );
  assert.doesNotMatch(
    contractSource,
    /export interface ArchiveDownloadReceipt \{/,
    'The fictional store-local ArchiveDownloadReceipt must be deleted'
  );
  // Implementation code legitimately passes `archiveName` to the archive factory,
  // so the negative proof is scoped to the declared store surface.
  const declaredBlocks = contractSource.match(/export (?:interface|type) [A-Za-z0-9_]+[\s\S]*?\n\}/g) || [];
  assert.doesNotMatch(declaredBlocks.join('\n'), /archiveName|fileCount|totalBytes/, 'Fictional receipt fields must not reappear in the declared store surface');

  // VFS projections use FileRecord, not FileListItem aliases; downloadFile returns its receipt.
  assert.match(contractSource, /fsSnapshot = \$state<Record<string, Record<string, FileRecord>>>\(/, 'fsSnapshot must be typed as FileRecord maps');
  assert.match(contractSource, /get activeFsFiles\(\): ReadonlyArray<FileRecord> \{/, 'activeFsFiles must be typed as FileRecord');
  assert.match(
    contractSource,
    /downloadFile\(filePath: string, workspaceId: string \| null = null\): DownloadReceipt \{/,
    'downloadFile must declare the real DownloadReceipt return type'
  );

  // Runtime shape: successful archive + single-file downloads expose the real fields.
  const store = await createOperatorStore();
  const wsAuth = { workspaceId: 'archive-ws', callerAgentId: 'archive-ws' };
  store.writeFile('/alpha.txt', 'alpha content', wsAuth);

  const record = store.fsSnapshot['archive-ws']['/alpha.txt'];
  assert.ok(record, 'fsSnapshot entries must carry the VFS FileRecord shape');
  for (const field of ['path', 'workspaceId', 'content', 'size', 'updatedAt', 'readOnly', 'owner']) {
    assert.ok(field in record, `fsSnapshot record must expose ${field}`);
  }
  assert.ok(store.activeFsFiles.every((file) => 'content' in file && 'workspaceId' in file), 'activeFsFiles must expose full FileRecords');

  const fileReceipt = store.downloadFile('/alpha.txt', 'archive-ws');
  assert.strictEqual(typeof fileReceipt.filename, 'string');
  assert.strictEqual(typeof fileReceipt.size, 'number');
  assert.ok(!('totalBytes' in fileReceipt), 'downloadFile must not synthesize fictional sizes');

  const archiveReceipt = await store.downloadWorkspaceArchive('archive-ws');
  assert.ok(!('archiveName' in archiveReceipt), 'ArchiveDownloadReceipt must not expose archiveName');
  assert.ok(!('fileCount' in archiveReceipt), 'ArchiveDownloadReceipt must not expose fileCount');
  assert.ok(!('totalBytes' in archiveReceipt), 'ArchiveDownloadReceipt must not expose totalBytes');
  assert.ok('filesCount' in archiveReceipt, 'ArchiveDownloadReceipt must expose the runtime filesCount');
  if (archiveReceipt.success) {
    assert.strictEqual(typeof archiveReceipt.filename, 'string');
    assert.strictEqual(typeof archiveReceipt.format, 'string');
    assert.strictEqual(archiveReceipt.filesCount, 1);
  } else {
    assert.strictEqual(typeof archiveReceipt.error, 'string', 'Archive failures carry the runtime error field');
  }

  store.destroy();
});

// ============================================================================
// 24. Vault-driven credential rotation skips preset-bound agents (MOD-20 OPEN-2)
// ============================================================================

test('24. Vault Set-Active + rebindProviderCredentials leave preset-bound composition-root agents untouched (MOD-20 OPEN-2)', async () => {
  const store = getSandboxStore();
  const vault = store.getCredentialVault();
  const catalog = store.getPresetCatalog();
  const previousActivePresetId = catalog.createPresetSourcePort().getDefaultPresetId();

  const customPreset = {
    id: 'preset_custom_vault24',
    name: 'Vault Probe Preset',
    isCustom: true,
    modelConfig: { providerId: 'custom', url: 'https://api.example.test/v1', modelId: 'vault-24-model' }
  };
  catalog.savePreset(customPreset);
  catalog.setActivePresetId(customPreset.id);

  const bogus = vault.addCredential({ providerId: 'custom', label: 'Bogus 282cb2b', apiKey: 'bogus-282cb2b-key' });
  const good = vault.addCredential({ providerId: 'custom', label: 'Good 282cb2b', apiKey: 'good-282cb2b-key' });
  vault.setActiveCredential('custom', bogus.id);

  const probeId = 'vault-rebind-probe-282cb2b';

  try {
    // The store-owned runtime resolves a preset binding for every launch
    // (W3-B3), so no legacy/unbound agent can exist on the composition root.
    await store.launchAgent({ id: probeId, name: 'Vault Rebind Probe', presetId: customPreset.id });

    const before = store.agents.find(a => a.id === probeId);
    assert.ok(before, 'The probe agent must launch');
    assert.strictEqual(before.config.presetId, customPreset.id, 'The probe must stay preset-bound');
    assert.strictEqual(before.config.modelConfig.keyId, bogus.id, 'Launch materializes the provider-active credential');

    // Surviving vault-driven path (settings modal): rotate the active
    // credential, then run the explicit rebind walk for legacy/unbound agents.
    // Preset-bound agents must be skipped — rotation materializes at the next
    // turn start through the preset resolver.
    vault.setActiveCredential('custom', good.id);
    assert.strictEqual(
      store.rebindProviderCredentials('custom', good.id),
      0,
      'The composition root hosts no legacy/unbound agents to re-pin'
    );
    assert.strictEqual(store.rebindProviderCredentials('custom', null), 0, 'Unpin walks are equally safe no-ops');

    const after = store.agents.find(a => a.id === probeId);
    assert.strictEqual(after.config.presetId, customPreset.id, 'Binding must survive the vault rotation');
    assert.strictEqual(
      after.config.modelConfig.keyId,
      bogus.id,
      'The rebind walk must not rewrite a preset-bound agent (credential rotation materializes at the next turn start)'
    );
    assert.deepStrictEqual(
      { ...after.config.modelConfig },
      { ...before.config.modelConfig },
      'Preset-bound modelConfig must not be rewritten by the walk'
    );
  } finally {
    if (store.agents.some(a => a.id === probeId)) {
      store.killAgent(probeId, 'test cleanup');
      store.purgeAgent(probeId);
    }
    vault.deleteCredential(bogus.id);
    vault.deleteCredential(good.id);
    catalog.deletePreset(customPreset.id);
    catalog.setActivePresetId(previousActivePresetId);
  }
});

// ============================================================================
// 25. Wave I (ticket c02d0b9): Store operator authority (host principal)
// ============================================================================

test('25. Operator authority: the store acts through the runtime host operator principal with zero agents', async () => {
  // Zero-agent store (no director bootstrapped): the store still runs operator
  // actions under the runtime's host operator principal (Wave I, ticket
  // c02d0b9), so lifecycle, authority grants, and scheduler visibility all work
  // without any agent existing.
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });
  assert.strictEqual(store.agents.length, 0, 'fixture: no director and no other agent');
  await store.launchAgent({ id: 'op-victim', name: 'Op Victim', model: createMockModel() });
  await store.launchAgent({ id: 'op-timer', name: 'Op Timer', model: createMockModel() });

  // The store's principal is the exact runtime-minted host reference, not an
  // agent descriptor: caller-declared privilege flags cannot substitute for it.
  const operatorPrincipal = runtime.getOperatorPrincipal();
  assert.strictEqual(operatorPrincipal.kind, 'internal', 'the runtime mints an opaque host operator principal');
  assert.strictEqual(store.agents.some((agent) => agent.id === 'director'), false, 'no director is needed');

  const granted = store.updateAgentConfig('op-victim', { privileged: true });
  assert.strictEqual(granted.config.privileged, true, 'the settings path is an operator-mediated authority grant');

  const privileged = await store.launchAgent({ id: 'op-priv', name: 'Op Priv', privileged: true, allowedTools: ['*'], model: createMockModel() });
  assert.strictEqual(privileged.config.privileged, true, 'the launcher toggle is a validated operator grant request');

  const receipt = await store.scheduleTimer({
    durationSeconds: 30,
    prompt: 'Operator timer',
    timerCondition: 'never',
    agentId: 'op-timer'
  });
  assert.ok(receipt.success);
  assert.ok(
    store.scheduledTimers.some(t => t.timerId === receipt.timerId),
    'the operator principal sees every agent timer, not only its own'
  );
  assert.strictEqual(store.cancelScheduledTimer(receipt.timerId, 'Operator cancel'), true);

  const killed = store.killAgent('op-victim', 'Operator kill');
  assert.strictEqual(killed, true, 'operator kill succeeds through the host operator principal');
  assert.strictEqual(store.recycleBinCount, 1);

  store.destroy();
  runtime.destroy();
});

// ============================================================================
// 26. MOD-20 composition root: catalog adapter, derived modelConfig, pointer
// ============================================================================

test('26. MOD-20 composition root: catalog adapter round-trip and derived modelConfig (OPEN-4)', () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const catalog = store.getPresetCatalog();
  assert.ok(catalog && typeof catalog.savePreset === 'function', 'Store must expose the owned preset catalog');

  // Seed catalog + derived getter (credential-free, active preset).
  const seeds = catalog.listPresets();
  assert.ok(seeds.length >= 5, 'Catalog must expose the official seed presets');
  assert.ok(seeds.every(p => !('keyId' in p.modelConfig)), 'Catalog entries must stay credential-free');

  const initial = store.modelConfig;
  assert.ok(initial && initial.providerId && initial.modelId, 'Derived modelConfig must resolve the active preset');
  const activeId = catalog.createPresetSourcePort().getDefaultPresetId();
  assert.deepStrictEqual(initial, catalog.getPreset(activeId).modelConfig, 'Derived modelConfig must equal the active preset config');
  assert.strictEqual(Object.isFrozen(initial), true, 'Derived preset config must stay frozen (read-only projection)');

  // Catalog CRUD through the management API drives the derived getter.
  const custom = {
    id: 'preset_custom_store26',
    name: 'Store 26',
    isCustom: true,
    modelConfig: { providerId: 'custom', modelId: 'store-26-model', temperature: 0.4 }
  };
  catalog.savePreset(custom);
  catalog.setActivePresetId(custom.id);
  assert.strictEqual(store.modelConfig.modelId, 'store-26-model', 'Derived modelConfig must follow the active pointer');
  catalog.savePreset({ ...custom, modelConfig: { ...custom.modelConfig, temperature: 0.9 } });
  assert.strictEqual(store.modelConfig.temperature, 0.9, 'Derived modelConfig must reflect catalog updates immediately');

  // Snapshot adapter: only custom entries + the pointer persist.
  const snapshot = store.serialize();
  assert.strictEqual(snapshot.activePresetId, custom.id, 'Active pointer must serialize into the snapshot');
  assert.deepStrictEqual(snapshot.customPresets.map(p => p.id), [custom.id], 'Only custom entries must serialize');
  assert.ok(snapshot.customPresets.every(p => p.isCustom), 'Official seed presets must not be duplicated into the snapshot');
  assert.strictEqual(store.saveToStorage(), true);

  // A fresh auto-hydrating store seeds its catalog from the snapshot.
  const reloaded = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  const reloadedCatalog = reloaded.getPresetCatalog();
  const restored = reloadedCatalog.getPreset(custom.id);
  assert.ok(restored, 'Custom preset must round-trip through the snapshot adapter');
  assert.strictEqual(restored.modelConfig.modelId, 'store-26-model');
  assert.strictEqual(restored.modelConfig.temperature, 0.9);
  assert.strictEqual(
    reloadedCatalog.createPresetSourcePort().getDefaultPresetId(),
    custom.id,
    'Active pointer must round-trip through the snapshot'
  );
  assert.strictEqual(reloaded.modelConfig.modelId, 'store-26-model', 'Derived getter must resolve the restored pointer');

  reloaded.destroy();
  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 27. MOD-20 hydration reconciliation + fingerprint heal
// ============================================================================

test('27. MOD-20 hydration reconciles the catalog and fingerprint-heals snapshot bindings', async () => {
  sharedLocalStorage.clear();

  const custom = {
    id: 'preset_custom_store27',
    name: 'Store 27',
    isCustom: true,
    modelConfig: { providerId: 'custom', url: 'https://api.example.test/v1', modelId: 'store-27-model', temperature: 0.2 }
  };
  const unknownId = 'preset_custom_missing27';
  const now = Date.now();
  const telemetry = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turnCount: 0,
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
    terminalStops: 0,
    injectedDeliveries: 0,
    precallCount: 0,
    lastSentContext: []
  };
  const agentEntry = (id, config) => ({
    id,
    name: id,
    config: { id, ...config },
    turnCount: 0,
    telemetry,
    createdAt: now,
    updatedAt: now,
    lastSummary: null,
    lastError: null,
    pendingPrecalls: [],
    redoStack: [],
    history: []
  });

  const snapshot = {
    version: '1.0.0',
    timestamp: now,
    activeAgentId: 'mod20-fingerprint',
    activeFsWorkspace: 'global',
    activeTab: 'chat',
    agents: [
      // Legacy entry: no presetId, fingerprint matches the custom preset.
      agentEntry('mod20-fingerprint', { modelConfig: { providerId: 'custom', url: 'https://api.example.test/v1', modelId: 'store-27-model', keyId: 'canonical_custom' } }),
      // Unknown preset id with a matching fingerprint: the fingerprint wins.
      agentEntry('mod20-stale', { presetId: unknownId, modelConfig: { providerId: 'deepseek', modelId: 'deepseek-flash', keyId: 'canonical_deepseek' } }),
      // Unknown preset id without a fingerprint match: heals to the catalog default.
      agentEntry('mod20-unmatched', { presetId: unknownId, modelConfig: { providerId: 'custom', url: 'https://api.example.test/v1', modelId: 'store-27-unmatched', keyId: 'canonical_custom' } }),
      // Already valid binding.
      agentEntry('mod20-valid', { presetId: custom.id, modelConfig: { providerId: 'custom', url: 'https://api.example.test/v1', modelId: 'store-27-model', keyId: 'canonical_custom' } })
    ],
    recycleBin: [
      {
        ...agentEntry('mod20-recycled', { modelConfig: { providerId: 'custom', url: 'https://api.example.test/v1', modelId: 'store-27-model', keyId: 'canonical_custom' } }),
        recycledAt: new Date(now).toISOString(),
        recycleReason: 'Reconciled for coverage'
      }
    ],
    virtualFs: {},
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {},
    activePresetId: custom.id,
    customPresets: [custom]
  };
  // Drain any pending autosave left by earlier tests before seeding, so the
  // deferred no-write checks observe only this store's hydration path.
  drainPendingAutosaves();
  sharedLocalStorage.clear();
  const seededRaw = JSON.stringify(snapshot);
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', seededRaw);

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  const catalog = store.getPresetCatalog();
  const defaultId = catalog.createPresetSourcePort().getDefaultPresetId();

  // Reconciled catalog + active pointer.
  assert.ok(catalog.getPreset(custom.id), 'Persisted custom preset must be reconciled into the catalog');
  assert.strictEqual(store.modelConfig.modelId, 'store-27-model', 'Persisted active pointer must resolve through the derived getter');

  // Fingerprint heal: active + recycled entries, valid entry untouched.
  assert.strictEqual(store.agents.length, 4);
  assert.strictEqual(store.recycleBin.length, 1);
  assert.strictEqual(
    store.agents.find(a => a.id === 'mod20-fingerprint').config.presetId,
    custom.id,
    'Missing presetId must fingerprint-match the catalog entry'
  );
  assert.strictEqual(
    store.agents.find(a => a.id === 'mod20-stale').config.presetId,
    'deepseek',
    'Unknown presetId must fingerprint-match the catalog before falling back to the default'
  );
  assert.strictEqual(
    store.agents.find(a => a.id === 'mod20-unmatched').config.presetId,
    defaultId,
    'Unknown presetId without a fingerprint match must heal to the catalog default'
  );
  assert.strictEqual(store.agents.find(a => a.id === 'mod20-valid').config.presetId, custom.id);
  assert.strictEqual(
    store.recycleBin.find(a => a.id === 'mod20-recycled').config.presetId,
    custom.id,
    'Recycled agent fingerprints must heal too'
  );

  // Heal is in-memory only: the persisted snapshot is not rewritten on load.
  const rawAfterLoad = JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'));
  assert.strictEqual(
    rawAfterLoad.agents.find(a => a.id === 'mod20-fingerprint').config.presetId,
    undefined,
    'Hydration must not rewrite persisted bindings'
  );
  assert.strictEqual(rawAfterLoad.agents.find(a => a.id === 'mod20-stale').config.presetId, unknownId);

  // F2 regression: the check above is synchronous; the load-time reconciliation
  // used to schedule the 300ms debounced save, which then rewrote the snapshot
  // (injecting `activePresetId` and healed `presetId`s). Wait past the debounce
  // window and require the raw bytes to be byte-identical.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(
    sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'),
    seededRaw,
    'Successful hydration must not schedule a deferred snapshot rewrite (byte-identical storage)'
  );
  assert.deepStrictEqual(
    JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1')),
    JSON.parse(seededRaw),
    'Successful hydration must not inject activePresetId or healed presetIds'
  );

  // The next hydrate with a snapshot that omits the custom preset reconciles it away.
  const pruned = { ...snapshot, activePresetId: undefined, customPresets: [] };
  const prunedRaw = JSON.stringify(pruned);
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', prunedRaw);
  assert.strictEqual(store.hydrateFromStorage(), true, 'Preset-pruned snapshot must still hydrate');
  assert.strictEqual(catalog.getPreset(custom.id), null, 'Custom presets absent from the snapshot must be deleted');
  assert.strictEqual(store.modelConfig.providerId, 'deepseek', 'Missing pointer must fall back to the master default');

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(
    sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'),
    prunedRaw,
    'Reconcile-driven deletions must not schedule a deferred snapshot rewrite'
  );

  // Positive control: once hydration returns, ordinary mutations must still
  // flow through the debounced autosave (the guard clears in `finally`).
  store.setActiveTab('filesystem');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(
    JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1')).activeTab,
    'filesystem',
    'Post-hydration mutations must still reach storage through the debounced autosave'
  );

  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 28. MOD-20 factory reset clears the snapshot-backed preset topology
// ============================================================================

test('28. factoryReset clears the snapshot-backed preset topology', () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const catalog = store.getPresetCatalog();
  const custom = {
    id: 'preset_custom_store28',
    name: 'Store 28',
    isCustom: true,
    modelConfig: { providerId: 'custom', modelId: 'store-28-model' }
  };
  catalog.savePreset(custom);
  catalog.setActivePresetId(custom.id);
  assert.strictEqual(store.modelConfig.modelId, 'store-28-model');
  assert.strictEqual(store.saveToStorage(), true);

  store.factoryReset();

  assert.strictEqual(store.getPresetCatalog().getPreset(custom.id), null, 'Factory reset must drop custom presets');
  assert.strictEqual(store.modelConfig.providerId, 'deepseek', 'Active pointer must fall back to the master default');
  assert.strictEqual(store.serialize().customPresets, undefined, 'No custom presets may serialize after factory reset');
  assert.strictEqual(
    store.serialize().activePresetId,
    store.getPresetCatalog().createPresetSourcePort().getDefaultPresetId(),
    'The reset pointer must persist as the catalog default'
  );

  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 29. MOD-20: a caller-injected runtime is never re-wired
// ============================================================================

test('29. A caller-injected runtime is never re-wired with the store preset source', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });
  const store = new SandboxStore({
    virtualFs: vfs,
    messagingBus: bus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  await store.launchAgent({
    id: 'injected-unbound',
    name: 'Injected Unbound',
    model: createMockModel(),
    modelConfig: {
      providerId: 'custom',
      url: 'https://api.example.test/v1',
      modelId: 'injected-model',
      keyId: 'canonical_custom'
    }
  });

  const agent = runtime.getAgent('injected-unbound');
  assert.ok(agent, 'Agent must launch on the injected runtime');
  assert.strictEqual(agent.modelConfig.modelId, 'injected-model', 'Injected runtime must keep the legacy explicit model config');
  assert.strictEqual(agent.modelConfig.providerId, 'custom');
  assert.strictEqual(agent.config.presetId, undefined, 'No preset binding is invented for an injected runtime');

  store.destroy();
});

// ============================================================================
// 30. Wave A realm composition root: registry CRUD, projection, round-trip
// ============================================================================

test('30. Wave A realm composition root: registry CRUD, reactive projection, snapshot round-trip', () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const registry = store.getRealmRegistry();
  assert.ok(registry && typeof registry.listRealms === 'function', 'Store must expose the owned realm registry');
  assert.strictEqual(store.getRealm('realm_missing_30'), null);

  // Wave R (ticket 56ba4b9): the seeded Generic default realm is the only
  // record a fresh store carries, and the UI helper mirrors its fixed id.
  assert.strictEqual(UI_GENERIC_REALM_ID, GENERIC_REALM_ID, 'the UI helper mirrors the engine-side Generic id');
  assert.deepStrictEqual(store.realms.map((realm) => realm.id), [GENERIC_REALM_ID]);
  assert.strictEqual(store.getRealm(GENERIC_REALM_ID).name, 'Generic');

  // Create through the store CRUD surface.
  const created = store.createRealm({
    id: 'realm_store30',
    name: 'Store 30',
    description: 'round-trip probe',
    color: '#102030'
  });
  assert.strictEqual(created.id, 'realm_store30');
  assert.ok(Object.isFrozen(created), 'Created realm records must be frozen');
  assert.strictEqual(typeof created.createdAt, 'number');
  assert.deepStrictEqual(store.realms.map((realm) => realm.id), [GENERIC_REALM_ID, 'realm_store30']);
  assert.strictEqual(store.getRealm('realm_store30').name, 'Store 30');

  // Generated ids are `realm_*` and registry-unique.
  const generated = store.createRealm({ name: 'Generated Realm' });
  assert.match(generated.id, /^realm_/);
  assert.notStrictEqual(generated.id, created.id);
  assert.strictEqual(store.realms.length, 3);

  // Invalid drafts reject with the store error code; duplicates reject in the registry.
  for (const draft of [null, undefined, {}, { name: '' }, { name: '   ' }, { name: 'X', color: 7 }]) {
    assert.throws(
      () => store.createRealm(draft),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS,
      `must reject ${JSON.stringify(draft)}`
    );
  }
  assert.throws(() => store.createRealm({ id: 'realm_store30', name: 'Duplicate' }), /duplicate/);
  assert.strictEqual(store.realms.length, 3, 'Rejected and duplicate creates must not mutate the projection');

  // Update + delete.
  store.updateRealm('realm_store30', { name: 'Store 30 Renamed', description: null });
  assert.strictEqual(store.realms.find((realm) => realm.id === 'realm_store30').name, 'Store 30 Renamed');
  assert.ok(!('description' in store.getRealm('realm_store30')), 'null must clear the description');
  assert.strictEqual(store.deleteRealm(generated.id), true);
  assert.strictEqual(store.deleteRealm('realm_missing_30'), false);
  assert.deepStrictEqual(store.realms.map((realm) => realm.id), [GENERIC_REALM_ID, 'realm_store30']);

  // Export/import round-trip through LocalStorage.
  const snapshot = store.serialize();
  assert.deepStrictEqual(snapshot.realms.map((realm) => realm.id), [GENERIC_REALM_ID, 'realm_store30']);
  assert.strictEqual(store.saveToStorage(), true);

  const reloaded = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  assert.deepStrictEqual(
    reloaded.realms.map((realm) => realm.id),
    [GENERIC_REALM_ID, 'realm_store30'],
    'Realm records must hydrate into the reactive projection'
  );
  const restored = reloaded.getRealm('realm_store30');
  assert.strictEqual(restored.name, 'Store 30 Renamed');
  assert.strictEqual(restored.color, '#102030');
  assert.strictEqual(restored.createdAt, created.createdAt, 'createdAt must round-trip');
  assert.strictEqual(reloaded.serialize().realms.find((realm) => realm.id === 'realm_store30').name, 'Store 30 Renamed');

  // Snapshot authority: a realm absent from the persisted bytes is pruned on
  // re-hydration, while the protected Generic default is always re-seeded.
  const inMemoryOnly = reloaded.createRealm({ id: 'realm_store30_temp', name: 'Temp Realm' });
  assert.ok(reloaded.getRealm(inMemoryOnly.id));
  assert.strictEqual(reloaded.hydrateFromStorage(), true);
  assert.strictEqual(reloaded.getRealm(inMemoryOnly.id), null, 'Snapshot-pruned realms must be removed on hydration');
  assert.deepStrictEqual(reloaded.realms.map((realm) => realm.id), [GENERIC_REALM_ID, 'realm_store30']);

  reloaded.destroy();
  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 31. Wave A realm back-compat: legacy snapshots load with no realms
// ============================================================================

test('31. Legacy snapshots without realms hydrate the Generic default in memory and leave persisted bytes untouched', async () => {
  const legacySnapshot = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: null,
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [],
    recycleBin: [],
    virtualFs: {},
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };

  drainPendingAutosaves();
  sharedLocalStorage.clear();
  const seededRaw = JSON.stringify(legacySnapshot);
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', seededRaw);

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });

  assert.deepStrictEqual(
    store.realms.map((realm) => realm.id),
    [GENERIC_REALM_ID],
    'Wave R: a legacy snapshot still hydrates the seeded Generic default in memory'
  );
  assert.strictEqual(store.getRealm(GENERIC_REALM_ID).name, 'Generic');
  assert.strictEqual(store.getRealm('realm_any'), null);
  assert.deepStrictEqual(
    store.serialize().realms.map((realm) => realm.id),
    [GENERIC_REALM_ID],
    'the in-memory Generic record reaches the next serialized snapshot'
  );

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.strictEqual(
    sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'),
    seededRaw,
    'Legacy hydration must not rewrite persisted bytes'
  );

  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 32. Wave A H1: reload capability heal
// ============================================================================

test('32. Hydration capability heal restores persisted tool grants and never snapshot privilege/parentage', async () => {
  drainPendingAutosaves();
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await store.ensureDirector();
  await store.launchAgent({
    id: 'heal_probe',
    name: 'Heal Probe',
    allowedTools: ['read_file', 'write_file'],
    model: createMockModel()
  });
  await store.launchAgent({
    id: 'heal_wildcard_probe',
    name: 'Heal Wildcard Probe',
    allowedTools: ['*'],
    model: createMockModel()
  });
  assert.strictEqual(store.saveToStorage(), true, 'the probe session must persist');

  // Tamper the persisted bytes: the legitimate grants stay, while a privilege
  // claim and forged parentage that hydration must never trust are injected.
  const persistedKey = 'ai_storyteller_sandbox_state_v1';
  const raw = JSON.parse(sharedLocalStorage.getItem(persistedKey));
  const probeEntry = raw.agents.find((entry) => entry.id === 'heal_probe');
  probeEntry.config.privileged = true;
  probeEntry.config.spawnedBy = 'director';
  probeEntry.config.creatorId = 'director';
  const tamperedRaw = JSON.stringify(raw);
  sharedLocalStorage.setItem(persistedKey, tamperedRaw);

  // Reload through an injected runtime so the restored entities are inspectable.
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const reloaded = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: true });

  assert.strictEqual(reloaded.agents.length, 3, 'director plus both probes must restore');
  const agent = runtime.getAgent('heal_probe');
  assert.ok(agent, 'the probed agent must restore into the runtime');

  // H1: tool grants are restored through the operator-context heal pass.
  assert.deepStrictEqual(
    [...agent.config.allowedTools],
    ['read_file', 'write_file'],
    'H1 must restore the persisted tool grant'
  );
  assert.deepStrictEqual(
    [...runtime.getAgent('heal_wildcard_probe').config.allowedTools],
    ['*'],
    'the operator-context heal restores an operator-granted wildcard capability'
  );
  assert.deepStrictEqual(
    [...reloaded.agents.find((snapshot) => snapshot.id === 'heal_probe').config.allowedTools],
    ['read_file', 'write_file'],
    'the reactive projection must expose the healed grant'
  );

  // Snapshot privilege and parentage are never restored.
  assert.notStrictEqual(agent.privileged, true, 'a tampered privilege claim must not survive hydration');
  assert.strictEqual(agent.config.privileged, undefined, 'no privilege field may be re-granted from the snapshot');
  assert.strictEqual(agent.spawnedBy, null, 'snapshot parentage is never restored');
  assert.strictEqual(agent.creatorId, null, 'snapshot parentage is never restored');
  const identity = runtime.createAgentIdentityPort().getAgentIdentity('heal_probe');
  assert.ok(identity, 'the healed agent must expose an identity projection');
  assert.strictEqual(identity.privileged, false, 'the healed agent must stay non-privileged');
  assert.strictEqual(identity.authority.allow.has('*'), false, 'no wildcard authority may leak from the snapshot');
  assert.strictEqual(
    identity.authority.allow.has('@lifecycle:authority'),
    false,
    'no lifecycle authority may leak from the snapshot'
  );

  // Observable + idempotent: a second pass reports `unchanged` and mutates nothing.
  const report = reloaded.capabilityHealReport;
  assert.ok(report, 'the heal pass must publish an observable report');
  assert.strictEqual(
    report.restored,
    3,
    'both probes and the (ordinary) director restore their persisted grants under the host operator principal'
  );
  const probeOutcome = report.entries.find((entry) => entry.agentId === 'heal_probe');
  assert.strictEqual(probeOutcome.outcome, 'restored');
  assert.deepStrictEqual([...probeOutcome.allowedTools], ['read_file', 'write_file']);
  const directorOutcome = report.entries.find((entry) => entry.agentId === 'director');
  assert.strictEqual(directorOutcome.outcome, 'restored', 'the director is an ordinary agent: its persisted grant heals too');
  assert.deepStrictEqual([...directorOutcome.allowedTools], ['*']);
  assert.ok(report.at > 0);

  const second = reloaded.healRestoredCapabilities();
  assert.ok(second, 'the manual heal pass must return its report');
  const secondOutcome = second.entries.find((entry) => entry.agentId === 'heal_probe');
  assert.strictEqual(secondOutcome.outcome, 'unchanged', 'the heal pass must be idempotent');
  assert.strictEqual(second.restored, 0);
  assert.deepStrictEqual([...agent.config.allowedTools], ['read_file', 'write_file']);

  // Hydration stays storage-read-only: healing is in-memory only.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.strictEqual(
    sharedLocalStorage.getItem(persistedKey),
    tamperedRaw,
    'the heal pass must not rewrite the persisted bytes during hydration'
  );

  reloaded.destroy();
  store.destroy();
  sharedLocalStorage.clear();
});

test('33. deleting a realm with active or recycled members refuses by default and leaves everything intact', async () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await store.ensureDirector();
  store.createRealm({ id: 'realm_del_33', name: 'Delete Me', color: '#123456' });

  await store.launchAgent({ id: 'del_member', name: 'Member', realmId: 'realm_del_33', allowedTools: ['read_file'], model: createMockModel() });
  await store.launchAgent({ id: 'del_outsider', name: 'Outsider', allowedTools: ['read_file'], model: createMockModel() });
  await store.launchAgent({ id: 'del_recycled', name: 'Recycled Member', realmId: 'realm_del_33', allowedTools: ['read_file'], model: createMockModel() });
  store.killAgent('del_recycled', 'fixture recycle');

  assert.strictEqual(store.agents.find((agent) => agent.id === 'del_member').config.realmId, 'realm_del_33');
  assert.strictEqual(store.recycleBin.find((agent) => agent.id === 'del_recycled').config.realmId, 'realm_del_33');

  // Wave R (ticket 56ba4b9): deletion is refused while the realm has active OR
  // recycled members; membership never moves, so nothing is ungrouped.
  const refusal = (() => {
    try {
      store.deleteRealm('realm_del_33');
      return null;
    } catch (err) {
      return err;
    }
  })();
  assert.ok(refusal, 'a member-bearing delete must refuse');
  assert.strictEqual(
    refusal.code,
    SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_NOT_EMPTY,
    'the refusal carries the typed not-empty code'
  );
  assert.match(refusal.message, /terminate or delete members first/i, 'the refusal copy names the required action');
  assert.strictEqual(refusal.realmId, 'realm_del_33');
  assert.strictEqual(refusal.activeMembers, 1);
  assert.strictEqual(refusal.recycledMembers, 1);

  assert.ok(store.getRealm('realm_del_33'), 'a refused delete leaves the record intact');
  assert.strictEqual(
    store.agents.find((agent) => agent.id === 'del_member').config.realmId,
    'realm_del_33',
    'a refused delete leaves active membership intact'
  );
  assert.strictEqual(
    store.recycleBin.find((agent) => agent.id === 'del_recycled').config.realmId,
    'realm_del_33',
    'a refused delete leaves recycled membership intact'
  );
  assert.strictEqual(
    store.agents.find((agent) => agent.id === 'del_outsider').config.realmId,
    GENERIC_REALM_ID,
    'non-members keep their own (Generic) membership'
  );

  assert.strictEqual(store.deleteRealm('realm_missing_33'), false, 'an unknown id stays a false no-op');

  store.destroy();
  sharedLocalStorage.clear();
});

test('34. recursive deletion purges active and recycled members under the operator principal and leaves zero residue', async () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await store.ensureDirector();
  store.createRealm({ id: 'realm_del_34', name: 'Recursive Delete' });

  await store.launchAgent({ id: 'rec_member', name: 'Active Member', realmId: 'realm_del_34', allowedTools: ['read_file'], model: createMockModel() });
  await store.launchAgent({ id: 'rec_recycled', name: 'Recycled Member', realmId: 'realm_del_34', allowedTools: ['read_file'], model: createMockModel() });
  await store.launchAgent({ id: 'rec_outsider', name: 'Outsider', allowedTools: ['read_file'], model: createMockModel() });
  store.killAgent('rec_recycled', 'fixture recycle');

  assert.strictEqual(store.deleteRealm('realm_del_34', { recursive: true }), true);
  assert.strictEqual(store.getRealm('realm_del_34'), null, 'the record is removed after the members are purged');
  assert.strictEqual(store.agents.find((agent) => agent.id === 'rec_member'), undefined, 'an active member is purged, not recycled');
  assert.strictEqual(
    store.recycleBin.find((agent) => agent.id === 'rec_recycled'),
    undefined,
    'a recycled member is emptied from the recycle bin'
  );
  assert.strictEqual(
    store.recycleBin.filter((agent) => agent.config?.realmId === 'realm_del_34').length,
    0,
    'zero recycle residue for the deleted realm'
  );
  assert.strictEqual(store.agents.find((agent) => agent.id === 'rec_outsider').config.realmId, GENERIC_REALM_ID, 'non-members are untouched');

  const snapshot = store.serialize();
  assert.strictEqual(
    snapshot.agents.some((agent) => agent.config?.realmId === 'realm_del_34') || (snapshot.recycleBin || []).some((agent) => agent.config?.realmId === 'realm_del_34'),
    false,
    'no persisted record keeps the deleted realm membership'
  );

  // Empty realms delete without the recursive option (and without any members).
  store.createRealm({ id: 'realm_empty_34', name: 'Empty' });
  assert.strictEqual(store.deleteRealm('realm_empty_34'), true);

  store.destroy();
  sharedLocalStorage.clear();
});

test('35. recursive deletion works with zero agents under the runtime host operator principal', async () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await store.launchAgent({ id: 'orphan_member', name: 'Orphan', realmId: 'realm_noop_35', allowedTools: ['read_file'], model: createMockModel() });
  store.createRealm({ id: 'realm_noop_35', name: 'No Director' });
  assert.strictEqual(store.agents.find((agent) => agent.id === 'orphan_member').config.realmId, 'realm_noop_35');
  assert.strictEqual(store.agents.some((agent) => agent.id === 'director'), false, 'fixture: no director exists');

  // Wave I (ticket c02d0b9): the host operator principal exists with zero
  // agents, so the recursive purge needs no bootstrapped director.
  assert.strictEqual(
    store.deleteRealm('realm_noop_35', { recursive: true }),
    true,
    'the operator principal purges the members and removes the record'
  );
  assert.strictEqual(store.getRealm('realm_noop_35'), null, 'the record is removed');
  assert.strictEqual(store.agents.find((agent) => agent.id === 'orphan_member'), undefined, 'the member is purged');

  store.destroy();
  sharedLocalStorage.clear();
});

test('36. listRealmTemplates exposes the frozen baked launch catalog to the launcher UI', () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const templates = store.listRealmTemplates();

  assert.ok(Array.isArray(templates), 'the accessor returns a list');
  assert.ok(templates.length >= 1, 'the baked catalog is never empty');
  assert.ok(Object.isFrozen(templates), 'the returned list is frozen');
  assert.ok(templates.every((template) => Object.isFrozen(template)), 'every template is frozen');
  assert.ok(templates.includes(DEMO_TEMPLATE), 'the baked demo fixture is registered for launch');
  assert.deepStrictEqual(
    templates.map((template) => template.id),
    BAKED_TEMPLATE_BUNDLES.map((bundle) => bundle.template.id),
    'the picker exposes exactly the baked catalog: demo fixture first, then the embedded bundles'
  );
  assert.strictEqual(
    new Set(templates.map((template) => template.id)).size,
    templates.length,
    'template ids stay unique'
  );
  assert.throws(
    () => { templates.push(templates[0]); },
    TypeError,
    'callers cannot mutate the catalog through the accessor'
  );

  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 37. Wave R (ticket 56ba4b9): the seeded Generic default realm
// ============================================================================

test('37. the Generic realm is seeded, renamable, non-deletable, and re-seeded after an in-memory reset', async () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const generic = store.getRealm(GENERIC_REALM_ID);
  assert.ok(generic, 'every store seeds the fixed Generic default realm at init');
  assert.strictEqual(generic.name, 'Generic');
  assert.strictEqual(store.realms[0].id, GENERIC_REALM_ID, 'Generic is the first projected registry record');

  // Renamable (the record metadata is operator-editable) ...
  const renamed = store.updateRealm(GENERIC_REALM_ID, { name: 'General', color: '#aabbcc' });
  assert.strictEqual(renamed.name, 'General');
  assert.strictEqual(store.getRealm(GENERIC_REALM_ID).color, '#aabbcc');

  // ... but never deletable, with or without the recursive override.
  await store.ensureDirector();
  for (const options of [undefined, { recursive: true }]) {
    assert.throws(
      () => store.deleteRealm(GENERIC_REALM_ID, options),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_PROTECTED,
      'Generic must be refused even under the recursive override'
    );
  }
  assert.ok(store.getRealm(GENERIC_REALM_ID), 'a refused Generic delete leaves the record intact');

  // Wave R hardening (ticket 0fe25fd): Generic is undeletable through EVERY
  // public store surface, the raw registry exposed by getRealmRegistry()
  // included. A refused raw removal is a false no-op: record intact, no
  // change event, projection unchanged.
  const rawRegistry = store.getRealmRegistry();
  const rawEvents = [];
  rawRegistry.subscribe((event) => rawEvents.push(event));
  assert.strictEqual(
    rawRegistry.removeRealm(GENERIC_REALM_ID),
    false,
    'the raw registry surface must refuse Generic removal'
  );
  assert.ok(store.getRealm(GENERIC_REALM_ID), 'a refused raw removal leaves the record intact');
  assert.deepStrictEqual(rawEvents, [], 'a refused raw removal never emits a change event');
  assert.deepStrictEqual(
    store.realms.map((realm) => realm.id),
    [GENERIC_REALM_ID],
    'a refused raw removal leaves the reactive projection unchanged'
  );

  // The management contract is intact for every other Realm: a normal record
  // stays removable through the same raw surface.
  store.createRealm({ id: 'realm_raw_37', name: 'Raw Removable' });
  assert.strictEqual(rawRegistry.removeRealm('realm_raw_37'), true, 'non-protected Realms stay removable');
  assert.strictEqual(store.getRealm('realm_raw_37'), null);
  assert.deepStrictEqual(store.realms.map((realm) => realm.id), [GENERIC_REALM_ID]);

  // A launch after the refused raw removal must bind to a REGISTERED Realm,
  // never to a dangling id left behind by the removal.
  await store.launchAgent({
    id: 'g_orphan_37',
    name: 'Orphan Probe',
    allowedTools: ['read_file'],
    model: createMockModel()
  });
  const orphanMembership = store.agents.find((agent) => agent.id === 'g_orphan_37').config.realmId;
  assert.strictEqual(orphanMembership, GENERIC_REALM_ID, 'the launch resolves the seeded Generic default');
  assert.ok(store.getRealm(orphanMembership), 'a launch must never bind to an unregistered Realm');

  // An in-memory reset re-seeds the default (a factory reset returns to a
  // fresh topology, never a store without a realm).
  store.reset();
  assert.deepStrictEqual(store.realms.map((realm) => realm.id), [GENERIC_REALM_ID]);
  assert.strictEqual(store.getRealm(GENERIC_REALM_ID).name, 'Generic', 'the reset default is the pristine record');

  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 38. Wave R: launch composition + immutable membership (store operator path)
// ============================================================================

test('38. launches resolve the Generic default (director excepted) and membership never moves, store operator included', async () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await store.ensureDirector();
  store.createRealm({ id: 'realm_move_38', name: 'Move Target' });

  // Default assignment: no explicit realm ⇒ the seeded Generic default.
  await store.launchAgent({ id: 'defaulted_38', name: 'Defaulted', allowedTools: ['read_file'], model: createMockModel() });
  assert.strictEqual(store.agents.find((agent) => agent.id === 'defaulted_38').config.realmId, GENERIC_REALM_ID);
  assert.strictEqual(UI_GENERIC_REALM_ID, GENERIC_REALM_ID, 'the launcher default id and the engine seed agree');

  // Explicit membership is honored; an explicit null still resolves Generic
  // (null is reserved for the director/system bootstrap).
  await store.launchAgent({ id: 'explicit_38', name: 'Explicit', realmId: 'realm_move_38', allowedTools: ['read_file'], model: createMockModel() });
  assert.strictEqual(store.agents.find((agent) => agent.id === 'explicit_38').config.realmId, 'realm_move_38');
  await store.launchAgent({ id: 'null_request_38', name: 'Null Request', realmId: null, allowedTools: ['read_file'], model: createMockModel() });
  assert.strictEqual(store.agents.find((agent) => agent.id === 'null_request_38').config.realmId, GENERIC_REALM_ID);

  // The system director is the only null-scope record.
  assert.strictEqual(store.agents.find((agent) => agent.id === 'director').config.realmId, null);

  // No-move matrix: the store acts under the runtime's host operator
  // principal (Wave I, ticket c02d0b9), and even that principal cannot move or
  // clear membership.
  for (const patch of [{ realmId: 'realm_move_38' }, { realmId: null }, { realmId: 'realm_generic_other' }]) {
    assert.throws(
      () => store.updateAgentConfig('defaulted_38', patch),
      (err) => err.code === 'PERMISSION_DENIED',
      `the store operator path must deny ${JSON.stringify(patch)}`
    );
  }
  assert.strictEqual(
    store.agents.find((agent) => agent.id === 'defaulted_38').config.realmId,
    GENERIC_REALM_ID,
    'denied moves leave membership untouched'
  );

  // Non-realm authority fields still update through the same store path.
  const updated = store.updateAgentConfig('defaulted_38', { role: 'Auditor' });
  assert.strictEqual(updated.config.role, 'Auditor');

  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 39. Wave R: hydration retains membership (no adoption, no rewrite)
// ============================================================================

test('39. hydration retains persisted memberships verbatim, including the Generic default', async () => {
  sharedLocalStorage.clear();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await store.ensureDirector();
  store.createRealm({ id: 'realm_hydr_39', name: 'Hydrate Me' });
  await store.launchAgent({ id: 'hydr_member', name: 'Member', realmId: 'realm_hydr_39', allowedTools: ['read_file'], model: createMockModel() });
  await store.launchAgent({ id: 'hydr_default', name: 'Default', allowedTools: ['read_file'], model: createMockModel() });
  assert.strictEqual(store.saveToStorage(), true, 'the fixture session must persist');

  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const reloaded = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: true });
  assert.strictEqual(runtime.getAgent('hydr_member').config.realmId, 'realm_hydr_39', 'explicit membership survives hydration');
  assert.strictEqual(runtime.getAgent('hydr_default').config.realmId, GENERIC_REALM_ID, 'the Generic default survives hydration');
  assert.strictEqual(
    runtime.createAgentIdentityPort().getAgentIdentity('director').realmId,
    null,
    'the director system scope survives hydration (engine-composed body, null scope)'
  );

  reloaded.destroy();
  store.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 40. Wave R R6 (ticket ff2202a) staged uniqueness, completed by Wave I
//     (ticket d57cbc1): realm-local ids
// ============================================================================

test('40. duplicate agent ids are denied in the target realm; the same id in another realm is realm-local', async () => {
  sharedLocalStorage.clear();

  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = createSandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });
  await store.ensureDirector();
  store.createRealm({ id: 'realm_dup_40a', name: 'Realm A' });
  store.createRealm({ id: 'realm_dup_40b', name: 'Realm B' });

  await store.launchAgent({
    id: 'dup_scout',
    name: 'Scout',
    realmId: 'realm_dup_40a',
    allowedTools: ['read_file'],
    model: createMockModel()
  });
  const agentsBefore = store.agents.map((agent) => agent.id).sort();

  // Same-realm duplicate: denied at launch time (realm-local detection).
  await assert.rejects(
    () => store.launchAgent({
      id: 'dup_scout',
      name: 'Clone',
      realmId: 'realm_dup_40a',
      allowedTools: ['read_file'],
      model: createMockModel()
    }),
    (err) => err.code === 'AGENT_ALREADY_EXISTS',
    'a duplicate inside the target realm must be denied'
  );

  assert.deepStrictEqual(
    store.agents.map((agent) => agent.id).sort(),
    agentsBefore,
    'denied duplicates never create or auto-suffix a record'
  );
  assert.strictEqual(store.recycleBin.length, 0, 'denied duplicates leave no recycle residue');

  // Cross-realm duplicate: legal since Wave I (ticket d57cbc1) — agent
  // identity is the composite `(realmId, agentId)`, so the same literal id
  // registers independently per realm. The two registrations stay distinct
  // and each realm resolves exactly its own instance.
  await store.launchAgent({
    id: 'dup_scout',
    name: 'Clone',
    realmId: 'realm_dup_40b',
    allowedTools: ['read_file'],
    model: createMockModel()
  });
  const realmA = runtime.listAgents({ realmId: 'realm_dup_40a' }).filter((agent) => agent.id === 'dup_scout');
  const realmB = runtime.listAgents({ realmId: 'realm_dup_40b' }).filter((agent) => agent.id === 'dup_scout');
  assert.strictEqual(realmA.length, 1, 'realm A carries exactly its own dup_scout');
  assert.strictEqual(realmB.length, 1, 'realm B carries exactly its own dup_scout');
  assert.notStrictEqual(realmA[0], realmB[0], 'the two registrations are distinct agents');
  assert.strictEqual(realmA[0].config.realmId, 'realm_dup_40a', 'the realm A record stays in realm A');
  assert.strictEqual(realmB[0].config.realmId, 'realm_dup_40b', 'the realm B record stays in realm B');

  store.destroy();
  runtime.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 41. Wave R hardening (ticket 0fe25fd): a snapshot missing Generic hydrates
//     the re-seeded default FIRST — the prepend order contract
// ============================================================================

test('41. a snapshot missing the Generic realm hydrates it re-seeded first, never appended last', () => {
  sharedLocalStorage.clear();

  const source = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  source.createRealm({ id: 'realm_keep_41', name: 'Keep' });
  assert.strictEqual(source.saveToStorage(), true);

  // Hand-craft the persisted bytes: the snapshot retains a non-Generic realm
  // but has lost the Generic record (the V21 probe B6 repro).
  const raw = JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'));
  raw.realms = raw.realms.filter((realm) => realm.id !== GENERIC_REALM_ID);
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', JSON.stringify(raw));
  source.destroy();

  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const reloaded = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: true });
  try {
    assert.ok(reloaded.getRealm(GENERIC_REALM_ID), 'hydration re-seeds the missing Generic record');
    assert.ok(reloaded.getRealm('realm_keep_41'), 'the persisted non-Generic record is retained');
    assert.deepStrictEqual(
      reloaded.realms.map((realm) => realm.id),
      [GENERIC_REALM_ID, 'realm_keep_41'],
      'the seeded Generic default keeps the first position after hydration (prepend contract)'
    );
    assert.strictEqual(reloaded.realms[0].id, GENERIC_REALM_ID);
  } finally {
    reloaded.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 42. Wave R hardening (ticket 0fe25fd): deletion member counting uses the
//     same trim semantics as realm grouping/resolution
// ============================================================================

test('42. deleteRealm counts trimmed memberships, so a padded hydrated member blocks (and is purged by) the deletion', async () => {
  sharedLocalStorage.clear();

  const source = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await source.ensureDirector();
  source.createRealm({ id: 'realm_ws_42', name: 'Whitespace Realm' });
  await source.launchAgent({
    id: 'ws_member_42',
    name: 'WS Member',
    realmId: 'realm_ws_42',
    allowedTools: ['read_file'],
    model: createMockModel()
  });
  assert.strictEqual(source.saveToStorage(), true);

  // Hand-craft the persisted bytes: the member's membership carries
  // surrounding whitespace (the V21 probe C2 repro). Grouping/realm resolution
  // trims it to `realm_ws_42`, so deletion counting must too — otherwise the
  // record could be removed while the member stays attached to it.
  const raw = JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'));
  raw.agents.find((agent) => agent.id === 'ws_member_42').config.realmId = '  realm_ws_42  ';
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', JSON.stringify(raw));
  source.destroy();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  try {
    assert.strictEqual(
      store.agents.find((agent) => agent.id === 'ws_member_42').config.realmId,
      '  realm_ws_42  ',
      'the hydrated membership is retained verbatim'
    );

    // Default deletion refuses: the padded membership resolves to the target
    // Realm under the trim semantics the grouping uses.
    assert.throws(
      () => store.deleteRealm('realm_ws_42'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_REALM_NOT_EMPTY,
      'a padded member must block the default deletion'
    );
    assert.ok(store.getRealm('realm_ws_42'), 'the refused record survives');
    assert.strictEqual(
      store.agents.find((agent) => agent.id === 'ws_member_42').config.realmId,
      '  realm_ws_42  ',
      'the refused member stays attached'
    );

    // The recursive override reaches the same member (normalized counting),
    // purges it, and only then removes the record.
    assert.strictEqual(store.deleteRealm('realm_ws_42', { recursive: true }), true);
    assert.strictEqual(store.getRealm('realm_ws_42'), null, 'the recursive removal drops the record');
    assert.strictEqual(store.agents.find((agent) => agent.id === 'ws_member_42'), undefined, 'the member was purged');
    assert.strictEqual(store.recycleBin.find((agent) => agent.id === 'ws_member_42'), undefined, 'no recycle residue');
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 43. Wave C (ticket f1eb48a): launch-bundle seam and fail-closed options
// ============================================================================

/**
 * Minimal valid launch bundle injected through the store's bundle seam: one
 * declared input and one agent — enough to exercise option validation without
 * launching a member.
 */
const UNIT_FIXTURE_BUNDLE = {
  template: {
    id: 'c4-unit-fixture',
    name: 'C4 Unit Fixture',
    description: '',
    formatVersion: 1,
    inputs: [{ id: 'directives', label: 'Directives' }],
    agents: [
      {
        key: 'unit',
        idPattern: 'c4-unit-agent',
        name: 'Unit',
        role: 'worker',
        prompt: [{ kind: 'text', text: 'Unit protocol.' }],
        toolProfile: { preset: 'readonly' },
        privileged: false
      }
    ]
  },
  files: { 'prompts/unit.md': 'Unit bundle body.' }
};

test('43. the launch-bundle seam exposes baked and injected bundles; invalid launch options reject before any record exists', async () => {
  sharedLocalStorage.clear();

  // Baked bundle: the demo template with an empty file map.
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const demoBundle = store.getRealmTemplateBundle(DEMO_TEMPLATE.id);
  assert.ok(demoBundle, 'the baked demo bundle resolves');
  assert.strictEqual(demoBundle.template, DEMO_TEMPLATE);
  assert.deepStrictEqual(demoBundle.files, {}, 'the demo bundle ships no bundle files');
  assert.ok(Object.isFrozen(demoBundle), 'the bundle container is frozen');
  assert.ok(Object.isFrozen(demoBundle.files), 'the bundle file map is frozen');
  assert.strictEqual(store.getRealmTemplateBundle('ghost'), null, 'unknown ids resolve to null');
  assert.strictEqual(store.getRealmTemplateBundle(''), null, 'blank ids resolve to null');
  const bakedIds = BAKED_TEMPLATE_BUNDLES.map((bundle) => bundle.template.id);
  assert.deepStrictEqual(
    store.listRealmTemplates().map((template) => template.id),
    bakedIds,
    'the default catalog is the baked catalog (demo fixture plus embedded bundles)'
  );
  store.destroy();

  // Injected bundle: extends the catalog and feeds the preview seam.
  const injected = createSandboxStore({
    autoBootstrapDirector: false,
    autoHydrate: false,
    realmTemplateBundles: [UNIT_FIXTURE_BUNDLE]
  });
  try {
    assert.deepStrictEqual(
      injected.listRealmTemplates().map((template) => template.id),
      [...bakedIds, 'c4-unit-fixture'],
      'injected bundles extend the baked catalog'
    );
    const bundle = injected.getRealmTemplateBundle('c4-unit-fixture');
    assert.strictEqual(bundle.template.id, 'c4-unit-fixture');
    assert.deepStrictEqual(bundle.files, { 'prompts/unit.md': 'Unit bundle body.' });
    assert.ok(Object.isFrozen(bundle) && Object.isFrozen(bundle.files), 'the bundle container and file map are frozen');
    assert.notStrictEqual(bundle.files, UNIT_FIXTURE_BUNDLE.files, 'the store never aliases injected state');

    const realmsBefore = injected.realms.map((realm) => realm.id);

    // Unknown input key rejects up front.
    await assert.rejects(
      () => injected.launchRealmFromTemplate('c4-unit-fixture', { inputValues: { ghost: 'x' } }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        && /unknown input 'ghost'/.test(err.message)
    );
    // Non-string value rejects up front.
    await assert.rejects(
      () => injected.launchRealmFromTemplate('c4-unit-fixture', { inputValues: { directives: 42 } }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        && /must be a string/.test(err.message)
    );
    // Malformed record rejects up front.
    await assert.rejects(
      () => injected.launchRealmFromTemplate('c4-unit-fixture', { inputValues: 42 }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        && /record of input id/.test(err.message)
    );
    // Non-boolean seed toggle rejects up front.
    await assert.rejects(
      () => injected.launchRealmFromTemplate('c4-unit-fixture', { seed: 'yes' }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        && /seed must be a boolean/.test(err.message)
    );

    assert.deepStrictEqual(
      injected.realms.map((realm) => realm.id),
      realmsBefore,
      'rejected options never create a realm record'
    );
    assert.strictEqual(injected.agents.length, 0, 'rejected options never launch a member');
  } finally {
    injected.destroy();
    sharedLocalStorage.clear();
  }

  // Malformed injections fail construction.
  assert.throws(
    () => createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false, realmTemplateBundles: 'nope' }),
    /realmTemplateBundles must be an array/
  );
  assert.throws(
    () => createSandboxStore({
      autoBootstrapDirector: false,
      autoHydrate: false,
      realmTemplateBundles: [{ template: { id: '' }, files: {} }]
    }),
    /non-empty string id/
  );
  assert.throws(
    () => createSandboxStore({
      autoBootstrapDirector: false,
      autoHydrate: false,
      realmTemplateBundles: [{ template: { id: 'x' }, files: { 'a.md': 42 } }]
    }),
    /must be a string/
  );
});

// ============================================================================
// 44. Wave I (ticket d57cbc1): realm-local identity through the store path —
//     same bare id in two realms (send, unread, workspace access)
// ============================================================================

/**
 * Closed-loopback model config for the realm-local identity fixtures: no turn
 * is ever run, so no request leaves the process (real runtime, real store,
 * real provider construction — zero mocks).
 */
const IDENTITY_OFFLINE_MODEL_CONFIG = Object.freeze({
  providerId: 'openai',
  modelId: 'store-realm-local-probe',
  url: 'http://127.0.0.1:1/v1'
});

/**
 * Builds a real runtime plus a store wired to that runtime's own substrates,
 * so tests can inspect canonical identity keys through the runtime's public
 * identity port while every store operation flows through the real engines.
 *
 * @param {{ autoHydrate?: boolean }} [options] - Auto-hydration flag.
 * @returns {{ runtime: AgentRuntime, store: SandboxStore }} The fixture.
 */
function createSharedSubstrateStore({ autoHydrate = false } = {}) {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    runtime,
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    autoBootstrapDirector: false,
    autoHydrate
  });
  return { runtime, store };
}

test('44. [d57cbc1] the same bare id in two realms resolves realm-locally through store send, unread and workspace paths', async () => {
  sharedLocalStorage.clear();
  const { runtime, store } = createSharedSubstrateStore();
  try {
    const realmA = store.createRealm({ id: 'realm_i2s_44a', name: 'Realm 44 A' });
    const realmB = store.createRealm({ id: 'realm_i2s_44b', name: 'Realm 44 B' });
    await store.launchAgent({ id: 'alpha_root', name: 'Alpha Root', realmId: realmA.id, privileged: true, allowedTools: ['*'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });
    await store.launchAgent({ id: 'beta_root', name: 'Beta Root', realmId: realmB.id, privileged: true, allowedTools: ['*'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });
    await store.launchAgent({ id: 'scout', name: 'Scout A', realmId: realmA.id, allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });
    await store.launchAgent({ id: 'scout', name: 'Scout B', realmId: realmB.id, allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });

    const identityPort = runtime.createAgentIdentityPort();
    const keyA = identityPort.getAgentIdentity('scout', { realmId: realmA.id }).key;
    const keyB = identityPort.getAgentIdentity('scout', { realmId: realmB.id }).key;
    assert.notStrictEqual(keyA, keyB, 'the two registrations carry distinct canonical keys');
    assert.equal(identityPort.getAgentIdentity('scout'), null, 'the bare id is ambiguous across realms (fail closed)');

    // Store projections stay realm-opaque: bare ids only, one entry per registration.
    const scouted = store.agents.filter((agent) => agent.id === 'scout');
    assert.equal(scouted.length, 2, 'both same-id registrations project');
    assert.deepStrictEqual(
      scouted.map((agent) => agent.config.realmId),
      [realmA.id, realmB.id],
      'each projection carries its own realm membership'
    );
    assert.ok(
      store.agents.every((agent) => !agent.id.startsWith('realm:') && !agent.id.startsWith('system:')),
      'no canonical key may appear in the agent projection'
    );

    // The runtime's canonical registration form (the wiring contract); the
    // store send below must resolve its recipient to that exact partition.
    runtime.messagingBus.registerAgent(keyA);
    runtime.messagingBus.registerAgent(keyB);

    const sendA = store.sendMessage('alpha_root', 'scout', 'Alpha greeting');
    const sendB = store.sendMessage('beta_root', 'scout', 'Beta greeting');
    assert.strictEqual(sendA.success, true, 'the realm A root delivers to its own scout');
    assert.strictEqual(sendB.success, true, 'the realm B root delivers to its own scout');
    assert.strictEqual(sendA.to, 'scout', 'the envelope recipient stays the bare realm-local id');
    assert.strictEqual(sendA.from, 'alpha_root', 'the envelope sender stays the bare realm-local id');
    assert.strictEqual(sendB.to, 'scout');

    // Each realm's mailbox holds exactly its own envelope.
    assert.strictEqual(runtime.messagingBus.getUnreadCount(keyA), 1, 'realm A mailbox holds the Alpha greeting');
    assert.strictEqual(runtime.messagingBus.getUnreadCount(keyB), 1, 'realm B mailbox holds the Beta greeting');
    const scoutedAfter = store.agents.filter((agent) => agent.id === 'scout');
    assert.deepStrictEqual(
      scoutedAfter.map((agent) => agent.unreadCount),
      [1, 1],
      'each same-id registration badges its own realm-local unread count'
    );
    assert.strictEqual(
      store.getAgentUnreadCount('scout'),
      0,
      'the ambiguous bare-id query fails closed instead of reporting a wrong-realm badge'
    );
    assert.strictEqual(store.getAgentUnreadCount('alpha_root'), 0, 'a realm-unique query keeps the legacy zero count');

    // Workspace access: explicit canonical host targets keep the two private
    // workspaces distinct, and each realm reads only its own copy.
    const writtenA = store.writeFile('/note.md', 'Alpha note', { workspaceId: keyA });
    const writtenB = store.writeFile('/note.md', 'Beta note', { workspaceId: keyB });
    assert.strictEqual(writtenA.success, true);
    assert.strictEqual(writtenB.success, true);
    assert.strictEqual(store.fsSnapshot[keyA]['/note.md'].content, 'Alpha note');
    assert.strictEqual(store.fsSnapshot[keyB]['/note.md'].content, 'Beta note');
    assert.strictEqual(
      store.fsSnapshot['scout'],
      undefined,
      'no bare-key private workspace is created for a realm-bound agent'
    );
    assert.ok(store.allWorkspaces.includes('scout'), 'the user-visible workspace list carries the bare id');
    assert.ok(
      store.allWorkspaces.every((workspace) => !workspace.startsWith('realm:') && !workspace.startsWith('system:')),
      'no canonical key may appear in the user-visible workspace list'
    );

    const alphaRead = runtime.virtualFs.readFile(
      { filePath: '/note.md', workspaceId: 'scout', raw: true },
      { callerAgentId: 'alpha_root' }
    );
    const betaRead = runtime.virtualFs.readFile(
      { filePath: '/note.md', workspaceId: 'scout', raw: true },
      { callerAgentId: 'beta_root' }
    );
    assert.strictEqual(alphaRead, 'Alpha note', 'the Alpha root reads its own realm-scout workspace');
    assert.strictEqual(betaRead, 'Beta note', 'the Beta root reads its own realm-scout workspace');

    // Clock partition resolution: a realm-unique agent's clock is addressed by
    // the runtime's current key form and read back through the same path; an
    // ambiguous bare id can never be attributed a realm.
    store.advanceAgentClock(30, 'alpha_root');
    assert.strictEqual(store.getAgentClock('alpha_root').totalSeconds, 30, 'the realm root clock advances its own partition');
    assert.strictEqual(store.getAgentClock('scout').totalSeconds, 0, 'an ambiguous bare id falls back to the global partition');

    // An ambiguous agent label is agent-attributed, never operator-attributed.
    const ambiguousSend = store.sendMessage('scout', 'alpha_root', 'not an operator send');
    assert.strictEqual(ambiguousSend.success, false, 'an ambiguous agent sender label never becomes an operator send');
    assert.strictEqual(ambiguousSend.code, 'PERMISSION_DENIED');

    // The human operator label still routes through the operator principal
    // with the bare presentation label preserved on the envelope.
    const operatorSend = store.sendMessage('human', 'alpha_root', 'operator directive');
    assert.strictEqual(operatorSend.success, true);
    assert.strictEqual(operatorSend.from, 'human');
    assert.strictEqual(operatorSend.to, 'alpha_root');
    assert.strictEqual(
      store.getAgentUnreadCount('alpha_root'),
      1,
      'a realm-unique bare id keeps counting its own mailbox'
    );
    assert.ok(
      store.messages.every((message) => !String(message.from).startsWith('realm:') && !String(message.to).startsWith('realm:')),
      'no canonical key may appear in the message projection'
    );
  } finally {
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 45. Wave I (ticket d57cbc1): legacy bare-key private workspace remap on
//     hydrate — canonical wins duplicates, nothing is dropped, bytes untouched
// ============================================================================

test('45. [d57cbc1] hydration remaps a legacy bare-key workspace onto the canonical key without rewriting persisted bytes', async () => {
  drainPendingAutosaves();
  sharedLocalStorage.clear();

  const { runtime, store } = createSharedSubstrateStore();
  store.createRealm({ id: 'realm_remap_45', name: 'Remap Realm' });
  await store.launchAgent({ id: 'remap_scout', name: 'Remap Scout', realmId: 'realm_remap_45', allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });
  const canonicalKey = runtime.createAgentIdentityPort()
    .getAgentIdentity('remap_scout', { realmId: 'realm_remap_45' }).key;
  store.writeFile('/keep.md', 'canonical keep', { workspaceId: canonicalKey });
  assert.strictEqual(store.saveToStorage(), true, 'the fixture session must persist');

  // Hand-craft the pre-I2 legacy bytes: the canonical workspace holds a
  // conflicting /keep.md, while the bare legacy partition carries the
  // duplicate plus one file only it owns.
  const persistedKey = 'ai_storyteller_sandbox_state_v1';
  const raw = JSON.parse(sharedLocalStorage.getItem(persistedKey));
  const legacyFile = (path, content) => ({
    path,
    workspaceId: 'remap_scout',
    content,
    size: content.length,
    updatedAt: Date.now(),
    readOnly: false,
    owner: 'remap_scout'
  });
  raw.virtualFs['remap_scout'] = {
    '/keep.md': legacyFile('/keep.md', 'legacy keep'),
    '/extra.md': legacyFile('/extra.md', 'legacy extra')
  };
  const legacyRaw = JSON.stringify(raw);
  sharedLocalStorage.setItem(persistedKey, legacyRaw);
  store.destroy();
  runtime.destroy();

  const reloaded = createSharedSubstrateStore({ autoHydrate: true });
  try {
    const report = reloaded.store.legacyWorkspaceRemapReport;
    assert.ok(report, 'the remap pass publishes a report when legacy bytes are found');
    assert.strictEqual(report.failed, false);
    assert.strictEqual(report.remappedCount, 1);
    assert.strictEqual(report.conflictCount, 1, 'the duplicate path is reported');
    assert.strictEqual(report.remapped[0].agentId, 'remap_scout', 'the report carries the bare id only');
    assert.deepStrictEqual([...report.remapped[0].mergedConflictPaths], ['/keep.md']);
    assert.ok(
      !JSON.stringify(report).includes('realm:'),
      'the report never exposes the canonical storage key'
    );

    const canonical = reloaded.store.fsSnapshot[canonicalKey];
    assert.ok(canonical, 'the canonical workspace survives hydration');
    assert.strictEqual(canonical['/keep.md'].content, 'canonical keep', 'the canonical copy wins the duplicate path');
    assert.strictEqual(canonical['/extra.md'].content, 'legacy extra', 'legacy-only bytes are carried over, never dropped');
    assert.strictEqual(reloaded.store.fsSnapshot['remap_scout'], undefined, 'the bare legacy partition is merged and removed');

    // The remap resolves the record's own realm scope, so membership survives.
    assert.strictEqual(
      reloaded.runtime.getAgent('remap_scout').config.realmId,
      'realm_remap_45',
      'membership survives the remap'
    );
    // No hydration step (the remap included) may schedule an autosave: wait
    // past the debounce window before any post-hydration user action below.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(
      sharedLocalStorage.getItem(persistedKey),
      legacyRaw,
      'hydration (including the remap) must not rewrite persisted bytes'
    );

    // The UI projection resolves the public bare label back to the canonical
    // storage key and never shows the internal key itself.
    reloaded.store.setActiveFsWorkspace('remap_scout');
    assert.deepStrictEqual(
      reloaded.store.activeFsFiles.map((file) => file.path).sort(),
      ['/extra.md', '/keep.md'],
      'the workspace view resolves the bare label to the recovered canonical bytes'
    );
    assert.ok(reloaded.store.allWorkspaces.includes('remap_scout'));
    assert.ok(
      reloaded.store.allWorkspaces.every((workspace) => !workspace.startsWith('realm:') && !workspace.startsWith('system:')),
      'no canonical key may appear in the user-visible workspace list after the remap'
    );
  } finally {
    reloaded.store.destroy();
    reloaded.runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 46. Wave I (ticket d57cbc1): a bare id registered in two realms is never
//     attributed an ambiguous legacy workspace (fail closed, no data loss)
// ============================================================================

test('46. [d57cbc1] a two-realm legacy bare workspace stays literal: no wrong-realm byte move', async () => {
  drainPendingAutosaves();
  sharedLocalStorage.clear();

  const { runtime, store } = createSharedSubstrateStore();
  store.createRealm({ id: 'realm_i2s_46a', name: 'Realm 46 A' });
  store.createRealm({ id: 'realm_i2s_46b', name: 'Realm 46 B' });
  await store.launchAgent({ id: 'scout', name: 'Scout A', realmId: 'realm_i2s_46a', allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });
  await store.launchAgent({ id: 'scout', name: 'Scout B', realmId: 'realm_i2s_46b', allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });
  const identityPort = runtime.createAgentIdentityPort();
  const keyA = identityPort.getAgentIdentity('scout', { realmId: 'realm_i2s_46a' }).key;
  const keyB = identityPort.getAgentIdentity('scout', { realmId: 'realm_i2s_46b' }).key;
  store.writeFile('/own.md', 'Alpha own', { workspaceId: keyA });
  store.writeFile('/own.md', 'Beta own', { workspaceId: keyB });
  assert.strictEqual(store.saveToStorage(), true);

  // The pre-I2 bare workspace cannot be attributed: its id is live in two
  // realms, so hydration must leave it literal instead of guessing a realm.
  const persistedKey = 'ai_storyteller_sandbox_state_v1';
  const raw = JSON.parse(sharedLocalStorage.getItem(persistedKey));
  raw.virtualFs['scout'] = {
    '/ghost.md': {
      path: '/ghost.md',
      workspaceId: 'scout',
      content: 'legacy ghost',
      size: 12,
      updatedAt: Date.now(),
      readOnly: false,
      owner: 'scout'
    }
  };
  const legacyRaw = JSON.stringify(raw);
  sharedLocalStorage.setItem(persistedKey, legacyRaw);
  store.destroy();
  runtime.destroy();

  const reloaded = createSharedSubstrateStore({ autoHydrate: true });
  try {
    assert.strictEqual(
      reloaded.store.legacyWorkspaceRemapReport,
      null,
      'an ambiguous legacy id publishes no remap report'
    );
    assert.strictEqual(
      reloaded.store.fsSnapshot['scout']['/ghost.md'].content,
      'legacy ghost',
      'the ambiguous legacy bytes stay literal, never moved to a guessed realm'
    );
    assert.strictEqual(reloaded.store.fsSnapshot[keyA]['/own.md'].content, 'Alpha own', 'the Alpha workspace is untouched');
    assert.strictEqual(reloaded.store.fsSnapshot[keyB]['/own.md'].content, 'Beta own', 'the Beta workspace is untouched');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(sharedLocalStorage.getItem(persistedKey), legacyRaw, 'no persisted byte was rewritten');
  } finally {
    reloaded.store.destroy();
    reloaded.runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 47. Wave I (ticket d57cbc1, fix lane F3): the operator bypass grant/revoke
//     targets a scoped same-id registration realm-exactly
// ============================================================================

test('47. [d57cbc1] realmBypass grant/revoke targets a scoped same-id registration realm-exactly', async () => {
  drainPendingAutosaves();
  sharedLocalStorage.clear();
  const { runtime, store } = createSharedSubstrateStore();
  let reloaded = null;
  try {
    store.createRealm({ id: 'realm_i2s_47a', name: 'Realm 47 A' });
    store.createRealm({ id: 'realm_i2s_47b', name: 'Realm 47 B' });
    await store.launchAgent({ id: 'scout', name: 'Scout A', realmId: 'realm_i2s_47a', allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });
    await store.launchAgent({ id: 'scout', name: 'Scout B', realmId: 'realm_i2s_47b', allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });

    const identityPort = runtime.createAgentIdentityPort();
    const alpha = identityPort.getAgentIdentity('scout', { realmId: 'realm_i2s_47a' });
    const beta = identityPort.getAgentIdentity('scout', { realmId: 'realm_i2s_47b' });
    assert.ok(alpha && beta, 'both same-id registrations resolve realm-exactly');
    assert.notStrictEqual(alpha.key, beta.key, 'the registrations carry distinct canonical keys');
    assert.strictEqual(identityPort.getAgentIdentity('scout'), null, 'the bare id is ambiguous across realms (fail closed)');

    const readGrant = (projection) => identityPort.getAgentIdentity(projection.key).realmBypass;

    // Ambiguous bare targeting stays fail-closed: no registration is touched.
    assert.strictEqual(await store.grantRealmBypass('scout'), null, 'an ambiguous bare grant resolves null');
    assert.strictEqual(readGrant(alpha), false, 'the Alpha scout stays ungranted');
    assert.strictEqual(readGrant(beta), false, 'the Beta scout stays ungranted');

    // Canonical-key targeting flips exactly the Alpha registration.
    const keyed = await store.grantRealmBypass(alpha.key);
    assert.ok(keyed && keyed.realmBypass === true, 'the canonical-key grant rebuilds the Alpha descriptor');
    assert.strictEqual(readGrant(alpha), true, 'the Alpha scout projection flips true');
    assert.strictEqual(readGrant(beta), false, 'the Beta scout projection stays false');
    assert.strictEqual(store.agents.filter((agent) => agent.id === 'scout').length, 2, 'both projections survive the grant');

    const keyedRevoke = await store.revokeRealmBypass(alpha.key);
    assert.ok(keyedRevoke && keyedRevoke.realmBypass === false, 'the canonical-key revoke clears the Alpha descriptor');
    assert.strictEqual(readGrant(alpha), false, 'the revocation flips the Alpha projection back');
    assert.strictEqual(readGrant(beta), false, 'the Beta scout was never touched by the keyed lane');

    // Scoped targeting (the store composes the canonical key) flips Alpha only.
    const scoped = await store.grantRealmBypass('scout', { realmId: 'realm_i2s_47a' });
    assert.ok(scoped && scoped.realmBypass === true, 'the scoped grant rebuilds the Alpha descriptor');
    assert.strictEqual(readGrant(alpha), true, 'the scoped grant lands on the Alpha registration');
    assert.strictEqual(readGrant(beta), false, 'the scoped grant never crosses into Beta');

    // A revoke scoped to the other realm targets Beta (a no-op on its grant
    // state) and must leave the Alpha grant untouched.
    const betaRevoke = await store.revokeRealmBypass('scout', { realmId: 'realm_i2s_47b' });
    assert.ok(betaRevoke && betaRevoke.realmBypass === false, 'the Beta-scoped revoke rebuilds the Beta descriptor');
    assert.strictEqual(readGrant(beta), false, 'the Beta registration remains ungranted');
    assert.strictEqual(readGrant(alpha), true, 'the Beta-scoped revoke never clears the Alpha grant');

    const scopedRevoke = await store.revokeRealmBypass('scout', { realmId: 'realm_i2s_47a' });
    assert.ok(scopedRevoke && scopedRevoke.realmBypass === false, 'the Alpha-scoped revoke clears the grant');
    assert.strictEqual(readGrant(alpha), false, 'the Alpha projection flips back');
    assert.strictEqual(readGrant(beta), false, 'the Beta projection stays unchanged');

    // Realm-exact means exact: an unknown realm or id never falls back to the
    // unique-match rule and never grants a same-id agent elsewhere.
    assert.strictEqual(await store.grantRealmBypass('scout', { realmId: 'realm_i2s_47_ghost' }), null, 'an unknown scoped realm fails closed');
    assert.strictEqual(await store.grantRealmBypass('ghost_agent', { realmId: 'realm_i2s_47b' }), null, 'an unknown scoped id fails closed');
    assert.strictEqual(readGrant(alpha), false, 'no fail-closed path grants Alpha');
    assert.strictEqual(readGrant(beta), false, 'no fail-closed path grants Beta');

    // The operator/internal-only authority gate is untouched.
    assert.throws(
      () => runtime.grantRealmBypass(alpha.key, { callerAgentId: 'scout' }),
      (err) => err && err.code === 'PERMISSION_DENIED',
      'the runtime grant gate still denies non-operator callers'
    );

    // The grant persists as the canonical identity key (Wave I, ticket
    // d57cbc1; fix lane G2): the legacy bare-id list was realm-ambiguous, so
    // the scoped same-id grant was lost on hydration.
    await store.grantRealmBypass(alpha.key);
    assert.strictEqual(store.saveToStorage(), true, 'the snapshot saves after the scoped grant');
    const persistedKey = 'ai_storyteller_sandbox_state_v1';
    const persisted = JSON.parse(sharedLocalStorage.getItem(persistedKey));
    assert.deepStrictEqual(
      persisted.realmBypassGrants,
      [alpha.key],
      'the persisted grant list carries the canonical identity key'
    );

    // Round-trip: the scoped grant survives hydration on exactly the Alpha
    // registration, and the Beta same-id agent never receives it.
    store.destroy();
    runtime.destroy();
    reloaded = createSharedSubstrateStore({ autoHydrate: true });
    const reloadedPort = reloaded.runtime.createAgentIdentityPort();
    const reloadedAlpha = reloadedPort.getAgentIdentity('scout', { realmId: 'realm_i2s_47a' });
    const reloadedBeta = reloadedPort.getAgentIdentity('scout', { realmId: 'realm_i2s_47b' });
    assert.ok(reloadedAlpha && reloadedBeta, 'both same-id registrations hydrate');
    assert.strictEqual(reloadedAlpha.realmBypass, true, 'the Alpha grant survives the round-trip realm-exactly');
    assert.strictEqual(reloadedBeta.realmBypass, false, 'the Beta same-id agent never receives the Alpha grant');
    assert.deepStrictEqual(
      reloaded.runtime.listRealmBypassGrants(),
      [alpha.key],
      'the persisted canonical key is restored as-is'
    );
  } finally {
    if (reloaded) {
      reloaded.store.destroy();
      reloaded.runtime.destroy();
    } else {
      store.destroy();
      runtime.destroy();
    }
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 48. Wave I (ticket d57cbc1, fix lane G2): same-id launches with an
//     initialPrompt each execute their own initial turn
// ============================================================================

test('48. [d57cbc1] same-id launches with initialPrompt each run their own initial turn', async () => {
  drainPendingAutosaves();
  sharedLocalStorage.clear();
  const { runtime, store } = createSharedSubstrateStore();
  try {
    store.createRealm({ id: 'realm_i2s_48a', name: 'Realm 48 A' });
    store.createRealm({ id: 'realm_i2s_48b', name: 'Realm 48 B' });

    // The same bare id launches into two Realms with its own initial prompt.
    // Before the fix the second launch enqueued its turn under the bare id,
    // the ambiguous lookup failed closed with AGENT_NOT_FOUND, and the whole
    // launch rolled back.
    await store.launchAgent(
      { id: 'relay', name: 'Relay A', realmId: 'realm_i2s_48a', initialPrompt: 'hello alpha' },
      createMockModel([{ content: 'alpha reply' }])
    );
    await store.launchAgent(
      { id: 'relay', name: 'Relay B', realmId: 'realm_i2s_48b', initialPrompt: 'hello beta' },
      createMockModel([{ content: 'beta reply' }])
    );

    const identityPort = runtime.createAgentIdentityPort();
    const alpha = identityPort.getAgentIdentity('relay', { realmId: 'realm_i2s_48a' });
    const beta = identityPort.getAgentIdentity('relay', { realmId: 'realm_i2s_48b' });
    assert.ok(alpha && beta, 'both same-id registrations are live after the initial-prompt launches');

    const userInputs = (key) => runtime.getAgent(key).history
      .filter((message) => message.role === 'user')
      .map((message) => message.content);
    assert.deepStrictEqual(userInputs(alpha.key), ['hello alpha'], 'Alpha ran exactly its own initial prompt');
    assert.deepStrictEqual(userInputs(beta.key), ['hello beta'], 'Beta ran exactly its own initial prompt');

    // Control: same-id launches without an initial prompt keep working.
    await store.launchAgent(
      { id: 'plain_relay', name: 'Plain Relay', realmId: 'realm_i2s_48a' },
      createMockModel()
    );
    await store.launchAgent(
      { id: 'plain_relay', name: 'Plain Relay', realmId: 'realm_i2s_48b' },
      createMockModel()
    );
    const plainAlpha = identityPort.getAgentIdentity('plain_relay', { realmId: 'realm_i2s_48a' });
    const plainBeta = identityPort.getAgentIdentity('plain_relay', { realmId: 'realm_i2s_48b' });
    assert.ok(
      runtime.getAgent(plainAlpha.key) && runtime.getAgent(plainBeta.key),
      'the prompt-less same-id control pair stays live'
    );
  } finally {
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 49. Wave I (ticket d57cbc1, fix lane G2): legacy bare-id realmBypass
//     snapshots hydrate unique-match and never escalate
// ============================================================================

test('49. [d57cbc1] legacy bare realmBypass snapshots hydrate unique-match without escalation', async () => {
  drainPendingAutosaves();
  sharedLocalStorage.clear();
  const persistedKey = 'ai_storyteller_sandbox_state_v1';
  let legacyStore = null;
  let ambiguousStore = null;
  try {
    // Legacy unique-match: one registration for the bare id, so the persisted
    // bare list restores that registration (no loss).
    const seeded = createSharedSubstrateStore();
    seeded.store.createRealm({ id: 'realm_i2s_49', name: 'Realm 49' });
    await seeded.store.launchAgent({
      id: 'solo', name: 'Solo', realmId: 'realm_i2s_49', allowedTools: ['read_file'],
      modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG
    });
    const soloIdentity = seeded.runtime.createAgentIdentityPort().getAgentIdentity('solo', { realmId: 'realm_i2s_49' });
    await seeded.store.grantRealmBypass(soloIdentity.key);
    assert.strictEqual(seeded.store.saveToStorage(), true, 'the seeded snapshot saves');
    const legacySnapshot = JSON.parse(sharedLocalStorage.getItem(persistedKey));
    legacySnapshot.realmBypassGrants = ['solo'];
    sharedLocalStorage.setItem(persistedKey, JSON.stringify(legacySnapshot));
    seeded.store.destroy();
    seeded.runtime.destroy();

    legacyStore = createSharedSubstrateStore({ autoHydrate: true });
    const legacyIdentity = legacyStore.runtime.createAgentIdentityPort().getAgentIdentity('solo', { realmId: 'realm_i2s_49' });
    assert.ok(legacyIdentity, 'the legacy snapshot hydrates its registration');
    assert.strictEqual(legacyIdentity.realmBypass, true, 'a unique-match legacy bare grant restores');

    // Legacy ambiguity: the same bare id in two Realms resolves no
    // registration, so the grant is skipped fail-closed (no escalation).
    legacyStore.store.destroy();
    legacyStore.runtime.destroy();
    legacyStore = null;
    sharedLocalStorage.clear();

    const pair = createSharedSubstrateStore();
    pair.store.createRealm({ id: 'realm_i2s_49a', name: 'Realm 49 A' });
    pair.store.createRealm({ id: 'realm_i2s_49b', name: 'Realm 49 B' });
    await pair.store.launchAgent({
      id: 'scout', name: 'Scout A', realmId: 'realm_i2s_49a', allowedTools: ['read_file'],
      modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG
    });
    await pair.store.launchAgent({
      id: 'scout', name: 'Scout B', realmId: 'realm_i2s_49b', allowedTools: ['read_file'],
      modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG
    });
    assert.strictEqual(pair.store.saveToStorage(), true, 'the pair snapshot saves');
    const pairSnapshot = JSON.parse(sharedLocalStorage.getItem(persistedKey));
    pairSnapshot.realmBypassGrants = ['scout'];
    sharedLocalStorage.setItem(persistedKey, JSON.stringify(pairSnapshot));
    pair.store.destroy();
    pair.runtime.destroy();

    ambiguousStore = createSharedSubstrateStore({ autoHydrate: true });
    const pairPort = ambiguousStore.runtime.createAgentIdentityPort();
    assert.strictEqual(
      pairPort.getAgentIdentity('scout', { realmId: 'realm_i2s_49a' }).realmBypass,
      false,
      'Alpha never receives the ambiguous legacy grant'
    );
    assert.strictEqual(
      pairPort.getAgentIdentity('scout', { realmId: 'realm_i2s_49b' }).realmBypass,
      false,
      'Beta never receives the ambiguous legacy grant'
    );
    assert.deepStrictEqual(
      ambiguousStore.runtime.listRealmBypassGrants(),
      [],
      'an ambiguous legacy bare grant mints no grant anywhere'
    );
  } finally {
    if (legacyStore) {
      legacyStore.store.destroy();
      legacyStore.runtime.destroy();
    }
    if (ambiguousStore) {
      ambiguousStore.store.destroy();
      ambiguousStore.runtime.destroy();
    }
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 50. Wave T (ticket 0df20ae): runtime template import/export registry
// ============================================================================

/**
 * Fresh valid import fixture bundle: one declared input, one bundle file, one
 * agent — enough to exercise canonical transport round-trips.
 *
 * @param {string} [id] - Template id override.
 * @returns {object} Transport bundle (`{ formatVersion, template, files }`).
 */
function createImportFixtureBundle(id = 'c4-unit-import') {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id,
      name: 'Import Fixture',
      description: 'Runtime import fixture.',
      inputs: [{ id: 'directives', label: 'Directives' }],
      agents: [
        {
          key: 'worker',
          idPattern: `${id}-worker`,
          name: 'Worker',
          role: 'worker',
          prompt: [
            { kind: 'file', path: 'prompts/worker.md' },
            { kind: 'input', inputId: 'directives' }
          ],
          toolProfile: { tools: [] },
          privileged: false
        }
      ]
    },
    files: { 'prompts/worker.md': 'Imported worker protocol.' }
  };
}

/**
 * Fresh shadow bundle: a valid template whose id equals the baked demo id, so
 * importing it must shadow the shipped entry in place.
 *
 * @returns {object} Transport bundle.
 */
function createShadowDemoBundle() {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: DEMO_TEMPLATE.id,
      name: 'Shadow Demo',
      description: 'Imported revision shadowing the shipped demo.',
      agents: [
        {
          key: 'shadow',
          idPattern: 'shadow-worker',
          name: 'Shadow Worker',
          role: 'worker',
          prompt: [{ kind: 'text', text: 'Shadow protocol.' }],
          toolProfile: { tools: [] },
          privileged: false
        }
      ]
    },
    files: {}
  };
}

test('50. import → export → re-import keeps one effective entry per id and a canonical payload', () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const templateId = 'c4-unit-import';

  try {
    const fixture = createImportFixtureBundle();
    const canonical = serializeTemplateBundle(fixture);
    const expectedVersion = templateBundleVersion(fixture);

    const receipt = store.importRealmTemplate(fixture);
    assert.ok(Object.isFrozen(receipt), 'the receipt is frozen');
    assert.strictEqual(receipt.templateId, templateId);
    assert.strictEqual(receipt.templateVersion, expectedVersion);
    assert.strictEqual(receipt.source, 'imported');
    assert.strictEqual(receipt.replacesShipped, false, 'a new id shadows nothing');
    assert.strictEqual(receipt.replacedImport, false);
    assert.deepStrictEqual(receipt.warnings, []);
    assert.ok(receipt.totalImportedBytes > 0, 'the receipt reports the effective import budget');

    // Effective catalog: the baked entries keep their order and the import is appended.
    const effectiveIds = store.listRealmTemplates().map((template) => template.id);
    assert.deepStrictEqual(
      effectiveIds.slice(0, BAKED_TEMPLATE_BUNDLES.length),
      BAKED_TEMPLATE_BUNDLES.map((bundle) => bundle.template.id),
      'imports never disturb the shipped catalog order'
    );
    assert.strictEqual(effectiveIds.filter((id) => id === templateId).length, 1, 'one effective entry per id');
    const bundle = store.getRealmTemplateBundle(templateId);
    assert.strictEqual(bundle.template.name, 'Import Fixture');
    assert.deepStrictEqual(bundle.files, { 'prompts/worker.md': 'Imported worker protocol.' });
    assert.ok(Object.isFrozen(bundle) && Object.isFrozen(bundle.files), 'the effective bundle is frozen');

    // Export is the canonical transport JSON of the effective bundle.
    assert.strictEqual(store.exportRealmTemplate(templateId), canonical, 'export is canonical and deterministic');

    // Re-importing the exported text replaces the previous import in place.
    const reimported = store.importRealmTemplate(canonical);
    assert.strictEqual(reimported.templateVersion, expectedVersion, 'round-trip preserves the content version');
    assert.strictEqual(reimported.replacedImport, true, 'the second import replaces the first');
    assert.strictEqual(
      store.listRealmTemplates().filter((template) => template.id === templateId).length,
      1,
      're-import keeps exactly one effective entry'
    );

    // Source labels (the read API for T-D).
    assert.deepStrictEqual(store.getRealmTemplateSource(templateId), {
      templateId,
      source: 'imported',
      replacesShipped: false,
      templateVersion: expectedVersion
    });
    assert.strictEqual(store.getRealmTemplateSource('ghost'), null);
    assert.strictEqual(store.getRealmTemplateSource(''), null);
    assert.ok(
      store.listRealmTemplateSources().every((entry) => Object.isFrozen(entry)),
      'every source label is frozen'
    );

    // Fail-closed transport errors stay typed.
    assert.throws(
      () => store.importRealmTemplate('not json'),
      (err) => err instanceof RealmCatalogError && err.code === 'ERR_BUNDLE_FORMAT'
    );
    assert.throws(
      () => store.importRealmTemplate({ formatVersion: 1 }),
      (err) => err instanceof RealmCatalogError && err.code === 'ERR_BUNDLE_FORMAT'
    );
    assert.throws(
      () => store.exportRealmTemplate('ghost'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
    );

    // The registry import persisted synchronously with the snapshot.
    const persisted = JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'));
    assert.strictEqual(persisted.importedRealmTemplates.length, 1);
    assert.strictEqual(persisted.importedRealmTemplates[0].id, templateId);
    assert.strictEqual(persisted.importedRealmTemplates[0].payload, canonical);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 51. Wave T: an import shadows a shipped id and delete reveals the shipped
//     revision in place
// ============================================================================

test('51. a shadowing import replaces the shipped bundle and delete restores it', () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const bakedIds = BAKED_TEMPLATE_BUNDLES.map((bundle) => bundle.template.id);

  try {
    assert.strictEqual(store.getRealmTemplateBundle(DEMO_TEMPLATE.id).template, DEMO_TEMPLATE, 'shipped first');

    const receipt = store.importRealmTemplate(createShadowDemoBundle());
    assert.strictEqual(receipt.replacesShipped, true, 'the import shadows the shipped demo id');
    const shadowed = store.getRealmTemplateBundle(DEMO_TEMPLATE.id);
    assert.strictEqual(shadowed.template.name, 'Shadow Demo');
    assert.deepStrictEqual(
      store.listRealmTemplates().map((template) => template.id),
      bakedIds,
      'shadowing replaces in place: the shipped order and ids are unchanged'
    );
    assert.deepStrictEqual(store.getRealmTemplateSource(DEMO_TEMPLATE.id), {
      templateId: DEMO_TEMPLATE.id,
      source: 'imported',
      replacesShipped: true,
      templateVersion: templateBundleVersion(createShadowDemoBundle())
    });

    assert.strictEqual(store.deleteRealmTemplate(DEMO_TEMPLATE.id), true, 'the import is deleted');
    assert.strictEqual(
      store.getRealmTemplateBundle(DEMO_TEMPLATE.id).template,
      DEMO_TEMPLATE,
      'the shipped revision resurfaces at its original position'
    );
    assert.deepStrictEqual(store.getRealmTemplateSource(DEMO_TEMPLATE.id), {
      templateId: DEMO_TEMPLATE.id,
      source: 'shipped',
      replacesShipped: false,
      templateVersion: templateBundleVersion({ template: DEMO_TEMPLATE, files: {} })
    });

    // Shipped templates have no delete path; unknown/blank ids are false no-ops.
    assert.strictEqual(store.deleteRealmTemplate(DEMO_TEMPLATE.id), false, 'shipped is not deletable');
    assert.strictEqual(store.deleteRealmTemplate('ghost'), false);
    assert.strictEqual(store.deleteRealmTemplate(''), false);

    // The same resolution rule covers host-injected bundles: deleting the
    // import reveals the injected revision, not the baked one.
    const injected = createSandboxStore({
      autoBootstrapDirector: false,
      autoHydrate: false,
      realmTemplateBundles: [UNIT_FIXTURE_BUNDLE]
    });
    try {
      const shadow = {
        formatVersion: 1,
        template: {
          formatVersion: 1,
          id: 'c4-unit-fixture',
          name: 'Injected Shadow',
          description: '',
          agents: [
            {
              key: 'shadow',
              idPattern: 'injected-shadow',
              name: 'Shadow',
              role: 'worker',
              prompt: [{ kind: 'text', text: 'Shadow.' }],
              toolProfile: { tools: [] },
              privileged: false
            }
          ]
        },
        files: {}
      };
      assert.strictEqual(
        injected.importRealmTemplate(shadow).replacesShipped,
        true,
        'an import shadows a host-injected id too'
      );
      assert.strictEqual(injected.getRealmTemplateBundle('c4-unit-fixture').template.name, 'Injected Shadow');
      assert.strictEqual(injected.deleteRealmTemplate('c4-unit-fixture'), true);
      assert.strictEqual(
        injected.getRealmTemplateBundle('c4-unit-fixture').template,
        UNIT_FIXTURE_BUNDLE.template,
        'the injected revision resurfaces'
      );
    } finally {
      injected.destroy();
    }
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 52. Wave T: hydration-package launch (generated files, merged inputs,
//     history, provenance) and fail-closed package validation
// ============================================================================

/**
 * Fresh package-launch fixture: two declared inputs (one user, one
 * generated), a baked history opener, a generated seed slot, a user seed slot,
 * and a fixed seed slot served from the bundle.
 *
 * @returns {object} Transport bundle.
 */
function createPackageLaunchBundle() {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: 'unit-package',
      name: 'Unit Package',
      description: 'Package launch fixture.',
      inputs: [
        { id: 'brief', label: 'Brief', origin: 'generated', brief: 'One generated brief.' },
        { id: 'tone', label: 'Tone', default: 'neutral' }
      ],
      agents: [
        {
          key: 'writer',
          idPattern: 'unit-package-writer',
          name: 'Writer',
          role: 'writer',
          prompt: [
            { kind: 'file', path: 'prompts/writer.md' },
            { kind: 'input', inputId: 'brief' },
            { kind: 'input', inputId: 'tone' }
          ],
          toolProfile: { tools: [] },
          privileged: false,
          history: [{ role: 'assistant', content: [{ kind: 'text', text: 'The desk lamp hums.' }] }]
        }
      ],
      seed: {
        files: [
          { path: 'lore/world.md', target: 'realm', origin: 'generated', brief: 'World lore' },
          { path: 'notes/tone.md', target: { agent: 'writer' }, origin: 'user', brief: 'Tone notes' },
          { path: 'rules/base.md', target: 'realm', origin: 'fixed', source: { inline: 'Fixed rules.' } }
        ]
      }
    },
    files: { 'prompts/writer.md': 'Writer protocol.' }
  };
}

/**
 * Builds a hydration package for the package-launch fixture.
 *
 * @param {string} templateVersion - Pinned bundle version.
 * @param {object} [overrides] - Field overrides (e.g. `files`).
 * @returns {object} Package object.
 */
function createUnitPackage(templateVersion, overrides = {}) {
  return {
    formatVersion: 1,
    templateId: 'unit-package',
    templateVersion,
    inputs: { brief: 'A generated brief.', tone: 'package tone' },
    files: [
      { path: 'lore/world.md', target: 'realm', content: 'Generated world lore.' },
      { path: 'notes/tone.md', target: { agent: 'writer' }, content: 'User tone notes.' }
    ],
    ...overrides
  };
}

/**
 * Finds a file record's content across every workspace partition (the private
 * workspace key is canonical for realm-bound members, so tests search by path).
 *
 * @param {object} store - Store under test.
 * @param {string} path - File path to find.
 * @returns {string|null} File content, or `null` when absent.
 */
function findFsContent(store, path) {
  for (const files of Object.values(store.fsSnapshot)) {
    if (!files || typeof files !== 'object') continue;
    const record = files[path];
    if (record && typeof record.content === 'string') return record.content;
  }
  return null;
}

test('52. package launch writes generated files, merges inputs, seeds history, and records provenance', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const bundle = createPackageLaunchBundle();
  const version = templateBundleVersion(bundle);

  try {
    store.importRealmTemplate(bundle);

    const receipt = await store.launchRealmFromTemplate('unit-package', {
      package: createUnitPackage(version),
      inputValues: { tone: 'launch tone' },
      name: 'Package Realm'
    });
    const realmId = receipt.realm.id;
    assert.strictEqual(receipt.realm.templateId, 'unit-package');

    // Generated + user slots written from the package; fixed slot from the bundle.
    assert.strictEqual(findFsContent(store, '/lore/world.md'), 'Generated world lore.');
    assert.strictEqual(findFsContent(store, '/notes/tone.md'), 'User tone notes.');
    assert.strictEqual(findFsContent(store, '/rules/base.md'), 'Fixed rules.');

    // History is seeded from the template without a model call.
    const writer = store.agents.find((agent) => agent.id === 'unit-package-writer');
    assert.ok(writer, 'the member launched');
    assert.strictEqual(writer.history[0].role, 'system');
    const opener = writer.history[1];
    assert.strictEqual(opener.role, 'assistant');
    assert.strictEqual(opener.content, 'The desk lamp hums.');
    assert.deepStrictEqual(opener.metadata, { source: 'template' }, 'template provenance rides the seeded message');

    // Provenance: hashes and paths only, with launch values winning the merge.
    const instance = receipt.realm.instance;
    assert.ok(instance, 'the receipt realm carries instance provenance');
    assert.ok(Object.isFrozen(instance), 'provenance is frozen');
    assert.strictEqual(instance.templateId, 'unit-package');
    assert.strictEqual(instance.templateVersion, version);
    assert.ok(instance.packageDigest.startsWith('sha256:'), 'the package digest is a content hash');
    assert.strictEqual(instance.inputHashes.brief, hashText('A generated brief.'));
    assert.strictEqual(instance.inputHashes.tone, hashText('launch tone'), 'the explicit launch value wins the merge');
    assert.deepStrictEqual(
      instance.seedPaths,
      ['/lore/world.md', '/rules/base.md', '/notes/tone.md'],
      'seed paths record the files the launch wrote (grouped by target in first-appearance order)'
    );
    assert.ok(!Number.isNaN(Date.parse(instance.launchedAt)), 'launchedAt is a timestamp');
    assert.ok(
      !JSON.stringify(instance).includes('launch tone') && !JSON.stringify(instance).includes('A generated brief.'),
      'no raw input value reaches the provenance record'
    );
    assert.strictEqual(
      store.getRealm(realmId).instance.packageDigest,
      instance.packageDigest,
      'the registry record carries the same provenance as the receipt'
    );

    // The digest is deterministic for identical packages, distinct for
    // different ones. (These comparison launches skip the seed: the fixture
    // member id is literal and `seedRealm` resolves a bare target across the
    // store's realms, a pre-existing multi-instance seeding limitation that is
    // out of this ticket's scope.)
    const second = await store.launchRealmFromTemplate('unit-package', {
      package: createUnitPackage(version),
      inputValues: { tone: 'launch tone' },
      seed: false,
      name: 'Package Realm Two'
    });
    assert.strictEqual(second.realm.instance.packageDigest, instance.packageDigest);
    const different = await store.launchRealmFromTemplate('unit-package', {
      package: createUnitPackage(version, { inputs: { brief: 'Another brief.' } }),
      seed: false,
      name: 'Package Realm Three'
    });
    assert.notStrictEqual(different.realm.instance.packageDigest, instance.packageDigest);

    // Fail-closed package validation never creates a realm record.
    const realmsBefore = store.realms.map((realm) => realm.id);
    const fixedEntryPackage = createUnitPackage(version, {
      files: [
        ...createUnitPackage(version).files,
        { path: 'rules/base.md', target: 'realm', content: 'must not attach' }
      ]
    });
    await assert.rejects(
      () => store.launchRealmFromTemplate('unit-package', { package: fixedEntryPackage }),
      (err) => err instanceof RealmCatalogError && err.code === 'ERR_HYDRATION_PACKAGE'
        && /fixed seed slot/.test(err.message)
    );
    const missingGenerated = createUnitPackage(version, {
      files: createUnitPackage(version).files.filter((file) => file.path !== 'lore/world.md')
    });
    await assert.rejects(
      () => store.launchRealmFromTemplate('unit-package', { package: missingGenerated }),
      (err) => err instanceof RealmCatalogError && err.code === 'ERR_HYDRATION_PACKAGE'
        && /missing the required generated seed slot/.test(err.message)
    );
    await assert.rejects(
      () => store.launchRealmFromTemplate('unit-package', { package: createUnitPackage(version), allowVersionMismatch: 'yes' }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
    );

    // Version mismatch: fail-closed by default, an explicit confirmation turns
    // it into a receipt warning.
    const mismatched = createUnitPackage(`sha256:${'0'.repeat(64)}`);
    await assert.rejects(
      () => store.launchRealmFromTemplate('unit-package', { package: mismatched }),
      (err) => err instanceof RealmCatalogError && err.code === 'ERR_HYDRATION_VERSION_MISMATCH'
    );
    assert.deepStrictEqual(store.realms.map((realm) => realm.id), realmsBefore, 'rejected packages create no record');
    const allowed = await store.launchRealmFromTemplate('unit-package', {
      package: mismatched,
      allowVersionMismatch: true,
      seed: false,
      name: 'Allowed Mismatch'
    });
    assert.ok(Array.isArray(allowed.warnings) && allowed.warnings.length === 1, 'the allowed mismatch is reported');
    assert.ok(/version/.test(allowed.warnings[0]));
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 53. Wave T: the providers launch gate fails closed before any side effect
// ============================================================================

test('53. a template declaring capability requirements imports but blocks launch with the typed gate', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const bundle = {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: 'unit-providers',
      name: 'Provider Gate',
      description: 'Declares one capability requirement.',
      agents: [
        {
          key: 'observer',
          idPattern: 'unit-providers-observer',
          name: 'Observer',
          role: 'observer',
          prompt: [{ kind: 'text', text: 'Observe.' }],
          toolProfile: { tools: [] },
          privileged: false
        }
      ],
      toolContract: {
        requirements: [
          {
            id: 'text.similarity',
            brief: 'Similarity between two texts.',
            io: { in: { a: 'string', b: 'string' }, out: { score: 'number' } }
          }
        ]
      }
    },
    files: {}
  };

  try {
    const receipt = store.importRealmTemplate(bundle);
    assert.strictEqual(receipt.templateId, 'unit-providers', 'the capability contract is accepted at import');
    assert.strictEqual(
      store.exportRealmTemplate('unit-providers'),
      serializeTemplateBundle(bundle),
      'the contract exports unchanged'
    );
    assert.strictEqual(store.getRealmTemplateSource('unit-providers').source, 'imported');

    const realmsBefore = store.realms.map((realm) => realm.id);
    await assert.rejects(
      () => store.launchRealmFromTemplate('unit-providers'),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_TEMPLATE_PROVIDERS_UNSUPPORTED
        && err.code === 'ERR_TEMPLATE_PROVIDERS_UNSUPPORTED'
    );
    assert.deepStrictEqual(store.realms.map((realm) => realm.id), realmsBefore, 'no partial realm record');
    assert.strictEqual(store.agents.length, 0, 'no partial member');
    assert.strictEqual(store.recycleBin.length, 0, 'no recycle residue');
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 54. Wave T: provenance and imports persist and hydrate back unchanged
// ============================================================================

test('54. instance provenance and imported templates round-trip through persistence', async () => {
  drainPendingAutosaves();
  sharedLocalStorage.clear();
  let first = null;
  let reloaded = null;

  try {
    first = createSharedSubstrateStore();
    const bundle = createPackageLaunchBundle();
    const version = templateBundleVersion(bundle);
    first.store.importRealmTemplate(bundle);
    const receipt = await first.store.launchRealmFromTemplate('unit-package', {
      package: createUnitPackage(version),
      name: 'Persisted Package Realm'
    });
    assert.strictEqual(first.store.saveToStorage(), true, 'the fixture session persists');
    const canonicalExport = first.store.exportRealmTemplate('unit-package');
    const instance = receipt.realm.instance;
    const realmId = receipt.realm.id;
    first.store.destroy();
    first.runtime.destroy();
    first = null;

    reloaded = createSharedSubstrateStore({ autoHydrate: true });
    const hydratedRealm = reloaded.store.getRealm(realmId);
    assert.ok(hydratedRealm, 'the realm record hydrates');
    assert.deepStrictEqual(hydratedRealm.instance, instance, 'provenance round-trips byte-for-byte');
    assert.ok(Object.isFrozen(hydratedRealm.instance), 'hydrated provenance is frozen');
    assert.strictEqual(
      reloaded.store.exportRealmTemplate('unit-package'),
      canonicalExport,
      'the imported bundle payload round-trips canonically'
    );
    assert.strictEqual(reloaded.store.getRealmTemplateSource('unit-package').source, 'imported');
    assert.strictEqual(
      reloaded.store.listRealmTemplateSources().filter((entry) => entry.templateId === 'unit-package').length,
      1,
      'exactly one effective import remains after hydration'
    );
  } finally {
    if (first) {
      first.store.destroy();
      first.runtime.destroy();
    }
    if (reloaded) {
      reloaded.store.destroy();
      reloaded.runtime.destroy();
    }
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 55. Wave T: a failed snapshot write rolls the registry mutation back
// ============================================================================

test('55. a quota failure rolls import/delete back with the typed persistence error', () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  try {
    const templateId = 'c4-unit-import';
    store.importRealmTemplate(createImportFixtureBundle());
    const exportedBefore = store.exportRealmTemplate(templateId);
    const realmsBefore = store.realms.map((realm) => realm.id);
    const templatesBefore = store.listRealmTemplates().map((template) => template.id);

    sharedLocalStorage.__simulateQuotaExceeded(true);
    try {
      assert.throws(
        () => store.deleteRealmTemplate(templateId),
        (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_PERSIST_FAILED
          && err.code === 'ERR_STORE_TEMPLATE_PERSIST_FAILED'
      );
      assert.throws(
        () => store.importRealmTemplate(createShadowDemoBundle()),
        (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_PERSIST_FAILED
      );
    } finally {
      sharedLocalStorage.__simulateQuotaExceeded(false);
    }

    // Both mutations rolled back: the import survives, the shadow never applied.
    assert.strictEqual(store.exportRealmTemplate(templateId), exportedBefore);
    assert.strictEqual(store.getRealmTemplateSource(templateId).source, 'imported');
    assert.strictEqual(store.getRealmTemplateBundle(DEMO_TEMPLATE.id).template, DEMO_TEMPLATE);
    assert.deepStrictEqual(store.listRealmTemplates().map((template) => template.id), templatesBefore);
    assert.deepStrictEqual(store.realms.map((realm) => realm.id), realmsBefore);
    const persisted = JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'));
    assert.strictEqual(persisted.importedRealmTemplates.length, 1, 'the persisted snapshot still carries only the accepted import');
    assert.strictEqual(persisted.importedRealmTemplates[0].id, templateId);
  } finally {
    sharedLocalStorage.__simulateQuotaExceeded(false);
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 56. Wave T: the documented import budgets are enforced with typed errors
// ============================================================================

test('56. import caps enforce the per-bundle and total budgets with typed errors', () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  /**
   * Builds a valid template bundle carrying one large unreferenced file body.
   *
   * @param {string} id - Template id.
   * @param {number} fileBytes - File body size.
   * @returns {object} Transport bundle.
   */
  const bigBundle = (id, fileBytes) => ({
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id,
      name: id,
      description: '',
      agents: [
        {
          key: 'worker',
          idPattern: `${id}-worker`,
          name: 'Worker',
          role: 'worker',
          prompt: [{ kind: 'text', text: 'Work.' }],
          toolProfile: { tools: [] },
          privileged: false
        }
      ]
    },
    files: { 'files/blob.txt': 'x'.repeat(fileBytes) }
  });

  try {
    assert.throws(
      () => store.importRealmTemplate(bigBundle('unit-big', REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES + 1)),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_TOO_LARGE
    );
    assert.strictEqual(store.getRealmTemplateBundle('unit-big'), null, 'an over-budget import never applies');

    const first = bigBundle('unit-big-a', 1_600_000);
    const firstReceipt = store.importRealmTemplate(first);
    const second = bigBundle('unit-big-b', 1_600_000);
    assert.throws(
      () => store.importRealmTemplate(second),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_TEMPLATE_TOO_LARGE
    );
    assert.strictEqual(store.getRealmTemplateBundle('unit-big-b'), null, 'the total-budget refusal never applies');

    // Re-importing the same id replaces its record, so it never double-counts.
    const replacement = store.importRealmTemplate(first);
    assert.strictEqual(replacement.replacedImport, true);
    assert.ok(replacement.totalImportedBytes <= REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES);
    assert.ok(firstReceipt.totalImportedBytes <= REALM_TEMPLATE_IMPORT_MAX_TOTAL_BYTES);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 57. [adcc133] the same seed-bearing template must seed twice in one store:
//     seed target resolution stays realm-scoped
// ============================================================================

/** Offline preset id keeping the directive wake turns off the network. */
const ADCC133_OFFLINE_PRESET_ID = 'preset_adcc133_offline';

/**
 * Fresh seed-bearing fixture whose member seed targets the template agent:
 * launching it twice in one store exercises realm-scoped seed resolution
 * (defect adcc133).
 *
 * @returns {object} Transport bundle.
 */
function createRealmScopedSeedBundle() {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: 'unit-realm-scoped-seed',
      name: 'Realm Scoped Seed',
      description: 'Seed fixture for realm-scoped target resolution.',
      agents: [
        {
          key: 'writer',
          idPattern: 'adcc133-writer',
          name: 'Writer',
          role: 'writer',
          prompt: [{ kind: 'text', text: 'Write.' }],
          toolProfile: { tools: [] },
          privileged: false
        }
      ],
      seed: {
        files: [
          { path: 'lore/realm.md', target: 'realm', origin: 'fixed', source: { inline: 'Realm lore.' } },
          { path: 'notes/member.md', target: { agent: 'writer' }, origin: 'fixed', source: { inline: 'Member note.' } }
        ],
        directive: { targetAgentKey: 'writer', text: 'Begin the seeded session.' }
      }
    },
    files: {}
  };
}

test('57. [adcc133] the same seed-bearing template launches and seeds into two realms of one store', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    store.getPresetCatalog().savePreset({
      id: ADCC133_OFFLINE_PRESET_ID,
      name: 'adcc133 offline',
      isCustom: true,
      modelConfig: { providerId: 'openai', modelId: 'adcc133-offline', url: 'http://127.0.0.1:1/v1' }
    });
    store.importRealmTemplate(createRealmScopedSeedBundle());
    const bindings = { presetBindings: { writer: ADCC133_OFFLINE_PRESET_ID } };

    const first = await store.launchRealmFromTemplate('unit-realm-scoped-seed', { ...bindings, name: 'Seed Realm A' });
    const second = await store.launchRealmFromTemplate('unit-realm-scoped-seed', { ...bindings, name: 'Seed Realm B' });
    assert.notStrictEqual(first.realm.id, second.realm.id);

    // Two realm-local registrations of the same literal member id.
    const writers = store.agents.filter((agent) => agent.id === 'adcc133-writer');
    assert.strictEqual(writers.length, 2, 'both realm registrations are active');
    assert.deepStrictEqual(
      writers.map((agent) => agent.config.realmId).sort(),
      [first.realm.id, second.realm.id].sort(),
      'each registration belongs to its own realm'
    );

    // Each realm received its own realm-global and member seed writes.
    for (const realm of [first.realm, second.realm]) {
      assert.strictEqual(
        store.fsSnapshot[`realm:${realm.id}:global`]['/lore/realm.md'].content,
        'Realm lore.',
        'the realm-global seed lands in this realm only'
      );
      assert.strictEqual(
        store.fsSnapshot[`realm:${realm.id}:adcc133-writer`]['/notes/member.md'].content,
        'Member note.',
        'the member seed lands in this realm member workspace only'
      );
      assert.deepStrictEqual(
        realm.instance.seedPaths,
        ['/lore/realm.md', '/notes/member.md'],
        'provenance records the seed paths per instance'
      );
    }

    // The directives were delivered realm-exactly under the operator label.
    const directives = store.messages.filter((message) => message.content === 'Begin the seeded session.');
    assert.strictEqual(directives.length, 2, 'one directive per realm instance');
    assert.ok(
      directives.every((message) => message.from === 'human' && message.to === 'adcc133-writer'),
      'envelopes stay operator-attributed and realm-opaque'
    );
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 58. [3595f6a] seedRealm resolves a padded hydrated membership with the same
//     trim semantics as deleteRealm/grouping
// ============================================================================

test('58. [3595f6a] seedRealm resolves a padded hydrated membership with the store trim semantics', async () => {
  sharedLocalStorage.clear();

  const source = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  await source.ensureDirector();
  source.createRealm({ id: 'realm_pad', name: 'Padded Realm' });
  await source.launchAgent({
    id: 'pad_member',
    name: 'Pad Member',
    realmId: 'realm_pad',
    allowedTools: ['read_file'],
    model: createMockModel()
  });
  assert.strictEqual(source.saveToStorage(), true);

  // Hand-craft the persisted bytes exactly like the F2 repro (and test 42):
  // the hydrated member's membership carries surrounding whitespace.
  const raw = JSON.parse(sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'));
  raw.agents.find((agent) => agent.id === 'pad_member').config.realmId = '  realm_pad  ';
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', JSON.stringify(raw));
  source.destroy();

  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  try {
    assert.strictEqual(
      store.agents.find((agent) => agent.id === 'pad_member').config.realmId,
      '  realm_pad  ',
      'the hydrated membership is retained verbatim'
    );

    // The trim semantics deleteRealm/grouping use must also resolve the seed
    // target: the padded member belongs to `realm_pad`.
    const receipt = store.seedRealm({
      realmId: 'realm_pad',
      targetAgentId: 'pad_member',
      files: [{ path: '/notes/pad.md', content: 'Padded seed.' }]
    });
    assert.strictEqual(receipt.workspace, 'pad_member', 'the receipt keeps the realm-opaque member label');
    assert.deepStrictEqual(receipt.writtenPaths, ['/notes/pad.md']);
    assert.strictEqual(
      store.fsSnapshot['realm:realm_pad:pad_member']['/notes/pad.md'].content,
      'Padded seed.',
      'the seed lands in the trimmed canonical member workspace'
    );

    // Never a wrong-realm write: a foreign realm target keeps the historical
    // membership refusal and writes nothing.
    assert.throws(
      () => store.seedRealm({
        realmId: GENERIC_REALM_ID,
        targetAgentId: 'pad_member',
        files: [{ path: '/nope.md', content: 'x' }]
      }),
      (err) => err.code === SANDBOX_STORE_ERROR_CODES.ERR_STORE_INVALID_PARAMS
        && /not an active member/.test(err.message),
      'a foreign realm must not adopt the padded member'
    );
    assert.strictEqual(
      store.fsSnapshot[`realm:${GENERIC_REALM_ID}:pad_member`],
      undefined,
      'the refused foreign seed wrote nothing'
    );
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 59. [7571ce5] the operator partition listing addresses realm-global and
//     same-id realm workspaces with resolved counts (agent opacity intact)
// ============================================================================

test('59. [7571ce5] the operator partition listing addresses realm-global and same-id realm workspaces with resolved counts', async () => {
  drainPendingAutosaves();
  sharedLocalStorage.clear();
  const { runtime, store } = createSharedSubstrateStore();
  try {
    const realmA = store.createRealm({ id: 'realm_part_59a', name: 'Realm 59 A' });
    const realmB = store.createRealm({ id: 'realm_part_59b', name: 'Realm 59 B' });
    await store.launchAgent({ id: 'scout', name: 'Scout A', realmId: realmA.id, allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });
    await store.launchAgent({ id: 'scout', name: 'Scout B', realmId: realmB.id, allowedTools: ['read_file'], modelConfig: IDENTITY_OFFLINE_MODEL_CONFIG });

    const identityPort = runtime.createAgentIdentityPort();
    const keyA = identityPort.getAgentIdentity('scout', { realmId: realmA.id }).key;
    const keyB = identityPort.getAgentIdentity('scout', { realmId: realmB.id }).key;
    const realmGlobalA = `realm:${realmA.id}:global`;
    const realmGlobalB = `realm:${realmB.id}:global`;

    store.writeFile('/shared.md', 'shared', { workspaceId: 'global' });
    store.writeFile('/own.md', 'Alpha own', { workspaceId: keyA });
    store.writeFile('/own.md', 'Beta own', { workspaceId: keyB });
    store.writeFile('/seed.md', 'Alpha global seed', { workspaceId: realmGlobalA });

    const partitions = store.fsWorkspacePartitions;
    assert.ok(Array.isArray(partitions), 'the operator partition listing is an array');
    const byKey = new Map(partitions.map((partition) => [partition.key, partition]));

    // 1. The literal shared global partition keeps its own count.
    const shared = byKey.get('global');
    assert.ok(shared, 'the shared global partition is listed');
    assert.strictEqual(shared.kind, 'global');
    assert.strictEqual(shared.realmId, null);
    assert.strictEqual(shared.fileCount, 1, 'the shared partition counts only its own file');

    // 2. Realm-global partitions: reachable per realm, uploadable even when empty.
    const alphaGlobal = byKey.get(realmGlobalA);
    assert.ok(alphaGlobal, 'realm A global partition is listed');
    assert.strictEqual(alphaGlobal.kind, 'realm-global');
    assert.strictEqual(alphaGlobal.realmId, realmA.id);
    assert.strictEqual(alphaGlobal.realmName, realmA.name);
    assert.ok(alphaGlobal.label.includes(realmA.name), 'the label carries the realm name');
    assert.strictEqual(alphaGlobal.fileCount, 1, 'the realm-global count resolves its own key, never the shared global');
    const betaGlobal = byKey.get(realmGlobalB);
    assert.ok(betaGlobal, 'realm B global partition is listed even with no files (uploadable)');
    assert.strictEqual(betaGlobal.kind, 'realm-global');
    assert.strictEqual(betaGlobal.fileCount, 0);

    // 3. The same bare id in two realms yields two distinct partitions, each
    //    resolving its own bytes and its own count.
    const alphaAgent = byKey.get(keyA);
    const betaAgent = byKey.get(keyB);
    assert.ok(alphaAgent && betaAgent, 'both same-id registrations own a partition');
    assert.strictEqual(alphaAgent.kind, 'agent');
    assert.strictEqual(betaAgent.kind, 'agent');
    assert.strictEqual(alphaAgent.realmId, realmA.id);
    assert.strictEqual(betaAgent.realmId, realmB.id);
    assert.notStrictEqual(alphaAgent.label, betaAgent.label, 'the two pills carry distinct realm-qualified labels');
    assert.strictEqual(alphaAgent.fileCount, 1, 'the pill count resolves the canonical key, not the raw bare label');
    assert.strictEqual(betaAgent.fileCount, 1);

    // 4. Selecting a partition addresses exactly it (operator path).
    store.setActiveFsWorkspace(keyA);
    assert.strictEqual(store.activeFsWorkspace, keyA, 'the selection keeps the internal key for exact addressing');
    assert.deepStrictEqual(store.activeFsFiles.map((file) => file.path), ['/own.md']);
    assert.strictEqual(store.activeFsFiles[0].content, 'Alpha own', 'the Alpha pill reads Alpha bytes');
    assert.ok(store.activeFsPartition, 'the active partition resolves');
    assert.strictEqual(store.activeFsPartition.key, keyA);
    assert.strictEqual(store.activeFsPartition.fileCount, 1, 'the active pill count reads the resolved partition');

    store.setActiveFsWorkspace(realmGlobalA);
    assert.deepStrictEqual(store.activeFsFiles.map((file) => file.path), ['/seed.md'], 'the realm-global partition is viewable');
    assert.strictEqual(store.activeFsPartition.kind, 'realm-global');

    store.setActiveFsWorkspace(keyB);
    assert.strictEqual(store.activeFsFiles[0].content, 'Beta own', 'the Beta pill resolves its own workspace');

    // 5. Upload into a realm-global partition through the operator surface.
    await store.uploadFiles([{ path: '/uploaded.md', content: 'uploaded' }], realmGlobalB);
    assert.strictEqual(store.fsSnapshot[realmGlobalB]['/uploaded.md'].content, 'uploaded');
    const refreshed = new Map(store.fsWorkspacePartitions.map((partition) => [partition.key, partition]));
    assert.strictEqual(refreshed.get(realmGlobalB).fileCount, 1, 'the uploaded realm-global partition count updates');

    // 6. Agent-facing realm opacity stays intact: the public listing never
    //    carries a canonical key, and the same-id label still projects once.
    assert.ok(store.allWorkspaces.includes('global'));
    assert.ok(store.allWorkspaces.includes('scout'), 'the bare id stays in the agent-facing list');
    assert.ok(
      store.allWorkspaces.every((workspace) => !workspace.startsWith('realm:') && !workspace.startsWith('system:')),
      'no canonical key may appear in the agent-facing workspace list'
    );
    assert.ok(!store.allWorkspaces.includes(keyA) && !store.allWorkspaces.includes(keyB));
    assert.ok(
      !JSON.stringify(store.agents).includes('realm:'),
      'no canonical key may appear in the agent projection'
    );
  } finally {
    store.destroy();
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});
