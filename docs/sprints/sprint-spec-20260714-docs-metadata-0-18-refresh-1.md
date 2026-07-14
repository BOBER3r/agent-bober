# Complete the COMMANDS.md CLI reference (config, telemetry, worktree, memory, facts)

**Contract:** sprint-spec-20260714-docs-metadata-0-18-refresh-1  ·  **Spec:** spec-20260714-docs-metadata-0-18-refresh  ·  **Completed:** 2026-07-14

## What this sprint added

`COMMANDS.md` opens by calling itself the "Complete reference for all bober CLI commands" (`COMMANDS.md:2`), but five registered, non-hidden top-level command groups had no section at all. This sprint closes that drift: it documents `config`, `telemetry`, `worktree`, `memory`, and `facts`, and — after iteration 1 caught one remaining gap — adds a standard command-reference heading for `blackboard`. With those in place, **every one of the 35 top-level commands** registered in `src/cli/index.ts` and `src/fleet/index.ts` now has a matching `### ` heading, so an outsider iterating the registered command names finds none without documentation.

This is a docs-only sprint: the only file touched is `COMMANDS.md`, and no CLI registration, flag, or behavior changed. Descriptions were taken verbatim from the `.command()`/`.option()`/`.description()` registrations in each command's source, so no flag or subcommand is invented.

## Public surface

No code symbols were added — this documents commands that already shipped. The new `COMMANDS.md` sections are:

- **`### bober config`** — under a new "## Configuration & Introspection Commands" block. Documents `config migrate` (add all new schema fields with default values to `bober.config.json`) and its `--dry-run` flag.
- **`### bober telemetry`** — `telemetry status` / `telemetry purge` / `telemetry export` (opt-in, local-only telemetry events).
- **`### bober worktree`** — `worktree run <task>` (run the full pipeline in an isolated git worktree on a new branch) with `--allow-dirty` and `--keep-on-success`.
- **`### bober memory`** — `memory distill` / `memory list` (with `--limit`) / `memory show <lessonId>` / `memory prune` (the self-improvement lessons index).
- **`### bober facts`** — `facts add` / `facts list` / `facts show <id>` / `facts invalidate <id>` (the semantic bi-temporal FactStore), documenting the real `--subject`/`--predicate`/`--value`/`--scope`/`--confidence`/`--run-id` options.
- **`### bober blackboard`** (added in iteration 2) — `blackboard publish <value>` (with `--round`) / `blackboard read` (with `--all`) for the shared inter-agent fleet blackboard (Phase B). It sits alongside the existing conceptual "Inter-child blackboard (Phase B)" section and cross-links to it, so the reference now has both a standard command heading and the narrative explanation.

## How to use / how it fits

The five new sections follow the format of the neighboring reference entries: a `### bober <cmd>` heading, a one-sentence purpose line, and a fenced usage block listing each subcommand with its real flags. They were grouped into a new "## Configuration & Introspection Commands" block placed after the Graph & Utility commands, without disturbing any existing section.

The completeness guarantee is the load-bearing part: `sc-1-2` requires that iterating the `register*Command` calls in `src/cli/index.ts` plus `fleet` in `src/fleet/index.ts` yields zero commands without a `### ` heading. That is what caught `blackboard` in iteration 1 — it had only a level-4 `#### agent-bober blackboard publish/read` narrative, not a proper command heading.

## Notes for maintainers

- **The completeness invariant is manual, not test-enforced.** Nothing in the suite fails if a future command is registered without a `COMMANDS.md` heading. When adding a top-level command, add its `### bober <cmd>` section here too, or this reference silently drifts again.
- **Iteration 1 correctly failed.** The evaluator rejected iteration 1 because `blackboard` lacked a standard heading — the five named sections were already accurate. The fix (commit `6296eee`) was explicitly authorized by the orchestrator to resolve the tension between `sc-1-2` (every command documented) and nonGoal #4 (don't add sections beyond the named five); it is within the sprint's "complete the reference" intent and the contract's `evaluatorNotes` named `blackboard`.
- **No git tags were created.** A nonGoal explicitly forbade tagging; `v0.12.0`–`v0.18.0` already exist in the repo.

## Scope

Two commits, both `COMMANDS.md`-only:

- `0ae6da6` (`bober(docs-1): complete COMMANDS.md CLI reference (config/telemetry/worktree/memory/facts)`) — +76 lines, the five new sections.
- `6296eee` (`bober(docs-1): add bober blackboard command heading (sc-1-2 completeness)`) — +21 lines, the `### bober blackboard` heading (iteration 2).

Passed on **iteration 2** (iteration 1 failed on the `blackboard` completeness gap). All 5 required criteria (sc-1-1..1-5) green; typecheck, build, lint, and the full suite (323 files / **4276 tests** + 1 intentional skip) passed; `git diff --name-only` showed only `COMMANDS.md`.
