/**
 * @file tests/unit/realm_hydration_helpers_test.js
 * @description Zero-mock unit tests for the template-hydration workspace
 * helpers (ticket 874182b): the per-input requirement reviews and fileset
 * placement mapping built over the real `realmCatalog` usage map, the
 * directive review resolved through the catalog's own `resolveDirectives`, the
 * canonical payload digest/pin projection, the saved-payload name rules, the
 * rehydrate plan (real `validatePayload` + `materializeTemplate`), and the
 * session saved-payload library.
 *
 * Every fixture is a real baked bundle (`session_zero`) or a template validated
 * through the real `validateTemplate`; no function under test is stubbed.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getBakedTemplateBundle,
  materializeTemplate,
  payloadDigest,
  templateBundleVersion,
  validateTemplate
} from '../../src/lib/sandbox/realmCatalog/index.ts';
import {
  buildRealmInputUsageMap,
  buildRealmV2InputDrafts
} from '../../src/lib/components/sandbox/realmLauncherHelpers.ts';
import {
  buildRealmDirectiveReview,
  buildRealmFileAttachmentViews,
  buildRealmHydrationPinView,
  buildRealmInputPlacementDestinations,
  buildRealmInputRequirementReviews,
  buildRealmProvenanceDetailView,
  buildRealmRehydratePlan,
  buildRealmSavedPayloadFilename,
  describeRealmPayloadInputs,
  describeRealmRehydrateOutcome,
  formatRealmByteSize,
  utf8ByteLength,
  validateRealmSavedPayloadName
} from '../../src/lib/components/sandbox/realmHydrationHelpers.ts';
import { createRealmPayloadLibrary } from '../../src/lib/components/sandbox/realmPayloadLibrary.ts';

const SESSION_BUNDLE = getBakedTemplateBundle('session_zero');
const SESSION_TEMPLATE = SESSION_BUNDLE.template;
const SESSION_FILES = SESSION_BUNDLE.files;
const SESSION_VERSION = templateBundleVersion({ template: SESSION_TEMPLATE, files: SESSION_FILES });

/** A real validated variant of the baked template that declares one directive. */
const DIRECTIVE_TEMPLATE = validateTemplate({
  ...SESSION_TEMPLATE,
  directives: [{ inputId: 'target_template', target: { agent: 'genesis' } }]
});

const SESSION_MEMBERS = Object.freeze([
  { id: 'architect', name: 'Architect' },
  { id: 'genesis', name: 'Genesis' }
]);

/** Builds a valid authored payload for the baked template. */
function sessionPayload(overrides = {}) {
  return {
    formatVersion: 2,
    templateId: 'session_zero',
    templateVersion: SESSION_VERSION,
    inputs: {
      assignment: { text: 'Draft the realm.' },
      ...overrides
    }
  };
}

test('formatRealmByteSize and utf8ByteLength describe attachment sizes', () => {
  assert.equal(formatRealmByteSize(0), '0 B');
  assert.equal(formatRealmByteSize(512), '512 B');
  assert.equal(formatRealmByteSize(1536), '1.5 KiB');
  assert.equal(formatRealmByteSize(2 * 1024 * 1024), '2.0 MiB');
  assert.equal(formatRealmByteSize(-4), '0 B');
  assert.equal(formatRealmByteSize('nope'), '0 B');
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('é'), 2);
  assert.equal(utf8ByteLength(''), 0);
  assert.equal(utf8ByteLength(null), 0);
});

test('buildRealmInputPlacementDestinations derives placement sites from the real usage map', () => {
  const usage = buildRealmInputUsageMap(SESSION_TEMPLATE);
  const destinations = buildRealmInputPlacementDestinations(usage.get('handoff_notes'));
  assert.equal(destinations.length, 1);
  assert.equal(destinations[0].mode, 'path');
  assert.equal(destinations[0].destination, 'handoff/notes.md');
  assert.equal(destinations[0].targetKind, 'realm');
  assert.equal(destinations[0].targetLabel, 'Realm-global workspace');
  // A prompt-only input has no placement destinations.
  assert.deepEqual(buildRealmInputPlacementDestinations(usage.get('assignment')), []);
});

test('buildRealmFileAttachmentViews maps a single file to its path destination and sizes it', () => {
  const draft = buildRealmV2InputDrafts(SESSION_TEMPLATE, SESSION_FILES)
    .find((entry) => entry.id === 'handoff_notes');
  const destinations = buildRealmInputPlacementDestinations(
    buildRealmInputUsageMap(SESSION_TEMPLATE).get('handoff_notes')
  );
  const views = buildRealmFileAttachmentViews(
    { ...draft, files: [{ path: 'notes.md', content: 'hello', name: 'notes.md' }] },
    destinations
  );
  assert.equal(views.length, 1);
  assert.equal(views[0].sizeBytes, 5);
  assert.equal(views[0].sizeLabel, '5 B');
  assert.deepEqual(views[0].destinations, ['handoff/notes.md']);
});

test('buildRealmFileAttachmentViews joins every file under a root destination', () => {
  const draft = {
    id: 'corpus',
    label: 'Corpus',
    help: '',
    brief: '',
    shape: 'files',
    multiline: false,
    required: false,
    files: [
      { path: 'chapters/one.md', content: 'A', name: 'one.md' },
      { path: 'chapters/two.md', content: 'B', name: 'two.md' }
    ],
    dirty: true,
    usage: { inputId: 'corpus', shape: 'files', required: false, sites: [], summary: '' }
  };
  const destinations = [{
    targetKind: 'agent',
    agentKey: 'scribe',
    targetLabel: 'Scribe (scribe)',
    mode: 'root',
    destination: 'corpus'
  }];
  const views = buildRealmFileAttachmentViews(draft, destinations);
  assert.deepEqual(views.map((view) => view.destinations), [
    ['corpus/chapters/one.md'],
    ['corpus/chapters/two.md']
  ]);
  // A multi-file fileset cannot write a single path destination.
  const pathOnly = buildRealmFileAttachmentViews(draft, [{
    targetKind: 'realm',
    agentKey: '',
    targetLabel: 'Realm-global workspace',
    mode: 'path',
    destination: 'notes.md'
  }]);
  assert.deepEqual(pathOnly.map((view) => view.destinations), [[], []]);
});

test('buildRealmInputRequirementReviews carries label, brief, required, shape and placement mapping', () => {
  const reviews = buildRealmInputRequirementReviews(SESSION_TEMPLATE);
  assert.deepEqual(reviews.map((entry) => entry.id), ['assignment', 'target_template', 'handoff_notes']);
  const assignment = reviews.find((entry) => entry.id === 'assignment');
  assert.equal(assignment.required, true);
  assert.equal(assignment.shape, 'text');
  assert.equal(assignment.usageSummary, '2 system prompt references');
  const notes = reviews.find((entry) => entry.id === 'handoff_notes');
  assert.equal(notes.shape, 'files');
  assert.equal(notes.required, false);
  assert.match(notes.brief, /operator notes/i);
  assert.equal(notes.placements.length, 1);
  assert.equal(notes.placements[0].destination, 'handoff/notes.md');
  assert.deepEqual(buildRealmInputRequirementReviews(null), []);
});

test('buildRealmDirectiveReview resolves bound directives through the catalog resolver', () => {
  const inputs = { target_template: { shape: 'text', text: 'demo_target' } };
  const review = buildRealmDirectiveReview(DIRECTIVE_TEMPLATE, inputs);
  assert.equal(review.ok, true);
  assert.equal(review.entries.length, 1);
  assert.equal(review.entries[0].source, 'input');
  assert.equal(review.entries[0].inputId, 'target_template');
  assert.equal(review.entries[0].inputLabel, 'Target template id');
  assert.equal(review.entries[0].targetAgentKey, 'genesis');
  assert.equal(review.entries[0].targetLabel, 'Genesis (genesis)');
  assert.match(review.entries[0].text, /demo_target/);

  // An optional empty input delivers nothing (no error, empty text).
  const empty = buildRealmDirectiveReview(DIRECTIVE_TEMPLATE, { target_template: { shape: 'text', text: '' } });
  assert.equal(empty.ok, true);
  assert.equal(empty.entries[0].text, '');
  assert.equal(empty.entries[0].error, '');

  // A malformed template reports honestly instead of throwing.
  const malformed = buildRealmDirectiveReview({ formatVersion: 2 }, {});
  assert.equal(malformed.ok, false);
  assert.match(malformed.error, /could not be validated/);
  assert.deepEqual(malformed.entries, []);
});

test('buildRealmHydrationPinView digests the reviewed payload and counts content', () => {
  const payload = sessionPayload({ handoff_notes: { files: [{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B' }] } });
  const view = buildRealmHydrationPinView({
    templateId: 'session_zero',
    templateVersion: SESSION_VERSION,
    payload,
    sourceLabel: 'assembled inputs'
  });
  assert.equal(view.visible, true);
  assert.equal(view.digestOk, true);
  assert.equal(view.digest, payloadDigest(payload));
  assert.equal(view.pin, SESSION_VERSION);
  assert.equal(view.inputCount, 2);
  assert.equal(view.fileCount, 2);
  assert.equal(view.sourceLabel, 'assembled inputs');
  // An undigestible value reports failure instead of a fake hash.
  const bad = buildRealmHydrationPinView({ templateId: 'x', payload: () => {} });
  assert.equal(bad.digestOk, false);
  assert.equal(bad.digest, '');
  assert.ok(bad.digestError.length > 0);
});

test('describeRealmPayloadInputs summarises authored payload content', () => {
  assert.equal(describeRealmPayloadInputs(sessionPayload()), '1 input');
  assert.equal(
    describeRealmPayloadInputs(sessionPayload({
      target_template: { text: 'x' },
      handoff_notes: { files: [{ path: 'a.md', content: 'A' }] }
    })),
    '3 inputs · 1 file'
  );
  assert.equal(describeRealmPayloadInputs(null), 'no input values');
});

test('saved-payload names trim, reject blanks, and refuse case-insensitive duplicates', () => {
  assert.deepEqual(validateRealmSavedPayloadName('  Act 1 ', ['Act 2']), { ok: true, error: '', name: 'Act 1' });
  assert.equal(validateRealmSavedPayloadName('   ', []).ok, false);
  const duplicate = validateRealmSavedPayloadName('act 2', ['Act 2']);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /already saved/);
  assert.equal(buildRealmSavedPayloadFilename('Act 1', 'session_zero'), 'session_zero--Act_1.package.json');
  assert.equal(buildRealmSavedPayloadFilename('', ''), 'realm-template--payload.package.json');
});

test('the saved-payload library names, digests, lists, and deletes entries', () => {
  const library = createRealmPayloadLibrary();
  let notifications = 0;
  const unsubscribe = library.subscribe(() => { notifications += 1; });
  const payload = sessionPayload();
  const saved = library.saveRealmPayload({
    name: 'Act 1',
    templateId: 'session_zero',
    templateVersion: SESSION_VERSION,
    payload
  });
  assert.equal(saved.digest, payloadDigest(payload));
  assert.equal(saved.inputSummary, '1 input');
  assert.equal(saved.templateId, 'session_zero');
  assert.equal(notifications, 1);

  assert.equal(library.listRealmSavedPayloads().length, 1);
  assert.equal(library.getRealmSavedPayload(saved.id)?.name, 'Act 1');
  assert.equal(library.getRealmSavedPayload('missing'), null);
  assert.throws(
    () => library.saveRealmPayload({ name: 'act 1', templateId: 'session_zero', templateVersion: SESSION_VERSION, payload }),
    /already saved/
  );
  assert.throws(
    () => library.saveRealmPayload({ name: 'Bad', templateId: 'session_zero', templateVersion: SESSION_VERSION, payload: null }),
    /authored payload object/
  );
  assert.equal(library.deleteRealmSavedPayload('missing'), false);
  assert.equal(library.deleteRealmSavedPayload(saved.id), true);
  assert.equal(notifications, 2);
  unsubscribe();
  library.saveRealmPayload({ name: 'Act 2', templateId: 'session_zero', templateVersion: SESSION_VERSION, payload });
  assert.equal(notifications, 2);
  library.clearRealmSavedPayloads();
  assert.equal(library.listRealmSavedPayloads().length, 0);
});

test('buildRealmRehydratePlan validates a payload with the real catalog and groups writes', () => {
  const payload = sessionPayload({
    handoff_notes: { files: [{ path: 'notes.md', content: 'operator notes' }] }
  });
  const plan = buildRealmRehydratePlan({
    template: SESSION_TEMPLATE,
    realmId: 'realm_test',
    payload,
    bundleFiles: SESSION_FILES,
    members: SESSION_MEMBERS,
    currentVersion: SESSION_VERSION
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.templateId, 'session_zero');
  assert.equal(plan.templateVersion, SESSION_VERSION);
  assert.equal(plan.mismatch, false);
  assert.equal(plan.digest, payloadDigest(payload));
  assert.equal(plan.fileCount, 2);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].targetKind, 'realm');
  assert.deepEqual(
    plan.writes[0].files.map((file) => file.path).sort(),
    ['handoff/README.md', 'handoff/notes.md']
  );
  assert.deepEqual(plan.directives, []);
});

test('buildRealmRehydratePlan maps directives to active members and fails closed without one', () => {
  const payload = sessionPayload({ target_template: { text: 'demo_target' } });
  const plan = buildRealmRehydratePlan({
    template: DIRECTIVE_TEMPLATE,
    realmId: 'realm_test',
    payload,
    bundleFiles: SESSION_FILES,
    members: SESSION_MEMBERS,
    currentVersion: SESSION_VERSION
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.directives.length, 1);
  assert.equal(plan.directives[0].agentId, 'genesis');
  assert.equal(plan.directives[0].targetLabel, 'Genesis');

  const missing = buildRealmRehydratePlan({
    template: DIRECTIVE_TEMPLATE,
    realmId: 'realm_test',
    payload,
    bundleFiles: SESSION_FILES,
    members: [{ id: 'architect', name: 'Architect' }],
    currentVersion: SESSION_VERSION
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /Genesis/);
  assert.deepEqual(missing.writes, []);
});

test('buildRealmRehydratePlan reports pin mismatches and invalid payloads inline', () => {
  const stale = { ...sessionPayload(), templateVersion: 'sha256:deadbeef' };
  const rejected = buildRealmRehydratePlan({
    template: SESSION_TEMPLATE,
    realmId: 'realm_test',
    payload: stale,
    members: SESSION_MEMBERS,
    currentVersion: SESSION_VERSION
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /version mismatch|pins template version/i);

  const allowed = buildRealmRehydratePlan({
    template: SESSION_TEMPLATE,
    realmId: 'realm_test',
    payload: stale,
    bundleFiles: SESSION_FILES,
    members: SESSION_MEMBERS,
    currentVersion: SESSION_VERSION,
    allowVersionMismatch: true
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.mismatch, true);
  assert.equal(allowed.warnings.length, 1);

  const unknown = buildRealmRehydratePlan({
    template: SESSION_TEMPLATE,
    realmId: 'realm_test',
    payload: sessionPayload({ ghost: { text: 'x' } }),
    members: SESSION_MEMBERS,
    currentVersion: SESSION_VERSION
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /ghost|unknown input|undeclared/i);
  assert.equal(unknown.digest, '');
});

test('describeRealmRehydrateOutcome folds write and directive receipts into one line', () => {
  const text = describeRealmRehydrateOutcome(
    [
      { targetLabel: 'Realm-global workspace', workspaceLabel: 'the Realm-global workspace', writtenPaths: ['/a.md', '/b.md'] },
      { targetLabel: 'Genesis', workspaceLabel: 'the member workspace "genesis"', writtenPaths: ['/c.md'] }
    ],
    [
      { targetLabel: 'Genesis', delivered: true },
      { targetLabel: 'Architect', delivered: false }
    ]
  );
  assert.match(text, /Wrote 3 files into Realm-global workspace, Genesis\./);
  assert.match(text, /Delivered 1 directive/);
  assert.match(text, /1 directive could not be delivered/);
  assert.equal(describeRealmRehydrateOutcome([], []), 'Nothing was written.');
});

test('buildRealmProvenanceDetailView reads hashes and paths only', () => {
  const view = buildRealmProvenanceDetailView({
    instance: {
      templateId: 'session_zero',
      templateVersion: SESSION_VERSION,
      launchedAt: '2026-09-21T12:00:00.000Z',
      inputHashes: { assignment: 'sha256:abcdef0123456789abcdef0123456789', target_template: 'sha256:short' },
      seedPaths: ['/handoff/README.md']
    }
  });
  assert.equal(view.visible, true);
  assert.deepEqual(view.inputRows.map((row) => row.inputId), ['assignment', 'target_template']);
  assert.match(view.inputRows[0].shortHash, /…$/);
  assert.equal(view.inputRows[1].shortHash, 'sha256:short');
  assert.deepEqual(view.seedPaths, ['/handoff/README.md']);
  assert.deepEqual(buildRealmProvenanceDetailView(null), { visible: false, inputRows: [], seedPaths: [] });
});

test('the rehydrate plan matches the launch materialization agent ids', () => {
  const materialized = materializeTemplate(SESSION_TEMPLATE, {
    realmId: 'realm_test',
    inputs: { assignment: { shape: 'text', text: 'x' } },
    bundleFiles: SESSION_FILES
  });
  const plan = buildRealmRehydratePlan({
    template: SESSION_TEMPLATE,
    realmId: 'realm_test',
    payload: sessionPayload(),
    bundleFiles: SESSION_FILES,
    members: materialized.agents.map((agent) => ({ id: agent.agentId, name: agent.name })),
    currentVersion: SESSION_VERSION
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].files[0].path, 'handoff/README.md');
});
