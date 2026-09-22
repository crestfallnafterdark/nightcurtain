/**
 * @file tests/audit/repros/dbeb5d4.test.js
 * @description Audit repro for ticket dbeb5d4 (Minor, area:telemetry): the
 * defensive copy in `RuntimeTelemetry` passes non-plain objects by reference.
 *
 * Evidence: `src/lib/sandbox/runtime/runtimeTelemetry/index.ts:237-263`
 * (`#deepCloneValue` returns non-plain objects unchanged) and `:273-292`
 * (`#deepFreezeValue` skips prototypes other than `Object.prototype`/`null`).
 * A class instance (or `Map`) inside `formattedMessages` is therefore stored
 * aliased and mutable: caller mutation after capture is visible through
 * `getAgentMetrics().lastSentContext`, and the truncation path at `:319-325`
 * writes the caller's own object.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/dbeb5d4.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeTelemetry } from '../../../src/lib/sandbox/runtime/runtimeTelemetry/index.ts';

class PayloadBox {
  constructor(tag) {
    this.tag = tag;
  }
}

class LiveMessage {
  constructor(content) {
    this.role = 'user';
    this.content = content;
  }
}

test('dbeb5d4: lastSentContext must not alias a non-plain message object', () => {
  const telemetry = new RuntimeTelemetry();

  const box = new PayloadBox('original');
  telemetry.recordTurnUsage('agent_nonplain_alias', {
    turnPromptTokens: 1,
    turnCompletionTokens: 1,
    formattedMessages: [{ role: 'user', content: 'hello', metadata: box }]
  });

  try {
    box.tag = 'mutated after send';
  } catch (_) {
    // A fix may freeze the caller object in place; either way the capture must not change.
  }

  const metrics = telemetry.getAgentMetrics('agent_nonplain_alias');
  assert.strictEqual(
    metrics.lastSentContext[0].metadata.tag,
    'original',
    'caller mutation after capture must not be visible in telemetry (no aliasing)'
  );
});

test('dbeb5d4: truncation must not write into the caller message object', () => {
  const telemetry = new RuntimeTelemetry();

  const longContent = 'X'.repeat(300);
  const live = new LiveMessage(longContent);
  const snapshot = telemetry.recordContextSnapshot('agent_nonplain_truncate', [live], {
    maxMessagesToRetain: 10,
    truncateContentAt: 50
  });

  assert.strictEqual(
    live.content,
    longContent,
    'the truncation path must not mutate the caller payload object'
  );
  assert.ok(
    snapshot.messages[0].content.length < longContent.length,
    'the captured copy must still be bounded/truncated'
  );
});
