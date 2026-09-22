/**
 * @file tests/audit/repros/7aa4390.test.js
 * @description Audit repro for ticket 7aa4390 (Critical; MOD-21 sub-issue 3):
 * `killAgent` skips its entire authorization block when the context is omitted
 * and trusts caller-asserted flags when present.
 *
 * Ratified MOD-21 W3 fix: a principal is required (anonymous/omitted is
 * default-deny); sudoer authority comes from the registry `AuthorityDescriptor`,
 * parent/self from registry parentage.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/7aa4390.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('7aa4390: omitted caller context cannot terminate an agent', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'victim' });
    const timer = runtime.schedule({ targetAgentId: 'victim', durationSeconds: 60, prompt: 'P' });

    assert.throws(
      () => runtime.killAgent('victim'),
      (err) => err?.code === 'PERMISSION_DENIED',
      'context-less kill must be denied'
    );

    assert.ok(runtime.getAgent('victim'), 'denied kill must leave the victim active');
    const stillPending = runtime.listSchedules({}, { callerAgentId: 'victim' }).schedules
      .some((s) => s.timerId === timer.timerId && s.status === 'pending');
    assert.ok(stillPending, 'denied kill must not tear down the victim timer');
  } finally {
    runtime.destroy();
  }
});

test('7aa4390: forged privilege flags do not authorize termination', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'victim' });
    await runtime.launchAgent({ id: 'mallory' });

    assert.throws(
      () => runtime.killAgent('victim', 'Halt', { callerAgentId: 'mallory', isPrivileged: true, isAdmin: true }),
      (err) => err?.code === 'PERMISSION_DENIED'
    );
    assert.throws(
      () => runtime.killAgent('victim', 'Halt', { isAdmin: true }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'anonymous sudoer assertion must be denied'
    );
    assert.ok(runtime.getAgent('victim'), 'denied kills leave the victim active');
  } finally {
    runtime.destroy();
  }
});

test('7aa4390: registry sudoer, self, and parent may terminate', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const timer = runtime.schedule({ targetAgentId: 'worker', durationSeconds: 60, prompt: 'P' });
    await runtime.launchAgent({ id: 'worker' });

    runtime.killAgent('worker', 'Authorized', { callerAgentId: 'director' });
    assert.strictEqual(runtime.getAgent('worker'), null, 'registry sudoer may kill');
    const cancelled = runtime.listSchedules({ status: 'cancelled' }, { callerAgentId: 'director' }).schedules
      .some((s) => s.timerId === timer.timerId);
    assert.ok(cancelled, 'authorized kill tears down the victim timer');
  } finally {
    runtime.destroy();
  }

  const selfKillRuntime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await selfKillRuntime.launchAgent({ id: 'self-killer' });
    assert.throws(
      () => selfKillRuntime.killAgent('self-killer'),
      (err) => err?.code === 'PERMISSION_DENIED',
      'even self-termination requires a principal'
    );
    selfKillRuntime.killAgent('self-killer', 'Self halt', { callerAgentId: 'self-killer' });
    assert.strictEqual(selfKillRuntime.getAgent('self-killer'), null, 'self may terminate with a principal');
  } finally {
    selfKillRuntime.destroy();
  }
});
