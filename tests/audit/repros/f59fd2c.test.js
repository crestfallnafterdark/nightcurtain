/**
 * @file tests/audit/repros/f59fd2c.test.js
 * @description Audit repro for ticket f59fd2c (Major; MOD-21 W9-A):
 * every VFS method's object-form branch re-injected caller-payload identity
 * whenever the trusted context value was falsy
 * (`if (callerAgentId && !options.callerAgentId) options.callerAgentId = callerAgentId;`).
 * An anonymous dispatcher (documented to have no identity subject,
 * `toolDefinitions/index.ts`) therefore let tool arguments fabricate the
 * identity used for workspace ACLs: `caller_agent_id: 'victim'` +
 * `workspace_id: 'victim'` read (and mutated) any private workspace.
 *
 * Adapted to the agent workspace view (wave R): an anonymous dispatcher binds
 * no trusted caller, so it keeps the legacy semantics — bare `/...` paths
 * resolve to the legacy shared workspace (`global`) and a private workspace is
 * never reachable. The fixture seeds the *same* addresses in the victim's
 * private workspace and in the legacy shared workspace with distinct bytes, so
 * every anonymous call must answer from the shared channel only.
 *
 * Contract under test: an anonymous dispatcher stays anonymous; a payload
 * identity/workspace claim is never promoted, so no anonymous call may read,
 * list, mutate, or delete victim bytes. Regardless of the call outcome, the
 * victim private workspace stays byte-identical, no victim content or identity
 * may appear in any receipt, and a successful call may only be the legacy
 * shared channel — asserted explicitly by the shared decoy bytes it returns.
 * Context-less direct-API object calls keep the legacy payload identity
 * channel.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/f59fd2c.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

const VICTIM_SECRET = 'victim plain secret';
const VICTIM_MISSION = 'victim-secret-mission';
const SHARED_DECOY = 'shared decoy plain content';
const SHARED_MISSION = 'shared-decoy-mission';
const INTRUDER_CONTENT = 'intruder';

/** Payload identity/workspace claims an anonymous caller must never profit from. */
const VICTIM_CLAIMS = Object.freeze({ workspace_id: 'victim', caller_agent_id: 'victim' });

/**
 * Boots a runtime with a director and a `victim`, seeding the victim's private
 * workspace and the legacy shared workspace with the same addresses but
 * distinct bytes. The shared decoys are seeded without a caller identity, so
 * they never carry the victim's name.
 * @returns {Promise<{runtime: import('../../../src/lib/sandbox/runtime/index.ts').AgentRuntime, vfs: VirtualFS}>}
 */
async function createFixture() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  await runtime.launchAgent({ id: 'victim' });

  const vfs = new VirtualFS({ identityPort: runtime.createAgentIdentityPort() });
  // Victim private workspace (legacy context-less payload identity channel).
  vfs.writeFile({
    filePath: '/plain.txt',
    content: VICTIM_SECRET,
    workspaceId: 'victim',
    callerAgentId: 'victim'
  });
  vfs.writeFile({
    filePath: '/plans.json',
    content: JSON.stringify({ mission: VICTIM_MISSION }),
    workspaceId: 'victim',
    callerAgentId: 'victim'
  });
  // Legacy shared workspace decoys at the same addresses, owned by 'system'.
  vfs.writeFile({ filePath: '/plain.txt', content: SHARED_DECOY, workspaceId: 'global' });
  vfs.writeFile({
    filePath: '/plans.json',
    content: JSON.stringify({ mission: SHARED_MISSION }),
    workspaceId: 'global'
  });
  return { runtime, vfs };
}

/**
 * Builds an anonymous dispatcher with the full VFS surface under test.
 * @param {VirtualFS} vfs
 * @returns {Function}
 */
function createAnonymousDispatcher(vfs) {
  return createSandboxToolDispatcher({
    virtualFs: vfs,
    allowedTools: ['read_file', 'write_file', 'list_files', 'delete_file', 'grep', 'query_json']
  });
}

/**
 * Asserts an anonymous receipt never carries victim bytes or the victim
 * identity/workspace claim.
 * @param {object} receipt
 */
function assertNoVictimLeak(receipt) {
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes(VICTIM_SECRET), 'victim file content must never appear in an anonymous receipt');
  assert.ok(!serialized.includes(VICTIM_MISSION), 'victim JSON content must never appear in an anonymous receipt');
  assert.ok(!serialized.includes('victim'), 'the victim identity/workspace claim must never appear in an anonymous receipt');
}

/**
 * Asserts the victim private workspace is byte-identical and free of anonymous
 * artifacts.
 * @param {VirtualFS} vfs
 */
function assertVictimWorkspaceIntact(vfs) {
  assert.equal(
    vfs.readFile('/plain.txt', { workspaceId: 'victim', callerAgentId: 'victim' }).content,
    VICTIM_SECRET,
    'the victim file must stay byte-identical'
  );
  assert.equal(
    JSON.parse(vfs.readFile('/plans.json', { workspaceId: 'victim', callerAgentId: 'victim' }).content).mission,
    VICTIM_MISSION,
    'the victim JSON must stay byte-identical'
  );
  let intrusion = null;
  try {
    intrusion = vfs.readFile('/intrusion.txt', { workspaceId: 'victim', callerAgentId: 'victim' });
  } catch {
    intrusion = null;
  }
  assert.equal(intrusion, null, 'no anonymous artifact may land in the victim private workspace');
}

test('f59fd2c: anonymous read answers only from the legacy shared channel', async () => {
  const { runtime, vfs } = await createFixture();
  try {
    const anon = createAnonymousDispatcher(vfs);
    const res = await anon.executeTool('read_file', { file_path: '/plain.txt', ...VICTIM_CLAIMS });
    assertNoVictimLeak(res);
    assertVictimWorkspaceIntact(vfs);
    assert.equal(res.success, true, 'the legacy shared channel holds the same address and answers');
    assert.equal(res.content, SHARED_DECOY, 'the anonymous read must return the shared decoy bytes, never the victim secret');
  } finally {
    runtime.destroy();
  }
});

test('f59fd2c: anonymous write lands only in the legacy shared channel', async () => {
  const { runtime, vfs } = await createFixture();
  try {
    const anon = createAnonymousDispatcher(vfs);
    const res = await anon.executeTool('write_file', {
      file_path: '/intrusion.txt',
      content: INTRUDER_CONTENT,
      ...VICTIM_CLAIMS
    });
    assertNoVictimLeak(res);
    assertVictimWorkspaceIntact(vfs);
    assert.equal(res.success, true, 'the anonymous write is permitted on the legacy shared channel');
    assert.equal(res.workspaceId, 'global', 'a successful anonymous write may only target the legacy shared channel');
    assert.equal(
      vfs.readFile('/intrusion.txt', { workspaceId: 'global' }).content,
      INTRUDER_CONTENT,
      'the anonymous artifact must land in the legacy shared workspace'
    );
  } finally {
    runtime.destroy();
  }
});

test('f59fd2c: anonymous list and delete touch only the legacy shared channel', async () => {
  const { runtime, vfs } = await createFixture();
  try {
    const anon = createAnonymousDispatcher(vfs);

    const listRes = await anon.executeTool('list_files', { ...VICTIM_CLAIMS });
    assertNoVictimLeak(listRes);
    assert.equal(listRes.success, true, 'the legacy shared channel is listable');
    const entries = Array.isArray(listRes.result) ? listRes.result : [];
    assert.ok(entries.length > 0, 'the shared decoys are listable through the legacy channel');
    assert.ok(
      entries.every(entry => entry.workspaceId === 'global'),
      'every listed entry must belong to the legacy shared workspace'
    );

    const deleteRes = await anon.executeTool('delete_file', { file_path: '/plain.txt', ...VICTIM_CLAIMS });
    assertNoVictimLeak(deleteRes);
    assert.equal(deleteRes.success, true, 'the anonymous delete is permitted on the legacy shared channel');
    assert.equal(deleteRes.result, true, 'the anonymous delete may only remove the shared decoy');
    let sharedAfter = null;
    try {
      sharedAfter = vfs.readFile('/plain.txt', { workspaceId: 'global' });
    } catch {
      sharedAfter = null;
    }
    assert.equal(sharedAfter, null, 'the shared decoy is gone — the delete acted on the shared channel only');
    assertVictimWorkspaceIntact(vfs);
  } finally {
    runtime.destroy();
  }
});

test('f59fd2c: anonymous query and grep answer only from the legacy shared channel', async () => {
  const { runtime, vfs } = await createFixture();
  try {
    const anon = createAnonymousDispatcher(vfs);

    const queryRes = await anon.executeTool('query_json', { file_path: '/plans.json', ...VICTIM_CLAIMS });
    assertNoVictimLeak(queryRes);
    assert.equal(queryRes.success, true, 'the legacy shared channel holds the same address and answers');
    assert.equal(queryRes.mission, SHARED_MISSION, 'the anonymous query must return the shared decoy document');

    const grepRes = await anon.executeTool('grep', { pattern: 'plain', ...VICTIM_CLAIMS });
    assertNoVictimLeak(grepRes);
    assert.equal(grepRes.success, true, 'the anonymous grep is permitted on the legacy shared channel');
    const hits = Array.isArray(grepRes.result) ? grepRes.result : [];
    assert.ok(hits.length > 0, 'the shared decoy matches the pattern');
    assert.ok(
      hits.every(hit => hit.workspaceId === 'global'),
      'grep hits must come from the legacy shared workspace only'
    );
    assert.ok(
      hits.every(hit => hit.lineContent === SHARED_DECOY),
      'grep must never surface victim line content'
    );
    assertVictimWorkspaceIntact(vfs);
  } finally {
    runtime.destroy();
  }
});

test('f59fd2c control: context-less direct-API object call still honors payload identity', async () => {
  const { runtime, vfs } = await createFixture();
  try {
    const content = vfs.readFile({ filePath: '/plain.txt', workspaceId: 'victim', callerAgentId: 'victim' }).content;
    assert.equal(content, VICTIM_SECRET, 'direct object-first calls keep the legacy payload identity channel');
  } finally {
    runtime.destroy();
  }
});
