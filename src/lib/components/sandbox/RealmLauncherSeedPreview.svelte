<script>
  /**
   * Template-seed summary card of the Realm launcher (launcher redesign
   * decomposition, ticket e1e8775): the declared placement/directive summary,
   * the catalog-resolved directive review, the resolved destination count
   * with the files-dialog entry point, and the seed-after-launch toggle.
   *
   * Purely presentational: the toggle and the dialog travel through callbacks.
   */
  /**
   * @type {{
   *   seedSummary: import('./realmLauncherHelpers.ts').RealmSeedSummary,
   *   directiveReview: import('./realmHydrationHelpers.ts').RealmDirectiveReview,
   *   fileSlots: Array<import('./realmReviewHelpers.ts').RealmReviewFileSlot>,
   *   editedFileSlotCount: number,
   *   conflictedFileSlotCount: number,
   *   attachedPayload: unknown,
   *   seedAfterLaunch: boolean,
   *   onseedtoggle: (checked: boolean) => void,
   *   onopenfiles: () => void
   * }}
   */
  let {
    seedSummary,
    directiveReview,
    fileSlots,
    editedFileSlotCount,
    conflictedFileSlotCount,
    attachedPayload,
    seedAfterLaunch,
    onseedtoggle,
    onopenfiles
  } = $props();
</script>

{#if seedSummary.declaresSeed}
  <div class="settings-section-card">
    <div class="section-card-header">
      <div class="section-title-wrap">
        <span class="section-badge">Seed</span>
        <h4 class="section-title">Template seed</h4>
      </div>
    </div>
    <p class="seed-summary-line">
      {seedSummary.placementCount ?? seedSummary.fileCount}
      placement{(seedSummary.placementCount ?? seedSummary.fileCount) === 1 ? '' : 's'} write at launch into
      {seedSummary.targetLabels.length > 0 ? seedSummary.targetLabels.join(', ') : 'no target'}{#if seedSummary.directiveCount} · {seedSummary.directiveCount} directive{seedSummary.directiveCount === 1 ? '' : 's'}{/if}.
    </p>
    {#if directiveReview.entries.length > 0}
      <div class="directive-review">
        <span class="slot-list-title">Directives ({directiveReview.entries.length})</span>
        {#each directiveReview.entries as entry, index (index)}
          <div class="directive-row">
            <span class="directive-target">
              → {entry.targetLabel}
              {#if entry.source === 'input'}
                <span class="field-hint">bound to "{entry.inputLabel}"</span>
              {:else}
                <span class="field-hint">literal directive</span>
              {/if}
            </span>
            {#if entry.error}
              <span class="input-error" role="alert">{entry.error}</span>
            {:else if entry.text}
              <span class="seed-directive-preview">“{entry.text}”</span>
            {:else}
              <span class="field-hint">resolves empty — this directive delivers nothing.</span>
            {/if}
          </div>
        {/each}
      </div>
    {:else if seedSummary.directive}
      <p class="seed-summary-line">
        First directive → {seedSummary.directive.targetLabel}:
        <span class="seed-directive-preview">“{seedSummary.directive.preview}”</span>
      </p>
    {/if}
    {#if fileSlots.length > 0}
      <div class="slot-list">
        <span class="slot-list-title">
          Destinations ({fileSlots.length}){#if editedFileSlotCount > 0} · {editedFileSlotCount} edited{/if}{#if conflictedFileSlotCount > 0} · {conflictedFileSlotCount} conflict{conflictedFileSlotCount === 1 ? '' : 's'}{/if}{#if attachedPayload} · payload attached{/if}
        </span>
        <div class="template-picker-actions">
          <button type="button" class="btn-secondary btn-xs" onclick={onopenfiles}>
            Review file contents…
          </button>
        </div>
        <span class="field-hint">
          Every declared placement with its resolved content. Bundle-file destinations ship in the bundle;
          input destinations resolve from the launch inputs (then the attached payload) and are edited at
          the input field above.
        </span>
      </div>
    {/if}
    <label class="seed-toggle">
      <input
        type="checkbox"
        checked={seedAfterLaunch}
        onchange={(event) => onseedtoggle(event.currentTarget.checked)}
      />
      <span>Seed after launch</span>
    </label>
    <span class="field-hint">
      On by default. Turn it off to launch without the template seed and seed manually afterwards.
    </span>
    {#if attachedPayload && !seedAfterLaunch}
      <span class="field-hint payload-input-note">
        Seeding is off — the attached payload's file content will not be written at launch.
      </span>
    {/if}
  </div>
{/if}
