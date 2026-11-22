[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Agus12341/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Agus12341/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend - one patch tool for every AI edit format

An entry for make.fun's [Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) bounty.

`main.ts` is mend, a CLI that applies an edit an AI model wrote to a tree of text files. Models write edits in four
formats, and mend reads all of them, exactly as `SPEC.md` in this repository says:

- unified diffs, including hunks whose line numbers are wrong (the hunk is placed at the occurrence nearest the
  stated line);
- SEARCH/REPLACE blocks;
- V4A patches (`*** Begin Patch` ... `*** End Patch`), with anchored chunks and a cursor;
- text-editor tool calls as JSON, one array or one object a line.

Old lines are matched at three tiers: exact, then ignoring trailing spaces and tabs, then ignoring leading ones
too, with the replacement re-indented to the file at the loosest tier. `--strict` keeps only the exact tier.
A patch applies whole or not at all: every edit is tried and every failure reported, and when any edit fails no
file is written. `--check` reports what would change and writes nothing.

Run it as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`; with no PATCH (or `-`) the patch is read
from standard input. Node 22, standard library alone.

## Layout

- `main.ts` - the CLI
- `runner.ts` - the trial runner the grader uses (kept as the kit has it)
- `check.ts` - runs the public practice set against `main.ts`
- `SPEC.md` - the specification mend implements
- `LICENSE` - MIT

## License

MIT - see `LICENSE`.
