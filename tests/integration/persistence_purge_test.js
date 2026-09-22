/**
 * @file tests/persistence_purge_test.js
 * @description Comprehensive Unit and Contract Test Suite for EPIC-18:
 * Persistent Storage Schema Evolution, Recycle Bin Serialization,
 * Zero-Zombie Hydration & Hard Purge Storage Governance.
 * 
 * Strict Zero-Mock Mandate:
 * - Real production modules (sandboxPersistence/index.ts, runtime/index.ts, virtualFs/index.ts, messagingBus/index.ts, sandboxStore/index.svelte.ts).
 * - Real LocalStorage persistence engine with full round-trip serialization and schema validation.
 */

import '../test_env.js';
import assert from 'node:assert/strict';
import {
  SANDBOX_STATE_STORAGE_KEY,
  SANDBOX_PERSISTENCE_VERSION,
  validateSandboxState,
  saveSandboxState,
  loadSandboxState,
  clearSandboxState,
  hasPersistedState,
  serializeRuntimeEnvironment,
  restoreRuntimeEnvironment,
  createDebouncedSave
} from '../../src/lib/sandbox/sandboxPersistence/index.ts';
import { AgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { createWiredRuntime } from '../helpers/wired_identity_fixture.js';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';

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
 * Self-termination context: resolves the victim's own registry descriptor for
 * the runtime's self-kill path (MOD-21 W3 default-deny). These suites exercise
 * serialization/purge mechanics, so the runtime actor terminates its own agent.
 * @param {string} agentId
 * @returns {{ callerAgentId: string }}
 */
function asSelf(agentId) {
  return { callerAgentId: agentId };
}

console.log('======================================================================');
console.log('  EPIC-18: PERSISTENCE SCHEMA EVOLUTION & HARD PURGE TEST SUITE');
console.log('======================================================================\n');

// --------------------------------------------------------------------
// 1. Schema Validation & Backwards Compatibility (INV-SCHEMA-EVOLVE-01)
// --------------------------------------------------------------------
console.log('--- 1. Schema Validation (validateSandboxState) & Compatibility ---');

await runTest('validateSandboxState accepts valid state with empty recycleBin array', () => {
  const state = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'agent-1',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: 'agent-1',
        name: 'Agent One',
        config: { id: 'agent-1', name: 'Agent One' },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: []
      }
    ],
    recycleBin: []
  };

  const res = validateSandboxState(state);
  assert.equal(res.valid, true);
  assert.equal(res.error, undefined);
});

await runTest('validateSandboxState accepts valid state with populated recycleBin entries', () => {
  const state = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'agent-1',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: 'agent-1',
        name: 'Agent One',
        config: { id: 'agent-1', name: 'Agent One' },
        turnCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [{ id: 'm1', role: 'user', content: 'hello' }]
      }
    ],
    recycleBin: [
      {
        id: 'recycled-agent-1',
        name: 'Recycled Agent One',
        config: { id: 'recycled-agent-1', model: 'deepseek-v4-flash' },
        turnCount: 4,
        createdAt: Date.now() - 5000,
        updatedAt: Date.now() - 1000,
        recycledAt: new Date().toISOString(),
        recycleReason: 'Task completed',
        history: [
          { id: 'm1', role: 'user', content: 'start' },
          { id: 'm2', role: 'assistant', content: 'done' }
        ]
      }
    ]
  };

  const res = validateSandboxState(state);
  assert.equal(res.valid, true);
  assert.equal(res.error, undefined);
});

await runTest('validateSandboxState maintains 100% backwards compatibility for legacy snapshots without recycleBin', () => {
  const legacyState = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'legacy-agent',
    activeFsWorkspace: 'global',
    activeTab: 'chat',
    agents: [
      {
        id: 'legacy-agent',
        name: 'Legacy Agent',
        config: { id: 'legacy-agent' },
        turnCount: 2,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: []
      }
    ]
    // Notice: recycleBin is undefined
  };

  const res = validateSandboxState(legacyState);
  assert.equal(res.valid, true);
  assert.equal(res.error, undefined);

  // Null recycleBin should also be accepted cleanly
  legacyState.recycleBin = null;
  const resNull = validateSandboxState(legacyState);
  assert.equal(resNull.valid, true);
});

await runTest('validateSandboxState rejects non-array recycleBin', () => {
  const invalidStates = [
    { version: '1.0.0', timestamp: Date.now(), agents: [], recycleBin: 'invalid-string' },
    { version: '1.0.0', timestamp: Date.now(), agents: [], recycleBin: 12345 },
    { version: '1.0.0', timestamp: Date.now(), agents: [], recycleBin: true },
    { version: '1.0.0', timestamp: Date.now(), agents: [], recycleBin: { someKey: 'value' } }
  ];

  for (const state of invalidStates) {
    const res = validateSandboxState(state);
    assert.equal(res.valid, false);
    assert.match(res.error, /'recycleBin' must be an array/);
  }
});

await runTest('validateSandboxState rejects corrupted recycleBin items (null, non-object, missing id, missing config, invalid history)', () => {
  const base = () => ({
    version: '1.0.0',
    timestamp: Date.now(),
    agents: []
  });

  // 1. Non-object item
  const nonObjectState = { ...base(), recycleBin: ['not-an-object'] };
  let res = validateSandboxState(nonObjectState);
  assert.equal(res.valid, false);
  assert.match(res.error, /Recycled agent at index 0 is not a valid object/);

  // 2. Null item
  const nullState = { ...base(), recycleBin: [null] };
  res = validateSandboxState(nullState);
  assert.equal(res.valid, false);
  assert.match(res.error, /Recycled agent at index 0 is not a valid object/);

  // 3. Missing / empty id
  const missingIdState = { ...base(), recycleBin: [{ config: {}, history: [] }] };
  res = validateSandboxState(missingIdState);
  assert.equal(res.valid, false);
  assert.match(res.error, /Recycled agent at index 0 is missing a valid string 'id'/);

  const emptyIdState = { ...base(), recycleBin: [{ id: '   ', config: {}, history: [] }] };
  res = validateSandboxState(emptyIdState);
  assert.equal(res.valid, false);
  assert.match(res.error, /Recycled agent at index 0 is missing a valid string 'id'/);

  // 4. Missing / invalid config
  const missingConfigState = { ...base(), recycleBin: [{ id: 'agent-x', history: [] }] };
  res = validateSandboxState(missingConfigState);
  assert.equal(res.valid, false);
  assert.match(res.error, /Recycled agent 'agent-x' is missing a valid 'config' object/);

  const invalidConfigState = { ...base(), recycleBin: [{ id: 'agent-x', config: 'bad', history: [] }] };
  res = validateSandboxState(invalidConfigState);
  assert.equal(res.valid, false);
  assert.match(res.error, /Recycled agent 'agent-x' is missing a valid 'config' object/);

  // 5. Missing / invalid history
  const missingHistoryState = { ...base(), recycleBin: [{ id: 'agent-x', config: {} }] };
  res = validateSandboxState(missingHistoryState);
  assert.equal(res.valid, false);
  assert.match(res.error, /Recycled agent 'agent-x' is missing a valid 'history' array/);

  const invalidHistoryState = { ...base(), recycleBin: [{ id: 'agent-x', config: {}, history: 'bad-history' }] };
  res = validateSandboxState(invalidHistoryState);
  assert.equal(res.valid, false);
  assert.match(res.error, /Recycled agent 'agent-x' is missing a valid 'history' array/);
});

// --------------------------------------------------------------------
// 2. Lossless Serialization of Active & Recycled Agents (INV-SERIALIZE-RECYCLE-01)
// --------------------------------------------------------------------
console.log('\n--- 2. Lossless Serialization (serializeRuntimeEnvironment) ---');

await runTest('serializeRuntimeEnvironment serializes both active and recycled agents with all metadata', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  // Spawn 2 active agents
  await runtime.launchAgent({ id: 'active-1', name: 'Active Agent 1', role: 'specialist' });
  await runtime.launchAgent({ id: 'active-2', name: 'Active Agent 2', role: 'critic' });

  // Spawn 2 agents to be recycled
  await runtime.launchAgent({ id: 'recycle-1', name: 'Recycle Me 1', role: 'worker' });
  await runtime.launchAgent({ id: 'recycle-2', name: 'Recycle Me 2', role: 'scout' });

  // Add conversation history
  const r1 = runtime.getAgent('recycle-1');
  r1.history.push({ id: 'msg-1', role: 'user', content: 'Collect data' });
  r1.history.push({ id: 'msg-2', role: 'assistant', content: 'Data collected' });
  r1.turnCount = 5;

  const r2 = runtime.getAgent('recycle-2');
  r2.history.push({ role: 'user', content: 'Explore sector' }); // id omitted to test ensureHistoryMessageIds

  // Soft-kill the 2 agents
  runtime.killAgent('recycle-1', 'Objective reached', asSelf('recycle-1'));
  runtime.killAgent('recycle-2', 'Resource exhaustion', asSelf('recycle-2'));

  // Verify memory maps before serialization
  assert.equal(runtime.listAgents().length, 2);
  assert.equal(runtime.listRecycledAgents().length, 2);

  // Serialize runtime environment
  const snapshot = serializeRuntimeEnvironment(runtime, {
    activeAgentId: 'active-1',
    activeFsWorkspace: 'global',
    activeTab: 'chat'
  });

  // Verify schema validation passes
  const validation = validateSandboxState(snapshot);
  assert.equal(validation.valid, true);

  // Verify active agents serialization
  assert.equal(snapshot.agents.length, 2);
  const activeIds = snapshot.agents.map(a => a.id);
  assert.ok(activeIds.includes('active-1'));
  assert.ok(activeIds.includes('active-2'));

  // Verify recycle bin serialization
  assert.ok(Array.isArray(snapshot.recycleBin));
  assert.equal(snapshot.recycleBin.length, 2);

  const recycled1 = snapshot.recycleBin.find(a => a.id === 'recycle-1');
  assert.ok(recycled1);
  assert.equal(recycled1.name, 'Recycle Me 1');
  assert.equal(recycled1.turnCount, 5);
  assert.equal(recycled1.recycleReason, 'Objective reached');
  assert.ok(recycled1.recycledAt);
  assert.equal(recycled1.history.length, 2);
  assert.equal(recycled1.history[0].id, 'msg-1');
  assert.equal(recycled1.history[1].id, 'msg-2');

  const recycled2 = snapshot.recycleBin.find(a => a.id === 'recycle-2');
  assert.ok(recycled2);
  assert.equal(recycled2.name, 'Recycle Me 2');
  assert.equal(recycled2.recycleReason, 'Resource exhaustion');
  assert.ok(recycled2.recycledAt);
  assert.equal(recycled2.history.length, 1);
  assert.ok(recycled2.history[0].id.length > 0); // Normalized ID generated

  // Extra metadata verification
  assert.equal(snapshot.activeAgentId, 'active-1');
  assert.equal(snapshot.activeFsWorkspace, 'global');
  assert.equal(snapshot.activeTab, 'chat');
});

// --------------------------------------------------------------------
// 3. Deterministic Hydration & State Partitioning (INV-HYDRATE-RECYCLE-01)
// --------------------------------------------------------------------
console.log('\n--- 3. Deterministic Hydration & State Partitioning (restoreRuntimeEnvironment) ---');

await runTest('restoreRuntimeEnvironment cleanly hydrates active into agents (IDLE) and recycled into recycleBin (RECYCLED)', async () => {
  const vfs1 = new VirtualFS();
  const bus1 = new MessagingBus();
  const runtime1 = new AgentRuntime({ virtualFs: vfs1, messagingBus: bus1, autoBootstrapDirector: false });

  await runtime1.launchAgent({ id: 'active-alpha', name: 'Alpha Active' });
  await runtime1.launchAgent({ id: 'recycled-beta', name: 'Beta Recycled' });

  const beta = runtime1.getAgent('recycled-beta');
  beta.history.push({ id: 'msg-b1', role: 'user', content: 'Beta prompt' });
  beta.turnCount = 3;

  runtime1.killAgent('recycled-beta', 'Decommissioned during test', asSelf('recycled-beta'));

  const snapshot = serializeRuntimeEnvironment(runtime1, {
    activeAgentId: 'active-alpha'
  });

  // Create clean target runtime
  const vfs2 = new VirtualFS();
  const bus2 = new MessagingBus();
  const runtime2 = new AgentRuntime({ virtualFs: vfs2, messagingBus: bus2, autoBootstrapDirector: false });

  // Track restore event
  let restoredEventEmitted = null;
  runtime2.subscribe(event => {
    if (event.type === 'state_restored') {
      restoredEventEmitted = event;
    }
  });

  const restoreResult = restoreRuntimeEnvironment(snapshot, runtime2);
  assert.equal(restoreResult.success, true);

  // Active agents partitioning check
  assert.equal(runtime2.getAgent('active-alpha') !== null, true);
  assert.equal(runtime2.getAgent('recycled-beta') !== null, false);
  const activeAgent = runtime2.getAgent('active-alpha');
  assert.equal(activeAgent.state, AGENT_STATES.IDLE);

  // Recycled agents partitioning check
  assert.equal(runtime2.hasRecycledAgent('recycled-beta'), true);
  assert.equal(runtime2.hasRecycledAgent('active-alpha'), false);
  const restoredRecycled = runtime2.getRecycledAgent('recycled-beta');
  assert.ok(restoredRecycled);
  assert.equal(restoredRecycled.state, AGENT_STATES.RECYCLED);
  assert.equal(restoredRecycled.recycleReason, 'Decommissioned during test');
  assert.equal(restoredRecycled.turnCount, 3);
  assert.equal(restoredRecycled.history.length, 1);
  assert.equal(restoredRecycled.history[0].id, 'msg-b1');
  assert.equal(restoredRecycled.history[0].content, 'Beta prompt');

  // Verify state_restored event payload carries the hydrated snapshot
  assert.ok(restoredEventEmitted);
  assert.ok(restoredEventEmitted.payload.snapshot);
  assert.equal(restoredEventEmitted.payload.snapshot.agents.length, 1);
  assert.equal(restoredEventEmitted.payload.snapshot.recycleBin.length, 1);
});

await runTest('restoreRuntimeEnvironment handles legacy snapshot without recycleBin and initializes empty recycleBin Map', async () => {
  const legacySnapshot = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'agent-legacy',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: 'agent-legacy',
        name: 'Legacy Agent',
        config: { id: 'agent-legacy' },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: []
      }
    ],
    virtualFs: {},
    messagingBus: { auditLog: [], inboxes: {}, registeredAgents: {} },
    scheduledTimers: []
  };

  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  // Pre-seed a stale recycled entry via the public soft-kill flow to verify restore clears it
  await runtime.launchAgent({ id: 'stale-zombie', name: 'Stale Zombie' });
  runtime.killAgent('stale-zombie', 'Pre-restore stale entry', asSelf('stale-zombie'));
  assert.equal(runtime.hasRecycledAgent('stale-zombie'), true);

  const restoreResult = restoreRuntimeEnvironment(legacySnapshot, runtime);
  assert.equal(restoreResult.success, true);
  assert.equal(runtime.getAgent('agent-legacy') !== null, true);
  assert.equal(runtime.listRecycledAgents().length, 0);
  assert.equal(runtime.hasRecycledAgent('stale-zombie'), false);
});

// --------------------------------------------------------------------
// 4. Zero Zombie Mailbox Invariant (INV-NO-ZOMBIE-BUS-01)
// --------------------------------------------------------------------
console.log('\n--- 4. Zero Zombie Mailbox Invariant (messagingBus Isolation) ---');

await runTest('Restored recycled agents are not registered as active listeners on MessagingBus and reject messages with AGENT_TERMINATED', async () => {
  const { runtime, virtualFs: vfs, messagingBus: bus } = createWiredRuntime();

  await runtime.launchAgent({ id: 'active-sender', name: 'Sender', triggerPolicy: 'queued' });
  await runtime.launchAgent({ id: 'recycled-target', name: 'Target', triggerPolicy: 'auto' });

  runtime.killAgent('recycled-target', 'Killed before snapshot', asSelf('recycled-target'));

  const snapshot = serializeRuntimeEnvironment(runtime);

  // Restore into a fresh environment
  const { runtime: runtimeRestored, virtualFs: vfsRestored, messagingBus: busRestored } = createWiredRuntime();

  restoreRuntimeEnvironment(snapshot, runtimeRestored);

  // Active sender is registered on bus
  assert.equal(busRestored.isRegistered('active-sender'), true);
  assert.equal(busRestored.isAgentTerminated('active-sender'), false);

  // Recycled target is NOT registered on bus, and is marked terminated. The
  // dead-letter address is the registration's canonical identity key (Wave I,
  // d57cbc1): a recycled registration is not resolvable through the
  // active-only identity port, so the canonical key is what the bus
  // classifies as terminated.
  const recycledTargetKey = createAgentIdentityKey(
    runtimeRestored.getRecycledAgent('recycled-target')?.config?.realmId ?? null,
    'recycled-target'
  );
  assert.equal(busRestored.isRegistered('recycled-target'), false);
  assert.equal(busRestored.isAgentTerminated(recycledTargetKey), true);

  // Active sender attempts to send a direct message to recycled-target
  const receipt = busRestored.sendMessage({
    from: 'active-sender',
    to: recycledTargetKey,
    content: 'Wake up zombie!'
  });

  assert.equal(receipt.success, false);
  assert.equal(receipt.code, 'AGENT_TERMINATED');
  // The dead-letter message names the target id. The current bus message
  // echoes the canonical registration key for a projection-less terminated
  // classification — a bus-side opacity seam reported by this lane; assert the
  // id is named without pinning the echo form here.
  assert.ok(receipt.error.includes('recycled-target'), 'the dead-letter error names the target id');

  // Verify no broadcast reaches the recycled target (no live subscription)
  const broadcast = busRestored.sendMessage({
    from: 'active-sender',
    to: 'all',
    content: 'Roll call'
  });
  assert.equal(broadcast.success, true);
  assert.equal(broadcast.recipients.includes('recycled-target'), false);
  assert.equal(busRestored.getUnreadCount('recycled-target'), 0);
});

// --------------------------------------------------------------------
// 5. Hard Purge Storage Governance (INV-PURGE-GOVERNANCE-01)
// --------------------------------------------------------------------
console.log('\n--- 5. Hard Purge Storage Governance (purgeAgent & emptyRecycleBin) ---');

await runTest('purgeAgent immediately removes agent and subsequent save leaves zero ghost references in LocalStorage', async () => {
  clearSandboxState();
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  await runtime.launchAgent({ id: 'agent-keep', name: 'Agent Keep' });
  await runtime.launchAgent({ id: 'agent-purge', name: 'Agent Purge' });

  // Soft-kill agent-purge
  runtime.killAgent('agent-purge', 'About to be purged', asSelf('agent-purge'));

  // Persist state with agent-purge in recycle bin
  let snapshot = serializeRuntimeEnvironment(runtime);
  saveSandboxState(snapshot);

  // Inspect raw LocalStorage through the sandbox persistence key
  let rawStored = JSON.parse(window.localStorage.getItem(SANDBOX_STATE_STORAGE_KEY));
  assert.ok(rawStored);
  assert.equal(rawStored.agents.length, 1);
  assert.equal(rawStored.recycleBin.length, 1);
  assert.equal(rawStored.recycleBin[0].id, 'agent-purge');

  // Execute hard purge on runtime under the operator principal (MOD-21 W8:
  // purge is irreversible and sudoer-only). The operator is bootstrapped only
  // after the pre-purge snapshot so the persisted-ghost assertions below still
  // describe the agent data, not the operator.
  await runtime.ensureDirector();
  const operator = { callerAgentId: 'director' };
  const purged = runtime.purgeAgent('agent-purge', operator);
  assert.equal(purged, true);
  assert.equal(runtime.hasRecycledAgent('agent-purge'), false);
  assert.equal(runtime.getAgent('agent-purge') !== null, false);

  // Re-serialize and save snapshot to LocalStorage
  snapshot = serializeRuntimeEnvironment(runtime);
  saveSandboxState(snapshot);

  // Inspect raw LocalStorage string directly
  const rawJson = window.localStorage.getItem(SANDBOX_STATE_STORAGE_KEY);
  assert.ok(rawJson);
  assert.equal(rawJson.includes('"agent-purge"'), false);
  assert.equal(rawJson.includes('agent-purge'), false);

  // Load state and verify zero ghost records (agent-keep plus the operator
  // director that authorized the purge)
  const loadedState = loadSandboxState();
  assert.ok(loadedState);
  assert.equal(loadedState.agents.length, 2);
  const loadedIds = loadedState.agents.map(a => a.id).sort();
  assert.deepEqual(loadedIds, ['agent-keep', 'director']);
  assert.equal(loadedState.recycleBin.length, 0);
  assert.equal(loadedState.recycleBin.some(a => a.id === 'agent-purge'), false);
});

await runTest('emptyRecycleBin batch-purges all recycled agents and cleans LocalStorage snapshot', async () => {
  clearSandboxState();
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  await runtime.launchAgent({ id: 'survivor-1', name: 'Survivor 1' });
  await runtime.launchAgent({ id: 'purge-alpha', name: 'Purge Alpha' });
  await runtime.launchAgent({ id: 'purge-bravo', name: 'Purge Bravo' });
  await runtime.launchAgent({ id: 'purge-charlie', name: 'Purge Charlie' });

  // Soft-kill 3 agents
  runtime.killAgent('purge-alpha', 'batch kill', asSelf('purge-alpha'));
  runtime.killAgent('purge-bravo', 'batch kill', asSelf('purge-bravo'));
  runtime.killAgent('purge-charlie', 'batch kill', asSelf('purge-charlie'));

  // Save intermediate snapshot
  saveSandboxState(serializeRuntimeEnvironment(runtime));
  let loaded = loadSandboxState();
  assert.equal(loaded.recycleBin.length, 3);

  // Empty recycle bin under the operator principal (MOD-21 W8: sudoer-only).
  // Bootstrapped after the intermediate snapshot above so the persisted
  // recycle-bin counts describe the agent records only.
  await runtime.ensureDirector();
  const count = runtime.emptyRecycleBin({ callerAgentId: 'director' });
  assert.equal(count, 3);
  assert.equal(runtime.listRecycledAgents().length, 0);

  // Save updated snapshot
  saveSandboxState(serializeRuntimeEnvironment(runtime));

  // Verify raw LocalStorage
  const rawJson = window.localStorage.getItem(SANDBOX_STATE_STORAGE_KEY);
  assert.equal(rawJson.includes('purge-alpha'), false);
  assert.equal(rawJson.includes('purge-bravo'), false);
  assert.equal(rawJson.includes('purge-charlie'), false);
  assert.equal(rawJson.includes('survivor-1'), true);

  loaded = loadSandboxState();
  assert.equal(loaded.agents.length, 2);
  const survivorIds = loaded.agents.map(a => a.id).sort();
  assert.deepEqual(survivorIds, ['director', 'survivor-1']);
  assert.equal(loaded.recycleBin.length, 0);
});

// --------------------------------------------------------------------
// 6. Multi-Cycle Round-Trip Integrity
// --------------------------------------------------------------------
console.log('\n--- 6. Multi-Cycle Round-Trip Integrity ---');

await runTest('Complete lifecycle round-trip (launch -> soft-kill -> persist -> restore -> restoreAgent -> purge -> persist)', async () => {
  clearSandboxState();
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });

  // Cycle 1: Launch 3 agents
  await runtime.launchAgent({ id: 'hero', name: 'Hero Agent', role: 'specialist' });
  await runtime.launchAgent({ id: 'sidekick', name: 'Sidekick Agent', role: 'scout' });
  await runtime.launchAgent({ id: 'villain', name: 'Villain Agent', role: 'critic' });

  // Add history to sidekick
  const sidekick = runtime.getAgent('sidekick');
  sidekick.history.push({ id: 'msg-sk-1', role: 'user', content: 'Scout sector 4' });
  sidekick.history.push({ id: 'msg-sk-2', role: 'assistant', content: 'Sector 4 clear' });
  sidekick.turnCount = 2;

  // Soft-kill sidekick & villain
  runtime.killAgent('sidekick', 'Injured in battle', asSelf('sidekick'));
  runtime.killAgent('villain', 'Defeated', asSelf('villain'));

  // Cycle 2: Save to storage
  const snap1 = serializeRuntimeEnvironment(runtime);
  assert.equal(saveSandboxState(snap1), true);

  // Cycle 3: Restore into fresh runtime
  const vfs2 = new VirtualFS();
  const bus2 = new MessagingBus();
  const runtime2 = new AgentRuntime({ virtualFs: vfs2, messagingBus: bus2, autoBootstrapDirector: false });

  const restored1 = loadSandboxState();
  assert.ok(restored1);
  assert.equal(restoreRuntimeEnvironment(restored1, runtime2).success, true);

  assert.equal(runtime2.listAgents().length, 1);
  assert.equal(runtime2.getAgent('hero') !== null, true);
  assert.equal(runtime2.listRecycledAgents().length, 2);
  assert.equal(runtime2.hasRecycledAgent('sidekick'), true);
  assert.equal(runtime2.hasRecycledAgent('villain'), true);

  // Cycle 4: Restore sidekick back to active agents under the operator
  // principal (MOD-21 W8: lifecycle mutations require a resolved principal;
  // the production store resolves the director as operator).
  await runtime2.ensureDirector();
  const operator = { callerAgentId: 'director' };
  const revivedSidekick = runtime2.restoreAgent('sidekick', operator);
  assert.equal(revivedSidekick.state, AGENT_STATES.IDLE);
  assert.equal(runtime2.getAgent('sidekick') !== null, true);
  assert.equal(runtime2.hasRecycledAgent('sidekick'), false);
  assert.equal(revivedSidekick.history.length, 2); // History preserved!
  assert.equal(revivedSidekick.turnCount, 2);

  // Cycle 5: Purge villain permanently (sudoer-only)
  assert.equal(runtime2.purgeAgent('villain', operator), true);
  assert.equal(runtime2.listRecycledAgents().length, 0);

  // Cycle 6: Save and load again
  const snap2 = serializeRuntimeEnvironment(runtime2);
  assert.equal(saveSandboxState(snap2), true);

  const restored2 = loadSandboxState();
  assert.ok(restored2);
  assert.equal(restored2.agents.length, 3);
  const loadedAgentIds = restored2.agents.map(a => a.id).sort();
  assert.deepEqual(loadedAgentIds, ['director', 'hero', 'sidekick']);
  assert.equal(restored2.recycleBin.length, 0);

  // Raw LocalStorage check
  const rawStorageStr = window.localStorage.getItem(SANDBOX_STATE_STORAGE_KEY);
  assert.equal(rawStorageStr.includes('villain'), false);
  assert.equal(rawStorageStr.includes('sidekick'), true);
  assert.equal(rawStorageStr.includes('hero'), true);
});

// --------------------------------------------------------------------
// 7. SandboxStore Reactive Integration & Delegators
// --------------------------------------------------------------------
console.log('\n--- 7. SandboxStore Reactive Integration & Delegators ---');

await runTest('SandboxStore delegators (recycleBin, listRecycledAgents, getRecycledAgent, restoreAgent, purgeAgent, emptyRecycleBin) operate seamlessly', async () => {
  clearSandboxState();
  const store = new SandboxStore({ autoBootstrapDirector: false });

  await store.launchAgent({ id: 'bot-1', name: 'Bot 1' });
  await store.launchAgent({ id: 'bot-2', name: 'Bot 2' });
  await store.launchAgent({ id: 'bot-3', name: 'Bot 3' });
  // The director is the operator principal that authorizes store kills (MOD-21 W6).
  await store.ensureDirector();

  assert.equal(store.agents.length, 4, 'three bots plus the operator director');
  assert.equal(store.recycleBin.length, 0);

  // Soft-kill bot-2
  store.killAgent('bot-2', 'User terminated bot-2');
  assert.equal(store.agents.length, 3);
  assert.equal(store.recycleBin.length, 1);
  assert.equal(store.listRecycledAgents().length, 1);
  assert.equal(store.getRecycledAgent('bot-2').id, 'bot-2');
  assert.equal(store.getRecycledAgent('ghost'), null);

  // Save to storage
  assert.equal(store.saveToStorage(), true);
  let loaded = loadSandboxState();
  assert.equal(loaded.recycleBin.length, 1);
  assert.equal(loaded.recycleBin[0].id, 'bot-2');

  // Restore bot-2
  const restored = store.restoreAgent('bot-2');
  assert.equal(restored.id, 'bot-2');
  assert.equal(store.agents.length, 4);
  assert.equal(store.recycleBin.length, 0);
  assert.equal(store.selectedAgentId, 'bot-2');

  // Soft-kill bot-1 and bot-3
  store.killAgent('bot-1', 'Kill 1');
  store.killAgent('bot-3', 'Kill 3');
  assert.equal(store.recycleBin.length, 2);

  // Purge bot-1
  assert.equal(store.purgeAgent('bot-1'), true);
  assert.equal(store.recycleBin.length, 1);
  assert.equal(store.getRecycledAgent('bot-1'), null);

  // Empty recycle bin
  const purgedCount = store.emptyRecycleBin();
  assert.equal(purgedCount, 1);
  assert.equal(store.recycleBin.length, 0);

  // Save and verify storage is clean
  assert.equal(store.saveToStorage(), true);
  const rawJson = window.localStorage.getItem(SANDBOX_STATE_STORAGE_KEY);
  assert.equal(rawJson.includes('bot-1'), false);
  assert.equal(rawJson.includes('bot-3'), false);
  assert.equal(rawJson.includes('bot-2'), true);
});

// --------------------------------------------------------------------
// Test Summary
// --------------------------------------------------------------------
console.log('\n======================================================================');
console.log(`  EPIC-18 TEST SUITE SUMMARY: ${passedTests}/${totalTests} PASSED`);
if (failedTests > 0) {
  console.error(`  FAILURES: ${failedTests}`);
  process.exit(1);
} else {
  console.log('  100% PASS RATE - ALL CONTRACTS AND INVARIANTS VERIFIED');
  console.log('======================================================================\n');
}
