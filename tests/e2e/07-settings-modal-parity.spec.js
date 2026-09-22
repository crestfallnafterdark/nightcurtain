import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox } from './helpers.js';

test.describe('07: Catalog-driven Sandbox Settings Modal', () => {
  test('catalog select/create/edit/activate, vault add/set-active, Escape and close', async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);

    const openSettings = async () => {
      await page.locator('.header-actions .btn-settings-header').click();
      const dialog = page.getByRole('dialog', { name: 'Sandbox Settings' });
      await expect(dialog).toBeVisible();
      return dialog;
    };

    // 1. Open the catalog modal from SandboxView.
    let dialog = await openSettings();
    await expect(dialog.locator('#sandbox-settings-heading')).toHaveText('Sandbox Settings');

    const presetSection = dialog.locator('section[aria-labelledby="preset-section-heading"]');
    const vaultSection = dialog.locator('section[aria-labelledby="vault-section-heading"]');
    const presetSelect = dialog.locator('#preset-select');
    const presetStatus = presetSection.locator('.status-banner');

    // 2. Catalog options and the default active pointer (master default = deepseek).
    await expect(presetSelect).toBeVisible();
    const optionLabels = await presetSelect.locator('option').allInnerTexts();
    for (const label of ['Runware', 'NanoGPT', 'DeepSeek Native', 'Prem AI', 'Custom OpenAI Completion']) {
      expect(optionLabels.some(text => text.includes(label))).toBeTruthy();
    }
    await expect(presetSelect).toHaveValue('deepseek');
    await expect(presetSection.locator('.badge-official')).toHaveText('Official');
    await expect(presetSection.locator('.badge-active')).toHaveText('Active');
    await expect(presetSection.locator('.status-pill')).toContainText('5 in catalog');

    // 3. Adaptive provider fields follow the selected preset.
    await presetSelect.selectOption('nanogpt');
    await expect(presetStatus).toContainText('Active preset set to "NanoGPT".');
    await expect(dialog.locator('#routing-input')).toHaveValue('auto');
    await expect(dialog.locator('#custom-url-input')).toHaveCount(0);

    await presetSelect.selectOption('custom');
    await expect(presetStatus).toContainText('Active preset set to "Custom OpenAI Completion".');
    await expect(dialog.locator('#custom-url-input')).toHaveValue('http://localhost:11434/v1');
    await expect(dialog.locator('#routing-input')).toHaveCount(0);

    // 4. Create a custom preset from an edited config (catches the dirty state).
    await presetSelect.selectOption('deepseek');
    await dialog.locator('#temperature-slider').fill('1.4');
    await expect(presetSection.locator('.dirty-badge')).toHaveText('Unsaved changes');
    await dialog.getByRole('button', { name: 'Save As New…' }).click();
    await dialog.getByPlaceholder('New preset name').fill('E2E Custom Preset');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(presetStatus).toContainText('Custom preset "E2E Custom Preset" created and activated.');
    await expect(presetSection.locator('.badge-custom')).toHaveText('Custom');
    await expect(presetSection.locator('.badge-active')).toHaveText('Active');
    await expect(presetSection.locator('.status-pill')).toContainText('6 in catalog');
    const customValue = await presetSelect.locator('option', { hasText: 'E2E Custom Preset' }).getAttribute('value');
    expect(customValue).toMatch(/^preset_custom_/);
    const labelsAfterCreate = await presetSelect.locator('option').allInnerTexts();
    expect(labelsAfterCreate.some(text => text.includes('E2E Custom Preset') && text.includes('★'))).toBeTruthy();

    // 5. Edit the custom preset and save it through the catalog.
    await dialog.locator('#temperature-slider').fill('1.2');
    await expect(presetSection.locator('.dirty-badge')).toBeVisible();
    await dialog.getByRole('button', { name: 'Save Preset' }).click();
    await expect(presetStatus).toContainText('Preset "E2E Custom Preset" saved.');
    await expect(presetSection.locator('.dirty-badge')).toHaveCount(0);

    // 6. The active pointer follows selection and survives a modal reopen.
    await presetSelect.selectOption('nanogpt');
    await expect(presetStatus).toContainText('Active preset set to "NanoGPT".');
    await presetSelect.selectOption(customValue);
    await expect(presetStatus).toContainText('Active preset set to "E2E Custom Preset".');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    dialog = await openSettings();
    await expect(dialog.locator('#preset-select')).toHaveValue(customValue);
    await expect(dialog.locator('section[aria-labelledby="preset-section-heading"] .badge-active')).toHaveText('Active');

    // 7. Vault: add a key (auto-activated) and move the active pointer to the canonical slot.
    const vaultStatus = dialog.locator('section[aria-labelledby="vault-section-heading"] .status-banner');
    await dialog.getByRole('tab', { name: 'DEEPSEEK' }).click();
    await expect(dialog.locator('.vault-tabs-row')).toBeVisible();
    const canonicalCard = dialog.locator('.cred-card:has-text("Default slot")');
    await expect(canonicalCard).toBeVisible();
    await dialog.getByPlaceholder('Label (e.g. Production Key)').fill('E2E DeepSeek Key');
    await dialog.getByPlaceholder('API key').fill('sk-test-1234567890');
    await dialog.getByRole('button', { name: 'Save to Vault' }).click();
    await expect(vaultStatus).toContainText('Stored "E2E DeepSeek Key" and set it active for deepseek.');

    const addedCard = dialog.locator('.cred-card', { hasText: 'E2E DeepSeek Key' });
    await expect(addedCard).toBeVisible();
    await expect(addedCard).toHaveClass(/active/);
    await expect(addedCard.locator('.cred-secret')).toContainText('****');
    await expect(addedCard.locator('.badge-active')).toHaveText('Active');
    await canonicalCard.locator('button:has-text("Set Active")').click();
    await expect(vaultStatus).toContainText('Active credential updated');
    await expect(canonicalCard).toHaveClass(/active/);
    await expect(addedCard.locator('button:has-text("Set Active")')).toBeVisible();
    await addedCard.locator('button:has-text("Set Active")').click();
    await expect(addedCard).toHaveClass(/active/);

    // 8. Delete the custom preset (confirm dialog) and fall back to the master default.
    page.once('dialog', browserDialog => browserDialog.accept());
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(presetStatus).toContainText('Custom preset "E2E Custom Preset" deleted.');
    await expect(presetSelect.locator('option', { hasText: 'E2E Custom Preset' })).toHaveCount(0);
    await expect(presetSection.locator('.status-pill')).toContainText('5 in catalog');
    await expect(presetSection.locator('.badge-custom')).toHaveCount(0);

    // 9. Escape backs out the Save As New form first, then closes; close button also closes.
    await dialog.getByRole('button', { name: 'Save As New…' }).click();
    await expect(dialog.locator('.inline-form')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog.locator('.inline-form')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.sandbox-studio-root')).toBeVisible();

    dialog = await openSettings();
    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.sandbox-studio-root')).toBeVisible();

    expect(auditor.pageErrors).toEqual([]);
  });
});
