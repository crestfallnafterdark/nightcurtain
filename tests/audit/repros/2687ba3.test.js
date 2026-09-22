/**
 * @file tests/audit/repros/2687ba3.test.js
 * @description Audit repro for ticket 2687ba3 (Major, area:docs): four store
 * lifecycle methods (`launchAgent`, `restoreAgent`, `updateAgentConfig`,
 * `ensureDirector`) are declared to resolve to normalized `AgentStateSnapshot`
 * projections but returned the raw runtime `Agent` instance.
 *
 * Evidence: `src/lib/sandbox/sandboxStore/index.svelte.ts:418-425`, `:467-475`,
 * `:543-546`, `:554-557` returned the runtime result directly, while
 * `AgentStateSnapshot` requires a numeric `unreadCount` and `string | null`
 * `lastError`, and the raw `Agent` carries engine internals (`modelConfig`)
 * that no store contract may expose.
 *
 * Fixture note (P2, migrated for Wave I ticket c02d0b9): the store is the
 * operator surface — lifecycle mutations run under the runtime's host operator
 * principal (`runtime.getOperatorPrincipal()`, exact-reference validated), so
 * they succeed with zero agents and never depend on a director existing. The
 * fail-closed property now lives at the direct runtime call: a restore without
 * a trusted principal (or with a forged lookalike) is denied with
 * `PERMISSION_DENIED` and leaves the recycled record intact. The companion
 * test holds the injected runtime and pins both sides of that boundary.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/2687ba3.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSandboxStore } from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';
import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

function assertNormalizedSnapshot(result, label) {
  assert.ok(result, `${label} must resolve to an AgentStateSnapshot`);
  assert.strictEqual(typeof result.unreadCount, 'number', `${label} must expose the normalized unreadCount`);
  assert.ok(
    result.lastError === null || typeof result.lastError === 'string',
    `${label} lastError must be string | null`
  );
  assert.ok(!('modelConfig' in result), `${label} must not leak the runtime Agent modelConfig`);
}

test('2687ba3: lifecycle methods return normalized AgentStateSnapshot projections', async () => {
  const store = createSandboxStore({ autoBootstrapDirector: false, autoHydrate: false });
  try {
    // Operator bootstrap (MOD-21 W6): registers the director principal through
    // which the store authorizes the kill/restore below.
    const director = await store.ensureDirector();
    assertNormalizedSnapshot(director, 'ensureDirector result');
    assert.strictEqual(
      director,
      store.agents.find(a => a.id === 'director'),
      'ensureDirector must return the reactive normalized projection'
    );

    const launched = await store.launchAgent({ id: 'agent-scout', name: 'Scout Unit', role: 'Recon' });
    assertNormalizedSnapshot(launched, 'launchAgent result');
    assert.strictEqual(launched.id, 'agent-scout');
    assert.strictEqual(
      launched,
      store.agents.find(a => a.id === 'agent-scout'),
      'launchAgent must return the reactive normalized projection'
    );

    const updated = store.updateAgentConfig('agent-scout', { name: 'Scout Unit Prime' });
    assertNormalizedSnapshot(updated, 'updateAgentConfig result');
    assert.strictEqual(updated.name, 'Scout Unit Prime');
    assert.strictEqual(
      updated,
      store.agents.find(a => a.id === 'agent-scout'),
      'updateAgentConfig must return the reactive normalized projection'
    );

    store.killAgent('agent-scout', 'Recycle for restore coverage', { callerAgentId: 'agent-scout' });
    const restored = store.restoreAgent('agent-scout');
    assertNormalizedSnapshot(restored, 'restoreAgent result');
    assert.strictEqual(
      restored,
      store.agents.find(a => a.id === 'agent-scout'),
      'restoreAgent must return the reactive normalized projection'
    );
  } finally {
    store.destroy();
  }
});

test('2687ba3: store restore is operator-authorized; anonymous/forged direct restores fail closed', async () => {
  // Injected runtime: the store keeps its engine encapsulated, so the repro
  // holds the direct-call handle. Real instances only — a real SandboxStore
  // over a real AgentRuntime, zero mocks.
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = createSandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });
  try {
    assert.strictEqual(store.agents.length, 0, 'fixture: zero agents — no director is bootstrapped');

    const launched = await store.launchAgent({
      id: 'anon-scout',
      name: 'Anon Scout',
      role: 'Recon',
      // Wildcard tools make restoring the record re-derive an authority-bearing
      // descriptor (`#wouldRestoreAuthority`): the runtime then requires
      // lifecycle authority for the restore, so a forged identity claim can
      // never satisfy the gate.
      allowedTools: ['*']
    });
    assertNormalizedSnapshot(launched, 'anonymous launchAgent result');

    // Self-scoped recycle is authorized by the target's own registry identity...
    store.killAgent('anon-scout', 'Anonymous recycle', { callerAgentId: 'anon-scout' });
    assert.ok(store.getRecycledAgent('anon-scout'), 'setup: anon-scout must be recycled');

    // ...and the store, as the operator surface (Wave I, ticket c02d0b9),
    // restores it under the runtime's host operator principal with zero agents:
    // operator actions never depend on a director principal existing.
    const restored = store.restoreAgent('anon-scout');
    assertNormalizedSnapshot(restored, 'operator store restore result');
    assert.strictEqual(
      restored,
      store.agents.find(a => a.id === 'anon-scout'),
      'the operator store restore must put the record back into the reactive agents projection'
    );

    // Recycle again and probe the runtime directly: the fail-closed property
    // lives at the direct call, where no trusted principal is presented.
    store.killAgent('anon-scout', 'Recycle for direct-restore probes', { callerAgentId: 'anon-scout' });
    assert.ok(store.getRecycledAgent('anon-scout'), 'setup: anon-scout must be recycled again');

    assert.throws(
      () => runtime.restoreAgent('anon-scout'),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a direct context-less runtime restore must fail closed'
    );
    assert.throws(
      () => runtime.restoreAgent('anon-scout', { callerAgentId: 'anon-scout' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a forged self-id restore claim must fail closed'
    );
    assert.throws(
      () => runtime.restoreAgent('anon-scout', { kind: 'internal' }),
      (err) => err?.code === 'PERMISSION_DENIED',
      'a forged internal-principal lookalike must fail closed'
    );

    assert.ok(
      store.getRecycledAgent('anon-scout'),
      'the denied direct restores must leave the recycled record intact'
    );
    assert.ok(
      runtime.hasRecycledAgent('anon-scout'),
      'the recycled record survives every denied direct restore in the runtime recycle bin'
    );
    assert.ok(
      !store.agents.find(a => a.id === 'anon-scout'),
      'no denied direct restore may re-enter the active agents projection'
    );
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
