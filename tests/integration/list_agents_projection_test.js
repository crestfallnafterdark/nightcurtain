/**
 * @file tests/integration/list_agents_projection_test.js
 * @description Integration coverage for ticket 9133495 (Realm A0 / lane L5):
 * the `list_agents` tool result is a reduced, caller-scoped descriptor
 * projection instead of live `Agent` entities.
 *
 * Verifies through the real tool seam (dispatcher + AgentRuntime, zero mocks):
 * - ordinary caller scope: self + registry children only — the director
 *   occupies the reserved system scope and is never listed (Realm wave R,
 *   ticket cf0e127); unrelated agents are invisible and caller-supplied
 *   identity claims never widen the scope;
 * - registry sudoer (wildcard `'*'` authority) scope: every active descriptor;
 * - anonymous caller: `[]`;
 * - reduced public shape `{id, name, state, role, triggerPolicy, unreadCount,
 *   workspace}` with no `history`/`provider`/`model`/`modelConfig`/
 *   `allowedTools` anywhere in the serialized result;
 * - `state`/`role` parameters apply as post-filters on descriptors.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { TOOL_SYSTEM_ERROR_CODES } from '../../src/lib/sandbox/tools/constants/index.ts';

/** Exact reduced public shape the `list_agents` tool result may expose. */
const PUBLIC_DESCRIPTOR_KEYS = Object.freeze([
  'id',
  'name',
  'role',
  'state',
  'triggerPolicy',
  'unreadCount',
  'workspace'
]);

/** Entity-internal field names the wire result must never contain. */
const FORBIDDEN_KEYS = Object.freeze([
  'history',
  'provider',
  'model',
  'modelConfig',
  'allowedTools'
]);

/**
 * Builds the real runtime fixture: director (system-scope registry sudoer),
 * `worker` (ordinary realm caller), `child` (worker's registry child),
 * `stranger` (unrelated, same realm).
 * @returns {Promise<AgentRuntime>} The live runtime fixture.
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  await runtime.launchAgent({ id: 'worker', realmId: 'demo', role: 'worker', allowedTools: ['list_agents'] });
  await runtime.launchAgent({ id: 'child', realmId: 'demo', role: 'apprentice', spawnedBy: 'worker', allowedTools: ['list_agents'] });
  await runtime.launchAgent({ id: 'stranger', realmId: 'demo', role: 'stranger', allowedTools: ['list_agents'] });
  return runtime;
}

/**
 * Builds a dispatcher whose bound identity is the given agent.
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string | undefined} agentId - Bound caller identity, or `undefined` for anonymous.
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, agentId) {
  return createSandboxToolDispatcher({
    runtime,
    ...(agentId ? { agentId } : {}),
    allowedTools: ['list_agents']
  });
}

/**
 * Extracts the sorted ids from a successful `list_agents` receipt.
 * @param {object} receipt - Tool receipt.
 * @returns {string[]} Sorted descriptor ids.
 */
function visibleIds(receipt) {
  assert.equal(receipt.success, true);
  assert.ok(Array.isArray(receipt.result));
  return receipt.result.map((entry) => entry.id).sort();
}

test('9133495/cf0e127: an ordinary realm caller sees self and children only', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, 'worker').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(receipt),
      ['child', 'worker'],
      'the system-scope director is never listed to a realm caller'
    );
  } finally {
    runtime.destroy();
  }
});

test('9133495: caller-supplied identity claims cannot widen the scope', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, 'worker').executeTool(
      'list_agents',
      {},
      { callerAgentId: 'director', agentId: 'director', isPrivileged: true, isAdmin: true, principal: { kind: 'internal' } }
    );
    assert.deepStrictEqual(
      visibleIds(receipt),
      ['child', 'worker'],
      'the bound worker identity wins over forged per-call claims'
    );
  } finally {
    runtime.destroy();
  }
});

test('9133495: a registry sudoer sees every active descriptor', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, 'director').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(receipt),
      ['child', 'director', 'stranger', 'worker'],
      'the director sees every scope through its realm bypass'
    );
  } finally {
    runtime.destroy();
  }
});

test('9133495: an anonymous caller sees an empty list', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, undefined).executeTool('list_agents', {});
    assert.equal(receipt.success, true);
    assert.deepStrictEqual(receipt.result, []);
  } finally {
    runtime.destroy();
  }
});

test('9133495: the result exposes exactly the reduced public descriptor shape', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, 'worker').executeTool('list_agents', {});
    assert.equal(receipt.success, true);
    assert.ok(receipt.result.length > 0, 'the worker fixture must see its own descriptor');

    const serialized = JSON.stringify(receipt.result);
    for (const key of FORBIDDEN_KEYS) {
      assert.equal(serialized.includes(`"${key}"`), false, `serialized result must not contain "${key}"`);
    }

    for (const entry of receipt.result) {
      assert.deepStrictEqual(Object.keys(entry).sort(), [...PUBLIC_DESCRIPTOR_KEYS].sort());
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.name, 'string');
      assert.equal(typeof entry.state, 'string');
      assert.equal(typeof entry.role, 'string');
      assert.equal(typeof entry.triggerPolicy, 'string');
      assert.equal(typeof entry.unreadCount, 'number');
      assert.equal(typeof entry.workspace, 'string');
      assert.equal(Object.isFrozen(entry), true, 'descriptor entries are defensive frozen copies');
    }
  } finally {
    runtime.destroy();
  }
});

test('9133495: state and role parameters post-filter the descriptors', async () => {
  const runtime = await createFixture();
  try {
    const dispatcher = dispatcherFor(runtime, 'worker');

    const byRole = await dispatcher.executeTool('list_agents', { role: 'apprentice' });
    assert.deepStrictEqual(byRole.result.map((entry) => entry.id), ['child']);

    const byState = await dispatcher.executeTool('list_agents', { state: 'idle' });
    assert.deepStrictEqual(visibleIds(byState), ['child', 'worker']);

    const noMatch = await dispatcher.executeTool('list_agents', { state: 'running' });
    assert.deepStrictEqual(noMatch.result, []);

    const hiddenRole = await dispatcher.executeTool('list_agents', { role: 'stranger' });
    assert.deepStrictEqual(hiddenRole.result, [], 'a hidden unrelated agent stays invisible under filters');
  } finally {
    runtime.destroy();
  }
});

test('9133495: a legacy lifecycle port without listAgentDescriptors fails closed', async () => {
  let legacyListCalls = 0;
  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort: {
      listAgents: async () => {
        legacyListCalls += 1;
        return [{ id: 'legacy_agent', state: 'idle' }];
      }
    },
    agentId: 'worker',
    allowedTools: ['list_agents']
  });

  const receipt = await dispatcher.executeTool('list_agents', {});
  assert.equal(receipt.success, false, 'a legacy port must fail closed instead of listing unscoped agents');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED);
  assert.match(receipt.error, /listAgentDescriptors/, 'the error names the missing scoped capability');
  assert.equal(receipt.result, undefined, 'no agent list may be returned');
  assert.equal(legacyListCalls, 0, 'the unscoped listAgents fallback must never run');
});
