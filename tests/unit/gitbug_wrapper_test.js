/**
 * @file tests/unit/gitbug_wrapper_test.js
 * @description Unit tests for `scripts/gitbug.mjs`'s pure functions plus one
 * read-only `list --json` smoke against this repository. No tracker state is
 * mutated; the smoke asserts `refs/bugs` is byte-identical before and after.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  validateLabel,
  validateLabels,
  resolveTicketRef,
  buildNewArgs,
  buildCommentArgs,
  main,
} from '../../scripts/gitbug.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/gitbug.mjs', import.meta.url));

function snapshotRefs() {
  const result = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, 'git for-each-ref refs/bugs must succeed');
  return result.stdout.split('\n').filter((line) => line.length > 0);
}

test('validateLabel accepts canonical prefixes and legacy labels', () => {
  for (const label of ['area:settings', 'sev:major', 'type:bug', 'prog:encapsulation', 'prio:high', 'qa', 'mod-21', 'security', 'audit-fail']) {
    assert.deepStrictEqual(validateLabel(label), { ok: true }, `${label} should be valid`);
  }
});

test('validateLabel rejects empty, whitespace, unknown prefix, unknown bare, and empty value', () => {
  assert.strictEqual(validateLabel('').ok, false);
  assert.strictEqual(validateLabel('a b').ok, false);
  assert.strictEqual(validateLabel('area:with space').ok, false);
  assert.strictEqual(validateLabel('foo').ok, false);
  assert.strictEqual(validateLabel('bogus:value').ok, false);
  assert.strictEqual(validateLabel('area:').ok, false);
  assert.match(validateLabel('').reason, /empty/);
  assert.match(validateLabel('a b').reason, /whitespace/);
});

test('validateLabels aggregates only the invalid labels', () => {
  const result = validateLabels(['qa', 'area:tooling', 'nope', 'sev:']);
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(result.invalid.map((entry) => entry.label), ['nope', 'sev:']);
  assert.deepStrictEqual(validateLabels(['qa', 'area:tooling']), { ok: true, invalid: [] });
});

const REFS = [
  'refs/bugs/bb977919c94e16f4682bc3834294c05323f54de96faed3df05f0e4f8dfdc3756',
  'refs/bugs/816e77e7a0f29da84dfcf31f0297aea9b367838d36da0e14113f542c0416acff',
  'refs/bugs/06f1ecb36353ecb405ab28e7fc6d00e350da41c849a32e509141f37285fbbb33',
];

test('resolveTicketRef resolves short ids, prefixes, full ids, and full ref names', () => {
  const expected = 'bb977919c94e16f4682bc3834294c05323f54de96faed3df05f0e4f8dfdc3756';
  for (const ref of ['bb97791', 'bb9779', expected, `refs/bugs/${expected}`, 'BB97791']) {
    const result = resolveTicketRef(ref, REFS);
    assert.strictEqual(result.ok, true, `${ref} should resolve`);
    assert.strictEqual(result.id, expected);
    assert.strictEqual(result.shortId, 'bb97791');
  }
});

test('resolveTicketRef fails on unknown and ambiguous refs without falling back', () => {
  assert.deepStrictEqual(resolveTicketRef('deadbeef', REFS), { ok: false, reason: 'not-found', ref: 'deadbeef' });
  assert.deepStrictEqual(resolveTicketRef('', REFS), { ok: false, reason: 'empty' });
  const ambiguous = resolveTicketRef('0', [
    'refs/bugs/0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'refs/bugs/0bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  ]);
  assert.strictEqual(ambiguous.ok, false);
  assert.strictEqual(ambiguous.reason, 'ambiguous');
  assert.strictEqual(ambiguous.matches.length, 2);
});

test('buildNewArgs default mode honours -t via -m and never emits -F with -t', () => {
  const built = buildNewArgs({ title: 'A title', body: 'A body' });
  assert.deepStrictEqual(built.args, ['bug', 'bug', 'new', '--non-interactive', '-t', 'A title', '-m', 'A body']);
  assert.strictEqual(built.stdin, null);
  assert.ok(!(built.args.includes('-t') && built.args.includes('-F')), '-t and -F must never coexist');
});

test('buildNewArgs --title-from-body uses -F - with stdin and omits -t', () => {
  const built = buildNewArgs({ body: 'first line\nsecond line', titleFromBody: true });
  assert.deepStrictEqual(built.args, ['bug', 'bug', 'new', '--non-interactive', '-F', '-']);
  assert.strictEqual(built.stdin, 'first line\nsecond line');
  assert.ok(!(built.args.includes('-t') && built.args.includes('-F')), '-t and -F must never coexist');

  const withTitle = buildNewArgs({ title: 'ignored', body: 'first', titleFromBody: true });
  assert.deepStrictEqual(withTitle.args, ['bug', 'bug', 'new', '--non-interactive', '-F', '-']);
  assert.ok(!(withTitle.args.includes('-t') && withTitle.args.includes('-F')), '-t and -F must never coexist');
});

test('buildNewArgs throws on missing title or body', () => {
  assert.throws(() => buildNewArgs({ body: 'only body' }), { exitCode: 2 });
  assert.throws(() => buildNewArgs({ title: 'only title' }), { exitCode: 2 });
  assert.throws(() => buildNewArgs({ titleFromBody: true }), { exitCode: 2 });
});

test('buildCommentArgs always passes --non-interactive and -m', () => {
  const built = buildCommentArgs({ body: 'hello' });
  assert.deepStrictEqual(built.args, ['bug', 'bug', 'comment', 'new', '--non-interactive', '-m', 'hello']);
  assert.throws(() => buildCommentArgs({}), { exitCode: 2 });
});

test('main returns exit code 2 for invalid labels without touching git', () => {
  const originalWrite = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.strictEqual(main(['list', '--label', 'a b']), 2);
    assert.strictEqual(main(['list', '--label', 'bogus:thing']), 2);
    assert.strictEqual(main(['list', '--status', 'archived']), 2);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('smoke: list --json parses to an array and leaves refs/bugs untouched', () => {
  const before = snapshotRefs();
  const result = spawnSync(process.execPath, [SCRIPT, 'list', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `list --json failed: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed), 'list --json must be a JSON array');
  assert.ok(parsed.length > 0, 'repository should have at least one ticket');
  for (const ticket of parsed) {
    assert.strictEqual(typeof ticket, 'object');
    assert.strictEqual(typeof ticket.id, 'string');
    assert.strictEqual(typeof (ticket.shortId ?? ticket.human_id), 'string');
    assert.strictEqual(typeof ticket.status, 'string');
  }
  assert.deepStrictEqual(snapshotRefs(), before, 'list --json must not mutate refs/bugs');
});
