/**
 * @file tests/audit/repros/e6f10db.test.js
 * @description Audit repro for ticket e6f10db (Major; prog:realm; verifier
 * finding V8-F1): reserved key SHAPES need not exist, so the existence-based
 * shadow check (`hasWorkspace`) does not stop a non-authority own-id launch
 * from claiming them.
 *
 * Attack chain (pre-fix):
 * 1. A manager-preset agent (resolved non-authority principal) spawns a child
 *    with `{id: 'realm:alpha:global'}` on a fresh VFS. Launch composition
 *    resolves the child workspace as
 *    `config.workspaceId || config.workspace || agentId` — its own id — and
 *    the claim check cannot match (no registered record resolves to the key),
 *    while the own-id shadow check refuses only a pre-existing workspace
 *    (`hasWorkspace` is false on a fresh VFS).
 * 2. The child therefore claims workspace `realm:alpha:global` (`public`, and
 *    the exact `global` shape behave identically) before Wave A allocates it,
 *    and can read/overwrite that partition's files through tool calls.
 *    Deletion stays blocked by the reserved deletion guard, so the gap is
 *    partition-ownership claim, not byte destruction.
 *
 * Ratified remediation (this repro is the red-before evidence):
 * 1. Reserved shapes are always-shadowed for resolved non-authority principals
 *    at launch: the canonical VirtualFS reserved-key predicate (`global`,
 *    `public`, `realm:<realmId>:global`) is consulted on the resolved key
 *    regardless of `hasWorkspace`, and the launch fails closed with
 *    `PERMISSION_DENIED` before registration or recycle-bin capture (no
 *    partial child).
 * 2. Near-miss keys (`realm:alpha:globalx`, `realm:a:glob`, `Global`,
 *    `PUBLIC`) stay ordinary private workspaces and remain launchable. Wave I
 *    (`d57cbc1`, folded `eab4e51`) tightens the `realm:`-prefixed spellings:
 *    ids carrying internal realm vocabulary are hard launch refusals now, so
 *    only the case near-misses (`Global`, `PUBLIC`) remain launchable
 *    ordinary keys — the reserved-shape near-miss rule is unchanged for the
 *    shapes the vocabulary gate does not own.
 * 3. Authority/internal/principal-less pinning to reserved keys is unchanged
 *    (host/operator pins reserved partitions intentionally).
 *
 * Zero-mock: real `AgentRuntime`, real `VirtualFS`, real `MessagingBus`, real
 * descriptor pipeline, and the real dispatcher.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/e6f10db.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

/** Reserved key shapes an own-id launch must never claim (e6f10db). */
const RESERVED_OWN_IDS = ['realm:alpha:global', 'public', 'global'];

/** Keys one shape-step away from reserved that stay launchable. */
const NEAR_MISS_OWN_IDS = ['Global', 'PUBLIC'];

/**
 * Realm-vocabulary spellings of the near-miss shape: launchable before Wave I,
 * now refused by the vocabulary gate (`realm:` prefix; ticket d57cbc1, folded
 * eab4e51) with the same uniform denial semantics.
 */
const VOCABULARY_NEAR_MISS_OWN_IDS = ['realm:alpha:globalx', 'realm:a:glob'];

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

test('e6f10db (a): non-authority own-id launches cannot claim reserved key shapes on a fresh VFS', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    // `realm:alpha:global` and `public` are absent from the fresh VFS — the
    // existence-based shadow check therefore has nothing to match, which is
    // the window this repro exercises. The runtime bootstraps the shared
    // `global` workspace at construction, so that shape is covered below
    // regardless of existence (and by the own-id shadow check even pre-fix).
    assert.equal(virtualFs.hasWorkspace('realm:alpha:global'), false, 'precondition: realm-global key is absent');
    assert.equal(virtualFs.hasWorkspace('public'), false, 'precondition: public key is absent');

    await launchManager(runtime, 'res-attacker');
    const attackerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'res-attacker' });

    for (const reservedId of RESERVED_OWN_IDS) {
      const receipt = await attackerDispatcher.executeTool('spawn_agent', {
        id: reservedId,
        role: 'manager'
      });
      assert.equal(
        receipt.success,
        false,
        `a non-authority own-id launch must not claim reserved key shape '${reservedId}'`
      );
      assert.equal(receipt.code, 'PERMISSION_DENIED', 'the refused reserved-shape spawn uses denial semantics');
      assert.equal(runtime.getAgent(reservedId), null, 'no partially-launched child stays registered');
      assert.equal(runtime.getRecycledAgent(reservedId), null, 'no zombie child lands in the recycle bin');
      if (reservedId !== 'global') {
        assert.equal(
          virtualFs.hasWorkspace(reservedId),
          false,
          'the denied launch must not create the reserved workspace'
        );
      }
    }

    // Reserved partition state written by a genuine realm path stays untouched
    // and the attacker still cannot reach it through a claimed child.
    virtualFs.writeFile('/realm.txt', 'realm partition state', {
      workspaceId: 'realm:alpha:global',
      callerAgentId: 'realm:alpha:global'
    });
    assert.equal(
      virtualFs.readFile('/realm.txt', { workspaceId: 'realm:alpha:global', callerAgentId: 'realm:alpha:global', raw: true }),
      'realm partition state',
      'the reserved partition bytes survive the denied attempts'
    );
  } finally {
    runtime.destroy();
  }
});

test('e6f10db (b): near-miss keys stay launchable (subject to the existing rules)', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    await launchManager(runtime, 'res-near-miss');
    const attackerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'res-near-miss' });

    // Wave I (d57cbc1; folded eab4e51): `realm:`-prefixed spellings are refused
    // by the vocabulary gate — same uniform denial, no partial child.
    for (const vocabularyId of VOCABULARY_NEAR_MISS_OWN_IDS) {
      const receipt = await attackerDispatcher.executeTool('spawn_agent', {
        id: vocabularyId,
        role: 'manager'
      });
      assert.equal(
        receipt.success,
        false,
        `realm-vocabulary id '${vocabularyId}' is refused: ${JSON.stringify(receipt)}`
      );
      assert.equal(receipt.code, 'PERMISSION_DENIED', 'the vocabulary refusal uses denial semantics');
      assert.equal(runtime.getAgent(vocabularyId), null, 'no partially-launched vocabulary child stays registered');
      assert.equal(runtime.getRecycledAgent(vocabularyId), null, 'no zombie vocabulary child lands in the recycle bin');
    }

    for (const nearMissId of NEAR_MISS_OWN_IDS) {
      const receipt = await attackerDispatcher.executeTool('spawn_agent', {
        id: nearMissId,
        role: 'manager'
      });
      assert.equal(
        receipt.success,
        true,
        `near-miss key '${nearMissId}' is an ordinary private workspace: ${JSON.stringify(receipt)}`
      );
      assert.equal(
        runtime.getAgent(nearMissId)?.config?.workspaceId,
        nearMissId,
        `the near-miss child '${nearMissId}' adopts its own id as the resolved workspace`
      );
      assert.equal(virtualFs.hasWorkspace(nearMissId), false, 'a fresh near-miss launch creates no pre-existing bytes');
    }
  } finally {
    runtime.destroy();
  }
});

test('e6f10db (c): authority pins to reserved key shapes are unchanged', async () => {
  const { runtime } = await createRealRuntime();
  try {
    const reservedPins = ['realm:gamma:global', 'public', 'global'];
    for (const [index, reservedKey] of reservedPins.entries()) {
      const hosted = await runtime.launchAgent({
        config: { id: `host-reserved-${index}`, workspaceId: reservedKey, allowedTools: ['read_file'] },
        callerContext: { callerAgentId: 'director' }
      });
      assert.equal(
        hosted.config.workspaceId,
        reservedKey,
        `authorized (director) pinning to reserved key '${reservedKey}' is unchanged`
      );
    }

    // Principal-less direct engine/host launch keeps the legacy pinning
    // behavior; it is not agent- or tool-reachable.
    const enginePinned = await runtime.launchAgent({
      config: { id: 'engine-reserved-pin', workspaceId: 'realm:beta:global', allowedTools: ['read_file'] }
    });
    assert.equal(
      enginePinned.config.workspaceId,
      'realm:beta:global',
      'principal-less engine pinning to a reserved key is unchanged'
    );
  } finally {
    runtime.destroy();
  }
});

test('e6f10db (d): an existing reserved workspace is equally unclaimable by own-id launch', async () => {
  const { runtime, virtualFs } = await createRealRuntime();
  try {
    virtualFs.writeFile('/realm.txt', 'allocated realm state', {
      workspaceId: 'realm:alpha:global',
      callerAgentId: 'realm:alpha:global'
    });
    assert.equal(virtualFs.hasWorkspace('realm:alpha:global'), true, 'precondition: reserved workspace exists');

    await launchManager(runtime, 'res-existing-attacker');
    const attackerDispatcher = createSandboxToolDispatcher({ runtime, agentId: 'res-existing-attacker' });
    const receipt = await attackerDispatcher.executeTool('spawn_agent', {
      id: 'realm:alpha:global',
      role: 'manager'
    });

    assert.equal(receipt.success, false, 'an existing reserved workspace is unclaimable by own-id launch');
    assert.equal(receipt.code, 'PERMISSION_DENIED', 'the refusal uses denial semantics');
    assert.equal(runtime.getAgent('realm:alpha:global'), null, 'no partial child exists');
    assert.equal(
      virtualFs.readFile('/realm.txt', { workspaceId: 'realm:alpha:global', callerAgentId: 'realm:alpha:global', raw: true }),
      'allocated realm state',
      'the allocated realm-global bytes survive'
    );
  } finally {
    runtime.destroy();
  }
});
