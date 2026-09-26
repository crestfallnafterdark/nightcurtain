<script>
  /**
   * Hydration-workspace inputs card of the Realm launcher (launcher redesign
   * decomposition, ticket e1e8775): the format-v2 input requirements rendered
   * per shape (`text` fields with label/help/required/multiline, `files`
   * fields with attach/attach-folder/replace/remove), each attachment's
   * fileset path + resolved placement destinations, the derived usage map,
   * and the per-field inline errors.
   *
   * The card owns the shared picker elements and the file-reading mechanics;
   * draft state stays with the modal (the composition root) and edits travel
   * through the `ontext`/`onfiles`/`onreset` callbacks so the synthesized
   * payload and the launch gate always see the same drafts.
   */
  import {
    buildRealmInputAttachment,
    isRealmV2InputEditable,
    uniqueRealmAttachmentPath
  } from './realmLauncherHelpers.ts';
  import {
    buildRealmFileAttachmentViews,
    buildRealmInputPlacementDestinations
  } from './realmHydrationHelpers.ts';

  /**
   * @type {{
   *   drafts: Array<import('./realmLauncherHelpers.ts').RealmInputDraft>,
   *   inputErrors: Record<string, string>,
   *   effectiveInputs: import('../../sandbox/realmCatalog/index.ts').RealmInputValues,
   *   payloadInputIds: Set<string>,
   *   ontext: (inputId: string, value: string) => void,
   *   onfiles: (inputId: string, files: Array<{ path: string, content: string, name: string }>) => void,
   *   onreset: (draft: import('./realmLauncherHelpers.ts').RealmInputDraft) => void,
   *   onerror: (message: string) => void
   * }}
   */
  let { drafts, inputErrors, effectiveInputs, payloadInputIds, ontext, onfiles, onreset, onerror } = $props();

  // The files pickers are shared: the draft id they target is recorded on click.
  let inputFilesInput = $state(/** @type {HTMLInputElement | null} */(null));
  let folderFilesInput = $state(/** @type {HTMLInputElement | null} */(null));
  let replaceFileInput = $state(/** @type {HTMLInputElement | null} */(null));
  let activeFilesDraftId = $state('');
  let activeReplaceIndex = $state(-1);

  /**
   * Display value of one input (effective text, or the attached fileset's
   * paths), resolved from the effective launch values.
   *
   * @param {string} inputId - Declared input id.
   * @returns Display text.
   */
  function displayFor(inputId) {
    const value = effectiveInputs[inputId];
    if (!value) return '';
    return value.shape === 'text' ? value.text : value.files.map((file) => file.path).join(', ');
  }

  /**
   * Placement destinations of one input draft (root/path mapping rendered by
   * the fileset editor).
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Input draft.
   * @returns Derived placement destinations.
   */
  function placementDestinationsFor(draft) {
    return buildRealmInputPlacementDestinations(draft ? draft.usage : null);
  }

  /**
   * Per-file attachment rows (size + resolved placement destinations) of one
   * files draft.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Input draft.
   * @returns Per-file attachment views.
   */
  function attachmentViewsFor(draft) {
    if (!draft || draft.shape !== 'files') return [];
    return buildRealmFileAttachmentViews(draft, placementDestinationsFor(draft));
  }

  /**
   * Display destination of one placement: a `path` writes its declared path, a
   * `root` renders the prefix with a `<file path>` join marker.
   *
   * @param {import('./realmHydrationHelpers.ts').RealmInputPlacementDestination} placement - Placement destination.
   * @returns Display text.
   */
  function placementPreview(placement) {
    if (!placement || typeof placement.destination !== 'string') return '';
    if (placement.mode !== 'root') return placement.destination;
    const prefix = placement.destination.endsWith('/') ? placement.destination : `${placement.destination}/`;
    return `${prefix}<file path>`;
  }

  /**
   * The draft behind one declared input id.
   *
   * @param {string} inputId - Declared input id.
   * @returns The draft, or null.
   */
  function draftFor(inputId) {
    return drafts.find((draft) => draft.id === inputId) ?? null;
  }

  /**
   * Opens the shared file picker for one files draft.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Target files draft.
   */
  function openInputFilePicker(draft) {
    if (!draft || draft.shape !== 'files') return;
    activeFilesDraftId = draft.id;
    inputFilesInput?.click();
  }

  /**
   * Reads every picked file as a text attachment and appends it to the active
   * files draft: each attachment carries its own fileset-relative `path`
   * (the file name, made unique) so `path` selections and `root` joins resolve
   * deterministically.
   *
   * @param {Event} event - Change event of the shared file input.
   */
  async function handleInputFilesPick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const picked = input && input.files ? [...input.files] : [];
    const targetId = activeFilesDraftId;
    activeFilesDraftId = '';
    if (input) input.value = '';
    if (picked.length === 0 || !targetId) return;
    const draft = draftFor(targetId);
    if (!draft || draft.shape !== 'files') return;
    try {
      const existing = draft.files.map((file) => file.path);
      const attachments = [];
      for (const file of picked) {
        const content = await file.text();
        const attachment = buildRealmInputAttachment(file.name, content);
        attachments.push({
          ...attachment,
          path: uniqueRealmAttachmentPath(
            [...existing, ...attachments.map((entry) => entry.path)],
            attachment.path
          )
        });
      }
      onfiles(draft.id, [...draft.files, ...attachments]);
    } catch (err) {
      onerror(err && err.message ? err.message : 'The attached files could not be read.');
    }
  }

  /**
   * Opens the shared directory picker for one files draft. The `webkitdirectory`
   * attribute is set imperatively so the template stays attribute-clean; picked
   * files keep their folder-relative paths.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Target files draft.
   */
  function openInputFolderPicker(draft) {
    if (!draft || draft.shape !== 'files') return;
    if (folderFilesInput) folderFilesInput.setAttribute('webkitdirectory', '');
    activeFilesDraftId = draft.id;
    folderFilesInput?.click();
  }

  /**
   * Reads every file picked through the directory picker and appends it to the
   * active files draft, preserving each file's folder-relative path (made
   * unique); a picker that reports no relative path falls back to the file name.
   *
   * @param {Event} event - Change event of the hidden folder input.
   */
  async function handleFolderFilesPick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const picked = input && input.files ? [...input.files] : [];
    const targetId = activeFilesDraftId;
    activeFilesDraftId = '';
    if (input) input.value = '';
    if (picked.length === 0 || !targetId) return;
    const draft = draftFor(targetId);
    if (!draft || draft.shape !== 'files') return;
    try {
      const existing = draft.files.map((file) => file.path);
      const attachments = [];
      for (const file of picked) {
        const content = await file.text();
        const relative = typeof file.webkitRelativePath === 'string' && file.webkitRelativePath.length > 0
          ? file.webkitRelativePath
          : file.name;
        const attachment = buildRealmInputAttachment(relative, content);
        attachments.push({
          ...attachment,
          path: uniqueRealmAttachmentPath(
            [...existing, ...attachments.map((entry) => entry.path)],
            attachment.path
          )
        });
      }
      onfiles(draft.id, [...draft.files, ...attachments]);
    } catch (err) {
      onerror(err && err.message ? err.message : 'The attached folder could not be read.');
    }
  }

  /**
   * Opens the hidden single-file picker to replace one attachment in place: the
   * fileset path (the identity placements resolve against) is kept, only the
   * body and source name are swapped.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Target files draft.
   * @param {number} index - Attachment index.
   */
  function openReplacementFilePicker(draft, index) {
    if (!draft || draft.shape !== 'files') return;
    activeFilesDraftId = draft.id;
    activeReplaceIndex = index;
    replaceFileInput?.click();
  }

  /**
   * Replaces the active attachment's body with the picked file (path preserved).
   *
   * @param {Event} event - Change event of the hidden replace input.
   */
  async function handleReplacementFilePick(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const file = input && input.files ? input.files[0] : null;
    const targetId = activeFilesDraftId;
    const index = activeReplaceIndex;
    activeFilesDraftId = '';
    activeReplaceIndex = -1;
    if (input) input.value = '';
    if (!file || !targetId || index < 0) return;
    const draft = draftFor(targetId);
    if (!draft || draft.shape !== 'files' || index >= draft.files.length) return;
    try {
      const content = await file.text();
      onfiles(draft.id, draft.files.map((entry, position) =>
        position === index ? { ...entry, content, name: file.name } : entry
      ));
    } catch (err) {
      onerror(err && err.message ? err.message : 'The replacement file could not be read.');
    }
  }

  /**
   * Updates one attachment's fileset path (the identity `path` selections and
   * `root` placements resolve against).
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Files draft.
   * @param {number} index - Attachment index.
   * @param {string} path - New fileset-relative path.
   */
  function setAttachmentPath(draft, index, path) {
    if (!draft || draft.shape !== 'files') return;
    onfiles(draft.id, draft.files.map((file, position) =>
      position === index ? { ...file, path } : file
    ));
  }

  /**
   * Updates one attachment's body text.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Files draft.
   * @param {number} index - Attachment index.
   * @param {string} content - New body.
   */
  function setAttachmentContent(draft, index, content) {
    if (!draft || draft.shape !== 'files') return;
    onfiles(draft.id, draft.files.map((file, position) =>
      position === index ? { ...file, content } : file
    ));
  }

  /**
   * Removes one attachment from a files draft.
   *
   * @param {import('./realmLauncherHelpers.ts').RealmInputDraft} draft - Files draft.
   * @param {number} index - Attachment index.
   */
  function removeAttachment(draft, index) {
    if (!draft || draft.shape !== 'files') return;
    onfiles(draft.id, draft.files.filter((_, position) => position !== index));
  }
</script>

{#if drafts.length > 0}
  <div class="settings-section-card">
    <div class="section-card-header">
      <div class="section-title-wrap">
        <span class="section-badge">Inputs</span>
        <h4 class="section-title">Hydration workspace — inputs ({drafts.length})</h4>
      </div>
    </div>
    <p class="field-hint">
      Launch-level values shared by every member that references them. An untouched field keeps the
      attached payload's value, then the template default; an edited field is sent explicitly (clearing a
      required field blocks the launch). Files inputs carry one or more attached files (or a whole folder),
      each with its own fileset-relative path and root-mapped placement destinations.
    </p>
    <input
      bind:this={inputFilesInput}
      class="visually-hidden"
      type="file"
      multiple
      aria-label="Attach files to the selected template input"
      onchange={handleInputFilesPick}
    />
    <input
      bind:this={folderFilesInput}
      class="visually-hidden"
      type="file"
      multiple
      aria-label="Attach a folder to the selected template input"
      onchange={handleFolderFilesPick}
    />
    <input
      bind:this={replaceFileInput}
      class="visually-hidden"
      type="file"
      aria-label="Replace the selected attached file"
      onchange={handleReplacementFilePick}
    />
    {#each drafts as draft (draft.id)}
      <div class="form-group">
        <label for={`realm-input-${draft.id}`}>
          {draft.label}{#if draft.required}<span class="req"> *</span>{/if}
          <span class="shape-badge">{draft.shape === 'files' ? 'files' : 'text'}</span>
        </label>
        {#if draft.shape === 'files'}
          <div class="fileset-field">
            <div class="input-actions">
              <button type="button" class="btn-secondary btn-xs" onclick={() => openInputFilePicker(draft)}>
                Attach files…
              </button>
              <button type="button" class="btn-secondary btn-xs" onclick={() => openInputFolderPicker(draft)}>
                Attach folder…
              </button>
              {#if draft.files.length > 0}
                <span class="input-dirty-note">
                  {draft.files.length} file{draft.files.length === 1 ? '' : 's'} attached
                </span>
              {/if}
            </div>
            {#if draft.files.length === 0}
              <span class="field-hint">No files attached — an absent optional fileset writes nothing.</span>
            {/if}
            {#if placementDestinationsFor(draft).length > 0}
              <ul class="placement-map">
                {#each placementDestinationsFor(draft) as placement, placementIndex (placementIndex)}
                  <li class="placement-row">
                    <span class="placement-mode">{placement.mode === 'root' ? 'root' : 'path'}</span>
                    <span class="placement-target">{placement.targetLabel}</span>
                    <span class="placement-destination font-mono">
                      {placementPreview(placement)}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
            {#each attachmentViewsFor(draft) as view (view.index)}
              <div class="attachment-row">
                <div class="attachment-head">
                  <input
                    type="text"
                    class="input-field font-mono"
                    value={draft.files[view.index].path}
                    aria-label={`Attachment ${view.index + 1} fileset path`}
                    oninput={(event) => setAttachmentPath(draft, view.index, event.currentTarget.value)}
                  />
                  <button
                    type="button"
                    class="btn-secondary btn-xs"
                    onclick={() => openReplacementFilePicker(draft, view.index)}
                    aria-label={`Replace attachment ${view.index + 1}`}
                  >
                    Replace…
                  </button>
                  <button
                    type="button"
                    class="btn-row-remove"
                    onclick={() => removeAttachment(draft, view.index)}
                    aria-label={`Remove attachment ${view.index + 1}`}
                  >
                    Remove
                  </button>
                </div>
                <span class="field-hint">
                  {view.sizeLabel}{view.name ? ` · from ${view.name}` : ' · typed fileset path'}
                </span>
                {#if view.destinations.length > 0}
                  <span class="field-hint attachment-destinations">
                    Writes:
                    {#each view.destinations as destination, destinationIndex (destinationIndex)}
                      <span class="font-mono">{destination}</span>{destinationIndex < view.destinations.length - 1 ? ', ' : ''}
                    {/each}
                  </span>
                {/if}
                <details class="attachment-content">
                  <summary>Content ({draft.files[view.index].content.length} chars)</summary>
                  <textarea
                    rows="3"
                    class="textarea-field font-mono"
                    value={draft.files[view.index].content}
                    aria-label={`Attachment ${view.index + 1} content`}
                    oninput={(event) => setAttachmentContent(draft, view.index, event.currentTarget.value)}
                  ></textarea>
                </details>
              </div>
            {/each}
          </div>
        {:else if draft.multiline}
          <textarea
            id={`realm-input-${draft.id}`}
            value={displayFor(draft.id)}
            rows="3"
            class="textarea-field"
            disabled={!isRealmV2InputEditable(draft)}
            oninput={(event) => ontext(draft.id, event.currentTarget.value)}
          ></textarea>
        {:else}
          <input
            id={`realm-input-${draft.id}`}
            type="text"
            value={displayFor(draft.id)}
            class="input-field"
            disabled={!isRealmV2InputEditable(draft)}
            oninput={(event) => ontext(draft.id, event.currentTarget.value)}
          />
        {/if}
        {#if !draft.dirty && payloadInputIds.has(draft.id)}
          <span class="field-hint payload-input-note">
            Attached payload value — edit the field to override it explicitly.
          </span>
        {/if}
        {#if draft.brief}
          <span class="field-hint hydration-brief">Brief: {draft.brief}</span>
        {/if}
        {#if draft.help}
          <span class="field-hint">{draft.help}</span>
        {/if}
        {#if draft.shape === 'text' && !draft.defaultResolved}
          <span class="field-hint input-warning">
            The template's default file is not in the launch bundle — the field starts empty.
          </span>
        {/if}
        <div class="input-actions">
          <button type="button" class="btn-secondary btn-xs" onclick={() => onreset(draft)}>
            {draft.shape === 'files' ? 'Clear attached files' : 'Reset to template default'}
          </button>
          {#if draft.dirty}
            <span class="input-dirty-note">Edited — sent explicitly at launch.</span>
          {/if}
        </div>
        <div class="usage-map">
          <span class="usage-summary">Usage: {draft.usage.summary}</span>
          {#if draft.usage.sites.length > 0}
            <ul class="usage-list">
              {#each draft.usage.sites as site, index (index)}
                <li class="usage-row">
                  <span class="usage-kind">{site.kind}</span>
                  <span class="usage-label">{site.label}</span>
                  {#if site.path}
                    <span class="usage-path font-mono">{site.path}</span>
                  {/if}
                  <span class="usage-detail">{site.detail}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
        {#if inputErrors[draft.id]}
          <span class="input-error" role="alert">{inputErrors[draft.id]}</span>
        {/if}
      </div>
    {/each}
  </div>
{/if}
