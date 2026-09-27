/**
 * @file tests/integration/session_zero_generator_realm_test.js
 * @description Wave U lane U-G (ticket 7dc9333) acceptance: the shipped
 *   **Session Zero** generator realm — Architect (`@template:authority`) and
 *   Genesis (`@hydration:authority`) — end to end on the real engine.
 *
 *   Asserted contract:
 *   1. the baked `session_zero` bundle validates through the real catalog,
 *      declares the per-agent authorities, is privileged, and carries the
 *      plumbing tool profiles; the publishing tools stay explicit-grant-only
 *      (never profile-selectable) and the composed prompts carry the protocols
 *      (including the operator-staged `/global/source/` ingress and the
 *      handoff-wake rule);
 *   2. launch review: both declared authorities approved per agent, applied
 *      under the operator principal, recorded in `metaAuthorityGrants`, and the
 *      exact set trusted (`templateAuthorityTrust`); approval additionally
 *      exposes the M5b read tools (`list_templates`/`get_template` to
 *      Architect, `list_hydration_packages` to Genesis) and nothing wider;
 *   3. Architect authors a bundle by reference under `/global/...`, iterates
 *      with `import_realm_template { dry_run: true }` (zero side effects), then
 *      imports for real and hands off the canonical version;
 *   4. Genesis reads the handoff, assembles payload bytes by reference
 *      (`source_file`/`append`), iterates with
 *      `submit_hydration_package { dry_run: true }`, then submits for real and
 *      a pending candidate is stored;
 *   5. the same two-agent flow authors a **format-v2** template leg: declared
 *      placements, one `files` input pinned by multiple
 *      `{ kind: 'input', inputId, path }` prompt parts in order, a v2 payload
 *      with per-entry `{ path, sourceFile }` fileset entries, and a launch that
 *      composes the pinned paths and seeds every declared destination;
 *   6. privilege enables in-realm peer private-workspace reads both ways;
 *   7. the reviewed candidate attaches through the existing launch path and
 *      seeds the instance content.
 *
 * Zero-Mock Verification: real `SandboxStore`/`AgentRuntime`/`VirtualFS`/
 * `MessagingBus` instances and the real tool dispatcher; no fixture triggers a
 * model turn.
 *
 * Standalone: `timeout 180 node tests/integration/session_zero_generator_realm_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import {
  AGENT_AUTHORITIES,
  materializeTemplate,
  templateUnsupportedAuthorities
} from '../../src/lib/sandbox/realmCatalog/index.ts';
import {
  createSandboxToolDispatcher,
  getSandboxToolsSchema
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { getAuthorityToolSchemas } from '../../src/lib/sandbox/tools/descriptors/index.ts';
import {
  PUBLISHING_TOOLS,
  REALM_KNOWLEDGE_TOOLS
} from '../../src/lib/sandbox/tools/constants/index.ts';

/** Shipped generator realm under test. */
const TEMPLATE_ID = 'session_zero';

/** Minimal realm the end-to-end fixture authors, imports, and hydrates (v1 leg). */
const SMOKE_TEMPLATE_ID = 'session-zero-smoke';

/** Format-v2 leg: placements plus a fileset pinned by multiple prompt parts. */
const SMOKE_TEMPLATE_ID_V2 = 'session-zero-smoke-v2';

/** M5b realm-knowledge read tools exposed only by an approved exact authority. */
const LIST_TEMPLATES = REALM_KNOWLEDGE_TOOLS.LIST_TEMPLATES;
const GET_TEMPLATE = REALM_KNOWLEDGE_TOOLS.GET_TEMPLATE;
const LIST_HYDRATION_PACKAGES = REALM_KNOWLEDGE_TOOLS.LIST_HYDRATION_PACKAGES;

/** Plumbing tool names the shipped profiles must carry. */
const PLUMBING_TOOLS = Object.freeze([
  'read_file',
  'write_file',
  'replace_file_content',
  'write_json',
  'json_patch',
  'query_json',
  'concat_files',
  'list_files',
  'grep'
]);

/**
 * Creates an isolated store over its own real runtime substrates.
 *
 * @returns {{ runtime: object, store: object, vfs: object, bus: object }}
 */
function createFixtureStore() {
  // The runtime-owned substrates carry the injected identity port, so the VFS
  // resolves realm-exact identities for peer mounts (the U-P fixture's bare
  // `new VirtualFS()` is enough for own-workspace reads only).
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    runtime,
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  return { runtime, store, vfs: runtime.virtualFs, bus: runtime.messagingBus };
}

/**
 * Builds a dispatcher bound to a launched agent's real identity, workspace
 * view, and the store's publishing port.
 *
 * @param {object} store - Fixture store.
 * @param {object} runtime - Fixture runtime.
 * @param {string} agentId - Bound caller agent id.
 * @returns {Function} Tool dispatcher.
 */
function createDispatcher(store, runtime, agentId) {
  return createSandboxToolDispatcher({
    agentId,
    callerAgentId: agentId,
    identityPort: runtime.createAgentIdentityPort(),
    virtualFs: runtime.virtualFs,
    realmPublishingPort: store.getRealmPublishingPort()
  });
}

/**
 * Runs the full Session Zero worked flow once, lazily: launch with approvals,
 * Architect author → dry-run → import → hand off, Genesis recon → assemble →
 * dry-run → submit, and one private note per member for the peer-read check.
 *
 * Every engine step goes through the real store, VFS, and tool dispatcher; the
 * setup asserts each receipt so a failure localizes to the step that broke.
 *
 * @returns {Promise<object>} Live fixture handles and receipts.
 */
async function createSessionZeroRun() {
  const { runtime, store, vfs } = createFixtureStore();
  const principal = runtime.getOperatorPrincipal();

  const launched = await store.launchRealmFromTemplate(TEMPLATE_ID, {
    inputValues: {
      assignment: 'Author a minimal smoke realm; Genesis hydrates it.',
      target_template: ''
    },
    authorityApprovals: [
      { agentKey: 'architect', authority: AGENT_AUTHORITIES.TEMPLATE },
      { agentKey: 'genesis', authority: AGENT_AUTHORITIES.HYDRATION }
    ],
    trustAuthorities: true
  });
  const architect = launched.agents.find((agent) => agent.id === 'architect');
  const genesis = launched.agents.find((agent) => agent.id === 'genesis');
  assert.ok(architect && genesis, 'both Session Zero members launched');

  const architectDispatcher = createDispatcher(store, runtime, architect.id);
  const genesisDispatcher = createDispatcher(store, runtime, genesis.id);

  // --- Architect: assemble a prompt part with concat_files, write the spec and
  // the transport manifest by reference, dry-run, import, hand off.
  const workDir = `/global/work/${SMOKE_TEMPLATE_ID}`;
  for (const [name, body] of [
    ['keeper_intro.md', '# Keeper protocol\n\nYou keep the harbor lights.'],
    ['keeper_rules.md', '## Rules\n\nNever let the lamp go dark.']
  ]) {
    const written = await architectDispatcher.executeTool('write_file', {
      file_path: `${workDir}/drafts/${name}`,
      content: body
    });
    assert.equal(written.success, true, JSON.stringify(written));
  }
  const joined = await architectDispatcher.executeTool('concat_files', {
    sources: [`${workDir}/drafts/keeper_intro.md`, `${workDir}/drafts/keeper_rules.md`],
    destination: `${workDir}/prompts/keeper.md`,
    separator: '\n\n'
  });
  assert.equal(joined.success, true, JSON.stringify(joined));

  const spec = {
    formatVersion: 1,
    id: SMOKE_TEMPLATE_ID,
    name: 'Session Zero Smoke',
    description: 'Minimal realm authored by the Session Zero end-to-end fixture.',
    inputs: [
      { id: 'premise', label: 'Premise', origin: 'generated', brief: 'One generated premise.' }
    ],
    seed: {
      files: [
        { path: 'lore/world.md', target: 'realm', origin: 'generated', brief: 'World lore.' }
      ]
    },
    agents: [
      {
        key: 'keeper',
        idPattern: 'keeper',
        name: 'Keeper',
        role: 'narrator',
        prompt: [
          { kind: 'file', path: 'prompts/keeper.md' },
          // Format-v2 totality: the declared premise input is consumed here.
          { kind: 'input', inputId: 'premise' }
        ],
        toolProfile: { tools: [] },
        privileged: false
      }
    ]
  };
  const specWrite = await architectDispatcher.executeTool('write_json', {
    file_path: `${workDir}/template.json`,
    data: spec
  });
  assert.equal(specWrite.success, true, JSON.stringify(specWrite));
  const manifestWrite = await architectDispatcher.executeTool('write_json', {
    file_path: `${workDir}/import.manifest.json`,
    data: {
      formatVersion: 1,
      template: spec,
      files: { 'prompts/keeper.md': { sourceFile: `${workDir}/prompts/keeper.md` } }
    }
  });
  assert.equal(manifestWrite.success, true, JSON.stringify(manifestWrite));

  const catalogBefore = store.listRealmTemplates().map((template) => template.id).join(',');
  const importsBefore = JSON.stringify(store.serialize().importedRealmTemplates ?? []);
  const importDry = await architectDispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest_file: `${workDir}/import.manifest.json`,
    dry_run: true
  });
  assert.equal(importDry.success, true, JSON.stringify(importDry));
  assert.equal(importDry.dryRun, true);
  assert.equal(importDry.imported, false);
  assert.equal(store.getRealmTemplateBundle(SMOKE_TEMPLATE_ID), null, 'dry_run imports nothing');
  assert.equal(store.listRealmTemplates().map((template) => template.id).join(','), catalogBefore);
  assert.equal(JSON.stringify(store.serialize().importedRealmTemplates ?? []), importsBefore);

  const importReal = await architectDispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest_file: `${workDir}/import.manifest.json`
  });
  assert.equal(importReal.success, true, JSON.stringify(importReal));
  assert.equal(importReal.imported, true);
  assert.equal(importReal.templateId, SMOKE_TEMPLATE_ID);
  assert.equal(importReal.templateVersion, importDry.templateVersion, 'dry run and real import agree on the version');

  const handoff = await architectDispatcher.executeTool('write_file', {
    file_path: `/global/handoff/${SMOKE_TEMPLATE_ID}.md`,
    content: [
      `templateId: ${SMOKE_TEMPLATE_ID}`,
      `version: ${importReal.templateVersion}`,
      'slots: premise (generated input); lore/world.md (generated, realm)',
      `spec: ${workDir}/template.json`
    ].join('\n')
  });
  assert.equal(handoff.success, true, JSON.stringify(handoff));

  // --- Genesis: read the handoff, assemble the payload by reference
  // (source_file + append), dry-run, submit, report.
  const handoffRead = await genesisDispatcher.executeTool('read_file', {
    file_path: `/global/handoff/${SMOKE_TEMPLATE_ID}.md`
  });
  assert.equal(handoffRead.success, true, JSON.stringify(handoffRead));
  assert.match(handoffRead.content, new RegExp(`templateId: ${SMOKE_TEMPLATE_ID}`));
  assert.match(handoffRead.content, /version: sha256:[0-9a-f]{64}/);

  const loreOne = 'The harbor keeps one lamp lit for the drowned.';
  const loreTwo = 'The keeper never asks the water why.';
  for (const [name, body] of [['part1.md', `${loreOne}\n`], ['part2.md', loreTwo]]) {
    const written = await genesisDispatcher.executeTool('write_file', {
      file_path: `${workDir}/payload/lore/${name}`,
      content: body
    });
    assert.equal(written.success, true, JSON.stringify(written));
  }
  const seeded = await genesisDispatcher.executeTool('write_file', {
    file_path: `${workDir}/payload/lore/world.md`,
    source_file: `${workDir}/payload/lore/part1.md`
  });
  assert.equal(seeded.success, true, JSON.stringify(seeded));
  const appended = await genesisDispatcher.executeTool('write_file', {
    file_path: `${workDir}/payload/lore/world.md`,
    source_file: `${workDir}/payload/lore/part2.md`,
    append: true
  });
  assert.equal(appended.success, true, JSON.stringify(appended));

  const hydrateManifest = {
    templateId: SMOKE_TEMPLATE_ID,
    templateVersion: importReal.templateVersion,
    inputs: { premise: { sourceFile: `${workDir}/payload/lore/world.md` } },
    files: [
      { path: 'lore/world.md', target: 'realm', sourceFile: `${workDir}/payload/lore/world.md` }
    ],
    provenance: { hydrator: 'genesis' }
  };
  const hydrateWrite = await genesisDispatcher.executeTool('write_json', {
    file_path: `${workDir}/hydrate.manifest.json`,
    data: hydrateManifest
  });
  assert.equal(hydrateWrite.success, true, JSON.stringify(hydrateWrite));

  const submitDry = await genesisDispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest_file: `${workDir}/hydrate.manifest.json`,
    dry_run: true
  });
  assert.equal(submitDry.success, true, JSON.stringify(submitDry));
  assert.equal(submitDry.dryRun, true);
  assert.equal(submitDry.stored, false);
  assert.equal(store.getPendingInstancePayload(SMOKE_TEMPLATE_ID), null, 'dry_run stores no candidate');

  const submitReal = await genesisDispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest_file: `${workDir}/hydrate.manifest.json`
  });
  assert.equal(submitReal.success, true, JSON.stringify(submitReal));
  assert.equal(submitReal.stored, true);
  assert.equal(submitReal.templateVersion, importReal.templateVersion);

  // --- Format-v2 leg: the Architect authors placements plus one fileset input
  // pinned by multiple `{ kind: 'input', inputId, path }` prompt parts in order;
  // Genesis hydrates it with per-entry `{ path, sourceFile }` fileset entries.
  const v2WorkDir = `/global/work/${SMOKE_TEMPLATE_ID_V2}`;
  const v2Lore = [
    ['01_open.md', 'The lamp is lit for the drowned.'],
    ['02_close.md', 'The keeper never asks the water why.']
  ];
  for (const [name, body] of v2Lore) {
    const written = await architectDispatcher.executeTool('write_file', {
      file_path: `${v2WorkDir}/drafts/${name}`,
      content: body
    });
    assert.equal(written.success, true, JSON.stringify(written));
  }
  const v2Joined = await architectDispatcher.executeTool('concat_files', {
    sources: [`${v2WorkDir}/drafts/01_open.md`, `${v2WorkDir}/drafts/02_close.md`],
    destination: `${v2WorkDir}/prompts/keeper.md`,
    separator: '\n\n'
  });
  assert.equal(v2Joined.success, true, JSON.stringify(v2Joined));

  const v2Spec = {
    formatVersion: 2,
    id: SMOKE_TEMPLATE_ID_V2,
    name: 'Session Zero Smoke v2',
    description: 'Format-v2 realm authored by the Session Zero end-to-end fixture.',
    inputs: [
      { id: 'premise', label: 'Premise', shape: 'text', brief: 'One premise sentence.', required: true },
      { id: 'lore', label: 'Lore corpus', shape: 'files', brief: 'World lore files, one per chapter.' }
    ],
    placements: [
      { inputId: 'premise', target: 'realm', path: 'premise.md' },
      { inputId: 'lore', target: 'realm', root: 'lore/' }
    ],
    agents: [
      {
        key: 'keeper',
        idPattern: 'keeper',
        name: 'Keeper',
        role: 'narrator',
        prompt: [
          { kind: 'file', path: 'prompts/keeper.md' },
          { kind: 'input', inputId: 'lore', path: '01_open.md' },
          { kind: 'input', inputId: 'lore', path: '02_close.md' },
          { kind: 'input', inputId: 'premise' }
        ],
        toolProfile: { tools: [] },
        privileged: false
      }
    ]
  };
  const v2SpecWrite = await architectDispatcher.executeTool('write_json', {
    file_path: `${v2WorkDir}/template.json`,
    data: v2Spec
  });
  assert.equal(v2SpecWrite.success, true, JSON.stringify(v2SpecWrite));
  const v2ManifestWrite = await architectDispatcher.executeTool('write_json', {
    file_path: `${v2WorkDir}/import.manifest.json`,
    data: {
      formatVersion: 2,
      template: v2Spec,
      files: { 'prompts/keeper.md': { sourceFile: `${v2WorkDir}/prompts/keeper.md` } }
    }
  });
  assert.equal(v2ManifestWrite.success, true, JSON.stringify(v2ManifestWrite));

  const v2ImportDry = await architectDispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest_file: `${v2WorkDir}/import.manifest.json`,
    dry_run: true
  });
  assert.equal(v2ImportDry.success, true, JSON.stringify(v2ImportDry));
  assert.equal(v2ImportDry.imported, false);
  assert.equal(v2ImportDry.sourceFormatVersion, 2);
  assert.equal(store.getRealmTemplateBundle(SMOKE_TEMPLATE_ID_V2), null, 'the v2 dry run imports nothing');

  const v2ImportReal = await architectDispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, {
    manifest_file: `${v2WorkDir}/import.manifest.json`
  });
  assert.equal(v2ImportReal.success, true, JSON.stringify(v2ImportReal));
  assert.equal(v2ImportReal.imported, true);
  assert.equal(v2ImportReal.sourceFormatVersion, 2);
  assert.equal(v2ImportReal.templateVersion, v2ImportDry.templateVersion, 'the v2 dry run and real import agree');
  const v2Bundle = store.getRealmTemplateBundle(SMOKE_TEMPLATE_ID_V2);
  assert.ok(v2Bundle, 'the v2 import is registered');
  assert.equal(v2Bundle.template.formatVersion, 2);
  assert.deepEqual(v2Bundle.template.placements, [
    { inputId: 'premise', target: 'realm', path: 'premise.md' },
    { inputId: 'lore', target: 'realm', root: 'lore/' }
  ]);

  // Hand off with the pinned version. (The wake itself is `send_message`,
  // documented in both protocols; the fixture must not trigger a model turn,
  // so the mail wake path is exercised by the trigger-queue suite instead.)
  const v2HandoffWrite = await architectDispatcher.executeTool('write_file', {
    file_path: `/global/handoff/${SMOKE_TEMPLATE_ID_V2}.md`,
    content: [
      `templateId: ${SMOKE_TEMPLATE_ID_V2}`,
      `version: ${v2ImportReal.templateVersion}`,
      'inputs: premise (text, required); lore (files, optional; prompt pins 01_open.md + 02_close.md)',
      `spec: ${v2WorkDir}/template.json`
    ].join('\n')
  });
  assert.equal(v2HandoffWrite.success, true, JSON.stringify(v2HandoffWrite));

  // --- Genesis (v2 leg): per-entry sourceFile references, cover check against
  // the pinned prompt paths, dry-run, submit.
  const v2PremiseBody = 'One lamp, one keeper, one drowned harbor.';
  const v2PremiseWrite = await genesisDispatcher.executeTool('write_file', {
    file_path: `${v2WorkDir}/payload/premise.md`,
    content: v2PremiseBody
  });
  assert.equal(v2PremiseWrite.success, true, JSON.stringify(v2PremiseWrite));
  for (const [name, body] of v2Lore) {
    const written = await genesisDispatcher.executeTool('write_file', {
      file_path: `${v2WorkDir}/payload/lore/${name}`,
      content: `${body}\n`
    });
    assert.equal(written.success, true, JSON.stringify(written));
  }
  const v2HydrateManifest = {
    formatVersion: 2,
    templateId: SMOKE_TEMPLATE_ID_V2,
    templateVersion: v2ImportReal.templateVersion,
    inputs: {
      premise: { sourceFile: `${v2WorkDir}/payload/premise.md` },
      lore: {
        files: [
          { path: '01_open.md', sourceFile: `${v2WorkDir}/payload/lore/01_open.md` },
          { path: '02_close.md', sourceFile: `${v2WorkDir}/payload/lore/02_close.md` }
        ]
      }
    },
    provenance: {
      producer: 'Genesis',
      generatedAt: '2026-09-27T00:00:00.000Z',
      model: 'fixture',
      reviewedBy: 'fixture'
    }
  };
  const v2HydrateWrite = await genesisDispatcher.executeTool('write_json', {
    file_path: `${v2WorkDir}/hydrate.manifest.json`,
    data: v2HydrateManifest
  });
  assert.equal(v2HydrateWrite.success, true, JSON.stringify(v2HydrateWrite));

  const v2SubmitDry = await genesisDispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest_file: `${v2WorkDir}/hydrate.manifest.json`,
    dry_run: true
  });
  assert.equal(v2SubmitDry.success, true, JSON.stringify(v2SubmitDry));
  assert.equal(v2SubmitDry.dryRun, true);
  assert.equal(v2SubmitDry.stored, false);
  assert.equal(v2SubmitDry.sourceFormatVersion, 2);
  assert.deepEqual(v2SubmitDry.inputIds, ['premise', 'lore']);
  assert.deepEqual(v2SubmitDry.fileEntries, [
    { path: 'lore/01_open.md', target: 'realm' },
    { path: 'lore/02_close.md', target: 'realm' }
  ]);
  assert.equal(store.getPendingInstancePayload(SMOKE_TEMPLATE_ID_V2), null, 'the v2 dry_run stores no candidate');

  const v2SubmitReal = await genesisDispatcher.executeTool(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, {
    manifest_file: `${v2WorkDir}/hydrate.manifest.json`
  });
  assert.equal(v2SubmitReal.success, true, JSON.stringify(v2SubmitReal));
  assert.equal(v2SubmitReal.stored, true);
  assert.equal(v2SubmitReal.sourceFormatVersion, 2);
  assert.equal(v2SubmitReal.templateVersion, v2ImportReal.templateVersion);

  // --- Peer notes: each member writes one private-workspace file.
  const genesisNote = 'genesis private note: candidate ready for review.';
  const architectNote = 'architect private note: smoke bundle imported.';
  const genesisNoteWrite = await genesisDispatcher.executeTool('write_file', {
    file_path: '/notes/genesis.md',
    content: genesisNote
  });
  assert.equal(genesisNoteWrite.success, true, JSON.stringify(genesisNoteWrite));
  const architectNoteWrite = await architectDispatcher.executeTool('write_file', {
    file_path: '/notes/architect.md',
    content: architectNote
  });
  assert.equal(architectNoteWrite.success, true, JSON.stringify(architectNoteWrite));

  return {
    runtime,
    store,
    vfs,
    principal,
    launched,
    architect,
    genesis,
    architectDispatcher,
    genesisDispatcher,
    workDir,
    importDry,
    importReal,
    submitDry,
    submitReal,
    loreOne,
    loreTwo,
    genesisNote,
    architectNote,
    v2WorkDir,
    v2Lore,
    v2PremiseBody,
    v2ImportDry,
    v2ImportReal,
    v2SubmitDry,
    v2SubmitReal
  };
}

/** Lazily created shared run (the fixture is the end-to-end chain itself). */
let sessionZeroRun = null;

/**
 * Returns the shared Session Zero run, creating it on first use.
 *
 * @returns {Promise<object>} Live fixture.
 */
function getSessionZeroRun() {
  if (sessionZeroRun === null) sessionZeroRun = createSessionZeroRun();
  return sessionZeroRun;
}

// ============================================================================
// 1. The baked bundle
// ============================================================================

test('1. the baked session_zero bundle is a valid two-agent generator realm with declared authorities', () => {
  const { store } = createFixtureStore();
  const bundle = store.getRealmTemplateBundle(TEMPLATE_ID);
  assert.ok(bundle, 'the baked session_zero bundle resolves through the store seam');
  const template = bundle.template;
  assert.equal(template.name, 'Session Zero');
  assert.ok(typeof template.description === 'string' && template.description.length > 0);
  assert.ok(typeof template.notes === 'string' && template.notes.length > 0, 'the bundle carries author notes');
  assert.deepEqual(templateUnsupportedAuthorities(template), [], 'every declared authority is known');

  const architectSpec = template.agents.find((agent) => agent.key === 'architect');
  const genesisSpec = template.agents.find((agent) => agent.key === 'genesis');
  assert.ok(architectSpec && genesisSpec, 'both generator agents ship');
  assert.equal(architectSpec.idPattern, 'architect', 'ids are literal and realm-opaque');
  assert.equal(genesisSpec.idPattern, 'genesis');
  assert.equal(architectSpec.privileged, true);
  assert.equal(genesisSpec.privileged, true);
  assert.deepEqual(architectSpec.authorities, [AGENT_AUTHORITIES.TEMPLATE]);
  assert.deepEqual(genesisSpec.authorities, [AGENT_AUTHORITIES.HYDRATION]);

  // Inputs: the optional source_pack ingress is staged under /global/source/,
  // and handoff_notes documents its exactly-one-file placement contract.
  const inputsById = new Map((template.inputs ?? []).map((input) => [input.id, input]));
  assert.deepEqual([...inputsById.keys()], ['assignment', 'target_template', 'handoff_notes', 'source_pack']);
  const sourcePack = inputsById.get('source_pack');
  assert.equal(sourcePack.shape, 'files');
  assert.equal(sourcePack.required, undefined, 'source_pack is optional');
  const handoffNotes = inputsById.get('handoff_notes');
  assert.match(handoffNotes.brief, /exactly one file/, 'the single-file placement contract is documented');
  assert.ok(
    (template.placements ?? []).some(
      (placement) => placement.inputId === 'source_pack' && placement.target === 'realm' && placement.root === 'source/'
    ),
    'source_pack is placed under source/'
  );

  // The publishing tools are explicit-grant-only and outside the canonical
  // taxonomy: no toolProfile selector may name them (U-P decision, ticket
  // 2518510). The profiles carry the file plumbing instead.
  const publishingNames = Object.values(PUBLISHING_TOOLS);
  for (const spec of template.agents) {
    const tools = spec.toolProfile.tools;
    assert.ok(Array.isArray(tools), `${spec.key} declares an explicit tool list`);
    for (const plumbing of PLUMBING_TOOLS) {
      assert.ok(tools.includes(plumbing), `${spec.key} carries the '${plumbing}' plumbing tool`);
    }
    assert.ok(tools.includes('send_message'), `${spec.key} carries the handoff-wake tool`);
    for (const publishing of publishingNames) {
      assert.equal(tools.includes(publishing), false, `${spec.key} never profile-selects '${publishing}'`);
    }
  }

  // The shipped prompts compose through the real materializer and carry the
  // protocols (shared rules, per-agent procedure, launch inputs).
  const plan = materializeTemplate(template, {
    realmId: 'session_zero_probe',
    inputs: {
      assignment: { shape: 'text', text: 'Probe the protocols.' },
      target_template: { shape: 'text', text: '' }
    },
    bundleFiles: bundle.files
  });
  const planWithPack = materializeTemplate(template, {
    realmId: 'session_zero_probe',
    inputs: {
      assignment: { shape: 'text', text: 'Probe the protocols.' },
      target_template: { shape: 'text', text: '' },
      source_pack: {
        shape: 'files',
        files: [
          { path: 'director_protocol.md', content: 'Director protocol.' },
          { path: 'lore/01_open.md', content: 'Opening lore.' }
        ]
      }
    },
    bundleFiles: bundle.files
  });
  assert.deepEqual(
    planWithPack.placements
      .filter((placement) => placement.path.startsWith('source/'))
      .map((placement) => ({ path: placement.path, target: placement.target, content: placement.content })),
    [
      { path: 'source/director_protocol.md', target: 'realm', content: 'Director protocol.' },
      { path: 'source/lore/01_open.md', target: 'realm', content: 'Opening lore.' }
    ],
    'the source pack resolves under source/ at launch composition'
  );
  const architectPrompt = plan.agents.find((agent) => agent.key === 'architect').systemPrompt;
  const genesisPrompt = plan.agents.find((agent) => agent.key === 'genesis').systemPrompt;
  for (const prompt of [architectPrompt, genesisPrompt]) {
    assert.match(prompt, /SESSION ZERO — OPERATIONAL RULES/);
    assert.match(prompt, /operator-owned content/);
    assert.match(prompt, /dry_run/);
    assert.match(prompt, /\/global\/handoff\//);
    assert.match(prompt, /\/global\/source\//);
    assert.match(prompt, /send_message/);
  }
  assert.match(architectPrompt, /ARCHITECT — TEMPLATE AUTHORING PROTOCOL/);
  assert.match(architectPrompt, new RegExp(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE));
  assert.match(architectPrompt, new RegExp(LIST_TEMPLATES));
  assert.match(architectPrompt, new RegExp(GET_TEMPLATE));
  assert.match(genesisPrompt, /GENESIS — PAYLOAD GENERATION PROTOCOL/);
  assert.match(genesisPrompt, new RegExp(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE));
  assert.match(genesisPrompt, new RegExp(LIST_HYDRATION_PACKAGES));
  assert.match(genesisPrompt, /sourceFile/);
  store.destroy();
});

// ============================================================================
// 2. Launch approvals, grants, trust, and the seeded handoff surface
// ============================================================================

test('2. launch approvals apply and record both grants and trust the exact set', async () => {
  const run = await getSessionZeroRun();
  const { store, runtime, launched, architect, genesis } = run;
  assert.notEqual(launched.realm.id, '', 'the launch minted a realm');

  const identityPort = runtime.createAgentIdentityPort();
  const architectIdentity = identityPort.getAgentIdentity(architect.id, { realmId: launched.realm.id });
  const genesisIdentity = identityPort.getAgentIdentity(genesis.id, { realmId: launched.realm.id });
  assert.ok([...architectIdentity.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE));
  assert.equal([...architectIdentity.authority.allow].includes(AGENT_AUTHORITIES.HYDRATION), false);
  assert.ok([...genesisIdentity.authority.allow].includes(AGENT_AUTHORITIES.HYDRATION));
  assert.equal([...genesisIdentity.authority.allow].includes(AGENT_AUTHORITIES.TEMPLATE), false);

  const grants = store.listMetaAuthorityGrants();
  assert.equal(grants.template.length, 1, 'the architect grant is recorded under the operator principal');
  assert.equal(grants.hydration.length, 1);
  assert.match(grants.template[0], /:architect$/);
  assert.match(grants.hydration[0], /:genesis$/);
  assert.deepEqual(Object.assign({}, store.listTemplateAuthorityTrust()[TEMPLATE_ID]), {
    architect: [AGENT_AUTHORITIES.TEMPLATE],
    genesis: [AGENT_AUTHORITIES.HYDRATION]
  });

  // The fixed seed file landed in the realm-global workspace; the absent user
  // slot was skipped.
  const readme = run.vfs.getFileRecord('/handoff/README.md', {
    workspaceId: `realm:${launched.realm.id}:global`,
    callerAgentId: architect.id,
    principal: run.principal
  });
  assert.ok(readme, 'the fixed handoff README was seeded');
  assert.match(readme.content, /handoff directory/);
  assert.equal(
    run.vfs.getFileRecord('/handoff/notes.md', {
      workspaceId: `realm:${launched.realm.id}:global`,
      callerAgentId: architect.id,
      principal: run.principal
    }),
    null,
    'the optional user slot is skipped when no file is attached'
  );
});

// ============================================================================
// 3. Architect: dry-run, import, handoff
// ============================================================================

test('3. Architect imports a minimal bundle through dry-run then real, and hands off the pinned version', async () => {
  const run = await getSessionZeroRun();
  const { store, importDry, importReal } = run;
  assert.equal(importDry.dryRun, true);
  assert.equal(importDry.imported, false);
  assert.equal(importReal.imported, true);
  assert.equal(importReal.source, 'imported');
  assert.equal(importReal.templateVersion, importDry.templateVersion);
  const bundle = store.getRealmTemplateBundle(SMOKE_TEMPLATE_ID);
  assert.ok(bundle, 'the real import is registered');
  assert.deepEqual(Object.keys(bundle.files), ['prompts/keeper.md'], 'the referenced prompt file was resolved host-side');
  assert.match(bundle.files['prompts/keeper.md'], /You keep the harbor lights\./);

  // The handoff note Genesis reads carries the pinned canonical version.
  const handoff = await run.genesisDispatcher.executeTool('read_file', {
    file_path: `/global/handoff/${SMOKE_TEMPLATE_ID}.md`
  });
  assert.equal(handoff.success, true, JSON.stringify(handoff));
  assert.match(handoff.content, new RegExp(`version: ${importReal.templateVersion}`));
});

// ============================================================================
// 4. Genesis: dry-run, submit, candidate
// ============================================================================

test('4. Genesis submits a matching package and a pending candidate is stored for review', async () => {
  const run = await getSessionZeroRun();
  const { store, submitDry, submitReal, loreOne, loreTwo } = run;
  assert.equal(submitDry.dryRun, true);
  assert.equal(submitDry.stored, false);
  assert.equal(submitReal.stored, true);

  const candidate = store.getPendingInstancePayload(SMOKE_TEMPLATE_ID);
  assert.ok(candidate, 'the candidate is stored on the session surface');
  assert.equal(candidate.templateId, SMOKE_TEMPLATE_ID);
  assert.equal(candidate.templateVersion, submitReal.templateVersion);
  assert.equal(candidate.payload.inputs.premise, `${loreOne}\n${loreTwo}`, 'the appended payload bytes were resolved');
  assert.equal(candidate.payload.files.length, 1);
  assert.equal(candidate.payload.files[0].path, 'lore/world.md');
  assert.equal(candidate.payload.files[0].content, `${loreOne}\n${loreTwo}`);
  assert.ok(Object.isFrozen(candidate));
  assert.deepEqual(
    store.listPendingInstancePayloads().map((entry) => entry.templateId).sort(),
    [SMOKE_TEMPLATE_ID, SMOKE_TEMPLATE_ID_V2].sort()
  );
});

// ============================================================================
// 5. Privileged peer private-workspace reads
// ============================================================================

test('5. both privileged members read each other private workspace in-realm', async () => {
  const run = await getSessionZeroRun();
  const architectPeerRead = await run.architectDispatcher.executeTool('read_file', {
    file_path: `/agents/${run.genesis.id}/notes/genesis.md`
  });
  assert.equal(architectPeerRead.success, true, JSON.stringify(architectPeerRead));
  assert.equal(architectPeerRead.content, run.genesisNote);

  const genesisPeerRead = await run.genesisDispatcher.executeTool('read_file', {
    file_path: `/agents/${run.architect.id}/notes/architect.md`
  });
  assert.equal(genesisPeerRead.success, true, JSON.stringify(genesisPeerRead));
  assert.equal(genesisPeerRead.content, run.architectNote);
});

// ============================================================================
// 6. Review attach: the candidate launches the instance
// ============================================================================

test('6. the reviewed candidate attaches through the existing launch path', async () => {
  const run = await getSessionZeroRun();
  const candidate = run.store.getPendingInstancePayload(SMOKE_TEMPLATE_ID);
  const launched = await run.store.launchRealmFromTemplate(SMOKE_TEMPLATE_ID, {
    package: candidate.payload
  });
  assert.equal(launched.agents.length, 1, 'the smoke realm launched its single member');
  const worldRecord = run.vfs.getFileRecord('/lore/world.md', {
    workspaceId: `realm:${launched.realm.id}:global`,
    callerAgentId: run.architect.id,
    principal: run.principal
  });
  assert.ok(worldRecord, 'the candidate file was seeded at launch');
  assert.equal(worldRecord.content, `${run.loreOne}\n${run.loreTwo}`);
  assert.ok(run.store.getPendingInstancePayload(SMOKE_TEMPLATE_ID), 'the candidate stays session-only after attach');
});

// ============================================================================
// 7. Format-v2 leg: placements + a pinned multi-part fileset
// ============================================================================

test('7. the format-v2 leg authors placements plus a pinned multi-part fileset and hydrates it', async () => {
  const run = await getSessionZeroRun();
  const { store, vfs, principal, architect } = run;

  // The candidate is a format-v2 payload whose lore fileset arrived entirely
  // through per-entry `{ path, sourceFile }` references.
  const candidate = store.getPendingInstancePayload(SMOKE_TEMPLATE_ID_V2);
  assert.ok(candidate, 'the v2 candidate is stored');
  assert.equal(candidate.templateId, SMOKE_TEMPLATE_ID_V2);
  assert.equal(candidate.templateVersion, run.v2ImportReal.templateVersion);
  assert.equal(candidate.payload.formatVersion, 2);
  assert.equal(candidate.payload.inputs.premise.text, run.v2PremiseBody);
  assert.deepEqual(
    candidate.payload.inputs.lore.files.map((file) => file.path),
    ['01_open.md', '02_close.md']
  );
  assert.match(candidate.payload.inputs.lore.files[0].content, /lamp is lit/);
  assert.deepEqual(candidate.payload.provenance, {
    producer: 'Genesis',
    generatedAt: '2026-09-27T00:00:00.000Z',
    model: 'fixture',
    reviewedBy: 'fixture'
  });
  assert.deepEqual(
    run.v2SubmitDry.fileEntries,
    run.v2SubmitReal.fileEntries,
    'the dry run and the real receipt agree on destinations'
  );

  // Launching the candidate composes the pinned prompt paths — a fileset
  // missing `01_open.md`/`02_close.md` would fail here even though the submit
  // dry run passed — and seeds every declared destination.
  const launched = await store.launchRealmFromTemplate(SMOKE_TEMPLATE_ID_V2, {
    package: candidate.payload
  });
  assert.equal(launched.agents.length, 1, 'the v2 smoke realm launched its single member');
  const workspaceId = `realm:${launched.realm.id}:global`;
  const readSeed = (path) => vfs.getFileRecord(path, {
    workspaceId,
    callerAgentId: architect.id,
    principal
  });
  const premise = readSeed('/premise.md');
  assert.ok(premise, 'the text placement seeded premise.md');
  assert.equal(premise.content, run.v2PremiseBody);
  const firstLore = readSeed('/lore/01_open.md');
  const secondLore = readSeed('/lore/02_close.md');
  assert.ok(firstLore && secondLore, 'both pinned fileset files were placed under lore/');
  assert.match(firstLore.content, /lamp is lit/);
  assert.match(secondLore.content, /never asks the water why/);
});

// ============================================================================
// 8. M5b read tools: exact-authority exposure
// ============================================================================

test('8. the M5b read tools surface exactly with the approved publishing authorities', async () => {
  const run = await getSessionZeroRun();
  const { runtime, launched, architect, genesis } = run;
  const identityPort = runtime.createAgentIdentityPort();
  const architectAllow = [
    ...identityPort.getAgentIdentity(architect.id, { realmId: launched.realm.id }).authority.allow
  ];
  const genesisAllow = [
    ...identityPort.getAgentIdentity(genesis.id, { realmId: launched.realm.id }).authority.allow
  ];

  assert.deepEqual(
    getAuthorityToolSchemas(architectAllow).map((definition) => definition.function.name).sort(),
    [PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, LIST_TEMPLATES, GET_TEMPLATE].sort(),
    'the architect approval exposes its publishing tool plus the two template reads'
  );
  assert.deepEqual(
    getAuthorityToolSchemas(genesisAllow).map((definition) => definition.function.name).sort(),
    [PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE, LIST_HYDRATION_PACKAGES].sort(),
    'the genesis approval exposes its publishing tool plus the hydration listing'
  );
  const canonical = getSandboxToolsSchema('all').map((definition) => definition.function.name);
  for (const name of [LIST_TEMPLATES, GET_TEMPLATE, LIST_HYDRATION_PACKAGES]) {
    assert.equal(canonical.includes(name), false, `'${name}' stays outside the canonical taxonomy`);
  }

  // Real dispatcher calls: the approved holder succeeds, the other authority denies.
  const listed = await run.architectDispatcher.executeTool(LIST_TEMPLATES, {});
  assert.equal(listed.success, true, JSON.stringify(listed));
  assert.ok(listed.templates.some((entry) => entry.templateId === TEMPLATE_ID), 'the shipped Session Zero is listed');
  const described = await run.architectDispatcher.executeTool(GET_TEMPLATE, { templateId: SMOKE_TEMPLATE_ID_V2 });
  assert.equal(described.success, true, JSON.stringify(described));
  assert.equal(described.templateId, SMOKE_TEMPLATE_ID_V2);
  assert.equal(described.templateVersion, run.v2ImportReal.templateVersion);
  assert.deepEqual(described.template.placements, [
    { inputId: 'premise', target: 'realm', path: 'premise.md' },
    { inputId: 'lore', target: 'realm', root: 'lore/' }
  ]);
  const packages = await run.genesisDispatcher.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(packages.success, true, JSON.stringify(packages));
  assert.ok(
    packages.pending.some((entry) => entry.templateId === SMOKE_TEMPLATE_ID_V2),
    'the v2 candidate is listed for the hydration authority'
  );

  const crossAuthority = await run.architectDispatcher.executeTool(LIST_HYDRATION_PACKAGES, {});
  assert.equal(crossAuthority.success, false);
  assert.equal(crossAuthority.code, 'PERMISSION_DENIED');
  const crossPublishing = await run.genesisDispatcher.executeTool(GET_TEMPLATE, { templateId: SMOKE_TEMPLATE_ID_V2 });
  assert.equal(crossPublishing.success, false);
  assert.equal(crossPublishing.code, 'PERMISSION_DENIED');
});
