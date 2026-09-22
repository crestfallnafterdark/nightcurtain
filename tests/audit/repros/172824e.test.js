/**
 * @file tests/audit/repros/172824e.test.js
 * @description Audit repro for ticket 172824e (Critical; MOD-21 sub-issue 2):
 * creator privilege is caller-asserted via `callerContext` flags, a smuggled
 * `config.callerContext`, or shape-sniffed positional objects.
 *
 * Ratified MOD-21 W3 fix: authority comes only from the registry
 * `AuthorityDescriptor` of the resolved caller identity; flags and
 * shape-sniffed positional objects grant nothing.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/172824e.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('172824e: forged callerContext flags cannot elevate a literal-id spawn', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker' });
    // Every id is ordinary (Wave I, c02d0b9): the forged flags must not mint
    // privilege or bypass on the literal id.
    const ordinary = await runtime.launchAgent({
      config: { id: 'admin' },
      callerContext: { callerAgentId: 'worker', isPrivileged: true, isAdmin: true, privileged: true }
    });
    assert.equal(ordinary.config.privileged, false, 'forged flags on a registered unprivileged caller must not elevate');
    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('admin').realmBypass,
      false,
      'forged flags must not grant the realmBypass grant'
    );
  } finally {
    runtime.destroy();
  }
});

test('172824e: forged callerContext flags cannot spawn privileged agents', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker' });
    await assert.rejects(
      () => runtime.launchAgent({
        config: { id: 'tool-user', privileged: true },
        callerContext: { callerAgentId: 'worker', isPrivileged: true }
      }),
      (err) => err?.code === 'PERMISSION_DENIED'
    );
  } finally {
    runtime.destroy();
  }
});

test('172824e: anonymous flags (no registered identity) cannot spawn privileged agents', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await assert.rejects(
      () => runtime.launchAgent({
        config: { id: 'ghost-tool-user', privileged: true },
        callerContext: { isPrivileged: true, isAdmin: true }
      }),
      (err) => err?.code === 'PERMISSION_DENIED'
    );
  } finally {
    runtime.destroy();
  }
});

test('172824e: config.callerContext privilege flags are ignored', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await assert.rejects(
      () => runtime.launchAgent({
        id: 'smuggled',
        privileged: true,
        callerContext: { callerAgentId: 'nobody', isPrivileged: true, isAdmin: true }
      }),
      (err) => err?.code === 'PERMISSION_DENIED'
    );
  } finally {
    runtime.destroy();
  }
});

test('172824e: positional objects carrying authority-looking flags grant nothing', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await assert.rejects(
      () => runtime.launchAgent(
        { id: 'probe-pos', privileged: true },
        null,
        { callerAgentId: 'worker', isPrivileged: true, isAdmin: true }
      ),
      (err) => err?.code === 'PERMISSION_DENIED',
      'positional objects must not be promoted to caller contexts'
    );
  } finally {
    runtime.destroy();
  }
});
