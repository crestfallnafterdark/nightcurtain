<script>
  /**
   * Realm Manager modal (Wave A, ticket d13a038; Wave R, ticket 56ba4b9):
   * create, rename, recolor, describe, inspect members, and delete Realms.
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
  import { sandboxStore, GENERIC_REALM_ID } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { isRealmNameTaken } from './realmLauncherHelpers.ts';
  import { buildRealmProvenanceView } from './realmTemplateHelpers.ts';
  import { buildRealmProvenanceDetailView } from './realmHydrationHelpers.ts';
  import { describeRealmDeletion, safeRealmColor } from './realmGroups.ts';

  let { onclose = () => {}, realmId = null, onlaunchtemplate = () => {}, onrehydrate = () => {} } = $props();

  let realms = $derived(sandboxStore.realms);
  // Selection is derived: an explicit operator choice wins, then the optional
  // launch-target prop, then the first registered record. Deletion simply
  // invalidates the choice and the fallback re-selects.
  let requestedRealmId = $state('');
  let selectedRealmId = $derived(
    requestedRealmId && realms.some((realm) => realm.id === requestedRealmId)
      ? requestedRealmId
      : (typeof realmId === 'string' && realmId && realms.some((realm) => realm.id === realmId)
        ? realmId
        : (realms.length > 0 ? realms[0].id : ''))
  );
  let validationError = $state('');
  let notice = $state('');

  // Creation draft
  let newName = $state('');
  let newDescription = $state('');
  let newColor = $state('#7c9cff');

  // Selected-realm edit draft
  let draftName = $state('');
  let draftDescription = $state('');
  let draftColor = $state('#7c9cff');

  let deleteConfirming = $state(false);
  let deleteRecursive = $state(false);
  let isSubmitting = $state(false);
  let modalRef = $state(/** @type {HTMLDivElement | null} */(null));

  let selectedRealm = $derived(realms.find((realm) => realm.id === selectedRealmId) || null);
  // Launch provenance panel (Wave T): reads RealmRecord.instance; a record
  // without a valid provenance block renders nothing.
  let provenance = $derived(buildRealmProvenanceView(selectedRealm));
  // Provenance detail (ticket 874182b): per-input hashes and seeded paths
  // recorded at launch — hashes and paths only, never raw values.
  let provenanceDetail = $derived(buildRealmProvenanceDetailView(selectedRealm));
  let activeMembers = $derived(
    selectedRealm ? sandboxStore.agents.filter((agent) => agent.config?.realmId === selectedRealm.id) : []
  );
  let recycledMembers = $derived(
    selectedRealm ? sandboxStore.recycleBin.filter((agent) => agent.config?.realmId === selectedRealm.id) : []
  );
  let accent = $derived(selectedRealm ? safeRealmColor(selectedRealm.color) : null);
  // Wave R deletion model: default refusal while members exist, explicit
  // recursive override, Generic protected (pure copy from realmGroups.ts).
  let deletePlan = $derived(
    describeRealmDeletion(selectedRealm, {
      active: activeMembers.length,
      recycled: recycledMembers.length
    })
  );
  let isGenericRealm = $derived(selectedRealm?.id === GENERIC_REALM_ID);

  // Seed the edit draft from the selected record; reseeded after each save.
  $effect(() => {
    const realm = selectedRealm;
    if (!realm) return;
    draftName = realm.name;
    draftDescription = realm.description ?? '';
    draftColor = safeRealmColor(realm.color) ?? '#7c9cff';
    deleteConfirming = false;
    deleteRecursive = false;
  });

  function clearMessages() {
    validationError = '';
    notice = '';
  }

  /**
   * Resolves a thrown store error into a user-facing message.
   *
   * @param {unknown} err - Thrown value.
   * @param {string} fallback - Fallback text.
   * @returns {string} User-facing message.
   */
  function errorText(err, fallback) {
    const message = err instanceof Error ? err.message : '';
    if (!message) return fallback;
    if (message.includes('PERMISSION_DENIED') || /permission denied/i.test(message)) {
      return 'The operator (Director) principal is required for that Realm action. Reload with the Director registered and retry.';
    }
    return message;
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

  function handleCreate(e) {
    e.preventDefault();
    clearMessages();
    const name = newName.trim();
    if (!name) {
      validationError = 'A Realm name is required.';
      return;
    }
    // The launcher wizard and this manager share one duplicate-name guard
    // (trimmed, case-insensitive) so both creation paths behave the same.
    if (isRealmNameTaken(name, realms)) {
      validationError = `A Realm named "${name}" already exists — pick a different name.`;
      return;
    }
    try {
      const created = sandboxStore.createRealm({
        name,
        color: newColor || undefined,
        description: newDescription.trim() || undefined
      });
      newName = '';
      newDescription = '';
      requestedRealmId = created.id;
      notice = `Realm "${created.name}" created.`;
    } catch (err) {
      validationError = errorText(err, 'Failed to create the Realm.');
    }
  }

  function handleSave(e) {
    e.preventDefault();
    if (!selectedRealm) return;
    clearMessages();
    const name = draftName.trim();
    if (!name) {
      validationError = 'A Realm name is required.';
      return;
    }
    try {
      sandboxStore.updateRealm(selectedRealm.id, {
        name,
        description: draftDescription.trim() || null,
        color: draftColor || null
      });
      notice = 'Realm settings saved.';
    } catch (err) {
      validationError = errorText(err, 'Failed to save the Realm settings.');
    }
  }

  function handleDelete() {
    if (!selectedRealm) return;
    clearMessages();
    if (!deleteConfirming) {
      deleteConfirming = true;
      return;
    }
    const realmName = selectedRealm.name;
    const recursive = deleteRecursive && deletePlan.requiresRecursive;
    const memberCount = deletePlan.memberCount;
    isSubmitting = true;
    try {
      sandboxStore.deleteRealm(selectedRealm.id, recursive ? { recursive: true } : {});
      deleteConfirming = false;
      requestedRealmId = '';
      notice = recursive
        ? `Realm "${realmName}" deleted — ${memberCount} ${memberCount === 1 ? 'member was' : 'members were'} permanently deleted.`
        : `Realm "${realmName}" deleted.`;
    } catch (err) {
      validationError = errorText(err, 'Failed to delete the Realm.');
    } finally {
      isSubmitting = false;
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

    <!-- Create -->
    <form class="settings-section-card" onsubmit={handleCreate}>
      <div class="section-card-header">
        <div class="section-title-wrap">
          <span class="section-badge">New</span>
          <h4 class="section-title">Create Realm</h4>
        </div>
      </div>
      <div class="create-grid">
        <div class="form-group grow">
          <label for="realm-new-name">Name</label>
          <input id="realm-new-name" type="text" bind:value={newName} placeholder="e.g. Story Realm" class="input-field" oninput={clearMessages} />
        </div>
        <div class="form-group color-group">
          <label for="realm-new-color">Color</label>
          <input id="realm-new-color" type="color" bind:value={newColor} class="color-input" />
        </div>
      </div>
      <div class="form-group">
        <label for="realm-new-description">Description <span class="opt">(optional)</span></label>
        <input id="realm-new-description" type="text" bind:value={newDescription} placeholder="Operator note for this group" class="input-field" />
      </div>
      <div class="section-actions">
        <button type="button" class="btn-secondary" onclick={() => onlaunchtemplate()}>Launch from Template…</button>
        <button type="submit" class="btn-primary">Create Realm</button>
      </div>
    </form>

    {#if realms.length === 0}
      <div class="empty-realms">
        <p>No Realms yet. Create one above, then launch agents into it from the launcher.</p>
      </div>
    {:else}
      <!-- Selector -->
      <div class="realm-selector" role="tablist" aria-label="Realms">
        {#each realms as realm (realm.id)}
          <button
            type="button"
            role="tab"
            class="realm-chip"
            class:active={realm.id === selectedRealmId}
            aria-selected={realm.id === selectedRealmId}
            onclick={() => { requestedRealmId = realm.id; clearMessages(); }}
          >
            <span class="realm-dot" style="background: {safeRealmColor(realm.color) ?? 'var(--text-muted)'}"></span>
            <span>{realm.name}</span>
            <span class="realm-chip-count font-mono">{sandboxStore.agents.filter((agent) => agent.config?.realmId === realm.id).length}</span>
          </button>
        {/each}
      </div>

      {#if selectedRealm}
        <!-- Rename / recolor -->
        <form class="settings-section-card" onsubmit={handleSave}>
          <div class="section-card-header">
            <div class="section-title-wrap">
              <span class="section-badge" style="border-color: {accent ?? 'var(--border-color)'}">Settings</span>
              <h4 class="section-title">{selectedRealm.name}</h4>
            </div>
            <span class="realm-id font-mono">{selectedRealm.id}</span>
          </div>
          <div class="create-grid">
            <div class="form-group grow">
              <label for="realm-edit-name">Name</label>
              <input id="realm-edit-name" type="text" bind:value={draftName} class="input-field" oninput={clearMessages} />
            </div>
            <div class="form-group color-group">
              <label for="realm-edit-color">Color</label>
              <input id="realm-edit-color" type="color" bind:value={draftColor} class="color-input" />
            </div>
          </div>
          <div class="form-group">
            <label for="realm-edit-description">Description <span class="opt">(optional)</span></label>
            <input id="realm-edit-description" type="text" bind:value={draftDescription} placeholder="Operator note for this group" class="input-field" />
          </div>
          <div class="section-actions">
            <button type="submit" class="btn-primary">Save Settings</button>
          </div>
        </form>

        <!-- Template provenance (template-launched Realms only) -->
        {#if provenance.visible}
          <div class="settings-section-card">
            <div class="section-card-header">
              <div class="section-title-wrap">
                <span class="section-badge">Origin</span>
                <h4 class="section-title">Template provenance</h4>
              </div>
            </div>
            <dl class="provenance-list">
              {#each provenance.rows as row (row.key)}
                <div class="provenance-row">
                  <dt class="provenance-label">{row.label}</dt>
                  <dd class="provenance-value font-mono">{row.value}</dd>
                </div>
              {/each}
            </dl>
            {#if provenanceDetail.inputRows.length > 0}
              <details class="provenance-details">
                <summary>Input hashes ({provenanceDetail.inputRows.length})</summary>
                <ul class="provenance-detail-list">
                  {#each provenanceDetail.inputRows as row (row.inputId)}
                    <li class="provenance-detail-row">
                      <span class="provenance-detail-label">{row.inputId}</span>
                      <span class="provenance-detail-value font-mono">{row.shortHash}</span>
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            {#if provenanceDetail.seedPaths.length > 0}
              <details class="provenance-details">
                <summary>Seeded paths ({provenanceDetail.seedPaths.length})</summary>
                <ul class="provenance-detail-list">
                  {#each provenanceDetail.seedPaths as path, index (index)}
                    <li class="provenance-detail-row"><span class="provenance-detail-value font-mono">{path}</span></li>
                  {/each}
                </ul>
              </details>
            {/if}
            <p class="provenance-note">
              Recorded at launch: template revision, package digest, input hashes, and seeded paths — hashes and
              paths only, never raw input values. Provenance is descriptive metadata, never authority.
            </p>
            <div class="section-actions">
              <button type="button" class="btn-secondary" onclick={() => onrehydrate(selectedRealm)}>
                Rehydrate / Replace content…
              </button>
            </div>
          </div>
        {:else}
          <div class="settings-section-card">
            <div class="section-card-header">
              <div class="section-title-wrap">
                <span class="section-badge">Content</span>
                <h4 class="section-title">Realm content</h4>
              </div>
            </div>
            <p class="provenance-note">
              This Realm has no recorded launch provenance. You can still write files into its global workspace or a
              member's workspace without relaunching anyone.
            </p>
            <div class="section-actions">
              <button type="button" class="btn-secondary" onclick={() => onrehydrate(selectedRealm)}>
                Write files…
              </button>
            </div>
          </div>
        {/if}

        <!-- Members -->
        <div class="settings-section-card">
          <div class="section-card-header">
            <div class="section-title-wrap">
              <span class="section-badge">Members</span>
              <h4 class="section-title">Members ({activeMembers.length})</h4>
            </div>
          </div>

          {#if activeMembers.length === 0}
            <p class="members-empty">No active agents in this Realm.</p>
          {:else}
            <ul class="member-list">
              {#each activeMembers as member (member.id)}
                <li class="member-row">
                  <div class="member-info">
                    <span class="member-name">{member.name}</span>
                    <span class="member-id font-mono">{member.id}</span>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}

          {#if recycledMembers.length > 0}
            <div class="recycled-note">
              <span class="recycled-label">Recycled members</span>
              <ul class="member-list recycled-list">
                {#each recycledMembers as member (member.id)}
                  <li class="member-row">
                    <div class="member-info">
                      <span class="member-name">{member.name}</span>
                      <span class="member-id font-mono">{member.id}</span>
                    </div>
                    <span class="recycled-chip font-mono">recycled</span>
                  </li>
                {/each}
              </ul>
              <p class="recycled-hint">Recycled members stay in this Realm; the recursive Realm deletion permanently deletes them.</p>
            </div>
          {/if}

          <p class="membership-note">
            Realm membership is fixed at launch. To change an agent's Realm, terminate it and relaunch it into the target Realm.
          </p>
        </div>

        <!-- Danger zone -->
        <div class="settings-section-card danger-card">
          <div class="section-card-header">
            <div class="section-title-wrap">
              <span class="section-badge danger-badge">Danger</span>
              <h4 class="section-title">Delete Realm</h4>
            </div>
          </div>
          {#if isGenericRealm}
            <p class="danger-copy protected-copy">
              {deletePlan.blockedCopy}
            </p>
          {:else if deleteConfirming}
            <p class="danger-copy">
              {deletePlan.confirmCopy}
              {#if deletePlan.requiresRecursive}
                The default deletion is refused while members exist — terminate or delete members first, or opt into the recursive override below.
              {/if}
            </p>
            {#if deletePlan.requiresRecursive}
              <label class="recursive-option" class:active={deleteRecursive}>
                <input type="checkbox" bind:checked={deleteRecursive} />
                <span class="recursive-info">
                  <span class="recursive-label">{deletePlan.recursiveLabel}</span>
                  <span class="recursive-copy">{deletePlan.recursiveCopy}</span>
                </span>
              </label>
            {/if}
            <div class="section-actions">
              <button type="button" class="btn-secondary" onclick={() => deleteConfirming = false} disabled={isSubmitting}>Cancel</button>
              <button
                type="button"
                class="btn-danger"
                onclick={handleDelete}
                disabled={isSubmitting || (deletePlan.requiresRecursive && !deleteRecursive)}
              >
                {#if isSubmitting}
                  Deleting…
                {:else if deletePlan.requiresRecursive && deleteRecursive}
                  {deletePlan.confirmLabel}
                {:else}
                  Confirm Delete
                {/if}
              </button>
            </div>
          {:else}
            <div class="section-actions">
              <button type="button" class="btn-danger-outline" onclick={handleDelete}>Delete Realm…</button>
            </div>
          {/if}
        </div>
      {/if}
    {/if}

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

  .realm-modal {
    width: 100%;
    max-width: 720px;
    max-height: 90vh;
    overflow-y: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 1.75rem;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }

  .icon-chip {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: var(--accent-primary-subtle);
    border: 1px solid var(--accent-primary-border);
    color: var(--accent-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .modal-title {
    font-size: 1.2rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }

  .modal-sub {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin: 0.15rem 0 0 0;
  }

  .btn-close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.35rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .btn-close:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  .error-banner,
  .notice-banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.7rem 0.95rem;
    border-radius: 8px;
    font-size: 0.84rem;
  }

  .error-banner {
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    color: #f87171;
  }

  .notice-banner {
    background: rgba(52, 211, 153, 0.1);
    border: 1px solid rgba(52, 211, 153, 0.35);
    color: #34d399;
  }

  .settings-section-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .section-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: 0.5rem;
    gap: 0.75rem;
  }

  .section-title-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .section-badge {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.12rem 0.45rem;
    border-radius: 4px;
    background: var(--accent-primary-subtle);
    color: var(--accent-primary);
    border: 1px solid var(--accent-primary-border);
  }

  .danger-badge {
    background: var(--accent-danger-subtle);
    color: #f87171;
    border-color: var(--accent-danger-border);
  }

  .section-title {
    margin: 0;
    font-size: 0.92rem;
    color: var(--text-primary);
    font-weight: 600;
  }

  .realm-id {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .create-grid {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.85rem;
    align-items: end;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .form-group.grow {
    min-width: 0;
  }

  .color-group {
    width: 86px;
  }

  label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .opt {
    font-weight: normal;
    font-size: 0.74rem;
    color: var(--text-muted);
  }

  .input-field,
  .select-field {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 0.5rem 0.7rem;
    font-size: 0.86rem;
    font-family: inherit;
  }

  .input-field:focus,
  .select-field:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .color-input {
    width: 100%;
    height: 34px;
    padding: 2px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    cursor: pointer;
  }

  .section-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
  }

  .realm-selector {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .realm-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 999px;
    padding: 0.35rem 0.75rem;
    color: var(--text-secondary);
    font-size: 0.82rem;
    cursor: pointer;
  }

  .realm-chip.active {
    border-color: var(--accent-primary);
    background: var(--accent-primary-subtle);
    color: var(--text-primary);
  }

  .realm-chip-count {
    font-size: 0.7rem;
    background: var(--bg-base);
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
    color: var(--text-muted);
  }

  .realm-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
  }

  .empty-realms {
    padding: 1.25rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.85rem;
    border: 1px dashed var(--border-color);
    border-radius: 8px;
  }

  .members-empty {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-muted);
  }

  .provenance-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
  }

  .provenance-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.45rem 0.6rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
  }

  .provenance-label {
    font-size: 0.74rem;
    font-weight: 600;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .provenance-value {
    font-size: 0.74rem;
    color: var(--text-secondary);
    text-align: right;
    word-break: break-all;
  }

  .provenance-note {
    margin: 0;
    font-size: 0.73rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .provenance-details summary {
    cursor: pointer;
    font-size: 0.73rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .provenance-detail-list {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .provenance-detail-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.6rem;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .provenance-detail-label {
    font-weight: 600;
    color: var(--text-muted);
  }

  .provenance-detail-value {
    text-align: right;
    word-break: break-all;
  }

  .member-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .member-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.65rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
  }

  .member-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .member-name {
    font-size: 0.85rem;
    color: var(--text-primary);
    font-weight: 600;
  }

  .member-id {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .recycled-note {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .recycled-label {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .recycled-list .member-row {
    opacity: 0.75;
  }

  .recycled-chip {
    font-size: 0.68rem;
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.13);
    border: 1px solid rgba(245, 158, 11, 0.35);
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
  }

  .recycled-hint {
    margin: 0;
    font-size: 0.73rem;
    color: var(--text-muted);
  }

  .danger-card {
    border-color: var(--accent-danger-border, rgba(239, 68, 68, 0.4));
  }

  .danger-copy {
    margin: 0;
    font-size: 0.84rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .protected-copy {
    color: #f59e0b;
  }

  .recursive-option {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.7rem 0.8rem;
    border: 1px solid var(--accent-danger-border, rgba(239, 68, 68, 0.4));
    border-radius: 6px;
    background: var(--accent-danger-subtle, rgba(239, 68, 68, 0.08));
    cursor: pointer;
  }

  .recursive-option input[type="checkbox"] {
    margin-top: 0.15rem;
    accent-color: #dc2626;
  }

  .recursive-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .recursive-label {
    font-size: 0.82rem;
    font-weight: 600;
    color: #f87171;
  }

  .recursive-copy {
    font-size: 0.74rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .membership-note {
    margin: 0;
    font-size: 0.74rem;
    color: var(--text-muted);
    line-height: 1.4;
  }

  .btn-primary,
  .btn-secondary,
  .btn-danger,
  .btn-danger-outline {
    border-radius: 6px;
    padding: 0.45rem 0.9rem;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-primary {
    background: var(--accent-primary);
    color: #fff;
  }

  .btn-primary:disabled,
  .btn-secondary:disabled,
  .btn-danger:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-surface);
    border-color: var(--border-color);
    color: var(--text-primary);
  }

  .btn-danger {
    background: #dc2626;
    color: #fff;
  }

  .btn-danger-outline {
    background: transparent;
    border-color: var(--accent-danger-border);
    color: #f87171;
  }

  .btn-danger-outline:hover {
    background: var(--accent-danger-subtle);
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    padding-top: 0.85rem;
    border-top: 1px solid var(--border-subtle);
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (max-width: 640px) {
    .create-grid {
      grid-template-columns: 1fr;
    }
    .color-group {
      width: 100%;
    }
  }
</style>
