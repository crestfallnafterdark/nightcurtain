/**
 * @file tests/audit/repros/9133495.test.js
 * @description Audit repro for ticket 9133495 (Major; Realm A0 / lane L5):
 * `list_agents` returns live `Agent` entities and ignores caller identity, so
 * an ordinary caller sees every agent in the runtime and the tool result leaks
 * entity internals (`history`, `provider`, `model`, `modelConfig`, `config` /
 * `allowedTools`) through `JSON.stringify`.
 *
 * Ratified fix: the descriptor handler calls
 * `LifecyclePort.listAgentDescriptors({ callerAgentId })` with the bound
 * execution-context identity only (never caller-supplied claims) and projects
 * every descriptor to the reduced public shape
 * `{ id, name, state, role, triggerPolicy, unreadCount, workspace }`.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/9133495.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

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
 * Builds the real runtime fixture: director (registry sudoer), `worker`
 * (ordinary caller), `child` (worker's registry child), `stranger` (unrelated).
 * @returns {Promise<AgentRuntime>} The live runtime fixture.
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  await runtime.launchAgent({ id: 'worker', role: 'worker', allowedTools: ['list_agents'] });
  await runtime.launchAgent({ id: 'child', role: 'apprentice', spawnedBy: 'worker' });
  await runtime.launchAgent({ id: 'stranger', role: 'stranger' });
  return runtime;
}

/**
 * Builds a dispatcher bound to the ordinary `worker` identity.
 * @param {AgentRuntime} runtime - Live runtime.
 * @returns {Function} Bound tool dispatcher.
 */
function workerDispatcher(runtime) {
  return createSandboxToolDispatcher({
    runtime,
    agentId: 'worker',
    allowedTools: ['list_agents']
  });
}

test('9133495 A: an ordinary caller must not see unrelated agents', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await workerDispatcher(runtime).executeTool('list_agents', {});
    assert.equal(receipt.success, true);
    const ids = receipt.result.map((entry) => entry.id).sort();
    assert.deepStrictEqual(
      ids,
      ['child', 'worker'],
      'ordinary callers see self + registry children only (the system-scope director is never listed; ticket cf0e127 supersedes the always-visible director clause)'
    );
  } finally {
    runtime.destroy();
  }
});

test('9133495 B: the tool result must not leak live entity internals', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await workerDispatcher(runtime).executeTool('list_agents', {});
    assert.equal(receipt.success, true);
    assert.ok(Array.isArray(receipt.result), 'list_agents wraps the descriptor array under .result');

    let serialized = null;
    assert.doesNotThrow(() => {
      serialized = JSON.stringify(receipt.result);
    }, 'list_agents result must be JSON-serializable');
    for (const key of FORBIDDEN_KEYS) {
      assert.equal(
        serialized.includes(`"${key}"`),
        false,
        `serialized list_agents result must not contain "${key}"`
      );
    }

    for (const entry of receipt.result) {
      assert.deepStrictEqual(
        Object.keys(entry).sort(),
        [...PUBLIC_DESCRIPTOR_KEYS].sort(),
        'descriptor entries expose the reduced public shape only'
      );
    }
  } finally {
    runtime.destroy();
  }
});

test('9133495 C: an anonymous caller must receive an empty list', async () => {
  const runtime = await createFixture();
  try {
    const anonymousDispatcher = createSandboxToolDispatcher({
      runtime,
      allowedTools: ['list_agents']
    });
    const receipt = await anonymousDispatcher.executeTool('list_agents', {});
    assert.equal(receipt.success, true);
    assert.deepStrictEqual(receipt.result, [], 'anonymous callers must see no agents');
  } finally {
    runtime.destroy();
  }
});
