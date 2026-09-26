/**
 * @file tests/audit/repros/0cd2dde.test.js
 * @description Audit repro for ticket 0cd2dde (Major, hang class), acceptance
 *   (b): "a trigger dropped by realm confinement resolves/notifies its waiter
 *   (clear rejection or documented terminal receipt) instead of hanging".
 *
 *   `TriggerQueue.processTick()` drops a trigger whose realm-bound source
 *   targets another realm (A6 drop-not-loop) by deleting the trigger and its
 *   `#sourceKeys` side-car entry and `continue`-ing — no event, no callback, no
 *   receipt (`src/lib/sandbox/triggerQueue/index.ts:811-814`). But
 *   `Runtime.enqueueUserTurn` registered a `#userTurnWaiters` entry keyed by the
 *   queue `triggerId` (`src/lib/sandbox/runtime/index.ts:2960-2977`), which is
 *   only settled when the dispatcher forwards that trigger
 *   (`#claimUserTurnWaiter`, `src/lib/sandbox/runtime/index.ts:3809-3818`).
 *   A dropped trigger therefore strands the caller's promise forever:
 *   `store.triggerTurn(target, input, { mode: 'injection', sender })` never
 *   settles — no rejection, no terminal receipt.
 *
 *   The foreign-sender injection is the exact shape from
 *   `tests/integration/operator_realm_injection_test.js` case 1c, but through
 *   the queued entry points (`enqueueUserTurn` / store `triggerTurn`) instead of
 *   the direct `executeAgentTurn` facade. The drop is deterministic: the source
 *   resolves realm-bound via the runtime's trusted identity port, the queued
 *   target is the canonical `(realmId, agentId)` key of the other realm, and
 *   `enqueueUserTurn` forwards no `sourceKey`, so the gate fails closed.
 *
 * Red at HEAD d12a847. Deterministic and offline: real `AgentRuntime` / real
 * `SandboxStore` / real `VirtualFS` / real `MessagingBus` (only the model
 * provider is the repo's deterministic in-memory stub, and the dropped trigger
 * never reaches a turn). Each assertion is a bounded settle race (500 ms), so a
 * red run fails fast instead of hanging the test runner.
 *
 * Expected green after the fix: both queued promises settle within the bound —
 * either rejected with a clear error or resolved with a documented terminal
 * receipt. The assertions deliberately require only *settlement*, not a
 * particular shape, so either ratified fix path passes.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/0cd2dde.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { createSandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';

/** Upper bound for a queued turn to settle in this fixture (ms). */
const SETTLE_BOUND_MS = 500;

/**
 * Deterministic in-memory model stub accepted by both `launchAgent` surfaces
 * (mirrors the integration harness convention; never invoked on the dropped
 * paths, so it only has to satisfy the model shape).
 *
 * @param {string} output - Final assistant text for every turn.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createMockModel(output = 'acknowledged') {
  return {
    id: 'mock-model',
    config: {},
    provider: {
      id: 'mock-provider',
      createModel: () => createMockModel(output),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: 'mock-model', name: 'Mock Model' }]
    },
    async *stream(options = {}) {
      if (typeof options.onChunk === 'function') options.onChunk(output);
      yield { type: 'text', content: output };
      yield { type: 'finish', finishReason: 'stop', content: output, reasoning: '', toolCalls: [] };
    },
    async complete() {
      return { role: 'assistant', content: output };
    }
  };
}

/**
 * Bounded settle race. Resolves `'settled'` when `promise` settles at all
 * (resolution or rejection) and `'TIMED_OUT'` after `ms`; the timer is cleared
 * when the promise wins, so a green run adds no latency and a red run fails
 * fast without leaking a handle.
 *
 * @param {Promise<unknown>} promise - Promise under test.
 * @param {number} [ms] - Settle bound in milliseconds.
 * @returns {Promise<'settled'|'TIMED_OUT'>} Settlement outcome marker.
 */
function settleWithin(promise, ms = SETTLE_BOUND_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMED_OUT'), ms);
    const finish = () => {
      clearTimeout(timer);
      resolve('settled');
    };
    promise.then(finish, finish);
  });
}

// ============================================================================
// 1. Runtime-level queued entry: foreign-sender injection stranded by the drop
// ============================================================================

test('0cd2dde (a): a realm-confined drop settles its enqueueUserTurn waiter', async () => {
  const runtime = new AgentRuntime({
    virtualFs: new VirtualFS(),
    messagingBus: new MessagingBus(),
    autoBootstrapDirector: false
  });
  try {
    await runtime.launchAgent(
      { id: 'realm-alpha-member', realmId: 'realm_alpha_a6', allowedTools: ['read_file'] },
      createMockModel()
    );
    await runtime.launchAgent(
      { id: 'realm-beta-member', realmId: 'realm_beta_a6', allowedTools: ['read_file'] },
      createMockModel()
    );

    // Queued injection whose explicit sender is realm-bound in another realm:
    // the queue's A6 gate drops the trigger; the waiter must still settle.
    const turn = runtime.enqueueUserTurn('realm-alpha-member', 'Runtime cross-realm injection', {
      mode: 'injection',
      sender: 'realm-beta-member'
    });

    const outcome = await settleWithin(turn);
    const pending = runtime.triggerQueue.getPendingCount();
    assert.equal(
      outcome,
      'settled',
      `enqueueUserTurn waiter stranded: no settlement within ${SETTLE_BOUND_MS} ms ` +
        `(queue pending=${pending}, so the trigger was silently discarded, not deferred) — ` +
        'the A6 realm-confinement drop discarded the trigger without notifying its waiter'
    );
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Store-level queued entry: the ticket's "store waiter" wording
// ============================================================================

test('0cd2dde (b): a realm-confined drop settles the store triggerTurn waiter', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    await store.ensureDirector();
    store.createRealm({ id: 'realm_alpha_a6', name: 'Alpha A6' });
    await store.launchAgent({
      id: 'realm-alpha-member',
      name: 'Alpha A6 member',
      role: 'realm-test-agent',
      realmId: 'realm_alpha_a6',
      model: createMockModel()
    });
    await store.launchAgent({
      id: 'realm-beta-member',
      name: 'Beta A6 member',
      role: 'realm-test-agent',
      realmId: 'realm_beta_a6',
      model: createMockModel()
    });

    // Store-level variant matching the ticket's "store waiter" wording: an
    // injection attributed to a foreign-realm agent whose queued user trigger
    // is dropped by the A6 confinement.
    const turn = store.triggerTurn('realm-alpha-member', 'Store cross-realm injection', {
      mode: 'injection',
      sender: 'realm-beta-member'
    });

    const outcome = await settleWithin(turn);
    assert.equal(
      outcome,
      'settled',
      `store triggerTurn waiter stranded: no settlement within ${SETTLE_BOUND_MS} ms — ` +
        'the A6 realm-confinement drop discarded the queued injection without rejecting or ' +
        'notifying the store waiter'
    );
  } finally {
    store.destroy();
  }
});
