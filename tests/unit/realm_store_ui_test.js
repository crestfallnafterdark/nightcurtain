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
  groupAgentsByRealm,
  isDirectorAgent,
  resolveAgentRealmId,
  safeRealmColor
} from '../../src/lib/components/sandbox/realmGroups.ts';
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
import { buildRealmInputDrafts } from '../../src/lib/components/sandbox/realmLauncherHelpers.ts';
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
  buildRealmReviewInputValues,
  describeRealmAuthorityTrust,
  previewRealmReviewPackage,
  resolveRealmReviewInputDisplay
} from '../../src/lib/components/sandbox/realmReviewHelpers.ts';
import {
  createSandboxStore,
  REALM_TEMPLATE_IMPORT_MAX_BUNDLE_BYTES
} from '../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { createAgentIdentityKey } from '../../src/lib/sandbox/runtime/index.ts';
import {
  DEMO_TEMPLATE,
  serializeTemplateBundle,
  templateBundleVersion
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
    const demoBundle = store.getRealmTemplateBundle(DEMO_TEMPLATE.id);
    assert.strictEqual(
      demoEntry.templateVersion,
      templateBundleVersion(demoBundle),
      'the label carries the effective bundle content version'
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
    assert.strictEqual(restored.templateVersion, templateBundleVersion(demoBundle));
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
      templateBundleVersion(store.getRealmTemplateBundle(DEMO_TEMPLATE.id)),
      'the panel shows the effective bundle version the launch recorded'
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
    const version = templateBundleVersion(effective);

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

    // Review projections resolve inputs and file slots from the candidate.
    const drafts = buildRealmInputDrafts(effective.template.inputs, effective.files);
    assert.deepStrictEqual(buildRealmReviewInputValues(drafts, candidate.payload), { topic: 'Tides' });
    assert.strictEqual(resolveRealmReviewInputDisplay(drafts[0], candidate.payload), 'Tides');
    const slots = buildRealmReviewFileSlots(effective.template, effective.files, { payload: candidate.payload });
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
    const preview = previewRealmReviewPackage(effective.template, assembly.package, { currentVersion: version });
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
