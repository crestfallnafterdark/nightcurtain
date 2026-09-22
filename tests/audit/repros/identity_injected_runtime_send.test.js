/**
 * @file tests/audit/repros/identity_injected_runtime_send.test.js
 * @description Red-first audit repro for Wave I ticket c02d0b9 (lane I1-F):
 * a store composed over an INJECTED runtime must bind that runtime's host
 * operator principal onto the substrates the store itself constructs, so
 * operator-attributed sends and operator VFS operations authorize by exact
 * reference exactly as they do for a store-created runtime.
 *
 * Target model (Wave I identity model — git-bug `c02d0b9`): the operator is a first-class
 * host-side principal minted by the runtime and exposed through
 * `runtime.getOperatorPrincipal()`. `SandboxStore` injects its store-owned
 * substrates into a store-created runtime (the runtime constructor binds
 * them), but with `new SandboxStore({ runtime })` the store's own
 * `MessagingBus`/`VirtualFS` never receive the reference, so non-agent sends
 * (`store.sendMessage('human', realmBoundTarget, …)`) are denied
 * `PERMISSION_DENIED` and privileged VFS writes are denied too.
 *
 * Red at HEAD 237c54ae: both probes below fail closed. The fix is expected to
 * bind the injected runtime's operator principal on each store-constructed
 * substrate that exposes `bindInternalPrincipal` (bus/VFS/clock), mirroring
 * the runtime constructor's injected-substrate wiring.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/identity_injected_runtime_send.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';
import {
  GENERIC_REALM_ID,
  SandboxStore
} from '../../../src/lib/sandbox/sandboxStore/index.svelte.ts';

/**
 * Closed-loopback model config for the launch fixture. No turn is ever run, so
 * no request leaves the process; the URL only pins the real OpenAI-compatible
 * adapter off vendor defaults. Zero mocks: real runtime, real store, real
 * provider construction.
 */
const OFFLINE_MODEL_CONFIG = Object.freeze({
  providerId: 'openai',
  modelId: 'i1f-injected-runtime-probe',
  url: 'http://127.0.0.1:1/v1'
});

/**
 * Builds a store over an injected real runtime (both substrates store-owned:
 * no `virtualFs`/`messagingBus` injection) and one realm-bound agent.
 *
 * @returns {Promise<{ runtime: AgentRuntime, store: SandboxStore, targetId: string }>}
 */
async function createFixture() {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  const store = new SandboxStore({ runtime, autoBootstrapDirector: false, autoHydrate: false });
  await store.launchAgent({
    id: 'i1f_realm_worker',
    name: 'I1F realm worker',
    realmId: GENERIC_REALM_ID,
    allowedTools: ['read_file'],
    modelConfig: OFFLINE_MODEL_CONFIG
  });
  return { runtime, store, targetId: 'i1f_realm_worker' };
}

test('c02d0b9: injected-runtime store sends as the host operator principal', async () => {
  const { runtime, store, targetId } = await createFixture();
  try {
    const receipt = store.sendMessage('human', targetId, 'Operator hello from outside the realm');
    assert.equal(
      receipt.success,
      true,
      `a non-agent store send must run as the runtime's operator principal; got ${
        receipt.success ? 'delivered' : `${receipt.code}: ${receipt.error}`
      }`
    );
    assert.equal(receipt.to, targetId, 'the operator send must be delivered to the realm-bound recipient');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});

test('c02d0b9: injected-runtime store-owned VFS accepts the host operator principal', async () => {
  const { runtime, store, targetId } = await createFixture();
  try {
    let writeError = null;
    let writeReceipt = null;
    try {
      writeReceipt = store.writeFile('/i1f_operator_probe.txt', 'operator bytes', { workspaceId: targetId });
    } catch (err) {
      writeError = err;
    }

    assert.equal(writeError, null, `an operator VFS write to the agent workspace must authorize; got ${writeError ? `${writeError.code}: ${writeError.message}` : 'none'}`);
    assert.equal(writeReceipt && writeReceipt.success, true, 'the operator VFS write must produce a success receipt');
    assert.equal(writeReceipt && writeReceipt.workspaceId, targetId, 'the write must land in the target workspace');
  } finally {
    store.destroy();
    runtime.destroy();
  }
});
