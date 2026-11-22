# mend-cli-20261122-entry

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sinker234/mend-cli-20261122-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/sinker234/mend-cli-20261122-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies AI-written edits in four formats — unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to a tree of files, changing every file or none.

## Run it

```sh
node main.ts patch.diff
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=1c94brae&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

## What it does

`node main.ts [--format=NAME] [--check] [--strict] [PATCH]` reads a patch from a
file (or standard input when PATCH is absent or `-`) and applies it to the
working directory, which is the root of the tree.

- Four formats, auto-detected by default (`--format=auto`): `unified`,
  `search-replace`, `v4a`, `json`. A format can also be forced with
  `--format=NAME`.
- Line matching at three tiers: exact, ignoring trailing whitespace, then
  ignoring leading and trailing whitespace (and re-indenting added lines).
  `--strict` matches exactly only.
- Unified diffs with wrong line numbers are applied at the occurrence nearest
  the hunk's line number; creations, deletions and renames are supported.
- SEARCH/REPLACE blocks fail as `ambiguous` when the old text occurs more than
  once; V4A chunks are applied in order with an anchor and a cursor.
- `--check` reports what would change without writing anything.
- Atomicity: a failed edit changes nothing, later edits still run and every
  failure is reported; when any edit fails, no file is written.
- Exit codes: `0` with `A`/`D`/`M`/`R` lines and `ok: N files`, `1` with one
  `error: <code> <path>` line per failed edit, `2` for usage, unreadable patch,
  undetected format or parse errors.

## Checks

`main.ts` is Node 22, standard library only, with `runner.ts` beside it (the
kit's trial runner, kept as it is). The kit's practice set passes in full:

```sh
node check.ts ../program/generator/practice.json   # 100 of 100 passed
```

See `SPEC.md` in the competition kit for the full specification.
