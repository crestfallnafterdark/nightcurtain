/**
 * @file tests/audit/repros/d83b359.test.js
 * @description Audit repro for ticket d83b359 (Critical; MOD-21 sub-issue 4):
 * `updateAgentConfig` writes `privileged` into the live config (and the bus
 * policy) with no authorization.
 *
 * Ratified MOD-21 W3 fix: authority-bearing fields require a principal whose
 * descriptor allows `@lifecycle:authority`; anonymous and unprivileged callers
 * receive PERMISSION_DENIED before any mutation.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/d83b359.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('d83b359: anonymous privileged grant is denied without mutation', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker', allowedTools: ['read_file'] });

    assert.throws(
      () => runtime.updateAgentConfig('worker', { privileged: true, allowedTools: ['*'] }),
      (err) => err?.code === 'PERMISSION_DENIED'
    );

    const worker = runtime.getAgent('worker');
    assert.strictEqual(worker.config.privileged, false, 'config privilege must be unchanged');
    assert.deepStrictEqual(worker.config.allowedTools, ['read_file'], 'tools must be unchanged');
  } finally {
    runtime.destroy();
  }
});

test('d83b359: forged privilege flags cannot grant privileged', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker' });
    await runtime.launchAgent({ id: 'mallory' });

    assert.throws(
      () => runtime.updateAgentConfig(
        'worker',
        { privileged: true },
        { callerAgentId: 'mallory', isPrivileged: true, isAdmin: true }
      ),
      (err) => err?.code === 'PERMISSION_DENIED'
    );
    assert.strictEqual(runtime.getAgent('worker').config.privileged, false);
  } finally {
    runtime.destroy();
  }
});

test('d83b359: registry lifecycle authority may grant and revoke privilege', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'worker' });

    runtime.updateAgentConfig('worker', { privileged: true, allowedTools: ['*'] }, { callerAgentId: 'director' });
    assert.strictEqual(runtime.getAgent('worker').config.privileged, true, 'operator grant applies');

    runtime.updateAgentConfig('worker', { privileged: false, allowedTools: ['read_file'] }, { callerAgentId: 'director' });
    assert.strictEqual(runtime.getAgent('worker').config.privileged, false, 'operator revoke applies');
    assert.deepStrictEqual(runtime.getAgent('worker').config.allowedTools, ['read_file']);
  } finally {
    runtime.destroy();
  }
});

test('d83b359: non-authority fields still update anonymously', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker' });
    runtime.updateAgentConfig('worker', { name: 'Renamed Worker' });
    assert.strictEqual(runtime.getAgent('worker').config.name, 'Renamed Worker');
  } finally {
    runtime.destroy();
  }
});
