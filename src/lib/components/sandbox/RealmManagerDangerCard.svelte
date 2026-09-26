<script>
  /**
   * Realm Manager danger card (realm manager redesign, ticket ca33e1b):
   * inline deletion with the Wave R semantics.
   *
   * The default deletion is refused while active or recycled members exist
   * (“terminate or delete members first”); the operator must opt into the
   * explicit recursive override, which permanently purges those members. The
   * seeded Generic Realm is never deletable. Copy comes from the pure
   * `describeRealmDeletion` model (realmGroups.ts).
   *
   * The confirmation state lives in the manager composition root, so Escape
   * backs out an armed confirmation before closing the dialog (the pre-
   * redesign behavior). This card is presentational: it renders the plan and
   * reports the operator's intent.
   */
  /**
   * @type {{
   *   plan: import('./realmGroups.ts').RealmDeletionPlan,
   *   confirming: boolean,
   *   recursive: boolean,
   *   submitting: boolean,
   *   onbegin: () => void,
   *   oncancel: () => void,
   *   ontoggle: (checked: boolean) => void,
   *   onconfirm: () => void
   * }}
   */
  let { plan, confirming, recursive, submitting, onbegin, oncancel, ontoggle, onconfirm } = $props();

  // The recursive override is only armed for a member-bearing Realm whose
  // confirmation checkbox is checked; the confirm action stays disabled until
  // then.
  let armedRecursive = $derived(plan.requiresRecursive && recursive);
</script>

<div class="settings-section-card danger-card">
  <div class="section-card-header">
    <div class="section-title-wrap">
      <span class="section-badge danger-badge">Danger</span>
      <h4 class="section-title">Delete Realm</h4>
    </div>
  </div>
  {#if plan.protected}
    <p class="danger-copy protected-copy">
      {plan.blockedCopy}
    </p>
  {:else if confirming}
    <p class="danger-copy">
      {plan.confirmCopy}
      {#if plan.requiresRecursive}
        The default deletion is refused while members exist — terminate or delete members first, or opt into the recursive override below.
      {/if}
    </p>
    {#if plan.requiresRecursive}
      <label class="recursive-option" class:active={recursive}>
        <input type="checkbox" checked={recursive} onchange={(event) => ontoggle(event.currentTarget.checked)} />
        <span class="recursive-info">
          <span class="recursive-label">{plan.recursiveLabel}</span>
          <span class="recursive-copy">{plan.recursiveCopy}</span>
        </span>
      </label>
    {/if}
    <div class="section-actions">
      <button type="button" class="btn-secondary" onclick={() => oncancel()} disabled={submitting}>Cancel</button>
      <button
        type="button"
        class="btn-danger"
        onclick={() => onconfirm()}
        disabled={submitting || (plan.requiresRecursive && !recursive)}
      >
        {#if submitting}
          Deleting…
        {:else if armedRecursive}
          {plan.confirmLabel}
        {:else}
          Confirm Delete
        {/if}
      </button>
    </div>
  {:else}
    <div class="section-actions">
      <button type="button" class="btn-danger-outline" onclick={() => onbegin()}>Delete Realm…</button>
    </div>
  {/if}
</div>
