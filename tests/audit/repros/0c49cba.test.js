/**
 * @file tests/audit/repros/0c49cba.test.js
 * @description Audit repro for ticket 0c49cba (Critical; MOD-21-A):
 * `launchAgent` treats wildcard tool selectors (`allowedTools: ['*']`,
 * `toolPreset: 'all'`, `role: 'all'`, `allowedTools: ['@lifecycle:authority']`)
 * as lifecycle authority, so an anonymous caller can mint a sudoer descriptor.
 *
 * Ratified MOD-21 W8 fix: wildcard tool access is not privilege. A principal
 * without lifecycle authority cannot place `'*'` or `'@lifecycle:authority'`
 * (or any preset alias expanding to them) into the composed `allowedTools`;
 * the operator path may still grant wildcard capability.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/0c49cba.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

const AUTHORITY_CAPABILITY = '@lifecycle:authority';

const HOSTILE_SELECTORS = [
  { label: "role: 'all'", config: { role: 'all' } },
  { label: "toolPreset: 'all'", config: { toolPreset: 'all' } },
  { label: "tools: '*'", config: { tools: '*' } },
  { label: "allowedTools: ['*']", config: { allowedTools: ['*'] } },
  { label: "allowedTools: ['@lifecycle:authority']", config: { allowedTools: [AUTHORITY_CAPABILITY] } },
  { label: "allowedTools: ['*', '@lifecycle:authority']", config: { allowedTools: ['*', AUTHORITY_CAPABILITY] } },
  { label: "allowedTools: ['all'] (preset alias)", config: { allowedTools: ['all'] } },
  { label: "allowedTools: ['read_file', '@lifecycle:authority']", config: { allowedTools: ['read_file', AUTHORITY_CAPABILITY] } }
];

test('0c49cba: anonymous wildcard selectors never mint lifecycle authority', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    for (const [index, { label, config }] of HOSTILE_SELECTORS.entries()) {
      const id = `proxy_${index}`;
      await runtime.launchAgent({ id, ...config });

      const identity = runtime.createAgentIdentityPort().getAgentIdentity(id);
      assert.ok(identity?.authority, `${label}: the agent must register a descriptor`);
      assert.equal(identity.authority.allow.has('*'), false, `${label}: no wildcard authority`);
      assert.equal(identity.authority.allow.has(AUTHORITY_CAPABILITY), false, `${label}: no lifecycle capability`);

      // Every id is ordinary (Wave I, c02d0b9): the descriptor may spawn the
      // literal id but confers no privilege or bypass on it.
      const ordinary = await runtime.launchAgent({ config: { id: 'admin' }, principal: identity.authority });
      assert.equal(ordinary.config.privileged, false, `${label}: the descriptor must not elevate a literal id`);
      assert.equal(
        runtime.createAgentIdentityPort().getAgentIdentity('admin').realmBypass,
        false,
        `${label}: the descriptor must not grant bypass`
      );
      runtime.purgeAgent('admin', { principal: runtime.getOperatorPrincipal() });
      await assert.rejects(
        () => runtime.launchAgent({ config: { id: `priv_${index}`, privileged: true }, principal: identity.authority }),
        (err) => err?.code === 'PERMISSION_DENIED',
        `${label}: the descriptor must not grant privilege`
      );
    }
  } finally {
    runtime.destroy();
  }
});

test('0c49cba: the operator path may still grant wildcard capability', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director')?.authority;
    assert.ok(operator, 'the bootstrapped director carries the operator descriptor');

    await runtime.launchAgent({ config: { id: 'ops_tools', allowedTools: ['*'] }, principal: operator });
    const identity = runtime.createAgentIdentityPort().getAgentIdentity('ops_tools');
    assert.equal(identity.authority.allow.has('*'), true, 'an operator wildcard grant registers the wildcard');
    assert.deepEqual(identity.allowedTools, ['*'], 'the granted whitelist round-trips as config data');

    const privileged = await runtime.launchAgent({
      config: { id: 'ops_priv', privileged: true },
      principal: operator
    });
    assert.equal(privileged.config.privileged, true, 'operator authority may still spawn privileged agents');
  } finally {
    runtime.destroy();
  }
});

test('0c49cba: an unprivileged registered principal cannot self-grant wildcard tools', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'worker', allowedTools: ['read_file'] });
    const child = await runtime.launchAgent({
      config: { id: 'child', allowedTools: ['*'] },
      callerContext: { callerAgentId: 'worker' }
    });
    assert.deepEqual(child.config.allowedTools, ['read_file'], 'the SEC-2 clamp replaces the wildcard request');
    const identity = runtime.createAgentIdentityPort().getAgentIdentity('child');
    assert.equal(identity.authority.allow.has('*'), false, 'the registry descriptor stays default-deny');

    const anonymousChild = await runtime.launchAgent({ id: 'child_anon', allowedTools: ['*'] });
    assert.deepEqual(anonymousChild.config.allowedTools, [], 'an anonymous wildcard request is stripped entirely');
  } finally {
    runtime.destroy();
  }
});
