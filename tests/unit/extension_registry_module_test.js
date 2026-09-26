/**
 * @file tests/unit/extension_registry_module_test.js
 * @description Isolated unit suite for the extension-wave `extensionRegistry`
 *   module plus its real-store adapter path.
 *
 * Contract coverage:
 *  1. Runtime export surface (factories/classes/constants; types are
 *     compile-time).
 *  2. Install-record validation: ids, kinds, kind-compatible transport hints,
 *     statuses, install sources, warnings, createdAt; typed error codes.
 *  3. Freeze/copy isolation: every read returns frozen fresh copies with fresh
 *     nested arrays, never internal references.
 *  4. Install CRUD: duplicate refusal, unknown remove `false` no-op, adapter
 *     persistence after every mutation, adapter-failure resilience.
 *  5. Adapter ingestion: overlay by id, malformed entries dropped.
 *  6. `reconcile`: snapshot-authoritative validation, malformed entry drop,
 *     duplicate last-wins, no-op never persists.
 *  7. Attachment validation: `toolSelection` shape/uniqueness/sanitization,
 *     reserved call names, wildcard refusal, status/approval stamp.
 *  8. Attach/detach list helpers: append order, duplicate refusal, frozen
 *     copies, detach no-op copies.
 *  9. Resolution permutations: installed+attached, installed-not-attached,
 *     not-installed, selection-excluded, declared-order determinism, frozen
 *     outputs, unreserved call-name projection.
 * 10. Resolution failure matrix: malformed requests/references, undeclared
 *     reference targets, duplicate ids, reserved/prototype derivations,
 *     call-name collisions, malformed context, duplicate context ids.
 * 11. Real-store persistence round-trip: install → snapshot → reload, plus a
 *     tampered snapshot whose malformed install record and unknown-extension
 *     attachment degrade through the validated load path.
 * 12. Purity: own-file plus sanctioned normalizer imports, no ambient I/O,
 *     `index.ts` re-exports only.
 *
 * Zero-Mock Verification: the registry, the persistence validator, and the
 * `SandboxStore` composition root are all real production classes; the only
 * fake is the in-memory storage adapter the module's own constructor accepts.
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import * as ExtensionRegistryModule from '../../src/lib/sandbox/extensionRegistry/index.ts';
import {
  EXTENSION_KINDS,
  EXTENSION_REGISTRY_ERROR_CODES,
  ExtensionRegistryError,
  createExtensionRegistry,
  isRealmExtensionAttachment,
  normalizeExtensionInstallRecord,
  normalizeRealmExtensionAttachment,
  resolveExtensionRequests
} from '../../src/lib/sandbox/extensionRegistry/index.ts';
import { createSandboxStore } from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { saveSandboxState, validateSandboxState } from '../../src/lib/sandbox/sandboxPersistence/index.ts';

/** Module folder under test (source-level purity checks). */
const MODULE_DIR = path.resolve(import.meta.dirname, '../../src/lib/sandbox/extensionRegistry');

/**
 * Builds a registry over an in-memory adapter with injectable failure modes.
 *
 * @param {object} [options] Harness overrides
 * @param {unknown[]} [options.stored] Adapter-load return value
 * @param {unknown} [options.loadValue] Explicit adapter-load return value
 * @param {Error} [options.loadError] When set, `load()` throws it
 * @param {Error} [options.saveError] When set, `save()` throws it
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
    save(records) {
      if (options.saveError) throw options.saveError;
      state.saves.push(records);
      state.stored = records;
    }
  };
  const registry = createExtensionRegistry({ storage });
  return { registry, state };
}

/**
 * Builds a valid MCP install record literal.
 *
 * @param {object} [overrides] Field overrides
 * @returns {object} Install record literal
 */
function installRecord(overrides = {}) {
  return {
    id: 'acme-scoring',
    kind: 'mcp',
    transportHint: { kind: 'http', url: 'https://mcp.example.com' },
    status: 'installed',
    installSource: 'operator',
    createdAt: 1,
    ...overrides
  };
}

/**
 * Builds a valid attachment literal.
 *
 * @param {object} [overrides] Field overrides
 * @returns {object} Attachment literal
 */
function attachment(overrides = {}) {
  return {
    extensionId: 'acme-scoring',
    toolSelection: 'all',
    status: 'active',
    approvedAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'operator',
    ...overrides
  };
}

// ============================================================================
// 1. Export surface
// ============================================================================

test('1. runtime surface exports the sanctioned factories/classes/constants', () => {
  assert.deepStrictEqual(
    Object.keys(ExtensionRegistryModule).sort(),
    [
      'EXTENSION_KINDS',
      'EXTENSION_REGISTRY_ERROR_CODES',
      'ExtensionRegistryError',
      'createExtensionRegistry',
      'isRealmExtensionAttachment',
      'normalizeExtensionInstallRecord',
      'normalizeRealmExtensionAttachment',
      'resolveExtensionRequests'
    ],
    'the module surface must expose exactly the sanctioned runtime exports'
  );
  assert.deepStrictEqual(EXTENSION_KINDS, { MCP: 'mcp', PACK: 'pack' });
  assert.ok(Object.isFrozen(EXTENSION_KINDS), 'the kind vocabulary must be frozen');
  assert.ok(Object.isFrozen(EXTENSION_REGISTRY_ERROR_CODES), 'the error-code dictionary must be frozen');

  const { registry } = createHarness();
  assert.deepStrictEqual(
    Object.keys(registry).sort(),
    [
      'attachExtension',
      'createAttachment',
      'detachExtension',
      'getExtension',
      'installExtension',
      'listExtensions',
      'reconcile',
      'removeExtension',
      'resolve'
    ],
    'the registry surface must expose exactly the documented methods'
  );
  assert.ok(Object.isFrozen(registry), 'the registry service object must be frozen');
  assert.ok(Object.isFrozen(EXTENSION_REGISTRY_ERROR_CODES), 'error codes stay frozen');
});

// ============================================================================
// 2. Install-record validation
// ============================================================================

test('2. install-record validation fails closed with typed codes', () => {
  const cases = [
    [null, /must be an object/],
    [{ ...installRecord(), id: '' }, /id must be a non-empty string/],
    [{ ...installRecord(), id: '__proto__' }, /reserved property name/],
    [{ ...installRecord(), kind: 'stdio' }, /kind must be 'mcp' or 'pack'/],
    [{ ...installRecord(), transportHint: null }, /transportHint must be an object/],
    [{ ...installRecord(), kind: 'pack', transportHint: { kind: 'http', url: 'u' } }, /pack transport hint/],
    [{ ...installRecord(), transportHint: { kind: 'http', url: '' } }, /url must be a non-empty string/],
    [{ ...installRecord(), transportHint: { kind: 'stdio', command: '' } }, /command must be a non-empty string/],
    [{ ...installRecord(), transportHint: { kind: 'stdio', command: 'npx', args: [1] } }, /args must be an array of strings/],
    [{ ...installRecord(), transportHint: { kind: 'nope' } }, /kind must be 'http', 'stdio', or 'pack'/],
    [{ ...installRecord(), status: 'connected' }, /status must be/],
    [{ ...installRecord(), installSource: 'template' }, /installSource must be/],
    [{ ...installRecord(), createdAt: 'yesterday' }, /createdAt must be a finite number/],
    [{ ...installRecord(), normalizationWarnings: ['ok', ''] }, /normalizationWarnings/],
    [{ ...installRecord(), displayName: '' }, /displayName must be a non-empty string/]
  ];
  for (const [candidate, pattern] of cases) {
    assert.throws(
      () => normalizeExtensionInstallRecord(candidate),
      (error) => error instanceof ExtensionRegistryError
        && error.code === EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD
        && pattern.test(error.message),
      `expected a typed invalid-record failure for ${JSON.stringify(candidate)}`
    );
  }

  const normalized = normalizeExtensionInstallRecord(installRecord({
    kind: 'pack',
    transportHint: { kind: 'pack', source: 'npm:@acme/pack' },
    displayName: 'Acme Pack',
    credentialId: 'cred_1',
    status: 'unavailable',
    installSource: 'template-assist',
    approvedUrl: 'https://approved.example.com',
    normalizationWarnings: ['deprecated field ignored']
  }));
  assert.deepStrictEqual(normalized, {
    id: 'acme-scoring',
    kind: 'pack',
    displayName: 'Acme Pack',
    transportHint: { kind: 'pack', source: 'npm:@acme/pack' },
    credentialId: 'cred_1',
    status: 'unavailable',
    installSource: 'template-assist',
    approvedUrl: 'https://approved.example.com',
    normalizationWarnings: ['deprecated field ignored'],
    createdAt: 1
  });
});

// ============================================================================
// 3. Freeze/copy isolation
// ============================================================================

test('3. every read returns frozen fresh copies with fresh nested arrays', () => {
  const { registry } = createHarness();
  const installed = registry.installExtension(installRecord({
    transportHint: { kind: 'stdio', command: 'npx', args: ['-y', 'server'] },
    normalizationWarnings: ['w1']
  }));
  assert.ok(Object.isFrozen(installed), 'installed record must be frozen');
  assert.ok(Object.isFrozen(installed.transportHint), 'nested hint must be frozen');
  assert.ok(Object.isFrozen(installed.transportHint.args), 'nested args must be frozen');
  assert.ok(Object.isFrozen(installed.normalizationWarnings), 'nested warnings must be frozen');

  const listed = registry.listExtensions();
  assert.ok(Object.isFrozen(listed), 'the list must be frozen');
  assert.notStrictEqual(listed[0], installed, 'reads must not alias the install return');
  assert.notStrictEqual(listed[0].transportHint.args, installed.transportHint.args, 'nested arrays must be fresh copies');
  const fetched = registry.getExtension('acme-scoring');
  assert.notStrictEqual(fetched, listed[0], 'get must not alias list');
  assert.deepStrictEqual(fetched, listed[0], 'copies must be deep-equal');
});

// ============================================================================
// 4. CRUD + adapter persistence
// ============================================================================

test('4. install/remove CRUD persists through the adapter and refuses duplicates', () => {
  const { registry, state } = createHarness();
  const record = registry.installExtension(installRecord());
  assert.strictEqual(state.saves.length, 1, 'install persists once');
  assert.deepStrictEqual(state.saves[0].map((entry) => entry.id), ['acme-scoring']);

  assert.throws(
    () => registry.installExtension(installRecord({ name: 'dupe' })),
    (error) => error.code === EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_DUPLICATE_ID
  );
  assert.strictEqual(state.saves.length, 1, 'a refused duplicate never persists');

  registry.installExtension(installRecord({ id: 'beta-pack', kind: 'pack', transportHint: { kind: 'pack', source: 'src' } }));
  assert.deepStrictEqual(registry.listExtensions().map((entry) => entry.id), ['acme-scoring', 'beta-pack'], 'registry order is insertion order');
  assert.strictEqual(registry.getExtension('absent'), null);

  assert.strictEqual(registry.removeExtension('absent'), false, 'unknown ids are a false no-op');
  assert.strictEqual(state.saves.length, 2, 'a false no-op never persists');
  assert.strictEqual(registry.removeExtension(record.id), true);
  assert.deepStrictEqual(registry.listExtensions().map((entry) => entry.id), ['beta-pack']);
  assert.strictEqual(state.saves.length, 3, 'remove persists');
});

// 5. Adapter resilience

test('5. adapter failures degrade to the in-memory registry', () => {
  const saveFailing = createHarness({ saveError: new Error('quota') });
  assert.doesNotThrow(() => saveFailing.registry.installExtension(installRecord()));
  assert.strictEqual(saveFailing.registry.listExtensions().length, 1, 'the in-memory record survives a failing save');

  const loadFailing = createHarness({ loadError: new Error('unavailable') });
  assert.deepStrictEqual(loadFailing.registry.listExtensions(), [], 'a throwing load degrades to empty');
  const loadGarbage = createHarness({ loadValue: 'nope' });
  assert.deepStrictEqual(loadGarbage.registry.listExtensions(), [], 'a non-array load degrades to empty');
});

// ============================================================================
// 6. Adapter ingestion
// ============================================================================

test('6. adapter load overlays by id and drops malformed entries', () => {
  const { registry } = createHarness({
    stored: [
      installRecord({ id: 'a', displayName: 'First' }),
      installRecord({ id: 'a', displayName: 'Second' }),
      installRecord({ id: 'b', kind: 'pack', transportHint: { kind: 'pack', source: 's' } }),
      { id: '', kind: 'mcp', transportHint: { kind: 'http', url: 'u' }, status: 'installed', installSource: 'operator', createdAt: 1 },
      { id: 'c', kind: 'nope', transportHint: { kind: 'http', url: 'u' }, status: 'installed', installSource: 'operator', createdAt: 1 },
      { id: 'd', kind: 'mcp', transportHint: { kind: 'http', url: 'u' }, status: 'bogus', installSource: 'operator', createdAt: 1 },
      null,
      'nope'
    ]
  });
  const records = registry.listExtensions();
  assert.deepStrictEqual(records.map((entry) => entry.id), ['a', 'b'], 'invalid entries drop, duplicate ids last-win in place');
  assert.strictEqual(records[0].displayName, 'Second');
});

// ============================================================================
// 7. Reconcile
// ============================================================================

test('7. reconcile applies a validated snapshot-authoritative set without churn', () => {
  const { registry, state } = createHarness();
  registry.installExtension(installRecord({ id: 'stale' }));
  const savesBefore = state.saves.length;

  const applied = registry.reconcile([
    installRecord({ id: 'kept' }),
    { id: 'bad', kind: 'mcp', transportHint: { kind: 'http', url: 'u' }, status: 'nope', installSource: 'operator', createdAt: 1 },
    installRecord({ id: 'kept', displayName: 'Last wins' })
  ]);
  assert.deepStrictEqual(applied.map((entry) => entry.id), ['kept'], 'malformed entries drop; duplicate ids last-win in place');
  assert.strictEqual(applied[0].displayName, 'Last wins');
  assert.strictEqual(state.saves.length, savesBefore + 1, 'a changed set persists once');

  const before = state.saves.length;
  registry.reconcile([applied[0]]);
  assert.strictEqual(state.saves.length, before, 'an unchanged set never persists');

  assert.deepStrictEqual(registry.reconcile(null), [], 'a non-array reconcile target clears the registry');
  assert.deepStrictEqual(registry.reconcile([]), [], 'an empty array clears the registry');
});

// ============================================================================
// 8-9. Attachment validation + helpers
// ============================================================================

test('8. attachment validation enforces call-name hygiene and the approval stamp', () => {
  const { registry } = createHarness();
  const valid = registry.createAttachment(attachment({ toolSelection: ['search_docs', 'summarize_v2'] }));
  assert.ok(Object.isFrozen(valid));
  assert.ok(Object.isFrozen(valid.toolSelection), 'the selection array must be frozen');
  assert.deepStrictEqual(valid.toolSelection, ['search_docs', 'summarize_v2']);

  const cases = [
    [attachment({ extensionId: '' }), /extensionId must be a non-empty string/],
    [attachment({ toolSelection: [] }), /must be 'all' or a non-empty array/],
    [attachment({ toolSelection: '*' }), /non-empty array of sanitized call names/],
    [attachment({ toolSelection: ['*'] }), /wildcard/],
    [attachment({ toolSelection: ['read_file'] }), /reserved tool call name/],
    [attachment({ toolSelection: ['import_realm_template'] }), /reserved tool call name/],
    [attachment({ toolSelection: ['not.sanitized'] }), /must already be a sanitized call name/],
    [attachment({ toolSelection: ['a_b', 'a_b'] }), /duplicate call name/],
    [attachment({ toolSelection: ['__proto__'] }), /reserved tool call name/],
    [attachment({ status: 'bogus' }), /status must be/],
    [attachment({ approvedAt: '' }), /approvedAt must be a non-empty/],
    [attachment({ approvedBy: 'agent' }), /approvedBy must be 'operator'/]
  ];
  for (const [candidate, pattern] of cases) {
    assert.throws(
      () => registry.createAttachment(candidate),
      (error) => error.code === EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT && pattern.test(error.message),
      `expected a typed invalid-attachment failure for ${JSON.stringify(candidate)}`
    );
  }

  assert.strictEqual(isRealmExtensionAttachment(attachment()), true);
  assert.strictEqual(isRealmExtensionAttachment({ geometry: 'bad' }), false);
  assert.deepStrictEqual(normalizeRealmExtensionAttachment({ geometry: 'bad' }), null);
});

test('9. attach/detach helpers are frozen, ordered, and duplicate-safe', () => {
  const { registry } = createHarness();
  const first = registry.createAttachment(attachment({ extensionId: 'a' }));
  const second = registry.createAttachment(attachment({ extensionId: 'b', status: 'unavailable' }));
  const list = registry.attachExtension([], first);
  assert.deepStrictEqual(list.map((entry) => entry.extensionId), ['a']);
  const appended = registry.attachExtension(list, second);
  assert.deepStrictEqual(appended.map((entry) => entry.extensionId), ['a', 'b'], 'attachments append in call order');
  assert.ok(Object.isFrozen(appended));
  assert.notStrictEqual(appended, list, 'attach returns a fresh list');

  assert.throws(
    () => registry.attachExtension(appended, first),
    (error) => error.code === EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT
  );
  assert.throws(
    () => registry.attachExtension([first, first], second),
    (error) => error.code === EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT
  );

  const detached = registry.detachExtension(appended, 'a');
  assert.deepStrictEqual(detached.map((entry) => entry.extensionId), ['b']);
  assert.ok(Object.isFrozen(detached));
  const noop = registry.detachExtension(detached, 'absent');
  assert.deepStrictEqual(noop.map((entry) => entry.extensionId), ['b'], 'detaching an absent extension copies the list');
  assert.throws(
    () => registry.detachExtension(detached, ''),
    (error) => error.code === EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT
  );
});

// ============================================================================
// 10. Resolution permutations
// ============================================================================

test('10. resolution covers every installed/attached/missing permutation in declared order', () => {
  const installs = [
    installRecord({ id: 'installed-active' }),
    installRecord({ id: 'installed-inactive' }),
    installRecord({ id: 'installed-narrow' })
  ];
  const attachments = [
    attachment({ extensionId: 'installed-active' }),
    attachment({ extensionId: 'installed-inactive', status: 'unavailable' }),
    attachment({ extensionId: 'installed-narrow', toolSelection: ['kept_tool'] })
  ];
  const requests = [
    { id: 'installed-active', kind: 'mcp' },
    { id: 'installed-inactive', kind: 'mcp' },
    { id: 'installed-narrow', kind: 'mcp' },
    { id: 'not-installed', kind: 'pack' }
  ];
  const references = [
    'installed-active::search.docs',
    'installed-inactive::anything',
    'installed-narrow::kept.tool',
    'installed-narrow::dropped.tool',
    'not-installed::ghost'
  ];

  const input = { requests, toolReferences: references, installs, attachments };
  const resolution = resolveExtensionRequests(input);
  assert.deepStrictEqual(
    resolution.resolvedTools,
    { search_docs: 'installed-active', kept_tool: 'installed-narrow' },
    'only installed + active + selection-covered tools resolve'
  );
  assert.deepStrictEqual(
    resolution.missingExtensions.map((entry) => [entry.extensionId, entry.reason]),
    [
      ['installed-inactive', 'not-attached'],
      ['not-installed', 'not-installed']
    ],
    'missing extensions keep declared request order with precise reasons'
  );
  assert.deepStrictEqual(
    resolution.missingTools.map((entry) => [entry.callName, entry.reason]),
    [
      ['anything', 'not-attached'],
      ['dropped_tool', 'selection-excluded'],
      ['ghost', 'not-installed']
    ],
    'missing tools keep declared reference order with precise reasons'
  );
  assert.ok(Object.isFrozen(resolution));
  assert.ok(Object.isFrozen(resolution.resolvedTools));
  assert.ok(Object.isFrozen(resolution.missingExtensions));
  assert.ok(Object.isFrozen(resolution.missingTools));

  // The registry service resolves against its own live installs.
  const { registry } = createHarness({ stored: installs });
  const viaService = registry.resolve({ requests, toolReferences: references }, attachments);
  assert.deepStrictEqual(viaService.resolvedTools, resolution.resolvedTools);
  assert.deepStrictEqual(viaService.missingExtensions, resolution.missingExtensions);

  // Deterministic: repeated calls are deep-equal and key order is declared order.
  const again = resolveExtensionRequests(input);
  assert.deepStrictEqual(again, resolution);
  assert.deepStrictEqual(Object.keys(again.resolvedTools), ['search_docs', 'kept_tool']);
  assert.deepStrictEqual(resolveExtensionRequests({ requests: [], toolReferences: [], installs: [], attachments: [] }), {
    resolvedTools: {},
    missingExtensions: [],
    missingTools: []
  });
});

// ============================================================================
// 11. Resolution failure matrix
// ============================================================================

test('11. resolution fails closed on inconsistent input', () => {
  const base = {
    requests: [{ id: 'acme', kind: 'mcp' }],
    toolReferences: ['acme::one'],
    installs: [],
    attachments: []
  };
  const expectResolutionError = (input, pattern) => {
    assert.throws(
      () => resolveExtensionRequests(input),
      (error) => error instanceof ExtensionRegistryError
        && error.code === EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION
        && pattern.test(error.message),
      `expected a typed resolution failure for ${JSON.stringify(input)}`
    );
  };

  expectResolutionError(null, /must be an object/);
  expectResolutionError({ ...base, requests: 'nope' }, /requires requests and toolReferences arrays/);
  expectResolutionError({ ...base, installs: null }, /requires installs and attachments arrays/);
  expectResolutionError({ ...base, requests: [{ id: '', kind: 'mcp' }] }, /id must be a non-empty string/);
  expectResolutionError({ ...base, requests: [{ id: 'a', kind: 'nope' }] }, /kind must be 'mcp' or 'pack'/);
  expectResolutionError({ ...base, requests: [{ id: 'a', kind: 'mcp' }, { id: 'a', kind: 'mcp' }] }, /duplicate extension id 'a'/);
  expectResolutionError({ ...base, toolReferences: ['not-a-reference'] }, /must be a '<providerId>::<serverToolName>' reference/);
  expectResolutionError({ ...base, toolReferences: ['::tool'] }, /must be a '<providerId>::<serverToolName>' reference/);
  expectResolutionError({ ...base, toolReferences: ['acme::   '] }, /must be a '<providerId>::<serverToolName>' reference/);
  expectResolutionError({ ...base, toolReferences: ['other::one'] }, /names undeclared extension 'other'/);
  expectResolutionError({ ...base, toolReferences: [42] }, /references must be strings/);
  expectResolutionError({ ...base, toolReferences: ['acme::read.file'] }, /derives the reserved tool call name 'read_file'/);
  expectResolutionError({ ...base, toolReferences: ['acme::__proto__'] }, /reserved tool call name/);
  expectResolutionError({ ...base, toolReferences: ['acme::a.b', 'acme::a_b'] }, /already claimed by 'acme::a\.b'/);
  expectResolutionError(
    { ...base, installs: [installRecord({ id: 'x' }), installRecord({ id: 'x' })] },
    /duplicate extension id 'x'/
  );
  expectResolutionError(
    { ...base, attachments: [attachment(), attachment()] },
    /duplicate extension id/
  );
  expectResolutionError({ ...base, attachments: [{ geometry: 'bad' }] }, /malformed attachment/);
  expectResolutionError({ ...base, installs: [installRecord({ status: 'bogus' })] }, /status must be/);

  // Exact duplicate references are idempotent, not a collision.
  const deduped = resolveExtensionRequests({ ...base, toolReferences: ['acme::one', 'acme::one'] });
  assert.deepStrictEqual(deduped.missingTools.map((entry) => entry.callName), ['one']);
});

// ============================================================================
// 12-13. Real-store persistence adapter path
// ============================================================================

test('12. installs and attachments round-trip through the real store adapter and snapshot validator', () => {
  sharedLocalStorage.clear();
  let second = null;
  try {
    const first = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
    first.installExtension({
      id: 'acme-scoring',
      kind: 'mcp',
      displayName: 'Acme Scoring',
      transportHint: { kind: 'http', url: 'https://mcp.example.com' },
      credentialId: 'cred_1'
    });
    first.createRealm({ id: 'realm_ext_unit', name: 'Extension Unit Realm' });
    first.attachExtension('realm_ext_unit', 'acme-scoring', { toolSelection: ['search_docs'] });
    first.saveToStorage();
    first.destroy();

    second = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
    assert.deepStrictEqual(second.listExtensions().map((record) => record.id), ['acme-scoring']);
    assert.strictEqual(second.getExtension('acme-scoring').credentialId, 'cred_1');
    assert.deepStrictEqual(
      second.getRealm('realm_ext_unit').extensions.map((entry) => [entry.extensionId, entry.toolSelection]),
      [['acme-scoring', ['search_docs']]]
    );

    // The validated snapshot survives a second serialization cycle unchanged.
    const snapshot = second.serialize();
    const validated = validateSandboxState(JSON.parse(JSON.stringify(snapshot)));
    assert.strictEqual(validated.valid, true);
    assert.deepStrictEqual(validated.state.extensions, snapshot.extensions);
    assert.deepStrictEqual(
      validated.state.realms.find((realm) => realm.id === 'realm_ext_unit').extensions,
      snapshot.realms.find((realm) => realm.id === 'realm_ext_unit').extensions
    );
  } finally {
    if (second) second.destroy();
    sharedLocalStorage.clear();
  }
});

test('13. a tampered snapshot drops the malformed install record and heals the unknown-extension attachment', () => {
  sharedLocalStorage.clear();
  let hydrated = null;
  try {
    const seed = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
    const base = seed.serialize();
    seed.destroy();

    saveSandboxState({
      ...base,
      extensions: [
        installRecord({ id: 'good' }),
        { id: 'bad', kind: 'mcp', transportHint: { kind: 'http' }, status: 'installed', installSource: 'operator', createdAt: 1 },
        'garbage'
      ],
      realms: [
        { id: 'realm_generic', name: 'Generic', createdAt: 1 },
        {
          id: 'realm_tampered',
          name: 'Tampered',
          createdAt: 2,
          extensions: [attachment({ extensionId: 'ghost' }), { extensionId: 'broken' }]
        }
      ]
    });

    const validated = validateSandboxState({
      ...base,
      extensions: [
        installRecord({ id: 'good' }),
        { id: 'bad', kind: 'mcp', transportHint: { kind: 'http' }, status: 'installed', installSource: 'operator', createdAt: 1 },
        'garbage'
      ],
      realms: [
        { id: 'realm_generic', name: 'Generic', createdAt: 1 },
        {
          id: 'realm_tampered',
          name: 'Tampered',
          createdAt: 2,
          extensions: [attachment({ extensionId: 'ghost' }), { extensionId: 'broken' }]
        }
      ]
    });
    assert.strictEqual(validated.valid, true);
    assert.deepStrictEqual(validated.state.extensions.map((record) => record.id), ['good'], 'malformed install records drop individually');
    assert.deepStrictEqual(
      validated.state.realms.find((realm) => realm.id === 'realm_tampered').extensions.map((entry) => entry.extensionId),
      ['ghost'],
      'malformed attachment entries drop while the realm survives'
    );

    hydrated = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: true });
    assert.deepStrictEqual(hydrated.listExtensions().map((record) => record.id), ['good']);
    assert.deepStrictEqual(
      hydrated.getRealm('realm_tampered').extensions.map((entry) => [entry.extensionId, entry.status]),
      [['ghost', 'unavailable']],
      'an attachment whose extension is not installed hydrates as unavailable'
    );
    assert.strictEqual(hydrated.getRealm('realm_tampered').extensions[0].approvedAt.length > 0, true, 'the approval stamp survives the heal');
  } finally {
    if (hydrated) hydrated.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 14. Purity
// ============================================================================

test('14. module sources are pure: own-file plus sanctioned normalizer imports and no ambient I/O', () => {
  const forbidden = [
    { id: 'window', pattern: /\bwindow\b/ },
    { id: 'localStorage', pattern: /\blocalStorage\b/ },
    { id: 'fetch', pattern: /\bfetch\s*\(/ },
    { id: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
    { id: 'navigator', pattern: /\bnavigator\b/ }
  ];
  const sanctionedSpecifiers = new Set(['../tools/normalizers/index.ts']);
  const files = fs.readdirSync(MODULE_DIR).filter((entry) => entry.endsWith('.ts'));

  for (const file of files) {
    const source = fs.readFileSync(path.join(MODULE_DIR, file), 'utf-8');
    for (const { id, pattern } of forbidden) {
      assert.ok(!pattern.test(source), `${file} must not reference ${id}`);
    }
    const specifiers = [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('./') || sanctionedSpecifiers.has(specifier),
        `${file} may import only its own files or a sanctioned normalizer, found '${specifier}'`
      );
    }
    assert.ok(!source.includes('realmRegistry'), `${file} must not import realm semantics`);
    assert.ok(!source.includes('runtime/'), `${file} must not import runtime modules`);
  }

  const indexSource = fs.readFileSync(path.join(MODULE_DIR, 'index.ts'), 'utf-8');
  const body = indexSource.replace(/\/\*[\s\S]*?\*\//g, '');
  const remainder = body
    .replace(/import\s+type\s*\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;/g, '')
    .replace(/export\s+(?:type\s+)?\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;/g, '')
    .trim();
  assert.strictEqual(remainder, '', `index.ts must only re-export, found: ${remainder}`);
});
