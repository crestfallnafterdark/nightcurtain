<script>
  import SandboxMessageCard from './SandboxMessageCard.svelte';
  import { renderMarkdownProse } from './markdown/index.ts';
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';

  let {
    agent = null,
    messages = [],
    isStreaming = false,
    streamingProse = '',
    streamingReasoning = '',
    activeToolCalls = [],
    onSendTurn = async () => {},
    onEditMessage = null,
    onEditAgent = null
  } = $props();

  let scrollContainer = $state(null);
  let isUserScrolledUp = $state(false);
  let lastScrollTop = 0;
  let isStreamingThinkingExpanded = $state(false);

  /**
   * Deterministic Yielding Check: Returns true if the current streaming prose
   * has already been committed as the latest assistant message in history,
   * cleanly yielding the in-flight preview to prevent duplicate bubble rendering.
   */
  function hasCommittedCurrentTurn(msgs, streamProse) {
    if (!msgs || msgs.length === 0) return false;
    const lastMsg = msgs[msgs.length - 1];
    if (lastMsg && (lastMsg.role === 'assistant' || lastMsg.role === 'model')) {
      const trimmedStream = (streamProse || '').trim();
      const trimmedContent = (lastMsg.content || '').trim();
      if (trimmedStream && trimmedContent && (trimmedStream === trimmedContent || trimmedContent.endsWith(trimmedStream))) {
        return true;
      }
    }
    return false;
  }

  async function handleEditMessage(messageId, newContent) {
    if (onEditMessage) {
      await onEditMessage(messageId, newContent);
    } else {
      sandboxStore.editAgentMessage(messageId, newContent);
    }
  }

  let lastAssistantIndex = $derived.by(() => {
    if (!messages || messages.length === 0) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return i;
    }
    return -1;
  });

  // QA-012 unified failure surface: the store projection already redacts
  // `lastError`, and persistence re-applies it during hydration, so its
  // presence alone marks a failed turn — independent of agent state (idle
  // after reload) or interruption state. Never rendered raw.
  let failureReason = $derived(agent?.lastError || null);

  // Auto-collapse / expand live thinking during active streaming
  let prevStreaming = false;
  $effect(() => {
    if (!prevStreaming && isStreaming) {
      isStreamingThinkingExpanded = false;
    }
    prevStreaming = isStreaming;
  });

  function handleScroll() {
    if (!scrollContainer) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
    const distanceFromBottom = scrollHeight - (scrollTop + clientHeight);
    isUserScrolledUp = distanceFromBottom > 100;
    lastScrollTop = scrollTop;
  }

  function scrollToBottom(smooth = true) {
    if (!scrollContainer) return;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto'
    });
    isUserScrolledUp = false;
  }

  $effect(() => {
    // Read reactive variables to trigger effect
    const _len = messages.length;
    const _stream = streamingProse;
    const _reason = streamingReasoning;
    const _loading = isStreaming;

    if (!isUserScrolledUp && scrollContainer) {
      queueMicrotask(() => {
        scrollToBottom(true);
      });
    }
  });

  function toggleStreamingThinking() {
    isStreamingThinkingExpanded = !isStreamingThinkingExpanded;
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
</script>

<div class="sandbox-chat-log-wrapper">
  <div
    class="chat-scroll-area"
    bind:this={scrollContainer}
    onscroll={handleScroll}
  >
    <div class="chat-reading-column">
      <!-- Agent Studio Header -->
      {#if agent}
        <header class="agent-chronicle-header">
          <div class="agent-title-row">
            <h1 class="agent-title">{agent.name}</h1>
            <span class="agent-id-pill font-mono">{agent.id}</span>
            {#if agent.config?.privileged}
              <span class="sudo-tag font-mono" title="Universal Administrative / Sudo Authority">⚡ sudo</span>
            {/if}
            <span class="state-chip state-{agent.state} font-mono">{agent.state}</span>
            {#if (agent.unreadCount || 0) > 0}
              <span class="mail-header-badge font-mono" title="{agent.unreadCount} unread message(s)">
                ✉ {agent.unreadCount} unread
              </span>
            {/if}
            {#if messages.length > 0}
              <button
                type="button"
                class="btn-undo-turn-header"
                onclick={() => sandboxStore.undoAgentTurn(agent.identityKey)}
                title="Undo last completed turn for this agent"
                disabled={isStreaming}
              >
                <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
                <span>Undo Turn</span>
              </button>
            {/if}
            {#if onEditAgent}
              <button
                type="button"
                class="btn-edit-agent"
                onclick={() => onEditAgent?.()}
                title="Edit Agent Character & Directives"
              >
                <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
                <span>Edit Agent</span>
              </button>
            {/if}
          </div>
          {#if agent.config?.role}
            <p class="agent-subtitle">{agent.config.role}</p>
          {/if}
          <div class="agent-divider"></div>
        </header>
      {/if}

      <!-- Empty State -->
      {#if messages.length === 0 && !isStreaming}
        <div class="empty-state glass-panel">
          <div class="empty-icon-wrap">
            <svg class="icon-svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <h2 class="empty-heading">Conversational Studio</h2>
          <p class="empty-desc">
            You are in direct communication with <strong>{agent ? agent.name : 'Agent'}</strong>.
            Submit a directive, ask a question, or trigger a tool operation below to begin.
          </p>
        </div>
      {:else}
        <!-- Historical Turn Messages (Single-Pass Keyed Loop with Invariant Stable Message ID) -->
        <div class="messages-stream">
          {#each messages as msg, index (msg.id)}
            <SandboxMessageCard
              message={msg}
              isLatest={index === messages.length - 1}
              isLatestAssistant={index === lastAssistantIndex}
              agentId={agent?.identityKey}
              onEditMessage={handleEditMessage}
              onDeleteMessage={(msgId) => sandboxStore.deleteAgentMessage(msgId, agent?.identityKey)}
              onUndoTurn={() => sandboxStore.undoAgentTurn(agent?.identityKey)}
            />
          {/each}
        </div>
      {/if}

      <!-- Failed Agent Turn Notice (QA-012 unified failure surface) -->
      {#if agent && failureReason && !isStreaming}
        <div class="sandbox-failure-card glass-panel" role="alert">
          <div class="sandbox-failure-header">
            <span class="sandbox-failure-icon" aria-hidden="true">
              <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </span>
            <div class="sandbox-failure-info">
              <strong class="sandbox-failure-title">Execution Error Encountered</strong>
              <p class="sandbox-failure-reason" title={failureReason}>{failureReason}</p>
            </div>
          </div>
          <div class="sandbox-turn-actions">
            <button
              type="button"
              class="btn-sm btn-resend-sandbox"
              onclick={() => sandboxStore.retryAgentTurn(agent.identityKey)}
              title="Retry the failed turn"
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
              <span>Retry Turn</span>
            </button>
            <button
              type="button"
              class="btn-sm btn-undo-sandbox"
              onclick={() => sandboxStore.undoAgentTurn(agent.identityKey)}
              title="Undo the failed turn and restore the prompt to the editor"
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
              <span>Undo Turn &amp; Edit Prompt</span>
            </button>
            <button
              type="button"
              class="btn-sm btn-dismiss-sandbox"
              onclick={() => sandboxStore.clearAgentLastError(agent.identityKey)}
              title="Dismiss error"
            >
              <span>Dismiss</span>
            </button>
          </div>
        </div>
      {/if}

      <!-- Interrupted Agent Turn Notice (genuine cancellations only) -->
      {#if agent && !failureReason && sandboxStore.isAgentInterrupted(agent.identityKey) && !isStreaming}
        <div class="sandbox-interrupted-card glass-panel">
          <div class="sandbox-interrupted-header">
            <span class="sandbox-interrupted-dot"></span>
            <div class="sandbox-interrupted-info">
              <strong class="sandbox-interrupted-title">Agent Turn Interrupted</strong>
              <p class="sandbox-interrupted-desc">Turn execution was stopped before completing.</p>
            </div>
          </div>
          <div class="sandbox-turn-actions">
            <button
              type="button"
              class="btn-sm btn-resend-sandbox"
              onclick={() => sandboxStore.retryAgentTurn(agent.identityKey)}
              title="Resend this turn to the agent"
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
              <span>Resend Turn</span>
            </button>
            <button
              type="button"
              class="btn-sm btn-undo-sandbox"
              onclick={() => sandboxStore.undoAgentTurn(agent.identityKey)}
              title="Undo this turn and remove from history"
            >
              <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
              <span>Undo Turn</span>
            </button>
          </div>
        </div>
      {/if}

      <!-- In-Flight Live Streaming Turn (Yields immediately when turn is committed to history) -->
      {#if isStreaming && !hasCommittedCurrentTurn(messages, streamingProse) && (streamingProse || streamingReasoning || (activeToolCalls && activeToolCalls.length > 0))}
        <div class="streaming-stream-entry">
          <!-- Live Thinking / Reasoning Accordion -->
          {#if streamingReasoning}
            <div class="thinking-container streaming-thinking-box glass-panel" class:expanded={isStreamingThinkingExpanded}>
              <button
                type="button"
                class="thinking-header"
                onclick={toggleStreamingThinking}
                title="Toggle live thinking process"
              >
                <div class="thinking-header-left">
                  <span class="thinking-icon-wrap">
                    <svg class="thinking-spark-svg animating" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/>
                    </svg>
                  </span>
                  <span class="thinking-title">
                    {#if !streamingProse}
                      <span class="thinking-live-text">Thinking...</span>
                    {:else}
                      <span>Thought Process</span>
                    {/if}
                  </span>
                  {#if !streamingProse}
                    <span class="thinking-pulse-dot"></span>
                  {/if}
                </div>
                <div class="thinking-header-right">
                  <span class="thinking-toggle-label">{isStreamingThinkingExpanded ? 'Hide' : 'Show'}</span>
                  <span class="thinking-chevron" class:rotated={isStreamingThinkingExpanded}>▾</span>
                </div>
              </button>

              {#if isStreamingThinkingExpanded}
                <div class="thinking-content-body">
                  <div class="thinking-prose-stream font-mono">
                    {streamingReasoning}
                    {#if !streamingProse}
                      <span class="thinking-cursor"></span>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          {/if}

          <!-- Active Tool Invocations During Streaming -->
          {#if activeToolCalls && activeToolCalls.length > 0}
            <div class="active-tools-stream">
              {#each activeToolCalls as tc}
                <div class="active-tool-badge glass-panel">
                  <div class="tool-spinner-sm"></div>
                  <span class="tool-name font-mono">{tc.function?.name || tc.name}</span>
                  <span class="tool-status font-mono">Executing...</span>
                </div>
              {/each}
            </div>
          {/if}

          <!-- Live Streaming Narrative Prose -->
          {#if streamingProse}
            <div class="turn-narrative-prose markdown-content">
              {@html renderMarkdownProse(streamingProse)}
              <span class="book-cursor"></span>
            </div>
          {/if}
        </div>
      {:else if isStreaming && !hasCommittedCurrentTurn(messages, streamingProse) && !streamingProse && !streamingReasoning && (!activeToolCalls || activeToolCalls.length === 0)}
        <div class="stream-waiting">
          <span class="pulse-dot"></span>
          <span class="waiting-label">{agent ? agent.name : 'Agent'} is contemplating...</span>
        </div>
      {/if}
    </div>
  </div>

  <!-- Floating Jump to Bottom Button -->
  {#if isUserScrolledUp}
    <button type="button" class="btn-jump-bottom glass-panel" onclick={() => scrollToBottom(true)}>
      <span>Latest Turn</span>
      <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m6 9 6 6 6-6"/>
      </svg>
    </button>
  {/if}
</div>

<style>
  .sandbox-chat-log-wrapper {
    flex: 1;
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--bg-base);
  }

  .chat-scroll-area {
    flex: 1;
    overflow-y: auto;
    padding: 2rem 1.5rem;
    display: flex;
    flex-direction: column;
  }

  .chat-reading-column {
    max-width: 820px;
    width: 100%;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
  }

  .agent-chronicle-header {
    margin-bottom: 2rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
  }

  .agent-title-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    justify-content: center;
  }

  .agent-title {
    font-size: 1.6rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
    font-family: var(--font-main);
  }

  .agent-id-pill {
    font-size: 0.75rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .sudo-tag {
    font-size: 0.65rem;
    padding: 0.12rem 0.42rem;
    border-radius: 4px;
    background: rgba(245, 158, 11, 0.18);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.4);
    font-weight: 700;
    letter-spacing: 0.03em;
    line-height: 1;
  }

  .state-chip {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    background: var(--bg-surface);
  }

  .state-chip.state-running {
    color: var(--accent-warning);
    background: var(--accent-warning-subtle);
  }

  .state-chip.state-idle {
    color: var(--accent-success);
  }

  .state-chip.state-errored {
    color: var(--accent-danger);
    background: var(--accent-danger-subtle);
  }

  .mail-header-badge {
    font-size: 0.72rem;
    font-weight: 600;
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.3);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
  }

  .btn-undo-turn-header {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text-secondary);
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-undo-turn-header:hover:not(:disabled) {
    color: #fbbf24;
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.1);
    transform: translateY(-1px);
  }

  .btn-undo-turn-header:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-edit-agent {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--accent-primary, #d4af37);
    background: var(--accent-primary-subtle, rgba(212, 175, 55, 0.1));
    border: 1px solid var(--accent-primary-border, rgba(212, 175, 55, 0.25));
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-edit-agent:hover {
    background: rgba(212, 175, 55, 0.2);
    border-color: var(--accent-primary, #d4af37);
    transform: translateY(-1px);
  }

  .agent-subtitle {
    margin: 0;
    font-size: 0.88rem;
    color: var(--text-secondary);
  }

  .agent-divider {
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--border-color), transparent);
    width: 80%;
    margin: 0.75rem auto 0 auto;
  }

  .messages-stream {
    display: flex;
    flex-direction: column;
  }

  .empty-state {
    margin: 3.5rem auto;
    max-width: 520px;
    padding: 2.5rem 2rem;
    text-align: center;
    border-radius: 12px;
    border: 1px solid var(--border-color);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .empty-icon-wrap {
    color: var(--accent-primary, #d4af37);
    margin-bottom: 0.25rem;
  }

  .empty-heading {
    font-size: 1.4rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
  }

  .empty-desc {
    color: var(--text-secondary);
    line-height: 1.6;
    font-size: 0.95rem;
    margin: 0;
  }

  .streaming-stream-entry {
    margin-bottom: 1.5rem;
    animation: chronicle-fade 0.2s ease-out;
  }

  /* Thinking Box (Claude-Style Accordion) */
  .thinking-container {
    margin-bottom: 0.85rem;
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
    transition: background 0.15s ease, color 0.15s ease;
  }

  .thinking-header:hover {
    background: rgba(255, 255, 255, 0.03);
    color: var(--text-primary, #f8fafc);
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

  .thinking-live-text {
    font-style: italic;
  }

  .thinking-pulse-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-primary, #d4af37);
    opacity: 0.9;
    animation: pulse-dot 1.2s infinite ease-in-out;
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

  .thinking-cursor {
    display: inline-block;
    width: 6px;
    height: 14px;
    background: var(--accent-primary, #d4af37);
    margin-left: 3px;
    vertical-align: middle;
    animation: blink 0.8s infinite;
  }

  /* Active Tools Stream */
  .active-tools-stream {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-bottom: 0.85rem;
  }

  .active-tool-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    border-radius: 6px;
    border: 1px solid rgba(56, 189, 248, 0.3);
    background: rgba(56, 189, 248, 0.08);
  }

  .tool-spinner-sm {
    width: 12px;
    height: 12px;
    border: 2px solid rgba(56, 189, 248, 0.3);
    border-top-color: #38bdf8;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  .tool-name {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--accent-cyan, #38bdf8);
  }

  .tool-status {
    font-size: 0.72rem;
    color: var(--text-muted);
    margin-left: auto;
  }

  .turn-narrative-prose {
    color: var(--text-primary);
    font-size: 0.98rem;
    line-height: 1.7;
  }

  .book-cursor {
    display: inline-block;
    width: 3px;
    height: 16px;
    background: var(--accent-primary, #d4af37);
    margin-left: 4px;
    vertical-align: middle;
    animation: blink 0.8s infinite;
  }

  .stream-waiting {
    display: inline-flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.6rem 1rem;
    border-radius: 8px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    margin-bottom: 1.5rem;
    width: fit-content;
  }

  .pulse-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent-primary, #d4af37);
    animation: pulse-dot 1.2s infinite ease-in-out;
  }

  .waiting-label {
    font-size: 0.88rem;
    color: var(--text-secondary);
    font-style: italic;
  }

  .btn-jump-bottom {
    position: absolute;
    bottom: 1.5rem;
    right: 2rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.9rem;
    border-radius: 6px;
    background: var(--bg-surface-elevated);
    border: 1px solid var(--border-hover);
    color: var(--text-primary);
    font-size: 0.82rem;
    font-weight: 500;
    cursor: pointer;
    box-shadow: var(--shadow-md);
    animation: fade-in-up 0.2s ease-out;
    transition: background 0.15s ease;
  }

  .btn-jump-bottom:hover {
    background: var(--bg-surface-hover);
  }

  @keyframes pulse-dot {
    0%, 100% { opacity: 0.4; transform: scale(0.85); }
    50% { opacity: 1; transform: scale(1.15); }
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0; }
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @keyframes chronicle-fade {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes fade-in-up {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /*
   * QA-012 duplicate-surface decision: the chat-log card is the canonical
   * in-transcript failure/interrupt notice. The composer renders the same
   * `agent.lastError` / interrupted state as a sticky banner (SandboxActionInput
   * `.failure-notice-banner` / `.interrupted-notice-banner`), which would repeat
   * the identical copy directly below the card. While the card is rendering its
   * notice, suppress the composer mirror so exactly one notice is visible; the
   * composer keeps its Retry/Undo action buttons and hotkey hints. Scoped to the
   * chat pane so other hosts of either component are unaffected.
   */
  :global(.chat-studio-pane:has(.sandbox-failure-card) .failure-notice-banner),
  :global(.chat-studio-pane:has(.sandbox-interrupted-card) .interrupted-notice-banner) {
    display: none;
  }

  .sandbox-failure-card {
    margin: 1.25rem 0;
    padding: 1rem 1.25rem;
    border-radius: 8px;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.35);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    animation: chronicle-fade 0.25s ease-out;
  }

  .sandbox-failure-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .sandbox-failure-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #f87171;
    flex-shrink: 0;
  }

  .sandbox-failure-info {
    min-width: 0;
  }

  .sandbox-failure-title {
    font-size: 0.92rem;
    color: #f87171;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .sandbox-failure-reason {
    font-size: 0.78rem;
    color: var(--text-secondary);
    margin: 0.15rem 0 0 0;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .sandbox-interrupted-card {
    margin: 1.25rem 0;
    padding: 1rem 1.25rem;
    border-radius: 8px;
    background: rgba(245, 158, 11, 0.07);
    border: 1px solid rgba(245, 158, 11, 0.3);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
    animation: chronicle-fade 0.25s ease-out;
  }

  .sandbox-interrupted-header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
  }

  .sandbox-interrupted-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #f59e0b;
    box-shadow: 0 0 10px rgba(245, 158, 11, 0.9);
    animation: pulseNotice 1.5s infinite;
    flex-shrink: 0;
  }

  .sandbox-interrupted-title {
    font-size: 0.92rem;
    color: var(--text-primary);
    font-weight: 600;
  }

  .sandbox-interrupted-desc {
    font-size: 0.78rem;
    color: var(--text-muted);
    margin: 0.15rem 0 0 0;
  }

  .sandbox-turn-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .btn-dismiss-sandbox {
    background: transparent;
    color: var(--text-muted, #94a3b8);
    font-weight: 500;
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    transition: all 0.15s ease;
    border: 1px solid var(--border-color);
  }

  .btn-dismiss-sandbox:hover {
    background: var(--bg-surface-hover);
    color: var(--text-primary);
  }

  .btn-resend-sandbox {
    background: var(--accent-primary, #d4af37);
    color: #111;
    font-weight: 600;
    padding: 0.4rem 0.85rem;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    transition: all 0.15s ease;
    border: 1px solid var(--accent-primary, #d4af37);
  }

  .btn-resend-sandbox:hover {
    filter: brightness(1.1);
  }

  .btn-undo-sandbox {
    background: var(--bg-surface);
    color: var(--text-secondary);
    font-weight: 500;
    padding: 0.4rem 0.8rem;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    transition: all 0.15s ease;
    border: 1px solid var(--border-color);
  }

  .btn-undo-sandbox:hover {
    background: var(--bg-surface-hover);
    color: var(--text-primary);
    border-color: var(--border-focus);
  }
</style>
