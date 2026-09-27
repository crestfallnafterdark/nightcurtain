/**
 * @file tests/unit/authority_editor_helpers_test.js
 * @description Operator authority editor helper tests (`authorityEditorHelpers.ts`,
 *   ticket 62d89b8; redesign d7131dc). Pure vocabulary/normalization/state rules
 *   over the seven authority ids: the display table (declaration order, classes,
 *   scope flags, one-line copy, the `warning` field on the three high-impact
 *   ids), the per-agent grant/scope projection read out of the store's
 *   `listAuthorityGrantDetails()` shape, the draft normalizer that mirrors the
 *   runtime `validateAuthorityScope` vocabulary (class-allowed keys, trim +
 *   dedupe, prototype-vocabulary refusal, all-default → `null`, empty list input
 *   = key absent, `fields` omitted when every declared token is selected, and
 *   the additive optional `field` hint on mapped failures), and the
 *   `describeAuthorityScopeSummary` chip/rail grammar (deterministic part order).
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
  describeAuthorityScopeSummary,
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

test('1. the editor table exposes all seven ids in declaration order with classes, scope flags, and short copy', () => {
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
  // copy byte-for-byte (the shortened hydration line moves both files at once;
  // the template line stays as-is).
  assert.deepStrictEqual(
    [byId.get(TEMPLATE), byId.get(HYDRATION)].map(({ authority, label, description }) => ({
      authority,
      label,
      description
    })),
    META_AUTHORITY_TOGGLES.map(({ authority, label, description }) => ({ authority, label, description }))
  );

  // The compact one-line copy from the approved design (no "Powerful:" prose).
  assert.strictEqual(byId.get(TEMPLATE).description, 'Import realm template bundles into the host catalog.');
  assert.strictEqual(byId.get(HYDRATION).description, 'Submit instance payloads for host review.');
  assert.strictEqual(byId.get(AGENT_INSPECT).description, 'Read other agents’ role, tools, and prompt.');
  assert.strictEqual(byId.get(AGENT_EDIT).description, 'Change other agents’ tools, policy, or prompt.');
  assert.strictEqual(byId.get(REALM_INSPECT).description, 'Read realm settings, attachments, and tool ceiling.');
  assert.strictEqual(byId.get(REALM_EDIT).description, 'Change realm settings, attachments, and tool ceiling.');
  assert.strictEqual(byId.get(EXTENSIONS).description, 'Attach extensions realm-wide for every member.');

  // The three high-impact ids carry the amber-warning copy; the rest do not.
  assert.strictEqual(
    byId.get(AGENT_EDIT).warning,
    'High impact — edits other agents’ tools and prompt.'
  );
  assert.strictEqual(
    byId.get(REALM_EDIT).warning,
    'High impact — changes the tools every member can reach.'
  );
  assert.strictEqual(
    byId.get(EXTENSIONS).warning,
    'High impact — target realm members gain these tools.'
  );
  for (const id of [TEMPLATE, HYDRATION, AGENT_INSPECT, REALM_INSPECT]) {
    assert.strictEqual(byId.get(id).warning, undefined, `${id} carries no high-impact warning`);
  }
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
    { scope: { targets: ['peer-one', 'peer-two'] }, error: '' },
    'ownSpawns:false is a no-op (the runtime matcher never honors it) and is dropped'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ targets: ['peer-one', 'peer-two'] }, AGENT_INSPECT),
    { scope: { targets: ['peer-one', 'peer-two'] }, error: '' },
    'an omitted ownSpawns flag stays omitted'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ realms: 'r2, r3', realmMembers: true, ownSpawns: false }, AGENT_INSPECT),
    { scope: { realms: ['r2', 'r3'], realmMembers: true }, error: '' },
    'a false ownSpawns alongside other selectors is dropped too (runtime-identical)'
  );
  assert.deepStrictEqual(
    normalizeAuthorityScopeDraft({ ownSpawns: false }, AGENT_INSPECT),
    { scope: null, error: '' },
    'a bare ownSpawns:false is the id default — the matcher treats false as absent, so it can never deny'
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

test('7. scope summaries follow the deterministic chip grammar for all seven ids', () => {
  const byId = togglesById();
  const summary = (id, scope) => describeAuthorityScopeSummary(byId.get(id), scope);

  // Publishing ids are unscoped and carry no chip; unknown ids speak nothing.
  assert.strictEqual(summary(TEMPLATE, null), '');
  assert.strictEqual(summary(HYDRATION, { targets: ['x'] }), '');
  assert.strictEqual(describeAuthorityScopeSummary(null, null), '');
  assert.strictEqual(describeAuthorityScopeSummary(undefined, null), '');
  assert.strictEqual(describeAuthorityScopeSummary({ authority: '@nope:authority' }, null), '');

  // Granted, default scope (`scope: null`): each id's documented default.
  assert.strictEqual(summary(AGENT_INSPECT, null), 'own spawns');
  assert.strictEqual(summary(AGENT_EDIT, null), 'own spawns');
  assert.strictEqual(summary(REALM_INSPECT, null), 'own realm');
  assert.strictEqual(summary(REALM_EDIT, null), 'own realm');
  assert.strictEqual(summary(EXTENSIONS, null), 'own realm');

  // Granted, narrowed — the three examples from the approved design.
  assert.strictEqual(
    summary(AGENT_EDIT, { targets: ['worker', 'coordinator'], fields: ['tools', 'prompt'] }),
    '2 agent targets · fields: tools, prompt'
  );
  assert.strictEqual(
    summary(REALM_EDIT, { targets: ['r1', 'r2'], fields: ['attachments', 'name'] }),
    '2 realm targets · fields: attachments, name'
  );
  assert.strictEqual(
    summary(EXTENSIONS, { targets: ['r1', 'r2', 'r3'] }),
    '3 realm targets'
  );

  // Reach selectors, realm bound, and the field-deny marker.
  assert.strictEqual(
    summary(AGENT_INSPECT, { targets: ['peer'], ownSpawns: true, realms: ['r2'] }),
    '1 agent targets · own spawns · 1 bound realms'
  );
  assert.strictEqual(
    summary(AGENT_INSPECT, { ownSpawns: false }),
    'own spawns',
    'ownSpawns:false is treated as absent — the runtime matcher never honors a bare deny'
  );
  assert.strictEqual(
    summary(AGENT_INSPECT, { targets: ['peer'], ownSpawns: false }),
    '1 agent targets',
    'the dropped no-op selector never claims “no spawns”'
  );
  assert.strictEqual(
    summary(AGENT_INSPECT, { realmMembers: true, realms: ['r1', 'r2'] }),
    'realm members · 2 bound realms'
  );
  assert.strictEqual(
    summary(AGENT_EDIT, { targets: ['peer'], realms: ['r1'], fields: [] }),
    '1 agent targets · 1 bound realms · field edits denied'
  );
  assert.strictEqual(summary(REALM_EDIT, { fields: [] }), 'own realm · field edits denied');

  // An explicit empty target list is a fail-closed deny, never the default.
  assert.strictEqual(summary(AGENT_INSPECT, { targets: [] }), '0 agent targets');
  assert.strictEqual(summary(REALM_INSPECT, { targets: [] }), '0 realm targets');

  // Deterministic part order: targets → own spawns → realm members → realm
  // bound → fields (field tokens render in declared vocabulary order).
  assert.strictEqual(
    summary(AGENT_EDIT, {
      fields: ['prompt', 'tools'],
      realms: ['r1'],
      realmMembers: true,
      ownSpawns: true,
      targets: ['a', 'b']
    }),
    '2 agent targets · own spawns · realm members · 1 bound realms · fields: tools, prompt'
  );

  // A selector-free scope object collapses to the id's default reach.
  assert.strictEqual(summary(AGENT_INSPECT, {}), 'own spawns');
  assert.strictEqual(summary(REALM_INSPECT, {}), 'own realm');
});

test('8. normalization failures carry the additive optional field hint where a control maps', () => {
  const targetsError = normalizeAuthorityScopeDraft({ targets: 'ok, __proto__' }, AGENT_INSPECT);
  assert.strictEqual(targetsError.error.length > 0, true);
  assert.strictEqual(targetsError.field, 'targets');

  assert.strictEqual(
    normalizeAuthorityScopeDraft({ targets: ['ok', 7] }, AGENT_INSPECT).field,
    'targets'
  );
  assert.strictEqual(
    normalizeAuthorityScopeDraft({ realms: ['ok', 7] }, AGENT_INSPECT).field,
    'realms'
  );
  assert.strictEqual(
    normalizeAuthorityScopeDraft({ fields: ['nope'] }, AGENT_EDIT).field,
    'fields'
  );
  assert.strictEqual(
    normalizeAuthorityScopeDraft({ targets: 'x' }, TEMPLATE).field,
    'targets',
    'a class-invalid rendered key still maps to its control'
  );
  assert.strictEqual(
    normalizeAuthorityScopeDraft({ realms: 'r1' }, REALM_EDIT).field,
    'realms'
  );

  // Unmapped failure classes carry no hint at all (never a fabricated control).
  assert.strictEqual(
    normalizeAuthorityScopeDraft({ ownSpawns: 'yes' }, AGENT_INSPECT).field,
    undefined
  );
  assert.strictEqual(normalizeAuthorityScopeDraft([], AGENT_INSPECT).field, undefined);
  assert.strictEqual(
    normalizeAuthorityScopeDraft({ targets: 'x' }, '@nope:authority').field,
    undefined
  );
  assert.strictEqual(
    'field' in normalizeAuthorityScopeDraft({ targets: 'peer' }, AGENT_INSPECT),
    false,
    'successful results stay exactly `{ scope, error }`'
  );
});
