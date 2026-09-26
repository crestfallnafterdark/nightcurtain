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
  import { describeRealmDeletion, safeRealmColor, selectRealmMembers } from './realmGroups.ts';
  import ExtensionInstallDialog from './ExtensionInstallDialog.svelte';
  import {
    buildExtensionLabelMap,
    buildMissingExtensionFlowViews,
    buildRealmExtensionAttachmentViews,
    describeExtensionAttachError,
    describeExtensionConnectionError,
    describeRealmAttachCeilingEditor,
    describeRealmExtensionState,
    EXTENSION_THIRD_PARTY_LABEL
  } from './extensionUiHelpers.ts';

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
    selectedRealm ? selectRealmMembers(sandboxStore.agents, selectedRealm.id) : []
  );
  let recycledMembers = $derived(
    selectedRealm ? selectRealmMembers(sandboxStore.recycleBin, selectedRealm.id) : []
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

  // ---- Extensions (extension wave) ------------------------------------------

  let extensionsRevision = $state(0);
  let extensionStatus = $state({ ok: true, msg: '' });
  let attachExtensionId = $state('');
  let attachSelectionMode = $state('all');
  let attachSelectionText = $state('');
  let attachCheckedNames = $state(/** @type {string[]} */([]));
  let installAssist = $state(/** @type {import('./extensionUiHelpers.ts').MissingExtensionFlowView | null} */(null));

  let installedExtensions = $derived.by(() => {
    void extensionsRevision;
    return sandboxStore.listExtensions();
  });

  let realmAttachments = $derived.by(() => {
    void extensionsRevision;
    const realm = selectedRealm;
    return realm ? sandboxStore.listRealmExtensions(realm.id) : [];
  });

  /** Display labels for attachment/conflict rows (id → name). */
  let extensionLabels = $derived.by(() => {
    void extensionsRevision;
    return buildExtensionLabelMap(installedExtensions);
  });

  /** Live attachment views (state, ceiling, conflicts, resolution actions). */
  let attachmentViews = $derived.by(() => {
    void extensionsRevision;
    return buildRealmExtensionAttachmentViews({
      attachments: realmAttachments,
      connections: sandboxStore.extensionConnections,
      installs: installedExtensions,
      labels: extensionLabels
    });
  });

  /**
   * Attach-editor ceiling model (ticket 9472417): the picked extension's live
   * conflict-free catalog names plus the state-accurate copy/visibility
   * decision, so the editor never claims a missing live catalog while a
   * connected catalog exists (or before anything is picked).
   */
  let attachCeiling = $derived(describeRealmAttachCeilingEditor({
    extensionId: attachExtensionId,
    connections: sandboxStore.extensionConnections
  }));

  /** Live conflict-free catalog names of the extension picked in the attach editor. */
  let attachCatalogNames = $derived(attachCeiling.catalogNames);

  let attachableExtensions = $derived(
    installedExtensions.filter(
      (record) => !realmAttachments.some((attachment) => attachment.extensionId === record.id)
    )
  );

  let missingFlow = $derived.by(() => {
    void extensionsRevision;
    const realm = selectedRealm;
    const instance = realm && realm.instance ? realm.instance : null;
    if (!realm || !instance || !Array.isArray(instance.missingExtensions)) return [];
    const templateId = typeof instance.templateId === 'string' ? instance.templateId : '';
    const template = templateId
      ? (sandboxStore.getRealmTemplateBundle(templateId)?.template ?? null)
      : null;
    return buildMissingExtensionFlowViews({
      missingExtensionIds: instance.missingExtensions,
      template,
      installs: installedExtensions,
      attachments: realmAttachments
    }).filter((view) => view.state !== 'active');
  });

  /**
   * Installed-record display label (`Name` or the raw id).
   *
   * @param {string} extensionId - Extension id.
   * @returns {string} Display label.
   */
  function extensionLabel(extensionId) {
    const record = installedExtensions.find((candidate) => candidate.id === extensionId) ?? null;
    return record ? (record.displayName || record.id) : extensionId;
  }

  /**
   * Attaches one globally installed extension to the selected Realm with the
   * operator-chosen tool selection. Nothing connects.
   *
   * @param {string} extensionId - Installed extension id.
   * @param {'all' | readonly string[]} toolSelection - Realm-level selection.
   */
  function attachToSelectedRealm(extensionId, toolSelection = 'all') {
    const realm = selectedRealm;
    if (!realm) return;
    extensionStatus = { ok: true, msg: '' };
    try {
      sandboxStore.attachExtension(realm.id, extensionId, { toolSelection });
      extensionsRevision += 1;
      extensionStatus = {
        ok: true,
        msg: `Attached "${extensionLabel(extensionId)}" to "${realm.name}" — the extension is accepted here; nothing connects.`
      };
    } catch (err) {
      extensionStatus = { ok: false, msg: describeExtensionAttachError(err) };
    }
  }

  /** Clears the inline extension status banner. */
  function clearExtensionMessages() {
    extensionStatus = { ok: true, msg: '' };
  }

  /** Reseeds the ceiling editor when the attach selection changes. */
  function handleAttachSelectionChange() {
    clearExtensionMessages();
    attachCheckedNames = [...attachCatalogNames];
    attachSelectionMode = 'all';
    attachSelectionText = '';
  }

  /**
   * Attaches the extension picked in the attach editor with its realm-level
   * ceiling: the live catalog names the operator checked (all checked is the
   * `'all'` selection), or the typed sanitized call names when no live
   * catalog exists yet.
   */
  function handleAttachExtension() {
    if (!attachExtensionId) {
      extensionStatus = { ok: false, msg: 'Choose an installed extension to attach.' };
      return;
    }
    let toolSelection;
    if (attachCatalogNames.length > 0) {
      if (attachCheckedNames.length === 0) {
        extensionStatus = { ok: false, msg: 'Select at least one live catalog tool, or keep every tool selected.' };
        return;
      }
      toolSelection = attachCheckedNames.length < attachCatalogNames.length
        ? attachCatalogNames.filter((name) => attachCheckedNames.includes(name))
        : 'all';
    } else if (attachSelectionMode === 'custom') {
      toolSelection = attachSelectionText.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      if (toolSelection.length === 0) {
        extensionStatus = { ok: false, msg: 'List at least one sanitized call name, or use the "all tools" selection.' };
        return;
      }
    } else {
      toolSelection = 'all';
    }
    attachToSelectedRealm(attachExtensionId, toolSelection);
    attachExtensionId = '';
    attachSelectionMode = 'all';
    attachSelectionText = '';
    attachCheckedNames = [];
  }

  /**
   * Disconnects one attached extension's live session (the attachment stays).
   * This is the operator resolution action for a catalog conflict.
   *
   * @param {string} extensionId - Extension id.
   */
  async function handleDisconnectExtension(extensionId) {
    extensionStatus = { ok: true, msg: '' };
    try {
      await sandboxStore.disconnectExtension(extensionId);
      extensionsRevision += 1;
      extensionStatus = { ok: true, msg: `Disconnected "${extensionLabel(extensionId)}". The attachment stays; its tools are unavailable until reconnected.` };
    } catch (err) {
      const failure = describeExtensionConnectionError(err);
      extensionStatus = { ok: false, msg: `${failure.code}: ${failure.message}` };
    }
  }

  /**
   * Reconnects one attached extension's live session (re-discovery + drift
   * disclosure; grants update at the next safe state).
   *
   * @param {string} extensionId - Extension id.
   */
  async function handleReconnectExtension(extensionId) {
    extensionStatus = { ok: true, msg: '' };
    try {
      await sandboxStore.reconnectExtension(extensionId);
      extensionsRevision += 1;
      extensionStatus = { ok: true, msg: `Reconnected "${extensionLabel(extensionId)}". Any catalog drift is disclosed on the attachment row.` };
    } catch (err) {
      const failure = describeExtensionConnectionError(err);
      extensionStatus = { ok: false, msg: `${failure.code}: ${failure.message}` };
    }
  }

  /**
   * Detaches one extension from the selected Realm (the global install record
   * survives).
   *
   * @param {string} extensionId - Attached extension id.
   */
  function handleDetachExtension(extensionId) {
    const realm = selectedRealm;
    if (!realm) return;
    if (!confirm(`Detach "${extensionLabel(extensionId)}" from "${realm.name}"? The global install record stays installed.`)) return;
    extensionStatus = { ok: true, msg: '' };
    try {
      sandboxStore.detachExtension(realm.id, extensionId);
      extensionsRevision += 1;
      extensionStatus = { ok: true, msg: `Detached "${extensionLabel(extensionId)}" from "${realm.name}".` };
    } catch (err) {
      extensionStatus = { ok: false, msg: describeExtensionAttachError(err, 'Failed to detach the extension.') };
    }
  }

  /**
   * Opens the prefilled install dialog for one missing requested extension
   * (the operator-initiated auto-install assist; nothing installs on its own).
   *
   * @param {import('./extensionUiHelpers.ts').MissingExtensionFlowView} view - Missing flow view.
   */
  function openInstallAssist(view) {
    extensionStatus = { ok: true, msg: '' };
    installAssist = view;
  }

  /**
   * Records one assist install and leaves attachment to the operator.
   *
   * @param {{ id: string, displayName?: string }} record - Installed record.
   */
  function handleAssistInstalled(record) {
    installAssist = null;
    extensionsRevision += 1;
    extensionStatus = {
      ok: true,
      msg: `Installed "${record.displayName || record.id}". Attach it to this Realm when ready — nothing attaches automatically.`
    };
  }

  // Seed the edit draft from the selected record; reseeded after each save.
  // The extension editor follows the selection too: a picked extension, a
  // half-typed selection, and an open assist dialog never leak across Realms.
  $effect(() => {
    const realm = selectedRealm;
    if (!realm) return;
    draftName = realm.name;
    draftDescription = realm.description ?? '';
    draftColor = safeRealmColor(realm.color) ?? '#7c9cff';
    deleteConfirming = false;
    deleteRecursive = false;
    attachExtensionId = '';
    attachSelectionMode = 'all';
    attachSelectionText = '';
    attachCheckedNames = [];
    installAssist = null;
    extensionStatus = { ok: true, msg: '' };
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
            <span class="realm-chip-count font-mono">{selectRealmMembers(sandboxStore.agents, realm.id).length}</span>
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
              Recorded at launch: template revision, package digest, input hashes, seeded paths, and the extension
              resolution (resolved tool call names and missing requested extensions) — hashes, paths, call names, and
              ids only, never raw input values or secrets. Provenance is descriptive metadata, never authority.
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

        <!-- Extensions (extension wave): realm-local attachments -->
        <div class="settings-section-card">
          <div class="section-card-header">
            <div class="section-title-wrap">
              <span class="section-badge">Extensions</span>
              <h4 class="section-title">Attachments ({realmAttachments.length})</h4>
            </div>
          </div>

          <p class="extensions-hint">
            Attaching accepts a globally installed extension in this Realm with a realm-level tool selection.
            Install records are managed in Sandbox Settings → Extensions. Nothing connects: an attachment is
            recorded operator intent, and its tools stay inert until a runtime connection exists.
          </p>

          {#if extensionStatus.msg}
            <div class="extension-status" class:ok={extensionStatus.ok} class:err={!extensionStatus.ok} role="status">
              {extensionStatus.msg}
            </div>
          {/if}

          {#if realmAttachments.length === 0}
            <p class="members-empty">No extensions attached to this Realm yet.</p>
          {:else}
            <ul class="attachment-list">
              {#each attachmentViews as view (view.extensionId)}
                <li class="attachment-row">
                  <div class="attachment-info">
                    <div class="attachment-title-row">
                      <span class="attachment-name">{view.label}</span>
                      <span class="attachment-id font-mono">{view.extensionId}</span>
                      <span class="status-chip state-{view.state} font-mono">{view.stateLabel}</span>
                      {#if view.live.chip}
                        <span class="live-chip live-{view.live.state} font-mono">{view.live.label}</span>
                      {/if}
                      <span class="third-party-chip font-mono">{EXTENSION_THIRD_PARTY_LABEL}</span>
                    </div>
                    <span class="attachment-selection font-mono">{view.ceiling.summary}</span>
                    <span class="attachment-note">
                      {view.stateDescription}
                      {#if view.state === 'unavailable'}
                        It returns to active once the extension is installed again.
                      {/if}
                    </span>
                    {#if view.toolCount > 0}
                      <span class="attachment-live-meta font-mono">
                        {view.toolCount} live tool{view.toolCount === 1 ? '' : 's'}{view.digest ? ` · ${view.digest}` : ''}{view.connectedAt ? ` · connected ${view.connectedAt}` : ''}
                      </span>
                    {/if}
                    {#if view.conflicts.length > 0}
                      <span class="attachment-conflicts font-mono">
                        conflicts:
                        {view.conflicts.map((conflict) => `${conflict.callName} ↔ ${conflict.otherLabel}`).join(', ')}
                        — disconnect one side or reconnect to re-arbitrate
                      </span>
                    {/if}
                  </div>
                  <div class="attachment-actions">
                    {#if view.canReconnect}
                      <button
                        type="button"
                        class="btn-secondary btn-xs"
                        onclick={() => handleReconnectExtension(view.extensionId)}
                        title="Reconnect the live session (re-discovery + drift disclosure)"
                      >
                        Reconnect
                      </button>
                    {/if}
                    {#if view.canDisconnect}
                      <button
                        type="button"
                        class="btn-secondary btn-xs"
                        onclick={() => handleDisconnectExtension(view.extensionId)}
                        title="Disconnect the live session (the attachment stays)"
                      >
                        Disconnect
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="btn-secondary btn-xs"
                      onclick={() => handleDetachExtension(view.extensionId)}
                      title="Detach from this Realm (the global install stays)"
                    >
                      Detach
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}

          <div class="attach-editor">
            <div class="attach-grid">
              <div class="form-group grow">
                <label for="realm-attach-extension">Attach an installed extension</label>
                <select id="realm-attach-extension" class="select-field" bind:value={attachExtensionId} onchange={handleAttachSelectionChange}>
                  <option value="">Choose an extension…</option>
                  {#each attachableExtensions as record (record.id)}
                    <option value={record.id}>{record.displayName || record.id} ({record.kind})</option>
                  {/each}
                </select>
                {#if attachableExtensions.length === 0}
                  <span class="attach-empty-hint">Every installed extension is already attached here, or none is installed.</span>
                {/if}
              </div>
              <div class="form-group grow">
                <span class="field-label">Realm-level ceiling (tool selection)</span>
                {#if attachCeiling.showLiveCatalog}
                  <div class="ceiling-tool-list">
                    <label class="ceiling-tool-row">
                      <input
                        type="checkbox"
                        checked={attachCheckedNames.length === attachCatalogNames.length}
                        onchange={(event) => (attachCheckedNames = event.currentTarget.checked ? [...attachCatalogNames] : [])}
                      />
                      <span>All {attachCatalogNames.length} live catalog tools</span>
                    </label>
                    {#each attachCatalogNames as callName (callName)}
                      <label class="ceiling-tool-row">
                        <input
                          type="checkbox"
                          checked={attachCheckedNames.includes(callName)}
                          onchange={(event) => {
                            const next = new Set(attachCheckedNames);
                            if (event.currentTarget.checked) next.add(callName);
                            else next.delete(callName);
                            attachCheckedNames = attachCatalogNames.filter((name) => next.has(name));
                          }}
                        />
                        <span class="font-mono">{callName}</span>
                      </label>
                    {/each}
                  </div>
                  <span class="attach-empty-hint">
                    The Realm ceiling caps the live catalog: unchecked tools are never granted here, and per-agent
                    scopes can only narrow further.
                  </span>
                {:else}
                  <div class="selection-modes">
                    <label class="mode-option" class:active={attachSelectionMode === 'all'}>
                      <input type="radio" bind:group={attachSelectionMode} value="all" />
                      <span>All tools</span>
                    </label>
                    <label class="mode-option" class:active={attachSelectionMode === 'custom'}>
                      <input type="radio" bind:group={attachSelectionMode} value="custom" />
                      <span>Only specific call names</span>
                    </label>
                  </div>
                  {#if attachSelectionMode === 'custom'}
                    <input
                      type="text"
                      class="input-field font-mono"
                      placeholder="docs_search, similarity"
                      bind:value={attachSelectionText}
                      oninput={clearExtensionMessages}
                    />
                    <span class="attach-empty-hint">
                      {attachCeiling.customNamesHint}
                    </span>
                  {:else}
                    <span class="attach-empty-hint">
                      {attachCeiling.allToolsHint}
                    </span>
                  {/if}
                {/if}
              </div>
            </div>
            <div class="section-actions">
              <button
                type="button"
                class="btn-primary btn-xs"
                onclick={handleAttachExtension}
                disabled={!attachExtensionId}
              >
                Attach to this Realm
              </button>
            </div>
          </div>
        </div>

        <!-- Missing requested extensions (extension wave): live install/attach flow -->
        {#if missingFlow.length > 0}
          <div class="settings-section-card missing-card">
            <div class="section-card-header">
              <div class="section-title-wrap">
                <span class="section-badge missing-badge">Attention</span>
                <h4 class="section-title">Missing extensions ({missingFlow.length})</h4>
              </div>
            </div>
            <p class="extensions-hint">
              The launch template requested these extensions, but their tools are not available in this Realm.
              Nothing installs or attaches automatically — use an action below; this list follows the live state.
            </p>
            <ul class="missing-list">
              {#each missingFlow as view (view.extensionId)}
                {@const stateView = describeRealmExtensionState(view.state)}
                <li class="missing-row">
                  <div class="missing-info">
                    <div class="missing-title-row">
                      <span class="missing-name">{view.displayName || view.extensionId}</span>
                      <span class="kind-chip font-mono">{view.kind}</span>
                      <span class="status-chip state-{stateView.state} font-mono">{stateView.label}</span>
                      <span class="third-party-chip font-mono">{view.thirdPartyLabel}</span>
                    </div>
                    <span class="missing-note">{stateView.description}</span>
                    {#if view.transportHintSummary}
                      <span class="missing-transport font-mono">{view.transportHintSummary}</span>
                    {/if}
                    {#if view.authorComment}
                      <span class="missing-author">Template note: {view.authorComment}</span>
                    {/if}
                  </div>
                  <div class="missing-actions">
                    {#if view.canInstall}
                      <button type="button" class="btn-primary btn-xs" onclick={() => openInstallAssist(view)}>
                        Install…
                      </button>
                    {/if}
                    {#if view.canAttach}
                      <button type="button" class="btn-secondary btn-xs" onclick={() => attachToSelectedRealm(view.extensionId)}>
                        Attach to this Realm
                      </button>
                    {/if}
                    {#if !view.canInstall && !view.canAttach && view.state !== 'active'}
                      <span class="missing-passive">
                        {view.state === 'conflict'
                          ? 'Already attached — resolve the call-name conflict to activate it.'
                          : 'Already attached — the extension is currently unavailable.'}
                      </span>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
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

    {#if installAssist}
      <ExtensionInstallDialog
        prefill={installAssist.installPrefill}
        contextLabel={selectedRealm ? `realm "${selectedRealm.name}"` : ''}
        authorComment={installAssist.authorComment}
        oninstalled={handleAssistInstalled}
        onclose={() => (installAssist = null)}
      />
    {/if}
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

  /* ---- Extensions (extension wave) ---- */

  .extensions-hint {
    margin: 0;
    font-size: 0.73rem;
    line-height: 1.45;
    color: var(--text-muted);
  }

  .extension-status {
    font-size: 0.78rem;
    line-height: 1.4;
    padding: 0.5rem 0.65rem;
    border-radius: 6px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-secondary);
    color: var(--text-secondary);
  }

  .extension-status.err {
    color: #f87171;
    border-color: var(--accent-danger-border, rgba(239, 68, 68, 0.4));
    background: var(--accent-danger-subtle, rgba(239, 68, 68, 0.08));
  }

  .attachment-list,
  .missing-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .attachment-row,
  .missing-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.55rem 0.7rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
  }

  .attachment-info,
  .missing-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .attachment-title-row,
  .missing-title-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .attachment-name,
  .missing-name {
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .attachment-id,
  .attachment-selection,
  .missing-transport {
    font-size: 0.7rem;
    color: var(--text-secondary);
    word-break: break-all;
  }

  .attachment-note,
  .missing-note,
  .missing-author,
  .missing-passive {
    font-size: 0.71rem;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .kind-chip,
  .status-chip {
    font-size: 0.65rem;
    border-radius: 4px;
    padding: 0.08rem 0.36rem;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    background: var(--bg-base);
  }

  .status-chip.state-active {
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.4);
    background: rgba(52, 211, 153, 0.1);
  }

  .status-chip.state-conflict {
    color: #f87171;
    border-color: var(--accent-danger-border, rgba(239, 68, 68, 0.4));
    background: var(--accent-danger-subtle, rgba(239, 68, 68, 0.08));
  }

  .status-chip.state-unavailable,
  .status-chip.state-not-attached,
  .status-chip.state-not-installed {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.1);
  }

  .live-chip,
  .third-party-chip {
    font-size: 0.64rem;
    border-radius: 4px;
    padding: 0.08rem 0.36rem;
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    background: var(--bg-base);
  }

  .live-chip.live-connected {
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.4);
    background: rgba(52, 211, 153, 0.1);
  }

  .live-chip.live-connecting {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.4);
    background: rgba(251, 191, 36, 0.1);
  }

  .live-chip.live-conflict,
  .live-chip.live-error {
    color: #f87171;
    border-color: var(--accent-danger-border, rgba(239, 68, 68, 0.4));
    background: var(--accent-danger-subtle, rgba(239, 68, 68, 0.08));
  }

  .third-party-chip {
    color: var(--text-muted);
    border-color: var(--border-subtle);
  }

  .attachment-live-meta,
  .attachment-conflicts {
    font-size: 0.68rem;
    color: var(--text-secondary);
    word-break: break-all;
  }

  .attachment-conflicts {
    color: #f87171;
  }

  .ceiling-tool-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 11rem;
    overflow-y: auto;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.4rem 0.5rem;
    background: var(--bg-secondary);
  }

  .ceiling-tool-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.76rem;
    color: var(--text-secondary);
  }

  .ceiling-tool-row input {
    accent-color: var(--accent-primary);
  }

  .attachment-actions,
  .missing-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .attach-editor {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.75rem;
  }

  .attach-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
    gap: 0.75rem;
    align-items: start;
  }

  .field-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .selection-modes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .mode-option {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0.3rem 0.55rem;
    cursor: pointer;
    background: var(--bg-secondary);
  }

  .mode-option.active {
    border-color: var(--accent-primary);
    color: var(--text-primary);
    background: var(--accent-primary-subtle);
  }

  .mode-option input {
    accent-color: var(--accent-primary);
  }

  .attach-empty-hint {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .missing-card {
    border-color: rgba(245, 158, 11, 0.4);
  }

  .missing-badge {
    background: rgba(245, 158, 11, 0.13);
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.4);
  }

  .btn-xs {
    border-radius: 6px;
    padding: 0.28rem 0.6rem;
    font-size: 0.74rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-primary.btn-xs {
    background: var(--accent-primary);
    color: #fff;
  }

  .btn-secondary.btn-xs {
    background: var(--bg-surface);
    border-color: var(--border-color);
    color: var(--text-primary);
  }

  .btn-primary.btn-xs:disabled {
    opacity: 0.55;
    cursor: not-allowed;
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
