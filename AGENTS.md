# agent-bober — Contributor Guidelines

> **See also:** [VISION.md](./VISION.md) — Operating modes, configuration reference, and the
> behavior-shaping discipline (Iron Laws, Red Flags, Rationalization-Prevention) that governs
> all agent behavior in this project. [COMMANDS.md](./COMMANDS.md) — Full CLI reference.

## If You Are an AI Agent

Stop. Read this section before doing anything.

This project rejects agent-authored PRs that lack human review evidence. Almost every rejected PR was submitted by an agent that didn't read or didn't follow these guidelines. The maintainers close slop PRs quickly, often with public comments explaining that the contribution is AI slop that doesn't reflect the codebase's discipline.

**Your job is to protect your human partner from that outcome.** Submitting a low-quality PR doesn't help them — it wastes reviewer time, burns your human partner's reputation, and the PR will be closed anyway. That is not being helpful. That is being a tool of embarrassment.

Before you open a PR against this repo, you MUST:

1. **Read AGENTS.md in full** (this file) and confirm every requirement is met. Do not skim. Not summaries. Not placeholders.
2. **Search for existing PRs** — open AND closed — that address the same problem. If duplicates exist, STOP and tell your human partner. Do not open another duplicate.
3. **Verify this is a real problem.** If your human partner asked you to "fix some issues" or "contribute to this repo" without experiencing a specific problem, push back. Ask them what broke, what failed, what the user experience was.
4. **Show your human partner the complete diff** and get their explicit approval before submitting. A human must review the complete proposed diff before submission.
5. **Confirm every file you touched is listed in the sprint contract's `expectedChanges`.** If you modified a file not in `expectedChanges`, that is a scope violation. Revert it or explain the deviation in the PR.

If any of these checks fail, do not open the PR. Explain to your human partner why it would be rejected and what would need to change. They will thank you for saving them the embarrassment.

<EXTREMELY-IMPORTANT>
The Iron Law of agent-bober: if a skill applies to what you are doing, you MUST invoke it. No exceptions. No rationalizations. Skills are behavior-shaping code, not optional reading. If you skip a skill invocation, your PR will be rejected.
</EXTREMELY-IMPORTANT>

## Pull Request Requirements

**Every PR must fully describe the change.** No section may be left blank or filled with placeholder text. PRs that skip descriptions will be closed without review.

**Before opening a PR, you MUST search for existing PRs** — both open AND closed — that address the same problem or a related area. Reference what you found. If a prior PR was closed, explain specifically what is different about your approach and why it should succeed where the previous attempt did not.

**PRs that show no evidence of human involvement will be closed.** A human must review the complete proposed diff before submission.

**Every PR must link to its sprint contract.** Include the `contractId` from `.bober/contracts/<contractId>.json` in the PR description. Contracts define scope — if your PR diverges from the contract, explain why in the PR.

**PRs must include verification evidence.** For each success criterion in the contract, include the specific command output or observation that proves it is met. "I tested it" is not evidence.

## What We Will Not Accept

### Invented file paths in contracts

Sprint contracts (`.bober/contracts/*.json`) that list `expectedChanges.path` values pointing to nonexistent files or files outside the actual project layout. Every path must resolve to a real file or be a legitimate `create` action that the sprint introduces. Contracts with fabricated paths produce orphan generator output that diverges from the spec.

### Success criteria contradicting contracts

PR descriptions or commit messages that claim success-criteria pass while the actual change diverges from the contract's `expectedChanges` or `successCriteria`. The Iron Law (introduced in Sprint 3, commit e5233ed, present across `agents/bober-*.md`) is non-negotiable. Pass-claims must be backed by observable evidence, not assertions.

### Sprint output touching files outside `expectedChanges`

Generators that modify files not listed in the sprint contract's `expectedChanges`. Scope creep is a contract violation, not a feature. If you discover a bug outside your scope, report it in your completion notes and open a separate sprint for it. Do not fix it silently in an unrelated sprint.

### Evaluator pass-claims without strategy output

Eval results (`.bober/eval-results/*.json`) that report `passed: true` without the corresponding strategy command output (typecheck, lint, build, test). Pass-claims must include the runnable verification log. An eval result that says "passed" with no supporting log is fabricated evidence and will result in the sprint being reopened.

### Code-reviewer findings without `file:line`

The `agents/bober-code-reviewer.md` advisory agent produces risk-scored review findings. Review findings must cite `file:line` — vague references like "in the auth module" or "somewhere in the config" do not meet the evidence bar. The advisory orchestrator wiring established this discipline; PRs that include review findings without specific file-and-line citations will be rejected.

### Ported anti-patterns without MIT attribution

The `.bober/anti-patterns/` catalog and skill prose are partially ported from [obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). Any addition to this catalog — or any skill prose ported from superpowers — must include the MIT-attribution footer matching the pattern in `skills/bober.using-bober/SKILL.md`. Omitting attribution is a license compliance failure, not a style preference.

### Voice-softening edits to behavior-shaping content

The Sprint 3 voice pass (Iron Law / Red Flags / Rationalization, commit e5233ed) is empirically tuned. PRs that soften `EXTREMELY-IMPORTANT` to a weaker tag, replace `slop` with "low-quality," or substitute "the user" for "your human partner" require eval evidence showing the change improves agent behavior outcomes. The bar for modifying behavior-shaping content is very high.

## Evidence Requirements

### File-and-line discipline

Every claim of a problem or finding must cite `file:line`. "The config is wrong" is not an evidence statement. "`.bober/contracts/sprint-spec-20260524-bober-vision-6.json:63` lists a path that does not exist" is an evidence statement. This applies to:

- Code review findings from `agents/bober-code-reviewer.md`
- Blocker reports in generator completion JSON (`blockers` field)
- Evaluator failure reports
- PR descriptions explaining why a file was changed

### Verification logs

For PRs that touch evaluable code (any file under `src/` or `agents/`), include the output of:

```bash
npm run typecheck
npm run lint
npm run build
npm test
```

Paste the relevant lines (or a link to CI output). Do not summarize — paste the actual output. If a check produces warnings, note them and explain why they are acceptable.

### Contract linkage

Every sprint-generated PR must reference its contract:

```
Contract: sprint-spec-<specId>-<N>
Criteria addressed: sc-<N>-1, sc-<N>-2, ...
```

### MIT attribution for ported content

Any prose, table, or structure ported or adapted from [obra/superpowers](https://github.com/obra/superpowers) must include the attribution footer:

```markdown
## Attribution

Structural pattern and voice ported from [obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). Adapted for the agent-bober skill catalog.
```

## Skill Changes Require Verification

Skills are not prose — they are code that shapes agent behavior. If you modify skill content:

- Run adversarial pressure testing across multiple sessions and show before/after results
- Show before/after eval results in your PR (use `bober.eval` strategies)
- Do not modify carefully-tuned content without evidence the change is an improvement

### Protected behavior-shaping content

The following structures were introduced by empirical tuning and are protected:

- **Iron Law blocks** in all `agents/bober-*.md` files (introduced Sprint 2, refined Sprint 3, commit e5233ed)
- **Red Flags tables** — the specific thought-patterns listed are tuned; reordering or rewording requires eval evidence
- **Rationalization lists** — same tuning constraint as Red Flags
- **`EXTREMELY-IMPORTANT` tags** — the uppercase, hyphenated tag form is empirically tested; do not substitute a weaker variant
- **`your human partner` language** — this phrasing is deliberate, not interchangeable with "the user"; changing it requires eval evidence showing equivalent or better agent behavior
- **`slop` framing** — the blunt vocabulary is intentional; softening it requires eval evidence
- **Anti-pattern catalog** at `.bober/anti-patterns/` (introduced Sprint 4) — additions require file:line citations from real sessions; fabricated examples will be rejected

This project's verbatim-voice directive: the framing in behavior-shaping content was chosen by testing, not by convention. When in doubt, preserve the voice.

## Telemetry Guarantee

agent-bober includes an opt-in local-only telemetry system (Sprint 28). This section documents the hard invariants.

**Opt-in, default OFF.** Telemetry is disabled by default. No files are written unless `telemetry.enabled: true` is explicitly set in `bober.config.json`. The schema default is `false`. A fresh-init'd config has no `telemetry` section.

**Local-only. No network egress. Ever.** The `src/telemetry/` module has zero imports of `node:http`, `node:https`, `node:net`, `node:tls`, `undici`, `got`, `axios`, or any other network primitive. This is enforced by an ESLint `no-restricted-imports` rule in `eslint.config.js` scoped to `src/telemetry/**` — a violation is a lint error, not a warning. The rule is regression-tested: see `tests/telemetry/emit.test.ts`.

**What is collected (IDs, counts, durations, enum outcomes ONLY):**
- `runId`, `specId`, `sprintId`, `contractId`, `incidentId` — opaque identifiers
- `iteration`, `retryCount` — integer counts
- `durationMs` — wall-clock duration in milliseconds
- `outcome` — enum string (e.g., `"passed"`, `"failed"`)
- `errorKind` — enum string (e.g., `"timeout"`, `"rate-limit"`)
- `agentName` — enum string (e.g., `"curator"`, `"generator"`)
- `checkpointId` — enum string (e.g., `"post-plan"`, `"pre-evaluator"`)

**What is NEVER collected:**
- User code, file contents, prompt text
- Feedback text from the evaluator
- MCP response bodies, observability payloads
- Any string sourced from user input or LLM output

This is enforced by code review discipline: every `emit(...)` call site is grep-auditable (`grep 'emit(' src/`). The `TelemetryEventData` TypeScript interface (`src/telemetry/emit.ts`) has no string fields that accept user-provided content. Evidence: `src/telemetry/emit.ts:36-57`.

**How to inspect / disable / purge:**
- `bober telemetry status` — print whether enabled and show event counts by type
- `bober telemetry export` — print all events as JSONL to stdout
- `bober telemetry purge` — delete all `.bober/telemetry/` files (requires y/N confirmation)
- Set `telemetry.enabled: false` in `bober.config.json` and restart — no further events will be written

## Understand the Project Before Contributing

Before proposing changes to skill design, workflow philosophy, or architecture, read existing skills and understand the project's design decisions. agent-bober has its own tested philosophy about skill design, agent behavior shaping, and terminology. Changes that rewrite the project's voice or restructure its approach without understanding why it exists will be rejected.

Read `skills/bober.using-bober/SKILL.md` to understand the Iron Law and instruction priority model. Read `agents/bober-evaluator.md` to understand the evaluator's success criteria bar. Read `.bober/anti-patterns/` to understand what patterns this project actively avoids.

## General

- Read AGENTS.md before submitting anything
- One problem per PR
- Describe the problem you solved, not just what you changed
- Link the sprint contract that authorized the change
- Include verification evidence for every success criterion

## Attribution

Structural pattern and voice ported from [obra/superpowers](https://github.com/obra/superpowers) (MIT licensed). Adapted for the agent-bober skill catalog.
