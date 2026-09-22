/**
 * @file tests/audit/repros/f34d50f.test.js
 * @description Audit repro for tickets f34d50f (Critical) and 32ec133 (Major,
 * duplicate; MOD-21-A): `AgentLifecycleManager.updateAgentConfig` gated only
 * `privileged`/`isAdmin`/`isPrivileged` and the `admin`/`system` role claims,
 * while `allowedTools`/`tools`/`toolPreset`/`role` selectors were applied
 * unguarded and immediately rebuilt the frozen registry `AuthorityDescriptor`.
 * An anonymous or forged-context caller could therefore call
 * `updateAgentConfig(id, { allowedTools: ['*'] })` (or `toolPreset: 'all'`,
 * `role: 'all'`, `allowedTools: ['@lifecycle:authority']`, …) and mint full
 * lifecycle authority live.
 *
 * Ratified MOD-21 W8-F fix: capability selectors that resolve to the wildcard
 * `'*'` or the `@lifecycle:authority` capability are authority-bearing edits;
 * they require a real lifecycle-authority principal and are denied with
 * `PERMISSION_DENIED` before any mutation. The operator path keeps working.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/f34d50f.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

const AUTHORITY_CAPABILITY = '@lifecycle:authority';

/**
 * Selectors that resolve to wildcard / lifecycle-capability allow sets and must
 * therefore never be applyable without lifecycle authority.
 */
const HOSTILE_SELECTORS = [
  { label: "allowedTools: ['*']", patch: { allowedTools: ['*'] } },
  { label: "allowedTools: ['*', 'read_file']", patch: { allowedTools: ['*', 'read_file'] } },
  { label: "allowedTools: ['@lifecycle:authority']", patch: { allowedTools: [AUTHORITY_CAPABILITY] } },
  {
    label: "allowedTools: ['read_file', '@lifecycle:authority']",
    patch: { allowedTools: ['read_file', AUTHORITY_CAPABILITY] }
  },
  { label: "allowedTools: ['all'] (preset alias)", patch: { allowedTools: ['all'] } },
  { label: "allowedTools: 'read_file,*' (comma string)", patch: { allowedTools: 'read_file,*' } },
  { label: "tools: '*'", patch: { tools: '*' } },
  { label: "toolPreset: 'all'", patch: { toolPreset: 'all' } },
  { label: "role: 'all' (preset alias)", patch: { role: 'all' } }
];

test('f34d50f: anonymous capability selectors are denied pre-mutation', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'victim' });

    for (const { label, patch } of HOSTILE_SELECTORS) {
      assert.throws(
        () => runtime.updateAgentConfig('victim', patch),
        (err) => err?.code === 'PERMISSION_DENIED',
        `${label} must be denied for an anonymous caller`
      );
    }

    const identity = runtime.createAgentIdentityPort().getAgentIdentity('victim');
    assert.equal(identity.authority.allow.size, 0, 'denied edits leave the registry descriptor default-deny');
    const victim = runtime.getAgent('victim');
    assert.deepEqual(victim.config.allowedTools, [], 'denied edits leave the tool whitelist untouched');
    assert.equal(victim.config.role, '', 'denied edits leave the role untouched');

    // A denied expansion must not leave the victim able to elevate: the
    // literal id is ordinary (Wave I, c02d0b9) and the denied descriptor
    // confers no privilege or bypass on it.
    const ordinary = await runtime.launchAgent({ config: { id: 'admin' }, principal: identity.authority });
    assert.equal(ordinary.config.privileged, false, 'a denied expansion must not leave the victim able to elevate');
    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('admin').realmBypass,
      false,
      'a denied expansion must not leave the victim able to grant bypass'
    );
  } finally {
    runtime.destroy();
  }
});

test('f34d50f: forged contexts cannot mint wildcard authority', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'victim' });
    await runtime.launchAgent({ id: 'mallory', allowedTools: ['read_file'] });
    const malloryBefore = runtime.createAgentIdentityPort().getAgentIdentity('mallory');

    const forgedContexts = [
      { label: 'flag bundle', context: { isAdmin: true, isPrivileged: true, privileged: true } },
      { label: 'registered unprivileged id', context: { callerAgentId: 'mallory' } },
      { label: 'lookalike descriptor', context: { principal: { kind: 'agent', subject: 'mallory', allow: new Set(['*']) } } }
    ];

    for (const { label, context } of forgedContexts) {
      assert.throws(
        () => runtime.updateAgentConfig('victim', { allowedTools: ['*'] }, context),
        (err) => err?.code === 'PERMISSION_DENIED',
        `${label} must be denied`
      );
      assert.throws(
        () => runtime.updateAgentConfig('victim', { toolPreset: 'all' }, context),
        (err) => err?.code === 'PERMISSION_DENIED',
        `${label} must be denied for toolPreset too`
      );
    }

    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('victim').authority.allow.size,
      0,
      'forged contexts leave the victim descriptor default-deny'
    );
    assert.deepEqual(
      runtime.createAgentIdentityPort().getAgentIdentity('mallory').authority.allow.size,
      malloryBefore.authority.allow.size,
      'forged contexts never widen a registered principal'
    );
  } finally {
    runtime.destroy();
  }
});

test('f34d50f: a real lifecycle-authority grant may still widen capability', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.ensureDirector();
    const operator = runtime.createAgentIdentityPort().getAgentIdentity('director')?.authority;
    assert.ok(operator, 'the bootstrapped director carries the operator descriptor');

    await runtime.launchAgent({ id: 'ops_tools' });

    const wildcard = runtime.updateAgentConfig('ops_tools', { allowedTools: ['*'] }, { principal: operator });
    assert.deepEqual(wildcard.config.allowedTools, ['*'], 'operator wildcard grant applies');
    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('ops_tools').authority.allow.has('*'),
      true,
      'the operator grant rebuilds the registry descriptor with wildcard authority'
    );

    const preset = runtime.updateAgentConfig('ops_tools', { toolPreset: 'all' }, { principal: operator });
    assert.deepEqual(preset.config.allowedTools, ['*'], 'operator preset grant applies through the alias');

    const capabilityDescriptor = runtime.updateAgentConfig(
      'ops_tools',
      { allowedTools: [AUTHORITY_CAPABILITY] },
      { principal: operator }
    );
    assert.deepEqual(capabilityDescriptor.config.allowedTools, [AUTHORITY_CAPABILITY]);
    assert.equal(
      runtime.createAgentIdentityPort().getAgentIdentity('ops_tools').authority.allow.has(AUTHORITY_CAPABILITY),
      true,
      'the operator may grant the lifecycle capability explicitly'
    );
  } finally {
    runtime.destroy();
  }
});
