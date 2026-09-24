/**
 * @file tests/unit/model_config_module_test.js
 * @description Comprehensive isolated unit suite for the `modelConfig` module.
 *
 * Contract coverage:
 *  1. Strict export whitelist (no runtime import surface beyond the five symbols).
 *  2. Preset catalog: 5 entries with exact ids/names and verbatim literal values.
 *  3. Immutability: frozen array/entries/nested configs + copy isolation.
 *  4. `getDefaultModelConfig`: master default verbatim + fresh copy per call.
 *  5. `getDefaultModelId`: all five providers, unknown, omitted (alias deferred).
 *  6. `resolveModelConfig`: default equivalence, precedence, absent fall-through.
 *  7. `'inherit'` stripping for every field.
 *  8. `keyId` derivation (`canonical_<providerId>`) and explicit-key precedence.
 *  9. Completeness guarantee + no secrets + fresh output + input immutability.
 * 10. `getProviderCapabilities`: routing only for nanogpt, url only for custom.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as ModelConfigModule from '../../src/lib/sandbox/modelConfig/index.ts';
import {
  PRESET_MODELS,
  getDefaultModelConfig,
  getDefaultModelId,
  getProviderCapabilities,
  resolveModelConfig
} from '../../src/lib/sandbox/modelConfig/index.ts';

/**
 * Converted module contract source (`modelConfig/index.ts`); `ModelPreset` is a
 * type-only export, so the export assertion below is necessarily a static
 * contract check.
 */
const CONTRACT_PATH = path.resolve(
  import.meta.dirname,
  '../../src/lib/sandbox/modelConfig/index.ts'
);

/**
 * Master default, byte-identical to `utils/storage.js@f002725:59-65`.
 */
const MASTER_DEFAULT = {
  providerId: 'deepseek',
  keyId: 'canonical_deepseek',
  modelId: 'deepseek-flash',
  temperature: 0.7,
  reasoningEffort: 'high'
};

/**
 * The five approved presets, byte-identical to the `SettingsModal.svelte@f002725:53-116` literal.
 */
const EXPECTED_PRESETS = [
  {
    id: 'runware',
    name: 'Runware',
    isCustom: false,
    modelConfig: {
      providerId: 'runware',
      keyId: 'canonical_runware',
      modelId: 'deepseek-v4-flash',
      temperature: 0.7,
      reasoningEffort: 'max'
    }
  },
  {
    id: 'nanogpt',
    name: 'NanoGPT',
    isCustom: false,
    modelConfig: {
      providerId: 'nanogpt',
      keyId: 'canonical_nanogpt',
      modelId: 'deepseek/deepseek-v4.1-flash:thinking',
      temperature: 0.7,
      reasoningEffort: 'high',
      routing: 'auto'
    }
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Native',
    isCustom: false,
    modelConfig: {
      providerId: 'deepseek',
      keyId: 'canonical_deepseek',
      modelId: 'deepseek-flash',
      temperature: 0.7,
      reasoningEffort: 'high'
    }
  },
  {
    id: 'prem',
    name: 'Prem AI',
    isCustom: false,
    modelConfig: {
      providerId: 'prem',
      keyId: 'canonical_prem',
      modelId: 'deepseek-v4-flash-abliterated',
      temperature: 0.7,
      reasoningEffort: 'high'
    }
  },
  {
    id: 'custom',
    name: 'Custom OpenAI Completion',
    isCustom: false,
    modelConfig: {
      providerId: 'custom',
      keyId: 'canonical_custom',
      modelId: 'custom-completion-model',
      url: 'http://localhost:11434/v1',
      temperature: 0.7,
      reasoningEffort: 'none'
    }
  }
];

// ============================================================================
// 1. Strict Export Whitelist
// ============================================================================

test('1. Strict Export Whitelist & Function Types', () => {
  const expectedKeys = [
    'PRESET_MODELS',
    'getDefaultModelConfig',
    'getDefaultModelId',
    'getProviderCapabilities',
    'resolveModelConfig'
  ].sort();

  assert.deepStrictEqual(
    Object.keys(ModelConfigModule).sort(),
    expectedKeys,
    'Runtime exports must match the contract surface exactly'
  );
  assert.ok(!('default' in ModelConfigModule), 'Module must not expose a default export');

  assert.ok(Array.isArray(PRESET_MODELS), 'PRESET_MODELS must be an array');
  assert.strictEqual(typeof getDefaultModelConfig, 'function');
  assert.strictEqual(typeof getDefaultModelId, 'function');
  assert.strictEqual(typeof getProviderCapabilities, 'function');
  assert.strictEqual(typeof resolveModelConfig, 'function');
});

test('1b. Contract export assertion: ModelPreset is exported by the index.ts contract', () => {
  const contractSource = fs.readFileSync(CONTRACT_PATH, 'utf-8');

  assert.match(
    contractSource,
    /export\s+interface\s+ModelPreset\b/,
    'ModelPreset must be exported by modelConfig/index.ts (clears ae-forgotten-export)'
  );
  assert.match(
    contractSource,
    /export\s+const\s+PRESET_MODELS:\s*readonly\s+ModelPreset\[\]/,
    'PRESET_MODELS must stay declared as readonly ModelPreset[] (the exported element type)'
  );

  assert.ok(PRESET_MODELS.length > 0, 'PRESET_MODELS must expose elements of the exported type');
});

// ============================================================================
// 2. Preset Catalog — Verbatim Literals
// ============================================================================

test('2. Preset catalog: 5 entries with exact ids/names/values', () => {
  assert.strictEqual(PRESET_MODELS.length, 5, 'Exactly five base presets');

  assert.deepStrictEqual(
    PRESET_MODELS.map(preset => preset.id),
    ['runware', 'nanogpt', 'deepseek', 'prem', 'custom']
  );
  assert.deepStrictEqual(
    PRESET_MODELS.map(preset => preset.name),
    ['Runware', 'NanoGPT', 'DeepSeek Native', 'Prem AI', 'Custom OpenAI Completion']
  );
  assert.deepStrictEqual(
    PRESET_MODELS.map(preset => preset.isCustom),
    [false, false, false, false, false],
    'Base entries all isCustom:false (the quirk is preserved as-is)'
  );

  for (const [index, expected] of EXPECTED_PRESETS.entries()) {
    assert.deepStrictEqual(
      PRESET_MODELS[index],
      expected,
      `Preset '${expected.id}' must be byte-identical to its source literal`
    );
  }
});

test('3. Preset catalog: provider model ids and per-provider extras', () => {
  assert.strictEqual(getDefaultModelId('runware'), 'deepseek-v4-flash');
  assert.strictEqual(getDefaultModelId('nanogpt'), 'deepseek/deepseek-v4.1-flash:thinking');
  assert.strictEqual(getDefaultModelId('deepseek'), 'deepseek-flash');
  assert.strictEqual(getDefaultModelId('prem'), 'deepseek-v4-flash-abliterated');
  assert.strictEqual(getDefaultModelId('custom'), 'custom-completion-model');

  const nanogpt = PRESET_MODELS.find(preset => preset.id === 'nanogpt');
  assert.strictEqual(nanogpt?.modelConfig.routing, 'auto');

  const custom = PRESET_MODELS.find(preset => preset.id === 'custom');
  assert.strictEqual(custom?.modelConfig.url, 'http://localhost:11434/v1');
  assert.strictEqual(custom?.modelConfig.modelId, 'custom-completion-model');
  assert.strictEqual(custom?.modelConfig.reasoningEffort, 'none');
  assert.strictEqual(custom?.isCustom, false);
});

// ============================================================================
// 3. Immutability & Copy Isolation
// ============================================================================

test('4. Immutability: array, entries, and nested modelConfig are frozen', () => {
  assert.ok(Object.isFrozen(PRESET_MODELS), 'PRESET_MODELS must be frozen');

  for (const preset of PRESET_MODELS) {
    assert.ok(Object.isFrozen(preset), `Preset '${preset.id}' must be frozen`);
    assert.ok(
      Object.isFrozen(preset.modelConfig),
      `Preset '${preset.id}' nested modelConfig must be frozen`
    );
  }

  // ESM strict mode: writes to frozen properties throw TypeError.
  assert.throws(() => {
    /** @type {any} */ (PRESET_MODELS).push({ id: 'injected' });
  }, TypeError);
  assert.throws(() => {
    /** @type {any} */ (PRESET_MODELS[0]).id = 'mutated';
  }, TypeError);
  assert.throws(() => {
    /** @type {any} */ (PRESET_MODELS[4].modelConfig).url = 'http://evil.example';
  }, TypeError);

  // The failed writes left the catalog intact.
  assert.deepStrictEqual(PRESET_MODELS.map(preset => preset.id), [
    'runware',
    'nanogpt',
    'deepseek',
    'prem',
    'custom'
  ]);
  assert.strictEqual(PRESET_MODELS[4].modelConfig.url, 'http://localhost:11434/v1');
});

test('5. getDefaultModelConfig: master default verbatim and fresh copy isolation', () => {
  assert.deepStrictEqual(getDefaultModelConfig(), MASTER_DEFAULT);

  const first = getDefaultModelConfig();
  const second = getDefaultModelConfig();
  assert.notStrictEqual(first, second, 'Each call must return a fresh object');

  first.providerId = 'mutated-provider';
  first.modelId = 'mutated-model';
  first.temperature = 99;

  assert.deepStrictEqual(getDefaultModelConfig(), MASTER_DEFAULT, 'Copy mutation must not leak');
  assert.strictEqual(second.providerId, 'deepseek');
  assert.strictEqual(second.temperature, 0.7);
});

// ============================================================================
// 4. getDefaultModelId — Lookup & Fallback
// ============================================================================

test('6. getDefaultModelId: five providers, unknown, omitted, alias deferred', () => {
  for (const preset of EXPECTED_PRESETS) {
    assert.strictEqual(
      getDefaultModelId(preset.modelConfig.providerId),
      preset.modelConfig.modelId,
      `Provider '${preset.modelConfig.providerId}' must resolve its preset modelId`
    );
  }

  assert.strictEqual(getDefaultModelId('unknown-provider'), MASTER_DEFAULT.modelId);
  assert.strictEqual(getDefaultModelId(''), MASTER_DEFAULT.modelId);
  assert.strictEqual(getDefaultModelId(), MASTER_DEFAULT.modelId);
  assert.strictEqual(getDefaultModelId(undefined), MASTER_DEFAULT.modelId);

  // Alias normalization is not performed here: preset keys are preserved
  // as-is, so `deepseek_native` is unknown and falls back to the master id.
  assert.strictEqual(getDefaultModelId('deepseek_native'), MASTER_DEFAULT.modelId);
});

// ============================================================================
// 5. resolveModelConfig — Precedence & Fall-through
// ============================================================================

test("7. resolveModelConfig: default equivalence and null/empty settings", () => {
  assert.deepStrictEqual(resolveModelConfig(), MASTER_DEFAULT);
  assert.deepStrictEqual(resolveModelConfig(undefined), MASTER_DEFAULT);
  assert.deepStrictEqual(resolveModelConfig(null), MASTER_DEFAULT);
  assert.deepStrictEqual(resolveModelConfig({}), MASTER_DEFAULT);
  assert.deepStrictEqual(resolveModelConfig({ modelConfig: null }), MASTER_DEFAULT);
  assert.deepStrictEqual(resolveModelConfig({ modelConfig: {} }), MASTER_DEFAULT);
  assert.deepStrictEqual(resolveModelConfig(), getDefaultModelConfig());
});

test('8. resolveModelConfig: explicit fields override default, absent fields fall through', () => {
  const full = resolveModelConfig({
    modelConfig: {
      providerId: 'nanogpt',
      keyId: 'canonical_nanogpt',
      modelId: 'deepseek/deepseek-v4.1-flash:thinking',
      temperature: 0.2,
      reasoningEffort: 'low',
      routing: 'auto'
    }
  });
  assert.deepStrictEqual(full, {
    providerId: 'nanogpt',
    keyId: 'canonical_nanogpt',
    modelId: 'deepseek/deepseek-v4.1-flash:thinking',
    temperature: 0.2,
    reasoningEffort: 'low',
    routing: 'auto'
  });

  const partial = resolveModelConfig({ modelConfig: { temperature: 0.1 } });
  assert.deepStrictEqual(partial, { ...MASTER_DEFAULT, temperature: 0.1 });

  const extras = resolveModelConfig({
    modelConfig: { serviceTier: 'flex', url: 'http://localhost:9999/v1' }
  });
  assert.strictEqual(extras.providerId, MASTER_DEFAULT.providerId);
  assert.strictEqual(extras.keyId, MASTER_DEFAULT.keyId);
  assert.strictEqual(extras.modelId, MASTER_DEFAULT.modelId);
  assert.strictEqual(extras.temperature, MASTER_DEFAULT.temperature);
  assert.strictEqual(extras.reasoningEffort, MASTER_DEFAULT.reasoningEffort);
  assert.strictEqual(extras.serviceTier, 'flex');
  assert.strictEqual(extras.url, 'http://localhost:9999/v1');
});

// ============================================================================
// 6. resolveModelConfig — 'inherit' Sentinel Stripping
// ============================================================================

test("9. resolveModelConfig: 'inherit' stripped per field and falls through", () => {
  for (const field of ['providerId', 'keyId', 'modelId', 'temperature', 'reasoningEffort']) {
    assert.deepStrictEqual(
      resolveModelConfig({ modelConfig: { [field]: 'inherit' } }),
      MASTER_DEFAULT,
      `'inherit' on '${field}' must fall through to the default layer`
    );
  }

  assert.deepStrictEqual(
    resolveModelConfig({
      modelConfig: {
        providerId: 'inherit',
        keyId: 'inherit',
        modelId: 'inherit',
        temperature: 'inherit',
        reasoningEffort: 'inherit'
      }
    }),
    MASTER_DEFAULT
  );

  // Explicit fields survive even when sibling fields are 'inherit'.
  const mixed = resolveModelConfig({
    modelConfig: {
      providerId: 'prem',
      keyId: 'inherit',
      modelId: 'inherit',
      temperature: 'inherit',
      reasoningEffort: 'inherit'
    }
  });
  assert.deepStrictEqual(mixed, {
    providerId: 'prem',
    keyId: 'canonical_prem',
    modelId: MASTER_DEFAULT.modelId,
    temperature: MASTER_DEFAULT.temperature,
    reasoningEffort: MASTER_DEFAULT.reasoningEffort
  });
});

// ============================================================================
// 7. resolveModelConfig — keyId Derivation
// ============================================================================

test('10. resolveModelConfig: keyId derivation canonical_<providerId>', () => {
  for (const preset of EXPECTED_PRESETS) {
    const resolved = resolveModelConfig({ modelConfig: { providerId: preset.modelConfig.providerId } });
    assert.strictEqual(
      resolved.keyId,
      preset.modelConfig.keyId,
      `Provider '${preset.modelConfig.providerId}' must derive '${preset.modelConfig.keyId}'`
    );
  }

  // Inherit keyId still derives from an explicit providerId.
  const inherited = resolveModelConfig({ modelConfig: { providerId: 'runware', keyId: 'inherit' } });
  assert.strictEqual(inherited.keyId, 'canonical_runware');

  // Explicit keyId wins over derivation.
  const explicit = resolveModelConfig({ modelConfig: { providerId: 'prem', keyId: 'prem-cred-7' } });
  assert.strictEqual(explicit.keyId, 'prem-cred-7');

  // Provider switch without keyId does not keep the master credential reference.
  const switched = resolveModelConfig({ modelConfig: { providerId: 'custom' } });
  assert.strictEqual(switched.keyId, 'canonical_custom');
  assert.notStrictEqual(switched.keyId, MASTER_DEFAULT.keyId);

  // No providerId: master keyId is retained.
  assert.strictEqual(resolveModelConfig({ modelConfig: { temperature: 0.5 } }).keyId, 'canonical_deepseek');
});

// ============================================================================
// 8. resolveModelConfig — Completeness, Purity, Freshness
// ============================================================================

test('11. resolveModelConfig: completeness guarantee, no secrets, fresh output', () => {
  const inputs = [
    undefined,
    null,
    {},
    { modelConfig: null },
    { modelConfig: {} },
    { modelConfig: { providerId: 'inherit' } },
    { modelConfig: { keyId: 'inherit', modelId: 'inherit' } },
    { modelConfig: { providerId: 'custom' } },
    { modelConfig: { providerId: 'nanogpt', routing: 'auto' } }
  ];

  for (const input of inputs) {
    const resolved = resolveModelConfig(input);
    for (const field of ['providerId', 'keyId', 'modelId']) {
      assert.strictEqual(
        typeof resolved[field],
        'string',
        `'${field}' must be present for input ${JSON.stringify(input)}`
      );
      assert.notStrictEqual(resolved[field] ?? '', '', `'${field}' must be non-empty`);
      assert.notStrictEqual(resolved[field], 'inherit', `'${field}' must never emit 'inherit'`);
    }
    assert.ok(!('apiKey' in resolved), 'No apiKey secret field');
    assert.ok(!('encryptionKey' in resolved), 'No encryptionKey secret field');
  }

  // Fresh output per call and no input mutation.
  const first = resolveModelConfig({ modelConfig: { providerId: 'prem' } });
  const second = resolveModelConfig({ modelConfig: { providerId: 'prem' } });
  assert.notStrictEqual(first, second);
  first.modelId = 'mutated';
  assert.strictEqual(second.modelId, MASTER_DEFAULT.modelId);

  const frozenSettings = Object.freeze({ modelConfig: Object.freeze({ providerId: 'prem' }) });
  const resolved = resolveModelConfig(frozenSettings);
  assert.strictEqual(resolved.keyId, 'canonical_prem');
  assert.deepStrictEqual(frozenSettings.modelConfig, { providerId: 'prem' });
});

// ============================================================================
// 9. getProviderCapabilities — Single Capability Source (ticket 1448f5a)
// ============================================================================

test('12. getProviderCapabilities: routing only for nanogpt, url only for custom', () => {
  assert.deepStrictEqual(getProviderCapabilities('nanogpt'), {
    supportsRouting: true,
    supportsUrl: false
  });
  assert.deepStrictEqual(getProviderCapabilities('custom'), {
    supportsRouting: false,
    supportsUrl: true
  });

  for (const providerId of ['runware', 'deepseek', 'prem']) {
    assert.deepStrictEqual(
      getProviderCapabilities(providerId),
      { supportsRouting: false, supportsUrl: false },
      `Provider '${providerId}' supports neither routing nor a custom endpoint`
    );
  }

  for (const unknown of ['unknown-provider', 'deepseek_native', '', undefined]) {
    assert.deepStrictEqual(
      getProviderCapabilities(unknown),
      { supportsRouting: false, supportsUrl: false },
      `Unknown provider ${JSON.stringify(unknown)} must degrade to both false`
    );
  }

  const first = getProviderCapabilities('nanogpt');
  const second = getProviderCapabilities('nanogpt');
  assert.notStrictEqual(first, second, 'Each call must return a fresh capability object');
  first.supportsRouting = false;
  assert.strictEqual(second.supportsRouting, true, 'Copy mutation must not leak');
});
