<script>
  /**
   * Realm Manager provenance card (realm manager redesign, ticket ca33e1b):
   * the selected Realm's launch provenance and its rehydrate/replace entry
   * point.
   *
   * Template-launched Realms render the read-only provenance rows (template
   * revision, optional package digest, launch timestamp) plus the expandable
   * per-input hashes and seeded paths; a Realm without a valid provenance
   * block renders the manual content note instead. Both paths keep the
   * rehydrate entry point (`onrehydrate`), exactly as before the redesign —
   * hashes and paths only, never raw input values.
   */
  import { buildRealmProvenanceView } from './realmTemplateHelpers.ts';
  import { buildRealmProvenanceDetailView } from './realmHydrationHelpers.ts';

  /**
   * @type {{
   *   realm: import('../../sandbox/realmRegistry/index.ts').RealmRecord,
   *   onrehydrate: (realm: import('../../sandbox/realmRegistry/index.ts').RealmRecord) => void
   * }}
   */
  let { realm, onrehydrate } = $props();

  let provenance = $derived(buildRealmProvenanceView(realm));
  // Provenance detail (ticket 874182b): per-input hashes and seeded paths
  // recorded at launch — hashes and paths only, never raw values.
  let provenanceDetail = $derived(buildRealmProvenanceDetailView(realm));
</script>

{#if provenance.visible}
  <div class="settings-section-card">
    <div class="section-card-header">
      <div class="section-title-wrap">
        <span class="section-badge">Origin</span>
        <h4 class="section-title">Template provenance</h4>
      </div>
    </div>
    <dl class="provenance-list">
      {#each provenance.rows as row (row.key)}
        <div class="provenance-row">
          <dt class="provenance-label">{row.label}</dt>
          <dd class="provenance-value font-mono">{row.value}</dd>
        </div>
      {/each}
    </dl>
    {#if provenanceDetail.inputRows.length > 0}
      <details class="provenance-details">
        <summary>Input hashes ({provenanceDetail.inputRows.length})</summary>
        <ul class="provenance-detail-list">
          {#each provenanceDetail.inputRows as row (row.inputId)}
            <li class="provenance-detail-row">
              <span class="provenance-detail-label">{row.inputId}</span>
              <span class="provenance-detail-value font-mono">{row.shortHash}</span>
            </li>
          {/each}
        </ul>
      </details>
    {/if}
    {#if provenanceDetail.seedPaths.length > 0}
      <details class="provenance-details">
        <summary>Seeded paths ({provenanceDetail.seedPaths.length})</summary>
        <ul class="provenance-detail-list">
          {#each provenanceDetail.seedPaths as path, index (index)}
            <li class="provenance-detail-row"><span class="provenance-detail-value font-mono">{path}</span></li>
          {/each}
        </ul>
      </details>
    {/if}
    <p class="provenance-note">
      Recorded at launch: template revision, package digest, input hashes, seeded paths, and the extension
      resolution (resolved tool call names and missing requested extensions) — hashes, paths, call names, and
      ids only, never raw input values or secrets. Provenance is descriptive metadata, never authority.
    </p>
    <div class="section-actions">
      <button type="button" class="btn-secondary" onclick={() => onrehydrate(realm)}>
        Rehydrate / Replace content…
      </button>
    </div>
  </div>
{:else}
  <div class="settings-section-card">
    <div class="section-card-header">
      <div class="section-title-wrap">
        <span class="section-badge">Content</span>
        <h4 class="section-title">Realm content</h4>
      </div>
    </div>
    <p class="provenance-note">
      This Realm has no recorded launch provenance. You can still write files into its global workspace or a
      member's workspace without relaunching anyone.
    </p>
    <div class="section-actions">
      <button type="button" class="btn-secondary" onclick={() => onrehydrate(realm)}>
        Write files…
      </button>
    </div>
  </div>
{/if}
