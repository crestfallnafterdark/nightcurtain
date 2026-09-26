/**
 * Module-private validation and freeze helpers for the `extensionRegistry`
 * module: install-record normalizing, attachment normalizing, call-name
 * hygiene, and extension tool-reference parsing.
 */

import { deriveToolCallName, isReservedToolCallName } from '../tools/normalizers/index.ts';
import {
  EXTENSION_REGISTRY_ERROR_CODES,
  ExtensionRegistryError
} from './errors.ts';
import { EXTENSION_KINDS } from './types.ts';
import type {
  ExtensionInstallRecord,
  ExtensionInstallSource,
  ExtensionInstallStatus,
  ExtensionKind,
  ExtensionRequest,
  ExtensionTransportHint,
  RealmExtensionAttachment,
  ExtensionAttachmentStatus
} from './types.ts';

/**
 * Object keys that must never become dynamic record keys. A derived call name
 * or identifier equal to one of these would otherwise pollute a projection
 * object built from template content.
 */
const RESERVED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype'
]);

/**
 * Narrows an unknown value to a plain record.
 *
 * @param value - Candidate value
 * @returns `true` when the value is a non-null, non-array object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds a typed registry error.
 *
 * @param code - Stable error code
 * @param message - Human-readable failure description
 * @returns The typed error
 */
export function registryError(
  code: (typeof EXTENSION_REGISTRY_ERROR_CODES)[keyof typeof EXTENSION_REGISTRY_ERROR_CODES],
  message: string
): ExtensionRegistryError {
  return new ExtensionRegistryError(message, code);
}

/**
 * Validates one extension id: a non-empty trimmed string that is not a
 * reserved property name. Ids are matched exactly as declared.
 *
 * @param value - Candidate id
 * @param label - Human-readable label used in error messages
 * @returns The validated id string
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_RECORD` or `ERR_EXTENSION_INVALID_ATTACHMENT` for invalid values
 */
export function requireExtensionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} must be a non-empty string`);
  }
  if (RESERVED_PROPERTY_NAMES.has(value)) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} must not be a reserved property name`);
  }
  return value;
}

/**
 * Validates the extension kind discriminator.
 *
 * @param value - Candidate kind
 * @param label - Human-readable label used in error messages
 * @returns The validated kind
 */
export function requireExtensionKind(value: unknown, label: string): ExtensionKind {
  if (value !== EXTENSION_KINDS.MCP && value !== EXTENSION_KINDS.PACK) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} must be 'mcp' or 'pack'`);
  }
  return value;
}

/**
 * Validates a transport hint and returns its frozen deep copy. The hint kind
 * must be compatible with the owning extension kind (MCP → http/stdio,
 * pack → pack).
 *
 * @param value - Candidate transport hint
 * @param kind - Owning extension kind
 * @param label - Human-readable label used in error messages
 * @returns The frozen transport hint copy
 */
export function normalizeTransportHint(
  value: unknown,
  kind: ExtensionKind,
  label: string
): ExtensionTransportHint {
  if (!isRecord(value)) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} must be an object`);
  }
  const hintKind = value.kind;
  if (kind === 'pack') {
    if (hintKind !== 'pack') {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD,
        `${label} must be a pack transport hint for a pack extension`
      );
    }
    if (typeof value.source !== 'string' || value.source.trim().length === 0) {
      throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} source must be a non-empty string`);
    }
    return Object.freeze({ kind: 'pack', source: value.source });
  }
  if (hintKind === 'http') {
    if (typeof value.url !== 'string' || value.url.trim().length === 0) {
      throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} url must be a non-empty string`);
    }
    return Object.freeze({ kind: 'http', url: value.url });
  }
  if (hintKind === 'stdio') {
    if (typeof value.command !== 'string' || value.command.trim().length === 0) {
      throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} command must be a non-empty string`);
    }
    let args: readonly string[] | undefined;
    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string')) {
        throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} args must be an array of strings`);
      }
      args = Object.freeze([...(value.args as string[])]);
    }
    return Object.freeze({
      kind: 'stdio',
      command: value.command,
      ...(args !== undefined ? { args } : {})
    });
  }
  throw registryError(
    EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD,
    `${label} kind must be 'http', 'stdio', or 'pack'`
  );
}

/**
 * Validates one optional non-empty string field of an install record.
 *
 * @param value - Candidate field value
 * @param label - Human-readable label used in error messages
 * @returns The validated string, or `undefined` when absent
 */
function normalizeOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, `${label} must be a non-empty string`);
  }
  return value;
}

/**
 * Freezes one install record as a fresh deep copy (nested arrays fresh).
 *
 * @param record - Valid install record
 * @returns New deeply frozen install record
 */
export function cloneInstallRecord(record: ExtensionInstallRecord): ExtensionInstallRecord {
  const hint = record.transportHint;
  const transportHint: ExtensionTransportHint = hint.kind === 'http'
    ? Object.freeze({ kind: 'http', url: hint.url })
    : hint.kind === 'stdio'
      ? Object.freeze({
          kind: 'stdio',
          command: hint.command,
          ...(hint.args !== undefined ? { args: Object.freeze([...hint.args]) } : {})
        })
      : Object.freeze({ kind: 'pack', source: hint.source });
  return Object.freeze({
    id: record.id,
    kind: record.kind,
    ...(record.displayName !== undefined ? { displayName: record.displayName } : {}),
    transportHint,
    ...(record.credentialId !== undefined ? { credentialId: record.credentialId } : {}),
    status: record.status,
    installSource: record.installSource,
    ...(record.approvedUrl !== undefined ? { approvedUrl: record.approvedUrl } : {}),
    ...(record.normalizationWarnings !== undefined
      ? { normalizationWarnings: Object.freeze([...record.normalizationWarnings]) }
      : {}),
    createdAt: record.createdAt
  });
}

/**
 * Validates an unknown value into a frozen install record, or throws.
 *
 * @param value - Candidate install record
 * @returns The frozen validated record
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_RECORD` when the shape is invalid
 */
export function normalizeInstallRecord(value: unknown): ExtensionInstallRecord {
  if (!isRecord(value)) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD, 'Install record must be an object');
  }
  const id = requireExtensionId(value.id, 'Install record id');
  const kind = requireExtensionKind(value.kind, `Install record '${id}' kind`);
  const transportHint = normalizeTransportHint(value.transportHint, kind, `Install record '${id}' transportHint`);
  const displayName = normalizeOptionalString(value.displayName, `Install record '${id}' displayName`);
  const credentialId = normalizeOptionalString(value.credentialId, `Install record '${id}' credentialId`);
  const approvedUrl = normalizeOptionalString(value.approvedUrl, `Install record '${id}' approvedUrl`);

  const status = value.status;
  if (status !== 'installed' && status !== 'unavailable' && status !== 'error') {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD,
      `Install record '${id}' status must be 'installed', 'unavailable', or 'error'`
    );
  }
  const installSource = value.installSource;
  if (installSource !== 'operator' && installSource !== 'template-assist') {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD,
      `Install record '${id}' installSource must be 'operator' or 'template-assist'`
    );
  }

  let normalizationWarnings: readonly string[] | undefined;
  if (value.normalizationWarnings !== undefined) {
    if (!Array.isArray(value.normalizationWarnings)
      || value.normalizationWarnings.some((warning) => typeof warning !== 'string' || warning.trim().length === 0)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD,
        `Install record '${id}' normalizationWarnings must be an array of non-empty strings`
      );
    }
    normalizationWarnings = Object.freeze([...(value.normalizationWarnings as string[])]);
  }

  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RECORD,
      `Install record '${id}' createdAt must be a finite number`
    );
  }

  return Object.freeze({
    id,
    kind,
    ...(displayName !== undefined ? { displayName } : {}),
    transportHint,
    ...(credentialId !== undefined ? { credentialId } : {}),
    status: status as ExtensionInstallStatus,
    installSource: installSource as ExtensionInstallSource,
    ...(approvedUrl !== undefined ? { approvedUrl } : {}),
    ...(normalizationWarnings !== undefined ? { normalizationWarnings } : {}),
    createdAt: value.createdAt
  });
}

/**
 * Validates one tool selection: `'all'`, or a non-empty array of unique
 * sanitized, non-reserved model-facing call names.
 *
 * @param value - Candidate tool selection
 * @param label - Human-readable label used in error messages
 * @returns The frozen validated selection
 */
export function normalizeToolSelection(value: unknown, label: string): 'all' | readonly string[] {
  if (value === 'all') return 'all';
  if (!Array.isArray(value) || value.length === 0) {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      `${label} must be 'all' or a non-empty array of sanitized call names`
    );
  }
  const names: string[] = [];
  for (const entry of value) {
    const callName = normalizeCallName(entry, label);
    if (names.includes(callName)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
        `${label} carries duplicate call name '${callName}'`
      );
    }
    names.push(callName);
  }
  return Object.freeze(names);
}

/**
 * Validates one sanitized model-facing call name: a non-empty string equal to
 * its own derivation, not the wildcard, not reserved by the baked/publishing
 * surface, and not a reserved property name.
 *
 * @param value - Candidate call name
 * @param label - Human-readable label used in error messages
 * @returns The validated call name
 */
export function normalizeCallName(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      `${label} entries must be non-empty strings`
    );
  }
  if (value === '*') {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      `${label} must not carry the internal wildcard '*' — use 'all' for an extension-wide selection`
    );
  }
  if (deriveToolCallName(value) !== value) {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      `${label} entry '${value}' must already be a sanitized call name`
    );
  }
  if (RESERVED_PROPERTY_NAMES.has(value) || isReservedToolCallName(value)) {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      `${label} entry '${value}' is a reserved tool call name`
    );
  }
  return value;
}

/**
 * Validates a complete attachment into a frozen record, or throws. Used for
 * caller input (realm attach paths), where a malformed attachment fails
 * closed.
 *
 * @param value - Candidate attachment record
 * @param label - Human-readable label used in error messages
 * @returns The frozen validated attachment
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_ATTACHMENT` when the shape is invalid
 */
export function assertAttachment(value: unknown, label: string): RealmExtensionAttachment {
  if (!isRecord(value)) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT, `${label} must be an object`);
  }
  let extensionId: string;
  try {
    extensionId = requireExtensionId(value.extensionId, `${label} extensionId`);
  } catch (error) {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      error instanceof Error ? error.message : String(error)
    );
  }
  const toolSelection = normalizeToolSelection(value.toolSelection, `${label} toolSelection`);
  const status = value.status;
  if (status !== 'active' && status !== 'conflict' && status !== 'unavailable') {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      `${label} status must be 'active', 'conflict', or 'unavailable'`
    );
  }
  if (typeof value.approvedAt !== 'string' || value.approvedAt.trim().length === 0) {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      `${label} approvedAt must be a non-empty ISO-8601 string`
    );
  }
  if (value.approvedBy !== 'operator') {
    throw registryError(
      EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_ATTACHMENT,
      `${label} approvedBy must be 'operator'`
    );
  }
  return Object.freeze({
    extensionId,
    toolSelection,
    status: status as ExtensionAttachmentStatus,
    approvedAt: value.approvedAt,
    approvedBy: 'operator'
  });
}

/**
 * Parses an unknown value into a frozen attachment record, or `null` when the
 * shape is invalid. Used on snapshot/adapter ingest paths, where a malformed
 * attachment entry is dropped while its enclosing record survives.
 *
 * @param value - Candidate attachment record
 * @returns The frozen attachment, or `null` when invalid
 */
export function normalizeAttachment(value: unknown): RealmExtensionAttachment | null {
  try {
    return assertAttachment(value, 'Attachment');
  } catch {
    return null;
  }
}

/**
 * Narrows an unknown value to a valid attachment record. Convenience predicate
 * over {@link normalizeAttachment} for structural filtering.
 *
 * @param value - Candidate attachment record
 * @returns `true` when the value is a valid attachment
 */
export function isRealmExtensionAttachment(value: unknown): value is RealmExtensionAttachment {
  return normalizeAttachment(value) !== null;
}

/**
 * Parses one `<providerId>::<serverToolName>` extension tool reference: the
 * first `::` separates the segments, both must be non-empty.
 *
 * @param reference - Candidate reference string
 * @returns The parsed segments, or `null` when malformed
 */
export function parseExtensionToolReference(
  reference: unknown
): { extensionId: string; serverToolName: string } | null {
  if (typeof reference !== 'string') return null;
  const separatorIndex = reference.indexOf('::');
  if (separatorIndex <= 0) return null;
  const extensionId = reference.slice(0, separatorIndex);
  const serverToolName = reference.slice(separatorIndex + 2);
  if (serverToolName.trim().length === 0) return null;
  return { extensionId, serverToolName };
}

/**
 * Validates one resolution request entry into a frozen record.
 *
 * @param value - Candidate request entry
 * @param label - Human-readable label used in error messages
 * @returns The frozen validated request
 */
export function normalizeExtensionRequest(value: unknown, label: string): ExtensionRequest {
  if (!isRecord(value)) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION, `${label} must be an object`);
  }
  if (typeof value.id !== 'string' || value.id.trim().length === 0) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION, `${label} id must be a non-empty string`);
  }
  const kind = value.kind;
  if (kind !== 'mcp' && kind !== 'pack') {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION, `${label} kind must be 'mcp' or 'pack'`);
  }
  if (value.displayName !== undefined && (typeof value.displayName !== 'string' || value.displayName.trim().length === 0)) {
    throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION, `${label} displayName must be a non-empty string`);
  }
  let transportHint: ExtensionTransportHint | undefined;
  if (value.transportHint !== undefined) {
    try {
      transportHint = normalizeTransportHint(value.transportHint, kind, `${label} transportHint`);
    } catch (error) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  return Object.freeze({
    id: value.id,
    kind,
    ...(value.displayName !== undefined ? { displayName: value.displayName as string } : {}),
    ...(transportHint !== undefined ? { transportHint } : {})
  });
}
