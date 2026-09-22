/**
 * @file tests/integration/modern_settings_workflow_test.js
 * @description Integration tests for the catalog-driven Sandbox Settings Modal
 * workflow (W4-A/W4-C): catalog CRUD persisted through a snapshot adapter,
 * provider-adaptive editing, credential-vault isolation, and credential-free
 * preset resolution. No legacy gameState/localStorage channels are involved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../test_env.js';

import { PRESET_MODELS, getDefaultModelId, resolveModelConfig } from '../../src/lib/sandbox/modelConfig/index.ts';
import { createPresetCatalog } from '../../src/lib/sandbox/presetCatalog/index.ts';
import { CredentialVault } from '../../src/lib/sandbox/credentialVault/index.ts';
import { DeepSeekProvider, OpenAIProvider } from '../../src/lib/sandbox/inference/index.ts';

const COMPONENTS_DIR = path.resolve(import.meta.dirname, '../../src/lib/components/sandbox');
const SANDBOX_MODAL_PATH = path.join(COMPONENTS_DIR, 'SandboxSettingsModal.svelte');
const SANDBOX_VIEW_PATH = path.join(COMPONENTS_DIR, 'SandboxView.svelte');

function createTestStorage() {
  const store = new Map();
  return {
    get(key) {
      return store.get(key) ?? null;
    },
    set(key, value) {
      store.set(key, value);
    },
    remove(key) {
      store.delete(key);
    }
  };
}

/**
 * Builds an in-memory catalog composition mirroring the store's snapshot wiring.
 * @returns {{ catalog: object, port: object, snapshot: { entries: object[] | null, pointer: { value: string } } }}
 */
function createSnapshotCatalog() {
  const snapshot = { entries: null, pointer: { value: '' } };
  const catalog = createPresetCatalog({
    storage: {
      load: () => snapshot.entries,
      save: (entries) => {
        snapshot.entries = entries;
      }
    },
    getActivePresetId: () => snapshot.pointer.value,
    setActivePresetId: (id) => {
      snapshot.pointer.value = id;
    }
  });
  return { catalog, port: catalog.createPresetSourcePort(), snapshot };
}

test('Sandbox Settings Modal Integration Workflow', async (t) => {

  await t.test('1. Catalog workflow: create, edit, activate, reconstitute from the snapshot, delete', () => {
    const { catalog, port, snapshot } = createSnapshotCatalog();
    assert.equal(catalog.listPresets().length, 5, 'catalog must seed the five official presets');
    assert.equal(port.getDefaultPresetId(), 'deepseek', 'empty state resolves the master default');

    const id = 'preset_custom_workflow_1';
    catalog.savePreset({
      id,
      name: 'Workflow Custom',
      isCustom: true,
      modelConfig: { providerId: 'deepseek', modelId: 'deepseek-flash', temperature: 1.4, reasoningEffort: 'max' }
    });
    catalog.setActivePresetId(id);
    assert.equal(port.getDefaultPresetId(), id, 'the created preset must become active');
    assert.ok(snapshot.entries.some(entry => entry.id === id), 'the custom preset must persist through the snapshot');
    assert.equal(snapshot.pointer.value, id, 'the active pointer must persist through the snapshot');

    catalog.savePreset({
      id,
      name: 'Workflow Custom',
      isCustom: true,
      modelConfig: { providerId: 'deepseek', modelId: 'deepseek-flash', temperature: 0.9, reasoningEffort: 'high' }
    });
    assert.equal(catalog.getPreset(id).modelConfig.temperature, 0.9, 'editing must replace the entry in place');

    const reloaded = createPresetCatalog({
      storage: { load: () => snapshot.entries, save: () => {} },
      getActivePresetId: () => snapshot.pointer.value,
      setActivePresetId: () => {}
    });
    const reloadedPort = reloaded.createPresetSourcePort();
    assert.equal(reloaded.getPreset(id).modelConfig.temperature, 0.9, 'reconstitution must restore the edited preset');
    assert.equal(reloadedPort.getDefaultPresetId(), id, 'reconstitution must restore the active pointer');

    reloaded.deletePreset(id);
    assert.equal(reloaded.getPreset(id), null);
    assert.equal(reloadedPort.getDefaultPresetId(), 'deepseek', 'deleting the active custom preset falls back to the master default');
    assert.equal(snapshot.pointer.value, id, 'the stale pointer is not rewritten by the fallback');
  });

  await t.test('2. Provider adaptation: defaults, routing, URL, and KEK inputs match the catalog', () => {
    const expectedDefaults = {
      runware: 'deepseek-v4-flash',
      nanogpt: 'deepseek/deepseek-v4.1-flash:thinking',
      deepseek: 'deepseek-flash',
      prem: 'deepseek-v4-flash-abliterated',
      custom: 'custom-completion-model'
    };
    for (const [providerId, modelId] of Object.entries(expectedDefaults)) {
      assert.equal(getDefaultModelId(providerId), modelId, `${providerId} default model must resolve from the catalog`);
      const preset = PRESET_MODELS.find(p => p.id === providerId);
      assert.equal(preset.modelConfig.providerId, providerId);
      assert.equal(preset.modelConfig.modelId, modelId);
    }

    assert.equal(PRESET_MODELS.find(p => p.id === 'nanogpt').modelConfig.routing, 'auto', 'NanoGPT must carry upstream routing');
    assert.equal(PRESET_MODELS.find(p => p.id === 'custom').modelConfig.url, 'http://localhost:11434/v1', 'custom must carry its endpoint');
    for (const preset of PRESET_MODELS) {
      if (preset.id === 'nanogpt') continue;
      assert.equal('routing' in preset.modelConfig, false, `${preset.id} must not carry routing`);
    }

    const source = fs.readFileSync(SANDBOX_MODAL_PATH, 'utf-8');
    assert.match(source, /\{#if providerId === 'custom'\}[\s\S]*?id="custom-url-input"/, 'Custom provider must show the endpoint input');
    assert.match(source, /\{#if providerId === 'nanogpt'\}[\s\S]*?id="routing-input"/, 'NanoGPT must show the routing input');
    assert.match(source, /\{#if vaultProvider === 'prem'\}[\s\S]*?Client KEK/, 'Prem must show the KEK input');
  });

  await t.test('3. Credential vault isolation: credential records only, active selection, masking, stale guards', () => {
    const vault = new CredentialVault({ storage: createTestStorage(), storageKey: 'test_vault_isolation_spec' });

    const rwCred = vault.addCredential({
      providerId: 'runware',
      label: 'Production Runware Key',
      apiKey: 'sk-test-rw-prod-12345678'
    });
    const nanoCred = vault.addCredential({
      providerId: 'nanogpt',
      label: 'NanoGPT Fast Key',
      apiKey: 'sk-test-nano-fast-87654321'
    });

    const creds = vault.getAllCredentials();
    assert.equal(creds.length, 2);
    for (const c of creds) {
      assert.ok(c.id && c.label && c.apiKey);
      assert.equal(c.balance, undefined, 'Key Vault must not store balance data');
      assert.equal(c.currency, undefined, 'Key Vault must not store currency data');
    }

    vault.setActiveCredential('runware', rwCred.id);
    assert.equal(vault.getActiveCredential('runware').id, rwCred.id);
    assert.equal(vault.getActiveCredential('nanogpt').id, nanoCred.id, 'per-provider active pointers must be independent');

    const masked = CredentialVault.maskKey(rwCred.apiKey);
    assert.ok(masked.startsWith('sk-'));
    assert.ok(masked.endsWith('5678'));
    assert.ok(masked.includes('****'));

    assert.equal(vault.updateCredential('missing-id', { label: 'x' }), null, 'stale edits must return null for UI guards');
    assert.equal(vault.deleteCredential('missing-id'), false, 'stale deletes must return false for UI guards');
    assert.equal(vault.deleteCredential(nanoCred.id), true);
    assert.equal(vault.getCredentialsForProvider('nanogpt').some(c => c.id === nanoCred.id), false);
  });

  await t.test('4. Live balance contract: providers degrade deterministically, custom provider never calls out', async () => {
    const vault = new CredentialVault({ storage: createTestStorage(), storageKey: 'test_vault_balance_spec' });
    const cred = vault.addCredential({
      providerId: 'deepseek',
      label: 'DeepSeek Native Key',
      apiKey: 'sk-test-ds-dummy-key-for-contract'
    });

    const dsProvider = new DeepSeekProvider({
      credentialId: cred.id,
      vault,
      model: 'deepseek-flash'
    });
    assert.equal(typeof dsProvider.checkBalance, 'function');

    const realFetch = globalThis.fetch;
    let requestedUrl = '';
    try {
      globalThis.fetch = async (url) => {
        requestedUrl = String(url);
        return {
          ok: true,
          json: async () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.34' }] })
        };
      };
      const okResult = await dsProvider.checkBalance();
      assert.ok(requestedUrl.endsWith('/user/balance'), 'DeepSeek balance must query the /user/balance endpoint');
      assert.equal(okResult.available, true);
      assert.equal(okResult.balance, '12.34');
      assert.equal(okResult.currency, 'USD');
      assert.equal(okResult.formatted, '$12.34');

      globalThis.fetch = async () => {
        throw new Error('network down');
      };
      const failedResult = await dsProvider.checkBalance();
      assert.equal(failedResult.available, false);
      assert.equal(failedResult.balance, null);
      assert.equal(failedResult.error, 'network down', 'network failures must degrade to a balance result, never throw');
    } finally {
      globalThis.fetch = realFetch;
    }

    const customProvider = new OpenAIProvider({
      credentialId: cred.id,
      vault,
      apiUrl: 'http://localhost:11434/v1',
      model: 'custom-model'
    });
    let customFetched = false;
    const guardedFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => {
        customFetched = true;
        throw new Error('custom provider must not call out');
      };
      const customResult = await customProvider.checkBalance();
      assert.equal(customResult.available, false);
      assert.equal(customResult.balance, null);
      assert.equal(customFetched, false, 'custom provider balance check must be offline');
    } finally {
      globalThis.fetch = guardedFetch;
    }
  });

  await t.test('5. Preset configs stay credential-free; resolution re-attaches the canonical keyId', () => {
    const { catalog } = createSnapshotCatalog();

    catalog.savePreset({
      id: 'preset_custom_roundtrip',
      name: 'Roundtrip',
      isCustom: true,
      modelConfig: { providerId: 'nanogpt', modelId: 'deepseek/deepseek-v4.1-flash:thinking', routing: 'auto', temperature: 0.7, reasoningEffort: 'high' }
    });

    const entry = catalog.getPreset('preset_custom_roundtrip');
    assert.equal('keyId' in entry.modelConfig, false, 'catalog entries must not pin credentials');

    const resolved = resolveModelConfig({ modelConfig: entry.modelConfig });
    assert.equal(resolved.providerId, 'nanogpt');
    assert.equal(resolved.modelId, 'deepseek/deepseek-v4.1-flash:thinking');
    assert.equal(resolved.keyId, 'canonical_nanogpt', 'resolution must derive the canonical credential reference');
    assert.equal(resolved.routing, 'auto');
  });

  await t.test('6. Catalog metadata: display names, model ids, and the select option template', () => {
    for (const preset of PRESET_MODELS) {
      assert.ok(preset.name.trim(), `${preset.id} must expose a display name`);
      assert.ok(preset.modelConfig.modelId.trim(), `${preset.id} must expose a model id`);
    }

    const source = fs.readFileSync(SANDBOX_MODAL_PATH, 'utf-8');
    assert.match(source, /\{preset\.name\} — \{preset\.modelConfig\.modelId\}/, 'the preset select must render name + model id');
    assert.match(source, /\{preset\.isCustom \? ' ★' : ''\}/, 'custom presets must be marked in the select');
    assert.match(source, /class="badge-active"/, 'the selected active preset must be badged');
    assert.match(source, /class="badge-official"/, 'official presets must be badged');
    assert.match(source, /class="badge-custom"/, 'custom presets must be badged');
  });

  await t.test('7. New architecture only: modal + sandbox components carry no legacy settings channels', () => {
    const modal = fs.readFileSync(SANDBOX_MODAL_PATH, 'utf-8');
    assert.equal(modal.match(/\bfetch\s*\(/g), null, 'SandboxSettingsModal.svelte must not contain raw fetch() calls');
    assert.doesNotMatch(modal, /gameState|updateActiveSettings|activeModelPresetId|ai_story_saved_presets_v1|ai_storyteller_api_key|ai_storyteller_provider_keys/, 'no legacy settings channels');
    assert.doesNotMatch(modal, /\blocalStorage\b/, 'the modal must not touch localStorage directly');
    assert.doesNotMatch(modal, /\bkeyId\b/, 'the modal must never write keyId');

    const view = fs.readFileSync(SANDBOX_VIEW_PATH, 'utf-8');
    assert.match(view, /import SandboxSettingsModal from '\.\/SandboxSettingsModal\.svelte'/, 'SandboxView must mount the catalog modal');
    assert.doesNotMatch(view, /import SettingsModal from/, 'the legacy settings modal must not be imported');

    for (const rel of ['SandboxSettingsModal.svelte', 'AgentInspector.svelte', 'AgentLauncherModal.svelte', 'AgentSettingsPanel.svelte']) {
      const source = fs.readFileSync(path.join(COMPONENTS_DIR, rel), 'utf-8');
      assert.doesNotMatch(source, /gameState/, `${rel} must not depend on legacy gameState`);
      assert.doesNotMatch(source, /utils\/tokenEstimator/, `${rel} must not depend on the legacy token estimator`);
    }
  });
});
