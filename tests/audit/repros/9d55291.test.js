/**
 * @file tests/audit/repros/9d55291.test.js
 * @description Audit repro for ticket 9d55291 (Major, area:security, MOD-21):
 * `AgentRuntime.importSnapshot` re-authorized any entity whose id is `director`
 * from `DIRECTOR_SPEC` (wildcard descriptor) but adopted the snapshot-supplied
 * entity body verbatim, so a crafted persisted snapshot planted an
 * operator-privileged director with attacker-controlled config.
 *
 * Wave I (ticket c02d0b9) removed the reserved-id namespace and every
 * hydration-time re-authorization: a hydrated record is data only. Expected:
 * a snapshot-supplied `director` body never receives engine authority or the
 * `realmBypass` grant, so a crafted snapshot can never pair privilege with
 * attacker-controlled config.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/9d55291.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { AgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

const ATTACKER_PROMPT = 'attacker-controlled';

test('9d55291: a snapshot-supplied director body never receives engine authority', () => {
  const runtime = new AgentRuntime({ autoBootstrapDirector: false });
  try {
    runtime.importSnapshot({
      agents: [
        {
          id: 'director',
          name: 'director',
          config: { id: 'director', role: 'user', systemPrompt: ATTACKER_PROMPT },
          state: 'idle',
          history: [],
          redoStack: [],
          pendingPrecalls: [],
          telemetry: {}
        }
      ],
      recycleBin: []
    });

    const director = runtime.getAgent('director');
    assert.ok(director, 'the hydrated record exists under its canonical key');
    const projection = runtime.createAgentIdentityPort().getAgentIdentity('director');
    assert.strictEqual(
      projection.authority.allow.size,
      0,
      'hydration must never mint engine authority beside a snapshot body'
    );
    assert.strictEqual(
      projection.realmBypass,
      false,
      'hydration must never mint the realmBypass grant beside a snapshot body'
    );
  } finally {
    runtime.destroy();
  }
});
