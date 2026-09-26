/**
 * @file tests/integration/spawn_receipt_opacity_test.js
 * @description Integration coverage for ticket 550486c (Realm R4-F1): a
 * successful `spawn_agent` receipt must be a bounded public projection, never
 * a spread of the live `Agent` — so the caller's `config.realmId`, the raw
 * entity (`history`, `provider`, `model`, `modelConfig`, the whole `config`
 * object) and any internal realm vocabulary never reach agent-visible tool
 * history. Denial receipts stay opaque as well.
 *
 * Verifies through the real seam (zero mocks): the real `AgentRuntime`
 * turn-execution engine writes tool receipts into the manager's history; the
 * real dispatcher returns the same receipt object for denial and for
 * authority-pinned spawns. Realm opacity assertions follow WAVE_R §0.2
 * (no `realm:` string, no realm field, no realm identifier on any
 * agent-visible surface).
 *
 * Wave I (ticket d57cbc1, folding eab4e51) extends the same seam:
 * - a spawn/kill claim carrying internal realm vocabulary (`realm:`/`system:`
 *   shapes, the seeded Generic realm id) is refused at the tool boundary with
 *   a uniform `PERMISSION_DENIED` receipt that never echoes the claim;
 * - a withheld workspace label is omitted from receipts and listings instead
 *   of falling back to the raw id;
 * - the dispatcher binds the resolved caller's canonical identity key when a
 *   trusted `realmId` scope is bound, so two realms sharing one literal id
 *   resolve their own registrations (real VirtualFS partitions).
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';

/** Distinctive realm id: every receipt must stay free of this string. */
const REALM_ID = 'realm_spawn_opacity_probe';

/** A second realm referenced only through an engine-internal partition pin. */
const FOREIGN_REALM_KEY = 'realm:beta:global';

/** Internal realm vocabulary that must never appear in an agent-visible receipt. */
const REALM_VOCABULARY_PATTERN = /realm:/;

/** Realm scope fields that must never appear in an agent-visible receipt. */
const REALM_FIELD_PATTERN = /realmId|realm_id|realm_scope|realmScope|realmBypass|realm_bypass/;

/** Exact public key set of the projected successful spawn receipt. */
const PUBLIC_SPAWN_RECEIPT_KEYS = Object.freeze(['allowedTools', 'id', 'name', 'role', 'state', 'success', 'workspace']);

/** Entity-internal keys the projected receipt must never carry. */
const FORBIDDEN_RECEIPT_KEYS = Object.freeze(['config', 'history', 'provider', 'model', 'modelConfig', 'authority']);

/**
 * Builds a scripted model whose stream yields the supplied steps.
 * @param {Array<{content?: string, toolCalls?: Array<object>}>} script - Scripted turns.
 * @returns {object} A model bound to a scripted provider.
 */
function createScriptedModel(script) {
  let call = 0;
  const provider = {
    id: 'scripted-provider',
    createModel: () => model,
    getEndpointUrl: () => 'http://localhost/scripted',
    checkBalance: async () => ({ balance: 1 }),
    listModels: async () => [{ id: 'scripted-model', name: 'scripted-model' }]
  };
  const model = {
    id: 'scripted-model',
    config: {},
    provider,
    async *stream(options = {}) {
      const step = script[Math.min(call, script.length - 1)] || {};
      call += 1;
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      if (toolCalls.length > 0) yield { type: 'tool_call', toolCalls };
      yield { type: 'finish', finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop', content: step.content || '', toolCalls };
    },
    async complete() { return { content: 'complete' }; }
  };
  return model;
}

/**
 * Builds a canonical OpenAI-style tool call.
 * @param {string} id - Tool-call id.
 * @param {string} name - Canonical tool name.
 * @param {object} args - Tool arguments.
 * @returns {object} The tool-call envelope.
 */
function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

/**
 * Launches a realm-bound manager whose only tool is `spawn_agent`.
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {Array<object>} script - Scripted model steps.
 * @param {object} [config] - Extra config overrides.
 * @returns {Promise<void>} Resolves after launch.
 */
async function launchRealmManager(runtime, script, config = {}) {
  await runtime.launchAgent({
    config: { id: 'manager', realmId: REALM_ID, allowedTools: ['spawn_agent'], ...config },
    model: createScriptedModel(script)
  });
}

/**
 * Reads every tool-role receipt body out of an agent's history.
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} agentId - Agent whose history is read.
 * @returns {string[]} Raw serialized receipt contents.
 */
function toolHistoryContents(runtime, agentId) {
  return runtime.getAgent(agentId).history
    .filter((message) => message.role === 'tool')
    .map((message) => String(message.content));
}

/**
 * Asserts a serialized agent-visible receipt carries no realm vocabulary or scope fields.
 * @param {string} serialized - Serialized receipt under test.
 * @param {string} label - Assertion context label.
 */
function assertRealmOpaque(serialized, label) {
  assert.equal(REALM_VOCABULARY_PATTERN.test(serialized), false, `${label} must not contain 'realm:' vocabulary`);
  assert.equal(REALM_FIELD_PATTERN.test(serialized), false, `${label} must not contain realm scope fields`);
  assert.equal(serialized.includes(REALM_ID), false, `${label} must not contain the caller's realm identifier`);
}

test('550486c: a successful realm-bound spawn_agent receipt is projected and realm-opaque', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await launchRealmManager(runtime, [
      { toolCalls: [toolCall('t1', 'spawn_agent', { id: 'worker', name: 'Worker', role: 'worker' })] },
      { content: 'done' }
    ]);
    await runtime.executeAgentTurn('manager', 'go');

    const contents = toolHistoryContents(runtime, 'manager');
    assert.equal(contents.length, 1, 'exactly one spawn receipt is written to agent history');
    const serialized = contents[0];
    assertRealmOpaque(serialized, 'the successful spawn_agent receipt');

    const receipt = JSON.parse(serialized);
    assert.equal(receipt.success, true, 'the spawn succeeded');
    assert.equal(receipt.id, 'worker', 'the child id is reported');
    assert.equal(receipt.name, 'Worker', 'the child display name is reported');
    assert.equal(receipt.role, 'worker', 'the child role is reported');
    assert.equal(receipt.state, 'idle', 'the child lifecycle state is reported');
    assert.equal(receipt.workspace, 'worker', 'the child workspace stays the plain private key');
    assert.ok(Array.isArray(receipt.allowedTools), 'the effective tool policy is reported');
    assert.deepStrictEqual(
      Object.keys(receipt).sort(),
      [...PUBLIC_SPAWN_RECEIPT_KEYS].sort(),
      'the receipt exposes exactly the reduced public shape'
    );
    for (const key of FORBIDDEN_RECEIPT_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(receipt, key), false, `the receipt must not carry '${key}'`);
    }
  } finally {
    runtime.destroy();
  }
});

test('550486c: workspace pins are not model-facing; the realm-global label stays masked in listings', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
    await runtime.launchAgent({
      config: { id: 'root_manager', realmId: REALM_ID, privileged: true, allowedTools: ['spawn_agent', 'list_agents'] },
      principal: operator
    });

    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'root_manager' });
    // Ratified parameter surface (f41f838 follow-up): `workspace` is
    // authority-adjacent and stripped at the tool boundary, never forwarded to
    // the lifecycle, and reported in the model-visible warnings.
    const receipt = await dispatcher.executeTool('spawn_agent', {
      id: 'pinned_child',
      workspace: FOREIGN_REALM_KEY
    });
    assert.equal(receipt.success, true, `the spawn itself succeeds: ${receipt.error}`);
    assert.equal(receipt.workspace, 'pinned_child', 'the stripped pin leaves the child on its own private key');
    assert.deepStrictEqual(receipt.warnings, ["ignored unknown parameter 'workspace'"]);
    assertRealmOpaque(JSON.stringify(receipt), 'the spawn_agent receipt with a stripped pin');

    // The operator/host surface keeps explicit pinning; its projection stays
    // realm-opaque and masks the internal realm-global partition label.
    await runtime.launchAgent({
      config: { id: 'global_pinned_child', realmId: REALM_ID, workspace: FOREIGN_REALM_KEY, allowedTools: ['read_file'] },
      principal: operator
    });
    const listed = await dispatcher.executeTool('list_agents', {});
    const child = listed.result.find((entry) => entry.id === 'global_pinned_child');
    assert.ok(child, 'the pinned child is listed for its authority creator');
    assert.equal(child.workspace, 'global', 'the listing labels the realm-global workspace as global');
    assertRealmOpaque(JSON.stringify(listed.result), 'the list_agents result');
  } finally {
    runtime.destroy();
  }
});

test('550486c/eab4e51: authority-adjacent claims are stripped at the tool boundary without escalation', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await launchRealmManager(runtime, [{ content: 'unused' }]);

    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager' });
    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'priv_child', privileged: true });
    assert.equal(receipt.success, true, 'the privileged claim is not a model input; the spawn itself succeeds');
    assert.deepStrictEqual(receipt.warnings, ["ignored unknown parameter 'privileged'"]);
    assert.equal(runtime.getAgent('priv_child').config.privileged, false, 'the stripped claim never elevates the child');
    assertRealmOpaque(JSON.stringify(receipt), 'the stripped-claim spawn_agent receipt');

    // Defense in depth: the lifecycle's lifecycle-authority gate still denies a
    // direct (non-tool) escalation claim, and the denial stays realm-opaque.
    await assert.rejects(
      () => runtime.launchAgent({
        config: { id: 'direct_priv_child', privileged: true },
        callerContext: { callerAgentId: 'manager' }
      }),
      (err) => {
        assert.equal(err?.code, 'PERMISSION_DENIED');
        assertRealmOpaque(String(err?.message || ''), 'the direct privileged-spawn denial');
        return true;
      }
    );
    assert.equal(runtime.getAgent('direct_priv_child'), null);
  } finally {
    runtime.destroy();
  }
});

test('eab4e51/d57cbc1: a realm-vocabulary spawn claim is refused uniformly and never echoed', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await launchRealmManager(runtime, [{ content: 'unused' }], {
      allowedTools: ['spawn_agent', 'list_agents']
    });
    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager' });

    const refusals = [];
    for (const claimedId of [
      'realm:beta:worker',
      `realm:${REALM_ID}:worker`,
      'realm_generic',
      'system:director'
    ]) {
      const receipt = await dispatcher.executeTool('spawn_agent', { id: claimedId, name: 'Vocabulary Probe' });
      assert.equal(receipt.success, false, `the vocabulary id '${claimedId}' must be refused`);
      assert.equal(receipt.code, 'PERMISSION_DENIED', `the refusal of '${claimedId}' uses denial semantics`);
      assertRealmOpaque(JSON.stringify(receipt), `the refusal of '${claimedId}'`);
      // Bare-id listing: `runtime.getAgent('system:director')` would resolve
      // the director's canonical registry key, so mint detection compares the
      // registered bare ids instead.
      assert.equal(
        runtime.listAgents().some((agent) => agent.id === claimedId),
        false,
        `'${claimedId}' must never be minted`
      );
      assert.equal(runtime.getRecycledAgent(claimedId), null, `'${claimedId}' must never reach the recycle bin`);
      refusals.push(JSON.stringify(receipt));
    }
    assert.equal(
      new Set(refusals).size,
      1,
      'every vocabulary claim is refused with the identical uniform shape (no oracle)'
    );
    for (const serialized of refusals) {
      assert.equal(
        serialized.includes('Agent identifier is refused'),
        false,
        'the tool boundary refuses before the launch gate is reached'
      );
    }

    // The refusal is a boundary decision, not a state change: a plain spawn
    // still lands and the listing stays free of the vocabulary.
    const spawned = await dispatcher.executeTool('spawn_agent', { id: 'plain_child', name: 'Plain Child' });
    assert.equal(spawned.success, true, `a plain spawn still works: ${spawned.error}`);
    assertRealmOpaque(JSON.stringify(spawned), 'the plain spawn receipt');
    const listed = await dispatcher.executeTool('list_agents', {});
    assert.equal(listed.success, true);
    assert.ok(listed.result.some((entry) => entry.id === 'plain_child'), 'the plain child is listed');
    assertRealmOpaque(JSON.stringify(listed.result), 'the list_agents result');
  } finally {
    runtime.destroy();
  }
});

test('eab4e51/d57cbc1: a withheld workspace label is omitted from listings, never the raw key', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
    await runtime.launchAgent({
      config: { id: 'root_manager', realmId: REALM_ID, privileged: true, allowedTools: ['spawn_agent', 'list_agents'] },
      principal: operator
    });
    const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'root_manager' });

    // Tool-boundary: a realm-private pin is stripped, never forwarded.
    const stripped = await dispatcher.executeTool('spawn_agent', {
      id: 'pinned_private',
      workspace: 'realm:beta:private'
    });
    assert.equal(stripped.success, true, `the spawn itself succeeds: ${stripped.error}`);
    assert.equal(stripped.workspace, 'pinned_private', 'the child keeps its own plain private key');
    assert.deepStrictEqual(stripped.warnings, ["ignored unknown parameter 'workspace'"]);
    assertRealmOpaque(JSON.stringify(stripped), 'the stripped-pin spawn receipt');

    // The projection itself: an operator/host pin to a realm-scoped private
    // key (not the realm-global shape) must not fall back to the raw key as a
    // workspace label.
    await runtime.launchAgent({
      config: { id: 'direct_private', realmId: REALM_ID, workspace: 'realm:beta:private', allowedTools: ['read_file'] },
      principal: operator
    });
    const listed = await dispatcher.executeTool('list_agents', {});
    const child = listed.result.find((entry) => entry.id === 'direct_private');
    assert.ok(child, 'the pinned child is listed for its authority creator');
    assert.equal(
      Object.prototype.hasOwnProperty.call(child, 'workspace'),
      false,
      'the listing omits the withheld workspace field'
    );
    assertRealmOpaque(JSON.stringify(listed.result), 'the list_agents result');
  } finally {
    runtime.destroy();
  }
});

test('1829afd: whoami projects the workspace label and parent reference realm-opaquely', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
    const canonicalParent = createAgentIdentityKey(REALM_ID, 'opaque_parent');
    // Host/authority pins are the documented reachability path for a canonical
    // workspace key and an explicit canonical parent reference.
    await runtime.launchAgent({
      config: {
        id: 'whoami_global',
        realmId: REALM_ID,
        workspace: `realm:${REALM_ID}:global`,
        spawnedBy: canonicalParent,
        allowedTools: ['whoami']
      },
      principal: operator
    });
    await runtime.launchAgent({
      config: {
        id: 'whoami_private',
        realmId: REALM_ID,
        workspace: 'realm:beta:private',
        allowedTools: ['whoami']
      },
      principal: operator
    });

    const globalDispatcher = createSandboxToolDispatcher({
      runtime,
      agentId: 'whoami_global',
      realmId: REALM_ID
    });
    const globalWho = await globalDispatcher.executeTool('whoami', {});
    assert.equal(globalWho.success, true, `whoami must succeed: ${globalWho.error}`);
    assert.equal(globalWho.id, 'whoami_global', 'whoami keeps the bare registered id');
    assert.equal(
      globalWho.workspaceId,
      'global',
      'the realm-global workspace is labeled global, never the raw canonical key'
    );
    assert.equal(
      globalWho.spawnedBy,
      'opaque_parent',
      'a canonical parent reference projects to its bare registered id'
    );
    assertRealmOpaque(JSON.stringify(globalWho), 'the whoami receipt');

    const privateDispatcher = createSandboxToolDispatcher({
      runtime,
      agentId: 'whoami_private',
      realmId: REALM_ID
    });
    const privateWho = await privateDispatcher.executeTool('whoami', {});
    assert.equal(privateWho.success, true, `whoami must succeed: ${privateWho.error}`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(privateWho, 'workspaceId'),
      false,
      'a withheld workspace key is omitted from whoami, never echoed raw'
    );
    assertRealmOpaque(JSON.stringify(privateWho), 'the withheld-workspace whoami receipt');
  } finally {
    runtime.destroy();
  }
});

test('d57cbc1: the dispatcher binds the callerKey so same-id realm callers resolve exactly', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    // The same literal id in two realms: each registration owns a distinct
    // realm-qualified private workspace (I2-CORE + VFS keying).
    await runtime.launchAgent({ id: 'scout', realmId: 'alpha', allowedTools: ['write_file', 'read_file'] });
    await runtime.launchAgent({ id: 'scout', realmId: 'beta', allowedTools: ['write_file', 'read_file'] });

    const alpha = createSandboxToolDispatcher({
      runtime,
      agentId: 'scout',
      realmId: 'alpha',
      virtualFs: runtime.virtualFs
    });
    const beta = createSandboxToolDispatcher({
      runtime,
      agentId: 'scout',
      realmId: 'beta',
      virtualFs: runtime.virtualFs
    });

    const alphaWrite = await alpha.executeTool('write_file', { file_path: '/note.md', content: 'alpha-note' });
    assert.equal(alphaWrite.success, true, `the Alpha scout writes its own workspace: ${alphaWrite.error}`);
    const betaWrite = await beta.executeTool('write_file', { file_path: '/note.md', content: 'beta-note' });
    assert.equal(betaWrite.success, true, `the Beta scout writes its own workspace: ${betaWrite.error}`);

    const alphaRead = await alpha.executeTool('read_file', { file_path: '/note.md' });
    assert.equal(alphaRead.content, 'alpha-note', 'the Alpha scout reads its own bytes');
    const betaRead = await beta.executeTool('read_file', { file_path: '/note.md' });
    assert.equal(betaRead.content, 'beta-note', 'the Beta scout reads its own bytes');

    // Real partitions: two canonical keys, no bare-id partition.
    const snapshot = runtime.virtualFs.exportSnapshot({ principal: runtime.getOperatorPrincipal() });
    assert.equal(snapshot[createAgentIdentityKey('alpha', 'scout')]['/note.md'].content, 'alpha-note');
    assert.equal(snapshot[createAgentIdentityKey('beta', 'scout')]['/note.md'].content, 'beta-note');
    assert.equal(snapshot.scout, undefined, 'the same literal id never shares a bare-id partition');

    // Per-call identity claims (a forged callerKey and realm scope) are
    // pinned: the bound construction wins.
    const spoofed = await alpha.executeTool(
      'read_file',
      { file_path: '/note.md' },
      { callerKey: createAgentIdentityKey('beta', 'scout'), callerAgentId: 'scout', realmId: 'beta' }
    );
    assert.equal(spoofed.content, 'alpha-note', 'a forged per-call callerKey/realmId cannot select the other realm');

    // A bound realm scope with no matching registration fails closed.
    const unknown = createSandboxToolDispatcher({
      runtime,
      agentId: 'scout',
      realmId: 'gamma',
      virtualFs: runtime.virtualFs
    });
    const denied = await unknown.executeTool('read_file', { file_path: '/note.md' });
    assert.equal(denied.success, false, 'a realm scope with no matching registration fails closed');
    assert.equal(denied.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});
