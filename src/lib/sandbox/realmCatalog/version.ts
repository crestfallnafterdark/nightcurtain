/**
 * Per-bundle content versioning for the `realmCatalog` module.
 *
 * `templateBundleVersion()` computes the format-v1 `templateVersion` — a
 * `sha256:<hex>` digest over the canonical byte stream: the spec re-serialized
 * as UTF-8 JSON with recursively sorted keys and no insignificant whitespace,
 * followed by each referenced bundle file in lexicographic path order, each
 * framed as `<pathLength>:<path>\n<contentLength>:<content>` (lengths are
 * UTF-8 byte counts). Baked (build-time embedded) and imported (runtime JSON)
 * bundles are canonicalized through the same function, so the two paths hash
 * identically.
 *
 * This helper is intentionally separate from the pipeline's global
 * `REALM_CONTENT_VERSION`: the generated module version covers the whole
 * embedded payload (the build's freshness gate), while `templateBundleVersion`
 * identifies one bundle (the instance provenance pin).
 */

import { REALM_CATALOG_ERROR_CODES, toCatalogError } from './errors.ts';
import { deepFreeze } from './freeze.ts';
import { sha256Hex, utf8ByteLength } from './sha256.ts';
import { isPlainRecord, requireSafePath, validateTemplate } from './validation.ts';
import type { BundleFiles, RealmTemplate } from './types.ts';

/**
 * Renders a JSON value canonically: object keys recursively sorted, no
 * insignificant whitespace, JSON-standard string escaping.
 *
 * Only plain JSON data is accepted (finite numbers, strings, booleans, null,
 * arrays, plain objects); `undefined` object members are omitted like
 * `JSON.stringify` does and array holes become `null`.
 *
 * @param value - Value to render
 * @returns The canonical JSON text
 * @throws `Error` - When the value is not plain finite JSON data
 */
export function canonicalJsonStringify(value: unknown): string {
  return writeCanonical(value, 'value');
}

/**
 * Recursive canonical JSON writer.
 *
 * @param value - Value at the current position
 * @param path - Human-readable path used in error messages
 * @returns Canonical JSON text
 */
function writeCanonical(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} must be a finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item, index) => (
      item === undefined ? 'null' : writeCanonical(item, `${path}[${index}]`)
    ));
    return `[${items.join(',')}]`;
  }
  if (isPlainRecord(value)) {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${writeCanonical(value[key], `${path}.${key}`)}`);
    return `{${members.join(',')}}`;
  }
  throw new Error(`${path} must be plain JSON data (got ${typeof value})`);
}

/**
 * Validates one bundle files map: a plain record whose keys are safe
 * bundle-relative paths and whose values are strings.
 *
 * @param candidate - Candidate bundle files map
 * @returns The validated map reference
 * @throws `Error` - When the map or any entry is invalid
 */
export function validateBundleFiles(candidate: unknown): BundleFiles {
  if (!isPlainRecord(candidate)) {
    throw new Error('bundle files must be a record of file bodies');
  }
  for (const path of Object.keys(candidate)) {
    requireSafePath(path, 'bundle file path');
    if (typeof candidate[path] !== 'string') {
      throw new Error(`bundle files['${path}'] must be a string`);
    }
  }
  return candidate as BundleFiles;
}

/**
 * Validates a template plus its bundle files map into the canonical bundle
 * parts used by versioning, transport parsing, and serialization.
 *
 * @param bundle - Candidate bundle (`{ template, files }`)
 * @returns The validated template and files references
 * @throws `Error` - When the bundle, template, or files map is invalid
 */
export function validateBundleParts(bundle: unknown): { template: RealmTemplate; files: BundleFiles } {
  if (!isPlainRecord(bundle)) {
    throw new Error('template bundle must be an object');
  }
  const template = validateTemplate(bundle.template);
  const files = validateBundleFiles(bundle.files);
  return { template, files };
}

/**
 * Collects every bundle file path the template references: `file` prompt
 * parts, `file` history content parts, input `defaultFile` prefills, and
 * `fixed` seed `source.file` bodies.
 *
 * The result is deduplicated and sorted lexicographically by code unit (the
 * order the canonical version stream frames files in).
 *
 * @param template - Validated template
 * @returns Referenced bundle-relative paths in lexicographic order
 */
export function collectReferencedBundlePaths(template: RealmTemplate): readonly string[] {
  const references: Set<string> = new Set();
  const addParts = (parts: readonly { kind: string; path?: string }[]): void => {
    for (const part of parts) {
      if (part.kind === 'file' && typeof part.path === 'string') references.add(part.path);
    }
  };
  for (const agent of template.agents) {
    addParts(agent.prompt);
    for (const entry of agent.history ?? []) {
      addParts(entry.content);
    }
  }
  for (const input of template.inputs ?? []) {
    if (input.defaultFile !== undefined) references.add(input.defaultFile);
  }
  for (const file of template.seed?.files ?? []) {
    if ((file.origin ?? 'fixed') !== 'fixed' || file.source === undefined) continue;
    if ('file' in file.source) references.add(file.source.file);
  }
  return Object.freeze([...references].sort());
}

/**
 * Asserts that every referenced bundle file is present in the files map.
 *
 * @param template - Validated template
 * @param files - Validated bundle files map
 * @throws `Error` - When a referenced file is missing from the map
 */
export function assertBundleReferencesResolvable(template: RealmTemplate, files: BundleFiles): void {
  for (const path of collectReferencedBundlePaths(template)) {
    if (!Object.prototype.hasOwnProperty.call(files, path)) {
      throw new Error(`bundle references file '${path}' but the bundle files do not carry it`);
    }
  }
}

/**
 * Computes the per-bundle content version of a template bundle.
 *
 * The canonical byte stream is deterministic and synchronous: the spec
 * re-serialized as UTF-8 JSON with recursively sorted keys and no insignificant
 * whitespace, then each referenced bundle file in lexicographic path order,
 * each framed as `<pathLength>:<path>\n<contentLength>:<content>` (UTF-8 byte
 * counts). Baked and JSON-imported bundles hash identically because both go
 * through this same canonicalization.
 *
 * @param bundle - Bundle to version (`{ template, files }`)
 * @returns The version string (`sha256:<64 lowercase hex>`)
 * @throws `RealmCatalogError` (`ERR_TEMPLATE_INVALID`) - When the bundle, its template, files, or references are invalid
 *
 * @example
 * ```typescript
 * import { templateBundleVersion } from './realmCatalog/index.ts';
 *
 * templateBundleVersion({ template: DEMO_TEMPLATE, files: {} });
 * // 'sha256:…'
 * ```
 */
export function templateBundleVersion(bundle: { template: RealmTemplate; files: BundleFiles }): string {
  try {
    const { template, files } = validateBundleParts(bundle);
    assertBundleReferencesResolvable(template, files);
    const parts: string[] = [canonicalJsonStringify(template)];
    for (const path of collectReferencedBundlePaths(template)) {
      const content = files[path];
      parts.push(`${utf8ByteLength(path)}:${path}\n${utf8ByteLength(content)}:${content}`);
    }
    return `sha256:${sha256Hex(parts.join(''))}`;
  } catch (error) {
    throw toCatalogError(error, REALM_CATALOG_ERROR_CODES.ERR_TEMPLATE_INVALID);
  }
}

/**
 * Freezes a bundle's template and files in place and returns them.
 *
 * Internal helper used by the transport parser to return immutable parsed
 * bundles; callers should pass freshly parsed objects (the freeze is
 * intentional and documented at the public entry point).
 *
 * @param template - Validated template
 * @param files - Validated files map
 * @returns The same references, deeply frozen
 */
export function freezeBundleParts(
  template: RealmTemplate,
  files: BundleFiles
): { template: RealmTemplate; files: BundleFiles } {
  return { template: deepFreeze(template), files: deepFreeze(files) };
}
