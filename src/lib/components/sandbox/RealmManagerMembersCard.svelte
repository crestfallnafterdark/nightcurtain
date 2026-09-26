<script>
  /**
   * Realm Manager members card (realm manager redesign, ticket ca33e1b): the
   * selected Realm's active and recycled members.
   *
   * Read-only by design: Realm membership is immutable after launch, so the
   * card never moves or removes members — it lists them (active first, then
   * recycled with their badge) and states the terminate + relaunch rule.
   */
  /**
   * @type {{
   *   activeMembers: ReadonlyArray<{ id: string, name?: string }>,
   *   recycledMembers: ReadonlyArray<{ id: string, name?: string }>
   * }}
   */
  let { activeMembers, recycledMembers } = $props();

  let hasRecycledMembers = $derived(recycledMembers.length > 0);
</script>

<div class="settings-section-card">
  <div class="section-card-header">
    <div class="section-title-wrap">
      <span class="section-badge">Members</span>
      <h4 class="section-title">Members ({activeMembers.length})</h4>
    </div>
  </div>

  {#if activeMembers.length === 0}
    <p class="members-empty">No active agents in this Realm.</p>
  {:else}
    <ul class="member-list">
      {#each activeMembers as member (member.id)}
        <li class="member-row">
          <div class="member-info">
            <span class="member-name">{member.name || member.id}</span>
            <span class="member-id font-mono">{member.id}</span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  {#if hasRecycledMembers}
    <div class="recycled-note">
      <span class="recycled-label">Recycled members</span>
      <ul class="member-list recycled-list">
        {#each recycledMembers as member (member.id)}
          <li class="member-row">
            <div class="member-info">
              <span class="member-name">{member.name || member.id}</span>
              <span class="member-id font-mono">{member.id}</span>
            </div>
            <span class="recycled-chip font-mono">recycled</span>
          </li>
        {/each}
      </ul>
      <p class="recycled-hint">Recycled members stay in this Realm; the recursive Realm deletion permanently deletes them.</p>
    </div>
  {/if}

  <p class="membership-note">
    Realm membership is fixed at launch. To change an agent's Realm, terminate it and relaunch it into the target Realm.
  </p>
</div>
