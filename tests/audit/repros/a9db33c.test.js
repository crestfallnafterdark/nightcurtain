/**
 * @file tests/audit/repros/a9db33c.test.js
 * @description Audit repro for ticket a9db33c (Critical; MOD-21 sub-issue 7):
 * invocation authority derives from magic invoker ids (`director`/`admin`),
 * caller-supplied roles, and caller-supplied privilege flags.
 *
 * Ratified MOD-21 W3 fix: invoker authority comes from the registry
 * `AuthorityDescriptor` of the resolved invoker only; flags and role aliases
 * are ignored (self and parent-creator invocation remain allowed by parentage).
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/a9db33c.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { InvocationEngine } from '../../../src/lib/sandbox/invocationEngine/index.ts';

test('a9db33c: magic admin id no longer grants invocation authority', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'victim' });
    const receipt = runtime.invokeAgent('admin', 'victim', 'P');
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('a9db33c: caller-supplied roles and flags do not elevate', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'mallory' });
    await runtime.launchAgent({ id: 'victim' });

    const forgedFlags = runtime.invokeAgent('mallory', 'victim', 'P', {
      isAdmin: true,
      isPrivileged: true,
      privileged: true
    });
    assert.strictEqual(forgedFlags.success, false);
    assert.strictEqual(forgedFlags.code, 'PERMISSION_DENIED');

    const forgedRole = runtime.invokeAgent('mallory', 'victim', 'P', {
      callerRole: 'admin',
      role: 'admin'
    });
    assert.strictEqual(forgedRole.success, false);
    assert.strictEqual(forgedRole.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('a9db33c: registry authority may invoke peers; self invocation stays allowed', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    await runtime.launchAgent({ id: 'victim' });
    await runtime.launchAgent({ id: 'mallory' });

    const sudoer = runtime.invokeAgent('director', 'victim', 'P');
    assert.strictEqual(sudoer.success, true, 'registry sudoer may invoke a peer');

    const self = runtime.invokeAgent('mallory', 'mallory', 'P');
    assert.strictEqual(self.success, true, 'self invocation needs no sudo authority');
  } finally {
    runtime.destroy();
  }
});

test('a9db33c: engine authority resolver replaces id magic and flags', () => {
  const agents = {
    boss: { id: 'boss' },
    peer: { id: 'peer' },
    target: { id: 'target' }
  };
  const authorities = {
    boss: Object.freeze({
      subject: 'boss',
      kind: 'agent',
      allow: new Set(['*']),
      visibility: 'all'
    })
  };
  const engine = new InvocationEngine({
    getAgent: (id) => agents[id] || null,
    getAgentAuthority: (id) => authorities[id] || null
  });

  const granted = engine.invokeAgent({ invokerId: 'boss', targetAgentId: 'target', prompt: 'P' });
  assert.strictEqual(granted.success, true);

  const magic = engine.invokeAgent({ invokerId: 'admin', targetAgentId: 'target', prompt: 'P' });
  assert.strictEqual(magic.success, false);
  assert.strictEqual(magic.code, 'PERMISSION_DENIED');

  const forged = engine.invokeAgent({
    invokerId: 'peer',
    targetAgentId: 'target',
    prompt: 'P',
    isAdmin: true,
    isPrivileged: true,
    callerRole: 'admin',
    role: 'admin'
  });
  assert.strictEqual(forged.success, false);
  assert.strictEqual(forged.code, 'PERMISSION_DENIED');
});
