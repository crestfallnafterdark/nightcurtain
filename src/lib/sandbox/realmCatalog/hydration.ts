/**
 * Payload validation for the `realmCatalog` module.
 *
 * A payload is one instance's content: the structured input values for one
 * template, keyed by declared input id and shape-tagged (`text` | `files`). It
 * is validated fail-closed against the template's declared contract — unknown
 * input ids and shape mismatches are rejected, every `required` input must be
 * present and non-empty, and the payload pins the template version it was
 * produced against (a mismatch is a typed error unless the caller explicitly
 * allows it, in which case it is reported as a review warning). A legacy
 * format-v1 hydration package is accepted and converted through the same
 * entry point, so pre-migration instance content keeps validating.
 */

import { REALM_CATALOG_ERROR_CODES, RealmCatalogError, toCatalogError } from './errors.ts';
import { deepFreeze } from './freeze.ts';
import { normalizeTemplate } from './legacy.ts';
import { sha256Hex } from './sha256.ts';
import { canonicalJsonStringify } from './version.ts';
import {
  isPlainRecord,
  rejectUnknownFields,
  requireNonEmptyString,
  requireSafePath,
  seedSlotKey,
  validatePayloadFile,
  validateSeedTarget
} from './validation.ts';
import type {
  RealmInputValue,
  RealmPayloadFile,
  RealmPayloadProvenance,
  RealmPlacement,
  RealmTemplateInput,
  RealmTemplate,
  ResolvedPayload
} from './types.ts';

/** Canonical hydration-package field names (closed shape). */
const PACKAGE_FIELDS: ReadonlySet<string> = new Set([
  'formatVersion',
  'templateId',
  'templateVersion',
  'inputs',
  'files',
  'provenance'
]);

/** Canonical hydration-package file-entry field names (closed shape). */
const PACKAGE_FILE_FIELDS: ReadonlySet<string> = new Set(['path', 'target', 'content']);

/** Canonical hydration-package provenance field names (closed shape). */
const PACKAGE_PROVENANCE_FIELDS: ReadonlySet<string> = new Set([
  'hydrator',
  'generatedAt',
  'model',
  'reviewedBy'
]);

/**
 * Builds a typed hydration-package error.
 *
 * @param message - Failure description
 * @returns A `RealmCatalogError` with code `ERR_HYDRATION_PACKAGE`
 */
function packageError(message: string): RealmCatalogError {
  return new RealmCatalogError(message, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
}

/* ------------------------------------------------------------------------- *
 * Payloads (decision ticket 2ba3008)
 *
 * A payload is the structured input content for one template: self-contained,
 * inline-only, keyed by declared input id. `validatePayload()` also accepts a
 * format-v1 hydration package and converts it against the normalized template
 * (its seed-slot entries match placements by path + target), so the v1 read
 * shim covers instance content as well as templates.
 * ------------------------------------------------------------------------- */

/** Canonical payload field names (closed shape). */
const PAYLOAD_FIELDS: ReadonlySet<string> = new Set([
  'formatVersion',
  'templateId',
  'templateVersion',
  'inputs',
  'provenance'
]);

/** Canonical format-v2 payload provenance field names (closed shape). */
const PAYLOAD_PROVENANCE_FIELDS: ReadonlySet<string> = new Set([
  'producer',
  'generatedAt',
  'model',
  'reviewedBy'
]);

/** Canonical format-v2 payload input-value field names per declared shape. */
const PAYLOAD_INPUT_VALUE_FIELDS: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  text: new Set(['text']),
  files: new Set(['files'])
});

/**
 * Validates the optional format-v2 payload provenance block (closed shape; all
 * fields optional non-empty strings, never secrets).
 *
 * @param candidate - Candidate provenance block
 * @param label - Human-readable label used in error messages
 * @returns The validated provenance block, or `undefined` when absent
 */
function validatePayloadProvenance(candidate: unknown, label: string): RealmPayloadProvenance | undefined {
  if (candidate === undefined) return undefined;
  if (!isPlainRecord(candidate)) {
    throw packageError(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, PAYLOAD_PROVENANCE_FIELDS, label);
  for (const field of PAYLOAD_PROVENANCE_FIELDS) {
    if (candidate[field] !== undefined) {
      requireNonEmptyString(candidate[field], `${label} ${field}`);
    }
  }
  return candidate as RealmPayloadProvenance;
}

/**
 * Validates one authored payload input value against its declaration's shape.
 *
 * A `text` declaration requires `{ text }`; a `files` declaration requires
 * `{ files }` with a non-empty array of safe, unique `{ path, content }`
 * entries. Unknown members and shape mismatches fail closed.
 *
 * @param candidate - Candidate authored value
 * @param declaration - Declared input the value fills
 * @param label - Human-readable label used in error messages
 * @returns The validated shape-tagged value
 */
function validatePayloadInputValue(
  candidate: unknown,
  declaration: RealmTemplateInput,
  label: string
): RealmInputValue {
  if (!isPlainRecord(candidate)) {
    throw packageError(`${label} must be an object`);
  }
  rejectUnknownFields(candidate, PAYLOAD_INPUT_VALUE_FIELDS[declaration.shape], label);
  if (declaration.shape === 'text') {
    if (typeof candidate.text !== 'string') {
      throw packageError(`${label} text must be a string`);
    }
    return { shape: 'text', text: candidate.text };
  }
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    throw packageError(`${label} files must be a non-empty array of file entries`);
  }
  const files: RealmPayloadFile[] = [];
  const seen: Set<string> = new Set();
  candidate.files.forEach((file, index) => {
    const validated = validatePayloadFile(file, `${label} files[${index}]`);
    if (seen.has(validated.path)) {
      throw packageError(`${label} files duplicate the path '${validated.path}'`);
    }
    seen.add(validated.path);
    files.push(validated);
  });
  return { shape: 'files', files };
}

/**
 * Validates the authored payload `inputs` record against the declared inputs.
 *
 * @param candidate - Candidate inputs record
 * @param declarationsById - Declared inputs keyed by id
 * @param label - Human-readable label used in error messages
 * @returns Validated shape-tagged values keyed by declared input id
 */
function validatePayloadInputs(
  candidate: unknown,
  declarationsById: ReadonlyMap<string, RealmTemplateInput>,
  label: string
): Record<string, RealmInputValue> {
  if (!isPlainRecord(candidate)) {
    throw packageError(`${label} must be a record of input values`);
  }
  // Null prototype: a payload key can never reach an Object.prototype setter
  // through this accumulator (T-V finding F1, ticket e4c8f91).
  const inputs: Record<string, RealmInputValue> = Object.create(null);
  for (const inputId of Object.keys(candidate)) {
    const declaration = declarationsById.get(inputId);
    if (declaration === undefined) {
      throw packageError(`${label} names undeclared input '${inputId}'`);
    }
    inputs[inputId] = validatePayloadInputValue(candidate[inputId], declaration, `${label}['${inputId}']`);
  }
  return inputs;
}

/**
 * Converts a validated format-v1 hydration package against a normalized v2
 * template (the package half of the v1 read shim).
 *
 * Package input values must name declared `text` inputs; package file entries
 * match a declared placement by path + target, and the matched placement must
 * resolve a `files` input (fixed bundle placements and text placements are
 * rejected). The v1 `hydrator` provenance field maps to v2 `producer`.
 *
 * @param pkg - Candidate format-v1 package (object)
 * @param template - Normalized format-v2 template
 * @returns The converted envelope parts (template id, version, inputs, provenance)
 */
function convertLegacyPackageV1(
  pkg: Record<string, unknown>,
  template: RealmTemplate
): {
  templateId: string;
  templateVersion: string;
  inputs: Record<string, RealmInputValue>;
  provenance?: RealmPayloadProvenance;
} {
  rejectUnknownFields(pkg, PACKAGE_FIELDS, 'hydration package');
  const templateId = requireNonEmptyString(pkg.templateId, 'hydration package templateId');
  const templateVersion = requireNonEmptyString(pkg.templateVersion, 'hydration package templateVersion');

  let provenance: RealmPayloadProvenance | undefined;
  if (pkg.provenance !== undefined) {
    if (!isPlainRecord(pkg.provenance)) {
      throw packageError('hydration package provenance must be an object');
    }
    rejectUnknownFields(pkg.provenance, PACKAGE_PROVENANCE_FIELDS, 'hydration package provenance');
    for (const field of PACKAGE_PROVENANCE_FIELDS) {
      if (pkg.provenance[field] !== undefined) {
        requireNonEmptyString(pkg.provenance[field], `hydration package provenance ${field}`);
      }
    }
    const legacy = pkg.provenance as Record<string, unknown>;
    provenance = {
      ...(legacy.hydrator !== undefined ? { producer: legacy.hydrator as string } : {}),
      ...(legacy.generatedAt !== undefined ? { generatedAt: legacy.generatedAt as string } : {}),
      ...(legacy.model !== undefined ? { model: legacy.model as string } : {}),
      ...(legacy.reviewedBy !== undefined ? { reviewedBy: legacy.reviewedBy as string } : {})
    };
  }

  const declarationsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
    (template.inputs ?? []).map((input) => [input.id, input] as const)
  );
  const inputs: Record<string, RealmInputValue> = Object.create(null);
  if (pkg.inputs !== undefined) {
    if (!isPlainRecord(pkg.inputs)) {
      throw packageError('hydration package inputs must be a record of string values');
    }
    for (const inputId of Object.keys(pkg.inputs)) {
      const value = pkg.inputs[inputId];
      if (typeof value !== 'string') {
        throw packageError(`hydration package inputs['${inputId}'] must be a string`);
      }
      const declaration = declarationsById.get(inputId);
      if (declaration === undefined) {
        throw packageError(`hydration package inputs names undeclared input '${inputId}'`);
      }
      if (declaration.shape !== 'text') {
        throw packageError(
          `hydration package inputs['${inputId}'] cannot fill files input '${inputId}' — `
          + 'a format-v1 package carries text input values only'
        );
      }
      inputs[inputId] = { shape: 'text', text: value };
    }
  }

  const agentKeys: ReadonlySet<string> = new Set(template.agents.map((spec) => spec.key));
  const placementsByKey: ReadonlyMap<string, RealmPlacement> = new Map(
    (template.placements ?? [])
      .filter((placement): placement is RealmPlacement & { path: string } => placement.path !== undefined)
      .map((placement) => [seedSlotKey(placement.path, placement.target), placement] as const)
  );
  const seen: Set<string> = new Set();
  if (pkg.files !== undefined) {
    if (!Array.isArray(pkg.files)) {
      throw packageError('hydration package files must be an array of file entries');
    }
    pkg.files.forEach((entry, index) => {
      const label = `hydration package files[${index}]`;
      if (!isPlainRecord(entry)) {
        throw packageError(`${label} must be an object`);
      }
      rejectUnknownFields(entry, PACKAGE_FILE_FIELDS, label);
      const path = requireSafePath(entry.path, `${label} path`);
      const target = validateSeedTarget(entry.target, `${label} target`, agentKeys);
      if (typeof entry.content !== 'string') {
        throw packageError(`${label} content must be a string`);
      }
      const key = seedSlotKey(path, target);
      if (seen.has(key)) {
        throw packageError(`${label} duplicates the entry for seed slot '${path}'`);
      }
      seen.add(key);
      const placement = placementsByKey.get(key);
      if (placement === undefined) {
        throw packageError(`${label} does not match any declared placement (path+target)`);
      }
      if (placement.file !== undefined) {
        throw packageError(
          `${label} targets fixed placement '${path}'; fixed content ships in the bundle and must not appear in a package`
        );
      }
      const declaration = declarationsById.get(placement.inputId as string);
      if (declaration === undefined) {
        throw packageError(`${label} references undeclared input '${String(placement.inputId)}'`);
      }
      if (declaration.shape !== 'files') {
        throw packageError(
          `${label} targets text input '${declaration.id}'; a format-v1 package file entry needs a files input`
        );
      }
      const existing = Object.prototype.hasOwnProperty.call(inputs, declaration.id)
        ? inputs[declaration.id]
        : undefined;
      const files = existing !== undefined && existing.shape === 'files' ? [...existing.files] : [];
      files.push({ path, content: entry.content });
      inputs[declaration.id] = { shape: 'files', files };
    });
  }

  return {
    templateId,
    templateVersion,
    inputs,
    ...(provenance !== undefined ? { provenance } : {})
  };
}

/**
 * Validates a payload (or a format-v1 hydration package) against a template's
 * declared contract.
 *
 * The template normalizes first (legacy v1 documents shim to the canonical
 * model). The closed payload envelope requires a matching `templateId`, a
 * `templateVersion` pin, and an `inputs` record keyed by declared input id
 * whose values match each declaration's shape (`{ text }` / non-empty
 * `{ files }` with unique safe paths); unknown keys and shape mismatches fail
 * closed, and every `required` input must be present and non-empty. The pinned
 * version is compared against `opts.currentVersion`: a mismatch is a typed
 * `ERR_HYDRATION_VERSION_MISMATCH` unless `allowVersionMismatch` is `true`, in
 * which case it is reported in `warnings`.
 *
 * @param template - Template the payload targets (legacy format-v1 documents accepted)
 * @param payload - Candidate payload (or legacy hydration package)
 * @param opts - Optional `currentVersion` (effective bundle version) and `allowVersionMismatch` confirmation
 * @returns The deeply frozen resolved payload
 * @throws `RealmCatalogError` - `ERR_TEMPLATE_INVALID` for an invalid template, `ERR_HYDRATION_PACKAGE` for an invalid payload, `ERR_HYDRATION_VERSION_MISMATCH` for a disallowed version mismatch
 *
 * @example
 * ```typescript
 * import { validatePayload } from './realmCatalog/index.ts';
 *
 * const resolved = validatePayload(DEMO_TEMPLATE, {
 *   formatVersion: 2,
 *   templateId: 'demo',
 *   templateVersion: 'sha256:…',
 *   inputs: {}
 * }, { allowVersionMismatch: true });
 * ```
 */
export function validatePayload(
  template: RealmTemplate,
  payload: unknown,
  opts?: { allowVersionMismatch?: boolean; currentVersion?: string }
): ResolvedPayload {
  let validated: RealmTemplate;
  try {
    validated = normalizeTemplate(template);
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }

  if (opts !== undefined) {
    if (!isPlainRecord(opts)) {
      throw packageError('validatePayload options must be an object');
    }
    try {
      rejectUnknownFields(
        opts,
        new Set(['allowVersionMismatch', 'currentVersion']),
        'validatePayload options'
      );
      if (opts.allowVersionMismatch !== undefined && typeof opts.allowVersionMismatch !== 'boolean') {
        throw new Error('validatePayload allowVersionMismatch must be a boolean');
      }
      if (opts.currentVersion !== undefined) {
        requireNonEmptyString(opts.currentVersion, 'validatePayload currentVersion');
      }
    } catch (error) {
      throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
    }
  }
  const allowVersionMismatch = opts?.allowVersionMismatch === true;
  const currentVersion = typeof opts?.currentVersion === 'string' ? opts.currentVersion : undefined;

  try {
    if (!isPlainRecord(payload)) {
      throw packageError('payload must be an object');
    }
    if (payload.formatVersion !== 1 && payload.formatVersion !== 2) {
      throw packageError(`payload formatVersion must be 1 or 2 (got '${String(payload.formatVersion)}')`);
    }

    let templateId: string;
    let templateVersion: string;
    let inputs: Record<string, RealmInputValue>;
    if (payload.formatVersion === 1) {
      const converted = convertLegacyPackageV1(payload, validated);
      templateId = converted.templateId;
      templateVersion = converted.templateVersion;
      inputs = converted.inputs;
    } else {
      rejectUnknownFields(payload, PAYLOAD_FIELDS, 'payload');
      templateId = requireNonEmptyString(payload.templateId, 'payload templateId');
      templateVersion = requireNonEmptyString(payload.templateVersion, 'payload templateVersion');
      const declarationsById: ReadonlyMap<string, RealmTemplateInput> = new Map(
        (validated.inputs ?? []).map((input) => [input.id, input] as const)
      );
      inputs = validatePayloadInputs(payload.inputs, declarationsById, 'payload inputs');
      validatePayloadProvenance(payload.provenance, 'payload provenance');
    }

    if (templateId !== validated.id) {
      throw packageError(`payload targets template '${templateId}' but was validated against '${validated.id}'`);
    }

    for (const declaration of validated.inputs ?? []) {
      if (declaration.required !== true) continue;
      const label = `input '${declaration.id}' (${declaration.label})`;
      if (!Object.prototype.hasOwnProperty.call(inputs, declaration.id)) {
        throw packageError(`required ${label} is missing from the payload`);
      }
      const value = inputs[declaration.id];
      if (value.shape === 'text' ? value.text.trim().length === 0 : value.files.length === 0) {
        throw packageError(`required ${label} resolves empty`);
      }
    }

    const warnings: string[] = [];
    if (currentVersion !== undefined && currentVersion !== templateVersion) {
      const mismatch =
        `payload pins template version '${templateVersion}' but the current template version is '${currentVersion}'`;
      if (!allowVersionMismatch) {
        throw new RealmCatalogError(
          `${mismatch}; pass allowVersionMismatch to accept the mismatch`,
          REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_VERSION_MISMATCH
        );
      }
      warnings.push(`${mismatch}; the mismatch was explicitly allowed.`);
    }

    return deepFreeze({
      templateId: validated.id,
      templateVersion,
      // Plain-prototype copy for the public shape; own data properties are
      // defined by the spread, so no key can invoke a prototype setter.
      inputs: { ...inputs },
      warnings
    });
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
  }
}

/**
 * Computes the canonical content digest of an authored payload.
 *
 * The digest is `sha256:<hex>` over the payload re-serialized as UTF-8 JSON
 * with recursively sorted keys and no insignificant whitespace (the same
 * canonicalization the bundle version uses), so it identifies the payload
 * bytes independently of key order. Only plain JSON data is accepted.
 *
 * @param payload - Payload value to digest
 * @returns The digest string (`sha256:<64 lowercase hex>`)
 * @throws `RealmCatalogError` (`ERR_HYDRATION_PACKAGE`) - When the value is not plain finite JSON data
 *
 * @example
 * ```typescript
 * import { payloadDigest } from './realmCatalog/index.ts';
 *
 * payloadDigest({ formatVersion: 2, templateId: 'demo', templateVersion: 'sha256:…', inputs: {} });
 * // 'sha256:…'
 * ```
 */
export function payloadDigest(payload: unknown): string {
  try {
    return `sha256:${sha256Hex(canonicalJsonStringify(payload))}`;
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
  }
}
