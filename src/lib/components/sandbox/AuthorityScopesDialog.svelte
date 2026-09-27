<script>
  /**
   * "Authority scopes" dialog (redesign d7131dc): the single secondary surface
   * that holds all five meta-capability scope editors. It follows the Realm
   * Manager conventions — `.modal-backdrop` (click closes), `role="dialog"` /
   * `aria-modal` / `aria-labelledby`, Escape, a Tab focus trap, a footer
   * Close, and a fixed rail + one scrolling detail pane (master–detail), so
   * the settings card no longer grows five inline editors.
   *
   * Composition-root split: this component owns no store calls and no draft
   * state. The Agent Settings panel passes the live per-id rows (state, seeded
   * draft, summary, Save eligibility), the inline error map, and the callback
   * set; the dialog only renders and reports operator input. Focus returns to
   * the triggering “Edit scope” button via the panel's close handler.
   *
   * Styles live in `authorityScopeUi.css`, scoped under
   * `.authority-scopes-modal`.
   */
  import './authorityScopeUi.css';

  /**
   * One scoped-authority row projection consumed by the dialog (built by the
   * Agent Settings panel from the live registry state and the seeded draft).
   *
   * @typedef {object} AuthorityScopeDialogRow
   * @property {string} authority Exact `AUTHORITY_IDS` member.
   * @property {string} label Short display label.
   * @property {import('./authorityEditorHelpers.ts').AuthorityEditorClass} class Display/scope class.
   * @property {string} warning One-line high-impact warning (empty when none).
   * @property {boolean} enabled Whether the selected agent holds the id.
   * @property {import('../../sandbox/realmCatalog/index.ts').AuthorityScopeRecord | null} scope Held scope (`null` = the id default).
   * @property {{ targets: string, fields?: readonly string[], realms?: string, ownSpawns?: boolean, realmMembers?: boolean }} draft Seeded operator draft (`fields` is absent for ids with no declared vocabulary).
   * @property {readonly string[]} vocabulary Declared field-token vocabulary.
   * @property {string} summary One-line scope summary for the rail.
   * @property {boolean} canSave False only for a granted no-op draft.
   * @property {boolean} pending True while the grant/scope call is in flight.
   */

  /**
   * @type {{
   *   agentName: string,
   *   rows: ReadonlyArray<AuthorityScopeDialogRow>,
   *   selected: string,
   *   errors: Readonly<Record<string, { error: string, field?: string }>>,
   *   feedbackFor: (authority: string) => { msg: string, type: string } | null,
   *   onclose: () => void,
   *   onselect: (authority: string) => void,
   *   onupdate: (authority: string, key: string, value: unknown) => void,
   *   onfieldtoggle: (authority: string, token: string, checked: boolean) => void,
   *   onapply: (authority: string) => void,
   *   onreset: (authority: string) => void
   * }}
   */
  let {
    agentName,
    rows,
    selected,
    errors,
    feedbackFor,
    onclose,
    onselect,
    onupdate,
    onfieldtoggle,
    onapply,
    onreset
  } = $props();

  let modalRef = $state(/** @type {HTMLDivElement | null} */(null));
  /** Last rail id the dialog focused, so draft re-renders never steal focus. */
  let lastFocusedAuthority = null;

  let activeRow = $derived(rows.find((row) => row.authority === selected) ?? rows[0] ?? null);
  let activeFeedback = $derived(activeRow ? feedbackFor(activeRow.authority) : null);

  /**
   * Sanitized DOM id for one authority rail tab (raw ids carry `@`/`:`).
   *
   * @param {string} authority - Authority id.
   * @returns {string} DOM id (`authority-tab-agent-edit`).
   */
  function tabId(authority) {
    return `authority-tab-${authority.replace(/^@/, '').replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }

  /**
   * Unique control id inside the dialog.
   *
   * @param {string} authority - Authority id.
   * @param {string} name - Control name.
   * @returns {string} DOM id.
   */
  function fieldId(authority, name) {
    return `${tabId(authority)}-${name}`;
  }

  // Focus the selected rail tab on open / selection change only (never on the
  // panel's draft-patch re-renders, which produce a fresh `rows` array).
  $effect(() => {
    const authority = selected;
    if (!authority || authority === lastFocusedAuthority || !modalRef) return;
    const target = modalRef.querySelector(`#${tabId(authority)}`);
    if (target instanceof HTMLElement) {
      lastFocusedAuthority = authority;
      target.focus();
    }
  });

  /**
   * Exact dialog status line for the active id's state.
   *
   * @param {AuthorityScopeDialogRow} row - Active row.
   * @returns {string} Status copy.
   */
  function statusLine(row) {
    if (!row.enabled) return 'Not granted yet — saving grants it with this scope.';
    if (!row.scope) return 'Granted · default scope applies.';
    return 'Granted · narrowed scope applies.';
  }

  /**
   * Inline error mapped to one rendered control, or an empty string.
   *
   * @param {AuthorityScopeDialogRow} row - Active row.
   * @param {'targets' | 'realms' | 'fields'} field - Control name.
   * @returns {string} Error text, or `''`.
   */
  function fieldError(row, field) {
    const entry = errors[row.authority];
    return entry && entry.field === field ? entry.error : '';
  }

  /**
   * Error text that maps to no rendered control (rendered once as an alert
   * line above the action row instead).
   *
   * @param {AuthorityScopeDialogRow} row - Active row.
   * @returns {string} Error text, or `''`.
   */
  function unmappedError(row) {
    const entry = errors[row.authority];
    if (!entry) return '';
    const rendered =
      entry.field === 'targets' ||
      (entry.field === 'realms' && row.class === 'agent') ||
      (entry.field === 'fields' && row.vocabulary.length > 0);
    return rendered ? '' : entry.error;
  }

  /**
   * Primary action label: `Save scope` while granted, `Grant with scope` while
   * ungranted, `Applying…` while the call is in flight.
   *
   * @param {AuthorityScopeDialogRow} row - Active row.
   * @returns {string} Button label.
   */
  function primaryLabel(row) {
    if (row.pending) return 'Applying…';
    return row.enabled ? 'Save scope' : 'Grant with scope';
  }

  /**
   * Whether the primary action may run: never while pending; always for an
   * ungranted id; only for a dirty draft once granted.
   *
   * @param {AuthorityScopeDialogRow} row - Active row.
   * @returns {boolean} True when the button is enabled.
   */
  function canApply(row) {
    return !row.pending && (!row.enabled || row.canSave);
  }

  /**
   * Backdrop click closes the dialog (clicks inside it never do).
   *
   * @param {MouseEvent} event - Click event.
   */
  function handleBackdropClick(event) {
    if (event.target === event.currentTarget) onclose();
  }

  /**
   * Escape closes the dialog; Tab is trapped inside the modal perimeter.
   *
   * @param {KeyboardEvent} event - Key event.
   */
  function handleKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
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
</script>

<div
  class="modal-backdrop"
  role="presentation"
  tabindex="-1"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
>
  <div
    bind:this={modalRef}
    class="authority-scopes-modal glass-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="authority-scopes-title"
  >
    <div class="modal-header">
      <div class="header-left">
        <div class="icon-chip">
          <svg class="icon-svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        </div>
        <div>
          <h2 id="authority-scopes-title" class="modal-title">Authority scopes</h2>
          <p class="modal-sub">Bounds for {agentName}’s capability grants</p>
        </div>
      </div>
      <button type="button" class="btn-close" onclick={() => onclose()} aria-label="Close modal">
        <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>

    <div class="authority-scopes-body">
      <div class="authority-rail" role="tablist" aria-orientation="vertical" aria-label="Scoped capabilities">
        <span class="rail-heading">Scoped capabilities</span>
        {#each rows as row (row.authority)}
          <button
            type="button"
            role="tab"
            id={tabId(row.authority)}
            class="rail-tab"
            class:active={row.authority === selected}
            aria-selected={row.authority === selected}
            onclick={() => onselect(row.authority)}
          >
            <span class="rail-top">
              <span class="rail-name">{row.label}</span>
              <span class="rail-state" class:granted={row.enabled}>
                {row.enabled ? 'granted' : 'not granted'}
              </span>
            </span>
            <span class="rail-summary font-mono" title={row.enabled ? row.summary : 'Not granted'}>
              {row.enabled ? row.summary : '—'}
            </span>
          </button>
        {/each}
      </div>

      {#if activeRow}
        <div
          class="authority-detail"
          role="tabpanel"
          aria-labelledby={tabId(activeRow.authority)}
        >
          <div class="detail-title-row">
            <span class="detail-title">{activeRow.label}</span>
            <span class="authority-id font-mono">{activeRow.authority}</span>
            {#if activeRow.enabled}
              <span class="authority-live-tag font-mono">GRANTED</span>
            {/if}
          </div>
          <span class="status-line" class:granted={activeRow.enabled}>{statusLine(activeRow)}</span>
          {#if activeRow.warning}
            <div class="power-hint">⚠ {activeRow.warning}</div>
          {/if}

          <span class="section-label">Who it reaches</span>
          {#if activeRow.class === 'agent'}
            <label class="check-row">
              <input
                type="checkbox"
                class="authority-checkbox"
                checked={activeRow.draft.ownSpawns === true}
                onchange={(event) => onupdate(activeRow.authority, 'ownSpawns', event.currentTarget.checked)}
              />
              Own direct spawns
            </label>
            <span class="field-hint">Agents this holder spawned itself.</span>
            <label class="check-row">
              <input
                type="checkbox"
                class="authority-checkbox"
                checked={activeRow.draft.realmMembers === true}
                onchange={(event) => onupdate(activeRow.authority, 'realmMembers', event.currentTarget.checked)}
              />
              Every member of the bound realms
            </label>
          {/if}

          <div class="field">
            <label for={fieldId(activeRow.authority, 'targets')}>
              {activeRow.class === 'agent' ? 'Agent id targets' : 'Realm id targets'}
            </label>
            <input
              id={fieldId(activeRow.authority, 'targets')}
              type="text"
              class="input-field font-mono"
              class:invalid={fieldError(activeRow, 'targets') !== ''}
              aria-invalid={fieldError(activeRow, 'targets') !== ''}
              value={activeRow.draft.targets}
              placeholder={activeRow.class === 'agent' ? 'e.g. worker, coordinator' : 'e.g. realm_generic'}
              oninput={(event) => onupdate(activeRow.authority, 'targets', event.currentTarget.value)}
            />
            <span class="field-hint">
              {activeRow.class === 'agent'
                ? 'Comma or newline separated. Empty = no agent-target selector.'
                : 'Comma or newline separated. Empty = the holder’s own realm.'}
            </span>
            {#if fieldError(activeRow, 'targets')}
              <span class="field-error" role="alert">{fieldError(activeRow, 'targets')}</span>
            {/if}
          </div>

          {#if activeRow.class === 'agent'}
            <div class="field">
              <label for={fieldId(activeRow.authority, 'realms')}>Realm bound</label>
              <input
                id={fieldId(activeRow.authority, 'realms')}
                type="text"
                class="input-field font-mono"
                class:invalid={fieldError(activeRow, 'realms') !== ''}
                aria-invalid={fieldError(activeRow, 'realms') !== ''}
                value={activeRow.draft.realms}
                placeholder="e.g. realm_generic"
                oninput={(event) => onupdate(activeRow.authority, 'realms', event.currentTarget.value)}
              />
              <span class="field-hint">Comma or newline separated. Empty = the holder’s own realm.</span>
              {#if fieldError(activeRow, 'realms')}
                <span class="field-error" role="alert">{fieldError(activeRow, 'realms')}</span>
              {/if}
            </div>
          {/if}

          {#if activeRow.vocabulary.length > 0}
            <span class="section-label">Editable fields</span>
            <div class="token-row">
              {#each activeRow.vocabulary as token (token)}
                <label class="token">
                  <input
                    type="checkbox"
                    class="authority-checkbox"
                    checked={(activeRow.draft.fields ?? []).includes(token)}
                    onchange={(event) => onfieldtoggle(activeRow.authority, token, event.currentTarget.checked)}
                  />
                  {token}
                </label>
              {/each}
            </div>
            <span class="field-hint">All tokens checked = the id default. Clearing every token denies all field edits.</span>
            {#if fieldError(activeRow, 'fields')}
              <span class="field-error" role="alert">{fieldError(activeRow, 'fields')}</span>
            {/if}
          {/if}

          {#if unmappedError(activeRow)}
            <span class="field-error" role="alert">{unmappedError(activeRow)}</span>
          {/if}

          <div class="dialog-actions">
            <button
              type="button"
              class="btn-scope"
              disabled={!canApply(activeRow)}
              onclick={() => onapply(activeRow.authority)}
            >
              {primaryLabel(activeRow)}
            </button>
            <button
              type="button"
              class="btn-ghost"
              disabled={activeRow.pending}
              onclick={() => onreset(activeRow.authority)}
            >
              Reset to default
            </button>
            <span class="discard-note">Closing discards unapplied edits.</span>
          </div>

          {#if activeFeedback}
            <span
              class="field-status"
              class:pending={activeFeedback.type === 'pending'}
              class:error={activeFeedback.type === 'error'}
              role={activeFeedback.type === 'error' ? 'alert' : 'status'}
            >
              {activeFeedback.msg}
            </span>
          {/if}
        </div>
      {/if}
    </div>

    <div class="modal-footer">
      <button type="button" class="btn-ghost" onclick={() => onclose()}>Close</button>
    </div>
  </div>
</div>
