# Sprint Briefing: Documentation and key-gated provider smoke scripts

**Contract:** sprint-spec-20260531-multi-provider-deepseek-claude-code-6
**Generated:** 2026-05-31

> DOCS + SMOKE ONLY. No provider source code changes. Do NOT fix the 80 pre-existing
> markdownlint errors in README.md — that is scope creep. Your job: NEW docs/providers.md
> fully lint-clean + README additions add ZERO NEW markdownlint errors.

---

## 1. Target Files

### README.md (modify)

Insert the capability matrix into the `## Multi-Provider Support` region. The existing
`### Supported Providers` section is at lines 177-190; insert the new capability matrix
right after the existing provider table (after line 190) or as a new `### Capability Matrix`
subsection. Add a deepseek + claude-code note. Cost/ToS link goes in this section.

**Relevant sections (lines 177-231) — current content:**
```markdown
## Multi-Provider Support              (line 177)

agent-bober is **provider-agnostic**. ...   (line 179)

### Supported Providers                 (line 181)

| Provider | Shorthands | API Key |                                   (line 183)
|----------|-----------|---------|                                   (line 184)  <-- trips MD060
| **Anthropic** (default) | `opus`, `sonnet`, `haiku` | `ANTHROPIC_API_KEY` |  (185)
| **OpenAI** | Any OpenAI model ID | `OPENAI_API_KEY` |               (186)
| **Google Gemini** | `gemini-pro`, `gemini-flash` | `GOOGLE_API_KEY` or `GEMINI_API_KEY` | (187)
| **OpenAI-Compatible** | Any model (Ollama, LM Studio, Groq, DeepSeek, etc.) | Optional | (188)

Shorthands resolve to the latest model version automatically. ...     (line 190)

### Configuration                       (line 192)
... jsonc snippet at lines 196-212 ...
### Anthropic features (Claude Opus 4.8)  (line 226)
--- (line 233)
```

**CRITICAL — existing table at line 184 ALREADY trips MD060** (3 errors on its delimiter row,
columns 12/24/34/1). This is one of the 80 pre-existing errors. DO NOT fix it (scope creep).
But your NEW tables MUST NOT trip MD060 — see §2 for the exact aligned style.

**Imported by:** none (README is leaf documentation).
**Test file:** none. Verification is `npx markdownlint README.md` error-count comparison.

---

### docs/providers.md (create)

**Directory pattern:** `docs/` exists and contains kebab-case `.md` files
(`docs/PR-graph-telemetry-and-update-all.md`). New file: `docs/providers.md`.
**Most similar existing file:** the README `## Multi-Provider Support` section (lines 177-231)
is the structural template for headings + jsonc config snippets.
**Must contain (sc-6-2):**
- Copy-paste `bober.config.json` snippets for: anthropic (default), deepseek
  (note `npm install openai` + `DEEPSEEK_API_KEY`), claude-code (subscription,
  planner/researcher only).
- Explicit statement: agent-bober NEVER persists API keys, and `.env` is gitignored
  (verified: `.gitignore` lines 10-12 list `.env`, `.env.local`, `.env.*.local`).
- The full capability matrix (§7) and cost/ToS facts (§7).
**Must be FULLY markdownlint-clean (exit 0 when linted alone).**

---

### scripts/spike-deepseek.mjs (modify)

**Current guard (lines 12-16) — HARD EXITS 1, must become skip+exit 0:**
```js
const key = process.env.DEEPSEEK_API_KEY;          // line 12
if (!key) {                                         // line 13
  console.error("Set DEEPSEEK_API_KEY in the environment.");  // line 14
  process.exit(1);                                  // line 15  <-- CHANGE to exit 0
}
```
**Required change (sc-6-4):** when `DEEPSEEK_API_KEY` is unset, print a SKIP message
and `process.exit(0)` BEFORE constructing the client (no network call). The client is
built at lines 21-27 via `createClient("openai-compat", "https://api.deepseek.com",
{ apiKey: key }, "deepseek-v4-pro", "Spike")`. The skip must happen before that.
Asserts already cover completion (line 37) + tool_use (lines 59-61). Keep those.

---

### scripts/provider-smoke.mjs (create) — OR extend spike-claude-code-provider.mjs

**Current `scripts/spike-claude-code-provider.mjs` state:**
- Imports `ClaudeCodeAdapter` from `../dist/providers/claude-code.js` (line 11).
- Constructs adapter line 20, runs no-tools completion (lines 22-40), asserts
  text non-empty + empty toolCalls + numeric usage (lines 36-39).
- Spike 2 (lines 42-57) asserts the tools-guard THROWS when `tools` are passed.
- **NO binary probe — it does NOT check for `claude` on PATH and does NOT skip.**
  It will fail (not skip) when `claude` is absent. This MUST be fixed (sc-6-5).

**Required (sc-6-5):** the claude-code smoke must probe for the `claude` binary on PATH,
print a SKIP message and `process.exit(0)` if absent, BEFORE calling `adapter.chat`.
Probe pattern: spawn `claude --version` (or `which claude`) and skip on ENOENT / non-zero.
Cover BOTH completion (Spike 1) and the tools-guard throw (Spike 2) when present.

The contract lists `scripts/provider-smoke.mjs` as estimatedFile — generatorNotes allow
EITHER a new `scripts/provider-smoke.mjs` covering both providers OR extending the existing
spike. Either is acceptable per sc-6-4/sc-6-5. Whichever you pick, ensure BOTH the deepseek
key-gate and the claude binary-gate skip+exit 0.

---

## 2. Patterns to Follow — markdownlint rules for NEW content

Active config (`.markdownlint.json`, verified verbatim):
```json
{
  "MD013": false,
  "MD041": false
}
```
Only MD013 (line-length) and MD041 (first-line-heading) are disabled. EVERY OTHER default
rule is ENFORCED. The new content must satisfy all of these:

### MD060 — table-column-style (default = "aligned")
**Source/evidence:** README:184 trips it; verified in /tmp that aligned tables pass.
Default style is `"aligned"`: every `|` must vertically line up across the header row,
the delimiter row, AND every body row. Pad each cell with spaces so all rows have the
SAME column widths. Single-space padding around content; delimiter dashes fill the column.

**LINT-CLEAN aligned table example (verified EXIT 0):**
```markdown
| Role          | anthropic | deepseek | claude-code        |
| ------------- | --------- | -------- | ------------------ |
| planner       | yes       | yes      | yes (no tools)     |
| curator       | yes       | yes      | no (runs own loop) |
```
**Rule:** Build every NEW table fully column-aligned (pipes vertically aligned in all rows,
including the `| --- |` delimiter row). The compact `|----|----|` style (no spaces) FAILS.

### MD031 — blanks-around-fences
**Rule:** A blank line BEFORE and AFTER every fenced code block (```). README:215/220/242
currently violate this (pre-existing). Your new fences must have surrounding blanks.

### MD032 — blanks-around-lists
**Rule:** A blank line before and after every list.

### MD040 — fenced-code-language
**Rule:** Every fence needs a language tag. Use ```json or ```jsonc for config snippets,
```bash for commands. README:14/110/121 violate this (pre-existing, bare ```).

### MD022 — blanks-around-headings
**Rule:** A blank line before and after every heading (`###` etc.). README:84/91/101 violate.

### MD036 — no-emphasis-as-heading
**Rule:** Don't use `**bold line**` as a standalone pseudo-heading; use a real `###`.

### MD060-safe checklist for the generator
1. Tables: fully aligned pipes in header + delimiter + body (single-space pad).
2. Fences: blank line above and below; always a language tag.
3. Lists: blank line above and below.
4. Headings: blank line above and below; no emphasis-as-heading.

---

## 3. Existing Utilities — DO NOT Recreate

This sprint is docs + smoke scripts only; no new source utilities. Relevant existing exports
the smoke scripts already import (do not reimplement):

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createClient` | `dist/providers/factory.js` (compiled) | `(provider, endpoint, providerConfig, modelId, role) => LLMClient` | Builds an LLMClient; used by spike-deepseek.mjs:21 to drive DeepSeek via openai-compat. |
| `ClaudeCodeAdapter` | `dist/providers/claude-code.js` (compiled) | `new ClaudeCodeAdapter()` → `.chat({model,system,messages,tools?})` | Subscription `claude -p` adapter; used by spike-claude-code-provider.mjs:11,20; throws if `tools` passed. |

Utilities reviewed: scripts import only compiled `dist/` exports above. No `utils/`/`lib/`/
`helpers/` functions are needed for docs+smoke. For the claude binary probe, use Node builtins
(`child_process`/`execa` is a dep but smoke scripts use plain Node) — see §6 pattern.

---

## 4. Prior Sprint Output (facts the docs MUST state correctly)

### Sprint 2 — DeepSeek
Shorthands `deepseek` / `deepseek-v4-pro` / `deepseek-v4-flash` resolve to provider
`openai-compat` @ `https://api.deepseek.com`. Key from `providerConfig.apiKey` else
`DEEPSEEK_API_KEY`. Prerequisite: `npm install openai`. Supports ALL roles (tools work).

### Sprint 4 — claude-code
Provider `claude-code`, subscription (NO API key), prompt-only — THROWS if `tools` passed.
`providerConfig.binary` + `timeoutMs` overrides. `preflightClaudeBinary` checks the `claude`
binary on PATH. (Adapter at dist/providers/claude-code.js.)

### Sprint 5 — role fallback
Tool roles (curator, generator, evaluator, code-reviewer) on claude-code redirect to another
configured provider, or HARD-ERROR at config load if claude-code is the only option.
planner/researcher are ALLOWED on claude-code (no tools needed).

**Connection:** the docs (matrix) and the config snippets must reflect exactly these facts:
claude-code = ❌ for the four tool roles, ✅ for planner/researcher; deepseek = ✅ all roles.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint (docs/smoke only). The governing spec is
`tasks/prd-multi-provider-deepseek-claude-code.md`.

### Architecture / PRD facts
PRD US-007 (lines 156-164): README "Supported Providers" must carry the matrix; claude-code
note must say planner/researcher only, metered per 2026-06-15 ToS (link), and that `claude -p`
injects ~40k-token system-prompt overhead per call.

### no-key-persistence (sc-6-2)
`.gitignore` lines 10-12 (verified): `.env`, `.env.local`, `.env.*.local` are ignored.
State in docs/providers.md: "agent-bober never persists API keys; keys are read from the
environment (or providerConfig at runtime) and `.env` is gitignored."

---

## 6. Smoke-Script / Test Patterns

### npm test does NOT collect smoke scripts (sc-6-6 — VERIFIED)
`package.json` test script (line 16, verbatim):
```json
"test": "vitest"
```
There is NO `vitest.config.*` / `vite.config.*` file in the repo (verified: glob returned
"no matches"). Bare `vitest` with no config uses Vitest defaults, whose `include` is
`**/*.{test,spec}.?(c|m)[jt]s?(x)` — it ONLY collects `*.test.*` / `*.spec.*` files. The
smoke scripts are `scripts/spike-*.mjs` / `scripts/provider-smoke.mjs` (NOT `.test`/`.spec`),
so they are already excluded. **Do NOT add a vitest config, and do NOT name any smoke file
`*.test.mjs` or `*.spec.mjs`** — that would pull it into `npm test` and break sc-6-6.
Keep smoke files out of the `test` script entirely.

### Skip-and-exit-0 guard pattern (what to write)
DeepSeek guard (replace spike-deepseek.mjs:13-15 `exit(1)` with `exit(0)`):
```js
const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.log("SKIP: DEEPSEEK_API_KEY not set — skipping DeepSeek smoke.");
  process.exit(0);
}
```
claude binary probe (add to the claude-code smoke before adapter.chat):
```js
import { spawnSync } from "node:child_process";
const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  console.log("SKIP: `claude` binary not on PATH — skipping claude-code smoke.");
  process.exit(0);
}
```
Both must skip+exit 0 BEFORE any network/subprocess call (sc-6-4, sc-6-5).

### Verification commands
- `npx markdownlint docs/providers.md` → MUST be EXIT 0 (zero errors).
- `npx markdownlint README.md` → MUST still be 80 errors (no NEW errors; pre-existing 80 stay).
- `DEEPSEEK_API_KEY= node scripts/spike-deepseek.mjs` → prints SKIP, exits 0, no network.
- claude smoke with no `claude` on PATH → prints SKIP, exits 0.
- `npm test` → exits 0, no smoke script executed.

---

## 7. PRD Capability Matrix (VERBATIM) + Cost/ToS Facts

### Capability matrix — mirror this EXACTLY (PRD lines 52-66)
```
| Role | anthropic (default) | deepseek (openai-compat) | claude-code (subscription) |
|------|---------------------|--------------------------|----------------------------|
| planner | ✅ | ✅ | ✅ (no tools needed) |
| researcher (phase 1/2) | ✅ | ✅ | ✅ (no tools needed) |
| curator | ✅ | ✅ (tools) | ❌ runs own loop |
| generator | ✅ | ✅ (tools) | ❌ runs own loop |
| evaluator | ✅ | ✅ (tools) | ❌ runs own loop |
| code-reviewer | ✅ | ✅ (tools) | ❌ runs own loop |
```
**Reproduce these rows/columns** (sc-6-1: rows planner, researcher, curator, generator,
evaluator, code-reviewer; columns anthropic, deepseek, claude-code; claude-code = ❌ for the
four tool roles). When you render it in README/docs, RE-ALIGN the pipes per §2 (the PRD's own
table uses the compact no-space delimiter that would trip MD060) — keep the CONTENT identical
but align the pipes so it lints clean.

**Rule (PRD lines 63-66):** claude-code is valid only for roles that send no `tools`. For
tool-using roles, if claude-code is configured but another provider is also configured, the
other provider is used; if claude-code is the ONLY configured provider for a tool role, that
is a configuration error surfaced at load time.

### Cost / ToS facts (PRD lines 32-35, 160-164)
- **ToS (2026-06-15):** programmatic subscription use is ALLOWED but METERED (separate monthly
  Agent-SDK credit = plan fee, billed at API rates, NO rollover). claude-code is NOT
  "free unlimited."
- **DeepSeek is the cheaper full-capability path** (works for all roles incl. tools).
- **`claude -p` injects ~40k-token system-prompt overhead per call** — call this out in the
  claude-code note as a cost consideration.

---

## 8. Impact Analysis

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| README.md | self | low | Must stay at 80 markdownlint errors (no NEW errors). |
| docs/providers.md | new | low | Must lint EXIT 0 standalone. |
| scripts/spike-deepseek.mjs | dist/providers/factory.js | low | Existing asserts (lines 37,59-61) unchanged; only add skip guard. |
| scripts/spike-claude-code-provider.mjs | dist/providers/claude-code.js | low | Add binary probe; keep Spike 1 + Spike 2 asserts. |
| package.json | — | medium | Do NOT add smoke to `test`; do NOT add a vitest include glob. |

### Existing Tests That Must Still Pass
- `npm test` (vitest, all `**/*.test.ts`) — must remain EXIT 0 and must NOT pick up any smoke
  script. No test file imports the smoke scripts (they are run manually). Verify by running
  `npm test` after changes.

### Features That Could Be Affected
- **feat-7 (docs)** and **feat-8 (smoke gating)** are this sprint. No other plan feature shares
  these files. Provider source (Sprints 2-5) is OUT of scope — do not touch it.

### Recommended Regression Checks (run all after implementation)
1. `npx markdownlint docs/providers.md` → EXIT 0.
2. `npx markdownlint README.md 2>&1 | wc -l` → still `80` (baseline; no new errors).
3. `DEEPSEEK_API_KEY= node scripts/spike-deepseek.mjs` → SKIP + exit 0, no network.
4. claude smoke with `claude` not on PATH → SKIP + exit 0.
5. `npm test` → EXIT 0, no smoke output in the run.
6. `grep -n "spike\|provider-smoke\|scripts/" package.json` → only build/update-all refs, NOT in `test`.

---

## 9. Implementation Sequence

1. **scripts/spike-deepseek.mjs** — change `process.exit(1)` (line 15) to a SKIP message +
   `process.exit(0)` before client construction.
   - Verify: `DEEPSEEK_API_KEY= node scripts/spike-deepseek.mjs` prints SKIP, exits 0.
2. **claude-code smoke** (extend spike-claude-code-provider.mjs OR new scripts/provider-smoke.mjs)
   — add a `claude` binary probe that skips+exits 0 when absent, before adapter.chat.
   - Verify: with no `claude` on PATH, prints SKIP, exits 0; Spike 1 + Spike 2 asserts kept.
3. **docs/providers.md** — create. Headings + aligned matrix + three config snippets
   (anthropic/deepseek/claude-code) + no-key-persistence statement + cost/ToS facts.
   - Verify: `npx markdownlint docs/providers.md` → EXIT 0.
4. **README.md** — add the capability matrix (aligned per §2) + deepseek/claude-code note +
   cost/ToS link into the `## Multi-Provider Support` region (after line 190).
   - Verify: `npx markdownlint README.md 2>&1 | wc -l` still `80`.
5. **package.json** — confirm (no change needed) the `test` script is bare `vitest` and no
   smoke file is referenced; do NOT create a vitest config.
   - Verify: `npm test` → EXIT 0, no smoke executed.
6. **Full verification** — run all six regression checks in §8.

---

## 10. Pitfalls & Warnings

- DO NOT fix the 80 pre-existing README markdownlint errors (line 184 table, bare fences at
  14/110/121, headings at 84/91/101, etc.). Only ensure your ADDITIONS add ZERO new errors.
- The default MD060 style is "aligned" — NOT compact. Pipes must vertically align in EVERY
  row including the `| --- |` delimiter. Copy-pasting the PRD matrix verbatim WILL trip MD060
  (its delimiter is `|------|`); re-align the pipes while keeping content identical.
- Do NOT name any smoke file `*.test.mjs` / `*.spec.mjs` and do NOT create a vitest config
  with an include glob covering `scripts/` — either would break sc-6-6.
- Smoke scripts run against compiled `dist/` (`npm run build` first); they import
  `dist/providers/factory.js` and `dist/providers/claude-code.js`. Do not change those imports.
- The skip guard MUST run BEFORE any network call (deepseek) or subprocess call (claude),
  otherwise sc-6-4/sc-6-5 ("no network call") fail.
- Never commit a real API key or `.env`. The no-key-persistence statement is a sc-6-2 requirement.
- Every NEW fenced code block needs a language tag (MD040) and surrounding blank lines (MD031);
  every NEW heading and list needs surrounding blank lines (MD022/MD032).
