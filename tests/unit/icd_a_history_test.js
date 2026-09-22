/**
 * @file tests/unit/icd_a_history_test.js
 * @description Focused ICD-A regression suite for `runtime/historyManager` and the
 * `undo_turn` descriptor contract.
 *
 * Covers:
 *   dcd309a — options-form `HistoryManager` emit resolution (option port, runtime
 *             `createSubsystemEmitPort()` fallback, and the documented no-op).
 *   adb58c0 — `undo_turn` / `undoAgentTurn(agentId, targetTurnId)` selection is no
 *             longer inert: earlier turns are honored, unknown / already-undone /
 *             non-string targets fail structurally without side effects.
 *
 * Pre-fix expectations (verified against the pre-change module):
 *   - Test 2 fails: options form did not fall back to the runtime emit factory.
 *   - Tests 4, 6, 9 fail: `targetTurnId` was ignored for selection and only
 *     labeled the bundle, so an explicit target silently undid the most recent
 *     turn instead.
 *   - Tests 7, 8 fail: unknown / already-undone targets silently undid the most
 *     recent turn instead of returning a structured failure.
 *   - Test 10 fails: any truthy raw target (including whitespace) became the
 *     bundle label, so no `turn_` id was generated for a blank selector.
 *   - Test 11's failure-receipt assertions fail: the descriptor passed the raw
 *     port result through without an error message / canonical code.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { HistoryManager } from '../../src/lib/sandbox/runtime/historyManager/index.ts';
import { undoTurnDescriptor } from '../../src/lib/sandbox/tools/descriptors/index.ts';

/**
 * Builds a plain agent-like target with three completed turns.
 * @returns {Object}
 */
function makeThreeTurnAgent() {
  return {
    id: 'agent-1',
    state: 'idle',
    turnCount: 3,
    lastError: null,
    lastInterruptedTurn: null,
    updatedAt: 0,
    redoStack: [],
    history: [
      { id: 'sys_0', role: 'system', content: 'System' },
      { id: 'u1', role: 'user', content: 'Prompt 1' },
      { id: 'a1', role: 'assistant', content: 'Answer 1' },
      { id: 'u2', role: 'user', content: 'Prompt 2' },
      { id: 'a2', role: 'assistant', content: 'Answer 2' },
      { id: 'u3', role: 'user', content: 'Prompt 3' },
      { id: 'a3', role: 'assistant', content: 'Answer 3' }
    ]
  };
}

/**
 * @param {Object} agent
 * @param {Object} [extras]
 * @returns {Object}
 */
function makeRuntime(agent, extras = {}) {
  return {
    getAgent: (id) => (id === agent.id ? agent : null),
    ...extras
  };
}

const ids = (agent) => agent.history.map((m) => m.id).join(',');

// ============================================================================
// 1. Options-form emit: port honored
// ============================================================================

test('1. options-provided emit port receives message and turn events', () => {
  const events = [];
  const agent = makeThreeTurnAgent();
  const manager = new HistoryManager({
    runtime: makeRuntime(agent),
    emit: { emit: (event) => events.push(event) }
  });

  manager.updateHistoryMessage(agent.id, 'u1', { content: 'Prompt 1 edited' });
  manager.deleteHistoryMessage(agent.id, 'a3');
  manager.undoAgentTurn(agent.id);
  manager.redoAgentTurn(agent.id);

  const types = new Set(events.map((e) => e.type));
  assert.ok(types.has('message_updated'), 'message_updated emitted');
  assert.ok(types.has('message_deleted'), 'message_deleted emitted');
  assert.ok(types.has('turn_undone'), 'turn_undone emitted');
  assert.ok(types.has('turn_redone'), 'turn_redone emitted');
});

// ============================================================================
// 2. Options-form emit: runtime factory fallback (dcd309a)
// ============================================================================

test('2. options form without emit falls back to runtime.createSubsystemEmitPort()', () => {
  const fallbackEvents = [];
  const agent = makeThreeTurnAgent();
  const runtime = makeRuntime(agent, {
    createSubsystemEmitPort: () => ({ emit: (event) => fallbackEvents.push(event) })
  });

  const manager = new HistoryManager({ runtime });
  manager.undoAgentTurn(agent.id);
  assert.ok(
    fallbackEvents.some((e) => e.type === 'turn_undone'),
    'runtime emit factory must receive history events when options carry no emit port'
  );

  // An explicit options emit port still takes precedence over the runtime factory.
  const optionEvents = [];
  const agent2 = makeThreeTurnAgent();
  const factoryEvents = [];
  const runtime2 = makeRuntime(agent2, {
    createSubsystemEmitPort: () => ({ emit: (event) => factoryEvents.push(event) })
  });
  const manager2 = new HistoryManager({
    runtime: runtime2,
    emit: { emit: (event) => optionEvents.push(event) }
  });
  manager2.undoAgentTurn(agent2.id);
  assert.ok(optionEvents.some((e) => e.type === 'turn_undone'));
  assert.strictEqual(factoryEvents.length, 0, 'runtime factory must not be consulted when emit is usable');
});

// ============================================================================
// 3. No emitter anywhere: documented no-op, no console noise
// ============================================================================

test('3. no emitter anywhere is a documented no-op without console noise', () => {
  const errors = [];
  const warnings = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args) => errors.push(args);
  console.warn = (...args) => warnings.push(args);

  try {
    const agent = makeThreeTurnAgent();
    const manager = new HistoryManager({ runtime: makeRuntime(agent) });
    const result = manager.undoAgentTurn(agent.id);
    assert.strictEqual(result.undoneUserContent, 'Prompt 3');
    assert.strictEqual(result.success, undefined, 'untargeted undo keeps the plain result shape');

    const bare = new HistoryManager();
    assert.strictEqual(bare.isAgentInterrupted('agent-1'), false);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.strictEqual(errors.length, 0, 'no console.error from the documented no-op');
  assert.strictEqual(warnings.length, 0, 'no console.warn from the documented no-op');
});

// ============================================================================
// 4. target_turn_id: earlier turn honored + redo restores position (adb58c0)
// ============================================================================

test('4. target_turn_id selects an earlier turn and redo restores its position', () => {
  const agent = makeThreeTurnAgent();
  const manager = new HistoryManager({ runtime: makeRuntime(agent) });

  const result = manager.undoAgentTurn(agent.id, 'u2');
  assert.strictEqual(result.undoneUserContent, 'Prompt 2');
  assert.strictEqual(result.undoneAssistantContent, 'Answer 2');
  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.restoredPrompt, 'Prompt 2');
  assert.strictEqual(ids(agent), 'sys_0,u1,a1,u3,a3', 'only the targeted turn is popped');
  assert.strictEqual(agent.turnCount, 2);

  assert.strictEqual(agent.redoStack.length, 1);
  assert.strictEqual(agent.redoStack[0].turnId, 'u2');
  assert.strictEqual(agent.redoStack[0].insertionIndex, 3);
  assert.strictEqual(agent.redoStack[0].turnCountDelta, 1);
  assert.deepStrictEqual(
    agent.redoStack[0].allPoppedMessages.map((m) => m.id),
    ['u2', 'a2']
  );

  const redo = manager.redoAgentTurn(agent.id);
  assert.strictEqual(redo.success, true);
  assert.strictEqual(ids(agent), 'sys_0,u1,a1,u2,a2,u3,a3', 'redo restores the original order');
  assert.strictEqual(agent.turnCount, 3);
});

// ============================================================================
// 5. target_turn_id: most recent turn matches the default undo
// ============================================================================

test('5. target_turn_id naming the most recent turn matches the default undo', () => {
  const agent = makeThreeTurnAgent();
  const manager = new HistoryManager({ runtime: makeRuntime(agent) });

  const result = manager.undoAgentTurn(agent.id, 'u3');
  assert.strictEqual(result.undoneUserContent, 'Prompt 3');
  assert.strictEqual(result.undoneAssistantContent, 'Answer 3');
  assert.strictEqual(ids(agent), 'sys_0,u1,a1,u2,a2');
  assert.strictEqual(agent.redoStack[0].turnId, 'u3');
  assert.strictEqual(agent.redoStack[0].insertionIndex, undefined, 'conventional tail bundles append');
});

// ============================================================================
// 6. metadata.turnId acts as a selector
// ============================================================================

test('6. metadata.turnId is accepted as a turn selector', () => {
  const agent = makeThreeTurnAgent();
  agent.history[1].metadata = { turnId: 'turn_alpha' };
  const manager = new HistoryManager({ runtime: makeRuntime(agent) });

  const result = manager.undoAgentTurn(agent.id, 'turn_alpha');
  assert.strictEqual(result.undoneUserContent, 'Prompt 1');
  assert.strictEqual(ids(agent), 'sys_0,u2,a2,u3,a3');
  assert.strictEqual(agent.redoStack[0].turnId, 'turn_alpha');
});

// ============================================================================
// 7. Unknown target: structured failure, zero side effects
// ============================================================================

test('7. unknown target returns structured TURN_NOT_FOUND without side effects', () => {
  const agent = makeThreeTurnAgent();
  agent.state = 'running';
  let cancelCalls = 0;
  const manager = new HistoryManager({
    runtime: makeRuntime(agent, { cancelAgent: () => { cancelCalls++; } })
  });

  const before = ids(agent);
  const result = manager.undoAgentTurn(agent.id, 'turn_does_not_exist');

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'TURN_NOT_FOUND');
  assert.strictEqual(result.targetTurnId, 'turn_does_not_exist');
  assert.strictEqual(ids(agent), before, 'history untouched');
  assert.strictEqual(agent.redoStack.length, 0, 'nothing pushed onto the redo stack');
  assert.strictEqual(agent.turnCount, 3, 'turn count untouched');
  assert.strictEqual(agent.state, 'running', 'in-flight state untouched');
  assert.strictEqual(cancelCalls, 0, 'no cancellation for a failed selection');
});

// ============================================================================
// 8. Already-undone target: structured failure, zero side effects
// ============================================================================

test('8. already-undone target returns structured TURN_ALREADY_UNDONE', () => {
  const agent = makeThreeTurnAgent();
  const manager = new HistoryManager({ runtime: makeRuntime(agent) });

  manager.undoAgentTurn(agent.id, 'u3');
  const afterFirstUndo = ids(agent);

  const byBundleId = manager.undoAgentTurn(agent.id, 'u3');
  assert.strictEqual(byBundleId.success, false);
  assert.strictEqual(byBundleId.reason, 'TURN_ALREADY_UNDONE');
  assert.strictEqual(byBundleId.targetTurnId, 'u3');
  assert.strictEqual(ids(agent), afterFirstUndo, 'history untouched by the failed retry');
  assert.strictEqual(agent.redoStack.length, 1, 'redo stack untouched by the failed retry');

  const byMessageId = manager.undoAgentTurn(agent.id, 'a3');
  assert.strictEqual(byMessageId.success, false);
  assert.strictEqual(byMessageId.reason, 'TURN_ALREADY_UNDONE', 'contained message ids resolve to the undone bundle');
  assert.strictEqual(ids(agent), afterFirstUndo);
});

// ============================================================================
// 9. Non-string target: structured failure, not a bundle label
// ============================================================================

test('9. non-string target fails structured instead of labeling the bundle', () => {
  const agent = makeThreeTurnAgent();
  const manager = new HistoryManager({ runtime: makeRuntime(agent) });

  const before = ids(agent);
  const result = manager.undoAgentTurn(agent.id, 42);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'TURN_NOT_FOUND');
  assert.strictEqual(result.targetTurnId, '42');
  assert.strictEqual(ids(agent), before);
  assert.strictEqual(agent.redoStack.length, 0);
});

// ============================================================================
// 10. Blank target behaves as "no target"
// ============================================================================

test('10. blank target selects the most recent turn like no target', () => {
  const agent = makeThreeTurnAgent();
  const manager = new HistoryManager({ runtime: makeRuntime(agent) });

  const result = manager.undoAgentTurn(agent.id, '   ');
  assert.strictEqual(result.undoneUserContent, 'Prompt 3');
  assert.strictEqual(agent.redoStack.length, 1);
  assert.ok(agent.redoStack[0].turnId.startsWith('turn_'), 'generated turn id for blank selectors');
});

// ============================================================================
// 11. undo_turn descriptor: parameter passthrough and truthful failure surface
// ============================================================================

test('11. undo_turn descriptor forwards target_turn_id and surfaces structured failures', async () => {
  const calls = [];
  const failingPort = {
    undoAgentTurn: async (agentId, targetTurnId) => {
      calls.push([agentId, targetTurnId]);
      return { success: false, reason: 'TURN_ALREADY_UNDONE', targetTurnId };
    }
  };

  const receipt = await undoTurnDescriptor.handler(
    { target_turn_id: 'turn_42' },
    { lifecyclePort: failingPort, callerAgentId: 'agent-1' }
  );
  assert.deepStrictEqual(calls, [['agent-1', 'turn_42']]);
  assert.strictEqual(receipt.success, false);
  assert.strictEqual(receipt.reason, 'TURN_ALREADY_UNDONE');
  assert.strictEqual(receipt.code, 'EXECUTION_FAILED');
  assert.strictEqual(receipt.targetTurnId, 'turn_42');
  assert.match(receipt.error, /already been undone/);

  const notFoundPort = {
    undoAgentTurn: async (agentId, targetTurnId) => ({
      success: false,
      reason: 'TURN_NOT_FOUND',
      targetTurnId
    })
  };
  const notFound = await undoTurnDescriptor.handler(
    { target_turn_id: 'turn_missing' },
    { lifecyclePort: notFoundPort, callerAgentId: 'agent-1' }
  );
  assert.strictEqual(notFound.success, false);
  assert.strictEqual(notFound.reason, 'TURN_NOT_FOUND');
  assert.match(notFound.error, /No active turn matches/);

  // Successful undo receipts pass through unchanged.
  const successPort = {
    undoAgentTurn: async () => ({
      undoneUserContent: 'Prompt',
      undoneAssistantContent: 'Answer',
      count: 2,
      restoredPrompt: 'Prompt'
    })
  };
  const success = await undoTurnDescriptor.handler({}, { lifecyclePort: successPort, callerAgentId: 'agent-1' });
  assert.strictEqual(success.undoneUserContent, 'Prompt');
  assert.strictEqual(success.restoredPrompt, 'Prompt');

  // Alias sanitization still canonicalizes camelCase selectors.
  assert.deepStrictEqual(undoTurnDescriptor.sanitize({ turnId: 'turn_9' }), { target_turn_id: 'turn_9' });
  assert.match(
    String(undoTurnDescriptor.schema.properties.target_turn_id.description),
    /Unknown or already-undone/
  );
});
