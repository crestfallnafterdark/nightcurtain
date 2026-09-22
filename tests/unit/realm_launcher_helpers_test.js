/**
 * @file tests/unit/realm_launcher_helpers_test.js
 * @description Wave B B3 (ticket b309e02): zero-mock unit tests for the Realm
 * launcher UI helpers (`realmLauncherHelpers.ts`) — the per-agent capability
 * preview projection built over the real `realmCatalog`, the preset-binding
 * display model over a real `presetCatalog`, seed file-row parsing and draft
 * validation, seed-target options, and the launch/seed error descriptions.
 * Wave C C4 (ticket f1eb48a) adds the v3 launch surface: input drafts
 * (defaults/defaultFile/reset/required presence semantics), `inputValues`
 * assembly and launch-draft validation, the compact seed summary, and the
 * composed-prompt preview built over the real `composeSystemPrompt`.
 * The parser rejects seed paths addressing the reserved `global`/`public`
 * workspace roots (V18 F-V18-1) so the UI fails inline instead of letting the
 * legacy VirtualFS prefix routing divert the write, and the duplicate-name
 * guard (`isRealmNameTaken`) is shared by the launcher wizard and the Realm
 * manager create form (V18 F-V18-3).
 * Wave T (ticket 2b5db57) adds the minimal review surface: origin-typed input
 * drafts (generated proposals stay editable), the read-only baked-history
 * preview built over the real `composeAgentHistory`, and the read-only seed
 * file-slot listing.
 * Wave U review completion (ticket 458e727) adds the completed review
 * projections from `realmReviewHelpers.ts`: per-part prompt provenance,
 * source-editable baked history, the files-dialog slot provenance, payload
 * assembly/validation against the effective template version, declared
 * authority decisions with the trust override, the mandatory launch gate, the
 * preview disclosures, and the operator publishing-authority toggle state.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleRealmInputValues,
  buildRealmHistoryPreview,
  buildRealmInputDrafts,
  buildRealmPreviewProjection,
  buildRealmPromptPreview,
  buildRealmSeedSlotViews,
  buildRealmSeedSummary,
  buildSeedTargetOptions,
  describeRealmLaunchError,
  describeRealmPresetBinding,
  describeRealmSeedError,
  describeSeedWorkspace,
  isRealmInputEditable,
  isRealmNameTaken,
  parseSeedFileRows,
  resetRealmInputField,
  validateRealmInputDrafts,
  validateRealmLaunchDraft,
  validateSeedDraft
} from '../../src/lib/components/sandbox/realmLauncherHelpers.ts';
import {
  META_AUTHORITY_TOGGLES,
  assembleRealmAuthorityApprovals,
  assembleRealmReviewPackage,
  buildMetaAuthorityToggleState,
  buildRealmAgentDisclosureRows,
  buildRealmAuthorityDecisions,
  buildRealmAuthorityDecisionKey,
  buildRealmAuthorityReviewAgents,
  buildRealmHistoryEditorViews,
  buildRealmPartProvenanceViews,
  buildRealmPayloadFilename,
  buildRealmPendingPayloadViews,
  buildRealmReviewFileSlots,
  buildRealmReviewInputValues,
  describeRealmAuthorityTrust,
  describeRealmLaunchGate,
  parseRealmPayloadFileText,
  previewRealmReviewPackage,
  realmReviewSlotKey,
  resolveRealmReviewInputDisplay,
  serializeRealmPendingPayload
} from '../../src/lib/components/sandbox/realmReviewHelpers.ts';
import { formatRealmLaunchTimestamp } from '../../src/lib/components/sandbox/realmTemplateHelpers.ts';
import { DEMO_TEMPLATE, materializeTemplate, summarizeAgentCapabilities, templateBundleVersion } from '../../src/lib/sandbox/realmCatalog/index.ts';
import { createPresetCatalog } from '../../src/lib/sandbox/presetCatalog/index.ts';
import { MUTATING_TOOLS, READ_ONLY_TOOLS, SANDBOX_TOOLS } from '../../src/lib/sandbox/tools/constants/index.ts';

/**
 * Launch fixture with declared inputs (default, defaultFile, required) and a
 * per-target seed — the shapes the launcher form and preview must handle.
 */
const FIXTURE_TEMPLATE = {
  id: 'c4-fixture',
  name: 'C4 Fixture Realm',
  description: 'Inputs + seed fixture.',
  formatVersion: 1,
  inputs: [
    { id: 'directives', label: 'Directives', help: 'Optional launch directives.', default: 'Default directive.' },
    { id: 'lore', label: 'Lore', defaultFile: 'files/lore.md' },
    { id: 'mandate', label: 'Mandate', required: true, multiline: false }
  ],
  agents: [
    {
      key: 'lead',
      idPattern: 'c4-lead',
      name: 'Lead',
      role: 'lead',
      prompt: [
        { kind: 'file', path: 'prompts/lead.md' },
        { kind: 'input', inputId: 'directives' },
        { kind: 'input', inputId: 'lore' },
        { kind: 'input', inputId: 'mandate' },
        { kind: 'text', text: 'Tail.' }
      ],
      toolProfile: { preset: 'readonly' },
      privileged: false
    },
    {
      key: 'scribe',
      idPattern: 'c4-scribe',
      name: 'Scribe',
      role: 'scribe',
      prompt: [{ kind: 'text', text: 'Scribe protocol.' }],
      toolProfile: { preset: 'readonly' },
      privileged: false
    }
  ],
  seed: {
    files: [
      { path: 'notes/realm.md', target: 'realm', source: { inline: 'Realm-wide note.' } },
      { path: 'orders/one.md', target: { agent: 'lead' }, source: { file: 'files/order.md' } },
      { path: 'lore/world.md', target: { agent: 'scribe' }, source: { inline: 'World lore.' } }
    ],
    directive: { targetAgentKey: 'lead', text: 'Begin the seeded session.' }
  }
};

/** Bundle file bodies the fixture's prompt parts and seed sources resolve against. */
const FIXTURE_FILES = {
  'prompts/lead.md': 'Lead protocol body.',
  'files/lore.md': 'Bundle lore.',
  'files/order.md': 'Order one.'
};

/**
 * Builds a real preset catalog over an in-memory storage seam (the adapter is
 * the module's documented persistence port; no catalog behavior is mocked).
 *
 * @returns {import('../../src/lib/sandbox/presetCatalog/index.ts').PresetCatalog} Real catalog.
 */
function realCatalog() {
  const persisted = [];
  return createPresetCatalog({
    storage: {
      load: () => persisted,
      save: (presets) => {
        persisted.length = 0;
        persisted.push(...presets);
      }
    }
  });
}

test('1. the preview projection mirrors the real realmCatalog summaries in template order', () => {
  const projection = buildRealmPreviewProjection(DEMO_TEMPLATE);

  assert.strictEqual(projection.ok, true, 'the baked demo template must project');
  assert.strictEqual(projection.error, '');
  assert.deepStrictEqual(
    projection.rows.map((row) => row.key),
    DEMO_TEMPLATE.agents.map((spec) => spec.key),
    'preview rows follow template order'
  );
  assert.deepStrictEqual(
    projection.rows,
    DEMO_TEMPLATE.agents.map((spec) => summarizeAgentCapabilities(spec)),
    'the projection is the catalog summary, never a re-derived approximation'
  );
  assert.ok(projection.rows.every((row) => Object.isFrozen(row)), 'preview rows stay frozen');
  assert.deepStrictEqual(
    projection.rows.map((row) => row.idPattern),
    ['coordinator', 'worker'],
    'the preview carries the plain realm-opaque id patterns'
  );
  assert.ok(
    projection.rows.every((row) => !row.idPattern.includes('{')),
    'no preview row carries the retired {realm} placeholder'
  );
});

test('2. the privileged demo coordinator previews wildcard capability with full classification', () => {
  const coordinator = buildRealmPreviewProjection(DEMO_TEMPLATE).rows[0];

  assert.strictEqual(coordinator.privileged, true);
  assert.strictEqual(coordinator.wildcard, true);
  assert.strictEqual(coordinator.wildcardSource, 'privileged', 'privilege is the wildcard source');
  assert.deepStrictEqual(coordinator.grants, ['*']);
  assert.deepStrictEqual(
    coordinator.mutating,
    [...MUTATING_TOOLS],
    'wildcard capability reports the full canonical mutating vocabulary'
  );
  assert.deepStrictEqual(
    coordinator.readOnly,
    [...READ_ONLY_TOOLS],
    'wildcard capability reports the full canonical read-only vocabulary'
  );
  assert.strictEqual(coordinator.preset, 'manager');
});

test('3. the read-only demo worker previews a precise mutating/read-only partition', () => {
  const worker = buildRealmPreviewProjection(DEMO_TEMPLATE).rows[1];

  assert.strictEqual(worker.privileged, false);
  assert.strictEqual(worker.wildcard, false);
  assert.strictEqual(worker.wildcardSource, 'none');
  assert.strictEqual(worker.preset, 'readonly');
  assert.ok(worker.readOnly.includes(SANDBOX_TOOLS.READ_FILE), 'readonly grants read_file');
  assert.ok(worker.readOnly.includes(SANDBOX_TOOLS.GREP), 'readonly grants grep');
  assert.ok(worker.readOnly.includes(SANDBOX_TOOLS.WHOAMI), 'readonly grants whoami');
  assert.ok(
    worker.mutating.includes(SANDBOX_TOOLS.GET_INBOX),
    'mail consumption (get_inbox) is classified as mutating'
  );
  assert.ok(
    worker.mutating.includes(SANDBOX_TOOLS.READ_MESSAGE),
    'read_message mutates mailbox state and is classified as mutating'
  );

  // The partition is honest: no grant appears in both buckets, and the
  // non-wildcard grant list is exactly the union of the two buckets.
  const overlap = worker.mutating.filter((tool) => worker.readOnly.includes(tool));
  assert.deepStrictEqual(overlap, [], 'mutating and read-only buckets are disjoint');
  assert.deepStrictEqual(
    [...worker.readOnly, ...worker.mutating].sort(),
    [...worker.grants].sort(),
    'the buckets partition the effective grants'
  );
});

test('4. the preview projection fails closed instead of throwing', () => {
  const none = buildRealmPreviewProjection(null);
  assert.strictEqual(none.ok, false);
  assert.deepStrictEqual(none.rows, []);
  assert.match(none.error, /select a template/i);

  const malformed = buildRealmPreviewProjection({ id: 'x', name: 'X', description: '', agents: 'nope' });
  assert.strictEqual(malformed.ok, false, 'a malformed template must not project');
  assert.ok(malformed.error.length > 0);

  const invalidSpec = buildRealmPreviewProjection({
    id: 'x',
    name: 'X',
    description: '',
    agents: [{ ...DEMO_TEMPLATE.agents[0], privileged: 'yes' }]
  });
  assert.strictEqual(invalidSpec.ok, false, 'an invalid agent spec must not project');
  assert.ok(invalidSpec.error.length > 0);

  const retiredPlaceholder = buildRealmPreviewProjection({
    id: 'x',
    name: 'X',
    description: '',
    agents: [{ ...DEMO_TEMPLATE.agents[0], idPattern: '{realm}-coordinator' }]
  });
  assert.strictEqual(retiredPlaceholder.ok, false, 'a retired-placeholder pattern must not preview');
  assert.match(retiredPlaceholder.error, /retired/, 'the preview surfaces the retirement message inline');
});

test('5. the preset binding resolves declared, defaulted, and unknown ids against a real catalog', () => {
  const catalog = realCatalog();
  const presets = catalog.listPresets();
  const defaultId = catalog.createPresetSourcePort().getDefaultPresetId();
  const defaultPreset = catalog.getPreset(defaultId);

  assert.ok(defaultPreset, 'the real catalog always resolves a default preset');
  assert.ok(presets.length > 1, 'the seeded catalog has multiple presets');

  const declaredDefault = describeRealmPresetBinding(defaultId, presets, defaultId);
  assert.strictEqual(declaredDefault.known, true);
  assert.strictEqual(declaredDefault.isDefault, true);
  assert.strictEqual(declaredDefault.label, defaultPreset.name);

  const absent = describeRealmPresetBinding(undefined, presets, defaultId);
  assert.strictEqual(absent.id, defaultId, 'an absent binding falls back to the active default');
  assert.strictEqual(absent.isDefault, true);

  const override = presets.find((preset) => preset.id !== defaultId);
  const declaredOverride = describeRealmPresetBinding(override.id, presets, defaultId);
  assert.strictEqual(declaredOverride.id, override.id);
  assert.strictEqual(declaredOverride.label, override.name);
  assert.strictEqual(declaredOverride.isDefault, false, 'a non-default binding is not the active default');

  const unknown = describeRealmPresetBinding('preset_missing', presets, defaultId);
  assert.strictEqual(unknown.known, false, 'a declared id absent from the catalog must be flagged');
  assert.strictEqual(unknown.id, 'preset_missing');
  assert.match(unknown.label, /not in catalog/);

  const none = describeRealmPresetBinding(undefined, [], null);
  assert.strictEqual(none.id, null);
  assert.strictEqual(none.known, false);
  assert.strictEqual(none.isDefault, false);
  assert.match(none.label, /no preset available/i);

  const trimmed = describeRealmPresetBinding(`  ${defaultId}  `, presets, defaultId);
  assert.strictEqual(trimmed.id, defaultId, 'declared ids resolve after trimming');
});

test('6. seed target options put the realm-global workspace first and preserve member order', () => {
  const options = buildSeedTargetOptions(
    [
      { id: 'coordinator', name: 'Coordinator' },
      { id: 'worker', name: 'Worker' }
    ],
    'Demo Realm'
  );

  assert.deepStrictEqual(options, [
    { value: '', label: 'Realm-global workspace (Demo Realm)' },
    { value: 'coordinator', label: 'Coordinator (coordinator)' },
    { value: 'worker', label: 'Worker (worker)' }
  ]);
});

test('7. seed target options tolerate malformed members and a missing realm name', () => {
  const options = buildSeedTargetOptions(
    [null, { id: '   ' }, { id: 'member-1' }, { id: 'member-2', name: '   ' }, undefined],
    null
  );

  assert.deepStrictEqual(options, [
    { value: '', label: 'Realm-global workspace (default)' },
    { value: 'member-1', label: 'member-1 (member-1)' },
    { value: 'member-2', label: 'member-2 (member-2)' }
  ]);
});

test('8. parseSeedFileRows normalizes accepted paths and preserves content verbatim', () => {
  const parsed = parseSeedFileRows([
    { path: 'notes/brief.md', content: 'Brief' },
    { path: '/lore\\codex.json', content: '' },
    { path: '  /a/c.md  ', content: 'line1\nline2' }
  ]);

  assert.strictEqual(parsed.ok, true);
  assert.deepStrictEqual(parsed.files, [
    { path: '/notes/brief.md', content: 'Brief' },
    { path: '/lore/codex.json', content: '' },
    { path: '/a/c.md', content: 'line1\nline2' }
  ]);
});

test('9. parseSeedFileRows rejects malformed rows fail-closed', () => {
  const cases = [
    { name: 'non-array input', rows: null, pattern: /must be a list/i },
    { name: 'non-object row', rows: [42], pattern: /row 1/i },
    { name: 'blank path', rows: [{ path: '   ', content: 'x' }], pattern: /path is required/i },
    { name: 'null byte', rows: [{ path: 'a\0b.md', content: 'x' }], pattern: /null bytes/i },
    { name: 'traversal', rows: [{ path: '../secret.md', content: 'x' }], pattern: /\.\./ },
    { name: 'inner traversal', rows: [{ path: 'a/../secret.md', content: 'x' }], pattern: /\.\./ },
    { name: 'root path', rows: [{ path: '/', content: 'x' }], pattern: /workspace root/i },
    {
      name: 'duplicate normalized path',
      rows: [{ path: 'a.md', content: 'x' }, { path: '/a.md', content: 'y' }],
      pattern: /row 2: .*duplicates/i
    },
    { name: 'non-string content', rows: [{ path: 'a.md', content: 42 }], pattern: /content must be text/i }
  ];

  for (const scenario of cases) {
    const parsed = parseSeedFileRows(scenario.rows);
    assert.strictEqual(parsed.ok, false, `${scenario.name} must be rejected`);
    assert.match(parsed.error, scenario.pattern, `${scenario.name} carries the expected message`);
  }
});

test('10. validateSeedDraft accepts files-only and directive-to-member drafts', () => {
  const filesOnly = validateSeedDraft({
    rows: [{ path: 'notes/brief.md', content: 'Brief' }],
    directive: '',
    targetAgentId: ''
  });
  assert.strictEqual(filesOnly.ok, true);
  assert.deepStrictEqual(filesOnly.files, [{ path: '/notes/brief.md', content: 'Brief' }]);
  assert.strictEqual(filesOnly.directive, null, 'a blank directive counts as absent');
  assert.strictEqual(filesOnly.targetAgentId, null, 'the empty target means realm-global');

  const withDirective = validateSeedDraft({
    rows: [{ path: '/brief.md', content: 'Brief' }],
    directive: '  Begin the session.  ',
    targetAgentId: '  coordinator  '
  });
  assert.strictEqual(withDirective.ok, true);
  assert.strictEqual(withDirective.directive, '  Begin the session.  ', 'directive text is preserved verbatim');
  assert.strictEqual(withDirective.targetAgentId, 'coordinator', 'the target id is trimmed');

  const whitespaceDirective = validateSeedDraft({
    rows: [{ path: '/brief.md', content: '' }],
    directive: '   ',
    targetAgentId: 'member-1'
  });
  assert.strictEqual(whitespaceDirective.ok, true);
  assert.strictEqual(whitespaceDirective.directive, null);
});

test('11. validateSeedDraft rejects empty rows, missing directive targets, and malformed input', () => {
  const empty = validateSeedDraft({ rows: [] });
  assert.strictEqual(empty.ok, false);
  assert.match(empty.error, /at least one file row/i);

  const directiveGlobal = validateSeedDraft({
    rows: [{ path: 'a.md', content: 'x' }],
    directive: 'Do the thing.',
    targetAgentId: ''
  });
  assert.strictEqual(directiveGlobal.ok, false, 'a directive cannot target the realm-global workspace');
  assert.match(directiveGlobal.error, /member/i);

  const directiveNoTarget = validateSeedDraft({
    rows: [{ path: 'a.md', content: 'x' }],
    directive: 'Do the thing.'
  });
  assert.strictEqual(directiveNoTarget.ok, false);
  assert.match(directiveNoTarget.error, /member/i);

  const nonStringDirective = validateSeedDraft({
    rows: [{ path: 'a.md', content: 'x' }],
    directive: 42,
    targetAgentId: 'member-1'
  });
  assert.strictEqual(nonStringDirective.ok, false);
  assert.match(nonStringDirective.error, /must be text/i);

  const malformed = validateSeedDraft(null);
  assert.strictEqual(malformed.ok, false);
  assert.match(malformed.error, /malformed/i);

  const malformedRows = validateSeedDraft({ rows: [{ path: '', content: '' }] });
  assert.strictEqual(malformedRows.ok, false, 'row errors propagate from the parser');
});

test('12. validateRealmLaunchDraft enforces selection, name, and name uniqueness', () => {
  const templateIds = [DEMO_TEMPLATE.id];
  const realms = [{ name: 'Demo Realm' }, { name: '  Side Realm  ' }];

  const ok = validateRealmLaunchDraft({
    templateId: `  ${DEMO_TEMPLATE.id}  `,
    name: '  Story Realm  ',
    templateIds,
    realms
  });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.templateId, DEMO_TEMPLATE.id);
  assert.strictEqual(ok.name, 'Story Realm', 'the returned name is trimmed');

  const emptySelection = validateRealmLaunchDraft({ templateId: '', name: 'Story', templateIds, realms });
  assert.strictEqual(emptySelection.ok, false);
  assert.match(emptySelection.error, /choose a template/i);

  const unknownTemplate = validateRealmLaunchDraft({ templateId: 'gone', name: 'Story', templateIds, realms });
  assert.strictEqual(unknownTemplate.ok, false);
  assert.match(unknownTemplate.error, /no longer available/i);

  const blankName = validateRealmLaunchDraft({ templateId: DEMO_TEMPLATE.id, name: '   ', templateIds, realms });
  assert.strictEqual(blankName.ok, false);
  assert.match(blankName.error, /name is required/i);

  const duplicate = validateRealmLaunchDraft({
    templateId: DEMO_TEMPLATE.id,
    name: '  demo realm ',
    templateIds,
    realms
  });
  assert.strictEqual(duplicate.ok, false, 'duplicate realm names are rejected case-insensitively');
  assert.match(duplicate.error, /already exists/i);

  const malformed = validateRealmLaunchDraft(null);
  assert.strictEqual(malformed.ok, false);
});

test('13. describeRealmLaunchError surfaces the rollback report of a failed template launch', () => {
  const rolledBack = Object.assign(new Error('launchRealmFromTemplate failed at worker'), {
    code: 'ERR_STORE_REALM_LAUNCH_FAILED',
    realmId: 'realm_1',
    templateId: DEMO_TEMPLATE.id,
    failedAgentId: 'worker',
    rolledBack: true,
    terminatedMembers: ['coordinator', 'worker'],
    rollbackFailures: []
  });
  const text = describeRealmLaunchError(rolledBack);
  assert.match(text, /failed at worker/);
  assert.match(text, /No partial Realm remains \(2 rolled-back members\)/);

  const halfRolledBack = Object.assign(new Error('launch failed'), {
    code: 'ERR_STORE_REALM_LAUNCH_FAILED',
    rolledBack: false,
    terminatedMembers: [],
    rollbackFailures: ['realm record removal failed']
  });
  const halfText = describeRealmLaunchError(halfRolledBack);
  assert.match(halfText, /Rollback could not be confirmed/);
  assert.match(halfText, /realm record removal failed/);

  const denied = Object.assign(new Error('Permission denied: operator required'), { code: 'PERMISSION_DENIED' });
  assert.match(describeRealmLaunchError(denied), /operator \(Director\) principal is required/i);

  assert.strictEqual(describeRealmLaunchError(new Error('plain failure')), 'plain failure');
  assert.strictEqual(describeRealmLaunchError(null), 'Failed to launch the Realm.');
});

test('14. describeRealmSeedError reports partial writes instead of hiding them', () => {
  const partial = Object.assign(new Error('seedRealm: write failed'), {
    code: 'ERR_STORE_VFS_FAILED',
    writtenPaths: ['/notes/a.md', '/notes/b.md']
  });
  const partialText = describeRealmSeedError(partial);
  assert.match(partialText, /\/notes\/a\.md/);
  assert.match(partialText, /\/notes\/b\.md/);
  assert.match(partialText, /remaining rows were not written/i);

  const noneWritten = Object.assign(new Error('seedRealm: write failed'), {
    code: 'ERR_STORE_VFS_FAILED',
    writtenPaths: []
  });
  assert.match(describeRealmSeedError(noneWritten), /No files were written/);

  const denied = Object.assign(new Error('Permission denied: operator required'), { code: 'PERMISSION_DENIED' });
  assert.match(describeRealmSeedError(denied), /operator \(Director\) principal is required/i);

  assert.strictEqual(describeRealmSeedError('boom'), 'boom');
  assert.strictEqual(describeRealmSeedError(undefined), 'Failed to seed the Realm.');
});

test('15. describeSeedWorkspace labels the realm-global partition and member workspaces', () => {
  assert.match(describeSeedWorkspace('realm:r1:global', 'r1'), /Realm-global workspace/);
  assert.match(describeSeedWorkspace('coordinator', 'realm_1'), /member workspace "coordinator"/);
  assert.match(describeSeedWorkspace('', 'realm_1'), /unknown workspace/);
});

test('16. parseSeedFileRows rejects the reserved workspace prefixes instead of letting them reroute a seed (V18 F-V18-1)', () => {
  const rejected = [
    '/global/x.md',
    '/public/y.md',
    'global/x.md',
    '/global',
    '/public',
    '\\global\\x.md',
    '\\public\\y.md'
  ];
  for (const path of rejected) {
    const parsed = parseSeedFileRows([{ path, content: 'x' }]);
    assert.strictEqual(parsed.ok, false, `${JSON.stringify(path)} must be rejected`);
    assert.match(parsed.error, /reserved workspace/i, `${JSON.stringify(path)} carries the reserved-workspace message`);
  }

  const viaDraft = validateSeedDraft({ rows: [{ path: '/global/x.md', content: 'x' }] });
  assert.strictEqual(viaDraft.ok, false, 'the draft validator rejects the prefix through the parser');
  assert.match(viaDraft.error, /reserved workspace/i);

  // Near-misses stay legal: the guard is root-segment exact, never a string
  // prefix match on the normalized path.
  const nearMiss = parseSeedFileRows([
    { path: '/globalization/notes.md', content: 'x' },
    { path: '/publicist.md', content: 'y' }
  ]);
  assert.strictEqual(nearMiss.ok, true);
  assert.deepStrictEqual(nearMiss.files, [
    { path: '/globalization/notes.md', content: 'x' },
    { path: '/publicist.md', content: 'y' }
  ]);
});

test('17. isRealmNameTaken shares the launcher duplicate-name rule with the Realm manager create form (V18 F-V18-3)', () => {
  const realms = [{ name: 'Demo Realm' }, { name: '  Side Realm  ' }];

  assert.strictEqual(isRealmNameTaken('Demo Realm', realms), true);
  assert.strictEqual(isRealmNameTaken('  demo realm ', realms), true, 'comparison is trimmed and case-insensitive');
  assert.strictEqual(isRealmNameTaken('side REALM', realms), true);
  assert.strictEqual(isRealmNameTaken('Story Realm', realms), false);
  assert.strictEqual(isRealmNameTaken('', realms), false, 'a blank candidate belongs to the required-name check');
  assert.strictEqual(isRealmNameTaken(42, realms), false, 'non-string candidates never collide');
  assert.strictEqual(isRealmNameTaken('Demo Realm', []), false);
  assert.strictEqual(isRealmNameTaken('Demo Realm', null), false, 'malformed registry input never throws');
  assert.strictEqual(
    isRealmNameTaken('Demo Realm', [null, {}, { name: 42 }, { name: 'Demo Realm' }]),
    true,
    'malformed records are skipped, real collisions still match'
  );
});

// ============================================================================
// 18-21. Wave C v3 launcher inputs, seed summary, and composed prompt preview
// ============================================================================

test('18. input drafts prefill from defaults/defaultFile, reset, and assemble only edited fields', () => {
  const drafts = buildRealmInputDrafts(FIXTURE_TEMPLATE.inputs, FIXTURE_FILES);
  assert.deepStrictEqual(drafts.map((draft) => draft.id), ['directives', 'lore', 'mandate']);

  const [directives, lore, mandate] = drafts;
  assert.strictEqual(directives.value, 'Default directive.', 'a declared default prefills the field');
  assert.strictEqual(directives.dirty, false, 'prefilled fields start untouched');
  assert.strictEqual(directives.multiline, true, 'multiline defaults on');
  assert.strictEqual(lore.value, 'Bundle lore.', 'defaultFile resolves from the bundle files');
  assert.strictEqual(lore.defaultResolved, true);
  assert.strictEqual(mandate.value, '', 'a required input without a default starts empty');
  assert.strictEqual(mandate.required, true);
  assert.strictEqual(mandate.multiline, false, 'multiline:false renders a single-line field');
  assert.strictEqual(mandate.label, 'Mandate');

  assert.deepStrictEqual(assembleRealmInputValues(drafts), {}, 'untouched fields stay out of the payload');
  assert.deepStrictEqual(
    assembleRealmInputValues([{ ...directives, value: '', dirty: true }, lore]),
    { directives: '' },
    'an explicitly cleared field is present with an empty value'
  );
  const edited = drafts.map((draft) => draft.id === 'mandate' ? { ...draft, value: 'Do it.', dirty: true } : draft);
  assert.deepStrictEqual(assembleRealmInputValues(edited), { mandate: 'Do it.' });

  const reset = resetRealmInputField(
    { ...directives, value: 'Changed', dirty: true },
    FIXTURE_TEMPLATE.inputs[0],
    FIXTURE_FILES
  );
  assert.strictEqual(reset.value, 'Default directive.', 'reset restores the template default');
  assert.strictEqual(reset.dirty, false, 'reset restores untouched presence semantics');

  const unresolved = buildRealmInputDrafts(FIXTURE_TEMPLATE.inputs, {});
  assert.strictEqual(unresolved[1].value, '', 'a missing defaultFile prefill starts empty');
  assert.strictEqual(unresolved[1].defaultResolved, false, 'the unresolved prefill is flagged');
  const resolvedByReset = resetRealmInputField(unresolved[1], FIXTURE_TEMPLATE.inputs[1], FIXTURE_FILES);
  assert.strictEqual(resolvedByReset.value, 'Bundle lore.', 'reset re-resolves the defaultFile prefill');

  assert.deepStrictEqual(buildRealmInputDrafts(null, null), [], 'a template without inputs has no fields');
  assert.deepStrictEqual(
    buildRealmInputDrafts([null, { label: 'No id' }, { id: 'ok', label: 'Ok' }], null).map((draft) => draft.id),
    ['ok'],
    'malformed declarations are skipped'
  );
});

test('19. required inputs fail closed with inline field errors; launch draft carries inputValues', () => {
  const drafts = buildRealmInputDrafts(FIXTURE_TEMPLATE.inputs, FIXTURE_FILES);

  const missing = validateRealmInputDrafts(drafts);
  assert.strictEqual(missing.ok, false);
  assert.match(missing.fieldErrors.mandate, /required/);
  assert.deepStrictEqual(missing.inputValues, {}, 'untouched fields stay out of the payload');

  const filled = drafts.map((draft) => draft.id === 'mandate' ? { ...draft, value: 'M', dirty: true } : draft);
  const valid = validateRealmInputDrafts(filled);
  assert.strictEqual(valid.ok, true);
  assert.deepStrictEqual(valid.inputValues, { mandate: 'M' });

  const cleared = filled.map((draft) => draft.id === 'mandate' ? { ...draft, value: '   ', dirty: true } : draft);
  assert.strictEqual(validateRealmInputDrafts(cleared).ok, false, 'an explicit empty value blocks a required input');

  const untouchedDefault = validateRealmInputDrafts([
    { id: 'directives', label: 'Directives', required: true, value: 'Default directive.', dirty: false }
  ]);
  assert.strictEqual(untouchedDefault.ok, true, 'a required field with a non-empty default passes untouched');

  const blocked = validateRealmLaunchDraft({
    templateId: FIXTURE_TEMPLATE.id,
    name: 'Fixture Realm',
    templateIds: [FIXTURE_TEMPLATE.id],
    realms: [],
    inputDrafts: drafts
  });
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.error, /required/);
  assert.match(blocked.fieldErrors.mandate, /required/);

  const launched = validateRealmLaunchDraft({
    templateId: FIXTURE_TEMPLATE.id,
    name: 'Fixture Realm',
    templateIds: [FIXTURE_TEMPLATE.id],
    realms: [],
    inputDrafts: filled
  });
  assert.strictEqual(launched.ok, true);
  assert.deepStrictEqual(launched.inputValues, { mandate: 'M' });

  const malformed = validateRealmLaunchDraft({
    templateId: FIXTURE_TEMPLATE.id,
    name: 'Fixture Realm',
    templateIds: [FIXTURE_TEMPLATE.id],
    realms: [],
    inputDrafts: 'nope'
  });
  assert.strictEqual(malformed.ok, false);
  assert.match(malformed.error, /drafts are malformed/);

  const noInputs = validateRealmLaunchDraft({
    templateId: DEMO_TEMPLATE.id,
    name: 'Demo Copy',
    templateIds: [DEMO_TEMPLATE.id],
    realms: []
  });
  assert.strictEqual(noInputs.ok, true);
  assert.deepStrictEqual(noInputs.inputValues, {}, 'an input-less template assembles an empty payload');
});

test('20. the seed summary counts files, lists targets in order, and previews the directive', () => {
  const summary = buildRealmSeedSummary(FIXTURE_TEMPLATE);
  assert.strictEqual(summary.declaresSeed, true);
  assert.strictEqual(summary.fileCount, 3);
  assert.deepStrictEqual(
    summary.targetLabels,
    ['Realm-global workspace', 'Lead (lead)', 'Scribe (scribe)'],
    'distinct targets in first-appearance order'
  );
  assert.deepStrictEqual(summary.directive, {
    targetAgentKey: 'lead',
    targetLabel: 'Lead (lead)',
    preview: 'Begin the seeded session.'
  });

  assert.deepStrictEqual(buildRealmSeedSummary(DEMO_TEMPLATE), {
    declaresSeed: false,
    fileCount: 0,
    targetLabels: [],
    directive: null
  });
  assert.deepStrictEqual(buildRealmSeedSummary(null), {
    declaresSeed: false,
    fileCount: 0,
    targetLabels: [],
    directive: null
  });

  const longDirective = buildRealmSeedSummary({
    ...FIXTURE_TEMPLATE,
    seed: { ...FIXTURE_TEMPLATE.seed, directive: { targetAgentKey: 'lead', text: 'x'.repeat(200) } }
  });
  assert.strictEqual(longDirective.directive.preview.length, 121, 'the preview caps at 120 chars plus the ellipsis');
  assert.ok(longDirective.directive.preview.endsWith('…'));

  const unknownTarget = buildRealmSeedSummary({
    ...FIXTURE_TEMPLATE,
    seed: { files: [{ path: 'a.md', target: { agent: 'ghost' }, source: { inline: 'x' } }] }
  });
  assert.deepStrictEqual(unknownTarget.targetLabels, ['ghost'], 'an unknown target key falls back to the raw key');
});

test('21. the prompt preview matches the materialized system prompt and reports missing bundles inline', () => {
  const spec = FIXTURE_TEMPLATE.agents[0];
  const inputValues = { mandate: 'M' };
  const preview = buildRealmPromptPreview(spec.prompt, FIXTURE_TEMPLATE.inputs, {
    inputValues,
    bundleFiles: FIXTURE_FILES
  });

  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.bundleUnavailable, false);
  assert.strictEqual(preview.error, '');
  assert.strictEqual(
    preview.systemPrompt,
    'Lead protocol body.\n\nDefault directive.\n\nBundle lore.\n\nM\n\nTail.'
  );

  const plan = materializeTemplate(FIXTURE_TEMPLATE, {
    realmId: 'realm_c4',
    inputValues,
    bundleFiles: FIXTURE_FILES
  });
  assert.strictEqual(preview.systemPrompt, plan.agents[0].systemPrompt, 'the preview is the materialized prompt');
  assert.deepStrictEqual(preview.inputProvenance, plan.agents[0].inputProvenance);

  const emptyInput = buildRealmPromptPreview(
    [{ kind: 'text', text: 'A' }, { kind: 'input', inputId: 'directives' }],
    [{ id: 'directives', label: 'Directives' }],
    { inputValues: { directives: '   ' } }
  );
  assert.strictEqual(emptyInput.ok, true);
  assert.strictEqual(emptyInput.systemPrompt, 'A', 'an empty input contributes nothing');

  const missingBundle = buildRealmPromptPreview(spec.prompt, FIXTURE_TEMPLATE.inputs, {
    inputValues,
    bundleFiles: {}
  });
  assert.strictEqual(missingBundle.ok, false);
  assert.strictEqual(missingBundle.bundleUnavailable, true);
  assert.match(missingBundle.error, /not available/);
  assert.match(missingBundle.error, /prompts\/lead\.md/);

  const missingDefaultFile = buildRealmPromptPreview(
    [{ kind: 'input', inputId: 'lore' }],
    FIXTURE_TEMPLATE.inputs,
    { bundleFiles: {} }
  );
  assert.strictEqual(missingDefaultFile.bundleUnavailable, true, 'an unresolved defaultFile is a bundle state');
  assert.match(missingDefaultFile.error, /files\/lore\.md/);

  const requiredEmpty = buildRealmPromptPreview(spec.prompt, FIXTURE_TEMPLATE.inputs, {
    inputValues: { mandate: '' },
    bundleFiles: FIXTURE_FILES
  });
  assert.strictEqual(requiredEmpty.ok, false);
  assert.strictEqual(requiredEmpty.bundleUnavailable, false, 'a composition error is not a bundle state');
  assert.match(requiredEmpty.error, /required/);

  const malformed = buildRealmPromptPreview(null, null, null);
  assert.strictEqual(malformed.ok, false);
  assert.ok(malformed.error.length > 0, 'malformed input fails inline, never throws');
});

// ============================================================================
// 22-24. Wave T review surface: origin-typed inputs, baked history, file slots
// ============================================================================

/**
 * Review fixture (Wave T): a generated input with a hydration brief, a
 * required input, baked history referencing inputs and a bundle file, and
 * origin-typed seed slots — the shapes the minimal review surface must render.
 */
const REVIEW_TEMPLATE = {
  id: 't-review-fixture',
  name: 'Review Fixture',
  description: 'Generated inputs, baked history, and origin-typed seed slots.',
  formatVersion: 1,
  inputs: [
    { id: 'premise', label: 'Premise', origin: 'generated', brief: 'One falsifiable premise.', required: true },
    { id: 'tone', label: 'Tone', default: 'Noir.' },
    { id: 'lore', label: 'Lore', defaultFile: 'files/lore.md' }
  ],
  agents: [
    {
      key: 'narrator',
      idPattern: 't-review-narrator',
      name: 'Narrator',
      role: 'narrator',
      prompt: [
        { kind: 'file', path: 'prompts/narrator.md' },
        { kind: 'input', inputId: 'premise' },
        { kind: 'input', inputId: 'tone' },
        { kind: 'input', inputId: 'lore' }
      ],
      toolProfile: { preset: 'readonly' },
      privileged: false,
      history: [
        { role: 'assistant', content: [{ kind: 'input', inputId: 'premise' }, { kind: 'text', text: 'Rain on the window.' }] },
        { role: 'user', content: [{ kind: 'file', path: 'files/order.md' }, { kind: 'input', inputId: 'tone' }] },
        { role: 'assistant', content: [{ kind: 'input', inputId: 'lore' }] }
      ]
    }
  ],
  seed: {
    files: [
      { path: 'lore/world.md', target: 'realm', origin: 'generated', brief: 'World lore.' },
      { path: 'notes/tone.md', target: { agent: 'narrator' }, origin: 'user', brief: 'Tone notes.' },
      { path: 'rules/base.md', target: 'realm', origin: 'fixed', source: { inline: 'Fixed rules.' } },
      { path: 'rules/extra.md', target: 'realm', origin: 'fixed', source: { file: 'files/extra.md' } }
    ]
  }
};

/** Bundle file bodies the review fixture's prompt, history, and slot references resolve against. */
const REVIEW_FILES = {
  'prompts/narrator.md': 'Narrator protocol.',
  'files/order.md': 'Order body.',
  'files/lore.md': 'Bundle lore.',
  'files/extra.md': 'Extra rules.'
};

test('22. input drafts carry the declared origin and generated proposals stay editable', () => {
  const drafts = buildRealmInputDrafts(REVIEW_TEMPLATE.inputs, REVIEW_FILES);
  const [premise, tone, lore] = drafts;

  assert.strictEqual(premise.origin, 'generated');
  assert.strictEqual(premise.brief, 'One falsifiable premise.');
  assert.strictEqual(premise.required, true);
  assert.strictEqual(premise.value, '', 'a generated input carries no prefill');
  assert.strictEqual(premise.defaultResolved, true);
  assert.strictEqual(isRealmInputEditable(premise), true, 'a generated proposal stays reviewer-editable');
  assert.strictEqual(tone.origin, 'user');
  assert.strictEqual(tone.brief, '', 'a user input carries no hydration brief');
  assert.strictEqual(tone.value, 'Noir.');
  assert.strictEqual(lore.origin, 'user');
  assert.strictEqual(lore.value, 'Bundle lore.', 'defaultFile prefills resolve for user inputs');
  assert.strictEqual(isRealmInputEditable(lore), true);
  assert.strictEqual(isRealmInputEditable(null), false);
  assert.strictEqual(isRealmInputEditable({}), false, 'a malformed draft has no field to edit');

  // A generated input is a proposal: an edit travels explicitly, while the
  // untouched field stays out of the payload and blocks a required launch.
  const edited = drafts.map((draft) => draft.id === 'premise'
    ? { ...draft, value: 'Edited premise.', dirty: true }
    : draft);
  assert.deepStrictEqual(assembleRealmInputValues(edited), { premise: 'Edited premise.' });
  assert.deepStrictEqual(assembleRealmInputValues(drafts), {}, 'untouched generated inputs stay out of the payload');
  const blocked = validateRealmInputDrafts(drafts);
  assert.strictEqual(blocked.ok, false);
  assert.match(blocked.fieldErrors.premise, /required/);
  const valid = validateRealmInputDrafts(edited);
  assert.strictEqual(valid.ok, true);
  assert.deepStrictEqual(valid.inputValues, { premise: 'Edited premise.' });

  // Reset restores the declared origin metadata, not just the text.
  const reset = resetRealmInputField(edited[0], REVIEW_TEMPLATE.inputs[0], REVIEW_FILES);
  assert.strictEqual(reset.value, '');
  assert.strictEqual(reset.dirty, false);
  assert.strictEqual(reset.origin, 'generated');
  assert.strictEqual(reset.brief, 'One falsifiable premise.');

  // The fixture is a valid format-v1 template: the real catalog materializes it.
  const plan = materializeTemplate(REVIEW_TEMPLATE, {
    realmId: 'realm_review',
    inputValues: { premise: 'A premise.' },
    bundleFiles: REVIEW_FILES,
    hydrationFiles: [
      { path: 'lore/world.md', target: 'realm', content: 'Generated world lore.' },
      { path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'User tone notes.' }
    ]
  });
  assert.strictEqual(plan.agents[0].systemPrompt, 'Narrator protocol.\n\nA premise.\n\nNoir.\n\nBundle lore.');
});

test('23. the history preview composes role-tagged messages through the real catalog', () => {
  const spec = REVIEW_TEMPLATE.agents[0];
  const preview = buildRealmHistoryPreview(spec, REVIEW_TEMPLATE.inputs, {
    inputValues: { premise: 'A premise.' },
    bundleFiles: REVIEW_FILES
  });

  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.bundleUnavailable, false);
  assert.strictEqual(preview.error, '');
  assert.deepStrictEqual(preview.entries, [
    { role: 'assistant', roleLabel: 'Agent', content: 'A premise.\n\nRain on the window.' },
    { role: 'user', roleLabel: 'Operator', content: 'Order body.\n\nNoir.' },
    { role: 'assistant', roleLabel: 'Agent', content: 'Bundle lore.' }
  ]);

  const plan = materializeTemplate(REVIEW_TEMPLATE, {
    realmId: 'realm_review',
    inputValues: { premise: 'A premise.' },
    bundleFiles: REVIEW_FILES,
    hydrationFiles: [
      { path: 'lore/world.md', target: 'realm', content: 'Generated world lore.' },
      { path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'User tone notes.' }
    ]
  });
  assert.deepStrictEqual(
    preview.entries.map((entry) => ({ role: entry.role, content: entry.content })),
    plan.agents[0].history.map((message) => ({ role: message.role, content: message.content })),
    'the preview is exactly the history the launch seeds'
  );

  // Explicit review values win over declared defaults and defaultFile prefills.
  const overridden = buildRealmHistoryPreview(spec, REVIEW_TEMPLATE.inputs, {
    inputValues: { premise: 'P', tone: 'Launch tone', lore: 'Launch lore' },
    bundleFiles: REVIEW_FILES
  });
  assert.deepStrictEqual(overridden.entries.map((entry) => entry.content), [
    'P\n\nRain on the window.',
    'Order body.\n\nLaunch tone',
    'Launch lore'
  ]);

  // No declared history is a valid empty preview.
  const noHistory = buildRealmHistoryPreview({ ...spec, history: undefined }, REVIEW_TEMPLATE.inputs, {});
  assert.strictEqual(noHistory.ok, true);
  assert.deepStrictEqual(noHistory.entries, []);

  // Missing bundle entries are a bundle state, not a composition error.
  const missing = buildRealmHistoryPreview(spec, REVIEW_TEMPLATE.inputs, {
    inputValues: { premise: 'P' },
    bundleFiles: {}
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.bundleUnavailable, true);
  assert.match(missing.error, /files\/order\.md/);
  assert.match(missing.error, /files\/lore\.md/);

  // Undeclared input references fail closed with the catalog's own rule.
  const undeclared = buildRealmHistoryPreview(
    { ...spec, history: [{ role: 'assistant', content: [{ kind: 'input', inputId: 'ghost' }] }] },
    REVIEW_TEMPLATE.inputs,
    { bundleFiles: REVIEW_FILES }
  );
  assert.strictEqual(undeclared.ok, false);
  assert.match(undeclared.error, /undeclared input "ghost"/);

  // An entry that composes empty is rejected instead of previewed as empty.
  const empty = buildRealmHistoryPreview(
    { ...spec, history: [{ role: 'assistant', content: [{ kind: 'input', inputId: 'premise' }] }] },
    REVIEW_TEMPLATE.inputs,
    { inputValues: { premise: '   ' }, bundleFiles: REVIEW_FILES }
  );
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.bundleUnavailable, false);
  assert.match(empty.error, /composes empty/);

  const malformed = buildRealmHistoryPreview(null, null, null);
  assert.strictEqual(malformed.ok, false);
  assert.ok(malformed.error.length > 0, 'malformed input fails inline, never throws');
});

test('24. the seed slot list projects path, target, origin, and source labels', () => {
  const slots = buildRealmSeedSlotViews(REVIEW_TEMPLATE);

  assert.deepStrictEqual(
    slots.map((slot) => slot.path),
    ['lore/world.md', 'notes/tone.md', 'rules/base.md', 'rules/extra.md'],
    'slots render in declared order'
  );
  assert.deepStrictEqual(slots.map((slot) => slot.origin), ['generated', 'user', 'fixed', 'fixed']);
  assert.deepStrictEqual(slots.map((slot) => slot.targetKind), ['realm', 'agent', 'realm', 'realm']);
  assert.deepStrictEqual(slots.map((slot) => slot.targetLabel), [
    'Realm-global workspace',
    'Narrator (narrator)',
    'Realm-global workspace',
    'Realm-global workspace'
  ]);
  assert.strictEqual(slots[1].targetKey, 'narrator');
  assert.deepStrictEqual(slots.map((slot) => slot.sourceLabel), [
    'filled from the hydration package',
    'attached at launch',
    'inline bundle content',
    'bundle file files/extra.md'
  ]);
  assert.deepStrictEqual(slots.map((slot) => slot.brief), ['World lore.', 'Tone notes.', '', '']);

  assert.deepStrictEqual(buildRealmSeedSlotViews(DEMO_TEMPLATE), [], 'the demo template declares no seed');
  assert.deepStrictEqual(buildRealmSeedSlotViews(null), []);

  const malformed = buildRealmSeedSlotViews({
    ...REVIEW_TEMPLATE,
    seed: {
      files: [
        null,
        { path: '' },
        { path: 'ok.md', target: 'realm' },
        { path: 'x.md', target: { agent: 'ghost' }, origin: 'user' }
      ]
    }
  });
  assert.deepStrictEqual(malformed.map((slot) => slot.path), ['ok.md', 'x.md'], 'malformed slots are skipped');
  assert.strictEqual(malformed[0].origin, 'fixed', 'an absent origin defaults to fixed');
  assert.strictEqual(malformed[0].sourceLabel, 'bundle content', 'an absent fixed source is labeled honestly');
  assert.strictEqual(malformed[1].targetLabel, 'ghost', 'an unknown agent key falls back to the raw key');
});

// ============================================================================
// 25-33. Wave U review completion (ticket 458e727)
// ============================================================================

/** Input values the review fixture resolves against by default. */
const REVIEW_INPUT_VALUES = { premise: 'A premise.' };

/** Valid canonical hydration package for the review fixture's declared slots. */
function reviewPayload(templateVersion = templateBundleVersion({ template: REVIEW_TEMPLATE, files: REVIEW_FILES })) {
  return {
    formatVersion: 1,
    templateId: REVIEW_TEMPLATE.id,
    templateVersion,
    inputs: { premise: 'A premise.' },
    files: [
      { path: 'lore/world.md', target: 'realm', content: 'Generated world lore.' },
      { path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'User tone notes.' }
    ]
  };
}

test('25. prompt part provenance resolves each part with its origin and source editability', () => {
  const spec = REVIEW_TEMPLATE.agents[0];
  const view = buildRealmPartProvenanceViews(spec.prompt, REVIEW_TEMPLATE.inputs, {
    inputValues: REVIEW_INPUT_VALUES,
    bundleFiles: REVIEW_FILES
  });

  assert.strictEqual(view.ok, true);
  assert.strictEqual(view.bundleUnavailable, false);
  assert.deepStrictEqual(view.parts.map((part) => part.kind), ['file', 'input', 'input', 'input']);
  assert.deepStrictEqual(
    view.parts.map((part) => part.origin),
    ['fixed', 'generated', 'user', 'user'],
    'bundle files are fixed, inputs carry their declared origin'
  );
  assert.deepStrictEqual(
    view.parts.map((part) => part.editable),
    [false, true, true, true],
    'only input parts are editable (at their launch-value source)'
  );
  assert.strictEqual(view.parts[0].path, 'prompts/narrator.md');
  assert.strictEqual(view.parts[0].content, 'Narrator protocol.');
  assert.strictEqual(view.parts[1].content, 'A premise.');
  assert.strictEqual(view.parts[2].content, 'Noir.');
  assert.strictEqual(view.parts[3].content, 'Bundle lore.');
  assert.deepStrictEqual(
    view.parts[0].label,
    'bundle file prompts/narrator.md'
  );
  assert.strictEqual(view.parts[2].inputLabel, 'Tone');
  assert.strictEqual(view.parts[1].required, true, 'the generated premise is declared required');

  // The contributing parts are exactly the catalog-composed prompt.
  const composed = buildRealmPromptPreview(spec.prompt, REVIEW_TEMPLATE.inputs, {
    inputValues: REVIEW_INPUT_VALUES,
    bundleFiles: REVIEW_FILES
  });
  assert.strictEqual(
    view.parts.filter((part) => !part.empty).map((part) => part.content).join('\n\n'),
    composed.systemPrompt,
    'the part views agree with the real composition'
  );

  // An empty input contributes nothing and stays visible.
  const emptyInput = buildRealmPartProvenanceViews(
    [{ kind: 'text', text: 'A' }, { kind: 'input', inputId: 'tone' }],
    REVIEW_TEMPLATE.inputs,
    { inputValues: { tone: '   ' }, bundleFiles: REVIEW_FILES }
  );
  assert.strictEqual(emptyInput.ok, true);
  assert.strictEqual(emptyInput.parts[1].empty, true);

  // Missing bundle entries are a bundle state, not a silent empty part.
  const missing = buildRealmPartProvenanceViews(spec.prompt, REVIEW_TEMPLATE.inputs, { bundleFiles: {} });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.bundleUnavailable, true);
  assert.match(missing.error, /prompts\/narrator\.md/);
  assert.deepStrictEqual(missing.parts, []);

  assert.deepStrictEqual(buildRealmPartProvenanceViews(null, null, null), {
    ok: true,
    parts: [],
    bundleUnavailable: false,
    error: ''
  });
});

test('26. the history editor composes through the real catalog and edits input-backed entries at source', () => {
  const spec = REVIEW_TEMPLATE.agents[0];
  const view = buildRealmHistoryEditorViews(spec, REVIEW_TEMPLATE.inputs, {
    inputValues: REVIEW_INPUT_VALUES,
    bundleFiles: REVIEW_FILES
  });

  assert.strictEqual(view.ok, true);
  assert.deepStrictEqual(view.entries.map((entry) => entry.role), ['assistant', 'user', 'assistant']);
  assert.deepStrictEqual(view.entries.map((entry) => entry.roleLabel), ['Agent', 'Operator', 'Agent']);
  assert.deepStrictEqual(view.entries.map((entry) => entry.content), [
    'A premise.\n\nRain on the window.',
    'Order body.\n\nNoir.',
    'Bundle lore.'
  ]);
  assert.deepStrictEqual(
    view.entries.map((entry) => entry.editable),
    [true, true, true],
    'every declared entry references an editable input in this fixture'
  );
  assert.deepStrictEqual(view.entries[0].inputIds, ['premise']);
  assert.deepStrictEqual(view.entries[0].parts.map((part) => part.origin), ['generated', 'fixed']);
  assert.deepStrictEqual(view.entries[0].parts.map((part) => part.editable), [true, false]);

  // The editor content is exactly what the launch seeds.
  const plan = materializeTemplate(REVIEW_TEMPLATE, {
    realmId: 'realm_review',
    inputValues: REVIEW_INPUT_VALUES,
    bundleFiles: REVIEW_FILES,
    hydrationFiles: [
      { path: 'lore/world.md', target: 'realm', content: 'Generated world lore.' },
      { path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'User tone notes.' }
    ]
  });
  assert.deepStrictEqual(
    view.entries.map((entry) => entry.content),
    plan.agents[0].history.map((message) => message.content),
    'review history equals the seeded history'
  );

  // Editing the referenced input changes the composed entry (source editing).
  const edited = buildRealmHistoryEditorViews(spec, REVIEW_TEMPLATE.inputs, {
    inputValues: { premise: 'Edited premise.' },
    bundleFiles: REVIEW_FILES
  });
  assert.strictEqual(edited.entries[0].content, 'Edited premise.\n\nRain on the window.');
  assert.strictEqual(edited.entries[0].parts[0].content, 'Edited premise.');

  // A fixed-only entry renders read-only.
  const fixed = buildRealmHistoryEditorViews(
    { ...spec, history: [{ role: 'assistant', content: [{ kind: 'text', text: 'Fixed opener.' }] }] },
    REVIEW_TEMPLATE.inputs,
    {}
  );
  assert.strictEqual(fixed.ok, true);
  assert.strictEqual(fixed.entries[0].editable, false);
  assert.strictEqual(fixed.entries[0].content, 'Fixed opener.');

  // Missing bundle entries and undeclared references fail closed inline.
  const missing = buildRealmHistoryEditorViews(spec, REVIEW_TEMPLATE.inputs, { bundleFiles: {} });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.bundleUnavailable, true);
  assert.match(missing.error, /files\/order\.md/);

  const undeclared = buildRealmHistoryEditorViews(
    { ...spec, history: [{ role: 'assistant', content: [{ kind: 'input', inputId: 'ghost' }] }] },
    REVIEW_TEMPLATE.inputs,
    {}
  );
  assert.strictEqual(undeclared.ok, false, 'the catalog rejects the undeclared reference');
  assert.match(undeclared.error, /undeclared input/);

  assert.deepStrictEqual(buildRealmHistoryEditorViews(null, null, null), {
    ok: true,
    entries: [],
    bundleUnavailable: false,
    error: ''
  });
  const noHistory = buildRealmHistoryEditorViews({ ...spec, history: undefined }, REVIEW_TEMPLATE.inputs, {});
  assert.strictEqual(noHistory.ok, true);
  assert.deepStrictEqual(noHistory.entries, []);
});

test('27. the files dialog resolves slot content and provenance per origin', () => {
  const payload = reviewPayload();
  const slots = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, { payload });

  assert.deepStrictEqual(
    slots.map((slot) => slot.path),
    ['lore/world.md', 'notes/tone.md', 'rules/base.md', 'rules/extra.md'],
    'slots render in declared order'
  );
  assert.deepStrictEqual(slots.map((slot) => slot.origin), ['generated', 'user', 'fixed', 'fixed']);
  assert.deepStrictEqual(
    slots.map((slot) => slot.contentSource),
    ['payload', 'payload', 'bundle-inline', 'bundle-file']
  );
  assert.deepStrictEqual(slots.map((slot) => slot.sourceLabel), [
    'attached payload',
    'attached payload',
    'inline bundle content',
    'bundle file files/extra.md'
  ]);
  assert.deepStrictEqual(slots.map((slot) => slot.editable), [true, true, false, false]);
  assert.deepStrictEqual(slots.map((slot) => slot.required), [true, false, false, false]);
  assert.strictEqual(slots[0].content, 'Generated world lore.');
  assert.strictEqual(slots[1].content, 'User tone notes.');
  assert.strictEqual(slots[2].content, 'Fixed rules.');
  assert.strictEqual(slots[3].content, 'Extra rules.');
  assert.strictEqual(slots[1].targetLabel, 'Narrator (narrator)');
  assert.strictEqual(slots[0].brief, 'World lore.');

  // Review edits win over the payload and are marked.
  const key = realmReviewSlotKey('realm', 'lore/world.md');
  assert.strictEqual(key, 'realm|lore/world.md');
  const edited = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, {
    payload,
    edits: { [key]: 'Edited world lore.' }
  });
  assert.strictEqual(edited[0].content, 'Edited world lore.');
  assert.strictEqual(edited[0].contentSource, 'review');
  assert.strictEqual(edited[0].edited, true);
  assert.strictEqual(edited[1].contentSource, 'payload', 'other slots keep the payload content');

  // A fixed slot can never be edited through review edits.
  const fixedEdit = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, {
    edits: { [realmReviewSlotKey('realm', 'rules/base.md')]: 'override' }
  });
  assert.strictEqual(fixedEdit[2].content, 'Fixed rules.', 'fixed slots ignore review edits');
  assert.strictEqual(fixedEdit[2].editable, false);

  // No payload and no edits: user/generated slots read as absent.
  const absent = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, {});
  assert.deepStrictEqual(absent.map((slot) => slot.contentSource), ['absent', 'absent', 'bundle-inline', 'bundle-file']);

  // A missing fixed bundle source is reported honestly, never guessed.
  const missing = buildRealmReviewFileSlots(REVIEW_TEMPLATE, {}, {});
  assert.strictEqual(missing[3].contentSource, 'bundle-missing');
  assert.match(missing[3].sourceLabel, /missing/);
  assert.strictEqual(missing[3].content, '');

  // A member-targeted edit key round-trips through the canonical slot key.
  const memberEdit = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, {
    edits: { 'agent:narrator|notes/tone.md': 'Member tone.' }
  });
  assert.strictEqual(memberEdit[1].content, 'Member tone.');
  assert.strictEqual(memberEdit[1].contentSource, 'review');

  assert.deepStrictEqual(buildRealmReviewFileSlots(DEMO_TEMPLATE, {}, {}), [], 'a seed-less template has no slots');
  assert.deepStrictEqual(buildRealmReviewFileSlots(null, null, null), []);
});

test('28. the review attaches an unedited source verbatim and rebuilds only edited or reviewed payloads', () => {
  const version = templateBundleVersion({ template: REVIEW_TEMPLATE, files: REVIEW_FILES });
  const source = reviewPayload(version);
  const slots = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, { payload: source });

  const verbatim = assembleRealmReviewPackage({
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    source,
    slots
  });
  assert.strictEqual(verbatim.attached, true);
  assert.strictEqual(verbatim.package, source, 'an unedited candidate attaches verbatim (the digest stays the submitter\'s)');
  assert.strictEqual(verbatim.fileCount, 2);

  const rebuiltSlots = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, {
    payload: source,
    edits: { 'realm|lore/world.md': 'Edited world lore.' }
  });
  const rebuilt = assembleRealmReviewPackage({
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    source,
    slots: rebuiltSlots
  });
  assert.notStrictEqual(rebuilt.package, source, 'an edited review rebuilds the package');
  assert.deepStrictEqual(rebuilt.package.files, [
    { path: 'lore/world.md', target: 'realm', content: 'Edited world lore.' },
    { path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'User tone notes.' }
  ]);
  assert.deepStrictEqual(rebuilt.package.inputs, { premise: 'A premise.' }, 'source inputs are preserved');
  assert.deepStrictEqual(rebuilt.package.provenance, undefined, 'absent provenance stays absent');
  assert.strictEqual(rebuilt.package.formatVersion, 1);
  assert.strictEqual(rebuilt.package.templateId, REVIEW_TEMPLATE.id);
  assert.strictEqual(rebuilt.package.templateVersion, version);

  // A review-built package from edits alone (no candidate attached).
  const editSlots = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, {
    edits: {
      'realm|lore/world.md': 'Solo lore.',
      'agent:narrator|notes/tone.md': 'Solo tone.'
    }
  });
  const built = assembleRealmReviewPackage({
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    source: null,
    slots: editSlots
  });
  assert.strictEqual(built.attached, true);
  assert.deepStrictEqual(built.package.files.map((file) => file.path), ['lore/world.md', 'notes/tone.md']);
  assert.strictEqual(built.package.inputs, undefined, 'a review-built package carries no source inputs');

  // Nothing attached and nothing edited stays nothing.
  const nothing = assembleRealmReviewPackage({
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    source: null,
    slots: buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, {})
  });
  assert.deepStrictEqual(nothing, { attached: false, package: null, fileCount: 0 });
  assert.deepStrictEqual(
    assembleRealmReviewPackage({ templateId: REVIEW_TEMPLATE.id, templateVersion: null, source, slots }),
    { attached: false, package: null, fileCount: 0 },
    'an unversionable bundle attaches nothing (the store would fail closed anyway)'
  );
});

test('29. the package preview validates against the effective version and surfaces the mismatch', () => {
  const version = templateBundleVersion({ template: REVIEW_TEMPLATE, files: REVIEW_FILES });
  const valid = previewRealmReviewPackage(REVIEW_TEMPLATE, reviewPayload(version), { currentVersion: version });
  assert.strictEqual(valid.ok, true, valid.error);
  assert.strictEqual(valid.mismatch, false);
  assert.deepStrictEqual(valid.warnings, []);
  assert.strictEqual(valid.code, '');

  const mismatch = previewRealmReviewPackage(REVIEW_TEMPLATE, reviewPayload('sha256:other'), {
    currentVersion: version
  });
  assert.strictEqual(mismatch.ok, true, 'a mismatch is a review warning, not a hard failure, with the flag');
  assert.strictEqual(mismatch.mismatch, true);
  assert.match(mismatch.warnings[0], /pins template version/);

  const fixedEntry = previewRealmReviewPackage(REVIEW_TEMPLATE, {
    ...reviewPayload(version),
    files: [...reviewPayload(version).files, { path: 'rules/base.md', target: 'realm', content: 'nope' }]
  }, { currentVersion: version });
  assert.strictEqual(fixedEntry.ok, false);
  assert.match(fixedEntry.error, /fixed seed slot/);
  assert.strictEqual(fixedEntry.code, 'ERR_HYDRATION_PACKAGE');

  const missingGenerated = previewRealmReviewPackage(REVIEW_TEMPLATE, {
    formatVersion: 1,
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    files: [{ path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'Tone.' }]
  }, { currentVersion: version });
  assert.strictEqual(missingGenerated.ok, false);
  assert.match(missingGenerated.error, /generated seed slot/);

  const undeclaredInput = previewRealmReviewPackage(REVIEW_TEMPLATE, {
    ...reviewPayload(version),
    inputs: { ghost: 'x' }
  }, { currentVersion: version });
  assert.strictEqual(undeclaredInput.ok, false);
  assert.match(undeclaredInput.error, /undeclared input/);

  assert.deepStrictEqual(previewRealmReviewPackage(REVIEW_TEMPLATE, null, { currentVersion: version }), {
    ok: true,
    warnings: [],
    mismatch: false,
    error: '',
    code: ''
  });
});

test('30. payload source parsing, candidate views, and input display projections', () => {
  const parsed = parseRealmPayloadFileText('{"formatVersion":1,"templateId":"x"}');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.value.templateId, 'x');
  assert.match(parseRealmPayloadFileText('').error, /empty/);
  assert.match(parseRealmPayloadFileText('{oops').error, /not valid JSON/);
  assert.match(parseRealmPayloadFileText('[]').error, /JSON object/);
  assert.match(parseRealmPayloadFileText(null).error, /empty/);

  assert.strictEqual(buildRealmPayloadFilename('t-review-fixture'), 't-review-fixture.package.json');
  assert.strictEqual(buildRealmPayloadFilename('../../evil'), 'evil.package.json');
  assert.strictEqual(buildRealmPayloadFilename(''), 'realm-template.package.json');

  const pending = [
    {
      templateId: REVIEW_TEMPLATE.id,
      templateVersion: 'sha256:v',
      resolvedAt: '2026-09-21T12:34:56.000Z',
      payload: {
        inputs: { premise: 'P', ignored: 42 },
        files: [
          { path: 'lore/world.md', target: 'realm', content: 'L' },
          { path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'T' },
          { path: 'bad' }
        ]
      }
    },
    { templateId: 'other', templateVersion: 'sha256:o', resolvedAt: '2026-09-21T00:00:00.000Z', payload: {} }
  ];
  const views = buildRealmPendingPayloadViews(REVIEW_TEMPLATE.id, pending, formatRealmLaunchTimestamp);
  assert.strictEqual(views.length, 1);
  assert.strictEqual(views[0].templateVersion, 'sha256:v');
  assert.strictEqual(views[0].inputCount, 1, 'non-string input values are not counted');
  assert.strictEqual(views[0].fileCount, 2, 'malformed file entries are not counted');
  assert.strictEqual(views[0].summary, '1 input · 2 files · resolved 2026-09-21 12:34:56 UTC');
  assert.deepStrictEqual(buildRealmPendingPayloadViews('', pending, formatRealmLaunchTimestamp), []);
  assert.deepStrictEqual(buildRealmPendingPayloadViews(REVIEW_TEMPLATE.id, null, formatRealmLaunchTimestamp), []);

  // Input display: payload values show until the operator edits (edits win).
  const drafts = buildRealmInputDrafts(REVIEW_TEMPLATE.inputs, REVIEW_FILES);
  const payload = reviewPayload();
  assert.deepStrictEqual(buildRealmReviewInputValues(drafts, payload), { premise: 'A premise.' });
  assert.strictEqual(resolveRealmReviewInputDisplay(drafts[0], payload), 'A premise.');
  assert.strictEqual(resolveRealmReviewInputDisplay(drafts[1], payload), 'Noir.', 'no payload value → the prefill shows');
  const edited = drafts.map((draft) => (draft.id === 'premise' ? { ...draft, value: 'Edited', dirty: true } : draft));
  assert.deepStrictEqual(buildRealmReviewInputValues(edited, payload), { premise: 'Edited' });
  assert.strictEqual(resolveRealmReviewInputDisplay(edited[0], payload), 'Edited');
  assert.deepStrictEqual(buildRealmReviewInputValues(null, null), {});
});

// Authority fixture: the Session Zero shape — one template-authoring agent and
// one payload agent, plus an unrequesting member.
const AUTHORITY_TEMPLATE = {
  formatVersion: 1,
  id: 'u-authority-fixture',
  name: 'Authority Fixture',
  description: '',
  agents: [
    {
      key: 'architect',
      idPattern: 'u-architect',
      name: 'Architect',
      role: 'template author',
      prompt: [{ kind: 'text', text: 'Author.' }],
      toolProfile: { tools: [] },
      privileged: true,
      authorities: ['@template:authority']
    },
    {
      key: 'genesis',
      idPattern: 'u-genesis',
      name: 'Genesis',
      role: 'payload author',
      prompt: [{ kind: 'text', text: 'Hydrate.' }],
      toolProfile: { tools: [] },
      privileged: true,
      authorities: ['@hydration:authority', 'acme:unknown']
    },
    {
      key: 'plain',
      idPattern: 'u-plain',
      name: 'Plain',
      role: 'member',
      prompt: [{ kind: 'text', text: 'Work.' }],
      toolProfile: { tools: [] },
      privileged: false
    }
  ]
};

test('31. declared authorities disclose per agent, default to declined, and assemble only checked pairs', () => {
  const rows = buildRealmAuthorityReviewAgents(AUTHORITY_TEMPLATE);
  assert.deepStrictEqual(rows.map((row) => row.key), ['architect', 'genesis'], 'only declaring agents render');
  assert.strictEqual(rows[0].privileged, true, 'privilege is disclosed separately from the requests');
  assert.deepStrictEqual(rows[0].declarations.map((entry) => entry.authority), ['@template:authority']);
  assert.strictEqual(rows[0].declarations[0].known, true);
  assert.match(rows[0].declarations[0].description, /Import realm template bundles/);
  assert.deepStrictEqual(rows[1].declarations.map((entry) => entry.authority), ['@hydration:authority', 'acme:unknown']);
  assert.deepStrictEqual(rows[1].unknownAuthorities.map((entry) => entry.authority), ['acme:unknown']);
  assert.strictEqual(rows[1].declarations[1].known, false);

  const declined = buildRealmAuthorityDecisions(AUTHORITY_TEMPLATE, null);
  assert.strictEqual(declined[buildRealmAuthorityDecisionKey('architect', '@template:authority')], 'declined');
  assert.strictEqual(declined[buildRealmAuthorityDecisionKey('genesis', 'acme:unknown')], 'declined');
  assert.deepStrictEqual(
    assembleRealmAuthorityApprovals(AUTHORITY_TEMPLATE, declined),
    [],
    'absent approval = declined; nothing travels'
  );

  const approved = {
    ...declined,
    [buildRealmAuthorityDecisionKey('architect', '@template:authority')]: 'approved',
    [buildRealmAuthorityDecisionKey('genesis', '@hydration:authority')]: 'approved'
  };
  assert.deepStrictEqual(
    assembleRealmAuthorityApprovals(AUTHORITY_TEMPLATE, approved),
    [
      { agentKey: 'architect', authority: '@template:authority' },
      { agentKey: 'genesis', authority: '@hydration:authority' }
    ],
    'approvals follow template/declaration order and never grant jointly'
  );

  // Trust auto-approves only exact declared matches: the trusted pair renders
  // checked, a newly declared authority stays declined (re-prompt), and a
  // trusted-but-removed authority is stale (never approves).
  const trust = {
    architect: ['@template:authority'],
    genesis: ['@hydration:authority', 'gone:authority'],
    ghost: ['@template:authority']
  };
  const trusted = buildRealmAuthorityDecisions(AUTHORITY_TEMPLATE, trust);
  assert.strictEqual(trusted[buildRealmAuthorityDecisionKey('architect', '@template:authority')], 'trusted');
  assert.strictEqual(trusted[buildRealmAuthorityDecisionKey('genesis', '@hydration:authority')], 'trusted');
  assert.strictEqual(trusted[buildRealmAuthorityDecisionKey('genesis', 'acme:unknown')], 'declined');
  assert.deepStrictEqual(
    assembleRealmAuthorityApprovals(AUTHORITY_TEMPLATE, trusted),
    [
      { agentKey: 'architect', authority: '@template:authority' },
      { agentKey: 'genesis', authority: '@hydration:authority' }
    ]
  );

  const trustView = describeRealmAuthorityTrust(AUTHORITY_TEMPLATE, trust);
  assert.strictEqual(trustView.trusted, true);
  assert.deepStrictEqual(
    trustView.pairs.map((pair) => `${pair.agentKey}→${pair.authority}`),
    ['architect→@template:authority', 'genesis→@hydration:authority']
  );
  assert.deepStrictEqual(
    trustView.stalePairs.map((pair) => `${pair.agentKey}→${pair.authority}`),
    ['genesis→gone:authority', 'ghost→@template:authority'],
    'trusted pairs no longer declared (or on an unknown agent key) never approve'
  );
  assert.match(trustView.summary, /2 exact pairs/);
  assert.match(trustView.summary, /2 trusted pairs no longer declared re-prompt/);

  assert.deepStrictEqual(describeRealmAuthorityTrust(AUTHORITY_TEMPLATE, null), {
    trusted: false,
    pairs: [],
    stalePairs: [],
    summary: ''
  });
  assert.deepStrictEqual(buildRealmAuthorityReviewAgents(null), []);
  assert.deepStrictEqual(buildRealmAuthorityDecisions(null, null), {});
  assert.deepStrictEqual(assembleRealmAuthorityApprovals(null, null), []);
});

test('32. the launch gate blocks on unknown authorities, payload errors, unconfirmed mismatches, and unreviewed state', () => {
  const base = {
    reviewed: true,
    previewError: '',
    payloadError: '',
    mismatchUnconfirmed: false,
    unknownAuthorities: []
  };
  assert.deepStrictEqual(describeRealmLaunchGate(base), { disabled: false, hint: '' });

  const unreviewed = describeRealmLaunchGate({ ...base, reviewed: false });
  assert.strictEqual(unreviewed.disabled, true);
  assert.match(unreviewed.hint, /Confirm the review/);

  const payload = describeRealmLaunchGate({ ...base, payloadError: 'Required generated slots are not attached: a.md.' });
  assert.strictEqual(payload.disabled, true);
  assert.match(payload.hint, /Fix the attached payload/);

  const mismatch = describeRealmLaunchGate({ ...base, mismatchUnconfirmed: true });
  assert.strictEqual(mismatch.disabled, true);
  assert.match(mismatch.hint, /confirm the mismatch/i);

  const preview = describeRealmLaunchGate({ ...base, previewError: 'Template preview unavailable.' });
  assert.strictEqual(preview.disabled, true);
  assert.strictEqual(preview.hint, 'Template preview unavailable.');

  const unknown = describeRealmLaunchGate({ ...base, unknownAuthorities: ['acme:unknown'] });
  assert.strictEqual(unknown.disabled, true);
  assert.match(unknown.hint, /cannot enforce/);
  assert.match(unknown.hint, /acme:unknown/);

  // Precedence: an unknown authority wins over every other blocker.
  const all = describeRealmLaunchGate({
    reviewed: false,
    previewError: 'preview',
    payloadError: 'payload',
    mismatchUnconfirmed: true,
    unknownAuthorities: ['a', 'b']
  });
  assert.match(all.hint, /cannot enforce the declared authorities a, b/);
});

test('33. the preview disclosures and operator toggle state project declared fields honestly', () => {
  const rows = buildRealmAgentDisclosureRows(
    {
      key: 'a',
      initialPrompt: 'Begin the session.',
      triggerPolicy: 'queue',
      modelPresetId: 'preset_x',
      privileged: true
    },
    'Preset X'
  );
  assert.deepStrictEqual(rows.map((row) => row.key), ['initialPrompt', 'triggerPolicy', 'modelPresetId', 'privileged']);
  assert.deepStrictEqual(rows.map((row) => row.value), [
    'Begin the session.',
    'queue',
    'Preset X',
    'yes — sudo authority'
  ]);
  assert.deepStrictEqual(rows.map((row) => row.present), [true, true, true, true]);

  const empty = buildRealmAgentDisclosureRows(null);
  assert.deepStrictEqual(empty.map((row) => row.present), [false, false, false, true]);
  assert.deepStrictEqual(empty.map((row) => row.value), ['—', '—', 'catalog default', 'no']);

  const declaredOnlyPreset = buildRealmAgentDisclosureRows({ key: 'a', modelPresetId: 'preset_y' });
  assert.strictEqual(declaredOnlyPreset[2].value, 'preset_y', 'the raw declared id shows when no binding label is resolved');

  assert.deepStrictEqual(
    META_AUTHORITY_TOGGLES.map((entry) => entry.authority),
    ['@template:authority', '@hydration:authority']
  );
  const key = 'realm:r1:architect';
  assert.deepStrictEqual(
    buildMetaAuthorityToggleState({ template: [key], hydration: [] }, key),
    { template: true, hydration: false }
  );
  assert.deepStrictEqual(
    buildMetaAuthorityToggleState({ template: [key], hydration: [key] }, key),
    { template: true, hydration: true }
  );
  assert.deepStrictEqual(
    buildMetaAuthorityToggleState(null, key),
    { template: false, hydration: false },
    'malformed listings read as ungranted'
  );
  assert.deepStrictEqual(
    buildMetaAuthorityToggleState({ template: [key], hydration: [] }, ''),
    { template: false, hydration: false },
    'an unresolved agent key never matches'
  );
});

// ============================================================================
// 34. Pending-candidate download: safe filenames + canonical JSON serialization
// ============================================================================

test('34. pending payload downloads use sanitized filenames and canonical JSON text', () => {
  assert.strictEqual(buildRealmPayloadFilename('example_agent'), 'example_agent.package.json');

  // Path separators and unsafe characters collapse into the safe alphabet, so
  // a template id can never inject a directory into the download name.
  for (const unsafe of ['a/b', 'a\\b', '../../evil', 'C:secret', 'sp ace:name?', '..', '.', '\u0000null']) {
    const filename = buildRealmPayloadFilename(unsafe);
    assert.match(
      filename,
      /^[A-Za-z0-9._-]+\.package\.json$/,
      `${JSON.stringify(unsafe)} sanitizes to the safe alphabet`
    );
    assert.ok(
      !filename.includes('/') && !filename.includes('\\'),
      `${JSON.stringify(unsafe)} carries no path separator`
    );
  }
  assert.strictEqual(buildRealmPayloadFilename('a/b'), 'a_b.package.json');
  assert.strictEqual(buildRealmPayloadFilename('../../evil'), 'evil.package.json');
  assert.strictEqual(buildRealmPayloadFilename(''), 'realm-template.package.json', 'a blank id falls back');
  assert.strictEqual(buildRealmPayloadFilename('   '), 'realm-template.package.json');
  assert.strictEqual(buildRealmPayloadFilename(null), 'realm-template.package.json');
  assert.strictEqual(buildRealmPayloadFilename(undefined), 'realm-template.package.json');

  // Serialization round-trips the exact candidate payload, pretty-printed,
  // with a trailing newline.
  const payload = reviewPayload();
  const json = serializeRealmPendingPayload(payload);
  assert.ok(json.endsWith('\n'), 'the serialized payload ends with a newline');
  assert.deepStrictEqual(JSON.parse(json), payload, 'the text parses back to the exact payload');
  assert.ok(json.split('\n').length > 1, 'the body is pretty-printed across multiple lines');
  assert.match(json, /\n  "/, 'the body is indented with two spaces');
  assert.strictEqual(json, `${JSON.stringify(payload, null, 2)}\n`);

  // Absent payloads serialize to a parseable `null` literal instead of throwing.
  assert.strictEqual(serializeRealmPendingPayload(undefined), 'null\n');
  assert.strictEqual(JSON.parse(serializeRealmPendingPayload(undefined)), null);
  assert.strictEqual(JSON.parse(serializeRealmPendingPayload(null)), null);

  // Malformed values never throw: circular references and unsupported
  // primitives fall back to the `null` literal.
  const circular = {};
  circular.self = circular;
  assert.strictEqual(JSON.parse(serializeRealmPendingPayload(circular)), null);
  assert.strictEqual(serializeRealmPendingPayload(Symbol('pending')), 'null\n');
});
