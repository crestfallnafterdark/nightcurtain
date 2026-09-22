<script>
  import { sandboxStore, GENERIC_REALM_ID } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { resolveToolGrants } from './toolPresetResolve.ts';

  let { onclose = () => {} } = $props();

  let agentId = $state('');
  let name = $state('');
  let role = $state('');
  let systemPrompt = $state('You are an autonomous AI agent operating within the sandbox environment. You have access to virtual filesystem tools and inter-agent messaging to collaborate and accomplish mission objectives.');

  // Model binding: every agent binds to a catalog preset (MOD-20 OPEN-1,
  // binding-only), so the launcher picks from the full catalog instead of
  // editing provider/model fields. A missing choice binds the active preset.
  const presetCatalog = sandboxStore.getPresetCatalog();
  let catalogPresets = $state(presetCatalog.listPresets());
  let activePresetId = $state(presetCatalog.createPresetSourcePort().getDefaultPresetId());
  let selectedPresetId = $state(activePresetId);

  $effect(() => {
    const unsubscribe = presetCatalog.subscribe(() => {
      catalogPresets = presetCatalog.listPresets();
      activePresetId = presetCatalog.createPresetSourcePort().getDefaultPresetId();
      if (!catalogPresets.some(p => p.id === selectedPresetId)) {
        selectedPresetId = activePresetId;
      }
    });
    return unsubscribe;
  });

  let selectedPreset = $derived(
    catalogPresets.find(p => p.id === selectedPresetId)
      || catalogPresets.find(p => p.id === activePresetId)
      || catalogPresets[0]
      || null
  );

  // Agent-level hyper-parameters (the preset owns provider/model tuning).
  let maxTurns = $state(100000);

  // Wave A Realm membership; Wave R (56ba4b9): every agent belongs to a Realm,
  // so the launcher defaults to the seeded Generic default and never offers an
  // ungrouped option. The store's realm registry is the single source of
  // options; the launch carries the id as an explicit operator-context
  // membership request, validated by the runtime.
  let realms = $derived(sandboxStore.realms);
  let selectedRealmId = $state(GENERIC_REALM_ID);

  // A Realm deleted (or pruned) while this modal is open must not linger as a
  // dangling selection: fall back to the Generic default, then the first
  // registered record.
  $effect(() => {
    if (realms.some((realm) => realm.id === selectedRealmId)) return;
    selectedRealmId = realms.some((realm) => realm.id === GENERIC_REALM_ID)
      ? GENERIC_REALM_ID
      : (realms[0]?.id ?? '');
  });

  // Authority & Tools
  let privileged = $state(false);
  let toolPreset = $state('all');
  let customTools = $state('');
  let initialPrompt = $state('');
  let validationError = $state('');
  let isSubmitting = $state(false);

  function clearValidationError() {
    if (validationError) validationError = '';
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) {
      onclose();
    }
  }

  let modalRef = $state(null);

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      onclose();
      return;
    }
    if (e.key === 'Tab' && modalRef) {
      const focusable = modalRef.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || !modalRef.contains(document.activeElement)) {
          last.focus();
          e.preventDefault();
        }
      } else {
        if (document.activeElement === last || !modalRef.contains(document.activeElement)) {
          first.focus();
          e.preventDefault();
        }
      }
    }
  }

  async function handleLaunch(e) {
    e.preventDefault();
    validationError = '';

    // Manual validation (form is `novalidate`): native pattern/required bubbles
    // are replaced by the inline error banner, with the input constraints kept.
    const trimmedId = agentId.trim();
    if (!trimmedId) {
      validationError = 'Agent ID is required (e.g. "agent-scout")';
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(trimmedId)) {
      validationError = 'Agent ID may only contain letters, numbers, hyphens, and underscores.';
      return;
    }

    const cleanId = trimmedId.toLowerCase().replace(/\s+/g, '-');
    // Staged realm-opaque uniqueness (Wave R ticket ff2202a): ids are plain
    // (no realm prefix), never auto-suffixed, and the registry keys them
    // globally — so a duplicate is denied inline both inside the target Realm
    // and across Realms until realm-local id namespacing lands.
    const collision = sandboxStore.agents.find(a => a.id === cleanId);
    if (collision) {
      const collisionRealmId = collision.config?.realmId ?? null;
      if (selectedRealmId && collisionRealmId === selectedRealmId) {
        validationError = `An agent with ID "${cleanId}" already exists in this Realm — ids are never auto-suffixed; choose a different id.`;
      } else if (collisionRealmId) {
        validationError = `An agent with ID "${cleanId}" already exists in another Realm — agent ids are realm-opaque and stay globally unique until realm-local namespacing lands; choose a different id.`;
      } else {
        validationError = `An agent with ID "${cleanId}" already exists — choose a different id.`;
      }
      return;
    }

    const preset = selectedPreset;
    if (!preset) {
      validationError = 'No model preset is available. Create a preset in Settings before launching an agent.';
      return;
    }

    if (!selectedRealmId || !realms.some((realm) => realm.id === selectedRealmId)) {
      validationError = 'Select a Realm — every agent belongs to one, and membership is fixed at launch.';
      return;
    }

    // Tool grants: a blank custom whitelist is rejected here instead of being
    // silently widened to the ['*'] wildcard grant.
    const toolGrants = resolveToolGrants(toolPreset, customTools);
    if (!toolGrants.ok) {
      validationError = toolGrants.error;
      return;
    }

    isSubmitting = true;
    try {
      // Binding-only launch (MOD-20 OPEN-1): the agent carries the chosen
      // catalog preset id and resolves its effective model config from the
      // catalog at construction/turn start. No per-field override layer.
      await sandboxStore.launchAgent({
        id: cleanId,
        name: name.trim() || cleanId,
        role: role.trim() || 'Autonomous Agent',
        systemPrompt: systemPrompt.trim(),
        presetId: preset.id,
        maxTurns: Number(maxTurns) > 0 ? Number(maxTurns) : 100000,
        privileged,
        allowedTools: toolGrants.allowedTools,
        realmId: selectedRealmId || null
      }, initialPrompt.trim() || null);

      onclose();
    } catch (err) {
      validationError = err.message || 'Failed to launch agent';
    } finally {
      isSubmitting = false;
    }
  }
</script>

<div
  class="modal-backdrop"
  role="presentation"
  tabindex="-1"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
>
  <div bind:this={modalRef} class="launcher-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="launcher-title">
    <div class="modal-header">
      <div class="header-left">
        <div class="icon-chip">
          <svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
          </svg>
        </div>
        <div>
          <h2 id="launcher-title" class="modal-title">Provision New Agent</h2>
          <p class="modal-sub">Deploy an autonomous agent with custom tools and lifecycle policies</p>
        </div>
      </div>
      <button type="button" class="btn-close" onclick={onclose} aria-label="Close modal">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    {#if validationError}
      <div class="error-banner">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{validationError}</span>
      </div>
    {/if}

    <form class="launcher-form" onsubmit={handleLaunch} novalidate>
      <div class="form-grid">
        <div class="form-group">
          <label for="agent-id">Agent Identifier <span class="req">*</span></label>
          <input
            id="agent-id"
            type="text"
            bind:value={agentId}
            placeholder="e.g. agent-scout, commander-01"
            class="input-field"
            required
            pattern="[a-zA-Z0-9_\-]+"
            oninput={clearValidationError}
          />
          <span class="field-hint">Unique alphanumeric slug</span>
        </div>

        <div class="form-group">
          <label for="agent-name">Display Name</label>
          <input
            id="agent-name"
            type="text"
            bind:value={name}
            placeholder="e.g. Scout Recon Unit"
            class="input-field"
          />
          <span class="field-hint">Human-readable label</span>
        </div>
      </div>

      <div class="form-group">
        <label for="agent-role">Agent Role / Specialization</label>
        <input
          id="agent-role"
          type="text"
          bind:value={role}
          placeholder="e.g. Telemetry Gathering, Tactical Analysis, Code Audit"
          class="input-field"
        />
      </div>

      <div class="form-group">
        <label for="realm-select">Realm Membership</label>
        <select id="realm-select" bind:value={selectedRealmId} onchange={clearValidationError} class="select-field">
          {#each realms as realm (realm.id)}
            <option value={realm.id}>{realm.name}</option>
          {/each}
        </select>
        <span class="field-hint">
          Isolation scope for this agent (default Generic). Membership is fixed at launch — changing realms means terminate and relaunch.
        </span>
      </div>

      <div class="form-group">
        <label for="system-prompt">System Instructions (Prompt)</label>
        <textarea
          id="system-prompt"
          bind:value={systemPrompt}
          rows="3"
          placeholder="Define agent personality, operational constraints, and domain focus..."
          class="textarea-field"
        ></textarea>
      </div>

      <!-- SECTION 2: MODEL & INFERENCE ENGINE -->
      <div class="settings-section-card">
        <div class="section-card-header">
          <div class="section-title-wrap">
            <span class="section-badge">Inference Engine</span>
            <h4 class="section-title">Model Preset Binding</h4>
          </div>
        </div>

        <div class="form-group">
          <label for="preset-select">Model Preset</label>
          <select id="preset-select" bind:value={selectedPresetId} onchange={clearValidationError} class="select-field">
            {#each catalogPresets as preset (preset.id)}
              <option value={preset.id}>
                {preset.name} — {preset.modelConfig.modelId}{preset.id === activePresetId ? ' · active' : ''}{preset.isCustom ? ' · custom' : ''}
              </option>
            {/each}
          </select>
          <span class="field-hint">
            Agents are bound to one catalog preset (binding-only). Edit or create presets in Settings; the active preset is the default.
          </span>
        </div>

        {#if selectedPreset}
          <div class="preset-summary">
            <div class="preset-summary-row">
              <span class="summary-label">Provider</span>
              <span class="summary-value font-mono">{selectedPreset.modelConfig.providerId || 'auto'}</span>
            </div>
            <div class="preset-summary-row">
              <span class="summary-label">Model</span>
              <span class="summary-value font-mono">{selectedPreset.modelConfig.modelId}</span>
            </div>
            <div class="preset-summary-row">
              <span class="summary-label">Temperature</span>
              <span class="summary-value font-mono">{selectedPreset.modelConfig.temperature ?? 'default'}</span>
            </div>
            <div class="preset-summary-row">
              <span class="summary-label">Reasoning</span>
              <span class="summary-value font-mono">{selectedPreset.modelConfig.reasoningEffort || 'high'}</span>
            </div>
            {#if selectedPreset.modelConfig.routing}
              <div class="preset-summary-row">
                <span class="summary-label">Routing</span>
                <span class="summary-value font-mono">{selectedPreset.modelConfig.routing}</span>
              </div>
            {/if}
            {#if selectedPreset.modelConfig.url}
              <div class="preset-summary-row">
                <span class="summary-label">Endpoint</span>
                <span class="summary-value font-mono">{selectedPreset.modelConfig.url}</span>
              </div>
            {/if}
          </div>
        {/if}

        <div class="form-group">
          <label for="max-turns">Max Tool Turns</label>
          <input
            id="max-turns"
            type="number"
            min="1"
            max="1000000"
            bind:value={maxTurns}
            class="input-field"
          />
          <span class="field-hint">Loop step limit per turn</span>
        </div>
      </div>

      <div class="form-group">
        <span class="label-text">Security & Authority</span>
        <label class="privileged-card" class:active={privileged}>
          <input type="checkbox" bind:checked={privileged} />
          <div class="policy-info">
            <div class="policy-header-row">
              <span class="policy-name">⚡ Sudo / Administrative Authority</span>
              {#if privileged}
                <span class="sudo-tag font-mono">ROOT PRIVILEGES</span>
              {/if}
            </div>
            <span class="policy-desc">
              Grants universal root permissions: cross-workspace virtual filesystem write access, modifying protected /global/ configurations, and terminating or inspecting peer agents.
            </span>
          </div>
        </label>
      </div>

      <div class="form-group">
        <span class="label-text">Tool Permission Profile</span>
        <div class="tool-presets-grid">
          <label class="preset-card" class:active={toolPreset === 'all'}>
            <input type="radio" name="toolPreset" value="all" bind:group={toolPreset} />
            <div class="preset-info">
              <span class="preset-name">Full Access (*)</span>
              <span class="preset-desc">All virtual filesystem, messaging, scheduling, and runtime tools enabled.</span>
            </div>
          </label>

          <label class="preset-card" class:active={toolPreset === 'manager'}>
            <input type="radio" name="toolPreset" value="manager" bind:group={toolPreset} />
            <div class="preset-info">
              <span class="preset-name">Lead / Manager</span>
              <span class="preset-desc">Full collaborator suite + subagent management (spawn, invoke, kill child agents).</span>
            </div>
          </label>

          <label class="preset-card" class:active={toolPreset === 'collaborator'}>
            <input type="radio" name="toolPreset" value="collaborator" bind:group={toolPreset} />
            <div class="preset-info">
              <span class="preset-name">Standard Collaborator</span>
              <span class="preset-desc">Filesystem, messaging, and scheduling. Inter-agent collaboration via messaging.</span>
            </div>
          </label>

          <label class="preset-card" class:active={toolPreset === 'readonly_collaborator'}>
            <input type="radio" name="toolPreset" value="readonly_collaborator" bind:group={toolPreset} />
            <div class="preset-info">
              <span class="preset-name">Read-Only Collaborator</span>
              <span class="preset-desc">File inspection, search, inbox querying, and outbound peer messaging.</span>
            </div>
          </label>

          <label class="preset-card" class:active={toolPreset === 'readonly'}>
            <input type="radio" name="toolPreset" value="readonly" bind:group={toolPreset} />
            <div class="preset-info">
              <span class="preset-name">Read-Only Observer</span>
              <span class="preset-desc">Inspection, file reading, and inbox querying only. Zero write permissions.</span>
            </div>
          </label>

          <label class="preset-card" class:active={toolPreset === 'custom'}>
            <input type="radio" name="toolPreset" value="custom" bind:group={toolPreset} />
            <div class="preset-info">
              <span class="preset-name">Custom Whitelist</span>
              <span class="preset-desc">Manually specify a comma-separated list of permitted tool names.</span>
            </div>
          </label>
        </div>

        {#if toolPreset === 'custom'}
          <div class="custom-tools-input-wrap">
            <label for="custom-tools-input" class="sub-label">Permitted Tools (comma-separated):</label>
            <input
              id="custom-tools-input"
              type="text"
              bind:value={customTools}
              placeholder="read_file, write_file, send_message, whoami"
              class="input-field font-mono"
              oninput={clearValidationError}
            />
            <span class="field-hint">e.g. read_file, write_file, send_message, schedule</span>
          </div>
        {/if}
      </div>

      <div class="form-group">
        <label for="initial-prompt">Initial User Prompt <span class="opt">(Optional)</span></label>
        <textarea
          id="initial-prompt"
          bind:value={initialPrompt}
          rows="2"
          placeholder="Optional starting turn prompt (triggers turn immediately on launch)..."
          class="textarea-field"
        ></textarea>
      </div>

      <div class="modal-footer">
        <button type="button" class="btn-secondary" onclick={onclose} disabled={isSubmitting}>
          Cancel
        </button>
        <button type="submit" class="btn-primary" disabled={isSubmitting}>
          {#if isSubmitting}
            <span class="spinner-sm"></span>
            <span>Launching...</span>
          {:else}
            <span>Launch Agent</span>
          {/if}
        </button>
      </div>
    </form>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(12, 13, 14, 0.85);
    backdrop-filter: blur(8px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1.5rem;
    animation: fade-in 0.2s ease-out;
  }

  .launcher-modal {
    width: 100%;
    max-width: 680px;
    max-height: 90vh;
    overflow-y: auto;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 12px;
    padding: 1.75rem;
    box-shadow: var(--shadow-lg);
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }

  .icon-chip {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: var(--accent-primary-subtle);
    border: 1px solid var(--accent-primary-border);
    color: var(--accent-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .modal-title {
    font-size: 1.2rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }

  .modal-sub {
    font-size: 0.82rem;
    color: var(--text-secondary);
    margin: 0.15rem 0 0 0;
  }

  .btn-close {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0.35rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
  }

  .btn-close:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  .error-banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem 1rem;
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    border-radius: 8px;
    color: #f87171;
    font-size: 0.85rem;
  }

  .launcher-form {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .settings-section-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.95rem;
  }

  .section-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: 0.5rem;
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
    background: rgba(192, 132, 252, 0.15);
    color: #c084fc;
    border: 1px solid rgba(192, 132, 252, 0.3);
  }

  .section-title {
    margin: 0;
    font-size: 0.92rem;
    color: var(--text-primary);
    font-weight: 600;
  }

  .preset-summary {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.7rem 0.85rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }

  .preset-summary-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
  }

  .summary-label {
    font-size: 0.74rem;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .summary-value {
    font-size: 0.8rem;
    color: var(--text-primary);
    text-align: right;
    word-break: break-all;
  }

  label, .label-text {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .req {
    color: var(--accent-danger);
  }

  .opt {
    font-weight: normal;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .field-hint {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .input-field, .textarea-field, .select-field {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    font-size: 0.88rem;
    font-family: inherit;
    transition: border-color 0.15s;
  }

  .input-field:focus, .textarea-field:focus, .select-field:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .textarea-field {
    resize: vertical;
    line-height: 1.45;
  }

  .policy-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .policy-name {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .policy-desc {
    font-size: 0.72rem;
    color: var(--text-secondary);
    line-height: 1.35;
  }

  .privileged-card {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.85rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .privileged-card:hover {
    border-color: rgba(245, 158, 11, 0.4);
  }

  .privileged-card.active {
    border-color: #f59e0b;
    background: rgba(245, 158, 11, 0.08);
    box-shadow: 0 0 12px rgba(245, 158, 11, 0.15);
  }

  .privileged-card input[type="checkbox"] {
    margin-top: 0.2rem;
    accent-color: #f59e0b;
    width: 16px;
    height: 16px;
    cursor: pointer;
  }

  .policy-header-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .sudo-tag {
    font-size: 0.68rem;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.4);
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .tool-presets-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .preset-card {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    padding: 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .preset-card:hover {
    border-color: var(--border-hover, #444);
  }

  .preset-card.active {
    border-color: var(--accent-primary);
    background: var(--accent-primary-subtle);
  }

  .preset-card input[type="radio"] {
    margin-top: 0.2rem;
    accent-color: var(--accent-primary);
  }

  .preset-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .preset-name {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .preset-desc {
    font-size: 0.72rem;
    color: var(--text-secondary);
    line-height: 1.35;
  }

  .custom-tools-input-wrap {
    margin-top: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }

  .sub-label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 0.75rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-subtle);
  }

  .spinner-sm {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (max-width: 640px) {
    .form-grid, .tool-presets-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
