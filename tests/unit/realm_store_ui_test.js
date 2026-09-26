/**
 * @file tests/unit/realm_store_ui_test.js
 * @description Realm sidebar/settings UI helper tests (`realmGroups.ts`).
 *
 *   Wave A A7 (ticket d13a038) pinned the original grouping (registered realms
 *   in registry order, an Ungrouped section for absent/unresolved memberships,
 *   and the operator-color presentation guard).
 *
 *   Wave R (ticket 56ba4b9) replaces the ungrouped concept: every
 *   non-director agent has a realm (the seeded Generic realm is the default),
 *   memberships never move, and the director renders as a pinned separate
 *   entity. These tests pin the new projection and the deletion-dialog copy
 *   model (including the explicit recursive override).
 *
 *   Wave T (ticket 2b5db57) adds the template registry and provenance UI
 *   helpers (`realmTemplateHelpers.ts`) exercised against the real store:
 *   source labels (`shipped`/`imported`/`replaces shipped`), import/export/
 *   delete controls and typed error surfacing, and the `RealmRecord.instance`
 *   provenance panel.
 *
 *   Wave U review completion (ticket 458e727) adds the review-to-launch wiring
 *   exercised against the real store: declared-authority approvals and the
 *   trust override applying/revoking real operator grants, the session
 *   candidate attach/clear surface feeding the review and attaching at launch,
 *   and the operator publishing-authority toggles
 *   (`realmReviewHelpers.ts` + `sandboxStore`).
 *
 *   Format v2 (ticket a71198f) adds the v2 launcher input projection exercised
 *   against the real store: the required-input block, the operator-assembled
 *   shape-tagged `inputs` payload a real launch accepts, the placement writes
 *   it produces, the typed shape-mismatch refusal, and an edited review slot
 *   whose assembled package lands the edited content in the seeded file.
 *
 *   P2.3 (extension wave) adds the extension management surface against the
 *   real store: install/attach/detach round-trips with typed refusals, the
 *   live missing-tools flow over a real launch's disclosure, and the
 *   provenance rows plus the realm-card badge for recorded extension
 *   resolution (`extensionUiHelpers.ts` + `realmGroups.ts`).
 *
 *   Ticket 9472417 adds the attach-editor ceiling state model
 *   (`describeRealmAttachCeilingEditor`): the stale "No live catalog is
 *   connected yet" claim must not render while nothing is selected (a catalog
 *   may be connected), while the selected-without-catalog recording copy
 *   stays.
 */

import '../test_env.js';
import { sharedLocalStorage } from '../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DIRECTOR_GROUP_KEY,
  DIRECTOR_GROUP_LABEL,
  GENERIC_REALM_ID,
  describeRealmDeletion,
  describeRealmExtensionIndicator,
  groupAgentsByRealm,
  isDirectorAgent,
  resolveAgentRealmId,
  safeRealmColor
} from '../../src/lib/components/sandbox/realmGroups.ts';
import {
  applyAgentExtensionSelectorToggle,
  applyAgentExtensionToolToggle,
  buildAgentExtensionTuningProjection,
  buildAgentLiveExtensionTuningProjection,
  buildExtensionCatalogFidelityView,
  buildExtensionConnectionView,
  buildExtensionConnectionViews,
  buildMissingExtensionFlowViews,
  buildRealmAttachmentCeilingView,
  buildRealmExtensionAttachmentViews,
  buildRealmExtensionRequestViews,
  describeExtensionCatalogDrift,
  describeExtensionConnectionError,
  describeExtensionConnectionStatus,
  describeExtensionRemovalError,
  describeRealmAttachCeilingEditor,
  describeRealmExtensionLiveIndicator,
  EXTENSION_THIRD_PARTY_LABEL,
  formatExtensionConnectionTimestamp
} from '../../src/lib/components/sandbox/extensionUiHelpers.ts';
import {
  buildRealmProvenanceView,
  buildRealmTemplateCatalogEntries,
  buildRealmTemplateExportFilename,
  canDeleteRealmTemplate,
  describeRealmTemplateDeleteError,
  describeRealmTemplateDeletion,
  describeRealmTemplateExportError,
  describeRealmTemplateImportError,
  describeRealmTemplateImportReceipt,
  describeRealmTemplateSource,
  formatRealmLaunchTimestamp
} from '../../src/lib/components/sandbox/realmTemplateHelpers.ts';
import { buildRealmV2InputDrafts, setRealmV2InputFiles, setRealmV2InputText, validateRealmV2InputDrafts } from '../../src/lib/components/sandbox/realmLauncherHelpers.ts';
import {
  applyMetaAuthorityToggle,
  assembleRealmAuthorityApprovals,
  assembleRealmReviewPackage,
  buildMetaAuthorityToggleState,
  buildRealmAuthorityDecisions,
  buildRealmAuthorityDecisionKey,
  buildRealmAuthorityReviewAgents,
  buildRealmPendingPayloadViews,
  buildRealmReviewFileSlots,
  describeRealmAuthorityTrust,
  previewRealmReviewPackage,
  resolveRealmReviewLaunchPayload
} from '../../src/lib/components/sandbox/realmReviewHelpers.ts';
import {
  SandboxStore,
  createSandboxStore,
  REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES
} from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AgentRuntime, createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import {
  DEMO_TEMPLATE,
  serializeTemplateBundle,
  templateBundleVersion,
  validatePayload
} from '../../src/lib/sandbox/realmCatalog/index.ts';

/**
 * Builds an agent fixture with an optional Realm membership.
 *
 * @param {string} id - Agent id.
 * @param {string | null} [realmId] - Membership value.
 * @returns {object} Structural agent snapshot.
 */
function agent(id, realmId = null) {
  return { id, config: { realmId } };
}

/**
 * Builds a Realm record fixture.
 *
 * @param {string} id - Realm id.
 * @param {string} [name] - Display name.
 * @param {string} [color] - Accent color.
 * @returns {object} Structural realm record.
 */
function realm(id, name = id, color = undefined) {
  return { id, name, createdAt: 1, ...(color ? { color } : {}) };
}

/**
 * Registry fixture mirroring the store's seeded topology: Generic first.
 *
 * @returns {object[]} Realm records in registry order.
 */
function seededRealms() {
  return [realm(GENERIC_REALM_ID, 'Generic'), realm('r1', 'Realm One')];
}

test('1. only the system-scope director is pinned; a realm-local "director" renders under its realm', async () => {
  const director = agent('director', null);
  const member = agent('member', 'r1');
  assert.strictEqual(isDirectorAgent(director), true);
  assert.strictEqual(isDirectorAgent(member), false);
  assert.strictEqual(isDirectorAgent(null), false);

  // I2 (ticket 93243cc): the director id is an ordinary realm-local label.
  // Only the system-scope director (no realm membership) is the pinned entity.
  const realmDirector = agent('director', 'r1');
  assert.strictEqual(
    isDirectorAgent(realmDirector),
    false,
    'a realm-local director id is an ordinary member, never the pinned entity'
  );

  const groups = groupAgentsByRealm([director, realmDirector, member], seededRealms());
  assert.deepStrictEqual(
    groups.flatMap((group) => group.agents.map((entry) => entry.id)),
    ['director', 'member'],
    'the realm-local director renders exactly once inside its realm group; the system director stays pinned'
  );
  assert.strictEqual(
    groups.flatMap((group) => group.agents).filter((entry) => entry.id === 'director').length,
    1,
    'the realm-local director is never dropped'
  );
  assert.strictEqual(DIRECTOR_GROUP_KEY, '__director__');
  assert.strictEqual(DIRECTOR_GROUP_LABEL, 'Director');

  // The pinned entity is selected by scope, never by bare id.
  const module = await import('../../src/lib/components/sandbox/realmGroups.ts');
  assert.strictEqual(typeof module.selectPinnedDirector, 'function', 'the pinned-director selector is exported');
  assert.strictEqual(module.selectPinnedDirector([director, realmDirector, member]), director);
  assert.strictEqual(
    module.selectPinnedDirector([realmDirector, member]),
    null,
    'a realm-local director never resolves as the pinned entity'
  );
  assert.strictEqual(module.selectPinnedDirector([]), null);
});

test('2. registered realms keep registry order (Generic first), include empty realms, and preserve input order', () => {
  const realms = [realm(GENERIC_REALM_ID, 'Generic'), realm('r2', 'Second'), realm('r1', 'First'), realm('r3', 'Empty')];
  const agents = [agent('g1', GENERIC_REALM_ID), agent('a', 'r1'), agent('b', 'r2'), agent('c', 'r1'), agent('g2', GENERIC_REALM_ID)];
  const groups = groupAgentsByRealm(agents, realms);

  assert.deepStrictEqual(groups.map((group) => group.key), [GENERIC_REALM_ID, 'r2', 'r1', 'r3']);
  assert.deepStrictEqual(groups.map((group) => group.label), ['Generic', 'Second', 'First', 'Empty']);
  assert.deepStrictEqual(groups[0].agents.map((entry) => entry.id), ['g1', 'g2'], 'input order is preserved inside a group');
  assert.deepStrictEqual(groups[1].agents.map((entry) => entry.id), ['b']);
  assert.deepStrictEqual(groups[2].agents.map((entry) => entry.id), ['a', 'c']);
  assert.deepStrictEqual(groups[3].agents, [], 'an empty Realm still renders for management');
  assert.ok(groups.every((group) => group.realm !== null), 'every registry group carries its record');
});

test('3. absent membership falls back to Generic; an unregistered membership renders under its raw realm id', () => {
  const agents = [
    agent('explicit_generic', GENERIC_REALM_ID),
    agent('blank', '   '),
    agent('missing'),
    agent('orphan', 'realm_deleted'),
    agent('member', 'r1')
  ];
  const groups = groupAgentsByRealm(agents, seededRealms());

  assert.deepStrictEqual(groups.map((group) => group.key), [GENERIC_REALM_ID, 'r1', 'realm_deleted']);
  assert.deepStrictEqual(
    groups[0].agents.map((entry) => entry.id),
    ['explicit_generic', 'blank', 'missing'],
    'absent/blank membership resolves to the default Generic realm'
  );
  assert.deepStrictEqual(groups[1].agents.map((entry) => entry.id), ['member']);
  assert.deepStrictEqual(
    groups[2].agents.map((entry) => entry.id),
    ['orphan'],
    'an unregistered membership renders under its own realm id instead of being dropped'
  );
  assert.strictEqual(groups[2].realm, null, 'a synthetic group has no registry record');
  assert.strictEqual(groups[2].label, 'realm_deleted');
  assert.strictEqual(
    groups.flatMap((group) => group.agents).length,
    agents.length,
    'every non-director agent renders exactly once'
  );
});

test('4. a registry without records still renders a synthetic Generic group for the defaulted members', () => {
  const groups = groupAgentsByRealm(
    [agent('a'), agent('blank', '   '), agent('b', 'r1'), agent('director')],
    []
  );

  assert.deepStrictEqual(
    groups.map((group) => group.key),
    ['r1', GENERIC_REALM_ID],
    'absent/blank memberships fold into the synthetic Generic fallback; other memberships keep their raw id'
  );
  assert.strictEqual(groups[0].label, 'r1');
  assert.deepStrictEqual(groups[0].agents.map((entry) => entry.id), ['b']);
  assert.strictEqual(groups[1].label, 'Generic');
  assert.strictEqual(groups[1].realm, null, 'no registry record exists to attach');
  assert.deepStrictEqual(groups[1].agents.map((entry) => entry.id), ['a', 'blank']);
});

test('5. resolveAgentRealmId trims, and safeRealmColor accepts only 3/6-digit hex colors', () => {
  assert.strictEqual(resolveAgentRealmId(agent('x', ' r1 ')), 'r1');
  assert.strictEqual(resolveAgentRealmId(agent('x', '   ')), null);
  assert.strictEqual(resolveAgentRealmId(agent('x')), null);
  assert.strictEqual(resolveAgentRealmId({ id: 'x', config: null }), null);
  assert.strictEqual(resolveAgentRealmId({ id: 'x' }), null);

  assert.strictEqual(safeRealmColor('#abc'), '#abc');
  assert.strictEqual(safeRealmColor('#A1B2C3'), '#A1B2C3');
  assert.strictEqual(safeRealmColor('  #88aaff  '), '#88aaff');
  assert.strictEqual(safeRealmColor(undefined), null);
  assert.strictEqual(safeRealmColor(null), null);
  assert.strictEqual(safeRealmColor(42), null);
  assert.strictEqual(safeRealmColor('red'), null);
  assert.strictEqual(safeRealmColor('#abcd'), null);
  assert.strictEqual(safeRealmColor('url(https://evil.test/x)'), null);
  assert.strictEqual(safeRealmColor('red;background:url(x)'), null);
});

test('5.1. realm member selection shares the engine trim semantics for padded memberships (7368e98)', async () => {
  const { selectRealmMembers } = await import('../../src/lib/components/sandbox/realmGroups.ts');

  // Ticket 7368e98: the deletion dialog counted exact-string memberships while
  // the engine counted trimmed ones, so a hydrated `' realm_one '` membership
  // could make the dialog and the engine disagree. Member selection must use
  // the same trim semantics as `resolveAgentRealmId`/`resolveMemberRealmId`.
  const members = selectRealmMembers(
    [
      agent('padded', ' realm_one '),
      agent('exact', 'realm_one'),
      agent('blank', '   '),
      agent('other', 'realm_two'),
      agent('absent')
    ],
    'realm_one'
  );

  assert.deepStrictEqual(
    members.map((entry) => entry.id),
    ['padded', 'exact'],
    'a padded hydrated membership must count as a member of its trimmed realm'
  );
});

test('6. the deletion plan refuses member-bearing realms and offers the recursive override explicitly', () => {
  const blocked = describeRealmDeletion(realm('r1', 'Story Realm'), { active: 2, recycled: 1 });
  assert.strictEqual(blocked.realmId, 'r1');
  assert.strictEqual(blocked.protected, false);
  assert.strictEqual(blocked.memberCount, 3);
  assert.strictEqual(blocked.requiresRecursive, true, 'members block the default deletion');
  assert.match(blocked.blockedCopy, /terminate or delete members first/i, 'the refusal copy names the required action');
  assert.match(blocked.blockedCopy, /Story Realm/);
  assert.match(blocked.recursiveCopy, /recursively|permanently/i, 'the recursive option is described explicitly');
  assert.match(blocked.recursiveCopy, /2 active member/, 'the recursive copy counts the active members it would purge');
  assert.match(blocked.recursiveCopy, /1 recycled member/, 'the recursive copy counts the recycled members it would empty');
  assert.match(blocked.recursiveLabel, /recursive/i);
  assert.match(blocked.confirmLabel, /3/);

  const empty = describeRealmDeletion(realm('r2', 'Empty Realm'), { active: 0, recycled: 0 });
  assert.strictEqual(empty.requiresRecursive, false);
  assert.strictEqual(empty.blockedCopy, '', 'an empty realm is not blocked');
  assert.match(empty.confirmCopy, /Empty Realm/);
});

test('7. the Generic realm is always protected from deletion', () => {
  const generic = describeRealmDeletion(realm(GENERIC_REALM_ID, 'Generic'), { active: 4, recycled: 2 });
  assert.strictEqual(generic.protected, true);
  assert.strictEqual(generic.requiresRecursive, false, 'there is no recursive path for Generic');
  assert.match(generic.blockedCopy, /Generic/);
  assert.match(generic.blockedCopy, /cannot be deleted/i);
});

test('8. the module no longer carries the UNGROUPED vocabulary', async () => {
  const module = await import('../../src/lib/components/sandbox/realmGroups.ts');
  assert.strictEqual('UNGROUPED_GROUP_KEY' in module, false, 'the ungrouped group key is retired');
  assert.strictEqual('UNGROUPED_GROUP_LABEL' in module, false, 'the ungrouped label is retired');
});

// ============================================================================
// 9-13. Wave T: template registry picker/provenance UI helpers over the real store
// ============================================================================

/**
 * Builds a valid canonical template bundle fixture for the registry flows.
 *
 * @param {string} id - Template id (also the agent id prefix).
 * @returns {object} Transport bundle (`{ formatVersion, template, files }`).
 */
function uiBundle(id) {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id,
      name: `UI ${id}`,
      description: `UI fixture ${id}.`,
      agents: [
        {
          key: 'writer',
          idPattern: `${id}-writer`,
          name: 'Writer',
          role: 'writer',
          prompt: [{ kind: 'text', text: `${id} protocol.` }],
          toolProfile: { tools: [] },
          privileged: false
        }
      ]
    },
    files: {}
  };
}

/**
 * Builds a structural Realm record carrying an optional provenance block.
 *
 * @param {object|null} instance - Provenance block, or `null` for none.
 * @returns {object} Realm record fixture.
 */
function realmWithProvenance(instance) {
  return {
    id: 'realm_ui',
    name: 'UI Realm',
    templateId: 'ui-template',
    createdAt: 1,
    ...(instance ? { instance } : {})
  };
}

test('9. template catalog entries carry the store source labels and only imports are deletable', () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const shippedTemplates = store.listRealmTemplates();
    const shippedEntries = buildRealmTemplateCatalogEntries(shippedTemplates, store.listRealmTemplateSources());
    assert.strictEqual(shippedEntries.length, shippedTemplates.length, 'one picker entry per effective template');
    assert.ok(shippedEntries.length >= 1, 'the shipped catalog is never empty');
    assert.ok(
      shippedEntries.every((entry) => entry.source === 'shipped' && entry.sourceLabel === 'shipped' && !entry.deletable),
      'every shipped entry is labeled and non-deletable'
    );
    assert.strictEqual(canDeleteRealmTemplate(shippedEntries[0]), false);
    const demoEntry = shippedEntries.find((entry) => entry.id === DEMO_TEMPLATE.id);
    assert.ok(demoEntry, 'the baked demo entry is listed');
    assert.strictEqual(
      demoEntry.templateVersion,
      templateBundleVersion({ template: DEMO_TEMPLATE, files: {} }),
      'the label carries the effective authored bundle content version'
    );

    const receipt = store.importRealmTemplate(uiBundle('ui-import'));
    assert.strictEqual(receipt.replacesShipped, false);
    const afterImport = buildRealmTemplateCatalogEntries(store.listRealmTemplates(), store.listRealmTemplateSources());
    assert.strictEqual(afterImport.length, shippedEntries.length + 1, 'an import appends one effective entry');
    const importedEntry = afterImport.find((entry) => entry.id === 'ui-import');
    assert.strictEqual(importedEntry.source, 'imported');
    assert.strictEqual(importedEntry.sourceLabel, 'imported');
    assert.strictEqual(importedEntry.replacesShipped, false);
    assert.strictEqual(importedEntry.deletable, true);
    assert.strictEqual(importedEntry.templateVersion, receipt.templateVersion);
    assert.strictEqual(canDeleteRealmTemplate(importedEntry), true);
    assert.match(describeRealmTemplateImportReceipt(receipt), /Imported template "ui-import"/);
    assert.doesNotMatch(describeRealmTemplateImportReceipt(receipt), /replaces the shipped revision/);
    const importedPlan = describeRealmTemplateDeletion(importedEntry);
    assert.strictEqual(importedPlan.allowed, true);
    assert.match(importedPlan.confirmCopy, /cannot be undone/);
    assert.strictEqual(importedPlan.confirmLabel, 'Delete Import');

    // Shadowing: importing the demo id replaces the shipped entry in place.
    const shadowReceipt = store.importRealmTemplate(uiBundle(DEMO_TEMPLATE.id));
    assert.strictEqual(shadowReceipt.replacesShipped, true);
    const shadowed = buildRealmTemplateCatalogEntries(store.listRealmTemplates(), store.listRealmTemplateSources());
    assert.strictEqual(shadowed.length, afterImport.length, 'shadowing replaces an entry, never appends one');
    const shadowEntry = shadowed.find((entry) => entry.id === DEMO_TEMPLATE.id);
    assert.strictEqual(shadowEntry.source, 'imported');
    assert.strictEqual(shadowEntry.sourceLabel, 'imported · replaces shipped');
    assert.strictEqual(shadowEntry.replacesShipped, true);
    assert.strictEqual(shadowEntry.name, `UI ${DEMO_TEMPLATE.id}`, 'the effective entry is the import');
    assert.match(describeRealmTemplateImportReceipt(shadowReceipt), /replaces the shipped revision/);
    const shadowPlan = describeRealmTemplateDeletion(shadowEntry);
    assert.strictEqual(shadowPlan.allowed, true);
    assert.match(shadowPlan.confirmCopy, /shipped revision of this id will resolve again/);
    assert.strictEqual(shadowPlan.confirmLabel, 'Delete Import & Restore Shipped');
    const shippedPlan = describeRealmTemplateDeletion(demoEntry);
    assert.strictEqual(shippedPlan.allowed, false);
    assert.match(shippedPlan.blockedCopy, /cannot be deleted/);
    assert.strictEqual(describeRealmTemplateSource('imported', true), 'imported · replaces shipped');
    assert.strictEqual(describeRealmTemplateSource('imported', false), 'imported');
    assert.strictEqual(describeRealmTemplateSource('shipped', true), 'shipped');
    assert.strictEqual(describeRealmTemplateSource(undefined, undefined), 'shipped');

    // Deleting the shadow import restores the shipped revision in place.
    assert.strictEqual(store.deleteRealmTemplate(DEMO_TEMPLATE.id), true);
    const restored = buildRealmTemplateCatalogEntries(store.listRealmTemplates(), store.listRealmTemplateSources())
      .find((entry) => entry.id === DEMO_TEMPLATE.id);
    assert.strictEqual(restored.source, 'shipped');
    assert.strictEqual(restored.sourceLabel, 'shipped');
    assert.strictEqual(
      restored.templateVersion,
      templateBundleVersion({ template: DEMO_TEMPLATE, files: {} })
    );
    assert.strictEqual(store.deleteRealmTemplate(DEMO_TEMPLATE.id), false, 'shipped revisions have no delete path');
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

test('10. import failures surface the typed catalog and store errors', () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    assert.throws(
      () => store.importRealmTemplate('not json'),
      (err) => {
        const text = describeRealmTemplateImportError(err);
        assert.match(text, /not a canonical Realm template bundle/i);
        assert.match(text, /formatVersion/);
        return true;
      }
    );
    assert.throws(
      () => store.importRealmTemplate({ formatVersion: 1, template: { formatVersion: 1, id: 'broken' }, files: {} }),
      (err) => {
        const text = describeRealmTemplateImportError(err);
        assert.match(text, /failed format-v1 validation/i);
        return true;
      }
    );

    // Oversized bundle: rejected before any mutation, with the budget hint.
    const oversized = uiBundle('ui-oversized');
    oversized.template.seed = {
      files: [
        {
          path: 'big.md',
          target: 'realm',
          origin: 'fixed',
          source: { inline: 'x'.repeat(REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES + 1024) }
        }
      ]
    };
    assert.throws(
      () => store.importRealmTemplate(oversized),
      (err) => {
        const text = describeRealmTemplateImportError(err);
        assert.match(text, /exceeding the per-bundle cap/);
        assert.match(text, /files or hydration packages/);
        return true;
      }
    );
    assert.strictEqual(store.getRealmTemplateBundle('ui-oversized'), null, 'an oversized import never enters the catalog');

    // Persistence rollback: the import is rejected and the registry is unchanged.
    const rollbackFixture = uiBundle('ui-rollback');
    sharedLocalStorage.__simulateQuotaExceeded(true);
    try {
      assert.throws(
        () => store.importRealmTemplate(rollbackFixture),
        (err) => {
          const text = describeRealmTemplateImportError(err);
          assert.match(text, /rolled back/i);
          assert.match(text, /storage quota/i);
          return true;
        }
      );
    } finally {
      sharedLocalStorage.__simulateQuotaExceeded(false);
    }
    assert.strictEqual(store.getRealmTemplateBundle('ui-rollback'), null, 'the rolled-back import is not effective');
    assert.strictEqual(
      store.listRealmTemplateSources().some((entry) => entry.templateId === 'ui-rollback'),
      false,
      'the rolled-back import left no source label'
    );
    assert.strictEqual(store.importRealmTemplate(rollbackFixture).templateId, 'ui-rollback', 'the registry stays writable');
    assert.strictEqual(describeRealmTemplateImportError(null), 'Failed to import the template bundle.');
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

test('11. export round-trips the effective bundle and its failures surface honestly', () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const fixture = uiBundle('ui-export');
    store.importRealmTemplate(fixture);
    const exported = store.exportRealmTemplate('ui-export');
    assert.strictEqual(exported, serializeTemplateBundle(fixture), 'export is the canonical transport payload');
    const reimported = store.importRealmTemplate(exported);
    assert.strictEqual(reimported.replacedImport, true, 'the exported text re-imports to the same id');
    assert.match(describeRealmTemplateImportReceipt(reimported), /previous import of this id was replaced/);

    assert.throws(
      () => store.exportRealmTemplate('ghost'),
      (err) => {
        const text = describeRealmTemplateExportError(err);
        assert.match(text, /unknown realm template/);
        assert.match(text, /refresh the template list and retry/i);
        return true;
      }
    );
    assert.strictEqual(describeRealmTemplateExportError(null), 'Failed to export the template bundle.');

    assert.strictEqual(buildRealmTemplateExportFilename('ui-export'), 'ui-export.template.json');
    assert.strictEqual(buildRealmTemplateExportFilename('../../evil'), 'evil.template.json', 'path characters are sanitized');
    assert.strictEqual(buildRealmTemplateExportFilename(''), 'realm-template.template.json');
    assert.strictEqual(buildRealmTemplateExportFilename(42), 'realm-template.template.json');

    // A rolled-back delete keeps the import effective and says so.
    sharedLocalStorage.__simulateQuotaExceeded(true);
    try {
      assert.throws(
        () => store.deleteRealmTemplate('ui-export'),
        (err) => {
          const text = describeRealmTemplateDeleteError(err);
          assert.match(text, /rolled back/i);
          assert.match(text, /storage quota/i);
          return true;
        }
      );
    } finally {
      sharedLocalStorage.__simulateQuotaExceeded(false);
    }
    assert.ok(store.getRealmTemplateBundle('ui-export'), 'the import survives the rolled-back delete');
    assert.strictEqual(describeRealmTemplateDeleteError(null), 'Failed to delete the imported template.');
    assert.strictEqual(store.deleteRealmTemplate('ui-export'), true);
    assert.strictEqual(store.getRealmTemplateBundle('ui-export'), null);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

test('12. the provenance panel reads RealmRecord.instance and hides when absent', () => {
  const view = buildRealmProvenanceView(realmWithProvenance({
    templateId: 'ui-template',
    templateVersion: 'sha256:abc',
    packageDigest: 'sha256:def',
    inputHashes: { brief: 'sha256:1' },
    seedPaths: ['/a.md'],
    launchedAt: '2026-09-21T12:34:56.000Z'
  }));
  assert.strictEqual(view.visible, true);
  assert.strictEqual(view.templateId, 'ui-template');
  assert.deepStrictEqual(
    view.rows.map((row) => row.key),
    ['templateId', 'templateVersion', 'packageDigest', 'launchedAt'],
    'rows render in a stable order'
  );
  assert.deepStrictEqual(
    view.rows.map((row) => row.value),
    ['ui-template', 'sha256:abc', 'sha256:def', '2026-09-21 12:34:56 UTC']
  );

  const withoutPackage = buildRealmProvenanceView(realmWithProvenance({
    templateId: 'ui-template',
    templateVersion: 'sha256:abc',
    inputHashes: {},
    seedPaths: [],
    launchedAt: '2026-09-21T12:34:56.000Z'
  }));
  assert.deepStrictEqual(
    withoutPackage.rows.map((row) => row.key),
    ['templateId', 'templateVersion', 'launchedAt'],
    'no package row is shown without a digest'
  );

  // Absent or malformed provenance renders nothing — never a guessed panel.
  assert.strictEqual(buildRealmProvenanceView(null).visible, false);
  assert.strictEqual(buildRealmProvenanceView(realmWithProvenance(null)).visible, false);
  assert.deepStrictEqual(buildRealmProvenanceView(realmWithProvenance(null)).rows, []);
  assert.strictEqual(
    buildRealmProvenanceView({ id: 'x', name: 'X', templateId: 'ui-template', createdAt: 1 }).visible,
    false,
    'a bare templateId is not launch provenance'
  );
  assert.strictEqual(buildRealmProvenanceView({ instance: { templateId: 'x' } }).visible, false);
  assert.strictEqual(
    buildRealmProvenanceView({ instance: { templateId: 'x', templateVersion: 'sha256:a', launchedAt: '   ' } }).visible,
    false
  );

  assert.strictEqual(formatRealmLaunchTimestamp('2026-09-21T12:34:56.000Z'), '2026-09-21 12:34:56 UTC');
  assert.strictEqual(formatRealmLaunchTimestamp('not-a-date'), 'not-a-date');
  assert.strictEqual(formatRealmLaunchTimestamp(42), '');
  assert.strictEqual(formatRealmLaunchTimestamp(null), '');
});

test('13. a real template launch feeds the provenance panel its effective version', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const receipt = await store.launchRealmFromTemplate(DEMO_TEMPLATE.id, { name: 'Provenance Realm' });
    const view = buildRealmProvenanceView(receipt.realm);
    assert.strictEqual(view.visible, true, 'a launched record carries visible provenance');
    assert.strictEqual(view.templateId, DEMO_TEMPLATE.id);
    const byKey = Object.fromEntries(view.rows.map((row) => [row.key, row.value]));
    assert.strictEqual(
      byKey.templateVersion,
      templateBundleVersion({ template: DEMO_TEMPLATE, files: {} }),
      'the panel shows the effective authored bundle version the launch recorded'
    );
    assert.strictEqual(byKey.packageDigest, undefined, 'no package row without an attached package');
    assert.match(byKey.launchedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    assert.strictEqual(
      store.getRealm(receipt.realm.id).instance.templateId,
      DEMO_TEMPLATE.id,
      'the registry record carries the same provenance the panel reads'
    );
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 14-16. Wave U review completion over the real store (ticket 458e727)
// ============================================================================

/**
 * Builds a declared-authority template bundle (the Session Zero shape: one
 * template-authoring agent and one payload agent, never granted jointly).
 *
 * @returns {object} Transport bundle.
 */
function uiAuthorityBundle() {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: 'u-authority-bundle',
      name: 'Authority Bundle',
      description: 'Declared publishing authorities fixture.',
      agents: [
        {
          key: 'architect',
          idPattern: 'u-authority-architect',
          name: 'Architect',
          role: 'template author',
          prompt: [{ kind: 'text', text: 'Author protocol.' }],
          toolProfile: { tools: [] },
          privileged: true,
          authorities: ['@template:authority']
        },
        {
          key: 'genesis',
          idPattern: 'u-authority-genesis',
          name: 'Genesis',
          role: 'payload author',
          prompt: [{ kind: 'text', text: 'Hydrate protocol.' }],
          toolProfile: { tools: [] },
          privileged: true,
          authorities: ['@hydration:authority']
        }
      ]
    },
    files: {}
  };
}

/**
 * Builds a hydration fixture bundle: one generated input, one generated
 * realm-global slot, and one user member slot.
 *
 * @returns {object} Transport bundle.
 */
function uiPayloadBundle() {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: 'u-payload-bundle',
      name: 'Payload Bundle',
      description: 'Generated/user slot fixture.',
      inputs: [{ id: 'topic', label: 'Topic', origin: 'generated', brief: 'A topic.', required: true }],
      agents: [
        {
          key: 'writer',
          idPattern: 'u-payload-writer',
          name: 'Writer',
          role: 'writer',
          prompt: [{ kind: 'text', text: 'Write.' }, { kind: 'input', inputId: 'topic' }],
          toolProfile: { tools: [] },
          privileged: false
        }
      ],
      seed: {
        files: [
          { path: 'lore/world.md', target: 'realm', origin: 'generated', brief: 'World lore.' },
          { path: 'notes/tone.md', target: { agent: 'writer' }, origin: 'user', brief: 'Tone notes.' }
        ]
      }
    },
    files: {}
  };
}

test('14. declared-authority approvals and the trust override drive real operator grants', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const bundle = uiAuthorityBundle();
    store.importRealmTemplate(bundle);
    const template = store.getRealmTemplateBundle(bundle.template.id).template;
    assert.deepStrictEqual(
      buildRealmAuthorityReviewAgents(template).map((row) => row.key),
      ['architect', 'genesis'],
      'the disclosure lists both declaring agents'
    );

    // Unchecked = declined: nothing travels and no grant appears.
    const declined = buildRealmAuthorityDecisions(template, null);
    assert.deepStrictEqual(assembleRealmAuthorityApprovals(template, declined), []);
    const first = await store.launchRealmFromTemplate(bundle.template.id, { name: 'Authority One' });
    assert.ok(
      !store.listMetaAuthorityGrants().template.includes(createAgentIdentityKey(first.realm.id, 'u-authority-architect')),
      'a declined request leaves the agent without the authority'
    );
    assert.ok(
      !store.listMetaAuthorityGrants().hydration.includes(createAgentIdentityKey(first.realm.id, 'u-authority-genesis'))
    );

    // Per-agent approval wires through the launch seam as ordinary grants.
    const approved = {
      ...declined,
      [buildRealmAuthorityDecisionKey('architect', '@template:authority')]: 'approved',
      [buildRealmAuthorityDecisionKey('genesis', '@hydration:authority')]: 'approved'
    };
    const second = await store.launchRealmFromTemplate(bundle.template.id, {
      name: 'Authority Two',
      authorityApprovals: assembleRealmAuthorityApprovals(template, approved)
    });
    const architectKey = createAgentIdentityKey(second.realm.id, 'u-authority-architect');
    const genesisKey = createAgentIdentityKey(second.realm.id, 'u-authority-genesis');
    assert.ok(store.listMetaAuthorityGrants().template.includes(architectKey));
    assert.ok(store.listMetaAuthorityGrants().hydration.includes(genesisKey));
    assert.ok(
      !store.listMetaAuthorityGrants().template.includes(genesisKey),
      'the grants stay per-agent (never joint)'
    );

    // Trust override: persisted only on a successful launch; exact matches
    // auto-approve later launches.
    assert.strictEqual(store.listTemplateAuthorityTrust()[bundle.template.id], undefined);
    await store.launchRealmFromTemplate(bundle.template.id, {
      name: 'Authority Three',
      authorityApprovals: assembleRealmAuthorityApprovals(template, approved),
      trustAuthorities: true
    });
    const trustRecord = store.listTemplateAuthorityTrust()[bundle.template.id];
    assert.deepStrictEqual(
      Object.entries(trustRecord).map(([agentKey, authorities]) => [agentKey, [...authorities]]),
      [
        ['architect', ['@template:authority']],
        ['genesis', ['@hydration:authority']]
      ],
      'the persisted trust record is exactly the approved declared set (null-prototype container)'
    );
    const trustView = describeRealmAuthorityTrust(template, trustRecord);
    assert.strictEqual(trustView.trusted, true);
    assert.strictEqual(trustView.pairs.length, 2);
    const trustedDecisions = buildRealmAuthorityDecisions(template, trustRecord);
    assert.strictEqual(trustedDecisions[buildRealmAuthorityDecisionKey('architect', '@template:authority')], 'trusted');
    assert.strictEqual(trustedDecisions[buildRealmAuthorityDecisionKey('genesis', '@hydration:authority')], 'trusted');

    const auto = await store.launchRealmFromTemplate(bundle.template.id, { name: 'Authority Four' });
    const autoKey = createAgentIdentityKey(auto.realm.id, 'u-authority-architect');
    assert.ok(
      store.listMetaAuthorityGrants().template.includes(autoKey),
      'the persisted trust record auto-approves the exact set without explicit approvals'
    );

    // Clearing the override re-prompts; already-applied grants stay.
    assert.strictEqual(store.clearTemplateAuthorityTrust(bundle.template.id), true);
    assert.strictEqual(store.listTemplateAuthorityTrust()[bundle.template.id], undefined);
    assert.strictEqual(describeRealmAuthorityTrust(template, null).trusted, false);
    assert.strictEqual(store.clearTemplateAuthorityTrust(bundle.template.id), false, 'clearing is idempotent-reporting');
    const afterClear = await store.launchRealmFromTemplate(bundle.template.id, { name: 'Authority Five' });
    assert.ok(
      !store.listMetaAuthorityGrants().template.includes(
        createAgentIdentityKey(afterClear.realm.id, 'u-authority-architect')
      ),
      'a cleared trust record re-prompts instead of auto-approving'
    );
    assert.ok(store.listMetaAuthorityGrants().template.includes(autoKey), 'clearing trust never revokes applied grants');
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

test('15. a session candidate feeds the review and attaches at launch, then clears', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const bundle = uiPayloadBundle();
    store.importRealmTemplate(bundle);
    const effective = store.getRealmTemplateBundle(bundle.template.id);
    const version = templateBundleVersion({ template: bundle.template, files: {} });

    // The candidate crosses the real publishing port (the tool's store seam).
    store.getRealmPublishingPort().storePendingInstancePayload({
      templateId: bundle.template.id,
      templateVersion: version,
      resolvedAt: '2026-09-21T12:34:56.000Z',
      payload: {
        formatVersion: 1,
        templateId: bundle.template.id,
        templateVersion: version,
        inputs: { topic: 'Tides' },
        files: [
          { path: 'lore/world.md', target: 'realm', content: 'Generated lore.' },
          { path: 'notes/tone.md', target: { agent: 'writer' }, content: 'Tone notes.' }
        ]
      }
    });

    const views = buildRealmPendingPayloadViews(
      bundle.template.id,
      store.listPendingInstancePayloads(),
      formatRealmLaunchTimestamp
    );
    assert.strictEqual(views.length, 1);
    assert.match(views[0].summary, /1 input · 2 files · resolved 2026-09-21 12:34:56 UTC/);
    const candidate = store.getPendingInstancePayload(bundle.template.id);
    assert.ok(candidate, 'the candidate is retrievable per template id');

    // Review projections resolve inputs and file slots from the candidate. The
    // review helpers normalize the authored format-v1 fixture to the model the
    // store exposes; the launch below attaches through the real store path.
    assert.deepStrictEqual(candidate.payload.inputs, { topic: 'Tides' }, 'the candidate carries the authored inputs');
    const slots = buildRealmReviewFileSlots(bundle.template, effective.files, { payload: candidate.payload });
    assert.deepStrictEqual(slots.map((slot) => slot.contentSource), ['payload', 'payload']);
    assert.strictEqual(slots[0].content, 'Generated lore.');
    assert.strictEqual(slots[1].content, 'Tone notes.');

    const assembly = assembleRealmReviewPackage({
      templateId: bundle.template.id,
      templateVersion: version,
      source: candidate.payload,
      slots
    });
    assert.strictEqual(assembly.package, candidate.payload, 'an unedited candidate attaches verbatim');
    const preview = previewRealmReviewPackage(bundle.template, assembly.package, { currentVersion: version });
    assert.strictEqual(preview.ok, true, preview.error);
    assert.strictEqual(preview.mismatch, false);

    // Attach through the existing Wave T launch path.
    const receipt = await store.launchRealmFromTemplate(bundle.template.id, {
      name: 'Payload Realm',
      package: assembly.package
    });
    assert.deepStrictEqual(receipt.agents.map((agent) => agent.id), ['u-payload-writer']);
    assert.strictEqual(
      store.agents.find((agent) => agent.id === 'u-payload-writer').config.systemPrompt,
      'Write.\n\nTides',
      'the candidate input composes into the launched prompt'
    );
    const globalKey = `realm:${receipt.realm.id}:global`;
    const memberKey = `realm:${receipt.realm.id}:u-payload-writer`;
    assert.strictEqual(store.fsSnapshot[globalKey]['/lore/world.md'].content, 'Generated lore.');
    assert.strictEqual(store.fsSnapshot[memberKey]['/notes/tone.md'].content, 'Tone notes.');
    assert.ok(receipt.realm.instance.seedPaths.includes('/lore/world.md'));

    // Clearing is session-only and detaches the review.
    assert.strictEqual(store.clearPendingInstancePayload(bundle.template.id), true);
    assert.strictEqual(store.getPendingInstancePayload(bundle.template.id), null);
    assert.deepStrictEqual(
      buildRealmPendingPayloadViews(
        bundle.template.id,
        store.listPendingInstancePayloads(),
        formatRealmLaunchTimestamp
      ),
      []
    );
    assert.strictEqual(store.clearPendingInstancePayload(bundle.template.id), false);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

test('16. the operator publishing-authority toggle grants and revokes through the real store', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const receipt = await store.launchRealmFromTemplate(DEMO_TEMPLATE.id, { name: 'Toggle Realm' });
    const member = receipt.agents[0];
    const realmId = receipt.realm.id;
    const agentKey = createAgentIdentityKey(realmId, member.id);

    const granted = await applyMetaAuthorityToggle(store, {
      agentId: member.id,
      authority: '@template:authority',
      enabled: true,
      realmId
    });
    assert.deepStrictEqual(granted, { ok: true, error: '' });
    assert.deepStrictEqual(
      buildMetaAuthorityToggleState(store.listMetaAuthorityGrants(), agentKey),
      { template: true, hydration: false },
      'the toggle state reads the live registry grant'
    );

    const hydration = await applyMetaAuthorityToggle(store, {
      agentId: member.id,
      authority: '@hydration:authority',
      enabled: true,
      realmId
    });
    assert.strictEqual(hydration.ok, true);
    assert.deepStrictEqual(
      buildMetaAuthorityToggleState(store.listMetaAuthorityGrants(), agentKey),
      { template: true, hydration: true }
    );

    const revoked = await applyMetaAuthorityToggle(store, {
      agentId: member.id,
      authority: '@template:authority',
      enabled: false,
      realmId
    });
    assert.strictEqual(revoked.ok, true);
    assert.deepStrictEqual(
      buildMetaAuthorityToggleState(store.listMetaAuthorityGrants(), agentKey),
      { template: false, hydration: true },
      'revoking one authority never touches the other'
    );

    const unknownAuthority = await applyMetaAuthorityToggle(store, {
      agentId: member.id,
      authority: '@nope:authority',
      enabled: true,
      realmId
    });
    assert.strictEqual(unknownAuthority.ok, false);
    assert.match(unknownAuthority.error, /Unknown publishing authority/);

    const unknownAgent = await applyMetaAuthorityToggle(store, {
      agentId: 'ghost',
      authority: '@template:authority',
      enabled: true,
      realmId
    });
    assert.strictEqual(unknownAgent.ok, false, 'a null descriptor reports no active agent instead of success');
    assert.match(unknownAgent.error, /No active agent matched/);

    const noHost = await applyMetaAuthorityToggle(null, {
      agentId: member.id,
      authority: '@template:authority',
      enabled: true,
      realmId
    });
    assert.strictEqual(noHost.ok, false);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 17. [7571ce5] VirtualFS operator partitions group by realm: shared first,
//     registry order, same-id partitions kept distinct, resolved counts kept
// ============================================================================

test('17. [7571ce5] FS operator partitions group by realm with shared first and registry order', async () => {
  const groupModule = await import('../../src/lib/components/sandbox/realmGroups.ts');
  assert.strictEqual(typeof groupModule.groupFsPartitionsByRealm, 'function', 'the FS partition grouping helper is exported');
  assert.strictEqual(groupModule.FS_SHARED_GROUP_KEY, '__shared__');
  assert.strictEqual(groupModule.FS_SHARED_GROUP_LABEL, 'Shared');
  assert.strictEqual(groupModule.FS_WORKSPACES_GROUP_KEY, '__workspaces__');
  assert.strictEqual(groupModule.FS_WORKSPACES_GROUP_LABEL, 'Workspaces');

  const realms = seededRealms();
  const partitions = [
    // Deliberately unsorted input: the helper owns the presentation order.
    { key: 'realm:r1:scout', label: 'Realm One · scout', realmId: 'r1', realmName: 'Realm One', kind: 'agent', fileCount: 1 },
    { key: 'writer-persisted', label: 'writer-persisted', realmId: null, realmName: null, kind: 'workspace', fileCount: 2 },
    { key: 'realm:r1:global', label: 'Realm One · global', realmId: 'r1', realmName: 'Realm One', kind: 'realm-global', fileCount: 3 },
    { key: 'realm:realm_deleted:global', label: 'realm_deleted · global', realmId: 'realm_deleted', realmName: null, kind: 'realm-global', fileCount: 0 },
    { key: 'global', label: 'global', realmId: null, realmName: null, kind: 'global', fileCount: 5 },
    { key: 'realm:realm_generic:othman', label: 'Generic · othman', realmId: GENERIC_REALM_ID, realmName: 'Generic', kind: 'agent', fileCount: 0 }
  ];

  const groups = groupModule.groupFsPartitionsByRealm(partitions, realms);

  assert.deepStrictEqual(
    groups.map((group) => group.key),
    [groupModule.FS_SHARED_GROUP_KEY, GENERIC_REALM_ID, 'r1', 'realm_deleted', groupModule.FS_WORKSPACES_GROUP_KEY],
    'shared first, then registry order, then unregistered realms, then other workspaces'
  );
  assert.deepStrictEqual(
    groups.map((group) => group.label),
    ['Shared', 'Generic', 'Realm One', 'realm_deleted', 'Workspaces']
  );
  assert.strictEqual(groups[0].realm, null, 'the shared group is synthetic');
  assert.strictEqual(groups[2].realm, realms[1], 'a registered realm group carries its record');
  assert.strictEqual(groups[3].realm, null, 'an unregistered realm renders under its raw id');

  const sharedPartitions = groups[0].partitions;
  assert.deepStrictEqual(sharedPartitions.map((partition) => partition.key), ['global']);
  assert.strictEqual(sharedPartitions[0].fileCount, 5, 'the resolved count is carried through, never recomputed from a label');

  const realmOne = groups[2].partitions;
  assert.deepStrictEqual(
    realmOne.map((partition) => partition.key),
    ['realm:r1:global', 'realm:r1:scout'],
    'inside a realm the realm-global partition sorts before its agents regardless of input order'
  );

  assert.deepStrictEqual(groups[1].partitions.map((partition) => partition.key), ['realm:realm_generic:othman']);
  assert.deepStrictEqual(groups[4].partitions.map((partition) => partition.key), ['writer-persisted']);
  assert.strictEqual(
    groups.flatMap((group) => group.partitions).length,
    partitions.length,
    'every partition renders exactly once'
  );

  // Degenerate input stays safe and empty-friendly.
  assert.deepStrictEqual(groupModule.groupFsPartitionsByRealm([], realms), []);
  assert.deepStrictEqual(groupModule.groupFsPartitionsByRealm(null, null), []);
});

// 18. Format-v2 launcher inputs through the real store (ticket a71198f)
// ============================================================================

/**
 * Builds a format-v2 transport bundle exercising the launcher's input
 * requirements: a required text input, a defaulted text input, a files input
 * with a path placement, and prompt/history references.
 *
 * @returns {object} Transport bundle.
 */
function uiV2Bundle() {
  return {
    formatVersion: 2,
    template: {
      formatVersion: 2,
      id: 'u-v2-bundle',
      name: 'V2 Bundle',
      description: 'Format-v2 operator inputs fixture.',
      inputs: [
        { id: 'topic', label: 'Topic', shape: 'text', required: true },
        { id: 'tone', label: 'Tone', shape: 'text', default: 'Noir.' },
        { id: 'notes', label: 'Notes', shape: 'files', brief: 'Attach notes.' }
      ],
      agents: [
        {
          key: 'writer',
          idPattern: 'u-v2-writer',
          name: 'Writer',
          role: 'writer',
          prompt: [
            { kind: 'text', text: 'Write.' },
            { kind: 'input', inputId: 'topic' },
            { kind: 'input', inputId: 'tone' }
          ],
          history: [
            { role: 'assistant', content: [{ kind: 'input', inputId: 'topic' }, { kind: 'text', text: 'Acknowledged.' }] }
          ],
          toolProfile: { tools: [] },
          privileged: false
        }
      ],
      placements: [
        { file: 'files/readme.md', target: 'realm', path: 'notes/README.md' },
        { inputId: 'notes', target: 'realm', path: 'notes/handoff.md' },
        { inputId: 'tone', target: { agent: 'writer' }, path: 'style/tone.md' }
      ]
    },
    files: { 'files/readme.md': 'Readme body.' }
  };
}

test('18. the v2 launcher projection validates and feeds a real store launch', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const bundle = uiV2Bundle();
    store.importRealmTemplate(bundle);
    const effective = store.getRealmTemplateBundle(bundle.template.id);
    const version = templateBundleVersion({ template: bundle.template, files: bundle.files });
    assert.strictEqual(store.getRealmTemplateSource(bundle.template.id).templateVersion, version);

    // The launcher drafts render from the normalized v2 model the store
    // exposes, and the required input fails closed through the synthesized
    // catalog envelope before any Realm record exists.
    const drafts = buildRealmV2InputDrafts(effective.template, effective.files);
    assert.deepStrictEqual(drafts.map((draft) => draft.shape), ['text', 'text', 'files']);
    const blocked = validateRealmV2InputDrafts(effective.template, drafts, {
      currentVersion: version,
      bundleFiles: effective.files
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.code, 'missing-required');
    assert.match(blocked.fieldErrors.topic, /required/);

    // Filling the required text input and attaching one fileset file yields
    // the exact explicit `inputs` payload the store accepts.
    const filled = drafts.map((draft) => {
      if (draft.id === 'topic') return setRealmV2InputText(draft, 'A topic.');
      if (draft.id === 'notes') {
        return setRealmV2InputFiles(draft, [{ path: 'handoff.md', content: 'Notes body.', name: 'handoff.md' }]);
      }
      return draft;
    });
    const projection = validateRealmV2InputDrafts(effective.template, filled, {
      currentVersion: version,
      bundleFiles: effective.files
    });
    assert.strictEqual(projection.ok, true, projection.error);
    assert.deepStrictEqual(projection.launchInputs, {
      topic: { shape: 'text', text: 'A topic.' },
      notes: { shape: 'files', files: [{ path: 'handoff.md', content: 'Notes body.' }] }
    });

    const receipt = await store.launchRealmFromTemplate(bundle.template.id, {
      name: 'V2 Launch',
      inputs: projection.launchInputs
    });
    assert.deepStrictEqual(receipt.agents.map((agent) => agent.id), ['u-v2-writer']);
    assert.strictEqual(
      store.agents.find((agent) => agent.id === 'u-v2-writer').config.systemPrompt,
      'Write.\n\nA topic.\n\nNoir.',
      'the explicit input and the declared default compose into the launched prompt'
    );
    const globalKey = `realm:${receipt.realm.id}:global`;
    const memberKey = `realm:${receipt.realm.id}:u-v2-writer`;
    assert.strictEqual(store.fsSnapshot[globalKey]['/notes/README.md'].content, 'Readme body.');
    assert.strictEqual(store.fsSnapshot[globalKey]['/notes/handoff.md'].content, 'Notes body.');
    assert.strictEqual(store.fsSnapshot[memberKey]['/style/tone.md'].content, 'Noir.');
    assert.ok(receipt.realm.instance.seedPaths.includes('/notes/handoff.md'));

    // A shape mismatch through the same path fails closed with the typed
    // class before any second Realm record exists.
    const mismatched = validateRealmV2InputDrafts(effective.template, filled, {
      currentVersion: version,
      bundleFiles: effective.files,
      payload: {
        formatVersion: 2,
        templateId: bundle.template.id,
        templateVersion: version,
        inputs: {
          topic: { files: [{ path: 'a.md', content: 'A' }] },
          notes: { files: [{ path: 'handoff.md', content: 'N' }] }
        }
      }
    });
    assert.strictEqual(mismatched.code, 'shape-mismatch');
    assert.match(mismatched.fieldErrors.topic, /unknown field 'files'/);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

test('19. an edited review slot launches through the assembled package and lands in the seeded file', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const bundle = uiPayloadBundle();
    store.importRealmTemplate(bundle);
    const version = templateBundleVersion({ template: bundle.template, files: {} });
    const source = {
      formatVersion: 1,
      templateId: bundle.template.id,
      templateVersion: version,
      inputs: { topic: 'Tides' },
      files: [
        { path: 'lore/world.md', target: 'realm', content: 'Generated lore.' },
        { path: 'notes/tone.md', target: { agent: 'writer' }, content: 'Tone notes.' }
      ]
    };

    // The review edits the generated realm slot; the resolved launch payload
    // is the rebuilt package, never the unedited source. Canonical slots are
    // read-only, so the edit is expressed on the slot view directly.
    const slots = buildRealmReviewFileSlots(bundle.template, {}, { payload: source }).map(
      (slot) => (slot.path === 'lore/world.md'
        ? { ...slot, edited: true, content: 'Edited lore.', contentSource: 'review' }
        : slot)
    );
    const resolved = resolveRealmReviewLaunchPayload({
      templateId: bundle.template.id,
      templateVersion: version,
      source,
      slots
    });
    assert.strictEqual(resolved.edited, true);
    assert.strictEqual(resolved.blocked, false, resolved.error);
    assert.notStrictEqual(resolved.payload, source, 'an edited review rebuilds the package');

    // The assembled payload validates through the real catalog with the edit
    // present in the resolved values.
    const validated = validatePayload(bundle.template, resolved.payload, { currentVersion: version });
    assert.strictEqual(validated.templateId, bundle.template.id);
    const filesetFiles = Object.values(validated.inputs).flatMap((value) => (
      value.shape === 'files' ? value.files : []
    ));
    assert.ok(
      filesetFiles.some((file) => file.path === 'lore/world.md' && file.content === 'Edited lore.'),
      'the edited slot content resolves through the real catalog'
    );

    // The real launch writes the edited content into the placed file.
    const receipt = await store.launchRealmFromTemplate(bundle.template.id, {
      name: 'Edited Realm',
      payload: resolved.payload
    });
    const globalKey = `realm:${receipt.realm.id}:global`;
    const memberKey = `realm:${receipt.realm.id}:u-payload-writer`;
    assert.strictEqual(
      store.fsSnapshot[globalKey]['/lore/world.md'].content,
      'Edited lore.',
      'the edited slot content lands in the seeded file'
    );
    assert.strictEqual(
      store.fsSnapshot[memberKey]['/notes/tone.md'].content,
      'Tone notes.',
      'unedited slots keep the payload content'
    );
    assert.strictEqual(
      store.agents.find((agent) => agent.id === 'u-payload-writer').config.systemPrompt,
      'Write.\n\nTides'
    );
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 20-21. Extension management over the real store (P2.3)
// ============================================================================

/**
 * Builds an extension-requesting transport bundle: one installed-able MCP
 * request, one pack request, and one agent referencing the MCP tool.
 *
 * @returns {object} Transport bundle.
 */
function uiExtensionBundle() {
  return {
    formatVersion: 1,
    template: {
      formatVersion: 1,
      id: 'u-extension-bundle',
      name: 'Extension Bundle',
      description: 'One MCP request and one pack request.',
      notes: 'Install the scoring server, then attach it here.',
      agents: [
        {
          key: 'observer',
          idPattern: 'u-ext-observer',
          name: 'Observer',
          role: 'observer',
          prompt: [{ kind: 'text', text: 'Observe the extension seam.' }],
          toolProfile: { tools: ['acme-scoring::similarity'] },
          privileged: false
        }
      ],
      providers: [
        { kind: 'mcp', id: 'acme-scoring', transport: { kind: 'http', url: 'https://mcp.example.com' } },
        { kind: 'pack', id: 'acme/text-tools', source: 'acme/text-tools-pack' }
      ]
    },
    files: {}
  };
}

test('20. install/attach/detach round-trips through the real store and the missing flow follows it', async () => {
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const bundle = uiExtensionBundle();
    store.importRealmTemplate(bundle);
    const template = store.getRealmTemplateBundle(bundle.template.id).template;

    // Nothing installed or approved: the launch proceeds with the missing
    // disclosure and records the unresolved request ids.
    const receipt = await store.launchRealmFromTemplate(bundle.template.id, { name: 'Extensions Realm' });
    assert.deepStrictEqual(
      receipt.realm.instance.missingExtensions,
      ['acme-scoring', 'acme/text-tools'],
      'both requested extensions stay disclosed'
    );
    assert.strictEqual(receipt.warnings.length, 2, JSON.stringify(receipt.warnings));

    const realm = store.getRealm(receipt.realm.id);
    const initialFlow = buildMissingExtensionFlowViews({
      missingExtensionIds: realm.instance.missingExtensions,
      template,
      installs: store.listExtensions(),
      attachments: store.listRealmExtensions(realm.id)
    });
    assert.deepStrictEqual(
      initialFlow.map((view) => [view.extensionId, view.reason, view.canInstall, view.canAttach]),
      [
        ['acme-scoring', 'not-installed', true, false],
        ['acme/text-tools', 'not-installed', true, false]
      ]
    );
    assert.strictEqual(initialFlow[0].authorComment, template.notes);
    assert.strictEqual(initialFlow[0].installPrefill.url, 'https://mcp.example.com');

    // Operator install (the dialog's store call), then the flow offers attach.
    const installed = store.installExtension({
      id: 'acme-scoring',
      kind: 'mcp',
      displayName: 'Acme Scoring',
      transportHint: { kind: 'http', url: 'https://mcp.example.com' },
      approvedUrl: 'https://mcp.example.com'
    });
    assert.strictEqual(installed.status, 'installed');
    assert.strictEqual(store.listExtensions().length, 1);

    const afterInstall = buildMissingExtensionFlowViews({
      missingExtensionIds: realm.instance.missingExtensions,
      template,
      installs: store.listExtensions(),
      attachments: store.listRealmExtensions(realm.id)
    });
    assert.deepStrictEqual(
      afterInstall.map((view) => [view.extensionId, view.canInstall, view.canAttach]),
      [['acme-scoring', false, true], ['acme/text-tools', true, false]]
    );

    // Operator attach with an explicit sanitized call-name selection.
    store.attachExtension(realm.id, 'acme-scoring', { toolSelection: ['similarity'] });
    const attachments = store.listRealmExtensions(realm.id);
    assert.deepStrictEqual(
      attachments.map((entry) => [entry.extensionId, entry.toolSelection, entry.status, entry.approvedBy]),
      [['acme-scoring', ['similarity'], 'active', 'operator']]
    );

    const afterAttach = buildMissingExtensionFlowViews({
      missingExtensionIds: realm.instance.missingExtensions,
      template,
      installs: store.listExtensions(),
      attachments
    }).filter((view) => view.state !== 'active');
    assert.deepStrictEqual(
      afterAttach.map((view) => [view.extensionId, view.state, view.reason]),
      [['acme/text-tools', 'not-installed', 'not-installed']],
      'the components filter resolved rows; the since-attached request drops out'
    );

    // The request views carry the live attachment state too.
    const requestViews = buildRealmExtensionRequestViews(template, store.listExtensions(), attachments);
    assert.deepStrictEqual(
      requestViews.requests.map((view) => [view.id, view.state, view.installed]),
      [['acme-scoring', 'active', true], ['acme/text-tools', 'not-installed', false]]
    );

    // A malformed selection on an installed, unattached extension fails closed
    // with the registry's own message and writes nothing.
    store.installExtension({
      id: 'acme-extra',
      kind: 'mcp',
      transportHint: { kind: 'http', url: 'https://extra.example.com' }
    });
    assert.throws(
      () => store.attachExtension(realm.id, 'acme-extra', { toolSelection: ['docs.search'] }),
      (err) => {
        assert.strictEqual(err.code, 'ERR_STORE_INVALID_PARAMS');
        assert.match(err.message, /sanitized call name/);
        return true;
      }
    );
    assert.deepStrictEqual(
      store.listRealmExtensions(realm.id).map((entry) => entry.extensionId),
      ['acme-scoring'],
      'a refused attach leaves the attachment list unchanged'
    );
    assert.strictEqual(store.removeExtension('acme-extra'), true);

    // Removal is refused while the Realm attaches the extension, and the
    // refusal copy carries the detach-first guidance.
    assert.throws(
      () => store.removeExtension('acme-scoring'),
      (err) => {
        assert.strictEqual(err.code, 'ERR_STORE_EXTENSION_ATTACHED');
        const copy = describeExtensionRemovalError(err);
        assert.match(copy, /still attached to 1 Realm\(s\)/);
        assert.match(copy, /Detach it from every Realm before removing the install record/);
        return true;
      }
    );
    assert.ok(store.getExtension('acme-scoring'), 'the refused removal changed nothing');

    // Detach, then the removal succeeds and the install record disappears.
    store.detachExtension(realm.id, 'acme-scoring');
    assert.deepStrictEqual(store.listRealmExtensions(realm.id), []);
    assert.strictEqual(store.removeExtension('acme-scoring'), true);
    assert.deepStrictEqual(store.listExtensions(), []);

    // A second launch with the explicit attach approval resolves and attaches.
    const approvedReceipt = await store.launchRealmFromTemplate(bundle.template.id, {
      name: 'Approved Realm',
      extensionApprovals: [{ extensionId: 'acme/text-tools' }]
    });
    assert.deepStrictEqual(
      approvedReceipt.realm.instance.missingExtensions,
      ['acme-scoring', 'acme/text-tools'],
      'approving an uninstalled request attaches nothing and stays disclosed'
    );
    assert.deepStrictEqual(store.listRealmExtensions(approvedReceipt.realm.id), []);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

test('21. provenance rows and the realm badge surface the recorded extension resolution', async () => {
  const record = realmWithProvenance({
    templateId: 'ui-template',
    templateVersion: 'sha256:abc',
    inputHashes: {},
    seedPaths: [],
    launchedAt: '2026-09-26T12:00:00.000Z',
    resolvedTools: { similarity: 'acme-scoring' },
    missingExtensions: ['acme/ghost']
  });
  const view = buildRealmProvenanceView(record);
  assert.strictEqual(view.visible, true);
  assert.deepStrictEqual(
    view.rows.map((row) => row.key),
    [
      'templateId',
      'templateVersion',
      'launchedAt',
      'resolvedTool:similarity',
      'missingExtension:acme/ghost'
    ],
    'extension rows append after the launch rows with collision-free keys'
  );
  assert.deepStrictEqual(
    view.rows.map((row) => [row.label, row.value]),
    [
      ['Template', 'ui-template'],
      ['Template version', 'sha256:abc'],
      ['Launched', '2026-09-26 12:00:00 UTC'],
      ['Resolved tool', 'similarity → acme-scoring'],
      ['Missing extension', 'acme/ghost']
    ]
  );
  assert.deepStrictEqual(view.resolvedTools, [{ callName: 'similarity', extensionId: 'acme-scoring' }]);
  assert.deepStrictEqual(view.missingExtensions, ['acme/ghost']);

  const indicator = describeRealmExtensionIndicator(record);
  assert.strictEqual(indicator.visible, true);
  assert.strictEqual(indicator.count, 1);
  assert.strictEqual(indicator.label, '1 missing');
  assert.match(indicator.title, /acme\/ghost/);
  assert.match(indicator.title, /Open Realm settings/);
  assert.strictEqual(describeRealmExtensionIndicator(realmWithProvenance({
    templateId: 'ui-template',
    templateVersion: 'sha256:abc',
    inputHashes: {},
    seedPaths: [],
    launchedAt: '2026-09-26T12:00:00.000Z'
  })).visible, false);
  assert.strictEqual(describeRealmExtensionIndicator(null).visible, false);
  assert.strictEqual(describeRealmExtensionIndicator({ instance: { missingExtensions: 'nope' } }).visible, false);

  // The same rows come out of a real launch that recorded a missing request.
  sharedLocalStorage.clear();
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    const bundle = uiExtensionBundle();
    store.importRealmTemplate(bundle);
    const receipt = await store.launchRealmFromTemplate(bundle.template.id, { name: 'Badge Realm' });
    const launched = buildRealmProvenanceView(store.getRealm(receipt.realm.id));
    assert.deepStrictEqual(
      launched.rows.filter((row) => row.key.startsWith('missingExtension:')).map((row) => row.value),
      ['acme-scoring', 'acme/text-tools']
    );
    assert.strictEqual(describeRealmExtensionIndicator(store.getRealm(receipt.realm.id)).count, 2);
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 22. Per-agent extension tuning (P2.4)
// ============================================================================

test('22. the per-agent extension tuning projection mirrors the store universe and toggles collapse to `all`', async () => {
  // (1) Pure projection: resolution + attachment filtering + selector state.
  const resolvedTools = { similarity: 'acme-scoring', docs_search: 'acme-docs' };
  const attachments = [
    { extensionId: 'acme-scoring', toolSelection: 'all', status: 'active', approvedAt: 'x', approvedBy: 'operator' },
    { extensionId: 'acme-docs', toolSelection: 'all', status: 'unavailable', approvedAt: 'x', approvedBy: 'operator' }
  ];
  const all = buildAgentExtensionTuningProjection({
    resolvedTools,
    attachments,
    selector: undefined,
    extensionLabels: { 'acme-scoring': 'Acme Scoring', 'acme-docs': 'Acme Docs' }
  });
  assert.deepStrictEqual(
    all.options.map((option) => [option.callName, option.extensionId, option.extensionLabel, option.enabled]),
    [['similarity', 'acme-scoring', 'Acme Scoring', true]],
    'only resolved-and-active tools render, enabled under the default selector'
  );
  assert.deepStrictEqual(
    [all.totalCount, all.selectedCount, all.allSelected, all.hasTools, all.label],
    [1, 1, true, true, 'All resolved extension tools']
  );

  const subset = buildAgentExtensionTuningProjection({
    resolvedTools: { similarity: 'acme-scoring', docs_search: 'acme-scoring' },
    attachments: [attachments[0]],
    selector: ['docs_search']
  });
  assert.deepStrictEqual(
    subset.options.map((option) => [option.callName, option.enabled]),
    [['similarity', false], ['docs_search', true]],
    'an explicit subset enables exactly its names'
  );
  assert.strictEqual(subset.label, '1 of 2 tools');
  assert.deepStrictEqual(subset.selector, ['docs_search']);

  const empty = buildAgentExtensionTuningProjection({ resolvedTools: null, attachments: null, selector: 'all' });
  assert.deepStrictEqual(
    [empty.totalCount, empty.hasTools, empty.label],
    [0, false, 'No extension tools resolved for this Realm.']
  );

  // (2) Toggles: disabling collapses to an explicit list; re-enabling every
  // tool collapses back to `'all'`; unknown names and no-ops keep the selector.
  const disabled = applyAgentExtensionToolToggle('all', 'similarity', false, resolvedTools, [attachments[0]]);
  assert.deepStrictEqual(disabled, []);
  const enabledAgain = applyAgentExtensionToolToggle(disabled, 'similarity', true, resolvedTools, [attachments[0]]);
  assert.strictEqual(enabledAgain, 'all', 'enabling the last tool collapses to the default');
  assert.deepStrictEqual(
    applyAgentExtensionToolToggle('all', 'ghost_tool', false, resolvedTools, [attachments[0]]),
    'all',
    'an unknown tool name is a no-op'
  );
  assert.strictEqual(
    applyAgentExtensionToolToggle('all', 'similarity', false, resolvedTools, [attachments[1]]),
    'all',
    'a detached/unsupported tool is not toggleable'
  );

  // (3) Store agreement: a real launch feeds the projection, and applying its
  // toggle through `updateAgentConfig` reauthorizes the descriptor.
  sharedLocalStorage.clear();
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({
    runtime,
    virtualFs: runtime.virtualFs,
    messagingBus: runtime.messagingBus,
    autoBootstrapDirector: false,
    autoHydrate: false
  });
  try {
    store.installExtension({
      id: 'acme-scoring',
      kind: 'mcp',
      displayName: 'Acme Scoring',
      transportHint: { kind: 'http', url: 'https://mcp.example.com' }
    });
    const bundle = uiExtensionBundle();
    store.importRealmTemplate(bundle);
    const receipt = await store.launchRealmFromTemplate(bundle.template.id, {
      name: 'Tuning Realm',
      extensionApprovals: [{ extensionId: 'acme-scoring' }]
    });
    const realm = store.getRealm(receipt.realm.id);
    const member = store.agents.find((agent) => agent.id === 'u-ext-observer');
    const tuning = buildAgentExtensionTuningProjection({
      resolvedTools: realm.instance?.resolvedTools,
      attachments: realm.extensions,
      selector: member.config.extensionTools,
      extensionLabels: { 'acme-scoring': 'Acme Scoring' }
    });
    assert.deepStrictEqual(tuning.options.map((option) => [option.callName, option.enabled]), [['similarity', true]]);

    const memberKey = createAgentIdentityKey(realm.id, 'u-ext-observer');
    const extensionsOf = () => [
      ...runtime.createAgentIdentityPort().getAgentIdentity('u-ext-observer', { realmId: realm.id }).authority.extensions
    ];
    assert.deepStrictEqual(extensionsOf(), ['similarity'], 'the launch grants the resolved tool');

    const next = applyAgentExtensionToolToggle(tuning.selector, 'similarity', false, realm.instance?.resolvedTools, realm.extensions);
    store.updateAgentConfig(memberKey, { extensionTools: next });
    assert.deepStrictEqual(store.agents.find((agent) => agent.id === 'u-ext-observer').config.extensionTools, []);
    assert.deepStrictEqual(extensionsOf(), [], 'the tuning edit reauthorizes the descriptor immediately for the idle member');

    store.updateAgentConfig(memberKey, { extensionTools: 'all' });
    assert.deepStrictEqual(extensionsOf(), ['similarity'], 'restoring the default re-grants the resolved tool');
  } finally {
    store.destroy();
    sharedLocalStorage.clear();
  }
});

// ============================================================================
// 23-26. Live extension surfaces (P3.4)
// ============================================================================

/**
 * Builds one global install-record fixture.
 *
 * @param {object} [overrides] - Record field overrides.
 * @returns {object} Structural install record.
 */
function extensionInstallFixture(overrides = {}) {
  return {
    id: 'acme-scoring',
    kind: 'mcp',
    displayName: 'Acme Scoring',
    transportHint: { kind: 'http', url: 'http://127.0.0.1:8791/mcp' },
    status: 'installed',
    installSource: 'operator',
    createdAt: 1758900000000,
    ...overrides
  };
}

/**
 * Builds one realm attachment fixture.
 *
 * @param {object} [overrides] - Attachment field overrides.
 * @returns {object} Structural attachment record.
 */
function extensionAttachmentFixture(overrides = {}) {
  return {
    extensionId: 'acme-scoring',
    toolSelection: 'all',
    status: 'active',
    approvedAt: '2026-09-26T12:00:00.000Z',
    approvedBy: 'operator',
    ...overrides
  };
}

/**
 * Builds one live connection projection fixture with a two-tool catalog:
 * `similarity` is clean, `flagged` carries benign metadata plus one semantic
 * constraint (`pattern`).
 *
 * @param {object} [overrides] - Projection field overrides.
 * @returns {object} Structural connection projection.
 */
function extensionConnectionFixture(overrides = {}) {
  return {
    extensionId: 'acme-scoring',
    status: 'connected',
    serverInfo: { name: 'acme-mcp', version: '1.2.3' },
    protocolVersion: '2025-06-18',
    catalog: {
      similarity: {
        extensionId: 'acme-scoring',
        serverToolName: 'similarity',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string', description: 'q' } },
          required: ['q'],
          additionalProperties: false
        }
      },
      flagged: {
        extensionId: 'acme-scoring',
        serverToolName: 'flagged',
        inputSchema: {
          type: 'object',
          title: 'Flag',
          properties: { p: { type: 'string', pattern: '^x', description: 'p' } },
          additionalProperties: false
        }
      }
    },
    shadows: [{ callName: 'dup', serverToolName: 'dup.two' }],
    conflicts: [],
    drift: null,
    error: null,
    connectedAt: 1758900000000,
    discoveredAt: 1758900060000,
    digest: 'sha256:abc',
    ...overrides
  };
}

test('23. connection views project status, server identity, catalog, fidelity, drift, and controls', () => {
  const record = extensionInstallFixture();
  assert.strictEqual(EXTENSION_THIRD_PARTY_LABEL, 'third-party — classification unknown');

  // Status vocabulary: disconnected carries no chip; every live state does.
  assert.deepStrictEqual(
    [describeExtensionConnectionStatus('disconnected').chip, describeExtensionConnectionStatus('disconnected').label],
    [false, 'Not connected']
  );
  assert.strictEqual(describeExtensionConnectionStatus('connected').chip, true);
  assert.match(describeExtensionConnectionStatus('conflict').description, /call names first/);

  // Error projection: typed code + fixed safe message + key=value details.
  const networkError = describeExtensionConnectionError({
    code: 'ERR_MCP_NETWORK',
    details: { kind: 'TypeError', retryable: true }
  });
  assert.strictEqual(networkError.code, 'ERR_MCP_NETWORK');
  assert.match(networkError.message, /network or CORS/);
  assert.deepStrictEqual(networkError.details, ['kind=TypeError', 'retryable=true']);
  assert.match(describeExtensionConnectionError({ code: 'ERR_CUSTOM' }).message, /typed code/);

  // Drift projection discloses the change classes.
  const drift = describeExtensionCatalogDrift({
    added: ['sse'], removed: ['old'], changed: ['similarity'], shadowedAdded: ['dup'],
    shadowedRemoved: [], reordered: true,
    digests: { previous: 'sha256:old', next: 'sha256:new' }
  });
  assert.strictEqual(drift.visible, true);
  assert.strictEqual(drift.summary, '+1 added · -1 removed · ~1 changed · +1 shadowed · order changed');
  assert.strictEqual(describeExtensionCatalogDrift(null).visible, false);

  // Connected view: identity, controls, catalog count/digest, fidelity, drift.
  const connection = extensionConnectionFixture({
    drift: {
      added: ['sse'], removed: [], changed: [], shadowedAdded: [], shadowedRemoved: [],
      reordered: false, digests: { previous: 'sha256:old', next: 'sha256:new' }
    }
  });
  const view = buildExtensionConnectionView(record, connection);
  assert.strictEqual(view.status.label, 'Connected');
  assert.deepStrictEqual(
    [view.canConnect, view.canDisconnect, view.canReconnect, view.controlsHint],
    [false, true, true, '']
  );
  assert.deepStrictEqual(
    [view.serverName, view.serverVersion, view.protocolVersion],
    ['acme-mcp', '1.2.3', '2025-06-18']
  );
  assert.deepStrictEqual([view.toolCount, view.digest], [2, 'sha256:abc']);
  assert.deepStrictEqual(view.shadows.map((shadow) => shadow.callName), ['dup']);
  assert.strictEqual(view.drift.visible, true);
  assert.match(formatExtensionConnectionTimestamp(1758900000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  assert.match(view.connectedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
  assert.strictEqual(formatExtensionConnectionTimestamp('nope'), '');
  assert.strictEqual(view.thirdPartyLabel, EXTENSION_THIRD_PARTY_LABEL);

  // Fidelity: the metadata-only `title` drop is additive; the `pattern` drop
  // is semantic — 1 of 2 tools semantic is exactly half, so `projected`.
  assert.deepStrictEqual(
    [view.fidelity.state, view.fidelity.badge, view.fidelity.total, view.fidelity.warned, view.fidelity.refused],
    ['projected', 'projected schemas', 2, 1, 0]
  );
  assert.ok(view.fidelity.warnings.some((warning) => (
    warning.callName === 'flagged' && warning.code === 'metadata-dropped' && warning.path === '#/title'
  )));
  assert.ok(view.fidelity.warnings.some((warning) => (
    warning.callName === 'flagged' && warning.code === 'keyword-dropped' && warning.path === '#/properties/p/pattern'
  )));

  // Degraded when more than half the tools need semantic projection.
  const degraded = buildExtensionCatalogFidelityView(extensionConnectionFixture({
    catalog: {
      a: { extensionId: 'acme-scoring', serverToolName: 'a', inputSchema: { type: 'object', properties: { p: { type: 'string', pattern: '^x', description: 'p' } }, additionalProperties: false } },
      b: { extensionId: 'acme-scoring', serverToolName: 'b', inputSchema: { type: 'object', properties: { p: { type: 'string', pattern: '^y', description: 'p' } }, additionalProperties: false } }
    }
  }));
  assert.deepStrictEqual([degraded.state, degraded.badge, degraded.total, degraded.refused], ['degraded', 'degraded schema fidelity', 2, 0]);

  // Disconnected: no live chip, no catalog, connect applies.
  const offline = buildExtensionConnectionView(record, null);
  assert.deepStrictEqual(
    [offline.status.chip, offline.toolCount, offline.fidelity, offline.canConnect, offline.canDisconnect],
    [false, 0, null, true, false]
  );
  assert.match(offline.status.label, /Not connected/);

  // stdio/pack records never offer connect controls.
  const stdio = buildExtensionConnectionView(
    extensionInstallFixture({ transportHint: { kind: 'stdio', command: 'npx' } }),
    null
  );
  assert.strictEqual(stdio.canConnect, false);
  assert.match(stdio.controlsHint, /host-only/);
  const pack = buildExtensionConnectionView(extensionInstallFixture({ kind: 'pack', transportHint: { kind: 'pack', source: 'acme/pack' } }), null);
  assert.strictEqual(pack.canConnect, false);
  assert.match(pack.controlsHint, /Tool packs/);

  // A connection error keeps the view's safe typed disclosure.
  const failed = buildExtensionConnectionView(record, extensionConnectionFixture({
    status: 'error',
    catalog: null,
    serverInfo: null,
    protocolVersion: null,
    digest: null,
    error: { code: 'ERR_MCP_TIMEOUT' }
  }));
  assert.deepStrictEqual([failed.status.label, failed.error.code], ['Error', 'ERR_MCP_TIMEOUT']);
  assert.deepStrictEqual([failed.canConnect, failed.canDisconnect, failed.canReconnect], [true, true, true]);

  // The list projection follows install order and joins by id.
  const views = buildExtensionConnectionViews({
    installs: [record, extensionInstallFixture({ id: 'acme-docs', displayName: 'Acme Docs' })],
    connections: [connection]
  });
  assert.deepStrictEqual(views.map((entry) => [entry.extensionId, entry.status.label]), [
    ['acme-scoring', 'Connected'],
    ['acme-docs', 'Not connected']
  ]);
});

test('24. Realm attachment views reflect live state, ceiling, and conflict winners', () => {
  const scoring = extensionAttachmentFixture({ toolSelection: ['similarity'] });
  const ceiling = buildRealmAttachmentCeilingView(scoring, extensionConnectionFixture());
  assert.deepStrictEqual(
    [ceiling.mode, ceiling.hasLiveCatalog, ceiling.effectiveNames, ceiling.excludedNames],
    ['selection', true, ['similarity'], ['flagged']],
    'the realm selection caps the live catalog contribution'
  );
  assert.match(ceiling.summary, /1 of 2 live tools selected/);
  assert.match(ceiling.summary, /1 excluded by the Realm ceiling/);

  const allCeiling = buildRealmAttachmentCeilingView(extensionAttachmentFixture(), null);
  assert.deepStrictEqual(
    [allCeiling.mode, allCeiling.hasLiveCatalog, allCeiling.effectiveNames],
    ['all', false, []]
  );
  assert.match(allCeiling.summary, /no live catalog yet/);

  const conflictConnection = extensionConnectionFixture({
    status: 'conflict',
    conflicts: [{ callName: 'similarity', otherExtensionId: 'zzz-winner' }]
  });
  const views = buildRealmExtensionAttachmentViews({
    attachments: [
      scoring,
      extensionAttachmentFixture({ extensionId: 'acme-docs' }),
      extensionAttachmentFixture({ extensionId: 'gone', status: 'unavailable' })
    ],
    connections: [conflictConnection],
    installs: [extensionInstallFixture(), extensionInstallFixture({ id: 'acme-docs' }), extensionInstallFixture({ id: 'gone' })],
    labels: { 'zzz-winner': 'Winner Server' }
  });
  assert.deepStrictEqual(views.map((entry) => [entry.extensionId, entry.state, entry.stateLabel]), [
    ['acme-scoring', 'conflict', 'Conflict'],
    ['acme-docs', 'active', 'Active'],
    ['gone', 'unavailable', 'Unavailable']
  ]);
  assert.deepStrictEqual(views[0].conflicts, [{ callName: 'similarity', otherExtensionId: 'zzz-winner', otherLabel: 'Winner Server' }]);
  assert.deepStrictEqual([views[0].canDisconnect, views[0].canReconnect], [true, true]);
  assert.match(views[1].stateDescription, /not connected/);
  assert.deepStrictEqual([views[1].toolCount, views[1].fidelity ?? null], [0, null]);

  const liveView = buildRealmExtensionAttachmentViews({
    attachments: [extensionAttachmentFixture()],
    connections: [extensionConnectionFixture()],
    installs: [extensionInstallFixture()]
  })[0];
  assert.deepStrictEqual([liveView.state, liveView.live.label, liveView.toolCount, liveView.digest], ['active', 'Connected', 2, 'sha256:abc']);
  assert.strictEqual(liveView.label, 'Acme Scoring');
});

test('25. the live agent tuning projection mirrors the store universe and narrows by the ceiling', () => {
  const attachments = [
    extensionAttachmentFixture(),
    extensionAttachmentFixture({ extensionId: 'acme-docs', toolSelection: ['docs_search'] })
  ];
  const connections = [
    extensionConnectionFixture(),
    extensionConnectionFixture({ extensionId: 'acme-docs', status: 'conflict', conflicts: [{ callName: 'docs_search', otherExtensionId: 'zzz' }] })
  ];
  const projection = buildAgentLiveExtensionTuningProjection({
    resolvedTools: { similarity: 'acme-scoring', ghost_call: 'ghost' },
    attachments,
    connections,
    selector: 'all',
    extensionLabels: { 'acme-scoring': 'Acme Scoring', 'acme-docs': 'Acme Docs' }
  });
  assert.deepStrictEqual(
    projection.options.map((option) => [option.callName, option.extensionId, option.enabled, option.source]),
    [
      ['similarity', 'acme-scoring', true, 'resolved'],
      ['flagged', 'acme-scoring', true, 'catalog']
    ],
    'persisted names come first, live catalog names follow, inactive/absent extensions drop'
  );
  assert.deepStrictEqual([projection.totalCount, projection.selectedCount, projection.hasTools, projection.label], [2, 2, true, 'All realm extension tools (ceiling)']);
  assert.match(projection.ceilingHint, /ceiling/);
  assert.deepStrictEqual(
    projection.unavailableAttachments.map((entry) => [entry.extensionId, entry.reason]),
    [['acme-docs', 'conflict']],
    'an attachment without a live conflict-free catalog is marked unavailable'
  );
  assert.deepStrictEqual(projection.callNames, ['similarity', 'flagged']);

  // A restricted selector can only narrow the ceiling: unknown names are
  // dropped from the toggle universe and stay disabled.
  const subset = buildAgentLiveExtensionTuningProjection({
    resolvedTools: { similarity: 'acme-scoring' },
    attachments,
    connections,
    selector: ['docs_search', 'flagged']
  });
  assert.deepStrictEqual(
    subset.options.map((option) => [option.callName, option.enabled]),
    [['similarity', false], ['flagged', true]]
  );
  assert.strictEqual(subset.label, '1 of 2 tools');
  const toggled = applyAgentExtensionSelectorToggle('all', 'flagged', false, projection.callNames);
  assert.deepStrictEqual(toggled, ['similarity']);
  assert.strictEqual(applyAgentExtensionSelectorToggle(toggled, 'flagged', true, projection.callNames), 'all');
  assert.deepStrictEqual(applyAgentExtensionSelectorToggle('all', 'docs_search', false, projection.callNames), 'all');

  // The attachment ceiling caps the live contribution.
  const capped = buildAgentLiveExtensionTuningProjection({
    resolvedTools: null,
    attachments: [extensionAttachmentFixture({ toolSelection: ['similarity'] })],
    connections: [extensionConnectionFixture()],
    selector: 'all'
  });
  assert.deepStrictEqual(capped.callNames, ['similarity'], 'a connect never widens the realm selection');

  // Not-connected marker carries guidance; no attachments means no universe.
  const idle = buildAgentLiveExtensionTuningProjection({
    resolvedTools: null,
    attachments: [extensionAttachmentFixture()],
    connections: [],
    selector: 'all'
  });
  assert.deepStrictEqual([idle.totalCount, idle.hasTools, idle.label], [0, false, 'No extension tools available in this Realm.']);
  assert.deepStrictEqual(idle.unavailableAttachments.map((entry) => entry.reason), ['not-connected']);
  assert.deepStrictEqual(
    buildAgentLiveExtensionTuningProjection({ resolvedTools: null, attachments: null, connections: null }).options,
    []
  );
});

test('26. review disclosures carry third-party labels, live fidelity, and realm-card live state', () => {
  const template = {
    id: 'ui-template',
    name: 'UI Template',
    description: '',
    formatVersion: 2,
    providers: [
      { kind: 'mcp', id: 'acme-scoring', transport: { kind: 'http', url: 'http://127.0.0.1:8791/mcp' } }
    ],
    agents: []
  };
  const installs = [extensionInstallFixture()];
  const attachments = [extensionAttachmentFixture()];

  // Connected: third-party label, live count, and fidelity badge render; no
  // "not connected" disclosure.
  const connectedViews = buildRealmExtensionRequestViews(template, installs, attachments, [extensionConnectionFixture()]);
  const connected = connectedViews.requests[0];
  assert.strictEqual(connected.thirdPartyLabel, EXTENSION_THIRD_PARTY_LABEL);
  assert.deepStrictEqual([connected.connected, connected.liveToolCount, connected.fidelityBadge, connected.disclosure], [true, 2, 'projected schemas', '']);

  // Installed but not connected: explicit requested-but-not-connected copy.
  const idle = buildRealmExtensionRequestViews(template, installs, attachments, []).requests[0];
  assert.strictEqual(idle.connected, false);
  assert.match(idle.disclosure, /not connected/);

  // Failed connection: the typed code is disclosed.
  const failed = buildRealmExtensionRequestViews(template, installs, attachments, [
    extensionConnectionFixture({ status: 'error', catalog: null, error: { code: 'ERR_MCP_AUTH' } })
  ]).requests[0];
  assert.match(failed.disclosure, /ERR_MCP_AUTH/);

  // Realm-card live indicator: live/conflict/idle split + third-party tooltip.
  const indicator = describeRealmExtensionLiveIndicator({
    attachments: [
      extensionAttachmentFixture(),
      extensionAttachmentFixture({ extensionId: 'acme-docs' }),
      extensionAttachmentFixture({ extensionId: 'acme-extra' }),
      extensionAttachmentFixture({ extensionId: 'acme-idle' })
    ],
    connections: [
      extensionConnectionFixture(),
      extensionConnectionFixture({ extensionId: 'acme-docs' }),
      extensionConnectionFixture({ extensionId: 'acme-extra', status: 'conflict', conflicts: [{ callName: 'x', otherExtensionId: 'zzz' }] })
    ],
    labels: { 'acme-docs': 'Acme Docs' }
  });
  assert.deepStrictEqual(
    [indicator.visible, indicator.connectedCount, indicator.conflictCount, indicator.notConnectedCount],
    [true, 2, 1, 1]
  );
  assert.strictEqual(indicator.label, '2 live · 1 conflict · 1 not connected');
  assert.match(indicator.title, /third-party — classification unknown/);
  assert.match(indicator.title, /Acme Docs/);
  assert.strictEqual(describeRealmExtensionLiveIndicator({ attachments: [], connections: [extensionConnectionFixture()] }).visible, false);

  // Missing-flow rows carry the third-party label too.
  const flow = buildMissingExtensionFlowViews({
    missingExtensionIds: ['acme-scoring'],
    template,
    installs: [],
    attachments: []
  });
  assert.strictEqual(flow[0].thirdPartyLabel, EXTENSION_THIRD_PARTY_LABEL);
});

test('27. the attach-editor ceiling model keeps state-accurate copy per selection (ticket 9472417)', () => {
  const connection = extensionConnectionFixture();

  // No extension picked yet: the editor must never claim a live catalog is
  // missing — the ticket repro showed exactly that claim while an attached
  // extension's catalog was live.
  const unselected = describeRealmAttachCeilingEditor({ extensionId: '', connections: [connection] });
  assert.deepStrictEqual(
    [unselected.state, unselected.showLiveCatalog, unselected.catalogNames],
    ['no-selection', false, []]
  );
  assert.doesNotMatch(unselected.allToolsHint, /No live catalog is connected yet/);
  assert.doesNotMatch(unselected.customNamesHint, /No live catalog is connected yet/);
  assert.match(unselected.allToolsHint, /Choose an extension/);

  // Selected + live conflict-free catalog: the checkbox editor applies and
  // carries the catalog names in catalog order.
  const live = describeRealmAttachCeilingEditor({ extensionId: 'acme-scoring', connections: [connection] });
  assert.deepStrictEqual(
    [live.state, live.showLiveCatalog, live.catalogNames],
    ['live-catalog', true, ['similarity', 'flagged']]
  );

  // Selected with no live session: the legitimate recording-for-later-connect
  // copy stays verbatim.
  const offline = describeRealmAttachCeilingEditor({ extensionId: 'acme-scoring', connections: [] });
  assert.deepStrictEqual(
    [offline.state, offline.showLiveCatalog, offline.catalogNames],
    ['no-live-catalog', false, []]
  );
  assert.strictEqual(
    offline.allToolsHint,
    'No live catalog is connected yet — the ceiling stays "all tools" until a connect.'
  );
  assert.strictEqual(
    offline.customNamesHint,
    'Sanitized model-facing call names (the derived form), comma-separated. No live catalog is connected yet, '
      + 'so names are recorded as the ceiling for a later connect.'
  );

  // A connecting/errored/conflicting session still counts as no live catalog.
  for (const status of ['connecting', 'error', 'conflict']) {
    const busy = describeRealmAttachCeilingEditor({
      extensionId: 'acme-scoring',
      connections: [extensionConnectionFixture({
        status,
        ...(status === 'conflict'
          ? { conflicts: [{ callName: 'similarity', otherExtensionId: 'zzz-winner' }] }
          : {})
      })]
    });
    assert.deepStrictEqual([busy.state, busy.showLiveCatalog], ['no-live-catalog', false], status);
  }

  // A connected catalog that lists no tools is still connected: never the
  // stale claim, and not the checkbox editor either.
  const empty = describeRealmAttachCeilingEditor({
    extensionId: 'acme-scoring',
    connections: [extensionConnectionFixture({ catalog: {} })]
  });
  assert.deepStrictEqual(
    [empty.state, empty.showLiveCatalog, empty.catalogNames],
    ['empty-live-catalog', false, []]
  );
  assert.match(empty.allToolsHint, /lists no tools/);
  assert.doesNotMatch(empty.allToolsHint, /No live catalog is connected yet/);
  assert.doesNotMatch(empty.customNamesHint, /No live catalog is connected yet/);

  // Another extension's live connection never leaks into this selection.
  const other = describeRealmAttachCeilingEditor({
    extensionId: 'acme-docs',
    connections: [
      connection,
      extensionConnectionFixture({ extensionId: 'acme-docs', status: 'error', catalog: null, error: { code: 'ERR_MCP_TIMEOUT' } })
    ]
  });
  assert.deepStrictEqual([other.state, other.showLiveCatalog], ['no-live-catalog', false]);

  // A connected projection still carrying conflicts stays out of the editor
  // (defense in depth: the connected status alone never lights a ceiling).
  const conflicted = describeRealmAttachCeilingEditor({
    extensionId: 'acme-scoring',
    connections: [extensionConnectionFixture({
      status: 'connected',
      conflicts: [{ callName: 'similarity', otherExtensionId: 'zzz-winner' }]
    })]
  });
  assert.deepStrictEqual([conflicted.state, conflicted.showLiveCatalog], ['no-live-catalog', false]);

  // Missing/invalid options read as no selection (structural guard).
  const bare = describeRealmAttachCeilingEditor();
  assert.deepStrictEqual([bare.state, bare.showLiveCatalog, bare.catalogNames], ['no-selection', false, []]);
});
