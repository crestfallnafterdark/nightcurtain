/**
 * QA harness — pre-flight provider smoke probe.
 *
 * Makes ONE minimal chat completion per configured provider before the live
 * provider suites run, so failures can be attributed to the provider/key
 * rather than to engine code. Required providers: NanoGPT and DeepSeek (the
 * consistently reliable pair); flaky providers are intentionally not probed.
 *
 * Usage: `node tests/qa/provider_smoke.mjs`
 * Exit 0 = every required provider completed; non-zero = key missing or failed.
 * Never prints key material; prints provider ids, booleans and sanitized errors.
 */
import '../test_env.js';
import { NanoGptProvider, DeepSeekProvider } from '../../src/lib/sandbox/inference/index.ts';

const TIMEOUT_MS = 45_000;

const PROVIDERS = [
  {
    id: 'nanogpt',
    envKeys: ['NANO_TEST_API_KEY', 'NANOGPT_API_KEY'],
    modelId: 'deepseek/deepseek-v4.1-flash:thinking',
    create: (apiKey) => new NanoGptProvider({ apiKey })
  },
  {
    id: 'deepseek',
    envKeys: ['DEEPSEEK_TEST_API_KEY', 'DEEPSEEK_API_KEY'],
    modelId: 'deepseek-v4-pro',
    create: (apiKey) => new DeepSeekProvider({ apiKey })
  }
];

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
      timer.unref?.();
    })
  ]);
}

let failures = 0;

for (const spec of PROVIDERS) {
  const apiKey = spec.envKeys.map((name) => process.env[name]).find(Boolean) || '';
  if (!apiKey) {
    console.log(`[${spec.id}] FAIL key=missing (${spec.envKeys.join('|')})`);
    failures++;
    continue;
  }

  const startedAt = Date.now();
  try {
    const provider = spec.create(apiKey);
    const balance = await withTimeout(provider.checkBalance(), `${spec.id} balance`);
    if (balance.available === false) {
      console.log(`[${spec.id}] FAIL balance="${String(balance.error || 'unavailable').slice(0, 200)}"`);
      failures++;
      continue;
    }

    const model = provider.createModel(spec.modelId, { maxTokens: 32, temperature: 0 });
    const result = await withTimeout(
      model.complete({ messages: [{ role: 'user', content: 'Reply with exactly: SMOKE_OK' }] }),
      `${spec.id} completion`
    );

    const text = `${result?.content || ''} ${result?.reasoning || ''}`.toUpperCase();
    if (!text.includes('SMOKE_OK')) {
      console.log(`[${spec.id}] FAIL completion=no-mark latency=${Date.now() - startedAt}ms`);
      failures++;
      continue;
    }

    console.log(`[${spec.id}] OK balance=available completion=SMOKE_OK latency=${Date.now() - startedAt}ms`);
  } catch (err) {
    const message = String(err?.message || err).replace(/\s+/g, ' ').slice(0, 240);
    console.log(`[${spec.id}] FAIL error="${message}" latency=${Date.now() - startedAt}ms`);
    failures++;
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
