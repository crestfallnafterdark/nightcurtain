import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox, setupMockLLM } from './helpers.js';
import path from 'path';

const SCREENSHOTS_DIR = path.resolve('tests/e2e/screenshots');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 375, height: 812 }
];

test.describe('08: Visual Capture & Multimodal Screenshots', () => {
  for (const vp of VIEWPORTS) {
    test(`captures full-page and key state screenshots for ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      attachAuditor(page);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await setupMockLLM(page, {
        reasoning: 'Autonomous execution check for responsive visual verification.',
        toolCalls: [
          {
            id: 'call_snap_001',
            type: 'function',
            function: {
              name: 'fs_writeFile',
              arguments: JSON.stringify({ workspaceId: 'global', path: '/status.json', content: '{"ok": true}' })
            }
          }
        ],
        prose: 'Visual test response with **formatted Markdown** and telemetry verification.'
      });

      await gotoSandbox(page);

      // 1. Initial State Screenshot (Inspector or Default)
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/${vp.name}_01_initial_studio.png`,
        fullPage: true
      });

      // 2. Chat Studio with Active Turn & Tool Badge Screenshot
      await page.locator('.tab-btn:has-text("Chat Studio")').click();
      await page.locator('.agent-card:has-text("Director")').click();

      const textarea = page.locator('.action-textarea');
      await textarea.fill('Generate status report with tool verification.');
      await page.locator('.btn-submit-action').click();

      // Wait for turn to complete
      await expect(page.locator('.turn-assistant').first()).toBeVisible({ timeout: 15000 });

      // Open tool details if available
      const toolHeader = page.locator('.tool-badge-header').first();
      if (await toolHeader.isVisible()) {
        await toolHeader.click();
      }

      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/${vp.name}_02_chat_with_tools.png`,
        fullPage: true
      });

      // 3. Telemetry & Inspector Panel Screenshot
      await page.locator('.tab-btn:has-text("Telemetry & Trace")').click();
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/${vp.name}_03_inspector_panel.png`,
        fullPage: true
      });

      // 4. Virtual Filesystem Explorer Screenshot
      await page.locator('.tab-btn:has-text("Virtual Filesystem")').click();
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/${vp.name}_04_virtualfs_explorer.png`,
        fullPage: true
      });

      // 5. Open the catalog-driven Settings Modal Screenshot
      const settingsBtn = page.locator('.studio-header .btn-settings-header').first();
      await settingsBtn.click();
      const settingsDialog = page.getByRole('dialog', { name: 'Sandbox Settings' });
      await expect(settingsDialog).toBeVisible();
      await page.screenshot({
        path: `${SCREENSHOTS_DIR}/${vp.name}_05_settings_modal.png`,
        fullPage: true
      });

      // Close settings modal
      await settingsDialog.getByRole('button', { name: 'Close settings' }).click();
      await expect(settingsDialog).not.toBeVisible();
    });
  }
});
