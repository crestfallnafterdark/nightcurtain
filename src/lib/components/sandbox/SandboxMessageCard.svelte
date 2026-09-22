<script>
  import { renderMarkdownProse } from './markdown/index.ts';
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';

  let {
    message,
    isLatest = false,
    isLatestAssistant = false,
    isStreaming = false,
    agentId = null,
    onEditMessage = null,
    onDeleteMessage = null,
    onUndoTurn = null
  } = $props();

  function handleDeleteMessage() {
    if (onDeleteMessage) {
      onDeleteMessage(message.id);
    } else if (sandboxStore && typeof sandboxStore.deleteAgentMessage === 'function') {
      sandboxStore.deleteAgentMessage(message.id, agentId);
    }
  }

  function handleUndoTurn() {
    if (onUndoTurn) {
      onUndoTurn();
    } else if (sandboxStore && typeof sandboxStore.undoAgentTurn === 'function') {
      sandboxStore.undoAgentTurn(agentId);
    }
  }

  let isThinkingExpanded = $state(false);
  let copied = $state(false);
  let showToolDetails = $state({});

  // Inline Message Editing State (REQ-UI-04)
  let isEditing = $state(false);
  let editDraft = $state('');
  let isSaving = $state(false);
  let editTextareaRef = $state(null);

  function startEditing() {
    editDraft = message.content || '';
    isEditing = true;
  }

  function cancelEdit() {
    editDraft = message.content || '';
    isEditing = false;
  }

  async function saveEdit() {
    const trimmed = editDraft.trim();
    if (trimmed !== (message.content || '').trim()) {
      isSaving = true;
      try {
        if (onEditMessage) {
          await onEditMessage(message.id, trimmed);
        } else if (sandboxStore && typeof sandboxStore.editAgentMessage === 'function') {
          sandboxStore.editAgentMessage(message.id, trimmed);
        }
      } finally {
        isSaving = false;
      }
    }
    isEditing = false;
  }

  function handleEditKeydown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  function autoResizeEdit() {
    if (!editTextareaRef) return;
    editTextareaRef.style.height = 'auto';
    editTextareaRef.style.height = Math.min(editTextareaRef.scrollHeight, 400) + 'px';
  }

  $effect(() => {
    if (isEditing && editTextareaRef) {
      queueMicrotask(() => {
        if (editTextareaRef) {
          editTextareaRef.focus();
          autoResizeEdit();
        }
      });
    }
  });

  $effect(() => {
    if (message.isThinkingExpanded !== undefined) {
      isThinkingExpanded = Boolean(message.isThinkingExpanded);
    }
  });

  function toggleThinking() {
    isThinkingExpanded = !isThinkingExpanded;
    message.isThinkingExpanded = isThinkingExpanded;
  }

  function toggleToolDetails(key) {
    showToolDetails = {
      ...showToolDetails,
      [key]: !showToolDetails[key]
    };
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(message.content || '');
      copied = true;
      setTimeout(() => copied = false, 2000);
    } catch {
      // Clipboard fallback
    }
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

  function parseToolPayload(content) {
    if (typeof content !== 'string') return content;
    try {
      return JSON.parse(content);
    } catch (_) {
      return content;
    }
  }

  let reasoningText = $derived(message.reasoning || message.reasoning_content || '');
  let isEventNotification = $derived(
    message.role === 'user' &&
    typeof message.content === 'string' &&
    (message.content.startsWith('[EVENT NOTIFICATION]') || message.content.startsWith('[MAIL NOTIFICATION]'))
  );
</script>

<article
  class="turn-entry"
  class:turn-assistant={message.role === 'assistant'}
  class:turn-user={message.role === 'user'}
  class:turn-system={message.role === 'system'}
  class:turn-tool={message.role === 'tool'}
  class:turn-event={isEventNotification}
>
  <!-- Micro Toolbar -->
  <div class="turn-micro-toolbar">
    <span class="role-indicator font-mono">{isEventNotification ? 'event' : message.role}</span>
    {#if message.role !== 'tool' && !isEditing}
      <button type="button" class="micro-btn" onclick={startEditing} title="Edit message content">
        Edit
      </button>
    {/if}
    <button type="button" class="micro-btn" onclick={copyText} title="Copy turn content">
      {copied ? 'Copied' : 'Copy'}
    </button>
    {#if !isEditing}
      <button
        type="button"
        class="micro-btn micro-danger"
        onclick={handleDeleteMessage}
        title="Delete this message (with cascading tool hygiene)"
      >
        Delete
      </button>
    {/if}
    {#if (isLatest || isLatestAssistant) && !isEditing}
      <button
        type="button"
        class="micro-btn micro-undo"
        onclick={handleUndoTurn}
        title="Undo this full turn (removes prompt and assistant response)"
      >
        Undo Turn
      </button>
    {/if}
  </div>

  <!-- 1. USER TURN -->
  {#if message.role === 'user'}
    <div class="chronicle-action-group">
      {#if isEditing}
        <div class="action-prefix-label">
          <strong>{isEventNotification ? 'Event Notification' : 'User Directive'}</strong>
        </div>
        <div class="inline-editor-wrap glass-panel">
          <textarea
            bind:this={editTextareaRef}
            bind:value={editDraft}
            oninput={autoResizeEdit}
            onkeydown={handleEditKeydown}
            class="inline-edit-textarea font-mono"
            placeholder={isEventNotification ? "Edit event notification..." : "Edit user directive..."}
            rows="3"
          ></textarea>
          <div class="inline-edit-footer">
            <span class="shortcut-tip font-mono">Ctrl+Enter to save • Esc to cancel</span>
            <div class="inline-edit-actions">
              <button type="button" class="btn-edit-action btn-cancel" onclick={cancelEdit}>
                Cancel
              </button>
              <button type="button" class="btn-edit-action btn-save" onclick={saveEdit} disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      {:else if isEventNotification}
        <div class="event-notification-card glass-panel" class:scheduled-event={message.content.includes('scheduled event')}>
          <div class="event-notification-header">
            <span class="event-icon">
              {#if message.content.includes('scheduled event')}
                🕒
              {:else}
                ✉️
              {/if}
            </span>
            <span class="event-title font-mono">
              {message.content.includes('scheduled event') ? 'Scheduled Event Notification' : 'Mailbox Notification'}
            </span>
            <span class="event-badge font-mono">Mailbox Autonomy</span>
          </div>
          <div class="event-notification-body">
            <p class="event-text">{message.content}</p>
          </div>
        </div>
      {:else}
        <div class="action-prefix-label">
          <strong>User Directive</strong>
        </div>
        <blockquote class="book-blockquote">
          {#each (message.content || '').split('\n') as line}
            <p>{line}</p>
          {/each}
        </blockquote>
      {/if}
    </div>

  <!-- 2. ASSISTANT TURN -->
  {:else if message.role === 'assistant'}
    <!-- Collapsible Reasoning / Thinking Box -->
    {#if reasoningText}
      <div class="thinking-container glass-panel" class:expanded={isThinkingExpanded}>
        <button
          type="button"
          class="thinking-header"
          onclick={toggleThinking}
          title="Toggle thinking process"
        >
          <div class="thinking-header-left">
            <span class="thinking-icon-wrap">
              <svg class="thinking-spark-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2v4"/><path d="M12 18v4"/><path d="M4.93 4.93l2.83 2.83"/><path d="M16.24 16.24l2.83 2.83"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="M4.93 19.07l2.83-2.83"/><path d="M16.24 7.76l2.83-2.83"/>
              </svg>
            </span>
            <span class="thinking-title">Thought Process</span>
          </div>
          <div class="thinking-header-right">
            <span class="thinking-toggle-label">{isThinkingExpanded ? 'Hide' : 'Show'}</span>
            <span class="thinking-chevron" class:rotated={isThinkingExpanded}>▾</span>
          </div>
        </button>

        {#if isThinkingExpanded}
          <div class="thinking-content-body">
            <div class="thinking-prose-stream">
              {reasoningText}
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Inline Tool Calls (Emitted by Assistant) -->
    {#if message.tool_calls && message.tool_calls.length > 0}
      <div class="inline-tools-container">
        {#each message.tool_calls as tc, idx (tc.id || idx)}
          {@const key = tc.id || `tc_${idx}`}
          {@const isExpanded = !!showToolDetails[key]}
          {@const toolName = tc.function?.name || tc.name || 'tool'}
          {@const rawArgs = tc.function?.arguments || tc.arguments}
          <div class="inline-tool-badge glass-panel" class:expanded={isExpanded}>
            <button
              type="button"
              class="tool-badge-header"
              onclick={() => toggleToolDetails(key)}
              title="Toggle tool execution details"
            >
              <div class="tool-badge-left">
                <span class="tool-status-icon success-icon">
                  <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span class="tool-name font-mono">{toolName}</span>
                {#if tc.id}
                  <span class="tool-id font-mono">id: {tc.id.slice(0, 8)}</span>
                {/if}
              </div>
              <div class="tool-badge-right">
                <span class="tool-expand-label font-mono">{isExpanded ? 'Hide' : 'Inspect'}</span>
                <span class="tool-chevron" class:rotated={isExpanded}>▾</span>
              </div>
            </button>

            {#if isExpanded}
              <div class="tool-badge-body">
                <div class="tool-args-label">Arguments:</div>
                <pre class="tool-args-pre font-mono">{formatJson(rawArgs)}</pre>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <!-- Assistant Rich Narrative Prose -->
    {#if isEditing}
      <div class="inline-editor-wrap glass-panel">
        <textarea
          bind:this={editTextareaRef}
          bind:value={editDraft}
          oninput={autoResizeEdit}
          onkeydown={handleEditKeydown}
          class="inline-edit-textarea font-mono"
          placeholder="Edit assistant prose..."
          rows="4"
        ></textarea>
        <div class="inline-edit-footer">
          <span class="shortcut-tip font-mono">Ctrl+Enter to save • Esc to cancel</span>
          <div class="inline-edit-actions">
            <button type="button" class="btn-edit-action btn-cancel" onclick={cancelEdit}>
              Cancel
            </button>
            <button type="button" class="btn-edit-action btn-save" onclick={saveEdit} disabled={isSaving}>
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    {:else if message.content}
      <div class="turn-narrative-prose markdown-content">
        {@html renderMarkdownProse(message.content)}
      </div>
    {/if}

  <!-- 3. TOOL RESULT TURN -->
  {:else if message.role === 'tool'}
    {@const parsed = parseToolPayload(message.content)}
    {@const isExpanded = !!showToolDetails[message.tool_call_id || message.name || 'tool_result']}
    <div class="tool-result-card glass-panel" class:expanded={isExpanded}>
      <header
        class="tool-result-header"
        role="button"
        tabindex="0"
        onclick={() => toggleToolDetails(message.tool_call_id || message.name || 'tool_result')}
        onkeydown={(e) => { if (e.key === 'Enter') toggleToolDetails(message.tool_call_id || message.name || 'tool_result'); }}
      >
        <div class="tool-result-header-left">
          {#if parsed && typeof parsed === 'object' && parsed.success === false}
            <span class="tool-status-icon error-icon" title="Tool returned error">✕</span>
          {:else}
            <span class="tool-status-icon success-icon" title="Tool execution succeeded">✓</span>
          {/if}
          <strong class="tool-result-title font-mono">
            {message.name || 'Tool Receipt'}
          </strong>
          {#if message.tool_call_id}
            <span class="tool-id font-mono">id: {message.tool_call_id.slice(0, 8)}</span>
          {/if}
          {#if parsed && typeof parsed === 'object' && parsed.truncated}
            <span class="tool-budget-pill font-mono">1.5KB Capped</span>
          {/if}
        </div>
        <div class="tool-result-header-right">
          <span class="tool-expand-label font-mono">{isExpanded ? 'Hide Payload' : 'View Payload'}</span>
          <span class="tool-chevron" class:rotated={isExpanded}>▾</span>
        </div>
      </header>

      <!-- Concise Summary Receipt Line -->
      {#if parsed && typeof parsed === 'object' && !isExpanded}
        <div class="tool-concise-summary">
          {#if parsed.message}
            <span class="summary-msg">{parsed.message}</span>
          {:else if parsed.path}
            <span class="summary-path font-mono">{parsed.path}</span>
            {#if parsed.bytes_written !== undefined}
              <span class="summary-meta font-mono">({parsed.bytes_written} bytes)</span>
            {/if}
          {:else if parsed.total_matches !== undefined}
            <span class="summary-msg">{parsed.total_matches} matches found</span>
          {:else if parsed.truncated}
            <span class="summary-msg">Output budgeted at {parsed.content?.length || 1500} bytes (total {parsed.total_bytes} bytes)</span>
          {/if}
        </div>
      {/if}

      {#if isExpanded}
        <div class="tool-result-body">
          <pre class="tool-result-pre font-mono">{formatJson(message.content)}</pre>
        </div>
      {/if}
    </div>

  <!-- 4. SYSTEM PROMPT TURN -->
  {:else}
    <div class="turn-system-prose glass-panel">
      <div class="system-header">
        <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span class="system-title">System Directive</span>
      </div>
      {#if isEditing}
        <div class="inline-editor-wrap">
          <textarea
            bind:this={editTextareaRef}
            bind:value={editDraft}
            oninput={autoResizeEdit}
            onkeydown={handleEditKeydown}
            class="inline-edit-textarea font-mono"
            placeholder="Edit system directive..."
            rows="3"
          ></textarea>
          <div class="inline-edit-footer">
            <span class="shortcut-tip font-mono">Ctrl+Enter to save • Esc to cancel</span>
            <div class="inline-edit-actions">
              <button type="button" class="btn-edit-action btn-cancel" onclick={cancelEdit}>
                Cancel
              </button>
              <button type="button" class="btn-edit-action btn-save" onclick={saveEdit} disabled={isSaving}>
                {isSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      {:else}
        <div class="system-body">
          <p>{message.content}</p>
        </div>
      {/if}
    </div>
  {/if}
</article>

<style>
  .turn-entry {
    position: relative;
    width: 100%;
    margin-bottom: 1.5rem;
    animation: chronicle-fade 0.2s ease-out;
  }

  .turn-micro-toolbar {
    position: absolute;
    bottom: -0.85rem;
    right: 0;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    background: var(--bg-surface-elevated);
    border: 1px solid var(--border-color);
    padding: 0.15rem 0.45rem;
    border-radius: 6px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease-in-out;
    z-index: 10;
    box-shadow: var(--shadow-sm);
  }

  .turn-entry:hover .turn-micro-toolbar,
  .turn-entry:focus-within .turn-micro-toolbar {
    opacity: 1;
    pointer-events: auto;
  }

  .role-indicator {
    font-size: 0.65rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .micro-btn {
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 0.65rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    cursor: pointer;
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
    font-family: var(--font-main);
  }

  .micro-btn:hover {
    color: var(--text-primary);
    background: rgba(255, 255, 255, 0.1);
  }

  .micro-btn.micro-danger:hover {
    color: #f87171;
    background: rgba(239, 68, 68, 0.15);
  }

  .micro-btn.micro-undo:hover {
    color: #fbbf24;
    background: rgba(245, 158, 11, 0.15);
  }

  /* User Blockquote */
  .chronicle-action-group {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .action-prefix-label {
    font-size: 0.82rem;
    color: var(--accent-primary, #d4af37);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .book-blockquote {
    margin: 0;
    padding: 0.75rem 1.1rem;
    background: var(--user-msg-bg, rgba(212, 175, 55, 0.06));
    border-left: 3px solid var(--accent-primary, #d4af37);
    border-radius: 0 8px 8px 0;
    color: var(--text-primary);
    font-size: 0.95rem;
    line-height: 1.6;
  }

  .book-blockquote p {
    margin: 0 0 0.35rem 0;
  }

  .book-blockquote p:last-child {
    margin-bottom: 0;
  }

  /* Event Notification Card (EPIC-21 / REQ-UI-07) */
  .event-notification-card {
    background: linear-gradient(135deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0.8) 100%);
    border: 1px solid rgba(245, 158, 11, 0.3);
    border-left: 3px solid #f59e0b;
    border-radius: 8px;
    padding: 0.85rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }

  .event-notification-card.scheduled-event {
    border-color: rgba(245, 158, 11, 0.45);
    border-left: 3px solid #f59e0b;
    background: linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(15, 23, 42, 0.85) 100%);
  }

  .event-notification-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .event-icon {
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .event-title {
    font-size: 0.78rem;
    font-weight: 700;
    color: #f59e0b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex: 1;
  }

  .event-badge {
    font-size: 0.68rem;
    font-weight: 600;
    color: #fbbf24;
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.35);
    padding: 0.15rem 0.5rem;
    border-radius: 9999px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .event-notification-body {
    margin: 0;
    padding: 0;
  }

  .event-text {
    margin: 0;
    font-size: 0.88rem;
    line-height: 1.55;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, monospace);
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

  .thinking-container:hover {
    border-color: rgba(212, 175, 55, 0.35);
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

  /* Inline Compact Tool Badges */
  .inline-tools-container {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    margin-bottom: 0.85rem;
  }

  .inline-tool-badge {
    border-radius: 6px;
    border: 1px solid rgba(56, 189, 248, 0.25);
    background: rgba(14, 165, 233, 0.05);
    overflow: hidden;
  }

  .tool-badge-header {
    width: 100%;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.35rem 0.65rem;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
  }

  .tool-badge-header:hover {
    background: rgba(255, 255, 255, 0.03);
  }

  .tool-badge-left {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .tool-status-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    font-size: 0.68rem;
    font-weight: bold;
  }

  .tool-status-icon.success-icon {
    color: #38bdf8;
    background: rgba(56, 189, 248, 0.15);
  }

  .tool-status-icon.error-icon {
    color: #f87171;
    background: rgba(239, 68, 68, 0.15);
  }

  .tool-name {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .tool-id {
    font-size: 0.68rem;
    color: var(--text-muted);
  }

  .tool-badge-right {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .tool-chevron {
    display: inline-block;
    font-size: 0.75rem;
    transition: transform 0.2s ease;
  }

  .tool-chevron.rotated {
    transform: rotate(180deg);
  }

  .tool-badge-body {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid rgba(56, 189, 248, 0.15);
    background: rgba(0, 0, 0, 0.3);
  }

  .tool-args-label {
    font-size: 0.68rem;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-bottom: 0.2rem;
  }

  .tool-args-pre {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 200px;
    overflow-y: auto;
  }

  /* Tool Result Card */
  .tool-result-card {
    border-radius: 8px;
    border: 1px solid var(--border-color);
    background: rgba(0, 0, 0, 0.2);
    overflow: hidden;
  }

  .tool-result-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.45rem 0.75rem;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.02);
  }

  .tool-result-header:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .tool-result-header-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .tool-result-title {
    font-size: 0.8rem;
    color: var(--accent-cyan, #38bdf8);
  }

  .tool-budget-pill {
    font-size: 0.65rem;
    padding: 0.1rem 0.35rem;
    background: rgba(245, 158, 11, 0.15);
    color: var(--accent-warning, #fbbf24);
    border-radius: 4px;
    border: 1px solid rgba(245, 158, 11, 0.3);
  }

  .tool-result-header-right {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .tool-concise-summary {
    padding: 0.3rem 0.75rem 0.45rem 0.75rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .summary-path {
    color: var(--accent-primary, #d4af37);
  }

  .summary-meta {
    color: var(--text-muted);
  }

  .tool-result-body {
    padding: 0.6rem 0.85rem;
    border-top: 1px solid var(--border-subtle);
    background: rgba(0, 0, 0, 0.35);
    max-height: 300px;
    overflow-y: auto;
  }

  .tool-result-pre {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* Narrative Markdown Prose */
  .turn-narrative-prose {
    color: var(--text-primary);
    font-size: 0.98rem;
    line-height: 1.7;
  }

  :global(.markdown-content p) {
    margin: 0 0 1rem 0;
  }

  :global(.markdown-content p:last-child) {
    margin-bottom: 0;
  }

  :global(.markdown-content h1, .markdown-content h2, .markdown-content h3, .markdown-content h4) {
    color: var(--text-primary);
    margin: 1.25rem 0 0.6rem 0;
    font-weight: 700;
  }

  :global(.markdown-content h1) { font-size: 1.4rem; }
  :global(.markdown-content h2) { font-size: 1.2rem; }
  :global(.markdown-content h3) { font-size: 1.05rem; }

  :global(.markdown-content pre) {
    background: rgba(0, 0, 0, 0.45);
    border: 1px solid var(--border-color);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    overflow-x: auto;
    margin: 0.85rem 0;
    font-family: var(--font-mono, monospace);
    font-size: 0.82rem;
  }

  :global(.markdown-content code) {
    font-family: var(--font-mono, monospace);
    font-size: 0.85em;
    background: rgba(255, 255, 255, 0.08);
    padding: 0.15rem 0.35rem;
    border-radius: 4px;
    color: var(--accent-primary, #d4af37);
  }

  :global(.markdown-content pre code) {
    background: transparent;
    padding: 0;
    color: inherit;
  }

  :global(.markdown-content table) {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
    font-size: 0.85rem;
  }

  :global(.markdown-content th, .markdown-content td) {
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--border-color);
    text-align: left;
  }

  :global(.markdown-content th) {
    background: var(--bg-surface-elevated);
    font-weight: 600;
  }

  :global(.markdown-content ul, .markdown-content ol) {
    margin: 0.5rem 0 1rem 1.5rem;
    padding: 0;
  }

  :global(.markdown-content li) {
    margin-bottom: 0.35rem;
  }

  /* System Turn */
  .turn-system-prose {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    border: 1px solid var(--border-subtle);
    background: rgba(0, 0, 0, 0.2);
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .system-header {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--text-muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    font-weight: 600;
  }

  .system-body p {
    margin: 0;
    font-size: 0.85rem;
    color: var(--text-secondary);
    line-height: 1.5;
    /* Ticket 4154694: the directive is plain text seeded with meaningful line
       breaks and indentation; preserve them exactly like the inline editor's
       textarea and the Sent Context view instead of collapsing to one line. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* Inline History Message Editor (REQ-UI-04) */
  .inline-editor-wrap {
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 8px;
    background: var(--bg-surface-elevated, #1e293b);
    border: 1px solid var(--accent-primary, #d4af37);
    box-shadow: 0 0 0 1px rgba(212, 175, 55, 0.2);
  }

  .inline-edit-textarea {
    width: 100%;
    min-height: 80px;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-primary, #f8fafc);
    font-size: 0.95rem;
    line-height: 1.5;
    resize: none;
    font-family: inherit;
  }

  .inline-edit-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
    padding-top: 0.5rem;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .shortcut-tip {
    font-size: 0.72rem;
    color: var(--text-muted, #64748b);
  }

  .inline-edit-actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

  .btn-edit-action {
    padding: 0.25rem 0.65rem;
    font-size: 0.78rem;
    font-weight: 500;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-cancel {
    background: transparent;
    border: 1px solid var(--border-color, #475569);
    color: var(--text-secondary, #94a3b8);
  }

  .btn-cancel:hover {
    background: rgba(255, 255, 255, 0.05);
    color: var(--text-primary, #f8fafc);
  }

  .btn-save {
    background: var(--accent-primary, #d4af37);
    border: 1px solid var(--accent-primary, #d4af37);
    color: #0f172a;
    font-weight: 600;
  }

  .btn-save:hover:not(:disabled) {
    opacity: 0.9;
    transform: translateY(-1px);
  }

  .btn-save:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @keyframes chronicle-fade {
    from { opacity: 0; transform: translateY(3px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
