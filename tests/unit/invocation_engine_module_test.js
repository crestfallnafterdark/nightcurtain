/**
 * @file tests/unit/invocation_engine_module_test.js
 * @description Comprehensive isolated unit and contract test suite for Module 5: InvocationEngine.
 *
 * Verifies strict ICD compliance and architectural guarantees:
 *   1. Strict Export Whitelist & Constant Immutability
 *   2. Direct RPC Dispatch & Parameter Normalization
 *   3. Authority Security Governance (Sudoer, Parent Creator, Self, Peer Rejection)
 *   4. Hard Recursion Guard (Max Depth = 5)
 *   5. Dedicated Secondary Token Streaming & Event Isolation
 *   6. Turn-Level Await Primitive (Single/Multi UUIDs, Barrier vs Race, Timeouts, AbortSignal)
 *   7. Lifecycle Fault Isolation & Agent Termination Cleanup
 *   8. Encapsulated State Integrity & Memory Leak Prevention
 *  18. Wave I canonical identity: realm-local ids, bare receipts, await auth
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as InvocationEngineModule from '../../src/lib/sandbox/invocationEngine/index.ts';
import {
  InvocationEngine,
  MAX_INVOCATION_DEPTH,
  DEFAULT_INVOCATION_TIMEOUT_MS,
  INVOCATION_STATUS,
  INVOCATION_ERROR_CODES
} from '../../src/lib/sandbox/invocationEngine/index.ts';
import { createAgentIdentityKey } from '../../src/lib/sandbox/runtime/agent/index.ts';

/**
 * Converted module contract source (`invocationEngine/index.ts`); the error-code
 * surface is a type-only contract, so the removal assertion below is necessarily
 * a static contract check.
 */
const ENGINE_CONTRACT_PATH = path.resolve(
  import.meta.dirname,
  '../../src/lib/sandbox/invocationEngine/index.ts'
);

/**
 * MOD-21 test authority (default-deny): only `director` holds the wildcard
 * allow set through the injected registry resolver; every other invoker id is
 * anonymous unless a test supplies its own `getAgentAuthority`.
 */
const DIRECTOR_AUTHORITY = Object.freeze({
  subject: 'director',
  kind: 'agent',
  allow: new Set(['*']),
  visibility: 'all'
});
const getAgentAuthority = (id) => (id === 'director' ? DIRECTOR_AUTHORITY : null);

// ============================================================================
// 1. Strict Export Whitelist & Constants Immutability
// ============================================================================

test('1. Strict Export Whitelist & Constants Immutability', () => {
  const exportedKeys = Object.keys(InvocationEngineModule).sort();
  assert.deepStrictEqual(
    exportedKeys,
    [
      'DEFAULT_INVOCATION_TIMEOUT_MS',
      'INVOCATION_ERROR_CODES',
      'INVOCATION_STATUS',
      'InvocationEngine',
      'MAX_INVOCATION_DEPTH'
    ].sort()
  );

  // Constants verification
  assert.strictEqual(MAX_INVOCATION_DEPTH, 5);
  assert.strictEqual(DEFAULT_INVOCATION_TIMEOUT_MS, 10000);

  // Status Enum verification & immutability
  assert.strictEqual(INVOCATION_STATUS.PENDING, 'pending');
  assert.strictEqual(INVOCATION_STATUS.RUNNING, 'running');
  assert.strictEqual(INVOCATION_STATUS.COMPLETED, 'completed');
  assert.strictEqual(INVOCATION_STATUS.ERROR, 'error');
  assert.strictEqual(INVOCATION_STATUS.TIMED_OUT, 'timed_out');
  assert.strictEqual(INVOCATION_STATUS.CANCELLED, 'cancelled');
  assert.ok(Object.isFrozen(INVOCATION_STATUS), 'INVOCATION_STATUS must be frozen');

  // Error Codes Enum verification & immutability
  assert.strictEqual(INVOCATION_ERROR_CODES.INVALID_ARGUMENTS, 'INVALID_ARGUMENTS');
  assert.strictEqual(INVOCATION_ERROR_CODES.AGENT_NOT_FOUND, 'AGENT_NOT_FOUND');
  assert.strictEqual(INVOCATION_ERROR_CODES.AGENT_TERMINATED, 'AGENT_TERMINATED');
  assert.strictEqual(INVOCATION_ERROR_CODES.PERMISSION_DENIED, 'PERMISSION_DENIED');
  assert.strictEqual(INVOCATION_ERROR_CODES.RECURSION_DEPTH_EXCEEDED, 'RECURSION_DEPTH_EXCEEDED');
  assert.strictEqual(INVOCATION_ERROR_CODES.ABORTED, 'ABORTED');
  assert.deepStrictEqual(
    Object.keys(INVOCATION_ERROR_CODES).sort(),
    [
      'ABORTED',
      'AGENT_NOT_FOUND',
      'AGENT_TERMINATED',
      'INVALID_ARGUMENTS',
      'PERMISSION_DENIED',
      'RECURSION_DEPTH_EXCEEDED'
    ],
    'ENGINE_UNAVAILABLE was never emitted and was removed; facade availability errors surface as ERR_RUNTIME_NOT_INITIALIZED'
  );
  assert.ok(Object.isFrozen(INVOCATION_ERROR_CODES), 'INVOCATION_ERROR_CODES must be frozen');
});

test('1b. Contract: ENGINE_UNAVAILABLE is absent from the invocation contract', () => {
  const contractSource = fs.readFileSync(ENGINE_CONTRACT_PATH, 'utf-8');

  assert.doesNotMatch(
    contractSource,
    /ENGINE_UNAVAILABLE/,
    'engine unavailability is a facade concern (ERR_RUNTIME_NOT_INITIALIZED), not an InvocationEngine error code'
  );
});

// ============================================================================
// 2. Constructor, Initial State & Runtime Hooks
// ============================================================================

test('2. Constructor, Initial State & Runtime Hooks', async () => {
  const defaultEngine = new InvocationEngine({ getAgentAuthority });
  assert.strictEqual(defaultEngine.getActiveInvocations().length, 0);
  assert.strictEqual(defaultEngine.getInvocationHistory().length, 0);
  assert.strictEqual(defaultEngine.getInvocation('non_existent'), null);

  // Default engine has no executeTurn hook: dispatch settles with an empty output
  const noHookReceipt = defaultEngine.invokeAgent('director', 'worker', 'No hooks configured');
  const noHookResult = await defaultEngine.waitForInvocation(noHookReceipt.invocationId);
  assert.strictEqual(noHookResult.success, true);
  assert.strictEqual(noHookResult.results[0].status, INVOCATION_STATUS.COMPLETED);
  assert.strictEqual(noHookResult.results[0].output, '');
  assert.strictEqual(defaultEngine.getActiveInvocations().length, 0);
  assert.strictEqual(defaultEngine.getInvocationHistory().length, 1);

  // Constructor hooks are observable through invokeAgent gating and turn dispatch
  const customExecute = async () => ({ output: 'custom' });
  const customGetAgent = (id) => (id === 'ghost' ? null : { id, role: 'worker', state: 'idle' });
  const customIsTerminated = (id) => id === 'dead';

  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: customExecute,
    getAgent: customGetAgent,
    isAgentTerminated: customIsTerminated
  });

  // isAgentTerminated hook rejects terminated targets
  const terminatedResult = engine.invokeAgent('director', 'dead', 'Hello');
  assert.strictEqual(terminatedResult.success, false);
  assert.strictEqual(terminatedResult.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);

  // getAgent hook gates unknown targets
  const notFoundResult = engine.invokeAgent('director', 'ghost', 'Hello');
  assert.strictEqual(notFoundResult.success, false);
  assert.strictEqual(notFoundResult.code, INVOCATION_ERROR_CODES.AGENT_NOT_FOUND);

  // executeTurn hook drives the produced output
  const customReceipt = engine.invokeAgent('director', 'worker', 'Run custom hook');
  const customResult = await engine.waitForInvocation(customReceipt.invocationId);
  assert.strictEqual(customResult.results[0].output, 'custom');

  // setRuntimeHooks updates dynamically; unspecified hooks are retained
  const updatedExecute = async () => 'updated';
  engine.setRuntimeHooks({ executeTurn: updatedExecute });

  const updatedReceipt = engine.invokeAgent('director', 'worker', 'Run updated hook');
  const updatedResult = await engine.waitForInvocation(updatedReceipt.invocationId);
  assert.strictEqual(updatedResult.results[0].output, 'updated');

  assert.strictEqual(engine.invokeAgent('director', 'dead', 'Hello').code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);
  assert.strictEqual(engine.invokeAgent('director', 'ghost', 'Hello').code, INVOCATION_ERROR_CODES.AGENT_NOT_FOUND);

  // setRuntimeHooks gracefully handles undefined/empty/null without clearing prior hooks
  engine.setRuntimeHooks(null);
  engine.setRuntimeHooks(undefined);
  engine.setRuntimeHooks({});

  const afterNullReceipt = engine.invokeAgent('director', 'worker', 'Still updated');
  const afterNullResult = await engine.waitForInvocation(afterNullReceipt.invocationId);
  assert.strictEqual(afterNullResult.results[0].output, 'updated');
});

// ============================================================================
// 3. Direct RPC & Argument Validation
// ============================================================================

test('3. invokeAgent argument validation and parameter polymorphism', async () => {
  const engine = new InvocationEngine({ getAgentAuthority });

  // Missing invokerId
  const r1 = engine.invokeAgent({ targetAgentId: 'worker', prompt: 'Hello' });
  assert.strictEqual(r1.success, false);
  assert.strictEqual(r1.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);
  assert.ok(r1.error.includes('invokerId'));

  // Empty whitespace invokerId
  const r2 = engine.invokeAgent({ invokerId: '   ', targetAgentId: 'worker', prompt: 'Hello' });
  assert.strictEqual(r2.success, false);
  assert.strictEqual(r2.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);

  // Missing targetAgentId
  const r3 = engine.invokeAgent({ invokerId: 'director', prompt: 'Hello' });
  assert.strictEqual(r3.success, false);
  assert.strictEqual(r3.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);
  assert.ok(r3.error.includes('targetAgentId'));

  // Missing prompt
  const r4 = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'worker' });
  assert.strictEqual(r4.success, false);
  assert.strictEqual(r4.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);
  assert.ok(r4.error.includes('prompt'));

  // Empty whitespace prompt
  const r5 = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'worker', prompt: '   ' });
  assert.strictEqual(r5.success, false);
  assert.strictEqual(r5.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);

  // Positional signature: invokeAgent(invokerId, targetAgentId, prompt, options)
  engine.setRuntimeHooks({
    executeTurn: async (target, prompt) => `Echo ${target}: ${prompt}`
  });
  const rPos = engine.invokeAgent('director', 'worker', 'Positional prompt', { depth: 0 });
  assert.strictEqual(rPos.success, true);
  assert.strictEqual(rPos.status, 'dispatched');
  assert.ok(rPos.invocationId.startsWith('inv_'));
  assert.strictEqual(rPos.targetAgentId, 'worker');

  const waitPos = await engine.waitForInvocation(rPos.invocationId);
  assert.strictEqual(waitPos.success, true);
  assert.strictEqual(waitPos.results[0].output, 'Echo worker: Positional prompt');

  // Canonical structured InvokeAgentParams surface
  const rParams1 = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Canonical params 1'
  });
  assert.strictEqual(rParams1.success, true);
  const waitParams1 = await engine.waitForInvocation(rParams1.invocationId);
  assert.strictEqual(waitParams1.results[0].output, 'Echo worker: Canonical params 1');

  // Canonical execution options carried on the params envelope (depth, role, timeoutMs)
  const rParams2 = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Canonical params 2',
    depth: 1,
    role: 'system',
    timeoutMs: 5000
  });
  assert.strictEqual(rParams2.success, true);
  const waitParams2 = await engine.waitForInvocation(rParams2.invocationId);
  assert.strictEqual(waitParams2.results[0].output, 'Echo worker: Canonical params 2');

  // Removed undocumented aliases (invokingAgentId, target_agent_id, instruction) are rejected
  const rAlias1 = engine.invokeAgent({
    invokingAgentId: 'director',
    target_agent_id: 'worker',
    instruction: 'Alias instruction 1'
  });
  assert.strictEqual(rAlias1.success, false);
  assert.strictEqual(rAlias1.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);

  // Removed undocumented aliases (callerAgentId, agentId, message) are rejected
  const rAlias2 = engine.invokeAgent({
    callerAgentId: 'director',
    agentId: 'worker',
    message: 'Alias message 2'
  });
  assert.strictEqual(rAlias2.success, false);
  assert.strictEqual(rAlias2.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);
});

// ============================================================================
// 4. Authority Security Governance
// ============================================================================
test('4. Authority Security Governance (Registry Descriptor, Parent Creator, Self, Peer Rejection)', () => {
  const agents = {
    director: { id: 'director', role: 'admin' },
    sudo_bot: { id: 'sudo_bot' },
    admin_bot: { id: 'admin_bot', privileged: true },
    config_admin: { id: 'config_admin', config: { role: 'admin' } },
    config_priv: { id: 'config_priv', config: { privileged: true } },
    parent: { id: 'parent', role: 'worker' },
    child_spawned: { id: 'child_spawned', spawnedBy: 'parent' },
    child_created: { id: 'child_created', creatorId: 'parent' },
    child_config_spawned: { id: 'child_config_spawned', config: { spawnedBy: 'parent' } },
    child_config_created: { id: 'child_config_created', config: { creatorId: 'parent' } },
    peer_alice: { id: 'peer_alice', role: 'worker' },
    peer_bob: { id: 'peer_bob', role: 'worker' }
  };
  const sudoBotAuthority = Object.freeze({
    subject: 'sudo_bot',
    kind: 'agent',
    allow: new Set(['@lifecycle:authority']),
    visibility: 'all'
  });

  const engine = new InvocationEngine({
    getAgent: (id) => agents[id] || null,
    getAgentAuthority: (id) => {
      if (id === 'sudo_bot') return sudoBotAuthority;
      return getAgentAuthority(id);
    }
  });

  // 1. Registry descriptor authority: wildcard and explicit capability
  assert.strictEqual(engine.invokeAgent({ invokerId: 'director', targetAgentId: 'peer_alice', prompt: 'P' }).success, true);
  assert.strictEqual(engine.invokeAgent({ invokerId: 'sudo_bot', targetAgentId: 'peer_alice', prompt: 'P' }).success, true);

  // 2. Caller-asserted flags, roles, and reserved ids do NOT elevate
  for (const forged of [
    { isAdmin: true },
    { privileged: true },
    { isPrivileged: true },
    { callerRole: 'admin' },
    { role: 'admin' }
  ]) {
    const receipt = engine.invokeAgent({ invokerId: 'peer_alice', targetAgentId: 'peer_bob', prompt: 'P', ...forged });
    assert.strictEqual(receipt.success, false, `forged ${JSON.stringify(forged)} must not elevate`);
    assert.strictEqual(receipt.code, INVOCATION_ERROR_CODES.PERMISSION_DENIED);
  }
  const magicAdmin = engine.invokeAgent({ invokerId: 'admin', targetAgentId: 'peer_alice', prompt: 'P' });
  assert.strictEqual(magicAdmin.success, false, "magic id 'admin' grants nothing");

  // 3. Legacy config privilege/role no longer confers authority
  assert.strictEqual(
    engine.invokeAgent({ invokerId: 'admin_bot', targetAgentId: 'peer_alice', prompt: 'P' }).code,
    INVOCATION_ERROR_CODES.PERMISSION_DENIED
  );
  assert.strictEqual(
    engine.invokeAgent({ invokerId: 'config_admin', targetAgentId: 'peer_alice', prompt: 'P' }).code,
    INVOCATION_ERROR_CODES.PERMISSION_DENIED
  );
  assert.strictEqual(
    engine.invokeAgent({ invokerId: 'config_priv', targetAgentId: 'peer_alice', prompt: 'P' }).code,
    INVOCATION_ERROR_CODES.PERMISSION_DENIED
  );

  // 4. Self invocation
  assert.strictEqual(engine.invokeAgent({ invokerId: 'peer_alice', targetAgentId: 'peer_alice', prompt: 'Self P' }).success, true);

  // 5. Parent Creator invocation (spawnedBy & creatorId top-level and config)
  assert.strictEqual(engine.invokeAgent({ invokerId: 'parent', targetAgentId: 'child_spawned', prompt: 'P' }).success, true);
  assert.strictEqual(engine.invokeAgent({ invokerId: 'parent', targetAgentId: 'child_created', prompt: 'P' }).success, true);
  assert.strictEqual(engine.invokeAgent({ invokerId: 'parent', targetAgentId: 'child_config_spawned', prompt: 'P' }).success, true);
  assert.strictEqual(engine.invokeAgent({ invokerId: 'parent', targetAgentId: 'child_config_created', prompt: 'P' }).success, true);

  // 6. Unauthorized arbitrary peer invocation rejected with PERMISSION_DENIED
  const rejected = engine.invokeAgent({ invokerId: 'peer_alice', targetAgentId: 'peer_bob', prompt: 'Illegal call' });
  assert.strictEqual(rejected.success, false);
  assert.strictEqual(rejected.code, INVOCATION_ERROR_CODES.PERMISSION_DENIED);
  assert.ok(rejected.error.includes("Permission denied: agent 'peer_alice' cannot invoke arbitrary peer agent 'peer_bob'"));
});

test('4.1 role/callerRole are never authority aliases; role selects the turn role only', async () => {
  const capturedRoles = [];
  const agents = {
    sudo_caller: { id: 'sudo_caller' },
    plain_caller: { id: 'plain_caller' },
    target: { id: 'target' }
  };
  const sudoCallerAuthority = Object.freeze({
    subject: 'sudo_caller',
    kind: 'agent',
    allow: new Set(['*']),
    visibility: 'all'
  });

  const engine = new InvocationEngine({
    getAgent: (id) => agents[id] || null,
    getAgentAuthority: (id) => (id === 'sudo_caller' ? sudoCallerAuthority : null),
    executeTurn: async (agent, prompt, ctx) => {
      capturedRoles.push(ctx.role);
      return 'done';
    }
  });

  const adminReceipt = engine.invokeAgent({
    invokerId: 'sudo_caller',
    targetAgentId: 'target',
    prompt: 'Admin-looking turn role',
    role: 'admin'
  });
  assert.strictEqual(adminReceipt.success, true, 'registry authority authorizes the call');

  const systemReceipt = engine.invokeAgent({
    invokerId: 'sudo_caller',
    targetAgentId: 'target',
    prompt: 'System turn',
    callerRole: 'admin',
    role: 'system'
  });
  assert.strictEqual(systemReceipt.success, true);

  await engine.waitForInvocation([adminReceipt.invocationId, systemReceipt.invocationId]);
  assert.deepStrictEqual(capturedRoles, ['user', 'system'], "'admin' must not leak into the execution turn role");

  // An unprivileged caller cannot buy authority with role aliases.
  const denied = engine.invokeAgent({
    invokerId: 'plain_caller',
    targetAgentId: 'target',
    prompt: 'Alias elevation attempt',
    role: 'admin',
    callerRole: 'admin'
  });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.code, INVOCATION_ERROR_CODES.PERMISSION_DENIED);
});
// ============================================================================
// 5. Agent Lifecycle & Existence Validation
// ============================================================================

test('5. Agent lifecycle and existence gates (AGENT_NOT_FOUND, AGENT_TERMINATED)', () => {
  const agents = {
    alive: { id: 'alive', role: 'worker' },
    dead_state: { id: 'dead_state', state: 'terminated' },
    recycled_state: { id: 'recycled_state', state: 'recycled' },
    dead_flag: { id: 'dead_flag', terminated: true },
    dead_status: { id: 'dead_status', status: 'Terminated' }
  };

  const engine = new InvocationEngine({ getAgentAuthority,
    getAgent: (id) => agents[id] || null,
    isAgentTerminated: (id) => id === 'hook_dead'
  });

  // Agent not found
  const rNotFound = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'ghost_agent', prompt: 'P' });
  assert.strictEqual(rNotFound.success, false);
  assert.strictEqual(rNotFound.code, INVOCATION_ERROR_CODES.AGENT_NOT_FOUND);
  assert.ok(rNotFound.error.includes("Target agent 'ghost_agent' not found"));

  // Target terminated via isAgentTerminated hook
  const rHookDead = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'hook_dead', prompt: 'P' });
  assert.strictEqual(rHookDead.success, false);
  assert.strictEqual(rHookDead.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);
  assert.ok(rHookDead.error.includes("Cannot invoke terminated agent 'hook_dead'"));

  // Target terminated via state: 'terminated'
  const rDeadState = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'dead_state', prompt: 'P' });
  assert.strictEqual(rDeadState.success, false);
  assert.strictEqual(rDeadState.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);

  // Target terminated via state: 'recycled'
  const rRecycled = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'recycled_state', prompt: 'P' });
  assert.strictEqual(rRecycled.success, false);
  assert.strictEqual(rRecycled.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);

  // Target terminated via terminated: true
  const rDeadFlag = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'dead_flag', prompt: 'P' });
  assert.strictEqual(rDeadFlag.success, false);
  assert.strictEqual(rDeadFlag.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);

  // Target terminated via status: 'Terminated'
  const rDeadStatus = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'dead_status', prompt: 'P' });
  assert.strictEqual(rDeadStatus.success, false);
  assert.strictEqual(rDeadStatus.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);
});

// ============================================================================
// 6. Hard Recursion Guard (Ceiling = 5)
// ============================================================================

test('6. Hard Recursion Guard rejects depth > 5 with RECURSION_DEPTH_EXCEEDED', async () => {
  let capturedDepth = null;
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (agent, prompt, ctx) => {
      capturedDepth = ctx.depth;
      return `Depth ${ctx.depth}`;
    }
  });

  // Depths 0 through 4 succeed (resulting depth 1 through 5)
  for (let incoming = 0; incoming <= 4; incoming++) {
    const res = engine.invokeAgent({
      invokerId: 'director',
      targetAgentId: 'worker',
      prompt: `Depth test ${incoming}`,
      depth: incoming
    });
    assert.strictEqual(res.success, true);
    const wait = await engine.waitForInvocation(res.invocationId);
    assert.strictEqual(wait.results[0].output, `Depth ${incoming + 1}`);
    assert.strictEqual(capturedDepth, incoming + 1);
  }

  // Incoming depth 5 (resulting depth 6) is rejected
  const res5 = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Too deep',
    depth: 5
  });
  assert.strictEqual(res5.success, false);
  assert.strictEqual(res5.code, INVOCATION_ERROR_CODES.RECURSION_DEPTH_EXCEEDED);
  assert.strictEqual(res5.error, `Recursion depth limit exceeded (max ${MAX_INVOCATION_DEPTH})`);

  // Incoming depth 6 via recursionDepth alias is rejected
  const res6 = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Too deep alias',
    recursionDepth: 6
  });
  assert.strictEqual(res6.success, false);
  assert.strictEqual(res6.code, INVOCATION_ERROR_CODES.RECURSION_DEPTH_EXCEEDED);
});

test('6.1 Depth lower bound: negative or non-integer depths are rejected with INVALID_ARGUMENTS', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (agent, prompt, ctx) => `Depth ${ctx.depth}`
  });

  for (const badDepth of [-1, -5, 0.5, NaN]) {
    const res = engine.invokeAgent({
      invokerId: 'director',
      targetAgentId: 'worker',
      prompt: `Bad depth ${badDepth}`,
      depth: badDepth
    });
    assert.strictEqual(res.success, false, `depth ${badDepth} must be rejected`);
    assert.strictEqual(res.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);
    assert.ok(res.error.includes('depth'), 'rejection must name the invalid depth field');
  }

  // A negative alias value is rejected too
  const aliasRes = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Bad alias depth',
    recursionDepth: -2
  });
  assert.strictEqual(aliasRes.success, false);
  assert.strictEqual(aliasRes.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);

  // Valid depth 0 still executes at resulting depth 1
  const okRes = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Valid zero depth',
    depth: 0
  });
  assert.strictEqual(okRes.success, true);
  const waitRes = await engine.waitForInvocation(okRes.invocationId);
  assert.strictEqual(waitRes.results[0].output, 'Depth 1');
});

// ============================================================================
// 7. Microtask Turn Execution & Output Normalization
// ============================================================================

test('7. Turn execution output normalization (object.output, object.content, string, primitives, exceptions)', async () => {
  const engine = new InvocationEngine({ getAgentAuthority });

  // 1. Returns { output: string }
  engine.setRuntimeHooks({ executeTurn: async () => ({ output: 'from_output_prop' }) });
  const r1 = engine.invokeAgent('director', 'w1', 'P');
  const w1 = await engine.waitForInvocation(r1.invocationId);
  assert.strictEqual(w1.results[0].output, 'from_output_prop');
  assert.strictEqual(w1.results[0].status, INVOCATION_STATUS.COMPLETED);

  // 2. Returns { content: string }
  engine.setRuntimeHooks({ executeTurn: async () => ({ content: 'from_content_prop' }) });
  const r2 = engine.invokeAgent('director', 'w2', 'P');
  const w2 = await engine.waitForInvocation(r2.invocationId);
  assert.strictEqual(w2.results[0].output, 'from_content_prop');

  // 3. Returns raw string
  engine.setRuntimeHooks({ executeTurn: async () => 'raw_string_result' });
  const r3 = engine.invokeAgent('director', 'w3', 'P');
  const w3 = await engine.waitForInvocation(r3.invocationId);
  assert.strictEqual(w3.results[0].output, 'raw_string_result');

  // 4. Returns primitive number / boolean
  engine.setRuntimeHooks({ executeTurn: async () => 12345 });
  const r4 = engine.invokeAgent('director', 'w4', 'P');
  const w4 = await engine.waitForInvocation(r4.invocationId);
  assert.strictEqual(w4.results[0].output, '12345');

  // 5. Unhandled exception in executeTurn transitions to ERROR status
  engine.setRuntimeHooks({
    executeTurn: async () => {
      throw new Error('LLM Provider connection timeout');
    }
  });
  const r5 = engine.invokeAgent('director', 'w5', 'P');
  const w5 = await engine.waitForInvocation(r5.invocationId);
  assert.strictEqual(w5.results[0].status, INVOCATION_STATUS.ERROR);
  assert.strictEqual(w5.results[0].output, '');
  assert.strictEqual(w5.results[0].error, 'LLM Provider connection timeout');
});

// ============================================================================
// 8. Secondary Token Streaming Channel & Event Isolation
// ============================================================================

test('8. Dedicated secondary streaming channel with invocationId tagging and unsubscription', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (targetId, prompt, ctx) => {
      ctx.onChunk(`[${targetId}] chunk 1`);
      ctx.onChunk(`[${targetId}] chunk 2`);
      return `Final ${targetId}`;
    }
  });

  const chunksReceived = [];
  const unsub = engine.onInvocationChunk((chunkEvent) => {
    chunksReceived.push(chunkEvent);
  });

  const rA = engine.invokeAgent('director', 'agent_a', 'Prompt A');
  const rB = engine.invokeAgent('director', 'agent_b', 'Prompt B');

  await engine.waitForInvocation([rA.invocationId, rB.invocationId]);

  assert.strictEqual(chunksReceived.length, 4);

  const chunksA = chunksReceived.filter(c => c.targetAgentId === 'agent_a');
  const chunksB = chunksReceived.filter(c => c.targetAgentId === 'agent_b');

  assert.strictEqual(chunksA.length, 2);
  assert.strictEqual(chunksA[0].invocationId, rA.invocationId);
  assert.strictEqual(chunksA[0].chunk, '[agent_a] chunk 1');
  assert.ok(typeof chunksA[0].timestamp === 'number');

  assert.strictEqual(chunksB.length, 2);
  assert.strictEqual(chunksB[0].invocationId, rB.invocationId);
  assert.strictEqual(chunksB[0].chunk, '[agent_b] chunk 1');

  // Test unsubscription stops receiving chunks
  unsub();
  const rC = engine.invokeAgent('director', 'agent_c', 'Prompt C');
  await engine.waitForInvocation(rC.invocationId);
  assert.strictEqual(chunksReceived.length, 4, 'No chunks delivered after unsubscribe');

  // Test onInvocationChunk with non-function returns no-op
  const noop = engine.onInvocationChunk(null);
  assert.strictEqual(typeof noop, 'function');
  noop();
});

// ============================================================================
// 9. Invocation Lifecycle Events (Start and Complete)
// ============================================================================

test('9. onInvocationStart and onInvocationComplete event emissions', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (agent, prompt) => `Result of ${prompt}`
  });

  const starts = [];
  const completes = [];

  const unsubStart = engine.onInvocationStart((e) => starts.push(e));
  const unsubComplete = engine.onInvocationComplete((e) => completes.push(e));

  const r = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Execute task 1',
    role: 'system'
  });

  assert.strictEqual(starts.length, 1);
  assert.strictEqual(starts[0].invocationId, r.invocationId);
  assert.strictEqual(starts[0].invokerId, 'director');
  assert.strictEqual(starts[0].targetAgentId, 'worker');
  assert.strictEqual(starts[0].prompt, 'Execute task 1');
  assert.strictEqual(starts[0].role, 'system');
  assert.ok(typeof starts[0].timestamp === 'number');

  await engine.waitForInvocation(r.invocationId);

  assert.strictEqual(completes.length, 1);
  assert.strictEqual(completes[0].invocationId, r.invocationId);
  assert.strictEqual(completes[0].targetAgentId, 'worker');
  assert.strictEqual(completes[0].status, INVOCATION_STATUS.COMPLETED);
  assert.strictEqual(completes[0].output, 'Result of Execute task 1');

  unsubStart();
  unsubComplete();
});

// ============================================================================
// 10. Turn-Level Await Barrier (waitForInvocation)
// ============================================================================

test('10. waitForInvocation: argument validation, single/multi target handling, and aliases', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (agent, prompt) => `Handled: ${prompt}`
  });

  // Empty targets returns INVALID_ARGUMENTS
  const resEmpty1 = await engine.waitForInvocation([]);
  assert.strictEqual(resEmpty1.success, false);
  assert.strictEqual(resEmpty1.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);
  assert.strictEqual(resEmpty1.count, 0);

  const resEmpty2 = await engine.waitForInvocation('');
  assert.strictEqual(resEmpty2.success, false);
  assert.strictEqual(resEmpty2.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);

  const resEmpty3 = await engine.waitForInvocation({ invocationIds: [] });
  assert.strictEqual(resEmpty3.success, false);
  assert.strictEqual(resEmpty3.code, INVOCATION_ERROR_CODES.INVALID_ARGUMENTS);

  // Single string wait
  const r1 = engine.invokeAgent('director', 'w1', 'Task 1');
  const w1 = await engine.waitForInvocation(r1.invocationId);
  assert.strictEqual(w1.success, true);
  assert.strictEqual(w1.count, 1);
  assert.strictEqual(w1.results[0].output, 'Handled: Task 1');
  assert.strictEqual(w1.results[0].status, 'completed');
  assert.strictEqual(w1.results[0].timedOut, false);
  assert.deepStrictEqual(w1.receivedIds, [r1.invocationId]);
  assert.deepStrictEqual(w1.missingIds, []);

  // Structured request object aliases: invocationId, ids, id
  const r2 = engine.invokeAgent('director', 'w2', 'Task 2');
  const w2 = await engine.waitForInvocation({ invocationId: r2.invocationId });
  assert.strictEqual(w2.count, 1);
  assert.strictEqual(w2.results[0].output, 'Handled: Task 2');

  const r3 = engine.invokeAgent('director', 'w3', 'Task 3');
  const w3 = await engine.waitForInvocation({ ids: [r3.invocationId] });
  assert.strictEqual(w3.count, 1);

  const r4 = engine.invokeAgent('director', 'w4', 'Task 4');
  const w4 = await engine.waitForInvocation({ id: r4.invocationId });
  assert.strictEqual(w4.count, 1);
});

// ============================================================================
// 11. Await Barrier (requireAll: true) vs First-Arrival Race (requireAll: false)
// ============================================================================

test('11. Barrier synchronization (requireAll: true) vs First-Arrival Race (requireAll: false)', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (agent) => {
      const delay = agent === 'fast' ? 10 : 60;
      await new Promise(r => setTimeout(r, delay));
      return `Done ${agent}`;
    }
  });

  // Barrier: requireAll: true waits for both fast and slow
  const rFast1 = engine.invokeAgent('director', 'fast', 'P1');
  const rSlow1 = engine.invokeAgent('director', 'slow', 'P2');

  const barrierRes = await engine.waitForInvocation([rFast1.invocationId, rSlow1.invocationId], {
    requireAll: true,
    timeoutMs: 2000
  });

  assert.strictEqual(barrierRes.success, true);
  assert.strictEqual(barrierRes.count, 2);
  assert.strictEqual(barrierRes.timedOut, false);
  assert.strictEqual(barrierRes.results.find(r => r.invocationId === rFast1.invocationId).output, 'Done fast');
  assert.strictEqual(barrierRes.results.find(r => r.invocationId === rSlow1.invocationId).output, 'Done slow');

  // Race: requireAll: false resolves on first arrival
  const rFast2 = engine.invokeAgent('director', 'fast', 'P3');
  const rSlow2 = engine.invokeAgent('director', 'slow', 'P4');

  const t0 = Date.now();
  const raceRes = await engine.waitForInvocation([rFast2.invocationId, rSlow2.invocationId], {
    requireAll: false,
    timeoutMs: 2000
  });
  const elapsed = Date.now() - t0;

  assert.strictEqual(raceRes.success, true);
  assert.strictEqual(raceRes.count, 1);
  assert.strictEqual(raceRes.results[0].invocationId, rFast2.invocationId);
  assert.strictEqual(raceRes.results[0].output, 'Done fast');
  assert.ok(elapsed < 50, `Race should resolve rapidly with first arrival (elapsed: ${elapsed}ms)`);
});

// ============================================================================
// 12. Instant Historical Resolution & Fast Path
// ============================================================================

test('12. Instant resolution for already settled invocations in history', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => 'Settled output'
  });

  const r = engine.invokeAgent('director', 'worker', 'P');

  // Wait for microtask to complete and settle in history
  await new Promise(r => setTimeout(r, 20));
  assert.strictEqual(engine.getInvocation(r.invocationId).status, INVOCATION_STATUS.COMPLETED);

  // Calling waitForInvocation on settled target must resolve immediately
  const t0 = Date.now();
  const res = await engine.waitForInvocation(r.invocationId);
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 20, `History resolution should be instantaneous (took ${elapsed}ms)`);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.timedOut, false);
  assert.strictEqual(res.results[0].output, 'Settled output');
});

// ============================================================================
// 13. Timeout Safety Valve & Partial Result Preservation
// ============================================================================

test('13. Timeout safety valve preserves partial arrived results and sets timedOut: true', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (agent) => {
      if (agent === 'speedy') {
        await new Promise(r => setTimeout(r, 10));
        return 'Speedy result';
      }
      await new Promise(r => setTimeout(r, 300));
      return 'Slow result';
    }
  });

  const rSpeedy = engine.invokeAgent('director', 'speedy', 'P1');
  const rSnail = engine.invokeAgent('director', 'snail', 'P2');

  const waitResult = await engine.waitForInvocation([rSpeedy.invocationId, rSnail.invocationId], {
    requireAll: true,
    timeoutMs: 60
  });

  assert.strictEqual(waitResult.success, true);
  assert.strictEqual(waitResult.timedOut, true);
  assert.strictEqual(waitResult.count, 1);
  assert.deepStrictEqual(waitResult.receivedIds, [rSpeedy.invocationId]);
  assert.deepStrictEqual(waitResult.missingIds, [rSnail.invocationId]);
  assert.strictEqual(waitResult.results[0].output, 'Speedy result');
  assert.strictEqual(waitResult.results[0].timedOut, false);
});

// ============================================================================
// 14. Cooperative Cancellation via AbortSignal
// ============================================================================

test('14. Cooperative cancellation via AbortSignal immediately aborts wait', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => {
      await new Promise(r => setTimeout(r, 500));
      return 'Done';
    }
  });

  const r = engine.invokeAgent('director', 'worker', 'Long task');

  // Case A: Signal already aborted prior to call
  const preAborted = AbortSignal.abort();
  const resPre = await engine.waitForInvocation(r.invocationId, { signal: preAborted });
  assert.strictEqual(resPre.success, false);
  assert.strictEqual(resPre.code, INVOCATION_ERROR_CODES.ABORTED);
  assert.strictEqual(resPre.error, 'Operation aborted');

  // Case B: Signal aborted while in flight
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);

  const resFlight = await engine.waitForInvocation(r.invocationId, {
    timeoutMs: 5000,
    signal: controller.signal
  });

  assert.strictEqual(resFlight.success, false);
  assert.strictEqual(resFlight.code, INVOCATION_ERROR_CODES.ABORTED);
  assert.strictEqual(resFlight.error, 'Operation aborted');
  assert.deepStrictEqual(resFlight.missingIds, [r.invocationId]);
});

// ============================================================================
// 15. Lifecycle Fault Isolation & Agent Termination (cancelPendingInvocationsForAgent)
// ============================================================================

test('15. Lifecycle fault isolation and emergency unstick via cancelPendingInvocationsForAgent', async () => {
  const crashedAuthority = Object.freeze({
    subject: 'crashed_agent',
    kind: 'agent',
    allow: new Set(['*']),
    visibility: 'all'
  });
  const engine = new InvocationEngine({
    executeTurn: async () => {
      await new Promise(r => setTimeout(r, 500));
      return 'Never finished';
    },
    getAgentAuthority: (id) => {
      if (id === 'crashed_agent') return crashedAuthority;
      return getAgentAuthority(id);
    }
  });

  // Start two invocations: one for crashing agent, one for independent agent
  const rCrashedTarget = engine.invokeAgent('director', 'crashed_agent', 'Task 1');
  const rCrashedInvoker = engine.invokeAgent('crashed_agent', 'director', 'Task 2');
  const rIndependent = engine.invokeAgent('director', 'healthy_agent', 'Task 3');

  assert.strictEqual(engine.getActiveInvocations().length, 3);

  // Await in background for the crashed invocation
  const waitPromise = engine.waitForInvocation(rCrashedTarget.invocationId, { timeoutMs: 5000 });

  // Cancel invocations for crashed_agent
  const cancelledIds = engine.cancelPendingInvocationsForAgent('crashed_agent', 'Unresponsive agent killed');

  assert.strictEqual(cancelledIds.length, 2);
  assert.ok(cancelledIds.includes(rCrashedTarget.invocationId));
  assert.ok(cancelledIds.includes(rCrashedInvoker.invocationId));

  // Healthy agent invocation remains active
  assert.strictEqual(engine.getActiveInvocations().length, 1);
  assert.strictEqual(engine.getActiveInvocations()[0].invocationId, rIndependent.invocationId);

  // In-flight waiter immediately unblocks with CANCELLED status and AGENT_TERMINATED code
  const waitRes = await waitPromise;
  assert.strictEqual(waitRes.success, true);
  assert.strictEqual(waitRes.results[0].status, INVOCATION_STATUS.CANCELLED);
  assert.strictEqual(waitRes.results[0].code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);
  assert.strictEqual(waitRes.results[0].error, 'Unresponsive agent killed');

  // Verify historical record state
  const historyRecord = engine.getInvocation(rCrashedTarget.invocationId);
  assert.strictEqual(historyRecord.status, INVOCATION_STATUS.CANCELLED);
  assert.strictEqual(historyRecord.code, INVOCATION_ERROR_CODES.AGENT_TERMINATED);

  // Calling cancel with empty/invalid agentId safely returns empty array
  assert.deepStrictEqual(engine.cancelPendingInvocationsForAgent(''), []);
  assert.deepStrictEqual(engine.cancelPendingInvocationsForAgent(null), []);
});

// ============================================================================
// 16. State Encapsulation, Defensive Copies & Reset
// ============================================================================

test('16. State encapsulation, defensive shallow copies, and reset()', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => 'Result'
  });

  const r = engine.invokeAgent('director', 'worker', 'Task');
  const activeList = engine.getActiveInvocations();
  assert.strictEqual(activeList.length, 1);

  // Mutating returned defensive copy must not mutate internal state
  activeList[0].status = 'tampered';
  assert.strictEqual(engine.getInvocation(r.invocationId).status !== 'tampered', true);

  await engine.waitForInvocation(r.invocationId);

  const historyList = engine.getInvocationHistory();
  assert.strictEqual(historyList.length, 1);
  historyList[0].output = 'tampered';
  assert.strictEqual(engine.getInvocation(r.invocationId).output, 'Result');

  // Query non-existent returns null
  assert.strictEqual(engine.getInvocation('non_existent'), null);
  assert.strictEqual(engine.getInvocation(null), null);

  // reset() clears all queryable state
  engine.reset();
  assert.strictEqual(engine.getActiveInvocations().length, 0);
  assert.strictEqual(engine.getInvocationHistory().length, 0);
  assert.strictEqual(engine.getInvocation(r.invocationId), null);

  // reset() also clears registered listeners: prior subscribers receive no further events
  let completions = 0;
  const resetEngine = new InvocationEngine({ getAgentAuthority, executeTurn: async () => 'After reset' });
  resetEngine.onInvocationComplete(() => { completions++; });
  resetEngine.reset();

  const r2 = resetEngine.invokeAgent('director', 'worker', 'Post-reset');
  const res2 = await resetEngine.waitForInvocation(r2.invocationId);
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.results[0].output, 'After reset');
  assert.strictEqual(completions, 0, 'Listeners cleared by reset() must not receive later events');
});

// ============================================================================
// 17. Memory Leak Prevention: pendingWaiters Pruning
// ============================================================================

test('17. Waiter lifecycle: resolution, timeout, and abort settle cleanly', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => {
      await new Promise(r => setTimeout(r, 15));
      return 'Completed';
    }
  });

  // 1. Normal resolution: waiter observes the completed result
  const r1 = engine.invokeAgent('director', 'w1', 'P1');
  const res1 = await engine.waitForInvocation(r1.invocationId);
  assert.strictEqual(res1.success, true);
  assert.strictEqual(res1.results[0].status, INVOCATION_STATUS.COMPLETED);
  assert.strictEqual(res1.results[0].output, 'Completed');

  // Already-settled waiter entries are released: a fresh waiter resolves instantly from history
  const res1b = await engine.waitForInvocation(r1.invocationId, { timeoutMs: 500 });
  assert.strictEqual(res1b.count, 1);
  assert.strictEqual(res1b.results[0].output, 'Completed');

  // 2. Timeout: waiter settles with timedOut, and no stale waiter blocks the underlying invocation
  engine.setRuntimeHooks({
    executeTurn: async () => {
      await new Promise(r => setTimeout(r, 200));
      return 'Slow';
    }
  });

  const r2 = engine.invokeAgent('director', 'w2', 'P2');
  const res2 = await engine.waitForInvocation(r2.invocationId, { timeoutMs: 20 });
  assert.strictEqual(res2.success, true);
  assert.strictEqual(res2.timedOut, true);
  assert.deepStrictEqual(res2.results, []);

  // The underlying invocation still settles; a subsequent waiter observes it
  const res2b = await engine.waitForInvocation(r2.invocationId, { timeoutMs: 1000 });
  assert.strictEqual(res2b.timedOut, false);
  assert.strictEqual(res2b.results[0].output, 'Slow');

  // 3. Abort: waiter settles as ABORTED while the invocation remains active and awaitable
  const r3 = engine.invokeAgent('director', 'w3', 'P3');
  const controller = new AbortController();
  const pendingAbort = engine.waitForInvocation(r3.invocationId, { signal: controller.signal });
  controller.abort();
  const res3 = await pendingAbort;
  assert.strictEqual(res3.success, false);
  assert.strictEqual(res3.code, INVOCATION_ERROR_CODES.ABORTED);

  const res3b = await engine.waitForInvocation(r3.invocationId, { timeoutMs: 1000 });
  assert.strictEqual(res3b.results[0].output, 'Slow');
});

// ============================================================================
// 18. Wave I canonical identity (ticket d57cbc1)
// ============================================================================

/**
 * Builds a real identity port over a realm-local registration roster (zero
 * mocks: real projections, real canonical keys), mirroring the runtime
 * `AgentIdentityPort`: canonical `key` match first, realm-exact scope
 * resolution, unique-match otherwise (zero/multiple -> null), and
 * `listAgentIdentities()` enumeration.
 *
 * @param {Array<{realmId: string|null, id: string, realmBypass?: boolean}>} roster - Registrations.
 * @returns {{getAgentIdentity: Function, listAgentIdentities: Function}} Identity port.
 */
function createRealmIdentityPort(roster) {
  const registrations = roster.map((entry) => Object.freeze({
    id: entry.id,
    key: createAgentIdentityKey(entry.realmId, entry.id),
    realmId: entry.realmId,
    realmBypass: entry.realmBypass === true
  }));
  return {
    getAgentIdentity(agentId, scope) {
      if (typeof agentId !== 'string' || !agentId) return null;
      const byKey = registrations.find((entry) => entry.key === agentId);
      if (byKey) return byKey;
      if (scope && typeof scope === 'object' && 'realmId' in scope && scope.realmBypass !== true) {
        const realmId = typeof scope.realmId === 'string' && scope.realmId ? scope.realmId : null;
        return registrations.find((entry) => entry.id === agentId && entry.realmId === realmId) || null;
      }
      const matches = registrations.filter((entry) => entry.id === agentId);
      return matches.length === 1 ? matches[0] : null;
    },
    listAgentIdentities() {
      return registrations.slice();
    }
  };
}

test('18. Wave I: canonical identifiers stay opaque and receipts expose bare ids', async () => {
  const keyWorkerA = createAgentIdentityKey('realm_a', 'worker');
  const keyWorkerB = createAgentIdentityKey('realm_b', 'worker');
  const keyLeadA = createAgentIdentityKey('realm_a', 'lead');
  const keyDirector = createAgentIdentityKey(null, 'director');
  const keySole = createAgentIdentityKey('realm_c', 'sole');
  const keySoleChild = createAgentIdentityKey('realm_c', 'sole_child');

  const identityPort = createRealmIdentityPort([
    { realmId: 'realm_a', id: 'worker' },
    { realmId: 'realm_b', id: 'worker' },
    { realmId: 'realm_a', id: 'lead' },
    { realmId: null, id: 'director', realmBypass: true },
    { realmId: 'realm_c', id: 'sole' },
    { realmId: 'realm_c', id: 'sole_child' }
  ]);

  const authoritiesByKey = new Map([
    [keyLeadA, Object.freeze({ subject: keyLeadA, kind: 'agent', allow: new Set(['*']), visibility: 'all' })],
    [keyWorkerA, Object.freeze({ subject: keyWorkerA, kind: 'agent', allow: new Set(['read_file']), visibility: 'self' })],
    [keyWorkerB, Object.freeze({ subject: keyWorkerB, kind: 'agent', allow: new Set(['read_file']), visibility: 'self' })],
    [keyDirector, Object.freeze({ subject: keyDirector, kind: 'agent', allow: new Set(['*']), visibility: 'all' })],
    [keySole, Object.freeze({ subject: keySole, kind: 'agent', allow: new Set(['read_file']), visibility: 'self' })],
    [keySoleChild, Object.freeze({ subject: keySoleChild, kind: 'agent', allow: new Set(['read_file']), visibility: 'self' })]
  ]);
  const scopesByKey = new Map([
    [keyLeadA, { realmId: 'realm_a', realmBypass: false }],
    [keyWorkerA, { realmId: 'realm_a', realmBypass: false }],
    [keyWorkerB, { realmId: 'realm_b', realmBypass: false }],
    [keyDirector, { realmId: null, realmBypass: true }],
    [keySole, { realmId: 'realm_c', realmBypass: false }],
    [keySoleChild, { realmId: 'realm_c', realmBypass: false }]
  ]);
  const descriptorsByKey = new Map([
    [keyWorkerA, { id: 'worker', state: 'idle' }],
    [keyWorkerB, { id: 'worker', state: 'idle' }],
    [keySole, { id: 'sole', state: 'idle' }],
    ['sole', { id: 'sole', state: 'idle' }],
    [keySoleChild, { id: 'sole_child', state: 'idle', config: { spawnedBy: 'sole' } }]
  ]);
  const releases = [];
  const engine = new InvocationEngine({
    identityPort,
    getAgent: (ref) => descriptorsByKey.get(ref) || null,
    isAgentTerminated: () => false,
    getAgentAuthority: (ref) => authoritiesByKey.get(ref) || null,
    getAgentRealmScope: (ref) => scopesByKey.get(ref) || null,
    executeTurn: async () => new Promise((resolve) => releases.push(resolve))
  });

  const realmADescriptor = authoritiesByKey.get(keyWorkerA);
  const realmBDescriptor = authoritiesByKey.get(keyWorkerB);

  const starts = [];
  const completes = [];
  engine.onInvocationStart((event) => starts.push(event));
  engine.onInvocationComplete((event) => completes.push(event));

  // Same-realm success: the canonical pair executes, receipts and events
  // expose the bare id, and no canonical key leaks.
  const sameRealm = engine.invokeAgent(keyLeadA, keyWorkerA, 'realm A task');
  assert.strictEqual(sameRealm.success, true);
  assert.strictEqual(sameRealm.targetAgentId, 'worker', 'the receipt projects the bare id');
  assert.strictEqual(JSON.stringify(sameRealm).includes('realm:'), false, 'no canonical key in a receipt');
  const record = engine.getInvocation(sameRealm.invocationId);
  assert.strictEqual(record.invokerId, 'lead', 'records project the bare invoker id');
  assert.strictEqual(record.targetAgentId, 'worker', 'records project the bare target id');
  assert.strictEqual(JSON.stringify(record).includes('realm:'), false, 'records never carry a canonical key');
  assert.strictEqual(starts[0].invokerId, 'lead');
  assert.strictEqual(starts[0].targetAgentId, 'worker');
  assert.strictEqual(JSON.stringify(engine.getActiveInvocations()).includes('realm:'), false);

  // Cross-realm denial: a realm-bound pair never invokes across the boundary,
  // and the denial names only bare ids.
  const crossRealm = engine.invokeAgent(keyLeadA, keyWorkerB, 'realm B task');
  assert.strictEqual(crossRealm.success, false);
  assert.strictEqual(crossRealm.code, INVOCATION_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(crossRealm.error.includes('realm:'), false, 'no canonical key in a denial');
  assert.ok(crossRealm.error.includes("'worker'"), 'the denial names the bare target id');

  // Bypass spanning: the granted director spans every realm.
  const bypass = engine.invokeAgent(keyDirector, keyWorkerB, 'director task');
  assert.strictEqual(bypass.success, true);
  assert.strictEqual(bypass.targetAgentId, 'worker');
  assert.strictEqual(JSON.stringify(bypass).includes('realm:'), false);

  // Self and parent relations compare canonical keys: a canonical invoker and a
  // bare-family reference resolve to the same registration through the port.
  const self = engine.invokeAgent(keySole, 'sole', 'canonical self');
  assert.strictEqual(self.success, true, 'a canonical key and its bare id compare as one identity');
  const parent = engine.invokeAgent(keySole, keySoleChild, 'canonical parent');
  assert.strictEqual(parent.success, true, 'canonical parentage authorizes the spawner');

  // Await authentication (unchanged rules, canonical refs): the invoker and
  // the target may await; an unrelated same-literal-id registration may not.
  const asInvoker = await engine.waitForInvocation(sameRealm.invocationId, { timeoutMs: 20 }, { callerKey: keyLeadA });
  assert.strictEqual(asInvoker.timedOut, true, 'the invoker resolves through the wait window');
  const asTarget = await engine.waitForInvocation(sameRealm.invocationId, { timeoutMs: 20 }, { callerKey: keyWorkerA });
  assert.strictEqual(asTarget.timedOut, true, 'the target resolves through the wait window');
  const asForeign = await engine.waitForInvocation(sameRealm.invocationId, { timeoutMs: 20 }, { callerKey: keyWorkerB });
  assert.strictEqual(asForeign.success, false, 'an unrelated caller never awaits another realm invocation');
  assert.strictEqual(asForeign.code, INVOCATION_ERROR_CODES.PERMISSION_DENIED);
  assert.strictEqual(asForeign.error.includes('realm:'), false, 'no canonical key in an await denial');
  const asDirector = await engine.waitForInvocation(sameRealm.invocationId, { timeoutMs: 20 }, { callerKey: keyDirector });
  assert.strictEqual(asDirector.timedOut, true, 'a realm-bypass caller spans the await');

  // Also verify the legacy principal/callerAgentId channel still authenticates.
  const asPrincipal = await engine.waitForInvocation(
    sameRealm.invocationId,
    { timeoutMs: 20 },
    { callerAgentId: keyLeadA }
  );
  assert.strictEqual(asPrincipal.timedOut, true, 'the registry-resolved callerAgentId channel stays valid');
  const asWrongPrincipal = await engine.waitForInvocation(
    sameRealm.invocationId,
    { timeoutMs: 20 },
    { principal: realmBDescriptor }
  );
  assert.strictEqual(asWrongPrincipal.success, false, 'an unrelated descriptor principal is denied');

  // Cancellation by canonical key is realm-exact: realm A's in-flight
  // invocation is settled; the same-literal-id realm B invocation stays active.
  const cancellableA = engine.invokeAgent(keyLeadA, keyWorkerA, 'cancellable A');
  const cancellableB = engine.invokeAgent(keyDirector, keyWorkerB, 'cancellable B');
  assert.strictEqual(cancellableA.success, true);
  assert.strictEqual(cancellableB.success, true);
  const cancelled = engine.cancelPendingInvocationsForAgent(keyWorkerA, 'realm A teardown');
  assert.strictEqual(cancelled.includes(sameRealm.invocationId), true, 'realm A invocations are cancelled by key');
  assert.strictEqual(cancelled.includes(cancellableA.invocationId), true);
  assert.strictEqual(cancelled.includes(cancellableB.invocationId), false, 'the other realm stays in flight');
  assert.strictEqual(
    engine.getActiveInvocations().some((entry) => entry.invocationId === cancellableB.invocationId),
    true
  );

  // Settle the remaining work: history projections stay bare and key-free.
  engine.cancelPendingInvocationsForAgent(keyDirector, 'cleanup');
  for (const release of releases) release('done');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const history = engine.getInvocationHistory();
  assert.ok(history.length >= 3);
  assert.strictEqual(JSON.stringify(history).includes('realm:'), false, 'history never carries a canonical key');
  assert.strictEqual(JSON.stringify(completes).includes('realm:'), false, 'completion events never carry a canonical key');
});
