/**
 * @file tests/audit/repros/0c6aa62.test.js
 * @description Audit repro for ticket 0c6aa62 (Minor, area:docs):
 * `executeAgentTurn` pre-turn validation throws settle without kicking
 * `triggerQueue.processTick()`, contradicting the documented every-settled-turn
 * kick and the contract's own definition of a terminal outcome (receipt or
 * thrown error).
 *
 * Evidence: validations at `src/lib/sandbox/runtime/turnExecutionEngine/index.ts`
 * `INVALID_ARGUMENTS` / `AGENT_TERMINATED` (recycle bin) / `AGENT_NOT_FOUND` /
 * `AGENT_TERMINATED` (state) run before the `try` whose `finally` owns the kick.
 *
 * Contract pin: `turnExecutionEngine.d.ts` @invariant "Every settled turn kicks
 * the injected `triggerQueue.processTick()` from a `finally` block" and class
 * invariant 8 "Notifies `triggerQueue.processTick()` in the `finally` block of
 * every turn settlement".
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/0c6aa62.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TurnExecutionEngine,
  EXECUTION_STATUS,
  EXECUTION_ERROR_CODES
} from '../../../src/lib/sandbox/runtime/turnExecutionEngine/index.ts';
import { AGENT_STATES } from '../../../src/lib/sandbox/runtime/agentLifecycle/index.ts';

function makeAgent(id = 'kick_agent', state = AGENT_STATES.IDLE) {
  return {
    id,
    name: id,
    state,
    stateDetail: null,
    history: [],
    turnCount: 0,
    currentTurnPromise: null,
    abortController: null,
    lastError: null,
    lastSummary: null,
    lastInterruptedTurn: null,
    pendingPrecalls: [],
    currentStream: '',
    currentReasoning: '',
    activeToolCalls: [],
    redoStack: [],
    config: { allowedTools: [] },
    model: { async *stream() {} },
    rebindModel() {}
  };
}

function createEngine({ agents = new Map(), recycled = new Set(), bus = null } = {}) {
  const kicks = { count: 0 };
  const runtime = {
    getAgent: (id) => agents.get(id) || null,
    hasRecycledAgent: (id) => recycled.has(id),
    setAgentState: (agent, state, detail) => {
      agent.state = state;
      agent.stateDetail = detail;
      agent.updatedAt = Date.now();
    }
  };
  const engine = new TurnExecutionEngine({
    runtime,
    messagingBus: bus,
    triggerQueue: { processTick() { kicks.count++; return Promise.resolve(); } }
  });
  return { engine, kicks };
}

test('0c6aa62: INVALID_ARGUMENTS settlement still kicks processTick', async () => {
  const { engine, kicks } = createEngine();

  await assert.rejects(
    () => engine.executeAgentTurn(''),
    (err) => err.code === EXECUTION_ERROR_CODES.INVALID_ARGUMENTS
  );

  assert.strictEqual(kicks.count, 1, 'a settled INVALID_ARGUMENTS throw must kick processTick exactly once');
});

test('0c6aa62: AGENT_NOT_FOUND settlement still kicks processTick', async () => {
  const { engine, kicks } = createEngine();

  await assert.rejects(
    () => engine.executeAgentTurn('missing_agent'),
    (err) => err.code === EXECUTION_ERROR_CODES.AGENT_NOT_FOUND
  );

  assert.strictEqual(kicks.count, 1, 'a settled AGENT_NOT_FOUND throw must kick processTick exactly once');
});

test('0c6aa62: AGENT_TERMINATED settlements (recycle bin and lifecycle state) still kick processTick', async () => {
  const binAgent = makeAgent('recycled_agent');
  const bin = createEngine({
    agents: new Map([[binAgent.id, binAgent]]),
    recycled: new Set([binAgent.id])
  });
  await assert.rejects(
    () => bin.engine.executeAgentTurn(binAgent.id, 'hi'),
    (err) => err.code === EXECUTION_ERROR_CODES.AGENT_TERMINATED
  );
  assert.strictEqual(bin.kicks.count, 1, 'a recycle-bin rejection must kick processTick exactly once');

  const deadAgent = makeAgent('terminated_agent', AGENT_STATES.TERMINATED);
  const stopped = createEngine({ agents: new Map([[deadAgent.id, deadAgent]]) });
  await assert.rejects(
    () => stopped.engine.executeAgentTurn(deadAgent.id, 'hi'),
    (err) => err.code === EXECUTION_ERROR_CODES.AGENT_TERMINATED
  );
  assert.strictEqual(stopped.kicks.count, 1, 'a terminated-state rejection must kick processTick exactly once');
});

test('0c6aa62: executing, skipped, and cancelled settlements kick processTick exactly once each', async () => {
  const agent = makeAgent('happy_agent');
  const bus = {
    getUnreadCount: () => 0,
    listInbox: () => [],
    drainInbox: () => []
  };
  const { engine, kicks } = createEngine({ agents: new Map([[agent.id, agent]]), bus });

  const completed = await engine.executeAgentTurn(agent.id, 'prompt');
  assert.strictEqual(completed.status, EXECUTION_STATUS.COMPLETED);
  assert.strictEqual(kicks.count, 1, 'completed turn must kick exactly once');

  const skipped = await engine.executeAgentTurn(agent.id, null, { triggerType: 'mail', autoTrigger: true });
  assert.strictEqual(skipped.status, EXECUTION_STATUS.SKIPPED);
  assert.strictEqual(kicks.count, 2, 'skipped turn must kick exactly once (no double kick)');

  const controller = new AbortController();
  controller.abort();
  const cancelled = await engine.executeAgentTurn(agent.id, 'prompt', { signal: controller.signal });
  assert.strictEqual(cancelled.status, EXECUTION_STATUS.CANCELLED);
  assert.strictEqual(kicks.count, 3, 'cancelled turn must kick exactly once (no double kick)');
});
