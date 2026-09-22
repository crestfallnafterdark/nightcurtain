<script>
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { TOOL_PRESETS } from '$lib/sandbox/toolDefinitions/index.ts';
  import { AGENT_AUTHORITIES } from '../../sandbox/realmCatalog/index.ts';
  import { createAgentIdentityKey } from '../../sandbox/runtime/index.ts';
  import {
    META_AUTHORITY_TOGGLES,
    applyMetaAuthorityToggle,
    buildMetaAuthorityToggleState
  } from './realmReviewHelpers.ts';
  import { resolveAgentRealmId } from './realmGroups.ts';

  // MOD-20 preset catalog: the single source of model truth. The panel binds
  // agents to catalog presets (binding-only, OPEN-1) and edits the bound
  // preset explicitly — never a per-agent override or inherit layer.
  const presetCatalog = sandboxStore.getPresetCatalog();
  let catalogPresets = $state(presetCatalog.listPresets());
  let activePresetId = $state(presetCatalog.createPresetSourcePort().getDefaultPresetId());

  $effect(() => {
    const unsubscribe = presetCatalog.subscribe(() => {
      catalogPresets = presetCatalog.listPresets();
      activePresetId = presetCatalog.createPresetSourcePort().getDefaultPresetId();
    });
    return unsubscribe;
  });

  let agent = $derived(sandboxStore.selectedAgent);

  // Form State (mirrors the selected agent's live runtime configuration)
  let name = $state('');
  let role = $state('');
  let systemPrompt = $state('');
  let modelPresetId = $state('');
  let presetDraft = $state({ modelId: '', temperature: 0.7, reasoningEffort: 'high', routing: '', url: '' });
  let presetDraftSnapshot = $state('');
  let privileged = $state(false);
  let toolPreset = $state('all');
  let toolsString = $state('*');
  let feedbackMessage = $state('');
  let feedbackType = $state('success');
  let feedbackTimer = null;

  // Per-field auto-apply feedback, keyed by field id. Every edit is applied to
  // the agent runtime as it is made; these badges are the "saved" acknowledgement.
  let fieldFeedback = $state({});
  const fieldFeedbackTimers = {};
  const pendingApplies = {};

  const TOOL_PRESET_ITEMS = [
    {
      id: 'all',
      name: 'Full Access (*)',
      desc: 'All virtual filesystem, messaging, scheduling, and runtime tools enabled.'
    },
    {
      id: 'manager',
      name: 'Lead / Manager',
      desc: 'Full collaborator suite + subagent management (spawn, invoke, kill child agents).'
    },
    {
      id: 'collaborator',
      name: 'Standard Collaborator',
      desc: 'Filesystem, messaging, and scheduling. Inter-agent collaboration via messaging.'
    },
    {
      id: 'readonly_collaborator',
      name: 'Read-Only Collaborator',
      desc: 'File inspection, search, inbox querying, and outbound peer messaging.'
    },
    {
      id: 'readonly',
      name: 'Read-Only Observer',
      desc: 'Inspection, file reading, and inbox querying only. Zero write permissions.'
    }
  ];

  let lastAgentId = $state(null);

  function clearPendingApplies() {
    for (const field of Object.keys(pendingApplies)) {
      if (pendingApplies[field]) clearTimeout(pendingApplies[field]);
      pendingApplies[field] = null;
    }
  }

  let selectedCatalogPreset = $derived(catalogPresets.find(p => p.id === modelPresetId) || null);

  function serializePresetDraft() {
    return JSON.stringify({
      modelId: presetDraft.modelId.trim(),
      temperature: Number(presetDraft.temperature),
      reasoningEffort: presetDraft.reasoningEffort.trim(),
      routing: presetDraft.routing.trim(),
      url: presetDraft.url.trim()
    });
  }

  let presetDraftDirty = $derived(serializePresetDraft() !== presetDraftSnapshot);

  function resolveAgentPresetId() {
    if (!agent) return '';
    const boundId = typeof agent.config?.presetId === 'string' ? agent.config.presetId.trim() : '';
    if (boundId && presetCatalog.getPreset(boundId)) return boundId;
    return activePresetId;
  }

  function seedPresetDraft(preset) {
    const mc = preset?.modelConfig;
    presetDraft = {
      modelId: mc?.modelId || '',
      temperature: typeof mc?.temperature === 'number' ? mc.temperature : 0.7,
      reasoningEffort: mc?.reasoningEffort || 'high',
      routing: mc?.routing || '',
      url: mc?.url || ''
    };
    presetDraftSnapshot = serializePresetDraft();
  }

  function buildDraftModelConfig(base) {
    const config = {
      ...base,
      modelId: presetDraft.modelId.trim(),
      temperature: Number(presetDraft.temperature)
    };
    const reasoning = presetDraft.reasoningEffort.trim();
    if (reasoning) config.reasoningEffort = reasoning;
    const routing = presetDraft.routing.trim();
    if (routing) config.routing = routing; else delete config.routing;
    const url = presetDraft.url.trim();
    if (url) config.url = url; else delete config.url;
    return config;
  }

  // Hydrate the form from the selected agent's live runtime configuration.
  // This is the single place local state is overwritten from the runtime.
  function syncFormFromAgent() {
    if (!agent) return;
    name = agent.name || '';
    role = agent.config?.role || '';
    systemPrompt = agent.config?.systemPrompt || '';
    privileged = Boolean(agent.config?.privileged);

    modelPresetId = resolveAgentPresetId();
    seedPresetDraft(presetCatalog.getPreset(modelPresetId));

    const rawTools = Array.isArray(agent.config?.allowedTools)
      ? agent.config.allowedTools
      : (agent.config?.allowedTools === '*' ? ['*'] : null);

    if (!rawTools || (rawTools.length === 1 && rawTools[0] === '*')) {
      toolPreset = 'all';
      toolsString = '*';
    } else {
      const managerJoined = (TOOL_PRESETS.manager || []).join(', ');
      const collabJoined = (TOOL_PRESETS.collaborator || []).join(', ');
      const readonlyCollabJoined = (TOOL_PRESETS.readonly_collaborator || []).join(', ');
      const readonlyJoined = (TOOL_PRESETS.readonly || []).join(', ');
      const currentJoined = rawTools.join(', ');

      if (currentJoined === managerJoined) {
        toolPreset = 'manager';
      } else if (currentJoined === collabJoined) {
        toolPreset = 'collaborator';
      } else if (currentJoined === readonlyCollabJoined) {
        toolPreset = 'readonly_collaborator';
      } else if (currentJoined === readonlyJoined) {
        toolPreset = 'readonly';
      } else {
        toolPreset = 'custom';
      }
      toolsString = currentJoined;
    }
  }

  // Load runtime values as soon as an agent is selected; live edits are never
  // clobbered by the store's post-apply state refreshes (same agent id).
  $effect(() => {
    const currentId = agent?.id ?? null;
    if (currentId === null) {
      lastAgentId = null;
      clearPendingApplies();
      return;
    }
    if (currentId !== lastAgentId) {
      lastAgentId = currentId;
      clearPendingApplies();
      fieldFeedback = {};
      syncFormFromAgent();
    }
  });

  function showFeedback(msg, type = 'success') {
    feedbackMessage = msg;
    feedbackType = type;
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(() => {
      feedbackMessage = '';
    }, 4000);
  }

  function setFieldFeedback(field, msg, type = 'success') {
    const entry = { msg, type };
    fieldFeedback = { ...fieldFeedback, [field]: entry };
    if (fieldFeedbackTimers[field]) clearTimeout(fieldFeedbackTimers[field]);
    fieldFeedbackTimers[field] = setTimeout(() => {
      if (fieldFeedback[field] === entry) {
        const next = { ...fieldFeedback };
        delete next[field];
        fieldFeedback = next;
      }
    }, 2600);
  }

  // Applies a partial config update to the agent runtime immediately.
  function applyAgentUpdate(field, patch, successMsg, targetId) {
    if (pendingApplies[field]) {
      clearTimeout(pendingApplies[field]);
      pendingApplies[field] = null;
    }
    const id = targetId || agent?.id;
    if (!id) return;
    try {
      sandboxStore.updateAgentConfig(id, patch);
      setFieldFeedback(field, successMsg, 'success');
    } catch (err) {
      setFieldFeedback(field, err.message || 'Update failed.', 'error');
      showFeedback(err.message || 'Failed to update agent configuration.', 'error');
      syncFormFromAgent();
    }
  }

  // Debounced apply for free-text fields so each keystroke does not churn the
  // runtime; the captured agent id prevents cross-agent leaks on fast switches.
  function scheduleAgentUpdate(field, patch, successMsg) {
    const targetId = agent?.id;
    if (!targetId) return;
    if (pendingApplies[field]) clearTimeout(pendingApplies[field]);
    setFieldFeedback(field, 'Applying…', 'pending');
    pendingApplies[field] = setTimeout(() => {
      pendingApplies[field] = null;
      applyAgentUpdate(field, patch, successMsg, targetId);
    }, 300);
  }

  function parseAllowedTools() {
    if (toolsString.trim() === '*') return ['*'];
    const list = toolsString.split(',').map(t => t.trim()).filter(Boolean);
    return list.length > 0 ? list : ['*'];
  }

  function handleNameInput(e) {
    name = e.currentTarget.value;
    const trimmed = name.trim();
    if (!trimmed) {
      if (pendingApplies.name) {
        clearTimeout(pendingApplies.name);
        pendingApplies.name = null;
      }
      setFieldFeedback('name', 'Display Name cannot be empty.', 'error');
      return;
    }
    scheduleAgentUpdate('name', { name: trimmed }, 'Display name saved');
  }

  function handleRoleInput(e) {
    role = e.currentTarget.value;
    scheduleAgentUpdate('role', { role: role.trim() || 'Autonomous Agent' }, 'Role saved');
  }

  function handleSystemPromptInput(e) {
    systemPrompt = e.currentTarget.value;
    scheduleAgentUpdate('systemPrompt', { systemPrompt: systemPrompt.trim() }, 'System prompt saved');
  }

  function handlePrivilegedChange(e) {
    privileged = e.currentTarget.checked;
    applyAgentUpdate('privileged', { privileged }, 'Authority saved');
  }

  function handleModelPresetChange(e) {
    const value = e.currentTarget.value;
    const preset = presetCatalog.getPreset(value);
    if (!preset) {
      setFieldFeedback('model', 'Unknown model preset.', 'error');
      return;
    }
    modelPresetId = value;
    seedPresetDraft(preset);
    applyAgentUpdate('model', { presetId: value }, 'Agent bound to preset');
  }

  // Explicit bound-preset editing (binding-only, OPEN-1): "Save preset changes"
  // writes through the catalog; nothing is written silently.
  function savePresetChanges() {
    const preset = presetCatalog.getPreset(modelPresetId);
    if (!preset) {
      setFieldFeedback('model', 'Preset no longer exists.', 'error');
      return;
    }
    const modelId = presetDraft.modelId.trim();
    if (!modelId) {
      setFieldFeedback('model', 'Model ID cannot be empty.', 'error');
      return;
    }
    try {
      presetCatalog.savePreset({
        id: preset.id,
        name: preset.name,
        isCustom: preset.isCustom,
        modelConfig: buildDraftModelConfig(preset.modelConfig)
      });
      seedPresetDraft(presetCatalog.getPreset(preset.id));
      setFieldFeedback('model', 'Preset saved', 'success');
      showFeedback(`Preset "${preset.name}" updated. Bound agents pick up the change at their next turn.`, 'success');
    } catch (err) {
      setFieldFeedback('model', err.message || 'Preset save failed.', 'error');
    }
  }

  // Fork the edited draft into a new custom preset and bind the agent to it,
  // leaving the original (official or shared) entry untouched.
  function duplicateAsCustom() {
    if (!agent) return;
    const source = presetCatalog.getPreset(modelPresetId);
    if (!source) {
      setFieldFeedback('model', 'Preset no longer exists.', 'error');
      return;
    }
    const modelId = presetDraft.modelId.trim();
    if (!modelId) {
      setFieldFeedback('model', 'Model ID cannot be empty.', 'error');
      return;
    }
    const newId = `preset_custom_${Date.now()}`;
    try {
      presetCatalog.savePreset({
        id: newId,
        name: `${source.name} (Custom)`,
        isCustom: true,
        modelConfig: buildDraftModelConfig(source.modelConfig)
      });
      modelPresetId = newId;
      seedPresetDraft(presetCatalog.getPreset(newId));
      applyAgentUpdate('model', { presetId: newId }, 'Bound to custom preset');
      showFeedback(`Created custom preset "${source.name} (Custom)" and bound the agent to it.`, 'success');
    } catch (err) {
      setFieldFeedback('model', err.message || 'Preset creation failed.', 'error');
    }
  }

  function handleSelectToolPreset(presetKey) {
    toolPreset = presetKey;
    if (presetKey === 'all') {
      toolsString = '*';
    } else if (TOOL_PRESETS[presetKey]) {
      toolsString = TOOL_PRESETS[presetKey].join(', ');
    }
    applyAgentUpdate('tools', { allowedTools: parseAllowedTools() }, 'Tool permissions saved');
  }

  function handleToolsStringInput(e) {
    toolsString = e.currentTarget.value;
    toolPreset = 'custom';
    scheduleAgentUpdate('tools', { allowedTools: parseAllowedTools() }, 'Tool permissions saved');
  }

  let activeToolCountDisplay = $derived.by(() => {
    if (toolPreset === 'all' || toolsString.trim() === '*') return '34 (All Tools)';
    const count = toolsString.split(',').map(t => t.trim()).filter(Boolean).length;
    return `${count} active`;
  });

  // Wave U operator publishing authorities (ticket 458e727): the two dedicated
  // grants are explicit-only operator actions (never implied by privilege or
  // the wildcard), rendered with their live registry state and applied through
  // the store's grant/revoke methods. The listing keys on the canonical
  // (realmId, agentId) identity so a same-id agent in another Realm is never
  // retargeted.
  let metaAuthorityGrants = $state(
    /** @type {{ template: readonly string[], hydration: readonly string[] }} */({ template: [], hydration: [] })
  );
  let lastMetaAuthorityAgentId = $state(/** @type {string | null} */(null));

  /** Canonical identity key of the selected agent (the grant registry key). */
  let metaAuthorityAgentKey = $derived(
    agent ? createAgentIdentityKey(resolveAgentRealmId(agent), agent.id) : ''
  );

  /** Live grant state of the selected agent per authority. */
  let metaAuthorityState = $derived(buildMetaAuthorityToggleState(metaAuthorityGrants, metaAuthorityAgentKey));

  /** Toggle rows with their live checked state. */
  let metaAuthorityToggleViews = $derived(META_AUTHORITY_TOGGLES.map((toggle) => ({
    ...toggle,
    enabled: toggle.authority === AGENT_AUTHORITIES.TEMPLATE
      ? metaAuthorityState.template
      : metaAuthorityState.hydration
  })));

  /** Re-reads the operator grant registry. */
  function refreshMetaAuthorityGrants() {
    metaAuthorityGrants = sandboxStore.listMetaAuthorityGrants();
  }

  $effect(() => {
    const currentId = agent?.id ?? null;
    if (currentId !== lastMetaAuthorityAgentId) {
      lastMetaAuthorityAgentId = currentId;
      refreshMetaAuthorityGrants();
    }
  });

  /**
   * Applies one publishing-authority toggle through the real store and
   * re-reads the registry state; failures are surfaced inline.
   *
   * @param {string} authority - Authority id (`@template:authority` / `@hydration:authority`).
   * @param {boolean} enabled - Requested state.
   */
  async function handleMetaAuthorityToggle(authority, enabled) {
    if (!agent) return;
    const field = `meta-authority:${authority}`;
    setFieldFeedback(field, enabled ? 'Granting…' : 'Revoking…', 'pending');
    const result = await applyMetaAuthorityToggle(sandboxStore, {
      agentId: agent.id,
      authority,
      enabled,
      realmId: resolveAgentRealmId(agent)
    });
    refreshMetaAuthorityGrants();
    if (result.ok) {
      setFieldFeedback(field, enabled ? 'Granted' : 'Revoked', 'success');
      showFeedback(
        enabled
          ? `Granted ${authority} to ${agent.name || agent.id}.`
          : `Revoked ${authority} from ${agent.name || agent.id}.`,
        'success'
      );
      return;
    }
    setFieldFeedback(field, result.error, 'error');
    showFeedback(result.error, 'error');
  }
</script>

<div class="agent-settings-pane">
  {#if !agent}
    <div class="empty-selection">
      <div class="empty-icon">⚙️</div>
      <h3>No Agent Selected</h3>
      <p>Select an agent from the left roster to view and customize its configuration.</p>
    </div>
  {:else}
    <div class="settings-layout">
      <!-- Top Inspector-style Header -->
      <header class="settings-top-header">
        <div class="agent-identity-block">
          <div class="agent-avatar-box">
            <svg class="icon-svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
            </svg>
          </div>
          <div class="agent-meta">
            <div class="name-row">
              <h2 class="agent-name">{agent.name || agent.id}</h2>
              <span class="state-tag state-{agent.state} font-mono">{agent.state}</span>
              {#if agent.config?.privileged}
                <span class="sudo-tag font-mono">⚡ SUDO</span>
              {/if}
            </div>
            <div class="sub-row">
              <span class="agent-id-tag font-mono">ID: {agent.id}</span>
              <span class="divider">•</span>
              <span class="agent-role-tag">{agent.config?.role || 'Autonomous Agent'}</span>
            </div>
          </div>
        </div>

        <div class="header-right-actions">
          <span class="live-apply-badge" title="Every change on this panel is applied to the agent runtime as you edit it">
            <span class="live-dot"></span>
            Live apply
          </span>
        </div>
      </header>

      {#if feedbackMessage}
        <div class="feedback-alert" class:error={feedbackType === 'error'} class:success={feedbackType === 'success'}>
          {#if feedbackType === 'success'}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          {/if}
          <span>{feedbackMessage}</span>
        </div>
      {/if}

      <div class="settings-body-form">
        <!-- 2-Column Responsive Workspace Grid -->
        <div class="settings-grid">
          <!-- LEFT COLUMN: Identity & Model Preset -->
          <div class="settings-col">
            <!-- 1. Identity Card -->
            <section class="config-card">
              <div class="card-header">
                <span class="card-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  Agent Identity & Directives
                </span>
              </div>

              <div class="form-group">
                <div class="label-row">
                  <label for="agent-display-name">Display Name <span class="req">*</span></label>
                  {#if fieldFeedback.name}
                    <span class="field-status" class:pending={fieldFeedback.name.type === 'pending'} class:error={fieldFeedback.name.type === 'error'}>
                      {#if fieldFeedback.name.type === 'pending'}<span class="spinner-mini"></span>{/if}
                      {fieldFeedback.name.msg}
                    </span>
                  {/if}
                </div>
                <input
                  id="agent-display-name"
                  type="text"
                  class="input-field"
                  value={name}
                  oninput={handleNameInput}
                  placeholder="e.g. Director, Storyteller"
                />
              </div>

              <div class="form-group">
                <div class="label-row">
                  <label for="agent-role">Role Persona</label>
                  {#if fieldFeedback.role}
                    <span class="field-status" class:pending={fieldFeedback.role.type === 'pending'} class:error={fieldFeedback.role.type === 'error'}>
                      {#if fieldFeedback.role.type === 'pending'}<span class="spinner-mini"></span>{/if}
                      {fieldFeedback.role.msg}
                    </span>
                  {/if}
                </div>
                <input
                  id="agent-role"
                  type="text"
                  class="input-field"
                  value={role}
                  oninput={handleRoleInput}
                  placeholder="e.g. Root Orchestrator, Lorekeeper"
                />
              </div>

              <div class="form-group">
                <div class="label-row">
                  <label for="agent-system-prompt">System Prompt & Directives</label>
                  {#if fieldFeedback.systemPrompt}
                    <span class="field-status" class:pending={fieldFeedback.systemPrompt.type === 'pending'} class:error={fieldFeedback.systemPrompt.type === 'error'}>
                      {#if fieldFeedback.systemPrompt.type === 'pending'}<span class="spinner-mini"></span>{/if}
                      {fieldFeedback.systemPrompt.msg}
                    </span>
                  {/if}
                </div>
                <textarea
                  id="agent-system-prompt"
                  class="textarea-field"
                  rows="16"
                  value={systemPrompt}
                  oninput={handleSystemPromptInput}
                  placeholder="Operational directives, behavioral guidelines, constraints..."
                ></textarea>
                <span class="field-hint">Defines the persona and governing constraints for the agent.</span>
              </div>
            </section>

            <!-- 2. Model Preset Card -->
            <section class="config-card">
              <div class="card-header">
                <span class="card-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10H12V2z"/><path d="M12 2a10 10 0 0 1 10 10h-10V2z"/></svg>
                  Model & Inference Preset
                </span>
              </div>

              <div class="form-group">
                <div class="label-row">
                  <label for="agent-model-preset">Bound Model Preset</label>
                  {#if fieldFeedback.model}
                    <span class="field-status" class:pending={fieldFeedback.model.type === 'pending'} class:error={fieldFeedback.model.type === 'error'}>
                      {#if fieldFeedback.model.type === 'pending'}<span class="spinner-mini"></span>{/if}
                      {fieldFeedback.model.msg}
                    </span>
                  {/if}
                </div>
                <select
                  id="agent-model-preset"
                  class="select-field"
                  value={modelPresetId}
                  onchange={handleModelPresetChange}
                >
                  {#each catalogPresets as preset (preset.id)}
                    <option value={preset.id}>
                      {preset.name} — {preset.modelConfig.modelId}{preset.id === activePresetId ? ' · active' : ''}{preset.isCustom ? ' · custom' : ''}
                    </option>
                  {/each}
                </select>
                <span class="field-hint">
                  {#if selectedCatalogPreset}
                    {selectedCatalogPreset.modelConfig.providerId || 'auto'} · {selectedCatalogPreset.modelConfig.modelId} · temp {selectedCatalogPreset.modelConfig.temperature ?? 'default'} · reasoning {selectedCatalogPreset.modelConfig.reasoningEffort || 'high'}{selectedCatalogPreset.isCustom ? ' · custom preset' : ' · official preset'}
                  {:else}
                    Select a catalog preset to bind this agent.
                  {/if}
                </span>
              </div>

              <div class="preset-editor">
                <div class="preset-editor-header">
                  <span class="preset-editor-title">Edit Bound Preset</span>
                  {#if presetDraftDirty}
                    <span class="dirty-pill font-mono">UNSAVED</span>
                  {/if}
                </div>

                <div class="form-group">
                  <label for="preset-model-id">Model ID</label>
                  <input
                    id="preset-model-id"
                    type="text"
                    class="input-field font-mono"
                    bind:value={presetDraft.modelId}
                  />
                </div>

                <div class="form-group">
                  <label for="preset-temperature">Temperature: <strong class="val-pill">{presetDraft.temperature}</strong></label>
                  <input
                    id="preset-temperature"
                    type="range"
                    min="0"
                    max="1.2"
                    step="0.05"
                    class="slider-field"
                    bind:value={presetDraft.temperature}
                  />
                </div>

                <div class="form-group">
                  <label for="preset-reasoning-effort">Reasoning Effort</label>
                  <input
                    id="preset-reasoning-effort"
                    type="text"
                    class="input-field font-mono"
                    placeholder="e.g. none, low, medium, high, max, xhigh"
                    bind:value={presetDraft.reasoningEffort}
                  />
                </div>

                <div class="form-group">
                  <label for="preset-routing">Routing Provider</label>
                  <input
                    id="preset-routing"
                    type="text"
                    class="input-field font-mono"
                    placeholder="Auto (or default)"
                    bind:value={presetDraft.routing}
                  />
                </div>

                <div class="form-group">
                  <label for="preset-endpoint-url">Endpoint URL</label>
                  <input
                    id="preset-endpoint-url"
                    type="text"
                    class="input-field font-mono"
                    placeholder="http://localhost:11434/v1"
                    bind:value={presetDraft.url}
                  />
                </div>

                <div class="preset-editor-actions">
                  <button
                    type="button"
                    class="btn-save-preset"
                    disabled={!presetDraftDirty || !selectedCatalogPreset}
                    onclick={savePresetChanges}
                    title="Write these values to the bound catalog preset"
                  >
                    Save preset changes
                  </button>
                  <button
                    type="button"
                    class="btn-duplicate-preset"
                    disabled={!selectedCatalogPreset}
                    onclick={duplicateAsCustom}
                    title="Create a new custom preset from these values and bind this agent to it"
                  >
                    Duplicate as custom
                  </button>
                </div>

                <span class="field-hint">
                  Presets are the single model source (no per-agent overrides). Saving updates the bound entry for every agent bound to it; "Duplicate as custom" forks a new custom entry.
                </span>
              </div>
            </section>
          </div>

          <!-- RIGHT COLUMN: Security & Tool Permissions -->
          <div class="settings-col">
            <!-- 3. Authority Card -->
            <section class="config-card">
              <div class="card-header">
                <span class="card-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                  Security & Authority
                </span>
              </div>

              <label class="privileged-box" class:active={privileged}>
                <input
                  type="checkbox"
                  class="checkbox-input"
                  checked={privileged}
                  onchange={handlePrivilegedChange}
                />
                <div class="policy-details">
                  <div class="policy-title-row">
                    <span class="policy-title">⚡ Sudo / Administrative Authority</span>
                    {#if privileged}
                      <span class="sudo-tag font-mono">ROOT PRIVILEGES</span>
                    {/if}
                    {#if fieldFeedback.privileged}
                      <span class="field-status" class:error={fieldFeedback.privileged.type === 'error'}>
                        {fieldFeedback.privileged.msg}
                      </span>
                    {/if}
                  </div>
                  <span class="policy-desc">
                    Grants universal administrative permissions: cross-workspace virtual filesystem write access, modifying protected /global/ configurations, and terminating peer agents.
                  </span>
                </div>
              </label>

              <div class="publishing-grants">
                <div class="publishing-grants-head">
                  <span class="publishing-grants-title">Publishing authorities (operator grants)</span>
                  <span class="publishing-distinct">explicit · revocable</span>
                </div>
                <span class="policy-desc">
                  Never implied by Sudo/Administrative Authority or the wildcard grant — these are dedicated,
                  explicit-only operator grants. Approving a template-declared request in the launch review applies
                  the same grant, and both surfaces revoke it here.
                </span>
                {#each metaAuthorityToggleViews as toggle (toggle.authority)}
                  <label class="authority-toggle" class:active={toggle.enabled}>
                    <input
                      type="checkbox"
                      class="checkbox-input authority-checkbox"
                      checked={toggle.enabled}
                      onchange={(event) => handleMetaAuthorityToggle(toggle.authority, event.currentTarget.checked)}
                    />
                    <div class="policy-details">
                      <div class="policy-title-row">
                        <span class="policy-title">{toggle.label}</span>
                        <span class="authority-id font-mono">{toggle.authority}</span>
                        {#if toggle.enabled}
                          <span class="authority-live-tag font-mono">GRANTED</span>
                        {/if}
                        {#if fieldFeedback[`meta-authority:${toggle.authority}`]}
                          <span
                            class="field-status"
                            class:pending={fieldFeedback[`meta-authority:${toggle.authority}`].type === 'pending'}
                            class:error={fieldFeedback[`meta-authority:${toggle.authority}`].type === 'error'}
                          >
                            {fieldFeedback[`meta-authority:${toggle.authority}`].msg}
                          </span>
                        {/if}
                      </div>
                      <span class="policy-desc">{toggle.description}</span>
                    </div>
                  </label>
                {/each}
              </div>
            </section>

            <!-- 4. Tool Capabilities Card -->
            <section class="config-card">
              <div class="card-header">
                <div class="card-header-title">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                  Tool Permission Profile
                </div>
                <div class="card-header-meta">
                  {#if fieldFeedback.tools}
                    <span class="field-status" class:pending={fieldFeedback.tools.type === 'pending'} class:error={fieldFeedback.tools.type === 'error'}>
                      {#if fieldFeedback.tools.type === 'pending'}<span class="spinner-mini"></span>{/if}
                      {fieldFeedback.tools.msg}
                    </span>
                  {/if}
                  <span class="tool-count-pill font-mono">{activeToolCountDisplay}</span>
                </div>
              </div>

              <div class="tool-presets-list">
                {#each TOOL_PRESET_ITEMS as item (item.id)}
                  <button
                    type="button"
                    class="preset-item-card"
                    class:active={toolPreset === item.id}
                    onclick={() => handleSelectToolPreset(item.id)}
                  >
                    <div class="preset-item-info">
                      <div class="preset-name-row">
                        <span class="preset-item-name">{item.name}</span>
                        {#if toolPreset === item.id}
                          <span class="selected-indicator font-mono">SELECTED</span>
                        {/if}
                      </div>
                      <span class="preset-item-desc">{item.desc}</span>
                    </div>
                  </button>
                {/each}
              </div>

              <div class="form-group custom-tools-group">
                <label for="agent-tools-string">Allowed Tools (Comma-separated or * for all)</label>
                <input
                  id="agent-tools-string"
                  type="text"
                  class="input-field font-mono"
                  value={toolsString}
                  oninput={handleToolsStringInput}
                  placeholder="e.g. *, readFile, writeFile, sendMessage"
                />
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .agent-settings-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 100%;
    overflow-y: auto;
    padding: 1.25rem;
    background: transparent;
  }

  .empty-selection {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 4rem 2rem;
    text-align: center;
    background: var(--bg-secondary, #0f172a);
    border: 1px solid var(--border-color, #334155);
    border-radius: 12px;
    color: var(--text-muted, #94a3b8);
  }

  .empty-icon {
    font-size: 3rem;
    margin-bottom: 1rem;
    opacity: 0.5;
  }

  .settings-layout {
    display: flex;
    flex-direction: column;
    width: 100%;
    gap: 1.25rem;
  }

  /* Top Header matching Inspector style */
  .settings-top-header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--bg-secondary, #0f172a);
    border: 1px solid var(--border-color, #334155);
    border-radius: 10px;
    padding: 0.9rem 1.25rem;
    gap: 1rem;
    flex-wrap: wrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(12px);
  }

  .agent-identity-block {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .agent-avatar-box {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    background: rgba(168, 85, 247, 0.15);
    border: 1px solid rgba(168, 85, 247, 0.35);
    color: #c084fc;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .agent-meta {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .name-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .agent-name {
    font-size: 1.2rem;
    font-weight: 700;
    color: var(--text-primary, #f8fafc);
    margin: 0;
  }

  .state-tag {
    font-size: 0.72rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: var(--text-muted, #94a3b8);
    text-transform: uppercase;
  }

  .state-tag.state-idle { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border-color: rgba(59, 130, 246, 0.3); }
  .state-tag.state-running { background: rgba(16, 185, 129, 0.15); color: #34d399; border-color: rgba(16, 185, 129, 0.3); }
  .state-tag.state-errored { background: rgba(239, 68, 68, 0.15); color: #f87171; border-color: rgba(239, 68, 68, 0.3); }

  .sudo-tag {
    font-size: 0.72rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(234, 179, 8, 0.15);
    border: 1px solid rgba(234, 179, 8, 0.35);
    color: #fde047;
    font-weight: 700;
  }

  .sub-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--text-muted, #94a3b8);
  }

  .divider { opacity: 0.4; }

  .header-right-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .live-apply-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.65rem;
    border-radius: 999px;
    background: rgba(16, 185, 129, 0.1);
    border: 1px solid rgba(16, 185, 129, 0.25);
    color: #34d399;
    font-size: 0.74rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #34d399;
    box-shadow: 0 0 6px rgba(52, 211, 153, 0.8);
  }

  .feedback-alert {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    font-size: 0.84rem;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .feedback-alert.success {
    background: rgba(16, 185, 129, 0.12);
    border: 1px solid rgba(16, 185, 129, 0.3);
    color: #34d399;
  }

  .feedback-alert.error {
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #f87171;
  }

  .settings-body-form {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    width: 100%;
  }

  .settings-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
    width: 100%;
  }

  @media (max-width: 960px) {
    .settings-grid {
      grid-template-columns: 1fr;
    }
  }

  .settings-col {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .config-card {
    background: var(--bg-secondary, #0f172a);
    border: 1px solid var(--border-color, #334155);
    border-radius: 10px;
    padding: 1.15rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .card-header-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .field-status {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.72rem;
    font-weight: 600;
    color: #34d399;
    white-space: nowrap;
  }

  .field-status.pending { color: #93c5fd; }
  .field-status.error { color: #f87171; }

  .field-status .spinner-mini {
    width: 10px;
    height: 10px;
    border-width: 1.5px;
    border-color: rgba(147, 197, 253, 0.3);
    border-top-color: #93c5fd;
  }

  .card-title, .card-header-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.92rem;
    font-weight: 600;
    color: var(--text-primary, #f8fafc);
  }

  .tool-count-pill {
    font-size: 0.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: var(--text-muted, #94a3b8);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .form-group label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-muted, #94a3b8);
  }

  .req { color: #f87171; }

  .input-field, .select-field, .textarea-field {
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
    border-radius: 6px;
    padding: 0.55rem 0.75rem;
    font-size: 0.88rem;
    color: var(--text-primary, #f8fafc);
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .input-field:focus, .select-field:focus, .textarea-field:focus {
    border-color: rgba(168, 85, 247, 0.5);
    box-shadow: 0 0 0 2px rgba(168, 85, 247, 0.15);
  }

  .textarea-field {
    resize: vertical;
    min-height: 320px;
    line-height: 1.55;
    font-family: var(--font-mono, monospace);
    font-size: 0.85rem;
  }

  .field-hint {
    font-size: 0.74rem;
    color: var(--text-muted, #94a3b8);
  }

  /* Bound preset editor */
  .preset-editor {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    padding: 0.85rem;
    border: 1px dashed var(--border-color, #334155);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.15);
  }

  .preset-editor-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .preset-editor-title {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--text-secondary, #cbd5e1);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .dirty-pill {
    font-size: 0.66rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.35);
    color: #fbbf24;
    letter-spacing: 0.04em;
  }

  .slider-field {
    accent-color: var(--accent-primary, #a855f7);
    cursor: pointer;
    margin-top: 0.25rem;
  }

  .val-pill {
    color: var(--accent-primary, #c084fc);
    font-family: var(--font-mono, monospace);
  }

  .preset-editor-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.15rem;
  }

  .btn-save-preset,
  .btn-duplicate-preset {
    padding: 0.45rem 0.75rem;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-save-preset {
    background: rgba(168, 85, 247, 0.18);
    border: 1px solid rgba(168, 85, 247, 0.45);
    color: #e9d5ff;
  }

  .btn-save-preset:hover:not(:disabled) {
    background: rgba(168, 85, 247, 0.3);
  }

  .btn-duplicate-preset {
    background: transparent;
    border: 1px solid var(--border-color, #334155);
    color: var(--text-secondary, #cbd5e1);
  }

  .btn-duplicate-preset:hover:not(:disabled) {
    border-color: rgba(168, 85, 247, 0.45);
    color: var(--text-primary, #f8fafc);
  }

  .btn-save-preset:disabled,
  .btn-duplicate-preset:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Privileged Box */
  .privileged-box {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.85rem;
    background: rgba(234, 179, 8, 0.04);
    border: 1px solid rgba(234, 179, 8, 0.15);
    border-radius: 6px;
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
  }

  .privileged-box:hover {
    background: rgba(234, 179, 8, 0.08);
    border-color: rgba(234, 179, 8, 0.3);
  }

  .privileged-box.active {
    background: rgba(234, 179, 8, 0.1);
    border-color: rgba(234, 179, 8, 0.4);
  }

  .checkbox-input {
    margin-top: 3px;
    accent-color: #eab308;
    cursor: pointer;
  }

  /* Wave U publishing authorities: visually distinct from the amber sudo box
     (purple publishing accent) so the dedicated grants never read as part of
     privilege. */
  .publishing-grants {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.85rem;
    border: 1px solid rgba(168, 85, 247, 0.35);
    border-radius: 8px;
    background: rgba(168, 85, 247, 0.05);
  }

  .publishing-grants-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .publishing-grants-title {
    font-size: 0.86rem;
    font-weight: 600;
    color: #c084fc;
  }

  .publishing-distinct {
    font-size: 0.62rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    border: 1px solid rgba(168, 85, 247, 0.4);
    background: rgba(168, 85, 247, 0.12);
    color: #c084fc;
  }

  .authority-toggle {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.7rem 0.85rem;
    border: 1px solid var(--border-color, #334155);
    border-radius: 6px;
    background: var(--bg-surface, #1e293b);
    cursor: pointer;
    user-select: none;
    transition: all 0.15s ease;
  }

  .authority-toggle:hover {
    border-color: rgba(168, 85, 247, 0.5);
  }

  .authority-toggle.active {
    background: rgba(168, 85, 247, 0.12);
    border-color: rgba(168, 85, 247, 0.55);
  }

  .authority-checkbox {
    accent-color: #a855f7;
  }

  .authority-id {
    font-size: 0.7rem;
    color: var(--text-muted, #94a3b8);
  }

  .authority-live-tag {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    border: 1px solid rgba(52, 211, 153, 0.35);
    background: rgba(52, 211, 153, 0.12);
    color: #34d399;
  }

  .policy-details {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .policy-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .policy-title {
    font-size: 0.86rem;
    font-weight: 600;
    color: var(--text-primary, #f8fafc);
  }

  .policy-desc {
    font-size: 0.75rem;
    color: var(--text-muted, #94a3b8);
    line-height: 1.4;
  }

  /* Tool Presets List */
  .tool-presets-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .preset-item-card {
    display: flex;
    align-items: flex-start;
    padding: 0.65rem 0.85rem;
    border-radius: 6px;
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
    text-align: left;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .preset-item-card:hover {
    border-color: rgba(168, 85, 247, 0.4);
    background: var(--bg-surface-elevated, #334155);
  }

  .preset-item-card.active {
    background: rgba(168, 85, 247, 0.12);
    border-color: rgba(168, 85, 247, 0.5);
  }

  .preset-item-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    width: 100%;
  }

  .preset-name-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .preset-item-name {
    font-size: 0.84rem;
    font-weight: 600;
    color: var(--text-primary, #f8fafc);
  }

  .selected-indicator {
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    background: #a855f7;
    color: #ffffff;
    font-weight: 700;
  }

  .preset-item-desc {
    font-size: 0.74rem;
    color: var(--text-muted, #94a3b8);
    line-height: 1.35;
  }

  .custom-tools-group {
    margin-top: 0.35rem;
  }

  .spinner-mini {
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #ffffff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
