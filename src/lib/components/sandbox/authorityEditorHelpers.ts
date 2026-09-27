/**
 * Operator authority editor helpers (ticket 62d89b8; compact-row redesign
 * d7131dc).
 *
 * Pure, UI-framework-free projections for the Agent Settings
 * "Meta capabilities" subsection: the seven authority ids
 * with their display metadata (one-line descriptions plus the high-impact
 * `warning` copy), the per-agent grant/scope projection read from
 * the store's host-only `listAuthorityGrantDetails()` surface, the operator
 * draft normalizer that mirrors the runtime `validateAuthorityScope`
 * vocabulary, the one-line scope summary that drives the row chip and the
 * "Authority scopes" dialog rail, and the generic realm-exact grant/revoke
 * seam the panel calls through ({@link applyAuthorityGrantToggle}).
 *
 * `META_AUTHORITY_TOGGLES` and `applyMetaAuthorityToggle`
 * (`realmReviewHelpers.ts`) stay the source-compatible publishing-pair
 * surface; this module is additive. The publishing pair remains unscoped-only:
 * a draft carrying any scope key for `@template:authority` /
 * `@hydration:authority` rejects exactly like the runtime validator rejects
 * class-invalid keys.
 *
 * Operator/host-only surface: every authority id, scope value, and canonical
 * identity key handled here is registry-side operator state — none of it is
 * ever rendered to an agent, embedded in a receipt, or placed on a
 * model-facing schema.
 */

import { AGENT_AUTHORITIES, AUTHORITY_SCOPE_FIELDS } from '../../sandbox/realmCatalog/index.ts';
import type { AuthorityScopeRecord } from '../../sandbox/realmCatalog/index.ts';

/**
 * Display class of one authority id in the operator editor: the publishing
 * pair, the agent-scoped meta ids, the realm-scoped meta ids, and the
 * realm-wide extension-attachment id.
 */
export type AuthorityEditorClass = 'publishing' | 'agent' | 'realm' | 'extensions';

/**
 * One operator authority-editor row definition.
 */
export interface AuthorityEditorToggleDefinition {
  /** Exact `AUTHORITY_IDS` member. */
  readonly authority: string;
  /** Short display label. */
  readonly label: string;
  /** One-line, state-accurate description. */
  readonly description: string;
  /** Display class (also the scope-key class the normalizer enforces). */
  readonly class: AuthorityEditorClass;
  /** Whether the id accepts a registry-side scope (the publishing pair does not). */
  readonly scoped: boolean;
  /**
   * One-line high-impact warning for the dangerous ids (tooltip/aria name and
   * dialog detail line); absent for ids that need no extra affordance.
   */
  readonly warning?: string;
}

/**
 * The seven operator authority rows, in `AUTHORITY_IDS` declaration order. The
 * publishing pair carries the exact `META_AUTHORITY_TOGGLES` copy (hydration
 * shortened with the approved redesign; the template line is unchanged); the
 * five meta-plane ids state their reach in one line, and the three dangerous
 * ids additionally carry `warning` copy for the amber affordance and the
 * dialog detail.
 */
export const AUTHORITY_EDITOR_TOGGLES: readonly AuthorityEditorToggleDefinition[] = Object.freeze([
  Object.freeze({
    authority: AGENT_AUTHORITIES.TEMPLATE,
    label: 'Template publishing',
    description: 'Import realm template bundles into the host catalog.',
    class: 'publishing',
    scoped: false
  }),
  Object.freeze({
    authority: AGENT_AUTHORITIES.HYDRATION,
    label: 'Hydration publishing',
    description: 'Submit instance payloads for host review.',
    class: 'publishing',
    scoped: false
  }),
  Object.freeze({
    authority: AGENT_AUTHORITIES.AGENT_INSPECT,
    label: 'Agent inspection',
    description: 'Read other agents’ role, tools, and prompt.',
    class: 'agent',
    scoped: true
  }),
  Object.freeze({
    authority: AGENT_AUTHORITIES.AGENT_EDIT,
    label: 'Agent editing',
    description: 'Change other agents’ tools, policy, or prompt.',
    class: 'agent',
    scoped: true,
    warning: 'High impact — edits other agents’ tools and prompt.'
  }),
  Object.freeze({
    authority: AGENT_AUTHORITIES.REALM_INSPECT,
    label: 'Realm inspection',
    description: 'Read realm settings, attachments, and tool ceiling.',
    class: 'realm',
    scoped: true
  }),
  Object.freeze({
    authority: AGENT_AUTHORITIES.REALM_EDIT,
    label: 'Realm editing',
    description: 'Change realm settings, attachments, and tool ceiling.',
    class: 'realm',
    scoped: true,
    warning: 'High impact — changes the tools every member can reach.'
  }),
  Object.freeze({
    authority: AGENT_AUTHORITIES.EXTENSIONS,
    label: 'Extension attachment',
    description: 'Attach extensions realm-wide for every member.',
    class: 'extensions',
    scoped: true,
    warning: 'High impact — target realm members gain these tools.'
  })
]);

/**
 * One grant/scope detail entry as projected by
 * `sandboxStore.listAuthorityGrantDetails()`: the canonical `(realmId,
 * agentId)` identity key plus the registry-side scope (`null` = the id's
 * default scope).
 */
export interface AuthorityGrantDetailEntry {
  /** Canonical identity key of the granted registration (operator-internal). */
  readonly ref: string;
  /** Registry-side narrowing, or `null` for the id's default scope. */
  readonly scope: AuthorityScopeRecord | null;
}

/**
 * The store projection shape this module reads: per authority id, the frozen
 * detail entries. The legacy bare-string form is accepted structurally too
 * (malformed listings read as ungranted).
 */
export type AuthorityGrantDetailListing = Readonly<
  Record<string, readonly (AuthorityGrantDetailEntry | string)[]>
>;

/**
 * Per-id editor state: whether the selected agent holds the id and the live
 * registry-side scope (`null` = default).
 */
export interface AuthorityEditorEntryState {
  /** Whether the selected agent holds the exact id. */
  readonly enabled: boolean;
  /** The held scope, or `null` for the id's default. */
  readonly scope: AuthorityScopeRecord | null;
}

/**
 * Proto keys that may never bound a scope list entry (mirrors the runtime
 * `AUTHORITY_SCOPE_FORBIDDEN_NAMES` validator vocabulary).
 */
const AUTHORITY_SCOPE_FORBIDDEN_ENTRIES: ReadonlySet<string> = new Set<string>([
  '__proto__',
  'constructor',
  'prototype'
]);

/**
 * Projects the operator grant/scope listing onto one agent's canonical
 * identity key, for every editor id (ungranted ids included).
 *
 * Malformed listings read as ungranted: a missing/non-array per-id value, a
 * non-string unresolved agent key, or an entry without a matching `ref` never
 * produces a fabricated grant. A malformed scope on a matching entry reads as
 * the id's default (`null`) instead of a narrowing that was never stored.
 *
 * @param details - `listAuthorityGrantDetails()` result (or the legacy string form).
 * @param agentKey - Target agent's canonical identity key (`createAgentIdentityKey(realmId, id)`).
 * @returns Frozen per-id `{ enabled, scope }` state.
 */
export function buildAuthorityEditorState(
  details: AuthorityGrantDetailListing | null | undefined,
  agentKey: unknown
): Readonly<Record<string, AuthorityEditorEntryState>> {
  const key = typeof agentKey === 'string' ? agentKey : '';
  const listing = details && typeof details === 'object' && !Array.isArray(details) ? details : null;
  const state: Record<string, AuthorityEditorEntryState> = {};
  for (const toggle of AUTHORITY_EDITOR_TOGGLES) {
    let enabled = false;
    let scope: AuthorityScopeRecord | null = null;
    const entries = listing ? listing[toggle.authority] : undefined;
    if (key.length > 0 && Array.isArray(entries)) {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const ref =
          typeof entry === 'string'
            ? entry
            : entry && typeof entry === 'object'
              ? entry.ref
              : '';
        if (ref !== key) continue;
        enabled = true;
        const candidate = typeof entry === 'object' && entry !== null ? entry.scope : null;
        scope = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
        break;
      }
    }
    state[toggle.authority] = Object.freeze({ enabled, scope });
  }
  return Object.freeze(state);
}

/**
 * One operator scope draft as the panel holds it: `targets`/`realms`/`fields`
 * accept a parsed list or the raw comma/newline-separated input, and the
 * boolean selectors are the checkbox states.
 */
export interface AuthorityScopeDraft {
  /** Target ids: bare agent ids for `@agent:*`, realm ids for realm-class ids. */
  readonly targets?: string | readonly string[] | null;
  /** `@agent:*` realm bound (absent = the holder's own realm). */
  readonly realms?: string | readonly string[] | null;
  /** `@agent:*` selector: direct spawns (default checked). */
  readonly ownSpawns?: boolean | null;
  /** `@agent:*` selector: members of the `realms` bound (default unchecked). */
  readonly realmMembers?: boolean | null;
  /** Field tokens, restricted to the id's `AUTHORITY_SCOPE_FIELDS` vocabulary. */
  readonly fields?: string | readonly string[] | null;
}

/** Successful/failed scope normalization result. */
export interface AuthorityScopeDraftResult {
  /** The validated, frozen scope, or `null` for the id's default scope. */
  readonly scope: AuthorityScopeRecord | null;
  /** Operator-readable inline error; empty on success. */
  readonly error: string;
  /**
   * Additive optional hint naming the draft control the error maps to
   * (`targets` / `realms` / `fields`); absent when the failure maps to no
   * rendered control. Never set on success.
   */
  readonly field?: 'targets' | 'realms' | 'fields';
}

/**
 * Normalizes one operator scope draft for an authority id, mirroring the
 * runtime `validateAuthorityScope` class vocabulary:
 *
 * - only class-allowed keys survive (`@agent:*`: `targets`/`realms`/`ownSpawns`/
 *   `realmMembers`; `@realm:*`/`@extensions:authority`: `targets`; `fields` only
 *   for ids with a declared `AUTHORITY_SCOPE_FIELDS` vocabulary); a present
 *   class-invalid key rejects fail-closed instead of being silently dropped;
 * - list entries are trimmed and deduped (first-seen order), prototype
 *   vocabulary rejects, and an empty/blank list input means the key is absent —
 *   never the explicit-empty deny (which only a stored empty array expresses);
 * - `ownSpawns: true` is kept explicit only when another selector is present
 *   (alone, or alongside no other selector, it is the id's default and the
 *   record collapses), while `ownSpawns: false` is an explicit selector;
 * - `fields` is omitted when every declared token is selected; an empty
 *   selection stays as the explicit fail-closed deny `fields: []`;
 * - a draft equal to the id's default scope normalizes to `null`, keeping the
 *   legacy keys-only persistence.
 *
 * @param draft - Operator draft (checkbox states plus list inputs).
 * @param authorityId - Exact `AUTHORITY_IDS` member the draft narrows.
 * @returns `{ scope | null, error }`; `error` is operator-readable and non-empty when invalid.
 */
export function normalizeAuthorityScopeDraft(
  draft: AuthorityScopeDraft | null | undefined,
  authorityId: unknown
): AuthorityScopeDraftResult {
  /** Builds a failure result, carrying the control hint only when one maps. */
  const fail = (error: string, field?: 'targets' | 'realms' | 'fields'): AuthorityScopeDraftResult =>
    field ? { scope: null, error, field } : { scope: null, error };
  const id = typeof authorityId === 'string' ? authorityId : '';
  const definition = AUTHORITY_EDITOR_TOGGLES.find((toggle) => toggle.authority === id);
  if (!definition) return fail(`Unknown authority id "${id}".`);
  if (draft === null || draft === undefined) draft = {};
  if (typeof draft !== 'object' || Array.isArray(draft)) {
    return fail('The authority scope draft must be a plain object.');
  }
  const record = draft as Record<string, unknown>;
  const vocabulary = AUTHORITY_SCOPE_FIELDS[id] ?? [];
  const agentClass = definition.class === 'agent';
  const realmClass = definition.class === 'realm' || definition.class === 'extensions';
  const allowed = new Set<string>();
  if (agentClass) {
    allowed.add('targets');
    allowed.add('realms');
    allowed.add('ownSpawns');
    allowed.add('realmMembers');
  } else if (realmClass) {
    allowed.add('targets');
  }
  if (vocabulary.length > 0) allowed.add('fields');
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (!allowed.has(key)) {
      const hint = key === 'targets' || key === 'realms' || key === 'fields' ? key : undefined;
      return fail(`The "${key}" scope key is not available for ${id}.`, hint);
    }
  }

  const readList = (
    key: 'targets' | 'realms'
  ): { entries: readonly string[]; error: string; field?: 'targets' | 'realms' } => {
    const value = record[key];
    if (value === undefined || value === null) return { entries: Object.freeze([]), error: '' };
    let raw: readonly unknown[];
    if (typeof value === 'string') raw = value.split(/[\n,]+/);
    else if (Array.isArray(value)) raw = value;
    else return { entries: Object.freeze([]), error: `The "${key}" bound must be a list of ids.`, field: key };
    const entries: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (typeof item !== 'string') {
        return { entries: Object.freeze([]), error: `Every "${key}" entry must be a string id.`, field: key };
      }
      const entry = item.trim();
      if (entry.length === 0) continue;
      if (AUTHORITY_SCOPE_FORBIDDEN_ENTRIES.has(entry)) {
        return {
          entries: Object.freeze([]),
          error: `The "${key}" entry "${entry}" is reserved prototype vocabulary.`,
          field: key
        };
      }
      if (!entries.includes(entry)) entries[entries.length] = entry;
    }
    return { entries: Object.freeze(entries), error: '' };
  };
  const readFlag = (key: string): { value: boolean | undefined; error: string } => {
    const value = record[key];
    if (value === undefined || value === null) return { value: undefined, error: '' };
    if (typeof value !== 'boolean') return { value: undefined, error: `The "${key}" selection must be a boolean.` };
    return { value, error: '' };
  };

  const scope: {
    targets?: readonly string[];
    ownSpawns?: boolean;
    realmMembers?: boolean;
    realms?: readonly string[];
    fields?: readonly string[];
  } = {};

  if (agentClass || realmClass) {
    const targets = readList('targets');
    if (targets.error) return fail(targets.error, targets.field);
    if (targets.entries.length > 0) scope.targets = targets.entries;
  }
  if (agentClass) {
    const realms = readList('realms');
    if (realms.error) return fail(realms.error, realms.field);
    if (realms.entries.length > 0) scope.realms = realms.entries;
    const ownSpawns = readFlag('ownSpawns');
    if (ownSpawns.error) return fail(ownSpawns.error);
    const realmMembers = readFlag('realmMembers');
    if (realmMembers.error) return fail(realmMembers.error);
    const selectorPresent =
      scope.targets !== undefined || scope.realms !== undefined || realmMembers.value === true;
    if (ownSpawns.value === true) {
      if (selectorPresent) scope.ownSpawns = true;
    } else if (ownSpawns.value === false) {
      scope.ownSpawns = false;
    }
    if (realmMembers.value === true) scope.realmMembers = true;
  }
  if (vocabulary.length > 0) {
    const value = record.fields;
    if (value !== undefined && value !== null) {
      let raw: readonly unknown[];
      if (typeof value === 'string') raw = value.split(/[\n,]+/);
      else if (Array.isArray(value)) raw = value;
      else return fail('The "fields" selection must be a list of field tokens.', 'fields');
      const selected: string[] = [];
      for (let i = 0; i < raw.length; i++) {
        const item = raw[i];
        if (typeof item !== 'string') {
          return fail('Every "fields" entry must be a field token.', 'fields');
        }
        const token = item.trim();
        if (token.length === 0) continue;
        if (!vocabulary.includes(token)) {
          return fail(`"${token}" is not a field token for ${id}.`, 'fields');
        }
        if (!selected.includes(token)) selected[selected.length] = token;
      }
      if (selected.length < vocabulary.length) {
        scope.fields = Object.freeze(vocabulary.filter((token) => selected.includes(token)));
      }
    }
  }
  if (Object.keys(scope).length === 0) return { scope: null, error: '' };
  return { scope: Object.freeze(scope) as AuthorityScopeRecord, error: '' };
}

/**
 * One-line scope summary for the operator list chip and the "Authority scopes"
 * dialog rail, in the approved deterministic grammar: reach (`N agent
 * targets` / `N realm targets` / `own spawns` / `no spawns` / `own realm` /
 * `realm members`) · realm bound (`N bound realms`) · fields (`fields: a, b`,
 * or `field edits denied` when the held scope carries the explicit fail-closed
 * deny `fields: []`).
 *
 * The publishing pair is unscoped and returns `''` (no chip), as do unknown or
 * malformed definitions. A `null`/malformed scope is the id's default
 * (`own spawns` for `@agent:*`, `own realm` for the realm class). An explicit
 * empty list stays visible as `0 agent targets` / `0 realm targets` — the
 * fail-closed deny is never rendered as the default reach. Field tokens render
 * in declared vocabulary order, so the summary is deterministic.
 *
 * @param definition - Editor row definition (the id resolves through the canonical table).
 * @param scope - Held registry-side scope (`null` = the id's default scope).
 * @returns Chip/rail summary string; `''` when the id has no scope summary.
 */
export function describeAuthorityScopeSummary(
  definition: AuthorityEditorToggleDefinition | null | undefined,
  scope: AuthorityScopeRecord | null | undefined
): string {
  if (!definition || typeof definition !== 'object') return '';
  const canonical = AUTHORITY_EDITOR_TOGGLES.find((toggle) => toggle.authority === definition.authority);
  if (!canonical || canonical.scoped !== true) return '';
  const record = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : null;
  const agentClass = canonical.class === 'agent';
  const fallback = agentClass ? 'own spawns' : 'own realm';
  if (!record) return fallback;

  const parts: string[] = [];
  const targets = Array.isArray(record.targets) ? record.targets : null;
  if (agentClass) {
    if (targets !== null) parts.push(`${targets.length} agent targets`);
    const realmMembers = record.realmMembers === true;
    const otherSelector = targets !== null || realmMembers;
    if (record.ownSpawns === false) {
      if (!otherSelector) parts.push('no spawns');
    } else if (record.ownSpawns === true || !otherSelector) {
      parts.push('own spawns');
    }
    if (realmMembers) parts.push('realm members');
  } else if (targets !== null) {
    parts.push(`${targets.length} realm targets`);
  } else {
    parts.push('own realm');
  }
  if (Array.isArray(record.realms)) parts.push(`${record.realms.length} bound realms`);

  const vocabulary = AUTHORITY_SCOPE_FIELDS[canonical.authority] ?? [];
  if (vocabulary.length > 0 && Array.isArray(record.fields)) {
    const ordered: string[] = [];
    for (const token of vocabulary) {
      if (record.fields.includes(token)) ordered.push(token);
    }
    for (const token of record.fields) {
      if (typeof token === 'string' && !ordered.includes(token)) ordered.push(token);
    }
    parts.push(ordered.length === 0 ? 'field edits denied' : `fields: ${ordered.join(', ')}`);
  }
  if (parts.length === 0) return fallback;
  return parts.join(' · ');
}

/**
 * Narrow structural host the generic grant/revoke calls go through: the real
 * `sandboxStore` satisfies it (the dedicated publishing wrappers stay
 * untouched), and tests exercise it with a real store instance.
 */
export interface AuthorityGrantEditorHost {
  /** Grant one exact authority id to one active agent. */
  grantAuthority(
    agentId: string,
    authorityId: string,
    scope?: AuthorityScopeRecord | null,
    identityScope?: { readonly realmId?: string | null }
  ): Promise<unknown>;
  /** Revoke one exact authority id from one active agent. */
  revokeAuthority(
    agentId: string,
    authorityId: string,
    identityScope?: { readonly realmId?: string | null }
  ): Promise<unknown>;
}

/**
 * One generic authority toggle activation.
 */
export interface AuthorityGrantToggleRequest {
  /** Active agent id (bare, realm-local). */
  readonly agentId: string;
  /** Exact `AUTHORITY_IDS` member. */
  readonly authority: string;
  /** Whether the id should end granted. */
  readonly enabled: boolean;
  /** Normalized registry-side scope for a grant (`null` = the id's default). */
  readonly scope?: AuthorityScopeRecord | null;
  /** Trusted realm scope for exact `(realmId, agentId)` resolution (`null` = system scope). */
  readonly realmId?: string | null;
}

/**
 * Applies one generic authority toggle through the injected host: enable
 * grants the id (`enabled ? scope : null`; a re-grant replaces the record for
 * that id), disable revokes it. The call is realm-exact when `realmId` is
 * supplied (including `null` for the director's system scope), so a
 * same-literal-id agent in another Realm is never retargeted. Failures come
 * back inline; the caller re-reads the live listing and re-renders.
 *
 * @param host - Grant host (the real `sandboxStore` satisfies it).
 * @param request - Toggle activation.
 * @returns `{ ok, error }`; `ok` means the call completed, not that the toggle reads enabled.
 */
export async function applyAuthorityGrantToggle(
  host: AuthorityGrantEditorHost | null | undefined,
  request: AuthorityGrantToggleRequest
): Promise<{ readonly ok: boolean; readonly error: string }> {
  const agentId = typeof request?.agentId === 'string' ? request.agentId.trim() : '';
  const authority = typeof request?.authority === 'string' ? request.authority : '';
  if (!host || !agentId || authority.length === 0) {
    return { ok: false, error: 'The authority change needs an active agent and a known authority id.' };
  }
  const identityScope = { realmId: request.realmId ?? null };
  try {
    const descriptor = request.enabled
      ? await host.grantAuthority(agentId, authority, request.scope ?? null, identityScope)
      : await host.revokeAuthority(agentId, authority, identityScope);
    if (descriptor === null || descriptor === undefined) {
      return {
        ok: false,
        error: `No active agent matched "${agentId}" in the selected realm — it may have been killed or recycled.`
      };
    }
    return { ok: true, error: '' };
  } catch (error) {
    return { ok: false, error: readableMessage(error) || 'The authority change was rejected.' };
  }
}

/**
 * Reads the human-readable message from an unknown thrown value.
 *
 * @param error - Thrown value.
 * @returns Trimmed message, or an empty string.
 */
function readableMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return '';
}
