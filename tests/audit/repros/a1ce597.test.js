/**
 * @file tests/audit/repros/a1ce597.test.js
 * @description Audit repro for ticket a1ce597 (Critical; MOD-21 W8-A):
 * per-call `callerContext.callerAgentId`/`agentId` (including the nested
 * `callerContext.callerContext.agentId`) selects which registered agent's
 * `AuthorityDescriptor` the dispatcher consults, enabling director
 * impersonation and privilege escalation from the exported facade.
 *
 * Contract under test: `toolDefinitions.d.ts` — per-call `callerContext` is
 * caller data, never authority; the identity subject comes only from trusted
 * bound construction (`boundOptions.agentId`/`callerAgentId`), and an
 * anonymous dispatcher defaults to deny.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/a1ce597.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

/**
 * Boots a runtime with a director, an unprivileged `mallory`, and a `victim`.
 * @returns {Promise<import('../../../src/lib/sandbox/runtime/index.ts').AgentRuntime>}
 */
async function createFixtureRuntime() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  await runtime.launchAgent({ id: 'mallory' });
  await runtime.launchAgent({ id: 'victim' });
  return runtime;
}

test('a1ce597 baseline: bound unprivileged caller cannot spawn privileged agents', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: { writeFile: async () => ({ success: true }) },
      agentId: 'mallory',
      allowedTools: [],
      lifecyclePort: runtime.createLifecyclePort(),
      identityPort: runtime.createAgentIdentityPort()
    });

    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'probe', privileged: true });
    assert.equal(receipt.success, false, 'baseline privileged spawn must be denied');
    assert.equal(receipt.code, 'PERMISSION_DENIED');
  } finally {
    runtime.destroy();
  }
});

test('a1ce597: per-call callerAgentId cannot impersonate the director for a privileged spawn', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: { writeFile: async () => ({ success: true }) },
      agentId: 'mallory',
      allowedTools: [],
      lifecyclePort: runtime.createLifecyclePort(),
      identityPort: runtime.createAgentIdentityPort()
    });

    const receipt = await dispatcher.executeTool(
      'spawn_agent',
      { id: 'evil', privileged: true },
      { callerAgentId: 'director' }
    );
    assert.equal(receipt.success, false, 'forged callerAgentId must not select the director authority');
    assert.equal(receipt.code, 'PERMISSION_DENIED');
    assert.equal(runtime.getAgent('evil'), null, 'no agent may be spawned under a forged identity');
  } finally {
    runtime.destroy();
  }
});

test('a1ce597: top-level agentId cannot impersonate the director for a reserved id', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: { writeFile: async () => ({ success: true }) },
      agentId: 'mallory',
      allowedTools: [],
      lifecyclePort: runtime.createLifecyclePort(),
      identityPort: runtime.createAgentIdentityPort()
    });

    const receipt = await dispatcher.executeTool('spawn_agent', { id: 'system' }, { agentId: 'director' });
    assert.equal(receipt.success, false, 'forged agentId must not claim reserved identities');
    assert.equal(receipt.code, 'PERMISSION_DENIED');
    assert.equal(runtime.getAgent('system'), null, 'reserved id must not be spawned');
  } finally {
    runtime.destroy();
  }
});

test('a1ce597: per-call callerAgentId cannot authorize an arbitrary kill', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: { writeFile: async () => ({ success: true }) },
      agentId: 'mallory',
      allowedTools: [],
      lifecyclePort: runtime.createLifecyclePort(),
      identityPort: runtime.createAgentIdentityPort()
    });

    const receipt = await dispatcher.executeTool(
      'kill_agent',
      { agent_id: 'victim' },
      { callerAgentId: 'director' }
    );
    assert.equal(receipt.success, false, 'forged callerAgentId must not authorize a kill');
    assert.notEqual(runtime.getAgent('victim'), null, 'the victim must remain registered');
  } finally {
    runtime.destroy();
  }
});

test('a1ce597: nested callerContext.agentId cannot impersonate on an anonymous dispatcher', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: { writeFile: async () => ({ success: true }) },
      lifecyclePort: runtime.createLifecyclePort(),
      identityPort: runtime.createAgentIdentityPort()
    });

    const receipt = await dispatcher.executeTool(
      'spawn_agent',
      { id: 'evil2', privileged: true },
      { callerContext: { agentId: 'director' } }
    );
    assert.equal(receipt.success, false, 'anonymous dispatcher must default-deny');
    assert.equal(receipt.code, 'PERMISSION_DENIED');
    assert.equal(runtime.getAgent('evil2'), null, 'no agent may be spawned under a forged nested identity');
  } finally {
    runtime.destroy();
  }
});

test('a1ce597: forged per-call identity cannot bypass the VFS workspace ACL', async () => {
  const runtime = await createFixtureRuntime();
  try {
    const identityPort = runtime.createAgentIdentityPort();
    const vfs = new VirtualFS({ identityPort });
    vfs.writeFile({
      filePath: '/secret.txt',
      content: 'victim-secret',
      workspaceId: 'victim',
      callerAgentId: 'victim'
    });

    const dispatcher = createSandboxToolDispatcher({
      virtualFs: vfs,
      agentId: 'mallory',
      allowedTools: ['read_file', 'write_file'],
      identityPort
    });

    const forgedRead = await dispatcher.executeTool(
      'read_file',
      { file_path: '/secret.txt', workspace_id: 'victim' },
      { callerAgentId: 'victim' }
    );
    assert.equal(forgedRead.success, false, 'cross-workspace read under a forged identity must fail');
    assert.ok(
      !JSON.stringify(forgedRead).includes('victim-secret'),
      'the victim workspace contents must never leak'
    );

    const forgedWrite = await dispatcher.executeTool(
      'write_file',
      { file_path: '/intrusion.txt', content: 'intruder', workspace_id: 'victim' },
      { callerAgentId: 'victim' }
    );
    assert.equal(forgedWrite.success, false, 'cross-workspace write under a forged identity must fail');

    let probe = null;
    try {
      probe = vfs.readFile({ filePath: '/intrusion.txt', workspaceId: 'victim', callerAgentId: 'victim' });
    } catch {
      probe = null;
    }
    assert.equal(probe, null, 'no forged artifact may land in the victim workspace');
  } finally {
    runtime.destroy();
  }
});
