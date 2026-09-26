<script>
  /**
   * Declared-publishing-authorities card of the Realm launcher (launcher
   * redesign decomposition, ticket e1e8775): per-agent declaration rows with
   * explicit approval checkboxes (unchecked = declined), the unknown-authority
   * fail-closed notice, and the "trust this template" control with the
   * persisted trust record.
   *
   * Decision state stays with the modal; this card only renders it and reports
   * checkbox/toggle changes.
   */
  /**
   * @type {{
   *   rows: ReadonlyArray<import('./realmReviewHelpers.ts').RealmAuthorityReviewAgent>,
   *   unknownAuthorities: ReadonlyArray<string>,
   *   trustView: import('./realmReviewHelpers.ts').RealmAuthorityTrustView,
   *   trustTemplate: boolean,
   *   decisionFor: (agentKey: string, authority: string) => import('./realmReviewHelpers.ts').RealmAuthorityDecision,
   *   ondecision: (agentKey: string, authority: string, checked: boolean) => void,
   *   ontrusttoggle: (checked: boolean) => void,
   *   oncleartrust: () => void
   * }}
   */
  let {
    rows,
    unknownAuthorities,
    trustView,
    trustTemplate,
    decisionFor,
    ondecision,
    ontrusttoggle,
    oncleartrust
  } = $props();

  /**
   * Whether one declared pair is checked (approved or trust-auto-approved).
   *
   * @param {string} agentKey - Template agent key.
   * @param {string} authority - Declared authority id.
   * @returns True while the pair is checked.
   */
  function authorityChecked(agentKey, authority) {
    const decision = decisionFor(agentKey, authority);
    return decision === 'approved' || decision === 'trusted';
  }

  /**
   * Whether one declared pair renders locked by the template trust override.
   *
   * @param {string} agentKey - Template agent key.
   * @param {string} authority - Declared authority id.
   * @returns True while the pair is trust-auto-approved.
   */
  function authorityTrusted(agentKey, authority) {
    return decisionFor(agentKey, authority) === 'trusted';
  }
</script>

{#if rows.length > 0}
  <div class="settings-section-card">
    <div class="section-card-header">
      <div class="section-title-wrap">
        <span class="section-badge">Authorities</span>
        <h4 class="section-title">Declared publishing authorities</h4>
      </div>
      {#if trustView.trusted}
        <span class="trust-badge">trusted</span>
      {/if}
    </div>
    <p class="field-hint">
      Publishing is an explicit operator grant — never implied by privilege or the wildcard. Check a request
      to approve it for this launch; unchecked requests are declined and the launched agent simply lacks the
      authority. Approved grants are ordinary revocable operator grants.
    </p>
    {#if unknownAuthorities.length > 0}
      <p class="payload-error" role="alert">
        Unknown declared authorit{unknownAuthorities.length === 1 ? 'y' : 'ies'}:
        {unknownAuthorities.join(', ')} — this host cannot enforce
        {unknownAuthorities.length === 1 ? 'it' : 'them'}, so the launch fails closed.
      </p>
    {/if}
    {#each rows as row (row.key)}
      <div class="authority-agent">
        <div class="authority-agent-head">
          <span class="authority-agent-name">{row.name}</span>
          <span class="authority-agent-key font-mono">{row.key}</span>
          {#if row.privileged}
            <span class="badge badge-sudo" title="Privilege is disclosed separately and never implies these authorities">⚡ sudo</span>
          {/if}
        </div>
        {#each row.declarations as declaration (declaration.authority)}
          <label
            class="authority-row"
            class:authority-row-trusted={authorityTrusted(row.key, declaration.authority)}
          >
            <input
              type="checkbox"
              checked={authorityChecked(row.key, declaration.authority)}
              disabled={authorityTrusted(row.key, declaration.authority) || !declaration.known}
              onchange={(event) => ondecision(row.key, declaration.authority, event.currentTarget.checked)}
            />
            <div class="authority-info">
              <div class="authority-title-row">
                <span class="authority-title font-mono">{declaration.authority}</span>
                <span class="authority-label">{declaration.label}</span>
                {#if authorityTrusted(row.key, declaration.authority)}
                  <span class="trust-badge">trust-auto-approved</span>
                {/if}
                {#if !declaration.known}
                  <span class="unknown-badge">unknown to this host</span>
                {/if}
              </div>
              <span class="policy-desc">{declaration.description}</span>
            </div>
          </label>
        {/each}
      </div>
    {/each}

    <div class="trust-control">
      {#if trustView.trusted}
        <p class="payload-status">{trustView.summary}</p>
        {#if trustView.pairs.length > 0}
          <ul class="written-paths">
            {#each trustView.pairs as pair (`${pair.agentKey}::${pair.authority}`)}
              <li class="font-mono">{pair.agentKey} → {pair.authority}</li>
            {/each}
          </ul>
        {/if}
        <div class="template-picker-actions">
          <button type="button" class="btn-danger-outline btn-xs" onclick={oncleartrust}>
            Clear trust override
          </button>
        </div>
      {:else}
        <p class="field-hint">No trust override is stored for this template.</p>
      {/if}
      <label class="seed-toggle">
        <input
          type="checkbox"
          checked={trustTemplate}
          onchange={(event) => ontrusttoggle(event.currentTarget.checked)}
        />
        <span>Trust this template for these exact approvals (persisted on a successful launch)</span>
      </label>
      <span class="field-hint">
        Trust auto-approves only the exact (agent, authority) set approved now; a newly declared authority
        re-prompts, and clearing the override revokes it (already-applied grants stay revocable through the
        agent settings toggles).
      </span>
    </div>
  </div>
{/if}
