/**
 * @file tests/unit/realm_content_pipeline_test.js
 * @description Wave C C2 (ticket dd13eab): zero-mock verification of the Realm
 *   template bundle embed pipeline and the baked-bundle accessor. Extended for
 *   Wave T (ticket c19fb5d): history file references are collected by the
 *   generator, and format-v1 origins/history materialize through the real
 *   catalog against generated fixture bundles.
 *
 *   Covered behavior:
 *   1. The committed `content.generated.ts` is fresh (`--check` green) and the
 *      generator is deterministic: a fresh generation from a byte copy of
 *      `templates/` reproduces the committed module byte-for-byte, and two runs
 *      are byte-identical.
 *   2. Every baked bundle (demo fixture + generated bundles) carries only
 *      `prompts/**`, `inputs/**`, `files/**` text files and cross-validates
 *      through the real `materializeTemplate` with `bundleFiles` — composition
 *      and seed resolution included — as deeply frozen data.
 *   3. The generator fails closed with a precise message on a bad manifest,
 *      a missing referenced file (prompt, defaultFile, seed source, and history
 *      content included), an oversized file, a binary/invalid-UTF-8 file, a
 *      traversal path, an absolute path, and bad CLI usage.
 *   4. Freshness is red on a source edit and green after regeneration (proven
 *      on a `/tmp` copy so the committed module is never touched), and a
 *      content change changes `REALM_CONTENT_VERSION`.
 *   5. The generated module is data-only (header + one type import + the
 *      version constant + the bundle list) and carries no secret material or
 *      absolute paths.
 *   6. History references embed and materialize through the real catalog, and
 *      format-v1 seed origins (fixed/user/generated) resolve end-to-end.
 *
 *   These tests pin pipeline mechanics, never the bundle wording.
 */

import '../test_env.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BAKED_TEMPLATE_BUNDLES,
  DEMO_TEMPLATE,
  REALM_CONTENT_VERSION,
  getBakedTemplateBundle,
  materializeTemplate
} from '../../src/lib/sandbox/realmCatalog/index.ts';

/** Repository root. */
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

/** Generator under test. */
const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts/embed_realm_content.mjs');

/** Committed generated module. */
const GENERATED_PATH = path.join(PROJECT_ROOT, 'src/lib/sandbox/realmCatalog/content.generated.ts');

/** Real bundle sources. */
const TEMPLATES_ROOT = path.join(PROJECT_ROOT, 'templates');

/** Scratch root for fixtures (created under the OS temp dir). */
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'realm-pipeline-'));

/** Per-file embed cap mirrored from the generator. */
const MAX_FILE_BYTES = 256 * 1024;

/** Bundle-relative directories whose files may be embedded. */
const INLINE_PREFIXES = ['prompts/', 'inputs/', 'files/'];

/** Scratch directories created by this suite, removed on exit. */
const scratchDirs = [TMP_ROOT];

/**
 * Creates one scratch directory under the suite scratch root.
 *
 * @param {string} label Short label embedded in the directory name.
 * @returns {string} Absolute scratch directory path.
 */
function createScratchDir(label) {
  fs.mkdirSync(TMP_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TMP_ROOT, `realm-content-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

/**
 * Runs the embed generator.
 *
 * @param {string[]} args CLI arguments.
 * @returns {{ status: number, stdout: string, stderr: string }} Process result.
 */
function runGenerator(args) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8'
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/**
 * Builds a minimal valid manifest referencing one prompt file.
 *
 * @param {string} id Template id (must match the bundle directory).
 * @returns {object} Manifest literal.
 */
function baseManifest(id) {
  return {
    id,
    name: `Fixture ${id}`,
    description: 'pipeline fixture',
    formatVersion: 1,
    agents: [
      {
        key: 'agent',
        idPattern: `fixture-${id}`,
        name: 'Fixture Agent',
        role: 'worker',
        prompt: [{ kind: 'file', path: 'prompts/protocol.md' }],
        toolProfile: { preset: 'readonly' },
        privileged: false
      }
    ]
  };
}

/**
 * Writes one fixture bundle under a templates root.
 *
 * @param {string} root Templates root.
 * @param {string} id Bundle directory/template id.
 * @param {object} [options] Fixture options.
 * @param {object|string} [options.manifest] Manifest object, raw JSON text, or default fixture.
 * @param {Record<string, string|Buffer>} [options.files] Files to write (bundle-relative path -> content).
 * @returns {string} Bundle directory.
 */
function writeBundle(root, id, { manifest = null, files = {} } = {}) {
  const bundleDir = path.join(root, id);
  fs.mkdirSync(bundleDir, { recursive: true });
  const manifestText = manifest === null
    ? JSON.stringify(baseManifest(id), null, 2)
    : typeof manifest === 'string'
      ? manifest
      : JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(bundleDir, 'template.json'), manifestText, 'utf-8');
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(bundleDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return bundleDir;
}

/**
 * Extracts `REALM_CONTENT_VERSION` from a generated module text.
 *
 * @param {string} text Generated module text.
 * @returns {string|null} Version string, or null when absent.
 */
function extractVersion(text) {
  const match = text.match(/REALM_CONTENT_VERSION[^=]*= '([^']+)'/);
  return match ? match[1] : null;
}

after(() => {
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 1. Freshness + determinism of the committed module
// ============================================================================

test('1. committed content.generated.ts is fresh and generation is deterministic', () => {
  const check = runGenerator(['--check']);
  assert.equal(check.status, 0, `--check must pass for the committed module: ${check.stderr}`);
  assert.match(check.stdout, /embed_realm_content: OK sha256:[0-9a-f]{64}/);
  assert.match(check.stdout, /\d+ bundle\(s\)/);

  const committed = fs.readFileSync(GENERATED_PATH, 'utf-8');
  assert.ok(committed.startsWith('/**'), 'the generated module opens with its generated header');
  assert.match(committed, /GENERATED by/);
  assert.match(committed, /Regenerate: node scripts\/embed_realm_content\.mjs/);
  assert.match(REALM_CONTENT_VERSION, /^sha256:[0-9a-f]{64}$/);
  assert.equal(extractVersion(committed), REALM_CONTENT_VERSION, 'the embedded constant matches the exported version');

  // Byte-identical regeneration from a copy of the real sources, twice.
  const scratch = createScratchDir('determinism');
  const root = path.join(scratch, 'templates');
  fs.cpSync(TEMPLATES_ROOT, root, { recursive: true });
  const outA = path.join(scratch, 'a.generated.ts');
  const outB = path.join(scratch, 'b.generated.ts');

  const first = runGenerator(['--root', root, '--out', outA]);
  assert.equal(first.status, 0, first.stderr);
  const second = runGenerator(['--root', root, '--out', outB]);
  assert.equal(second.status, 0, second.stderr);

  const bytesA = fs.readFileSync(outA, 'utf-8');
  const bytesB = fs.readFileSync(outB, 'utf-8');
  assert.equal(bytesA, bytesB, 'two runs over the same sources must be byte-identical');
  assert.equal(bytesA, committed, 'a fresh generation must reproduce the committed module byte-for-byte');

  const checked = runGenerator(['--check', '--root', root, '--out', outA]);
  assert.equal(checked.status, 0, 'a freshly generated copy is check-green');
});

// ============================================================================
// 2. Baked bundles cross-validate through the real materializer
// ============================================================================

test('2. every baked bundle is frozen text-only data that materializes with its bundle files', () => {
  assert.ok(BAKED_TEMPLATE_BUNDLES.length >= 2, 'demo plus at least one generated bundle');
  assert.equal(BAKED_TEMPLATE_BUNDLES[0].template, DEMO_TEMPLATE, 'the demo fixture stays first');
  assert.deepEqual(BAKED_TEMPLATE_BUNDLES[0].files, {}, 'the demo bundle ships no files');
  assert.ok(Object.isFrozen(BAKED_TEMPLATE_BUNDLES), 'the bundle list is frozen');

  const ids = BAKED_TEMPLATE_BUNDLES.map((bundle) => bundle.template.id);
  assert.deepEqual(
    [...ids.slice(1)].sort(),
    ids.slice(1),
    'the generated bundles are registered in sorted template id order after the demo fixture'
  );

  for (const bundle of BAKED_TEMPLATE_BUNDLES) {
    assert.ok(Object.isFrozen(bundle), `${bundle.template.id}: bundle container frozen`);
    assert.ok(Object.isFrozen(bundle.files), `${bundle.template.id}: file map frozen`);
    assert.ok(Object.isFrozen(bundle.template), `${bundle.template.id}: template deep-frozen`);

    for (const [bundlePath, body] of Object.entries(bundle.files)) {
      assert.equal(typeof body, 'string', `${bundle.template.id}: '${bundlePath}' must be a string`);
      assert.ok(
        INLINE_PREFIXES.some((prefix) => bundlePath.startsWith(prefix)),
        `${bundle.template.id}: '${bundlePath}' must live under prompts/, inputs/, or files/`
      );
      assert.ok(!bundlePath.includes('\\'), `${bundle.template.id}: '${bundlePath}' uses forward slashes`);
      assert.ok(!bundlePath.split('/').includes('..'), `${bundle.template.id}: '${bundlePath}' is traversal-free`);
    }
    assert.ok(!Object.keys(bundle.files).includes('template.json'), 'the manifest is a field, not a bundle file');

    // Referenced bundle files resolve, including defaultFile prefills and seed
    // sources: materialization fails closed when anything is missing.
    for (const input of bundle.template.inputs ?? []) {
      if (input.defaultFile !== undefined) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(bundle.files, input.defaultFile),
          `${bundle.template.id}: defaultFile '${input.defaultFile}' is embedded`
        );
      }
    }
    for (const file of bundle.template.seed?.files ?? []) {
      // `user`/`generated` slots carry no `source` (their bytes arrive at
      // launch or from a hydration package); only `fixed` sources must embed.
      if (file.source && 'file' in file.source) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(bundle.files, file.source.file),
          `${bundle.template.id}: seed source '${file.source.file}' is embedded`
        );
      }
    }

    const requiredValues = Object.fromEntries(
      (bundle.template.inputs ?? [])
        .filter((input) => input.required === true)
        .map((input) => [input.id, `required-${input.id}`])
    );
    // Generated seed slots are hydrated at launch: supply a synthetic body per
    // generated slot so cross-validation exercises the success path (test 6
    // pins the missing-hydration failure separately).
    const hydrationFiles = (bundle.template.seed?.files ?? [])
      .filter((file) => (file.origin ?? 'fixed') === 'generated')
      .map((file) => ({ path: file.path, target: file.target, content: `Generated ${file.path} body.` }));
    const plan = materializeTemplate(bundle.template, {
      realmId: 'realm_pipeline_probe',
      inputValues: requiredValues,
      bundleFiles: bundle.files,
      hydrationFiles
    });
    assert.equal(plan.templateId, bundle.template.id);
    assert.equal(plan.realmId, 'realm_pipeline_probe');
    assert.ok(Object.isFrozen(plan), `${bundle.template.id}: plan frozen`);
    assert.ok(plan.agents.length >= 1, `${bundle.template.id}: at least one agent`);
    for (const agentPlan of plan.agents) {
      assert.ok(typeof agentPlan.systemPrompt === 'string' && agentPlan.systemPrompt.length > 0,
        `${bundle.template.id}/${agentPlan.key}: composed prompt from bundle files`);
    }

    // A prompt file part's body must reach the composed prompt verbatim.
    for (const spec of bundle.template.agents) {
      for (const part of spec.prompt) {
        if (part.kind === 'file' && bundle.files[part.path].trim().length > 0) {
          const agentPlan = plan.agents.find((candidate) => candidate.key === spec.key);
          assert.ok(
            agentPlan.systemPrompt.includes(bundle.files[part.path]),
            `${bundle.template.id}/${spec.key}: '${part.path}' contributes verbatim`
          );
        }
      }
    }
  }

  // The accessor exposes the same frozen objects by id.
  for (const bundle of BAKED_TEMPLATE_BUNDLES) {
    assert.equal(getBakedTemplateBundle(bundle.template.id), bundle);
  }
  assert.equal(getBakedTemplateBundle('ghost'), null);
  assert.equal(getBakedTemplateBundle(''), null);
  assert.equal(getBakedTemplateBundle('   '), null);
  assert.equal(getBakedTemplateBundle(42), null);
});

// ============================================================================
// 3. Fail-closed generation (precise messages, fixtures under /tmp)
// ============================================================================

test('3. the generator fails closed on bad bundles, files, and CLI usage', () => {
  const cases = [
    {
      name: 'invalid JSON manifest',
      setup: (root) => writeBundle(root, 'bad_json', { manifest: '{ not json' }),
      pattern: /bundle 'bad_json': template\.json is not valid JSON/
    },
    {
      name: 'manifest without agents',
      setup: (root) => writeBundle(root, 'no_agents', {
        manifest: { id: 'no_agents', name: 'No agents', description: '', formatVersion: 1 }
      }),
      pattern: /bundle 'no_agents': 'agents' must be a non-empty array/
    },
    {
      name: 'manifest id mismatching the directory',
      setup: (root) => writeBundle(root, 'dir_name', {
        manifest: { ...baseManifest('dir_name'), id: 'other_id' }
      }),
      pattern: /template\.json id 'other_id' must match the bundle directory name/
    },
    {
      name: 'unsupported formatVersion',
      setup: (root) => writeBundle(root, 'old_format', {
        manifest: { ...baseManifest('old_format'), formatVersion: 2 }
      }),
      pattern: /formatVersion must be 1 \(got '2'\)/
    },
    {
      name: 'missing referenced prompt file',
      setup: (root) => writeBundle(root, 'missing_file'),
      pattern: /bundle 'missing_file': referenced bundle file 'prompts\/protocol\.md' is not embedded/
    },
    {
      name: 'missing referenced defaultFile',
      setup: (root) => writeBundle(root, 'missing_default', {
        manifest: {
          ...baseManifest('missing_default'),
          inputs: [{ id: 'prefill', label: 'Prefill', defaultFile: 'inputs/prefill.md' }]
        },
        files: { 'prompts/protocol.md': 'Protocol.' }
      }),
      pattern: /referenced bundle file 'inputs\/prefill\.md' is not embedded/
    },
    {
      name: 'missing referenced seed source',
      setup: (root) => writeBundle(root, 'missing_seed', {
        manifest: {
          ...baseManifest('missing_seed'),
          seed: { files: [{ path: 'notes.md', target: 'realm', source: { file: 'files/notes.md' } }] }
        },
        files: { 'prompts/protocol.md': 'Protocol.' }
      }),
      pattern: /referenced bundle file 'files\/notes\.md' is not embedded/
    },
    {
      name: 'missing referenced history file',
      setup: (root) => writeBundle(root, 'missing_history', {
        manifest: {
          ...baseManifest('missing_history'),
          agents: [
            {
              ...baseManifest('missing_history').agents[0],
              history: [{ role: 'assistant', content: [{ kind: 'file', path: 'files/opener.md' }] }]
            }
          ]
        },
        files: { 'prompts/protocol.md': 'Protocol.' }
      }),
      pattern: /referenced bundle file 'files\/opener\.md' is not embedded/
    },
    {
      name: 'oversized file',
      setup: (root) => writeBundle(root, 'oversized', {
        files: {
          'prompts/protocol.md': 'Protocol.',
          'files/big.md': 'x'.repeat(MAX_FILE_BYTES + 1)
        }
      }),
      pattern: /files\/big\.md is 262145 bytes; the per-file cap is 262144/
    },
    {
      name: 'binary file (null byte)',
      setup: (root) => writeBundle(root, 'binary', {
        files: {
          'prompts/protocol.md': Buffer.from([0x61, 0x00, 0x62]),
          'files/placeholder.md': 'x'
        }
      }),
      pattern: /prompts\/protocol\.md is binary \(null byte at offset 1\)/
    },
    {
      name: 'invalid UTF-8 file',
      setup: (root) => writeBundle(root, 'bad_utf8', {
        files: {
          'prompts/protocol.md': Buffer.from([0xff, 0xfe, 0xfd]),
          'files/placeholder.md': 'x'
        }
      }),
      pattern: /prompts\/protocol\.md is not valid UTF-8 text/
    },
    {
      name: 'traversal in a prompt part',
      setup: (root) => writeBundle(root, 'traversal_prompt', {
        manifest: {
          ...baseManifest('traversal_prompt'),
          agents: [
            {
              ...baseManifest('traversal_prompt').agents[0],
              prompt: [{ kind: 'file', path: '../escape.md' }]
            }
          ]
        },
        files: { 'files/placeholder.md': 'x' }
      }),
      pattern: /must not contain '\.\.' path segments/
    },
    {
      name: 'traversal in a seed source',
      setup: (root) => writeBundle(root, 'traversal_seed', {
        manifest: {
          ...baseManifest('traversal_seed'),
          seed: { files: [{ path: 'notes.md', target: 'realm', source: { file: '../escape.md' } }] }
        },
        files: { 'prompts/protocol.md': 'Protocol.' }
      }),
      pattern: /must not contain '\.\.' path segments/
    },
    {
      name: 'absolute bundle path',
      setup: (root) => writeBundle(root, 'absolute', {
        manifest: {
          ...baseManifest('absolute'),
          agents: [
            { ...baseManifest('absolute').agents[0], prompt: [{ kind: 'file', path: '/abs.md' }] }
          ]
        },
        files: { 'files/placeholder.md': 'x' }
      }),
      pattern: /must be bundle-relative/
    },
    {
      name: 'an empty templates root',
      setup: (root) => fs.mkdirSync(root, { recursive: true }),
      pattern: /no template bundles found under/
    }
  ];

  for (const scenario of cases) {
    const scratch = createScratchDir('reject');
    const root = path.join(scratch, 'templates');
    scenario.setup(root);
    const out = path.join(scratch, 'out.generated.ts');
    const result = runGenerator(['--check', '--root', root, '--out', out]);
    assert.equal(result.status, 1, `${scenario.name}: must exit 1, got ${result.status}\n${result.stderr}`);
    assert.match(result.stderr, scenario.pattern, `${scenario.name}: precise failure message`);
    assert.ok(!fs.existsSync(out), `${scenario.name}: no output is written on failure`);
  }

  // Missing root and bad usage.
  const scratch = createScratchDir('usage');
  const missingRoot = runGenerator(['--check', '--root', path.join(scratch, 'nope')]);
  assert.equal(missingRoot.status, 1);
  assert.match(missingRoot.stderr, /is not a directory/);

  const unknownOption = runGenerator(['--bogus']);
  assert.equal(unknownOption.status, 2);
  assert.match(unknownOption.stderr, /unknown option: --bogus/);

  const missingValue = runGenerator(['--root']);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /missing value for --root/);

  const help = runGenerator(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Regenerates the embedded Realm template content module/);
});

// ============================================================================
// 4. Freshness: red on a source edit, green after regen, version changes
// ============================================================================

test('4. a source edit makes --check red until the bundle is regenerated', () => {
  const scratch = createScratchDir('freshness');
  const root = path.join(scratch, 'templates');
  fs.cpSync(TEMPLATES_ROOT, root, { recursive: true });
  const out = path.join(scratch, 'out.generated.ts');

  const initial = runGenerator(['--root', root, '--out', out]);
  assert.equal(initial.status, 0, initial.stderr);
  const versionBefore = extractVersion(fs.readFileSync(out, 'utf-8'));
  assert.match(versionBefore, /^sha256:[0-9a-f]{64}$/);

  const green = runGenerator(['--check', '--root', root, '--out', out]);
  assert.equal(green.status, 0, green.stderr);

  const protocolPath = path.join(root, 'example_agent', 'prompts', 'protocol.md');
  fs.appendFileSync(protocolPath, '\n\n<!-- C2 freshness probe -->\n', 'utf-8');

  const red = runGenerator(['--check', '--root', root, '--out', out]);
  assert.equal(red.status, 1, 'an edited source must fail --check');
  assert.match(red.stderr, /generated content is stale/);
  assert.match(red.stderr, /committed version: sha256:[0-9a-f]{64}/);
  assert.match(red.stderr, /expected version:  sha256:[0-9a-f]{64}/);
  assert.match(
    red.stderr,
    new RegExp(`regenerate with:   node scripts/embed_realm_content\\.mjs --root ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --out`)
  );

  const regen = runGenerator(['--root', root, '--out', out]);
  assert.equal(regen.status, 0, regen.stderr);
  const versionAfter = extractVersion(fs.readFileSync(out, 'utf-8'));
  assert.notEqual(versionAfter, versionBefore, 'a content edit must change REALM_CONTENT_VERSION');

  const greenAgain = runGenerator(['--check', '--root', root, '--out', out]);
  assert.equal(greenAgain.status, 0, 'regeneration restores freshness');
});

// ============================================================================
// 5. The generated module is data-only and secret-free
// ============================================================================

test('5. the committed generated module is data-only, secret-free, and path-free', () => {
  const source = fs.readFileSync(GENERATED_PATH, 'utf-8');
  const dataStart = source.indexOf('export const GENERATED_TEMPLATE_BUNDLES');
  assert.ok(dataStart > 0, 'the bundle constant is present');

  const preamble = source
    .slice(0, dataStart)
    .replace(/\/\*\*[\s\S]*?\*\//g, '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  assert.deepEqual(preamble, [
    "import type { BakedTemplateBundle } from './types.ts';",
    `export const REALM_CONTENT_VERSION: string = '${REALM_CONTENT_VERSION}';`
  ], 'the generated module contains only its type import and the version constant before the data');

  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(source), 'no API-key-shaped material');
  assert.ok(!/api[_-]?key/i.test(source), 'no api-key references');
  assert.ok(!/authorization/i.test(source), 'no authorization headers');
  assert.ok(!/bearer\s/i.test(source), 'no bearer tokens');
  assert.ok(/(password|secret)\s*[:=]/i.test(source) === false, 'no secret assignments');
  assert.ok(!source.includes('/home/'), 'no absolute host paths');
  assert.ok(!source.includes('\u0000'), 'no null bytes');
});

// ============================================================================
// 6. Format-v1 history + origins through the real generator and catalog
// ============================================================================

test('6. history references embed and origin-aware slots materialize through the real catalog', () => {
  const scratch = createScratchDir('history');
  const root = path.join(scratch, 'templates');
  const files = {
    'prompts/protocol.md': 'Protocol body.',
    'files/opener.md': 'Rain hammers the roof.'
  };
  const manifest = {
    id: 'opener_fixture',
    name: 'Opener Fixture',
    description: 'format-v1 pipeline fixture',
    formatVersion: 1,
    inputs: [{ id: 'scene', label: 'Scene', origin: 'generated', brief: 'opening scene' }],
    agents: [
      {
        key: 'gm',
        idPattern: 'gm',
        name: 'GM',
        role: 'narrator',
        prompt: [{ kind: 'file', path: 'prompts/protocol.md' }, { kind: 'input', inputId: 'scene' }],
        toolProfile: { tools: [] },
        privileged: false,
        history: [
          {
            role: 'assistant',
            content: [{ kind: 'file', path: 'files/opener.md' }, { kind: 'input', inputId: 'scene' }]
          }
        ]
      }
    ],
    seed: {
      files: [
        { path: 'lore/world.md', target: 'realm', origin: 'generated', brief: 'world lore' },
        { path: 'notes.md', target: 'realm', origin: 'user' }
      ]
    }
  };
  writeBundle(root, 'opener_fixture', { manifest, files });

  const out = path.join(scratch, 'out.generated.ts');
  const generated = runGenerator(['--root', root, '--out', out]);
  assert.equal(generated.status, 0, generated.stderr);
  const text = fs.readFileSync(out, 'utf-8');
  assert.match(text, /files\/opener\.md/, 'the history file reference is embedded');
  assert.match(text, /Rain hammers the roof\./, 'the history file body is embedded');
  const checked = runGenerator(['--check', '--root', root, '--out', out]);
  assert.equal(checked.status, 0, 'the generated fixture module is check-green');

  const plan = materializeTemplate(manifest, {
    realmId: 'realm_pipeline_history',
    inputValues: { scene: 'A storm at sea.' },
    bundleFiles: files,
    hydrationFiles: [{ path: 'lore/world.md', target: 'realm', content: 'World lore body.' }]
  });
  assert.deepEqual(plan.agents[0].history, [
    { role: 'assistant', content: 'Rain hammers the roof.\n\nA storm at sea.', source: 'template' }
  ]);
  assert.deepEqual(
    plan.seed.files.map((file) => [file.path, file.content]),
    [['lore/world.md', 'World lore body.']],
    'the generated slot resolves and the absent optional user slot is skipped'
  );
  assert.ok(Object.isFrozen(plan.agents[0].history), 'plan history is frozen');

  assert.throws(
    () => materializeTemplate(manifest, {
      realmId: 'realm_pipeline_history',
      inputValues: { scene: 'A storm at sea.' },
      bundleFiles: files
    }),
    /seed slot 'lore\/world\.md' is generated but no hydration file was supplied/,
    'a missing generated slot fails closed through the real catalog'
  );
});
