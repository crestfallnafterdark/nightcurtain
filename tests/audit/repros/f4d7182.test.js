/**
 * @file tests/audit/repros/f4d7182.test.js
 * @description Audit repro for ticket f4d7182 (Minor, area:docs): the
 * `reasoning_content` string-primitive invariant is false for caller-supplied
 * assistant-role directive inputs, which are pushed into history verbatim.
 *
 * Evidence: `src/lib/sandbox/runtime/turnExecutionEngine/index.ts` directive-mode
 * `role` branches push `{ ...item }` / `{ ...input }` with only an id
 * backfilled, so an assistant message without `reasoning_content` (or with a
 * non-string value) reaches `agent.history`.
 *
 * Contract pin: `turnExecutionEngine.d.ts` @invariant "Every assistant history
 * message carries `reasoning_content` as a string primitive (default `''`),
 * never `null` or `undefined` (INV-REASONING-STRING)" and class invariant 7.
 * `TurnInputObject.role` explicitly permits `'assistant'`.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/f4d7182.test.js
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

function assistantHistory(agent, content) {
  return agent.history.find((m) => m.role === 'assistant' && m.content === content);
}

test('f4d7182: assistant-role input object without reasoning_content is normalized to a string', async () => {
  const agent = makeAgent('reasoning_object_agent');
  const receipt = await new TurnExecutionEngine({}).executeAgentTurn(agent, {
    role: 'assistant',
    content: 'prior turn'
  });

  assert.strictEqual(receipt.status, 'completed');
  const msg = assistantHistory(agent, 'prior turn');
  assert.ok(msg, 'the caller-supplied assistant message must be stored in history');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(msg, 'reasoning_content'),
    true,
    'assistant message must carry the reasoning_content field'
  );
  assert.strictEqual(typeof msg.reasoning_content, 'string', 'reasoning_content must be a string primitive');
  assert.strictEqual(msg.reasoning_content, '');
});

test('f4d7182: array-form assistant inputs normalize missing, null, and non-string reasoning_content', async () => {
  const agent = makeAgent('reasoning_array_agent');
  await new TurnExecutionEngine({}).executeAgentTurn(agent, [
    { role: 'assistant', content: 'no-reasoning' },
    { role: 'assistant', content: 'null-reasoning', reasoning_content: null },
    { role: 'assistant', content: 'numeric-reasoning', reasoning_content: 42 },
    { role: 'assistant', content: 'string-reasoning', reasoning_content: 'kept reasoning' }
  ]);

  for (const [content, expected] of [
    ['no-reasoning', ''],
    ['null-reasoning', ''],
    ['numeric-reasoning', ''],
    ['string-reasoning', 'kept reasoning']
  ]) {
    const msg = assistantHistory(agent, content);
    assert.ok(msg, `assistant message '${content}' must be stored in history`);
    assert.strictEqual(
      typeof msg.reasoning_content,
      'string',
      `reasoning_content for '${content}' must be a string primitive`
    );
    assert.strictEqual(msg.reasoning_content, expected, `reasoning_content for '${content}' must be normalized`);
  }
});
