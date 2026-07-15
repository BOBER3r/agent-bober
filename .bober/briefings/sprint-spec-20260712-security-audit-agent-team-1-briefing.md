# Sprint Briefing: Add security config section, audit result types, and .bober/security store

**Contract:** sprint-spec-20260712-security-audit-agent-team-1
**Generated:** 2026-07-12

> Foundation sprint (1 of 7). Pure typed scaffolding: one opt-in Zod config
> section, wrapper types over the LOCKED ReviewResult/ReviewFinding, a pure
> `deriveVerdict`, and a `.bober/security/` markdown store. No runtime behavior,
> no LLM, no CLI, no gate. Byte-identity when unconfigured is the dominant constraint.

---

## 1. Target Files

### src/config/schema.ts (modify)

Add `SecuritySectionSchema` next to the other role sections and wire ONE optional key onto `BoberConfigSchema`. The **closest existing sibling** is `CodeReviewSectionSchema` — copy its exact style (it already has `timeoutMs`, `enabled`, `model`, `maxTurns`, `provider/endpoint/providerConfig`).

**`CodeReviewSectionSchema` — the template to mirror (lines 189-198):**
```typescript
export const CodeReviewSectionSchema = z.object({
  timeoutMs: z.number().int().positive().default(300_000),
  enabled: z.boolean().default(true),
  model: ModelChoiceSchema.default("sonnet"),
  maxTurns: z.number().int().min(1).default(15),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type CodeReviewSection = z.infer<typeof CodeReviewSectionSchema>;
```

**Building blocks to REUSE (all already exported, verified):**
- `ModelChoiceSchema` — **line 19**: `export const ModelChoiceSchema = z.string().min(1);` (NOT an enum — the contract's "if it has a different name" caveat is moot; it exists under exactly this name and is what CodeReview/Curator sections use for `model`). Use `ModelChoiceSchema.default("opus")`.
- `BudgetSectionSchema` — **lines 48-51**: `z.object({ maxUsd: z.number().positive().nullable().optional() })`. Use `budget: BudgetSectionSchema.optional()`.
- `EvalStrategySchema` — **lines 74-88**: has `type/plugin/command/required/config/label`. Use `scanners: z.array(EvalStrategySchema).default([])`.
- Default-off `enabled` precedent: `EvaluatorSectionSchema.panel` at **line 146** (`enabled: z.boolean().default(false)`).

**Exact shape to add (per sc-1-1 + generatorNotes — include `standaloneBlockOn` and `hub` NOW to avoid re-touching the schema in sprints 4/6):**
```typescript
// ── Security Section (opt-in stack-aware audit; default-off) ──────────
export const SecuritySectionSchema = z.object({
  enabled: z.boolean().default(false),
  failClosed: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(300_000),
  model: ModelChoiceSchema.default("opus"),
  maxTurns: z.number().int().min(1).default(20),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  budget: BudgetSectionSchema.optional(),
  scanners: z.array(EvalStrategySchema).default([]),
  standaloneBlockOn: z.enum(["critical", "important"]).default("critical"),
  hub: z.boolean().default(true),
});
export type SecuritySection = z.infer<typeof SecuritySectionSchema>;
```

**Wiring onto `BoberConfigSchema` (block at lines 560-601)** — add near `codeReview` (line 570) / `documenter` (line 571):
```typescript
  codeReview: CodeReviewSectionSchema.optional(),
  documenter: DocumenterSectionSchema.optional(),
  // ── Security audit gate (opt-in) ──
  security: SecuritySectionSchema.optional(),   // <-- ADD. .optional(), NO top-level default.
```

**CRITICAL:** `.optional()` on the section, no default. Absent stays absent — a config with no `security` key must parse to `data.security === undefined`, never a materialized defaults object.

**Imports this file uses:** `import { z } from "zod";` (top of file — already present).
**Imported by:** ~56 modules import from `../config/schema.js` (mostly the `BoberConfig` type). Adding an OPTIONAL key is additive — no consumer breaks. Do NOT touch `createDefaultConfig` (line 625).
**Test file:** `src/config/schema.test.ts` (exists — modify).

---

### src/config/schema.test.ts (modify)

Add a `describe("BoberConfigSchema — security section is optional")` block mirroring the tools-section precedent (see §6). Use the `minimalBase` fixture idiom (lines 136-144).

---

### src/orchestrator/security-audit-types.ts (create)

**Directory pattern:** `src/orchestrator/*.ts`, kebab-case files, collocated `*.test.ts`.
**Most similar existing file:** the type block of `src/orchestrator/code-reviewer-agent.ts` (lines 12-37) — it defines `ReviewFinding`/`ReviewResult` with the same interface + unicode-box-comment style.
**Structure template:**
```typescript
import type { ReviewResult, ReviewFinding } from "./code-reviewer-agent.js";

// ── Vulnerability taxonomy ────────────────────────────────────────────
export type VulnClass =
  | "injection" | "authn-authz" | "secret-handling"
  | "input-validation" | "path-traversal" | "privilege-escalation";

// ── Wrapper types over the LOCKED ReviewResult/ReviewFinding ──────────
export interface SecurityFinding extends ReviewFinding {
  vulnClass?: VulnClass;              // MUST be optional
}

export interface SecurityAuditResult {
  review: ReviewResult;              // LOCKED shape; review.critical[] = blocking bucket
  stack: string;
  scannerRan: boolean;
  parsed: boolean;                   // false => auditor output unparseable; gate blocks
  verdict: "pass" | "blocked";       // derived from review.critical.length
}

// ── Pure verdict derivation (reused by core, gate, CLI in later sprints) ──
export function deriveVerdict(review: ReviewResult): "pass" | "blocked" {
  return review.critical.length > 0 ? "blocked" : "pass";
}
```
**MUST** use `import type` for `ReviewResult`/`ReviewFinding` (ESLint `consistent-type-imports` + evaluator greps for `import type`). Never redefine them.

---

### src/state/security-audit-state.ts (create)

**Most similar existing file:** `src/state/review-state.ts` — mirror it structurally 1:1, swapping `.bober/reviews` → `.bober/security` and the `-review.md` suffix → `-security-audit.md`.

**`review-state.ts` full pattern to mirror (the whole file, 66 lines):**
```typescript
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "./helpers.js";

const REVIEW_DIR = ".bober/reviews";
function reviewDir(projectRoot: string): string { return join(projectRoot, REVIEW_DIR); }
function reviewPath(projectRoot: string, contractId: string): string {
  const safeId = contractId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(reviewDir(projectRoot), `${safeId}-review.md`);
}
export async function saveReview(projectRoot, contractId, content): Promise<void> {
  await ensureDir(reviewDir(projectRoot));
  await writeFile(reviewPath(projectRoot, contractId), content, "utf-8");
}
export async function readReview(projectRoot, contractId): Promise<string | null> {
  try { return await readFile(reviewPath(projectRoot, contractId), "utf-8"); }
  catch { return null; }                     // read-of-missing → null, never throws
}
export async function listReviews(projectRoot): Promise<string[]> {
  let entries: string[];
  try { entries = await readdir(reviewDir(projectRoot)); } catch { return []; }
  return entries.filter((f) => f.endsWith("-review.md")).sort()
    .map((f) => f.slice(0, -("-review.md".length)));
}
```

**Key difference:** `saveSecurityAudit` takes a `SecurityAuditResult` (not a pre-rendered string) and renders it via `renderReviewMarkdown(result.review)`:
```typescript
import { renderReviewMarkdown } from "../orchestrator/code-reviewer-agent.js";
import type { SecurityAuditResult } from "../orchestrator/security-audit-types.js";

const SECURITY_DIR = ".bober/security";
// ...
export async function saveSecurityAudit(
  projectRoot: string, contractId: string, result: SecurityAuditResult,
): Promise<void> {
  await ensureDir(securityDir(projectRoot));
  const markdown = renderReviewMarkdown(result.review);
  await writeFile(securityPath(projectRoot, contractId), markdown, "utf-8");
}
```
Suffix: `${safeId}-security-audit.md`. `readSecurityAudit` returns `string | null`; `listSecurityAudits` filters `.endsWith("-security-audit.md")` and strips the suffix.

**Async-only:** use `node:fs/promises` — the evaluator greps for `readFileSync`/`writeFileSync` and will fail the sprint if found.
**Optional:** you MAY add the three exports to the `src/state/index.ts` barrel (review-state is re-exported there at lines 62-66) — not required by the contract.

---

## 2. Patterns to Follow

### Opt-in default-off section (Zod)
**Source:** `src/config/schema.ts`, lines 189-198 (`CodeReviewSectionSchema`) + 145-149 (panel `enabled:false`).
**Rule:** Model your section on `CodeReviewSectionSchema`; every field has a `.default(...)` or `.optional()`; the SECTION is wired `.optional()` with no top-level default.

### Type-only import of locked shapes
**Source:** `src/orchestrator/code-reviewer-agent.ts`, lines 1-3 (`import type { BoberConfig } from "../config/schema.js";`).
**Rule:** Import `ReviewResult`/`ReviewFinding` with `import type` from `./code-reviewer-agent.js` — never copy their definitions.

### Filesystem store (async, ensureDir-before-write, read→null)
**Source:** `src/state/review-state.ts`, lines 21-46.
**Rule:** `ensureDir` before every write; `try/catch → null` on read-of-missing; `try/catch → []` on list-of-missing-dir; `node:fs/promises` only.

### `renderReviewMarkdown` — REUSE, do not re-render
**Source:** `src/orchestrator/code-reviewer-agent.ts`, line 183 (`export function renderReviewMarkdown(review: ReviewResult): string`).
**Rule:** The store's `save` renders `result.review` through this exported function — do not write a second markdown renderer.

### Unicode box section comments
**Source:** `.bober/principles.md`, line 32; live example `code-reviewer-agent.ts:12` (`// ── Types ──…`).
**Rule:** Organize each new file with `// ── Section Name ──────` headers.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | `mkdir -p` — call before every store write |
| `renderReviewMarkdown` | `src/orchestrator/code-reviewer-agent.ts:183` | `(review: ReviewResult): string` | Renders the 6-section review markdown; the store reuses it for `result.review` |
| `ModelChoiceSchema` | `src/config/schema.ts:19` | `z.string().min(1)` | Model field type for the security section |
| `BudgetSectionSchema` | `src/config/schema.ts:48` | `z.object({ maxUsd? })` | Reused as `budget?` in the section |
| `EvalStrategySchema` | `src/config/schema.ts:74` | `z.object({ type, command?, required, … })` | Reused as `scanners: z.array(...)` |
| `ReviewResult` / `ReviewFinding` | `src/orchestrator/code-reviewer-agent.ts:17,27` | interfaces (type-only import) | LOCKED shapes the new types wrap |
| `saveReview`/`readReview`/`listReviews` | `src/state/review-state.ts:21,35,51` | store fns | The exact structure to mirror (do NOT edit review-state.ts) |

Directories reviewed: `src/state/` (helpers.ts, review-state.ts), `src/utils/` (logger/fs/git — none needed here), `src/config/` (schema building blocks). No generic string/markdown util applies beyond `renderReviewMarkdown`.

---

## 4. Prior Sprint Output

None — this is sprint 1 of 7 (`dependsOn: []`). It lays the typed foundation consumed by later sprints: `runSecurityAudit` (S2), the fail-closed gate (S3-4, uses `deriveVerdict` + `standaloneBlockOn`), the CLI (S4), and hub emission (S6, uses `hub`). Everything you export here (`SecuritySectionSchema`, `SecurityAuditResult`, `deriveVerdict`, `saveSecurityAudit`) is a downstream import surface — keep names exactly as the contract specifies.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` extensions** on all imports (line 26). NodeNext resolution.
- **Zod for config** — schemas in `config/schema.ts`, runtime via `z.parse()` (line 30).
- **Filesystem state** — mutable state as files under `.bober/` (line 32); no DB, no globals.
- **Section comments** — unicode box headers (line 32).
- **`import type`** enforced by ESLint `consistent-type-imports` (line 37).
- **Collocated tests** — `*.test.ts` next to source; tests run against real fs in temp dirs.
- **Strict TS gate** — `noUnusedLocals`, `noUnusedParameters`, `isolatedModules`; zero type/lint errors is a hard gate.

### Architecture Decisions (`.bober/architecture/arch-20260712-security-audit-agent-team-architecture.md`)
- **ADR-3:** persist audits to a SEPARATE `.bober/security/` store (not `.bober/reviews/`) — hence the distinct dir + `-security-audit.md` suffix.
- **Data model (lines 219-250):** authoritative shapes for `VulnClass`, `SecurityFinding`, `SecurityAuditResult`, `SecuritySection`. `verdict` is DERIVED (`review.critical.length > 0`), never stored independently.
- **Risk table (line 346):** `parsed:boolean` exists so the gate (S3) can treat unparseable output as a block — you only add the field here; the gate logic is out of scope.
- **Backward-compat HARD CONSTRAINT (line 24):** byte-identical when unconfigured, matching the evaluator-panel / medical-egress / telemetry default-off idiom.

### Other Docs
`README.md` present (project-level, no sprint-specific rules). No `CONTRIBUTING.md` rules beyond principles.md.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion:** `expect`. **Mock approach:** NONE for these files — repo convention is **real fs in temp dirs, no fs mocks**. **File naming:** `<name>.test.ts` collocated. **Location:** next to source.

### Config byte-identity / optional-absent test (THE key sc-1-2 template)
**Source:** `src/config/schema.test.ts`, lines 563-576 (tools-section precedent).
```typescript
describe("BoberConfigSchema — security section is optional", () => {
  it("parses a config without a security section (security is undefined)", () => {
    const result = BoberConfigSchema.safeParse(minimalBase); // fixture lines 136-144
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.security).toBeUndefined();
  });

  it("createDefaultConfig / absent-section config stays byte-identical (no security key)", () => {
    expect(Object.hasOwn(BoberConfigSchema.parse(minimalBase), "security")).toBe(false);
  });
});
```
**`minimalBase` fixture (reuse, lines 136-144):**
```typescript
const minimalBase = {
  project: { name: "test-project", mode: "greenfield" },
  planner: {}, generator: {}, evaluator: { strategies: [] },
  sprint: {}, pipeline: {}, commands: {},
};
```
For the STRONGER sc-1-2 proof the evaluator wants, deep-equal a full parse before/after conceptually: parse `minimalBase` and assert the result has no `security` key (`Object.hasOwn(...) === false`) AND that a section-present parse materializes the defaults. Also add positive tests: `SecuritySectionSchema.parse({})` → `enabled:false, failClosed:true, timeoutMs:300000, model:"opus", maxTurns:20, standaloneBlockOn:"critical", hub:true, scanners:[]`.

### Verdict table test (sc-1-3)
**Pattern:** plain table test, no fs.
```typescript
import { deriveVerdict } from "./security-audit-types.js";
const base = { reviewId:"r", contractId:"c", specId:"s", timestamp:"t",
  summary:"", critical:[], important:[], minor:[], approvedAreas:[] };
it.each([
  [[], [], "pass"],                                   // empty → pass
  [[{description:"x",evidence:[]}], [], "blocked"],   // critical → blocked
  [[], [{description:"y",evidence:[]}], "pass"],      // important-only → pass
])("deriveVerdict", (critical, important, expected) => {
  expect(deriveVerdict({ ...base, critical, important } as any)).toBe(expected);
});
```

### Store round-trip test in a temp dir (sc-1-4)
**Source (store-test template):** `src/state/approval-state.test.ts`, lines 9-33 (NOTE: `review-state.test.ts` does NOT exist — approval-state is the closest store test).
```typescript
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { saveSecurityAudit, readSecurityAudit, listSecurityAudits } from "./security-audit-state.js";

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-security-state-test-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });
```
**ReviewResult fixture to build a `SecurityAuditResult`** (adapt from `code-reviewer-agent.test.ts:260-280`):
```typescript
const review = { reviewId:"r", contractId:"c-1", specId:"s", timestamp:"2026-01-01T00:00:00.000Z",
  summary:"one critical", critical:[{description:"SQL injection",
  evidence:[{path:"src/db.ts",line:10,snippet:"query(`SELECT ${x}`)"}]}],
  important:[], minor:[], approvedAreas:[] };
const result = { review, stack:"node", scannerRan:false, parsed:true, verdict:"blocked" as const };
```
Assert: `save` then `read` returns markdown containing `"## Critical"`; `read` of a missing id returns `null` (not throw) — assert this EXPLICITLY per evaluatorNotes; `list` returns `["c-1"]`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/schema.ts` consumers (~56 modules import `../config/schema.js`) | `BoberConfig` type | low | Adding an OPTIONAL key is additive; existing `.parse()` calls unaffected |
| `src/config/loader.ts` (`loadConfig`) | `BoberConfigSchema` | low | Loader just re-parses; no security key in any fixture → `undefined` |
| `src/fleet/child-config.ts` | `BoberConfigSchema`, `createDefaultConfig` | low | `createDefaultConfig` untouched → child configs byte-identical |
| `src/orchestrator/code-reviewer-agent.ts` | (you IMPORT from it, read-only) | none | Type-only import + reusing exported `renderReviewMarkdown`; do NOT edit this file (locked) |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — the whole file; especially the optional-section idioms (tools 563-576, fleet 135-198, architect 80-115) and `createDefaultConfig` byte-identity assertions. Your change must not perturb any.
- `src/config/loader.test.ts` — writes real `bober.config.json` to temp dirs and calls `loadConfig`; must still parse.
- `src/fleet/child-config.test.ts`, `src/medical/*.test.ts`, `src/chat/chat-session.test.ts`, `src/cli/commands/update.test.ts` — all call `createDefaultConfig`; since you do NOT modify it, they stay green.
- `src/orchestrator/code-reviewer-agent.test.ts` — exercises `renderReviewMarkdown`; unaffected because you only import it.

### Features That Could Be Affected
- **Repo's own `bober.config.json`** (root, 1535 bytes) — has NO `security` key (verified: top-level keys are project/planner/curator/generator/evaluator/sprint/pipeline/commands/...). It MUST parse deep-equal before/after. This IS the sc-1-2 dogfood target — but do NOT edit it (dogfooding is sprint 7).
- **Code-reviewer advisory flow** — shares `renderReviewMarkdown` and the `ReviewResult` shape. Verify your reuse does not require any change to those (it doesn't).

### Recommended Regression Checks
1. `npm run build` — clean tsc output.
2. `npm run typecheck` — zero type errors (watch `isolatedModules`: `verdict: "blocked" as const` in fixtures).
3. `npm test -- src/config/schema.test.ts` — full config suite green, new + existing.
4. `npm test -- src/state/security-audit-state.test.ts src/orchestrator/security-audit-types.test.ts` — new suites green.
5. `npm test` — full suite, zero regressions.
6. ESLint on the 3 new + 1 modified file — zero errors (confirm `import type` used; no `readFileSync`/`writeFileSync`).

---

## 8. Implementation Sequence

1. **src/orchestrator/security-audit-types.ts** — `import type { ReviewResult, ReviewFinding }`; define `VulnClass`, `SecurityFinding`, `SecurityAuditResult`, and pure exported `deriveVerdict`.
   - Verify: `npx tsc --noEmit` resolves the type-only import; `deriveVerdict` has no side effects.
2. **src/orchestrator/security-audit-types.test.ts** — verdict table test (empty/critical/important-only).
   - Verify: `npm test -- security-audit-types` green; `vulnClass` proven optional.
3. **src/config/schema.ts** — add `SecuritySectionSchema` (mirror `CodeReviewSectionSchema`) + `SecuritySection` type; wire `security: SecuritySectionSchema.optional()` onto `BoberConfigSchema`. Do NOT touch `createDefaultConfig`.
   - Verify: `SecuritySectionSchema.parse({})` yields the documented defaults; `BoberConfigSchema` still parses `minimalBase` with `security === undefined`.
4. **src/config/schema.test.ts** — add the optional/byte-identity block + section-defaults test (mirror lines 563-587).
   - Verify: full `schema.test.ts` green including all pre-existing describes.
5. **src/state/security-audit-state.ts** — mirror `review-state.ts`; `.bober/security/`, `-security-audit.md`, render via `renderReviewMarkdown(result.review)`.
   - Verify: no sync fs calls; `read` of missing → `null`.
6. **src/state/security-audit-state.test.ts** — temp-dir round-trip (mirror `approval-state.test.ts` setup); explicit read-of-missing → null.
   - Verify: `npm test -- security-audit-state` green.
7. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test`, ESLint on changed files (all §7 checks).

---

## 9. Pitfalls & Warnings

- **`.optional()` NOT `.default({})`** on the `security` wiring. A top-level default would materialize `security` on every parse and break byte-identity (sc-1-2). Test with `Object.hasOwn(parsed, "security") === false`, not just `toBeUndefined()`.
- **Do NOT edit `createDefaultConfig` (schema.ts:625)** or any preset — opt-in only (non-goal). Do NOT edit the root `bober.config.json` (dogfooding = sprint 7).
- **`ModelChoiceSchema` is `z.string().min(1)`, not an enum** (line 19). `.default("opus")` is valid — no enum membership check. The contract's "if it has a different name" hedge does not apply; the name is exactly `ModelChoiceSchema`.
- **`ReviewResult`/`ReviewFinding` are LOCKED.** Import them `import type` from `./code-reviewer-agent.js` — the evaluator greps for `import type`; a value import or a redefinition fails the sprint.
- **`vulnClass` MUST be optional** (`vulnClass?`). The evaluator checks this explicitly.
- **Async fs only** — `node:fs/promises`. The evaluator greps `readFileSync`/`writeFileSync` in the new files; any hit fails sc-1-5.
- **`.js` import extensions** on ALL relative imports (`./code-reviewer-agent.js`, `./helpers.js`, `../orchestrator/security-audit-types.js`) — NodeNext requires them even though the source is `.ts`.
- **`isolatedModules` + `verdict` literal:** in test/impl object literals, annotate `verdict: "blocked" as const` (or via the typed variable) so `"pass" | "blocked"` narrows correctly.
- **`renderReviewMarkdown` takes a `ReviewResult`, not `SecurityAuditResult`** — pass `result.review`, not `result`.
- **Store filename suffix must be exactly `-security-audit.md`** and `listSecurityAudits` strips exactly that suffix (mirror the `-review.md` slice arithmetic in review-state.ts:64).
- **`review-state.test.ts` does not exist** — use `src/state/approval-state.test.ts` as the store-test template (mkdtemp/rm, beforeEach/afterEach).
