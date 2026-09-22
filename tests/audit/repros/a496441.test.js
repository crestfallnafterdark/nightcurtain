/**
 * @file tests/audit/repros/a496441.test.js
 * @description Audit repro for ticket a496441 (Critical; MOD-21 sub-issue 7):
 * `VirtualFS` honors caller-supplied `isAdmin`/`privileged`/`isPrivileged` flags
 * at the workspace ACL (`#checkWorkspaceAccess`) and seven secondary
 * authorization sites, so any caller can read/write/delete another agent's
 * private workspace, overwrite read-only files, reassign ownership, mutate
 * permissions, and grep private workspaces by asserting a boolean. The
 * privilege flags were taken from the caller's own per-call options object
 * (virtualFs.js:1676-1702 and secondary sites, pre-fix).
 *
 * Ratified MOD-21 W4 fix: authority resolves from a principal descriptor
 * resolved through the injected identity port (or the opaque injected
 * `internalPrincipal` reference); per-call flags are ignored; anonymous and
 * unknown principals default-deny.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/a496441.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { VirtualFS, PermissionDeniedError } from '../../../src/lib/sandbox/virtualFs/index.ts';

const FORGED_FLAGS = ['isAdmin', 'isPrivileged', 'privileged'];

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

function operatorVfs(extraOptions = {}) {
  return new VirtualFS({
    identityPort: {
      getAgentIdentity: (agentId) => (agentId === 'operator' ? grantFor('operator') : { id: agentId, privileged: false, allowedTools: [] })
    },
    ...extraOptions
  });
}

function seedAlice(vfs) {
  vfs.writeFile('/secret_notes.txt', 'Alice secrets', {
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice'
  });
  vfs.writeFile('/diary.txt', 'needle in alice diary', {
    workspaceId: 'agent_alice',
    callerAgentId: 'agent_alice'
  });
}

test('a496441: forged privilege flags cannot read another private workspace', () => {
  const vfs = new VirtualFS();
  seedAlice(vfs);

  for (const flag of FORGED_FLAGS) {
    assert.throws(
      () => vfs.readFile('/secret_notes.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_bob', [flag]: true, raw: true }),
      (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED',
      `forged ${flag} must not open agent_alice's workspace`
    );
  }
});

test('a496441: forged privilege flags cannot write into another private workspace', () => {
  const vfs = new VirtualFS();
  seedAlice(vfs);

  for (const flag of FORGED_FLAGS) {
    assert.throws(
      () => vfs.writeFile('/hack.txt', 'payload', { workspaceId: 'agent_alice', callerAgentId: 'agent_bob', [flag]: true }),
      (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED',
      `forged ${flag} must not open agent_alice's workspace for writing`
    );
  }
});

test('a496441: forged privilege flags cannot delete from another private workspace', () => {
  const vfs = new VirtualFS();
  seedAlice(vfs);

  for (const flag of FORGED_FLAGS) {
    assert.throws(
      () => vfs.deleteFile('/secret_notes.txt', { workspaceId: 'agent_alice', callerAgentId: 'agent_bob', [flag]: true }),
      (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED',
      `forged ${flag} must not open agent_alice's workspace for deletion`
    );
  }
});

test('a496441: forged privilege flags cannot overwrite a read-only file', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/rules.txt', 'immutable', {
    workspaceId: 'global',
    callerAgentId: 'agent_alice',
    owner: 'agent_alice',
    readOnly: true
  });

  for (const flag of FORGED_FLAGS) {
    assert.throws(
      () => vfs.writeFile('/rules.txt', 'hacked', { workspaceId: 'global', callerAgentId: 'agent_bob', [flag]: true }),
      (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED',
      `forged ${flag} must not bypass the read-only lock`
    );
  }
});

test('a496441: forged privilege flags cannot reassign file ownership or mutate permissions', () => {
  const vfs = new VirtualFS();
  vfs.writeFile('/owned.txt', 'mine', { workspaceId: 'global', callerAgentId: 'agent_alice', owner: 'agent_alice' });
  vfs.writeFile('/locked.txt', 'locked', { workspaceId: 'global', callerAgentId: 'agent_alice', owner: 'agent_alice', readOnly: true });

  for (const flag of FORGED_FLAGS) {
    assert.throws(
      () => vfs.setPermissions('/owned.txt', { owner: 'attacker' }, { workspaceId: 'global', callerAgentId: 'agent_bob', [flag]: true }),
      (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED',
      `forged ${flag} must not reassign ownership`
    );
    assert.throws(
      () => vfs.setPermissions('/locked.txt', { readOnly: false }, { workspaceId: 'global', callerAgentId: 'agent_bob', [flag]: true }),
      (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED',
      `forged ${flag} must not unlock a read-only file`
    );
  }
});

test("a496441: forged privilege flags cannot widen grep workspaceId '*' scope", () => {
  const vfs = new VirtualFS();
  seedAlice(vfs);
  vfs.writeFile('/public_note.txt', 'needle in global', { workspaceId: 'global', callerAgentId: 'agent_writer' });

  for (const flag of FORGED_FLAGS) {
    const forged = vfs.grep(
      { pattern: 'needle', workspaceId: '*', callerAgentId: 'agent_bob' },
      { [flag]: true }
    );
    const leaked = forged.filter((m) => m.workspaceId === 'agent_alice');
    assert.equal(leaked.length, 0, `forged ${flag} must not leak agent_alice's workspace through grep`);

    const forgedPayload = vfs.grep({ pattern: 'needle', workspaceId: '*', callerAgentId: 'agent_bob', [flag]: true });
    assert.equal(forgedPayload.filter((m) => m.workspaceId === 'agent_alice').length, 0);
  }

  const scoped = vfs.grep({ pattern: 'needle', workspaceId: '*', callerAgentId: 'agent_bob' });
  assert.ok(scoped.some((m) => m.workspaceId === 'global'));
});

test('a496441: the injected authority descriptor still allows legitimate cross-workspace reads', () => {
  const vfs = operatorVfs();
  seedAlice(vfs);

  const content = vfs.readFile('/secret_notes.txt', { workspaceId: 'agent_alice', callerAgentId: 'operator', raw: true });
  assert.equal(content, 'Alice secrets');
});

test('a496441: the injected internal principal reference authorizes engine sync writes', () => {
  const internalPrincipal = Object.freeze({ kind: 'internal', subject: 'engine_sync' });
  const vfs = new VirtualFS({ internalPrincipal });

  const receipt = vfs.writeFile('/world_clock.json', '{"totalSeconds":0}', {
    workspaceId: 'agent_alice',
    principal: internalPrincipal,
    force: true
  });
  assert.equal(receipt.success, true);

  assert.throws(
    () => vfs.writeFile('/world_clock.json', '{"totalSeconds":1}', {
      workspaceId: 'agent_alice',
      callerAgentId: 'engine_sync',
      principal: { kind: 'internal', subject: 'engine_sync' },
      force: true
    }),
    (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED',
    'a plain lookalike principal must not impersonate the injected internal principal'
  );
});
