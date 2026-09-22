#!/usr/bin/env node
/**
 * @file scripts/embed_realm_content.mjs
 * @description Bundle embed pipeline for the Realm catalog content: a
 * deterministic walk of `templates/<templateId>/` that inlines `template.json`
 * plus the `prompts/**`, `inputs/**`, and `files/**` text bodies into the
 * generated `src/lib/sandbox/realmCatalog/content.generated.ts` module consumed
 * by `realmCatalog`.
 *
 * Modes
 * -----
 * default         Regenerate the committed module (write `--out`).
 * `--check`       Regenerate in memory and byte-compare against `--out`; exit 1
 *                 on drift and print the exact regen command.
 * `--root <dir>`  Scan an alternate templates root (tests/fixtures).
 * `--out <file>`  Write/compare an alternate output file (tests/fixtures).
 *
 * Validation split
 * ----------------
 * This script owns bundle *mechanics* only: the manifest must parse as a JSON
 * object whose id matches its directory and whose formatVersion is 1, every
 * referenced bundle file must exist under the inline directories, bundle paths
 * must be safe forward-slash relative paths, and every embedded file must be
 * UTF-8 text within the per-file byte cap. The complete format-v1 template
 * schema (unknown fields, id patterns, input cross-references, origins,
 * history, presets, composition caps) is enforced against the generated
 * bundles by the pipeline test through the real `materializeTemplate`, so the
 * schema is never re-implemented here.
 *
 * Exit codes: 0 success, 1 validation/drift/write failure, 2 usage error.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Repository root (this script lives in `scripts/`). */
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/** Default bundle root: the repo's `templates/` directory. */
const DEFAULT_ROOT = path.join(PROJECT_ROOT, 'templates');

/** Default generated module path (committed; freshness-gated). */
const DEFAULT_OUT = path.join(PROJECT_ROOT, 'src/lib/sandbox/realmCatalog/content.generated.ts');

/** Bundle-relative directories whose text files are embedded. */
const INLINE_DIRECTORIES = Object.freeze(['prompts', 'inputs', 'files']);

/** Per-file embed cap in bytes (mirrors the design cap: 256 KB). */
const MAX_FILE_BYTES = 256 * 1024;

/** Repo-relative script path used in generated headers and regen hints. */
const REGEN_SCRIPT = 'scripts/embed_realm_content.mjs';

const USAGE = `Usage: node ${REGEN_SCRIPT} [--check] [--root <dir>] [--out <file>]

Regenerates the embedded Realm template content module.

  (no flags)      Write the generated module to '--out' (default:
                  src/lib/sandbox/realmCatalog/content.generated.ts).
  --check         Regenerate in memory and exit 1 when '--out' differs
                  (stale committed content); prints the exact regen command.
  --root <dir>    Read bundles from <dir> instead of templates/.
  --out <file>    Write/compare <file> instead of the committed module.
  -h, --help      Show this help.

Exit codes: 0 success, 1 validation/drift/write failure, 2 usage error.`;

/** Usage/argument error (exit code 2). */
class UsageError extends Error {}

/**
 * Throws a prefixed embed error (exit code 1).
 *
 * @param {string} message Problem description.
 */
function fail(message) {
  throw new Error(`embed_realm_content: ${message}`);
}

/**
 * Deterministic code-unit string ordering (locale-independent).
 *
 * @param {string} a Left string.
 * @param {string} b Right string.
 * @returns {number} Negative when `a` sorts first.
 */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Narrows a value to a plain non-array record.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} True for plain records.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Requires a non-empty string, returning it unmodified.
 *
 * @param {unknown} value Candidate value.
 * @param {string} label Human-readable label used in the error message.
 * @returns {string} The validated string.
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Validates a bundle-relative path: non-empty, forward-slash, relative, with no
 * null bytes, no `.`/`..`/empty segments, and no drive prefix.
 *
 * @param {unknown} value Candidate path.
 * @param {string} label Human-readable label used in the error message.
 * @returns {string} The validated path.
 */
function assertBundlePath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty bundle-relative path`);
  }
  if (value.includes('\0')) {
    fail(`${label} must not contain null bytes`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail(`${label} '${value}' must be bundle-relative`);
  }
  if (value.includes('\\')) {
    fail(`${label} '${value}' must use forward slashes`);
  }
  for (const segment of value.split('/')) {
    if (segment === '') {
      fail(`${label} '${value}' must not contain empty path segments`);
    }
    if (segment === '.' || segment === '..') {
      fail(`${label} '${value}' must not contain '${segment}' path segments`);
    }
  }
  return value;
}

/**
 * Reads one embedded bundle file, enforcing the byte cap, the text-only rule
 * (no null bytes), and strict UTF-8 decoding.
 *
 * @param {string} absolutePath File path on disk.
 * @param {string} bundlePath Bundle-relative path used in error messages.
 * @returns {string} Decoded text (bytes preserved, including line endings).
 */
function readBundleFile(absolutePath, bundlePath) {
  const bytes = fs.readFileSync(absolutePath);
  if (bytes.byteLength > MAX_FILE_BYTES) {
    fail(`${bundlePath} is ${bytes.byteLength} bytes; the per-file cap is ${MAX_FILE_BYTES}`);
  }
  const nullIndex = bytes.indexOf(0);
  if (nullIndex !== -1) {
    fail(`${bundlePath} is binary (null byte at offset ${nullIndex}); only UTF-8 text files are embedded`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${bundlePath} is not valid UTF-8 text; only UTF-8 text files are embedded`);
  }
}

/**
 * Walks one inline directory of a bundle (`prompts`/`inputs`/`files`) and adds
 * every regular file to the bundle file map under its bundle-relative path.
 *
 * @param {string} bundleDir Absolute bundle directory.
 * @param {string} bundleId Bundle id (for error labels).
 * @param {string} dirName Inline directory name.
 * @param {Map<string, string>} files Bundle path -> text accumulator.
 */
function collectInlineFiles(bundleDir, bundleId, dirName, files) {
  const absoluteRoot = path.join(bundleDir, dirName);
  if (!fs.existsSync(absoluteRoot)) return;
  if (!fs.statSync(absoluteRoot).isDirectory()) {
    fail(`bundle '${bundleId}': '${dirName}' must be a directory`);
  }

  /**
   * Recursive walk in sorted entry order.
   *
   * @param {string} absoluteDir Current directory.
   * @param {string} relativeDir Bundle-relative directory prefix.
   */
  const walk = (absoluteDir, relativeDir) => {
    const entries = fs
      .readdirSync(absoluteDir, { withFileTypes: true })
      .sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const bundlePath = `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        fail(`bundle '${bundleId}': '${bundlePath}' is a symbolic link; only regular bundle files are embedded`);
      }
      if (entry.isDirectory()) {
        walk(absolutePath, bundlePath);
        continue;
      }
      if (!entry.isFile()) {
        fail(`bundle '${bundleId}': '${bundlePath}' is not a regular file`);
      }
      const validated = assertBundlePath(bundlePath, `bundle '${bundleId}' file '${bundlePath}'`);
      files.set(validated, readBundleFile(absolutePath, `bundle '${bundleId}': ${validated}`));
    }
  };

  walk(absoluteRoot, dirName);
}

/**
 * Collects bundle file references from one ordered part list (prompt or
 * history content), validating the structures it traverses.
 *
 * @param {unknown} parts Candidate part list.
 * @param {string} label Label used in error messages.
 * @param {(value: unknown, refLabel: string) => void} reference Reference accumulator.
 */
function collectPartReferences(parts, label, reference) {
  if (!Array.isArray(parts) || parts.length === 0) {
    fail(`${label} must be a non-empty array`);
  }
  parts.forEach((part, partIndex) => {
    const partLabel = `${label}[${partIndex}]`;
    if (!isRecord(part)) {
      fail(`${partLabel} must be an object`);
    }
    if (part.kind === 'file') {
      reference(part.path, `${partLabel}.path`);
    } else if (part.kind === 'input') {
      requireNonEmptyString(part.inputId, `${partLabel}.inputId`);
    } else if (part.kind === 'text') {
      if (typeof part.text !== 'string') {
        fail(`${partLabel}.text must be a string`);
      }
    } else {
      fail(`${partLabel} carries unknown prompt part kind '${String(part.kind)}'`);
    }
  });
}

/**
 * Collects every bundle file path the manifest references: agent `file` prompt
 * parts, `file` history content parts, input `defaultFile` prefills, and seed
 * `source.file` entries.
 *
 * The walk is fail-closed on the structures it must traverse (it cannot verify
 * references inside a malformed shape), but cross-reference and closed-shape
 * schema rules stay with `materializeTemplate` in the pipeline test.
 *
 * @param {Record<string, unknown>} manifest Parsed manifest.
 * @param {string} label Bundle label used in error messages.
 * @returns {Set<string>} Referenced bundle-relative paths.
 */
function collectReferencedBundlePaths(manifest, label) {
  const references = new Set();
  const reference = (value, refLabel) => {
    references.add(assertBundlePath(value, refLabel));
  };

  if (!Array.isArray(manifest.agents) || manifest.agents.length === 0) {
    fail(`${label}: 'agents' must be a non-empty array`);
  }
  manifest.agents.forEach((agent, agentIndex) => {
    if (!isRecord(agent)) {
      fail(`${label}: agents[${agentIndex}] must be an object`);
    }
    collectPartReferences(agent.prompt, `${label}: agents[${agentIndex}].prompt`, reference);
    if (agent.history !== undefined) {
      if (!Array.isArray(agent.history)) {
        fail(`${label}: agents[${agentIndex}].history must be an array`);
      }
      agent.history.forEach((entry, entryIndex) => {
        const entryLabel = `${label}: agents[${agentIndex}].history[${entryIndex}]`;
        if (!isRecord(entry)) {
          fail(`${entryLabel} must be an object`);
        }
        collectPartReferences(entry.content, `${entryLabel}.content`, reference);
      });
    }
  });

  if (manifest.inputs !== undefined) {
    if (!Array.isArray(manifest.inputs)) {
      fail(`${label}: 'inputs' must be an array`);
    }
    manifest.inputs.forEach((input, inputIndex) => {
      if (!isRecord(input)) {
        fail(`${label}: inputs[${inputIndex}] must be an object`);
      }
      if (input.defaultFile !== undefined) {
        reference(input.defaultFile, `${label}: inputs[${inputIndex}].defaultFile`);
      }
    });
  }

  if (manifest.seed !== undefined) {
    if (!isRecord(manifest.seed)) {
      fail(`${label}: 'seed' must be an object`);
    }
    if (manifest.seed.files !== undefined) {
      if (!Array.isArray(manifest.seed.files)) {
        fail(`${label}: seed.files must be an array`);
      }
      manifest.seed.files.forEach((file, fileIndex) => {
        if (!isRecord(file)) {
          fail(`${label}: seed.files[${fileIndex}] must be an object`);
        }
        if (isRecord(file.source) && file.source.file !== undefined) {
          reference(file.source.file, `${label}: seed.files[${fileIndex}].source.file`);
        }
      });
    }
  }

  return references;
}

/**
 * Collects one bundle: parses and mechanics-validates its manifest, walks the
 * inline directories, and fails closed on dangling references.
 *
 * @param {string} root Templates root.
 * @param {string} entryName Bundle directory name.
 * @returns {{ template: Record<string, unknown>, files: Record<string, string> }} Bundle payload.
 */
function collectBundle(root, entryName) {
  const bundleDir = path.join(root, entryName);
  const manifestPath = path.join(bundleDir, 'template.json');
  if (!fs.existsSync(manifestPath)) {
    fail(`bundle '${entryName}' has no template.json`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    fail(`bundle '${entryName}': template.json is not valid JSON (${err.message})`);
  }
  if (!isRecord(manifest)) {
    fail(`bundle '${entryName}': template.json must be a JSON object`);
  }

  const id = requireNonEmptyString(manifest.id, `bundle '${entryName}': template.json id`);
  if (id !== entryName) {
    fail(`bundle '${entryName}': template.json id '${id}' must match the bundle directory name`);
  }
  if (manifest.formatVersion !== 1) {
    fail(
      `bundle '${entryName}': template.json formatVersion must be 1 (got '${String(manifest.formatVersion)}')`
    );
  }

  const label = `bundle '${id}'`;
  const references = collectReferencedBundlePaths(manifest, label);

  const collected = new Map();
  for (const dirName of INLINE_DIRECTORIES) {
    collectInlineFiles(bundleDir, id, dirName, collected);
  }
  const files = Object.fromEntries([...collected.entries()].sort((a, b) => compareStrings(a[0], b[0])));

  for (const reference of references) {
    if (!Object.prototype.hasOwnProperty.call(files, reference)) {
      const embedded = Object.keys(files);
      fail(
        `${label}: referenced bundle file '${reference}' is not embedded`
        + ` (embedded files: ${embedded.length > 0 ? embedded.join(', ') : '(none)'})`
      );
    }
  }

  return { template: manifest, files };
}

/**
 * Walks a templates root deterministically and collects every bundle.
 *
 * @param {string} root Templates root directory.
 * @returns {Array<{ template: Record<string, unknown>, files: Record<string, string> }>} Bundles in sorted directory order.
 */
function collectBundles(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`templates root '${root}' is not a directory`);
  }
  const entries = fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => compareStrings(a.name, b.name));

  const bundles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      fail(`unexpected file '${entry.name}' in the templates root; bundles are directories with template.json`);
    }
    bundles.push(collectBundle(root, entry.name));
  }
  if (bundles.length === 0) {
    fail(`no template bundles found under '${root}'`);
  }

  const ids = new Set();
  for (const bundle of bundles) {
    const id = bundle.template.id;
    if (ids.has(id)) {
      fail(`duplicate template id '${id}'`);
    }
    ids.add(id);
  }
  return bundles;
}

/**
 * Renders the generated content module and its content hash.
 *
 * The hash covers the canonical embedded payload (templates in sorted id
 * order, each manifest and its bundle files in sorted bundle-relative path
 * order), so any content change changes the version and unchanged sources are
 * byte-stable.
 *
 * @param {Array<{ template: Record<string, unknown>, files: Record<string, string> }>} bundles Collected bundles.
 * @returns {{ content: string, version: string }} Generated module text and version.
 */
function renderModule(bundles) {
  const payload = bundles.map((bundle) => ({ template: bundle.template, files: bundle.files }));
  const version = `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
  const data = JSON.stringify(payload, null, 2);

  const content = [
    '/**',
    ' * Embedded Realm template bundle content — GENERATED by',
    ` * \`${REGEN_SCRIPT}\`; never edit by hand.`,
    ' *',
    ' * The payload embeds every `templates/<id>/` bundle (the `template.json`',
    ' * manifest plus its `prompts/**`, `inputs/**`, and `files/**` text bodies,',
    ` * capped at ${MAX_FILE_BYTES} bytes per file) so the sandbox resolves prompt parts`,
    ' * and seed sources without runtime file reads or `?raw` imports. The',
    ' * generator fails closed on malformed manifests, missing referenced files,',
    ' * oversized or binary files, and unsafe bundle paths; the complete format-v1',
    ' * schema is enforced against this generated data by the pipeline test through',
    ' * the real `materializeTemplate`.',
    ' *',
    ` * Regenerate: node ${REGEN_SCRIPT}`,
    ` * Freshness:  node ${REGEN_SCRIPT} --check`,
    ' */',
    '',
    "import type { BakedTemplateBundle } from './types.ts';",
    '',
    '/**',
    ' * Stable content hash of the embedded baked bundles (`sha256:<hex>`).',
    ' *',
    ' * The hash covers the canonical embedded payload: templates in sorted id',
    ' * order, each manifest and its bundle files in sorted bundle-relative path',
    ' * order. Any content change changes the hash, and generation is byte-stable',
    ' * for unchanged sources.',
    ' */',
    `export const REALM_CONTENT_VERSION: string = '${version}';`,
    '',
    '/**',
    ' * Embedded template bundles in sorted template id order.',
    ' *',
    ' * Each entry carries the verbatim manifest and its bundle file bodies keyed',
    ' * by bundle-relative path; `realmCatalog` deep-freezes and exposes this list',
    ' * behind the demo fixture as the baked launch catalog.',
    ' */',
    `export const GENERATED_TEMPLATE_BUNDLES: readonly BakedTemplateBundle[] = ${data};`,
    ''
  ].join('\n');

  return { content, version };
}

/**
 * Parses CLI arguments (fail-closed, no positional arguments).
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{ check: boolean, root: string|null, out: string|null, help: boolean }} Parsed options.
 */
function parseArgs(argv) {
  const options = { check: false, root: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--check') {
      options.check = true;
    } else if (token === '--help' || token === '-h') {
      options.help = true;
    } else if (token === '--root' || token === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`missing value for ${token}`);
      }
      options[token.slice(2)] = value;
      index += 1;
    } else {
      throw new UsageError(`unknown option: ${token}`);
    }
  }
  return options;
}

/**
 * Runs the generator.
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {number} Process exit code.
 */
function run(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const root = options.root !== null ? path.resolve(options.root) : DEFAULT_ROOT;
  const out = options.out !== null ? path.resolve(options.out) : DEFAULT_OUT;
  const bundles = collectBundles(root);
  const { content, version } = renderModule(bundles);

  const regenParts = ['node', REGEN_SCRIPT];
  if (options.root !== null) regenParts.push('--root', options.root);
  if (options.out !== null) regenParts.push('--out', options.out);
  const regenCommand = regenParts.join(' ');

  if (options.check) {
    let committed = null;
    try {
      committed = fs.readFileSync(out, 'utf-8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    if (committed === content) {
      process.stdout.write(`embed_realm_content: OK ${version} (${bundles.length} bundle(s)) from ${root}\n`);
      return 0;
    }
    const committedMatch = committed === null ? null : committed.match(/REALM_CONTENT_VERSION[^=]*= '([^']+)'/);
    const committedVersion = committed === null ? '(missing)' : committedMatch ? committedMatch[1] : '(unrecognized)';
    process.stderr.write(`embed_realm_content: generated content is stale: ${out}\n`);
    process.stderr.write(`  committed version: ${committedVersion}\n`);
    process.stderr.write(`  expected version:  ${version}\n`);
    process.stderr.write(`  regenerate with:   ${regenCommand}\n`);
    return 1;
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, content, 'utf-8');
  const fileCount = bundles.reduce((sum, bundle) => sum + Object.keys(bundle.files).length, 0);
  process.stdout.write(
    `embed_realm_content: wrote ${out} (${version}, ${bundles.length} bundle(s), ${fileCount} file(s)) from ${root}\n`
  );
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`embed_realm_content: ${err.message}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
