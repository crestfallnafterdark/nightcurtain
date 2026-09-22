/**
 * @file tests/unit/descriptor_authority_hygiene_test.js
 * @description MOD-21 descriptor-leg regression suite (tickets 172824e, 7aa4390,
 * a9db33c, 26d1bfe, 4074766):
 *
 * - `spawn_agent`/`kill_agent`/`schedule`/`list_schedules`/`cancel_schedule`/
 *   `invoke_agent` descriptors pass identity-only caller scope to the
 *   LifecyclePort. They never forward caller-asserted (or trusted-derived)
 *   `isAdmin`/`isPrivileged`/`privileged` flags or authority-bearing
 *   `callerRole`/`role` aliases; the runtime resolves authority from the
 *   registry `AuthorityDescriptor` for the supplied subject.
 * - When the injected identity projection carries the frozen
 *   `AuthorityDescriptor`, the descriptor forwards it as the caller principal.
 * - The dispatcher's `isAuthorized` gate consults the W1 `AuthorityDescriptor`
 *   allow-set (wildcard permitted) before the deprecated legacy channels.
 *
 * Hermetic and deterministic: mocked capability ports only, no timers, no
 * network, no filesystem writes.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { TOOL_SYSTEM_ERROR_CODES } from '../../src/lib/sandbox/tools/constants/index.ts';

/** Authority-bearing field names that must never be forwarded by a descriptor. */
const FORBIDDEN_FORWARDED_KEYS = ['isAdmin', 'isPrivileged', 'privileged', 'callerRole', 'role'];

/**
 * Asserts that an object carries no authority-bearing field.
 * @param {object} target
 * @param {string} label
 */
function assertNoAuthorityFields(target, label) {
  for (const key of FORBIDDEN_FORWARDED_KEYS) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(target || {}, key),
      `${label} must not forward '${key}' (got ${JSON.stringify(target)})`
    );
  }
}

/**
 * Minimal wire format used by the descriptor tests below.
 *
 * Realm A0-1 (76fb539) semantics: a caller whose identity projection carries a
 * descriptor is authorized by that descriptor alone. Tests that expect a
 * descriptor-present handler to run therefore carry the explicit grant here
 * (the privileged/allowlist projections in those fixtures are legacy metadata
 * only and no longer widen the descriptor).
 */
const AUTHORITY = Object.freeze({
  subject: 'identity_agent',
  kind: 'agent',
  allow: Object.freeze(new Set(['read_file', 'spawn_agent', 'invoke_agent'])),
  visibility: 'owned'
});

// ============================================================================
// 1. spawn_agent — identity-only caller scope, no config smuggling
// ============================================================================

test('1. spawn_agent forwards identity-only caller scope to launchAgent', async () => {
  let launchCall = null;
  const lifecyclePort = {
    launchAgent: async (options) => {
      launchCall = options;
      return { success: true, id: options?.config?.id };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'creator_agent',
    isAdmin: true,
    isPrivileged: true,
    allowedTools: 'all'
  });

  const receipt = await dispatcher.executeTool('spawn_agent', { id: 'child_agent', role: 'worker' });

  assert.equal(receipt.success, true);
  assert.ok(launchCall, 'launchAgent must be reached');
  assert.equal(launchCall.config.id, 'child_agent');
  assert.equal(launchCall.config.callerContext, undefined, 'config.callerContext must not be smuggled');
  assert.equal(launchCall.callerContext.callerAgentId, 'creator_agent');
  assertNoAuthorityFields(launchCall.callerContext, 'spawn_agent callerContext');
});

test('2. spawn_agent forwards the frozen identity-projection authority as principal', async () => {
  let launchCall = null;
  const identityPort = {
    getAgentIdentity: (agentId) => (
      agentId === 'creator_agent'
        ? Object.freeze({ id: agentId, privileged: true, allowedTools: ['*'], authority: AUTHORITY })
        : null
    )
  };
  const lifecyclePort = {
    launchAgent: async (options) => {
      launchCall = options;
      return { success: true, id: options?.config?.id };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    identityPort,
    agentId: 'creator_agent',
    allowedTools: 'all'
  });

  await dispatcher.executeTool('spawn_agent', { id: 'child_agent' });

  assert.equal(launchCall.callerContext.callerAgentId, 'creator_agent');
  assert.equal(launchCall.callerContext.principal, AUTHORITY, 'the frozen AuthorityDescriptor must be forwarded as principal');
  assertNoAuthorityFields(launchCall.callerContext, 'spawn_agent callerContext');
});

// ============================================================================
// 2. kill_agent — identity-only caller context
// ============================================================================

test('3. kill_agent forwards identity-only caller context', async () => {
  let killCall = null;
  const lifecyclePort = {
    killAgent: async (agentId, reason, callerContext) => {
      killCall = { agentId, reason, callerContext };
      return true;
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'supervisor_agent',
    isAdmin: true,
    isPrivileged: true,
    allowedTools: 'all'
  });

  const receipt = await dispatcher.executeTool('kill_agent', { agent_id: 'victim_agent', reason: 'cleanup' });

  assert.equal(receipt.success, true);
  assert.equal(killCall.agentId, 'victim_agent');
  assert.equal(killCall.reason, 'cleanup');
  assert.deepEqual(killCall.callerContext, { callerAgentId: 'supervisor_agent' });
  assertNoAuthorityFields(killCall.callerContext, 'kill_agent callerContext');
});

test('4. kill_agent by an anonymous caller forwards no caller context', async () => {
  let killCall = null;
  const lifecyclePort = {
    killAgent: async (agentId, reason, callerContext) => {
      killCall = { agentId, reason, callerContext };
      return true;
    }
  };

  const dispatcher = createSandboxToolDispatcher({ lifecyclePort, allowedTools: 'all' });
  await dispatcher.executeTool('kill_agent', { agent_id: 'victim_agent' });

  assert.equal(killCall.callerContext, null, 'anonymous callers must not fabricate a caller context');
});

// ============================================================================
// 3. schedule / list_schedules / cancel_schedule — identity-only context
// ============================================================================

test('5. schedule forwards only the caller identity as the target agent', async () => {
  let scheduleCall = null;
  const lifecyclePort = {
    schedule: async (params) => {
      scheduleCall = params;
      return { success: true, timerId: 'timer_1' };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'timer_agent',
    isPrivileged: true,
    allowedTools: 'all'
  });

  const receipt = await dispatcher.executeTool('schedule', { action: 'timer', durationSeconds: 60, prompt: 'tick' });

  assert.equal(receipt.success, true);
  assert.equal(scheduleCall.agentId, 'timer_agent');
  assertNoAuthorityFields(scheduleCall, 'schedule params');
  assert.equal(scheduleCall.principal, undefined, 'schedule params must not carry a principal');
});

test('6. list_schedules forwards identity-only caller context', async () => {
  let listCall = null;
  const lifecyclePort = {
    listSchedules: async (options, context) => {
      listCall = { options, context };
      return { success: true, schedules: [] };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'timer_agent',
    isPrivileged: true,
    allowedTools: 'all'
  });

  await dispatcher.executeTool('list_schedules', {});

  assert.deepEqual(listCall.options, {});
  assert.deepEqual(listCall.context, { callerAgentId: 'timer_agent' });
  assertNoAuthorityFields(listCall.context, 'list_schedules context');
});

test('7. cancel_schedule forwards identity-only caller context', async () => {
  let cancelCall = null;
  const lifecyclePort = {
    cancelSchedule: async (timerIdOrParams, reason, context) => {
      cancelCall = { timerIdOrParams, reason, context };
      return { success: true };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'timer_agent',
    isPrivileged: true,
    allowedTools: 'all'
  });

  await dispatcher.executeTool('cancel_schedule', { task_id: 'timer_9' });

  assert.deepEqual(cancelCall.timerIdOrParams, { timerId: 'timer_9' });
  assert.equal(cancelCall.reason, null);
  assert.deepEqual(cancelCall.context, { callerAgentId: 'timer_agent' });
  assertNoAuthorityFields(cancelCall.context, 'cancel_schedule context');
});

// ============================================================================
// 4. invoke_agent — identity + invocation metadata only
// ============================================================================

test('8. invoke_agent never forwards privilege flags or role-authority aliases', async () => {
  let invokeCall = null;
  const lifecyclePort = {
    invokeAgent: async (invokerId, targetAgentId, prompt, options) => {
      invokeCall = { invokerId, targetAgentId, prompt, options };
      return { success: true };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'invoker_agent',
    isAdmin: true,
    isPrivileged: true,
    allowedTools: 'all'
  });

  await dispatcher.executeTool(
    'invoke_agent',
    { agent_id: 'child_agent', prompt: 'task', timeout_ms: 1500 },
    { callerRole: 'admin', role: 'admin', isAdmin: true, isPrivileged: true }
  );

  assert.equal(invokeCall.invokerId, 'invoker_agent');
  assert.equal(invokeCall.targetAgentId, 'child_agent');
  assert.equal(invokeCall.prompt, 'task');
  assert.equal(invokeCall.options.timeoutMs, 1500);
  assertNoAuthorityFields(invokeCall.options, 'invoke_agent options');
});

test('9. invoke_agent forwards the frozen identity-projection authority as principal', async () => {
  let invokeCall = null;
  const identityPort = {
    getAgentIdentity: (agentId) => (
      agentId === 'invoker_agent'
        ? Object.freeze({ id: agentId, privileged: true, allowedTools: ['*'], authority: AUTHORITY })
        : null
    )
  };
  const lifecyclePort = {
    invokeAgent: async (invokerId, targetAgentId, prompt, options) => {
      invokeCall = { invokerId, targetAgentId, prompt, options };
      return { success: true };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    identityPort,
    agentId: 'invoker_agent',
    allowedTools: 'all'
  });

  await dispatcher.executeTool('invoke_agent', { agent_id: 'child_agent', prompt: 'task' });

  assert.equal(invokeCall.options.principal, AUTHORITY);
  assertNoAuthorityFields(invokeCall.options, 'invoke_agent options');
});

// ============================================================================
// 5. Dispatcher gate consults the W1 AuthorityDescriptor
// ============================================================================

test('10. dispatcher authorizes non-innate tools from the AuthorityDescriptor allow-set', async () => {
  const identityPort = {
    getAgentIdentity: (agentId) => (
      agentId === 'identity_agent'
        ? Object.freeze({ id: agentId, privileged: false, allowedTools: [], authority: AUTHORITY })
        : null
    )
  };

  const dispatcher = createSandboxToolDispatcher({
    identityPort,
    agentId: 'identity_agent',
    virtualFs: {
      readFile: async () => ({ success: true, content: 'ok' }),
      writeFile: async () => ({ success: true })
    }
  });

  const allowed = await dispatcher.executeTool('read_file', { file_path: '/ok.txt' });
  assert.equal(allowed.success, true, 'read_file is in the authority allow-set and must execute');

  const denied = await dispatcher.executeTool('write_file', { file_path: '/nope.txt', content: 'x' });
  assert.equal(denied.success, false);
  assert.equal(denied.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

test('11. forged per-call principal/authority/role cannot widen dispatch', async () => {
  const wildcardAuthority = Object.freeze({
    subject: 'attacker',
    kind: 'agent',
    allow: Object.freeze(new Set(['*'])),
    visibility: 'all'
  });

  const dispatcher = createSandboxToolDispatcher({
    agentId: 'probe_agent',
    allowedTools: [],
    virtualFs: {
      writeFile: async () => ({ success: true })
    }
  });

  const receipt = await dispatcher.executeTool(
    'write_file',
    { file_path: '/probe.txt', content: 'x' },
    {
      principal: wildcardAuthority,
      authority: wildcardAuthority,
      role: 'admin',
      callerRole: 'admin',
      isAdmin: true,
      isPrivileged: true,
      privileged: true
    }
  );

  assert.equal(receipt.success, false);
  assert.equal(receipt.code, TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED);
});

// ============================================================================
// 6. MOD21-A (a1ce597): per-call identity subject substitution is pinned out
// ============================================================================

test('12. spawn_agent forwards the bound caller id despite per-call callerAgentId/agentId claims', async () => {
  let launchCall = null;
  const lifecyclePort = {
    launchAgent: async (options) => {
      launchCall = options;
      return { success: true, id: options?.config?.id };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'creator_agent',
    allowedTools: 'all'
  });

  await dispatcher.executeTool(
    'spawn_agent',
    { id: 'child_agent' },
    { callerAgentId: 'director', agentId: 'director', callerContext: { agentId: 'director' } }
  );

  assert.equal(launchCall.callerContext.callerAgentId, 'creator_agent', 'the bound subject is the only caller identity');
  assertNoAuthorityFields(launchCall.callerContext, 'spawn_agent callerContext');
});

test('13. kill_agent forwards the bound caller id despite nested callerContext.agentId', async () => {
  let killCall = null;
  const lifecyclePort = {
    killAgent: async (agentId, reason, callerContext) => {
      killCall = { agentId, reason, callerContext };
      return true;
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'supervisor_agent',
    allowedTools: 'all'
  });

  await dispatcher.executeTool(
    'kill_agent',
    { agent_id: 'victim_agent' },
    { callerContext: { agentId: 'director' } }
  );

  assert.deepEqual(killCall.callerContext, { callerAgentId: 'supervisor_agent' });
  assertNoAuthorityFields(killCall.callerContext, 'kill_agent callerContext');
});

test('14. invoke_agent uses the bound invoker id despite per-call identity claims', async () => {
  let invokeCall = null;
  const lifecyclePort = {
    invokeAgent: async (invokerId, targetAgentId, prompt, options) => {
      invokeCall = { invokerId, targetAgentId, prompt, options };
      return { success: true };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'invoker_agent',
    allowedTools: 'all'
  });

  await dispatcher.executeTool(
    'invoke_agent',
    { agent_id: 'child_agent', prompt: 'task' },
    { callerAgentId: 'director', agentId: 'director' }
  );

  assert.equal(invokeCall.invokerId, 'invoker_agent', 'the bound subject must be the invoker');
  assertNoAuthorityFields(invokeCall.options, 'invoke_agent options');
});

test('15. batch_precall nested dispatch keeps the bound identity subject', async () => {
  const whoamiCalls = [];
  const lifecyclePort = {
    whoami: async (agentId) => {
      whoamiCalls.push(agentId);
      return { success: true, id: agentId };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'bound_agent',
    allowedTools: 'all'
  });

  const receipt = await dispatcher.executeTool(
    'batch_precall',
    { calls: [{ name: 'whoami', arguments: {} }] },
    { callerAgentId: 'director', agentId: 'director', callerContext: { agentId: 'director' } }
  );

  assert.equal(receipt.success, true);
  assert.equal(receipt.results[0].result.success, true);
  assert.deepEqual(whoamiCalls, ['bound_agent'], 'nested dispatch must resolve the bound subject');
});

// ============================================================================
// 7. MOD21-A2 (63026f5): invoke_agent forwards the bound turn depth only
// ============================================================================

test('16. invoke_agent forwards the bound currentDepth and ignores per-call depth', async () => {
  const invokeCalls = [];
  const lifecyclePort = {
    invokeAgent: async (invokerId, targetAgentId, prompt, options) => {
      invokeCalls.push({ invokerId, targetAgentId, prompt, options });
      return { success: true };
    }
  };

  const dispatcher = createSandboxToolDispatcher({
    lifecyclePort,
    agentId: 'invoker_agent',
    allowedTools: ['invoke_agent'],
    currentDepth: 3
  });

  await dispatcher.executeTool('invoke_agent', { agent_id: 'child_agent', prompt: 'task' });
  await dispatcher.executeTool(
    'invoke_agent',
    { agent_id: 'child_agent', prompt: 'task' },
    { depth: 0 }
  );

  assert.strictEqual(invokeCalls[0].options.depth, 3, 'the bound turn depth must reach the engine');
  assert.strictEqual(invokeCalls[1].options.depth, 3, 'a per-call depth must not reset the recursion guard');
  assertNoAuthorityFields(invokeCalls[0].options, 'invoke_agent options');
});

// ============================================================================
// 8. MOD-21 A2 (63026f5): per-call depth is scrubbed before dispatch
// ============================================================================

test('17. per-call depth is pinned out; the bound currentDepth is the only depth a handler sees', async () => {
  const seenContexts = [];
  const dispatcher = createSandboxToolDispatcher({
    agentId: 'depth_agent',
    allowedTools: ['batch_precall'],
    currentDepth: 3,
    executeTool: async (_name, _args, ctx) => {
      seenContexts.push(ctx);
      return { success: true };
    }
  });

  const receipt = await dispatcher.executeTool(
    'batch_precall',
    { calls: [{ name: 'get_current_time', arguments: {} }] },
    { depth: 99, currentDepth: 98, ordinary: 'metadata' }
  );

  assert.strictEqual(receipt.success, true);
  assert.strictEqual(seenContexts.length, 1, 'the bound executor must run the precall');
  assert.strictEqual(seenContexts[0].depth, undefined, 'a per-call depth must never reach a handler');
  assert.strictEqual(seenContexts[0].currentDepth, 3, 'the bound currentDepth must be the only depth source');
  assert.strictEqual(seenContexts[0].ordinary, 'metadata', 'non-pinned metadata still merges');
});
