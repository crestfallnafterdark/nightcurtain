<script>
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';

  let senderFilter = $state('');
  let recipientFilter = $state('');
  let typeFilter = $state('');
  let searchKeyword = $state('');
  let autoScroll = $state(true);

  // Manual message sender form
  let msgFrom = $state('human');
  let msgTo = $state('all');
  let msgContent = $state('');
  let msgPriority = $state('NORMAL');
  let sendError = $state('');

  // Messages list from store
  let allMessages = $derived(sandboxStore.messages);

  // Derived filtered message stream
  let filteredMessages = $derived.by(() => {
    let list = [...allMessages];
    const kw = searchKeyword.trim().toLowerCase();

    if (senderFilter) {
      list = list.filter(m => m.from === senderFilter);
    }
    if (recipientFilter) {
      list = list.filter(m => m.to === recipientFilter);
    }
    if (typeFilter) {
      if (typeFilter === 'scheduled_timer') {
        list = list.filter(m => m.type === 'scheduled_timer' || m.metadata?.category === 'scheduled_timer' || m.metadata?.type === 'scheduled_timer');
      } else if (typeFilter === 'standard') {
        list = list.filter(m => !(m.type === 'scheduled_timer' || m.metadata?.category === 'scheduled_timer' || m.metadata?.type === 'scheduled_timer'));
      }
    }
    if (kw) {
      list = list.filter(m =>
        (m.content && m.content.toLowerCase().includes(kw)) ||
        (m.from && m.from.toLowerCase().includes(kw)) ||
        (m.to && m.to.toLowerCase().includes(kw))
      );
    }

    return list;
  });

  // Unique senders and recipients for filter dropdowns
  let uniqueSenders = $derived.by(() => {
    const set = new Set(['human']);
    for (const a of sandboxStore.agents) set.add(a.id);
    for (const m of allMessages) set.add(m.from);
    return Array.from(set);
  });

  let uniqueRecipients = $derived.by(() => {
    const set = new Set(['all']);
    for (const a of sandboxStore.agents) set.add(a.id);
    for (const m of allMessages) set.add(m.to);
    return Array.from(set);
  });

  function handleSendMessage(e) {
    if (e) e.preventDefault();
    sendError = '';

    const content = msgContent.trim();
    if (!content) {
      sendError = 'Message content cannot be empty';
      return;
    }

    try {
      /** @type {Record<string, unknown>} */
      const metadata = {};
      if (msgPriority !== 'NORMAL') {
        metadata.priority = msgPriority;
      }

      sandboxStore.sendMessage(msgFrom.trim() || 'human', msgTo.trim() || 'all', content, metadata);
      msgContent = '';
    } catch (err) {
      sendError = err.message || 'Failed to dispatch message';
    }
  }

  function formatTime(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatTimestamp(timestamp) {
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return String(timestamp);
    return date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function formatJsonPayload(text) {
    try {
      const parsed = JSON.parse(text);
      return JSON.stringify(parsed, null, 2);
    } catch (_) {
      return text;
    }
  }

  function isJson(text) {
    if (!text || typeof text !== 'string') return false;
    const trimmed = text.trim();
    return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
  }
</script>

<div class="bus-viewer-container">
  <!-- Top Filter & Search Toolbar -->
  <div class="bus-toolbar glass-panel">
    <div class="filter-controls">
      <div class="filter-item">
        <label for="sender-filter" class="filter-label">Sender:</label>
        <select id="sender-filter" bind:value={senderFilter} class="filter-select">
          <option value="">All Senders</option>
          {#each uniqueSenders as s}
            <option value={s}>{s}</option>
          {/each}
        </select>
      </div>

      <div class="filter-item">
        <label for="recipient-filter" class="filter-label">Recipient:</label>
        <select id="recipient-filter" bind:value={recipientFilter} class="filter-select">
          <option value="">All Recipients</option>
          {#each uniqueRecipients as r}
            <option value={r}>{r}</option>
          {/each}
        </select>
      </div>

      <div class="filter-item">
        <label for="type-filter" class="filter-label">Type:</label>
        <select id="type-filter" bind:value={typeFilter} class="filter-select">
          <option value="">All Types</option>
          <option value="standard">Standard Messages</option>
          <option value="scheduled_timer">Scheduled Timers</option>
        </select>
      </div>

      <div class="search-box">
        <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          type="text"
          bind:value={searchKeyword}
          placeholder="Filter messages..."
          class="search-input"
        />
        {#if searchKeyword}
          <button type="button" class="btn-clear" onclick={() => searchKeyword = ''}>✕</button>
        {/if}
      </div>
    </div>

    <div class="bus-meta-badge font-mono">
      <span>{filteredMessages.length} / {allMessages.length} Messages</span>
    </div>
  </div>

  <div class="bus-body-layout">
    <!-- Left: Live Message Stream Feed -->
    <div class="stream-panel glass-panel">
      <div class="panel-header">
        <h3 class="panel-title">
          <span class="live-dot"></span>
          <span>Live Messaging Stream</span>
        </h3>
      </div>

      {#if filteredMessages.length === 0}
        <div class="empty-stream">
          <svg class="icon-svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          </svg>
          <p>No messages matching active filters.</p>
        </div>
      {:else}
        <div class="messages-feed">
          {#each filteredMessages as msg (msg.id)}
            <div
              class="message-card"
              class:broadcast={msg.to === 'all'}
              class:scheduled-timer={msg.type === 'scheduled_timer' || msg.metadata?.category === 'scheduled_timer'}
            >
              <!-- Envelope Subheader / Metadata -->
              <div class="msg-envelope-line font-mono">
                <span class="envelope-id" title="Unique Message ID">#{msg.messageId || msg.id}</span>
                {#if msg.type === 'scheduled_timer' || msg.metadata?.category === 'scheduled_timer'}
                  <span class="scheduled-timer-pill" title="Scheduled Timer Event Delivery">
                    🕒 Scheduled Timer #{msg.metadata?.timerId || ''}
                  </span>
                {/if}
                {#if msg.metadata?.invocationId || ('invocationId' in msg && msg.invocationId)}
                  <span class="invocation-badge" title="Asynchronous Inter-Agent Invocation ID">
                    ⚡ inv: {msg.metadata?.invocationId || ('invocationId' in msg && msg.invocationId)}
                  </span>
                {/if}
              </div>

              <div class="msg-header">
                <div class="routing-badges">
                  <span
                    class="sender-badge font-mono"
                    class:system-scheduler-pill={msg.from === 'system:scheduler'}
                    title="Sender: {msg.from}"
                  >
                    {#if msg.from === 'system:scheduler'}
                      ⏱️ {msg.from}
                    {:else}
                      {msg.from}
                    {/if}
                  </span>
                  <span class="arrow-indicator">➔</span>
                  <span class="recipient-badge font-mono" class:all={msg.to === 'all'} title="Recipient: {msg.to}">{msg.to}</span>
                  {#if msg.replyTo}
                    <span class="reply-badge font-mono" title="Reply-To Address">↩ {msg.replyTo}</span>
                  {/if}
                </div>

                <div class="msg-meta font-mono">
                  {#if msg.metadata && msg.metadata.priority}
                    <span class="priority-pill priority-{typeof msg.metadata.priority === 'string' ? msg.metadata.priority.toLowerCase() : ''}">
                      {msg.metadata.priority}
                    </span>
                  {/if}
                  <span class="msg-time">{formatTime(msg.timestamp)}</span>
                </div>
              </div>

              <div class="msg-content">
                {#if isJson(msg.content)}
                  <pre class="json-content font-mono">{formatJsonPayload(msg.content)}</pre>
                {:else}
                  <p class="text-content">{msg.content}</p>
                {/if}
              </div>

              {#if msg.metadata && Object.keys(msg.metadata).length > 0}
                <div class="msg-metadata-tags">
                  {#each Object.entries(msg.metadata) as [k, v]}
                    {#if k !== 'priority' && k !== 'invocationId' && k !== 'type'}
                      <span class="meta-tag font-mono">
                        {k}: {k === 'scheduledAt' || k === 'triggeredAt' ? formatTimestamp(v) : String(v)}
                      </span>
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Right: Manual Message Injection Form -->
    <div class="injection-panel glass-panel">
      <div class="panel-header">
        <h3 class="panel-title">
          <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          <span>Manual Message Injection</span>
        </h3>
      </div>

      {#if sendError}
        <div class="error-banner font-mono">{sendError}</div>
      {/if}

      <form class="injection-form" onsubmit={handleSendMessage}>
        <div class="form-row">
          <div class="form-group">
            <label for="inject-from">From:</label>
            <input
              id="inject-from"
              type="text"
              bind:value={msgFrom}
              placeholder="e.g. human, director"
              class="input-field font-mono"
              required
            />
          </div>

          <div class="form-group">
            <label for="inject-to">To:</label>
            <input
              id="inject-to"
              type="text"
              bind:value={msgTo}
              placeholder="e.g. all, agent-scout"
              class="input-field font-mono"
              required
            />
          </div>
        </div>

        <div class="form-group">
          <label for="inject-priority">Priority Level:</label>
          <select id="inject-priority" bind:value={msgPriority} class="select-field">
            <option value="NORMAL">Normal</option>
            <option value="HIGH">High Priority</option>
            <option value="URGENT">Urgent / Emergency</option>
          </select>
        </div>

        <div class="form-group">
          <label for="inject-content">Message Payload (Text or JSON):</label>
          <textarea
            id="inject-content"
            bind:value={msgContent}
            rows="5"
            placeholder="Type directive, query, or JSON object to route through bus..."
            class="textarea-field font-mono"
            required
          ></textarea>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn-primary">
            <span>Send Message</span>
          </button>
        </div>
      </form>
    </div>
  </div>
</div>

<style>
  .bus-viewer-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 1.25rem;
    gap: 1.25rem;
    overflow-y: auto;
  }

  .bus-toolbar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    flex-wrap: wrap;
    gap: 0.75rem;
  }

  .filter-controls {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    flex-wrap: wrap;
  }

  .filter-item {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .filter-label {
    font-size: 0.75rem;
    color: var(--text-muted);
    font-weight: 600;
  }

  .filter-select {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
    font-size: 0.8rem;
  }

  .search-box {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
  }

  .search-input {
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 0.8rem;
    width: 140px;
  }

  .search-input:focus {
    outline: none;
  }

  .btn-clear {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.75rem;
  }

  .bus-meta-badge {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .bus-body-layout {
    display: grid;
    grid-template-columns: 1fr 380px;
    gap: 1.25rem;
    align-items: start;
  }

  .stream-panel, .injection-panel {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .panel-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }

  .live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent-success);
    box-shadow: 0 0 6px var(--accent-success);
  }

  .empty-stream {
    padding: 3rem 1rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.88rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
  }

  .messages-feed {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-height: 700px;
    overflow-y: auto;
  }

  .message-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: border-color 0.15s;
  }

  .message-card.broadcast {
    border-left: 3px solid var(--accent-primary);
  }

  .message-card.scheduled-timer {
    border-left: 3px solid #f59e0b;
    background: linear-gradient(135deg, var(--bg-surface) 0%, rgba(245, 158, 11, 0.05) 100%);
  }

  .msg-envelope-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.7rem;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
    padding-bottom: 0.35rem;
    margin-bottom: 0.1rem;
    flex-wrap: wrap;
  }

  .envelope-id {
    color: var(--text-secondary);
    background: var(--bg-base);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
  }

  .invocation-badge {
    color: #a78bfa;
    background: rgba(139, 92, 246, 0.15);
    border: 1px solid rgba(139, 92, 246, 0.3);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-weight: 600;
  }

  .scheduled-timer-pill {
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.3);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
    font-weight: 600;
  }

  .reply-badge {
    font-size: 0.72rem;
    color: #c084fc;
    background: rgba(192, 132, 252, 0.1);
    border: 1px solid rgba(192, 132, 252, 0.25);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
  }

  .msg-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .routing-badges {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .sender-badge {
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    color: var(--accent-cyan);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
  }

  .sender-badge.system-scheduler-pill {
    color: #f59e0b;
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.12);
  }

  .arrow-indicator {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .recipient-badge {
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    color: var(--accent-primary);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
  }

  .recipient-badge.all {
    color: #e5c158;
    background: var(--accent-primary-subtle);
  }

  .msg-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .priority-pill {
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
    font-size: 0.65rem;
    font-weight: 700;
  }

  .priority-high {
    background: var(--accent-warning-subtle);
    color: var(--accent-warning);
    border: 1px solid var(--accent-warning-border);
  }

  .priority-urgent {
    background: var(--accent-danger-subtle);
    color: var(--accent-danger);
    border: 1px solid var(--accent-danger-border);
  }

  .msg-content {
    font-size: 0.88rem;
    line-height: 1.5;
    color: var(--text-primary);
  }

  .text-content {
    margin: 0;
    white-space: pre-wrap;
  }

  .json-content {
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    padding: 0.6rem;
    border-radius: 4px;
    font-size: 0.78rem;
    color: var(--text-story);
    overflow-x: auto;
  }

  .msg-metadata-tags {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding-top: 0.35rem;
    border-top: 1px solid var(--border-subtle);
  }

  .meta-tag {
    font-size: 0.68rem;
    background: var(--bg-base);
    color: var(--text-secondary);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
  }

  .injection-form {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .form-group label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .input-field, .textarea-field, .select-field {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.82rem;
  }

  .input-field:focus, .textarea-field:focus, .select-field:focus {
    outline: none;
    border-color: var(--border-focus);
  }

  .textarea-field {
    resize: vertical;
    line-height: 1.45;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
  }

  .error-banner {
    color: #f87171;
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    padding: 0.4rem 0.6rem;
    border-radius: 4px;
    font-size: 0.78rem;
  }

  @media (max-width: 900px) {
    .bus-body-layout {
      grid-template-columns: 1fr;
    }
  }
</style>
