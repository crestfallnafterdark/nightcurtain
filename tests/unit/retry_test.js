import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, defaultIsRetryable } from '../../src/lib/sandbox/inference/index.ts';

test('withRetry universal exponential backoff test suite', async (t) => {
  await t.test('1. Resolves immediately when operation succeeds on first attempt', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'SUCCESS';
    });

    assert.equal(result, 'SUCCESS');
    assert.equal(calls, 1);
  });

  await t.test('2. Retries on transient failure and returns result on subsequent attempt', async () => {
    let attempts = 0;
    const retryHistory = [];

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('HTTP 429 rate limit exceeded');
          err.status = 429;
          throw err;
        }
        return 'RECOVERED';
      },
      {
        maxRetries: 3,
        baseDelayMs: 20,
        maxDelayMs: 100,
        onRetry: (err, attempt, delay) => retryHistory.push({ attempt, delay })
      }
    );

    assert.equal(result, 'RECOVERED');
    assert.equal(attempts, 3);
    assert.equal(retryHistory.length, 2);
    assert.equal(retryHistory[0].attempt, 1);
    assert.equal(retryHistory[1].attempt, 2);
  });

  await t.test('3. Throws last error when maxRetries is exceeded', async () => {
    let attempts = 0;
    await assert.rejects(
      async () => {
        await withRetry(
          async () => {
            attempts++;
            const err = new Error('503 Service Unavailable');
            err.status = 503;
            throw err;
          },
          { maxRetries: 2, baseDelayMs: 10 }
        );
      },
      /503 Service Unavailable/
    );
    assert.equal(attempts, 3); // Initial attempt + 2 retries
  });

  await t.test('4. Does not retry non-transient errors (e.g. 401 Unauthorized)', async () => {
    let attempts = 0;
    await assert.rejects(
      async () => {
        await withRetry(
          async () => {
            attempts++;
            const err = new Error('Invalid API Key');
            err.status = 401;
            throw err;
          },
          { maxRetries: 3, baseDelayMs: 10 }
        );
      },
      /Invalid API Key/
    );
    assert.equal(attempts, 1); // Fails immediately, no retry
  });

  await t.test('5. Respects AbortSignal cancellation during backoff delay', async () => {
    const controller = new AbortController();

    setTimeout(() => controller.abort(new Error('User aborted backoff')), 30);

    await assert.rejects(
      async () => {
        await withRetry(
          async () => {
            const err = new Error('Rate limit 429');
            err.status = 429;
            throw err;
          },
          { maxRetries: 5, baseDelayMs: 200, signal: controller.signal }
        );
      },
      /aborted/i
    );
  });

  await t.test('6. defaultIsRetryable correctly identifies transient errors', () => {
    assert.equal(defaultIsRetryable({ status: 429 }), true);
    assert.equal(defaultIsRetryable({ status: 500 }), true);
    assert.equal(defaultIsRetryable({ status: 502 }), true);
    assert.equal(defaultIsRetryable({ status: 503 }), true);
    assert.equal(defaultIsRetryable({ status: 504 }), true);
    assert.equal(defaultIsRetryable({ message: 'ETIMEDOUT connection timeout' }), true);
    assert.equal(defaultIsRetryable({ message: 'fetch failed' }), true);
    assert.equal(defaultIsRetryable({ status: 401 }), false);
    assert.equal(defaultIsRetryable({ status: 404 }), false);
  });
});
