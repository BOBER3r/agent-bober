# Sprint Briefing: Test-gap (cadence) suggestions + cross-marker dig-deeper offers

**Contract:** sprint-spec-20260628-medical-analysis-4
**Generated:** 2026-06-28T00:00:00.000Z

---

## 0. Mission (read first)

Extend the sprint-1 **offline, zero-LLM, deterministic** proactive review pass with TWO new analyzers, plus a separate gated dig-deeper path:

1. **`cadence.ts`** — `detectTestGaps(store, biomarkers, {now})` over a **CLOSED** `RECOMMENDED_CADENCE_DAYS` table. Biomarkers ABSENT from the table are **SKIPPED** (no guessed cadence — mirror the closed-whitelist discipline of `NumericPrimitive`).
2. **`cross-marker.ts`** — `detectCrossMarkerPatterns(store, {now})` over a CLOSED `CROSS_MARKER_PAIRS` list; OFFERS a `kind:"question"` "want me to dig deeper?" finding when BOTH markers of a pair are out of reference range. **NO LLM call.** The offer finding must persist its marker pair so dig-deeper can recover it (sc-4-6).
3. **`review-pass.ts`** — `runProactiveReview` now emits trend + gap + offer findings in ONE offline pass. Add a `digDeeper(...)` helper that loads an offer finding, extracts its marker pair, and **DELEGATES to sprint-3 `generateRecommendation`** (the ONLY LLM step).
4. **`medical.ts`** — add `--dig-deeper <findingId>` to the existing `review` subcommand.

### THE FOUR INVARIANTS (do not violate)
- **(a) ZERO-LLM / zero-network in detection.** `cadence.ts` and `cross-marker.ts` import NO provider/network. Only the explicit `--dig-deeper` flag crosses the gate (via `generateRecommendation`). Evaluator asserts the injected LLM spy is NEVER called during offer/gap detection (sc-4-4).
- **(b) CLOSED cadence table.** Unknown biomarkers produce NO gap finding (sc-4-3). No default cadence.
- **(c) Offer finding PERSISTS its marker pair** in frontmatter so dig-deeper maps `findingId -> markers` (sc-4-6). Use the `tags[]` array (already serialized + parseable round-trip).
- **(d) DISTINCT `ruleKey` per analyzer** so new finding ids do NOT collide with sprint-1 trend ids and do NOT break sprint-1 idempotency tests (review-pass.test.ts sc-1-4).
- **NO-TOUCH:** `src/medical/engine.ts` must be unchanged (evaluator checks this).

---

## 1. Target Files

### src/medical/analysis/cadence.ts (create)

**Directory pattern:** `src/medical/analysis/` uses kebab-case filenames, named exports, a doc-comment header declaring purity, collocated `*.test.ts`.
**Most similar existing file:** `src/medical/analysis/trends.ts` (a pure synchronous analyzer returning `MedicalFinding[]`). Follow its shape exactly: import `findingId` + types from `./finding.js`, build findings via a small `makeFinding` helper, distinct `ruleKey`.

**Structure template (model on trends.ts:32-54 + 182-238):**
```ts
import type { HealthDataStore } from "../health-store.js";
import { findingId } from "./finding.js";
import type { MedicalFinding } from "./finding.js";

/** CLOSED recommended re-test cadence in days, keyed by biomarker.
 *  Extending this is a code-review event (mirror NumericPrimitive at types.ts:142).
 *  Biomarkers absent here are SKIPPED — no guessed cadence (sc-4-3). */
export const RECOMMENDED_CADENCE_DAYS: Readonly<Record<string, number>> = {
  ldl: 365,
  hba1c: 180,
  tsh: 365,
  vitamin_d: 365,
  ferritin: 365,
};

const MS_PER_DAY = 86_400_000;

/** PURE except store reads. NO network / NO LLM / NO Date.now(). 'now' is injected. */
export function detectTestGaps(
  store: HealthDataStore,
  biomarkers: string[],
  opts: { now: string },
): MedicalFinding[] {
  const findings: MedicalFinding[] = [];
  for (const biomarker of biomarkers) {
    const cadenceDays = RECOMMENDED_CADENCE_DAYS[biomarker];
    if (cadenceDays === undefined) continue;          // (b) CLOSED — skip unknown
    const series = store.getLabSeries(biomarker);     // ASC by collected_at
    const latest = series[series.length - 1];
    if (latest === undefined) continue;               // no data → no gap
    const ageDays = (Date.parse(opts.now) - Date.parse(latest.collectedAtIso)) / MS_PER_DAY;
    if (ageDays > cadenceDays) {
      findings.push(/* makeFinding(...) with ruleKey "cadence-gap", kind "question" */);
    }
  }
  return findings;
}
```
**Imports this file uses:** `HealthDataStore` (type), `findingId`, `MedicalFinding`.
**Test file:** `src/medical/analysis/cadence.test.ts` — does NOT exist (create).

---

### src/medical/analysis/cross-marker.ts (create)

**Most similar existing file:** `src/medical/analysis/trends.ts` (reads reference range from the latest `getLabSeries` row, see trends.ts:198-202).

**Structure template:**
```ts
import type { HealthDataStore } from "../health-store.js";
import { findingId } from "./finding.js";
import type { MedicalFinding } from "./finding.js";

/** CLOSED list of related-marker pairs (code-review to extend). */
export const CROSS_MARKER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["ldl", "triglycerides"],
  ["hba1c", "triglycerides"],
];

/** True when the marker's LATEST result is outside [referenceLow, referenceHigh]. */
function isOutOfRange(store: HealthDataStore, marker: string): boolean {
  const series = store.getLabSeries(marker);
  const latest = series[series.length - 1];
  if (latest === undefined) return false;
  const { value, referenceLow, referenceHigh } = latest;
  if (referenceHigh !== undefined && value > referenceHigh) return true;
  if (referenceLow !== undefined && value < referenceLow) return true;
  return false;
}

/** PURE except store reads. NO LLM / NO network. OFFERS only — never runs the analysis. */
export function detectCrossMarkerPatterns(
  store: HealthDataStore,
  opts: { now: string },
): MedicalFinding[] {
  const findings: MedicalFinding[] = [];
  for (const [a, b] of CROSS_MARKER_PAIRS) {
    if (isOutOfRange(store, a) && isOutOfRange(store, b)) {
      // (c) persist the marker pair in tags so dig-deeper can recover it:
      //   tags: ["cross-marker", a, b]
      // ruleKey MUST embed the pair so distinct pairs get distinct ids, e.g. `cross-marker-${a}-${b}`
      findings.push(/* makeFinding(... kind:"question", tags:["cross-marker", a, b]) */);
    }
  }
  return findings;
}
```
**Test file:** `src/medical/analysis/cross-marker.test.ts` — does NOT exist (create).

---

### src/medical/analysis/review-pass.ts (modify)

**Current `runProactiveReview` (review-pass.ts:45-100) — extend the analyzer block ONLY.** The store-lifecycle / vault-resolve / dashboard / finally-close logic MUST be preserved verbatim (sc-1-4 idempotency depends on it):
```ts
// review-pass.ts:71-88 — the section to extend
const biomarkers =
  opts.biomarkers !== undefined && opts.biomarkers.length > 0
    ? opts.biomarkers
    : store.listBiomarkers();

const findings = analyzeTrends(store, biomarkers, { now: opts.now });   // KEEP

// Write one finding note per detected condition
const findingPaths: string[] = [];
for (const finding of findings) {
  const path = await writeFinding(vaultDir, finding);
  findingPaths.push(path);
}

const dashboardPath = await writeDashboard(vaultDir);   // KEEP (always — sc-1-5)
```
**Extension plan (minimal, additive):**
```ts
import { detectTestGaps } from "./cadence.js";
import { detectCrossMarkerPatterns } from "./cross-marker.js";
// ...
const findings = [
  ...analyzeTrends(store, biomarkers, { now: opts.now }),
  ...detectTestGaps(store, biomarkers, { now: opts.now }),
  ...detectCrossMarkerPatterns(store, { now: opts.now }),
];
```
> Note: sprint-1 test review-pass.test.ts seeds ONLY `ldl @ 2026-01-01` value 160 ref 130 with `now=2026-06-28` and asserts `findingsWritten >= 1` and a STABLE file count across two runs. Since `ldl` IS in the cadence table and `2026-01-01 -> 2026-06-28` is ~178 days (< 365), it will NOT add a gap finding there — but it WILL still add the trend finding. Idempotency holds because every new ruleKey is deterministic and excludes `now`. **Do NOT regress the existing assertions.** The `>= 1` and "same file count on rerun" assertions stay green.

**`digDeeper` helper to ADD (gated LLM path — the ONLY network step):**
```ts
import { readFile } from "node:fs/promises";
import { parseFrontmatter } from "../../vault/frontmatter.js";
import { generateRecommendation } from "../recommend/recommend.js";
import type { RecommendDeps, RecommendOutcome } from "../recommend/recommend.js";

export interface DigDeeperDeps {
  /** Injected for sc-4-6 spy — defaults to the real generateRecommendation. */
  generateRecommendation?: typeof generateRecommendation;
  recommendDeps?: RecommendDeps;   // forwarded to generateRecommendation for its own test deps
}

export async function digDeeper(
  projectRoot: string,
  config: BoberConfig,
  findingId: string,
  opts: { now: string },
  deps: DigDeeperDeps = {},
): Promise<RecommendOutcome> {
  const vaultDir = config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault");
  const notePath = join(vaultDir, "findings", `${findingId}.md`);
  const raw = await readFile(notePath, "utf-8");
  const { frontmatter } = parseFrontmatter(raw);
  const tags = (frontmatter.tags as string[] | undefined) ?? [];
  const pair = tags.filter((t) => t !== "cross-marker");   // recover [markerA, markerB]
  const question = `The markers ${pair.join(" and ")} are both out of reference range. Dig deeper into what that combination suggests.`;
  const gen = deps.generateRecommendation ?? generateRecommendation;
  return gen(projectRoot, config, { question, now: opts.now }, deps.recommendDeps);
}
```
**Imported by:** `src/cli/commands/medical.ts:29` (`import { runProactiveReview } ...`) — add `digDeeper` to that import.
**Test file:** `src/medical/analysis/review-pass.test.ts` (EXISTS — extend, do not rewrite).

---

### src/cli/commands/medical.ts (modify)

**Current `review` subcommand (medical.ts:351-374):**
```ts
medicalCmd
  .command("review")
  .description("Run the deterministic proactive trend review pass and write Finding notes + dashboard")
  .action(async () => {
    const projectRoot = await resolveRoot();
    try {
      const config = await loadConfig(projectRoot);
      const now = new Date().toISOString();              // clock read ONLY at CLI boundary
      const result = await runProactiveReview(projectRoot, config, { now });
      process.stdout.write(chalk.green(`Proactive review complete\n`));
      process.stdout.write(`  findings written: ${result.findingsWritten}\n`);
      process.stdout.write(`  dashboard:        ${result.dashboardPath}\n`);
    } catch (err) {
      process.stderr.write(chalk.red(`Failed to run review: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;                              // MUST NOT throw
    }
  });
```
**Extension:** add `.option("--dig-deeper <id>", "run deeper cross-marker analysis for an offer finding id")` and branch in the action:
```ts
.option("--dig-deeper <id>", "run the deeper cross-marker analysis for the given offer finding id")
.action(async (opts: { digDeeper?: string }) => {
  const projectRoot = await resolveRoot();
  try {
    const config = await loadConfig(projectRoot);
    const now = new Date().toISOString();
    if (opts.digDeeper !== undefined) {
      const outcome = await digDeeper(projectRoot, config, opts.digDeeper, { now });
      // print outcome.kind / findingPath (mirror the recommend action at medical.ts:394-411)
      return;
    }
    const result = await runProactiveReview(projectRoot, config, { now });
    // counts now include gap + offer findings (they flow through findingsWritten)
    ...
  } catch (err) { process.exitCode = 1; }
});
```
> commander maps `--dig-deeper` to `opts.digDeeper` (camelCase). The `review` action currently takes no args — add the `opts` param.

---

## 2. Patterns to Follow

### Deterministic finding id derivation (id excludes `now`)
**Source:** `src/medical/analysis/finding.ts:65-70`
```ts
export function findingId(domain: string, biomarker: string, ruleKey: string): string {
  return createHash("sha256")
    .update(`${domain}|${biomarker}|${ruleKey}`)
    .digest("hex")
    .slice(0, 16);
}
```
**Rule:** Every analyzer builds its id via `findingId("medical", biomarker, ruleKey)` with a DISTINCT `ruleKey` (trends use `rule-a-*`/`rule-b-*`; use `cadence-gap` for gaps and `cross-marker-${a}-${b}` for offers) so ids never collide and re-runs are idempotent.

### `makeFinding` helper shape (copy this exact MedicalFinding field set)
**Source:** `src/medical/analysis/trends.ts:32-54`
```ts
function makeFinding(biomarker, ruleKey, title, kind, urgency, severity, evidence, now): MedicalFinding {
  return {
    id: findingId("medical", biomarker, ruleKey),
    domain: "medical", title, kind, urgency, severity, evidence,
    surfacedAt: now,                 // INJECTED — never wall-clock
    tags: ["lab-trend", biomarker],  // <-- cross-marker uses tags: ["cross-marker", a, b]
    status: "open",
  };
}
```
**Rule:** Reuse this exact object shape. For cross-marker, the `tags` array is the channel that persists the marker pair (sc-4-6).

### Frontmatter round-trip (offer pair recovery)
**Source:** serialize `src/medical/analysis/finding.ts:83-95` (emits `tags` as an array); parse `src/vault/frontmatter.ts:53-135` (block-list `- item` -> `string[]`).
**Rule:** `serializeFindingToMarkdown` writes `tags:` as a YAML block list; `parseFrontmatter` reads it back into a `string[]`. dig-deeper reads `frontmatter.tags`, drops the `"cross-marker"` sentinel, and the remainder is `[markerA, markerB]`.

### Lab row timestamp field name
**Source:** `src/medical/types.ts:118-127` (`LabResult.collectedAtIso`) + `src/medical/health-store.ts:91-101` (`rowToLabResult` maps `collected_at` -> `collectedAtIso`).
**Rule:** `getLabSeries` returns rows ordered `collected_at ASC` (health-store.ts:196-206); the latest is `series[series.length - 1]`; its timestamp field is **`collectedAtIso`** (ISO-8601 string). Compute gap via `Date.parse(now) - Date.parse(latest.collectedAtIso)`.

### CLI must never throw (set exitCode)
**Source:** `src/cli/commands/medical.ts:366-373`
**Rule:** Wrap the action body in try/catch and set `process.exitCode = 1` on error; never re-throw. dig-deeper must exit 0 on a normal outcome (sc-4-7).

### Clock read ONLY at CLI boundary
**Source:** `src/cli/commands/medical.ts:361` (`const now = new Date().toISOString();`)
**Rule:** All analyzers and `digDeeper` take `now` as an injected param. `new Date()` appears ONLY in the CLI `.action()`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `findingId` | `src/medical/analysis/finding.ts:65` | `(domain, biomarker, ruleKey): string` | Deterministic 16-hex finding id (excludes `now`). REUSE for both new analyzers. |
| `MedicalFinding` / `FindingKind` | `src/medical/analysis/finding.ts:26,36` | type | Finding shape; kinds are `"action"\|"watch"\|"risk"\|"question"`. |
| `serializeFindingToMarkdown` | `src/medical/analysis/finding.ts:83` | `(finding): string` | Writes frontmatter incl. `tags[]` (used to persist the offer pair). |
| `writeFinding` | `src/medical/analysis/finding-writer.ts:27` | `(vaultDir, finding): Promise<string>` | Writes `<vaultDir>/findings/<id>.md`. review-pass already loops over this. |
| `writeDashboard` | `src/medical/analysis/finding-writer.ts:62` | `(vaultDir): Promise<string>` | Always-written Dataview dashboard (sc-1-5). |
| `HealthDataStore.getLabSeries` | `src/medical/health-store.ts:196` | `(biomarker): LabResult[]` (ASC by collected_at) | Source of the latest `collectedAtIso` + reference range. |
| `HealthDataStore.listBiomarkers` | `src/medical/health-store.ts:268` | `(): string[]` | Enumerates distinct biomarkers (review-pass default). |
| `HealthDataStore.upsertLabResult` | `src/medical/health-store.ts:212` | `(LabResult): number` | Seed labs in tests (`:memory:`). |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw): {frontmatter, body}` | dig-deeper reads back the offer note to recover the marker pair. |
| `generateRecommendation` | `src/medical/recommend/recommend.ts:108` | `(projectRoot, config, {question, goal?, now}, deps?): Promise<RecommendOutcome>` | The sprint-3 gated LLM judge loop. dig-deeper DELEGATES here — do NOT re-implement. |
| `RecommendDeps` / `RecommendOutcome` | `src/medical/recommend/recommend.ts:66,50` | type | dig-deeper forwards/returns these. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path): Promise<void>` | Used by review-pass/finding-writer (already wired). |
| `EgressGuard` | `src/medical/egress.ts:18,35` | `new EgressGuard(...)`, `.isAllowed(axis)` | The gate `generateRecommendation` consults; NOT needed in the offline analyzers. |

Utilities reviewed: `src/utils/`, `src/medical/analysis/`, `src/medical/recommend/`, `src/vault/`. The above covers every helper the sprint needs — build NO new id/finding/store/frontmatter helpers.

---

## 4. Prior Sprint Output

### Sprint 1 (307e5e7): src/medical/analysis/
**Created:** `review-pass.ts` (`runProactiveReview`, `ProactiveReviewResult`), `trends.ts` (`analyzeTrends`), `finding.ts` (`findingId`, `MedicalFinding`, `serializeFindingToMarkdown`), `finding-writer.ts` (`writeFinding`, `writeDashboard`). Also `HealthDataStore.listBiomarkers` + `getLabSeries`.
**Connection:** Sprint 4 EXTENDS `runProactiveReview` to also run `detectTestGaps` + `detectCrossMarkerPatterns`, reusing `finding.ts`/`finding-writer.ts` unchanged. New ruleKeys keep idempotency tests green.

### Sprint 3 (3b2abb9): src/medical/recommend/
**Created:** `recommend.ts` — `generateRecommendation(projectRoot, config, {question, goal?, now}, deps?)` returning `RecommendOutcome {kind, findingPath?, cannedResponse?, reason?}`. Internally builds tier-diverse/local clients gated by `egress.isAllowed("cloud-inference")` and runs `runJudgeLoop`.
**Connection:** `digDeeper` IMPORTS and CALLS `generateRecommendation` (NonGoal #4: do NOT duplicate the judge loop). The sc-4-6 test injects a spy in its place to assert delegation with the recovered marker pair.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` was read for this sprint. Purity discipline is documented INLINE in every analyzer header (e.g. trends.ts:1-19, finding.ts:1-14, review-pass.ts:1-13): "PURE / NO network / NO LLM / NO Date.now()". Follow it.

### Architecture Decisions (cited from contract + code)
- **ADR-3 closed whitelist** — `NumericPrimitive` at `src/medical/types.ts:142` is the discipline model: extending the set is a code-review event, not a runtime/model decision. The cadence table and cross-marker pairs MUST follow this (CLOSED, exported `const`, extend only via code review). (Contract nonGoals + assumptions.)
- **ADR-4 deterministic ids** — finding ids and lab ids are SHA-256 slices over stable content; `now` is never part of the id (finding.ts:54-70, health-store.ts:24-53).
- **Egress gating** — only `--dig-deeper` may cross into the LLM/network path; it inherits sprint-3's `EgressGuard` fail-closed behaviour through `generateRecommendation` (recommend.ts:117, 141, 200-211).

### Other Docs
`engine.ts` is NO-TOUCH (contract evaluatorNotes; recommend.ts:14 "engine.ts is NO-TOUCH"). Do not import from or modify it.

---

## 6. Testing Patterns

### Unit Test Pattern — :memory: store, injected now (gap + cross-marker detection)
**Source:** `src/medical/analysis/trends.test.ts:1-58`
```ts
import { describe, it, expect, afterEach } from "vitest";
import { HealthDataStore } from "../health-store.js";
import { detectTestGaps } from "./cadence.js";

const NOW = "2026-06-28T12:00:00.000Z";
let store: HealthDataStore;
afterEach(() => { store?.close(); });

it("sc-4-2: flags ldl overdue vs cadence", () => {
  store = new HealthDataStore(":memory:");
  store.upsertLabResult({                       // collected >365d before NOW
    biomarker: "ldl", value: 100, unit: "mg/dL",
    collectedAtIso: "2024-01-01T08:00:00.000Z", referenceHigh: 130,
  });
  const findings = detectTestGaps(store, ["ldl"], { now: NOW });
  expect(findings).toHaveLength(1);
  expect(findings[0]!.title.toLowerCase()).toContain("ldl");
});

it("sc-4-3: biomarker absent from cadence table yields no gap", () => {
  store = new HealthDataStore(":memory:");
  store.upsertLabResult({
    biomarker: "some_obscure_marker", value: 1, unit: "x",
    collectedAtIso: "2000-01-01T00:00:00.000Z",
  });
  expect(detectTestGaps(store, ["some_obscure_marker"], { now: NOW })).toHaveLength(0);
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** real `:memory:` store + injected `now`; NO module mocking. **File naming:** `<name>.test.ts` collocated. **Location:** co-located in `src/medical/analysis/`.

### Cross-marker offer — assert NO LLM call (sc-4-4)
Since `detectCrossMarkerPatterns` imports no client, the strongest assertion is structural (it CANNOT call an LLM). For the explicit spy-style assertion the contract asks for, run the offer through `runProactiveReview` (or call detect directly) and assert a spy that would represent the LLM was never invoked. Pattern for an injected spy that must NOT be called comes from `recommend.test.ts:298-321`:
```ts
import { vi } from "vitest";
const llmSpy = vi.fn();                 // stand-in; detection must never touch it
store = new HealthDataStore(":memory:");
store.upsertLabResult({ biomarker: "ldl", value: 200, unit: "mg/dL",
  collectedAtIso: "2026-03-01T08:00:00.000Z", referenceHigh: 130 });
store.upsertLabResult({ biomarker: "triglycerides", value: 400, unit: "mg/dL",
  collectedAtIso: "2026-03-01T08:00:00.000Z", referenceHigh: 150 });
const offers = detectCrossMarkerPatterns(store, { now: NOW });
expect(offers).toHaveLength(1);
expect(offers[0]!.kind).toBe("question");
expect(offers[0]!.evidence.join(" ")).toContain("ldl");          // references BOTH
expect(offers[0]!.evidence.join(" ")).toContain("triglycerides");
expect(offers[0]!.tags).toEqual(expect.arrayContaining(["cross-marker", "ldl", "triglycerides"]));
expect(llmSpy).not.toHaveBeenCalled();
```

### dig-deeper delegates to generateRecommendation (sc-4-6) — injected spy
**Pattern source:** `recommend.test.ts:298-327` (vi.fn spy, assert called/NOT called) + `review-pass.test.ts:34-48` (file-backed seed + write the offer note to disk first).
```ts
import { vi } from "vitest";
import { digDeeper } from "./review-pass.js";

it("sc-4-6: dig-deeper delegates to generateRecommendation with the marker pair", async () => {
  // 1. seed + run review so a cross-marker offer note exists on disk
  const store = new HealthDataStore(":memory:");
  store.upsertLabResult({ biomarker:"ldl", value:200, unit:"mg/dL",
    collectedAtIso:"2026-03-01T08:00:00.000Z", referenceHigh:130 });
  store.upsertLabResult({ biomarker:"triglycerides", value:400, unit:"mg/dL",
    collectedAtIso:"2026-03-01T08:00:00.000Z", referenceHigh:150 });
  const res = await runProactiveReview(tmpRoot, MINIMAL_CONFIG, { now: NOW, store });
  store.close();
  // find the offer id (kind question with both markers) — read its file or compute via findingId
  const offerId = /* findingId("medical", "ldl", "cross-marker-ldl-triglycerides") or scan findingPaths */;

  // 2. inject a spy in place of generateRecommendation
  const genSpy = vi.fn(async () => ({ kind: "accepted", findingPath: "/x" }));
  const outcome = await digDeeper(tmpRoot, MINIMAL_CONFIG, offerId, { now: NOW },
    { generateRecommendation: genSpy });

  expect(genSpy).toHaveBeenCalledTimes(1);
  const [, , callOpts] = genSpy.mock.calls[0]!;
  expect(callOpts.question).toContain("ldl");
  expect(callOpts.question).toContain("triglycerides");
});
```
> `runProactiveReview` test harness (tmpRoot via `mkdtemp`, `MINIMAL_CONFIG = {} as BoberConfig`, `NOW`) already exists in `review-pass.test.ts:13-26` — reuse it.

### sc-4-5: one pass emits all three kinds
Seed a store with (i) `ldl` out of range AND >365d old (trend + gap), and (ii) `triglycerides` out of range AND old, so all of trend/gap/cross-marker-offer fire; assert `result.findingsWritten` covers trend + gap + offer and that the written notes include a `kind: question` cross-marker note. Use the file-backed `seedFileStore` style (review-pass.test.ts:34-48) or an injected `:memory:` store.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/medical.ts:29` | `runProactiveReview` (review-pass.ts) | medium | Adding `digDeeper` export + `--dig-deeper` option must not change the no-flag `review` behaviour; counts still print. |
| `src/medical/analysis/review-pass.test.ts` | `review-pass.ts` exports/behaviour | high | sc-1-4 idempotency + stable file-count tests MUST stay green; `ldl @2026-01-01` seed must not gain a gap finding (~178d < 365d). |
| `src/medical/recommend/recommend.ts` | imported by new `digDeeper` | low | Read-only import of `generateRecommendation`; signature unchanged. |
| `src/medical/analysis/finding.ts` / `finding-writer.ts` | reused unchanged | low | No edits; new analyzers consume them as-is. |

### Existing Tests That Must Still Pass
- `src/medical/analysis/review-pass.test.ts` — sc-1-4 idempotency (lines 138-177): same `now` + same store → identical file count/paths across two runs. New analyzers add deterministic, `now`-independent ids, so this holds; verify the `ldl`-only seed still yields `findingsWritten >= 1` and stable counts.
- `src/medical/analysis/trends.test.ts` — sprint-1 trend rules; untouched (`analyzeTrends` unchanged), must still pass.
- `src/medical/recommend/recommend.test.ts` — sprint-3 judge loop; `generateRecommendation` signature/behaviour must NOT change.

### Features That Could Be Affected
- **Proactive review (sprint 1)** — shares `runProactiveReview`; verify trend output is byte-identical when no gap/offer fires.
- **Recommendation (sprint 3)** — shares `generateRecommendation`; dig-deeper is a NEW caller; verify it passes a `{question, now}` shape and forwards optional `deps`.

### Recommended Regression Checks
1. `npx tsc --noEmit` (or the project build) — zero type errors (sc-4-1).
2. `npx vitest run src/medical/analysis/` — new + existing analysis tests pass.
3. `npx vitest run src/medical/recommend/` — sprint-3 suite unaffected.
4. `npx vitest run` — full suite, no new failures (stopCondition).
5. `git diff --stat src/medical/engine.ts` — MUST be empty (evaluator: engine.ts unchanged).
6. Grep new files for provider/network imports — `grep -nE "providers/|fetch|http|EgressGuard|createClient" src/medical/analysis/cadence.ts src/medical/analysis/cross-marker.ts` must return NOTHING (zero-LLM detection).

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/medical/analysis/cadence.ts** — closed `RECOMMENDED_CADENCE_DAYS` + `detectTestGaps` (ruleKey `cadence-gap`, kind `question`).
   - Verify: imports only `health-store` (type) + `finding`; `tsc` clean; no network/provider import.
2. **src/medical/analysis/cross-marker.ts** — closed `CROSS_MARKER_PAIRS` + `detectCrossMarkerPatterns` (ruleKey `cross-marker-${a}-${b}`, kind `question`, `tags:["cross-marker",a,b]`, evidence names both).
   - Verify: tags carry the pair; `tsc` clean; no network/provider import.
3. **src/medical/analysis/review-pass.ts** — splice both analyzers into the `findings` array (additive); add `digDeeper` helper (reads offer note, recovers pair, delegates to `generateRecommendation`, injectable for tests).
   - Verify: existing review-pass.test.ts still passes; `findingsWritten` now includes gap/offer.
4. **src/cli/commands/medical.ts** — add `--dig-deeper <id>` option to the `review` subcommand; route to `digDeeper`; plain `review` prints counts (now incl. gaps/offers). Clock read only here.
   - Verify: `review` no-flag unchanged; never throws (exitCode pattern).
5. **Tests** — `cadence.test.ts` (sc-4-2, sc-4-3), `cross-marker.test.ts` (sc-4-4), extend `review-pass.test.ts` (sc-4-5 one-pass-three-kinds, sc-4-6 dig-deeper spy delegation).
   - Verify: all new tests pass; existing idempotency tests green.
6. **Run full verification** — `npx tsc --noEmit`, `npx vitest run`, confirm `engine.ts` untouched.

---

## 9. Pitfalls & Warnings

- **(a) ZERO-LLM in detection.** Do NOT import `createClient`, `EgressGuard`, `buildMedicalInferenceClient`, or anything from `../recommend/` into `cadence.ts` or `cross-marker.ts`. The ONLY place that touches the LLM is `digDeeper` (in review-pass.ts) via `generateRecommendation`. The evaluator greps for this.
- **(b) CLOSED table, no default.** In `detectTestGaps`, look up `RECOMMENDED_CADENCE_DAYS[biomarker]`; if `undefined`, `continue`. Never apply a fallback cadence (sc-4-3 fails otherwise).
- **(c) Persist the pair, then recover it.** The offer finding MUST carry both markers in `tags` (`["cross-marker", a, b]`). dig-deeper reads the note via `parseFrontmatter`, filters out the `"cross-marker"` sentinel, and uses the remainder. If you instead bury the pair only in `evidence` free-text, recovery is brittle — use `tags`.
- **(d) Distinct ruleKeys.** trends already use `rule-a-*`/`rule-b-*`. Use `cadence-gap` and `cross-marker-${a}-${b}`. Reusing a trend ruleKey would COLLIDE ids and overwrite a trend note (breaks sc-1-4 and sc-4-5).
- **`collectedAtIso`, not `collectedAt`.** The camelCase field on `LabResult` is `collectedAtIso` (types.ts:124); the DB column `collected_at` is mapped away by `rowToLabResult`. Use `latest.collectedAtIso`.
- **Latest = last element.** `getLabSeries` is ASC by `collected_at`; the newest result is `series[series.length - 1]` (trends.ts:199 does this). Empty series → `undefined` → skip.
- **commander option name.** `--dig-deeper <id>` becomes `opts.digDeeper`. The `review` action currently has no params — add `(opts: { digDeeper?: string })`.
- **Do NOT close an injected store** inside review-pass (the `weOpened` guard at review-pass.ts:57,96 handles this) — keep that logic intact when splicing analyzers.
- **engine.ts NO-TOUCH** — do not import from or edit `src/medical/engine.ts`; `generateRecommendation` already copies (not imports) its patterns.
- **dig-deeper must read the SAME vault dir review wrote to** — resolve `vaultDir` the same way (`config.medical?.vaultDir ?? join(projectRoot,".bober","medical","vault")`, review-pass.ts:51-52) so `findings/<id>.md` is found.
