/**
 * @file tests/unit/realm_catalog_v2_module_test.js
 * @description Isolated unit suite for the `realmCatalog` canonical surface
 * (decision ticket 2ba3008): the v2 template/input/placement/directive schema
 * and its totality validation, v2 composition (positioned prompt/history
 * injection, fileset selection, placements, directives), payload validation
 * and its canonical digest, canonical bundle versioning in either authored
 * format, v2 transport parse/serialize, v2 materialization, and the format-v1
 * read shim (template conversion + legacy package conversion).
 *
 * Contract coverage:
 *  1. Runtime surface exports the v2 helpers.
 *  2. v2 schema validation: closed shapes, input shape rules, placement and
 *     directive rules, target/path safety, totality.
 *  3. Composition: declared order, blank-line separator, text and fileset
 *     injection, required/optional semantics, provenance, no caps.
 *  4. Baked history composition through the same part model.
 *  5. Placement resolution: file sources, text values, fileset roots and
 *     single-file paths, destination collisions.
 *  6. Directive resolution: literal and input-driven messages.
 *  7. Payload validation: required coverage, unknown/shape rejection, fileset
 *     rules, pin policy, typed errors, canonical digest.
 *  8. The v1 read shim: template conversion (seed → placements/directives,
 *     origins → required, hydration brief), legacy package conversion, and
 *     authored-form pins preserved through the v2 transport.
 *  9. Versioning and transport: v2 canonical byte stream, v1 parity, parse /
 *     serialize round-trips, closed envelopes, frozen output.
 * 10. Materialization: v2 plans (placements/directives/agents), id overrides,
 *     demo and legacy fixtures.
 * 11. Capability summaries and provider/authority gates accept v2 specs.
 * 12. Gap matrix: totality reference permutations, v2-only path/reserved-name
 *     surfaces, directive target/requiredness details, per-target placement
 *     destinations and root/file collisions, fileset-selection edges, payload
 *     provenance shapes, authored-format versioning, and v1-shim version
 *     pinning end to end.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import * as RealmCatalogModule from '../../src/lib/sandbox/realmCatalog/index.ts';
import {
  REALM_CATALOG_ERROR_CODES,
  RealmCatalogError,
  composeAgentHistory,
  composeSystemPrompt,
  materializeTemplate,
  normalizeTemplate,
  parseTemplateBundle,
  payloadDigest,
  resolveDirectives,
  resolvePlacements,
  serializeTemplateBundle,
  summarizeAgentCapabilities,
  templateBundleVersion,
  templateRequiresProviders,
  validatePayload,
  validateTemplate
} from '../../src/lib/sandbox/realmCatalog/index.ts';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * Builds a valid format-v2 agent spec.
 *
 * @param {object} [overrides] Spec field overrides
 * @returns {object} Agent spec literal
 */
function agentV2(overrides = {}) {
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
 * Builds a valid format-v2 template.
 *
 * @param {object} [overrides] Template field overrides
 * @returns {object} Template literal
 */
function templateV2(overrides = {}) {
  return {
    id: 'tpl2',
    name: 'Template V2',
    description: 'fixture',
    formatVersion: 2,
    agents: [agentV2()],
    ...overrides
  };
}

/**
 * Wraps a fileset in a shape-tagged composition value.
 *
 * @param {Array<{path: string, content: string}>} files Fileset entries
 * @returns {{shape: 'files', files: Array<{path: string, content: string}>}} Tagged value
 */
function filesValue(files) {
  return { shape: 'files', files };
}

/**
 * Builds a valid legacy format-v1 template exercising every origin path.
 *
 * @returns {object} v1 template literal
 */
function legacyTemplate() {
  return {
    formatVersion: 1,
    id: 'legacy',
    name: 'Legacy',
    description: 'legacy fixture',
    hydration: { brief: 'Hydrate carefully.' },
    inputs: [
      { id: 'assignment', label: 'Assignment', required: true },
      { id: 'generated_note', label: 'Note', origin: 'generated', brief: 'Write the note.' }
    ],
    agents: [
      agentV2({
        prompt: [
          { kind: 'file', path: 'prompts/p.md' },
          { kind: 'input', inputId: 'assignment' },
          { kind: 'input', inputId: 'generated_note' }
        ]
      })
    ],
    seed: {
      files: [
        { path: 'handoff/README.md', target: 'realm', origin: 'fixed', source: { file: 'files/readme.md' } },
        { path: 'brief.md', target: { agent: 'agent' }, origin: 'fixed', source: { inline: 'Inline body.' } },
        { path: 'notes.md', target: 'realm', origin: 'user', brief: 'Optional notes.' },
        { path: 'lore/deep.md', target: { agent: 'agent' }, origin: 'generated', brief: 'Generate lore.' }
      ],
      directive: { targetAgentKey: 'agent', text: 'Begin.' }
    }
  };
}

/** Legacy bundle files used by the shim tests. */
const LEGACY_FILES = { 'prompts/p.md': 'Protocol.', 'files/readme.md': 'Readme.' };

// ============================================================================
// 1. Runtime surface
// ============================================================================

test('1. runtime surface exports the canonical helpers', () => {
  for (const name of [
    'normalizeTemplate',
    'validateTemplate',
    'materializeTemplate',
    'composeSystemPrompt',
    'composeAgentHistory',
    'resolvePlacements',
    'resolveDirectives',
    'validatePayload',
    'payloadDigest',
    'parseTemplateBundle',
    'serializeTemplateBundle',
    'templateBundleVersion',
    'summarizeAgentCapabilities'
  ]) {
    assert.strictEqual(typeof RealmCatalogModule[name], 'function', `${name} must be exported`);
  }
});

// ============================================================================
// 2. v2 schema validation
// ============================================================================

test('2. a minimal v2 template validates and returns the same reference', () => {
  const fixture = templateV2();
  assert.strictEqual(validateTemplate(fixture), fixture);
});

test('3. v2 totality: an unreferenced input is a template error', () => {
  assert.throws(
    () => validateTemplate(templateV2({ inputs: [{ id: 'orphan', label: 'Orphan', shape: 'text' }] })),
    /never referenced/
  );
});

test('4. v2 totality: every reference surface counts and must resolve', () => {
  const fixture = templateV2({
    inputs: [{ id: 'style', label: 'Style', shape: 'text' }],
    placements: [{ inputId: 'style', target: 'realm', path: 'style.md' }]
  });
  assert.strictEqual(validateTemplate(fixture), fixture);

  assert.throws(
    () => validateTemplate(templateV2({ inputs: [{ id: 'style', label: 'Style', shape: 'text' }] })),
    /never referenced/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'missing' }] })]
    })),
    /references undeclared input 'missing'/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      agents: [agentV2({
        history: [{ role: 'user', content: [{ kind: 'input', inputId: 'missing' }] }]
      })]
    })),
    /references undeclared input 'missing'/
  );
  assert.throws(
    () => validateTemplate(templateV2({ placements: [{ inputId: 'missing', target: 'realm', path: 'a.md' }] })),
    /references undeclared input 'missing'/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      directives: [{ inputId: 'missing', target: { agent: 'agent' } }]
    })),
    /references undeclared input 'missing'/
  );
});

test('5. v2 input-part shape rules: files requires a path and text forbids one', () => {
  const filesInput = { id: 'lore', label: 'Lore', shape: 'files' };
  assert.strictEqual(
    validateTemplate(templateV2({
      inputs: [filesInput],
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'lore', path: 'index.md' }] })]
    })).inputs[0].shape,
    'files'
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [filesInput],
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'lore' }] })]
    })),
    /without a file selection path/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [{ id: 'style', label: 'Style', shape: 'text' }],
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'style', path: 'a.md' }] })]
    })),
    /"path" is only meaningful for files inputs/
  );
});

test('6. v2 input shape rules reject text-only fields on files inputs', () => {
  const filesInput = (overrides) => ({
    id: 'lore',
    label: 'Lore',
    shape: 'files',
    ...overrides
  });
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [filesInput({ default: 'x' })],
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'lore', path: 'a.md' }] })]
    })),
    /must not declare default for a files input/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [filesInput({ defaultFile: 'a.md' })],
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'lore', path: 'a.md' }] })]
    })),
    /must not declare defaultFile for a files input/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [filesInput({ multiline: true })],
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'lore', path: 'a.md' }] })]
    })),
    /must not declare multiline for a files input/
  );
  assert.throws(
    () => validateTemplate(templateV2({ inputs: [{ id: 'x', label: 'X' }] })),
    /shape must be 'text' or 'files'/
  );
});

test('7. v2 placement shape rules', () => {
  const withInput = (placement, inputs = [{ id: 'style', label: 'Style', shape: 'text' }]) => (
    templateV2({ inputs, placements: [placement] })
  );
  assert.throws(() => validateTemplate(withInput({ target: 'realm', path: 'a.md' })), /exactly one of inputId or file/);
  assert.throws(
    () => validateTemplate(withInput({ inputId: 'style', file: 'a.md', target: 'realm', path: 'a.md' })),
    /exactly one of inputId or file/
  );
  assert.throws(
    () => validateTemplate(withInput({ inputId: 'style', target: 'realm' })),
    /exactly one of path or root/
  );
  assert.throws(
    () => validateTemplate(withInput({ inputId: 'style', target: 'realm', path: 'a.md', root: 'r/' })),
    /exactly one of path or root/
  );
  assert.throws(
    () => validateTemplate(withInput({ inputId: 'style', target: 'realm', root: 'r/' })),
    /must declare a path destination/
  );
  assert.throws(
    () => validateTemplate(withInput({ file: 'a.md', target: 'realm', root: 'r/' })),
    /with a file source must declare a path destination/
  );
  assert.throws(
    () => validateTemplate(withInput({ inputId: 'style', target: { agent: 'ghost' }, path: 'a.md' })),
    /unknown template agent key 'ghost'/
  );
  assert.throws(
    () => validateTemplate(withInput({ inputId: 'style', target: 'realm', path: '../a.md' })),
    /must not contain '\.\.' path segments/
  );
});

test('8. v2 placements accept a root destination for files inputs and reject duplicates', () => {
  const filesInput = { id: 'lore', label: 'Lore', shape: 'files' };
  assert.strictEqual(
    validateTemplate(templateV2({
      inputs: [filesInput],
      placements: [{ inputId: 'lore', target: 'realm', root: 'lore/' }]
    })).placements[0].root,
    'lore/'
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [filesInput],
      placements: [
        { inputId: 'lore', target: 'realm', root: 'lore/' },
        { inputId: 'lore', target: 'realm', root: 'lore/' }
      ]
    })),
    /duplicates the root destination/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [{ id: 'style', label: 'Style', shape: 'text' }],
      placements: [
        { inputId: 'style', target: 'realm', path: 'a.md' },
        { inputId: 'style', target: 'realm', path: 'a.md' }
      ]
    })),
    /duplicates the destination 'a\.md'/
  );
});

test('9. v2 directive shape rules', () => {
  const fixture = (directive) => templateV2({ directives: [directive] });
  assert.throws(() => validateTemplate(fixture({ target: { agent: 'agent' } })), /exactly one of inputId or text/);
  assert.throws(
    () => validateTemplate(fixture({ inputId: 'x', text: 'y', target: { agent: 'agent' } })),
    /exactly one of inputId or text/
  );
  assert.throws(() => validateTemplate(fixture({ text: 'Hi', target: 'realm' })), /must be an object naming a template agent/);
  assert.throws(
    () => validateTemplate(fixture({ text: 'Hi', target: { agent: 'ghost' } })),
    /unknown template agent key 'ghost'/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [{ id: 'lore', label: 'Lore', shape: 'files' }],
      directives: [{ inputId: 'lore', target: { agent: 'agent' } }],
      placements: [{ inputId: 'lore', target: 'realm', root: 'lore/' }]
    })),
    /a directive needs a text message/
  );
});

test('10. v2 closed shapes reject unknown fields and duplicate identifiers', () => {
  assert.throws(() => validateTemplate(templateV2({ seed: { files: [] } })), /carries unknown field 'seed'/);
  assert.throws(
    () => validateTemplate(templateV2({ inputs: [{ id: 'x', label: 'X', shape: 'text', origin: 'user' }] })),
    /carries unknown field 'origin'/
  );
  assert.throws(
    () => validateTemplate(templateV2({ agents: [agentV2(), agentV2()] })),
    /duplicate agent key 'agent'/
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [
        { id: 'x', label: 'X', shape: 'text' },
        { id: 'x', label: 'X2', shape: 'text' }
      ]
    })),
    /duplicate input id 'x'/
  );
  assert.throws(() => validateTemplate(templateV2({ agents: [] })), /agents must be a non-empty array/);
  assert.throws(
    () => validateTemplate(templateV2({ agents: [agentV2({ prompt: [] })] })),
    /prompt must be a non-empty array/
  );
  assert.throws(
    () => validateTemplate(templateV2({ formatVersion: 1 })),
    /formatVersion must be 2/
  );
});

test('11. v2 imposes no prompt-part or composed-size caps', () => {
  const parts = Array.from({ length: 150 }, (_, index) => ({ kind: 'text', text: `Part ${index}.` }));
  const fixture = templateV2({ agents: [agentV2({ prompt: parts })] });
  assert.strictEqual(validateTemplate(fixture).agents[0].prompt.length, 150);
  const composed = composeSystemPrompt(parts, []);
  assert.strictEqual(composed.systemPrompt.split('\n\n').length, 150);
  const wide = composeSystemPrompt([{ kind: 'text', text: 'x'.repeat(250 * 1024) }], []);
  assert.strictEqual(wide.systemPrompt.length, 250 * 1024);
});

// ============================================================================
// 3-4. Composition
// ============================================================================

test('12. composeSystemPrompt joins declared parts with a blank line and omits empty inputs', () => {
  const inputs = [
    { id: 'a', label: 'A', shape: 'text' },
    { id: 'b', label: 'B', shape: 'text' }
  ];
  const composed = composeSystemPrompt(
    [
      { kind: 'text', text: 'Head.' },
      { kind: 'input', inputId: 'a' },
      { kind: 'input', inputId: 'b' }
    ],
    inputs,
    { inputs: { a: { shape: 'text', text: 'Body.' }, b: { shape: 'text', text: '   ' } } }
  );
  assert.strictEqual(composed.systemPrompt, 'Head.\n\nBody.');
  assert.deepStrictEqual(composed.inputProvenance, [
    { inputId: 'a', source: 'launch' },
    { inputId: 'b', source: 'launch' }
  ]);
});

test('13. composeSystemPrompt resolves default, defaultFile, and explicit-empty precedence', () => {
  const inputs = [
    { id: 'inline', label: 'Inline', shape: 'text', default: 'Default text.' },
    { id: 'fromFile', label: 'From file', shape: 'text', defaultFile: 'inputs/style.md' }
  ];
  const composed = composeSystemPrompt(
    [
      { kind: 'input', inputId: 'inline' },
      { kind: 'input', inputId: 'fromFile' }
    ],
    inputs,
    { bundleFiles: { 'inputs/style.md': 'File text.' } }
  );
  assert.strictEqual(composed.systemPrompt, 'Default text.\n\nFile text.');
  assert.deepStrictEqual(composed.inputProvenance, [
    { inputId: 'inline', source: 'default' },
    { inputId: 'fromFile', source: 'defaultFile' }
  ]);
  const overridden = composeSystemPrompt(
    [{ kind: 'input', inputId: 'inline' }],
    inputs,
    { inputs: { inline: { shape: 'text', text: '' } } }
  );
  assert.strictEqual(overridden.systemPrompt, '');
  assert.deepStrictEqual(overridden.inputProvenance, [{ inputId: 'inline', source: 'launch' }]);
  assert.throws(
    () => composeSystemPrompt([{ kind: 'input', inputId: 'fromFile' }], inputs, {}),
    /not present in the bundle files/
  );
});

test('14. composeSystemPrompt injects one selected file of a files input', () => {
  const inputs = [{ id: 'lore', label: 'Lore', shape: 'files' }];
  const files = [
    { path: 'index.md', content: 'Index body.' },
    { path: 'deep/a.md', content: 'Deep body.' }
  ];
  const composed = composeSystemPrompt(
    [{ kind: 'input', inputId: 'lore', path: 'deep/a.md' }],
    inputs,
    { inputs: { lore: filesValue(files) } }
  );
  assert.strictEqual(composed.systemPrompt, 'Deep body.');
  assert.throws(
    () => composeSystemPrompt(
      [{ kind: 'input', inputId: 'lore', path: 'missing.md' }],
      inputs,
      { inputs: { lore: filesValue(files) } }
    ),
    /has no file 'missing\.md'/
  );
  assert.throws(
    () => composeSystemPrompt([{ kind: 'input', inputId: 'lore' }], inputs, { inputs: { lore: filesValue(files) } }),
    /without a file selection path/
  );
});

test('15. composeSystemPrompt enforces required inputs and rejects unknown supplied ids', () => {
  const inputs = [
    { id: 'required_text', label: 'Required', shape: 'text', required: true },
    { id: 'required_files', label: 'Corpus', shape: 'files', required: true }
  ];
  assert.throws(
    () => composeSystemPrompt([{ kind: 'input', inputId: 'required_text' }], inputs, {}),
    /is required and resolves empty/
  );
  assert.throws(
    () => composeSystemPrompt([{ kind: 'input', inputId: 'required_text' }], inputs, {
      inputs: { required_text: { shape: 'text', text: '  ' } }
    }),
    /is required and resolves empty/
  );
  assert.throws(
    () => composeSystemPrompt([{ kind: 'input', inputId: 'required_files', path: 'a.md' }], inputs, {}),
    /is required and resolves empty/
  );
  assert.strictEqual(
    composeSystemPrompt([{ kind: 'text', text: 'x' }], inputs, {
      inputs: { required_files: filesValue([{ path: 'a.md', content: 'A' }]) }
    }).systemPrompt,
    'x',
    'an unreferenced required input does not block other composition'
  );
  assert.throws(
    () => composeSystemPrompt([{ kind: 'text', text: 'x' }], inputs, {
      inputs: { ghost: { shape: 'text', text: 'x' } }
    }),
    /names undeclared input 'ghost'/
  );
});

test('16. composeAgentHistory composes through the same part model and rejects empty entries', () => {
  const spec = {
    ...agentV2(),
    history: [
      { role: 'user', content: [{ kind: 'text', text: 'Kickoff.' }, { kind: 'input', inputId: 'style' }] },
      { role: 'assistant', content: [{ kind: 'input', inputId: 'lore', path: 'index.md' }] }
    ]
  };
  const inputs = [
    { id: 'style', label: 'Style', shape: 'text' },
    { id: 'lore', label: 'Lore', shape: 'files' }
  ];
  const history = composeAgentHistory(spec, inputs, {
    inputs: {
      style: { shape: 'text', text: 'Terse.' },
      lore: filesValue([{ path: 'index.md', content: 'Lore index.' }])
    }
  });
  assert.deepStrictEqual(history, [
    { role: 'user', content: 'Kickoff.\n\nTerse.', source: 'template' },
    { role: 'assistant', content: 'Lore index.', source: 'template' }
  ]);
  assert.ok(Object.isFrozen(history), 'composed history is frozen');
  assert.throws(
    () => composeAgentHistory({
      ...agentV2(),
      history: [{ role: 'user', content: [{ kind: 'input', inputId: 'style' }] }]
    }, inputs, {}),
    /composes empty/
  );
  assert.throws(
    () => composeAgentHistory(agentV2(), inputs, {
      inputs: { ghost: { shape: 'text', text: 'x' } }
    }),
    /names undeclared input 'ghost'/
  );
});

// ============================================================================
// 5. Placements
// ============================================================================

test('17. resolvePlacements writes bundle files, text values, and fileset roots', () => {
  const inputs = [
    { id: 'style', label: 'Style', shape: 'text', default: 'Terse.' },
    { id: 'lore', label: 'Lore', shape: 'files' }
  ];
  const placements = [
    { file: 'files/readme.md', target: 'realm', path: 'handoff/README.md' },
    { inputId: 'style', target: { agent: 'agent' }, path: 'style.md' },
    { inputId: 'lore', target: { agent: 'agent' }, root: 'lore' }
  ];
  const resolved = resolvePlacements(placements, inputs, {
    bundleFiles: { 'files/readme.md': 'Readme.' },
    inputs: { lore: filesValue([{ path: 'a.md', content: 'A' }, { path: 'b/c.md', content: 'C' }]) }
  });
  assert.deepStrictEqual(resolved, [
    { path: 'handoff/README.md', target: 'realm', content: 'Readme.' },
    { path: 'style.md', target: { agent: 'agent' }, content: 'Terse.' },
    { path: 'lore/a.md', target: { agent: 'agent' }, content: 'A' },
    { path: 'lore/b/c.md', target: { agent: 'agent' }, content: 'C' }
  ]);
  assert.ok(Object.isFrozen(resolved), 'resolved placements are frozen');
});

test('18. resolvePlacements handles single-file paths, optional empties, and collisions', () => {
  const inputs = [
    { id: 'one', label: 'One', shape: 'files' },
    { id: 'many', label: 'Many', shape: 'files' },
    { id: 'optional', label: 'Optional', shape: 'text' },
    { id: 'required', label: 'Required', shape: 'text', required: true }
  ];
  assert.deepStrictEqual(
    resolvePlacements([{ inputId: 'one', target: 'realm', path: 'exact.md' }], inputs, {
      inputs: { one: filesValue([{ path: 'inner.md', content: 'Body.' }]) }
    }),
    [{ path: 'exact.md', target: 'realm', content: 'Body.' }]
  );
  assert.throws(
    () => resolvePlacements([{ inputId: 'many', target: 'realm', path: 'exact.md' }], inputs, {
      inputs: { many: filesValue([{ path: 'a.md', content: 'A' }, { path: 'b.md', content: 'B' }]) }
    }),
    /declare a root destination/
  );
  assert.deepStrictEqual(
    resolvePlacements([{ inputId: 'optional', target: 'realm', path: 'skip.md' }], inputs, {}),
    [],
    'an optional empty text value writes nothing'
  );
  assert.deepStrictEqual(
    resolvePlacements([{ inputId: 'one', target: 'realm', root: 'r/' }], inputs, {}),
    [],
    'an optional absent fileset writes nothing'
  );
  assert.throws(
    () => resolvePlacements([{ inputId: 'required', target: 'realm', path: 'x.md' }], inputs, {}),
    /is required and resolves empty/
  );
  assert.throws(
    () => resolvePlacements(
      [
        { file: 'files/a.md', target: 'realm', path: 'same.md' },
        { file: 'files/b.md', target: 'realm', path: 'same.md' }
      ],
      [],
      { bundleFiles: { 'files/a.md': 'A', 'files/b.md': 'B' } }
    ),
    /duplicate destination 'same\.md'/
  );
  assert.throws(
    () => resolvePlacements([{ file: 'files/missing.md', target: 'realm', path: 'a.md' }], [], {}),
    /not present in the bundle files/
  );
});

// ============================================================================
// 6. Directives
// ============================================================================

test('19. resolveDirectives resolves literal and input-driven messages', () => {
  const inputs = [
    { id: 'kickoff', label: 'Kickoff', shape: 'text' },
    { id: 'optional', label: 'Optional', shape: 'text' }
  ];
  const resolved = resolveDirectives(
    [
      { text: 'Literal.', target: { agent: 'agent' } },
      { inputId: 'kickoff', target: { agent: 'agent' } },
      { inputId: 'optional', target: { agent: 'agent' } }
    ],
    inputs,
    { inputs: { kickoff: { shape: 'text', text: 'From input.' } } }
  );
  assert.deepStrictEqual(resolved, [
    { targetAgentKey: 'agent', text: 'Literal.' },
    { targetAgentKey: 'agent', text: 'From input.' }
  ]);
  assert.throws(
    () => resolveDirectives([{ inputId: 'ghost', target: { agent: 'agent' } }], inputs, {}),
    /references undeclared input 'ghost'/
  );
  assert.throws(
    () => resolveDirectives([{ inputId: 'kickoff', target: { agent: 'agent' } }], inputs, {
      inputs: { kickoff: filesValue([{ path: 'a.md', content: 'x' }]) }
    }),
    /inputs\['kickoff'\] must be text-shape/
  );
});

// ============================================================================
// 7. Payloads
// ============================================================================

test('20. validatePayload accepts a conforming v2 payload and tags values by shape', () => {
  const template = templateV2({
    inputs: [
      { id: 'style', label: 'Style', shape: 'text', required: true },
      { id: 'lore', label: 'Lore', shape: 'files', required: true }
    ],
    placements: [{ inputId: 'lore', target: 'realm', root: 'lore/' }],
    agents: [
      agentV2({
        prompt: [
          { kind: 'input', inputId: 'style' },
          { kind: 'input', inputId: 'lore', path: 'index.md' }
        ]
      })
    ]
  });
  const resolved = validatePayload(template, {
    formatVersion: 2,
    templateId: 'tpl2',
    templateVersion: 'sha256:abc',
    inputs: {
      style: { text: 'Terse.' },
      lore: { files: [{ path: 'index.md', content: 'Index.' }] }
    },
    provenance: { producer: 'Genesis' }
  });
  assert.deepStrictEqual(resolved, {
    templateId: 'tpl2',
    templateVersion: 'sha256:abc',
    inputs: {
      style: { shape: 'text', text: 'Terse.' },
      lore: { shape: 'files', files: [{ path: 'index.md', content: 'Index.' }] }
    },
    warnings: []
  });
  assert.ok(Object.isFrozen(resolved), 'resolved payload is frozen');
  assert.ok(Object.isFrozen(resolved.inputs.lore.files), 'nested filesets are frozen');
});

test('21. validatePayload enforces required, unknown, and shape rules', () => {
  const template = templateV2({
    inputs: [
      { id: 'style', label: 'Style', shape: 'text', required: true },
      { id: 'lore', label: 'Lore', shape: 'files' }
    ],
    placements: [{ inputId: 'lore', target: 'realm', root: 'lore/' }],
    agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'style' }] })]
  });
  const base = { formatVersion: 2, templateId: 'tpl2', templateVersion: 'sha256:abc' };
  assert.throws(
    () => validatePayload(template, { ...base, inputs: {} }),
    /required input 'style' \(Style\) is missing/
  );
  assert.throws(
    () => validatePayload(template, { ...base, inputs: { style: { text: '   ' } } }),
    /resolves empty/
  );
  assert.throws(
    () => validatePayload(template, { ...base, inputs: { style: { text: 'x' }, ghost: { text: 'y' } } }),
    /names undeclared input 'ghost'/
  );
  assert.throws(
    () => validatePayload(template, { ...base, inputs: { style: { files: [{ path: 'a.md', content: 'x' }] } } }),
    /carries unknown field 'files'/
  );
  assert.throws(
    () => validatePayload(template, { ...base, inputs: { lore: { text: 'x' }, style: { text: 'x' } } }),
    /carries unknown field 'text'/
  );
  assert.throws(
    () => validatePayload(template, { ...base, inputs: { style: { text: 'x' }, lore: { files: [] } } }),
    /files must be a non-empty array/
  );
  assert.throws(
    () => validatePayload(template, {
      ...base,
      inputs: {
        style: { text: 'x' },
        lore: { files: [{ path: 'a.md', content: 'x' }, { path: 'a.md', content: 'y' }] }
      }
    }),
    /duplicate the path 'a\.md'/
  );
  assert.throws(
    () => validatePayload(template, {
      ...base,
      inputs: { style: { text: 'x' }, lore: { files: [{ path: '../a.md', content: 'x' }] } }
    }),
    /must not contain '\.\.' path segments/
  );
  assert.throws(
    () => validatePayload(template, { ...base, inputs: { style: { text: 'x' }, lore: { files: [] } }, extra: true }),
    /carries unknown field 'extra'/
  );
  assert.throws(
    () => validatePayload(template, { ...base, templateId: 'other', inputs: { style: { text: 'x' } } }),
    /targets template 'other'/
  );
});

test('22. validatePayload applies the pin policy and reports allowed mismatches', () => {
  const template = templateV2();
  const payload = { formatVersion: 2, templateId: 'tpl2', templateVersion: 'sha256:old', inputs: {} };
  assert.throws(
    () => validatePayload(template, payload, { currentVersion: 'sha256:new' }),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_VERSION_MISMATCH
  );
  const resolved = validatePayload(template, payload, {
    currentVersion: 'sha256:new',
    allowVersionMismatch: true
  });
  assert.strictEqual(resolved.warnings.length, 1);
  assert.match(resolved.warnings[0], /explicitly allowed/);
  assert.strictEqual(validatePayload(template, payload).warnings.length, 0);
});

test('23. validatePayload types template errors and payload errors apart', () => {
  assert.throws(
    () => validatePayload(templateV2({ inputs: [{ id: 'orphan', label: 'Orphan', shape: 'text' }] }), {}),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID
  );
  assert.throws(
    () => validatePayload(templateV2(), { formatVersion: 3 }),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE
  );
  assert.throws(
    () => validatePayload(templateV2(), { formatVersion: 2, templateId: 'tpl2', templateVersion: 'sha256:x' }),
    /must be a record of input values/
  );
  assert.throws(
    () => validatePayload(templateV2(), { formatVersion: 2, templateId: 'tpl2', templateVersion: 'sha256:x', inputs: {}, provenance: { author: 'x' } }),
    /carries unknown field 'author'/
  );
});

test('24. payloadDigest hashes canonical sorted-key bytes', () => {
  const expected = `sha256:${createHash('sha256').update('{"a":2,"b":1}', 'utf8').digest('hex')}`;
  assert.strictEqual(payloadDigest({ b: 1, a: 2 }), expected);
  assert.strictEqual(payloadDigest({ a: 2, b: 1 }), expected);
  assert.throws(() => payloadDigest(undefined), /plain JSON data/);
});

// ============================================================================
// 8. v1 read shim
// ============================================================================

test('25. normalizeTemplate shims a legacy template into the v2 model', () => {
  const normalized = normalizeTemplate(legacyTemplate());
  assert.strictEqual(normalized.formatVersion, 2);

  const inputsById = new Map(normalized.inputs.map((input) => [input.id, input]));
  assert.deepStrictEqual([...inputsById.keys()], ['assignment', 'generated_note', 'seed_1', 'seed_2', 'seed_3']);
  assert.deepStrictEqual(inputsById.get('assignment'), {
    id: 'assignment',
    label: 'Assignment',
    shape: 'text',
    brief: 'Hydrate carefully.',
    required: true
  });
  assert.deepStrictEqual(inputsById.get('generated_note'), {
    id: 'generated_note',
    label: 'Note',
    shape: 'text',
    brief: 'Write the note.',
    required: true
  });
  assert.deepStrictEqual(inputsById.get('seed_1'), {
    id: 'seed_1',
    label: 'brief.md',
    shape: 'text',
    default: 'Inline body.'
  });
  assert.deepStrictEqual(inputsById.get('seed_2'), {
    id: 'seed_2',
    label: 'notes.md',
    shape: 'files',
    brief: 'Optional notes.'
  });
  assert.deepStrictEqual(inputsById.get('seed_3'), {
    id: 'seed_3',
    label: 'lore/deep.md',
    shape: 'files',
    brief: 'Generate lore.',
    required: true
  });

  assert.deepStrictEqual(normalized.placements, [
    { file: 'files/readme.md', target: 'realm', path: 'handoff/README.md' },
    { inputId: 'seed_1', target: { agent: 'agent' }, path: 'brief.md' },
    { inputId: 'seed_2', target: 'realm', path: 'notes.md' },
    { inputId: 'seed_3', target: { agent: 'agent' }, path: 'lore/deep.md' }
  ]);
  assert.deepStrictEqual(normalized.directives, [{ text: 'Begin.', target: { agent: 'agent' } }]);
  assert.ok(!('seed' in normalized), 'the v2 model carries no seed manifest');
  assert.ok(!('hydration' in normalized), 'the v2 model carries no template-level hydration block');
});

test('26. the shim preserves v1 acceptance except for v2 totality', () => {
  assert.throws(
    () => normalizeTemplate({ ...legacyTemplate(), formatVersion: 3 }),
    /formatVersion must be 1 or 2/
  );
  const orphan = legacyTemplate();
  orphan.inputs = [...orphan.inputs, { id: 'unused', label: 'Unused' }];
  assert.throws(() => normalizeTemplate(orphan), /never referenced/);
  const collision = legacyTemplate();
  collision.inputs = [...collision.inputs, { id: 'seed_1', label: 'Collides' }];
  assert.throws(() => normalizeTemplate(collision), /collides with input id 'seed_1'/);
});

test('27. validatePayload converts a legacy hydration package against the shimmed template', () => {
  const resolved = validatePayload(legacyTemplate(), {
    formatVersion: 1,
    templateId: 'legacy',
    templateVersion: 'sha256:legacy',
    inputs: { assignment: 'Do it.', generated_note: 'Note.' },
    files: [
      { path: 'notes.md', target: 'realm', content: 'Notes.' },
      { path: 'lore/deep.md', target: { agent: 'agent' }, content: 'Deep.' }
    ],
    provenance: { hydrator: 'Genesis' }
  });
  assert.deepStrictEqual(resolved.inputs, {
    assignment: { shape: 'text', text: 'Do it.' },
    generated_note: { shape: 'text', text: 'Note.' },
    seed_2: { shape: 'files', files: [{ path: 'notes.md', content: 'Notes.' }] },
    seed_3: { shape: 'files', files: [{ path: 'lore/deep.md', content: 'Deep.' }] }
  });
  assert.deepStrictEqual(resolved.warnings, []);
});

test('28. legacy package conversion fails closed on missing generated slots and mismatches', () => {
  const legacy = legacyTemplate();
  const base = {
    formatVersion: 1,
    templateId: 'legacy',
    templateVersion: 'sha256:legacy',
    inputs: { assignment: 'Do it.', generated_note: 'Note.' }
  };
  assert.throws(
    () => validatePayload(legacy, {
      ...base,
      files: [{ path: 'notes.md', target: 'realm', content: 'Notes.' }]
    }),
    /required input 'seed_3' \(lore\/deep\.md\) is missing/
  );
  assert.throws(
    () => validatePayload(legacy, {
      ...base,
      files: [{ path: 'handoff/README.md', target: 'realm', content: 'x' }]
    }),
    /targets fixed placement 'handoff\/README\.md'/
  );
  assert.throws(
    () => validatePayload(legacy, {
      ...base,
      files: [{ path: 'ghost.md', target: 'realm', content: 'x' }]
    }),
    /does not match any declared placement/
  );
  assert.throws(
    () => validatePayload(legacy, { ...base, inputs: { ...base.inputs, seed_2: 'not-a-file' } }),
    /cannot fill files input 'seed_2'/
  );
  assert.throws(
    () => validatePayload(legacy, { ...base, provenance: { author: 'x' } }),
    /carries unknown field 'author'/
  );
});

test('29. a shimmed legacy template materializes into a v2 plan end to end', () => {
  const legacy = legacyTemplate();
  const resolved = validatePayload(legacy, {
    formatVersion: 1,
    templateId: 'legacy',
    templateVersion: 'sha256:legacy',
    inputs: { assignment: 'Do it.', generated_note: 'Note.' },
    files: [
      { path: 'notes.md', target: 'realm', content: 'Notes.' },
      { path: 'lore/deep.md', target: { agent: 'agent' }, content: 'Deep.' }
    ]
  });
  const plan = materializeTemplate(legacy, {
    realmId: 'realm_1',
    inputs: resolved.inputs,
    bundleFiles: LEGACY_FILES
  });
  assert.strictEqual(plan.templateId, 'legacy');
  assert.strictEqual(plan.realmId, 'realm_1');
  assert.deepStrictEqual(plan.placements, [
    { path: 'handoff/README.md', target: 'realm', content: 'Readme.' },
    { path: 'brief.md', target: { agent: 'agent' }, content: 'Inline body.' },
    { path: 'notes.md', target: 'realm', content: 'Notes.' },
    { path: 'lore/deep.md', target: { agent: 'agent' }, content: 'Deep.' }
  ]);
  assert.deepStrictEqual(plan.directives, [{ targetAgentKey: 'agent', text: 'Begin.' }]);
  assert.deepStrictEqual(plan.agents.map((entry) => entry.agentId), ['agent']);
  assert.strictEqual(plan.agents[0].systemPrompt, 'Protocol.\n\nDo it.\n\nNote.');
  assert.deepStrictEqual(plan.agents[0].inputProvenance, [
    { inputId: 'assignment', source: 'launch' },
    { inputId: 'generated_note', source: 'launch' }
  ]);
  assert.ok(Object.isFrozen(plan), 'the plan is frozen');
  assert.ok(Object.isFrozen(plan.placements), 'placements are frozen');
});

// ============================================================================
// 9. Versioning and transport
// ============================================================================

test('30. templateBundleVersion hashes the v2 spec plus referenced bundle files', () => {
  const fixture = templateV2({
    inputs: [{ id: 'style', label: 'Style', shape: 'text', defaultFile: 'inputs/style.md' }],
    agents: [agentV2({ prompt: [{ kind: 'file', path: 'prompts/p.md' }, { kind: 'input', inputId: 'style' }] })],
    placements: [{ file: 'files/readme.md', target: 'realm', path: 'README.md' }]
  });
  const files = {
    'inputs/style.md': 'Terse.',
    'prompts/p.md': 'Protocol.',
    'files/readme.md': 'Readme.'
  };
  const version = templateBundleVersion({ template: fixture, files });
  assert.match(version, /^sha256:[0-9a-f]{64}$/);
  assert.strictEqual(version, templateBundleVersion({ template: fixture, files }), 'deterministic');
  assert.notStrictEqual(
    version,
    templateBundleVersion({ template: fixture, files: { ...files, 'files/readme.md': 'Changed.' } }),
    'a referenced file change changes the version'
  );
  assert.strictEqual(
    version,
    templateBundleVersion({ template: fixture, files: { ...files, 'unrelated.md': 'x' } }),
    'unreferenced files are not hashed'
  );
  assert.throws(
    () => templateBundleVersion({ template: fixture, files: { 'prompts/p.md': 'P' } }),
    /bundle references file 'files\/readme\.md'/
  );
});

test('31. templateBundleVersion preserves the legacy v1 hash for v1 bundles', () => {
  const legacy = legacyTemplate();
  assert.strictEqual(
    templateBundleVersion({ template: legacy, files: LEGACY_FILES }),
    templateBundleVersion({ template: legacy, files: LEGACY_FILES })
  );
});

test('32. parseTemplateBundle round-trips a v2 bundle through canonical transport JSON', () => {
  const fixture = templateV2({
    inputs: [{ id: 'style', label: 'Style', shape: 'text' }],
    agents: [agentV2({ prompt: [{ kind: 'file', path: 'prompts/p.md' }, { kind: 'input', inputId: 'style' }] })],
    placements: [{ inputId: 'style', target: 'realm', path: 'style.md' }]
  });
  const bundle = { template: fixture, files: { 'prompts/p.md': 'Protocol.' } };
  const text = serializeTemplateBundle(bundle);
  const parsed = parseTemplateBundle(text);
  assert.strictEqual(parsed.sourceFormatVersion, 2);
  assert.strictEqual(parsed.version, templateBundleVersion(bundle));
  assert.strictEqual(parsed.serialized, text);
  assert.deepStrictEqual(parsed.warnings, []);
  assert.deepStrictEqual(parsed.template, fixture);
  assert.deepStrictEqual(parsed.files, { 'prompts/p.md': 'Protocol.' });
  assert.ok(Object.isFrozen(parsed), 'parsed bundle is frozen');
  assert.ok(Object.isFrozen(parsed.template), 'parsed template is frozen');
  assert.ok(Object.isFrozen(parsed.files), 'parsed files are frozen');
  assert.deepStrictEqual(parseTemplateBundle(parsed.serialized), parsed, 'serialized is a stable round-trip');
});

test('33. parseTemplateBundle shims a v1 bundle and keeps its authored pin', () => {
  const legacy = legacyTemplate();
  const text = serializeTemplateBundle({ template: legacy, files: LEGACY_FILES });
  const parsed = parseTemplateBundle(text);
  assert.strictEqual(parsed.sourceFormatVersion, 1);
  assert.strictEqual(parsed.version, templateBundleVersion({ template: legacy, files: LEGACY_FILES }));
  assert.strictEqual(parsed.template.formatVersion, 2);
  assert.match(parsed.warnings[0], /legacy format v1/);
  assert.deepStrictEqual(parseTemplateBundle(parsed.serialized), parsed, 'v1 serialized round-trips');
  const plan = materializeTemplate(parsed.template, {
    realmId: 'realm_1',
    bundleFiles: parsed.files,
    inputs: {
      assignment: { shape: 'text', text: 'Do it.' },
      generated_note: { shape: 'text', text: 'Note.' },
      seed_2: { shape: 'files', files: [{ path: 'notes.md', content: 'Notes.' }] },
      seed_3: { shape: 'files', files: [{ path: 'lore/deep.md', content: 'Deep.' }] }
    }
  });
  assert.strictEqual(plan.placements.length, 4);
});

test('34. parseTemplateBundle and serializeTemplateBundle reject malformed envelopes', () => {
  const fixture = templateV2();
  const expectBundleFormat = (value) => (error) => error instanceof RealmCatalogError
    && error.code === REALM_CATALOG_ERROR_CODES.ERR_BUNDLE_FORMAT;
  assert.throws(() => parseTemplateBundle('{ not json'), expectBundleFormat());
  assert.throws(() => parseTemplateBundle({ formatVersion: 3, template: fixture, files: {} }), expectBundleFormat());
  assert.throws(
    () => parseTemplateBundle({ formatVersion: 2, template: legacyTemplate(), files: {} }),
    expectBundleFormat()
  );
  assert.throws(() => parseTemplateBundle({ formatVersion: 2, template: fixture }), expectBundleFormat());
  assert.throws(
    () => parseTemplateBundle({ formatVersion: 2, template: fixture, files: {}, extra: true }),
    expectBundleFormat()
  );
  assert.throws(
    () => parseTemplateBundle({
      formatVersion: 2,
      template: templateV2({ agents: [agentV2({ prompt: [{ kind: 'file', path: 'prompts/p.md' }] })] }),
      files: {}
    }),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID
      && /references file 'prompts\/p\.md'/.test(error.message)
  );
  assert.throws(() => serializeTemplateBundle({ template: null, files: {} }), /template must be an object/);
  assert.throws(() => serializeTemplateBundle({ template: fixture, files: null }), /record of file bodies/);
});

// ============================================================================
// 10. Materialization
// ============================================================================

test('35. materializeTemplate resolves ids, overrides, history, and rejects unknowns', () => {
  const fixture = templateV2({
    inputs: [{ id: 'style', label: 'Style', shape: 'text', default: 'Terse.' }],
    agents: [
      agentV2({
        prompt: [{ kind: 'input', inputId: 'style' }],
        history: [{ role: 'user', content: [{ kind: 'text', text: 'Open.' }] }],
        modelPresetId: 'preset-x'
      }),
      agentV2({ key: 'second', idPattern: 'second' })
    ]
  });
  const plan = materializeTemplate(fixture, {
    realmId: 'realm_1',
    idOverrides: { agent: 'lead' }
  });
  assert.deepStrictEqual(plan.agents.map((entry) => entry.agentId), ['lead', 'second']);
  assert.strictEqual(plan.agents[0].systemPrompt, 'Terse.');
  assert.deepStrictEqual(plan.agents[0].history, [
    { role: 'user', content: 'Open.', source: 'template' }
  ]);
  assert.strictEqual(plan.agents[0].modelPresetId, 'preset-x');
  assert.deepStrictEqual(plan.placements, []);
  assert.deepStrictEqual(plan.directives, []);
  assert.throws(() => materializeTemplate(fixture, { realmId: 'realm_1', idOverrides: { ghost: 'x' } }), /unknown agent key 'ghost'/);
  assert.throws(
    () => materializeTemplate(templateV2({
      agents: [agentV2(), agentV2({ key: 'second', idPattern: 'agent' })]
    }), { realmId: 'realm_1' }),
    /duplicate agent id 'agent'/
  );
  assert.throws(() => materializeTemplate(fixture, { realmId: '' }), /realmId must be a non-empty string/);
});

test('36. materializeTemplate composes a files-input selection into the system prompt', () => {
  const fixture = templateV2({
    inputs: [{ id: 'lore', label: 'Lore', shape: 'files' }],
    agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'lore', path: 'index.md' }] })],
    placements: [{ inputId: 'lore', target: { agent: 'agent' }, root: 'lore/' }]
  });
  const plan = materializeTemplate(fixture, {
    realmId: 'realm_1',
    inputs: { lore: filesValue([{ path: 'index.md', content: 'Index.' }]) }
  });
  assert.strictEqual(plan.agents[0].systemPrompt, 'Index.');
  assert.deepStrictEqual(plan.placements, [{ path: 'lore/index.md', target: { agent: 'agent' }, content: 'Index.' }]);
});

test('37. the baked demo template materializes through the canonical entry point', () => {
  const plan = materializeTemplate(RealmCatalogModule.DEMO_TEMPLATE, { realmId: 'realm_1' });
  assert.strictEqual(plan.templateId, 'demo');
  assert.deepStrictEqual(plan.agents.map((entry) => entry.agentId), ['coordinator', 'worker']);
  assert.deepStrictEqual(plan.placements, []);
  assert.deepStrictEqual(plan.directives, []);
});

// ============================================================================
// 11. Capability summaries and gates
// ============================================================================

test('38. summarizeAgentCapabilities accepts v2 specs with path-bearing parts', () => {
  const summary = summarizeAgentCapabilities(agentV2({
    prompt: [{ kind: 'input', inputId: 'lore', path: 'index.md' }],
    toolProfile: { tools: ['read_file'] }
  }));
  assert.ok(summary.readOnly.includes('read_file'));
  assert.strictEqual(summary.wildcard, false);
});

test('39. provider and authority gates accept v2 templates', () => {
  const requesting = templateV2({
    inputs: [{ id: 'style', label: 'Style', shape: 'text' }],
    placements: [{ inputId: 'style', target: 'realm', path: 'style.md' }],
    toolContract: {
      requirements: [{ id: 'text.similarity', brief: 'Similarity.', io: { in: { a: 'string' }, out: { score: 'number' } } }]
    }
  });
  assert.strictEqual(templateRequiresProviders(requesting), true);
  assert.strictEqual(templateRequiresProviders(templateV2()), false);
  const withAuthorities = templateV2({
    agents: [agentV2({ authorities: ['@template:authority', '@future:authority'] })]
  });
  assert.deepStrictEqual(
    RealmCatalogModule.templateUnsupportedAuthorities(withAuthorities),
    ['@future:authority']
  );
});

// ============================================================================
// 12. Gap matrix (audit ticket a972763)
// ============================================================================

test('40. v2 totality accepts a history-only or directive-only reference and ignores literal directives', () => {
  const historyOnly = templateV2({
    inputs: [{ id: 'style', label: 'Style', shape: 'text' }],
    agents: [agentV2({
      history: [{ role: 'user', content: [{ kind: 'input', inputId: 'style' }] }]
    })]
  });
  assert.strictEqual(validateTemplate(historyOnly), historyOnly, 'a history reference consumes the input');

  const directiveOnly = templateV2({
    inputs: [{ id: 'kickoff', label: 'Kickoff', shape: 'text' }],
    directives: [{ inputId: 'kickoff', target: { agent: 'agent' } }]
  });
  assert.strictEqual(validateTemplate(directiveOnly), directiveOnly, 'an input-driven directive consumes the input');

  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [{ id: 'orphan', label: 'Orphan', shape: 'text' }],
      directives: [{ text: 'Begin.', target: { agent: 'agent' } }]
    })),
    /never referenced/,
    'a literal directive consumes no input, so a declared input stays unreferenced'
  );
});

test('41. v2 path and target safety rejects reserved names and null bytes on v2-only surfaces', () => {
  assert.throws(
    () => validateTemplate(templateV2({ inputs: [{ id: '__proto__', label: 'P', shape: 'text' }] })),
    /reserved property name/,
    'a v2 input id keys payload and placement records'
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [{ id: 'lore', label: 'Lore', shape: 'files' }],
      placements: [{ inputId: 'lore', target: 'realm', root: 'constructor/' }]
    })),
    /must not use reserved property names as path segments/,
    'a fileset root is a v2-only path surface'
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [{ id: 'lore', label: 'Lore', shape: 'files' }],
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'lore', path: 'prototype/a.md' }] })]
    })),
    /must not use reserved property names as path segments/,
    'an input part file selector is a v2-only path surface'
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [{ id: 'lore', label: 'Lore', shape: 'files' }],
      agents: [agentV2({ prompt: [{ kind: 'input', inputId: 'lore', path: '../a.md' }] })]
    })),
    /must not contain '\.\.' path segments/,
    'the input part file selector rejects traversal'
  );
  assert.throws(
    () => validateTemplate(templateV2({
      inputs: [{ id: 'style', label: 'Style', shape: 'text' }],
      placements: [{ inputId: 'style', target: 'realm', path: 'a\0.md' }]
    })),
    /must not contain null bytes/,
    'a placement path rejects null bytes'
  );
  assert.throws(
    () => validatePayload(templateV2({
      inputs: [{ id: 'lore', label: 'Lore', shape: 'files', required: true }],
      placements: [{ inputId: 'lore', target: 'realm', root: 'lore/' }]
    }), {
      formatVersion: 2,
      templateId: 'tpl2',
      templateVersion: 'sha256:x',
      inputs: { lore: { files: [{ path: 'prototype/a.md', content: 'x' }] } }
    }),
    /must not use reserved property names as path segments/,
    'payload fileset paths are validated by the same safety rules'
  );
});

test('42. v2 directive targets are closed objects with a non-empty agent key', () => {
  assert.throws(
    () => validateTemplate(templateV2({ directives: [{ text: 'Hi', target: { agent: '   ' } }] })),
    /target agent must be a non-empty string/
  );
  assert.throws(
    () => validateTemplate(templateV2({ directives: [{ text: 'Hi', target: { agent: 'agent', extra: 1 } }] })),
    /target carries unknown field 'extra'/
  );
  assert.throws(
    () => validateTemplate(templateV2({ directives: [{ text: 'Hi', target: {} }] })),
    /target agent must be a non-empty string/
  );
});

test('43. v2 placement destinations are per-target; root expansions collide with exact paths', () => {
  const inputs = [{ id: 'style', label: 'Style', shape: 'text', default: 'Terse.' }];
  const placements = [
    { inputId: 'style', target: 'realm', path: 'a.md' },
    { inputId: 'style', target: { agent: 'agent' }, path: 'a.md' }
  ];
  const template = templateV2({ inputs, placements });
  assert.strictEqual(validateTemplate(template), template, 'the same path in two workspaces is not a template conflict');
  assert.deepStrictEqual(resolvePlacements(placements, inputs), [
    { path: 'a.md', target: 'realm', content: 'Terse.' },
    { path: 'a.md', target: { agent: 'agent' }, content: 'Terse.' }
  ], 'the same path in two workspaces resolves twice');

  const filesInputs = [{ id: 'lore', label: 'Lore', shape: 'files' }];
  const loreValue = filesValue([{ path: 'a.md', content: 'A' }]);
  assert.throws(
    () => resolvePlacements([
      { inputId: 'lore', target: 'realm', root: 'lore/' },
      { file: 'files/x.md', target: 'realm', path: 'lore/a.md' }
    ], filesInputs, { inputs: { lore: loreValue }, bundleFiles: { 'files/x.md': 'X' } }),
    /resolves a duplicate destination 'lore\/a\.md' for the same target/,
    'a root expansion colliding with an exact path fails closed instead of overwriting'
  );
  assert.throws(
    () => resolvePlacements([
      { inputId: 'lore', target: 'realm', root: 'lore' },
      { inputId: 'lore', target: 'realm', root: 'lore/' }
    ], filesInputs, { inputs: { lore: loreValue } }),
    /resolves a duplicate destination 'lore\/a\.md' for the same target/,
    'two roots that normalize to the same prefix collide at resolution'
  );
  assert.deepStrictEqual(
    resolvePlacements([{ inputId: 'lore', target: 'realm', root: 'lore/' }], filesInputs, {
      inputs: { lore: filesValue([{ path: 'sub/a.md', content: 'A' }]) }
    }),
    [{ path: 'lore/sub/a.md', target: 'realm', content: 'A' }],
    'the root join inserts a separator only when the declared root omits one'
  );
});

test('44. v2 fileset selection: empty selected files and malformed value records fail closed', () => {
  const inputs = [
    { id: 'lore', label: 'Lore', shape: 'files' },
    { id: 'required_lore', label: 'Required lore', shape: 'files', required: true }
  ];
  const blank = { path: 'a.md', content: '   ' };
  assert.throws(
    () => composeSystemPrompt(
      [{ kind: 'input', inputId: 'required_lore', path: 'a.md' }],
      inputs,
      { inputs: { required_lore: filesValue([blank]) } }
    ),
    /file 'a\.md' is required and resolves empty/,
    'a required fileset whose selected file is empty fails closed'
  );
  const optional = composeSystemPrompt(
    [{ kind: 'input', inputId: 'lore', path: 'a.md' }],
    inputs,
    { inputs: { lore: filesValue([blank]) } }
  );
  assert.strictEqual(optional.systemPrompt, '', 'an optional empty selected file contributes nothing');
  assert.deepStrictEqual(
    optional.inputProvenance,
    [{ inputId: 'lore', source: 'launch' }],
    'the supplied (empty) value is still recorded as launch provenance'
  );
  assert.throws(
    () => composeSystemPrompt([{ kind: 'input', inputId: 'lore', path: 'a.md' }], inputs, {
      inputs: { lore: filesValue([{ path: 'a.md', content: 'A' }, { path: 'a.md', content: 'B' }]) }
    }),
    /files duplicate the path 'a\.md'/,
    'duplicate fileset paths fail closed at the composition boundary too'
  );
  assert.throws(
    () => composeSystemPrompt([{ kind: 'input', inputId: 'lore', path: 'a.md' }], inputs, {
      inputs: { lore: { shape: 'text', text: 'A' } }
    }),
    /must be files-shape \(got 'text'\)/,
    'a files declaration never accepts a text-shaped value'
  );
});

test('45. v2 payload provenance is a closed record of optional non-empty strings', () => {
  const template = templateV2({
    inputs: [{ id: 'style', label: 'Style', shape: 'text' }],
    placements: [{ inputId: 'style', target: 'realm', path: 'style.md' }]
  });
  const base = {
    formatVersion: 2,
    templateId: 'tpl2',
    templateVersion: 'sha256:x',
    inputs: { style: { text: 'Terse.' } }
  };
  const resolved = validatePayload(template, {
    ...base,
    provenance: {
      producer: 'Genesis',
      generatedAt: '2026-09-21T00:00:00Z',
      model: 'gpt-x',
      reviewedBy: 'owner'
    }
  });
  assert.deepStrictEqual(
    Object.keys(resolved).sort(),
    ['inputs', 'templateId', 'templateVersion', 'warnings'],
    'provenance is validated, never echoed into the resolved payload'
  );
  assert.throws(
    () => validatePayload(template, { ...base, provenance: { producer: '' } }),
    /producer must be a non-empty string/
  );
  assert.throws(
    () => validatePayload(template, { ...base, provenance: { model: 7 } }),
    /model must be a non-empty string/
  );
  assert.throws(
    () => validatePayload(template, { ...base, provenance: 7 }),
    /provenance must be an object/
  );
});

test('46. the v1 package provenance vocabulary is preserved, not widened by the v2 fields', () => {
  const base = {
    formatVersion: 1,
    templateId: 'legacy',
    templateVersion: 'sha256:legacy',
    inputs: { assignment: 'Do it.', generated_note: 'Note.' },
    files: [
      { path: 'notes.md', target: 'realm', content: 'Notes.' },
      { path: 'lore/deep.md', target: { agent: 'agent' }, content: 'Deep.' }
    ]
  };
  const resolved = validatePayload(legacyTemplate(), {
    ...base,
    provenance: {
      hydrator: 'Genesis',
      generatedAt: '2026-09-21T00:00:00Z',
      model: 'gpt-x',
      reviewedBy: 'owner'
    }
  });
  assert.deepStrictEqual(resolved.warnings, [], 'the full legacy provenance field set is accepted');
  assert.throws(
    () => validatePayload(legacyTemplate(), { ...base, provenance: { producer: 'Genesis' } }),
    /carries unknown field 'producer'/,
    'the v2 producer field is not accepted on a legacy package'
  );
});

test('47. templateBundleVersion hashes the authored form and every v2 file reference', () => {
  assert.throws(
    () => templateBundleVersion({ template: { ...templateV2(), formatVersion: 3 }, files: {} }),
    /template formatVersion must be 1 or 2/,
    'an unsupported authored format is a typed versioning failure'
  );

  const historyTemplate = templateV2({
    agents: [agentV2({ history: [{ role: 'user', content: [{ kind: 'file', path: 'history/opener.md' }] }] })]
  });
  const first = templateBundleVersion({ template: historyTemplate, files: { 'history/opener.md': 'Rain.' } });
  assert.notStrictEqual(
    first,
    templateBundleVersion({ template: historyTemplate, files: { 'history/opener.md': 'Sun.' } }),
    'a history file body is covered by the version'
  );
  assert.throws(
    () => templateBundleVersion({ template: historyTemplate, files: {} }),
    /bundle references file 'history\/opener\.md'/,
    'a referenced history file must be present to version the bundle'
  );

  // The shim hashes the authored v1 document (legacy pins stay valid), so the
  // normalized v2 model of the same template hashes differently.
  const legacy = legacyTemplate();
  assert.notStrictEqual(
    templateBundleVersion({ template: legacy, files: LEGACY_FILES }),
    templateBundleVersion({ template: normalizeTemplate(legacy), files: LEGACY_FILES }),
    'authored-format hashing keeps the v1 pin distinct from the shimmed model'
  );
});

test('48. a shimmed v1 bundle pins against the authored version, not the normalized model', () => {
  const legacy = legacyTemplate();
  const parsed = parseTemplateBundle(serializeTemplateBundle({ template: legacy, files: LEGACY_FILES }));
  assert.strictEqual(parsed.sourceFormatVersion, 1);
  assert.strictEqual(parsed.template.formatVersion, 2);

  const pkg = {
    formatVersion: 1,
    templateId: 'legacy',
    templateVersion: parsed.version,
    inputs: { assignment: 'Do it.', generated_note: 'Note.' },
    files: [
      { path: 'notes.md', target: 'realm', content: 'Notes.' },
      { path: 'lore/deep.md', target: { agent: 'agent' }, content: 'Deep.' }
    ]
  };
  const resolved = validatePayload(parsed.template, pkg, { currentVersion: parsed.version });
  assert.deepStrictEqual(resolved.warnings, [], 'the authored v1 pin validates against the shimmed template');
  assert.deepStrictEqual(resolved.inputs.assignment, { shape: 'text', text: 'Do it.' });

  const shimmedVersion = templateBundleVersion({ template: parsed.template, files: parsed.files });
  assert.notStrictEqual(shimmedVersion, parsed.version, 'the shimmed model is not the authored pin');
  assert.throws(
    () => validatePayload(parsed.template, { ...pkg, templateVersion: shimmedVersion }, {
      currentVersion: parsed.version
    }),
    (error) => error instanceof RealmCatalogError
      && error.code === REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_VERSION_MISMATCH,
    'a payload pinned to the shimmed model is a version mismatch against the authored pin'
  );
  const allowed = validatePayload(parsed.template, { ...pkg, templateVersion: shimmedVersion }, {
    currentVersion: parsed.version,
    allowVersionMismatch: true
  });
  assert.strictEqual(allowed.warnings.length, 1, 'the shimmed-model pin is reportable as an allowed mismatch');
});

test('49. v2 directive resolution fails closed on a required empty input', () => {
  assert.throws(
    () => resolveDirectives(
      [{ inputId: 'kickoff', target: { agent: 'agent' } }],
      [{ id: 'kickoff', label: 'Kickoff', shape: 'text', required: true }],
      {}
    ),
    /input 'kickoff' is required and resolves empty/
  );
});
