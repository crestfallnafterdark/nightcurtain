/**
 * @file tests/audit/repros/dfba631.test.js
 * @description Audit repro for ticket dfba631 (Minor, area:tools):
 * `import_realm_template` discarded the caller's transport envelope and
 * re-serialized `{ template, files }` through `serializeTemplateBundle`, which
 * always stamps `formatVersion: 1`. A manifest declaring `formatVersion: 2`,
 * omitting it, or using the string `"1"` was silently accepted and imported as
 * v1 instead of failing closed with `ERR_BUNDLE_FORMAT`, matching the catalog
 * transport gate in `src/lib/sandbox/realmCatalog/transport.ts:70-75`.
 *
 * Evidence: `src/lib/sandbox/tools/descriptors/realmTools.ts` carried only an
 * envelope *key* whitelist and re-stamped the format version during canonical
 * re-serialization, before the real `parseTemplateBundle` validation ran.
 *
 * Exact enforced claim after the fix: the transport envelope
 * `formatVersion` must be exactly the number `1`; any other value (including
 * absent and `"1"`) is rejected with `INVALID_ARGUMENTS` /
 * `details.upstreamCode === 'ERR_BUNDLE_FORMAT'` before any file reference is
 * resolved and with zero catalog/import mutation. A valid v1 manifest still
 * imports.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/dfba631.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import { SandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { AGENT_AUTHORITIES } from '../../../src/lib/sandbox/realmCatalog/index.ts';
import { PUBLISHING_TOOLS } from '../../../src/lib/sandbox/tools/constants/index.ts';
import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

/**
 * Builds the minimal format-v1 template fixture used by every probe.
 *
 * @param {string} id - Fixture template id.
 * @returns {object} Format-v1 template spec.
 */
function createFixtureTemplate(id) {
  return {
    formatVersion: 1,
    id,
    name: 'Envelope Fixture',
    description: 'Transport-envelope repro fixture.',
    hydration: { brief: 'Produce the opening lore.' },
    inputs: [
      { id: 'premise', label: 'Premise', origin: 'generated', brief: 'One generated premise.' }
    ],
    seed: {
      files: [
        { path: 'lore/world.md', target: 'realm', origin: 'user', brief: 'World lore.' }
      ]
    },
    agents: [
      {
        key: 'architect',
        idPattern: `${id}-architect`,
        name: 'Architect',
        role: 'author',
        prompt: [{ kind: 'text', text: 'You author templates.' }],
        toolProfile: { tools: ['read_file'] },
        privileged: false,
        authorities: [AGENT_AUTHORITIES.TEMPLATE]
      }
    ]
  };
}

/**
 * Creates an isolated real store over its own runtime substrates.
 *
 * @returns {{ runtime: object, store: object }}
 */
function createFixtureStore() {
  const vfs = new VirtualFS();
  const bus = new MessagingBus();
  const runtime = new AgentRuntime({ virtualFs: vfs, messagingBus: bus, autoBootstrapDirector: false });
  const store = new SandboxStore({
    runtime,
    virtualFs: vfs,
    messagingBus: bus,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  return { runtime, store };
}

/**
 * Runs one import through the real director-authorized dispatcher and reports
 * the receipt plus the catalog/import projections around the call.
 *
 * @param {number|string|undefined} formatVersion - Envelope value to send (absent when undefined).
 * @returns {Promise<object>} Receipt, store, fixture id, and pre-call projections.
 */
async function runImportProbe(formatVersion) {
  const { runtime, store } = createFixtureStore();
  const director = await runtime.ensureDirector();
  const dispatcher = createSandboxToolDispatcher({
    agentId: director.id,
    callerAgentId: director.id,
    identityPort: runtime.createAgentIdentityPort(),
    virtualFs: runtime.virtualFs,
    realmPublishingPort: store.getRealmPublishingPort()
  });
  const templateId = `audit-dfba631-${formatVersion === undefined ? 'absent' : String(formatVersion)}`;
  const manifest = { template: createFixtureTemplate(templateId), files: {} };
  if (formatVersion !== undefined) manifest.formatVersion = formatVersion;
  const beforeCatalog = store.listRealmTemplates().map((template) => template.id).join(',');
  const beforeImports = JSON.stringify(store.serialize().importedRealmTemplates ?? []);
  const receipt = await dispatcher.executeTool(PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE, { manifest });
  return { receipt, store, templateId, beforeCatalog, beforeImports };
}

/**
 * Asserts one malformed envelope is rejected with the typed transport code and
 * leaves the catalog and the persisted import topology untouched.
 *
 * @param {Awaited<ReturnType<typeof runImportProbe>>} probe - Probe outcome.
 */
function assertRejectedWithoutMutation(probe) {
  assert.equal(probe.receipt.success, false, JSON.stringify(probe.receipt));
  assert.equal(probe.receipt.code, 'INVALID_ARGUMENTS', JSON.stringify(probe.receipt));
  assert.equal(probe.receipt.details.upstreamCode, 'ERR_BUNDLE_FORMAT', JSON.stringify(probe.receipt));
  assert.equal(probe.store.getRealmTemplateBundle(probe.templateId), null, 'no bundle may be imported');
  assert.equal(
    probe.store.listRealmTemplates().map((template) => template.id).join(','),
    probe.beforeCatalog,
    'the launch catalog must be unchanged'
  );
  assert.equal(
    JSON.stringify(probe.store.serialize().importedRealmTemplates ?? []),
    probe.beforeImports,
    'the persisted import topology must be unchanged'
  );
}

test('dfba631: envelope formatVersion 2 is rejected with ERR_BUNDLE_FORMAT and imports nothing', async () => {
  assertRejectedWithoutMutation(await runImportProbe(2));
});

test('dfba631: an absent envelope formatVersion is rejected and imports nothing', async () => {
  assertRejectedWithoutMutation(await runImportProbe(undefined));
});

test('dfba631: a string envelope formatVersion "1" is rejected and imports nothing', async () => {
  assertRejectedWithoutMutation(await runImportProbe('1'));
});

test('dfba631 control: a numeric formatVersion 1 still imports', async () => {
  const { receipt, store, templateId } = await runImportProbe(1);
  assert.equal(receipt.success, true, JSON.stringify(receipt));
  assert.equal(receipt.templateId, templateId);
  assert.ok(store.getRealmTemplateBundle(templateId), 'the v1 envelope must import');
});
