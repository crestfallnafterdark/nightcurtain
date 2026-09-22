/**
 * @file tests/audit/repros/3b3f241.test.js
 * @description Audit repro for ticket 3b3f241 (Minor, area:docs):
 * `syncFromVirtualFs` claims to report unreadable VirtualFS files as a
 * `CORRUPTED_SNAPSHOT` receipt with `details`, but read failures
 * (readFile/exists throwing) are swallowed and the method returns
 * `{ success: true }`.
 *
 * Evidence (pre-fix): `src/lib/sandbox/worldClock/index.ts:1534` and `:1586` wrap the
 * `/world_clock.json` / `/event_list.json` reads in empty `catch (_) {}` blocks;
 * `:1504-1506` and `:1544-1546` treat a throwing `exists()` as "no file" (silent
 * skip). Contract claim: `src/lib/sandbox/worldClock/index.ts:1735-1738` — an
 * unreadable file is "reported through a `CORRUPTED_SNAPSHOT` receipt instead of
 * being swallowed, with `details` listing each malformed file/entry/clock-field
 * location while the remaining valid payloads are still imported".
 *
 * Deterministic check (ticket):
 *   const vfs = { readFile: () => { throw new Error('EACCES'); } };
 *   const c = new WorldClock({ virtualFs: vfs, autoSyncFs: false });
 *   c.syncFromVirtualFs('agent_x'); // actual { success: true }; docs promise
 *                                   // CORRUPTED_SNAPSHOT + details
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/3b3f241.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WorldClock,
  WORLD_CLOCK_ERROR_CODES
} from '../../../src/lib/sandbox/worldClock/index.ts';

test('3b3f241: throwing readFile is reported as CORRUPTED_SNAPSHOT for both payload paths', () => {
  const vfs = {
    readFile: () => {
      throw new Error('EACCES: permission denied');
    }
  };
  const clock = new WorldClock({ virtualFs: vfs, autoSyncFs: false });

  const receipt = clock.syncFromVirtualFs('agent_x');

  assert.strictEqual(receipt.success, false, 'an unreadable payload must not report success');
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(Array.isArray(receipt.details), 'details must enumerate the unreadable locations');
  assert.ok(
    receipt.details.some((detail) => detail.includes('/world_clock.json@agent_x') && /unreadable/i.test(detail)),
    'the unreadable /world_clock.json must be named in details'
  );
  assert.ok(
    receipt.details.some((detail) => detail.includes('/event_list.json@agent_x') && /unreadable/i.test(detail)),
    'the unreadable /event_list.json must be named in details'
  );
});

test('3b3f241: only the unreadable payload is reported while the valid one still hydrates', () => {
  const vfs = {
    exists: () => true,
    readFile: (pathOrParams) => {
      const filePath = (pathOrParams && typeof pathOrParams === 'object') ? pathOrParams.filePath : pathOrParams;
      if (filePath === '/world_clock.json') {
        return JSON.stringify({ totalSeconds: 900, date: 'Day 1' });
      }
      throw new Error('EIO: device failure');
    }
  };
  const clock = new WorldClock({ virtualFs: vfs, autoSyncFs: false });

  const receipt = clock.syncFromVirtualFs('agent_partial');

  assert.strictEqual(receipt.success, false, 'the unreadable event payload must be surfaced');
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(receipt.details.some((detail) => detail.includes('/event_list.json@agent_partial')));
  assert.strictEqual(
    clock.getTime({}, { callerAgentId: 'agent_partial' }).totalSeconds,
    900,
    'the readable clock payload must still be imported (best-effort sync)'
  );
});

test('3b3f241: a throwing exists() is reported as CORRUPTED_SNAPSHOT, not silently skipped', () => {
  const vfs = {
    exists: () => {
      throw new Error('EIO: stat failure');
    },
    readFile: () => null
  };
  const clock = new WorldClock({ virtualFs: vfs, autoSyncFs: false });

  const receipt = clock.syncFromVirtualFs('agent_statless');

  assert.strictEqual(receipt.success, false, 'an unchecked/unreadable file must not report success');
  assert.strictEqual(receipt.code, WORLD_CLOCK_ERROR_CODES.CORRUPTED_SNAPSHOT);
  assert.ok(
    receipt.details.some((detail) => detail.includes('/world_clock.json@agent_statless') && /unreadable/i.test(detail)),
    'the exists() failure must be named in details'
  );
  assert.ok(
    receipt.details.some((detail) => detail.includes('/event_list.json@agent_statless') && /unreadable/i.test(detail)),
    'the exists() failure must be named in details'
  );
});

test('3b3f241: a genuinely missing file stays resilient (no CORRUPTED_SNAPSHOT)', () => {
  const missing = new Error('File not found');
  missing.name = 'FileNotFoundError';
  const vfs = {
    readFile: () => {
      throw missing;
    }
  };
  const clock = new WorldClock({ virtualFs: vfs, autoSyncFs: false });

  const receipt = clock.syncFromVirtualFs('agent_gone');

  assert.strictEqual(receipt.success, true, 'absent persisted state is not corruption');
  assert.strictEqual(receipt.code, undefined);
  assert.strictEqual(receipt.details, undefined);
});
