/**
 * @file tests/audit/repros/4074766.test.js
 * @description Audit repro for ticket 4074766 (Major; MOD-21 sub-issue 5):
 * the tool dispatcher honors caller-supplied privilege flags on the per-call
 * `callerContext` (`isAdmin`/`isPrivileged`/`privileged`) and lets a per-call
 * `allowedTools` value override the trusted allowlist, contradicting the
 * `AgentIdentityPort` rule that privilege derives from trusted configuration
 * only (never caller claims).
 *
 * Ratified MOD-21 W1 fix: per-call `callerContext` is caller data, never
 * authority. The dispatcher strips privilege flags and `allowedTools` from it;
 * privilege and capability derive only from trusted bound construction options
 * and the injected identity port. The trusted engine path (bound options) is
 * unaffected.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/4074766.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxToolDispatcher } from '../../../src/lib/sandbox/toolDefinitions/index.ts';

function createVfs() {
  return {
    writeFile: async (params) => ({ success: true, bytes_written: params?.content?.length ?? 0 })
  };
}

for (const flag of ['isAdmin', 'isPrivileged', 'privileged']) {
  test(`4074766: forged per-call {${flag}: true} cannot invoke a restricted tool`, async () => {
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: createVfs(),
      agentId: 'probe_agent',
      allowedTools: []
    });

    const receipt = await dispatcher.executeTool(
      'write_file',
      { file_path: '/probe.txt', content: 'x' },
      { [flag]: true }
    );

    assert.equal(receipt.success, false, `forged ${flag} must not authorize write_file`);
    assert.equal(receipt.code, 'PERMISSION_DENIED');
  });
}

test('4074766: per-call allowedTools cannot widen the trusted bound allowlist', async () => {
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: createVfs(),
    agentId: 'limited_agent',
    allowedTools: ['read_file']
  });

  const forged = await dispatcher.executeTool(
    'write_file',
    { file_path: '/probe.txt', content: 'x' },
    { allowedTools: ['*'] }
  );
  assert.equal(forged.success, false, 'per-call allowedTools must not unlock write_file');
  assert.equal(forged.code, 'PERMISSION_DENIED');
});

test('4074766: trusted bound privilege still executes the restricted tool', async () => {
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: createVfs(),
    agentId: 'trusted_agent',
    privileged: true,
    allowedTools: []
  });

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/trusted.txt', content: 'x' });
  assert.equal(receipt.success, true);
});

test('4074766: trusted identity port grants privilege without any caller flags', async () => {
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: createVfs(),
    agentId: 'identity_agent',
    identityPort: {
      getAgentIdentity: (agentId) => (
        agentId === 'identity_agent'
          ? { id: agentId, privileged: true, allowedTools: ['*'] }
          : null
      )
    }
  });

  const receipt = await dispatcher.executeTool('write_file', { file_path: '/identity.txt', content: 'x' });
  assert.equal(receipt.success, true);
});

test('4074766: per-call privilege flags cannot override a bound unprivileged identity port', async () => {
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: createVfs(),
    agentId: 'plain_agent',
    identityPort: {
      getAgentIdentity: (agentId) => (
        agentId === 'plain_agent'
          ? { id: agentId, privileged: false, allowedTools: ['read_file'] }
          : null
      )
    }
  });

  const receipt = await dispatcher.executeTool(
    'write_file',
    { file_path: '/plain.txt', content: 'x' },
    { isAdmin: true, isPrivileged: true, privileged: true }
  );
  assert.equal(receipt.success, false);
  assert.equal(receipt.code, 'PERMISSION_DENIED');
});

// -----------------------------------------------------------------------------
// MOD21-A follow-through (ticket a1ce597): the identity *subject* is pinned to
// bound construction. A per-call id can no longer select the director's
// AuthorityDescriptor.
// -----------------------------------------------------------------------------

/** Identity port where only the registered `director` carries privilege. */
function createDirectorIdentityPort() {
  return {
    getAgentIdentity: (agentId) => {
      if (agentId === 'director') return { id: agentId, privileged: true, allowedTools: ['*'] };
      if (agentId === 'bound_agent') return { id: agentId, privileged: false, allowedTools: [] };
      return null;
    }
  };
}

for (const forgedContext of [
  { callerAgentId: 'director' },
  { agentId: 'director' },
  { callerContext: { agentId: 'director' } }
]) {
  test(`4074766: per-call ${JSON.stringify(forgedContext)} cannot select the director identity subject`, async () => {
    const dispatcher = createSandboxToolDispatcher({
      virtualFs: createVfs(),
      agentId: 'bound_agent',
      allowedTools: [],
      identityPort: createDirectorIdentityPort()
    });

    const receipt = await dispatcher.executeTool(
      'write_file',
      { file_path: '/forged.txt', content: 'x' },
      forgedContext
    );
    assert.equal(receipt.success, false, 'the bound unprivileged subject must be the only subject consulted');
    assert.equal(receipt.code, 'PERMISSION_DENIED');
  });
}

test('4074766: nested per-call callerContext.agentId cannot identify an anonymous dispatcher', async () => {
  const dispatcher = createSandboxToolDispatcher({
    virtualFs: createVfs(),
    allowedTools: [],
    identityPort: createDirectorIdentityPort()
  });

  const receipt = await dispatcher.executeTool(
    'write_file',
    { file_path: '/forged.txt', content: 'x' },
    { callerContext: { agentId: 'director' } }
  );
  assert.equal(receipt.success, false, 'an anonymous dispatcher must default-deny');
  assert.equal(receipt.code, 'PERMISSION_DENIED');
});
