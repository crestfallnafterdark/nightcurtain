/**
 * @file tests/unit/agent_model_config_helpers_test.js
 * @description Unit suite for the shared agent model-config UI helpers
 * (tickets 1448f5a, 8de6b9d):
 *  1. `presetEditorFieldVisibility`: routing only for `nanogpt`, url only for
 *     `custom`, both false for every other/unknown provider, and always
 *     consistent with the single capability source `getProviderCapabilities`.
 *  2. `buildPresetModelConfig`: capability-gated `routing`/`url` emission —
 *     unsupported stray fields (in the draft or the base config) are stripped,
 *     supported non-empty values survive, supported empty values are removed.
 *  3. `resolveAgentModelConfig`: bound preset wins over the agent runtime copy,
 *     then the agent config, then the injected fallback (the precedence the
 *     Agent Inspector and Agent Settings preset editor share).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getProviderCapabilities } from '../../src/lib/sandbox/modelConfig/index.ts';
import { createPresetCatalog } from '../../src/lib/sandbox/presetCatalog/index.ts';
import {
  buildPresetModelConfig,
  presetEditorFieldVisibility,
  resolveAgentModelConfig
} from '../../src/lib/components/sandbox/agentModelConfigHelpers.ts';

/**
 * Creates a real in-memory preset catalog (MOD-20) plus its active-pointer
 * closures, mirroring the store's snapshot-backed composition root.
 *
 * @returns {{ catalog: object, pointer: { value: string } }}
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
  return { catalog, pointer };
}

/** Seed nanogpt base config (catalog-shaped, credential-free). */
const NANOGPT_BASE = {
  providerId: 'nanogpt',
  modelId: 'deepseek/deepseek-v4.1-flash:thinking',
  temperature: 0.7,
  reasoningEffort: 'high',
  routing: 'auto'
};

// ============================================================================
// 1. presetEditorFieldVisibility — Capability Gating
// ============================================================================

test('1. presetEditorFieldVisibility: nanogpt routing, custom url, every other provider neither', () => {
  assert.deepEqual(presetEditorFieldVisibility('nanogpt'), { routing: true, url: false });
  assert.deepEqual(presetEditorFieldVisibility('custom'), { routing: false, url: true });

  for (const providerId of ['runware', 'deepseek', 'prem', 'unknown-provider', 'deepseek_native']) {
    assert.deepEqual(
      presetEditorFieldVisibility(providerId),
      { routing: false, url: false },
      `Provider '${providerId}' must expose neither editor field`
    );
  }

  for (const unknown of [undefined, null, '', 42]) {
    assert.deepEqual(
      presetEditorFieldVisibility(unknown),
      { routing: false, url: false },
      `Non-provider value ${JSON.stringify(unknown)} must degrade to both false`
    );
  }
});

test('2. presetEditorFieldVisibility mirrors the single capability source for every provider', () => {
  const providers = ['runware', 'nanogpt', 'deepseek', 'prem', 'custom', 'unknown-provider', undefined];
  for (const providerId of providers) {
    const capabilities = getProviderCapabilities(providerId);
    assert.deepEqual(
      presetEditorFieldVisibility(providerId),
      { routing: capabilities.supportsRouting, url: capabilities.supportsUrl },
      `Visibility for ${JSON.stringify(providerId)} must derive from getProviderCapabilities`
    );
  }
});

// ============================================================================
// 2. buildPresetModelConfig — Capability-Gated, No Dead Fields
// ============================================================================

test('3. buildPresetModelConfig: a nanogpt draft loses a stray url (base url too)', () => {
  const built = buildPresetModelConfig(
    {
      modelId: '  deepseek/deepseek-v4.1-flash:thinking  ',
      temperature: '0.2',
      reasoningEffort: 'high',
      routing: ' auto ',
      url: 'http://stray.example/v1'
    },
    { ...NANOGPT_BASE, url: 'http://stale-base.example/v1' },
    presetEditorFieldVisibility('nanogpt')
  );

  assert.deepEqual(built, {
    providerId: 'nanogpt',
    modelId: 'deepseek/deepseek-v4.1-flash:thinking',
    temperature: 0.2,
    reasoningEffort: 'high',
    routing: 'auto'
  });
  assert.equal('url' in built, false, 'nanogpt must never persist a url field');
});

test('4. buildPresetModelConfig: a custom draft loses a stray routing', () => {
  const built = buildPresetModelConfig(
    {
      modelId: 'custom-completion-model',
      temperature: 0.4,
      reasoningEffort: 'none',
      routing: 'auto',
      url: ' http://localhost:9999/v1 '
    },
    {
      providerId: 'custom',
      modelId: 'custom-completion-model',
      url: 'http://localhost:11434/v1',
      temperature: 0.7,
      reasoningEffort: 'none'
    },
    presetEditorFieldVisibility('custom')
  );

  assert.deepEqual(built, {
    providerId: 'custom',
    modelId: 'custom-completion-model',
    temperature: 0.4,
    reasoningEffort: 'none',
    url: 'http://localhost:9999/v1'
  });
  assert.equal('routing' in built, false, 'custom must never persist a routing field');
});

test('5. buildPresetModelConfig: a deepseek/unknown provider loses both stray fields', () => {
  const draft = {
    modelId: 'deepseek-flash',
    temperature: 0.7,
    reasoningEffort: 'high',
    routing: 'auto',
    url: 'http://dead.example/v1'
  };
  const base = {
    providerId: 'deepseek',
    modelId: 'deepseek-flash',
    temperature: 0.7,
    reasoningEffort: 'high',
    routing: 'auto',
    url: 'http://dead.example/v1'
  };

  for (const providerId of ['deepseek', 'runware', 'prem', 'unknown-provider']) {
    const built = buildPresetModelConfig(draft, base, presetEditorFieldVisibility(providerId));
    assert.deepEqual(
      built,
      {
        providerId: 'deepseek',
        modelId: 'deepseek-flash',
        temperature: 0.7,
        reasoningEffort: 'high'
      },
      `Provider '${providerId}' must strip both routing and url`
    );
  }
});

test('6. buildPresetModelConfig: supported empty values are removed, unsupported base fields stripped', () => {
  const nanogpt = buildPresetModelConfig(
    { modelId: NANOGPT_BASE.modelId, temperature: 0.7, reasoningEffort: 'high', routing: '   ', url: '' },
    NANOGPT_BASE,
    presetEditorFieldVisibility('nanogpt')
  );
  assert.equal('routing' in nanogpt, false, 'an emptied routing must not survive from the base');
  assert.equal('url' in nanogpt, false, 'an unsupported base url must not survive');

  const custom = buildPresetModelConfig(
    { modelId: 'custom-completion-model', temperature: 0.7, reasoningEffort: 'none', routing: '', url: '  ' },
    { providerId: 'custom', modelId: 'custom-completion-model', url: 'http://localhost:11434/v1', temperature: 0.7 },
    presetEditorFieldVisibility('custom')
  );
  assert.equal('url' in custom, false, 'an emptied url must not survive from the base');
  assert.equal('routing' in custom, false, 'an unsupported base routing must not survive');

  const withoutBase = buildPresetModelConfig(
    { modelId: ' m ', temperature: 1.5, reasoningEffort: 'low', routing: '', url: '' },
    null,
    presetEditorFieldVisibility('custom')
  );
  assert.deepEqual(withoutBase, { modelId: 'm', temperature: 1.5, reasoningEffort: 'low' });
});

// ============================================================================
// 3. resolveAgentModelConfig — Bound-Preset-First Precedence
// ============================================================================

test('7. resolveAgentModelConfig: the bound preset wins over the stale runtime copy and the fallback', () => {
  const { catalog } = createTestCatalog();
  const fallback = { providerId: 'fallback', modelId: 'fallback-model', temperature: 1.1 };
  const agent = {
    config: {
      presetId: 'nanogpt',
      modelConfig: { providerId: 'deepseek', modelId: 'stale-runtime-model', temperature: 0.3 }
    }
  };

  const resolved = resolveAgentModelConfig(agent, catalog, fallback);
  assert.deepEqual(resolved, catalog.getPreset('nanogpt').modelConfig);
  assert.equal(resolved.temperature, 0.7, 'the bound preset temperature (0.7) must win over the runtime 0.3 copy');
  assert.equal(resolved.routing, 'auto');
  assert.equal(resolved.providerId, 'nanogpt');

  // The bound id is trimmed before resolution (same as the Inspector derivation).
  const padded = resolveAgentModelConfig({ config: { presetId: '  custom  ' } }, catalog, fallback);
  assert.equal(padded.url, 'http://localhost:11434/v1');
  assert.equal(padded.providerId, 'custom');
});

test('8. resolveAgentModelConfig: unbound agent config wins over the fallback', () => {
  const { catalog } = createTestCatalog();
  const fallback = { providerId: 'fallback', modelId: 'fallback-model' };
  const agentConfig = { providerId: 'prem', modelId: 'deepseek-v4-flash-abliterated', temperature: 0.5 };

  const resolved = resolveAgentModelConfig({ config: { modelConfig: agentConfig } }, catalog, fallback);
  assert.deepEqual(resolved, agentConfig);
  assert.equal(resolved.temperature, 0.5);
});

test('9. resolveAgentModelConfig: stale/missing bindings and absent inputs fall through to the fallback', () => {
  const { catalog } = createTestCatalog();
  const fallback = { providerId: 'fallback', modelId: 'fallback-model', temperature: 0.9 };
  const agentConfig = { providerId: 'runware', modelId: 'deepseek-v4-flash', temperature: 0.4 };

  // Stale binding with an agent config copy: the agent copy wins over the fallback.
  assert.deepEqual(
    resolveAgentModelConfig({ config: { presetId: 'preset_deleted', modelConfig: agentConfig } }, catalog, fallback),
    agentConfig
  );
  // Stale binding without an agent copy: the fallback is last.
  assert.deepEqual(
    resolveAgentModelConfig({ config: { presetId: 'preset_deleted' } }, catalog, fallback),
    fallback
  );
  // No catalog at all: the agent copy still resolves, else the fallback.
  assert.deepEqual(resolveAgentModelConfig({ config: { presetId: 'nanogpt', modelConfig: agentConfig } }, null, fallback), agentConfig);
  assert.deepEqual(resolveAgentModelConfig({ config: { presetId: 'nanogpt' } }, null, fallback), fallback);
  // No agent at all: the fallback is returned verbatim.
  assert.deepEqual(resolveAgentModelConfig(null, catalog, fallback), fallback);
  assert.deepEqual(resolveAgentModelConfig(undefined, catalog, fallback), fallback);
  // A falsy agent copy also falls through to the fallback.
  assert.deepEqual(resolveAgentModelConfig({ config: { modelConfig: null } }, catalog, fallback), fallback);
});
