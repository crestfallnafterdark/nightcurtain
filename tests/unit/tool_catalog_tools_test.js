/**
 * @file tests/unit/tool_catalog_tools_test.js
 * @description M5a meta-knowledge — canonical tool/preset enumeration
 *   (`list_tools`, `list_tool_presets`, `describe_preset`) acceptance suite
 *   (meta-plane spec §6.1, ticket `abec3a9`).
 *
 * Acceptance coverage:
 *   AC-M5a-01 no authority/meta tools leaked: the canonical reflection tools
 *     enumerate only `ALL_TOOL_DESCRIPTORS`; the publishing / realm-admin /
 *     extension-admin authority registries never appear in receipts or schema
 *     surfaces, and every listed entry projects its frozen descriptor;
 *   AC-M5a-02 preset catalog fidelity: `list_tool_presets` / `describe_preset`
 *     read the generated Wave 1 `TOOL_PRESETS` catalog exactly (ids, counts,
 *     members), never hardcoded literals;
 *   AC-M5a-03 closed schemas + bounded output: Draft-07 closed shapes, exact
 *     receipt keys, a per-entry description cap, and no schema/config/history
 *     leakage;
 *   AC-M5a-04 no realm/extension vocabulary in the three own descriptors or
 *     their receipts;
 *   AC-M5a-05 read-only classification and preset placement: the three tools
 *     are read-only, innate, in the `precall` family, and present in every
 *     named tier;
 *   AC-M5a-06 count check against `SANDBOX_TOOLS` (d872723 F11 drift guard):
 *     canonical counts derive from the frozen enumeration itself.
 *
 * Zero-Mock Verification: real dispatcher over the real frozen catalog; no
 * mocks and no static scraping.
 *
 * Standalone: `timeout 90 node tests/unit/tool_catalog_tools_test.js`
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INNATE_TOOLS,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  SANDBOX_TOOLS,
  TOOL_FAMILIES,
  TOOL_PRESETS,
  isMutatingTool
} from '../../src/lib/sandbox/tools/constants/index.ts';
import {
  ALL_TOOL_DESCRIPTORS,
  AUTHORITY_TOOL_REGISTRY,
  CATALOG_TOOL_DESCRIPTION_MAX_CHARS,
  TOOL_REGISTRY,
  describePresetDescriptor,
  listToolPresetsDescriptor,
  listToolsDescriptor
} from '../../src/lib/sandbox/tools/descriptors/index.ts';
import { getCanonToolName } from '../../src/lib/sandbox/tools/normalizers/index.ts';
import { createSandboxToolDispatcher, getSandboxToolsSchema } from '../../src/lib/sandbox/toolDefinitions/index.ts';

/** The three M5a canonical catalog reflection tool names. */
const CATALOG_TOOLS = Object.freeze([
  SANDBOX_TOOLS.LIST_TOOLS,
  SANDBOX_TOOLS.LIST_TOOL_PRESETS,
  SANDBOX_TOOLS.DESCRIBE_PRESET
]);

/** Canonical declaration order as the frozen enum publishes it. */
const CANONICAL_NAMES = Object.freeze(Object.values(SANDBOX_TOOLS));

/** Every explicit-grant-only authority tool name (never canonical). */
const AUTHORITY_TOOL_NAMES = Object.freeze(Object.keys(AUTHORITY_TOOL_REGISTRY));

/** Authorization-meta vocabulary that must never appear in an ordinary receipt. */
const AUTHORITY_ID_VOCABULARY = Object.freeze([
  '@template:authority',
  '@hydration:authority',
  '@agent:inspect',
  '@agent:edit',
  '@realm:inspect',
  '@realm:edit',
  '@extensions:authority'
]);

/** Realm/extension vocabulary a canonical receipt must never carry. */
const OPAQUE_VOCABULARY = Object.freeze([
  'realm:',
  'realmId',
  'realm_id',
  'tenantId',
  'tenant_id',
  'workspaceId',
  'workspace_id',
  'extensionId',
  'extension_id',
  'extensionTools',
  'extension_tools',
  'list_extensions',
  'attach_extension',
  'inspect_realm',
  'update_realm'
]);

/** Builds a bare real dispatcher (canonical registration only). */
function createDispatcher() {
  return createSandboxToolDispatcher({});
}

/** JSON round-trip view of one receipt. */
function serialized(receipt) {
  return JSON.stringify(receipt);
}

// ============================================================================
// AC-M5a-01 — canonical surface, no authority/meta leak
// ============================================================================

test('1. the three catalog tools are canonical, alias-resolvable, and outside every authority registry', () => {
  assert.equal(SANDBOX_TOOLS.LIST_TOOLS, 'list_tools');
  assert.equal(SANDBOX_TOOLS.LIST_TOOL_PRESETS, 'list_tool_presets');
  assert.equal(SANDBOX_TOOLS.DESCRIBE_PRESET, 'describe_preset');

  for (const name of CATALOG_TOOLS) {
    assert.equal(getCanonToolName(name), name, `'${name}' resolves to its canonical name`);
    assert.equal(TOOL_REGISTRY[name]?.name, name, `'${name}' is registered in TOOL_REGISTRY`);
    assert.equal(AUTHORITY_TOOL_REGISTRY[name], undefined, `'${name}' is never an authority tool`);
    assert.ok(
      ALL_TOOL_DESCRIPTORS.some((descriptor) => descriptor.name === name),
      `'${name}' is part of ALL_TOOL_DESCRIPTORS`
    );
  }
  assert.equal(getCanonToolName('listTools'), 'list_tools', 'the camelCase spelling resolves');
  assert.equal(getCanonToolName('listToolPresets'), 'list_tool_presets', 'the camelCase spelling resolves');
  assert.equal(getCanonToolName('describePreset'), 'describe_preset', 'the camelCase spelling resolves');

  const wildcard = getSandboxToolsSchema('all').map((definition) => definition.function.name);
  for (const name of CATALOG_TOOLS) assert.ok(wildcard.includes(name), `'${name}' is wildcard-exposed`);
});

test('2. [AC-M5a-01] list_tools enumerates only ALL_TOOL_DESCRIPTORS and never an authority tool', async () => {
  const dispatcher = createDispatcher();
  const receipt = await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOLS, {});
  assert.equal(receipt.success, true, serialized(receipt));
  assert.equal(receipt.count, CANONICAL_NAMES.length, 'count is the canonical descriptor count');
  assert.deepEqual(
    receipt.tools.map((entry) => entry.name),
    CANONICAL_NAMES,
    'the listing follows canonical declaration order'
  );
  for (const authorityName of AUTHORITY_TOOL_NAMES) {
    assert.equal(
      receipt.tools.some((entry) => entry.name === authorityName),
      false,
      `authority tool '${authorityName}' never leaks into list_tools`
    );
  }
  // Every listed entry projects its frozen descriptor (one-line description,
  // family, mutation class) with no schema/config/history surface.
  for (const entry of receipt.tools) {
    const descriptor = TOOL_REGISTRY[entry.name];
    assert.ok(descriptor, `'${entry.name}' resolves in TOOL_REGISTRY`);
    assert.deepEqual(Object.keys(entry).sort(), ['description', 'family', 'mutating', 'name']);
    assert.equal(entry.family, TOOL_FAMILIES[entry.name]);
    assert.equal(entry.mutating, isMutatingTool(entry.name));
    const expected = descriptor.description.length <= CATALOG_TOOL_DESCRIPTION_MAX_CHARS
      ? descriptor.description
      : `${descriptor.description.slice(0, CATALOG_TOOL_DESCRIPTION_MAX_CHARS - 1)}\u2026`;
    assert.equal(entry.description, expected, `'${entry.name}' description projects its descriptor`);
  }

  // A dispatcher bound to a merged registry carrying foreign descriptors (a
  // granted extension call name plus an authority meta tool) still lists the
  // canonical enumeration only: the merged per-turn registry can never widen
  // the ordinary listing.
  const mergedDispatcher = createSandboxToolDispatcher({
    toolRegistry: {
      ...TOOL_REGISTRY,
      ext_echo: { name: 'ext_echo', description: 'Extension tool' },
      list_extensions: AUTHORITY_TOOL_REGISTRY.list_extensions
    }
  });
  const mergedReceipt = await mergedDispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOLS, {});
  assert.deepEqual(
    mergedReceipt.tools.map((entry) => entry.name),
    CANONICAL_NAMES,
    'the merged registry leaks no foreign descriptor into list_tools'
  );
  assert.equal(mergedReceipt.count, CANONICAL_NAMES.length);
});

// ============================================================================
// AC-M5a-02 — preset catalog fidelity
// ============================================================================

test('3. [AC-M5a-02] list_tool_presets and describe_preset read the generated catalog exactly', async () => {
  const dispatcher = createDispatcher();

  const list = await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOL_PRESETS, {});
  assert.equal(list.success, true, serialized(list));
  assert.deepEqual(
    list.presets,
    Object.entries(TOOL_PRESETS).map(([id, members]) => ({ id, count: members.length })),
    'preset ids and counts match the generated catalog'
  );
  assert.equal(list.count, Object.keys(TOOL_PRESETS).length);

  for (const [id, members] of Object.entries(TOOL_PRESETS)) {
    const described = await dispatcher.executeTool(SANDBOX_TOOLS.DESCRIBE_PRESET, { preset: id });
    assert.equal(described.success, true, serialized(described));
    assert.equal(described.preset, id);
    assert.equal(described.count, members.length);
    assert.deepEqual(described.members, [...members], `'${id}' members match the generated catalog`);
  }

  const upper = await dispatcher.executeTool(SANDBOX_TOOLS.DESCRIBE_PRESET, { preset: '  MANAGER  ' });
  assert.equal(upper.success, true, 'preset ids resolve case-insensitively with padding');
  assert.equal(upper.preset, 'manager');
  assert.deepEqual(upper.members, [...TOOL_PRESETS.manager]);

  const unknown = await dispatcher.executeTool(SANDBOX_TOOLS.DESCRIBE_PRESET, { preset: 'not_a_preset' });
  assert.equal(unknown.success, false);
  assert.equal(unknown.code, 'INVALID_ARGUMENTS');
  assert.equal(serialized(unknown).includes('not_a_preset'), false, 'an unknown preset id is never echoed');

  const missing = await dispatcher.executeTool(SANDBOX_TOOLS.DESCRIBE_PRESET, {});
  assert.equal(missing.success, false);
  assert.equal(missing.code, 'INVALID_ARGUMENTS');
});

// ============================================================================
// AC-M5a-03 — closed schemas + bounded output
// ============================================================================

test('4. [AC-M5a-03] closed schemas, exact receipt keys, and bounded listing output', async () => {
  assert.ok(Object.isFrozen(listToolsDescriptor));
  assert.ok(Object.isFrozen(listToolPresetsDescriptor));
  assert.ok(Object.isFrozen(describePresetDescriptor));
  for (const descriptor of [listToolsDescriptor, listToolPresetsDescriptor, describePresetDescriptor]) {
    assert.equal(descriptor.schema.type, 'object');
    assert.equal(descriptor.schema.additionalProperties, false, `${descriptor.name} schema is closed`);
    assert.equal(typeof descriptor.schema.properties, 'object');
    assert.ok(Object.isFrozen(descriptor.schema));
  }
  assert.deepEqual(Object.keys(listToolsDescriptor.schema.properties), [], 'list_tools declares no parameters');
  assert.deepEqual(Object.keys(listToolPresetsDescriptor.schema.properties), [], 'list_tool_presets declares no parameters');
  assert.deepEqual(Object.keys(describePresetDescriptor.schema.properties), ['preset']);
  assert.deepEqual(describePresetDescriptor.schema.required, ['preset']);

  const dispatcher = createDispatcher();
  const list = await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOLS, {});
  assert.deepEqual(Object.keys(list).sort(), ['count', 'success', 'tools']);
  assert.ok(list.tools.length > 0);
  for (const entry of list.tools) {
    assert.ok(
      typeof entry.description === 'string' && entry.description.length <= CATALOG_TOOL_DESCRIPTION_MAX_CHARS,
      `'${entry.name}' description is bounded to ${CATALOG_TOOL_DESCRIPTION_MAX_CHARS} characters`
    );
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.family, 'string');
    assert.equal(typeof entry.mutating, 'boolean');
  }
  assert.ok(
    serialized(list).length < 12 * 1024,
    'the full canonical listing is serialization-bounded'
  );

  const presets = await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOL_PRESETS, {});
  assert.deepEqual(Object.keys(presets).sort(), ['count', 'presets', 'success']);
  for (const entry of presets.presets) assert.deepEqual(Object.keys(entry).sort(), ['count', 'id']);

  const described = await dispatcher.executeTool(SANDBOX_TOOLS.DESCRIBE_PRESET, { preset: 'readonly' });
  assert.deepEqual(Object.keys(described).sort(), ['count', 'members', 'preset', 'success']);
  assert.ok(Object.isFrozen(TOOL_PRESETS.readonly));

  // Zero-parameter tools refuse any supplied parameter; describe_preset refuses
  // unknown keys. All refusals are static (no key echo) whole-call failures.
  const strayToolParam = await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOLS, { family: 'vfs.read' });
  assert.equal(strayToolParam.success, false);
  assert.equal(strayToolParam.code, 'INVALID_ARGUMENTS');
  assert.equal(serialized(strayToolParam).includes('family'), false);

  const strayPresetParam = await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOL_PRESETS, { filter: 'x' });
  assert.equal(strayPresetParam.success, false);
  assert.equal(strayPresetParam.code, 'INVALID_ARGUMENTS');
  assert.equal(serialized(strayPresetParam).includes('filter'), false);

  const strayDescribeParam = await dispatcher.executeTool(SANDBOX_TOOLS.DESCRIBE_PRESET, { preset: 'all', extra: true });
  assert.equal(strayDescribeParam.success, false);
  assert.equal(strayDescribeParam.code, 'INVALID_ARGUMENTS');
  assert.equal(serialized(strayDescribeParam).includes('extra'), false);
});

// ============================================================================
// AC-M5a-04 — realm/extension opacity
// ============================================================================

test('5. [AC-M5a-04] the catalog tools carry no realm/extension/authority vocabulary', async () => {
  const dispatcher = createDispatcher();
  const receipts = [
    await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOLS, {}),
    await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOL_PRESETS, {}),
    await dispatcher.executeTool(SANDBOX_TOOLS.DESCRIBE_PRESET, { preset: 'manager' })
  ];
  const blob = serialized(receipts);
  for (const term of OPAQUE_VOCABULARY) {
    assert.equal(blob.includes(term), false, `receipts never carry '${term}'`);
  }
  for (const term of AUTHORITY_ID_VOCABULARY) {
    assert.equal(blob.includes(term), false, `receipts never carry '${term}'`);
  }
  for (const descriptor of [listToolsDescriptor, listToolPresetsDescriptor, describePresetDescriptor]) {
    assert.equal(/realm/iu.test(descriptor.description), false, `${descriptor.name} description is realm-free`);
    assert.equal(/extension/iu.test(descriptor.description), false, `${descriptor.name} description is extension-free`);
    assert.equal(descriptor.description.includes('@'), false, `${descriptor.name} description carries no authority id`);
  }
});

// ============================================================================
// AC-M5a-05 — classification and preset placement
// ============================================================================

test('6. [AC-M5a-05] the catalog tools are read-only, innate, and family-placed with describe_tool', () => {
  for (const name of CATALOG_TOOLS) {
    assert.ok(INNATE_TOOLS.includes(name), `'${name}' is an innate primitive`);
    assert.equal(INNATE_TOOLS.has(name), true);
    assert.ok(READ_ONLY_TOOLS.includes(name), `'${name}' is read-only`);
    assert.equal(MUTATING_TOOLS.includes(name), false, `'${name}' is never mutating`);
    assert.equal(isMutatingTool(name), false);
    assert.equal(TOOL_FAMILIES[name], 'precall', `'${name}' joins the precall reflection family`);
    for (const tier of ['readonly', 'readonly_collaborator', 'collaborator', 'manager']) {
      assert.ok(TOOL_PRESETS[tier].includes(name), `'${tier}' carries '${name}'`);
      const schemaNames = getSandboxToolsSchema(tier).map((definition) => definition.function.name);
      assert.ok(schemaNames.includes(name), `'${tier}' exposes '${name}'`);
    }
  }
  assert.deepEqual(TOOL_PRESETS.all, ['*']);
});

// ============================================================================
// AC-M5a-06 — canonical count drift guard
// ============================================================================

test('7. [AC-M5a-06] canonical counts derive from SANDBOX_TOOLS and descriptors, never a docblock', async () => {
  const canonical = Object.values(SANDBOX_TOOLS);
  assert.equal(canonical.length, 41, 'the canonical taxonomy carries 41 tools');
  assert.equal(new Set(canonical).size, canonical.length, 'the canonical names are unique');
  assert.equal(ALL_TOOL_DESCRIPTORS.length, canonical.length, 'descriptor catalog covers the canonical set');
  assert.equal(Object.keys(TOOL_REGISTRY).length, canonical.length, 'the registry covers the canonical set');
  assert.deepEqual(Object.keys(TOOL_FAMILIES).sort(), [...canonical].sort(), 'every canonical tool declares a family');
  assert.equal(new Set([...MUTATING_TOOLS, ...READ_ONLY_TOOLS]).size, canonical.length, 'the mutation partition covers the canonical set');
  assert.equal(MUTATING_TOOLS.length + READ_ONLY_TOOLS.length, canonical.length, 'the mutation partition is disjoint');
  assert.equal(getSandboxToolsSchema('all').length, canonical.length, 'the wildcard surface covers the canonical set');

  const dispatcher = createDispatcher();
  const receipt = await dispatcher.executeTool(SANDBOX_TOOLS.LIST_TOOLS, {});
  assert.equal(receipt.count, canonical.length, 'the listing count derives from the canonical enumeration');
  assert.equal(receipt.count, ALL_TOOL_DESCRIPTORS.length, 'descriptor/listing counts never drift');
});
