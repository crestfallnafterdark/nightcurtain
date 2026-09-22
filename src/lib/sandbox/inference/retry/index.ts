/**
 * @packageDocumentation
 * Universal exponential backoff retry policy, decoupled from providers,
 * models, or network layers.
 *
 * @module inference/retry
 * @mustNotImport ../../modelConfig/index.ts
 * @mustNotImport ../../runtime/*
 * @mustNotImport ../../domain/*
 * @mustNotImport ../../tools/*
 * @invariant Provider-agnostic: zero imports; works on any async operation.
 * @invariant Delay before retry `attempt` is `min(baseDelayMs * 2^(attempt - 1), maxDelayMs)`, plus up to 25 % random jitter added when `jitter` is enabled (default).
 * @invariant Abort-aware: `AbortSignal` is checked before each attempt and after each failure, and an abort during the backoff sleep rejects immediately; the sleep's `abort` listener is removed on settle.
 * @invariant Transient classification defaults to `defaultIsRetryable` (HTTP 429, 5xx up to 504, recognized message substrings) and is overridable via `isRetryable`.
 * @invariant Errors named `AbortError` are never retried.
 * @decision `retry` stays fetch-free; transport I/O lives only in the adapter pairs
 */

/**
 * Retry policy configuration for {@link withRetry}.
 */
export interface RetryOptions {
  /** Maximum number of retries after the initial attempt. Default: `3`. */
  maxRetries?: number;
  /** Base delay in milliseconds before the first retry. Default: `1000`. */
  baseDelayMs?: number;
  /**
   * Cap applied to the exponential delay before jitter is added, in
   * milliseconds. With `jitter` enabled the actual sleep can exceed this value
   * by up to 25 %. Default: `10000`.
   */
  maxDelayMs?: number;
  /** Whether to add up to 25 % random jitter to each delay. Default: `true`. */
  jitter?: boolean;
  /**
   * Transient-error classifier invoked with the error thrown by the failed
   * attempt. Return `false` to rethrow that error immediately. Default:
   * {@link defaultIsRetryable}.
   */
  isRetryable?: (error: unknown) => boolean;
  /**
   * Cancellation signal. Checked before each attempt, after each failed
   * attempt, and throughout the backoff sleep. An abort detected before an
   * attempt rejects with the signal's reason (or an `Error`) without invoking
   * `fn`; an abort during the sleep rejects immediately; an abort observed
   * after a failed attempt stops further retries and rethrows that attempt's
   * error rather than the abort reason.
   */
  signal?: AbortSignal;
  /**
   * Observation hook invoked synchronously before each backoff sleep; not
   * invoked when the error is non-retryable, retries are exhausted, or an
   * abort has already been observed. A hook that throws rejects the call with
   * that error.
   *
   * @param error - The error thrown by the failed attempt.
   * @param attempt - 1-based retry attempt number (1 = first retry).
   * @param delayMs - Computed delay (including jitter) in milliseconds.
   */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

// ============================================================================
// Retryability Classification
// ============================================================================

/**
 * Structural view over the retry-relevant fields of an arbitrary thrown value.
 */
interface ErrorFields {
  /** HTTP status, when the value exposes one. */
  status?: unknown;
  /** Alternate HTTP status field. */
  statusCode?: unknown;
  /** Numeric or string error code. */
  code?: unknown;
  /** Human-readable message. */
  message?: unknown;
  /** Alternate message field. */
  error?: unknown;
  /** Error name (used to detect `AbortError`). */
  name?: unknown;
}

/**
 * Reads the retry-relevant fields of an arbitrary thrown value without
 * narrowing its runtime shape; primitives yield an empty view.
 *
 * @param err - Candidate thrown value.
 * @returns Field view (`{}` for primitives).
 */
function errorFields(err: unknown): ErrorFields {
  return (typeof err === 'object' || typeof err === 'function') && err !== null
    ? (err as ErrorFields)
    : {};
}

/**
 * Determines whether an error is transient and eligible for retry.
 *
 * Retryable when the error exposes HTTP status 429 or any 5xx status up to and
 * including 504 (`status`, `statusCode`, or numeric `code`), or when the
 * stringified message/error contains a known transient marker: `429`, `500`,
 * `502`, `503`, `504`, `rate limit`, `too many requests`, `quota`, `concurrency`,
 * `concurrent`, `timeout`, `timed out`, `network`, `fetch failed`, `econnreset`,
 * or `etimedout`.
 *
 * Falsy inputs are never retryable. The message match stringifies `message`,
 * falling back to `error`, then to the value itself.
 *
 * @param err - Candidate error value (Error, provider error shape, or thrown value).
 * @returns True when the error is classified as transient/retryable.
 *
 * @example
 * ```typescript
 * import { defaultIsRetryable } from './index.ts';
 *
 * defaultIsRetryable({ status: 429 });          // true
 * defaultIsRetryable({ status: 401 });          // false
 * defaultIsRetryable({ message: 'fetch failed' }); // true
 * ```
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (!err) return false;

  const fields = errorFields(err);
  const status = fields.status || fields.statusCode || (typeof fields.code === 'number' ? fields.code : null);
  if (status === 429 || (Number(status) >= 500 && Number(status) <= 504)) {
    return true;
  }

  const msg = String(fields.message || fields.error || err || '').toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota') ||
    msg.includes('concurrency') ||
    msg.includes('concurrent') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  );
}

// ============================================================================
// Exponential Backoff Wrapper
// ============================================================================

/**
 * Universal exponential backoff wrapper for any async operation.
 * Decoupled from providers, models, or network layers.
 *
 * Type parameter `T`.
 * @param fn - Async function to execute.
 * @param options - Retry policy configuration (defaults: 3 retries, 1 s base, 10 s cap, jitter on).
 * @returns Result of `fn()`.
 * @throws The last error thrown by `fn()` once retries are exhausted or the error is non-retryable.
 * @throws The `AbortSignal` reason (or an `Error`) when aborted before an attempt or during backoff.
 *
 * @example
 * ```typescript
 * import { withRetry } from './index.ts';
 *
 * const data = await withRetry(() => fetchJson('/api/models'), {
 *   maxRetries: 3,
 *   onRetry: (err, attempt, delayMs) => console.warn(`retry ${attempt} in ${delayMs}ms`, err)
 * });
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10000,
    jitter = true,
    isRetryable = defaultIsRetryable,
    signal,
    onRetry
  } = options;

  let attempt = 0;

  while (true) {
    if (signal?.aborted) {
      throw signal.reason || new Error('Operation aborted');
    }

    try {
      return await fn();
    } catch (err) {
      attempt++;

      if (attempt > maxRetries || signal?.aborted || !isRetryable(err) || errorFields(err).name === 'AbortError') {
        throw err;
      }

      let delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      if (jitter) {
        delay += Math.random() * (delay * 0.25);
      }

      onRetry?.(err, attempt, delay);

      await new Promise<void>((resolve, reject) => {
        let onAbort: (() => void) | undefined;
        const timer = setTimeout(() => {
          if (signal && onAbort) {
            signal.removeEventListener('abort', onAbort);
          }
          resolve();
        }, delay);

        if (signal) {
          if (signal.aborted) {
            clearTimeout(timer);
            reject(signal.reason || new Error('Operation aborted during retry backoff'));
            return;
          }

          onAbort = () => {
            clearTimeout(timer);
            if (signal && onAbort) {
              signal.removeEventListener('abort', onAbort);
            }
            reject(signal.reason || new Error('Operation aborted during retry backoff'));
          };

          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }
  }
}
