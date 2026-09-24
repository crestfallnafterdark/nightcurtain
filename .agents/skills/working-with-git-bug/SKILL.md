---
name: working-with-git-bug
description: >-
  Operate this repository's local git-bug issue tracker without guessing its command grammar.
  Use whenever reading, searching, filing, labelling, commenting on, closing, or syncing
  git-bug tickets (running `git bug`, `git bug bug`, `git bug bug show|new|comment|label|status`,
  or `git bug push`/`pull`), or when a `git bug` command fails with "unknown command".
  Prevents the top-level-subcommand confusion (`git bug ls|show|new` do not exist — every bug
  operation nests under `git bug bug`), the silent fallback of unresolvable ids to the selected
  bug (which can silently MUTATE an unrelated ticket), interactive `$EDITOR` hangs from missing
  `--non-interactive`, and the `-F`-overrides-`-t` title trap.
---

# Working with git-bug

git-bug is this repo's issue tracker of record: tickets are git objects on
`refs/bugs/<64-hex>`, not files, so normal `git status` stays clean. Grammar is
version-sensitive — **verify the installed binary before trusting any example here**:

```bash
git bug version     # verified on: dev-f2070b5325 (≈ upstream v0.10.1)
git bug commands    # authoritative command tree for the installed build
```

Older upstream docs/READMEs use `git bug ls` / `git bug add`; those do not exist in this build.

## Prefer the wrapper

`scripts/gitbug.mjs` wraps the footguns: no `$EDITOR`, label validation, boolean
id resolution (never the selection fallback), JSON/`--dry-run` output.

```bash
node scripts/gitbug.mjs list -s open --json
node scripts/gitbug.mjs resolve 20a885f          # exit 1 if not a real ticket
node scripts/gitbug.mjs show 20a885f --json
node scripts/gitbug.mjs new --title "…" --body "…" --label area:tooling --label sev:minor
node scripts/gitbug.mjs comment 20a885f --body "…"
node scripts/gitbug.mjs close 20a885f
node scripts/gitbug.mjs --dry-run new --title "…" --body "…"   # prints the git argv only
```

Use raw `git bug` only for verbs the wrapper lacks (`title`, `comment edit`, `user`,
`bridge`, `push`/`pull`).

## Rule 1 — everything nests under `git bug bug`

There is no top-level `git bug ls|show|new|add|edit|comment|status|select|title|rm`; they
all fail with `unknown command`. `git bug bug` with no further word is the **list** command.
`git bug --help` prints a stale 2019 man page — use `git bug -h`, `git bug help`, or
`git bug bug <cmd> --help`.

## Rule 2 — never trust an id; resolve it first

An **unresolvable id does not error**: git-bug silently falls back to the *selected* bug
(`.git/git-bug/select/bugs`) and still exits 0 — for **reads and writes**:

- `git bug bug show deadbeef` → prints the selected bug, exit 0.
- `git bug bug label new deadbeef foo` → **adds the label to the selected bug**, exit 0.
- `git bug bug comment new deadbeef -m hi` → **comments on the selected bug**, exit 0.

So never use `git bug bug show <ref>` exit status as an existence test, and never write to
an unverified id. Resolve against refs (selection-independent):

```bash
git for-each-ref --format='%(refname)' refs/bugs | grep "refs/bugs/$ref"
```

Note: `git rev-parse --verify refs/bugs/<7-hex>` **fails** — only the full 64-hex id
resolves that way (short refs are not expanded outside standard namespaces). Prefer
`node scripts/gitbug.mjs resolve <ref>`.

## Rule 3 — non-interactive, and never `-F` with `-t`

Without `--non-interactive` plus `-m`/`-F`, `new`, `comment new|edit`, and `title edit` open
`$EDITOR` (here `nvim`) and hang an agent.

**`-F` overrides `-t`**: `git bug bug new --non-interactive -t "REAL TITLE" -F -` takes its
title from the **body's first line** and ignores `-t` (verified — this is how ticket
`20a885f`'s title got mangled). Put the body in `-m`, or use the wrapper.

## Command reference (verified on dev-f2070b5325)

```bash
# List / search. Qualifiers: status:, label:, title:, author:, participant:, actor:,
# no:label, sort:id|creation|edit[-asc|-desc]; -f: default|plain|id|json|org-mode
git bug bug
git bug bug -s open -l area:tooling -f json
git bug bug "some full text"

# Read one
git bug bug show <short-id>
git bug bug show --field labels <short-id>   # --field takes ONE value (combined values error)
git bug bug show -f json <short-id>
git bug bug comment <short-id>               # list comments (description is #0)
git bug bug label <short-id>                 # labels of THIS ticket
git bug bug status <short-id>
git bug bug title <short-id>

# Write (non-interactive)
git bug bug new --non-interactive -t "<title>" -m "<body>"
git bug bug comment new --non-interactive -m "<body>" <id>
git bug bug comment edit --non-interactive -m "<body>" <comment-id>
git bug bug title edit --non-interactive -t "<new title>" <id>
git bug bug label new <id> <label> <label>   # ONE ARG PER LABEL
git bug bug label rm <id> <label>
git bug bug status close <id> | git bug bug status open <id>
git bug bug rm <id>                          # local removal only

# Global / identity
git bug label                                # all labels KNOWN TO THE INDEX (see below)
git bug user | git bug user user [USER_ID]
```

## Labels and lifecycle

- **Scheme:** `type:defect|feature|task|chore|decision` · `sev:cosmetic|low|minor|major|critical` ·
  `area:<module|surface>` · `prog:<program>` · `prio:low|normal|high`. Legacy labels still in
  use: `qa`, `mod-21`, `security`, `audit-fail`. The wrapper validates against these.
- **File:** concise title; body = Summary / Repro or Evidence (commands + `file:line`) /
  Acceptance / References. One `--label` per label.
- **Update:** every update is a **comment**, carrying references — commit SHA, `file:line`,
  durable doc paths, command output. Never edit history; append.
- **Close:** `status close <id>` after a closing comment that cites the fix commit/repro.
- Session todos stay ephemeral; durable issues belong here, not in a TODO file.

## Cloud ingestion (bridges)

This build ships bridges: **github, gitlab, jira, launchpad-preview**
(`git bug bridge new --help`). Pull-first; push only on explicit request.

```bash
git bug bridge new --non-interactive --name=github --target=github \
    --owner=<owner> --project=<repo> --token=$GH_TOKEN   # PAT: public_repo / repo
git bug bridge pull github                               # import issues + comments (read-only on the remote)
# git bug bridge push github                             # comment/status round-trip — explicit request only
```

Jira/similar: `--target=jira --base-url=<url> --login=<email> --token=<token> --project=<KEY>`.
UNVERIFIED live here (no remote/token); `git bug bridge` lists configured bridges.
Fallback without the bridge: `gh issue list --json … | node scripts/gitbug.mjs new …`.

## Pitfalls

1. **No top-level shorthands.** `git bug bug <unknownword>` is silently treated as a board query.
2. **Id fallback to the selected bug** (Rule 2) — reads *and* writes; verify refs first.
3. **Missing `--non-interactive`/`-m` hangs on `$EDITOR`.**
4. **`-F` overrides `-t`** (Rule 3).
5. **A ticket's labels ≠ all labels:** `git bug bug label <id>` vs `git bug label`. A quoted
   multi-label (`label new <id> "a b"`) creates one space-containing label — pass one arg each.
6. **Status vs label:** `open`/`closed` is status; `qa`/`sev:*`/`area:*` are labels.
7. **No "edit description" command:** the description is comment `#0`; edit via
   `comment edit <comment-id>` (UNVERIFIED whether git-bug accepts edits to `#0`).
8. **Ids:** 7-char `shortId` is the durable ref; full 64-hex lives in `refs/bugs/`.
9. **`git bug user user <id>`** is the working form; the usage string's `... user show` errors.
10. **`push`/`pull`** move `refs/bugs/*` to/from a remote — off-limits without explicit approval.
11. **Locks:** the wrapper serializes its own invocations with an advisory lock (`<git-common-dir>/gitbug-wrapper.lock`; `--lock-timeout`/`GITBUG_LOCK_TIMEOUT`, default 120 s; stale locks are reclaimed automatically) — concurrent wrapper calls queue instead of failing, and the old one-command-at-a-time/retry workaround is retired. Raw `git bug` calls made outside the wrapper are not serialized; prefer the wrapper.

## Derived data (index/cache)

`git bug label` (and other queries) read derived caches under `.git/git-bug/indexes/` and
`.git/git-bug/cache/`. They are **not** the source of truth and can go stale — e.g. labels
added by an id-fallback write survive a ref reset in the index, so the global label list can
show labels no ticket carries. Safe purge (derived data; rebuilt on next command):

```bash
mv .git/git-bug/indexes /tmp/gitbug-indexes.bak && mv .git/git-bug/cache /tmp/gitbug-cache.bak
git bug bug -f id >/dev/null      # rebuilds
```

## Quick verification

```bash
node scripts/gitbug.mjs list -s open --json     # board
git for-each-ref refs/bugs | wc -l              # ticket refs
node scripts/gitbug.mjs resolve <ref>           # 0 = real ticket, 1 = not
```
