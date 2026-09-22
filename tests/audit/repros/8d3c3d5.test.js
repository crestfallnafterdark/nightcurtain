/**
 * @file tests/audit/repros/8d3c3d5.test.js
 * @description Audit repro for ticket 8d3c3d5 (Major; MOD-21 sub-issue 6):
 * `listAgentDescriptors` is fail-open for anonymous callers and trusts
 * caller-asserted privilege flags.
 *
 * Ratified MOD-21 W3 fix: visibility is principal-driven through the registry
 * `AuthorityDescriptor`; anonymous callers receive no descriptors, flags are
 * ignored, and unprivileged principals see self and children (the system-scope
 * director is never listed; ticket cf0e127 supersedes the always-visible clause).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/8d3c3d5.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentLifecycleManager } from '../../../src/lib/sandbox/runtime/agentLifecycle/index.ts';

const operator = Object.freeze({ kind: 'internal', subject: 'test-operator' });

async function createFixture() {
  const lifecycle = new AgentLifecycleManager({ emit: { emit: () => {} }, internalPrincipal: operator });
  await lifecycle.launchAgent({ config: { id: 'director', privileged: true }, principal: operator });
  await lifecycle.launchAgent({ config: { id: 'worker', allowedTools: ['read_file'] }, principal: operator });
  await lifecycle.launchAgent({ config: { id: 'child', spawnedBy: 'worker' }, principal: operator });
  await lifecycle.launchAgent({ config: { id: 'stranger' }, principal: operator });
  return lifecycle;
}

test('8d3c3d5: anonymous callers receive no descriptors', async () => {
  const lifecycle = await createFixture();
  assert.deepStrictEqual(lifecycle.listAgentDescriptors({}), []);
  assert.deepStrictEqual(lifecycle.listAgentDescriptors({ isPrivileged: true, isAdmin: true }), []);
});

test('8d3c3d5: forged flags do not widen visibility', async () => {
  const lifecycle = await createFixture();
  const visible = lifecycle.listAgentDescriptors({
    callerAgentId: 'worker',
    isPrivileged: true,
    isAdmin: true,
    privileged: true
  });
  const ids = visible.map((d) => d.id).sort();
  assert.deepStrictEqual(ids, ['child', 'worker'], 'flags must not widen a worker scope (ticket cf0e127: no always-visible director)');
  assert.ok(!ids.includes('stranger'), 'stranger must stay hidden');
});

test('8d3c3d5: unprivileged principal sees self and children only', async () => {
  const lifecycle = await createFixture();
  const ids = lifecycle.listAgentDescriptors({ callerAgentId: 'worker' }).map((d) => d.id).sort();
  assert.deepStrictEqual(ids, ['child', 'worker'], 'the system-scope director is never listed to a non-bypass caller (cf0e127)');
});

test('8d3c3d5: registry authority sees every descriptor', async () => {
  const lifecycle = await createFixture();
  const allIds = lifecycle.listAgentDescriptors({ callerAgentId: 'director' }).map((d) => d.id).sort();
  assert.deepStrictEqual(allIds, ['child', 'director', 'stranger', 'worker']);

  const viaOperator = lifecycle.listAgentDescriptors({ principal: operator }).map((d) => d.id).sort();
  assert.deepStrictEqual(viaOperator, ['child', 'director', 'stranger', 'worker']);
});

test('8d3c3d5: a forged descriptor object is not a principal', async () => {
  const lifecycle = await createFixture();
  const forged = Object.freeze({
    subject: 'director',
    kind: 'agent',
    allow: new Set(['*']),
    visibility: 'all'
  });
  assert.deepStrictEqual(lifecycle.listAgentDescriptors({ principal: forged }), []);
});
