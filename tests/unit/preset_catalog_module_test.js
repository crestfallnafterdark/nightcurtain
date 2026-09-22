/**
 * @file tests/unit/preset_catalog_module_test.js
 * @description Isolated unit suite for the MOD-20 `presetCatalog` module.
 *
 * Contract coverage:
 *  1. Runtime export surface (single factory; type exports are compile-time).
 *  2. Seed catalog mirrors `PRESET_MODELS` with `keyId` stripped.
 *  3. Frozen entries and fresh copies on every read (list/get/port).
 *  4. CRUD: append, overlay in place, delete, unknown-id no-op.
 *  5. Event emission: synchronous, ordered, listener-isolated, `preset-deleted`
 *     observes `getPreset(id) === null`, idempotent unsubscribe.
 *  6. Default validity: master-default fallback, undeletable fallback entry,
 *     stale/unknown/throwing active pointer.
 *  7. No-secret invariant: `keyId`/`apiKey`/`encryptionKey` stripped on seed,
 *     adapter load, save, and every read projection.
 *  8. Adapter resilience: load/save failures degrade without throwing; invalid
 *     loaded entries are dropped; duplicate ids resolve last-wins.
 *  9. Port projection: frozen plain object, frozen copies, delegation.
 * 10. Purity: own/`modelConfig` imports only, no ambient I/O identifiers, and
 *     `index.ts` carries the port contract interface and re-exports only.
 * 11. Credential-field stripping: all three credential-shaped keys stripped on
 *     save, adapter load, and seed ingestion; legitimate fields preserved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as PresetCatalogModule from '../../src/lib/sandbox/presetCatalog/index.ts';
import { createPresetCatalog } from '../../src/lib/sandbox/presetCatalog/index.ts';
import { PRESET_MODELS, getDefaultModelConfig } from '../../src/lib/sandbox/modelConfig/index.ts';

/** Module folder under test (source-level purity checks). */
const MODULE_DIR = path.resolve(import.meta.dirname, '../../src/lib/sandbox/presetCatalog');

/** Seed catalog ids in `PRESET_MODELS` order. */
const SEED_IDS = PRESET_MODELS.map(preset => preset.id);

/** Credential-shaped `modelConfig` keys the catalog must strip from every path. */
const CREDENTIAL_FIELDS = ['keyId', 'apiKey', 'encryptionKey'];

/**
 * Mirrors the catalog's fallback-default rule: the first seed entry whose
 * `keyId`-stripped config matches the master default, else the synthetic id.
 *
 * @returns {string} Expected fallback default preset id
 */
function expectedFallbackDefaultId() {
  const master = { ...getDefaultModelConfig() };
  delete master.keyId;
  const masterKeys = Object.keys(master);
  const match = PRESET_MODELS.find(seed => {
    const config = { ...seed.modelConfig };
    delete config.keyId;
    const keys = Object.keys(config);
    return keys.length === masterKeys.length && keys.every(key => Object.is(config[key], master[key]));
  });
  return match ? match.id : 'preset_master_default';
}

/**
 * Builds a catalog over an in-memory adapter with injectable failure modes.
 *
 * @param {object} [options] Harness overrides
 * @param {unknown[]} [options.stored] Adapter-load return value
 * @param {unknown} [options.loadValue] Explicit adapter-load return value
 * @param {Error} [options.loadError] When set, `load()` throws it
 * @param {Error} [options.saveError] When set, `save()` throws it
 * @param {string} [options.active] Initial active preset id
 * @param {Error} [options.getActiveError] When set, `getActivePresetId()` throws it
 * @param {Error} [options.setActiveError] When set, `setActivePresetId()` throws it
 * @returns {{ catalog: object, state: object }} Catalog + observable adapter state
 */
function createHarness(options = {}) {
  const state = {
    stored: options.stored ? [...options.stored] : [],
    active: options.active || '',
    saves: []
  };
  const hasLoadValue = Object.prototype.hasOwnProperty.call(options, 'loadValue');
  const storage = {
    load() {
      if (options.loadError) throw options.loadError;
      return hasLoadValue ? options.loadValue : state.stored;
    },
    save(presets) {
      if (options.saveError) throw options.saveError;
      state.saves.push(presets);
      state.stored = presets;
    }
  };
  const catalog = createPresetCatalog({
    storage,
    getActivePresetId() {
      if (options.getActiveError) throw options.getActiveError;
      return state.active;
    },
    setActivePresetId(id) {
      if (options.setActiveError) throw options.setActiveError;
      state.active = id;
    }
  });
  return { catalog, state };
}

/**
 * Builds a valid custom preset literal.
 *
 * @param {object} [overrides] Field overrides
 * @returns {object} Preset literal
 */
function customPreset(overrides = {}) {
  return {
    id: 'preset_custom_1',
    name: 'Custom Preset',
    isCustom: true,
    modelConfig: { providerId: 'custom', modelId: 'custom-model', temperature: 0.5 },
    ...overrides
  };
}

// ============================================================================
// 1. Export surface
// ============================================================================

test('1. runtime surface exports createPresetCatalog only', () => {
  assert.deepStrictEqual(Object.keys(PresetCatalogModule).sort(), ['createPresetCatalog']);
  assert.strictEqual(typeof createPresetCatalog, 'function');
  assert.ok(!('default' in PresetCatalogModule), 'no default export');

  const { catalog } = createHarness();
  assert.deepStrictEqual(
    Object.keys(catalog).sort(),
    [
      'createPresetSourcePort',
      'deletePreset',
      'getPreset',
      'listPresets',
      'savePreset',
      'setActivePresetId',
      'subscribe'
    ],
    'the management surface must match ICD §8 exactly'
  );
  assert.ok(Object.isFrozen(catalog), 'the catalog service object must be frozen');
});

// ============================================================================
// 2. Seed catalog + no-keyId invariant
// ============================================================================

test('2. seed catalog mirrors PRESET_MODELS with keyId stripped', () => {
  const { catalog } = createHarness();
  const presets = catalog.listPresets();

  assert.deepStrictEqual(presets.map(preset => preset.id), SEED_IDS);
  for (const [index, seed] of PRESET_MODELS.entries()) {
    const preset = presets[index];
    assert.strictEqual(preset.name, seed.name);
    assert.strictEqual(preset.isCustom, seed.isCustom);
    assert.strictEqual(preset.modelConfig.providerId, seed.modelConfig.providerId);
    assert.strictEqual(preset.modelConfig.modelId, seed.modelConfig.modelId);
    assert.strictEqual(preset.modelConfig.temperature, seed.modelConfig.temperature);
    assert.strictEqual(preset.modelConfig.reasoningEffort, seed.modelConfig.reasoningEffort);
    assert.ok(!('keyId' in preset.modelConfig), `seed '${seed.id}' must not carry keyId`);
  }

  const nanogpt = presets.find(preset => preset.id === 'nanogpt');
  assert.strictEqual(nanogpt.modelConfig.routing, 'auto');
  const customSeed = presets.find(preset => preset.id === 'custom');
  assert.strictEqual(customSeed.modelConfig.url, 'http://localhost:11434/v1');
});

// ============================================================================
// 3. Freeze + copy isolation
// ============================================================================

test('3. listPresets/getPreset return frozen fresh copies', () => {
  const { catalog } = createHarness();

  const firstList = catalog.listPresets();
  const secondList = catalog.listPresets();
  assert.notStrictEqual(firstList, secondList, 'listPresets must build a fresh array');
  assert.notStrictEqual(firstList[0], secondList[0], 'entries must be fresh copies');
  assert.notStrictEqual(
    firstList[0].modelConfig,
    secondList[0].modelConfig,
    'modelConfig must be a fresh copy'
  );
  assert.deepStrictEqual(firstList, secondList);
  assert.ok(Object.isFrozen(firstList), 'returned array must be frozen');
  assert.ok(Object.isFrozen(firstList[0]), 'returned entry must be frozen');
  assert.ok(Object.isFrozen(firstList[0].modelConfig), 'returned modelConfig must be frozen');
  assert.throws(() => {
    firstList[0].name = 'mutated';
  }, TypeError);
  assert.throws(() => {
    firstList[0].modelConfig.modelId = 'mutated';
  }, TypeError);
  assert.throws(() => {
    firstList.push(customPreset());
  }, TypeError);

  const id = SEED_IDS[0];
  const first = catalog.getPreset(id);
  const second = catalog.getPreset(id);
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.modelConfig, second.modelConfig);
  assert.deepStrictEqual(first, second);
  assert.throws(() => {
    first.name = 'mutated';
  }, TypeError);
  assert.strictEqual(catalog.getPreset(id).name, PRESET_MODELS[0].name);
  assert.strictEqual(catalog.getPreset('missing-id'), null);

  // The retained legacy seed catalog is untouched by copy mutation attempts.
  assert.strictEqual(PRESET_MODELS[0].name, 'Runware');
});

// ============================================================================
// 4. CRUD
// ============================================================================

test('4. savePreset appends a custom preset and emits preset-updated synchronously', () => {
  const { catalog, state } = createHarness();
  const events = [];
  catalog.subscribe(event => events.push(event));

  catalog.savePreset(customPreset());

  assert.strictEqual(events.length, 1, 'the event must be emitted synchronously');
  assert.deepStrictEqual(events[0], { type: 'preset-updated', presetId: 'preset_custom_1' });
  assert.ok(Object.isFrozen(events[0]), 'event objects must be frozen');
  assert.throws(() => {
    events[0].type = 'mutated';
  }, TypeError);
  assert.deepStrictEqual(
    catalog.listPresets().map(preset => preset.id),
    [...SEED_IDS, 'preset_custom_1']
  );
  assert.deepStrictEqual(
    state.saves.at(-1).map(preset => preset.id),
    [...SEED_IDS, 'preset_custom_1']
  );
});

test('5. savePreset overlays an existing id in place', () => {
  const { catalog } = createHarness();
  catalog.savePreset({
    id: 'nanogpt',
    name: 'NanoGPT Edited',
    isCustom: false,
    modelConfig: { providerId: 'nanogpt', modelId: 'edited-model' }
  });

  const presets = catalog.listPresets();
  assert.deepStrictEqual(presets.map(preset => preset.id), SEED_IDS);
  const edited = presets.find(preset => preset.id === 'nanogpt');
  assert.strictEqual(edited.name, 'NanoGPT Edited');
  assert.strictEqual(edited.modelConfig.modelId, 'edited-model');
});

test('6. savePreset strips keyId and persists the full projection', () => {
  const { catalog, state } = createHarness();
  catalog.savePreset(
    customPreset({
      modelConfig: {
        providerId: 'deepseek',
        keyId: 'canonical_deepseek',
        modelId: 'deepseek-flash',
        temperature: 0.2
      }
    })
  );

  const saved = catalog.getPreset('preset_custom_1');
  assert.ok(!('keyId' in saved.modelConfig), 'keyId must be stripped on save');
  assert.strictEqual(saved.modelConfig.temperature, 0.2);

  const projection = state.saves.at(-1);
  assert.strictEqual(projection.length, SEED_IDS.length + 1);
  assert.ok(projection.every(preset => !('keyId' in preset.modelConfig)));
  assert.ok(projection.every(preset => Object.isFrozen(preset)));
  assert.ok(projection.every(preset => Object.isFrozen(preset.modelConfig)));
});

test('7. savePreset rejects invalid presets without mutating the catalog', () => {
  const { catalog, state } = createHarness();
  const before = catalog.listPresets();
  const invalid = [
    null,
    undefined,
    'nope',
    { id: '', name: 'x', isCustom: true, modelConfig: { providerId: 'p', modelId: 'm' } },
    { id: 'x', name: '', isCustom: true, modelConfig: { providerId: 'p', modelId: 'm' } },
    { id: 'x', name: 'x', isCustom: 'yes', modelConfig: { providerId: 'p', modelId: 'm' } },
    { id: 'x', name: 'x', isCustom: true, modelConfig: {} },
    { id: 'x', name: 'x', isCustom: true, modelConfig: { providerId: 'p', modelId: '' } },
    { id: 'x', name: 'x', isCustom: true, modelConfig: null },
    { id: 'x', name: 'x', isCustom: true }
  ];

  for (const preset of invalid) {
    assert.throws(() => catalog.savePreset(preset), Error, `must reject ${JSON.stringify(preset)}`);
  }
  assert.deepStrictEqual(catalog.listPresets(), before);
  assert.strictEqual(state.saves.length, 0, 'rejected saves must not persist');
});

test('8. deletePreset emits after removal and persists', () => {
  const { catalog, state } = createHarness();
  catalog.savePreset(customPreset());

  const observed = [];
  catalog.subscribe(event => {
    if (event.type === 'preset-deleted') observed.push(catalog.getPreset(event.presetId));
  });
  catalog.deletePreset('preset_custom_1');

  assert.deepStrictEqual(observed, [null], 'listeners must observe the entry as deleted');
  assert.strictEqual(catalog.getPreset('preset_custom_1'), null);
  assert.ok(!state.saves.at(-1).some(preset => preset.id === 'preset_custom_1'));
});

test('9. deletePreset of an unknown id is a no-op', () => {
  const { catalog, state } = createHarness();
  const events = [];
  catalog.subscribe(event => events.push(event));

  assert.doesNotThrow(() => catalog.deletePreset('missing-id'));
  assert.doesNotThrow(() => catalog.deletePreset(''));

  assert.deepStrictEqual(events, []);
  assert.strictEqual(state.saves.length, 0);
  assert.deepStrictEqual(catalog.listPresets().map(preset => preset.id), SEED_IDS);
});

test('10. deletePreset refuses the fallback default preset', () => {
  const { catalog } = createHarness();
  const defaultId = catalog.createPresetSourcePort().getDefaultPresetId();
  assert.ok(catalog.getPreset(defaultId), 'the fallback default must exist');

  assert.throws(() => catalog.deletePreset(defaultId), /refuses/);
  assert.ok(catalog.getPreset(defaultId), 'the fallback default must survive the rejection');
});

// ============================================================================
// 5. Events
// ============================================================================

test('11. listener exceptions are isolated; order and unsubscribe are stable', () => {
  const { catalog } = createHarness();
  const order = [];
  catalog.subscribe(() => {
    order.push('first');
    throw new Error('listener boom');
  });
  const unsubscribe = catalog.subscribe(() => {
    order.push('second');
  });

  assert.doesNotThrow(() => catalog.savePreset(customPreset()));
  assert.deepStrictEqual(order, ['first', 'second'], 'registration order is preserved');

  unsubscribe();
  unsubscribe();
  catalog.deletePreset('preset_custom_1');
  assert.deepStrictEqual(order, ['first', 'second', 'first']);

  assert.throws(() => catalog.subscribe(null), TypeError);
});

// ============================================================================
// 6. Default validity
// ============================================================================

test('12. getDefaultPresetId returns the active id or the master-default fallback', () => {
  const { catalog, state } = createHarness();
  const port = catalog.createPresetSourcePort();
  const fallbackId = expectedFallbackDefaultId();
  assert.strictEqual(port.getDefaultPresetId(), fallbackId);

  catalog.setActivePresetId('nanogpt');
  assert.strictEqual(state.active, 'nanogpt');
  assert.strictEqual(port.getDefaultPresetId(), 'nanogpt');

  state.active = 'preset_custom_deleted';
  assert.strictEqual(port.getDefaultPresetId(), fallbackId);

  state.active = '';
  assert.strictEqual(port.getDefaultPresetId(), fallbackId);
});

test('13. deleting the active preset leaves a stale pointer that resolves to the fallback', () => {
  const { catalog, state } = createHarness();
  const port = catalog.createPresetSourcePort();
  const fallbackId = expectedFallbackDefaultId();
  catalog.savePreset(customPreset());
  catalog.setActivePresetId('preset_custom_1');

  catalog.deletePreset('preset_custom_1');

  assert.strictEqual(state.active, 'preset_custom_1', 'the pointer is not rewritten');
  assert.strictEqual(port.getDefaultPresetId(), fallbackId);
});

test('14. setActivePresetId validates against the catalog', () => {
  const { catalog, state } = createHarness();

  catalog.setActivePresetId('nanogpt');
  assert.strictEqual(state.active, 'nanogpt');

  assert.throws(() => catalog.setActivePresetId('missing-id'), Error);
  assert.throws(() => catalog.setActivePresetId(''), Error);
  assert.strictEqual(state.active, 'nanogpt', 'rejected ids must not be persisted');
});

// ============================================================================
// 7. Adapter resilience
// ============================================================================

test('15. storage.load failures degrade to the seed catalog', () => {
  let catalog;
  assert.doesNotThrow(() => {
    catalog = createHarness({ loadError: new Error('disk failure') }).catalog;
  });
  assert.deepStrictEqual(catalog.listPresets().map(preset => preset.id), SEED_IDS);

  const nonArray = createHarness({ loadValue: { not: 'an array' } }).catalog;
  assert.deepStrictEqual(nonArray.listPresets().map(preset => preset.id), SEED_IDS);

  const nullLoad = createHarness({ loadValue: null }).catalog;
  assert.deepStrictEqual(nullLoad.listPresets().map(preset => preset.id), SEED_IDS);
});

test('16. adapter load overlays by id, appends unknown ids, drops invalid entries', () => {
  const { catalog } = createHarness({
    stored: [
      {
        id: 'nanogpt',
        name: 'NanoGPT Edited',
        isCustom: false,
        modelConfig: {
          providerId: 'nanogpt',
          keyId: 'canonical_nanogpt',
          modelId: 'edited-model'
        }
      },
      customPreset({ id: 'preset_custom_1', name: 'First' }),
      customPreset({ id: 'preset_custom_1', name: 'Second' }),
      { id: 'bad', name: '', isCustom: true, modelConfig: { providerId: 'x', modelId: 'y' } },
      { id: 'bad2', name: 'Bad', isCustom: true, modelConfig: {} },
      'nope',
      null
    ]
  });

  const presets = catalog.listPresets();
  assert.deepStrictEqual(presets.map(preset => preset.id), [...SEED_IDS, 'preset_custom_1']);

  const nanogpt = presets.find(preset => preset.id === 'nanogpt');
  assert.strictEqual(nanogpt.name, 'NanoGPT Edited');
  assert.strictEqual(nanogpt.modelConfig.modelId, 'edited-model');
  assert.ok(!('keyId' in nanogpt.modelConfig), 'loaded keyId must be stripped');

  const custom = presets.find(preset => preset.id === 'preset_custom_1');
  assert.strictEqual(custom.name, 'Second', 'duplicate ids resolve last-wins in place');
});

test('17. storage.save failures never propagate and keep the in-memory mutation', () => {
  const { catalog, state } = createHarness({ saveError: new Error('quota exceeded') });
  const events = [];
  catalog.subscribe(event => events.push(event));

  assert.doesNotThrow(() => catalog.savePreset(customPreset()));
  assert.strictEqual(catalog.getPreset('preset_custom_1').name, 'Custom Preset');
  assert.deepStrictEqual(events, [{ type: 'preset-updated', presetId: 'preset_custom_1' }]);
  assert.strictEqual(state.saves.length, 0);

  assert.doesNotThrow(() => catalog.deletePreset('preset_custom_1'));
  assert.strictEqual(catalog.getPreset('preset_custom_1'), null);
  assert.deepStrictEqual(events.at(-1), { type: 'preset-deleted', presetId: 'preset_custom_1' });
});

test('18. pointer closure failures never propagate', () => {
  const getFailing = createHarness({ getActiveError: new Error('read failure') }).catalog;
  assert.strictEqual(
    getFailing.createPresetSourcePort().getDefaultPresetId(),
    expectedFallbackDefaultId()
  );

  const setFailing = createHarness({ setActiveError: new Error('write failure') });
  assert.doesNotThrow(() => setFailing.catalog.setActivePresetId('nanogpt'));
  assert.strictEqual(setFailing.state.active, '', 'a failed pointer write is not persisted');
});

// ============================================================================
// 8. Source port
// ============================================================================

test('19. createPresetSourcePort returns a frozen read-only projection', () => {
  const { catalog } = createHarness();
  const port = catalog.createPresetSourcePort();

  assert.ok(Object.isFrozen(port));
  assert.deepStrictEqual(Object.keys(port).sort(), ['getDefaultPresetId', 'getPreset', 'subscribe']);
  assert.deepStrictEqual(port.getPreset('nanogpt'), catalog.getPreset('nanogpt'));
  assert.notStrictEqual(port.getPreset('nanogpt'), catalog.getPreset('nanogpt'));
  assert.strictEqual(port.getPreset('missing-id'), null);
  assert.strictEqual(port.getDefaultPresetId(), expectedFallbackDefaultId());
  assert.notStrictEqual(port, catalog.createPresetSourcePort(), 'each call builds a fresh port');

  const events = [];
  const unsubscribe = port.subscribe(event => events.push(event));
  catalog.savePreset(customPreset());
  assert.deepStrictEqual(events, [{ type: 'preset-updated', presetId: 'preset_custom_1' }]);
  unsubscribe();
  catalog.savePreset(customPreset({ id: 'preset_custom_2' }));
  assert.strictEqual(events.length, 1, 'the port unsubscribe must detach the listener');
});

test('20. deterministic outputs across constructions and mutations', () => {
  const first = createHarness({ stored: [customPreset()] }).catalog;
  const second = createHarness({ stored: [customPreset()] }).catalog;
  assert.deepStrictEqual(first.listPresets(), second.listPresets());

  first.savePreset(customPreset({ id: 'preset_custom_2' }));
  second.savePreset(customPreset({ id: 'preset_custom_2' }));
  assert.deepStrictEqual(first.listPresets(), second.listPresets());
  assert.deepStrictEqual(
    first.createPresetSourcePort().getDefaultPresetId(),
    second.createPresetSourcePort().getDefaultPresetId()
  );
});

// ============================================================================
// 9. Purity
// ============================================================================

test('21. module sources are pure: own/modelConfig imports and no ambient I/O', () => {
  const forbidden = [
    { id: 'window', pattern: /\bwindow\b/ },
    { id: 'localStorage', pattern: /\blocalStorage\b/ },
    { id: 'sessionStorage', pattern: /\bsessionStorage\b/ },
    { id: 'fetch', pattern: /\bfetch\s*\(/ },
    { id: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
    { id: 'navigator', pattern: /\bnavigator\b/ }
  ];

  for (const file of ['index.ts', 'catalog.ts', 'types.ts', 'port.ts']) {
    const source = fs.readFileSync(path.join(MODULE_DIR, file), 'utf-8');
    for (const { id, pattern } of forbidden) {
      assert.ok(!pattern.test(source), `${file} must not reference ${id}`);
    }
    const specifiers = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map(
      match => match[1]
    );
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('./') || specifier === '../modelConfig/index.ts',
        `${file} may import only its own files or modelConfig, found '${specifier}'`
      );
    }
  }

  const indexSource = fs.readFileSync(path.join(MODULE_DIR, 'index.ts'), 'utf-8');
  const body = indexSource.replace(/\/\*\*[\s\S]*?\*\//g, '');
  const remainder = body
    .replace(/import\s+type\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;/g, '')
    .replace(/export\s+(?:type\s+)?\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;/g, '')
    .replace(/export\s+interface\s+ModelPresetSourcePort\s*\{[\s\S]*?\n\}/g, '')
    .trim();
  assert.strictEqual(
    remainder,
    '',
    `index.ts must only declare the port contract interface and re-export, found: ${remainder}`
  );
});

// ============================================================================
// 10. Credential-field stripping
// ============================================================================

test('22. savePreset strips keyId/apiKey/encryptionKey and preserves legitimate fields', () => {
  const { catalog, state } = createHarness();
  catalog.savePreset(
    customPreset({
      modelConfig: {
        providerId: 'deepseek',
        keyId: 'canonical_deepseek',
        apiKey: 'sk-custom-secret',
        encryptionKey: 'kek-custom-secret',
        modelId: 'deepseek-flash',
        temperature: 0.2,
        reasoningEffort: 'high',
        routing: 'auto',
        url: 'https://example.invalid/v1'
      }
    })
  );

  const saved = catalog.getPreset('preset_custom_1');
  for (const field of CREDENTIAL_FIELDS) {
    assert.ok(!(field in saved.modelConfig), `${field} must be stripped on save`);
  }
  assert.strictEqual(saved.modelConfig.providerId, 'deepseek');
  assert.strictEqual(saved.modelConfig.modelId, 'deepseek-flash');
  assert.strictEqual(saved.modelConfig.temperature, 0.2);
  assert.strictEqual(saved.modelConfig.reasoningEffort, 'high');
  assert.strictEqual(saved.modelConfig.routing, 'auto');
  assert.strictEqual(saved.modelConfig.url, 'https://example.invalid/v1');

  const listed = catalog.listPresets().find(preset => preset.id === 'preset_custom_1');
  for (const field of CREDENTIAL_FIELDS) {
    assert.ok(!(field in listed.modelConfig), `${field} must be absent from listPresets`);
  }
  assert.strictEqual(listed.modelConfig.temperature, 0.2);

  const projected = catalog.createPresetSourcePort().getPreset('preset_custom_1');
  for (const field of CREDENTIAL_FIELDS) {
    assert.ok(!(field in projected.modelConfig), `${field} must be absent from the port projection`);
  }
  assert.strictEqual(projected.modelConfig.modelId, 'deepseek-flash');

  const projection = state.saves.at(-1);
  assert.ok(
    projection.every(preset =>
      CREDENTIAL_FIELDS.every(field => !(field in preset.modelConfig))
    ),
    'storage.save must never receive credential-shaped keys'
  );
});

test('23. adapter-loaded credential keys are stripped and never re-persisted', () => {
  const { catalog, state } = createHarness({
    stored: [
      {
        id: 'preset_loaded_1',
        name: 'Loaded Preset',
        isCustom: true,
        modelConfig: {
          providerId: 'custom',
          keyId: 'canonical_custom',
          apiKey: 'sk-loaded-secret',
          encryptionKey: 'kek-loaded-secret',
          modelId: 'loaded-model',
          temperature: 0.4,
          reasoningEffort: 'none',
          url: 'http://localhost:11434/v1'
        }
      }
    ]
  });

  const loaded = catalog.getPreset('preset_loaded_1');
  for (const field of CREDENTIAL_FIELDS) {
    assert.ok(!(field in loaded.modelConfig), `${field} must be stripped from adapter-loaded entries`);
  }
  assert.strictEqual(loaded.modelConfig.providerId, 'custom');
  assert.strictEqual(loaded.modelConfig.modelId, 'loaded-model');
  assert.strictEqual(loaded.modelConfig.temperature, 0.4);
  assert.strictEqual(loaded.modelConfig.reasoningEffort, 'none');
  assert.strictEqual(loaded.modelConfig.url, 'http://localhost:11434/v1');

  const listed = catalog.listPresets().find(preset => preset.id === 'preset_loaded_1');
  for (const field of CREDENTIAL_FIELDS) {
    assert.ok(!(field in listed.modelConfig), `${field} must be absent from listPresets`);
  }

  catalog.savePreset(customPreset());
  const projection = state.saves.at(-1);
  assert.ok(
    projection.every(preset =>
      CREDENTIAL_FIELDS.every(field => !(field in preset.modelConfig))
    ),
    'the persisted projection must stay credential-free after a later save'
  );
});

test('24. seed entries expose no credential-shaped keys and keep legitimate fields', () => {
  const { catalog } = createHarness();

  for (const preset of catalog.listPresets()) {
    for (const field of CREDENTIAL_FIELDS) {
      assert.ok(!(field in preset.modelConfig), `seed '${preset.id}' must not carry ${field}`);
    }
  }

  const nanogpt = catalog.getPreset('nanogpt');
  assert.strictEqual(nanogpt.modelConfig.providerId, 'nanogpt');
  assert.strictEqual(nanogpt.modelConfig.modelId, 'deepseek/deepseek-v4.1-flash:thinking');
  assert.strictEqual(nanogpt.modelConfig.temperature, 0.7);
  assert.strictEqual(nanogpt.modelConfig.reasoningEffort, 'high');
  assert.strictEqual(nanogpt.modelConfig.routing, 'auto');

  const customSeed = catalog.getPreset('custom');
  assert.strictEqual(customSeed.modelConfig.url, 'http://localhost:11434/v1');
});
