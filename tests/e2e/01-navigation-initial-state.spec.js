import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox } from './helpers.js';

test.describe('01: Sandbox Navigation & Initial State', () => {
  test('renders studio header, telemetry KPIs, agent sidebar, tab bar, and inspector/chat panels', async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);

    // 1. Studio Header & Title
    await expect(page.locator('.studio-title')).toHaveText('Agentic Sandbox Studio');
    await expect(page.locator('.studio-sub')).toContainText('Conversational Studio & Observability');

    // 2. Telemetry KPI Chips in Header
    const telemetryBar = page.locator('.telemetry-bar');
    await expect(telemetryBar).toBeVisible();
    await expect(telemetryBar).toContainText('Agents');
    await expect(telemetryBar).toContainText('Running');
    await expect(telemetryBar).toContainText('Messages');
    await expect(telemetryBar).toContainText('Files');
    await expect(telemetryBar).toContainText('Timers');

    // 3. Header & Drawer Action Buttons
    await expect(page.locator('.header-actions .btn-settings-header')).toBeVisible();
    await expect(page.locator('.studio-header button:has-text("Reset")').first()).toBeVisible();
    await expect(page.locator('.drawer-header-actions button[aria-label="Launch Agent"]')).toBeVisible();
    await expect(page.locator('.drawer-header-actions button[aria-label="Recycle Bin"]')).toBeVisible();

    // 4. Left Sidebar / Agent Drawer
    const agentDrawer = page.locator('.agent-drawer');
    await expect(agentDrawer).toBeVisible();
    await expect(agentDrawer.locator('.drawer-title')).toContainText('Active Agents');
    await expect(page.locator('.drawer-search-input')).toBeVisible();

    // Default bootstrapped Director agent card
    const agentCards = page.locator('.agent-card');
    await expect(agentCards.first()).toBeVisible();
    await expect(agentCards.first().locator('.agent-card-name')).toContainText('Director');
    await expect(agentCards.first().locator('.agent-card-id')).toContainText('director');
    await expect(agentCards.first().locator('.sudo-tag')).toBeVisible();
    await expect(agentCards.first().locator('.state-chip')).toBeVisible();

    // 5. Studio Navigation Tabs
    const tabChat = page.locator('.tab-btn:has-text("Chat Studio")');
    const tabInspector = page.locator('.tab-btn:has-text("Telemetry & Trace")');
    const tabFs = page.locator('.tab-btn:has-text("Virtual Filesystem")');
    const tabMsg = page.locator('.tab-btn:has-text("Messaging Bus")');

    await expect(tabChat).toBeVisible();
    await expect(tabInspector).toBeVisible();
    await expect(tabFs).toBeVisible();
    await expect(tabMsg).toBeVisible();

    // Initial default tab is inspector
    await expect(tabInspector).toHaveClass(/active/);
    await expect(page.locator('.inspector-container')).toBeVisible();

    // 6. Switch to Chat Studio
    await tabChat.click();
    await expect(tabChat).toHaveClass(/active/);
    await expect(page.locator('.chat-studio-pane')).toBeVisible();
    await expect(page.locator('.sandbox-chat-log-wrapper')).toBeVisible();
    await expect(page.locator('.sandbox-action-input-wrapper')).toBeVisible();

    // Verify Action Input controls
    await expect(page.locator('.category-btn:has-text("Directive")')).toBeVisible();
    await expect(page.locator('.category-btn:has-text("System Instruction")')).toBeVisible();
    await expect(page.locator('.category-btn:has-text("Message Injection")')).toBeVisible();
    await expect(page.locator('.action-textarea')).toBeVisible();
    await expect(page.locator('.btn-submit-action')).toBeVisible();

    // 7. Switch to Virtual Filesystem Tab
    await tabFs.click();
    await expect(tabFs).toHaveClass(/active/);
    await expect(page.locator('.fs-explorer-container')).toBeVisible();

    // 8. Switch to Messaging Bus Tab
    await tabMsg.click();
    await expect(tabMsg).toHaveClass(/active/);
    await expect(page.locator('.bus-viewer-container')).toBeVisible();

    // Verify no unhandled pageerrors
    expect(auditor.pageErrors).toEqual([]);
  });

  test('filters active agents in sidebar using search input', async ({ page }) => {
    attachAuditor(page);
    await gotoSandbox(page);

    const searchInput = page.locator('.drawer-search-input');
    await searchInput.fill('director');
    await expect(page.locator('.agent-card')).toHaveCount(1);
    await expect(page.locator('.agent-card-id')).toHaveText('director');

    // Filter with nonexistent term
    await searchInput.fill('nonexistent-agent-xyz');
    await expect(page.locator('.empty-agents-drawer')).toBeVisible();
    await expect(page.locator('.empty-agents-drawer')).toContainText('No agents registered.');

    // Clear filter
    await searchInput.fill('');
    await expect(page.locator('.agent-card')).toHaveCount(1);
  });
});
