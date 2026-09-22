import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox } from './helpers.js';

test.describe('03: Multi-Agent Navigation, Switching & Draft Persistence', () => {
  test('switches active agents cleanly and checks active card highlight and chat chronicle swap', async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);

    const launchBtn = page.locator('.drawer-header-actions button[aria-label="Launch Agent"]');
    const launcherModal = page.locator('.launcher-modal');

    // 1. Provision Agent A via the drawer header launcher
    await launchBtn.click();
    await expect(launcherModal).toBeVisible();
    await page.fill('#agent-id', 'agent-alpha');
    await page.fill('#agent-name', 'Alpha Specialist');
    await launcherModal.locator('button[type="submit"]').click();
    await expect(launcherModal).not.toBeVisible();

    const alphaCard = page.locator('.agent-card:has-text("Alpha Specialist")');
    await expect(alphaCard).toBeVisible();
    await expect(alphaCard.locator('.agent-card-id')).toHaveText('agent-alpha');

    // 2. Provision Agent B
    await launchBtn.click();
    await expect(launcherModal).toBeVisible();
    await page.fill('#agent-id', 'agent-beta');
    await page.fill('#agent-name', 'Beta Analyst');
    await launcherModal.locator('button[type="submit"]').click();
    await expect(launcherModal).not.toBeVisible();

    const betaCard = page.locator('.agent-card:has-text("Beta Analyst")');
    await expect(betaCard).toBeVisible();
    await expect(betaCard.locator('.agent-card-id')).toHaveText('agent-beta');

    // Switch to Chat Studio tab
    await page.locator('.tab-btn:has-text("Chat Studio")').click();

    // 3. Select Agent Alpha
    await alphaCard.click();
    await expect(alphaCard).toHaveClass(/selected/);
    await expect(page.locator('.tab-target-badge')).toHaveText('agent-alpha');
    await expect(page.locator('.agent-chronicle-header .agent-title')).toHaveText('Alpha Specialist');
    await expect(page.locator('.agent-chronicle-header .agent-id-pill')).toHaveText('agent-alpha');

    // 4. Select Agent Beta
    await betaCard.click();
    await expect(betaCard).toHaveClass(/selected/);
    await expect(alphaCard).not.toHaveClass(/selected/);
    await expect(page.locator('.tab-target-badge')).toHaveText('agent-beta');
    await expect(page.locator('.agent-chronicle-header .agent-title')).toHaveText('Beta Analyst');
    await expect(page.locator('.agent-chronicle-header .agent-id-pill')).toHaveText('agent-beta');

    // 5. Select Director
    const directorCard = page.locator('.agent-card:has-text("Director")');
    await directorCard.click();
    await expect(directorCard).toHaveClass(/selected/);
    await expect(betaCard).not.toHaveClass(/selected/);
    await expect(page.locator('.tab-target-badge')).toHaveText('director');
    await expect(page.locator('.agent-chronicle-header .agent-title')).toHaveText('Director');

    expect(auditor.pageErrors).toEqual([]);
  });

  test('evaluates per-agent draft persistence across agent switching in SandboxActionInput & Inspector', async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);

    const launchBtn = page.locator('.drawer-header-actions button[aria-label="Launch Agent"]');
    const launcherModal = page.locator('.launcher-modal');

    // Provision Agent A and Agent B
    await launchBtn.click();
    await expect(launcherModal).toBeVisible();
    await page.fill('#agent-id', 'agent-recon');
    await page.fill('#agent-name', 'Recon Agent');
    await launcherModal.locator('button[type="submit"]').click();
    await expect(launcherModal).not.toBeVisible();

    await launchBtn.click();
    await expect(launcherModal).toBeVisible();
    await page.fill('#agent-id', 'agent-intel');
    await page.fill('#agent-name', 'Intel Agent');
    await launcherModal.locator('button[type="submit"]').click();
    await expect(launcherModal).not.toBeVisible();

    const reconCard = page.locator('.agent-card:has-text("Recon Agent")');
    const intelCard = page.locator('.agent-card:has-text("Intel Agent")');
    await expect(reconCard).toBeVisible();
    await expect(intelCard).toBeVisible();

    // --- PART 1: Inspector Tab Draft Persistence ---
    await page.locator('.tab-btn:has-text("Telemetry & Trace")').click();

    // Select Recon Agent in Inspector
    await reconCard.click();
    const inspectorTextarea = page.locator('#turn-prompt-input');
    await expect(inspectorTextarea).toBeVisible();
    await inspectorTextarea.fill('Recon prompt draft buffer 123');

    // Switch to Intel Agent in Inspector: separate (empty) per-agent draft
    await intelCard.click();
    await expect(inspectorTextarea).toHaveValue('');

    // Switch back to Recon Agent in Inspector: draft restored
    await reconCard.click();
    await expect(inspectorTextarea).toHaveValue('Recon prompt draft buffer 123');

    // --- PART 2: Chat Studio SandboxActionInput Draft Persistence ---
    await page.locator('.tab-btn:has-text("Chat Studio")').click();

    // Select Recon Agent: the shared per-agent draft is seeded from the Inspector
    await reconCard.click();
    const actionTextarea = page.locator('.action-textarea');
    await expect(actionTextarea).toHaveValue('Recon prompt draft buffer 123');
    await actionTextarea.fill('Chat Studio Draft for Recon Agent');

    // Switch to Intel Agent: draft must not leak across agents
    await intelCard.click();
    await expect(actionTextarea).toHaveValue('');

    // Switch back to Recon Agent: Chat Studio draft preserved
    await reconCard.click();
    await expect(actionTextarea).toHaveValue('Chat Studio Draft for Recon Agent');

    expect(auditor.pageErrors).toEqual([]);
  });
});
