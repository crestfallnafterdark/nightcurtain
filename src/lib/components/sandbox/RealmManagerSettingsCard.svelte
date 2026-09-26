<script>
  /**
   * Realm Manager settings card (realm manager redesign, ticket ca33e1b):
   * rename, recolor, and describe the selected Realm.
   *
   * The card owns its edit draft and reseeds it from the selected record
   * (including after each selection change), so a half-typed draft never
   * leaks across Realms. Validation and the store call stay with the manager
   * composition root; a failed save keeps the draft and surfaces the root's
   * inline error banner.
   */
  import { safeRealmColor } from './realmGroups.ts';

  /**
   * @type {{
   *   realm: import('../../sandbox/realmRegistry/index.ts').RealmRecord,
   *   onsave: (input: { name: string, description: string, color: string }) => boolean
   * }}
   */
  let { realm, onsave } = $props();

  let draftName = $state('');
  let draftDescription = $state('');
  let draftColor = $state('#7c9cff');

  let accent = $derived(safeRealmColor(realm.color));

  // Seed and reseed the edit draft from the selected record; the store returns
  // frozen records, so identity changes exactly when this Realm's fields
  // change. The effect also performs the mount-time seed.
  $effect(() => {
    const record = realm;
    draftName = record.name;
    draftDescription = record.description ?? '';
    draftColor = safeRealmColor(record.color) ?? '#7c9cff';
  });

  /** Hands the trimmed draft to the root's save path. */
  function handleSubmit(event) {
    event.preventDefault();
    onsave({ name: draftName, description: draftDescription, color: draftColor });
  }
</script>

<form class="settings-section-card" onsubmit={handleSubmit} novalidate>
  <div class="section-card-header">
    <div class="section-title-wrap">
      <span class="section-badge" style="border-color: {accent ?? 'var(--border-color)'}">Settings</span>
      <h4 class="section-title">{realm.name}</h4>
    </div>
    <span class="realm-id font-mono">{realm.id}</span>
  </div>
  <div class="create-grid">
    <div class="form-group grow">
      <label for="realm-edit-name">Name</label>
      <input id="realm-edit-name" type="text" bind:value={draftName} class="input-field" />
    </div>
    <div class="form-group color-group">
      <label for="realm-edit-color">Color</label>
      <input id="realm-edit-color" type="color" bind:value={draftColor} class="color-input" />
    </div>
  </div>
  <div class="form-group">
    <label for="realm-edit-description">Description <span class="opt">(optional)</span></label>
    <input
      id="realm-edit-description"
      type="text"
      bind:value={draftDescription}
      placeholder="Operator note for this group"
      class="input-field"
    />
  </div>
  <div class="section-actions">
    <button type="submit" class="btn-primary">Save Settings</button>
  </div>
</form>
