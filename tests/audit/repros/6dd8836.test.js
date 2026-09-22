/**
 * @file tests/audit/repros/6dd8836.test.js
 * @description Audit repro for ticket 6dd8836 (Major, area:docs): every
 * `RuntimeScheduler` emission must satisfy the canonical `SubsystemEmitPort`
 * event shape, whose authoritative contract requires a numeric epoch-millisecond
 * `timestamp` supplied by the emitter (`src/lib/sandbox/runtime/index.ts:700-712`,
 * PORTS.md §1; same root as open ticket f950abe in turnExecutionEngine).
 *
 * Evidence: `src/lib/sandbox/runtime/runtimeScheduler/index.ts` #emit call sites for
 * `schedule_registered`, `schedule_triggered`, and `schedule_cancelled` pass
 * `{ type, agentId, timerId, payload }` with no `timestamp`; the injected port
 * and runtime broadcast forward events unchanged.
 *
 * Note: the former `schedule_completed` path was removed with the recurrence
 * surface (ticket ef84eb9 / user ruling #7), so this regression now pins the
 * one-shot events only.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/6dd8836.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeScheduler } from '../../../src/lib/sandbox/runtime/runtimeScheduler/index.ts';

/** MOD-21 W3: reference-validated agent principal for the owner-cancel path. */
const OWNER_AUTHORITY = Object.freeze({
  subject: 'agent-a',
  kind: 'agent',
  allow: new Set(),
  visibility: 'self'
});

function createScheduler(options = {}) {
  return new RuntimeScheduler({
    ...options,
    resolveAgentAuthority: (id) => (id === 'agent-a' ? OWNER_AUTHORITY : null)
  });
}

const assertAllEventsTimestamped = (events) => {
  assert.ok(events.length > 0, 'expected at least one emitted event');
  for (const event of events) {
    assert.strictEqual(
      typeof event.timestamp,
      'number',
      `'${event.type}' must carry the SubsystemEmitPort-required numeric timestamp`
    );
    assert.ok(
      Number.isFinite(event.timestamp),
      `'${event.type}' timestamp must be a finite epoch-millisecond value`
    );
  }
};

test('6dd8836: schedule_registered and schedule_cancelled emissions carry a timestamp', () => {
  const events = [];
  const scheduler = createScheduler({ emit: { emit: (event) => events.push(event) } });

  const receipt = scheduler.schedule({
    agentId: 'agent-a',
    prompt: 'Reminder prompt',
    durationSeconds: 60
  });
  assert.strictEqual(receipt.success, true);

  const cancelled = scheduler.cancelSchedule(receipt.timerId, 'repro cancel', {
    principal: OWNER_AUTHORITY
  });
  assert.strictEqual(cancelled.success, true);

  assertAllEventsTimestamped(events);
  assert.deepStrictEqual(
    events.map((event) => event.type),
    ['schedule_registered', 'schedule_cancelled']
  );

  scheduler.destroy();
});

test('6dd8836: schedule_triggered emission carries a timestamp', async () => {
  const events = [];
  const scheduler = createScheduler({
    emit: { emit: (event) => events.push(event) },
    triggerQueue: { enqueue: () => 'trig_repro' }
  });

  const receipt = scheduler.schedule({
    agentId: 'agent-b',
    prompt: 'One-shot prompt',
    durationSeconds: 0.01
  });
  assert.strictEqual(receipt.success, true);

  await new Promise((resolve) => setTimeout(resolve, 60));

  assertAllEventsTimestamped(events);
  assert.deepStrictEqual(
    events.map((event) => event.type),
    ['schedule_registered', 'schedule_triggered']
  );

  scheduler.destroy();
});
