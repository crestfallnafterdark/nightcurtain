<script>
  /**
   * Step 2 of the Realm launcher (launcher redesign decomposition, ticket
   * e1e8775): the launch receipt, the live missing-extension flow of the
   * freshly launched Realm (install/attach actions, nothing automatic), and
   * the optional post-launch seed form (target workspace, file rows, optional
   * directive) with its receipt.
   *
   * Draft state is bindable from the modal (the seed call site lives there).
   */
  import { describeSeedWorkspace } from './realmLauncherHelpers.ts';
  import { describeRealmExtensionState } from './extensionUiHelpers.ts';

  /**
   * @type {{
   *   launchReceipt: import('../../sandbox/sandboxStore/index.svelte.ts').RealmLaunchReceipt | null,
   *   launchApprovals: ReadonlyArray<{ agentKey: string, authority: string }>,
   *   missingFlow: ReadonlyArray<import('./extensionUiHelpers.ts').MissingExtensionFlowView>,
   *   seedReceipt: import('../../sandbox/sandboxStore/index.svelte.ts').RealmSeedReceipt | null,
   *   seedRows: Array<{ path: string, content: string }>,
   *   seedDirective: string,
   *   seedTargetId: string,
   *   seedTargetOptions: ReadonlyArray<import('./realmLauncherHelpers.ts').RealmSeedTargetOption>,
   *   seedDirectiveRequested: boolean,
   *   isSeeding: boolean,
   *   onseed: (event: SubmitEvent) => void,
   *   ontargetchange: () => void,
   *   onaddrow: () => void,
   *   onremoverow: (index: number) => void,
   *   onclose: () => void,
   *   oninstallmissing: (view: import('./extensionUiHelpers.ts').MissingExtensionFlowView) => void,
   *   onattachmissing: (view: import('./extensionUiHelpers.ts').MissingExtensionFlowView) => void
   * }}
   */
  let {
    launchReceipt,
    launchApprovals,
    missingFlow,
    seedReceipt,
    seedRows = $bindable(/** @type {Array<{ path: string, content: string }>} */([])),
    seedDirective = $bindable(''),
    seedTargetId = $bindable(''),
    seedTargetOptions,
    seedDirectiveRequested,
    isSeeding,
    onseed,
    ontargetchange,
    onaddrow,
    onremoverow,
    onclose,
    oninstallmissing,
    onattachmissing
  } = $props();
</script>

{#if launchReceipt}
  <div class="launch-receipt" role="status">
    <div class="receipt-title-row">
      <span class="badge badge-success">Launched</span>
      <span class="receipt-title">{launchReceipt.realm.name}</span>
      <span class="receipt-id font-mono">{launchReceipt.realm.id}</span>
    </div>
    <p class="receipt-copy">
      {launchReceipt.agents.length} member{launchReceipt.agents.length === 1 ? '' : 's'} launched and grouped in the
      sidebar: {launchReceipt.agents.map((agent) => agent.name).join(', ')}.
    </p>
    {#if launchApprovals.length > 0}
      <p class="receipt-copy">
        Approved publishing authorities: {launchApprovals.map((entry) => `${entry.agentKey} → ${entry.authority}`).join(', ')}.
      </p>
    {/if}
  </div>

  {#if missingFlow.length > 0}
    <div class="settings-section-card missing-card">
      <div class="section-card-header">
        <div class="section-title-wrap">
          <span class="section-badge missing-badge">Attention</span>
          <h4 class="section-title">Missing extensions ({missingFlow.length})</h4>
        </div>
      </div>
      <p class="field-hint">
        These requested extensions are not available in this Realm. Nothing installs or attaches automatically —
        the actions below are explicit operator steps; this list follows the live state.
      </p>
      <ul class="missing-list">
        {#each missingFlow as view (view.extensionId)}
          {@const stateView = describeRealmExtensionState(view.state)}
          <li class="missing-row">
            <div class="missing-info">
              <div class="missing-title-row">
                <span class="missing-name">{view.displayName || view.extensionId}</span>
                <span class="kind-chip font-mono">{view.kind}</span>
                <span class="status-chip state-{stateView.state} font-mono">{stateView.label}</span>
                <span class="third-party-chip font-mono">{view.thirdPartyLabel}</span>
              </div>
              <span class="missing-note">{stateView.description}</span>
              {#if view.transportHintSummary}
                <span class="missing-transport font-mono">{view.transportHintSummary}</span>
              {/if}
              {#if view.authorComment}
                <span class="missing-author">Template note: {view.authorComment}</span>
              {/if}
            </div>
            <div class="missing-actions">
              {#if view.canInstall}
                <button type="button" class="btn-primary btn-xs" onclick={() => oninstallmissing(view)}>
                  Install…
                </button>
              {/if}
              {#if view.canAttach}
                <button type="button" class="btn-secondary btn-xs" onclick={() => onattachmissing(view)}>
                  Attach to this Realm
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if launchReceipt.warnings && launchReceipt.warnings.length > 0}
        <details class="launch-warnings">
          <summary>Launch warnings ({launchReceipt.warnings.length})</summary>
          <ul class="written-paths">
            {#each launchReceipt.warnings as warning, index (index)}
              <li>{warning}</li>
            {/each}
          </ul>
        </details>
      {/if}
    </div>
  {/if}

  {#if seedReceipt}
    <div class="settings-section-card">
      <div class="section-card-header">
        <div class="section-title-wrap">
          <span class="section-badge">Seed</span>
          <h4 class="section-title">Seed receipt</h4>
        </div>
      </div>
      <p class="receipt-copy">
        Wrote {seedReceipt.writtenPaths.length} file{seedReceipt.writtenPaths.length === 1 ? '' : 's'} into
        {describeSeedWorkspace(seedReceipt.workspace, seedReceipt.realmId)}.
      </p>
      <ul class="written-paths">
        {#each seedReceipt.writtenPaths as path (path)}
          <li class="font-mono">{path}</li>
        {/each}
      </ul>
      <p class="receipt-copy">
        {#if seedReceipt.directiveDelivered}
          Directive delivered to the target member's mailbox (operator-attributed).
        {:else if seedDirectiveRequested}
          Directive was NOT delivered — no operator principal may be registered.
        {:else}
          No directive was requested.
        {/if}
      </p>
    </div>
    <div class="modal-footer compact">
      <button type="button" class="btn-primary" onclick={onclose}>Done</button>
    </div>
  {:else}
    <form class="launcher-form" onsubmit={onseed} novalidate>
      <div class="settings-section-card">
        <div class="section-card-header">
          <div class="section-title-wrap">
            <span class="section-badge">Seed</span>
            <h4 class="section-title">Optional post-launch seed</h4>
          </div>
        </div>

        <div class="form-group">
          <label for="realm-seed-target">Target workspace</label>
          <select id="realm-seed-target" bind:value={seedTargetId} class="select-field" onchange={ontargetchange}>
            {#each seedTargetOptions as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
          <span class="field-hint">
            Files land in the Realm-global workspace by default, or in the selected member's private workspace.
            A directive needs a member recipient.
          </span>
        </div>

        <div class="form-group">
          <span class="label-text">Files</span>
          {#if seedRows.length === 0}
            <p class="rows-empty">No file rows yet — add one to seed, or skip seeding.</p>
          {/if}
          {#each seedRows as row, index (index)}
            <div class="seed-row">
              <div class="seed-row-head">
                <span class="seed-row-label">Row {index + 1}</span>
                <button type="button" class="btn-row-remove" onclick={() => onremoverow(index)} aria-label="Remove row {index + 1}">
                  Remove
                </button>
              </div>
              <input
                type="text"
                bind:value={row.path}
                placeholder="/notes/brief.md"
                class="input-field font-mono"
                aria-label="Row {index + 1} file path"
              />
              <textarea
                bind:value={row.content}
                rows="3"
                placeholder="File content (paste supported)"
                class="textarea-field font-mono"
                aria-label="Row {index + 1} file content"
              ></textarea>
            </div>
          {/each}
          <div class="rows-actions">
            <button type="button" class="btn-secondary btn-xs" onclick={onaddrow}>+ Add file row</button>
          </div>
        </div>

        <div class="form-group">
          <label for="realm-seed-directive">Directive <span class="opt">(optional)</span></label>
          <textarea
            id="realm-seed-directive"
            bind:value={seedDirective}
            rows="3"
            placeholder="Operator instruction delivered to the target member's mailbox"
            class="textarea-field"
          ></textarea>
        </div>
      </div>

      <div class="modal-footer compact">
        <button type="button" class="btn-secondary" onclick={onclose} disabled={isSeeding}>Skip &amp; Close</button>
        <button type="submit" class="btn-primary" disabled={isSeeding}>
          {isSeeding ? 'Seeding…' : 'Seed Realm'}
        </button>
      </div>
    </form>
  {/if}
{/if}
