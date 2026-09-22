/**
 * @file tests/audit/repros/3d09c70.test.js
 * @description Audit repro for ticket 3d09c70 (Major, area:docs):
 * `runHandshakeDemo` cleared its own demo state by calling `reset()` after
 * setting `isDemoRunning = true`, so an observer only ever saw `false` and the
 * first demo log ("1. Initializing Demo") was silently discarded.
 *
 * Evidence: `src/lib/sandbox/sandboxStore/index.svelte.ts:1875-1886` set the flag and
 * emitted step 1, then called `reset()`, which sets `isDemoRunning = false`
 * (`:1822`) and clears `demoLogs` (`:1825`).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/3d09c70.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';

test('3d09c70: runHandshakeDemo keeps isDemoRunning observable and retains the first log', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const pending = store.runHandshakeDemo();

    // Observation point: the demo has yielded at its first await, so an
    // in-flight UI must see the live flag and the step-1 log entry.
    assert.strictEqual(store.isDemoRunning, true, 'isDemoRunning must be true while the demo executes');
    assert.ok(store.demoLogs.length >= 1, 'the first demo log must be visible while the demo executes');
    assert.strictEqual(store.demoLogs[0].step, '1. Initializing Demo', 'the first log must not be discarded');

    const result = await pending;
    assert.strictEqual(result.success, true, 'demo must complete successfully');
    assert.strictEqual(result.logs[0].step, '1. Initializing Demo', 'returned logs must retain step 1');
    assert.ok(result.logs.length >= 7, 'demo must emit every step log');
    assert.strictEqual(store.isDemoRunning, false, 'isDemoRunning must clear once the demo settles');
  } finally {
    store.destroy();
  }
});
