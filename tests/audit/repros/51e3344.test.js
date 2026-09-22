/**
 * @file tests/audit/repros/51e3344.test.js
 * @description Audit repro for ticket 51e3344 (Minor, area:docs): the
 * `InlineFileOptions.callerAgentId` alias is documented as an alias for `from`,
 * but the object-parameter call form resolves the caller from
 * `params.from || params.sender || context.callerAgentId || context.agentId`
 * only, so `params.callerAgentId` yields `INVALID_ARGUMENTS`.
 *
 * Status (A1): the original probe — payload `params.callerAgentId` promoted
 * while a trailing `{ virtualFs }` context is supplied — is obsolete, superseded
 * by MOD-21 W10-B (ref bdc5cee): a supplied context object is the only identity
 * source, so payload identity is never promoted and an identity-less context
 * fails closed. The alias remains ratified only for genuinely contextless
 * direct-API object calls, and the object form binds the caller from the
 * supplied execution context. This repro now pins those ratified behaviors
 * instead of the superseded promotion.
 *
 * Evidence: `src/lib/sandbox/messagingBus/index.ts` object form (MOD-21 W10-B
 * `resolveRoutingIdentity`) vs the ratified `InlineFileOptions.callerAgentId`
 * documentation for contextless direct-API calls.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/51e3344.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MessagingBus,
  MESSAGING_ERROR_CODES
} from '../../../src/lib/sandbox/messagingBus/index.ts';

const makeVfs = () => ({ readFile: async () => ({ content: 'x', totalBytes: 1 }) });

test('51e3344: object form resolves the caller from the supplied execution context', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('b');

  const result = await bus.inlineFileInMessage(
    { filePath: '/f.txt', recipient: 'b' },
    { virtualFs: makeVfs(), callerAgentId: 'c' }
  );

  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(result.from, 'c');
});

test('51e3344: contextless object form honors the documented callerAgentId alias', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('b');

  const result = await bus.inlineFileInMessage({
    filePath: '/f.txt',
    recipient: 'b',
    callerAgentId: 'c',
    virtualFs: makeVfs()
  });

  assert.strictEqual(result.success, true, result.error);
  assert.strictEqual(result.from, 'c');
});

test('51e3344: identity-less context fails closed and never promotes payload callerAgentId', async () => {
  const bus = new MessagingBus();
  bus.registerAgent('b');

  const result = await bus.inlineFileInMessage(
    { filePath: '/f.txt', recipient: 'b', callerAgentId: 'c' },
    { virtualFs: makeVfs() }
  );

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.code, MESSAGING_ERROR_CODES.INVALID_ARGUMENTS);
});
