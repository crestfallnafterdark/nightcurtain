/**
 * @file tests/audit/repros/243b4c8.test.js
 * @description Audit repro for ticket 243b4c8 (Minor, area:docs):
 * `schedule()` throws a synchronous `TypeError` for a circular/BigInt prompt
 * (`runtimeScheduler.js:222`) and `listSchedules()` throws for a snapshot-imported
 * non-string `status` (`:324`), while the contract states `schedule()` reports
 * validation failures as coded receipts and `listSchedules()` never throws.
 *
 * Evidence: `src/lib/sandbox/runtime/runtimeScheduler/index.ts:222`
 * (`JSON.stringify` outside any guard), `:324` (`task.status.toLowerCase()`)
 * fed by `importSchedules` copying `item.status` unvalidated (`:603`), and
 * `:618` (`JSON.stringify` of an imported prompt outside any guard).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/243b4c8.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RuntimeScheduler,
  SCHEDULER_ERROR_CODES
} from '../../../src/lib/sandbox/runtime/runtimeScheduler/index.ts';

function makeCircular() {
  const circular = {};
  circular.self = circular;
  return circular;
}

test('243b4c8: circular prompt yields an INVALID_ARGUMENTS receipt, never a TypeError', () => {
  const scheduler = new RuntimeScheduler();
  try {
    const receipt = scheduler.schedule({ agentId: 'a', prompt: makeCircular(), durationSeconds: 1 });
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);
  } finally {
    scheduler.destroy();
  }
});

test('243b4c8: BigInt prompt yields an INVALID_ARGUMENTS receipt, never a TypeError', () => {
  const scheduler = new RuntimeScheduler();
  try {
    const receipt = scheduler.schedule({ agentId: 'a', prompt: 1n, durationSeconds: 1 });
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.code, SCHEDULER_ERROR_CODES.INVALID_ARGUMENTS);
  } finally {
    scheduler.destroy();
  }
});

test('243b4c8: a non-string imported status never makes listSchedules throw', () => {
  const scheduler = new RuntimeScheduler();
  try {
    scheduler.importSchedules([{ timerId: 't1', agentId: 'a', status: 123, prompt: 'x' }]);
    const result = scheduler.listSchedules({ status: 'pending' }, { isPrivileged: true });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.schedules, [], 'malformed status records must be skipped');
  } finally {
    scheduler.destroy();
  }
});

test('243b4c8: importSchedules skips a record whose prompt cannot be serialized', () => {
  const scheduler = new RuntimeScheduler();
  try {
    scheduler.importSchedules([
      { timerId: 't1', agentId: 'a', status: 'pending', prompt: makeCircular() }
    ]);
    const result = scheduler.listSchedules({ status: 'pending' }, { isPrivileged: true });
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.schedules, [], 'non-serializable prompt records must be skipped');
  } finally {
    scheduler.destroy();
  }
});
