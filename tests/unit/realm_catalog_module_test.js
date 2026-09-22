/**
 * @file tests/unit/realm_catalog_module_test.js
 * @description Isolated unit suite for the `realmCatalog` module: the Wave C
 * template schema (ticket 7bf251b) plus the Wave T format-v1 surface (ticket
 * c19fb5d — origins, briefs, baked history, hydration packages, bundle
 * transport/versioning, provider-requirement gate).
 *
 * Contract coverage:
 *  1. Runtime export surface (baked template + baked bundles + the pure
 *     helpers; type exports are compile-time).
 *  2. Baked demo fixture shape, text prompt parts, formatVersion, deep freeze.
 *  3. Deterministic materialization: composed prompts, provenance, literal
 *     realm-opaque ids, template order, deep equality, deep freeze.
 *  4. Literal-id/override resolution, ordinary-id acceptance (the director id
 *     included — Wave I, ticket c02d0b9), and retired `{realm}` placeholder
 *     rejection.
 *  5. Optional spec-field pass-through and closed-shape plans.
 *  6. Fail-closed validation of options, templates, specs, prompt parts,
 *     inputs, seed manifests, and tool profiles.
 *  7. Capability summaries: presets, aggregate expansion, wildcard, aliases,
 *     declared requirement ids, strict grant validation, privilege escalation,
 *     frozen deterministic output.
 *  8. Composition: declared order, verbatim pieces, empty-input omission,
 *     required rejection, default/defaultFile resolution, bundle files,
 *     provenance, caps, frozen deterministic output.
 *  9. Seed resolution: inline verbatim, bundle files, missing-entry failure,
 *     directive-without-target-file rejection, frozen deterministic output.
 * 10. Purity: explicit import surface only, no ambient I/O, re-export-only index.
 * 11. Baked bundles: demo fixture first, frozen generated bundles appended in
 *     sorted id order, accessor semantics, and a stable sha256 content version.
 * 12. Format v1 schema: input origins/briefs, seed-slot origin/source rules,
 *     history schema, hydration declaration, toolContract/providers shapes.
 * 13. Baked history: composition, empty-entry rejection, plan carriage, input
 *     precedence, missing-file failure, frozen deterministic output.
 * 14. Per-bundle versioning: canonical byte stream (independently reproduced
 *     with node:crypto), baked vs JSON-imported identity, UTF-8 framing.
 * 15. Transport: parse/serialize round-trips, closed envelope, typed errors,
 *     deep-frozen parsed bundles.
 * 16. Hydration packages: slot matching, generated coverage, fixed/unknown/
 *     duplicate rejection, input ids, version-mismatch policy.
 * 17. Origin-aware materialization: fixed/user/generated seed slots and the
 *     provider-requirement launch gate helper.
 * 18. Text hashing: `hashText` known vectors, unicode bytes, input rejection.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as RealmCatalogModule from '../../src/lib/sandbox/realmCatalog/index.ts';
import {
  AGENT_AUTHORITIES,
  BAKED_TEMPLATE_BUNDLES,
  DEMO_TEMPLATE,
  KNOWN_AGENT_AUTHORITIES,
  REALM_CATALOG_ERROR_CODES,
  REALM_CONTENT_VERSION,
  RealmCatalogError,
  composeAgentHistory,
  composeSystemPrompt,
  getBakedTemplateBundle,
  hashText,
  materializeTemplate,
  parseTemplateBundle,
  resolveSeedManifest,
  serializeTemplateBundle,
  summarizeAgentCapabilities,
  templateBundleVersion,
  templateRequiresProviders,
  templateUnsupportedAuthorities,
  validateHydrationPackage
} from '../../src/lib/sandbox/realmCatalog/index.ts';
import {
  MUTATING_TOOLS,
  READ_ONLY_TOOLS,
  TOOL_PRESETS
} from '../../src/lib/sandbox/tools/constants/index.ts';

/** Module folder under test (source-level purity checks). */
const MODULE_DIR = path.resolve(import.meta.dirname, '../../src/lib/sandbox/realmCatalog');

/** Every hand-written source file owned by the module (implementation + surface). */
const MODULE_FILES = [
  'index.ts',
  'types.ts',
  'freeze.ts',
  'errors.ts',
  'sha256.ts',
  'validation.ts',
  'version.ts',
  'transport.ts',
  'hydration.ts',
  'compose.ts',
  'materialize.ts',
  'capabilities.ts',
  'demo.ts',
  'bundles.ts'
];

/** Composition cap mirrored from the module (parts per agent prompt). */
const MAX_PROMPT_PARTS = 64;

/** Composition cap mirrored from the module (characters per composed prompt). */
const MAX_COMPOSED_PROMPT_CHARS = 200 * 1024;

/**
 * Builds a valid agent spec fixture with a single inline text part.
 *
 * @param {object} [overrides] Spec field overrides
 * @returns {object} Agent spec literal
 */
function agentSpec(overrides = {}) {
  return {
    key: 'agent',
    idPattern: 'agent',
    name: 'Agent',
    role: 'worker',
    prompt: [{ kind: 'text', text: 'You are a worker.' }],
    toolProfile: { preset: 'readonly' },
    privileged: false,
    ...overrides
  };
}

/**
 * Builds a valid template fixture.
 *
 * @param {object} [overrides] Template field overrides
 * @returns {object} Template literal
 */
function template(overrides = {}) {
  return {
    id: 'tpl',
    name: 'Template',
    description: 'fixture',
    formatVersion: 1,
    agents: [agentSpec()],
    ...overrides
  };
}

// ============================================================================
// 1. Runtime surface
// ============================================================================

test('1. runtime surface exports the demo template, the baked bundles, and the pure helpers', () => {
  assert.deepStrictEqual(Object.keys(RealmCatalogModule).sort(), [
    'AGENT_AUTHORITIES',
    'BAKED_TEMPLATE_BUNDLES',
    'DEMO_TEMPLATE',
    'KNOWN_AGENT_AUTHORITIES',
    'REALM_CATALOG_ERROR_CODES',
    'REALM_CONTENT_VERSION',
    'RealmCatalogError',
    'composeAgentHistory',
    'composeSystemPrompt',
    'getBakedTemplateBundle',
    'hashText',
    'materializeTemplate',
    'parseTemplateBundle',
    'resolveSeedManifest',
    'serializeTemplateBundle',
    'summarizeAgentCapabilities',
    'templateBundleVersion',
    'templateRequiresProviders',
    'templateUnsupportedAuthorities',
    'validateHydrationPackage'
  ]);
  assert.strictEqual(typeof composeSystemPrompt, 'function');
  assert.strictEqual(typeof composeAgentHistory, 'function');
  assert.strictEqual(typeof materializeTemplate, 'function');
  assert.strictEqual(typeof resolveSeedManifest, 'function');
  assert.strictEqual(typeof summarizeAgentCapabilities, 'function');
  assert.strictEqual(typeof getBakedTemplateBundle, 'function');
  assert.strictEqual(typeof hashText, 'function');
  assert.strictEqual(typeof parseTemplateBundle, 'function');
  assert.strictEqual(typeof serializeTemplateBundle, 'function');
  assert.strictEqual(typeof templateBundleVersion, 'function');
  assert.strictEqual(typeof validateHydrationPackage, 'function');
  assert.strictEqual(typeof templateRequiresProviders, 'function');
  assert.strictEqual(typeof RealmCatalogError, 'function');
  assert.ok(Object.isFrozen(REALM_CATALOG_ERROR_CODES), 'the error-code dictionary is frozen');
  assert.ok(!('default' in RealmCatalogModule), 'no default export');
});

// ============================================================================
// 2. Baked demo fixture
// ============================================================================

test('2. demo template is the frozen two-agent fixture with inline text prompt parts', () => {
  assert.strictEqual(DEMO_TEMPLATE.id, 'demo');
  assert.strictEqual(DEMO_TEMPLATE.formatVersion, 1);
  assert.ok(!('inputs' in DEMO_TEMPLATE), 'the demo declares no inputs');
  assert.ok(!('seed' in DEMO_TEMPLATE), 'the demo declares no seed');
  assert.deepStrictEqual(DEMO_TEMPLATE.agents.map((spec) => spec.key), ['coordinator', 'worker']);
  assert.deepStrictEqual(
    DEMO_TEMPLATE.agents.map((spec) => spec.idPattern),
    ['coordinator', 'worker'],
    'demo patterns are plain literal ids'
  );
  assert.ok(
    DEMO_TEMPLATE.agents.every((spec) => !spec.idPattern.includes('{')),
    'no demo pattern carries the retired {realm} placeholder'
  );

  const coordinator = DEMO_TEMPLATE.agents[0];
  const worker = DEMO_TEMPLATE.agents[1];
  assert.deepStrictEqual(coordinator.prompt, [
    { kind: 'text', text: 'You coordinate the realm workers and report their results back.' }
  ]);
  assert.deepStrictEqual(worker.prompt, [
    { kind: 'text', text: 'You carry out the coordinator assignments and report back.' }
  ]);
  assert.strictEqual(coordinator.privileged, true);
  assert.deepStrictEqual(coordinator.toolProfile, { preset: 'manager' });
  assert.strictEqual(worker.privileged, false);
  assert.deepStrictEqual(worker.toolProfile, { preset: 'readonly' });

  assert.ok(Object.isFrozen(DEMO_TEMPLATE), 'template must be frozen');
  assert.ok(Object.isFrozen(DEMO_TEMPLATE.agents), 'agent list must be frozen');
  assert.ok(Object.isFrozen(coordinator), 'agent spec must be frozen');
  assert.ok(Object.isFrozen(coordinator.prompt), 'prompt part list must be frozen');
  assert.ok(Object.isFrozen(coordinator.prompt[0]), 'prompt part must be frozen');
  assert.ok(Object.isFrozen(coordinator.toolProfile), 'tool profile must be frozen');
  assert.throws(() => {
    coordinator.privileged = false;
  }, TypeError);
  assert.throws(() => {
    DEMO_TEMPLATE.agents.push(agentSpec());
  }, TypeError);
  assert.throws(() => {
    coordinator.prompt[0].text = 'mutated';
  }, TypeError);
});

// ============================================================================
// 3. Deterministic materialization
// ============================================================================

test('3. materializeTemplate yields deterministic, deeply frozen plans in template order', () => {
  const first = materializeTemplate(DEMO_TEMPLATE, { realmId: 'alpha' });
  const second = materializeTemplate(DEMO_TEMPLATE, { realmId: 'alpha' });

  assert.notStrictEqual(first, second, 'each call must build a fresh plan');
  assert.deepStrictEqual(first, second, 'plans must be deep-equal across calls');
  assert.strictEqual(first.templateId, 'demo');
  assert.strictEqual(first.realmId, 'alpha');
  assert.ok(!('seed' in first), 'a seed-less template produces a seed-less plan');
  assert.deepStrictEqual(
    first.agents.map((agent) => agent.agentId),
    ['coordinator', 'worker']
  );
  assert.ok(
    first.agents.every((agent) => !agent.agentId.includes('alpha')),
    'generated ids must never embed the realm id'
  );
  assert.strictEqual(first.agents[0].systemPrompt, DEMO_TEMPLATE.agents[0].prompt[0].text);
  assert.strictEqual(first.agents[1].systemPrompt, DEMO_TEMPLATE.agents[1].prompt[0].text);
  assert.deepStrictEqual(first.agents[0].inputProvenance, []);
  assert.deepStrictEqual(first.agents[1].inputProvenance, []);
  assert.deepStrictEqual(first.agents[0].toolProfile.tools, [...TOOL_PRESETS.manager]);
  assert.deepStrictEqual(first.agents[1].toolProfile.tools, [...TOOL_PRESETS.readonly]);
  assert.strictEqual(first.agents[0].toolProfile.preset, 'manager');
  assert.strictEqual(first.agents[1].toolProfile.preset, 'readonly');

  assert.ok(Object.isFrozen(first), 'plan must be frozen');
  assert.ok(Object.isFrozen(first.agents), 'plan agent list must be frozen');
  assert.ok(Object.isFrozen(first.agents[0]), 'plan agent must be frozen');
  assert.ok(Object.isFrozen(first.agents[0].inputProvenance), 'provenance list must be frozen');
  assert.ok(Object.isFrozen(first.agents[0].toolProfile), 'resolved profile must be frozen');
  assert.ok(Object.isFrozen(first.agents[0].toolProfile.tools), 'resolved grants must be frozen');
  assert.throws(() => {
    first.agents[0].agentId = 'mutated';
  }, TypeError);
  assert.throws(() => {
    first.agents[0].systemPrompt = 'mutated';
  }, TypeError);
  assert.throws(() => {
    first.agents.push({});
  }, TypeError);
  assert.throws(() => {
    first.agents[0].toolProfile.tools.push('write_file');
  }, TypeError);

  const other = materializeTemplate(DEMO_TEMPLATE, { realmId: 'beta' });
  assert.deepStrictEqual(
    other.agents.map((agent) => agent.agentId),
    ['coordinator', 'worker'],
    'the same template yields the same realm-opaque ids in every realm'
  );
  assert.strictEqual(other.realmId, 'beta', 'the realm id stays plan membership metadata only');
  assert.strictEqual(DEMO_TEMPLATE.agents[0].idPattern, 'coordinator');
  assert.strictEqual(DEMO_TEMPLATE.agents[1].idPattern, 'worker');
});

test('4. materialization never mutates or aliases caller input', () => {
  const mutable = template({ agents: [agentSpec({ toolProfile: { tools: ['read_file'] } })] });
  const snapshot = structuredClone(mutable);

  const plan = materializeTemplate(mutable, { realmId: 'r' });

  assert.deepStrictEqual(mutable, snapshot, 'input template must stay untouched');
  assert.notStrictEqual(
    plan.agents[0].toolProfile.tools,
    mutable.agents[0].toolProfile.tools,
    'resolved grants must be a fresh array'
  );
});

// ============================================================================
// 4. Literal ids / override resolution
// ============================================================================

test('5. literal id resolution and per-key overrides', () => {
  const tpl = template({
    agents: [agentSpec(), agentSpec({ key: 'fixed', idPattern: 'stable-id' })]
  });

  const plan = materializeTemplate(tpl, { realmId: 'r1' });
  assert.deepStrictEqual(
    plan.agents.map((agent) => agent.agentId),
    ['agent', 'stable-id'],
    'patterns materialize verbatim, never realm-prefixed'
  );

  const overridden = materializeTemplate(tpl, {
    realmId: 'r1',
    idOverrides: { agent: 'custom', fixed: '  padded-id  ' }
  });
  assert.deepStrictEqual(
    overridden.agents.map((agent) => agent.agentId),
    ['custom', 'padded-id'],
    'overrides win over patterns and resolve to trimmed ids'
  );
  assert.strictEqual(overridden.realmId, 'r1');
});

test('6. every literal id is ordinary (director included); retired placeholders are rejected', () => {
  // Wave I (ticket c02d0b9): ids are ordinary labels and confer nothing — the
  // historically reserved `director` identity materializes like any other id.
  const director = materializeTemplate(template({ agents: [agentSpec({ idPattern: 'director' })] }), { realmId: 'r' });
  assert.strictEqual(director.agents[0].agentId, 'director', 'the director id is an ordinary identifier');
  assert.strictEqual(director.realmId, 'r', 'an ordinary id does not change realm scoping');

  const cased = materializeTemplate(template({ agents: [agentSpec({ idPattern: 'Director' })] }), { realmId: 'r' });
  assert.strictEqual(cased.agents[0].agentId, 'Director', 'ids stay case-sensitive ordinary labels');

  const overridden = materializeTemplate(template(), { realmId: 'r', idOverrides: { agent: 'director' } });
  assert.strictEqual(overridden.agents[0].agentId, 'director', 'an override may carry any literal id');

  assert.throws(
    () => materializeTemplate(template({ agents: [agentSpec({ idPattern: '{realm}' })] }), { realmId: 'r' }),
    /retired/,
    'the {realm} placeholder is retired and must fail validation'
  );
  assert.throws(
    () => materializeTemplate(template({ agents: [agentSpec({ idPattern: '{realm}-agent' })] }), { realmId: 'r' }),
    /retired/,
    'a pattern embedding the retired token must fail validation'
  );
  assert.throws(
    () => materializeTemplate(template({ agents: [agentSpec({ idPattern: '{realm}-{slot}' })] }), { realmId: 'r' }),
    /retired/,
    'no placeholder syntax is accepted in an id pattern'
  );
  assert.throws(
    () => materializeTemplate(template(), { realmId: 'r', idOverrides: { agent: '{slot}' } }),
    /unresolved placeholder/,
    'override ids still fail closed on unresolved placeholders'
  );
});

// ============================================================================
// 5. Optional pass-through + closed shape
// ============================================================================

test('7. optional fields pass through verbatim; absent optionals stay absent', () => {
  const tpl = template({
    agents: [
      agentSpec({ triggerPolicy: 'manual', modelPresetId: 'preset_demo', initialPrompt: 'Start.' }),
      agentSpec({ key: 'bare', idPattern: 'bare-id' })
    ]
  });

  const plan = materializeTemplate(tpl, { realmId: 'r' });
  const [rich, bare] = plan.agents;

  assert.strictEqual(rich.triggerPolicy, 'manual');
  assert.strictEqual(rich.modelPresetId, 'preset_demo', 'preset ids must pass through verbatim');
  assert.strictEqual(rich.initialPrompt, 'Start.');
  assert.deepStrictEqual(Object.keys(rich).sort(), [
    'agentId',
    'authorities',
    'history',
    'initialPrompt',
    'inputProvenance',
    'key',
    'modelPresetId',
    'name',
    'privileged',
    'role',
    'systemPrompt',
    'toolProfile',
    'triggerPolicy'
  ]);
  assert.deepStrictEqual(rich.authorities, [], 'a spec without declarations carries an empty list');
  assert.deepStrictEqual(rich.history, [], 'a spec without declared history carries an empty list');

  for (const field of ['triggerPolicy', 'modelPresetId', 'initialPrompt']) {
    assert.ok(!(field in bare), `${field} must stay absent when not declared`);
  }
  assert.deepStrictEqual(Object.keys(bare).sort(), [
    'agentId',
    'authorities',
    'history',
    'inputProvenance',
    'key',
    'name',
    'privileged',
    'role',
    'systemPrompt',
    'toolProfile'
  ]);
  assert.ok(!('modelConfig' in rich), 'plans carry no model config');
  assert.ok(!('apiKey' in rich), 'plans carry no credential material');
  assert.ok(!('prompt' in rich), 'plans carry the composed system prompt, not the raw parts');
});

// ============================================================================
// 6. Fail-closed validation
// ============================================================================

test('8. materializeTemplate fails closed on malformed options and overrides', () => {
  const valid = template();

  assert.throws(() => materializeTemplate(valid, undefined), /options object/);
  assert.throws(() => materializeTemplate(valid, {}), /realmId/);
  assert.throws(() => materializeTemplate(valid, { realmId: '' }), /realmId/);
  assert.throws(() => materializeTemplate(valid, { realmId: '   ' }), /realmId/);
  assert.throws(() => materializeTemplate(valid, { realmId: 7 }), /realmId/);
  assert.throws(() => materializeTemplate(valid, { realmId: 'r', idOverrides: 'nope' }), /idOverrides/);
  assert.throws(
    () => materializeTemplate(valid, { realmId: 'r', idOverrides: { missing: 'x' } }),
    /unknown agent key/
  );
  assert.throws(() => materializeTemplate(valid, { realmId: 'r', idOverrides: { agent: '' } }), /idOverrides/);
  assert.throws(
    () => materializeTemplate(valid, { realmId: 'r', inputValues: 'nope' }),
    /inputValues must be a record/
  );
  assert.throws(
    () => materializeTemplate(valid, { realmId: 'r', inputValues: { ghost: 'x' } }),
    /undeclared input 'ghost'/,
    'an input value for an undeclared input fails closed'
  );
  assert.throws(
    () => materializeTemplate(valid, { realmId: 'r', inputValues: { agent: 7 } }),
    /inputValues\['agent'\] must be a string/
  );
  assert.throws(
    () => materializeTemplate(valid, { realmId: 'r', bundleFiles: 'nope' }),
    /bundleFiles must be a record/
  );
  assert.throws(
    () => materializeTemplate(valid, { realmId: 'r', bundleFiles: { 'a.md': 7 } }),
    /bundleFiles\['a\.md'\] must be a string/
  );
});

test('9. materializeTemplate fails closed on malformed templates, inputs, and seed', () => {
  assert.throws(() => materializeTemplate(null, { realmId: 'r' }), /template must be an object/);
  assert.throws(() => materializeTemplate('tpl', { realmId: 'r' }), /template must be an object/);
  assert.throws(() => materializeTemplate(template({ extra: true }), { realmId: 'r' }), /unknown field 'extra'/);
  assert.throws(() => materializeTemplate(template({ id: '' }), { realmId: 'r' }), /template id/);
  assert.throws(() => materializeTemplate(template({ name: '' }), { realmId: 'r' }), /template name/);
  assert.throws(() => materializeTemplate(template({ description: 7 }), { realmId: 'r' }), /description/);
  assert.throws(() => materializeTemplate(template({ notes: 7 }), { realmId: 'r' }), /notes/);
  assert.throws(() => materializeTemplate(template({ notes: '   ' }), { realmId: 'r' }), /notes/);
  assert.throws(
    () => materializeTemplate(template({ formatVersion: undefined }), { realmId: 'r' }),
    /formatVersion must be 1/
  );
  assert.throws(
    () => materializeTemplate(template({ formatVersion: 2 }), { realmId: 'r' }),
    /formatVersion must be 1/
  );
  assert.throws(
    () => materializeTemplate(template({ formatVersion: '1' }), { realmId: 'r' }),
    /formatVersion must be 1/
  );
  assert.throws(() => materializeTemplate(template({ agents: [] }), { realmId: 'r' }), /non-empty array/);
  assert.throws(() => materializeTemplate(template({ agents: 'nope' }), { realmId: 'r' }), /non-empty array/);
  assert.throws(
    () => materializeTemplate(template({ agents: [agentSpec(), agentSpec()] }), { realmId: 'r' }),
    /duplicate agent key/
  );
  assert.throws(
    () =>
      materializeTemplate(
        template({ agents: [agentSpec({ key: 'a' }), agentSpec({ key: 'b' })] }),
        { realmId: 'r' }
      ),
    /duplicate agent id/
  );

  // Template inputs (closed shape + uniqueness + prefill exclusivity).
  assert.throws(() => materializeTemplate(template({ inputs: 'nope' }), { realmId: 'r' }), /inputs must be an array/);
  assert.throws(
    () => materializeTemplate(template({ inputs: [{}] }), { realmId: 'r' }),
    /inputs\[0\] id/
  );
  assert.throws(
    () => materializeTemplate(template({ inputs: [{ id: 'a' }] }), { realmId: 'r' }),
    /inputs\[0\] label/
  );
  assert.throws(
    () => materializeTemplate(template({ inputs: [{ id: 'a', label: 'A', help: 7 }] }), { realmId: 'r' }),
    /inputs\[0\] help/
  );
  assert.throws(
    () => materializeTemplate(template({ inputs: [{ id: 'a', label: 'A', default: 7 }] }), { realmId: 'r' }),
    /inputs\[0\] default must be a string/
  );
  assert.throws(
    () =>
      materializeTemplate(
        template({ inputs: [{ id: 'a', label: 'A', default: 'x', defaultFile: 'f.md' }] }),
        { realmId: 'r' }
      ),
    /at most one of default or defaultFile/
  );
  assert.throws(
    () => materializeTemplate(template({ inputs: [{ id: 'a', label: 'A', defaultFile: '../f.md' }] }), { realmId: 'r' }),
    /must not contain '\.\.'/
  );
  assert.throws(
    () => materializeTemplate(template({ inputs: [{ id: 'a', label: 'A', required: 'yes' }] }), { realmId: 'r' }),
    /inputs\[0\] required must be a boolean/
  );
  assert.throws(
    () => materializeTemplate(template({ inputs: [{ id: 'a', label: 'A', multiline: 'yes' }] }), { realmId: 'r' }),
    /inputs\[0\] multiline must be a boolean/
  );
  assert.throws(
    () => materializeTemplate(template({ inputs: [{ id: 'a', label: 'A', extra: 1 }] }), { realmId: 'r' }),
    /unknown field 'extra'/
  );
  assert.throws(
    () =>
      materializeTemplate(
        template({ inputs: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }),
        { realmId: 'r' }
      ),
    /duplicate input id 'a'/
  );
  assert.throws(
    () =>
      materializeTemplate(
        template({ agents: [agentSpec({ prompt: [{ kind: 'input', inputId: 'missing' }] })] }),
        { realmId: 'r' }
      ),
    /references undeclared input 'missing'/
  );

  // Seed manifest (closed shape, safe paths, agent-key targets, source exclusivity).
  const seedCases = [
    [template({ seed: 'nope' }), /seed must be an object/],
    [template({ seed: { extra: 1 } }), /unknown field 'extra'/],
    [template({ seed: { files: 'nope' } }), /files must be an array/],
    [template({ seed: { files: [{}] } }), /files\[0\] path/],
    [
      template({ seed: { files: [{ path: '../escape.md', target: 'realm', source: { inline: 'x' } }] } }),
      /must not contain '\.\.'/
    ],
    [
      template({ seed: { files: [{ path: 'a\0b.md', target: 'realm', source: { inline: 'x' } }] } }),
      /null bytes/
    ],
    [
      template({ seed: { files: [{ path: 'a.md', target: 'realm', source: { inline: 'x' }, extra: 1 }] } }),
      /unknown field 'extra'/
    ],
    [
      template({ seed: { files: [{ path: 'a.md', target: 'other', source: { inline: 'x' } }] } }),
      /'realm' or an object/
    ],
    [
      template({ seed: { files: [{ path: 'a.md', target: { agent: 'ghost' }, source: { inline: 'x' } }] } }),
      /unknown template agent key 'ghost'/
    ],
    [
      template({ seed: { files: [{ path: 'a.md', target: { agent: 'agent', extra: 1 }, source: { inline: 'x' } }] } }),
      /unknown field 'extra'/
    ],
    [
      template({ seed: { files: [{ path: 'a.md', target: 'realm', source: {} }] } }),
      /exactly one of file or inline/
    ],
    [
      template({ seed: { files: [{ path: 'a.md', target: 'realm', source: { file: 'f.md', inline: 'x' } }] } }),
      /exactly one of file or inline/
    ],
    [
      template({ seed: { files: [{ path: 'a.md', target: 'realm', source: { file: '../f.md' } }] } }),
      /must not contain '\.\.'/
    ],
    [
      template({ seed: { files: [{ path: 'a.md', target: 'realm', source: { inline: 7 } }] } }),
      /inline must be a string/
    ],
    [template({ seed: { directive: {} } }), /directive targetAgentKey/],
    [
      template({ seed: { directive: { targetAgentKey: 'ghost', text: 'x' } } }),
      /unknown template agent key 'ghost'/
    ],
    [
      template({ seed: { directive: { targetAgentKey: 'agent', text: '   ' } } }),
      /directive text/
    ],
    [
      template({ seed: { directive: { targetAgentKey: 'agent', text: 'x', extra: 1 } } }),
      /unknown field 'extra'/
    ]
  ];
  for (const [spec, pattern] of seedCases) {
    assert.throws(
      () => materializeTemplate(spec, { realmId: 'r' }),
      pattern,
      `must reject ${JSON.stringify(spec.seed)}`
    );
  }
});

test('10. materializeTemplate fails closed on malformed agent specs, prompts, and profiles', () => {
  const cases = [
    [null, /must be an object/],
    ['spec', /must be an object/],
    [agentSpec({ extra: 1 }), /unknown field 'extra'/],
    [agentSpec({ systemPromptRef: 'retired' }), /unknown field 'systemPromptRef'/],
    [agentSpec({ key: '' }), /key/],
    [agentSpec({ idPattern: '' }), /idPattern/],
    [agentSpec({ idPattern: '{realm}-agent' }), /retired/],
    [agentSpec({ name: '' }), /name/],
    [agentSpec({ role: '' }), /role/],
    [agentSpec({ prompt: [] }), /non-empty array of prompt parts/],
    [agentSpec({ prompt: 'nope' }), /non-empty array of prompt parts/],
    [agentSpec({ prompt: [{ kind: 'wizard', text: 'x' }] }), /unknown prompt part kind 'wizard'/],
    [agentSpec({ prompt: [{ kind: 'text' }] }), /prompt\[0\] text/],
    [agentSpec({ prompt: [{ kind: 'text', text: '   ' }] }), /prompt\[0\] text/],
    [agentSpec({ prompt: [{ kind: 'text', text: 'x', extra: 1 }] }), /unknown field 'extra'/],
    [agentSpec({ prompt: [{ kind: 'file' }] }), /prompt\[0\] path/],
    [agentSpec({ prompt: [{ kind: 'file', path: '../x.md' }] }), /must not contain '\.\.'/],
    [agentSpec({ prompt: [{ kind: 'file', path: 'p.md', text: 'x' }] }), /unknown field 'text'/],
    [agentSpec({ prompt: [{ kind: 'input' }] }), /prompt\[0\] inputId/],
    [agentSpec({ prompt: [{ kind: 'input', inputId: 'a', path: 'p.md' }] }), /unknown field 'path'/],
    [agentSpec({ privileged: 'yes' }), /privileged/],
    [agentSpec({ triggerPolicy: 7 }), /triggerPolicy/],
    [agentSpec({ modelPresetId: '' }), /modelPresetId/],
    [agentSpec({ initialPrompt: 7 }), /initialPrompt/],
    [agentSpec({ toolProfile: undefined }), /toolProfile/],
    [agentSpec({ toolProfile: {} }), /exactly one/],
    [agentSpec({ toolProfile: { preset: 'manager', tools: ['read_file'] } }), /exactly one/],
    [agentSpec({ toolProfile: { preset: 'wizard' } }), /not a known tool preset/],
    [agentSpec({ toolProfile: { preset: 7 } }), /not a known tool preset/],
    [agentSpec({ toolProfile: { tools: 'read_file' } }), /array of tool names/],
    [agentSpec({ toolProfile: { tools: [''] } }), /tools\[0\]/],
    [agentSpec({ toolProfile: { tools: ['read_file'], extra: true } }), /unknown field 'extra'/]
  ];

  for (const [spec, pattern] of cases) {
    assert.throws(
      () => materializeTemplate(template({ agents: [spec] }), { realmId: 'r' }),
      pattern,
      `must reject ${JSON.stringify(spec)}`
    );
  }
});

// ============================================================================
// 7. Capability summaries
// ============================================================================

test('11. capability summary for the demo coordinator and worker', () => {
  const coordinator = summarizeAgentCapabilities(DEMO_TEMPLATE.agents[0]);
  assert.strictEqual(coordinator.privileged, true);
  assert.strictEqual(coordinator.preset, 'manager');
  assert.strictEqual(coordinator.wildcard, true);
  assert.strictEqual(coordinator.wildcardSource, 'privileged', 'privilege escalates to wildcard');
  assert.deepStrictEqual(coordinator.grants, ['*']);
  assert.deepStrictEqual(coordinator.mutating, [...MUTATING_TOOLS]);
  assert.deepStrictEqual(coordinator.readOnly, [...READ_ONLY_TOOLS]);
  assert.deepStrictEqual(coordinator.unrecognized, []);
  assert.strictEqual(coordinator.subagentManagement, true);

  const worker = summarizeAgentCapabilities(DEMO_TEMPLATE.agents[1]);
  assert.strictEqual(worker.privileged, false);
  assert.strictEqual(worker.preset, 'readonly');
  assert.strictEqual(worker.wildcard, false);
  assert.strictEqual(worker.wildcardSource, 'none');
  assert.strictEqual(worker.subagentManagement, false);
  assert.deepStrictEqual(worker.grants, [...TOOL_PRESETS.readonly]);
  assert.deepStrictEqual(
    worker.mutating,
    TOOL_PRESETS.readonly.filter((tool) => MUTATING_TOOLS.includes(tool))
  );
  assert.deepStrictEqual(
    worker.readOnly,
    TOOL_PRESETS.readonly.filter((tool) => READ_ONLY_TOOLS.includes(tool))
  );
  assert.deepStrictEqual(worker.unrecognized, []);
  assert.ok(worker.mutating.includes('get_inbox'), 'mail consumption mutates state');
  assert.ok(worker.mutating.includes('read_message'));
  assert.ok(worker.readOnly.includes('read_file'));
  assert.ok(Object.isFrozen(worker), 'summary must be frozen');
  assert.ok(Object.isFrozen(worker.grants));
  assert.ok(Object.isFrozen(worker.mutating));
  assert.ok(Object.isFrozen(worker.readOnly));
  assert.ok(Object.isFrozen(worker.unrecognized));
  assert.throws(() => {
    worker.mutating.push('write_file');
  }, TypeError);

  const plan = materializeTemplate(DEMO_TEMPLATE, { realmId: 'x' });
  assert.deepStrictEqual(worker.grants, plan.agents[1].toolProfile.tools, 'preview grants mirror plan grants');
});

test('12. manager preset expands the aggregate selector for unprivileged specs', () => {
  const summary = summarizeAgentCapabilities(agentSpec({ toolProfile: { preset: 'manager' } }));

  assert.strictEqual(summary.privileged, false);
  assert.strictEqual(summary.wildcard, false);
  assert.strictEqual(summary.wildcardSource, 'none');
  assert.strictEqual(summary.subagentManagement, true);
  for (const tool of ['spawn_agent', 'kill_agent', 'invoke_agent', 'undo_turn']) {
    assert.ok(summary.mutating.includes(tool), `${tool} must be classified mutating`);
  }
  assert.ok(!summary.grants.includes('subagent_management'), 'the aggregate selector is expanded');
  assert.ok(!summary.unrecognized.includes('subagent_management'));
});

test('13. wildcard profiles report full vocabulary coverage', () => {
  for (const profile of [{ preset: 'all' }, { tools: ['*'] }]) {
    const summary = summarizeAgentCapabilities(agentSpec({ toolProfile: profile }));
    assert.strictEqual(summary.wildcard, true);
    assert.strictEqual(summary.wildcardSource, 'profile');
    assert.deepStrictEqual(summary.grants, ['*']);
    assert.deepStrictEqual(summary.mutating, [...MUTATING_TOOLS]);
    assert.deepStrictEqual(summary.readOnly, [...READ_ONLY_TOOLS]);
    assert.deepStrictEqual(summary.unrecognized, []);
    assert.strictEqual(summary.subagentManagement, true);
  }
});

test('14. explicit grants are strict: aliases canonicalize; unknown names and undeclared requirements are rejected', () => {
  const aliased = summarizeAgentCapabilities(
    agentSpec({ toolProfile: { tools: ['read_file', 'save_file', 'save_file'] } })
  );
  assert.strictEqual(aliased.preset, null);
  assert.strictEqual(aliased.wildcard, false);
  assert.deepStrictEqual(aliased.grants, ['read_file', 'write_file'], 'aliases canonicalize and dedupe');
  assert.deepStrictEqual(aliased.readOnly, ['read_file']);
  assert.deepStrictEqual(aliased.mutating, ['write_file']);
  assert.deepStrictEqual(aliased.unrecognized, []);

  assert.throws(
    () => summarizeAgentCapabilities(agentSpec({ toolProfile: { tools: ['definitely_not_a_tool'] } })),
    /neither a canonical tool name nor a declared toolContract requirement id/,
    'the silent unrecognized pass-through is replaced by strict validation'
  );
  assert.throws(
    () => summarizeAgentCapabilities(agentSpec({ toolProfile: { tools: ['text.similarity'] } })),
    /neither a canonical tool name nor a declared toolContract requirement id/,
    'a requirement id is only a valid grant when the owning template declares it'
  );

  const requirements = [
    { id: 'text.similarity', brief: 'similarity', io: { in: { a: 'string' }, out: { score: 'number' } } }
  ];
  const withRequirement = summarizeAgentCapabilities(
    agentSpec({ toolProfile: { tools: ['read_file', 'text.similarity', 'text.similarity'] } }),
    requirements
  );
  assert.deepStrictEqual(withRequirement.grants, ['read_file', 'text.similarity']);
  assert.deepStrictEqual(withRequirement.readOnly, ['read_file']);
  assert.deepStrictEqual(withRequirement.mutating, []);
  assert.deepStrictEqual(withRequirement.unrecognized, [], 'declared requirement ids are not unrecognized');
  assert.ok(Object.isFrozen(withRequirement.grants));

  assert.throws(
    () => summarizeAgentCapabilities(agentSpec(), [{ id: '' }]),
    /requirements\[0\] id/,
    'malformed requirement declarations fail closed in the summary'
  );
});

test('15. summarizeAgentCapabilities fails closed and stays deterministic', () => {
  assert.throws(() => summarizeAgentCapabilities(null), /must be an object/);
  assert.throws(() => summarizeAgentCapabilities(agentSpec({ key: '' })), /key/);
  assert.throws(() => summarizeAgentCapabilities(agentSpec({ privileged: 'yes' })), /privileged/);
  assert.throws(
    () => summarizeAgentCapabilities(agentSpec({ idPattern: '{realm}-agent' })),
    /retired/,
    'the launcher preview must reject the retired placeholder too'
  );
  assert.throws(
    () => summarizeAgentCapabilities(agentSpec({ prompt: [] })),
    /non-empty array of prompt parts/,
    'the launcher preview must reject a malformed prompt too'
  );
  assert.throws(
    () => summarizeAgentCapabilities(agentSpec({ prompt: [{ kind: 'wizard' }] })),
    /unknown prompt part kind/
  );
  assert.throws(
    () => summarizeAgentCapabilities(agentSpec({ toolProfile: { preset: 'wizard' } })),
    /not a known tool preset/
  );
  assert.throws(() => summarizeAgentCapabilities(agentSpec({ toolProfile: {} })), /exactly one/);
  assert.throws(
    () => summarizeAgentCapabilities(agentSpec({ toolProfile: { preset: 'manager', tools: [] } })),
    /exactly one/
  );

  const first = summarizeAgentCapabilities(DEMO_TEMPLATE.agents[1]);
  const second = summarizeAgentCapabilities(DEMO_TEMPLATE.agents[1]);
  assert.notStrictEqual(first, second, 'each call must build a fresh summary');
  assert.deepStrictEqual(first, second);
});

// ============================================================================
// 8. Composition
// ============================================================================

test('16. composition follows declared order, joins with a blank line, and resolves every part kind', () => {
  const tpl = template({
    inputs: [
      { id: 'directives', label: 'Directives', default: 'Default directives.' },
      { id: 'lore', label: 'Lore' }
    ],
    agents: [
      agentSpec({
        prompt: [
          { kind: 'text', text: 'Protocol.' },
          { kind: 'file', path: 'prompts/protocol.md' },
          { kind: 'input', inputId: 'directives' },
          { kind: 'input', inputId: 'lore' },
          { kind: 'text', text: 'End.' }
        ]
      })
    ]
  });

  const plan = materializeTemplate(tpl, {
    realmId: 'r',
    inputValues: { lore: 'World lore.' },
    bundleFiles: { 'prompts/protocol.md': 'File protocol.' }
  });
  const again = materializeTemplate(tpl, {
    realmId: 'r',
    inputValues: { lore: 'World lore.' },
    bundleFiles: { 'prompts/protocol.md': 'File protocol.' }
  });

  assert.strictEqual(
    plan.agents[0].systemPrompt,
    'Protocol.\n\nFile protocol.\n\nDefault directives.\n\nWorld lore.\n\nEnd.'
  );
  assert.deepStrictEqual(plan.agents[0].inputProvenance, [
    { inputId: 'directives', source: 'default' },
    { inputId: 'lore', source: 'launch' }
  ]);
  assert.deepStrictEqual(plan, again, 'composition stays deterministic across calls');
  assert.notStrictEqual(plan.agents[0].inputProvenance, again.agents[0].inputProvenance);

  const padded = materializeTemplate(
    template({ agents: [agentSpec({ prompt: [{ kind: 'text', text: '  padded  ' }] })] }),
    { realmId: 'r' }
  );
  assert.strictEqual(padded.agents[0].systemPrompt, '  padded  ', 'text parts contribute verbatim');
});

test('17. an empty input contributes nothing; required inputs fail closed while empty', () => {
  const tpl = template({
    inputs: [
      { id: 'optional', label: 'Optional' },
      { id: 'unreferencedRequired', label: 'Unreferenced required', required: true }
    ],
    agents: [
      agentSpec({
        prompt: [
          { kind: 'text', text: 'A' },
          { kind: 'input', inputId: 'optional' },
          { kind: 'text', text: 'B' }
        ]
      })
    ]
  });

  const plan = materializeTemplate(tpl, { realmId: 'r' });
  assert.strictEqual(plan.agents[0].systemPrompt, 'A\n\nB', 'an empty input is omitted, separators collapse');
  assert.deepStrictEqual(plan.agents[0].inputProvenance, [{ inputId: 'optional', source: 'empty' }]);

  const requiredTpl = template({
    inputs: [{ id: 'directives', label: 'Directives', required: true }],
    agents: [agentSpec({ prompt: [{ kind: 'text', text: 'A' }, { kind: 'input', inputId: 'directives' }] })]
  });
  assert.throws(
    () => materializeTemplate(requiredTpl, { realmId: 'r' }),
    /input 'directives' is required and resolves empty/
  );
  assert.throws(
    () => materializeTemplate(requiredTpl, { realmId: 'r', inputValues: { directives: '   ' } }),
    /required and resolves empty/,
    'a whitespace-only launch value is empty'
  );
  assert.throws(
    () => materializeTemplate(requiredTpl, { realmId: 'r', inputValues: { directives: '' } }),
    /required and resolves empty/,
    'an explicit empty launch value stays launch-sourced and blocks a required input'
  );
  assert.strictEqual(
    materializeTemplate(requiredTpl, { realmId: 'r', inputValues: { directives: 'Go.' } }).agents[0].systemPrompt,
    'A\n\nGo.'
  );

  const defaulted = template({
    inputs: [{ id: 'directives', label: 'Directives', required: true, default: 'Fallback.' }],
    agents: [agentSpec({ prompt: [{ kind: 'input', inputId: 'directives' }] })]
  });
  assert.strictEqual(materializeTemplate(defaulted, { realmId: 'r' }).agents[0].systemPrompt, 'Fallback.');

  const overridden = template({
    inputs: [{ id: 'i', label: 'I', default: 'D' }],
    agents: [agentSpec({ prompt: [{ kind: 'text', text: 'A' }, { kind: 'input', inputId: 'i' }, { kind: 'text', text: 'B' }] })]
  });
  const launchedEmpty = materializeTemplate(overridden, { realmId: 'r', inputValues: { i: '' } });
  assert.strictEqual(launchedEmpty.agents[0].systemPrompt, 'A\n\nB');
  assert.deepStrictEqual(
    launchedEmpty.agents[0].inputProvenance,
    [{ inputId: 'i', source: 'launch' }],
    'an explicit empty launch value never silently falls back to the default'
  );
});

test('18. default and defaultFile prefills resolve; a referenced missing bundle entry fails closed', () => {
  const tpl = template({
    inputs: [
      { id: 'plain', label: 'Plain', default: 'Default text.' },
      { id: 'fromFile', label: 'From file', defaultFile: 'files/prefill.md' }
    ],
    agents: [
      agentSpec({
        prompt: [{ kind: 'input', inputId: 'plain' }, { kind: 'input', inputId: 'fromFile' }]
      })
    ]
  });

  const plan = materializeTemplate(tpl, { realmId: 'r', bundleFiles: { 'files/prefill.md': 'Prefilled.' } });
  assert.strictEqual(plan.agents[0].systemPrompt, 'Default text.\n\nPrefilled.');
  assert.deepStrictEqual(plan.agents[0].inputProvenance, [
    { inputId: 'plain', source: 'default' },
    { inputId: 'fromFile', source: 'defaultFile' }
  ]);

  assert.throws(
    () => materializeTemplate(tpl, { realmId: 'r' }),
    /defaultFile 'files\/prefill\.md' is not present in the bundle files/
  );

  const overridden = materializeTemplate(tpl, { realmId: 'r', inputValues: { fromFile: 'Launch.' } });
  assert.strictEqual(overridden.agents[0].systemPrompt, 'Default text.\n\nLaunch.');
  assert.deepStrictEqual(overridden.agents[0].inputProvenance[1], { inputId: 'fromFile', source: 'launch' });

  const emptyDefault = template({
    inputs: [{ id: 'i', label: 'I', default: '' }],
    agents: [agentSpec({ prompt: [{ kind: 'input', inputId: 'i' }] })]
  });
  const emptyPlan = materializeTemplate(emptyDefault, { realmId: 'r' });
  assert.strictEqual(emptyPlan.agents[0].systemPrompt, '', 'an all-empty composition is the empty string');
  assert.deepStrictEqual(emptyPlan.agents[0].inputProvenance, [{ inputId: 'i', source: 'default' }]);
});

test('19. file parts resolve from bundleFiles; a missing bundle entry fails closed', () => {
  const tpl = template({
    agents: [agentSpec({ prompt: [{ kind: 'file', path: 'prompts/a.md' }, { kind: 'text', text: 'B' }] })]
  });

  const plan = materializeTemplate(tpl, { realmId: 'r', bundleFiles: { 'prompts/a.md': 'A file.' } });
  assert.strictEqual(plan.agents[0].systemPrompt, 'A file.\n\nB');
  assert.deepStrictEqual(plan.agents[0].inputProvenance, []);

  assert.throws(
    () => materializeTemplate(tpl, { realmId: 'r' }),
    /prompt file 'prompts\/a\.md' is not present in the bundle files/
  );
  assert.throws(
    () => materializeTemplate(tpl, { realmId: 'r', bundleFiles: { 'prompts/other.md': 'x' } }),
    /not present in the bundle files/
  );
});

test('20. input provenance dedupes per input and follows first-reference order', () => {
  const tpl = template({
    inputs: [
      { id: 'b', label: 'B' },
      { id: 'a', label: 'A', default: 'A.' }
    ],
    agents: [
      agentSpec({
        prompt: [
          { kind: 'input', inputId: 'b' },
          { kind: 'text', text: 'X' },
          { kind: 'input', inputId: 'a' },
          { kind: 'input', inputId: 'b' }
        ]
      })
    ]
  });

  const plan = materializeTemplate(tpl, { realmId: 'r', inputValues: { b: 'B.' } });
  assert.strictEqual(plan.agents[0].systemPrompt, 'B.\n\nX\n\nA.\n\nB.');
  assert.deepStrictEqual(plan.agents[0].inputProvenance, [
    { inputId: 'b', source: 'launch' },
    { inputId: 'a', source: 'default' }
  ]);
  assert.ok(Object.isFrozen(plan.agents[0].inputProvenance), 'provenance must be frozen');
  assert.ok(Object.isFrozen(plan.agents[0].inputProvenance[0]), 'provenance entries must be frozen');

  const unused = template({ inputs: [{ id: 'unused', label: 'Unused' }], agents: [agentSpec()] });
  const unusedPlan = materializeTemplate(unused, { realmId: 'r', inputValues: { unused: 'ignored' } });
  assert.deepStrictEqual(
    unusedPlan.agents[0].inputProvenance,
    [],
    'provenance covers referenced inputs only'
  );
});

test('21. seed manifests resolve inline and bundle-file content into the plan', () => {
  const tpl = template({
    seed: {
      files: [
        { path: 'brief.md', target: 'realm', source: { inline: 'Inline brief.' } },
        { path: 'notes/plan.md', target: { agent: 'agent' }, source: { file: 'files/plan.md' } }
      ],
      directive: { targetAgentKey: 'agent', text: 'Begin.' }
    }
  });

  const plan = materializeTemplate(tpl, { realmId: 'r', bundleFiles: { 'files/plan.md': 'Plan body.' } });
  assert.deepStrictEqual(plan.seed, {
    files: [
      { path: 'brief.md', target: 'realm', content: 'Inline brief.' },
      { path: 'notes/plan.md', target: { agent: 'agent' }, content: 'Plan body.' }
    ],
    directive: { targetAgentKey: 'agent', text: 'Begin.' }
  });
  assert.ok(Object.isFrozen(plan.seed), 'resolved seed must be frozen');
  assert.ok(Object.isFrozen(plan.seed.files), 'resolved seed files must be frozen');
  assert.ok(Object.isFrozen(plan.seed.files[1]), 'resolved seed file must be frozen');
  assert.ok(Object.isFrozen(plan.seed.files[1].target), 'resolved seed target must be frozen');
  assert.ok(Object.isFrozen(plan.seed.directive), 'resolved directive must be frozen');
  assert.deepStrictEqual(
    materializeTemplate(tpl, { realmId: 'r', bundleFiles: { 'files/plan.md': 'Plan body.' } }),
    plan,
    'seed resolution stays deterministic across calls'
  );

  assert.throws(
    () => materializeTemplate(tpl, { realmId: 'r' }),
    /seed file 'files\/plan\.md' \(files\[1\]\) is not present in the bundle files/
  );

  assert.ok(!('seed' in materializeTemplate(template(), { realmId: 'r' })), 'a seed-less template stays seed-less');

  const emptyInline = template({
    seed: { files: [{ path: 'empty.md', target: 'realm', source: { inline: '' } }] }
  });
  assert.strictEqual(
    materializeTemplate(emptyInline, { realmId: 'r' }).seed.files[0].content,
    '',
    'empty inline content is a valid empty file'
  );

  const emptyManifest = materializeTemplate(template({ seed: {} }), { realmId: 'r' });
  assert.deepStrictEqual(emptyManifest.seed, { files: [] }, 'a file-less manifest resolves to an empty list');
});

test('22. a seed directive must have a file for its target agent (fail closed, no second delivery path)', () => {
  const directiveOnly = template({
    seed: {
      files: [{ path: 'brief.md', target: 'realm', source: { inline: 'Realm brief.' } }],
      directive: { targetAgentKey: 'agent', text: 'Begin.' }
    }
  });
  assert.throws(
    () => materializeTemplate(directiveOnly, { realmId: 'r' }),
    /directive targets agent 'agent' but declares no seed file for that target/,
    'a directive for an agent without files is rejected at validation'
  );

  const emptyFiles = template({ seed: { files: [], directive: { targetAgentKey: 'agent', text: 'Begin.' } } });
  assert.throws(
    () => materializeTemplate(emptyFiles, { realmId: 'r' }),
    /declares no seed file for that target/
  );

  const realmFileOnly = template({
    seed: {
      files: [{ path: 'notes.md', target: 'realm', source: { inline: 'Realm notes.' } }],
      directive: { targetAgentKey: 'agent', text: 'Begin.' }
    }
  });
  assert.throws(
    () => materializeTemplate(realmFileOnly, { realmId: 'r' }),
    /declares no seed file for that target/,
    'a realm-global file does not satisfy the directive target'
  );

  // The valid shape: at least one file targets the directive's agent key.
  const valid = template({
    seed: {
      files: [
        { path: 'brief.md', target: 'realm', source: { inline: 'Realm brief.' } },
        { path: 'orders/one.md', target: { agent: 'agent' }, source: { inline: 'Order.' } }
      ],
      directive: { targetAgentKey: 'agent', text: 'Begin.' }
    }
  });
  const plan = materializeTemplate(valid, { realmId: 'r' });
  assert.deepStrictEqual(plan.seed.directive, { targetAgentKey: 'agent', text: 'Begin.' });
  assert.deepStrictEqual(
    plan.seed.files.map((file) => file.target),
    ['realm', { agent: 'agent' }]
  );

  // The standalone resolver validates the same rule.
  assert.throws(
    () => resolveSeedManifest({ directive: { targetAgentKey: 'agent', text: 'Begin.' } }),
    /declares no seed file for that target/
  );
});

test('23. composition caps: at most 64 parts and 200 KB per composed prompt', () => {
  const exactly64 = Array.from({ length: MAX_PROMPT_PARTS }, (_, index) => ({ kind: 'text', text: `p${index}` }));
  const plan = materializeTemplate(template({ agents: [agentSpec({ prompt: exactly64 })] }), { realmId: 'r' });
  assert.strictEqual(plan.agents[0].systemPrompt.split('\n\n').length, MAX_PROMPT_PARTS);

  const tooMany = Array.from({ length: MAX_PROMPT_PARTS + 1 }, () => ({ kind: 'text', text: 'x' }));
  assert.throws(
    () => materializeTemplate(template({ agents: [agentSpec({ prompt: tooMany })] }), { realmId: 'r' }),
    /the cap is 64/
  );

  const atCap = 'x'.repeat(MAX_COMPOSED_PROMPT_CHARS);
  const atCapPlan = materializeTemplate(
    template({ agents: [agentSpec({ prompt: [{ kind: 'text', text: atCap }] })] }),
    { realmId: 'r' }
  );
  assert.strictEqual(atCapPlan.agents[0].systemPrompt.length, MAX_COMPOSED_PROMPT_CHARS);

  const overCap = 'x'.repeat(MAX_COMPOSED_PROMPT_CHARS + 1);
  assert.throws(
    () => materializeTemplate(template({ agents: [agentSpec({ prompt: [{ kind: 'text', text: overCap }] })] }), { realmId: 'r' }),
    /the cap is 204800/
  );
});

test('24. composeSystemPrompt and resolveSeedManifest are standalone, frozen, and fail closed', () => {
  const composed = composeSystemPrompt(
    [{ kind: 'text', text: 'A' }, { kind: 'input', inputId: 'i' }],
    [{ id: 'i', label: 'I', default: 'D' }]
  );
  assert.deepStrictEqual(composed, {
    systemPrompt: 'A\n\nD',
    inputProvenance: [{ inputId: 'i', source: 'default' }]
  });
  assert.ok(Object.isFrozen(composed), 'composed prompt must be frozen');
  assert.ok(Object.isFrozen(composed.inputProvenance), 'composed provenance must be frozen');
  assert.notStrictEqual(composed, composeSystemPrompt(
    [{ kind: 'text', text: 'A' }, { kind: 'input', inputId: 'i' }],
    [{ id: 'i', label: 'I', default: 'D' }]
  ));

  assert.throws(() => composeSystemPrompt([], undefined), /non-empty array of prompt parts/);
  assert.throws(
    () => composeSystemPrompt([{ kind: 'input', inputId: 'ghost' }], undefined),
    /references undeclared input 'ghost'/
  );
  assert.throws(
    () => composeSystemPrompt([{ kind: 'text', text: 'A' }], undefined, { inputValues: { ghost: 'x' } }),
    /undeclared input 'ghost'/
  );
  assert.throws(() => composeSystemPrompt([{ kind: 'text', text: 'A' }], undefined, 'nope'), /options must be an object/);

  const resolved = resolveSeedManifest({
    files: [{ path: 'a.md', target: 'realm', source: { inline: 'Body.' } }]
  });
  assert.deepStrictEqual(resolved, { files: [{ path: 'a.md', target: 'realm', content: 'Body.' }] });
  assert.ok(Object.isFrozen(resolved), 'resolved seed must be frozen');
  assert.deepStrictEqual(resolveSeedManifest({}), { files: [] }, 'an empty manifest resolves to an empty list');
  assert.throws(() => resolveSeedManifest(null), /seed must be an object/);
  assert.throws(
    () => resolveSeedManifest({ files: [{ path: 'a.md', target: 'realm', source: { file: 'missing.md' } }] }),
    /not present in the bundle files/
  );
});

// ============================================================================
// 9. Purity
// ============================================================================

test('25. module sources stay pure with an explicit import surface', () => {
  const allowedSpecifiers = new Set([
    './freeze.ts',
    './errors.ts',
    './sha256.ts',
    './types.ts',
    './validation.ts',
    './version.ts',
    './transport.ts',
    './hydration.ts',
    './compose.ts',
    './materialize.ts',
    './capabilities.ts',
    './demo.ts',
    './bundles.ts',
    './content.generated.ts',
    '../tools/constants/index.ts',
    '../tools/normalizers/index.ts',
    '../domain/directorAgent/index.ts',
    '../runtime/agent/index.ts'
  ]);
  const forbidden = [
    { id: 'window', pattern: /\bwindow\b/ },
    { id: 'localStorage', pattern: /\blocalStorage\b/ },
    { id: 'sessionStorage', pattern: /\bsessionStorage\b/ },
    { id: 'fetch', pattern: /\bfetch\s*\(/ },
    { id: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
    { id: 'navigator', pattern: /\bnavigator\b/ }
  ];

  for (const file of MODULE_FILES) {
    const source = fs.readFileSync(path.join(MODULE_DIR, file), 'utf-8');
    for (const { id, pattern } of forbidden) {
      assert.ok(!pattern.test(source), `${file} must not reference ${id}`);
    }

    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const specifiers = [...code.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1]
    );
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('.'), `${file} has a non-relative import '${specifier}'`);
      assert.ok(
        allowedSpecifiers.has(specifier),
        `${file} imports '${specifier}' outside the declared module surface`
      );
    }
  }

  const indexSource = fs.readFileSync(path.join(MODULE_DIR, 'index.ts'), 'utf-8');
  const body = indexSource.replace(/\/\*\*[\s\S]*?\*\//g, '');
  const remainder = body
    .replace(/export\s+(?:type\s+)?\{[\s\S]*?\}\s*from\s*['"][^'"]+['"]\s*;/g, '')
    .trim();
  assert.strictEqual(remainder, '', `index.ts must only re-export, found: ${remainder}`);

  // The generated module is pure embedded data: the only code is the type
  // import, the version constant, and the bundle payload. Its payload text is
  // never regex-scanned as code because prompt content may contain arbitrary
  // words (the pipeline suite pins the generated-module shape separately).
  const generatedSource = fs.readFileSync(path.join(MODULE_DIR, 'content.generated.ts'), 'utf-8');
  assert.match(generatedSource, /GENERATED by/);
  assert.match(generatedSource, /never edit by hand\./);
  assert.match(generatedSource, /scripts\/embed_realm_content\.mjs/);
  assert.match(generatedSource, /^import type \{ BakedTemplateBundle \} from '\.\/types\.ts';$/m);
});

// ============================================================================
// 11. Baked bundles + generated content version
// ============================================================================

test('26. baked bundles: demo first, frozen generated bundles appended, lookup semantics', () => {
  assert.ok(Array.isArray(BAKED_TEMPLATE_BUNDLES), 'the baked catalog is a list');
  assert.ok(Object.isFrozen(BAKED_TEMPLATE_BUNDLES), 'the baked catalog is frozen');
  assert.ok(BAKED_TEMPLATE_BUNDLES.length >= 2, 'the demo fixture plus at least one generated bundle');
  assert.strictEqual(BAKED_TEMPLATE_BUNDLES[0].template, DEMO_TEMPLATE, 'the demo fixture is registered first');
  assert.deepStrictEqual(BAKED_TEMPLATE_BUNDLES[0].files, {}, 'the demo bundle ships no files');
  assert.ok(Object.isFrozen(BAKED_TEMPLATE_BUNDLES[0]), 'the demo bundle container is frozen');
  assert.ok(Object.isFrozen(BAKED_TEMPLATE_BUNDLES[0].files), 'the demo file map is frozen');

  assert.match(REALM_CONTENT_VERSION, /^sha256:[0-9a-f]{64}$/, 'the content version is a sha256 digest');

  const ids = BAKED_TEMPLATE_BUNDLES.map((bundle) => bundle.template.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'bundle ids stay unique');
  const generatedIds = ids.slice(1);
  assert.deepStrictEqual(
    [...generatedIds].sort(),
    generatedIds,
    'the generated bundles follow the demo fixture in sorted template id order'
  );

  for (const bundle of BAKED_TEMPLATE_BUNDLES) {
    assert.ok(Object.isFrozen(bundle.template), `${bundle.template.id}: template is deep-frozen`);
    assert.ok(Object.isFrozen(bundle.files), `${bundle.template.id}: file map is frozen`);
    for (const body of Object.values(bundle.files)) {
      assert.strictEqual(typeof body, 'string', `${bundle.template.id}: every bundle file body is a string`);
    }
  }

  for (const bundle of BAKED_TEMPLATE_BUNDLES) {
    assert.strictEqual(getBakedTemplateBundle(bundle.template.id), bundle, 'lookup returns the frozen constant');
  }
  assert.strictEqual(getBakedTemplateBundle('demo'), BAKED_TEMPLATE_BUNDLES[0]);
  assert.strictEqual(getBakedTemplateBundle('ghost'), null, 'unknown ids resolve to null');
  assert.strictEqual(getBakedTemplateBundle(''), null, 'blank ids resolve to null');
  assert.strictEqual(getBakedTemplateBundle('   '), null, 'whitespace ids resolve to null');
  assert.strictEqual(getBakedTemplateBundle(null), null, 'non-string ids resolve to null');
  assert.strictEqual(getBakedTemplateBundle(42), null, 'non-string ids resolve to null');
});

// ============================================================================
// 12. Format v1 schema
// ============================================================================

test('27. input origins default to user; generated inputs require a brief and reject prefills', () => {
  const accepted = [
    [{ id: 'a', label: 'A' }],
    [{ id: 'a', label: 'A', origin: 'user' }],
    [{ id: 'a', label: 'A', origin: 'user', brief: 'author hint' }],
    [{ id: 'a', label: 'A', origin: 'generated', brief: 'generate me' }],
    [{ id: 'a', label: 'A', default: 'draft-compatible' }]
  ];
  for (const inputs of accepted) {
    const plan = materializeTemplate(template({ inputs }), { realmId: 'r' });
    assert.strictEqual(plan.agents.length, 1, `must accept ${JSON.stringify(inputs)}`);
  }

  const cases = [
    [{ id: 'a', label: 'A', origin: 'fixed' }, /origin must be 'user' or 'generated'/],
    [{ id: 'a', label: 'A', origin: 'generated' }, /must declare a brief for a generated input/],
    [
      { id: 'a', label: 'A', origin: 'generated', brief: 'g', default: 'x' },
      /must not declare default or defaultFile for a generated input/
    ],
    [
      { id: 'a', label: 'A', origin: 'generated', brief: 'g', defaultFile: 'f.md' },
      /must not declare default or defaultFile for a generated input/
    ],
    [{ id: 'a', label: 'A', brief: '' }, /inputs\[0\] brief/]
  ];
  for (const [input, pattern] of cases) {
    assert.throws(
      () => materializeTemplate(template({ inputs: [input] }), { realmId: 'r' }),
      pattern,
      `must reject ${JSON.stringify(input)}`
    );
  }
});

test('28. seed slots: fixed requires a source; user/generated forbid one; generated requires a brief', () => {
  const fixedPlan = materializeTemplate(
    template({ seed: { files: [{ path: 'a.md', target: 'realm', source: { inline: 'x' } }] } }),
    { realmId: 'r' }
  );
  assert.strictEqual(fixedPlan.seed.files[0].content, 'x', 'an absent origin defaults to fixed with a source');

  const userPlan = materializeTemplate(
    template({ seed: { files: [{ path: 'a.md', target: 'realm', origin: 'user' }] } }),
    { realmId: 'r' }
  );
  assert.deepStrictEqual(userPlan.seed.files, [], 'an absent optional user slot is skipped');

  const generatedPlan = materializeTemplate(
    template({ seed: { files: [{ path: 'a.md', target: 'realm', origin: 'generated', brief: 'fill me' }] } }),
    { realmId: 'r', hydrationFiles: [{ path: 'a.md', target: 'realm', content: 'generated body' }] }
  );
  assert.strictEqual(generatedPlan.seed.files[0].content, 'generated body');

  const cases = [
    [
      { path: 'a.md', target: 'realm' },
      /must declare a source for a fixed seed slot/
    ],
    [
      { path: 'a.md', target: 'realm', origin: 'fixed' },
      /must declare a source for a fixed seed slot/
    ],
    [
      { path: 'a.md', target: 'realm', origin: 'user', source: { inline: 'x' } },
      /must not declare a source for a user seed slot/
    ],
    [
      { path: 'a.md', target: 'realm', origin: 'generated', brief: 'g', source: { inline: 'x' } },
      /must not declare a source for a generated seed slot/
    ],
    [
      { path: 'a.md', target: 'realm', origin: 'generated' },
      /must declare a brief for a generated seed slot/
    ],
    [
      { path: 'a.md', target: 'realm', origin: 'other', source: { inline: 'x' } },
      /origin must be 'fixed', 'user', or 'generated'/
    ],
    [
      { path: 'a.md', target: 'realm', origin: 'user', brief: '' },
      /files\[0\] brief/
    ]
  ];
  for (const [file, pattern] of cases) {
    assert.throws(
      () => materializeTemplate(template({ seed: { files: [file] } }), { realmId: 'r' }),
      pattern,
      `must reject ${JSON.stringify(file)}`
    );
  }
});

test('29. history entries validate as closed shapes and reference declared inputs', () => {
  const tpl = template({
    inputs: [{ id: 'opening', label: 'Opening', origin: 'generated', brief: 'opening scene' }],
    agents: [
      agentSpec({
        history: [
          { role: 'assistant', content: [{ kind: 'input', inputId: 'opening' }] },
          { role: 'user', content: [{ kind: 'text', text: 'Continue.' }] }
        ]
      })
    ]
  });
  const plan = materializeTemplate(tpl, { realmId: 'r', inputValues: { opening: 'Rain hammers the roof.' } });
  assert.deepStrictEqual(plan.agents[0].history, [
    { role: 'assistant', content: 'Rain hammers the roof.', source: 'template' },
    { role: 'user', content: 'Continue.', source: 'template' }
  ]);
  assert.ok(Object.isFrozen(plan.agents[0].history), 'plan history must be frozen');
  assert.ok(Object.isFrozen(plan.agents[0].history[0]), 'plan history entries must be frozen');

  const cases = [
    [agentSpec({ history: 'nope' }), /history must be an array of history entries/],
    [agentSpec({ history: [null] }), /history\[0\] must be an object/],
    [
      agentSpec({ history: [{ role: 'system', content: [{ kind: 'text', text: 'x' }] }] }),
      /history\[0\] role must be 'user' or 'assistant'/
    ],
    [
      agentSpec({ history: [{ role: 'user', content: [] }] }),
      /history\[0\] content must be a non-empty array of prompt parts/
    ],
    [
      agentSpec({ history: [{ role: 'user', content: [{ kind: 'input', inputId: 'ghost' }] }] }),
      /history references undeclared input 'ghost'/
    ],
    [
      agentSpec({ history: [{ role: 'user', content: [{ kind: 'text', text: 'x' }], extra: 1 }] }),
      /history\[0\] carries unknown field 'extra'/
    ],
    [
      agentSpec({ history: [{ role: 'user', content: [{ kind: 'wizard' }] }] }),
      /unknown prompt part kind 'wizard'/
    ]
  ];
  for (const [spec, pattern] of cases) {
    assert.throws(
      () => materializeTemplate(template({ agents: [spec] }), { realmId: 'r' }),
      pattern,
      `must reject ${JSON.stringify(spec.history)}`
    );
  }
});

test('30. composeAgentHistory composes parts in order, omits empty inputs, and rejects empty entries', () => {
  const spec = agentSpec({
    key: 'gm',
    history: [
      {
        role: 'assistant',
        content: [
          { kind: 'text', text: 'Opening.' },
          { kind: 'file', path: 'files/opener.md' },
          { kind: 'input', inputId: 'scene' },
          { kind: 'input', inputId: 'empty' }
        ]
      },
      { role: 'user', content: [{ kind: 'text', text: 'Begin.' }] }
    ]
  });
  const history = composeAgentHistory(spec, { scene: 'Rain.', empty: '   ' }, { 'files/opener.md': 'The door opens.' });
  assert.deepStrictEqual(history, [
    { role: 'assistant', content: 'Opening.\n\nThe door opens.\n\nRain.', source: 'template' },
    { role: 'user', content: 'Begin.', source: 'template' }
  ]);
  assert.ok(Object.isFrozen(history), 'composed history must be frozen');
  assert.ok(Object.isFrozen(history[0]), 'composed history entries must be frozen');
  assert.deepStrictEqual(
    composeAgentHistory(spec, { scene: 'Rain.', empty: '' }, { 'files/opener.md': 'The door opens.' }),
    history,
    'composition stays deterministic'
  );

  assert.deepStrictEqual(composeAgentHistory(agentSpec(), {}, {}), [], 'a history-less spec composes to nothing');

  assert.throws(
    () => composeAgentHistory(agentSpec({ history: [{ role: 'assistant', content: [{ kind: 'file', path: 'ghost.md' }] }] }), {}, {}),
    /references bundle file 'ghost\.md' which is not present/,
    'a missing history file fails closed'
  );
  assert.throws(
    () => composeAgentHistory(agentSpec({ history: [{ role: 'assistant', content: [{ kind: 'input', inputId: 'scene' }] }] }), {}, {}),
    /history\[0\] composes empty/,
    'an entry that composes empty is rejected'
  );
  assert.throws(
    () => composeAgentHistory(null, {}, {}),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID
      && /spec must be an object/.test(error.message)
  );
  assert.throws(() => composeAgentHistory(agentSpec(), 'nope', {}), /inputs must be a record/);
  assert.throws(() => composeAgentHistory(agentSpec(), {}, 'nope'), /files must be a record/);
  assert.throws(() => composeAgentHistory(agentSpec({ key: '' }), {}, {}), /spec key/);
});

test('31. materialized history resolves launch/default/defaultFile inputs like prompts do', () => {
  const tpl = template({
    inputs: [
      { id: 'scene', label: 'Scene', default: 'Default scene.' },
      { id: 'prefill', label: 'Prefill', defaultFile: 'inputs/prefill.md' }
    ],
    agents: [
      agentSpec({
        history: [
          { role: 'assistant', content: [{ kind: 'input', inputId: 'scene' }] },
          { role: 'user', content: [{ kind: 'input', inputId: 'prefill' }] }
        ]
      })
    ]
  });

  const plan = materializeTemplate(tpl, { realmId: 'r', bundleFiles: { 'inputs/prefill.md': 'Prefilled opener.' } });
  assert.deepStrictEqual(plan.agents[0].history, [
    { role: 'assistant', content: 'Default scene.', source: 'template' },
    { role: 'user', content: 'Prefilled opener.', source: 'template' }
  ]);

  const overridden = materializeTemplate(tpl, {
    realmId: 'r',
    inputValues: { scene: 'Launch scene.' },
    bundleFiles: { 'inputs/prefill.md': 'Prefilled opener.' }
  });
  assert.strictEqual(overridden.agents[0].history[0].content, 'Launch scene.');

  assert.throws(
    () => materializeTemplate(tpl, { realmId: 'r' }),
    /defaultFile 'inputs\/prefill\.md' is not present in the bundle files/,
    'a missing history defaultFile fails closed'
  );

  const missingHistoryFile = template({
    agents: [agentSpec({ history: [{ role: 'assistant', content: [{ kind: 'file', path: 'files/ghost.md' }] }] })]
  });
  assert.throws(
    () => materializeTemplate(missingHistoryFile, { realmId: 'r' }),
    /references bundle file 'files\/ghost\.md' which is not present/,
    'materialization resolves history file parts from bundle files'
  );
});

// ============================================================================
// 13. Tool contract / providers (accepted and validated, never resolved)
// ============================================================================

/**
 * Builds the consensus-test-shaped fixture used by the format-v1 tests.
 *
 * @param {object} [overrides] Template field overrides
 * @returns {object} Template literal
 */
function consensusTemplate(overrides = {}) {
  return {
    id: 'consensus_test',
    name: 'Consensus Test',
    description: 'fixture',
    formatVersion: 1,
    hydration: { brief: 'Invent a motion and the opposing stances.' },
    inputs: [
      { id: 'motion', label: 'Motion', origin: 'generated', brief: 'One falsifiable claim.', required: true },
      { id: 'rounds', label: 'Rounds', origin: 'user', default: '10' }
    ],
    agents: [
      {
        key: 'observer',
        idPattern: 'observer',
        name: 'Observer',
        role: 'scorer',
        prompt: [{ kind: 'text', text: 'Score each turn.' }, { kind: 'input', inputId: 'motion' }],
        toolProfile: { tools: ['read_message', 'list_inbox', 'text.similarity'] },
        privileged: false,
        history: [
          {
            role: 'assistant',
            content: [{ kind: 'text', text: 'The motion:' }, { kind: 'input', inputId: 'motion' }]
          }
        ]
      }
    ],
    seed: {
      files: [
        { path: 'scoreboard.ndjson', target: 'realm', origin: 'fixed', source: { inline: '' } },
        { path: 'lore/world.md', target: 'realm', origin: 'generated', brief: 'World lore.' },
        { path: 'notes/private.md', target: { agent: 'observer' }, origin: 'user', brief: 'Optional notes.' }
      ]
    },
    toolContract: {
      requirements: [
        {
          id: 'text.similarity',
          brief: '0..1 similarity between two texts',
          io: { in: { a: 'string', b: 'string' }, out: { score: 'number' } },
          required: true,
          range: '^1',
          prefer: ['acme/text-tools@^1']
        }
      ]
    },
    providers: [
      { kind: 'pack', id: 'acme/text-tools', range: '^1', source: 'https://example.com/acme-text-tools' },
      {
        kind: 'mcp',
        id: 'acme-scoring',
        transport: { kind: 'http', url: 'https://mcp.example.com' },
        provides: [{ capability: 'text.similarity', tool: 'similarity' }],
        authRef: 'acme_scoring_key'
      }
    ],
    ...overrides
  };
}

/**
 * Builds a hydration package for the consensus fixture.
 *
 * @param {string} templateVersion Version to pin
 * @param {object} [overrides] Package field overrides
 * @returns {object} Package literal
 */
function consensusPackage(templateVersion, overrides = {}) {
  return {
    formatVersion: 1,
    templateId: 'consensus_test',
    templateVersion,
    inputs: { motion: 'Open-weight models match closed models by 2027.', rounds: '5' },
    files: [{ path: 'lore/world.md', target: 'realm', content: 'World lore body.' }],
    provenance: { hydrator: 'hydration builtin', generatedAt: '2026-09-21T00:00:00Z', reviewedBy: 'owner' },
    ...overrides
  };
}

test('32. toolContract and providers are accepted and shape-validated, never resolved', () => {
  const tpl = consensusTemplate();
  const plan = materializeTemplate(tpl, {
    realmId: 'r',
    inputValues: { motion: 'A motion.', rounds: '5' },
    hydrationFiles: [{ path: 'lore/world.md', target: 'realm', content: 'Lore.' }]
  });
  assert.strictEqual(plan.agents[0].toolProfile.tools.includes('text.similarity'), true);
  assert.deepStrictEqual(
    plan.agents[0].history,
    [{ role: 'assistant', content: 'The motion:\n\nA motion.', source: 'template' }]
  );

  assert.strictEqual(templateRequiresProviders(tpl), true, 'requirements and providers gate launch');
  assert.strictEqual(templateRequiresProviders(DEMO_TEMPLATE), false);
  assert.strictEqual(
    templateRequiresProviders({ ...DEMO_TEMPLATE, toolContract: { requirements: [] }, providers: [] }),
    false,
    'empty contracts do not gate launch'
  );
  assert.strictEqual(
    templateRequiresProviders({ ...DEMO_TEMPLATE, providers: [{ kind: 'pack', id: 'acme/x' }] }),
    true
  );
  assert.strictEqual(templateRequiresProviders(null), false);
  assert.strictEqual(templateRequiresProviders(undefined), false);

  const invalid = [
    [template({ toolContract: 'nope' }), /toolContract must be an object/],
    [template({ toolContract: { extra: 1 } }), /unknown field 'extra'/],
    [template({ toolContract: { requirements: 'nope' } }), /requirements must be an array/],
    [template({ toolContract: { requirements: [{}] } }), /requirements\[0\] id/],
    [
      template({ toolContract: { requirements: [{ id: 'a', brief: '', io: { in: {}, out: {} } }] } }),
      /requirements\[0\] brief/
    ],
    [
      template({ toolContract: { requirements: [{ id: 'a', brief: 'b' }] } }),
      /requirements\[0\] io must be an object/
    ],
    [
      template({ toolContract: { requirements: [{ id: 'a', brief: 'b', io: { in: {} } }] } }),
      /requirements\[0\] io\.out must be a record/
    ],
    [
      template({ toolContract: { requirements: [{ id: 'a', brief: 'b', io: { in: {}, out: {} }, required: 'yes' }] } }),
      /requirements\[0\] required must be a boolean/
    ],
    [
      template({ toolContract: { requirements: [{ id: 'a', brief: 'b', io: { in: {}, out: {} }, prefer: 'x' }] } }),
      /requirements\[0\] prefer must be an array/
    ],
    [
      template({
        toolContract: {
          requirements: [
            { id: 'a', brief: 'b', io: { in: {}, out: {} } },
            { id: 'a', brief: 'c', io: { in: {}, out: {} } }
          ]
        }
      }),
      /duplicate requirement id 'a'/
    ],
    [template({ providers: 'nope' }), /providers must be an array/],
    [template({ providers: [{}] }), /kind must be 'pack' or 'mcp'/],
    [template({ providers: [{ kind: 'pack', id: 'no-slash' }] }), /must be a 'publisher\/name' pack identity/],
    [template({ providers: [{ kind: 'pack', id: 'acme/x', extra: 1 }] }), /unknown field 'extra'/],
    [template({ providers: [{ kind: 'mcp', id: 's' }] }), /transport must be an object/],
    [
      template({ providers: [{ kind: 'mcp', id: 's', transport: { kind: 'carrier-pigeon', url: 'x' } }] }),
      /transport kind must be 'http' or 'stdio'/
    ],
    [
      template({ providers: [{ kind: 'mcp', id: 's', transport: { kind: 'http', url: 'x', command: 'y' } }] }),
      /transport carries unknown field 'command'/
    ],
    [
      template({ providers: [{ kind: 'mcp', id: 's', transport: { kind: 'stdio', command: 'npx', args: 'x' } }] }),
      /transport args must be an array/
    ],
    [
      template({ providers: [{ kind: 'mcp', id: 's', transport: { kind: 'http', url: 'x' }, provides: [{}] }] }),
      /provides\[0\] capability/
    ],
    [
      template({ providers: [{ kind: 'mcp', id: 's', transport: { kind: 'http', url: 'x' }, authRef: '' }] }),
      /authRef/
    ]
  ];
  for (const [spec, pattern] of invalid) {
    assert.throws(() => materializeTemplate(spec, { realmId: 'r' }), pattern);
  }

  // Requirement ids are valid grants only when declared by the same template.
  const declared = template({
    agents: [agentSpec({ toolProfile: { tools: ['text.similarity'] } })],
    toolContract: {
      requirements: [{ id: 'text.similarity', brief: 'sim', io: { in: {}, out: {} } }]
    }
  });
  assert.strictEqual(materializeTemplate(declared, { realmId: 'r' }).agents[0].toolProfile.tools[0], 'text.similarity');
  assert.throws(
    () => materializeTemplate(template({ agents: [agentSpec({ toolProfile: { tools: ['text.similarity'] } })] }), { realmId: 'r' }),
    /neither a canonical tool name nor a declared toolContract requirement id/
  );
});

// ============================================================================
// 14. Per-bundle versioning (canonical byte stream)
// ============================================================================

/**
 * Independently reproduces the canonical version stream and hash from the spec
 * rules (sorted keys, referenced files in path order, UTF-8 byte framing).
 *
 * @param {{ template: object, files: Record<string, string> }} bundle Bundle to version
 * @returns {string} Expected `sha256:<hex>` version
 */
function independentBundleVersion(bundle) {
  const sortKeys = (value) => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
    }
    return value;
  };
  const references = new Set();
  const addParts = (parts) => {
    for (const part of parts) {
      if (part.kind === 'file') references.add(part.path);
    }
  };
  for (const agent of bundle.template.agents) {
    addParts(agent.prompt);
    for (const entry of agent.history ?? []) addParts(entry.content);
  }
  for (const input of bundle.template.inputs ?? []) {
    if (input.defaultFile !== undefined) references.add(input.defaultFile);
  }
  for (const file of bundle.template.seed?.files ?? []) {
    if ((file.origin ?? 'fixed') === 'fixed' && file.source !== undefined && 'file' in file.source) {
      references.add(file.source.file);
    }
  }
  let stream = JSON.stringify(sortKeys(bundle.template));
  for (const path of [...references].sort()) {
    const content = bundle.files[path];
    stream += `${Buffer.byteLength(path, 'utf8')}:${path}\n${Buffer.byteLength(content, 'utf8')}:${content}`;
  }
  return `sha256:${createHash('sha256').update(stream, 'utf8').digest('hex')}`;
}

test('33. templateBundleVersion is canonical, deterministic, and identical for baked and imported bundles', () => {
  const baked = getBakedTemplateBundle('example_agent');
  const bakedVersion = templateBundleVersion(baked);
  assert.match(bakedVersion, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(bakedVersion, independentBundleVersion(baked), 'matches the spec-defined byte stream');
  assert.strictEqual(templateBundleVersion(baked), bakedVersion, 'deterministic across calls');
  assert.strictEqual(
    templateBundleVersion(JSON.parse(JSON.stringify(baked))),
    bakedVersion,
    'a JSON-imported copy hashes identically'
  );

  const fixture = {
    template: template({
      id: 'versioned',
      inputs: [{ id: 'prefill', label: 'Prefill', defaultFile: 'inputs/prefill.md' }],
      agents: [
        agentSpec({
          prompt: [{ kind: 'file', path: 'prompts/protocol.md' }, { kind: 'input', inputId: 'prefill' }],
          history: [{ role: 'assistant', content: [{ kind: 'file', path: 'files/opener.md' }] }]
        })
      ],
      seed: { files: [{ path: 'notes.md', target: 'realm', source: { file: 'files/notes.md' } }] }
    }),
    files: {
      'files/notes.md': 'notes é–“漢字',
      'files/opener.md': 'opener 🎭',
      'inputs/prefill.md': 'prefill',
      'prompts/protocol.md': 'protocol',
      'files/unreferenced.md': 'never referenced'
    }
  };
  const fixtureVersion = templateBundleVersion(fixture);
  assert.strictEqual(fixtureVersion, independentBundleVersion(fixture), 'UTF-8 framing matches the independent stream');
  assert.strictEqual(
    templateBundleVersion(JSON.parse(JSON.stringify(fixture))),
    fixtureVersion,
    'round-tripped fixture hashes identically'
  );

  const unreferencedChanged = { template: fixture.template, files: { ...fixture.files, 'files/unreferenced.md': 'changed' } };
  assert.strictEqual(
    templateBundleVersion(unreferencedChanged),
    fixtureVersion,
    'only referenced bundle files participate in the version'
  );
  const referencedChanged = { template: fixture.template, files: { ...fixture.files, 'files/opener.md': 'changed' } };
  assert.notStrictEqual(templateBundleVersion(referencedChanged), fixtureVersion, 'a referenced file changes the version');
  const specChanged = { template: { ...fixture.template, name: 'Renamed' }, files: fixture.files };
  assert.notStrictEqual(templateBundleVersion(specChanged), fixtureVersion, 'a spec change changes the version');

  assert.throws(
    () => templateBundleVersion({ template: fixture.template, files: { 'prompts/protocol.md': 'protocol' } }),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID
      && /bundle references file/.test(error.message),
    'a missing referenced file fails closed'
  );
  assert.throws(
    () => templateBundleVersion({ template: fixture.template, files: { 'a\0b': 'x' } }),
    /bundle file path/
  );
  assert.throws(
    () => templateBundleVersion({ template: fixture.template, files: { 'a.md': 7 } }),
    /must be a string/
  );
  assert.throws(() => templateBundleVersion(null), /template bundle must be an object/);
});

// ============================================================================
// 15. Transport parse/serialize
// ============================================================================

test('34. parseTemplateBundle and serializeTemplateBundle round-trip canonically with typed errors', () => {
  const bundle = {
    template: consensusTemplate(),
    files: {}
  };
  const serialized = serializeTemplateBundle(bundle);
  assert.strictEqual(serialized, JSON.stringify(JSON.parse(serialized)), 'canonical output is compact and stable');
  assert.ok(serialized.startsWith('{"files":'), 'object keys are recursively sorted (files before formatVersion)');

  const parsed = parseTemplateBundle(serialized);
  assert.strictEqual(parsed.template.id, 'consensus_test');
  assert.strictEqual(parsed.version, templateBundleVersion(bundle));
  assert.deepStrictEqual(parsed.warnings, []);
  assert.ok(Object.isFrozen(parsed), 'parsed bundle is frozen');
  assert.ok(Object.isFrozen(parsed.template), 'parsed template is frozen');
  assert.ok(Object.isFrozen(parsed.files), 'parsed files are frozen');
  assert.ok(Object.isFrozen(parsed.warnings), 'parsed warnings are frozen');
  assert.strictEqual(serializeTemplateBundle(parsed), serialized, 're-serializing a parsed bundle is byte-stable');
  assert.strictEqual(
    parseTemplateBundle(serializeTemplateBundle(parseTemplateBundle(serialized))).version,
    parsed.version,
    'parse → serialize → parse is version-stable'
  );

  const fromObject = parseTemplateBundle({ formatVersion: 1, template: consensusTemplate(), files: {} });
  assert.strictEqual(fromObject.version, parsed.version, 'object input parses identically to text input');

  const typed = (fn, code, pattern) => assert.throws(
    fn,
    (error) => error instanceof RealmCatalogError && error.code === code && pattern.test(error.message),
    `expected ${code} matching ${pattern}`
  );
  typed(
    () => parseTemplateBundle('{ not json'),
    REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT,
    /not valid JSON/
  );
  typed(
    () => parseTemplateBundle(null),
    REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT,
    /must be an object/
  );
  typed(
    () => parseTemplateBundle({ formatVersion: 1, template: consensusTemplate(), files: {}, extra: 1 }),
    REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT,
    /carries unknown field 'extra'/
  );
  typed(
    () => parseTemplateBundle({ formatVersion: 2, template: consensusTemplate(), files: {} }),
    REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT,
    /formatVersion must be 1/
  );
  typed(
    () => parseTemplateBundle({ formatVersion: 1, template: consensusTemplate() }),
    REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT,
    /must carry both template and files/
  );
  typed(
    () => parseTemplateBundle({ formatVersion: 1, template: { ...consensusTemplate(), extra: 1 }, files: {} }),
    REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID,
    /unknown field 'extra'/
  );
  typed(
    () => parseTemplateBundle({ formatVersion: 1, template: consensusTemplate(), files: { 'a.md': 7 } }),
    REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID,
    /must be a string/
  );
  typed(
    () => parseTemplateBundle({ formatVersion: 1, template: consensusTemplate(), files: { '../escape.md': 'x' } }),
    REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID,
    /must not contain '\.\.'/
  );
});

// ============================================================================
// 16. Hydration packages
// ============================================================================

test('35. validateHydrationPackage matches slots by path+target and enforces the version policy', () => {
  const tpl = consensusTemplate();
  const version = templateBundleVersion({ template: tpl, files: {} });

  const resolved = validateHydrationPackage(tpl, consensusPackage(version), { currentVersion: version });
  assert.strictEqual(resolved.templateId, 'consensus_test');
  assert.strictEqual(resolved.templateVersion, version);
  assert.deepStrictEqual(resolved.inputValues, { motion: 'Open-weight models match closed models by 2027.', rounds: '5' });
  assert.deepStrictEqual(resolved.files, [{ path: 'lore/world.md', target: 'realm', content: 'World lore body.' }]);
  assert.deepStrictEqual(resolved.warnings, []);
  assert.ok(Object.isFrozen(resolved), 'resolved hydration is frozen');
  assert.ok(Object.isFrozen(resolved.files), 'resolved files are frozen');
  assert.ok(Object.isFrozen(resolved.inputValues), 'resolved input values are frozen');

  const withUserSlot = validateHydrationPackage(
    tpl,
    consensusPackage(version, {
      files: [
        { path: 'lore/world.md', target: 'realm', content: 'World lore body.' },
        { path: 'notes/private.md', target: { agent: 'observer' }, content: 'Private notes.' }
      ]
    }),
    { currentVersion: version }
  );
  assert.deepStrictEqual(
    withUserSlot.files.map((file) => file.path),
    ['lore/world.md', 'notes/private.md'],
    'package entry order is preserved'
  );

  const noCheck = validateHydrationPackage(tpl, consensusPackage('sha256:other'), {});
  assert.deepStrictEqual(noCheck.warnings, [], 'without currentVersion there is nothing to compare');

  assert.throws(
    () => validateHydrationPackage(tpl, consensusPackage('sha256:deadbeef'), { currentVersion: version }),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_VERSION_MISMATCH
      && /pins template version/.test(error.message),
    'a disallowed mismatch fails closed with a typed error'
  );
  const allowed = validateHydrationPackage(tpl, consensusPackage('sha256:deadbeef'), {
    currentVersion: version,
    allowVersionMismatch: true
  });
  assert.strictEqual(allowed.warnings.length, 1);
  assert.match(allowed.warnings[0], /sha256:deadbeef/);
  assert.match(allowed.warnings[0], /explicitly allowed/);

  const cases = [
    [
      consensusPackage(version, { files: [{ path: 'ghost.md', target: 'realm', content: 'x' }] }),
      /does not match any declared seed slot/
    ],
    [
      consensusPackage(version, { files: [{ path: 'scoreboard.ndjson', target: 'realm', content: 'x' }] }),
      /targets fixed seed slot/
    ],
    [
      consensusPackage(version, {
        files: [
          { path: 'lore/world.md', target: 'realm', content: 'a' },
          { path: 'lore/world.md', target: 'realm', content: 'b' }
        ]
      }),
      /duplicates the entry/
    ],
    [consensusPackage(version, { files: [] }), /missing the required generated seed slot 'lore\/world\.md'/],
    [consensusPackage(version, { inputs: { ghost: 'x' } }), /names undeclared input 'ghost'/],
    [consensusPackage(version, { inputs: { motion: 7 } }), /inputs\['motion'\] must be a string/],
    [consensusPackage(version, { templateId: 'other' }), /targets template 'other'/],
    [consensusPackage(version, { formatVersion: 2 }), /formatVersion must be 1/],
    [consensusPackage(version, { extra: 1 }), /hydration package carries unknown field 'extra'/],
    [consensusPackage(version, { provenance: { extra: 1 } }), /provenance carries unknown field 'extra'/],
    [consensusPackage(version, { provenance: { hydrator: 7 } }), /provenance hydrator/],
    [
      consensusPackage(version, { files: [{ path: 'lore/world.md', target: { agent: 'ghost' }, content: 'x' }] }),
      /unknown template agent key 'ghost'/
    ],
    [
      consensusPackage(version, { files: [{ path: 'lore/world.md', target: 'realm', content: 7 }] }),
      /content must be a string/
    ],
    [
      consensusPackage(version, { files: [{ path: 'lore/world.md', target: 'realm', content: 'x', extra: 1 }] }),
      /files\[0\] carries unknown field 'extra'/
    ]
  ];
  for (const [pkg, pattern] of cases) {
    assert.throws(
      () => validateHydrationPackage(tpl, pkg, { currentVersion: version }),
      pattern,
      `must reject ${JSON.stringify(pkg).slice(0, 120)}`
    );
  }

  assert.throws(() => validateHydrationPackage(tpl, null, {}), /package must be an object/);
  assert.throws(
    () => validateHydrationPackage(tpl, consensusPackage(version), { currentVersion: version, extra: 1 }),
    /options carries unknown field 'extra'/
  );
  assert.throws(
    () => validateHydrationPackage({ ...tpl, extra: 1 }, consensusPackage(version), {}),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID,
    'an invalid template is a typed template error'
  );
});

// ============================================================================
// 17. Origin-aware materialization
// ============================================================================

test('36. materialization resolves seed origins and composes the hydrated instance', () => {
  const tpl = consensusTemplate();
  const version = templateBundleVersion({ template: tpl, files: {} });
  const pkg = validateHydrationPackage(tpl, consensusPackage(version), { currentVersion: version });

  const plan = materializeTemplate(tpl, {
    realmId: 'realm_consensus',
    inputValues: pkg.inputValues,
    hydrationFiles: pkg.files
  });
  assert.deepStrictEqual(
    plan.seed.files.map((file) => [file.path, file.content]),
    [
      ['scoreboard.ndjson', ''],
      ['lore/world.md', 'World lore body.']
    ],
    'fixed and generated slots resolve; the absent optional user slot is skipped'
  );
  assert.deepStrictEqual(plan.agents[0].history, [
    {
      role: 'assistant',
      content: 'The motion:\n\nOpen-weight models match closed models by 2027.',
      source: 'template'
    }
  ]);
  assert.deepStrictEqual(plan.agents[0].toolProfile.tools, ['read_message', 'list_inbox', 'text.similarity']);
  assert.ok(Object.isFrozen(plan.seed), 'resolved seed is frozen');
  assert.ok(Object.isFrozen(plan.agents[0].history), 'plan history is frozen');
  assert.strictEqual(templateRequiresProviders(tpl), true, 'the store launch gate must block this template');

  const withUserSlot = materializeTemplate(tpl, {
    realmId: 'realm_consensus',
    inputValues: pkg.inputValues,
    hydrationFiles: [
      ...pkg.files,
      { path: 'notes/private.md', target: { agent: 'observer' }, content: 'Private notes.' }
    ]
  });
  assert.deepStrictEqual(
    withUserSlot.seed.files.map((file) => file.path),
    ['scoreboard.ndjson', 'lore/world.md', 'notes/private.md'],
    'a present user slot is written in declared order'
  );

  assert.throws(
    () => materializeTemplate(tpl, { realmId: 'r', inputValues: pkg.inputValues }),
    /seed slot 'lore\/world\.md' is generated but no hydration file was supplied/,
    'a missing generated slot fails closed'
  );
  assert.throws(
    () => materializeTemplate(tpl, {
      realmId: 'r',
      inputValues: pkg.inputValues,
      hydrationFiles: [{ path: 'ghost.md', target: 'realm', content: 'x' }]
    }),
    /does not match any declared seed slot/
  );
  assert.throws(
    () => materializeTemplate(tpl, {
      realmId: 'r',
      inputValues: pkg.inputValues,
      hydrationFiles: [{ path: 'scoreboard.ndjson', target: 'realm', content: 'x' }]
    }),
    /targets a fixed seed slot/
  );
  assert.throws(
    () => materializeTemplate(tpl, {
      realmId: 'r',
      inputValues: pkg.inputValues,
      hydrationFiles: [
        { path: 'lore/world.md', target: 'realm', content: 'a' },
        { path: 'lore/world.md', target: 'realm', content: 'b' }
      ]
    }),
    /duplicate the entry/
  );
  assert.throws(
    () => materializeTemplate(tpl, { realmId: 'r', inputValues: pkg.inputValues, hydrationFiles: 'nope' }),
    /must be an array of hydration file entries/
  );
  assert.throws(
    () => materializeTemplate(tpl, {
      realmId: 'r',
      inputValues: pkg.inputValues,
      hydrationFiles: [{ path: 'a.md', target: 'realm' }]
    }),
    /content must be a string/
  );

  // The standalone resolver applies the same origin rules.
  assert.deepStrictEqual(
    resolveSeedManifest(tpl.seed, { hydrationFiles: pkg.files }).files.map((file) => file.path),
    ['scoreboard.ndjson', 'lore/world.md']
  );
  assert.throws(
    () => resolveSeedManifest(tpl.seed, {}),
    /generated but no hydration file was supplied/
  );
});

// ============================================================================
// 18. Content hashing
// ============================================================================

test('37. hashText returns sha256:<hex> over UTF-8 bytes with known vectors', () => {
  assert.strictEqual(
    hashText(''),
    'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'the empty-string vector'
  );
  assert.strictEqual(
    hashText('abc'),
    'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'the FIPS 180-4 abc vector'
  );

  const unicode = 'é–“…” 漢字 🎭';
  assert.strictEqual(
    hashText(unicode),
    `sha256:${createHash('sha256').update(unicode, 'utf8').digest('hex')}`,
    'unicode hashes over UTF-8 bytes (matches node:crypto)'
  );
  assert.match(hashText('anything'), /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(hashText('abc'), hashText('abc'), 'hashing is deterministic');
  assert.notStrictEqual(hashText('abc'), hashText('abd'));

  assert.throws(() => hashText(null), /text must be a string/);
  assert.throws(() => hashText(42), /text must be a string/);
  assert.throws(() => hashText(undefined), /text must be a string/);
});

// ============================================================================
// 19. Hostile-name hardening (T-V findings)
// ============================================================================

test('38. reserved property names are rejected wherever a template string keys an object (F1 e4c8f91)', () => {
  const reserved = ['__proto__', 'constructor', 'prototype'];
  for (const name of reserved) {
    assert.throws(
      () => materializeTemplate(template({ inputs: [{ id: name, label: 'P' }] }), { realmId: 'r' }),
      /reserved property name/,
      `input id '${name}' must be rejected`
    );
    assert.throws(
      () => materializeTemplate(template({ agents: [agentSpec({ key: name })] }), { realmId: 'r' }),
      /reserved property name/,
      `agent key '${name}' must be rejected`
    );
    assert.throws(
      () => materializeTemplate(
        template({ toolContract: { requirements: [{ id: name, brief: 'b', io: { in: {}, out: {} } }] } }),
        { realmId: 'r' }
      ),
      /reserved property name/,
      `requirement id '${name}' must be rejected`
    );
    assert.throws(
      () => materializeTemplate(
        template({ seed: { files: [{ path: name, target: 'realm', source: { inline: 'x' } }] } }),
        { realmId: 'r' }
      ),
      /reserved property name/,
      `seed path '${name}' must be rejected`
    );
    assert.throws(
      () => materializeTemplate(
        template({ agents: [agentSpec({ prompt: [{ kind: 'file', path: `files/${name}` }] })] }),
        { realmId: 'r', bundleFiles: { [`files/${name}`]: 'body' } }
      ),
      /reserved property name/,
      `bundle path segment '${name}' must be rejected`
    );
  }

  // A reserved input id cannot be smuggled in through a hydration package: the
  // owning template is rejected before package slot/input matching runs.
  assert.throws(
    () => validateHydrationPackage(
      template({ inputs: [{ id: '__proto__', label: 'P' }] }),
      { formatVersion: 1, templateId: 'tpl', templateVersion: 'sha256:x', inputs: {}, files: [] },
      {}
    ),
    /reserved property name/,
    'the owning template is rejected before package validation'
  );

  // Safe names keep working, and a normal record read never falls through to
  // the prototype chain for an undeclared override.
  const plan = materializeTemplate(template({ agents: [agentSpec()] }), { realmId: 'r' });
  assert.strictEqual(plan.agents[0].agentId, 'agent');
});

test('39. duplicate path+target seed slots are rejected at validation (F3 dc2aa0c)', () => {
  assert.throws(
    () => materializeTemplate(
      template({
        seed: {
          files: [
            { path: 'notes.md', target: 'realm', source: { inline: 'a' } },
            { path: 'notes.md', target: 'realm', source: { inline: 'b' } }
          ]
        }
      }),
      { realmId: 'r' }
    ),
    /duplicate seed slot 'notes\.md'/,
    'two slots with the same path and target are rejected'
  );
  assert.throws(
    () => parseTemplateBundle({
      formatVersion: 1,
      template: template({
        seed: {
          files: [
            { path: 'a.md', target: 'realm', origin: 'generated', brief: 'g' },
            { path: 'a.md', target: 'realm', origin: 'user', brief: 'u' }
          ]
        }
      }),
      files: {}
    }),
    /duplicate seed slot 'a\.md'/,
    'the transport parser rejects the duplicate too'
  );

  // The same path in a different workspace is a distinct slot.
  const plan = materializeTemplate(
    template({
      seed: {
        files: [
          { path: 'a.md', target: 'realm', source: { inline: 'realm copy' } },
          { path: 'a.md', target: { agent: 'agent' }, source: { inline: 'private copy' } }
        ]
      }
    }),
    { realmId: 'r' }
  );
  assert.deepStrictEqual(
    plan.seed.files.map((file) => [file.path, file.target]),
    [['a.md', 'realm'], ['a.md', { agent: 'agent' }]]
  );
});

// ============================================================================
// 19. Wave U declared authorities (ticket 2518510)
// ============================================================================

/**
 * Builds a minimal format-v1 template with one agent and an optional
 * authorities declaration.
 *
 * @param {string[]|undefined} authorities - Declared authority ids.
 * @returns {object} Template spec.
 */
function authorityTemplate(authorities) {
  return {
    formatVersion: 1,
    id: 'wave-u-authorities',
    name: 'Authorities',
    description: '',
    agents: [{
      key: 'architect',
      idPattern: 'wave-u-architect',
      name: 'Architect',
      role: 'author',
      prompt: [{ kind: 'text', text: 'Author.' }],
      toolProfile: { tools: [] },
      privileged: false,
      ...(authorities !== undefined ? { authorities } : {})
    }]
  };
}

test('19a. authority vocabulary is frozen and lists the v1 known set', () => {
  assert.ok(Object.isFrozen(AGENT_AUTHORITIES));
  assert.ok(Object.isFrozen(KNOWN_AGENT_AUTHORITIES));
  assert.deepStrictEqual([...KNOWN_AGENT_AUTHORITIES], ['@template:authority', '@hydration:authority']);
  assert.strictEqual(AGENT_AUTHORITIES.TEMPLATE, '@template:authority');
  assert.strictEqual(AGENT_AUTHORITIES.HYDRATION, '@hydration:authority');
});

test('19b. authorities shape: unique non-empty strings, duplicates rejected, unknown ids accepted', () => {
  const declared = parseTemplateBundle(
    serializeTemplateBundle({ template: authorityTemplate(['@template:authority', '@future:authority']), files: {} })
  );
  assert.deepStrictEqual(
    declared.template.agents[0].authorities,
    ['@template:authority', '@future:authority'],
    'unknown identifiers are accepted by validation'
  );

  assert.throws(
    () => parseTemplateBundle(serializeTemplateBundle({
      template: authorityTemplate(['@template:authority', '@template:authority']),
      files: {}
    })),
    /duplicate authority/,
    'duplicate declarations are rejected'
  );
  assert.throws(
    () => parseTemplateBundle(serializeTemplateBundle({ template: authorityTemplate(['']), files: {} })),
    /must be a non-empty string/,
    'empty identifiers are rejected'
  );
  assert.throws(
    () => parseTemplateBundle(serializeTemplateBundle({ template: authorityTemplate('nope'), files: {} })),
    /must be an array/,
    'a non-array declaration is rejected'
  );
  assert.throws(
    () => parseTemplateBundle(serializeTemplateBundle({
      template: {
        ...authorityTemplate(),
        agents: [{ ...authorityTemplate().agents[0], authority: ['@template:authority'] }]
      },
      files: {}
    })),
    /unknown field 'authority'/,
    'the closed shape rejects the singular typo'
  );
});

test('19c. materialization copies declarations onto the plan (empty default) and freezes them', () => {
  const withDeclarations = materializeTemplate(
    authorityTemplate(['@template:authority']),
    { realmId: 'r' }
  );
  assert.deepStrictEqual(withDeclarations.agents[0].authorities, ['@template:authority']);
  assert.ok(Object.isFrozen(withDeclarations.agents[0].authorities));

  const without = materializeTemplate(authorityTemplate(), { realmId: 'r' });
  assert.deepStrictEqual(without.agents[0].authorities, []);
});

test('19d. templateUnsupportedAuthorities reports declared-but-unknown ids once, in declaration order', () => {
  assert.deepStrictEqual(templateUnsupportedAuthorities(null), []);
  assert.deepStrictEqual(templateUnsupportedAuthorities({ agents: [] }), []);
  assert.deepStrictEqual(
    templateUnsupportedAuthorities(authorityTemplate(['@template:authority', '@hydration:authority'])),
    []
  );
  const template = authorityTemplate(['@future:b', '@future:a', '@future:b', '@template:authority']);
  assert.deepStrictEqual(templateUnsupportedAuthorities(template), ['@future:b', '@future:a']);
});

test('19e. the canonical templateVersion covers the authorities field', () => {
  const first = serializeTemplateBundle({
    template: authorityTemplate(['@template:authority']),
    files: {}
  });
  const second = serializeTemplateBundle({
    template: authorityTemplate(['@hydration:authority']),
    files: {}
  });
  const none = serializeTemplateBundle({ template: authorityTemplate(), files: {} });
  assert.notStrictEqual(
    templateBundleVersion(JSON.parse(first)),
    templateBundleVersion(JSON.parse(second)),
    'different authority ids hash differently'
  );
  assert.notStrictEqual(
    templateBundleVersion(JSON.parse(first)),
    templateBundleVersion(JSON.parse(none)),
    'declaring an authority changes the content version'
  );
});
