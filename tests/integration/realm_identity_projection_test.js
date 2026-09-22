/**
 * @file tests/integration/realm_identity_projection_test.js
 * @description Realm wave A-1 (ticket f5d1ccc) + wave R (ticket 56ba4b9)
 *   end-to-end verification:
 *   1. Every runtime identity projection carries `realmId` + `realmBypass`;
 *      a launch without an explicit realm resolves the seeded Generic default
 *      (`realm_generic`, ticket 56ba4b9); bypass is the hardcoded system
 *      director only, while wildcard/privileged agents stay Realm-bound.
 *   2. Launch composition inherits the RESOLVED creator's Realm and ignores a
 *      caller-supplied `realmId` for a non-authority creator; a creator-less
 *      trusted launch without a value (or with an explicit null) resolves the
 *      Generic default, and `null` remains reserved for the director/system
 *      bootstrap.
 *   3. Realm membership is immutable for EVERY caller (Wave R): the injected
 *      internal principal, the hardcoded system director identity, wildcard
 *      agents, peers, and anonymous callers are all denied a change or clear;
 *      direct entity writes fail closed and denied moves leave membership
 *      untouched. Changing realms means terminate + relaunch.
 *   4. Realm membership persists/hydrates through runtime snapshot
 *      export/import (exported config + rebuilt projection); a persisted
 *      legacy null membership is retained verbatim.
 *   5. A realm-bound agent's worldClock sync targets `realm:<realmId>:global`
 *      through the real runtime (A0-3 behavior end-to-end); a Generic agent
 *      syncs its `realm:realm_generic:global` partition, cross-realm
 *      enumeration stays scoped, and the director bypass spans every partition.
 *
 * Real classes only (Zero-Mock Verification): a real `AgentRuntime` with real
 * substrates; no static source scraping.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';

/**
 * Resolves the bootstrapped system director's frozen authority descriptor: the
 * operator principal the store uses for lifecycle actions.
 *
 * @param {object} runtime - Real runtime instance.
 * @returns {object} Frozen director `AuthorityDescriptor`.
 */
function directorAuthority(runtime) {
  const identity = runtime.createAgentIdentityPort().getAgentIdentity('director');
  assert.ok(identity && identity.authority, 'the bootstrapped director must expose a frozen authority descriptor');
  return identity.authority;
}

/**
 * Parses a VFS snapshot's persisted `/world_clock.json` payload for a workspace.
 *
 * @param {object} vfsSnapshot - Snapshot from the runtime persistence port.
 * @param {string} workspaceId - Workspace partition key.
 * @returns {object|null} Parsed clock payload, or `null` when absent.
 */
function workspaceClock(vfsSnapshot, workspaceId) {
  const file = vfsSnapshot[workspaceId] && vfsSnapshot[workspaceId]['/world_clock.json'];
  return file ? JSON.parse(file.content) : null;
}

// ============================================================================
// 1. Projection Content
// ============================================================================

test('1. identity projections carry realm fields; bypass is the hardcoded director only', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'default_agent', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'realm_bound_agent', realmId: 'demo', allowedTools: ['read_file'] });
    await runtime.ensureDirector();
    const operator = directorAuthority(runtime);
    await runtime.launchAgent({
      config: { id: 'realm_wildcard', realmId: 'demo', privileged: true, allowedTools: ['*'] },
      principal: operator
    });

    const port = runtime.createAgentIdentityPort();

    const defaulted = port.getAgentIdentity('default_agent');
    assert.equal(defaulted.realmId, 'realm_generic', 'a launch without an explicit realm resolves the Generic default');
    assert.equal(defaulted.realmBypass, false, 'a Generic agent does not bypass');

    const bound = port.getAgentIdentity('realm_bound_agent');
    assert.equal(bound.realmId, 'demo');
    assert.equal(bound.realmBypass, false);

    const wildcard = port.getAgentIdentity('realm_wildcard');
    assert.equal(wildcard.realmId, 'demo', 'a wildcard agent keeps its resolved Realm');
    assert.equal(wildcard.realmBypass, false, 'agent authority — including the wildcard — never bypasses');
    assert.ok(wildcard.authority.allow.has('*'), 'the wildcard descriptor is otherwise intact');

    const director = port.getAgentIdentity('director');
    assert.equal(director.realmId, null);
    assert.equal(director.realmBypass, true, 'the hardcoded system director bypasses');
    assert.ok(director.authority.allow.has('*'), 'the director keeps its root descriptor');

    assert.equal(port.getAgentIdentity('no_such_agent'), null, 'unknown subjects resolve to null');

    // Every projection always carries both fields (required, never undefined).
    for (const id of ['default_agent', 'realm_bound_agent', 'realm_wildcard', 'director']) {
      const projection = port.getAgentIdentity(id);
      assert.notEqual(projection.realmId, undefined, `${id} projection carries realmId`);
      assert.equal(typeof projection.realmBypass, 'boolean', `${id} projection carries realmBypass`);
      assert.ok(Object.isFrozen(projection), `${id} projection stays frozen`);
    }
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 2. Launch Inheritance from the Resolved Creator
// ============================================================================

test('2. launch inherits the RESOLVED creator realm; caller-supplied realmId is ignored without authority', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'realm_a_lead', realmId: 'demo', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'default_lead', allowedTools: ['read_file'] });

    const inherited = await runtime.launchAgent({
      config: { id: 'realm_a_child', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'realm_a_lead' }
    });
    assert.equal(inherited.config.realmId, 'demo', 'a creator-bound launch inherits the resolved creator realm');
    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('realm_a_child').realmId,
      'demo',
      'the inherited membership reaches the identity projection'
    );

    const forged = await runtime.launchAgent({
      config: { id: 'realm_forged_child', realmId: 'other', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'realm_a_lead' }
    });
    assert.equal(
      forged.config.realmId,
      'demo',
      'an unprivileged creator cannot place a child in another Realm — the resolved creator wins'
    );

    const defaultedChild = await runtime.launchAgent({
      config: { id: 'default_child', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'default_lead' }
    });
    assert.equal(defaultedChild.config.realmId, 'realm_generic', 'a Generic creator passes the Generic default on');

    // Principal-less host/operator launch: the explicit realm is honored.
    await runtime.launchAgent({ id: 'host_realm_agent', realmId: 'ops', allowedTools: ['read_file'] });
    assert.equal(runtime.getAgent('host_realm_agent').config.realmId, 'ops');

    // Principal-less launch without a realm resolves the Generic default, and
    // an explicit null never creates an ungrouped non-director agent.
    await runtime.launchAgent({ id: 'host_default_agent', allowedTools: ['read_file'] });
    assert.equal(runtime.getAgent('host_default_agent').config.realmId, 'realm_generic');
    await runtime.launchAgent({ id: 'host_null_agent', realmId: null, allowedTools: ['read_file'] });
    assert.equal(runtime.getAgent('host_null_agent').config.realmId, 'realm_generic', 'null is reserved for the director/system bootstrap');

    // Authority path: the explicit realm is honored (and the operator stays free).
    await runtime.ensureDirector();
    const operator = directorAuthority(runtime);
    const operatorChild = await runtime.launchAgent({
      config: { id: 'operator_realm_child', realmId: 'ops', allowedTools: ['read_file'] },
      principal: operator
    });
    assert.equal(operatorChild.config.realmId, 'ops');
    assert.equal(runtime.getAgent('director').config.realmId, null, 'the director itself keeps the reserved null scope');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 3. Authority-Gated Realm Moves
// ============================================================================

test('3. realm membership is immutable for every caller; direct entity writes fail closed', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'realm_a_member', realmId: 'demo' });
    await runtime.launchAgent({ id: 'realm_a_peer', realmId: 'demo', allowedTools: ['read_file'] });
    await runtime.ensureDirector();
    const operator = directorAuthority(runtime);
    await runtime.launchAgent({
      config: { id: 'realm_wildcard', realmId: 'demo', privileged: true, allowedTools: ['*'] },
      principal: operator
    });

    // Entity-level direct writes cannot move an agent.
    const member = runtime.getAgent('realm_a_member');
    assert.throws(() => { member.config.realmId = 'other'; }, TypeError, 'config writes must fail closed');
    assert.throws(
      () => member.updateConfig({ realmId: 'other' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the entity channel denies realm moves'
    );
    assert.equal(runtime.getAgent('realm_a_member').config.realmId, 'demo', 'direct writes must not move the agent');

    // Unprivileged and anonymous manager updates are denied before mutation.
    assert.throws(
      () => runtime.updateAgentConfig('realm_a_member', { realmId: 'other' }, { callerAgentId: 'realm_a_peer' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'an unprivileged peer cannot move a same-realm member'
    );
    assert.throws(
      () => runtime.updateAgentConfig('realm_a_member', { realmId: 'other' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'an anonymous caller cannot move a member'
    );
    assert.equal(runtime.getAgent('realm_a_member').config.realmId, 'demo', 'denied moves leave membership untouched');
    assert.equal(runtime.createAgentIdentityPort().getAgentIdentity('realm_a_member').realmId, 'demo');

    // A privileged wildcard agent holds lifecycle authority but membership is
    // still immutable for it — as it is for EVERY caller, the injected
    // operator principal and the hardcoded system director identity included
    // (Wave R, ticket 56ba4b9). Changing realms means terminate + relaunch.
    assert.ok(
      runtime.createAgentIdentityPort().getAgentIdentity('realm_wildcard').authority.allow.has('*'),
      'the would-be mover holds the wildcard lifecycle grant'
    );
    const noMoveCallers = [
      { label: 'a wildcard peer', context: { callerAgentId: 'realm_wildcard' }, target: 'realm_a_member' },
      { label: 'a wildcard self', context: { callerAgentId: 'realm_wildcard' }, target: 'realm_wildcard' },
      { label: 'the injected operator principal', context: { principal: operator }, target: 'realm_a_member' },
      { label: 'the hardcoded system director identity', context: { callerAgentId: 'director' }, target: 'realm_a_member' }
    ];
    for (const move of noMoveCallers) {
      for (const patch of [{ realmId: 'other' }, { realmId: null }, { realmId: 'realm_generic' }]) {
        assert.throws(
          () => runtime.updateAgentConfig(move.target, patch, move.context),
          (err) => err?.code === 'PERMISSION_DENIED',
          `${move.label} must be denied ${JSON.stringify(patch)}`
        );
      }
    }
    assert.equal(runtime.getAgent('realm_wildcard').config.realmId, 'demo', 'denied wildcard moves leave membership untouched');
    assert.equal(runtime.getAgent('realm_a_member').config.realmId, 'demo');
    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('realm_a_member').realmId,
      'demo',
      'the identity projection is untouched by the denied moves'
    );

    // Non-realm authority fields keep the generic lifecycle-authority gate.
    const granted = runtime.updateAgentConfig('realm_a_peer', { privileged: true }, { callerAgentId: 'realm_wildcard' });
    assert.equal(granted.config.privileged, true, 'wildcard lifecycle authority still updates non-realm authority fields');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 4. Persistence Round-Trip
// ============================================================================

test('4. realm membership persists and hydrates through runtime snapshot export/import', async () => {
  const source = createAgentRuntime({ autoBootstrapDirector: false });
  await source.launchAgent({ id: 'realm_persist', realmId: 'persist_demo' });
  await source.launchAgent({ id: 'default_persist' });
  await source.ensureDirector();
  const snapshot = JSON.parse(JSON.stringify(source.exportSnapshot()));
  source.destroy();

  const exported = snapshot.agents.find((entry) => entry.id === 'realm_persist');
  assert.equal(exported.config.realmId, 'persist_demo', 'the exported config carries membership');

  // Hydration retention (Wave R): a persisted membership is a constraint, not
  // a grant — a legacy null membership is retained verbatim rather than
  // silently adopted into the Generic default.
  const legacyUnbound = snapshot.agents.find((entry) => entry.id === 'default_persist');
  legacyUnbound.config.realmId = null;

  const restored = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    restored.importSnapshot(snapshot);

    assert.equal(restored.getAgent('realm_persist').config.realmId, 'persist_demo', 'membership hydrates');
    assert.equal(
      restored.getAgent('default_persist').config.realmId,
      null,
      'a persisted legacy null membership hydrates verbatim (retention unchanged)'
    );
    assert.equal(
      restored.createAgentIdentityPort().getAgentIdentity('director').realmId,
      null,
      'the system bootstrap hydrates its null scope (engine-composed body, null projection)'
    );

    const projection = restored.createAgentIdentityPort().getAgentIdentity('realm_persist');
    assert.equal(projection.realmId, 'persist_demo', 'the rebuilt projection carries hydrated membership');
    assert.equal(projection.realmBypass, false);

    // A re-export keeps the membership (the persistence chain is stable).
    const reExported = JSON.parse(JSON.stringify(restored.exportSnapshot()));
    assert.equal(
      reExported.agents.find((entry) => entry.id === 'realm_persist').config.realmId,
      'persist_demo',
      'membership survives re-export'
    );
  } finally {
    restored.destroy();
  }
});

// ============================================================================
// 5. End-to-End WorldClock Wiring (A0-3 Behavior Through the Real Runtime)
// ============================================================================

test('5. a realm-bound agent\u2019s worldClock sync targets realm:<realmId>:global through the real runtime', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = directorAuthority(runtime);
    const launchPrivileged = (id, realmId) => runtime.launchAgent({
      config: {
        id,
        ...(realmId ? { realmId } : {}),
        privileged: true,
        allowedTools: ['world_clock', 'event_list']
      },
      principal: operator
    });
    await launchPrivileged('realm_a_lead', 'demo');
    await launchPrivileged('realm_b_lead', 'other');
    await launchPrivileged('default_lead', null);

    const clock = runtime.worldClock;
    const setA = clock.setTime(
      { totalSeconds: 7200, date: 'Day 1 Noon', targetAgentId: 'global' },
      { callerAgentId: 'realm_a_lead' }
    );
    assert.equal(setA.success, true);
    assert.equal(setA.agentId, 'realm:demo:global', 'a realm-bound caller\u2019s global partition is its realm key');

    const setB = clock.setTime(
      { totalSeconds: 3600, date: 'Day 1', targetAgentId: 'global' },
      { callerAgentId: 'realm_b_lead' }
    );
    assert.equal(setB.agentId, 'realm:other:global');

    const setDefaulted = clock.setTime(
      { totalSeconds: 100, date: 'Generic Day', targetAgentId: 'global' },
      { callerAgentId: 'default_lead' }
    );
    assert.equal(
      setDefaulted.agentId,
      'realm:realm_generic:global',
      'a launch without an explicit realm resolves the Generic partition (Wave R)'
    );

    // The real VFS sync targets are visible through the engine-authorized
    // persistence port: each realm syncs only to its own realm-global workspace.
    const vfsSnapshot = runtime.createPersistencePort().virtualFs.exportSnapshot();
    const realmAClock = workspaceClock(vfsSnapshot, 'realm:demo:global');
    const realmBClock = workspaceClock(vfsSnapshot, 'realm:other:global');
    const genericClock = workspaceClock(vfsSnapshot, 'realm:realm_generic:global');
    assert.ok(realmAClock, 'the realm A partition syncs to realm:demo:global');
    assert.equal(realmAClock.agentId, 'realm:demo:global');
    assert.equal(realmAClock.totalSeconds, 7200);
    assert.ok(realmBClock, 'the realm B partition syncs to realm:other:global');
    assert.equal(realmBClock.totalSeconds, 3600, 'realm B is untouched by the realm A sync');
    assert.ok(genericClock, 'the Generic partition syncs to realm:realm_generic:global');
    assert.equal(genericClock.totalSeconds, 100, 'the Generic partition is untouched by realm syncs');

    // Enumeration stays scoped for a realm-bound wildcard agent; the director
    // (realmBypass) spans every partition — the operator/director-only rule.
    const leaderClocks = clock.getAllClocks({ callerAgentId: 'realm_a_lead' });
    assert.ok('realm:demo:global' in leaderClocks, 'the realm-global clock is enumerated');
    assert.equal('realm:other:global' in leaderClocks, false, 'another realm\u2019s partition is not enumerated');
    assert.equal('realm:realm_generic:global' in leaderClocks, false, 'the Generic partition is not enumerated for a realm-bound caller');
    assert.equal('global' in leaderClocks, false, 'the legacy global partition is not enumerated for a realm-bound caller');

    const directorClocks = clock.getAllClocks({ callerAgentId: 'director' });
    assert.ok('realm:demo:global' in directorClocks, 'the director bypass spans realm A');
    assert.ok('realm:other:global' in directorClocks, 'the director bypass spans realm B');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 6. Workspace-Key Projection (Realm wave R, ticket 59e4673)
// ============================================================================

/**
 * Builds a scripted model whose Nth stream call replays `script[N]`.
 *
 * @param {Array<object>} script - Per-call response plans.
 * @returns {object} Model-like object accepted by `launchAgent`.
 */
function createScriptedModel(script) {
  let call = 0;
  const provider = {
    id: 'projection-scripted-provider',
    createModel: () => model,
    getEndpointUrl: () => 'http://localhost/scripted',
    checkBalance: async () => ({ balance: 1 }),
    listModels: async () => [{ id: 'projection-scripted-model', name: 'projection-scripted-model' }]
  };
  const model = {
    id: 'projection-scripted-model',
    config: {},
    provider,
    async *stream(options = {}) {
      const step = script[Math.min(call, script.length - 1)] || {};
      call += 1;
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      if (typeof step.content === 'string' && step.content) {
        if (typeof options.onChunk === 'function') {
          try { options.onChunk({ type: 'text', content: step.content }); } catch { /* ignore */ }
        }
        yield { type: 'text', content: step.content };
      }
      if (toolCalls.length > 0) {
        yield { type: 'tool_call', toolCalls };
      }
      yield {
        type: 'finish',
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        content: step.content || '',
        toolCalls
      };
    },
    async complete() {
      return { content: 'complete' };
    }
  };
  return model;
}

/**
 * Creates a scripted OpenAI-style tool call.
 *
 * @param {string} id - Tool call id.
 * @param {string} name - Canonical tool name.
 * @param {object} args - Tool arguments.
 * @returns {object} Tool call envelope.
 */
function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/**
 * Extracts the JSON-parsed tool result messages from an agent's history.
 *
 * @param {object} runtime - Real runtime instance.
 * @param {string} agentId - Agent whose history is inspected.
 * @returns {Array<{content: string, parsed: object|null}>} Tool results.
 */
function toolResults(runtime, agentId) {
  const agent = runtime.getAgent(agentId);
  assert.ok(agent, `agent '${agentId}' exists`);
  return agent.history
    .filter((message) => message.role === 'tool')
    .map((message) => {
      try {
        return { content: String(message.content), parsed: JSON.parse(String(message.content)) };
      } catch {
        return { content: String(message.content), parsed: null };
      }
    });
}

/**
 * Builds the custom-workspace fixture: `custom_agent` (explicit
 * `workspaceId: 'custom_ws'`) and the ordinary peer `default_agent`.
 *
 * @returns {Promise<object>} Live runtime.
 */
async function createWorkspaceFixture() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  await runtime.launchAgent({
    config: {
      id: 'custom_agent',
      realmId: 'demo',
      workspaceId: 'custom_ws',
      allowedTools: ['write_file', 'inline_file_in_message', 'read_file']
    },
    model: createScriptedModel([
      {
        content: '',
        toolCalls: [
          toolCall('w1', 'write_file', { file_path: '/note.md', content: 'custom-note' }),
          toolCall('w2', 'write_file', { file_path: '/global/lore.md', content: 'shared-lore' }),
          toolCall('i1', 'inline_file_in_message', { file_path: '/note.md', recipient: 'custom_agent' }),
          toolCall('i2', 'inline_file_in_message', { file_path: '/global/lore.md', recipient: 'custom_agent' })
        ]
      },
      { content: 'done' }
    ])
  });
  await runtime.launchAgent({
    config: { id: 'default_agent', realmId: 'demo', allowedTools: ['read_file'] },
    model: createScriptedModel([
      {
        content: '',
        toolCalls: [toolCall('p1', 'read_file', { file_path: '/agents/custom_agent/note.md' })]
      },
      { content: 'done' }
    ])
  });
  return runtime;
}

test('6. the identity projection carries the resolved workspace key (59e4673)', async () => {
  const runtime = await createWorkspaceFixture();
  try {
    // The projection is trusted construction output: the resolved private
    // workspace key rides alongside realmId/realmBypass.
    const port = runtime.createAgentIdentityPort();
    const customProjection = port.getAgentIdentity('custom_agent');
    assert.equal(customProjection.workspaceId, 'custom_ws', 'a custom workspace key is projected');
    assert.equal(customProjection.realmId, 'demo');
    assert.ok(Object.isFrozen(customProjection), 'the projection stays frozen');
    assert.equal(
      port.getAgentIdentity('default_agent').workspaceId,
      'default_agent',
      'a default-key agent projects its plain id'
    );
  } finally {
    runtime.destroy();
  }
});

test('7. custom-workspace inline private + shared reads resolve; cross-agent private stays denied (59e4673)', async () => {
  const runtime = await createWorkspaceFixture();
  try {
    await runtime.executeAgentTurn('custom_agent', 'go');
    const results = toolResults(runtime, 'custom_agent');
    assert.equal(results.length, 4, 'all four file tool calls produced receipts');
    const [privateWrite, sharedWrite, privateInline, sharedInline] = results;
    assert.equal(privateWrite.parsed.success, true, `private write failed: ${privateWrite.parsed.error}`);
    assert.equal(sharedWrite.parsed.success, true, `shared write failed: ${sharedWrite.parsed.error}`);
    assert.equal(privateInline.parsed.success, true, `custom-workspace private inline failed: ${privateInline.parsed.error}`);
    assert.equal(sharedInline.parsed.success, true, `custom-workspace shared inline failed: ${sharedInline.parsed.error}`);

    // Private and shared bytes both land in the caller's own mailbox, and the
    // receipts/envelopes stay realm-opaque.
    const privateMail = runtime.messagingBus.readMessage('custom_agent', privateInline.parsed.messageId);
    const sharedMail = runtime.messagingBus.readMessage('custom_agent', sharedInline.parsed.messageId);
    assert.equal(privateMail.success, true, 'the private inline envelope is readable');
    assert.equal(sharedMail.success, true, 'the shared inline envelope is readable');
    assert.ok(String(privateMail.message.content).includes('custom-note'), 'private bytes inlined');
    assert.ok(String(sharedMail.message.content).includes('shared-lore'), 'shared bytes inlined');
    const serialized = JSON.stringify(results.map((entry) => entry.content))
      + JSON.stringify([privateMail.message, sharedMail.message]);
    assert.equal(/realm:/.test(serialized), false, 'no agent-visible receipt or envelope exposes a realm key');

    // Cross-agent private read stays denied for an ordinary peer.
    await runtime.executeAgentTurn('default_agent', 'go');
    const probe = toolResults(runtime, 'default_agent').find((entry) => entry.parsed && entry.parsed.success === false);
    assert.ok(probe, 'the peer mount attempt is denied');
    assert.equal(probe.parsed.code, 'PERMISSION_DENIED');
    assert.equal(/realm:/.test(String(probe.parsed.error)), false, 'the denial is realm-opaque');
  } finally {
    runtime.destroy();
  }
});
