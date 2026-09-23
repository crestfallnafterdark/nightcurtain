#!/usr/bin/env node
/**
 * @file tests/qa/compose_hydration_payload.mjs
 * @description QA-only composer for a local format-v2 hydration fixture: reads
 * an operator-owned source directory (default `../IS` relative to the repository
 * root) plus a local template fixture directory (default
 * `data/qa/hydration-fixture/template`, gitignored), assembles the canonical
 * format-v2 payload and the canonical transport bundle, validates both through
 * the real `realmCatalog`, and writes two artifacts for the hydration run.
 *
 * Only this script touches source bytes: it reads them at runtime and prints
 * counts, byte sizes, digests, and paths only — never file content, and never
 * external paths or URLs inside the payload (provenance stays neutral).
 *
 * Source layout (payload source)
 * ------------------------------
 *   <source>/prompts/Genesis     -> director_brief
 *   <source>/prompts/Narrator    -> narrator_brief
 *   <source>/lore/**\/*.md       -> lore fileset (sorted; paths 1:1 relative to lore/)
 *   <source>/opening_scene.md    -> opening_scene (optional; neutral fallback otherwise)
 *
 * Fixture layout (template source, untracked)
 * -------------------------------------------
 *   <fixture>/template.json          authored format-v2 manifest
 *   <fixture>/prompts|inputs|files/** referenced bundle files (UTF-8 text)
 *
 * Usage
 * -----
 *   node tests/qa/compose_hydration_payload.mjs [--source <dir>] [--fixture <dir>] [--out <file>] [--bundle-out <file>]
 *
 * Defaults: source `<repo>/../IS`, fixture `<repo>/data/qa/hydration-fixture/template`,
 * payload `<repo>/data/qa/hydration-fixture/payload-v2.json`,
 * bundle `<repo>/data/qa/hydration-fixture/bundle-v2.json`.
 *
 * Exit codes: 0 success, 1 validation/read/write failure, 2 usage error.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  parseTemplateBundle,
  payloadDigest,
  serializeTemplateBundle,
  validatePayload
} from '../../src/lib/sandbox/realmCatalog/index.ts';

/** Repository root (this script lives in `tests/qa/`). */
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** Default source directory: `../IS` relative to the repository root. */
const DEFAULT_SOURCE = path.resolve(PROJECT_ROOT, '..', 'IS');

/** Default template fixture directory (untracked, under the ignored `data/`). */
const DEFAULT_FIXTURE = path.join(PROJECT_ROOT, 'data/qa/hydration-fixture/template');

/** Default payload artifact path (ignored). */
const DEFAULT_OUT = path.join(PROJECT_ROOT, 'data/qa/hydration-fixture/payload-v2.json');

/** Default transport-bundle artifact path (ignored). */
const DEFAULT_BUNDLE_OUT = path.join(PROJECT_ROOT, 'data/qa/hydration-fixture/bundle-v2.json');

/** Bundle directories the fixture may carry inline text files in. */
const FIXTURE_INLINE_DIRS = ['prompts', 'inputs', 'files'];

/** Neutral, source-free opening scene used when the source ships none. */
const FALLBACK_OPENING_SCENE =
  'The story opens quietly: one place, one moment, and someone about to make the first choice.';

/** Per-file publishing cap in bytes (mirrors the host's 2 MiB plumbing cap). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Payload-total publishing cap in bytes (mirrors the host's 8 MiB package cap). */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

const USAGE = `Usage: node tests/qa/compose_hydration_payload.mjs [options]

Composes and validates the format-v2 payload + transport bundle for a local
hydration fixture from an operator-owned source directory.

Options:
  --source <dir>       Source directory (default: ../IS relative to the repo root).
  --fixture <dir>      Template fixture directory (default: data/qa/hydration-fixture/template).
  --out <file>         Payload artifact path (default: data/qa/hydration-fixture/payload-v2.json).
  --bundle-out <file>  Transport-bundle artifact path (default: data/qa/hydration-fixture/bundle-v2.json).
  -h, --help           Show this help.

The script prints counts, byte sizes, digests, and paths only; it never echoes
source content. Exit codes: 0 success, 1 failure, 2 usage error.`;

/** Usage/argument error (exit code 2). */
class UsageError extends Error {}

/**
 * Throws a prefixed composer error (exit code 1).
 *
 * @param {string} message Problem description.
 */
function fail(message) {
  throw new Error(`compose_hydration_payload: ${message}`);
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
 * Validates a fileset-relative path (non-empty, forward-slash, relative, no
 * null bytes, no `.`/`..`/empty segments, no drive prefix, no reserved names).
 *
 * @param {string} value Candidate path.
 * @param {string} label Human-readable label used in error messages.
 * @returns {string} The validated path.
 */
function assertFilesetPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} must be a non-empty fileset-relative path`);
  }
  if (value.includes('\0')) {
    fail(`${label} must not contain null bytes`);
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    fail(`${label} '${value}' must be fileset-relative`);
  }
  if (value.includes('\\')) {
    fail(`${label} '${value}' must use forward slashes`);
  }
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '') {
      fail(`${label} '${value}' must not contain empty path segments`);
    }
    if (segment === '.' || segment === '..') {
      fail(`${label} '${value}' must not contain '${segment}' path segments`);
    }
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      fail(`${label} '${value}' must not contain the reserved name '${segment}'`);
    }
  }
  return value;
}

/**
 * Reads one source file as strict UTF-8 text under the per-file cap.
 *
 * @param {string} absolutePath File path on disk.
 * @param {string} label Human-readable label used in error messages.
 * @returns {string} Decoded text.
 */
function readTextFile(absolutePath, label) {
  let bytes;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch (error) {
    fail(`${label} cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
  if (bytes.byteLength > MAX_FILE_BYTES) {
    fail(`${label} is ${bytes.byteLength} bytes; the per-file cap is ${MAX_FILE_BYTES}`);
  }
  if (bytes.indexOf(0) !== -1) {
    fail(`${label} is binary (null byte present); only UTF-8 text files are supported`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8 text`);
  }
}

/**
 * Collects the lore corpus: every `*.md` file under `<source>/lore/`, walked
 * recursively in sorted entry order, keyed by its path relative to `lore/`.
 *
 * Non-markdown entries are counted and skipped; symlinks and non-regular files
 * fail closed.
 *
 * @param {string} loreDir Absolute lore directory.
 * @returns {{ files: Array<{ path: string, content: string }>, skipped: number }} Fileset and skipped-entry count.
 */
function collectLoreFiles(loreDir) {
  if (!fs.existsSync(loreDir) || !fs.statSync(loreDir).isDirectory()) {
    fail(`lore directory '${loreDir}' is not a directory`);
  }
  const files = [];
  let skipped = 0;

  /**
   * Recursive walk in sorted entry order.
   *
   * @param {string} absoluteDir Current directory.
   * @param {string} relativeDir Fileset-relative directory prefix.
   */
  const walk = (absoluteDir, relativeDir) => {
    const entries = fs
      .readdirSync(absoluteDir, { withFileTypes: true })
      .sort((a, b) => compareStrings(a.name, b.name));
    for (const entry of entries) {
      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        fail(`lore entry '${relativePath}' is a symbolic link; only regular files are supported`);
      }
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        fail(`lore entry '${relativePath}' is not a regular file`);
      }
      if (!entry.name.toLowerCase().endsWith('.md')) {
        skipped += 1;
        continue;
      }
      const validated = assertFilesetPath(relativePath, `lore file '${relativePath}'`);
      files.push({
        path: validated,
        content: readTextFile(absolutePath, `lore file '${relativePath}'`)
      });
    }
  };

  walk(loreDir, '');
  if (files.length === 0) {
    fail(`lore directory '${loreDir}' contains no .md files`);
  }
  files.sort((a, b) => compareStrings(a.path, b.path));
  return { files, skipped };
}

/**
 * Collects the fixture's inline bundle files (`prompts/`, `inputs/`, `files/`)
 * into a path-keyed text map, walked in sorted entry order with the same
 * safe-path and UTF-8 rules as the embed pipeline.
 *
 * @param {string} fixtureDir Absolute template fixture directory.
 * @returns {Record<string, string>} Bundle files keyed by fixture-relative path.
 */
function collectFixtureFiles(fixtureDir) {
  const files = {};
  for (const dirName of FIXTURE_INLINE_DIRS) {
    const rootDir = path.join(fixtureDir, dirName);
    if (!fs.existsSync(rootDir)) continue;
    if (!fs.statSync(rootDir).isDirectory()) {
      fail(`fixture entry '${dirName}' is not a directory`);
    }
    /**
     * Recursive walk in sorted entry order.
     *
     * @param {string} absoluteDir Current directory.
     * @param {string} relativeDir Fixture-relative directory prefix.
     */
    const walk = (absoluteDir, relativeDir) => {
      const entries = fs
        .readdirSync(absoluteDir, { withFileTypes: true })
        .sort((a, b) => compareStrings(a.name, b.name));
      for (const entry of entries) {
        const absolutePath = path.join(absoluteDir, entry.name);
        const relativePath = `${relativeDir}/${entry.name}`;
        if (entry.isSymbolicLink()) {
          fail(`fixture entry '${relativePath}' is a symbolic link; only regular files are supported`);
        }
        if (entry.isDirectory()) {
          walk(absolutePath, relativePath);
          continue;
        }
        if (!entry.isFile()) {
          fail(`fixture entry '${relativePath}' is not a regular file`);
        }
        const validated = assertFilesetPath(relativePath, `fixture file '${relativePath}'`);
        files[validated] = readTextFile(absolutePath, `fixture file '${relativePath}'`);
      }
    };
    walk(rootDir, dirName);
  }
  if (Object.keys(files).length === 0) {
    fail(`fixture directory '${fixtureDir}' carries no inline files (${FIXTURE_INLINE_DIRS.join('/, ')}/)`);
  }
  return files;
}

/**
 * Parses CLI arguments (fail-closed, no positional arguments).
 *
 * @param {string[]} argv Arguments after the script path.
 * @returns {{ source: string, fixture: string, out: string, bundleOut: string, help: boolean }} Parsed options.
 */
function parseArgs(argv) {
  const options = {
    source: DEFAULT_SOURCE,
    fixture: DEFAULT_FIXTURE,
    out: DEFAULT_OUT,
    bundleOut: DEFAULT_BUNDLE_OUT,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      options.help = true;
    } else if (token === '--source' || token === '--fixture' || token === '--out' || token === '--bundle-out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError(`missing value for ${token}`);
      }
      if (value.trim() === '') {
        throw new UsageError(`${token} requires a non-empty value`);
      }
      if (token === '--source') options.source = path.resolve(value);
      else if (token === '--fixture') options.fixture = path.resolve(value);
      else if (token === '--out') options.out = path.resolve(value);
      else options.bundleOut = path.resolve(value);
      index += 1;
    } else {
      throw new UsageError(`unknown option: ${token}`);
    }
  }
  return options;
}

/**
 * Renders the per-input byte-size summary from the validated payload.
 *
 * @param {Record<string, { shape: 'text', text: string } | { shape: 'files', files: readonly { path: string, content: string }[] }>} inputs Validated input values.
 * @returns {{ lines: string[], totalBytes: number }} Summary lines and total bytes.
 */
function summarizeInputs(inputs) {
  const lines = [];
  let totalBytes = 0;
  for (const inputId of Object.keys(inputs)) {
    const value = inputs[inputId];
    if (value.shape === 'text') {
      const bytes = Buffer.byteLength(value.text, 'utf8');
      totalBytes += bytes;
      lines.push(`    ${inputId.padEnd(16)} text   ${String(bytes).padStart(9)} bytes`);
    } else {
      const bytes = value.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0);
      totalBytes += bytes;
      lines.push(
        `    ${inputId.padEnd(16)} files  ${String(bytes).padStart(9)} bytes (${value.files.length} file(s))`
      );
    }
  }
  return { lines, totalBytes };
}

/**
 * Runs the composer and returns the process exit code.
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

  if (!fs.existsSync(options.source) || !fs.statSync(options.source).isDirectory()) {
    fail(`source directory '${options.source}' is not a directory (pass --source <dir>)`);
  }
  if (!fs.existsSync(options.fixture) || !fs.statSync(options.fixture).isDirectory()) {
    fail(`fixture directory '${options.fixture}' is not a directory (pass --fixture <dir>)`);
  }
  // Validate the authored fixture through the real catalog: the transport
  // parser is the single source of truth for the template, its files, and the
  // authored content pin.
  const manifestPath = path.join(options.fixture, 'template.json');
  const manifest = JSON.parse(readTextFile(manifestPath, 'template.json'));
  const fixtureFiles = collectFixtureFiles(options.fixture);
  const parsed = parseTemplateBundle({ formatVersion: 2, template: manifest, files: fixtureFiles });
  const templateId = parsed.template.id;
  const templateVersion = parsed.version;

  const directorBrief = readTextFile(path.join(options.source, 'prompts', 'Genesis'), 'prompts/Genesis');
  const narratorBrief = readTextFile(path.join(options.source, 'prompts', 'Narrator'), 'prompts/Narrator');
  const lore = collectLoreFiles(path.join(options.source, 'lore'));

  const openingScenePath = path.join(options.source, 'opening_scene.md');
  const openingScene = fs.existsSync(openingScenePath)
    ? readTextFile(openingScenePath, 'opening_scene.md')
    : FALLBACK_OPENING_SCENE;

  const payload = {
    formatVersion: 2,
    templateId,
    templateVersion,
    inputs: {
      director_brief: { text: directorBrief },
      narrator_brief: { text: narratorBrief },
      lore: { files: lore.files },
      opening_scene: { text: openingScene }
    },
    provenance: { producer: 'tests/qa/compose_hydration_payload.mjs' }
  };

  // Validate in-process with the real catalog against the fixture template: a
  // failure here means the artifact must not be handed to the hydration run.
  const resolved = validatePayload(parsed.template, payload, { currentVersion: templateVersion });

  const payloadText = `${JSON.stringify(payload, null, 2)}\n`;
  const payloadBytes = Buffer.byteLength(payloadText, 'utf8');
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    fail(`payload is ${payloadBytes} bytes; the payload cap is ${MAX_PAYLOAD_BYTES}`);
  }

  // Canonical transport bundle for the import step; round-trip check the
  // canonical text so the pinned version is provably stable.
  const bundleText = serializeTemplateBundle({ template: parsed.template, files: parsed.files });
  const reparsed = parseTemplateBundle(bundleText);
  if (reparsed.version !== templateVersion) {
    fail(`internal: serialized bundle version '${reparsed.version}' does not match '${templateVersion}'`);
  }
  const bundleBytes = Buffer.byteLength(bundleText, 'utf8');

  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.mkdirSync(path.dirname(options.bundleOut), { recursive: true });
  fs.writeFileSync(options.out, payloadText, 'utf8');
  fs.writeFileSync(options.bundleOut, bundleText, 'utf8');

  const { lines, totalBytes } = summarizeInputs(resolved.inputs);
  const digest = payloadDigest(payload);
  const warnings = resolved.warnings.length;
  const openingSource = fs.existsSync(openingScenePath) ? 'source file' : 'neutral fallback';

  process.stdout.write(
    [
      'compose_hydration_payload: OK',
      `  template:         ${resolved.templateId}`,
      `  templateVersion:  ${resolved.templateVersion}`,
      `  payloadDigest:    ${digest}`,
      `  source:           ${options.source}`,
      `  fixture:          ${options.fixture}`,
      `  opening_scene:    ${openingSource}`,
      '  inputs:',
      ...lines,
      `  inputBytes:       ${totalBytes} (all inputs)`,
      ...(lore.skipped > 0 ? [`  skipped:          ${lore.skipped} non-markdown lore entr(ies)`] : []),
      `  validation:       ok (${warnings} warning(s))`,
      `  payload:          ${options.out} (${payloadBytes} bytes)`,
      `  bundle:           ${options.bundleOut} (${bundleBytes} bytes)`,
      ''
    ].join('\n')
  );
  return 0;
}

try {
  process.exitCode = run(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`compose_hydration_payload: ${err.message}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
