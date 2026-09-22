/**
 * @file tests/audit/repros/1644833.test.js
 * @description Audit repro for ticket 1644833 (Minor, area:world-clock):
 * `importSnapshot` accepts a top-level `Infinity` scalar and silently coerces a
 * non-string top-level `date`.
 *
 * Evidence: `src/lib/sandbox/worldClock/index.ts:1754` accepts any `typeof number`
 * that is not `NaN` (`!isNaN`), while per-entry validation uses
 * `Number.isFinite` at `:1719` and the sync path rejects at `:1518`; `:1757`
 * silently substitutes `'Day 1'` for a non-string date. Result: a receipt of
 * `success:true` and a `NaN:NaN:NaN` global clock.
 *
 * Contract pin: `WorldClockSnapshot.totalSeconds` is a required finite
 * `number` and `date` a required `string` in `worldClock.d.ts`, and the d.ts
 * declares `importSnapshot` malformed values reject atomically with
 * `CORRUPTED_SNAPSHOT` and no state mutation. The d.ts explicitly names
 * non-finite `totalSeconds` / non-string `date` on clock entries, not the
 * top-level scalars; where that wording is ambiguous this repro pins the
 * strictest truthful reading (atomic rejection + details naming the scalar).
 *
 * Fixture note (A1): `importSnapshot` is tenant administration (MOD-21 W10-C,
 * default-deny) and returns `PERMISSION_DENIED` for anonymous callers before
 * any validation runs. The corruption probes below therefore construct the
 * clock with an opaque `internalPrincipal` and pass the same reference as
 * `{ principal }`; the anonymous default-deny is asserted separately.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/1644833.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WorldClock,
  WORLD_CLOCK_ERROR_CODES
} from '../../../src/lib/sandbox/worldClock/index.ts';

const PRINCIPAL = Object.freeze({ kind: 'repro-composition-root' });

test('1644833: anonymous importSnapshot is denied before validation', () => {
  const clock = new WorldClock({ initialSeconds: 100, date: 'Day 2', autoSyncFs: false });

  const receipt = clock.importSnapshot({ totalSeconds: Infinity, date: 'Day 3', events: [] });

  assert.strictEqual(receipt.success, false);
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(receipt.details, undefined, 'denial must precede validation, leaking no details');
});

test('1644833: importSnapshot rejects a non-finite top-level totalSeconds', () => {
  const clock = new WorldClock({
    initialSeconds: 100,
    date: 'Day 2',
    autoSyncFs: false,
    internalPrincipal: PRINCIPAL
  });

  const receipt = clock.importSnapshot(
    { totalSeconds: Infinity, date: 'Day 3', events: [] },
    { principal: PRINCIPAL }
  );

  assert.strictEqual(receipt.success, false, 'Infinity is not a finite number and must be rejected');
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);

  const time = clock.getTime();
  assert.strictEqual(time.totalSeconds, 100, 'rejected snapshot must not mutate the clock');
  assert.strictEqual(time.date, 'Day 2', 'rejected snapshot must not mutate the clock date');
  assert.ok(Number.isFinite(time.totalSeconds), 'clock must never expose a NaN/Infinity projection');
});

test('1644833: importSnapshot rejects a non-string top-level date without coercion', () => {
  const clock = new WorldClock({
    initialSeconds: 100,
    date: 'Day 2',
    autoSyncFs: false,
    internalPrincipal: PRINCIPAL
  });

  const receipt = clock.importSnapshot(
    { totalSeconds: 50, date: 12345, events: [] },
    { principal: PRINCIPAL }
  );

  assert.strictEqual(receipt.success, false, 'a non-string date must be rejected/reported, not coerced');
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(
    Array.isArray(receipt.details)
      && receipt.details.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes('date')),
    'the malformed top-level date must be named in the receipt details'
  );

  const time = clock.getTime();
  assert.strictEqual(time.totalSeconds, 100, 'rejected snapshot must not mutate the clock');
  assert.strictEqual(time.date, 'Day 2', 'rejected snapshot must not coerce the date to Day 1');
});
