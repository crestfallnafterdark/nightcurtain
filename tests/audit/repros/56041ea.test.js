/**
 * @file tests/audit/repros/56041ea.test.js
 * @description Audit repro for tickets 56041ea and 240a9cf (Minor, area:docs).
 * `RuntimeTelemetry` applies `Math.floor`/`Math.max` to numeric option values
 * without a finiteness guard, so NaN/Infinity bypass every documented clamp and
 * default.
 *
 * - 56041ea (capacity options): non-finite `maxTraceEventsPerAgent` /
 *   `maxGlobalTraceEvents` flow into ring-buffer capacities as
 *   `new Array(NaN)` / `new Array(Infinity)` and throw `RangeError: Invalid
 *   array length` — synchronously from the constructor for the global buffer
 *   (JS:155-159, 169, 57-59) and on the first recorded event for per-agent
 *   buffers (JS:606-613). Documented contract: clamped to >= 1, default
 *   200/1000.
 * - 240a9cf (snapshot options): non-finite `maxMessagesToRetain` /
 *   `truncateContentAt` defeat the INV-6 bounds — `slice(-(NaN - 2))` is
 *   `slice(NaN)`, which returns the whole list, so the capture grows to head +
 *   entire input, and `content.length > NaN` is always false, so no content is
 *   ever truncated (JS:1018-1019, 447-462). Documented contract: floored,
 *   clamped to >= 1/>= 10, default 50/2000.
 *
 * Both tickets share one root: non-finite values must fall back to the
 * documented defaults before any `Math.floor`/`Math.max`/slice arithmetic.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/56041ea.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeTelemetry } from '../../../src/lib/sandbox/runtime/runtimeTelemetry/index.ts';

const DEFAULT_MAX_TRACE_PER_AGENT = 200;
const DEFAULT_MAX_MESSAGES_TO_RETAIN = 50;
const DEFAULT_TRUNCATE_CONTENT_AT = 2000;

// --- 56041ea: ring-buffer capacity options ---

test('56041ea: non-finite global capacity options fall back to the default instead of throwing', () => {
  for (const value of [NaN, Infinity]) {
    assert.doesNotThrow(
      () => new RuntimeTelemetry({ maxGlobalTraceEvents: value }),
      `maxGlobalTraceEvents: ${value} must not throw RangeError from the constructor`
    );
  }
});

test('56041ea: non-finite per-agent capacity options fall back to the default instead of throwing on first event', () => {
  for (const value of [NaN, Infinity]) {
    const telemetry = new RuntimeTelemetry({ maxTraceEventsPerAgent: value });
    assert.doesNotThrow(
      () => telemetry.recordPrecall('agent_nonfinite_capacity', 1),
      `maxTraceEventsPerAgent: ${value} must not throw on the first recorded event`
    );
  }
});

test('56041ea: non-finite per-agent capacity falls back to the documented default bound', () => {
  const telemetry = new RuntimeTelemetry({ maxTraceEventsPerAgent: NaN });
  for (let i = 0; i < DEFAULT_MAX_TRACE_PER_AGENT + 5; i++) {
    telemetry.recordPrecall('agent_default_bound', 1);
  }
  const trace = telemetry.getTrace('agent_default_bound', { limit: DEFAULT_MAX_TRACE_PER_AGENT + 100 });
  assert.strictEqual(
    trace.length,
    DEFAULT_MAX_TRACE_PER_AGENT,
    'a NaN capacity must fall back to the default 200-event bound, not disable eviction'
  );
});

// --- 240a9cf: context snapshot retention/truncation options ---

test('240a9cf: non-finite retention option falls back to the default bound without head duplication', () => {
  const telemetry = new RuntimeTelemetry();
  const messages = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: 'x', i }));

  const record = telemetry.recordContextSnapshot('agent_nonfinite_retention', messages, {
    maxMessagesToRetain: NaN,
    truncateContentAt: NaN
  });

  assert.strictEqual(
    record.messages.length,
    DEFAULT_MAX_MESSAGES_TO_RETAIN,
    'a NaN retention option must fall back to the default 50-entry bound'
  );
  assert.strictEqual(
    telemetry.getAgentMetrics('agent_nonfinite_retention').lastSentContext.length,
    DEFAULT_MAX_MESSAGES_TO_RETAIN,
    'INV-6: lastSentContext must stay bounded under non-finite options'
  );
});

test('240a9cf: non-finite options on a small list must not duplicate the head', () => {
  const telemetry = new RuntimeTelemetry();
  const messages = Array.from({ length: 5 }, (_, i) => ({ role: 'user', content: 'x'.repeat(10), i }));

  const record = telemetry.recordContextSnapshot('agent_nonfinite_small', messages, {
    maxMessagesToRetain: NaN,
    truncateContentAt: NaN
  });

  assert.deepStrictEqual(
    record.messages.map(m => m.i),
    [0, 1, 2, 3, 4],
    'each input message must appear exactly once (no head duplication from slice(NaN))'
  );
});

test('240a9cf: non-finite truncation option still truncates at the default limit', () => {
  const telemetry = new RuntimeTelemetry();
  const longContent = 'y'.repeat(DEFAULT_TRUNCATE_CONTENT_AT + 1000);

  const record = telemetry.recordContextSnapshot(
    'agent_nonfinite_truncation',
    [{ role: 'system', content: longContent }],
    { truncateContentAt: NaN }
  );

  assert.ok(
    record.messages[0].content.length < longContent.length,
    'content must still be truncated when the truncation option is non-finite'
  );
  assert.match(
    record.messages[0].content,
    /\[truncated \d+ chars\]/,
    'the truncation marker must be present'
  );
});

test('240a9cf: infinite retention option falls back to the default bound', () => {
  const telemetry = new RuntimeTelemetry();
  const messages = Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: 'x', i }));

  const record = telemetry.recordContextSnapshot('agent_infinite_retention', messages, {
    maxMessagesToRetain: Infinity
  });

  assert.strictEqual(
    record.messages.length,
    DEFAULT_MAX_MESSAGES_TO_RETAIN,
    'Infinity is not a meaningful capacity; the documented default bound applies'
  );
});
