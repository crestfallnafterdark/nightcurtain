/**
 * @file tests/unit/extension_tools_module_test.js
 * @description Unit suite for the `tools/extensionTools` module surface.
 *
 * Coverage:
 *  1. Projection policy matrix: clean schemas; additive defaults; free-form
 *     objects; missing/null roots; Notion-style `$defs`+`oneOf`+string
 *     fallback; Sentry-style nullable `anyOf`; reference cycles; union
 *     widening; `allOf` merging; unknown-keyword drops; refusals (non-object
 *     and malformed roots, unresolvable references, depth/reference budgets).
 *  2. Prototype-key hygiene and deterministic, deeply frozen outputs.
 *  3. Descriptor synthesis: frozen descriptors, description pass-through and
 *     defaults, refusal semantics, input validation.
 *  4. Execution handler delegation through a frozen fake
 *     `ExtensionExecutionPort` (the sanctioned DI seam).
 *  5. Result mapping: text joins, markers without base64, structured content,
 *     failure receipts, truncation and cap overrides.
 *  6. Fidelity-summary thresholds.
 *
 * Zero-Mock Verification: every tested class is real. The only injected seam
 * is the sanctioned frozen plain-object execution port handed to the handler,
 * exactly as the composition root will supply it.
 */

import '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTENSION_EXECUTION_PORT_KEY,
  EXTENSION_SCHEMA_MAX_DEPTH,
  EXTENSION_SCHEMA_MAX_REFS,
  EXTENSION_SCHEMA_REFUSAL_CODES,
  EXTENSION_SCHEMA_WARNING_CODES,
  EXTENSION_TOOL_DESCRIPTION_MAX_LENGTH,
  EXTENSION_TOOL_RESULT_MAX_CHARS,
  mapMcpToolResult,
  projectExtensionInputSchema,
  summarizeExtensionSchemaFidelity,
  synthesizeExtensionToolDescriptor
} from '../../src/lib/sandbox/tools/extensionTools/index.ts';

import { TOOL_SYSTEM_ERROR_CODES } from '../../src/lib/sandbox/tools/constants/index.ts';

/** Clean object schema with descriptions everywhere; projects with zero warnings. */
const CLEAN_SCHEMA = {
  type: 'object',
  description: 'Search documents',
  properties: {
    query: { type: 'string', description: 'Free-text query' },
    limit: { type: 'integer', enum: [10, 20], description: 'Max results' }
  },
  required: ['query'],
  additionalProperties: false
};

/** Sentry-style nullable `anyOf` input schema (inline fixture from the survey). */
const SENTRY_STYLE_SCHEMA = {
  type: 'object',
  properties: {
    regionUrl: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      default: null,
      description: 'Region URL override'
    },
    issueId: { type: 'integer', description: 'Issue id' }
  },
  required: ['issueId'],
  additionalProperties: false
};

/** Notion-style `$defs` + `oneOf` + string-fallback input schema (inline fixture). */
const NOTION_STYLE_SCHEMA = {
  type: 'object',
  $defs: {
    RichText: {
      type: 'object',
      properties: {
        text: { type: 'string', format: 'uuid', description: 'Text content' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  properties: {
    title: {
      oneOf: [{ $ref: '#/$defs/RichText' }, { type: 'string' }],
      description: 'Title as rich text or plain string'
    }
  },
  required: ['title'],
  additionalProperties: false
};

/** Prototype-vocabulary property names, parsed so `__proto__` is an own key. */
const PROTOTYPE_SCHEMA = JSON.parse(
  '{"type":"object","properties":{"__proto__":{"type":"string","description":"bad"},'
  + '"constructor":{"type":"string","description":"bad"},"prototype":{"type":"string","description":"bad"},'
  + '"safe":{"type":"string","description":"ok"}},"additionalProperties":false}'
);

/**
 * Builds a chain of `depth` nested object wrappers around a string leaf.
 *
 * @param {number} depth Number of object wrappers.
 * @returns {object} Nested schema.
 */
function nestedObjectSchema(depth) {
  let node = { type: 'string', description: 'leaf' };
  for (let index = 0; index < depth; index += 1) {
    node = { type: 'object', properties: { child: node }, additionalProperties: false };
  }
  return node;
}

/**
 * Builds an object schema with `count` properties, each a local `$ref`.
 *
 * @param {number} count Number of reference properties.
 * @returns {object} Schema with one `$defs` entry and `count` dereferences.
 */
function referenceBudgetSchema(count) {
  const properties = {};
  for (let index = 0; index < count; index += 1) {
    properties[`p${index}`] = { $ref: '#/$defs/S' };
  }
  return {
    type: 'object',
    $defs: { S: { type: 'string', description: 'shared' } },
    properties,
    additionalProperties: false
  };
}

/**
 * Renders one projection's warnings as `code@path` strings.
 *
 * @param {object} projection Projection outcome.
 * @returns {string[]} Rendered warning pairs.
 */
function warningPairs(projection) {
  return projection.warnings.map((warning) => `${warning.code}@${warning.path}`);
}

/**
 * Asserts a projection was refused with the expected code.
 *
 * @param {object} projection Projection outcome.
 * @param {string} code Expected refusal code.
 */
function expectRefused(projection, code) {
  assert.strictEqual(projection.status, 'refused');
  assert.strictEqual(projection.refusal.code, code);
}

// ============================================================================
// 1-14. Projection matrix
// ============================================================================

test('1. clean schemas project verbatim, deterministically, deeply frozen', () => {
  const projection = projectExtensionInputSchema(CLEAN_SCHEMA);
  assert.strictEqual(projection.status, 'projected');
  assert.deepStrictEqual(projection.warnings, []);
  assert.deepStrictEqual(projection.schema, {
    type: 'object',
    description: 'Search documents',
    properties: {
      query: { type: 'string', description: 'Free-text query' },
      limit: { type: 'integer', enum: [10, 20], description: 'Max results' }
    },
    required: ['query'],
    additionalProperties: false
  });
  assert.ok(Object.isFrozen(projection), 'projection must be frozen');
  assert.ok(Object.isFrozen(projection.schema), 'schema must be frozen');
  assert.ok(Object.isFrozen(projection.schema.properties), 'properties map must be frozen');
  assert.ok(Object.isFrozen(projection.schema.properties.query), 'property nodes must be frozen');
  assert.ok(Object.isFrozen(projection.warnings), 'warnings array must be frozen');
  assert.deepStrictEqual(projectExtensionInputSchema(CLEAN_SCHEMA), projection, 'projection must be deterministic');
});

test('2. missing additionalProperties/descriptions normalize additively', () => {
  const projection = projectExtensionInputSchema({
    type: 'object',
    properties: { query: { type: 'string' } }
  });
  assert.strictEqual(projection.status, 'projected');
  assert.deepStrictEqual(warningPairs(projection), [
    `${EXTENSION_SCHEMA_WARNING_CODES.DESCRIPTION_DEFAULTED}@#/properties/query`,
    `${EXTENSION_SCHEMA_WARNING_CODES.ADDITIONAL_PROPERTIES_DEFAULTED}@#`
  ]);
  assert.strictEqual(projection.schema.additionalProperties, false);
  assert.strictEqual(
    projection.schema.properties.query.description,
    'No description provided by the server.'
  );
  assert.ok(Object.isFrozen(projection.warnings[0]), 'warning entries must be frozen');
});

test('3. free-form objects stay permissive with one disclosure per tool', () => {
  const projection = projectExtensionInputSchema({
    type: 'object',
    properties: {
      props: { type: 'object', additionalProperties: { type: 'string' }, description: 'props' },
      values: { type: 'object', description: 'values' },
      other: { type: 'object', description: 'other' }
    },
    additionalProperties: false
  });
  assert.strictEqual(projection.status, 'projected');
  assert.strictEqual(
    warningPairs(projection).filter((pair) => pair.startsWith(EXTENSION_SCHEMA_WARNING_CODES.FREEFORM_OBJECT)).length,
    1,
    'free-form disclosure is per tool, not per node'
  );
  assert.strictEqual(projection.schema.properties.props.additionalProperties.type, 'string');
  assert.strictEqual(projection.schema.properties.values.additionalProperties, true);
  assert.strictEqual(projection.schema.properties.other.additionalProperties, true);
});

test('4. missing or null input schemas project to an open empty object', () => {
  for (const raw of [undefined, null]) {
    const projection = projectExtensionInputSchema(raw);
    assert.strictEqual(projection.status, 'projected');
    assert.deepStrictEqual(projection.schema, {
      type: 'object',
      properties: {},
      additionalProperties: true
    });
    assert.deepStrictEqual(
      warningPairs(projection),
      [`${EXTENSION_SCHEMA_WARNING_CODES.FREEFORM_OBJECT}@#`]
    );
  }
});

test('5. Notion-style $defs + oneOf + string fallback projects to a callable schema', () => {
  const projection = projectExtensionInputSchema(NOTION_STYLE_SCHEMA);
  assert.strictEqual(projection.status, 'projected');
  const pairs = warningPairs(projection);
  assert.ok(pairs.includes(`${EXTENSION_SCHEMA_WARNING_CODES.REF_DEREF}@#/properties/title/oneOf/0`));
  assert.ok(pairs.includes(`${EXTENSION_SCHEMA_WARNING_CODES.UNION_WIDENED}@#/properties/title`));

  const title = projection.schema.properties.title;
  assert.deepStrictEqual(title.type, ['object', 'string'], 'object branch and string fallback both survive');
  assert.strictEqual(title.description, 'Title as rich text or plain string');
  assert.strictEqual(title.properties.text.type, 'string');
  assert.strictEqual(title.properties.text.format, 'uuid', 'known formats are kept');
  assert.strictEqual(title.additionalProperties, false, 'closed object branch stays closed');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(projection.schema, '$defs'), false, '$defs is consumed');
});

test('6. Sentry-style nullable anyOf and nullable type arrays unwrap', () => {
  const anyOfProjection = projectExtensionInputSchema(SENTRY_STYLE_SCHEMA);
  assert.strictEqual(anyOfProjection.status, 'projected');
  const pairs = warningPairs(anyOfProjection);
  assert.ok(pairs.includes(`${EXTENSION_SCHEMA_WARNING_CODES.NULLABLE_UNWRAPPED}@#/properties/regionUrl`));
  assert.ok(pairs.includes(`${EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED}@#/properties/regionUrl/default`));
  assert.strictEqual(anyOfProjection.schema.properties.regionUrl.type, 'string');
  assert.strictEqual(anyOfProjection.schema.properties.regionUrl.description, 'Region URL override');

  const typeArrayProjection = projectExtensionInputSchema({
    type: 'object',
    properties: { region: { type: ['string', 'null'], description: 'Region' } },
    additionalProperties: false
  });
  assert.deepStrictEqual(warningPairs(typeArrayProjection), [
    `${EXTENSION_SCHEMA_WARNING_CODES.NULLABLE_UNWRAPPED}@#/properties/region`
  ]);
  assert.strictEqual(typeArrayProjection.schema.properties.region.type, 'string');
});

test('7. a $ref cycle is cut to a permissive node without throwing', () => {
  const projection = projectExtensionInputSchema({
    type: 'object',
    $defs: {
      Node: {
        type: 'object',
        properties: { child: { $ref: '#/$defs/Node' }, label: { type: 'string', description: 'label' } },
        additionalProperties: false
      }
    },
    properties: { root: { $ref: '#/$defs/Node' } },
    additionalProperties: false
  });
  assert.strictEqual(projection.status, 'projected');
  assert.ok(warningPairs(projection).includes(`${EXTENSION_SCHEMA_WARNING_CODES.REF_CYCLE_CUT}@#/properties/root/properties/child`));
  assert.deepStrictEqual(projection.schema.properties.root.properties.child, {
    type: 'object',
    description: 'No description provided by the server.',
    properties: {},
    additionalProperties: true
  });
});

test('8. multi-branch unions widen to the union type set and keep object properties', () => {
  const deepwikiStyle = projectExtensionInputSchema({
    type: 'object',
    properties: {
      repoName: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Repository name or names'
      }
    },
    additionalProperties: false
  });
  assert.strictEqual(deepwikiStyle.status, 'projected');
  assert.ok(warningPairs(deepwikiStyle).includes(`${EXTENSION_SCHEMA_WARNING_CODES.UNION_WIDENED}@#/properties/repoName`));
  assert.deepStrictEqual(deepwikiStyle.schema.properties.repoName.type, ['string', 'array']);
  assert.deepStrictEqual(deepwikiStyle.schema.properties.repoName.items, {
    type: 'string',
    description: 'No description provided by the server.'
  });

  const untypedBranch = projectExtensionInputSchema({
    type: 'object',
    properties: {
      anything: { anyOf: [{ type: 'string' }, { description: 'untyped branch' }], description: 'Any value' }
    },
    additionalProperties: false
  });
  assert.strictEqual(untypedBranch.status, 'projected');
  assert.strictEqual(untypedBranch.schema.properties.anything.type, undefined, 'an untyped branch widens to unconstrained');
  assert.strictEqual(untypedBranch.schema.properties.anything.description, 'Any value');
});

test('9. allOf shallow-merges with later keys winning and types unioning', () => {
  const projection = projectExtensionInputSchema({
    allOf: [
      { type: 'object', properties: { a: { type: 'string', description: 'a' } } },
      { type: 'object', properties: { b: { type: 'integer', description: 'b' } }, required: ['b'] }
    ],
    additionalProperties: false
  });
  assert.strictEqual(projection.status, 'projected');
  assert.deepStrictEqual(warningPairs(projection), [`${EXTENSION_SCHEMA_WARNING_CODES.ALLOF_MERGED}@#`]);
  assert.deepStrictEqual(Object.keys(projection.schema.properties), ['a', 'b']);
  assert.deepStrictEqual(projection.schema.required, ['b']);
  assert.strictEqual(projection.schema.additionalProperties, false);
});

test('10. unsupported keywords drop with a pointer path', () => {
  const projection = projectExtensionInputSchema({
    type: 'object',
    title: 'Root title',
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: {
      query: {
        type: 'string',
        description: 'q',
        pattern: '^x',
        minLength: 1,
        default: 'x',
        format: 'fancy'
      },
      filter: {
        type: 'object',
        description: 'f',
        patternProperties: { '^a': { type: 'string' } },
        if: { type: 'object' },
        then: { type: 'object' },
        else: { type: 'object' }
      }
    },
    additionalProperties: false
  });
  assert.strictEqual(projection.status, 'projected');
  const pairs = new Set(warningPairs(projection));
  for (const expected of [
    'keyword-dropped@#/title',
    'keyword-dropped@#/$schema',
    'keyword-dropped@#/properties/query/pattern',
    'keyword-dropped@#/properties/query/minLength',
    'keyword-dropped@#/properties/query/default',
    'keyword-dropped@#/properties/query/format',
    'keyword-dropped@#/properties/filter/patternProperties',
    'keyword-dropped@#/properties/filter/if',
    'keyword-dropped@#/properties/filter/then',
    'keyword-dropped@#/properties/filter/else'
  ]) {
    assert.ok(pairs.has(expected), `expected warning '${expected}'`);
  }
  assert.strictEqual(projection.schema.properties.query.type, 'string');
  assert.strictEqual(projection.schema.title, undefined);
});

test('11. non-object and malformed roots refuse per tool', () => {
  expectRefused(projectExtensionInputSchema({ type: 'string' }), EXTENSION_SCHEMA_REFUSAL_CODES.UNSUPPORTED_ROOT);
  expectRefused(projectExtensionInputSchema({ type: ['string', 'null'] }), EXTENSION_SCHEMA_REFUSAL_CODES.UNSUPPORTED_ROOT);
  expectRefused(projectExtensionInputSchema([1, 2]), EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA);
  expectRefused(projectExtensionInputSchema('object'), EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA);
  expectRefused(projectExtensionInputSchema(true), EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA);
  expectRefused(
    projectExtensionInputSchema({ type: 'object', properties: { n: { type: 'number', minimum: Number.NaN, description: 'n' } } }),
    EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA
  );
  expectRefused(
    projectExtensionInputSchema({ type: 'object', properties: { f: { type: 'string', description: 'f', default: () => {} } } }),
    EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA
  );

  const cyclic = { type: 'object' };
  cyclic.properties = { self: cyclic };
  expectRefused(projectExtensionInputSchema(cyclic), EXTENSION_SCHEMA_REFUSAL_CODES.MALFORMED_SCHEMA);
});

test('12. unresolvable and non-local references refuse at their pointer', () => {
  const missing = projectExtensionInputSchema({
    type: 'object',
    properties: { a: { $ref: '#/$defs/Missing' } },
    additionalProperties: false
  });
  expectRefused(missing, EXTENSION_SCHEMA_REFUSAL_CODES.UNRESOLVABLE_REF);
  assert.strictEqual(missing.refusal.path, '#/properties/a/$ref');

  const remote = projectExtensionInputSchema({
    type: 'object',
    properties: { a: { $ref: 'https://example.com/schema.json#/x' } },
    additionalProperties: false
  });
  expectRefused(remote, EXTENSION_SCHEMA_REFUSAL_CODES.UNRESOLVABLE_REF);
});

test('13. depth and reference budgets refuse with no partial schema', () => {
  assert.strictEqual(
    projectExtensionInputSchema(nestedObjectSchema(EXTENSION_SCHEMA_MAX_DEPTH)).status,
    'projected',
    'depth equal to the budget is allowed'
  );
  expectRefused(
    projectExtensionInputSchema(nestedObjectSchema(EXTENSION_SCHEMA_MAX_DEPTH + 1)),
    EXTENSION_SCHEMA_REFUSAL_CODES.DEPTH_BUDGET
  );

  assert.strictEqual(
    projectExtensionInputSchema(referenceBudgetSchema(EXTENSION_SCHEMA_MAX_REFS)).status,
    'projected',
    'reference count equal to the budget is allowed'
  );
  expectRefused(
    projectExtensionInputSchema(referenceBudgetSchema(EXTENSION_SCHEMA_MAX_REFS + 1)),
    EXTENSION_SCHEMA_REFUSAL_CODES.REF_BUDGET
  );
});

test('14. prototype keys are dropped everywhere without pollution', () => {
  const projection = projectExtensionInputSchema(PROTOTYPE_SCHEMA);
  assert.strictEqual(projection.status, 'projected');
  const properties = projection.schema.properties;
  assert.deepStrictEqual(Object.keys(properties), ['safe']);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(properties, '__proto__'), false);
  assert.strictEqual(Object.getPrototypeOf(properties), Object.prototype);
  assert.strictEqual(Object.getPrototypeOf(projection.schema), Object.prototype);
  assert.strictEqual(Object.prototype.polluted, undefined, 'no prototype pollution may occur');
  const pairs = warningPairs(projection);
  assert.ok(pairs.includes(`${EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED}@#/properties/__proto__`));
  assert.ok(pairs.includes(`${EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED}@#/properties/constructor`));
  assert.ok(pairs.includes(`${EXTENSION_SCHEMA_WARNING_CODES.KEYWORD_DROPPED}@#/properties/prototype`));
});

// ============================================================================
// 15-17. Descriptor synthesis
// ============================================================================

test('15. synthesis freezes a descriptor with default description and wired sanitizer', () => {
  const { descriptor, projection } = synthesizeExtensionToolDescriptor({
    extensionId: 'acme-docs',
    callName: 'docs_search',
    serverToolName: 'docs.search',
    inputSchema: CLEAN_SCHEMA
  });
  assert.strictEqual(projection.status, 'projected');
  assert.ok(descriptor);
  assert.ok(Object.isFrozen(descriptor));
  assert.ok(Object.isFrozen(descriptor.source));
  assert.ok(Object.isFrozen(descriptor.schema));
  assert.strictEqual(descriptor.name, 'docs_search');
  assert.strictEqual(
    descriptor.description,
    "Tool 'docs.search' provided by extension 'acme-docs' (third-party; classification unknown)"
  );
  assert.deepStrictEqual(descriptor.source, { extensionId: 'acme-docs', serverToolName: 'docs.search' });
  assert.strictEqual(typeof descriptor.sanitize, 'function');
  assert.strictEqual(typeof descriptor.handler, 'function');
  assert.deepStrictEqual(descriptor.sanitize('{"topK": 5, "snake_key": true}'), { topK: 5, snake_key: true });

  // A supplied third-party description passes through verbatim, capped when huge.
  const described = synthesizeExtensionToolDescriptor({
    extensionId: 'acme-docs',
    callName: 'docs_search',
    serverToolName: 'docs.search',
    description: 'Search docs',
    inputSchema: { type: 'object' }
  });
  assert.strictEqual(described.descriptor.description, 'Search docs');

  const long = 'd'.repeat(EXTENSION_TOOL_DESCRIPTION_MAX_LENGTH + 40);
  const capped = synthesizeExtensionToolDescriptor({
    extensionId: 'acme-docs',
    callName: 'docs_search',
    serverToolName: 'docs.search',
    description: long,
    inputSchema: { type: 'object' }
  });
  assert.strictEqual(capped.descriptor.description.length, EXTENSION_TOOL_DESCRIPTION_MAX_LENGTH + 1);
  assert.ok(capped.descriptor.description.endsWith('…'));
});

test('16. refused projections yield descriptor: null; output schemas never block', () => {
  const refused = synthesizeExtensionToolDescriptor({
    extensionId: 'acme-docs',
    callName: 'docs_grep',
    serverToolName: 'docs.grep',
    inputSchema: { type: 'string' }
  });
  assert.strictEqual(refused.descriptor, null);
  assert.strictEqual(refused.projection.status, 'refused');

  // An unprojectable output schema is carried, never projected, and never blocks.
  const withOutput = synthesizeExtensionToolDescriptor({
    extensionId: 'acme-docs',
    callName: 'docs_list',
    serverToolName: 'docs.list',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' }
  });
  assert.ok(withOutput.descriptor, 'output schema must not refuse the tool');
  assert.strictEqual(withOutput.projection.status, 'projected');
});

test('17. synthesis rejects programmer errors and reserved call names', () => {
  const base = { extensionId: 'acme', callName: 'docs_list', serverToolName: 'docs.list', inputSchema: { type: 'object' } };
  assert.throws(() => synthesizeExtensionToolDescriptor(null), TypeError);
  assert.throws(() => synthesizeExtensionToolDescriptor({ ...base, extensionId: '' }), TypeError);
  assert.throws(() => synthesizeExtensionToolDescriptor({ ...base, serverToolName: '' }), TypeError);
  assert.throws(() => synthesizeExtensionToolDescriptor({ ...base, callName: '' }), TypeError);
  assert.throws(() => synthesizeExtensionToolDescriptor({ ...base, description: 42 }), TypeError);
  for (const reserved of ['read_file', '__proto__', 'import_realm_template']) {
    assert.throws(
      () => synthesizeExtensionToolDescriptor({ ...base, callName: reserved }),
      TypeError,
      `'${reserved}' must be rejected as a reserved call name`
    );
  }
});

// ============================================================================
// 18-19. Execution handler delegation (frozen fake port seam)
// ============================================================================

test('18. the handler delegates through the pinned frozen execution port', async () => {
  const calls = [];
  const port = Object.freeze({
    async execute(request) {
      calls.push(request);
      return { content: [{ type: 'text', text: 'done' }], isError: false };
    }
  });
  const { descriptor } = synthesizeExtensionToolDescriptor({
    extensionId: 'acme-docs',
    callName: 'docs_search',
    serverToolName: 'docs.search',
    inputSchema: CLEAN_SCHEMA
  });

  assert.strictEqual(EXTENSION_EXECUTION_PORT_KEY, 'extensionExecutionPort');
  const receipt = await descriptor.handler(
    { query: 'hello', top_k: 3 },
    { [EXTENSION_EXECUTION_PORT_KEY]: port, agentId: 'agent_writer' }
  );

  assert.deepStrictEqual(calls, [
    { extensionId: 'acme-docs', serverToolName: 'docs.search', args: { query: 'hello', top_k: 3 } }
  ]);
  assert.deepStrictEqual(receipt, { success: true, content: 'done' });
  assert.ok(Object.isFrozen(receipt), 'mapped receipts are frozen');
});

test('19. a missing port fails closed and port rejections propagate', async () => {
  const { descriptor } = synthesizeExtensionToolDescriptor({
    extensionId: 'acme-docs',
    callName: 'docs_search',
    serverToolName: 'docs.search',
    inputSchema: { type: 'object' }
  });

  for (const context of [undefined, {}, { [EXTENSION_EXECUTION_PORT_KEY]: null }, { [EXTENSION_EXECUTION_PORT_KEY]: { execute: 'nope' } }]) {
    const receipt = await descriptor.handler({}, context);
    assert.strictEqual(receipt.success, false);
    assert.strictEqual(receipt.code, TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED);
  }

  const failingPort = Object.freeze({
    async execute() {
      throw new Error('transport down');
    }
  });
  await assert.rejects(
    descriptor.handler({}, { [EXTENSION_EXECUTION_PORT_KEY]: failingPort }),
    /transport down/,
    'port rejections propagate to the dispatcher error shield'
  );
});

// ============================================================================
// 20-22. Result mapping
// ============================================================================

test('20. success mapping joins text, marks non-text blocks, appends structured JSON', () => {
  const receipt = mapMcpToolResult({
    content: [
      { type: 'text', text: 'first' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      { type: 'resource', resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'inline text' } },
      { type: 'audio', mimeType: 'audio/mpeg', data: 'aGVsbG8=' },
      { type: 'resource_link', uri: 'https://example.com/a', mimeType: 'text/html' },
      { type: 'text', text: 'second' }
    ],
    isError: false,
    structuredContent: { count: 2 }
  });

  assert.strictEqual(receipt.success, true);
  assert.strictEqual(
    receipt.content,
    'first\n\n[image image/png 5B]\n\n[resource file:///notes.txt text/plain]\ninline text\n\n'
    + '[audio audio/mpeg 5B]\n\n[resource_link https://example.com/a text/html]\n\nsecond\n\n{"count":2}'
  );
  assert.ok(!receipt.content.includes('aGVsbG8'), 'base64 must never enter the receipt');
});

test('21. isError maps to the failure receipt', () => {
  const failure = mapMcpToolResult({
    content: [
      { type: 'text', text: 'boom' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
      { type: 'text', text: 'details' }
    ],
    isError: true
  });
  assert.deepStrictEqual(failure, {
    success: false,
    error: 'boom\n\ndetails',
    code: TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED
  });

  const silentFailure = mapMcpToolResult({ content: [], isError: true });
  assert.strictEqual(silentFailure.success, false);
  assert.strictEqual(silentFailure.code, TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED);
  assert.ok(silentFailure.error.length > 0, 'a generic failure text is always present');
  assert.ok(!JSON.stringify(silentFailure).includes('aGVsbG8'));
});

test('22. mapped text is capped with the deterministic truncation marker', () => {
  const longText = 'x'.repeat(EXTENSION_TOOL_RESULT_MAX_CHARS + 25);
  const truncated = mapMcpToolResult({ content: [{ type: 'text', text: longText }], isError: false });
  assert.ok(truncated.content.endsWith('…[truncated 25 chars]'));
  assert.strictEqual(
    truncated.content.slice(0, EXTENSION_TOOL_RESULT_MAX_CHARS),
    longText.slice(0, EXTENSION_TOOL_RESULT_MAX_CHARS)
  );
  assert.strictEqual(truncated.content.length, EXTENSION_TOOL_RESULT_MAX_CHARS + '…[truncated 25 chars]'.length);

  const overridden = mapMcpToolResult(
    { content: [{ type: 'text', text: 'abcdefghijklmno' }], isError: false },
    { maxChars: 10 }
  );
  assert.strictEqual(overridden.content, 'abcdefghij…[truncated 5 chars]');

  assert.throws(() => mapMcpToolResult(null), TypeError);
  assert.throws(() => mapMcpToolResult({ content: 'nope', isError: false }), TypeError);
  assert.throws(() => mapMcpToolResult({ content: [], isError: false }, { maxChars: 0 }), TypeError);
});

// ============================================================================
// 23. Fidelity summary
// ============================================================================

test('23. fidelity summary distinguishes clean, projected, degraded, and refused', () => {
  const clean = projectExtensionInputSchema(CLEAN_SCHEMA);
  const additive = projectExtensionInputSchema({ type: 'object', properties: { a: { type: 'string' } } });
  const semantic = projectExtensionInputSchema(SENTRY_STYLE_SCHEMA);
  const refused = projectExtensionInputSchema({ type: 'string' });

  assert.deepStrictEqual(summarizeExtensionSchemaFidelity([]), {
    state: 'clean', total: 0, warned: 0, refused: 0
  });
  assert.strictEqual(summarizeExtensionSchemaFidelity([clean]).state, 'clean');
  assert.deepStrictEqual(summarizeExtensionSchemaFidelity([clean, additive]), {
    state: 'projected', total: 2, warned: 1, refused: 0
  });
  // Additive normalization alone never degrades fidelity.
  assert.strictEqual(summarizeExtensionSchemaFidelity([additive, additive, additive]).state, 'projected');
  // More than half of the tools needing semantic projection degrades...
  assert.strictEqual(summarizeExtensionSchemaFidelity([semantic, semantic, additive]).state, 'degraded');
  // ... and an exact half does not.
  assert.strictEqual(summarizeExtensionSchemaFidelity([semantic, semantic, clean, clean]).state, 'projected');
  // Any refusal degrades.
  const withRefusal = summarizeExtensionSchemaFidelity([clean, refused]);
  assert.strictEqual(withRefusal.state, 'degraded');
  assert.strictEqual(withRefusal.refused, 1);

  assert.throws(() => summarizeExtensionSchemaFidelity('nope'), TypeError);
  assert.throws(() => summarizeExtensionSchemaFidelity([{ status: 'weird', warnings: [] }]), TypeError);
  assert.ok(Object.isFrozen(summarizeExtensionSchemaFidelity([clean])));
});
