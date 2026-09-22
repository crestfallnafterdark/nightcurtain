/**
 * @file tests/audit/repros/0a87141.test.js
 * @description Audit repro for ticket 0a87141 (Major; MOD-21 W10-A): snapshot
 * hydration treats capability selectors and privilege claims as untrusted but
 * copies `config.spawnedBy`/`config.creatorId` into the live config. Lifecycle
 * authorization resolves parent authority from that config, so a tampered
 * snapshot (direct `importSnapshot` or `restoreRuntimeEnvironment`) silently
 * re-grants `killAgent`, `invokeAgent`, and non-sudoer `restoreAgent` authority
 * over the hydrated agent to any registered subject named in the snapshot.
 *
 * Expected (ratified W10): snapshot parentage is untrusted across every
 * hydration boundary — a hydrated agent carries no parent authority until a
 * trusted operator repair.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/0a87141.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import {
  restoreRuntimeEnvironment,
  serializeRuntimeEnvironment
} from '../../../src/lib/sandbox/sandboxPersistence/index.ts';

/**
 * Forges snapshot parentage on the victim entry copy.
 *
 * @param {Object} snapshot - Runtime export/persisted snapshot
 * @param {string} parentId
 * @returns {Object} A new snapshot with forged victim parentage
 */
function forgeParentage(snapshot, parentId) {
  const forged = JSON.parse(JSON.stringify(snapshot));
  const victim = forged.agents.find((entry) => entry.id === 'victim');
  assert.ok(victim, 'the victim entry must exist in the snapshot');
  victim.config.spawnedBy = parentId;
  victim.config.creatorId = parentId;
  return forged;
}

/**
 * Runs `fn` against a source runtime hosting `mallory` + `victim` and destroys it.
 * @param {(source: AgentRuntime) => Promise<void>} fn
 */
async function withSourceRuntime(fn) {
  const source = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    await source.launchAgent({ id: 'mallory' });
    await source.launchAgent({ id: 'victim' });
    await fn(source);
  } finally {
    source.destroy();
  }
}

test('0a87141: importSnapshot must not adopt caller-supplied parentage', async () => {
  await withSourceRuntime(async (source) => {
    const snapshot = forgeParentage(source.exportSnapshot(), 'mallory');
    const runtime = new AgentRuntime({ autoBootstrapDirector: false });
    try {
      runtime.importSnapshot(snapshot);

      const victim = runtime.getAgent('victim');
      assert.ok(victim, 'the victim must hydrate');
      assert.notStrictEqual(victim.config.spawnedBy, 'mallory', 'snapshot parentage must not be adopted');
      assert.notStrictEqual(victim.config.creatorId, 'mallory', 'snapshot parentage must not be adopted');

      assert.throws(
        () => runtime.killAgent('victim', 'forged snapshot parentage', { callerAgentId: 'mallory' }),
        (err) => err?.code === 'PERMISSION_DENIED',
        'a snapshot-forged parent cannot kill the hydrated victim'
      );
      assert.ok(runtime.getAgent('victim'), 'the denied kill leaves the victim active');

      const invocation = runtime.invokeAgent('mallory', 'victim', 'P');
      assert.strictEqual(invocation.success, false, 'a snapshot-forged parent cannot invoke the hydrated victim');
      assert.strictEqual(invocation.code, 'PERMISSION_DENIED');
    } finally {
      runtime.destroy();
    }
  });
});

test('0a87141: restoreRuntimeEnvironment must not adopt caller-supplied parentage', async () => {
  await withSourceRuntime(async (source) => {
    const persisted = serializeRuntimeEnvironment({ runtime: source });
    const forged = forgeParentage(persisted, 'mallory');
    // Restore does not need the WorldClock body for this authority assertion.
    forged.worldClock = null;

    const runtime = new AgentRuntime({ autoBootstrapDirector: false });
    try {
      const restore = restoreRuntimeEnvironment(forged, runtime);
      assert.strictEqual(restore.success, true, `restore must succeed: ${restore.error || ''}`);

      assert.notStrictEqual(runtime.getAgent('victim').config.spawnedBy, 'mallory', 'persisted parentage must not be adopted');
      assert.throws(
        () => runtime.killAgent('victim', 'forged persisted parentage', { callerAgentId: 'mallory' }),
        (err) => err?.code === 'PERMISSION_DENIED',
        'a persisted-forged parent cannot kill the hydrated victim'
      );
      assert.strictEqual(runtime.invokeAgent('mallory', 'victim', 'P').code, 'PERMISSION_DENIED');
    } finally {
      runtime.destroy();
    }
  });
});

test('0a87141: a recycled snapshot record cannot re-grant restore authority', async () => {
  await withSourceRuntime(async (source) => {
    const snapshot = JSON.parse(JSON.stringify(source.exportSnapshot()));
    const victim = snapshot.agents.find((entry) => entry.id === 'victim');
    victim.state = 'recycled';
    victim.recycledAt = new Date().toISOString();
    victim.recycleReason = 'forged recycle';
    victim.config.spawnedBy = 'mallory';
    victim.config.creatorId = 'mallory';

    const runtime = new AgentRuntime({ autoBootstrapDirector: false });
    try {
      runtime.importSnapshot({
        agents: snapshot.agents.filter((entry) => entry.id !== 'victim'),
        recycleBin: [victim]
      });
      assert.ok(runtime.hasRecycledAgent('victim'), 'the victim must hydrate into the recycle bin');

      assert.throws(
        () => runtime.restoreAgent('victim', { callerAgentId: 'mallory' }),
        (err) => err?.code === 'PERMISSION_DENIED',
        'a snapshot-forged parent cannot restore the recycled victim'
      );
      assert.ok(!runtime.hasAgent('victim'), 'the denied restore leaves the victim recycled');
    } finally {
      runtime.destroy();
    }
  });
});
