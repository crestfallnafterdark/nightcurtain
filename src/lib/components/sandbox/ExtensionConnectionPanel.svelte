<script>
  /**
   * Live extension connection panel (extension wave, P3.4): the operator
   * controls and disclosures for one installed MCP extension.
   *
   * All projections are computed by the pure helpers in `extensionUiHelpers.ts`
   * (`buildExtensionConnectionView` + the fidelity/drift/error helpers); this
   * component only renders them and performs the explicit operator action the
   * button names — it never connects, reconnects, or disconnects on its own.
   * Secrets never reach this surface: the store's connection projection is
   * secret-free, and failures render as the typed code plus fixed safe copy.
   */
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import {
    buildExtensionConnectionView,
    describeExtensionConnectionError,
    EXTENSION_THIRD_PARTY_LABEL
  } from './extensionUiHelpers.ts';

  let {
    record,
    connection = null,
    labels = {},
    onstatus = () => {}
  } = $props();

  let busy = $state(false);
  let actionError = $state('');

  const view = $derived(buildExtensionConnectionView(record, connection));

  /**
   * Runs one explicit operator connection action and surfaces the typed
   * failure inline. Never dials anything that the operator did not click.
   *
   * @param {'connect' | 'disconnect' | 'reconnect'} action - Action to run.
   */
  async function runAction(action) {
    if (busy) return;
    busy = true;
    actionError = '';
    try {
      if (action === 'connect') {
        await sandboxStore.connectExtension(record.id);
        onstatus(`Connected "${view.label}".`);
      } else if (action === 'disconnect') {
        await sandboxStore.disconnectExtension(record.id);
        onstatus(`Disconnected "${view.label}".`);
      } else {
        await sandboxStore.reconnectExtension(record.id);
        onstatus(`Reconnected "${view.label}".`);
      }
    } catch (err) {
      const failure = describeExtensionConnectionError(err);
      actionError = `${failure.code}: ${failure.message}`;
    } finally {
      busy = false;
    }
  }

  /**
   * Display label of one conflict counterpart.
   *
   * @param {string} extensionId - Counterpart extension id.
   * @returns {string} Display label.
   */
  function counterpartLabel(extensionId) {
    return labels && labels[extensionId] ? labels[extensionId] : extensionId;
  }
</script>

<div class="connection-panel" data-extension-connection={record.id}>
  <div class="connection-status-row">
    {#if view.status.chip}
      <span class="conn-chip conn-{view.status.state} font-mono">{view.status.label}</span>
    {/if}
    <span class="third-party-chip font-mono" title={view.thirdPartyLabel}>{view.thirdPartyLabel}</span>
    {#if view.serverName}
      <span class="connection-meta font-mono">
        {view.serverName} {view.serverVersion}{view.protocolVersion ? ` · protocol ${view.protocolVersion}` : ''}
      </span>
    {/if}
  </div>

  <p class="connection-description">{view.status.description}</p>

  <div class="connection-controls">
    {#if view.canConnect}
      <button
        type="button"
        class="btn-conn btn-connect"
        disabled={busy}
        onclick={() => runAction('connect')}
        aria-label="Connect extension {record.id}"
      >
        {busy ? 'Working…' : 'Connect'}
      </button>
    {/if}
    {#if view.canDisconnect}
      <button
        type="button"
        class="btn-conn btn-disconnect"
        disabled={busy}
        onclick={() => runAction('disconnect')}
        aria-label="Disconnect extension {record.id}"
      >
        Disconnect
      </button>
    {/if}
    {#if view.canReconnect}
      <button
        type="button"
        class="btn-conn btn-reconnect"
        disabled={busy}
        onclick={() => runAction('reconnect')}
        aria-label="Reconnect extension {record.id}"
      >
        Reconnect
      </button>
    {/if}
    {#if view.controlsHint}
      <span class="connection-hint">{view.controlsHint}</span>
    {/if}
  </div>

  {#if actionError}
    <p class="connection-error" role="alert">{actionError}</p>
  {/if}

  {#if view.error}
    <div class="connection-error-block" role="alert">
      <span class="error-code font-mono">{view.error.code}</span>
      <span>{view.error.message}</span>
      {#if view.error.details.length > 0}
        <ul class="error-details font-mono">
          {#each view.error.details as detail, index (index)}
            <li>{detail}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if view.toolCount > 0}
    <div class="catalog-row">
      <span class="catalog-count font-mono">{view.toolCount} tool{view.toolCount === 1 ? '' : 's'}</span>
      {#if view.digest}
        <span class="catalog-digest font-mono" title="Catalog digest">{view.digest}</span>
      {/if}
      {#if view.fidelity && view.fidelity.badge}
        <span class="fidelity-badge ${view.fidelity.state === 'degraded' ? 'degraded' : ''} font-mono">
          {view.fidelity.badge}
        </span>
      {/if}
    </div>
    {#if view.fidelity}
      <details class="disclosure fidelity-details">
        <summary>Schema fidelity details ({view.fidelity.warned} warned{view.fidelity.refused > 0 ? `, ${view.fidelity.refused} refused` : ''})</summary>
        <p class="disclosure-note">{view.fidelity.summary}</p>
        {#if view.fidelity.warnings.length > 0}
          <ul class="disclosure-list font-mono">
            {#each view.fidelity.warnings as warning (`${warning.callName}::${warning.code}::${warning.path}`)}
              <li>{warning.callName} · {warning.code} @ {warning.path}</li>
            {/each}
          </ul>
        {/if}
        {#if view.fidelity.refusals.length > 0}
          <ul class="disclosure-list refused font-mono">
            {#each view.fidelity.refusals as refusal (`${refusal.callName}::${refusal.code}`)}
              <li>{refusal.callName} · {refusal.code}{refusal.path ? ` @ ${refusal.path}` : ''}</li>
            {/each}
          </ul>
        {/if}
      </details>
    {/if}
  {/if}

  {#if view.shadows.length > 0}
    <details class="disclosure">
      <summary>Shadowed tools ({view.shadows.length}) — a later server tool lost the call-name race</summary>
      <ul class="disclosure-list font-mono">
        {#each view.shadows as shadow (`${shadow.callName}::${shadow.serverToolName}`)}
          <li>{shadow.serverToolName} → shadowed by {shadow.callName}</li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if view.conflicts.length > 0}
    <div class="conflict-block" role="status">
      <span class="conflict-title">Active conflicts ({view.conflicts.length})</span>
      <ul class="disclosure-list font-mono">
        {#each view.conflicts as conflict (`${conflict.callName}::${conflict.otherExtensionId}`)}
          <li>{conflict.callName} — claimed first by {counterpartLabel(conflict.otherExtensionId)}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if view.drift && view.drift.visible}
    <details class="disclosure">
      <summary>Reconnect drift — {view.drift.summary}</summary>
      {#if view.drift.added.length > 0}
        <p class="disclosure-note font-mono">added: {view.drift.added.join(', ')}</p>
      {/if}
      {#if view.drift.removed.length > 0}
        <p class="disclosure-note font-mono">removed: {view.drift.removed.join(', ')}</p>
      {/if}
      {#if view.drift.changed.length > 0}
        <p class="disclosure-note font-mono">changed: {view.drift.changed.join(', ')}</p>
      {/if}
      {#if view.drift.shadowedAdded.length > 0}
        <p class="disclosure-note font-mono">newly shadowed: {view.drift.shadowedAdded.join(', ')}</p>
      {/if}
      {#if view.drift.shadowedRemoved.length > 0}
        <p class="disclosure-note font-mono">shadows cleared: {view.drift.shadowedRemoved.join(', ')}</p>
      {/if}
      {#if view.drift.reordered}
        <p class="disclosure-note">catalog order changed</p>
      {/if}
      <p class="disclosure-note font-mono">{view.drift.previousDigest || '(none)'} → {view.drift.nextDigest}</p>
    </details>
  {/if}

  {#if view.connectedAt || view.discoveredAt}
    <div class="connection-times font-mono">
      {#if view.connectedAt}<span>connected {view.connectedAt}</span>{/if}
      {#if view.discoveredAt}<span>discovered {view.discoveredAt}</span>{/if}
    </div>
  {/if}
</div>

<style>
  .connection-panel {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.5rem;
    padding-top: 0.5rem;
    border-top: 1px dashed var(--border-subtle);
  }

  .connection-status-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .conn-chip {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    border: 1px solid var(--border-color);
  }

  .conn-connected {
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.45);
    background: rgba(52, 211, 153, 0.12);
  }

  .conn-connecting {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.45);
    background: rgba(251, 191, 36, 0.12);
  }

  .conn-conflict,
  .conn-error {
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.5);
    background: rgba(248, 113, 113, 0.12);
  }

  .third-party-chip {
    font-size: 0.62rem;
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.08rem 0.35rem;
  }

  .connection-meta {
    font-size: 0.68rem;
    color: var(--text-secondary);
  }

  .connection-description {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--text-muted);
  }

  .connection-controls {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .btn-conn {
    border-radius: 6px;
    padding: 0.3rem 0.7rem;
    font-size: 0.74rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid var(--border-color);
    background: var(--bg-surface);
    color: var(--text-primary);
  }

  .btn-conn:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-connect {
    background: var(--accent-primary);
    border-color: var(--accent-primary);
    color: #fff;
  }

  .connection-hint {
    font-size: 0.68rem;
    color: var(--text-muted);
  }

  .connection-error {
    margin: 0;
    font-size: 0.72rem;
    color: #f87171;
  }

  .connection-error-block {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.72rem;
    color: #f87171;
    background: rgba(248, 113, 113, 0.08);
    border: 1px solid rgba(248, 113, 113, 0.35);
    border-radius: 6px;
    padding: 0.4rem 0.55rem;
  }

  .error-code {
    font-weight: 700;
  }

  .error-details {
    margin: 0;
    padding-left: 1rem;
    color: var(--text-muted);
  }

  .catalog-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .catalog-count {
    font-size: 0.7rem;
    color: var(--text-secondary);
  }

  .catalog-digest {
    font-size: 0.66rem;
    color: var(--text-muted);
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fidelity-badge {
    font-size: 0.65rem;
    padding: 0.08rem 0.4rem;
    border-radius: 4px;
    border: 1px solid rgba(251, 191, 36, 0.45);
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
  }

  .fidelity-badge.degraded {
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.5);
    background: rgba(248, 113, 113, 0.1);
  }

  .disclosure {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .disclosure summary {
    cursor: pointer;
    color: var(--text-secondary);
  }

  .disclosure-note {
    margin: 0.25rem 0 0.25rem 0.75rem;
  }

  .disclosure-list {
    margin: 0.25rem 0 0.35rem 0;
    padding-left: 1.5rem;
  }

  .disclosure-list.refused {
    color: #f87171;
  }

  .conflict-block {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    font-size: 0.7rem;
    color: #f87171;
    border: 1px solid rgba(248, 113, 113, 0.35);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
  }

  .conflict-title {
    font-weight: 700;
  }

  .connection-times {
    display: flex;
    gap: 0.8rem;
    font-size: 0.65rem;
    color: var(--text-muted);
  }
</style>
