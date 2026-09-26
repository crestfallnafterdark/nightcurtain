/**
 * @file tests/integration/spawn_agent_contract_test.js
 * @description Standing regressions for the ratified `spawn_agent` contract
 * (decision ticket f41f838 comments #2-#3; findings F1-F9 of the investigation
 * report `scratch/investigations/spawn-agent-report.md`).
 *
 * Ported from the investigation's proposed red repros R1-R6 and extended to
 * the full ratified surface:
 * - capability: `toolPreset`/`allowedTools` exposed, honored end-to-end, and
 *   clamped to the spawner's own effective set (child ⊆ spawner, authority
 *   callers included); `role` is a pure label; the no-selector default is
 *   `readonly_collaborator ∩ spawner tools` (spawner set when the intersection
 *   is empty);
 * - parameter surface: unknown keys dropped at the boundary, never forwarded,
 *   reported in the model-visible `warnings` list; authority-adjacent acting
 *   keys (`privileged`, `workspace`, model/turn tuning) stripped the same way;
 * - prompt policy: non-blocking by default, `await_completion` blocking opt-in,
 *   a failed child turn never unwinds the registered child;
 * - receipts/introspection: bounded receipt carries the child handle, identity
 *   and effective tool policy; `list_agents` exposes the per-agent policy; a
 *   malformed port success record fails instead of fabricating 'unknown';
 * - errors: tool-boundary validation uses `INVALID_ARGUMENTS` with
 *   spawn-scoped text; a duplicate id keeps its own `AGENT_ALREADY_EXISTS`
 *   code.
 *
 * Verifies through the real seam (zero mocks of the classes under test): real
 * `AgentRuntime` + real dispatcher; only `enqueueUserTurn` is stubbed in the
 * prompt-policy tests so turn timing/failure is deterministic and offline.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import {
  createSandboxToolDispatcher,
  getSandboxToolsSchema
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import {
  SANDBOX_TOOLS,
  TOOL_PRESETS
} from '../../src/lib/sandbox/tools/constants/index.ts';

/** Realm shared by the contract fixtures (plain literal; never asserted in receipts). */
const REALM = 'realm_spawn_contract';

/** Spawner tool set used by most capability tests. */
const MANAGER_TOOLS = Object.freeze(['spawn_agent', 'list_agents', 'read_file']);

/**
 * Builds a real runtime with a realm-bound agent and a dispatcher bound to it.
 *
 * @param {object} [options] - Fixture options.
 * @param {string} [options.id] - Spawner id.
 * @param {readonly string[]} [options.tools] - Spawner allowed tools.
 * @param {string} [options.realmId] - Spawner realm.
 * @returns {Promise<{runtime: AgentRuntime, dispatcher: Function, id: string}>} Fixture handles.
 */
async function createSpawnerFixture(options = {}) {
  const id = options.id || 'spawner_manager';
  const tools = options.tools || MANAGER_TOOLS;
  const realmId = options.realmId || REALM;
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  await runtime.launchAgent({ id, realmId, allowedTools: [...tools] });
  const dispatcher = createSandboxToolDispatcher({ runtime, agentId: id });
  return { runtime, dispatcher, id };
}

/** Resolves after one macrotask/microtask drain, letting detached work settle. */
function drainAsync() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Reads a live child or fails the test with a clear message. */
function childOf(runtime, id) {
  const child = runtime.getAgent(id);
  assert.ok(child, `child '${id}' must be registered`);
  return child;
}

// ============================================================================
// Capability: preset/list, role label, defaults, child ⊆ spawner
// ============================================================================

test('R1: a documented spawn (id + role) gives the child a usable default capability set', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture();
  try {
    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'child_r1', role: 'worker' });
    assert.equal(receipt.success, true, `spawn must succeed: ${receipt.error}`);
    assert.equal(receipt.role, 'worker', 'role stays a display label on the receipt');

    const child = childOf(runtime, 'child_r1');
    assert.deepStrictEqual(
      child.config.allowedTools,
      ['read_file'],
      'no-selector default is readonly_collaborator ∩ the spawner tools (never a zero-tool child)'
    );
    assert.equal(child.config.role, 'worker', 'role is forwarded as a pure label');
    const schemaTools = getSandboxToolsSchema(child.config.allowedTools).map((def) => def.function.name);
    assert.ok(schemaTools.includes(SANDBOX_TOOLS.READ_FILE), 'the child sees at least one usable tool schema');
    assert.deepStrictEqual(receipt.allowedTools, child.config.allowedTools, 'the receipt echoes the effective policy');
  } finally {
    runtime.destroy();
  }
});

test('R1b: role never selects the child tool policy', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({
    id: 'spawner_role',
    tools: ['spawn_agent', 'read_file', 'write_file']
  });
  try {
    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'child_role', role: 'collaborator' });
    assert.equal(receipt.success, true, `spawn must succeed: ${receipt.error}`);
    const child = childOf(runtime, 'child_role');
    assert.deepStrictEqual(
      child.config.allowedTools,
      ['read_file'],
      "role 'collaborator' must not resolve the collaborator preset (it is a label only)"
    );
    assert.equal(child.config.role, 'collaborator');
  } finally {
    runtime.destroy();
  }
});

test('R2: allowedTools and toolPreset are honored end-to-end in every documented spelling', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({ id: 'spawner_r2' });
  try {
    const cases = [
      [{ allowedTools: ['read_file'] }, ['read_file'], 'camelCase allowedTools'],
      [{ allowed_tools: ['read_file'] }, ['read_file'], 'snake_case allowed_tools'],
      [{ tools: ['read_file'] }, ['read_file'], 'tools alias'],
      [{ toolPreset: 'readonly_collaborator' }, ['read_file'], 'camelCase toolPreset (clamped to spawner tools)'],
      [{ tool_preset: 'readonly_collaborator' }, ['read_file'], 'snake_case tool_preset (clamped to spawner tools)']
    ];
    let index = 0;
    for (const [args, expected, label] of cases) {
      index += 1;
      const id = `child_r2_${index}`;
      const receipt = await dispatcher.executeTool('spawn_agent', { id, ...args });
      assert.equal(receipt.success, true, `${label} must succeed: ${receipt.error}`);
      const child = childOf(runtime, id);
      assert.deepStrictEqual(child.config.allowedTools, expected, `${label} must reach the child config`);
      assert.deepStrictEqual(receipt.allowedTools, expected, `${label} must echo the effective policy`);
    }
  } finally {
    runtime.destroy();
  }
});

test('R12: a child never exceeds the spawner tools, for authority spawners too', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
    await runtime.launchAgent({
      config: {
        id: 'root_restricted',
        realmId: REALM,
        privileged: true,
        allowedTools: ['spawn_agent', 'read_file', 'write_file']
      },
      principal: operator
    });
    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'root_restricted' });

    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'child_r12', toolPreset: 'manager' });
    assert.equal(receipt.success, true, `authority spawn must succeed: ${receipt.error}`);
    const child = childOf(runtime, 'child_r12');
    assert.deepStrictEqual(
      [...child.config.allowedTools].sort(),
      ['read_file', 'write_file'],
      'an authority child is clamped to the authority spawner own effective set'
    );

    // A wildcard spawner may grant equivalent wildcard access.
    await runtime.launchAgent({
      config: { id: 'root_all', realmId: REALM, privileged: true, allowedTools: ['*'] },
      principal: operator
    });
    const wildDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'root_all' });
    const wildReceipt = await wildDispatcher.executeTool('spawn_agent', { id: 'child_r12_wild', allowedTools: ['*'] });
    assert.equal(wildReceipt.success, true, `wildcard-equivalent spawn must succeed: ${wildReceipt.error}`);
    assert.deepStrictEqual(childOf(runtime, 'child_r12_wild').config.allowedTools, ['*']);
  } finally {
    runtime.destroy();
  }
});

test('R13: an empty default intersection inherits the spawner own effective set', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({
    id: 'spawner_r13',
    tools: ['spawn_agent', 'write_file']
  });
  try {
    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'child_r13' });
    assert.equal(receipt.success, true, `spawn must succeed: ${receipt.error}`);
    const child = childOf(runtime, 'child_r13');
    assert.deepStrictEqual(
      child.config.allowedTools,
      ['spawn_agent', 'write_file'],
      'the spawner set is inherited when readonly_collaborator ∩ spawner is empty'
    );
    assert.ok(child.config.allowedTools.length >= 1, 'never a zero-tool child when the spawner has tools');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// Parameter surface: unknown keys dropped with warnings, never forwarded
// ============================================================================

test('R3: unknown parameters are dropped at the boundary, never forwarded, and reported', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({ id: 'spawner_r3' });
  try {
    const receipt = await dispatcher.executeTool('spawn_agent', {
      id: 'child_r3',
      instructions: 'Do the task',
      taskName: 'Named task'
    });
    assert.equal(receipt.success, true, `spawn must succeed: ${receipt.error}`);
    assert.deepStrictEqual(
      [...receipt.warnings].sort(),
      ["ignored unknown parameter 'instructions'", "ignored unknown parameter 'taskName'"],
      'each ignored key is named in the model-visible warnings list'
    );
    const child = childOf(runtime, 'child_r3');
    assert.equal(
      Object.prototype.hasOwnProperty.call(child.config, 'instructions'),
      false,
      'unknown keys never reach the launched config'
    );
    assert.equal(
      child.history.some((message) => message.role === 'user'),
      false,
      'an unknown task key never delivers a prompt'
    );
  } finally {
    runtime.destroy();
  }
});

test('R3b: the boundary never forwards unknown keys to the lifecycle port', async () => {
  let launchCall = null;
  const lifecyclePort = {
    launchAgent: async (options) => {
      launchCall = options;
      return { success: true, id: options?.config?.id, state: 'idle', role: options?.config?.role, config: { allowedTools: [] } };
    }
  };
  const dispatcher = createSandboxToolDispatcher({ lifecyclePort, allowedTools: 'all' });
  const receipt = await dispatcher.executeTool('spawn_agent', {
    id: 'child_r3b',
    instructions: 'Do the task',
    workspaceId: 'peer-ws'
  });
  assert.equal(receipt.success, true);
  assert.ok(launchCall, 'launchAgent must be reached');
  assert.equal(Object.prototype.hasOwnProperty.call(launchCall.config, 'instructions'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(launchCall.config, 'workspaceId'), false);
  assert.deepStrictEqual(receipt.warnings, [
    "ignored unknown parameter 'instructions'",
    "ignored unknown parameter 'workspaceId'"
  ]);
});

test('R10: authority-adjacent acting keys and model tuning are stripped with warnings', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({ id: 'spawner_r10' });
  try {
    const receipt = await dispatcher.executeTool('spawn_agent', {
      id: 'child_r10',
      privileged: true,
      workspace: 'peer-ws',
      workspaceId: 'peer-ws',
      temperature: 0.95,
      maxTurns: 9,
      modelConfig: { modelId: 'sneaky' },
      presetId: 'sneaky_preset'
    });
    assert.equal(receipt.success, true, `spawn must succeed: ${receipt.error}`);
    assert.deepStrictEqual(
      [...receipt.warnings].sort(),
      [
        "ignored unknown parameter 'maxTurns'",
        "ignored unknown parameter 'modelConfig'",
        "ignored unknown parameter 'presetId'",
        "ignored unknown parameter 'privileged'",
        "ignored unknown parameter 'temperature'",
        "ignored unknown parameter 'workspace'",
        "ignored unknown parameter 'workspaceId'"
      ],
      'every stripped key is named'
    );
    const child = childOf(runtime, 'child_r10');
    assert.equal(child.config.privileged, false, 'a stripped privileged claim never elevates the child');
    assert.equal(child.config.workspaceId, 'child_r10', 'a stripped workspace pin never retargets the child');
    assert.equal(child.config.temperature, 0.3, 'temperature tuning is not model-facing');
    assert.equal(child.config.maxTurns, undefined, 'maxTurns tuning is not model-facing');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// Errors / validation
// ============================================================================

test('R4: validation failures use INVALID_ARGUMENTS with spawn-scoped text', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({ id: 'spawner_r4' });
  try {
    for (const [args, label] of [
      [{ name: 'no id' }, 'missing id'],
      [{ id: 123 }, 'numeric id'],
      [{ config: { id: 'nested_child' } }, 'nested config shape']
    ]) {
      const receipt = await dispatcher.executeTool('spawn_agent', args);
      assert.equal(receipt.success, false, `${label} must fail`);
      assert.equal(receipt.code, 'INVALID_ARGUMENTS', `${label} must report a validation code, got ${JSON.stringify(receipt)}`);
      assert.equal(
        String(receipt.error).includes('launchAgent'),
        false,
        `${label} must not leak the internal launchAgent vocabulary: ${receipt.error}`
      );
    }
  } finally {
    runtime.destroy();
  }
});

test('R4b: a duplicate id keeps its own distinguishable code', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({ id: 'spawner_r4b' });
  try {
    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'spawner_r4b' });
    assert.equal(receipt.success, false, 'a live duplicate id must fail');
    assert.equal(receipt.code, 'AGENT_ALREADY_EXISTS', `expected the dedicated conflict code, got ${JSON.stringify(receipt)}`);
    assert.match(String(receipt.error), /already registered/i, 'the denial names the collision');
  } finally {
    runtime.destroy();
  }
});

test('R4c: an authorization denial names the capability requirement', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'collab_r4c', realmId: REALM, allowedTools: ['read_file'] });
    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'collab_r4c' });
    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'denied_child' });
    assert.equal(receipt.success, false, 'a caller without the capability is denied');
    assert.equal(receipt.code, 'PERMISSION_DENIED');
    assert.match(
      String(receipt.error),
      /manager preset/i,
      `the denial names the requirement (no authority oracle): ${receipt.error}`
    );
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// Prompt policy: non-blocking default, blocking opt-in, child survives
// ============================================================================

test('R5: initial_prompt is non-blocking by default', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'spawner_r5', realmId: REALM, allowedTools: ['spawn_agent'] });
    let settleTurn = null;
    const turnSettled = new Promise((resolve) => { settleTurn = resolve; });
    const enqueued = [];
    runtime.enqueueUserTurn = async (agentRef, input) => {
      enqueued.push({ agentRef, input });
      await new Promise((resolve) => setTimeout(resolve, 500));
      settleTurn();
      return { status: 'completed' };
    };
    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'spawner_r5' });

    const started = Date.now();
    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'child_r5', initial_prompt: 'Do the task' });
    const elapsed = Date.now() - started;
    assert.equal(receipt.success, true, `spawn must succeed: ${receipt.error}`);
    assert.ok(elapsed < 150, `spawn waited ${elapsed}ms for the child turn instead of returning after launch`);
    assert.ok(runtime.getAgent('child_r5'), 'the child is registered before its turn completes');
    assert.equal(enqueued.length, 1, 'the prompt is queued exactly once');
    assert.match(String(enqueued[0].agentRef), /child_r5/, 'the queued turn addresses the child');

    await turnSettled;
  } finally {
    runtime.destroy();
  }
});

test('R6: a failed child turn never unwinds a registered child (default and blocking)', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'spawner_r6', realmId: REALM, allowedTools: ['spawn_agent'] });
    runtime.enqueueUserTurn = async () => {
      const err = new Error('child turn failed');
      err.code = 'EXECUTION_FAILED';
      throw err;
    };
    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'spawner_r6' });

    const nonBlocking = await dispatcher.executeTool('spawn_agent', { id: 'child_r6', initial_prompt: 'Fail' });
    assert.equal(nonBlocking.success, true, 'the non-blocking spawn returns before the child turn settles');
    const child = childOf(runtime, 'child_r6');
    await drainAsync();
    assert.match(String(child.lastError || ''), /child turn failed/, 'the detached failure is recorded observably on the child');

    const blocking = await dispatcher.executeTool('spawn_agent', {
      id: 'child_r6b',
      initial_prompt: 'Fail',
      await_completion: true
    });
    assert.equal(blocking.success, false, 'the blocking opt-in surfaces the child turn failure');
    assert.equal(blocking.code, 'EXECUTION_FAILED');
    assert.ok(runtime.getAgent('child_r6b'), 'blocking keeps the child registered on turn failure');
  } finally {
    runtime.destroy();
  }
});

test('R14: await_completion awaits the child completed turn', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'spawner_r14', realmId: REALM, allowedTools: ['spawn_agent'] });
    let calls = 0;
    runtime.enqueueUserTurn = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { status: 'completed' };
    };
    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'spawner_r14' });

    const started = Date.now();
    const receipt = await dispatcher.executeTool('spawn_agent', {
      id: 'child_r14',
      initial_prompt: 'Go',
      awaitCompletion: true
    });
    const elapsed = Date.now() - started;
    assert.equal(receipt.success, true, `blocking spawn must succeed: ${receipt.error}`);
    assert.equal(calls, 1, 'the blocking opt-in awaits exactly one child turn');
    assert.ok(elapsed >= 40, `blocking must wait for the completed turn (waited ${elapsed}ms)`);
    assert.equal(Object.prototype.hasOwnProperty.call(receipt, 'warnings'), false, 'awaitCompletion is an accepted spelling');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// Schema + receipts + introspection
// ============================================================================

test('R7: the model-facing schema exposes the real capability, prompt, and honesty contract', async () => {
  const schemas = getSandboxToolsSchema('manager');
  const spawn = schemas.find((def) => def.function.name === SANDBOX_TOOLS.SPAWN_AGENT);
  assert.ok(spawn, 'spawn_agent must be exposed for the manager preset');
  const properties = spawn.function.parameters.properties;
  assert.deepStrictEqual(
    [...(properties.toolPreset?.enum || [])].sort(),
    [...Object.keys(TOOL_PRESETS)].sort(),
    'toolPreset enumerates the real preset ids'
  );
  assert.equal(properties.allowedTools?.type, 'array', 'allowedTools is exposed as an explicit list');
  assert.equal(properties.allowedTools?.items?.type, 'string');
  assert.equal(properties.await_completion?.type, 'boolean', 'await_completion is exposed');
  assert.equal(
    spawn.function.parameters.additionalProperties,
    true,
    'the emitted keyword matches the accept-and-warn runtime policy (no strict tool-schema mode)'
  );
  const description = spawn.function.description;
  for (const token of ['toolPreset', 'allowedTools', 'await_completion', 'warnings', 'role']) {
    assert.ok(description.includes(token), `the description must document '${token}'`);
  }
});

test('R8: the spawn receipt carries the child handle, identity, and effective policy', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({ id: 'spawner_r8' });
  try {
    const receipt = await dispatcher.executeTool('spawn_agent', {
      id: 'child_r8',
      name: 'Child R8',
      role: 'worker',
      toolPreset: 'readonly_collaborator'
    });
    assert.equal(receipt.success, true, `spawn must succeed: ${receipt.error}`);
    assert.equal(receipt.id, 'child_r8', 'the receipt names the handle a parent addresses with send_message/invoke_agent');
    assert.equal(receipt.name, 'Child R8');
    assert.equal(receipt.role, 'worker');
    assert.equal(receipt.state, 'idle');
    assert.deepStrictEqual(receipt.allowedTools, ['read_file'], 'the effective tool policy is echoed');
    assert.ok(runtime.getAgent(receipt.id), 'the receipt handle resolves the live child');
    for (const forbidden of ['config', 'history', 'provider', 'model', 'modelConfig', 'authority', 'realmId']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(receipt, forbidden),
        false,
        `the receipt must stay a bounded projection (no '${forbidden}')`
      );
    }
  } finally {
    runtime.destroy();
  }
});

test('R9: list_agents exposes each visible agent effective tool policy', async () => {
  const { runtime, dispatcher } = await createSpawnerFixture({ id: 'spawner_r9' });
  try {
    const spawned = await dispatcher.executeTool('spawn_agent', { id: 'child_r9', toolPreset: 'readonly_collaborator' });
    assert.equal(spawned.success, true, `spawn must succeed: ${spawned.error}`);

    const listed = await dispatcher.executeTool('list_agents', {});
    assert.equal(listed.success, true);
    const childEntry = listed.result.find((entry) => entry.id === 'child_r9');
    assert.ok(childEntry, 'the child is listed for its parent');
    assert.deepStrictEqual(childEntry.allowedTools, ['read_file'], 'the listing carries the effective tool policy');
    const selfEntry = listed.result.find((entry) => entry.id === 'spawner_r9');
    assert.ok(selfEntry, 'the caller is listed for itself');
    assert.deepStrictEqual(
      [...selfEntry.allowedTools].sort(),
      [...MANAGER_TOOLS].sort(),
      'the caller own policy is listed too'
    );
  } finally {
    runtime.destroy();
  }
});

test('R11: a malformed lifecycle-port success record fails the receipt, never fabricates identity', async () => {
  for (const [record, label] of [
    [{ success: true }, 'no id'],
    [{ success: true, id: 42 }, 'non-string id'],
    [{ success: true, id: '   ' }, 'blank id']
  ]) {
    const dispatcher = createSandboxToolDispatcher({
      lifecyclePort: { launchAgent: async () => record },
      allowedTools: 'all'
    });
    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'child_r11' });
    assert.equal(receipt.success, false, `${label}: a malformed port record must fail the receipt`);
    assert.equal(receipt.id, undefined, `${label}: no fabricated id may be projected`);
    assert.equal(JSON.stringify(receipt).includes('unknown'), false, `${label}: 'unknown' must never be fabricated`);
  }
});
