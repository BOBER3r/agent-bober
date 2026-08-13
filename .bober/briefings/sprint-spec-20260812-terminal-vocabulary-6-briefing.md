# Sprint Briefing: The convergence record, and what a flip would still need

**Contract:** sprint-spec-20260812-terminal-vocabulary-6
**Generated:** 2026-08-12T23:15:00Z
**Baseline verified by the curator:** `npx vitest run --exclude '**/.claude/worktrees/**' src/orchestrator/workflow/conformance.engines.test.ts src/orchestrator/workflow/oracle-retention.test.ts` → **2 files / 16 tests passed**. `node dist/cli/index.js pge docs --check` → **`ok … (44 nodes documented)`**, exit 0. `npx vitest run … src/pge/topology/docs.test.ts src/cli/commands/pge.test.ts` → **173 passed**.

> **Read the handoff's `measuredReality` first.** The contract description says "two divergences closed". The divergence SET never shrank — it is still exactly `[audits, contracts, history, pipelineResult]`. What closed is the `pipelineResult` *mechanism* (sprint 4) and the `contracts` **status delta** (sprint 5). The contract's own stop condition authorises recording that.

---

## 1. Target Files

### `src/orchestrator/workflow/conformance.engines.test.ts` (modify) — 498 lines

**The divergence-set pin (lines 318-324) — this is sc-6-1's first half:**

```ts
    expect([...new Set(report.diffs.map((diff) => diff.field))].sort()).toEqual([
      "audits",
      "contracts",
      "history",
      "pipelineResult",
    ]);
    expect(report.equivalent).toBe(false);
```

Above it, lines 249-317 are a ~70-line prose comment ("THE RECORDED DIVERGENCE SET") describing the four. That comment was last rewritten by sprint 5 and is **currently accurate**; lines 288-299 already say `status` is CLOSED and three deltas remain.

**The per-field records — sc-6-1's second half.** One `it(...)` block, lines 327-452, driving two real runs and asserting each divergence's content:

- history, lines 346-361: `expect((await loadHistory(tsRoot)).map(e => e.event)).toEqual([... 10 events ...])` vs `[PIPELINE_COMPLETE_EVENT]` for pge.
- audits, lines 363-399: eight distinct `checkpointId`s for ts vs `new Set(["end-of-pipeline"])` for pge, plus the `outcome` triple `["approved","rejected","approved"]` and the `FAIL_CLOSED` / `node "commit"` / `was not executed` text assertions.
- contracts, lines 408-430 — **the block sc-6-1 most likely touches**:

```ts
    expect(tsContract.status).toBe("completed");
    expect(pgeContract.status).toBe("completed");
    expect(tsContract.status).toBe(pgeContract.status);
    expect(tsContract.evaluatorFeedback).toBeDefined();
    expect(pgeContract.evaluatorFeedback).toBeUndefined();
    expect(tsContract.generatorNotes).toBeDefined();
    expect(pgeContract.generatorNotes).toBeUndefined();
    // The remaining delta: `sprint_exit` writes a monotone `version`; `runSprintCycle` writes none.
    expect(tsContract.version).toBeUndefined();
    expect(pgeContract.version).toBeDefined();
    expect(tsContract.iterationHistory).toEqual([]);
    expect(pgeContract.iterationHistory).toEqual([]);
```

- pipelineResult, lines 432-451: `completedSprints.map(c => c.status)` equals `["completed"]` on both, `pgeResult?.failedSprints` is `[]`, and `expect(pgeResult?.completedSprints[0]).toEqual(pgeContract)` — the container-reduces-to-contracts proof.

**Other pins in the file that must not be disturbed:** `KNOWN_EMPTY = ["progress","runState"]` (line 202) and the population gate (lines 205-235); the "EQUIVALENT on every field outside the recorded divergence set" test (lines 454-470).

**Imported by:** `src/orchestrator/workflow/oracle-retention.test.ts:42-44` reads this file's **source text** (`readFile`), so its *content*, not just its behaviour, is load-bearing. See §7.

**Test file:** this IS the test file. Verified currently green (5 tests, 202ms).

---

### `src/orchestrator/workflow/oracle-retention.test.ts` (do NOT modify) — 168 lines

`git log --oneline 4aef5ea..HEAD -- src/orchestrator/workflow/oracle-retention.test.ts` → **empty**. This spec's five sprints have not touched it. sc-6-3 says "unmodified or only strengthened"; the safe answer is **leave it byte-identical** and cite the git result as the evidence.

The three claims sc-6-3 names, verbatim:

```ts
// :78-80
  it("defaults to 'ts' when the config says nothing at all", () => {
    expect(defaultedConfig().pipeline.engine).toBe("ts");
  });
// :113-116
  it("is what the DEFAULT config selects", () => {
    // The seam, not the constructor: an oracle nothing routes to is not retained.
    expect(selectPipelineEngine(defaultedConfig())).toBeInstanceOf(TsPipelineEngine);
  });
// :125-130
  it("is the fallback the graph engine itself downgrades to", async () => {
    const source = await readFile(PGE_ENGINE_SOURCE, "utf8");
    expect(source).toContain("TsPipelineEngine");
  });
```

**The coupling that can break from a conformance.engines.test.ts edit** — `oracle-retention.test.ts:156-167`:

```ts
  it("still pins sprint 13's verdict, which is why the default has not moved", async () => {
    const source = await readFile(CONFORMANCE_TEST, "utf8");
    expect(source).toContain("report.equivalent");
    expect(source).toMatch(/expect\(report\.equivalent\)\.toBe\(false\)/);
    for (const field of ["history", "audits", "contracts", "pipelineResult"]) {
      expect(source, `the ${field} divergence is no longer pinned`).toContain(field);
    }
  });
```
Also `:146-154`: no `.skip`/`.only`/`.todo`, and **at least 5 `it(` blocks** in `conformance.engines.test.ts` (it has exactly 5 today — removing one breaks this).

---

### `docs/pge-graph.md` (modify) — 1506 lines

The section to edit is **`## Engine migration disposition`, lines 1162-1374**, with three subsections: `### The evidence` (1168-1279), `### The decision` (1281-1320), `### The dormant src/orchestrator/workflow/ subtree — RETAIN` (1322-1349), `### bober sprint and bober_sprint …` (1351-1374).

**The precise place the previous spec put its closing record — lines 1301-1305, added by commit `b1abb321` (`bober(sprint-9): docs for the honest node-coverage rule, and the spec's closing record`):**

```md
`spec-20260812-pge-real-workload-errors` closed at its sprint 9 **without moving this
disposition**. It made the engine able to run a real workload at all and gave a refused run
a channel to say so, but the divergence set is still exactly `history`, `audits`,
`contracts`, `pipelineResult` at `equivalent: false` — none of the four was in its scope —
so PGE remains opt-in and `TsPipelineEngine` remains the oracle.
```

**This is the model the contract's `generatorNotes` names.** Its shape, in order: (1) name the spec and where it closed; (2) state in one clause what it *did* achieve; (3) state the divergence set as it stands, by name, with the verdict literal; (4) state the consequence for the disposition. Five lines, inserted **between** the flip-bar paragraph (1293-1299) and `**This decision is enforced, not just recorded.**` (1307). Put this sprint's closing record in the same slot, directly after it.

**The existing flip bar — lines 1293-1299, the paragraph a future reader will misread:**

```md
Flipping the default is a separate decision that requires sustained green conformance
across real runs. `PipelineResult` gained the error channel this paragraph used to say was
missing (spec-20260812-pge-real-workload-errors, sprint 5), and sprint 6 migrated the two
callers this repository ships — the `bober run` CLI and the MCP run manager — so a refusal
is visible to an operator and fails a CI job. `success` itself still cannot say a
fail-closed refusal happened, by the same Option-A decision, so a flip still requires every
*remaining* caller that decides on `success` alone to be migrated to check `errors` too.
```

That sentence — *"requires sustained green conformance across real runs"* — is the **only** written statement of the bar. It means `equivalent: true`. See §5 for why it is now unsatisfiable and what that obliges the record to say.

---

## 2. Patterns to Follow

### Pattern A — the disposition bullet: claim, then the file that pins it
**Source:** `docs/pge-graph.md`, lines 1203-1207
```md
  field of the `contracts` divergence is CLOSED: both engines now write the identical word
  for a settled sprint, pinned by asserting `tsContract.status` against `pgeContract.status`
  directly (`src/orchestrator/workflow/conformance.engines.test.ts:417-419`) rather than
  against a literal, so the claim pinned is the convergence itself.
```
**Rule:** every claim carries `path:line` of the assertion that fails when it stops being true, and says *why the assertion is shaped that way*. Bold the verdict word (`CLOSED`, `RECORDED, not closed`).

### Pattern B — the closing sprint doc: outcome → what was enforced by which test → what stayed unproven
**Source:** `docs/sprints/sprint-spec-20260812-pge-real-workload-errors-9.md` — headings in order: `## What this sprint added`, `## Two corrections the sprint made by measuring rather than by carrying wording forward`, `## Public surface`, `## How it fits`, `## Notes for maintainers`. Its closing bullet, `:110-115`:
```md
- **What would move these numbers.** `commit` and `finalize` need a **durable checkpoint
  mechanism** — the golden executor pins one config on purpose, so no case can close them.
```
**Rule:** the maintainer-notes section is where the "what stayed unproven" list goes, one bold lead-in per item.

### Pattern C — the spec's closing record in `docs/sprints/README.md`
**Source:** commit `b1abb321` changed the heading `## PGE Real-Workload Viability … — in progress (8 of 9)` → `— **COMPLETE (9 of 9)**` (now at `docs/sprints/README.md:2536`) and appended a `**Closing the spec.**` paragraph naming what it set out to do, what it found, and **"What it leaves open, deliberately and on the record:"** as an explicit list.
**Current state of this spec's section — `docs/sprints/README.md:2662`:** heading still reads `— in progress (3 of 6)`, and the table has **rows 1-3 only**; rows 4 and 5 were never added (`grep -c "terminal-vocabulary-4.md\|terminal-vocabulary-5.md" docs/sprints/README.md` → `0`) although both sprint docs exist on disk. The documenter step owns this file; the gap is real and this is the sprint that closes the spec.

### Pattern D — two-directional pin with a named negative control
**Source:** `src/pge/topology/docs.test.ts:1027-1033`
```ts
  it("FAILS when the disposition stops naming where the evidence is pinned", () => {
    const gutted = shippedDoc.split("conformance.engines.test.ts").join("a test somewhere");
    expect(gutted).not.toBe(shippedDoc);
    expect(() => { assertDispositionCitesEvidence(gutted); }).toThrow();
  });
```
**Rule:** a doc-claim assertion is a pure `assertX(doc: string): void` helper, applied to `shippedDoc` in one test and to a **gutted copy** in a paired `FAILS when …` test. `expect(gutted).not.toBe(shippedDoc)` first — so the control cannot silently stop mutating anything.

---

## 3. Existing Utilities — DO NOT Recreate

Reviewed `src/pge/topology/`, `src/orchestrator/workflow/`, `src/orchestrator/checkpoints/`, `src/contracts/`, `src/state/`, `src/utils/`.

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `assertDispositionCitesEvidence` | `src/pge/topology/docs.test.ts:920-941` | `(doc: string): void` | **The existing sc-6-5 hook.** Asserts the disposition names `conformance.engines.test.ts`, all four field names, `/equivalent[^\n]*false/i`, `/does not commit/i`, `success: true`, `pipeline.engine`. Extend this — do not write a second one. |
| `assertSubtreeDispositionRecorded` | `src/pge/topology/docs.test.ts:947` | `(doc: string): void` | Pins the dormant-subtree decision (`interpreter.ts`, `pure-sprint.ts`, `/retain/i`, 8 named retained units). |
| `assertGoldenLimitationStated` | `src/pge/topology/docs.test.ts:904` | `(doc: string): void` | Pins the golden-dataset limitation wording. |
| `assertChangelogCoversVersion` | `src/pge/topology/docs.test.ts:897` | `(spec, doc): void` | Pins a `### <graphVersion>` changelog heading. Not needed here — no topology change. |
| `shippedDoc` | `src/pge/topology/docs.test.ts:237`, loaded `:249` | `let shippedDoc: string` | The real `docs/pge-graph.md`, read once in `beforeAll`. Every doc assertion reads this. |
| `docDriftReport` | `src/pge/topology/docs.ts:91` | `(spec: TopologySpec, docText: string): DocDriftReport` | What `pge docs --check` runs. Node-id set symmetric difference, nothing else. |
| `documentedNodeIds` | `src/pge/topology/docs.ts:66` | `(docText: string): string[]` | Backticked bare identifiers inside `pge:nodes` regions only. |
| `EngineConformanceHarness` | `src/orchestrator/workflow/conformance.ts` (used at `conformance.engines.test.ts:179`) | `.assertEquivalent(specId, engines, rootFactory, runnerFor): Promise<ConformanceReport>` | Runs both engines and diffs 11 fields. |
| `emptyOnAllEnginesFields` / `fullyPopulatedFields` | imported at `conformance.engines.test.ts:78` | `(report): ConformanceField[]` | The population gate — stops "equivalent because both wrote nothing". |
| `VOLATILE_KEYS` | `src/orchestrator/workflow/conformance.ts:65-76` | `Set<string>` — 10 keys | Stripped before comparison. `version` is deliberately **not** on it. Verified: 10 entries, `createdAt`…`approverId`. |
| `loadHistory` / `listContracts` | `src/state/history.js`, `src/state/sprint-state.js` (imported `:66-67`) | `(projectRoot): Promise<…>` | The shipped readers the per-field records already use. |
| `readAuditRecords` | `src/orchestrator/workflow/conformance.engines.test.ts:165` | `(projectRoot): Promise<ApprovalRecord[]>` | File-local helper, reads `getAuditPath(root, RUN_ID)` in write order. |
| `isSettledContractStatus` / `isTerminalContractStatus` | `src/contracts/sprint-contract.ts` | `(s: ContractStatus): boolean` | Sprint 1's single definition site. |
| `CHECKPOINT_IDS` | `src/orchestrator/checkpoints/types.ts:16-27` | `readonly [9 ids]` | The nine decision points; a topology cannot name a tenth. |

---

## 4. Prior Sprint Output (this spec)

| Sprint | What it left for this one |
|---|---|
| 1 | `isSettledContractStatus`/`isTerminalContractStatus`; `src/contracts/status-vocabulary.invariant.test.ts` — a **line-number-pinned** allowlist enforced in both directions (`:257-268` fails on a *stale* entry). `interpreter.ts:728` allowlisted as a live instance of the bug class. |
| 2 | Four `pending` contracts → `completed`; run-time corpus guard. |
| 3 | `SprintContract.version` (`src/contracts/sprint-contract.ts:214`, optional, never defaulted); `sprint_exit` writes `version: attempts` (`src/pge/nodes/sprint-review.ts:222`). **Added the fourth `contracts` delta.** |
| 4 | Rank-aware `mergeEntries`/`lastWriteWinsByKey`. **MEASURED: `pipelineResult` did not leave the divergence set** — it is a container for `SprintContract`, so it reduces to `contracts`. |
| 5 | `pipeline.ts:589` writes `"completed"`; `pipeline.ts:1052` migrated to the predicate; `flusher.ts:63,76`; `getStatusIcon` fixed. **MEASURED: the `status` delta closed; `evaluatorFeedback`, `generatorNotes`, `version` remain**, each recorded with a reason (`docs/pge-graph.md:1208-1232`). |

**Carry-forward facts from the handoff that belong in the closing record** (all confirmed by sprint 5's evaluator and security auditor):
- `verdictFrom` (`src/pge/runtime/interpreter.ts:728`) counts contracts whose status is the literal `"passed"`. After sprint 5 **no writer in either engine produces that word**, so the counter is structurally always 0 and `verdictFrom`'s downgrade paths to `partial` are unreachable. Direction is conservative. Allowlisted at `status-vocabulary.invariant.test.ts:205-208`.
- `flusher.ts:76` decides the completed/failed split from a bare literal on a **local**, invisible to the sc-1-4 scan (which keys on the `.status` member-access spelling) — see that file's header, `status-vocabulary.invariant.test.ts:44-49`.
- `src/pge/registry/reducers.ts` contains literal NUL bytes (pre-existing on `main`), so `grep`/`semgrep`/`gitleaks` skip the engine's most trust-bearing module. **Spawned separately — not this sprint's work.**

---

## 5. Relevant Documentation — the four things sc-6-4 demands, sourced

### (a) The remaining divergences' disposition — the architectural grounds, with evidence

`.bober/specs/spec-20260812-terminal-vocabulary.json` `outOfScope[0]`:
> "Closing the `history` or `audits` conformance divergences. Both are recommended for permanent acceptance on architectural grounds — there is no curator node to emit a start/complete pair from, and five of eight checkpoint ids sit inside the fan-out region where HITL is a frozen ADR-6 error."

Curator-verified primary evidence for each:

- **`history`.** `grep -rn "appendHistory\|history.jsonl" src/pge --include="*.ts"` (non-test) → **zero hits**. The only history line a graph run writes comes from `finalizePipelineRun` (`src/orchestrator/finalize.ts:238-240`, `event: PIPELINE_COMPLETE_EVENT`). The imperative engine appends ten phase events from `runTsPipeline` itself. Closing it means either deleting the imperative event stream or giving nine node bodies a history writer through the commit boundary — and the boundary cannot reconstruct a `curator-start`/`curator-complete` **pair** from one superstep commit (`conformance.engines.test.ts:267-275`).
- **`audits`.** `InterruptInsideFanOut` is emitted at `src/pge/topology/validate.ts:1089-1099`, and `diag()` hardcodes `severity: "error"` (`validate.ts:417`) — so it is a **blocking** validation error, not a warning. The sprint subgraph is entered only through fan-out edges (`e-sprint-dispatch`, `e-rework-dispatch` → `sprint_body`, both `kind: "fanout"` in `.bober/topology/coding.json`), so the five per-sprint checkpoint ids (`pre-curator`, `pre-generator`, `pre-evaluator`, `pre-code-reviewer`, `post-sprint`) **cannot** be declared there without failing validation. ADR: `.bober/architecture/arch-20260805-pge-graph-engineering-adr-6.md:3`.
- **Precision note the generator should not copy wrong:** `conformance.engines.test.ts:277-279` and `docs/pge-graph.md` say the graph records only `end-of-pipeline` *"because that is the only checkpoint id the committed artifact declares."* **That is imprecise.** The artifact declares **two** HITL checkpoint ids — `hitl_commit → end-of-pipeline` and `plan_clarify → post-plan` (`src/pge/topology/coding.graph.ts:483`, since `1.2.0`). Only `end-of-pipeline` is ever *evaluated* on this fixture because `plan_clarify` is reachable only via the conditional edge `e-plan-clarify` (label `clarify`) that a settled plan never takes; the router goes `e-plan-ok → plan_materialize`. If the record repeats the old wording it repeats a falsifiable claim. Say **"the only checkpoint id this fixture ever evaluates"**, or state the two-declared/one-evaluated fact.

### (b) "Option B success semantics" — the term of art, defined

**Definition, `.bober/specs/spec-20260812-pge-real-workload-errors.json:27` (resolvedClarifications D3):**
> "Option A for this spec: `success` keeps the frozen deriveRunSuccess formula shared with the imperative engine, and callers treat a non-empty `errors` array as failure. **Option B (success:false on a FAIL_CLOSED refusal) is deliberately NOT taken here** — it moves `.bober/runs/<runId>.completed.json` and the `pipeline-complete` history phase, which adds `completionMarker` to the divergence set … **Option B belongs to the later decision that re-specifies the conformance bar, not to this spec.**"

Also carried in this spec's own `outOfScope[3]`: `"Option B success semantics (success:false on a fail-closed refusal)."`

So: **Option B = making `PipelineResult.success` false when a gated-effect node is refused FAIL_CLOSED.** Today a pge run that never committed still reports `success: true` (`conformance.engines.test.ts:405-406` asserts both engines report `true`). Taking Option B would add `completionMarker` to the divergence set — the field currently asserted **identical** across engines (`conformance.engines.test.ts:464-469`) and the one the chat layer tails. That is why it is a bar-level decision, not a sprint.

### (c) "A durable checkpoint mechanism for commit and finalize" — what exists, what is missing

**Exists:** four registered mechanisms — `cli`, `disk`, `pr`, `noop` (`src/pge/runtime/interrupt.ts:318`; implementations under `src/orchestrator/checkpoints/mechanisms/`, registered in `registry.ts`).

**The rule that blocks the nodes** — `src/pge/runtime/interrupt.ts:38-46`:
```
 * ── Fail-closed is about WHO approved, not whether anything approved ──
 * `noop` is the autopilot mechanism: it returns `{ approved: true }` without asking
 * anybody. … A node carrying GATED_EFFECTS therefore proceeds only when a DURABLE
 * mechanism — the disk marker `bober approve` writes, a PR review, an interactive CLI
 * answer — or a decision supplied on resume actually granted its upstream gate. With no
 * such record it blocks, the node body is never entered, and the block is written to the
 * audit log.
```
Enforced at `interrupt.ts:523`: `if (mechanismName !== "noop") granted.set(key, outcome);`

**Missing:** nothing in this repository ever *runs* `commit`/`finalize` under a non-`noop` mechanism. `conformanceConfig()` (`src/pge/engine/__fixtures__/whole-graph.ts:420-427`) is `createDefaultConfig(...)` — autopilot — and the golden executor pins one config on purpose. Consequence, already recorded: `commit` and `finalize` are two of the six `NEVER_EXECUTED` entries (`src/pge/golden/coverage.test.ts:139-146`), and `commit`'s span ends `{ status: "interrupted", errorClass: "FailClosed" }`, never `"ok"`. Previous spec's own words, `sprint-spec-20260812-pge-real-workload-errors-9.md:110-112`: *"`commit` and `finalize` need a **durable checkpoint mechanism** — the golden executor pins one config on purpose, so no case can close them."*

### (d) The bar itself, and why "two things closed" is not progress toward it

- **Where the bar is written:** `docs/pge-graph.md:1293` — *"Flipping the default is a separate decision that requires sustained green conformance across real runs."* Operationally that is `report.equivalent === true`.
- **`equivalent` is computed from a non-empty `diffs` set**, and `oracle-retention.test.ts:162-166` pins the literal `expect(report.equivalent).toBe(false)` **plus all four field names** in the conformance file's source text.
- **The bar is now unsatisfiable by design:** `history` and `audits` are recommended for **permanent acceptance** on the architectural grounds in (a), so `diffs` can never become empty; `pipelineResult` reduces to `contracts` (sprint 4) and cannot close first; `contracts` needs a new writer inside a PGE node body for `evaluatorFeedback`/`generatorNotes`, and `version` is deliberately excluded from `VOLATILE_KEYS` (`conformance.ts:65-76`) because stripping it would hide a real difference. **Therefore the bar has to change before a flip is possible** — which is precisely the sentence the contract's `generatorNotes` calls the most valuable one to write. This spec's `outOfScope[2]` explicitly reserves that: *"Re-specifying the conformance bar. … deciding what the remaining bar should be is a separate, stated decision."*

### Project principles bearing on this sprint
From `.bober/principles.md` (in the handoff): ESM with `.js` import extensions; `import type`; no synchronous fs; collocated `*.test.ts`; unicode box-drawing section headers (`// ── Section ──…`); conventional commits `bober(sprint-N): description`. All already followed by the target files.

---

## 6. Testing Patterns

**Runner:** vitest. **Assertions:** `expect`. **Mocks:** `vi.mock` (hoisted) + `vi.mocked(...).mockImplementation(...)`. **Naming:** `*.test.ts`, collocated. **Long-run tests carry an explicit timeout argument** — `}, 60_000);` in `conformance.engines.test.ts`.

### The doc-claim test pattern — where sc-6-5's new assertions belong

**File:** `src/pge/topology/docs.test.ts`, `describe("the document's changelog, disposition and stated limitations")` at **line 981**, helpers at **897-971** (`assertDispositionCitesEvidence` occupies **920-941**).

```ts
// src/pge/topology/docs.test.ts:920-941
function assertDispositionCitesEvidence(doc: string): void {
  const cited = [
    "conformance.engines.test.ts",
    "history", "audits", "contracts", "pipelineResult",
  ];
  const missing = cited.filter((needle) => !doc.includes(needle));
  expect(missing, `the disposition does not cite: ${missing.join(", ")}`).toEqual([]);

  expect(doc, "the disposition must state the conformance verdict").toMatch(/equivalent[^\n]*false/i);
  expect(doc, "the most consequential divergence must be stated").toMatch(/does not commit/i);
  expect(doc, "…including that the run still reports success").toContain("success: true");
  expect(doc, "what would have to be true to flip the default must be stated").toContain("pipeline.engine");
}
```
Paired negative controls at `:1027-1041` (gut `conformance.engines.test.ts`; gut `equivalent: false`) and `:1043-1053` (gut `synthesizer.ts`).

**Recommended shape for sc-6-5** — one new phrase-tolerant helper beside these, e.g. `assertFlipPrerequisitesStated(doc)`, asserting the four sc-6-4 subjects are addressed (a durable-checkpoint phrase, an Option-B phrase, the two permanently-accepted field names, and a re-specify-the-bar phrase), plus **one `FAILS when …` gutted control per new assertion**. Keep it phrase-tolerant, exactly as the existing block's own comment instructs (`:1009-1011`: *"Deliberately phrase-tolerant: this guards that the four subjects … are still addressed, not that any particular sentence survives a later edit"*).

### ⚠ `src/pge/topology/docs.test.ts` IS A BINARY FILE TO `grep`

It contains **2 literal NUL bytes at line 308**, inside `rows.sort((a, b) => compare(a.join("\0"), b.join("\0")))` — deliberate, load-bearing separators. Consequence: plain `grep -n "assertDispositionCitesEvidence" src/pge/topology/docs.test.ts` prints **nothing**. Use `grep -a`, or `Read`. Two other files share this: `src/pge/registry/reducers.ts:460` (2 NULs) and `src/pge/runtime/frontier.ts:61` (1 NUL). **Do not "clean" them** — they are inside `join()`/template-literal keys and removing them changes key semantics. Do not rewrite the whole file; make surgical edits far from line 308.

### Conformance test structure (the file being edited)
```ts
// conformance.engines.test.ts:341-344 — how the per-field record obtains its two runs
    const tsRoot = await projectRootFactory();
    const tsResult = await runnerFor("ts")(tsRoot);
    const pgeRoot = await projectRootFactory();
    const pgeResult = await runnerFor("pge")(pgeRoot);
```
Both engines run against fresh temp roots under a frozen clock (`FROZEN_ISO`, `:88`) and a fixed `RUN_ID` (`:90`).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files that may break

| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/orchestrator/workflow/oracle-retention.test.ts:136-167` | the **source text** of `conformance.engines.test.ts` | **high** | Must still contain `new TsPipelineEngine()`, `new PgeEngine(`, `EngineConformanceHarness`, `assertEquivalent`, `report.equivalent`, `expect(report.equivalent).toBe(false)`, all four field names; ≥ 5 `it(` blocks; no `.skip`/`.only`/`.todo`. |
| `src/pge/topology/docs.test.ts:981-1054` | the text of `docs/pge-graph.md` | **high** | `assertDispositionCitesEvidence`, `assertSubtreeDispositionRecorded`, `assertGoldenLimitationStated` all read `shippedDoc`. Deleting any of the phrases they key on (`success: true`, `pipeline.engine`, `equivalent: false`, `interpreter.ts`, `pure-sprint.ts`, `synthesizer.ts`, `Scheduler`, `Semaphore`, `mapBounded`, `Budget`, `retry.ts`, `reconciler.ts`, `conformance.ts`, `bober_sprint`, `src/orchestrator/workflow/`, `TsPipelineEngine`, `/opt-in/i`, `/does not commit/i`) breaks the build. **Rewrite in place; never delete a paragraph wholesale.** |
| `src/cli/commands/pge.test.ts` (114 tests) | `runPgeDocs` / `DEFAULT_DOC_PATH` | medium | Only breaks if the doc's `pge:nodes` regions change. |
| `src/contracts/status-vocabulary.invariant.test.ts:257-268` | **line numbers** of allowlisted production sources | medium | A stale entry FAILS. This sprint must not touch any production `.ts` file — if it does, re-verify the allowlist line numbers. |
| `.bober/golden/*` + `scripts/run-golden-regression.mjs` | runtime behaviour | low | Doc + test-prose changes move no artifacts. Expect **6/6** unchanged. |

### Existing tests that must still pass
- `src/orchestrator/workflow/conformance.engines.test.ts` — 5 tests (verified green).
- `src/orchestrator/workflow/oracle-retention.test.ts` — 11 tests (verified green).
- `src/pge/topology/docs.test.ts` + `src/cli/commands/pge.test.ts` — 173 tests together (verified green).
- `src/contracts/status-vocabulary.invariant.test.ts`, `src/contracts/sprint-contract.test.ts`, `src/mcp/tools/sprint-corpus.test.ts` — sprint 1/2 guards.
- `src/pge/golden/coverage.test.ts` — the `NEVER_EXECUTED` pin, if the record cites `commit`/`finalize`.

### Regression checks the generator must run
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — clean baseline **459 files / 6960 tests / 0 failed** (handoff). Never a bare `npx vitest run`: a stray worktree at `.claude/worktrees/youthful-satoshi-563347` adds ~22 unrelated failures. **Do not touch that worktree.**
2. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`
3. `node scripts/run-golden-regression.mjs` — expect 6/6.
4. `node dist/cli/index.js pge docs --check` — expect `ok … (44 nodes documented)`, exit 0. **Run it after `npm run build`**, and after every `docs/pge-graph.md` edit.
5. Disk is at ~89% (≈2.1 GiB free) and has produced transient `ENOSPC` flakes in `abort-run.test.ts` / `run-manager.test.ts`. Re-run a single suspect file before calling it a regression.

---

## 8. `pge docs --check` — exactly what it checks (sc-6-5)

**Entry point:** `runPgeDocs` (`src/cli/commands/pge.ts:542-582`). `--check` selects `DEFAULT_DOC_PATH = join("docs","pge-graph.md")` (`:511`); it is a document selector, not a mode switch (`:517-533`).

**What it compares — nothing more:** `docDriftReport(spec, text)` (`src/pge/topology/docs.ts:91-105`) is the **symmetric difference between two sets of node ids**:
- documented = every backticked bare identifier matching `` /`([A-Za-z_][A-Za-z0-9_]*)`/g `` (`docs.ts:35`) found **only inside `<!-- pge:nodes -->` … `<!-- /pge:nodes -->` regions** (`docs.ts:31-32, 44-63`);
- declared = `spec.nodes.map(n => n.id)` from the committed artifact.

Failure modes, and only these:
- `missing` — a declared node absent from the regions → `error DocDrift: node "<id>" is declared in the topology but absent from …`, exit `EXIT_FAILED` (`pge.ts:570-579`).
- `extra` — a backticked identifier inside a region that is not a declared node id → same exit.
- `EXIT_USAGE` if the document does not exist or cannot be read (`pge.ts:563-567`).

**What it does NOT check — say this out loud:**
- It **does not validate line-number citations.** `path:line` strings live outside every `pge:nodes` region and contain `/` and `.`, so `CODE_SPAN` never even matches them.
- It does not check links, anchors, or whether a prose claim is true.
- It does not read `docs/sprints/**` at all.
- Prose anywhere after the last `<!-- /pge:nodes -->` (line 207) is invisible to it. **The entire `## Engine migration disposition` section (lines 1162-1374) is outside all three regions, so `pge docs --check` cannot catch anything wrong there.** It will pass on a disposition full of stale citations — it does today.

**The one way a disposition edit CAN break it:** writing the literal marker text `<!-- pge:nodes -->` in prose or a fenced block opens a **fourth region** that runs to the end of the document, turning every backticked identifier below it into a claimed node id → dozens of `extra` drifts. The document warns about exactly this at `docs/pge-graph.md:47-49`: *"(The literal marker text is deliberately not reproduced in this paragraph: the checker scans for it, so quoting it in prose would open a fourth, empty region.)"*

### 🔴 STALE LINE-NUMBER CITATIONS ALREADY IN THE SECTION BEING EDITED

This spec has broken citations twice (`5da9940` — *"fix versionRank citations stale from the reducers.ts line shift"*; sprint 5 fixed more). **Nothing in CI catches it — no test in the repo validates a `path:line` citation.** Curator-verified against the working tree right now:

| Cited at | Citation | Reality | Verdict |
|---|---|---|---|
| `docs/pge-graph.md:1194` | `src/pge/nodes/sprint-review.ts:205` for the `"completed"` write | the write is `status: outcome.settled === "succeeded" ? "completed" : "failed"` at **`:215`**; `:205` is `: branchOutcome(...)` | **STALE** |
| `docs/pge-graph.md:1195` | `src/pge/nodes/sprint-evaluate.test.ts:765` "the persisted value is pinned at" | `:765` is a comment line; the pin is `expect(persisted).toEqual([…":completed"])` at **`:776`** | **STALE** |
| `docs/pge-graph.md:1213` | `src/pge/nodes/sprint-review.ts:215` for `version: attempts` | that write is at **`:222`**; `:215` is the status write | **STALE** |
| `docs/pge-graph.md:1268` | `src/contracts/sprint-contract.ts:213` for the `version` field | field decl is at **`:214`**; `:213` is `*/` | off-by-one |
| `status-vocabulary.invariant.test.ts:52` | `src/pge/nodes/sprint-review.ts:208` | actual **`:215`** | stale (comment only) |
| `docs/pge-graph.md:1206` | `conformance.engines.test.ts:417-419` | exact | ✅ accurate |
| `docs/pge-graph.md:1215` | `conformance.engines.test.ts:417-426` | exact | ✅ accurate |
| `docs/pge-graph.md:1216` | `conformance.ts:65-76`, "10-key" | exact, 10 keys counted | ✅ accurate |
| `docs/pge-graph.md:1214` | `src/pge/registry/reducers.ts:366-393` (`versionRank`) | exact | ✅ accurate |
| `docs/pge-graph.md:1250` | `src/pge/runtime/interpreter.ts:728` (`verdictFrom`) | exact | ✅ accurate |
| `docs/pge-graph.md:1200-1201` | `pipeline.ts:589`, `pipeline.ts:1052` | exact | ✅ accurate |

**Two obligations follow.** (1) Fix the four stale ones while you are in the section — a closing record that carries broken citations is exactly what this spec's own discipline forbids. (2) **Any insertion or deletion above line 417 of `conformance.engines.test.ts` shifts `:417-419` and `:417-426` and silently falsifies two accurate citations.** After editing that file, re-run `sed -n '417,426p' src/orchestrator/workflow/conformance.engines.test.ts` and update `docs/pge-graph.md:1206` and `:1215` to the new numbers.

---

## 9. sc-6-1 — what "fails in both directions" requires, and whether it still holds

**Direction 1 — a NEW divergence appears.** A fifth field entering `report.diffs` makes the sorted array 5 long; `toEqual` on the 4-element literal (`:318-323`) fails. Also caught structurally: `KNOWN_EMPTY` + the population gate (`:218-234`) fail if a field stops being written on either side. ✅ **holds**.

**Direction 2 — a divergence is SILENTLY FIXED.** Two independent layers:
- *Field level.* If `contracts` converged entirely, the array becomes 3 long → `:318-323` fails. Same for any of the four. ✅ **holds**.
- *Delta level (the layer that matters now).* If PGE gained an `evaluatorFeedback` writer, `contracts` would still diverge on `version`, so the field-set assertion would still pass — but `expect(pgeContract.evaluatorFeedback).toBeUndefined()` (`:421`) fails. Same for `generatorNotes` (`:423`) and `version` (`:425-426`). ✅ **holds** — the per-field records are what make direction 2 bite below field granularity.

**Does it still hold after sprint 5's edits?** Yes, and sprint 5 *strengthened* it. The status delta is pinned three ways at `:417-419`: both engines against the literal `"completed"` **and** against each other. A revert of either writer to `"passed"` fails a literal assertion; a coordinated move of both engines to a third word fails `:417`/`:418`. The one-line form `toBe(pgeContract.status)` alone would have been direction-blind; the two literals in front of it close that.

**Concrete mutations the evaluator will run (`evaluatorNotes`), and what should fail:**
| Mutation | Expected failure |
|---|---|
| Add a fifth field to the expected array (a fake divergence) | `:318-323` — array length/content mismatch |
| Delete `"contracts"` from the expected array (pretend it was fixed) | `:318-323` |
| Make PGE write `generatorNotes` in a node body | `:423` — `toBeUndefined()` |
| Make `sprint_exit` stop writing `version` | `:426` — `toBeDefined()` |
| Revert `pipeline.ts:589` to `"passed"` | `:417` and `:419`, plus `:440` |

**What sc-6-1 actually asks you to change:** "pins the divergence set to exactly what a real run now produces, with the per-field records updated to match." A real run produces the **same four fields** — verified. So the set literal is already correct and **should not move**. What may need updating is the *prose* in the `:249-317` comment (state which spec closed which mechanism, and that the set never shrank) and, if the record's wording changes, the audits precision noted in §5(a). **Do not adjust code or tests to make the contract's "two closed" prediction come true** — the stop condition forbids it.

---

## 10. Implementation Sequence

1. **Verify the ground truth yourself before writing a word.**
   `npx vitest run --exclude '**/.claude/worktrees/**' src/orchestrator/workflow/conformance.engines.test.ts src/orchestrator/workflow/oracle-retention.test.ts`
   *Verify:* 16 passed; the divergence set assertion at `:318-323` is untouched and green.
   `git log --oneline 4aef5ea..HEAD -- src/orchestrator/workflow/oracle-retention.test.ts`
   *Verify:* empty output — that is sc-6-3's evidence. **Change nothing in that file.**

2. **`src/orchestrator/workflow/conformance.engines.test.ts` — prose and, only if measurement demands it, assertions.**
   Update the `:249-317` record comment so it states: the set is still four; `pipelineResult`'s *mechanism* closed at sprint 4 but the field did not leave; `contracts`' *status delta* closed at sprint 5 with three deltas remaining; `history`/`audits` are recommended for permanent acceptance with the §5(a) grounds. Fix the audits "only checkpoint id declared" wording (§5(a)). Keep the assertions as they are unless a run says otherwise.
   *Verify:* rerun the two files; still 16 passed. Then `sed -n '417,426p'` and record the new line numbers for step 4.

3. **`src/pge/topology/docs.test.ts` — the sc-6-5 hook (edit with `Read`/surgical replace; the file is NUL-bearing).**
   Add a phrase-tolerant `assertFlipPrerequisitesStated(doc)` beside `assertDispositionCitesEvidence` (insert after `:941`, before the `:943` comment block), plus one `it(...)` applying it to `shippedDoc` and one `FAILS when …` gutted control per new claim, inside the `describe` at `:981`.
   *Verify:* `npx vitest run --exclude '**/.claude/worktrees/**' src/pge/topology/docs.test.ts` — new tests fail (the doc has not been written yet). That failing state is the proof the pin bites.

4. **`docs/pge-graph.md` — the closing record.**
   Insert this spec's closing paragraph immediately after `:1305`, in the shape of the model quoted in §1. In the same edit: state which two things closed and that the SET did not shrink; the disposition of `evaluatorFeedback`/`generatorNotes`/`version`; the permanent-acceptance recommendation for `history` and `audits` with the §5(a) grounds; the `verdictFrom`/`flusher.ts:76` carry-forwards from §4; and the four sc-6-4 flip prerequisites from §5(a)-(d), ending on the sentence that says **the bar itself must be re-specified before a flip is possible**. Fix the four stale citations from §8 and update `:1206`/`:1215` to step 2's measured numbers.
   *Verify:* `npm run build && node dist/cli/index.js pge docs --check` → `ok … (44 nodes documented)`; then `npx vitest run … src/pge/topology/docs.test.ts` → all green, including the new pins and their gutted controls.

5. **`docs/sprints/` — the spec's closing record (documenter step).**
   `docs/sprints/sprint-spec-20260812-terminal-vocabulary-6.md` in the Pattern-B shape. In `docs/sprints/README.md`: flip `:2662` from `— in progress (3 of 6)` to `— **COMPLETE (6 of 6)**`, add the **missing rows 4 and 5** plus row 6, and append a `**Closing the spec.**` paragraph with an explicit "what it leaves open" list (Pattern C).
   *Verify:* `grep -c "terminal-vocabulary-4.md\|terminal-vocabulary-5.md\|terminal-vocabulary-6.md" docs/sprints/README.md` → 3.

6. **Full verification.** `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` (expect ≥ 6960, 0 failed) → `npm run typecheck` → `npm run typecheck:tests` → `npm run lint` → `npm run build` → `node scripts/run-golden-regression.mjs` (6/6) → `node dist/cli/index.js pge docs --check`.

---

## 11. Pitfalls & Warnings

- **The contract's own description is wrong and the handoff says so.** "Two divergences closed" — the SET never shrank. Record what a real run produces. `stopConditions[0]` pre-authorises this: *"record what it actually is and why, rather than adjusting anything to match the prediction."* Do not edit code or tests to make the prediction true.
- **`pge docs --check` will pass no matter what you write in the disposition.** It only diffs node ids inside `pge:nodes` regions (`docs.ts:66-105`). It is not a proof that your prose is right. sc-6-5's real gate is `docs.test.ts:981-1054`.
- **Never write the literal `<!-- pge:nodes -->` in prose or in a fenced block.** It opens a fourth region and fails the check (`docs/pge-graph.md:47-49` explains the same trap).
- **`grep` silently skips `src/pge/topology/docs.test.ts`, `src/pge/registry/reducers.ts` and `src/pge/runtime/frontier.ts`** — each contains deliberate NUL bytes (`docs.test.ts:308`, `reducers.ts:460`, `frontier.ts:61`) used as key separators. Use `grep -a` or `Read`. Never strip those bytes, and never rewrite those files wholesale.
- **Editing above line 417 of `conformance.engines.test.ts` silently falsifies `docs/pge-graph.md:1206` and `:1215`.** Nothing in CI catches a stale citation. Re-measure and update.
- **Four citations in the section you are editing are already stale (§8).** Fix them; do not propagate them into the new paragraph.
- **`docs.test.ts`'s doc assertions are substring/regex checks over the whole file.** Deleting a paragraph that happens to contain `success: true`, `pipeline.engine`, `equivalent: false`, `synthesizer.ts`, `bober_sprint`, `interpreter.ts` or `pure-sprint.ts` turns a prose edit into a red build. **Rewrite in place; never wholesale-delete.**
- **Do not touch `oracle-retention.test.ts`.** It is unmodified since `4aef5ea`, and that fact IS sc-6-3's evidence. It also reads `conformance.engines.test.ts`'s source text — keep ≥ 5 `it(` blocks, both engine constructors, `assertEquivalent`, `expect(report.equivalent).toBe(false)` and all four field names.
- **Do not touch any production `.ts` file.** `status-vocabulary.invariant.test.ts:257-268` pins allowlisted sites by **line number** and fails on a stale entry, so any production line shift becomes a red test in a docs sprint.
- **`plan_clarify → post-plan` exists.** The artifact declares two HITL checkpoint ids, not one. Do not repeat the old "only checkpoint id the committed artifact declares" wording (§5(a)).
- **Golden is 6 replay cases against a floor of `GOLDEN_MIN_REPLAY_CASES = 5` — zero slack.** A docs/test-prose sprint must move zero artifacts. If the golden gate moves, something behavioural changed that should not have.
- **Never run a bare `npx vitest run`.** The stray worktree `.claude/worktrees/youthful-satoshi-563347` contributes ~22 unrelated failures. Do not touch it.
- **Disk is at ~89%.** `abort-run.test.ts` / `run-manager.test.ts` have produced transient `ENOSPC` flakes. Re-run a single file before declaring a regression.
- **`nonGoals` are hard walls:** do not re-specify the bar, do not flip the default, do not close `history` or `audits`. The record *names* what a re-specification would need; it does not perform one.
