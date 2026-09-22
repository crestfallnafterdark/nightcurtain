import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox } from './helpers.js';

test.describe('06: Agent Inspector & VirtualFS Explorer', () => {
  test('inspects agent telemetry, schedules timer, and explores VirtualFS files, AST queries, and Grep', async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);

    // 1. Inspector Panel Verification
    await page.locator('.tab-btn:has-text("Telemetry & Trace")').click();
    await page.locator('.agent-card:has-text("Director")').click();

    // Verify Inspector Header
    await expect(page.locator('.inspector-container')).toBeVisible();
    await expect(page.locator('.inspector-header .agent-name')).toHaveText('Director');

    // Verify Internal Inspector Navigation: Trace, Telemetry, Context
    const tabTrace = page.locator('.inspector-tab-btn:has-text("Trace & Interaction")');
    const tabTelemetry = page.locator('.inspector-tab-btn:has-text("Telemetry & Tokens")');
    const tabContext = page.locator('.inspector-tab-btn:has-text("Sent Context")');

    await expect(tabTrace).toBeVisible();
    await expect(tabTelemetry).toBeVisible();
    await expect(tabContext).toBeVisible();

    // Switch to Telemetry tab in Inspector
    await tabTelemetry.click();
    await expect(tabTelemetry).toHaveClass(/active/);
    await expect(page.locator('.telemetry-tab-container')).toBeVisible();
    await expect(page.locator('.telemetry-title')).toContainText('Agent Token Consumption');

    // Switch back to Trace tab
    await tabTrace.click();
    await expect(tabTrace).toHaveClass(/active/);

    // 2. Schedule a Timer via Inspector UI
    const timerPromptInput = page.locator('.timer-prompt-input');
    const timerDurationInput = page.locator('#timer-dur-input');
    const scheduleTimerBtn = page.locator('.schedule-form button[type="submit"]');

    if (await timerPromptInput.isVisible()) {
      await timerDurationInput.fill('30');
      await timerPromptInput.fill('Run scheduled diagnostic pulse');
      await scheduleTimerBtn.click();

      // Verify timer appears in active timers list
      const timerItem = page.locator('.timer-item:has-text("Run scheduled diagnostic pulse")');
      await expect(timerItem).toBeVisible();

      // Cancel timer (the entry is retained with a cancelled status badge)
      const cancelTimerBtn = timerItem.locator('.btn-cancel-timer');
      await cancelTimerBtn.click();
      await expect(timerItem).toHaveClass(/cancelled/);
      await expect(timerItem.locator('.btn-cancel-timer')).toHaveCount(0);
    }

    // 3. Virtual Filesystem Explorer Verification
    await page.locator('.tab-btn:has-text("Virtual Filesystem")').click();
    const vfsRoot = page.locator('.fs-explorer-container');
    await expect(vfsRoot).toBeVisible();

    // Verify Workspace Pills (Global Shared)
    const globalPill = page.locator('.ws-pill:has-text("Global Shared")');
    await expect(globalPill).toBeVisible();
    await globalPill.click();

    // 3a. Realm-aware partition grouping (ticket 7571ce5): the pill bar renders
    //     the shared partition and one group per registered Realm, and a
    //     realm-global partition is selectable with its resolved count.
    await expect(page.locator('.ws-group').first()).toBeVisible();
    await expect(page.locator('.ws-group-label', { hasText: 'Shared' })).toBeVisible();
    const genericGroupLabel = page.locator('.ws-group-label', { hasText: 'Generic' });
    await expect(genericGroupLabel).toBeVisible();
    const genericGroup = page.locator('.ws-group').filter({ has: genericGroupLabel });
    const genericGlobalPill = genericGroup.locator('.ws-pill').filter({ hasText: 'global' }).first();
    await expect(genericGlobalPill).toBeVisible();
    await expect(genericGlobalPill.locator('.file-count')).toHaveText('0');

    // 4. Create New File in VirtualFS
    await page.locator('button:has-text("+ New File")').click();
    const createFileModal = page.locator('.file-modal');
    await expect(createFileModal).toBeVisible();

    await page.fill('#new-path', '/config/server.json');
    await page.fill('#new-content', JSON.stringify({
      server: 'Alpha-Omega',
      port: 8080,
      active: true,
      features: ['audit', 'orchestration']
    }, null, 2));

    await page.locator('.file-modal button[type="submit"]').click();
    await expect(createFileModal).not.toBeVisible();

    // 5. Select Created File and Inspect Viewer Content
    const fileRow = page.locator('.file-row:has-text("/config/server.json")');
    await expect(fileRow).toBeVisible();
    await fileRow.click();

    const fileCode = page.locator('.file-code');
    await expect(fileCode).toBeVisible();
    await expect(fileCode).toContainText('Alpha-Omega');
    await expect(fileCode).toContainText('features');

    // 6. Test Structured AST JSON KeyPath Query Widget
    const jsonQueryInput = page.locator('.query-form input.query-input').first();
    await jsonQueryInput.fill('$.server');
    await page.locator('button:has-text("Query KeyPath")').click();

    const queryResultBox = page.locator('.query-result-box');
    await expect(queryResultBox).toBeVisible();
    await expect(queryResultBox).toContainText('Alpha-Omega');

    // 7. Test Regex & Text Grep Search Widget
    const grepInput = page.locator('.query-form input[placeholder*="Search text or regex"]').first();
    await grepInput.fill('Alpha-Omega');
    await page.locator('button:has-text("Search Grep")').click();

    const grepResultBox = page.locator('.grep-results-box');
    await expect(grepResultBox).toBeVisible();
    await expect(grepResultBox).toContainText('/config/server.json');

    // 8. Realm-global partition write/read (ticket 7571ce5): selecting the
    //    Generic realm's global partition and creating a file there keeps the
    //    partition counts and file lists distinct from the shared global.
    await genericGlobalPill.click();
    await expect(genericGlobalPill).toHaveClass(/active/);
    await expect(page.locator('.empty-files code')).toHaveText('Generic · global');
    await page.locator('.empty-files button:has-text("Create Initial File")').click();
    await expect(page.locator('.file-modal')).toBeVisible();
    await page.fill('#new-path', '/realm_seed.md');
    await page.fill('#new-content', 'realm-global seed');
    await page.locator('.file-modal button[type="submit"]').click();
    await expect(page.locator('.file-modal')).not.toBeVisible();
    await expect(page.locator('.file-row:has-text("/realm_seed.md")')).toBeVisible();
    await expect(genericGlobalPill.locator('.file-count')).toHaveText('1');

    // The shared global partition keeps its own file list and count.
    await globalPill.click();
    await expect(page.locator('.file-row:has-text("/config/server.json")')).toBeVisible();
    await expect(page.locator('.file-row:has-text("/realm_seed.md")')).toHaveCount(0);

    expect(auditor.pageErrors).toEqual([]);
  });
});
