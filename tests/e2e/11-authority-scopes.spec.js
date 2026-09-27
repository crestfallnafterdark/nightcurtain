import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox } from './helpers.js';

/**
 * @file tests/e2e/11-authority-scopes.spec.js
 * Authority scope application for the five scoped meta-capability ids
 * (regression cover for defect 9b14928; compact-row redesign d7131dc).
 *
 * Operator flow: Agent Settings → Security & Authority → "Edit scope" →
 * "Authority scopes" dialog → shape-valid scope → save. Two ids declare an
 * `AUTHORITY_SCOPE_FIELDS` vocabulary (`@agent:edit`, `@realm:edit`) and three
 * declare none (`@agent:inspect`, `@realm:inspect`, `@extensions:authority`):
 * the seeded draft must carry `fields` only for ids with a declared
 * vocabulary, otherwise the fail-closed normalizer rejects the save with
 * `The "fields" scope key is not available for <id>.` and no scope is applied.
 *
 * Deterministic: no model calls and no mocked LLM; every case provisions its
 * own probe agent in the default Generic realm inside a fresh browser context,
 * so the five cases never share grant state.
 */

/**
 * Sanitized dialog DOM tab id, mirroring `AuthorityScopesDialog.tabId()`.
 *
 * @param {string} authority - Exact authority id.
 * @returns {string} DOM id (`authority-tab-agent-inspect`).
 */
function tabId(authority) {
  return `authority-tab-${authority.replace(/^@/, '').replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/**
 * The five scoped ids with a deterministic, shape-valid draft per class:
 * agent-class ids take agent-id targets (the seeded own-spawns selector stays
 * checked), realm-class ids take a realm-id target. `summary` is the exact
 * chip/rail grammar from `describeAuthorityScopeSummary`.
 */
const SCOPES = Object.freeze([
  {
    authority: '@agent:inspect',
    slug: 'agent-inspect',
    targets: 'probe-target-a',
    realms: null,
    summary: '1 agent targets · own spawns'
  },
  {
    authority: '@agent:edit',
    slug: 'agent-edit',
    targets: 'probe-target-b',
    realms: 'realm_generic',
    summary: '1 agent targets · own spawns · 1 bound realms'
  },
  {
    authority: '@realm:inspect',
    slug: 'realm-inspect',
    targets: 'realm_generic',
    realms: null,
    summary: '1 realm targets'
  },
  {
    authority: '@realm:edit',
    slug: 'realm-edit',
    targets: 'realm_generic',
    realms: null,
    summary: '1 realm targets'
  },
  {
    authority: '@extensions:authority',
    slug: 'extensions-authority',
    targets: 'realm_generic',
    realms: null,
    summary: '1 realm targets'
  }
]);

/**
 * Locates one meta-capability row in the Security & Authority card by its
 * exact authority id (only meta rows carry the "Edit scope" button).
 *
 * @param {import('@playwright/test').Page} page - Page.
 * @param {string} authority - Exact authority id.
 * @returns {import('@playwright/test').Locator} The row locator.
 */
function metaAuthorityRow(page, authority) {
  return page
    .locator('.authority-row')
    .filter({ has: page.locator('.authority-edit-scope') })
    .filter({ has: page.locator('.authority-id', { hasText: authority }) });
}

/**
 * Provisions one probe agent through the launcher and opens its Agent Settings
 * workstation tab (the real operator path).
 *
 * @param {import('@playwright/test').Page} page - Page already on /sandbox.
 * @param {string} slug - Case slug for the unique agent id/name.
 * @returns {Promise<void>} Resolves once the settings pane is visible.
 */
async function provisionProbeAgent(page, slug) {
  const id = `scope-probe-${slug}`;
  await page.locator('.drawer-header-actions button[aria-label="Launch Agent"]').click();
  const launcher = page.locator('.launcher-modal');
  await expect(launcher).toBeVisible();
  await page.fill('#agent-id', id);
  await page.fill('#agent-name', `Scope Probe ${slug}`);
  await page.locator('.launcher-modal button[type="submit"]').click();
  await expect(launcher).not.toBeVisible();

  const card = page.locator('.agent-card', { hasText: `Scope Probe ${slug}` });
  await expect(card).toBeVisible();
  await card.click();
  await page.locator('.tab-btn:has-text("Agent Settings")').click();
  await expect(page.locator('.agent-settings-pane')).toBeVisible();
}

for (const spec of SCOPES) {
  test(`applies and persists a valid scope for ${spec.authority}`, async ({ page }) => {
    const auditor = attachAuditor(page);
    await gotoSandbox(page);
    await provisionProbeAgent(page, spec.slug);

    const row = metaAuthorityRow(page, spec.authority);
    await expect(row).toHaveCount(1);
    await row.locator('.authority-edit-scope').click();

    const dialog = page.locator('.authority-scopes-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.detail-title-row .authority-id')).toHaveText(spec.authority);

    await dialog.locator(`#${tabId(spec.authority)}-targets`).fill(spec.targets);
    if (spec.realms) {
      await dialog.locator(`#${tabId(spec.authority)}-realms`).fill(spec.realms);
    }

    await dialog.locator('.dialog-actions .btn-scope').click();

    // Settle: a successful apply renders the success feedback; a rejected
    // draft renders an inline error (the defect surfaces the spurious
    // `fields` rejection here).
    await expect
      .poll(async () => {
        const errors = await dialog.locator('.field-error').allInnerTexts();
        if (errors.length > 0) return 'error';
        const status = (await dialog.locator('.field-status').allInnerTexts()).join(' ');
        return status.includes('Scope applied') ? 'applied' : 'pending';
      }, { timeout: 15000 })
      .not.toBe('pending');

    // 1. No inline error — the seeded draft carried no class-invalid key.
    const inlineErrors = await dialog.locator('.field-error').allInnerTexts();
    expect(inlineErrors).toEqual([]);

    // 2. The applied-scope feedback and the row chip reflect the scope.
    await expect(dialog.locator('.field-status')).toContainText('Scope applied');
    await expect(row.locator('.authority-live-tag')).toHaveText('GRANTED');
    await expect(row.locator('.authority-scope-chip')).toHaveText(spec.summary);

    // 3. Reopening the dialog re-seeds from the persisted registry scope.
    await dialog.locator('.modal-footer .btn-ghost').click();
    await expect(dialog).not.toBeVisible();
    await row.locator('.authority-edit-scope').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(`#${tabId(spec.authority)}-targets`)).toHaveValue(spec.targets);
    if (spec.realms) {
      await expect(dialog.locator(`#${tabId(spec.authority)}-realms`)).toHaveValue(spec.realms);
    }
    await expect(dialog.locator(`#${tabId(spec.authority)} .rail-summary`)).toHaveText(spec.summary);
    await expect(dialog.locator('.status-line')).toHaveText('Granted · narrowed scope applies.');

    expect(auditor.pageErrors).toEqual([]);
  });
}
