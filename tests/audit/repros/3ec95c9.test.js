/**
 * @file tests/audit/repros/3ec95c9.test.js
 * @description Audit repro for ticket 3ec95c9 (Critical; MOD-21 sub-issue 1):
 * `launchAgent` defaults the creator to privileged when no caller context is
 * supplied, so a context-less caller can mint `privileged: true` agents (and,
 * under the retired reserved-id model, reserved-id agents).
 *
 * Ratified MOD-21 W3 fix: default-deny. An absent caller context is anonymous
 * and `config.privileged: true` requires a principal whose registry
 * `AuthorityDescriptor` allows `@lifecycle:authority` (or `*`). Wave I
 * (ticket c02d0b9) removed the reserved-id namespace: `admin`/`director`/
 * `system` are ordinary ids, so this repro asserts that claiming them never
 * confers privilege or the `realmBypass` grant.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/3ec95c9.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('3ec95c9: anonymous literal-id spawn gains no privilege and no realmBypass', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    for (const id of ['admin', 'director', 'system', 'ADMIN']) {
      const ordinary = await runtime.launchAgent({ id });
      assert.strictEqual(ordinary.config.privileged, false, `anonymous launchAgent({ id: '${id}' }) must not elevate`);
      assert.strictEqual(
        runtime.createAgentIdentityPort().getAgentIdentity(id).realmBypass,
        false,
        `anonymous launchAgent({ id: '${id}' }) must not gain the realmBypass grant`
      );
      runtime.purgeAgent(id, { principal: runtime.getOperatorPrincipal() });
    }
    assert.strictEqual(runtime.getAgentCount(), 0, 'the probe agents are purged after the ordinary-id checks');
  } finally {
    runtime.destroy();
  }
});

test('3ec95c9: anonymous privileged spawn is PERMISSION_DENIED', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await assert.rejects(
      () => runtime.launchAgent({ id: 'probe', privileged: true }),
      (err) => err?.code === 'PERMISSION_DENIED'
    );
    assert.strictEqual(runtime.getAgentCount(), 0, 'denied spawn must not register the agent');
  } finally {
    runtime.destroy();
  }
});

test('3ec95c9: registry authority can spawn privileged agents; literal ids stay ordinary', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    const director = await runtime.ensureDirector();
    const directorAuthority = runtime.createAgentIdentityPort().getAgentIdentity('director')?.authority;
    assert.ok(directorAuthority, 'the bootstrapped director must carry an authority descriptor');

    // Every id is ordinary (Wave I, ticket c02d0b9): registry authority may
    // claim the literal id, but the launch gains no privilege or bypass by
    // itself.
    const ordinarySystem = await runtime.launchAgent({ config: { id: 'system' }, principal: directorAuthority });
    assert.strictEqual(ordinarySystem.config.privileged, false, 'the literal id grants nothing');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('system').realmBypass,
      false,
      'the literal id gains no realmBypass grant'
    );

    const privileged = await runtime.launchAgent({
      config: { id: 'operator-peer', privileged: true },
      principal: directorAuthority
    });
    assert.strictEqual(privileged.config.privileged, true);
    assert.strictEqual(director.config.privileged, true);
  } finally {
    runtime.destroy();
  }
});

test('3ec95c9: an unprivileged registered principal cannot gain privilege through a literal id', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker' });
    const ordinaryAdmin = await runtime.launchAgent({
      config: { id: 'admin' },
      callerContext: { callerAgentId: 'worker' }
    });
    assert.strictEqual(ordinaryAdmin.config.privileged, false, 'the literal id must not elevate the child');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('admin').realmBypass,
      false,
      'the literal id must not grant bypass to the child'
    );
  } finally {
    runtime.destroy();
  }
});
