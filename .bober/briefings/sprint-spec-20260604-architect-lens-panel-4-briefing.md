# Sprint Briefing: Native canonical reference, lens-aware architect agent, and sync gate

**Contract:** sprint-spec-20260604-architect-lens-panel-4
**Generated:** 2026-06-04T07:00:00Z

> Sprint 4 mirrors the EVALUATOR native panel (sprints already done for the evaluator)
> for the ARCHITECT. Four files: a new canonical markdown reference, an additive MODE
> section in the architect agent, its byte-identical `.claude` copy, and a vitest drift gate.
> NON-GOALS (do not touch): SKILL.md wiring, skill `references/` copies, command regen,
> and `arch-lenses.ts` / `synthesizer.ts` / `reconciler.ts` / `architect-agent.ts`.

---

## 1. Target Files

### skills/shared/arch-lens-panel.md (create)

**Directory pattern:** `skills/shared/` holds canonical protocol references. The sole sibling is
`skills/shared/lens-panel.md` — the EVALUATOR canonical reference. Mirror its structure exactly.
**Most similar existing file:** `skills/shared/lens-panel.md` (104 lines) — follow this structure,
substituting the architect's CP2-synthesize + CP5-reconcile protocols for the evaluator's split fan-out.

**Structure to mirror (from `skills/shared/lens-panel.md`):**
- Title + 1-paragraph intro stating this is the single source of truth and that the fragments
  are embedded verbatim from `src/orchestrator/arch-lenses.ts` (the `ARCH_LENS_CATALOG` literal),
  enforced by the drift gate `src/orchestrator/arch-lens-panel-parity.test.ts`. (`lens-panel.md:1-6`)
- `## Lens Focus Fragments` — one `### <lens>` subsection per lens, each with the fragment in a
  plain fenced ``` block. (`lens-panel.md:10-38`) — **SIX lenses here, not four.**
- Protocol section(s) documenting the panel orchestration. (`lens-panel.md:42-100`)

**The SIX fragments to embed VERBATIM** (exact strings `resolveArchLensFocus(lens)` returns; from
`src/orchestrator/arch-lenses.ts:4-17`). Each must appear character-for-character — the drift gate
asserts `md.toContain(resolveArchLensFocus(lens))`:

- **scalability** (`arch-lenses.ts:5-6`):
  `Focus on whether the proposed architecture can handle projected load growth. Evaluate horizontal and vertical scaling paths, bottlenecks, stateful vs stateless components, and whether partitioning or sharding strategies are available when needed.`
- **security** (`arch-lenses.ts:7-8`):
  `Focus on the threat surface introduced by this architecture. Evaluate trust boundaries, data flows across zones, authentication and authorisation enforcement points, secrets management, and exposure of internal services.`
- **cost** (`arch-lenses.ts:9-10`):
  `Focus on the total cost of ownership implied by this architecture. Evaluate compute, storage, and egress costs at projected scale, licensing or SaaS subscription expenses, and the operational overhead of running, monitoring, and scaling the system.`
- **operability** (`arch-lenses.ts:11-12`):
  `Focus on how easy it will be to operate this architecture in production. Evaluate observability (metrics, logs, traces), deployment complexity, rollout and rollback procedures, on-call burden, and the blast radius of common failure modes.`
- **maintainability** (`arch-lenses.ts:13-14`):
  `Focus on how easy it will be to change and extend this architecture over time. Evaluate coupling between components, clarity of boundaries, documentation needs, onboarding friction for new contributors, and the risk of accruing technical debt.`
- **reversibility** (`arch-lenses.ts:15-16`):
  `Focus on how difficult or costly it would be to undo or replace this architectural decision. Evaluate lock-in to vendors or proprietary technologies, data migration complexity, and whether a strangler-fig or incremental migration path exists if the approach needs to change.`

> WARNING: British spelling — `authorisation` (security), `behaviour` n/a here. Use UTF-8 punctuation
> as-is. Do NOT "correct" spelling or punctuation — `toContain` is byte-exact.

**Protocols to document (these REPLACE the evaluator's split fan-out / majority-vote prose):**

- **(a) CP2 synthesis panel** (C1): generate 2-3 candidate approaches -> spawn **one lens scorer per
  lens**, bounded by `maxConcurrent` -> `synthesize()` produces a ranked winner + dissent. (Sprint 1
  added `synthesize()` in `src/orchestrator/synthesizer.ts` and `architect.panel` config — do NOT
  modify them; just document the protocol.)
- **(b) CP5 reconcile panel** (C1): spawn **one lens reviewer per lens** -> `reconcile()` returns
  pass/fail, **fail-closed on tie**. Mirror the fail-closed wording from `lens-panel.md:61-77`.

---

### agents/bober-architect.md (modify — additive ONLY)

**Insertion point:** Add ONE new `## Panel / Lens Mode` section. Place it **after the IRON LAW
block and before the "You are the Architect..." identity line** — i.e. between line 52 (the closing
`---` after the `<EXTREMELY-IMPORTANT>` block) and line 54. This mirrors where the evaluator agent
places its MODE section (after that agent's intro JSON, before its IRON LAW). The architect's
existing structure at the seam:

```
50	</EXTREMELY-IMPORTANT>
51	
52	---
53	
54	You are the **Architect** in the Bober multi-agent harness. You produce architecture documents...
```

Insert the new section as `... </EXTREMELY-IMPORTANT> \n\n --- \n\n ## Panel / Lens Mode (opt-in) \n ... \n\n --- \n\n You are the **Architect**...`. The existing `---` on line 52 becomes the separator above the new section; add a fresh `---` after the new section so line 54's identity line keeps its blank-line spacing. **Touch nothing else** — the 5-checkpoint prose (lines 67-442), IRON LAW (40-46), identity, Quality Gates, Red Flags, Rationalization table must remain byte-unchanged (C2, nonGoal line 20).

**What the MODE section documents** (C2; mirror the evaluator's three-subsection additive style at
`agents/bober-evaluator.md:68-91`):
- `### MODE:full (default)` — applied when no MODE is specified; behave EXACTLY as the rest of the
  doc (all 5 checkpoints). This is the off-path byte-identical default. (mirror `bober-evaluator.md:72-74`)
- `### MODE:lens-score:<name>` — CP2. Score the candidate approaches through
  `resolveArchLensFocus(<name>)`, emit per-lens scores for `synthesize()`.
- `### MODE:lens-review:<name>` — CP5. PASS/FAIL review the assembled architecture + ADRs through the
  named lens, emit a verdict for `reconcile()`.
- Reference `skills/shared/arch-lens-panel.md` for the fragment definitions (mirror how
  `bober-evaluator.md:82` references `skills/shared/lens-panel.md` + `resolveLensFocus`).

**Imported by / coupling:** This is a markdown agent prompt, not TS — no code imports it. Its only
coupling is the byte-equality requirement with `.claude/agents/bober-architect.md` (C3) enforced by
the drift gate.

**Test file:** the new drift gate `src/orchestrator/arch-lens-panel-parity.test.ts` (create).

---

### .claude/agents/bober-architect.md (modify — regenerate)

**Action:** After editing `agents/bober-architect.md`, copy it over byte-for-byte:
`cp agents/bober-architect.md .claude/agents/bober-architect.md` (C3). Do NOT hand-edit this file
separately — copy only, or the byte-equality gate fails.

---

### src/orchestrator/arch-lens-panel-parity.test.ts (create)

**Most similar existing file:** `src/orchestrator/lens-panel-parity.test.ts` — copy its first two
`describe` blocks (the fragment-embedding gate at lines 9-19 and the agent-copy sync gate at lines
23-35), swap evaluator -> architect symbols/paths. **Do NOT** include the per-skill reference-copy or
command-recomputation gates (lines 37-94) — those are sprint 5 scope (nonGoals).

---

## 2. Patterns to Follow

### Canonical-reference markdown shape
**Source:** `skills/shared/lens-panel.md`, lines 10-38
```
## Lens Focus Fragments

The following fragments are the exact strings returned by `resolveLensFocus(lens)` ...
They MUST remain byte-for-byte identical ... the drift gate enforces this.

### correctness

```
Focus on whether the implementation actually satisfies each success criterion verbatim...
```
```
**Rule:** One `### <lens>` heading per lens; fragment inside a bare fenced block; intro paragraph
names the source TS file and the drift gate. For arch, name `arch-lenses.ts` and the new test.

### Additive MODE section (three subsections, full=default)
**Source:** `agents/bober-evaluator.md`, lines 68-91
```
## Panel / Lens Mode (opt-in)

The orchestrator may pass a `MODE` directive in your spawn prompt...

### MODE:full (default)

Applied when the spawn prompt specifies **no MODE**... Behave EXACTLY as the rest of this document...
```
**Rule:** Lead with the `## Panel / Lens Mode (opt-in)` heading and a sentence saying the orchestrator
may pass `MODE`; first subsection is `MODE:full (default)` declaring byte-identical off-path behavior.

### Unicode box-drawing section headers in TS
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 5 & 21
```ts
// ── Lens-panel drift gate ──────────────────────────────────────────
// ── Evaluator agent copy sync gate ─────────────────────────────────
```
**Rule:** Use `// ── Section Name ──...` headers in the new test (principles.md:32).

### ESM `.js` specifier + `import type`
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 1-3
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveLensFocus } from "./eval-lenses.js";
```
**Rule:** Import the resolver with a `.js` specifier (`./arch-lenses.js`); use `import type` for any
type-only imports (principles.md:27,35). `resolveArchLensFocus` is a value, not a type.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveArchLensFocus` | `src/orchestrator/arch-lenses.ts:26` | `(lens: string): string` | Returns the catalog fragment for a known arch lens or a generic fallback; the drift gate's accessor (ARCH_LENS_CATALOG stays module-private). |
| `ARCH_LENS_CATALOG` | `src/orchestrator/arch-lenses.ts:4` | `Record<string,string>` (module-private, NOT exported) | The 6 fragment strings. Access ONLY via `resolveArchLensFocus` — do not import it (it is not exported). |
| `resolveLensFocus` | `src/orchestrator/eval-lenses.ts` (imported at `lens-panel-parity.test.ts:3`) | `(lens: string): string` | Evaluator analog — reference only; do NOT use for the architect gate. |
| `synthesize` | `src/orchestrator/synthesizer.ts` (sprint 1) | n/a — do not call | CP2 ranked-winner synthesizer; document its role in the md, do NOT modify or import. |
| `reconcile` | `src/orchestrator/workflow/reconciler.ts` (cited `lens-panel.md:63`) | n/a — do not call | CP5 pass/fail reconciliation, fail-closed on tie; document only. |

Node builtins used by the test: `readFile` from `node:fs/promises`. No new util modules needed.

---

## 4. Prior Sprint Output

### Sprint 1 (7de08b5): arch-lens foundation
**Created:** `src/orchestrator/arch-lenses.ts` — exports `resolveArchLensFocus(lens: string): string`
over the 6 lenses (scalability/security/cost/operability/maintainability/reversibility) with a generic
fallback; `synthesize()`; and `architect.panel` config.
**Connection to this sprint:** The 6 fragments returned by `resolveArchLensFocus` are embedded verbatim
into `arch-lens-panel.md`; the drift gate imports `resolveArchLensFocus` as the test accessor.

### Sprints 2-3 (6f82cea/1d02543/9163a56): TS panel branches
**Created/modified:** CP2 synthesis panel + CP5 review panel in `runArchitectPanel`.
**Connection to this sprint:** This sprint documents (in markdown) the protocols those TS branches
implement — but must NOT modify the TS (nonGoals line 21).

### Evaluator panel (template to mirror — already complete)
`skills/shared/lens-panel.md`, `agents/bober-evaluator.md` (MODE section), and
`src/orchestrator/lens-panel-parity.test.ts` are the exact templates for the three new artifacts.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere; `.js` import specifiers** for NodeNext (line 27) — use `./arch-lenses.js`.
- **`consistent-type-imports`**: use `import type` for type-only imports (line 35).
- **Unicode box-drawing section headers** `// ── Name ──` in long files (line 32).
- **No synchronous fs**: tests use `node:fs/promises` (`readFile`), never `readFileSync` (line 42).
- **Tests run against the real committed files** (line 20) — the `new URL(..., import.meta.url)` idiom
  reads the actual repo files; this is the sanctioned pattern.
- **Conventional commits**: `bober(sprint-4): ...` (line 34). Use the message in generatorNotes.

### Architecture Decisions
`.bober/architecture/` exists (untracked) but no ADR governs this sprint's markdown/test work. The
evaluator panel precedent (sprints in this plan) is the operative design.

### Other Docs
None additionally relevant. `CLAUDE.md` global rules concern exploration tooling, not artifact shape.

---

## 6. Testing Patterns

### Unit Test Pattern (the drift gate)
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 1-35
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveLensFocus } from "./eval-lenses.js";

const BUILT_IN_LENSES = ["correctness", "security", "regression", "quality"] as const;

describe("lens-panel.md drift gate", () => {
  it("embeds every resolveLensFocus fragment verbatim", async () => {
    const md = await readFile(
      new URL("../../skills/shared/lens-panel.md", import.meta.url),
      "utf-8",
    );
    for (const lens of BUILT_IN_LENSES) {
      expect(md).toContain(resolveLensFocus(lens));
    }
  });
});

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
**New test to write** (`src/orchestrator/arch-lens-panel-parity.test.ts`): same two blocks, with
`resolveArchLensFocus` from `./arch-lenses.js`, the SIX-lens array
`["scalability","security","cost","operability","maintainability","reversibility"]`, path
`../../skills/shared/arch-lens-panel.md`, and the agent paths `../../agents/bober-architect.md` /
`../../.claude/agents/bober-architect.md`. Note `readdir` is NOT needed (drop it from the import).

**Runner:** vitest. **Assertion style:** `expect(...).toContain(...)` and `expect(...).toBe(...)`.
**Mock approach:** none — reads real committed files via `new URL(path, import.meta.url)`.
**File naming:** `*.test.ts` collocated in `src/orchestrator/`. **Location:** co-located.

### E2E Test Pattern
Not applicable — agent-bober is a CLI/library with no UI (principles.md:48). No Playwright for this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `.claude/agents/bober-architect.md` | `agents/bober-architect.md` | high | Must be re-copied byte-identical after the edit; the new gate fails otherwise (C3/C4). |
| new `arch-lens-panel-parity.test.ts` | `arch-lenses.ts` fragments + both architect md files | high | Asserts all 6 fragments embedded + agent copies equal — green is C4. |
| `src/orchestrator/lens-panel-parity.test.ts` | unchanged | low | Must still pass; this sprint does not touch it. Verify it stays green. |

No TS source imports the architect markdown, so blast radius is limited to the agent-copy equality
and the two drift-gate tests.

### Existing Tests That Must Still Pass
- `src/orchestrator/lens-panel-parity.test.ts` — the evaluator drift gate; this sprint must not
  disturb `skills/shared/lens-panel.md`, `agents/bober-evaluator.md`, the skill reference copies, or
  the commands, so all 5 of its `describe` blocks stay green.
- The full vitest suite — tolerate ONLY the documented pre-existing skipped baseline (C5).

### Features That Could Be Affected
- **Evaluator native panel** — shares the `skills/shared/` dir and the parity-test idiom. Verify its
  `lens-panel.md` and `bober-evaluator.md` are untouched (nonGoal: confine changes to the 4 target files).
- **Sprint 5 (architect SKILL.md wiring)** — depends on this sprint's `arch-lens-panel.md` existing;
  do NOT pre-wire it (nonGoals lines 18-19).

### Recommended Regression Checks
1. `npx vitest run src/orchestrator/arch-lens-panel-parity.test.ts` — new gate green.
2. `npx vitest run src/orchestrator/lens-panel-parity.test.ts` — evaluator gate still green.
3. `diff agents/bober-architect.md .claude/agents/bober-architect.md` — empty (byte-identical).
4. `git diff agents/bober-architect.md` — additive only; existing checkpoint prose / IRON LAW intact.
5. `git status --short` — only the 4 target files changed (no SKILL.md / commands / TS source).
6. `npx tsc --noEmit && npm run build && npx eslint src/` — exit 0 (C5).
7. `npx vitest run` — full suite green beyond the pre-existing skipped baseline (C5).

---

## 8. Implementation Sequence

1. **skills/shared/arch-lens-panel.md** (create) — mirror `lens-panel.md` structure; embed the 6
   fragments VERBATIM from `arch-lenses.ts:5-16`; document the CP2 synthesize + CP5 reconcile
   (fail-closed) protocols.
   - Verify: each fragment string is character-exact (copy from the snippets in section 1, do not retype).
2. **agents/bober-architect.md** (modify) — insert the additive `## Panel / Lens Mode (opt-in)`
   section between line 52 (`---`) and line 54 (the "You are the Architect" line); document full
   (default) / lens-score / lens-review; reference `skills/shared/arch-lens-panel.md`.
   - Verify: `git diff` shows additive-only; checkpoint prose, IRON LAW, identity unchanged.
3. **.claude/agents/bober-architect.md** (regenerate) — `cp agents/bober-architect.md .claude/agents/bober-architect.md`.
   - Verify: `diff` between the two is empty.
4. **src/orchestrator/arch-lens-panel-parity.test.ts** (create) — two `describe` blocks (fragment
   embedding over the 6 lenses via `resolveArchLensFocus`; agent-copy byte-equality).
   - Verify: `npx vitest run src/orchestrator/arch-lens-panel-parity.test.ts` green.
5. **Run full verification** — `npx tsc --noEmit`, `npm run build`, `npx eslint src/`, `npx vitest run`.
   - Verify: all exit 0; full suite green beyond the pre-existing skipped baseline.

---

## 9. Pitfalls & Warnings

- **Fragment byte-exactness is the #1 failure.** `toContain` is exact. Copy each fragment from
  section 1 of this briefing (sourced from `arch-lenses.ts:5-16`). Do not "fix" British spelling
  (`authorisation`), do not reflow line breaks inside the string, do not change punctuation. A
  single altered char fails C4.
- **SIX lenses, not four.** The evaluator template has 4 (correctness/security/regression/quality);
  the architect has 6 (scalability/security/cost/operability/maintainability/reversibility). `security`
  is the only overlapping name but the architect's fragment text differs.
- **ARCH_LENS_CATALOG is NOT exported** (`arch-lenses.ts:4`). Do not `import { ARCH_LENS_CATALOG }` —
  it will not compile. Use `resolveArchLensFocus(lens)` as the accessor in the gate.
- **MODE section is ADDITIVE only.** Do not modify the 5-checkpoint prose, IRON LAW, identity, Quality
  Gates, Red Flags, or the Rationalization table. Any non-additive diff violates C2 / nonGoal line 20.
- **Copy, never hand-edit, the `.claude` copy.** Editing both files independently risks a 1-byte
  divergence (trailing newline, whitespace) that fails the equality gate. Always `cp`.
- **Stay in scope.** Do NOT touch `skills/bober.architect/SKILL.md`, `.claude/commands/`, the skill
  `references/` dirs, or any TS in `arch-lenses.ts`/`synthesizer.ts`/`reconciler.ts`/`architect-agent.ts`
  (nonGoals 18-21). Drop the `readdir`/`recomputeCommand`/per-skill blocks when copying the test template.
- **Git hygiene:** stage only the 4 files with explicit paths; never `git add -A`. Both architect md
  files may already carry pre-existing uncommitted edits and are currently byte-identical — keep them so.
- **Both architect agent files are byte-identical RIGHT NOW** (verified: `diff` empty, 17570 bytes each).
  Re-copy after the edit to preserve this.
