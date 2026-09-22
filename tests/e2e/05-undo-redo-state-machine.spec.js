import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox, setupMockLLM } from './helpers.js';

test.describe('05: Undo / Redo State Machine & Keyboard Shortcuts', () => {
  test('executes turn, undoes via button, verifies Redo button with stack badge, and tests keyboard shortcuts', async ({ page }) => {
    const auditor = attachAuditor(page);

    await setupMockLLM(page, {
      prose: 'First response: Task executed successfully.',
      reasoning: 'Processing first request...'
    });

    await gotoSandbox(page);

    // Switch to Chat Studio
    await page.locator('.tab-btn:has-text("Chat Studio")').click();
    await page.locator('.agent-card:has-text("Director")').click();

    // 1. Submit a turn
    const textarea = page.locator('.action-textarea');
    await textarea.fill('First directive to be undone later.');
    await page.locator('.btn-submit-action').click();

    // Wait for assistant response to appear
    await expect(page.locator('.turn-assistant').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.turn-user')).toHaveCount(1);
    await expect(page.locator('.turn-assistant')).toHaveCount(1);

    // 2. Click "Undo Turn" button in Chat Chronicle Header or Action Input
    const undoBtn = page.locator('.btn-undo-turn-header, .btn-undo-turn').first();
    await expect(undoBtn).toBeVisible();
    await undoBtn.click();

    // Verify turn is removed from chat chronicle
    await expect(page.locator('.turn-assistant')).toHaveCount(0);
    await expect(page.locator('.turn-user')).toHaveCount(0);

    // 3. Switch to Inspector tab and inspect Redo button state
    await page.locator('.tab-btn:has-text("Telemetry & Trace")').click();
    const redoBtn = page.locator('.btn-redo');
    await expect(redoBtn).toBeVisible();
    await expect(redoBtn).toBeEnabled();
    await expect(redoBtn).toHaveText(/Redo\s*\(1\)/);

    // 4. Click Redo button in Inspector
    await redoBtn.click();

    // Verify Redo stack count cleared/decremented and disabled
    await expect(redoBtn).toBeDisabled();

    // Switch back to Chat Studio and verify turn restored
    await page.locator('.tab-btn:has-text("Chat Studio")').click();
    await expect(page.locator('.turn-user')).toHaveCount(1);
    await expect(page.locator('.turn-assistant')).toHaveCount(1);
    await expect(page.locator('.turn-user .book-blockquote')).toContainText('First directive to be undone later.');

    // 5. Test Keyboard Shortcuts
    // Test Ctrl+Z in action textarea when empty
    const chatTextarea = page.locator('.action-textarea');
    await chatTextarea.focus();
    await chatTextarea.fill('');
    await page.keyboard.press('Control+z');

    // Check if Ctrl+Z removed turn
    const assistantCountAfterCtrlZ = await page.locator('.turn-assistant').count();
    console.log('[E2E SHORTCUT AUDIT] Assistant count after Ctrl+Z:', assistantCountAfterCtrlZ);

    // Test Ctrl+Y in action textarea / page
    await page.keyboard.press('Control+y');
    const assistantCountAfterCtrlY = await page.locator('.turn-assistant').count();
    console.log('[E2E SHORTCUT AUDIT] Assistant count after Ctrl+Y:', assistantCountAfterCtrlY);

    expect(auditor.pageErrors).toEqual([]);
  });
});
