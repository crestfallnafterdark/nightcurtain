/**
 * @file tests/audit/repros/20a885f.test.js
 * @description Audit repro for ticket 20a885f (Minor, area:tooling):
 * `probeGitBugTicket()` in `scripts/verify_module_contracts.js` treats the
 * `git bug bug show <ref>` exit code as proof the ref is a real ticket. git-bug
 * silently falls back to the **currently selected** bug for an unresolvable id
 * and still exits 0, so arbitrary hex-shaped refs pass the `@decision` ref
 * durability check.
 *
 * Evidence: `scripts/verify_module_contracts.js` (`probeGitBugTicket` reached
 * from `resolveDurableRef` for any `^[0-9a-f]{7,40}$` ref).
 *
 * Exact enforced claim after the fix: the ticket-resolution predicate is
 * selection-independent — it resolves only refs that prefix-match an actual
 * `refs/bugs/<64-hex>` ref, and rejects bogus hex strings, commit-prefix hex
 * strings, and non-hex refs, regardless of which bug is currently selected.
 *
 * Run directly (not part of `npm test`):
 *   timeout 90 node tests/audit/repros/20a885f.test.js
 */

import '../../test_env.js';
import test from 'node:test';
import assert from 'node:assert/strict';

import { isResolvableTicketRef } from '../../../scripts/verify_module_contracts.js';

/** A real local git-bug ticket id (7-char prefix of a refs/bugs/<64-hex> ref). */
const REAL_TICKET_ID = 'b87de48';

/** Repository HEAD commit at the time this repro was authored. */
const COMMIT_PREFIX = 'eb8f604';

test('20a885f: bogus hex ref is not a resolvable ticket', () => {
  assert.strictEqual(
    isResolvableTicketRef('deadbeef'),
    false,
    "'deadbeef' must not resolve as a ticket (git-bug selection fallback)"
  );
});

test('20a885f: bogus 64-hex ref is not a resolvable ticket', () => {
  const bogus = 'dead'.repeat(16);
  assert.strictEqual(
    isResolvableTicketRef(bogus),
    false,
    `'${bogus}' must not resolve as a ticket`
  );
});

test('20a885f: a real 7-char ticket id resolves', () => {
  assert.strictEqual(
    isResolvableTicketRef(REAL_TICKET_ID),
    true,
    `'${REAL_TICKET_ID}' must resolve as a ticket`
  );
});

test('20a885f: a commit-prefix hex ref is not mistaken for a ticket', () => {
  assert.strictEqual(
    isResolvableTicketRef(COMMIT_PREFIX),
    false,
    `commit prefix '${COMMIT_PREFIX}' must not resolve as a ticket`
  );
});

test('20a885f: non-hex refs are not tickets', () => {
  assert.strictEqual(isResolvableTicketRef('docs/TODO.md'), false);
  assert.strictEqual(isResolvableTicketRef('refs/heads/main'), false);
});
