/**
 * @file tests/audit/repros/916b052.test.js
 * @description Audit repro for ticket 916b052 (Minor, area:security, MOD-21):
 * `Agent#authority.allow` is mutable through `Set.prototype.add.call` despite
 * the freeze. `freezeAuthorityAllow` shadows the own `add`/`delete`/`clear`
 * properties with `undefined` and calls `Object.freeze`, but `Object.freeze`
 * does not block mutation of a Set's internal `[[SetData]]`, so the prototype
 * call widens the "frozen" authority allow-set.
 *
 * Expected: `agent.authority.allow` is a genuinely immutable read-only set
 * (Proxy-backed facade, matching the lifecycle registry descriptor); no
 * mutator — own or prototype — can add/delete/clear members.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/916b052.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { Agent } from '../../../src/lib/sandbox/runtime/agent/index.ts';

test('916b052: entity allow-set resists Set.prototype.add.call mutation', () => {
  const agent = new Agent({ id: 'mutation-probe', allowedTools: ['read_file'] });

  assert.ok(Object.isFrozen(agent.authority), 'authority descriptor must stay frozen');
  assert.strictEqual(typeof agent.authority.allow.add, 'undefined', 'own mutators must be neutralized');

  assert.throws(
    () => Set.prototype.add.call(agent.authority.allow, '*'),
    TypeError,
    'prototype-call add must throw (a Proxy has no [[SetData]])'
  );
  assert.strictEqual(agent.authority.allow.has('*'), false, 'prototype-call add must not widen the allow-set');
  assert.deepStrictEqual([...agent.authority.allow], ['read_file'], 'the allow-set contents must be unchanged');
  assert.strictEqual(agent.authority.allow.size, 1);

  assert.throws(
    () => Set.prototype.delete.call(agent.authority.allow, 'read_file'),
    TypeError,
    'prototype-call delete must throw'
  );
  assert.throws(
    () => Set.prototype.clear.call(agent.authority.allow),
    TypeError,
    'prototype-call clear must throw'
  );
  assert.strictEqual(agent.authority.allow.has('read_file'), true, 'prototype-call delete must not remove members');
});

test('916b052: forEach never hands out the mutable backing set', () => {
  const agent = new Agent({ id: 'forEach-probe', allowedTools: ['read_file'] });

  const seen = [];
  agent.authority.allow.forEach((value, key, collection) => {
    seen.push({ value, key, collection });
  });

  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].value, 'read_file');
  assert.strictEqual(seen[0].key, 'read_file');
  assert.strictEqual(
    seen[0].collection,
    agent.authority.allow,
    'forEach must pass the frozen facade itself, never the backing set'
  );
  assert.ok(Object.isFrozen(seen[0].collection), 'the collection handed to forEach must be frozen');
  assert.strictEqual(typeof seen[0].collection.add, 'undefined', 'the handed-out collection must expose no mutators');
  assert.throws(
    () => Set.prototype.add.call(seen[0].collection, '*'),
    TypeError,
    'the handed-out collection must resist prototype-call mutation'
  );
  assert.strictEqual(agent.authority.allow.has('*'), false, 'forEach must not widen the allow-set');
  assert.deepStrictEqual([...agent.authority.allow], ['read_file'], 'the allow-set contents must be unchanged');

  const thisArg = { count: 0 };
  agent.authority.allow.forEach(function () { this.count += 1; }, thisArg);
  assert.strictEqual(thisArg.count, 1, 'forEach must honor the thisArg argument');
});

test('916b052: privileged wildcard allow-set resists prototype-call mutation too', () => {
  const privileged = new Agent({ id: 'privileged-probe', privileged: true, allowedTools: ['*'] });

  assert.deepStrictEqual([...privileged.authority.allow], ['*']);
  assert.throws(() => Set.prototype.add.call(privileged.authority.allow, 'forged_tool'), TypeError);
  assert.strictEqual(privileged.authority.allow.has('forged_tool'), false);
  assert.throws(() => Set.prototype.clear.call(privileged.authority.allow), TypeError);
  assert.strictEqual(privileged.authority.allow.has('*'), true);
});
