# Sprint Briefing: Checkpoints inside the sprint fan-out — the ADR decision

**Contract:** sprint-spec-20260814-pge-full-convergence-1
**Generated:** 2026-08-14T08:45:00Z

> This is an **architecture-decision sprint**. The weight below is on evidence for the
> decision (sections 1, 5, 7), not on implementation mechanics. The code change is small;
> the ADR is the deliverable. Read section 5 before touching `validate.ts`.

---

## 1. Target Files

### `src/pge/topology/validate.ts` (modify) — 1225 lines

**The rule — lines 1089-1100, inside `collectNodePolicyRules` (`:1071-1075`, which receives
`fanOutRegion` as a parameter; wired at `:488` and `:495`):**
```ts
    if (node.hitl) {
      if (fanOutRegion.has(node.id)) {
        out.push(
          diag(
            "InterruptInsideFanOut",
            `Node "${node.id}" raises a human-in-the-loop interrupt but is reachable only through a fan-out edge.`,
            [node.id],
            [],
            ["nodes", i, "hitl"],
          ),
        );
      }
```
The message carries **no reason** — it states the shape, not the hazard. `sc-1-3`'s
"the diagnostic gains the reason" branch means editing this string.

**`diag()` hardcodes error severity — `validate.ts:410-418`:**
```ts
function diag(code, message, nodeIds = [], edgeIds = [], path?): ValidationDiagnostic {
  return { code, severity: "error", message, nodeIds, edgeIds, path };   // :417 verbatim
}
```
**There is no warn-emitting helper.** `DiagnosticSeverity = "error" | "warn"` is declared at
`validate.ts:82` and `"warn"` appears nowhere else under `src/pge/topology/` (`grep -n '"warn"'
src/pge/topology/*.ts` → one hit, the type alias). `ok` is
`diagnostics.every((d) => d.severity !== "error")` (`validate.ts:502`) — so downgrading to a
warning needs a *new* helper and would be the first warn diagnostic in the codebase.

**How `fanOutRegion` is computed — `validate.ts:602-607` (inside `collectReachability`,
`:591-641`):**
```ts
  const reachable = reachableFrom(index, spec.entry, () => true);
  const withoutFanOut = reachableFrom(index, spec.entry, (edge) => edge.kind !== "fanout");
  const fanOutRegion = new Set<string>();
  for (const id of reachable) {
    if (!withoutFanOut.has(id)) fanOutRegion.add(id);
  }
```
A plain set difference: reachable-from-entry minus reachable-without-traversing-a-`fanout`
edge. `reachableFrom` is at `validate.ts:268-287`; the adjacency it walks also includes
**policy endpoints** (`gate.onFail`, `hitl.onReject`, `loop.onExhausted`) linked as
`kind: "normal"` (`validate.ts:189-213`, linked at `:251-262`). The runtime keeps a
deliberate duplicate at `src/pge/runtime/interpreter.ts:490-498` (`computeFanOutRegion`;
the comment at `:481-489` explains the module-graph boundary) which walks `spec.edges`
only — **for the committed artifact the two agree exactly** (recomputed both against
`.bober/topology/coding.json`: same 16 ids, empty symmetric difference).

**The fan-out region of the committed topology — 16 of 44 nodes** (recomputed from
`.bober/topology/coding.json`, `graphVersion` 1.4.0, entry `research_body`):

`sprint_body` (subgraph call site) and, all `subgraph: "sprint"`: `gate_sprint_in`,
`sprint_curate_explain`, `sprint_curate_mocks` (fs-write), `gate_mock_coverage`,
`sprint_generate` (fs-write), `gate_syntax` (sandbox-exec), `sprint_security`,
`sprint_correct` (fs-write), `sprint_evaluate` (sandbox-exec), `gate_anchor_regression`
(sandbox-exec), `sprint_route`, `sprint_review`, `sprint_exit` (fs-write), `gate_sprint_out`
— **plus `reduce_sprints`**, a root-scope (`subgraph: null`) gate.

Only two edges are `kind: "fanout"`, both into `sprint_body`:
`e-sprint-dispatch` (`fanout_sprints -> sprint_body`) and `e-rework-dispatch`
(`rework_route -> sprint_body`).

**Load-bearing finding — the fan-in barrier is itself inside the region.** `reduce_sprints`
has exactly one inbound edge, `e-sprint-released` from `gate_sprint_out`, itself in the region
— so a HITL declared on the barrier would be rejected today. ADR-6's Consequences say
"`hitl_commit` sits at the fan-in barrier, batching approval for every branch in one
interrupt", but the artifact's `hitl_commit` is **not** there: it sits after `documenter`
(`e-doc-approval`), outside the region. **No gated effect (`git`/`process-exec`) exists
anywhere in the region** — `sandbox-exec` and `fs-write` are not in `GATED_EFFECTS`
(`interrupt.ts:75`) — so relaxing the rule cannot un-gate a git commit by itself.

**Imported by (non-test callers of `validateTopology`):** `src/pge/compile/compiler.ts:663`
(`mode: "structural"`, compile time) · `src/pge/engine/pge-engine.ts:387` (engine load) ·
`src/cli/commands/pge.ts:182, :289` (`pge dump --check` / `pge validate`) ·
`src/pge/topology/optimize.ts:77` · `src/pge/nodes/regions.ts:34` (documented dependency).

**Test file:** `src/pge/topology/validate.test.ts` — exists, 782 lines, 100 tests, green today.

---

### `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` (create)

**Directory pattern:** `.bober/architecture/arch-<YYYYMMDD>-<spec-slug>-adr-<N>.md`, verified
against the 8-file set `arch-20260805-pge-graph-engineering-adr-{1..8}.md`. **No `arch-20260814-*`
file exists yet.** **Most similar existing files:** `…-adr-6.md` (the one being amended) and
`…-adr-7.md` — the repo's only "we decline a prescription" ADR, the closest structural analogue.

**Structure template — the authoritative source is `.claude/agents/bober-architect.md:370-389`:**
```markdown
# ADR-N: <Decision Title>

**Decision:** <1 sentence — what was decided>
**Context:** <Why the decision was needed. 2-3 sentences max.>
**Options Considered:**   <a | Option | Pros | Cons | markdown table, one row per option>
**Rationale:** <Why this option won. Must name a specific constraint.>
**Consequences:** <What changes. Concrete, not abstract.>
**Risk:** <"If X assumption is wrong, Y will fail.">
```
(Each label is its own paragraph in the real ADRs — see
`arch-20260805-pge-graph-engineering-adr-6.md:3,5,7,15,17,19`.)
Six required fields, cap **50 lines** (`bober-architect.md:368, :527, :529, :567`).

**How superseding is expressed in this repo: it is not.** `grep -rln -i "supersede"` over
`.bober/architecture/` returns one file whose only hit is `arch-20260616-medical-team-adr-7.md:12`,
a Cons cell about database rows — not an ADR relationship. **No ADR here carries a `Status:`
or `Supersedes:` header**, and the template has no slot for either. State the amendment in
prose inside **Decision:**/**Context:**, and add one forward-pointing sentence to
`arch-20260805-pge-graph-engineering-adr-6.md`. That edit is safe: **no test reads any real
`.bober/architecture/*.md` today** (`grep -rln "\.bober/architecture" src/` returns only
modules that *write* such paths, plus `architect-agent.test.ts`'s fabricated fixture path).

---

### `src/pge/topology/validate.test.ts` and `docs/pge-graph.md` (modify)
See §6 for the assertion pattern and §7 for what pins them.

---

## 2. Patterns to Follow

### Diagnostic messages explain the remedy
**Source:** `src/pge/topology/validate.ts:1104-1105` — the sibling rule in the same block:
```ts
            "EffectfulNodeContainsHitl",
            `Node "${node.id}" declares effects (${node.effects.join(", ")}) and its own HITL interrupt; the approval must be a separate upstream node.`,
```
**Rule:** the house style names the remedy. `InterruptInsideFanOut`'s message names neither
hazard nor remedy — that asymmetry is exactly the sc-1-3 target.

### A new code must be added to the closed set
**Source:** `src/pge/topology/validate.ts:45-80` — `DIAGNOSTIC_CODES` is a
`as const` tuple, `DiagnosticCode` is derived from it. Adding, renaming or removing a member
is a three-file change (see §7).

### Section comments
**Source:** `src/pge/topology/validate.ts:33, :408, :428` — `// ── Rule helpers ───────`
(unicode box-drawing headers, as `.bober/principles.md` requires).

### Doc marker regions
**Source:** `src/pge/topology/docs.ts:31-32`
```ts
export const DOC_NODES_BEGIN = "<!-- pge:nodes -->";
export const DOC_NODES_END = "<!-- /pge:nodes -->";
```
**Rule:** never write the literal marker text in prose in `docs/pge-graph.md` — it opens a
node region and turns every backticked identifier in the following prose into node drift.
(This exact trap was hit and recovered from in `spec-20260812-terminal-vocabulary` sprint 6;
see `docs/sprints/README.md:2747`.)

---

## 3. Existing Utilities — DO NOT Recreate

Directories reviewed: `src/pge/topology/`, `src/pge/runtime/`, `src/orchestrator/checkpoints/`,
`src/utils/`. `src/utils/` holds `fs.ts`/`git.ts`/`logger.ts` — **none applicable** to a
validator/ADR sprint.

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `diag` | `src/pge/topology/validate.ts:410` | `(code, message, nodeIds?, edgeIds?, path?) => ValidationDiagnostic` | The **only** diagnostic constructor; hardcodes `severity: "error"` |
| `collectReachability` | `src/pge/topology/validate.ts:591` | `(spec, index, out) => { reachable; fanOutRegion }` | Computes `fanOutRegion` once; already threaded into `collectNodePolicyRules` at `:495` |
| `reachableFrom` | `src/pge/topology/validate.ts:267` | `(index, start, allow) => Set<string>` | Edge-filtered DFS. Reuse for any new region predicate |
| `computeFanOutRegion` | `src/pge/runtime/interpreter.ts:490` | `(spec: TopologySpec) => Set<string>` | The runtime's copy of the same derivation — **exported**, keep the two in step |
| `computeEffectGates` | `src/pge/runtime/interpreter.ts:516` | `(spec) => Map<string, EffectGate>` | Which HITL gate authorises each effectful node, read off the artifact |
| `findCycles` | `src/pge/topology/validate.ts:318` | `(spec) => StronglyConnectedComponent[]` | Exported Tarjan SCC |
| `grantScope` / `grantKey` | `src/pge/runtime/interrupt.ts:268, :292` | `(checkpointId, gateNodeId) => string` / `(scope, GrantPass) => string` | Approval identity — `branchKeys`+`superstep`+`payload` |
| `gatedEffectsOf` | `src/pge/runtime/interrupt.ts:80` | `(node: NodeSpec) => EffectTag[]` | The gated effects a node declares (`GATED_EFFECTS` = `["git","process-exec"]`, `:75`) |
| `isCheckpointId` / `CHECKPOINT_IDS` | `src/orchestrator/checkpoints/types.ts:35, :16` | `(value: string) => value is CheckpointId` | The nine legal ids |
| `checksumTopology` | `src/pge/topology/canonical.ts` (imported at `validate.ts:18`) | `(spec) => string` | Re-seal a mutated fixture so `ChecksumStale` does not drown the rule under test |
| `topologyArtifactPath` / `readTopologyArtifact` | `src/pge/topology/dump.ts` (used at `docs.test.ts:219, :240`) | `(root, graphId) => string` | Locate/read the committed artifact from a test |

---

## 4. Prior Sprint Output

`dependsOn: []` — this is sprint 1. The relevant prior work is the **previous spec**,
`spec-20260812-terminal-vocabulary`, whose sprint 6 wrote the disposition this sprint
reopens:

**`docs/pge-graph.md:1333-1350`** — records `audits` as *recommended for permanent acceptance*
because "five of the eight checkpoint ids the imperative pipeline records sit inside the
sprint fan-out region, where `InterruptInsideFanOut` (`src/pge/topology/validate.ts:1089-1099`)
is a BLOCKING validation error (`severity: "error"`) by ADR-6". It also corrects an earlier
claim: the artifact declares **two** HITL ids, `plan_clarify -> post-plan`
(`coding.graph.ts:483`) and `hitl_commit -> end-of-pipeline` (`coding.graph.ts:909`), but only
`end-of-pipeline` is ever *evaluated* on the golden fixture because a settled plan takes
`e-plan-ok` and never `e-plan-clarify`.

**Connection to this sprint:** that paragraph is the claim this sprint either upholds (rule is
sound → amend the spec's `audits` goal) or overturns (fan-out checkpoints become legal). Either
way the paragraph must be updated, and `docs.test.ts:956` pins that it still names
`InterruptInsideFanOut` by that literal string.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`, via the handoff)
- ESM/NodeNext, `.js` extensions on every relative import.
- `import type` for types (`consistent-type-imports` is an ESLint error).
- Tests collocated: `*.test.ts` next to `*.ts`.
- No hand-rolled validation; Zod only. No `fs` sync ops.
- Conventional commits; sprint commits are `bober(sprint-N): description`.

### Architecture Decisions — ADR-6 in full, and what it actually argues

`.bober/architecture/arch-20260805-pge-graph-engineering-adr-6.md` is 19 lines. The clause under
revision is the **last sentence of Decision** (`:3`):

> `InterruptInsideFanOut` rejects, at validation time, any HITL node reachable only through a
> fan-out edge.

**Does the ADR state a hazard for *this* clause? Read carefully: no — not directly.** The
document's stated hazard is **double execution under restart-from-top resume**, which is an
argument about *where* an interrupt fires (before the node vs inside it), not about *whether a
fan-out branch may host one*. Quoting the Rationale (`:15`) in full:

> **Rationale:** The **success criterion that each state key is written exactly once per
> superstep** (asserted by a write-counter spy across 8 concurrent branches) eliminates Options
> A and B: under restart-from-top, a resumed superstep re-enters branches whose writes already
> committed, producing duplicate writes that no reducer can distinguish from legitimate ones.
> Option B is additionally eliminated because the required discipline has no enforcement point,
> whereas Option C converts the hazard into two compile-time validator errors
> (`InterruptInsideFanOut`, `EffectfulNodeContainsHitl`) that a later edit cannot reintroduce.

The only fan-out-specific sentence is in **Option A's Cons** (`:11`):

> Combined with fan-out, resume re-enters sibling branches that already committed.

and in **Option C's Pros** (`:13`):

> per-branch approvals batch naturally at the fan-in barrier so one interrupt covers N branches

and in **Consequences** (`:17`):

> `hitl_commit` sits at the fan-in barrier, batching approval for every branch in one interrupt.

**What this means for the sprint's licence to revisit.** The rule is a *belt-and-braces*
consequence of a decision whose actual hazard (node-body re-entry on resume) was already
eliminated by boundary interrupts. ADR-6 asserts the barrier alternative is sufficient — it
never argues that a per-branch interrupt is *unsound*, only that it is *unnecessary*. That is a
narrower claim than the validator enforces, and it is the gap this ADR must close in one
direction or the other. **Do not overstate this**: the ADR's Option C Pros do contain a real
soundness claim — "the checkpoint at the pause is a single consistent snapshot with no branch
mid-flight" — and §5's runtime trace below shows the current machinery cannot deliver that for
a per-branch pause.

### The semantics question, decided from what the runtime can do

Three candidate meanings when N branches reach a node declaring a checkpoint:

**(a) One approval covering all N branches.**
*Expressible today — but only OUTSIDE the region.* The join fires as **one** task with
`branchKey: null` at the first node outside the fan-out region
(`interpreter.ts:1571-1579`): `enqueue(createPendingTask({ nodeId, input: { fanIn: results } }))`,
and `leavingFanOut` is `task.branchKey !== null && fanOutRegion.has(task.nodeId) && !fanOutRegion.has(destination.nodeId)`
(`interpreter.ts:1485-1488`). For the committed graph that node is `supervisor`. **Every node
inside the region executes once per branch** — including `reduce_sprints`. So "one approval for
all branches" is exactly what ADR-6 already provides, at the join target, and *cannot* be
expressed by declaring a checkpoint on an in-region node without new machinery.

**(b) One approval per branch.** *Not expressible — three independent blockers.*

1. **The checkpoint can hold one pending interrupt.** `Checkpoint.interrupt` is
   `InterruptRecord | null` (`src/pge/runtime/checkpointer.ts:247`, schema at `:132-139`), and
   the interpreter **returns from the run** on the first raise
   (`interpreter.ts:1135-1164`): `return { status: "interrupted", checkpointRef, pending: error.record, ... }`.
   N concurrent pauses cannot be represented.
2. **A grant scope holds at most one grant, and a sibling branch's arrival deletes it.**
   `grantScope` is `` `${checkpointId} @ ${gateNodeId} # ` `` (`interrupt.ts:268`) — it carries
   **no branch discriminator**. `maybeInterrupt` calls `clearScope(scope)` before asking
   (`interrupt.ts:485`), and `clearScope` deletes *every* key with that prefix
   (`interrupt.ts:371-375`). Branch B's arrival therefore **evicts branch A's approval**.
   `applyResume` does the same (`interrupt.ts:414` and `:434-436`, which filters all in-scope
   keys out of `carried`). Traced consequence in `mode: "suspend"`: resume 1 grants A, the loop
   re-runs, B clears A's grant and pauses; resume 2 grants B, the loop re-runs, A clears B's
   grant and pauses — **the run cannot converge**. This is a code trace, not an executed
   experiment; pin it with a test rather than citing it as measured.
   The invariant is already pinned as intended behaviour:
   `src/pge/runtime/interrupt.test.ts:794` — *"restore REPLACES whatever the same gate scope
   held, so a scope never holds two grants"*.
3. **The decision message has no per-branch identity.** `resumeMessageId(checkpointId)` is
   `` `hitl:${checkpointId}` `` (`interrupt.ts:332-334`); `applyResume` rebuilds `messages` by
   *replacing* the row with that id (`interrupt.ts:428-431`); the consumer matches on
   `message.nodeId` with no branch key (`src/pge/nodes/plan.ts:142-144`). N branch decisions
   collapse to one row. `src/pge/topology-invariants.test.ts:127-132` states this explicitly for
   the two-gates case — *"a second gate's resume EVICTS the first gate's recorded human
   decision from state"* — and the per-branch case is the same eviction with the same key.

   Note the one thing that *does* already work: `grantKey` hashes `branchKeys` alongside
   `superstep` and `payload` (`interrupt.ts:292-294`), the interpreter passes
   `branchKeys: task.branchKey === null ? [] : [task.branchKey]` (`interpreter.ts:1131`), and
   `interrupt.test.ts:862-876` pins that a different branch key yields a different key. So
   *identity* is per-branch; only *retention* is not.

**(c) A barrier that joins before asking.** *Already the shipped shape, and it is (a).* Nothing
new is needed: put the HITL on the join target, which is by construction outside the region.

**The concurrency argument that decides it.** `cap` defaults to 1
(`.bober/topology/coding.json` `defaults.concurrency: 1`; `src/pge/runtime/frontier.ts:13`
"`cap` defaults to 1"). At cap 1 the branches serialize, each grant is consumed before the next
branch arrives, and blocker 2 may never fire. At cap 8 it fires. `frontier.ts:29-32` states the
governing criterion:

> `plan` sorts the frontier into a total order that does not depend on arrival order
> (`nodeId`, then `branchKey`, then `taskKey`). Two runs of the same graph therefore admit the
> same tasks in the same order at every cap, which is what makes the concurrency-1-versus-8
> artifact comparison decidable rather than flaky.

A per-branch fan-out checkpoint is therefore **concurrency-dependent behaviour**, which is
precisely what ADR-4's "byte-identical at concurrency 1 and 8" criterion forbids. That is the
strongest available argument that (b) is unsound *as the machinery stands today* — and it is a
statement about the runtime, not about taste, which is what the contract asks for.

### Other docs
- `docs/pge-graph.md:1162-1444` — "Engine migration disposition"; the paragraph to amend is at
  `:1333-1350` under "**What a flip would still require beyond everything this spec did**".
- `src/orchestrator/workflow/conformance.engines.test.ts:285-301` — the same claim in a
  comment; prose only, no assertion depends on it, but it will read as stale if not updated.

---

## 6. Testing Patterns

**Runner:** vitest 3.2.6. **Assertions:** `expect`. **Mocks:** none — real temp dirs
(`mkdtemp`), real files. **Naming:** `<module>.test.ts`, collocated.

### Asserting a diagnostic IS emitted — the canonical both-directions pattern
**Source:** `src/pge/topology/validate.test.ts:15-18, :36-46, :505-522`
```ts
/** Unique error-severity codes, so a fixture is pinned to exactly one rule. */
function errorCodes(report: ValidationReport): DiagnosticCode[] {
  return [...new Set(report.diagnostics.filter((d) => d.severity === "error").map((d) => d.code))];
}

// Mutate the well-formed fixture and RE-SEAL its checksum, so the rule under test is
// not drowned out by ChecksumStale.
async function mutatedValid(
  mutate: (raw: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const raw = (await loadFixture("valid")) as Record<string, unknown>;
  mutate(raw);
  raw.checksum = checksumTopology(TopologySpecSchema.parse(raw));
  return raw;
}
```
Positive direction (`validate.test.ts:510-522`):
```ts
    const raw = await mutatedValid((spec) => {
      const node = nodeOf(spec, nodeId);
      (node[field[0]] as Record<string, unknown>)[field[1]] = "does_not_exist";
    });
    const report = validateTopology(raw);
    expect(errorCodes(report)).toEqual(["DanglingEdge"]);
    const diagnostic = report.diagnostics[0];
    expect(diagnostic.nodeIds).toEqual([nodeId]);
    expect(diagnostic.message).toContain("does_not_exist");
    expect(diagnostic.path?.[0]).toBe("nodes");
```
Negative direction — assert a shape is now **legal** (`validate.test.ts:530-551`, tail):
```ts
    const report = validateTopology(raw);
    expect(errorCodes(report)).toEqual([]);
    expect(report.ok).toBe(true);
```
**`toEqual([code])`, never `toContain`** — `pge.test.ts:255-257` explains why: a fixture that
also tripped four unrelated rules used to pass.

### There is NO dedicated test for `InterruptInsideFanOut` today
`grep -n "hitl\|InterruptInside\|FanOut" src/pge/topology/validate.test.ts` returns only three
incidental hits (`:290`, `:500`, `:508`). The rule is covered **solely** by the fixture-driven
table at `validate.test.ts:77-88`. sc-1-4's both-directions pin is therefore new work.

### Reading a shipped repo file from a test, and asserting a doc claim
**Source:** `src/pge/topology/docs.test.ts:217-219, :249, :956`
```ts
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DOC_PATH = join(REPO_ROOT, "docs", "pge-graph.md");
// in beforeAll: shippedDoc = await readFile(DOC_PATH, "utf8");
expect(doc, "audits' ADR-6 fan-out ground must be named").toContain("InterruptInsideFanOut");
```
Use the same shape to read `.bober/architecture/<new-adr>.md` (adjust the `../` depth for
wherever the test lives). Match on **subjects**, not sentences, and give every `expect` a
message string so a failure says what the document stopped claiming.

### E2E
None — no `playwright.config.ts` and no `e2e/` directory in this repo.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break

| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/pge/topology/validate.test.ts:64-66` | `DIAGNOSTIC_CODES` | **high** | `expect(codesWithFixture.sort()).toEqual([...DIAGNOSTIC_CODES].sort())` **and** `expect(DIAGNOSTIC_CODES).toHaveLength(32)` |
| `src/cli/commands/pge.test.ts:229-231, :247-260` | `DIAGNOSTIC_CODES` | **high** | A second `toHaveLength(32)` and a second one-fixture-per-code table over the CLI |
| `src/pge/zero-execution.test.ts:188-195` | `DIAGNOSTIC_CODES` | **high** | Iterates every code, asserts `runPgeValidate` exits 1 for its fixture |
| `src/pge/topology/__fixtures__/InterruptInsideFanOut.json` | the code name | **high** | Filename **is** the code. Its `sprint_generate` node declares `hitl.checkpointId: "sprint_hitl"` behind `e7` (`sprint_body -> gate_sprint_in`, `kind: "fanout"`). If the rule is relaxed this fixture stops producing the code and the table test fails |
| `src/pge/topology/docs.test.ts:956` | literal `"InterruptInsideFanOut"` in `docs/pge-graph.md` | **medium** | Renaming the code without editing both breaks the doc pin |
| `src/pge/topology/coding.graph.test.ts:123-135, :398-412` | `validateTopology(CODING_GRAPH)` | **medium** | The committed graph must still validate clean; `:408` pins the HITL node set as exactly `["hitl_commit", "plan_clarify"]` |
| `src/pge/topology-invariants.test.ts:75-146` | `hitl` nodes across graphs | **medium** | A1-A4; A4 forbids two HITL nodes sharing a checkpoint id |
| `src/pge/compile/compiler.ts:663`, `src/pge/engine/pge-engine.ts:387` | `validateTopology` | **medium** | Relaxing the rule makes a previously-uncompilable topology compile — intended for sprint 3, but verify nothing else assumed the block |
| `src/pge/topology/optimize.ts:77` + `optimize.test.ts` | `validateTopology` | low | Optimiser re-validates its output |
| `src/pge/runtime/interpreter.test.ts`, `src/pge/registry/production.test.ts` | `validateTopology` | low | Import the validator; unaffected unless the report shape changes |
| `src/orchestrator/workflow/conformance.engines.test.ts:295-300` | prose comment only | low | No assertion; update for honesty |

### Existing Tests That Must Still Pass
- `src/pge/topology/validate.test.ts` — 100 tests; the fixture-coverage table and the code-set count.
- `src/cli/commands/pge.test.ts` — the CLI's own per-code table and `EXIT_FAILED` expectations.
- `src/pge/zero-execution.test.ts` — every code's fixture must still exit non-zero **and** no
  node may execute during validation (`probe.lookups`/`probe.invocations` empty).
- `src/pge/topology/coding.graph.test.ts` — the committed topology validates with zero
  diagnostics (sc-1-5).
- `src/pge/topology/docs.test.ts` — node/gate/loop/router/edge/channel drift plus
  `assertFlipPrerequisitesStated` (`:949-978`).
- `src/pge/topology-invariants.test.ts` — A1-A4, B1-B2 (B2 pins that `git` still fails closed).
- `src/pge/runtime/interrupt.test.ts` — 878 lines; `:794` (one grant per scope) and `:862`
  (pass identity) are the two the ADR reasons about. **Do not weaken either** — sprint 2 owns
  interrupt mechanics (`nonGoals[1]`).
- `src/orchestrator/workflow/oracle-retention.test.ts` — pins `pipeline.engine` default `"ts"`.

### Features That Could Be Affected
- **feat-3 "audits converges"** (`spec-20260814-pge-full-convergence.json`, `dependsOn:
  ["feat-1","feat-2"]`) — its AC2 is *"'audits' no longer appears in the divergence set"*. If
  this ADR upholds the rule, **that acceptance criterion becomes unreachable and the contract
  requires it be amended honestly**, not quietly passed (`stopConditions[0]`,
  `evaluatorNotes`). The spec's own `riskNotes` pre-authorises this outcome.
- **Golden gate** — unaffected while no checkpoint is declared: the gate validates the dataset
  against the committed artifact (`scripts/run-golden-regression.mjs` → `src/pge/golden/gate.ts`),
  and the artifact is not being changed this sprint.

### Recommended Regression Checks
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'` — full suite.
2. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**' src/pge/topology src/pge/zero-execution.test.ts src/pge/topology-invariants.test.ts src/cli/commands/pge.test.ts src/pge/runtime/interrupt.test.ts` — the blast radius, fast.
3. `npm run build && node scripts/run-golden-regression.mjs` — golden gate (needs `dist/`).
4. `npm run typecheck && npm run typecheck:tests && npm run lint`.
5. Baseline recorded before any edit: `validate.test.ts` 100 tests + `coding.graph.test.ts` 55
   tests = **155 passed**, 2 files, green (run at briefing time).
6. Verify on a **clean checkout**, not the working tree — the handoff's `environmentNote` says
   this repo has twice been green locally and red in CI from uncommitted state.

---

## 8. Implementation Sequence

1. **Read `.bober/architecture/arch-20260805-pge-graph-engineering-adr-6.md` end to end** and
   quote its Rationale before proposing anything (sc-1-1, `generatorNotes`).
   - Verify: your write-up names the hazard ADR-6 actually states (double execution under
     restart-from-top) and distinguishes it from the fan-out clause, which ADR-6 justifies as
     *unnecessary* rather than *unsound*.
2. **Settle the semantics from the runtime**, using §5 — `interrupt.ts:268/292/371-375/485/414`,
   `checkpointer.ts:247`, `interpreter.ts:1118-1164/1485-1488/1571-1579`, `frontier.ts:13/29-32`.
   - Verify: for each of (a)/(b)/(c) you can say what the machinery does *today*, citing a line.
3. **Write the ADR** at `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` using
   the six-field template, ≤50 lines, stating the amendment relationship to ADR-6 in prose.
   Add one forward-pointing sentence to ADR-6 itself.
   - Verify: six bold field labels present; no `Status:`/`Supersedes:` header (no repo precedent).
4. **Change `validate.ts` to match the ADR — and only that.**
   - If the rule stands: rewrite the message at `:1094` to carry the reason, leaving the code
     and severity untouched. `DIAGNOSTIC_CODES` does not change; the three `toHaveLength(32)`
     pins stay green.
   - If it is relaxed: the replacement rule must still reject whatever the ADR calls unsound.
     Changing the code name means editing the fixture filename **and** `DIAGNOSTIC_CODES`
     **and** the doc pin at `docs.test.ts:956` — three tests count the set (§7).
   - Verify: `npx vitest run … src/pge/topology/validate.test.ts` green.
5. **Pin both directions** in `validate.test.ts` using `mutatedValid` + `errorCodes(...)` —
   one test that a now-legal topology yields `toEqual([])` and `ok === true`, one that the
   still-forbidden shape yields `toEqual([<code>])`. Construct the forbidden topology yourself;
   the evaluator will do the same (`evaluatorNotes`).
   - Verify: temporarily revert the `validate.ts` edit and confirm **both** new tests fail.
6. **Pin the ADR** (sc-1-2 is `verificationMethod: "unit-test"`) — read the file with the
   `docs.test.ts:217-219` pattern and assert phrase-tolerantly that it names the amendment
   relationship and states the semantics conclusion.
   - Verify: delete a sentence from the ADR and watch the test fail.
7. **Update `docs/pge-graph.md:1333-1350`** and, if the rule stands, amend the spec's `audits`
   goal (`.bober/specs/spec-20260814-pge-full-convergence.json`, feat-3 AC2) honestly.
   - Verify: `docs.test.ts` `assertFlipPrerequisitesStated` still green; the literal
     `InterruptInsideFanOut` still present.
8. **Confirm the committed artifact still validates and no checkpoint was declared** (sc-1-5).
   - Verify: `coding.graph.test.ts` green; `git diff --stat .bober/topology/` is empty.
9. **Run full verification** — `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`,
   `npm run typecheck`, `npm run typecheck:tests`, `npm run lint`, `npm run build`,
   `node scripts/run-golden-regression.mjs`.

---

## 9. Pitfalls & Warnings

- **`.bober/topology/coding.json` is generated** by `bober pge dump` from
  `src/pge/topology/coding.graph.ts`. Never hand-edit it. This sprint should not change it at
  all (`nonGoals[0]`).
- **The code name is the fixture filename.** `validate.test.ts:60-66` derives the expected code
  set from `readdir(__fixtures__)`. Renaming `InterruptInsideFanOut` without renaming
  `__fixtures__/InterruptInsideFanOut.json` fails immediately.
- **`toHaveLength(32)` appears in three files** — `validate.test.ts:65`, `pge.test.ts:230`,
  and implicitly via the loop in `zero-execution.test.ts:188`. Changing the code-set size is a
  three-file edit.
- **There is no warn-severity path.** `diag()` hardcodes `"error"` (`validate.ts:417`) and
  `ok` rejects on any error (`:502`). "Downgrade it to a warning" is a larger change than it
  looks and would be the first warn diagnostic in the codebase.
- **Do not weaken `interrupt.ts` to make sprint 3 easier.** `nonGoals[1]` reserves interrupt
  mechanics for sprint 2, and `stopConditions[0]` explicitly pre-authorises concluding that the
  rule is sound. `interrupt.test.ts:794`'s one-grant-per-scope invariant is deliberate.
- **Never write `<!-- pge:nodes -->` (or the other four marker pairs) in prose** in
  `docs/pge-graph.md` — it opens a machine-checked region and every backticked identifier after
  it becomes node drift. Name the section instead of the marker.
- **`reduce_sprints` is inside the fan-out region**, so "put the checkpoint on the barrier" is
  not available as written — the true single-execution join target is `supervisor`, outside the
  region. Do not repeat ADR-6's loose phrasing that `hitl_commit` "sits at the fan-in barrier";
  in the committed artifact it sits after `documenter`.
- **`.bober/architecture/` currently has no test coverage**, so a malformed ADR will not fail
  anything until the sprint's own new test exists. Write the test, not just the document —
  `definitionOfDone` requires every documentation claim be backed by a test that fails when the
  claim stops being true.
- **Do not touch `.claude/worktrees/`.** A bare `npx vitest run` picks it up; always pass both
  `--exclude` flags.
