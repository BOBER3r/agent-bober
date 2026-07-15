# Sprint Briefing: Wire run/sprint/eval orchestrators + per-skill reference copies + regenerate commands

**Contract:** sprint-spec-20260604-native-lens-panel-3
**Generated:** 2026-06-04T05:00:00Z

> FINAL sprint of the Native-Surface Multi-Lens Evaluator Panel plan. Markdown-heavy: 3 SKILL.md edits, 3 reference copies, 3 regenerated commands, 1 TS test extension. The ONLY code file is the vitest drift gate.

---

## 0. Authoritative Gate — READ FIRST

The contract was CORRECTED. There are TWO drift-detection mechanisms; only ONE is your gate:

- ❌ `npm run update-all:check` — syncs EXTERNAL projects in `scripts/sync-targets.json`, NOT this repo. It already reports PRE-EXISTING drift from Sprint 2 (it copies `agents/` into external `.claude/agents/`). It is **informational only**. Do NOT use it to pass/fail this sprint, and do NOT modify `scripts/update-all.mjs` to make it green.
- ✅ The **in-repo vitest recomputation** in `src/orchestrator/lens-panel-parity.test.ts`. This test reads each `skills/bober.<x>/SKILL.md`, readdir's `references/`, sorts filenames, concatenates in the `inlineSkill` format, and asserts byte-equality with the committed `.claude/commands/bober-<x>.md`. THIS is the gate (criteria C3 + C5).

**VERIFIED current sync state (recomputed via node BEFORE any changes):**
```
bober.run   => IN SYNC (28192 bytes)
bober.sprint=> IN SYNC (29724 bytes)
bober.eval  => IN SYNC (30898 bytes)
```
All three `.claude/commands/bober-{run,sprint,eval}.md` are presently byte-identical to their recomputed inline. So there is **no pre-existing command drift you'd be blamed for** — after your edits, the test must STILL pass for all three (you regenerate the commands as part of this sprint).

---

## 1. Target Files

### `scripts/update-all.mjs` — DO NOT MODIFY (read-only reference for the format)

This file defines the canonical inline format. Your test (and your hand-regeneration of the 3 commands) must replicate `inlineSkill` EXACTLY. Lines 55-71:

```js
async function inlineSkill(skillDir) {
  const srcSkill = join(SKILLS_ROOT, skillDir, "SKILL.md");
  let content = await readFile(srcSkill, "utf-8");

  const refsDir = join(SKILLS_ROOT, skillDir, "references");
  try {
    const refFiles = await readdir(refsDir);
    for (const refFile of refFiles.sort()) {
      if (!refFile.endsWith(".md")) continue;
      const refContent = await readFile(join(refsDir, refFile), "utf-8");
      content += `\n\n---\n\n<!-- Reference: ${refFile} -->\n\n${refContent}`;
    }
  } catch {
    // No references directory — fine.
  }
  return content;
}
```

**Exact concatenation rules (memorize these):**
1. Start with the verbatim `SKILL.md` content (NO trailing transform).
2. `readdir(references)` then `.sort()` — plain lexicographic filename sort.
3. Skip any file not ending in `.md` (`if (!refFile.endsWith(".md")) continue;`).
4. For each remaining ref, append: `"\n\n---\n\n<!-- Reference: " + refFile + " -->\n\n" + refContent`.
5. The separator is literally `\n\n---\n\n<!-- Reference: <filename> -->\n\n` (two newlines, three dashes, two newlines, the HTML comment, two newlines) followed by the raw reference file content (which already ends with its own trailing newline).

Non-goal (contract line 22): "Do not modify scripts/update-all.mjs or src/cli/commands/init.ts inlining logic."

---

### `skills/bober.run/SKILL.md` (modify)

Evaluator-spawn step = **Step 3f: Spawn the Evaluator Subagent** (lines 444-533). The Agent-tool call block is lines 450-456; the prose instructing "Use the Agent tool to spawn AN evaluator subagent" begins line 446.

**Insertion point:** immediately AFTER the `### 3f. Spawn the Evaluator Subagent` heading (line 444) and BEFORE the existing `Use the **Agent tool** to spawn an evaluator subagent.` (line 446). Add a gated branch; the ENTIRE existing single-evaluator prose (lines 446-533) becomes the **else-path body, untouched**.

Current lines 444-458 (the head you wrap):
```markdown
### 3f. Spawn the Evaluator Subagent

Use the **Agent tool** to spawn an evaluator subagent.

**How to call the Agent tool:**

```
Agent tool call:
  description: "Evaluate sprint <N>: <sprint title>"
  subagent_type: bober-evaluator
  mode: auto
  prompt: <the full prompt below>
```
```

**Config is already in scope:** Step 1a (lines 72-82) reads `bober.config.json`. The branch keys on `config.evaluator.panel.enabled` and `config.evaluator.panel.lenses`.

**Imported by / generated into:** `.claude/commands/bober-run.md` (regenerate after edit). `bober.run` currently has NO `references/` dir — you create `skills/bober.run/references/`.

**Test file:** `src/orchestrator/lens-panel-parity.test.ts` (exists, extend it).

---

### `skills/bober.sprint/SKILL.md` (modify)

Evaluator-spawn step = **Step 6: Spawn the Evaluator Subagent** (lines 284-351). Agent-tool block lines 288-294.

**Insertion point:** immediately AFTER `## Step 6: Spawn the Evaluator Subagent` (line 284) and BEFORE `**Use the Agent tool to spawn the evaluator:**` (line 286). The existing prose (lines 286-346) becomes the untouched else-body.

Current lines 284-296:
```markdown
## Step 6: Spawn the Evaluator Subagent

**Use the Agent tool to spawn the evaluator:**

```
Agent tool call:
  description: "Evaluate sprint <N>: <sprint title>"
  subagent_type: bober-evaluator
  mode: auto
  prompt: <the full prompt below>
```

NOTE: The evaluator needs `mode: auto` for bash access (running tests, builds). It has no write/edit tools by agent definition.
```

`bober.sprint` reads config in its own Step 2/3 flow; reference `config.evaluator.panel` in the gate prose. Generated into `.claude/commands/bober-sprint.md`. Existing `references/`: `contract-schema.md`.

---

### `skills/bober.eval/SKILL.md` (modify)

Evaluator-spawn step = **Step 3: Spawn the Evaluator Subagent** (lines 62-179). Agent-tool block lines 66-72.

**Insertion point:** immediately AFTER `## Step 3: Spawn the Evaluator Subagent` (line 62) and BEFORE `Use the **Agent tool** to spawn an evaluator subagent.` (line 64). Existing prose (lines 64-179) becomes the untouched else-body.

Current lines 62-74:
```markdown
## Step 3: Spawn the Evaluator Subagent

Use the **Agent tool** to spawn an evaluator subagent.

```
Agent tool call:
  description: "Evaluate: <sprint title>"
  subagent_type: bober-evaluator
  mode: auto
  prompt: <the full prompt below>
```

IMPORTANT: Use `mode: auto` — the evaluator needs bash access to run tests, builds, and verification commands.
```

`bober.eval` Step 2 (lines 42-60) reads `bober.config.json` → reference `config.evaluator.panel` there. Generated into `.claude/commands/bober-eval.md`. Existing `references/`: `eval-strategies.md`, `feedback-format.md`.

---

### The gated branch to insert (same prose template for all three)

Per generatorNotes STEP 1. Insert ABOVE the existing spawn prose so the old prose is the else-body. Suggested additive block:

```markdown
**Panel mode (gated, off by default):** Read `config.evaluator.panel`. If `panel.enabled` is `true` AND `panel.lenses.length >= 2`, run the PANEL flow described in the inlined Lens Panel reference below (`<!-- Reference: lens-panel.md -->`):
- Spawn ONE bober-evaluator with **MODE:deterministic** — runs the configured strategy suite exactly once.
- Then spawn one bober-evaluator per lens with **MODE:lens:<name>** for each name in `panel.lenses`, bounded by `panel.maxConcurrent` concurrent spawns.
- Collect each lens verdict; majority-vote: `passed = passCount > failCount`, **FAIL-CLOSED on tie** (tie → false).
- Set `final.passed = deterministic.passed && reconciled.passed`.
- Save the eval-result with `evaluator: "panel"` and a `lensVerdicts: [{ lens, passed, summary }]` array.

OTHERWISE (panel disabled, or fewer than 2 lenses), spawn exactly ONE bober-evaluator with **MODE:full** exactly as described below — byte-identical to today's behaviour.
```

Then the existing single-evaluator prose follows verbatim as the else-body. NOTE for `bober.run`: its evaluator prompt template (lines 464-533) does NOT currently pass a MODE line; the off-path is implicitly MODE:full per the evaluator agent (agents/bober-evaluator.md:74 — "Applied when the spawn prompt specifies no MODE (or MODE:full)"). Keep the else-body untouched; do not retrofit a MODE line into the existing prompt (that would change off-path bytes vs the recomputed command — but since you regenerate the command from the edited SKILL, it stays consistent; the C4 concern is git-diff additivity, so keep the else-body literally unchanged).

---

## 2. Patterns to Follow

### Inline-format concatenation (THE load-bearing pattern)
**Source:** `scripts/update-all.mjs`, lines 55-71 (quoted in full in §1).
**Rule:** Replicate byte-for-byte in both (a) your hand-regeneration of the 3 commands and (b) the test recomputation. Plain `.sort()`, `.md`-only, separator `\n\n---\n\n<!-- Reference: ${refFile} -->\n\n${refContent}`.

### Drift-gate test idiom — readFile + new URL
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 1-19, 23-35.
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../../agents/bober-evaluator.md", import.meta.url),
  "utf-8",
);
const claudeCopy = await readFile(
  new URL("../../.claude/agents/bober-evaluator.md", import.meta.url),
  "utf-8",
);
expect(claudeCopy).toBe(source);
```
**Rule:** Use `new URL('../../<path>', import.meta.url)` relative to `src/orchestrator/`. The test file lives at `src/orchestrator/`, so `../../` reaches the repo root. Reference copies are at `../../skills/bober.<x>/references/lens-panel.md`; canonical at `../../skills/shared/lens-panel.md`; commands at `../../.claude/commands/bober-<x>.md`. Use `toBe` for byte-equality.

### readdir + sort + concat inside a test (recomputation helper)
**Pattern to add** (mirrors update-all.mjs exactly, using `new URL` for paths):
```ts
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function recomputeCommand(skillDir: string): Promise<string> {
  const root = new URL("../../", import.meta.url);
  let content = await readFile(new URL(`skills/${skillDir}/SKILL.md`, root), "utf-8");
  const refsDir = new URL(`skills/${skillDir}/references/`, root);
  let refFiles: string[] = [];
  try {
    refFiles = await readdir(refsDir);
  } catch {
    refFiles = [];
  }
  for (const refFile of refFiles.sort()) {
    if (!refFile.endsWith(".md")) continue;
    const refContent = await readFile(new URL(refFile, refsDir), "utf-8");
    content += `\n\n---\n\n<!-- Reference: ${refFile} -->\n\n${refContent}`;
  }
  return content;
}
```
**Rule:** `readdir` can take a URL. Append a trailing `/` to directory URLs so `new URL(refFile, refsDir)` resolves into the dir, not as a sibling. The `.sort()` + `.md` filter + separator string must match `inlineSkill` exactly.

### Evaluator MODE convention (from Sprint 2 — already in the agent)
**Source:** `agents/bober-evaluator.md`, lines 72-80.
```
### MODE:full (default)   — line 72  (no MODE specified → full behaviour, off-path byte-identical)
### MODE:deterministic    — line 76  (strategies once; qualitative criteria → "skipped")
### MODE:lens:<name>      — line 80  (qualitative judgment through one lens focus)
```
**Rule:** The branch prose references these existing modes. Do NOT re-edit the agent (non-goal contract line 19).

### Panel config schema (already exists — Sprint 1)
**Source:** `src/config/schema.ts`, lines 112-116.
```ts
panel: z.object({
  enabled: z.boolean().default(false),
  lenses: z.array(z.string()).default([]),
  maxConcurrent: z.number().int().min(1).default(4),
}).default({ enabled: false, lenses: [], maxConcurrent: 4 }),
```
**Rule:** The gate keys on `config.evaluator.panel.enabled` and `config.evaluator.panel.lenses` (length >= 2) and `panel.maxConcurrent` for fan-out bound. Default `enabled:false` guarantees off-path.

---

## 3. Sorted Reference Order (CRITICAL for regeneration)

After copying `lens-panel.md` into each `references/`, the SORTED filename order (`.sort()` lexicographic) is:

| Skill | references/ contents AFTER copy | Sorted concat order | Command |
|-------|--------------------------------|---------------------|---------|
| `bober.run` | `lens-panel.md` (new dir) | `lens-panel.md` | `.claude/commands/bober-run.md` |
| `bober.sprint` | `contract-schema.md`, `lens-panel.md` | `contract-schema.md`, **then** `lens-panel.md` | `.claude/commands/bober-sprint.md` |
| `bober.eval` | `eval-strategies.md`, `feedback-format.md`, `lens-panel.md` | `eval-strategies.md`, `feedback-format.md`, **then** `lens-panel.md` | `.claude/commands/bober-eval.md` |

(`c` < `e` < `f` < `l` confirms ordering.) Append blocks in exactly this order when regenerating each command.

---

## 4. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `inlineSkill` | `scripts/update-all.mjs:55` | `(skillDir: string) => Promise<string>` | Canonical inline-format concat. You REPLICATE its logic in the test; do not import or modify it. |
| `resolveLensFocus` | `src/orchestrator/eval-lenses.ts` (imported at `lens-panel-parity.test.ts:3`) | `(lens) => string` | Returns the canonical lens focus fragment. Already used by the existing drift test; do NOT change eval-lenses.ts (non-goal). |
| `reconcile` | `src/orchestrator/workflow/reconciler.ts` (per lens-panel.md:64) | majority-vote reducer | Pure reconciler — referenced by the protocol doc only; NOT touched this sprint (non-goal line 19). |
| `EvaluatorSectionSchema.panel` | `src/config/schema.ts:112` | Zod object | Panel config the branch keys on. Already exists (Sprint 1). |

Utilities reviewed: `src/orchestrator/`, `scripts/`, `src/config/`. No NEW utility is needed — this sprint is markdown edits + one test extension using only `node:fs/promises` (`readFile`, `readdir`) and `node:url`.

---

## 5. Prior Sprint Output

### Sprint 1 (0dc9cd8): canonical protocol + drift gate
**Created:** `skills/shared/lens-panel.md` (104 lines — the canonical protocol; embeds the 4 lens fragments verbatim). Optional `lensVerdicts` on `EvalResultSchema`. Created `src/orchestrator/lens-panel-parity.test.ts` (fragment-embed assertion, lines 9-19). Panel config schema (`src/config/schema.ts:112-116`).
**Connection:** This sprint COPIES `skills/shared/lens-panel.md` byte-identically into the three `references/` dirs (C2) and EXTENDS the test file Sprint 1 created (C5).

### Sprint 2 (0736260): evaluator agent MODE support + agent-copy gate
**Modified:** `agents/bober-evaluator.md` (added MODE:full | deterministic | lens:<name>, lines 72-80). Synced `.claude/agents/bober-evaluator.md`. Added the agent-copy sync gate to `lens-panel-parity.test.ts` (lines 23-35).
**Connection:** The branch prose you insert references these MODE strings. Do NOT edit the agent again (non-goal). NOTE: Sprint 2 is the cause of the pre-existing `update-all:check` drift against EXTERNAL projects — irrelevant to your in-repo gate.

---

## 6. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere; `.js` specifiers.** The test already imports `./eval-lenses.js` (line 3). New imports use `node:fs/promises`, `node:url`.
- **No synchronous fs.** Use `readFile`/`readdir` from `node:fs/promises` (line 42). The test already does.
- **No test mocks for filesystem (line 44).** Read the REAL files via `new URL` — exactly the existing idiom. Do NOT mock fs.
- **Unicode section headers** `// -- Section Name ------` (line 32). The existing test uses `// ── ... ──` box-drawing headers (lines 5, 21) — follow that style for new describe-block sections.
- **`consistent-type-imports`** (line 35) — if you import any types, use `import type`. (You likely need none; `readdir`/`readFile` are values.)
- **Conventional commit:** `bober(sprint-3): wire run/sprint/eval panel branch + per-skill reference copies + regenerate commands`.

### Architecture Decisions
`reconciler.ts` is a pure function (ADR-4, per lens-panel.md:77 — timestamp echoed verbatim). Not edited here. No other ADR directly governs this markdown-wiring sprint.

### Other Docs
`scripts/update-all.mjs` header comment (lines 1-25) documents that the inline format MUST match `src/cli/commands/init.ts:installClaudeCommands` byte-for-byte. That coupling is why the test recomputation is authoritative.

---

## 7. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/lens-panel-parity.test.ts` (full file, lines 1-35).
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

describe("bober-evaluator.md agent-copy sync gate", () => {
  it("keeps agents/ and .claude/agents/ copies byte-identical", async () => {
    const source = await readFile(
      new URL("../../agents/bober-evaluator.md", import.meta.url),
      "utf-8",
    );
    const claudeCopy = await readFile(
      new URL("../../.claude/agents/bober-evaluator.md", import.meta.url),
      "utf-8",
    );
    expect(claudeCopy).toBe(source);
  });
});
```
**Runner:** vitest. **Assertion:** `expect(...).toBe(...)` for byte-equality. **Mock approach:** NONE — read real files (principles line 44). **File naming:** `*.test.ts` collocated. **Location:** `src/orchestrator/` (this file already exists; EXTEND it, don't create new).

### What to ADD to the test (C5):
1. **Reference-copy equality (3 assertions):** for each of `bober.run`, `bober.sprint`, `bober.eval`, assert
   `readFile(new URL('../../skills/bober.<x>/references/lens-panel.md', import.meta.url))` `.toBe(` canonical `readFile(new URL('../../skills/shared/lens-panel.md', import.meta.url))` `)`.
2. **Command recomputation equality (3 assertions):** for each `<x>`, `expect(await recomputeCommand('bober.<x>')).toBe(await readFile(new URL('../../.claude/commands/bober-<x>.md', import.meta.url), 'utf-8'))` using the `recomputeCommand` helper from §2.

Add these as new `describe` blocks with the existing `// ──` header style. Keep the two existing describe blocks intact.

### E2E Test Pattern
Not applicable — no Playwright for this sprint.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `.claude/commands/bober-{run,sprint,eval}.md` | their SKILL.md + references | high | Must be regenerated byte-identically to the recomputed inline, else the new test fails. |
| `src/orchestrator/lens-panel-parity.test.ts` | the 3 SKILL.md, 3 reference copies, 3 commands, `skills/shared/lens-panel.md` | high | New assertions must all pass; helper must mirror inlineSkill exactly. |
| EXTERNAL sync targets (`scripts/sync-targets.json`) | `update-all.mjs` | n/a | NOT your gate — ignore `update-all:check` drift. |

### Existing Tests That Must Still Pass
- `src/orchestrator/lens-panel-parity.test.ts` — its existing two describe blocks (fragment-embed at lines 9-19, agent-copy sync at lines 23-35) MUST still pass; your edits are additive new describe blocks.
- Full `npx vitest run` — must stay green. Tolerate ONLY the documented pre-existing skipped baseline (do not introduce new skips/failures).

### Features That Could Be Affected
- **Off-by-default guarantee (C4):** the panel branch is gated; with `panel.enabled:false` (schema default) the regenerated prose drives exactly one MODE:full evaluator. Verify via `git diff` that the existing single-evaluator else-body prose is character-for-character intact in all three SKILL.md files.
- **Sprint 2 evaluator MODE:** the branch references MODE:deterministic / MODE:lens — already implemented; do not re-touch.

### Recommended Regression Checks (run after implementation)
1. `npx vitest run src/orchestrator/lens-panel-parity.test.ts` — all assertions (old + 6 new) green.
2. `npx vitest run` — full suite green (only pre-existing skipped baseline).
3. `npx tsc --noEmit` — exit 0.
4. `npm run build` — exit 0.
5. `npx eslint src/` — exit 0.
6. `git diff skills/bober.run/SKILL.md skills/bober.sprint/SKILL.md skills/bober.eval/SKILL.md` — confirm additive-only (old spawn prose unchanged).
7. `diff skills/shared/lens-panel.md skills/bober.run/references/lens-panel.md` (and sprint/eval) — zero diff.
8. (Informational only, NOT a gate) `npm run update-all:check` may still report external drift — ignore it.

---

## 9. Implementation Sequence

1. **Edit `skills/bober.run/SKILL.md`** — insert the gated panel branch right after the `### 3f.` heading (line 444), before line 446. Else-body = existing lines 446-533 untouched.
   - Verify: `git diff` shows only the added block; old prose intact.
2. **Edit `skills/bober.sprint/SKILL.md`** — insert after `## Step 6` heading (line 284), before line 286.
   - Verify: additive diff.
3. **Edit `skills/bober.eval/SKILL.md`** — insert after `## Step 3` heading (line 62), before line 64.
   - Verify: additive diff.
4. **Copy reference into all three** — `cp skills/shared/lens-panel.md skills/bober.run/references/lens-panel.md` (mkdir `skills/bober.run/references/` first), and to `skills/bober.sprint/references/lens-panel.md`, `skills/bober.eval/references/lens-panel.md`. Verbatim, no edits.
   - Verify: `diff` against canonical = empty for all three.
5. **Regenerate `.claude/commands/bober-run.md`** — SKILL.md content + `\n\n---\n\n<!-- Reference: lens-panel.md -->\n\n` + lens-panel.md content. (Cleanest: write a one-off node snippet replicating inlineSkill, OR copy update-all.mjs's loop. Do NOT modify update-all.mjs.)
   - Verify: command contains the inlined `<!-- Reference: lens-panel.md -->` block AND the panel branch prose.
6. **Regenerate `.claude/commands/bober-sprint.md`** — SKILL.md + (sorted) `contract-schema.md` block + `lens-panel.md` block.
   - Verify: both reference blocks present, in that order.
7. **Regenerate `.claude/commands/bober-eval.md`** — SKILL.md + `eval-strategies.md` + `feedback-format.md` + `lens-panel.md` blocks (sorted order).
   - Verify: all three reference blocks present, in that order.
8. **Extend `src/orchestrator/lens-panel-parity.test.ts`** — add the `recomputeCommand` helper + two new describe blocks (reference-copy equality, command recomputation equality). 6 new assertions total.
   - Verify: helper mirrors inlineSkill byte-for-byte.
9. **Run full verification** — `npx vitest run` (all green), `npx tsc --noEmit`, `npm run build`, `npx eslint src/` (all exit 0).
10. **Commit** — stage ONLY the 10 files explicitly (6 sources + 3 commands + 1 test). NEVER `git add -A`. Message: `bober(sprint-3): wire run/sprint/eval panel branch + per-skill reference copies + regenerate commands`. On the feature branch, never main.

---

## 10. Pitfalls & Warnings

- **The gate is the in-repo vitest test, NOT `update-all:check`.** `update-all:check` syncs EXTERNAL projects and ALREADY shows pre-existing Sprint-2 drift. Running it is informational only; do not chase it green, and do not edit `update-all.mjs` (non-goal).
- **All 3 commands are currently IN SYNC** (verified: 28192/29724/30898 bytes). After your edits the in-repo test must remain green — so regenerate the commands precisely.
- **Byte-exact separator.** The separator is `\n\n---\n\n<!-- Reference: <file> -->\n\n` then the raw file content. The reference files end with their own trailing newline — do NOT add or strip one. Do NOT trim/normalize SKILL.md content.
- **Sorted order matters** for bober.sprint (`contract-schema.md` before `lens-panel.md`) and bober.eval (`eval-strategies.md`, `feedback-format.md`, `lens-panel.md`). Wrong order = test fails.
- **Else-body must be byte-identical** to today's spawn prose for the off-path (C4). Do NOT reword the existing single-evaluator instructions; only PREPEND the gated branch.
- **Do not edit** `agents/bober-evaluator.md`, `src/orchestrator/eval-lenses.ts`, `reconciler.ts`, `eval-result.ts`, schemas, or `update-all.mjs` (non-goals lines 18-23).
- **`.gitignore`-tracked artifacts may already be dirty** from unrelated work — stage only your 10 files with explicit paths.
- **Test path math:** the test lives in `src/orchestrator/`, so `../../` reaches repo root. Directory URLs need a trailing `/` for `new URL(file, dir)` to resolve inside them.
- **No fs mocks** (principles line 44) — read real files via `new URL` + `node:fs/promises`, exactly as the existing test does.
- **`mkdir` for bober.run/references/** — it does not exist yet; create it before copying.
