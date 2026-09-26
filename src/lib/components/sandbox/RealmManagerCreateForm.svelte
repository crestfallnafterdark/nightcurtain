<script>
  /**
   * Realm Manager create form (realm manager redesign, ticket ca33e1b): the
   * compact rail form that creates one Realm record.
   *
   * The form owns its draft and validates the shared rules inline — a Realm
   * name is required, and the launcher's duplicate-name guard (trimmed,
   * case-insensitive; ticket b309e02) rejects a name already carried by a
   * registered record, so both creation surfaces behave the same. The store
   * call stays with the manager composition root; a successful create clears
   * the draft and lets the root collapse the form.
   */
  import { isRealmNameTaken } from './realmLauncherHelpers.ts';

  /**
   * @type {{
   *   realms: import('../../sandbox/realmRegistry/index.ts').RealmRecord[],
   *   oncreate: (input: { name: string, description: string, color: string }) => boolean,
   *   oncancel?: (() => void) | null,
   *   onlaunchtemplate: () => void
   * }}
   */
  let { realms, oncreate, oncancel = null, onlaunchtemplate } = $props();

  let newName = $state('');
  let newDescription = $state('');
  let newColor = $state('#7c9cff');
  let error = $state('');

  /** Validates the draft inline, then hands the store call to the root. */
  function handleSubmit(event) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) {
      error = 'A Realm name is required.';
      return;
    }
    // The launcher wizard and this manager share one duplicate-name guard
    // (trimmed, case-insensitive) so both creation paths behave the same.
    if (isRealmNameTaken(name, realms)) {
      error = `A Realm named "${name}" already exists — pick a different name.`;
      return;
    }
    error = '';
    const created = oncreate({ name, description: newDescription, color: newColor });
    if (created) {
      newName = '';
      newDescription = '';
      newColor = '#7c9cff';
    }
  }
</script>

<form class="settings-section-card create-card" onsubmit={handleSubmit} novalidate>
  <div class="section-card-header">
    <div class="section-title-wrap">
      <span class="section-badge">New</span>
      <h4 class="section-title">Create Realm</h4>
    </div>
  </div>
  {#if error}
    <p class="create-error" role="alert">{error}</p>
  {/if}
  <div class="form-group">
    <label for="realm-new-name">Name</label>
    <input
      id="realm-new-name"
      type="text"
      bind:value={newName}
      placeholder="e.g. Story Realm"
      class="input-field"
      oninput={() => (error = '')}
    />
  </div>
  <div class="form-group color-group">
    <label for="realm-new-color">Color</label>
    <input id="realm-new-color" type="color" bind:value={newColor} class="color-input" />
  </div>
  <div class="form-group">
    <label for="realm-new-description">Description <span class="opt">(optional)</span></label>
    <input
      id="realm-new-description"
      type="text"
      bind:value={newDescription}
      placeholder="Operator note for this group"
      class="input-field"
      oninput={() => (error = '')}
    />
  </div>
  <div class="section-actions">
    {#if oncancel}
      <button type="button" class="btn-secondary" onclick={() => oncancel()}>Cancel</button>
    {/if}
    <button type="button" class="btn-secondary" onclick={() => onlaunchtemplate()}>Launch from Template…</button>
    <button type="submit" class="btn-primary">Create Realm</button>
  </div>
</form>
