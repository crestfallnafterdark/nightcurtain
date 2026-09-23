#!/usr/bin/env node
/**
 * @file scripts/validate_realm_artifacts.mjs
 * @description Standalone validator for Realm authoring artifacts (format v2,
 * with the format-v1 read shim): template bundles (the canonical transport
 * document `{ formatVersion: 1|2, template, files }`) and payloads (the
 * format-v2 instance-content document, or a legacy format-v1 hydration
 * package) validated against a template.
 *
 * This script intentionally re-implements nothing: it imports the real
 * `realmCatalog` entry points and reports their typed results. The engine is
 * the single source of validation truth, so an artifact that passes here is an
 * artifact the host's import/submit pipeline accepts.
 *
 *   parseTemplateBundle()  bundle envelope + template + files + version (v1 or v2)
 *   validatePayload()        payload/package shape, coverage, version pin (fail-closed)
 *   hashText()               informational sha256 of the artifact file bytes
 *
 * A format-v1 bundle or package is accepted through the same entry points (the
 * v2 parser shims the authored v1 template and preserves its authored pin;
 * `validatePayload` converts a legacy package against the normalized model),
 * so pre-migration artifacts stay checkable.
 *
 * Usage: node scripts/validate_realm_artifacts.mjs <artifact.json> [options]
 *
 *   <artifact.json>            Bundle or payload/package (kind auto-detected)
 *   --kind bundle|package      Force the artifact kind
 *   --template <file>          Payload validation input: a transport bundle
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
  validatePayload
} from '../src/lib/sandbox/realmCatalog/index.ts';

const USAGE = `Usage: node scripts/validate_realm_artifacts.mjs <artifact.json> [options]

Validates a Realm template bundle or a format-v2 payload (legacy format-v1
hydration packages included) with the real realmCatalog validator (no
reimplementation).

Arguments:
  <artifact.json>            Bundle (transport JSON) or payload/package;
                             the kind is auto-detected unless --kind is given.

Options:
  --kind bundle|package      Force the artifact kind.
  --template <file>          Template for payload validation: a transport
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
 * Loads the `--template` input for payload validation.
 *
 * A transport bundle is parsed with the real `parseTemplateBundle()` (which
 * accepts either authored format, resolves bundle file references, and pins
 * the canonical version — the authored v1 pin included); a bare template spec
 * is passed through with no version, so the pin check is skipped. Either way
 * the template itself is validated by the real `validatePayload()` before any
 * payload check runs.
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
 * Validates a template bundle (either authored format) with the real catalog
 * parser, then round-trips its canonical transport text as a consistency check.
 *
 * @param {{file: string, text: string, value: unknown}} artifact Artifact input.
 * @returns {Record<string, unknown>} Validation summary.
 * @throws {RealmCatalogError} On an invalid bundle.
 */
function validateBundle(artifact) {
  const parsed = parseTemplateBundle(artifact.value);
  const reparsed = parseTemplateBundle(parsed.serialized);
  if (reparsed.version !== parsed.version) {
    throw new Error(
      `internal: canonical transport re-parses to version '${reparsed.version}' instead of '${parsed.version}'`
    );
  }
  const template = parsed.template;
  const inputs = template.inputs ?? [];
  const placements = template.placements ?? [];
  return {
    kind: 'bundle',
    file: artifact.file,
    templateId: template.id,
    templateName: template.name,
    sourceFormatVersion: parsed.sourceFormatVersion,
    version: parsed.version,
    fileCount: Object.keys(parsed.files).length,
    agents: template.agents.map((agent) => ({
      key: agent.key,
      idPattern: agent.idPattern,
      privileged: agent.privileged === true,
      authorities: Array.isArray(agent.authorities) ? [...agent.authorities] : []
    })),
    inputs: {
      total: inputs.length,
      text: inputs.filter((input) => input.shape === 'text').length,
      files: inputs.filter((input) => input.shape === 'files').length,
      required: inputs.filter((input) => input.required === true).length
    },
    placements: {
      total: placements.length,
      realm: placements.filter((placement) => placement.target === 'realm').length,
      agent: placements.filter((placement) => placement.target !== 'realm').length
    },
    warnings: [...parsed.warnings],
    fileHash: hashText(artifact.text)
  };
}

/**
 * Validates a format-v2 payload (or a legacy format-v1 hydration package)
 * against the `--template` input.
 *
 * @param {{file: string, text: string, value: unknown}} artifact Artifact input.
 * @param {string | null} templateFile `--template` path (required).
 * @returns {Record<string, unknown>} Validation summary.
 * @throws {UsageError} When `--template` is missing.
 * @throws {RealmCatalogError} On an invalid template or payload.
 */
function validatePackage(artifact, templateFile) {
  if (templateFile === null) {
    throw new UsageError('payload validation requires --template <template.json|bundle.json>');
  }
  const { template, currentVersion, form } = loadTemplateInput(templateFile);
  const resolved = validatePayload(
    template,
    artifact.value,
    currentVersion === null ? undefined : { currentVersion }
  );
  const payloadFormatVersion =
    isRecord(artifact.value) && artifact.value.formatVersion === 1 ? 1 : 2;
  // Legacy package entries carry their target; v2 payload entries do not
  // (destinations live only in the template), so the target is reported when
  // the authored document names one.
  const targetByPath = new Map();
  if (payloadFormatVersion === 1 && isRecord(artifact.value) && Array.isArray(artifact.value.files)) {
    for (const entry of artifact.value.files) {
      if (isRecord(entry) && typeof entry.path === 'string') {
        targetByPath.set(entry.path, entry.target);
      }
    }
  }
  const fileEntries = [];
  for (const inputId of Object.keys(resolved.inputs)) {
    const value = resolved.inputs[inputId];
    if (value.shape !== 'files') continue;
    for (const entry of value.files) {
      fileEntries.push({
        inputId,
        path: entry.path,
        target: targetByPath.has(entry.path) ? targetByPath.get(entry.path) : null
      });
    }
  }
  return {
    kind: 'package',
    file: artifact.file,
    templateFile,
    templateForm: form,
    payloadFormatVersion,
    templateId: resolved.templateId,
    pinnedVersion: resolved.templateVersion,
    currentVersion,
    versionCheck: currentVersion === null ? 'skipped' : 'match',
    inputValues: Object.keys(resolved.inputs),
    fileEntries,
    warnings: [...resolved.warnings],
    fileHash: hashText(artifact.text)
  };
}

/**
 * Renders a placement/file target for display.
 *
 * @param {{agent: string} | string | null} target Seed or file target.
 * @returns {string} Display form.
 */
function formatTarget(target) {
  if (target === null || target === undefined) return 'template destination';
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
    lines.push(`  file:       ${summary.file}`);
    lines.push(
      `  format:     authored v${summary.sourceFormatVersion}` +
        (summary.sourceFormatVersion === 1 ? ' (shimmed to the v2 model)' : '')
    );
    lines.push(`  version:    ${summary.version}`);
    lines.push(`  files:      ${summary.fileCount}`);
    lines.push(`  agents:     ${summary.agents.length} (${summary.agents.map((agent) => agent.key).join(', ')})`);
    lines.push(
      `  inputs:     ${summary.inputs.total} (${summary.inputs.text} text, ${summary.inputs.files} files; ` +
        `${summary.inputs.required} required)`
    );
    lines.push(
      `  placements: ${summary.placements.total} (${summary.placements.realm} realm, ${summary.placements.agent} agent)`
    );
    const declared = summary.agents.filter((agent) => agent.authorities.length > 0);
    if (declared.length > 0) {
      lines.push('  declared authorities (approval required at launch):');
      for (const agent of declared) {
        lines.push(`    ${agent.key} → ${agent.authorities.join(', ')}`);
      }
    }
  } else {
    lines.push(`realm-artifacts: OK payload for '${summary.templateId}'`);
    lines.push(`  file:       ${summary.file}`);
    lines.push(`  template:   ${summary.templateFile} (${summary.templateForm})`);
    lines.push(
      `  payload:    ${summary.payloadFormatVersion === 1 ? 'legacy format v1 (hydration package)' : 'format v2'}`
    );
    lines.push(
      `  pinned:     ${summary.pinnedVersion}` +
        (summary.versionCheck === 'match'
          ? ' (matches the current template version)'
          : ' (pin check skipped: pass a transport bundle as --template)')
    );
    lines.push(`  inputs:     ${summary.inputValues.length} value(s) (${summary.inputValues.join(', ') || 'none'})`);
    lines.push(
      `  files:      ${summary.fileEntries.length} fileset entry(ies)` +
        (summary.fileEntries.length > 0
          ? ` (${summary.fileEntries
              .map((entry) => `${entry.inputId}:${entry.path} → ${formatTarget(entry.target)}`)
              .join(', ')})`
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
        `'${options.file}' is neither a template bundle { formatVersion, template, files } nor a payload/package; ` +
          'use --kind to force one'
      );
    }
    if (kind === 'bundle' && options.template !== null) {
      throw new UsageError("--template only applies to payloads/packages (this artifact is a bundle)");
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
