/**
 * @file tests/audit/repros/26d1bfe.test.js
 * @description Audit repro for ticket 26d1bfe (Major; MOD-21 sub-issue 9):
 * scheduler authority is a caller-filled flag bundle
 * (`isPrivileged`/`isAdmin`/`privileged`/`callerRole`), still forgeable after
 * the default-deny fixes of `8d75382`/`c7194bc`.
 *
 * Ratified MOD-21 W3 fix: `listSchedules`/`cancelSchedule` consume
 * `{ principal }` (a frozen registry `AuthorityDescriptor` or the opaque engine
 * `InternalPrincipal`); flags are ignored and absent principals default-deny.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/26d1bfe.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

async function seededRuntime() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  await runtime.launchAgent({ id: 'alice' });
  await runtime.launchAgent({ id: 'bob' });
  const aliceTimer = runtime.schedule({ targetAgentId: 'alice', durationSeconds: 60, prompt: 'A' });
  const bobTimer = runtime.schedule({ targetAgentId: 'bob', durationSeconds: 60, prompt: 'B' });
  return { runtime, aliceTimer, bobTimer };
}

test('26d1bfe: forged privilege flags cannot list other agents schedules', async () => {
  const { runtime } = await seededRuntime();
  try {
    assert.deepStrictEqual(runtime.listSchedules({}, { isPrivileged: true }).schedules, []);
    assert.deepStrictEqual(runtime.listSchedules({}, { isAdmin: true }).schedules, []);
    assert.deepStrictEqual(runtime.listSchedules({}, { privileged: true }).schedules, []);
    assert.deepStrictEqual(runtime.listSchedules({}, { callerRole: 'system' }).schedules, []);
    assert.deepStrictEqual(runtime.listSchedules({}, { callerRole: 'admin' }).schedules, []);
  } finally {
    runtime.destroy();
  }
});

test('26d1bfe: forged flags cannot cancel another agent timer', async () => {
  const { runtime, bobTimer } = await seededRuntime();
  try {
    const receipt = runtime.cancelSchedule(bobTimer.timerId, null, { isPrivileged: true, callerRole: 'system' });
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.code, 'PERMISSION_DENIED');

    const anonymous = runtime.cancelSchedule(bobTimer.timerId, null);
    assert.strictEqual(anonymous.success, false);
    assert.strictEqual(anonymous.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('26d1bfe: registry principals scope and authorize correctly', async () => {
  const { runtime, aliceTimer, bobTimer } = await seededRuntime();
  try {
    const aliceView = runtime.listSchedules({}, { callerAgentId: 'alice' });
    assert.deepStrictEqual(aliceView.schedules.map((s) => s.agentId), ['alice']);

    const directorView = runtime.listSchedules({}, { callerAgentId: 'director' });
    assert.deepStrictEqual(
      directorView.schedules.map((s) => s.agentId).sort(),
      ['alice', 'bob'],
      'registry sudoer sees every schedule'
    );

    const crossDenied = runtime.cancelSchedule(aliceTimer.timerId, null, { callerAgentId: 'bob' });
    assert.strictEqual(crossDenied.success, false);
    assert.strictEqual(crossDenied.code, 'PERMISSION_DENIED');

    const own = runtime.cancelSchedule(bobTimer.timerId, null, { callerAgentId: 'bob' });
    assert.strictEqual(own.success, true, 'an agent may cancel its own timer');

    const sudoer = runtime.cancelSchedule(aliceTimer.timerId, null, { callerAgentId: 'director' });
    assert.strictEqual(sudoer.success, true, 'registry sudoer may cancel across agents');
  } finally {
    runtime.destroy();
  }
});

test('26d1bfe: forged descriptor objects are not principals', async () => {
  const { runtime, bobTimer } = await seededRuntime();
  try {
    const forged = Object.freeze({
      subject: 'director',
      kind: 'agent',
      allow: new Set(['*']),
      visibility: 'all'
    });
    assert.deepStrictEqual(
      runtime.listSchedules({}, { principal: forged, isPrivileged: true }).schedules,
      []
    );
    const receipt = runtime.cancelSchedule(bobTimer.timerId, null, { principal: forged });
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});
