<script>
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';

  let { isOpen = false, onClose = () => {}, onclose = () => {} } = $props();

  let actionFeedback = $state('');

  function handleClose() {
    if (typeof onClose === 'function') onClose();
    if (typeof onclose === 'function') onclose();
  }

  function handleBackdropClick(e) {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  }

  let modalRef = $state(null);

  function handleKeydown(e) {
    if (e.key === 'Escape') {
      handleClose();
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

  function formatTimestamp(ts) {
    if (!ts) return 'Unknown date';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return String(ts);
      return d.toLocaleString();
    } catch (_) {
      return String(ts);
    }
  }

  function handleRestore(agentId, agentName) {
    try {
      const restored = sandboxStore.restoreAgent(agentId);
      actionFeedback = `Agent "${agentName || agentId}" restored to active roster.`;
      setTimeout(() => { actionFeedback = ''; }, 3000);
    } catch (err) {
      actionFeedback = `Failed to restore agent: ${err.message}`;
      setTimeout(() => { actionFeedback = ''; }, 4000);
    }
  }

  function handlePurge(agentId, agentName) {
    const ok = confirm(`Permanently purge agent "${agentName || agentId}"?\n\nThis will permanently delete the agent's memory, inboxes, private workspace files, and browser persistence.`);
    if (!ok) return;

    try {
      sandboxStore.purgeAgent(agentId);
      actionFeedback = `Agent "${agentName || agentId}" permanently purged.`;
      setTimeout(() => { actionFeedback = ''; }, 3000);
    } catch (err) {
      actionFeedback = `Failed to purge agent: ${err.message}`;
      setTimeout(() => { actionFeedback = ''; }, 4000);
    }
  }

  function handleEmptyRecycleBin() {
    if (sandboxStore.recycleBinCount === 0) return;
    const ok = confirm(`Empty the entire Recycle Bin?\n\nThis will permanently purge all ${sandboxStore.recycleBinCount} recycled agent(s) and cannot be undone.`);
    if (!ok) return;

    try {
      const count = sandboxStore.emptyRecycleBin();
      actionFeedback = `Purged ${count} agent(s) from Recycle Bin.`;
      setTimeout(() => { actionFeedback = ''; }, 3000);
    } catch (err) {
      actionFeedback = `Failed to empty recycle bin: ${err.message}`;
      setTimeout(() => { actionFeedback = ''; }, 4000);
    }
  }
</script>

{#if isOpen}
  <div
    class="modal-backdrop"
    role="presentation"
    tabindex="-1"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div
      bind:this={modalRef}
      class="recycle-modal glass-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="recycle-bin-title"
    >
      <!-- Modal Header -->
      <header class="modal-header">
        <div class="header-left">
          <div class="icon-chip">
            <svg class="icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              <line x1="10" y1="11" x2="10" y2="17"></line>
              <line x1="14" y1="11" x2="14" y2="17"></line>
            </svg>
          </div>
          <div>
            <div class="title-with-badge">
              <h2 id="recycle-bin-title" class="modal-title">Agent Recycle Bin</h2>
              <span class="badge-count font-mono">{sandboxStore.recycleBinCount}</span>
            </div>
            <p class="modal-sub">Soft-killed agents residing in the recycle bin pending restoration or permanent deletion</p>
          </div>
        </div>

        <div class="header-actions">
          <button
            type="button"
            class="btn-danger-subtle btn-sm"
            onclick={handleEmptyRecycleBin}
            disabled={sandboxStore.recycleBinCount === 0}
            title="Permanently purge all agents currently in recycle bin"
          >
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
            <span>Empty Recycle Bin</span>
          </button>

          <button
            type="button"
            class="btn-close"
            onclick={handleClose}
            aria-label="Close modal"
          >
            <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </header>

      <!-- Feedback Banner -->
      {#if actionFeedback}
        <div class="feedback-banner">
          <svg class="icon-svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
            <polyline points="22 4 12 14.01 9 11.01"></polyline>
          </svg>
          <span>{actionFeedback}</span>
        </div>
      {/if}

      <!-- Modal Body -->
      <div class="modal-body">
        {#if sandboxStore.recycleBin.length === 0}
          <div class="empty-state">
            <div class="empty-icon-wrap">
              <svg class="icon-svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </div>
            <h3 class="empty-title">Recycle Bin is Empty</h3>
            <p class="empty-desc">
              No soft-killed agents currently reside in the recycle bin. When an agent is terminated via the Inspector or API, it will safely appear here with its full conversation history preserved until you restore or permanently delete it.
            </p>
          </div>
        {:else}
          <div class="recycled-agent-list">
            {#each sandboxStore.recycleBin as agent (agent.id)}
              <div class="recycled-card glass-panel">
                <div class="card-main">
                  <div class="card-top-row">
                    <div class="card-title-group">
                      <span class="agent-name">{agent.name || agent.id}</span>
                      <span class="agent-id-pill font-mono">{agent.id}</span>
                      <span class="state-recycled-chip font-mono">RECYCLED</span>
                    </div>

                    <div class="card-top-meta">
                      <span class="turns-pill font-mono">{agent.turnCount || 0} turns</span>
                    </div>
                  </div>

                  {#if agent.config?.role}
                    <div class="agent-role-row">
                      <span class="role-label">Role:</span>
                      <span class="role-text">{agent.config.role}</span>
                    </div>
                  {/if}

                  {#if agent.config?.systemPrompt}
                    <div class="system-prompt-preview">
                      <span class="prompt-label">Prompt Preview:</span>
                      <p class="prompt-text font-mono">{agent.config.systemPrompt}</p>
                    </div>
                  {/if}

                  <div class="termination-meta-bar">
                    <div class="term-meta-item">
                      <span class="meta-label">Terminated:</span>
                      <span class="meta-val font-mono">{formatTimestamp(agent.recycledAt)}</span>
                    </div>
                    <div class="term-meta-item">
                      <span class="meta-label">Reason:</span>
                      <span class="meta-val reason-text">{agent.recycleReason || agent.stateDetail || 'Terminated by user'}</span>
                    </div>
                  </div>
                </div>

                <div class="card-actions">
                  <button
                    type="button"
                    class="btn-restore"
                    onclick={() => handleRestore(agent.id, agent.name)}
                    title="Restore agent back into active studio roster"
                  >
                    <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
                      <path d="M3 3v5h5"></path>
                    </svg>
                    <span>Restore Agent</span>
                  </button>

                  <button
                    type="button"
                    class="btn-purge font-mono"
                    onclick={() => handlePurge(agent.id, agent.name)}
                    title="Permanently obliterate this agent from memory and storage"
                  >
                    <svg class="icon-svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="3 6 5 6 21 6"></polyline>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    </svg>
                    <span>Delete Permanently</span>
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Modal Footer -->
      <footer class="modal-footer">
        <div class="footer-summary">
          <span class="summary-text">
            {sandboxStore.recycleBinCount} recycled agent{sandboxStore.recycleBinCount === 1 ? '' : 's'} in bin
          </span>
        </div>
        <button type="button" class="btn-secondary" onclick={handleClose}>
          Close
        </button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(10, 12, 16, 0.82);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
    animation: fade-in 0.15s ease-out;
  }

  .recycle-modal {
    width: 100%;
    max-width: 760px;
    max-height: 88vh;
    background: var(--bg-secondary, #16181a);
    border: 1px solid var(--border-color, #272a30);
    border-radius: 12px;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.55);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: modal-pop 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1.1rem 1.4rem;
    border-bottom: 1px solid var(--border-color, #272a30);
    background: var(--bg-surface, #1e2024);
    gap: 1rem;
    flex-wrap: wrap;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 0.85rem;
  }

  .icon-chip {
    width: 38px;
    height: 38px;
    border-radius: 8px;
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.35);
    color: var(--accent-warning, #f59e0b);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .title-with-badge {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .modal-title {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text-primary, #ffffff);
    margin: 0;
  }

  .badge-count {
    font-size: 0.75rem;
    font-weight: 700;
    background: rgba(245, 158, 11, 0.2);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.35);
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
  }

  .modal-sub {
    font-size: 0.78rem;
    color: var(--text-secondary, #94a3b8);
    margin: 0.15rem 0 0 0;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .btn-close {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary, #94a3b8);
    width: 32px;
    height: 32px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-close:hover {
    background: var(--bg-surface-hover, #2a2d34);
    color: var(--text-primary, #ffffff);
    border-color: var(--border-color, #272a30);
  }

  .feedback-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1.4rem;
    background: rgba(16, 185, 129, 0.12);
    border-bottom: 1px solid rgba(16, 185, 129, 0.3);
    color: #34d399;
    font-size: 0.82rem;
    font-weight: 500;
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.25rem 1.4rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-height: 220px;
  }

  .empty-state {
    padding: 3rem 1.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    margin: auto;
    max-width: 480px;
  }

  .empty-icon-wrap {
    width: 68px;
    height: 68px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted, #64748b);
    margin-bottom: 0.35rem;
  }

  .empty-title {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--text-primary, #ffffff);
    margin: 0;
  }

  .empty-desc {
    font-size: 0.82rem;
    color: var(--text-secondary, #94a3b8);
    line-height: 1.55;
    margin: 0;
  }

  .recycled-agent-list {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }

  .recycled-card {
    background: var(--bg-surface, #1a1d22);
    border: 1px solid var(--border-color, #272a30);
    border-radius: 8px;
    padding: 1rem 1.15rem;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
    transition: all 0.15s ease;
  }

  .recycled-card:hover {
    border-color: rgba(245, 158, 11, 0.4);
    background: var(--bg-surface-elevated, #20242a);
  }

  .card-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    min-width: 0;
  }

  .card-top-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .card-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .agent-name {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--text-primary, #ffffff);
  }

  .agent-id-pill {
    font-size: 0.72rem;
    background: var(--bg-base, #101216);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
    padding: 0.1rem 0.45rem;
    border-radius: 4px;
    color: var(--text-secondary, #94a3b8);
  }

  .state-recycled-chip {
    font-size: 0.65rem;
    font-weight: 700;
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.35);
    color: #f59e0b;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    letter-spacing: 0.03em;
  }

  .card-top-meta {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .turns-pill {
    font-size: 0.72rem;
    color: var(--text-muted, #64748b);
    background: var(--bg-base, #101216);
    padding: 0.15rem 0.45rem;
    border-radius: 4px;
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.08));
  }

  .agent-role-row {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.8rem;
  }

  .role-label {
    color: var(--text-muted, #64748b);
    font-weight: 500;
  }

  .role-text {
    color: var(--text-secondary, #94a3b8);
  }

  .system-prompt-preview {
    background: var(--bg-base, #101216);
    border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
    border-radius: 6px;
    padding: 0.45rem 0.65rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .prompt-label {
    font-size: 0.68rem;
    color: var(--text-muted, #64748b);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }

  .prompt-text {
    font-size: 0.75rem;
    color: var(--text-secondary, #94a3b8);
    margin: 0;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .termination-meta-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding-top: 0.35rem;
    font-size: 0.75rem;
    border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.06));
    flex-wrap: wrap;
  }

  .term-meta-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .meta-label {
    color: var(--text-muted, #64748b);
    font-weight: 500;
  }

  .meta-val {
    color: var(--text-secondary, #94a3b8);
  }

  .reason-text {
    color: #fbbf24;
    font-style: italic;
  }

  .card-actions {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    flex-shrink: 0;
    align-self: center;
  }

  .btn-restore {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    background: rgba(16, 185, 129, 0.15);
    border: 1px solid rgba(16, 185, 129, 0.4);
    color: #34d399;
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .btn-restore:hover {
    background: rgba(16, 185, 129, 0.25);
    border-color: rgba(16, 185, 129, 0.6);
    color: #6ee7b7;
    transform: translateY(-1px);
  }

  .btn-purge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #f87171;
    padding: 0.35rem 0.75rem;
    border-radius: 6px;
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    white-space: nowrap;
  }

  .btn-purge:hover {
    background: rgba(239, 68, 68, 0.2);
    border-color: rgba(239, 68, 68, 0.55);
    color: #fca5a5;
  }

  .btn-danger-subtle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: rgba(239, 68, 68, 0.12);
    border: 1px solid rgba(239, 68, 68, 0.35);
    color: #f87171;
    padding: 0.35rem 0.7rem;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-danger-subtle:hover:not(:disabled) {
    background: rgba(239, 68, 68, 0.22);
    border-color: rgba(239, 68, 68, 0.6);
    color: #fca5a5;
  }

  .btn-danger-subtle:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .modal-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.85rem 1.4rem;
    border-top: 1px solid var(--border-color, #272a30);
    background: var(--bg-surface, #1e2024);
  }

  .footer-summary {
    font-size: 0.78rem;
    color: var(--text-muted, #64748b);
  }

  .btn-secondary {
    background: var(--bg-surface, #1e2024);
    border: 1px solid var(--border-color, #272a30);
    color: var(--text-primary, #ffffff);
    padding: 0.45rem 1rem;
    border-radius: 6px;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-secondary:hover {
    background: var(--bg-surface-hover, #2a2d34);
    border-color: var(--border-hover, #3f444e);
  }

  @keyframes modal-pop {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(8px);
    }
    to {
      opacity: 1;
      transform: scale(1) translateY(0);
    }
  }

  @keyframes fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (max-width: 640px) {
    .recycled-card {
      flex-direction: column;
      align-items: stretch;
    }

    .card-actions {
      flex-direction: row;
      justify-content: flex-end;
    }
  }
</style>
