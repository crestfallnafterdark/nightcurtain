/**
 * @file tests/audit/repros/f950abe.test.js
 * @description Audit repro for ticket f950abe (Major, area:docs): every event
 * emitted by `TurnExecutionEngine` omits the `timestamp` required by the
 * declared `SubsystemEmitPort` contract.
 *
 * Evidence: all eight `#emit` call sites in
 * `src/lib/sandbox/runtime/turnExecutionEngine/index.ts` (`turn_start`, precall
 * `tool_start`/`tool_end`, `stream`, loop `tool_start`/`tool_end`,
 * `turn_complete`, `error`) build `{ type, agentId, payload }` without a
 * timestamp; the injected port and runtime broadcast forward events unchanged.
 *
 * Contract pin: `src/lib/sandbox/runtime/index.ts` `SubsystemEmitPort.emit` -
 * `emit(event: { type: string; timestamp: number; payload?: unknown }): void;`
 * with "`timestamp` is an epoch millisecond value supplied by the emitter".
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/f950abe.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { TurnExecutionEngine } from '../../../src/lib/sandbox/runtime/turnExecutionEngine/index.ts';

/**
 * Wildcard-authority identity stub (A0-5, ticket 0443865): the custom
 * `read_file`/`echo` handlers in this repro are host-registered, and the
 * turn execution engine now executes custom handlers only for callers whose
 * frozen authority descriptor grants `'*'`/`'@lifecycle:authority'`. The
 * timestamp assertions below are unaffected.
 */
function createWildcardRuntime(agentId) {
  return {
    createAgentIdentityPort: () => ({
      getAgentIdentity: (id) => (id === agentId
        ? {
            id,
            privileged: true,
            allowedTools: ['*'],
            authority: {
              subject: id,
              kind: 'agent',
              allow: new Set(['*']),
              visibility: 'all'
            }
          }
        : null)
    })
  };
}

function makeAgent(id) {
  return {
    id,
    name: id,
    state: 'idle',
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
    config: { allowedTools: [], maxTurns: 5 },
    model: { async *stream() {} },
    rebindModel() {}
  };
}

test('f950abe: every event emitted across a tool-loop turn carries a numeric timestamp', async () => {
  const events = [];
  let streamCall = 0;
  const agent = makeAgent('timestamp_agent');
  agent.pendingPrecalls = [{ name: 'read_file', arguments: { path: '/notes.md' } }];
  agent.config.customTools = {
    read_file: async () => ({ success: true, content: 'notes' }),
    echo: async () => ({ success: true, echoed: true })
  };
  agent.model = {
    async *stream() {
      if (streamCall++ === 0) {
        yield { type: 'text', content: 'working' };
        yield {
          type: 'tool_call',
          toolCalls: [{
            id: 'call_echo_1',
            type: 'function',
            name: 'echo',
            function: { name: 'echo', arguments: '{}' }
          }]
        };
      } else {
        yield { type: 'text', content: 'done' };
      }
    }
  };

  const engine = new TurnExecutionEngine({
    emit: { emit: (event) => events.push(event) },
    runtime: createWildcardRuntime(agent.id)
  });
  const receipt = await engine.executeAgentTurn(agent, 'go');

  assert.strictEqual(receipt.status, 'completed');

  const types = events.map((e) => e.type);
  for (const required of ['turn_start', 'stream', 'tool_start', 'tool_end', 'turn_complete']) {
    assert.ok(types.includes(required), `expected a '${required}' event, saw: ${types.join(', ') || '(none)'}`);
  }
  assert.ok(
    events.filter((e) => e.type === 'tool_start').length >= 2,
    'precall dispatch and loop tool dispatch must both emit tool_start'
  );

  for (const event of events) {
    assert.strictEqual(
      typeof event.timestamp,
      'number',
      `event '${event.type}' must carry the port-required numeric timestamp`
    );
    assert.ok(Number.isFinite(event.timestamp), `event '${event.type}' timestamp must be finite`);
  }
});

test('f950abe: error events carry a numeric timestamp', async () => {
  const events = [];
  const agent = makeAgent('timestamp_error_agent');
  agent.model = {
    async *stream() {
      const err = new Error('provider exploded');
      err.code = 'PROVIDER_DOWN';
      throw err;
    }
  };

  const engine = new TurnExecutionEngine({ emit: { emit: (event) => events.push(event) } });
  await assert.rejects(() => engine.executeAgentTurn(agent, 'go'), /provider exploded/);

  const errorEvent = events.find((e) => e.type === 'error');
  assert.ok(errorEvent, 'the engine must emit an error event before rethrowing');
  assert.strictEqual(typeof errorEvent.timestamp, 'number');
  assert.ok(Number.isFinite(errorEvent.timestamp));
});
