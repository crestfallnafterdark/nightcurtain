import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox } from './helpers.js';

test.describe('02: Agent Provisioning & Editing', () => {
  test('provisions a new agent via AgentLauncherModal, binds a catalog preset, and edits it via the Agent Settings panel', async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);

    // 1. Open Agent Launcher Modal from the drawer header
    const launchBtn = page.locator('.drawer-header-actions button[aria-label="Launch Agent"]');
    await launchBtn.click();

    const launcherModal = page.locator('.launcher-modal');
    await expect(launcherModal).toBeVisible();
    await expect(launcherModal.locator('#launcher-title')).toHaveText('Provision New Agent');

    // 2. Fill Agent Details
    await page.fill('#agent-id', 'agent-scout-unit');
    await page.fill('#agent-name', 'Scout Unit 99');
    await page.fill('#agent-role', 'Deep Space Reconnaissance & Surface Cartography');
    await page.fill('#system-prompt', 'You are Scout Unit 99. You scan planets and record observations.');

    // Bind a non-default catalog model preset (MOD-20 binding-only launcher)
    await page.selectOption('#preset-select', 'nanogpt');
    await expect(launcherModal.locator('.preset-summary')).toContainText('nanogpt');
    await expect(launcherModal.locator('.preset-summary')).toContainText('deepseek/deepseek-v4.1-flash:thinking');

    // Select Tool Preset: Standard Collaborator
    await page.locator('.preset-card:has-text("Standard Collaborator")').click();
    await expect(page.locator('.preset-card:has-text("Standard Collaborator")')).toHaveClass(/active/);

    // Submit form
    await page.locator('.launcher-modal button[type="submit"]').click();

    // 3. Verify modal closes and agent appears in sidebar
    await expect(launcherModal).not.toBeVisible();

    const scoutCard = page.locator('.agent-card:has-text("Scout Unit 99")');
    await expect(scoutCard).toBeVisible();
    await expect(scoutCard.locator('.agent-card-id')).toHaveText('agent-scout-unit');
    await expect(scoutCard.locator('.agent-card-role')).toContainText('Deep Space Reconnaissance');

    // 4. Select the newly created agent
    await scoutCard.click();
    await expect(scoutCard).toHaveClass(/selected/);

    // 5. Edit via the Agent Settings workstation tab (inline live-apply panel)
    await page.locator('.tab-btn:has-text("Agent Settings")').click();
    const settingsPane = page.locator('.agent-settings-pane');
    await expect(settingsPane).toBeVisible();

    // Verify existing fields pre-populated
    await expect(page.locator('#agent-display-name')).toHaveValue('Scout Unit 99');
    await expect(page.locator('#agent-role')).toHaveValue('Deep Space Reconnaissance & Surface Cartography');
    await expect(page.locator('#agent-system-prompt')).toHaveValue('You are Scout Unit 99. You scan planets and record observations.');
    await expect(page.locator('#agent-model-preset')).toHaveValue('nanogpt');

    // 6. Modify attributes (each edit auto-applies after the 300ms debounce)
    await page.fill('#agent-display-name', 'Scout Unit 99 (Promoted)');
    await page.fill('#agent-role', 'Fleet Commander & Recon Lead');
    await page.fill('#agent-system-prompt', 'Updated directives: Lead fleet recon and report to command.');

    // 7. Verify updated metadata in the sidebar and the reloaded preset binding
    await expect(scoutCard.locator('.agent-card-name')).toHaveText('Scout Unit 99 (Promoted)');
    await expect(scoutCard.locator('.agent-card-role')).toHaveText('Fleet Commander & Recon Lead');
    await expect(page.locator('#agent-model-preset')).toHaveValue('nanogpt');

    expect(auditor.pageErrors).toEqual([]);
  });

  test('validates duplicate agent ID prevention in launcher modal', async ({ page }) => {
    attachAuditor(page);
    await gotoSandbox(page);

    // Attempt to launch an agent with existing ID 'director'
    await page.locator('.drawer-header-actions button[aria-label="Launch Agent"]').click();
    await page.fill('#agent-id', 'director');
    await page.fill('#agent-name', 'Director Clone');
    await page.locator('.launcher-modal button[type="submit"]').click();

    // Verify error banner is shown and modal stays open
    const errorBanner = page.locator('.launcher-modal .error-banner');
    await expect(errorBanner).toBeVisible();
    await expect(errorBanner).toContainText('already exists');

    // Close modal via close button
    await page.locator('.launcher-modal .btn-close').click();
    await expect(page.locator('.launcher-modal')).not.toBeVisible();
  });
});
