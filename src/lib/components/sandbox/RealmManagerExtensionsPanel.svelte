<script>
  /**
   * Realm Manager extensions panel (realm manager redesign, ticket ca33e1b):
   * the selected Realm's extension attachments, the attach editor, and the
   * missing-requested-extensions flow.
   *
   * This panel owns the whole extension capability for the manager: live
   * install/attachment/connection projections from the store, the attach
   * status banner, the prefilled install assist, and the three operator
   * actions (attach, disconnect/reconnect, detach). Install records stay
   * global (`Sandbox Settings → Extensions`); an attachment is recorded
   * operator intent and nothing connects here.
   *
   * The panel is keyed by Realm in the manager root, so a picked extension and
   * every status message reset on selection change instead of leaking across
   * Realms.
   */
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import ExtensionInstallDialog from './ExtensionInstallDialog.svelte';
  import RealmManagerAttachEditor from './RealmManagerAttachEditor.svelte';
  import RealmManagerMissingExtensionsPanel from './RealmManagerMissingExtensionsPanel.svelte';
  import {
    buildExtensionLabelMap,
    buildMissingExtensionFlowViews,
    buildRealmExtensionAttachmentViews,
    describeExtensionAttachError,
    describeExtensionConnectionError,
    EXTENSION_THIRD_PARTY_LABEL
  } from './extensionUiHelpers.ts';

  /**
   * @type {{ realm: import('../../sandbox/realmRegistry/index.ts').RealmRecord }}
   */
  let { realm } = $props();

  let extensionsRevision = $state(0);
  let extensionStatus = $state({ ok: true, msg: '' });
  let installAssist = $state(/** @type {import('./extensionUiHelpers.ts').MissingExtensionFlowView | null} */(null));

  let installedExtensions = $derived.by(() => {
    void extensionsRevision;
    return sandboxStore.listExtensions();
  });

  let realmAttachments = $derived.by(() => {
    void extensionsRevision;
    return sandboxStore.listRealmExtensions(realm.id);
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

  let attachableExtensions = $derived(
    installedExtensions.filter(
      (record) => !realmAttachments.some((attachment) => attachment.extensionId === record.id)
    )
  );

  let missingFlow = $derived.by(() => {
    void extensionsRevision;
    const instance = realm.instance ? realm.instance : null;
    if (!instance || !Array.isArray(instance.missingExtensions)) return [];
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

  // The extension editor follows the selection: a picked extension, a
  // half-typed ceiling, a status message, and an open assist dialog never
  // leak across Realms.
  $effect(() => {
    void realm.id;
    extensionStatus = { ok: true, msg: '' };
    installAssist = null;
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
   * @returns {boolean} True when the attachment was recorded.
   */
  function attachToSelectedRealm(extensionId, toolSelection = 'all') {
    extensionStatus = { ok: true, msg: '' };
    try {
      sandboxStore.attachExtension(realm.id, extensionId, { toolSelection });
      extensionsRevision += 1;
      extensionStatus = {
        ok: true,
        msg: `Attached "${extensionLabel(extensionId)}" to "${realm.name}" — the extension is accepted here; nothing connects.`
      };
      return true;
    } catch (err) {
      extensionStatus = { ok: false, msg: describeExtensionAttachError(err) };
      return false;
    }
  }

  /**
   * Renders one attach-editor status (or clears it with an empty message).
   *
   * @param {{ ok: boolean, msg: string }} status - Editor status.
   */
  function handleEditorStatus(status) {
    extensionStatus = { ok: status.ok === true, msg: typeof status.msg === 'string' ? status.msg : '' };
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
</script>

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

  {#key realm.id}
    <RealmManagerAttachEditor
      attachable={attachableExtensions}
      onattach={attachToSelectedRealm}
      onstatus={handleEditorStatus}
    />
  {/key}
</div>

{#if missingFlow.length > 0}
  <RealmManagerMissingExtensionsPanel
    views={missingFlow}
    onassist={openInstallAssist}
    onattach={(extensionId) => attachToSelectedRealm(extensionId)}
  />
{/if}

{#if installAssist}
  <ExtensionInstallDialog
    prefill={installAssist.installPrefill}
    contextLabel={`realm "${realm.name}"`}
    authorComment={installAssist.authorComment}
    oninstalled={handleAssistInstalled}
    onclose={() => (installAssist = null)}
  />
{/if}
