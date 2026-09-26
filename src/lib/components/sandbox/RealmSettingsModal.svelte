<script>
  /**
   * Realm Manager modal (Wave A, ticket d13a038; Wave R, ticket 56ba4b9;
   * realm manager redesign, ticket ca33e1b): create, rename, recolor,
   * describe, inspect members, and delete Realms.
   *
   * Redesign decomposition (ticket ca33e1b): the modal is the composition root
   * of a master–detail layout that scales with the realm count — a fixed-
   * height, searchable realm rail on the left and one Realm's detail pane on
   * the right. The dialog no longer grows with the registry; the rail scrolls
   * inside itself and the detail shows one Realm at a time. Sections render
   * through focused subcomponents under this folder:
   * `RealmManagerList` (search + selectable realm rows), `RealmManagerCreateForm`
   * (create + duplicate-name guard),
   * `RealmManagerSettingsCard` (rename/recolor/describe),
   * `RealmManagerProvenanceCard` (launch provenance + rehydrate entry),
   * `RealmManagerExtensionsPanel` (attachments, attach editor, missing flow),
   * `RealmManagerMembersCard` (active + recycled members),
   * `RealmManagerFsCard` (read-only workspace partitions), and
   * `RealmManagerDangerCard` (deletion semantics). Shared styles live in
   * `realmManagerUi.css`, scoped under `.realm-modal`.
   *
   * The root owns the store calls (create/save/delete), the selection, the
   * banners, and the modal shell; the row/detail projections live in
   * `realmManagerHelpers.ts` so they are unit-testable without a DOM.
   *
   * The create form rejects a name already carried by a registered record
   * through the launcher's shared duplicate-name guard (ticket b309e02), so
   * both creation surfaces behave the same (names stay unique in the UI even
   * though the registry identity is the generated id).
   *
   * Realm membership is immutable (Wave R): the modal never moves an agent in
   * or out of a Realm — changing realms means terminate + relaunch, and the
   * member list is read-only.
   *
   * Delete semantics (Wave R): the default delete refuses a Realm that still
   * has active or recycled members ("terminate or delete members first") and
   * offers the explicit recursive override, which permanently purges those
   * members before removing the record. The seeded Generic realm is always
   * refused. `describeRealmDeletion` (realmGroups.ts) is the pure copy model
   * behind the dialog.
   */
  import './realmManagerUi.css';
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { isRealmNameTaken } from './realmLauncherHelpers.ts';
  import { describeRealmDeletion, selectRealmMembers } from './realmGroups.ts';
  import {
    buildRealmManagerEntries,
    describeRealmManagerError,
    resolveRealmManagerSelection
  } from './realmManagerHelpers.ts';
  import RealmManagerList from './RealmManagerList.svelte';
  import RealmManagerCreateForm from './RealmManagerCreateForm.svelte';
  import RealmManagerSettingsCard from './RealmManagerSettingsCard.svelte';
  import RealmManagerProvenanceCard from './RealmManagerProvenanceCard.svelte';
  import RealmManagerExtensionsPanel from './RealmManagerExtensionsPanel.svelte';
  import RealmManagerMembersCard from './RealmManagerMembersCard.svelte';
  import RealmManagerFsCard from './RealmManagerFsCard.svelte';
  import RealmManagerDangerCard from './RealmManagerDangerCard.svelte';

  let { onclose = () => {}, realmId = null, onlaunchtemplate = () => {}, onrehydrate = () => {} } = $props();

  let realms = $derived(sandboxStore.realms);
  // Selection is derived: an explicit operator choice wins, then the optional
  // launch-target prop, then the first registered record. Deletion simply
  // invalidates the choice and the fallback re-selects.
  let requestedRealmId = $state('');
  let selectedRealmId = $derived(resolveRealmManagerSelection(realms, requestedRealmId, realmId));
  let selectedRealm = $derived(realms.find((realm) => realm.id === selectedRealmId) || null);

  // Master-list projection: one entry per Realm with trim-consistent member
  // counts (defect 7368e98) and the recorded missing-extension badge.
  let entries = $derived(buildRealmManagerEntries(realms, sandboxStore.agents, sandboxStore.recycleBin));

  let query = $state('');
  let validationError = $state('');
  let notice = $state('');
  let creatingRealm = $state(false);
  let modalRef = $state(/** @type {HTMLDivElement | null} */(null));

  // Delete confirmation state lives here, not in the danger card: Escape backs
  // out an armed confirmation before it closes the dialog.
  let deleteConfirming = $state(false);
  let deleteRecursive = $state(false);
  let isSubmitting = $state(false);

  let activeMembers = $derived(
    selectedRealm ? selectRealmMembers(sandboxStore.agents, selectedRealm.id) : []
  );
  let recycledMembers = $derived(
    selectedRealm ? selectRealmMembers(sandboxStore.recycleBin, selectedRealm.id) : []
  );
  // Wave R deletion model: default refusal while members exist, explicit
  // recursive override, Generic protected (pure copy from realmGroups.ts).
  let deletePlan = $derived(
    describeRealmDeletion(selectedRealm, {
      active: activeMembers.length,
      recycled: recycledMembers.length
    })
  );

  // A selection change disarms any pending deletion; the create panel stays as
  // the operator left it.
  $effect(() => {
    void selectedRealmId;
    deleteConfirming = false;
    deleteRecursive = false;
  });

  /** Clears both inline banners. */
  function clearMessages() {
    validationError = '';
    notice = '';
  }

  /**
   * Selects one Realm from the master list and clears stale banners.
   *
   * @param {string} realmId - Selected Realm id.
   */
  function handleSelectRealm(realmId) {
    requestedRealmId = realmId;
    clearMessages();
  }

  /**
   * Creates one Realm record (the create form already ran the shared
   * duplicate-name guard; the root re-checks fail-closed).
   *
   * @param {{ name?: unknown, description?: unknown, color?: unknown }} input - Create draft.
   * @returns {boolean} True when the record was created.
   */
  function handleCreate(input) {
    clearMessages();
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) {
      validationError = 'A Realm name is required.';
      return false;
    }
    if (isRealmNameTaken(name, realms)) {
      validationError = `A Realm named "${name}" already exists — pick a different name.`;
      return false;
    }
    const color = typeof input?.color === 'string' && input.color ? input.color : undefined;
    const description = typeof input?.description === 'string' ? input.description.trim() : '';
    try {
      const created = sandboxStore.createRealm({
        name,
        color,
        description: description || undefined
      });
      requestedRealmId = created.id;
      notice = `Realm "${created.name}" created.`;
      return true;
    } catch (err) {
      validationError = describeRealmManagerError(err, 'Failed to create the Realm.');
      return false;
    }
  }

  /**
   * Creates from the rail form and collapses the form on success.
   *
   * @param {{ name?: unknown, description?: unknown, color?: unknown }} input - Create draft.
   * @returns {boolean} True when the record was created.
   */
  function handleCreateFromForm(input) {
    const created = handleCreate(input);
    if (created) creatingRealm = false;
    return created;
  }

  /**
   * Saves the selected Realm's settings draft.
   *
   * @param {{ name?: unknown, description?: unknown, color?: unknown }} input - Edit draft.
   * @returns {boolean} True when the record was saved.
   */
  function handleSave(input) {
    if (!selectedRealm) return false;
    clearMessages();
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    if (!name) {
      validationError = 'A Realm name is required.';
      return false;
    }
    const description = typeof input?.description === 'string' ? input.description.trim() : '';
    const color = typeof input?.color === 'string' ? input.color : '';
    try {
      sandboxStore.updateRealm(selectedRealm.id, {
        name,
        description: description || null,
        color: color || null
      });
      notice = 'Realm settings saved.';
      return true;
    } catch (err) {
      validationError = describeRealmManagerError(err, 'Failed to save the Realm settings.');
      return false;
    }
  }

  /** Arms the inline delete confirmation. */
  function handleBeginDelete() {
    clearMessages();
    deleteConfirming = true;
  }

  /** Disarms the inline delete confirmation. */
  function handleCancelDelete() {
    deleteConfirming = false;
    deleteRecursive = false;
  }

  /**
   * Confirms the armed deletion with the selected mode. The default refuses a
   * member-bearing Realm; the recursive override purges its members first.
   */
  function handleConfirmDelete() {
    if (!selectedRealm || !deleteConfirming) return;
    clearMessages();
    const realmName = selectedRealm.name;
    const recursive = deleteRecursive && deletePlan.requiresRecursive;
    const memberCount = deletePlan.memberCount;
    isSubmitting = true;
    try {
      sandboxStore.deleteRealm(selectedRealm.id, recursive ? { recursive: true } : {});
      deleteConfirming = false;
      deleteRecursive = false;
      requestedRealmId = '';
      notice = recursive
        ? `Realm "${realmName}" deleted — ${memberCount} ${memberCount === 1 ? 'member was' : 'members were'} permanently deleted.`
        : `Realm "${realmName}" deleted.`;
    } catch (err) {
      validationError = describeRealmManagerError(err, 'Failed to delete the Realm.');
    } finally {
      isSubmitting = false;
    }
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onclose();
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      if (deleteConfirming) {
        deleteConfirming = false;
        return;
      }
      onclose();
      return;
    }
    if (e.key === 'Tab' && modalRef) {
      const focusable = modalRef.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = /** @type {HTMLElement} */ (focusable[0]);
      const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1]);
      if (e.shiftKey) {
        if (document.activeElement === first || !modalRef.contains(document.activeElement)) {
          last.focus();
          e.preventDefault();
        }
      } else if (document.activeElement === last || !modalRef.contains(document.activeElement)) {
        first.focus();
        e.preventDefault();
      }
    }
  }
</script>

<div
  class="modal-backdrop"
  role="presentation"
  tabindex="-1"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
>
  <div bind:this={modalRef} class="realm-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="realm-modal-title">
    <div class="modal-header">
      <div class="header-left">
        <div class="icon-chip">
          <svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="12 2 2 7 12 12 22 7 12 2" />
            <polyline points="2 17 12 22 22 17" />
            <polyline points="2 12 12 17 22 12" />
          </svg>
        </div>
        <div>
          <h2 id="realm-modal-title" class="modal-title">Realm Manager</h2>
          <p class="modal-sub">Isolated agent Realms; membership is fixed at launch</p>
        </div>
      </div>
      <button type="button" class="btn-close" onclick={() => onclose()} aria-label="Close modal">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    {#if validationError}
      <div class="error-banner" role="alert">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{validationError}</span>
      </div>
    {/if}
    {#if notice}
      <div class="notice-banner" role="status">
        <span>{notice}</span>
      </div>
    {/if}

    <div class="realm-manager-body">
      <aside class="realm-manager-rail">
        <RealmManagerList
          entries={entries}
          selectedId={selectedRealmId}
          query={query}
          onquery={(value) => (query = value)}
          onselect={handleSelectRealm}
        />
        {#if creatingRealm || realms.length === 0}
          <RealmManagerCreateForm
            realms={realms}
            oncreate={handleCreateFromForm}
            oncancel={realms.length > 0 ? () => (creatingRealm = false) : null}
            onlaunchtemplate={() => onlaunchtemplate()}
          />
        {:else}
          <button type="button" class="btn-secondary create-toggle" onclick={() => (creatingRealm = true)}>
            + New Realm…
          </button>
        {/if}
      </aside>

      <section
        class="realm-manager-detail"
        role={selectedRealm ? 'tabpanel' : undefined}
        aria-labelledby={selectedRealm ? `realm-tab-${selectedRealm.id}` : undefined}
      >
        {#if selectedRealm}
          <RealmManagerSettingsCard realm={selectedRealm} onsave={handleSave} />
          <RealmManagerProvenanceCard realm={selectedRealm} onrehydrate={(realm) => onrehydrate(realm)} />
          {#key selectedRealm.id}
            <RealmManagerExtensionsPanel realm={selectedRealm} />
          {/key}
          <RealmManagerMembersCard activeMembers={activeMembers} recycledMembers={recycledMembers} />
          <RealmManagerFsCard realm={selectedRealm} />
          <RealmManagerDangerCard
            plan={deletePlan}
            confirming={deleteConfirming}
            recursive={deleteRecursive}
            submitting={isSubmitting}
            onbegin={handleBeginDelete}
            oncancel={handleCancelDelete}
            ontoggle={(checked) => (deleteRecursive = checked)}
            onconfirm={handleConfirmDelete}
          />
        {:else}
          <div class="empty-realms">
            <p>No Realms yet. Create one with “New Realm…” on the left, then launch agents into it from the launcher.</p>
          </div>
        {/if}
      </section>
    </div>

    <div class="modal-footer">
      <button type="button" class="btn-secondary" onclick={() => onclose()}>Close</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(12, 13, 14, 0.85);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1.5rem;
    animation: fade-in 0.2s ease-out;
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }
</style>
