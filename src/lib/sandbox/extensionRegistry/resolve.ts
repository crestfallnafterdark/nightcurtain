/**
 * Pure extension resolution for the `extensionRegistry` module: projects a
 * template's requested extensions and declared `<providerId>::<serverToolName>`
 * references onto the host's installed records and one realm's attachments.
 */

import { deriveToolCallName, isReservedToolCallName } from '../tools/normalizers/index.ts';
import {
  EXTENSION_REGISTRY_ERROR_CODES,
  ExtensionRegistryError
} from './errors.ts';
import {
  isRecord,
  normalizeAttachment,
  normalizeExtensionRequest,
  normalizeInstallRecord,
  parseExtensionToolReference,
  registryError
} from './validate.ts';
import type {
  ExtensionInstallRecord,
  ExtensionRequest,
  ExtensionResolution,
  ExtensionResolutionInput,
  MissingExtension,
  MissingExtensionTool,
  MissingExtensionToolReason,
  RealmExtensionAttachment
} from './types.ts';

/** Object keys that must never become dynamic projection keys. */
const RESERVED_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype'
]);

/**
 * Wraps any validation failure as an invalid-resolution error so the
 * resolution entry point exposes one stable code.
 *
 * @param error - Unknown thrown value
 * @returns The typed invalid-resolution error
 */
function asResolutionError(error: unknown): ExtensionRegistryError {
  if (error instanceof ExtensionRegistryError
    && error.code === EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION) {
    return error;
  }
  return registryError(
    EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
    error instanceof Error ? error.message : String(error)
  );
}

/**
 * Validates the resolution context (installed records and realm attachments)
 * and indexes it by extension id. Duplicate install ids and duplicate
 * attachment ids fail closed: the resolution input must describe one state per
 * extension.
 *
 * @param input - Validated resolution input
 * @returns Install index and attachment index
 */
function indexContext(input: ExtensionResolutionInput): {
  installsById: Map<string, ExtensionInstallRecord>;
  attachmentsById: Map<string, RealmExtensionAttachment>;
} {
  const installsById = new Map<string, ExtensionInstallRecord>();
  for (const candidate of input.installs) {
    const record = normalizeInstallRecord(candidate);
    if (installsById.has(record.id)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        `Resolution context installs carry duplicate extension id '${record.id}'`
      );
    }
    installsById.set(record.id, record);
  }
  const attachmentsById = new Map<string, RealmExtensionAttachment>();
  for (const candidate of input.attachments) {
    const attachment = normalizeAttachment(candidate);
    if (!attachment) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        'Resolution context carries a malformed attachment'
      );
    }
    if (attachmentsById.has(attachment.extensionId)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        `Resolution context attachments carry duplicate extension id '${attachment.extensionId}'`
      );
    }
    attachmentsById.set(attachment.extensionId, attachment);
  }
  return { installsById, attachmentsById };
}

/**
 * Validates the requested extensions (unique ids, shape, kind-compatible
 * transport hints) and the declared tool references (well-formed, naming a
 * declared request, unreserved unique derived call names).
 *
 * @param input - Candidate resolution input
 * @returns Validated requests in declared order and parsed references
 */
function validateRequests(input: ExtensionResolutionInput): {
  requests: readonly ExtensionRequest[];
  references: ReadonlyArray<{ reference: string; extensionId: string; callName: string }>;
} {
  const requests: ExtensionRequest[] = [];
  const requestIds = new Set<string>();
  for (const candidate of input.requests) {
    const request = normalizeExtensionRequest(candidate, 'Resolution request');
    if (requestIds.has(request.id)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        `Resolution requests carry duplicate extension id '${request.id}'`
      );
    }
    requestIds.add(request.id);
    requests.push(request);
  }

  const references: Array<{ reference: string; extensionId: string; callName: string }> = [];
  const referenceByCallName = new Map<string, string>();
  for (const raw of input.toolReferences) {
    if (typeof raw !== 'string') {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        'Resolution tool references must be strings'
      );
    }
    const parsed = parseExtensionToolReference(raw);
    if (!parsed) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        `Resolution tool reference '${raw}' must be a '<providerId>::<serverToolName>' reference`
      );
    }
    if (!requestIds.has(parsed.extensionId)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        `Resolution tool reference '${raw}' names undeclared extension '${parsed.extensionId}'`
      );
    }
    const callName = deriveToolCallName(parsed.serverToolName);
    if (RESERVED_PROPERTY_NAMES.has(callName) || isReservedToolCallName(callName)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        `Resolution tool reference '${raw}' derives the reserved tool call name '${callName}'`
      );
    }
    const existingReference = referenceByCallName.get(callName);
    if (existingReference !== undefined) {
      if (existingReference === raw) continue; // Exact duplicate reference: idempotent.
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        `Resolution tool reference '${raw}' derives the call name '${callName}', already claimed by '${existingReference}'`
      );
    }
    referenceByCallName.set(callName, raw);
    references.push({ reference: raw, extensionId: parsed.extensionId, callName });
  }
  return { requests: Object.freeze(requests), references: Object.freeze(references) };
}

/**
 * Resolves a template's extension requests and declared tool references
 * against the passed host state.
 *
 * Resolution is exact and deterministic:
 * - an extension resolves only when its id is installed AND it carries an
 *   `active` attachment;
 * - a tool reference resolves only when its extension resolved and the
 *   attachment's tool selection is `'all'` or includes the derived call name;
 * - `resolvedTools` maps the sanitized call name to the extension id in
 *   declared reference order, `missingExtensions` lists requested extensions
 *   that did not resolve in declared request order, and `missingTools` lists
 *   unresolved references in declared reference order.
 *
 * Malformed input (request shape, reference shape, undeclared reference
 * targets, duplicate request/install/attachment ids, or reserving/colliding
 * derived call names) fails closed with `ERR_EXTENSION_INVALID_RESOLUTION`.
 * The returned projection is deeply frozen.
 *
 * @param input - Requests, references, installs, and attachments to resolve
 * @returns The frozen resolution projection
 * @throws {@link ExtensionRegistryError} With `ERR_EXTENSION_INVALID_RESOLUTION` when the input is inconsistent
 *
 * @example
 * ```typescript
 * import { resolveExtensionRequests } from './extensionRegistry/index.ts';
 *
 * const resolution = resolveExtensionRequests({
 *   requests: [{ id: 'acme-scoring', kind: 'mcp' }],
 *   toolReferences: ['acme-scoring::similarity'],
 *   installs: [installedRecord],
 *   attachments: [activeAttachment]
 * });
 * // resolution.resolvedTools => { similarity: 'acme-scoring' }
 * ```
 */
export function resolveExtensionRequests(input: ExtensionResolutionInput): ExtensionResolution {
  try {
    if (!isRecord(input)) {
      throw registryError(EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION, 'Resolution input must be an object');
    }
    if (!Array.isArray(input.requests) || !Array.isArray(input.toolReferences)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        'Resolution input requires requests and toolReferences arrays'
      );
    }
    if (!Array.isArray(input.installs) || !Array.isArray(input.attachments)) {
      throw registryError(
        EXTENSION_REGISTRY_ERROR_CODES.ERR_EXTENSION_INVALID_RESOLUTION,
        'Resolution input requires installs and attachments arrays'
      );
    }

    const { requests, references } = validateRequests(input);
    const { installsById, attachmentsById } = indexContext(input);

    const missingExtensions: MissingExtension[] = [];
    const missingReasonByExtensionId = new Map<string, 'not-installed' | 'not-attached'>();
    for (const request of requests) {
      const installed = installsById.has(request.id);
      const attachment = attachmentsById.get(request.id);
      const attached = attachment !== undefined && attachment.status === 'active';
      if (installed && attached) continue;
      const reason = installed ? 'not-attached' : 'not-installed';
      missingReasonByExtensionId.set(request.id, reason);
      missingExtensions.push(Object.freeze({ extensionId: request.id, kind: request.kind, reason }));
    }

    const resolvedTools: Record<string, string> = {};
    const missingTools: MissingExtensionTool[] = [];
    for (const reference of references) {
      const missingExtensionReason = missingReasonByExtensionId.get(reference.extensionId);
      if (missingExtensionReason !== undefined) {
        missingTools.push(Object.freeze({
          reference: reference.reference,
          extensionId: reference.extensionId,
          callName: reference.callName,
          reason: missingExtensionReason
        }));
        continue;
      }
      const attachment = attachmentsById.get(reference.extensionId) as RealmExtensionAttachment;
      if (attachment.toolSelection !== 'all' && !attachment.toolSelection.includes(reference.callName)) {
        const reason: MissingExtensionToolReason = 'selection-excluded';
        missingTools.push(Object.freeze({
          reference: reference.reference,
          extensionId: reference.extensionId,
          callName: reference.callName,
          reason
        }));
        continue;
      }
      resolvedTools[reference.callName] = reference.extensionId;
    }

    return Object.freeze({
      resolvedTools: Object.freeze(resolvedTools),
      missingExtensions: Object.freeze(missingExtensions),
      missingTools: Object.freeze(missingTools)
    });
  } catch (error) {
    throw asResolutionError(error);
  }
}
