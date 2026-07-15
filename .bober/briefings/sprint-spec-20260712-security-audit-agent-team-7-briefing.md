# Sprint Briefing: Add the bober.security-audit skill, enable dogfooding, and write docs

**Contract:** sprint-spec-20260712-security-audit-agent-team-7
**Generated:** 2026-07-12T13:25:03Z

> FINAL sprint (7 of 7). This is a **markdown + config + docs + one test-edit** sprint. NonGoals are explicit: **NO application code**. The four target files are: a new `SKILL.md`, a minimal `bober.config.json` edit, a new `docs/security-audit.md`, and the deep-equal repair in `src/config/schema.test.ts`.

---

## 1. Target Files

### `skills/bober.security-audit/SKILL.md` (create)

**Directory pattern:** Each skill is `skills/bober.<name>/SKILL.md`. `skills/bober.code-review/` contains **ONLY** `SKILL.md` — no `references/` subdir (verified: `ls skills/bober.code-review/` → `SKILL.md`). Mirror that: create just `skills/bober.security-audit/SKILL.md`, no subdirs.

**Most similar existing file:** `skills/bober.code-review/SKILL.md` (186 lines) — the exact structural template. It is an *orchestrator* skill: the SKILL body does NOT do the work itself, it spawns a subagent via the Agent tool and processes/saves the result.

**Frontmatter template (from `skills/bober.code-review/SKILL.md:1-5`):**
```yaml
---
name: bober-code-review
description: Use when completing a sprint, after evaluator pass — spawns bober-code-reviewer subagent to audit the sprint diff against the contract and anti-pattern catalog, producing an advisory ReviewResult written to .bober/reviews/<contractId>-review.md.
argument-hint: "[contract-id]"
---
```
**Rule:** three frontmatter keys — `name` (kebab, `bober-security-audit`), `description` (starts with "Use when…" trigger guidance), `argument-hint` (`"[target]"` — the CLI takes an optional target path, sc-4). NOTE the frontmatter `name` is `bober-code-review` (the COMMAND name), while the agent it spawns is `bober-code-reviewer`. For the new skill: frontmatter `name: bober-security-audit`, agent spawned is `bober-security-auditor`.

**Orchestrator body shape to mirror (`skills/bober.code-review/SKILL.md`):**
- L11-17: title + "You are the **orchestrator**… You do NOT review the code yourself. You spawn the … subagent using the **Agent tool**, then process and save its results to `.bober/…/<contractId>-…md`." + an "Integration with bober pipeline" note (the pipeline gate is the automated path; this skill is the **standalone/manual** path).
- L19-27 "When to Request …": mandatory-in-pipeline vs manual-use bullets.
- L28-61 what the auditor checks / what NOT to flag / acting on feedback by severity.
- L62-171 "Process Flow": Step 1 identify target → Step 2 gather context (read `bober.config.json`, `.bober/principles.md`) → Step 3 spawn subagent with a full prompt (paste contract JSON, project root, context, task) → Step 4 process + save result.
- L172-187 "Red Flags - STOP" + "Rationalization Prevention" table.

**Concrete content the security skill body MUST get right (evaluator checks these exist as named — stale refs = fail, evaluatorNotes sc-7-1):**
- Agent to spawn: **`bober-security-auditor`** (file `agents/bober-security-auditor.md`; tools Read/Grep/Glob; model opus). It returns a `ReviewResult` JSON — the orchestrator persists it (the agent has NO Write tool).
- CLI alternative to spawning: **`bober security-audit [target]`** (or `agent-bober security-audit`) — see `src/cli/commands/security-audit.ts`.
- Config keys read: `security.enabled`, `security.standaloneBlockOn`, `security.scanners`, `security.hub` (see §3 schema).
- Persisted artifact path: **`.bober/security/<contractId>-security-audit.md`** (exact — from `src/state/security-audit-state.ts:17-18`, safeId = contractId with `[^a-zA-Z0-9_-]` → `_`).
- Present findings **ranked by severity** (critical → important → minor) with **path:line** citations.
- **Advisory in skill mode:** the skill never instructs writing code fixes (sc-7-1); remind that enforcement lives in the **CLI exit code** and the **pipeline gate**, not the skill. The `bober-security-auditor` agent itself "never writes, edits, or blocks completion" (`agents/bober-security-auditor.md:3`).

**Attribution note:** `bober.code-review` has an "Adapted from obra/superpowers" note (L7-9) because it was ported. `bober.security-audit` is NOT a port — OMIT the attribution block (do not fabricate a superpowers origin).

---

### `bober.config.json` (modify) — dogfooding

**Current state (full file is 76 lines; relevant fact):** there is **no** `security` key today. Sibling opt-in sections (`vault`, `fleet`, `tools`) are all absent from this file — they are `.optional()` and never materialized.

**Exact change (minimal diff — generatorNotes item 2):** add ONE top-level key. Do NOT materialize other defaults:
```jsonc
  "security": { "enabled": true, "scanners": [] },
```
Place it as a new top-level section (e.g. after `"graph"` / before `"commands"`, or wherever reads cleanly — ordering is cosmetic, the deep-equal test compares object equality not key order). Keep `scanners: []` (LLM-only per nonGoals[1] — slither/semgrep not guaranteed on dev machines).

**Why this is safe (assumption 2, verified):** the ONLY test that reads the repo's own `bober.config.json` is `src/config/schema.test.ts:744-819`. Every other test writes its own temp config (grep confirmed: `pipeline.test.ts` uses `vi.mock("./security-auditor-agent.js")` at L119 and builds inline configs — it never loads the repo config, so flipping `enabled:true` cannot make any pipeline test spawn a real audit).

---

### `docs/security-audit.md` (create)

**Directory pattern:** `docs/*.md` — precedent `docs/teams.md`, `docs/chat-steer.md`, `docs/providers.md` (assumption 3). Use **timeless language** (describe the feature as it is, not "this sprint adds…") per repo doc conventions (generatorNotes item 4).

**Required structure (generatorNotes item 4 + sc-7-3):** Overview → Quick start (CLI + skill) → Pipeline gate (flows incl. blocked path) → Configuration reference table (field/type/default/effect) → Scanners (slither/semgrep config examples with JSON output flags) → Hub emission → Fail-closed guarantees → FAQ (timeout / budget exhaustion / false positive → cite retry path).

**Existing material to consolidate (already written elsewhere — reuse the wording, cross-check every field):**
- `README.md:630-631` — CLI usage + exit codes (verbatim source of truth for the Quick-start CLI section).
- `README.md:852-862` — annotated config-reference block (every field + inline comment).
- `docs/storage.md:225-263` — the `security` section prose + the `.bober/security/` artifact row (`docs/storage.md:154`).
The docs sc-7-3 criterion says docs/security-audit.md **consolidates** — pull these together into one authoritative page.

---

### `src/config/schema.test.ts` (modify) — THE REGRESSION TRAP

This is the single biggest trap of the sprint. The test at **`src/config/schema.test.ts:744-819`** deep-equals the parsed repo `bober.config.json` and asserts `security` is absent. Adding `security` to the config **breaks two assertions**:

**Relevant section (`src/config/schema.test.ts:744-818`):**
```ts
describe("BoberConfigSchema — repo's own bober.config.json parses byte-identically (sc-1-2)", () => {
  it("deep-equals an explicit expected snapshot, with no security key materialized", async () => {
    const raw = await readFile(join(process.cwd(), "bober.config.json"), "utf-8");
    const rawJson: Record<string, unknown> = JSON.parse(raw);
    const parsed = BoberConfigSchema.parse(rawJson);

    // The security key must be absent — this schema change never injects it.
    expect(Object.hasOwn(parsed, "security")).toBe(false);   // <-- L751 BREAKS (now true)

    expect(parsed).toEqual({                                  // <-- L755 BREAKS (needs security added)
      project: { name: "agent-bober", mode: "greenfield" },
      ...
      commands: {},
    });
  });
});
```

**Two required edits:**
1. **`src/config/schema.test.ts:751`** — `expect(Object.hasOwn(parsed, "security")).toBe(false)` must become `.toBe(true)` (or be replaced by a positive assertion on the materialized section). The comment above it ("this schema change never injects it") and the `it()` title ("with no security key materialized", L745) are now stale — update them for hygiene.
2. **`src/config/schema.test.ts:755-817`** — add a `security` key to the expected deep-equal object. Because the config has `security: { enabled: true, scanners: [] }`, the schema materializes **all** defaults. The expected object (cross-check against §3 defaults) is:
```ts
      security: {
        enabled: true,       // explicit in config
        failClosed: true,    // default
        timeoutMs: 300_000,  // default
        model: "opus",       // default
        maxTurns: 20,        // default
        scanners: [],        // explicit in config
        standaloneBlockOn: "critical", // default
        hub: true,           // default
      },
```
`provider`, `endpoint`, `providerConfig`, `budget` are `.optional()` with **no** default → they are **NOT** materialized (absent from the parsed object). Do not add them to the expected object. This exactly matches the `SecuritySectionSchema.parse({})` default set already asserted at `src/config/schema.test.ts:641-651`, plus `enabled: true`.

**Do NOT** touch the other `security`-section tests (`src/config/schema.test.ts:639-742`) — they construct standalone fixtures and are unaffected. This is sc-7-2's "a test asserts the repo config file remains schema-valid" — the existing L744 test already does that via `BoberConfigSchema.parse(rawJson)`; the generator just keeps it green.

---

## 2. Patterns to Follow

### Orchestrator-skill body (spawn-a-subagent, don't-do-the-work)
**Source:** `skills/bober.code-review/SKILL.md:11-13`
```
You are the **orchestrator** for a standalone code review run. You do NOT review the code
yourself. You spawn the code reviewer as a subagent using the **Agent tool**, then process
and save its results to `.bober/reviews/<contractId>-review.md`.
```
**Rule:** The skill is a conductor. It spawns `bober-security-auditor`, then presents/points to `.bober/security/<contractId>-security-audit.md`. It never audits inline and never writes fixes.

### Skill frontmatter with trigger-first description
**Source:** `skills/bober.code-review/SKILL.md:2` (`description:` begins "Use when completing a sprint, after evaluator pass — …")
**Rule:** Start `description` with a "Use when…" trigger so Claude Code surfaces the skill at the right moment; end with the concrete artifact it produces.

### Config-reference doc block (annotated JSONC)
**Source:** `README.md:852-862` and `docs/storage.md:234-243`
```jsonc
"security": {
  "enabled": false,                     // Fail-closed pipeline gate runs ONLY when exactly true. NOT required by the standalone CLI.
  "failClosed": true,
  "timeoutMs": 300000,
  "model": "opus",
  "maxTurns": 20,
  "standaloneBlockOn": "critical",      // CI threshold for `bober security-audit`: 'critical' | 'important'. Gate ignores this key.
  "scanners": [],
  "hub": true
}
```
**Rule:** Reuse this exact annotation style in docs/security-audit.md's config table; every documented default MUST match `SecuritySectionSchema` (§3) — evaluatorNotes cross-checks every field.

### CLI exit-code semantics (verbatim source of truth)
**Source:** `src/cli/commands/security-audit.ts:16-18`
```
 * Exit codes: 0 = pass, 2 = blocked-by-threshold OR fail-closed (audit threw,
 * or the auditor's output could not be parsed). 1 is reserved for Commander's
 * own usage errors and for unexpected errors resolving config/project root.
```
**Rule:** Document exactly these codes. `standaloneBlockOn: "critical"` (default) blocks only on critical findings; `"important"` also blocks on important-bucket findings (`security-audit.ts:59-66`, `thresholdVerdict`).

---

## 3. `SecuritySectionSchema` — the config field reference (source of truth for docs + test)

**Source:** `src/config/schema.ts:210-228` (wired `.optional()` at `src/config/schema.ts:632-633`).

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `enabled` | boolean | `false` | Pipeline fail-closed gate runs only when exactly `true`. NOT required by the standalone CLI. |
| `failClosed` | boolean | `true` | Unparseable auditor output / timeout blocks. |
| `timeoutMs` | int > 0 | `300000` | Per-audit `Promise.race` time-box (pipeline gate). |
| `model` | ModelChoice | `"opus"` | Auditor model (shorthand or full string). |
| `maxTurns` | int ≥ 1 | `20` | Max read-only tool-use turns. |
| `provider` | string? | (unset) | Optional provider override. Not materialized when omitted. |
| `endpoint` | string \| null ? | (unset) | Optional endpoint override. Not materialized. |
| `providerConfig` | record? | (unset) | Optional provider config. Not materialized. |
| `budget` | `{maxUsd}`? | (unset) | Optional per-run USD ceiling. Not materialized. |
| `scanners` | `EvalStrategy[]` | `[]` | Opt-in deterministic pre-filter (slither/semgrep). Empty ⇒ zero child processes. |
| `standaloneBlockOn` | `"critical"\|"important"` | `"critical"` | CLI exit-code threshold ONLY. The pipeline gate ignores this (critical-only veto). |
| `hub` | boolean | `true` | Emit critical/important findings to the priority hub. |

Scanner strategy shape = `EvalStrategySchema` (`src/config/schema.ts:74-88`): `{ type, label?, command?, required? }`. Parser selection is by "slither"/"semgrep" substring in `type`/`label`/`command` (`src/orchestrator/security-scanners.ts:263-274`); scanners are run with their `--json` output flag and parsed into priors; nonzero exit ⇒ `[]`.

---

## 4. Existing Utilities / Symbols — DO NOT recreate; reference by exact name

| Symbol | Location | Signature / value | Purpose |
|--------|----------|-------------------|---------|
| `bober-security-auditor` (agent) | `agents/bober-security-auditor.md` | Read/Grep/Glob, model opus | The subagent the skill spawns; returns ReviewResult JSON. |
| `registerSecurityAuditCommand` | `src/cli/commands/security-audit.ts:289` | `(program, overrides?) => void` | Registers `bober security-audit [target]` (wired at `src/cli/index.ts:360`). |
| `thresholdVerdict` | `src/cli/commands/security-audit.ts:59` | `(review, "critical"\|"important") => boolean` | CLI-local block decision (doc the threshold semantics from here). |
| `evaluateSecurityGate` | `src/orchestrator/security-gate.ts:83` | `(SecurityGateInput) => Promise<SecurityGateVerdict>` | The fail-closed pipeline gate (doc gate semantics from its JSDoc L63-82). |
| `renderSecurityFeedback` | `src/orchestrator/security-gate.ts:223` | `(verdict) => string[]` | Renders blocked-round feedback fed to next generator iteration. |
| `runSecurityAudit` | `src/orchestrator/security-auditor-agent.ts:48` | `(contract, evaluation\|null, projectRoot, config, priors?) => Promise<SecurityAuditResult>` | The core both the gate and CLI call. |
| artifact path helper | `src/state/security-audit-state.ts:17-18` | `.bober/security/${safeId}-security-audit.md` | The persisted-artifact path the skill/docs must cite exactly. |
| `SecuritySectionSchema` | `src/config/schema.ts:210` | Zod object | The config schema — docs field table must match it exactly. |

No NEW utilities are needed this sprint (nonGoals[2]: no application code). Utilities reviewed: `src/utils/`, `src/state/`, `src/orchestrator/security-*` — all six security modules already exist (sprints 1-6); the skill/docs only *reference* them.

---

## 5. Prior Sprint Output (what this sprint wires together)

- **Sprint 1** — `SecuritySectionSchema` (`src/config/schema.ts:210-228`) + `.bober/security/` store (`src/state/security-audit-state.ts`). THIS sprint edits the config to opt in and repairs the sprint-1 deep-equal test.
- **Sprint 2** — `runSecurityAudit` (`src/orchestrator/security-auditor-agent.ts:48`) + `agents/bober-security-auditor.md`. THIS sprint's skill spawns that agent.
- **Sprint 3** — `evaluateSecurityGate` + pipeline gate (`src/orchestrator/pipeline.ts:449-531`). Flipping the dogfood `enabled:true` makes this gate run on every future agent-bober sprint.
- **Sprint 4** — `bober security-audit [target]` CLI (`src/cli/commands/security-audit.ts`), exit 0/2, `standaloneBlockOn`. THIS sprint's skill/docs reference it.
- **Sprint 5** — slither/semgrep scanner parsers (`src/orchestrator/security-scanners.ts`). Docs' Scanners section documents these (config stays `scanners:[]` for dogfooding).
- **Sprint 6** — hub emission (`src/orchestrator/security-hub.ts`, `security.hub` default true). Docs' Hub-emission section documents this.

**Gate semantics to document (from `src/orchestrator/pipeline.ts:449-531` + `security-gate.ts:63-82`):** when `security.enabled === true`, gate runs at the top of the `if (evaluation.passed)` branch BEFORE the sprint is marked passed. Blocked reasons: `critical-finding` / `timeout` / `audit-error` (unparseable or thrown). On block: no `sprint-passed`; a **`security-audit-blocked`** history event (phase `rework`); findings routed into the next generator iteration's feedback (`pendingSecurityFeedback`); **code-review + documenter are skipped**; at `maxIterations` → `needs-rework`. On clean: a **`security-audit-clean`** history event, falls through unchanged. When `security` is absent or `enabled !== true`: branch skipped → pipeline byte-identical.

---

## 6. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — `.js` import extensions, `node:fs/promises` (relevant only to the test edit; the test already uses `readFile` from `node:fs/promises`).
- **Zod for config validation** — never hand-roll; the schema change is already in `src/config/schema.ts` (this sprint only edits the JSON + the test).
- **Tests collocated** `*.test.ts` — the config test stays in `src/config/schema.test.ts`.
- **Conventional commits** — `bober(sprint-7): …` for the generated commit.
- Docs: timeless language, no UI (CLI/library tool).

### Architecture Decisions
Binding doc: `.bober/architecture/arch-20260712-security-audit-agent-team-architecture.md`. Relevant ADRs already realized in code: ADR-2 (fail-closed gate, critical-only veto), ADR-3 (`.bober/security/` separate from `.bober/reviews/`), ADR-5 (feedback into next generator iteration), ADR-6 (documenter/code-review skipped on block). Docs should describe these behaviors, not re-decide them.

### Other Docs
- `README.md:630-631` (CLI), `README.md:852-862` (config ref), `docs/storage.md:154` + `docs/storage.md:225-263` (artifact + section prose) — the material to consolidate into `docs/security-audit.md`.

---

## 7. Testing Patterns

### Unit Test Pattern (the only test edit this sprint)
**Source:** `src/config/schema.test.ts:744-818`
```ts
describe("BoberConfigSchema — repo's own bober.config.json parses byte-identically (sc-1-2)", () => {
  it("deep-equals an explicit expected snapshot, ...", async () => {
    const raw = await readFile(join(process.cwd(), "bober.config.json"), "utf-8");
    const parsed = BoberConfigSchema.parse(JSON.parse(raw));
    expect(parsed).toEqual({ /* full expected object incl. new security block */ });
  });
});
```
**Runner:** vitest. **Assertion style:** `expect().toEqual()` / `expect().toBe()`. **Mock approach:** none here (reads the real repo file — that is the point). **File naming:** `*.test.ts` collocated. **Location:** `src/config/schema.test.ts` (existing).

Reference default-set assertion to copy the security shape from: `src/config/schema.test.ts:640-652` (`SecuritySectionSchema.parse({})` → full default object).

### E2E Test Pattern
Not applicable — no Playwright/E2E for a config/skill/docs sprint.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/schema.test.ts:744` | `bober.config.json` (reads it, deep-equals) | **high** | The deep-equal + `Object.hasOwn` assertion. MUST be updated (see §1). This is the ONE guaranteed break. |
| `src/orchestrator/pipeline.ts:453` | `config.security.enabled` | low | Only relevant at RUNTIME (real pipeline runs), not in the test suite — `pipeline.test.ts` mocks the auditor and builds its own config. |
| all other `*.test.ts` reading `bober.config.json` | temp configs they write themselves | none | Grep confirmed: `loader.test.ts`, `run.test.ts`, `blackboard.test.ts`, `security-audit.test.ts`, etc. all `writeFile` their own temp config — none read the repo file. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — the whole file, especially the L744 deep-equal (must be edited) and the L639-742 `SecuritySectionSchema` tests (unaffected — verify still green).
- `src/orchestrator/pipeline.test.ts` — the sprint-3 gate tests. Uses `vi.mock("./security-auditor-agent.js")` (`pipeline.test.ts:119`); confirm no test regresses (it builds inline configs, not the repo config).
- `src/orchestrator/security-gate.test.ts`, `security-auditor-agent.test.ts`, `security-hub.test.ts`, `security-scanners.test.ts`, `security-audit-types.test.ts` — all use self-built fixtures; verify still green.
- `src/cli/commands/security-audit.test.ts` — CLI behavior; self-built temp configs; verify still green.

### Features That Could Be Affected
- **Skill distribution / `update-all`** — shares `skills/` and the auto-derived skill map. Creating `skills/bober.security-audit/SKILL.md` is auto-discovered (see §9); no other file needs editing. Verify the new dir has exactly one file (`SKILL.md`) so it matches the sibling layout `update-all` expects (sc-7-4).
- **Every future agent-bober sprint** — with `enabled:true`, the real pipeline now runs the fail-closed gate. This is the intended dogfooding (approved, assumption 5). No test impact; a live-run cost/latency note belongs in the handoff.

### Recommended Regression Checks
1. `npm run build` — clean tsc output (sc-7-5).
2. `npm run typecheck` (`npx tsc --noEmit`) — zero type errors.
3. `npm run lint` — zero ESLint errors.
4. `npm test` — full suite green. **Specifically** `npx vitest run src/config/schema.test.ts` must pass (the edited deep-equal).
5. Sanity: parse the repo config with the real schema — `node -e "import('./dist/config/schema.js').then(m=>console.log(m.BoberConfigSchema.parse(JSON.parse(require('fs').readFileSync('bober.config.json','utf8'))).security))"` should print the materialized security object (or run the existing test, which does this).
6. Confirm NO test newly spawns a subagent or touches the network (evaluatorNotes sc-7-5) — if one does, it means a test read the repo config; report as a finding, do not mask.

---

## 9. Skill Distribution — how the new skill is discovered (sc-7-4)

**Key fact:** the skill→command map is **derived at runtime from the `skills/` directory**, not hardcoded. `scripts/update-all.mjs:39-52` does `readdir(SKILLS_ROOT)` and maps every `skills/bober.X` dir → `bober-X.md`. So creating `skills/bober.security-audit/SKILL.md` is automatically picked up.

**Therefore:**
- Create ONLY `skills/bober.security-audit/SKILL.md`. Do NOT hand-author a `.claude/commands/bober-security-audit.md` twin — `update-all`/`agent-bober init` GENERATES it (by inlining `SKILL.md` + sorted `references/`). Running `update-all` is explicitly a **post-merge follow-up** (nonGoals[0], outOfScope).
- Do NOT edit `.claude-plugin/marketplace.json` or `.claude-plugin/plugin.json`. `marketplace.json:4` has a prose count ("24 skills + 11 subagents") but there is no per-skill registry to update — skill discovery is directory-driven. (Note the count is now stale; leave it — updating counts is outside this sprint's scope and not a success criterion.)
- The sibling `skills/bober.code-review/` has NO `references/` subdir, so `bober.security-audit/` should have none either — one `SKILL.md`, byte-clean layout.

---

## 10. Implementation Sequence

1. **`bober.config.json`** — add `"security": { "enabled": true, "scanners": [] }` (minimal diff, no other defaults).
   - Verify: `node -e "JSON.parse(require('fs').readFileSync('bober.config.json','utf8'))"` succeeds (valid JSON).
2. **`src/config/schema.test.ts`** — flip L751 `Object.hasOwn(...security...)` false→true; add the materialized `security` block (§1) to the L755 deep-equal; refresh the stale `it()` title/comment.
   - Verify: `npx vitest run src/config/schema.test.ts` passes.
3. **`skills/bober.security-audit/SKILL.md`** — author the orchestrator skill mirroring `skills/bober.code-review/SKILL.md` (frontmatter + spawn-`bober-security-auditor` body + CLI path + severity-ranked findings + `.bober/security/` artifact pointer + advisory-in-skill reminder). No `references/` subdir.
   - Verify: frontmatter has `name`/`description`/`argument-hint`; every referenced name (`bober-security-auditor`, `bober security-audit`, config keys, `.bober/security/…` path) exists in-repo.
4. **`docs/security-audit.md`** — write the consolidated doc (Overview → Quick start → Pipeline gate incl. blocked flow → Config reference table matching §3 → Scanners w/ slither/semgrep JSON examples → Hub emission → Fail-closed guarantees → FAQ w/ retry path). Timeless language.
   - Verify: every field/default in the table matches `src/config/schema.ts:210-228`; exit codes match `src/cli/commands/security-audit.ts:16-18`.
5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` (sc-7-5).

---

## 11. Pitfalls & Warnings

- **THE deep-equal trap (highest risk):** `src/config/schema.test.ts:751` AND `:755` both break the instant `security` is added to `bober.config.json`. `Object.hasOwn(...)` flips to `true`, and the `.toEqual({...})` object omits `security`. Both must be updated in the same change or the suite goes red. Materialize exactly the 8 keys in §1 — NOT `provider`/`endpoint`/`providerConfig`/`budget` (those are `.optional()` and stay absent).
- **Do NOT hand-create `.claude/commands/bober-security-audit.md`.** It is generated by `update-all`/`init` from `skills/`. Creating it by hand risks drift and is not the repo convention; `update-all` is a post-merge follow-up (nonGoals[0]).
- **Do NOT add a `references/` subdir** — `skills/bober.code-review/` has none; match the sibling layout exactly (sc-7-4 diffs the directory shape).
- **Do NOT materialize other config defaults** into `bober.config.json` (generatorNotes item 2) — a `security: { enabled, scanners }` two-key diff only. Adding e.g. `failClosed`/`timeoutMs` explicitly would still parse but adds noise and could desync the deep-equal expectations if not mirrored.
- **Do NOT configure scanners** in the dogfood config (nonGoals[1]) — slither/semgrep aren't guaranteed on dev machines; keep `scanners: []` (LLM-only).
- **Do NOT add application code** (nonGoals[2]) — this sprint is markdown + JSON + one test edit. If you feel the urge to add a helper, stop: the six security modules already exist (sprints 1-6).
- **Stale-reference risk in the skill (evaluatorNotes sc-7-1):** the agent name is `bober-security-auditor` (NOT `-audit`, NOT `-reviewer`); the CLI is `security-audit` (NOT `audit`); the artifact dir is `.bober/security/` (NOT `.bober/reviews/`). One wrong name fails the criterion.
- **`docs/sprints/README.md` has NO section for spec-20260712** (verified: grep for "security"/"20260712" returns nothing). The per-sprint `docs/sprints/*.md` records (1-5 exist; 6 and 7 pending) are written by the **documenter agent**, not this sprint. Adding a `docs/sprints/README.md` section is a documenter concern — note it in the handoff; it is NOT one of this sprint's four `estimatedFiles`.
- **`docs/security-audit.md` timeless language:** don't write "sprint 7 adds…"; describe the feature as a stable capability (per repo doc convention and how `docs/teams.md`/`docs/chat-steer.md` read).
