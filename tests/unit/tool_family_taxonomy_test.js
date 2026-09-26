/**
 * @file tests/unit/tool_family_taxonomy_test.js
 * @description Family-taxonomy migration tests (ticket 5efc129): every baked tool
 * declares exactly one primary family, the five capability presets are generated
 * from the frozen family plan, and the generated tiers reproduce the frozen
 * pre-rebuild effective sets (selector window included) with only the ratified
 * delta ledger shipping.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INNATE_TOOLS,
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  RETIRED_TOOL_SELECTORS,
  SANDBOX_TOOLS,
  TOOL_FAMILIES,
  FAMILY_TIER_PLAN,
  TOOL_TIER_EXPOSURE,
  TOOL_PRESETS,
  expandRetiredToolSelector,
  isMutatingTool,
  resolveToolPreset
} from '../../src/lib/sandbox/tools/constants/index.ts';
import { getCanonToolName } from '../../src/lib/sandbox/tools/normalizers/index.ts';
import {
  createSandboxToolDispatcher,
  getSandboxToolsSchema
} from '../../src/lib/sandbox/toolDefinitions/index.ts';
import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';

const CANONICAL_NAMES = Object.freeze(Object.values(SANDBOX_TOOLS));
const NAMED_TIERS = Object.freeze(['readonly', 'readonly_collaborator', 'collaborator', 'manager']);
const FAMILY_VOCABULARY = Object.freeze([
  'vfs.read', 'vfs.write', 'messaging.send', 'mailbox.read', 'mailbox.consume',
  'lifecycle', 'invocation', 'scheduler', 'clock', 'world', 'precall'
]);
const LEGACY_MANAGEMENT_EXPANSION = Object.freeze(['spawn_agent', 'kill_agent', 'invoke_agent', 'undo_turn']);
const PERMANENT_ORPHANS = Object.freeze(['concat_files', 'drain_inbox', 'world_clock', 'event_list']);

/**
 * Pre-rebuild hand literals (`TOOL_PRESETS` as shipped before the rebuild),
 * frozen so the migration is asserted against a snapshot, never re-derived.
 */
const LEGACY_HAND_RAW = Object.freeze({
  all: Object.freeze(['*']),
  manager: Object.freeze([
    'read_file', 'write_file', 'copy_file', 'set_permissions', 'replace_file_content',
    'write_json', 'query_json', 'list_files', 'delete_file', 'json_patch', 'grep',
    'send_message', 'inline_file_in_message', 'get_inbox', 'list_inbox', 'read_message',
    'get_archive', 'wait_for_mail', 'whoami', 'get_current_time', 'schedule',
    'list_schedules', 'cancel_schedule', 'subagent_management', 'batch_precall'
  ]),
  collaborator: Object.freeze([
    'read_file', 'write_file', 'copy_file', 'set_permissions', 'replace_file_content',
    'write_json', 'query_json', 'list_files', 'delete_file', 'json_patch', 'grep',
    'send_message', 'inline_file_in_message', 'get_inbox', 'list_inbox', 'read_message',
    'get_archive', 'wait_for_mail', 'whoami', 'get_current_time', 'schedule',
    'list_schedules', 'cancel_schedule', 'batch_precall'
  ]),
  readonly_collaborator: Object.freeze([
    'read_file', 'query_json', 'list_files', 'grep', 'get_inbox', 'list_inbox',
    'read_message', 'get_archive', 'wait_for_mail', 'send_message', 'whoami',
    'get_current_time', 'batch_precall'
  ]),
  readonly: Object.freeze([
    'read_file', 'query_json', 'list_files', 'grep', 'get_inbox', 'list_inbox',
    'read_message', 'get_archive', 'wait_for_mail', 'whoami', 'get_current_time',
    'batch_precall'
  ])
});

/**
 * Sorted, selector-expanded effective sets of the pre-rebuild hand lists
 * (measured baseline: manager 28, collaborator 24, readonly_collaborator 13,
 * readonly 12, all `['*']`).
 */
const LEGACY_EFFECTIVE_SORTED = Object.freeze({
  all: Object.freeze(['*']),
  manager: Object.freeze([
    'batch_precall', 'cancel_schedule', 'copy_file', 'delete_file', 'get_archive',
    'get_current_time', 'get_inbox', 'grep', 'inline_file_in_message', 'invoke_agent',
    'json_patch', 'kill_agent', 'list_files', 'list_inbox', 'list_schedules', 'query_json',
    'read_file', 'read_message', 'replace_file_content', 'schedule', 'send_message',
    'set_permissions', 'spawn_agent', 'undo_turn', 'wait_for_mail', 'whoami', 'write_file',
    'write_json'
  ]),
  collaborator: Object.freeze([
    'batch_precall', 'cancel_schedule', 'copy_file', 'delete_file', 'get_archive',
    'get_current_time', 'get_inbox', 'grep', 'inline_file_in_message', 'json_patch',
    'list_files', 'list_inbox', 'list_schedules', 'query_json', 'read_file', 'read_message',
    'replace_file_content', 'schedule', 'send_message', 'set_permissions', 'wait_for_mail',
    'whoami', 'write_file', 'write_json'
  ]),
  readonly_collaborator: Object.freeze([
    'batch_precall', 'get_archive', 'get_current_time', 'get_inbox', 'grep', 'list_files',
    'list_inbox', 'query_json', 'read_file', 'read_message', 'send_message', 'wait_for_mail',
    'whoami'
  ]),
  readonly: Object.freeze([
    'batch_precall', 'get_archive', 'get_current_time', 'get_inbox', 'grep', 'list_files',
    'list_inbox', 'query_json', 'read_file', 'read_message', 'wait_for_mail', 'whoami'
  ])
});

/**
 * Canonical-order generated tier literals for the final Wave-1 state plus the
 * M2/M5a deltas: the pre-C parity literals plus the ratified deltas (every
 * innate tool — including `describe_tool` and the M5a catalog reflection tools
 * — is schema-visible per tier; manager gains `list_agents`/
 * `wait_for_invocation` in Wave 2, `wait_for_agent` in W2, and
 * `inspect_agent`/`update_agent` in M2).
 */
const GENERATED_TIER_LITERALS = Object.freeze({
  all: Object.freeze(['*']),
  readonly: Object.freeze([
    'read_file', 'list_files', 'query_json', 'grep', 'wait_for_mail', 'list_inbox',
    'read_message', 'get_archive', 'get_inbox', 'whoami', 'get_current_time', 'batch_precall',
    'describe_tool', 'list_tools', 'list_tool_presets', 'describe_preset'
  ]),
  readonly_collaborator: Object.freeze([
    'read_file', 'list_files', 'query_json', 'grep', 'send_message', 'wait_for_mail',
    'list_inbox', 'read_message', 'get_archive', 'get_inbox', 'whoami', 'get_current_time',
    'batch_precall', 'describe_tool', 'list_tools', 'list_tool_presets', 'describe_preset'
  ]),
  collaborator: Object.freeze([
    'read_file', 'write_file', 'replace_file_content', 'copy_file', 'delete_file', 'list_files',
    'write_json', 'query_json', 'json_patch', 'grep', 'set_permissions', 'send_message',
    'wait_for_mail', 'list_inbox', 'read_message', 'get_archive', 'inline_file_in_message',
    'get_inbox', 'whoami', 'schedule', 'list_schedules', 'cancel_schedule', 'get_current_time',
    'batch_precall', 'describe_tool', 'list_tools', 'list_tool_presets', 'describe_preset'
  ]),
  manager: Object.freeze([
    'read_file', 'write_file', 'replace_file_content', 'copy_file', 'delete_file', 'list_files',
    'write_json', 'query_json', 'json_patch', 'grep', 'set_permissions', 'send_message',
    'wait_for_mail', 'list_inbox', 'read_message', 'get_archive', 'inline_file_in_message',
    'get_inbox', 'spawn_agent', 'kill_agent', 'list_agents', 'whoami', 'undo_turn',
    'inspect_agent', 'update_agent',
    'invoke_agent', 'wait_for_invocation', 'wait_for_agent', 'schedule', 'list_schedules',
    'cancel_schedule', 'get_current_time', 'batch_precall', 'describe_tool', 'list_tools',
    'list_tool_presets', 'describe_preset'
  ])
});

/** Ratified deltas applied on top of the parity fixtures (Wave 2 + M2 + M5a). */
const RATIFIED_DELTAS = Object.freeze({
  innate: Object.freeze(['describe_tool', 'list_tools', 'list_tool_presets', 'describe_preset']),
  manager: Object.freeze(['list_agents', 'wait_for_invocation', 'wait_for_agent']),
  m2Manager: Object.freeze(['inspect_agent', 'update_agent'])
});

/**
 * Canonical, selector-expanded, duplicate-free, sorted effective set.
 * Encodes the only allowed representation change (sentinel → concrete names)
 * so pre-rebuild fixtures compare against post-rebuild output.
 *
 * @param {string | readonly string[] | ReadonlySet<string> | null} [input]
 * @returns {string[]} the normalized effective set
 */
function normalizeEffectiveSet(input) {
  const resolved = resolveToolPreset(input);
  if (resolved.includes('*')) return ['*'];
  const out = new Set();
  for (const entry of resolved) {
    const canonical = getCanonToolName(entry) ?? entry;
    const expansion = expandRetiredToolSelector(canonical);
    if (expansion) {
      for (const tool of expansion) out.add(tool);
      continue;
    }
    out.add(canonical);
  }
  return [...out].sort();
}

/**
 * The frozen parity baseline plus the ratified delta ledger — the only
 * allowed membership/visibility change over the pre-rebuild effective sets.
 *
 * @param {string} tier - Named capability tier
 * @returns {string[]} the sorted expected effective set
 */
function expectedEffectiveSet(tier) {
  const expected = new Set(LEGACY_EFFECTIVE_SORTED[tier]);
  for (const tool of RATIFIED_DELTAS.innate) expected.add(tool);
  if (tier === 'manager') {
    for (const tool of RATIFIED_DELTAS.manager) expected.add(tool);
    for (const tool of RATIFIED_DELTAS.m2Manager) expected.add(tool);
  }
  return [...expected].sort();
}

/** The generated catalog under test (the exported generated `TOOL_PRESETS`). */
const generatedCatalog = TOOL_PRESETS;

test('T1 every baked tool declares exactly one primary family', () => {
  assert.ok(Object.isFrozen(TOOL_FAMILIES), 'TOOL_FAMILIES must be frozen');
  assert.strictEqual(Object.keys(TOOL_FAMILIES).length, CANONICAL_NAMES.length);
  assert.deepStrictEqual(Object.keys(TOOL_FAMILIES).sort(), [...CANONICAL_NAMES].sort());
  for (const tool of CANONICAL_NAMES) {
    const family = TOOL_FAMILIES[tool];
    assert.ok(FAMILY_VOCABULARY.includes(family), `'${tool}' declares unknown family '${family}'`);
    assert.ok(Object.prototype.hasOwnProperty.call(FAMILY_TIER_PLAN, family));
  }
  assert.deepStrictEqual(Object.keys(FAMILY_TIER_PLAN).sort(), [...FAMILY_VOCABULARY].sort());
  assert.strictEqual(new Set(Object.values(TOOL_FAMILIES)).size, FAMILY_VOCABULARY.length);
});

test('T2 family table agrees with the MUTATING_TOOLS partition', () => {
  for (const tool of CANONICAL_NAMES) {
    const mutating = MUTATING_TOOLS.includes(tool);
    assert.strictEqual(isMutatingTool(tool), mutating, `'${tool}' mutation partition`);
    const family = TOOL_FAMILIES[tool];
    if (family === 'vfs.read' || family === 'mailbox.read') {
      assert.strictEqual(mutating, false, `family '${family}' must be read-only ('${tool}')`);
    }
    if (family === 'vfs.write' || family === 'messaging.send' || family === 'mailbox.consume' || family === 'world') {
      assert.strictEqual(mutating, true, `family '${family}' must be mutating ('${tool}')`);
    }
  }
  assert.deepStrictEqual([...MUTATING_TOOLS, ...READ_ONLY_TOOLS].sort(), [...CANONICAL_NAMES].sort());
  assert.strictEqual(new Set([...MUTATING_TOOLS, ...READ_ONLY_TOOLS]).size, CANONICAL_NAMES.length);
});

test('T3 tier derivation rule reproduces the canonical order', () => {
  for (const tier of NAMED_TIERS) {
    const generated = [...generatedCatalog[tier]];
    assert.ok(Object.isFrozen(generatedCatalog[tier]), `'${tier}' must be frozen`);
    assert.strictEqual(new Set(generated).size, generated.length, `'${tier}' must be duplicate-free`);
    assert.deepStrictEqual(
      generated,
      CANONICAL_NAMES.filter((tool) => generated.includes(tool)),
      `'${tier}' must follow canonical declaration order`
    );
    assert.deepStrictEqual(generated, GENERATED_TIER_LITERALS[tier], `'${tier}' canonical-order literal`);
  }
  const ro = new Set(generatedCatalog.readonly);
  const roc = new Set(generatedCatalog.readonly_collaborator);
  const col = new Set(generatedCatalog.collaborator);
  const mgr = new Set(generatedCatalog.manager);
  for (const tool of ro) assert.ok(roc.has(tool), `readonly ⊆ readonly_collaborator ('${tool}')`);
  for (const tool of roc) assert.ok(col.has(tool), `readonly_collaborator ⊆ collaborator ('${tool}')`);
  for (const tool of col) assert.ok(mgr.has(tool), `collaborator ⊆ manager ('${tool}')`);
  assert.deepStrictEqual(generatedCatalog.all, ['*']);
});

test('T4 hand lists normalize to the frozen pre-rebuild effective sets', () => {
  for (const tier of ['all', ...NAMED_TIERS]) {
    assert.deepStrictEqual(
      normalizeEffectiveSet(LEGACY_HAND_RAW[tier]),
      LEGACY_EFFECTIVE_SORTED[tier],
      `legacy '${tier}' effective set`
    );
  }
});

test('T5 generated tiers equal the frozen effective sets plus the ratified deltas', () => {
  for (const tier of NAMED_TIERS) {
    assert.deepStrictEqual(
      normalizeEffectiveSet(GENERATED_TIER_LITERALS[tier]),
      expectedEffectiveSet(tier),
      `generated '${tier}' must normalize to the frozen pre-rebuild effective set plus the ratified deltas`
    );
    assert.deepStrictEqual(
      normalizeEffectiveSet(generatedCatalog[tier]),
      expectedEffectiveSet(tier),
      `catalog '${tier}' must normalize to the frozen pre-rebuild effective set plus the ratified deltas`
    );
    // No named-tier membership beyond the ledger: the ratified widening is
    // manager-only, and the innate visibility delta applies to every tier.
    for (const tool of generatedCatalog[tier]) {
      assert.ok(
        LEGACY_EFFECTIVE_SORTED[tier].includes(tool)
        || RATIFIED_DELTAS.innate.includes(tool)
        || (tier === 'manager' && (RATIFIED_DELTAS.manager.includes(tool) || RATIFIED_DELTAS.m2Manager.includes(tool))),
        `'${tier}' must not gain unratified member '${tool}'`
      );
    }
  }
  assert.deepStrictEqual(normalizeEffectiveSet(generatedCatalog.all), ['*']);
});

test('T6 per-tier schema names match the frozen literals', () => {
  for (const tier of NAMED_TIERS) {
    const names = getSandboxToolsSchema(tier).map((def) => def.function.name);
    assert.deepStrictEqual(names, GENERATED_TIER_LITERALS[tier], `'${tier}' schema names`);
    const noReflection = getSandboxToolsSchema(tier, { includeReflection: false }).map((def) => def.function.name);
    assert.deepStrictEqual(
      noReflection,
      GENERATED_TIER_LITERALS[tier].filter((name) => name !== 'describe_tool'),
      `'${tier}' includeReflection:false drops describe_tool only`
    );
  }
  const allNames = getSandboxToolsSchema('all').map((def) => def.function.name);
  assert.deepStrictEqual(allNames, CANONICAL_NAMES);
  assert.strictEqual(allNames.length, 41);
  const allNoReflection = getSandboxToolsSchema('all', { includeReflection: false }).map((def) => def.function.name);
  assert.deepStrictEqual(allNoReflection, CANONICAL_NAMES.filter((name) => name !== 'describe_tool'));
});

test('T7 authorization matrix matches the frozen per-tier literals', async () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  await runtime.ensureDirector();
  const directorAuthority = runtime.createAgentIdentityPort().getAgentIdentity('director').authority;
  try {
    for (const tier of ['all', ...NAMED_TIERS]) {
      const agentId = `taxonomy_${tier}`;
      // The director principal carries lifecycle authority, so the `'all'`
      // tier's wildcard survives launch-time capability sanitization; every
      // other tier is launchable unprivileged but uses the same trusted path.
      await runtime.launchAgent({
        config: { id: agentId, allowedTools: [tier] },
        principal: directorAuthority
      });
      const dispatcher = createSandboxToolDispatcher({ runtime, agentId });
      const tierTools = tier === 'all' ? null : new Set(GENERATED_TIER_LITERALS[tier]);
      for (const tool of CANONICAL_NAMES) {
        const receipt = await dispatcher.executeTool(tool, {});
        const authorized = receipt.code !== 'PERMISSION_DENIED';
        const expected = tierTools === null || tierTools.has(tool) || INNATE_TOOLS.has(tool);
        assert.strictEqual(
          authorized,
          expected,
          `tier '${tier}': '${tool}' authorization must be ${expected} (got receipt code ${receipt.code ?? 'success'})`
        );
      }
    }
  } finally {
    runtime.destroy();
  }
});

test('T8 retired selector window is canonical-keyed and stays reserved', () => {
  assert.ok(Object.isFrozen(RETIRED_TOOL_SELECTORS), 'RETIRED_TOOL_SELECTORS must be frozen');
  const expansion = expandRetiredToolSelector('subagent_management');
  assert.deepStrictEqual([...expansion], [...LEGACY_MANAGEMENT_EXPANSION]);
  assert.ok(Object.isFrozen(expansion), 'the expansion array must be frozen');
  assert.strictEqual(expandRetiredToolSelector('manage_subagents'), null, 'spellings are not window keys');
  assert.strictEqual(expandRetiredToolSelector('unknown_tool'), null, 'unknown names fail closed');
  assert.strictEqual(expandRetiredToolSelector('__proto__'), null, 'prototype keys fail closed');
  for (const spelling of ['manage_subagents', 'subagents', 'subagent_tools']) {
    assert.strictEqual(getCanonToolName(spelling), 'subagent_management', `'${spelling}' stays reserved`);
  }
  // Resolution expands the canonical selector (string, CSV, array, and Set paths).
  assert.deepStrictEqual(resolveToolPreset('subagent_management'), [...LEGACY_MANAGEMENT_EXPANSION]);
  assert.deepStrictEqual(resolveToolPreset(['subagent_management']), [...LEGACY_MANAGEMENT_EXPANSION]);
  assert.deepStrictEqual(resolveToolPreset(new Set(['subagent_management'])), [...LEGACY_MANAGEMENT_EXPANSION]);
  assert.deepStrictEqual(
    resolveToolPreset('read_file, subagent_management'),
    ['read_file', ...LEGACY_MANAGEMENT_EXPANSION]
  );
  // Unknown names and spellings keep the pass-through/fail-closed semantics.
  assert.deepStrictEqual(resolveToolPreset('unknown_tool'), ['unknown_tool']);
  assert.deepStrictEqual(resolveToolPreset('manage_subagents'), ['manage_subagents']);
});

test('T9 orphans stay wildcard/custom-only', () => {
  for (const tool of PERMANENT_ORPHANS) {
    assert.strictEqual(TOOL_TIER_EXPOSURE[tool], 'never', `'${tool}' must hold an explicit never-exposure decision`);
  }
  for (const tier of NAMED_TIERS) {
    const schemaNames = new Set(getSandboxToolsSchema(tier).map((def) => def.function.name));
    for (const tool of CANONICAL_NAMES) {
      if (TOOL_TIER_EXPOSURE[tool] !== 'never') continue;
      assert.ok(!generatedCatalog[tier].includes(tool), `'${tool}' must not join '${tier}'`);
      assert.ok(!schemaNames.has(tool), `'${tool}' must not be exposed in '${tier}' schemas`);
    }
  }
});

test('T10 no tier references an unknown name and preset keys stay byte-identical', () => {
  assert.deepStrictEqual(
    Object.keys(TOOL_PRESETS),
    ['all', 'manager', 'collaborator', 'readonly_collaborator', 'readonly']
  );
  const known = new Set([...CANONICAL_NAMES, ...Object.keys(RETIRED_TOOL_SELECTORS)]);
  for (const tier of NAMED_TIERS) {
    for (const entry of TOOL_PRESETS[tier]) {
      assert.ok(known.has(entry), `'${tier}' references unknown name '${entry}'`);
    }
  }
  assert.deepStrictEqual(TOOL_PRESETS.all, ['*']);
});

test('T11 wait_for_agent is baked in the invocation family and manager-only', () => {
  assert.deepStrictEqual([...FAMILY_TIER_PLAN.invocation], ['manager'], 'invocation is a manager-only family');
  assert.equal(TOOL_FAMILIES.wait_for_agent, 'invocation', 'wait_for_agent belongs to the invocation family');
  assert.equal(TOOL_TIER_EXPOSURE.wait_for_agent, undefined, 'the family default places it in manager');
  for (const tier of NAMED_TIERS) {
    for (const tool of CANONICAL_NAMES) {
      if (TOOL_FAMILIES[tool] !== 'invocation') continue;
      if (TOOL_TIER_EXPOSURE[tool] === 'never') continue;
      assert.strictEqual(
        GENERATED_TIER_LITERALS[tier].includes(tool),
        tier === 'manager',
        `invocation tool '${tool}' must only appear in manager`
      );
    }
  }
  const manager = GENERATED_TIER_LITERALS.manager;
  assert.ok(manager.includes('wait_for_agent'), 'the manager literal carries the agent-addressed wait');
  assert.ok(
    manager.indexOf('wait_for_agent') === manager.indexOf('wait_for_invocation') + 1,
    'wait_for_agent appends directly after its id-addressed sibling'
  );
  assert.equal(READ_ONLY_TOOLS.includes('wait_for_agent'), true, 'wait_for_agent is read-only');
});
