/**
 * @file tests/audit/repros/26c3913.test.js
 * @description Audit repro for ticket 26c3913 (Major; prog:realm; verifier
 * finding V7-F1): the f44da3e launch confinement guards only EXPLICIT
 * workspace pins, so destruction is still reachable without any pin.
 *
 * Attack chain (pre-fix):
 * 1. The director launches a peer `alice` into the explicit workspace
 *    `ws-victim`.
 * 2. A manager-preset, non-authority agent spawns a child whose id equals a
 *    peer's workspace key (`ws-victim`) with no workspace parameter. Launch
 *    composition resolves the child workspace as
 *    `config.workspaceId || config.workspace || agentId` — its own id — so the
 *    child silently adopts the peer's workspace key.
 * 3. The child self-kills (`kill_agent`), and `AgentLifecycleManager.killAgent`
 *    unconditionally evicts the resolved key under the engine-bound internal
 *    principal. The peer's bytes are destroyed while the peer stays active.
 *
 * The same works for orphan workspaces with no owning agent: a child named
 * after a pre-existing workspace simply shadows it and evicts it on self-kill.
 * Reserved-key protection (`global`/`public`/`realm:<id>:global`) already held
 * and is asserted here as an unchanged guard.
 *
 * Ratified claim-aware remediation (this repro is the red-before evidence):
 * 1. Launch gate for resolved non-authority principals: the resolved key
 *    (`workspaceId || workspace || agentId`) must not be claimed by any other
 *    registered record (active or recycled), and a resolved own-id key must not
 *    already exist in the VFS (no shadowing of pre-existing/orphan
 *    workspaces). Authority/internal/sentinel creators keep full pinning.
 * 2. Claim-aware eviction: kill/purge/emptyRecycleBin delete the resolved key
 *    only when no other registered record resolves to it (last-claimant
 *    cleanup); creator-shared child workspaces survive the child's death.
 *
 * Zero-mock: real `AgentRuntime`, real `VirtualFS`, real `MessagingBus`, real
 * descriptor pipeline, and the real dispatcher.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/26c3913.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

const VICTIM_SECRET = 'peer workspace bytes';
const ORPHAN_SECRET = 'orphan workspace bytes';
const CREATOR_SECRET = 'creator workspace bytes';
const RESERVED_SECRET = 'realm-global workspace bytes';

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
 * Seeds a workspace sentinel through the workspace's own caller identity (the
 * VFS ACL models a private workspace's member that way).
 * @param {VirtualFS} virtualFs
 * @param {string} workspaceId
 * @param {string} content
 */
function seedWorkspace(virtualFs, workspaceId, content) {
  virtualFs.writeFile('/sentinel.txt', content, { workspaceId, callerAgentId: workspaceId });
}

/**
 * Reads a seeded workspace sentinel back through the same caller identity.
 * @param {VirtualFS} virtualFs
 * @param {string} workspaceId
 * @returns {string}
 */
function readSentinel(virtualFs, workspaceId) {
  return virtualFs.readFile('/sentinel.txt', { workspaceId, callerAgentId: workspaceId, raw: true });
}

/**
 * Launches a non-authority manager-preset agent through the director.
 * @param {AgentRuntime} runtime
 * @param {string} agentId
 * @returns {Promise<void>}
 */
async function launchManager(runtime, agentId) {
  await runtime.launchAgent({
    config: { id: agentId, role: 'manager' },
    callerContext: { callerAgentId: 'director' }
  });
}

test('26c3913 (a): a child id shadowing a peer workspace key is denied and the peer bytes survive', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    await runtime.launchAgent({
      config: { id: 'alice', workspaceId: 'ws-victim', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'director' }
    });
    seedWorkspace(virtualFs, 'ws-victim', VICTIM_SECRET);
    await launchManager(runtime, 'manager-collision');

    const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-collision' });
    const spawnReceipt = await managerDispatcher.executeTool('spawn_agent', {
      id: 'ws-victim',
      role: 'manager'
    });

    assert.equal(
      spawnReceipt.success,
      false,
      'a non-authority creator must not spawn a child whose id shadows a registered peer workspace key'
    );
    assert.equal(spawnReceipt.code, 'PERMISSION_DENIED', 'the refused shadow spawn uses denial semantics');
    assert.equal(runtime.getAgent('ws-victim'), null, 'no active partially-launched shadow child');
    assert.equal(runtime.getRecycledAgent('ws-victim'), null, 'no zombie shadow child in the recycle bin');

    // Even an attempted kill of the never-launched shadow id must not evict.
    const shadowDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'ws-victim' });
    const killReceipt = await shadowDispatcher.executeTool('kill_agent', {
      agent_id: 'ws-victim',
      reason: '26c3913 shadow kill attempt'
    });
    assert.notEqual(killReceipt.success, true, 'there is no live shadow child to self-kill');

    assert.ok(runtime.getAgent('alice'), 'the peer stays active after the attempt');
    assert.ok(virtualFs.hasWorkspace('ws-victim'), 'the peer workspace must not be evicted');
    assert.equal(readSentinel(virtualFs, 'ws-victim'), VICTIM_SECRET, 'the peer workspace bytes must survive');
  } finally {
    runtime.destroy();
  }
});

test('26c3913 (b): killing a child that shares the creator workspace leaves the creator files intact', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    await launchManager(runtime, 'manager-shared');
    // The realm-bound creator's private workspace key is its canonical
    // `(realmId, agentId)` identity key (Wave I, ticket d57cbc1), not the bare
    // id; resolve it through the runtime identity port so the fixture seeds and
    // pins exactly the workspace whose last-claimant protection is asserted.
    const managerIdentity = runtime.createAgentIdentityPort().getAgentIdentity('manager-shared');
    assert.ok(managerIdentity, 'setup: the creator identity must resolve');
    const sharedWorkspaceKey = managerIdentity.key;
    assert.ok(
      sharedWorkspaceKey && sharedWorkspaceKey !== 'manager-shared',
      'setup: a realm-bound creator keys its private workspace canonically'
    );
    seedWorkspace(virtualFs, sharedWorkspaceKey, CREATOR_SECRET);

    const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-shared' });
    const spawnReceipt = await managerDispatcher.executeTool('spawn_agent', {
      id: 'child-shared',
      role: 'manager',
      workspace: sharedWorkspaceKey
    });
    assert.equal(spawnReceipt.success, true, 'sharing the creator workspace remains an allowed composition');
    assert.equal(
      runtime.getAgent('child-shared')?.config?.workspaceId,
      sharedWorkspaceKey,
      'the shared child adopts the creator workspace key'
    );

    const childDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'child-shared' });
    const killReceipt = await childDispatcher.executeTool('kill_agent', {
      agent_id: 'child-shared',
      reason: '26c3913 shared-workspace self-kill'
    });
    assert.equal(killReceipt.success, true, 'the child self-kill itself completes');
    assert.ok(runtime.getRecycledAgent('child-shared'), 'the child lands in the recycle bin');

    assert.ok(runtime.getAgent('manager-shared'), 'the creator stays active');
    assert.ok(
      virtualFs.hasWorkspace(sharedWorkspaceKey),
      "killing the child must not evict the creator's shared workspace"
    );
    assert.equal(
      readSentinel(virtualFs, sharedWorkspaceKey),
      CREATOR_SECRET,
      "the creator's shared workspace bytes must survive the child teardown"
    );
  } finally {
    runtime.destroy();
  }
});

test('26c3913 (c): a child id shadowing a pre-existing orphan workspace is denied at launch', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    await launchManager(runtime, 'manager-orphan');
    seedWorkspace(virtualFs, 'orphan-ws', ORPHAN_SECRET);

    const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-orphan' });
    const spawnReceipt = await managerDispatcher.executeTool('spawn_agent', {
      id: 'orphan-ws',
      role: 'manager'
    });

    assert.equal(
      spawnReceipt.success,
      false,
      'a non-authority creator must not shadow a pre-existing workspace with the child id'
    );
    assert.equal(spawnReceipt.code, 'PERMISSION_DENIED', 'the refused shadow spawn uses denial semantics');
    assert.equal(runtime.getAgent('orphan-ws'), null, 'no partially-launched shadow child');
    assert.equal(runtime.getRecycledAgent('orphan-ws'), null, 'no zombie shadow child');

    assert.ok(virtualFs.hasWorkspace('orphan-ws'), 'the orphan workspace must survive the attempt');
    assert.equal(readSentinel(virtualFs, 'orphan-ws'), ORPHAN_SECRET, 'the orphan bytes must survive');
  } finally {
    runtime.destroy();
  }
});

test('26c3913 (d): authority pins and legitimate fresh own-id launches are unchanged', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    // Authority (director / host-operator path) keeps full pinning, including
    // onto a key claimed by a live peer.
    const peerPinned = await runtime.launchAgent({
      config: { id: 'peer-owner', workspaceId: 'claimed-key', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'director' }
    });
    assert.equal(peerPinned.config.workspaceId, 'claimed-key');

    const operatorPinned = await runtime.launchAgent({
      config: { id: 'operator-child', workspaceId: 'claimed-key', allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'director' }
    });
    assert.equal(operatorPinned.config.workspaceId, 'claimed-key', 'authority pinning is unchanged');

    // Principal-less direct engine/host launch keeps the legacy behavior.
    const engineDirect = await runtime.launchAgent({
      config: { id: 'engine-direct', workspaceId: 'engine-direct-ws' }
    });
    assert.equal(engineDirect.config.workspaceId, 'engine-direct-ws', 'legacy engine launch pinning is unchanged');

    // A fresh own-id launch (no workspace exists, no claimant) stays allowed.
    await launchManager(runtime, 'manager-fresh');
    const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-fresh' });
    const freshReceipt = await managerDispatcher.executeTool('spawn_agent', {
      id: 'fresh-child',
      role: 'manager'
    });
    assert.equal(freshReceipt.success, true, 'a legitimate fresh own-id child launch stays allowed');
    assert.equal(runtime.getAgent('fresh-child')?.config?.workspaceId, 'fresh-child');

    // The fresh child's implicit workspace is not shadowing anything.
    assert.equal(virtualFs.hasWorkspace('fresh-child'), false, 'a fresh own-id child has no pre-existing workspace');
  } finally {
    runtime.destroy();
  }
});

test('26c3913 (e): reserved-key protection still holds', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    const realmKey = 'realm:alpha:global';
    await runtime.launchAgent({
      config: { id: 'realm-pinned', workspaceId: realmKey, allowedTools: ['read_file'] },
      callerContext: { callerAgentId: 'director' }
    });
    seedWorkspace(virtualFs, realmKey, RESERVED_SECRET);
    await launchManager(runtime, 'manager-reserved');

    const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-reserved' });
    const deniedPin = await managerDispatcher.executeTool('spawn_agent', {
      id: 'reserved-pinned',
      role: 'manager',
      workspace: realmKey
    });
    assert.equal(deniedPin.success, false, 'a non-authority reserved-key pin is still refused');
    assert.equal(deniedPin.code, 'PERMISSION_DENIED');

    const directorDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'director', allowedTools: ['*'] });
    const killReceipt = await directorDispatcher.executeTool('kill_agent', {
      agent_id: 'realm-pinned',
      reason: '26c3913 reserved-key guard'
    });
    assert.equal(killReceipt.success, true, 'the authorized kill itself completes');
    assert.ok(virtualFs.hasWorkspace(realmKey), 'the realm-global workspace survives the kill');
    assert.equal(readSentinel(virtualFs, realmKey), RESERVED_SECRET);
  } finally {
    runtime.destroy();
  }
});
