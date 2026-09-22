/**
 * @file tests/audit/repros/12bab3a.test.js
 * @description Audit repro for tickets 12bab3a (Major, area:docs) and ce97aa5
 * (Minor, area:docs): cancellation is not final in `InvocationEngine`.
 *
 * Evidence: `src/lib/sandbox/invocationEngine/index.ts:294-312` arms a per-invocation
 * timeout whose callback guards only on the microtask-local `isSettled`, while
 * `cancelPendingInvocationsForAgent` (:404-433) settles the record as
 * `cancelled`/`AGENT_TERMINATED` in history without marking that closure
 * settled or clearing the armed timer. A later timeout therefore overwrites
 * the settled `cancelled` history record with `timed_out` and emits a second
 * `onInvocationComplete` event. The same closure's `onChunk` guard (:325-333)
 * consults only `isSettled`, so `#emitChunk` still fires after cancellation,
 * contradicting the `TurnExecutionContext.onChunk` contract
 * ("Calls after the invocation has settled are ignored") and the
 * cancel-finality invariant in `invocationEngine.d.ts`.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/12bab3a.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InvocationEngine,
  INVOCATION_STATUS,
  INVOCATION_ERROR_CODES
} from '../../../src/lib/sandbox/invocationEngine/index.ts';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** MOD-21 W3: registry descriptor granting the invoker sudoer authority. */
const DIRECTOR_AUTHORITY = Object.freeze({
  subject: 'director',
  kind: 'agent',
  allow: new Set(['*']),
  visibility: 'all'
});
const getAgentAuthority = (id) => (id === 'director' ? DIRECTOR_AUTHORITY : null);

test('12bab3a: cancellation remains final when a timeout is armed and only one terminal event fires', async () => {
  let releaseTurn;
  const turnGate = new Promise((resolve) => { releaseTurn = resolve; });

  const engine = new InvocationEngine({
    getAgentAuthority,
    executeTurn: async () => {
      await turnGate;
      return 'late output';
    }
  });

  const terminalEvents = [];
  engine.onInvocationComplete((event) => terminalEvents.push(event));

  const receipt = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Long task',
    timeoutMs: 40
  });
  assert.strictEqual(receipt.success, true);

  await sleep(10);
  const cancelledIds = engine.cancelPendingInvocationsForAgent('worker');
  assert.deepStrictEqual(cancelledIds, [receipt.invocationId]);

  const immediately = engine.getInvocation(receipt.invocationId);
  assert.strictEqual(immediately.status, INVOCATION_STATUS.CANCELLED);
  assert.strictEqual(immediately.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);

  // Let the armed timeout (40ms from dispatch) fire if cancellation left it armed.
  await sleep(60);

  const afterTimeoutWindow = engine.getInvocation(receipt.invocationId);
  assert.strictEqual(
    afterTimeoutWindow.status,
    INVOCATION_STATUS.CANCELLED,
    'a cancelled invocation must never be overwritten to timed_out'
  );
  assert.strictEqual(afterTimeoutWindow.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);
  assert.strictEqual(terminalEvents.length, 1, 'cancellation must yield exactly one terminal event');
  assert.strictEqual(terminalEvents[0].status, INVOCATION_STATUS.CANCELLED);

  releaseTurn();
  await sleep(10);

  const afterTurn = engine.getInvocation(receipt.invocationId);
  assert.strictEqual(afterTurn.status, INVOCATION_STATUS.CANCELLED);
  assert.strictEqual(terminalEvents.length, 1, 'the late turn must not emit a second terminal event');
});

test('ce97aa5: onChunk emits nothing after the invocation is cancelled', async () => {
  let releaseTurn;
  const turnGate = new Promise((resolve) => { releaseTurn = resolve; });

  const engine = new InvocationEngine({
    getAgentAuthority,
    executeTurn: async (targetAgentId, prompt, ctx) => {
      ctx.onChunk('before-cancel');
      await turnGate;
      ctx.onChunk('after-cancel');
      return 'late output';
    }
  });

  const chunks = [];
  engine.onInvocationChunk((event) => chunks.push(event.chunk));
  engine.onInvocationComplete(() => {});
  engine.onInvocationStart(() => {});

  const receipt = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Streaming task'
  });
  assert.strictEqual(receipt.success, true);

  await sleep(10);
  assert.deepStrictEqual(chunks, ['before-cancel']);

  engine.cancelPendingInvocationsForAgent('worker');
  releaseTurn();
  await sleep(10);

  assert.deepStrictEqual(
    chunks,
    ['before-cancel'],
    'the streaming channel must stay silent once the invocation is cancelled'
  );
});
