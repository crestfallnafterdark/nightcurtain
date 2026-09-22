/**
 * @file tests/audit/repros/502ceac.test.js
 * @description Audit repro for ticket 502ceac (Major, area:docs): `importSnapshot`
 * is documented as atomic/fail-closed (`src/lib/sandbox/runtime/index.ts:19`,
 * `:1741-1742`) but clears the prior registry before validating that every
 * serialized agent can hydrate, and surfaces hydration failures as uncoded
 * errors.
 *
 * Evidence: `src/lib/sandbox/runtime/index.ts:1293-1304` clears registries after
 * only a top-level shape check; `:1309-1321` hydrates entry-by-entry, so a
 * malformed trailing record destroys prior state, commits a partial restore,
 * and throws an error without `ERR_SNAPSHOT_INVALID`.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/502ceac.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentRuntime } from '../../../src/lib/sandbox/runtime/index.ts';

test('502ceac: malformed importSnapshot is fail-closed and leaves the prior registry intact', async () => {
  const runtime = createAgentRuntime({ autoBootstrapDirector: false });
  try {
    await runtime.launchAgent({ id: 'survivor_1', role: 'helper' });

    const malformedSnapshot = {
      agents: [
        { id: 'ok_agent', config: { id: 'ok_agent' } },
        { id: 'bad_agent', config: { id: 'bad_agent', modelConfig: { providerId: 'custom' } } }
      ]
    };

    assert.throws(
      () => runtime.importSnapshot(malformedSnapshot),
      { code: 'ERR_SNAPSHOT_INVALID' },
      'malformed hydration must fail closed with ERR_SNAPSHOT_INVALID'
    );

    assert.strictEqual(runtime.getAgentCount(), 1, 'failed import must not destroy the prior registry');
    assert.ok(runtime.getAgent('survivor_1'), 'pre-existing agent must survive the failed import');
    assert.strictEqual(runtime.hasAgent('ok_agent'), false, 'rejected snapshot must not be partially hydrated');
  } finally {
    runtime.destroy();
  }
});
