/**
 * @file tests/audit/repros/ef84eb9.test.js
 * @description Audit repro for ticket ef84eb9 (Major, area:docs; user ruling #7:
 * one-shot scheduled alarm, cron mode removed): the scheduler contract claimed
 * "recurring cron intervals" that the implementation never produced (exactly one
 * `setTimeout`, never re-armed), so the recurrence surface must be removed
 * outright — no cron/recurrence params, fields, or aliases, and a cron-shaped
 * input must behave as a one-shot alarm (rejected without a delay, ignored with
 * one).
 *
 * Contract pin: `scheduleDescriptor` (`src/lib/sandbox/tools/descriptors/index.ts`)
 * and `RuntimeScheduler.schedule()` / `listSchedules()`
 * (`src/lib/sandbox/runtime/runtimeScheduler/index.ts`).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/ef84eb9.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { scheduleDescriptor } from '../../../src/lib/sandbox/tools/descriptors/index.ts';
import {
  RuntimeScheduler,
  SCHEDULER_ERROR_CODES
} from '../../../src/lib/sandbox/runtime/runtimeScheduler/index.ts';

const RECURRENCE_PARAM_KEYS = Object.freeze([
  'cron',
  'cron_expression',
  'cronExpression',
  'max_iterations',
  'maxIterations'
]);

/** MOD-21 W3: reference-validated agent principal for owner-scoped reads. */
const OWNER_AUTHORITY = Object.freeze({
  subject: 'agent-a',
  kind: 'agent',
  allow: new Set(),
  visibility: 'self'
});

function createScheduler() {
  return new RuntimeScheduler({
    resolveAgentAuthority: (id) => (id === 'agent-a' ? OWNER_AUTHORITY : null)
  });
}

const RECURRENCE_FIELD_KEYS = Object.freeze([
  'cron',
  'cronExpr',
  'iterationCount',
  'maxIterations'
]);

test('ef84eb9: schedule tool schema, params, and alias map expose no recurrence surface', () => {
  assert.doesNotMatch(
    scheduleDescriptor.description,
    /cron|recurrence|recurring/i,
    'schedule tool description must not advertise recurrence'
  );

  for (const key of RECURRENCE_PARAM_KEYS) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(scheduleDescriptor.schema.properties, key),
      false,
      `schedule schema must not declare a '${key}' property`
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(scheduleDescriptor.paramAliasMap, key),
      false,
      `schedule alias map must not accept a '${key}' alias`
    );
  }
});

test('ef84eb9: a cron input is rejected without a delay and ignored as one-shot with one', async () => {
  const scheduler = createScheduler();

  const rejected = scheduler.schedule({
    agentId: 'agent-a',
    prompt: 'wake me',
    cron: '*/5 * * * *'
  });
  assert.strictEqual(rejected.success, false, 'a cron-only schedule must be rejected');
  assert.strictEqual(rejected.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);

  const accepted = scheduler.schedule({
    agentId: 'agent-a',
    prompt: 'wake me',
    delaySeconds: 60,
    cron: '*/5 * * * *',
    maxIterations: 10
  });
  assert.strictEqual(accepted.success, true, 'a delayed schedule must succeed');
  assert.strictEqual(accepted.durationSeconds, 60);

  for (const key of RECURRENCE_FIELD_KEYS) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(accepted, key),
      false,
      `schedule receipt must not expose '${key}'`
    );
  }

  const listed = scheduler.listSchedules({ agentId: 'agent-a' }, { principal: OWNER_AUTHORITY }).schedules;
  assert.strictEqual(listed.length, 1);
  for (const key of RECURRENCE_FIELD_KEYS) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(listed[0], key),
      false,
      `schedule projection must not expose '${key}'`
    );
  }

  scheduler.destroy();
});
