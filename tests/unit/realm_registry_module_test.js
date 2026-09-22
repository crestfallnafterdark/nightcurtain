/**
 * @file tests/unit/realm_registry_module_test.js
 * @description Isolated unit suite for the Wave A `realmRegistry` module.
 *
 * Contract coverage:
 *  1. Runtime export surface (single factory; type exports are compile-time).
 *  2. Adapter-ingested registry state: overlay by id, append unknown ids,
 *     drop invalid entries, degrade on load failures.
 *  3. Frozen records and fresh frozen copies on every read.
 *  4. CRUD: add (duplicate-refusing), update (patch + null clears), remove
 *     (unknown-id false no-op); id/createdAt immutability.
 *  5. Event emission: synchronous, ordered, listener-isolated, `realm-removed`
 *     observes the record as gone, idempotent unsubscribe.
 *  6. Closed shape: unknown fields dropped, optional fields preserved or absent.
 *  7. Adapter resilience: load/save failures degrade without throwing.
 *  8. Purity: own-file imports only, no ambient I/O identifiers, and `index.ts`
 *     carries re-exports only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as RealmRegistryModule from '../../src/lib/sandbox/realmRegistry/index.ts';
import { createRealmRegistry } from '../../src/lib/sandbox/realmRegistry/index.ts';

/** Module folder under test (source-level purity checks). */
const MODULE_DIR = path.resolve(import.meta.dirname, '../../src/lib/sandbox/realmRegistry');

/**
 * Builds a registry over an in-memory adapter with injectable failure modes.
 *
 * @param {object} [options] Harness overrides
 * @param {unknown[]} [options.stored] Adapter-load return value
 * @param {unknown} [options.loadValue] Explicit adapter-load return value
 * @param {Error} [options.loadError] When set, `load()` throws it
 * @param {Error} [options.saveError] When set, `save()` throws it
 * @param {string[]} [options.protectedIds] Ids the registry must refuse to remove
 * @returns {{ registry: object, state: object }} Registry + observable adapter state
 */
function createHarness(options = {}) {
  const state = {
    stored: options.stored ? [...options.stored] : [],
    saves: []
  };
  const hasLoadValue = Object.prototype.hasOwnProperty.call(options, 'loadValue');
  const storage = {
    load() {
      if (options.loadError) throw options.loadError;
      return hasLoadValue ? options.loadValue : state.stored;
    },
    save(realms) {
      if (options.saveError) throw options.saveError;
      state.saves.push(realms);
      state.stored = realms;
    }
  };
  const registry = createRealmRegistry({ storage, protectedIds: options.protectedIds });
  return { registry, state };
}

/**
 * Builds a valid realm record literal.
 *
 * @param {object} [overrides] Field overrides
 * @returns {object} Realm record literal
 */
function realm(overrides = {}) {
  return { id: 'realm_demo', name: 'Demo Realm', createdAt: 1, ...overrides };
}

// ============================================================================
// 1. Export surface
// ============================================================================

test('1. runtime surface exports createRealmRegistry only', () => {
  assert.deepStrictEqual(Object.keys(RealmRegistryModule).sort(), ['createRealmRegistry']);
  assert.strictEqual(typeof createRealmRegistry, 'function');
  assert.ok(!('default' in RealmRegistryModule), 'no default export');
  assert.ok(!('REALM_CHANGE_TYPES' in RealmRegistryModule), 'classification vocabulary stays internal');

  const { registry } = createHarness();
  assert.deepStrictEqual(
    Object.keys(registry).sort(),
    ['addRealm', 'getRealm', 'listRealms', 'removeRealm', 'subscribe', 'updateRealm'],
    'the registry surface must expose exactly get/list/add/update/remove + subscribe'
  );
  assert.ok(Object.isFrozen(registry), 'the registry service object must be frozen');
});

// ============================================================================
// 2. Adapter ingestion
// ============================================================================

test('2. adapter load overlays by id, appends unknown ids, drops invalid entries', () => {
  const { registry } = createHarness({
    stored: [
      realm({ id: 'realm_a', name: 'First' }),
      realm({ id: 'realm_a', name: 'Second' }),
      realm({ id: 'realm_b', name: 'B', description: 'desc', color: '#fff', templateId: 'tpl_1' }),
      { id: 'bad', name: '', createdAt: 1 },
      { id: 'bad2', name: 'Bad2' },
      { id: 'bad3', name: 'Bad3', createdAt: 'yesterday' },
      { id: 'bad4', name: 'Bad4', createdAt: 1, color: 42 },
      'nope',
      null
    ]
  });

  const records = registry.listRealms();
  assert.deepStrictEqual(records.map((record) => record.id), ['realm_a', 'realm_b']);
  assert.strictEqual(records[0].name, 'Second', 'duplicate ids resolve last-wins in place');
  assert.deepStrictEqual(records[1], {
    id: 'realm_b',
    name: 'B',
    description: 'desc',
    color: '#fff',
    templateId: 'tpl_1',
    createdAt: 1
  });
});

test('3. adapter load failures degrade to an empty registry', () => {
  let throwing;
  assert.doesNotThrow(() => {
    throwing = createHarness({ loadError: new Error('disk failure') }).registry;
  });
  assert.deepStrictEqual(throwing.listRealms(), []);

  assert.deepStrictEqual(createHarness({ loadValue: { not: 'an array' } }).registry.listRealms(), []);
  assert.deepStrictEqual(createHarness({ loadValue: null }).registry.listRealms(), []);
  assert.deepStrictEqual(createHarness({ loadValue: undefined }).registry.listRealms(), []);
});

// ============================================================================
// 3. Freeze + copy isolation
// ============================================================================

test('4. listRealms/getRealm return frozen fresh copies', () => {
  const { registry } = createHarness();
  registry.addRealm(realm());

  const firstList = registry.listRealms();
  const secondList = registry.listRealms();
  assert.notStrictEqual(firstList, secondList, 'listRealms must build a fresh array');
  assert.notStrictEqual(firstList[0], secondList[0], 'records must be fresh copies');
  assert.deepStrictEqual(firstList, secondList);
  assert.ok(Object.isFrozen(firstList), 'returned array must be frozen');
  assert.ok(Object.isFrozen(firstList[0]), 'returned record must be frozen');
  assert.throws(() => {
    firstList[0].name = 'mutated';
  }, TypeError);
  assert.throws(() => {
    firstList.push(realm());
  }, TypeError);

  const first = registry.getRealm('realm_demo');
  const second = registry.getRealm('realm_demo');
  assert.notStrictEqual(first, second);
  assert.deepStrictEqual(first, second);
  assert.ok(Object.isFrozen(first));
  assert.throws(() => {
    first.color = '#000';
  }, TypeError);
  assert.strictEqual(registry.getRealm('realm_demo').name, 'Demo Realm');
  assert.strictEqual(registry.getRealm('missing-id'), null);
});

// ============================================================================
// 4. CRUD
// ============================================================================

test('5. addRealm stores the record, persists the projection, emits realm-added', () => {
  const { registry, state } = createHarness();
  const events = [];
  registry.subscribe((event) => events.push(event));

  const created = registry.addRealm(realm({ color: '#abc' }));

  assert.deepStrictEqual(events, [{ type: 'realm-added', realmId: 'realm_demo' }]);
  assert.ok(Object.isFrozen(events[0]), 'event objects must be frozen');
  assert.throws(() => {
    events[0].type = 'mutated';
  }, TypeError);
  assert.ok(Object.isFrozen(created), 'the created record must be frozen');
  assert.strictEqual(created.color, '#abc');
  assert.deepStrictEqual(
    state.saves.at(-1),
    [{ id: 'realm_demo', name: 'Demo Realm', color: '#abc', createdAt: 1 }],
    'the adapter must receive the full frozen registry projection'
  );
  assert.ok(state.saves.at(-1).every((record) => Object.isFrozen(record)));
});

test('6. addRealm rejects invalid records and duplicate ids without mutating', () => {
  const { registry, state } = createHarness();
  const events = [];
  registry.subscribe((event) => events.push(event));

  const invalid = [
    null,
    undefined,
    'nope',
    realm({ id: '' }),
    realm({ id: 7 }),
    realm({ name: '' }),
    realm({ name: 7 }),
    realm({ createdAt: undefined }),
    realm({ createdAt: NaN }),
    realm({ createdAt: Infinity }),
    realm({ description: 7 }),
    realm({ color: 7 }),
    realm({ templateId: 7 })
  ];
  for (const record of invalid) {
    assert.throws(() => registry.addRealm(record), Error, `must reject ${JSON.stringify(record)}`);
  }
  assert.deepStrictEqual(registry.listRealms(), []);
  assert.strictEqual(state.saves.length, 0, 'rejected adds must not persist');

  registry.addRealm(realm());
  assert.throws(() => registry.addRealm(realm({ name: 'Other' })), /duplicate/);
  assert.strictEqual(registry.getRealm('realm_demo').name, 'Demo Realm', 'the duplicate must not overwrite');
  assert.deepStrictEqual(events, [{ type: 'realm-added', realmId: 'realm_demo' }]);
});

test('7. addRealm keeps only canonical fields and preserves absent optionals', () => {
  const { registry, state } = createHarness();
  registry.addRealm(
    realm({ apiKey: 'sk-test-should-not-survive', unknownField: { nested: true }, description: 'kept' })
  );

  const stored = registry.getRealm('realm_demo');
  assert.deepStrictEqual(
    Object.keys(stored).sort(),
    ['createdAt', 'description', 'id', 'name'],
    'unknown fields must be dropped and absent optionals must stay absent'
  );
  assert.strictEqual(stored.apiKey, undefined);
  assert.strictEqual(stored.unknownField, undefined);
  assert.deepStrictEqual(Object.keys(state.saves.at(-1)[0]).sort(), ['createdAt', 'description', 'id', 'name']);
});

test('8. updateRealm patches fields in place, persists, and emits realm-updated', () => {
  const { registry, state } = createHarness();
  registry.addRealm(realm({ description: 'old', color: '#000', templateId: 'tpl_old' }));

  const events = [];
  registry.subscribe((event) => events.push(event));
  const updated = registry.updateRealm('realm_demo', { name: 'Renamed', color: '#fff' });

  assert.deepStrictEqual(events, [{ type: 'realm-updated', realmId: 'realm_demo' }]);
  assert.strictEqual(updated.name, 'Renamed');
  assert.strictEqual(updated.color, '#fff');
  assert.strictEqual(updated.description, 'old', 'unpatched optional fields stay unchanged');
  assert.strictEqual(updated.templateId, 'tpl_old');
  assert.strictEqual(updated.createdAt, 1, 'createdAt is immutable');
  assert.strictEqual(registry.getRealm('realm_demo').name, 'Renamed');
  assert.deepStrictEqual(state.saves.at(-1)[0], updated);
});

test('9. updateRealm null clears an optional field', () => {
  const { registry } = createHarness();
  registry.addRealm(realm({ description: 'gone', color: '#000' }));

  registry.updateRealm('realm_demo', { description: null, color: null });

  const stored = registry.getRealm('realm_demo');
  assert.ok(!('description' in stored), 'null must clear description');
  assert.ok(!('color' in stored), 'null must clear color');
});

test('10. updateRealm rejects unknown ids and invalid values without mutating', () => {
  const { registry, state } = createHarness();
  registry.addRealm(realm({ color: '#000' }));
  const events = [];
  registry.subscribe((event) => events.push(event));
  const savesBefore = state.saves.length;

  assert.throws(() => registry.updateRealm('missing-id', { name: 'X' }), /existing realm/);
  assert.throws(() => registry.updateRealm('', { name: 'X' }), /existing realm/);
  assert.throws(() => registry.updateRealm('realm_demo', null), Error);
  assert.throws(() => registry.updateRealm('realm_demo', 'nope'), Error);
  assert.throws(() => registry.updateRealm('realm_demo', { name: '' }), Error);
  assert.throws(() => registry.updateRealm('realm_demo', { name: 7 }), Error);
  assert.throws(() => registry.updateRealm('realm_demo', { color: 7 }), Error);
  assert.throws(() => registry.updateRealm('realm_demo', { description: 7 }), Error);
  assert.throws(() => registry.updateRealm('realm_demo', { templateId: 7 }), Error);

  assert.deepStrictEqual(registry.listRealms(), [realm({ color: '#000' })]);
  assert.strictEqual(state.saves.length, savesBefore, 'rejected updates must not persist');
  assert.deepStrictEqual(events, []);

  // Unknown patch keys are ignored; id/createdAt cannot be rewritten.
  const unchanged = registry.updateRealm('realm_demo', {
    id: 'realm_other',
    createdAt: 999,
    apiKey: 'sk-x',
    unknownKey: true
  });
  assert.strictEqual(unchanged.id, 'realm_demo');
  assert.strictEqual(unchanged.createdAt, 1);
  assert.ok(!('apiKey' in unchanged));
});

test('11. removeRealm emits after removal and persists; unknown ids are a false no-op', () => {
  const { registry, state } = createHarness();
  registry.addRealm(realm());

  const observed = [];
  registry.subscribe((event) => {
    if (event.type === 'realm-removed') observed.push(registry.getRealm(event.realmId));
  });
  assert.strictEqual(registry.removeRealm('realm_demo'), true);

  assert.deepStrictEqual(observed, [null], 'listeners must observe the record as removed');
  assert.strictEqual(registry.getRealm('realm_demo'), null);
  assert.deepStrictEqual(state.saves.at(-1), []);

  const events = [];
  registry.subscribe((event) => events.push(event));
  assert.strictEqual(registry.removeRealm('realm_demo'), false);
  assert.strictEqual(registry.removeRealm(''), false);
  assert.strictEqual(registry.removeRealm(null), false);
  assert.deepStrictEqual(events, [], 'unknown removals must not emit');
});

// ============================================================================
// 5. Events
// ============================================================================

test('12. listener exceptions are isolated; order and unsubscribe are stable', () => {
  const { registry } = createHarness();
  const order = [];
  registry.subscribe(() => {
    order.push('first');
    throw new Error('listener boom');
  });
  const unsubscribe = registry.subscribe(() => {
    order.push('second');
  });

  assert.doesNotThrow(() => registry.addRealm(realm()));
  assert.deepStrictEqual(order, ['first', 'second'], 'registration order is preserved');

  unsubscribe();
  unsubscribe();
  registry.updateRealm('realm_demo', { name: 'Renamed' });
  assert.deepStrictEqual(order, ['first', 'second', 'first']);

  assert.throws(() => registry.subscribe(null), TypeError);
});

// ============================================================================
// 6. Adapter resilience
// ============================================================================

test('13. storage.save failures never propagate and keep the in-memory mutation', () => {
  const { registry, state } = createHarness({ saveError: new Error('quota exceeded') });
  const events = [];
  registry.subscribe((event) => events.push(event));

  assert.doesNotThrow(() => registry.addRealm(realm()));
  assert.strictEqual(registry.getRealm('realm_demo').name, 'Demo Realm');
  assert.deepStrictEqual(events, [{ type: 'realm-added', realmId: 'realm_demo' }]);
  assert.strictEqual(state.saves.length, 0);

  assert.doesNotThrow(() => registry.removeRealm('realm_demo'));
  assert.strictEqual(registry.getRealm('realm_demo'), null);
  assert.deepStrictEqual(events.at(-1), { type: 'realm-removed', realmId: 'realm_demo' });
});

test('14. persisted projection determinism across constructions and mutations', () => {
  const first = createHarness({ stored: [realm()] }).registry;
  const second = createHarness({ stored: [realm()] }).registry;
  assert.deepStrictEqual(first.listRealms(), second.listRealms());

  first.updateRealm('realm_demo', { description: 'shared' });
  second.updateRealm('realm_demo', { description: 'shared' });
  assert.deepStrictEqual(first.listRealms(), second.listRealms());

  first.removeRealm('realm_demo');
  second.removeRealm('realm_demo');
  assert.deepStrictEqual(first.listRealms(), []);
  assert.deepStrictEqual(second.listRealms(), []);
});

// ============================================================================
// 7. Purity
// ============================================================================

test('15. module sources are pure: own-file imports and no ambient I/O', () => {
  const forbidden = [
    { id: 'window', pattern: /\bwindow\b/ },
    { id: 'localStorage', pattern: /\blocalStorage\b/ },
    { id: 'sessionStorage', pattern: /\bsessionStorage\b/ },
    { id: 'fetch', pattern: /\bfetch\s*\(/ },
    { id: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
    { id: 'navigator', pattern: /\bnavigator\b/ }
  ];

  for (const file of ['index.ts', 'registry.ts', 'types.ts']) {
    const source = fs.readFileSync(path.join(MODULE_DIR, file), 'utf-8');
    for (const { id, pattern } of forbidden) {
      assert.ok(!pattern.test(source), `${file} must not reference ${id}`);
    }
    const specifiers = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1]
    );
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('./'), `${file} may import only its own files, found '${specifier}'`);
    }
  }

  const indexSource = fs.readFileSync(path.join(MODULE_DIR, 'index.ts'), 'utf-8');
  const body = indexSource.replace(/\/\*\*[\s\S]*?\*\//g, '');
  const remainder = body
    .replace(/import\s+type\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;/g, '')
    .replace(/export\s+(?:type\s+)?\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;/g, '')
    .trim();
  assert.strictEqual(remainder, '', `index.ts must only re-export, found: ${remainder}`);
});

// ============================================================================
// 8. Protected ids (Wave R hardening, ticket 0fe25fd)
// ============================================================================

test('16. protected ids refuse removal as a false no-op while every other management operation stays available', () => {
  const { registry, state } = createHarness({ protectedIds: ['realm_generic'] });
  registry.addRealm(realm({ id: 'realm_generic', name: 'Generic' }));
  registry.addRealm(realm({ id: 'realm_other', name: 'Other' }));

  const events = [];
  registry.subscribe((event) => events.push(event));
  const savesBefore = state.saves.length;
  const projectedBefore = registry.listRealms();

  assert.strictEqual(registry.removeRealm('realm_generic'), false, 'a protected removal is refused');
  assert.strictEqual(registry.getRealm('realm_generic').name, 'Generic', 'the protected record is untouched');
  assert.deepStrictEqual(registry.listRealms(), projectedBefore, 'the protected projection is untouched');
  assert.strictEqual(state.saves.length, savesBefore, 'a refused removal never persists');
  assert.deepStrictEqual(events, [], 'a refused removal never emits');

  // The rest of the management contract stays available for the protected id.
  const renamed = registry.updateRealm('realm_generic', { name: 'General', color: '#aabbcc' });
  assert.strictEqual(renamed.name, 'General');
  assert.strictEqual(registry.getRealm('realm_generic').name, 'General');
  assert.throws(() => registry.addRealm(realm({ id: 'realm_generic', name: 'Clone' })), /duplicate/);

  // Non-protected ids stay removable; unknown ids stay a false no-op.
  assert.strictEqual(registry.removeRealm('realm_other'), true);
  assert.strictEqual(registry.getRealm('realm_other'), null);
  assert.strictEqual(registry.removeRealm('realm_absent'), false);
  assert.deepStrictEqual(registry.listRealms().map((record) => record.id), ['realm_generic']);

  // A registry without declared protection keeps the pre-existing contract.
  const unprotected = createHarness().registry;
  unprotected.addRealm(realm({ id: 'realm_generic', name: 'Generic' }));
  assert.strictEqual(unprotected.removeRealm('realm_generic'), true, 'protection is opt-in per registry');
});

// ============================================================================
// 17. Wave T (ticket 0df20ae): instance provenance metadata
// ============================================================================

/**
 * Builds a valid launch-provenance record.
 *
 * @param {object} [overrides] - Field overrides.
 * @returns {object} Provenance record literal.
 */
function instanceProvenance(overrides = {}) {
  return {
    templateId: 'unit_template',
    templateVersion: `sha256:${'a'.repeat(64)}`,
    packageDigest: `sha256:${'b'.repeat(64)}`,
    inputHashes: { brief: `sha256:${'c'.repeat(64)}` },
    seedPaths: ['/lore/world.md'],
    launchedAt: '2026-09-21T00:00:00.000Z',
    resolvedTools: { 'text.similarity': 'acme/text-tools@1.0.0#sha256:abc' },
    ...overrides
  };
}

test('17. instance provenance is copied, frozen, patchable, and validated', () => {
  const { registry } = createHarness();
  const created = registry.addRealm(realm({ instance: instanceProvenance() }));

  assert.ok(Object.isFrozen(created.instance), 'provenance is frozen');
  assert.ok(Object.isFrozen(created.instance.inputHashes), 'nested hashes are frozen');
  assert.ok(Object.isFrozen(created.instance.seedPaths), 'nested paths are frozen');
  assert.ok(Object.isFrozen(created.instance.resolvedTools), 'resolvedTools is frozen when present');

  // Reads hand out fresh frozen copies, never internal references.
  const readA = registry.getRealm('realm_demo');
  const readB = registry.getRealm('realm_demo');
  assert.notStrictEqual(readA.instance, readB.instance, 'every read clones provenance');
  assert.notStrictEqual(readA.instance.inputHashes, readB.instance.inputHashes);
  assert.deepStrictEqual(readA.instance, instanceProvenance(), 'provenance round-trips');

  // Unknown sub-fields are dropped by the closed shape.
  registry.updateRealm('realm_demo', { instance: instanceProvenance({ localOnly: 'drop me' }) });
  assert.deepStrictEqual(
    Object.keys(registry.getRealm('realm_demo').instance).sort(),
    ['inputHashes', 'launchedAt', 'packageDigest', 'resolvedTools', 'seedPaths', 'templateId', 'templateVersion']
  );

  // `resolvedTools` is optional and reserved for Wave P.
  registry.updateRealm('realm_demo', { instance: instanceProvenance({ resolvedTools: undefined }) });
  assert.strictEqual(registry.getRealm('realm_demo').instance.resolvedTools, undefined);

  // A patch replaces the whole provenance block; `null` clears it.
  const replaced = registry.updateRealm('realm_demo', {
    instance: instanceProvenance({ templateId: 'second_template', seedPaths: [] })
  });
  assert.strictEqual(replaced.instance.templateId, 'second_template');
  assert.deepStrictEqual(replaced.instance.seedPaths, []);
  assert.strictEqual(registry.updateRealm('realm_demo', { instance: null }).instance, undefined);

  // Malformed caller input is refused (add and update) without mutating state.
  const validRecord = { id: 'realm_guard', name: 'Guard', createdAt: 2 };
  for (const bad of [
    { templateId: 'x' },
    { ...instanceProvenance(), templateVersion: '' },
    { ...instanceProvenance(), launchedAt: 42 },
    { ...instanceProvenance(), inputHashes: { brief: 42 } },
    { ...instanceProvenance(), seedPaths: ['ok', 7] },
    { ...instanceProvenance(), packageDigest: '' },
    { ...instanceProvenance(), resolvedTools: { a: 1 } },
    'not-an-object'
  ]) {
    assert.throws(
      () => registry.addRealm({ ...validRecord, id: `realm_bad_${String(bad)}`, instance: bad }),
      /non-empty string id and name/,
      'a malformed instance refuses addRealm'
    );
  }
  assert.strictEqual(registry.getRealm('realm_guard'), null, 'refused adds create nothing');
  assert.strictEqual(registry.addRealm(validRecord).instance, undefined, 'provenance stays optional');
  assert.throws(
    () => registry.updateRealm('realm_guard', { instance: { templateId: 'x' } }),
    /valid instance provenance/,
    'a malformed instance refuses updateRealm'
  );
  assert.strictEqual(registry.updateRealm('realm_guard', { name: 'Guard 2' }).instance, undefined);

  // Adapter-loaded records with a malformed instance are dropped entirely.
  const { registry: loaded } = createHarness({
    stored: [
      realm({ id: 'realm_ok', instance: instanceProvenance() }),
      realm({ id: 'realm_bad', instance: { templateId: 'incomplete' } })
    ]
  });
  assert.deepStrictEqual(loaded.listRealms().map((record) => record.id), ['realm_ok']);
  assert.deepStrictEqual(loaded.getRealm('realm_ok').instance, instanceProvenance());
});
