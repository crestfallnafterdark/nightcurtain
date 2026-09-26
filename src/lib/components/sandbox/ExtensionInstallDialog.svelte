<script>
  /**
   * Extension install dialog (extension wave, P2.3): the one operator install
   * surface shared by the global Extensions settings tab and the Realm
   * missing-tools assist.
   *
   * The form covers the registry's install-record fields — id, kind,
   * kind-specific transport hint (MCP over http/stdio, or a pack source),
   * optional display name, optional approved URL, and an optional credential
   * picker over the vault's entries (an id only, never a secret) — and records
   * the install source (`operator` for a blank install, `template-assist` for
   * a dialog prefilled from a template request). Validation runs through the
   * pure draft helper (mirroring the registry's own rules) before the store's
   * typed `installExtension` call; nothing connects, and no credential is
   * bound automatically.
   */
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import {
    describeExtensionInstallError,
    emptyExtensionInstallDraft,
    validateExtensionInstallDraft
  } from './extensionUiHelpers.ts';

  let {
    prefill = emptyExtensionInstallDraft(),
    contextLabel = '',
    authorComment = '',
    oninstalled = () => {},
    onclose = () => {}
  } = $props();

  const vault = sandboxStore.getCredentialVault();

  /**
   * Reads the mount-time form state from the prefill. The parent mounts this
   * dialog fresh per open (`{#if …}`), so the initial read is the intended
   * semantic; the draft fields stay operator-editable state afterwards.
   *
   * @returns {import('./extensionUiHelpers.ts').ExtensionInstallDraft} Initial form state.
   */
  function readInitialForm() {
    return {
      id: prefill.id,
      kind: prefill.kind === 'pack' ? 'pack' : 'mcp',
      displayName: prefill.displayName,
      transportKind: prefill.transportKind === 'stdio' ? 'stdio' : prefill.transportKind === 'pack' ? 'pack' : 'http',
      url: prefill.url,
      command: prefill.command,
      argsText: prefill.argsText,
      source: prefill.source,
      approvedUrl: prefill.approvedUrl,
      credentialId: prefill.credentialId,
      installSource: prefill.installSource === 'template-assist' ? 'template-assist' : 'operator'
    };
  }

  let form = $state(readInitialForm());
  let errorText = $state('');
  let fieldErrors = $state(/** @type {Record<string, string>} */({}));
  let isInstalling = $state(false);
  let modalRef = $state(/** @type {HTMLDivElement | null} */(null));

  let credentials = $derived(vault.getAllCredentials());

  /** Effective transport discriminator for the currently selected kind. */
  let effectiveTransport = $derived(
    form.kind === 'pack' ? 'pack' : form.transportKind === 'stdio' ? 'stdio' : 'http'
  );

  function clearMessages() {
    errorText = '';
    fieldErrors = {};
  }

  /** Switches kind and keeps the transport discriminator compatible. */
  function handleKindChange() {
    if (form.kind === 'pack') form.transportKind = 'pack';
    else if (form.transportKind === 'pack') form.transportKind = 'http';
    clearMessages();
  }

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) onclose();
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      onclose();
      return;
    }
    if (event.key === 'Tab' && modalRef) {
      const focusable = modalRef.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = /** @type {HTMLElement} */ (focusable[0]);
      const last = /** @type {HTMLElement} */ (focusable[focusable.length - 1]);
      if (event.shiftKey) {
        if (document.activeElement === first || !modalRef.contains(document.activeElement)) {
          last.focus();
          event.preventDefault();
        }
      } else if (document.activeElement === last || !modalRef.contains(document.activeElement)) {
        first.focus();
        event.preventDefault();
      }
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    clearMessages();
    if (isInstalling) return;
    const result = validateExtensionInstallDraft(form);
    if (!result.ok) {
      fieldErrors = { ...result.fieldErrors };
      errorText = result.error;
      return;
    }
    isInstalling = true;
    try {
      const record = sandboxStore.installExtension(result.input);
      oninstalled(record);
    } catch (err) {
      errorText = describeExtensionInstallError(err);
    } finally {
      isInstalling = false;
    }
  }
</script>

<div
  class="install-backdrop"
  role="presentation"
  tabindex="-1"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
>
  <div bind:this={modalRef} class="install-dialog" role="dialog" aria-modal="true" aria-labelledby="extension-install-title">
    <div class="modal-header">
      <div class="section-title-wrap">
        <span class="section-badge">Install</span>
        <h3 id="extension-install-title" class="modal-title">Install extension</h3>
      </div>
      <button type="button" class="btn-close" onclick={() => onclose()} aria-label="Close install dialog">✕</button>
    </div>

    <p class="install-note">
      {#if form.installSource === 'template-assist'}
        Prefilled from a template request{contextLabel ? ` (${contextLabel})` : ''}. Review every field — installing records
        operator intent only; nothing connects and no credential is bound automatically.
      {:else}
        Installing records operator intent only — no server is dialed and no tool runs until a connection exists.
      {/if}
    </p>

    {#if authorComment}
      <p class="install-author-note"><span class="author-tag">Template note</span>{authorComment}</p>
    {/if}

    {#if errorText}
      <div class="error-banner" role="alert"><span>{errorText}</span></div>
    {/if}

    <form class="install-form" onsubmit={handleSubmit} novalidate>
      <div class="form-grid">
        <div class="form-group grow">
          <label for="extension-install-id">Extension id <span class="req">*</span></label>
          <input
            id="extension-install-id"
            type="text"
            class="input-field font-mono"
            bind:value={form.id}
            placeholder="acme-scoring"
            oninput={clearMessages}
          />
          {#if fieldErrors.id}<span class="field-error">{fieldErrors.id}</span>{/if}
        </div>
        <div class="form-group">
          <label for="extension-install-kind">Kind <span class="req">*</span></label>
          <select id="extension-install-kind" class="input-field" bind:value={form.kind} onchange={handleKindChange}>
            <option value="mcp">MCP server</option>
            <option value="pack">Tool pack</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label for="extension-install-display-name">Display name <span class="opt">(optional)</span></label>
        <input
          id="extension-install-display-name"
          type="text"
          class="input-field"
          bind:value={form.displayName}
          placeholder="Operator-facing label"
          oninput={clearMessages}
        />
      </div>

      {#if form.kind === 'mcp'}
        <div class="form-grid">
          <div class="form-group">
            <label for="extension-install-transport">Transport <span class="req">*</span></label>
            <select id="extension-install-transport" class="input-field" bind:value={form.transportKind} onchange={clearMessages}>
              <option value="http">HTTP (URL)</option>
              <option value="stdio">stdio (host-only)</option>
            </select>
          </div>
          {#if effectiveTransport === 'http'}
            <div class="form-group grow">
              <label for="extension-install-url">Server URL <span class="req">*</span></label>
              <input
                id="extension-install-url"
                type="text"
                class="input-field font-mono"
                bind:value={form.url}
                placeholder="https://mcp.example.com"
                oninput={clearMessages}
              />
              {#if fieldErrors.url}<span class="field-error">{fieldErrors.url}</span>{/if}
            </div>
          {:else}
            <div class="form-group grow">
              <label for="extension-install-command">Command <span class="req">*</span></label>
              <input
                id="extension-install-command"
                type="text"
                class="input-field font-mono"
                bind:value={form.command}
                placeholder="npx"
                oninput={clearMessages}
              />
              {#if fieldErrors.command}<span class="field-error">{fieldErrors.command}</span>{/if}
            </div>
          {/if}
        </div>
        {#if effectiveTransport === 'stdio'}
          <div class="form-group">
            <label for="extension-install-args">Arguments <span class="opt">(one per line)</span></label>
            <textarea
              id="extension-install-args"
              class="input-field font-mono args-area"
              rows="2"
              bind:value={form.argsText}
              placeholder="-y&#10;@acme/mcp-server"
              oninput={clearMessages}
            ></textarea>
          </div>
          <p class="hint-note">
            stdio is host-only transport metadata: a browser session records the declaration but cannot execute it.
          </p>
        {/if}
      {:else}
        <div class="form-group">
          <label for="extension-install-source">Pack install source <span class="req">*</span></label>
          <input
            id="extension-install-source"
            type="text"
            class="input-field font-mono"
            bind:value={form.source}
            placeholder="acme/tool-pack"
            oninput={clearMessages}
          />
          {#if fieldErrors.source}<span class="field-error">{fieldErrors.source}</span>{/if}
        </div>
      {/if}

      <div class="form-grid">
        <div class="form-group grow">
          <label for="extension-install-approved-url">Approved URL <span class="opt">(optional)</span></label>
          <input
            id="extension-install-approved-url"
            type="text"
            class="input-field font-mono"
            bind:value={form.approvedUrl}
            placeholder="Explicitly approved server URL"
            oninput={clearMessages}
          />
        </div>
        <div class="form-group grow">
          <label for="extension-install-credential">Credential <span class="opt">(optional)</span></label>
          <select id="extension-install-credential" class="input-field" bind:value={form.credentialId} onchange={clearMessages}>
            <option value="">No credential</option>
            {#each credentials as entry (entry.id)}
              <option value={entry.id}>{entry.label} ({entry.providerId})</option>
            {/each}
          </select>
        </div>
      </div>

      <p class="hint-note">
        The credential stays a vault id on the record — the secret is never copied into extension state. Plaintext
        credentials over http are refused by policy.
      </p>

      <div class="install-actions">
        <span class="install-source-chip font-mono">source: {form.installSource}</span>
        <button type="button" class="btn-secondary" onclick={() => onclose()} disabled={isInstalling}>Cancel</button>
        <button type="submit" class="btn-primary" disabled={isInstalling}>
          {isInstalling ? 'Installing…' : 'Install'}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
  .install-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: rgba(2, 6, 23, 0.72);
    backdrop-filter: blur(4px);
  }

  .install-dialog {
    width: 560px;
    max-width: 95vw;
    max-height: 90vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
    padding: 1.25rem 1.4rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
    color: var(--text-primary);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: 0.6rem;
  }

  .section-title-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .section-badge {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.12rem 0.45rem;
    border-radius: 4px;
    background: var(--accent-primary-subtle);
    color: var(--accent-primary);
    border: 1px solid var(--accent-primary-border);
  }

  .modal-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
  }

  .btn-close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
  }

  .btn-close:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  .install-note,
  .hint-note {
    margin: 0;
    font-size: 0.74rem;
    line-height: 1.45;
    color: var(--text-muted);
  }

  .install-author-note {
    margin: 0;
    font-size: 0.76rem;
    line-height: 1.45;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.5rem 0.65rem;
  }

  .author-tag {
    display: inline-block;
    margin-right: 0.45rem;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .error-banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 0.85rem;
    border-radius: 8px;
    font-size: 0.8rem;
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    color: #f87171;
  }

  .install-form {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .form-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.75rem;
    align-items: start;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0;
  }

  .form-group.grow {
    min-width: 0;
  }

  label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .req {
    color: #f87171;
  }

  .opt {
    font-weight: normal;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .input-field {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 0.45rem 0.65rem;
    font-size: 0.84rem;
    font-family: inherit;
    width: 100%;
    box-sizing: border-box;
  }

  .input-field:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .args-area {
    resize: vertical;
  }

  .field-error {
    font-size: 0.72rem;
    color: #f87171;
  }

  .install-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.6rem;
    border-top: 1px solid var(--border-subtle);
    padding-top: 0.75rem;
  }

  .install-source-chip {
    margin-right: auto;
    font-size: 0.7rem;
    color: var(--text-muted);
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 0.15rem 0.4rem;
  }

  .btn-primary,
  .btn-secondary {
    border-radius: 6px;
    padding: 0.45rem 0.9rem;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    border: 1px solid transparent;
  }

  .btn-primary {
    background: var(--accent-primary);
    color: #fff;
  }

  .btn-primary:disabled,
  .btn-secondary:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-secondary {
    background: var(--bg-surface);
    border-color: var(--border-color);
    color: var(--text-primary);
  }

  @media (max-width: 560px) {
    .form-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
