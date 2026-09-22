/**
 * @file tests/audit/repros/identity_restore_subject.test.js
 * @description Red-first audit repro for Wave I I2-V residual R5 (MEDIUM,
 * security; ticket d57cbc1): `restoreAgent` re-derived the frozen authority
 * descriptor with the raw `agentId` argument as the descriptor subject
 * (`src/lib/sandbox/runtime/agentLifecycle/index.ts`, restore path). A restore
 * addressed by the canonical identity key — a supported input used by the
 * wave's matrix and teardown lanes — therefore registered the canonical key as
 * `authority.subject`: the restored same-id registration became invisible to
 * itself (`listAgentDescriptors` and the `list_agents` tool projected `[]`)
 * and lifecycle denials echoed the key. The fix resolves the recycled record
 * first and always registers the descriptor under the record's bare
 * realm-local `agent.id` (precedent F3 `#setRealmBypass`), keeping the subject
 * opaque and the restored agent's self-view intact.
 *
 * Red at HEAD 4f0d7aed (pre-fix): after kill+restore by canonical key the
 * projected subject is the canonical key, the same-id caller's descriptor
 * listing and `list_agents` return `[]`, and the cross-Realm denial echoes the
 * key.
 *
 * Run directly (not part of `npm test`):
 *   timeout 180 node tests/audit/repros/identity_restore_subject.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

/** Realm of the restored same-id registration under test. */
const ALPHA = 'realm_g7r5_alpha';
/** Realm of the untouched same-id twin and the denial target. */
const BETA = 'realm_g7r5_beta';

/** Tool grants of the shared ordinary `scout` caller. */
const SCOUT_TOOLS = Object.freeze(['read_file', 'list_agents']);

/**
 * Deterministic in-memory model accepted by the store's launch path (repo
 * convention): no turn is driven here, so no request ever leaves the process.
 *
 * @param {string} output - Static assistant text.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output) {
  return {
    id: `g7r5-model-${output}`,
    config: {},
    provider: {
      id: `g7r5-provider-${output}`,
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: `g7r5-model-${output}`, name: 'G7-R5 Model' }]
    },
    async *stream(options = {}) {
      if (typeof options.onChunk === 'function') options.onChunk(output);
      yield { type: 'text', content: output };
      yield { type: 'finish', finishReason: 'stop', content: output, reasoning: '', toolCalls: [] };
    },
    async complete() {
      return { role: 'assistant', content: output };
    }
  };
}

/**
 * Asserts an agent-visible value is realm-opaque: no canonical-key prefix and
 * no realm identifier may appear.
 *
 * @param {string} value - Serialized receipt or message under test.
 * @param {string} label - Assertion label.
 */
function assertRealmOpaque(value, label) {
  assert.equal(value.includes('realm:'), false, `${label} must not carry a canonical key: ${value}`);
  assert.equal(value.includes(ALPHA), false, `${label} must not expose its realm id: ${value}`);
  assert.equal(value.includes(BETA), false, `${label} must not expose a foreign realm id: ${value}`);
}

/**
 * Captures a throwing lifecycle call for receipt-style assertions.
 *
 * @param {Function} fn - Synchronous call under test.
 * @returns {{ ok: boolean, code?: string, message?: string, value?: unknown }} Outcome.
 */
function capture(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, code: err && err.code, message: String(err && err.message) };
  }
}

/**
 * Builds the two-Realm same-id fixture: an ordinary `scout` per Realm plus a
 * Beta denial target. The untouched Beta twin is the control that keeps the
 * pre-fix behavior visible in the projection comparisons.
 *
 * @returns {Promise<object>} Live fixture with realm-exact projections.
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  await store.ensureDirector();
  store.createRealm({ id: ALPHA, name: 'G7-R5 Alpha' });
  store.createRealm({ id: BETA, name: 'G7-R5 Beta' });

  await store.launchAgent(
    { id: 'scout', realmId: ALPHA, allowedTools: [...SCOUT_TOOLS] },
    createDeterministicModel('g7r5-alpha-scout')
  );
  await store.launchAgent(
    { id: 'scout', realmId: BETA, allowedTools: [...SCOUT_TOOLS] },
    createDeterministicModel('g7r5-beta-scout')
  );
  await store.launchAgent(
    { id: 'beta_lead', realmId: BETA, allowedTools: ['read_file'] },
    createDeterministicModel('g7r5-beta-lead')
  );

  const identityPort = runtime.createAgentIdentityPort();
  const alpha = identityPort.getAgentIdentity('scout', { realmId: ALPHA });
  const beta = identityPort.getAgentIdentity('scout', { realmId: BETA });
  assert.ok(alpha?.key && beta?.key, 'fixture: both same-id registrations resolve canonical keys');
  assert.notEqual(alpha.key, beta.key, 'fixture: the two registrations are distinct');

  return { runtime, store, operator: runtime.getOperatorPrincipal(), alpha, beta };
}

/**
 * Recycles the Alpha scout by canonical key and restores it the same way (the
 * supported keyed input this residual concerns).
 *
 * @param {object} fixture - Live fixture.
 */
function recycleAndRestoreAlphaByKey(fixture) {
  fixture.runtime.killAgent(fixture.alpha.key, 'g7-r5 restore probe', { principal: fixture.operator });
  fixture.runtime.restoreAgent(fixture.alpha.key, { principal: fixture.operator });
}

test('d57cbc1 G7-R5: a canonical-key restore keeps the bare subject and the agent self-view', async () => {
  const fixture = await createFixture();
  const { runtime, store, alpha, beta } = fixture;
  try {
    const identityPort = runtime.createAgentIdentityPort();
    assert.equal(
      identityPort.getAgentIdentity(alpha.key).authority?.subject,
      'scout',
      'fixture: the pre-restore subject is the bare realm-local id'
    );

    recycleAndRestoreAlphaByKey(fixture);

    // 1. The restored descriptor subject is the record's bare id — never the
    // caller-supplied canonical key.
    const restored = identityPort.getAgentIdentity(alpha.key);
    assert.ok(restored, 'fixture: the restored registration resolves by key');
    assert.equal(
      restored.authority?.subject,
      'scout',
      'the restored descriptor subject stays the bare realm-local id'
    );
    assertRealmOpaque(String(restored.authority?.subject), 'the restored descriptor subject');

    // 2. The restored same-id agent resolves its own descriptor through both
    // the scoped projector and its bound `list_agents` tool.
    const listed = runtime
      .createLifecyclePort()
      .listAgentDescriptors({ callerAgentId: 'scout', callerKey: alpha.key });
    assert.deepEqual(
      listed.map((descriptor) => descriptor.id),
      ['scout'],
      'the restored same-id caller resolves its own descriptor listing'
    );
    const toolListed = await createSandboxToolDispatcher({
      runtime,
      agentId: 'scout',
      callerAgentId: 'scout',
      callerKey: alpha.key,
      allowedTools: ['list_agents'],
      virtualFs: runtime.virtualFs,
      messagingBus: runtime.messagingBus,
      worldClock: runtime.worldClock
    }).executeTool('list_agents', {});
    assert.equal(toolListed.success, true, `the restored agent list_agents must succeed: ${JSON.stringify(toolListed)}`);
    assert.deepEqual(
      toolListed.result.map((descriptor) => descriptor.id),
      ['scout'],
      'the restored agent sees itself in list_agents'
    );
    assertRealmOpaque(JSON.stringify(toolListed), 'the restored agent list_agents receipt');

    // Control: the untouched Beta twin keeps its bare subject and self-view.
    assert.equal(
      identityPort.getAgentIdentity(beta.key).authority?.subject,
      'scout',
      'the untouched twin subject is unchanged'
    );
    assert.deepEqual(
      runtime.createLifecyclePort().listAgentDescriptors({ callerAgentId: 'scout', callerKey: beta.key }).map((d) => d.id),
      ['scout'],
      'the untouched twin self-view is unchanged'
    );
  } finally {
    store.destroy();
    runtime.destroy();
  }
});

test('d57cbc1 G7-R5: a canonical-key restore never echoes the key in a cross-Realm denial', async () => {
  const fixture = await createFixture();
  const { runtime, store, alpha } = fixture;
  try {
    recycleAndRestoreAlphaByKey(fixture);

    // The restored descriptor is the caller's own principal, so its subject is
    // what the realm gate echoes: a polluted subject leaks the canonical key
    // into an agent-visible denial.
    const denial = capture(() =>
      runtime.updateAgentConfig('beta_lead', { systemPrompt: 'g7-r5' }, { callerAgentId: alpha.key, callerKey: alpha.key })
    );
    assert.equal(denial.ok, false, `the cross-Realm update must be denied: ${JSON.stringify(denial)}`);
    assert.equal(denial.code, 'PERMISSION_DENIED', 'the cross-Realm denial uses PERMISSION_DENIED');
    assertRealmOpaque(String(denial.message), 'the cross-Realm denial');
    assert.equal(
      denial.message.includes("agent 'scout'"),
      true,
      `the denial identifies the bare caller subject: ${denial.message}`
    );
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
