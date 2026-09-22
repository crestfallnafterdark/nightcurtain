#!/usr/bin/env node
/**
 * @file scripts/validate_realm_artifacts.mjs
 * @description Standalone validator for Realm format-v1 authoring artifacts:
 * template bundles (the canonical transport document
 * `{ formatVersion: 1, template, files }`) and hydration packages (the
 * instance-content document validated against a template).
 *
 * This script intentionally re-implements nothing: it imports the real
 * `realmCatalog` entry points and reports their typed results. The engine is
 * the single source of validation truth, so an artifact that passes here is an
 * artifact the host's import/submit pipeline accepts.
 *
 *   parseTemplateBundle()       bundle envelope + template + files + version
 *   templateBundleVersion()     recomputed canonical version (consistency check)
 *   validateHydrationPackage()  package shape, slot matching, version pin (fail-closed)
 *   hashText()                  informational sha256 of the artifact file bytes
 *
 * Usage: node scripts/validate_realm_artifacts.mjs <artifact.json> [options]
 *
 *   <artifact.json>            Bundle or hydration package (kind auto-detected)
 *   --kind bundle|package      Force the artifact kind
 *   --template <file>          Package validation input: a transport bundle
 *                              (recommended — also checks the pinned version)
 *                              or a bare template.json spec (pin check skipped)
 *   --json                     Machine-readable result on stdout
 *   -h, --help                 Show this help
 *
 * Exit codes: 0 valid, 1 invalid artifact (typed catalog error),
 * 2 usage/input error, 3 unexpected internal error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  RealmCatalogError,
  hashText,
  parseTemplateBundle,
  templateBundleVersion,
  validateHydrationPackage
} from '../src/lib/sandbox/realmCatalog/index.ts';

const USAGE = `Usage: node scripts/validate_realm_artifacts.mjs <artifact.json> [options]

Validates a Realm format-v1 template bundle or hydration package with the real
realmCatalog validator (no reimplementation).

Arguments:
  <artifact.json>            Bundle (transport JSON) or hydration package;
                             the kind is auto-detected unless --kind is given.

Options:
  --kind bundle|package      Force the artifact kind.
  --template <file>          Template for package validation: a transport
                             bundle (recommended; also checks the pinned
                             templateVersion) or a bare template.json spec
                             (the pin check is then skipped).
  --json                     Print a machine-readable JSON result on stdout.
  -h, --help                 Show this help.

Exit codes: 0 valid · 1 invalid artifact (typed catalog error) ·
2 usage/input error · 3 unexpected internal error.`;

/** Usage/input error (exit code 2). */
class UsageError extends Error {}

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
 * Parses argv into options.
 *
 * @param {readonly string[]} argv Arguments after the script path.
 * @returns {{file: string | null, kind: 'bundle' | 'package' | null, template: string | null, json: boolean, help: boolean}} Parsed options
 * @throws {UsageError} On unknown options, missing option values, or extra positionals
 */
function parseArgs(argv) {
  const options = { file: null, kind: null, template: null, json: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inlineValue = equals === -1 ? null : arg.slice(equals + 1);
    if (name === '-h' || name === '--help') {
      options.help = true;
    } else if (name === '--json') {
      options.json = true;
    } else if (name === '--kind' || name === '--template') {
      let value = inlineValue;
      if (value === null) {
        index += 1;
        if (index >= argv.length) throw new UsageError(`option '${name}' requires a value`);
        value = argv[index];
      }
      if (value === '') throw new UsageError(`option '${name}' requires a non-empty value`);
      if (name === '--kind') {
        if (value !== 'bundle' && value !== 'package') {
          throw new UsageError(`--kind must be 'bundle' or 'package' (got '${value}')`);
        }
        options.kind = value;
      } else {
        options.template = value;
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      throw new UsageError(`unknown option '${arg}'`);
    } else if (options.file === null) {
      options.file = arg;
    } else {
      throw new UsageError(`unexpected argument '${arg}' (validate one artifact per invocation)`);
    }
  }
  return options;
}

/**
 * Reads a JSON file, distinguishing I/O errors from JSON syntax errors.
 *
 * @param {string} file Path as given on the command line.
 * @returns {{text: string, value: unknown}} File text and parsed JSON
 * @throws {UsageError} When the file cannot be read or is not valid JSON
 */
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read '${file}': ${error instanceof Error ? error.message : String(error)}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`'${file}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { text, value };
}

/**
 * Detects the artifact kind from the document shape.
 *
 * @param {unknown} value Parsed artifact JSON.
 * @returns {'bundle' | 'package' | null} Detected kind.
 */
function detectKind(value) {
  if (!isRecord(value)) return null;
  if (typeof value.templateId === 'string') return 'package';
  if (isRecord(value.template) || Array.isArray(value.agents)) return 'bundle';
  return null;
}

/**
 * Loads the `--template` input for package validation.
 *
 * A transport bundle is parsed with the real `parseTemplateBundle()` (which
 * resolves bundle file references and pins the canonical version); a bare
 * template spec is passed through with no version, so the pin check is
 * skipped. Either way the template itself is validated by the real
 * `validateHydrationPackage()` before any package check runs.
 *
 * @param {string} file Path as given on the command line.
 * @returns {{template: unknown, currentVersion: string | null, form: 'bundle' | 'spec'}} Template input
 * @throws {UsageError} When the file is neither form or cannot be read
 */
function loadTemplateInput(file) {
  const { value } = readJsonFile(file);
  if (isRecord(value) && isRecord(value.template) && isRecord(value.files)) {
    try {
      const parsed = parseTemplateBundle(value);
      return { template: parsed.template, currentVersion: parsed.version, form: 'bundle' };
    } catch (error) {
      throw new RealmCatalogError(
        `--template '${file}' is not a valid template bundle: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof RealmCatalogError ? error.code : 'ERR_TEMPLATE_INVALID',
        error instanceof RealmCatalogError ? error.details : undefined
      );
    }
  }
  if (isRecord(value) && typeof value.id === 'string' && Array.isArray(value.agents)) {
    return { template: value, currentVersion: null, form: 'spec' };
  }
  throw new UsageError(
    `--template '${file}' must be a transport bundle { formatVersion, template, files } or a template.json spec`
  );
}

/**
 * Validates a template bundle with the real catalog parser.
 *
 * @param {{file: string, text: string, value: unknown}} artifact Artifact input.
 * @returns {Record<string, unknown>} Validation summary.
 * @throws {RealmCatalogError} On an invalid bundle.
 */
function validateBundle(artifact) {
  const parsed = parseTemplateBundle(artifact.value);
  const recomputed = templateBundleVersion({ template: parsed.template, files: parsed.files });
  if (recomputed !== parsed.version) {
    throw new Error(
      `internal: parseTemplateBundle version '${parsed.version}' does not match templateBundleVersion '${recomputed}'`
    );
  }
  const inputs = parsed.template.inputs ?? [];
  const seedSlots = (parsed.template.seed?.files ?? []).map((slot) => ({
    path: slot.path,
    target: slot.target,
    origin: slot.origin ?? 'fixed'
  }));
  return {
    kind: 'bundle',
    file: artifact.file,
    templateId: parsed.template.id,
    templateName: parsed.template.name,
    version: parsed.version,
    fileCount: Object.keys(parsed.files).length,
    agents: parsed.template.agents.map((agent) => ({
      key: agent.key,
      idPattern: agent.idPattern,
      privileged: agent.privileged === true,
      authorities: Array.isArray(agent.authorities) ? [...agent.authorities] : []
    })),
    inputs: {
      total: inputs.length,
      user: inputs.filter((input) => (input.origin ?? 'user') === 'user').length,
      generated: inputs.filter((input) => input.origin === 'generated').length
    },
    seedSlots: {
      total: seedSlots.length,
      fixed: seedSlots.filter((slot) => slot.origin === 'fixed').length,
      user: seedSlots.filter((slot) => slot.origin === 'user').length,
      generated: seedSlots.filter((slot) => slot.origin === 'generated').length,
      slots: seedSlots
    },
    warnings: [...parsed.warnings],
    fileHash: hashText(artifact.text)
  };
}

/**
 * Validates a hydration package against the `--template` input.
 *
 * @param {{file: string, text: string, value: unknown}} artifact Artifact input.
 * @param {string | null} templateFile `--template` path (required).
 * @returns {Record<string, unknown>} Validation summary.
 * @throws {UsageError} When `--template` is missing.
 * @throws {RealmCatalogError} On an invalid template or package.
 */
function validatePackage(artifact, templateFile) {
  if (templateFile === null) {
    throw new UsageError('hydration package validation requires --template <template.json|bundle.json>');
  }
  const { template, currentVersion, form } = loadTemplateInput(templateFile);
  const resolved = validateHydrationPackage(
    template,
    artifact.value,
    currentVersion === null ? undefined : { currentVersion }
  );
  return {
    kind: 'package',
    file: artifact.file,
    templateFile,
    templateForm: form,
    templateId: resolved.templateId,
    pinnedVersion: resolved.templateVersion,
    currentVersion,
    versionCheck: currentVersion === null ? 'skipped' : 'match',
    inputValues: Object.keys(resolved.inputValues),
    fileEntries: resolved.files.map((entry) => ({ path: entry.path, target: entry.target })),
    warnings: [...resolved.warnings],
    fileHash: hashText(artifact.text)
  };
}

/**
 * Renders a seed-file target for display.
 *
 * @param {{agent: string} | string} target Seed target.
 * @returns {string} Display form.
 */
function formatTarget(target) {
  return target === 'realm' ? 'realm' : `agent:${target.agent}`;
}

/**
 * Renders the human-readable success report.
 *
 * @param {Record<string, unknown>} summary Validation summary.
 * @returns {string} Report text.
 */
function formatSuccess(summary) {
  const lines = [];
  if (summary.kind === 'bundle') {
    lines.push(`realm-artifacts: OK bundle '${summary.templateId}' (${summary.templateName})`);
    lines.push(`  file:      ${summary.file}`);
    lines.push(`  version:   ${summary.version}`);
    lines.push(`  files:     ${summary.fileCount}`);
    lines.push(`  agents:    ${summary.agents.length} (${summary.agents.map((agent) => agent.key).join(', ')})`);
    lines.push(
      `  inputs:    ${summary.inputs.total} (${summary.inputs.user} user, ${summary.inputs.generated} generated)`
    );
    lines.push(
      `  seed:      ${summary.seedSlots.total} slot(s) (${summary.seedSlots.fixed} fixed, ` +
        `${summary.seedSlots.user} user, ${summary.seedSlots.generated} generated)`
    );
    const declared = summary.agents.filter((agent) => agent.authorities.length > 0);
    if (declared.length > 0) {
      lines.push('  declared authorities (approval required at launch):');
      for (const agent of declared) {
        lines.push(`    ${agent.key} → ${agent.authorities.join(', ')}`);
      }
    }
  } else {
    lines.push(`realm-artifacts: OK hydration package for '${summary.templateId}'`);
    lines.push(`  file:       ${summary.file}`);
    lines.push(`  template:   ${summary.templateFile} (${summary.templateForm})`);
    lines.push(
      `  pinned:     ${summary.pinnedVersion}` +
        (summary.versionCheck === 'match'
          ? ' (matches the current template version)'
          : ' (pin check skipped: pass a transport bundle as --template)')
    );
    lines.push(`  inputs:     ${summary.inputValues.length} value(s) (${summary.inputValues.join(', ') || 'none'})`);
    lines.push(
      `  files:      ${summary.fileEntries.length} entry(ies)` +
        (summary.fileEntries.length > 0
          ? ` (${summary.fileEntries.map((entry) => `${entry.path} → ${formatTarget(entry.target)}`).join(', ')})`
          : '')
    );
  }
  lines.push(`  warnings:   ${summary.warnings.length === 0 ? 'none' : summary.warnings.join(' | ')}`);
  lines.push(`  file hash:  ${summary.fileHash} (informational: sha256 of the file bytes)`);
  return lines.join('\n');
}

/**
 * Renders the human-readable failure report.
 *
 * @param {string | null} kind Detected artifact kind, when known.
 * @param {string} file Artifact path.
 * @param {RealmCatalogError} error Typed catalog error.
 * @returns {string} Report text.
 */
function formatFailure(kind, file, error) {
  return [
    `realm-artifacts: INVALID ${kind ?? 'artifact'} '${file}'`,
    `  code:    ${error.code}`,
    `  message: ${error.message}`
  ].join('\n');
}

/**
 * Runs the validator and returns the process exit code.
 *
 * @param {readonly string[]} argv Arguments after the script path.
 * @param {{stdout?: (text: string) => void, stderr?: (text: string) => void}} [io] Output sinks (defaults to console).
 * @returns {number} Exit code (0 valid, 1 invalid, 2 usage/input, 3 unexpected).
 */
export function run(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => console.log(text));
  const stderr = io.stderr ?? ((text) => console.error(text));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`realm-artifacts: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  if (options.help) {
    stdout(USAGE);
    return 0;
  }
  if (options.file === null) {
    stderr(`realm-artifacts: missing artifact file\n${USAGE}`);
    return 2;
  }

  let kind = options.kind;
  try {
    const artifact = readJsonFile(options.file);
    if (kind === null) kind = detectKind(artifact.value);
    if (kind === null) {
      throw new UsageError(
        `'${options.file}' is neither a template bundle { formatVersion, template, files } nor a hydration package; ` +
          'use --kind to force one'
      );
    }
    if (kind === 'bundle' && options.template !== null) {
      throw new UsageError("--template only applies to hydration packages (this artifact is a bundle)");
    }
    const summary =
      kind === 'bundle'
        ? validateBundle({ file: options.file, text: artifact.text, value: artifact.value })
        : validatePackage({ file: options.file, text: artifact.text, value: artifact.value }, options.template);
    if (options.json) {
      stdout(JSON.stringify({ ok: true, kind, file: options.file, summary, error: null }, null, 2));
    } else {
      stdout(formatSuccess(summary));
    }
    return 0;
  } catch (error) {
    if (error instanceof RealmCatalogError) {
      if (options.json) {
        stdout(
          JSON.stringify(
            {
              ok: false,
              kind,
              file: options.file,
              summary: null,
              error: { code: error.code, message: error.message }
            },
            null,
            2
          )
        );
      } else {
        stderr(formatFailure(kind, options.file, error));
      }
      return 1;
    }
    if (error instanceof UsageError) {
      stderr(`realm-artifacts: ${error.message}`);
      return 2;
    }
    stderr(`realm-artifacts: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return 3;
  }
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(path.resolve(invoked)).href) {
  process.exitCode = run(process.argv.slice(2));
}
