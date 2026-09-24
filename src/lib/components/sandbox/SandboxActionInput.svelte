<script>
  import { estimateTokens } from './estimateTokens.ts';
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';

  let {
    agentId = null,
    disabled = false,
    isLoading = false,
    placeholder = '',
    hasInterruptedTurn = false,
    hasHistory = false,
    onSend = async () => {},
    onCancel = () => {},
    onResend = async () => {},
    onUndo = () => {}
  } = $props();

  let promptText = $state('');
  let activeMode = $state('directive'); // 'directive' | 'system' | 'injection'
  let textareaRef = $state(null);

  // Sync draft reactively with sandboxStore per-agent draft buffer
  $effect(() => {
    if (agentId) {
      const draft = sandboxStore.getAgentDraft(agentId);
      if (draft !== promptText) {
        promptText = draft;
      }
    } else {
      promptText = '';
    }
  });

  function handleInput(e) {
    promptText = e.target.value;
    if (agentId) {
      sandboxStore.setAgentDraft(agentId, e.target.value);
    }
    autoResize();
  }

  const ACTION_MODES = [
    {
      id: 'directive',
      label: 'Directive',
      description: 'Standard user prompt / task instruction',
      placeholder: 'Instruct the agent to execute a task or tool action... (Enter for newline, Ctrl+Enter to send)'
    },
    {
      id: 'system',
      label: 'System Instruction',
      description: 'Inject runtime directive or temporary prompt constraint',
      placeholder: 'Inject high-priority system instruction or prompt override for this turn...'
    },
    {
      id: 'injection',
      label: 'Message Injection',
      description: 'Simulate inter-agent event payload or external message',
      placeholder: 'Simulate inter-agent event payload or external message injection...'
    }
  ];

  let estimatedTokens = $derived(estimateTokens(promptText));

  let dynamicPlaceholder = $derived.by(() => {
    if (placeholder) return placeholder;
    const current = ACTION_MODES.find(m => m.id === activeMode);
    return current ? current.placeholder : 'What would you like the agent to do?';
  });

  // Reactive agent snapshot for the failure surface (QA-012). `lastError` is
  // redacted at the store boundary and survives reloads via persistence, so a
  // failed turn keeps its diagnostic reason instead of a generic notice.
  // Defect 7d2c314: the caller passes the canonical identity key, so resolve
  // it exactly first and keep a unique bare-id fallback for legacy callers.
  let inspectedAgent = $derived.by(() => {
    const ref = agentId || sandboxStore.selectedAgent?.identityKey;
    if (!ref) return null;
    const exact = sandboxStore.agents.find(a => a.identityKey === ref);
    if (exact) return exact;
    const matches = sandboxStore.agents.filter(a => a.id === ref);
    return matches.length === 1 ? matches[0] : null;
  });

  let failureReason = $derived.by(() => {
    if (!inspectedAgent || !inspectedAgent.lastError) return null;
    return inspectedAgent.lastError;
  });

  function handleUndoToEdit() {
    const res = onUndo();
    if (res?.undoneUserContent) {
      promptText = res.undoneUserContent;
      if (agentId) sandboxStore.setAgentDraft(agentId, promptText);
    }
  }

  function handleDismissFailure() {
    if (!inspectedAgent) return;
    // Defect 7d2c314: clear through the exact registration key.
    sandboxStore.clearAgentLastError(inspectedAgent.identityKey);
  }

  function autoResize() {
    if (!textareaRef) return;
    textareaRef.style.height = 'auto';
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 220) + 'px';
  }

  function handleKeydown(e) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
      return;
    }

    // Ctrl+Z to undo turn when input empty
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !promptText.trim()) {
      if (hasInterruptedTurn || hasHistory || isLoading) {
        e.preventDefault();
        const res = onUndo();
        if (res?.undoneUserContent) {
          promptText = res.undoneUserContent;
          if (agentId) sandboxStore.setAgentDraft(agentId, promptText);
        }
        return;
      }
    }

    // Shift+Enter or Ctrl+R to resend when interrupted and empty
    if (
      ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') ||
      (e.key === 'Enter' && e.shiftKey && !promptText.trim())
    ) {
      if (hasInterruptedTurn && !isLoading) {
        e.preventDefault();
        onResend();
        return;
      }
    }
  }

  async function handleSend() {
    const textToSend = promptText.trim();
    if (!textToSend || isLoading || disabled) return;

    const mode = activeMode;
    promptText = '';
    if (agentId) {
      sandboxStore.clearAgentDraft(agentId);
    }
    if (textareaRef) {
      textareaRef.style.height = 'auto';
    }

    await onSend(textToSend, { mode });
  }
</script>

<div class="sandbox-action-input-wrapper glass-panel">
  <!-- Top Category Selection Bar -->
  <div class="controls-top-bar">
    <div class="category-tabs" role="tablist">
      {#each ACTION_MODES as mode (mode.id)}
        <button
          type="button"
          class="category-btn"
          class:active={activeMode === mode.id}
          onclick={() => activeMode = mode.id}
          disabled={isLoading || disabled}
          title={mode.description}
        >
          <span class="cat-label">{mode.label}</span>
        </button>
      {/each}
    </div>
  </div>

  <!-- Failure / Interrupted Notice Banner (QA-012 unified error surface) -->
  {#if failureReason && !isLoading}
    <div class="failure-notice-banner glass-panel" role="alert">
      <div class="failure-notice-left">
        <svg class="icon-svg failure-notice-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div class="failure-notice-copy">
          <span class="failure-notice-title">Execution Error Encountered</span>
          <span class="failure-notice-reason" title={failureReason}>{failureReason}</span>
        </div>
      </div>
      <div class="failure-notice-actions">
        <button
          type="button"
          class="btn-xs btn-resend-inline"
          onclick={onResend}
          title="Retry the failed turn (Ctrl+R or Shift+Enter)"
        >
          <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          <span>Retry Turn</span>
        </button>
        <button
          type="button"
          class="btn-xs btn-undo-inline"
          onclick={handleUndoToEdit}
          title="Undo the failed turn and restore the prompt to the editor (Ctrl+Z)"
        >
          <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
          <span>Undo Turn & Edit Prompt</span>
        </button>
        <button
          type="button"
          class="btn-xs btn-dismiss-inline"
          onclick={handleDismissFailure}
          title="Dismiss error"
        >
          <span>Dismiss</span>
        </button>
      </div>
    </div>
  {:else if hasInterruptedTurn && !isLoading}
    <div class="interrupted-notice-banner glass-panel">
      <div class="interrupted-notice-left">
        <span class="interrupted-pulse-indicator"></span>
        <span class="interrupted-notice-text">Previous agent turn was interrupted.</span>
      </div>
      <div class="interrupted-notice-actions">
        <button 
          type="button" 
          class="btn-xs btn-resend-inline" 
          onclick={onResend}
          title="Resend interrupted turn (Ctrl+R or Shift+Enter)"
        >
          <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          <span>Resend</span>
        </button>
        <button 
          type="button" 
          class="btn-xs btn-undo-inline" 
          onclick={handleUndoToEdit}
          title="Undo turn and restore prompt to editor (Ctrl+Z)"
        >
          <svg class="icon-svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
          <span>Undo to Edit</span>
        </button>
      </div>
    </div>
  {/if}

  <!-- Main Text Input Form -->
  <div class="input-form">
    <div class="textarea-container">
      <textarea
        bind:this={textareaRef}
        value={promptText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        placeholder={dynamicPlaceholder}
        rows="2"
        disabled={isLoading || disabled}
        class="action-textarea"
      ></textarea>

      <div class="input-bottom-bar">
        <span class="hotkey-tip">
          {#if failureReason && !isLoading}
            Turn failed: Shift+Enter or click Retry Turn • Ctrl+Z to undo
          {:else if hasInterruptedTurn && !isLoading}
            Turn interrupted: Shift+Enter or click Resend • Ctrl+Z to undo
          {:else}
            Ctrl+Enter to send • Enter for new line
          {/if}
        </span>
        <span class="token-counter" class:token-warning={estimatedTokens > 200}>
          {estimatedTokens} tokens
        </span>
      </div>
    </div>

    <!-- Action Trigger Buttons -->
    <div class="action-buttons">
      {#if isLoading}
        <button
          type="button"
          class="btn-stop"
          onclick={onCancel}
          title="Halt active agent turn"
        >
          <span>Stop</span>
        </button>
        <button
          type="button"
          class="btn-secondary btn-undo-in-flight"
          onclick={() => {
            const res = onUndo();
            if (res?.undoneUserContent) {
              promptText = res.undoneUserContent;
              if (agentId) sandboxStore.setAgentDraft(agentId, promptText);
            }
          }}
          title="Halt turn and undo prompt to editor"
        >
          <span>Undo</span>
        </button>
      {:else if hasInterruptedTurn && !promptText.trim()}
        <button
          type="button"
          class="btn-primary btn-resend-action"
          onclick={onResend}
          title={failureReason ? 'Retry the failed turn (Ctrl+R or Shift+Enter)' : 'Resend interrupted turn (Ctrl+R or Shift+Enter)'}
        >
          <svg class="icon-svg resend-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
          <span>{failureReason ? 'Retry Turn' : 'Resend'}</span>
        </button>
        <button
          type="button"
          class="btn-secondary btn-undo-interrupted"
          onclick={() => {
            const res = onUndo();
            if (res?.undoneUserContent) promptText = res.undoneUserContent;
          }}
          title="Undo interrupted turn to edit prompt (Ctrl+Z)"
        >
          <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
          <span>Undo</span>
        </button>
      {:else}
        {#if hasHistory}
          <button
            type="button"
            class="btn-secondary btn-undo-turn"
            onclick={() => {
              const res = onUndo();
              if (res?.undoneUserContent) promptText = res.undoneUserContent;
            }}
            title="Undo last completed turn (Ctrl+Z)"
          >
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>
            <span>Undo Turn</span>
          </button>
        {/if}
        <button
          type="button"
          class="btn-primary btn-submit-action"
          onclick={handleSend}
          disabled={!promptText.trim() || disabled}
          title="Send turn (Ctrl+Enter)"
        >
          <span>Send</span>
          <svg class="icon-svg send-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>
          </svg>
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .sandbox-action-input-wrapper {
    padding: 0.85rem 1.5rem;
    border-top: 1px solid var(--border-color);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    z-index: 20;
    flex-shrink: 0;
  }

  .controls-top-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.6rem;
  }

  .category-tabs {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .category-tabs::-webkit-scrollbar {
    display: none;
  }

  .category-btn {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.3rem 0.65rem;
    border-radius: 6px;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    font-size: 0.78rem;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }

  .category-btn:hover:not(:disabled) {
    background: var(--bg-surface-hover);
    color: var(--text-primary);
  }

  .category-btn.active {
    background: var(--accent-primary, #d4af37);
    border-color: var(--accent-primary, #d4af37);
    color: var(--bg-base);
    font-weight: 600;
  }

  .input-form {
    display: flex;
    gap: 0.65rem;
    align-items: flex-end;
    width: 100%;
  }

  .textarea-container {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 0.55rem 0.8rem;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .textarea-container:focus-within {
    border-color: var(--accent-primary, #d4af37);
    box-shadow: 0 0 0 1px var(--accent-primary, #d4af37);
  }

  .action-textarea {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-size: 0.95rem;
    line-height: 1.5;
    resize: none;
    min-height: 44px;
    max-height: 200px;
    font-family: var(--font-main);
  }

  .action-textarea:focus {
    outline: none;
  }

  .input-bottom-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-top: 0.35rem;
    border-top: 1px solid var(--border-subtle);
    gap: 0.5rem;
  }

  .hotkey-tip {
    font-size: 0.7rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .token-counter {
    font-size: 0.7rem;
    color: var(--text-muted);
    font-family: var(--font-mono);
    white-space: nowrap;
    margin-left: auto;
  }

  .token-warning {
    color: var(--accent-warning);
  }

  .failure-notice-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.35);
    gap: 0.6rem;
    animation: fadeIn 0.2s ease;
  }

  .failure-notice-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .failure-notice-icon {
    color: #f87171;
    flex-shrink: 0;
  }

  .failure-notice-copy {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }

  .failure-notice-title {
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #f87171;
  }

  .failure-notice-reason {
    font-size: 0.78rem;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .failure-notice-actions {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .btn-dismiss-inline {
    background: transparent;
    color: var(--text-muted, #94a3b8);
    border: 1px solid var(--border-color);
  }

  .btn-dismiss-inline:hover {
    background: var(--bg-surface-hover);
    color: var(--text-primary);
  }

  .interrupted-notice-banner {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    background: rgba(245, 158, 11, 0.08);
    border: 1px solid rgba(245, 158, 11, 0.3);
    gap: 0.6rem;
    animation: fadeIn 0.2s ease;
  }

  .interrupted-notice-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .interrupted-pulse-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #f59e0b;
    box-shadow: 0 0 8px rgba(245, 158, 11, 0.8);
    animation: pulseNotice 1.5s infinite;
    flex-shrink: 0;
  }

  @keyframes pulseNotice {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.3); opacity: 0.6; }
  }

  .interrupted-notice-text {
    font-size: 0.78rem;
    color: var(--text-secondary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .interrupted-notice-actions {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
  }

  .btn-xs {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.25rem 0.55rem;
    border-radius: 4px;
    font-size: 0.72rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-resend-inline {
    background: var(--accent-primary, #d4af37);
    color: #111;
    border: 1px solid var(--accent-primary, #d4af37);
  }

  .btn-resend-inline:hover {
    filter: brightness(1.1);
  }

  .btn-undo-inline {
    background: var(--bg-surface);
    color: var(--text-secondary);
    border: 1px solid var(--border-color);
  }

  .btn-undo-inline:hover {
    background: var(--bg-surface-hover);
    color: var(--text-primary);
  }

  .action-buttons {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }

  .btn-submit-action {
    padding: 0.65rem 1.15rem;
    height: 44px;
    gap: 0.45rem;
    border-radius: 6px;
    font-weight: 600;
  }

  .btn-resend-action {
    background: var(--accent-primary, #d4af37);
    color: #111;
    padding: 0.65rem 1.1rem;
    height: 44px;
    gap: 0.45rem;
    border-radius: 6px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    box-shadow: 0 2px 8px rgba(212, 175, 55, 0.25);
  }

  .btn-resend-action:hover {
    filter: brightness(1.1);
    transform: translateY(-1px);
  }

  .btn-undo-interrupted,
  .btn-undo-in-flight,
  .btn-undo-turn {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    padding: 0.65rem 0.95rem;
    height: 44px;
    gap: 0.35rem;
    border-radius: 6px;
    font-weight: 500;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
    font-size: 0.85rem;
  }

  .btn-undo-interrupted:hover,
  .btn-undo-in-flight:hover,
  .btn-undo-turn:hover {
    background: rgba(245, 158, 11, 0.1);
    color: #fbbf24;
    border-color: rgba(245, 158, 11, 0.4);
  }

  .btn-stop {
    background: var(--accent-danger-subtle);
    border: 1px solid var(--accent-danger-border);
    color: #fca5a5;
    padding: 0.65rem 1.1rem;
    height: 44px;
    border-radius: 6px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    font-size: 0.85rem;
  }

  .btn-stop:hover {
    background: var(--accent-danger);
    color: white;
  }

  .send-svg,
  .resend-svg {
    opacity: 0.9;
  }

  @media (max-width: 768px) {
    .sandbox-action-input-wrapper {
      padding: 0.6rem 0.75rem;
      padding-bottom: calc(0.6rem + env(safe-area-inset-bottom, 0px));
    }
    .hotkey-tip {
      display: none;
    }
  }
</style>
