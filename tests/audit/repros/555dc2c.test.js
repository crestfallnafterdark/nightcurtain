/**
 * @file tests/audit/repros/555dc2c.test.js
 * @description Audit repro for ticket 555dc2c (Minor, area:security, MOD-21):
 * the `MessagingBus.forAgent(agentId)` agent-scoped proxy lets caller payload
 * `from`/`sender` fields override the bound sender identity on `sendMessage`
 * (and `from`/`sender`/`callerAgentId` on `inlineFileInMessage`), so a proxy
 * can spoof another agent.
 *
 * Expected: the bound agent ID is the authoritative sender at every proxy send
 * seam (payload identity is stripped/ignored), while contextless direct-API
 * calls keep their documented payload sender fallback.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/555dc2c.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { MessagingBus } from '../../../src/lib/sandbox/messagingBus/index.ts';
import { VirtualFS } from '../../../src/lib/sandbox/virtualFs/index.ts';

function setupBus() {
  const bus = new MessagingBus();
  bus.registerAgent('mallory');
  bus.registerAgent('victim');
  bus.registerAgent('director');
  return bus;
}

test('555dc2c: proxy sendMessage ignores the payload `from` spoof', () => {
  const bus = setupBus();

  const receipt = bus.forAgent('mallory').sendMessage({
    from: 'director',
    to: 'victim',
    content: 'spoof'
  });

  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.from, 'mallory', 'the bound agent must remain the sender');
  assert.strictEqual(receipt.replyTo, 'mallory', 'replyTo must default to the bound sender');

  const read = bus.readMessage('victim', receipt.id);
  assert.strictEqual(read.success, true);
  assert.strictEqual(read.message.from, 'mallory', 'the recipient must observe the bound sender');
});

test('555dc2c: proxy sendMessage ignores the `sender` alias spoof', () => {
  const bus = setupBus();

  const receipt = bus.forAgent('mallory').sendMessage({
    sender: 'director',
    to: 'victim',
    content: 'spoof'
  });

  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.from, 'mallory', 'the bound agent must remain the sender');
});

test('555dc2c: positional proxy sendMessage stays bound to the proxy agent', () => {
  const bus = setupBus();

  const receipt = bus.forAgent('mallory').sendMessage('victim', 'hello');

  assert.strictEqual(receipt.success, true);
  assert.strictEqual(receipt.from, 'mallory');
});

test('555dc2c: proxy inlineFileInMessage ignores sender-identity spoof options', async () => {
  const bus = setupBus();
  const vfs = new VirtualFS();
  vfs.writeFile('/notes.txt', 'Secret notes', { workspaceId: 'global' });

  const spoofs = [
    { from: 'director' },
    { sender: 'director' },
    { callerAgentId: 'director' }
  ];

  for (const spoof of spoofs) {
    const result = await bus.forAgent('mallory').inlineFileInMessage('/notes.txt', 'victim', {
      virtualFs: vfs,
      ...spoof
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(
      result.from,
      'mallory',
      `bound sender must survive ${JSON.stringify(spoof)}`
    );
  }
});

test('555dc2c: contextless direct-API sender fallback is retained', () => {
  const bus = setupBus();

  const fromReceipt = bus.sendMessage({ from: 'director', to: 'victim', content: 'legit' });
  assert.strictEqual(fromReceipt.success, true);
  assert.strictEqual(fromReceipt.from, 'director');

  const senderReceipt = bus.sendMessage({ sender: 'director', to: 'victim', content: 'legit' });
  assert.strictEqual(senderReceipt.success, true);
  assert.strictEqual(senderReceipt.from, 'director');
});
