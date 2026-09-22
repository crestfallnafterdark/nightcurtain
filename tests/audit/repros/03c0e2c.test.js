/**
 * @file tests/audit/repros/03c0e2c.test.js
 * @description Audit repro for ticket 03c0e2c (Critical; MOD-21 W9-A), covering the
 * duplicate ticket 7651555 (same root cause on the `grep` leg):
 * `query_json`/`grep` prefer the caller payload identity (`callerAgentId`/
 * `caller_agent_id`) over the bound execution context. A bound unprivileged
 * agent can read a foreign private workspace by claiming the victim id, and can
 * combine the claim with `workspace_id: '*'` plus a privileged id (e.g.
 * `director`, resolved through the injected identity port) to scan every
 * workspace.
 *
 * Adapted to the agent workspace view (wave R): a bound caller's bare `/...`
 * paths resolve to its own private workspace, foreign private workspaces are
 * only addressable through `/agents/<id>/...` mounts (cross-workspace authority
 * required), and the payload workspace/identity claims are scrubbed before the
 * substrate sees them. The fixture seeds the same `/secret.json` address in the
 * victim's and the caller's workspaces with distinct bytes, so scope
 * confinement is observable in both directions.
 *
 * Contract under test: the dispatcher pins the identity subject to bound
 * construction (`toolDefinitions/index.ts`), so payload identity must never
 * select the identity or scope the VFS authorizes against: reads answer from
 * the caller's resolved view only, foreign mounts are denied by the mount ACL,
 * and no foreign bytes or filenames may appear in any receipt.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/03c0e2c.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

const VICTIM_TOKEN = 'victim-test-secret-token';
const OTHER_TOKEN = 'other-test-secret-token';
const MALLORY_TOKEN = 'mallory-own-test-secret-token';

/**
 * Boots a runtime with a director, an unprivileged `mallory`, a `victim`, and a
 * foreign `other` tenant; seeds private workspaces in an isolated VirtualFS.
 * The caller's own workspace carries the same `/secret.json` address as the
 * victim's with distinct bytes.
 * @returns {Promise<{runtime: import('../../../src/lib/sandbox/runtime/index.ts').AgentRuntime, identityPort: object, vfs: VirtualFS}>}
 */
async function createFixture() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  // Fixture grant under descriptor-authoritative authorization (76fb539): the
  // dispatcher-bound allowlist no longer widens an empty registry descriptor,
  // so the caller must be launched with the capabilities the control exercises.
  await runtime.launchAgent({ id: 'mallory', allowedTools: ['query_json', 'grep'] });
  await runtime.launchAgent({ id: 'victim' });

  const identityPort = runtime.createAgentIdentityPort();
  const vfs = new VirtualFS({ identityPort });
  vfs.writeFile({
    filePath: '/secret.json',
    content: JSON.stringify({ token: VICTIM_TOKEN }),
    workspaceId: 'victim',
    callerAgentId: 'victim'
  });
  vfs.writeFile({
    filePath: '/plain.txt',
    content: 'victim plain secret',
    workspaceId: 'victim',
    callerAgentId: 'victim'
  });
  vfs.writeFile({
    filePath: '/other.json',
    content: JSON.stringify({ token: OTHER_TOKEN }),
    workspaceId: 'other',
    callerAgentId: 'other'
  });
  // The caller's resolved view: same address, distinct bytes.
  vfs.writeFile({
    filePath: '/secret.json',
    content: JSON.stringify({ token: MALLORY_TOKEN }),
    workspaceId: 'mallory',
    callerAgentId: 'mallory'
  });
  vfs.writeFile({
    filePath: '/own.txt',
    content: 'mallory own marker',
    workspaceId: 'mallory',
    callerAgentId: 'mallory'
  });
  return { runtime, identityPort, vfs };
}

/**
 * Builds a dispatcher bound to `mallory` with readonly query/grep capabilities.
 * @param {VirtualFS} vfs
 * @param {object} identityPort
 * @returns {Function}
 */
function createMalloryDispatcher(vfs, identityPort) {
  return createSandboxToolDispatcher({
    virtualFs: vfs,
    agentId: 'mallory',
    allowedTools: ['query_json', 'grep'],
    identityPort
  });
}

/**
 * Asserts a receipt never carries foreign workspace bytes, workspace keys, or
 * filenames.
 * @param {object} receipt
 */
function assertNoForeignLeak(receipt) {
  const serialized = JSON.stringify(receipt);
  assert.ok(!serialized.includes(VICTIM_TOKEN), 'victim workspace bytes must never appear in a receipt');
  assert.ok(!serialized.includes(OTHER_TOKEN), 'foreign workspace bytes must never appear in a receipt');
  assert.ok(!serialized.includes('"workspaceId":"victim"'), 'the victim workspace key must never appear in a receipt');
  assert.ok(!serialized.includes('"workspaceId":"other"'), 'the foreign workspace key must never appear in a receipt');
  assert.ok(!serialized.includes('/plain.txt'), 'victim file names must never appear in a receipt');
  assert.ok(!serialized.includes('/other.json'), 'foreign file names must never appear in a receipt');
}

test('03c0e2c: query_json ignores payload caller_agent_id for a foreign workspace', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    const dispatcher = createMalloryDispatcher(vfs, identityPort);
    const res = await dispatcher.executeTool('query_json', {
      file_path: '/secret.json',
      workspace_id: 'victim',
      caller_agent_id: 'victim'
    });
    assert.equal(res.success, true, 'the payload claim is inert: the call resolves normally in the caller\'s view');
    assert.equal(
      res.token,
      MALLORY_TOKEN,
      'the payload identity/workspace claim must not select the victim\'s workspace or identity'
    );
    assertNoForeignLeak(res);
  } finally {
    runtime.destroy();
  }
});

test('03c0e2c: query_json ignores camelCase payload callerAgentId', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    const dispatcher = createMalloryDispatcher(vfs, identityPort);
    const res = await dispatcher.executeTool('query_json', {
      file_path: '/secret.json',
      workspace_id: 'victim',
      callerAgentId: 'victim'
    });
    assert.equal(res.success, true, 'the camelCase payload claim is inert too');
    assert.equal(
      res.token,
      MALLORY_TOKEN,
      'the camelCase payload identity/workspace claim must not select the victim\'s workspace or identity'
    );
    assertNoForeignLeak(res);
  } finally {
    runtime.destroy();
  }
});

test('03c0e2c: query_json cannot reach a foreign private workspace through its mount', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    const dispatcher = createMalloryDispatcher(vfs, identityPort);
    const res = await dispatcher.executeTool('query_json', {
      file_path: '/agents/victim/secret.json',
      caller_agent_id: 'victim'
    });
    assert.equal(res.success, false, 'an unprivileged caller must not reach a foreign private workspace');
    assert.equal(res.code, 'PERMISSION_DENIED', 'the mount ACL must be the denial layer');
    assert.match(res.error, /denied read access to mount '\/agents\/victim'/, 'the denial must come from the mount ACL');
    assert.doesNotMatch(
      res.error,
      /not authorized to invoke tool/,
      'the dispatcher gate must not be the denial layer for this fixture'
    );
    assertNoForeignLeak(res);
  } finally {
    runtime.destroy();
  }
});

test('7651555: grep ignores payload caller_agent_id for a foreign workspace', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    const dispatcher = createMalloryDispatcher(vfs, identityPort);

    const victimScope = await dispatcher.executeTool('grep', {
      pattern: VICTIM_TOKEN,
      workspace_id: 'victim',
      caller_agent_id: 'victim'
    });
    assert.equal(victimScope.success, true, 'grep itself is permitted in the caller\'s resolved view');
    assert.deepEqual(victimScope.result, [], 'the victim token must not be found in the caller\'s resolved view');
    assertNoForeignLeak(victimScope);

    const ownScope = await dispatcher.executeTool('grep', {
      pattern: MALLORY_TOKEN,
      workspace_id: 'victim',
      caller_agent_id: 'victim'
    });
    assert.equal(ownScope.success, true, 'the caller\'s own workspace is still searchable');
    const hits = Array.isArray(ownScope.result) ? ownScope.result : [];
    assert.ok(hits.length > 0, 'the caller\'s own bytes must still be found');
    assert.ok(
      hits.every(hit => hit.workspaceId === 'mallory'),
      'grep scope must stay inside the caller\'s resolved workspace'
    );
    assert.ok(
      hits.some(hit => hit.lineContent.includes(MALLORY_TOKEN)),
      'the caller\'s own match must be delivered'
    );
    assertNoForeignLeak(ownScope);

    const mountAttempt = await dispatcher.executeTool('grep', {
      pattern: VICTIM_TOKEN,
      path_prefix: '/agents/victim',
      caller_agent_id: 'victim'
    });
    assert.equal(mountAttempt.success, false, 'a foreign mount must not be grep-scannable');
    assert.equal(mountAttempt.code, 'PERMISSION_DENIED', 'the mount ACL must be the denial layer');
    assert.doesNotMatch(
      mountAttempt.error,
      /not authorized to invoke tool/,
      'the dispatcher gate must not be the denial layer for this fixture'
    );
    assertNoForeignLeak(mountAttempt);
  } finally {
    runtime.destroy();
  }
});

test('7651555: wildcard grep with payload director claim cannot scan foreign workspaces', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    const dispatcher = createMalloryDispatcher(vfs, identityPort);
    const res = await dispatcher.executeTool('grep', {
      pattern: 'secret-token',
      workspace_id: '*',
      caller_agent_id: 'director'
    });
    assert.equal(res.success, true, 'wildcard grep itself is a permitted operation');
    const hits = Array.isArray(res.result) ? res.result : [];
    assert.ok(hits.length > 0, 'the caller\'s own workspace is still scanned');
    assert.ok(
      hits.every(hit => hit.workspaceId === 'mallory'),
      'a payload director claim must not widen wildcard grep beyond the bound caller scope'
    );
    assertNoForeignLeak(res);
  } finally {
    runtime.destroy();
  }
});

test('03c0e2c control: bound mallory still reads its own workspace via the tool path', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    vfs.writeFile({
      filePath: '/own.json',
      content: JSON.stringify({ token: 'mallory-own-test-token' }),
      workspaceId: 'mallory',
      callerAgentId: 'mallory'
    });
    const dispatcher = createMalloryDispatcher(vfs, identityPort);
    const res = await dispatcher.executeTool('query_json', {
      file_path: '/own.json',
      workspace_id: 'mallory'
    });
    assert.equal(res.success, true, 'the bound caller must keep access to its own workspace');
    assert.ok(JSON.stringify(res).includes('mallory-own-test-token'), 'the bound caller must receive its own content');
    assertNoForeignLeak(res);
  } finally {
    runtime.destroy();
  }
});
