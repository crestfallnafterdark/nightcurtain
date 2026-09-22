/**
 * @file tests/unit/sandbox_persistence_module_test.js
 * @description Comprehensive isolated unit test suite for Module 6: Persistence.
 * 
 * Invariants Tested:
 * 1. Strict Contract Header Export Whitelist (0 Leaked Exports, E \ D = ∅)
 * 2. Schema Validation (validateSandboxState) & Version Handling
 * 3. Deep Prototype Pollution Immunity (INV-PROTO-POLLUTION)
 * 4. Zero-Leak Credential Boundary & Snapshot Serialization (serializeRuntimeEnvironment)
 * 5. Strict Topological Hydration & Zero Zombie Agent Policy (restoreRuntimeEnvironment)
 * 6. Storage Operations & Concurrency Lock Queue (saveSandboxState, loadSandboxState, etc.)
 * 7. Burst-Coalescing Debounced Auto-Saver (createDebouncedSave)
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as PersistenceModule from '../../src/lib/sandbox/sandboxPersistence/index.ts';
import {
  SANDBOX_PERSISTENCE_VERSION,
  SANDBOX_STATE_STORAGE_KEY,
  PERSISTENCE_ERROR_CODES,
  validateSandboxState,
  serializeRuntimeEnvironment,
  restoreRuntimeEnvironment,
  saveSandboxState,
  saveSandboxStateLocked,
  loadSandboxState,
  clearSandboxState,
  hasPersistedState,
  createDebouncedSave,
  resetSaveLockQueue
} from '../../src/lib/sandbox/sandboxPersistence/index.ts';

import { AgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { Agent } from '../../src/lib/sandbox/runtime/agent/index.ts';
import { AGENT_STATES } from '../../src/lib/sandbox/runtime/agentLifecycle/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';

const CONTRACT_PATH = new URL('../../src/lib/sandbox/sandboxPersistence/index.ts', import.meta.url);

// ============================================================================
// 1. Export Whitelist & Constants
// ============================================================================

test('1. Strict Export Whitelist & Constants', () => {
  const exportedKeys = Object.keys(PersistenceModule).sort();
  const expectedKeys = [
    'PERSISTENCE_ERROR_CODES',
    'SANDBOX_PERSISTENCE_VERSION',
    'SANDBOX_STATE_STORAGE_KEY',
    'clearSandboxState',
    'createDebouncedSave',
    'hasPersistedState',
    'loadSandboxState',
    'resetSaveLockQueue',
    'restoreRuntimeEnvironment',
    'saveSandboxState',
    'saveSandboxStateLocked',
    'serializeRuntimeEnvironment',
    'validateSandboxState'
  ].sort();

  assert.deepStrictEqual(exportedKeys, expectedKeys, 'Exported symbols must strictly match contract');
  assert.strictEqual(SANDBOX_PERSISTENCE_VERSION, '1.0.0');
  assert.strictEqual(typeof SANDBOX_STATE_STORAGE_KEY, 'string');
  assert.ok(SANDBOX_STATE_STORAGE_KEY.length > 0);
  assert.strictEqual(
    SANDBOX_STATE_STORAGE_KEY,
    'ai_storyteller_sandbox_state_v1',
    'Persisted key literal must stay byte-compatible with existing saved sessions'
  );

  // Validate error codes dictionary (dead STORAGE_UNAVAILABLE/QUOTA_EXCEEDED removed per c49b8a9)
  assert.ok(Object.isFrozen(PERSISTENCE_ERROR_CODES));
  assert.deepStrictEqual(
    Object.keys(PERSISTENCE_ERROR_CODES).sort(),
    [
      'HYDRATION_FAILED',
      'INVALID_STATE',
      'PROTOTYPE_POLLUTION_DETECTED',
      'SERIALIZATION_FAILED',
      'VERSION_MISMATCH'
    ].sort(),
    'Error code dictionary must contain exactly the live codes'
  );
  assert.strictEqual(PERSISTENCE_ERROR_CODES.INVALID_STATE, 'ERR_PERSISTENCE_INVALID_STATE');
  assert.strictEqual(PERSISTENCE_ERROR_CODES.VERSION_MISMATCH, 'ERR_PERSISTENCE_VERSION_MISMATCH');
  assert.strictEqual(PERSISTENCE_ERROR_CODES.SERIALIZATION_FAILED, 'ERR_PERSISTENCE_SERIALIZATION_FAILED');
  assert.strictEqual(PERSISTENCE_ERROR_CODES.HYDRATION_FAILED, 'ERR_PERSISTENCE_HYDRATION_FAILED');
  assert.strictEqual(PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED, 'ERR_PERSISTENCE_PROTOTYPE_POLLUTION');
  assert.ok(!('STORAGE_UNAVAILABLE' in PERSISTENCE_ERROR_CODES), 'Dead STORAGE_UNAVAILABLE must be removed');
  assert.ok(!('QUOTA_EXCEEDED' in PERSISTENCE_ERROR_CODES), 'Dead QUOTA_EXCEEDED must be removed');

  // Contract pair must not re-declare the removed dead codes (c49b8a9)
  const contractSource = fs.readFileSync(CONTRACT_PATH, 'utf-8');
  assert.ok(!contractSource.includes('STORAGE_UNAVAILABLE'), 'sandboxPersistence/index.ts must not declare STORAGE_UNAVAILABLE');
  assert.ok(!contractSource.includes('QUOTA_EXCEEDED'), 'sandboxPersistence/index.ts must not declare QUOTA_EXCEEDED');

  // Self-contained storage: the legacy app storage util must never be re-imported.
  assert.ok(
    !contractSource.includes('utils/storage'),
    'sandboxPersistence/index.ts must stay self-contained (no legacy storage util import)'
  );
});

// ============================================================================
// 2. Schema Validation (validateSandboxState)
// ============================================================================

test('2. validateSandboxState validates canonical snapshots and rejects structural flaws', () => {
  const validSnapshot = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'agent_1',
    activeFsWorkspace: 'workspace_test',
    activeTab: 'chat',
    agents: [
      {
        id: 'agent_1',
        name: 'Writer Agent',
        config: { id: 'agent_1', name: 'Writer Agent', role: 'writer' },
        turnCount: 2,
        telemetry: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          turnCount: 2,
          lastPromptTokens: 50,
          lastCompletionTokens: 25,
          terminalStops: 0,
          injectedDeliveries: 1,
          precallCount: 0,
          lastSentContext: []
        },
        createdAt: Date.now() - 10000,
        updatedAt: Date.now(),
        lastSummary: null,
        pendingPrecalls: [],
        redoStack: [],
        history: [
          { id: 'msg_1', role: 'user', content: 'Hello' },
          { id: 'msg_2', role: 'assistant', content: 'Greetings!' }
        ]
      }
    ],
    recycleBin: [
      {
        id: 'agent_recycled',
        name: 'Old Agent',
        config: { id: 'agent_recycled' },
        turnCount: 0,
        telemetry: {
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
        },
        createdAt: Date.now() - 20000,
        updatedAt: Date.now() - 10000,
        recycledAt: new Date().toISOString(),
        recycleReason: 'Completed session',
        lastSummary: null,
        pendingPrecalls: [],
        redoStack: [],
        history: []
      }
    ],
    virtualFs: {
      global: {
        '/notes.txt': {
          content: 'Important lore notes',
          size: 20,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      }
    },
    messagingBus: {
      auditLog: [],
      inboxes: { agent_1: [] },
      registeredAgents: { agent_1: { mode: 'queued', privileged: false } }
    },
    scheduledTimers: [
      {
        id: 'timer_1',
        agentId: 'agent_1',
        type: 'timeout',
        delayMs: 5000,
        createdAt: Date.now(),
        nextRunAt: Date.now() + 5000,
        iterationCount: 0
      }
    ],
    worldClock: {
      totalSeconds: 3600,
      events: [{ id: 'evt_1', timestamp: Date.now(), type: 'narrative', title: 'Dawn' }]
    },
    agentDraftInputs: {
      agent_1: 'Draft response in progress...'
    }
  };

  // Valid snapshot
  const validRes = validateSandboxState(validSnapshot);
  assert.strictEqual(validRes.valid, true);
  assert.strictEqual(validRes.error, undefined);
  assert.strictEqual(validRes.state, validSnapshot);

  // Invalid root types
  assert.strictEqual(validateSandboxState(null).valid, false);
  assert.strictEqual(validateSandboxState(undefined).valid, false);
  assert.strictEqual(validateSandboxState('string').valid, false);
  assert.strictEqual(validateSandboxState(12345).valid, false);
  assert.strictEqual(validateSandboxState([]).valid, false);

  // Missing or invalid version
  const noVersion = { ...validSnapshot, version: '' };
  const noVerRes = validateSandboxState(noVersion);
  assert.strictEqual(noVerRes.valid, false);
  assert.strictEqual(noVerRes.code, PERSISTENCE_ERROR_CODES.INVALID_STATE);

  // Incompatible major version
  const incompatibleVersion = { ...validSnapshot, version: '2.0.0' };
  const incompRes = validateSandboxState(incompatibleVersion);
  assert.strictEqual(incompRes.valid, false);
  assert.strictEqual(incompRes.code, PERSISTENCE_ERROR_CODES.VERSION_MISMATCH);

  // Invalid timestamp
  assert.strictEqual(validateSandboxState({ ...validSnapshot, timestamp: 0 }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, timestamp: -1 }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, timestamp: NaN }).valid, false);

  // Invalid agents array
  assert.strictEqual(validateSandboxState({ ...validSnapshot, agents: null }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, agents: 'not-an-array' }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, agents: [{}] }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, agents: [{ id: 'a1' }] }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, agents: [{ id: 'a1', config: {} }] }).valid, false);

  // Backward compatibility: missing recycleBin or null recycleBin
  const legacyWithoutRecycleBin = { ...validSnapshot };
  delete legacyWithoutRecycleBin.recycleBin;
  assert.strictEqual(validateSandboxState(legacyWithoutRecycleBin).valid, true);

  const legacyNullRecycleBin = { ...validSnapshot, recycleBin: null };
  assert.strictEqual(validateSandboxState(legacyNullRecycleBin).valid, true);

  // Corrupted recycleBin
  assert.strictEqual(validateSandboxState({ ...validSnapshot, recycleBin: 'not-array' }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, recycleBin: [null] }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, recycleBin: [{ id: 'r1' }] }).valid, false);

  // Corrupted virtualFs
  assert.strictEqual(validateSandboxState({ ...validSnapshot, virtualFs: 'not-object' }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, virtualFs: { '': {} } }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, virtualFs: { ws1: 'not-files-object' } }).valid, false);

  // Corrupted messagingBus
  assert.strictEqual(validateSandboxState({ ...validSnapshot, messagingBus: 'invalid' }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, messagingBus: { auditLog: 'invalid' } }).valid, false);

  // Corrupted scheduledTimers
  assert.strictEqual(validateSandboxState({ ...validSnapshot, scheduledTimers: {} }).valid, false);

  // Corrupted worldClock
  assert.strictEqual(validateSandboxState({ ...validSnapshot, worldClock: 'invalid' }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, worldClock: { totalSeconds: 'invalid' } }).valid, false);
  assert.strictEqual(validateSandboxState({ ...validSnapshot, worldClock: { events: 'invalid' } }).valid, false);

  // Corrupted agentDraftInputs
  assert.strictEqual(validateSandboxState({ ...validSnapshot, agentDraftInputs: 'invalid' }).valid, false);
});

// ============================================================================
// 3. Deep Prototype Pollution Immunity (INV-PROTO-POLLUTION)
// ============================================================================

test('3. validateSandboxState strictly detects and rejects prototype pollution attacks', () => {
  const baseValid = () => ({
    version: '1.0.0',
    timestamp: Date.now(),
    agents: [
      {
        id: 'agent_1',
        name: 'Agent 1',
        config: { id: 'agent_1' },
        history: []
      }
    ]
  });

  // 1. Prototype pollution on root object via constructor
  const attack1 = JSON.parse('{"version": "1.0.0", "timestamp": 1726531200000, "agents": [{"id": "agent_1", "config": {"id": "agent_1"}, "history": []}], "constructor": {"polluted": true}}');
  const res1 = validateSandboxState(attack1);
  assert.strictEqual(res1.valid, false);
  assert.strictEqual(res1.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);

  // 2. Prototype pollution inside agent config
  const attack2 = JSON.parse('{"version": "1.0.0", "timestamp": 1726531200000, "agents": [{"id": "agent_1", "config": {"id": "agent_1", "__proto__": {"admin": true}}, "history": []}]}');
  const res2 = validateSandboxState(attack2);
  assert.strictEqual(res2.valid, false);
  assert.strictEqual(res2.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);

  // 3. Prototype pollution in virtualFs workspace ID
  const attack3 = JSON.parse('{"version": "1.0.0", "timestamp": 1726531200000, "agents": [{"id": "agent_1", "config": {"id": "agent_1"}, "history": []}], "virtualFs": {"__proto__": {}}}');
  const res3 = validateSandboxState(attack3);
  assert.strictEqual(res3.valid, false);
  assert.strictEqual(res3.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);

  // 4. Prototype pollution in virtualFs file path
  const attack4 = JSON.parse('{"version": "1.0.0", "timestamp": 1726531200000, "agents": [{"id": "agent_1", "config": {"id": "agent_1"}, "history": []}], "virtualFs": {"global": {"__proto__": {"content": "evil"}}}}');
  const res4 = validateSandboxState(attack4);
  assert.strictEqual(res4.valid, false);
  assert.strictEqual(res4.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);

  // 5. Prototype pollution in messagingBus inboxes
  const attack5 = JSON.parse('{"version": "1.0.0", "timestamp": 1726531200000, "agents": [{"id": "agent_1", "config": {"id": "agent_1"}, "history": []}], "messagingBus": {"inboxes": {"constructor": []}}}');
  const res5 = validateSandboxState(attack5);
  assert.strictEqual(res5.valid, false);
  assert.strictEqual(res5.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);

  // 6. Prototype pollution in agentDraftInputs
  const attack6 = JSON.parse('{"version": "1.0.0", "timestamp": 1726531200000, "agents": [{"id": "agent_1", "config": {"id": "agent_1"}, "history": []}], "agentDraftInputs": {"__proto__": "malicious payload"}}');
  const res6 = validateSandboxState(attack6);
  assert.strictEqual(res6.valid, false);
  assert.strictEqual(res6.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);

  // 7. Prototype pollution in deep nested history message tool calls
  const attack7 = JSON.parse('{"version": "1.0.0", "timestamp": 1726531200000, "agents": [{"id": "agent_1", "config": {"id": "agent_1"}, "history": [{"id": "m1", "role": "assistant", "content": "Calling tool", "tool_calls": [{"id": "tc1", "function": {"arguments": {"prototype": "polluted"}}}]}]}]}');
  const res7 = validateSandboxState(attack7);
  assert.strictEqual(res7.valid, false);
  assert.strictEqual(res7.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);
});

// ============================================================================
// 4. Snapshot Serialization & Zero-Leak Credential Stripping
// ============================================================================

test('4. serializeRuntimeEnvironment deeply strips credentials and normalizes runtime snapshot', async () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/rules.md', '# Adventure Rules', { workspaceId: 'global' });

  const bus = new MessagingBus({ virtualFs: vfs });
  bus.registerAgent('director', { mode: 'queued', privileged: true });
  bus.registerAgent('writer', { mode: 'queued', privileged: false });
  bus.sendMessage({ from: 'director', to: 'writer', content: 'Draft chapter 1' });

  const clock = new WorldClock({ virtualFs: vfs });
  clock.advanceClock({ seconds: 7200 }, { isAdmin: true });

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    worldClock: clock,
    autoBootstrapDirector: false
  });

  // Launch agent with sensitive credentials in config and modelConfig
  const agentWriter = await runtime.launchAgent({
    id: 'writer',
    name: 'Story Writer',
    role: 'author',
    systemPrompt: 'You write fantasy fiction.',
    tools: ['fs_read', 'fs_write'],
    apiKey: 'sk-test-secret-agent-key-12345',
    providerApiKey: 'sk-test-provider-key-67890',
    providerApiKeys: { runware: 'sk-test-provider-map-key-11111' },
    encryptionKey: 'kek-test-master-secret',
    providerEncryptionKey: 'kek-test-provider-legacy',
    providerEncryptionKeys: { prem: 'kek-test-provider-map-legacy' },
    runwareApiKey: 'rw-test-secret-legacy-key',
    providerUrl: 'https://sensitive-api.internal.org',
    modelConfig: {
      providerId: 'deepseek',
      modelId: 'deepseek-chat',
      keyId: 'key-ref-public-123',
      temperature: 0.8,
      maxTokens: 4096,
      apiKey: 'sk-test-nested-model-secret-key',
      providerEncryptionKey: 'kek-test-nested-model',
      providerApiKeys: { deepseek: 'sk-test-nested-map-key' },
      providerEncryptionKeys: { prem: 'kek-test-nested-map' },
      runwareApiKey: 'rw-test-nested-secret',
      secretKey: 'test-nested-secret-key',
      token: 'test-jwt-bearer-token',
      nestedAuth: {
        apiKey: 'test-deeply-nested-key'
      }
    }
  });

  agentWriter.turnCount = 3;
  agentWriter.history = [
    { role: 'user', content: 'Begin story.' },
    { id: 'msg_2', role: 'assistant', content: 'In a land of mystery...' }
  ];
  agentWriter.redoStack = [
    [{ id: 'redo_msg_1', role: 'user', content: 'Undone prompt' }]
  ];
  agentWriter.telemetry = {
    inputTokens: 500,
    outputTokens: 250,
    totalTokens: 750,
    turnCount: 3,
    lastPromptTokens: 200,
    lastCompletionTokens: 100,
    terminalStops: 0,
    injectedDeliveries: 2,
    precallCount: 1,
    lastSentContext: [{ role: 'system', content: 'Context' }]
  };

  // Launch a temporary agent and recycle it
  const tempAgent = await runtime.launchAgent({
    id: 'temp_agent',
    name: 'Temp Worker',
    apiKey: 'sk-test-temp-secret',
    modelConfig: {
      providerId: 'nano-gpt',
      apiKey: 'sk-test-nano-secret',
      keyId: 'key-nano-pub'
    }
  });
  tempAgent.turnCount = 1;
  tempAgent.history = [{ role: 'user', content: 'Calc 1+1' }];
  runtime.killAgent('temp_agent', 'One-off calculation finished', { callerAgentId: 'temp_agent' });

  // Serialize environment with UI session metadata
  const snapshot = serializeRuntimeEnvironment(
    { runtime, virtualFs: vfs, messagingBus: bus, worldClock: clock },
    {
      activeAgentId: 'writer',
      activeFsWorkspace: 'global',
      activeTab: 'chat',
      agentDraftInputs: { writer: 'Draft chapter 2 intro...' }
    }
  );

  // Validate root structure
  assert.strictEqual(snapshot.version, '1.0.0');
  assert.strictEqual(snapshot.activeAgentId, 'writer');
  assert.strictEqual(snapshot.activeFsWorkspace, 'global');
  assert.strictEqual(snapshot.activeTab, 'chat');
  assert.strictEqual(snapshot.agentDraftInputs.writer, 'Draft chapter 2 intro...');

  // Validate active agent serialization & ZERO credential leaks
  assert.strictEqual(snapshot.agents.length, 1);
  const serializedWriter = snapshot.agents[0];
  assert.strictEqual(serializedWriter.id, 'writer');
  assert.strictEqual(serializedWriter.name, 'Story Writer');
  assert.strictEqual(serializedWriter.turnCount, 3);
  assert.strictEqual(serializedWriter.telemetry.totalTokens, 750);

  // Verify all secret properties are completely stripped
  assert.strictEqual(serializedWriter.config.apiKey, undefined);
  assert.strictEqual(serializedWriter.config.providerApiKey, undefined);
  assert.strictEqual(serializedWriter.config.providerApiKeys, undefined);
  assert.strictEqual(serializedWriter.config.encryptionKey, undefined);
  assert.strictEqual(serializedWriter.config.providerEncryptionKey, undefined);
  assert.strictEqual(serializedWriter.config.providerEncryptionKeys, undefined);
  assert.strictEqual(serializedWriter.config.runwareApiKey, undefined);
  assert.strictEqual(serializedWriter.config.providerUrl, undefined);

  // Verify nested modelConfig secret properties are stripped
  const modelConfig = serializedWriter.config.modelConfig;
  assert.ok(modelConfig);
  assert.strictEqual(modelConfig.providerId, 'deepseek');
  assert.strictEqual(modelConfig.modelId, 'deepseek-chat');
  assert.strictEqual(modelConfig.keyId, 'key-ref-public-123', 'Public keyId reference must be preserved');
  assert.strictEqual(modelConfig.temperature, 0.8);
  assert.strictEqual(modelConfig.maxTokens, 4096);
  assert.strictEqual(modelConfig.apiKey, undefined);
  assert.strictEqual(modelConfig.providerEncryptionKey, undefined);
  assert.strictEqual(modelConfig.providerApiKeys, undefined);
  assert.strictEqual(modelConfig.providerEncryptionKeys, undefined);
  assert.strictEqual(modelConfig.runwareApiKey, undefined);
  assert.strictEqual(modelConfig.secretKey, undefined);
  assert.strictEqual(modelConfig.token, undefined);
  assert.strictEqual(modelConfig.nestedAuth?.apiKey, undefined);

  // Verify deterministic message UUID auto-backfilling
  assert.strictEqual(serializedWriter.history.length, 2);
  assert.ok(typeof serializedWriter.history[0].id === 'string' && serializedWriter.history[0].id.length > 0, 'Message without id must be backfilled with deterministic UUID');
  assert.strictEqual(serializedWriter.history[1].id, 'msg_2');

  // Verify deep-cloned redo stack
  assert.strictEqual(serializedWriter.redoStack.length, 1);
  assert.strictEqual(serializedWriter.redoStack[0][0].id, 'redo_msg_1');

  // Validate recycled agent serialization
  assert.strictEqual(snapshot.recycleBin.length, 1);
  const serializedRecycled = snapshot.recycleBin[0];
  assert.strictEqual(serializedRecycled.id, 'temp_agent');
  assert.strictEqual(serializedRecycled.recycleReason, 'One-off calculation finished');
  assert.strictEqual(serializedRecycled.config.apiKey, undefined);
  assert.strictEqual(serializedRecycled.config.modelConfig?.apiKey, undefined);
  assert.strictEqual(serializedRecycled.config.modelConfig?.keyId, 'key-nano-pub');

  // Validate VirtualFS snapshot
  assert.ok(snapshot.virtualFs.global['/rules.md']);
  assert.strictEqual(snapshot.virtualFs.global['/rules.md'].content, '# Adventure Rules');

  // Validate MessagingBus snapshot
  assert.ok(snapshot.messagingBus.inboxes.writer);
  assert.strictEqual(snapshot.messagingBus.inboxes.writer.length, 1);

  // Validate WorldClock snapshot
  assert.ok(snapshot.worldClock);
  assert.strictEqual(snapshot.worldClock.totalSeconds, 7200);

  // Serialization with missing runtime must throw
  assert.throws(() => {
    serializeRuntimeEnvironment(null);
  }, (err) => err.code === PERSISTENCE_ERROR_CODES.SERIALIZATION_FAILED);
});

// ============================================================================
// 5. Strict Topological Hydration & Zero Zombie Agent Policy
// ============================================================================

test('5. restoreRuntimeEnvironment performs topological hydration, IDLE normalization & Zero Zombie Policy', async () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus({ virtualFs: vfs });
  const clock = new WorldClock({ virtualFs: vfs });
  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    worldClock: clock,
    autoBootstrapDirector: false
  });

  let stateRestoredEvents = [];
  runtime.on('state_restored', (evt) => {
    stateRestoredEvents.push(evt);
  });

  const snapshotToRestore = {
    version: '1.0.0',
    timestamp: 1726531200000,
    activeAgentId: 'hero_agent',
    activeFsWorkspace: 'hero_ws',
    activeTab: 'clock',
    agents: [
      {
        id: 'hero_agent',
        name: 'Hero Warrior',
        config: {
          id: 'hero_agent',
          name: 'Hero Warrior',
          role: 'fighter',
          privileged: false,
          modelConfig: {
            providerId: 'openai',
            modelId: 'gpt-4o',
            temperature: 0.5
          }
        },
        turnCount: 5,
        telemetry: {
          inputTokens: 1200,
          outputTokens: 600,
          totalTokens: 1800,
          turnCount: 5,
          lastPromptTokens: 240,
          lastCompletionTokens: 120,
          terminalStops: 0,
          injectedDeliveries: 1,
          precallCount: 0,
          lastSentContext: []
        },
        createdAt: 1726500000000,
        updatedAt: 1726530000000,
        lastSummary: 'Hero explored the dungeon depths.',
        pendingPrecalls: [],
        redoStack: [],
        history: [
          { id: 'msg_h1', role: 'user', content: 'Enter dungeon.' },
          { id: 'msg_h2', role: 'assistant', content: 'You see stone arches.' }
        ]
      }
    ],
    recycleBin: [
      {
        id: 'fallen_companion',
        name: 'Fallen Companion',
        config: {
          id: 'fallen_companion',
          name: 'Fallen Companion'
        },
        turnCount: 2,
        createdAt: 1726400000000,
        updatedAt: 1726450000000,
        recycledAt: '2026-09-16T12:00:00.000Z',
        recycleReason: 'Fell in battle',
        lastSummary: null,
        pendingPrecalls: [],
        redoStack: [],
        history: [
          { id: 'msg_f1', role: 'user', content: 'Watch out!' }
        ]
      }
    ],
    virtualFs: {
      hero_ws: {
        '/inventory.json': {
          content: '{"gold": 50, "items": ["sword", "shield"]}',
          size: 43,
          createdAt: 1726500000000,
          updatedAt: 1726530000000
        }
      }
    },
    messagingBus: {
      auditLog: [
        {
          id: 'msg_bus_1',
          from: 'system',
          to: 'hero_agent',
          content: 'Quest started',
          timestamp: 1726500000000,
          read: true
        }
      ],
      inboxes: {
        hero_agent: []
      },
      registeredAgents: {
        hero_agent: { mode: 'queued', privileged: false }
      }
    },
    scheduledTimers: [
      {
        id: 'timer_hero_rest',
        agentId: 'hero_agent',
        type: 'timeout',
        delayMs: 30000,
        createdAt: 1726530000000,
        nextRunAt: 1726560000000,
        iterationCount: 0
      }
    ],
    worldClock: {
      totalSeconds: 14400,
      events: [
        { id: 'evt_noon', timestamp: 1726530000000, type: 'simulation', title: 'Solar Noon' }
      ]
    },
    agentDraftInputs: {
      hero_agent: 'I cast a light spell.'
    }
  };

  // Perform restoration (runtime owns 'state_restored' emission)
  const result = restoreRuntimeEnvironment(
    snapshotToRestore,
    { runtime, virtualFs: vfs, messagingBus: bus, worldClock: clock }
  );

  assert.strictEqual(result.success, true);
  assert.ok(result.metadata);
  assert.strictEqual(result.metadata.activeAgentCount, 1);
  assert.strictEqual(result.metadata.recycledAgentCount, 1);
  assert.strictEqual(result.metadata.activeAgentId, 'hero_agent');
  assert.strictEqual(result.metadata.activeFsWorkspace, 'hero_ws');
  assert.strictEqual(result.metadata.activeTab, 'clock');
  assert.strictEqual(result.metadata.agentDraftInputs.hero_agent, 'I cast a light spell.');

  // Verify VirtualFS hydration (private workspaces require an explicit caller)
  const file = vfs.readFile('/inventory.json', { workspaceId: 'hero_ws', callerAgentId: 'hero_ws' });
  assert.strictEqual(file.content, '{"gold": 50, "items": ["sword", "shield"]}');

  // Verify WorldClock hydration (through the runtime persistence port, whose
  // clock members carry the composition-root InternalPrincipal binding; MOD-21
  // W10-C)
  const clockSnap = runtime.createPersistencePort().worldClock.exportSnapshot();
  assert.strictEqual(clockSnap.totalSeconds, 14400);

  // Verify Active Agent Hydration & IDLE Normalization
  assert.strictEqual(runtime.listAgents().length, 1);
  const heroAgent = runtime.getAgent('hero_agent');
  assert.ok(heroAgent instanceof Agent);
  assert.strictEqual(heroAgent.state, AGENT_STATES.IDLE, 'Restored active agent must be normalized to IDLE');
  assert.strictEqual(heroAgent.turnCount, 5);
  assert.strictEqual(heroAgent.lastSummary, 'Hero explored the dungeon depths.');
  assert.strictEqual(heroAgent.history.length, 2);
  assert.strictEqual(heroAgent.history[0].id, 'msg_h1');

  // Verify MessagingBus registration for active agent
  assert.strictEqual(bus.isRegistered('hero_agent'), true);

  // Verify ZERO ZOMBIE POLICY for recycled agent
  assert.strictEqual(runtime.listRecycledAgents().length, 1);
  const recycled = runtime.getRecycledAgent('fallen_companion');
  assert.ok(recycled);
  assert.strictEqual(recycled.state, AGENT_STATES.RECYCLED);
  assert.strictEqual(recycled.recycleReason, 'Fell in battle');

  // Terminated agent rejects incoming messages on messaging bus with
  // AGENT_TERMINATED. The dead-letter address is the registration's canonical
  // identity key (Wave I, d57cbc1): a recycled registration is not resolvable
  // through the identity port (active-only), so the canonical key is what the
  // bus can classify as terminated.
  const deadLetterSend = bus.sendMessage({
    from: 'hero_agent',
    to: createAgentIdentityKey(recycled.config?.realmId ?? null, 'fallen_companion'),
    content: 'Wake up'
  });
  assert.strictEqual(deadLetterSend.success, false);
  assert.strictEqual(deadLetterSend.code, 'AGENT_TERMINATED', 'Recycled agent must be marked terminated on MessagingBus');

  // Verify event emission
  assert.strictEqual(stateRestoredEvents.length, 1);
  assert.strictEqual(stateRestoredEvents[0].type, 'state_restored');
  assert.ok(stateRestoredEvents[0].payload);

  // Restoration of invalid schema returns success: false
  const invalidResult = restoreRuntimeEnvironment({ invalid: true }, runtime);
  assert.strictEqual(invalidResult.success, false);
  assert.strictEqual(invalidResult.code, PERSISTENCE_ERROR_CODES.INVALID_STATE);
});

// ============================================================================
// 6. Storage Operations & Concurrency Lock Queue
// ============================================================================

test('6. Storage primitives (save, load, clear, has, saveLocked, resetSaveLockQueue)', async () => {
  sharedLocalStorage.clear();
  resetSaveLockQueue();

  const sampleState = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'agent_test',
    activeFsWorkspace: 'global',
    activeTab: 'chat',
    agents: [
      {
        id: 'agent_test',
        name: 'Tester',
        config: { id: 'agent_test' },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: []
      }
    ],
    recycleBin: [],
    virtualFs: {},
    messagingBus: { auditLog: [], inboxes: {}, registeredAgents: {} },
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };

  // 1. hasPersistedState on empty storage
  assert.strictEqual(hasPersistedState(), false);

  // 2. saveSandboxState with valid state
  const saveSuccess = saveSandboxState(sampleState);
  assert.strictEqual(saveSuccess, true);
  assert.strictEqual(hasPersistedState(), true);

  // 3. loadSandboxState
  const loaded = loadSandboxState();
  assert.ok(loaded);
  assert.strictEqual(loaded.version, '1.0.0');
  assert.strictEqual(loaded.activeAgentId, 'agent_test');
  assert.strictEqual(loaded.agents.length, 1);

  // 4. saveSandboxState with invalid state returns false
  const invalidSave = saveSandboxState({ version: '' });
  assert.strictEqual(invalidSave, false);

  // 5. Quota exceeded handling
  sharedLocalStorage.__simulateQuotaExceeded(true);
  const quotaSave = saveSandboxState(sampleState);
  assert.strictEqual(quotaSave, false, 'QuotaExceededError must be caught safely returning false');
  sharedLocalStorage.__simulateQuotaExceeded(false);

  // 6. Corrupted JSON in localStorage safely returns null on load
  sharedLocalStorage.setItem(SANDBOX_STATE_STORAGE_KEY, 'invalid-json{{{');
  const corruptedLoad = loadSandboxState();
  assert.strictEqual(corruptedLoad, null);

  // 7. Schema invalid payload in localStorage safely returns null
  sharedLocalStorage.setItem(SANDBOX_STATE_STORAGE_KEY, JSON.stringify({ version: '2.0.0', timestamp: 123 }));
  const invalidSchemaLoad = loadSandboxState();
  assert.strictEqual(invalidSchemaLoad, null);

  // 8. clearSandboxState
  const cleared = clearSandboxState();
  assert.strictEqual(cleared, true);
  assert.strictEqual(hasPersistedState(), false);
  assert.strictEqual(loadSandboxState(), null);

  // 9. saveSandboxStateLocked FIFO queue execution
  const save1Promise = saveSandboxStateLocked({ ...sampleState, activeAgentId: 'agent_lock_1' });
  const save2Promise = saveSandboxStateLocked({ ...sampleState, activeAgentId: 'agent_lock_2' });
  const save3Promise = saveSandboxStateLocked({ ...sampleState, activeAgentId: 'agent_lock_3' });

  const results = await Promise.all([save1Promise, save2Promise, save3Promise]);
  assert.deepStrictEqual(results, [true, true, true]);

  const finalLoaded = loadSandboxState();
  assert.strictEqual(finalLoaded.activeAgentId, 'agent_lock_3', 'Final locked save must be agent_lock_3');

  // 10. resetSaveLockQueue
  resetSaveLockQueue();
});

// ============================================================================
// 7. Burst-Coalescing Debounced Auto-Saver (createDebouncedSave)
// ============================================================================

test('7. createDebouncedSave coalesces writes, supports lazy suppliers, flushSync, isPending & cancel', async () => {
  let saveCalls = [];
  const mockSaveFn = (state) => {
    saveCalls.push({ ...state });
    return true;
  };

  const autoSaver = createDebouncedSave({
    delayMs: 50,
    saveFn: mockSaveFn,
    bindWindowEvents: false
  });

  const baseSnapshot = (id) => ({
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: id,
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [{ id, name: id, config: { id }, history: [] }]
  });

  // 1. isPending initially false
  assert.strictEqual(autoSaver.isPending(), false);

  // 2. Schedule rapid burst saves (coalescing)
  let callCount = 0;
  autoSaver.schedule(() => {
    callCount++;
    return baseSnapshot('call_1');
  });
  assert.strictEqual(autoSaver.isPending(), true);

  autoSaver.schedule(() => {
    callCount++;
    return baseSnapshot('call_2');
  });
  autoSaver.schedule(() => {
    callCount++;
    return baseSnapshot('call_3');
  });

  // Wait for debounce timer to fire
  await new Promise(r => setTimeout(r, 80));

  // Only the latest scheduled supplier must have been evaluated and saved
  assert.strictEqual(saveCalls.length, 1);
  assert.strictEqual(saveCalls[0].activeAgentId, 'call_3');
  assert.strictEqual(callCount, 1, 'Lazy supplier should only evaluate once on execution');
  assert.strictEqual(autoSaver.isPending(), false);

  // 3. flushSync forces immediate execution
  saveCalls = [];
  autoSaver.schedule(() => baseSnapshot('flushed_agent'));
  assert.strictEqual(autoSaver.isPending(), true);

  const flushed = autoSaver.flushSync();
  assert.strictEqual(flushed, true);
  assert.strictEqual(saveCalls.length, 1);
  assert.strictEqual(saveCalls[0].activeAgentId, 'flushed_agent');
  assert.strictEqual(autoSaver.isPending(), false);

  // 4. flush on idle coordinator returns true without error
  assert.strictEqual(autoSaver.flush(), true);

  // 5. cancel aborts scheduled save without saving
  saveCalls = [];
  autoSaver.schedule(() => baseSnapshot('cancelled_agent'));
  assert.strictEqual(autoSaver.isPending(), true);
  autoSaver.cancel();
  assert.strictEqual(autoSaver.isPending(), false);

  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(saveCalls.length, 0, 'Cancelled save must not write to storage');

  // 6. destroy tears down coordinator
  autoSaver.destroy();
  assert.strictEqual(autoSaver.isPending(), false);
});

// ============================================================================
// 8. Recovery Quarantine & Diagnostic Error Persistence (QA-012 / QA-013)
// ============================================================================

test('8. unreadable persisted state is quarantined + reported, and lastError survives sanitized hydration', async () => {
  sharedLocalStorage.clear();

  // --- QA-013: corrupt JSON is quarantined and reported (never silently reset) ---
  sharedLocalStorage.setItem(SANDBOX_STATE_STORAGE_KEY, '{broken json');
  const recoveryEvents = [];
  const corruptedLoad = loadSandboxState({ onRecovery: (info) => recoveryEvents.push(info) });
  assert.strictEqual(corruptedLoad, null, 'Corrupted state must load as null');
  assert.strictEqual(recoveryEvents.length, 1, 'Recovery listener must be notified exactly once');
  assert.strictEqual(recoveryEvents[0].reason, 'unparseable');
  assert.strictEqual(recoveryEvents[0].key, SANDBOX_STATE_STORAGE_KEY);
  assert.strictEqual(
    sharedLocalStorage.getItem(SANDBOX_STATE_STORAGE_KEY),
    null,
    'Canonical key must be cleared so the next save cannot silently overwrite the corrupt blob'
  );
  assert.strictEqual(hasPersistedState(), false, 'No persisted state remains after quarantine');
  if (recoveryEvents[0].quarantinedKey) {
    assert.strictEqual(
      sharedLocalStorage.getItem(recoveryEvents[0].quarantinedKey),
      '{broken json',
      'Corrupt blob must be preserved under the timestamped backup key'
    );
  }

  // Schema-invalid JSON is treated with the same quarantine + notice path
  sharedLocalStorage.setItem(SANDBOX_STATE_STORAGE_KEY, JSON.stringify({ version: '2.0.0', timestamp: 123 }));
  const schemaEvents = [];
  const invalidSchemaLoad = loadSandboxState({ onRecovery: (info) => schemaEvents.push(info) });
  assert.strictEqual(invalidSchemaLoad, null);
  assert.strictEqual(schemaEvents.length, 1);
  assert.strictEqual(schemaEvents[0].reason, 'invalid-schema');
  assert.strictEqual(sharedLocalStorage.getItem(SANDBOX_STATE_STORAGE_KEY), null);

  // A clean save after quarantine round-trips normally
  const cleanSnapshot = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'agent_quarantine',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [{
      id: 'agent_quarantine',
      name: 'Quarantine Agent',
      config: { id: 'agent_quarantine' },
      turnCount: 0,
      history: []
    }],
    recycleBin: [],
    agentDraftInputs: {}
  };
  assert.strictEqual(saveSandboxState(cleanSnapshot), true);
  assert.strictEqual(loadSandboxState()?.activeAgentId, 'agent_quarantine');
  sharedLocalStorage.clear();

  // --- QA-012: lastError is redacted in snapshots and restored onto hydration ---
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  await runtime.launchAgent({ id: 'agent_diag', name: 'Diagnostic Agent', role: 'tester' });
  const liveAgent = runtime.getAgent('agent_diag');
  liveAgent.lastError = 'OpenAI API error (401): invalid api_key=sk-test-live-secret-abcdef1234567890 Authorization: Bearer gsk_test_abcdef1234567890';

  const snapshot = serializeRuntimeEnvironment(runtime);
  const serializedAgent = snapshot.agents.find(a => a.id === 'agent_diag');
  assert.ok(serializedAgent, 'Serialized agent must be present');
  assert.ok(serializedAgent.lastError.includes('401'), 'Diagnostic prefix must be preserved');
  assert.ok(
    !serializedAgent.lastError.includes('sk-test-live-secret-abcdef1234567890'),
    'Raw credential value must never be persisted'
  );
  assert.ok(
    !serializedAgent.lastError.includes('gsk_test_abcdef1234567890'),
    'Bearer token must never be persisted'
  );
  assert.ok(serializedAgent.lastError.includes('[redacted]'), 'Redaction marker must be present');

  const restoredRuntime = new AgentRuntime({ autoBootstrapDirector: false });
  const restoreResult = restoreRuntimeEnvironment(snapshot, restoredRuntime);
  assert.strictEqual(restoreResult.success, true);
  const restoredAgent = restoredRuntime.getAgent('agent_diag');
  assert.ok(restoredAgent.lastError.includes('401'), 'Diagnostic reason must survive hydration');
  assert.ok(!restoredAgent.lastError.includes('sk-test-live-secret'), 'Hydrated diagnostic must stay redacted');

  sharedLocalStorage.clear();
});

// ============================================================================
// 9. Hydration Credential Resolver Injection (QA-022 RC-2)
// ============================================================================

test('9. hydrated agents receive the runtime credential resolver and resolve active credentials', () => {
  const resolverCalls = [];
  const resolver = Object.freeze({
    getCredential: (id) => {
      resolverCalls.push(['getCredential', id]);
      return null;
    },
    getActiveCredential: (providerId) => {
      resolverCalls.push(['getActiveCredential', providerId]);
      return providerId === 'custom' ? { id: 'cred_active_custom', apiKey: 'active-vault-key' } : null;
    }
  });

  const modelConfig = {
    providerId: 'custom',
    url: 'https://api.example.test/v1',
    modelId: 'test-model',
    keyId: 'cred_deleted'
  };

  const runtime = new AgentRuntime({ credentialResolver: resolver, autoBootstrapDirector: false });
  runtime.importSnapshot({
    version: '1.0.0',
    timestamp: Date.now(),
    agents: [
      {
        id: 'hydrated_agent',
        name: 'Hydrated Agent',
        config: { id: 'hydrated_agent', name: 'Hydrated Agent', modelConfig },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        redoStack: [],
        history: []
      }
    ],
    recycleBin: [
      {
        id: 'hydrated_recycled',
        name: 'Hydrated Recycled',
        config: { id: 'hydrated_recycled', name: 'Hydrated Recycled', modelConfig },
        turnCount: 0,
        recycledAt: '2026-09-18T00:00:00.000Z',
        recycleReason: 'Recycled for resolver coverage',
        redoStack: [],
        history: []
      }
    ]
  });

  const agent = runtime.getAgent('hydrated_agent');
  assert.ok(agent, 'Hydrated active agent must exist');
  assert.strictEqual(agent.credentialResolver, resolver, 'Hydration must inject the runtime credential resolver');
  assert.strictEqual(agent.provider.vault, resolver, 'Hydrated provider must hold the resolver as its vault');
  assert.strictEqual(agent.provider.credentialId, 'cred_active_custom', 'Dangling keyId must fall back to the vault active credential');
  assert.strictEqual(agent.provider.getEffectiveApiKey(), 'active-vault-key');
  assert.ok(
    resolverCalls.some(([method, arg]) => method === 'getCredential' && arg === 'cred_deleted'),
    'Hydration must attempt the persisted keyId before falling back'
  );

  const recycledAgent = runtime.getRecycledAgent('hydrated_recycled');
  assert.ok(recycledAgent, 'Hydrated recycled agent must exist');
  assert.strictEqual(recycledAgent.credentialResolver, resolver, 'Recycled hydration must inject the resolver too');
  assert.strictEqual(recycledAgent.provider.vault, resolver);
  assert.strictEqual(recycledAgent.provider.getEffectiveApiKey(), 'active-vault-key');

  runtime.destroy();
});

// ============================================================================
// 10. Restore Target Validation (missing runtime must never report success)
// ============================================================================

test('10. restoreRuntimeEnvironment fails clearly when no live runtime is supplied', () => {
  const validState = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: null,
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: 'runtime_guard_agent',
        name: 'Runtime Guard Agent',
        config: { id: 'runtime_guard_agent' },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: []
      }
    ],
    recycleBin: [],
    virtualFs: {},
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, inboxes: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };

  const invalidTargets = [null, undefined, {}, { runtime: null }, { runtime: {} }];
  for (const target of invalidTargets) {
    const result = restoreRuntimeEnvironment(validState, target);
    assert.strictEqual(result.success, false, `Restore must not claim success for target ${JSON.stringify(target)}`);
    assert.strictEqual(result.code, PERSISTENCE_ERROR_CODES.HYDRATION_FAILED);
    assert.match(result.error, /runtime/i);
    assert.strictEqual(result.metadata, undefined, 'No metadata is produced on a failed restore');
  }
});

// ============================================================================
// 11. Quarantine Backup Failure & Whitespace-Only State
// ============================================================================

test('11. quarantine reports no backup key when the backup write fails; whitespace-only state is absent', () => {
  sharedLocalStorage.clear();

  // Quota exhaustion blocks the timestamped backup write while removal still succeeds.
  sharedLocalStorage.setItem(SANDBOX_STATE_STORAGE_KEY, '{broken json');
  sharedLocalStorage.__simulateQuotaExceeded(true);
  const recoveryEvents = [];
  const corruptedLoad = loadSandboxState({ onRecovery: (info) => recoveryEvents.push(info) });
  sharedLocalStorage.__simulateQuotaExceeded(false);

  assert.strictEqual(corruptedLoad, null);
  assert.strictEqual(recoveryEvents.length, 1);
  assert.strictEqual(recoveryEvents[0].reason, 'unparseable');
  assert.strictEqual(recoveryEvents[0].quarantinedKey, null, 'Failed backup write must not report a quarantine key');
  assert.strictEqual(
    sharedLocalStorage.getItem(SANDBOX_STATE_STORAGE_KEY),
    null,
    'Canonical key must still be cleared so the next save cannot overwrite the corrupt blob'
  );

  // Whitespace-only entries must be treated as absent on the facade and fallback paths.
  sharedLocalStorage.setItem(SANDBOX_STATE_STORAGE_KEY, '   ');
  assert.strictEqual(hasPersistedState(), false, 'Whitespace-only default-key entry must count as absent');
  assert.strictEqual(hasPersistedState({ storageKey: SANDBOX_STATE_STORAGE_KEY }), false);

  const customKey = 'custom_whitespace_state_key';
  sharedLocalStorage.setItem(customKey, '\n\t  ');
  assert.strictEqual(hasPersistedState({ storageKey: customKey }), false, 'Whitespace-only custom-key entry must count as absent');

  sharedLocalStorage.setItem(customKey, JSON.stringify({ version: '1.0.0', timestamp: Date.now(), agents: [] }));
  assert.strictEqual(hasPersistedState({ storageKey: customKey }), true, 'Non-empty custom-key entry must be detected');

  sharedLocalStorage.clear();
});

// ============================================================================
// 12. Emitted Snapshot Shapes (cross-module alignment guard)
// ============================================================================

test('12. serialized subsystem snapshots expose the emitted cross-module shapes', async () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/shape.txt', 'shape content', { workspaceId: 'global' });

  const bus = new MessagingBus({ virtualFs: vfs });
  bus.registerAgent('dispatcher', { mode: 'queued', privileged: true });
  bus.registerAgent('shape_agent', { mode: 'queued', privileged: false });
  bus.sendMessage({ from: 'dispatcher', to: 'shape_agent', content: 'queued message' });

  const clock = new WorldClock({ virtualFs: vfs });
  const registered = clock.registerEvent(
    { name: 'Solar Noon', description: 'The sun peaks.', offsetSeconds: 60, category: 'celestial', priority: 'high' },
    { isAdmin: true, callerAgentId: 'system' }
  );
  assert.strictEqual(registered.success, true, 'Event registration fixture must succeed');

  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    worldClock: clock,
    autoBootstrapDirector: false
  });
  await runtime.launchAgent({ id: 'shape_agent', name: 'Shape Agent' });

  const snapshot = serializeRuntimeEnvironment({ runtime, virtualFs: vfs, messagingBus: bus, worldClock: clock });

  // VirtualFS persisted file shape: path/workspaceId/owner, no createdAt/permissions.
  const persistedFile = snapshot.virtualFs.global['/shape.txt'];
  assert.ok(persistedFile, 'Persisted VFS file must exist');
  assert.strictEqual(persistedFile.path, '/shape.txt');
  assert.strictEqual(persistedFile.workspaceId, 'global');
  assert.strictEqual(persistedFile.content, 'shape content');
  assert.strictEqual(typeof persistedFile.size, 'number');
  assert.strictEqual(typeof persistedFile.updatedAt, 'number');
  assert.strictEqual(persistedFile.readOnly, false);
  assert.strictEqual(typeof persistedFile.owner, 'string');
  assert.strictEqual(persistedFile.createdAt, undefined);
  assert.strictEqual(persistedFile.permissions, undefined);

  // MessagingBus snapshot shape: activeQueues/archives/inboxes alias/terminatedAgents.
  const busSnapshot = snapshot.messagingBus;
  assert.ok(Array.isArray(busSnapshot.auditLog));
  assert.ok(busSnapshot.activeQueues && typeof busSnapshot.activeQueues === 'object');
  assert.ok(busSnapshot.archives && typeof busSnapshot.archives === 'object');
  assert.deepStrictEqual(busSnapshot.inboxes, busSnapshot.activeQueues, 'inboxes is the emitted alias of activeQueues');
  assert.ok(Array.isArray(busSnapshot.terminatedAgents));
  assert.ok(Array.isArray(busSnapshot.activeQueues.shape_agent));
  const queuedEnvelope = busSnapshot.activeQueues.shape_agent[0];
  assert.strictEqual(typeof queuedEnvelope.id, 'string');
  assert.strictEqual(queuedEnvelope.messageId, queuedEnvelope.id);
  assert.strictEqual(queuedEnvelope.from, 'dispatcher');
  assert.strictEqual(queuedEnvelope.to, 'shape_agent');
  assert.strictEqual(typeof queuedEnvelope.replyTo, 'string');
  assert.strictEqual(typeof queuedEnvelope.content, 'string');
  assert.strictEqual(queuedEnvelope.read, false);

  // WorldClock snapshot shape: date/agentClocks/agentEvents plus real WorldEvent fields.
  const worldSnapshot = snapshot.worldClock;
  assert.ok(worldSnapshot);
  assert.strictEqual(typeof worldSnapshot.date, 'string');
  assert.ok(worldSnapshot.agentClocks && typeof worldSnapshot.agentClocks === 'object');
  assert.ok(worldSnapshot.agentEvents && typeof worldSnapshot.agentEvents === 'object');
  assert.ok(Array.isArray(worldSnapshot.events));
  const event = worldSnapshot.events.find(ev => ev.name === 'Solar Noon');
  assert.ok(event, 'Registered event must be present in the flattened events array');
  assert.strictEqual(typeof event.id, 'string');
  assert.strictEqual(typeof event.triggerTime, 'number');
  assert.strictEqual(typeof event.category, 'string');
  assert.strictEqual(typeof event.priority, 'string');
  assert.strictEqual(typeof event.status, 'string');
  assert.strictEqual(typeof event.ownerId, 'string');
  assert.strictEqual(typeof event.createdAtRealTime, 'number');
  assert.strictEqual(event.title, undefined, 'WorldEvent carries `name`, not the legacy `title` field');
  assert.strictEqual(event.timestamp, undefined, 'WorldEvent does not carry `timestamp`');

  runtime.destroy();
});

// ============================================================================
// 13. Subsystem Receipt Propagation (9c496da)
// ============================================================================

test('13. restoreRuntimeEnvironment fails with the WorldClock corruption receipt instead of reporting success', () => {
  const vfs = new VirtualFS();
  const bus = new MessagingBus({ virtualFs: vfs });
  const clock = new WorldClock({ virtualFs: vfs });
  clock.advanceClock({ seconds: 120 }, { isAdmin: true });
  const runtime = new AgentRuntime({
    virtualFs: vfs,
    messagingBus: bus,
    worldClock: clock,
    autoBootstrapDirector: false
  });

  const corruptState = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'receipt_agent',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: 'receipt_agent',
        name: 'Receipt Agent',
        config: { id: 'receipt_agent' },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        redoStack: [],
        history: []
      }
    ],
    recycleBin: [],
    virtualFs: {
      global: {
        '/receipt_probe.txt': {
          path: '/receipt_probe.txt',
          workspaceId: 'global',
          content: 'hydrated body',
          size: 13,
          updatedAt: Date.now(),
          readOnly: false,
          owner: 'system'
        }
      }
    },
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    worldClock: { totalSeconds: 999, date: 'Day 9', events: [{ name: 'Missing id event' }] },
    agentDraftInputs: {}
  };

  // Schema validation passes (worldClock.events is an array); the corruption is only
  // detectable through the WorldClock import receipt.
  assert.strictEqual(validateSandboxState(corruptState).valid, true);

  const result = restoreRuntimeEnvironment(
    corruptState,
    { runtime, virtualFs: vfs, messagingBus: bus, worldClock: clock }
  );

  assert.strictEqual(result.success, false, 'A rejected clock snapshot must never report success');
  assert.strictEqual(result.code, PERSISTENCE_ERROR_CODES.HYDRATION_FAILED);
  assert.match(result.error, /worldClock: Corrupted snapshot/);
  assert.ok(
    Array.isArray(result.details) && result.details.some((detail) => detail.includes('events[0]')),
    'Per-entry clock corruption details must surface in RestoreResult.details'
  );

  const clockReceipt = result.receipts.find((receipt) => receipt.subsystem === 'worldClock');
  assert.ok(clockReceipt, 'WorldClock import receipt must be captured');
  assert.strictEqual(clockReceipt.success, false);
  assert.strictEqual(clockReceipt.code, 'CORRUPTED_SNAPSHOT');
  assert.ok(Array.isArray(clockReceipt.details) && clockReceipt.details.length > 0);
  assert.deepStrictEqual(
    result.receipts.filter((receipt) => receipt.success).map((receipt) => receipt.subsystem).sort(),
    ['messagingBus', 'virtualFs'],
    'Accepted subsystem receipts must remain attached alongside the rejecting one'
  );

  // Partial/degraded semantics: remaining stages hydrated, rejected clock kept its prior state.
  assert.ok(runtime.getAgent('receipt_agent'), 'Runtime body still hydrates on partial failure');
  assert.strictEqual(
    vfs.readFile('/receipt_probe.txt', { workspaceId: 'global' }).content,
    'hydrated body',
    'VirtualFS still hydrates on partial failure'
  );
  assert.strictEqual(
    runtime.createPersistencePort().worldClock.exportSnapshot().totalSeconds,
    120,
    'Atomic clock rejection leaves the prior clock state untouched'
  );

  // A clean snapshot restores with all-success receipts.
  const cleanState = { ...corruptState, worldClock: { totalSeconds: 999, date: 'Day 9', events: [] } };
  const clean = restoreRuntimeEnvironment(
    cleanState,
    { runtime, virtualFs: vfs, messagingBus: bus, worldClock: clock }
  );
  assert.strictEqual(clean.success, true);
  assert.ok(clean.receipts.every((receipt) => receipt.success === true));
  assert.strictEqual(clean.receipts.find((receipt) => receipt.subsystem === 'worldClock').success, true);
  assert.strictEqual(runtime.createPersistencePort().worldClock.exportSnapshot().totalSeconds, 999);

  runtime.destroy();
});

// ============================================================================
// 14. Entity Snapshot Contract Persistence Round-Trip (ed65f49)
// ============================================================================

test('14. serialize/restore round-trips lastInterruptedTurn and redacted lastError through the entity contract', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  await runtime.launchAgent({ id: 'entity_contract_agent', name: 'Entity Contract Agent', role: 'tester' });
  const liveAgent = runtime.getAgent('entity_contract_agent');

  const interruptedTurn = {
    input: 'Draft the opening scene',
    mode: 'chat',
    timestamp: 1773700000000,
    cancelled: true
  };
  liveAgent.lastInterruptedTurn = interruptedTurn;
  liveAgent.lastError = 'Provider timeout with token=sk-test-live-secret-abcdef1234567890';

  const snapshot = serializeRuntimeEnvironment(runtime);
  const persistedAgent = snapshot.agents.find((agent) => agent.id === 'entity_contract_agent');
  assert.ok(persistedAgent, 'Serialized agent must be present');
  assert.deepStrictEqual(
    persistedAgent.lastInterruptedTurn,
    interruptedTurn,
    'Save must carry the entity-owned interrupted-turn record'
  );
  assert.ok(persistedAgent.lastError.includes('Provider timeout'), 'Diagnostic prefix must be preserved');
  assert.ok(
    !persistedAgent.lastError.includes('sk-test-live-secret-abcdef1234567890'),
    'Persisted diagnostic must stay redacted'
  );

  const restoredRuntime = new AgentRuntime({ autoBootstrapDirector: false });
  const restoreResult = restoreRuntimeEnvironment(snapshot, restoredRuntime);
  assert.strictEqual(restoreResult.success, true);

  const restoredAgent = restoredRuntime.getAgent('entity_contract_agent');
  assert.ok(restoredAgent, 'Agent must be restored');
  assert.deepStrictEqual(
    restoredAgent.lastInterruptedTurn,
    interruptedTurn,
    'Restore must hydrate the interrupted-turn record through Agent.fromSnapshot'
  );
  assert.notStrictEqual(
    restoredAgent.lastInterruptedTurn,
    persistedAgent.lastInterruptedTurn,
    'Hydrated interrupted-turn record must be a deep copy'
  );
  assert.ok(restoredAgent.lastError.includes('Provider timeout'), 'Diagnostic reason must survive hydration');
  assert.ok(
    !restoredAgent.lastError.includes('sk-test-live-secret-abcdef1234567890'),
    'Hydrated diagnostic must stay redacted'
  );
  assert.strictEqual(restoredAgent.state, AGENT_STATES.IDLE, 'Restore still normalizes active agents to IDLE');

  runtime.destroy();
  restoredRuntime.destroy();
});

// ============================================================================
// 15. Authority Trust Is Never Persisted (MOD-21 W5, 43a36a1)
// ============================================================================

test('15. serialize/restore drops authority claims and re-derives default-deny authority', () => {
  const privilegedAgent = new Agent({
    id: 'persisted_privileged_agent',
    name: 'Persisted Privileged',
    privileged: true,
    allowedTools: ['*']
  });
  const snapshot = serializeRuntimeEnvironment({
    runtime: {
      listAgents: () => [privilegedAgent],
      listRecycledAgents: () => [],
      exportSchedules: () => []
    }
  });
  const persistedAgent = snapshot.agents.find((agent) => agent.id === 'persisted_privileged_agent');
  assert.ok(persistedAgent, 'Serialized agent must be present');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(persistedAgent.config, 'privileged'),
    false,
    'Save must not persist caller-asserted authority'
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(persistedAgent, 'authority'),
    false,
    'Save must not serialize the frozen authority descriptor'
  );

  const restoredRuntime = new AgentRuntime({ autoBootstrapDirector: false });
  const restoreResult = restoreRuntimeEnvironment(snapshot, restoredRuntime);
  assert.strictEqual(restoreResult.success, true);

  const restoredAgent = restoredRuntime.getAgent('persisted_privileged_agent');
  assert.ok(restoredAgent, 'Agent must be restored');
  assert.notStrictEqual(restoredAgent.config.privileged, true, 'Restore must not honor persisted privilege');
  assert.strictEqual(restoredAgent.authority.allow.size, 0, 'Restored authority is re-derived default-deny');
  assert.strictEqual(restoredRuntime.whoami('persisted_privileged_agent').privileged, false);
  assert.strictEqual(
    restoredRuntime.createAgentIdentityPort().getAgentIdentity('persisted_privileged_agent').authority.allow.size,
    0,
    'Registry descriptor is re-derived default-deny; a persisted wildcard whitelist grants nothing'
  );

  restoredRuntime.destroy();
});

test('16. restoreRuntimeEnvironment downgrades crafted privilege claims and fails closed on schema-invalid claims', () => {
  const craftedState = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'crafted_privileged_agent',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: 'crafted_privileged_agent',
        name: 'Crafted Privileged Agent',
        config: { id: 'crafted_privileged_agent', privileged: true, allowedTools: ['*'] },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pendingPrecalls: [],
        redoStack: [],
        history: []
      }
    ],
    recycleBin: [],
    virtualFs: {},
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };

  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const result = restoreRuntimeEnvironment(craftedState, runtime);
  assert.strictEqual(result.success, true, 'A tampered claim downgrades silently rather than rejecting the snapshot');

  const restoredAgent = runtime.getAgent('crafted_privileged_agent');
  assert.ok(restoredAgent, 'Agent must be restored');
  assert.notStrictEqual(restoredAgent.config.privileged, true, 'Crafted privilege claim must not be honored');
  assert.strictEqual(restoredAgent.authority.allow.size, 0, 'Crafted allowedTools wildcard grants no authority');
  assert.ok(restoredAgent.authorityDowngrade, 'Ignored claim must be recorded on the entity');
  assert.strictEqual(runtime.whoami('crafted_privileged_agent').privileged, false);
  assert.strictEqual(
    runtime.createAgentIdentityPort().getAgentIdentity('crafted_privileged_agent').authority.allow.size,
    0,
    'Registry descriptor is re-derived default-deny for crafted snapshots'
  );
  runtime.destroy();

  const invalidState = {
    ...craftedState,
    agents: [
      {
        ...craftedState.agents[0],
        id: 'schema_invalid_agent',
        config: { id: 'schema_invalid_agent', privileged: 'yes' }
      }
    ]
  };
  const invalidRuntime = new AgentRuntime({ autoBootstrapDirector: false });
  const invalidResult = restoreRuntimeEnvironment(invalidState, invalidRuntime);
  assert.strictEqual(invalidResult.success, false, 'Schema-invalid authority claims fail closed');
  assert.strictEqual(invalidResult.code, PERSISTENCE_ERROR_CODES.HYDRATION_FAILED);
  assert.strictEqual(invalidRuntime.getAgent('schema_invalid_agent'), null, 'Fail-closed restore installs no agent');
  invalidRuntime.destroy();
});

test('17. Hydrated wildcard whitelist cannot dispatch tools (MOD-21 W8, 8042808)', async () => {
  const craftedState = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: 'hydrated_wildcard_agent',
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: 'hydrated_wildcard_agent',
        name: 'Hydrated Wildcard Agent',
        config: { id: 'hydrated_wildcard_agent', allowedTools: ['*'] },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pendingPrecalls: [],
        redoStack: [],
        history: []
      }
    ],
    recycleBin: [],
    virtualFs: {},
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };

  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    const result = restoreRuntimeEnvironment(structuredClone(craftedState), runtime);
    assert.strictEqual(result.success, true);

    const agent = runtime.getAgent('hydrated_wildcard_agent');
    assert.ok(agent, 'Agent must restore');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(agent.config, 'allowedTools'),
      false,
      'Persisted capability selectors must be withheld from the restored config'
    );

    const dispatcher = createSandboxToolDispatcher({
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      agentId: 'hydrated_wildcard_agent',
      privileged: Boolean(agent.config?.privileged),
      allowedTools: agent.config.allowedTools,
      lifecyclePort: runtime.createLifecyclePort(),
      identityPort: runtime.createAgentIdentityPort(),
      worldClock: runtime.worldClock
    });
    const receipt = await dispatcher.executeTool('write_file', { file_path: 'x.txt', content: 'x' });
    assert.strictEqual(receipt.success, false, 'A hydrated whitelist must not grant tool execution');
    assert.strictEqual(receipt.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('18. restoreRuntimeEnvironment canonicalizes persisted agent ids before the runtime sees them (1398527/38a64ae)', () => {
  const captured = [];
  const stubRuntime = {
    importSnapshot: (snapshot) => {
      captured.push(snapshot);
    }
  };

  const state = {
    version: '1.0.0',
    timestamp: Date.now(),
    activeAgentId: null,
    activeFsWorkspace: 'global',
    activeTab: 'inspector',
    agents: [
      {
        id: '  director  ',
        name: 'Padded Director',
        config: { id: '\tdirector\n', role: 'user' },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pendingPrecalls: [],
        redoStack: [],
        history: []
      },
      {
        id: '  padded_analyst  ',
        name: 'Padded Analyst',
        config: { id: 'padded_analyst ' },
        turnCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pendingPrecalls: [],
        redoStack: [],
        history: []
      }
    ],
    recycleBin: [],
    virtualFs: {},
    messagingBus: { auditLog: [], activeQueues: {}, archives: {}, registeredAgents: {}, terminatedAgents: [] },
    scheduledTimers: [],
    worldClock: null,
    agentDraftInputs: {}
  };

  const result = restoreRuntimeEnvironment(state, { runtime: stubRuntime });
  assert.strictEqual(result.success, true, 'the normalized snapshot must restore cleanly through the stub runtime');
  assert.strictEqual(captured.length, 1, 'the normalized snapshot must reach the runtime boundary');

  const [director, analyst] = captured[0].agents;
  assert.strictEqual(director.id, 'director', 'entry id must be canonical before hydration');
  assert.strictEqual(director.config.id, 'director', 'config.id must be canonical before hydration');
  assert.strictEqual(analyst.id, 'padded_analyst', 'non-reserved padded ids canonicalize too');
  assert.strictEqual(analyst.config.id, 'padded_analyst');

  assert.strictEqual(state.agents[0].id, '  director  ', 'the caller snapshot must never be mutated');
  assert.strictEqual(state.agents[0].config.id, '\tdirector\n', 'the caller config must never be mutated');
});

// ============================================================================
// 19. Self-Contained Storage: canonical key literal & byte compatibility
// ============================================================================

test('19. persisted key and JSON format stay byte-compatible after the legacy storage retirement', () => {
  sharedLocalStorage.clear();

  // The inlined key must be the frozen literal, not a lookup into legacy storage.
  assert.strictEqual(SANDBOX_STATE_STORAGE_KEY, 'ai_storyteller_sandbox_state_v1');

  // A snapshot written under the literal key by the pre-retirement facade must load.
  const legacyWrittenSnapshot = {
    version: '1.0.0',
    timestamp: 1750000000000,
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
  sharedLocalStorage.setItem('ai_storyteller_sandbox_state_v1', JSON.stringify(legacyWrittenSnapshot));

  const loaded = loadSandboxState();
  assert.ok(loaded, 'Snapshot stored under the canonical literal key must load unchanged');
  assert.strictEqual(loaded.timestamp, legacyWrittenSnapshot.timestamp);

  // Saving must reproduce the exact pre-retirement wire format under the same key.
  assert.strictEqual(saveSandboxState(legacyWrittenSnapshot), true);
  assert.strictEqual(
    sharedLocalStorage.getItem('ai_storyteller_sandbox_state_v1'),
    JSON.stringify(legacyWrittenSnapshot),
    'Serialized bytes must match the pre-retirement storage facade exactly'
  );

  sharedLocalStorage.clear();
});

// ============================================================================
// 20. MOD-20 presetId binding is explicit in the sanitized config contract
// ============================================================================

test('20. presetId binding persists and hydrates through the sanitized config unchanged', () => {
  const boundAgent = new Agent({
    id: 'persisted_preset_agent',
    name: 'Persisted Preset Agent',
    presetId: 'preset_official_deepseek_chat',
    modelConfig: { providerId: 'deepseek', keyId: 'canonical_deepseek', modelId: 'deepseek-chat' }
  });

  const snapshot = serializeRuntimeEnvironment({
    runtime: {
      listAgents: () => [boundAgent],
      listRecycledAgents: () => [],
      exportSchedules: () => []
    }
  });
  const persistedAgent = snapshot.agents.find((agent) => agent.id === 'persisted_preset_agent');
  assert.ok(persistedAgent, 'Serialized agent must be present');
  assert.strictEqual(
    persistedAgent.config.presetId,
    'preset_official_deepseek_chat',
    'The preset binding must survive credential-stripping serialization as plain data'
  );

  const restoredRuntime = new AgentRuntime({ autoBootstrapDirector: false });
  const restoreResult = restoreRuntimeEnvironment(snapshot, restoredRuntime);
  assert.strictEqual(restoreResult.success, true, 'Snapshot with a presetId binding must validate and restore');

  const restoredAgent = restoredRuntime.getAgent('persisted_preset_agent');
  assert.ok(restoredAgent, 'Agent must be restored');
  assert.strictEqual(
    restoredAgent.config.presetId,
    'preset_official_deepseek_chat',
    'Hydration without a preset source adopts the persisted binding unchanged'
  );

  restoredRuntime.destroy();
  sharedLocalStorage.clear();
});

// ============================================================================
// 21. Wave A additive realm registry field: round-trip, back-compat, drop-invalid
// ============================================================================

test('21. realm records round-trip and invalid values are dropped on load', () => {
  sharedLocalStorage.clear();

  const realm = {
    id: 'realm_persist22',
    name: 'Persist 22',
    description: 'demo realm',
    color: '#88aaff',
    templateId: 'tpl_demo',
    createdAt: 1700000000000
  };

  const runtimeStub = {
    listAgents: () => [],
    listRecycledAgents: () => [],
    exportSchedules: () => []
  };
  const snapshot = serializeRuntimeEnvironment({ runtime: runtimeStub }, { realms: [realm] });

  assert.strictEqual(snapshot.realms.length, 1);
  assert.deepStrictEqual(snapshot.realms[0], realm);
  assert.notStrictEqual(snapshot.realms[0], realm, 'Serialization must copy realm records');
  assert.strictEqual(realm.apiKey, undefined, 'Serialization must not mutate the caller metadata');

  // Unknown fields on an ingested record are dropped by the canonical copy.
  const withUnknown = serializeRuntimeEnvironment(
    { runtime: runtimeStub },
    { realms: [{ ...realm, apiKey: 'sk-test-should-be-stripped', unknownField: { nested: true } }] }
  );
  assert.deepStrictEqual(
    Object.keys(withUnknown.realms[0]).sort(),
    ['color', 'createdAt', 'description', 'id', 'name', 'templateId']
  );
  assert.strictEqual(withUnknown.realms[0].apiKey, undefined);

  // An empty registry omits the field so legacy wire bytes are unchanged.
  const bare = serializeRuntimeEnvironment({ runtime: runtimeStub });
  assert.ok(!('realms' in bare), 'An empty realm projection must omit the field');

  // Snapshot validation keeps valid realm fields and its input identity.
  const validated = validateSandboxState(snapshot);
  assert.strictEqual(validated.valid, true);
  assert.strictEqual(validated.state, snapshot, 'Valid realm fields must not force a snapshot copy');
  assert.deepStrictEqual(validated.state.realms, snapshot.realms);

  assert.strictEqual(saveSandboxState(snapshot), true);
  const loaded = loadSandboxState();
  assert.ok(loaded, 'Snapshot with realm records must load');
  assert.deepStrictEqual(loaded.realms, snapshot.realms, 'Realm records must round-trip through storage');

  // Unknown top-level snapshot fields are preserved (no schema-narrowing copy).
  const futureField = { ...snapshot, futureTopology: { anything: true } };
  const futureValidated = validateSandboxState(futureField);
  assert.strictEqual(futureValidated.valid, true);
  assert.strictEqual(futureValidated.state, futureField, 'Unknown top-level fields must survive validation');
  assert.deepStrictEqual(futureValidated.state.futureTopology, { anything: true });

  // Back-compat: legacy snapshots without the field load unchanged and keep identity.
  const legacy = { ...snapshot };
  delete legacy.realms;
  const legacyValidated = validateSandboxState(legacy);
  assert.strictEqual(legacyValidated.valid, true);
  assert.strictEqual(legacyValidated.state, legacy, 'Legacy snapshots must keep their identity');
  assert.strictEqual(legacyValidated.state.realms, undefined);
  assert.strictEqual(saveSandboxState(legacy), true);
  const legacyLoaded = loadSandboxState();
  assert.ok(legacyLoaded);
  assert.strictEqual(legacyLoaded.realms, undefined);

  // Invalid values are dropped, never fail the snapshot, and never mutate the input.
  const invalid = {
    ...snapshot,
    realms: [
      realm,
      { id: '', name: 'Broken', createdAt: 1 },
      { id: 'realm_no_name', name: '', createdAt: 1 },
      { id: 'realm_no_created', name: 'Missing createdAt' },
      { id: 'realm_bad_created', name: 'Bad createdAt', createdAt: 'yesterday' },
      { id: 'realm_bad_color', name: 'Bad color', color: 42, createdAt: 1 },
      'garbage',
      null
    ]
  };
  const invalidValidated = validateSandboxState(invalid);
  assert.strictEqual(invalidValidated.valid, true, 'Invalid optional realm entries must not fail validation');
  assert.strictEqual(invalidValidated.state.realms.length, 1, 'Invalid realm entries must be dropped individually');
  assert.strictEqual(invalidValidated.state.realms[0].id, 'realm_persist22');
  assert.strictEqual(invalid.realms.length, 8, 'Validation must not mutate the input array');

  const nonArray = { ...snapshot, realms: 'not-an-array' };
  const nonArrayValidated = validateSandboxState(nonArray);
  assert.strictEqual(nonArrayValidated.valid, true);
  assert.strictEqual(nonArrayValidated.state.realms, undefined, 'Non-array realms must be dropped');

  // Prototype pollution inside a realm record is still rejected.
  const pollutedRealm = JSON.parse('{"id":"realm_p","name":"P","createdAt":1,"__proto__":{"polluted":true}}');
  const polluted = { ...snapshot, realms: [pollutedRealm] };
  const pollutedResult = validateSandboxState(polluted);
  assert.strictEqual(pollutedResult.valid, false);
  assert.strictEqual(pollutedResult.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);

  sharedLocalStorage.clear();
});

// ============================================================================
// 22. MOD-20 additive preset fields: round-trip, back-compat, drop-invalid
// ============================================================================

test('22. MOD-20 preset fields round-trip and invalid values are dropped on load', () => {
  sharedLocalStorage.clear();

  const preset = {
    id: 'preset_custom_persist21',
    name: 'Persist 21',
    isCustom: true,
    modelConfig: {
      providerId: 'custom',
      url: 'https://api.example.test/v1',
      modelId: 'persist-21-model',
      temperature: 0.3,
      keyId: 'should-be-stripped',
      apiKey: 'sk-test-should-be-stripped',
      encryptionKey: 'kek-test-should-be-stripped'
    }
  };

  const runtimeStub = {
    listAgents: () => [],
    listRecycledAgents: () => [],
    exportSchedules: () => []
  };
  const snapshot = serializeRuntimeEnvironment(
    { runtime: runtimeStub },
    { activePresetId: 'preset_custom_persist21', customPresets: [preset] }
  );

  assert.strictEqual(snapshot.activePresetId, 'preset_custom_persist21');
  assert.strictEqual(snapshot.customPresets.length, 1);
  assert.strictEqual(snapshot.customPresets[0].modelConfig.modelId, 'persist-21-model');
  assert.strictEqual(snapshot.customPresets[0].modelConfig.keyId, undefined, 'Credential keyId must be stripped from persisted presets');
  assert.strictEqual(snapshot.customPresets[0].modelConfig.apiKey, undefined, 'Credential apiKey must be stripped from persisted presets');
  assert.strictEqual(snapshot.customPresets[0].modelConfig.encryptionKey, undefined, 'Credential encryptionKey must be stripped from persisted presets');
  assert.strictEqual(snapshot.customPresets[0].modelConfig.temperature, 0.3);
  assert.strictEqual(preset.modelConfig.keyId, 'should-be-stripped', 'Serialization must not mutate the caller metadata');

  // Snapshot validation keeps valid additive fields and its input identity.
  const validated = validateSandboxState(snapshot);
  assert.strictEqual(validated.valid, true);
  assert.strictEqual(validated.state, snapshot, 'Valid preset fields must not force a snapshot copy');
  assert.deepStrictEqual(validated.state.customPresets, snapshot.customPresets);

  assert.strictEqual(saveSandboxState(snapshot), true);
  const loaded = loadSandboxState();
  assert.ok(loaded, 'Snapshot with preset fields must load');
  assert.strictEqual(loaded.activePresetId, 'preset_custom_persist21');
  assert.strictEqual(loaded.customPresets[0].modelConfig.modelId, 'persist-21-model');

  // Back-compat: legacy snapshots without the fields load unchanged.
  const legacy = { ...snapshot };
  delete legacy.activePresetId;
  delete legacy.customPresets;
  const legacyValidated = validateSandboxState(legacy);
  assert.strictEqual(legacyValidated.valid, true);
  assert.strictEqual(legacyValidated.state, legacy, 'Legacy snapshots must keep their identity');
  assert.strictEqual(saveSandboxState(legacy), true);
  const legacyLoaded = loadSandboxState();
  assert.ok(legacyLoaded);
  assert.strictEqual(legacyLoaded.activePresetId, undefined);
  assert.strictEqual(legacyLoaded.customPresets, undefined);

  // Invalid values are dropped, never fail the snapshot, and never mutate the input.
  const invalid = {
    ...snapshot,
    activePresetId: 42,
    customPresets: [
      preset,
      { id: '', name: 'Broken', isCustom: true, modelConfig: { providerId: 'x', modelId: 'y' } },
      'garbage'
    ]
  };
  const invalidValidated = validateSandboxState(invalid);
  assert.strictEqual(invalidValidated.valid, true, 'Invalid optional preset fields must not fail validation');
  assert.strictEqual(invalidValidated.state.activePresetId, undefined, 'Invalid activePresetId must be dropped');
  assert.strictEqual(invalidValidated.state.customPresets.length, 1, 'Invalid custom preset entries must be dropped individually');
  assert.strictEqual(invalidValidated.state.customPresets[0].id, 'preset_custom_persist21');
  assert.strictEqual(invalid.activePresetId, 42, 'Validation must not mutate its input');
  assert.strictEqual(invalid.customPresets.length, 3, 'Validation must not mutate the input array');

  const nonArray = { ...snapshot, customPresets: 'not-an-array' };
  const nonArrayValidated = validateSandboxState(nonArray);
  assert.strictEqual(nonArrayValidated.valid, true);
  assert.strictEqual(nonArrayValidated.state.customPresets, undefined, 'Non-array customPresets must be dropped');

  // Prototype pollution inside a preset modelConfig is still rejected.
  const pollutedPreset = JSON.parse('{"id":"p","name":"P","isCustom":true,"modelConfig":{"providerId":"custom","modelId":"m","__proto__":{"polluted":true}}}');
  const polluted = { ...snapshot, customPresets: [pollutedPreset] };
  const pollutedResult = validateSandboxState(polluted);
  assert.strictEqual(pollutedResult.valid, false);
  assert.strictEqual(pollutedResult.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);

  sharedLocalStorage.clear();
});

// ============================================================================
// 23. Wave T (ticket 0df20ae): Realm launch provenance (instance) round-trips,
//     malformed provenance is dropped without costing the Realm record
// ============================================================================

test('23. realm instance provenance round-trips and a malformed block is dropped per-field', () => {
  sharedLocalStorage.clear();

  const instance = {
    templateId: 'unit_package',
    templateVersion: `sha256:${'a'.repeat(64)}`,
    packageDigest: `sha256:${'b'.repeat(64)}`,
    inputHashes: { brief: `sha256:${'c'.repeat(64)}` },
    seedPaths: ['/lore/world.md', '/notes/tone.md'],
    launchedAt: '2026-09-21T00:00:00.000Z',
    resolvedTools: { 'text.similarity': 'acme/text-tools@1.0.0#sha256:abc' }
  };
  const realm = {
    id: 'realm_prov_23',
    name: 'Provenance 23',
    templateId: 'unit_package',
    instance,
    createdAt: 1700000000000
  };
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });

  try {
    const snapshot = serializeRuntimeEnvironment({ runtime }, { realms: [realm] });
    assert.deepStrictEqual(snapshot.realms[0], realm, 'provenance serializes verbatim');
    assert.notStrictEqual(snapshot.realms[0].instance, instance, 'provenance is copied, never aliased');
    assert.notStrictEqual(snapshot.realms[0].instance.inputHashes, instance.inputHashes);
    assert.notStrictEqual(snapshot.realms[0].instance.seedPaths, instance.seedPaths);

    const validated = validateSandboxState(snapshot);
    assert.strictEqual(validated.valid, true);
    assert.deepStrictEqual(validated.state.realms[0].instance, instance);

    assert.strictEqual(saveSandboxState(snapshot), true);
    const loaded = loadSandboxState();
    assert.deepStrictEqual(loaded.realms[0].instance, instance, 'provenance round-trips through storage');

    // A malformed provenance block is dropped while the Realm record survives.
    const malformed = {
      ...snapshot,
      realms: [
        { ...realm, instance: { templateId: 'x' } },
        { ...realm, instance: { ...instance, inputHashes: { brief: 42 } } },
        { ...realm, instance: 'not-an-object' }
      ]
    };
    const malformedValidated = validateSandboxState(malformed);
    assert.strictEqual(malformedValidated.valid, true, 'provenance shape never fails the snapshot');
    assert.strictEqual(malformedValidated.state.realms.length, 3, 'the Realm records survive');
    assert.ok(
      malformedValidated.state.realms.every((record) => record.instance === undefined),
      'malformed provenance is dropped per record'
    );

    // Legacy snapshots without instance keep their identity.
    const legacyRealm = { id: 'realm_legacy_23', name: 'Legacy 23', createdAt: 1 };
    const legacySnapshot = { ...snapshot, realms: [legacyRealm] };
    const legacyValidated = validateSandboxState(legacySnapshot);
    assert.strictEqual(legacyValidated.valid, true);
    assert.strictEqual(legacyValidated.state.realms[0].instance, undefined);
  } finally {
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 24. Wave T: imported-template payloads round-trip, invalid entries are
//     dropped, and legacy snapshots stay byte-identical
// ============================================================================

test('24. imported template payloads round-trip and invalid entries are dropped on load', () => {
  sharedLocalStorage.clear();

  const payload = JSON.stringify({
    formatVersion: 1,
    template: { formatVersion: 1, id: 'unit_import', name: 'Unit Import', description: '', agents: [] },
    files: {}
  });
  const imported = { id: 'unit_import', payload };
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });

  try {
    const snapshot = serializeRuntimeEnvironment({ runtime }, { importedRealmTemplates: [imported] });
    assert.deepStrictEqual(snapshot.importedRealmTemplates, [imported]);
    assert.notStrictEqual(snapshot.importedRealmTemplates[0], imported, 'entries are copied, never aliased');

    // An empty import registry omits the field so legacy wire bytes are unchanged.
    const bare = serializeRuntimeEnvironment({ runtime });
    assert.ok(!('importedRealmTemplates' in bare), 'An empty import registry must omit the field');

    const validated = validateSandboxState(snapshot);
    assert.strictEqual(validated.valid, true);
    assert.strictEqual(validated.state, snapshot, 'valid imports must not force a snapshot copy');
    assert.strictEqual(saveSandboxState(snapshot), true);
    const loaded = loadSandboxState();
    assert.deepStrictEqual(loaded.importedRealmTemplates, [imported]);

    // Invalid entries are dropped individually; a non-array value drops the field.
    const invalid = {
      ...snapshot,
      importedRealmTemplates: [
        imported,
        { id: '', payload },
        { id: 'unit_import', payload: '' },
        { id: 'unit_import', payload: 42 },
        'garbage',
        null
      ]
    };
    const invalidValidated = validateSandboxState(invalid);
    assert.strictEqual(invalidValidated.valid, true, 'invalid optional import entries must not fail validation');
    assert.strictEqual(invalidValidated.state.importedRealmTemplates.length, 1);
    assert.strictEqual(invalidValidated.state.importedRealmTemplates[0].id, 'unit_import');
    assert.strictEqual(invalid.importedRealmTemplates.length, 6, 'validation never mutates the input');

    const nonArray = { ...snapshot, importedRealmTemplates: 'not-an-array' };
    const nonArrayValidated = validateSandboxState(nonArray);
    assert.strictEqual(nonArrayValidated.valid, true);
    assert.strictEqual(nonArrayValidated.state.importedRealmTemplates, undefined, 'non-array imports are dropped');

    // Back-compat: legacy snapshots without the field keep identity and load.
    const legacy = { ...snapshot };
    delete legacy.importedRealmTemplates;
    const legacyValidated = validateSandboxState(legacy);
    assert.strictEqual(legacyValidated.valid, true);
    assert.strictEqual(legacyValidated.state, legacy, 'legacy snapshots keep their identity');
    assert.strictEqual(legacyValidated.state.importedRealmTemplates, undefined);
    assert.strictEqual(saveSandboxState(legacy), true);
    const legacyLoaded = loadSandboxState();
    assert.strictEqual(legacyLoaded.importedRealmTemplates, undefined);
  } finally {
    runtime.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// Wave U authority fields (ticket 2518510)
// ============================================================================

/**
 * Builds a minimal valid snapshot for authority-field validation.
 *
 * @param {object} [extra] - Additional top-level fields.
 * @returns {object} Candidate snapshot.
 */
function authoritySnapshot(extra = {}) {
  return {
    version: '1.0.0',
    timestamp: Date.now(),
    agents: [],
    recycleBin: [],
    ...extra
  };
}

test('authority fields: valid grants/trust validate and legacy snapshots stay untouched', () => {
  const withAuthorities = authoritySnapshot({
    metaAuthorityGrants: {
      template: ['realm:r1:architect'],
      hydration: ['realm:r1:genesis']
    },
    templateAuthorityTrust: {
      'wave-u': { architect: ['@template:authority'], genesis: ['@hydration:authority'] }
    }
  });
  const validated = validateSandboxState(withAuthorities);
  assert.strictEqual(validated.valid, true);
  assert.deepStrictEqual(validated.state.metaAuthorityGrants, withAuthorities.metaAuthorityGrants);
  assert.deepStrictEqual(validated.state.templateAuthorityTrust, withAuthorities.templateAuthorityTrust);

  // Empty/absent forms are valid.
  assert.strictEqual(validateSandboxState(authoritySnapshot({ metaAuthorityGrants: {} })).valid, true);
  assert.strictEqual(validateSandboxState(authoritySnapshot({ templateAuthorityTrust: {} })).valid, true);

  // Legacy snapshots load byte-compatibly with the fields absent.
  const legacy = authoritySnapshot();
  const legacyValidated = validateSandboxState(legacy);
  assert.strictEqual(legacyValidated.valid, true);
  assert.strictEqual('metaAuthorityGrants' in legacyValidated.state, false);
  assert.strictEqual('templateAuthorityTrust' in legacyValidated.state, false);
});

test('authority fields: malformed shapes fail validation closed', () => {
  const malformed = [
    { metaAuthorityGrants: 'nope' },
    { metaAuthorityGrants: { template: 'nope' } },
    { metaAuthorityGrants: { hydration: [42] } },
    { metaAuthorityGrants: { template: [''] } },
    { templateAuthorityTrust: [] },
    { templateAuthorityTrust: { 'wave-u': 'nope' } },
    { templateAuthorityTrust: { 'wave-u': { architect: 'nope' } } },
    { templateAuthorityTrust: { 'wave-u': { architect: [''] } } },
    { templateAuthorityTrust: { '': { architect: ['@template:authority'] } } }
  ];
  for (const extra of malformed) {
    const result = validateSandboxState(authoritySnapshot(extra));
    assert.strictEqual(result.valid, false, `expected invalid for ${JSON.stringify(extra)}`);
    assert.strictEqual(result.code, PERSISTENCE_ERROR_CODES.INVALID_STATE);
  }
});

test('authority fields: prototype-pollution keys fail closed', () => {
  const polluted = JSON.parse(`{
    "version": "1.0.0",
    "timestamp": ${Date.now()},
    "agents": [],
    "metaAuthorityGrants": { "__proto__": ["realm:r1:a"] }
  }`);
  const result = validateSandboxState(polluted);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);
});

test('authority fields: prototype-carried records reject as pollution and own records still round-trip', () => {
  const inherited = [
    ['metaAuthorityGrants', { template: ['realm:r1:architect'], hydration: [] }],
    ['templateAuthorityTrust', { 'wave-u': { architect: ['@template:authority'] } }]
  ];
  for (const [field, value] of inherited) {
    const hostile = Object.create({ [field]: value });
    Object.assign(hostile, authoritySnapshot());
    const result = validateSandboxState(hostile);
    assert.strictEqual(result.valid, false, `'${field}' must not validate through the prototype chain`);
    assert.strictEqual(result.code, PERSISTENCE_ERROR_CODES.PROTOTYPE_POLLUTION_DETECTED);
  }

  const own = authoritySnapshot({
    metaAuthorityGrants: { template: ['realm:r1:architect'], hydration: [] },
    templateAuthorityTrust: { 'wave-u': { architect: ['@template:authority'] } }
  });
  const validated = validateSandboxState(own);
  assert.strictEqual(validated.valid, true);
  assert.strictEqual(validated.state, own, 'own-field snapshots keep their identity');
  assert.deepStrictEqual(validated.state.metaAuthorityGrants, own.metaAuthorityGrants);
  assert.deepStrictEqual(validated.state.templateAuthorityTrust, own.templateAuthorityTrust);
});
