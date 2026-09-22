/**
 * QA harness — one-shot credential vault seeder.
 *
 * Reads provider keys from `.env.local` on this machine, builds the
 * `ai_story_credentials_v1` vault payload, and writes it directly into the
 * Playwright MCP persistent profile. No daemon, no open port, no secrets in
 * tool arguments, logs, or model context.
 *
 * Usage (single-writer profile lock — the MCP browser must be closed first):
 *   1. `browser_close` (MCP tool)
 *   2. `node tests/qa/seed_vault.mjs`
 *   3. continue with the QA run (next MCP call relaunches the browser)
 *
 * Optional env override: `QA_PROFILE_DIR` (defaults to `.playwright/qa-profile`,
 * matching `--user-data-dir` in the global opencode MCP config).
 *
 * Seeds canonical entries for all providers present in `.env.local`; prints
 * provider ids only.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENV_FILE = path.join(REPO_ROOT, ".env.local");
const PROFILE_DIR = process.env.QA_PROFILE_DIR || path.join(REPO_ROOT, ".playwright", "qa-profile");
const APP_URL = "http://localhost:5173/";
const VAULT_KEY = "ai_story_credentials_v1";

const PROVIDERS = [
  { providerId: "runware", envName: "RUNWARE_TEST_API_KEY" },
  { providerId: "deepseek", envName: "DEEPSEEK_TEST_API_KEY" },
  { providerId: "nanogpt", envName: "NANO_TEST_API_KEY" },
  { providerId: "prem", envName: "PREM_TEST_API_KEY" }
];

function readEnvFile(file) {
  if (!fs.existsSync(file)) throw new Error(`missing ${path.basename(file)}`);
  return Object.fromEntries(
    fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const [key, ...rest] = line.split("=");
        return [key.trim(), rest.join("=").trim().replace(/^["']|["']$/g, "")];
      })
  );
}

const env = readEnvFile(ENV_FILE);
const credentials = [];
const active = {};
const seeded = [];

for (const { providerId, envName } of PROVIDERS) {
  const apiKey = env[envName];
  if (!apiKey) continue;
  const id = `canonical_${providerId}`;
  credentials.push({
    id,
    providerId,
    label: "QA seed",
    apiKey,
    createdAt: 0,
    lastUsed: null,
    isCanonical: true
  });
  active[providerId] = id;
  seeded.push(providerId);
}

if (seeded.length === 0) throw new Error(".env.local contains no recognized QA provider keys");

const vaultJson = JSON.stringify({ credentials, active });

const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
try {
  await context.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    { key: VAULT_KEY, value: vaultJson }
  );
  const page = await context.newPage();
  await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
  const written = await page.evaluate((key) => window.localStorage.getItem(key) !== null, VAULT_KEY);
  if (!written) throw new Error("vault seed verification failed");
  console.log(`Vault seeded for: ${seeded.join(", ")} (profile: ${PROFILE_DIR})`);
} finally {
  await context.close();
}
