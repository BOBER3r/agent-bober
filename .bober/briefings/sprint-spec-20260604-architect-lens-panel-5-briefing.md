# Sprint Briefing: Wire native architect CP2+CP5, copy reference, regenerate command, extend drift gate

**Contract:** sprint-spec-20260604-architect-lens-panel-5
**Generated:** 2026-06-04T00:00:00Z

---

## 0. Sprint At A Glance

Four files, all in scope (do NOT touch anything else):

1. `skills/bober.architect/SKILL.md` (modify) — add additive gated panel branch to CP2 (Step 6) and CP5 (Step 9).
2. `skills/bober.architect/references/arch-lens-panel.md` (create) — byte-copy of `skills/shared/arch-lens-panel.md`.
3. `.claude/commands/bober-architect.md` (regenerate) — recompute = SKILL.md + sorted references inline.
4. `src/orchestrator/arch-lens-panel-parity.test.ts` (modify) — add reference-copy + command-recompute gates.

**Off-by-default invariant:** the existing single-subagent spawn prose at CP2/CP5 stays untouched as the `else` body. New text is purely additive and gated behind `config.architect.panel.enabled && panel.lenses.length >= 2`.

**CRITICAL — the authoritative gate is in-repo vitest recomputation (C3/C5), NOT `npm run update-all:check`.** `update-all:check` targets EXTERNAL sync projects and already shows pre-existing drift — do not use it to judge success.

---

## 1. Target Files

### skills/bober.architect/SKILL.md (modify)

This file is **exactly 12224 bytes** and is currently byte-in-sync with `.claude/commands/bober-architect.md` (also 12224 bytes — no references/ dir exists yet, so the command == SKILL.md verbatim).

#### CP2 spawn step — Step 6 (lines 107-166)

The CP2 spawn step opens at line 107 and the user-review prompt ends at line 166:

```
## Step 6: Checkpoint 2 — Approach Selection                           # line 107

Spawn a subagent with the approved Problem Statement included:          # line 109

```
You are the Bober Architect agent running Checkpoint 2: Approach Selection.   # lines 111-147 (fenced spawn prompt)
...
```

Present the approaches to the user:                                     # line 149
... (user review block, lines 151-164) ...
Wait for user response. Handle (B)/(C) by respawning with feedback.     # line 166
```

**RECOMMENDED INSERTION POINT (CP2):** insert the gated branch **between line 108 (blank) and line 109 ("Spawn a subagent with the approved Problem Statement included:")** — i.e. immediately after the `## Step 6` heading, BEFORE the existing spawn prose. The existing spawn prompt (lines 109-147) and review block become the untouched `else` path. Mirror the bober.run idiom (see §2).

#### CP5 spawn step — Step 9 (lines 296-374)

```
## Step 9: Checkpoint 5 — Final Assembly                                # line 296

Spawn a subagent to compile the complete architecture document:         # line 298

```
You are the Bober Architect agent running Checkpoint 5: Final Assembly. # lines 300-372 (fenced spawn prompt)
...
```

Wait for the subagent to complete.                                      # line 374
```

**RECOMMENDED INSERTION POINT (CP5):** insert the gated branch **between line 297 (blank) and line 298 ("Spawn a subagent to compile the complete architecture document:")** — immediately after the `## Step 9` heading, BEFORE the existing spawn prose. The existing CP5 spawn prompt (lines 298-372) becomes the untouched `else` path.

**Imports this file uses:** none (Markdown skill). It is the coordinator; it references `agents/bober-architect.md` (read at Step 4, line 39) and `bober.config.json` (Step 1, line 22).

**Imported by:** nothing imports it. It is INLINED into `.claude/commands/bober-architect.md` by `scripts/update-all.mjs:inlineSkill` and by `src/cli/commands/init.ts` (same format).

**Test file:** `src/orchestrator/arch-lens-panel-parity.test.ts` (exists — extend it).

---

### skills/bober.architect/references/arch-lens-panel.md (create)

**Directory pattern:** `skills/bober.architect/references/` does NOT exist yet. The generator creates it. The native lens-panel sprint established the convention: each panel-enabled skill keeps a per-skill copy of the shared reference at `skills/<skill>/references/<ref>.md`, byte-identical to the canonical in `skills/shared/`. See existing copies e.g. `skills/bober.run/references/lens-panel.md`.

**Most similar existing file:** `skills/bober.run/references/lens-panel.md` (a byte-copy of `skills/shared/lens-panel.md`).

**Content:** byte-identical copy of `skills/shared/arch-lens-panel.md` (5433 bytes). Use `cp` or read-and-write verbatim. After this is the ONLY .md in references/, the sorted reference list is just `[arch-lens-panel.md]`.

---

### .claude/commands/bober-architect.md (regenerate)

**Do NOT hand-edit.** Regenerate from SKILL.md + sorted references using the EXACT `inlineSkill` format (§3). After this sprint it becomes: `<new SKILL.md content>` + `"\n\n---\n\n<!-- Reference: arch-lens-panel.md -->\n\n"` + `<arch-lens-panel.md content>`.

Practical regeneration approach (matches the test recompute exactly):
```
node -e 'const fs=require("fs");const p="skills/bober.architect/";let c=fs.readFileSync(p+"SKILL.md","utf8");const r=fs.readdirSync(p+"references").filter(f=>f.endsWith(".md")).sort();for(const f of r){c+=`\n\n---\n\n<!-- Reference: ${f} -->\n\n`+fs.readFileSync(p+"references/"+f,"utf8");}fs.writeFileSync(".claude/commands/bober-architect.md",c);'
```
(Run from project root. This byte-for-byte matches `inlineSkill` and the test's `recomputeCommand`.)

---

### src/orchestrator/arch-lens-panel-parity.test.ts (modify)

Current structure (43 lines) has TWO describe blocks:
- `"arch-lens-panel.md drift gate"` — fragment-embedding (lines 16-26)
- `"bober-architect.md agent-copy sync gate"` — agents/ vs .claude/agents/ byte-equality (lines 30-42)

**Test file:** this IS the test (Sprint 4's gate). Extend it with two NEW describe blocks (§6).

---

## 2. Patterns to Follow

### Pattern A — Gated additive panel branch in a SKILL.md spawn step
**Source:** `skills/bober.run/SKILL.md`, lines 446-453
```
**Panel mode (gated, off by default):** Read `config.evaluator.panel`. If `panel.enabled` is `true` AND `panel.lenses.length >= 2`, run the PANEL flow described in the inlined Lens Panel reference below (`<!-- Reference: lens-panel.md -->`):
- Spawn ONE bober-evaluator with **MODE:deterministic** ...
- Then spawn one bober-evaluator per lens with **MODE:lens:<name>** for each name in `panel.lenses`, bounded by `panel.maxConcurrent` concurrent spawns.
- Collect each lens verdict; majority-vote: `passed = passCount > failCount`, **FAIL-CLOSED on tie** (tie → false).
- Save the eval-result with `evaluator: "panel"` and a `lensVerdicts: [{ lens, passed, summary }]` array.

OTHERWISE (panel disabled, or fewer than 2 lenses), spawn exactly ONE bober-evaluator with **MODE:full** exactly as described below — byte-identical to today's behaviour.
```
**Rule:** Lead with a `**Panel mode (gated, off by default):**` paragraph that reads `config.architect.panel`, gates on `panel.enabled && panel.lenses.length >= 2`, references the inlined reference by its `<!-- Reference: arch-lens-panel.md -->` marker, then closes with an `OTHERWISE` sentence pointing at the untouched existing spawn prose. ADD this BEFORE the existing prose; do not delete or reword the existing prose.

### Pattern B — recomputeCommand helper (the exact idiom to mirror)
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 39-55
```ts
async function recomputeCommand(skillDir: string): Promise<string> {
  const root = new URL("../../", import.meta.url);
  let content = await readFile(new URL(`skills/${skillDir}/SKILL.md`, root), "utf-8");
  const refsDir = new URL(`skills/${skillDir}/references/`, root);
  let refFiles: string[];
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
**Rule:** Copy this helper VERBATIM into `arch-lens-panel-parity.test.ts` (add `readdir` to the `node:fs/promises` import on line 2). It is byte-identical to `update-all.mjs:inlineSkill`, so the recompute matches the command.

### Pattern C — Reference-copy parity gate
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 57-73 (per-skill copy parity) and 77-94 (command recomputation parity)
```ts
describe("per-skill lens-panel.md reference copy parity", () => {
  const SKILL_DIRS = ["bober.run", "bober.sprint", "bober.eval"] as const;
  for (const skillDir of SKILL_DIRS) {
    it(`skills/${skillDir}/references/lens-panel.md is byte-identical to skills/shared/lens-panel.md`, async () => {
      const canonical = await readFile(new URL("../../skills/shared/lens-panel.md", import.meta.url), "utf-8");
      const copy = await readFile(new URL(`../../skills/${skillDir}/references/lens-panel.md`, import.meta.url), "utf-8");
      expect(copy).toBe(canonical);
    });
  }
});
```
**Rule:** Mirror this for the architect: canonical = `skills/shared/arch-lens-panel.md`, copy = `skills/bober.architect/references/arch-lens-panel.md`, command = `.claude/commands/bober-architect.md`.

### Pattern D — MODE directives the panel branch must reference
**Source:** `agents/bober-architect.md`, lines 62-80
- `MODE:lens-score:<name>` (lines 62-70): CP2 scoring mode; emits `{ "lens", "scores": [{ "approach", "score": 0-100, "rationale" }] }`.
- `MODE:lens-review:<name>` (lines 72-80): CP5 review mode; emits `{ "lens", "passed": bool, "summary" }`.
- `MODE:full` (lines 58-60): the off-path default.
**Rule:** The CP2 branch spawns `bober-architect` subagents in `MODE:lens-score:<name>`; the CP5 branch in `MODE:lens-review:<name>`. These MODEs already exist in the agent (Sprint 4) — just reference them.

### Pattern E — Section comments / box-drawing headers in tests
**Source:** `src/orchestrator/arch-lens-panel-parity.test.ts`, lines 5, 28
```ts
// ── Arch-lens-panel drift gate ─────────────────────────────────────
// ── Architect agent copy sync gate ────────────────────────────────
```
**Rule:** New describe blocks get their own `// ── ... ──` header comment, matching `.bober/principles.md` line 32 convention.

---

## 3. The inlineSkill Format — Byte-Exact Contract

**Source:** `scripts/update-all.mjs`, lines 55-71
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
**The exact concatenation:** `<SKILL.md content>` then, for each `references/*.md` in `.sort()` (lexical filename) order: the literal `"\n\n---\n\n<!-- Reference: " + refFile + " -->\n\n" + refContent`. With one reference, the command = SKILL.md + `"\n\n---\n\n<!-- Reference: arch-lens-panel.md -->\n\n"` + `<arch-lens-panel.md content>`. **Do NOT modify update-all.mjs (non-goal).** Replicate this format in the regenerated command and in `recomputeCommand`.

---

## 4. Prior Sprint Output

### Sprint 1: synthesize()/arch-lenses/config
**Created/owns:** `src/orchestrator/arch-lenses.ts` (`resolveArchLensFocus`, `ARCH_LENS_CATALOG`), `src/orchestrator/synthesizer.ts` (`synthesize()`), config `architect.panel` block.
**Connection:** the CP2 branch references `synthesize()` for ranking; the reference doc (§ "CP2 Synthesis Panel") describes it. The config gate reads `config.architect.panel` — schema at `src/config/schema.ts:122-128` (`ArchitectSectionSchema`: `panel: { enabled, lenses: string[], maxConcurrent }`).

### Sprint 2-3: TS CP2 + TS CP5 (architect-agent.ts)
**Connection:** OUT OF SCOPE — do NOT touch `architect-agent.ts`, `arch-lenses.ts`, `synthesizer.ts`, `reconciler.ts`. This sprint is the SKILL/command/test wiring only.

### Sprint 4 (a77625a): canonical reference + agent MODE section + Sprint-4 gate
**Created:** `skills/shared/arch-lens-panel.md` (5433 bytes — canonical protocol, 6 lens fragments, CP2 synthesize + CP5 reconcile docs), `agents/bober-architect.md` MODE section (`MODE:full|lens-score:<name>|lens-review:<name>`, lines 56-80), `src/orchestrator/arch-lens-panel-parity.test.ts` (fragment-embedding + agent-copy gates).
**Connection:** this sprint copies the Sprint-4 canonical reference into the skill's references/, inlines it into the command, references the Sprint-4 MODE directives in the new panel branches, and EXTENDS the Sprint-4 test file.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** (line 27): all imports use `.js` extensions (NodeNext). The test already imports `./arch-lenses.js` (line 3).
- **Use `type` imports** (line 35): `consistent-type-imports` enforced. (The recompute helper imports values only — `readFile`, `readdir` — no type import needed.)
- **Tests collocated** (line 20): `*.test.ts` next to source; tests run against the real project (this test reads real skill/command files via `new URL(..., import.meta.url)`).
- **Section comments** (line 32): `// ── Section Name ──` box-drawing headers.
- **Conventional commits** (line 34): sprint commits use `bober(sprint-N): description`. This sprint: `bober(sprint-5): wire native architect CP2+CP5 panel + reference copy + regenerate command`.

### Architecture Decisions
No architect-panel-specific ADR found in `.bober/architecture/` relevant to this MD/test wiring. The canonical protocol doc `skills/shared/arch-lens-panel.md` is the de-facto spec.

### CP2/CP5 protocol (`skills/shared/arch-lens-panel.md`)
- **CP2 Synthesis Panel** (lines 57-73): generate 2-3 candidates → one scorer subagent per lens (bounded by `maxConcurrent`) scoring via the lens focus fragment → `synthesize()` produces ranked winner + dissent.
- **CP5 Reconcile Panel** (lines 75-97): one reviewer per lens → PASS/FAIL → `reconcile()` strict majority `passCount > failCount`, **fail-closed on tie**, `evaluator = "panel"`.
- **lensVerdicts shape** (lines 99-113): `Array<{ lens: string; passed: boolean; summary: string }>` — optional, backward-compatible.

---

## 6. Testing Patterns

### Unit Test Pattern (extend the existing gate)
**Source:** `src/orchestrator/arch-lens-panel-parity.test.ts` (current, 43 lines) + `src/orchestrator/lens-panel-parity.test.ts` (template for new blocks)

**Runner:** vitest. **Assertion style:** `expect(x).toBe(y)` / `expect(x).toContain(y)`. **Mock approach:** none — reads real files via `node:fs/promises` + `new URL(..., import.meta.url)`. **File naming:** `*.test.ts` collocated in `src/orchestrator/`. **Location:** co-located.

**What to add to `arch-lens-panel-parity.test.ts`:**
1. Add `readdir` to the import on line 2: `import { readFile, readdir } from "node:fs/promises";`
2. Add the `recomputeCommand` helper VERBATIM from Pattern B (it can be hardcoded to `"bober.architect"` or kept generic — generic mirrors the template best).
3. Add describe block (a) — reference-copy parity:
```ts
// ── Per-skill reference copy parity gate ───────────────────────────
describe("bober.architect references/arch-lens-panel.md reference copy parity", () => {
  it("skills/bober.architect/references/arch-lens-panel.md is byte-identical to skills/shared/arch-lens-panel.md", async () => {
    const canonical = await readFile(new URL("../../skills/shared/arch-lens-panel.md", import.meta.url), "utf-8");
    const copy = await readFile(new URL("../../skills/bober.architect/references/arch-lens-panel.md", import.meta.url), "utf-8");
    expect(copy).toBe(canonical);
  });
});
```
4. Add describe block (b) — command recomputation parity:
```ts
// ── Command recomputation parity gate ──────────────────────────────
describe("bober-architect.md command recomputation parity", () => {
  it(".claude/commands/bober-architect.md equals recomputed inline of skills/bober.architect", async () => {
    const recomputed = await recomputeCommand("bober.architect");
    const committed = await readFile(new URL("../../.claude/commands/bober-architect.md", import.meta.url), "utf-8");
    expect(committed).toBe(recomputed);
  });
});
```

### E2E Test Pattern
Not applicable — this is a CLI/library repo with no Playwright. (`.bober/principles.md` line 48: "N/A — no user interface.")

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `.claude/commands/bober-architect.md` | `skills/bober.architect/SKILL.md` + references/ | high | MUST be regenerated after editing SKILL.md or the recompute test fails (C3/C5). |
| `src/orchestrator/arch-lens-panel-parity.test.ts` | `skills/shared/arch-lens-panel.md`, `skills/bober.architect/references/arch-lens-panel.md`, `.claude/commands/bober-architect.md` | high | New gates assert byte-equality; a stale command or non-verbatim copy fails. |
| External sync targets (`sync-targets.json`) | inlined commands | low | `update-all:check` shows PRE-EXISTING drift; NOT this sprint's gate — ignore. |

### Existing Tests That Must Still Pass
- `src/orchestrator/arch-lens-panel-parity.test.ts` — the two existing describe blocks (fragment-embedding lines 16-26, agent-copy lines 30-42) must still pass; do NOT alter them, only append.
- `src/orchestrator/lens-panel-parity.test.ts` — the analogous native lens-panel gate (do not touch; just don't break the shared `skills/shared/` files).
- Full vitest suite — tolerate ONLY the documented pre-existing skipped baseline; no new failures.

### Features That Could Be Affected
- **Native lens-panel (bober.run/sprint/eval)** — shares the `skills/shared/` directory and the per-skill-reference-copy + recompute convention. Do not modify `skills/shared/lens-panel.md` or the run/sprint/eval skills.
- **TS architect panel (sprints 2-3)** — shares `arch-lenses.ts`/`synthesizer.ts`/`reconciler.ts`. OUT OF SCOPE — do not touch.

### Recommended Regression Checks
1. `npx tsc --noEmit` (exit 0).
2. `npm run build` (exit 0).
3. `npx eslint src/` (exit 0).
4. `npx vitest run src/orchestrator/arch-lens-panel-parity.test.ts` — all 4 describe blocks green.
5. `npx vitest run` — full suite green except the documented pre-existing skipped baseline.
6. `git diff skills/bober.architect/SKILL.md` — confirm CP2/CP5 changes are purely ADDITIVE (existing spawn prose intact).
7. `diff skills/shared/arch-lens-panel.md skills/bober.architect/references/arch-lens-panel.md` — zero output (byte-identical).
8. Do NOT rely on `npm run update-all:check` — it targets external projects and shows pre-existing drift.

---

## 8. Implementation Sequence

1. **skills/bober.architect/references/arch-lens-panel.md** — `cp skills/shared/arch-lens-panel.md skills/bober.architect/references/arch-lens-panel.md` (creates the references/ dir + the byte-copy).
   - Verify: `diff` against the canonical returns nothing.
2. **skills/bober.architect/SKILL.md** — insert the CP2 gated branch after `## Step 6` heading (before line 109) and the CP5 gated branch after `## Step 9` heading (before line 298). Both purely additive; existing spawn prose becomes the `else` path. Reference `<!-- Reference: arch-lens-panel.md -->`, `config.architect.panel`, `MODE:lens-score:<name>` (CP2), `MODE:lens-review:<name>` (CP5).
   - Verify: `git diff` shows only additions around Step 6 and Step 9; the fenced spawn prompts are unchanged.
3. **.claude/commands/bober-architect.md** — regenerate via the inlineSkill format (the node one-liner in §1 or equivalent). Output = new SKILL.md + `"\n\n---\n\n<!-- Reference: arch-lens-panel.md -->\n\n"` + reference content.
   - Verify: file contains the `<!-- Reference: arch-lens-panel.md -->` marker and the CP2/CP5 branches.
4. **src/orchestrator/arch-lens-panel-parity.test.ts** — add `readdir` to the import, add the `recomputeCommand` helper (Pattern B, verbatim), add the two new describe blocks (§6).
   - Verify: `npx vitest run src/orchestrator/arch-lens-panel-parity.test.ts` → 4 describe blocks pass.
5. **Run full verification** — `npx tsc --noEmit` && `npm run build` && `npx eslint src/` && `npx vitest run` (all green; tolerate only pre-existing skipped baseline).

---

## 9. Pitfalls & Warnings

- **Regenerate AFTER editing SKILL.md, not before.** The command is derived; edit SKILL.md → copy reference → THEN regenerate. The recompute test compares the committed command to the live recompute — order matters.
- **Byte-exact concatenation.** The trailing format is `"\n\n---\n\n<!-- Reference: arch-lens-panel.md -->\n\n"` — two newlines, `---`, two newlines, the HTML comment, two newlines, content. No trailing/leading whitespace tweaks. Use the same readFile (utf-8) round-trip the test uses.
- **`update-all:check` is a FALSE gate here.** It targets external sync projects (`sync-targets.json`) and already shows pre-existing drift. The authoritative gate is the in-repo vitest recompute (C3/C5). Do not "fix" external drift.
- **Do NOT touch `scripts/update-all.mjs` or `src/cli/commands/init.ts`** (non-goal) — only replicate their format.
- **Do NOT touch TS modules** — `architect-agent.ts`, `arch-lenses.ts`, `synthesizer.ts`, `reconciler.ts` are out of scope.
- **Do NOT touch `skills/shared/arch-lens-panel.md`** — it is canonical (Sprint 4). You copy FROM it, never edit it.
- **Additive-only at CP2/CP5.** The existing single-subagent spawn prompts (SKILL.md lines 109-147 and 298-372) and the user-review blocks must remain byte-identical. The gate C4 is verified by git diff being additive.
- **`consistent-type-imports`:** the test imports only runtime values (`readFile`, `readdir`, vitest `describe/it/expect`, `resolveArchLensFocus`) — no `import type` needed; do not add one unnecessarily.
- **ESM `.js` extension:** keep `from "./arch-lenses.js"` (line 3) — do not strip the extension.
- **The byte-count note (12180) in the orchestrator prompt is stale:** the file is actually 12224 bytes and currently in sync. Trust the recompute test, not the byte count.
