/**
 * Shared Test Environment & Browser Polyfills for Node.js
 */

export class MockLocalStorage {
  #store = new Map();
  #quotaExceeded = false;

  getItem(key) {
    return this.#store.has(key) ? this.#store.get(key) : null;
  }

  setItem(key, value) {
    if (this.#quotaExceeded) {
      const err = new Error('QuotaExceededError: LocalStorage quota exceeded');
      err.name = 'QuotaExceededError';
      err.code = 22;
      throw err;
    }
    this.#store.set(String(key), String(value));
  }

  removeItem(key) {
    this.#store.delete(key);
  }

  clear() {
    this.#store.clear();
  }

  get length() {
    return this.#store.size;
  }

  key(index) {
    return Array.from(this.#store.keys())[index] || null;
  }

  __simulateQuotaExceeded(exceeded) {
    this.#quotaExceeded = exceeded;
  }

  __dump() {
    return Object.fromEntries(this.#store.entries());
  }
}

export const sharedLocalStorage = new MockLocalStorage();

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    localStorage: sharedLocalStorage
  };
} else {
  globalThis.window.localStorage = sharedLocalStorage;
}

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    body: { appendChild: () => {}, removeChild: () => {}, contains: () => true },
    createElement: () => ({ href: '', download: '', click: () => {}, style: {} })
  };
}

if (typeof URL.createObjectURL === 'undefined') {
  URL.createObjectURL = (_blob) => `blob:mock-url-${Math.random().toString(36).slice(2)}`;
  URL.revokeObjectURL = (_url) => {};
}

// Svelte 5 Rune emulation for Node.js
if (typeof globalThis.$state === 'undefined') {
  globalThis.$state = function(val) { return val; };
  globalThis.$state.snapshot = function(val) { return structuredClone(val); };
}

// Environment variables and .env.local loader for integration & LLM tests
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

export function loadEnvFiles() {
  const envFiles = ['.env.local', '.env'];
  for (const file of envFiles) {
    const fullPath = path.join(projectRoot, file);
    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      } catch (err) {
        // Ignore read errors
      }
    }
  }
}

// Auto-load on import
loadEnvFiles();

/**
 * Returns structured test API keys for LLM and provider testing
 */
export function getTestApiKeys() {
  return {
    deepseek: process.env.DEEPSEEK_TEST_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    nanogpt: process.env.NANO_TEST_API_KEY || process.env.NANOGPT_API_KEY || '',
    prem: process.env.PREM_TEST_API_KEY || process.env.PREM_API_KEY || '',
    runware: process.env.RUNWARE_TEST_API_KEY || process.env.RUNWARE_API_KEY || ''
  };
}

/**
 * Helper to populate sharedLocalStorage with live test API keys
 */
export function seedLocalStorageWithTestKeys() {
  const keys = getTestApiKeys();
  const providerKeys = {};
  if (keys.deepseek) providerKeys.deepseek = keys.deepseek;
  if (keys.nanogpt) providerKeys.nanogpt = keys.nanogpt;
  if (keys.prem) providerKeys.prem = keys.prem;
  if (keys.runware) providerKeys.runware = keys.runware;

  sharedLocalStorage.setItem('ai_story_provider_keys', JSON.stringify(providerKeys));
  if (keys.deepseek) {
    sharedLocalStorage.setItem('ai_story_api_key', keys.deepseek);
  }
  return keys;
}
