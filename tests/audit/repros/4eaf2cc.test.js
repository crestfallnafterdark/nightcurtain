/**
 * @file tests/audit/repros/4eaf2cc.test.js
 * @description Audit repro for ticket 4eaf2cc (Major; MOD-21-A2): the
 * `AgentLifecycleManager.updateAgentConfig` authority gate covers only the
 * manager facade. The public entity obtained through `runtime.getAgent()`
 * exposes `Agent#updateConfig`, which merges arbitrary fields into the live
 * `config` with no principal. Downstream consumers read that live config:
 * the identity projection mints `privileged`/`allowedTools` capability, and
 * `killAgent`/`invokeAgent` treat `spawnedBy`/`creatorId` as parent authority.
 *
 * Expected (ratified W9-B): the entity channel denies authority-bearing
 * mutations pre-mutation with `PERMISSION_DENIED`; only the gated lifecycle
 * manager may apply `privileged`, `allowedTools`, `tools`, `toolPreset`,
 * `role`, `spawnedBy`, and `creatorId`.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/4eaf2cc.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

const AUTHORITY_FIELDS = [
  { label: 'privileged', patch: { privileged: true } },
  { label: "allowedTools: ['*']", patch: { allowedTools: ['*'] } },
  { label: "tools: '*'", patch: { tools: '*' } },
  { label: 'toolPreset: all', patch: { toolPreset: 'all' } },
  { label: 'role: admin', patch: { role: 'admin' } },
  { label: 'spawnedBy', patch: { spawnedBy: 'mallory' } },
  { label: 'creatorId', patch: { creatorId: 'mallory' } }
];

test('4eaf2cc: entity updateConfig cannot mint tool capability', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });

    const vfs = new VirtualFS({ identityPort: runtime.createAgentIdentityPort() });
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: vfs,
      identityPort: runtime.createAgentIdentityPort(),
      lifecyclePort: runtime.createLifecyclePort(),
      callerAgentId: 'mallory'
    });

    const baseline = await dispatcher.executeTool('write_file', {
      file_path: '/global/pwn.txt',
      content: 'x'
    });
    assert.strictEqual(baseline.success, false, 'an unprivileged agent cannot write outside its workspace');
    assert.strictEqual(baseline.code, 'PERMISSION_DENIED');

    const agent = runtime.getAgent('mallory');
    for (const { label, patch } of AUTHORITY_FIELDS) {
      assert.throws(
        () => agent.updateConfig(patch),
        (err) => err?.code === 'PERMISSION_DENIED',
        `entity updateConfig must deny authority-bearing field '${label}' pre-mutation`
      );
    }

    assert.strictEqual(agent.config.privileged, false, 'the privilege mint must not land');
    assert.deepStrictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('mallory').allowedTools,
      ['read_file'],
      'the capability projection must not widen'
    );

    const after = await dispatcher.executeTool('write_file', {
      file_path: '/global/pwn.txt',
      content: 'x'
    });
    assert.strictEqual(after.success, false, 'the dispatcher must stay default-deny after denied edits');
    assert.strictEqual(after.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('4eaf2cc: entity updateConfig cannot forge lifecycle parentage', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory' });
    await runtime.launchAgent({ id: 'victim' });

    assert.throws(
      () => runtime.getAgent('victim').updateConfig({ spawnedBy: 'mallory', creatorId: 'mallory' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'parentage forgery through the entity channel is denied pre-mutation'
    );

    const victim = runtime.getAgent('victim');
    assert.strictEqual(victim.config.spawnedBy, null, 'denied parentage must not land');
    assert.strictEqual(victim.config.creatorId, null, 'denied parentage must not land');

    assert.throws(
      () => runtime.killAgent('victim', 'forged parentage', { callerAgentId: 'mallory' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a peer cannot kill through forged entity parentage'
    );
    assert.ok(runtime.getAgent('victim'), 'the denied kill leaves the victim active');

    const invocation = runtime.invokeAgent('mallory', 'victim', 'P');
    assert.strictEqual(invocation.success, false, 'a forged parent cannot invoke the victim');
    assert.strictEqual(invocation.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('4eaf2cc: benign entity updates keep working, gated manager grants still apply', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });
    const agent = runtime.getAgent('mallory');

    agent.updateConfig({ name: 'Mallory Renamed', modelConfig: { temperature: 0.5 } });
    assert.strictEqual(agent.name, 'Mallory Renamed', 'non-authority metadata still updates');
    assert.strictEqual(agent.config.modelConfig.temperature, 0.5, 'non-authority model config still updates');

    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director')?.authority;
    const granted = runtime.updateAgentConfig('mallory', { privileged: true }, { principal: operator });
    assert.strictEqual(granted.config.privileged, true, 'the gated manager path still applies authority edits');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('mallory').privileged,
      true,
      'the operator grant rebuilds the identity projection'
    );
  } finally {
    runtime.destroy();
  }
});
