/**
 * @file tests/audit/repros/31a81f1.test.js
 * @description Audit repro for ticket 31a81f1 (Minor, area:docs):
 * `TurnExecutionOptions.metadata` is silently dropped for role-carrying
 * directive inputs, although the contract documents input metadata as
 * overriding same-named option metadata.
 *
 * Evidence: `src/lib/sandbox/runtime/turnExecutionEngine/index.ts` role branches push
 * `{ ...item }` / `{ ...input }` only; the documented merge exists only on the
 * no-role content path and in system/injection modes.
 *
 * Contract pin: `turnExecutionEngine.d.ts` `TurnInputObject.metadata` -
 * "Metadata stored on the ingested history message; keys here override
 * same-named keys from `TurnExecutionOptions.metadata`."
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/31a81f1.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutionEngine } from '../../../src/lib/sandbox/runtime/turnExecutionEngine/index.ts';

function makeAgent(id) {
  return {
    id,
    name: id,
    state: 'idle',
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

function userHistory(agent) {
  return agent.history.find((m) => m.role === 'user');
}

test('31a81f1: role-bearing input metadata merges option metadata with input keys overriding', async () => {
  const agent = makeAgent('metadata_object_agent');
  await new TurnExecutionEngine({}).executeAgentTurn(
    agent,
    { role: 'user', content: 'x', metadata: { tag: 'from-input', inputOnly: true } },
    { metadata: { tag: 'from-options', optionOnly: true } }
  );

  const msg = userHistory(agent);
  assert.ok(msg, 'the role-bearing user message must be stored in history');
  assert.deepStrictEqual(
    msg.metadata,
    { tag: 'from-input', inputOnly: true, optionOnly: true },
    'input metadata keys must override same-named option metadata keys, with option-only keys preserved'
  );
});

test('31a81f1: role-bearing input without metadata still carries option metadata', async () => {
  const agent = makeAgent('metadata_options_only_agent');
  await new TurnExecutionEngine({}).executeAgentTurn(
    agent,
    { role: 'user', content: 'x' },
    { metadata: { tag: 'from-options' } }
  );

  const msg = userHistory(agent);
  assert.ok(msg);
  assert.deepStrictEqual(msg.metadata, { tag: 'from-options' });
});

test('31a81f1: array-form role-bearing inputs carry merged option metadata', async () => {
  const agent = makeAgent('metadata_array_agent');
  await new TurnExecutionEngine({}).executeAgentTurn(
    agent,
    [
      { role: 'user', content: 'first', metadata: { tag: 'from-input' } },
      { role: 'assistant', content: 'second' }
    ],
    { metadata: { tag: 'from-options', traceId: 'tr_9' } }
  );

  const first = agent.history.find((m) => m.content === 'first');
  const second = agent.history.find((m) => m.content === 'second');
  assert.ok(first);
  assert.ok(second);
  assert.deepStrictEqual(first.metadata, { tag: 'from-input', traceId: 'tr_9' });
  assert.deepStrictEqual(second.metadata, { tag: 'from-options', traceId: 'tr_9' });
});

test('31a81f1: no-role content-path merge parity is preserved', async () => {
  const agent = makeAgent('metadata_parity_agent');
  await new TurnExecutionEngine({}).executeAgentTurn(
    agent,
    { content: 'y', metadata: { tag: 'from-input' } },
    { metadata: { tag: 'from-options', traceId: 'tr_9' } }
  );

  const msg = userHistory(agent);
  assert.ok(msg);
  assert.deepStrictEqual(msg.metadata, { tag: 'from-input', traceId: 'tr_9' });
});
