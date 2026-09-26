<script>
  /**
   * Realm Manager missing-extensions panel (realm manager redesign, ticket
   * ca33e1b): the launch template's requested extensions whose tools are not
   * available in this Realm, with their live install/attach actions.
   *
   * Nothing installs or attaches automatically: the panel offers the prefilled
   * install assist (`onassist`) and the realm attach action (`onattach`) for
   * each view that allows one, and follows the live state — an extension
   * installed (and attached) after the launch resolves to `active` and drops
   * out of the flow (`buildMissingExtensionFlowViews`).
   */
  import { describeRealmExtensionState } from './extensionUiHelpers.ts';

  /**
   * @type {{
   *   views: import('./extensionUiHelpers.ts').MissingExtensionFlowView[],
   *   onassist: (view: import('./extensionUiHelpers.ts').MissingExtensionFlowView) => void,
   *   onattach: (extensionId: string) => void
   * }}
   */
  let { views, onassist, onattach } = $props();

  // Each row precomputes its live state view once, so the markup stays a
  // pure render of the flow projection.
  let rows = $derived(views.map((view) => ({ view, stateView: describeRealmExtensionState(view.state) })));
</script>

<div class="settings-section-card missing-card">
  <div class="section-card-header">
    <div class="section-title-wrap">
      <span class="section-badge missing-badge">Attention</span>
      <h4 class="section-title">Missing extensions ({views.length})</h4>
    </div>
  </div>
  <p class="extensions-hint">
    The launch template requested these extensions, but their tools are not available in this Realm.
    Nothing installs or attaches automatically — use an action below; this list follows the live state.
  </p>
  <ul class="missing-list">
    {#each rows as row (row.view.extensionId)}
      <li class="missing-row">
        <div class="missing-info">
          <div class="missing-title-row">
            <span class="missing-name">{row.view.displayName || row.view.extensionId}</span>
            <span class="kind-chip font-mono">{row.view.kind}</span>
            <span class="status-chip state-{row.stateView.state} font-mono">{row.stateView.label}</span>
            <span class="third-party-chip font-mono">{row.view.thirdPartyLabel}</span>
          </div>
          <span class="missing-note">{row.stateView.description}</span>
          {#if row.view.transportHintSummary}
            <span class="missing-transport font-mono">{row.view.transportHintSummary}</span>
          {/if}
          {#if row.view.authorComment}
            <span class="missing-author">Template note: {row.view.authorComment}</span>
          {/if}
        </div>
        <div class="missing-actions">
          {#if row.view.canInstall}
            <button type="button" class="btn-primary btn-xs" onclick={() => onassist(row.view)}>
              Install…
            </button>
          {/if}
          {#if row.view.canAttach}
            <button type="button" class="btn-secondary btn-xs" onclick={() => onattach(row.view.extensionId)}>
              Attach to this Realm
            </button>
          {/if}
          {#if !row.view.canInstall && !row.view.canAttach && row.view.state !== 'active'}
            <span class="missing-passive">
              {row.view.state === 'conflict'
                ? 'Already attached — resolve the call-name conflict to activate it.'
                : 'Already attached — the extension is currently unavailable.'}
            </span>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</div>
