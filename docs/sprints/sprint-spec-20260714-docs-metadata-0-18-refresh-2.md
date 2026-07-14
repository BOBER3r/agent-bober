# Sync README CLI quick-reference (fleet + 5 commands) and refresh package.json metadata

**Contract:** sprint-spec-20260714-docs-metadata-0-18-refresh-2  ·  **Spec:** spec-20260714-docs-metadata-0-18-refresh  ·  **Completed:** 2026-07-14

## What this sprint added

The README's CLI quick-reference (`README.md:507-633`) had fallen behind the shipped surface: it listed neither the `fleet` command family nor the `config`/`telemetry`/`worktree`/`memory`/`facts` commands, and `package.json`'s `description`/`keywords` predated the 0.18.0 `security-audit`, `fleet`, and knowledge-platform features. This sprint syncs both without touching behavior.

It adds eight one-line entries to the README CLI block (three `fleet` lines plus the five commands Sprint 1 documented), each deferring to `COMMANDS.md` for full detail, and refreshes `package.json`'s `description` and `keywords` to advertise the 0.18.0 surface. Version, name, bin, dependencies, peerDependencies, and scripts are byte-identical. It depends on Sprint 1 so the "full reference in COMMANDS.md" pointers resolve to the sections Sprint 1 added.

## Public surface

Docs + npm metadata only — no code symbols. The changes:

**`README.md` CLI quick-reference (additions only, in the existing `npx agent-bober <cmd>  # note` style):**

- A "Fleet orchestrator" group: `fleet <manifest>` (run a fleet of children from a manifest), `fleet expand <goal>` (decompose a goal into a manifest and optionally run it), and `fleet expand-deep <goal>` (robust two-stage plan-then-expand decomposer).
- A "Config, telemetry & introspection" group: `config [migrate]`, `telemetry <status|purge|export>`, `worktree run <task>`, `memory <distill|list|show|prune>`, `facts <add|list|show|invalidate>` — each ending with "full reference in COMMANDS.md".

**`package.json` (only `description` and `keywords` edited):**

- `description` extended to name the pipeline's Documenter stage, the **fail-closed security-audit gate**, the **fleet orchestrator for bulk multi-agent runs**, and the **cross-domain knowledge platform** (medical, vault, priority hub), and reworded "multi-provider" / "software".
- `keywords` gained `security-audit`, `fleet`, `incident-response`, and `knowledge-platform` (existing keywords kept; 14 → 18).

## How to use / how it fits

The README entries are intentionally one-liners that defer to `COMMANDS.md`, matching the README's established quick-reference pattern ("Full reference in COMMANDS.md", `README.md:548`). No existing README entry was removed or reordered — the diff is pure additions plus the two `package.json` field edits. Each new keyword maps to a shipped, documented surface: `security-audit` (`src/cli/commands/security-audit.ts` + `docs/security-audit.md`), `fleet` (`src/fleet/index.ts` + `docs/fleet.md`), `incident-response` (`src/cli/commands/incident.ts`), and `knowledge-platform` (`docs/knowledge-platform.md`).

## Notes for maintainers

- **`package.json` version stayed `0.18.0`.** Only `description` and `keywords` changed; a nonGoal forbade touching version, name, bin, dependencies, peerDependencies, or scripts. The evaluator verified this with a `node -e` check on the parsed JSON.
- **No git tags were created.** As with Sprint 1, tagging was a nonGoal and `v0.12.0`–`v0.18.0` already exist.
- **README descriptions were spot-checked against source** (`sc-2-5`): the fleet lines mirror the `COMMANDS.md` Fleet Commands wording and the five command lines mirror their `.description()` registrations — no flag is fabricated.

## Scope

One commit — `bdb2e04` (`bober(docs-2): sync README CLI quick-reference (fleet + 5 cmds) + refresh package.json metadata for 0.18.0`). Two files, `README.md` (+12) and `package.json` (+8/−2). Passed on **iteration 1**: all 6 required criteria (sc-2-1..2-6) green; typecheck, build, lint, and the full suite (323 files / **4276 tests** + 1 intentional skip) passed; `git diff --name-only` showed only `README.md` and `package.json`.
