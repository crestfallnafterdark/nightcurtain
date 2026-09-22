/**
 * @file tests/audit/repros/63026f5.test.js
 * @description Audit repro for ticket 63026f5 (Major; MOD-21-A2):
 * `invoke_agent` forwards `context.depth` — a caller-controllable per-call key
 * — while the trusted bound `currentDepth` capability has no consumer. The
 * hard recursion guard therefore never accumulates depth for tool-initiated
 * invocations, and a direct dispatcher caller can set/overwrite the depth that
 * reaches the invocation engine.
 *
 * Expected: the descriptor forwards the trusted bound `currentDepth` and never
 * reads a per-call `depth`; the invocation engine increments the incoming
 * trusted depth so nested tool-initiated invocations accumulate.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/63026f5.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';
import {
  InvocationEngine,
  MAX_INVOCATION_DEPTH
} from '../../../src/lib/sandbox/invocationEngine/index.ts';

function buildDispatcher(currentDepth, seen) {
  return createSandboxToolDispatcher({
    agentId: 'agent_a',
    allowedTools: ['invoke_agent'],
    currentDepth,
    lifecyclePort: {
      invokeAgent: async (invokerId, targetAgentId, prompt, options) => {
        seen.push({ invokerId, targetAgentId, prompt, options });
        return { success: true };
      }
    }
  });
}

test('63026f5: invoke_agent forwards the bound currentDepth and ignores caller depth', async () => {
  const seen = [];
  const dispatcher = buildDispatcher(4, seen);

  await dispatcher.executeTool('invoke_agent', { agent_id: 'agent_b', prompt: 'x' });
  await dispatcher.executeTool('invoke_agent', { agent_id: 'agent_b', prompt: 'x' }, { depth: 0 });
  await dispatcher.executeTool('invoke_agent', { agent_id: 'agent_b', prompt: 'x' }, { depth: 99 });

  assert.strictEqual(seen.length, 3);
  assert.strictEqual(seen[0].options.depth, 4, 'the bound turn depth must be forwarded');
  assert.strictEqual(seen[1].options.depth, 4, 'a per-call depth must not reset the guard');
  assert.strictEqual(seen[2].options.depth, 4, 'a per-call depth must not inflate the guard either');

  for (const call of seen) {
    assert.strictEqual(call.options.currentDepth, undefined, 'the capability key is not leaked downstream');
  }
});

test('63026f5: invocation engine rejects at the depth ceiling and increments below it', async () => {
  const seenDepths = [];
  const engine = new InvocationEngine({
    executeTurn: async (_targetAgentId, _prompt, options) => {
      seenDepths.push(options.depth);
      return { output: 'ok' };
    },
    getAgent: (agentId) => ({ id: agentId, config: {}, state: 'idle' }),
    isAgentTerminated: () => false,
    getAgentAuthority: () => ({
      subject: 'agent_a',
      kind: 'agent',
      allow: new Set(['*']),
      visibility: 'all'
    })
  });

  const receipt = engine.invokeAgent('agent_a', 'agent_b', 'P', { depth: 4 });
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.status, 'dispatched');

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepStrictEqual(seenDepths, [MAX_INVOCATION_DEPTH], 'the executed turn runs one level deeper');

  const overflow = engine.invokeAgent('agent_a', 'agent_b', 'P', { depth: MAX_INVOCATION_DEPTH });
  assert.strictEqual(overflow.success, false);
  assert.strictEqual(overflow.code, 'RECURSION_DEPTH_EXCEEDED');
});
