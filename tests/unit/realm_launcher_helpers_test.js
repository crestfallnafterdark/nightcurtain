/**
 * @file tests/unit/realm_launcher_helpers_test.js
 * @description Zero-mock unit tests for the Realm launcher UI helpers
 * (`realmLauncherHelpers.ts` / `realmReviewHelpers.ts`) — the per-agent
 * capability preview projection built over the real `realmCatalog`, the
 * preset-binding display model over a real `presetCatalog`, seed file-row
 * parsing and draft validation, seed-target options, and the launch/seed error
 * descriptions. The parser rejects seed paths addressing the reserved
 * `global`/`public` workspace roots (V18 F-V18-1) so the UI fails inline
 * instead of letting the legacy VirtualFS prefix routing divert the write, and
 * the duplicate-name guard (`isRealmNameTaken`) is shared by the launcher
 * wizard and the Realm manager create form (V18 F-V18-3).
 *
 * The launcher input surface is the canonical shape-tagged model: text/files
 * input drafts with attachments, the derived per-input usage map, the
 * synthesized-envelope input validation with typed failures, fileset
 * attachment checks, placement/directive seed views, and the placement-based
 * files dialog with prompt/history selection resolution. The review
 * projections cover per-part prompt provenance, source-editable baked history,
 * the files-dialog slot provenance, payload assembly/validation against the
 * effective template version (legacy format-v1 packages included through the
 * read shim), declared authority decisions with the trust override, the
 * mandatory launch gate, the preview disclosures, and the operator
 * publishing-authority toggle state. The review launch-payload resolution is
 * pinned too: an edited slot rebuilds the launch package and the assembled
 * payload validates through the real catalog with the edited content present.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assembleRealmV2Inputs,
  buildRealmHistoryPreview,
  buildRealmInputAttachment,
  buildRealmInputUsageMap,
  buildRealmPreviewProjection,
  buildRealmPromptPreview,
  buildRealmSeedSlotViews,
  buildRealmSeedSummary,
  buildRealmV2InputDrafts,
  buildSeedTargetOptions,
  describeRealmLaunchError,
  describeRealmPresetBinding,
  describeRealmSeedError,
  describeSeedWorkspace,
  isRealmNameTaken,
  parseSeedFileRows,
  resetRealmV2InputDraft,
  sanitizeRealmAttachmentPath,
  setRealmV2InputFiles,
  setRealmV2InputText,
  uniqueRealmAttachmentPath,
  validateRealmInputAttachments,
  validateRealmLaunchDraft,
  validateRealmV2InputDrafts,
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
  describeRealmAuthorityTrust,
  describeRealmLaunchGate,
  parseRealmPayloadFileText,
  previewRealmReviewPackage,
  realmReviewSlotKey,
  resolveRealmReviewLaunchPayload,
  serializeRealmPendingPayload
} from '../../src/lib/components/sandbox/realmReviewHelpers.ts';
import { formatRealmLaunchTimestamp } from '../../src/lib/components/sandbox/realmTemplateHelpers.ts';
import {
  DEMO_TEMPLATE,
  materializeTemplate,
  summarizeAgentCapabilities,
  templateBundleVersion,
  validatePayload
} from '../../src/lib/sandbox/realmCatalog/index.ts';
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
test('20. the seed summary counts placements, lists targets in order, and previews the directive', () => {
  const summary = buildRealmSeedSummary(V2_TEMPLATE);
  assert.strictEqual(summary.declaresSeed, true);
  assert.strictEqual(summary.fileCount, 4, 'one entry per declared placement');
  assert.strictEqual(summary.placementCount, 4);
  assert.strictEqual(summary.directiveCount, 2);
  assert.deepStrictEqual(
    summary.targetLabels,
    ['Realm-global workspace', 'Lead (lead)', 'Scribe (scribe)'],
    'distinct targets in first-appearance order'
  );
  assert.deepStrictEqual(summary.directive, {
    targetAgentKey: 'lead',
    targetLabel: 'Lead (lead)',
    preview: 'input "Briefing"',
    },
    'an input-backed directive previews its input label'
  );

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
    ...V2_TEMPLATE,
    directives: [{ text: 'x'.repeat(200), target: { agent: 'lead' } }]
  });
  assert.strictEqual(longDirective.directive.preview.length, 121, 'the preview caps at 120 chars plus the ellipsis');
  assert.ok(longDirective.directive.preview.endsWith('…'));

  // Legacy documents convert through the read shim and render natively.
  const legacy = buildRealmSeedSummary(FIXTURE_TEMPLATE);
  assert.strictEqual(legacy.declaresSeed, true);
  assert.strictEqual(legacy.fileCount, 3, 'the v1 seed slots become placements');
  assert.deepStrictEqual(
    legacy.targetLabels,
    ['Realm-global workspace', 'Lead (lead)', 'Scribe (scribe)']
  );
  assert.deepStrictEqual(legacy.directive, {
    targetAgentKey: 'lead',
    targetLabel: 'Lead (lead)',
    preview: 'Begin the seeded session.'
  });

  // A legacy document the shim cannot normalize renders no seed instead of throwing.
  const unknownTarget = buildRealmSeedSummary({
    ...FIXTURE_TEMPLATE,
    seed: { files: [{ path: 'a.md', target: { agent: 'ghost' }, source: { inline: 'x' } }] }
  });
  assert.strictEqual(unknownTarget.declaresSeed, false, 'an unresolvable legacy target fails closed');
});

test('21. the prompt preview matches the materialized system prompt and reports missing bundles inline', () => {
  const spec = V2_TEMPLATE.agents[0];
  const inputs = {
    briefing: { shape: 'text', text: 'M' },
    tone: { shape: 'text', text: 'Noir.' },
    house_style: { shape: 'text', text: 'Terse.' },
    roster: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }] }
  };
  const preview = buildRealmPromptPreview(spec.prompt, V2_TEMPLATE.inputs, {
    inputs,
    bundleFiles: V2_FILES
  });

  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.bundleUnavailable, false);
  assert.strictEqual(preview.error, '');
  assert.strictEqual(preview.systemPrompt, 'Lead protocol.\n\nM\n\nNoir.\n\nTerse.\n\nIndex.');

  const plan = materializeTemplate(V2_TEMPLATE, {
    realmId: 'realm_l4',
    inputs,
    bundleFiles: V2_FILES
  });
  assert.strictEqual(preview.systemPrompt, plan.agents[0].systemPrompt, 'the preview is the materialized prompt');
  assert.deepStrictEqual(preview.inputProvenance, plan.agents[0].inputProvenance);

  const emptyInput = buildRealmPromptPreview(
    [{ kind: 'text', text: 'A' }, { kind: 'input', inputId: 'tone' }],
    [{ id: 'tone', label: 'Tone', shape: 'text' }],
    { inputs: { tone: { shape: 'text', text: '   ' } } }
  );
  assert.strictEqual(emptyInput.ok, true);
  assert.strictEqual(emptyInput.systemPrompt, 'A', 'an empty input contributes nothing');

  const missingBundle = buildRealmPromptPreview(spec.prompt, V2_TEMPLATE.inputs, {
    inputs,
    bundleFiles: {}
  });
  assert.strictEqual(missingBundle.ok, false);
  assert.strictEqual(missingBundle.bundleUnavailable, true);
  assert.match(missingBundle.error, /not available/);
  assert.match(missingBundle.error, /prompts\/lead\.md/);

  const missingDefaultFile = buildRealmPromptPreview(
    [{ kind: 'input', inputId: 'house_style' }],
    V2_TEMPLATE.inputs,
    { bundleFiles: {} }
  );
  assert.strictEqual(missingDefaultFile.bundleUnavailable, true, 'an unresolved defaultFile is a bundle state');
  assert.match(missingDefaultFile.error, /inputs\/style\.md/);

  const requiredEmpty = buildRealmPromptPreview(spec.prompt, V2_TEMPLATE.inputs, {
    inputs: { ...inputs, briefing: { shape: 'text', text: '' } },
    bundleFiles: V2_FILES
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

test('23. the history preview composes role-tagged messages through the real catalog', () => {
  const spec = V2_TEMPLATE.agents[0];
  const preview = buildRealmHistoryPreview(spec, V2_TEMPLATE.inputs, {
    inputs: { briefing: { shape: 'text', text: 'A premise.' } },
    bundleFiles: V2_FILES
  });

  assert.strictEqual(preview.ok, true);
  assert.strictEqual(preview.bundleUnavailable, false);
  assert.strictEqual(preview.error, '');
  assert.deepStrictEqual(preview.entries, [
    { role: 'assistant', roleLabel: 'Agent', content: 'A premise.\n\nReady.' }
  ]);

  const plan = materializeTemplate(V2_TEMPLATE, {
    realmId: 'realm_l4',
    inputs: {
      briefing: { shape: 'text', text: 'A premise.' },
      roster: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }] }
    },
    bundleFiles: V2_FILES
  });
  assert.deepStrictEqual(
    preview.entries.map((entry) => ({ role: entry.role, content: entry.content })),
    plan.agents[0].history.map((message) => ({ role: message.role, content: message.content })),
    'the preview is exactly the history the launch seeds'
  );

  // Explicit review values win over declared defaults.
  const overridden = buildRealmHistoryPreview(spec, V2_TEMPLATE.inputs, {
    inputs: { briefing: { shape: 'text', text: 'P' } },
    bundleFiles: V2_FILES
  });
  assert.deepStrictEqual(overridden.entries.map((entry) => entry.content), ['P\n\nReady.']);

  // No declared history is a valid empty preview.
  const noHistory = buildRealmHistoryPreview({ ...spec, history: undefined }, V2_TEMPLATE.inputs, {});
  assert.strictEqual(noHistory.ok, true);
  assert.deepStrictEqual(noHistory.entries, []);

  // Missing bundle entries are a bundle state, not a composition error.
  const missingSpec = {
    ...spec,
    history: [{ role: 'user', content: [{ kind: 'file', path: 'files/order.md' }] }]
  };
  const missing = buildRealmHistoryPreview(missingSpec, V2_TEMPLATE.inputs, { bundleFiles: {} });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.bundleUnavailable, true);
  assert.match(missing.error, /files\/order\.md/);

  // Undeclared input references fail closed with the catalog's own rule.
  const undeclared = buildRealmHistoryPreview(
    { ...spec, history: [{ role: 'assistant', content: [{ kind: 'input', inputId: 'ghost' }] }] },
    V2_TEMPLATE.inputs,
    { bundleFiles: V2_FILES }
  );
  assert.strictEqual(undeclared.ok, false);
  assert.match(undeclared.error, /undeclared input "ghost"/);

  // An entry that composes empty is rejected instead of previewed as empty.
  const empty = buildRealmHistoryPreview(
    { ...spec, history: [{ role: 'assistant', content: [{ kind: 'input', inputId: 'tone' }] }] },
    V2_TEMPLATE.inputs,
    { inputs: { tone: { shape: 'text', text: '   ' } }, bundleFiles: V2_FILES }
  );
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.bundleUnavailable, false);
  assert.match(empty.error, /composes empty/);

  const malformed = buildRealmHistoryPreview(null, null, null);
  assert.strictEqual(malformed.ok, false);
  assert.ok(malformed.error.length > 0, 'malformed input fails inline, never throws');
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
  const spec = V2_TEMPLATE.agents[0];
  const inputs = {
    briefing: { shape: 'text', text: 'A premise.' },
    house_style: { shape: 'text', text: 'Terse.' },
    roster: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }] }
  };
  const view = buildRealmPartProvenanceViews(spec.prompt, V2_TEMPLATE.inputs, {
    inputs,
    bundleFiles: V2_FILES
  });

  assert.strictEqual(view.ok, true);
  assert.strictEqual(view.bundleUnavailable, false);
  assert.deepStrictEqual(view.parts.map((part) => part.kind), ['file', 'input', 'input', 'input', 'input']);
  assert.deepStrictEqual(
    view.parts.map((part) => part.origin),
    ['fixed', 'generated', 'fixed', 'fixed', 'generated'],
    'bundle files are fixed, required inputs render generated, prefilled inputs render fixed'
  );
  assert.deepStrictEqual(
    view.parts.map((part) => part.editable),
    [false, true, true, true, true],
    'only input parts are editable (at their launch-value source)'
  );
  assert.strictEqual(view.parts[0].path, 'prompts/lead.md');
  assert.strictEqual(view.parts[0].content, 'Lead protocol.');
  assert.strictEqual(view.parts[1].content, 'A premise.');
  assert.strictEqual(view.parts[2].content, 'Noir.');
  assert.strictEqual(view.parts[3].content, 'Terse.');
  assert.strictEqual(view.parts[4].content, 'Index.');
  assert.deepStrictEqual(view.parts[0].label, 'bundle file prompts/lead.md');
  assert.strictEqual(view.parts[2].inputLabel, 'Tone');
  assert.strictEqual(view.parts[1].required, true, 'the required briefing renders required');

  // The contributing parts are exactly the catalog-composed prompt.
  const composed = buildRealmPromptPreview(spec.prompt, V2_TEMPLATE.inputs, {
    inputs,
    bundleFiles: V2_FILES
  });
  assert.strictEqual(
    view.parts.filter((part) => !part.empty).map((part) => part.content).join('\n\n'),
    composed.systemPrompt,
    'the part views agree with the real composition'
  );

  // An empty input contributes nothing and stays visible.
  const emptyInput = buildRealmPartProvenanceViews(
    [{ kind: 'text', text: 'A' }, { kind: 'input', inputId: 'tone' }],
    V2_TEMPLATE.inputs,
    { inputs: { tone: { shape: 'text', text: '   ' } }, bundleFiles: V2_FILES }
  );
  assert.strictEqual(emptyInput.ok, true);
  assert.strictEqual(emptyInput.parts[1].empty, true);

  // Missing bundle entries are a bundle state, not a silent empty part.
  const missing = buildRealmPartProvenanceViews(spec.prompt, V2_TEMPLATE.inputs, { bundleFiles: {} });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.bundleUnavailable, true);
  assert.match(missing.error, /prompts\/lead\.md/);
  assert.deepStrictEqual(missing.parts, []);

  assert.deepStrictEqual(buildRealmPartProvenanceViews(null, null, null), {
    ok: true,
    parts: [],
    bundleUnavailable: false,
    error: ''
  });
});

test('26. the history editor composes through the real catalog and edits input-backed entries at source', () => {
  const spec = V2_TEMPLATE.agents[0];
  const inputs = {
    briefing: { shape: 'text', text: 'A premise.' },
    roster: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }] }
  };
  const view = buildRealmHistoryEditorViews(spec, V2_TEMPLATE.inputs, {
    inputs,
    bundleFiles: V2_FILES
  });

  assert.strictEqual(view.ok, true);
  assert.deepStrictEqual(view.entries.map((entry) => entry.role), ['assistant']);
  assert.deepStrictEqual(view.entries.map((entry) => entry.roleLabel), ['Agent']);
  assert.deepStrictEqual(view.entries.map((entry) => entry.content), ['A premise.\n\nReady.']);
  assert.deepStrictEqual(view.entries.map((entry) => entry.editable), [true]);
  assert.deepStrictEqual(view.entries[0].inputIds, ['briefing']);
  assert.deepStrictEqual(view.entries[0].parts.map((part) => part.origin), ['generated', 'fixed']);
  assert.deepStrictEqual(view.entries[0].parts.map((part) => part.editable), [true, false]);

  // The editor content is exactly what the launch seeds.
  const plan = materializeTemplate(V2_TEMPLATE, {
    realmId: 'realm_l4',
    inputs,
    bundleFiles: V2_FILES
  });
  assert.deepStrictEqual(
    view.entries.map((entry) => entry.content),
    plan.agents[0].history.map((message) => message.content),
    'review history equals the seeded history'
  );

  // Editing the referenced input changes the composed entry (source editing).
  const edited = buildRealmHistoryEditorViews(spec, V2_TEMPLATE.inputs, {
    inputs: { ...inputs, briefing: { shape: 'text', text: 'Edited premise.' } },
    bundleFiles: V2_FILES
  });
  assert.strictEqual(edited.entries[0].content, 'Edited premise.\n\nReady.');
  assert.strictEqual(edited.entries[0].parts[0].content, 'Edited premise.');

  // A fixed-only entry renders read-only.
  const fixed = buildRealmHistoryEditorViews(
    { ...spec, history: [{ role: 'assistant', content: [{ kind: 'text', text: 'Fixed opener.' }] }] },
    V2_TEMPLATE.inputs,
    {}
  );
  assert.strictEqual(fixed.ok, true);
  assert.strictEqual(fixed.entries[0].editable, false);
  assert.strictEqual(fixed.entries[0].content, 'Fixed opener.');

  // Missing bundle entries and undeclared references fail closed inline.
  const missingSpec = {
    ...spec,
    history: [{ role: 'user', content: [{ kind: 'file', path: 'files/order.md' }] }]
  };
  const missing = buildRealmHistoryEditorViews(missingSpec, V2_TEMPLATE.inputs, { bundleFiles: {} });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.bundleUnavailable, true);
  assert.match(missing.error, /files\/order\.md/);

  const undeclared = buildRealmHistoryEditorViews(
    { ...spec, history: [{ role: 'assistant', content: [{ kind: 'input', inputId: 'ghost' }] }] },
    V2_TEMPLATE.inputs,
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
  const noHistory = buildRealmHistoryEditorViews({ ...spec, history: undefined }, V2_TEMPLATE.inputs, {});
  assert.strictEqual(noHistory.ok, true);
  assert.deepStrictEqual(noHistory.entries, []);
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

  const rebuiltSlots = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, { payload: source }).map(
    (slot) => (slot.path === 'lore/world.md'
      ? { ...slot, edited: true, content: 'Edited world lore.', contentSource: 'review' }
      : slot)
  );
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
  const editSlots = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, {}).map(
    (slot) => (slot.path === 'lore/world.md'
      ? { ...slot, edited: true, content: 'Solo lore.', contentSource: 'review' }
      : slot.path === 'notes/tone.md'
        ? { ...slot, edited: true, content: 'Solo tone.', contentSource: 'review' }
        : slot)
  );
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
  assert.match(fixedEntry.error, /targets text input/);
  assert.strictEqual(fixedEntry.code, 'ERR_HYDRATION_PACKAGE');

  const missingGenerated = previewRealmReviewPackage(REVIEW_TEMPLATE, {
    formatVersion: 1,
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    files: [{ path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'Tone.' }]
  }, { currentVersion: version });
  assert.strictEqual(missingGenerated.ok, false);
  assert.match(missingGenerated.error, /is missing from the payload/);

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

// ============================================================================
// 35-43. Format-v2 launcher inputs, usage map, and placement review (ticket a71198f)
// ============================================================================

/**
 * Format-v2 launcher fixture (ticket a71198f): declared text inputs (required,
 * `default`, `defaultFile`, single-line), declared files inputs (optional with
 * a `path` placement, required with a `root` placement), prompt/history file
 * selections, and input-backed plus literal directives — the shapes the v2
 * launcher/review surfaces must render natively.
 */
const V2_TEMPLATE = {
  id: 'l4-v2-fixture',
  name: 'L4 V2 Fixture',
  description: 'Format-v2 inputs, placements, and directives fixture.',
  formatVersion: 2,
  inputs: [
    { id: 'briefing', label: 'Briefing', shape: 'text', help: 'The task briefing.', required: true },
    { id: 'tone', label: 'Tone', shape: 'text', default: 'Noir.', multiline: false },
    { id: 'house_style', label: 'House style', shape: 'text', defaultFile: 'inputs/style.md' },
    { id: 'notes', label: 'Handoff notes', shape: 'files', help: 'Operator notes.', brief: 'Attach notes.' },
    { id: 'roster', label: 'Roster files', shape: 'files', required: true }
  ],
  agents: [
    {
      key: 'lead',
      idPattern: 'l4-lead',
      name: 'Lead',
      role: 'lead',
      prompt: [
        { kind: 'file', path: 'prompts/lead.md' },
        { kind: 'input', inputId: 'briefing' },
        { kind: 'input', inputId: 'tone' },
        { kind: 'input', inputId: 'house_style' },
        { kind: 'input', inputId: 'roster', path: 'index.md' }
      ],
      history: [
        { role: 'assistant', content: [{ kind: 'input', inputId: 'briefing' }, { kind: 'text', text: 'Ready.' }] }
      ],
      toolProfile: { preset: 'readonly' },
      privileged: false
    },
    {
      key: 'scribe',
      idPattern: 'l4-scribe',
      name: 'Scribe',
      role: 'scribe',
      prompt: [{ kind: 'input', inputId: 'notes', path: 'notes.md' }],
      toolProfile: { preset: 'readonly' },
      privileged: false
    }
  ],
  placements: [
    { file: 'files/readme.md', target: 'realm', path: 'handoff/README.md' },
    { inputId: 'notes', target: 'realm', path: 'handoff/notes.md' },
    { inputId: 'roster', target: { agent: 'lead' }, root: 'roster/' },
    { inputId: 'tone', target: { agent: 'scribe' }, path: 'style/tone.md' }
  ],
  directives: [
    { inputId: 'briefing', target: { agent: 'lead' } },
    { text: 'Begin.', target: { agent: 'scribe' } }
  ]
};

/** Bundle file bodies the v2 fixture's prompt parts, placement sources, and prefills resolve against. */
const V2_FILES = {
  'prompts/lead.md': 'Lead protocol.',
  'files/readme.md': 'Handoff readme.',
  'inputs/style.md': 'Terse.'
};

/** The fixture's effective bundle version (authored-form pin). */
const V2_VERSION = 'sha256:l4-v2-fixture';

/** Builds one v2 payload envelope for the fixture. */
function v2Payload(inputs, templateVersion = V2_VERSION) {
  return {
    formatVersion: 2,
    templateId: V2_TEMPLATE.id,
    templateVersion,
    inputs
  };
}

/** Assembles the fixture's drafts with every required input filled. */
function filledV2Drafts() {
  return buildRealmV2InputDrafts(V2_TEMPLATE, V2_FILES).map((draft) => {
    if (draft.id === 'briefing') return setRealmV2InputText(draft, 'Write the story.');
    if (draft.id === 'roster') {
      return setRealmV2InputFiles(draft, [{ path: 'index.md', content: 'Index.', name: 'index.md' }]);
    }
    return draft;
  });
}

test('35. the v2 usage map derives every prompt, history, placement, and directive site per input', () => {
  const usage = buildRealmInputUsageMap(V2_TEMPLATE);

  assert.deepStrictEqual(
    [...usage.keys()],
    ['briefing', 'tone', 'house_style', 'notes', 'roster'],
    'every declared input carries a usage entry in declared order'
  );
  assert.strictEqual(usage.get('briefing').required, true);
  assert.deepStrictEqual(
    usage.get('briefing').sites.map((site) => site.kind),
    ['prompt', 'history', 'directive'],
    'briefing lands in the lead prompt, its baked history, and the input-backed directive'
  );
  assert.deepStrictEqual(
    usage.get('roster').sites.map((site) => site.selection),
    ['path', 'root'],
    'roster is selected by path in the prompt and written under a root prefix'
  );
  assert.strictEqual(usage.get('notes').sites[0].path, 'notes.md', 'the prompt selection path is recorded');
  assert.strictEqual(usage.get('tone').sites[1].targetLabel, 'Scribe (scribe)');
  assert.strictEqual(usage.get('tone').sites[1].path, 'style/tone.md');
  assert.strictEqual(usage.get('briefing').sites[0].label, 'System prompt part 2');
  assert.strictEqual(usage.get('briefing').sites[1].label, 'Baked history entry 1 part 1');
  assert.strictEqual(usage.get('briefing').summary, '1 system prompt reference · 1 baked history reference · 1 directive');
  assert.strictEqual(usage.get('roster').summary, '1 system prompt reference · 1 placement');
  assert.strictEqual(usage.get('house_style').summary, '1 system prompt reference');

  // Realm opacity: every derived label is template-level, never a launched
  // agent id or a canonical workspace key.
  const rendered = JSON.stringify([...usage.values()]);
  assert.ok(!rendered.includes('realm:'), 'no canonical workspace key appears in the usage map');
  assert.ok(!rendered.includes('realm_l4'), 'no realm id appears in the usage map');

  assert.strictEqual(buildRealmInputUsageMap(null).size, 0);
  assert.strictEqual(buildRealmInputUsageMap({ formatVersion: 2, id: 'x', name: 'x', description: '' }).size, 0);
});

test('36. v2 input drafts project text and files requirements with prefills and usage', () => {
  const drafts = buildRealmV2InputDrafts(V2_TEMPLATE, V2_FILES);
  assert.deepStrictEqual(drafts.map((draft) => draft.shape), ['text', 'text', 'text', 'files', 'files']);

  const [briefing, tone, houseStyle, notes, roster] = drafts;
  assert.strictEqual(briefing.required, true);
  assert.strictEqual(briefing.value, '', 'a required input without a prefill starts empty');
  assert.strictEqual(briefing.multiline, true, 'multiline defaults on');
  assert.strictEqual(briefing.help, 'The task briefing.');
  assert.strictEqual(briefing.usage.sites.length, 3, 'drafts carry the derived usage map');
  assert.strictEqual(tone.value, 'Noir.');
  assert.strictEqual(tone.multiline, false);
  assert.strictEqual(houseStyle.value, 'Terse.', 'defaultFile prefills resolve from the bundle');
  assert.strictEqual(houseStyle.defaultResolved, true);
  assert.strictEqual(notes.shape, 'files');
  assert.strictEqual(notes.brief, 'Attach notes.');
  assert.deepStrictEqual(notes.files, [], 'files drafts start with an empty fileset');
  assert.strictEqual(roster.required, true);
  assert.strictEqual(roster.multiline, false);

  const unresolved = buildRealmV2InputDrafts(V2_TEMPLATE, {})[2];
  assert.strictEqual(unresolved.value, '', 'a missing defaultFile prefill starts empty');
  assert.strictEqual(unresolved.defaultResolved, false, 'the unresolved prefill is flagged');

  // Format-v1 templates convert through the read shim: their authored inputs
  // render as v2 text drafts with placement usage sites.
  const shimmed = buildRealmV2InputDrafts(FIXTURE_TEMPLATE, FIXTURE_FILES);
  assert.deepStrictEqual(
    shimmed.map((draft) => draft.id),
    ['directives', 'lore', 'mandate', 'seed_0', 'seed_2'],
    'v1 inputs plus the shimmed fixed-inline seed slots render as drafts'
  );
  assert.ok(shimmed.every((draft) => draft.shape === 'text'), 'v1 inputs shim to text drafts');
  assert.deepStrictEqual(
    shimmed.map((draft) => draft.usage.sites.map((site) => site.kind)),
    [['prompt'], ['prompt'], ['prompt'], ['placement'], ['placement']],
    'v1 prompt references and fixed inline slots become prompt/placement usage'
  );
  assert.deepStrictEqual(buildRealmV2InputDrafts(null, null), []);
  assert.deepStrictEqual(
    buildRealmV2InputDrafts({ ...V2_TEMPLATE, inputs: [null, { label: 'No id' }, { id: 'ok', label: 'Ok', shape: 'text' }] })
      .map((draft) => draft.id),
    ['ok'],
    'malformed declarations are skipped'
  );
});

test('37. v2 draft edits, attachment helpers, and reset preserve the dirty presence semantics', () => {
  const drafts = buildRealmV2InputDrafts(V2_TEMPLATE, V2_FILES);
  const tone = drafts[1];
  const edited = setRealmV2InputText(tone, 'Comic.');
  assert.strictEqual(edited.value, 'Comic.');
  assert.strictEqual(edited.dirty, true);
  assert.strictEqual(tone.dirty, false, 'the source draft is never mutated');
  assert.deepStrictEqual(assembleRealmV2Inputs([edited]), { tone: { shape: 'text', text: 'Comic.' } });
  assert.deepStrictEqual(assembleRealmV2Inputs(drafts), {}, 'untouched fields stay out of the payload');

  const reset = resetRealmV2InputDraft(edited, V2_TEMPLATE.inputs[1], V2_FILES);
  assert.strictEqual(reset.value, 'Noir.', 'reset restores the declared default');
  assert.strictEqual(reset.dirty, false, 'reset restores untouched presence semantics');

  const notes = drafts[3];
  const withFiles = setRealmV2InputFiles(notes, [
    { path: 'notes.md', content: 'Notes.', name: 'notes.md' },
    { path: 'extra.md', content: 'Extra.', name: '' }
  ]);
  assert.deepStrictEqual(
    assembleRealmV2Inputs([withFiles]),
    { notes: { shape: 'files', files: [{ path: 'notes.md', content: 'Notes.' }, { path: 'extra.md', content: 'Extra.' }] } }
  );
  const cleared = setRealmV2InputFiles(withFiles, []);
  assert.deepStrictEqual(assembleRealmV2Inputs([cleared]), {}, 'an empty fileset cannot be expressed and stays out');
  assert.deepStrictEqual(resetRealmV2InputDraft(withFiles, V2_TEMPLATE.inputs[3], V2_FILES).files, []);

  // Attachment helpers: the file name becomes a safe fileset path, and
  // duplicates gain a numeric suffix.
  const attachment = buildRealmInputAttachment('notes/../evil.md', 'Body');
  assert.strictEqual(attachment.path, 'evil.md');
  assert.strictEqual(attachment.name, 'notes/../evil.md');
  assert.strictEqual(attachment.content, 'Body');
  assert.strictEqual(sanitizeRealmAttachmentPath('/abs/path.md'), 'abs/path.md');
  assert.strictEqual(sanitizeRealmAttachmentPath('..'), '');
  assert.strictEqual(sanitizeRealmAttachmentPath('a\0b'), '');
  assert.strictEqual(buildRealmInputAttachment('', 'x').path, 'file.txt');
  assert.strictEqual(uniqueRealmAttachmentPath(['notes.md'], 'notes.md'), 'notes-2.md');
  assert.strictEqual(uniqueRealmAttachmentPath(['notes.md', 'notes-2.md'], 'notes.md'), 'notes-3.md');
  assert.strictEqual(uniqueRealmAttachmentPath([], 'notes.md'), 'notes.md');
});

test('38. operator-assembled v2 values validate through the synthesized catalog envelope', () => {
  const drafts = buildRealmV2InputDrafts(V2_TEMPLATE, V2_FILES);

  const missing = validateRealmV2InputDrafts(V2_TEMPLATE, drafts, {
    currentVersion: V2_VERSION,
    bundleFiles: V2_FILES
  });
  assert.strictEqual(missing.ok, false);
  assert.strictEqual(missing.code, 'missing-required');
  assert.match(missing.fieldErrors.briefing, /required/);
  assert.match(missing.fieldErrors.roster, /required/);
  assert.deepStrictEqual(missing.launchInputs, {}, 'nothing travels while the required inputs are empty');

  const filled = filledV2Drafts();
  const ok = validateRealmV2InputDrafts(V2_TEMPLATE, filled, { currentVersion: V2_VERSION, bundleFiles: V2_FILES });
  assert.strictEqual(ok.ok, true, ok.error);
  assert.strictEqual(ok.code, '');
  assert.deepStrictEqual(
    Object.keys(ok.launchInputs).sort(),
    ['briefing', 'roster'],
    'edited fields plus required fields the payload does not provide travel explicitly'
  );
  assert.deepStrictEqual(ok.payload, {
    formatVersion: 2,
    templateId: V2_TEMPLATE.id,
    templateVersion: V2_VERSION,
    inputs: {
      briefing: { text: 'Write the story.' },
      roster: { files: [{ path: 'index.md', content: 'Index.' }] }
    }
  });
  assert.strictEqual(ok.effectiveInputs.tone.shape, 'text');
  assert.strictEqual(ok.effectiveInputs.tone.text, 'Noir.', 'declared defaults resolve into the effective view');
  assert.strictEqual(ok.effectiveInputs.house_style.text, 'Terse.');
  assert.strictEqual(ok.effectiveInputs.notes.shape, 'files');
  assert.deepStrictEqual(ok.effectiveInputs.notes.files, []);
  assert.deepStrictEqual(
    ok.resolved.map((entry) => entry.source),
    ['launch', 'default', 'defaultFile', 'empty', 'launch']
  );

  // Realm opacity: the projection's failure text and envelope never carry a
  // canonical workspace key.
  const rendered = JSON.stringify({ missing, ok });
  assert.ok(!rendered.includes('realm:'), 'no canonical workspace key leaks through the projection');
  assert.ok(!rendered.includes('realm_l4'), 'no realm id leaks through the projection');

  assert.strictEqual(
    validateRealmV2InputDrafts(null, drafts).code,
    'invalid-template',
    'no selection fails closed before any value is assembled'
  );
  const unversioned = validateRealmV2InputDrafts(V2_TEMPLATE, filled, { currentVersion: null, bundleFiles: V2_FILES });
  assert.strictEqual(unversioned.code, 'pin-mismatch', 'an unversionable bundle blocks the launch');
});

test('39. attached payload failures surface typed (pin mismatch, unknown input, shape mismatch)', () => {
  const filled = filledV2Drafts();

  const mismatch = validateRealmV2InputDrafts(V2_TEMPLATE, filled, {
    currentVersion: V2_VERSION,
    bundleFiles: V2_FILES,
    payload: v2Payload({ briefing: { text: 'B' }, roster: { files: [{ path: 'index.md', content: 'I' }] } }, 'sha256:other')
  });
  assert.strictEqual(mismatch.ok, false);
  assert.strictEqual(mismatch.code, 'pin-mismatch');
  assert.match(mismatch.error, /pins template version/);

  const mismatchAllowed = validateRealmV2InputDrafts(V2_TEMPLATE, filled, {
    currentVersion: V2_VERSION,
    bundleFiles: V2_FILES,
    allowVersionMismatch: true,
    payload: v2Payload({ briefing: { text: 'B' }, roster: { files: [{ path: 'index.md', content: 'I' }] } }, 'sha256:other')
  });
  assert.strictEqual(mismatchAllowed.ok, true, mismatchAllowed.error);

  const unknown = validateRealmV2InputDrafts(V2_TEMPLATE, filled, {
    currentVersion: V2_VERSION,
    bundleFiles: V2_FILES,
    payload: v2Payload({
      briefing: { text: 'B' },
      roster: { files: [{ path: 'index.md', content: 'I' }] },
      ghost: { text: 'x' }
    })
  });
  assert.strictEqual(unknown.code, 'unknown-input');
  assert.match(unknown.fieldErrors.ghost, /undeclared input/);

  const shape = validateRealmV2InputDrafts(V2_TEMPLATE, filled, {
    currentVersion: V2_VERSION,
    bundleFiles: V2_FILES,
    payload: v2Payload({
      briefing: { files: [{ path: 'a.md', content: 'A' }] },
      roster: { files: [{ path: 'index.md', content: 'I' }] }
    })
  });
  assert.strictEqual(shape.code, 'shape-mismatch');
  assert.match(shape.fieldErrors.briefing, /unknown field 'files'/);

  // A payload-provided required input is not duplicated into the explicit
  // launch values (the payload value applies; an edit would win per key).
  const payloadOnly = validateRealmV2InputDrafts(V2_TEMPLATE, [], {
    currentVersion: V2_VERSION,
    bundleFiles: V2_FILES,
    payload: v2Payload({ briefing: { text: 'B' }, roster: { files: [{ path: 'index.md', content: 'I' }] } })
  });
  assert.strictEqual(payloadOnly.ok, true, payloadOnly.error);
  assert.deepStrictEqual(payloadOnly.launchInputs, {}, 'untouched fields stay omitted so the payload applies');
  assert.deepStrictEqual(payloadOnly.effectiveInputs.briefing, { shape: 'text', text: 'B' });
});

test('40. fileset attachments validate against path placements, selections, and requiredness', () => {
  const drafts = buildRealmV2InputDrafts(V2_TEMPLATE, V2_FILES);
  const byId = Object.fromEntries(drafts.map((draft) => [draft.id, draft]));

  // A root placement accepts any count (the prompt's "index.md" selection
  // must still be present in the non-empty fileset).
  const rosterRoot = setRealmV2InputFiles(byId.roster, [
    { path: 'index.md', content: 'I', name: 'index.md' },
    { path: 'b.md', content: 'B', name: 'b.md' }
  ]);
  assert.strictEqual(validateRealmInputAttachments(V2_TEMPLATE, [rosterRoot]).ok, true);

  // A path placement writes exactly one file.
  const notesTwo = setRealmV2InputFiles(byId.notes, [
    { path: 'a.md', content: 'A', name: 'a.md' },
    { path: 'b.md', content: 'B', name: 'b.md' }
  ]);
  const twoIssue = validateRealmInputAttachments(V2_TEMPLATE, [rosterRoot, notesTwo]);
  assert.strictEqual(twoIssue.ok, false);
  assert.strictEqual(twoIssue.issues[0].code, 'path-placement-count');
  assert.match(twoIssue.fieldErrors.notes, /exactly one file/);
  assert.strictEqual(
    validateRealmInputAttachments(V2_TEMPLATE, [rosterRoot, setRealmV2InputFiles(byId.notes, [])]).ok,
    true,
    'an absent optional fileset writes nothing'
  );

  // The scribe prompt selects "notes.md": a non-empty fileset must carry it.
  const selectionMissing = setRealmV2InputFiles(byId.notes, [{ path: 'other.md', content: 'O', name: 'other.md' }]);
  const selectionIssue = validateRealmInputAttachments(V2_TEMPLATE, [rosterRoot, selectionMissing]);
  assert.ok(selectionIssue.issues.some((issue) => issue.code === 'selection-missing'));
  assert.strictEqual(
    validateRealmInputAttachments(V2_TEMPLATE, [rosterRoot, setRealmV2InputFiles(byId.notes, [{ path: 'notes.md', content: 'N', name: 'notes.md' }])]).ok,
    true
  );

  // Unsafe and duplicate fileset paths fail closed.
  const unsafe = setRealmV2InputFiles(byId.notes, [{ path: '../escape.md', content: 'X', name: '' }]);
  assert.strictEqual(validateRealmInputAttachments(V2_TEMPLATE, [unsafe]).issues[0].code, 'unsafe-path');
  const duplicate = setRealmV2InputFiles(byId.notes, [
    { path: 'notes.md', content: 'A', name: '' },
    { path: 'notes.md', content: 'B', name: '' }
  ]);
  assert.ok(validateRealmInputAttachments(V2_TEMPLATE, [duplicate]).issues.some((issue) => issue.code === 'duplicate-path'));

  // A required files input needs a non-empty fileset.
  const emptyRoster = setRealmV2InputFiles(byId.roster, []);
  const requiredIssue = validateRealmInputAttachments(V2_TEMPLATE, [emptyRoster]);
  assert.strictEqual(requiredIssue.issues[0].code, 'required-empty');
  assert.match(requiredIssue.fieldErrors.roster, /required/);
  const emptyContent = setRealmV2InputFiles(byId.roster, [{ path: 'index.md', content: '  ', name: '' }]);
  assert.strictEqual(validateRealmInputAttachments(V2_TEMPLATE, [emptyContent]).issues[0].code, 'required-empty');

  assert.strictEqual(validateRealmInputAttachments(null, null).ok, true);
});

test('41. the v2 seed summary and slot views render placements and directives natively', () => {
  const summary = buildRealmSeedSummary(V2_TEMPLATE);
  assert.strictEqual(summary.declaresSeed, true);
  assert.strictEqual(summary.placementCount, 4);
  assert.strictEqual(summary.directiveCount, 2);
  assert.strictEqual(summary.fileCount, 4);
  assert.deepStrictEqual(
    summary.targetLabels,
    ['Realm-global workspace', 'Lead (lead)', 'Scribe (scribe)'],
    'distinct placement targets in first-appearance order'
  );
  assert.deepStrictEqual(summary.directive, {
    targetAgentKey: 'lead',
    targetLabel: 'Lead (lead)',
    preview: 'input "Briefing"'
  });

  const slots = buildRealmSeedSlotViews(V2_TEMPLATE);
  assert.deepStrictEqual(slots.map((slot) => slot.path), ['handoff/README.md', 'handoff/notes.md', 'roster/', 'style/tone.md']);
  assert.deepStrictEqual(slots.map((slot) => slot.origin), ['fixed', 'user', 'generated', 'fixed']);
  assert.deepStrictEqual(slots.map((slot) => slot.targetKind), ['realm', 'realm', 'agent', 'agent']);
  assert.deepStrictEqual(slots.map((slot) => slot.targetLabel), [
    'Realm-global workspace',
    'Realm-global workspace',
    'Lead (lead)',
    'Scribe (scribe)'
  ]);
  assert.deepStrictEqual(slots.map((slot) => slot.sourceLabel), [
    'bundle file files/readme.md',
    'input "Handoff notes" — exactly one attached file',
    'input "Roster files" — every attached file under roster/',
    'input "Tone" — inline template default'
  ]);
  assert.deepStrictEqual(slots.map((slot) => slot.brief), ['', 'Attach notes.', '', '']);
  assert.ok(
    !JSON.stringify(slots).includes('realm:'),
    'placement labels never leak a canonical workspace key'
  );

  assert.deepStrictEqual(buildRealmSeedSummary({ ...V2_TEMPLATE, placements: [], directives: [] }), {
    declaresSeed: false,
    fileCount: 0,
    targetLabels: [],
    directive: null
  });
  assert.deepStrictEqual(buildRealmSeedSlotViews({ ...V2_TEMPLATE, placements: [] }), []);
});

test('42. the v2 files dialog resolves placements from launch values, payloads, and bundles', () => {
  const explicit = {
    briefing: { shape: 'text', text: 'Write.' },
    notes: { shape: 'files', files: [{ path: 'notes.md', content: 'Notes.' }] },
    roster: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }, { path: 'extra.md', content: 'Extra.' }] }
  };
  const slots = buildRealmReviewFileSlots(V2_TEMPLATE, V2_FILES, { inputs: explicit });
  assert.deepStrictEqual(slots.map((slot) => slot.path), [
    'handoff/README.md',
    'handoff/notes.md',
    'roster/index.md',
    'roster/extra.md',
    'style/tone.md'
  ]);
  assert.deepStrictEqual(slots.map((slot) => slot.contentSource), [
    'bundle-file',
    'input',
    'input',
    'input',
    'bundle-inline'
  ]);
  assert.deepStrictEqual(slots.map((slot) => slot.content), [
    'Handoff readme.',
    'Notes.',
    'Index.',
    'Extra.',
    'Noir.'
  ]);
  assert.deepStrictEqual(slots.map((slot) => slot.source), ['bundle', 'input', 'input', 'input', 'input']);
  assert.ok(slots.every((slot) => slot.editable === false), 'v2 slots stay read-only — editing happens at the input');
  assert.strictEqual(slots[1].inputId, 'notes');
  assert.strictEqual(slots[1].inputLabel, 'Handoff notes');
  assert.strictEqual(slots[2].required, true, 'the required roster input marks its placement slots');
  assert.ok(slots.every((slot) => slot.conflict === false));
  assert.ok(!JSON.stringify(slots).includes('realm:'), 'no canonical workspace key appears in slot labels');

  // A root placement with no files attached renders one honest placeholder.
  const emptyRoot = buildRealmReviewFileSlots(V2_TEMPLATE, V2_FILES, {
    inputs: { roster: { shape: 'files', files: [] } }
  });
  assert.strictEqual(emptyRoot[2].path, 'roster/');
  assert.strictEqual(emptyRoot[2].contentSource, 'absent');
  assert.match(emptyRoot[2].sourceLabel, /no files attached/);

  // A path placement with several files is flagged instead of guessing.
  const conflict = buildRealmReviewFileSlots(V2_TEMPLATE, V2_FILES, {
    inputs: {
      notes: { shape: 'files', files: [{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B' }] },
      roster: { shape: 'files', files: [{ path: 'index.md', content: 'I' }] }
    }
  });
  assert.strictEqual(conflict[1].conflict, true);
  assert.match(conflict[1].sourceLabel, /needs exactly one/);

  // An attached v2 payload resolves the input placements (bundle stays fixed).
  const payload = v2Payload({
    notes: { files: [{ path: 'notes.md', content: 'Payload notes.' }] },
    roster: { files: [{ path: 'index.md', content: 'Payload index.' }] }
  });
  const fromPayload = buildRealmReviewFileSlots(V2_TEMPLATE, V2_FILES, { payload });
  assert.strictEqual(fromPayload[1].content, 'Payload notes.');
  assert.strictEqual(fromPayload[1].contentSource, 'payload');
  assert.match(fromPayload[1].sourceLabel, /attached payload/);
  assert.strictEqual(fromPayload[2].content, 'Payload index.');

  // Explicit launch values win over the payload per input.
  const merged = buildRealmReviewFileSlots(V2_TEMPLATE, V2_FILES, {
    payload,
    inputs: { notes: { shape: 'files', files: [{ path: 'notes.md', content: 'Launch notes.' }] } }
  });
  assert.strictEqual(merged[1].content, 'Launch notes.');
  assert.strictEqual(merged[1].contentSource, 'input');
  assert.strictEqual(merged[2].content, 'Payload index.', 'untouched inputs keep the payload value');

  // A missing bundle file is reported honestly.
  const missing = buildRealmReviewFileSlots(V2_TEMPLATE, {}, {});
  assert.strictEqual(missing[0].contentSource, 'bundle-missing');
  assert.match(missing[0].sourceLabel, /missing/);

  assert.deepStrictEqual(buildRealmReviewFileSlots({ ...V2_TEMPLATE, placements: [] }, {}, {}), []);
});

test('43. v2 prompt and history projections resolve files selections through the real catalog', () => {
  const spec = V2_TEMPLATE.agents[0];
  const inputs = {
    briefing: { shape: 'text', text: 'Write.' },
    tone: { shape: 'text', text: 'Noir.' },
    house_style: { shape: 'text', text: 'Terse.' },
    roster: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }] }
  };

  const preview = buildRealmPromptPreview(spec.prompt, V2_TEMPLATE.inputs, { inputs, bundleFiles: V2_FILES });
  assert.strictEqual(preview.ok, true, preview.error);
  assert.strictEqual(preview.systemPrompt, 'Lead protocol.\n\nWrite.\n\nNoir.\n\nTerse.\n\nIndex.');

  const plan = materializeTemplate(V2_TEMPLATE, { realmId: 'realm_l4', inputs, bundleFiles: V2_FILES });
  assert.strictEqual(preview.systemPrompt, plan.agents[0].systemPrompt, 'the preview equals the materialized prompt');
  assert.deepStrictEqual(preview.inputProvenance, plan.agents[0].inputProvenance);

  const parts = buildRealmPartProvenanceViews(spec.prompt, V2_TEMPLATE.inputs, { inputs, bundleFiles: V2_FILES });
  assert.strictEqual(parts.ok, true, parts.error);
  assert.deepStrictEqual(parts.parts.map((part) => part.kind), ['file', 'input', 'input', 'input', 'input']);
  assert.strictEqual(parts.parts[4].path, 'index.md');
  assert.strictEqual(parts.parts[4].content, 'Index.', 'the selected fileset file resolves by path');
  assert.strictEqual(parts.parts[4].label, 'input "Roster files" — "index.md"');
  assert.strictEqual(parts.parts[1].required, true);

  const history = buildRealmHistoryEditorViews(spec, V2_TEMPLATE.inputs, { inputs, bundleFiles: V2_FILES });
  assert.strictEqual(history.ok, true, history.error);
  assert.deepStrictEqual(
    history.entries.map((entry) => entry.content),
    plan.agents[0].history.map((message) => message.content),
    'the history review equals the seeded history'
  );

  // The scribe's prompt selects one file of the optional fileset.
  const scribe = V2_TEMPLATE.agents[1];
  const scribePreview = buildRealmPromptPreview(scribe.prompt, V2_TEMPLATE.inputs, {
    inputs: { notes: { shape: 'files', files: [{ path: 'notes.md', content: 'Notes.' }] } },
    bundleFiles: V2_FILES
  });
  assert.strictEqual(scribePreview.systemPrompt, 'Notes.');
  const noNotes = buildRealmPromptPreview(scribe.prompt, V2_TEMPLATE.inputs, { inputs: {}, bundleFiles: V2_FILES });
  assert.strictEqual(noNotes.ok, true, 'an absent optional fileset contributes nothing');

  const wrongSelection = buildRealmPromptPreview(scribe.prompt, V2_TEMPLATE.inputs, {
    inputs: { notes: { shape: 'files', files: [{ path: 'other.md', content: 'Other.' }] } },
    bundleFiles: V2_FILES
  });
  assert.strictEqual(wrongSelection.ok, false);
  assert.match(wrongSelection.error, /has no file 'notes\.md'/);
  assert.strictEqual(
    buildRealmPartProvenanceViews(scribe.prompt, V2_TEMPLATE.inputs, {
      inputs: { notes: { shape: 'files', files: [{ path: 'other.md', content: 'Other.' }] } },
      bundleFiles: V2_FILES
    }).ok,
    false,
    'a missing selection fails the part projection inline'
  );
});

test('44. edited review slots assemble into the launch payload and validate with the edited content', () => {
  const version = templateBundleVersion({ template: REVIEW_TEMPLATE, files: REVIEW_FILES });
  const source = reviewPayload(version);

  // Unedited: the source attaches verbatim (the digest stays the submitter's).
  const uneditedSlots = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, { payload: source });
  const unedited = resolveRealmReviewLaunchPayload({
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    source,
    slots: uneditedSlots
  });
  assert.deepStrictEqual(unedited, { edited: false, payload: source, blocked: false, error: '' });

  // Edited: the package is rebuilt from the current slots and the edited
  // content survives real catalog validation against the effective template.
  const editedSlots = buildRealmReviewFileSlots(REVIEW_TEMPLATE, REVIEW_FILES, { payload: source }).map(
    (slot) => (slot.path === 'lore/world.md'
      ? { ...slot, edited: true, content: 'Edited world lore.', contentSource: 'review' }
      : slot)
  );
  const edited = resolveRealmReviewLaunchPayload({
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    source,
    slots: editedSlots
  });
  assert.strictEqual(edited.edited, true);
  assert.strictEqual(edited.blocked, false, edited.error);
  assert.notStrictEqual(edited.payload, source, 'an edited review rebuilds the package');
  assert.deepStrictEqual(
    edited.payload.files,
    [
      { path: 'lore/world.md', target: 'realm', content: 'Edited world lore.' },
      { path: 'notes/tone.md', target: { agent: 'narrator' }, content: 'User tone notes.' }
    ],
    'the assembled payload carries the edit and keeps unedited slot content'
  );

  const resolved = validatePayload(REVIEW_TEMPLATE, edited.payload, { currentVersion: version });
  assert.strictEqual(resolved.templateId, REVIEW_TEMPLATE.id);
  assert.deepStrictEqual(resolved.inputs.premise, { shape: 'text', text: 'A premise.' });
  const filesetFiles = Object.values(resolved.inputs).flatMap((value) => (
    value.shape === 'files' ? value.files : []
  ));
  assert.ok(
    filesetFiles.some((file) => file.path === 'lore/world.md' && file.content === 'Edited world lore.'),
    'the edited slot content resolves through the real catalog'
  );
  assert.ok(
    filesetFiles.some((file) => file.path === 'notes/tone.md' && file.content === 'User tone notes.'),
    'unedited slots keep the payload content'
  );

  // Edits with an unversionable bundle block instead of dropping the edits.
  const unversioned = resolveRealmReviewLaunchPayload({
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: null,
    source,
    slots: editedSlots
  });
  assert.strictEqual(unversioned.blocked, true);
  assert.strictEqual(unversioned.payload, null);
  assert.match(unversioned.error, /could not be assembled/);

  // A declared placement conflict blocks the gate with the slot's own label.
  const conflictSlots = buildRealmReviewFileSlots(V2_TEMPLATE, V2_FILES, {
    inputs: {
      notes: { shape: 'files', files: [{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B' }] }
    }
  });
  const conflict = resolveRealmReviewLaunchPayload({
    templateId: V2_TEMPLATE.id,
    templateVersion: V2_VERSION,
    source: null,
    slots: conflictSlots
  });
  assert.strictEqual(conflict.blocked, true);
  assert.strictEqual(conflict.payload, null);
  assert.match(conflict.error, /cannot resolve/);
  assert.match(conflict.error, /needs exactly one/);

  // No source and no edits attaches nothing (never a phantom package).
  const nothing = resolveRealmReviewLaunchPayload({
    templateId: REVIEW_TEMPLATE.id,
    templateVersion: version,
    source: null,
    slots: uneditedSlots
  });
  assert.deepStrictEqual(nothing, { edited: false, payload: null, blocked: false, error: '' });
});

/**
 * Red-first repro for ticket 0ea4c2b: the attachment gate must validate the
 * *effective* filesets (attached payload values included), not the operator
 * drafts alone — otherwise a payload that satisfies a required `files` input
 * still blocks the launch with the required-empty error.
 */
test('45. payload-provided filesets satisfy the attachment gate (0ea4c2b)', () => {
  const drafts = buildRealmV2InputDrafts(V2_TEMPLATE, V2_FILES);
  const rosterDraft = drafts.find((draft) => draft.id === 'roster');

  // A required files input with an empty draft but a payload-provided fileset
  // passes the composition gate.
  const satisfied = validateRealmInputAttachments(V2_TEMPLATE, drafts, {
    inputs: {
      roster: {
        shape: 'files',
        files: [
          { path: 'index.md', content: 'Index.' },
          { path: 'lore.md', content: 'Lore.' }
        ]
      }
    }
  });
  assert.strictEqual(satisfied.ok, true, JSON.stringify(satisfied.issues));

  // The same input with neither source still fails required-empty.
  const missing = validateRealmInputAttachments(V2_TEMPLATE, drafts);
  assert.ok(
    missing.issues.some((issue) => issue.code === 'required-empty' && issue.inputId === 'roster'),
    JSON.stringify(missing.issues)
  );
  assert.match(missing.fieldErrors.roster, /required/);

  // An effective fileset of empty bodies still fails required-empty.
  const emptyContent = validateRealmInputAttachments(V2_TEMPLATE, drafts, {
    inputs: { roster: { shape: 'files', files: [{ path: 'index.md', content: '  ' }] } }
  });
  assert.strictEqual(emptyContent.issues[0].code, 'required-empty');
  assert.match(emptyContent.issues[0].error, /empty/);

  // The composition checks see the effective values too: an effective fileset
  // missing the prompt's `path` selection fails, and two effective files for a
  // `path` destination fail.
  const selectionMissing = validateRealmInputAttachments(V2_TEMPLATE, drafts, {
    inputs: { roster: { shape: 'files', files: [{ path: 'other.md', content: 'Other.' }] } }
  });
  assert.ok(
    selectionMissing.issues.some((issue) => issue.code === 'selection-missing' && issue.path === 'index.md'),
    JSON.stringify(selectionMissing.issues)
  );

  const pathCount = validateRealmInputAttachments(V2_TEMPLATE, drafts, {
    inputs: {
      roster: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }] },
      notes: {
        shape: 'files',
        files: [
          { path: 'a.md', content: 'A' },
          { path: 'b.md', content: 'B' }
        ]
      }
    }
  });
  assert.ok(
    pathCount.issues.some((issue) => issue.code === 'path-placement-count' && issue.inputId === 'notes'),
    JSON.stringify(pathCount.issues)
  );

  // Draft-only callers keep the exact previous behavior (no options argument).
  const draftOnly = validateRealmInputAttachments(V2_TEMPLATE, [
    setRealmV2InputFiles(rosterDraft, [{ path: 'index.md', content: 'Index.', name: 'index.md' }])
  ]);
  assert.strictEqual(draftOnly.ok, true, JSON.stringify(draftOnly.issues));
  assert.strictEqual(
    validateRealmInputAttachments(V2_TEMPLATE, [setRealmV2InputFiles(rosterDraft, [])]).issues[0].code,
    'required-empty'
  );
});
