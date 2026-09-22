# Requirements: Sandbox Resilience, Turn Rollback Integrity & UI Fidelity

**Status:** RATIFIED  
**Last verified:** 2026-09-22  
**Version:** 1.1 (Updated with Playwright E2E Forensic Discoveries)  
**Date:** 2026-09-14  
**Scope Owner:** Product Owner & Core System Architect  
**Related Systems:** `src/lib/sandbox/virtualFs/index.ts`, `src/lib/sandbox/runtime/index.ts`, `src/lib/sandbox/sandboxStore/index.svelte.ts`, `src/lib/components/sandbox/`, `src/lib/components/sandbox/SandboxSettingsModal.svelte`, `tests/e2e/`

---

## 1. Purpose & Problem Statement

This document codifies the technical and behavioral requirements for resolving critical defects discovered during subsystem integration and Playwright E2E browser audits across sandbox state resilience, undo/redo lifecycles, draft persistence, settings synchronization, modal legibility, and mobile responsiveness:

1. **Un-reverted File Mutations on Turn Undo/Redo**: `undoAgentTurn` only pops conversation messages from `agent.history`, leaving files created, replaced, or patched during that turn behind in `VirtualFS`.
2. **Missing Redo Button & Shortcuts in Primary UI (BUG-02)**: The Redo button exists only in the hidden inspector panel; it is completely absent from the main chat toolbar (`SandboxActionInput`) and conversation log (`SandboxChatLog`). The `Ctrl+Y` shortcut is missing.
3. **Cross-Agent Draft Text Leakage (BUG-01)**: `SandboxActionInput` manages prompt text in local component state rather than binding to `sandboxStore.drafts[agentId]`, causing unsubmitted draft text typed for Agent A to leak into Agent B when switching agents.
4. **SettingsModal Drift vs. AgentEditModal (historical; both components retired)**: `SettingsModal` lacked modern inference controls present in `AgentEditModal` (reasoning effort selector, updated model catalog, provider routing, and service tiers). The surviving surface is the catalog-driven `SandboxSettingsModal`.
5. **Broken Model Inheritance**: Agents configured with `model: 'inherit'` or `vendor: 'inherit'` send the literal string `'inherit'` to provider APIs, causing provider validation errors.
6. **Modal Background Translucency Bleed-Through (BUG-03; historical component names)**: `SettingsModal` and `AgentEditModal` rendered with translucent `.glass-panel` backdrops, causing background cards, chat text, and headers to bleed through and degrade legibility.
7. **Mobile Header Overcrowding & Static Drawer Stacking (BUG-04)**: On mobile viewports ($\le 375\text{px}$), 8 header action buttons wrap across 4 rows occupying $>50\%$ of the screen height, and the `Active Agents` panel is statically stacked above chat.
8. **Action Micro-Toolbar Inaccessibility on Touch (BUG-05)**: Message action buttons in `SandboxMessageCard` rely on CSS `:hover` with `opacity: 0; pointer-events: none`, rendering them inaccessible on touchscreen devices without hover.

---

## 2. Functional Requirements

### 2.1 Turn-Level Filesystem Mutation Rollback (FS-ROLLBACK)

* **FS-ROLL-1 — Pre-Turn File State Journaling**:
  * When an agent turn begins (or before any mutating tool call: `writeFile`, `replaceFileContent`, `jsonPatch`, `deleteFile`, `copyFile` executes), `AgentRuntime` records the pre-mutation state of affected files (path, workspace, pre-mutation content, pre-mutation metadata, or `wasCreated: true`).
  * The file mutation journal is stored directly in the turn's `turnBundle` upon turn completion.
* **FS-ROLL-2 — Atomic File State Rollback on `undoAgentTurn`**:
  * When `undoAgentTurn(agentId)` is invoked:
    * Files modified during the undone turn are restored to their exact pre-turn content and metadata.
    * Files newly created during the undone turn are deleted from `VirtualFS`.
    * Files deleted during the undone turn are restored.
  * The post-turn file state is stored in `turnBundle.redoFileMutations` so redo can re-apply them.
* **FS-ROLL-3 — File State Reconstitution on `redoAgentTurn`**:
  * When `redoAgentTurn(agentId)` is invoked, all file states associated with that redone turn are re-applied to `VirtualFS` in lockstep with history messages.

---

### 2.2 Redo Button & Keyboard Shortcut Accessibility (UI-REDO / BUG-02)

* **UI-REDO-1 — Main Chat Input Redo Button**:
  * [`SandboxActionInput.svelte`](../../src/lib/components/sandbox/SandboxActionInput.svelte) must display a **Redo Turn** button alongside the Undo button in the action bar.
  * Displays the redo count badge when `agent.redoStack.length > 0` (e.g. `Redo (1)`).
  * Automatically disabled when `agent.redoStack` is empty or when the agent is currently running.
* **UI-REDO-2 — Conversation Log Redo Controls**:
  * [`SandboxChatLog.svelte`](../../src/lib/components/sandbox/SandboxChatLog.svelte) must display Redo controls in the bottom toolbar and within the Interrupted Turn card when redo is available.
* **UI-REDO-3 — Standard Keyboard Shortcuts**:
  * Support `Ctrl+Y` and `Ctrl+Shift+Z` in `SandboxActionInput.svelte` to trigger `redoAgentTurn` when input is empty and `redoStack` has items.

---

### 2.3 Per-Agent Saved Draft Input Persistence (DRAFT-SYNC / BUG-01)

* **DRAFT-1 — Direct Store Binding in `SandboxActionInput`**:
  * `SandboxActionInput.svelte` must bind its prompt text directly to `sandboxStore.getAgentDraft(selectedAgentId)`.
* **DRAFT-2 — Debounced Per-Agent Auto-Save**:
  * Any typing or text changes in `SandboxActionInput` must trigger `sandboxStore.setAgentDraft(selectedAgentId, text)` with debounced persistence.
* **DRAFT-3 — Seamless Agent Switch Hydration**:
  * When the user clicks a different agent in the sidebar or tabs, `SandboxActionInput` immediately loads the newly selected agent's draft text.
  * Switching from Agent A (with draft text) to Agent B (empty) must show an empty textarea for Agent B; switching back to Agent A immediately restores Agent A's draft.
* **DRAFT-4 — Undo Prompt Restoration**:
  * When `undoAgentTurn` is triggered, the undone user prompt text is automatically placed into the active agent's draft buffer in `SandboxActionInput`.
* **DRAFT-5 — Turn Send Draft Clearing**:
  * Successfully dispatching a turn clears the draft buffer for that specific agent.

---

### 2.4 SettingsModal & AgentEditModal Synchronization (SETTINGS-SYNC)

> **Historical component names (retired).** The parity work landed on the catalog-driven [`SandboxSettingsModal.svelte`](../../src/lib/components/sandbox/SandboxSettingsModal.svelte); the requirement below is preserved with current targets.

* **SETTINGS-1 — Parity of Inference Controls**:
  * [`SandboxSettingsModal.svelte`](../../src/lib/components/sandbox/SandboxSettingsModal.svelte) must expose the full inference surface through the preset catalog:
    * Global reasoning effort selector (`none`, `low`, `medium`, `high`, `max`, `xhigh`).
    * Full synchronized model catalog matching `PRESET_MODELS` / the catalog seeds.
    * Provider routing overrides (e.g., NanoGPT `aoro`/`flex`, `auto`).
    * Service tier configuration where the provider supports it.
* **SETTINGS-2 — Unified State Persistence**:
  * Preset edits saved in `SandboxSettingsModal` persist through the `presetCatalog` module (single writer); `sandboxStore.modelConfig` is a read-only projection of the active preset, and agents bind by `presetId`.

---

### 2.5 Deterministic Model & Config Inheritance (INHERIT-RESOLVE)

> **Historical (legacy surfaces retired):** The `model` / `vendor` scalar aliases and the literal `'inherit'` sentinel were retired; model identity now resolves solely through `binding-only` catalog presets: agents carry `presetId` and the preset's `AgentModelConfig` (`providerId` / `modelId` / `keyId`) is resolved at turn start. The defect narrative and acceptance criteria below are retained as historical design provenance.

* **INHERIT-1 — Zero Literal `'inherit'` Strings** (historical): In `src/lib/sandbox/runtime/` and `src/lib/sandbox/inference/`, any agent property set to `'inherit'` or left `undefined` (`model`, `providerVendor`, `reasoningEffort`, `temperature`, `apiKey`, `apiUrl`) had to be resolved dynamically against the then-current global settings; the literal string `'inherit'` must **NEVER** be passed to a provider API.
* **INHERIT-2 — Dynamic Reactive Cascading** (historical): When global settings changed in the legacy `SettingsModal`, agents configured with `'inherit'` immediately inherited the new model, vendor, and reasoning settings on their next turn. Current equivalent: a preset edit propagates to bound agents at their next turn start via the preset resolver.

---

### 2.6 Modal Visual Polish & Backdrop Parity (MODAL-VISUAL / BUG-03)

* **MODAL-VIS-1 — Solid Non-Bleeding Panel Surfaces**:
  * [`SandboxSettingsModal.svelte`](../../src/lib/components/sandbox/SandboxSettingsModal.svelte) and [`AgentLauncherModal.svelte`](../../src/lib/components/sandbox/AgentLauncherModal.svelte) must render with solid card backgrounds (`var(--bg-secondary)` / `rgb(20, 24, 33)`).
  * High-translucency styles that allow underlying chat bubbles or sidebar text to show through modal content are strictly prohibited.
* **MODAL-VIS-2 — Darkened Backdrop Overlay**:
  * Modal backdrops must use high-opacity overlays (`rgba(0, 0, 0, 0.75)` to `0.85`) with `backdrop-filter: blur(8px)` and `z-index: 1000` to ensure complete foreground legibility.

---

### 2.7 Mobile Responsive Navigation & Collapsible Drawer (MOBILE-RESPONSIVE / BUG-04 & BUG-05)

* **MOBILE-RESP-1 — Mobile Header Action Consolidation**:
  * On viewport widths $\le 768\text{px}$, secondary header action buttons (`Settings`, `Reset`, `Recycle Bin`, and other secondary actions as applicable — `Run Handshake Demo`/`Return to Hub` were retired with the legacy shell) must collapse into an overflow dropdown/menu, limiting the primary header to 3–4 key icons and preventing multi-row wrapping.
* **MOBILE-RESP-2 — Collapsible Active Agents Drawer**:
  * On mobile viewports ($\le 768\text{px}$), the `Active Agents` panel must render as a toggleable overlay/drawer rather than taking up permanent vertical space above the Chat chronicle.
* **MOBILE-RESP-3 — Touch-Accessible Message Toolbar**:
  * In [`SandboxMessageCard.svelte`](../../src/lib/components/sandbox/SandboxMessageCard.svelte), action controls (`Edit`, `Copy`, `Delete`, `Undo Turn`) must remain accessible via a tap trigger or permanent mobile action menu without requiring mouse `:hover`.

---

## 3. Acceptance Criteria

1. **[AC-RES-01] VirtualFS Undo Rollback**: Writing a file during an agent turn and then invoking `undoAgentTurn` completely removes newly created files and restores modified files to pre-turn states in `VirtualFS`.
2. **[AC-RES-02] VirtualFS Redo Restoration**: Invoking `redoAgentTurn` re-creates and re-modifies files in `VirtualFS` matching the redone turn's state in lockstep with history messages.
3. **[AC-RES-03] Main Chat Redo Button**: `SandboxActionInput` and `SandboxChatLog` render functional Redo buttons reflecting `agent.redoStack.length` and executing `redoAgentTurn`.
4. **[AC-RES-04] Redo Keyboard Shortcuts**: Pressing `Ctrl+Y` or `Ctrl+Shift+Z` in `SandboxActionInput` executes `redoAgentTurn`.
5. **[AC-RES-05] Per-Agent Draft Retention**: Typing text for Agent A, switching to Agent B, and switching back to Agent A preserves Agent A's exact draft text and leaves Agent B's textarea clean.
6. **[AC-RES-06] Undo Draft Population**: Undoing a turn populates `SandboxActionInput` with the undone user prompt for immediate re-editing.
7. **[AC-RES-07] Settings Modal Parity**: `SandboxSettingsModal` exposes reasoning effort, the full preset catalog (official + custom), and provider/routing fields.
8. **[AC-RES-08] Robust Inheritance (historical)**: An agent with the retired `model: 'inherit'` alias executed turns cleanly without provider 400 errors, dynamically resolving against global settings; superseded by binding-only catalog presets.
9. **[AC-RES-09] Modal Opacity & Legibility**: `SandboxSettingsModal` and `AgentLauncherModal` render with opaque backgrounds and darkened backdrops, eliminating all text bleed-through.
10. **[AC-RES-10] Mobile Header & Drawer Usability**: On mobile screens ($\le 375\text{px}$), header actions fit without wrapping across 4 rows, and the agent sidebar collapses cleanly.
11. **[AC-RES-11] Touch Micro-Toolbar Usability**: Message action buttons are accessible on mobile touchscreens without relying on hover states.
12. **[AC-RES-12] Zero-Mock Integration Suite**: Dedicated integration test suite (`tests/integration/undo_redo_draft_resilience_test.js`) passes with 100% success rate.
13. **[AC-RES-13] Playwright E2E Verification**: `tests/e2e/03-multi-agent-switching-drafts.spec.js` and `05-undo-redo-state-machine.spec.js` assert fixed draft isolation and `Ctrl+Y` redo shortcuts in headless Chromium with 0 console errors.
14. **[AC-RES-14] Whole-Project Gates**: `npm test`, `npm run test:e2e`, and `npm run build` all pass with exit code 0.
