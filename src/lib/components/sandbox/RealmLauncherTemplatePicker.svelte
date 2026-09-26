<script>
  /**
   * Template picker card of the Realm launcher (launcher redesign
   * decomposition, ticket e1e8775): the effective-catalog select plus the
   * registry controls (import a canonical bundle, export the effective bundle,
   * delete an imported revision behind an inline confirmation). The card owns
   * its picker elements and inline confirmation state; catalog mutations and
   * notices stay with the modal (the composition root).
   */
  import {
    describeRealmTemplateDeletion
  } from './realmTemplateHelpers.ts';

  /**
   * @type {{
   *   entries: Array<import('./realmTemplateHelpers.ts').RealmTemplateCatalogEntry>,
   *   selectedTemplateId: string,
   *   selectedTemplate: import('../../sandbox/realmCatalog/index.ts').RealmTemplate | null,
   *   selectedTemplateEntry: import('./realmTemplateHelpers.ts').RealmTemplateCatalogEntry | null,
   *   onselect: (templateId: string) => void,
   *   onimport: (file: File) => Promise<void>,
   *   onexport: () => void,
   *   ondelete: () => void
   * }}
   */
  let {
    entries,
    selectedTemplateId,
    selectedTemplate,
    selectedTemplateEntry,
    onselect,
    onimport,
    onexport,
    ondelete
  } = $props();

  let templateImportInput = $state(/** @type {HTMLInputElement | null} */(null));
  let isImporting = $state(false);
  let deleteConfirming = $state(false);
  let deletePlan = $derived(describeRealmTemplateDeletion(selectedTemplateEntry));

  // A selection change (operator, import, or delete) always re-arms the
  // inline delete confirmation.
  $effect(() => {
    void selectedTemplateId;
    deleteConfirming = false;
  });

  /**
   * Reads one picked canonical bundle file and hands it to the modal, which
   * imports it into the store and surfaces typed failures.
   *
   * @param {Event} event - Change event of the hidden file input.
   */
  async function handleImport(event) {
    const input = /** @type {HTMLInputElement | null} */ (event.currentTarget);
    const file = input && input.files ? input.files[0] : null;
    if (!file) return;
    isImporting = true;
    try {
      await onimport(file);
    } finally {
      isImporting = false;
      if (input) input.value = '';
    }
  }
</script>

<div class="form-group">
  <label for="realm-template-select">Template <span class="req">*</span></label>
  <div class="template-picker-row">
    <select
      id="realm-template-select"
      value={selectedTemplateId}
      onchange={(event) => onselect(event.currentTarget.value)}
      class="select-field"
    >
      <option value="">Select a template…</option>
      {#each entries as entry (entry.id)}
        <option value={entry.id}>{entry.name} — {entry.sourceLabel}</option>
      {/each}
    </select>
    <div class="template-picker-actions">
      <button
        type="button"
        class="btn-secondary btn-xs"
        onclick={() => templateImportInput?.click()}
        disabled={isImporting}
      >
        {isImporting ? 'Importing…' : 'Import…'}
      </button>
      <button
        type="button"
        class="btn-secondary btn-xs"
        onclick={onexport}
        disabled={!selectedTemplate}
      >
        Export
      </button>
    </div>
  </div>
  <input
    bind:this={templateImportInput}
    class="visually-hidden"
    type="file"
    accept="application/json,.json"
    aria-label="Import realm template bundle"
    onchange={handleImport}
  />
  {#if selectedTemplateEntry}
    <span class="template-source-line">
      Source:
      <span class="source-badge" class:source-imported={selectedTemplateEntry.source === 'imported'}>
        {selectedTemplateEntry.sourceLabel}
      </span>
      {#if selectedTemplateEntry.templateVersion}
        <span class="template-version font-mono">{selectedTemplateEntry.templateVersion}</span>
      {/if}
    </span>
  {/if}
  {#if selectedTemplate}
    <span class="field-hint">{selectedTemplate.description}</span>
  {:else}
    <span class="field-hint">
      Shipped templates ship with the sandbox; import a canonical bundle JSON to add your own. The agent
      preview appears once one is selected.
    </span>
  {/if}
  {#if selectedTemplateEntry && selectedTemplateEntry.deletable}
    {#if deleteConfirming}
      <div class="template-delete-confirm">
        <p class="template-delete-copy">{deletePlan.confirmCopy}</p>
        <div class="template-picker-actions">
          <button type="button" class="btn-secondary btn-xs" onclick={() => deleteConfirming = false}>
            Cancel
          </button>
          <button type="button" class="btn-danger btn-xs" onclick={() => { deleteConfirming = false; ondelete(); }}>
            {deletePlan.confirmLabel}
          </button>
        </div>
      </div>
    {:else}
      <div class="template-picker-actions">
        <button type="button" class="btn-danger-outline btn-xs" onclick={() => deleteConfirming = true}>
          Delete Import…
        </button>
      </div>
    {/if}
  {/if}
</div>
