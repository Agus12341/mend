# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Agus12341/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Agus12341/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend applies an edit written by an AI model to a tree of text files. Models write edits in four formats, and this tool reads all of them: unified diffs (with the wrong line numbers models often produce), SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. It applies the whole patch at once or nothing at all: if any edit fails, no file is written.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

PATCH is the patch file; without it, or with `-`, the patch is read from standard input. `--format` picks one format (`unified`, `search-replace`, `v4a`, `json`) or `auto` to detect it. `--check` reports what would change without writing anything. `--strict` matches lines exactly, with no whitespace tolerance.

When the patch applies cleanly, mend prints one line per changed file (`A`, `D`, `M`, or `R old -> new` for a move) and a final `ok: N files` line. When an edit fails it prints one `error: <code> <path>` line per failed edit and `failed: K of N edits`, and leaves every file untouched.

## How it matches

Line edits are found by content, not by the line numbers in the patch. A block of old lines is matched exactly first, then with trailing whitespace ignored, then with leading and trailing whitespace ignored (and re-indented to fit the file). A unified hunk with several copies of its old lines takes the copy nearest the line number the patch claims. SEARCH/REPLACE blocks need exactly one copy. V4A chunks walk the file with a cursor and an anchor line.

## Files

- `main.ts` — the CLI, Node 22 standard library only.
- `SPEC.md` — the full specification this implements.
- `check.ts` — runs the kit's practice checks against `main.ts`.
- `runner.ts` — runs one check the way a trial does.

Built for the [mend bounty on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).
