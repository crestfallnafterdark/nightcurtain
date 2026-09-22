/**
 * @file tests/audit/repros/identity_stale_caller_key.test.js
 * @description Red-first audit repro for Wave I I2-V re-check residual R2
 * (LOW-MED, security; ticket d57cbc1): a stale trusted `callerKey` — the
 * pinned identity channel a mid-turn dispatcher holds after its holder was
 * recycled — fell back to the bare id claim. With the other Realm's same-id
 * twin active the spawn retargeted that twin (child in Beta, peer workspace
 * pinned), and with both holders recycled it degraded to the anonymous host
 * path (child in the seeded Generic realm, full workspace pinning). The fix
 * fails a supplied-but-unresolvable key closed everywhere it is consumed:
 * principal resolution, mutation targets, and the launch spawn composition.
 *
 * Red at HEAD 0bec0920 (pre-fix): the stale spawns succeed (child in Beta /
 * `realm_generic`) and a stale `kill_agent` recycles the Beta victim; the
 * fresh-key controls pass before and after.
 *
 * Run directly (not part of `npm test`):
 *   timeout 180 node tests/audit/repros/identity_stale_caller_key.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

/** Realm of the recycled dispatcher holder. */
const ALPHA = 'realm_g5r2_alpha';
/** Realm of the same-id twin and the peer victim. */
const BETA = 'realm_g5r2_beta';
/** Private workspace key of the Beta victim (the peer pin a spawn must never adopt). */
const PEER_WORKSPACE = 'g5r2-wiki';
/** Peer bytes that every denied stale-key operation must leave intact. */
const PEER_SECRET = 'g5r2-test-peer-secret-bytes';

/** Tool grants of the shared ordinary `scout` caller. */
const SCOUT_TOOLS = Object.freeze(['read_file', 'spawn_agent', 'kill_agent']);

/**
 * Deterministic in-memory model accepted by the store's launch path (repo
 * convention): no turn is driven here, so no request ever leaves the process.
 *
 * @param {string} output - Static assistant text.
 * @returns {object} Model-shaped stub with `stream`/`complete`.
 */
function createDeterministicModel(output) {
  return {
    id: `g5r2-model-${output}`,
    config: {},
    provider: {
      id: `g5r2-provider-${output}`,
      createModel: () => createDeterministicModel(output),
      getEndpointUrl: () => 'http://127.0.0.1:1/v1',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: `g5r2-model-${output}`, name: 'G5-R2 Model' }]
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
 * Builds a dispatcher bound with an explicitly pinned canonical `callerKey`,
 * exactly as the turn engine binds the trusted key into a mid-turn execution
 * context (trusted construction output; per-call claims are stripped).
 *
 * @param {object} runtime - Live runtime.
 * @param {object} identityPort - Runtime identity port.
 * @param {string} callerKey - Pinned canonical identity key to bind.
 * @param {readonly string[]} [allowedTools] - Bound capability allowlist.
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, identityPort, callerKey, allowedTools = SCOUT_TOOLS) {
  return createSandboxToolDispatcher({
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    agentId: 'scout',
    callerAgentId: 'scout',
    callerKey,
    workspaceId: 'scout',
    allowedTools: [...allowedTools],
    lifecyclePort: runtime.createLifecyclePort(),
    identityPort
  });
}

/**
 * Builds the two-Realm fixture: ordinary `scout` in Alpha, a privileged
 * same-id twin in Beta, and a Beta victim whose private workspace holds the
 * peer bytes.
 *
 * @returns {Promise<object>} Live fixture plus realm-exact projections and the
 *   stale Alpha dispatcher (bound before any recycling).
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
  store.createRealm({ id: ALPHA, name: 'G5-R2 Alpha' });
  store.createRealm({ id: BETA, name: 'G5-R2 Beta' });

  await store.launchAgent(
    { id: 'scout', realmId: ALPHA, allowedTools: [...SCOUT_TOOLS] },
    createDeterministicModel('g5r2-alpha-scout')
  );
  await store.launchAgent(
    { id: 'scout', realmId: BETA, privileged: true, allowedTools: ['*'] },
    createDeterministicModel('g5r2-beta-scout')
  );
  await store.launchAgent(
    { id: 'victim', realmId: BETA, workspaceId: PEER_WORKSPACE, allowedTools: ['read_file'] },
    createDeterministicModel('g5r2-victim')
  );

  runtime.virtualFs.writeFile(
    { filePath: '/secret.md', content: PEER_SECRET },
    { callerAgentId: 'victim' }
  );

  const identityPort = runtime.createAgentIdentityPort();
  const alpha = identityPort.getAgentIdentity('scout', { realmId: ALPHA });
  const beta = identityPort.getAgentIdentity('scout', { realmId: BETA });
  assert.ok(alpha?.key && beta?.key, 'fixture: both same-id registrations resolve canonical keys');
  assert.notEqual(alpha.key, beta.key, 'fixture: the two registrations are distinct');

  return {
    runtime,
    store,
    operator: runtime.getOperatorPrincipal(),
    alpha,
    beta,
    stale: dispatcherFor(runtime, identityPort, alpha.key),
    fresh: dispatcherFor(runtime, identityPort, beta.key)
  };
}

/**
 * Finds any registration (active or recycled) of a bare id.
 *
 * @param {object} runtime - Live runtime.
 * @param {string} agentId - Bare agent id.
 * @returns {object|null} The registration, or null.
 */
function findAnywhere(runtime, agentId) {
  return runtime.listAgents({ includeRecycled: true }).find((agent) => agent.id === agentId) || null;
}

test('d57cbc1 G5-R2: a stale pinned key never retargets the same-id twin (case X)', async () => {
  const fixture = await createFixture();
  const { runtime, store, operator, stale, fresh, alpha, beta } = fixture;
  try {
    // Control: the fresh, correctly-keyed dispatcher still spawns in its own realm.
    const freshSpawn = await fresh.executeTool('spawn_agent', { id: 'fresh_child' });
    assert.equal(freshSpawn.success, true, `a valid pinned key must still spawn: ${JSON.stringify(freshSpawn)}`);
    const freshChild = findAnywhere(runtime, 'fresh_child');
    assert.equal(freshChild?.config?.realmId, BETA, 'the fresh child lands in the Beta caller realm');

    // Recycle the Alpha holder, leaving only the Beta twin.
    runtime.killAgent(alpha.key, 'stale-key probe', { principal: operator });
    assert.equal(runtime.getAgent(beta.key)?.id, 'scout', 'fixture: the Beta twin stays active');

    // A stale-key kill must not resolve the Beta twin's kill authority.
    const staleKill = await stale.executeTool('kill_agent', { agent_id: 'victim' });
    assert.equal(staleKill.success, false, `the stale-key kill must not retarget: ${JSON.stringify(staleKill)}`);
    assert.equal(runtime.getAgent(beta.key)?.id, 'scout', 'the Beta twin survives the stale kill');
    assert.equal(
      runtime.listAgents({ realmId: BETA }).some((agent) => agent.id === 'victim'),
      true,
      'the Beta victim stays active'
    );

    // The peer-pinned stale spawn must fail closed, not adopt the twin's authority.
    const staleSpawn = await stale.executeTool('spawn_agent', { id: 'stale_child', workspace: PEER_WORKSPACE });
    assert.equal(staleSpawn.success, false, `the stale-key spawn must be denied: ${JSON.stringify(staleSpawn)}`);
    assert.equal(staleSpawn.code, 'PERMISSION_DENIED', 'the stale launch denial uses PERMISSION_DENIED');
    assert.equal(findAnywhere(runtime, 'stale_child'), null, 'the denied stale child is never registered');
    assert.equal(
      runtime.listAgents({ realmId: BETA }).some((agent) => agent.config?.workspaceId === PEER_WORKSPACE),
      true,
      'the peer workspace claim is untouched'
    );

    // The pinned key is fail-closed on every lifecycle surface it feeds: the
    // descriptor listing resolves nothing (never the twin's realm members) and
    // the facade port list scopes to nothing.
    const staleDescriptors = runtime.createLifecyclePort().listAgentDescriptors({
      callerAgentId: 'scout',
      callerKey: alpha.key
    });
    assert.deepEqual(staleDescriptors, [], 'the stale key resolves no descriptor listing');
    const stalePortList = runtime.createLifecyclePort().listAgents({}, {
      callerAgentId: 'scout',
      callerKey: alpha.key
    });
    assert.deepEqual(stalePortList, [], 'the stale key resolves no port-scoped agent listing');

    // Peer bytes survived every denied operation.
    const peerBytes = runtime.virtualFs.readFile('/secret.md', { callerAgentId: 'victim', raw: true });
    assert.equal(peerBytes, PEER_SECRET, 'the peer private bytes are intact');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});

test('d57cbc1 G5-R2: a stale pinned key never anonymous-degrades (case Y)', async () => {
  const fixture = await createFixture();
  const { runtime, store, operator, stale, alpha, beta } = fixture;
  try {
    // Recycle both same-id holders: the pinned key resolves nothing at all.
    runtime.killAgent(alpha.key, 'stale-key probe', { principal: operator });
    runtime.killAgent(beta.key, 'stale-key probe', { principal: operator });

    const staleSpawn = await stale.executeTool('spawn_agent', { id: 'stale_child2', workspace: PEER_WORKSPACE });
    assert.equal(staleSpawn.success, false, `the stale-key spawn must not anonymous-degrade: ${JSON.stringify(staleSpawn)}`);
    assert.equal(staleSpawn.code, 'PERMISSION_DENIED', 'the degraded launch denial uses PERMISSION_DENIED');
    assert.equal(findAnywhere(runtime, 'stale_child2'), null, 'no child is minted from the stale key');
    assert.equal(
      runtime.listAgents().some((agent) => agent.config?.realmId === 'realm_generic' && agent.id === 'stale_child2'),
      false,
      'the seeded Generic realm never receives a stale-key child'
    );

    const peerBytes = runtime.virtualFs.readFile('/secret.md', { callerAgentId: 'victim', raw: true });
    assert.equal(peerBytes, PEER_SECRET, 'the peer private bytes are intact');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
