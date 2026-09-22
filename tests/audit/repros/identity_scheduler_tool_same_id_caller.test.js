/**
 * @file tests/audit/repros/identity_scheduler_tool_same_id_caller.test.js
 * @description Red-first audit repro for Wave I I2-V final residual R4 (MEDIUM,
 * security; ticket d57cbc1): the scheduler tool lane resolved its caller from
 * the bare bound subject only and dropped the dispatcher-pinned canonical
 * `callerKey` (`tools/descriptors/schedulerTools.ts:81-100`). For a lawful
 * same-id pair (`scout` registered in two Realms) the tool lane therefore
 * armed a bare `agentRef` for its own timer — at expiry the trigger dropped and
 * neither twin woke — `list_schedules` returned `[]`, and `cancel_schedule`
 * denied the caller as anonymous. With only the other Realm's twin active
 * (stale key after a recycle) the surviving twin was resolved as the principal
 * and owned the schedule (retarget class, same as R2 in this lane).
 *
 * The fix mirrors the G1/F4 caller-resolution pattern: read only the
 * dispatcher-pinned `context.callerKey` (plus the construction-bound realm
 * scope where present), resolve the caller realm-exactly, forward the key in
 * the scheduler principal context so the armed task stores the caller's
 * canonical dispatch ref, fail closed when a supplied key does not resolve,
 * and deny ambiguous keyless callers.
 *
 * Red at HEAD 204c18fe (pre-fix):
 * - the same-id schedule arms `agentRef: 'scout'` (bare), the listing is `[]`,
 *   the cancel denies as anonymous, and neither twin wakes;
 * - the stale-key schedule succeeds and arms the surviving twin's canonical
 *   ref (retarget), and with both holders recycled it anonymous-degrades.
 *
 * Run directly (not part of `npm test`):
 *   timeout 180 node tests/audit/repros/identity_scheduler_tool_same_id_caller.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

/** Realm of the caller whose dispatcher is under test. */
const ALPHA = 'realm_g6r4_alpha';
/** Realm of the same-id twin. */
const BETA = 'realm_g6r4_beta';

/** Scheduler grants of the shared ordinary `scout` caller. */
const SCOUT_TOOLS = Object.freeze(['schedule', 'list_schedules', 'cancel_schedule']);

/** Delay long enough to never expire inside a test. */
const LONG_DELAY_SECONDS = 240;

/** Settle window covering a 1s timer plus turn dispatch. */
const FIRE_SETTLE_MS = 1800;

/** Settle helper for timer/turn dispatch. */
const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asserts an agent-visible receipt is realm-opaque: no canonical-key prefix,
 * realm vocabulary, or realm identifier may appear.
 *
 * @param {unknown} value - Receipt under test.
 * @param {string} label - Assertion label.
 */
function assertRealmOpaque(value, label) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes('realm:'), false, `${label} must not carry a canonical key: ${serialized}`);
  assert.equal(serialized.includes(ALPHA), false, `${label} must not expose its realm id: ${serialized}`);
  assert.equal(serialized.includes(BETA), false, `${label} must not expose a foreign realm id: ${serialized}`);
}

/**
 * Deterministic in-memory model accepted by the store's launch path (repo
 * convention): the runtime, bus, VFS, clock, queue, scheduler, and identity
 * registries all stay real; this fixture never touches the network.
 *
 * @param {string} output - Static assistant text.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output) {
  return {
    id: `g6r4-model-${output}`,
    config: {},
    provider: {
      id: `g6r4-provider-${output}`,
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: `g6r4-model-${output}`, name: 'G6-R4 Model' }]
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
 * Builds a dispatcher with an explicitly pinned canonical `callerKey`, exactly
 * as the turn engine binds the trusted key into a mid-turn execution context
 * (trusted construction output; per-call claims are stripped).
 *
 * @param {object} runtime - Live runtime.
 * @param {string} callerKey - Pinned canonical identity key to bind.
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, callerKey) {
  return createSandboxToolDispatcher({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    agentId: 'scout',
    callerAgentId: 'scout',
    callerKey,
    allowedTools: [...SCOUT_TOOLS],
    lifecyclePort: runtime.createLifecyclePort(),
    identityPort: runtime.createAgentIdentityPort()
  });
}

/**
 * Builds the two-Realm same-id fixture: an ordinary `scout` per Realm plus the
 * pinned-key dispatchers.
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
  store.createRealm({ id: ALPHA, name: 'G6-R4 Alpha' });
  store.createRealm({ id: BETA, name: 'G6-R4 Beta' });

  await store.launchAgent(
    { id: 'scout', realmId: ALPHA, allowedTools: [...SCOUT_TOOLS] },
    createDeterministicModel('g6r4-alpha-scout')
  );
  await store.launchAgent(
    { id: 'scout', realmId: BETA, allowedTools: [...SCOUT_TOOLS] },
    createDeterministicModel('g6r4-beta-scout')
  );

  const identityPort = runtime.createAgentIdentityPort();
  const alpha = identityPort.getAgentIdentity('scout', { realmId: ALPHA });
  const beta = identityPort.getAgentIdentity('scout', { realmId: BETA });
  assert.ok(alpha?.key && beta?.key, 'fixture: both same-id registrations resolve canonical keys');
  assert.notEqual(alpha.key, beta.key, 'fixture: the two registrations are distinct');

  return {
    runtime,
    store,
    operator: runtime.getOperatorPrincipal(),
    alpha,
    beta,
    alphaDispatcher: dispatcherFor(runtime, alpha.key),
    betaDispatcher: dispatcherFor(runtime, beta.key)
  };
}

/**
 * Reads one exported schedule record by timer id.
 *
 * @param {object} runtime - Live runtime.
 * @param {string} timerId - Scheduler timer id.
 * @returns {object|undefined} Exported record.
 */
function exportByTimerId(runtime, timerId) {
  return runtime.exportSchedules().find((entry) => entry.timerId === timerId);
}

test('d57cbc1 G6-R4: a same-id tool caller arms, lists, cancels, and wakes realm-exactly', async () => {
  const fixture = await createFixture();
  const { runtime, store, alpha, beta, alphaDispatcher } = fixture;
  try {
    const alphaEntity = runtime.getAgent(alpha.key);
    const betaEntity = runtime.getAgent(beta.key);
    const alphaBefore = alphaEntity.history.length;
    const betaBefore = betaEntity.history.length;

    // Tool-path self-wake: the armed task must carry the caller's canonical
    // dispatch ref so the expiry trigger addresses the exact registration.
    const armed = await alphaDispatcher.executeTool('schedule', {
      action: 'prompt',
      prompt: 'g6r4-alpha-wake',
      delay_seconds: 1
    });
    assert.equal(armed.success, true, `the same-id tool schedule must arm: ${JSON.stringify(armed)}`);
    assert.equal(armed.targetAgentId, 'scout', 'the receipt projects the bare target id');
    assertRealmOpaque(armed, 'the same-id schedule receipt');
    assert.equal(exportByTimerId(runtime, armed.timerId).agentRef, alpha.key, 'the armed task stores the caller canonical dispatch ref');

    // A foreign same-id timer is armed to prove the caller view is scoped.
    const betaTimer = runtime.schedule(
      { agentId: 'scout', prompt: 'g6r4-beta-control', durationSeconds: LONG_DELAY_SECONDS, timerCondition: 'never' },
      { principal: beta.authority, callerKey: beta.key }
    );
    assert.equal(betaTimer.success, true, `fixture beta timer failed: ${JSON.stringify(betaTimer)}`);

    const longArm = await alphaDispatcher.executeTool('schedule', {
      action: 'prompt',
      prompt: 'g6r4-alpha-long',
      delay_seconds: LONG_DELAY_SECONDS
    });
    assert.equal(longArm.success, true, `the same-id long schedule must arm: ${JSON.stringify(longArm)}`);

    // The caller sees and cancels its own timers; the foreign twin's is invisible.
    const listed = await alphaDispatcher.executeTool('list_schedules', {});
    assert.equal(listed.success, true, `the same-id listing must succeed: ${JSON.stringify(listed)}`);
    const listedIds = listed.schedules.map((entry) => entry.timerId);
    assert.ok(listedIds.includes(armed.timerId), 'the same-id caller sees its own firing timer');
    assert.ok(listedIds.includes(longArm.timerId), 'the same-id caller sees its own long timer');
    assert.equal(listedIds.includes(betaTimer.timerId), false, 'the foreign same-id timer is never listed');
    assertRealmOpaque(listed, 'the same-id listing');

    const cancelled = await alphaDispatcher.executeTool('cancel_schedule', { task_id: longArm.timerId });
    assert.equal(cancelled.success, true, `the same-id caller must cancel its own timer: ${JSON.stringify(cancelled)}`);
    assert.equal(exportByTimerId(runtime, longArm.timerId).status, 'cancelled', 'the caller timer is cancelled');
    assertRealmOpaque(cancelled, 'the same-id cancel receipt');

    // At expiry only the caller's own twin wakes; the foreign same-id twin
    // stays untouched (the pre-fix bare ref dropped the trigger entirely).
    await settle(FIRE_SETTLE_MS);
    assert.equal(
      runtime.getAgent(alpha.key).history.length > alphaBefore,
      true,
      'the caller own twin wakes at expiry'
    );
    assert.equal(
      runtime.getAgent(beta.key).history.length,
      betaBefore,
      'the foreign same-id twin never wakes'
    );
    assert.equal(exportByTimerId(runtime, armed.timerId).status, 'triggered', 'the caller timer fired');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});

test('d57cbc1 G6-R4: a stale pinned key fails closed on every scheduler tool', async () => {
  const fixture = await createFixture();
  const { runtime, store, operator, alpha, beta, betaDispatcher } = fixture;
  const stale = fixture.alphaDispatcher;
  try {
    // Control: the beta twin's own pinned dispatcher keeps working.
    const freshArm = await betaDispatcher.executeTool('schedule', {
      action: 'prompt',
      prompt: 'g6r4-beta-hold',
      delay_seconds: LONG_DELAY_SECONDS
    });
    assert.equal(freshArm.success, true, `the fresh-key control must arm: ${JSON.stringify(freshArm)}`);
    assert.equal(exportByTimerId(runtime, freshArm.timerId).agentRef, beta.key, 'the control stores the beta canonical ref');

    // One twin alive: recycle the Alpha holder whose key the stale dispatcher holds.
    runtime.killAgent(alpha.key, 'g6r4 stale probe', { principal: operator });
    assert.ok(runtime.getAgent(beta.key), 'fixture: the beta twin stays active');

    const pendingPrompts = () =>
      runtime.exportSchedules().filter((entry) => entry.status === 'pending').map((entry) => ({ ref: entry.agentRef, prompt: entry.prompt }));

    const staleArm = await stale.executeTool('schedule', {
      action: 'prompt',
      prompt: 'g6r4-stale-arm',
      delay_seconds: LONG_DELAY_SECONDS
    });
    assert.equal(staleArm.success, false, `the stale-key schedule must fail closed: ${JSON.stringify(staleArm)}`);
    assert.equal(staleArm.code, 'PERMISSION_DENIED', 'the stale schedule denial uses PERMISSION_DENIED');
    assert.equal(pendingPrompts().some((entry) => entry.prompt === 'g6r4-stale-arm'), false, 'the stale arm stores no task');
    assert.equal(
      pendingPrompts().some((entry) => entry.ref === beta.key && entry.prompt === 'g6r4-stale-arm'),
      false,
      'the stale key never retargets the beta twin'
    );
    assertRealmOpaque(staleArm, 'the stale schedule denial');

    const staleList = await stale.executeTool('list_schedules', {});
    assert.equal(staleList.success, false, `the stale key must not list: ${JSON.stringify(staleList)}`);
    assert.equal(staleList.code, 'PERMISSION_DENIED', 'the stale listing denial uses PERMISSION_DENIED');

    const staleCancel = await stale.executeTool('cancel_schedule', { task_id: freshArm.timerId });
    assert.equal(staleCancel.success, false, `the stale key must not cancel: ${JSON.stringify(staleCancel)}`);
    assert.equal(staleCancel.code, 'PERMISSION_DENIED', 'the stale cancel denial uses PERMISSION_DENIED');
    assert.equal(exportByTimerId(runtime, freshArm.timerId).status, 'pending', 'the beta control timer survives the denied cancel');

    // Both holders recycled: no anonymous degradation, no bare-ref task.
    runtime.killAgent(beta.key, 'g6r4 stale probe 2', { principal: operator });
    const staleArm2 = await stale.executeTool('schedule', {
      action: 'prompt',
      prompt: 'g6r4-stale-arm-2',
      delay_seconds: LONG_DELAY_SECONDS
    });
    assert.equal(staleArm2.success, false, `the fully stale key must not anonymous-degrade: ${JSON.stringify(staleArm2)}`);
    assert.equal(staleArm2.code, 'PERMISSION_DENIED', 'the degraded schedule denial uses PERMISSION_DENIED');
    assert.equal(pendingPrompts().some((entry) => entry.prompt === 'g6r4-stale-arm-2'), false, 'no task is armed');
    assert.equal(
      pendingPrompts().some((entry) => entry.ref === 'scout'),
      false,
      'no anonymous bare-ref task exists'
    );
    assertRealmOpaque(staleArm2, 'the degraded schedule denial');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
