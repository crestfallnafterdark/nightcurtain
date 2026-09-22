/**
 * @file tests/unit/settings_modal_presets_test.js
 * @description Unit tests for the catalog-driven Sandbox Settings Modal (W4-A/W4-C).
 * Verifies the real MOD-20 preset catalog (seed invariants, CRUD, persistence,
 * active pointer, no credential material) and pins `SandboxSettingsModal.svelte`
 * to the catalog + credential vault surfaces — no `gameState`, no legacy
 * localStorage channels, no `keyId` writes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../test_env.js';
import { PRESET_MODELS, getDefaultModelId } from '../../src/lib/sandbox/modelConfig/index.ts';
import { createPresetCatalog } from '../../src/lib/sandbox/presetCatalog/index.ts';
import { CredentialVault, createBrowserCredentialStorage, normalizeProviderId } from '../../src/lib/sandbox/credentialVault/index.ts';

const MODAL_SOURCE_PATH = path.resolve(
  import.meta.dirname,
  '../../src/lib/components/sandbox/SandboxSettingsModal.svelte'
);

const OFFICIAL_IDS = ['runware', 'nanogpt', 'deepseek', 'prem', 'custom'];

/**
 * Reads the SandboxSettingsModal component source.
 * @returns {string}
 */
function readModalSource() {
  return fs.readFileSync(MODAL_SOURCE_PATH, 'utf-8');
}

/**
 * Extracts a top-level function body from the component source by brace matching.
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `SandboxSettingsModal.svelte must define ${name}()`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting ${name}()`);
}

/**
 * Creates an in-memory catalog storage adapter plus active-pointer closures,
 * mirroring the store's snapshot-backed composition root.
 * @returns {{ catalog: object, port: object, storage: { persisted: object[] | null }, pointer: { value: string } }}
 */
function createTestCatalog() {
  const pointer = { value: '' };
  const storage = { persisted: null };
  const catalog = createPresetCatalog({
    storage: {
      load: () => storage.persisted,
      save: (entries) => {
        storage.persisted = entries;
      }
    },
    getActivePresetId: () => pointer.value,
    setActivePresetId: (id) => {
      pointer.value = id;
    }
  });
  return { catalog, port: catalog.createPresetSourcePort(), storage, pointer };
}

test('Sandbox Settings Modal: Catalog Architecture & Vault Separation', async (t) => {

  await t.test('1. Official seed catalog: five provider presets, resolvable defaults, no secrets, no maxTokens UI field', () => {
    assert.deepEqual(PRESET_MODELS.map(p => p.id), OFFICIAL_IDS, 'official catalog ids must be the five approved providers');
    assert.deepEqual(
      PRESET_MODELS.map(p => p.name),
      ['Runware', 'NanoGPT', 'DeepSeek Native', 'Prem AI', 'Custom OpenAI Completion']
    );

    for (const preset of PRESET_MODELS) {
      assert.equal(preset.isCustom, false, `${preset.id} seed entry must not be custom`);
      assert.equal(preset.modelConfig.providerId, preset.id, `${preset.id} providerId must match the catalog id`);
      assert.ok(preset.modelConfig.modelId, `${preset.id} must carry a modelId`);
      assert.equal(
        getDefaultModelId(preset.modelConfig.providerId),
        preset.modelConfig.modelId,
        `getDefaultModelId(${preset.id}) must resolve the preset model`
      );
      assert.equal('apiKey' in preset.modelConfig, false, `${preset.id} must not carry secret material`);
      assert.equal('encryptionKey' in preset.modelConfig, false, `${preset.id} must not carry secret material`);
      assert.equal('maxTokens' in preset.modelConfig, false, `${preset.id} must not carry a maxTokens field (adapters own the 100K cap)`);
      assert.ok(Object.isFrozen(preset), `${preset.id} seed entry must be frozen`);
      assert.ok(Object.isFrozen(preset.modelConfig), `${preset.id} seed modelConfig must be frozen`);
    }

    assert.equal(getDefaultModelId('deepseek'), 'deepseek-flash');
    assert.equal(getDefaultModelId('custom'), 'custom-completion-model');

    // The 100K cap moved from preset metadata into the inference adapters.
    for (const rel of ['inference/OpenAIProvider/index.ts', 'inference/PremProvider/index.ts']) {
      const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/lib/sandbox', rel), 'utf-8');
      assert.match(source, /max_tokens\s*=\s*100000/, `${rel} must fix max_tokens at 100000`);
    }

    const modalSource = readModalSource();
    assert.doesNotMatch(modalSource, /maxTokens|Max Tokens/, 'the catalog modal must not expose a Max Tokens control');
  });

  await t.test('2. Catalog CRUD contract: save/delete, frozen copies, persistence projection, no keyId writes', () => {
    const { catalog, storage } = createTestCatalog();

    const seeded = catalog.listPresets();
    assert.equal(seeded.length, 5);
    assert.ok(Object.isFrozen(seeded), 'listPresets must return a frozen list');
    assert.equal(catalog.getPreset('does-not-exist'), null);

    const custom = {
      id: 'preset_custom_unit_1',
      name: 'Unit Custom',
      isCustom: true,
      modelConfig: {
        providerId: 'deepseek',
        keyId: 'canonical_deepseek',
        apiKey: 'sk-test-unit-secret',
        encryptionKey: 'kek-test-unit-secret',
        modelId: 'deepseek-flash',
        temperature: 1.1,
        reasoningEffort: 'max'
      }
    };
    catalog.savePreset(custom);

    const stored = catalog.getPreset(custom.id);
    assert.ok(stored, 'saved preset must be retrievable');
    assert.equal(stored.name, 'Unit Custom');
    assert.equal(stored.isCustom, true);
    assert.equal(stored.modelConfig.temperature, 1.1);
    assert.equal('keyId' in stored.modelConfig, false, 'catalog must strip keyId from ingested configs');
    assert.equal('apiKey' in stored.modelConfig, false, 'catalog must strip apiKey from ingested configs');
    assert.equal('encryptionKey' in stored.modelConfig, false, 'catalog must strip encryptionKey from ingested configs');

    assert.ok(Array.isArray(storage.persisted), 'savePreset must persist through the adapter');
    assert.equal(storage.persisted.length, 6, 'persistence must receive the full catalog projection');
    const persistedJson = JSON.stringify(storage.persisted);
    assert.doesNotMatch(persistedJson, /keyId|sk-test-unit-secret|kek-test-unit-secret/, 'persisted projection must be credential-free');

    assert.throws(
      () => catalog.savePreset({ id: 'preset_custom_bad', name: 'Bad', isCustom: true, modelConfig: { providerId: 'deepseek', modelId: '' } }),
      /savePreset requires/,
      'invalid entries must be rejected'
    );

    catalog.deletePreset(custom.id);
    assert.equal(catalog.getPreset(custom.id), null);
    assert.equal(catalog.listPresets().length, 5);
    assert.equal(storage.persisted.length, 5, 'delete must persist the reduced projection');
  });

  await t.test('3. Active pointer: catalog-set ids resolve, stale pointers fall back without being rewritten, events fire', () => {
    const { catalog, port, pointer } = createTestCatalog();

    assert.equal(port.getDefaultPresetId(), 'deepseek', 'empty pointer must fall back to the master default (deepseek)');

    catalog.savePreset({
      id: 'preset_custom_unit_2',
      name: 'Pointer Custom',
      isCustom: true,
      modelConfig: { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking', temperature: 0.5, reasoningEffort: 'low', routing: 'auto' }
    });
    catalog.setActivePresetId('preset_custom_unit_2');
    assert.equal(port.getDefaultPresetId(), 'preset_custom_unit_2');
    assert.equal(pointer.value, 'preset_custom_unit_2', 'setActivePresetId must write through the injected pointer closure');

    assert.throws(() => catalog.setActivePresetId('unknown-id'), /existing catalog preset id/, 'unknown active ids must be rejected');

    const events = [];
    const unsubscribe = catalog.subscribe(event => events.push(event));
    catalog.deletePreset('preset_custom_unit_2');
    assert.deepEqual(events, [{ type: 'preset-deleted', presetId: 'preset_custom_unit_2' }]);
    assert.equal(port.getDefaultPresetId(), 'deepseek', 'stale pointer must resolve to the master default');
    assert.equal(pointer.value, 'preset_custom_unit_2', 'a stale pointer is never rewritten');

    catalog.subscribe(() => { throw new Error('listener failure must be isolated'); });
    catalog.savePreset({ id: 'preset_custom_unit_3', name: 'Isolated', isCustom: true, modelConfig: { providerId: 'runware', modelId: 'deepseek-v4-flash' } });
    assert.equal(catalog.getPreset('preset_custom_unit_3').name, 'Isolated');

    unsubscribe();
    unsubscribe();
  });

  await t.test('4. Modal is catalog-driven: management API + change subscription, zero legacy settings channels', () => {
    const source = readModalSource();

    assert.match(source, /getSandboxStore\(\)/, 'modal must resolve the sandbox store');
    assert.match(source, /store\.getPresetCatalog\(\)/, 'modal must use the catalog management API');
    assert.match(source, /catalog\.createPresetSourcePort\(\)/, 'modal must read active bindings through the source port');
    assert.match(source, /catalog\.listPresets\(\)/, 'modal must list catalog entries');
    assert.match(source, /catalog\.getPreset\(/, 'modal must read catalog entries');
    assert.match(source, /catalog\.savePreset\(/, 'modal must save through the catalog');
    assert.match(source, /catalog\.deletePreset\(/, 'modal must delete through the catalog');
    assert.match(source, /catalog\.setActivePresetId\(/, 'modal must set the active pointer through the catalog');
    assert.match(source, /catalog\.subscribe\(/, 'modal must react to catalog change events');
    assert.match(source, /vaultRevision/, 'catalog/vault mutations must drive reactive invalidation');
    assert.match(source, /store\.getCredentialVault\(\)/, 'modal must use the store credential vault');

    assert.doesNotMatch(source, /gameState/, 'no legacy gameState dependency');
    assert.doesNotMatch(source, /updateActiveSettings/, 'no legacy settings writer');
    assert.doesNotMatch(source, /activeModelPresetId/, 'the retired activeModelPresetId channel must not return');
    assert.doesNotMatch(source, /ai_story_saved_presets_v1|ai_storyteller_api_key|ai_storyteller_provider_keys/, 'no legacy settings localStorage keys');
    assert.doesNotMatch(source, /\blocalStorage\b/, 'the modal must not touch localStorage directly');
    assert.doesNotMatch(source, /\bkeyId\b/, 'the modal must never read or write keyId');
    assert.doesNotMatch(source, /\bfetch\s*\(/, 'the modal must not issue raw fetches');
  });

  await t.test('5. Preset selection loads the editor and moves the active pointer through the catalog', () => {
    const source = readModalSource();

    assert.match(source, /const presetSource = catalog\.createPresetSourcePort\(\)/, 'source port must be the binding read path');
    assert.match(source, /const initialPreset = presetSource\.getPreset\(presetSource\.getDefaultPresetId\(\)\)/, 'initial selection must resolve from the source port');
    assert.match(source, /let selectedPresetId = \$state\(initialPreset \? initialPreset\.id : ''\)/, 'editor selection must initialize from the active preset');
    assert.match(source, /let activePresetId = \$derived\.by\(\(\) => \{[\s\S]*?presetSource\.getDefaultPresetId\(\)/, 'active pointer must be a live derived');
    assert.match(source, /let selectedPreset = \$derived\.by\(\(\) => \{[\s\S]*?catalog\.getPreset\(selectedPresetId\)/, 'selectedPreset must resolve from the catalog');
    assert.match(source, /selectedPreset\.id === activePresetId/, 'the Active badge must compare against the catalog pointer');

    const selectBody = extractFunction(source, 'handleSelectPreset');
    assert.match(selectBody, /const preset = catalog\.getPreset\(id\)/, 'selection must validate against the catalog');
    assert.match(selectBody, /if \(!preset\) return/, 'unknown preset ids must be a no-op');
    assert.match(selectBody, /loadPresetIntoEditor\(preset\)/, 'selection must load the preset into the editor');
    assert.match(selectBody, /catalog\.setActivePresetId\(id\)/, 'selection must move the active pointer through the catalog');

    const loadBody = extractFunction(source, 'loadPresetIntoEditor');
    assert.match(loadBody, /selectedPresetId = preset\.id/);
    assert.match(loadBody, /providerId = readString\(conf\.providerId\) \|\| 'runware'/);
    assert.match(loadBody, /modelId = readString\(conf\.modelId\)/);
    assert.match(loadBody, /reasoningEffort = readString\(conf\.reasoningEffort\) \|\| 'high'/);
    assert.doesNotMatch(loadBody, /keyId/, 'loading a preset must not touch credential ids');
  });

  await t.test('6. Save Preset and Save As New write catalog entries with credential-free configs', () => {
    const source = readModalSource();

    const buildBody = extractFunction(source, 'buildModelConfig');
    assert.match(buildBody, /providerId,/);
    assert.match(buildBody, /modelId: modelId\.trim\(\)/);
    assert.doesNotMatch(buildBody, /keyId|apiKey|encryptionKey/, 'built model configs must stay credential-free');
    assert.match(buildBody, /providerId === 'nanogpt'[\s\S]*?routing/, 'nanogpt routing is included only for nanogpt');
    assert.match(buildBody, /providerId === 'custom'[\s\S]*?url/, 'custom URL is included only for custom');

    const saveBody = extractFunction(source, 'handleSavePreset');
    assert.match(saveBody, /catalog\.savePreset\(\{/, 'Save Preset must go through the catalog');
    assert.match(saveBody, /modelConfig: buildModelConfig\(\)/);
    assert.doesNotMatch(saveBody, /keyId/, 'saving must never write keyId');

    const saveNewBody = extractFunction(source, 'handleSaveAsNew');
    assert.match(saveNewBody, /const id = `preset_custom_/, 'new presets must use the preset_custom_* namespace');
    assert.match(saveNewBody, /isCustom: true/);
    assert.match(saveNewBody, /catalog\.savePreset\(/);
    assert.match(saveNewBody, /catalog\.setActivePresetId\(id\)/, 'a newly created preset must be activated');
    assert.match(saveNewBody, /selectedPresetId = id/, 'the editor must switch to the new preset');
  });

  await t.test('7. Delete only targets custom entries, delegates to the catalog, and rebinds the fallback preset', () => {
    const source = readModalSource();
    const body = extractFunction(source, 'handleDeletePreset');

    assert.match(body, /if \(!selectedPreset \|\| !selectedPreset\.isCustom\) return/, 'official presets must not be deletable');
    assert.match(body, /catalog\.deletePreset\(selectedPreset\.id\)/, 'deletion must go through the catalog');
    assert.match(body, /presetSource\.getDefaultPresetId\(\)/, 'fallback must resolve through the source port');
    assert.match(body, /catalog\.setActivePresetId\(fallbackId\)/, 'fallback pointer must be persisted through the catalog');
  });

  await t.test('8. Vault mutations bump the revision and rebind through the store (no keyId/agent writes)', () => {
    const source = readModalSource();
    assert.match(source, /let vaultRevision = \$state\(0\)/, 'vaultRevision state is required to invalidate vault deriveds');

    for (const derived of ['vaultKeys', 'activeVaultCredential', 'currentProviderCredential']) {
      const re = new RegExp(`let ${derived} = \\$derived\\.by\\(\\(\\) => \\{[\\s\\S]*?vaultRevision[\\s\\S]*?\\}\\);`);
      assert.match(source, re, `${derived} must read vaultRevision`);
    }
    assert.match(source, /vault\.getCredentialsForProvider\(vaultProvider\)/, 'vault list must come from the vault');
    assert.match(source, /vault\.getActiveCredential\(vaultProvider\)/, 'active vault binding must come from the vault');
    assert.match(source, /vault\.getActiveCredential\(providerId\)/, 'editor key hint must resolve the editor provider');

    const addBody = extractFunction(source, 'handleAddCredential');
    assert.match(addBody, /vault\.addCredential\(\{/);
    assert.match(addBody, /vault\.setActiveCredential\(vaultProvider, added\.id\)/, 'a newly added key must become active');
    assert.match(addBody, /store\.rebindProviderCredentials\(vaultProvider, added\.id\)/, 'adding a key must rebind the store');
    assert.match(addBody, /vaultRevision \+= 1/, 'adding a key must invalidate the vault deriveds');
    assert.doesNotMatch(addBody, /keyId/, 'vault handlers must not write keyId');

    const setActiveBody = extractFunction(source, 'handleSetActiveCredential');
    assert.match(setActiveBody, /vault\.setActiveCredential\(vaultProvider, id\)/);
    assert.match(setActiveBody, /store\.rebindProviderCredentials\(vaultProvider, id\)/);
    assert.match(setActiveBody, /vaultRevision \+= 1/);

    const editBody = extractFunction(source, 'handleSaveEditedCredential');
    assert.match(editBody, /vault\.updateCredential\(id, \{/);
    assert.match(editBody, /vaultRevision \+= 1/);
    assert.match(editBody, /if \(!updated\)/, 'stale edits must surface feedback instead of silently no-oping');
    assert.match(editBody, /store\.rebindProviderCredentials\(vaultProvider, id\)/, 'editing the active credential must rebind the store');
  });

  await t.test('9. Vault guards: stale deletes/updates are detected; real vault semantics back the guards', () => {
    const source = readModalSource();
    const deleteBody = extractFunction(source, 'handleDeleteCredential');
    assert.match(deleteBody, /const deleted = vault\.deleteCredential\(id\)/, 'delete must capture the boolean result');
    assert.match(deleteBody, /vaultRevision \+= 1/);
    assert.match(deleteBody, /if \(!deleted\)/, 'stale deletes must surface feedback instead of silently no-oping');
    assert.match(deleteBody, /store\.rebindProviderCredentials\(vaultProvider, remaining \? remaining\.id : null\)/, 'deleting the active key must rebind the remaining key');
    assert.doesNotMatch(deleteBody, /probeVaultKeyStatus|refreshBalance/, 'the catalog modal must not run balance probes');

    const vault = new CredentialVault({
      storage: createBrowserCredentialStorage(),
      storageKey: `test_vault_${Date.now()}_${Math.random().toString(36).slice(2)}`
    });

    assert.equal(vault.updateCredential('missing-id', { label: 'x' }), null, 'updating a missing id must return null so the UI can guard');
    assert.equal(vault.deleteCredential('missing-id'), false, 'deleting a missing id must return false so the UI can guard');

    const added = vault.addCredential({ providerId: 'deepseek', label: 'Temp', apiKey: 'sk-test-1234567890' });
    vault.setActiveCredential('deepseek', added.id);
    assert.equal(vault.getActiveCredential('deepseek').apiKey, 'sk-test-1234567890');
    assert.equal(vault.deleteCredential(added.id), true);
    assert.equal(vault.deleteCredential(added.id), false, 'second delete is a stale action');
  });

  await t.test('10. Escape backs out the Save As New form, then closes; close controls stay wired', () => {
    const source = readModalSource();
    assert.match(source, /<svelte:window onkeydown=\{handleKeydown\}/, 'the modal must listen for keydown on window');

    const body = extractFunction(source, 'handleKeydown');
    assert.match(body, /if \(event\.key !== 'Escape'\) return/, 'handler must react to Escape only');
    assert.match(body, /showSaveAsNew = false/, 'Escape must back out the Save As New form first');
    assert.match(body, /handleClose\(\)/, 'Escape at the root must close the modal');
    const nestedIdx = body.indexOf('showSaveAsNew = false');
    const closeIdx = body.indexOf('handleClose()');
    assert.ok(nestedIdx < closeIdx, 'Escape must resolve nesting innermost-first');

    assert.match(extractFunction(source, 'handleClose'), /onclose\(\)/, 'close must call the injected onclose');
    assert.match(source, /class="btn-close"[\s\S]*?aria-label="Close settings"/, 'the header close button must be labeled');
    assert.match(source, /<button type="button" class="btn-secondary" onclick=\{handleClose\}>Close<\/button>/, 'the footer must expose a Close button');
  });

  await t.test('11. Provider-adaptive editor: fields follow the selected provider, defaults resolve from the catalog', () => {
    const source = readModalSource();

    assert.match(source, /\{#if providerId === 'custom'\}[\s\S]*?id="custom-url-input"/, 'custom endpoint must render only for the custom provider');
    assert.match(source, /\{#if providerId === 'nanogpt'\}[\s\S]*?id="routing-input"/, 'upstream routing must render only for nanogpt');
    assert.match(source, /\{#if vaultProvider === 'prem'\}[\s\S]*?Client KEK/, 'KEK input must render only for prem');
    assert.match(source, /const DEFAULT_CUSTOM_URL = 'http:\/\/localhost:11434\/v1'/, 'custom URL default must match the catalog');

    const customPreset = PRESET_MODELS.find(p => p.id === 'custom');
    assert.equal(customPreset.modelConfig.url, 'http://localhost:11434/v1');
    const nanoPreset = PRESET_MODELS.find(p => p.id === 'nanogpt');
    assert.equal(nanoPreset.modelConfig.routing, 'auto');

    const providerChangeBody = extractFunction(source, 'handleProviderChange');
    assert.match(providerChangeBody, /modelId = nextDefault/, 'switching providers must refresh the default model id');
    assert.match(providerChangeBody, /getDefaultModelId\(providerId\)/, 'provider defaults must resolve from the catalog');
  });

  await t.test('12. Dirty badge is derived from the edited config vs the selected catalog entry', () => {
    const source = readModalSource();
    assert.match(source, /function configSignature\(conf\)/, 'dirty state must compare canonical config signatures');
    const dirtyStart = source.indexOf('let presetDirty = $derived.by(');
    assert.notEqual(dirtyStart, -1, 'presetDirty must remain a derived');
    assert.match(
      source.slice(dirtyStart, dirtyStart + 400),
      /configSignature\(buildModelConfig\(\)\) !== configSignature\(selectedPreset\.modelConfig\)/,
      'dirty state must compare the editor against the selected catalog entry'
    );
    assert.match(source, /\{#if presetDirty\}[\s\S]*?Unsaved changes/, 'the dirty badge must render conditionally');
  });

  await t.test('13. Key Vault copy and display: masking, explicit reveal, no encryption claims, balance-free', () => {
    const source = readModalSource();
    assert.doesNotMatch(source, /encrypted vault/i, 'the vault must not claim at-rest encryption');
    assert.match(source, /API Key Vault/, 'the vault must be described as the API Key Vault');
    assert.match(source, /CredentialVault\.maskKey\(currentProviderCredential\.apiKey\)/, 'stored secrets must be masked');
    assert.match(source, /CredentialVault\.maskKey\(entry\.apiKey\)/, 'vault entries must be masked unless revealed');
    assert.match(source, /revealedKeys/, 'reveal state must be explicit and per-entry');
    assert.doesNotMatch(source, /checkBalance|refreshBalance|balanceError/, 'balance concerns must not live in the catalog modal');
    assert.match(source, /rebindProviderCredentials/, 'vault changes must rebind through the store, not keyId writes');

    assert.equal(CredentialVault.maskKey('sk-test-1234567890'), 'sk-****7890');
    assert.equal(CredentialVault.maskKey('short'), '****');
    assert.equal(normalizeProviderId('deepseek_native'), 'deepseek', 'vendor aliases must normalize to canonical provider ids');
  });
});
