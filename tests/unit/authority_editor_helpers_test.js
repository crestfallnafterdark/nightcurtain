/**
 * @file tests/unit/authority_editor_helpers_test.js
 * @description Operator authority editor helper tests (`authorityEditorHelpers.ts`,
 *   ticket 62d89b8). Pure vocabulary/normalization/state rules over the seven
 *   authority ids: the display table (declaration order, classes, scope flags,
 *   power copy), the per-agent grant/scope projection read out of the store's
 *   `listAuthorityGrantDetails()` shape, and the draft normalizer that mirrors
 *   the runtime `validateAuthorityScope` vocabulary (class-allowed keys, trim +
 *   dedupe, prototype-vocabulary refusal, all-default → `null`, empty list input
 *   = key absent, `fields` omitted when every declared token is selected).
 *
 *   Zero-Mock: these are the real helper exports; the grant/revoke seam is
 *   exercised against a real `sandboxStore` in
 *   `authority_editor_store_test.js`.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTHORITY_EDITOR_TOGGLES,
  buildAuthorityEditorState,
  normalizeAuthorityScopeDraft
} from '../../src/lib/components/sandbox/authorityEditorHelpers.ts';
import { META_AUTHORITY_TOGGLES } from '../../src/lib/components/sandbox/realmReviewHelpers.ts';
import {
  AGENT_AUTHORITIES,
  AUTHORITY_IDS,
  AUTHORITY_SCOPE_FIELDS
} from '../../src/lib/sandbox/realmCatalog/index.ts';

const AGENT_INSPECT = AGENT_AUTHORITIES.AGENT_INSPECT;
const AGENT_EDIT = AGENT_AUTHORITIES.AGENT_EDIT;
const REALM_INSPECT = AGENT_AUTHORITIES.REALM_INSPECT;
const REALM_EDIT = AGENT_AUTHORITIES.REALM_EDIT;
const EXTENSIONS = AGENT_AUTHORITIES.EXTENSIONS;
const TEMPLATE = AGENT_AUTHORITIES.TEMPLATE;
const HYDRATION = AGENT_AUTHORITIES.HYDRATION;

/** @returns {Map<string, object>} Toggle definitions by authority id. */
function togglesById() {
  return new Map(AUTHORITY_EDITOR_TOGGLES.map((toggle) => [toggle.authority, toggle]));
}

test('1. the editor table exposes all seven ids in declaration order with classes, scope flags, and power copy', () => {
  assert.deepStrictEqual(
    AUTHORITY_EDITOR_TOGGLES.map((toggle) => toggle.authority),
    [...AUTHORITY_IDS],
    'every authority id is in editor declaration order'
  );
  const byId = togglesById();
  assert.strictEqual(byId.get(TEMPLATE).class, 'publishing');
  assert.strictEqual(byId.get(HYDRATION).class, 'publishing');
  assert.strictEqual(byId.get(AGENT_INSPECT).class, 'agent');
  assert.strictEqual(byId.get(AGENT_EDIT).class, 'agent');
  assert.strictEqual(byId.get(REALM_INSPECT).class, 'realm');
  assert.strictEqual(byId.get(REALM_EDIT).class, 'realm');
  assert.strictEqual(byId.get(EXTENSIONS).class, 'extensions');
  assert.strictEqual(byId.get(TEMPLATE).scoped, false);
  assert.strictEqual(byId.get(HYDRATION).scoped, false);
  for (const id of [AGENT_INSPECT, AGENT_EDIT, REALM_INSPECT, REALM_EDIT, EXTENSIONS]) {
    assert.strictEqual(byId.get(id).scoped, true, `${id} is scope-editable`);
  }
  for (const toggle of AUTHORITY_EDITOR_TOGGLES) {
    assert.ok(toggle.label.trim().length > 0, `${toggle.authority} carries a label`);
    assert.ok(toggle.description.trim().length > 0, `${toggle.authority} carries a description`);
  }

  // The publishing pair keeps the source-compatible `META_AUTHORITY_TOGGLES`
  // copy byte-for-byte, so the existing subsection is untouched by this table.
  assert.deepStrictEqual(
    [byId.get(TEMPLATE), byId.get(HYDRATION)].map(({ authority, label, description }) => ({
      authority,
      label,
      description
    })),
    META_AUTHORITY_TOGGLES.map(({ authority, label, description }) => ({ authority, label, description }))
  );

  // Power warnings name the concrete reach of the dangerous ids.
  assert.match(byId.get(AGENT_EDIT).description, /tools, privilege, policy, and prompt/);
  assert.match(byId.get(REALM_EDIT).description, /attachments/);
  assert.match(byId.get(REALM_EDIT).description, /ceiling/);
  assert.match(byId.get(EXTENSIONS).description, /realm-wide/);
});

test('2. buildAuthorityEditorState projects the live grant/scope listing per id', () => {
  const key = 'realm:r1:agent-a';
  const details = {
    [AGENT_INSPECT]: [
      { ref: 'realm:r1:other', scope: { targets: ['other'] } },
      { ref: key, scope: { targets: ['peer'], ownSpawns: false } }
    ],
    [REALM_EDIT]: [key],
    [AGENT_EDIT]: [{ ref: key, scope: 'malformed' }]
  };
  const state = buildAuthorityEditorState(details, key);
  assert.deepStrictEqual(
    Object.keys(state).sort(),
    [...AUTHORITY_IDS].sort(),
    'every id reads back (ungranted ids included)'
  );
  assert.deepStrictEqual(state[AGENT_INSPECT], {
    enabled: true,
    scope: { targets: ['peer'], ownSpawns: false }
  });
  assert.deepStrictEqual(state[REALM_EDIT], { enabled: true, scope: null }, 'a legacy bare-string entry is enabled/unscoped');
  assert.deepStrictEqual(
    state[AGENT_EDIT],
    { enabled: true, scope: null },
    'a malformed scope reads as the id default, not a fake narrowing'
  );
  for (const id of [TEMPLATE, HYDRATION, REALM_INSPECT, EXTENSIONS]) {
    assert.deepStrictEqual(state[id], { enabled: false, scope: null }, `${id} is ungranted`);
  }
  assert.ok(Object.isFrozen(state), 'the projection is frozen');
  assert.ok(Object.isFrozen(state[AGENT_INSPECT]), 'each entry is frozen');

  // Malformed listings read as ungranted everywhere.
  for (const malformed of [null, undefined, 'nope', 42, []]) {
    const empty = buildAuthorityEditorState(malformed, key);
    for (const id of AUTHORITY_IDS) {
      assert.deepStrictEqual(empty[id], { enabled: false, scope: null }, `${id} stays ungranted for malformed input`);
    }
  }
  assert.deepStrictEqual(
    buildAuthorityEditorState({ [AGENT_INSPECT]: 'not-a-list' }, key)[AGENT_INSPECT],
    { enabled: false, scope: null }
  );
  assert.deepStrictEqual(
    buildAuthorityEditorState({ [AGENT_INSPECT]: [{ ref: key, scope: null }] }, '')[AGENT_INSPECT],
    { enabled: false, scope: null },
    'an unresolved agent key never matches'
  );
  assert.deepStrictEqual(
    buildAuthorityEditorState({ [AGENT_INSPECT]: [{ ref: 'realm:r2:agent-a', scope: null }] }, key)[AGENT_INSPECT],
    { enabled: false, scope: null },
    'a same-literal agent in another realm never matches'
  );
});

test('3. normalization: agent-class drafts trim, dedupe, and drop class-invalid input', () => {
  assert.deepStrictEqual(normalizeAuthorityScopeDraft(null, AGENT_INSPECT), { scope: null, error: '' });
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft(
      { targets: '', realms: '', ownSpawns: true, realmMembers: false },
      AGENT_INSPECT
    ),
    { scope: null, error: '' },
    'the all-default agent draft normalizes to the unscoped default'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: ' peer-one, peer-two\npeer-one ', ownSpawns: true }, AGENT_INSPECT),
    { scope: { targets: ['peer-one', 'peer-two'], ownSpawns: true }, error: '' },
    'targets trim + dedupe and preserve first-seen order; checked ownSpawns stays explicit alongside a selector'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: 'peer-one, peer-two', ownSpawns: false }, AGENT_INSPECT),
    { scope: { targets: ['peer-one', 'peer-two'], ownSpawns: false }, error: '' }
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: ['peer-one', 'peer-two'] }, AGENT_INSPECT),
    { scope: { targets: ['peer-one', 'peer-two'] }, error: '' },
    'an omitted ownSpawns flag stays omitted'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ realms: 'r2, r3', realmMembers: true, ownSpawns: false }, AGENT_INSPECT),
    { scope: { realms: ['r2', 'r3'], realmMembers: true, ownSpawns: false }, error: '' }
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ ownSpawns: false }, AGENT_INSPECT),
    { scope: { ownSpawns: false }, error: '' },
    'an explicit ownSpawns:false draft is not the default'
  );

  const proto = normalizeAuthorityScopeDraft({ targets: 'ok, __proto__' }, AGENT_INSPECT);
  assert.strictEqual(proto.scope, null);
  assert.match(proto.error, /reserved prototype vocabulary/);
  for (const bad of [42, { targets: 42 }, { targets: ['ok', 7] }, { ownSpawns: 'yes' }, { realmMembers: 1 }, { realms: 42 }]) {
    const result = normalizeAuthorityScopeDraft(bad, AGENT_INSPECT);
    assert.strictEqual(result.scope, null, `${JSON.stringify(bad)} rejects`);
    assert.ok(result.error.length > 0, `${JSON.stringify(bad)} carries an operator-readable error`);
  }
  assert.match(
    normalizeAuthorityScopeDraft({ ownSpawns: true }, REALM_INSPECT).error,
    /not available for @realm:inspect/,
    'class-invalid keys reject instead of silently narrowing'
  );
  assert.match(
    normalizeAuthorityScopeDraft({ realms: 'r1' }, REALM_EDIT).error,
    /not available for @realm:edit/
  );
  assert.match(
    normalizeAuthorityScopeDraft({ targets: 'r1' }, '@nope:authority').error,
    /Unknown authority id/
  );
  assert.match(
    normalizeAuthorityScopeDraft([], AGENT_INSPECT).error,
    /plain object/
  );
});

test('4. normalization: field tokens follow the declared vocabulary and omit the all-selected default', () => {
  const agentFields = [...AUTHORITY_SCOPE_FIELDS[AGENT_EDIT]];
  assert.deepStrictEqual(agentFields, ['tools', 'privilege', 'policy', 'prompt']);
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ fields: ['tools'] }, AGENT_EDIT),
    { scope: { fields: ['tools'] }, error: '' }
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ fields: ['prompt', 'tools'] }, AGENT_EDIT),
    { scope: { fields: ['tools', 'prompt'] }, error: '' },
    'selected tokens are stored in declared vocabulary order'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ fields: 'tools, policy, tools' }, AGENT_EDIT),
    { scope: { fields: ['tools', 'policy'] }, error: '' }
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ fields: agentFields }, AGENT_EDIT),
    { scope: null, error: '' },
    'selecting every declared token is the default scope'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ fields: [] }, AGENT_EDIT),
    { scope: { fields: [] }, error: '' },
    'clearing every token is an explicit fail-closed deny, not the default'
  );
  assert.match(
    normalizeAuthorityScopeDraft({ fields: ['nope'] }, AGENT_EDIT).error,
    /not a field token for @agent:edit/
  );
  assert.match(
    normalizeAuthorityScopeDraft({ fields: ['tools'] }, AGENT_INSPECT).error,
    /not available for @agent:inspect/,
    'ids without a declared field vocabulary reject a fields key'
  );

  const realmFields = [...AUTHORITY_SCOPE_FIELDS[REALM_EDIT]];
  assert.deepStrictEqual(
    realmFields,
    ['attachments', 'ceiling', 'name', 'description', 'color']
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: 'r1', fields: ['color', 'name'] }, REALM_EDIT),
    { scope: { targets: ['r1'], fields: ['name', 'color'] }, error: '' }
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: 'r1', fields: realmFields }, REALM_EDIT),
    { scope: { targets: ['r1'] }, error: '' },
    'all declared realm tokens collapse into the absent default while targets persists'
  );
});

test('5. normalization: realm-class and publishing-class drafts', () => {
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: 'r1, r2' }, REALM_INSPECT),
    { scope: { targets: ['r1', 'r2'] }, error: '' }
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: '' }, REALM_INSPECT),
    { scope: null, error: '' },
    'an empty realm-id list means the own-realm default, never an explicit deny'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: 'r1' }, EXTENSIONS),
    { scope: { targets: ['r1'] }, error: '' }
  );
  assert.match(
    normalizeAuthorityScopeDraft({ fields: [] }, EXTENSIONS).error,
    /not available for @extensions:authority/
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({}, TEMPLATE),
    { scope: null, error: '' },
    'the publishing pair is unscoped-only'
  );
  assert.match(
    normalizeAuthorityScopeDraft({ targets: 'x' }, TEMPLATE).error,
    /not available for @template:authority/
  );
  assert.match(
    normalizeAuthorityScopeDraft({ ownSpawns: false }, HYDRATION).error,
    /not available for @hydration:authority/
  );
});

test('6. normalization freezes the built scope and its list arrays', () => {
  const result = normalizeAuthorityScopeDraft(
    { targets: 'peer', realms: 'r2', realmMembers: true, fields: ['tools'] },
    AGENT_EDIT
  );
  assert.strictEqual(result.error, '');
  assert.deepStrictEqual(result.scope, {
    targets: ['peer'],
    realms: ['r2'],
    realmMembers: true,
    fields: ['tools']
  });
  assert.ok(Object.isFrozen(result.scope), 'the scope record is frozen');
  assert.ok(Object.isFrozen(result.scope.targets), 'targets is frozen');
  assert.ok(Object.isFrozen(result.scope.realms), 'realms is frozen');
  assert.ok(Object.isFrozen(result.scope.fields), 'fields is frozen');
});
