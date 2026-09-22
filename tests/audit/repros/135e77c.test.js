/**
 * @file tests/audit/repros/135e77c.test.js
 * @description Audit repro for ticket 135e77c (Major; MOD-21 W9-A):
 * `replace_file_content` and `json_patch` ran their workspace ACL check against
 * the resolved trusted caller but their read-only owner check against the raw
 * caller-payload `callerAgentId`, so a non-owner could overwrite/patch another
 * owner's read-only global file by adding `caller_agent_id: '<owner>'` to the
 * tool arguments.
 *
 * Adapted to the agent workspace view (wave R): the shared workspace is
 * addressed through its `/global/...` mount and the fixture seeds the read-only
 * files into the caller's shared workspace through a trusted owner call (the
 * engine's realm binding aliases `global`/`/global` onto
 * `realm:<realmId>:global`). Mallory's calls therefore reach the read-only VFS
 * ACL on the shared file instead of missing it in his own private workspace.
 *
 * Contract under test: the read-only owner check must use the same resolved
 * trusted caller as `writeFile`/`copyFile`/`deleteFile`/`setPermissions`; a
 * payload owner/workspace claim is inert, the denial must come from the shared
 * read-only VFS ACL (never the dispatcher gate and never a file-not-found
 * miss), and the shared file must stay byte-identical.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/135e77c.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

const ORIGINAL_TEXT = 'original-content';
const ORIGINAL_VALUE = 'original';

/**
 * Boots a runtime with a director, unprivileged `mallory`, and `victim`;
 * seeds read-only shared files owned by `victim` through the `/global` mount.
 * @returns {Promise<{runtime: import('../../../src/lib/sandbox/runtime/index.ts').AgentRuntime, identityPort: object, vfs: VirtualFS}>}
 */
async function createFixture() {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  // Fixture grants under descriptor-authoritative authorization (76fb539): the
  // dispatcher-bound allowlist no longer widens an empty registry descriptor,
  // so both callers must be launched with the capabilities their dispatcher
  // exercises. Mallory's grant routes the two security tests past the
  // dispatcher gate so they reach — and are denied by — the VFS read-only ACL
  // layer they were written to guard; he stays unprivileged either way.
  await runtime.launchAgent({ id: 'mallory', allowedTools: ['replace_file_content', 'json_patch'] });
  await runtime.launchAgent({ id: 'victim', allowedTools: ['replace_file_content', 'json_patch'] });

  const identityPort = runtime.createAgentIdentityPort();
  const vfs = new VirtualFS({ identityPort });
  // Trusted owner writes through the shared mount: a realm-bound caller
  // resolves `/global` onto its shared workspace (`realm:<realmId>:global`).
  vfs.writeFile('/global/ro.txt', ORIGINAL_TEXT, { callerAgentId: 'victim', readOnly: true });
  vfs.writeFile('/global/ro.json', JSON.stringify({ value: ORIGINAL_VALUE }, null, 2), {
    callerAgentId: 'victim',
    readOnly: true
  });
  return { runtime, identityPort, vfs };
}

/**
 * Builds a dispatcher bound to `mallory` with the two mutation capabilities.
 * @param {VirtualFS} vfs
 * @param {object} identityPort
 * @returns {Function}
 */
function createMalloryDispatcher(vfs, identityPort) {
  return createSandboxToolDispatcher({
    virtualFs: vfs,
    agentId: 'mallory',
    allowedTools: ['replace_file_content', 'json_patch'],
    identityPort
  });
}

/**
 * Reads the shared read-only text file through its owner's view.
 * @param {VirtualFS} vfs
 * @returns {string}
 */
function readSharedText(vfs) {
  return vfs.readFile('/global/ro.txt', { callerAgentId: 'victim' }).content;
}

/**
 * Queries the shared read-only JSON file through its owner's view.
 * @param {VirtualFS} vfs
 * @returns {unknown}
 */
function readSharedValue(vfs) {
  return vfs.queryJson('/global/ro.json', '.value', { callerAgentId: 'victim' });
}

test('135e77c: replace_file_content payload identity cannot bypass the read-only owner', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    const dispatcher = createMalloryDispatcher(vfs, identityPort);
    const res = await dispatcher.executeTool('replace_file_content', {
      file_path: '/global/ro.txt',
      target_content: ORIGINAL_TEXT,
      replacement_content: 'pwned-by-mallory',
      workspace_id: 'victim',
      caller_agent_id: 'victim'
    });
    assert.equal(res.success, false, 'a payload owner claim must not authorize the replacement');
    // Denial-layer discrimination (76fb539 follow-up): with the fixture grant in
    // place the dispatcher gate passes, so the denial must carry the shared
    // read-only ACL message — never the gate's "not authorized to invoke tool"
    // and never a file-not-found miss.
    assert.equal(res.code, 'PERMISSION_DENIED', 'the VFS ACL denial must surface as PERMISSION_DENIED');
    assert.match(res.error, /read-only file/, 'the denial must come from the VFS read-only ACL');
    assert.match(res.error, /global workspace/, 'the denial must be the shared-workspace read-only ACL');
    assert.doesNotMatch(
      res.error,
      /not authorized to invoke tool/,
      'the dispatcher gate must not be the denial layer for this fixture'
    );
    assert.doesNotMatch(res.error, /not found/i, 'the call must reach the read-only ACL, not miss the file');
    assert.equal(readSharedText(vfs), ORIGINAL_TEXT, 'the read-only file must stay byte-identical');
  } finally {
    runtime.destroy();
  }
});

test('135e77c: json_patch payload identity cannot bypass the read-only owner', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    const dispatcher = createMalloryDispatcher(vfs, identityPort);
    const res = await dispatcher.executeTool('json_patch', {
      file_path: '/global/ro.json',
      patch: [{ op: 'replace', path: '/value', value: 'pwned' }],
      workspace_id: 'victim',
      caller_agent_id: 'victim'
    });
    assert.equal(res.success, false, 'a payload owner claim must not authorize the patch');
    // Denial-layer discrimination (76fb539 follow-up), as in the replacement
    // test above: the shared read-only VFS ACL must be the denying layer.
    assert.equal(res.code, 'PERMISSION_DENIED', 'the VFS ACL denial must surface as PERMISSION_DENIED');
    assert.match(res.error, /read-only file/, 'the denial must come from the VFS read-only ACL');
    assert.match(res.error, /global workspace/, 'the denial must be the shared-workspace read-only ACL');
    assert.doesNotMatch(
      res.error,
      /not authorized to invoke tool/,
      'the dispatcher gate must not be the denial layer for this fixture'
    );
    assert.doesNotMatch(res.error, /not found/i, 'the call must reach the read-only ACL, not miss the file');
    assert.equal(readSharedValue(vfs), ORIGINAL_VALUE, 'the read-only JSON file must stay byte-identical');
  } finally {
    runtime.destroy();
  }
});

test('135e77c control: the real owner still replaces its own read-only global file', async () => {
  const { runtime, identityPort, vfs } = await createFixture();
  try {
    const ownerDispatcher = createSandboxToolDispatcher({
      virtualFs: vfs,
      agentId: 'victim',
      allowedTools: ['replace_file_content', 'json_patch'],
      identityPort
    });
    const replaceRes = await ownerDispatcher.executeTool('replace_file_content', {
      file_path: '/global/ro.txt',
      target_content: ORIGINAL_TEXT,
      replacement_content: 'owner-edit'
    });
    assert.equal(replaceRes.success, true, 'the resolved owner must keep write access');
    assert.equal(replaceRes.workspaceId, 'global', 'the owner edit must land in the shared workspace');
    assert.equal(readSharedText(vfs), 'owner-edit');

    const patchRes = await ownerDispatcher.executeTool('json_patch', {
      file_path: '/global/ro.json',
      patch: [{ op: 'replace', path: '/value', value: 'owner-edit' }]
    });
    assert.equal(patchRes.success, true, 'the resolved owner must keep patch access');
    assert.equal(patchRes.workspaceId, 'global', 'the owner patch must land in the shared workspace');
    assert.equal(readSharedValue(vfs), 'owner-edit');
  } finally {
    runtime.destroy();
  }
});
