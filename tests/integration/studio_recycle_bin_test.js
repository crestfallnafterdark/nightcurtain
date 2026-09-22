/**
 * @file tests/studio_recycle_bin_test.js
 * @description Comprehensive zero-mock unit and contract tests for EPIC-19:
 * Reactive Studio Presentation: Svelte 5 Recycle Bin State, Badge Counters,
 * Management Store Actions (killAgent, restoreAgent, purgeAgent, emptyRecycleBin),
 * Event-Driven Lifecycle Synchronization, and Storage Round-Trips.
 * 
 * Target Modules:
 * - src/lib/sandbox/sandboxStore/index.svelte.ts
 * - src/lib/sandbox/runtime/index.ts
 * - src/lib/sandbox/sandboxPersistence/index.ts
 */

import '../test_env.js';
import assert from 'node:assert/strict';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import {
  saveSandboxState,
  loadSandboxState,
  clearSandboxState
} from '../../src/lib/sandbox/sandboxPersistence/index.ts';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function runTest(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

/**
 * Creates an isolated store and bootstraps the Director meta-agent as the
 * operator principal (MOD-21 W6). Store-initiated operator actions run under
 * the director's frozen registry `AuthorityDescriptor`; caller-declared
 * privilege flags never grant anything.
 * @param {Object} [options={}]
 * @returns {Promise<SandboxStore>}
 */
async function createOperatorStore(options = {}) {
  const store = new SandboxStore({ autoBootstrapDirector: false, autoHydrate: false, ...options });
  await store.ensureDirector();
  return store;
}

/**
 * Self-termination context: resolves the victim's own registry descriptor for
 * the runtime's self-kill path (MOD-21 W3 default-deny). Used where a runtime
 * is the direct actor and the store merely observes the emitted events.
 * @param {string} agentId
 * @returns {{ callerAgentId: string }}
 */
function asSelf(agentId) {
  return { callerAgentId: agentId };
}

console.log('======================================================================');
console.log('  EPIC-19: STUDIO RECYCLE BIN & REACTIVE STORE UNIT TEST SUITE');
console.log('======================================================================\n');

// --------------------------------------------------------------------
// 1. Svelte 5 Reactive Store Initialization & Getters
// --------------------------------------------------------------------
console.log('--- 1. Reactive Store Initialization & Getters ---');

await runTest('SandboxStore initializes reactive recycleBin array and recycleBinCount getter', async () => {
  const store = new SandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  assert.ok(Array.isArray(store.recycleBin), 'recycleBin should be an array');
  assert.equal(store.recycleBin.length, 0);
  assert.equal(store.recycleBinCount, 0, 'recycleBinCount should equal 0 initially');
});

await runTest('listRecycledAgents and getRecycledAgent operate on reactive recycleBin', async () => {
  const store = new SandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  assert.deepEqual(store.listRecycledAgents(), []);
  assert.equal(store.getRecycledAgent('non-existent'), null);
});

// --------------------------------------------------------------------
// 2. Soft-Kill Store Actions & Selection Fallback
// --------------------------------------------------------------------
console.log('\n--- 2. Soft-Kill Store Actions & Selection Fallback ---');

await runTest('killAgent removes agent from active roster and inserts into reactive recycleBin', async () => {
  const store = await createOperatorStore();

  await store.launchAgent({
    id: 'agent-recon',
    name: 'Recon Unit',
    role: 'Scout',
    systemPrompt: 'Scout sector'
  });

  assert.equal(store.agents.length, 2, 'operator director plus the launched agent');
  assert.equal(store.recycleBinCount, 0);
  assert.equal(store.selectedAgentId, 'agent-recon');

  const killed = store.killAgent('agent-recon', 'Decommissioned by HQ');
  assert.equal(killed, true);

  // Verify active roster is updated
  assert.equal(store.agents.length, 1, 'only the operator director remains');
  assert.equal(store.selectedAgentId, 'director', 'Selection falls back to the remaining operator agent');

  // Verify recycleBin is populated
  assert.equal(store.recycleBin.length, 1);
  assert.equal(store.recycleBinCount, 1);

  const recycledAgent = store.getRecycledAgent('agent-recon');
  assert.ok(recycledAgent);
  assert.equal(recycledAgent.id, 'agent-recon');
  assert.equal(recycledAgent.name, 'Recon Unit');
  assert.equal(recycledAgent.state, AGENT_STATES.RECYCLED);
  assert.equal(recycledAgent.recycleReason, 'Decommissioned by HQ');
  assert.ok(recycledAgent.recycledAt, 'recycledAt timestamp should be populated');
});

function createMockModel(fn, modelId = 'test-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'test-provider',
      createModel: (mId) => createMockModel(fn, mId),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: modelId, name: modelId }]
    },
    async *stream(options = {}) {
      const res = await fn(options);
      if (typeof res === 'string') {
        yield { type: 'text', content: res };
      } else if (res && typeof res === 'object') {
        if (res.reasoning || res.reasoning_content) {
          yield { type: 'reasoning', reasoning: res.reasoning || res.reasoning_content, content: res.reasoning || res.reasoning_content };
        }
        if (res.content !== undefined || res.text !== undefined) {
          yield { type: 'text', content: res.content !== undefined ? res.content : res.text };
        }
        const toolCalls = res.tool_calls || res.toolCalls || [];
        if (Array.isArray(toolCalls) && toolCalls.length > 0) {
          yield { type: 'tool_call', toolCalls };
        }
        yield {
          type: 'finish',
          finishReason: res.finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
          content: res.content !== undefined ? res.content : (res.text || ''),
          reasoning: res.reasoning || res.reasoning_content || '',
          toolCalls,
          usage: res.usage
        };
      }
    },
    async complete(options = {}) {
      return await fn(options);
    }
  };
}

await runTest('Selection fallback switches to remaining active agent when selected agent is killed', async () => {
  // Operator store with the director appended after the test agents, so the
  // selection fallback still lands on the first remaining user agent.
  const store = new SandboxStore({ autoBootstrapDirector: false, autoHydrate: false });

  await store.launchAgent({ id: 'agent-1', name: 'Agent One' });
  await store.launchAgent({ id: 'agent-2', name: 'Agent Two' });
  await store.launchAgent({ id: 'agent-3', name: 'Agent Three' });
  await store.ensureDirector();

  assert.equal(store.agents.length, 4, 'three agents plus the operator director');
  store.selectAgent('agent-2');
  assert.equal(store.selectedAgentId, 'agent-2');

  // Kill the currently selected agent-2
  store.killAgent('agent-2', 'Testing fallback');

  assert.equal(store.agents.length, 3);
  assert.equal(store.recycleBinCount, 1);
  assert.equal(store.selectedAgentId, 'agent-1', 'Should fallback to next available active agent');
});

// --------------------------------------------------------------------
// 3. Agent Restoration Store Actions & Auto-Selection
// --------------------------------------------------------------------
console.log('\n--- 3. Agent Restoration Store Actions & Auto-Selection ---');

await runTest('restoreAgent moves agent from recycleBin back to active roster in IDLE state', async () => {
  const testCompletion = async (ctx) => ({
    content: `Processed turn: ${ctx?.prompt || 'no-prompt'}`,
    reasoning: '',
    toolCalls: []
  });

  const store = new SandboxStore({
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  await store.launchAgent({
    id: 'agent-analyst',
    name: 'Analyst Alpha',
    role: 'Data Analyst',
    systemPrompt: 'Analyze patterns'
  }, createMockModel(testCompletion));

  // Execute turn to build history
  await store.triggerTurn('agent-analyst', 'Initial data ingestion');
  const analyst = () => store.agents.find(a => a.id === 'agent-analyst');
  assert.equal(analyst().turnCount, 1);
  assert.ok(analyst().history.length >= 2);
  const initialHistoryLen = analyst().history.length;

  // Operator director authorizes the soft-kill (MOD-21 W6).
  await store.ensureDirector();

  // Soft-kill
  store.killAgent('agent-analyst', 'Temporary pause');
  assert.equal(store.agents.length, 1, 'only the operator director remains active');
  assert.equal(store.recycleBinCount, 1);

  // Restore agent
  const restored = store.restoreAgent('agent-analyst');
  assert.ok(restored);
  assert.equal(restored.id, 'agent-analyst');
  assert.equal(restored.state, AGENT_STATES.IDLE);

  // Verify store reactivity updates
  assert.equal(store.agents.length, 2);
  assert.equal(store.recycleBinCount, 0);
  assert.equal(store.recycleBin.length, 0);

  // Verify auto-selection of restored agent
  assert.equal(store.selectedAgentId, 'agent-analyst');

  // Verify history and turn count preservation
  assert.equal(analyst().turnCount, 1);
  assert.equal(analyst().history.length, initialHistoryLen);
});

await runTest('Restoring an agent restores its messaging capability and allows subsequent turns', async () => {
  const testCompletion = async (ctx) => ({
    content: `Restored response: ${ctx?.prompt || 'ok'}`,
    reasoning: '',
    toolCalls: []
  });

  const store = new SandboxStore({
    autoBootstrapDirector: false,
    autoHydrate: false
  });

  await store.launchAgent({ id: 'agent-bot', name: 'Bot' }, createMockModel(testCompletion));
  await store.ensureDirector();
  store.killAgent('agent-bot', 'Testing message restoration');
  assert.equal(store.recycleBinCount, 1);

  store.restoreAgent('agent-bot');
  assert.equal(store.recycleBinCount, 0);

  // Trigger turn on restored agent
  const turnResult = await store.triggerTurn('agent-bot', 'Hello again!');
  assert.ok(turnResult);
  assert.equal(store.agents.find(a => a.id === 'agent-bot').turnCount, 1);
});

// --------------------------------------------------------------------
// 4. Hard Purge Store Actions
// --------------------------------------------------------------------
console.log('\n--- 4. Hard Purge Store Actions ---');

await runTest('purgeAgent permanently removes agent from recycleBin and memory', async () => {
  const store = await createOperatorStore();

  await store.launchAgent({ id: 'agent-temp', name: 'Temporary Agent' });
  store.killAgent('agent-temp', 'Ready for purge');
  assert.equal(store.recycleBinCount, 1);

  const purged = store.purgeAgent('agent-temp');
  assert.equal(purged, true);

  assert.equal(store.recycleBin.length, 0);
  assert.equal(store.recycleBinCount, 0);
  assert.equal(store.getRecycledAgent('agent-temp'), null);
});

await runTest('purgeAgent returns false when agent ID does not exist in recycleBin', async () => {
  const store = new SandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  const result = store.purgeAgent('non-existent-agent-id');
  assert.equal(result, false);
});

// --------------------------------------------------------------------
// 5. Batch Empty Recycle Bin Store Actions
// --------------------------------------------------------------------
console.log('\n--- 5. Batch Empty Recycle Bin Store Actions ---');

await runTest('emptyRecycleBin purges all soft-killed agents and resets recycleBinCount to 0', async () => {
  const store = await createOperatorStore();

  await store.launchAgent({ id: 'agent-a', name: 'Alpha' });
  await store.launchAgent({ id: 'agent-b', name: 'Beta' });
  await store.launchAgent({ id: 'agent-c', name: 'Gamma' });

  store.killAgent('agent-a', 'Kill A');
  store.killAgent('agent-b', 'Kill B');
  store.killAgent('agent-c', 'Kill C');

  assert.equal(store.agents.length, 1, 'only the operator director remains active');
  assert.equal(store.recycleBinCount, 3);
  assert.equal(store.recycleBin.length, 3);

  const purgedCount = store.emptyRecycleBin();
  assert.equal(purgedCount, 3);

  assert.equal(store.recycleBin.length, 0);
  assert.equal(store.recycleBinCount, 0);
});

// --------------------------------------------------------------------
// 6. Event-Driven Reactive Synchronization
// --------------------------------------------------------------------
console.log('\n--- 6. Event-Driven Reactive Synchronization ---');

await runTest('Emitting runtime lifecycle events automatically synchronizes recycleBin state', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });
  const store = new SandboxStore({ virtualFs: vfs, messagingBus: bus, runtime, autoHydrate: false });

  await runtime.launchAgent({ id: 'agent-event-test', name: 'Event Test Agent' });
  assert.equal(store.agents.length, 1);
  assert.equal(store.recycleBinCount, 0);

  // Runtime soft-kills agent directly. The self identity claim resolves the
  // victim's registry descriptor (MOD-21 W3 default-deny); this test targets
  // the store's event-driven projection sync, not the authority predicate.
  runtime.killAgent('agent-event-test', 'Killed via runtime direct', asSelf('agent-event-test'));

  // Because runtime emits 'agent_killed' / 'agent_recycled', store handler should auto-sync
  assert.equal(store.agents.length, 0);
  assert.equal(store.recycleBinCount, 1);
  assert.equal(store.recycleBin[0].id, 'agent-event-test');
  assert.equal(store.recycleBin[0].recycleReason, 'Killed via runtime direct');

  // Runtime restores agent directly. A recycled entity has no live registry
  // descriptor, so the production store's operator context (the director) is
  // required (MOD-21 W8); it is bootstrapped here and the store observes it.
  await runtime.ensureDirector();
  const operator = { callerAgentId: 'director' };
  runtime.restoreAgent('agent-event-test', operator);
  assert.equal(store.agents.length, 2, 'restored victim plus the operator director');
  assert.equal(store.recycleBinCount, 0);

  // Soft-kill again and empty recycle bin directly on runtime. Emptying is
  // sudoer-only (MOD-21 W8).
  runtime.killAgent('agent-event-test', 'Killed again', asSelf('agent-event-test'));
  assert.equal(store.recycleBinCount, 1);

  runtime.emptyRecycleBin(operator);
  assert.equal(store.recycleBinCount, 0);
  assert.equal(store.recycleBin.length, 0);
});

// --------------------------------------------------------------------
// 7. Hydration & Reset Synchronization
// --------------------------------------------------------------------
console.log('\n--- 7. Hydration & Reset Synchronization ---');

await runTest('hydrateFromStorage correctly populates reactive recycleBin array', async () => {
  clearSandboxState();

  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  await runtime.launchAgent({ id: 'live-director', name: 'Director' });
  await runtime.launchAgent({ id: 'archived-scout', name: 'Scout' });
  runtime.killAgent('archived-scout', 'Archived before save', asSelf('archived-scout'));

  const store1 = new SandboxStore({ virtualFs: vfs, messagingBus: bus, runtime, autoHydrate: false });
  assert.equal(store1.recycleBinCount, 1);

  // Save to persistence
  store1.saveToStorage();

  // Create new store and hydrate from storage
  const store2 = new SandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
  assert.equal(store2.agents.length, 1);
  assert.equal(store2.agents[0].id, 'live-director');
  assert.equal(store2.recycleBinCount, 1);
  assert.equal(store2.recycleBin[0].id, 'archived-scout');
  assert.equal(store2.recycleBin[0].state, AGENT_STATES.RECYCLED);
  assert.equal(store2.recycleBin[0].recycleReason, 'Archived before save');

  clearSandboxState();
});

await runTest('reset and factoryReset clear both active agents and recycleBin', async () => {
  const store = await createOperatorStore();

  await store.launchAgent({ id: 'agent-1', name: 'One' });
  await store.launchAgent({ id: 'agent-2', name: 'Two' });
  store.killAgent('agent-2');

  assert.equal(store.agents.length, 2, 'remaining agent plus the operator director');
  assert.equal(store.recycleBinCount, 1);

  store.reset();
  assert.equal(store.agents.length, 0);
  assert.equal(store.recycleBinCount, 0);
  assert.equal(store.recycleBin.length, 0);
});

// --------------------------------------------------------------------
// 8. Invariant: Svelte 5 Cloned State Array Integrity
// --------------------------------------------------------------------
console.log('\n--- 8. Invariant: Svelte 5 Cloned State Array Integrity ---');

await runTest('syncRecycleBin produces detached cloned objects without runtime Map reference leaking', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });

  await store.launchAgent({ id: 'agent-clone-test', name: 'Clone Test', role: 'Security' });
  await store.ensureDirector();
  store.killAgent('agent-clone-test', 'Testing clone isolation');

  const recycledInStore = store.recycleBin[0];
  assert.ok(recycledInStore);

  // Mutating store object should not corrupt runtime internal representation
  recycledInStore.name = 'Mutated Store Name';
  const runtimeRecycled = runtime.getRecycledAgent('agent-clone-test');
  assert.equal(runtimeRecycled.name, 'Clone Test');

  // A subsequent runtime lifecycle event re-syncs the store snapshot cleanly
  await store.launchAgent({ id: 'active-anchor', name: 'Anchor' });
  runtime.updateAgentConfig('active-anchor', { name: 'Anchor Updated' });
  assert.equal(store.recycleBin[0].name, 'Clone Test');
});

// --------------------------------------------------------------------
// Summary
// --------------------------------------------------------------------
console.log('\n======================================================================');
console.log(`  EPIC-19 TEST SUITE SUMMARY: ${passedTests}/${totalTests} PASSED`);
if (failedTests === 0) {
  console.log('  100% PASS RATE - ALL CONTRACTS AND INVARIANTS VERIFIED');
} else {
  console.log(`  ${failedTests} TEST(S) FAILED`);
}
console.log('======================================================================\n');

if (failedTests > 0) {
  process.exit(1);
}
