/**
 * @file tests/audit/repros/26a65c5.test.js
 * @description Audit repro for ticket 26a65c5 (Major, area:security, MOD-21):
 * `AgentRuntime.ensureDirector`'s snapshot-provenance rebuild branch installs a
 * director body constructed without the lifecycle manager's authority channel
 * (`new Agent({ ...DIRECTOR_SPEC }, null, null, this.#credentialResolver)`).
 * The body is exposed through `runtime.getAgent('director')` with
 * `#authorityChannel === null`, so any in-process caller can claim the channel
 * with `agent.bindAuthorityChannel(attackerToken)`, write owner-controlled
 * authority state on it (`spawnedBy`, `allowedTools`, `privileged`), forge
 * parentage, and permanently lock the manager's channel out. The public,
 * writable `authorityProvenance` field is what drives the rebuild branch.
 *
 * Expected: the provenance field is owner-controlled (non-writable/non-
 * configurable) so a public caller cannot drive authority-bearing branches, and
 * a rebuilt director body is bound to the manager channel before exposure
 * (first bind wins).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/26a65c5.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('26a65c5: authorityProvenance is owner-controlled and the rebuilt director is channel-bound', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const director = runtime.getAgent('director');
    assert.ok(director, 'the director must exist');

    const descriptor = Object.getOwnPropertyDescriptor(director, 'authorityProvenance');
    const publiclyWritable = !descriptor || descriptor.writable === true || typeof descriptor.set === 'function';

    let injected = false;
    if (publiclyWritable) {
      try {
        director.authorityProvenance = 'snapshot';
        injected = director.authorityProvenance === 'snapshot';
      } catch (_) {
        injected = false;
      }
    }

    if (injected) {
      // At HEAD the public write drives the rebuild branch, which installs an
      // unbound body. Post-fix the write is refused and this branch is dead;
      // the assertions document the defense-in-depth bind.
      const rebuilt = await runtime.ensureDirector();
      assert.notStrictEqual(rebuilt, director, 'the snapshot-provenance rebuild branch replaces the director body');

      const token = {};
      assert.strictEqual(
        rebuilt.bindAuthorityChannel(token),
        false,
        'the rebuilt director must already own the manager authority channel'
      );
      assert.throws(
        () => rebuilt.applyAuthorityConfig({ spawnedBy: 'mallory' }, token),
        (err) => err?.code === 'PERMISSION_DENIED',
        'a public caller cannot claim the manager authority channel'
      );
      assert.throws(
        () => runtime.killAgent('director', 'claimed parentage', { callerAgentId: 'mallory' }),
        (err) => err?.code === 'PERMISSION_DENIED',
        'a peer cannot kill the director through a claimed channel'
      );
    }

    assert.strictEqual(injected, false, 'authorityProvenance must not be publicly writable');
    assert.strictEqual(publiclyWritable, false, 'authorityProvenance must be an owner-controlled accessor');
  } finally {
    runtime.destroy();
  }
});

test('26a65c5: the launched director refuses a later channel claim and the operator path still works', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'mallory' });

    const director = runtime.getAgent('director');
    assert.strictEqual(
      director.bindAuthorityChannel({ forged: true }),
      false,
      'the launched director is already bound to the manager channel (first bind wins)'
    );

    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
    runtime.updateAgentConfig(
      'director',
      { name: 'Director Prime', allowedTools: ['*'] },
      { principal: operator }
    );
    assert.strictEqual(runtime.getAgent('director').config.name, 'Director Prime', 'the operator rename applies');
    assert.strictEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('director').authority.allow.has('*'),
      true,
      'operator authority grants still reach the director'
    );

    assert.throws(
      () => runtime.killAgent('director', 'claimed parentage', { callerAgentId: 'mallory' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a peer cannot kill the director through a claimed channel'
    );
    assert.ok(runtime.getAgent('director'), 'the denied kill leaves the director active');
  } finally {
    runtime.destroy();
  }
});
