<script>
  /**
   * Realm Manager master list (realm manager redesign, ticket ca33e1b): the
   * fixed-height, searchable realm rail of the manager's master–detail layout.
   *
   * The list renders one selectable row per registered Realm (registry order,
   * Generic first) with its accent dot, active-member count, and a recorded
   * missing-extension badge. Search filters name/id/description through
   * `filterRealmManagerEntries` without reordering, so the registry order
   * stays the stable navigation order. The list never grows the dialog: it
   * scrolls inside its own rail.
   */
  import { filterRealmManagerEntries } from './realmManagerHelpers.ts';

  /**
   * @type {{
   *   entries: import('./realmManagerHelpers.ts').RealmManagerEntry[],
   *   selectedId: string,
   *   query: string,
   *   onquery: (query: string) => void,
   *   onselect: (realmId: string) => void
   * }}
   */
  let { entries, selectedId, query, onquery, onselect } = $props();

  let filtered = $derived(filterRealmManagerEntries(entries, query));
</script>

<div class="realm-rail-search">
  <input
    type="search"
    class="input-field"
    placeholder="Search realms by name or id…"
    aria-label="Search realms"
    value={query}
    oninput={(event) => onquery(event.currentTarget.value)}
  />
</div>

{#if entries.length > 0}
  <p class="realm-rail-status">
    {#if query.trim()}
      {filtered.length} of {entries.length} realm{entries.length === 1 ? '' : 's'}
    {:else}
      {entries.length} realm{entries.length === 1 ? '' : 's'}
    {/if}
  </p>
{/if}

<div class="realm-list" role="tablist" aria-label="Realms" aria-orientation="vertical">
  {#each filtered as entry (entry.id)}
    <button
      type="button"
      role="tab"
      id="realm-tab-{entry.id}"
      class="realm-chip"
      class:active={entry.id === selectedId}
      aria-selected={entry.id === selectedId}
      onclick={() => onselect(entry.id)}
    >
      <span class="realm-dot" style="background: {entry.color ?? 'var(--text-muted)'}"></span>
      <span class="realm-chip-name">{entry.name}</span>
      {#if entry.missingExtensionCount > 0}
        <span
          class="realm-chip-missing font-mono"
          title="{entry.missingExtensionCount} requested extension{entry.missingExtensionCount === 1 ? '' : 's'} not available in this Realm — open the Realm detail to install or attach."
        >
          {entry.missingExtensionCount} missing
        </span>
      {/if}
      <span class="realm-chip-count font-mono" title="{entry.activeMembers} active member{entry.activeMembers === 1 ? '' : 's'}">{entry.activeMembers}</span>
    </button>
  {:else}
    <p class="realm-list-empty">
      {entries.length === 0 ? 'No Realms registered yet.' : `No realms match “${query.trim()}”.`}
    </p>
  {/each}
</div>
