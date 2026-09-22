<script>
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { renderMarkdownProse } from './markdown/index.ts';
  import { estimateTokens } from './estimateTokens.ts';

  function formatMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(part => {
        if (part === null || part === undefined) return '';
        if (typeof part === 'string') return part;
        if (typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
          if (Array.isArray(part.content)) return formatMessageContent(part.content);
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
          if (part.type === 'image_url' || part.image_url) {
            const url = part.image_url?.url || part.url || 'embedded';
            return `[Image: ${url}]`;
          }
          return JSON.stringify(part);
        }
        return String(part);
      }).filter(Boolean).join('\n\n');
    }
    if (typeof content === 'object') {
      if (typeof content.text === 'string') return content.text;
      if (typeof content.content === 'string') return content.content;
      return JSON.stringify(content, null, 2);
    }
    return String(content);
  }

  let { onEditAgent = () => {} } = $props();

  let promptInput = $state('');
  let isExecuting = $state(false);
  let localError = $state('');
  let isThinkingExpanded = $state(true);
  let showHistoryDetails = $state({});
  let inspectorTab = $state('trace'); // 'trace' | 'telemetry' | 'context'
  let copyStatusText = $state('');
  let copyContextTimer = null;

  let agent = $derived(sandboxStore.selectedAgent);

  let agentModelConfig = $derived.by(() => {
    const boundPresetId = typeof agent?.config?.presetId === 'string' ? agent.config.presetId.trim() : '';
    if (boundPresetId) {
      const boundPreset = sandboxStore.getPresetCatalog().getPreset(boundPresetId);
      if (boundPreset) return boundPreset.modelConfig;
    }
    return agent?.config?.modelConfig || sandboxStore.modelConfig;
  });

  let agentTimers = $derived.by(() => {
    if (!agent) return [];
    return sandboxStore.scheduledTimers.filter(t => t.targetAgentId === agent.id || t.agentId === agent.id);
  });

  let activeTimers = $derived.by(() => {
    return agentTimers.filter(t => t.status === 'pending');
  });

  let newTimerDuration = $state(10);
  let newTimerPrompt = $state('');
  let isSchedulingTimer = $state(false);
  let timerError = $state('');

  async function handleScheduleTimer(e) {
    if (e) e.preventDefault();
    if (!agent || !newTimerPrompt.trim()) return;
    timerError = '';
    isSchedulingTimer = true;
    try {
      await sandboxStore.scheduleTimer({
        agentId: agent.id,
        durationSeconds: Number(newTimerDuration) || 10,
        prompt: newTimerPrompt.trim(),
        timerCondition: 'never'
      });
      newTimerPrompt = '';
    } catch (err) {
      timerError = err.message || 'Failed to schedule timer';
    } finally {
      isSchedulingTimer = false;
    }
  }

  function handleCancelTimer(timerId) {
    sandboxStore.cancelScheduledTimer(timerId, 'Cancelled via Agent Inspector UI');
  }

  // World Clock & Narrative Events State
  let isResettingEvents = $state(false);
  let isResettingClock = $state(false);
  let eventsError = $state('');

  // The store keeps engine instances private, so the inspector reads the
  // reactive projections / typed store boundary instead of a worldClock property.
  let agentClock = $derived(sandboxStore.selectedAgentClock);

  let agentEventsQuery = $derived.by(() => {
    if (!agent) return { events: [], activeEvents: [], count: 0, activeCount: 0, pendingCount: 0 };
    const _ = sandboxStore.clockSnapshot; // re-query when narrative state syncs
    return sandboxStore.queryAgentEvents({ all: false }, agent.id);
  });

  let allEventsList = $derived(agentEventsQuery?.events || []);

  function handleResetEvents() {
    if (!agent) return;
    eventsError = '';
    isResettingEvents = true;
    try {
      sandboxStore.resetAgentEvents(agent.id);
    } catch (err) {
      eventsError = err.message || 'Failed to reset events';
    } finally {
      isResettingEvents = false;
    }
  }

  function handleResetClock() {
    if (!agent) return;
    eventsError = '';
    isResettingClock = true;
    try {
      sandboxStore.resetAgentClock(agent.id);
    } catch (err) {
      eventsError = err.message || 'Failed to reset world clock';
    } finally {
      isResettingClock = false;
    }
  }

  // Reactive draft input synchronization with SandboxStore per-agent map
  $effect(() => {
    if (agent?.id) {
      const draft = sandboxStore.getAgentDraft(agent.id);
      if (draft !== promptInput) {
        promptInput = draft;
      }
    } else {
      promptInput = '';
    }
  });

  function handlePromptInput(e) {
    promptInput = e.target.value;
    if (agent?.id) {
      sandboxStore.setAgentDraft(agent.id, e.target.value);
    }
  }

  async function handleExecuteTurn(e) {
    if (e) e.preventDefault();
    if (!agent) return;

    if (agent.state === 'running' || (typeof agent.state === 'string' && agent.state.startsWith('waiting'))) {
      return;
    }

    const input = promptInput.trim();
    localError = '';
    isExecuting = true;

    try {
      promptInput = '';
      sandboxStore.clearAgentDraft(agent.id);
      await sandboxStore.triggerTurn(agent.id, input || null);
    } catch (err) {
      localError = err.message || 'Turn execution failed';
    } finally {
      isExecuting = false;
    }
  }

  function handleUndoTurn() {
    if (!agent) return;
    localError = '';
    sandboxStore.undoAgentTurn(agent.id);
  }

  function handleRedoTurn() {
    if (!agent) return;
    localError = '';
    sandboxStore.redoAgentTurn(agent.id);
  }

  async function handleRetryTurn() {
    if (!agent) return;
    localError = '';
    isExecuting = true;
    try {
      await sandboxStore.retryAgentTurn(agent.id);
    } catch (err) {
      localError = err.message || 'Retry failed';
    } finally {
      isExecuting = false;
    }
  }

  function handleDismissError() {
    localError = '';
    if (agent) {
      if (typeof sandboxStore.clearAgentLastError === 'function') {
        sandboxStore.clearAgentLastError(agent.id);
      } else {
        agent.lastError = null;
        sandboxStore.syncAgents();
      }
    }
  }

  function handleCancelTurn() {
    if (!agent) return;
    sandboxStore.cancelAgent(agent.id);
  }

  function handleTerminateAgent() {
    if (!agent) return;
    const ok = confirm(`Terminate agent "${agent.name || agent.id}" and move to Recycle Bin?\n\nThe agent will be soft-killed and moved to the Recycle Bin. You can restore it later with full conversation history preserved.`);
    if (ok) {
      sandboxStore.killAgent(agent.id, 'Terminated by user via Inspector');
    }
  }

  function applyQuickPrompt(text) {
    promptInput = text;
    if (agent?.id) {
      sandboxStore.setAgentDraft(agent.id, text);
    }
  }

  function toggleHistoryDetails(index) {
    showHistoryDetails = {
      ...showHistoryDetails,
      [index]: !showHistoryDetails[index]
    };
  }

  function formatJson(data) {
    if (typeof data === 'string') {
      try {
        return JSON.stringify(JSON.parse(data), null, 2);
      } catch (_) {
        return data;
      }
    }
    try {
      return JSON.stringify(data, null, 2);
    } catch (_) {
      return String(data);
    }
  }

  let agentTelemetry = $derived(agent?.telemetry || {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    turnCount: 0,
    lastPromptTokens: 0,
    lastCompletionTokens: 0,
    lastSentContext: []
  });

  let displayedContextMessages = $derived.by(() => {
    if (!agent) return [];
    if (agent.telemetry?.lastSentContext && agent.telemetry.lastSentContext.length > 0) {
      return agent.telemetry.lastSentContext;
    }
    return agent.history || [];
  });

  let estimatedContextTokens = $derived.by(() => {
    return displayedContextMessages.reduce((sum, msg) => {
      const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      return sum + estimateTokens(contentStr);
    }, 0);
  });

  function handleClearTelemetry() {
    if (!agent) return;
    sandboxStore.clearAgentTelemetry(agent.id);
  }

  function handleCopyContextJson() {
    if (!agent) return;
    const jsonStr = JSON.stringify(displayedContextMessages, null, 2);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(jsonStr).then(() => {
        copyStatusText = 'Copied!';
        if (copyContextTimer) clearTimeout(copyContextTimer);
        copyContextTimer = setTimeout(() => {
          copyStatusText = '';
        }, 2000);
      }).catch(() => {
        copyStatusText = 'Failed';
      });
    }
  }

  function formatAllowedTools(tools) {
    if (!tools || tools === '*' || (Array.isArray(tools) && tools.includes('*'))) {
      return 'All Tools (*)';
    }
    if (Array.isArray(tools)) {
      return tools.join(', ');
    }
    return String(tools);
  }

  function formatAllowedToolsSummary(tools) {
    if (!tools || tools === '*' || (Array.isArray(tools) && tools.includes('*'))) {
      return 'All (*)';
    }
    if (Array.isArray(tools)) {
      if (tools.length <= 2) return tools.join(', ');
      return `${tools.length} tools`;
    }
    return String(tools);
  }
</script>

<div class="inspector-container">
  {#if sandboxStore.hydrationNotice}
    <div class="hydration-notice-banner glass-panel" role="alert">
      <div class="hydration-notice-left">
        <svg class="icon-svg hydration-notice-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <div class="hydration-notice-copy">
          <span class="hydration-notice-title">Session Recovery</span>
          <span class="hydration-notice-message">{sandboxStore.hydrationNotice.message}</span>
        </div>
      </div>
      <button
        type="button"
        class="btn-icon-dismiss"
        title="Dismiss recovery notice"
        onclick={() => sandboxStore.dismissHydrationNotice()}
      >
        <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  {/if}

  {#if !agent}
    <div class="empty-inspector glass-panel">
      <div class="empty-icon">
        <svg class="icon-svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </div>
      <h3>No Agent Selected</h3>
      <p>Select an active agent from the sidebar drawer or provision a new agent using "+ Launch Agent".</p>
    </div>
  {:else}
    <!-- Agent Header & Metadata -->
    <header class="inspector-header glass-panel">
      <div class="header-top">
        <div class="agent-title-block">
          <div class="title-row">
            <h2 class="agent-name">{agent.name}</h2>
            <span class="agent-id-pill font-mono">{agent.id}</span>
            {#if agent.config?.privileged}
              <span class="sudo-badge font-mono" title="Universal administrative access (VirtualFS cross-workspace, termination authority)">⚡ SUDO</span>
            {/if}
          </div>
          {#if agent.config.role}
            <p class="agent-role">{agent.config.role}</p>
          {/if}
        </div>

        <div class="header-meta-and-actions">
          <div class="header-meta-chips">
            <div class="meta-chip">
              <span class="chip-label">Authority</span>
              <span class="chip-value font-mono {agent.config?.privileged ? 'auth-sudo' : ''}">
                {agent.config?.privileged ? '⚡ Sudo' : 'Standard'}
              </span>
            </div>
            <div class="meta-chip" title={formatAllowedTools(agent.config?.allowedTools)}>
              <span class="chip-label">Tools</span>
              <span class="chip-value font-mono">
                {formatAllowedToolsSummary(agent.config?.allowedTools)}
              </span>
            </div>
            <div class="meta-chip">
              <span class="chip-label">Model</span>
              <span class="chip-value font-mono">{agentModelConfig?.modelId}</span>
            </div>
            <div class="meta-chip">
              <span class="chip-label">Thinking</span>
              <span class="chip-value font-mono">{agentModelConfig?.reasoningEffort || 'high'}</span>
            </div>
            <div class="meta-chip">
              <span class="chip-label">Provider</span>
              <span class="chip-value font-mono">{agentModelConfig?.providerId || 'auto'}{agentModelConfig?.routing ? ` (${agentModelConfig.routing})` : ''}</span>
            </div>
            <div class="meta-chip">
              <span class="chip-label">Turns</span>
              <span class="chip-value font-mono">{agent.turnCount}</span>
            </div>
            <div class="meta-chip" class:has-unread={(agent.unreadCount || 0) > 0}>
              <span class="chip-label">Mailbox</span>
              <span class="chip-value font-mono">
                {#if (agent.unreadCount || 0) > 0}
                  <span class="unread-pill">✉ {agent.unreadCount} unread</span>
                {:else}
                  0 unread
                {/if}
              </span>
            </div>
            <button
              type="button"
              class="meta-chip meta-chip-clickable"
              onclick={() => inspectorTab = 'telemetry'}
              title="Click to view token telemetry & consumption breakdown"
            >
              <span class="chip-label">Tokens</span>
              <span class="chip-value font-mono">
                <span class="token-in font-mono" title="Input Tokens">↓{agentTelemetry.inputTokens.toLocaleString()}</span>
                <span class="token-sep">/</span>
                <span class="token-out font-mono" title="Output Tokens">↑{agentTelemetry.outputTokens.toLocaleString()}</span>
              </span>
            </button>
            <div class="meta-chip">
              <span class="chip-label">Temp</span>
              <span class="chip-value font-mono">{agent.config.temperature}</span>
            </div>
            <div class="meta-chip" title="Max tool calls per execution turn">
              <span class="chip-label">Max Calls</span>
              <span class="chip-value font-mono">{agent.config.maxTurns ?? 100000}</span>
            </div>
          </div>

          <div class="header-action-buttons">
            <button
              type="button"
              class="btn-edit-agent"
              onclick={() => onEditAgent()}
              title="Edit Agent Character, Directives & Permissions"
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
              <span>Edit Agent</span>
            </button>

            <button
              type="button"
              class="btn-terminate-agent"
              onclick={handleTerminateAgent}
              title="Soft-kill agent and move to Recycle Bin"
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
              <span>Terminate Agent</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Lifecycle State Banner -->
      <div class="state-banner state-{agent.state}">
        <div class="state-indicator">
          {#if agent.state === 'running'}
            <span class="pulse-dot"></span>
          {:else if agent.state === 'errored'}
            <span class="error-dot"></span>
          {:else}
            <span class="idle-dot"></span>
          {/if}
          <span class="state-label font-mono uppercase">{agent.state.replace(/_/g, ' ')}</span>
        </div>
        {#if agent.stateDetail}
          <span class="state-detail">{agent.stateDetail}</span>
        {/if}
      </div>

      {#if agent.lastError || localError}
        <div class="error-banner glass-panel" role="alert">
          <div class="error-banner-top">
            <div class="error-header">
              <svg class="icon-svg error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span class="error-title">Execution Error Encountered</span>
            </div>
            <button type="button" class="btn-icon-dismiss" title="Dismiss error" onclick={handleDismissError}>
              <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <p class="error-message">{agent.lastError || localError}</p>
          <div class="error-actions">
            <button type="button" class="btn-retry btn-sm" onclick={handleRetryTurn}>
              <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="1 4 1 10 7 10" /><polyline points="23 20 23 14 17 14" />
                <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15" />
              </svg>
              <span>Retry Turn</span>
            </button>
            <button type="button" class="btn-undo-prompt btn-sm" onclick={handleUndoTurn}>
              <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7v6h6" /><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
              </svg>
              <span>Undo Turn & Edit Prompt</span>
            </button>
            <button type="button" class="btn-dismiss btn-sm" onclick={handleDismissError}>
              Dismiss
            </button>
          </div>
        </div>
      {/if}
    </header>

    <!-- Tab Navigation Bar -->
    <nav class="inspector-tabs-nav">
      <button
        type="button"
        class="inspector-tab-btn"
        class:active={inspectorTab === 'trace'}
        onclick={() => inspectorTab = 'trace'}
      >
        <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
        </svg>
        <span>Trace & Interaction</span>
      </button>

      <button
        type="button"
        class="inspector-tab-btn"
        class:active={inspectorTab === 'telemetry'}
        onclick={() => inspectorTab = 'telemetry'}
      >
        <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="20" x2="18" y2="10"></line>
          <line x1="12" y1="20" x2="12" y2="4"></line>
          <line x1="6" y1="20" x2="6" y2="14"></line>
        </svg>
        <span>Telemetry & Tokens</span>
        {#if agentTelemetry.totalTokens > 0}
          <span class="tab-badge font-mono">{agentTelemetry.totalTokens.toLocaleString()}</span>
        {/if}
      </button>

      <button
        type="button"
        class="inspector-tab-btn"
        class:active={inspectorTab === 'context'}
        onclick={() => inspectorTab = 'context'}
      >
        <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        <span>Sent Context (Debug)</span>
        {#if displayedContextMessages.length > 0}
          <span class="tab-badge font-mono">{displayedContextMessages.length}</span>
        {/if}
      </button>
    </nav>

    <div class="inspector-body">
      {#if inspectorTab === 'trace'}
        <!-- Live Streaming Section (When Running) -->
        {#if agent.state === 'running' || agent.currentStream}
        <section class="live-stream-card glass-panel">
          <div class="card-header">
            <div class="card-title">
              <span class="pulse-dot"></span>
              <span>Live Streaming Prose</span>
            </div>
            <span class="token-count font-mono">{agent.currentStream.length} chars</span>
          </div>
          <div class="stream-content">
            {@html renderMarkdownProse(agent.currentStream || 'Awaiting completion tokens...')}
            {#if agent.state === 'running'}
              <span class="typing-cursor"></span>
            {/if}
          </div>
        </section>
      {/if}

      <!-- Reasoning / Thinking Tokens Collapsible -->
      {#if agent.currentReasoning}
        <div class="thinking-container glass-panel" class:expanded={isThinkingExpanded}>
          <button
            type="button"
            class="thinking-header"
            onclick={() => isThinkingExpanded = !isThinkingExpanded}
            title="Toggle thinking process"
          >
            <div class="thinking-header-left">
              <span class="thinking-icon-wrap">
                <svg class="thinking-spark-svg animating" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/>
                </svg>
              </span>
              <span class="thinking-title">Reasoning / Thinking Tokens</span>
            </div>
            <div class="thinking-header-right">
              <span class="thinking-toggle-label">{isThinkingExpanded ? 'Hide' : 'Show'}</span>
              <span class="thinking-chevron" class:rotated={isThinkingExpanded}>▾</span>
            </div>
          </button>

          {#if isThinkingExpanded}
            <div class="thinking-content-body">
              <div class="thinking-prose-stream font-mono">
                {agent.currentReasoning}
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- Active Tool Calls -->
      {#if agent.activeToolCalls && agent.activeToolCalls.length > 0}
        <section class="active-tools-card glass-panel">
          <div class="card-header">
            <div class="card-title">
              <span class="tool-dot"></span>
              <span>Active Tool Invocations ({agent.activeToolCalls.length})</span>
            </div>
          </div>
          <div class="tools-list">
            {#each agent.activeToolCalls as tc (tc.id || tc.function?.name)}
              <div class="tool-call-badge">
                <div class="tool-name font-mono">{tc.function?.name || tc.name}</div>
                <pre class="tool-args font-mono">{formatJson(tc.function?.arguments || tc.arguments)}</pre>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Scheduled Deferred Timers Section -->
      <section class="scheduled-timers-card glass-panel">
        <div class="card-header">
          <div class="card-title">
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            <span>Scheduled Deferred Timers</span>
            {#if activeTimers.length > 0}
              <span class="pulse-dot"></span>
              <span class="active-timer-badge font-mono">{activeTimers.length} active</span>
            {/if}
          </div>
        </div>

        {#if agentTimers.length === 0}
          <div class="empty-timers-notice">
            <span>No scheduled timers for this agent.</span>
          </div>
        {:else}
          <div class="timers-list">
            {#each agentTimers as timer (timer.timerId)}
              <div class="timer-item" class:pending={timer.status === 'pending'} class:cancelled={timer.status === 'cancelled'} class:triggered={timer.status === 'triggered'}>
                <div class="timer-main">
                  <div class="timer-top-line">
                    <span class="timer-id-pill font-mono">{timer.timerId}</span>
                    <span class="timer-status-badge font-mono status-{timer.status}">
                      {timer.status.toUpperCase()}
                    </span>
                    {#if timer.status === 'pending'}
                      <span class="countdown-badge font-mono">
                        ⏳ {timer.remainingSeconds}s remaining
                      </span>
                    {/if}
                  </div>
                  <p class="timer-prompt font-mono">"{timer.prompt}"</p>
                  <div class="timer-meta-info font-mono">
                    <span>Duration: {timer.durationSeconds}s</span>
                    <span>Condition: {timer.timerCondition || 'never'}</span>
                  </div>
                </div>

                {#if timer.status === 'pending'}
                  <button
                    type="button"
                    class="btn-cancel-timer font-mono"
                    onclick={() => handleCancelTimer(timer.timerId)}
                    title="Cancel scheduled timer"
                  >
                    Cancel Timer
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        <!-- Quick Schedule Form -->
        <form onsubmit={handleScheduleTimer} class="schedule-form">
          <div class="schedule-inputs-row">
            <div class="duration-input-wrap">
              <label for="timer-dur-input" class="input-mini-label">Delay(s):</label>
              <input
                id="timer-dur-input"
                type="number"
                min="1"
                max="3600"
                bind:value={newTimerDuration}
                class="duration-input font-mono"
              />
            </div>
            <input
              type="text"
              bind:value={newTimerPrompt}
              placeholder="Reminder prompt on expiry (e.g. 'Check inbox')..."
              class="timer-prompt-input"
            />
            <button
              type="submit"
              class="btn-primary btn-sm"
              disabled={isSchedulingTimer || !newTimerPrompt.trim()}
            >
              + Schedule
            </button>
          </div>
          {#if timerError}
            <span class="timer-error-msg">{timerError}</span>
          {/if}
        </form>
      </section>

      <!-- Agent Narrative Time & Events Section -->
      <section class="narrative-clock-card glass-panel">
        <div class="card-header">
          <div class="card-title">
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>Agent Narrative Time & Events</span>
            {#if agentClock}
              <span class="clock-time-pill font-mono">{agentClock.formattedTime || '00:00:00'} (Day {agentClock.day ?? 1})</span>
            {/if}
            {#if (agentEventsQuery?.activeCount || 0) > 0}
              <span class="active-events-badge font-mono">{agentEventsQuery.activeCount} active</span>
            {/if}
          </div>

          <div class="clock-header-actions">
            <button
              type="button"
              class="btn-reset-events font-mono"
              onclick={handleResetEvents}
              disabled={isResettingEvents}
              title="Reset and clear all world events for this agent"
            >
              <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
              <span>Reset Events</span>
            </button>

            <button
              type="button"
              class="btn-reset-clock font-mono"
              onclick={handleResetClock}
              disabled={isResettingClock}
              title="Reset world clock to 00:00:00 Day 1"
            >
              <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
              </svg>
              <span>Reset Clock</span>
            </button>
          </div>
        </div>

        {#if agentClock}
          <div class="clock-stats-strip font-mono">
            <div class="stat-item">
              <span class="stat-label">Time:</span>
              <span class="stat-val">{agentClock.formattedTime}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Date:</span>
              <span class="stat-val">Day {agentClock.day ?? 1}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Elapsed:</span>
              <span class="stat-val">{agentClock.totalSeconds}s ({Math.floor(agentClock.totalSeconds / 60)}m)</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Events:</span>
              <span class="stat-val">{allEventsList.length} total ({agentEventsQuery.activeCount || 0} active, {agentEventsQuery.pendingCount || 0} pending)</span>
            </div>
          </div>
        {/if}

        {#if eventsError}
          <div class="clock-error-msg">{eventsError}</div>
        {/if}

        {#if allEventsList.length === 0}
          <div class="empty-events-notice">
            <span>No simulation narrative events registered for this agent.</span>
          </div>
        {:else}
          <div class="narrative-events-list">
            {#each allEventsList as ev (ev.id)}
              <div class="narrative-event-item status-{ev.status}">
                <div class="event-main-line">
                  <span class="event-id-pill font-mono">{ev.id}</span>
                  <span class="event-name">{ev.name}</span>
                  <span class="event-status-pill font-mono status-{ev.status}">{ev.status.toUpperCase()}</span>
                  <span class="event-time-pill font-mono">Trigger: {ev.triggerFormatted || ev.triggerTime}s</span>
                  {#if ev.priority && ev.priority !== 'normal'}
                    <span class="event-priority-pill font-mono priority-{ev.priority}">{ev.priority}</span>
                  {/if}
                </div>
                {#if ev.description && ev.description !== ev.name}
                  <p class="event-desc">{ev.description}</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- Manual Execution Drawer -->
      <section class="turn-control-card glass-panel">
        <form onsubmit={handleExecuteTurn}>
          <div class="card-header">
            <label for="turn-prompt-input" class="card-title">
              <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              <span>Execute Manual Turn</span>
            </label>
            <div class="turn-actions">
              <button
                type="button"
                class="btn-secondary btn-sm btn-undo"
                title="Undo last turn and restore prompt to draft"
                disabled={!(agent.history?.length > 0 || agent.turnCount > 0) || isExecuting}
                onclick={handleUndoTurn}
              >
                <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 7v6h6" /><path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13" />
                </svg>
                <span>Undo</span>
              </button>

              <button
                type="button"
                class="btn-secondary btn-sm btn-redo"
                title="Redo undone turn"
                disabled={!(agent.redoStack?.length > 0) || isExecuting || agent.state === 'running'}
                onclick={handleRedoTurn}
              >
                <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 7v6h-6" /><path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7" />
                </svg>
                <span>Redo{#if agent.redoStack?.length > 0} ({agent.redoStack.length}){/if}</span>
              </button>

              {#if agent.state === 'running'}
                <button type="button" class="btn-danger btn-sm" onclick={handleCancelTurn}>
                  Cancel Turn
                </button>
              {:else}
                <button type="submit" class="btn-primary btn-sm" disabled={isExecuting}>
                  Execute Turn
                </button>
              {/if}
            </div>
          </div>

          <textarea
            id="turn-prompt-input"
            value={promptInput}
            oninput={handlePromptInput}
            rows="2"
            placeholder="Type instructions or leave blank to process mailbox queue..."
            class="turn-textarea"
          ></textarea>

          <div class="quick-prompts">
            <span class="quick-label">Quick Suggestions:</span>
            <button type="button" class="chip-btn" onclick={() => applyQuickPrompt('Inspect environment and list all files in workspace')}>
              List Files
            </button>
            <button type="button" class="chip-btn" onclick={() => applyQuickPrompt('Check mailbox inbox and process pending orders')}>
              Check Inbox
            </button>
            <button type="button" class="chip-btn" onclick={() => applyQuickPrompt('Write status update to /status.json in global workspace')}>
              Post Status
            </button>
          </div>
        </form>
      </section>

      <!-- Chronological History Timeline -->
      <section class="history-timeline-section">
        <h3 class="timeline-heading">
          <span>Conversation & Tool Trace</span>
          <span class="badge-count font-mono">{agent.history.length} entries</span>
        </h3>

        <div class="timeline-feed">
          {#each agent.history as item, idx (idx)}
            <div class="history-item role-{item.role}">
              <div class="item-header">
                <span class="role-pill font-mono">{item.role}</span>
                {#if item.name}
                  <span class="tool-name-pill font-mono">{item.name}</span>
                {/if}
                {#if item.tool_call_id}
                  <span class="tool-id-pill font-mono">id: {item.tool_call_id.slice(0, 8)}</span>
                {/if}
                <button
                  type="button"
                  class="btn-toggle-raw font-mono"
                  onclick={() => toggleHistoryDetails(idx)}
                >
                  {showHistoryDetails[idx] ? 'Hide Raw' : 'Raw JSON'}
                </button>
              </div>

              {#if item.reasoning_content}
                <details class="item-reasoning">
                  <summary class="font-mono">Thinking Trace</summary>
                  <pre class="font-mono">{item.reasoning_content}</pre>
                </details>
              {/if}

              {#if item.content}
                <div class="item-content {item.role === 'tool' ? 'font-mono' : ''}">
                  {#if showHistoryDetails[idx]}
                    <pre class="font-mono">{formatJson(item.content)}</pre>
                  {:else if item.role === 'assistant'}
                    {@html renderMarkdownProse(formatMessageContent(item.content))}
                  {:else if item.role === 'tool'}
                    <pre class="font-mono">{formatJson(item.content)}</pre>
                  {:else}
                    {formatMessageContent(item.content)}
                  {/if}
                </div>
              {/if}

              {#if item.tool_calls && item.tool_calls.length > 0}
                <div class="item-tool-calls">
                  <span class="tc-label">Tool Calls Emitted:</span>
                  {#each item.tool_calls as tc}
                    <div class="tool-call-block font-mono">
                      <strong>{tc.function?.name || tc.name}</strong>
                      <pre>{formatJson(tc.function?.arguments || tc.arguments)}</pre>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
      {:else if inspectorTab === 'telemetry'}
        <div class="telemetry-tab-container">
          <div class="telemetry-header-bar glass-panel">
            <div class="telemetry-summary-titles">
              <h3 class="telemetry-title">Agent Token Consumption</h3>
              <p class="telemetry-sub">Local telemetry tracking cumulative input (prompt) and output (completion/reasoning) tokens for this agent instance.</p>
            </div>
            <div class="telemetry-header-actions">
              <button
                type="button"
                class="btn-clear-telemetry font-mono"
                onclick={handleClearTelemetry}
                title="Reset cumulative token counters for this agent"
              >
                <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="1 4 1 10 7 10"></polyline>
                  <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path>
                </svg>
                <span>Clear Telemetry</span>
              </button>
            </div>
          </div>

          <div class="metrics-grid">
            <div class="metric-card glass-panel metric-total">
              <div class="metric-icon total-icon">
                <svg class="icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M12 6v12M6 12h12"></path>
                </svg>
              </div>
              <div class="metric-info">
                <span class="metric-label">Total Tokens</span>
                <span class="metric-value font-mono">{agentTelemetry.totalTokens.toLocaleString()}</span>
                <span class="metric-sub font-mono">Input + Output Combined</span>
              </div>
            </div>

            <div class="metric-card glass-panel metric-input">
              <div class="metric-icon input-icon">
                <svg class="icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="15 3 21 3 21 9"></polyline>
                  <polyline points="9 21 3 21 3 15"></polyline>
                  <line x1="21" y1="3" x2="14" y2="10"></line>
                  <line x1="3" y1="21" x2="10" y2="14"></line>
                </svg>
              </div>
              <div class="metric-info">
                <span class="metric-label">Input Tokens (Prompt)</span>
                <span class="metric-value font-mono">{agentTelemetry.inputTokens.toLocaleString()}</span>
                <span class="metric-sub font-mono">
                  {#if agentTelemetry.totalTokens > 0}
                    {Math.round((agentTelemetry.inputTokens / agentTelemetry.totalTokens) * 100)}% of total
                  {:else}
                    0% of total
                  {/if}
                </span>
              </div>
            </div>

            <div class="metric-card glass-panel metric-output">
              <div class="metric-icon output-icon">
                <svg class="icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                </svg>
              </div>
              <div class="metric-info">
                <span class="metric-label">Output Tokens (Completion / Reasoning)</span>
                <span class="metric-value font-mono">{agentTelemetry.outputTokens.toLocaleString()}</span>
                <span class="metric-sub font-mono">
                  {#if agentTelemetry.totalTokens > 0}
                    {Math.round((agentTelemetry.outputTokens / agentTelemetry.totalTokens) * 100)}% of total
                  {:else}
                    0% of total
                  {/if}
                </span>
              </div>
            </div>

            <div class="metric-card glass-panel metric-turns">
              <div class="metric-icon turns-icon">
                <svg class="icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <polyline points="1 20 1 14 7 14"></polyline>
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                </svg>
              </div>
              <div class="metric-info">
                <span class="metric-label">LLM Invocations / Turns</span>
                <span class="metric-value font-mono">{agentTelemetry.turnCount.toLocaleString()}</span>
                <span class="metric-sub font-mono">
                  {#if agentTelemetry.turnCount > 0}
                    ~{Math.round(agentTelemetry.totalTokens / agentTelemetry.turnCount).toLocaleString()} tokens/turn avg
                  {:else}
                    No recorded turns
                  {/if}
                </span>
              </div>
            </div>
          </div>

          <div class="last-turn-card glass-panel">
            <div class="card-header">
              <div class="card-title">
                <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 14 14"></polyline>
                </svg>
                <span>Most Recent Turn Consumption</span>
              </div>
            </div>
            <div class="last-turn-stats font-mono">
              <div class="stat-pill">
                <span class="stat-k">Last Prompt:</span>
                <span class="stat-v">{agentTelemetry.lastPromptTokens.toLocaleString()} tokens</span>
              </div>
              <div class="stat-pill">
                <span class="stat-k">Last Completion:</span>
                <span class="stat-v">{agentTelemetry.lastCompletionTokens.toLocaleString()} tokens</span>
              </div>
              <div class="stat-pill highlight">
                <span class="stat-k">Last Turn Total:</span>
                <span class="stat-v">{(agentTelemetry.lastPromptTokens + agentTelemetry.lastCompletionTokens).toLocaleString()} tokens</span>
              </div>
            </div>
          </div>
        </div>
      {:else if inspectorTab === 'context'}
        <div class="context-debug-container">
          <div class="context-debug-header glass-panel">
            <div class="debug-titles">
              <h3 class="debug-title">Sent Context Payload (Model Prompt Array)</h3>
              <p class="debug-sub">
                The exact formatted message context array sent to the model API on the most recent execution turn.
              </p>
            </div>
            <div class="debug-actions">
              <button
                type="button"
                class="btn-copy-context font-mono"
                onclick={handleCopyContextJson}
                title="Copy raw JSON of sent context array to clipboard"
              >
                <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
                <span>{copyStatusText || 'Copy JSON'}</span>
              </button>
            </div>
          </div>

          {#if displayedContextMessages.length === 0}
            <div class="empty-context-notice glass-panel">
              <p>No model turn context has been captured yet. Execute a turn or send a prompt to inspect the sent payload.</p>
            </div>
          {:else}
            <div class="context-meta-bar font-mono glass-panel">
              <span>{displayedContextMessages.length} Messages in Sent Context</span>
              <span>~{estimatedContextTokens.toLocaleString()} Estimated Prompt Tokens</span>
            </div>

            <div class="context-messages-list">
              {#each displayedContextMessages as msg, idx (idx)}
                <div class="context-msg-item role-{msg.role} glass-panel">
                  <div class="context-msg-header">
                    <span class="msg-index font-mono">#{idx + 1}</span>
                    <span class="msg-role font-mono role-pill role-{msg.role}">{msg.role}</span>
                    {#if msg.name}
                      <span class="msg-name font-mono">{msg.name}</span>
                    {/if}
                    {#if msg.tool_call_id}
                      <span class="msg-tool-id font-mono">id: {msg.tool_call_id}</span>
                    {/if}
                    <span class="msg-token-est font-mono">~{estimateTokens(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')).toLocaleString()} tokens</span>
                  </div>

                  {#if msg.content}
                    <pre class="msg-content font-mono">{typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}</pre>
                  {/if}

                  {#if msg.tool_calls && msg.tool_calls.length > 0}
                    <div class="msg-tool-calls">
                      <span class="tc-heading font-mono">Tool Calls:</span>
                      {#each msg.tool_calls as tc}
                        <pre class="tc-block font-mono">{JSON.stringify(tc, null, 2)}</pre>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .inspector-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
    padding: 1.25rem;
    gap: 1.25rem;
  }

  .empty-inspector {
    margin: 4rem auto;
    max-width: 480px;
    padding: 3rem 2rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    border-radius: 12px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
  }

  .empty-icon {
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  .empty-inspector h3 {
    font-size: 1.2rem;
    color: var(--text-primary);
  }

  .empty-inspector p {
    font-size: 0.88rem;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .inspector-header {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .header-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 1rem;
  }

  .agent-title-block {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .title-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .agent-name {
    font-size: 1.3rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }

  .agent-id-pill {
    font-size: 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .sudo-badge {
    font-size: 0.68rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.18);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.45);
    font-weight: 700;
    letter-spacing: 0.04em;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  .agent-role {
    font-size: 0.85rem;
    color: var(--text-secondary);
    margin: 0;
  }

  .header-meta-and-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .header-meta-chips {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .header-action-buttons {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .btn-edit-agent {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 0.45rem 0.75rem;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
    align-self: center;
  }

  .btn-edit-agent:hover {
    background: var(--bg-secondary);
    border-color: var(--accent-primary);
    color: var(--accent-primary);
    transform: translateY(-1px);
  }

  .btn-terminate-agent {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #f87171;
    padding: 0.45rem 0.75rem;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
    align-self: center;
  }

  .btn-terminate-agent:hover {
    background: rgba(239, 68, 68, 0.22);
    border-color: rgba(239, 68, 68, 0.6);
    color: #fca5a5;
    transform: translateY(-1px);
  }

  .meta-chip {
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
    min-width: 65px;
  }

  .chip-label {
    font-size: 0.65rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .chip-value {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .chip-value.auth-sudo {
    color: #f59e0b;
    font-weight: 700;
  }

  .state-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.85rem;
    border-radius: 6px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
  }

  .state-indicator {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .pulse-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-warning);
    box-shadow: 0 0 8px var(--accent-warning);
    animation: pulse 1.2s infinite;
  }

  .error-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-danger);
  }

  .idle-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-success);
  }

  .tool-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-cyan);
  }

  .state-label {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .state-running .state-label { color: var(--accent-warning); }
  .state-idle .state-label { color: var(--accent-success); }
  .state-errored .state-label { color: var(--accent-danger); }

  .state-detail {
    font-size: 0.8rem;
    color: var(--text-secondary);
    font-style: italic;
  }

  .hydration-notice-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    padding: 0.7rem 0.9rem;
    background: rgba(245, 158, 11, 0.1);
    border: 1px solid rgba(245, 158, 11, 0.35);
    border-radius: 8px;
    backdrop-filter: blur(8px);
    animation: fadeIn 0.2s ease;
  }

  .hydration-notice-left {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    min-width: 0;
  }

  .hydration-notice-icon {
    color: #fbbf24;
    flex-shrink: 0;
  }

  .hydration-notice-copy {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .hydration-notice-title {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #fbbf24;
  }

  .hydration-notice-message {
    font-size: 0.82rem;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .error-banner {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.85rem 1rem;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
    border-radius: 8px;
    backdrop-filter: blur(8px);
  }

  .error-banner-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .error-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .error-icon {
    color: #f87171;
    flex-shrink: 0;
  }

  .error-title {
    font-size: 0.85rem;
    font-weight: 600;
    color: #f87171;
  }

  .btn-icon-dismiss {
    background: transparent;
    border: none;
    color: var(--text-muted, #94a3b8);
    cursor: pointer;
    padding: 2px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s, background 0.15s;
  }

  .btn-icon-dismiss:hover {
    color: #f87171;
    background: rgba(239, 68, 68, 0.15);
  }

  .error-message {
    margin: 0;
    font-size: 0.82rem;
    line-height: 1.5;
    color: #fca5a5;
    font-family: var(--font-mono, monospace);
    word-break: break-word;
  }

  .error-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.25rem;
  }

  .btn-retry {
    background: rgba(239, 68, 68, 0.25);
    border: 1px solid rgba(239, 68, 68, 0.5);
    color: #fef2f2;
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-size: 0.75rem;
    font-weight: 500;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: all 0.15s;
  }

  .btn-retry:hover {
    background: rgba(239, 68, 68, 0.4);
    border-color: #ef4444;
  }

  .btn-undo-prompt {
    background: var(--bg-surface, #1e293b);
    border: 1px solid var(--border-color, #334155);
    color: var(--text-primary, #f8fafc);
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-size: 0.75rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    transition: all 0.15s;
  }

  .btn-undo-prompt:hover {
    background: var(--bg-surface-elevated, #334155);
    border-color: var(--border-hover, #475569);
  }

  .btn-dismiss {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--text-muted, #94a3b8);
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-dismiss:hover {
    color: var(--text-primary, #f8fafc);
    background: rgba(255, 255, 255, 0.05);
  }

  .turn-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .btn-undo, .btn-redo {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .error-alert {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.85rem;
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    border-radius: 6px;
    color: #f87171;
    font-size: 0.85rem;
  }

  .inspector-body {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .live-stream-card, .turn-control-card, .active-tools-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .card-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .stream-content {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.85rem;
    font-size: 0.95rem;
    line-height: 1.6;
    color: var(--text-primary);
    min-height: 60px;
  }

  .typing-cursor {
    display: inline-block;
    width: 6px;
    height: 1.1em;
    background: var(--accent-primary, #d4af37);
    vertical-align: text-bottom;
    margin-left: 2px;
    animation: blink 0.8s infinite;
  }

  /* Thinking Box (Claude-Style Accordion) */
  .thinking-container {
    border-radius: 8px;
    background: rgba(18, 24, 41, 0.65);
    border: 1px solid rgba(212, 175, 55, 0.2);
    overflow: hidden;
    transition: all 0.2s ease;
  }

  .thinking-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.45rem 0.85rem;
    background: transparent;
    border: none;
    cursor: pointer;
    color: var(--text-secondary, #94a3b8);
    font-size: 0.78rem;
    font-family: var(--font-main, sans-serif);
    text-align: left;
  }

  .thinking-header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .thinking-icon-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent-primary, #d4af37);
  }

  .thinking-spark-svg {
    opacity: 0.85;
  }

  .thinking-spark-svg.animating {
    animation: thinking-shimmer 2.5s ease-in-out infinite;
  }

  @keyframes thinking-shimmer {
    0%, 100% { opacity: 0.6; transform: rotate(0deg); }
    50% { opacity: 1; transform: rotate(180deg); }
  }

  .thinking-title {
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--accent-primary, #d4af37);
  }

  .thinking-header-right {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.72rem;
    color: var(--text-muted, #64748b);
  }

  .thinking-chevron {
    display: inline-block;
    font-size: 0.75rem;
    transition: transform 0.2s ease;
  }

  .thinking-chevron.rotated {
    transform: rotate(180deg);
  }

  .thinking-content-body {
    padding: 0.75rem 0.95rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    background: rgba(8, 12, 22, 0.75);
    max-height: 380px;
    overflow-y: auto;
  }

  .thinking-prose-stream {
    font-family: var(--font-mono, monospace);
    font-size: 0.8rem;
    line-height: 1.6;
    color: var(--text-muted, #94a3b8);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .tools-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .tool-call-badge {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0.6rem;
  }

  .tool-name {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--accent-cyan);
    margin-bottom: 0.35rem;
  }

  .tool-args {
    font-size: 0.75rem;
    color: var(--text-secondary);
    background: var(--bg-base);
    padding: 0.4rem;
    border-radius: 4px;
    overflow-x: auto;
  }

  .turn-textarea {
    width: 100%;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 0.6rem 0.75rem;
    font-size: 0.88rem;
    font-family: inherit;
    resize: vertical;
    margin: 0.5rem 0;
  }

  .turn-textarea:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .quick-prompts {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .quick-label {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .chip-btn {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.72rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .chip-btn:hover {
    color: var(--text-primary);
    border-color: var(--border-hover);
    background: var(--bg-surface-elevated);
  }

  .timeline-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 0.75rem;
  }

  .badge-count {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .timeline-feed {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .history-item {
    border-radius: 8px;
    padding: 0.85rem;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .history-item.role-user {
    background: var(--user-msg-bg, rgba(212, 175, 55, 0.06));
    border-color: var(--user-msg-border, rgba(212, 175, 55, 0.3));
  }

  .history-item.role-assistant {
    background: var(--bg-secondary);
    border-left: 3px solid var(--accent-primary, #d4af37);
  }

  .history-item.role-tool {
    background: var(--bg-base);
    border-left: 3px solid var(--accent-cyan);
  }

  .history-item.role-system {
    background: rgba(0, 0, 0, 0.4);
    opacity: 0.8;
  }

  .item-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .role-pill {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: var(--bg-surface);
    color: var(--text-secondary);
  }

  .tool-name-pill {
    font-size: 0.75rem;
    color: var(--accent-cyan);
    font-weight: 600;
  }

  .tool-id-pill {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .btn-toggle-raw {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    cursor: pointer;
  }

  .btn-toggle-raw:hover {
    color: var(--text-primary);
    border-color: var(--border-hover);
  }

  .item-content {
    font-size: 0.88rem;
    line-height: 1.5;
    color: var(--text-primary);
  }

  .item-content pre {
    background: var(--bg-base);
    padding: 0.5rem;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 0.75rem;
  }

  .item-reasoning {
    background: rgba(30, 27, 75, 0.2);
    border: 1px solid rgba(99, 102, 241, 0.15);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
  }

  .item-reasoning summary {
    cursor: pointer;
    color: #a5b4fc;
    font-weight: 600;
  }

  .item-reasoning pre {
    margin-top: 0.4rem;
    color: #c7d2fe;
    white-space: pre-wrap;
  }

  .item-tool-calls {
    background: var(--bg-base);
    border-radius: 6px;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .tc-label {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .tool-call-block {
    font-size: 0.75rem;
    color: var(--accent-cyan);
  }

  .tool-call-block pre {
    color: var(--text-secondary);
    background: var(--bg-surface);
    padding: 0.35rem;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.2rem 0 0 0;
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .meta-chip.has-unread {
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.08);
  }

  .unread-pill {
    color: #f59e0b;
    font-weight: 600;
  }

  .scheduled-timers-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .active-timer-badge {
    font-size: 0.72rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .empty-timers-notice {
    font-size: 0.82rem;
    color: var(--text-muted);
    font-style: italic;
    padding: 0.25rem 0;
  }

  .timers-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .timer-item {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.65rem 0.85rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .timer-item.pending {
    border-left: 3px solid #3b82f6;
  }

  .timer-item.cancelled {
    border-left: 3px solid var(--text-muted);
    opacity: 0.65;
  }

  .timer-item.triggered {
    border-left: 3px solid #10b981;
    opacity: 0.8;
  }

  .timer-main {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    flex: 1;
    min-width: 200px;
  }

  .timer-top-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .timer-id-pill {
    font-size: 0.72rem;
    color: var(--text-muted);
    background: var(--bg-base);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .timer-status-badge {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .timer-status-badge.status-pending {
    background: rgba(59, 130, 246, 0.2);
    color: #93c5fd;
  }

  .timer-status-badge.status-cancelled {
    background: rgba(107, 114, 128, 0.2);
    color: #9ca3af;
  }

  .timer-status-badge.status-triggered {
    background: rgba(16, 185, 129, 0.2);
    color: #6ee7b7;
  }

  .countdown-badge {
    font-size: 0.75rem;
    font-weight: 600;
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.3);
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    animation: pulse 1.5s infinite;
  }

  .timer-prompt {
    font-size: 0.8rem;
    color: var(--text-primary);
    margin: 0;
  }

  .timer-meta-info {
    font-size: 0.7rem;
    color: var(--text-muted);
    display: flex;
    gap: 0.75rem;
  }

  .btn-cancel-timer {
    background: rgba(239, 68, 68, 0.15);
    color: #f87171;
    border: 1px solid rgba(239, 68, 68, 0.3);
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-size: 0.75rem;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-cancel-timer:hover {
    background: rgba(239, 68, 68, 0.3);
    border-color: #ef4444;
  }

  .schedule-form {
    margin-top: 0.25rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border-subtle);
  }

  .schedule-inputs-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .duration-input-wrap {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .input-mini-label {
    font-size: 0.72rem;
    color: var(--text-muted);
    white-space: nowrap;
  }

  .duration-input {
    width: 60px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 0.25rem 0.4rem;
    font-size: 0.78rem;
  }

  .timer-prompt-input {
    flex: 1;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
  }

  .timer-prompt-input:focus, .duration-input:focus {
    outline: none;
    border-color: var(--accent-primary, #3b82f6);
  }

  .timer-error-msg {
    display: block;
    color: #ef4444;
    font-size: 0.72rem;
    margin-top: 0.3rem;
  }

  /* Narrative Clock & Events Card */
  .narrative-clock-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .clock-time-pill {
    font-size: 0.75rem;
    background: rgba(212, 175, 55, 0.12);
    border: 1px solid rgba(212, 175, 55, 0.35);
    color: var(--accent-primary, #d4af37);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    font-weight: 600;
  }

  .active-events-badge {
    font-size: 0.72rem;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    background: rgba(16, 185, 129, 0.15);
    color: #34d399;
    border: 1px solid rgba(16, 185, 129, 0.35);
  }

  .clock-header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-left: auto;
  }

  .btn-reset-events, .btn-reset-clock {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.6rem;
    border-radius: 4px;
    font-size: 0.74rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-reset-events {
    background: rgba(239, 68, 68, 0.12);
    color: #f87171;
    border: 1px solid rgba(239, 68, 68, 0.3);
  }

  .btn-reset-events:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.25);
    border-color: rgba(239, 68, 68, 0.5);
  }

  .btn-reset-clock {
    background: rgba(59, 130, 246, 0.12);
    color: #93c5fd;
    border: 1px solid rgba(59, 130, 246, 0.3);
  }

  .btn-reset-clock:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.25);
    border-color: rgba(59, 130, 246, 0.5);
  }

  .btn-reset-events:disabled, .btn-reset-clock:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .clock-stats-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem 1.25rem;
    padding: 0.5rem 0.75rem;
    background: rgba(0, 0, 0, 0.25);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 0.74rem;
  }

  .clock-stats-strip .stat-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .clock-stats-strip .stat-label {
    color: var(--text-muted);
  }

  .clock-stats-strip .stat-val {
    color: var(--text-primary);
    font-weight: 600;
  }

  .clock-error-msg {
    color: #ef4444;
    font-size: 0.75rem;
  }

  .empty-events-notice {
    font-size: 0.82rem;
    color: var(--text-muted);
    font-style: italic;
    padding: 0.35rem 0;
  }

  .narrative-events-list {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    max-height: 280px;
    overflow-y: auto;
  }

  .narrative-event-item {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .narrative-event-item.status-active {
    border-left: 3px solid #10b981;
    background: rgba(16, 185, 129, 0.05);
  }

  .narrative-event-item.status-pending {
    border-left: 3px solid #3b82f6;
  }

  .narrative-event-item.status-resolved {
    border-left: 3px solid #8b5cf6;
    opacity: 0.75;
  }

  .narrative-event-item.status-cancelled {
    border-left: 3px solid var(--text-muted);
    opacity: 0.6;
  }

  .event-main-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.8rem;
  }

  .event-id-pill {
    font-size: 0.7rem;
    color: var(--text-muted);
    background: var(--bg-base);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .event-name {
    font-weight: 600;
    color: var(--text-primary);
  }

  .event-status-pill {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .event-status-pill.status-active {
    background: rgba(16, 185, 129, 0.2);
    color: #6ee7b7;
  }

  .event-status-pill.status-pending {
    background: rgba(59, 130, 246, 0.2);
    color: #93c5fd;
  }

  .event-status-pill.status-resolved {
    background: rgba(139, 92, 246, 0.2);
    color: #c4b5fd;
  }

  .event-status-pill.status-cancelled {
    background: rgba(107, 114, 128, 0.2);
    color: #9ca3af;
  }

  .event-time-pill {
    font-size: 0.72rem;
    color: var(--text-secondary);
    margin-left: auto;
  }

  .event-priority-pill {
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    text-transform: uppercase;
  }

  .event-priority-pill.priority-critical {
    background: rgba(239, 68, 68, 0.2);
    color: #fca5a5;
  }

  .event-priority-pill.priority-high {
    background: rgba(245, 158, 11, 0.2);
    color: #fcd34d;
  }

  .event-desc {
    font-size: 0.78rem;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.4;
  }

  /* --- META CHIP EXTENSIONS --- */
  .meta-chip-clickable {
    cursor: pointer;
    text-align: left;
    transition: all 0.15s ease;
  }

  .meta-chip-clickable:hover {
    border-color: var(--accent-primary, #6366f1);
    background: rgba(99, 102, 241, 0.08);
  }

  .token-in {
    color: #38bdf8;
  }

  .token-out {
    color: #a78bfa;
  }

  .token-sep {
    color: var(--text-muted);
    margin: 0 0.15rem;
  }

  /* --- INSPECTOR TAB NAVIGATION --- */
  .inspector-tabs-nav {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-bottom: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    padding-bottom: 0.5rem;
    flex-wrap: wrap;
  }

  .inspector-tab-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary);
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .inspector-tab-btn:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.08);
  }

  .inspector-tab-btn.active {
    color: #fff;
    background: rgba(99, 102, 241, 0.15);
    border-color: rgba(99, 102, 241, 0.4);
    font-weight: 600;
  }

  .tab-badge {
    font-size: 0.68rem;
    background: rgba(0, 0, 0, 0.35);
    padding: 0.1rem 0.4rem;
    border-radius: 10px;
    color: var(--accent-primary, #a5b4fc);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  /* --- TELEMETRY TAB STYLES --- */
  .telemetry-tab-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .telemetry-header-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 1rem 1.25rem;
    border-radius: 8px;
    background: var(--bg-surface, rgba(20, 20, 28, 0.6));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  }

  .telemetry-title {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }

  .telemetry-sub {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin: 0.2rem 0 0 0;
  }

  .btn-clear-telemetry {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #f87171;
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    font-size: 0.76rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-clear-telemetry:hover {
    background: rgba(239, 68, 68, 0.22);
    border-color: rgba(239, 68, 68, 0.6);
    color: #fca5a5;
    transform: translateY(-1px);
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1rem;
  }

  .metric-card {
    display: flex;
    align-items: flex-start;
    gap: 0.9rem;
    padding: 1.15rem;
    border-radius: 8px;
    background: var(--bg-surface, rgba(20, 20, 28, 0.6));
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    transition: transform 0.15s ease, border-color 0.15s ease;
  }

  .metric-card:hover {
    border-color: rgba(255, 255, 255, 0.18);
  }

  .metric-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    border-radius: 8px;
    flex-shrink: 0;
  }

  .total-icon {
    background: rgba(139, 92, 246, 0.15);
    color: #a78bfa;
    border: 1px solid rgba(139, 92, 246, 0.35);
  }

  .input-icon {
    background: rgba(56, 189, 248, 0.15);
    color: #38bdf8;
    border: 1px solid rgba(56, 189, 248, 0.35);
  }

  .output-icon {
    background: rgba(168, 85, 247, 0.15);
    color: #c084fc;
    border: 1px solid rgba(168, 85, 247, 0.35);
  }

  .turns-icon {
    background: rgba(16, 185, 129, 0.15);
    color: #34d399;
    border: 1px solid rgba(16, 185, 129, 0.35);
  }

  .metric-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .metric-label {
    font-size: 0.72rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .metric-value {
    font-size: 1.35rem;
    font-weight: 700;
    color: var(--text-primary);
  }

  .metric-sub {
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .last-turn-card {
    border-radius: 8px;
    background: var(--bg-surface, rgba(20, 20, 28, 0.6));
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .last-turn-stats {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    flex-wrap: wrap;
  }

  .last-turn-stats .stat-pill {
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.78rem;
  }

  .last-turn-stats .stat-pill.highlight {
    border-color: rgba(99, 102, 241, 0.4);
    background: rgba(99, 102, 241, 0.1);
  }

  .last-turn-stats .stat-k {
    color: var(--text-muted);
  }

  .last-turn-stats .stat-v {
    color: var(--text-primary);
    font-weight: 600;
  }

  /* --- CONTEXT DEBUGGER STYLES --- */
  .context-debug-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .context-debug-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
    padding: 1rem 1.25rem;
    border-radius: 8px;
    background: var(--bg-surface, rgba(20, 20, 28, 0.6));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  }

  .debug-title {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }

  .debug-sub {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin: 0.2rem 0 0 0;
  }

  .btn-copy-context {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--bg-base, rgba(10, 10, 15, 0.8));
    border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
    color: var(--text-primary);
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-copy-context:hover {
    background: rgba(99, 102, 241, 0.15);
    border-color: rgba(99, 102, 241, 0.4);
    color: #fff;
  }

  .context-meta-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.55rem 0.95rem;
    border-radius: 6px;
    font-size: 0.76rem;
    color: var(--text-secondary);
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .empty-context-notice {
    padding: 2.5rem 1.5rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.88rem;
    border-radius: 8px;
    background: var(--bg-surface, rgba(20, 20, 28, 0.6));
    border: 1px dashed var(--border-subtle, rgba(255, 255, 255, 0.1));
  }

  .context-messages-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .context-msg-item {
    padding: 0.85rem 1.1rem;
    border-radius: 8px;
    background: var(--bg-surface, rgba(20, 20, 28, 0.6));
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .context-msg-item.role-system {
    border-left: 3px solid #8b5cf6;
  }

  .context-msg-item.role-user {
    border-left: 3px solid #3b82f6;
  }

  .context-msg-item.role-assistant {
    border-left: 3px solid #10b981;
  }

  .context-msg-item.role-tool {
    border-left: 3px solid #f59e0b;
  }

  .context-msg-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.75rem;
  }

  .msg-index {
    color: var(--text-muted);
    font-weight: 700;
  }

  .msg-name, .msg-tool-id {
    font-size: 0.7rem;
    background: rgba(0, 0, 0, 0.3);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .msg-token-est {
    margin-left: auto;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .msg-content {
    background: rgba(0, 0, 0, 0.35);
    border: 1px solid rgba(255, 255, 255, 0.05);
    padding: 0.75rem;
    border-radius: 6px;
    font-size: 0.78rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
    max-height: 320px;
    overflow-y: auto;
    margin: 0;
  }

  .msg-tool-calls {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-top: 0.25rem;
  }

  .tc-heading {
    font-size: 0.72rem;
    color: #f59e0b;
    font-weight: 600;
  }

  .tc-block {
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid rgba(245, 158, 11, 0.2);
    padding: 0.6rem;
    border-radius: 6px;
    font-size: 0.74rem;
    color: #fcd34d;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
    max-height: 200px;
    overflow-y: auto;
  }
</style>
