/**
 * @file tests/helpers/wired_identity_fixture.js
 * @description Wave I (ticket d57cbc1) wiring-lane test fixture.
 *
 * Host-side suites that inject their own `VirtualFS`/`MessagingBus` predate the
 * canonical identity wiring: the composition root constructs those substrates
 * with its identity port, while an injected instance carries none — so a bare
 * agent id no longer addresses the canonical registration and an
 * engine-bound canonical `callerKey` fails closed. This fixture builds the same
 * late-bound identity bridge the store composition root uses, and exposes an
 * operator-attributed host send: the caller-supplied label is presented on the
 * envelope while authority and Realm scope come from the operator principal
 * (the documented host/operator path). Tests that need their own handles can
 * keep them: `virtualFs`/`messagingBus` are the port-wired instances.
 */

import { AgentRuntime } from '../../src/lib/sandbox/runtime/index.ts';
import { VirtualFS } from '../../src/lib/sandbox/virtualFs/index.ts';
import { MessagingBus } from '../../src/lib/sandbox/messagingBus/index.ts';
import { WorldClock } from '../../src/lib/sandbox/worldClock/index.ts';

/**
 * Builds a runtime whose substrates resolve agent identity through the
 * runtime's canonical identity port (late-bound, like the store bridge).
 *
 * @param {{ autoBootstrapDirector?: boolean, messagingBus?: object | null, virtualFs?: object | null, withClock?: boolean }} [options]
 *   Runtime options; a supplied substrate is reused verbatim (for fixtures that
 *   must share one instance across runtimes), otherwise a port-wired one is built.
 *   `withClock: true` builds and returns a port-wired `WorldClock`.
 * @returns {{
 *   runtime: AgentRuntime,
 *   virtualFs: VirtualFS,
 *   messagingBus: MessagingBus,
 *   worldClock: object | null,
 *   operator: object,
 *   hostSend: (payload: object) => object
 * }} The fixture handles.
 */
export function createWiredRuntime({ autoBootstrapDirector = false, messagingBus: sharedBus = null, virtualFs: sharedVfs = null, withClock = false } = {}) {
  let identityPort = null;
  const bridge = {
    getAgentIdentity: (agentId, scope) => (identityPort ? identityPort.getAgentIdentity(agentId, scope) : null),
    listAgentIdentities: (scope) => (identityPort ? identityPort.listAgentIdentities(scope) : [])
  };
  const virtualFs = sharedVfs || new VirtualFS({ identityPort: bridge });
  const messagingBus = sharedBus || new MessagingBus({ identityPort: bridge });
  const worldClock = withClock ? new WorldClock({ virtualFs, identityPort: bridge }) : null;
  const runtime = new AgentRuntime({
    virtualFs,
    messagingBus,
    ...(worldClock ? { worldClock } : {}),
    autoBootstrapDirector
  });
  identityPort = runtime.createAgentIdentityPort();
  const operator = runtime.getOperatorPrincipal();
  return {
    runtime,
    virtualFs,
    messagingBus,
    worldClock,
    operator,
    hostSend: (payload) => messagingBus.sendMessage(payload, {
      callerAgentId: payload?.from || payload?.sender,
      principal: operator
    })
  };
}
