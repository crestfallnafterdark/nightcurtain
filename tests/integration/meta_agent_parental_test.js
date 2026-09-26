/**
 * @file tests/integration/meta_agent_parental_test.js
 * @description M2 meta-plane — parental `inspect_agent` / `update_agent`
 * acceptance suite (meta-plane spec §3, decision `c8a748f`).
 *
 * Acceptance coverage:
 *   AC-M2-01 parental inspect of an own direct spawn: bounded projection with
 *     no realm vocabulary, canonical keys, model URLs, or credentials;
 *   AC-M2-02 uniform denial for non-spawn peers, other-realm targets, unknown
 *     refs, and self-target updates (byte-identical receipts, no oracle);
 *   AC-M2-03 editable fields apply (tools preset + explicit list, privilege,
 *     policy, prompt, maxTurns, name);
 *   AC-M2-04 operator-only keys fail the whole call with `PERMISSION_DENIED`
 *     (`false`/`null` values included) with zero partial mutation;
 *   AC-M2-05 the <=-editor bound on the resulting state: no wildcard or
 *     tool-superset promotion, no self-promotion, no editing out-ranked
 *     targets;
 *   AC-M2-06 authority grants cannot be minted through the edit surface;
 *   AC-M2-07 safe state: busy target deferred once, latest-wins, applied
 *     exactly at `turn_complete`, terminated target dropped, flush-time
 *     re-check fails closed;
 *   AC-M2-08 audit before/after summaries, bare ids, no realm vocabulary;
 *   AC-M2-09 meta tier: scoped `@agent:inspect`/`@agent:edit` grants
 *     (ownSpawns/targets/realmMembers/realms, field tokens) enforced;
 *   AC-M2-10 schema/handler honesty (closed schemas, every declared key
 *     honored, denied keys never silently dropped);
 *   AC-M2-11 preset/placement: manager family exposes both tools, the other
 *     tiers do not; ordinary dispatcher authorization;
 *   AC-M2-12 `whoami` shows own authority ids only, never scopes;
 *   F3 scoped-grant persistence: a narrowed grant stays narrowed across a
 *     save -> hydrate restart (legacy keys-only entries stay unscoped);
 *   F4 entity deny-list parity: `Agent#updateConfig` rejects `authorities`.
 *
 * Zero-Mock Verification: real `AgentRuntime`, real dispatcher, real store;
 * the only stub is the LLM stream used to settle turns.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher, getSandboxToolsSchema, SANDBOX_TOOLS } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { ALL_TOOL_DESCRIPTORS, TOOL_REGISTRY } from '../../src/lib/sandbox/tools/descriptors/index.ts';
import {
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  TOOL_FAMILIES,
  TOOL_PRESETS
} from '../../src/lib/sandbox/tools/constants/index.ts';
import { getCanonToolName } from '../../src/lib/sandbox/tools/normalizers/index.ts';
import { AGENT_AUTHORITIES } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { saveSandboxState, validateSandboxState } from '../../src/lib/sandbox/sandboxPersistence/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { sharedLocalStorage } from '../test_env.js';

/** Simple deferred handle for gated turns. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

/**
 * Polls a predicate until it holds or the budget elapses.
 *
 * @param {Function} predicate - Synchronous predicate under test.
 * @param {number} [timeoutMs] - Polling budget in milliseconds.
 * @returns {Promise<void>} Resolves when the predicate holds.
 */
async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), 'waitUntil predicate must hold before the budget elapses');
}

/**
 * Minimal stream/complete mock model so turns settle without a provider network.
 *
 * @param {Function} fn - Response factory receiving the stream options.
 * @param {string} [modelId] - Model identifier.
 * @returns {object} Model-like object accepted by `launchAgent`.
 */
function createMockModel(fn, modelId = 'meta-parental-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'meta-parental-provider',
      createModel: (id) => createMockModel(fn, id),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: modelId, name: modelId }]
    },
    async *stream(options = {}) {
      const res = await fn({ ...options });
      const content = res && typeof res === 'object' ? (res.content || res.text || 'ok') : (res || 'ok');
      if (typeof options.onChunk === 'function') {
        try { options.onChunk(content); } catch { /* best-effort chunk delivery */ }
      }
      yield { type: 'text', content };
      yield { type: 'finish', finishReason: 'stop', content, toolCalls: [] };
    },
    async complete(options = {}) {
      return await fn(options);
    }
  };
}

/**
 * Launches an agent, optionally under a registered parent creator.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} id - Agent id.
 * @param {object} [options] - Launch overrides.
 * @returns {Promise<object>} The launched agent.
 */
async function launchAgent(runtime, id, options = {}) {
  const config = { id, allowedTools: options.tools || ['readonly'] };
  if (options.realmId) config.realmId = options.realmId;
  const launchOptions = { config, model: options.model || createMockModel(async () => ({ content: 'ok' })) };
  if (options.parentId) launchOptions.callerContext = { callerAgentId: options.parentId };
  return await runtime.launchAgent(launchOptions);
}

/**
 * Builds a dispatcher bound to one fixture agent.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} agentId - Bound caller identity.
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, agentId) {
  return createSandboxToolDispatcher({ runtime, agentId });
}

/** Canonical identity key of a registered agent through the trusted port. */
function identityKeyOf(runtime, agentId) {
  return runtime.createAgentIdentityPort().getAgentIdentity(agentId).key;
}

/** Extracts the Draft-07 schema from a `describe_tool` receipt. */
function describedSchema(receipt) {
  assert.equal(receipt.success, true, `describe_tool failed: ${receipt.error}`);
  return receipt.schema;
}

// ============================================================================
// AC-M2-01 / AC-M2-11 — surface + parental inspect
// ============================================================================

test('1. inspect_agent/update_agent are canonical manager-family tools (36->38 pins)', () => {
  assert.equal(SANDBOX_TOOLS.INSPECT_AGENT, 'inspect_agent');
  assert.equal(SANDBOX_TOOLS.UPDATE_AGENT, 'update_agent');
  assert.equal(Object.keys(SANDBOX_TOOLS).length, 38, 'the canonical taxonomy is 38 tools');
  assert.equal(ALL_TOOL_DESCRIPTORS.length, 38, 'the descriptor catalog carries all 38 tools');
  assert.equal(Object.keys(TOOL_REGISTRY).length, 38, 'the canonical registry carries all 38 tools');
  assert.equal(TOOL_FAMILIES.inspect_agent, 'lifecycle');
  assert.equal(TOOL_FAMILIES.update_agent, 'lifecycle');
  assert.ok(READ_ONLY_TOOLS.includes('inspect_agent'), 'inspect_agent is read-only');
  assert.ok(!MUTATING_TOOLS.includes('inspect_agent'), 'inspect_agent never mutates');
  assert.ok(MUTATING_TOOLS.includes('update_agent'), 'update_agent is mutating');
  assert.ok(!READ_ONLY_TOOLS.includes('update_agent'), 'update_agent is never read-only');

  const manager = TOOL_PRESETS.manager;
  assert.ok(manager.includes('inspect_agent'), 'the manager tier carries inspect_agent');
  assert.ok(manager.includes('update_agent'), 'the manager tier carries update_agent');
  for (const tier of ['collaborator', 'readonly_collaborator', 'readonly']) {
    assert.ok(!TOOL_PRESETS[tier].includes('inspect_agent'), `'${tier}' never carries inspect_agent`);
    assert.ok(!TOOL_PRESETS[tier].includes('update_agent'), `'${tier}' never carries update_agent`);
  }

  const managerSchemaNames = getSandboxToolsSchema('manager').map((def) => def.function.name);
  assert.ok(managerSchemaNames.includes('inspect_agent'), 'the manager schema exposes inspect_agent');
  assert.ok(managerSchemaNames.includes('update_agent'), 'the manager schema exposes update_agent');
  assert.equal(getSandboxToolsSchema('all').length, 38, 'the wildcard surface exposes 38 schemas');

  assert.equal(getCanonToolName('inspectAgent'), 'inspect_agent', 'the camelCase alias resolves');
  assert.equal(getCanonToolName('updateAgent'), 'update_agent', 'the camelCase alias resolves');
});

test('2. a parent inspects its direct spawn with a bounded realm-opaque projection', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p1', { tools: ['manager'] });
    await launchAgent(runtime, 'kid1', { parentId: 'p1' });
    const dispatcher = dispatcherFor(runtime, 'p1');

    const receipt = await dispatcher.executeTool('inspect_agent', { target: 'kid1' });
    assert.equal(receipt.success, true, `inspect failed: ${receipt.error}`);
    assert.equal(receipt.id, 'kid1');
    assert.equal(receipt.role, 'user');
    assert.equal(receipt.privileged, false);
    assert.equal(receipt.turns, 0);
    assert.ok(Array.isArray(receipt.tools.baked), 'the projection carries the baked tool list');
    assert.ok(Array.isArray(receipt.tools.extensions), 'the projection carries the extension call names');
    assert.equal(typeof receipt.model, 'object');
    assert.equal(typeof receipt.createdAt, 'number');
    assert.equal(receipt.spawnedBy, 'p1', 'the parent sees direct parentage');

    const serialized = JSON.stringify(receipt);
    for (const forbidden of ['realm:', 'realm_generic', 'system:', 'apiKey', 'authorization', 'http://', 'https://']) {
      assert.equal(serialized.includes(forbidden), false, `the projection must not carry '${forbidden}': ${serialized}`);
    }
  } finally {
    runtime.destroy();
  }
});

test('3. self-inspect is allowed and exposes the caller authority ids only', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p3', { tools: ['manager'] });
    runtime.grantAuthority('p3', AGENT_AUTHORITIES.AGENT_INSPECT, { ownSpawns: true }, { principal: runtime.getOperatorPrincipal() });
    const dispatcher = dispatcherFor(runtime, 'p3');

    const receipt = await dispatcher.executeTool('inspect_agent', { target: 'p3' });
    assert.equal(receipt.success, true, `self-inspect failed: ${receipt.error}`);
    assert.deepEqual(receipt.authorities, [AGENT_AUTHORITIES.AGENT_INSPECT], 'own ids only');
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes('ownSpawns'), false, 'scopes never surface');
    assert.equal(serialized.includes('realm:'), false, 'no realm vocabulary');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-02 — uniform denial, no oracle
// ============================================================================

test('4. non-spawn peers, other-realm targets, and unknown refs deny with byte-identical receipts', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p4', { tools: ['manager'] });
    await launchAgent(runtime, 'peer4', { tools: ['readonly'] });
    await launchAgent(runtime, 'stranger4', { realmId: 'realm_m2_other', tools: ['readonly'] });
    const dispatcher = dispatcherFor(runtime, 'p4');

    const peerInspect = await dispatcher.executeTool('inspect_agent', { target: 'peer4' });
    const strangerInspect = await dispatcher.executeTool('inspect_agent', { target: 'stranger4' });
    const ghostInspect = await dispatcher.executeTool('inspect_agent', { target: 'ghost4' });
    assert.equal(peerInspect.code, 'PERMISSION_DENIED');
    assert.equal(strangerInspect.code, 'PERMISSION_DENIED');
    assert.equal(ghostInspect.code, 'PERMISSION_DENIED');
    assert.equal(peerInspect.error, strangerInspect.error, 'peer-vs-other-realm deny identically');
    assert.equal(peerInspect.error, ghostInspect.error, 'peer-vs-unknown deny identically');

    const peerUpdate = await dispatcher.executeTool('update_agent', { target: 'peer4', name: 'nope' });
    const strangerUpdate = await dispatcher.executeTool('update_agent', { target: 'stranger4', name: 'nope' });
    const ghostUpdate = await dispatcher.executeTool('update_agent', { target: 'ghost4', name: 'nope' });
    assert.equal(peerUpdate.code, 'PERMISSION_DENIED');
    assert.equal(strangerUpdate.code, 'PERMISSION_DENIED');
    assert.equal(ghostUpdate.code, 'PERMISSION_DENIED');
    assert.equal(peerUpdate.error, strangerUpdate.error, 'update denials are uniform');
    assert.equal(peerUpdate.error, ghostUpdate.error, 'update denials are uniform');

    // Uniform receipts never echo the target claim or realm vocabulary.
    for (const receipt of [peerInspect, strangerInspect, ghostInspect, peerUpdate, strangerUpdate, ghostUpdate]) {
      const text = String(receipt.error);
      for (const forbidden of ['peer4', 'stranger4', 'ghost4', 'realm:', 'realm_m2_other', 'system:']) {
        assert.equal(text.includes(forbidden), false, `the denial must not echo '${forbidden}': ${text}`);
      }
    }

    // Self-target updates are denied like any other non-editable target.
    const selfUpdate = await dispatcher.executeTool('update_agent', { target: 'p4', name: 'self' });
    assert.equal(selfUpdate.code, 'PERMISSION_DENIED');

    // Zero mutation happened.
    assert.equal(runtime.getAgent('peer4').name, 'peer4');
    assert.equal(runtime.getAgent('peer4').config.realmId, 'realm_generic');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-03 / AC-M2-04 — editable fields and the operator-only deny list
// ============================================================================

test('5. a parent applies the editable field set through the intrinsic channel', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p5', { tools: ['manager'] });
    await launchAgent(runtime, 'kid5', { parentId: 'p5' });
    const dispatcher = dispatcherFor(runtime, 'p5');

    const toolEdit = await dispatcher.executeTool('update_agent', { target: 'kid5', tools: ['read_file', 'whoami'] });
    assert.equal(toolEdit.success, true, `tools edit failed: ${toolEdit.error}`);
    assert.equal(toolEdit.applied, true);
    assert.deepEqual(runtime.getAgent('kid5').config.allowedTools, ['read_file', 'whoami']);

    const presetEdit = await dispatcher.executeTool('update_agent', { target: 'kid5', toolPreset: 'readonly_collaborator' });
    assert.equal(presetEdit.success, true, `preset edit failed: ${presetEdit.error}`);
    assert.ok(runtime.getAgent('kid5').config.allowedTools.includes('send_message'), 'the preset resolved onto the child');

    const promptEdit = await dispatcher.executeTool('update_agent', { target: 'kid5', systemPrompt: 'Parent directive v2' });
    assert.equal(promptEdit.success, true, `prompt edit failed: ${promptEdit.error}`);
    const kid = runtime.getAgent('kid5');
    assert.equal(kid.history[0].role, 'system');
    assert.equal(kid.history[0].content, 'Parent directive v2', 'INV-CONFIG-SYNC in place');

    const policyEdit = await dispatcher.executeTool('update_agent', { target: 'kid5', triggerPolicy: 'manual' });
    assert.equal(policyEdit.success, true, `policy edit failed: ${policyEdit.error}`);
    assert.equal(kid.config.triggerPolicy, 'manual');

    const turnsEdit = await dispatcher.executeTool('update_agent', { target: 'kid5', maxTurns: 7 });
    assert.equal(turnsEdit.success, true, `maxTurns edit failed: ${turnsEdit.error}`);
    assert.equal(kid.config.maxTurns, 7);

    const nameEdit = await dispatcher.executeTool('update_agent', { target: 'kid5', name: 'Kid Five Renamed' });
    assert.equal(nameEdit.success, true, `name edit failed: ${nameEdit.error}`);
    assert.equal(runtime.getAgent('kid5').name, 'Kid Five Renamed');

    assert.deepEqual(runtime.getAuthorityGrants('kid5'), [], 'capability edits mint no authority');

    // A privileged parent may promote a child within its own level.
    await runtime.launchAgent({ config: { id: 'pp5', privileged: true } });
    const adminDispatcher = dispatcherFor(runtime, 'pp5');
    await launchAgent(runtime, 'kidsudo', { parentId: 'pp5', tools: ['readonly'] });
    const promote = await adminDispatcher.executeTool('update_agent', { target: 'kidsudo', privileged: true });
    assert.equal(promote.success, true, `a privileged parent may promote within its own level: ${promote.error}`);
    assert.equal(runtime.getAgent('kidsudo').config.privileged, true);
  } finally {
    runtime.destroy();
  }
});

test('6. operator-only keys fail the whole call with uniform PERMISSION_DENIED and zero mutation', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p6', { tools: ['manager'] });
    await launchAgent(runtime, 'kid6', { parentId: 'p6' });
    const dispatcher = dispatcherFor(runtime, 'p6');
    const kid = runtime.getAgent('kid6');
    const before = {
      name: kid.name,
      realmId: kid.config.realmId,
      spawnedBy: kid.config.spawnedBy,
      authorities: runtime.getAuthorityGrants('kid6').length
    };

    const cases = [
      ['modelConfig', { modelId: 'sneaky' }],
      ['modelConfig', null],
      ['presetId', 'sneaky-preset'],
      ['workspaceId', 'peer-workspace'],
      ['workspace', 'peer-workspace'],
      ['extensionTools', null],
      ['settings', {}],
      ['customTools', null],
      ['customToolSchemas', null],
      ['role', 'admin'],
      ['isAdmin', false],
      ['isPrivileged', false],
      ['spawnedBy', null],
      ['creatorId', null],
      ['realmId', null],
      ['realmBypass', false],
      ['templateAuthority', false],
      ['hydrationAuthority', false],
      ['authorities', []],
      [AGENT_AUTHORITIES.AGENT_EDIT, false],
      [AGENT_AUTHORITIES.TEMPLATE, null]
    ];
    for (const [key, value] of cases) {
      const receipt = await dispatcher.executeTool('update_agent', { target: 'kid6', [key]: value });
      assert.equal(receipt.success, false, `'${key}' must fail the whole call`);
      assert.equal(receipt.code, 'PERMISSION_DENIED', `'${key}' must deny with PERMISSION_DENIED (got ${receipt.code})`);
    }

    assert.equal(kid.name, before.name, 'no partial rename');
    assert.equal(kid.config.realmId, before.realmId, 'membership untouched');
    assert.equal(kid.config.spawnedBy, before.spawnedBy, 'parentage untouched');
    assert.equal(runtime.getAuthorityGrants('kid6').length, before.authorities, 'no authority minted');

    const unknownKey = await dispatcher.executeTool('update_agent', { target: 'kid6', bogus_field: 1 });
    assert.equal(unknownKey.code, 'INVALID_ARGUMENTS', 'unknown keys are malformed params');
    const emptyPatch = await dispatcher.executeTool('update_agent', { target: 'kid6' });
    assert.equal(emptyPatch.code, 'INVALID_ARGUMENTS', 'an empty patch is malformed');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-05 / AC-M2-06 — the <=-editor bound and authority immutability
// ============================================================================

test('7. the <=-editor bound is evaluated on the resulting state (no promotion)', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p7', { tools: ['manager'] });
    await launchAgent(runtime, 'kid7', { parentId: 'p7' });
    const dispatcher = dispatcherFor(runtime, 'p7');

    const privilege = await dispatcher.executeTool('update_agent', { target: 'kid7', privileged: true });
    assert.equal(privilege.code, 'PERMISSION_DENIED', 'a non-privileged parent can never promote');
    assert.equal(runtime.getAgent('kid7').config.privileged, false);

    const wildcard = await dispatcher.executeTool('update_agent', { target: 'kid7', tools: ['*'] });
    assert.equal(wildcard.code, 'PERMISSION_DENIED', 'no wildcard promotion');
    const superset = await dispatcher.executeTool('update_agent', { target: 'kid7', tools: ['world_clock'] });
    assert.equal(superset.code, 'PERMISSION_DENIED', 'a tool outside the editor set is a promotion');
    assert.deepEqual(runtime.getAgent('kid7').config.allowedTools, ['readonly'], 'the resulting state never applied');

    // A target that out-ranks the editor on an unchanged axis is not editable.
    await runtime.launchAgent({
      config: { id: 'outrank7', spawnedBy: 'p7', allowedTools: ['world_clock'] }
    });
    const outranked = await dispatcher.executeTool('update_agent', { target: 'outrank7', name: 'nope' });
    assert.equal(outranked.code, 'PERMISSION_DENIED', 'an out-ranking target is denied even for a neutral field');
    assert.equal(runtime.getAgent('outrank7').name, 'outrank7');
  } finally {
    runtime.destroy();
  }
});

test('8. authority grants cannot be minted through update_agent', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p8', { tools: ['manager'] });
    await launchAgent(runtime, 'kid8', { parentId: 'p8' });
    const dispatcher = dispatcherFor(runtime, 'p8');

    for (const patch of [
      { authorities: [{ id: AGENT_AUTHORITIES.AGENT_EDIT }] },
      { [AGENT_AUTHORITIES.AGENT_INSPECT]: true },
      { templateAuthority: true },
      { hydrationAuthority: false },
      { tools: [AGENT_AUTHORITIES.TEMPLATE] },
      { tools: [' @TEMPLATE:authority '] },
      { tools: ['@lifecycle:authority'] }
    ]) {
      const receipt = await dispatcher.executeTool('update_agent', { target: 'kid8', ...patch });
      assert.equal(receipt.success, false, `authority attempt must fail: ${JSON.stringify(patch)}`);
      assert.equal(receipt.code, 'PERMISSION_DENIED', `authority attempt must deny: ${JSON.stringify(patch)}`);
    }
    assert.deepEqual(runtime.getAuthorityGrants('kid8'), [], 'no id was ever minted');
    assert.equal(runtime.getAuthorityDescriptor('kid8').allow.has(AGENT_AUTHORITIES.AGENT_EDIT), false);
    assert.equal(runtime.getAuthorityDescriptor('kid8').allow.has('*'), false);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-07 — safe-state queue
// ============================================================================

test('9. a busy target defers the edit, latest-wins, and applies exactly once at turn_complete', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p9', { tools: ['manager'] });
    const gate = deferred();
    await launchAgent(runtime, 'kid9', {
      parentId: 'p9',
      model: createMockModel(async () => {
        await gate.promise;
        return { content: 'late' };
      })
    });
    const dispatcher = dispatcherFor(runtime, 'p9');
    const events = [];
    runtime.subscribe((event) => events.push(event));

    const turn = runtime.enqueueUserTurn('kid9', 'long work');
    await waitUntil(() => runtime.isAgentBusy('kid9'));

    const first = await dispatcher.executeTool('update_agent', { target: 'kid9', name: 'First Deferred' });
    assert.equal(first.success, true, `deferred edit failed: ${first.error}`);
    assert.equal(first.applied, false, 'a busy target never applies mid-turn');
    assert.equal(first.deferred, true);
    const second = await dispatcher.executeTool('update_agent', { target: 'kid9', systemPrompt: 'Latest wins' });
    assert.equal(second.success, true, `second deferred edit failed: ${second.error}`);
    assert.equal(second.deferred, true);

    assert.equal(runtime.getAgent('kid9').name, 'kid9', 'nothing applied while busy');
    assert.equal(runtime.getAgent('kid9').config.systemPrompt, undefined, 'nothing applied while busy');

    gate.resolve();
    await turn;

    const kid = runtime.getAgent('kid9');
    assert.equal(kid.name, 'kid9', 'latest-wins replaced the first pending edit');
    assert.equal(kid.config.systemPrompt, 'Latest wins', 'the latest edit applied at the safe state');
    assert.equal(kid.history[0].content, 'Latest wins', 'prompt sync ran through the intrinsic channel');

    const applied = events.filter((event) => event.type === 'agent_edit_applied' && event.payload?.targetId === 'kid9');
    assert.equal(applied.length, 1, 'the edit applies exactly once');
    assert.equal(applied[0].payload.actorId, 'p9');
    assert.equal(applied[0].payload.tier, 'parental');
    const deferredEvents = events.filter((event) => event.type === 'agent_edit_deferred' && event.payload?.targetId === 'kid9');
    assert.ok(deferredEvents.length >= 1, 'the deferral is audited');
  } finally {
    runtime.destroy();
  }
});

test('10. a terminated target drops its pending edit at the teardown event', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p10', { tools: ['manager'] });
    const gate = deferred();
    await launchAgent(runtime, 'kid10', {
      parentId: 'p10',
      model: createMockModel(async () => {
        await gate.promise;
        return { content: 'late' };
      })
    });
    const dispatcher = dispatcherFor(runtime, 'p10');
    const events = [];
    runtime.subscribe((event) => events.push(event));

    const turn = runtime.enqueueUserTurn('kid10', 'long work');
    await waitUntil(() => runtime.isAgentBusy('kid10'));
    const deferredEdit = await dispatcher.executeTool('update_agent', { target: 'kid10', systemPrompt: 'never' });
    assert.equal(deferredEdit.deferred, true);

    runtime.killAgent('kid10', 'drop test', { callerAgentId: 'p10' });
    gate.resolve();
    await turn.catch(() => {});

    const recycled = runtime.getRecycledAgent('kid10');
    assert.ok(recycled, 'the target is recycled');
    assert.equal(recycled.config.systemPrompt, undefined, 'the pending edit never applied');
    const dropped = events.filter((event) => event.type === 'agent_edit_dropped' && event.payload?.targetId === 'kid10');
    assert.ok(dropped.length >= 1, 'the drop is audited');
    assert.equal(events.some((event) => event.type === 'agent_edit_applied' && event.payload?.targetId === 'kid10'), false);
  } finally {
    runtime.destroy();
  }
});

test('11. flush-time re-authorization fails closed when the grant is revoked while waiting', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'm11', { tools: ['read_file', 'update_agent'] });
    const gate = deferred();
    await launchAgent(runtime, 'victim11', {
      model: createMockModel(async () => {
        await gate.promise;
        return { content: 'late' };
      })
    });
    runtime.grantAuthority(
      'm11',
      AGENT_AUTHORITIES.AGENT_EDIT,
      { targets: ['victim11'], fields: ['prompt'] },
      { principal: runtime.getOperatorPrincipal() }
    );
    const events = [];
    runtime.subscribe((event) => events.push(event));
    const dispatcher = dispatcherFor(runtime, 'm11');

    const turn = runtime.enqueueUserTurn('victim11', 'long work');
    await waitUntil(() => runtime.isAgentBusy('victim11'));
    const edit = await dispatcher.executeTool('update_agent', { target: 'victim11', systemPrompt: 'revoked soon' });
    assert.equal(edit.deferred, true, `expected a deferral: ${edit.error}`);

    runtime.revokeAuthority('m11', AGENT_AUTHORITIES.AGENT_EDIT, { principal: runtime.getOperatorPrincipal() });
    gate.resolve();
    await turn;

    assert.equal(runtime.getAgent('victim11').config.systemPrompt, undefined, 'the revoked edit never applied');
    const dropped = events.filter((event) => event.type === 'agent_edit_dropped' && event.payload?.targetId === 'victim11');
    assert.ok(dropped.length >= 1, 'the flush re-check drop is audited');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-08 — audits
// ============================================================================

test('12. edits audit before/after summaries with bare ids and no realm vocabulary', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p12', { tools: ['manager'] });
    await launchAgent(runtime, 'kid12', { parentId: 'p12' });
    const dispatcher = dispatcherFor(runtime, 'p12');
    const events = [];
    runtime.subscribe((event) => events.push(event));

    const receipt = await dispatcher.executeTool('update_agent', { target: 'kid12', tools: ['read_file'] });
    assert.equal(receipt.success, true, `edit failed: ${receipt.error}`);

    const applied = events.find((event) => event.type === 'agent_edit_applied');
    assert.ok(applied, 'the edit is audited');
    assert.equal(applied.agentId, 'kid12');
    assert.equal(applied.payload.actorId, 'p12');
    assert.equal(applied.payload.targetId, 'kid12');
    assert.equal(applied.payload.tier, 'parental');
    assert.deepEqual(applied.payload.fields, ['tools']);
    assert.deepEqual(Object.keys(applied.payload.before).sort(), ['authorities', 'baked', 'extensions', 'privileged']);
    assert.deepEqual(Object.keys(applied.payload.after).sort(), ['authorities', 'baked', 'extensions', 'privileged']);
    assert.equal(applied.payload.before.privileged, false);
    assert.ok(Array.isArray(applied.payload.after.baked));

    const auditEvents = events.filter((event) => String(event.type).startsWith('agent_edit'));
    const serialized = JSON.stringify(auditEvents);
    for (const forbidden of ['realm:', 'realm_generic', 'system:', 'apiKey', 'http://']) {
      assert.equal(serialized.includes(forbidden), false, `audit must be realm-opaque: ${serialized}`);
    }
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-09 — meta tier
// ============================================================================

test('13. scoped @agent:inspect/@agent:edit grants are enforced (targets, ownSpawns, realmMembers, realms, fields)', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'm13', { tools: ['read_file', 'inspect_agent', 'update_agent'] });
    await launchAgent(runtime, 'other13', { tools: ['readonly'] });
    await launchAgent(runtime, 'third13', { tools: ['readonly'] });
    const operator = { principal: runtime.getOperatorPrincipal() };
    const dispatcher = dispatcherFor(runtime, 'm13');

    // No grant: both operations deny.
    assert.equal((await dispatcher.executeTool('inspect_agent', { target: 'other13' })).code, 'PERMISSION_DENIED');
    assert.equal((await dispatcher.executeTool('update_agent', { target: 'other13', name: 'x' })).code, 'PERMISSION_DENIED');

    // targets scope: only the named target; self-inspect stays allowed.
    runtime.grantAuthority('m13', AGENT_AUTHORITIES.AGENT_INSPECT, { targets: ['other13'] }, operator);
    assert.equal((await dispatcher.executeTool('inspect_agent', { target: 'other13' })).success, true);
    assert.equal((await dispatcher.executeTool('inspect_agent', { target: 'third13' })).code, 'PERMISSION_DENIED');
    assert.equal((await dispatcher.executeTool('inspect_agent', { target: 'm13' })).success, true, 'self-inspect stays allowed');

    // Field-token narrowing: tools allowed; prompt/policy/privilege/name/maxTurns denied.
    runtime.grantAuthority('m13', AGENT_AUTHORITIES.AGENT_EDIT, { targets: ['other13'], fields: ['tools'] }, operator);
    const toolsEdit = await dispatcher.executeTool('update_agent', { target: 'other13', tools: ['read_file'] });
    assert.equal(toolsEdit.success, true, `granted tools edit failed: ${toolsEdit.error}`);
    for (const patch of [{ systemPrompt: 'no' }, { triggerPolicy: 'manual' }, { privileged: true }, { maxTurns: 9 }, { name: 'no' }]) {
      const denied = await dispatcher.executeTool('update_agent', { target: 'other13', ...patch });
      assert.equal(denied.code, 'PERMISSION_DENIED', `non-granted field must deny: ${JSON.stringify(patch)}`);
    }
    await runtime.revokeAuthority('m13', AGENT_AUTHORITIES.AGENT_EDIT, operator);

    // ownSpawns scope: children only.
    await runtime.grantAuthority('m13', AGENT_AUTHORITIES.AGENT_EDIT, { ownSpawns: true }, operator);
    await launchAgent(runtime, 'mykid13', { parentId: 'm13' });
    const ownChild = await dispatcher.executeTool('update_agent', { target: 'mykid13', name: 'My Kid' });
    assert.equal(ownChild.success, true, `ownSpawns edit failed: ${ownChild.error}`);
    const notOwn = await dispatcher.executeTool('update_agent', { target: 'other13', name: 'nope' });
    assert.equal(notOwn.code, 'PERMISSION_DENIED', 'ownSpawns never reaches peers');

    // realmMembers scope: same-realm peers become reachable; fields still narrow.
    await runtime.revokeAuthority('m13', AGENT_AUTHORITIES.AGENT_EDIT, operator);
    await runtime.grantAuthority('m13', AGENT_AUTHORITIES.AGENT_EDIT, { realmMembers: true, fields: ['prompt'] }, operator);
    const member = await dispatcher.executeTool('update_agent', { target: 'other13', systemPrompt: 'member edit' });
    assert.equal(member.success, true, `realmMembers edit failed: ${member.error}`);
    const memberTools = await dispatcher.executeTool('update_agent', { target: 'other13', tools: ['read_file'] });
    assert.equal(memberTools.code, 'PERMISSION_DENIED', 'fields still narrow realmMembers');

    // realms bound: cross-realm reach only when the grant names the realm.
    await launchAgent(runtime, 'far13', { realmId: 'realm_m2_far', tools: ['readonly'] });
    await runtime.revokeAuthority('m13', AGENT_AUTHORITIES.AGENT_EDIT, operator);
    await runtime.grantAuthority(
      'm13',
      AGENT_AUTHORITIES.AGENT_INSPECT,
      { targets: ['far13'], realms: ['realm_m2_far'] },
      operator
    );
    const crossRealm = await dispatcher.executeTool('inspect_agent', { target: 'far13' });
    assert.equal(crossRealm.success, true, `realms-bounded inspect failed: ${crossRealm.error}`);
    await runtime.revokeAuthority('m13', AGENT_AUTHORITIES.AGENT_INSPECT, operator);
    await runtime.grantAuthority('m13', AGENT_AUTHORITIES.AGENT_INSPECT, { targets: ['far13'] }, operator);
    const crossRealmDenied = await dispatcher.executeTool('inspect_agent', { target: 'far13' });
    assert.equal(crossRealmDenied.code, 'PERMISSION_DENIED', 'absent realms keeps the caller realm bound');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-12 + F4
// ============================================================================

test('14. whoami shows own authority ids only (never scopes); the entity channel denies authorities (F4)', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'p14', { tools: ['manager'] });
    runtime.grantAuthority('p14', AGENT_AUTHORITIES.AGENT_INSPECT, { ownSpawns: true }, { principal: runtime.getOperatorPrincipal() });
    const dispatcher = dispatcherFor(runtime, 'p14');

    const who = await dispatcher.executeTool('whoami', {});
    assert.equal(who.success, true, `whoami failed: ${who.error}`);
    assert.deepEqual(who.authorities, [AGENT_AUTHORITIES.AGENT_INSPECT], 'own grant ids only');
    const serialized = JSON.stringify(who);
    assert.equal(serialized.includes('ownSpawns'), false, 'scopes never surface on whoami');
    assert.equal(serialized.includes('realm:'), false, 'whoami stays realm-opaque');

    // F4: the public entity channel rejects the inert `authorities` key.
    const agent = runtime.getAgent('p14');
    assert.throws(
      () => agent.updateConfig({ authorities: [{ id: AGENT_AUTHORITIES.AGENT_EDIT }] }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the entity channel must deny the authorities key'
    );
    assert.deepEqual(runtime.getAuthorityGrants('p14').map((record) => record.id), [AGENT_AUTHORITIES.AGENT_INSPECT]);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-10 — schema/handler honesty
// ============================================================================

test('15. closed schemas: only editable keys are declared and every declared key is honored', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ config: { id: 'pp15', privileged: true } });
    await launchAgent(runtime, 'kid15', { parentId: 'pp15' });
    const dispatcher = dispatcherFor(runtime, 'pp15');

    const updateDescription = await dispatcher.executeTool('describe_tool', { tool_name: 'update_agent' });
    const updateSchema = describedSchema(updateDescription);
    assert.equal(updateSchema.additionalProperties, false, 'update_agent is a closed schema');
    assert.deepEqual(
      Object.keys(updateSchema.properties).sort(),
      ['allowedTools', 'maxTurns', 'name', 'privileged', 'systemPrompt', 'target', 'toolPreset', 'tools', 'triggerPolicy'].sort()
    );
    const inspectDescription = await dispatcher.executeTool('describe_tool', { tool_name: 'inspect_agent' });
    const inspectSchema = describedSchema(inspectDescription);
    assert.equal(inspectSchema.additionalProperties, false, 'inspect_agent is a closed schema');
    assert.deepEqual(Object.keys(inspectSchema.properties), ['target']);

    for (const description of [updateDescription.description, inspectDescription.description]) {
      const text = String(description);
      for (const forbidden of ['@template', '@hydration', '@agent:', '@realm:', 'realm:', 'ownSpawns', 'realmBypass']) {
        assert.equal(text.includes(forbidden), false, `descriptions stay generic: ${text}`);
      }
    }

    // Every declared editable key is honored (no schema key is silently ignored).
    const edits = [
      { tools: ['read_file'] },
      { allowedTools: ['read_file', 'whoami'] },
      { toolPreset: 'readonly' },
      { privileged: false },
      { triggerPolicy: 'auto' },
      { systemPrompt: 'honest' },
      { maxTurns: 3 },
      { name: 'Honest' }
    ];
    for (const patch of edits) {
      const receipt = await dispatcher.executeTool('update_agent', { target: 'kid15', ...patch });
      assert.equal(receipt.success, true, `declared key must be honored: ${JSON.stringify(patch)} -> ${receipt.error}`);
    }
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// AC-M2-11 — ordinary authorization by preset (no requiredAuthority)
// ============================================================================

test('16. manager preset holders pass the dispatcher gate; other tiers never reach the handler', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await launchAgent(runtime, 'manager16', { tools: ['manager'] });
    await launchAgent(runtime, 'collab16', { tools: ['collaborator'] });
    await launchAgent(runtime, 'kid16', { parentId: 'manager16' });

    const managerDispatcher = dispatcherFor(runtime, 'manager16');
    assert.equal((await managerDispatcher.executeTool('inspect_agent', { target: 'kid16' })).success, true);
    assert.equal((await managerDispatcher.executeTool('update_agent', { target: 'kid16', name: 'ok' })).success, true);

    const collabDispatcher = dispatcherFor(runtime, 'collab16');
    for (const tool of ['inspect_agent', 'update_agent']) {
      const receipt = await collabDispatcher.executeTool(tool, { target: 'kid16', name: 'nope' });
      assert.equal(receipt.code, 'PERMISSION_DENIED', `a collaborator never reaches ${tool}`);
    }
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// F3 — scoped-grant persistence (restart round-trip)
// ============================================================================

test('17. F3: a narrowed grant stays narrowed across save -> hydrate (legacy keys-only reads unscoped)', async () => {
  sharedLocalStorage.clear();
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });
  const store = new SandboxStore({
    runtime,
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  let restoredRuntime = null;
  let legacyRuntime = null;
  try {
    await launchAgent(runtime, 'f3-alpha', { tools: ['read_file'] });
    const grantedKey = identityKeyOf(runtime, 'f3-alpha');
    const scope = { targets: ['f3-beta'], fields: ['tools'] };
    await store.grantAuthority('f3-alpha', AGENT_AUTHORITIES.AGENT_EDIT, scope);

    const snapshot = store.serialize();
    assert.ok(Array.isArray(snapshot.authorityGrants[AGENT_AUTHORITIES.AGENT_EDIT]));
    const entry = snapshot.authorityGrants[AGENT_AUTHORITIES.AGENT_EDIT][0];
    assert.equal(typeof entry, 'object', 'a scoped grant persists as a scoped entry');
    assert.equal(entry.ref, grantedKey);
    assert.deepEqual(entry.scope, scope, 'the snapshot carries the scope');
    assert.equal(validateSandboxState(snapshot).valid, true, 'the scoped snapshot validates');

    assert.equal(store.saveToStorage(), true);
    const restoredVfs = new VirtualFS();
    const restoredBus = new MessagingBus();
    restoredRuntime = new AgentRuntime({ virtualFs: restoredVfs, messagingBus: restoredBus, autoBootstrapDirector: false });
    const restoredStore = new SandboxStore({
      runtime: restoredRuntime,
      virtualFs: restoredVfs,
      messagingBus: restoredBus,
      autoBootstrapDirector: false,
      autoHydrate: true
    });
    try {
      assert.deepEqual(
        restoredRuntime.getAuthorityGrants(grantedKey),
        [{ id: AGENT_AUTHORITIES.AGENT_EDIT, scope }],
        'the narrowed grant survives the restart'
      );
      assert.deepEqual(restoredStore.listAuthorityGrants(), { [AGENT_AUTHORITIES.AGENT_EDIT]: [grantedKey] });
    } finally {
      restoredStore.destroy();
    }

    // Legacy keys-only entries remain readable as unscoped.
    const legacySnapshot = JSON.parse(JSON.stringify(snapshot));
    legacySnapshot.authorityGrants = { [AGENT_AUTHORITIES.AGENT_INSPECT]: [grantedKey] };
    assert.equal(validateSandboxState(legacySnapshot).valid, true, 'keys-only entries stay valid');
    sharedLocalStorage.clear();
    assert.equal(saveSandboxState(legacySnapshot), true);
    const legacyVfs = new VirtualFS();
    const legacyBus = new MessagingBus();
    legacyRuntime = new AgentRuntime({ virtualFs: legacyVfs, messagingBus: legacyBus, autoBootstrapDirector: false });
    const legacyStore = new SandboxStore({
      runtime: legacyRuntime,
      virtualFs: legacyVfs,
      messagingBus: legacyBus,
      autoBootstrapDirector: false,
      autoHydrate: true
    });
    try {
      assert.deepEqual(
        legacyRuntime.getAuthorityGrants(grantedKey),
        [{ id: AGENT_AUTHORITIES.AGENT_INSPECT }],
        'a legacy keys-only entry restores unscoped'
      );
    } finally {
      legacyStore.destroy();
    }
  } finally {
    if (legacyRuntime) legacyRuntime.destroy();
    if (restoredRuntime) restoredRuntime.destroy();
    store.destroy();
    runtime.destroy();
  }
});
