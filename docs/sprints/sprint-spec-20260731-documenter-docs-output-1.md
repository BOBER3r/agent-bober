# docsMode / docsDir — configurable documenter output location + mode-aware prompt

**Contract:** sprint-spec-20260731-documenter-docs-output-1  ·  **Spec:** spec-20260731-documenter-docs-output  ·  **Completed:** 2026-07-31

## What this sprint added

The per-sprint documenter previously hardcoded **one** output policy: write
`docs/sprints/<contractId>.md` inside the repo and have the LLM `git add` + `git commit` it. That
is right for a solo repo and wrong for a shared one, where per-sprint records are noise in
everyone else's diff. This sprint makes the documenter's **output location and git behavior
configurable** via two new keys — `documenter.docsMode` (`committed` | `local` | `external`,
default `committed`) and `documenter.docsDir` — and splits the previously-inline prompt into an
exported, unit-testable builder that emits **different instructions per mode**: `committed` keeps
today's commit flow verbatim, while `local` and `external` emit no version-control instruction at
all, forbid touching any repo file other than the sprint record, and redirect stale-doc
observations into `concerns` instead of edits. In `local` mode the `.gitignore` entry covering the
docs directory is created by **deterministic TypeScript** (`ensureGitignoreEntry`), never by the
LLM. This is the runtime half of the spec; the skill/agent prompt surfaces and the user-facing
config reference land in sprints 2–3.

**Default behavior is unchanged, deliberately.** A config that omits both keys resolves to
`docsMode: "committed"`, the repo-relative literal `docs/sprints/<contractId>.md`, and a rendered
prompt verified **byte-identical** to the pre-sprint version (`66ea273`).

## Public surface

- `DocumenterDocsModeSchema` / `type DocumenterDocsMode` (`src/config/schema.ts:304-305`) — the
  `z.enum(["committed", "local", "external"])` union, named so `documenter-agent.ts` imports the
  type instead of re-declaring it.
- `documenter.docsMode` (`src/config/schema.ts:331`) — `DocumenterDocsModeSchema.default("committed")`.
  An invalid value fails zod parsing with an error naming the key.
- `documenter.docsDir` (`src/config/schema.ts:341`) — optional string override. Honored in **all**
  three modes and takes priority over every mode default.
- `resolveSprintDocPath(config, projectRoot, contractId)` (`src/orchestrator/documenter-agent.ts:74`)
  — pure resolver, exported for testing. Branches:
  - `committed`, no `docsDir` → the **repo-relative literal** `docs/sprints/<id>.md`.
  - `local`, no `docsDir` → `docs/sprints/<id>.md` resolved **absolute** under `projectRoot`.
  - `external`, no `docsDir` → `~/.bober/docs/<project.name>/sprints/<id>.md`, with
    `project.name` falling back to `basename(projectRoot)`.
  - any mode with `docsDir` → absolute; relative resolves against `projectRoot`, absolute and
    `~`-prefixed are honored as-is (`~` expanded inline via `os.homedir()` — `node:path` does not
    expand it and no tilde helper existed in `src/`).
- `buildDocumenterUserMessage(options)` + `interface DocumenterUserMessageOptions`
  (`src/orchestrator/documenter-agent.ts:122`, `:103`) — extracted from the `runDocumenter` body so
  the per-mode prompt is assertable without an LLM. Shares one `header` across modes; a `switch`
  on `docsMode` picks the task block, with a `never` exhaustiveness guard on the default arm.
- `ensureGitignoreEntry(projectRoot, entry)` (`src/utils/git.ts:163`) → `Promise<boolean>` —
  idempotent, fs-based (no `execa`). Appends `<entry>/` only when no existing trimmed line already
  matches `entry`, `entry/`, `/entry`, or `/entry/`; creates `.gitignore` when absent; never
  rewrites or reorders unrelated lines; returns whether it appended.

## How to use / how it fits

```jsonc
// bober.config.json — solo repo (default, may be omitted entirely)
"documenter": { "docsMode": "committed" }

// shared repo: records stay on your machine, inside the worktree but gitignored
"documenter": { "docsMode": "local", "docsDir": ".bober-docs/sprints" }

// shared repo: records live outside the repo entirely (default ~/.bober/docs/<project>/sprints)
"documenter": { "docsMode": "external" }
```

Inside `runDocumenter` (`src/orchestrator/documenter-agent.ts:281-306`) the order is: read
`config.documenter?.docsMode ?? "committed"` → `resolveSprintDocPath(...)` → **if `local`**, derive
the entry as `relative(projectRoot, dirname(sprintDocPath))` and `await ensureGitignoreEntry(...)`
inside a `try/catch` that only `logger.warn`s → `buildDocumenterUserMessage(...)`. The gitignore
step is intentionally *before* the agent call so the directory is already ignored when the record
is written. `parseDocumentationResult` already took the default path as a parameter, so it picks up
the mode-resolved value with no signature change.

The `pipeline.ts` call site is untouched: the documenter stays **advisory** — its failure or
timeout still never downgrades an already-passed sprint.

## Notes for maintainers

- **The `committed` default must stay a relative literal.** Iteration 1 returned an absolute path
  for every branch and was rejected: `sprintDocPath` is interpolated into the prompt *and*
  persisted into the git-tracked `.bober/history.jsonl` (`pipeline.ts:627`), so an absolute path
  leaks a machine-specific home directory into a committed artifact. Iteration 2 restored the
  literal. `local`'s default is absolute on purpose — it is new behavior with no compatibility
  constraint, and the absolute form is what the `.gitignore` computation needs.
- **`docsDir` wins in `committed` mode too**, and returns an *absolute* path — so setting
  `docsDir` in `committed` mode does reintroduce an absolute path into `history.jsonl`. Acceptable
  because it is opt-in, but worth knowing before treating `history.jsonl` paths as portable.
- **`local` + an absolute `docsDir` outside the project root** yields a `../…` gitignore entry,
  which git cannot act on. Not guarded and not tested; `external` is the intended mode for
  out-of-repo output.
- **Never let the LLM edit `.gitignore`.** That mutation is deterministic TS by contract
  (`nonGoals[3]`); the `local`/`external` prompts explicitly forbid the agent from touching it.
- **The `local`/`external` prohibition is worded to avoid the literal substrings `git add` /
  `git commit`** so a test can assert their total absence. Keep that property if you reword step 3
  or 4 of those prompts.
- **Prompt surfaces still hardcode the old policy.** `agents/bober-documenter.md`,
  `.claude/agents/bober-documenter.md`, `skills/bober.sprint/SKILL.md` and `skills/bober.run/SKILL.md`
  still say `docs/sprints/<contractId>.md` and commit unconditionally, so the **skill-engine** path
  ignores `docsMode` until sprint 2 syncs them. The user-facing config reference (README / VISION)
  and CHANGELOG are sprint 2 as well; the `bober init` solo-vs-team question is sprint 3.

## Scope

Two commits on `bober/documenter-docs-output` off `66ea273`: `c0d97c5` (implementation) and
`4155e53` (the committed-default relative-literal fix). Six files, +613/−46 — exactly the contract's
`estimatedFiles`, no others. **31 new tests**: `src/config/schema.test.ts` +9 (each valid mode,
omitted section, empty `documenter` object, invalid mode naming `docsMode`),
`src/orchestrator/documenter-agent.test.ts` +14 (all `resolveSprintDocPath` branches with exact
expected paths; per-mode prompt content), `src/utils/git.test.ts` +8, new (create-when-missing,
no-duplicate-on-second-call, unrelated lines preserved, existing covering pattern → no append).
All 6 required criteria passed on **iteration 2**; typecheck/build clean, eslint 0 errors
(2 pre-existing warnings), suite **4988 passed | 1 skipped**, sprint-relevant files 164/164 —
the 2 failures were pre-existing unrelated load flakes in `src/medical/recommend/recommend.test.ts`
(8/8 in isolation). No new dependency.
