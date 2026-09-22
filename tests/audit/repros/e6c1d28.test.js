/**
 * @file tests/audit/repros/e6c1d28.test.js
 * @description Audit repro for ticket e6c1d28 (Major; [DOC] with behavior
 * residual): the triggerDispatcher "Single dispatch point" invariant claims all
 * activations route through `TriggerQueue`, but user turns historically bypassed
 * it and two residual direct `executeAgentTurn` sites remained after the W6
 * store routing: history `retryAgentTurn` resend and `launchAgent(initialPrompt)`.
 *
 * Ratified resolution (MOD-21 W7): route both user-facing turn paths through the
 * centralized queue-backed `enqueueUserTurn` entry when the runtime exposes a
 * `TriggerQueue` (direct `executeAgentTurn` stays only as the no-queue
 * fallback for standalone/test hosts).
 *
 * Red on the pre-fix tree: neither path enqueues a USER trigger.
 *
 * Wave I (ticket d57cbc1) keyed queue dispatch on the canonical `(realmId,
 * agentId)` identity key, which is internal-only and never agent-facing. The
 * assertions therefore read the queue's public diagnostics projection
 * (`getPendingTriggers`), which maps registered canonical keys back to their
 * bare realm-local ids, instead of pinning the internal dispatch ref.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/e6c1d28.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

function createMockModel(responses = []) {
  let responseIndex = 0;
  const mockProvider = { name: 'mock_provider', providerName: 'mock' };
  return {
    provider: mockProvider,
    async *stream(options) {
      const resp = responses[responseIndex++] || { content: 'Default mock response' };
      if (resp.error) throw resp.error;
      if (resp.delayMs) {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(resolve, resp.delayMs);
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timeout);
              const abortErr = new Error('AbortError');
              abortErr.name = 'AbortError';
              reject(abortErr);
            }, { once: true });
          }
        });
      }
      if (resp.content) yield { type: 'text', content: resp.content };
      yield {
        type: 'finish',
        content: resp.content || '',
        reasoning: '',
        toolCalls: null,
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }
      };
    },
    async complete() {
      const resp = responses[responseIndex++] || { content: 'Default mock response' };
      return {
        content: resp.content || '',
        reasoning: '',
        toolCalls: null,
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 }
      };
    }
  };
}

/**
 * Captures each enqueued trigger's public diagnostics projection.
 *
 * The queue stores the canonical `(realmId, agentId)` identity key as the
 * internal dispatch ref (Wave I, ticket d57cbc1) but `getPendingTriggers()`
 * projects registered keys back to their bare realm-local ids. The wrapped
 * `enqueue` snapshots that projection synchronously, while the trigger is
 * still pending — dispatch happens on a later microtask/tick — so the
 * assertions below exercise the agent-facing identity, never the internal key.
 */
function captureUserTriggers(runtime) {
  const enqueued = [];
  const queue = runtime.triggerQueue;
  const realEnqueue = queue.enqueue.bind(queue);
  queue.enqueue = (trigger) => {
    const triggerId = realEnqueue(trigger);
    const projected = queue.getPendingTriggers().find((t) => t.triggerId === triggerId);
    if (!projected) {
      throw new Error(`Trigger '${triggerId}' missing from the pending diagnostics projection`);
    }
    enqueued.push(projected);
    return triggerId;
  };
  return enqueued;
}

test('e6c1d28: history retry resend routes through the central TriggerQueue', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.launchAgent(
      { id: 'retry_agent', role: 'assistant' },
      createMockModel([{ content: 'first reply' }, { content: 'retry reply' }])
    );
    await runtime.executeAgentTurn('retry_agent', 'hello');

    const enqueued = captureUserTriggers(runtime);
    const result = await runtime.retryAgentTurn('retry_agent');

    assert.strictEqual(result.output, 'retry reply', 'retry must still resolve the canonical receipt');
    const userTriggers = enqueued.filter((t) => t.type === 'user');
    assert.strictEqual(userTriggers.length, 1, 'retry must enqueue exactly one USER trigger');
    assert.strictEqual(userTriggers[0].targetAgentId, 'retry_agent');
  } finally {
    runtime.destroy();
  }
});

test('e6c1d28: launchAgent(initialPrompt) routes through the central TriggerQueue', async () => {
  const runtime = createAgentRuntime();
  try {
    const enqueued = captureUserTriggers(runtime);
    const agent = await runtime.launchAgent({
      config: { id: 'launch_agent', role: 'assistant' },
      model: createMockModel([{ content: 'boot reply' }]),
      initialPrompt: 'bootstrap directive'
    });

    assert.strictEqual(agent.id, 'launch_agent');
    const userTriggers = enqueued.filter((t) => t.type === 'user');
    assert.strictEqual(userTriggers.length, 1, 'initial prompt must enqueue exactly one USER trigger');
    assert.strictEqual(userTriggers[0].targetAgentId, 'launch_agent');
    assert.strictEqual(agent.history.filter((m) => m.role === 'user').length, 1, 'initial prompt must execute once');
  } finally {
    runtime.destroy();
  }
});

test('e6c1d28: no production turn path calls executeAgentTurn outside the queue dispatch', async () => {
  const runtime = createAgentRuntime();
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent(
      { id: 'audit_agent', role: 'assistant' },
      createMockModel([{ content: 'reply one' }, { content: 'reply two' }, { content: 'reply three' }])
    );

    const directCalls = [];
    const realExecute = runtime.executeAgentTurn.bind(runtime);
    runtime.executeAgentTurn = (agentId, input, options) => {
      if (options?.triggerType !== 'user' && options?.triggerType !== 'invocation' && options?.triggerType !== 'mail' && options?.triggerType !== 'schedule') {
        directCalls.push({ agentId, input });
      }
      return realExecute(agentId, input, options);
    };

    await runtime.enqueueUserTurn('audit_agent', 'queued turn');
    await runtime.executeAgentTurn('audit_agent', 'first direct turn');
    await runtime.retryAgentTurn('audit_agent');

    assert.deepStrictEqual(
      directCalls.map((c) => c.input),
      ['first direct turn'],
      'only the explicit direct facade call may bypass the queue; retry must be queued'
    );
  } finally {
    runtime.destroy();
  }
});
