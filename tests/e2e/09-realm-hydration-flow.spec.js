/**
 * @file tests/e2e/09-realm-hydration-flow.spec.js
 * E2E coverage for the template-hydration UI overhaul (ticket 874182b),
 * extending the live hydration run: the hydration workspace requirements
 * and placement mapping, the review-time template pin + payload digest, the
 * session saved-payload lifecycle, and the Realm Manager's reopen/replace
 * path — all without relaunching members or running a model turn.
 *
 * Both specs use the shipped `session_zero` template (no `initialPrompt`, so a
 * launch performs no completion call) and write only through the real store
 * surfaces rendered by the UI.
 */

import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox } from './helpers.js';

/**
 * Opens the Realm launcher and selects the shipped `session_zero` template.
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @returns The launcher modal locator.
 */
async function openLauncherWithSessionZero(page) {
  await page.locator('.drawer-header-actions button[aria-label="Launch Realm from Template"]').click();
  const modal = page.locator('.realm-launcher-modal');
  await expect(modal).toBeVisible();
  await page.selectOption('#realm-template-select', 'session_zero');
  await expect(modal.locator('.section-title:has-text("Hydration workspace — inputs")')).toBeVisible();
  return modal;
}

/**
 * Attaches one file to a named files input through the real UI flow: the
 * per-draft button targets the draft and opens the shared hidden picker, so
 * the test must intercept the file chooser instead of setting files on the
 * hidden input (which carries no draft target).
 *
 * @param {import('@playwright/test').Page} page - Playwright page.
 * @param {import('@playwright/test').Locator} modal - Launcher modal locator.
 * @param {string} inputLabel - Declared input label text.
 * @param {{ name: string, mimeType: string, buffer: Buffer }} file - File payload.
 * @returns The files input group locator.
 */
async function attachToFilesInput(page, modal, inputLabel, file) {
  const group = modal.locator('.form-group').filter({ hasText: inputLabel }).first();
  const chooserPromise = page.waitForEvent('filechooser');
  await group.locator('button:has-text("Attach files…")').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
  return group;
}

test.describe('09: Realm hydration flow', () => {
  test('renders v2 input requirements, placement mapping, digest, and the saved-payload lifecycle', async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);
    const modal = await openLauncherWithSessionZero(page);

    // Declared input requirements: shape badge, required marker, and brief.
    const notesGroup = modal.locator('.form-group').filter({ hasText: 'Handoff notes' }).first();
    await expect(notesGroup.locator('.shape-badge')).toHaveText('files');
    await expect(notesGroup.locator('.hydration-brief')).toContainText('operator notes');
    const assignmentGroup = modal.locator('.form-group').filter({ hasText: 'Assignment' }).first();
    await expect(assignmentGroup.locator('.req')).toBeVisible();

    // Fileset attach: per-file list with size, declared placement mapping, and
    // the concrete destination the file resolves to.
    await attachToFilesInput(page, modal, 'Handoff notes', {
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Operator notes')
    });
    const attachment = notesGroup.locator('.attachment-row');
    await expect(attachment).toHaveCount(1);
    await expect(attachment.locator('.field-hint').first()).toContainText('from notes.md');
    await expect(attachment.locator('.field-hint').first()).toContainText('B');
    await expect(attachment.locator('.attachment-destinations')).toContainText('handoff/notes.md');
    await expect(notesGroup.locator('.placement-map')).toContainText('handoff/notes.md');

    // The usage map still renders per input (prompt + placement sites).
    await expect(assignmentGroup.locator('.usage-summary')).toContainText('system prompt');

    // Required text input, then save the assembled payload into the session library.
    await page.fill('#realm-input-assignment', 'Draft the realm brief.');
    await page.fill('input[aria-label="Saved payload name"]', 'Act 1');
    await modal.locator('button:has-text("Save payload")').click();
    await expect(modal.locator('.notice-banner')).toContainText('Saved payload "Act 1"');
    await expect(modal.locator('.notice-banner')).toContainText('sha256:');

    // Attach the saved payload to this launch.
    await page.selectOption('select[aria-label="Payload attachment source"]', 'saved');
    const savedRow = modal.locator('.payload-candidate:has-text("Act 1")');
    await expect(savedRow).toBeVisible();
    await savedRow.locator('button:has-text("Attach")').click();
    await expect(modal.locator('.payload-attached-badge')).toBeVisible();
    await expect(modal.locator('.payload-status')).toContainText('saved payload "Act 1"');

    // Review-time pin + canonical digest are visible.
    const pinCard = modal.locator('.pin-card');
    await expect(pinCard).toContainText('sha256:');
    await expect(pinCard.locator('.pin-row').nth(1)).toContainText('sha256:');

    // Clearing a required input covered by the payload inline-reports the typed
    // failure and blocks the launch instead of launching.
    await page.fill('#realm-input-assignment', '');
    await expect(modal.locator('.launch-gate-hint')).toContainText('Assignment');
    await expect(modal.locator('button[type="submit"]')).toBeDisabled();
    await expect(modal).toBeVisible();

    expect(auditor.pageErrors).toEqual([]);
  });

  test('launches a hydrated Realm, then replaces its content from the Realm Manager', async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);
    const modal = await openLauncherWithSessionZero(page);

    // Assemble a complete payload and save it for the later reopen.
    await page.fill('#realm-input-assignment', 'Hydrate the realm with operator notes.');
    await attachToFilesInput(page, modal, 'Handoff notes', {
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Operator notes')
    });
    await page.fill('input[aria-label="Saved payload name"]', 'Reopen brief');
    await modal.locator('button:has-text("Save payload")').click();
    await expect(modal.locator('.notice-banner')).toContainText('Saved payload "Reopen brief"');

    // Acknowledge the mandatory review and launch (declared authorities stay declined).
    await modal.locator('.review-ack input[type="checkbox"]').check();
    await modal.locator('button[type="submit"]').click();
    await expect(page.locator('.realm-launcher-modal .launch-receipt')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.realm-launcher-modal .launch-receipt')).toContainText('Session Zero');

    // Close the wizard without seeding anything else.
    await page.locator('.realm-launcher-modal .btn-close').click();
    await expect(page.locator('.realm-launcher-modal')).not.toBeVisible();

    // Open the Realm Manager and select the freshly launched Realm.
    await page.locator('.drawer-header-actions button[aria-label="Manage Realms"]').click();
    await page.locator('.realm-chip:has-text("Session Zero")').click();
    await expect(page.locator('.provenance-list')).toContainText('session_zero');
    await expect(page.locator('.provenance-details summary').first()).toBeVisible();

    // Reopen the content and attach the saved payload.
    await page.locator('button:has-text("Rehydrate / Replace content…")').click();
    const rehydrate = page.locator('.realm-rehydrate-modal');
    await expect(rehydrate).toBeVisible();
    await expect(rehydrate.locator('.provenance-list')).toContainText('session_zero');
    await page.selectOption('select[aria-label="Saved payload"]', { index: 1 });
    await expect(rehydrate.locator('.pin-card')).toContainText('sha256:');
    await expect(rehydrate.locator('.write-group')).toContainText('handoff/notes.md');
    await expect(rehydrate.locator('.write-group')).toContainText('handoff/README.md');

    // Confirm the overwrite and replace the content (no relaunch, membership unchanged).
    await rehydrate.locator('label:has-text("Overwrite the declared destinations") input[type="checkbox"]').check();
    await rehydrate.locator('button:has-text("Replace Realm content")').click();
    await expect(rehydrate.locator('.payload-receipt')).toContainText('Wrote 2 files', { timeout: 15000 });

    // The active member roster survived the replace (closing the rehydrate
    // modal also dismisses the Realm Manager, so reopen it first).
    await rehydrate.locator('.modal-footer button:has-text("Close")').click();
    await expect(rehydrate).not.toBeVisible();
    await page.locator('.drawer-header-actions button[aria-label="Manage Realms"]').click();
    await page.locator('.realm-chip:has-text("Session Zero")').click();
    await expect(page.locator('.settings-section-card:has-text("Members") .member-row')).toHaveCount(2);

    expect(auditor.pageErrors).toEqual([]);
  });
});
