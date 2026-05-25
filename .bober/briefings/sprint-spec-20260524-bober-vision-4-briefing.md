# Sprint Briefing: Anti-pattern reference catalog + evaluator integration

**Contract:** sprint-spec-20260524-bober-vision-4
**Generated:** 2026-05-25T00:00:00Z

---

## 1. Sprint Summary

Port four MIT-licensed anti-pattern reference docs from `obra/superpowers` into a new `.bober/anti-patterns/` directory verbatim (with attribution headers), create a `README.md` index, and modify `agents/bober-evaluator.md` to instruct the evaluator to cite anti-pattern names from this catalog inside the existing `regressions` field of `EvalResult` when a regression matches a documented anti-pattern. The catalog directory does not yet exist; the evaluator change is small and additive (a new subsection inside the existing regressions step), with strict orders not to touch Sprint 3's Iron Law block at lines 70–80. All four sources are on disk in `/tmp/superpowers/skills/`; no skill cross-references to other superpowers files exist inside the four sources, so no adaptation of inline `superpowers:foo` references is needed (only the attribution header is mandatory).

---

## 2. Source Files

| File | Source path | Lines | Min in contract | Named anti-patterns / sections inside |
|------|------------|-------|------------------|----------------------------------------|
| `testing-anti-patterns.md` | `/tmp/superpowers/skills/test-driven-development/testing-anti-patterns.md` | **299** | 80 | The Iron Laws; Anti-Pattern 1: Testing Mock Behavior; Anti-Pattern 2: Test-Only Methods in Production; Anti-Pattern 3: Mocking Without Understanding; Anti-Pattern 4: Incomplete Mocks; Anti-Pattern 5: Integration Tests as Afterthought; When Mocks Become Too Complex; TDD Prevents These Anti-Patterns; Quick Reference table; Red Flags; The Bottom Line |
| `condition-based-waiting.md` | `/tmp/superpowers/skills/systematic-debugging/condition-based-waiting.md` | **115** | 60 | Overview; When to Use (with `dot` graph); Core Pattern; Quick Patterns table; Implementation (generic `waitFor` polling fn); Common Mistakes; When Arbitrary Timeout IS Correct; Real-World Impact |
| `root-cause-tracing.md` | `/tmp/superpowers/skills/systematic-debugging/root-cause-tracing.md` | **169** | 60 | Overview; When to Use (`dot`); The Tracing Process (5 numbered steps); Adding Stack Traces; Finding Which Test Causes Pollution; Real Example: Empty projectDir; Key Principle (`dot`); Stack Trace Tips; Real-World Impact |
| `defense-in-depth.md` | `/tmp/superpowers/skills/systematic-debugging/defense-in-depth.md` | **122** | 40 | Overview; Why Multiple Layers; The Four Layers (Entry Point, Business Logic, Environment Guards, Debug Instrumentation); Applying the Pattern; Example from Session; Key Insight |

**Cross-references to other superpowers skills inside these four sources:** **NONE.** A grep for `skills/` and `superpowers:` against all four source files returned zero matches. The only inter-doc reference is `root-cause-tracing.md` mentions "BETTER: Also add defense-in-depth" inside its `dot` graph — that's a free-text reference to a sibling file we are *also* porting, so it stays as-is (no link to rewrite).

**External file references that should be lightly noted (not deleted, but the file lives only in superpowers' repo):**
- `condition-based-waiting.md` line 82: *"See `condition-based-waiting-example.ts` in this directory for complete implementation..."* — the example file is NOT being ported. Leave the sentence verbatim per the "Do NOT rewrite empirical content" rule; the attribution header already tells the reader where the original repo lives.
- `root-cause-tracing.md` line 104: *"Use the bisection script `find-polluter.sh` in this directory"* — same situation. Leave verbatim.

These are NOT skill cross-references (no superpowers-only skill names), so no adaptation needed per `generatorNotes`. The attribution header makes the source repo discoverable.

---

## 3. Existing Attribution Convention (Tier 0 authoritative form)

The Tier 0 ports (`bober.verify`, `bober.debug`) use this **exact** three-line blockquote, placed immediately after the YAML frontmatter (if any) and before the first `#` heading:

**From `skills/bober.verify/SKILL.md` lines 6–8:**
```
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/verification-before-completion/SKILL.md.
> Adaptations: skill name (bober.verify), tool name references where bober has equivalents.
```

**From `skills/bober.debug/SKILL.md` lines 6–8:**
```
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/systematic-debugging/SKILL.md.
> Adaptations: skill name (bober.debug), tool name references where bober has equivalents.
```

**Rules distilled from Tier 0:**
1. Em-dash (`—`, U+2014), not hyphen, between "obra/superpowers" link and "MIT License."
2. Period after "MIT License", after the `Original:` filename, and after the `Adaptations:` sentence.
3. `Original:` line uses `skills/<dir>/<file>.md` form (relative to superpowers repo root).
4. `Adaptations:` line is REQUIRED. If no adaptations were made (which is the case for these four reference docs that have no skill name and live in `.bober/anti-patterns/`, not `skills/`), use: `> Adaptations: none (reference doc, not a skill).`
5. The attribution block goes at the very top of the file (above the `# Title`). The four anti-pattern docs have NO YAML frontmatter (they're reference docs, not skills), so the attribution block is literally line 1.

**Contract's `generatorNotes` template differs slightly** — it shows a two-line header without the `Adaptations:` line. The Tier 0 three-line form is authoritative; use it.

**Recommended attribution headers (paste verbatim at top of each ported file):**

`.bober/anti-patterns/testing-anti-patterns.md`:
```
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/test-driven-development/testing-anti-patterns.md.
> Adaptations: none (reference doc, not a skill).

```

`.bober/anti-patterns/condition-based-waiting.md`:
```
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/systematic-debugging/condition-based-waiting.md.
> Adaptations: none (reference doc, not a skill).

```

`.bober/anti-patterns/root-cause-tracing.md`:
```
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/systematic-debugging/root-cause-tracing.md.
> Adaptations: none (reference doc, not a skill).

```

`.bober/anti-patterns/defense-in-depth.md`:
```
> Verbatim port from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/systematic-debugging/defense-in-depth.md.
> Adaptations: none (reference doc, not a skill).

```

(Blank line after the third `>` line, then the original `# Title` heading from the source file.)

**README.md attribution block** (top of file, before the index table) — adapted from the same convention:
```
> Anti-pattern reference catalog. All four docs in this directory are verbatim ports from
> [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> See each file for its individual `Original:` path.
```

---

## 4. EvalResult Schema Today

**Defined in:** `/Users/bober4ik/agent-bober/src/contracts/eval-result.ts`

**Current shape of `regressions` field** (`eval-result.ts` lines 32–37 and 72):
```typescript
export const RegressionSchema = z.object({
  description: z.string(),
  evidence: z.string(),
  severity: z.enum(["critical", "major", "minor"]),
});
export type Regression = z.infer<typeof RegressionSchema>;

// In EvalResultSchema (line 72):
regressions: z.array(RegressionSchema).optional(),
```

So `regressions` is `Array<{ description: string; evidence: string; severity: "critical"|"major"|"minor" }>`, and the field itself is `.optional()`.

**Contract s4-c6 documented example shape from generatorNotes:**
```
{ antiPattern: string, source: string, evidence: Array<{path, line, snippet}> }
```

**This does NOT match the current Zod schema.** The current `Regression` entry has flat `description`/`evidence`/`severity` strings, no `antiPattern`/`source` fields, and `evidence` is a string, not an array of objects.

**Decision recommendation — extend in agent prompt only, do NOT modify the Zod schema this sprint:**

The contract's `expectedChanges` does NOT include `src/contracts/eval-result.ts`. Adding required fields to the Zod schema would be (a) scope creep and (b) a breaking change to all existing eval results. The `evaluatorNotes` are explicit: *"Reject if evaluator changes contradict the existing regressions schema (additions go INSIDE entries unless schema is intentionally extended)."*

**The correct approach: the example anti-pattern citation goes inside the `description` and `evidence` strings, AND optionally as additional keys on the regression object.** Zod's `z.object` is strict-by-default but since `regressions` is `.optional()` and not `.strict()`, extra keys CAN be passed through at runtime — they just won't be validated. The agent prompt should document the EXTENDED shape as the **convention** for anti-pattern-matched regressions, while keeping the base schema's three required keys (`description`, `evidence`, `severity`) populated. Concretely:

```jsonc
{
  "description": "Test asserts on mock element instead of real behavior",
  "evidence": "src/components/Page.test.tsx:42 — expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument()",
  "severity": "major",
  // Extended fields for anti-pattern citations (convention, not yet schema-enforced):
  "antiPattern": "Testing Mock Behavior",
  "source": ".bober/anti-patterns/testing-anti-patterns.md",
  "antiPatternEvidence": [
    { "path": "src/components/Page.test.tsx", "line": 42, "snippet": "expect(screen.getByTestId('sidebar-mock'))..." }
  ]
}
```

Three required keys keep Zod happy; three optional keys carry the anti-pattern citation. The agent prompt should call out: *"When a regression matches a known anti-pattern from `.bober/anti-patterns/`, add the `antiPattern`, `source`, and `antiPatternEvidence` fields to the regression entry. These extend (not replace) the base shape."*

Note: I used `antiPatternEvidence` (extra key) instead of overwriting `evidence: string` with an array, to avoid breaking the Zod string validation.

---

## 5. `agents/bober-evaluator.md` Current Structure

**Total file size:** 698 lines.

**Top-level sections (line ranges):**
| Line | Section |
|------|---------|
| 1–20 | YAML frontmatter (name, description, tools, model) |
| 22 | `# Bober Evaluator Agent` |
| 24–66 | `## Subagent Context` (includes the example EvalResult JSON skeleton at 38–61, lists `"regressions": [...]` at line 57) |
| 68–80 | **Iron Law block — SPRINT 3 ARTIFACT, DO NOT TOUCH.** Lines 70–73 contain the `IRON LAW: NO PASS WITHOUT INDEPENDENT VERIFICATION...` block; lines 78–80 contain the `<EXTREMELY-IMPORTANT>` Playwright/missing-strategy warning. Both were added in Sprint 3. |
| 82–88 | `## The One Rule That Must Never Be Broken` |
| 90–96 | `## Core Principles` |
| 98–405 | `## Process` — contains Steps 0 through 8: <br>• Step 0 (100–115): Contract Sanity Check <br>• Step 1 (116–128): Load Context <br>• Step 2 (130–177): Live Page Evaluation <br>• Step 3 (179–281): Run Configured Evaluation Strategies <br>• Step 4 (283–297): Verify Success Criteria <br>• Step 5 (299–306): Check Principles Adherence <br>• Step 5.5 (308–329): NonGoals/OutOfScope Adherence <br>• **Step 6 (330–337): Check for Regressions** ← **THIS IS WHERE THE NEW SUBSECTION GOES** <br>• Step 7 (338–398): Produce Structured EvalResult (includes example JSON with `"regressions"` at lines 378–384) <br>• Step 8 (400–405): Save and Report |
| 407–419 | `## Determining Overall Result` |
| 421–429 | `## Feedback Quality Standards` |
| 431–440 | `## Anti-Leniency Protocol` |
| 442–475 | `## Thorough Verification Protocol` |
| 477–557 | `## Proactive Test Execution` |
| 559–587 | `## Playwright Enforcement` |
| 589–611 | `## Code Quality Evaluation` |
| 613–624 | `## Red Flags - STOP` (Sprint 3 added/audited entries here) |
| 626–638 | `## Rationalization Prevention` (Sprint 3 added/audited entries) |
| 640–652 | `## What You Must Never Do` |
| 654–698 | `## Brownfield-Specific Evaluation` |

### Where the new "Anti-Pattern Citations" subsection fits

**Insert as a new subsection at the END of Step 6 (after line 337, before line 338's Step 7 header).** Use heading level `###` (Step 6 is `### Step 6:` at line 330, so peer subsections under it use `####` — but Step 6 currently has no subsections, only a numbered list at lines 332–337. The cleanest fit is to add a `### Step 6.5: Anti-Pattern Citations` heading that mirrors the existing `### Step 5.5:` pattern at line 308.)

**Also update the example JSON at lines 378–384** to show the extended regression-entry shape (the three optional fields `antiPattern`, `source`, `antiPatternEvidence`) — keep all three base fields, append the three optional ones, and add an inline comment explaining when to populate them.

### What NOT to touch

- **Lines 68–80** (Iron Law + EXTREMELY-IMPORTANT block from Sprint 3) — read-only this sprint. The new Anti-Pattern Citations text must not contradict the Iron Law (it shouldn't — citing a catalog is additive to "verify every criterion independently").
- **Lines 613–638** (Red Flags and Rationalization Prevention tables from Sprint 3) — do not edit, prune, or reorder rows. If you feel a new Red Flag entry is warranted (e.g., "About to mark a test-quality regression without checking `.bober/anti-patterns/`"), that is scope creep this sprint — leave it for a future sprint.
- **Lines 1–20** (frontmatter) — tool list and model are fixed.
- **The example EvalResult skeleton at lines 38–61** in Subagent Context — that's a high-level shape; do not duplicate the new field there. The detailed example at 378–384 is the right place.

---

## 6. Implementation Sequence

Execute in this order. Each step's verification must pass before moving on.

1. **Create the directory.**
   ```bash
   mkdir -p /Users/bober4ik/agent-bober/.bober/anti-patterns
   ```
   Verify: `ls -d /Users/bober4ik/agent-bober/.bober/anti-patterns` exits 0.

2. **Port `testing-anti-patterns.md`.**
   - Read `/tmp/superpowers/skills/test-driven-development/testing-anti-patterns.md` (299 lines).
   - Write `/Users/bober4ik/agent-bober/.bober/anti-patterns/testing-anti-patterns.md` with:
     - Lines 1–3: the 3-line attribution block from §3 above (path: `skills/test-driven-development/testing-anti-patterns.md`).
     - Line 4: blank line.
     - Line 5+: the full source content verbatim (starting with `# Testing Anti-Patterns`).
   - Verify: `wc -l < .bober/anti-patterns/testing-anti-patterns.md` >= 80 (will be ~303); `grep -c 'obra/superpowers' .bober/anti-patterns/testing-anti-patterns.md` returns 1; `grep -c 'MIT License' ...` returns 1; `grep -q 'Anti-Pattern 1: Testing Mock Behavior' ...` succeeds; `grep -q 'Anti-Pattern 5: Integration Tests as Afterthought' ...` succeeds.

3. **Port `condition-based-waiting.md`.** Source path: `skills/systematic-debugging/condition-based-waiting.md`. Lines: 115 source + 4 header = ~119. Verify: line count >= 60, attribution present, `grep -q 'Condition-Based Waiting'` succeeds, `grep -q 'waitFor'` succeeds.

4. **Port `root-cause-tracing.md`.** Source path: `skills/systematic-debugging/root-cause-tracing.md`. Lines: 169 source + 4 header = ~173. Verify: line count >= 60, attribution present, `grep -q 'Root Cause Tracing'` succeeds, `grep -q 'NEVER fix just where the error appears'` succeeds.

5. **Port `defense-in-depth.md`.** Source path: `skills/systematic-debugging/defense-in-depth.md`. Lines: 122 source + 4 header = ~126. Verify: line count >= 40, attribution present, `grep -q 'Defense-in-Depth'` succeeds, `grep -q 'Four Layers'` succeeds.

6. **Create `.bober/anti-patterns/README.md`** (~30–50 lines).
   Structure:
   ```markdown
   > Anti-pattern reference catalog. All four docs in this directory are verbatim ports from
   > [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
   > See each file for its individual `Original:` path.

   # Anti-Pattern Catalog

   This catalog is the canonical reference cited by `agents/bober-evaluator.md` in the
   `regressions` field of `EvalResult` when a detected regression matches a known anti-pattern.

   ## Index

   | Anti-pattern | When to flag | File |
   |--------------|--------------|------|
   | Testing Mock Behavior | Test asserts on `*-mock` test IDs or mock-only elements | [testing-anti-patterns.md](./testing-anti-patterns.md) |
   | Test-Only Methods in Production | Production class has methods called only from tests | [testing-anti-patterns.md](./testing-anti-patterns.md) |
   | Mocking Without Understanding | Mock setup breaks behavior the test depends on | [testing-anti-patterns.md](./testing-anti-patterns.md) |
   | Incomplete Mocks | Mock omits fields the production code consumes | [testing-anti-patterns.md](./testing-anti-patterns.md) |
   | Tests as Afterthought | Implementation shipped without tests written first | [testing-anti-patterns.md](./testing-anti-patterns.md) |
   | Arbitrary-Delay Waiting | Test uses `setTimeout`/`sleep` instead of waiting for a real condition | [condition-based-waiting.md](./condition-based-waiting.md) |
   | Symptom-Fix Instead of Root-Cause | Bug patched where it surfaces instead of traced to its source | [root-cause-tracing.md](./root-cause-tracing.md) |
   | Single-Layer Validation | Bug fixed at only one checkpoint; defense-in-depth missing | [defense-in-depth.md](./defense-in-depth.md) |

   ## Usage by evaluators

   When `agents/bober-evaluator.md` finds a regression that matches one of the above rows,
   it MUST cite the anti-pattern by name in the regression entry. See the "Anti-Pattern
   Citations" subsection in the evaluator agent for the extended `Regression` shape.
   ```
   Verify: file exists, opens with attribution, contains a markdown table with columns `Anti-pattern | When to flag | File`, table covers all four ported docs, all four file links resolve to files created in steps 2–5.

7. **Modify `agents/bober-evaluator.md`** — insert a new `### Step 6.5: Anti-Pattern Citations` block immediately after line 337 (end of current Step 6) and before line 338 (`### Step 7:`). Also update the regression-entry example at lines 378–384 to show the three optional fields.

   **New subsection text (paste between current Step 6 and Step 7):**

   ```markdown
   ### Step 6.5: Anti-Pattern Citations

   When a regression you found matches a documented anti-pattern in `.bober/anti-patterns/`,
   you MUST cite the anti-pattern by name in the regression entry. The catalog index is at
   `.bober/anti-patterns/README.md`. Currently catalogued:

   - Testing Mock Behavior, Test-Only Methods in Production, Mocking Without Understanding,
     Incomplete Mocks, Tests as Afterthought → `.bober/anti-patterns/testing-anti-patterns.md`
   - Arbitrary-delay waiting (`setTimeout` / `sleep` instead of condition polling) →
     `.bober/anti-patterns/condition-based-waiting.md`
   - Symptom-fix instead of root-cause → `.bober/anti-patterns/root-cause-tracing.md`
   - Single-layer validation (missing defense-in-depth) →
     `.bober/anti-patterns/defense-in-depth.md`

   **Extended regression entry shape for anti-pattern citations:**

   The base `Regression` schema (`src/contracts/eval-result.ts`) requires `description`,
   `evidence`, `severity`. When citing an anti-pattern, ADD these optional fields:

   ```json
   {
     "description": "Test asserts on mock element rather than real component behavior",
     "evidence": "src/components/Page.test.tsx:42 — expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument()",
     "severity": "major",
     "antiPattern": "Testing Mock Behavior",
     "source": ".bober/anti-patterns/testing-anti-patterns.md",
     "antiPatternEvidence": [
       { "path": "src/components/Page.test.tsx", "line": 42, "snippet": "expect(screen.getByTestId('sidebar-mock')).toBeInTheDocument()" }
     ]
   }
   ```

   - `antiPattern` (string): exact name as it appears in the catalog file's heading
     (e.g., `"Testing Mock Behavior"`, not `"mock testing"`).
   - `source` (string): repo-relative path to the catalog file.
   - `antiPatternEvidence` (array): one entry per location demonstrating the anti-pattern,
     each `{ path, line, snippet }`. Use repo-relative paths.

   These fields extend, but do not replace, the base schema. Always populate
   `description`, `evidence`, and `severity` as well — they remain required.

   If a regression does NOT match any catalogued anti-pattern, omit these fields and
   use only the base shape. Do not invent anti-pattern names.
   ```

   Verify: `grep -c '.bober/anti-patterns' agents/bober-evaluator.md` >= 5 (the new subsection cites the catalog README + four files); `grep -q 'Anti-Pattern Citations' agents/bober-evaluator.md` succeeds; `grep -q 'antiPattern' agents/bober-evaluator.md` succeeds; the Iron Law block (lines 70–80 pre-edit) still appears verbatim.

8. **Update the example JSON inside Step 7 at lines 378–384** to show the extended shape. Change from:
   ```json
   "regressions": [
     {
       "description": "<What regressed>",
       "evidence": "<How you detected it>",
       "severity": "critical | major | minor"
     }
   ],
   ```
   to:
   ```json
   "regressions": [
     {
       "description": "<What regressed>",
       "evidence": "<How you detected it>",
       "severity": "critical | major | minor",
       "antiPattern": "<optional: name from .bober/anti-patterns/ catalog if applicable>",
       "source": "<optional: path to the matched catalog file>",
       "antiPatternEvidence": [
         { "path": "<file>", "line": <n>, "snippet": "<code excerpt>" }
       ]
     }
   ],
   ```
   Verify: the example is parseable as JSON5 (allowing comments / angle-brackets are illustrative placeholders consistent with the rest of the file).

9. **Run full verification pipeline** — see Verification Checklist below.

---

## 7. Verification Checklist

Run these before declaring done. Each maps to a success criterion in the contract.

| # | Criterion | Verification command(s) | Pass condition |
|---|-----------|------------------------|-----------------|
| s4-c1 | README.md exists with index + attribution | `wc -l < .bober/anti-patterns/README.md` >= 20<br>`grep -c 'obra/superpowers' .bober/anti-patterns/README.md` >= 1<br>`grep -c 'MIT' .bober/anti-patterns/README.md` >= 1<br>`grep -c '\\| .* \\| .* \\| .* \\|' .bober/anti-patterns/README.md` >= 5 (header + 4 file rows; likely more)<br>All 4 file paths in the table resolve to existing files | All four ported files appear in the table; attribution present |
| s4-c2 | testing-anti-patterns.md >= 80 lines, attribution, content match | `wc -l < .bober/anti-patterns/testing-anti-patterns.md` >= 80<br>`head -3 .bober/anti-patterns/testing-anti-patterns.md \| grep -c 'obra/superpowers'` == 1<br>`grep -q 'Anti-Pattern 1: Testing Mock Behavior'`<br>`grep -q 'Anti-Pattern 5: Integration Tests as Afterthought'`<br>`grep -q 'The Iron Laws'` | All checks pass; line count ~303 |
| s4-c3 | condition-based-waiting.md >= 60 lines, attribution, content match | `wc -l` >= 60; attribution in head -3; `grep -q 'Condition-Based Waiting'`; `grep -q 'waitFor'`; `grep -q 'Quick Patterns'` | All pass; line count ~119 |
| s4-c4 | root-cause-tracing.md >= 60 lines, attribution, content match | `wc -l` >= 60; attribution; `grep -q 'Root Cause Tracing'`; `grep -q 'NEVER fix just where the error appears'`; `grep -q 'Four Layers'` (referenced from this file) or `grep -q 'defense-in-depth'` | All pass; line count ~173 |
| s4-c5 | defense-in-depth.md >= 40 lines, attribution, content match | `wc -l` >= 40; attribution; `grep -q 'Defense-in-Depth'`; `grep -q 'Layer 1'` through `grep -q 'Layer 4'`; `grep -q 'Entry Point Validation'` | All pass; line count ~126 |
| s4-c6 | bober-evaluator.md cites catalog + has example shape | `grep -c '.bober/anti-patterns' agents/bober-evaluator.md` >= 5<br>`grep -q '### Step 6.5: Anti-Pattern Citations'`<br>`grep -q 'antiPattern' agents/bober-evaluator.md`<br>`grep -q 'antiPatternEvidence'`<br>The JSON example in the new subsection parses (no trailing commas, valid quoting)<br>**Iron Law block at original lines 70–80 unchanged: `sed -n '70,80p' agents/bober-evaluator.md \| grep -q 'NO PASS WITHOUT INDEPENDENT VERIFICATION'`** (line numbers may shift due to insertion; instead verify by content match anywhere in the file) | All checks pass; Iron Law text still appears verbatim |
| s4-c7 | All existing eval strategies pass | From repo root:<br>`npm run typecheck` (or `npx tsc --noEmit`) → exit 0<br>`npm run lint` → exit 0<br>`npm run build` → exit 0<br>`npm test` → exit 0 | All four exit 0. No new test failures vs. main. |

**Additional self-verification (beyond the contract):**

- Diff scan: `git diff --name-only main...HEAD` should show ONLY: the five new `.bober/anti-patterns/*.md` files and one modified `agents/bober-evaluator.md`. Anything else is scope creep.
- Verify the IRON LAW block from Sprint 3 still appears: `grep -A 3 '^\*\*IRON LAW:' agents/bober-evaluator.md` should still print the `NO PASS WITHOUT INDEPENDENT VERIFICATION OF EVERY SUCCESS CRITERION` block.
- Verify Sprint 3's Red Flags and Rationalization Prevention sections are still intact: `grep -c '^## Red Flags - STOP' agents/bober-evaluator.md` == 1; `grep -c '^## Rationalization Prevention' agents/bober-evaluator.md` == 1.
- Verify no Zod schema change: `git diff src/contracts/eval-result.ts` should be empty.

**Pitfalls to avoid:**

1. Do NOT edit `src/contracts/eval-result.ts` — the contract explicitly excludes it, and the evaluator's new fields are convention (carried in optional extra keys), not schema-enforced this sprint.
2. Do NOT trim the source files' "empirical content" — keep all Red Flags lists, gate functions, `dot` graphs, code blocks, and tables verbatim. Only the attribution header is added.
3. Do NOT skip the `Adaptations: none (reference doc, not a skill).` line — Tier 0 always has all three attribution lines. Consistency matters.
4. Do NOT rewrite the dangling `condition-based-waiting-example.ts` or `find-polluter.sh` references — they're documented superpowers-repo artifacts; the attribution header tells readers where to find the originals.
5. Do NOT touch lines 68–80 of `agents/bober-evaluator.md` (Sprint 3 Iron Law + `<EXTREMELY-IMPORTANT>` block). The new Step 6.5 goes between current line 337 and line 338, far below.
6. Do NOT add a new Red Flag or Rationalization row this sprint — that's Sprint 3's territory and adding to those tables is out of scope.
7. README.md table: `Anti-pattern | When to flag | File` is the exact column order the contract calls for. Don't reorder.
