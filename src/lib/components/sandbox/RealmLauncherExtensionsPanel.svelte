<script>
  /**
   * Requested-extensions card of the Realm launcher (launcher redesign
   * decomposition, ticket e1e8775): the template's declared extension requests
   * with their live resolution/connection disclosure and per-request attach
   * approvals (installation is never automatic), the per-agent extension tool
   * references with their resolution state, and the third-party trust
   * disclosure.
   *
   * Connection/install actions stay with the modal (the install dialog lives
   * there); this card reports the operator's decisions.
   */
  import {
    REALM_EXTENSION_TRUST_DISCLOSURE,
    describeRealmExtensionState
  } from './extensionUiHelpers.ts';

  /**
   * @type {{
   *   requests: import('./extensionUiHelpers.ts').RealmExtensionRequestViews,
   *   references: import('./extensionUiHelpers.ts').RealmExtensionReferenceViews,
   *   decisions: Record<string, 'approved' | 'declined'>,
   *   ondecision: (extensionId: string, checked: boolean) => void,
   *   oninstall: (extensionId: string) => void
   * }}
   */
  let { requests, references, decisions, ondecision, oninstall } = $props();
</script>

{#if requests.requests.length > 0 || references.references.length > 0}
  <div class="settings-section-card">
    <div class="section-card-header">
      <div class="section-title-wrap">
        <span class="section-badge">Extensions</span>
        <h4 class="section-title">Requested extensions</h4>
      </div>
    </div>

    {#if !requests.ok}
      <p class="payload-error" role="alert">{requests.error}</p>
    {:else if requests.requests.length > 0}
      <p class="field-hint">
        This template requests these extensions. Approving records an attach approval for the Realm being
        created: only globally installed extensions actually attach, and an approved-but-uninstalled request
        stays disclosed and listed after the launch. Nothing connects automatically.
      </p>
      {#each requests.requests as request (request.id)}
        {@const stateView = describeRealmExtensionState(request.state)}
        <div class="extension-request">
          <label class="extension-approval">
            <input
              type="checkbox"
              checked={decisions[request.id] === 'approved'}
              onchange={(event) => ondecision(request.id, event.currentTarget.checked)}
            />
            <div class="extension-request-info">
              <div class="extension-request-title-row">
                <span class="extension-request-name font-mono">{request.id}</span>
                <span class="kind-chip font-mono">{request.kind}</span>
                <span class="status-chip state-{stateView.state} font-mono">{stateView.label}</span>
                {#if request.connected}
                  <span class="live-chip live-connected font-mono">connected · {request.liveToolCount} tools</span>
                {:else if request.installed && request.connectionStatus !== 'disconnected'}
                  <span class="live-chip live-{request.connectionStatus} font-mono">{request.connectionStatus}</span>
                {/if}
                {#if request.fidelityBadge}
                  <span class="fidelity-chip font-mono">{request.fidelityBadge}</span>
                {/if}
                {#if request.installed && request.installSource === 'template-assist'}
                  <span class="source-chip font-mono">template-assist</span>
                {/if}
                <span class="third-party-chip font-mono">{request.thirdPartyLabel}</span>
              </div>
              <span class="extension-request-detail">{stateView.description}</span>
              {#if request.disclosure}
                <span class="extension-request-disclosure">{request.disclosure}</span>
              {/if}
              {#if request.declaredTransportSummary}
                <span class="extension-request-transport font-mono">{request.declaredTransportSummary}</span>
              {/if}
              {#if request.approvedUrl}
                <span class="extension-request-detail">
                  approved URL: <code class="font-mono">{request.approvedUrl}</code>
                </span>
              {/if}
              {#if request.credentialId}
                <span class="extension-request-detail">
                  credential: <code class="font-mono">{request.credentialId}</code>
                </span>
              {/if}
            </div>
          </label>
          {#if !request.installed}
            <button type="button" class="btn-secondary btn-xs" onclick={() => oninstall(request.id)}>
              Install…
            </button>
          {/if}
        </div>
      {/each}
    {/if}

    {#if references.references.length > 0}
      <details class="extension-references">
        <summary>
          Extension tool references ({references.references.length}) — resolved against installed
          extensions
        </summary>
        {#if !references.ok}
          <p class="payload-error" role="alert">{references.error}</p>
        {:else}
          <ul class="extension-reference-list">
            {#each references.references as ref, index (`${ref.agentKey}::${ref.reference}::${index}`)}
              <li class="extension-reference-row">
                <span class="extension-reference-agent">{ref.agentName}</span>
                <span class="extension-reference-name font-mono">{ref.callName}</span>
                <span class="extension-reference-origin font-mono">{ref.reference}</span>
                <span class="ref-state ref-state-{ref.referenceState} font-mono">{ref.referenceState}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </details>
    {/if}

    <div class="trust-disclosure">
      <span class="trust-disclosure-title">Third-party trust</span>
      <ul class="trust-disclosure-list">
        {#each REALM_EXTENSION_TRUST_DISCLOSURE as line (line.key)}
          <li><span class="trust-disclosure-line-title">{line.title}</span> — {line.body}</li>
        {/each}
      </ul>
    </div>
  </div>
{/if}
