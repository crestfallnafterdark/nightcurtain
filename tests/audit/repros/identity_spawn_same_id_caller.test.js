/**
 * @file tests/audit/repros/identity_spawn_same_id_caller.test.js
 * @description Red-first audit repro for Wave I I2-V finding F1 (HIGH,
 * security; ticket d57cbc1): the lifecycle tool paths from a realm-bound
 * caller whose bare id exists in two realms must resolve the caller
 * realm-exactly through the trusted dispatcher-pinned canonical `callerKey`.
 * Before the tools fix the lifecycle descriptors dropped the pinned key, the
 * runtime resolved no principal, and the spawn degraded to an anonymous host
 * launch: the workspace-confinement gate and the SEC-2 tool clamp were skipped
 * and a peer private workspace could be adopted (then evicted by self-kill).
 *
 * The file carries the contract in two tests so the two layers stay legible:
 *
 * 1. `... tools resolve realm-exactly ...` — the tools-side contract, green
 *    with the `lifecycleTools` caller-resolution fix alone: forged per-call
 *    identity/realm claims stay stripped and inert, peer/reserved workspace
 *    pins are denied by the confinement gate, `kill_agent`/`list_agents`/
 *    `whoami` resolve the bound caller, and a realm-ambiguous keyless bound
 *    caller fails closed on the launch path instead of hosting anonymously.
 *
 * 2. `... spawn inherits the caller realm ...` — the placement contract, which
 *    additionally requires the runtime launch composition to resolve the
 *    creator record realm-exactly from the resolved principal descriptor
 *    (`runtime/agentLifecycle/index.ts` launch composition). It is RED at the
 *    tools-fix commit and goes green with that runtime seam; the exact seam and
 *    its verification are reported with the fix.
 *
 * Red at HEAD 79fb8bc2: test 1 fails (the peer pin is adopted) and test 2 fails
 * (the child lands in the seeded Generic realm).
 *
 * Run directly (not part of `npm test`):
 *   timeout 180 node tests/audit/repros/identity_spawn_same_id_caller.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

/** First realm of the same-literal-id pair. */
const ALPHA = 'realm_f1_alpha';
/** Second realm of the same-literal-id pair. */
const BETA = 'realm_f1_beta';
/** Private bytes the peer workspace holds; a denied spawn must never reach them. */
const PEER_SECRET = 'f1-test-peer-secret-bytes';

/** Tool grants for the shared ordinary `scout` pair. */
const SCOUT_TOOLS = Object.freeze(['read_file', 'spawn_agent', 'kill_agent', 'list_agents', 'whoami']);

/**
 * Deterministic in-memory model accepted by the store's launch path (repo
 * convention): no turn is driven here, so no request ever leaves the process.
 *
 * @param {string} output - Static assistant text.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output) {
  return {
    id: `f1-model-${output}`,
    config: {},
    provider: {
      id: `f1-provider-${output}`,
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: `f1-model-${output}`, name: 'F1 Model' }]
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
 * Builds the two-realm same-id fixture: ordinary `scout` in each realm, a
 * unique ordinary `solo` control, and a `peer` whose private workspace holds
 * the bytes a spawned child must never adopt.
 *
 * @returns {Promise<{ runtime: AgentRuntime, store: object, alphaScout: object, betaScout: object, alpha: Function, beta: Function }>}
 *   Live fixture plus the realm-exact identity projections and dispatchers.
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    runtime,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  await store.ensureDirector();
  store.createRealm({ id: ALPHA, name: 'F1 Alpha' });
  store.createRealm({ id: BETA, name: 'F1 Beta' });

  await store.launchAgent(
    { id: 'scout', realmId: ALPHA, allowedTools: [...SCOUT_TOOLS] },
    createDeterministicModel('alpha-scout')
  );
  await store.launchAgent(
    { id: 'scout', realmId: BETA, allowedTools: [...SCOUT_TOOLS] },
    createDeterministicModel('beta-scout')
  );
  await store.launchAgent(
    { id: 'solo', realmId: ALPHA, allowedTools: [...SCOUT_TOOLS] },
    createDeterministicModel('solo')
  );
  await store.launchAgent(
    { id: 'peer', realmId: ALPHA, allowedTools: ['read_file'] },
    createDeterministicModel('peer')
  );

  runtime.virtualFs.writeFile({ filePath: '/secret.md', content: PEER_SECRET }, { callerAgentId: 'peer' });

  const identityPort = runtime.createAgentIdentityPort();
  const alphaScout = identityPort.getAgentIdentity('scout', { realmId: ALPHA });
  const betaScout = identityPort.getAgentIdentity('scout', { realmId: BETA });
  assert.ok(alphaScout && alphaScout.key, 'fixture: the Alpha scout resolves to a canonical key');
  assert.ok(betaScout && betaScout.key, 'fixture: the Beta scout resolves to a canonical key');
  assert.notEqual(alphaScout.key, betaScout.key, 'fixture: the two registrations are distinct');

  return {
    runtime,
    store,
    alphaScout,
    betaScout,
    alpha: dispatcherFor(runtime, 'scout', ALPHA),
    beta: dispatcherFor(runtime, 'scout', BETA)
  };
}

/**
 * Builds a dispatcher bound to one fixture caller exactly as the turn engine
 * supplies it (identity subject plus, when the caller is realm-bound, the
 * pinned realm scope from which the dispatcher derives the canonical key).
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} agentId - Bound caller identity.
 * @param {string} [realmId] - Trusted realm scope to pin (omit for an unscoped dispatcher).
 * @param {readonly string[]} [allowedTools] - Bound capability allowlist.
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, agentId, realmId, allowedTools = SCOUT_TOOLS) {
  return createSandboxToolDispatcher({
    runtime,
    agentId,
    callerAgentId: agentId,
    ...(realmId ? { realmId } : {}),
    allowedTools: [...allowedTools],
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    worldClock: runtime.worldClock
  });
}

/**
 * Finds the live registration of a bare id inside one realm.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} realmId - Realm scope to search.
 * @param {string} agentId - Bare agent id.
 * @returns {object|null} The registration, or null.
 */
function findRealmAgent(runtime, realmId, agentId) {
  return runtime.listAgents({ realmId }).find((agent) => agent.id === agentId) || null;
}

test('d57cbc1 I2-V F1: same-id lifecycle tools resolve realm-exactly and stay confined', async () => {
  const fixture = await createFixture();
  const { runtime, store, betaScout, alpha } = fixture;
  try {
    // A peer workspace pin carries forged per-call identity/realm claims in the
    // third argument: all pinned keys must be stripped before dispatch, and the
    // realm-exact caller must drive the workspace-confinement gate.
    const forged = await alpha.executeTool(
      'spawn_agent',
      { id: 'child_peer', workspace: 'peer', tools: ['read_file'] },
      { callerAgentId: 'scout', agentId: 'scout', callerKey: betaScout.key, realmId: BETA }
    );
    assert.equal(forged.success, false, `the peer workspace pin must be denied: ${JSON.stringify(forged)}`);
    assert.equal(forged.code, 'PERMISSION_DENIED', 'the peer pin denial uses PERMISSION_DENIED');
    assert.equal(findRealmAgent(runtime, ALPHA, 'child_peer'), null, 'the denied child is never registered');
    assert.equal(
      String(JSON.stringify(forged)).includes(PEER_SECRET),
      false,
      'the denial receipt never carries peer bytes'
    );

    const reservedPin = await alpha.executeTool('spawn_agent', { id: 'child_global', workspace: 'global' });
    assert.equal(reservedPin.success, false, 'a reserved workspace pin must be denied for an ordinary same-id creator');
    assert.equal(reservedPin.code, 'PERMISSION_DENIED', 'the reserved pin denial uses PERMISSION_DENIED');
    assert.equal(findRealmAgent(runtime, ALPHA, 'child_global'), null, 'the reserved-pin child is never registered');

    const peerBytes = runtime.virtualFs.readFile('/secret.md', { callerAgentId: 'peer', raw: true });
    assert.equal(peerBytes, PEER_SECRET, 'the peer private bytes survive every denied spawn');

    // The same-id caller resolves for its self-scoped tools: `whoami` returns
    // its own bare identity and `list_agents` resolves its own realm scope.
    const who = await alpha.executeTool('whoami', {});
    assert.equal(who.success, true, `whoami must resolve the same-id caller: ${JSON.stringify(who)}`);
    assert.equal(who.id, 'scout', 'whoami projects the realm-local bare id');

    const alphaListingReceipt = await alpha.executeTool('list_agents', {});
    assert.equal(
      alphaListingReceipt.success,
      true,
      `list_agents must succeed for the same-id caller: ${JSON.stringify(alphaListingReceipt)}`
    );
    assert.ok(Array.isArray(alphaListingReceipt.result), 'list_agents returns a descriptor array');
    const alphaIds = alphaListingReceipt.result.map((entry) => entry.id);
    assert.ok(alphaIds.includes('scout'), `the same-id caller must see its own descriptor: ${JSON.stringify(alphaListingReceipt)}`);
    assert.equal(alphaIds.includes('peer'), false, 'an ordinary caller never sees a same-realm peer');
    assert.equal(
      JSON.stringify(alphaListingReceipt).includes(BETA),
      false,
      'the listing carries no foreign realm vocabulary'
    );

    // A dispatcher bound to the ambiguous bare id with no trusted key or realm
    // scope fails closed on every lifecycle path: no listing, no kill, and no
    // anonymous host launch.
    const ambiguous = dispatcherFor(runtime, 'scout');
    const ambiguousListing = await ambiguous.executeTool('list_agents', {});
    assert.equal(ambiguousListing.success, true, 'the ambiguous refusal path is a projected empty listing');
    assert.deepEqual(ambiguousListing.result, [], 'an ambiguous unbound caller receives no listing');

    const ambiguousKill = await ambiguous.executeTool('kill_agent', { agent_id: 'solo' });
    assert.equal(ambiguousKill.success, false, 'an ambiguous unbound caller cannot kill');

    const ambiguousSpawn = await ambiguous.executeTool('spawn_agent', { id: 'child_ambiguous', workspace: 'peer' });
    assert.equal(ambiguousSpawn.success, false, 'an ambiguous unbound caller must not reach an anonymous host launch');
    assert.equal(ambiguousSpawn.code, 'PERMISSION_DENIED', 'the ambiguous launch denial uses PERMISSION_DENIED');
    assert.equal(findRealmAgent(runtime, ALPHA, 'child_ambiguous'), null, 'the ambiguous launch registers nothing');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});

test('d57cbc1 I2-V F1: same-id spawn inherits the caller realm, clamp, and kill authority', async () => {
  const fixture = await createFixture();
  const { runtime, store, alpha, beta } = fixture;
  try {
    // A lawful spawn (no foreign pin) must register in the caller realm, not
    // the seeded Generic default, and the SEC-2 clamp must strip tools the
    // ordinary creator does not hold.
    const spawned = await alpha.executeTool('spawn_agent', { id: 'child_alpha', tools: ['write_file'] });
    assert.equal(spawned.success, true, `the same-id spawn must launch: ${JSON.stringify(spawned)}`);
    const childAlpha = findRealmAgent(runtime, ALPHA, 'child_alpha');
    assert.ok(childAlpha, 'the child must register in the caller realm');
    assert.equal(childAlpha.config.realmId, ALPHA, 'child realm === caller realm');
    assert.notEqual(childAlpha.config.workspaceId, 'peer', 'the child must not adopt the peer private workspace');
    assert.equal(
      (childAlpha.config.allowedTools || []).includes('write_file'),
      false,
      'SEC-2: the child tools must be clamped to the ordinary creator allowlist'
    );

    const betaSpawn = await beta.executeTool('spawn_agent', { id: 'child_beta' });
    assert.equal(betaSpawn.success, true, `the Beta same-id spawn must launch: ${JSON.stringify(betaSpawn)}`);
    const childBeta = findRealmAgent(runtime, BETA, 'child_beta');
    assert.ok(childBeta, 'the Beta child registers in the Beta realm');
    assert.equal(childBeta.config.realmId, BETA, 'Beta child realm === Beta caller realm');

    // Parent authority resolves realm-exactly: the same-id creator kills its
    // own child, the foreign-realm same-id caller cannot kill across realms.
    const crossKill = await alpha.executeTool('kill_agent', { agent_id: 'child_beta' });
    assert.equal(crossKill.success, false, 'the same-id Alpha caller must not kill the Beta realm child');
    assert.equal(crossKill.code, 'PERMISSION_DENIED', 'the cross-realm kill fails closed');
    assert.ok(findRealmAgent(runtime, BETA, 'child_beta'), 'the cross-realm kill leaves the Beta child alive');

    const betaOwnKill = await beta.executeTool('kill_agent', { agent_id: 'child_beta' });
    assert.equal(betaOwnKill.success, true, `the same-id Beta creator must kill its own child: ${JSON.stringify(betaOwnKill)}`);
    assert.equal(findRealmAgent(runtime, BETA, 'child_beta'), null, 'the parent kill recycles the Beta child');

    const ownKill = await alpha.executeTool('kill_agent', { agent_id: 'child_alpha' });
    assert.equal(ownKill.success, true, `the same-id creator must kill its own child: ${JSON.stringify(ownKill)}`);
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
