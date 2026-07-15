# Sprint Briefing: Shared synthesize() reducer, arch-lens catalog, and architect.panel config

**Contract:** sprint-spec-20260604-architect-lens-panel-1
**Generated:** 2026-06-04T00:00:00Z

---

## 0. CRITICAL FINDING — There is NO `architect` config section yet

The contract and generatorNotes say "add architect.panel to the architect config in src/config/schema.ts, mirrored in createDefaultConfig and EVERY other literal." **This is misleading: there is currently NO `architect` section in `BoberConfigSchema` at all.** What exists is:
- `pipeline.architectPhase` (a boolean inside `PipelineSectionSchema`) — `src/config/schema.ts:159`
- `graph.preflightBudgets.architect` (a number) — `src/config/schema.ts:218,244`
- `bober.architect` skill names in init.ts (strings, unrelated)

There is **no `ArchitectSectionSchema`** and no `architect:` key in `BoberConfigSchema` (`src/config/schema.ts:314-331`) nor in `createDefaultConfig` (`src/config/schema.ts:361-411`).

**Recommended approach (avoids the defaults.ts trap):**
1. Create a new `ArchitectSectionSchema` modeled on `EvaluatorSectionSchema`'s panel sub-object.
2. Add it to `BoberConfigSchema` as **`architect: ArchitectSectionSchema.optional()`** (mirror how `curator`, `codeReview`, `graph`, `observability`, `incident`, `telemetry` are all `.optional()` — `src/config/schema.ts:317,323-330`).
3. Because `architect` is OPTIONAL, the config literals in defaults.ts / init.ts / loader.ts / mcp/tools/init.ts do **NOT** need an `architect:` block to keep tsc green — they only carry `evaluator.panel` because `EvaluatorSectionSchema` is a REQUIRED key whose `strategies` field is required. An optional `architect` section adds zero pressure on those literals.
4. Optionally add the default block to `createDefaultConfig`'s returned object for parity, but it is not required for tsc.

> The "defaults.ts trap" warned about in the contract is REAL for required sections (that is exactly why `evaluator.panel` was copied into ~14 literals). You sidestep it entirely by making `architect` optional. If you instead make `architect` a REQUIRED key on `BoberConfigSchema`, you WILL have to add an `architect: { panel: {...} }` block to all 14 literals listed in §7 or tsc fails. **Prefer optional.** The schema-test C3 ("a config without architect.panel still parses to the default") is naturally satisfied either way because `panel` has a `.default(...)`.

---

## 1. Target Files

### src/orchestrator/workflow/synthesizer.ts (create)

**Directory pattern:** `src/orchestrator/workflow/` holds pure reducers. The sibling is `reconciler.ts` (kebab-case file, single exported pure function, collocated `.test.ts`).
**Most similar existing file:** `src/orchestrator/workflow/reconciler.ts` (the whole file is 82 lines).

**reconciler.ts structure to mirror (src/orchestrator/workflow/reconciler.ts:1-22):**
```ts
import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";

// ── Reconciler ─────────────────────────────────────────────────────

/**
 * Pure majority-vote reducer over per-lens EvalResult[] (ADR-4).
 * No Date.now / new Date / Math.random / fs — timestamp is a caller arg.
 * ...
 */
export function reconcile(
  _sprintId: string,
  _round: number,
  lensVerdicts: EvalResult[],
  timestamp: string,
): EvalResult {
  if (lensVerdicts.length === 0) {
    throw new Error("reconcile: lensVerdicts must be non-empty");
  }
  ...
```

PURITY DISCIPLINE (reconciler.ts:6-7, doc + actual code): no `Date.now`, `new Date`, `Math.random`, `fs`. Note `Math.round` IS used (reconciler.ts:71) — `Math.round`/`Math.max` are fine; only `Math.random` is forbidden. The ONLY "external" value (timestamp) is a caller arg echoed verbatim. `synthesize()` per C1 has no timestamp need, so it takes none unless you add one as a trailing caller arg.

**SynthesisResult shape (define IN this module, EXPORTED — there is no shared contract for it; reconcile returns `EvalResult` from `src/contracts/eval-result.ts` but synthesize returns a DIFFERENT, ranking shape that should live locally):**
```ts
export interface SynthesisResult {
  winner: string;
  ranking: Array<{ approach: string; perLensScores: Record<string, number>; total: number }>;
  graftedIdeas: string[];
  dissent: string[];
}
```

**Signature (from generatorNotes / C1):**
```ts
export function synthesize(
  approaches: string[],
  lensScores: Array<{ lens: string; scores: Record<string, number> }>,
): SynthesisResult
```

Logic per C1 + generatorNotes:
- For each approach, `total` = sum over all lenses of `scores[approach] ?? 0`; `perLensScores[lens] = scores[approach] ?? 0`.
- `ranking` sorted DESC by `total`; deterministic tie-break: **lower original index in `approaches` wins on equal total** — document this in a JSDoc/comment. (Use a stable sort with a comparator that falls back to original index; do not rely on Array.sort stability across totals — capture the index explicitly.)
- `winner = ranking[0].approach`.
- `dissent`: for each lens, compute that lens's own top-scored approach (max `scores[approach]`, tie-break lower index); if it differs from `winner`, record an entry (e.g. `` `${lens}: prefers ${pick}` `` or just the lens name — keep it a `string[]`, C1 says "a lens whose top pick differs from the winner is recorded in dissent").
- `graftedIdeas`: keep simple this sprint — e.g. the runner-up approach names `ranking.slice(1).map(r => r.approach)` (generatorNotes calls it "a placeholder collection slot"). Must be `string[]`.
- Decide behavior for empty `approaches`: reconciler THROWS on empty input (reconciler.ts:23-25). Mirroring that for an empty `approaches` array is reasonable and testable; the contract does not mandate it, so either throw (mirrors sibling) or return empty ranking with `winner: ""` — pick one and keep it deterministic. Throwing is the closer mirror.

**Imports this file will use:** none required from contracts (SynthesisResult is local). Pure TS only.
**Test file:** `src/orchestrator/workflow/synthesizer.test.ts` (create).

---

### src/orchestrator/arch-lenses.ts (create)

**Most similar existing file:** `src/orchestrator/eval-lenses.ts` (26 lines — mirror it EXACTLY in shape).

**eval-lenses.ts full structure (src/orchestrator/eval-lenses.ts:1-26):**
```ts
// ── Lens catalog ────────────────────────────────────────────────────

/** Built-in lens focus fragments. Each must be distinct and non-empty (C1). */
const LENS_CATALOG: Record<string, string> = {
  correctness: "Focus on whether the implementation actually satisfies ...",
  security: "Focus on injection vulnerabilities, ...",
  regression: "Focus on whether previously working behaviour still works ...",
  quality: "Focus on principles violations, dead code, ...",
};

// ── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve a lens name to its focus fragment.
 * Returns the catalog entry for a known lens, or a generic non-empty
 * fallback for any unknown custom string — never throws (C1).
 */
export function resolveLensFocus(lens: string): string {
  return (
    LENS_CATALOG[lens] ?? `Evaluate specifically through the '${lens}' lens.`
  );
}
```

**For arch-lenses.ts (C2):**
- `const ARCH_LENS_CATALOG: Record<string, string>` — module-private (NOT exported), 6 keys: `scalability`, `security`, `cost`, `operability`, `maintainability`, `reversibility`. Each fragment DISTINCT and non-empty.
- `export function resolveArchLensFocus(lens: string): string` — returns `ARCH_LENS_CATALOG[lens] ?? \`Evaluate this architecture specifically through the '${lens}' lens.\`` (generatorNotes specifies that exact fallback wording).
- No imports needed. Use `// ── Section ──` unicode headers like eval-lenses.ts.
**Test file:** `src/orchestrator/arch-lenses.test.ts` (create).

---

### src/config/schema.ts (modify)

**The exact evaluator.panel field to MIRROR (src/config/schema.ts:104-118):**
```ts
export const EvaluatorSectionSchema = z.object({
  model: GeneratorModelSchema.default("sonnet"),
  strategies: z.array(EvalStrategySchema),
  maxIterations: z.number().int().min(1).default(3),
  plugins: z.array(z.string()).optional(),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  panel: z.object({
    enabled: z.boolean().default(false),
    lenses: z.array(z.string()).default([]),
    maxConcurrent: z.number().int().min(1).default(4),
  }).default({ enabled: false, lenses: [], maxConcurrent: 4 }),
});
export type EvaluatorSection = z.infer<typeof EvaluatorSectionSchema>;
```

**Add (suggested placement: right after `EvaluatorSectionSchema`, before `SprintSectionSchema` at line 120):**
```ts
// ── Architect Section ───────────────────────────────────────────────

export const ArchitectSectionSchema = z.object({
  panel: z.object({
    enabled: z.boolean().default(false),
    lenses: z.array(z.string()).default([]),
    maxConcurrent: z.number().int().min(1).default(4),
  }).default({ enabled: false, lenses: [], maxConcurrent: 4 }),
});
export type ArchitectSection = z.infer<typeof ArchitectSectionSchema>;
```

**Wire into BoberConfigSchema (src/config/schema.ts:314-331) as OPTIONAL** (mirror the `.optional()` siblings — curator:317, graph:323, codeReview:324):
```ts
  architect: ArchitectSectionSchema.optional(),
```

**Test file:** `src/config/schema.test.ts` (exists — extend it).

---

## 2. Patterns to Follow

### Pure reducer discipline
**Source:** `src/orchestrator/workflow/reconciler.ts:5-25`
```ts
/** ... No Date.now / new Date / Math.random / fs — timestamp is a caller arg. ... */
export function reconcile(_sprintId: string, _round: number, lensVerdicts: EvalResult[], timestamp: string): EvalResult {
  if (lensVerdicts.length === 0) { throw new Error("reconcile: lensVerdicts must be non-empty"); }
```
**Rule:** No clocks/randomness/fs inside synthesize(); throw on degenerate empty input to mirror the sibling; document the deterministic tie-break in JSDoc. `Math.round`/`Math.max`/`Array.sort` are allowed (Math.round is used at reconciler.ts:71).

### Module-private catalog + exported resolver with `??` fallback
**Source:** `src/orchestrator/eval-lenses.ts:4-26`
```ts
const LENS_CATALOG: Record<string, string> = { correctness: "...", security: "...", ... };
export function resolveLensFocus(lens: string): string {
  return (LENS_CATALOG[lens] ?? `Evaluate specifically through the '${lens}' lens.`);
}
```
**Rule:** Catalog is `const` (not exported); only the resolver is exported; unknown key → template-literal fallback, never throw.

### Optional config sub-section with defaulted nested object
**Source:** `src/config/schema.ts:112-117` (the panel object) and `src/config/schema.ts:317,323-330` (`.optional()` siblings)
```ts
panel: z.object({ enabled: z.boolean().default(false), lenses: z.array(z.string()).default([]), maxConcurrent: z.number().int().min(1).default(4) })
  .default({ enabled: false, lenses: [], maxConcurrent: 4 }),
```
**Rule:** Each leaf has `.default(...)` AND the whole object has `.default({...})` so an omitted section still produces full defaults. Add the section to `BoberConfigSchema` as `.optional()` to avoid touching the 14 config literals.

### ESM `.js` specifiers + `import type`
**Source:** `src/orchestrator/workflow/reconciler.ts:1`, `reconciler.test.ts:2-4`
```ts
import type { EvalResult, EvalDetail } from "../../contracts/eval-result.js";
import { reconcile } from "./reconciler.js";
```
**Rule:** All relative imports carry `.js`; type-only imports use `import type`. (`.bober/principles.md` "ESM everywhere" + "Use `type` imports".)

### Unicode section headers
**Source:** `src/config/schema.ts:3,54,72` (`// ── Enums & Primitives ──`), `eval-lenses.ts:1,15`
**Rule:** Organize each new file with `// ── Section ──` box-drawing headers.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveLensFocus` | `src/orchestrator/eval-lenses.ts:22` | `(lens: string): string` | Eval-lens resolver — the exact pattern to mirror (DO NOT modify; create the arch sibling). |
| `reconcile` | `src/orchestrator/workflow/reconciler.ts:17` | `(sprintId, round, lensVerdicts: EvalResult[], timestamp): EvalResult` | Pure majority-vote reducer — sibling discipline reference (DO NOT modify). |
| `EvaluatorSectionSchema` | `src/config/schema.ts:104` | Zod schema | Source-of-truth for the `panel` shape to mirror. |
| `createDefaultConfig` | `src/config/schema.ts:355` | `(name, mode, preset?, overrides?): BoberConfig` | Default-config factory; optionally add an `architect` default here. |
| `aggregateResults` | `src/contracts/eval-result.ts:97` | `(sprintId, round, results: EvalResult[]): SprintEvaluation` | Existing aggregate helper — NOT relevant to ranking; do not reuse for synthesize. |

Utilities reviewed: `src/utils/` (fs/git/logger — none applicable to a pure reducer or Zod schema). No existing ranking/synthesis helper exists — `synthesize` is genuinely new.

---

## 4. Prior Sprint Output

This plan has NO completed sprints. The directly-mirrored reference is the **evaluator lens panel** shipped earlier on this branch:
- `src/orchestrator/eval-lenses.ts` — exports `resolveLensFocus`; private `LENS_CATALOG`. **Connection:** arch-lenses.ts is a structural clone.
- `src/orchestrator/workflow/reconciler.ts` — exports `reconcile` (pure). **Connection:** synthesizer.ts is the sibling pure reducer (ranking, not pass/fail). Reconcile MUST stay untouched (nonGoal).
- `src/config/schema.ts:112-117` — `evaluator.panel` (added commit 5dc7a5e). **Connection:** architect.panel mirrors this exact Zod shape.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- ESM everywhere, `.js` import specifiers (NodeNext). No CommonJS.
- Zod for all config validation in `config/schema.ts`; runtime uses `z.parse()`.
- TS strict (`noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`); prefix unused params with `_` (see `reconcile`'s `_sprintId`, `_round`).
- ESLint `consistent-type-imports` enforced — use `import type`.
- Tests collocated as `*.test.ts` next to source.
- Unicode `// ── Section ──` headers.
- Conventional commit for sprints: `bober(sprint-N): ...`.

### Architecture Decisions
`reconciler.ts:5` references **ADR-4** (pure majority-vote reducer). synthesize() is its ranking-shaped sibling. No new ADR required this sprint.

---

## 6. Testing Patterns

### Unit Test Pattern — pure reducer
**Source:** `src/orchestrator/workflow/reconciler.test.ts:1-59`
```ts
import { describe, it, expect } from "vitest";
import { reconcile } from "./reconciler.js";
const TS = "2026-01-01T00:00:00.000Z"; // sentinel

describe("reconcile", () => {
  it("throws when lensVerdicts is empty", () => {
    expect(() => reconcile("s", 1, [], TS)).toThrow("reconcile: lensVerdicts must be non-empty");
  });
  it("unanimous pass (3/3) → passed=true", () => {
    const result = reconcile("s", 1, [lens(true), lens(true), lens(true)], TS);
    expect(result.passed).toBe(true);
  });
});
```
**For synthesizer.test.ts (C1) — cover:** clear winner (one approach with strictly higher total → `winner` + `ranking[0].approach` match), a tie resolved deterministically (two approaches equal total → lower-index `approaches` entry wins / appears first in ranking), dissent capture (a lens whose own top pick != winner appears in `dissent`). Use plain in-memory fixtures (no fs, no mocks).

### Unit Test Pattern — catalog/resolver
**Source:** `src/orchestrator/eval-lenses.test.ts:1-38`
```ts
import { describe, it, expect } from "vitest";
import { resolveLensFocus } from "./eval-lenses.js";

describe("resolveLensFocus — built-in lenses (C1)", () => {
  const BUILT_INS = ["correctness", "security", "regression", "quality"] as const;
  it("all four built-in fragments are mutually distinct", () => {
    const fragments = BUILT_INS.map((lens) => resolveLensFocus(lens));
    expect(new Set(fragments).size).toBe(4);
  });
});
describe("resolveLensFocus — unknown lens fallback (C1)", () => {
  it("unknown lens returns a generic fallback containing the lens name", () => {
    const result = resolveLensFocus("made-up");
    expect(result).toContain("made-up");
  });
  it("unknown lens does not throw", () => {
    expect(() => resolveLensFocus("completely-unknown-lens-xyz")).not.toThrow();
  });
});
```
**For arch-lenses.test.ts (C2):** import `resolveArchLensFocus` from `./arch-lenses.js`; `BUILT_INS = ["scalability","security","cost","operability","maintainability","reversibility"]`; assert each non-empty, all 6 mutually distinct (`new Set(...).size === 6`), unknown lens returns non-empty fallback containing the lens name and does not throw.

### Schema Test Pattern
**Source:** `src/config/schema.test.ts:1-32`
```ts
import { describe, it, expect } from "vitest";
import { PipelineSectionSchema, EvaluatorSectionSchema } from "./schema.js";

describe("EvaluatorSectionSchema.panel", () => {
  it("defaults panel to disabled/empty/4 when omitted", () => {
    const parsed = EvaluatorSectionSchema.parse({ strategies: [] });
    expect(parsed.panel).toEqual({ enabled: false, lenses: [], maxConcurrent: 4 });
  });
  it("rejects maxConcurrent < 1", () => {
    expect(() => EvaluatorSectionSchema.parse({ strategies: [], panel: { maxConcurrent: 0 } })).toThrow();
  });
});
```
**For schema.test.ts (C3) — add a `describe("ArchitectSectionSchema.panel", ...)` block:** import `ArchitectSectionSchema` from `./schema.js`; assert `ArchitectSectionSchema.parse({}).panel` equals `{ enabled: false, lenses: [], maxConcurrent: 4 }` (panel default when section omitted), rejects `maxConcurrent: 0`, and accepts a fully-specified enabled panel. Optionally assert `BoberConfigSchema` parses a config WITHOUT an `architect` key (since it's `.optional()`).

**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** none (pure). **File naming:** `<name>.test.ts` collocated. **Location:** collocated next to source.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/schema.test.ts` | `schema.ts` exports | low | New exports `ArchitectSectionSchema`/`ArchitectSection` added; existing tests unaffected. |
| 14 config literals (see below) | `BoberConfigSchema` typing | low IF `architect` is `.optional()`; HIGH if you make it required | If required, EVERY literal below needs an `architect:` block or tsc fails. |
| `src/orchestrator/eval-lenses.ts`, `reconciler.ts` | — | none (DO NOT TOUCH) | nonGoal: must be byte-identical in `git diff`. |

### The 14 config literals carrying `evaluator.panel` (the trap, ONLY relevant if `architect` is made REQUIRED)
- `src/config/defaults.ts:66, 92, 130, 143, 156, 170, 197, 239` (preset + brownfield/greenfield blocks)
- `src/config/loader.ts:209`
- `src/cli/commands/init.ts:645, 761, 894`
- `src/mcp/tools/init.ts:130, 225`

> With `architect: ArchitectSectionSchema.optional()` NONE of these need editing — confirm by running `npx tsc --noEmit`. If tsc flags any of them, that means `architect` ended up required somewhere; switch it to `.optional()`.

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — evaluator.panel + pipeline.engine defaults; unaffected by an additive optional section.
- `src/orchestrator/workflow/reconciler.test.ts` — reconcile behavior; must stay green (you are not touching reconciler).
- `src/orchestrator/eval-lenses.test.ts` — must stay green (not touching eval-lenses).
- `src/orchestrator/lens-panel-parity.test.ts` — skills/native drift gate; ensure you do NOT touch any `skills/` files (nonGoal) so it stays green.

### Recommended Regression Checks
1. `npx tsc --noEmit` (exit 0)
2. `npm run build` (exit 0)
3. `npx eslint src/` (exit 0 — verify `import type` and `_`-prefixed unused params)
4. `npx vitest run` (full suite green; only the documented pre-existing skipped baseline tolerated)
5. `git diff --stat src/orchestrator/workflow/reconciler.ts src/orchestrator/eval-lenses.ts` → must show NO changes.
6. Verify no `skills/` / `agents/` / `commands/` / orchestrator-wiring files changed.

---

## 8. Implementation Sequence

1. **src/orchestrator/workflow/synthesizer.ts** — define `SynthesisResult` interface + pure `synthesize()`. No imports needed. Document tie-break in JSDoc.
   - Verify: no `Date`/`Math.random`/`fs`; `winner === ranking[0].approach`; ranking sorted desc.
2. **src/orchestrator/workflow/synthesizer.test.ts** — winner / deterministic tie / dissent capture.
   - Verify: `npx vitest run src/orchestrator/workflow/synthesizer.test.ts` green.
3. **src/orchestrator/arch-lenses.ts** — private `ARCH_LENS_CATALOG` (6 lenses) + exported `resolveArchLensFocus` with generic fallback.
   - Verify: 6 distinct non-empty fragments; unknown lens returns fallback, no throw.
4. **src/orchestrator/arch-lenses.test.ts** — 6 distinct+non-empty, unknown fallback.
   - Verify: `npx vitest run src/orchestrator/arch-lenses.test.ts` green.
5. **src/config/schema.ts** — add `ArchitectSectionSchema` (+ `ArchitectSection` type) mirroring evaluator.panel; wire `architect: ArchitectSectionSchema.optional()` into `BoberConfigSchema`; optionally add an `architect` default block in `createDefaultConfig`.
   - Verify: `npx tsc --noEmit` clean — if any config literal is flagged, ensure `architect` is `.optional()`.
6. **src/config/schema.test.ts** — extend with an `ArchitectSectionSchema.panel` describe block (defaults, rejects maxConcurrent<1, accepts full panel, parses without the section).
   - Verify: `npx vitest run src/config/schema.test.ts` green.
7. **Run full verification** — `npx tsc --noEmit`, `npm run build`, `npx eslint src/`, `npx vitest run`.

---

## 9. Pitfalls & Warnings

- **The "architect config" does not exist yet.** Do NOT search for an existing `ArchitectSectionSchema` to extend — you must CREATE it. `pipeline.architectPhase` and `graph.preflightBudgets.architect` are unrelated.
- **Make `architect` OPTIONAL on `BoberConfigSchema`** to avoid editing 14 config literals. If you make it required, all literals at defaults.ts:66/92/130/143/156/170/197/239, loader.ts:209, init.ts:645/761/894, mcp/tools/init.ts:130/225 must gain an `architect:` block or tsc fails. Optional is the clean path and still satisfies C3 (omitted section → defaults via `.default(...)`).
- **DO NOT modify** `reconciler.ts` or `eval-lenses.ts` (explicit nonGoals). DO NOT wire anything into `runArchitect`/orchestrator, and DO NOT touch `skills/`/`agents/`/`commands/` (sprints 2-5).
- **Purity:** `Math.round`/`Math.max`/`Array.prototype.sort` are allowed; ONLY `Math.random`, `Date.now`, `new Date`, and `fs` are forbidden in synthesize().
- **Deterministic tie-break must be EXPLICIT.** Capture original index before sorting; do not rely on V8 sort stability across differing totals. Document "lower original approach index wins on equal total".
- **ESM `.js` specifiers** on every relative import in tests (`./synthesizer.js`, `./arch-lenses.js`, `./schema.js`) or NodeNext resolution / build fails.
- **`import type`** for type-only imports (eslint `consistent-type-imports` is a hard gate).
- **SynthesisResult lives in synthesizer.ts** (exported) — there is no shared contract for it; do NOT add it to `src/contracts/eval-result.ts` (that file is the pass/fail `EvalResult` shape, a different concern).
- **Conventional commit, explicit paths only:** `bober(sprint-1): add synthesize() reducer + arch-lens catalog + architect.panel config`. Never `git add -A`; never commit on main.
