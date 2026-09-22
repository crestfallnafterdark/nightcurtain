import test from 'node:test';
import assert from 'node:assert/strict';
import '../test_env.js';
import { CredentialVault } from '../../src/lib/sandbox/credentialVault/index.ts';
import { RunwareProvider, NanoGptProvider, DeepSeekProvider, PremProvider, OpenAIProvider } from '../../src/lib/sandbox/inference/index.ts';

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

test('Modern Settings Modal Architecture & Provider Test Suite', async (t) => {

  await t.test('1. Base Presets: Official models, fixed 100K maxTokens, no fake names', () => {
    const BASE_PRESETS = [
      { id: 'runware', name: 'Runware', providerId: 'runware', model: 'deepseek-v4-flash', temperature: 0.7, reasoningEffort: 'max', maxTokens: 100000 },
      { id: 'nanogpt', name: 'NanoGPT', providerId: 'nanogpt', model: 'deepseek/deepseek-v4.1-flash:thinking', providerRouting: 'auto', temperature: 0.7, reasoningEffort: 'high', maxTokens: 100000 },
      { id: 'deepseek', name: 'DeepSeek Native', providerId: 'deepseek', model: 'deepseek-flash', temperature: 0.7, reasoningEffort: 'high', maxTokens: 100000 },
      { id: 'prem', name: 'Prem AI', providerId: 'prem', model: 'deepseek-v4-flash-abliterated', temperature: 0.7, reasoningEffort: 'high', maxTokens: 100000 },
      { id: 'custom', name: 'Custom OpenAI Completion', providerId: 'custom', model: 'custom-completion-model', apiUrl: 'http://localhost:11434/v1', temperature: 0.7, reasoningEffort: 'none', maxTokens: 100000 }
    ];

    assert.equal(BASE_PRESETS.length, 5);

    // Verify official models
    const rw = BASE_PRESETS.find(p => p.providerId === 'runware');
    assert.equal(rw.model, 'deepseek-v4-flash');
    assert.equal(rw.maxTokens, 100000, 'Max tokens must be fixed to 100K');

    const nano = BASE_PRESETS.find(p => p.providerId === 'nanogpt');
    assert.equal(nano.model, 'deepseek/deepseek-v4.1-flash:thinking');
    assert.equal(nano.providerRouting, 'auto');
    assert.equal(nano.maxTokens, 100000);

    const ds = BASE_PRESETS.find(p => p.providerId === 'deepseek');
    assert.equal(ds.model, 'deepseek-flash');
    assert.equal(ds.maxTokens, 100000);

    const prem = BASE_PRESETS.find(p => p.providerId === 'prem');
    assert.equal(prem.model, 'deepseek-v4-flash-abliterated');
    assert.equal(prem.maxTokens, 100000);

    const custom = BASE_PRESETS.find(p => p.providerId === 'custom');
    assert.equal(custom.name, 'Custom OpenAI Completion');
    assert.equal(custom.apiUrl, 'http://localhost:11434/v1');
    assert.equal(custom.maxTokens, 100000);
  });

  await t.test('2. Saveable Presets Lifecycle: Custom presets stored in localStorage', () => {
    const STORAGE_KEY = 'ai_story_saved_presets_test';
    const testStorage = new Map();

    function loadCustomPresets() {
      const raw = testStorage.get(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    }

    function saveCustomPresets(presets) {
      testStorage.set(STORAGE_KEY, JSON.stringify(presets));
    }

    // Save as new preset
    const customPreset1 = {
      id: 'preset_custom_1',
      name: 'My DeepSeek Pro Preset',
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      temperature: 0.5,
      reasoningEffort: 'high',
      maxTokens: 100000,
      isCustom: true
    };

    let list = loadCustomPresets();
    list.push(customPreset1);
    saveCustomPresets(list);

    let reloaded = loadCustomPresets();
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].name, 'My DeepSeek Pro Preset');
    assert.equal(reloaded[0].model, 'deepseek-v4-pro');
    assert.equal(reloaded[0].maxTokens, 100000);

    // Update preset
    reloaded[0].temperature = 0.2;
    saveCustomPresets(reloaded);

    const updated = loadCustomPresets();
    assert.equal(updated[0].temperature, 0.2);

    // Delete preset
    saveCustomPresets([]);
    assert.equal(loadCustomPresets().length, 0);
  });

  await t.test('3. Direct Provider Instantiation & Capability Decoupling', async () => {
    const testVault = new CredentialVault({ storage: createTestStorage(), storageKey: 'test_vault_modal_spec' });
    const cred = testVault.addCredential({
      providerId: 'runware',
      label: 'Modal Spec Key',
      apiKey: 'sk-runware-test-spec'
    });
    testVault.setActiveCredential('runware', cred.id);

    // RunwareProvider instantiates with vault credential
    const rwProvider = new RunwareProvider({ credentialId: cred.id, vault: testVault });
    assert.equal(rwProvider.id, 'runware');
    const rwRoutes = await rwProvider.getProviders();
    assert.deepEqual(rwRoutes, [], 'Non-hub provider returns empty routes');

    // NanoGptProvider handles dynamic routes
    const nanoProvider = new NanoGptProvider({ apiKey: 'sk-nano-test' });
    assert.equal(nanoProvider.id, 'nanogpt');
    const emptyRoutes = await nanoProvider.getProviders('');
    assert.deepEqual(emptyRoutes, []);

    // DeepSeekProvider single-endpoint
    const dsProvider = new DeepSeekProvider({ apiKey: 'sk-ds-test' });
    assert.equal(dsProvider.id, 'deepseek');

    // PremProvider enclave singleton
    const premProvider = new PremProvider({ apiKey: 'sk-prem-test' });
    assert.equal(premProvider.id, 'prem');
    const premBalance = await premProvider.checkBalance();
    assert.equal(premBalance.available, false, 'Prem enclave does not expose balance');

    // OpenAIProvider custom baseUrl
    const customProvider = new OpenAIProvider({
      apiUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-custom-test',
      id: 'custom'
    });
    assert.equal(customProvider.id, 'custom');
    assert.equal(customProvider.getEndpointUrl('/chat/completions'), 'http://localhost:11434/v1/chat/completions');
  });

  await t.test('4. Key Vault: Labeled keys, secret masking, zero balance clutter', () => {
    const vault = new CredentialVault({ storage: createTestStorage(), storageKey: 'test_vault_pure_spec' });
    
    // Add credentials across providers
    const rwCred = vault.addCredential({
      providerId: 'runware',
      label: 'Runware Main',
      apiKey: 'rw_test_1234567890abcdef'
    });

    const premCred = vault.addCredential({
      providerId: 'prem',
      label: 'Prem Enclave Key',
      apiKey: 'sk-test-prem-secret-key',
      encryptionKey: 'test-kek-0123456789abcdef0123456789abcdef0123456789abcdef0123456'
    });

    const customCred = vault.addCredential({
      providerId: 'custom',
      label: 'Local Ollama',
      apiKey: 'ollama-no-key',
      baseUrl: 'http://localhost:11434/v1'
    });

    assert.equal(vault.getCredentialsForProvider('runware').length, 1);
    assert.equal(vault.getCredentialsForProvider('prem').length, 1);
    assert.equal(vault.getCredentialsForProvider('custom').length, 1);

    // Verify masking
    assert.equal(CredentialVault.maskKey(rwCred.apiKey), 'rw_****cdef');

    // Active credential resolution
    assert.equal(vault.getActiveCredential('runware').id, rwCred.id);
    assert.equal(vault.getActiveCredential('prem').encryptionKey.length, 64);
    // BUG-ENC-027: vault is a pure (keyId, secret) store — baseUrl is dropped
    assert.equal(vault.getActiveCredential('custom').apiKey, 'ollama-no-key');
    assert.equal(vault.getActiveCredential('custom').baseUrl, undefined);
  });
});
