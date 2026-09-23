#!/usr/bin/env node
/**
 * @file tests/qa/live_hydration_run.mjs
 * @description Live hydration run for a local (untracked) format-v2 hydration
 * fixture (ticket `a4e8ae9`): drives the real UI end to end — import the
 * transport bundle, attach the composed payload, review, launch — then
 * verifies the landed placements and captures screenshots under
 * `data/qa/hydration-fixture/run/`.
 *
 * The composed artifacts must exist first
 * (`tests/qa/compose_hydration_payload.mjs`) and the dev server must be
 * running (`npm run dev`).
 *
 * Output is structural only: counts, labels, paths, booleans, digests. Prompt
 * text and lore content are never printed.
 *
 * Usage: node tests/qa/live_hydration_run.mjs [--url http://localhost:5173]
 * Exit codes: 0 green, 1 verification failure, 2 usage/input error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

/** Repository root (this script lives in `tests/qa/`). */
const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
/** Composed transport bundle (import step). */
const BUNDLE_PATH = path.join(PROJECT_ROOT, 'data/qa/hydration-fixture/bundle-v2.json');
/** Composed canonical payload (attach step). */
const PAYLOAD_PATH = path.join(PROJECT_ROOT, 'data/qa/hydration-fixture/payload-v2.json');
/** Screenshot directory for this run. */
const SHOTS_DIR = path.join(PROJECT_ROOT, 'data/qa/hydration-fixture/run');
/** Declared lore files in the composed payload. */
const EXPECTED_LORE = 22;

const args = process.argv.slice(2);
let baseUrl = process.env.SANDBOX_URL || 'http://localhost:5173';
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--url' && args[index + 1]) {
    baseUrl = args[index + 1];
    index += 1;
  } else {
    process.stderr.write('usage: node tests/qa/live_hydration_run.mjs [--url <base>]\n');
    process.exit(2);
  }
}
for (const required of [BUNDLE_PATH, PAYLOAD_PATH]) {
  if (!fs.existsSync(required)) {
    process.stderr.write(`live_hydration_run: missing artifact ${required} — run tests/qa/compose_hydration_payload.mjs first\n`);
    process.exit(2);
  }
}
/** Template identity declared by the composed transport bundle. */
const BUNDLE_DOC = JSON.parse(fs.readFileSync(BUNDLE_PATH, 'utf8'));
const TEMPLATE_ID = BUNDLE_DOC.template.id;
const TEMPLATE_NAME = BUNDLE_DOC.template.name;
fs.mkdirSync(SHOTS_DIR, { recursive: true });

const summary = {};
let failed = false;
const check = (label, ok, detail = '') => {
  summary[label] = ok ? 'ok' : `FAIL ${detail}`;
  if (!ok) failed = true;
};

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
  // ---- Import the transport bundle -----------------------------------------
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.drawer-header-actions button[aria-label="Launch Realm from Template"]', { timeout: 30000 });
  await page.click('.drawer-header-actions button[aria-label="Launch Realm from Template"]');
  await page.waitForSelector('.realm-launcher-modal', { timeout: 15000 });

  await page.setInputFiles('input[aria-label="Import realm template bundle"]', BUNDLE_PATH);
  await page.waitForSelector('.realm-launcher-modal .notice-banner', { timeout: 15000 });
  summary.importNotice = (await page.textContent('.realm-launcher-modal .notice-banner')).trim();
  check('import', /imported|Imported/.test(summary.importNotice), summary.importNotice);

  // ---- Select the template and attach the composed payload -----------------
  await page.selectOption('#realm-template-select', TEMPLATE_ID);
  await page.waitForSelector('.section-title:has-text("Hydration workspace — inputs")', { timeout: 15000 });
  summary.inputLabels = (await page.locator('.realm-launcher-modal .settings-section-card:has(.section-title:has-text("Hydration workspace")) .form-group > label').allTextContents())
    .map((text) => text.replace(/\s+/g, ' ').trim());
  check('four inputs', summary.inputLabels.length === 4, String(summary.inputLabels.length));

  await page.selectOption('select[aria-label="Payload attachment source"]', 'file');
  await page.setInputFiles('input[aria-label="Attach instance payload file"]', PAYLOAD_PATH);
  await page.waitForTimeout(1200);

  summary.payloadStatus = (await page.locator('.realm-launcher-modal .payload-status').first().textContent()).replace(/\s+/g, ' ').trim();
  summary.pinCard = (await page.locator('.realm-launcher-modal .pin-card').textContent()).replace(/\s+/g, ' ').trim();
  check('pin visible', /sha256:/.test(summary.pinCard));
  await page.screenshot({ path: path.join(SHOTS_DIR, '01-hydration-workspace.png'), fullPage: true });

  // ---- Review: per-agent prompt part order (labels only) -------------------
  const agentCards = page.locator('.realm-launcher-modal .agent-preview-card');
  const agentCount = await agentCards.count();
  summary.agents = [];
  for (let index = 0; index < agentCount; index += 1) {
    const card = agentCards.nth(index);
    const name = (await card.locator('.agent-preview-name').textContent()).trim();
    const parts = (await card.locator('.prompt-preview .part-row .part-label').allTextContents())
      .map((text) => text.replace(/\s+/g, ' ').trim());
    summary.agents.push({ name, parts });
  }
  const director = summary.agents.find((agent) => /director/i.test(agent.name));
  const narrator = summary.agents.find((agent) => /narrator/i.test(agent.name));
  check('two agents', agentCount === 2 && Boolean(director) && Boolean(narrator));
  check('director brief last', Boolean(director) && director.parts.length > 0 && /^input .*Director brief/.test(director.parts[director.parts.length - 1]), JSON.stringify(director?.parts));
  check('narrator brief last', Boolean(narrator) && narrator.parts.length > 0 && /^input .*Narrator brief/.test(narrator.parts[narrator.parts.length - 1]), JSON.stringify(narrator?.parts));
  await page.screenshot({ path: path.join(SHOTS_DIR, '02-review-prompts.png'), fullPage: true });

  // ---- Launch ---------------------------------------------------------------
  await page.locator('.review-ack input[type="checkbox"]').check();
  await page.waitForTimeout(600);
  summary.reviewAckChecked = await page.locator('.review-ack input[type="checkbox"]').isChecked();
  summary.gateHint = (await page.locator('.launch-gate-hint').count()) > 0
    ? (await page.locator('.launch-gate-hint').first().textContent()).replace(/\s+/g, ' ').trim()
    : '';
  summary.launchDisabled = await page.locator('.realm-launcher-modal button[type="submit"]:has-text("Launch Realm")').isDisabled();
  await page.locator('.realm-launcher-modal button[type="submit"]:has-text("Launch Realm")').click();
  await page.waitForSelector('.realm-launcher-modal .launch-receipt', { timeout: 30000 });
  summary.receipt = (await page.textContent('.realm-launcher-modal .launch-receipt')).replace(/\s+/g, ' ').trim();
  check('launched', summary.receipt.includes(TEMPLATE_NAME), summary.receipt);
  const realmName = (summary.receipt.match(/Launched (.+?) realm_/) || [])[1] || '';
  summary.realmName = realmName;
  await page.screenshot({ path: path.join(SHOTS_DIR, '03-launch-receipt.png'), fullPage: true });
  await page.click('.realm-launcher-modal .btn-close');
  await page.waitForSelector('.realm-launcher-modal', { state: 'detached', timeout: 10000 });

  // ---- Verify placements in the Virtual Filesystem -------------------------
  await page.click('nav button:has-text("Virtual Filesystem")');
  await page.waitForSelector('.ws-pill', { timeout: 15000 });

  const directorPill = page.locator('.ws-pill', { hasText: realmName ? `${realmName} · director` : '· director' }).first();
  await directorPill.click();
  await page.waitForTimeout(400);
  const lorePaths = (await page.locator('.file-row .file-path').allTextContents())
    .map((text) => text.trim())
    .filter((value) => value.startsWith('/lore/'));
  summary.directorLoreCount = lorePaths.length;
  check('22 lore files', lorePaths.length === EXPECTED_LORE, String(lorePaths.length));
  check('lore paths unique', new Set(lorePaths).size === lorePaths.length);
  summary.firstLorePath = lorePaths[0] || '';
  summary.lastLorePath = lorePaths[lorePaths.length - 1] || '';
  await page.screenshot({ path: path.join(SHOTS_DIR, '04-director-lore.png'), fullPage: true });

  const globalPill = page.locator('.ws-pill', { hasText: realmName ? `${realmName} · global` : '· global' }).first();
  await globalPill.click();
  await page.waitForTimeout(400);
  const globalPaths = (await page.locator('.file-row .file-path').allTextContents()).map((text) => text.trim());
  summary.realmGlobalPaths = globalPaths;
  check('opening scene', globalPaths.includes('/scene/opening.md'), JSON.stringify(globalPaths));
  await page.screenshot({ path: path.join(SHOTS_DIR, '05-realm-global-scene.png'), fullPage: true });
} catch (error) {
  failed = true;
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  await browser.close();
}

process.stdout.write(`live_hydration_run: ${failed ? 'FAIL' : 'OK'}\n`);
for (const [key, value] of Object.entries(summary)) {
  process.stdout.write(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}
process.stdout.write(`  screenshots: ${SHOTS_DIR}\n`);
process.exitCode = failed ? 1 : 0;
