/**
 * @file tests/audit/repros/5b585b7.test.js
 * @description Audit repro for ticket 5b585b7 (Major; MOD-21 W10-A): the live
 * `Agent#config` object is a mutable authority channel. The W9 entity-method
 * gate (`Agent#updateConfig`, 4eaf2cc) denies authority-bearing fields, but a
 * caller holding the entity reference returned by the public
 * `runtime.getAgent()` writes the live config directly (`config.privileged =
 * true`, `Object.assign(config, { allowedTools: ['*'] })`, `config.spawnedBy =
 * caller`) and mints tool capability, turns the per-turn dispatcher privileged
 * and forges lifecycle parentage without a principal.
 *
 * Expected (ratified W10): authority-bearing config fields are owner-controlled
 * read-only projections backed by private entity state; direct writes,
 * `Object.assign` and whole-object replacement cannot change authority; only
 * the lifecycle manager's gated path may apply authority updates.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/5b585b7.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

/**
 * Runs a hostile write without letting a strict-mode TypeError abort the probe.
 * @param {() => void} write
 */
function attemptWrite(write) {
  try {
    write();
  } catch (_) {
    // A throwing write is an acceptable (fail-closed) outcome.
  }
}

/**
 * Builds the same per-turn dispatcher binding `turnExecutionEngine` derives
 * from the live entity config (turnExecutionEngine.js:854-889).
 *
 * @param {import('../../../src/lib/sandbox/runtime/agent/index.ts').Agent} agent
 * @param {VirtualFS} virtualFs
 * @param {object} identityPort
 * @returns {Function}
 */
function buildPerTurnDispatcher(agent, virtualFs, identityPort) {
  const isPrivileged = Boolean(agent.config?.privileged);
  const isUniversalTools = Array.isArray(agent.config.allowedTools) && agent.config.allowedTools.includes('*');
  return createSandboxToolDispatcher({
    virtualFs,
    messagingBus: null,
    agentId: agent.id,
    role: agent.config.role || (isPrivileged ? 'admin' : 'user'),
    privileged: isPrivileged,
    allowedTools: isUniversalTools ? ['*'] : (agent.config.allowedTools || null),
    identityPort
  });
}

test('5b585b7: direct config writes cannot mint tool capability', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'victim' });

    const identityPort = runtime.createAgentIdentityPort();
    const vfs = new VirtualFS({ identityPort });
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: vfs,
      identityPort,
      lifecyclePort: runtime.createLifecyclePort(),
      callerAgentId: 'mallory'
    });

    const baseline = await dispatcher.executeTool('write_file', {
      file_path: '/global/pwn.txt',
      content: 'x'
    });
    assert.strictEqual(baseline.success, false, 'baseline: an unprivileged agent cannot write outside its workspace');
    assert.strictEqual(baseline.code, 'PERMISSION_DENIED');

    const liveConfig = runtime.getAgent('mallory').config;
    attemptWrite(() => { liveConfig.privileged = true; });
    attemptWrite(() => { Object.assign(liveConfig, { privileged: true }); });
    attemptWrite(() => { liveConfig.allowedTools = ['*']; });
    attemptWrite(() => { liveConfig.tools = '*'; });
    attemptWrite(() => { Object.assign(liveConfig, { allowedTools: ['*'], tools: ['*'] }); });
    attemptWrite(() => { liveConfig.role = 'admin'; });
    attemptWrite(() => {
      Object.defineProperty(liveConfig, 'privileged', { value: true, writable: true, enumerable: true, configurable: true });
    });

    const agent = runtime.getAgent('mallory');
    assert.strictEqual(agent.config.privileged, false, 'direct writes must not mint privilege on the live config');
    assert.deepStrictEqual(agent.config.allowedTools, ['read_file'], 'direct writes must not widen the live whitelist');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('mallory').privileged,
      false,
      'the identity projection must stay unprivileged'
    );
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('mallory').authority.allow.has('*'),
      false,
      'the registry descriptor must stay default-deny'
    );

    const afterDirect = await dispatcher.executeTool('write_file', { file_path: '/global/pwn.txt', content: 'x' });
    assert.strictEqual(afterDirect.success, false, 'the dispatcher must stay default-deny after direct config writes');
    assert.strictEqual(afterDirect.code, 'PERMISSION_DENIED');

    // Whole-object replacement through the public entity reference.
    attemptWrite(() => {
      runtime.getAgent('mallory').config = { id: 'mallory', privileged: true, allowedTools: ['*'], tools: ['*'] };
    });
    const afterReplace = await dispatcher.executeTool('write_file', { file_path: '/global/pwn.txt', content: 'x' });
    assert.strictEqual(afterReplace.success, false, 'whole-object config replacement must not grant capability');
    assert.strictEqual(afterReplace.code, 'PERMISSION_DENIED');

    // Per-turn dispatcher binding (turnExecutionEngine.js:854-889) must not honor entity-mutated config.
    const perTurn = buildPerTurnDispatcher(runtime.getAgent('mallory'), vfs, identityPort);
    const perTurnReceipt = await perTurn.executeTool('write_file', { file_path: '/global/pwn.txt', content: 'x' });
    assert.strictEqual(perTurnReceipt.success, false, 'the per-turn dispatcher must stay default-deny');
    assert.strictEqual(perTurnReceipt.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('5b585b7: direct parentage writes cannot forge lifecycle authority', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory' });
    await runtime.launchAgent({ id: 'victim' });

    const victim = runtime.getAgent('victim');
    attemptWrite(() => { victim.config.spawnedBy = 'mallory'; });
    attemptWrite(() => { victim.config.creatorId = 'mallory'; });
    attemptWrite(() => { Object.assign(victim.config, { spawnedBy: 'mallory', creatorId: 'mallory' }); });
    attemptWrite(() => { victim.spawnedBy = 'mallory'; });
    attemptWrite(() => { victim.creatorId = 'mallory'; });

    assert.strictEqual(runtime.getAgent('victim').config.spawnedBy, null, 'forged parentage must not land on the live config');
    assert.strictEqual(runtime.getAgent('victim').config.creatorId, null, 'forged parentage must not land on the live config');

    assert.throws(
      () => runtime.killAgent('victim', 'forged parentage', { callerAgentId: 'mallory' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a peer cannot kill through directly written parentage'
    );
    assert.ok(runtime.getAgent('victim'), 'the denied kill leaves the victim active');

    const invocation = runtime.invokeAgent('mallory', 'victim', 'P');
    assert.strictEqual(invocation.success, false, 'a peer cannot invoke through directly written parentage');
    assert.strictEqual(invocation.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('5b585b7: gated manager grants still apply after the hardening', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director')?.authority;

    const granted = runtime.updateAgentConfig('mallory', { privileged: true, allowedTools: ['*'] }, { principal: operator });
    assert.strictEqual(granted.config.privileged, true, 'the gated manager path still applies privilege');
    assert.deepStrictEqual(granted.config.allowedTools, ['*'], 'the gated manager path still applies capability');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('mallory').authority.allow.has('*'),
      true,
      'the operator grant rebuilds the registry descriptor'
    );

    const stored = structuredClone(runtime.getAgent('mallory').config);
    assert.strictEqual(stored.privileged, true, 'the applied privilege must serialize through the live config');
  } finally {
    runtime.destroy();
  }
});
