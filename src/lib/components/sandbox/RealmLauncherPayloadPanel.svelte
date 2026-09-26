<script>
  /**
   * Instance-payload card of the Realm launcher (launcher redesign
   * decomposition, ticket e1e8775): the payload source select (none /
   * session candidate / session saved payload / local package file), the
   * candidate and saved-payload rows, the template-version mismatch
   * confirmation, the save-to-library row, and the template pin + canonical
   * payload digest card.
   *
   * The card renders the payload state the modal owns; every mutation
   * (attach/detach/clear/download/save/mismatch) travels through a callback so
   * the launch payload resolution stays in one place.
   */
  import { buildRealmPayloadFilename } from './realmReviewHelpers.ts';
  import { formatRealmLaunchTimestamp } from './realmTemplateHelpers.ts';

  /**
   * @type {{
   *   templateId: string,
   *   bundleVersion: string | null,
   *   sourceKind: 'none' | 'candidate' | 'saved' | 'file',
   *   candidateId: string,
   *   savedId: string,
   *   pendingPayloads: Array<import('./realmReviewHelpers.ts').RealmPendingPayloadView>,
   *   savedPayloads: Array<import('./realmPayloadLibrary.ts').RealmSavedPayload>,
   *   attachedPayload: unknown,
   *   sourceLabel: string,
   *   fileError: string,
   *   payloadPreview: import('./realmReviewHelpers.ts').RealmReviewPackagePreview,
   *   mismatchConfirmed: boolean,
   *   editedFileSlotCount: number,
   *   savedName: string,
   *   savedError: string,
   *   pinView: import('./realmHydrationHelpers.ts').RealmHydrationPinView,
   *   onsourcechange: (kind: 'none' | 'candidate' | 'saved' | 'file') => void,
   *   onfile: (file: File) => Promise<void>,
   *   onattachcandidate: (view: import('./realmReviewHelpers.ts').RealmPendingPayloadView) => void,
   *   ondownloadcandidate: (view: import('./realmReviewHelpers.ts').RealmPendingPayloadView) => void,
   *   onclearcandidate: (view: import('./realmReviewHelpers.ts').RealmPendingPayloadView) => void,
   *   onattachsaved: (entry: import('./realmPayloadLibrary.ts').RealmSavedPayload) => void,
   *   ondownloadsaved: (entry: import('./realmPayloadLibrary.ts').RealmSavedPayload) => void,
   *   ondeletesaved: (entry: import('./realmPayloadLibrary.ts').RealmSavedPayload) => void,
   *   ondetach: () => void,
   *   onmismatch: (checked: boolean) => void,
   *   onsavename: (value: string) => void,
   *   onsave: () => void
   * }}
   */
  let {
    templateId,
    bundleVersion,
    sourceKind,
    candidateId,
    savedId,
    pendingPayloads,
    savedPayloads,
    attachedPayload,
    sourceLabel,
    fileError,
    payloadPreview,
    mismatchConfirmed,
    editedFileSlotCount,
    savedName,
    savedError,
    pinView,
    onsourcechange,
    onfile,
    onattachcandidate,
    ondownloadcandidate,
    onclearcandidate,
    onattachsaved,
    ondownloadsaved,
    ondeletesaved,
    ondetach,
    onmismatch,
    onsavename,
    onsave
  } = $props();

  let payloadFileInput = $state(/** @type {HTMLInputElement | null} */(null));

  /**
   * Reads one picked local package file and hands it to the modal (which
   * parses it and surfaces parse failures inline).
   *
   * @param {Event} event - Change event of the hidden payload file input.
   */
  async function handlePayloadFilePick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const file = input && input.files ? input.files[0] : null;
    if (!file) return;
    try {
      await onfile(file);
    } finally {
      if (input) input.value = '';
    }
  }
</script>

{#if templateId}
  <div class="settings-section-card">
    <div class="section-card-header">
      <div class="section-title-wrap">
        <span class="section-badge">Payload</span>
        <h4 class="section-title">Instance payload (attach at launch)</h4>
      </div>
      {#if attachedPayload}
        <span class="payload-attached-badge">attached</span>
      {/if}
    </div>
    <p class="field-hint">
      The reviewed instance content: declared input values (<code>text</code> or <code>files</code>
      shape). Attach a submitted session candidate, a named payload from the saved-payload library, or a local
      <code>{buildRealmPayloadFilename(templateId)}</code> file. The package is validated against
      the effective template version before any launch; submitted candidates are session-only and saved
      payloads persist across reloads.
      Edited input values win per input over the attached package.
    </p>
    <div class="payload-source-row">
      <select
        class="select-field"
        value={sourceKind}
        onchange={(event) => onsourcechange(/** @type {'none' | 'candidate' | 'saved' | 'file'} */ (event.currentTarget.value))}
        aria-label="Payload attachment source"
      >
        <option value="none">No payload attached</option>
        <option value="candidate" disabled={pendingPayloads.length === 0}>Submitted candidate…</option>
        <option value="saved" disabled={savedPayloads.length === 0}>Saved payload…</option>
        <option value="file">Local payload file…</option>
      </select>
      {#if sourceKind === 'file'}
        <button type="button" class="btn-secondary btn-xs" onclick={() => payloadFileInput?.click()}>
          Choose file…
        </button>
      {/if}
      {#if attachedPayload}
        <button type="button" class="btn-danger-outline btn-xs" onclick={ondetach}>Detach</button>
      {/if}
    </div>
    <input
      bind:this={payloadFileInput}
      class="visually-hidden"
      type="file"
      accept="application/json,.json"
      aria-label="Attach instance payload file"
      onchange={handlePayloadFilePick}
    />

    {#if sourceKind === 'candidate'}
      {#if pendingPayloads.length === 0}
        <p class="payload-status payload-empty">
          No session candidates are pending for this template — submit one with the hydration tool, or
          attach a saved or local payload.
        </p>
      {:else}
        {#each pendingPayloads as candidate (candidate.templateId)}
          <div class="payload-candidate">
            <div class="payload-candidate-info">
              <span class="payload-candidate-title font-mono">{candidate.templateVersion}</span>
              <span class="field-hint">{candidate.summary}</span>
            </div>
            <div class="template-picker-actions">
              <button
                type="button"
                class="btn-secondary btn-xs"
                class:active-candidate={candidateId === candidate.templateId && Boolean(attachedPayload)}
                onclick={() => onattachcandidate(candidate)}
              >
                {candidateId === candidate.templateId && attachedPayload ? 'Attached' : 'Attach'}
              </button>
              <button type="button" class="btn-secondary btn-xs" onclick={() => ondownloadcandidate(candidate)}>
                Download
              </button>
              <button type="button" class="btn-danger-outline btn-xs" onclick={() => onclearcandidate(candidate)}>
                Clear…
              </button>
            </div>
          </div>
        {/each}
      {/if}
    {/if}

    {#if sourceKind === 'saved'}
      {#if savedPayloads.length === 0}
        <p class="payload-status payload-empty">
          No saved payloads exist for this template yet — assemble inputs and save one below, or attach a
          local payload file.
        </p>
      {:else}
        {#each savedPayloads as entry (entry.id)}
          <div class="payload-candidate">
            <div class="payload-candidate-info">
              <span class="payload-candidate-title">
                {entry.name}
                <span class="template-version font-mono">{entry.digest}</span>
              </span>
              <span class="field-hint">{entry.inputSummary} · saved {formatRealmLaunchTimestamp(entry.savedAt)}</span>
            </div>
            <div class="template-picker-actions">
              <button
                type="button"
                class="btn-secondary btn-xs"
                class:active-candidate={savedId === entry.id && Boolean(attachedPayload)}
                onclick={() => onattachsaved(entry)}
              >
                {savedId === entry.id && attachedPayload ? 'Attached' : 'Attach'}
              </button>
              <button type="button" class="btn-secondary btn-xs" onclick={() => ondownloadsaved(entry)}>
                Download
              </button>
              <button type="button" class="btn-danger-outline btn-xs" onclick={() => ondeletesaved(entry)}>
                Delete…
              </button>
            </div>
          </div>
        {/each}
      {/if}
    {/if}

    {#if fileError}
      <p class="payload-error" role="alert">{fileError}</p>
    {/if}
    {#if attachedPayload}
      <p class="payload-status">
        Attached: {sourceLabel}{#if payloadPreview.mismatch} — pins a different template version
        (current {bundleVersion ?? 'unknown'}){/if}.
      </p>
      {#if payloadPreview.mismatch}
        <label class="seed-toggle">
          <input type="checkbox" checked={mismatchConfirmed} onchange={(event) => onmismatch(event.currentTarget.checked)} />
          <span>Allow the template-version mismatch for this payload</span>
        </label>
      {/if}
    {:else if sourceKind === 'file'}
      <p class="payload-status">No payload file read yet — choose a package JSON file.</p>
    {/if}
    {#if editedFileSlotCount > 0}
      <p class="payload-status">
        {editedFileSlotCount} reviewed file slot{editedFileSlotCount === 1 ? '' : 's'} assembled into the
        launch package.
      </p>
    {/if}

    <div class="save-payload-row">
      <input
        type="text"
        class="input-field grow"
        placeholder="Name this payload (e.g. Act 1 briefs)"
        aria-label="Saved payload name"
        value={savedName}
        oninput={(event) => onsavename(event.currentTarget.value)}
      />
      <button type="button" class="btn-secondary btn-xs" onclick={onsave}>
        Save payload…
      </button>
    </div>
    {#if savedError}
      <p class="payload-error" role="alert">{savedError}</p>
    {/if}

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
        <span class="pin-label">Content</span>
        <span class="pin-value">
          {pinView.sourceLabel} · {pinView.inputCount} input{pinView.inputCount === 1 ? '' : 's'}{#if pinView.fileCount > 0} · {pinView.fileCount} file{pinView.fileCount === 1 ? '' : 's'}{/if}
        </span>
      </div>
    </div>
  </div>
{/if}
