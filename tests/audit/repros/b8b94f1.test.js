/**
 * @file tests/audit/repros/b8b94f1.test.js
 * @description Audit repro for ticket b8b94f1 (Minor, area:lifecycle): a denied
 * relaunch of a recycled id deletes the recycle-bin record before the
 * authorization gate runs, so the recycled agent can no longer be restored.
 *
 * Evidence: `src/lib/sandbox/runtime/agentLifecycle/index.ts:280`
 * (`this.#recycleBin.delete(agentId)`) executed before the (then
 * reserved-identity) privilege gate at `:306-320`. After a denied unprivileged
 * relaunch the recycle-bin record was destroyed and `restoreAgent(id)` threw
 * `AGENT_NOT_FOUND`. Wave I (ticket c02d0b9) removed the reserved-id namespace,
 * so the denied relaunch is now a privilege-grant attempt on the same
 * recycled id; the side-effect-freedom assertion is unchanged.
 *
 * Fixture note (P2): restore is principal-mandatory (MOD-21 W8, default-deny),
 * so the original anonymous `restoreAgent('admin')` now throws
 * `PERMISSION_DENIED` regardless of the record's survival. The fixture pins
 * that anonymous denial explicitly, then restores under the already-injected
 * `internalPrincipal` so the side-effect-freedom assertion is exercised.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/b8b94f1.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AgentLifecycleManager,
  AGENT_STATES
} from '../../../src/lib/sandbox/runtime/agentLifecycle/index.ts';

/** MOD-21: opaque-in-spirit engine principal injected at trusted construction. */
const TEST_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'test-operator' });

test('b8b94f1: denied relaunch of a reserved id must not consume its recycled record', async () => {
  const lifecycle = new AgentLifecycleManager({ emit: { emit: () => {} }, internalPrincipal: TEST_PRINCIPAL });

  // Setup: launch the id under the injected engine principal ...
  const admin = await lifecycle.launchAgent({
    config: { id: 'admin', name: 'Admin' },
    principal: TEST_PRINCIPAL
  });
  assert.strictEqual(admin.id, 'admin', 'setup: the literal-id launch must succeed');

  // ... then soft-kill it so its record lives in the recycle bin.
  lifecycle.killAgent('admin', 'Recycled for repro', { principal: TEST_PRINCIPAL });
  assert.strictEqual(lifecycle.isAgentTerminated('admin'), true, 'setup: admin must be recycled');

  // Unprivileged caller attempts a privileged relaunch of the recycled id:
  // this must be denied (the literal id itself is ordinary).
  await assert.rejects(
    () => lifecycle.launchAgent({
      config: { id: 'admin', privileged: true },
      callerContext: { callerAgentId: 'mallory', isPrivileged: false }
    }),
    (err) => err.code === 'PERMISSION_DENIED',
    'unprivileged caller must not relaunch the recycled id with a privilege grant'
  );

  // Anonymous restore is itself default-denied (MOD-21 W8) and must not
  // consume the record either.
  assert.throws(
    () => lifecycle.restoreAgent('admin'),
    (err) => err?.code === 'PERMISSION_DENIED',
    'anonymous restore of the recycled record must default-deny'
  );
  assert.strictEqual(lifecycle.isAgentTerminated('admin'), true, 'the denied anonymous restore must leave the record recycled');

  // The denial must be side-effect free: the recycled record survives and is
  // restorable under the injected engine principal.
  const restored = lifecycle.restoreAgent('admin', { principal: TEST_PRINCIPAL });
  assert.strictEqual(restored.id, 'admin');
  assert.strictEqual(restored.state, AGENT_STATES.IDLE);
});
