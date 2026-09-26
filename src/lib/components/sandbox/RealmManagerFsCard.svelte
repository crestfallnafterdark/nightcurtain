<script>
  /**
   * Realm Manager workspaces card (realm manager redesign, ticket ca33e1b):
   * read-only VirtualFS partition visibility for the selected Realm.
   *
   * The card lists the Realm's realm-global workspace and its member
   * workspaces (label, kind, resolved file count) from the store's operator
   * partition listing — display-only, no navigation or mutation. Managing the
   * bytes stays in the Files tab (VirtualFS explorer).
   */
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import { selectRealmFsPartitionViews } from './realmManagerHelpers.ts';

  /**
   * @type {{ realm: import('../../sandbox/realmRegistry/index.ts').RealmRecord }}
   */
  let { realm } = $props();

  let partitions = $derived(selectRealmFsPartitionViews(sandboxStore.fsWorkspacePartitions, realm.id));
</script>

<div class="settings-section-card">
  <div class="section-card-header">
    <div class="section-title-wrap">
      <span class="section-badge">Files</span>
      <h4 class="section-title">Workspaces ({partitions.length})</h4>
    </div>
  </div>

  {#if partitions.length === 0}
    <p class="members-empty">No workspace partitions recorded for this Realm yet.</p>
  {:else}
    <ul class="fs-partition-list">
      {#each partitions as partition (partition.key)}
        <li class="fs-partition-row">
          <div class="fs-partition-info">
            <span class="fs-partition-label">{partition.label}</span>
            <span class="fs-partition-kind font-mono">{partition.kindLabel}</span>
          </div>
          <span class="fs-partition-count font-mono">
            {partition.fileCount} file{partition.fileCount === 1 ? '' : 's'}
          </span>
        </li>
      {/each}
    </ul>
    <p class="membership-note">
      Read-only visibility. Open the Files tab to inspect, upload into, or download a workspace.
    </p>
  {/if}
</div>
