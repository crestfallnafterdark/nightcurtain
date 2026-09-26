<script>
  /**
   * Resolved-file-contents dialog of the Realm launcher (launcher redesign
   * decomposition, ticket e1e8775): every declared placement with its resolved
   * content and provenance; non-`fixed` slots are editable in place and the
   * edit travels into the launch package.
   *
   * The dialog is read-only for `fixed`/bundle destinations; edits are keyed by
   * the slot key and owned by the modal so the launch payload resolution sees
   * them.
   */
  /**
   * @typedef {{
   *   slots: ReadonlyArray<import('./realmReviewHelpers.ts').RealmReviewFileSlot>,
   *   mismatchUnconfirmed: boolean,
   *   onedit: (slot: import('./realmReviewHelpers.ts').RealmReviewFileSlot, value: string) => void,
   *   onreset: (slot: import('./realmReviewHelpers.ts').RealmReviewFileSlot) => void,
   *   onclose: () => void
   * }} RealmLauncherFilesDialogProps
   */

  // NOTE: the destructuring stays un-annotated on purpose — a JSDoc comment
  // adjacent to a `$props()` destructuring pattern makes the Svelte 5 compiler
  // drop the `var [` binding token on this template (observed at HEAD with
  // svelte 5); the props type is documented above.
  let { slots, mismatchUnconfirmed, onedit, onreset, onclose } = $props();
</script>

<div class="files-dialog-backdrop">
  <div class="files-dialog" role="dialog" aria-modal="true" aria-label="Resolved file contents">
    <div class="files-dialog-header">
      <div class="section-title-wrap">
        <span class="section-badge">Files</span>
        <h4 class="section-title">Resolved file contents ({slots.length})</h4>
      </div>
      <button type="button" class="btn-close" onclick={onclose} aria-label="Close files dialog">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <p class="field-hint">
      Every declared placement with its resolved content. Bundle-file destinations ship in the bundle;
      input destinations resolve from the launch inputs (then the attached payload) and are edited at the input
      field — this dialog is read-only.
    </p>
    {#if mismatchUnconfirmed}
      <p class="field-hint payload-input-note">
        The attached payload pins a different template version — confirm the mismatch in the review before its
        content resolves here.
      </p>
    {/if}
    {#if slots.length === 0}
      <p class="rows-empty">This template declares no placements.</p>
    {/if}
    {#each slots as slot (slot.key)}
      <div class="file-slot" class:file-slot-fixed={slot.source === 'bundle'} class:file-slot-conflict={slot.conflict}>
        <div class="file-slot-head">
          <span class="slot-path font-mono">{slot.path}</span>
          <span
            class="slot-origin"
            class:origin-generated={slot.origin === 'generated'}
            class:origin-user={slot.origin === 'user'}
          >
            {slot.origin}
          </span>
          {#if slot.required}
            <span class="required-badge">required</span>
          {/if}
          {#if slot.conflict}
            <span class="unknown-badge">conflict</span>
          {/if}
          <span class="file-slot-source">{slot.sourceLabel}</span>
        </div>
        <span class="field-hint">
          {slot.targetLabel}{#if slot.inputLabel} · input "{slot.inputLabel}"{/if}{#if slot.brief} · {slot.brief}{/if}
        </span>
        {#if slot.editable}
          <textarea
            rows="4"
            class="textarea-field font-mono"
            value={slot.content}
            aria-label={`Content for ${slot.path}`}
            oninput={(event) => onedit(slot, event.currentTarget.value)}
          ></textarea>
          <div class="input-actions">
            <button type="button" class="btn-secondary btn-xs" disabled={!slot.edited} onclick={() => onreset(slot)}>
              Reset to source
            </button>
            {#if slot.edited}
              <span class="input-dirty-note">Edited — travels in the launch payload.</span>
            {/if}
          </div>
        {:else}
          <pre class="file-slot-readonly">{slot.content}</pre>
          <span class="field-hint">
            {slot.source === 'bundle'
              ? 'Shipped in the bundle — the format forbids payload overrides for bundle-file destinations.'
              : 'Resolved from the input — edit it at the input field above.'}
          </span>
        {/if}
      </div>
    {/each}
    <div class="modal-footer compact">
      <button type="button" class="btn-primary" onclick={onclose}>Done</button>
    </div>
  </div>
</div>
