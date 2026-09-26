/**
 * Realm manager (`RealmSettingsModal.svelte`) master–detail projections
 * (realm manager redesign, ticket ca33e1b).
 *
 * Pure, UI-framework-free projections behind the scalable Realm Manager: the
 * fixed-height realm list (member counts under the engine's trim semantics —
 * defect 7368e98), the search filter, the selection fallback, the attach
 * editor's tool-selection resolver, the read-only workspace-partition
 * visibility of one Realm, and the operator error copy.
 *
 * Every function is a pure projection of its arguments: no store access, no
 * DOM. The modal and its subcomponents stay thin rendering layers, and the
 * list/detail models are unit-testable against real store snapshots.
 */

import type { RealmRecord } from '../../sandbox/realmRegistry/index.ts';
import { safeRealmColor, selectRealmMembers } from './realmGroups.ts';
import { buildRealmProvenanceView } from './realmTemplateHelpers.ts';

/**
 * Minimal structural shape the manager list needs from an agent snapshot: a
 * stable id, a display name, and the optional Realm membership. Keeps the
 * helper decoupled from the full store snapshot contract while staying
 * satisfied by it.
 */
export interface RealmManagerAgent {
  /** Stable agent identifier. */
  readonly id: string;
  /** Display name; falls back to the id in member rows. */
  readonly name?: string;
  /** Agent config carrying the optional `realmId` membership. */
  readonly config?: { readonly realmId?: string | null } | null;
}

/**
 * One Realm row of the manager's master list: identity plus the live member
 * counts (the trim-consistent engine semantics), the presentation-safe accent
 * color, and the recorded missing-extension count.
 */
export interface RealmManagerEntry {
  /** Realm id (the selection key). */
  readonly id: string;
  /** Display name; falls back to the id when blank. */
  readonly name: string;
  /** Operator description (`''` when absent). */
  readonly description: string;
  /** Presentation-safe accent color, or `null`. */
  readonly color: string | null;
  /** Active members whose (trimmed) membership names this Realm. */
  readonly activeMembers: number;
  /** Recycled members whose (trimmed) membership names this Realm. */
  readonly recycledMembers: number;
  /** `activeMembers + recycledMembers`. */
  readonly memberCount: number;
  /** Recorded missing requested extensions (provenance badge count). */
  readonly missingExtensionCount: number;
}

/**
 * Builds the manager's master-list entries for every registered Realm, in
 * registry order (Generic first).
 *
 * Member counts go through {@link selectRealmMembers}, so a hydrated padded
 * membership (`' realm_x '`) counts for `realm_x` exactly like the deletion
 * engine (`resolveMemberRealmId`) and the sidebar grouping — the deletion
 * dialog and the list can never disagree (defect 7368e98). The missing-
 * extension badge reads the validated provenance block, so a Realm without
 * recorded launch provenance never shows one.
 *
 * @param realms - Realm records in registry order.
 * @param agents - Active agent snapshots.
 * @param recycled - Recycled agent snapshots.
 * @returns One entry per valid Realm; malformed records are skipped.
 *
 * @example
 * ```typescript
 * const entries = buildRealmManagerEntries(sandboxStore.realms, sandboxStore.agents, sandboxStore.recycleBin);
 * entries.find((entry) => entry.id === sandboxStore.realms[0].id)?.memberCount;
 * ```
 */
export function buildRealmManagerEntries(
  realms: readonly RealmRecord[] | null | undefined,
  agents: readonly RealmManagerAgent[] | null | undefined,
  recycled: readonly RealmManagerAgent[] | null | undefined
): RealmManagerEntry[] {
  const realmList = Array.isArray(realms) ? realms : [];
  const activeList = Array.isArray(agents) ? agents : [];
  const recycledList = Array.isArray(recycled) ? recycled : [];

  const entries: RealmManagerEntry[] = [];
  for (const realm of realmList) {
    if (!realm || typeof realm !== 'object' || typeof realm.id !== 'string' || realm.id.trim().length === 0) {
      continue;
    }
    const activeMembers = selectRealmMembers(activeList, realm.id).length;
    const recycledMembers = selectRealmMembers(recycledList, realm.id).length;
    const provenance = buildRealmProvenanceView(realm);
    entries.push({
      id: realm.id,
      name: typeof realm.name === 'string' && realm.name.trim().length > 0 ? realm.name : realm.id,
      description: typeof realm.description === 'string' ? realm.description : '',
      color: safeRealmColor(realm.color),
      activeMembers,
      recycledMembers,
      memberCount: activeMembers + recycledMembers,
      missingExtensionCount: provenance.missingExtensions.length
    });
  }
  return entries;
}

/**
 * Filters the master-list entries by a free-text query over name, id, and
 * description, preserving registry order.
 *
 * The query is trimmed and compared case-insensitively as a substring; an
 * empty/blank/non-string query returns every entry. Search never reorders the
 * list, so the operator's registry order stays the stable navigation order.
 *
 * @param entries - Entries in registry order.
 * @param query - Free-text search query.
 * @returns Matching entries in registry order.
 *
 * @example
 * ```typescript
 * filterRealmManagerEntries(entries, 'story').map((entry) => entry.name);
 * ```
 */
export function filterRealmManagerEntries(
  entries: readonly RealmManagerEntry[] | null | undefined,
  query: unknown
): RealmManagerEntry[] {
  const list = Array.isArray(entries) ? entries : [];
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!needle) return [...list];
  return list.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const name = typeof entry.name === 'string' ? entry.name.toLowerCase() : '';
    const id = typeof entry.id === 'string' ? entry.id.toLowerCase() : '';
    const description = typeof entry.description === 'string' ? entry.description.toLowerCase() : '';
    return name.includes(needle) || id.includes(needle) || description.includes(needle);
  });
}

/**
 * Resolves the selected Realm id with the manager's fallback chain: an
 * explicit operator choice wins, then the optional launch-target prop, then
 * the first registered record. A stale/deleted id falls through instead of
 * leaving the detail pane empty.
 *
 * @param realms - Realm records in registry order.
 * @param requestedId - Explicit operator selection (any shape; non-strings ignored).
 * @param initialId - Optional launch-target prop.
 * @returns The resolved Realm id, or `''` when no Realm exists.
 *
 * @example
 * ```typescript
 * resolveRealmManagerSelection(sandboxStore.realms, '', null);
 * // sandboxStore.realms[0]?.id ?? ''
 * ```
 */
export function resolveRealmManagerSelection(
  realms: readonly { readonly id: string }[] | null | undefined,
  requestedId: unknown,
  initialId: unknown
): string {
  const list = Array.isArray(realms) ? realms : [];
  const has = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && candidate.length > 0 && list.some((realm) => realm && realm.id === candidate);
  if (has(requestedId)) return requestedId;
  if (has(initialId)) return initialId;
  return list.length > 0 && list[0] && typeof list[0].id === 'string' ? list[0].id : '';
}

/**
 * Resolved realm-level tool selection for one attach action: the literal
 * `'all'` marker, or the explicit ordered call-name list.
 */
export type RealmAttachToolSelection = 'all' | readonly string[];

/**
 * Outcome of the attach-editor resolver.
 */
export type RealmAttachToolSelectionResult =
  | { readonly ok: true; readonly toolSelection: RealmAttachToolSelection }
  | { readonly ok: false; readonly error: string };

/**
 * Resolves the attach editor's realm-level ceiling selection, mirroring the
 * editor's visible state:
 * - with a live conflict-free catalog: every checked name means `'all'`, a
 *   strict subset means exactly those names in catalog order, and checking
 *   none is refused;
 * - without a live catalog: the `'custom'` mode parses the comma-separated
 *   sanitized call names (blank entries dropped; an empty list is refused),
 *   the `'all'` mode records `'all'`.
 *
 * @param options - Editor state (catalog names, checked names, fallback mode, custom text).
 * @returns The resolved selection, or the operator-facing refusal.
 *
 * @example
 * ```typescript
 * resolveRealmAttachToolSelection({ catalogNames: ['a', 'b'], checkedNames: ['b'] });
 * // { ok: true, toolSelection: ['b'] }
 * ```
 */
export function resolveRealmAttachToolSelection(
  options: {
    readonly catalogNames?: readonly string[] | null;
    readonly checkedNames?: readonly string[] | null;
    readonly mode?: unknown;
    readonly customText?: unknown;
  } = {}
): RealmAttachToolSelectionResult {
  const catalogNames = (Array.isArray(options.catalogNames) ? options.catalogNames : [])
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
  const checkedNames = (Array.isArray(options.checkedNames) ? options.checkedNames : [])
    .filter((name): name is string => typeof name === 'string');

  if (catalogNames.length > 0) {
    if (checkedNames.length === 0) {
      return { ok: false, error: 'Select at least one live catalog tool, or keep every tool selected.' };
    }
    if (checkedNames.length < catalogNames.length) {
      const checked = new Set(checkedNames);
      return { ok: true, toolSelection: catalogNames.filter((name) => checked.has(name)) };
    }
    return { ok: true, toolSelection: 'all' };
  }

  if (options.mode === 'custom') {
    const custom = typeof options.customText === 'string' ? options.customText : '';
    const names = custom
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (names.length === 0) {
      return { ok: false, error: 'List at least one sanitized call name, or use the "all tools" selection.' };
    }
    return { ok: true, toolSelection: names };
  }

  return { ok: true, toolSelection: 'all' };
}

/**
 * Minimal structural shape of one operator VirtualFS partition the manager's
 * read-only workspace card reads (satisfied by the store's
 * `FsWorkspacePartition`, kept structural so the helper stays store-free).
 */
export interface RealmManagerFsPartition {
  /** Internal VirtualFS snapshot key. */
  readonly key: string;
  /** Operator display label. */
  readonly label: string;
  /** Realm membership, or `null` for shared/literal partitions. */
  readonly realmId: string | null;
  /** Partition kind. */
  readonly kind: 'global' | 'realm-global' | 'agent' | 'workspace';
  /** File count of the resolved partition. */
  readonly fileCount: number;
}

/**
 * One rendered workspace-partition row of the Realm detail pane.
 */
export interface RealmManagerFsPartitionView {
  /** Internal VirtualFS snapshot key (display metadata only here). */
  readonly key: string;
  /** Operator display label. */
  readonly label: string;
  /** Partition kind. */
  readonly kind: RealmManagerFsPartition['kind'];
  /** Plain-language kind label. */
  readonly kindLabel: string;
  /** File count of the resolved partition. */
  readonly fileCount: number;
}

/**
 * Plain-language labels of the partition kinds shown in the Realm detail.
 */
export const REALM_FS_PARTITION_KIND_LABELS: Readonly<Record<RealmManagerFsPartition['kind'], string>> = Object.freeze({
  global: 'Shared',
  'realm-global': 'Realm workspace',
  agent: 'Member workspace',
  workspace: 'Workspace'
});

/**
 * Presentation rank of one partition kind inside the Realm detail: the
 * realm-global workspace first, then member workspaces, then anything else.
 */
const REALM_FS_PARTITION_KIND_RANK: Readonly<Record<RealmManagerFsPartition['kind'], number>> = Object.freeze({
  global: 0,
  'realm-global': 1,
  agent: 2,
  workspace: 3
});

/**
 * Selects the workspace partitions of one Realm for the read-only visibility
 * card: realm-global first, then member workspaces, then by label, with the
 * resolved file count carried through (never recomputed from a label).
 *
 * @param partitions - Operator partitions (`sandboxStore.fsWorkspacePartitions`).
 * @param realmId - Target Realm id (trimmed before comparison).
 * @returns Partition views; an unknown/blank Realm id yields `[]`.
 *
 * @example
 * ```typescript
 * selectRealmFsPartitionViews(sandboxStore.fsWorkspacePartitions, realm.id);
 * ```
 */
export function selectRealmFsPartitionViews(
  partitions: readonly RealmManagerFsPartition[] | null | undefined,
  realmId: unknown
): RealmManagerFsPartitionView[] {
  const list = Array.isArray(partitions) ? partitions : [];
  const target = typeof realmId === 'string' ? realmId.trim() : '';
  if (!target) return [];
  return list
    .filter((partition) => Boolean(partition)
      && typeof partition.key === 'string'
      && partition.key.length > 0
      && partition.realmId === target
      && typeof partition.kind === 'string')
    .map((partition) => ({
      key: partition.key,
      label: typeof partition.label === 'string' && partition.label.trim().length > 0 ? partition.label : target,
      kind: partition.kind,
      kindLabel: REALM_FS_PARTITION_KIND_LABELS[partition.kind] ?? 'Workspace',
      fileCount: Math.max(0, Number(partition.fileCount) || 0)
    }))
    .sort((a, b) => {
      const rankDelta = (REALM_FS_PARTITION_KIND_RANK[a.kind] ?? 9) - (REALM_FS_PARTITION_KIND_RANK[b.kind] ?? 9);
      if (rankDelta !== 0) return rankDelta;
      return a.label.localeCompare(b.label);
    });
}

/**
 * Resolves a thrown store error into the manager's user-facing message: a
 * permission refusal names the required operator (Director) principal, every
 * other failure preserves its message and falls back to the caller's copy.
 *
 * @param error - Thrown value.
 * @param fallback - Message used when the thrown value carries no text.
 * @returns User-facing message.
 *
 * @example
 * ```typescript
 * describeRealmManagerError(new Error('PERMISSION_DENIED'), 'Failed.');
 * ```
 */
export function describeRealmManagerError(error: unknown, fallback: string): string {
  const message = error instanceof Error && typeof error.message === 'string' ? error.message : '';
  if (!message) return fallback;
  if (message.includes('PERMISSION_DENIED') || /permission denied/i.test(message)) {
    return 'The operator (Director) principal is required for that Realm action. Reload with the Director registered and retry.';
  }
  return message;
}
