/**
 * @file tests/e2e/10-mcp-extension-cors.spec.js
 * E2E coverage for the P3.4 live MCP extension surfaces: the real browser
 * `fetch` path against the CORS-enabled `node:http` fixture (plaintext
 * loopback, unauthenticated), the settings connection panel (status, server
 * identity, negotiated protocol, catalog count + fidelity badge, reconnect
 * drift), the Realm Manager attachment with the live ceiling editor, and the
 * zero-console-error + no-`Authorization`-header assertions.
 *
 * The fixture is spawned and killed by the spec itself (self-contained); the
 * app dev server is whatever the Playwright config provides (reused when one
 * is already running on :5173).
 */

import { test, expect } from '@playwright/test';
import { attachAuditor, gotoSandbox } from './helpers.js';
import { createMcpFixtureServer } from '../fixtures/mcp/http_fixture_server.mjs';

/** Extension id installed for the fixture server. */
const EXTENSION_ID = 'cors-fixture';

test.describe('10: MCP extension CORS connect', () => {
  test('connects from the browser, renders catalog/fidelity/drift/attach states, and never sends Authorization', async ({ page }) => {
    test.setTimeout(90000);
    const auditor = attachAuditor(page);
    const fixture = await createMcpFixtureServer({ port: 0, host: '127.0.0.1' });

    /** Every request the browser sent to the fixture (headers included; no secrets are ever sent). */
    const fixtureRequests = [];
    page.on('request', (request) => {
      if (!request.url().startsWith(fixture.url)) return;
      fixtureRequests.push({ url: request.url(), method: request.method(), headers: request.headers() });
    });

    try {
      await gotoSandbox(page);

      // ---- Install the fixture extension through the real dialog ----------
      await page.locator('.header-actions .btn-settings-header').click();
      await expect(page.locator('#sandbox-settings-heading')).toBeVisible();
      await page.locator('#settings-tab-extensions').click();
      await page.getByRole('button', { name: /Install Extension/ }).click();
      const installDialog = page.locator('.install-dialog');
      await expect(installDialog).toBeVisible();
      await installDialog.locator('#extension-install-id').fill(EXTENSION_ID);
      await installDialog.locator('#extension-install-url').fill(fixture.url);
      await installDialog.locator('button[type="submit"]').click();

      const panel = page.locator(`[data-extension-connection="${EXTENSION_ID}"]`);
      await expect(panel).toBeVisible();
      // Disconnected is chip-less by design: the description says so and the
      // Connect control is the only connection action offered.
      await expect(panel).toContainText('No live session');
      await expect(panel.getByRole('button', { name: `Connect extension ${EXTENSION_ID}` })).toBeVisible();

      // ---- Connect over the real browser fetch (CORS + legacy handshake) --
      await panel.getByRole('button', { name: `Connect extension ${EXTENSION_ID}` }).click();
      await expect(panel.locator('.conn-chip')).toHaveText('Connected', { timeout: 20000 });
      await expect(panel.locator('.connection-meta')).toContainText('mcp-http-fixture 1.0.0');
      await expect(panel.locator('.connection-meta')).toContainText('protocol 2025-06-18');
      await expect(panel.locator('.catalog-count')).toHaveText('5 tools');
      await expect(panel.locator('.fidelity-badge')).toHaveText('projected schemas');
      await expect(panel).toContainText('third-party — classification unknown');
      expect(fixture.requests.map((entry) => entry.method)).toContain('initialize');
      expect(fixture.requests.some((entry) => entry.method === 'tools/list')).toBe(true);

      // ---- Reconnect drift: swap the advertised catalog and re-discover ----
      fixture.setTools([{
        name: 'extra',
        description: 'Extra tool advertised after reconnect.',
        inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'q' } }, additionalProperties: false }
      }]);
      await panel.getByRole('button', { name: `Reconnect extension ${EXTENSION_ID}` }).click();
      await expect(panel.locator('.catalog-count')).toHaveText('1 tool', { timeout: 20000 });
      const drift = panel.locator('details').filter({ hasText: 'Reconnect drift' }).first();
      await expect(drift).toContainText('+1 added');
      await expect(drift).toContainText('-5 removed');

      // ---- Attach to the seeded Generic Realm with the live ceiling --------
      await page.locator('.settings-dialog button[aria-label="Close settings"]').click();
      await page.locator('.drawer-header-actions button[aria-label="Manage Realms"]').click();
      const realmModal = page.locator('.realm-modal');
      await expect(realmModal).toBeVisible();
      await realmModal.locator('.realm-chip', { hasText: 'Generic' }).click();
      await page.selectOption('#realm-attach-extension', EXTENSION_ID);
      await expect(realmModal.locator('.ceiling-tool-row')).toHaveCount(2);
      await realmModal.locator('.attach-editor button:has-text("Attach to this Realm")').click();

      const attachmentRow = realmModal.locator('.attachment-row', { hasText: EXTENSION_ID });
      await expect(attachmentRow).toBeVisible();
      await expect(attachmentRow).toContainText('All 1 live catalog tool.');
      await expect(attachmentRow.locator('.live-chip')).toHaveText('Connected');
      await expect(attachmentRow).toContainText('1 live tool');
      await expect(attachmentRow).toContainText('third-party — classification unknown');

      // ---- Wire assertions: unauthenticated loopback, no console errors ----
      expect(fixtureRequests.length).toBeGreaterThan(0);
      for (const entry of fixtureRequests) {
        const headerNames = Object.keys(entry.headers).map((name) => name.toLowerCase());
        expect(headerNames, `${entry.method} ${entry.url}`).not.toContain('authorization');
      }
      expect(auditor.pageErrors).toEqual([]);
      // The fixture deliberately answers the optional GET server-push probe
      // with 405 ("SSE stream not offered"), which Chromium logs as a failed
      // resource; only that documented negotiation response is excluded.
      const appConsoleErrors = auditor.consoleErrors.filter(
        (entry) => !String(entry.location?.url ?? '').startsWith(fixture.url)
      );
      expect(appConsoleErrors).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
