/**
 * @file tests/integration/realm_visibility_lifecycle_test.js
 * @description Realm wave A-2 (tickets 3487c56 + fc74c52) end-to-end
 * verification through the real dispatcher seam:
 *   1. `list_agents` visibility is Realm-scoped on top of the 9133495
 *      predicate: a realm-bound caller sees itself and its same-Realm
 *      children/members only — the director occupies the reserved system
 *      scope and is never listed to a realm caller (Realm wave R, ticket
 *      cf0e127); ungrouped callers keep the legacy self/children scope and
 *      never see Realm members; the director/operator bypass sees every agent.
 *   2. `kill_agent` / `restore_agent` / `invoke_agent` are confined to the
 *      caller's Realm scope: a cross-scope target is denied fail-closed even
 *      for wildcard/privileged agents, while same-scope self/parent/sudoer
 *      semantics are unchanged. Wave R (ticket 56ba4b9): launches without an
 *      explicit realm resolve the seeded Generic default, the null scope is
 *      reserved for the director/system bootstrap, and no caller (the system
 *      director included) can move membership.
 *   3. `wait_for_invocation` authenticates the trusted caller channel: only
 *      the invocation's invoker, its target, or a Realm-bypass principal may
 *      await it; unrelated, unresolvable, and flag-forged callers fail closed,
 *      and the agent-facing lifecycle port marks every wait caller-scoped so
 *      an unauthenticated tool-path wait is denied.
 *   4. Launch parentage is bound to the RESOLVED creator (fc74c52): a forged
 *      `spawnedBy`/`creatorId` from an unprivileged creator is ignored, the
 *      forged parent gains neither visibility nor kill authority, and the real
 *      creator keeps both.
 *   5. `listAgents` Realm-filter plumbing: the additive `realmId` option and
 *      the agent-facing lifecycle-port confinement, while the operator path
 *      stays unscoped.
 *
 * Real classes only (Zero-Mock Verification): a real `AgentRuntime` with real
 * substrates and the real dispatcher; the only stub is the LLM model.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';

/** Tools granted to ordinary fixture agents. */
const ORDINARY_TOOLS = Object.freeze([
  'list_agents',
  'kill_agent',
  'spawn_agent',
  'invoke_agent',
  'wait_for_invocation'
]);

/**
 * Minimal stream/complete mock model so invocation turns settle without a
 * provider network.
 *
 * @param {Function} fn - Response factory receiving the stream options.
 * @param {string} [modelId] - Model identifier.
 * @returns {object} Model-like object accepted by `launchAgent`.
 */
function createMockModel(fn, modelId = 'realm-a5-model') {
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'realm-a5-provider',
      createModel: (id) => createMockModel(fn, id),
      getEndpointUrl: () => 'http://localhost/test',
      checkBalance: async () => ({ balance: 100 }),
      listModels: async () => [{ id: modelId, name: modelId }]
    },
    async *stream(options = {}) {
      const res = await fn({ ...options });
      const content = res && typeof res === 'object' ? (res.content || res.text || 'ok') : (res || 'ok');
      if (typeof options.onChunk === 'function') {
        try { options.onChunk(content); } catch { /* best-effort chunk delivery */ }
      }
      yield { type: 'text', content };
      yield { type: 'finish', finishReason: 'stop', content, toolCalls: [] };
    },
    async complete(options = {}) {
      return await fn(options);
    }
  };
}

/**
 * Resolves the bootstrapped director's frozen authority descriptor (the
 * operator/system principal used by host launches).
 *
 * @param {AgentRuntime} runtime - Real runtime.
 * @returns {object} Frozen director `AuthorityDescriptor`.
 */
function directorAuthority(runtime) {
  const identity = runtime.createAgentIdentityPort().getAgentIdentity('director');
  assert.ok(identity && identity.authority, 'the bootstrapped director must expose a frozen authority descriptor');
  return identity.authority;
}

/**
 * Builds the Realm fixture through real launches:
 * - director (ungrouped bypass);
 * - realm `R1`: privileged `r1_lead`, ordinary `r1_worker` + its child `r1_child`;
 * - realm `R2`: privileged `r2_lead`, ordinary `r2_worker`;
 * - ungrouped: privileged `loose_lead`, ordinary `loose_worker` + its child
 *   `loose_child`, ordinary `stranger`.
 *
 * @returns {Promise<AgentRuntime>} Live runtime.
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const model = createMockModel(async () => ({ content: 'realm-a5 turn complete' }));
  await runtime.ensureDirector();
  const operator = directorAuthority(runtime);

  await runtime.launchAgent({ config: { id: 'loose_lead', privileged: true }, principal: operator, model });
  await runtime.launchAgent({ id: 'loose_worker', allowedTools: [...ORDINARY_TOOLS] }, model);
  await runtime.launchAgent({
    config: { id: 'loose_child', allowedTools: ['list_agents'] },
    callerContext: { callerAgentId: 'loose_worker' },
    model
  });
  await runtime.launchAgent({ id: 'stranger', allowedTools: ['list_agents', 'kill_agent'] }, model);

  await runtime.launchAgent({ config: { id: 'r1_lead', realmId: 'R1', privileged: true }, principal: operator, model });
  await runtime.launchAgent({ id: 'r1_worker', realmId: 'R1', allowedTools: [...ORDINARY_TOOLS] }, model);
  await runtime.launchAgent({
    config: { id: 'r1_child', allowedTools: ['list_agents'] },
    callerContext: { callerAgentId: 'r1_worker' },
    model
  });

  await runtime.launchAgent({ config: { id: 'r2_lead', realmId: 'R2', privileged: true }, principal: operator, model });
  await runtime.launchAgent({ id: 'r2_worker', realmId: 'R2', allowedTools: [...ORDINARY_TOOLS] }, model);

  return runtime;
}

/**
 * Builds a dispatcher bound to one fixture agent.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} agentId - Bound caller identity.
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, agentId) {
  return createSandboxToolDispatcher({ runtime, agentId });
}

/**
 * Extracts the sorted ids from a successful `list_agents` receipt.
 *
 * @param {object} receipt - Tool receipt.
 * @returns {string[]} Sorted descriptor ids.
 */
function visibleIds(receipt) {
  assert.equal(receipt.success, true, `list_agents failed: ${receipt.error}`);
  assert.ok(Array.isArray(receipt.result));
  return receipt.result.map((entry) => entry.id).sort();
}

// ============================================================================
// 1. Visibility matrix (through the real dispatcher seam)
// ============================================================================

test('1. a realm-bound ordinary caller sees self and same-realm children only', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, 'r1_worker').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(receipt),
      ['r1_child', 'r1_worker'],
      'ordinary callers never see peers, other realms, ungrouped agents, or the director'
    );
  } finally {
    runtime.destroy();
  }
});

test('2. a realm-bound wildcard caller sees its own realm members only', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, 'r1_lead').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(receipt),
      ['r1_child', 'r1_lead', 'r1_worker'],
      'wildcard authority does not escape the Realm or reach the system scope'
    );
  } finally {
    runtime.destroy();
  }
});

test('3. the director (Realm bypass) sees every agent', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, 'director').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(receipt),
      ['director', 'loose_child', 'loose_lead', 'loose_worker', 'r1_child', 'r1_lead', 'r1_worker', 'r2_lead', 'r2_worker', 'stranger']
    );
  } finally {
    runtime.destroy();
  }
});

test('4. ungrouped callers keep legacy scoping and never see realm members', async () => {
  const runtime = await createFixture();
  try {
    const ordinary = await dispatcherFor(runtime, 'loose_worker').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(ordinary),
      ['loose_child', 'loose_worker'],
      'an ungrouped ordinary caller keeps self + children; the director is never listed'
    );

    // Legacy parity note: the ungrouped `null` scope remains a shared legacy
    // scope for ungrouped subjects, but it is not the director's reserved
    // system scope — no non-bypass caller, realm-bound or ungrouped, shares
    // scope with the director (Realm wave R, ticket cf0e127). Realm model R5
    // removes non-director ungrouped launches via the Generic default.
    const sudoer = await dispatcherFor(runtime, 'loose_lead').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(sudoer),
      ['loose_child', 'loose_lead', 'loose_worker', 'stranger'],
      'the ungrouped scope is shared by ungrouped subjects only'
    );
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Lifecycle gates (kill / restore / invoke)
// ============================================================================

test('5. cross-realm kill is denied fail-closed even for wildcard callers; same-realm relations hold', async () => {
  const runtime = await createFixture();
  try {
    // Ordinary R1 caller targeting R2: denied, target untouched.
    const ordinaryDenied = await dispatcherFor(runtime, 'r1_worker').executeTool('kill_agent', { agent_id: 'r2_worker' });
    assert.equal(ordinaryDenied.success, false);
    assert.equal(ordinaryDenied.code, 'PERMISSION_DENIED');
    assert.equal(runtime.hasAgent('r2_worker'), true, 'a denied cross-realm kill leaves the target active');

    // Wildcard R1 caller targeting R2: still denied (agent authority never escapes).
    const wildcardDenied = await dispatcherFor(runtime, 'r1_lead').executeTool('kill_agent', { agent_id: 'r2_worker' });
    assert.equal(wildcardDenied.success, false);
    assert.equal(wildcardDenied.code, 'PERMISSION_DENIED');
    assert.equal(runtime.hasAgent('r2_worker'), true);

    // Wildcard R1 caller targeting an ungrouped agent: denied (scope mismatch).
    const ungroupedDenied = await dispatcherFor(runtime, 'r1_lead').executeTool('kill_agent', { agent_id: 'loose_worker' });
    assert.equal(ungroupedDenied.success, false);
    assert.equal(ungroupedDenied.code, 'PERMISSION_DENIED');
    assert.equal(runtime.hasAgent('loose_worker'), true);

    // Same-realm parent kill of its child: allowed inside the Realm.
    const parentKill = await dispatcherFor(runtime, 'r1_worker').executeTool('kill_agent', { agent_id: 'r1_child' });
    assert.equal(parentKill.success, true, `same-realm parent kill failed: ${parentKill.error}`);
    assert.equal(runtime.hasRecycledAgent('r1_child'), true);

    // Same-realm sudoer kill: allowed inside the Realm.
    const sudoerKill = await dispatcherFor(runtime, 'r1_lead').executeTool('kill_agent', { agent_id: 'r1_worker' });
    assert.equal(sudoerKill.success, true, `same-realm sudoer kill failed: ${sudoerKill.error}`);
    assert.equal(runtime.hasRecycledAgent('r1_worker'), true);

    // Director bypass: cross-realm kill allowed.
    const directorKill = await dispatcherFor(runtime, 'director').executeTool('kill_agent', { agent_id: 'r2_worker' });
    assert.equal(directorKill.success, true, `director bypass kill failed: ${directorKill.error}`);
    assert.equal(runtime.hasRecycledAgent('r2_worker'), true);
  } finally {
    runtime.destroy();
  }
});

test('6. cross-realm restore is denied; same-realm and bypass restores work', async () => {
  const runtime = await createFixture();
  try {
    runtime.killAgent('r2_worker', 'fixture recycle', { callerAgentId: 'director' });
    assert.equal(runtime.hasRecycledAgent('r2_worker'), true);

    assert.throws(
      () => runtime.restoreAgent('r2_worker', { callerAgentId: 'r1_lead' }),
      (err) => err.code === 'PERMISSION_DENIED',
      'a wildcard agent cannot restore a foreign-realm agent'
    );
    assert.throws(
      () => runtime.restoreAgent('r2_worker', { callerAgentId: 'loose_lead' }),
      (err) => err.code === 'PERMISSION_DENIED',
      'an ungrouped caller cannot restore a realm-bound agent'
    );
    assert.equal(runtime.hasRecycledAgent('r2_worker'), true, 'denied restores leave the record recycled');

    const restored = runtime.restoreAgent('r2_worker', { callerAgentId: 'r2_lead' });
    assert.equal(restored.id, 'r2_worker');
    assert.equal(runtime.hasAgent('r2_worker'), true);

    runtime.killAgent('r2_worker', 'fixture recycle again', { callerAgentId: 'director' });
    const bypassRestored = runtime.restoreAgent('r2_worker', { callerAgentId: 'director' });
    assert.equal(bypassRestored.id, 'r2_worker', 'the director bypass spans Realms');

    // A privileged foreign record takes the requireSudoer path; the Realm gate
    // still denies the wildcard caller before the sudoer verdict is accepted.
    runtime.killAgent('r2_lead', 'fixture recycle lead', { callerAgentId: 'director' });
    assert.throws(
      () => runtime.restoreAgent('r2_lead', { callerAgentId: 'r1_lead' }),
      (err) => err.code === 'PERMISSION_DENIED',
      'the requireSudoer restore path is Realm-gated too'
    );
    assert.equal(runtime.hasRecycledAgent('r2_lead'), true, 'the denied restore leaves the privileged record recycled');
    assert.equal(runtime.restoreAgent('r2_lead', { callerAgentId: 'director' }).id, 'r2_lead', 'the director bypass restores it');
  } finally {
    runtime.destroy();
  }
});

test('7. cross-realm invoke is denied even for wildcards; same-realm and bypass invokes dispatch', async () => {
  const runtime = await createFixture();
  try {
    const crossRealm = await dispatcherFor(runtime, 'r1_lead').executeTool('invoke_agent', {
      agent_id: 'r2_worker',
      prompt: 'foreign realm task'
    });
    assert.equal(crossRealm.success, false);
    assert.equal(crossRealm.code, 'PERMISSION_DENIED');

    const sameRealm = await dispatcherFor(runtime, 'r1_lead').executeTool('invoke_agent', {
      agent_id: 'r1_worker',
      prompt: 'same realm task'
    });
    assert.equal(sameRealm.success, true, `same-realm invoke failed: ${sameRealm.error}`);
    assert.equal(sameRealm.status, 'dispatched');

    const bypass = await dispatcherFor(runtime, 'director').executeTool('invoke_agent', {
      agent_id: 'r2_worker',
      prompt: 'bypass task'
    });
    assert.equal(bypass.success, true, `director invoke failed: ${bypass.error}`);

    const ungroupedParent = await dispatcherFor(runtime, 'loose_worker').executeTool('invoke_agent', {
      agent_id: 'loose_child',
      prompt: 'ungrouped legacy task'
    });
    assert.equal(ungroupedParent.success, true, `ungrouped parent invoke failed: ${ungroupedParent.error}`);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 3. Parentage binding (fc74c52)
// ============================================================================

test('8. forged parentage is bound to the resolved creator and confers neither visibility nor authority (fc74c52)', async () => {
  const runtime = await createFixture();
  try {
    await runtime.launchAgent({
      config: {
        id: 'mole',
        spawnedBy: 'stranger',
        creatorId: 'stranger',
        allowedTools: ['list_agents']
      },
      callerContext: { callerAgentId: 'r1_worker' }
    });

    const mole = runtime.getAgent('mole');
    assert.ok(mole, 'the child must launch');
    assert.equal(mole.config.spawnedBy, 'r1_worker', 'stored spawnedBy is the RESOLVED creator');
    assert.equal(mole.config.creatorId, 'r1_worker', 'stored creatorId is the RESOLVED creator');
    assert.equal(mole.config.realmId, 'R1', 'the child inherits the resolved creator realm');

    // (a) The forged parent gains no visibility.
    const strangerView = await dispatcherFor(runtime, 'stranger').executeTool('list_agents', {});
    assert.equal(
      visibleIds(strangerView).includes('mole'),
      false,
      'the forged parent must not see the child in its list_agents scope'
    );

    // (b) The forged parent gains no parent kill authority.
    const forgedKill = await dispatcherFor(runtime, 'stranger').executeTool('kill_agent', { agent_id: 'mole' });
    assert.equal(forgedKill.success, false);
    assert.equal(forgedKill.code, 'PERMISSION_DENIED');
    assert.equal(runtime.hasAgent('mole'), true, 'a denied forged-parent kill leaves the child active');

    // The resolved creator keeps both visibility and parent authority.
    const creatorView = await dispatcherFor(runtime, 'r1_worker').executeTool('list_agents', {});
    assert.equal(visibleIds(creatorView).includes('mole'), true, 'the real creator sees its child');
    const creatorKill = await dispatcherFor(runtime, 'r1_worker').executeTool('kill_agent', { agent_id: 'mole' });
    assert.equal(creatorKill.success, true, `the real creator keeps parent authority: ${creatorKill.error}`);
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 4. wait_for_invocation authorization
// ============================================================================

test('9. waitForInvocation authenticates the trusted caller: invoker/target/bypass only, fail closed', async () => {
  const runtime = await createFixture();
  try {
    const receipt = runtime.invokeAgent({ invokerId: 'r1_lead', targetAgentId: 'r1_worker', prompt: 'collect report' });
    assert.equal(receipt.success, true);
    const invocationId = receipt.invocationId;

    const unrelated = await runtime.waitForInvocation(invocationId, { timeout_ms: 50 }, { callerAgentId: 'r2_worker' });
    assert.equal(unrelated.success, false, 'an unrelated peer must not await the invocation');
    assert.equal(unrelated.code, 'PERMISSION_DENIED');

    const ungrouped = await runtime.waitForInvocation(invocationId, { timeout_ms: 50 }, { callerAgentId: 'loose_worker' });
    assert.equal(ungrouped.success, false, 'cross-scope callers are denied');
    assert.equal(ungrouped.code, 'PERMISSION_DENIED');

    const unknown = await runtime.waitForInvocation(invocationId, { timeout_ms: 50 }, { callerAgentId: 'no_such_agent' });
    assert.equal(unknown.success, false, 'an unresolvable caller fails closed');
    assert.equal(unknown.code, 'PERMISSION_DENIED');

    const forgedFlags = await runtime.waitForInvocation(
      invocationId,
      { timeout_ms: 50 },
      { isPrivileged: true, isAdmin: true, callerRole: 'admin' }
    );
    assert.equal(forgedFlags.success, false, 'flag-only claims are unauthenticated');
    assert.equal(forgedFlags.code, 'PERMISSION_DENIED');

    const forgedPrincipal = await runtime.waitForInvocation(
      invocationId,
      { timeout_ms: 50 },
      { principal: { kind: 'agent', subject: 'director' } }
    );
    assert.equal(forgedPrincipal.success, false, 'a plain object cannot impersonate the director descriptor');
    assert.equal(forgedPrincipal.code, 'PERMISSION_DENIED');

    const forgedInternal = await runtime.waitForInvocation(
      invocationId,
      { timeout_ms: 50 },
      { principal: { kind: 'internal', subject: 'operator' } }
    );
    assert.equal(forgedInternal.success, false, 'a plain object cannot impersonate the internal principal');
    assert.equal(forgedInternal.code, 'PERMISSION_DENIED');

    const invoker = await runtime.waitForInvocation(invocationId, { timeout_ms: 200 }, { callerAgentId: 'r1_lead' });
    assert.equal(invoker.success, true, 'the invoker may await its own invocation');

    const target = await runtime.waitForInvocation(invocationId, { timeout_ms: 200 }, { callerAgentId: 'r1_worker' });
    assert.equal(target.success, true, 'the target may await its own invocation');

    const bypass = await runtime.waitForInvocation(invocationId, { timeout_ms: 200 }, { callerAgentId: 'director' });
    assert.equal(bypass.success, true, 'the director bypass may await any invocation');

    const host = await runtime.waitForInvocation(invocationId, { timeout_ms: 200 });
    assert.equal(host.success, true, 'the composition-root/host path keeps legacy behavior');
  } finally {
    runtime.destroy();
  }
});

test('10. the agent-facing lifecycle port is caller-scoped: unauthenticated and unrelated tool-path waits fail closed', async () => {
  const runtime = await createFixture();
  try {
    const receipt = runtime.invokeAgent({ invokerId: 'r1_lead', targetAgentId: 'r1_worker', prompt: 'collect report' });
    assert.equal(receipt.success, true);
    const invocationId = receipt.invocationId;
    const port = runtime.createLifecyclePort();

    const unauthenticated = await port.waitForInvocation([invocationId], { timeout_ms: 50 });
    assert.equal(unauthenticated.success, false, 'a port call with no caller identity must fail closed');
    assert.equal(unauthenticated.code, 'PERMISSION_DENIED');

    const scoped = await port.waitForInvocation([invocationId], { timeout_ms: 200 }, { callerAgentId: 'r1_lead' });
    assert.equal(scoped.success, true, 'an authenticated port call resolves for the invoker');

    // Tool path: forged caller params are caller data; the descriptor forwards
    // only the dispatcher-bound caller scope (r2_worker, a foreign realm), never
    // the per-call identity params, so the port authenticates the bound caller
    // and fails closed.
    const toolReceipt = await dispatcherFor(runtime, 'r2_worker').executeTool('wait_for_invocation', {
      invocation_ids: [invocationId],
      timeout_ms: 50,
      caller_agent_id: 'r1_lead',
      principal: { kind: 'internal' },
      isPrivileged: true
    });
    assert.equal(toolReceipt.success, false, 'forged per-call identity cannot authenticate a tool-path wait');
    assert.equal(toolReceipt.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 5. listAgents Realm-filter plumbing
// ============================================================================

test('11. listAgents realm filter and agent-facing port confinement; operator path stays unscoped', async () => {
  const runtime = await createFixture();
  try {
    const r1 = runtime.listAgents({ realmId: 'R1' }).map((agent) => agent.id).sort();
    assert.deepStrictEqual(r1, ['r1_child', 'r1_lead', 'r1_worker']);

    const generic = runtime.listAgents({ realmId: 'realm_generic' }).map((agent) => agent.id).sort();
    assert.deepStrictEqual(
      generic,
      ['loose_child', 'loose_lead', 'loose_worker', 'stranger'],
      'Wave R: launches without an explicit realm resolve the Generic default'
    );

    const nullScope = runtime.listAgents({ realmId: null }).map((agent) => agent.id).sort();
    assert.deepStrictEqual(
      nullScope,
      ['director'],
      'the null (ungrouped) scope is reserved for the director/system bootstrap'
    );

    assert.equal(runtime.listAgents().length, 10, 'the operator/store path stays unscoped');

    const port = runtime.createLifecyclePort();
    const scoped = port.listAgents({}, { callerAgentId: 'r1_worker' }).map((agent) => agent.id).sort();
    assert.deepStrictEqual(scoped, ['r1_child', 'r1_worker'], 'the agent-facing port listing is scope-local');

    const bypass = port.listAgents({}, { principal: directorAuthority(runtime) }).length;
    assert.equal(bypass, 10, 'the director bypass spans every Realm');

    assert.deepStrictEqual(
      port.listAgents({}, {}),
      [],
      'an unauthenticated agent-facing listing fails closed'
    );

    assert.equal(port.listAgents().length, 10, 'the port host path (no context) stays unscoped');
  } finally {
    runtime.destroy();
  }
});

test('12. realm membership is immutable: even the director identity cannot move a child out of its realm', async () => {
  const runtime = await createFixture();
  try {
    await runtime.launchAgent({
      config: { id: 'moved_child', allowedTools: ['list_agents'] },
      callerContext: { callerAgentId: 'r1_worker' }
    });
    const before = await dispatcherFor(runtime, 'r1_worker').executeTool('list_agents', {});
    assert.equal(visibleIds(before).includes('moved_child'), true, 'the creator sees its child before the attempt');

    // Wave R (ticket 56ba4b9): no caller moves membership — the strongest
    // identity (the hardcoded system director) is denied too, exact-id and all.
    assert.throws(
      () => runtime.updateAgentConfig('moved_child', { realmId: 'R2' }, { callerAgentId: 'director' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the system director identity cannot move an agent between realms'
    );

    const after = await dispatcherFor(runtime, 'r1_worker').executeTool('list_agents', {});
    assert.equal(visibleIds(after).includes('moved_child'), true, 'the child stays in its creator realm scope');
    assert.equal(runtime.getAgent('moved_child').config.realmId, 'R1', 'membership is untouched');

    const foreignRealm = await dispatcherFor(runtime, 'r2_lead').executeTool('list_agents', {});
    assert.equal(visibleIds(foreignRealm).includes('moved_child'), false, 'the child never becomes visible in another realm');
  } finally {
    runtime.destroy();
  }
});
