<script>
  /**
   * Realm Manager attach editor (realm manager redesign, ticket ca33e1b): pick
   * one installed extension and record its realm-level ceiling.
   *
   * The editor owns its picker state (selection, live-catalog checkboxes, or
   * the fallback all/custom mode) and reseeds it on every selection change, so
   * a half-typed ceiling never leaks across extensions. The ceiling model and
   * the state-accurate hint copy come from `describeRealmAttachCeilingEditor`
   * (ticket 9472417); the resolver (`resolveRealmAttachToolSelection`) turns
   * the visible state into the store's `toolSelection` so the editor can never
   * disagree with what it shows.
   *
   * Nothing connects: recording an attachment is operator intent, and its
   * tools stay inert until a runtime connection exists.
   */
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { describeRealmAttachCeilingEditor } from './extensionUiHelpers.ts';
  import { resolveRealmAttachToolSelection } from './realmManagerHelpers.ts';

  /**
   * @type {{
   *   attachable: ReadonlyArray<{ id: string, displayName?: string, kind: string }>,
   *   onattach: (extensionId: string, toolSelection: 'all' | readonly string[]) => boolean,
   *   onstatus: (status: { ok: boolean, msg: string }) => void
   * }}
   */
  let { attachable, onattach, onstatus } = $props();

  let attachExtensionId = $state('');
  let attachSelectionMode = $state('all');
  let attachSelectionText = $state('');
  let attachCheckedNames = $state(/** @type {string[]} */([]));

  /**
   * Attach-editor ceiling model (ticket 9472417): the picked extension's live
   * conflict-free catalog names plus the state-accurate copy/visibility
   * decision, so the editor never claims a missing live catalog while a
   * connected catalog exists (or before anything is picked).
   */
  let ceiling = $derived(describeRealmAttachCeilingEditor({
    extensionId: attachExtensionId,
    connections: sandboxStore.extensionConnections
  }));

  /** Live conflict-free catalog names of the picked extension. */
  let attachCatalogNames = $derived(ceiling.catalogNames);

  /** Reseeds the ceiling editor when the attach selection changes. */
  function handleAttachSelectionChange() {
    onstatus({ ok: true, msg: '' });
    attachCheckedNames = [...attachCatalogNames];
    attachSelectionMode = 'all';
    attachSelectionText = '';
  }

  /** Clears the editor after a successful attach. */
  function resetEditor() {
    attachExtensionId = '';
    attachSelectionMode = 'all';
    attachSelectionText = '';
    attachCheckedNames = [];
  }

  /**
   * Attaches the picked extension with its realm-level ceiling: the live
   * catalog names the operator checked (all checked is the `'all'` selection),
   * or the typed sanitized call names when no live catalog exists yet.
   */
  function handleAttachExtension() {
    if (!attachExtensionId) {
      onstatus({ ok: false, msg: 'Choose an installed extension to attach.' });
      return;
    }
    const resolved = resolveRealmAttachToolSelection({
      catalogNames: attachCatalogNames,
      checkedNames: attachCheckedNames,
      mode: attachSelectionMode,
      customText: attachSelectionText
    });
    if (!resolved.ok) {
      onstatus({ ok: false, msg: resolved.error });
      return;
    }
    if (onattach(attachExtensionId, resolved.toolSelection)) resetEditor();
  }
</script>

<div class="attach-editor">
  <div class="attach-grid">
    <div class="form-group grow">
      <label for="realm-attach-extension">Attach an installed extension</label>
      <select id="realm-attach-extension" class="select-field" bind:value={attachExtensionId} onchange={handleAttachSelectionChange}>
        <option value="">Choose an extension…</option>
        {#each attachable as record (record.id)}
          <option value={record.id}>{record.displayName || record.id} ({record.kind})</option>
        {/each}
      </select>
      {#if attachable.length === 0}
        <span class="attach-empty-hint">Every installed extension is already attached here, or none is installed.</span>
      {/if}
    </div>
    <div class="form-group grow">
      <span class="field-label">Realm-level ceiling (tool selection)</span>
      {#if ceiling.showLiveCatalog}
        <div class="ceiling-tool-list">
          <label class="ceiling-tool-row">
            <input
              type="checkbox"
              checked={attachCheckedNames.length === attachCatalogNames.length}
              onchange={(event) => (attachCheckedNames = event.currentTarget.checked ? [...attachCatalogNames] : [])}
            />
            <span>All {attachCatalogNames.length} live catalog tools</span>
          </label>
          {#each attachCatalogNames as callName (callName)}
            <label class="ceiling-tool-row">
              <input
                type="checkbox"
                checked={attachCheckedNames.includes(callName)}
                onchange={(event) => {
                  const next = new Set(attachCheckedNames);
                  if (event.currentTarget.checked) next.add(callName);
                  else next.delete(callName);
                  attachCheckedNames = attachCatalogNames.filter((name) => next.has(name));
                }}
              />
              <span class="font-mono">{callName}</span>
            </label>
          {/each}
        </div>
        <span class="attach-empty-hint">
          The Realm ceiling caps the live catalog: unchecked tools are never granted here, and per-agent
          scopes can only narrow further.
        </span>
      {:else}
        <div class="selection-modes">
          <label class="mode-option" class:active={attachSelectionMode === 'all'}>
            <input type="radio" bind:group={attachSelectionMode} value="all" />
            <span>All tools</span>
          </label>
          <label class="mode-option" class:active={attachSelectionMode === 'custom'}>
            <input type="radio" bind:group={attachSelectionMode} value="custom" />
            <span>Only specific call names</span>
          </label>
        </div>
        {#if attachSelectionMode === 'custom'}
          <input
            type="text"
            class="input-field font-mono"
            placeholder="docs_search, similarity"
            bind:value={attachSelectionText}
            oninput={() => onstatus({ ok: true, msg: '' })}
          />
          <span class="attach-empty-hint">
            {ceiling.customNamesHint}
          </span>
        {:else}
          <span class="attach-empty-hint">
            {ceiling.allToolsHint}
          </span>
        {/if}
      {/if}
    </div>
  </div>
  <div class="section-actions">
    <button
      type="button"
      class="btn-primary btn-xs"
      onclick={handleAttachExtension}
      disabled={!attachExtensionId}
    >
      Attach to this Realm
    </button>
  </div>
</div>
