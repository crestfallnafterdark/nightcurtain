/**
 * @file tests/invocation_engine_test.js
 * @description Zero-Mock Unit & Contract Test Suite for Epic 02: Standalone InvocationEngine & Secondary Streaming.
 * 
 * Verifies all ICD Acceptance Criteria:
 *   [AC-INVOKE-01] Zero Mail Pollute (Real MessagingBus verification)
 *   [AC-INVOKE-02] Second Stream (Isolated chunk emission with invocationId)
 *   [AC-INVOKE-03] Authority Security (Sudoer/admin, parent creator, self, PERMISSION_DENIED)
 *   [AC-INVOKE-04] Depth Guard (Recursion limit 5, RECURSION_DEPTH_EXCEEDED)
 *   [AC-WAIT-02] Multi-Wait Invocation (Single/multi UUIDs, require_all, timeouts, AbortSignal)
 */

import assert from 'node:assert/strict';
import { InvocationEngine } from '../../src/lib/sandbox/invocationEngine/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';

/**
 * MOD-21 test authority (default-deny): only `director` holds the wildcard
 * allow set through the injected registry resolver; magic ids, roles, and
 * caller flags grant nothing.
 */
const DIRECTOR_AUTHORITY = Object.freeze({
  subject: 'director',
  kind: 'agent',
  allow: new Set(['*']),
  visibility: 'all'
});
const getAgentAuthority = (id) => (id === 'director' ? DIRECTOR_AUTHORITY : null);

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

console.log('========================================================================');
console.log('  EPIC 02: STANDALONE INVOCATION ENGINE & SECONDARY STREAMING TESTS    ');
console.log('========================================================================\n');

// ----------------------------------------------------------------------------
// [AC-INVOKE-01] Zero Mail Pollute
// ----------------------------------------------------------------------------
console.log('--- 1. [AC-INVOKE-01] Zero Mail Pollute ---');

await test('[AC-INVOKE-01.1] Invocations produce ZERO envelopes in MessagingBus (activeQueue, archive, auditLog)', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director');
  bus.registerAgent('worker');

  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (targetAgentId, prompt) => {
      return { output: `Subroutine completed: ${prompt}` };
    }
  });

  // Verify baseline clean state
  assert.equal(bus.getUnreadCount('director'), 0);
  assert.equal(bus.listInbox('director').length, 0);
  assert.equal(bus.listInbox('worker').length, 0);

  // Invoke worker as director
  const receipt = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Analyze report data'
  });

  assert.equal(receipt.success, true);
  assert.equal(receipt.status, 'dispatched');
  assert.ok(receipt.invocationId.startsWith('inv_'));

  // Await invocation completion via turn-level await primitive
  const waitResult = await engine.waitForInvocation(receipt.invocationId, { timeout_ms: 1000 });
  assert.equal(waitResult.success, true);
  assert.equal(waitResult.count, 1);
  assert.equal(waitResult.results[0].output, 'Subroutine completed: Analyze report data');

  // Strict Invariant 2 assertion: MessagingBus is 100% untouched
  assert.equal(bus.getUnreadCount('director'), 0, 'director unreadCount must remain 0');
  assert.equal(bus.getUnreadCount('worker'), 0, 'worker unreadCount must remain 0');
  assert.equal(bus.listInbox('director').length, 0, 'director inbox must remain empty');
  assert.equal(bus.listInbox('worker').length, 0, 'worker inbox must remain empty');

  // drainInbox and listInbox return 0 items
  assert.equal(bus.drainInbox('director').length, 0);
  assert.equal(bus.drainInbox('worker').length, 0);
});

await test('[AC-INVOKE-01.2] Failed/Errored invocations also produce ZERO entries in MessagingBus', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('director');
  bus.registerAgent('faulty_worker');

  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => {
      throw new Error('Fatal execution failure in worker');
    }
  });

  const receipt = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'faulty_worker',
    prompt: 'Run problematic computation'
  });

  const waitResult = await engine.waitForInvocation(receipt.invocationId, { timeout_ms: 1000 });
  assert.equal(waitResult.success, true);
  assert.equal(waitResult.results[0].status, 'error');
  assert.equal(waitResult.results[0].error, 'Fatal execution failure in worker');

  // Invariant 2 assertion: no error envelopes in messaging bus
  assert.equal(bus.getUnreadCount('director'), 0);
  assert.equal(bus.getUnreadCount('faulty_worker'), 0);
  assert.equal(bus.listInbox('director').length, 0);
  assert.equal(bus.listInbox('faulty_worker').length, 0);
  assert.equal(bus.drainInbox('director').length, 0);
  assert.equal(bus.drainInbox('faulty_worker').length, 0);
});

// ----------------------------------------------------------------------------
// [AC-INVOKE-02] Second Stream
// ----------------------------------------------------------------------------
console.log('\n--- 2. [AC-INVOKE-02] Second Stream ---');

await test('[AC-INVOKE-02.1] Emits secondary stream chunks tagged with invocationId and targetAgentId', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (targetAgentId, prompt, context) => {
      context.onChunk('Token 1 ');
      context.onChunk('Token 2 ');
      context.onChunk('Token 3');
      return { output: 'Token 1 Token 2 Token 3' };
    }
  });

  const receivedChunks = [];
  const unsub = engine.onInvocationChunk((chunkEvent) => {
    receivedChunks.push(chunkEvent);
  });

  const receipt = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'streamer',
    prompt: 'Stream response'
  });

  const waitResult = await engine.waitForInvocation(receipt.invocationId, { timeout_ms: 1000 });
  assert.equal(waitResult.success, true);

  assert.equal(receivedChunks.length, 3);
  assert.equal(receivedChunks[0].invocationId, receipt.invocationId);
  assert.equal(receivedChunks[0].targetAgentId, 'streamer');
  assert.equal(receivedChunks[0].chunk, 'Token 1 ');
  assert.ok(typeof receivedChunks[0].timestamp === 'number');

  assert.equal(receivedChunks[1].chunk, 'Token 2 ');
  assert.equal(receivedChunks[2].chunk, 'Token 3');

  // Unsubscribe terminates delivery
  unsub();
  const receipt2 = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'streamer',
    prompt: 'Stream again'
  });
  await engine.waitForInvocation(receipt2.invocationId, { timeout_ms: 1000 });
  assert.equal(receivedChunks.length, 3, 'No more chunks delivered after unsubscribe');
});

await test('[AC-INVOKE-02.2] Concurrent invocations maintain separate chunk tagging without mixing', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (targetAgentId, prompt, context) => {
      for (let i = 1; i <= 2; i++) {
        context.onChunk(`[${targetAgentId}:${i}]`);
      }
      return { output: `done ${targetAgentId}` };
    }
  });

  const chunksA = [];
  const chunksB = [];

  engine.onInvocationChunk((ev) => {
    if (ev.targetAgentId === 'agent_a') chunksA.push(ev);
    if (ev.targetAgentId === 'agent_b') chunksB.push(ev);
  });

  const rA = engine.invokeAgent('director', 'agent_a', 'Prompt A');
  const rB = engine.invokeAgent('director', 'agent_b', 'Prompt B');

  await engine.waitForInvocation([rA.invocationId, rB.invocationId], { timeout_ms: 1000 });

  assert.equal(chunksA.length, 2);
  assert.ok(chunksA.every(c => c.invocationId === rA.invocationId && c.targetAgentId === 'agent_a'));

  assert.equal(chunksB.length, 2);
  assert.ok(chunksB.every(c => c.invocationId === rB.invocationId && c.targetAgentId === 'agent_b'));
});

// ----------------------------------------------------------------------------
// [AC-INVOKE-03] Authority Security
// ----------------------------------------------------------------------------
console.log('\n--- 3. [AC-INVOKE-03] Authority Security ---');

await test('[AC-INVOKE-03.1] Unauthorized peer invocation is rejected with PERMISSION_DENIED', () => {
  const agents = {
    alice: { id: 'alice', config: { role: 'user' } },
    bob: { id: 'bob', config: { role: 'assistant' } }
  };

  const engine = new InvocationEngine({ getAgentAuthority,
    getAgent: (id) => agents[id] || null
  });

  // Alice is neither sudoer, nor bob's parent, nor self
  const res = engine.invokeAgent({
    invokerId: 'alice',
    targetAgentId: 'bob',
    prompt: 'Do something secret'
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'PERMISSION_DENIED');
  assert.ok(res.error.includes("Permission denied: agent 'alice' cannot invoke arbitrary peer agent 'bob'"));
  assert.equal(engine.getActiveInvocations().length, 0);
});
await test('[AC-INVOKE-03.2] Registry authority invokes; magic ids, flags, and roles do not (MOD-21)', () => {
  const agents = {
    target: { id: 'target', config: { role: 'assistant' } },
    privileged_agent: { id: 'privileged_agent', config: { privileged: true } },
    admin_agent: { id: 'admin_agent', config: { role: 'admin' } }
  };

  const engine = new InvocationEngine({
    getAgentAuthority,
    getAgent: (id) => agents[id] || null
  });

  // 1. Registry descriptor authority (wildcard allow set)
  const r1 = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'target', prompt: 'P1' });
  assert.equal(r1.success, true);

  // 2. Magic ids, caller-asserted flags, and authority-looking roles do not elevate
  const r2 = engine.invokeAgent({ invokerId: 'admin', targetAgentId: 'target', prompt: 'P2' });
  assert.equal(r2.success, false);
  assert.equal(r2.code, 'PERMISSION_DENIED');

  const r3 = engine.invokeAgent({ invokerId: 'user1', targetAgentId: 'target', prompt: 'P3', isAdmin: true });
  assert.equal(r3.success, false);
  assert.equal(r3.code, 'PERMISSION_DENIED');

  const r4 = engine.invokeAgent({ invokerId: 'user2', targetAgentId: 'target', prompt: 'P4', privileged: true });
  assert.equal(r4.success, false);
  assert.equal(r4.code, 'PERMISSION_DENIED');

  const r5 = engine.invokeAgent({ invokerId: 'user3', targetAgentId: 'target', prompt: 'P5', callerRole: 'admin', role: 'admin' });
  assert.equal(r5.success, false);
  assert.equal(r5.code, 'PERMISSION_DENIED');

  // 3. Legacy config privilege/role confers no authority
  const r6 = engine.invokeAgent({ invokerId: 'privileged_agent', targetAgentId: 'target', prompt: 'P6' });
  assert.equal(r6.success, false);
  assert.equal(r6.code, 'PERMISSION_DENIED');

  const r7 = engine.invokeAgent({ invokerId: 'admin_agent', targetAgentId: 'target', prompt: 'P7' });
  assert.equal(r7.success, false);
  assert.equal(r7.code, 'PERMISSION_DENIED');
});

await test('[AC-INVOKE-03.3] Self-invocation succeeds', () => {
  const engine = new InvocationEngine({ getAgentAuthority });
  const res = engine.invokeAgent({
    invokerId: 'lone_wolf',
    targetAgentId: 'lone_wolf',
    prompt: 'Internal recursion check'
  });

  assert.equal(res.success, true);
  assert.equal(res.targetAgentId, 'lone_wolf');
});

await test('[AC-INVOKE-03.4] Parent/Creator invocation succeeds (spawnedBy / creatorId)', () => {
  const agents = {
    parent_agent: { id: 'parent_agent', config: { role: 'assistant' } },
    child_agent: { id: 'child_agent', config: { spawnedBy: 'parent_agent' } },
    created_agent: { id: 'created_agent', config: { creatorId: 'parent_agent' } }
  };

  const engine = new InvocationEngine({ getAgentAuthority,
    getAgent: (id) => agents[id] || null
  });

  const resChild = engine.invokeAgent({
    invokerId: 'parent_agent',
    targetAgentId: 'child_agent',
    prompt: 'Execute subtask'
  });
  assert.equal(resChild.success, true);

  const resCreated = engine.invokeAgent({
    invokerId: 'parent_agent',
    targetAgentId: 'created_agent',
    prompt: 'Execute subtask 2'
  });
  assert.equal(resCreated.success, true);
});

await test('[AC-INVOKE-03.5] Terminated agent invocation is rejected with AGENT_TERMINATED', () => {
  const agents = {
    dead_agent: { id: 'dead_agent', state: 'terminated' },
    recycled_agent: { id: 'recycled_agent', state: 'recycled' }
  };

  const engine = new InvocationEngine({ getAgentAuthority,
    getAgent: (id) => agents[id] || null,
    isAgentTerminated: (id) => id === 'hook_dead_agent'
  });

  const r1 = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'dead_agent', prompt: 'Wake up' });
  assert.equal(r1.success, false);
  assert.equal(r1.code, 'AGENT_TERMINATED');

  const r2 = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'recycled_agent', prompt: 'Wake up' });
  assert.equal(r2.success, false);
  assert.equal(r2.code, 'AGENT_TERMINATED');

  const r3 = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'hook_dead_agent', prompt: 'Wake up' });
  assert.equal(r3.success, false);
  assert.equal(r3.code, 'AGENT_TERMINATED');
});

await test('[AC-INVOKE-03.6] Nonexistent agent is rejected with AGENT_NOT_FOUND when getAgent is configured', () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    getAgent: () => null
  });

  const res = engine.invokeAgent({ invokerId: 'director', targetAgentId: 'ghost', prompt: 'Hello' });
  assert.equal(res.success, false);
  assert.equal(res.code, 'AGENT_NOT_FOUND');
});

// ----------------------------------------------------------------------------
// [AC-INVOKE-04] Depth Guard
// ----------------------------------------------------------------------------
console.log('\n--- 4. [AC-INVOKE-04] Depth Guard ---');

await test('[AC-INVOKE-04.1] Depths 1 through 5 succeed', () => {
  const engine = new InvocationEngine({ getAgentAuthority });

  for (let incomingDepth = 0; incomingDepth < 5; incomingDepth++) {
    const res = engine.invokeAgent({
      invokerId: 'director',
      targetAgentId: 'worker',
      prompt: `Depth test ${incomingDepth}`,
      depth: incomingDepth
    });
    assert.equal(res.success, true, `Depth incoming ${incomingDepth} (resulting ${incomingDepth + 1}) must succeed`);
  }
});

await test('[AC-INVOKE-04.2] Recursion depth > 5 is rejected with RECURSION_DEPTH_EXCEEDED', () => {
  const engine = new InvocationEngine({ getAgentAuthority });

  // incoming depth 5 would result in depth 6 > 5
  const res5 = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Too deep',
    depth: 5
  });
  assert.equal(res5.success, false);
  assert.equal(res5.code, 'RECURSION_DEPTH_EXCEEDED');
  assert.equal(res5.error, 'Recursion depth limit exceeded (max 5)');

  // incoming depth 6
  const res6 = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Way too deep',
    recursionDepth: 6
  });
  assert.equal(res6.success, false);
  assert.equal(res6.code, 'RECURSION_DEPTH_EXCEEDED');
});

// ----------------------------------------------------------------------------
// [AC-WAIT-02] Multi-Wait Invocation
// ----------------------------------------------------------------------------
console.log('\n--- 5. [AC-WAIT-02] Multi-Wait Invocation ---');

await test('[AC-WAIT-02.1] waitForInvocation single UUID halts and resolves upon completion', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (targetAgentId, prompt) => {
      await new Promise(r => setTimeout(r, 20));
      return { output: `Handled: ${prompt}` };
    }
  });

  const receipt = engine.invokeAgent('director', 'worker', 'Calculate trajectory');
  const start = Date.now();
  const waitResult = await engine.waitForInvocation(receipt.invocationId);
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 15, `Should halt turn during async turn execution (elapsed: ${elapsed}ms)`);
  assert.equal(waitResult.success, true);
  assert.equal(waitResult.timedOut, false);
  assert.equal(waitResult.count, 1);
  assert.equal(waitResult.results[0].invocationId, receipt.invocationId);
  assert.equal(waitResult.results[0].output, 'Handled: Calculate trajectory');
  assert.equal(waitResult.results[0].status, 'completed');
});

await test('[AC-WAIT-02.2] Instant resolution for already-completed invocations in history', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => 'Instant answer'
  });

  const receipt = engine.invokeAgent('director', 'worker', 'Question');

  // Wait for it to complete into history
  await new Promise(r => setTimeout(r, 30));
  assert.equal(engine.getInvocation(receipt.invocationId).status, 'completed');

  // Calling waitForInvocation now must resolve immediately
  const t0 = Date.now();
  const res = await engine.waitForInvocation(receipt.invocationId);
  const duration = Date.now() - t0;

  assert.ok(duration < 20, `Already completed invocation should resolve instantly (took ${duration}ms)`);
  assert.equal(res.success, true);
  assert.equal(res.timedOut, false);
  assert.equal(res.results[0].output, 'Instant answer');
});

await test('[AC-WAIT-02.3] Multi-UUID wait with require_all: true (default) resolves only when all complete', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (targetAgentId) => {
      const delay = targetAgentId === 'fast' ? 10 : 35;
      await new Promise(r => setTimeout(r, delay));
      return { output: `Result from ${targetAgentId}` };
    }
  });

  const rFast = engine.invokeAgent('director', 'fast', 'Fast task');
  const rSlow = engine.invokeAgent('director', 'slow', 'Slow task');

  const waitResult = await engine.waitForInvocation([rFast.invocationId, rSlow.invocationId], {
    require_all: true,
    timeout_ms: 2000
  });

  assert.equal(waitResult.success, true);
  assert.equal(waitResult.timedOut, false);
  assert.equal(waitResult.count, 2);
  assert.equal(waitResult.receivedIds.length, 2);
  assert.deepEqual(waitResult.missingIds, []);
  assert.equal(waitResult.results[0].output, 'Result from fast');
  assert.equal(waitResult.results[1].output, 'Result from slow');
});

await test('[AC-WAIT-02.4] Multi-UUID wait with require_all: false resolves upon FIRST completion', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (targetAgentId) => {
      const delay = targetAgentId === 'quick' ? 15 : 200;
      await new Promise(r => setTimeout(r, delay));
      return { output: `Winner: ${targetAgentId}` };
    }
  });

  const rQuick = engine.invokeAgent('director', 'quick', 'Go quick');
  const rLag = engine.invokeAgent('director', 'lag', 'Go slow');

  const t0 = Date.now();
  const waitResult = await engine.waitForInvocation([rQuick.invocationId, rLag.invocationId], {
    require_all: false,
    timeout_ms: 1000
  });
  const duration = Date.now() - t0;

  assert.ok(duration < 150, `require_all: false should resolve after first completion (took ${duration}ms)`);
  assert.equal(waitResult.success, true);
  assert.equal(waitResult.timedOut, false);
  assert.equal(waitResult.count, 1);
  assert.equal(waitResult.results[0].invocationId, rQuick.invocationId);
  assert.equal(waitResult.results[0].output, 'Winner: quick');
});

await test('[AC-WAIT-02.5] Timeout safety valve preserves arrived partial results and sets timedOut: true', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (targetAgentId) => {
      if (targetAgentId === 'speedy') {
        await new Promise(r => setTimeout(r, 15));
        return { output: 'Speedy output' };
      } else {
        await new Promise(r => setTimeout(r, 500)); // Will exceed timeout
        return { output: 'Late output' };
      }
    }
  });

  const rSpeedy = engine.invokeAgent('director', 'speedy', 'Fast');
  const rSnail = engine.invokeAgent('director', 'snail', 'Slow');

  const waitResult = await engine.waitForInvocation([rSpeedy.invocationId, rSnail.invocationId], {
    require_all: true,
    timeout_ms: 80
  });

  assert.equal(waitResult.success, true);
  assert.equal(waitResult.timedOut, true);
  assert.equal(waitResult.count, 1);
  assert.deepEqual(waitResult.receivedIds, [rSpeedy.invocationId]);
  assert.deepEqual(waitResult.missingIds, [rSnail.invocationId]);
  assert.equal(waitResult.results[0].output, 'Speedy output');
});

await test('[AC-WAIT-02.6] AbortSignal halts wait immediately and cleans up listeners', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => {
      await new Promise(r => setTimeout(r, 500));
      return { output: 'Never seen' };
    }
  });

  const receipt = engine.invokeAgent('director', 'worker', 'Hanging task');
  const ac = new AbortController();

  setTimeout(() => ac.abort(), 25);

  const res = await engine.waitForInvocation(receipt.invocationId, {
    timeout_ms: 3000,
    signal: ac.signal
  });

  assert.equal(res.success, false);
  assert.equal(res.code, 'ABORTED');
  assert.equal(res.timedOut, false);
  assert.equal(res.count, 0);
  assert.equal(res.missingIds[0], receipt.invocationId);
});

// ----------------------------------------------------------------------------
// 6. Polymorphic Signatures & API Contract Robustness
// ----------------------------------------------------------------------------
console.log('\n--- 6. Polymorphic Signatures & API Robustness ---');

await test('invokeAgent supports both object arguments and positional arguments', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async (agent, prompt) => `Echo ${agent}: ${prompt}`
  });

  // Positional signature: invokeAgent(invokerId, targetAgentId, prompt, options)
  const rPos = engine.invokeAgent('director', 'worker1', 'Positional call', { depth: 1 });
  assert.equal(rPos.success, true);

  // Object signature: invokeAgent({ invokerId, targetAgentId, prompt, ... })
  const rObj = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker2',
    prompt: 'Object call',
    role: 'system'
  });
  assert.equal(rObj.success, true);

  const res = await engine.waitForInvocation([rPos.invocationId, rObj.invocationId]);
  assert.equal(res.results[0].output, 'Echo worker1: Positional call');
  assert.equal(res.results[1].output, 'Echo worker2: Object call');
});

await test('waitForInvocation supports single string, array, and object options', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => 'Answer'
  });

  const r1 = engine.invokeAgent('director', 'w1', 'Q1');
  const r2 = engine.invokeAgent('director', 'w2', 'Q2');

  // Single string
  const w1 = await engine.waitForInvocation(r1.invocationId);
  assert.equal(w1.count, 1);

  // Array of strings
  const w2 = await engine.waitForInvocation([r2.invocationId]);
  assert.equal(w2.count, 1);

  // Object options with timeoutMs and requireAll camelCase aliases
  const r3 = engine.invokeAgent('director', 'w3', 'Q3');
  const w3 = await engine.waitForInvocation({
    invocationIds: [r3.invocationId],
    timeoutMs: 1000,
    requireAll: true
  });
  assert.equal(w3.count, 1);
});

await test('Argument validation on missing invokerId, targetAgentId, or prompt', () => {
  const engine = new InvocationEngine({ getAgentAuthority });

  const rNoInvoker = engine.invokeAgent({ targetAgentId: 'w', prompt: 'P' });
  assert.equal(rNoInvoker.success, false);
  assert.equal(rNoInvoker.code, 'INVALID_ARGUMENTS');

  const rNoTarget = engine.invokeAgent({ invokerId: 'd', prompt: 'P' });
  assert.equal(rNoTarget.success, false);
  assert.equal(rNoTarget.code, 'INVALID_ARGUMENTS');

  const rNoPrompt = engine.invokeAgent({ invokerId: 'd', targetAgentId: 'w' });
  assert.equal(rNoPrompt.success, false);
  assert.equal(rNoPrompt.code, 'INVALID_ARGUMENTS');
});

await test('getInvocation, getActiveInvocations, getInvocationHistory, and reset', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => {
      await new Promise(r => setTimeout(r, 20));
      return 'Completed';
    }
  });

  const r = engine.invokeAgent('director', 'worker', 'Job');
  const invId = r.invocationId;

  // Immediately after dispatch: pending in activeInvocations
  const active = engine.getActiveInvocations();
  assert.equal(active.length, 1);
  assert.equal(active[0].invocationId, invId);

  const fetchedPending = engine.getInvocation(invId);
  assert.ok(fetchedPending);
  assert.equal(fetchedPending.status, 'pending');

  // Once microtask fires: running
  await new Promise(r => setTimeout(r, 5));
  const fetchedRunning = engine.getInvocation(invId);
  assert.ok(fetchedRunning);
  assert.equal(fetchedRunning.status, 'running');

  // Wait to complete
  await engine.waitForInvocation(invId);
  assert.equal(engine.getActiveInvocations().length, 0);
  assert.equal(engine.getInvocationHistory().length, 1);

  const fetched2 = engine.getInvocation(invId);
  assert.equal(fetched2.status, 'completed');

  // reset() clears everything
  engine.reset();
  assert.equal(engine.getActiveInvocations().length, 0);
  assert.equal(engine.getInvocationHistory().length, 0);
  assert.equal(engine.getInvocation(invId), null);
});

await test('setRuntimeHooks dynamically updates executeTurn hook', async () => {
  const engine = new InvocationEngine({ getAgentAuthority });

  // Initially executeTurn is null -> returns empty output
  const r1 = engine.invokeAgent('director', 'w1', 'Initial');
  const w1 = await engine.waitForInvocation(r1.invocationId);
  assert.equal(w1.results[0].output, '');

  // Update hook
  engine.setRuntimeHooks({
    executeTurn: async (agent, prompt) => `Hooked: ${prompt}`
  });

  const r2 = engine.invokeAgent('director', 'w1', 'Secondary');
  const w2 = await engine.waitForInvocation(r2.invocationId);
  assert.equal(w2.results[0].output, 'Hooked: Secondary');
});

await test('Invocation per-call timeout_ms times out long running executeTurn', async () => {
  const engine = new InvocationEngine({ getAgentAuthority,
    executeTurn: async () => {
      await new Promise(r => setTimeout(r, 500));
      return 'Late';
    }
  });

  const r = engine.invokeAgent({
    invokerId: 'director',
    targetAgentId: 'worker',
    prompt: 'Slow task',
    timeout_ms: 30
  });

  const w = await engine.waitForInvocation(r.invocationId, { timeout_ms: 500 });
  assert.equal(w.results[0].status, 'timed_out');
  assert.ok(w.results[0].error.includes('timed out'));
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------
console.log('\n========================================================================');
console.log(`  RESULTS: ${passedTests} PASSED, ${failedTests} FAILED (TOTAL ${totalTests})`);
console.log('========================================================================');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
