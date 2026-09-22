/**
 * @file tests/unit/tool_authorization_gate_test.js
 * @description Realm A0-1 acceptance suite (ticket 76fb539): descriptor-authoritative
 * tool authorization.
 *
 * When the identity projection carries the frozen registry `AuthorityDescriptor`,
 * the descriptor decides alone — allow iff it holds the wildcard `'*'`, an
 * explicit grant for the canonical tool (alias-written entries are canonicalized
 * to their canonical tool), or the matching subagent-management selector
 * sentinel; otherwise deny. No widening through `context.isAdmin`/`isPrivileged`
 * or bound/identity `allowedTools`. Innate tools stay universally allowed, and
 * the legacy channels apply only to callers with no descriptor.
 *
 * Hermetic and deterministic: mocked capability ports plus one real
 * `AgentRuntime` fixture for the registry-descriptor path; no timers, no
 * network, no filesystem writes.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { TOOL_SYSTEM_ERROR_CODES } from '../../src/lib/sandbox/tools/constants/index.ts';
import { createAgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';

const GATE_AGENT = 'gate_agent';

/**
 * Minimal VirtualFS spy recording which substrate operation ran.
 * @returns {{ calls: string[], readFile: Function, writeFile: Function }}
 */
function createVfsSpy() {
  const calls = [];
  return {
    calls,
    readFile: async () => {
      calls.push('read_file');
      return { success: true, content: 'ok' };
    },
    writeFile: async () => {
      calls.push('write_file');
      return { success: true };
    }
  };
}

/**
 * Builds a frozen registry-shaped `AuthorityDescriptor`.
 * @param {string[]} allow
 * @returns {object}
 */
function createAuthority(allow) {
  return Object.freeze({
    subject: GATE_AGENT,
    kind: 'agent',
    allow: Object.freeze(new Set(allow)),
    visibility: 'owned'
  });
}

/**
 * Builds a frozen identity projection for the bound subject.
 * @param {object} [overrides]
 * @returns {object}
 */
function createIdentity(overrides = {}) {
  return Object.freeze({
    id: GATE_AGENT,
    privileged: false,
    allowedTools: [],
    ...overrides
  });
}

/**
 * Builds a dispatcher whose identity port resolves the supplied projection.
 * @param {object|null} projection - Identity projection, or null for no descriptor
 * @param {object} [options] - Additional trusted bound options
 * @returns {ReturnType<typeof createSandboxToolDispatcher>}
 */
function createDispatcher(projection, options = {}) {
  return createSandboxToolDispatcher({
    agentId: GATE_AGENT,
    virtualFs: createVfsSpy(),
    identityPort: {
      getAgentIdentity: (agentId) => (agentId === GATE_AGENT ? projection : null)
    },
    ...options
  });
}

// ============================================================================
// 1. Descriptor-present: the descriptor decides alone
// ============================================================================

test('1. descriptor present with an empty allow denies despite an identity allowedTools grant (76fb539)', async () => {
  const vfs = createVfsSpy();
  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: ['write_file'], authority: createAuthority([]) }),
    { virtualFs: vfs }
  );

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, false, 'an identity allowlist grant must not widen an empty descriptor');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
  assert.deepEqual(vfs.calls, [], 'a denied call must never reach the substrate');
});

test('2. descriptor grant authorizes with no bound or identity allowlist (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: [], authority: createAuthority(['read_file']) })
  );

  const allowed = await dispatcher.executeTool('read_file', { file_path: '/gate.txt' });
  assert.equal(allowed.success, true, 'the descriptor grant must authorize the canonical tool');

  const denied = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(denied.success, false, 'a tool outside the descriptor must stay denied');
  assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

test('3. a bound allowlist wider than the descriptor does not widen the descriptor (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: ['read_file'], authority: createAuthority(['read_file']) }),
    { allowedTools: ['read_file', 'write_file', 'delete_file'] }
  );

  const allowed = await dispatcher.executeTool('read_file', { file_path: '/gate.txt' });
  assert.equal(allowed.success, true, 'the descriptor grant must authorize read_file');

  const denied = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(denied.success, false, 'the wider bound allowlist must not admit write_file');
  assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

test('4. an identity allowlist wider than the descriptor does not widen the descriptor (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: ['*'], authority: createAuthority(['read_file']) })
  );

  const allowed = await dispatcher.executeTool('read_file', { file_path: '/gate.txt' });
  assert.equal(allowed.success, true, 'the descriptor grant must authorize read_file');

  const denied = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(denied.success, false, 'an identity wildcard must not widen a narrow descriptor');
  assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

test('5. bound privilege flags do not widen a descriptor (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ authority: createAuthority([]) }),
    { isAdmin: true, isPrivileged: true, privileged: true, allowedTools: [] }
  );

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, false, 'bound privilege flags must not widen the descriptor');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

test('6. identity privilege does not widen a descriptor (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ privileged: true, allowedTools: ['*'], authority: createAuthority([]) })
  );

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, false, 'the descriptor, not the privilege projection, decides');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

// ============================================================================
// 2. Descriptor grants that DO authorize
// ============================================================================

test('7. a wildcard descriptor grants the full non-innate surface (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: [], authority: createAuthority(['*']) })
  );

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, true, 'a wildcard descriptor must authorize non-innate tools');
});

test('8. the subagent_management selector sentinel grants exactly the subagent tools (76fb539)', async () => {
  const operations = [];
  const lifecyclePort = {
    launchAgent: async (options) => {
      operations.push(`spawn:${options?.config?.id}`);
      return { success: true, id: options?.config?.id };
    },
    killAgent: async (agentId) => {
      operations.push(`kill:${agentId}`);
      return true;
    },
    invokeAgent: async (invokerId, targetAgentId) => {
      operations.push(`invoke:${invokerId}->${targetAgentId}`);
      return { success: true };
    },
    undoAgentTurn: async (agentId, targetTurnId) => {
      operations.push(`undo:${agentId}:${targetTurnId ?? ''}`);
      return { success: true, targetTurnId: 'turn_1' };
    }
  };

  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: [], authority: createAuthority(['subagent_management']) }),
    { lifecyclePort }
  );

  const spawnRes = await dispatcher.executeTool('spawn_agent', { id: 'child_agent' });
  assert.equal(spawnRes.success, true, 'the selector sentinel must authorize spawn_agent');

  const killRes = await dispatcher.executeTool('kill_agent', { agent_id: 'child_agent' });
  assert.equal(killRes.success, true, 'the selector sentinel must authorize kill_agent');

  const invokeRes = await dispatcher.executeTool('invoke_agent', { agent_id: 'child_agent', prompt: 'task' });
  assert.equal(invokeRes.success, true, 'the selector sentinel must authorize invoke_agent');

  const undoRes = await dispatcher.executeTool('undo_turn', {});
  assert.equal(undoRes.success, true, 'the selector sentinel must authorize undo_turn');

  const denied = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(denied.success, false, 'the selector sentinel must not authorize non-subagent tools');
  assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
  assert.deepEqual(
    operations,
    ['spawn:child_agent', 'kill:child_agent', 'invoke:gate_agent->child_agent', 'undo:gate_agent:'],
    'only sentinel-scoped operations may run'
  );
});

test('9. alias-written descriptor entries grant exactly their canonical tool (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: [], authority: createAuthority(['save_file']) })
  );

  const allowed = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(allowed.success, true, "'save_file' must grant the canonical write_file");

  const denied = await dispatcher.executeTool('read_file', { file_path: '/gate.txt' });
  assert.equal(denied.success, false, 'an alias grant must not admit other tools');
  assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

test('10. a malformed descriptor fails closed instead of falling through (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({
      allowedTools: ['write_file'],
      privileged: true,
      authority: Object.freeze({ subject: GATE_AGENT, kind: 'agent', allow: undefined, visibility: 'owned' })
    }),
    { isAdmin: true, allowedTools: ['write_file'] }
  );

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, false, 'a descriptor with an unusable allow surface must deny, never fall through');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

// ============================================================================
// 3. Innate tools stay universally allowed
// ============================================================================

test('11. innate tools stay allowed for a descriptor with an empty allow (76fb539)', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ authority: createAuthority([]) }),
    {
      lifecyclePort: { whoami: async (agentId) => ({ success: true, id: agentId }) },
      worldClock: { getTime: () => ({ success: true, formatted: '00:00:00' }) }
    }
  );

  const who = await dispatcher.executeTool('whoami', {});
  assert.equal(who.success, true, 'whoami is innate');

  const time = await dispatcher.executeTool('get_current_time', {});
  assert.equal(time.success, true, 'get_current_time is innate');

  const describe = await dispatcher.executeTool('describe_tool', { tool_name: 'read_file' });
  assert.equal(describe.success, true, 'describe_tool is innate');

  const precall = await dispatcher.executeTool('batch_precall', { calls: [] });
  assert.equal(precall.success, true, 'batch_precall is innate');

  const denied = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(denied.success, false, 'the empty descriptor still denies non-innate tools');
  assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

// ============================================================================
// 4. Descriptor-less callers keep the legacy channels
// ============================================================================

test('12. descriptor-less callers keep bound/identity allowlists and bound privilege (76fb539)', async () => {
  // (a) bound allowlist only
  const boundOnly = createDispatcher(null, { allowedTools: ['write_file'] });
  const boundReceipt = await boundOnly.executeTool('write_file', { file_path: '/legacy.txt', content: 'x' });
  assert.equal(boundReceipt.success, true, 'a descriptor-less bound allowlist must still authorize');

  const boundDenied = await boundOnly.executeTool('delete_file', { file_path: '/legacy.txt' });
  assert.equal(boundDenied.success, false, 'a descriptor-less caller is still bounded by its allowlist');

  // (b) identity allowlist only
  const identityOnly = createDispatcher(createIdentity({ allowedTools: ['write_file'] }));
  const identityReceipt = await identityOnly.executeTool('write_file', { file_path: '/legacy.txt', content: 'x' });
  assert.equal(identityReceipt.success, true, 'a descriptor-less identity allowlist must still authorize');

  // (c) bound privilege bypass
  const privileged = createDispatcher(null, { isAdmin: true, allowedTools: [] });
  const privilegedReceipt = await privileged.executeTool('write_file', { file_path: '/legacy.txt', content: 'x' });
  assert.equal(privilegedReceipt.success, true, 'a descriptor-less bound privilege flag must still authorize');

  // (d) identity privilege projection
  const identityPrivileged = createDispatcher(createIdentity({ privileged: true, allowedTools: [] }));
  const identityPrivilegedReceipt = await identityPrivileged.executeTool(
    'write_file',
    { file_path: '/legacy.txt', content: 'x' }
  );
  assert.equal(
    identityPrivilegedReceipt.success,
    true,
    'a descriptor-less identity privilege projection must still authorize'
  );
});

test('13. descriptor-less callers still fail closed without any trusted grant (76fb539)', async () => {
  const anonymous = createSandboxToolDispatcher({ virtualFs: createVfsSpy() });
  const anonymousReceipt = await anonymous.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(anonymousReceipt.success, false, 'an anonymous dispatcher must default-deny');
  assert.equal(anonymousReceipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);

  const empty = createDispatcher(createIdentity({ allowedTools: [] }));
  const emptyReceipt = await empty.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(emptyReceipt.success, false, 'an empty descriptor-less allowlist must default-deny');
  assert.equal(emptyReceipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

// ============================================================================
// 5. Real registry descriptor path (AgentRuntime identity port)
// ============================================================================

test('14. the registry descriptor supersedes a wider dispatcher-bound allowlist (76fb539)', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'limited_agent', allowedTools: ['read_file'] });

    const vfs = createVfsSpy();
    const dispatcher = createSandboxToolDispatcher({
      agentId: 'limited_agent',
      allowedTools: ['read_file', 'write_file'],
      virtualFs: vfs,
      identityPort: runtime.createAgentIdentityPort()
    });

    const allowed = await dispatcher.executeTool('read_file', { file_path: '/runtime.txt' });
    assert.equal(allowed.success, true, 'the registry descriptor grant must authorize read_file');

    const denied = await dispatcher.executeTool('write_file', { file_path: '/runtime.txt', content: 'x' });
    assert.equal(denied.success, false, 'the wider bound allowlist must not widen the registry descriptor');
    assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
    assert.deepEqual(vfs.calls, ['read_file'], 'the denied write must never reach the substrate');
  } finally {
    runtime.destroy();
  }
});

// ============================================================================
// 6. A throwing capability probe denies (never escapes dispatch)
// ============================================================================

test('15. a descriptor whose allow.has throws denies with PERMISSION_DENIED, no unshielded throw (76fb539)', async () => {
  const vfs = createVfsSpy();
  const throwingAuthority = Object.freeze({
    subject: GATE_AGENT,
    kind: 'agent',
    allow: Object.freeze({
      has() {
        throw new Error('capability probe exploded');
      }
    }),
    visibility: 'owned'
  });

  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: ['write_file'], privileged: true, authority: throwingAuthority }),
    { virtualFs: vfs, isAdmin: true, allowedTools: ['write_file'] }
  );

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, false, 'a throwing capability probe must deny');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
  assert.deepEqual(vfs.calls, [], 'a denied call must never reach the substrate');
});

// ============================================================================
// 7. Throwing descriptor property accessors deny (never escape dispatch)
// ============================================================================

test('16. a throwing authority accessor denies with PERMISSION_DENIED, no unshielded throw (8716523)', async () => {
  const vfs = createVfsSpy();
  const identity = {
    id: GATE_AGENT,
    privileged: true,
    allowedTools: ['write_file'],
    get authority() {
      throw new Error('authority accessor exploded');
    }
  };

  const dispatcher = createDispatcher(identity, {
    virtualFs: vfs,
    isAdmin: true,
    allowedTools: ['write_file']
  });

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, false, 'a throwing authority accessor must deny');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
  assert.deepEqual(vfs.calls, [], 'a denied call must never reach the substrate');
});

test('17. a throwing allow accessor denies with PERMISSION_DENIED, no unshielded throw (8716523)', async () => {
  const vfs = createVfsSpy();
  const throwingAllowAuthority = {
    subject: GATE_AGENT,
    kind: 'agent',
    get allow() {
      throw new Error('allow accessor exploded');
    },
    visibility: 'owned'
  };

  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: ['write_file'], privileged: true, authority: throwingAllowAuthority }),
    { virtualFs: vfs, isAdmin: true, allowedTools: ['write_file'] }
  );

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, false, 'a throwing allow accessor must deny');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
  assert.deepEqual(vfs.calls, [], 'a denied call must never reach the substrate');
});

test('18. a throwing allow.has accessor denies with PERMISSION_DENIED, no unshielded throw (8716523)', async () => {
  const vfs = createVfsSpy();
  const throwingHasAuthority = {
    subject: GATE_AGENT,
    kind: 'agent',
    allow: {
      get has() {
        throw new Error('has accessor exploded');
      }
    },
    visibility: 'owned'
  };

  const dispatcher = createDispatcher(
    createIdentity({ allowedTools: ['write_file'], privileged: true, authority: throwingHasAuthority }),
    { virtualFs: vfs, isAdmin: true, allowedTools: ['write_file'] }
  );

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/gate.txt', content: 'x' });
  assert.equal(receipt.success, false, 'a throwing allow.has accessor must deny');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
  assert.deepEqual(vfs.calls, [], 'a denied call must never reach the substrate');
});

// ============================================================================
// 19. Wave U publishing meta tools: explicit-authority-only (ticket 2518510)
// ============================================================================

import { PUBLISHING_TOOLS } from '../../src/lib/sandbox/tools/constants/index.ts';
import { AGENT_AUTHORITIES } from '../../src/lib/sandbox/realmCatalog/index.ts';

/**
 * Builds a minimal publishing port that fails after the authorization gate.
 * @returns {object} Publishing port stub.
 */
function createPublishingPortStub() {
  return {
    importTemplate: () => {
      throw new Error('importTemplate must not be reached');
    },
    previewTemplateImport: () => {
      throw new Error('previewTemplateImport must not be reached');
    },
    getEffectiveTemplateBundle: () => null,
    storePendingInstancePayload: () => {
      throw new Error('storePendingInstancePayload must not be reached');
    }
  };
}

test('19. a wildcard/privileged descriptor never satisfies a publishing authority', async () => {
  const dispatcher = createDispatcher(
    createIdentity({ authority: createAuthority(['*']), privileged: true }),
    { isAdmin: true, privileged: true, allowedTools: ['*'], realmPublishingPort: createPublishingPortStub() }
  );

  const receipt = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: { formatVersion: 1, template: { formatVersion: 1, id: 'x', name: 'X', description: '', agents: [] }, files: {} }
  });
  assert.equal(receipt.success, false, 'the wildcard must not authorize a publishing meta tool');
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

test('20. the exact authority authorizes and reaches the handler; a different authority denies', async () => {
  const hydrationDispatcher = createDispatcher(
    createIdentity({ authority: createAuthority([AGENT_AUTHORITIES.HYDRATION]) }),
    { realmPublishingPort: createPublishingPortStub() }
  );
  const allowed = await hydrationDispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { templateId: 'ghost', inputs: {}, files: [] }
  });
  // The gate passed: the handler ran and reported its own typed failure.
  assert.equal(allowed.code, TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS);
  assert.match(allowed.error, /unknown realm template/);

  const cross = await hydrationDispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest: {}
  });
  assert.equal(cross.success, false);
  assert.equal(cross.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED, 'a hydration grant never authorizes import');
});

test('21. an engine-internal descriptor remains authorized and a throwing allow denies', async () => {
  const internal = createDispatcher(
    createIdentity({
      authority: Object.freeze({ subject: GATE_AGENT, kind: 'internal', allow: Object.freeze(new Set()), visibility: 'system' })
    }),
    { realmPublishingPort: createPublishingPortStub() }
  );
  const internalReceipt = await internal.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest: { templateId: 'ghost', inputs: {}, files: [] }
  });
  assert.equal(internalReceipt.code, TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS, 'internal descriptors pass the gate');

  const throwingAllow = {
    subject: GATE_AGENT,
    kind: 'agent',
    allow: {
      get has() {
        throw new Error('has accessor exploded');
      }
    },
    visibility: 'owned'
  };
  const throwing = createDispatcher(
    createIdentity({ authority: throwingAllow }),
    { realmPublishingPort: createPublishingPortStub() }
  );
  const denied = await throwing.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, { manifest: {} });
  assert.equal(denied.success, false);
  assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});
