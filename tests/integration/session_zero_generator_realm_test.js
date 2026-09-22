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
 *      (never profile-selectable) and the composed prompts carry the protocols;
 *   2. launch review: both declared authorities approved per agent, applied
 *      under the operator principal, recorded in `metaAuthorityGrants`, and the
 *      exact set trusted (`templateAuthorityTrust`);
 *   3. Architect authors a bundle by reference under `/global/...`, iterates
 *      with `import_realm_template { dry_run: true }` (zero side effects), then
 *      imports for real and hands off the canonical version;
 *   4. Genesis reads the handoff, assembles payload bytes by reference
 *      (`source_file`/`append`), iterates with
 *      `submit_hydration_package { dry_run: true }`, then submits for real and
 *      a pending candidate is stored;
 *   5. privilege enables in-realm peer private-workspace reads both ways;
 *   6. the reviewed candidate attaches through the existing launch path and
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
import { createSandboxToolDispatcher } from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { PUBLISHING_TOOLS } from '../../src/lib/sandbox/tools/constants/index.ts';

/** Shipped generator realm under test. */
const TEMPLATE_ID = 'session_zero';

/** Minimal realm the end-to-end fixture authors, imports, and hydrates. */
const SMOKE_TEMPLATE_ID = 'session-zero-smoke';

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
        prompt: [{ kind: 'file', path: 'prompts/keeper.md' }],
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
    architectNote
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
    for (const publishing of publishingNames) {
      assert.equal(tools.includes(publishing), false, `${spec.key} never profile-selects '${publishing}'`);
    }
  }

  // The shipped prompts compose through the real materializer and carry the
  // protocols (shared rules, per-agent procedure, launch inputs).
  const plan = materializeTemplate(template, {
    realmId: 'session_zero_probe',
    inputValues: { assignment: 'Probe the protocols.', target_template: '' },
    bundleFiles: bundle.files
  });
  const architectPrompt = plan.agents.find((agent) => agent.key === 'architect').systemPrompt;
  const genesisPrompt = plan.agents.find((agent) => agent.key === 'genesis').systemPrompt;
  for (const prompt of [architectPrompt, genesisPrompt]) {
    assert.match(prompt, /SESSION ZERO — OPERATIONAL RULES/);
    assert.match(prompt, /operator-owned content/);
    assert.match(prompt, /dry_run/);
    assert.match(prompt, /\/global\/handoff\//);
  }
  assert.match(architectPrompt, /ARCHITECT — TEMPLATE AUTHORING PROTOCOL/);
  assert.match(architectPrompt, new RegExp(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE));
  assert.match(genesisPrompt, /GENESIS — PAYLOAD GENERATION PROTOCOL/);
  assert.match(genesisPrompt, new RegExp(PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE));
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
  assert.deepEqual(store.listPendingInstancePayloads().map((entry) => entry.templateId), [SMOKE_TEMPLATE_ID]);
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
