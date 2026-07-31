# Sync skill/agent surfaces and docs with the mode-aware documenter

**Contract:** sprint-spec-20260731-documenter-docs-output-2  ·  **Spec:** spec-20260731-documenter-docs-output  ·  **Completed:** 2026-07-31

## What this sprint added

Sprint 1 made the documenter's output location and git behavior configurable in **TypeScript**
(`documenter.docsMode` / `documenter.docsDir`, `resolveSprintDocPath`, `buildDocumenterUserMessage`),
but the **skill-engine** path — the `bober.sprint` / `bober.run` skills driving a Claude Code
orchestrator, plus the `bober-documenter` agent spec — still hardcoded `docs/sprints/<contractId>.md`
and an unconditional commit. This sprint closes that gap: the two skills now **read
`documenter.docsMode` and `documenter.docsDir` from `bober.config.json`**, resolve the concrete
record path themselves, and interpolate it (plus the commit policy) into the documenter prompt;
`agents/bober-documenter.md` gates Step 3 (related-doc hunting) and Step 4 (commit) on the mode it
was given. The three `.claude/` copies were regenerated, and the user-facing config reference
(README + VISION) plus CHANGELOG now document the two keys with solo-vs-team recipes.

Markdown only — `src/` was untouched (contract nonGoal). Behavior for a config that omits both keys
is unchanged: mode `committed`, repo-relative `docs/sprints/<contractId>.md`, committed.

## Public surface

Prompt/instruction surfaces, not code symbols — this sprint's "API" is what the orchestrator and
documenter are told to do:

- **`skills/bober.sprint/SKILL.md:382-388`** — new "Resolve the docs mode and record path first"
  block in the documenter-spawn step: reads `documenter.docsMode` (default `committed`) and
  `documenter.docsDir` (optional) and spells out all three modes' record path + commit semantics,
  then instructs the orchestrator to compute the concrete path before writing the prompt.
- **`skills/bober.sprint/SKILL.md:400`, `:415`** — the single hardcoded documenter prompt is now
  **two** prompts: `committed` mode (write record to `<resolved record path>`, update stale docs,
  commit only doc files) and `local`/`external` mode (write the record only; no other repo file, no
  staging, no commit; stale docs go to `concerns`).
- **`skills/bober.run/SKILL.md:562`** — same mode resolution folded into step 4 of the autonomous
  run loop, including the `external` default `~/.bober/docs/<project.name>/sprints/<contractId>.md`
  and the `docsDir` override rule. The advisory-failure semantics right below it are untouched: a
  documenter crash still logs `sprint-docs-failed` and never fails the already-passed sprint.
- **`agents/bober-documenter.md:53`** — new paragraph: the orchestrator's prompt supplies the
  resolved **record path** and **docs mode**; if it does not, assume `committed` +
  `docs/sprints/<contractId>.md`.
- **`agents/bober-documenter.md:66`** — Step 2 writes to "the record path the orchestrator gave you"
  instead of the hardcoded literal (the literal survives only as the stated default).
- **`agents/bober-documenter.md:89`** — Step 3 retitled "**`committed` mode only**": in
  `local`/`external` the agent must not search for or edit any other repo file, and routes
  stale-doc findings into `concerns`.
- **`agents/bober-documenter.md:107`** — Step 4 retitled "**mode-gated**", with an explicit
  per-mode block. `local` additionally forbids editing `.gitignore` (that entry is deterministic TS
  from sprint 1, never the LLM's job).
- **`agents/bober-documenter.md:131`, `:146`** — the response contract is now two templates:
  `committed` keeps `docsCommit` + `relatedDocsUpdated`; `local`/`external` **omit `docsCommit`
  entirely** and leave `relatedDocsUpdated` empty.
- **`.claude/agents/bober-documenter.md`, `.claude/commands/bober-sprint.md`,
  `.claude/commands/bober-run.md`** — regenerated copies (not hand-edited), byte-identical to their
  canonical sources.
- **`README.md`** config block + Documenter agent bullet, **`VISION.md`** new `documenter` section
  table — `docsMode` / `docsDir` with defaults, since-version, and both carry-forward caveats.
- **`CHANGELOG.md`** — `[Unreleased] → Added` entry for the feature.

## How to use / how it fits

The config reference now ships the three recipes verbatim (README config block):

```jsonc
"documenter": { "docsMode": "committed" }                               // solo repo (default): committed with the code
"documenter": { "docsMode": "local", "docsDir": ".bober-docs/sprints" } // team: on disk, gitignored, never committed
"documenter": { "docsMode": "external" }                               // team: outside the repo entirely, no git op
```

Two paths now honor those keys and must stay in agreement:

1. **TS pipeline** — `runDocumenter` resolves the path and builds the per-mode prompt
   (`src/orchestrator/documenter-agent.ts`, sprint 1).
2. **Skill engine** — a Claude Code orchestrator running `bober.sprint` / `bober.run` reads the same
   two keys from `bober.config.json`, resolves the path with the same rules, and picks the matching
   prompt variant. `agents/bober-documenter.md` is the shared contract both paths hand to the
   documenter subagent.

If you change the mode semantics in one place, change the other — and regenerate the `.claude`
copies with the repo's update-all script (`node scripts/update-all.mjs`, drift check
`node scripts/update-all.mjs --check .`). Never hand-edit files under `.claude/`.

## Notes for maintainers

- **Carry-forward caveats are now documented prose, not just tribal knowledge.** Both the README
  config block and the VISION `documenter` table state that (a) a `local` `docsDir` pointing outside
  the project root cannot be gitignored — that use case belongs to `external`, not `local`; and
  (b) explicitly setting `docsDir` yields an absolute, machine-specific path that lands in the
  git-tracked `.bober/history.jsonl`, an opt-in trade-off.
- **The `local`/`external` prompt wording deliberately avoids the literal substrings `git add` /
  `git commit`** so sprint 1's tests can assert their total absence. The md surfaces follow the same
  discipline; keep it if you reword those steps.
- **Drift check is scoped.** `node scripts/update-all.mjs --check .` reports **14 pre-existing
  out-of-scope drifted files** (`bober-plan.md`, `bober-seo*`). That drift predates this sprint, was
  explicitly excluded by `sc-2-3`, and was left untouched. Only the three copies owned here were
  regenerated. `npm run update-all:check` passes trivially on a machine where the configured
  sync-target project paths are absent — use the explicit `--check .` form to actually verify.
- **`src/orchestrator/documenter-agent.ts:216-220` JSDoc still narrates the unconditional commit
  flow.** Flagged by the generator, not fixed: `src/` was frozen for this sprint. Worth a one-line
  doc-comment correction in a later sprint.
- **Sprint 3 is still pending:** the `bober init` solo-vs-team question. Until it lands, choosing a
  non-default `docsMode` is a manual `bober.config.json` edit.

## Scope

One commit, `3938793` (parent `9dac508`): exactly the 9 files in the contract's `estimatedFiles`,
+141/−28, **zero `src/` changes and zero tests added** (docs-only sprint). Passed **iteration 1**,
5/5 required criteria. Typecheck/build clean, eslint 0 errors (2 pre-existing warnings), suite
**4990 passed | 1 pre-existing skip**, zero sprint-owned copy drift.
