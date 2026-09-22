/**
 * @file tests/audit/repros/cb9909f.test.js
 * @description Audit repro for ticket cb9909f (Minor; prog:realm): the VFS ACL
 * (`VirtualFS#checkWorkspaceAccess`) trusts a `/global/` or `/public/` path
 * prefix and downgrades the operation to public even when a foreign private
 * workspace was requested. `grep` classifies through the requested workspace but
 * scans it when the caller supplies a `/global/`-prefixed path filter, so an
 * attacker reads files out of another agent's private workspace.
 *
 * Ratified fix: the ACL class is resolved from the (effective) workspace only; a
 * path prefix never downgrades it. Red before the fix; green after.
 *
 * The `/global/`-prefixed private-workspace entry is seeded through tenant
 * administration (`importSnapshot`) because the VFS itself resolves and stores
 * such legacy/global-mounted keys (see `readFile`'s `'/global' + lookupPath`
 * lookup), and Realm-scoped globals will make the prefix form first-class.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/cb9909f.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualFS, PermissionDeniedError } from '../../../src/lib/sandbox/virtualFs/index.ts';

/** Opaque engine-internal principal used only to seed the victim workspace. */
const INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'cb9909f_test_admin' });

function isPermissionDenied(err) {
  return err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED';
}

/**
 * Seeds a private victim workspace holding a `/global/`-prefixed entry, the
 * shape the ACL must never confuse with the shared public workspace.
 */
function makeVfsWithVictimWorkspace() {
  const vfs = new VirtualFS({ internalPrincipal: INTERNAL_PRINCIPAL });
  vfs.importSnapshot({
    victim_ws: {
      '/global/secret.txt': { content: 'TOP SECRET VICTIM DATA' }
    }
  }, { principal: INTERNAL_PRINCIPAL });
  return vfs;
}

test('cb9909f: a foreign caller cannot grep a private workspace through a /global/ path prefix', () => {
  const vfs = makeVfsWithVictimWorkspace();

  assert.throws(
    () => vfs.grep('SECRET', {
      pathPrefix: '/global/secret.txt',
      workspaceId: 'victim_ws',
      callerAgentId: 'attacker'
    }),
    isPermissionDenied,
    'a /global/ path prefix must not downgrade the foreign private workspace ACL class'
  );
});

test('cb9909f: an anonymous caller cannot grep a private workspace through a /global/ path prefix', () => {
  const vfs = makeVfsWithVictimWorkspace();

  assert.throws(
    () => vfs.grep('SECRET', {
      pathPrefix: '/global/secret.txt',
      workspaceId: 'victim_ws'
    }),
    isPermissionDenied,
    'anonymous /global/-prefixed access to a foreign private workspace must default-deny'
  );
});

test('cb9909f: the workspace owner still greps its own /global/-prefixed entries', () => {
  const vfs = makeVfsWithVictimWorkspace();

  const matches = vfs.grep('SECRET', {
    pathPrefix: '/global/secret.txt',
    workspaceId: 'victim_ws',
    callerAgentId: 'victim_ws'
  });

  assert.equal(matches.length, 1, 'the workspace owner must keep read access to its own entries');
  assert.equal(matches[0].workspaceId, 'victim_ws');
  assert.equal(matches[0].lineContent, 'TOP SECRET VICTIM DATA');
});

test('cb9909f: the shared global workspace stays readable through the /global/ prefix', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/global/shared.txt', 'shared-public-content', { workspaceId: 'global', callerAgentId: 'director' });

  const content = vfs.readFile('/global/shared.txt', { raw: true });
  assert.equal(content, 'shared-public-content', 'the global workspace prefix alias must keep working');
});
