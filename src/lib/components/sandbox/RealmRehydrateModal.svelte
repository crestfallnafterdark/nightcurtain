<script>
  /**
   * Realm rehydrate / replace modal (ticket 874182b, subsuming 074012c): the
   * Realm Manager's reopen path for updating an existing Realm's hydrated
   * content after launch.
   *
   * Two modes:
   * - **Replace from payload** (template-launched Realms): attach a payload
   *   from the session saved-payload library or a local `<templateId>.package.json`
   *   file. The payload validates through the real catalog `validatePayload`,
   *   resolves through `materializeTemplate` (the launch resolver), and the
   *   plan shows every placement destination grouped by target plus every
   *   resolved directive. Applying writes the groups through
   *   `sandboxStore.seedRealm` (one call per destination, overwriting the
   *   declared paths) and delivers directives as operator-attributed mailbox
   *   messages. Existing Realm membership is never changed and no agent is
   *   relaunched.
   * - **Write files manually**: reopenable seeding for any Realm — file rows,
   *   an optional directive, and a member/Realm-global target, written through
   *   `sandboxStore.seedRealm`.
   *
   * The current launch provenance (template, version, digest, per-input hashes,
   * seeded paths) is always displayed first so the replace decision is
   * informed; hashes and paths only, never raw values. Overwriting declared
   * destinations requires an explicit confirmation checkbox.
   */
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { resolveAgentRealmId } from './realmGroups.ts';
  import {
    buildSeedTargetOptions,
    describeRealmSeedError,
    describeSeedWorkspace,
    validateSeedDraft
  } from './realmLauncherHelpers.ts';
  import { buildRealmProvenanceView } from './realmTemplateHelpers.ts';
  import {
    buildRealmHydrationPinView,
    buildRealmInputRequirementReviews,
    buildRealmRehydratePlan,
    buildRealmProvenanceDetailView,
    describeRealmRehydrateOutcome
  } from './realmHydrationHelpers.ts';
  import { realmPayloadLibrary } from './realmPayloadLibrary.ts';
  import { parseRealmPayloadFileText } from './realmReviewHelpers.ts';

  let { realmId = null, onclose = () => {} } = $props();

  let modalRef = $state(/** @type {HTMLDivElement | null} */(null));
  let validationError = $state('');
  let notice = $state('');
  let isApplying = $state(false);

  let realm = $derived(sandboxStore.realms.find((entry) => entry.id === realmId) ?? null);
  let provenance = $derived(buildRealmProvenanceView(realm));
  let provenanceDetail = $derived(buildRealmProvenanceDetailView(realm));
  let templateId = $derived(realm && realm.instance ? realm.instance.templateId : '');
  let template = $derived(
    templateId ? (sandboxStore.listRealmTemplates().find((entry) => entry.id === templateId) ?? null) : null
  );
  let bundleFiles = $derived(templateId ? (sandboxStore.getRealmTemplateBundle(templateId)?.files ?? {}) : {});
  let effectiveVersion = $derived(
    templateId
      ? (sandboxStore.listRealmTemplateSources().find((entry) => entry.templateId === templateId)?.templateVersion ?? null)
      : null
  );
  let members = $derived(
    sandboxStore.agents
      .filter((agent) => resolveAgentRealmId(agent) === realmId)
      .map((agent) => ({ id: agent.id, name: agent.name }))
  );
  let requirementReviews = $derived(buildRealmInputRequirementReviews(template));
  let canReplaceFromPayload = $derived(Boolean(realm && realm.instance && template));

  // ---- Mode -----------------------------------------------------------------

  /** Operator mode choice; a Realm without provenance can only write files. */
  let requestedMode = $state('payload');
  let mode = $derived(canReplaceFromPayload ? requestedMode : 'files');

  // ---- Payload source -------------------------------------------------------

  let libraryRevision = $state(0);
  let payloadSourceKind = $state(/** @type {'saved' | 'file'} */('saved'));
  let payloadSavedId = $state('');
  let payloadFileValue = $state(/** @type {Record<string, unknown> | null} */(null));
  let payloadFileName = $state('');
  let payloadFileError = $state('');
  let mismatchConfirmed = $state(false);
  let replaceConfirmed = $state(false);
  let payloadReceipt = $state('');
  let partialReceipt = $state('');
  let payloadFileInput = $state(/** @type {HTMLInputElement | null} */(null));

  let savedPayloads = $derived.by(() => {
    void libraryRevision;
    return realmPayloadLibrary.listRealmSavedPayloads().filter((entry) => entry.templateId === templateId);
  });

  let attachedPayload = $derived(
    payloadSourceKind === 'saved'
      ? (realmPayloadLibrary.getRealmSavedPayload(payloadSavedId)?.payload ?? null)
      : payloadFileValue
  );
  let attachedPayloadLabel = $derived(
    payloadSourceKind === 'saved' && attachedPayload
      ? `saved payload "${realmPayloadLibrary.getRealmSavedPayload(payloadSavedId)?.name ?? payloadSavedId}"`
      : payloadSourceKind === 'file' && attachedPayload
        ? (payloadFileName || 'local payload file')
        : ''
  );
  let attachedPin = $derived(
    attachedPayload && typeof attachedPayload.templateVersion === 'string' ? attachedPayload.templateVersion : ''
  );
  let payloadMismatch = $derived(
    Boolean(attachedPin && effectiveVersion && attachedPin !== effectiveVersion)
  );

  let plan = $derived(buildRealmRehydratePlan({
    template,
    realmId,
    payload: attachedPayload,
    bundleFiles,
    members,
    currentVersion: effectiveVersion,
    allowVersionMismatch: mismatchConfirmed
  }));

  let pinView = $derived(buildRealmHydrationPinView({
    templateId,
    templateVersion: effectiveVersion,
    payload: attachedPayload ?? undefined,
    sourceLabel: attachedPayloadLabel || 'no payload attached'
  }));

  // ---- Manual files mode ----------------------------------------------------

  let seedRows = $state(/** @type {Array<{ path: string, content: string }>} */([{ path: '', content: '' }]));
  let seedDirective = $state('');
  let seedTargetId = $state('');
  let seedReceipt = $state(/** @type {import('../../sandbox/sandboxStore/index.svelte.ts').RealmSeedReceipt | null} */(null));
  let seedDirectiveRequested = $state(false);

  let seedTargetOptions = $derived(buildSeedTargetOptions(members, realm ? realm.name : null));

  function clearMessages() {
    validationError = '';
    notice = '';
  }

  /** Switches modes and re-arms the confirmation gates. */
  function setMode(next) {
    requestedMode = next;
    clearMessages();
    replaceConfirmed = false;
    payloadReceipt = '';
    partialReceipt = '';
  }

  /** Reads one local payload file into the replace flow. */
  async function handlePayloadFilePick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const file = input && input.files ? input.files[0] : null;
    if (!file) return;
    clearMessages();
    payloadSourceKind = 'file';
    payloadFileName = file.name;
    payloadFileValue = null;
    payloadFileError = '';
    mismatchConfirmed = false;
    replaceConfirmed = false;
    try {
      const text = await file.text();
      const parsed = parseRealmPayloadFileText(text);
      if (!parsed.ok) {
        payloadFileError = parsed.error;
        return;
      }
      payloadFileValue = parsed.value;
    } catch (err) {
      payloadFileError = err && err.message ? err.message : 'The payload file could not be read.';
    } finally {
      if (input) input.value = '';
    }
  }

  /** Attaches one saved payload from the session library. */
  function attachSavedPayload(entry) {
    clearMessages();
    payloadSourceKind = 'saved';
    payloadSavedId = entry.id;
    mismatchConfirmed = false;
    replaceConfirmed = false;
    payloadReceipt = '';
    partialReceipt = '';
  }

  /** Detaches the current payload source. */
  function detachPayload() {
    clearMessages();
    payloadSavedId = '';
    payloadFileValue = null;
    payloadFileName = '';
    payloadFileError = '';
    mismatchConfirmed = false;
    replaceConfirmed = false;
  }

  /** Toggles the mismatch confirmation for a payload pinning another version. */
  function handleMismatchConfirm(event) {
    const input = /** @type {HTMLInputElement | null} */ (event ? event.currentTarget : null);
    mismatchConfirmed = input ? input.checked : false;
    clearMessages();
  }

  /** Toggles the explicit overwrite confirmation that gates the apply button. */
  function handleReplaceConfirm(event) {
    const input = /** @type {HTMLInputElement | null} */ (event ? event.currentTarget : null);
    replaceConfirmed = input ? input.checked : false;
    clearMessages();
  }

  /** Switches the replacement payload source (saved library or local file). */
  function handlePayloadSourceChange(event) {
    const select = /** @type {HTMLSelectElement | null} */ (event ? event.currentTarget : null);
    payloadSourceKind = select && select.value === 'file' ? 'file' : 'saved';
    detachPayload();
  }

  /**
   * Applies the validated plan: writes each placement group through
   * `seedRealm` (one call per destination; declared paths are overwritten) and
   * delivers every resolved directive as an operator-attributed message.
   * Partial progress is reported instead of hidden.
   */
  function applyPayloadPlan() {
    clearMessages();
    if (!realm || !plan.ok || !replaceConfirmed || isApplying) return;
    isApplying = true;
    payloadReceipt = '';
    partialReceipt = '';
    const receipts = [];
    const directiveOutcomes = [];
    try {
      for (const group of plan.writes) {
        const receipt = sandboxStore.seedRealm({
          realmId: realm.id,
          files: group.files.map((file) => ({ path: file.path, content: file.content })),
          ...(group.targetKind === 'agent' && group.agentId ? { targetAgentId: group.agentId } : {})
        });
        receipts.push({
          targetLabel: group.targetLabel,
          workspaceLabel: describeSeedWorkspace(receipt.workspace, realm.id),
          writtenPaths: receipt.writtenPaths
        });
      }
      for (const directive of plan.directives) {
        const receipt = sandboxStore.sendMessage('human', directive.agentId, directive.text, {
          source: 'realm_seed',
          realmId: realm.id
        });
        directiveOutcomes.push({ targetLabel: directive.targetLabel, delivered: receipt.success === true });
      }
      payloadReceipt = describeRealmRehydrateOutcome(receipts, directiveOutcomes);
      notice = `Realm "${realm.name}" content replaced.`;
    } catch (err) {
      if (receipts.length > 0 || directiveOutcomes.length > 0) {
        partialReceipt = describeRealmRehydrateOutcome(receipts, directiveOutcomes);
      }
      validationError = describeRealmSeedError(err, 'Replacing the Realm content failed.');
    } finally {
      isApplying = false;
    }
  }

  /** Adds one manual seed row. */
  function addSeedRow() {
    seedRows = [...seedRows, { path: '', content: '' }];
    clearMessages();
  }

  /** Removes one manual seed row. */
  function removeSeedRow(index) {
    seedRows = seedRows.filter((_, position) => position !== index);
    clearMessages();
  }

  /** Writes the manual seed draft through the store's seed surface. */
  function applyManualSeed() {
    clearMessages();
    if (!realm || isApplying) return;
    const draft = validateSeedDraft({
      rows: seedRows,
      directive: seedDirective,
      targetAgentId: seedTargetId
    });
    if (!draft.ok) {
      validationError = draft.error;
      return;
    }
    isApplying = true;
    try {
      seedReceipt = sandboxStore.seedRealm({
        realmId: realm.id,
        files: draft.files,
        ...(draft.directive !== null ? { directive: draft.directive } : {}),
        ...(draft.targetAgentId !== null ? { targetAgentId: draft.targetAgentId } : {})
      });
      seedDirectiveRequested = draft.directive !== null;
      notice = 'Files written.';
    } catch (err) {
      validationError = describeRealmSeedError(err);
    } finally {
      isApplying = false;
    }
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) onclose();
  }

  function handleKeydown(e) {
    if (e.key === 'Escape') {
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
  <div bind:this={modalRef} class="realm-rehydrate-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="realm-rehydrate-title">
    <div class="modal-header">
      <div class="header-left">
        <div class="icon-chip">
          <svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v6" />
            <path d="m4.9 10.6 4.2 4.2" />
            <path d="m19.1 10.6-4.2 4.2" />
            <circle cx="12" cy="16" r="6" />
          </svg>
        </div>
        <div>
          <h2 id="realm-rehydrate-title" class="modal-title">Rehydrate / Replace Realm Content</h2>
          <p class="modal-sub">
            {realm ? realm.name : 'Unknown Realm'} · reopen the hydrated content without relaunching members
          </p>
        </div>
      </div>
      <button type="button" class="btn-close" onclick={() => onclose()} aria-label="Close modal">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    {#if !realm}
      <div class="error-banner" role="alert">
        <span>That Realm is no longer registered.</span>
      </div>
    {:else}
      {#if validationError}
        <div class="error-banner" role="alert"><span>{validationError}</span></div>
      {/if}
      {#if notice}
        <div class="notice-banner" role="status"><span>{notice}</span></div>
      {/if}

      <!-- Current provenance -->
      <div class="settings-section-card">
        <div class="section-card-header">
          <div class="section-title-wrap">
            <span class="section-badge">Current</span>
            <h4 class="section-title">Payload provenance</h4>
          </div>
        </div>
        {#if provenance.visible}
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
              <ul class="detail-list">
                {#each provenanceDetail.inputRows as row (row.inputId)}
                  <li class="detail-row">
                    <span class="detail-label">{row.inputId}</span>
                    <span class="detail-value font-mono">{row.shortHash}</span>
                  </li>
                {/each}
              </ul>
            </details>
          {/if}
          {#if provenanceDetail.seedPaths.length > 0}
            <details class="provenance-details">
              <summary>Seeded paths ({provenanceDetail.seedPaths.length})</summary>
              <ul class="detail-list">
                {#each provenanceDetail.seedPaths as path, index (index)}
                  <li class="detail-row"><span class="detail-value font-mono">{path}</span></li>
                {/each}
              </ul>
            </details>
          {/if}
        {:else}
          <p class="provenance-note">
            This Realm has no recorded launch provenance (it was not launched from a template). You can still write
            files manually below.
          </p>
        {/if}
      </div>

      {#if canReplaceFromPayload}
        <div class="mode-row">
          <button
            type="button"
            class="btn-secondary btn-xs"
            class:mode-active={mode === 'payload'}
            onclick={() => setMode('payload')}
          >
            Replace from payload
          </button>
          <button
            type="button"
            class="btn-secondary btn-xs"
            class:mode-active={mode === 'files'}
            onclick={() => setMode('files')}
          >
            Write files manually
          </button>
        </div>
      {/if}

      {#if mode === 'payload' && canReplaceFromPayload}
        <div class="settings-section-card">
          <div class="section-card-header">
            <div class="section-title-wrap">
              <span class="section-badge">Payload</span>
              <h4 class="section-title">Replacement payload</h4>
            </div>
            {#if attachedPayload}
              <span class="payload-attached-badge">attached</span>
            {/if}
          </div>
          <p class="field-hint">
            Attach a saved payload or a local <code>{templateId}.package.json</code> file. The payload is validated
            against template <code>{templateId}</code> ({effectiveVersion ?? 'unresolved version'}) through the real
            catalog validator and resolved through the launch resolver; applying overwrites the declared placement
            destinations of this Realm. Members are never relaunched and membership never changes.
          </p>
          <div class="payload-source-row">
            <select
              class="select-field"
              value={payloadSourceKind}
              onchange={handlePayloadSourceChange}
              aria-label="Replacement payload source"
            >
              <option value="saved" disabled={savedPayloads.length === 0}>Saved payload…</option>
              <option value="file">Local payload file…</option>
            </select>
            {#if payloadSourceKind === 'saved'}
              <select
                class="select-field"
                value={payloadSavedId}
                onchange={(event) => {
                  const entry = realmPayloadLibrary.getRealmSavedPayload(event.currentTarget.value);
                  if (entry) attachSavedPayload(entry);
                }}
                aria-label="Saved payload"
              >
                <option value="">Select a saved payload…</option>
                {#each savedPayloads as entry (entry.id)}
                  <option value={entry.id}>{entry.name} — {entry.digest.slice(0, 20)}…</option>
                {/each}
              </select>
            {:else}
              <button type="button" class="btn-secondary btn-xs" onclick={() => payloadFileInput?.click()}>
                Choose file…
              </button>
            {/if}
            {#if attachedPayload}
              <button type="button" class="btn-danger-outline btn-xs" onclick={detachPayload}>Detach</button>
            {/if}
          </div>
          <input
            bind:this={payloadFileInput}
            class="visually-hidden"
            type="file"
            accept="application/json,.json"
            aria-label="Attach replacement payload file"
            onchange={handlePayloadFilePick}
          />

          {#if payloadFileError}
            <p class="payload-error" role="alert">{payloadFileError}</p>
          {/if}
          {#if payloadSourceKind === 'saved' && savedPayloads.length === 0}
            <p class="payload-status payload-empty">
              No saved payloads exist for this template yet — save one from the launcher's hydration workspace, or
              attach a local payload file.
            </p>
          {/if}
          {#if attachedPayload}
            <p class="payload-status">Attached: {attachedPayloadLabel}</p>
            <div class="pin-card">
              <div class="pin-row">
                <span class="pin-label">Template pin</span>
                <span class="pin-value font-mono">{pinView.pin || 'unresolved'}</span>
              </div>
              <div class="pin-row">
                <span class="pin-label">Payload digest</span>
                <span class="pin-value font-mono" class:pin-value-missing={!pinView.digestOk}>
                  {pinView.digestOk ? pinView.digest : (pinView.digestError || 'no payload')}
                </span>
              </div>
              <div class="pin-row">
                <span class="pin-label">Payload pin</span>
                <span class="pin-value font-mono" class:pin-value-missing={payloadMismatch}>{attachedPin || 'none'}</span>
              </div>
            </div>
            {#if payloadMismatch && !mismatchConfirmed}
              <p class="payload-error" role="alert">
                The payload pins a different template version than this Realm's effective template
                ({effectiveVersion ?? 'unresolved'}).
              </p>
            {/if}
            <label class="seed-toggle">
              <input type="checkbox" checked={mismatchConfirmed} onchange={handleMismatchConfirm} />
              <span>Allow the template-version mismatch for this payload</span>
            </label>
          {/if}
        </div>

        {#if attachedPayload && plan.ok}
          <div class="settings-section-card">
            <div class="section-card-header">
              <div class="section-title-wrap">
                <span class="section-badge">Plan</span>
                <h4 class="section-title">
                  Resolved writes ({plan.fileCount} file{plan.fileCount === 1 ? '' : 's'} → {plan.writes.length} destination{plan.writes.length === 1 ? '' : 's'})
                </h4>
              </div>
            </div>
            {#if plan.warnings.length > 0}
              {#each plan.warnings as warning, index (index)}
                <p class="payload-status payload-warning">{warning}</p>
              {/each}
            {/if}
            {#if plan.writes.length === 0 && plan.directives.length === 0}
              <p class="payload-status payload-empty">
                The payload resolves no placements and no directives — applying would write nothing.
              </p>
            {:else}
              {#each plan.writes as group, index (index)}
                <div class="write-group">
                  <span class="write-target">
                    {group.targetLabel}
                    <span class="field-hint">
                      {group.files.length} file{group.files.length === 1 ? '' : 's'} · overwrites the declared destination{group.files.length === 1 ? '' : 's'}
                    </span>
                  </span>
                  <ul class="write-list">
                    {#each group.files as file, fileIndex (fileIndex)}
                      <li class="write-row">
                        <span class="write-path font-mono">{file.path}</span>
                        <span class="write-size">{file.content.length} chars</span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/each}
              {#if plan.directives.length > 0}
                <div class="write-group">
                  <span class="write-target">Directives ({plan.directives.length})</span>
                  <ul class="write-list">
                    {#each plan.directives as directive, index (index)}
                      <li class="write-row">
                        <span class="write-path">→ {directive.targetLabel}</span>
                        <span class="write-size">“{directive.text.length > 120 ? `${directive.text.slice(0, 120)}…` : directive.text}”</span>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            {/if}
            {#if requirementReviews.length > 0}
              <details class="provenance-details">
                <summary>Template input requirements ({requirementReviews.length})</summary>
                <ul class="detail-list">
                  {#each requirementReviews as review (review.id)}
                    <li class="detail-row">
                      <span class="detail-label">
                        {review.label}
                        <span class="shape-badge">{review.shape}</span>{#if review.required}<span class="req"> *</span>{/if}
                      </span>
                      <span class="detail-value">{review.brief || review.help || review.usageSummary}</span>
                    </li>
                  {/each}
                </ul>
              </details>
            {/if}
            <label class="seed-toggle">
              <input type="checkbox" checked={replaceConfirmed} onchange={handleReplaceConfirm} />
              <span>Overwrite the declared destinations in "{realm.name}"</span>
            </label>
            <div class="section-actions">
              <button
                type="button"
                class="btn-primary"
                disabled={!replaceConfirmed || isApplying || (plan.writes.length === 0 && plan.directives.length === 0)}
                onclick={applyPayloadPlan}
              >
                {isApplying ? 'Replacing…' : 'Replace Realm content'}
              </button>
            </div>
            {#if payloadReceipt}
              <p class="payload-status payload-receipt" role="status">{payloadReceipt}</p>
            {/if}
            {#if partialReceipt}
              <p class="payload-status payload-warning" role="alert">Before the failure: {partialReceipt}</p>
            {/if}
          </div>
        {:else if attachedPayload && !plan.ok}
          <div class="error-banner" role="alert"><span>{plan.error}</span></div>
        {/if}
      {:else}
        <form class="settings-section-card" onsubmit={(event) => { event.preventDefault(); applyManualSeed(); }} novalidate>
          <div class="section-card-header">
            <div class="section-title-wrap">
              <span class="section-badge">Files</span>
              <h4 class="section-title">Write files manually</h4>
            </div>
          </div>
          <p class="field-hint">
            Reopenable seeding: write files into this Realm's global workspace or one active member's workspace. Paths
            are workspace-relative; reserved <code>/global</code> and <code>/public</code> roots are rejected.
          </p>
          {#each seedRows as row, index (index)}
            <div class="seed-row">
              <input
                type="text"
                class="input-field font-mono grow"
                placeholder="/notes/brief.md"
                value={row.path}
                aria-label={`Seed file ${index + 1} path`}
                oninput={(event) => { seedRows = seedRows.map((entry, position) => position === index ? { ...entry, path: event.currentTarget.value } : entry); clearMessages(); }}
              />
              <button type="button" class="btn-row-remove" onclick={() => removeSeedRow(index)} aria-label={`Remove seed row ${index + 1}`}>
                Remove
              </button>
            </div>
            <textarea
              rows="3"
              class="textarea-field font-mono"
              placeholder="File content"
              value={row.content}
              aria-label={`Seed file ${index + 1} content`}
              oninput={(event) => { seedRows = seedRows.map((entry, position) => position === index ? { ...entry, content: event.currentTarget.value } : entry); clearMessages(); }}
            ></textarea>
          {/each}
          <div class="template-picker-actions">
            <button type="button" class="btn-secondary btn-xs" onclick={addSeedRow}>Add file</button>
          </div>
          <div class="form-group">
            <label for="realm-rehydrate-target">Target</label>
            <select id="realm-rehydrate-target" class="select-field" bind:value={seedTargetId} onchange={clearMessages}>
              {#each seedTargetOptions as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="realm-rehydrate-directive">Directive <span class="opt">(optional; needs a member target)</span></label>
            <textarea
              id="realm-rehydrate-directive"
              rows="2"
              class="textarea-field"
              placeholder="Operator-attributed instruction delivered to the target's mailbox"
              bind:value={seedDirective}
              oninput={clearMessages}
            ></textarea>
          </div>
          <div class="section-actions">
            <button type="submit" class="btn-primary" disabled={isApplying}>
              {isApplying ? 'Writing…' : 'Write files'}
            </button>
          </div>
          {#if seedReceipt}
            <p class="payload-status payload-receipt" role="status">
              Wrote {seedReceipt.writtenPaths.length} file{seedReceipt.writtenPaths.length === 1 ? '' : 's'} into
              {describeSeedWorkspace(seedReceipt.workspace, realm.id)}{#if seedReceipt.directiveDelivered} · directive delivered{/if}.
            </p>
            {#if seedReceipt.writtenPaths.length > 0}
              <ul class="detail-list">
                {#each seedReceipt.writtenPaths as written, index (index)}
                  <li class="detail-row"><span class="detail-value font-mono">{written}</span></li>
                {/each}
              </ul>
            {/if}
          {/if}
          {#if seedDirectiveRequested && !seedReceipt?.directiveDelivered}
            <p class="payload-warning">The directive was not delivered (no operator principal may be registered).</p>
          {/if}
        </form>
      {/if}
    {/if}

    <div class="modal-footer">
      <button type="button" class="btn-secondary" onclick={() => onclose()}>Close</button>
    </div>
  </div>
</div>

<style>
  .realm-rehydrate-modal {
    width: min(760px, 94vw);
    max-height: 88vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1.1rem 1.25rem;
  }

  .mode-row {
    display: flex;
    gap: 0.4rem;
  }

  .mode-active {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .provenance-details summary {
    cursor: pointer;
    font-size: 0.72rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .detail-list {
    list-style: none;
    margin: 0.3rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .detail-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .detail-label {
    min-width: 9rem;
    font-weight: 600;
  }

  .detail-value {
    word-break: break-all;
  }

  .write-group {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin-top: 0.35rem;
  }

  .write-target {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .write-list {
    list-style: none;
    margin: 0;
    padding: 0 0 0 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .write-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .write-path {
    word-break: break-all;
  }

  .write-size {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .payload-warning {
    color: var(--accent-danger);
  }

  .payload-receipt {
    color: var(--accent-success);
  }

  .seed-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .seed-row .input-field {
    flex: 1;
    min-width: 0;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
  }

  .shape-badge {
    margin-left: 0.4rem;
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    background: var(--bg-base);
    color: var(--text-muted);
    vertical-align: middle;
  }

  .pin-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.45rem;
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.45rem 0.55rem;
    background: var(--bg-base);
  }

  .pin-row {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.72rem;
  }

  .pin-label {
    flex-shrink: 0;
    min-width: 6.5rem;
    font-weight: 600;
    color: var(--text-muted);
  }

  .pin-value {
    color: var(--text-secondary);
    word-break: break-all;
  }

  .pin-value-missing {
    color: var(--accent-danger);
  }

  .req {
    color: var(--accent-danger);
  }
</style>
