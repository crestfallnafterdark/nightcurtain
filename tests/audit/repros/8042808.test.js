/**
 * @file tests/audit/repros/8042808.test.js
 * @description Audit repro for ticket 8042808 (Major, area:security, MOD-21):
 * hydration re-attaches the snapshot-persisted `allowedTools`/`tools` whitelist
 * to the live config, and the legacy tool gate binds that config
 * (`turnExecutionEngine` -> `createSandboxToolDispatcher`), re-granting the full
 * tool surface after the registry `AuthorityDescriptor` correctly default-denies.
 *
 * Ratified rule (43a36a1 / 90ad905; `runtime/index.d.ts`): authority is never
 * persisted — restore re-derives descriptors from trusted construction only and
 * a hydrated entity is default-deny until a trusted operator grant lands.
 *
 * Covered entry points:
 * - direct `Agent.fromSnapshot` / `runtime.importSnapshot` (crafted payloads)
 * - the app round trip (`serializeRuntimeEnvironment` -> `restoreRuntimeEnvironment`)
 * - the recycle-bin restore path (`importSnapshot.recycleBin` -> `restoreAgent`)
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/8042808.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../../src/lib/sandbox/runtime/agent/index.ts';
import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';
import {
  serializeRuntimeEnvironment,
  restoreRuntimeEnvironment
} from '../../../src/lib/sandbox/sandboxPersistence/index.ts';

const TELEMETRY = {
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

function buildAgentSnapshot(overrides = {}, id = 'probe') {
  return {
    id,
    name: id,
    config: { id, ...(overrides.config || {}) },
    state: overrides.state || 'idle',
    stateDetail: null,
    turnCount: 0,
    telemetry: { ...TELEMETRY },
    createdAt: 1773700000000,
    updatedAt: 1773700000000,
    lastSummary: null,
    lastError: null,
    lastInterruptedTurn: null,
    recycledAt: overrides.recycledAt || null,
    recycleReason: overrides.recycleReason || null,
    history: [],
    redoStack: [],
    pendingPrecalls: []
  };
}

function buildDispatcher(runtime, agentId) {
  const agent = runtime.getAgent(agentId);
  return createSandboxToolDispatcher({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    agentId,
    privileged: Boolean(agent?.config?.privileged),
    allowedTools: agent?.config?.allowedTools,
    lifecyclePort: runtime.createLifecyclePort(),
    identityPort: runtime.createAgentIdentityPort(),
    worldClock: runtime.worldClock
  });
}

function registryAllow(runtime, agentId) {
  const identity = runtime.createAgentIdentityPort().getAgentIdentity(agentId);
  return identity?.authority ? Array.from(identity.authority.allow) : [];
}

function assertWriteDenied(receipt, label) {
  assert.strictEqual(
    receipt.success,
    false,
    `${label}: hydrated whitelist must not execute tools (${JSON.stringify(receipt)})`
  );
  assert.strictEqual(receipt.code, 'PERMISSION_DENIED', `${label}: denial code`);
}

test('8042808: Agent.fromSnapshot withholds the persisted whitelist from the live config', () => {
  const restored = Agent.fromSnapshot(buildAgentSnapshot({ config: { allowedTools: ['*'] } }));

  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(restored.config, 'allowedTools'),
    false,
    'persisted allowedTools must not be re-attached to the hydrated config'
  );
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(restored.config, 'tools'),
    false,
    'persisted tools must not be re-attached to the hydrated config'
  );
  assert.strictEqual(restored.authority.allow.size, 0, 're-derived authority must stay default-deny');
});

test('8042808: crafted allowedTools:["*"] snapshot cannot dispatch tools after hydration', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({ agents: [buildAgentSnapshot({ config: { allowedTools: ['*'] } })], recycleBin: [] });

    const agent = runtime.getAgent('probe');
    assert.ok(agent, 'agent must hydrate');
    assert.deepStrictEqual(registryAllow(runtime, 'probe'), [], 'registry descriptor must stay default-deny');

    const receipt = await buildDispatcher(runtime, 'probe').executeTool('write_file', {
      file_path: 'pwned.txt',
      content: 'x'
    });
    assertWriteDenied(receipt, 'crafted array wildcard');
  } finally {
    runtime.destroy();
  }
});

test('8042808: crafted allowedTools:"*" string snapshot cannot dispatch tools after hydration', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({ agents: [buildAgentSnapshot({ config: { allowedTools: '*' } })], recycleBin: [] });
    assert.deepStrictEqual(registryAllow(runtime, 'probe'), [], 'registry descriptor must stay default-deny');

    const receipt = await buildDispatcher(runtime, 'probe').executeTool('write_file', {
      file_path: 'pwned.txt',
      content: 'x'
    });
    assertWriteDenied(receipt, 'crafted string wildcard');
  } finally {
    runtime.destroy();
  }
});

test('8042808: serialize -> restore round trip of an unprivileged wildcard agent stays default-deny', async () => {
  const source = new AgentRuntime({ autoBootstrapDirector: false });
  const restored = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await source.launchAgent({ id: 'live_wildcard', allowedTools: ['*'] });
    const snapshot = serializeRuntimeEnvironment(source);

    const result = restoreRuntimeEnvironment(snapshot, restored);
    assert.strictEqual(result.success, true, 'round-trip restore must succeed');

    const agent = restored.getAgent('live_wildcard');
    assert.ok(agent, 'agent must restore');
    assert.deepStrictEqual(registryAllow(restored, 'live_wildcard'), [], 'registry descriptor must stay default-deny');

    const receipt = await buildDispatcher(restored, 'live_wildcard').executeTool('write_file', {
      file_path: 'pwned.txt',
      content: 'x'
    });
    assertWriteDenied(receipt, 'live round trip');
  } finally {
    source.destroy();
    restored.destroy();
  }
});

test('8042808: recycle-bin restore of a wildcard record stays default-deny', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = { callerAgentId: 'director' };

    const recycled = buildAgentSnapshot(
      { config: { allowedTools: ['*'] }, state: 'recycled', recycledAt: 1773700000000 },
      'probe_bin'
    );
    runtime.importSnapshot({ agents: [], recycleBin: [recycled] });
    assert.ok(runtime.getRecycledAgent('probe_bin'), 'record must hydrate into the recycle bin');

    runtime.restoreAgent('probe_bin', operator);
    assert.deepStrictEqual(registryAllow(runtime, 'probe_bin'), [], 'restored descriptor must stay default-deny');

    const receipt = await buildDispatcher(runtime, 'probe_bin').executeTool('write_file', {
      file_path: 'pwned.txt',
      content: 'x'
    });
    assertWriteDenied(receipt, 'recycle-bin restore');
  } finally {
    runtime.destroy();
  }
});

test('8042808 control: a non-wildcard persisted whitelist still does not grant beyond its names', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({ agents: [buildAgentSnapshot({ config: { allowedTools: ['read_file'] } })], recycleBin: [] });

    const receipt = await buildDispatcher(runtime, 'probe').executeTool('write_file', {
      file_path: 'pwned.txt',
      content: 'x'
    });
    assertWriteDenied(receipt, 'non-wildcard control');
  } finally {
    runtime.destroy();
  }
});
