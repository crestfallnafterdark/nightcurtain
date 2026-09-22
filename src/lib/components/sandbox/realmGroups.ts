/**
 * Realm sidebar grouping and deletion-dialog helpers (Wave A, ticket d13a038;
 * Wave R, ticket 56ba4b9).
 *
 * Pure, UI-framework-free projections shared by `SandboxView.svelte` (drawer
 * grouping) and the Realm manager modal: agents are grouped by their
 * `config.realmId` against the registry records, with a stable ordering
 * (registry order; the store seeds the Generic default first) and input order
 * preserved inside every group.
 *
 * Wave R realm model (locked 2026-09-20; I2 scope-awareness, ticket 93243cc):
 * - the system-scope director is never a group member — it is identified by the
 *   hardcoded `DIRECTOR_AGENT_ID` with no Realm membership and rendered by the
 *   drawer as a pinned separate entity; agent ids are ordinary realm-local
 *   labels, so a realm-local agent legally named `director` renders under its
 *   own Realm instead;
 * - every non-director agent has a realm: an absent/blank membership falls back
 *   to the seeded Generic realm, and an unregistered membership renders under
 *   its raw realm id instead of being dropped;
 * - there is no "Ungrouped" section: realms are boundaries, not just groups.
 *
 * `describeRealmDeletion` is the pure copy model of the manager's deletion
 * dialog: it pins the default refusal ("terminate or delete members first"),
 * the Generic protection, and the explicit recursive override copy.
 *
 * `safeRealmColor` is the presentation guard for operator-supplied accent
 * colors: only 3/6-digit hex colors pass, everything else falls back to the
 * caller's default instead of reaching a CSS declaration.
 */

import { DIRECTOR_AGENT_ID } from '../../sandbox/domain/directorAgent/index.ts';
import type { RealmRecord } from '../../sandbox/realmRegistry/index.ts';

/**
 * Stable group key of the pinned director entity. The director is a scope of
 * its own (the reserved system scope), never a Realm group.
 */
export const DIRECTOR_GROUP_KEY = '__director__';

/**
 * Display label of the pinned director entity.
 */
export const DIRECTOR_GROUP_LABEL = 'Director';

/**
 * Fixed id of the seeded default Realm ("Generic"), mirrored from the store's
 * exported constant (`GENERIC_REALM_ID` in `sandboxStore/index.svelte.ts`).
 * The UI helper stays store-free, so the literal is duplicated here and pinned
 * equal by `sandbox_store_module_test` (the `OPERATOR_SUBJECT` precedent).
 */
export const GENERIC_REALM_ID = 'realm_generic';

/**
 * Minimal structural shape the grouping needs from an agent snapshot: a stable
 * id plus optional Realm membership. Keeps the helper decoupled from the full
 * `AgentStateSnapshot` contract while staying satisfied by it.
 */
export interface RealmGroupableAgent {
  /** Stable agent identifier. */
  readonly id: string;
  /** Agent config carrying the optional `realmId` membership. */
  readonly config?: { readonly realmId?: string | null } | null;
}

/**
 * One rendered drawer group: a registered Realm (with its record), a synthetic
 * group for an unregistered membership or the Generic fallback (`realm: null`
 * — no registry record exists for it). `agents` preserves the input order.
 */
export interface RealmAgentGroup<T extends RealmGroupableAgent = RealmGroupableAgent> {
  /** Stable group key: the Realm id (registry or synthetic). */
  readonly key: string;
  /** Registry Realm record, or `null` for a synthetic group. */
  readonly realm: RealmRecord | null;
  /** Display label (Realm name, or the synthetic key). */
  readonly label: string;
  /** Members in incoming order. */
  readonly agents: T[];
}

/**
 * Tests whether an agent snapshot is the pinned system-scope director.
 *
 * I2 (ticket 93243cc): agent ids are ordinary realm-local labels, so a bare id
 * named `director` proves nothing. Only the system-scope director —
 * `DIRECTOR_AGENT_ID` with no Realm membership (`resolveAgentRealmId` returns
 * `null`) — is the pinned entity; a realm-local `director` is an ordinary
 * member and renders under its Realm.
 *
 * @param agent - Agent snapshot or structural equivalent.
 * @returns True when the agent is the system-scope director identity.
 */
export function isDirectorAgent(agent: RealmGroupableAgent | null | undefined): boolean {
  return Boolean(agent && agent.id === DIRECTOR_AGENT_ID && resolveAgentRealmId(agent) === null);
}

/**
 * Selects the pinned system-scope director from an agent list.
 *
 * The drawer renders the returned snapshot as the pinned entity above the Realm
 * groups, and `groupAgentsByRealm` excludes it from every group. A realm-local
 * agent that happens to be named `director` is an ordinary member and is never
 * selected (I2, ticket 93243cc).
 *
 * @param agents - Agent snapshots in display order.
 * @returns The system-scope director snapshot, or `null` when none is present.
 *
 * @example
 * ```typescript
 * const pinned = selectPinnedDirector(sandboxStore.agents);
 * ```
 */
export function selectPinnedDirector<T extends RealmGroupableAgent>(agents: readonly T[]): T | null {
  const list = Array.isArray(agents) ? agents : [];
  return list.find((agent) => isDirectorAgent(agent)) ?? null;
}

/**
 * Resolves an agent's Realm membership: a trimmed non-empty `config.realmId`,
 * or `null` for an absent/blank value.
 *
 * @param agent - Agent snapshot or structural equivalent.
 * @returns Membership id, or `null`.
 */
export function resolveAgentRealmId(agent: RealmGroupableAgent): string | null {
  const value = agent && agent.config ? agent.config.realmId : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Groups agents by Realm with a stable ordering:
 * 1. one group per registry Realm, in registry order (including Realms with no
 *    members, so the operator can manage them);
 * 2. the system-scope director is excluded (the drawer pins it separately);
 *    realm-local agents named `director` group like any other member;
 * 3. an absent or blank membership falls back to the Generic group — the
 *    registry record when it exists, otherwise a trailing synthetic Generic
 *    group;
 * 4. an unregistered membership renders under its own raw realm id (a trailing
 *    synthetic group), never dropped and never silently re-labeled;
 * 5. member order inside every group is the incoming order.
 *
 * @param agents - Agent snapshots in display order (director entries allowed).
 * @param realms - Realm records in registry order.
 * @returns Grouped projection; an empty registry with no groupable agents
 *   yields `[]`.
 *
 * @example
 * ```typescript
 * const groups = groupAgentsByRealm(sandboxStore.agents, sandboxStore.realms);
 * groups.map(group => [group.label, group.agents.length]);
 * ```
 */
export function groupAgentsByRealm<T extends RealmGroupableAgent>(
  agents: readonly T[],
  realms: readonly RealmRecord[]
): RealmAgentGroup<T>[] {
  const list = Array.isArray(agents) ? agents : [];
  const records = Array.isArray(realms) ? realms : [];

  const groups: RealmAgentGroup<T>[] = records.map((realm) => ({
    key: realm.id,
    realm,
    label: realm.name,
    agents: []
  }));
  const groupByKey = new Map(groups.map((group) => [group.key, group]));
  const genericGroup = groupByKey.get(GENERIC_REALM_ID) ?? null;

  const synthetic = new Map<string, RealmAgentGroup<T>>();
  const genericFallback: T[] = [];

  for (const agent of list) {
    if (isDirectorAgent(agent)) continue;
    const realmId = resolveAgentRealmId(agent);
    if (!realmId || realmId === GENERIC_REALM_ID) {
      if (genericGroup) {
        genericGroup.agents.push(agent);
      } else {
        genericFallback.push(agent);
      }
      continue;
    }
    const registered = groupByKey.get(realmId);
    if (registered) {
      registered.agents.push(agent);
      continue;
    }
    let orphan = synthetic.get(realmId);
    if (!orphan) {
      orphan = { key: realmId, realm: null, label: realmId, agents: [] };
      synthetic.set(realmId, orphan);
    }
    orphan.agents.push(agent);
  }

  groups.push(...synthetic.values());
  if (genericFallback.length > 0) {
    groups.push({
      key: GENERIC_REALM_ID,
      realm: null,
      label: 'Generic',
      agents: genericFallback
    });
  }

  return groups;
}

/**
 * Member counts the deletion dialog derives from the live store projections.
 */
export interface RealmDeletionCounts {
  /** Active members whose membership names the Realm. */
  readonly active: number;
  /** Recycled members whose membership names the Realm. */
  readonly recycled: number;
}

/**
 * Pure copy/behavior model of the Realm manager's deletion dialog (Wave R,
 * ticket 56ba4b9).
 *
 * `protected` marks the seeded Generic realm (never deletable, with or without
 * the recursive override); `requiresRecursive` marks a member-bearing Realm
 * whose default deletion is refused — the operator must opt into the explicit
 * recursive purge instead.
 */
export interface RealmDeletionPlan {
  /** Realm the dialog targets. */
  readonly realmId: string;
  /** Display name of the targeted Realm. */
  readonly realmName: string;
  /** True for the seeded Generic default (always refused). */
  readonly protected: boolean;
  /** Active member count. */
  readonly activeMembers: number;
  /** Recycled member count. */
  readonly recycledMembers: number;
  /** Total members the Realm carries (`active + recycled`). */
  readonly memberCount: number;
  /** True when the default (non-recursive) deletion is refused by members. */
  readonly requiresRecursive: boolean;
  /** Refusal/protection copy; empty when the default deletion is available. */
  readonly blockedCopy: string;
  /** Label of the recursive-override option. */
  readonly recursiveLabel: string;
  /** Copy describing what the recursive override permanently deletes. */
  readonly recursiveCopy: string;
  /** Final confirmation copy for the selected deletion mode. */
  readonly confirmCopy: string;
  /** Label of the destructive confirm button for the selected mode. */
  readonly confirmLabel: string;
}

/**
 * Builds the deletion-dialog model for one Realm and its member counts.
 *
 * @param realm - Targeted Realm record (structural `{ id, name }`).
 * @param counts - Active/recycled member counts from the store projections.
 * @returns The dialog model; copy is deterministic for a given input.
 */
export function describeRealmDeletion(
  realm: { readonly id: string; readonly name: string } | null | undefined,
  counts: RealmDeletionCounts
): RealmDeletionPlan {
  const realmId = realm ? realm.id : '';
  const realmName = realm ? realm.name : '';
  const activeMembers = Math.max(0, Number(counts && counts.active) || 0);
  const recycledMembers = Math.max(0, Number(counts && counts.recycled) || 0);
  const memberCount = activeMembers + recycledMembers;
  const isProtected = realmId === GENERIC_REALM_ID;
  const requiresRecursive = !isProtected && memberCount > 0;

  let blockedCopy = '';
  if (isProtected) {
    blockedCopy = 'The Generic Realm is the sandbox default and cannot be deleted.';
  } else if (requiresRecursive) {
    blockedCopy = `Deleting "${realmName}" is refused while it has ${memberCount} member(s) — terminate or delete members first, or opt into recursive deletion.`;
  }

  const recursiveLabel = `Also permanently delete the ${memberCount} member(s) inside (recursive)`;
  const recursiveCopy = `Recursive deletion permanently purges ${activeMembers} active member(s) and empties ${recycledMembers} recycled member(s) from the Recycle Bin. This cannot be undone.`;

  const confirmCopy = isProtected
    ? blockedCopy
    : requiresRecursive
      ? `Permanently delete "${realmName}" and its ${memberCount} member(s)? This cannot be undone.`
      : `Delete "${realmName}"? This cannot be undone.`;
  const confirmLabel = requiresRecursive ? `Delete Realm + ${memberCount} Member(s)` : 'Confirm Delete';

  return {
    realmId,
    realmName,
    protected: isProtected,
    activeMembers,
    recycledMembers,
    memberCount,
    requiresRecursive,
    blockedCopy,
    recursiveLabel,
    recursiveCopy,
    confirmCopy,
    confirmLabel
  };
}

/**
 * Presentation guard for Realm accent colors: accepts only 3- or 6-digit hex
 * colors (with a leading `#`), so an operator-supplied registry string can
 * never inject arbitrary CSS.
 *
 * @param color - Candidate color value.
 * @returns The trimmed hex color, or `null` when it is not a safe hex color.
 *
 * @example
 * ```typescript
 * safeRealmColor('#88aaff'); // '#88aaff'
 * safeRealmColor('url(evil)'); // null
 * ```
 */
export function safeRealmColor(color: unknown): string | null {
  if (typeof color !== 'string') return null;
  const trimmed = color.trim();
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmed) ? trimmed : null;
}
