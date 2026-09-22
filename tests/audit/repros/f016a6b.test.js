/**
 * @file tests/audit/repros/f016a6b.test.js
 * @description Audit repro for ticket f016a6b (Minor, area:lifecycle): an
 * unauthorized caller can "kill" an already-recycled agent and the facade then
 * tears down that agent's timers.
 *
 * Evidence: `src/lib/sandbox/runtime/agentLifecycle/index.ts:621-626` returns the
 * recycle-bin entry before the authorization check at `:637`; the facade then
 * runs `teardownForAgent` (`src/lib/sandbox/runtime/index.ts:687-690`). An
 * unprivileged non-owner caller therefore reports a successful kill.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/f016a6b.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { AGENT_STATES } from '../../../src/lib/sandbox/runtime/agentLifecycle/index.ts';

test('f016a6b: unprivileged kill of an already-recycled agent must be denied', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    // Setup: launch then self-kill, leaving the record in the recycle bin.
    await runtime.launchAgent({ id: 'recycled-victim', role: 'helper' });
    runtime.killAgent('recycled-victim', 'Setup recycle', { callerAgentId: 'recycled-victim' });
    assert.strictEqual(runtime.hasRecycledAgent('recycled-victim'), true, 'setup: agent must be recycled');

    // Unprivileged, non-owner kill of a recycled agent must not report success.
    let denied = false;
    try {
      const result = runtime.killAgent('recycled-victim', 'Terminate', {
        callerAgentId: 'mallory',
        isPrivileged: false
      });
      denied = !result;
    } catch (err) {
      denied = err?.code === 'PERMISSION_DENIED';
    }
    assert.strictEqual(
      denied,
      true,
      'unprivileged non-owner kill of a recycled agent must be denied, never report success'
    );

    const recycled = runtime.getRecycledAgent('recycled-victim');
    assert.ok(recycled, 'denied kill must leave the recycled record in the bin');
    assert.strictEqual(recycled.state, AGENT_STATES.RECYCLED);
  } finally {
    runtime.destroy();
  }
});
