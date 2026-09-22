/**
 * @file tests/audit/repros/8990a62.test.js
 * @description Audit repro for ticket 8990a62 (Major, area:docs).
 *
 * SUPERSEDED (2026-09-19, ticket 555dc2c, MOD-21 W9-C): the documented
 * "an options object may override the sender" proxy behavior was ratified as a
 * sender-spoofing defect, so `AgentMessagingProxy` now pins the bound agent as
 * the authoritative sender and strips payload `from`/`sender`. The original
 * assertions of this file (proxy must honor the `from`/`sender` overrides) were
 * reversed by the security ruling; the file now guards the pinned behavior.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/8990a62.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';

test('8990a62 (superseded by 555dc2c): proxy must NOT honor the `sender` alias as a sender override', () => {
  const bus = new MessagingBus();
  bus.registerAgent('c');
  bus.registerAgent('b');

  const receipt = bus.forAgent('c').sendMessage({ sender: 'other', to: 'b', content: 'x' });
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.from, 'c', 'the bound agent id must win over the `sender` alias');

  const read = bus.readMessage('b', receipt.id);
  assert.strictEqual(read.success, true);
  assert.strictEqual(read.message.from, 'c', 'the recipient must observe the bound sender, not the spoofer');
});

test('8990a62 (superseded by 555dc2c): proxy must NOT honor the `from` sender override', () => {
  const bus = new MessagingBus();
  bus.registerAgent('c');
  bus.registerAgent('b');

  const receipt = bus.forAgent('c').sendMessage({ from: 'other2', to: 'b', content: 'x' });
  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.from, 'c', 'the `from` field must not override the bound agent id');
});
