# Sprint Briefing: audits converges — the full checkpoint trail

**Contract:** sprint-spec-20260814-pge-full-convergence-3
**Generated:** 2026-08-14T12:20:00Z
**Amended goal (from the handoff):** declare the ONE out-of-region id, name the other five
as permanently undeclarable citing the sprint-1 ADR, record `audits` as recommended for
permanent acceptance. Do NOT force sc-3-4's literal wording.

---

## 0. The sprint's central question, ANSWERED — with computed evidence

### 0.1 Is `post-sprint-contract` declarable? **YES.** Host it on `gate_plan_out`.

**Where the imperative pipeline records it** — `src/orchestrator/pipeline.ts:1017-1025`:

```ts
    const contracts = await materializeContracts(spec, projectRoot, config);
    await runWithAudit({
      projectRoot,
      runId: pipelineRunId,
      checkpointId: "post-sprint-contract",
      mechanism: pipelineMechanismName,
      iteration: 1,
      fn: () => getCheckpointMechanismFor("post-sprint-contract", config, "noop").request("post-sprint-contract", contracts),
    });
```

Semantics: **immediately after the SprintContract[] are materialised and persisted, before
the sprint loop begins.** Its payload is the `contracts` array.

**The PGE node at that same moment** is the pair `plan_materialize` → `gate_plan_out`
(`src/pge/topology/coding.graph.ts:485-512`). `plan_materialize` is the writer;
`gate_plan_out` is the effect-free gate that fires once the spec and contracts are on disk
and carries the same `contracts` payload on its input port.

**I COMPUTED the fan-out region** — the same derivation as `validate.ts:602-607` /
`interpreter.ts:490-498`, run against the committed `.bober/topology/coding.json`:

```
FAN-OUT REGION (16 of 44 nodes):
gate_anchor_regression, gate_mock_coverage, gate_sprint_in, gate_sprint_out, gate_syntax,
reduce_sprints, sprint_body, sprint_correct, sprint_curate_explain, sprint_curate_mocks,
sprint_evaluate, sprint_exit, sprint_generate, sprint_review, sprint_route, sprint_security

plan_materialize   inRegion = FALSE
gate_plan_out      inRegion = FALSE
fanout_sprints     inRegion = FALSE
reduce_sprints     inRegion = TRUE
```

The only two `kind: "fanout"` edges are `e-sprint-dispatch` (`fanout_sprints -> sprint_body`)
and `e-rework-dispatch` (`rework_route -> sprint_body`). Both plan-region nodes are
upstream of them.

**I then ran the SHIPPED validator on the mutated artifact** (via `dist/pge/topology/validate.js`,
`mode: "structural"`, which includes the `collectNodePolicyRules` pass):

| node given `hitl` | checkpointId | error diagnostics |
|---|---|---|
| `gate_plan_out` | `post-sprint-contract` | **`ChecksumStale` ONLY** |
| `plan_materialize` | `post-sprint-contract` | `EffectfulNodeContainsHitl`, `ChecksumStale` |
| `reduce_sprints` | `post-sprint` | `InterruptInsideFanOut`, `ChecksumStale` |
| `sprint_curate_explain` | `pre-curator` | `InterruptInsideFanOut`, `ChecksumStale` |
| `gate_sprint_out` | `post-sprint` | `InterruptInsideFanOut`, `ChecksumStale` |

`ChecksumStale` is expected and self-healing: `coding.graph.ts` reseals via
`checksumTopology(CODING_GRAPH_UNSEALED)` and `bober pge dump` rewrites the artifact.

**So: `gate_plan_out` is the host. `plan_materialize` is NOT** — it declares
`effects: ["fs-write"]` (`coding.graph.ts:496`), which trips `EffectfulNodeContainsHitl`
(`src/pge/topology/validate.ts:1101-1111`). The declarable set is exactly ONE, not zero.

### 0.2 What the `audits` divergence looks like RIGHT NOW — I RAN IT

`npx vitest run src/orchestrator/workflow/conformance.engines.test.ts --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`
→ **5 passed, 5 tests, 257ms.** The per-field record at
`src/orchestrator/workflow/conformance.engines.test.ts:389-408` is CURRENT, not stale:

```ts
    expect(tsAudits.map((record) => record.checkpointId)).toEqual([
      "post-plan", "post-sprint-contract", "pre-curator", "pre-generator",
      "pre-evaluator", "pre-code-reviewer", "post-sprint", "end-of-pipeline",
    ]);
    expect(tsAudits.every((record) => record.outcome === "approved")).toBe(true);
    expect(new Set(pgeAudits.map((record) => record.checkpointId))).toEqual(
      new Set(["end-of-pipeline"]),
    );
    expect(pgeAudits.map((record) => record.outcome)).toEqual(["approved", "rejected", "approved"]);
```

**SPRINT 2 DID NOT REACH THIS HARNESS.** The middle `rejected` is still here. Sprint 2 added
`goldenApprovedConfig()` in `src/pge/golden/executor.ts:152-161`, used only by the golden
executor. The conformance harness runs `conformanceConfig()`
(`src/pge/engine/__fixtures__/whole-graph.ts:420-427`), which is plain autopilot:

```ts
export function conformanceConfig(name = "pge-conformance"): BoberConfig {
  const base = createDefaultConfig(name, "brownfield");
  return {
    ...base,
    pipeline: { ...base.pipeline, researchPhase: false, maxIterations: 2 },
    evaluator: { ...base.evaluator, maxIterations: 1 },
  };
}
```

No `checkpointOverrides`. `git show --stat 7237c56 275f074 92609a6` confirms sprint 2
touched neither `whole-graph.ts` nor `conformance.engines.test.ts`. **See §9, first bullet — sc-3-3
as literally worded rests on a false premise, and closing it is dangerous.**

Nine checkpoint ids exist (`src/orchestrator/checkpoints/types.ts:16-26`); the TS side
records eight because `conformanceConfig()` sets `researchPhase: false`, so
`post-research` (`pipeline.ts:862-869`) never fires.

**Predicted shape AFTER declaring `post-sprint-contract` on `gate_plan_out`** (verify by
running the harness — do not trust this table):

| | ts | pge (today) | pge (predicted) |
|---|---|---|---|
| id SET | 8 ids | `{end-of-pipeline}` | `{post-sprint-contract, end-of-pipeline}` |
| outcomes | 8 × approved | `[approved, rejected, approved]` | `[approved, approved, rejected, approved]` |

The new record is **FIRST** — `gate_plan_out` runs long before the terminal region — with
`mechanism: "noop"`, `outcome: "approved"`, `iteration: 1`.

**sc-3-2 ("the same SET of checkpoint ids from both engines") is therefore UNREACHABLE:**
2 ids vs 8. That is exactly what the amended goal pre-authorises.

### 0.3 How a checkpoint id is declared

`src/pge/topology/coding.graph.ts:483` (`plan_clarify`) and `:909` (`hitl_commit`):

```ts
      hitl: { checkpointId: "post-plan", onReject: "graceful_failure" },
```
```ts
      hitl: { checkpointId: "end-of-pipeline", onReject: "graceful_failure" },
```

Adding a third **also** requires, in this order:

1. `src/pge/topology/coding.graph.ts:124` — `graphVersion: "1.4.0"` → `"1.5.0"`
   (a structural change must carry a bump; `pge diff --require-version-bump` in
   `.github/workflows/ci.yml:64-81` is the gate).
2. `.bober/topology/coding.json` — regenerate with `node dist/cli/index.js pge dump`
   (checksum moves off `sha256:a1df4bf0…`). CI runs `pge dump --check`.
3. `.bober/topology/state-audit.json` — pins `generatedFrom.checksum`. Regenerate with
   `node dist/cli/index.js pge audit-state`; CI runs it then `git diff --cached --exit-code`.
4. `src/pge/topology/__fixtures__/coding.dot` and `coding.mermaid` — hand-maintained
   goldens with NO capture escape hatch, asserted byte-for-byte at
   `src/pge/topology/render.test.ts:270-273` and `:119`. **I computed the exact deltas** by
   rendering the mutated artifact through `dist/pge/topology/render.js`; the committed
   fixtures match the current render byte-for-byte, so these are complete:

   `coding.dot:16` —
   `-  "gate_plan_out" [label="gate_plan_out", shape=box];`
   `+  "gate_plan_out" [label="gate_plan_out", shape=box, peripheries=2];`

   `coding.mermaid:14` —
   `-  gate_plan_out["gate_plan_out"]`
   `+  gate_plan_out[["hitl gate_plan_out"]]`

   `coding.mermaid`, inserted directly after line 109 (`gate_plan_out -.->|"onFail"| graceful_failure`) —
   `+  gate_plan_out -.->|"onReject"| graceful_failure`
5. `docs/pge-graph.md:224-238` — the `<!-- pge:gates -->` table's LAST column for
   `gate_plan_out` goes `(none)` → `post-sprint-contract`. Machine-checked field-by-field at
   `src/pge/topology/docs.test.ts:539-551` via `expectedGateRows` (`:354-365`).
6. `docs/pge-graph.md:213` — prose "Two of them additionally carry a human-in-the-loop
   checkpoint" → "Three". Also `:252-257` ("Both human checkpoints…") and `:1367-1369`
   ("declares **two** HITL checkpoint ids").
7. `docs/pge-graph.md` `## Changelog` (`:1531`) — a new `### 1.5.0 — …` heading, newest
   first. Pinned at `src/pge/topology/docs.test.ts:1028-1032`:
   `expect(committed.graphVersion).toBe("1.4.0")` and
   `expect(changelogVersions(shippedDoc)).toEqual(["1.4.0","1.3.0","1.2.0","1.1.0","1.0.0"])`
   — **both literals must move.**
8. `src/pge/topology/coding.graph.test.ts:406-413` — the two-directional HITL pin:
   `expect(hitl.map((n) => n.id).sort()).toEqual(["hitl_commit", "plan_clarify"])` →
   `["gate_plan_out", "hitl_commit", "plan_clarify"]`. Its loop already asserts every HITL
   node has `onReject === "graceful_failure"` and `effects === []`.

### 0.4 `onReject` semantics — and what a rejection would DO

Both declared ids use `onReject: "graceful_failure"`. **The new id should too**, and it is
the only sane choice: a human who refuses the materialised contracts has refused the plan,
and every downstream node is about to consume those contracts.

The runtime distinguishes a HITL rejection from a fail-closed refusal at
`src/pge/runtime/interpreter.ts:1167-1201`:

```ts
      const failClosed = node.spec.hitl === undefined;
      ...
      handle.end({
        status: "interrupted",
        outputHash: task.taskKey,
        failClosed,
        errorClass: failClosed ? FAIL_CLOSED_ERROR_CLASS : HITL_REJECTED_ERROR_CLASS,
      });
      if (failClosed) { failures.push({ ... }); }
      blockedTasks.push({ task, target: node.spec.hitl?.onReject ?? gate?.onReject ?? null });
```

So a rejected `post-sprint-contract`: span `status: "interrupted"`,
`errorClass: "HitlRejected"`, **no `failures` entry** (the verdict is not downgraded), and
control routes to `graceful_failure`, which writes a failure artifact and ends the run
without a commit. That mirrors the imperative pipeline, whose `runWithAudit` rejection at
`pipeline.ts:1018-1025` also aborts the run before the sprint loop.

**Under autopilot nothing rejects.** `maybeInterrupt`
(`src/pge/runtime/interrupt.ts:445-525`) resolves the mechanism, and `noop` approves. Note
`interrupt.ts:523` — `if (mechanismName !== "noop") granted.set(key, outcome);` — a noop
approval grants nothing, so no downstream gated-effect node can cite it.

**Behavioural consequence worth naming in the sprint's docs:** under
`pipeline.mode: "careful"` or a global `pipeline.checkpointMechanism: "disk"`
(`src/orchestrator/checkpoints/registry.ts:65-91`, tiers 4-5), a PGE run will now BLOCK at
`gate_plan_out` where it previously did not. That is the point — it is what the imperative
pipeline already does. The curated chat gate set
(`.bober/specs/spec-20260615-chat-interrupt-approve-steer.json`) leaves
`post-sprint-contract` on `noop`, so the chat path is unaffected.

**Harmless side effect, verified:** `computeEffectGates`
(`src/pge/runtime/interpreter.ts:516-529`) is ONE HOP, not transitive — it would add
`gates.set("fanout_sprints", { checkpointId: "post-sprint-contract", … })`. `fanout_sprints`
declares no effects, and `maybeInterrupt` short-circuits at `interrupt.ts:451`
(`if (hitl === undefined && gated.length === 0) return APPROVED;`) before consulting the
gate. No gated node derives `post-sprint-contract`, so no new grant is ever read.

### 0.5 Blast radius — golden cases and tests, predicted specifically

`compareGoldenArtifacts` (`src/pge/golden/runner.ts:141-168`) compares over the **UNION** of
`CONFORMANCE_FIELDS`, so a case with no pinned `audits` key expects ZERO audit records. Only
the **7 `replay`** cases are executed (`.github/workflows/ci.yml:99-106`,
`src/pge/golden/gate.ts:35-45`); the 37 `integrity` cases are structure-checked only.

I read the pinned `audits` of every case and the `specs`/`contracts` counts that prove
whether `plan_materialize` ran:

| replay case | terminal | specs | contracts | audits today | prediction |
|---|---|---|---|---|---|
| `replay-full-run-commit-approved` | `finalize` | 1 | 1 | 3 (all `disk`) | **+1** `post-sprint-contract`/`noop`/approved, FIRST |
| `replay-full-run-evaluation-fails` | `graceful_failure` | 1 | 1 | 1 | **+1** |
| `replay-full-run-evaluation-passes` | `graceful_failure` | 1 | 1 | 3 | **+1** |
| `replay-plan-clarification-round` | `graceful_failure` | 1 | 1 | 4 | **+1** |
| `replay-research-reflexions-exhausted` | `graceful_failure` | 1 | 1 | 3 | **+1** |
| `replay-research-second-reflexion` | `graceful_failure` | 1 | 1 | 3 | **+1** |
| `replay-plan-clarify-rounds-exhausted` | `graceful_failure` | **0** | **0** | 2 | **UNCHANGED** — never reaches `plan_materialize` |

**6 of 7 replay cases move; 1 does not.** In `replay-full-run-commit-approved` the new
record carries `mechanism: "noop"`, not `disk`, because `goldenApprovedConfig()`
(`executor.ts:152-161`) overrides `end-of-pipeline` only.

`mechanism` and `outcome` are deliberately NOT in `VOLATILE_KEYS`
(`src/orchestrator/workflow/conformance.ts:65-76`), so both appear in the captured record.

Integrity cases that would move if they were ever executed (they are not, but say so in the
sprint record): `plan-clarify-checkpoint-approved` (terminal is literally `gate_plan_out`),
`plan-draft-materialize-two-sprints`, `plan-gate-out-refuses-zero-contracts`,
`full-run-research-to-commit`.

**Coverage is UNCHANGED.** `gate_plan_out` is already executed (it is absent from
`NEVER_EXECUTED`, `src/pge/golden/coverage.test.ts:143`, which is
`["context_compact","critique","rework_route","synthesize"]` → 40/44, floor 0.85 at `:260`).
A HITL approved under `noop` still produces a `status: "ok"` span.

### 0.6 What "converges" can honestly mean — the `history` precedent

`docs/pge-graph.md:1342-1373` is the precedent, and it does not shrink either engine's
trail. It records:

> **`history` and `audits` are recommended for permanent acceptance, not open work.** Both
> rest on architectural grounds… `audits`: five of the eight checkpoint ids the imperative
> pipeline records sit inside the sprint fan-out region… Only the sixth undeclared
> checkpoint id, which sits outside the region, remains open to a later sprint.

The spec's own amended feat-3 AC2 (`.bober/specs/spec-20260814-pge-full-convergence.json`)
settles it:

> AC2 (AMENDED sprint 1): 'audits' is RECOMMENDED FOR PERMANENT ACCEPTANCE alongside
> 'history', per arch-20260814-pge-full-convergence-adr-1; **the divergence pin must not
> drop 'audits' silently without a corresponding ADR revisit.**

**The honest end state:** the imperative engine's trail does **NOT** shrink (that would be
`outOfScope[5]`, "Any change to the imperative pipeline's own behaviour"). `audits` **STAYS**
in the pinned divergence set at `conformance.engines.test.ts:340-345`, which therefore does
NOT change and keeps biting in both directions. What changes is the RECORD: the divergence
narrows from 1-of-8 ids to 2-of-8, one more id is permanently closed, and the remaining five
are named as permanently undeclarable with the ADR citation. **sc-3-4's literal wording is
superseded by the handoff's `amendedGoal`. Do not delete `"audits"` from that array.**

---

## 1. Target Files

### `src/pge/topology/coding.graph.ts` (modify)

**The edit target — `gate_plan_out`, `src/pge/topology/coding.graph.ts:499-512`.** The change is one line, inserted after `gate: { check: "spec-and-contracts-persisted", onFail: "graceful_failure" },`
(`:511`):

```ts
      hitl: { checkpointId: "post-sprint-contract", onReject: "graceful_failure" },
```

Its neighbour `plan_materialize` (`:486-498`) carries `effects: ["fs-write"]` at `:496` and
is therefore NOT a legal host — see §0.1.

**Line 124:** `graphVersion: "1.4.0",` — bump to `"1.5.0"`.

**Imported by:** `src/pge/engine/pge-engine.ts`, `src/pge/golden/*`, `src/cli/commands/pge.ts`,
`src/pge/topology-invariants.test.ts`, `src/pge/topology/{coding.graph,docs,render,diff,dump}.test.ts`.
**Test file:** `src/pge/topology/coding.graph.test.ts` (exists).

### `.bober/topology/coding.json` (modify — GENERATED, do not hand-edit)

Regenerate: `npm run build && node dist/cli/index.js pge dump`. Current checksum
`sha256:a1df4bf023618df2fe0b19817924986ec290841b113381f5652aa98da2dd9aea`. The shape to
expect on `gate_plan_out` — copy `plan_clarify`'s, which already carries both a `gate` and a
`hitl`:

```json
  "gate": { "check": "clarifications-answered", "onFail": "graceful_failure" },
  "hitl": { "checkpointId": "post-plan", "onReject": "graceful_failure" },
```

### `src/orchestrator/workflow/conformance.engines.test.ts` (modify)

Change **only** `:401-408` (the pge-side assertions) and the prose at `:281-307`. Do NOT
touch `:340-345`.

```ts
    // Every graph-side record is `end-of-pipeline` — the only checkpoint id this fixture
    // ever evaluates, not because one id was recorded twice, ...
    expect(new Set(pgeAudits.map((record) => record.checkpointId))).toEqual(
      new Set(["end-of-pipeline"]),
    );
    expect(pgeAudits.map((record) => record.outcome)).toEqual(["approved", "rejected", "approved"]);
```

**The prose paragraph at `:294-307` is now WRONG in one respect** — it says "Closing it would
mean declaring the other seven checkpoint ids… and FIVE of those seven sit inside the sprint
fan-out region". After this sprint: six of seven remain undeclared, five permanently
(fan-out) and one (`post-research`) simply not fired on this fixture. Restate precisely.

### `.bober/golden/` (modify — GENERATED)

Re-capture: `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`, then READ the
diff (`src/pge/golden/capture.test.ts:17-30` — "A recapture pushed without reading the diff
defeats the gate as surely as deleting it"). Expect exactly the 6 single-record additions in
§0.5 and nothing else.

### `docs/pge-graph.md` (modify)

Items 5, 6, 7 of §0.3, plus the `audits` disposition paragraph at `:1342-1373` (record the
sixth id as now DECLARED, five permanently undeclarable, `audits` still recommended for
permanent acceptance).

### `src/pge/topology/__fixtures__/coding.dot`, `coding.mermaid` (modify — hand-maintained)

Exact deltas in §0.3 item 4. **Not in `estimatedFiles` — the contract missed them; they
will fail `render.test.ts` if skipped.**

### `src/pge/topology/coding.graph.test.ts`, `src/pge/topology/docs.test.ts` (modify)

Pins listed in §0.3 items 7-8. **Neither is in `estimatedFiles`.**

---

## 2. Patterns to Follow

### Declaring a HITL on a gate node
**Source:** `src/pge/topology/coding.graph.ts:470-484`
```ts
    {
      id: "plan_clarify",
      kind: "gate",
      title: "Plan clarification interrupt",
      doc: "Human-in-the-loop interrupt collecting answers to the planner's open questions. Effect-free: the approval is a separate node from anything that writes.",
      ...
      effects: [],
      gate: { check: "clarifications-answered", onFail: "graceful_failure" },
      hitl: { checkpointId: "post-plan", onReject: "graceful_failure" },
    },
```
**Rule:** the `hitl` block sits LAST, after `gate`, on an `effects: []` node, `onReject`
always `"graceful_failure"`. This is the exact shape to add to `gate_plan_out`.

### Two-directional pins are the house style
**Source:** `src/pge/golden/coverage.test.ts:23-30`
```
 *   - a node that stops being executed fails, because coverage silently regressing is the
 *     failure this file exists to prevent;
 *   - a node that STARTS being executed also fails, because {@link NEVER_EXECUTED} is a
 *     list of claims about WHY each node is unreachable, and a node leaving it means one of
 *     those claims stopped being true and should be deleted deliberately.
```
**Rule:** every claim this sprint adds needs a test that fails when the claim stops being
true — in BOTH directions. That is also the DoD's literal wording. Same idea at
`src/orchestrator/workflow/conformance.engines.test.ts:249-257`: *"a NEW divergence fails
this test, and a divergence that gets FIXED fails it too… Not one volatile key was added to
make this list shorter."*

### Checkpoint-id validity is a RUNTIME rule, not a topology rule
**Source:** `src/pge/runtime/interrupt.ts:313-314`
```ts
export function assertKnownCheckpointId(nodeId: string, checkpointId: string): CheckpointId {
  if (!isCheckpointId(checkpointId)) throw new UnknownCheckpointIdError(nodeId, checkpointId);
```
**Rule:** `"post-sprint-contract"` is in `CHECKPOINT_IDS`
(`src/orchestrator/checkpoints/types.ts:16-26`), so `topology-invariants.test.ts` A1/A2
(`:82-105`) pass automatically, and A4 (`:127-146`, no two HITL nodes share an id) passes
because nothing else uses it.

---

## 3. Existing Utilities — DO NOT Recreate

Reviewed: `src/pge/topology/`, `src/pge/runtime/`, `src/pge/golden/`,
`src/orchestrator/checkpoints/`, `src/orchestrator/workflow/`, `src/utils/`.

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `computeFanOutRegion` | `src/pge/runtime/interpreter.ts:490` | `(spec: TopologySpec) => Set<string>` | The runtime's own fan-out-region derivation. Use it; do not re-derive by hand. |
| `computeEffectGates` | `src/pge/runtime/interpreter.ts:516` | `(spec: TopologySpec) => Map<string, EffectGate>` | Which HITL gate authorises each node — ONE hop off a declared edge, not transitive. |
| `validateTopology` | `src/pge/topology/validate.ts:468` | `(raw, opts) => ValidationReport` | The shipped validator. Run it on a MUTATED clone to prove a declaration legal/illegal. |
| `assertKnownCheckpointId` | `src/pge/runtime/interrupt.ts:313` | `(nodeId, checkpointId) => CheckpointId` | Throws `UnknownCheckpointIdError` for an id no mechanism answers. |
| `isCheckpointId` / `CHECKPOINT_IDS` | `src/orchestrator/checkpoints/types.ts:35` / `:16` | `(v: string) => v is CheckpointId` | The nine-id single source of truth. |
| `resolveCheckpointMechanismName` | `src/orchestrator/checkpoints/registry.ts:65` | `(id, config, cliOverride?, cliAll?, fallback?) => string` | Six-tier resolution; `checkpointOverrides` (tier 2) beats the global default (tier 4), `mode: "careful"` is tier 5. |
| `runWithAudit` | `src/orchestrator/checkpoints/audit.ts` (imported at `interrupt.ts:3`) | `<T>({projectRoot, runId, checkpointId, mechanism, iteration, fn}) => Promise<T>` | The ONLY audit writer. Both engines go through it. |
| `getAuditPath` | `src/orchestrator/checkpoints/audit.ts:73` | `(projectRoot, runId) => string` | `.bober/audits/<runId>.jsonl`. |
| `compareGoldenArtifacts` | `src/pge/golden/runner.ts:141` | `(expected, actual) => string[]` | Union-of-fields comparison — an UNPINNED artifact is a failure, not an omission. |
| `resolveGoldenConfig` | `src/pge/golden/executor.ts:195` | `(configInput?) => BoberConfig` | `goldenConfig()` or `goldenApprovedConfig()` from a case's `input.config`. |
| `withGoldenApproval` | `src/pge/golden/executor.ts:390` | `(runRoot, needed, fn) => Promise<T>` | Swaps a run-root-scoped `DiskCheckpointMechanism` in, restores it in a `finally`. |
| `normalize` / `VOLATILE_KEYS` | `src/orchestrator/workflow/conformance.ts:78` / `:65` | `(value: unknown) => unknown` | Canonical form. `mechanism` and `outcome` are deliberately NOT stripped; `timestamp`, `durationMs`, `approverId`, `runId` are. |
| `checksumTopology` | applied at `src/pge/topology/coding.graph.ts` (`CODING_GRAPH`) | `(spec) => string` | Reseals the authored literal. Never hand-write a checksum. |

---

## 4. Prior Sprint Output

### Sprint 1: The ADR decision
**Created:** `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md`.
**Modified:** `src/pge/topology/validate.ts:1094` — the `InterruptInsideFanOut` message now
names the runtime reason and cites the ADR by filename.
**Connection:** cite this ADR for each of the five undeclarable ids. Its Consequences name
them exactly: `pre-curator`, `pre-generator`, `pre-evaluator`, `pre-code-reviewer`,
`post-sprint`. Its Risk section calls the three runtime facts *"falsifiable conditions, not
a permanent verdict"* — quote that when recording the disposition.

### Sprint 2: Gated effects execute under a durable approval
**Created:** `goldenApprovedConfig()` (`src/pge/golden/executor.ts:152`),
`GOLDEN_APPROVED_CONFIG_INPUT` (`:173`), `withGoldenApproval` (`:390`),
`.bober/golden/replay-full-run-commit-approved.json`.
**Connection — LOAD-BEARING:** sprint 2's durable approval lives ONLY in the golden dataset.
Its own docs entry says so, `docs/pge-graph.md:1402-1406`: *"it does not touch the autopilot
path `conformanceConfig()` still runs, and it does not move any of the four conformance
fields below"*. This is the fact sc-3-3 turns on (§0.2, §9).

---

## 5. Relevant Documentation

**Principles** (`.bober/principles.md`, quoted in the handoff): ESM everywhere with `.js`
import extensions (NodeNext); `import type { ... }` (ESLint `consistent-type-imports`);
unicode box-drawing section headers; all `.bober/` state as JSON, no sync fs; conventional
commits `bober(sprint-N): description`.

**Architecture:** `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` is the
controlling document (see §4). `.bober/architecture/arch-20260805-pge-graph-engineering-adr-6.md`
is the original fan-out clause it corrects.

**Other:** `docs/pge-graph.md:209-262` (the gates section this sprint edits),
`:1339-1417` ("What a flip would still require" — the disposition section), `:1531+`
(changelog). `.github/workflows/ci.yml:40-106` — the blocking `pge-graph-gate` job.

---

## 6. Testing Patterns

**Runner:** vitest. **Assertions:** `expect`. **Mocks:** hoisted `vi.mock` +
`vi.mocked(...).mockImplementation(...)`. **Naming:** `*.test.ts` co-located with source.
**No Playwright** — the end-to-end surface is `node scripts/run-golden-regression.mjs`
(`GOLDEN_PASS_THRESHOLD: "80"`).

### Mutate a CLONE, never the committed artifact — and pair every assertion with a negative control
**Source:** `src/pge/topology/docs.test.ts:200-206`
```
// Everything below reads two real files: `docs/pge-graph.md` and
// `.bober/topology/coding.json`. Neither is ever written to — every negative control
// mutates an in-memory FIXTURE spec, never the committed artifact (HARD RULE 5).
//
// EVERY assertion below is paired with a negative control that breaks the precondition on
// a fixture and proves the assertion fails. A gate that cannot fail is not a gate.
```

### The structural pin this sprint must extend
**Source:** `src/pge/topology/coding.graph.test.ts:406-413`
```ts
  it("gives every human-in-the-loop node an onReject endpoint and no effects", () => {
    const hitl = CODING_GRAPH.nodes.filter((n) => n.hitl !== undefined);
    expect(hitl.map((n) => n.id).sort()).toEqual(["hitl_commit", "plan_clarify"]);
    for (const node of hitl) {
      expect(node.hitl?.onReject).toBe("graceful_failure");
      expect(node.effects).toEqual([]);
    }
  });
```

### Template for the NEW test that pins the ADR limitation
**Source:** `src/pge/topology-invariants.test.ts:61-78` — enumerate from `AUTHORED_GRAPHS`,
never spell a node name, and guard against a vacuous loop:
```ts
function hitlNodes(): { graphId: string; nodeId: string; checkpointId: string }[] {
  ...
      if (node.hitl === undefined) continue;
      found.push({ graphId, nodeId: node.id, checkpointId: node.hitl.checkpointId });
  ...
    // the `hitl` field renamed: an assertion loop over nothing passes silently.
    expect(hitlNodes().length).toBeGreaterThan(0);
```
**Apply it:** for each of the five in-region ids, clone the committed spec, attach a `hitl`
to an in-region node, run `validateTopology`, assert `InterruptInsideFanOut` at
`severity: "error"`. Add the positive control: `gate_plan_out` yields none. **Empirically
confirmed to behave exactly this way — see the §0.1 table.**

### Golden re-capture
`GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` rewrites the committed
replay cases (`src/pge/golden/capture.test.ts:26-30`): *"the resulting diff IS the statement
'the artifacts these runs produce have changed, and here is how'. A recapture pushed without
reading the diff defeats the gate as surely as deleting it."*

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/topology/coding.graph.test.ts:406-413` | `CODING_GRAPH.nodes[].hitl` | **high** | The `["hitl_commit","plan_clarify"]` pin FAILS. Must become a three-element array. |
| `src/pge/topology/docs.test.ts:539-551` | gate table vs artifact, field by field | **high** | `gate_plan_out`'s last column must become `post-sprint-contract`. |
| `src/pge/topology/docs.test.ts:1028-1032` | `graphVersion` + changelog headings | **high** | Both literals move to include `1.5.0`. |
| `src/pge/topology/render.test.ts:119, 270-273` | committed `coding.mermaid` / `coding.dot` | **high** | Byte-exact goldens; deltas in §0.3 item 4. |
| `src/orchestrator/workflow/conformance.engines.test.ts:405-408` | the pge audit trail | **high** | id set becomes 2, outcomes become 4. |
| `.bober/golden/replay-*.json` (6 of 7) | `audits` artifact | **high** | Union comparison — an unpinned record is a failure. Re-capture. |
| `.bober/topology/coding.json` | checksum + nodes | **high** | `pge dump --check`. |
| `.bober/topology/state-audit.json` | `generatedFrom.checksum` | **medium** | `pge audit-state` then `git diff --cached --exit-code`. |
| `src/pge/topology-invariants.test.ts:75-146` | every `hitl` node across `AUTHORED_GRAPHS` | **medium** | A1-A4 should PASS unchanged; if A4 fires you picked a duplicate id. |
| `src/pge/topology/validate.test.ts` | `InterruptInsideFanOut` fixture | **low** | Uses a synthetic 9 KB fixture, not `coding.json`. Unaffected. |
| `src/pge/golden/coverage.test.ts:143` | executed node set | **low** | `gate_plan_out` already executed; `NEVER_EXECUTED` unchanged. |
| `src/pge/topology/diff.test.ts`, `dump.test.ts`, `canonical.test.ts` | `CODING_GRAPH` shape | **low** | Version-agnostic (`bumpedVersion()` derives). Re-run anyway. |
| `src/cli/commands/pge.test.ts` | `CODING_GRAPH.checksum`, channel count | **low** | Derives from the literal; should pass. |

### Existing Tests That Must Still Pass
- `src/orchestrator/workflow/conformance.engines.test.ts` — all five tests; the divergence-set
  pin at `:340-345` MUST still list all four fields.
- `src/pge/topology-invariants.test.ts` — A1-A4 and B1-B3.
- `src/pge/golden/{coverage,capture,executor,dataset,gate,runner,workload}.test.ts`.
- `src/pge/topology/{coding.graph,docs,render,diff,dump,canonical,validate,ci-gate,audit,optimize}.test.ts`.
- `src/pge/nodes/{plan,gates,commit}.test.ts` — `gate_plan_out` behaviour and the
  `plan-gate-out` refusal path.
- `src/pge/engine/real-workload.test.ts` — asserts `plan_materialize` genuinely ran (`:442`).
- `src/orchestrator/finalize.test.ts` — **currently dirty in the working tree** (§9).

### Features That Could Be Affected
- **Sprint 2's durable-approval golden case** — shares `.bober/golden/` and the `audits`
  artifact. `replay-full-run-commit-approved` must still show all-approved with `commit` and
  `finalize` executing; the new record must be `noop`, not `disk`.
- **Careful-mode / `bober approve`** — shares `CHECKPOINT_IDS` and the disk mechanism. A PGE
  run under `mode: "careful"` now pauses at `gate_plan_out`.
- **Later sprints of this spec** (`contracts`, `pipelineResult`, node coverage) — share
  `conformance.engines.test.ts`. Do not renumber or reorder its assertions gratuitously.

### Recommended Regression Checks
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`
2. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`
3. `node dist/cli/index.js pge dump --check`
4. `node dist/cli/index.js pge validate --mode full`
5. `node dist/cli/index.js pge docs --check`
6. `node dist/cli/index.js pge audit-state && git diff --exit-code .bober/topology/state-audit.json`
7. `node dist/cli/index.js pge diff <base>/coding.json .bober/topology/coding.json --require-version-bump`
8. `node scripts/run-golden-regression.mjs` (floor 80; 7/7 replay cases today)
9. Re-run the conformance harness ALONE and READ the audit trail — do not read the pin.
10. Verify on a CLEAN checkout: `git worktree add --detach <tmp> HEAD` then run the suite
    there. Four tokensave tests self-skip on a clean checkout — pre-existing.

---

## 8. Implementation Sequence

1. **`src/pge/topology/coding.graph.ts`** — add
   `hitl: { checkpointId: "post-sprint-contract", onReject: "graceful_failure" }` to
   `gate_plan_out` (after its `gate` block, `:511`); bump `graphVersion` to `"1.5.0"` (`:124`);
   extend `gate_plan_out`'s `doc` to say it is the checkpoint the imperative pipeline records
   after `materializeContracts`.
   - **Verify:** `npm run build && node dist/cli/index.js pge validate --mode full` reports
     only `ChecksumStale` before the dump, and clean after it.
2. **`.bober/topology/coding.json` + `.bober/topology/state-audit.json`** — `pge dump`, then
   `pge audit-state`.
   - **Verify:** `pge dump --check` exits 0; `git diff` on `state-audit.json` shows only the
     checksum line.
3. **`src/pge/topology/coding.graph.test.ts`** — extend the HITL set pin to three ids, and
   add the new ADR test: for each of `pre-curator`, `pre-generator`, `pre-evaluator`,
   `pre-code-reviewer`, `post-sprint`, attach a `hitl` to an in-region node on a CLONE and
   assert `validateTopology` reports `InterruptInsideFanOut` at `severity: "error"`. Add the
   positive control too: `gate_plan_out` yields no `InterruptInsideFanOut`.
   - **Verify:** the ADR claim now fails a test if the runtime ever changes.
4. **`src/pge/topology/__fixtures__/coding.dot` and `coding.mermaid`** — apply the three
   exact edits from §0.3 item 4.
   - **Verify:** `npx vitest run src/pge/topology/render.test.ts`.
5. **`docs/pge-graph.md`** — gate table row; "Two"→"Three" at `:213`; the `:252-257` and
   `:1367-1369` two-HITL claims; `### 1.5.0` changelog entry; rewrite the `audits`
   disposition at `:1342-1373`.
6. **`src/pge/topology/docs.test.ts:1029, 1031`** — move both version literals.
   - **Verify:** `npx vitest run src/pge/topology/docs.test.ts` and `pge docs --check`.
7. **`.bober/golden/`** — `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`;
   READ the diff and confirm it is exactly the 6 additions of §0.5 and nothing else.
   - **Verify:** `node scripts/run-golden-regression.mjs` → 7/7.
8. **`src/orchestrator/workflow/conformance.engines.test.ts`** — run the harness FIRST, read
   the real trail, then update `:405-408` to the observed values and rewrite the `audits`
   paragraph at `:281-307`. Leave `:340-345` alone. Add an assertion that the five in-region
   ids are ABSENT from the pge trail, naming the ADR — so the limitation is pinned, not
   merely narrated.
   - **Verify:** all five tests pass; `"audits"` still in the divergence array.
9. **Prove the pin still bites both ways** — temporarily add a fifth field / remove `audits`
   and confirm each fails, then revert (the sprint-6 mutation precedent,
   commit `53986cf`).
10. **Full verification** — every command in §7.

---

## 9. Pitfalls & Warnings

- **THE BIGGEST TRAP — sc-3-3 rests on a false premise.** "The middle 'rejected' record is
  gone, because sprint 2's durable approval lets commit through" is TRUE **only in the golden
  dataset** (`replay-full-run-commit-approved` shows three `approved`/`disk` records). In the
  CONFORMANCE run it is still `[approved, rejected, approved]` — I ran the test; it passes
  today. Making it gone there means putting `checkpointOverrides: { "end-of-pipeline": "disk" }`
  into `conformanceConfig()` — **and `runnerFor` builds ONE config and hands it to BOTH
  engines** (`conformance.engines.test.ts:143-156`). The TS engine's `finalizePipelineRun`
  would then resolve `end-of-pipeline` to the real `DiskCheckpointMechanism` and BLOCK the
  imperative run until it times out, moving the ts-side `mechanism` from `noop` to `disk`,
  moving `approverId` (stripped, but the run behaviour is not), and risking a 60 s timeout in
  every one of the five conformance tests. **The honest disposition is to record the fact —
  the conformance harness deliberately measures the shipped autopilot path — rather than to
  route the shared config through disk.** If you disagree, say so explicitly in the commit
  message and prove both engines still finish.
- **`plan_materialize` looks like the right host and is not.** `effects: ["fs-write"]`
  (`coding.graph.ts:496`) trips `EffectfulNodeContainsHitl`
  (`validate.ts:1101-1111`). Verified empirically. `gate_plan_out` is the host.
- **Do NOT delete `"audits"` from `conformance.engines.test.ts:340-345`.** Spec feat-3 AC2
  forbids it without an ADR revisit, and the handoff's `amendedGoal` restates it. The set
  stays four.
- **Do NOT shrink the imperative engine's trail** to force set-equality. `outOfScope[5]`
  forbids changing the imperative pipeline's behaviour, and `nonGoals[1]` forbids
  reclassifying a refusal.
- **`.bober/topology/coding.json` and `state-audit.json` are GENERATED.** Hand-editing them
  passes `dump --check` never. Two separate commands: `pge dump`, then `pge audit-state`.
- **`coding.dot` / `coding.mermaid` are hand-maintained goldens** with no `CAPTURE=1` escape
  hatch, and they are NOT in `estimatedFiles`. Exact deltas are in §0.3 item 4.
- **`docs.test.ts` hard-codes `"1.4.0"` twice** (`:1029`, `:1031`). Bumping the artifact
  without moving both makes a green build red.
- **The working tree is DIRTY with an in-flight sprint-2 follow-up** as of this briefing:
  `src/orchestrator/finalize.ts` (+ `finalize.test.ts`), `src/pge/golden/executor.ts`
  (+ `executor.test.ts`), and `.bober/golden/replay-full-run-commit-approved.json` (one line,
  `"mechanism": "noop"` → `"disk"`). That is the fix routing `finalize`'s audit label through
  `resolveCheckpointMechanismName` instead of the bare `config.pipeline?.checkpointMechanism`.
  **Check `git status` before starting** — if it is still uncommitted, do not clobber it, and
  do not attribute its golden diff to your own change. It also means a re-capture will pick
  up BOTH deltas.
- **`post-plan` is DECLARED but never EVALUATED on the conformance fixture** — a settled plan
  takes `e-plan-ok -> plan_materialize`, never `e-plan-clarify`. Do not write "the only id
  the artifact declares"; write "the only id this fixture evaluates". Both existing briefings
  for this spec flag this exact wording trap.
- **`gate_plan_out` gains a SECOND dotted edge to `graceful_failure`** in the mermaid render
  (`onFail` and `onReject`). That is not a bug — `plan_clarify` already renders both.
- **A bare `npx vitest run` picks up nested worktrees.** Always pass
  `--exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`, and never touch
  `.claude/worktrees/`.
- **Verify on a clean checkout.** This repo has twice been green locally and red in CI because
  uncommitted state carried the result.
