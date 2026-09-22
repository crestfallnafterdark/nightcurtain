/**
 * @file tests/unit/virtual_fs_realm_scope_test.js
 * @description Realm wave A ticket 49cfc41 verification suite:
 *   1. Effective workspace alias resolution: `global`/`public` (and the
 *      `/global/`/`/public/` path prefixes) resolve to `realm:<realmId>:global`
 *      for realm-bound callers; ungrouped callers keep the literal `global`.
 *   2. Realm isolation matrix: member/member, member/foreign, same-realm admin,
 *      realm bypass, and legacy ungrouped parity.
 *   3. Enumeration confinement: `listWorkspaces`, `hasWorkspace`, and wildcard
 *      `grep` are confined to the caller's realm (+ self); a supplied but
 *      unresolvable caller context fails closed (V11 F2).
 *   4. `public` retirement: folded into the caller's shared-global handling
 *      while `isReservedWorkspaceKey('public')` keeps the key protected.
 *   5. Realm-global writes from members, survival across member eviction, and
 *      operator-level members (`reset`, `deleteWorkspace`, `forAgent`,
 *      `exportSnapshot` — a realm-bound caller never spans realms, V11 F1).
 *
 * Unit level: realm membership is supplied by an injected identity port; the
 * runtime producer wiring lands in Wave A (the projection fields are optional,
 * so the current runtime stays type-compatible).
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VirtualFS,
  isReservedWorkspaceKey,
  resolveAgentPrivateWorkspaceKey,
  remapLegacyWorkspaceKeys,
  PermissionDeniedError,
  FileNotFoundError
} from '../../src/lib/sandbox/virtualFs/index.ts';
import { createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';

/** Opaque engine-internal principal (composition-root wiring). */
const INTERNAL_PRINCIPAL = Object.freeze({ kind: 'internal', subject: 'realm_vfs_admin' });

/** Cross-workspace authority descriptor (same shape as the runtime producer). */
function authorityFor(subject) {
  return Object.freeze({
    subject,
    kind: 'agent',
    allow: Object.freeze(new Set(['*'])),
    visibility: 'all'
  });
}

/**
 * Trusted identity port with Realm membership (Wave A projection shape).
 * `realm_a_admin` / `realm_b_admin` carry a cross-workspace authority
 * descriptor but stay realm-bound; `bypass_director` carries `realmBypass`;
 * `ungrouped_*` carry neither optional field (legacy projection).
 * `director` is the hardcoded system-scope projection (null realm +
 * `realmBypass`); `realm_a_mapped` / `realm_a_mapped_custom` / `realm_a_alias`
 * are same-realm peers whose projected `workspaceId` aliases another
 * workspace key (ticket 2185224).
 */
const REALM_IDENTITY_PORT = Object.freeze({
  getAgentIdentity: (agentId) => {
    switch (agentId) {
      case 'realm_a_member':
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'alpha' };
      case 'realm_a_peer':
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'alpha' };
      case 'realm_a_admin':
        return { id: agentId, privileged: false, allowedTools: [], authority: authorityFor(agentId), realmId: 'alpha' };
      case 'realm_a_custom':
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'alpha', workspaceId: 'custom_alpha_ws' };
      case 'realm_b_member':
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'beta' };
      case 'realm_b_peer':
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'beta' };
      case 'realm_b_admin':
        return { id: agentId, privileged: false, allowedTools: [], authority: authorityFor(agentId), realmId: 'beta' };
      case 'realm_b_custom':
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'beta', workspaceId: 'custom_beta_ws' };
      case 'realm_a_mapped':
        // Mismatched projection (ticket 2185224): a same-realm peer whose
        // trusted projection aliases another realm's agent key.
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'alpha', workspaceId: 'realm_b_member' };
      case 'realm_a_mapped_custom':
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'alpha', workspaceId: 'realm_b_custom' };
      case 'realm_a_alias':
        // Same-realm mapped key: aliasing a same-realm peer's workspace stays
        // inside the caller's scope (no over-blocking).
        return { id: agentId, privileged: false, allowedTools: [], realmId: 'alpha', workspaceId: 'realm_a_peer' };
      case 'bypass_director':
        return { id: agentId, privileged: false, allowedTools: [], authority: authorityFor(agentId), realmId: 'alpha', realmBypass: true };
      case 'director':
        // The hardcoded system director projection: reserved system scope
        // (null realm, realmBypass only, ticket f5d1ccc).
        return { id: agentId, privileged: false, allowedTools: [], authority: authorityFor(agentId), realmBypass: true };
      case 'ungrouped_agent':
        return { id: agentId, privileged: false, allowedTools: [] };
      case 'ungrouped_operator':
        return { id: agentId, privileged: false, allowedTools: [], authority: authorityFor(agentId) };
      default:
        return null;
    }
  }
});

const denied = (err) => err instanceof PermissionDeniedError && err.code === 'PERMISSION_DENIED';
const missing = (err) => err instanceof FileNotFoundError && err.code === 'FILE_NOT_FOUND';

/** A VirtualFS wired with the realm identity port and the internal principal. */
function makeRealmVfs(options = {}) {
  return new VirtualFS({
    identityPort: REALM_IDENTITY_PORT,
    internalPrincipal: INTERNAL_PRINCIPAL,
    ...options
  });
}

// ============================================================================
// 1. Effective Workspace Alias Resolution
// ============================================================================

test('1. Realm-bound callers resolve global/public onto realm:<realmId>:global', () => {
  const vfs = makeRealmVfs();

  const alphaWrite = vfs.writeFile('/notes.md', 'alpha notes', { workspaceId: 'global', callerAgentId: 'realm_a_member' });
  assert.equal(alphaWrite.success, true);
  assert.equal(alphaWrite.workspaceId, 'global', "a realm member's `global` write lands in its realm-global workspace, reported realm-opaquely");
  assert.equal(vfs.hasWorkspace('realm:alpha:global'), true);
  assert.equal(vfs.hasWorkspace('global'), false, 'the literal global workspace is never created by a realm-bound alias');
  assert.equal(vfs.hasWorkspace('public'), false, 'no literal public workspace is created');

  // A same-realm peer reads the shared realm-global bytes through the same alias.
  assert.equal(
    vfs.readFile('/notes.md', { workspaceId: 'global', callerAgentId: 'realm_a_peer', raw: true }),
    'alpha notes',
    'the realm-global workspace is shared by realm members'
  );

  // A foreign-realm member has its own realm-global; the alpha file is invisible.
  assert.throws(
    () => vfs.readFile('/notes.md', { workspaceId: 'global', callerAgentId: 'realm_b_member' }),
    missing,
    "another realm's global alias must not see alpha's bytes"
  );
  assert.throws(
    () => vfs.readFile('/notes.md', { workspaceId: 'realm:alpha:global', callerAgentId: 'realm_b_member' }),
    denied,
    'an explicit foreign realm-global target is denied at the realm boundary'
  );

  // The `/global/` path prefix resolves to the same realm alias.
  const prefixed = vfs.writeFile('/global/prefixed.md', 'prefixed', { workspaceId: 'global', callerAgentId: 'realm_a_member' });
  assert.equal(prefixed.workspaceId, 'global');
  assert.equal(
    vfs.readFile('/global/prefixed.md', { callerAgentId: 'realm_a_member', raw: true }),
    'prefixed',
    'the /global/ prefix reads back from the realm-global workspace'
  );

  // Legacy global bytes stay invisible to realm-bound callers (stored keys are not renamed).
  vfs.writeFile('/legacy.md', 'legacy global', { workspaceId: 'global' });
  assert.equal(vfs.readFile('/legacy.md', { workspaceId: 'global', raw: true }), 'legacy global', 'ungrouped callers keep the literal global');
  assert.throws(
    () => vfs.readFile('/legacy.md', { workspaceId: 'global', callerAgentId: 'realm_a_member' }),
    missing,
    "realm-bound callers never fall back to the legacy ungrouped global namespace"
  );

  // Tool-path form: object-first params plus the trailing trusted context. The
  // trusted context is private-by-default (ticket a50f109); the shared workspace
  // is reached through the `/global/` mount.
  const contextWrite = vfs.writeFile({ filePath: '/ctx.md', content: 'ctx' }, { callerAgentId: 'realm_a_member' });
  assert.equal(contextWrite.workspaceId, 'realm_a_member', 'object-first writes default to the caller private workspace');
  const contextPrivateRead = vfs.readFile({ filePath: '/ctx.md' }, { callerAgentId: 'realm_a_member' });
  assert.equal(contextPrivateRead.content, 'ctx', 'the trailing context selects the caller private workspace for object-first reads');
  const sharedContextRead = vfs.readFile({ filePath: '/global/notes.md' }, { callerAgentId: 'realm_a_peer' });
  assert.equal(sharedContextRead.content, 'alpha notes', 'the /global mount selects the shared workspace for object-first reads');
  const contextList = vfs.listFiles({ directory_path: '/global' }, { callerAgentId: 'realm_a_member' });
  assert.ok(contextList.some(item => item.name === 'notes.md'), 'object-first listing reads the realm-global workspace through the mount');
  assert.throws(
    () => vfs.readFile({ filePath: '/legacy.md', workspaceId: 'realm:beta:global' }, { callerAgentId: 'realm_a_member' }),
    denied,
    'object-first reads keep the realm boundary with the context-resolved caller'
  );
});

// ============================================================================
// 2. Realm Isolation Matrix
// ============================================================================

test('2. Private-workspace isolation: member/member, foreign, same-realm admin, bypass, ungrouped parity', () => {
  const vfs = makeRealmVfs();
  vfs.writeFile('/member.md', 'alpha member private', { workspaceId: 'realm_a_member', callerAgentId: 'realm_a_member' });
  vfs.writeFile('/peer.md', 'alpha peer private', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_peer' });
  vfs.writeFile('/beta.md', 'beta member private', { workspaceId: 'realm_b_member', callerAgentId: 'realm_b_member' });
  vfs.writeFile('/ungrouped.md', 'ungrouped private', { workspaceId: 'ungrouped_agent', callerAgentId: 'ungrouped_agent' });
  vfs.writeFile('/legacy.md', 'legacy global', { workspaceId: 'global' });

  // Own workspace: read and write.
  assert.equal(vfs.readFile('/member.md', { workspaceId: 'realm_a_member', callerAgentId: 'realm_a_member', raw: true }), 'alpha member private');
  assert.equal(
    vfs.writeFile('/own.md', 'own write', { workspaceId: 'realm_a_member', callerAgentId: 'realm_a_member' }).success,
    true
  );

  // Member/member: a non-admin member cannot reach a same-realm peer's workspace.
  assert.throws(
    () => vfs.readFile('/peer.md', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_member' }),
    denied
  );
  assert.throws(
    () => vfs.writeFile('/peer.md', 'hijack', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_member' }),
    denied
  );
  assert.throws(
    () => vfs.listFiles('/', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_member' }),
    denied
  );
  assert.throws(
    () => vfs.exists('/peer.md', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_member' }),
    denied
  );

  // Same-realm admin (descriptor authority): peer access allowed.
  assert.equal(
    vfs.readFile('/peer.md', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_admin', raw: true }),
    'alpha peer private'
  );
  assert.equal(
    vfs.writeFile('/peer.md', 'admin overwrite', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_admin' }).success,
    true
  );

  // Cross-realm: denied even for the foreign realm's own admin.
  for (const caller of ['realm_a_member', 'realm_a_admin']) {
    assert.throws(
      () => vfs.readFile('/beta.md', { workspaceId: 'realm_b_member', callerAgentId: caller }),
      denied,
      `'${caller}' must not read a foreign private workspace`
    );
    assert.throws(
      () => vfs.writeFile('/beta.md', 'cross-realm write', { workspaceId: 'realm_b_member', callerAgentId: caller }),
      denied,
      `'${caller}' must not write a foreign private workspace`
    );
    assert.throws(
      () => vfs.deleteFile('/beta.md', { workspaceId: 'realm_b_member', callerAgentId: caller }),
      denied,
      `'${caller}' must not delete a foreign private file`
    );
    assert.throws(
      () => vfs.copyFile('/peer.md', '/stolen.md', { srcWorkspaceId: 'realm_a_member', destWorkspaceId: 'realm_b_member', callerAgentId: caller }),
      denied,
      `'${caller}' must not copy into a foreign private workspace`
    );
    assert.throws(
      () => vfs.readFile('/beta.md', { workspaceId: 'realm:beta:global', callerAgentId: caller }),
      denied,
      `'${caller}' targeting a foreign realm-global is denied`
    );
  }

  // Realm bypass: the injected internal principal and a realmBypass identity span realms.
  assert.equal(
    vfs.readFile('/beta.md', { workspaceId: 'realm_b_member', callerAgentId: 'bypass_director', raw: true }),
    'beta member private'
  );
  assert.equal(
    vfs.readFile('/ungrouped.md', { workspaceId: 'ungrouped_agent', principal: INTERNAL_PRINCIPAL, raw: true }),
    'ungrouped private'
  );

  // Ungrouped parity: no realmId projection keeps the legacy ACL exactly.
  assert.equal(vfs.readFile('/ungrouped.md', { workspaceId: 'ungrouped_agent', callerAgentId: 'ungrouped_agent', raw: true }), 'ungrouped private');
  assert.throws(
    () => vfs.readFile('/peer.md', { workspaceId: 'realm_a_peer', callerAgentId: 'ungrouped_agent' }),
    denied,
    'an ungrouped non-privileged caller cannot read a private peer workspace'
  );
  // Scope isolation (Realm wave R ticket d587e1e, V20 observation O-1): the
  // legacy privileged exemption never spans scopes — an ungrouped
  // cross-workspace operator reaches same-scope (ungrouped) targets only.
  assert.throws(
    () => vfs.readFile('/peer.md', { workspaceId: 'realm_a_peer', callerAgentId: 'ungrouped_operator' }),
    denied,
    'an ungrouped cross-workspace operator cannot select a realm-scoped private workspace'
  );
  assert.throws(
    () => vfs.writeFile('/peer.md', 'cross-scope write', { workspaceId: 'realm_a_peer', callerAgentId: 'ungrouped_operator' }),
    denied,
    'the cross-scope denial covers writes, not reads only'
  );
  assert.equal(
    vfs.readFile('/ungrouped.md', { workspaceId: 'ungrouped_agent', callerAgentId: 'ungrouped_operator', raw: true }),
    'ungrouped private',
    'same-scope (ungrouped) cross-workspace authority is unchanged'
  );
  assert.equal(
    vfs.readFile('/legacy.md', { workspaceId: 'global', callerAgentId: 'ungrouped_agent', raw: true }),
    'legacy global',
    'ungrouped callers keep the literal global workspace'
  );

  // Every identity-selecting read path shares the boundary (query_json included).
  assert.throws(
    () => vfs.queryJson('/peer.md', '.', { workspaceId: 'realm_b_member', callerAgentId: 'realm_a_admin' }),
    denied
  );

  // The remaining mutation surfaces resolve the same effective workspace.
  assert.throws(
    () => vfs.writeJson('/beta.json', { hijack: true }, { workspaceId: 'realm_b_member', callerAgentId: 'realm_a_admin' }),
    denied,
    'write_json cannot cross the realm boundary'
  );
  assert.throws(
    () => vfs.replaceFileContent('/beta.md', 'beta', 'hijack', { workspaceId: 'realm_b_member', callerAgentId: 'realm_a_admin' }),
    denied,
    'replace_file_content cannot cross the realm boundary'
  );
  assert.throws(
    () => vfs.patchJson('/beta.md', [{ op: 'replace', path: '/x', value: 1 }], { workspaceId: 'realm_b_member', callerAgentId: 'realm_a_admin' }),
    denied,
    'patch_json cannot cross the realm boundary'
  );
  assert.throws(
    () => vfs.setPermissions('/beta.md', true, { workspaceId: 'realm_b_member', callerAgentId: 'realm_a_admin' }),
    denied,
    'permission mutation cannot cross the realm boundary'
  );
});

// ============================================================================
// 3. Enumeration Confinement
// ============================================================================

test('3. listWorkspaces/hasWorkspace/wildcard-grep are confined to the caller realm (+ self)', () => {
  const vfs = makeRealmVfs();
  vfs.writeFile('/alpha.md', 'ALPHA SECRET', { workspaceId: 'global', callerAgentId: 'realm_a_member' });
  vfs.writeFile('/peer.md', 'PEER SECRET', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_peer' });
  vfs.writeFile('/self.md', 'SELF SECRET', { workspaceId: 'realm_a_member', callerAgentId: 'realm_a_member' });
  vfs.writeFile('/beta.md', 'BETA SECRET', { workspaceId: 'global', callerAgentId: 'realm_b_member' });
  vfs.writeFile('/beta_private.md', 'beta private note', { workspaceId: 'realm_b_member', callerAgentId: 'realm_b_member' });
  vfs.writeFile('/legacy.md', 'LEGACY SECRET', { workspaceId: 'global' });
  vfs.writeFile('/ungrouped.md', 'UNGROUPED SECRET', { workspaceId: 'ungrouped_agent', callerAgentId: 'ungrouped_agent' });

  // listWorkspaces: realm-bound member sees realm-global + own only.
  const memberList = vfs.listWorkspaces({ callerAgentId: 'realm_a_member' });
  assert.ok(memberList.includes('realm:alpha:global'), 'realm-global workspace is listed');
  assert.ok(memberList.includes('realm_a_member'), 'own workspace is listed');
  assert.equal(memberList.includes('realm_a_peer'), false, 'same-realm peer workspace is hidden from a non-admin member');
  assert.equal(memberList.includes('realm:beta:global'), false, "another realm's global is never listed");
  assert.equal(memberList.includes('global'), false, 'the legacy ungrouped global is never listed');
  assert.equal(memberList.includes('ungrouped_agent'), false, 'ungrouped workspaces are never listed');

  // Same-realm admin sees same-realm member workspaces, never foreign realms.
  const adminList = vfs.listWorkspaces({ callerAgentId: 'realm_a_admin' });
  assert.ok(adminList.includes('realm_a_peer'), 'a same-realm admin enumerates same-realm member workspaces');
  assert.equal(adminList.includes('realm_b_member'), false, 'foreign member workspaces stay hidden');
  assert.equal(adminList.includes('realm:beta:global'), false, 'foreign realm-global stays hidden');

  // Operator/internal and context-free substrate calls span all (legacy behavior).
  const internalList = vfs.listWorkspaces({ principal: INTERNAL_PRINCIPAL });
  const fullList = vfs.listWorkspaces();
  for (const key of ['realm:alpha:global', 'realm:beta:global', 'realm_a_peer', 'realm_a_member', 'realm_b_member', 'ungrouped_agent', 'global']) {
    assert.ok(internalList.includes(key), `internal enumeration spans '${key}'`);
    assert.ok(fullList.includes(key), `context-free enumeration spans '${key}'`);
  }
  const bypassList = vfs.listWorkspaces({ callerAgentId: 'bypass_director' });
  assert.ok(bypassList.includes('realm:beta:global'), 'a realmBypass identity spans all workspaces');

  // hasWorkspace: no cross-realm existence oracle.
  assert.equal(vfs.hasWorkspace('realm:alpha:global', { callerAgentId: 'realm_a_member' }), true);
  assert.equal(vfs.hasWorkspace('realm:beta:global', { callerAgentId: 'realm_a_member' }), false);
  assert.equal(vfs.hasWorkspace('realm_b_member', { callerAgentId: 'realm_a_member' }), false);
  assert.equal(vfs.hasWorkspace('realm_a_peer', { callerAgentId: 'realm_a_admin' }), true);
  assert.equal(vfs.hasWorkspace('realm_b_member', { callerAgentId: 'realm_a_admin' }), false);
  assert.equal(vfs.hasWorkspace('realm:beta:global', { callerAgentId: 'realm_a_admin' }), false, 'foreign realm-global existence stays hidden');
  assert.equal(vfs.hasWorkspace('realm:beta:global'), true, 'context-free calls keep the literal existence check');
  assert.equal(vfs.hasWorkspace('realm:beta:global', { principal: INTERNAL_PRINCIPAL }), true, 'the internal principal spans all');

  // F2 (V11): a supplied but unresolvable caller context fails closed; the
  // enumeration surfaces never fall back to the unscoped legacy span for an
  // identity the injected port cannot resolve (listWorkspaces ~:4344,
  // hasWorkspace ~:4375).
  for (const ghost of ['ghost', 'throwing', null]) {
    assert.deepEqual(
      vfs.listWorkspaces({ callerAgentId: ghost }),
      [],
      `an unresolvable callerAgentId (${String(ghost)}) enumerates nothing`
    );
  }
  assert.deepEqual(vfs.listWorkspaces({ agentId: 'ghost' }), [], 'the agentId alias fails closed the same way');
  assert.deepEqual(vfs.listWorkspaces({ principal: { kind: 'internal' } }), [], 'a lookalike principal context fails closed');
  assert.equal(vfs.hasWorkspace('realm_b_member', { callerAgentId: 'ghost' }), false, 'an unresolvable caller gets no cross-realm existence oracle');
  assert.equal(vfs.hasWorkspace('realm_a_member', { callerAgentId: 'throwing' }), false, 'a throwing identity port denies enumeration');
  assert.equal(vfs.hasWorkspace('realm_b_member', { callerAgentId: null }), false, 'an explicitly anonymous caller context fails closed');
  // The legacy spans stay intact: context-free substrate calls, the trusted
  // principal, and resolvable (ungrouped) identities are unchanged.
  assert.ok(vfs.listWorkspaces().includes('realm_b_member'), 'context-free enumeration still spans every workspace');
  assert.equal(vfs.hasWorkspace('realm_b_member'), true, 'context-free existence checks stay literal');
  assert.ok(vfs.listWorkspaces({ principal: INTERNAL_PRINCIPAL }).includes('realm_b_member'), 'the internal principal still spans every workspace');
  assert.ok(
    vfs.listWorkspaces({ callerAgentId: 'ungrouped_agent' }).includes('realm_b_member'),
    'a resolvable ungrouped caller keeps the legacy unscoped span'
  );

  // Wildcard grep: member scans realm-global + own; admin adds same-realm peers.
  // Hit labels are realm-opaque (the caller's realm-global reports as `global`),
  // so confinement is asserted by content, not by the internal partition key.
  const memberHits = vfs.grep({ pattern: 'SECRET', workspaceId: '*' }, { callerAgentId: 'realm_a_member' });
  const memberWorkspaces = new Set(memberHits.map(hit => hit.workspaceId));
  assert.deepEqual([...memberWorkspaces].sort(), ['global', 'realm_a_member'].sort());
  assert.equal(memberHits.some(hit => hit.workspaceId === 'realm_a_peer'), false, 'peer workspace is not scanned for a member');
  assert.equal(memberHits.some(hit => /beta|ungrouped/.test(hit.workspaceId)), false, 'foreign/ungrouped workspaces are not scanned');
  assert.equal(memberHits.some(hit => hit.lineContent === 'LEGACY SECRET'), false, 'the literal legacy global workspace is not scanned');

  const adminHits = vfs.grep({ pattern: 'SECRET', workspaceId: '*' }, { callerAgentId: 'realm_a_admin' });
  const adminWorkspaces = new Set(adminHits.map(hit => hit.workspaceId));
  assert.ok(adminWorkspaces.has('realm_a_peer'), 'same-realm peer workspace is scanned for a same-realm admin');
  assert.equal(adminWorkspaces.has('realm:beta:global'), false, 'foreign realm-global is never scanned');
  assert.equal(adminHits.some(hit => hit.lineContent === 'LEGACY SECRET'), false, 'legacy global is never scanned');

  const betaHits = vfs.grep({ pattern: 'SECRET', workspaceId: '*' }, { callerAgentId: 'realm_b_member' });
  assert.deepEqual([...new Set(betaHits.map(hit => hit.workspaceId))], ['global'], 'realm-beta shared hits are reported realm-opaquely');
  assert.equal(betaHits.some(hit => hit.lineContent === 'ALPHA SECRET' || hit.lineContent === 'LEGACY SECRET'), false, "foreign/legacy bytes are never revealed");

  const ungroupedHits = vfs.grep({ pattern: 'SECRET', workspaceId: '*' }, { callerAgentId: 'ungrouped_agent' });
  const ungroupedWorkspaces = new Set(ungroupedHits.map(hit => hit.workspaceId));
  assert.deepEqual([...ungroupedWorkspaces].sort(), ['global', 'ungrouped_agent'].sort(), 'legacy ungrouped wildcard scope is unchanged');

  const internalHits = vfs.grep({ pattern: 'SECRET', workspaceId: '*' }, { principal: INTERNAL_PRINCIPAL });
  const internalWorkspaces = new Set(internalHits.map(hit => hit.workspaceId));
  for (const key of ['realm:alpha:global', 'realm:beta:global', 'realm_a_peer', 'realm_a_member', 'ungrouped_agent', 'global']) {
    assert.ok(internalWorkspaces.has(key), `internal wildcard grep spans '${key}'`);
  }

  // Non-wildcard grep against a foreign workspace is denied at the boundary.
  assert.throws(
    () => vfs.grep({ pattern: 'SECRET', workspaceId: 'realm_b_member' }, { callerAgentId: 'realm_a_admin' }),
    denied
  );
});

// ============================================================================
// 4. `public` Retirement
// ============================================================================

test('4. The unscoped public alias folds into global handling and stays reserved', () => {
  const vfs = makeRealmVfs();

  // Realm-bound: public folds onto the caller's realm-global workspace.
  const alphaPublic = vfs.writeFile('/shared.md', 'alpha public', { workspaceId: 'public', callerAgentId: 'realm_a_member' });
  assert.equal(alphaPublic.workspaceId, 'global', "a realm member's `public` write folds into its realm-global workspace, reported realm-opaquely");
  assert.equal(
    vfs.readFile('/shared.md', { workspaceId: 'public', callerAgentId: 'realm_a_peer', raw: true }),
    'alpha public',
    'same-realm peers share the folded public workspace'
  );
  assert.throws(
    () => vfs.readFile('/shared.md', { workspaceId: 'public', callerAgentId: 'realm_b_member' }),
    missing,
    'public is no longer an unscoped cross-realm namespace'
  );
  assert.throws(
    () => vfs.readFile('/shared.md', { workspaceId: 'realm:beta:global', callerAgentId: 'realm_b_member' }),
    missing,
    "beta's public namespace is its own realm-global"
  );

  // The `/public/` path prefix folds the same way.
  const prefixed = vfs.writeFile('/public/prefix.md', 'public prefix', { workspaceId: 'realm:alpha:global', callerAgentId: 'realm_a_member' });
  assert.equal(prefixed.workspaceId, 'global');
  assert.equal(vfs.readFile('/public/prefix.md', { callerAgentId: 'realm_a_member', raw: true }), 'public prefix');

  // Ungrouped: public folds onto the literal global workspace.
  const ungroupedPublic = vfs.writeFile('/legacy_pub.md', 'legacy public', { workspaceId: 'public' });
  assert.equal(ungroupedPublic.workspaceId, 'global', 'an ungrouped `public` write lands in the literal global workspace');
  assert.equal(vfs.readFile('/legacy_pub.md', { workspaceId: 'global', raw: true }), 'legacy public');
  assert.equal(vfs.readFile('/legacy_pub.md', { workspaceId: 'public', raw: true }), 'legacy public', 'the public alias reads the folded global bytes');
  assert.equal(vfs.hasWorkspace('public'), false, 'no literal public workspace is created by the alias');

  // Stored keys are never renamed: a pre-existing literal public workspace survives, protected.
  vfs.initWorkspace('public');
  assert.equal(vfs.hasWorkspace('public'), true, 'pre-existing stored keys stay in the map');
  assert.ok(vfs.listWorkspaces().includes('public'), 'context-free enumeration still reports stored keys literally');
  assert.equal(isReservedWorkspaceKey('public'), true, 'the reserved-key vocabulary keeps public protected');
  assert.equal(vfs.deleteWorkspace('public', { principal: INTERNAL_PRINCIPAL }), false, 'public remains undeletable through lifecycle eviction');
});

// ============================================================================
// 5. Realm-Global Writes from Members + Operator-Level Members
// ============================================================================

test('5. Member-written realm-global bytes survive member eviction; operator members stay operator-level', () => {
  const vfs = makeRealmVfs();
  vfs.writeFile('/shared.md', 'realm shared', { workspaceId: 'global', callerAgentId: 'realm_a_member' });
  vfs.writeFile('/private.md', 'member private', { workspaceId: 'realm_a_member', callerAgentId: 'realm_a_member' });
  vfs.writeFile('/peer.md', 'alpha peer private', { workspaceId: 'realm_a_peer', callerAgentId: 'realm_a_peer' });

  // A same-realm admin evicts the member's private workspace; the realm-global survives.
  assert.equal(vfs.deleteWorkspace('realm_a_member', { callerAgentId: 'realm_a_admin' }), true);
  assert.equal(vfs.hasWorkspace('realm_a_member'), false);
  assert.equal(
    vfs.readFile('/shared.md', { workspaceId: 'global', callerAgentId: 'realm_a_peer', raw: true }),
    'realm shared',
    'the realm-global workspace shared by realm members survives member eviction'
  );
  assert.equal(vfs.deleteWorkspace('realm:alpha:global', { callerAgentId: 'realm_a_admin' }), false, 'realm-global keys are reserved against every caller');

  // Cross-realm tenant administration is denied for realm-bound callers.
  assert.throws(
    () => vfs.deleteWorkspace('realm_b_member', { callerAgentId: 'realm_a_admin' }),
    denied,
    'a realm admin cannot evict a foreign private workspace'
  );
  assert.throws(
    () => vfs.forAgent('realm_b_member', { callerAgentId: 'realm_a_admin' }),
    denied,
    'a realm admin cannot mint a proxy for a foreign agent'
  );
  assert.throws(
    () => vfs.reset({ callerAgentId: 'realm_a_admin' }),
    denied,
    'reset is operator-level: realm-bound callers are refused outright'
  );

  // F1 (V11): a full snapshot spans every realm's bytes, so a realm-bound
  // caller — even one holding descriptor `*` authority — is refused outright,
  // exactly like `reset`; trusted operator spans keep the full export
  // (exportSnapshot ~:7095-7112).
  vfs.writeFile('/beta_export.md', 'beta private bytes', { workspaceId: 'realm_b_member', callerAgentId: 'realm_b_member' });
  assert.throws(
    () => vfs.exportSnapshot({ callerAgentId: 'realm_a_admin' }),
    denied,
    'a realm-bound * authority cannot export every realm'
  );
  assert.throws(
    () => vfs.exportSnapshot({ callerAgentId: 'realm_a_member' }),
    denied,
    'a plain realm member cannot export every realm'
  );
  assert.throws(
    () => vfs.exportSnapshot({ callerAgentId: 'realm_a_admin', agentId: 'realm_a_member' }),
    denied,
    'the agentId alias path cannot dodge the realm-bound refusal'
  );
  assert.equal(
    vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL }).realm_b_member['/beta_export.md'].content,
    'beta private bytes',
    'the internal operator still exports every realm'
  );
  assert.equal(
    vfs.exportSnapshot({ callerAgentId: 'bypass_director' }).realm_b_member['/beta_export.md'].content,
    'beta private bytes',
    'a realmBypass director still exports every realm'
  );
  assert.equal(
    vfs.exportSnapshot({ callerAgentId: 'ungrouped_operator' }).realm_b_member['/beta_export.md'].content,
    'beta private bytes',
    'an ungrouped cross-workspace operator keeps the legacy export'
  );

  // Same-realm proxy minting still works for a same-realm admin.
  const sameRealmProxy = vfs.forAgent('realm_a_peer', { callerAgentId: 'realm_a_admin' });
  assert.equal(sameRealmProxy.readFile('/peer.md', { raw: true }), 'alpha peer private');

  // The internal principal keeps the operator path (eviction and reset).
  const fresh = makeRealmVfs();
  fresh.writeFile('/tmp.md', 'tmp', { workspaceId: 'temp_ws', callerAgentId: 'temp_ws' });
  assert.equal(fresh.deleteWorkspace('temp_ws', { principal: INTERNAL_PRINCIPAL }), true, 'the operator path still evicts ordinary workspaces');
  assert.equal(fresh.reset({ principal: INTERNAL_PRINCIPAL }), undefined);
  assert.deepEqual(fresh.listWorkspaces(), [], 'operator reset still clears every workspace');
});

// ============================================================================
// 6. Legacy Ungrouped Parity Without a Realm Projection
// ============================================================================

test('6. Projections without realm fields keep the legacy ungrouped behavior', () => {
  const port = {
    getAgentIdentity: (agentId) => ({ id: agentId, privileged: false, allowedTools: [] })
  };
  const vfs = new VirtualFS({ identityPort: port });

  vfs.writeFile('/shared.md', 'legacy', { workspaceId: 'global', callerAgentId: 'legacy_agent' });
  assert.equal(vfs.readFile('/shared.md', { workspaceId: 'global', callerAgentId: 'legacy_agent', raw: true }), 'legacy');
  assert.equal(vfs.hasWorkspace('global'), true, 'the literal global workspace is used when no realmId is projected');
  assert.equal(vfs.hasWorkspace('realm:alpha:global'), false);

  // `public` folds to global for ungrouped callers; reserved guard intact.
  vfs.writeFile('/pub.md', 'pub', { workspaceId: 'public', callerAgentId: 'legacy_agent' });
  assert.equal(vfs.readFile('/pub.md', { workspaceId: 'global', raw: true }), 'pub');
  assert.equal(isReservedWorkspaceKey('public'), true);

  // Enumeration and wildcard grep stay unscoped.
  assert.ok(vfs.listWorkspaces({ callerAgentId: 'legacy_agent' }).includes('global'));
  const hits = vfs.grep({ pattern: 'legacy', workspaceId: '*' }, { callerAgentId: 'legacy_agent' });
  assert.deepEqual([...new Set(hits.map(hit => hit.workspaceId))], ['global']);
});

// ============================================================================
// 7. Agent Workspace View: Private-By-Default Placement (ticket a50f109)
// ============================================================================

test('7. [a50f109] trusted agent context is private-by-default and writes honor the bound workspace', () => {
  const vfs = makeRealmVfs();

  // A trusted-context write with no explicit workspace lands in the caller's
  // own private workspace (never the shared realm-global workspace).
  const alphaWrite = vfs.writeFile({ filePath: '/same.md', content: 'alpha private' }, { callerAgentId: 'realm_a_member' });
  assert.equal(alphaWrite.workspaceId, 'realm_a_member', 'a default agent write lands in the caller private workspace');
  assert.equal(vfs.hasWorkspace('realm:alpha:global'), false, 'the shared realm-global workspace is untouched by a default write');
  assert.equal(vfs.hasWorkspace('realm_a_member'), true);

  // Two agents writing the same path stay separate.
  const peerWrite = vfs.writeFile({ filePath: '/same.md', content: 'peer private' }, { callerAgentId: 'realm_a_peer' });
  assert.equal(peerWrite.workspaceId, 'realm_a_peer');
  assert.equal(vfs.readFile({ filePath: '/same.md' }, { callerAgentId: 'realm_a_member', raw: true }), 'alpha private');
  assert.equal(vfs.readFile({ filePath: '/same.md' }, { callerAgentId: 'realm_a_peer', raw: true }), 'peer private');

  // `writeFile` honors the trusted context workspace exactly like `readFile`.
  const bound = vfs.writeFile({ filePath: '/bound.md', content: 'bound bytes' }, { callerAgentId: 'realm_a_member', workspaceId: 'realm_a_member' });
  assert.equal(bound.workspaceId, 'realm_a_member', 'writeFile honors the trusted context workspace binding');
  assert.equal(vfs.readFile({ filePath: '/bound.md' }, { callerAgentId: 'realm_a_member', raw: true }), 'bound bytes');

  // `/global/...` is the shared mount: visible to every realm member, stored at
  // the mount-stripped path (no literal `/global/...` records).
  const sharedWrite = vfs.writeFile({ filePath: '/global/lore.md', content: 'shared lore' }, { callerAgentId: 'realm_a_member' });
  assert.equal(sharedWrite.workspaceId, 'global', 'the shared mount receipt is realm-opaque');
  assert.equal(vfs.readFile({ filePath: '/global/lore.md' }, { callerAgentId: 'realm_a_peer', raw: true }), 'shared lore');
  assert.throws(
    () => vfs.readFile({ filePath: '/lore.md' }, { callerAgentId: 'realm_a_peer' }),
    missing,
    'the shared mount is not the default private target'
  );
  const snapshot = vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.ok(snapshot['realm:alpha:global'] && snapshot['realm:alpha:global']['/lore.md'], 'the shared write is stored at the stripped path');
  assert.equal(snapshot['realm:alpha:global']['/global/lore.md'], undefined, 'no literal /global/... record is created');
  assert.ok(snapshot['realm_a_member']['/same.md'], 'the private write stays in the caller workspace');

  // A cross-realm agent sees neither the private bytes nor the shared bytes.
  assert.throws(() => vfs.readFile({ filePath: '/lore.md' }, { callerAgentId: 'realm_b_member' }), missing);
  assert.throws(() => vfs.readFile({ filePath: '/global/lore.md' }, { callerAgentId: 'realm_b_member' }), missing);

  // Root listings: `/` shows private files plus the synthetic `global/` mount
  // (and `agents/` for cross-workspace authority holders only).
  const memberRoot = vfs.listFiles({ directory_path: '/' }, { callerAgentId: 'realm_a_member' });
  const memberNames = memberRoot.map(item => item.name).sort();
  assert.deepEqual(memberNames, ['bound.md', 'global', 'same.md'], 'an ordinary member root shows private files plus global/');
  assert.equal(memberRoot.some(item => String(item.workspaceId || '').includes('realm:')), false, 'listing labels are realm-opaque');
  const adminRoot = vfs.listFiles({ directory_path: '/' }, { callerAgentId: 'realm_a_admin' });
  assert.deepEqual(adminRoot.map(item => item.name).sort(), ['agents', 'global'], 'a root caller additionally sees the synthetic agents/ mount');

  // `/global` lists the shared contents labelled `global`.
  const sharedList = vfs.listFiles({ directory_path: '/global' }, { callerAgentId: 'realm_a_member' });
  assert.deepEqual(sharedList.map(item => item.name), ['lore.md'], 'the /global mount lists the shared workspace root');
  assert.equal(sharedList[0].workspaceId, 'global', 'shared files are labelled global');

  // Mount-root listings present view paths that are re-readable (V19-F1,
  // ticket 0a17bdb): `/global` listings — recursive included — must carry the
  // `/global/...` prefix instead of the storage-relative path.
  vfs.writeFile({ filePath: '/global/sub/inner.md', content: 'shared inner' }, { callerAgentId: 'realm_a_member' });
  const sharedRoot = vfs.listFiles({ directory_path: '/global' }, { callerAgentId: 'realm_a_member' });
  assert.ok(sharedRoot.every(item => item.path.startsWith('/global/')), 'the /global mount-root listing presents /global/... view paths');
  assert.ok(sharedRoot.some(item => item.path === '/global/lore.md'), 'the shared file path is the view path');
  const sharedRecursive = vfs.listFiles({ directory_path: '/global', recursive: true }, { callerAgentId: 'realm_a_member' });
  assert.ok(sharedRecursive.every(item => item.path.startsWith('/global/')), 'the recursive /global listing presents /global/... view paths');
  assert.ok(sharedRecursive.some(item => item.path === '/global/sub/inner.md'), 'nested shared file paths are view paths');
  assert.equal(
    vfs.readFile({ filePath: '/global/sub/inner.md' }, { callerAgentId: 'realm_a_peer', raw: true }),
    'shared inner',
    'every listed /global path is re-readable through the mount'
  );
});

// ============================================================================
// 8. Agent Mounts: /agents/<id> Authority Matrix (ticket a50f109)
// ============================================================================

test('8. [a50f109] /agents mounts require cross-workspace authority and stay within the realm', () => {
  const vfs = makeRealmVfs();
  vfs.writeFile({ filePath: '/peer.md', content: 'peer private bytes' }, { callerAgentId: 'realm_a_peer' });
  vfs.writeFile({ filePath: '/beta.md', content: 'beta private bytes' }, { callerAgentId: 'realm_b_member' });
  vfs.writeFile({ filePath: '/self.md', content: 'self private bytes' }, { callerAgentId: 'realm_a_member' });

  // `/agents/<self>/...` behaves exactly like `/...`.
  assert.equal(
    vfs.readFile({ filePath: '/agents/realm_a_member/self.md' }, { callerAgentId: 'realm_a_member', raw: true }),
    'self private bytes',
    'the self mount resolves to the caller private workspace'
  );

  // Ordinary member: a same-realm peer mount is denied (no cross-workspace authority).
  assert.throws(
    () => vfs.readFile({ filePath: '/agents/realm_a_peer/peer.md' }, { callerAgentId: 'realm_a_member' }),
    denied,
    'an ordinary member cannot mount a peer private workspace'
  );

  // Same-realm root: the mount is allowed.
  assert.equal(
    vfs.readFile({ filePath: '/agents/realm_a_peer/peer.md' }, { callerAgentId: 'realm_a_admin', raw: true }),
    'peer private bytes',
    'a same-realm root caller mounts a same-realm peer workspace'
  );

  // Cross-realm root: denied with the exact requested id, and realm-opaque.
  let crossErr = null;
  try {
    vfs.readFile({ filePath: '/agents/realm_b_member/beta.md' }, { callerAgentId: 'realm_a_admin' });
  } catch (err) {
    crossErr = err;
  }
  assert.ok(crossErr instanceof PermissionDeniedError, 'a cross-realm mount is denied outright');
  assert.ok(String(crossErr.message).includes('realm_b_member'), 'the denial names the exact requested mount id');
  assert.equal(/(^|[^a-z])realm:/.test(String(crossErr.message)), false, 'the denial is realm-opaque');

  // `/agents` listing: root sees same-realm mounts only; ordinary is denied.
  const adminMounts = vfs.listFiles({ directory_path: '/agents' }, { callerAgentId: 'realm_a_admin' });
  const mountNames = adminMounts.map(item => item.name).sort();
  assert.deepEqual(mountNames, ['realm_a_member', 'realm_a_peer'], 'a root caller lists same-realm mount targets only');
  assert.equal(adminMounts.some(item => String(item.name).includes('realm:')), false, 'mount targets never expose realm keys');
  assert.throws(
    () => vfs.listFiles({ directory_path: '/agents' }, { callerAgentId: 'realm_a_member' }),
    denied,
    'an ordinary member cannot enumerate mount targets'
  );

  // Mounts never cross realms for an ungrouped cross-workspace operator either
  // once a realm identity is bound; a realmBypass director still spans.
  assert.equal(
    vfs.readFile({ filePath: '/agents/realm_b_member/beta.md' }, { callerAgentId: 'bypass_director', raw: true }),
    'beta private bytes',
    'the realmBypass director spans realms'
  );
});

// ============================================================================
// 9. Realm Opacity in Agent-Visible Receipts and Errors (ticket a50f109)
// ============================================================================

test('9. [a50f109] no realm key leaks through agent-visible VFS receipts, listings, or errors', () => {
  const vfs = makeRealmVfs();

  const write = vfs.writeFile({ filePath: '/global/shared.md', content: 'shared bytes' }, { callerAgentId: 'realm_a_member' });
  assert.equal(write.workspaceId, 'global');
  assert.equal(JSON.stringify(write).includes('realm:'), false, 'the write receipt is realm-opaque');

  const replace = vfs.replaceFileContent(
    { file_path: '/global/shared.md', target_content: 'shared', replacement_content: 'edited' },
    { callerAgentId: 'realm_a_member' }
  );
  assert.equal(replace.workspaceId, 'global');
  assert.equal(JSON.stringify(replace).includes('realm:'), false, 'the replace receipt is realm-opaque');

  const list = vfs.listFiles({ directory_path: '/global' }, { callerAgentId: 'realm_a_member' });
  assert.equal(JSON.stringify(list).includes('realm:'), false, 'listing entries are realm-opaque');

  const hits = vfs.grep({ pattern: 'edited', path_prefix: '/global' }, { callerAgentId: 'realm_a_member' });
  assert.equal(hits.length, 1, 'the shared mount grep finds the shared file');
  assert.equal(JSON.stringify(hits).includes('realm:'), false, 'grep hits are realm-opaque');

  let notFound = null;
  try {
    vfs.readFile({ filePath: '/missing.md' }, { callerAgentId: 'realm_a_member' });
  } catch (err) {
    notFound = err;
  }
  assert.ok(notFound, 'a missing private file raises FileNotFoundError');
  assert.equal(String(notFound.message).includes('realm:'), false, 'the error message is realm-opaque');
  assert.equal(JSON.stringify(notFound.details || {}).includes('realm:'), false, 'the error details are realm-opaque');
});

// ============================================================================
// 10. Legacy `/global/<path>` Read Compatibility (ticket a50f109)
// ============================================================================

test('10. [a50f109] legacy literal /global/<path> records stay readable through the shared mount', () => {
  const vfs = makeRealmVfs();
  const now = Date.now();
  vfs.importSnapshot({
    'realm:alpha:global': {
      '/global/legacy.md': {
        path: '/global/legacy.md',
        workspaceId: 'realm:alpha:global',
        content: 'legacy nested bytes',
        size: 19,
        updatedAt: now,
        readOnly: false,
        owner: 'system'
      }
    }
  }, { principal: INTERNAL_PRINCIPAL });

  assert.equal(
    vfs.readFile({ filePath: '/global/legacy.md' }, { callerAgentId: 'realm_a_member', raw: true }),
    'legacy nested bytes',
    'the legacy nested record is readable through the /global mount'
  );
  assert.equal(vfs.exists({ filePath: '/global/legacy.md' }, { callerAgentId: 'realm_a_member' }), true);
  assert.throws(
    () => vfs.readFile({ filePath: '/legacy.md' }, { callerAgentId: 'realm_a_member' }),
    missing,
    'the private default never silently falls back to shared bytes'
  );
  // A fresh write stays clean: the stripped path is the only record shape.
  vfs.writeFile({ filePath: '/global/clean.md', content: 'clean' }, { callerAgentId: 'realm_a_member' });
  const snapshot = vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.ok(snapshot['realm:alpha:global']['/clean.md'], 'new shared writes are stored clean');
  assert.equal(snapshot['realm:alpha:global']['/global/clean.md'], undefined);
});

// ============================================================================
// 11. Custom-Workspace Peers Mount by Agent Identity (ticket 9765b96)
// ============================================================================

test('11. [9765b96] /agents mounts resolve custom-workspace peers by agent identity', () => {
  const vfs = makeRealmVfs();

  // A same-realm peer whose private workspace key is explicitly configured.
  const customWrite = vfs.writeFile({ filePath: '/secret.md', content: 'custom peer private' }, { callerAgentId: 'realm_a_custom' });
  assert.equal(customWrite.workspaceId, 'custom_alpha_ws', 'the custom peer writes into its projected workspace key');

  // Same-realm root: the mount resolves by the peer agent id, not by physical key.
  assert.equal(
    vfs.readFile({ filePath: '/agents/realm_a_custom/secret.md' }, { callerAgentId: 'realm_a_admin', raw: true }),
    'custom peer private',
    'a same-realm root mounts a custom-workspace peer by agent id'
  );

  // The observed mount appears in the root listing as the peer id, with the
  // custom workspace child count and no physical-key exposure.
  const mounts = vfs.listFiles({ directory_path: '/agents' }, { callerAgentId: 'realm_a_admin' });
  const names = mounts.map(item => item.name).sort();
  assert.ok(names.includes('realm_a_custom'), 'the /agents listing includes the custom-workspace peer');
  const customEntry = mounts.find(item => item.name === 'realm_a_custom');
  assert.equal(customEntry.childCount, 1, 'the mount childCount reflects the custom workspace');
  assert.equal(JSON.stringify(mounts).includes('custom_alpha_ws'), false, 'mount listings never expose physical workspace keys');

  // Ordinary caller: still denied, realm-opaquely.
  assert.throws(
    () => vfs.readFile({ filePath: '/agents/realm_a_custom/secret.md' }, { callerAgentId: 'realm_a_member' }),
    denied,
    'an ordinary member cannot mount a custom-workspace peer'
  );

  // Cross-realm root: denied naming the exact requested mount id, and the
  // denial never exposes the peer's physical workspace key.
  let crossErr = null;
  try {
    vfs.readFile({ filePath: '/agents/realm_b_custom/secret.md' }, { callerAgentId: 'realm_a_admin' });
  } catch (err) {
    crossErr = err;
  }
  assert.ok(crossErr instanceof PermissionDeniedError, 'a cross-realm custom-peer mount is denied');
  assert.ok(String(crossErr.message).includes('realm_b_custom'), 'the denial names the exact requested mount id');
  assert.equal(/realm:|custom_beta_ws/.test(String(crossErr.message)), false, 'the denial never exposes the peer workspace key');
  assert.equal(/realm:|custom_beta_ws/.test(JSON.stringify(crossErr.details || {})), false, 'denial details never expose the peer workspace key');

  // Cross-scope reach is denied for every caller, the ungrouped privileged
  // legacy operator included (ticket d587e1e): a mount target must share the
  // caller's scope, and an ungrouped caller shares no realm's scope.
  assert.throws(
    () => vfs.readFile({ filePath: '/agents/realm_a_custom/secret.md' }, { callerAgentId: 'ungrouped_operator' }),
    denied,
    'an ungrouped cross-workspace operator cannot mount a realm member workspace'
  );

  // ------------------------------------------------------------------------
  // Cross-realm-mapped workspace keys (ticket 2185224): resolving the mount
  // through the peer agent identity is not enough — the resolved workspace
  // key must also resolve inside the caller's scope.
  // ------------------------------------------------------------------------
  vfs.writeFile({ filePath: '/beta.md', content: 'beta private bytes' }, { callerAgentId: 'realm_b_member' });
  vfs.writeFile({ filePath: '/secret.md', content: 'custom beta private' }, { callerAgentId: 'realm_b_custom' });
  vfs.writeFile({ filePath: '/peer.md', content: 'alpha peer private' }, { callerAgentId: 'realm_a_peer' });

  for (const caller of ['realm_a_admin', 'ungrouped_operator']) {
    let mappedErr = null;
    try {
      vfs.readFile({ filePath: '/agents/realm_a_mapped/beta.md' }, { callerAgentId: caller });
    } catch (err) {
      mappedErr = err;
    }
    assert.ok(mappedErr instanceof PermissionDeniedError, `'${caller}' cannot mount a cross-realm-mapped agent key`);
    assert.ok(String(mappedErr.message).includes('realm_a_mapped'), 'the denial names the exact requested mount id');
    assert.equal(/realm:|realm_b_member/.test(String(mappedErr.message)), false, 'the denial never exposes the mapped physical key');
    assert.throws(
      () => vfs.readFile({ filePath: '/agents/realm_a_mapped_custom/secret.md' }, { callerAgentId: caller }),
      denied,
      `'${caller}' cannot mount a cross-realm-mapped custom-workspace key`
    );
  }

  // Same-scope resolved keys stay readable (no over-blocking): the custom
  // workspace key that resolves to no agent, and a key aliasing a same-realm
  // peer's workspace.
  assert.equal(
    vfs.readFile({ filePath: '/agents/realm_a_alias/peer.md' }, { callerAgentId: 'realm_a_admin', raw: true }),
    'alpha peer private',
    'a same-realm resolved key stays mountable'
  );

  // Observation side (ticket 2185224): a cross-realm-mapped key is never
  // listed, even after a denied mount attempt recorded the pair.
  const scopedMounts = vfs.listFiles({ directory_path: '/agents' }, { callerAgentId: 'realm_a_admin' });
  const scopedNames = scopedMounts.map(item => item.name);
  assert.ok(scopedNames.includes('realm_a_custom'), 'the custom-workspace same-realm peer stays listed');
  assert.ok(scopedNames.includes('realm_a_alias'), 'the same-realm aliased key stays listed');
  assert.equal(scopedNames.includes('realm_a_mapped'), false, 'a cross-realm-mapped agent key is never listed');
  assert.equal(scopedNames.includes('realm_a_mapped_custom'), false, 'a cross-realm-mapped custom key is never listed');
  assert.equal(
    scopedMounts.find(item => item.name === 'realm_a_mapped'),
    undefined,
    'no child count or label leaks the mapped physical workspace'
  );
});

// ============================================================================
// 12. Director System Scope: Never Mount-Visible, Never Cross-Scope (d587e1e)
// ============================================================================

test('12. [d587e1e] the system scope is never mount-visible and cross-scope reach is denied for every caller', () => {
  const vfs = makeRealmVfs();

  // The director's private workspace (system scope) and one realm peer.
  vfs.writeFile({ filePath: '/board.md', content: 'director-private-board' }, { callerAgentId: 'director' });
  vfs.writeFile({ filePath: '/secret.md', content: 'alpha peer private' }, { callerAgentId: 'realm_a_peer' });
  vfs.writeFile({ filePath: '/u.md', content: 'ungrouped private' }, { callerAgentId: 'ungrouped_agent' });

  // The director reaches its own private workspace (self mount included).
  assert.equal(
    vfs.readFile({ filePath: '/agents/director/board.md' }, { callerAgentId: 'director', raw: true }),
    'director-private-board',
    'the director self mount resolves to its own private workspace'
  );

  // Every non-bypass caller is denied the director mount at observation and
  // access — the ungrouped privileged legacy root included (V20 A-F2).
  for (const caller of ['ungrouped_operator', 'ungrouped_agent', 'realm_a_admin', 'realm_a_member', 'realm_b_admin']) {
    assert.throws(
      () => vfs.readFile({ filePath: '/agents/director/board.md' }, { callerAgentId: caller }),
      denied,
      `'${caller}' cannot read the director private workspace`
    );
    assert.throws(
      () => vfs.writeFile({ filePath: '/agents/director/board.md', content: 'TAMPERED' }, { callerAgentId: caller }),
      denied,
      `'${caller}' cannot write the director private workspace`
    );
    assert.throws(
      () => vfs.listFiles({ directory_path: '/agents/director' }, { callerAgentId: caller }),
      denied,
      `'${caller}' cannot list the director private workspace`
    );
  }
  assert.equal(
    vfs.readFile({ filePath: '/board.md' }, { callerAgentId: 'director', raw: true }),
    'director-private-board',
    'the director private bytes survive every tamper attempt'
  );

  // `/agents` listings never include the director for a non-bypass caller.
  const alphaMounts = vfs.listFiles({ directory_path: '/agents' }, { callerAgentId: 'realm_a_admin' });
  assert.equal(alphaMounts.some(item => item.name === 'director'), false, 'a realm root never lists the system scope');
  const ungroupedMounts = vfs.listFiles({ directory_path: '/agents' }, { callerAgentId: 'ungrouped_operator' });
  assert.deepEqual(
    ungroupedMounts.map(item => item.name),
    ['ungrouped_agent'],
    'an ungrouped root lists same-scope mounts only — never the director or a realm member'
  );
  assert.throws(
    () => vfs.listFiles({ directory_path: '/agents' }, { callerAgentId: 'ungrouped_agent' }),
    denied,
    'an ordinary caller cannot enumerate mount targets'
  );

  // Cross-scope reach is denied at the mount boundary (V20 observation O-1):
  // the ungrouped privileged legacy root cannot mount a realm member.
  assert.throws(
    () => vfs.readFile({ filePath: '/agents/realm_a_peer/secret.md' }, { callerAgentId: 'ungrouped_operator' }),
    denied,
    'the ungrouped privileged legacy root cannot reach a realm private workspace'
  );

  // ...and at the explicit-workspace boundary: the `!isAdmin` legacy
  // exemption covers same-scope targets only (ticket d587e1e).
  assert.throws(
    () => vfs.readFile('/secret.md', { workspaceId: 'realm_a_peer', callerAgentId: 'ungrouped_operator' }),
    denied,
    'the ungrouped privileged exemption never selects a realm private workspace'
  );
  assert.throws(
    () => vfs.readFile('/secret.md', { workspaceId: 'realm:alpha:global', callerAgentId: 'ungrouped_operator' }),
    denied,
    'the ungrouped privileged exemption never selects a realm-global partition'
  );
  assert.equal(
    vfs.readFile('/u.md', { workspaceId: 'ungrouped_agent', callerAgentId: 'ungrouped_operator', raw: true }),
    'ungrouped private',
    'same-scope cross-workspace authority stays intact'
  );

  // The realmBypass director spans every scope one-way (system snoop intact).
  assert.equal(
    vfs.readFile({ filePath: '/agents/realm_a_peer/secret.md' }, { callerAgentId: 'director', raw: true }),
    'alpha peer private',
    'the system scope still spans realms'
  );
});

// ============================================================================
// 13. Realm-Local Identity Keying (Wave I, ticket d57cbc1)
// ============================================================================

/**
 * Canonical identity-key port mirroring the runtime producer (Wave I, ticket
 * d57cbc1): projections carry the `(realmId, agentId)` composite `key`,
 * `getAgentIdentity` honors the realm-exact/bypass resolution scopes, and
 * `listAgentIdentities` enumerates. Built from the real
 * `createAgentIdentityKey` helper so the test never duplicates the key format.
 */
const SAME_ID_PORT = (() => {
  const records = [
    { id: 'scout', realmId: 'alpha' },
    { id: 'scout', realmId: 'beta' },
    { id: 'root', realmId: 'alpha', authority: authorityFor('root') },
    { id: 'outrider', realmId: 'beta' },
    { id: 'envoy', realmId: 'alpha' },
    { id: 'envoy', realmId: 'beta' },
    { id: 'pioneer', realmId: 'alpha', workspaceId: 'custom_alpha_ws' }
  ];
  const projections = records.map((record) => Object.freeze({
    id: record.id,
    key: createAgentIdentityKey(record.realmId, record.id),
    privileged: false,
    allowedTools: [],
    realmId: record.realmId,
    realmBypass: false,
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    ...(record.authority ? { authority: record.authority } : {})
  }));
  const realmOf = (scope) => (typeof scope.realmId === 'string' && scope.realmId) ? scope.realmId : null;
  const realmExact = (scope) => Boolean(scope)
    && typeof scope === 'object'
    && scope.realmBypass !== true
    && Object.prototype.hasOwnProperty.call(scope, 'realmId');
  return Object.freeze({
    getAgentIdentity: (agentId, scope) => {
      if (!agentId || typeof agentId !== 'string') return null;
      if (realmExact(scope)) {
        const realmId = realmOf(scope);
        return projections.find((p) => p.id === agentId && (p.realmId || null) === realmId) || null;
      }
      const matches = projections.filter((p) => p.id === agentId);
      return matches.length === 1 ? matches[0] : null;
    },
    listAgentIdentities: (scope) => {
      if (realmExact(scope)) {
        const realmId = realmOf(scope);
        return projections.filter((p) => (p.realmId || null) === realmId);
      }
      return [...projections];
    }
  });
})();

/** Trusted object-first context identifying a same-id port subject by canonical key. */
function sameIdCaller(realmId, id) {
  return { callerAgentId: id, callerKey: createAgentIdentityKey(realmId, id) };
}

test('13. [d57cbc1] the same literal id in two realms owns two distinct private workspaces', () => {
  const vfs = new VirtualFS({ identityPort: SAME_ID_PORT, internalPrincipal: INTERNAL_PRINCIPAL });

  const alphaWrite = vfs.writeFile({ filePath: '/note.md', content: 'alpha-private' }, sameIdCaller('alpha', 'scout'));
  assert.equal(alphaWrite.success, true);
  assert.equal(alphaWrite.workspaceId, 'scout', 'the write receipt projects the bare id, never the canonical key');
  assert.equal(JSON.stringify(alphaWrite).includes('realm:'), false, 'the write receipt is canonical-key opaque');
  const betaWrite = vfs.writeFile({ filePath: '/note.md', content: 'beta-private' }, sameIdCaller('beta', 'scout'));
  assert.equal(betaWrite.workspaceId, 'scout');

  // Each realm's scout reads only its own bytes through the default private view.
  assert.equal(vfs.readFile({ filePath: '/note.md' }, { ...sameIdCaller('alpha', 'scout'), raw: true }), 'alpha-private');
  assert.equal(vfs.readFile({ filePath: '/note.md' }, { ...sameIdCaller('beta', 'scout'), raw: true }), 'beta-private');

  // Storage is realm-qualified: two partitions, never a shared bare-id key.
  const snapshot = vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.equal(snapshot['realm:alpha:scout']['/note.md'].content, 'alpha-private');
  assert.equal(snapshot['realm:beta:scout']['/note.md'].content, 'beta-private');
  assert.equal(snapshot.scout, undefined, 'no bare-id partition is created for the same-id pair');

  // Host enumeration through a realm-bound caller sees its own registration only.
  const alphaList = vfs.listWorkspaces(sameIdCaller('alpha', 'scout'));
  assert.ok(alphaList.includes('realm:alpha:scout'), "a realm caller enumerates its own canonical partition");
  assert.equal(alphaList.includes('realm:beta:scout'), false, "another realm's same-id partition is never enumerated");

  // Errors are canonical-key opaque too.
  let notFound = null;
  try {
    vfs.readFile({ filePath: '/missing.md' }, sameIdCaller('alpha', 'scout'));
  } catch (err) {
    notFound = err;
  }
  assert.ok(notFound instanceof FileNotFoundError, 'a missing private file raises FileNotFoundError');
  assert.equal(String(notFound.message).includes('realm:'), false, 'the error message never carries the canonical key');
  assert.equal(JSON.stringify(notFound).includes('realm:'), false, 'the serialized error never carries the canonical key');
});

test('14. [d57cbc1] mounts and bare refs resolve per realm scope; foreign ids deny without an oracle', () => {
  const vfs = new VirtualFS({ identityPort: SAME_ID_PORT, internalPrincipal: INTERNAL_PRINCIPAL });
  vfs.writeFile({ filePath: '/note.md', content: 'alpha-private' }, sameIdCaller('alpha', 'scout'));
  vfs.writeFile({ filePath: '/note.md', content: 'beta-private' }, sameIdCaller('beta', 'scout'));
  vfs.writeFile({ filePath: '/oa.md', content: 'alpha-envoy' }, sameIdCaller('alpha', 'envoy'));
  vfs.writeFile({ filePath: '/op.md', content: 'alpha-pioneer' }, sameIdCaller('alpha', 'pioneer'));
  vfs.writeFile({ filePath: '/ob.md', content: 'beta-envoy' }, sameIdCaller('beta', 'envoy'));

  // A same-realm root resolves the bare id to ITS realm's scout — the beta
  // scout with the same literal id is never selected.
  assert.equal(
    vfs.readFile({ filePath: '/agents/scout/note.md' }, { ...sameIdCaller('alpha', 'root'), raw: true }),
    'alpha-private',
    "a same-realm root mount resolves the caller realm's same-id registration"
  );
  assert.notEqual(
    vfs.readFile({ filePath: '/agents/envoy/oa.md' }, { ...sameIdCaller('alpha', 'root'), raw: true }),
    'beta-envoy',
    "the caller realm's envoy bytes are read, never the other realm's"
  );

  // A foreign bare id is not-found — the denial names the requested id only.
  let foreignErr = null;
  try {
    vfs.readFile({ filePath: '/agents/outrider/ob.md' }, sameIdCaller('alpha', 'root'));
  } catch (err) {
    foreignErr = err;
  }
  assert.ok(foreignErr instanceof PermissionDeniedError, 'a foreign-realm mount is denied');
  assert.ok(String(foreignErr.message).includes('outrider'), 'the denial names the requested mount id');
  assert.equal(/realm:|beta/.test(String(foreignErr.message)), false, 'the denial leaks neither realm key nor realm id');
  assert.throws(
    () => vfs.readFile('/note.md', { ...sameIdCaller('alpha', 'root'), workspaceId: 'outrider' }),
    denied,
    'an explicit foreign workspace reference is denied at the realm boundary'
  );

  // The pinned same-realm peer keeps its explicit workspace key and mounts by id.
  const pioneerSnapshot = vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.equal(pioneerSnapshot['custom_alpha_ws']['/op.md'].content, 'alpha-pioneer', 'an explicit pin is preserved verbatim');
  assert.equal(
    vfs.readFile({ filePath: '/agents/pioneer/op.md' }, { ...sameIdCaller('alpha', 'root'), raw: true }),
    'alpha-pioneer',
    'a pinned same-realm peer mounts by agent id'
  );

  // The /agents listing is realm-scoped, bare-id labelled, and key-opaque.
  const mounts = vfs.listFiles({ directory_path: '/agents' }, sameIdCaller('alpha', 'root'));
  const names = mounts.map((item) => item.name);
  for (const expected of ['scout', 'envoy', 'pioneer']) {
    assert.ok(names.includes(expected), `a same-realm mount target '${expected}' is listed`);
  }
  assert.equal(names.includes('outrider'), false, 'a foreign-realm peer is never listed');
  assert.equal(JSON.stringify(mounts).includes('realm:'), false, 'mount listings never expose canonical keys');
  assert.equal(JSON.stringify(mounts).includes('custom_alpha_ws'), false, 'mount listings never expose physical keys');

  // An unresolvable or conflicting canonical caller key fails the call closed.
  assert.throws(
    () => vfs.readFile({ filePath: '/note.md' }, { callerAgentId: 'scout', callerKey: 'realm:alpha:ghost' }),
    denied,
    'a canonical caller key that does not resolve fails closed'
  );
  assert.throws(
    () => vfs.readFile({ filePath: '/note.md' }, { callerAgentId: 'envoy', callerKey: createAgentIdentityKey('beta', 'scout') }),
    denied,
    'conflicting callerKey/bare-id claims fail closed'
  );
  // An ambiguous bare caller id (same literal id in two realms) cannot be
  // mapped to a realm without the canonical key: fail closed rather than
  // silently sharing the bare-id partition (Wave I, ticket d57cbc1).
  assert.throws(
    () => vfs.writeFile({ filePath: '/ambiguous.md', content: 'leak' }, { callerAgentId: 'scout' }),
    denied,
    'an ambiguous bare caller id without the canonical key fails closed'
  );
  assert.equal(
    vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL }).scout,
    undefined,
    'the ambiguous write never mints a bare-id partition'
  );
});

test('15. [d57cbc1] legacy bare-key private workspaces remap without data loss', () => {
  const vfs = new VirtualFS({ identityPort: SAME_ID_PORT, internalPrincipal: INTERNAL_PRINCIPAL });
  const record = (content, workspaceId) => ({
    path: '/legacy.md',
    workspaceId,
    content,
    size: content.length,
    updatedAt: 1,
    readOnly: false,
    owner: 'scout'
  });
  vfs.importSnapshot({
    scout: { '/legacy.md': record('legacy-alpha-bytes', 'scout') },
    'realm:beta:scout': { '/other.md': record('beta-canonical', 'realm:beta:scout') },
    global: { '/shared.md': record('shared', 'global') }
  }, { principal: INTERNAL_PRINCIPAL });

  const before = vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.ok(before.scout, 'legacy bare-key bytes hydrate verbatim');

  // Pure snapshot helper: only the legacy bare key whose projection is
  // realm-qualified remaps; canonical and reserved keys pass through.
  const pure = remapLegacyWorkspaceKeys(before, (bareId) => (
    bareId === 'scout' ? SAME_ID_PORT.getAgentIdentity('scout', { realmId: 'alpha' }) : null
  ));
  assert.deepEqual(pure.remapped.map((entry) => [entry.from, entry.to]), [['scout', 'realm:alpha:scout']]);
  assert.equal(pure.workspaces['realm:alpha:scout']['/legacy.md'].content, 'legacy-alpha-bytes');
  assert.equal(pure.workspaces.scout, undefined, 'the legacy key is renamed');
  assert.ok(pure.workspaces['realm:beta:scout'], 'an already-canonical key passes through');
  assert.ok(pure.workspaces.global, 'a reserved shared key passes through');

  // In-memory hydration seam: the same rename on the live instance, under the
  // operator principal, and every byte stays readable through the caller view.
  assert.throws(
    () => vfs.rekeyLegacyPrivateWorkspaces(() => null),
    denied,
    'the in-memory remap is tenant administration (default-deny)'
  );
  const report = vfs.rekeyLegacyPrivateWorkspaces(
    (bareId) => (bareId === 'scout' ? SAME_ID_PORT.getAgentIdentity('scout', { realmId: 'alpha' }) : null),
    { principal: INTERNAL_PRINCIPAL }
  );
  assert.deepEqual(report, [{ from: 'scout', to: 'realm:alpha:scout', mergedConflictPaths: [] }]);
  assert.equal(
    vfs.readFile({ filePath: '/legacy.md' }, { ...sameIdCaller('alpha', 'scout'), raw: true }),
    'legacy-alpha-bytes',
    'the remapped legacy bytes are readable through the canonical private view'
  );
  const after = vfs.exportSnapshot({ principal: INTERNAL_PRINCIPAL });
  assert.equal(after.scout, undefined, 'no bare-id partition survives the remap');
  assert.ok(after['realm:beta:scout'] && after.global, 'unrelated partitions are untouched');

  // Conflict merge: the canonical copy wins the duplicate path, every
  // non-conflicting legacy file is preserved, and the conflict is reported.
  const merged = remapLegacyWorkspaceKeys({
    scout: {
      '/legacy.md': record('old-legacy', 'scout'),
      '/only-legacy.md': { ...record('only-legacy', 'scout'), path: '/only-legacy.md' }
    },
    'realm:alpha:scout': { '/legacy.md': record('canonical-wins', 'realm:alpha:scout') }
  }, (bareId) => (bareId === 'scout' ? SAME_ID_PORT.getAgentIdentity('scout', { realmId: 'alpha' }) : null));
  assert.equal(merged.workspaces['realm:alpha:scout']['/legacy.md'].content, 'canonical-wins', 'the canonical copy wins a conflicting path');
  assert.equal(merged.workspaces['realm:alpha:scout']['/only-legacy.md'].content, 'only-legacy', 'non-conflicting legacy files are preserved');
  assert.deepEqual(merged.remapped[0].mergedConflictPaths, ['/legacy.md'], 'duplicate paths are reported');
});
