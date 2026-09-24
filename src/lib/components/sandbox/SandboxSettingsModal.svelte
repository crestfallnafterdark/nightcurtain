<script>
  import { getSandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { CredentialVault } from '../../sandbox/credentialVault/index.ts';
  import { getDefaultModelId, getProviderCapabilities } from '../../sandbox/modelConfig/index.ts';

  let { onclose = () => {} } = $props();

  const store = getSandboxStore();
  const catalog = store.getPresetCatalog();
  const presetSource = catalog.createPresetSourcePort();
  const vault = store.getCredentialVault();

  const PROVIDER_OPTIONS = [
    { id: 'runware', label: 'Runware' },
    { id: 'nanogpt', label: 'NanoGPT' },
    { id: 'deepseek', label: 'DeepSeek Native' },
    { id: 'prem', label: 'Prem AI' },
    { id: 'custom', label: 'Custom OpenAI Completion' }
  ];

  const VAULT_PROVIDERS = ['runware', 'nanogpt', 'deepseek', 'prem', 'custom'];

  const REASONING_OPTIONS = ['none', 'low', 'medium', 'high', 'max', 'xhigh'];

  const DEFAULT_CUSTOM_URL = 'http://localhost:11434/v1';

  let catalogRevision = $state(0);

  $effect(() => {
    return catalog.subscribe(() => {
      catalogRevision += 1;
    });
  });

  let allPresets = $derived.by(() => {
    void catalogRevision;
    return catalog.listPresets();
  });

  let activePresetId = $derived.by(() => {
    void catalogRevision;
    return presetSource.getDefaultPresetId();
  });

  function readString(value) {
    return typeof value === 'string' ? value : '';
  }

  function readNumber(value) {
    return typeof value === 'number' ? value : null;
  }

  const initialPreset = presetSource.getPreset(presetSource.getDefaultPresetId());
  const initialConfig = initialPreset ? initialPreset.modelConfig : null;
  const initialTemperature = initialConfig ? readNumber(initialConfig.temperature) : null;

  let selectedPresetId = $state(initialPreset ? initialPreset.id : '');
  let providerId = $state(initialConfig ? readString(initialConfig.providerId) || 'runware' : 'runware');
  let modelId = $state(
    initialConfig ? readString(initialConfig.modelId) || getDefaultModelId('runware') : getDefaultModelId('runware')
  );
  let temperature = $state(initialTemperature !== null ? initialTemperature : 0.7);
  let reasoningEffort = $state(
    initialConfig ? readString(initialConfig.reasoningEffort) || 'high' : 'high'
  );
  let routing = $state(initialConfig ? readString(initialConfig.routing) || 'auto' : 'auto');
  let customUrl = $state(
    initialConfig ? readString(initialConfig.url) || DEFAULT_CUSTOM_URL : DEFAULT_CUSTOM_URL
  );

  let selectedPreset = $derived.by(() => {
    void catalogRevision;
    return catalog.getPreset(selectedPresetId);
  });

  function loadPresetIntoEditor(preset) {
    const conf = preset.modelConfig;
    const presetTemperature = readNumber(conf.temperature);
    selectedPresetId = preset.id;
    providerId = readString(conf.providerId) || 'runware';
    modelId = readString(conf.modelId);
    temperature = presetTemperature !== null ? presetTemperature : 0.7;
    reasoningEffort = readString(conf.reasoningEffort) || 'high';
    routing = readString(conf.routing) || 'auto';
    customUrl = readString(conf.url) || DEFAULT_CUSTOM_URL;
  }

  function buildModelConfig() {
    const capabilities = getProviderCapabilities(providerId);
    return {
      providerId,
      modelId: modelId.trim(),
      temperature,
      reasoningEffort,
      ...(capabilities.supportsRouting && routing.trim() ? { routing: routing.trim() } : {}),
      ...(capabilities.supportsUrl && customUrl.trim() ? { url: customUrl.trim() } : {})
    };
  }

  function configSignature(conf) {
    return JSON.stringify({
      providerId: conf.providerId || '',
      modelId: conf.modelId || '',
      temperature: typeof conf.temperature === 'number' ? conf.temperature : null,
      reasoningEffort: conf.reasoningEffort || '',
      routing: conf.routing || '',
      url: conf.url || ''
    });
  }

  let presetDirty = $derived.by(() => {
    if (!selectedPreset) return false;
    return configSignature(buildModelConfig()) !== configSignature(selectedPreset.modelConfig);
  });

  let presetStatus = $state({ ok: true, msg: '' });
  let showSaveAsNew = $state(false);
  let newPresetName = $state('');

  function describeError(err) {
    return err && err.message ? String(err.message) : String(err);
  }

  function handleClose() {
    onclose();
  }

  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) handleClose();
  }

  function handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (showSaveAsNew) {
      showSaveAsNew = false;
      newPresetName = '';
      return;
    }
    handleClose();
  }

  $effect(() => {
    const opener = typeof document !== 'undefined' ? document.activeElement : null;
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  });

  function handleSelectPreset(id) {
    const preset = catalog.getPreset(id);
    if (!preset) return;
    loadPresetIntoEditor(preset);
    try {
      catalog.setActivePresetId(id);
      presetStatus = { ok: true, msg: `Active preset set to "${preset.name}".` };
    } catch (err) {
      presetStatus = { ok: false, msg: describeError(err) };
    }
  }

  function handleProviderChange() {
    const nextDefault = getDefaultModelId(providerId);
    if (nextDefault) modelId = nextDefault;
    if (providerId === 'nanogpt' && !routing.trim()) routing = 'auto';
    if (providerId === 'custom' && !customUrl.trim()) customUrl = DEFAULT_CUSTOM_URL;
  }

  function handleSavePreset() {
    if (!selectedPreset) return;
    try {
      catalog.savePreset({
        id: selectedPreset.id,
        name: selectedPreset.name,
        isCustom: selectedPreset.isCustom,
        modelConfig: buildModelConfig()
      });
      presetStatus = { ok: true, msg: `Preset "${selectedPreset.name}" saved.` };
    } catch (err) {
      presetStatus = { ok: false, msg: describeError(err) };
    }
  }

  function handleSaveAsNew() {
    const name = newPresetName.trim();
    if (!name) return;
    const id = `preset_custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
      catalog.savePreset({ id, name, isCustom: true, modelConfig: buildModelConfig() });
      catalog.setActivePresetId(id);
      selectedPresetId = id;
      showSaveAsNew = false;
      newPresetName = '';
      presetStatus = { ok: true, msg: `Custom preset "${name}" created and activated.` };
    } catch (err) {
      presetStatus = { ok: false, msg: describeError(err) };
    }
  }

  function handleDeletePreset() {
    if (!selectedPreset || !selectedPreset.isCustom) return;
    const name = selectedPreset.name;
    if (!confirm(`Delete custom preset "${name}"?`)) return;
    try {
      catalog.deletePreset(selectedPreset.id);
      const fallbackId = presetSource.getDefaultPresetId();
      const fallback = catalog.getPreset(fallbackId);
      if (fallback) {
        loadPresetIntoEditor(fallback);
        catalog.setActivePresetId(fallbackId);
      }
      presetStatus = { ok: true, msg: `Custom preset "${name}" deleted.` };
    } catch (err) {
      presetStatus = { ok: false, msg: describeError(err) };
    }
  }

  let vaultProvider = $state(
    initialConfig ? readString(initialConfig.providerId) || 'runware' : 'runware'
  );
  let vaultRevision = $state(0);
  let vaultStatus = $state({ ok: true, msg: '' });

  let vaultKeys = $derived.by(() => {
    void vaultRevision;
    return vault.getCredentialsForProvider(vaultProvider);
  });

  let activeVaultCredential = $derived.by(() => {
    void vaultRevision;
    return vault.getActiveCredential(vaultProvider);
  });

  let currentProviderCredential = $derived.by(() => {
    void vaultRevision;
    return vault.getActiveCredential(providerId);
  });

  let revealedKeys = $state(new Set());
  let editingCredentialId = $state('');
  let editLabel = $state('');
  let editSecret = $state('');
  let editKek = $state('');
  let newLabel = $state('');
  let newSecret = $state('');
  let newKek = $state('');

  function handleVaultProviderChange(provider) {
    vaultProvider = provider;
    vaultStatus = { ok: true, msg: '' };
  }

  function toggleRevealKey(id) {
    const next = new Set(revealedKeys);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    revealedKeys = next;
  }

  async function copySecret(value) {
    if (!value || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      vaultStatus = { ok: true, msg: 'Secret copied to clipboard.' };
    } catch (err) {
      vaultStatus = { ok: false, msg: describeError(err) };
    }
  }

  function startEditCredential(entry) {
    editingCredentialId = entry.id;
    editLabel = entry.label || '';
    editSecret = entry.apiKey || '';
    editKek = typeof entry.encryptionKey === 'string' ? entry.encryptionKey : '';
  }

  function cancelEditCredential() {
    editingCredentialId = '';
    editLabel = '';
    editSecret = '';
    editKek = '';
  }

  function handleSaveEditedCredential(id) {
    const secret = editSecret.trim();
    if (!secret) return;
    const label = editLabel.trim() || `${vaultProvider} Key`;
    try {
      const updated = vault.updateCredential(id, {
        label,
        apiKey: secret,
        encryptionKey: vaultProvider === 'prem' ? editKek.trim() : undefined
      });
      vaultRevision += 1;
      if (!updated) {
        vaultStatus = { ok: false, msg: 'This credential no longer exists; the list was refreshed.' };
        cancelEditCredential();
        return;
      }
      if (activeVaultCredential && activeVaultCredential.id === id) {
        store.rebindProviderCredentials(vaultProvider, id);
      }
      cancelEditCredential();
      vaultStatus = { ok: true, msg: `Credential "${label}" updated.` };
    } catch (err) {
      vaultStatus = { ok: false, msg: describeError(err) };
    }
  }

  function handleAddCredential() {
    const secret = newSecret.trim();
    if (!secret) return;
    const label = newLabel.trim() || `${vaultProvider} Key ${vaultKeys.length + 1}`;
    try {
      const added = vault.addCredential({
        providerId: vaultProvider,
        label,
        apiKey: secret,
        encryptionKey: vaultProvider === 'prem' ? newKek.trim() : undefined
      });
      vault.setActiveCredential(vaultProvider, added.id);
      store.rebindProviderCredentials(vaultProvider, added.id);
      vaultRevision += 1;
      newLabel = '';
      newSecret = '';
      newKek = '';
      vaultStatus = { ok: true, msg: `Stored "${label}" and set it active for ${vaultProvider}.` };
    } catch (err) {
      vaultStatus = { ok: false, msg: describeError(err) };
    }
  }

  function handleSetActiveCredential(id) {
    try {
      vault.setActiveCredential(vaultProvider, id);
      store.rebindProviderCredentials(vaultProvider, id);
      vaultRevision += 1;
      vaultStatus = {
        ok: true,
        msg: 'Active credential updated; the change applies at the next turn start.'
      };
    } catch (err) {
      vaultStatus = { ok: false, msg: describeError(err) };
    }
  }

  function handleDeleteCredential(id) {
    if (!confirm(`Delete this ${vaultProvider} credential?`)) return;
    try {
      const deleted = vault.deleteCredential(id);
      vaultRevision += 1;
      if (!deleted) {
        vaultStatus = { ok: false, msg: 'This credential no longer exists; the list was refreshed.' };
        return;
      }
      const remaining = vault.getActiveCredential(vaultProvider);
      store.rebindProviderCredentials(vaultProvider, remaining ? remaining.id : null);
      vaultStatus = { ok: true, msg: 'Credential deleted.' };
    } catch (err) {
      vaultStatus = { ok: false, msg: describeError(err) };
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="modal-backdrop" role="presentation" tabindex="-1" onclick={handleBackdropClick}>
  <div
    class="settings-dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="sandbox-settings-heading"
  >
    <header class="modal-header">
      <div class="header-info">
        <div class="header-icon" aria-hidden="true">⚙</div>
        <div class="header-title">
          <h2 id="sandbox-settings-heading">Sandbox Settings</h2>
          <p>Model presets and provider credentials</p>
        </div>
      </div>
      <button type="button" class="btn-close" onclick={handleClose} aria-label="Close settings">✕</button>
    </header>

    <div class="modal-body">
      <section class="section-card" aria-labelledby="preset-section-heading">
        <div class="section-header">
          <div class="section-title-wrap">
            <span class="section-title" id="preset-section-heading">Model Presets</span>
            <span class="status-pill pill-active">
              <span class="pill-dot"></span>
              <span>{allPresets.length} in catalog</span>
            </span>
          </div>
          {#if selectedPreset}
            <div class="badge-row">
              {#if selectedPreset.isCustom}
                <span class="badge-custom">Custom</span>
              {:else}
                <span class="badge-official">Official</span>
              {/if}
              {#if selectedPreset.id === activePresetId}
                <span class="badge-active">Active</span>
              {/if}
            </div>
          {/if}
        </div>

        <div class="form-group">
          <label for="preset-select" class="form-label">Model Preset</label>
          <select
            id="preset-select"
            class="styled-select"
            value={selectedPresetId}
            onchange={(event) => handleSelectPreset(/** @type {HTMLSelectElement} */ (event.currentTarget).value)}
          >
            {#each allPresets as preset (preset.id)}
              <option value={preset.id}>
                {preset.name} — {preset.modelConfig.modelId}{preset.isCustom ? ' ★' : ''}
              </option>
            {/each}
          </select>
        </div>

        <div class="preset-summary-line">
          {#if currentProviderCredential && currentProviderCredential.apiKey}
            <span>
              Key: <code class="font-mono">{CredentialVault.maskKey(currentProviderCredential.apiKey)}</code>
            </span>
          {:else}
            <button
              type="button"
              class="preset-link warn"
              onclick={() => handleVaultProviderChange(providerId)}
            >
              No key stored for {providerId} — configure below
            </button>
          {/if}
        </div>

        <div class="editor-grid">
          <div class="form-group">
            <label for="provider-select" class="form-label">Provider</label>
            <select
              id="provider-select"
              class="styled-select"
              bind:value={providerId}
              onchange={handleProviderChange}
            >
              {#each PROVIDER_OPTIONS as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label for="model-input" class="form-label">Model ID</label>
            <input
              id="model-input"
              type="text"
              class="styled-input font-mono"
              bind:value={modelId}
              placeholder="Model identifier"
            />
          </div>
        </div>

        {#if providerId === 'custom'}
          <div class="form-group">
            <label for="custom-url-input" class="form-label">Custom Endpoint URL</label>
            <input
              id="custom-url-input"
              type="text"
              class="styled-input font-mono"
              bind:value={customUrl}
              placeholder={DEFAULT_CUSTOM_URL}
            />
          </div>
        {/if}

        {#if providerId === 'nanogpt'}
          <div class="form-group">
            <label for="routing-input" class="form-label">Upstream Routing</label>
            <input
              id="routing-input"
              type="text"
              class="styled-input font-mono"
              bind:value={routing}
              placeholder="auto"
            />
          </div>
        {/if}

        <div class="params-section">
          <div class="form-group flex-1">
            <div class="slider-label-row">
              <label for="temperature-slider" class="form-label">Temperature</label>
              <span class="val-pill font-mono">{temperature}</span>
            </div>
            <input
              id="temperature-slider"
              type="range"
              min="0"
              max="2"
              step="0.05"
              class="styled-slider"
              bind:value={temperature}
            />
          </div>

          <div class="form-group flex-1">
            <span class="form-label">Reasoning Effort</span>
            <div class="chips-row">
              {#each REASONING_OPTIONS as effort (effort)}
                <button
                  type="button"
                  class="effort-chip"
                  class:active={reasoningEffort === effort}
                  onclick={() => reasoningEffort = effort}
                >
                  {effort}
                </button>
              {/each}
            </div>
          </div>
        </div>

        {#if presetStatus.msg}
          <div
            class="status-banner"
            class:status-ok={presetStatus.ok}
            class:status-err={!presetStatus.ok}
            role="status"
          >
            {presetStatus.msg}
          </div>
        {/if}

        <div class="preset-actions-row">
          {#if presetDirty}
            <span class="dirty-badge">Unsaved changes</span>
          {/if}
          <button type="button" class="btn-primary" onclick={handleSavePreset} disabled={!selectedPreset}>
            Save Preset
          </button>
          <button
            type="button"
            class="btn-secondary"
            onclick={() => { showSaveAsNew = true; newPresetName = ''; }}
          >
            Save As New…
          </button>
          {#if selectedPreset && selectedPreset.isCustom}
            <button type="button" class="btn-danger" onclick={handleDeletePreset}>Delete</button>
          {/if}
        </div>

        {#if showSaveAsNew}
          <div class="inline-form">
            <input
              type="text"
              class="styled-input"
              placeholder="New preset name"
              bind:value={newPresetName}
            />
            <button
              type="button"
              class="btn-primary"
              onclick={handleSaveAsNew}
              disabled={!newPresetName.trim()}
            >
              Create
            </button>
            <button
              type="button"
              class="btn-secondary"
              onclick={() => { showSaveAsNew = false; newPresetName = ''; }}
            >
              Cancel
            </button>
          </div>
        {/if}
      </section>

      <section class="section-card" aria-labelledby="vault-section-heading">
        <div class="section-header">
          <div class="section-title-wrap">
            <span class="section-title" id="vault-section-heading">API Key Vault</span>
            <span class="status-pill pill-active">
              <span class="pill-dot"></span>
              <span>{vaultKeys.length} stored for {vaultProvider}</span>
            </span>
          </div>
        </div>

        <div class="vault-tabs-row" role="tablist" aria-label="Credential provider">
          {#each VAULT_PROVIDERS as provider (provider)}
            <button
              type="button"
              class="vault-tab"
              class:active={vaultProvider === provider}
              role="tab"
              aria-selected={vaultProvider === provider}
              onclick={() => handleVaultProviderChange(provider)}
            >
              {provider.toUpperCase()}
            </button>
          {/each}
        </div>

        {#if vaultStatus.msg}
          <div
            class="status-banner"
            class:status-ok={vaultStatus.ok}
            class:status-err={!vaultStatus.ok}
            role="status"
          >
            {vaultStatus.msg}
          </div>
        {/if}

        <div class="vault-keys-section">
          {#if vaultKeys.length === 0}
            <div class="empty-state">
              No credentials stored for {vaultProvider.toUpperCase()}. Add one below.
            </div>
          {:else}
            {#each vaultKeys as entry (entry.id)}
              <div class="cred-card" class:active={activeVaultCredential && activeVaultCredential.id === entry.id}>
                {#if editingCredentialId === entry.id}
                  <div class="edit-cred-form">
                    <span class="edit-cred-title">Edit credential ({vaultProvider.toUpperCase()})</span>
                    <div class="add-key-grid">
                      <input type="text" class="styled-input" placeholder="Label" bind:value={editLabel} />
                      <input
                        type="password"
                        class="styled-input font-mono"
                        placeholder="API key"
                        bind:value={editSecret}
                      />
                    </div>
                    {#if vaultProvider === 'prem'}
                      <input
                        type="password"
                        class="styled-input font-mono"
                        placeholder="Client KEK (optional)"
                        bind:value={editKek}
                      />
                    {/if}
                    <div class="edit-cred-actions">
                      <button
                        type="button"
                        class="btn-primary btn-action-sm"
                        onclick={() => handleSaveEditedCredential(entry.id)}
                        disabled={!editSecret.trim()}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        class="btn-secondary btn-action-sm"
                        onclick={cancelEditCredential}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                {:else}
                  <div class="cred-info">
                    <div class="cred-label-row">
                      <span class="cred-label">{entry.label}</span>
                      {#if activeVaultCredential && activeVaultCredential.id === entry.id}
                        <span class="badge-active">Active</span>
                      {/if}
                      {#if entry.isCanonical}
                        <span class="badge-canonical">Default slot</span>
                      {/if}
                    </div>
                    {#if entry.apiKey}
                      <code class="cred-secret">
                        {revealedKeys.has(entry.id) ? entry.apiKey : CredentialVault.maskKey(entry.apiKey)}
                      </code>
                    {:else}
                      <span class="unconfigured-warning">No secret stored</span>
                    {/if}
                    {#if entry.encryptionKey}
                      <div class="cred-kek-line">
                        <span class="kek-tag">Client KEK:</span>
                        <code class="font-mono">
                          {revealedKeys.has(entry.id) ? entry.encryptionKey : '••••••••••••'}
                        </code>
                      </div>
                    {/if}
                  </div>

                  <div class="cred-actions">
                    <button
                      type="button"
                      class="btn-action-sm btn-edit-cred"
                      onclick={() => startEditCredential(entry)}
                    >
                      Edit
                    </button>
                    {#if entry.apiKey}
                      <button type="button" class="btn-action-sm" onclick={() => toggleRevealKey(entry.id)}>
                        {revealedKeys.has(entry.id) ? 'Mask' : 'Reveal'}
                      </button>
                      <button type="button" class="btn-action-sm" onclick={() => copySecret(entry.apiKey)}>
                        Copy
                      </button>
                    {/if}
                    {#if !activeVaultCredential || activeVaultCredential.id !== entry.id}
                      <button
                        type="button"
                        class="btn-action-sm btn-set-active"
                        onclick={() => handleSetActiveCredential(entry.id)}
                      >
                        Set Active
                      </button>
                    {/if}
                    {#if !entry.isCanonical}
                      <button
                        type="button"
                        class="btn-action-sm btn-delete"
                        onclick={() => handleDeleteCredential(entry.id)}
                        aria-label="Delete credential"
                      >
                        ✕
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          {/if}
        </div>

        <div class="add-key-card">
          <span class="add-key-title">Add key for {vaultProvider.toUpperCase()}</span>
          <div class="add-key-grid">
            <input
              type="text"
              class="styled-input"
              placeholder="Label (e.g. Production Key)"
              bind:value={newLabel}
            />
            <input
              type="password"
              class="styled-input font-mono"
              placeholder="API key"
              bind:value={newSecret}
            />
          </div>
          {#if vaultProvider === 'prem'}
            <input
              type="password"
              class="styled-input font-mono"
              placeholder="Client KEK (optional)"
              bind:value={newKek}
            />
          {/if}
          <div class="add-key-footer">
            <button
              type="button"
              class="btn-primary btn-action-sm"
              onclick={handleAddCredential}
              disabled={!newSecret.trim()}
            >
              Save to Vault
            </button>
          </div>
        </div>
      </section>
    </div>

    <footer class="modal-footer">
      <span class="footer-meta font-mono">
        {allPresets.length} presets · {vaultKeys.length} {vaultProvider} credentials
      </span>
      <button type="button" class="btn-secondary" onclick={handleClose}>Close</button>
    </footer>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    background: rgba(2, 6, 23, 0.78);
  }

  .settings-dialog {
    width: 780px;
    max-width: 95vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-secondary, #0f172a);
    border: 1px solid var(--border-color, #334155);
    border-radius: 16px;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    color: var(--text-primary, #e2e8f0);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    background: var(--bg-surface, #1e293b);
    border-bottom: 1px solid var(--border-color, #334155);
  }

  .header-info {
    display: flex;
    align-items: center;
    gap: 0.9rem;
  }

  .header-icon {
    width: 38px;
    height: 38px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 10px;
    font-size: 18px;
    color: var(--accent-primary, #38bdf8);
    background: var(--accent-primary-subtle, rgba(56, 189, 248, 0.12));
    border: 1px solid var(--accent-primary-border, rgba(56, 189, 248, 0.3));
  }

  .header-title h2 {
    margin: 0;
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-primary, #f1f5f9);
  }

  .header-title p {
    margin: 0.15rem 0 0;
    font-size: 0.75rem;
    color: var(--text-muted, #94a3b8);
  }

  .btn-close {
    background: transparent;
    border: none;
    color: var(--text-muted, #94a3b8);
    font-size: 1.05rem;
    cursor: pointer;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
  }

  .btn-close:hover {
    color: var(--text-primary, #f1f5f9);
    background: var(--bg-surface-elevated, #334155);
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .section-card {
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    padding: 1.1rem;
    background: var(--bg-base, #0b1220);
    border: 1px solid var(--border-color, #334155);
    border-radius: 12px;
  }

  .section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .section-title-wrap {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .section-title {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text-primary, #f1f5f9);
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 600;
  }

  .pill-active {
    color: #34d399;
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.3);
  }

  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: currentColor;
  }

  .badge-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .badge-official,
  .badge-custom,
  .badge-active,
  .badge-canonical {
    padding: 0.12rem 0.5rem;
    border-radius: 999px;
    font-size: 0.65rem;
    font-weight: 700;
  }

  .badge-official {
    color: var(--text-secondary, #cbd5e1);
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
  }

  .badge-custom {
    color: #c084fc;
    background: rgba(168, 85, 247, 0.14);
    border: 1px solid rgba(168, 85, 247, 0.35);
  }

  .badge-active {
    color: #34d399;
    background: rgba(16, 185, 129, 0.14);
    border: 1px solid rgba(16, 185, 129, 0.35);
  }

  .badge-canonical {
    color: var(--text-muted, #94a3b8);
    background: var(--bg-surface, #1e293b);
    border: 1px dashed var(--border-color, #334155);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .form-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--text-secondary, #cbd5e1);
  }

  .styled-select,
  .styled-input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.82rem;
    color: var(--text-primary, #f8fafc);
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
    border-radius: 6px;
    outline: none;
  }

  .styled-select:focus,
  .styled-input:focus {
    border-color: var(--accent-primary, #38bdf8);
  }

  .preset-summary-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-muted, #94a3b8);
    flex-wrap: wrap;
  }

  .preset-link {
    background: transparent;
    border: none;
    padding: 0;
    color: var(--accent-primary, #38bdf8);
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    text-decoration: underline;
  }

  .preset-link.warn {
    color: #f59e0b;
  }

  .editor-grid {
    display: grid;
    grid-template-columns: 1fr 1.4fr;
    gap: 0.8rem;
  }

  .params-section {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .flex-1 {
    flex: 1;
    min-width: 220px;
  }

  .slider-label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .val-pill {
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    font-size: 0.7rem;
    color: var(--accent-primary, #38bdf8);
    background: var(--bg-surface, #1e293b);
  }

  .styled-slider {
    width: 100%;
    margin-top: 0.4rem;
    accent-color: var(--accent-primary, #38bdf8);
  }

  .chips-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.3rem;
  }

  .effort-chip {
    padding: 0.35rem 0.2rem;
    font-family: monospace;
    font-size: 0.7rem;
    color: var(--text-muted, #94a3b8);
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
    border-radius: 4px;
    cursor: pointer;
  }

  .effort-chip.active {
    color: var(--accent-primary, #38bdf8);
    background: var(--accent-primary-subtle, rgba(56, 189, 248, 0.15));
    border-color: var(--accent-primary, #38bdf8);
    font-weight: 700;
  }

  .status-banner {
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.75rem;
    color: var(--accent-primary, #38bdf8);
    background: rgba(56, 189, 248, 0.1);
    border: 1px solid rgba(56, 189, 248, 0.3);
  }

  .status-ok {
    color: #34d399;
    background: rgba(16, 185, 129, 0.12);
    border-color: rgba(16, 185, 129, 0.3);
  }

  .status-err {
    color: #f87171;
    background: rgba(239, 68, 68, 0.12);
    border-color: rgba(239, 68, 68, 0.3);
  }

  .preset-actions-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .dirty-badge {
    margin-right: auto;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    font-size: 0.65rem;
    font-weight: 700;
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.35);
  }

  .btn-primary,
  .btn-secondary,
  .btn-danger,
  .btn-action-sm {
    padding: 0.45rem 0.9rem;
    font-size: 0.78rem;
    font-weight: 600;
    border-radius: 6px;
    cursor: pointer;
  }

  .btn-primary {
    color: #fff;
    background: #0284c7;
    border: 1px solid #0369a1;
  }

  .btn-secondary {
    color: var(--text-secondary, #cbd5e1);
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
  }

  .btn-danger {
    color: #f87171;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
  }

  .btn-primary:disabled,
  .btn-action-sm:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .btn-action-sm {
    padding: 0.3rem 0.6rem;
    font-size: 0.7rem;
    color: var(--text-secondary, #cbd5e1);
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
  }

  .inline-form {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    padding: 0.75rem;
    border-radius: 8px;
    border: 1px dashed var(--accent-primary, #38bdf8);
    background: var(--bg-surface, #1e293b);
  }

  .vault-tabs-row {
    display: flex;
    gap: 0.35rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-color, #334155);
    flex-wrap: wrap;
  }

  .vault-tab {
    padding: 0.35rem 0.75rem;
    font-size: 0.7rem;
    font-weight: 700;
    color: var(--text-muted, #94a3b8);
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
    border-radius: 6px;
    cursor: pointer;
  }

  .vault-tab.active {
    color: #c084fc;
    background: rgba(168, 85, 247, 0.15);
    border-color: #a855f7;
  }

  .vault-keys-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .empty-state {
    padding: 1.25rem;
    text-align: center;
    font-size: 0.78rem;
    color: var(--text-muted, #94a3b8);
  }

  .cred-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.7rem 0.9rem;
    border-radius: 8px;
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
  }

  .cred-card.active {
    border-color: rgba(168, 85, 247, 0.5);
    background: rgba(168, 85, 247, 0.06);
  }

  .cred-info {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0;
  }

  .cred-label-row {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    flex-wrap: wrap;
  }

  .cred-label {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-primary, #f1f5f9);
  }

  .cred-secret {
    font-size: 0.75rem;
    color: var(--text-muted, #94a3b8);
    overflow-wrap: anywhere;
  }

  .cred-kek-line {
    display: flex;
    gap: 0.4rem;
    font-size: 0.7rem;
    color: var(--text-muted, #94a3b8);
  }

  .kek-tag {
    color: #a855f7;
  }

  .unconfigured-warning {
    width: fit-content;
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    font-size: 0.7rem;
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.1);
  }

  .cred-actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .btn-edit-cred {
    color: #38bdf8;
    border-color: rgba(56, 189, 248, 0.4);
  }

  .btn-set-active {
    color: #c084fc;
    border-color: rgba(168, 85, 247, 0.4);
  }

  .btn-delete {
    color: #f87171;
  }

  .edit-cred-form {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .edit-cred-title {
    font-size: 0.75rem;
    font-weight: 700;
    color: #38bdf8;
  }

  .edit-cred-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .add-key-card {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.9rem;
    border-radius: 8px;
    border: 1px dashed var(--border-color, #334155);
    background: var(--bg-surface, #1e293b);
  }

  .add-key-title {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--text-secondary, #cbd5e1);
  }

  .add-key-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .add-key-footer {
    display: flex;
    justify-content: flex-end;
  }

  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.9rem 1.5rem;
    background: var(--bg-surface, #1e293b);
    border-top: 1px solid var(--border-color, #334155);
  }

  .footer-meta {
    font-size: 0.7rem;
    color: var(--text-muted, #94a3b8);
  }

  .font-mono {
    font-family: monospace;
  }

  @media (max-width: 640px) {
    .editor-grid,
    .add-key-grid {
      grid-template-columns: 1fr;
    }

    .cred-card {
      flex-direction: column;
      align-items: stretch;
    }

    .cred-actions {
      justify-content: flex-start;
    }
  }
</style>
