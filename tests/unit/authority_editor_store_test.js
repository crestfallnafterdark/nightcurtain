/**
 * @file tests/unit/authority_editor_store_test.js
 * @description Operator authority editor wiring over a real `sandboxStore`
 *   (ticket 62d89b8; Zero-Mock). Exercises the additive host-only
 *   `listAuthorityGrantDetails()` projection together with the generic
 *   `applyAuthorityGrantToggle` seam: unscoped grant → normalized scoped
 *   re-grant (re-grant replaces the record) → live state projection → revoke,
 *   deep-frozen copies that cannot mutate registry state, and realm-exact
 *   resolution so a same-literal agent id in another Realm is never retargeted.
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAuthorityGrantToggle,
  buildAuthorityEditorState,
  normalizeAuthorityScopeDraft
} from '../../src/lib/components/sandbox/authorityEditorHelpers.ts';
import { createSandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import { AGENT_AUTHORITIES, DEMO_TEMPLATE } from '../../src/lib/sandbox/realmCatalog/index.ts';

const AGENT_INSPECT = AGENT_AUTHORITIES.AGENT_INSPECT;

test('1. the editor grants, projects, scopes, and revokes through a real store', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const receipt = await store.launchRealmFromTemplate(DEMO_TEMPLATE.id, { name: 'Editor Realm' });
    const member = receipt.agents[0];
    const realmId = receipt.realm.id;
    const agentKey = createAgentIdentityKey(realmId, member.id);

    // Unscoped grant through the generic toggle seam.
    const granted = await applyAuthorityGrantToggle(store, {
      agentId: member.id,
      authority: AGENT_INSPECT,
      enabled: true,
      scope: null,
      realmId
    });
    assert.deepStrictEqual(granted, { ok: true, error: '' });

    // The projection normalizes the legacy bare-string form to `scope: null`
    // and keys the entry by the canonical `(realmId, agentId)` identity.
    let details = store.listAuthorityGrantDetails();
    assert.deepStrictEqual(
      details[AGENT_INSPECT],
      [{ ref: agentKey, scope: null }],
      'an unscoped grant projects as a null scope, never a fabricated narrowing'
    );
    assert.deepStrictEqual(
      buildAuthorityEditorState(details, agentKey)[AGENT_INSPECT],
      { enabled: true, scope: null }
    );

    // Deep-frozen copies: mutating the projection must not reach the registry,
    // and the registry must not be writable through the returned scope.
    const entry = details[AGENT_INSPECT][0];
    assert.ok(Object.isFrozen(details), 'the listing record is frozen');
    assert.ok(Object.isFrozen(details[AGENT_INSPECT]), 'the per-id entry list is frozen');
    assert.ok(Object.isFrozen(entry), 'each detail entry is frozen');
    assert.throws(() => {
      entry.scope = { targets: ['evil'] };
    }, TypeError);
    assert.deepStrictEqual(store.listAuthorityGrantDetails()[AGENT_INSPECT], [{ ref: agentKey, scope: null }]);

    // A normalized scope draft re-grants with the exact registry-side narrowing
    // and replaces (never duplicates) the record for that id; the draft's
    // `ownSpawns:false` is a no-op the normalizer drops (runtime-identical).
    const normalized = normalizeAuthorityScopeDraft(
      { targets: 'peer-one, peer-two', realms: 'realm-remote', ownSpawns: false, realmMembers: true },
      AGENT_INSPECT
    );
    assert.strictEqual(normalized.error, '');
    const scoped = await applyAuthorityGrantToggle(store, {
      agentId: member.id,
      authority: AGENT_INSPECT,
      enabled: true,
      scope: normalized.scope,
      realmId
    });
    assert.deepStrictEqual(scoped, { ok: true, error: '' });

    details = store.listAuthorityGrantDetails();
    assert.strictEqual(details[AGENT_INSPECT].length, 1, 're-grant replaces the record for that id');
    assert.deepStrictEqual(details[AGENT_INSPECT][0], {
      ref: agentKey,
      scope: {
        targets: ['peer-one', 'peer-two'],
        realms: ['realm-remote'],
        realmMembers: true
      }
    });
    const scopedEntry = details[AGENT_INSPECT][0];
    assert.ok(Object.isFrozen(scopedEntry.scope), 'the projected scope is frozen');
    assert.ok(Object.isFrozen(scopedEntry.scope.targets), 'scopes arrays are deep-frozen copies');
    assert.throws(() => {
      scopedEntry.scope.targets.push('evil');
    }, TypeError);
    assert.deepStrictEqual(
      store.listAuthorityGrantDetails()[AGENT_INSPECT][0].scope.targets,
      ['peer-one', 'peer-two'],
      'the frozen copy never aliases registry state'
    );

    // Live state projection feeds the editor rows.
    details = store.listAuthorityGrantDetails();
    assert.deepStrictEqual(
      buildAuthorityEditorState(details, agentKey)[AGENT_INSPECT],
      {
        enabled: true,
        scope: {
          targets: ['peer-one', 'peer-two'],
          realms: ['realm-remote'],
          realmMembers: true
        }
      }
    );

    // Revoke closes the row and drops the id from the listing.
    const revoked = await applyAuthorityGrantToggle(store, {
      agentId: member.id,
      authority: AGENT_INSPECT,
      enabled: false,
      realmId
    });
    assert.deepStrictEqual(revoked, { ok: true, error: '' });
    details = store.listAuthorityGrantDetails();
    assert.strictEqual(details[AGENT_INSPECT], undefined, 'ids with no holder are omitted');
    assert.deepStrictEqual(
      buildAuthorityEditorState(details, agentKey)[AGENT_INSPECT],
      { enabled: false, scope: null }
    );

    // A fields-bearing edit scope round-trips verbatim.
    const editScope = normalizeAuthorityScopeDraft({ fields: ['tools', 'prompt'] }, AGENT_AUTHORITIES.AGENT_EDIT);
    assert.strictEqual(editScope.error, '');
    const editGrant = await applyAuthorityGrantToggle(store, {
      agentId: member.id,
      authority: AGENT_AUTHORITIES.AGENT_EDIT,
      enabled: true,
      scope: editScope.scope,
      realmId
    });
    assert.deepStrictEqual(editGrant, { ok: true, error: '' });
    assert.deepStrictEqual(
      store.listAuthorityGrantDetails()[AGENT_AUTHORITIES.AGENT_EDIT][0].scope,
      { fields: ['tools', 'prompt'] }
    );
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

test('2. the editor is realm-exact: a same-literal agent in another Realm is never retargeted', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const first = await store.launchRealmFromTemplate(DEMO_TEMPLATE.id, { name: 'Editor Realm One' });
    const second = await store.launchRealmFromTemplate(DEMO_TEMPLATE.id, { name: 'Editor Realm Two' });
    const memberId = first.agents[0].id;
    assert.strictEqual(second.agents[0].id, memberId, 'the fixture reuses the same literal agent id in both Realms');
    const firstKey = createAgentIdentityKey(first.realm.id, memberId);
    const secondKey = createAgentIdentityKey(second.realm.id, memberId);

    const firstGrant = await applyAuthorityGrantToggle(store, {
      agentId: memberId,
      authority: AGENT_INSPECT,
      enabled: true,
      scope: { targets: ['first-only'] },
      realmId: first.realm.id
    });
    assert.deepStrictEqual(firstGrant, { ok: true, error: '' });
    const secondGrant = await applyAuthorityGrantToggle(store, {
      agentId: memberId,
      authority: AGENT_INSPECT,
      enabled: true,
      scope: { realms: ['second-bound'] },
      realmId: second.realm.id
    });
    assert.deepStrictEqual(secondGrant, { ok: true, error: '' });

    let details = store.listAuthorityGrantDetails()[AGENT_INSPECT];
    assert.deepStrictEqual(
      details.map((entry) => entry.ref).sort(),
      [firstKey, secondKey].sort(),
      'each Realm holds its own realm-exact grant'
    );

    // Revoking in Realm One leaves Realm Two's grant and scope untouched.
    const revoked = await applyAuthorityGrantToggle(store, {
      agentId: memberId,
      authority: AGENT_INSPECT,
      enabled: false,
      realmId: first.realm.id
    });
    assert.deepStrictEqual(revoked, { ok: true, error: '' });
    details = store.listAuthorityGrantDetails()[AGENT_INSPECT];
    assert.deepStrictEqual(details, [{ ref: secondKey, scope: { realms: ['second-bound'] } }]);

    // Inline failure surfacing: unknown agent, unknown authority, and no host.
    const unknownAgent = await applyAuthorityGrantToggle(store, {
      agentId: 'ghost',
      authority: AGENT_INSPECT,
      enabled: true,
      realmId: first.realm.id
    });
    assert.strictEqual(unknownAgent.ok, false);
    assert.match(unknownAgent.error, /No active agent matched/);

    const unknownAuthority = await applyAuthorityGrantToggle(store, {
      agentId: memberId,
      authority: '@nope:authority',
      enabled: true,
      realmId: second.realm.id
    });
    assert.strictEqual(unknownAuthority.ok, false);
    assert.ok(unknownAuthority.error.length > 0, 'an unknown authority reports inline instead of minting anything');

    const noHost = await applyAuthorityGrantToggle(null, {
      agentId: memberId,
      authority: AGENT_INSPECT,
      enabled: true,
      realmId: second.realm.id
    });
    assert.strictEqual(noHost.ok, false);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});
