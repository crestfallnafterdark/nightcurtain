/**
 * @file tests/integration/realm_tool_scope_conformance_test.js
 * @description Realm wave R / ticket abc8e83 — the all-tool realm-scope
 *   conformance sweep (WAVE_R §7). Guard rail for the whole wave and for every
 *   future canonical tool:
 *
 *   1. Classification table over all 35 canonical tools
 *      (`realm-scope-denied` / `self-only` / `static`), derived mechanically
 *      from `ALL_TOOL_DESCRIPTORS` and cross-checked against the
 *      `SANDBOX_TOOLS` enumeration. A tool without a classification — or a
 *      classification entry without a canonical tool — fails with the names.
 *   2. Correct-id adversarial matrix with a real runtime (realms A/B + system
 *      scope): every cross-scope attempt by the exact correct id is denied and
 *      does not disclose bytes or realm vocabulary, across mail (including
 *      `to: 'all'` fan-out), invocation, await, kill/restore, all 11 VFS
 *      mounts (`/agents/<id>`), `batch_precall` nesting, schedules, and
 *      clock/event targets.
 *   3. Opacity sweep: representative agent-visible receipts of every tool
 *      (two realm scopes, including the Generic default), serialized and
 *      asserted free of the internal `realm:` vocabulary, realm scope fields
 *      (`realmId`/`realm_id`/…), and every realm identifier — including error
 *      text and listing metadata.
 *   4. Director sweep: the director (system scope) is never exposed in
 *      agent-visible listings, and addressing it by exact id is denied on
 *      every applicable tool.
 *   5. Realm-model sweep: no agent-visible move path, every non-director agent
 *      resolves to a realm (Generic default), and generated ids are
 *      realm-free.
 *
 * Zero-Mock Verification: every check runs against real `AgentRuntime` /
 * `SandboxStore` / `VirtualFS` / `MessagingBus` / scheduler / clock class
 * instances; the only stub is the LLM stream used to settle invoked turns.
 *
 * Exclusion (closed by Wave I, ticket d57cbc1; folded defect eab4e51):
 * caller-input echoes are blocking opacity assertions. A denied call must not
 * repeat a caller-supplied `realm:<id>:global` workspace claim (or any
 * realm-vocabulary id) in its error text — the tool boundary sanitizes such
 * denials to a uniform phrase. The uniform-denial property is pinned as well:
 * identical attempts against different claimed keys fail with the same shape
 * and register nothing. Engine-originated realm vocabulary is always blocking.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { ALL_TOOL_DESCRIPTORS } from '../../src/lib/sandbox/tools/descriptors/index.ts';
import { SANDBOX_TOOLS } from '../../src/lib/sandbox/tools/constants/index.ts';
import { GENERIC_REALM_ID, createSandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { DEMO_TEMPLATE, materializeTemplate } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { sharedLocalStorage } from '../test_env.js';

// ============================================================================
// Classification table (all 35 canonical tools)
// ============================================================================

/** Category: the tool has a cross-scope target surface; exact-id cross-scope attempts are denied. */
const CATEGORY_SCOPE_DENIED = 'realm-scope-denied';
/** Category: the tool resolves exclusively to the bound caller (no target identity). */
const CATEGORY_SELF_ONLY = 'self-only';
/** Category: the tool has no identity/scope dimension at all; caller-invariant. */
const CATEGORY_STATIC = 'static';

const KNOWN_CATEGORIES = Object.freeze([CATEGORY_SCOPE_DENIED, CATEGORY_SELF_ONLY, CATEGORY_STATIC]);

/** The 12 canonical Virtual Filesystem tools that resolve `/agents/<id>` mounts. */
const VFS_TOOL_NAMES = Object.freeze([
  'read_file',
  'write_file',
  'replace_file_content',
  'copy_file',
  'delete_file',
  'list_files',
  'write_json',
  'query_json',
  'json_patch',
  'grep',
  'set_permissions',
  'concat_files'
]);

/**
 * Frozen per-tool classification, keyed by canonical tool name. Every
 * canonical tool must appear exactly once; the classification test fails with
 * the names of any unclassified (or stale) entries.
 */
const TOOL_CLASSIFICATION = Object.freeze({
  // --- realm/scope-denied (25) ---
  // Every VFS tool resolves `/agents/<id>/...` mounts, so cross-scope targets
  // must be denied for the whole family.
  read_file: CATEGORY_SCOPE_DENIED,
  write_file: CATEGORY_SCOPE_DENIED,
  replace_file_content: CATEGORY_SCOPE_DENIED,
  copy_file: CATEGORY_SCOPE_DENIED,
  delete_file: CATEGORY_SCOPE_DENIED,
  list_files: CATEGORY_SCOPE_DENIED,
  write_json: CATEGORY_SCOPE_DENIED,
  query_json: CATEGORY_SCOPE_DENIED,
  json_patch: CATEGORY_SCOPE_DENIED,
  grep: CATEGORY_SCOPE_DENIED,
  set_permissions: CATEGORY_SCOPE_DENIED,
  concat_files: CATEGORY_SCOPE_DENIED,
  send_message: CATEGORY_SCOPE_DENIED,
  inline_file_in_message: CATEGORY_SCOPE_DENIED,
  // spawn_agent: a live same-realm id is still denied; the same literal id in
  // another realm is legal and mints realm-locally (Wave I, ticket d57cbc1).
  spawn_agent: CATEGORY_SCOPE_DENIED,
  kill_agent: CATEGORY_SCOPE_DENIED,
  list_agents: CATEGORY_SCOPE_DENIED,
  invoke_agent: CATEGORY_SCOPE_DENIED,
  wait_for_invocation: CATEGORY_SCOPE_DENIED,
  schedule: CATEGORY_SCOPE_DENIED,
  list_schedules: CATEGORY_SCOPE_DENIED,
  cancel_schedule: CATEGORY_SCOPE_DENIED,
  world_clock: CATEGORY_SCOPE_DENIED,
  event_list: CATEGORY_SCOPE_DENIED,
  batch_precall: CATEGORY_SCOPE_DENIED,
  // --- self-only (9) ---
  wait_for_mail: CATEGORY_SELF_ONLY,
  list_inbox: CATEGORY_SELF_ONLY,
  read_message: CATEGORY_SELF_ONLY,
  get_archive: CATEGORY_SELF_ONLY,
  get_inbox: CATEGORY_SELF_ONLY,
  drain_inbox: CATEGORY_SELF_ONLY,
  whoami: CATEGORY_SELF_ONLY,
  undo_turn: CATEGORY_SELF_ONLY,
  get_current_time: CATEGORY_SELF_ONLY,
  // --- static (1) ---
  describe_tool: CATEGORY_STATIC
});

/**
 * Schema property names that would make a `self-only`/`static` tool a
 * cross-agent target surface. `self-only` tools may declare caller-local
 * selectors (`message_id`, `target_turn_id`, `sender` filter) but never a
 * routing/target property.
 */
const CROSS_TARGET_SCHEMA_KEYS = Object.freeze([
  'recipient',
  'agent_id',
  'target_agent_id',
  'file_path',
  'src_path',
  'dest_path',
  'dir_path',
  'path_prefix',
  'task_id'
]);

/** Fixture realm identifiers: distinctive so receipt scans cannot false-positive. */
const ALPHA = 'realm_alpha_conformance';
const BETA = 'realm_beta_conformance';

/** Caller-supplied realm claim used to prove tool-level membership spoofs are inert. */
const REALM_HIJACK = 'realm_hijack_claim';

/** Internal realm partition vocabulary that must never reach an agent-visible receipt. */
const REALM_VOCABULARY_PATTERN = /realm:/;

/** Realm scope fields that must never appear in an agent-visible receipt. */
const REALM_FIELD_PATTERN = /realmId|realm_id|realm_scope|realmScope|realmBypass|realm_bypass/;

/** Tools granted to the ordinary fixture agents. */
const ORDINARY_TOOLS = Object.freeze([
  'list_agents',
  'send_message',
  'inline_file_in_message',
  'write_file',
  'read_file',
  'list_files',
  'kill_agent',
  'invoke_agent',
  'wait_for_invocation',
  'list_inbox',
  'get_inbox',
  'drain_inbox',
  'get_archive',
  'read_message',
  'wait_for_mail',
  'schedule',
  'list_schedules',
  'cancel_schedule',
  'world_clock',
  'event_list',
  'get_current_time',
  'whoami',
  'undo_turn',
  'describe_tool',
  'batch_precall'
]);

/**
 * Derives the canonical tool list from the runtime descriptors at test time
 * (never a stale hardcoded list) and cross-checks it against the canonical
 * `SANDBOX_TOOLS` enumeration.
 *
 * @returns {string[]} Sorted canonical tool names.
 */
function canonicalTools() {
  return ALL_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name).sort();
}

/** Module-level coverage ledger: scope-denied tools actually exercised by the matrix. */
const matrixCoveredTools = new Set();
/** Module-level coverage ledger: canonical tools executed at least once by the sweep. */
const executedTools = new Set();

/**
 * Asserts a serialized agent-visible receipt carries no engine realm
 * vocabulary, no realm scope field, and no realm identifier.
 *
 * @param {string} serialized - Serialized receipt under test.
 * @param {string} label - Assertion context label.
 */
function assertRealmOpaque(serialized, label) {
  assert.equal(
    REALM_VOCABULARY_PATTERN.test(serialized),
    false,
    `${label} must not contain the internal 'realm:' vocabulary`
  );
  assert.equal(
    REALM_FIELD_PATTERN.test(serialized),
    false,
    `${label} must not contain a realm scope field`
  );
  for (const realmId of [ALPHA, BETA, GENERIC_REALM_ID]) {
    assert.equal(serialized.includes(realmId), false, `${label} must not contain realm identifier '${realmId}'`);
  }
}

/**
 * Minimal stream/complete model stub so invoked turns settle without a
 * provider network (the only stub; every engine class is real).
 *
 * @param {Function} fn - Response factory receiving the stream options.
 * @returns {object} Model-like object accepted by `launchAgent`.
 */
function createMockModel(fn) {
  const modelId = 'realm-conformance-model';
  return {
    id: modelId,
    config: {},
    provider: {
      id: 'realm-conformance-provider',
      createModel: () => createMockModel(fn),
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
 * trusted operator principal used by host launches).
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
 * Resolves a launched agent's frozen registry authority descriptor.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} agentId - Launched agent id.
 * @returns {object} Frozen `AuthorityDescriptor`.
 */
function agentAuthority(runtime, agentId) {
  const identity = runtime.createAgentIdentityPort().getAgentIdentity(agentId);
  assert.ok(identity && identity.authority, `'${agentId}' must expose a frozen authority descriptor`);
  return identity.authority;
}

/**
 * Builds a dispatcher bound to one fixture agent with the real substrates
 * injected exactly as the turn engine supplies them.
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} agentId - Bound caller identity.
 * @param {object} [extra] - Optional substrate overrides (e.g. a recording VFS).
 * @returns {Function} Bound tool dispatcher.
 */
function dispatcherFor(runtime, agentId, extra = {}) {
  return createSandboxToolDispatcher({
    runtime,
    agentId,
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    worldClock: runtime.worldClock,
    ...extra
  });
}

/**
 * Builds the realm fixture through real launches:
 * - director (system scope, `realmBypass`);
 * - realm A: root `alpha_root` (privileged wildcard), ordinary `alpha_worker`,
 *   ordinary grandchild `alpha_child`;
 * - realm B: ordinary `beta_worker`.
 *
 * Every agent carries the mock model so any provoked turn settles locally.
 *
 * @returns {Promise<{runtime: AgentRuntime, operator: object}>} Live fixture.
 */
async function createRealmFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const model = createMockModel(async () => ({ content: 'realm conformance turn complete' }));
  await runtime.ensureDirector();
  const operator = directorAuthority(runtime);

  await runtime.launchAgent({
    config: { id: 'alpha_root', realmId: ALPHA, privileged: true, allowedTools: ['*'] },
    principal: operator,
    model
  });
  await runtime.launchAgent({ id: 'alpha_worker', realmId: ALPHA, allowedTools: [...ORDINARY_TOOLS], model });
  await runtime.launchAgent({
    config: { id: 'alpha_child', realmId: ALPHA, allowedTools: ['read_file', 'list_inbox', 'send_message', 'wait_for_mail'] },
    callerContext: { callerAgentId: 'alpha_worker' },
    model
  });
  await runtime.launchAgent({ id: 'beta_worker', realmId: BETA, allowedTools: [...ORDINARY_TOOLS], model });
  return { runtime, operator };
}

/**
 * Reads one sanitized schedule-status view from the engine-level export
 * surface (independent of principal visibility scoping).
 *
 * @param {AgentRuntime} runtime - Live runtime.
 * @param {string} timerId - Timer id.
 * @returns {string|null} Scheduler status, or `null` when unknown.
 */
function timerStatus(runtime, timerId) {
  const entry = runtime.exportSchedules().find((schedule) => (schedule.timerId || schedule.id) === timerId);
  return entry ? entry.status : null;
}

// ============================================================================
// 1. Classification table
// ============================================================================

test('1. every canonical tool is classified exactly once (fails with unclassified names)', () => {
  const canonical = canonicalTools();
  const enumeration = Object.values(SANDBOX_TOOLS).sort();

  assert.deepStrictEqual(
    canonical,
    enumeration,
    'ALL_TOOL_DESCRIPTORS and the SANDBOX_TOOLS enumeration must describe the same canonical set'
  );
  assert.equal(
    new Set(canonical).size,
    canonical.length,
    'the canonical descriptor list must not contain duplicate tool names'
  );

  const canonicalSet = new Set(canonical);
  const unclassified = canonical.filter((name) => !Object.prototype.hasOwnProperty.call(TOOL_CLASSIFICATION, name));
  assert.deepStrictEqual(
    unclassified,
    [],
    `unclassified canonical tool(s): ${unclassified.join(', ')} — add each to TOOL_CLASSIFICATION`
  );

  const stale = Object.keys(TOOL_CLASSIFICATION).filter((name) => !canonicalSet.has(name)).sort();
  assert.deepStrictEqual(
    stale,
    [],
    `TOOL_CLASSIFICATION entries without a canonical tool: ${stale.join(', ')}`
  );

  const invalid = Object.entries(TOOL_CLASSIFICATION)
    .filter(([, category]) => !KNOWN_CATEGORIES.includes(category))
    .map(([name]) => name)
    .sort();
  assert.deepStrictEqual(invalid, [], `tool(s) with an unknown category: ${invalid.join(', ')}`);

  const counts = {};
  for (const category of KNOWN_CATEGORIES) {
    counts[category] = canonical.filter((name) => TOOL_CLASSIFICATION[name] === category).length;
  }
  assert.deepStrictEqual(
    counts,
    { [CATEGORY_SCOPE_DENIED]: 25, [CATEGORY_SELF_ONLY]: 9, [CATEGORY_STATIC]: 1 },
    'the classification table must keep its ratified shape: 25 scope-denied / 9 self-only / 1 static'
  );

  // Mechanistic category invariants: a self-only/static tool never declares a
  // cross-agent routing/target property in its published schema.
  for (const name of canonical) {
    const category = TOOL_CLASSIFICATION[name];
    if (category !== CATEGORY_SELF_ONLY && category !== CATEGORY_STATIC) continue;
    const descriptor = ALL_TOOL_DESCRIPTORS.find((candidate) => candidate.name === name);
    const properties = Object.keys(descriptor?.schema?.properties || {});
    const targets = properties.filter((key) => CROSS_TARGET_SCHEMA_KEYS.includes(key));
    assert.deepStrictEqual(
      targets,
      [],
      `'${name}' is classified ${category} but declares cross-agent target schema key(s): ${targets.join(', ')}`
    );
  }
});

// ============================================================================
// 2. Correct-id adversarial matrix — mail
// ============================================================================

test('2. cross-scope mail by exact id is denied; fan-out stays inside the realm', async () => {
  const { runtime } = await createRealmFixture();
  try {
    runtime.virtualFs.writeFile({ filePath: '/secret.md', content: 'BETA-SECRET' }, { callerAgentId: 'beta_worker' });

    const betaUnreadBefore = runtime.messagingBus.getUnreadCount('beta_worker');
    const directorUnreadBefore = runtime.messagingBus.getUnreadCount('director');
    const auditBefore = runtime.messagingBus.getAuditLog().length;

    // --- send_message: cross-realm and system-scope exact ids ---------------
    for (const recipient of ['beta_worker', 'director']) {
      const denied = await dispatcherFor(runtime, 'alpha_worker').executeTool('send_message', {
        recipient,
        message: 'cross-scope probe'
      });
      assert.equal(denied.success, false, `alpha_worker -> ${recipient} must be denied`);
      assert.equal(denied.code, 'PERMISSION_DENIED', `alpha_worker -> ${recipient} must fail closed`);
      assert.equal(denied.messageId, undefined, 'no envelope id is minted for a denied send');
      assertRealmOpaque(JSON.stringify(denied), `the denied send_message receipt (${recipient})`);
    }
    matrixCoveredTools.add('send_message');
    assert.equal(runtime.messagingBus.getUnreadCount('beta_worker'), betaUnreadBefore, 'no cross-realm mailbox copy lands');
    assert.equal(runtime.messagingBus.getUnreadCount('director'), directorUnreadBefore, 'no system-scope mailbox copy lands');
    assert.equal(runtime.messagingBus.getAuditLog().length, auditBefore, 'denied envelopes never enter the audit log');

    // --- inline_file_in_message: denial precedes the VirtualFS read ---------
    const reads = [];
    const recordingFs = {
      readFile: (path, options) => {
        reads.push({ path, options });
        return runtime.virtualFs.readFile(path, options);
      },
      writeFile: (path, content, options) => runtime.virtualFs.writeFile(path, content, options)
    };
    const inline = await dispatcherFor(runtime, 'alpha_worker', { virtualFs: recordingFs }).executeTool(
      'inline_file_in_message',
      { file_path: '/secret.md', recipient: 'beta_worker' }
    );
    assert.equal(inline.success, false, 'alpha_worker -> beta_worker inline must be denied');
    assert.equal(inline.code, 'PERMISSION_DENIED');
    assert.equal(reads.length, 0, 'a denied inline never reads VirtualFS content');
    matrixCoveredTools.add('inline_file_in_message');
    assert.equal(runtime.messagingBus.getUnreadCount('beta_worker'), betaUnreadBefore, 'a denied inline copies nothing');

    // --- to: 'all' fan-out is confined to the caller's realm ----------------
    const broadcast = await dispatcherFor(runtime, 'alpha_worker').executeTool('send_message', {
      recipient: 'all',
      message: 'alpha-only broadcast'
    });
    assert.equal(broadcast.success, true, `the same-realm broadcast must deliver: ${broadcast.error}`);
    assert.deepStrictEqual(
      [...broadcast.recipients].sort(),
      ['alpha_child', 'alpha_root'],
      'fan-out recipients are exactly the same-realm members (sender excluded)'
    );
    assertRealmOpaque(JSON.stringify(broadcast), 'the fan-out receipt');
    assert.equal(runtime.messagingBus.getUnreadCount('beta_worker'), betaUnreadBefore, 'the foreign realm receives no fan-out');
    assert.equal(runtime.messagingBus.getUnreadCount('director'), directorUnreadBefore, 'the system scope receives no fan-out');

    // --- self-only mailbox family: foreign mail is never readable -----------
    const betaMessage = runtime.messagingBus.sendMessage({ from: 'director', to: 'beta_worker', content: 'beta-only-note' });
    const foreignRead = await dispatcherFor(runtime, 'alpha_worker').executeTool('read_message', {
      message_id: betaMessage.messageId
    });
    assert.equal(foreignRead.success, false, 'a foreign message id is never readable');
    assertRealmOpaque(JSON.stringify(foreignRead), 'the foreign read_message denial');
    const alphaInbox = await dispatcherFor(runtime, 'alpha_worker').executeTool('list_inbox', {});
    const alphaArchive = await dispatcherFor(runtime, 'alpha_worker').executeTool('get_archive', {});
    assert.deepStrictEqual(alphaInbox.result, [], 'the caller inbox contains only the caller mail');
    assert.deepStrictEqual(alphaArchive.result, [], 'the caller archive contains only the caller mail');
    assert.equal(runtime.messagingBus.getUnreadCount('beta_worker'), 1, 'the foreign mailbox stays intact');

    // --- list_agents visibility by exact id ---------------------------------
    const ordinaryList = await dispatcherFor(runtime, 'alpha_worker').executeTool('list_agents', {});
    const ordinaryIds = ordinaryList.result.map((entry) => entry.id).sort();
    assert.deepStrictEqual(ordinaryIds, ['alpha_child', 'alpha_worker'], 'an ordinary caller sees self + children only');
    const rootList = await dispatcherFor(runtime, 'alpha_root').executeTool('list_agents', {});
    const rootIds = rootList.result.map((entry) => entry.id).sort();
    assert.deepStrictEqual(rootIds, ['alpha_child', 'alpha_root', 'alpha_worker'], 'a realm root sees same-scope members only');
    for (const [label, receipt] of [['ordinary', ordinaryList], ['root', rootList]]) {
      assert.equal(JSON.stringify(receipt.result).includes('beta_worker'), false, `the ${label} listing hides the foreign realm member`);
      assert.equal(JSON.stringify(receipt.result).includes('director'), false, `the ${label} listing hides the system scope`);
      assertRealmOpaque(JSON.stringify(receipt), `the ${label} list_agents receipt`);
    }
    matrixCoveredTools.add('list_agents');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 3. Correct-id adversarial matrix — invocation + await
// ============================================================================

test('3. cross-scope invoke/await by exact id is denied; same-scope controls work', async () => {
  const { runtime } = await createRealmFixture();
  try {
    // Ordinary caller: peer authority already denies; it must stay realm-opaque.
    const ordinaryInvoke = await dispatcherFor(runtime, 'alpha_worker').executeTool('invoke_agent', {
      agent_id: 'beta_worker',
      prompt: 'cross-realm probe',
      timeout_ms: 50
    });
    assert.equal(ordinaryInvoke.success, false, 'an ordinary caller cannot invoke a foreign peer');
    assert.equal(ordinaryInvoke.code, 'PERMISSION_DENIED');
    assert.equal(ordinaryInvoke.invocationId, undefined, 'no invocation is dispatched');
    assertRealmOpaque(JSON.stringify(ordinaryInvoke), 'the ordinary cross-realm invoke denial');

    // Wildcard realm authority never crosses the realm boundary.
    for (const target of ['beta_worker', 'director']) {
      const denied = await dispatcherFor(runtime, 'alpha_root').executeTool('invoke_agent', {
        agent_id: target,
        prompt: 'authority probe',
        timeout_ms: 50
      });
      assert.equal(denied.success, false, `a realm root cannot invoke '${target}'`);
      assert.equal(denied.code, 'PERMISSION_DENIED');
      assert.equal(denied.invocationId, undefined, 'no invocation is dispatched across the boundary');
      assertRealmOpaque(JSON.stringify(denied), `the root cross-scope invoke denial (${target})`);
    }
    matrixCoveredTools.add('invoke_agent');

    // Same-scope control: a root may invoke a same-realm member.
    const sameScope = await dispatcherFor(runtime, 'alpha_root').executeTool('invoke_agent', {
      agent_id: 'alpha_worker',
      prompt: 'same-realm probe',
      timeout_ms: 500
    });
    assert.equal(sameScope.success, true, `a same-realm invoke must dispatch: ${sameScope.error}`);
    assert.ok(sameScope.invocationId, 'the same-realm invocation id is returned');

    // A bypass invoker (director) reaches a realm; no realm peer can await it.
    const directorInvoke = await dispatcherFor(runtime, 'director').executeTool('invoke_agent', {
      agent_id: 'beta_worker',
      prompt: 'system probe',
      timeout_ms: 500
    });
    assert.equal(directorInvoke.success, true, `the director bypass invoke must dispatch: ${directorInvoke.error}`);
    assert.ok(directorInvoke.invocationId, 'the bypass invocation id is returned');

    const foreignWait = await dispatcherFor(runtime, 'alpha_worker').executeTool('wait_for_invocation', {
      invocation_ids: [directorInvoke.invocationId],
      timeout_ms: 50
    });
    assert.equal(foreignWait.success, false, 'a foreign realm peer cannot await the invocation');
    assert.equal(foreignWait.code, 'PERMISSION_DENIED');
    assertRealmOpaque(JSON.stringify(foreignWait), 'the cross-scope await denial');

    const rootWait = await dispatcherFor(runtime, 'alpha_root').executeTool('wait_for_invocation', {
      invocation_ids: [directorInvoke.invocationId],
      timeout_ms: 50
    });
    assert.equal(rootWait.success, false, 'a same-realm root that is not invoker/target cannot await it');
    assert.equal(rootWait.code, 'PERMISSION_DENIED');
    matrixCoveredTools.add('wait_for_invocation');

    // Bypass/target control: the invocation target may await its own invocation.
    const targetWait = await dispatcherFor(runtime, 'beta_worker').executeTool('wait_for_invocation', {
      invocation_ids: [directorInvoke.invocationId],
      timeout_ms: 500
    });
    assert.equal(targetWait.success, true, `the invocation target may await its own invocation: ${targetWait.error}`);

    // Forged identity claims cannot turn a realm peer into the director.
    const forged = await dispatcherFor(runtime, 'beta_worker').executeTool(
      'wait_for_invocation',
      { invocation_ids: [sameScope.invocationId], timeout_ms: 50 },
      { callerAgentId: 'director', principal: directorAuthority(runtime) }
    );
    assert.equal(forged.success, false, 'forged per-call claims never authenticate a wait');
    assert.equal(forged.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 4. Correct-id adversarial matrix — lifecycle
// ============================================================================

test('4. cross-scope kill/restore by exact id is denied; same-id spawn is realm-local', async () => {
  const { runtime } = await createRealmFixture();
  try {
    // --- kill_agent: wildcard realm authority never crosses the boundary ----
    for (const target of ['beta_worker', 'director']) {
      const denied = await dispatcherFor(runtime, 'alpha_root').executeTool('kill_agent', {
        agent_id: target,
        reason: 'cross-scope probe'
      });
      assert.equal(denied.success, false, `alpha_root cannot kill '${target}'`);
      assert.equal(denied.code, 'PERMISSION_DENIED');
      assertRealmOpaque(JSON.stringify(denied), `the cross-scope kill denial (${target})`);
    }
    matrixCoveredTools.add('kill_agent');
    assert.equal(runtime.hasAgent('beta_worker'), true, 'the realm target survives');
    assert.equal(runtime.hasAgent('director'), true, 'the director survives');

    // --- restore_agent: realm callers cannot restore across scopes ----------
    assert.ok(
      runtime.killAgent('beta_worker', 'fixture recycle for restore probe', { callerAgentId: 'beta_worker' }),
      'the target recycles itself for the restore probe'
    );
    assert.equal(runtime.hasRecycledAgent('beta_worker'), true, 'the target is recycled');
    assert.throws(
      () => runtime.restoreAgent('beta_worker', { callerAgentId: 'alpha_root' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a realm root cannot restore a foreign realm agent'
    );
    assert.equal(runtime.hasRecycledAgent('beta_worker'), true, 'the denied restore leaves the record recycled');

    // Bypass control: the director restores the realm member.
    runtime.restoreAgent('beta_worker', { callerAgentId: 'director' });
    assert.equal(runtime.hasAgent('beta_worker'), true, 'the director bypass restores the realm member');

    // --- spawn_agent: ids are realm-local (Wave I, ticket d57cbc1) ----------
    // A live same-realm id is still never re-minted, while the same literal id
    // that exists only in another realm is legal: it mints a distinct
    // registration inside the caller's own realm (the cross-realm staged
    // uniqueness denial was lifted by the realm-local identity wave).
    const duplicate = await dispatcherFor(runtime, 'alpha_root').executeTool('spawn_agent', {
      id: 'alpha_worker',
      name: 'duplicate'
    });
    assert.equal(duplicate.success, false, 'a live same-realm id is never re-minted');
    assert.match(String(duplicate.error || ''), /already registered/i, 'the duplicate denial names the collision');
    assertRealmOpaque(JSON.stringify(duplicate), 'the same-realm duplicate denial');

    const crossRealmMint = await dispatcherFor(runtime, 'alpha_root').executeTool('spawn_agent', {
      id: 'beta_worker',
      name: 'alpha-side beta'
    });
    assert.equal(
      crossRealmMint.success,
      true,
      `the same literal id is legal in another realm: ${JSON.stringify(crossRealmMint)}`
    );
    assert.equal(crossRealmMint.id, 'beta_worker', 'the minted receipt carries the realm-local id');
    assertRealmOpaque(JSON.stringify(crossRealmMint), 'the realm-local mint receipt');
    const alphaPeer = runtime.listAgents({ realmId: ALPHA }).filter((agent) => agent.id === 'beta_worker');
    const betaOriginal = runtime.listAgents({ realmId: BETA }).filter((agent) => agent.id === 'beta_worker');
    assert.equal(alphaPeer.length, 1, 'the minted registration lands in the caller realm');
    assert.equal(betaOriginal.length, 1, 'the other realm carries exactly its own registration');
    assert.notStrictEqual(alphaPeer[0], betaOriginal[0], 'the two registrations are distinct agents');
    assert.equal(alphaPeer[0].config.realmId, ALPHA, 'the mint is bound to the caller realm');
    assert.equal(betaOriginal[0].config.realmId, BETA, 'the original stays bound to its realm');
    matrixCoveredTools.add('spawn_agent');
    assert.equal(runtime.getAgent('director').config.privileged, true, 'the real director record is untouched');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 5. Correct-id adversarial matrix — all 12 VFS mounts
// ============================================================================

test('5. every canonical VFS tool denies the cross-realm /agents mount without disclosure', async () => {
  const { runtime } = await createRealmFixture();
  try {
    runtime.virtualFs.writeFile({ filePath: '/secret.md', content: 'BETA-SECRET' }, { callerAgentId: 'beta_worker' });
    runtime.virtualFs.writeFile({ filePath: '/peer.md', content: 'ALPHA-PEER' }, { callerAgentId: 'alpha_worker' });
    runtime.virtualFs.writeFile({ filePath: '/board.md', content: 'DIRECTOR-BOARD' }, { callerAgentId: 'director' });

    const crossMountRows = [
      { tool: 'read_file', args: { file_path: '/agents/beta_worker/secret.md' } },
      { tool: 'write_file', args: { file_path: '/agents/beta_worker/tamper.md', content: 'TAMPER' } },
      { tool: 'replace_file_content', args: { file_path: '/agents/beta_worker/secret.md', target_content: 'BETA', replacement_content: 'PWN' } },
      { tool: 'copy_file', args: { src_path: '/agents/beta_worker/secret.md', dest_path: '/stolen.md' } },
      { tool: 'delete_file', args: { file_path: '/agents/beta_worker/secret.md' } },
      { tool: 'list_files', args: { dir_path: '/agents/beta_worker' } },
      { tool: 'write_json', args: { file_path: '/agents/beta_worker/data.json', data: { hacked: true } } },
      { tool: 'query_json', args: { file_path: '/agents/beta_worker/secret.md' } },
      { tool: 'json_patch', args: { file_path: '/agents/beta_worker/secret.md', patch: [{ op: 'add', path: '/x', value: 1 }] } },
      { tool: 'grep', args: { pattern: 'BETA-SECRET', path_prefix: '/agents/beta_worker' } },
      { tool: 'set_permissions', args: { file_path: '/agents/beta_worker/secret.md', read_only: true } },
      { tool: 'concat_files', args: { sources: ['/agents/beta_worker/secret.md'], destination: '/stolen.md' } }
    ];

    const coveredVfs = new Set();
    for (const row of crossMountRows) {
      const receipt = await dispatcherFor(runtime, 'alpha_root').executeTool(row.tool, row.args);
      const serialized = JSON.stringify(receipt);
      assert.equal(receipt.success, false, `the cross-realm mount must be denied for '${row.tool}'`);
      assert.equal(receipt.code, 'PERMISSION_DENIED', `the cross-realm mount denial must fail closed for '${row.tool}'`);
      assert.equal(serialized.includes('BETA-SECRET'), false, `'${row.tool}' must not disclose foreign bytes`);
      assertRealmOpaque(serialized, `the cross-realm mount denial (${row.tool})`);
      coveredVfs.add(row.tool);
      matrixCoveredTools.add(row.tool);
    }
    assert.deepStrictEqual(
      [...coveredVfs].sort(),
      [...VFS_TOOL_NAMES].sort(),
      'all 12 canonical VFS tools must be exercised by the cross-realm mount matrix'
    );
    for (const name of VFS_TOOL_NAMES) {
      assert.equal(TOOL_CLASSIFICATION[name], CATEGORY_SCOPE_DENIED, `'${name}' must stay classified ${CATEGORY_SCOPE_DENIED}`);
    }

    // Write-side copy claim: a foreign destination is denied too.
    const writeSideCopy = await dispatcherFor(runtime, 'alpha_root').executeTool('copy_file', {
      src_path: '/peer.md',
      dest_path: '/agents/beta_worker/stolen.md'
    });
    assert.equal(writeSideCopy.success, false, 'a foreign copy destination is denied');
    assert.equal(writeSideCopy.code, 'PERMISSION_DENIED');
    assertRealmOpaque(JSON.stringify(writeSideCopy), 'the foreign copy-destination denial');

    // --- director mount: system scope is never reachable --------------------
    for (const [tool, args] of [
      ['read_file', { file_path: '/agents/director/board.md' }],
      ['list_files', { dir_path: '/agents/director' }]
    ]) {
      const receipt = await dispatcherFor(runtime, 'alpha_root').executeTool(tool, args);
      assert.equal(receipt.success, false, `the director mount must be denied for '${tool}'`);
      assert.equal(receipt.code, 'PERMISSION_DENIED');
      assert.equal(JSON.stringify(receipt).includes('DIRECTOR-BOARD'), false, 'the director bytes are never disclosed');
      assertRealmOpaque(JSON.stringify(receipt), `the director mount denial (${tool})`);
    }

    // --- controls: same-realm mount + scoped /agents listing ----------------
    const sameRealmRead = await dispatcherFor(runtime, 'alpha_root').executeTool('read_file', {
      file_path: '/agents/alpha_worker/peer.md'
    });
    assert.equal(sameRealmRead.success, true, `a same-realm mount must work: ${sameRealmRead.error}`);
    assert.equal(sameRealmRead.content, 'ALPHA-PEER', 'the same-realm peer bytes are delivered');

    const mountListing = await dispatcherFor(runtime, 'alpha_root').executeTool('list_files', { dir_path: '/agents' });
    assert.equal(mountListing.success, true, `the root /agents listing must work: ${mountListing.error}`);
    const mountNames = mountListing.result.map((entry) => entry.name);
    assert.ok(mountNames.includes('alpha_worker'), 'same-realm mount targets stay listed');
    assert.equal(mountNames.includes('beta_worker'), false, 'a foreign realm mount target is never listed');
    assert.equal(mountNames.includes('director'), false, 'the system-scope mount target is never listed');
    assertRealmOpaque(JSON.stringify(mountListing), 'the /agents mount listing');

    // Ordinary members cannot reach /agents at all.
    const ordinaryListing = await dispatcherFor(runtime, 'alpha_worker').executeTool('list_files', { dir_path: '/agents' });
    assert.equal(ordinaryListing.success, false, 'an ordinary caller is denied the cross-workspace mount root');
    assert.equal(ordinaryListing.code, 'PERMISSION_DENIED');

    // Foreign bytes survive every denied attempt.
    assert.equal(
      runtime.virtualFs.readFile({ filePath: '/secret.md' }, { callerAgentId: 'beta_worker', raw: true }),
      'BETA-SECRET',
      'the foreign bytes are byte-identical after the whole attempt matrix'
    );
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 6. Correct-id adversarial matrix — batch_precall nesting
// ============================================================================

test('6. batch_precall preserves the caller scope for nested cross-scope targets', async () => {
  const { runtime } = await createRealmFixture();
  try {
    runtime.virtualFs.writeFile({ filePath: '/secret.md', content: 'BETA-SECRET' }, { callerAgentId: 'beta_worker' });

    const receipt = await dispatcherFor(runtime, 'alpha_worker').executeTool('batch_precall', {
      calls: [
        { name: 'read_file', arguments: { file_path: '/agents/beta_worker/secret.md' } },
        { name: 'list_agents', arguments: {} }
      ]
    });
    assert.equal(receipt.success, true, `batch_precall must execute: ${receipt.error}`);
    const nestedRead = receipt.results.find((entry) => entry.name === 'read_file')?.result;
    assert.ok(nestedRead, 'the nested read result is reported');
    assert.equal(nestedRead.success, false, 'the nested foreign mount read is denied');
    assert.equal(nestedRead.code, 'PERMISSION_DENIED');
    const nestedList = receipt.results.find((entry) => entry.name === 'list_agents')?.result;
    assert.ok(nestedList && Array.isArray(nestedList.result), 'the nested listing result is reported');
    assert.equal(
      nestedList.result.some((entry) => entry.id === 'beta_worker' || entry.id === 'director'),
      false,
      'the nested listing stays inside the caller scope'
    );
    const serialized = JSON.stringify(receipt);
    assert.equal(serialized.includes('BETA-SECRET'), false, 'the nested batch never discloses foreign bytes');
    assertRealmOpaque(serialized, 'the batch_precall receipt');
    matrixCoveredTools.add('batch_precall');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 7. Correct-id adversarial matrix — scheduler
// ============================================================================

test('7. schedules: target pinning, own-only listing, cross-scope cancel denial', async () => {
  const { runtime, operator } = await createRealmFixture();
  try {
    // The tool pins the target to the bound caller even when the caller
    // supplies a foreign target spelling.
    const armed = await dispatcherFor(runtime, 'alpha_worker').executeTool('schedule', {
      action: 'create',
      prompt: 'alpha wake',
      delay_seconds: 600,
      agentId: 'beta_worker',
      targetAgentId: 'beta_worker'
    });
    assert.equal(armed.success, true, `the caller schedule must arm: ${armed.error}`);
    assert.equal(armed.targetAgentId, 'alpha_worker', 'the schedule target is pinned to the bound caller');
    assertRealmOpaque(JSON.stringify(armed), 'the schedule receipt');
    matrixCoveredTools.add('schedule');

    // Host-armed foreign-realm and system-scope timers.
    const betaTimer = runtime.schedule(
      { agentId: 'beta_worker', prompt: 'beta wake', durationSeconds: 600 },
      { principal: agentAuthority(runtime, 'beta_worker') }
    );
    assert.equal(betaTimer.success, true, 'the beta timer arms through the host surface');
    const directorTimer = runtime.schedule(
      { agentId: 'director', prompt: 'director wake', durationSeconds: 600 },
      { principal: operator }
    );
    assert.equal(directorTimer.success, true, 'the director timer arms through the operator surface');

    // Host/port path: a realm-bound wildcard caller cannot arm or cancel a
    // foreign-realm timer by exact id either.
    const hostForeignSchedule = runtime.schedule(
      { agentId: 'beta_worker', prompt: 'foreign wake', durationSeconds: 600 },
      { principal: agentAuthority(runtime, 'alpha_root') }
    );
    assert.equal(hostForeignSchedule.success, false, 'a realm-bound caller cannot arm a foreign-realm timer');
    assert.equal(hostForeignSchedule.code, 'PERMISSION_DENIED');
    assertRealmOpaque(JSON.stringify(hostForeignSchedule), 'the host foreign-schedule denial');
    const hostForeignCancel = runtime.cancelSchedule(betaTimer.timerId, null, {
      principal: agentAuthority(runtime, 'alpha_root')
    });
    assert.equal(hostForeignCancel.success, false, 'a realm-bound caller cannot cancel a foreign-realm timer');
    assert.equal(hostForeignCancel.code, 'PERMISSION_DENIED');
    assertRealmOpaque(JSON.stringify(hostForeignCancel), 'the host foreign-cancel denial');

    // Own-only listing: foreign/system timers are never listed.
    const listed = await dispatcherFor(runtime, 'alpha_worker').executeTool('list_schedules', {});
    assert.equal(listed.success, true, `the own-scope listing must work: ${listed.error}`);
    const listedIds = listed.schedules.map((entry) => entry.timerId);
    assert.ok(listedIds.includes(armed.timerId), 'the caller timer is listed');
    assert.equal(listedIds.includes(betaTimer.timerId), false, 'the foreign realm timer is never listed');
    assert.equal(listedIds.includes(directorTimer.timerId), false, 'the system-scope timer is never listed');
    assertRealmOpaque(JSON.stringify(listed), 'the list_schedules receipt');
    matrixCoveredTools.add('list_schedules');

    // Cross-scope cancels by exact timer id are denied and change nothing.
    for (const [label, timerId] of [['foreign realm', betaTimer.timerId], ['system scope', directorTimer.timerId]]) {
      const denied = await dispatcherFor(runtime, 'alpha_worker').executeTool('cancel_schedule', { task_id: timerId });
      assert.equal(denied.success, false, `the ${label} timer cannot be cancelled across scopes`);
      assert.equal(denied.code, 'PERMISSION_DENIED');
      assertRealmOpaque(JSON.stringify(denied), `the ${label} cancel denial`);
    }
    matrixCoveredTools.add('cancel_schedule');
    assert.equal(timerStatus(runtime, betaTimer.timerId), 'pending', 'the foreign timer stays pending');
    assert.equal(timerStatus(runtime, directorTimer.timerId), 'pending', 'the system timer stays pending');
    assert.equal(timerStatus(runtime, armed.timerId), 'pending', 'the caller timer stays pending');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 8. Correct-id adversarial matrix — clock/event targets
// ============================================================================

test('8. clock/event targets: host gates deny cross-scope targets, tool spoofs are inert', async () => {
  const { runtime } = await createRealmFixture();
  try {
    // Tool boundary: a caller-supplied target is never a routing channel; the
    // receipt is owned by the bound caller.
    const clock = await dispatcherFor(runtime, 'alpha_worker').executeTool('world_clock', {
      action: 'set',
      time: '09:30',
      targetAgentId: 'beta_worker'
    });
    assert.equal(clock.success, true, `the caller clock set must work: ${clock.error}`);
    assert.equal(clock.agentId, 'alpha_worker', 'the clock receipt is owned by the bound caller');
    assertRealmOpaque(JSON.stringify(clock), 'the world_clock receipt');
    matrixCoveredTools.add('world_clock');

    const event = await dispatcherFor(runtime, 'alpha_worker').executeTool('event_list', {
      action: 'register',
      name: 'alpha-event',
      trigger_minutes: 10,
      targetAgentId: 'beta_worker'
    });
    assert.equal(event.success, true, `the caller event registration must work: ${event.error}`);
    assert.equal(event.event.ownerId, 'alpha_worker', 'the event owner is the bound caller');
    assert.equal(event.event.createdBy, 'alpha_worker', 'the event creator is the bound caller');
    assertRealmOpaque(JSON.stringify(event), 'the event_list receipt');
    matrixCoveredTools.add('event_list');

    const time = await dispatcherFor(runtime, 'alpha_worker').executeTool('get_current_time', {});
    assert.equal(time.success, true, `the caller time query must work: ${time.error}`);
    assert.equal(time.agentId, 'alpha_worker', 'the time receipt is owned by the bound caller');
    assertRealmOpaque(JSON.stringify(time), 'the get_current_time receipt');

    // Host API: cross-scope mutations are denied for the realm root.
    for (const [label, receipt] of [
      ['setTime foreign realm', runtime.worldClock.setTime({ totalSeconds: 100, targetAgentId: 'beta_worker' }, { callerAgentId: 'alpha_root' })],
      ['setTime director', runtime.worldClock.setTime({ totalSeconds: 100, targetAgentId: 'director' }, { callerAgentId: 'alpha_root' })],
      ['advanceClock director', runtime.worldClock.advanceClock({ minutes: 5, targetAgentId: 'director' }, { callerAgentId: 'alpha_root' })],
      ['registerEvent director', runtime.worldClock.registerEvent({ name: 'probe', targetAgentId: 'director' }, { callerAgentId: 'alpha_root' })]
    ]) {
      assert.equal(receipt.success, false, `the host ${label} cross-scope call must be denied`);
      assert.equal(receipt.code, 'PERMISSION_DENIED', `the host ${label} denial must fail closed`);
      assertRealmOpaque(JSON.stringify(receipt), `the host ${label} denial`);
    }

    // Host read: a foreign target silently narrows to the caller partition
    // (no failure branch) and never returns the target's time.
    const narrowed = runtime.worldClock.getTime({ targetAgentId: 'director' }, { callerAgentId: 'alpha_root' });
    assert.equal(narrowed.agentId, 'alpha_root', 'a foreign getTime target narrows to the caller partition');
    assertRealmOpaque(JSON.stringify(narrowed), 'the narrowed getTime receipt');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 9. Opacity sweep — representative receipts of every canonical tool
// ============================================================================

test('9. every canonical tool receipt is realm-free for two realm scopes', async () => {
  const { runtime, operator } = await createRealmFixture();
  try {
    const model = createMockModel(async () => ({ content: 'sweep turn complete' }));
    // A Generic-default ordinary member (invocation control) and a Generic
    // privileged caller whose receipts must stay free of the seeded
    // `realm_generic` identifier.
    await runtime.launchAgent({ config: { id: 'generic_worker', allowedTools: [...ORDINARY_TOOLS] }, principal: operator, model });
    await runtime.launchAgent({ config: { id: 'generic_root', privileged: true, allowedTools: ['*'] }, principal: operator, model });
    assert.equal(
      runtime.getAgent('generic_root').config.realmId,
      GENERIC_REALM_ID,
      'the Generic sweep caller resolves the seeded default realm'
    );

    const realmIdsBefore = new Map(
      ['alpha_root', 'alpha_worker', 'alpha_child', 'beta_worker', 'generic_root', 'generic_worker'].map((id) => [
        id,
        runtime.getAgent(id).config.realmId
      ])
    );

    /**
     * Runs the representative receipt script for one caller and returns every
     * receipt plus the spawned child's resolved realm. `realmId` is included
     * in every argument bag to prove a caller-supplied membership claim is
     * inert on every tool.
     *
     * @param {string} callerId - Bound caller.
     * @param {string} invokeTargetId - Same-scope member to invoke.
     * @param {string} mailTargetId - Same-scope member to mail/inline.
     * @param {string} suffix - Unique child-id suffix.
     * @returns {Promise<{receipts: Array<{tool: string, receipt: unknown}>, childRealm: string|null}>} Collected receipts.
     */
    const sweep = async (callerId, invokeTargetId, mailTargetId, suffix) => {
      const dispatcher = dispatcherFor(runtime, callerId);
      const receipts = [];
      const call = async (tool, args) => {
        const receipt = await dispatcher.executeTool(tool, { ...args, realmId: REALM_HIJACK });
        receipts.push({ tool, receipt });
        executedTools.add(tool);
        return receipt;
      };

      await call('write_file', { file_path: '/sweep.md', content: 'sweep-bytes' });
      await call('read_file', { file_path: '/sweep.md' });
      await call('replace_file_content', { file_path: '/sweep.md', target_content: 'sweep-bytes', replacement_content: 'replaced-bytes' });
      await call('copy_file', { src_path: '/sweep.md', dest_path: '/sweep-copy.md' });
      await call('delete_file', { file_path: '/sweep-copy.md' });
      await call('list_files', { dir_path: '/' });
      await call('write_json', { file_path: '/sweep.json', data: { marker: true } });
      await call('query_json', { file_path: '/sweep.json', query: '.marker' });
      await call('json_patch', { file_path: '/sweep.json', patch: [{ op: 'add', path: '/patched', value: 1 }] });
      await call('grep', { pattern: 'replaced-bytes', path_prefix: '/' });
      await call('set_permissions', { file_path: '/sweep.md', read_only: true });
      await call('concat_files', { sources: ['/sweep.md'], destination: '/sweep-concat.md' });

      const spawned = await call('spawn_agent', { id: `sweep_child_${suffix}`, name: 'Sweep Child' });
      assert.equal(spawned.success, true, `the ${callerId} sweep spawn must succeed: ${spawned.error}`);
      const childRealm = runtime.getAgent(spawned.id)?.config.realmId ?? null;
      await call('list_agents', {});

      const invoked = await call('invoke_agent', { agent_id: invokeTargetId, prompt: 'sweep prompt', timeout_ms: 500 });
      await call('wait_for_invocation', {
        invocation_ids: invoked.invocationId ? [invoked.invocationId] : ['inv_sweep_missing'],
        timeout_ms: 50
      });

      await call('send_message', { recipient: mailTargetId, message: 'sweep mail' });
      await call('inline_file_in_message', { file_path: '/sweep.md', recipient: mailTargetId });
      await call('list_inbox', {});
      await call('get_inbox', {});
      await call('drain_inbox', {});
      await call('get_archive', {});
      await call('wait_for_mail', { timeout_ms: 5 });
      await call('read_message', { message_id: 'msg_sweep_missing' });

      const armed = await call('schedule', { action: 'create', prompt: 'sweep wake', delay_seconds: 600 });
      await call('list_schedules', {});
      await call('cancel_schedule', { task_id: armed.timerId });

      await call('world_clock', { action: 'query' });
      await call('event_list', { action: 'query' });
      await call('get_current_time', {});
      await call('whoami', {});
      await call('undo_turn', {});
      await call('describe_tool', { tool_name: 'read_file' });
      await call('batch_precall', { calls: [{ name: 'list_inbox', arguments: {} }] });

      await call('kill_agent', { agent_id: spawned.id, reason: 'sweep cleanup' });
      return { receipts, childRealm };
    };

    const alphaSweep = await sweep('alpha_root', 'alpha_worker', 'alpha_child', 'alpha');
    const genericSweep = await sweep('generic_root', 'generic_worker', 'generic_worker', 'generic');

    for (const { tool, receipt } of [...alphaSweep.receipts, ...genericSweep.receipts]) {
      assertRealmOpaque(JSON.stringify(receipt), `the ${tool} sweep receipt`);
    }

    // Every canonical tool was executed (no stale classification entry).
    const canonical = canonicalTools();
    const missing = canonical.filter((name) => !executedTools.has(name));
    assert.deepStrictEqual(missing, [], `canonical tool(s) never executed by the sweep: ${missing.join(', ')}`);

    // Caller-supplied membership claims are inert on every tool: the fixture
    // memberships are byte-identical after both sweeps, and each sweep child
    // landed in its caller's realm.
    for (const [id, realmId] of realmIdsBefore) {
      assert.equal(runtime.getAgent(id).config.realmId, realmId, `'${id}' membership survives the realm-claim sweep`);
    }
    assert.equal(alphaSweep.childRealm, ALPHA, 'a hijacked claim never moves the alpha spawned child');
    assert.equal(genericSweep.childRealm, GENERIC_REALM_ID, 'the Generic caller spawns into Generic, never the claimed realm');
    assert.equal(runtime.hasAgent('sweep_child_alpha'), false, 'the alpha sweep child was terminated');
    assert.equal(runtime.hasAgent('sweep_child_generic'), false, 'the generic sweep child was terminated');

    // Static tool caller-invariance: `describe_tool` reads only the registry.
    const registryView = await dispatcherFor(runtime, 'alpha_root').executeTool('describe_tool', { tool_name: 'spawn_agent' });
    const foreignView = await dispatcherFor(runtime, 'beta_worker').executeTool('describe_tool', { tool_name: 'spawn_agent' });
    const genericView = await dispatcherFor(runtime, 'generic_root').executeTool('describe_tool', { tool_name: 'spawn_agent' });
    assert.equal(JSON.stringify(registryView), JSON.stringify(foreignView), 'describe_tool is caller-invariant across realms');
    assert.equal(JSON.stringify(registryView), JSON.stringify(genericView), 'describe_tool is caller-invariant for Generic callers');

    // --- Caller-input echo exclusion (blocking since Wave I, d57cbc1) ------
    // A denied call must not echo a caller-supplied `realm:<id>:global` claim
    // in its error text (ticket eab4e51, folded into Wave I): the tool
    // boundary sanitizes the denial to a uniform phrase, so the receipt is
    // realm-opaque while the uniform-denial-without-an-authority-oracle
    // property below is preserved.
    const claimOutcomes = [];
    for (const claim of [`realm:${ALPHA}:global`, `realm:${BETA}:global`, 'global']) {
      const claimId = `claim_${claim.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const denied = await dispatcherFor(runtime, 'alpha_worker').executeTool('spawn_agent', {
        id: claimId,
        workspace: claim
      });
      assert.equal(denied.success, false, `the reserved-workspace claim '${claim}' must be refused`);
      assert.equal(denied.code, 'PERMISSION_DENIED', `the reserved-workspace claim '${claim}' must fail closed`);
      assertRealmOpaque(JSON.stringify(denied), `the reserved-workspace claim denial (${claim})`);
      assert.equal(runtime.getAgent(claimId), null, `no record registers for the claim '${claim}'`);
      claimOutcomes.push({ success: denied.success, code: denied.code });
    }
    assert.equal(
      claimOutcomes.every((outcome) => outcome.success === false && outcome.code === 'PERMISSION_DENIED'),
      true,
      'caller-supplied realm claims are refused uniformly (no authority oracle)'
    );
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 10. Director sweep
// ============================================================================

test('10. the director is never listed and every applicable address by exact id is denied', async () => {
  const { runtime, operator } = await createRealmFixture();
  try {
    runtime.virtualFs.writeFile({ filePath: '/board.md', content: 'DIRECTOR-BOARD' }, { callerAgentId: 'director' });
    runtime.virtualFs.writeFile({ filePath: '/note.md', content: 'alpha-note' }, { callerAgentId: 'alpha_root' });
    const directorTimer = runtime.schedule(
      { agentId: 'director', prompt: 'director watchdog', durationSeconds: 600 },
      { principal: operator }
    );
    assert.equal(directorTimer.success, true, 'the director watchdog arms through the operator surface');

    // --- listings never expose the director ---------------------------------
    for (const caller of ['alpha_worker', 'alpha_root']) {
      const listed = await dispatcherFor(runtime, caller).executeTool('list_agents', {});
      assert.equal(
        listed.result.some((entry) => entry.id === 'director'),
        false,
        `'${caller}' never sees the director in list_agents`
      );
      assertRealmOpaque(JSON.stringify(listed), `the ${caller} list_agents receipt`);
    }
    const mountListing = await dispatcherFor(runtime, 'alpha_root').executeTool('list_files', { dir_path: '/agents' });
    assert.equal(
      mountListing.result.some((entry) => entry.name === 'director'),
      false,
      'the /agents mount listing never exposes the director'
    );
    assertRealmOpaque(JSON.stringify(mountListing), 'the /agents listing');

    const schedules = await dispatcherFor(runtime, 'alpha_worker').executeTool('list_schedules', {});
    assert.equal(
      schedules.schedules.some((entry) => entry.timerId === directorTimer.timerId),
      false,
      'the system-scope watchdog is never listed to a realm caller'
    );
    assertRealmOpaque(JSON.stringify(schedules), 'the list_schedules receipt');

    // --- addressing: every applicable tool denies the exact id --------------
    const addressRows = [
      ['send_message', { recipient: 'director', message: 'probe' }],
      ['inline_file_in_message', { file_path: '/note.md', recipient: 'director' }],
      ['invoke_agent', { agent_id: 'director', prompt: 'probe', timeout_ms: 50 }],
      ['kill_agent', { agent_id: 'director' }],
      ['read_file', { file_path: '/agents/director/board.md' }],
      ['list_files', { dir_path: '/agents/director' }]
    ];
    for (const [tool, args] of addressRows) {
      const denied = await dispatcherFor(runtime, 'alpha_root').executeTool(tool, args);
      assert.equal(denied.success, false, `'${tool}' must deny the exact director id`);
      assert.equal(denied.code, 'PERMISSION_DENIED', `'${tool}' must fail closed on the director`);
      matrixCoveredTools.add(tool);
    }
    const cancelDirector = await dispatcherFor(runtime, 'alpha_worker').executeTool('cancel_schedule', {
      task_id: directorTimer.timerId
    });
    assert.equal(cancelDirector.success, false, 'the director watchdog cannot be cancelled by exact id');
    assert.equal(cancelDirector.code, 'PERMISSION_DENIED');
    assertRealmOpaque(JSON.stringify(cancelDirector), 'the director cancel denial');
    matrixCoveredTools.add('cancel_schedule');

    assert.equal(timerStatus(runtime, directorTimer.timerId), 'pending', 'the director watchdog stays pending');
    assert.equal(runtime.hasAgent('director'), true, 'the director survives every denied address');
    assert.equal(
      runtime.virtualFs.readFile({ filePath: '/board.md' }, { callerAgentId: 'director', raw: true }),
      'DIRECTOR-BOARD',
      'the director private bytes survive every denied address'
    );

    // --- one-way mail: true sender identity, no reply path ------------------
    const mail = await dispatcherFor(runtime, 'director').executeTool('send_message', {
      recipient: 'alpha_worker',
      message: 'system directive'
    });
    assert.equal(mail.success, true, `the director one-way mail must deliver: ${mail.error}`);
    assert.equal(mail.from, 'director', 'the envelope carries the true sender identity');
    const reply = await dispatcherFor(runtime, 'alpha_worker').executeTool('send_message', {
      recipient: 'director',
      message: 'ack',
      in_reply_to: mail.messageId
    });
    assert.equal(reply.success, false, 'the realm agent cannot reply to the director');
    assert.equal(reply.code, 'PERMISSION_DENIED');

    // --- restore is denied by scope even with a recycled id ------------------
    assert.ok(
      runtime.killAgent('director', 'fixture recycle for restore probe', { callerAgentId: 'director' }),
      'the director recycles itself for the restore probe'
    );
    assert.equal(runtime.hasRecycledAgent('director'), true, 'the director record is recycled');
    assert.throws(
      () => runtime.restoreAgent('director', { callerAgentId: 'alpha_root' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a realm root cannot restore the director across the system boundary'
    );
    assert.equal(runtime.hasRecycledAgent('director'), true, 'the denied restore leaves the record recycled');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 11. Realm-model sweep
// ============================================================================

test('11. no agent-visible move path, every non-director resolves a realm, ids are realm-free', async () => {
  const { runtime, operator } = await createRealmFixture();
  try {
    // --- host/operator path: membership is immutable for every caller -------
    await runtime.launchAgent({ id: 'plain_agent', allowedTools: ['read_file'] });
    await runtime.launchAgent({ id: 'null_agent', realmId: null, allowedTools: ['read_file'] });
    assert.equal(runtime.getAgent('plain_agent').config.realmId, GENERIC_REALM_ID, 'a plain launch resolves the Generic default');
    assert.equal(runtime.getAgent('null_agent').config.realmId, GENERIC_REALM_ID, 'an explicit null realm falls through to Generic');
    assert.equal(runtime.getAgent('director').config.realmId, null, 'only the system bootstrap keeps the null scope');

    const moveCallers = [
      ['anonymous', undefined],
      ['ordinary peer', { callerAgentId: 'plain_agent' }],
      ['wildcard realm root', { callerAgentId: 'alpha_root' }],
      ['operator', { principal: operator }]
    ];
    for (const [label, context] of moveCallers) {
      assert.throws(
        () => runtime.updateAgentConfig('plain_agent', { realmId: ALPHA }, context),
        (err) => err?.code === 'PERMISSION_DENIED',
        `the ${label} caller cannot move realm membership`
      );
    }
    assert.equal(runtime.getAgent('plain_agent').config.realmId, GENERIC_REALM_ID, 'membership is unchanged after the move matrix');

    // --- no canonical tool declares a realm-mutating schema property --------
    const realmSchemaKeys = [];
    for (const descriptor of ALL_TOOL_DESCRIPTORS) {
      for (const key of Object.keys(descriptor?.schema?.properties || {})) {
        if (/realm/i.test(key)) realmSchemaKeys.push(`${descriptor.name}.${key}`);
      }
    }
    assert.deepStrictEqual(realmSchemaKeys, [], `canonical tool schemas must not expose realm fields: ${realmSchemaKeys.join(', ')}`);

    // --- tool-level realm spoofs are inert ----------------------------------
    const spoofed = await dispatcherFor(runtime, 'alpha_root').executeTool('spawn_agent', {
      id: 'spoof_child',
      realmId: BETA,
      realm_id: BETA
    });
    assert.equal(spoofed.success, true, `the authority spawn must succeed: ${spoofed.error}`);
    assert.equal(runtime.getAgent('spoof_child').config.realmId, ALPHA, 'a caller-supplied realm claim never selects the child realm');

    // Creator inheritance: a non-authority child lands in the creator realm.
    const inherited = await runtime.launchAgent({
      config: { id: 'alpha_grandchild', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'alpha_worker' },
      model: createMockModel(async () => ({ content: 'inherit' }))
    });
    assert.equal(inherited.config.realmId, ALPHA, 'a non-authority creator child inherits the creator realm');

    // Only the director carries the null scope across the whole fixture.
    for (const agent of runtime.listAgents()) {
      if (agent.id === 'director') {
        assert.equal(agent.config.realmId, null, 'the director keeps the reserved null scope');
      } else {
        assert.notEqual(agent.config.realmId, null, `'${agent.id}' must resolve a realm`);
      }
    }
    assertRealmOpaque(JSON.stringify(spoofed), 'the realm-spoofed spawn receipt');
  } finally {
    runtime.destroy();
  }

  // --- store composition root: Generic default, no move, realm-free ids -----
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    await store.ensureDirector();
    await store.launchAgent({ id: 'store_plain', name: 'Store Plain', allowedTools: ['read_file'] });
    assert.equal(
      store.agents.find((agent) => agent.id === 'store_plain').config.realmId,
      GENERIC_REALM_ID,
      'the store launcher resolves the Generic default'
    );
    assert.throws(
      () => store.updateAgentConfig('store_plain', { realmId: 'realm_other' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'the store operator path cannot move realm membership'
    );
    assert.equal(
      store.agents.find((agent) => agent.id === 'store_plain').config.realmId,
      GENERIC_REALM_ID,
      'the store membership is unchanged after the denied move'
    );

    const templateLaunch = await store.launchRealmFromTemplate('demo', { name: 'Conformance Demo' });
    assert.deepStrictEqual(
      templateLaunch.agents.map((agent) => agent.id),
      ['coordinator', 'worker'],
      'template launches use plain realm-opaque ids'
    );
    for (const agent of templateLaunch.agents) {
      assert.equal(agent.id.includes(templateLaunch.realm.id), false, 'no generated id embeds the realm id');
      assert.equal(agent.config.realmId, templateLaunch.realm.id, 'each template member joins the generated realm');
    }
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }

  // --- template catalog: ids realm-free, {realm} placeholder retired --------
  const secretRealm = 'realm_secret_catalog_probe';
  const plan = materializeTemplate(DEMO_TEMPLATE, { realmId: secretRealm });
  assert.deepStrictEqual(plan.agents.map((agent) => agent.agentId), ['coordinator', 'worker'], 'materialized ids are plain');
  for (const agent of plan.agents) {
    assert.equal(agent.agentId.includes(secretRealm), false, 'a materialized id never embeds the realm id');
  }
  const placeholderTemplate = {
    ...DEMO_TEMPLATE,
    agents: [
      { ...DEMO_TEMPLATE.agents[0], idPattern: '{realm}-coordinator' },
      DEMO_TEMPLATE.agents[1]
    ]
  };
  assert.throws(
    () => materializeTemplate(placeholderTemplate, { realmId: secretRealm }),
    (err) => /retired/i.test(String(err?.message)),
    'the {realm} placeholder is retired from the template schema'
  );
});

// ============================================================================
// 12. Coverage closure
// ============================================================================

test('12. matrix coverage closure: every classified tool was actually exercised', () => {
  const canonical = canonicalTools();
  const deniedTools = canonical.filter((name) => TOOL_CLASSIFICATION[name] === CATEGORY_SCOPE_DENIED);
  const uncoveredDenied = deniedTools.filter((name) => !matrixCoveredTools.has(name));
  assert.deepStrictEqual(
    uncoveredDenied,
    [],
    `scope-denied tool(s) without a behavioral matrix row: ${uncoveredDenied.join(', ')}`
  );

  const unexecuted = canonical.filter((name) => !executedTools.has(name));
  assert.deepStrictEqual(
    unexecuted,
    [],
    `canonical tool(s) never executed by the sweep: ${unexecuted.join(', ')}`
  );
});
