/**
 * @file tests/audit/repros/dd73ca7.test.js
 * @description Audit repro for ticket dd73ca7 (Major; MOD-21 W8-A):
 * per-call `callerContext` overrides bound capabilities (`executeTool`,
 * `virtualFs`, ...) because the untrusted context is spread last and only
 * `lifecyclePort`/`identityPort` are re-pinned. `batch_precall` (innate,
 * reachable with an empty allowlist) delegates to whatever executor the
 * caller context carries, enabling precall executor/substrate substitution.
 *
 * Contract under test: bound construction options are the only authority and
 * capability source; per-call `callerContext` can never override them.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/dd73ca7.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

test('dd73ca7 A: forged per-call executeTool cannot replace the bound precall executor', async () => {
  let called = null;
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: { writeFile: async () => ({ success: true }) },
    agentId: 'mallory',
    allowedTools: [],
    executeTool: async () => {
      called = 'trusted';
      return { success: true, marker: 'trusted' };
    }
  });

  const forged = async () => {
    called = 'forged';
    return { success: true, marker: 'forged' };
  };

  const receipt = await dispatcher.executeTool(
    'batch_precall',
    { calls: [{ name: 'list_agents', arguments: {} }] },
    { executeTool: forged }
  );

  assert.equal(called, 'trusted', 'the bound executor must win over the per-call executor');
  assert.equal(receipt.success, true);
  assert.equal(receipt.results[0].result.marker, 'trusted');
});

test('dd73ca7 B: forged per-call virtualFs cannot replace the bound substrate', async () => {
  let forgedUsed = false;
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: { readFile: async () => ({ success: true, real: true }) },
    agentId: 'mallory',
    allowedTools: ['read_file']
  });

  const receipt = await dispatcher.executeTool(
    'read_file',
    { file_path: '/x.txt' },
    {
      virtualFs: {
        readFile: async () => {
          forgedUsed = true;
          return { success: true, forged: true };
        }
      }
    }
  );

  assert.equal(forgedUsed, false, 'the bound virtualFs must win over the per-call substrate');
  assert.equal(receipt.success, true);
  assert.equal(receipt.real, true, 'the receipt must come from the bound substrate');
});

test('dd73ca7 C: per-call executeTool is ignored when no executor is bound', async () => {
  let forgedCalled = false;
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: { writeFile: async () => ({ success: true }) },
    agentId: 'mallory',
    allowedTools: []
  });

  const receipt = await dispatcher.executeTool(
    'batch_precall',
    { calls: [{ name: 'list_agents', arguments: {} }] },
    {
      executeTool: async () => {
        forgedCalled = true;
        return { success: true, marker: 'forged' };
      }
    }
  );

  assert.equal(forgedCalled, false, 'an unbound dispatcher must never adopt a per-call executor');
  assert.equal(receipt.success, true, 'the batch envelope remains a successful receipt');
});

test('dd73ca7 D: forged per-call messagingBus/worldClock cannot replace bound substrates', async () => {
  let forgedBusUsed = false;
  let boundBusUsed = false;
  const dispatcher = createSandboxToolDispatcher({
    messagingBus: {
      listInbox: async () => {
        boundBusUsed = true;
        return { success: true, source: 'bound' };
      }
    },
    agentId: 'mallory',
    allowedTools: ['list_inbox']
  });

  const receipt = await dispatcher.executeTool(
    'list_inbox',
    {},
    {
      messagingBus: {
        listInbox: async () => {
          forgedBusUsed = true;
          return { success: true, source: 'forged' };
        }
      }
    }
  );

  assert.equal(forgedBusUsed, false, 'the bound messagingBus must win over the per-call substrate');
  assert.equal(boundBusUsed, true, 'the bound messagingBus must serve the call');
  assert.equal(receipt.success, true);
  assert.equal(receipt.source, 'bound');
});
