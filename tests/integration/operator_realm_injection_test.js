/**
 * @file tests/integration/operator_realm_injection_test.js
 * @description Realm wave A-2 (ticket 99faaf1): operator attribution for
 *   Realm-bound deliveries on both operator surfaces, end to end through the
 *   real runtime, real messaging bus, and real SandboxStore composition root.
 *
 *   Covered behavior:
 *   1. The turn engine's mail-injection path (default `from: 'user'`) binds the
 *      runtime's opaque operator principal (Wave I, ticket c02d0b9) as the
 *      trusted execution-context caller, so a Realm-bound agent receives
 *      operator mail through the real bus and the envelope is archived under
 *      the operator label — never under an agent id.
 *   2. `SandboxStore.sendMessage` — the `MessagingBusViewer` manual-send and
 *      demo-seed surface — carries the runtime's host operator principal by
 *      exact reference (Wave I, ticket c02d0b9) for labels that do not resolve
 *      to a registered agent, so the bypass is the principal and the label
 *      stays presentation only, while agent-labelled sends keep the agent's
 *      own identity and Realm scope.
 *   3. Agent cross-realm sends stay denied (`PERMISSION_DENIED`, no mailbox
 *      copy, no audit entry) through both surfaces, including an explicitly
 *      attributed injection sender.
 *   4. Zero-agent operator capability: both the engine injection and the store
 *      manual send work with no agents at all (the runtime operator principal
 *      always exists, so no director is needed).
 *   5. Legacy ungrouped parity: operator and agent sends to ungrouped agents
 *      keep their established delivery semantics.
 *
 * Fixture note: each store performs at most one injection-mode `triggerTurn`.
 * Two consecutive injection triggers on one store do not settle today (a
 * pre-existing quirk, reproduced on unmodified code), and a queued injection
 * whose explicit foreign-agent sender is dropped by the trigger queue's Realm
 * confinement leaves the store waiter unsettled; neither is related to
 * operator attribution. The explicit-sender behavior is therefore covered by
 * the runtime-level case (1c), which bypasses the queue, and the store-level
 * cross-realm denial is covered by the `sendMessage` cases.
 *
 * Real classes only (Zero-Mock Verification): real `SandboxStore`, real
 * `AgentRuntime`, real `MessagingBus`, real `VirtualFS`; only the model provider
 * is a deterministic in-memory stub (repo test convention).
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus, MESSAGING_ERROR_CODES } from '../../src/lib/sandbox/messagingBus/index.ts';
import { createSandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';

/**
 * Trusted identity projection mirroring the runtime producer wiring (the
 * runtime's `createAgentIdentityPort` marks the hardcoded system director with
 * `realmBypass`): used by the engine-surface tests that wire their own real
 * runtime + real bus instead of the store composition root.
 *
 * @param {string} agentId - Claimed agent subject.
 * @returns {object|null} Projection for the subject, or `null` when unknown.
 */
function identityProbe(agentId) {
  if (agentId === 'director') return { id: agentId, key: 'system:director', realmBypass: true };
  if (agentId === 'realm-alpha-member') return { id: agentId, key: 'realm:realm_alpha_a2:realm-alpha-member', realmId: 'realm_alpha_a2' };
  if (agentId === 'realm-beta-member') return { id: agentId, key: 'realm:realm_beta_a2:realm-beta-member', realmId: 'realm_beta_a2' };
  if (agentId === 'ungrouped-agent') return { id: agentId, key: 'system:ungrouped-agent' };
  return null;
}

/**
 * Enumeration companion of {@link identityProbe}: the canonical-key channel
 * resolves through `listAgentIdentities()` (Wave I, d57cbc1), so the probe
 * mirrors the runtime producer's enumeration surface too.
 *
 * @returns {object[]} Known projections in probe order.
 */
function identityProbeList() {
  return ['director', 'realm-alpha-member', 'realm-beta-member', 'ungrouped-agent']
    .map((id) => identityProbe(id))
    .filter(Boolean);
}

/**
 * Deterministic in-memory model stub accepted by `launchAgent` (the repo's
 * standard test double for provider calls — the engine, runtime, bus, and store
 * remain real).
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
 * Creates an isolated non-hydrating store with no auto-bootstrapped director.
 *
 * @returns {object} Fresh `SandboxStore` instance.
 */
function createStore() {
  return createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
}

/**
 * Launches one agent into a Realm through the store (operator surface).
 *
 * @param {object} store - Store instance under test.
 * @param {string} id - Agent id.
 * @param {string|null} realmId - Realm membership, or `null` for ungrouped.
 * @returns {Promise<object>} The launched agent snapshot.
 */
async function launch(store, id, realmId = null) {
  return store.launchAgent({
    id,
    name: id,
    role: 'realm-test-agent',
    ...(realmId ? { realmId } : {}),
    model: createMockModel()
  });
}

/**
 * Filters the store's message projection (bus audit log) by exact content.
 *
 * @param {object} store - Store instance under test.
 * @param {string} content - Exact message content to find.
 * @returns {object[]} Matching audit envelopes.
 */
function archived(store, content) {
  return store.messages.filter((message) => message.content === content);
}

// ============================================================================
// 1. Engine injection surface — operator attribution into a Realm
// ============================================================================

test('1. operator injection through the turn engine delivers to a realm-bound agent mailbox (real bus)', async () => {
  const store = createStore();
  try {
    await store.ensureDirector();
    store.createRealm({ id: 'realm_alpha_a2', name: 'Alpha A2' });
    await launch(store, 'realm-narrator', 'realm_alpha_a2');

    // The documented operator injection path: default `from: 'user'`, no context.
    await store.triggerTurn('realm-narrator', 'Operator broadcast into the realm', { mode: 'injection' });

    const delivered = archived(store, 'Operator broadcast into the realm');
    assert.equal(delivered.length, 1, 'the operator injection must be archived exactly once on delivery');
    assert.equal(
      delivered[0].from,
      'user',
      'the envelope carries the operator label; authority is the runtime operator principal, never a caller-supplied realm claim'
    );
    assert.equal(delivered[0].to, 'realm-narrator');

    // The same-turn mail wake drains the envelope into the agent context.
    assert.equal(store.getAgentUnreadCount('realm-narrator'), 0, 'the injection wake consumed the mailbox copy');
    assert.ok(
      store.agentMessages.some(
        (message) => typeof message.content === 'string' && message.content.includes('Operator broadcast into the realm')
      ),
      'the injected mail body reaches the agent history/context'
    );
  } finally {
    store.destroy();
  }
});

test('1b. an explicit same-realm agent injection sender stays deliverable and keeps its identity', async () => {
  const store = createStore();
  try {
    await store.ensureDirector();
    await launch(store, 'realm-alpha-member', 'realm_alpha_a2');

    await store.triggerTurn('realm-alpha-member', 'Same-realm peer injection', {
      mode: 'injection',
      sender: 'realm-alpha-member'
    });

    const delivered = archived(store, 'Same-realm peer injection');
    assert.equal(delivered.length, 1, 'a same-realm agent injection stays deliverable');
    assert.equal(delivered[0].from, 'realm-alpha-member', 'an explicit agent sender is never operator-attributed');
  } finally {
    store.destroy();
  }
});

test('1c. runtime-level engine injection: default sender is operator-attributed, a foreign agent sender stays denied', async () => {
  const bus = new MessagingBus({ identityPort: { getAgentIdentity: identityProbe, listAgentIdentities: identityProbeList } });
  const runtime = new AgentRuntime({
    virtualFs: new VirtualFS(),
    messagingBus: bus,
    autoBootstrapDirector: false
  });
  try {
    await runtime.launchAgent({ id: 'realm-alpha-member', realmId: 'realm_alpha_a2', allowedTools: ['read_file'] }, createMockModel());
    await runtime.launchAgent({ id: 'realm-beta-member', realmId: 'realm_beta_a2', allowedTools: ['read_file'] }, createMockModel());

    // Default operator sender: attributed through the runtime operator
    // principal, which the composition root bound to the injected bus by exact
    // reference (Wave I, ticket c02d0b9).
    await runtime.executeAgentTurn('realm-alpha-member', 'Runtime operator injection', { mode: 'injection' });
    const delivered = bus.getAuditLog().filter((message) => message.content === 'Runtime operator injection');
    assert.equal(delivered.length, 1, 'the default injection sender must deliver to the realm-bound target');
    assert.equal(delivered[0].from, 'user', 'the envelope carries the operator label under the operator principal');
    assert.equal(delivered[0].to, 'realm-alpha-member');

    // Explicit agent sender: agent-scoped Realm enforcement is untouched.
    await runtime.executeAgentTurn('realm-alpha-member', 'Foreign injection', {
      mode: 'injection',
      sender: 'realm-beta-member'
    });
    assert.deepEqual(
      bus.getAuditLog().filter((message) => message.content === 'Foreign injection'),
      [],
      'an explicit foreign-realm sender must not be silently operator-attributed'
    );
    assert.equal(bus.getUnreadCount('realm-beta-member'), 0);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Store manual-send surface — operator attribution and identity preservation
// ============================================================================

test('2. store manual send carries the host operator principal for non-agent labels and preserves agent senders', async () => {
  const store = createStore();
  try {
    await store.ensureDirector();
    await launch(store, 'realm-alpha-lead', 'realm_alpha_a2');
    await launch(store, 'realm-alpha-peer', 'realm_alpha_a2');

    // MessagingBusViewer default label: 'human' resolves to no registered agent,
    // so the store (the operator surface) carries the host operator principal
    // by exact reference while the label stays presentation only.
    const operatorReceipt = store.sendMessage('human', 'realm-alpha-lead', 'Manual operator note');
    assert.equal(operatorReceipt.success, true, 'the manual operator send must reach a realm-bound target');
    assert.equal(operatorReceipt.from, 'human', 'the non-agent label is presented at the envelope; authority is the principal');
    assert.equal(operatorReceipt.to, 'realm-alpha-lead');
    assert.equal(store.getAgentUnreadCount('realm-alpha-lead'), 1, 'the envelope lands in the target mailbox');
    assert.equal(archived(store, 'Manual operator note').length, 1, 'the delivered envelope is archived');

    // A registered agent sender keeps its own identity and Realm scope.
    const agentReceipt = store.sendMessage('realm-alpha-peer', 'realm-alpha-lead', 'Same-realm agent note');
    assert.equal(agentReceipt.success, true);
    assert.equal(agentReceipt.from, 'realm-alpha-peer', 'agent-labelled sends keep their sender identity');
    assert.equal(archived(store, 'Same-realm agent note').length, 1);
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 3. No widening — cross-realm agent sends stay denied
// ============================================================================

test('3. agent cross-realm sends stay denied with no mailbox copy and no audit trace', async () => {
  const store = createStore();
  try {
    await store.ensureDirector();
    await launch(store, 'realm-alpha-agent', 'realm_alpha_a2');
    await launch(store, 'realm-beta-agent', 'realm_beta_a2');

    const receipt = store.sendMessage('realm-alpha-agent', 'realm-beta-agent', 'Cross-realm agent note');
    assert.equal(receipt.success, false, 'agent sends must not gain operator bypass');
    assert.equal(receipt.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
    assert.equal(store.getAgentUnreadCount('realm-beta-agent'), 0);
    assert.deepEqual(archived(store, 'Cross-realm agent note'), []);

    // The reverse direction is symmetric.
    const reverse = store.sendMessage('realm-beta-agent', 'realm-alpha-agent', 'Reverse cross-realm note');
    assert.equal(reverse.success, false);
    assert.equal(reverse.code, MESSAGING_ERROR_CODES.PERMISSION_DENIED);
    assert.equal(store.getAgentUnreadCount('realm-alpha-agent'), 0);
    assert.deepEqual(archived(store, 'Reverse cross-realm note'), []);
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 4. Zero-agent operator capability on both surfaces
// ============================================================================

test('4. the engine injection and the store manual send both work with zero agents (host operator principal)', async () => {
  const store = createStore();
  try {
    // No director: the principal-less launch still honors the explicit realm.
    await launch(store, 'realm-orphan', 'realm_alpha_a2');

    // Store manual send: the host operator principal exists with zero agents
    // (Wave I, ticket c02d0b9), so a realm-bound target is reachable.
    const receipt = store.sendMessage('human', 'realm-orphan', 'Zero-agent operator note');
    assert.equal(receipt.success, true, 'the host operator principal grants Realm bypass with zero agents');
    assert.equal(receipt.from, 'human', 'the non-agent label is presented at the envelope');
    assert.equal(store.getAgentUnreadCount('realm-orphan'), 1, 'the envelope lands in the target mailbox');

    // Engine injection: the runtime operator principal exists with zero agents
    // (Wave I, ticket c02d0b9), so the operator injection delivers.
    await store.triggerTurn('realm-orphan', 'Zero-agent operator injection', { mode: 'injection' });
    const injected = archived(store, 'Zero-agent operator injection');
    assert.equal(injected.length, 1, 'the engine operator injection must deliver with zero agents');
    assert.equal(injected[0].from, 'user', 'the envelope carries the operator label');
    assert.equal(injected[0].to, 'realm-orphan');
  } finally {
    store.destroy();
  }
});

// ============================================================================
// 5. Legacy ungrouped parity
// ============================================================================

test('5. ungrouped deliveries keep their established semantics on both surfaces', async () => {
  const store = createStore();
  try {
    await store.ensureDirector();
    await launch(store, 'ungrouped-sender');
    await launch(store, 'ungrouped-target');

    const agentReceipt = store.sendMessage('ungrouped-sender', 'ungrouped-target', 'Ungrouped agent note');
    assert.equal(agentReceipt.success, true, 'ungrouped agent-to-agent delivery stays unchanged');
    assert.equal(agentReceipt.from, 'ungrouped-sender', 'the ungrouped sender identity is preserved');

    const operatorReceipt = store.sendMessage('human', 'ungrouped-target', 'Ungrouped operator note');
    assert.equal(operatorReceipt.success, true, 'operator sends to ungrouped agents stay deliverable');
    assert.equal(operatorReceipt.from, 'human', 'the non-agent label is presented at the envelope');
    assert.equal(store.getAgentUnreadCount('ungrouped-target'), 2);

    await store.triggerTurn('ungrouped-target', 'Ungrouped operator injection', { mode: 'injection' });
    const injected = archived(store, 'Ungrouped operator injection');
    assert.equal(injected.length, 1, 'operator injection to an ungrouped agent stays deliverable');
    assert.equal(injected[0].from, 'user', 'the engine envelope carries the operator label under the operator principal');
  } finally {
    store.destroy();
  }
});
