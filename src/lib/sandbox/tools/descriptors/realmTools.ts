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
 * Both tools speak the format-v2 publishing contract (decision `2ba3008`) while
 * keeping the format-v1 transport/package conveniences working for one
 * migration cycle:
 *
 * - `import_realm_template` accepts the authored transport document of either
 *   format (`{ formatVersion: 1|2, template, files }`), resolves every
 *   tool-layer `{ sourceFile }` convenience into inline file bodies, and
 *   validates through the catalog's own `parseTemplateBundle` — the same
 *   parser the host registry uses — before handing the canonical authored
 *   `serialized` transport to the publishing port.
 * - `submit_hydration_package` accepts a format-v2 payload
 *   (`{ formatVersion: 2, templateId, templateVersion, inputs, provenance? }`
 *   with shape-matched `{ text }` / `{ files }` values) or a legacy format-v1
 *   package (the pre-migration manifest shape, or the same shape with an
 *   explicit `formatVersion: 1`), resolves `{ sourceFile }` conveniences
 *   inline, and validates through the catalog's `validatePayload`. The receipt
 *   carries the canonical `payloadDigest` over the stored authored payload,
 *   which equals the launch provenance `packageDigest` when the candidate is
 *   attached at launch.
 *
 * Tool-layer references are conveniences only: `{ sourceFile }` never reaches
 * a spec, a payload, or the port — every reference resolves to conforming
 * inline content before validation.
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
  normalizeTemplate,
  parseTemplateBundle,
  payloadDigest,
  resolvePlacements,
  validatePayload
} from '../../realmCatalog/index.ts';
import type {
  PendingInstancePayload,
  RealmInputValue,
  RealmTemplateInput,
  RealmTemplate
} from '../../realmCatalog/index.ts';
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
 * Canonical authored transport envelope field names (closed shape).
 *
 * `formatVersion` accepts 1 or 2; the catalog's own parser owns the
 * template-format match rule.
 */
const IMPORT_MANIFEST_FIELDS: ReadonlySet<string> = new Set(['formatVersion', 'template', 'files']);

/**
 * Resolves a template-bundle manifest into the canonical authored transport
 * document.
 *
 * Exactly one of the two manifest forms is accepted (inline object or
 * `manifest_file` path). The envelope is closed-shape
 * (`{ formatVersion: 1|2, template, files }`); the caller's `formatVersion`
 * must be exactly the number 1 or 2 and is enforced before any reference
 * resolution, mirroring the catalog parser's own transport gate. Every `files`
 * value is either an inline string or `{ sourceFile }`, resolved server-side
 * through the caller's workspace view under the per-file 2 MiB and 3 MiB
 * bundle-total caps. The resolved authored document is then validated by the
 * real catalog parser (`parseTemplateBundle`), so the tool and the import
 * registry share one validation truth for either format; the parser's
 * canonical authored `serialized` text is what travels to the port.
 *
 * @param params - Sanitized handler parameters.
 * @param vfs - Caller-scoped VirtualFS read view.
 * @param context - Trusted execution context.
 * @returns The parsed bundle, its canonical authored transport JSON, and the manifest source label.
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
    if (!IMPORT_MANIFEST_FIELDS.has(key)) {
      throw invalidArguments(`import_realm_template manifest carries unknown field '${key}'`);
    }
  }
  // Transport envelope gate: the catalog's own parser accepts exactly
  // `formatVersion` 1 or 2 (checked after the closed-field scan and before any
  // template/files work, and matched against the template's declared format).
  // The tool resolves `{ sourceFile }` references before the canonical document
  // reaches the parser, so the caller's value is re-checked here — before any
  // reference resolution or mutation — and fails with the same typed upstream
  // code.
  if (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) {
    throw invalidArguments(
      `import_realm_template manifest formatVersion must be 1 or 2 (got '${String(manifest.formatVersion)}')`,
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

  let parsed: ReturnType<typeof parseTemplateBundle>;
  try {
    parsed = parseTemplateBundle({
      // The authored envelope travels as declared; the parser owns the
      // closed-shape, format-version match, template, and reference validation
      // for either format. `serialized` is the canonical authored round-trip.
      formatVersion: manifest.formatVersion,
      template: manifest.template,
      files: resolvedFiles
    });
  } catch (error) {
    throw failureFromError(error);
  }
  const canonical = parsed.serialized;
  const canonicalBytes = utf8ByteLength(canonical);
  if (canonicalBytes > REALM_PUBLISHING_MAX_BUNDLE_BYTES) {
    throw invalidArguments(
      `import_realm_template canonical transport is ${canonicalBytes} bytes and exceeds the `
      + `${REALM_PUBLISHING_MAX_BUNDLE_BYTES}-byte bundle-total cap`,
      { actualBytes: canonicalBytes, maxBytes: REALM_PUBLISHING_MAX_BUNDLE_BYTES }
    );
  }
  return { parsed, canonical, manifestSource };
}

/**
 * Canonical hydration manifest field names (closed shape).
 *
 * `formatVersion` is optional for one migration cycle: absent selects the
 * legacy format-v1 package manifest, an explicit 1 or 2 selects that payload
 * contract.
 */
const HYDRATION_MANIFEST_FIELDS: ReadonlySet<string> = new Set([
  'formatVersion',
  'templateId',
  'templateVersion',
  'inputs',
  'files',
  'provenance'
]);

/**
 * One resolved destination entry reported by the submission receipt: the
 * destination path and its workspace target (`realm` or a template agent key).
 */
interface ResolvedFileEntry {
  readonly path: string;
  readonly target: 'realm' | { agent: string };
}

/** Mutable running total for the per-file/package-total publishing caps. */
interface PublishingByteState {
  totalBytes: number;
}

/**
 * Enforces the per-file (2 MiB) and package-total (8 MiB) publishing caps over
 * one resolved content body, accumulating the running total.
 *
 * @param state - Running byte total for the submission.
 * @param bytes - UTF-8 byte length of the resolved body.
 * @param prefix - Message prefix naming the resolved body.
 * @param details - Machine-readable diagnostics merged into a cap failure.
 * @throws `PublishingFailure`-shaped error carrying the structured receipt fields
 */
function accountPublishingBytes(
  state: PublishingByteState,
  bytes: number,
  prefix: string,
  details: Record<string, unknown>
): void {
  if (bytes > REALM_PUBLISHING_MAX_FILE_BYTES) {
    throw invalidArguments(
      `${prefix} is ${bytes} bytes and exceeds the ${REALM_PUBLISHING_MAX_FILE_BYTES}-byte per-file publishing cap`,
      { ...details, actualBytes: bytes, maxBytes: REALM_PUBLISHING_MAX_FILE_BYTES }
    );
  }
  state.totalBytes += bytes;
  if (state.totalBytes > REALM_PUBLISHING_MAX_PACKAGE_BYTES) {
    throw invalidArguments(
      `submit_hydration_package resolved content is ${state.totalBytes} bytes and exceeds the `
      + `${REALM_PUBLISHING_MAX_PACKAGE_BYTES}-byte package-total cap`,
      { actualBytes: state.totalBytes, maxBytes: REALM_PUBLISHING_MAX_PACKAGE_BYTES }
    );
  }
}

/**
 * Resolves one format-v1 package input value: an inline string or a
 * `{ sourceFile }` reference resolved through the caller's workspace view.
 *
 * @param entry - Authored input value.
 * @param inputId - Declared input id (diagnostics only).
 * @param label - Parameter label used in failure messages.
 * @param vfs - Caller-scoped VirtualFS read view.
 * @param context - Trusted execution context.
 * @param state - Running byte total.
 * @returns The resolved inline string value.
 * @throws `PublishingFailure`-shaped error carrying the structured receipt fields
 */
function resolveLegacyInputValue(
  entry: unknown,
  inputId: string,
  label: string,
  vfs: VirtualFsReadView,
  context: ExecutionContext,
  state: PublishingByteState
): string {
  let value: string;
  if (typeof entry === 'string') {
    value = entry;
  } else if (isPlainRecord(entry)) {
    const keys = Object.keys(entry);
    if (keys.length !== 1 || keys[0] !== 'sourceFile' || typeof entry.sourceFile !== 'string') {
      throw invalidArguments(`${label} must be an inline string or { sourceFile }`);
    }
    value = readSourceFile(vfs, context, entry.sourceFile, `${label}.sourceFile`);
  } else {
    throw invalidArguments(`${label} must be an inline string or { sourceFile }`);
  }
  accountPublishingBytes(state, utf8ByteLength(value), label, { inputId });
  return value;
}

/**
 * Resolves one format-v2 payload input value against its declaration.
 *
 * A `text` declaration accepts `{ text }` or a whole-value `{ sourceFile }`
 * reference; a `files` declaration accepts a non-empty `{ files }` fileset
 * whose entries carry inline `content` or a `{ sourceFile }` reference. Every
 * resolved body counts against the per-file and package-total caps. Values for
 * undeclared inputs pass through unchanged so the catalog's own validation
 * reports them with the canonical "names undeclared input" failure.
 *
 * @param entry - Authored input value.
 * @param inputId - Input id the value is keyed by.
 * @param declaration - Declared input, when the id is declared.
 * @param label - Parameter label used in failure messages.
 * @param vfs - Caller-scoped VirtualFS read view.
 * @param context - Trusted execution context.
 * @param state - Running byte total.
 * @returns The resolved authored value (shape-tagged, or the raw value for the catalog to reject).
 * @throws `PublishingFailure`-shaped error carrying the structured receipt fields
 */
function resolvePayloadInputValue(
  entry: unknown,
  inputId: string,
  declaration: RealmTemplateInput | undefined,
  label: string,
  vfs: VirtualFsReadView,
  context: ExecutionContext,
  state: PublishingByteState
): unknown {
  if (!isPlainRecord(entry)) return entry;
  const keys = Object.keys(entry);
  const hasSourceReference = keys.includes('sourceFile');

  if (declaration?.shape === 'text') {
    if (hasSourceReference) {
      if (keys.length !== 1) {
        throw invalidArguments(`${label} must declare either { text } or { sourceFile }`);
      }
      const text = readSourceFile(vfs, context, entry.sourceFile, `${label}.sourceFile`);
      accountPublishingBytes(state, utf8ByteLength(text), label, { inputId });
      return { text };
    }
    if (typeof entry.text === 'string') {
      accountPublishingBytes(state, utf8ByteLength(entry.text), label, { inputId });
      return { text: entry.text };
    }
    return entry;
  }

  if (declaration?.shape === 'files') {
    if (hasSourceReference && entry.files === undefined) {
      throw invalidArguments(
        `${label} targets files input '${inputId}' and must declare a { files } fileset — `
        + 'a whole-value sourceFile reference is only valid for text inputs'
      );
    }
    if (entry.files === undefined) return entry;
    if (!Array.isArray(entry.files)) {
      throw invalidArguments(`${label}.files must be an array of file entries`);
    }
    const files = entry.files.map((file, index) => {
      const fileLabel = `${label}.files[${index}]`;
      if (!isPlainRecord(file)) {
        throw invalidArguments(`${fileLabel} must be an object`);
      }
      for (const key of Object.keys(file)) {
        if (key !== 'path' && key !== 'content' && key !== 'sourceFile') {
          throw invalidArguments(`${fileLabel} carries unknown field '${key}'`);
        }
      }
      const hasContent = file.content !== undefined;
      const hasSource = file.sourceFile !== undefined;
      if (hasContent === hasSource) {
        throw invalidArguments(`${fileLabel} must declare exactly one of content or sourceFile`);
      }
      let content: string;
      if (hasSource) {
        content = readSourceFile(vfs, context, file.sourceFile, `${fileLabel}.sourceFile`);
      } else if (typeof file.content === 'string') {
        content = file.content;
      } else {
        throw invalidArguments(`${fileLabel} content must be a string`);
      }
      accountPublishingBytes(state, utf8ByteLength(content), `${fileLabel} '${String(file.path)}'`, { path: file.path });
      return { path: file.path, content };
    });
    return { files };
  }

  // Undeclared input (or a value the declaration cannot shape): pass the
  // authored value through so `validatePayload` owns the canonical rejection.
  return entry;
}

/**
 * Resolves the destination entries the submission receipt reports for the
 * payload's files-shaped inputs.
 *
 * Destinations live only in the template: the declared placements that consume
 * the supplied files inputs resolve through the catalog's own
 * `resolvePlacements` (canonical root-joining and single-file semantics).
 * Fileset entries consumed only by prompt/history parts have no destination and
 * are not reported.
 *
 * @param template - Normalized format-v2 template.
 * @param inputs - Validated supplied input values.
 * @param bundleFiles - Bundle file bodies the template references.
 * @returns Frozen `{ path, target }` destination entries, in placement order.
 */
function resolvePayloadFileEntries(
  template: RealmTemplate,
  inputs: Readonly<Record<string, RealmInputValue>>,
  bundleFiles: Readonly<Record<string, string>>
): readonly ResolvedFileEntry[] {
  const suppliedFilesInputIds: ReadonlySet<string> = new Set(
    Object.keys(inputs).filter((inputId) => inputs[inputId].shape === 'files')
  );
  if (suppliedFilesInputIds.size === 0) return Object.freeze([]);
  const consumingPlacements = (template.placements ?? []).filter(
    (placement) => placement.inputId !== undefined && suppliedFilesInputIds.has(placement.inputId)
  );
  if (consumingPlacements.length === 0) return Object.freeze([]);
  const resolvedPlacements = resolvePlacements(consumingPlacements, template.inputs, {
    inputs,
    bundleFiles
  });
  return Object.freeze(resolvedPlacements.map((placement) => Object.freeze({
    path: placement.path,
    target: placement.target
  })));
}

/**
 * Resolves a hydration manifest into the conforming inline payload and
 * validates it against the effective catalog template.
 *
 * Exactly one of the two manifest forms is accepted (inline object or
 * `manifest_file` path). The manifest is a format-v2 payload
 * (`formatVersion: 2`; shape-matched `{ text }` / `{ files }` values) or a
 * legacy format-v1 package (absent `formatVersion`, or an explicit `1`;
 * `inputs` strings and `{ path, target, content? | sourceFile }` file entries).
 * Every `{ sourceFile }` convenience — whole-value for a `text` input, per-file
 * body for a fileset entry, and every v1 input/file body — resolves through the
 * caller's workspace view into inline content under the per-file 2 MiB and
 * 8 MiB package-total caps, so the validated payload is always self-contained
 * and no reference ever reaches the catalog or the port. The canonical payload
 * pins the effective template version (the manifest may pin its own; a mismatch
 * fails closed through the catalog's version gate) and is validated by the
 * catalog's single `validatePayload` path, which accepts v2 payloads and
 * converts v1 packages against the normalized template.
 *
 * @param params - Sanitized handler parameters.
 * @param vfs - Caller-scoped VirtualFS read view.
 * @param context - Trusted execution context.
 * @returns The conforming payload, its canonical digest, and review metadata.
 */
function resolveHydrationSubmission(
  params: ToolParams,
  vfs: VirtualFsReadView,
  context: ExecutionContext
): {
  package: Record<string, unknown>;
  templateId: string;
  templateVersion: string;
  sourceFormatVersion: 1 | 2;
  digest: string;
  inputIds: readonly string[];
  fileEntries: readonly ResolvedFileEntry[];
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
    if (!HYDRATION_MANIFEST_FIELDS.has(key)) {
      throw invalidArguments(`submit_hydration_package manifest carries unknown field '${key}'`);
    }
  }
  // Authored-format gate: absent means the legacy v1 package manifest (the
  // pre-migration wire shape); an explicit 1 or 2 selects that payload
  // contract. Anything else fails closed before any reference resolution.
  const declaredFormatVersion = manifest.formatVersion === undefined ? 1 : manifest.formatVersion;
  if (declaredFormatVersion !== 1 && declaredFormatVersion !== 2) {
    throw invalidArguments(
      `submit_hydration_package manifest formatVersion must be 1 or 2 (got '${String(manifest.formatVersion)}')`,
      { upstreamCode: 'ERR_HYDRATION_PACKAGE' }
    );
  }
  const sourceFormatVersion: 1 | 2 = declaredFormatVersion;
  if (sourceFormatVersion === 2 && manifest.files !== undefined) {
    throw invalidArguments(
      'submit_hydration_package manifest with formatVersion 2 carries no top-level files — '
      + 'destinations live in the template placements',
      { upstreamCode: 'ERR_HYDRATION_PACKAGE' }
    );
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
  // The port serves the authored template (v1 or v2); normalize it once for the
  // shape-aware convenience resolution. The catalog's own normalization is the
  // single shape source, so a v2 payload targeting a v1-authored template
  // resolves against the same shimmed declarations `validatePayload` uses.
  let normalized: RealmTemplate;
  try {
    normalized = normalizeTemplate(effective.template);
  } catch (error) {
    throw failureFromError(error);
  }
  const declarationsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    (normalized.inputs ?? []).map((declaration) => [declaration.id, declaration] as const)
  );

  const state: PublishingByteState = { totalBytes: 0 };
  const inputs: Record<string, unknown> = Object.create(null);
  if (manifest.inputs !== undefined) {
    if (!isPlainRecord(manifest.inputs)) {
      throw invalidArguments('submit_hydration_package manifest inputs must be a record of values');
    }
    for (const inputId of Object.keys(manifest.inputs)) {
      const label = `submit_hydration_package manifest inputs['${inputId}']`;
      const entry = manifest.inputs[inputId];
      const value = sourceFormatVersion === 1
        ? resolveLegacyInputValue(entry, inputId, label, vfs, context, state)
        : resolvePayloadInputValue(entry, inputId, declarationsById.get(inputId), label, vfs, context, state);
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
      accountPublishingBytes(state, utf8ByteLength(content), `${label} '${String(entry.path)}'`, { path: entry.path });
      files.push({ path: entry.path, target: entry.target, content });
    });
  }

  const packageRecord: Record<string, unknown> = {
    formatVersion: sourceFormatVersion,
    templateId,
    // A manifest may omit the pin; the effective version is injected so the
    // canonical payload always pins what validation checked. A supplied pin
    // that differs from the effective version fails closed in the catalog.
    templateVersion: typeof manifest.templateVersion === 'string' && manifest.templateVersion.trim()
      ? manifest.templateVersion
      : (effective.version || ''),
    inputs: { ...inputs },
    ...(sourceFormatVersion === 1 ? { files } : {})
  };
  if (manifest.provenance !== undefined) {
    packageRecord.provenance = manifest.provenance;
  }

  let resolved: ReturnType<typeof validatePayload>;
  try {
    resolved = validatePayload(effective.template, packageRecord, {
      currentVersion: effective.version
    });
  } catch (error) {
    throw failureFromError(error);
  }

  let digest: string;
  let fileEntries: readonly ResolvedFileEntry[];
  try {
    // Digest the authored payload exactly as it is stored (canonical sorted-key
    // bytes), so the receipt value equals the store's launch provenance
    // `packageDigest` when this candidate is attached.
    digest = payloadDigest(packageRecord);
    fileEntries = resolvePayloadFileEntries(normalized, resolved.inputs, effective.files);
  } catch (error) {
    throw failureFromError(error);
  }

  return {
    package: packageRecord,
    templateId: resolved.templateId,
    templateVersion: resolved.templateVersion,
    sourceFormatVersion,
    digest,
    // The authored payload's filled input ids (v1 packages report their input
    // values; a v1 package's file entries resolve to shimmed fileset inputs and
    // are reported through `fileEntries` instead).
    inputIds: Object.freeze(Object.keys(packageRecord.inputs as Record<string, unknown>)),
    fileEntries,
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
 * (a caller-visible JSON file), plus optional `dry_run`. The transport envelope
 * declares `formatVersion` 1 or 2; bundle file values may be inline strings or
 * `{ sourceFile }` references resolved server-side under the caller's workspace
 * view. The resolved authored document validates through the catalog's own
 * `parseTemplateBundle` (the same parser the registry uses) and the parser's
 * canonical `serialized` transport travels to the port, so a format-v1 bundle
 * is normalized through the read shim while a format-v2 bundle imports as
 * authored. `dry_run: true` runs the identical resolve → validate → preview
 * pipeline with zero side effects.
 *
 * Receipt: the store import receipt (`templateId`, authored `templateVersion`,
 * shadow labels, effective byte budget, parser warnings) plus
 * `sourceFormatVersion` (which authored format the transport declared),
 * `fileCount`, `manifestSource`, `dryRun`, and `imported`.
 */
export const importRealmTemplateDescriptor = Object.freeze({
  name: PUBLISHING_TOOLS.IMPORT_REALM_TEMPLATE,
  authority: AGENT_AUTHORITIES.TEMPLATE,
  description: `Import a realm template transport bundle ({ formatVersion: 1|2, template, files }) into the host's template registry. Provide exactly one of manifest (the transport object) or manifest_file (a caller-visible JSON file path); each files value is an inline string or { sourceFile: '<caller-visible path>' } resolved server-side under your workspace view (referenced bytes never enter context). A format-v1 bundle validates against the frozen v1 schema and normalizes to the format-v2 model; a format-v2 bundle validates directly. dry_run: true runs the identical resolve/validate pipeline and returns the same typed receipt with zero side effects.`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      manifest: {
        type: 'object',
        description: 'Transport bundle object { formatVersion: 1|2, template, files }; files values are inline strings or { sourceFile } references. Mutually exclusive with manifest_file.'
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
        sourceFormatVersion: parsed.sourceFormatVersion,
        source: receipt.source,
        replacesShipped: receipt.replacesShipped,
        replacedImport: receipt.replacedImport,
        totalImportedBytes: receipt.totalImportedBytes,
        fileCount: Object.keys(parsed.files).length,
        manifestSource,
        dryRun,
        imported: !dryRun,
        warnings: [...new Set([...parsed.warnings, ...receipt.warnings])]
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
 * `submit_hydration_package` descriptor — submit an instance content payload
 * for an effective catalog template.
 *
 * Args: exactly one of `manifest` or `manifest_file`, plus optional `dry_run`.
 * The manifest is a format-v2 payload (`formatVersion: 2`; shape-matched
 * `{ text }` / `{ files }` values keyed by declared input id) or a legacy
 * format-v1 package (absent `formatVersion`, or an explicit `1`; string input
 * values and `{ path, target, content }` file entries). Input bodies and file
 * entries may be inline or `{ sourceFile }` references resolved server-side
 * under the caller's workspace view before validation, so the validated payload
 * is always self-contained. The resolved payload is validated against the
 * effective catalog template through the catalog's `validatePayload` (required
 * coverage, shape match, effective version as `currentVersion`; a mismatch
 * fails closed), then stored as a session-only pending candidate.
 * `dry_run: true` runs the identical resolve → validate pipeline and reports
 * the would-be payload without storing a candidate.
 *
 * Receipt: `templateId`, the pinned `templateVersion`, `sourceFormatVersion`,
 * the canonical `payloadDigest` (`sha256:<hex>` over the stored authored
 * payload — equal to the launch provenance `packageDigest` when the candidate
 * is attached), the filled `inputIds`, the resolved destination `fileEntries`
 * (declared placements consuming the supplied files inputs; fileset entries
 * consumed only by prompt/history parts have no destination), `manifestSource`,
 * `resolvedAt`, `stored`, `dryRun`, and any catalog review `warnings`.
 */
export const submitHydrationPackageDescriptor = Object.freeze({
  name: PUBLISHING_TOOLS.SUBMIT_HYDRATION_PACKAGE,
  authority: AGENT_AUTHORITIES.HYDRATION,
  description: `Submit a hydration payload for a realm template: a format-v2 payload { formatVersion: 2, templateId, templateVersion?, inputs, provenance? } with shape-matched values ({ text } for a text input, { files: [{ path, content }] } for a files input) or a legacy format-v1 package { formatVersion: 1, templateId, templateVersion?, inputs, files, provenance? }. Provide exactly one of manifest (the payload object) or manifest_file (a caller-visible JSON file path); input bodies and file entries may be inline or { sourceFile: '<caller-visible path>' } resolved server-side under your workspace view (referenced bytes never enter context). The host validates the resolved payload against the effective template (required coverage, shape match, template-version pin; mismatch fails closed) and stores a session-only pending candidate for the launch review; the receipt carries the canonical payloadDigest (sha256:<hex> over the stored authored payload) that launch provenance reuses. dry_run: true validates and reports the would-be payload without storing a candidate.`,
  schema: Object.freeze({
    type: 'object',
    properties: {
      manifest: {
        type: 'object',
        description: 'Hydration payload: format-v2 { formatVersion: 2, templateId, templateVersion?, inputs, provenance? } with { text } / { files } values, or legacy format-v1 { formatVersion: 1, templateId, templateVersion?, inputs, files, provenance? }; bodies may be inline or { sourceFile } references. Mutually exclusive with manifest_file.'
      },
      manifest_file: {
        type: 'string',
        description: 'Caller-visible path of a JSON file carrying the hydration payload; mutually exclusive with manifest.'
      },
      dry_run: {
        type: 'boolean',
        description: 'Validate and report the would-be payload without storing a candidate (defaults to false).'
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
        sourceFormatVersion: resolved.sourceFormatVersion,
        payloadDigest: resolved.digest,
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
