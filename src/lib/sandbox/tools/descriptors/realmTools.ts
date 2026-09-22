/**
 * Realm publishing meta-tool descriptors for the Wave U `AgentSpec` publishing
 * surface: `import_realm_template` and `submit_hydration_package`.
 *
 * These two tools are explicit-grant-only meta tools. They are deliberately
 * **outside** the canonical 35-tool taxonomy (`SANDBOX_TOOLS`), are never
 * implied by the wildcard capability or `privileged`, and their schemas are
 * only ever exposed to callers whose frozen `AuthorityDescriptor` carries the
 * matching authority id (`@template:authority` / `@hydration:authority`).
 *
 * Both tools accept a `dry_run` validator mode: the identical resolve → validate
 * pipeline runs with zero side effects (no import, no candidate, no registry or
 * trust mutation) and returns the same typed receipt/errors, so generator
 * agents can iterate in-loop before committing.
 */

import { PUBLISHING_TOOLS, TOOL_SYSTEM_ERROR_CODES } from '../constants/index.ts';
import { createParamSanitizer } from '../normalizers/index.ts';
import {
  AGENT_AUTHORITIES,
  parseTemplateBundle,
  serializeTemplateBundle,
  validateHydrationPackage
} from '../../realmCatalog/index.ts';
import type { PendingInstancePayload, RealmTemplate } from '../../realmCatalog/index.ts';
import { FILE_PLUMBING_MAX_FILE_BYTES } from '../../virtualFs/index.ts';
import type { ExecutionContext, JsonSchemaDraft07, RealmPublishingPort } from '../../toolDefinitions/index.ts';

/** Sanitized canonical parameter record handed to a publishing descriptor handler. */
type ToolParams = Record<string, unknown>;

/**
 * Per-file byte cap applied to every resolved publishing reference
 * (`{ sourceFile }` manifest inputs/files). Mirrors the ratified Wave U
 * per-file cap (2 MiB) and the VFS file-plumbing cap.
 */
export const REALM_PUBLISHING_MAX_FILE_BYTES: number = FILE_PLUMBING_MAX_FILE_BYTES;

/**
 * Aggregate byte cap for one resolved template bundle (Wave U decision 9):
 * the canonical transport document may not exceed 3 MiB.
 */
export const REALM_PUBLISHING_MAX_BUNDLE_BYTES: number = 3 * 1024 * 1024;

/**
 * Aggregate byte cap for one resolved hydration package (Wave U decision 9):
 * resolved input values plus file contents may not exceed 8 MiB.
 */
export const REALM_PUBLISHING_MAX_PACKAGE_BYTES: number = 8 * 1024 * 1024;

/**
 * One publishing meta-tool descriptor: the canonical tool name, the explicit
 * authority id required to invoke it, and the standard descriptor contract.
 *
 * The `authority` member is the single capability declaration the dispatcher
 * consults; it is never derived from caller data.
 */
export interface PublishingToolDescriptor {
  /** Canonical publishing tool name (`PUBLISHING_TOOLS`). */
  readonly name: string;
  /** Explicit authority id required to invoke this tool (never wildcard-implied). */
  readonly authority: string;
  /** Full human-readable tool description provided to the LLM. */
  readonly description: string;
  /** Draft-07 parameter schema definition (closed shape). */
  readonly schema: JsonSchemaDraft07;
  /** Mapping of parameter aliases/hallucinations to canonical parameter names. */
  readonly paramAliasMap: Readonly<Record<string, string>>;
  /** Table-driven parameter sanitizer instance. */
  readonly sanitize: (rawArgs?: unknown) => Record<string, unknown>;
  /** Delegation handler bound to the injected host publishing port. */
  readonly handler: (params: ToolParams, context: ExecutionContext) => unknown;
}

/** Minimal structural view of the caller-scoped VirtualFS read surface. */
interface VirtualFsReadView {
  readFile(params: Record<string, unknown>, context?: unknown): unknown;
}

/** Structured failure receipt shape returned by the publishing handlers. */
interface PublishingFailure {
  success: false;
  error: string;
  code: string;
  details: Record<string, unknown>;
}

/**
 * Computes the UTF-8 byte length of a string without platform APIs, matching
 * the VFS file-plumbing accounting exactly.
 *
 * @param text - Source text.
 * @returns The UTF-8 byte length.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Narrows an unknown value to a plain non-array record.
 *
 * @param value - Candidate value.
 * @returns `true` for non-null, non-array objects.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds a structured `INVALID_ARGUMENTS` failure receipt.
 *
 * @param message - Human-readable failure description.
 * @param details - Machine-readable diagnostics (never secrets).
 * @returns A failure receipt in the tool-system vocabulary.
 */
function invalidArguments(message: string, details: Record<string, unknown> = {}): PublishingFailure {
  return { success: false, error: message, code: TOOL_SYSTEM_ERROR_CODES.INVALID_ARGUMENTS, details };
}

/**
 * Builds a structured `PERMISSION_DENIED` failure receipt.
 *
 * @param message - Human-readable failure description.
 * @param details - Machine-readable diagnostics (never secrets).
 * @returns A failure receipt in the tool-system vocabulary.
 */
function permissionDenied(message: string, details: Record<string, unknown> = {}): PublishingFailure {
  return { success: false, error: message, code: TOOL_SYSTEM_ERROR_CODES.PERMISSION_DENIED, details };
}

/**
 * Builds a structured `EXECUTION_FAILED` failure receipt.
 *
 * @param message - Human-readable failure description.
 * @param details - Machine-readable diagnostics (never secrets).
 * @returns A failure receipt in the tool-system vocabulary.
 */
function executionFailed(message: string, details: Record<string, unknown> = {}): PublishingFailure {
  return { success: false, error: message, code: TOOL_SYSTEM_ERROR_CODES.EXECUTION_FAILED, details };
}

/**
 * Maps a thrown reference-resolution/catalog/port error onto the declared
 * tool-system error vocabulary while preserving the upstream typed code in
 * `details.catalogCode`/`details.storeCode`.
 *
 * The dispatcher's universal error shield only preserves codes from
 * `TOOL_SYSTEM_ERROR_CODES`, so typed publishing failures travel as structured
 * failure receipts (`INVALID_ARGUMENTS`/`PERMISSION_DENIED`/`EXECUTION_FAILED`)
 * with the originating code retained in `details`.
 *
 * @param error - Unknown thrown value.
 * @returns A structured failure receipt.
 */
function failureFromError(error: unknown): PublishingFailure {
  const candidate = (error ?? {}) as { message?: unknown; code?: unknown; name?: unknown; details?: unknown };
  const message = typeof candidate.message === 'string' && candidate.message
    ? candidate.message
    : 'Realm publishing failed with an unhandled error.';
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  const details: Record<string, unknown> = {};
  if (code) details.upstreamCode = code;
  if (typeof candidate.name === 'string' && candidate.name) details.upstreamName = candidate.name;
  if (code === 'PERMISSION_DENIED') return permissionDenied(message, details);
  if (
    code === 'ERR_BUNDLE_FORMAT'
    || code === 'ERR_TEMPLATE_INVALID'
    || code === 'ERR_HYDRATION_PACKAGE'
    || code === 'ERR_HYDRATION_VERSION_MISMATCH'
    || code === 'ERR_STORE_TEMPLATE_TOO_LARGE'
    || code === 'ERR_STORE_TEMPLATE_PERSIST_FAILED'
    || code === 'INVALID_ARGUMENTS'
    || code === 'FILE_TOO_LARGE'
    || code === 'FILE_NOT_FOUND'
  ) {
    return invalidArguments(message, details);
  }
  return executionFailed(message, details);
}

/**
 * Reads one caller-visible source reference through the caller's existing
 * workspace view and enforces the per-file publishing cap.
 *
 * The read goes through the exact VirtualFS read path the caller already has
 * (`readFile` with the trusted execution context as options), so a publishing
 * reference can never read more than the caller could already read; traversal,
 * cross-scope, and peer escapes fail with the VFS's own typed errors and are
 * mapped to structured failure receipts.
 *
 * @param vfs - Caller-scoped VirtualFS read view.
 * @param context - Trusted execution context (identity/workspace binding).
 * @param sourceFile - Caller-supplied source path.
 * @param label - Parameter label used in failure messages.
 * @returns Resolved raw file content.
 * @throws `PublishingFailure`-shaped error carrying the structured receipt fields
 */
function readSourceFile(
  vfs: VirtualFsReadView,
  context: ExecutionContext,
  sourceFile: unknown,
  label: string
): string {
  if (typeof sourceFile !== 'string' || sourceFile.trim().length === 0) {
    throw invalidArguments(`${label} must be a non-empty string path`);
  }
  let content: unknown;
  try {
    content = vfs.readFile({ file_path: sourceFile, raw: true }, context);
  } catch (error) {
    const mapped = failureFromError(error);
    mapped.error = `${label} '${sourceFile}' could not be resolved: ${mapped.error}`;
    mapped.details = { ...mapped.details, sourceFile };
    throw mapped;
  }
  if (typeof content !== 'string') {
    throw invalidArguments(`${label} '${sourceFile}' did not resolve to text content`);
  }
  const bytes = utf8ByteLength(content);
  if (bytes > REALM_PUBLISHING_MAX_FILE_BYTES) {
    throw invalidArguments(
      `${label} '${sourceFile}' is ${bytes} bytes and exceeds the ${REALM_PUBLISHING_MAX_FILE_BYTES}-byte per-file publishing cap`,
      { sourceFile, actualBytes: bytes, maxBytes: REALM_PUBLISHING_MAX_FILE_BYTES }
    );
  }
  return content;
}

/**
 * Resolves one manifest argument source: exactly one of an inline manifest
 * object or a caller-visible `manifest_file` path whose JSON text carries the
 * same manifest.
 *
 * @param params - Sanitized handler parameters.
 * @param vfs - Caller-scoped VirtualFS read view.
 * @param context - Trusted execution context.
 * @param toolName - Tool name used in failure messages.
 * @returns The resolved manifest value and its source label.
 * @throws Structured failure receipt fields when the exclusivity rule or JSON parse fails.
 */
function resolveManifestArgument(
  params: ToolParams,
  vfs: VirtualFsReadView,
  context: ExecutionContext,
  toolName: string
): { manifest: unknown; manifestSource: string } {
  const hasManifest = params.manifest !== undefined;
  const hasManifestFile = params.manifest_file !== undefined;
  if (hasManifest === hasManifestFile) {
    throw invalidArguments(
      `${toolName} requires exactly one of manifest or manifest_file`,
      { manifest: hasManifest, manifestFile: hasManifestFile }
    );
  }
  if (hasManifestFile) {
    const raw = readSourceFile(vfs, context, params.manifest_file, `${toolName} manifest_file`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw invalidArguments(
        `${toolName} manifest_file '${String(params.manifest_file)}' must contain valid JSON: `
        + `${error instanceof Error ? error.message : String(error)}`
      );
    }
    return { manifest: parsed, manifestSource: 'file' };
  }
  return { manifest: params.manifest, manifestSource: 'inline' };
}

/**
 * Resolves a template-bundle manifest into the canonical transport document.
 *
 * Exactly one of the two manifest forms is accepted (inline object or
 * `manifest_file` path). The envelope is closed-shape
 * (`{ formatVersion: 1, template, files }`); the caller's `formatVersion` must
 * be exactly the number 1 and is enforced before any reference resolution,
 * mirroring the catalog parser's own transport gate. Every `files` value is
 * either an inline string or `{ sourceFile }`, resolved server-side through the
 * caller's workspace view under the per-file 2 MiB and 3 MiB bundle-total caps.
 * The resolved document is then validated by the real catalog parser, so the
 * tool and the import registry share one validation truth.
 *
 * @param params - Sanitized handler parameters.
 * @param vfs - Caller-scoped VirtualFS read view.
 * @param context - Trusted execution context.
 * @returns The parsed bundle plus its canonical transport JSON.
 */
function resolveImportBundle(
  params: ToolParams,
  vfs: VirtualFsReadView,
  context: ExecutionContext
): { parsed: ReturnType<typeof parseTemplateBundle>; canonical: string; manifestSource: string } {
  const { manifest, manifestSource } = resolveManifestArgument(
    params,
    vfs,
    context,
    PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE
  );
  if (!isPlainRecord(manifest)) {
    throw invalidArguments('import_realm_template manifest must be the transport object { formatVersion, template, files }');
  }
  for (const key of Object.keys(manifest)) {
    if (key !== 'formatVersion' && key !== 'template' && key !== 'files') {
      throw invalidArguments(`import_realm_template manifest carries unknown field '${key}'`);
    }
  }
  // Transport envelope gate (defect dfba631): the catalog's own parser owns
  // this rule — `realmCatalog/transport.ts` requires `formatVersion` to be
  // exactly the number 1, checked after the closed-field scan and before any
  // template/files work. The tool resolves `{ sourceFile }` references before
  // the canonical document reaches the parser, so the caller's value is
  // re-checked here (canonical re-serialization stamps 1 unconditionally and
  // must only ever receive an already-validated v1 envelope) and fails with
  // the same typed upstream code before any reference resolution or mutation.
  if (manifest.formatVersion !== 1) {
    throw invalidArguments(
      `import_realm_template manifest formatVersion must be 1 (got '${String(manifest.formatVersion)}')`,
      { upstreamCode: 'ERR_BUNDLE_FORMAT' }
    );
  }
  if (!isPlainRecord(manifest.files)) {
    throw invalidArguments('import_realm_template manifest files must be a record of bundle path to content or { sourceFile }');
  }

  const resolvedFiles: Record<string, string> = Object.create(null);
  let totalBytes = 0;
  for (const path of Object.keys(manifest.files)) {
    const entry = manifest.files[path];
    let content: string;
    if (typeof entry === 'string') {
      content = entry;
    } else if (isPlainRecord(entry)) {
      const keys = Object.keys(entry);
      if (keys.length !== 1 || keys[0] !== 'sourceFile' || typeof entry.sourceFile !== 'string') {
        throw invalidArguments(
          `import_realm_template manifest files['${path}'] must be an inline string or { sourceFile }`
        );
      }
      content = readSourceFile(
        vfs,
        context,
        entry.sourceFile,
        `import_realm_template manifest files['${path}'].sourceFile`
      );
    } else {
      throw invalidArguments(
        `import_realm_template manifest files['${path}'] must be an inline string or { sourceFile }`
      );
    }
    const fileBytes = utf8ByteLength(content);
    if (fileBytes > REALM_PUBLISHING_MAX_FILE_BYTES) {
      throw invalidArguments(
        `import_realm_template manifest file '${path}' is ${fileBytes} bytes and exceeds the `
        + `${REALM_PUBLISHING_MAX_FILE_BYTES}-byte per-file publishing cap`,
        { path, actualBytes: fileBytes, maxBytes: REALM_PUBLISHING_MAX_FILE_BYTES }
      );
    }
    totalBytes += fileBytes;
    if (totalBytes > REALM_PUBLISHING_MAX_BUNDLE_BYTES) {
      throw invalidArguments(
        `import_realm_template resolved file content is ${totalBytes} bytes and exceeds the `
        + `${REALM_PUBLISHING_MAX_BUNDLE_BYTES}-byte bundle-total cap`,
        { actualBytes: totalBytes, maxBytes: REALM_PUBLISHING_MAX_BUNDLE_BYTES }
      );
    }
    Object.defineProperty(resolvedFiles, path, {
      value: content,
      writable: false,
      enumerable: true,
      configurable: false
    });
  }

  let canonical: string;
  try {
    canonical = serializeTemplateBundle({
      // Only the canonical envelope travels; a malformed manifest is rejected
      // by the catalog's own validation below.
      template: manifest.template as RealmTemplate,
      files: resolvedFiles
    });
  } catch (error) {
    throw failureFromError(error);
  }
  const canonicalBytes = utf8ByteLength(canonical);
  if (canonicalBytes > REALM_PUBLISHING_MAX_BUNDLE_BYTES) {
    throw invalidArguments(
      `import_realm_template canonical transport is ${canonicalBytes} bytes and exceeds the `
      + `${REALM_PUBLISHING_MAX_BUNDLE_BYTES}-byte bundle-total cap`,
      { actualBytes: canonicalBytes, maxBytes: REALM_PUBLISHING_MAX_BUNDLE_BYTES }
    );
  }
  let parsed: ReturnType<typeof parseTemplateBundle>;
  try {
    parsed = parseTemplateBundle(canonical);
  } catch (error) {
    throw failureFromError(error);
  }
  return { parsed, canonical, manifestSource };
}

/**
 * Resolves a hydration manifest into the canonical inline package and
 * validates it against the effective catalog template.
 *
 *
 * Exactly one of the two manifest forms is accepted (inline object or
 * `manifest_file` path). `inputs` values are either inline strings or
 * `{ sourceFile }`; `files` entries are `{ path, target, content? | sourceFile }`
 * with exactly one content form. Every reference resolves through the caller's
 * workspace view under the per-file 2 MiB and 8 MiB package-total caps. The
 * canonical package pins the effective template version (the manifest may pin
 * its own; a mismatch fails closed through the catalog's version gate).
 *
 * @param params - Sanitized handler parameters.
 * @param vfs - Caller-scoped VirtualFS read view.
 * @param context - Trusted execution context.
 * @returns The canonical package, effective template version, and warnings.
 */
function resolveHydrationSubmission(
  params: ToolParams,
  vfs: VirtualFsReadView,
  context: ExecutionContext
): {
  package: Record<string, unknown>;
  templateId: string;
  templateVersion: string;
  inputIds: readonly string[];
  fileEntries: readonly { path: string; target: 'realm' | { agent: string } }[];
  warnings: readonly string[];
  manifestSource: string;
} {
  const { manifest, manifestSource } = resolveManifestArgument(
    params,
    vfs,
    context,
    PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE
  );
  if (!isPlainRecord(manifest)) {
    throw invalidArguments(
      'submit_hydration_package manifest must be an object carrying templateId and content'
    );
  }
  for (const key of Object.keys(manifest)) {
    if (
      key !== 'templateId'
      && key !== 'templateVersion'
      && key !== 'inputs'
      && key !== 'files'
      && key !== 'provenance'
    ) {
      throw invalidArguments(`submit_hydration_package manifest carries unknown field '${key}'`);
    }
  }
  const templateId = typeof manifest.templateId === 'string' ? manifest.templateId.trim() : '';
  if (!templateId) {
    throw invalidArguments('submit_hydration_package manifest requires a non-empty templateId');
  }
  if (manifest.templateVersion !== undefined && (typeof manifest.templateVersion !== 'string' || !manifest.templateVersion.trim())) {
    throw invalidArguments('submit_hydration_package manifest templateVersion must be a non-empty string when present');
  }

  const port = realmPublishingPortOf(context);
  const effective = port.getEffectiveTemplateBundle(templateId);
  if (!effective) {
    throw invalidArguments(
      `submit_hydration_package targets unknown realm template '${templateId}'`,
      { templateId, reason: 'unknown_template' }
    );
  }

  let totalBytes = 0;
  const inputs: Record<string, string> = Object.create(null);
  if (manifest.inputs !== undefined) {
    if (!isPlainRecord(manifest.inputs)) {
      throw invalidArguments('submit_hydration_package manifest inputs must be a record of values');
    }
    for (const inputId of Object.keys(manifest.inputs)) {
      const entry = manifest.inputs[inputId];
      let value: string;
      if (typeof entry === 'string') {
        value = entry;
      } else if (isPlainRecord(entry)) {
        const keys = Object.keys(entry);
        if (keys.length !== 1 || keys[0] !== 'sourceFile' || typeof entry.sourceFile !== 'string') {
          throw invalidArguments(
            `submit_hydration_package manifest inputs['${inputId}'] must be an inline string or { sourceFile }`
          );
        }
        value = readSourceFile(
          vfs,
          context,
          entry.sourceFile,
          `submit_hydration_package manifest inputs['${inputId}'].sourceFile`
        );
      } else {
        throw invalidArguments(
          `submit_hydration_package manifest inputs['${inputId}'] must be an inline string or { sourceFile }`
        );
      }
      const inputBytes = utf8ByteLength(value);
      if (inputBytes > REALM_PUBLISHING_MAX_FILE_BYTES) {
        throw invalidArguments(
          `submit_hydration_package manifest inputs['${inputId}'] is ${inputBytes} bytes and exceeds the `
          + `${REALM_PUBLISHING_MAX_FILE_BYTES}-byte per-file publishing cap`,
          { inputId, actualBytes: inputBytes, maxBytes: REALM_PUBLISHING_MAX_FILE_BYTES }
        );
      }
      totalBytes += inputBytes;
      if (totalBytes > REALM_PUBLISHING_MAX_PACKAGE_BYTES) {
        throw invalidArguments(
          `submit_hydration_package resolved content is ${totalBytes} bytes and exceeds the `
          + `${REALM_PUBLISHING_MAX_PACKAGE_BYTES}-byte package-total cap`,
          { actualBytes: totalBytes, maxBytes: REALM_PUBLISHING_MAX_PACKAGE_BYTES }
        );
      }
      Object.defineProperty(inputs, inputId, {
        value,
        writable: false,
        enumerable: true,
        configurable: false
      });
    }
  }

  const files: Array<Record<string, unknown>> = [];
  if (manifest.files !== undefined) {
    if (!Array.isArray(manifest.files)) {
      throw invalidArguments('submit_hydration_package manifest files must be an array of file entries');
    }
    manifest.files.forEach((entry, index) => {
      const label = `submit_hydration_package manifest files[${index}]`;
      if (!isPlainRecord(entry)) {
        throw invalidArguments(`${label} must be an object`);
      }
      for (const key of Object.keys(entry)) {
        if (key !== 'path' && key !== 'target' && key !== 'content' && key !== 'sourceFile') {
          throw invalidArguments(`${label} carries unknown field '${key}'`);
        }
      }
      const hasContent = entry.content !== undefined;
      const hasSource = entry.sourceFile !== undefined;
      if (hasContent === hasSource) {
        throw invalidArguments(`${label} must declare exactly one of content or sourceFile`);
      }
      let content: string;
      if (hasSource) {
        content = readSourceFile(vfs, context, entry.sourceFile, `${label}.sourceFile`);
      } else if (typeof entry.content === 'string') {
        content = entry.content;
      } else {
        throw invalidArguments(`${label} content must be a string`);
      }
      const fileBytes = utf8ByteLength(content);
      if (fileBytes > REALM_PUBLISHING_MAX_FILE_BYTES) {
        throw invalidArguments(
          `${label} '${String(entry.path)}' is ${fileBytes} bytes and exceeds the `
          + `${REALM_PUBLISHING_MAX_FILE_BYTES}-byte per-file publishing cap`,
          { path: entry.path, actualBytes: fileBytes, maxBytes: REALM_PUBLISHING_MAX_FILE_BYTES }
        );
      }
      totalBytes += fileBytes;
      if (totalBytes > REALM_PUBLISHING_MAX_PACKAGE_BYTES) {
        throw invalidArguments(
          `submit_hydration_package resolved content is ${totalBytes} bytes and exceeds the `
          + `${REALM_PUBLISHING_MAX_PACKAGE_BYTES}-byte package-total cap`,
          { actualBytes: totalBytes, maxBytes: REALM_PUBLISHING_MAX_PACKAGE_BYTES }
        );
      }
      files.push({ path: entry.path, target: entry.target, content });
    });
  }

  const packageRecord: Record<string, unknown> = {
    formatVersion: 1,
    templateId,
    // A manifest may omit the pin; the effective version is injected so the
    // canonical package always pins what validation checked. A supplied pin
    // that differs from the effective version fails closed in the catalog.
    templateVersion: typeof manifest.templateVersion === 'string' && manifest.templateVersion.trim()
      ? manifest.templateVersion
      : (effective.version || ''),
    inputs: { ...inputs },
    files
  };
  if (manifest.provenance !== undefined) {
    packageRecord.provenance = manifest.provenance;
  }

  let resolved: ReturnType<typeof validateHydrationPackage>;
  try {
    resolved = validateHydrationPackage(effective.template, packageRecord, {
      currentVersion: effective.version
    });
  } catch (error) {
    throw failureFromError(error);
  }

  return {
    package: packageRecord,
    templateId: resolved.templateId,
    templateVersion: resolved.templateVersion,
    inputIds: Object.freeze(Object.keys(resolved.inputValues)),
    fileEntries: Object.freeze(resolved.files.map((file) => Object.freeze({ path: file.path, target: file.target }))),
    warnings: resolved.warnings,
    manifestSource
  };
}

/**
 * Resolves the injected host publishing port from the trusted execution
 * context, failing closed when it is absent.
 *
 * @param context - Trusted execution context.
 * @returns The publishing port.
 * @throws `Error` - When the host did not bind a publishing port.
 */
function realmPublishingPortOf(context: ExecutionContext): RealmPublishingPort {
  const port = context?.realmPublishingPort;
  if (!port || typeof port !== 'object') {
    throw new Error('realmPublishingPort service is not available in execution context');
  }
  const candidate = port as RealmPublishingPort;
  if (
    typeof candidate.importTemplate !== 'function'
    || typeof candidate.previewTemplateImport !== 'function'
    || typeof candidate.getEffectiveTemplateBundle !== 'function'
    || typeof candidate.storePendingInstancePayload !== 'function'
  ) {
    throw new Error('realmPublishingPort service is not available in execution context');
  }
  return candidate;
}

/**
 * Resolves the caller-scoped VirtualFS read view from the trusted execution
 * context, failing closed when it is absent.
 *
 * @param context - Trusted execution context.
 * @returns The caller-scoped VirtualFS read view.
 * @throws `Error` - When the host did not bind a VirtualFS.
 */
function virtualFsReadViewOf(context: ExecutionContext): VirtualFsReadView {
  const vfs = context?.virtualFs as VirtualFsReadView | undefined;
  if (!vfs || typeof vfs.readFile !== 'function') {
    throw new Error('virtualFs service is not available in execution context');
  }
  return vfs;
}

/**
 * Parses the shared `dry_run` flag; absent defaults to a real (mutating) call.
 *
 * @param params - Sanitized handler parameters.
 * @returns `true` for a validator-only call.
 * @throws Structured failure receipt fields when the flag is not boolean.
 */
function dryRunOf(params: ToolParams): boolean {
  if (params.dry_run === undefined) return false;
  if (typeof params.dry_run !== 'boolean') {
    throw invalidArguments('dry_run must be a boolean when present');
  }
  return params.dry_run;
}

// ============================================================================
// import_realm_template
// ============================================================================

const importRealmTemplateParamAliasMap = Object.freeze({
  manifestFile: 'manifest_file',
  manifest_file: 'manifest_file',
  manifestPath: 'manifest_file',
  manifest_path: 'manifest_file',
  transport: 'manifest',
  bundle: 'manifest',
  templateManifest: 'manifest',
  template_manifest: 'manifest',
  dryRun: 'dry_run',
  dry_run: 'dry_run',
  dryrun: 'dry_run'
});

/**
 * `import_realm_template` descriptor — import a realm template transport bundle
 * through the host's Wave T template registry.
 *
 * Args: exactly one of `manifest` (the transport object) or `manifest_file`
 * (a caller-visible JSON file), plus optional `dry_run`. Bundle file values may
 * be inline strings or `{ sourceFile }` references resolved server-side under
 * the caller's workspace view. `dry_run: true` runs the identical
 * resolve → validate → preview pipeline with zero side effects.
 */
export const importRealmTemplateDescriptor = Object.freeze({
  name: PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
  authority: AGENT_AUTHORITIES.TEMPLATE,
  description: `Import a realm template transport bundle ({ formatVersion: 1, template, files }) into the host's template registry. Provide exactly one of manifest (the transport object) or manifest_file (a caller-visible JSON file path); each files value is an inline string or { sourceFile: '<caller-visible path>' } resolved server-side under your workspace view (referenced bytes never enter context). dry_run: true runs the identical resolve/validate pipeline and returns the same typed receipt with zero side effects.`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      manifest: {
        type: 'object',
        description: 'Transport bundle object { formatVersion: 1, template, files }; files values are inline strings or { sourceFile } references. Mutually exclusive with manifest_file.'
      },
      manifest_file: {
        type: 'string',
        description: 'Caller-visible path of a JSON file carrying the transport bundle; mutually exclusive with manifest.'
      },
      dry_run: {
        type: 'boolean',
        description: 'Validate and report the would-be import receipt without importing anything (defaults to false).'
      }
    },
    oneOf: [
      { required: ['manifest'] },
      { required: ['manifest_file'] }
    ],
    additionalProperties: false
  }),
  paramAliasMap: importRealmTemplateParamAliasMap,
  sanitize: createParamSanitizer(importRealmTemplateParamAliasMap),
  handler: (params: ToolParams, context: ExecutionContext) => {
    try {
      const dryRun = dryRunOf(params);
      const vfs = virtualFsReadViewOf(context);
      const port = realmPublishingPortOf(context);
      const { parsed, canonical, manifestSource } = resolveImportBundle(params, vfs, context);
      const receipt = dryRun ? port.previewTemplateImport(canonical) : port.importTemplate(canonical);
      return {
        success: true,
        tool: PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
        templateId: receipt.templateId,
        templateVersion: receipt.templateVersion,
        source: receipt.source,
        replacesShipped: receipt.replacesShipped,
        replacedImport: receipt.replacedImport,
        totalImportedBytes: receipt.totalImportedBytes,
        fileCount: Object.keys(parsed.files).length,
        manifestSource,
        dryRun,
        imported: !dryRun,
        warnings: [...receipt.warnings]
      };
    } catch (error) {
      const structured = (error ?? {}) as Partial<PublishingFailure>;
      if (structured.success === false && typeof structured.error === 'string') return structured;
      return failureFromError(error);
    }
  }
});
/** camelCase alias of `importRealmTemplateDescriptor`. */
export const importRealmTemplate = importRealmTemplateDescriptor;
/** snake_case alias of `importRealmTemplateDescriptor`. */
export const import_realm_template = importRealmTemplateDescriptor;

// ============================================================================
// submit_hydration_package
// ============================================================================

const submitHydrationPackageParamAliasMap = Object.freeze({
  manifestFile: 'manifest_file',
  manifest_file: 'manifest_file',
  manifestPath: 'manifest_file',
  manifest_path: 'manifest_file',
  packageManifest: 'manifest',
  package_manifest: 'manifest',
  hydrationPackage: 'manifest',
  hydration_package: 'manifest',
  dryRun: 'dry_run',
  dry_run: 'dry_run',
  dryrun: 'dry_run'
});

/**
 * `submit_hydration_package` descriptor — submit an instance content package
 * for an effective catalog template.
 *
 * Args: exactly one of `manifest` or `manifest_file`, plus optional `dry_run`.
 * Input values and file entries may be inline or `{ sourceFile }` references
 * resolved server-side under the caller's workspace view. The resolved package
 * is validated against the effective catalog template with the effective
 * version as `currentVersion` (a mismatch fails closed), then stored as a
 * session-only pending candidate. `dry_run: true` validates (slot coverage,
 * version check, caps) and reports the would-be package without storing a
 * candidate.
 */
export const submitHydrationPackageDescriptor = Object.freeze({
  name: PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE,
  authority: AGENT_AUTHORITIES.HYDRATION,
  description: `Submit a hydration package for a realm template: { templateId, templateVersion?, inputs, files, provenance? } where inputs values and files entries may be inline or { sourceFile: '<caller-visible path>' } resolved server-side under your workspace view (referenced bytes never enter context). The host validates the resolved package against the effective template (slot coverage and template-version pin; mismatch fails closed) and stores a session-only pending candidate for the launch review. dry_run: true validates and reports the would-be package without storing a candidate.`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      manifest: {
        type: 'object',
        description: 'Hydration manifest { templateId, templateVersion?, inputs, files, provenance? }; values may be inline or { sourceFile } references. Mutually exclusive with manifest_file.'
      },
      manifest_file: {
        type: 'string',
        description: 'Caller-visible path of a JSON file carrying the hydration manifest; mutually exclusive with manifest.'
      },
      dry_run: {
        type: 'boolean',
        description: 'Validate and report the would-be package without storing a candidate (defaults to false).'
      }
    },
    oneOf: [
      { required: ['manifest'] },
      { required: ['manifest_file'] }
    ],
    additionalProperties: false
  }),
  paramAliasMap: submitHydrationPackageParamAliasMap,
  sanitize: createParamSanitizer(submitHydrationPackageParamAliasMap),
  handler: (params: ToolParams, context: ExecutionContext) => {
    try {
      const dryRun = dryRunOf(params);
      const vfs = virtualFsReadViewOf(context);
      const port = realmPublishingPortOf(context);
      const resolved = resolveHydrationSubmission(params, vfs, context);
      const resolvedAt = new Date().toISOString();
      if (!dryRun) {
        const candidate: PendingInstancePayload = Object.freeze({
          templateId: resolved.templateId,
          templateVersion: resolved.templateVersion,
          payload: Object.freeze({ ...resolved.package }),
          resolvedAt
        });
        port.storePendingInstancePayload(candidate);
      }
      return {
        success: true,
        tool: PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE,
        templateId: resolved.templateId,
        templateVersion: resolved.templateVersion,
        inputIds: [...resolved.inputIds],
        fileEntries: resolved.fileEntries.map((entry) => ({ path: entry.path, target: entry.target })),
        manifestSource: resolved.manifestSource,
        resolvedAt,
        stored: !dryRun,
        dryRun,
        warnings: [...resolved.warnings]
      };
    } catch (error) {
      const structured = (error ?? {}) as Partial<PublishingFailure>;
      if (structured.success === false && typeof structured.error === 'string') return structured;
      return failureFromError(error);
    }
  }
});
/** camelCase alias of `submitHydrationPackageDescriptor`. */
export const submitHydrationPackage = submitHydrationPackageDescriptor;
/** snake_case alias of `submitHydrationPackageDescriptor`. */
export const submit_hydration_package = submitHydrationPackageDescriptor;

/**
 * Array of the two Wave U publishing meta-tool descriptors.
 */
export const publishingToolDescriptors: readonly PublishingToolDescriptor[] = Object.freeze([
  importRealmTemplateDescriptor,
  submitHydrationPackageDescriptor
]);

/**
 * Frozen registry of the publishing meta tools keyed by canonical name.
 *
 * The publishing registry is deliberately separate from the canonical
 * `TOOL_REGISTRY`: `getSandboxToolsSchema()` never exposes these schemas by
 * wildcard, and the dispatcher resolves them only for a caller whose frozen
 * authority descriptor carries the matching explicit authority id.
 */
export const PUBLISHING_TOOL_REGISTRY: Readonly<Record<string, PublishingToolDescriptor>> = Object.freeze(
  publishingToolDescriptors.reduce<Record<string, PublishingToolDescriptor>>((registry, descriptor) => {
    Object.defineProperty(registry, descriptor.name, {
      value: descriptor,
      writable: false,
      enumerable: true,
      configurable: false
    });
    return registry;
  }, Object.create(null))
);

/**
 * Builds OpenAI function schemas for the publishing tools whose explicit
 * authority id is present in `authorities`.
 *
 * The exposure discipline mirrors the host-only custom-tool surface: schemas
 * are only ever appended for a caller whose frozen authority descriptor holds
 * the exact authority — the wildcard `'*'` and `privileged` never satisfy it.
 *
 * @param authorities - Explicit authority ids the caller holds.
 * @returns Fresh OpenAI tool definitions (empty when no authority matches).
 */
export function getPublishingToolSchemas(authorities: readonly string[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: JsonSchemaDraft07 };
}> {
  const granted: ReadonlySet<string> = new Set(Array.isArray(authorities) ? authorities : []);
  const definitions: Array<{
    type: 'function';
    function: { name: string; description: string; parameters: JsonSchemaDraft07 };
  }> = [];
  for (const descriptor of publishingToolDescriptors) {
    if (!granted.has(descriptor.authority)) continue;
    definitions.push({
      type: 'function',
      function: {
        name: descriptor.name,
        description: descriptor.description,
        parameters: {
          type: descriptor.schema.type,
          properties: { ...descriptor.schema.properties },
          required: Array.isArray(descriptor.schema.required) ? [...descriptor.schema.required] : [],
          additionalProperties: Boolean(descriptor.schema.additionalProperties) as false
        }
      }
    });
  }
  return definitions;
}
