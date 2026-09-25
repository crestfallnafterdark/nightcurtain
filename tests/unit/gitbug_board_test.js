/**
 * @file tests/unit/gitbug_board_test.js
 * @description Tests for the wrapper's triage verbs (`board`, `next`, `brief`,
 * `apply`) plus their pure projections. Every mutation runs inside a temporary
 * git repo created by this suite; the live tracker is never touched.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalFields,
  triageRank,
  formatAgeDays,
  truncateTitle,
  sortTickets,
  extractCrossRefs,
  formatBriefPlain,
  briefTicketJson,
  boardTicketJson,
  buildBugListArgs,
} from '../../scripts/gitbug.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/gitbug.mjs', import.meta.url));

/** Per-file scratch root, removed after the suite. */
const TEST_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gitbug-board-unit-'));
after(() => fs.rmSync(TEST_TMP, { recursive: true, force: true }));

/** Fixture repo populated once in `before`. */
let repo = '';
/** Fixture ticket short ids, in creation order. */
const ids = {};

/**
 * Run a command synchronously and fail the test on a non-zero exit.
 * @param {string} command Executable.
 * @param {string[]} args Arguments.
 * @param {string} cwd Working directory.
 * @returns {{status: number|null, stdout: string, stderr: string}} Result.
 */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(result.status, 0, `${command} ${args.join(' ')} failed: ${result.stderr}`);
  return result;
}

/**
 * Spawn the wrapper inside a fixture repo.
 * @param {string[]} args Wrapper argv.
 * @param {string} [cwd] Working directory (fixture repo by default).
 * @param {NodeJS.ProcessEnv} [extraEnv] Extra environment.
 * @returns {{status: number|null, stdout: string, stderr: string}} Result.
 */
function wrapper(args, cwd = repo, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.GITBUG_LOCK_PATH;
  delete env.GITBUG_LOCK_TIMEOUT;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Create a git-bug ticket and return its short id.
 * @param {string} title Ticket title.
 * @param {string} body Ticket body.
 * @param {string[]} [labels] Labels to apply.
 * @returns {string} Short id.
 */
function newTicket(title, body, labels = []) {
  const refsBefore = new Set(
    run('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], repo)
      .stdout.split('\n').filter((line) => line.length > 0)
  );
  run('git', ['bug', 'bug', 'new', '--non-interactive', '-t', title, '-m', body], repo);
  const refsAfter = run('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], repo)
    .stdout.split('\n').filter((line) => line.length > 0);
  const added = refsAfter.filter((name) => !refsBefore.has(name));
  assert.strictEqual(added.length, 1, `expected exactly one new ref for ${title}`);
  const short = added[0].replace(/^refs\/bugs\//, '').slice(0, 7);
  if (labels.length > 0) run('git', ['bug', 'bug', 'label', 'new', short, ...labels], repo);
  return short;
}

/**
 * The plain output lines of a wrapper invocation, header removed.
 * @param {string[]} args Wrapper argv.
 * @returns {string[]} Ticket lines.
 */
function boardLines(args = []) {
  const result = wrapper(['board', ...args]);
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((line) => line.length > 0 && !line.startsWith('#'));
}

before(() => {
  repo = fs.mkdtempSync(path.join(TEST_TMP, 'fixture-'));
  run('git', ['init', '-q'], repo);
  run('git', ['config', 'user.email', 'probe@example.com'], repo);
  run('git', ['config', 'user.name', 'Probe'], repo);
  run('git', ['commit', '-q', '--allow-empty', '-m', 'init'], repo);
  run('git', ['bug', 'user', 'new', '--non-interactive', '-n', 'Probe', '-e', 'probe@example.com'], repo);

  ids.beta = newTicket('Beta task ticket', 'Summary: beta.', ['area:docs', 'prio:normal', 'type:task']);
  ids.alpha = newTicket(
    'Alpha defect ticket',
    `Summary: alpha.\n\nEvidence: see ${ids.beta} and \`deadbee\` and \`aaaaaaaabbbb\` refs.`,
    ['area:tooling', 'sev:major', 'prio:high', 'type:defect']
  );
  ids.gamma = newTicket('Gamma untagged ticket', 'Summary: gamma.');
  ids.closed = newTicket('Delta closed ticket', 'Summary: delta.', ['area:tooling', 'sev:low']);
  run('git', ['bug', 'bug', 'status', 'close', ids.closed], repo);
});

test('triageRank orders severity, priority, then untagged', () => {
  assert.strictEqual(triageRank(['sev:critical']), 0);
  assert.strictEqual(triageRank(['sev:major']), 1);
  assert.strictEqual(triageRank(['prio:high']), 2);
  assert.strictEqual(triageRank(['sev:minor', 'prio:high']), 2, 'best label wins');
  assert.strictEqual(triageRank(['sev:minor']), 3);
  assert.strictEqual(triageRank(['prio:normal']), 4);
  assert.strictEqual(triageRank(['prio:low']), 5);
  assert.strictEqual(triageRank(['sev:low']), 6);
  assert.strictEqual(triageRank(['sev:cosmetic']), 7);
  assert.strictEqual(triageRank([]), 8);
  assert.strictEqual(triageRank(['qa', 'prog:realm']), 8);
  assert.strictEqual(triageRank(['sev:bogus']), 8, 'unknown values are ignored');
});

test('canonicalFields returns nulls, first values, and sorted areas', () => {
  assert.deepStrictEqual(canonicalFields(undefined), { prio: null, sev: null, type: null, areas: [] });
  assert.deepStrictEqual(
    canonicalFields(['area:tooling', 'sev:minor', 'area:docs', 'prio:low', 'type:defect', 'prio:high']),
    { prio: 'low', sev: 'minor', type: 'defect', areas: ['docs', 'tooling'] }
  );
});

test('formatAgeDays floors to whole days and never goes negative', () => {
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  assert.strictEqual(formatAgeDays(now / 1000, now), 0);
  assert.strictEqual(formatAgeDays(now / 1000 - 86_400, now), 1);
  assert.strictEqual(formatAgeDays(now / 1000 - 90_000, now), 1);
  assert.strictEqual(formatAgeDays(now / 1000 + 60, now), 0);
  assert.strictEqual(formatAgeDays(undefined, now), 0);
});

test('truncateTitle caps at the limit with an ASCII ellipsis', () => {
  assert.strictEqual(truncateTitle('short', 10), 'short');
  const capped = truncateTitle('x'.repeat(100), 72);
  assert.strictEqual(capped.length, 72);
  assert.ok(capped.endsWith('...'));
});

test('sortTickets orders by rank, then oldest, then id', () => {
  const make = (human_id, timestamp, labels) => ({ human_id, create_time: { timestamp }, labels, status: 'open', title: human_id });
  const sorted = sortTickets([
    make('bbbbbbb', 200, ['prio:normal']),
    make('aaaaaaa', 300, ['prio:normal']),
    make('ccccccc', 100, ['prio:normal']),
    make('ddddddd', 400, []),
    make('eeeeeee', 500, ['sev:major']),
  ]);
  assert.deepStrictEqual(sorted.map((ticket) => ticket.human_id), ['eeeeeee', 'ccccccc', 'bbbbbbb', 'aaaaaaa', 'ddddddd']);
});

test('extractCrossRefs matches only known ticket ids at exact 7-hex boundaries', () => {
  const known = ['abc1234', 'def5678'];
  const refs = extractCrossRefs(
    ['see abc1234 and def5678', 'stale deadbee and long aaaaabc1234', 'self abc1234'],
    known,
    ['def5678']
  );
  assert.deepStrictEqual(refs, ['abc1234']);
});

test('buildBugListArgs always ends with -f json and passes filters in order', () => {
  assert.deepStrictEqual(buildBugListArgs({}), ['bug', 'bug', '-f', 'json']);
  assert.deepStrictEqual(
    buildBugListArgs({ status: 'open', labels: ['area:docs', 'sev:minor'] }),
    ['bug', 'bug', '-s', 'open', '-l', 'area:docs', '-l', 'sev:minor', '-f', 'json']
  );
});

test('formatBriefPlain and briefTicketJson are stable for a synthetic ticket', () => {
  const ticket = {
    id: 'a'.repeat(64),
    human_id: 'aaaaaaa',
    status: 'open',
    title: 'Synthetic ticket',
    labels: ['sev:minor', 'area:docs', 'area:tooling'],
    create_time: { timestamp: 1_700_000_000, time: '2023-11-14T22:13:20Z' },
    edit_time: { timestamp: 1_700_000_100, time: '2023-11-14T22:15:00Z' },
    author: { name: 'Probe' },
    comments: [
      { human_id: '1111111', author: { name: 'Probe' }, message: 'body text' },
      { human_id: '2222222', author: { name: 'Probe' }, message: 'first reply' },
      { human_id: '3333333', author: { name: 'Probe' }, message: 'second reply' },
    ],
  };
  const nowMs = 1_700_000_200_000;

  const all = formatBriefPlain(ticket, { nowMs, refs: ['abc1234'] });
  assert.match(all, /^aaaaaaa open - sev:minor - area:docs,tooling 0d$/m);
  assert.match(all, /^title: Synthetic ticket$/m);
  assert.match(all, /^labels: area:docs, area:tooling, sev:minor$/m);
  assert.match(all, /^refs: abc1234$/m);
  assert.match(all, /^comments: 3$/m);
  assert.equal((all.match(/^\[#/gm) || []).length, 3);

  const tail = formatBriefPlain(ticket, { nowMs, refs: [], tail: 1 });
  assert.match(tail, /^comments: 3 \(showing last 1\)$/m);
  assert.equal((tail.match(/^\[#/gm) || []).length, 1);
  assert.match(tail, /^\[#2 3333333 Probe\]$/m);
  assert.ok(!tail.includes('body text'));

  const none = formatBriefPlain(ticket, { nowMs, refs: [], tail: 0 });
  assert.equal((none.match(/^\[#/gm) || []).length, 0);

  const json = briefTicketJson(ticket, { nowMs, tail: 2, refs: ['abc1234', 'abc1234'] });
  assert.strictEqual(json.schema, 'gitbug.brief.v1');
  assert.deepStrictEqual(Object.keys(json.ticket), [
    'id', 'short', 'status', 'prio', 'sev', 'type', 'area', 'ageDays', 'created', 'edited',
    'author', 'labels', 'refs', 'commentCount', 'comments',
  ]);
  assert.strictEqual(json.ticket.commentCount, 3);
  assert.deepStrictEqual(json.ticket.comments.map((comment) => comment.index), [1, 2]);
  assert.deepStrictEqual(json.ticket.refs, ['abc1234']);
});

test('boardTicketJson uses a stable key order and sorted areas', () => {
  const json = boardTicketJson({
    human_id: 'abc1234',
    status: 'open',
    title: 'T',
    labels: ['area:z', 'area:a', 'prio:high'],
    create_time: { timestamp: 0, time: '1970-01-01T00:00:00Z' },
  }, 86_400_000 * 3);
  assert.deepStrictEqual(Object.keys(json), ['short', 'status', 'prio', 'sev', 'type', 'area', 'ageDays', 'created', 'title']);
  assert.deepStrictEqual(json.area, ['a', 'z']);
  assert.strictEqual(json.ageDays, 3);
});

test('board plain shows open tickets in triage order and omits closed ones', () => {
  const lines = boardLines();
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], new RegExp(`^${ids.alpha} open prio:high sev:major type:defect area:tooling \\d+d Alpha defect ticket$`));
  assert.match(lines[1], new RegExp(`^${ids.beta} open prio:normal - type:task area:docs \\d+d Beta task ticket$`));
  assert.match(lines[2], new RegExp(`^${ids.gamma} open - - - - \\d+d Gamma untagged ticket$`));
  assert.ok(!lines.some((line) => line.includes(ids.closed)), 'closed tickets are excluded by default');
});

test('board filters narrow by status, label, area, prio, sev, and type with AND semantics', () => {
  assert.deepStrictEqual(boardLines(['--status', 'closed']).length, 1);
  assert.match(boardLines(['--status', 'closed'])[0], new RegExp(`^${ids.closed} `));
  assert.deepStrictEqual(boardLines(['--label', 'area:tooling']).map((line) => line.slice(0, 7)), [ids.alpha]);
  assert.deepStrictEqual(boardLines(['--area', 'docs']).map((line) => line.slice(0, 7)), [ids.beta]);
  assert.deepStrictEqual(boardLines(['--area', 'area:docs']).map((line) => line.slice(0, 7)), [ids.beta]);
  assert.deepStrictEqual(boardLines(['--prio', 'normal']).map((line) => line.slice(0, 7)), [ids.beta]);
  assert.deepStrictEqual(boardLines(['--sev', 'major']).map((line) => line.slice(0, 7)), [ids.alpha]);
  assert.deepStrictEqual(boardLines(['--type', 'task']).map((line) => line.slice(0, 7)), [ids.beta]);
  assert.deepStrictEqual(boardLines(['--area', 'tooling', '--sev', 'major']).map((line) => line.slice(0, 7)), [ids.alpha]);
  assert.deepStrictEqual(boardLines(['--area', 'tooling', '--prio', 'normal']), []);
  assert.deepStrictEqual(boardLines(['--limit', '1']).length, 1);
});

test('board --json is a versioned, count-consistent, byte-deterministic schema', () => {
  const first = wrapper(['board', '--json']);
  assert.strictEqual(first.status, 0, first.stderr);
  const parsed = JSON.parse(first.stdout);
  assert.strictEqual(Object.keys(parsed).join(','), 'schema,count,tickets');
  assert.strictEqual(parsed.schema, 'gitbug.board.v1');
  assert.strictEqual(parsed.count, parsed.tickets.length);
  assert.strictEqual(parsed.count, 3);
  for (const ticket of parsed.tickets) {
    assert.deepStrictEqual(Object.keys(ticket), ['short', 'status', 'prio', 'sev', 'type', 'area', 'ageDays', 'created', 'title']);
  }
  assert.deepStrictEqual(parsed.tickets.map((ticket) => ticket.short), [ids.alpha, ids.beta, ids.gamma]);

  const second = wrapper(['board', '--json']);
  assert.strictEqual(first.stdout, second.stdout, 'two board --json runs must be byte-identical');
});

test('next returns the deterministic top of the board, with filters and a none result', () => {
  const next = wrapper(['next']);
  assert.strictEqual(next.status, 0, next.stderr);
  const alpha = boardLines()[0];
  assert.strictEqual(next.stdout, `${alpha}\n`, 'next must equal the first board line (full title)');

  const filtered = wrapper(['next', '--area', 'docs']);
  assert.match(filtered.stdout, new RegExp(`^${ids.beta} `));

  const none = wrapper(['next', '--area', 'no-such-area']);
  assert.strictEqual(none.status, 0);
  assert.strictEqual(none.stdout, 'none\n');

  const json = JSON.parse(wrapper(['next', '--json']).stdout);
  assert.strictEqual(json.schema, 'gitbug.next.v1');
  assert.strictEqual(json.ticket.short, ids.alpha);

  const jsonNone = JSON.parse(wrapper(['next', '--json', '--label', 'qa']).stdout);
  assert.deepStrictEqual(jsonNone, { schema: 'gitbug.next.v1', ticket: null });
});

test('brief renders full metadata, labels, cross-refs, and tail-limited comments', () => {
  const result = wrapper(['brief', ids.alpha]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^${ids.alpha} open prio:high sev:major type:defect area:tooling \\d+d$`, 'm'));
  assert.match(result.stdout, /^title: Alpha defect ticket$/m);
  assert.match(result.stdout, /^author: Probe$/m);
  assert.match(result.stdout, /^labels: area:tooling, prio:high, sev:major, type:defect$/m);
  assert.match(result.stdout, new RegExp(`^refs: ${ids.beta}$`, 'm'), 'live cross-ref only');
  assert.match(result.stdout, /^comments: 1$/m);
  assert.match(result.stdout, /^\[#0 \w{7} Probe\]$/m);

  const zero = wrapper(['brief', ids.alpha, '--tail', '0']);
  assert.match(zero.stdout, /^comments: 1 \(showing last 0\)$/m);
  assert.ok(!zero.stdout.includes('[#0'), 'tail 0 must not render comment blocks');

  const json = JSON.parse(wrapper(['brief', ids.alpha, '--json']).stdout);
  assert.strictEqual(json.schema, 'gitbug.brief.v1');
  assert.strictEqual(json.ticket.short, ids.alpha);
  assert.strictEqual(json.ticket.id.length, 64);
  assert.deepStrictEqual(json.ticket.refs, [ids.beta]);
  assert.strictEqual(json.ticket.commentCount, 1);
  assert.strictEqual(json.ticket.comments[0].index, 0);
});

test('apply adds and removes labels, comments, and changes status in one call', () => {
  const before = run('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], repo).stdout;
  const result = wrapper([
    'apply', ids.beta,
    '--label', 'area:tooling',
    '--label-rm', 'type:task',
    '--comment', 'apply test comment',
    '--status', 'closed',
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(result.stdout, `${ids.beta} applied +area:tooling -type:task comment status:closed\n`);

  const labels = run('git', ['bug', 'bug', 'label', ids.beta], repo).stdout;
  assert.match(labels, /^area:tooling$/m);
  assert.match(labels, /^area:docs$/m);
  assert.doesNotMatch(labels, /^type:task$/m);
  assert.strictEqual(run('git', ['bug', 'bug', 'status', ids.beta], repo).stdout.trim(), 'closed');
  const comments = run('git', ['bug', 'bug', 'comment', ids.beta], repo).stdout;
  assert.match(comments, /apply test comment/);
  assert.strictEqual(run('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], repo).stdout, before, 'no new refs');
});

test('apply skips absent --label-rm labels and reports them in the receipt', () => {
  const result = wrapper(['apply', ids.gamma, '--label-rm', 'sev:critical', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), {
    schema: 'gitbug.apply.v1',
    short: ids.gamma,
    labelsAdded: [],
    labelsRemoved: [],
    labelsSkipped: ['sev:critical'],
    commentAdded: false,
    status: null,
  });
  const plain = wrapper(['apply', ids.gamma, '--label-rm', 'sev:critical']);
  assert.strictEqual(plain.stdout, `${ids.gamma} applied skipped-rm:sev:critical\n`);
  assert.strictEqual(run('git', ['bug', 'bug', 'label', ids.gamma], repo).stdout.trim(), '');
});

test('apply --dry-run prints planned steps and mutates nothing', () => {
  const refsBefore = run('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], repo).stdout;
  const labelsBefore = run('git', ['bug', 'bug', 'label', ids.gamma], repo).stdout;
  const result = wrapper(['--dry-run', 'apply', ids.gamma, '--label', 'sev:minor', '--comment', 'no', '--status', 'closed']);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# label add: git bug bug label new /m);
  assert.match(result.stdout, /^# comment: git bug bug comment new --non-interactive -m no /m);
  assert.match(result.stdout, /^# status close: git bug bug status close /m);
  assert.strictEqual(run('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], repo).stdout, refsBefore);
  assert.strictEqual(run('git', ['bug', 'bug', 'label', ids.gamma], repo).stdout, labelsBefore);
  assert.strictEqual(run('git', ['bug', 'bug', 'status', ids.gamma], repo).stdout.trim(), 'open');
});

test('new verbs reject invalid input with exit 2 and do not mutate', () => {
  const cases = [
    ['board', '--status', 'archived'],
    ['board', '--label', 'bogus:value'],
    ['board', '--area', ''],
    ['board', '--area', 'with space'],
    ['board', '--limit', '0'],
    ['board', 'stray'],
    ['next', '--limit', '1'],
    ['next', '--sev', 'nonsense:extra:colons'],
    ['brief'],
    ['brief', ids.alpha, '--tail', '-1'],
    ['brief', ids.alpha, '--tail', 'abc'],
    ['apply', ids.alpha],
    ['apply', ids.alpha, '--label', 'qa', '--label-rm', 'qa'],
    ['apply', ids.alpha, '--label', 'bogus:value'],
    ['apply', ids.alpha, '--status', 'archived'],
    ['apply', ids.alpha, '--comment', 'x', '--comment-file', 'x'],
  ];
  for (const args of cases) {
    const result = wrapper(args);
    assert.strictEqual(result.status, 2, `${args.join(' ')} should exit 2 (got ${result.status}: ${result.stderr})`);
    assert.match(result.stderr, /^gitbug: /, `${args.join(' ')} must print a one-line gitbug error`);
  }
  assert.deepStrictEqual(
    run('git', ['bug', 'bug', 'label', ids.alpha], repo).stdout.trim().split('\n').sort(),
    ['area:tooling', 'prio:high', 'sev:major', 'type:defect']
  );
  assert.strictEqual(run('git', ['bug', 'bug', 'status', ids.alpha], repo).stdout.trim(), 'open');
});

test('apply fails on an unknown ref without mutating and reports partial-failure steps', () => {
  const refsBefore = run('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], repo).stdout;
  const missing = wrapper(['apply', 'deadbeef', '--label', 'qa']);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /no such ticket: "deadbeef"/);
  assert.strictEqual(run('git', ['for-each-ref', '--format=%(refname)', 'refs/bugs'], repo).stdout, refsBefore);

  const badStatus = wrapper(['apply', ids.alpha, '--status', 'nope']);
  assert.strictEqual(badStatus.status, 2);
});

test('existing verbs keep their output contract in the fixture repo', () => {
  const list = wrapper(['list', '--status', 'open']);
  assert.strictEqual(list.status, 0);
  const raw = run('git', ['bug', 'bug', '-s', 'open', '-f', 'plain'], repo).stdout;
  assert.strictEqual(list.stdout, raw, 'list plain must stay a git-bug passthrough');

  const show = wrapper(['show', ids.beta, '--json']);
  assert.strictEqual(show.status, 0);
  assert.match(JSON.parse(show.stdout).human_id, /^[0-9a-f]{7}$/);

  assert.strictEqual(wrapper(['resolve', ids.beta]).stdout, `${ids.beta}\n`);
  assert.strictEqual(wrapper(['resolve', 'deadbeef']).status, 1);
  assert.match(wrapper(['labels']).stdout, /^sev:major$/m);

  const help = wrapper(['--help']);
  assert.strictEqual(help.status, 0);
  for (const verb of ['board', 'next', 'brief', 'apply']) assert.match(help.stdout, new RegExp(`^\\s+${verb} `, 'm'));
});

test('board and brief run under the advisory lock; apply fails closed on a held lock', () => {
  const lockPath = path.join(repo, '.git', 'gitbug-wrapper.lock');
  const holder = {
    nonce: 'board-test-holder',
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    command: 'test-holder',
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(holder)}\n`);
  try {
    const board = wrapper(['board', '--json', '--lock-timeout', '0']);
    assert.strictEqual(board.status, 1);
    assert.match(board.stderr, /timed out after 0ms/);

    const apply = wrapper(['apply', ids.gamma, '--label', 'qa', '--lock-timeout', '0']);
    assert.strictEqual(apply.status, 1);
    assert.match(apply.stderr, /refusing to run without the lock/);
    assert.strictEqual(run('git', ['bug', 'bug', 'label', ids.gamma], repo).stdout.trim(), '', 'no label may be added without the lock');
  } finally {
    fs.unlinkSync(lockPath);
  }
});
