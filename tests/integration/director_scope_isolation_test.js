/**
 * @file tests/integration/director_scope_isolation_test.js
 * @description Realm wave R / ticket cf0e127 — the director is isolated by
 * SCOPE, never by director-specific rules:
 *   1. Invisibility matrix: realm-bound ordinary and root callers never see
 *      the director in `list_agents` (the director occupies the reserved
 *      system scope); the director sees everyone through `realmBypass`;
 *      anonymous callers receive `[]`; the operator/host path stays unscoped.
 *   2. Addressing matrix: a realm caller addressing `director` by exact id is
 *      denied fail-closed through `send_message`, `inline_file_in_message`,
 *      `invoke_agent`, `kill_agent`, and `restore_agent` — with no mailbox
 *      copy, no VirtualFS read, no dispatch, and no mutation.
 *   3. One-way mail: director -> realm agent delivers with the true sender
 *      identity (`from: director`); the reply path (agent -> director) is
 *      denied by scope; no sender masking anywhere.
 *   4. `wait_for_invocation`: realm peers cannot await director-related
 *      invocations; the invoker/target/bypass rule is unchanged.
 *
 * Real classes only (Zero-Mock Verification): a real `AgentRuntime` with real
 * substrates and the real engine/dispatcher seam; the only stub is the LLM
 * model.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { Agent } from '../../src/lib/sandbox/runtime/agent/index.ts';
import { ensureDirectorAgent } from '../../src/lib/sandbox/domain/directorAgent/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';

/** Tools granted to the ordinary fixture agents. */
const ORDINARY_TOOLS = Object.freeze([
  'list_agents',
  'send_message',
  'inline_file_in_message',
  'write_file',
  'kill_agent',
  'invoke_agent',
  'wait_for_invocation'
]);

/**
 * Minimal stream/complete mock model so invocation turns settle without a
 * provider network.
 *
 * @param {Function} fn - Response factory receiving the stream options.
 * @returns {object} Model-like object accepted by `launchAgent`.
 */
function createMockModel(fn) {
  const modelId = 'director-scope-model';
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'director-scope-provider',
      createModel: (id) => createMockModel(fn),
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
 * - director (system scope, `realmBypass`);
 * - realm `R1`: root `r1_root`, ordinary `r1_worker` + its child `r1_child`;
 * - realm `R2`: ordinary `r2_worker`.
 *
 * @returns {Promise<AgentRuntime>} Live runtime.
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const model = createMockModel(async () => ({ content: 'director-scope turn complete' }));
  await runtime.ensureDirector();
  const operator = directorAuthority(runtime);

  await runtime.launchAgent({ config: { id: 'r1_root', realmId: 'R1', privileged: true, allowedTools: ['*'] }, principal: operator, model });
  await runtime.launchAgent({ id: 'r1_worker', realmId: 'R1', allowedTools: [...ORDINARY_TOOLS], model });
  await runtime.launchAgent({
    config: { id: 'r1_child', allowedTools: ['list_agents'] },
    callerContext: { callerAgentId: 'r1_worker' },
    model
  });
  await runtime.launchAgent({ id: 'r2_worker', realmId: 'R2', allowedTools: [...ORDINARY_TOOLS], model });

  return runtime;
}

/**
 * Builds a dispatcher bound to one fixture agent, with the real substrates
 * injected exactly as the turn engine supplies them.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string|undefined} agentId - Bound caller identity.
 * @param {object} [virtualFs] - Optional VirtualFS override (recording proxy).
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, agentId, virtualFs) {
  return createSandboxToolDispatcher({
    runtime,
    ...(agentId ? { agentId } : {}),
    virtualFs: virtualFs || runtime.virtualFs,
    messagingBus: runtime.messagingBus
  });
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
// 1. Invisibility matrix (scope-local, no director clause)
// ============================================================================

test('1. realm callers never see the director; the director sees everyone; anonymous sees []', async () => {
  const runtime = await createFixture();
  try {
    const ordinary = await dispatcherFor(runtime, 'r1_worker').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(ordinary),
      ['r1_child', 'r1_worker'],
      'an ordinary realm caller sees self + children, never the director'
    );

    const root = await dispatcherFor(runtime, 'r1_root').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(root),
      ['r1_child', 'r1_root', 'r1_worker'],
      'a realm root caller sees same-scope members, never the system-director scope'
    );

    const foreign = await dispatcherFor(runtime, 'r2_worker').executeTool('list_agents', {});
    assert.deepStrictEqual(visibleIds(foreign), ['r2_worker'], 'another realm member stays invisible');

    const director = await dispatcherFor(runtime, 'director').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(director),
      ['director', 'r1_child', 'r1_root', 'r1_worker', 'r2_worker'],
      'the director spans every scope through its bypass'
    );

    const anonymous = createSandboxToolDispatcher({ runtime, allowedTools: ['list_agents'] });
    const anonymousReceipt = await anonymous.executeTool('list_agents', {});
    assert.equal(anonymousReceipt.success, true, `anonymous list failed: ${anonymousReceipt.error}`);
    assert.deepStrictEqual(anonymousReceipt.result, [], 'anonymous callers receive no descriptors');

    // The agent-facing lifecycle port uses the same scope-local predicate.
    const port = runtime.createLifecyclePort();
    const scoped = port.listAgents({}, { callerAgentId: 'r1_worker' }).map((agent) => agent.id).sort();
    assert.deepStrictEqual(scoped, ['r1_child', 'r1_worker'], 'the port listing is scope-local too');
    const hostPath = port.listAgents().map((agent) => agent.id).sort();
    assert.deepStrictEqual(
      hostPath,
      ['director', 'r1_child', 'r1_root', 'r1_worker', 'r2_worker'],
      'the operator/host port path (no context) stays unscoped'
    );
    assert.equal(runtime.listAgents().length, 5, 'the raw operator listing path is unaffected');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Addressing matrix — exact-id director attempts are denied by scope
// ============================================================================

test('2. realm callers are denied send_message/inline_file_in_message to the director (exact id)', async () => {
  const runtime = await createFixture();
  try {
    const directorMailboxBefore = runtime.messagingBus.getUnreadCount('director');
    const auditBefore = runtime.messagingBus.getAuditLog().length;

    for (const caller of ['r1_worker', 'r1_root']) {
      const denied = await dispatcherFor(runtime, caller).executeTool('send_message', {
        recipient: 'director',
        message: 'status report'
      });
      assert.equal(denied.success, false, `${caller} -> director must be denied`);
      assert.equal(denied.code, 'PERMISSION_DENIED');
      assert.equal(denied.messageId, undefined, 'no envelope id is minted for a denied send');
    }

    assert.equal(runtime.messagingBus.getUnreadCount('director'), directorMailboxBefore, 'no mailbox copy lands');
    assert.equal(runtime.messagingBus.getAuditLog().length, auditBefore, 'denied envelopes never enter the audit log');

    // Inline path: the denial precedes the VirtualFS read.
    const reads = [];
    const recordingFs = {
      readFile: (path, options) => {
        reads.push({ path, options });
        return runtime.virtualFs.readFile(path, options);
      },
      writeFile: (path, content, options) => runtime.virtualFs.writeFile(path, content, options)
    };
    const writer = dispatcherFor(runtime, 'r1_worker');
    const write = await writer.executeTool('write_file', { file_path: '/note.md', content: 'private-note' });
    assert.equal(write.success, true, `fixture write failed: ${write.error}`);

    const inline = await dispatcherFor(runtime, 'r1_worker', recordingFs).executeTool('inline_file_in_message', {
      file_path: '/note.md',
      recipient: 'director'
    });
    assert.equal(inline.success, false, 'r1_worker -> director inline must be denied');
    assert.equal(inline.code, 'PERMISSION_DENIED');
    assert.equal(reads.length, 0, 'a denied inline never reads VirtualFS content');
    assert.equal(runtime.messagingBus.getUnreadCount('director'), directorMailboxBefore);
  } finally {
    runtime.destroy();
  }
});

test('3. director mail reaches realms one-way with the true sender identity', async () => {
  const runtime = await createFixture();
  try {
    const receipt = await dispatcherFor(runtime, 'director').executeTool('send_message', {
      recipient: 'r1_worker',
      message: 'system directive'
    });
    assert.equal(receipt.success, true, `director -> realm mail failed: ${receipt.error}`);
    assert.equal(receipt.from, 'director', 'the envelope carries the true sender identity');

    const inbox = runtime.messagingBus.listInbox('r1_worker');
    assert.equal(inbox.length, 1, 'the realm agent receives the director mail');
    assert.equal(inbox[0].from, 'director', 'no sender masking in the stored envelope');

    const read = runtime.messagingBus.readMessage('r1_worker', receipt.messageId);
    assert.equal(read.success, true);
    assert.equal(read.message.from, 'director');
    assert.equal(read.message.content, 'system directive');

    // No reply path: the realm agent cannot answer the director by scope.
    const reply = await dispatcherFor(runtime, 'r1_worker').executeTool('send_message', {
      recipient: 'director',
      message: 'ack',
      in_reply_to: receipt.messageId
    });
    assert.equal(reply.success, false, 'a reply to the director is a cross-scope send and is denied');
    assert.equal(reply.code, 'PERMISSION_DENIED');
    assert.equal(runtime.messagingBus.getUnreadCount('director'), 0);
  } finally {
    runtime.destroy();
  }
});

test('4. realm callers are denied invoke_agent/kill_agent/restore_agent on the exact director id', async () => {
  const runtime = await createFixture();
  try {
    // invoke: wildcard realm authority does not reach the system scope.
    const invoke = await dispatcherFor(runtime, 'r1_root').executeTool('invoke_agent', {
      agent_id: 'director',
      prompt: 'take over'
    });
    assert.equal(invoke.success, false, 'a realm root caller cannot invoke the director');
    assert.equal(invoke.code, 'PERMISSION_DENIED');
    assert.equal(invoke.invocationId, undefined, 'no invocation is dispatched');

    // kill: the realm gate precedes authority for wildcard callers too.
    for (const caller of ['r1_worker', 'r1_root']) {
      const kill = await dispatcherFor(runtime, caller).executeTool('kill_agent', { agent_id: 'director' });
      assert.equal(kill.success, false, `${caller} cannot kill the director`);
      assert.equal(kill.code, 'PERMISSION_DENIED');
    }
    assert.equal(runtime.hasAgent('director'), true, 'the director survives every denied attempt');

    // restore: recycle the director through its own bypass identity, then a
    // realm caller's restore is denied by scope and nothing is restored.
    runtime.killAgent('director', 'fixture recycle for restore probe', { callerAgentId: 'director' });
    assert.equal(runtime.hasRecycledAgent('director'), true);
    assert.throws(
      () => runtime.restoreAgent('director', { callerAgentId: 'r1_root' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a realm root caller cannot restore the director across scopes'
    );
    assert.equal(runtime.hasRecycledAgent('director'), true, 'the denied restore leaves the record recycled');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 3. wait_for_invocation authorization
// ============================================================================

test('5. realm peers cannot await director-related invocations', async () => {
  const runtime = await createFixture();
  try {
    const dispatch = await dispatcherFor(runtime, 'director').executeTool('invoke_agent', {
      agent_id: 'r1_worker',
      prompt: 'collect report'
    });
    assert.equal(dispatch.success, true, `director invoke failed: ${dispatch.error}`);
    const invocationId = dispatch.invocationId;
    assert.ok(invocationId, 'the director bypass dispatches into a realm');

    const peer = await dispatcherFor(runtime, 'r2_worker').executeTool('wait_for_invocation', {
      invocation_ids: [invocationId],
      timeout_ms: 50
    });
    assert.equal(peer.success, false, 'a foreign realm peer cannot await the invocation');
    assert.equal(peer.code, 'PERMISSION_DENIED');

    const realmRoot = await dispatcherFor(runtime, 'r1_root').executeTool('wait_for_invocation', {
      invocation_ids: [invocationId],
      timeout_ms: 50
    });
    assert.equal(realmRoot.success, false, 'a same-realm root that is not invoker/target cannot await it');
    assert.equal(realmRoot.code, 'PERMISSION_DENIED');

    const target = await dispatcherFor(runtime, 'r1_worker').executeTool('wait_for_invocation', {
      invocation_ids: [invocationId],
      timeout_ms: 200
    });
    assert.equal(target.success, true, 'the target may await its own invocation');

    // Forged identity claims cannot turn a realm peer into the director; the
    // bound dispatcher identity wins.
    const forged = await dispatcherFor(runtime, 'r2_worker').executeTool(
      'wait_for_invocation',
      { invocation_ids: [invocationId], timeout_ms: 50 },
      { callerAgentId: 'director', principal: directorAuthority(runtime) }
    );
    assert.equal(forged.success, false, 'forged per-call claims never authenticate a wait');
    assert.equal(forged.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('6. the director\u2019s reserved system scope never coalesces with the legacy ungrouped scope', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = directorAuthority(runtime);
    // A legacy ungrouped root caller (no realm membership).
    await runtime.launchAgent({ config: { id: 'legacy_root', privileged: true, allowedTools: ['*'] }, principal: operator });

    const listed = await dispatcherFor(runtime, 'legacy_root').executeTool('list_agents', {});
    assert.deepStrictEqual(
      visibleIds(listed),
      ['legacy_root'],
      'an ungrouped root caller sees same-scope members, never the system-scope director'
    );

    const kill = await dispatcherFor(runtime, 'legacy_root').executeTool('kill_agent', { agent_id: 'director' });
    assert.equal(kill.success, false, 'the system scope is not the ungrouped scope: exact-id kill is denied');
    assert.equal(kill.code, 'PERMISSION_DENIED');
    assert.equal(runtime.hasAgent('director'), true, 'the director survives the denied cross-scope kill');

    // The raw operator listing path still includes the director.
    assert.equal(runtime.listAgents().length, 2, 'the operator/store path stays unscoped');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 4. Ordinary ids and ordinary adoption (Wave I, ticket c02d0b9)
// ============================================================================

test('7. every id is ordinary: a realm root may mint admin/system/director; only the engine bootstrap composes the grant', async () => {
  const runtime = await createFixture();
  try {
    // A realm-bound wildcard agent may claim any literal id. The launch is an
    // ordinary realm member: no privilege, no bypass, non-null realm.
    for (const ordinaryId of ['admin', 'system']) {
      const minted = await dispatcherFor(runtime, 'r1_root').executeTool('spawn_agent', {
        agent_id: ordinaryId,
        name: 'ordinary member',
        system_prompt: 'ordinary member',
        realmId: 'R1'
      });
      assert.equal(minted.success, true, `r1_root may mint the ordinary id '${ordinaryId}': ${minted.error}`);
      assert.ok(runtime.getAgent(ordinaryId), `'${ordinaryId}' registers as an ordinary agent`);
      const projection = runtime.createAgentIdentityPort().getAgentIdentity(ordinaryId);
      assert.equal(projection.realmBypass, false, `the literal id '${ordinaryId}' never carries the grant`);
      assert.equal(projection.realmId, 'R1', `the literal id '${ordinaryId}' stays realm-bound`);
    }

    // Free the director id through the director's own bypass identity and mint
    // it as an ordinary R1 member: the literal id carries no meaning.
    runtime.killAgent('director', 'fixture recycle for minting probe', { callerAgentId: 'director' });
    assert.equal(runtime.hasRecycledAgent('director'), true, 'fixture: the director is recycled');

    const ordinaryDirector = await dispatcherFor(runtime, 'r1_root').executeTool('spawn_agent', {
      agent_id: 'director',
      name: 'ordinary holder',
      system_prompt: 'ordinary holder',
      realmId: 'R1'
    });
    assert.equal(ordinaryDirector.success, true, `a recycled director id is ordinary and mintable: ${ordinaryDirector.error}`);
    const minted = runtime.createAgentIdentityPort().getAgentIdentity('director');
    assert.equal(minted.realmId, 'R1', 'the minted holder is realm-bound');
    assert.equal(minted.realmBypass, false, 'the minted literal id carries no bootstrap grant');

    // The engine bootstrap provisions only when the id is free: recycle the
    // ordinary holder, then the bootstrap composes the hardcoded grant and the
    // bootstrap-only null system scope.
    runtime.killAgent('director', 'free the id for the bootstrap', { callerAgentId: 'director' });
    assert.equal(runtime.hasAgent('director'), false, 'fixture: the ordinary holder is recycled');
    const rebuilt = await runtime.ensureDirector();
    assert.equal(rebuilt.id, 'director');
    assert.equal(rebuilt.config.privileged, true, 'the bootstrapped director carries the spec authority');
    const projection = runtime.createAgentIdentityPort().getAgentIdentity('director');
    assert.equal(projection.realmBypass, true, 'the bootstrapped director carries the hardcoded grant');
    assert.equal(projection.realmId, null, 'the system scope is the bootstrap-only null scope');
  } finally {
    runtime.destroy();
  }
});

test('8. ensureDirectorAgent adopts any live id-holder unchanged and re-provisions terminated/recycled holders', async () => {
  // A live id-holder is adopted as-is: no spec gate, no launch, no upgrade.
  const holder = new Agent({
    id: 'director',
    name: 'ordinary holder',
    role: 'ordinary',
    systemPrompt: 'ordinary holder'
  });
  const launches = [];
  const liveHost = {
    getAgent: (agentId) => (agentId === 'director' ? holder : null),
    launchAgent: async (config) => {
      launches.push(config);
      return new Agent(config);
    }
  };

  const adopted = await ensureDirectorAgent(liveHost);
  assert.strictEqual(adopted, holder, 'the live id-holder is adopted unchanged');
  assert.equal(launches.length, 0, 'adoption never re-provisions');
  assert.notStrictEqual(adopted.config.privileged, true, 'adoption never upgrades authority');

  // A terminated/recycled holder is re-provisioned from DIRECTOR_SPEC.
  const recycledHolder = new Agent({
    id: 'director',
    name: 'recycled holder',
    role: 'ordinary',
    systemPrompt: 'ordinary holder'
  });
  recycledHolder.state = 'recycled';
  const recycledHost = {
    getAgent: (agentId) => (agentId === 'director' ? recycledHolder : null),
    launchAgent: async (config) => {
      launches.push(config);
      return new Agent(config);
    }
  };

  const director = await ensureDirectorAgent(recycledHost);
  assert.equal(launches.length, 1, 'a recycled holder is re-provisioned');
  assert.notStrictEqual(director, recycledHolder, 'the recycled record is never adopted');
  assert.equal(director.id, 'director');
  assert.equal(director.config.privileged, true, 'the re-provisioned director is launched from DIRECTOR_SPEC');
  assert.equal(director.config.role, 'director', 'the re-provisioned director carries the spec role');
  assert.deepStrictEqual(launches[0].allowedTools, ['*'], 'the re-provisioned director carries the spec tool grant');
});
