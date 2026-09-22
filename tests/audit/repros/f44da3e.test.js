/**
 * @file tests/audit/repros/f44da3e.test.js
 * @description Audit repro for ticket f44da3e (Major; prog:realm): a
 * manager-preset agent (`spawn_agent` + `kill_agent`) can pin a spawned
 * child's workspace to ANY key — the `spawn_agent` parameter sanitizer
 * preserves undeclared keys and launch composed
 * `workspaceId: config.workspaceId || config.workspace || agentId` — and then
 * have the child self-kill, evicting that workspace under the engine-bound
 * internal principal (`deleteWorkspace(resolvedKey, ...)`). Verified
 * destruction of `realm:alpha:global` and a peer's private workspace.
 * `deleteWorkspace` protected only the exact string `global`, so `public`,
 * `Global`, `/global/`, and every `realm:<id>:global` key were deletable.
 *
 * Ratified fix (both parts):
 * 1. Launch-time workspace confinement: a non-authority creator may pin the
 *    child workspace only to the child's own id or to the creator's own
 *    resolved workspace key; every other pin fails closed with
 *    `PERMISSION_DENIED` before any registration (no zombie child). Authority
 *    and internal (host/operator) creators keep full pinning.
 * 2. Reserved-key protection in `deleteWorkspace`: `global` (exact),
 *    `public`, and the `realm:<id>:global` namespace return `false` without
 *    eviction, even for the internal principal. Controlled Realm deletion is
 *    the operator Realm path (Wave A ticket 49cfc41), not lifecycle teardown.
 *
 * Zero-mock: real `AgentRuntime`, real `VirtualFS`, real `MessagingBus`, real
 * descriptor pipeline, and the real dispatcher.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/f44da3e.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

/** Opaque engine-internal principal used only for the direct VFS checks. */
const INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'f44da3e_test_admin' });

const VICTIM_SECRET = 'peer private workspace bytes';
const REALM_SECRET = 'realm-global workspace bytes';
const PUBLIC_SECRET = 'public workspace bytes';

/**
 * Builds a real runtime fixture with the bootstrapped director, so
 * descriptor-forwarded caller identity resolves to real registry authority.
 * @returns {Promise<{ runtime: AgentRuntime, virtualFs: VirtualFS }>}
 */
async function createRealRuntime() {
  const virtualFs = new VirtualFS();
  const messagingBus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs, messagingBus, autoBootstrapDirector: false });
  await runtime.ensureDirector();
  return { runtime, virtualFs };
}

/**
 * Launches the manager-preset attacker through the director.
 * @param {AgentRuntime} runtime
 * @returns {Promise<void>}
 */
async function launchManagerPreset(runtime) {
  await runtime.launchAgent({
    config: { id: 'manager-preset', role: 'manager' },
    callerContext: { callerAgentId: 'director' }
  });
}

/**
 * Attempts the full attack chain through the real dispatcher: the
 * manager-preset agent spawns a child pinned to `workspaceKey`, then the child
 * self-kills. Returns both receipts for assertion.
 * @param {AgentRuntime} runtime
 * @param {string} childId
 * @param {string} workspaceKey
 * @returns {Promise<{ spawnReceipt: object, killReceipt: object }>}
 */
async function attemptPinnedSpawnThenSelfKill(runtime, childId, workspaceKey) {
  const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-preset' });
  const spawnReceipt = await managerDispatcher.executeTool('spawn_agent', {
    id: childId,
    role: 'manager',
    workspace: workspaceKey
  });

  const childDispatcher = createSandboxToolDispatcher({ runtime, agentId: childId });
  const killReceipt = await childDispatcher.executeTool('kill_agent', {
    agent_id: childId,
    reason: 'f44da3e repro attempt'
  });

  return { spawnReceipt, killReceipt };
}

test('f44da3e: spawn+kill cannot evict a peer private workspace', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    await launchManagerPreset(runtime);
    virtualFs.writeFile('/secret.txt', VICTIM_SECRET, { workspaceId: 'victim', callerAgentId: 'victim' });

    const { spawnReceipt } = await attemptPinnedSpawnThenSelfKill(runtime, 'toolspawn-peer', 'victim');

    assert.equal(
      spawnReceipt.success,
      false,
      'a non-authority creator must not be able to pin a peer private workspace'
    );
    assert.equal(spawnReceipt.code, 'PERMISSION_DENIED', 'the refused pin uses the denial semantics');
    assert.equal(runtime.getAgent('toolspawn-peer'), null, 'no active partially-launched child');
    assert.equal(runtime.getRecycledAgent('toolspawn-peer'), null, 'no zombie child in the recycle bin');
    assert.equal(
      virtualFs.readFile('/secret.txt', { workspaceId: 'victim', callerAgentId: 'victim', raw: true }),
      VICTIM_SECRET,
      'the peer workspace bytes must survive the attempt'
    );
  } finally {
    runtime.destroy();
  }
});

test('f44da3e: spawn+kill cannot evict a reserved realm-global workspace', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    await launchManagerPreset(runtime);
    const realmKey = 'realm:alpha:global';
    virtualFs.writeFile('/realm.txt', REALM_SECRET, { workspaceId: realmKey, callerAgentId: realmKey });

    const { spawnReceipt } = await attemptPinnedSpawnThenSelfKill(runtime, 'toolspawn-realm', realmKey);

    assert.equal(spawnReceipt.success, false, 'a realm-global key pin must be refused');
    assert.equal(spawnReceipt.code, 'PERMISSION_DENIED', 'the refused pin uses the denial semantics');
    assert.equal(runtime.getAgent('toolspawn-realm'), null, 'no active partially-launched child');
    assert.equal(runtime.getRecycledAgent('toolspawn-realm'), null, 'no zombie child in the recycle bin');
    assert.equal(
      virtualFs.readFile('/realm.txt', { workspaceId: realmKey, callerAgentId: realmKey, raw: true }),
      REALM_SECRET,
      'the realm-global workspace bytes must survive the attempt'
    );
  } finally {
    runtime.destroy();
  }
});

test('f44da3e: spawn+kill cannot evict the public workspace', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    await launchManagerPreset(runtime);
    virtualFs.writeFile('/public.txt', PUBLIC_SECRET, { workspaceId: 'public' });

    const { spawnReceipt } = await attemptPinnedSpawnThenSelfKill(runtime, 'toolspawn-public', 'public');

    assert.equal(spawnReceipt.success, false, 'the public workspace pin must be refused');
    assert.equal(spawnReceipt.code, 'PERMISSION_DENIED', 'the refused pin uses the denial semantics');
    assert.equal(runtime.getAgent('toolspawn-public'), null, 'no active partially-launched child');
    assert.equal(runtime.getRecycledAgent('toolspawn-public'), null, 'no zombie child in the recycle bin');
    assert.equal(
      virtualFs.readFile('/public.txt', { workspaceId: 'public', raw: true }),
      PUBLIC_SECRET,
      'the public workspace bytes must survive the attempt'
    );
  } finally {
    runtime.destroy();
  }
});

test('f44da3e: deleteWorkspace refuses reserved keys for the internal principal', () => {
  const virtualFs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  const realmKey = 'realm:alpha:global';

  virtualFs.writeFile('/g.txt', 'global data', { workspaceId: 'global' });
  virtualFs.writeFile('/p.txt', PUBLIC_SECRET, { workspaceId: 'public', callerAgentId: 'public' });
  virtualFs.writeFile('/r.txt', REALM_SECRET, { workspaceId: realmKey, callerAgentId: realmKey });

  assert.equal(
    virtualFs.deleteWorkspace('global', { principal: INTERNAL_PRINCIPAL }),
    false,
    'the exact global key stays protected'
  );
  assert.equal(
    virtualFs.deleteWorkspace('public', { principal: INTERNAL_PRINCIPAL }),
    false,
    'the public alias is protected like global'
  );
  assert.equal(
    virtualFs.deleteWorkspace(realmKey, { principal: INTERNAL_PRINCIPAL }),
    false,
    'every realm:<id>:global key is protected'
  );

  assert.equal(virtualFs.readFile('/g.txt', { workspaceId: 'global', raw: true }), 'global data');
  assert.equal(virtualFs.readFile('/p.txt', { workspaceId: 'public', raw: true }), PUBLIC_SECRET);
  assert.equal(
    virtualFs.readFile('/r.txt', { workspaceId: realmKey, callerAgentId: realmKey, raw: true }),
    REALM_SECRET
  );

  // A non-reserved private workspace still deletes for the authorized principal.
  virtualFs.writeFile('/d.txt', 'disposable', { workspaceId: 'temp_ws', callerAgentId: 'temp_ws' });
  assert.equal(
    virtualFs.deleteWorkspace('temp_ws', { principal: INTERNAL_PRINCIPAL }),
    true,
    'ordinary private workspaces remain deletable'
  );
});

test('f44da3e: authorized host pinning still works and a creator may share its own workspace', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    // Host/operator path: the director (lifecycle authority) pins an explicit workspace.
    const hosted = await runtime.launchAgent({
      config: { id: 'host-pinned', workspace: 'host-shared-ws', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'director' }
    });
    assert.equal(hosted.config.workspaceId, 'host-shared-ws', 'authorized explicit pinning is unchanged');

    await launchManagerPreset(runtime);

    // A non-authority creator may pin a child to its OWN resolved workspace.
    const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-preset' });
    const sharedReceipt = await managerDispatcher.executeTool('spawn_agent', {
      id: 'toolspawn-shared',
      role: 'manager',
      workspace: 'manager-preset'
    });
    assert.equal(sharedReceipt.success, true, 'sharing the creator workspace is an allowed composition');
    assert.equal(
      runtime.getAgent('toolspawn-shared')?.config?.workspaceId,
      'manager-preset',
      'the allowed creator-workspace pin is honored verbatim'
    );

    // The same creator may pin the child to the child's own id.
    const selfReceipt = await managerDispatcher.executeTool('spawn_agent', {
      id: 'toolspawn-self',
      role: 'manager',
      workspace: 'toolspawn-self'
    });
    assert.equal(selfReceipt.success, true, 'pinning to the child own id is the default composition');
    assert.equal(runtime.getAgent('toolspawn-self')?.config?.workspaceId, 'toolspawn-self');

    // The host-pinned workspace pin is untouched by the manager attempts.
    assert.equal(runtime.getAgent('host-pinned')?.config?.workspaceId, 'host-shared-ws');
  } finally {
    runtime.destroy();
  }
});
