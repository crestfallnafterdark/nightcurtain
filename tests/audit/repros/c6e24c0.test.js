/**
 * @file tests/audit/repros/c6e24c0.test.js
 * @description Audit repro for ticket c6e24c0 (Major; MOD-21 post-release
 * substrate audit, VFS leg): `VirtualFS` tenant-administration members
 * (`deleteWorkspace`, `reset`, `exportSnapshot`, `importSnapshot`, `forAgent`)
 * accepted no principal, so any caller could destroy another tenant's
 * workspace, read every workspace through the snapshot, replace all state, or
 * obtain a full accessor for an arbitrary claimed agent id.
 *
 * Ratified MOD-21 W8-D fix: all five administer members default-deny anonymous
 * callers and require the injected `internalPrincipal` reference or an
 * identity-port `AuthorityDescriptor` granting cross-workspace authority.
 * Red before the fix; green after.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/c6e24c0.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualFS, PermissionDeniedError } from '../../../src/lib/sandbox/virtualFs/index.ts';

function isPermissionDenied(err) {
  return err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED';
}

function seedAlice(vfs) {
  vfs.writeFile('/secret.txt', 'alice-secret', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice' });
  return vfs;
}

function grantFor(subject) {
  return {
    id: subject,
    privileged: false,
    allowedTools: [],
    authority: {
      subject,
      kind: 'agent',
      allow: new Set(['*']),
      visibility: 'all'
    }
  };
}

function operatorVfs() {
  return new VirtualFS({
    identityPort: {
      getAgentIdentity: (agentId) => (agentId === 'operator'
        ? grantFor('operator')
        : { id: agentId, privileged: false, allowedTools: [] })
    }
  });
}

test('c6e24c0: anonymous forAgent is denied', () => {
  const vfs = seedAlice(new VirtualFS());
  assert.throws(() => vfs.forAgent('agent_alice'), isPermissionDenied, 'anonymous forAgent must default-deny');
});

test('c6e24c0: anonymous deleteWorkspace is denied and leaves the workspace intact', () => {
  const vfs = seedAlice(new VirtualFS());
  assert.throws(() => vfs.deleteWorkspace('agent_alice'), isPermissionDenied, 'anonymous deleteWorkspace must default-deny');
  assert.equal(vfs.hasWorkspace('agent_alice'), true, 'denied deletion must not destroy the workspace');
});

test('c6e24c0: anonymous reset is denied and leaves state intact', () => {
  const vfs = seedAlice(new VirtualFS());
  assert.throws(() => vfs.reset(), isPermissionDenied, 'anonymous reset must default-deny');
  assert.equal(vfs.readFile('/secret.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_alice', raw: true }), 'alice-secret');
});

test('c6e24c0: anonymous exportSnapshot is denied', () => {
  const vfs = seedAlice(new VirtualFS());
  assert.throws(() => vfs.exportSnapshot(), isPermissionDenied, 'anonymous exportSnapshot must default-deny');
});

test('c6e24c0: anonymous importSnapshot is denied and leaves prior state intact', () => {
  const vfs = seedAlice(new VirtualFS());
  assert.throws(
    () => vfs.importSnapshot({ global: { '/x.txt': { content: 'y', owner: 'mallory' } } }),
    isPermissionDenied,
    'anonymous importSnapshot must default-deny'
  );
  assert.equal(vfs.hasWorkspace('agent_alice'), true, 'denied import must not replace prior state');
});

test('c6e24c0: a plain lookalike principal is denied on every administer member', () => {
  const vfs = seedAlice(new VirtualFS());
  const lookalike = { kind: 'internal', subject: 'engine_sync' };

  assert.throws(() => vfs.forAgent('agent_alice', { principal: lookalike }), isPermissionDenied);
  assert.throws(() => vfs.deleteWorkspace('agent_alice', { principal: lookalike }), isPermissionDenied);
  assert.throws(() => vfs.reset({ principal: lookalike }), isPermissionDenied);
  assert.throws(() => vfs.exportSnapshot({ principal: lookalike }), isPermissionDenied);
  assert.throws(() => vfs.importSnapshot({}, { principal: lookalike }), isPermissionDenied);
});

test('c6e24c0: a non-granted agent descriptor cannot administer tenants', () => {
  const vfs = seedAlice(operatorVfs());
  assert.throws(() => vfs.deleteWorkspace('agent_alice', { callerAgentId: 'mallory' }), isPermissionDenied);
  assert.throws(() => vfs.exportSnapshot({ callerAgentId: 'mallory' }), isPermissionDenied);
});

test('c6e24c0: the injected internal principal authorizes all five administer members', () => {
  const internalPrincipal = Object.freeze({ kind: 'internal', subject: 'engine_sync' });
  const vfs = seedAlice(new VirtualFS({ internalPrincipal }));

  const snapshot = vfs.exportSnapshot({ principal: internalPrincipal });
  assert.ok(JSON.stringify(snapshot).includes('alice-secret'), 'authorized export must include tenant content');

  const proxy = vfs.forAgent('agent_alice', { principal: internalPrincipal });
  assert.equal(proxy.readFile('/secret.txt', { raw: true }), 'alice-secret', 'authorized proxy must read tenant content');

  const restored = new VirtualFS({ internalPrincipal });
  restored.importSnapshot(snapshot, { principal: internalPrincipal });
  assert.equal(restored.hasWorkspace('agent_alice'), true, 'authorized import must replace state');

  assert.equal(restored.deleteWorkspace('agent_alice', { principal: internalPrincipal }), true);
  assert.equal(restored.hasWorkspace('agent_alice'), false, 'authorized delete must evict the workspace');

  restored.reset({ principal: internalPrincipal });
  assert.deepEqual(restored.listWorkspaces(), [], 'authorized reset must clear every workspace');
});

test('c6e24c0: an identity-port operator descriptor authorizes tenant administration', () => {
  const vfs = seedAlice(operatorVfs());

  const proxy = vfs.forAgent('agent_alice', { callerAgentId: 'operator' });
  assert.equal(proxy.readFile('/secret.txt', { raw: true }), 'alice-secret');

  assert.equal(vfs.deleteWorkspace('agent_alice', { callerAgentId: 'operator' }), true);
  assert.equal(vfs.hasWorkspace('agent_alice'), false);
});
