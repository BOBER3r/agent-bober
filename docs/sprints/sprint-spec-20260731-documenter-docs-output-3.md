# Init flow: solo vs team docs question

**Contract:** sprint-spec-20260731-documenter-docs-output-3  ·  **Spec:** spec-20260731-documenter-docs-output  ·  **Completed:** 2026-07-31

## What this sprint added

Sprints 1 and 2 made the documenter's output location configurable (`documenter.docsMode` /
`documenter.docsDir`) across both the TS pipeline and the skill engine — but choosing a non-default
mode still meant hand-editing `bober.config.json` after init. This sprint closes the loop: **`bober
init` now asks one question** — commit per-sprint docs into the repo (solo, the default) or keep the
repo clean (team) — and writes the answer as `documenter.docsMode` (`"committed"` or `"local"`) into
the generated config. Non-interactive runs (no TTY, e.g. CI or a piped stdin) **never prompt** and
resolve to `committed`.

The question is asked by one exported helper, `askDocsMode`, wired into all three interactive init
flows immediately after the model-preferences questions. `external` is deliberately **not** an init
option — it stays a hand-edited config choice, keeping the prompt binary (contract nonGoal).

## Public surface

- **`askDocsMode(isTTY?: boolean): Promise<DocumenterDocsMode>`** (`src/cli/commands/init.ts:191`) —
  exported `prompts` select in the style of the neighbouring `askProvider`. Message: *"Where should
  per-sprint docs go?"*; choices *"Commit them into the repo (solo)"* → `"committed"` (initial) and
  *"Keep the repo clean (team)"* → `"local"`. Defaults `isTTY` to `process.stdin.isTTY ?? false` and
  **returns `"committed"` without prompting when false**. Anything other than an explicit `"local"`
  answer collapses to `"committed"`, which covers SIGINT (`undefined`) and a drained
  `prompts.inject()` queue (returns the numeric `initial` index, not a value).
- **`brownfieldFlow` (`:657`), `brownfieldManualFlow` (`:760`), `greenfieldFlow` (`:893`)** — each
  calls `askDocsMode()` right after `askModelPreferences` and passes
  `{ ...config, documenter: { docsMode } }` to `writeConfig` (`:690`, `:806`, `:947`).
- **`ConfigShape.documenter?: { docsMode: DocumenterDocsMode }`** (`:1170`) — the internal
  config-writing shape gains one optional field.
- **init summary line** (`:1227-1229`) — `Docs:  <mode>` is printed alongside `Strategies:` when the
  section is present.

No schema change: `DocumenterDocsModeSchema` and `documenter.docsMode` (default `"committed"`)
already shipped in sprint 1 (`src/config/schema.ts:304`, `:331`).

## How to use / how it fits

```
$ npx agent-bober init

? Where should per-sprint docs go? › - Use arrow-keys. Return to submit.
❯   Commit them into the repo (solo)   docs/sprints/<sprint>.md, committed with the code
    Keep the repo clean (team)         Written on disk and gitignored — never committed
```

The solo answer writes `"documenter": { "docsMode": "committed" }`; the team answer writes
`"local"`, which makes the documenter write the record on disk, gitignore its directory (via
sprint 1's deterministic `ensureGitignoreEntry`) and never commit or touch any other repo file.
`external` (records outside the repo entirely) remains available by editing `bober.config.json` —
see the recipes in the README config block.

Only `{ docsMode }` is emitted — never a fully-materialized `DocumenterSection`. That is
load-bearing: the documenter agent's model resolution is
`config.documenter?.model ?? config.generator.model`, so writing a parsed full section would
silently pin `model: "sonnet"` and override the user's generator model choice.

Non-interactive init paths are unchanged: the MCP `bober_init` tool (`src/mcp/tools/init.ts`) is
structurally prompt-free and omits the `documenter` section entirely, which `resolveSprintDocPath`
resolves to `committed` / `docs/sprints/<contractId>.md`.

## Notes for maintainers

- **`src/cli/commands/init.test.ts:59-68` is a tautological test** (flagged by the evaluator,
  low priority, non-blocking). The test *"does not materialize a full documenter section"* asserts
  `Object.keys(...)` on a **local literal declared inside the test body** — it exercises no real code
  path and would keep passing if `init.ts` started writing a full documenter section. To make it real,
  extract the `{ ...config, documenter: { docsMode } }` assembly into a `buildConfigToWrite` helper
  and assert against that; otherwise delete the test. Left as-is here (documenter must not touch
  tests).
- **`src/discovery/config-generator.ts` and its test were deliberately left untouched**, overriding
  the contract's advisory `estimatedFiles`. That module generates config from codebase *scanning* and
  has no documenter awareness — `docsMode` is a human preference, not something scan-derivable. The
  golden-snapshot tests in `src/config/schema.test.ts` (135 tests, both snapshots) pass unchanged.
- **The non-TTY guard is the only non-interactive protection.** Any future init entry point that
  bypasses `askDocsMode` (or force-passes `isTTY: true`) will prompt in CI. Keep the guard inside the
  helper rather than at the call sites.
- **`external` is intentionally absent from the prompt.** If it is ever added, keep the prompt to a
  single question — the contract's nonGoal was one question, one key.
- The user-facing config reference (README `documenter` block + recipes, VISION `documenter` table)
  and the `CHANGELOG` `[Unreleased]` entry were written in sprint 2 and already describe all three
  modes; they needed no change here. Worth folding a one-line "…and `bober init` asks for it" mention
  into the CHANGELOG entry at release time.

## Scope

One commit, `7d97de4` (parent `4031a9c`): 2 files, +141/−4 — `src/cli/commands/init.ts` modified and
`src/cli/commands/init.test.ts` created (7 tests). Passed **iteration 1**, 3/3 required criteria.
Typecheck/build clean, eslint 0 errors (2 pre-existing warnings), suite **4997 passed | 1 pre-existing
skip** (+7).

**Final sprint — the configurable documenter docs output spec is 3 of 3 complete.**
