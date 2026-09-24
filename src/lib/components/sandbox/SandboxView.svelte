<script>
  import { sandboxStore } from '../../sandbox/sandboxStore/index.svelte.ts';
  import SandboxChatLog from './SandboxChatLog.svelte';
  import SandboxActionInput from './SandboxActionInput.svelte';
  import AgentLauncherModal from './AgentLauncherModal.svelte';
  import SandboxSettingsModal from './SandboxSettingsModal.svelte';
  import AgentInspector from './AgentInspector.svelte';
  import VirtualFsExplorer from './VirtualFsExplorer.svelte';
  import MessagingBusViewer from './MessagingBusViewer.svelte';
  import AgentSettingsPanel from './AgentSettingsPanel.svelte';
  import RecycleBinModal from './RecycleBinModal.svelte';
  import RealmSettingsModal from './RealmSettingsModal.svelte';
  import RealmLauncherModal from './RealmLauncherModal.svelte';
  import RealmRehydrateModal from './RealmRehydrateModal.svelte';
  import {
    DIRECTOR_GROUP_KEY,
    DIRECTOR_GROUP_LABEL,
    groupAgentsByRealm,
    isDirectorAgent,
    safeRealmColor,
    selectPinnedDirector
  } from './realmGroups.ts';

  let showLauncherModal = $state(false);
  let showSettingsModal = $state(false);
  let showRecycleBinModal = $state(false);
  let showRealmModal = $state(false);
  let showRealmLauncherModal = $state(false);
  // Realm targeted by the rehydrate/replace modal opened from the Realm manager.
  let rehydrateRealmId = $state('');
  // Optional Realm preselected when the Realm manager opens ('' = none).
  let realmSettingsTargetId = $state('');
  let collapsedRealmKeys = $state({});
  let agentSearchFilter = $state('');

  // Derived telemetry stats
  let stats = $derived(sandboxStore.stats);

  // Tab rail element (used to keep the active tab scrollable into view on narrow screens)
  let tabBarEl = $state(null);

  $effect(() => {
    const activeTab = sandboxStore.activeTab;
    if (!tabBarEl || !activeTab) return;
    tabBarEl.querySelector('.tab-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  // Filtered agent list for left drawer
  let filteredAgents = $derived.by(() => {
    const list = sandboxStore.agents;
    const query = agentSearchFilter.trim().toLowerCase();
    if (!query) return list;
    return list.filter(a =>
      a.id.toLowerCase().includes(query) ||
      (a.name && a.name.toLowerCase().includes(query)) ||
      (a.config?.role && a.config.role.toLowerCase().includes(query))
    );
  });

  // Wave A (d13a038) + Wave R (56ba4b9) + I2 (93243cc): every agent renders
  // under its Realm (the seeded Generic default included) and only the
  // system-scope director is pinned on top as a separate entity — a realm-local
  // agent named `director` is an ordinary realm member. While searching, empty
  // groups are dropped so matches stay visible; the pinned director follows the
  // filter.
  let directorAgent = $derived(selectPinnedDirector(filteredAgents));
  let nonDirectorAgents = $derived(filteredAgents.filter((ag) => !isDirectorAgent(ag)));
  let realmGroups = $derived.by(() => {
    const groups = groupAgentsByRealm(filteredAgents, sandboxStore.realms);
    if (!agentSearchFilter.trim()) return groups;
    const matched = groups.filter(group => group.agents.length > 0);
    return matched.length > 0 ? matched : groups;
  });

  function toggleRealmGroup(key) {
    collapsedRealmKeys = { ...collapsedRealmKeys, [key]: !collapsedRealmKeys[key] };
  }

  function isRealmGroupCollapsed(key) {
    if (agentSearchFilter.trim()) return false;
    return Boolean(collapsedRealmKeys[key]);
  }

  /**
   * Opens the Realm manager, optionally focused on one Realm.
   *
   * @param {string} [realmId] - Realm to preselect; omit or pass an empty string for none.
   */
  function openRealmSettings(realmId = '') {
    realmSettingsTargetId = realmId;
    showRealmModal = true;
  }

  function closeRealmSettings() {
    showRealmModal = false;
    realmSettingsTargetId = '';
  }

  function handleReset() {
    if (confirm('Reset entire sandbox studio? This will terminate all agents, clear VirtualFS files, reset messaging logs, and restore the default Director.')) {
      sandboxStore.factoryReset();
    }
  }

  function handleTerminateAgent(ag) {
    if (!ag) return;
    const ok = confirm(`Terminate agent "${ag.name || ag.id}" and move to Recycle Bin?\n\nThe agent will be soft-killed and moved to the Recycle Bin. You can restore it later with full conversation history preserved.`);
    if (ok) {
      // Defect 7d2c314: address the exact registration, never a bare-id twin.
      sandboxStore.killAgent(ag.identityKey, 'Terminated by user');
    }
  }

  async function handleSendChat(text, category) {
    try {
      await sandboxStore.submitChatTurn(text, category);
    } catch (err) {
      console.error('Chat turn failed:', err);
    }
  }
</script>

{#snippet agentCard(ag)}
  <div
    class="agent-card"
    class:selected={sandboxStore.selectedAgent?.identityKey === ag.identityKey}
    role="button"
    tabindex="0"
    onclick={() => sandboxStore.selectAgent(ag.identityKey)}
    onkeydown={(e) => { if (e.key === 'Enter') sandboxStore.selectAgent(ag.identityKey); }}
  >
    <div class="card-top">
      <div class="agent-name-line">
        <div class="agent-name-row">
          <span class="agent-card-name">{ag.name}</span>
          {#if ag.config?.privileged}
            <span class="sudo-tag font-mono" title="Universal Administrative / Sudo Authority">⚡ sudo</span>
          {/if}
        </div>
        <span class="agent-card-id font-mono">{ag.id}</span>
      </div>
      <span class="state-chip state-{ag.state} font-mono">
        {ag.state}
      </span>
    </div>

    {#if ag.config?.role}
      <p class="agent-card-role">{ag.config.role}</p>
    {/if}

    <div class="card-bottom">
      <span class="card-pill font-mono">{ag.turnCount} turns</span>
      {#if (ag.unreadCount || 0) > 0}
        <span class="card-pill unread-badge font-mono" title="{ag.unreadCount} unread message(s)">
          ✉ {ag.unreadCount}
        </span>
      {/if}
      <button
        type="button"
        class="btn-terminate-mini"
        onclick={(e) => { e.stopPropagation(); handleTerminateAgent(ag); }}
        title="Terminate agent '{ag.name || ag.id}'"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
      {#if ag.state === 'running'}
        <button
          type="button"
          class="btn-cancel-mini"
          onclick={(e) => { e.stopPropagation(); sandboxStore.cancelAgent(ag.identityKey); }}
          title="Cancel active turn"
        >
          Cancel
        </button>
      {/if}
    </div>
  </div>
{/snippet}

<div class="sandbox-studio-root">
  <!-- Top Navigation & Telemetry Bar -->
  <header class="studio-header glass-panel">
    <div class="header-left">
      <div class="studio-brand">
        <div class="brand-chip">
          <svg class="icon-svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
            <line x1="8" y1="21" x2="16" y2="21" />
            <line x1="12" y1="17" x2="12" y2="21" />
          </svg>
        </div>
        <div>
          <h1 class="studio-title">Agentic Sandbox Studio</h1>
          <span class="studio-sub">Conversational Studio & Observability (Layer 3)</span>
        </div>
      </div>

      <!-- Telemetry KPI Chips -->
      <div class="telemetry-bar">
        <div class="kpi-chip" title="Total active agents in runtime">
          <span class="kpi-label">Agents</span>
          <span class="kpi-val font-mono">{stats.total}</span>
        </div>
        <div class="kpi-chip" title="Currently running turns">
          <span class="kpi-label">Running</span>
          <span class="kpi-val font-mono" class:running-active={stats.running > 0}>{stats.running}</span>
        </div>
        <div class="kpi-chip" title="Messages routed through MessagingBus">
          <span class="kpi-label">Messages</span>
          <span class="kpi-val font-mono">{stats.totalMessages}</span>
        </div>
        <div class="kpi-chip" title="VirtualFS files across all workspaces">
          <span class="kpi-label">Files</span>
          <span class="kpi-val font-mono">{stats.totalFiles}</span>
        </div>
        <div class="kpi-chip" title="Active scheduled timers in runtime">
          <span class="kpi-label">Timers</span>
          <span class="kpi-val font-mono" class:running-active={(stats.activeTimers || 0) > 0}>{stats.activeTimers || 0}</span>
        </div>
      </div>
    </div>

    <div class="header-actions">
      <button
        type="button"
        class="btn-secondary btn-settings-header"
        onclick={() => showSettingsModal = true}
        title="Model Presets & Provider Credentials"
      >
        <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>Settings</span>
      </button>

      <button type="button" class="btn-secondary" onclick={handleReset} title="Reset all agents, files, and messages">
        <span>Reset</span>
      </button>
    </div>
  </header>

  <!-- Main Workstation Layout -->
  <div class="studio-main-workstation">
    <!-- Left Drawer: Agent List -->
    <aside class="agent-drawer glass-panel">
      <div class="drawer-header">
        <h2 class="drawer-title">
          <span>Active Agents</span>
          <span class="badge-count font-mono">{filteredAgents.length}</span>
        </h2>
        <div class="drawer-header-actions">
          <button
            type="button"
            class="btn-icon-subtle"
            onclick={() => showRealmLauncherModal = true}
            title="Launch Realm from Template"
            aria-label="Launch Realm from Template"
          >
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
              <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
              <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
              <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
            </svg>
          </button>
          <button
            type="button"
            class="btn-icon-subtle"
            onclick={() => openRealmSettings()}
            title="Manage Realms ({sandboxStore.realms.length})"
            aria-label="Manage Realms"
          >
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
            {#if sandboxStore.realms.length > 0}
              <span class="badge-realm-count font-mono">{sandboxStore.realms.length}</span>
            {/if}
          </button>
          <button
            type="button"
            class="btn-icon-subtle"
            onclick={() => showRecycleBinModal = true}
            title="Recycle Bin ({sandboxStore.recycleBinCount} soft-killed agents)"
            aria-label="Recycle Bin"
          >
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"></polyline>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
            {#if sandboxStore.recycleBinCount > 0}
              <span class="badge-recycle-dot" title="{sandboxStore.recycleBinCount} in Recycle Bin"></span>
            {/if}
          </button>
          <button
            type="button"
            class="btn-add-icon"
            onclick={() => showLauncherModal = true}
            title="Launch Agent"
            aria-label="Launch Agent"
          >
            <svg class="icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </div>
      </div>

      <div class="drawer-search">
        <input
          type="text"
          bind:value={agentSearchFilter}
          placeholder="Filter agents..."
          class="drawer-search-input"
        />
      </div>

      <div class="agents-list">
        {#if filteredAgents.length === 0}
          <div class="empty-agents-drawer">
            <p>No agents registered.</p>
            <button type="button" class="btn-primary btn-sm" onclick={() => showLauncherModal = true}>
              + Launch Agent
            </button>
          </div>
        {:else}
          {#if directorAgent}
            <section class="realm-group director-pinned">
              <div class="realm-group-header">
                <button
                  type="button"
                  class="realm-toggle"
                  onclick={() => toggleRealmGroup(DIRECTOR_GROUP_KEY)}
                  aria-expanded={!isRealmGroupCollapsed(DIRECTOR_GROUP_KEY)}
                  title={isRealmGroupCollapsed(DIRECTOR_GROUP_KEY) ? 'Expand Director' : 'Collapse Director'}
                >
                  <svg class="realm-caret" class:collapsed={isRealmGroupCollapsed(DIRECTOR_GROUP_KEY)} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                  <span class="realm-dot director-dot"></span>
                  <span class="realm-name">{DIRECTOR_GROUP_LABEL}</span>
                  <span class="director-chip font-mono">SYSTEM SCOPE</span>
                  <span class="realm-member-count font-mono">1</span>
                </button>
              </div>
              {#if !isRealmGroupCollapsed(DIRECTOR_GROUP_KEY)}
                <div class="realm-members">
                  {@render agentCard(directorAgent)}
                </div>
              {/if}
            </section>
          {/if}
          {#if realmGroups.length > 0}
            {#each realmGroups as group (group.key)}
            {@const realm = group.realm}
            <section class="realm-group" class:synthetic={realm === null}>
              <div class="realm-group-header">
                <button
                  type="button"
                  class="realm-toggle"
                  onclick={() => toggleRealmGroup(group.key)}
                  aria-expanded={!isRealmGroupCollapsed(group.key)}
                  title={isRealmGroupCollapsed(group.key) ? 'Expand Realm' : 'Collapse Realm'}
                >
                  <svg class="realm-caret" class:collapsed={isRealmGroupCollapsed(group.key)} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                  <span
                    class="realm-dot"
                    style="background: {realm ? (safeRealmColor(realm.color) ?? 'var(--text-muted)') : 'var(--text-muted)'}"
                  ></span>
                  <span class="realm-name">{group.label}</span>
                  <span class="realm-member-count font-mono">{group.agents.length}</span>
                </button>
                {#if realm}
                  <button
                    type="button"
                    class="btn-realm-edit"
                    onclick={() => openRealmSettings(realm.id)}
                    title="Realm settings for '{realm.name}'"
                    aria-label="Realm settings for {realm.name}"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <circle cx="12" cy="12" r="3"/>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                    </svg>
                  </button>
                {/if}
              </div>
              {#if !isRealmGroupCollapsed(group.key)}
                <div class="realm-members">
                  {#if group.agents.length === 0}
                    <p class="empty-realm-hint">No agents in this Realm.</p>
                  {:else}
                    {#each group.agents as ag (ag.id)}
                      {@render agentCard(ag)}
                    {/each}
                  {/if}
                </div>
              {/if}
            </section>
          {/each}
          {:else}
            {#each nonDirectorAgents as ag (ag.id)}
              {@render agentCard(ag)}
            {/each}
          {/if}
        {/if}
      </div>
    </aside>

    <!-- Center/Right Area: Tab Switcher & Views -->
    <main class="studio-content-area">
      <!-- Tab Navigation -->
      <nav class="studio-tab-bar glass-panel" bind:this={tabBarEl}>
        <button
          type="button"
          class="tab-btn"
          class:active={sandboxStore.activeTab === 'chat'}
          onclick={() => sandboxStore.setActiveTab('chat')}
        >
          <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span>Chat Studio</span>
          {#if sandboxStore.selectedAgent}
            <span class="tab-target-badge font-mono">{sandboxStore.selectedAgent.id}</span>
          {/if}
        </button>

        <button
          type="button"
          class="tab-btn"
          class:active={sandboxStore.activeTab === 'settings'}
          onclick={() => sandboxStore.setActiveTab('settings')}
        >
          <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
          <span>Agent Settings</span>
        </button>

        <button
          type="button"
          class="tab-btn"
          class:active={sandboxStore.activeTab === 'inspector'}
          onclick={() => sandboxStore.setActiveTab('inspector')}
        >
          <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M12 16v-4" /><path d="M12 8h.01" />
          </svg>
          <span>Telemetry & Trace</span>
        </button>

        <button
          type="button"
          class="tab-btn"
          class:active={sandboxStore.activeTab === 'filesystem'}
          onclick={() => sandboxStore.setActiveTab('filesystem')}
        >
          <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
          </svg>
          <span>Virtual Filesystem</span>
          <span class="tab-count font-mono">{stats.totalFiles}</span>
        </button>

        <button
          type="button"
          class="tab-btn"
          class:active={sandboxStore.activeTab === 'messaging'}
          onclick={() => sandboxStore.setActiveTab('messaging')}
        >
          <svg class="icon-svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="20" height="16" x="2" y="4" rx="2" /><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
          </svg>
          <span>Messaging Bus</span>
          <span class="tab-count font-mono">{stats.totalMessages}</span>
        </button>
      </nav>

      <!-- Tab View Dynamic Rendering -->
      <div class="studio-view-pane">
        {#if sandboxStore.activeTab === 'chat'}
          <div class="chat-studio-pane">
            <SandboxChatLog
              agent={sandboxStore.selectedAgent}
              messages={sandboxStore.agentMessages}
              isStreaming={sandboxStore.isAgentStreaming}
              streamingProse={sandboxStore.streamingProse}
              streamingReasoning={sandboxStore.streamingReasoning}
              activeToolCalls={sandboxStore.activeToolCalls}
              onSendTurn={handleSendChat}
              onEditAgent={() => sandboxStore.setActiveTab('settings')}
            />
            <SandboxActionInput
              agentId={sandboxStore.selectedAgent?.identityKey}
              disabled={!sandboxStore.selectedAgent || sandboxStore.selectedAgent?.state === 'terminated'}
              isLoading={sandboxStore.isAgentStreaming}
              hasInterruptedTurn={sandboxStore.isAgentInterrupted(sandboxStore.selectedAgent?.identityKey)}
              hasHistory={Boolean(sandboxStore.selectedAgent?.history && sandboxStore.selectedAgent.history.length > 0)}
              onSend={handleSendChat}
              onCancel={() => sandboxStore.cancelActiveTurn()}
              onResend={() => sandboxStore.retryAgentTurn(sandboxStore.selectedAgent?.identityKey)}
              onUndo={() => sandboxStore.undoAgentTurn(sandboxStore.selectedAgent?.identityKey)}
            />
          </div>
        {:else if sandboxStore.activeTab === 'settings'}
          <AgentSettingsPanel />
        {:else if sandboxStore.activeTab === 'inspector'}
          <AgentInspector onEditAgent={() => sandboxStore.setActiveTab('settings')} />
        {:else if sandboxStore.activeTab === 'filesystem'}
          <VirtualFsExplorer />
        {:else if sandboxStore.activeTab === 'messaging'}
          <MessagingBusViewer />
        {/if}
      </div>
    </main>
  </div>

  <!-- Agent Launcher Modal -->
  {#if showLauncherModal}
    <AgentLauncherModal onclose={() => showLauncherModal = false} />
  {/if}

  <!-- Agent Recycle Bin Modal (EPIC-19) -->
  {#if showRecycleBinModal}
    <RecycleBinModal
      isOpen={showRecycleBinModal}
      onClose={() => showRecycleBinModal = false}
      onclose={() => showRecycleBinModal = false}
    />
  {/if}

  <!-- Sandbox Settings Modal (model presets & credential vault) -->
  {#if showSettingsModal}
    <SandboxSettingsModal onclose={() => showSettingsModal = false} />
  {/if}

  <!-- Realm Manager Modal (Wave A grouping + membership) -->
  {#if showRealmModal}
    <RealmSettingsModal
      realmId={realmSettingsTargetId || null}
      onclose={closeRealmSettings}
      onlaunchtemplate={() => { closeRealmSettings(); showRealmLauncherModal = true; }}
      onrehydrate={(realm) => { closeRealmSettings(); rehydrateRealmId = realm.id; }}
    />
  {/if}

  <!-- Realm Launcher Modal (Wave B template launch + seed wizard) -->
  {#if showRealmLauncherModal}
    <RealmLauncherModal onclose={() => showRealmLauncherModal = false} />
  {/if}

  <!-- Realm Rehydrate Modal (ticket 874182b reopen/replace flow) -->
  {#if rehydrateRealmId}
    <RealmRehydrateModal realmId={rehydrateRealmId} onclose={() => rehydrateRealmId = ''} />
  {/if}
</div>

<style>
  .sandbox-studio-root {
    width: 100vw;
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-base);
    color: var(--text-primary);
  }

  .studio-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.85rem 1.5rem;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
    z-index: 20;
    flex-shrink: 0;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .studio-brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .brand-chip {
    width: 36px;
    height: 36px;
    border-radius: 8px;
    background: var(--accent-primary-subtle);
    border: 1px solid var(--accent-primary-border);
    color: var(--accent-primary);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .studio-title {
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0;
    line-height: 1.2;
  }

  .studio-sub {
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .telemetry-bar {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .kpi-chip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    padding: 0.25rem 0.6rem;
    border-radius: 6px;
    font-size: 0.75rem;
  }

  .kpi-label {
    color: var(--text-muted);
    font-weight: 500;
  }

  .kpi-val {
    font-weight: 700;
    color: var(--text-primary);
  }

  .kpi-val.running-active {
    color: var(--accent-warning);
    animation: pulse 1.2s infinite;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .btn-settings-header {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .btn-terminate-mini {
    margin-left: auto;
    background: transparent;
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #f87171;
    border-radius: 4px;
    padding: 0.15rem 0.35rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .btn-terminate-mini:hover {
    color: #ef4444;
    border-color: #ef4444;
    background: rgba(239, 68, 68, 0.15);
  }

  .studio-main-workstation {
    flex: 1;
    display: flex;
    min-height: 0;
    overflow: hidden;
  }

  .agent-drawer {
    width: 320px;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-color);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    overflow: hidden;
  }

  .drawer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.9rem 1.1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .drawer-title {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--text-primary);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
  }

  .badge-count {
    font-size: 0.72rem;
    background: var(--bg-surface);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: var(--text-secondary);
  }

  .drawer-header-actions {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .btn-icon-subtle {
    position: relative;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-secondary);
    width: 26px;
    height: 26px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .btn-icon-subtle:hover {
    background: var(--bg-surface-hover);
    color: var(--text-primary);
    border-color: var(--border-focus, var(--accent-primary));
  }

  .badge-recycle-dot {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #f59e0b;
    box-shadow: 0 0 4px rgba(245, 158, 11, 0.8);
  }

  .btn-add-icon {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    width: 26px;
    height: 26px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }

  .drawer-search {
    padding: 0.6rem 1.1rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .drawer-search-input {
    width: 100%;
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    color: var(--text-primary);
    padding: 0.35rem 0.6rem;
    border-radius: 6px;
    font-size: 0.8rem;
  }

  .agents-list {
    flex: 1;
    overflow-y: auto;
    padding: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .empty-agents-drawer {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--text-muted);
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .badge-realm-count {
    position: absolute;
    top: -5px;
    right: -5px;
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    border-radius: 7px;
    background: var(--accent-primary);
    color: #fff;
    font-size: 0.58rem;
    line-height: 14px;
    text-align: center;
  }

  .realm-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .realm-group-header {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .realm-toggle {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.45rem;
    background: var(--bg-base);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 0.35rem 0.55rem;
    color: var(--text-secondary);
    cursor: pointer;
    min-width: 0;
  }

  .realm-toggle:hover {
    color: var(--text-primary);
    border-color: var(--border-hover);
  }

  .realm-caret {
    flex-shrink: 0;
    transition: transform 0.15s ease;
  }

  .realm-caret.collapsed {
    transform: rotate(-90deg);
  }

  .realm-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    flex-shrink: 0;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.12);
  }

  .realm-name {
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .realm-member-count {
    margin-left: auto;
    font-size: 0.68rem;
    color: var(--text-muted);
    background: var(--bg-surface);
    border-radius: 4px;
    padding: 0.05rem 0.35rem;
    flex-shrink: 0;
  }

  .btn-realm-edit {
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-muted);
    width: 24px;
    height: 24px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
  }

  .btn-realm-edit:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
    border-color: var(--border-color);
  }

  .realm-members {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding-left: 0.35rem;
    border-left: 2px solid var(--border-subtle);
  }

  .realm-group.synthetic .realm-toggle {
    border-style: dashed;
  }

  /* Director pinned entity: a distinct accent so the system scope never reads
     as just another Realm group (Wave R, ticket 56ba4b9). */
  .realm-group.director-pinned {
    border: 1px solid rgba(192, 132, 252, 0.4);
    background: rgba(192, 132, 252, 0.07);
    border-radius: 8px;
    padding: 0.45rem;
    margin-bottom: 0.35rem;
  }

  .realm-group.director-pinned .realm-toggle {
    background: transparent;
    border-color: transparent;
    color: #d8b4fe;
  }

  .director-dot {
    background: #c084fc;
  }

  .director-chip {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    padding: 0.08rem 0.35rem;
    border-radius: 4px;
    color: #d8b4fe;
    background: rgba(192, 132, 252, 0.16);
    border: 1px solid rgba(192, 132, 252, 0.35);
    flex-shrink: 0;
  }

  .empty-realm-hint {
    margin: 0;
    padding: 0.35rem 0.5rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .agent-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-color);
    border-radius: 8px;
    padding: 0.75rem;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .agent-card:hover {
    border-color: var(--border-hover);
    background: var(--bg-surface-elevated);
  }

  .agent-card.selected {
    border-color: var(--accent-primary);
    background: var(--accent-primary-subtle);
  }

  .card-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }

  .agent-name-line {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }

  .agent-name-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .sudo-tag {
    font-size: 0.62rem;
    padding: 0.08rem 0.35rem;
    border-radius: 3px;
    background: rgba(245, 158, 11, 0.18);
    color: #f59e0b;
    border: 1px solid rgba(245, 158, 11, 0.4);
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
  }

  .agent-card-name {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .agent-card-id {
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .state-chip {
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    background: var(--bg-base);
  }

  .state-chip.state-running {
    color: var(--accent-warning);
    background: var(--accent-warning-subtle);
  }

  .state-chip.state-idle {
    color: var(--accent-success);
  }

  .state-chip.state-errored {
    color: var(--accent-danger);
    background: var(--accent-danger-subtle);
  }

  .agent-card-role {
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin: 0;
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-bottom {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding-top: 0.35rem;
    border-top: 1px solid var(--border-subtle);
  }

  .card-pill {
    font-size: 0.68rem;
    color: var(--text-muted);
    background: var(--bg-base);
    padding: 0.1rem 0.35rem;
    border-radius: 3px;
  }

  .card-pill.unread-badge {
    color: #f59e0b;
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.3);
    font-weight: 600;
  }

  .btn-cancel-mini {
    margin-left: auto;
    background: transparent;
    border: 1px solid var(--accent-danger-border);
    color: #f87171;
    border-radius: 4px;
    font-size: 0.68rem;
    padding: 0.1rem 0.4rem;
    cursor: pointer;
  }

  .studio-content-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    background: var(--bg-base);
  }

  .studio-tab-bar {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.6rem 1.25rem;
    border-bottom: 1px solid var(--border-color);
    background: var(--bg-secondary);
    flex-shrink: 0;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--border-color) transparent;
  }

  .studio-tab-bar::-webkit-scrollbar {
    height: 6px;
  }

  .studio-tab-bar::-webkit-scrollbar-thumb {
    background: var(--border-color);
    border-radius: 3px;
  }

  .studio-tab-bar::-webkit-scrollbar-track {
    background: transparent;
  }

  .tab-btn {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 0.85rem;
    font-weight: 500;
    transition: all 0.15s;
    flex-shrink: 0;
    white-space: nowrap;
  }

  .tab-btn:hover {
    color: var(--text-primary);
    background: var(--bg-surface);
  }

  .tab-btn.active {
    color: var(--text-primary);
    background: var(--bg-surface-elevated);
    border-color: var(--border-color);
    font-weight: 600;
  }

  .tab-target-badge {
    font-size: 0.7rem;
    background: var(--accent-primary-subtle);
    color: var(--accent-primary);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .tab-count {
    font-size: 0.7rem;
    background: var(--bg-base);
    color: var(--text-muted);
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }

  .studio-view-pane {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .chat-studio-pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .spinner-sm {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: currentColor;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  @media (max-width: 860px) {
    .studio-main-workstation {
      flex-direction: column;
    }
    .agent-drawer {
      width: 100%;
      max-height: 200px;
    }
    .studio-tab-bar {
      padding: 0.5rem 0.75rem;
    }
  }
</style>
