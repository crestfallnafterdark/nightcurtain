/**
 * Hydration package validation for the `realmCatalog` module.
 *
 * A hydration package is an instance's content: generated/user input values
 * plus one file entry per declared `user`/`generated` seed slot. It is
 * validated fail-closed against the template's declared contract — entries
 * must match a declared slot by path and target, `fixed` slots must not
 * appear, unknown or duplicate entries are rejected, and every `generated`
 * slot must be present. The package pins the template version it was hydrated
 * against; a mismatch is a typed error unless the caller explicitly allows it,
 * in which case it is reported as a review warning.
 */

import { REALM_CATALOG_ERROR_CODES, RealmCatalogError, toCatalogError } from './errors.ts';
import { deepFreeze } from './freeze.ts';
import {
  isPlainRecord,
  rejectUnknownFields,
  requireNonEmptyString,
  requireSafePath,
  seedSlotKey,
  validateSeedTarget,
  validateTemplate
} from './validation.ts';
import type { RealmTemplate, RealmTemplateSeedFile, ResolvedHydration, ResolvedHydrationFile } from './types.ts';

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

/**
 * Validates one hydration-package file entry against the closed schema shape.
 *
 * @param candidate - Candidate entry
 * @param label - Human-readable label used in error messages
 * @param agentKeys - Declared template agent keys (target membership check)
 * @returns The validated entry
 */
function validatePackageFile(
  candidate: unknown,
  label: string,
  agentKeys: ReadonlySet<string>
): ResolvedHydrationFile {
  if (!isPlainRecord(candidate)) {
    throw packageError(`${label} must be an object`);
  }
  try {
    rejectUnknownFields(candidate, PACKAGE_FILE_FIELDS, label);
    requireSafePath(candidate.path, `${label} path`);
    validateSeedTarget(candidate.target, `${label} target`, agentKeys);
    if (typeof candidate.content !== 'string') {
      throw new Error(`${label} content must be a string`);
    }
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
  }
  return candidate as unknown as ResolvedHydrationFile;
}

/**
 * Validates the optional package provenance block (closed shape; all fields
 * optional non-empty strings, never secrets).
 *
 * @param candidate - Candidate provenance block
 * @param label - Human-readable label used in error messages
 */
function validatePackageProvenance(candidate: unknown, label: string): void {
  if (candidate === undefined) return;
  if (!isPlainRecord(candidate)) {
    throw packageError(`${label} must be an object`);
  }
  try {
    rejectUnknownFields(candidate, PACKAGE_PROVENANCE_FIELDS, label);
    for (const field of PACKAGE_PROVENANCE_FIELDS) {
      if (candidate[field] !== undefined) {
        requireNonEmptyString(candidate[field], `${label} ${field}`);
      }
    }
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
  }
}

/**
 * Validates a hydration package against a template's declared contract.
 *
 * Checks, in order: the template itself (typed `ERR_TEMPLATE_INVALID`); the
 * closed package envelope (`formatVersion: 1`, `templateId` equal to the
 * template id, `templateVersion`); declared input ids for `inputs`; one entry
 * per `user`/`generated` slot matched by path+target (unknown/duplicate
 * entries and `fixed`-slot entries rejected, every `generated` slot present);
 * and the pinned version. When `opts.currentVersion` is supplied and differs
 * from the package's `templateVersion`, the mismatch is a typed
 * `ERR_HYDRATION_VERSION_MISMATCH` unless `opts.allowVersionMismatch` is
 * `true`, in which case it is reported in `warnings` (review surfaces call
 * with the flag; launch passes it only after explicit user confirmation).
 *
 * @param template - Template the package targets
 * @param pkg - Candidate hydration package (object)
 * @param opts - Optional `currentVersion` (effective bundle version) and `allowVersionMismatch` confirmation
 * @returns The deeply frozen resolved hydration package
 * @throws `RealmCatalogError` - `ERR_TEMPLATE_INVALID` for an invalid template, `ERR_HYDRATION_PACKAGE` for an invalid package, `ERR_HYDRATION_VERSION_MISMATCH` for a disallowed version mismatch
 *
 * @example
 * ```typescript
 * import { validateHydrationPackage } from './realmCatalog/index.ts';
 *
 * const resolved = validateHydrationPackage(DEMO_TEMPLATE, {
 *   formatVersion: 1,
 *   templateId: 'demo',
 *   templateVersion: 'sha256:…',
 *   inputs: {},
 *   files: []
 * }, { allowVersionMismatch: true });
 * ```
 */
export function validateHydrationPackage(
  template: RealmTemplate,
  pkg: unknown,
  opts?: { allowVersionMismatch?: boolean; currentVersion?: string }
): ResolvedHydration {
  let validated: RealmTemplate;
  try {
    validated = validateTemplate(template);
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }

  if (opts !== undefined) {
    if (!isPlainRecord(opts)) {
      throw packageError('validateHydrationPackage options must be an object');
    }
    try {
      rejectUnknownFields(opts, new Set(['allowVersionMismatch', 'currentVersion']), 'validateHydrationPackage options');
      if (opts.allowVersionMismatch !== undefined && typeof opts.allowVersionMismatch !== 'boolean') {
        throw new Error('validateHydrationPackage allowVersionMismatch must be a boolean');
      }
      if (opts.currentVersion !== undefined) {
        requireNonEmptyString(opts.currentVersion, 'validateHydrationPackage currentVersion');
      }
    } catch (error) {
      throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
    }
  }
  const allowVersionMismatch = opts?.allowVersionMismatch === true;
  const currentVersion = typeof opts?.currentVersion === 'string' ? opts.currentVersion : undefined;

  if (!isPlainRecord(pkg)) {
    throw packageError('hydration package must be an object');
  }
  try {
    rejectUnknownFields(pkg, PACKAGE_FIELDS, 'hydration package');
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
  }
  if (pkg.formatVersion !== 1) {
    throw packageError(`hydration package formatVersion must be 1 (got '${String(pkg.formatVersion)}')`);
  }
  let templateId: string;
  let templateVersion: string;
  try {
    templateId = requireNonEmptyString(pkg.templateId, 'hydration package templateId');
    templateVersion = requireNonEmptyString(pkg.templateVersion, 'hydration package templateVersion');
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_HYDRATION_PACKAGE);
  }
  if (templateId !== validated.id) {
    throw packageError(
      `hydration package targets template '${templateId}' but was validated against '${validated.id}'`
    );
  }
  validatePackageProvenance(pkg.provenance, 'hydration package provenance');

  const declaredInputs: ReadonlySet<string> = new Set((validated.inputs ?? []).map((input) => input.id));
  // Null prototype: a package key can never reach an Object.prototype setter
  // through this accumulator (T-V finding F1, ticket e4c8f91).
  const inputValues: Record<string, string> = Object.create(null);
  if (pkg.inputs !== undefined) {
    if (!isPlainRecord(pkg.inputs)) {
      throw packageError('hydration package inputs must be a record of string values');
    }
    for (const inputId of Object.keys(pkg.inputs)) {
      const value = pkg.inputs[inputId];
      if (typeof value !== 'string') {
        throw packageError(`hydration package inputs['${inputId}'] must be a string`);
      }
      if (!declaredInputs.has(inputId)) {
        throw packageError(`hydration package inputs names undeclared input '${inputId}'`);
      }
      inputValues[inputId] = value;
    }
  }

  const agentKeys: ReadonlySet<string> = new Set(validated.agents.map((spec) => spec.key));
  const slotsByKey: ReadonlyMap<string, RealmTemplateSeedFile> = new Map(
    (validated.seed?.files ?? []).map((file) => [seedSlotKey(file.path, file.target), file] as const)
  );
  const files: ResolvedHydrationFile[] = [];
  const seen: Set<string> = new Set();
  if (pkg.files !== undefined) {
    if (!Array.isArray(pkg.files)) {
      throw packageError('hydration package files must be an array of file entries');
    }
    pkg.files.forEach((entry, index) => {
      const label = `hydration package files[${index}]`;
      const validatedEntry = validatePackageFile(entry, label, agentKeys);
      const key = seedSlotKey(validatedEntry.path, validatedEntry.target);
      if (seen.has(key)) {
        throw packageError(`${label} duplicates the entry for seed slot '${validatedEntry.path}'`);
      }
      seen.add(key);
      const slot = slotsByKey.get(key);
      if (slot === undefined) {
        throw packageError(`${label} does not match any declared seed slot (path+target)`);
      }
      if ((slot.origin ?? 'fixed') === 'fixed') {
        throw packageError(
          `${label} targets fixed seed slot '${slot.path}'; fixed slots are shipped in the bundle and must not appear in a hydration package`
        );
      }
      files.push(validatedEntry);
    });
  }
  for (const slot of validated.seed?.files ?? []) {
    if ((slot.origin ?? 'fixed') !== 'generated') continue;
    if (!seen.has(seedSlotKey(slot.path, slot.target))) {
      throw packageError(
        `hydration package is missing the required generated seed slot '${slot.path}'`
      );
    }
  }

  const warnings: string[] = [];
  if (currentVersion !== undefined && currentVersion !== templateVersion) {
    const mismatch =
      `hydration package pins template version '${templateVersion}' but the current template version is '${currentVersion}'`;
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
    inputValues: { ...inputValues },
    files,
    warnings
  });
}
