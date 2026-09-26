<script>
  /**
   * Per-agent preview card of the Realm launcher (launcher redesign
   * decomposition, ticket e1e8775): identity and badges (privilege, wildcard,
   * declared authorities), preset + catalog model binding, the disclosure grid
   * (`initialPrompt` / `triggerPolicy` / `modelPresetId` / `privileged` with
   * their semantics disclaimers), the mutating/read-only grant groups, the
   * composed-prompt preview with per-part provenance, and the baked-history
   * editor whose inline text edits travel back to the source input.
   *
   * The card resolves the preset catalog itself (subscription), so the modal
   * does not have to own catalog state only this card renders.
   */
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import {
    buildRealmPromptPreview,
    describeRealmPresetBinding
  } from './realmLauncherHelpers.ts';
  import {
    buildRealmAgentDisclosureRows,
    buildRealmHistoryEditorViews,
    buildRealmPartProvenanceViews
  } from './realmReviewHelpers.ts';

  /**
   * @type {{
   *   selectedTemplate: import('../../sandbox/realmCatalog/index.ts').RealmTemplate | null,
   *   rows: ReadonlyArray<import('../../sandbox/realmCatalog/index.ts').AgentCapabilitySummary>,
   *   bundleFiles: Readonly<Record<string, string>>,
   *   effectiveInputs: import('../../sandbox/realmCatalog/index.ts').RealmInputValues,
   *   drafts: Array<import('./realmLauncherHelpers.ts').RealmInputDraft>,
   *   oneditinput: (inputId: string, value: string) => void
   * }}
   */
  let { selectedTemplate, rows, bundleFiles, effectiveInputs, drafts, oneditinput } = $props();

  // Catalog presets drive the per-agent preset-binding display (the store
  // resolves the actual launch binding from the same catalog).
  const presetCatalog = sandboxStore.getPresetCatalog();
  let catalogPresets = $state(presetCatalog.listPresets());
  let defaultPresetId = $state(presetCatalog.createPresetSourcePort().getDefaultPresetId());

  $effect(() => {
    const unsubscribe = presetCatalog.subscribe(() => {
      catalogPresets = presetCatalog.listPresets();
      defaultPresetId = presetCatalog.createPresetSourcePort().getDefaultPresetId();
    });
    return unsubscribe;
  });

  /**
   * Resolves the source agent spec behind one preview row (the summary does
   * not carry `modelPresetId`).
   *
   * @param {string} key - Template agent key.
   * @returns The spec, or null.
   */
  function agentSpecFor(key) {
    if (!selectedTemplate) return null;
    return selectedTemplate.agents.find((agent) => agent.key === key) ?? null;
  }

  /**
   * The draft behind one declared input id (history editing resolves an inline
   * editor per referenced input).
   *
   * @param {string} inputId - Declared input id.
   * @returns The draft, or null.
   */
  function draftFor(inputId) {
    return drafts.find((draft) => draft.id === inputId) ?? null;
  }

  /**
   * Display value of one input for the inline history editors.
   *
   * @param {string} inputId - Declared input id.
   * @returns Display text.
   */
  function displayFor(inputId) {
    const value = effectiveInputs[inputId];
    if (!value) return '';
    return value.shape === 'text' ? value.text : value.files.map((file) => file.path).join(', ');
  }

  /**
   * Counts editable history entries in one editor projection (the template
   * summary cannot host an arrow-function expression).
   *
   * @param {import('./realmReviewHelpers.ts').RealmHistoryEditorProjection} projection - History projection.
   * @returns Number of entries with at least one source-editable part.
   */
  function countEditableHistoryEntries(projection) {
    return (projection?.entries ?? []).filter((entry) => entry.editable).length;
  }
</script>

<div class="settings-section-card">
  <div class="section-card-header">
    <div class="section-title-wrap">
      <span class="section-badge">Preview</span>
      <h4 class="section-title">Agents ({rows.length})</h4>
    </div>
  </div>

  {#each rows as row (row.key)}
    {@const spec = agentSpecFor(row.key)}
    {@const binding = describeRealmPresetBinding(spec?.modelPresetId, catalogPresets, defaultPresetId)}
    {@const promptPreview = buildRealmPromptPreview(spec?.prompt ?? [], selectedTemplate?.inputs, { inputs: effectiveInputs, bundleFiles })}
    {@const promptPartViews = buildRealmPartProvenanceViews(spec?.prompt ?? [], selectedTemplate?.inputs, { inputs: effectiveInputs, bundleFiles })}
    {@const historyEditor = buildRealmHistoryEditorViews(spec, selectedTemplate?.inputs, { inputs: effectiveInputs, bundleFiles })}
    {@const disclosureRows = buildRealmAgentDisclosureRows(spec, binding.label)}
    <div class="agent-preview-card">
      <div class="agent-preview-head">
        <div class="agent-preview-identity">
          <span class="agent-preview-name">{row.name}</span>
          <span class="agent-preview-id font-mono">{row.idPattern}</span>
        </div>
        <div class="agent-preview-badges">
          {#if row.privileged}
            <span class="badge badge-sudo" title="Universal Administrative / Sudo Authority">⚡ sudo</span>
          {:else}
            <span class="badge badge-muted">unprivileged</span>
          {/if}
          {#if row.wildcard}
            <span class="badge badge-wildcard" title="Effective grants include the wildcard '*'">
              * wildcard{row.wildcardSource === 'privileged' ? ' · from privilege' : ''}
            </span>
          {/if}
          {#if spec && Array.isArray(spec.authorities) && spec.authorities.length > 0}
            <span class="badge badge-authority" title="Declared publishing-authority requests; approved per launch below">
              {spec.authorities.length} declared authorit{spec.authorities.length === 1 ? 'y' : 'ies'}
            </span>
          {/if}
        </div>
      </div>
      <p class="agent-preview-role">{row.role}</p>
      <div class="agent-preview-meta">
        <div class="meta-line">
          <span class="meta-label">Preset</span>
          <span class="meta-value font-mono">{row.preset ?? 'custom list'}</span>
        </div>
        <div class="meta-line">
          <span class="meta-label">Model binding</span>
          <span class="meta-value font-mono">
            {binding.label}{binding.isDefault ? ' · active default' : ''}{binding.known ? '' : ' ⚠'}
          </span>
        </div>
      </div>

      <div class="disclosure-grid">
        {#each disclosureRows as disclosure (disclosure.key)}
          <div class="disclosure-line">
            <div class="meta-line">
              <span class="meta-label">{disclosure.label}</span>
              <span class="meta-value disclosure-value" class:disclosure-empty={!disclosure.present}>
                {disclosure.value}
              </span>
            </div>
            <span class="disclosure-note">{disclosure.disclaimer}</span>
          </div>
        {/each}
      </div>

      {#if row.unrecognized.length > 0}
        <p class="unrecognized-note">
          Unrecognized grants: {row.unrecognized.join(', ')}
        </p>
      {/if}

      <div class="grant-groups">
        <details class="grant-details">
          <summary>Mutating tools ({row.mutating.length})</summary>
          <div class="chip-wrap">
            {#each row.mutating as tool (tool)}
              <span class="tool-chip mutating font-mono">{tool}</span>
            {/each}
          </div>
        </details>
        <details class="grant-details">
          <summary>Read-only tools ({row.readOnly.length})</summary>
          <div class="chip-wrap">
            {#each row.readOnly as tool (tool)}
              <span class="tool-chip readonly font-mono">{tool}</span>
            {/each}
          </div>
        </details>
      </div>
      {#if row.wildcard}
        <p class="grant-note">
          Wildcard capability: the classification above covers the full canonical tool vocabulary
          ({row.mutating.length} mutating, {row.readOnly.length} read-only).
        </p>
      {/if}

      <details class="prompt-preview">
        <summary>Composed prompt preview — {promptPartViews.parts.length} parts</summary>
        {#if promptPreview.ok}
          <pre class="prompt-preview-text">{promptPreview.systemPrompt}</pre>
          {#if promptPartViews.ok && promptPartViews.parts.length > 0}
            <ul class="part-list">
              {#each promptPartViews.parts as part (part.index)}
                <li class="part-row">
                  <span class="part-origin" class:origin-fixed={part.origin === 'fixed'} class:origin-user={part.origin === 'user'} class:origin-generated={part.origin === 'generated'}>
                    {part.origin}
                  </span>
                  <span class="part-label">{part.label}</span>
                  {#if part.editable}
                    <span class="part-note">editable at source</span>
                  {/if}
                  {#if part.empty}
                    <span class="part-note part-note-empty">contributes nothing</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if promptPreview.inputProvenance.length > 0}
            <p class="prompt-preview-note">
              Inputs referenced:
              {promptPreview.inputProvenance.map((entry) => `${entry.inputId} (${entry.source})`).join(', ')}.
            </p>
          {/if}
        {:else if promptPreview.bundleUnavailable}
          <p class="prompt-preview-note prompt-preview-missing">
            Bundle not available — {promptPreview.error}
          </p>
        {:else}
          <p class="prompt-preview-note prompt-preview-missing">{promptPreview.error}</p>
        {/if}
      </details>

      <details class="prompt-preview history-preview">
        <summary>
          Baked history ({historyEditor.entries.length}){#if countEditableHistoryEntries(historyEditor) > 0} — editable at source{:else} — fixed{/if}
        </summary>
        {#if historyEditor.ok}
          {#if historyEditor.entries.length === 0}
            <p class="prompt-preview-note">No baked history is declared for this agent.</p>
          {:else}
            {#each historyEditor.entries as entry (entry.index)}
              <div class="history-entry">
                <span class="history-role" class:role-agent={entry.role === 'assistant'}>
                  {entry.roleLabel}
                </span>
                <pre class="history-content">{entry.content}</pre>
                {#if entry.parts.length > 0}
                  <ul class="part-list">
                    {#each entry.parts as part (part.index)}
                      <li class="part-row">
                        <span class="part-origin" class:origin-fixed={part.origin === 'fixed'} class:origin-user={part.origin === 'user'} class:origin-generated={part.origin === 'generated'}>
                          {part.origin}
                        </span>
                        <span class="part-label">{part.label}</span>
                        {#if part.editable && draftFor(part.inputId)?.shape === 'text'}
                          <textarea
                            class="part-input-edit"
                            rows="2"
                            value={displayFor(part.inputId)}
                            aria-label={`Edit ${part.inputLabel} for this history entry`}
                            oninput={(event) => oneditinput(part.inputId, event.currentTarget.value)}
                          ></textarea>
                          <span class="part-note">edits the launch input (source)</span>
                        {:else if part.editable && draftFor(part.inputId)?.shape === 'files'}
                          <span class="part-note">files input — edit the attached fileset above</span>
                        {:else if part.editable}
                          <span class="part-note">input not declared in the review form</span>
                        {:else}
                          <span class="part-note">shipped in the bundle</span>
                        {/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
            {/each}
          {/if}
        {:else if historyEditor.bundleUnavailable}
          <p class="prompt-preview-note prompt-preview-missing">
            Bundle not available — {historyEditor.error}
          </p>
        {:else}
          <p class="prompt-preview-note prompt-preview-missing">{historyEditor.error}</p>
        {/if}
      </details>
    </div>
  {/each}
</div>
