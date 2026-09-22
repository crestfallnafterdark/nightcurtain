/**
 * @file tests/audit/repros/85f1f5f.test.js
 * @description Audit repro for ticket 85f1f5f (Major; MOD-21-A):
 * `updateAgentConfig` lets anonymous callers rewrite `spawnedBy`/`creatorId`,
 * forging parentage that then authorizes `killAgent`/`invokeAgent` under the
 * `7aa4390`/`a9db33c` rules.
 *
 * Ratified MOD-21 W8 fix: parentage fields are authority-bearing. A caller
 * without lifecycle authority receives `PERMISSION_DENIED` before any mutation,
 * so registry parentage cannot be grafted onto a malleable identity.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/85f1f5f.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('85f1f5f: anonymous parentage edits are denied and cannot authorize kill/invoke', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory' });
    await runtime.launchAgent({ id: 'victim' });

    for (const patch of [
      { spawnedBy: 'mallory' },
      { creatorId: 'mallory' },
      { spawnedBy: 'mallory', creatorId: 'mallory' }
    ]) {
      assert.throws(
        () => runtime.updateAgentConfig('victim', patch),
        (err) => err?.code === 'PERMISSION_DENIED',
        `anonymous parentage patch ${JSON.stringify(patch)} must be denied`
      );
    }

    const victim = runtime.getAgent('victim');
    assert.equal(victim.config.spawnedBy, null, 'parentage must be untouched by denied edits');
    assert.equal(victim.config.creatorId, null, 'parentage must be untouched by denied edits');

    assert.throws(
      () => runtime.killAgent('victim', 'forged parentage', { callerAgentId: 'mallory' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a forged parent cannot kill'
    );
    assert.ok(runtime.getAgent('victim'), 'the denied kill leaves the victim active');

    const invocation = runtime.invokeAgent('mallory', 'victim', 'P');
    assert.equal(invocation.success, false, 'a forged parent cannot invoke');
    assert.equal(invocation.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('85f1f5f: lifecycle authority may still repair parentage, trusted parents still work', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;

    await runtime.launchAgent({ id: 'child', spawnedBy: 'director', creatorId: 'director' });
    await runtime.launchAgent({ id: 'orphan' });

    const repaired = runtime.updateAgentConfig('orphan', { spawnedBy: 'director', creatorId: 'director' }, { principal: operator });
    assert.equal(repaired.config.spawnedBy, 'director', 'the operator may repair parentage');
    runtime.killAgent('orphan', 'operator repair', { callerAgentId: 'director' });
    assert.equal(runtime.getAgent('orphan'), null, 'the repaired parentage authorizes the operator kill');

    runtime.killAgent('child', 'trusted parent', { callerAgentId: 'director' });
    assert.equal(runtime.getAgent('child'), null, 'trusted parentage keeps working');
  } finally {
    runtime.destroy();
  }
});
