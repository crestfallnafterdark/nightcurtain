/**
 * @file tests/integration/lifecycle_workspace_eviction_test.js
 * @description Ticket 4e9e0c8 (Realm wave A0-4) — lifecycle teardown is a
 * DESTRUCTIVE filesystem-eviction capability, not just a registry mutation.
 *
 * The suite drives the real tool seam (`kill_agent` through
 * `createSandboxToolDispatcher` → `LifecyclePort` → `AgentRuntime.killAgent` →
 * `AgentLifecycleManager.killAgent`) against a real `AgentRuntime` and
 * `VirtualFS`, and asserts that exactly the target's resolved workspace
 * (`config.workspaceId || config.workspace || agent id`) is evicted while every
 * other workspace — a peer's workspace, the `global` workspace, and even a
 * workspace named exactly like the raw agent id — survives untouched.
 *
 * There is no tool descriptor for purge/`emptyRecycleBin`, so the purge eviction
 * path is covered at the nearest available seam: the real
 * `AgentRuntime.purgeAgent`/`emptyRecycleBin` public API that the store uses.
 *
 * Zero-mock: every class under test is a real production instance
 * (`AgentRuntime`, `VirtualFS`, `MessagingBus`, `AgentLifecycleManager`, the
 * real descriptor pipeline and dispatcher).
 *
 * Ticket 26c3913 (V7-F1) coverage: claim-aware launch confinement and
 * last-claimant eviction — a child whose id/workspace shadows a peer or an
 * orphan workspace is refused, and a workspace still resolved by another
 * registered record (active or recycled, including a creator sharing its
 * workspace with a child) survives every teardown until its last claimant is
 * torn down.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';

/** Canonical private-workspace/registration key of a Generic-realm launch. */
const genericKey = (id) => createAgentIdentityKey('realm_generic', id);

/**
 * Builds a real runtime fixture. The injected `VirtualFS` receives the
 * composition-root internal principal via `bindInternalPrincipal` (first bind
 * wins), and the director is bootstrapped so descriptor-forwarded caller
 * identity resolves to real registry authority. The injected VFS carries no
 * identity port (the runtime wires one only for a VFS it constructs itself),
 * so direct storage calls in this suite address workspace keys literally;
 * lifecycle resolution still keys canonically (Wave I, d57cbc1).
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
 * Seeds a private workspace with a sentinel file. The caller identity matches
 * the workspace key — the VFS ACL models a workspace's own member that way.
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
  return virtualFs.readFile('/sentinel.txt', {
    workspaceId,
    callerAgentId: workspaceId,
    raw: true
  });
}

test('kill_agent through the dispatcher evicts exactly the resolved workspace and nothing else', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  await runtime.launchAgent({
    config: { id: 'realm-victim', workspaceId: 'realm-victim-ws', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  await runtime.launchAgent({
    config: { id: 'realm-bystander', workspaceId: 'bystander-ws', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });

  // The victim's real workspace, a workspace named exactly like its raw agent
  // id (must NOT be the eviction target), the peer workspace, and /global.
  seedWorkspace(virtualFs, 'realm-victim-ws', 'victim private data');
  seedWorkspace(virtualFs, 'realm-victim', 'workspace named after the raw agent id');
  seedWorkspace(virtualFs, 'bystander-ws', 'bystander private data');
  virtualFs.writeFile('/global-sentinel.txt', 'shared global data', { workspaceId: 'global' });

  const dispatcher = createSandboxToolDispatcher({
    runtime,
    agentId: 'director',
    allowedTools: ['*']
  });

  const receipt = await dispatcher.executeTool('kill_agent', {
    agent_id: 'realm-victim',
    reason: 'A0-4 eviction coverage'
  });

  assert.equal(receipt.success, true, 'kill_agent must succeed for the authorized director');
  assert.equal(receipt.id, 'realm-victim');
  assert.equal(runtime.getAgent('realm-victim'), null, 'victim leaves the active registry');
  assert.ok(runtime.getRecycledAgent('realm-victim'), 'victim lands in the recycle bin');

  assert.equal(
    virtualFs.hasWorkspace('realm-victim-ws'),
    false,
    "the victim's resolved workspace (config.workspaceId) must be evicted"
  );
  assert.ok(
    virtualFs.hasWorkspace('bystander-ws'),
    'a peer workspace must not be evicted'
  );
  assert.equal(
    readSentinel(virtualFs, 'bystander-ws'),
    'bystander private data',
    'peer workspace contents must survive the eviction'
  );
  assert.ok(
    virtualFs.hasWorkspace('realm-victim'),
    'a workspace merely named like the raw agent id is not the victim workspace and must survive'
  );
  assert.equal(
    readSentinel(virtualFs, 'realm-victim'),
    'workspace named after the raw agent id',
    'the raw-id-named workspace contents must survive the eviction'
  );
  assert.equal(
    virtualFs.readFile('/global-sentinel.txt', { workspaceId: 'global', raw: true }),
    'shared global data',
    'the shared global workspace must survive the eviction'
  );
});

test('purgeAgent evicts the resolved workspace at the runtime seam', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  await runtime.launchAgent({
    config: { id: 'purge-victim', workspaceId: 'purge-victim-ws', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  await runtime.launchAgent({
    config: { id: 'purge-bystander', workspaceId: 'purge-bystander-ws', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });

  seedWorkspace(virtualFs, 'purge-victim-ws', 'purge victim data');
  seedWorkspace(virtualFs, 'purge-victim', 'raw-id workspace sentinel');
  seedWorkspace(virtualFs, 'purge-bystander-ws', 'purge bystander data');

  const purged = runtime.purgeAgent('purge-victim', { callerAgentId: 'director' });

  assert.equal(purged, true, 'an authorized director may purge the active victim');
  assert.equal(runtime.getAgent('purge-victim'), null, 'purged victim leaves the active registry');
  assert.equal(
    virtualFs.hasWorkspace('purge-victim-ws'),
    false,
    "purge must evict the victim's resolved workspace"
  );
  assert.ok(
    virtualFs.hasWorkspace('purge-victim'),
    'purge must not touch a workspace merely named like the raw agent id'
  );
  assert.ok(
    virtualFs.hasWorkspace('purge-bystander-ws'),
    'purge must leave a peer workspace intact'
  );
  assert.equal(
    readSentinel(virtualFs, 'purge-bystander-ws'),
    'purge bystander data',
    'peer workspace contents must survive the purge'
  );
});

test('emptyRecycleBin evicts each recycled member resolved workspace', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  await runtime.launchAgent({
    config: { id: 'bin-victim', workspaceId: 'bin-victim-ws', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  await runtime.launchAgent({
    config: { id: 'bin-bystander', workspaceId: 'bin-bystander-ws', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });

  assert.ok(runtime.killAgent('bin-victim', 'Recycle for bin purge', { callerAgentId: 'director' }));

  // Re-seed both the resolved workspace and the raw-id-named workspace after
  // the kill so the recycle-bin purge eviction is observable on its own.
  seedWorkspace(virtualFs, 'bin-victim-ws', 'recycled member data');
  seedWorkspace(virtualFs, 'bin-victim', 'raw-id workspace sentinel');
  seedWorkspace(virtualFs, 'bin-bystander-ws', 'active peer data');

  const purgedCount = runtime.emptyRecycleBin({ callerAgentId: 'director' });

  assert.equal(purgedCount, 1, 'exactly the one recycled member is purged');
  assert.equal(
    virtualFs.hasWorkspace('bin-victim-ws'),
    false,
    'the recycled member resolved workspace must be evicted'
  );
  assert.ok(
    virtualFs.hasWorkspace('bin-victim'),
    'the raw-id-named workspace must survive the recycle-bin purge'
  );
  assert.ok(
    virtualFs.hasWorkspace('bin-bystander-ws'),
    'the active peer workspace must survive the recycle-bin purge'
  );
});

test('spawn_agent workspace pinning is confined for non-authority creators (f44da3e)', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  await runtime.launchAgent({
    config: { id: 'manager-lane', role: 'manager' },
    callerContext: { callerAgentId: 'director' }
  });
  seedWorkspace(virtualFs, 'peer-lane', 'peer private data');
  virtualFs.writeFile('/realm-sentinel.txt', 'realm global data', {
    workspaceId: 'realm:alpha:global',
    callerAgentId: 'realm:alpha:global'
  });

  const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-lane' });

  const deniedPeer = await managerDispatcher.executeTool('spawn_agent', {
    id: 'pinned-peer',
    role: 'manager',
    workspace: 'peer-lane'
  });
  assert.equal(deniedPeer.success, false, 'a non-authority creator cannot pin a peer private workspace');
  assert.equal(deniedPeer.code, 'PERMISSION_DENIED', 'the refused pin reports the denial code');
  assert.equal(runtime.getAgent('pinned-peer'), null, 'no partially-launched child stays registered');
  assert.equal(runtime.getRecycledAgent('pinned-peer'), null, 'no zombie child lands in the recycle bin');

  const deniedRealm = await managerDispatcher.executeTool('spawn_agent', {
    id: 'pinned-realm',
    role: 'manager',
    workspace: 'realm:alpha:global'
  });
  assert.equal(deniedRealm.success, false, 'a reserved realm-global pin is refused');
  assert.equal(deniedRealm.code, 'PERMISSION_DENIED', 'the refused realm pin reports the denial code');
  assert.equal(runtime.getAgent('pinned-realm'), null, 'the denied realm spawn leaves no child');

  assert.equal(readSentinel(virtualFs, 'peer-lane'), 'peer private data', 'the peer workspace bytes survive');
  assert.equal(
    virtualFs.readFile('/realm-sentinel.txt', { workspaceId: 'realm:alpha:global', callerAgentId: 'realm:alpha:global', raw: true }),
    'realm global data',
    'the realm-global workspace bytes survive'
  );

  // Explicit pins that ARE legitimate keep working.
  const shared = await managerDispatcher.executeTool('spawn_agent', {
    id: 'pinned-shared',
    role: 'manager',
    workspace: 'manager-lane'
  });
  assert.equal(shared.success, true, 'a creator may pin a child to its own resolved workspace');
  assert.equal(runtime.getAgent('pinned-shared')?.config?.workspaceId, 'manager-lane');

  const hosted = await runtime.launchAgent({
    config: { id: 'host-pinned', workspace: 'host-shared-ws', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  assert.equal(hosted.config.workspaceId, 'host-shared-ws', 'authorized host/operator explicit pinning is unchanged');
});

test('kill_agent never evicts reserved global/public/realm-global workspaces (f44da3e)', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  await runtime.launchAgent({
    config: { id: 'realm-pinned', workspaceId: 'realm:alpha:global', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  await runtime.launchAgent({
    config: { id: 'public-pinned', workspaceId: 'public', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });

  seedWorkspace(virtualFs, 'realm:alpha:global', 'realm global data');
  virtualFs.writeFile('/pub.txt', 'public data', { workspaceId: 'public' });

  const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'director', allowedTools: ['*'] });

  const realmReceipt = await dispatcher.executeTool('kill_agent', {
    agent_id: 'realm-pinned',
    reason: 'reserved eviction guard'
  });
  assert.equal(realmReceipt.success, true, 'the authorized kill itself completes');
  assert.ok(virtualFs.hasWorkspace('realm:alpha:global'), 'the realm-global workspace survives the kill');
  assert.equal(readSentinel(virtualFs, 'realm:alpha:global'), 'realm global data');

  const publicReceipt = await dispatcher.executeTool('kill_agent', {
    agent_id: 'public-pinned',
    reason: 'reserved eviction guard'
  });
  assert.equal(publicReceipt.success, true, 'the authorized kill itself completes');
  assert.equal(
    virtualFs.readFile('/pub.txt', { workspaceId: 'public', raw: true }),
    'public data',
    'the public workspace survives the kill'
  );
});

test('spawn_agent denies resolved workspace-key shadowing for non-authority creators (26c3913)', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  // The operator pins the peer to the exact canonical key a default-workspace
  // child resolves (Wave I, d57cbc1), so the claim collision is real.
  await runtime.launchAgent({
    config: { id: 'claimed-peer', workspaceId: genericKey('claimed-key'), allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  await runtime.launchAgent({
    config: { id: 'claim-manager', role: 'manager' },
    callerContext: { callerAgentId: 'director' }
  });
  seedWorkspace(virtualFs, 'orphan-key', 'orphan bytes');
  seedWorkspace(virtualFs, 'claimed-key', 'peer bytes');

  const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'claim-manager' });

  // Id shadows a registered peer's resolved workspace key: refused.
  const claimed = await dispatcher.executeTool('spawn_agent', { id: 'claimed-key', role: 'manager' });
  assert.equal(claimed.success, false, 'a child id shadowing a peer workspace claim is refused');
  assert.equal(claimed.code, 'PERMISSION_DENIED', 'the refused shadow spawn reports the denial code');
  assert.equal(runtime.getAgent('claimed-key'), null, 'no partially-launched shadow child');
  assert.equal(runtime.getRecycledAgent('claimed-key'), null, 'no zombie shadow child');

  // Id shadows a pre-existing/orphan VFS workspace: refused.
  const orphan = await dispatcher.executeTool('spawn_agent', { id: 'orphan-key', role: 'manager' });
  assert.equal(orphan.success, false, 'a child id shadowing a pre-existing workspace is refused');
  assert.equal(orphan.code, 'PERMISSION_DENIED', 'the refused orphan shadow reports the denial code');
  assert.equal(runtime.getAgent('orphan-key'), null, 'no partially-launched orphan shadow child');

  // A legitimate fresh own-id launch is unchanged.
  const fresh = await dispatcher.executeTool('spawn_agent', { id: 'fresh-claim-child', role: 'manager' });
  assert.equal(fresh.success, true, 'a fresh own-id child launch stays allowed');
  assert.equal(runtime.getAgent('fresh-claim-child')?.config?.workspaceId, 'fresh-claim-child');

  assert.equal(readSentinel(virtualFs, 'orphan-key'), 'orphan bytes', 'the orphan workspace bytes survive');
  assert.equal(readSentinel(virtualFs, 'claimed-key'), 'peer bytes', 'the peer workspace claim is untouched');
});

test('kill_agent preserves a child workspace shared with its creator (26c3913)', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  await runtime.launchAgent({
    config: { id: 'share-manager', role: 'manager' },
    callerContext: { callerAgentId: 'director' }
  });

  // Sharing is spelled with the creator's resolved workspace key (its
  // canonical identity for a Realm-bound agent; Wave I, d57cbc1). The seed
  // addresses that key literally (this fixture VFS has no identity port, so the
  // caller claim must equal the storage key); a bare-id pin stays verbatim and
  // names its own partition, so the canonical key is the shared-workspace
  // composition.
  const sharedKey = genericKey('share-manager');
  virtualFs.writeFile('/sentinel.txt', 'creator shared bytes', { workspaceId: sharedKey, callerAgentId: sharedKey });

  const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'share-manager' });
  const spawn = await managerDispatcher.executeTool('spawn_agent', {
    id: 'share-child',
    role: 'manager',
    workspace: sharedKey
  });
  assert.equal(spawn.success, true, 'sharing the creator workspace remains an allowed composition');
  assert.equal(runtime.getAgent('share-child')?.config?.workspaceId, sharedKey);

  const childDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'share-child' });
  const kill = await childDispatcher.executeTool('kill_agent', {
    agent_id: 'share-child',
    reason: 'shared workspace teardown'
  });
  assert.equal(kill.success, true, 'the child self-kill itself completes');
  assert.ok(runtime.getRecycledAgent('share-child'), 'the child lands in the recycle bin');
  assert.ok(runtime.getAgent('share-manager'), 'the creator stays active');

  assert.ok(virtualFs.hasWorkspace(sharedKey), 'the shared workspace must survive the child kill');
  assert.equal(
    virtualFs.readFile('/sentinel.txt', { workspaceId: sharedKey, callerAgentId: sharedKey, raw: true }),
    'creator shared bytes',
    'the creator bytes survive'
  );
});

test('co-claimed workspaces are evicted only at the last claimant teardown (26c3913)', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  await runtime.launchAgent({
    config: { id: 'co-a', workspaceId: 'co-lane', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  await runtime.launchAgent({
    config: { id: 'co-b', workspaceId: 'co-lane', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  seedWorkspace(virtualFs, 'co-lane', 'co-claimed bytes');

  const dispatcher = createSandboxToolDispatcher({ runtime, agentId: 'director', allowedTools: ['*'] });

  // Kill the first claimant while the second is active: shared bytes survive.
  const killA = await dispatcher.executeTool('kill_agent', { agent_id: 'co-a', reason: 'co-claim kill A' });
  assert.equal(killA.success, true);
  assert.ok(virtualFs.hasWorkspace('co-lane'), 'the active co-claimant keeps the workspace alive');

  // Kill the second claimant while the first is recycled: still shared.
  const killB = await dispatcher.executeTool('kill_agent', { agent_id: 'co-b', reason: 'co-claim kill B' });
  assert.equal(killB.success, true);
  assert.ok(virtualFs.hasWorkspace('co-lane'), 'the recycled co-claimant keeps the workspace alive');
  assert.equal(readSentinel(virtualFs, 'co-lane'), 'co-claimed bytes');

  // Purge one recycled claimant while the other is recycled: still shared.
  assert.equal(runtime.purgeAgent('co-a', { callerAgentId: 'director' }), true);
  assert.ok(virtualFs.hasWorkspace('co-lane'), 'the remaining recycled claimant keeps the workspace alive');

  // Empty the recycle bin: the last claimant's purge evicts the key.
  assert.equal(runtime.emptyRecycleBin({ callerAgentId: 'director' }), 1);
  assert.equal(runtime.listRecycledAgents().length, 0);
  assert.equal(virtualFs.hasWorkspace('co-lane'), false, 'the last claimant teardown evicts the workspace');
});

test('spawn_agent denies reserved-shape own-id launches for non-authority creators (e6f10db)', async () => {
  const { runtime, virtualFs } = await createRealRuntime();

  await runtime.launchAgent({
    config: { id: 'manager-res-shape', role: 'manager' },
    callerContext: { callerAgentId: 'director' }
  });
  seedWorkspace(virtualFs, 'realm:alpha:global', 'realm global data');
  assert.equal(virtualFs.hasWorkspace('public'), false, 'precondition: the public key is absent from the fresh VFS');

  const managerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'manager-res-shape' });

  for (const reservedId of ['realm:alpha:global', 'public']) {
    const receipt = await managerDispatcher.executeTool('spawn_agent', { id: reservedId, role: 'manager' });
    assert.equal(receipt.success, false, `the own-id reserved-shape launch '${reservedId}' must be denied`);
    assert.equal(receipt.code, 'PERMISSION_DENIED', 'the refusal uses denial semantics');
    assert.equal(runtime.getAgent(reservedId), null, 'the denied launch leaves no partial child');
    assert.equal(runtime.getRecycledAgent(reservedId), null, 'the denied launch leaves no zombie child');
  }

  // The reserved partition bytes survive, and the absent public key was not
  // created by the denied attempts.
  assert.equal(readSentinel(virtualFs, 'realm:alpha:global'), 'realm global data', 'the reserved bytes survive');
  assert.equal(virtualFs.hasWorkspace('public'), false, 'the denied launch creates no public workspace');

  // Realm-vocabulary near-misses are hard launch refusals (Wave I, d57cbc1;
  // folded eab4e51): the `realm:` shape can never be minted as an id.
  const vocabulary = await managerDispatcher.executeTool('spawn_agent', { id: 'realm:alpha:globalx', role: 'manager' });
  assert.equal(vocabulary.success, false, 'the realm-vocabulary near-miss is refused');
  assert.equal(vocabulary.code, 'PERMISSION_DENIED', 'the refusal uses denial semantics');
  assert.equal(runtime.getAgent('realm:alpha:globalx'), null, 'the refused vocabulary child never registers');

  // A case near-miss shape is an ordinary private key and still launches.
  const nearMiss = await managerDispatcher.executeTool('spawn_agent', { id: 'Global', role: 'manager' });
  assert.equal(nearMiss.success, true, 'the case near-miss shape remains launchable');
  assert.equal(
    runtime.getAgent('Global')?.config?.workspaceId,
    'Global',
    'the near-miss child resolves its own id as the workspace'
  );

  // Authority (host/operator) pinning to a reserved key is unchanged.
  const hosted = await runtime.launchAgent({
    config: { id: 'host-reserved-pin', workspaceId: 'realm:gamma:global', allowedTools: ['read_file'] },
    callerContext: { callerAgentId: 'director' }
  });
  assert.equal(hosted.config.workspaceId, 'realm:gamma:global', 'authorized reserved pinning is unchanged');
});
