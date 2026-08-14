# Sprint Briefing: Gated effects execute under a durable approval

**Contract:** sprint-spec-20260814-pge-full-convergence-2
**Generated:** 2026-08-14T00:00:00Z

## TL;DR — the five facts that decide this sprint

1. **The one condition that fails** is `grant !== undefined` at `interrupt.ts:537`, and the only
   filler is `interrupt.ts:523` (`if (mechanismName !== "noop") granted.set(key, outcome)`). The
   ONLY lever is `config` — `PgeEngine` never injects an `InterruptController`. (§2)
2. **`disk` is fully implemented and blocking.** It DELETES a pre-placed `.approved.json` before it
   polls (`disk.ts:80-83`), so a committed fixture cannot be consumed as-is. Three honest routes
   in §4 — pick one deliberately.
3. **Safety holds for golden runs** — a replay never calls `inner.invoke` (`replay.ts:385-424`),
   `goldenBindings.committer` throws (`executor.ts:200`), capture's committer is a stub returning
   `"0000000"` (`whole-graph.ts:410-413`), and roots are `mkdtemp`. **⚠ EXCEPT** the registered
   `disk` instance is rooted at `process.cwd()` (`registry.ts:126-132`) — it will write into THIS
   checkout. §3 caveat.
4. **`end-of-pipeline` is asked THREE times per run**, the third by `finalizePipelineRun`
   AFTER the interpreter loop (`finalize.ts:249-260`). It blocks too. §4.
5. **A second config can coexist without unpinning anything** — `goldenConfig()` stays byte-identical
   and the six existing replay cases must NOT move. §6, §7.

---

## 1. Target Files

### `src/pge/runtime/interrupt.ts` (modify — possibly not at all; see §2)

**The grant rule — lines 520-524:**
```ts
        // Autopilot did not ask anybody, so it does not GRANT anybody's approval. The
        // node itself still proceeds — a planner clarification under autopilot is meant to
        // — but nothing downstream may cite this as a recorded approval.
        if (mechanismName !== "noop") granted.set(key, outcome);
        return outcome;
```

**The gated-effect branch — lines 527-557** is the code that refuses `commit`; quoted in full in §2 rather than twice.

**Imports this file uses:** `runWithAudit`, `MechanismName` from `../../orchestrator/checkpoints/audit.js` (`:3-4`); `getCheckpointMechanismFor`, `resolveCheckpointMechanismName` from `../../orchestrator/checkpoints/registry.js` (`:5-8`); `isCheckpointId` from `.../types.js` (`:9`).

**Imported by:** `src/pge/runtime/interpreter.ts:39`, `src/pge/nodes/commit.ts:5` (`resumeMessageId`), `src/pge/runtime/interrupt.test.ts`.

**Test file:** `src/pge/runtime/interrupt.test.ts` — EXISTS (862 lines, mutation-proven; see its header at `:68-88`).

---

### `src/pge/golden/executor.ts` (modify — this is where the "second config" lives)

**The pinned config — lines 108-129 (do NOT unpin; the contract's stopCondition forbids it):**
```ts
/**
 * The config every golden run is executed under.
 * ... pinned here rather than read from the repository's own `bober.config.json`: a golden
 * case must produce the same artifacts on a contributor's machine and on a CI runner ...
 */
export function goldenConfig(): BoberConfig {
  const base = createDefaultConfig("golden", "brownfield");
  return {
    ...base,
    pipeline: { ...base.pipeline, researchPhase: false, maxIterations: 2 },
    evaluator: { ...base.evaluator, maxIterations: 1 },
  };
}
```
NOTE: the contract text says `conformanceConfig()`. In THIS file the function is `goldenConfig()`
(`executor.ts:122`); `conformanceConfig()` is its twin fixture at
`src/pge/engine/__fixtures__/whole-graph.ts:420-427` used by the conformance harness. Both are
autopilot by construction: neither sets `pipeline.mode`, `checkpointMechanism` or
`checkpointOverrides`, so `resolveCheckpointMechanismName` falls through to tier 6 → `"noop"`
(`registry.ts:65-91`).

**The per-case refusal that currently blocks a second config — lines 286-291:**
```ts
  if (goldenCase.input.config !== undefined) {
    throw new UnsupportedGoldenInputError(
      goldenCase.caseId,
      `it overrides config keys (${Object.keys(goldenCase.input.config).sort().join(", ")}), and this executor pins one config for every golden run`,
    );
  }
```

**The single call site — line 347:**
```ts
        }).run(goldenCase.input.featureRequest, runRoot, goldenConfig(), { runId: GOLDEN_RUN_ID }),
```

**The throwaway root — lines 320, 325, 354:**
```ts
  const parent = options.runRootParent ?? tmpdir();
  ...
    const runRoot = await mkdtemp(join(parent, `golden-${goldenCase.caseId.slice(0, 32)}-`));
  ...
      if (options.keepRunRoots !== true) await rm(runRoot, { recursive: true, force: true });
```

**Imported by:** `src/pge/golden/gate.ts:11`, `src/pge/golden/coverage.test.ts:8`,
`src/pge/golden/capture.ts:21`, `src/pge/golden/executor.test.ts:10`,
`src/pge/engine/real-workload.test.ts:70`, and by SOURCE-TEXT assertion in
`src/pge/topology/ci-gate.test.ts:350-359` (which greps `executor.ts` for `new PgeEngine(` and
`createReplayEffectRegistry(`).

**Test file:** `src/pge/golden/executor.test.ts` — EXISTS. `:193-205` pins the config refusal:
```ts
    const configured: GoldenCase = {
      ...replayCases[0],
      input: { ...replayCases[0].input, config: { autopilot: true } },
    };
    await expect(execute(configured)).rejects.toThrow(/overrides config keys/);
```

---

### `src/pge/golden/coverage.test.ts` (modify — sc-2-3)

**The list — lines 139-146:**
```ts
const NEVER_EXECUTED = [
  "commit",
  "context_compact",
  "critique",
  "finalize",
  "rework_route",
  "synthesize",
] as const;
```
The prose block above it (`:46-138`) is "a list of claims about WHY each node is unreachable"
(`:26-28`). Deleting `commit` and `finalize` from the array WITHOUT deleting their bullets at
`:68-77` leaves two orphan claims — the file's own rule says a deletion must be deliberate.

**The three assertions the deletion must satisfy — lines 246-264:**
```ts
  it("executes every declared node except the recorded structural blocks", () => {
    const missing = declared.filter((id) => !executed.has(id)).sort();
    expect(missing).toEqual([...NEVER_EXECUTED].sort());
  });
  ...
  it("covers a substantial majority of the graph, so the pin is not vacuous", () => {
    expect(declared.length - NEVER_EXECUTED.length).toBe(executed.size);
    expect(executed.size / declared.length).toBeGreaterThan(0.85);
  });
```
Committed artifact facts (verified): `graphId "coding"`, `graphVersion "1.4.0"`, `entry
"research_body"`, **44 nodes** (`.bober/topology/coding.json`). After the deletion the arithmetic
must be `44 - 4 = 40 = executed.size`, ratio `40/44 ≈ 0.909 > 0.85`. Both hold — no floor moves.

**The two-directional proof block — lines 286-358** is pure and synthetic
(`executedNodeIdsFromSpans`); it does NOT need to change and MUST keep failing in both directions.

**Test file:** it IS the test file.

---

### `src/pge/nodes/effects.ts` (probably read-only for this sprint)

**The one `git`-tagged effect — lines 946-979:**
```ts
export const GitCommitRequestSchema = z.object({ cwd: z.string().min(1), message: z.string().min(1) });
export const GitCommitResponseSchema = z.object({ commit: z.string().min(1) });
export type Committer = (cwd: string, message: string) => Promise<string>;

/** The shipped git primitive, unmodified (`src/utils/git.ts:27`). */
export const DEFAULT_COMMITTER: Committer = commitAll;

export function gitCommitEffect(commit: Committer = DEFAULT_COMMITTER): EffectDef<...> {
  return { name: EFFECTS.gitCommit /* "git.commit", :107 */, effects: ["git"],
           run: async (req) => ({ commit: await commit(req.cwd, req.message) }) };
}
```
`commitAll` is imported at `effects.ts:33` from `../../utils/git.js`. Registered into the terminal
registry at `effects.ts:1025` (`createTerminalEffectRegistry`), whose `committer` binding is optional
(`TerminalBindings`, `:1016-1020`) and defaults to the real one.

---

### `.bober/golden/` (modify — 43 case files; only 6 are `replay`)

Verified split: **6 `replay`** (`replay-*.json`) and **37 `integrity`**. Only `replay` cases are
executed (`case-schema.ts:83-108`, `executor.ts:267-273`). All six currently rest at
`terminalNodeId: "graceful_failure"`.

---

## 2. Exactly why `commit` is refused today — the traced path

1. `computeEffectGates(spec)` (`interpreter.ts:516-529`) walks edges and, for every edge whose
   `from` node has a `hitl` policy, records `gates.set(edge.to, {checkpointId, gateNodeId, onReject})`.
   The committed artifact has exactly one such edge: `e-approval-commit`, `hitl_commit -> commit`
   (`.bober/topology/coding.json`). `hitl_commit.hitl = { checkpointId: "end-of-pipeline",
   onReject: "graceful_failure" }` (`coding.graph.ts:909`). So `gates.get("commit")` is defined and
   `gates.get("finalize")` is **undefined** — `finalize` declares only `fs-write`
   (`coding.graph.ts:936`) and is not gated at all.
2. Superstep N: `hitl_commit` is admitted. `maybeInterrupt` takes the `hitl !== undefined` branch
   (`interrupt.ts:453-525`), resolves `mechanismName = "noop"` (tier 6, `registry.ts:90`), calls
   `NoopCheckpointMechanism.request` which returns `{ approved: true }` (`noop.ts:11-16`), and then
   **line 523 refuses to record it**: `if (mechanismName !== "noop") granted.set(key, outcome);`.
   `granted` stays empty. The gate node itself still runs.
3. Superstep N+1: `commit` is admitted. `maybeInterrupt` falls through to the gated-effect branch
   (`interrupt.ts:527`). `grant = grantInScope(grantScope("end-of-pipeline", "hitl_commit"))` is
   `undefined` (nothing was ever put in `granted`), so `allowed === false` (`:536-537`) and the
   outcome is the `FAIL_CLOSED: ...` rejection (`:541-544`).
4. `interpreter.ts:1167-1201` sees `!isApproved(outcome)`; `failClosed = node.spec.hitl === undefined`
   is `true` for `commit`; the span ends `{ status: "interrupted", failClosed: true, errorClass:
   "FailClosed" }` (`:1183-1188`) and a `TaskFailure` is pushed (`:1192-1200`). Control routes to
   `gate?.onReject` = `graceful_failure` (`:1201`).
5. `finalize`'s only inbound edge is `e-commit-finalize`, so it is never reached.

**THE ONE CONDITION THAT FAILS** is `grant !== undefined` at `interrupt.ts:537`, and the only
thing that fills `granted` for a `mechanism`-mode run is `interrupt.ts:523` — which requires
`resolveCheckpointMechanismName("end-of-pipeline", config) !== "noop"`.

**The only lever is `config`.** `PgeEngine` never sets `ctx.interrupts` (grep of
`src/pge/engine/pge-engine.ts` returns nothing for `interrupts`), so `interpreter.ts:1642` builds
`createInterruptController()` with defaults: `mode: "mechanism"`, `decisions: {}`
(`interrupt.ts:341, 354`). There is no seam for injecting decisions on a fresh `run()` — only on
`resume()` (`interpreter.ts:1659-1663`).

Resolution ladder (`registry.ts:65-91`): tier 2 `pipeline.checkpointOverrides["end-of-pipeline"]`,
tier 4 `pipeline.checkpointMechanism`, tier 5 `pipeline.mode === "careful"` → `"disk"`.

---

## 3. THE SAFETY BOUNDARY — and it holds, with one loud caveat

### What `commit`'s effect actually does when it runs

`commitNode`'s handler (`src/pge/nodes/commit.ts:209-234`) calls
`ctx.effects.invoke(EFFECTS.gitCommit, { cwd: ctx.projectRoot, message }, ctx)` — and only when
`documentedContracts(state).length > 0` (`:210-220`; `documenter.ts:79-87` filters to contracts
whose `branchStatus` is `succeeded` or whose `status` is `"completed"`).

The default `Committer` is `commitAll` (`effects.ts:959`), which is REAL git
(`src/utils/git.ts:29-40`):
```ts
export async function commitAll(cwd: string, message: string): Promise<string> {
  await execa("git", ["add", "-A"], { cwd });
  await execa("git", ["commit", "-m", message], { cwd });
  const { stdout } = await execa("git", ["rev-parse", "--short", "HEAD"], { cwd });
  return stdout.trim();
}
```
`cwd` is `ctx.projectRoot` — the run root.

### The mechanisms that keep it off this repository — NAMED AND QUOTED

**(a) In a golden REPLAY, the effect never reaches `inner.invoke` at all.**
`createReplayEffectRegistry` (`src/pge/runtime/replay.ts:368-424`) — its own docstring at `:355-366`:
> `inner` is kept for its DECLARATIONS only ... `inner.invoke` is never called, so nothing this
> registry does can reach a provider, a process or the filesystem.

Its `invoke` (`:385-424`) does the seal/registration/declared-tag checks, then
`recording.get(key)` and either returns a clone (`:423`) or throws `MissingRecordingError` (`:404-411`).
There is no fall-through branch.

**(b) In a golden replay every collaborator binding throws.** `executor.ts:177-203`:
```ts
    committer: refuse("committer"),
```
`refuse` throws `GoldenBindingInvokedError` (`executor.ts:162-166, 86-95`). Reaching it means the
effect seam was bypassed — a loud failure, not a silent commit.

**(c) In the CAPTURE run (which DOES call `inner.invoke` through the recorder decorator,
`replay.ts:228-256`), the committer is a stub.** `src/pge/engine/__fixtures__/whole-graph.ts:410-413`:
```ts
    committer: async () => {
      record("committer");
      return "0000000";
    },
```
`capture.test.ts` drives every committed scenario through `wholeGraphBindings` (`:161, 172, 183,
194, 205, 216`), so no capture ever shells out to git.

**(d) The run root is a temp directory.** `executor.ts:320` `const parent = options.runRootParent ??
tmpdir();` and `:325` `mkdtemp(join(parent, ...))`. `coverage.test.ts:227` passes
`mkdtemp(join(tmpdir(), "golden-coverage-"))`.

**(e) For node-level tests there is a real-git fixture that is explicitly never this repo.**
`src/pge/runtime/__fixtures__/temp-repo.ts:21-26`:
> ── Never this repository ── Every function takes an explicit `cwd`, and every caller passes a
> fresh `mkdtemp` directory ... an API with no default `cwd` is what makes that a property rather
> than a convention.

### ⚠ THE CAVEAT — the one place the boundary is NOT closed

The `disk` mechanism instance in the shipped registry is bound to **`process.cwd()` at module-load
time**, i.e. **the real agent-bober checkout when vitest runs** — `registry.ts:126-132`:
```ts
// Disk mechanism uses process.cwd() at module-load time. If the orchestrator
// ever runs from a different cwd, this path may be wrong; a factory pattern
// (Sprint 14+) can address this. For now this matches the cli registration parity.
registerCheckpointMechanism(
  "disk",
  new DiskCheckpointMechanism(join(process.cwd(), ".bober", "approvals")),
);
```
It is **not** rooted at `ctx.projectRoot`. So the moment a golden run resolves `end-of-pipeline`
to `disk`, the mechanism will `mkdir` and write `.bober/approvals/end-of-pipeline.pending.json`
**into this repository**, and `unlink` markers there (`disk.ts:73-83`). That is a filesystem write
into the checkout from a test — it creates no git object, but it WILL dirty the working tree, and
`.bober/approvals/` is **not gitignored** (checked). Any solution must re-root or replace that
instance; `interrupt.test.ts:95-107` is the precedent for doing so safely.

---

## 4. How the `disk` mechanism actually works — it is FULLY IMPLEMENTED, and it POLLS

`src/orchestrator/checkpoints/mechanisms/disk.ts` (177 lines). Sequence inside `request()`:

```ts
    await mkdir(this.approvalsDir, { recursive: true });                       // :73
    const pendingPath  = join(this.approvalsDir, `${checkpoint}.pending.json`); // :75
    const approvedPath = join(this.approvalsDir, `${checkpoint}.approved.json`);// :76
    const rejectedPath = join(this.approvalsDir, `${checkpoint}.rejected.json`);// :77

    // Clean up stale markers from a prior run (race-condition safety).        // :80
    await unlink(approvedPath).catch(() => {});                                // :81
    await unlink(rejectedPath).catch(() => {});                                // :82
    await unlink(timeoutPath).catch(() => {});                                 // :83
```
then writes the pending marker (`:88-102`) and polls:
```ts
            if (entries.has(`${checkpoint}.approved.json`)) {                  // :117
              const raw = await readFile(approvedPath, "utf-8");               // :118
              const parsed = JSON.parse(raw) as { editDelta?: unknown };       // :119
              await unlink(pendingPath).catch(() => {});                       // :121
              await unlink(approvedPath).catch(() => {});                      // :122
              ... resolve({ approved: true })                                  // :126
```
```ts
        // Start the first tick.
        pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);      // :166-168
```
Defaults: `DEFAULT_POLL_MS = 2000`, `DEFAULT_TIMEOUT_MS = 24h`, `MAX_TIMEOUT_MS = 7d` (`:23-25`).
The registered instance passes **no options** (`registry.ts:129-132`), so `pipeline.approvalTimeoutMs`
in `config/schema.ts:369` is IGNORED by it.

**Durable record shape** (what `bober approve` writes) — `src/cli/commands/approve.ts:68-78`:
```ts
      const payload = {
        approvedAt: new Date().toISOString(),
        approverId: resolveApprover(),
        ...(editDelta !== undefined ? { editDelta } : {}),
      };
      await writeFile(approvedPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
```
Typed as `ApprovedMarker` at `src/state/approval-state.ts:34-38`. `bober approve` REFUSES to write
it unless the pending marker already exists (`approve.ts:44-52`).

### 🔴 THE FEASIBILITY CRUX — read this twice

**A pre-placed `.approved.json` is DELETED before the poll begins** (`disk.ts:80-83`). The repo's
own test suite already documents this, at `src/pge/runtime/interrupt.test.ts:111-118`:
> The shipped mechanism deletes stale markers when it starts and then POLLS, so an approval
> written up front is thrown away — **the round trip genuinely has to happen while the run is
> blocked.** The marker is written temp-plus-rename because the mechanism reads the file the
> moment it appears, and a half-written one makes it throw.

So a committed fixture file under `.bober/golden/` or seeded into the run root cannot, with
`disk.ts` unchanged, be consumed as an approval. The generator has exactly three honest routes,
and must choose deliberately:

| Route | What it costs | Evidence |
|---|---|---|
| **A. Concurrent approver loop** (a poller that writes `.approved.json` while the run blocks) | The record IS on disk and survives process exit, but it is written by the harness *during* the run — the plainest reading of sc-2-4's "not synthesised by the harness at run time". Also adds ≥2s per checkpoint at the shipped `pollMs`. | `interrupt.test.ts:119-153` (`startApprover`) is the working implementation |
| **B. Teach `disk.ts` to honour a pre-existing approval** (check for `<id>.approved.json` before the stale-marker sweep) | Changes the SHIPPED approval mechanism and weakens the "race-condition safety" the sweep exists for (`disk.ts:80`). Must be paired with a test proving a marker from a *previous, unrelated* run is still not honoured. | `disk.ts:80-83` |
| **C. A run-root-scoped `DiskCheckpointMechanism` seeded from a committed fixture, registered for the golden run** (the record is committed to git, the run root gets a copy via `seedGoldenRoot`) | Still hits (B)'s deletion problem unless combined with it; but it does fix the `process.cwd()` rooting bug of §3. | `executor.ts:217-246` (`seedGoldenRoot`), `registry.ts:129-132` |

Whatever is chosen, **`interrupt.test.ts:95-107` is the mandatory hygiene pattern** — the registry
is module state and must be restored:
```ts
beforeEach(async () => { ... originalDisk = getCheckpointMechanism("disk"); });
afterEach(async () => {
  // The registry is module state. Restore the shipped instance so no other suite inherits
  // a mechanism pointed at a temp directory that no longer exists.
  registerCheckpointMechanism("disk", originalDisk);
  ...
});
```
`src/pge/nodes/commit.test.ts:87-96` (`scriptApproval`) does NOT restore it — do not copy that half.

### 🔴 THE SECOND BLOCKING CALL nobody expects

`end-of-pipeline` is asked a **third** time, AFTER the interpreter loop, by
`finalizePipelineRun` (`src/orchestrator/finalize.ts:249-260`):
```ts
  await runWithAudit({
    projectRoot, runId,
    checkpointId: "end-of-pipeline",
    mechanism,          // :220-221 — reads ONLY config.pipeline.checkpointMechanism ?? "noop"
    iteration: 1,
    fn: () => getCheckpointMechanismFor("end-of-pipeline", config, "noop").request("end-of-pipeline", {...}),
  });
```
`PgeEngine` reaches it via `commit.finalize(...)` (`pge-engine.ts:551`) →
`src/pge/runtime/commit.ts:550` → `finalizePipelineRun`. **This is why every committed replay case
carries a third `end-of-pipeline` audit line with `iteration: 1`.** Under `disk` this call blocks
too. Note also the asymmetry at `finalize.ts:220-221`: the audit's `mechanism` field is read from
`checkpointMechanism` ONLY — using `checkpointOverrides["end-of-pipeline"]` instead would make the
run use `disk` while the audit line records `"noop"`.

---

## 5. What `finalize` does, and its exposure

`finalizeNode` — `src/pge/nodes/root.ts:717-762`. It writes `verdict` + `refs` and offloads a
summary to the scratch store (`:753-758`). Its header (`:711-716`):
> It does NOT call `finalizePipelineRun`. The pipeline-complete history event and the
> `.completed.json` marker have one owner in this product, `CommitBoundary.finalize` ...

Declared `effects: ["fs-write"]` (`coding.graph.ts:936`) — **not gated** (`GATED_EFFECTS` is
`["git","process-exec"]`, `interrupt.ts:75`). It has **no independent exposure**: it is blocked
only because `commit -> finalize` is its sole inbound edge. Making `commit` execute unblocks it
automatically. It performs no git, no spawn, and no write outside the run root.

`finalize` is also **NOT in the terminal region projection** (`src/pge/nodes/regions.ts:257-261`:
"`finalize` is deliberately OUT"), so `commit.test.ts` structurally cannot cover it — only a
whole-graph golden case can.

---

## 6. The golden executor's config pinning — can a second config coexist?

**Yes, and it does not require unpinning anything.** The pin lives in two independent places:

- `assertExecutable` refuses `input.config` outright (`executor.ts:286-291`);
- `createGoldenExecutor` hard-codes `goldenConfig()` at the single call site (`executor.ts:347`).

The `GoldenCase` schema ALREADY carries an optional free-form `input.config`
(`case-schema.ts:229-236`) and the 37 `integrity` cases use it — e.g.
`commit-approved-writes-commit-object.json` declares `input.config = {"autopilot": false}` and
`entryNodeId: "hitl_commit"`, which is precisely why it is `integrity` and not `replay`.

**Smallest honest change** (matches `generatorNotes`: "a second, explicitly-approved config used by
new cases, leaving the autopilot path exactly as it is"):

1. Export a second pinned builder beside `goldenConfig()`, e.g. `goldenApprovedConfig()`, built from
   `goldenConfig()` plus exactly the checkpoint keys — so BOTH configs remain code constants, and
   neither is read from the checkout.
2. Select between them per case from something the case DECLARES, and refuse everything else. Two
   shapes both preserve the guarantee:
   - allowlist inside `assertExecutable`: accept `input.config` only when its key set is exactly the
     enumerated approval keys, and keep throwing `UnsupportedGoldenInputError` otherwise; or
   - a tag (`tags` is already `min(1)`, `case-schema.ts:252`) or a new explicit boolean field.
3. Keep `executor.test.ts:193-205` green by ensuring `{ autopilot: true }` — a key NOT on the
   allowlist — still throws `/overrides config keys/`. **That test is the negative control; do not
   delete it, extend it.**

The reproducibility property the stopCondition protects is "a case produces the same artifacts on a
contributor's machine and on a CI runner" (`executor.ts:110-114`). Two enumerated, code-pinned
configs preserve it exactly; reading `bober.config.json` would not.

**`capture.ts` must follow.** The RECORDED run also uses `goldenConfig()`
(`capture.ts:145`), and the expectation is produced by re-running the draft through the shipped
executor (`capture.ts:195-215`). Both halves must use the same config for the new case, or the
capture pins artifacts the gate can never reproduce.

---

## 7. Blast radius on the golden dataset — a PREDICTION to verify against

**37 `integrity` cases: ZERO artifact change.** They are not executed (`executor.ts:267-273`,
`coverage.test.ts:160`). Two of them make *claims* that the new behaviour touches and should be
re-read: `commit-refused-fail-closed-under-noop-gate.json` (still true — nothing about `noop`
changes) and `commit-approved-writes-commit-object.json` (its scenario becomes realisable; consider
whether it should be promoted, but note `capture.test.ts:288-296` requires SCENARIOS to list every
`replay` case, and its `entryNodeId: "hitl_commit"` is still refused by `executor.ts:274-279`).

**The 6 existing `replay` cases: ZERO change IF they keep using `goldenConfig()`.** That is the whole
point of the second-config shape. If instead the base config is changed, ALL SIX move — treat any
diff in `replay-*.json` as a red flag that the autopilot path was touched.

**A NEW `replay` case that supplies the approval will differ from
`replay-full-run-evaluation-passes.json` in exactly these places** (all others must be byte-identical):

| Field | Today | Predicted |
|---|---|---|
| `expected.terminalNodeId` | `"graceful_failure"` | `"finalize"` |
| `audits[]` | 3 lines: `{end-of-pipeline, noop, approved, it 1}`, `{... noop, rejected, it 2, feedbackText: "FAIL_CLOSED: ..."}`, `{... noop, approved, it 1}` | 3 lines, all `outcome: "approved"`; the `rejected`+`feedbackText` line becomes `approved` at `iteration: 2` (`interrupt.ts:548-555` audits in BOTH directions); `mechanism` becomes `"disk"` — but the THIRD line's `mechanism` follows `finalize.ts:220-221` (`checkpointMechanism` only) |
| `pipelineResult[0].errors` | `[{nodeId:"commit", errorClass:"FailClosed", branchKey:null, message:"FAIL_CLOSED: ..."}]` | **key absent entirely** — the spread is conditional on `result.failures.length !== 0` (`pge-engine.ts:551-560`) |
| `pinnedResponses` | no `git.commit` entry | one new `{nodeId:"commit", effectName:"git.commit", callIndex:0, response:{commit:"0000000"}}` (from `whole-graph.ts:410-413`) |
| `completionMarker` | `{completedSprints:1, failedSprints:0, success:true}` | **unchanged** — written by `finalizePipelineRun` from the sprint split (`finalize.ts:226,231-236`), which does not move |
| `history` | `["pipeline-complete"]` | **unchanged** (`finalize.ts:238-247`) |
| `contracts` / `specs` / `progress` / `runState` / `briefings` / `reviews` / `evalResults` | 1 / 1 / 0 / 0 / 0 / 0 / 0 | **unchanged** |

Normaliser context: `runId`, `timestamp`, `approverId`, `durationMs`, `createdAt`, `updatedAt`,
`duration` are stripped before comparison (`conformance.ts:65-76`), so an audit line compares as
`{checkpointId, mechanism, outcome, iteration, feedbackText?, editDeltaSummary}`.

Dataset bounds: 43 files today; `GOLDEN_DATASET_MIN_CASES = 20`, `MAX = 50`
(`case-schema.ts:77-78`); `GOLDEN_MIN_REPLAY_CASES = 5` (`:127`) against 6 today. Adding one case
keeps all three satisfied. `dataset.test.ts:88-89,142-143` asserts them.

---

## 8. Testing Patterns

### Unit test pattern — the fail-closed / approved PAIR already exists
**Source:** `src/pge/nodes/commit.test.ts:172-211` (refused) and `:267-309` (approved).
```ts
  it("never executes, and creates no git object in a real repository", async () => {
    await initTempRepo(root);
    const before = await headSha(root);
    const run = await runSprint({
      projectRoot: root, region: TERMINAL_REGION,
      // `committer` unbound on purpose: it resolves to the SHIPPED `commitAll`, so if the
      // node were entered a real commit would exist and the assertions below would see it.
      bindings: stubTerminalBindings(), contracts: [COMPLETED],
    });
    expect(run.handlerLog.calls[COMMIT_NODE_IDS.commit]).toBeUndefined();
    expect(await headSha(root)).toBe(before);
    const failure = run.result.failures.find((e) => e.nodeId === COMMIT_NODE_IDS.commit);
    expect(failure?.errorClass).toBe(FAIL_CLOSED_ERROR_CLASS);
  }, 30_000);
```
The approved twin uses `config: sprintConfig({}, { checkpointMechanism: "disk" })`
(`commit.test.ts:279`; `sprintConfig` at `src/pge/nodes/__fixtures__/sprint-harness.ts:391-407`)
and asserts `commitCount(root) === countBefore + 1` and the conventional subject.

**Gap this sprint must close:** `commit.test.ts:87-96`'s `scriptApproval` registers an **in-memory
stub** as `"disk"`. That is exactly what sc-2-4 forbids ("not synthesised by the harness at run
time"). The new test must use the **real `DiskCheckpointMechanism`** against a real marker file.

### The durable-disk pattern (real mechanism, real files)
**Source:** `src/pge/runtime/interrupt.test.ts:119-153, 171-173`
```ts
function useDisk(): void {
  registerCheckpointMechanism("disk", new DiskCheckpointMechanism(approvals, { pollMs: 5 }));
}
```
`startApprover` (`:119-153`) writes `<id>.<decision>.json` via **temp-file + `rename`** because "the
mechanism reads the file the moment it appears, and a half-written one makes it throw" (`:116-117`).

### Audit assertions
**Source:** `interrupt.test.ts:163-169`
```ts
async function readAudit(runId: string): Promise<AuditLine[]> {
  const raw = await readFile(join(root, ".bober", "audits", `${runId}.jsonl`), "utf8");
  return raw.split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as AuditLine);
}
```

**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** none for the filesystem —
real `mkdtemp` roots (project principle: "No test mocks for filesystem"). **File naming:**
`<module>.test.ts`, collocated. **E2E:** no Playwright in this repo.

### Re-capture command
`GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts` (`capture.test.ts:26-29, 62,
272-274`). The diff IS the statement; `capture.ts:43-49` says a recapture pushed without reading the
diff defeats the gate.

---

## 9. Impact Analysis — Affected Files & Tests

### Files that may break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/golden/coverage.test.ts` | `executor.ts` (`:8`) | **high** | `NEVER_EXECUTED` equality, the `declared - list === executed.size` arithmetic (`:262`), and the >85% ratio (`:263`) |
| `src/pge/golden/executor.test.ts` | `executor.ts` (`:10`) | **high** | `:193-205` — `{autopilot:true}` must STILL throw `/overrides config keys/` |
| `src/pge/golden/capture.test.ts` | `capture.ts`→`executor.ts` (`capture.ts:21`) | **high** | every scenario is re-captured and byte-compared (`:271-282`); `:288-296` requires SCENARIOS ≡ committed replay ids |
| `src/pge/golden/gate.ts` + `dataset.test.ts` + `runner.test.ts` + `gate.test.ts` | `executor.ts` (`gate.ts:11`) | medium | dataset floors/ceilings (`dataset.test.ts:88-89, 142-143`); pass rate must be **strictly above** 80 (`runner.ts:100`) |
| `src/pge/topology/ci-gate.test.ts:350-359` | reads `executor.ts` **as text** | medium | must still contain `new PgeEngine(` and `createReplayEffectRegistry(` |
| `src/pge/runtime/interrupt.test.ts` | `interrupt.ts` | **high** if `interrupt.ts` changes | 862 lines, mutation-proven (`:68-88`); the rework-cycle group pins "an approval authorises ONE PASS" |
| `src/pge/nodes/commit.test.ts` | `interrupt.ts`, `commit.ts`, registry | **high** | both the refused and approved cases; note it leaks a stubbed `"disk"` into the module registry |
| `src/orchestrator/checkpoints/*.test.ts` (`registry.test.ts`, `audit.test.ts`, `checkpoints.test.ts`) | `registry.ts`, `disk.ts` | **high** if `disk.ts` changes | `disk.ts` has no colocated test file — its behaviour is pinned indirectly through `interrupt.test.ts` and `registry.test.ts` |
| `src/orchestrator/workflow/conformance.engines.test.ts` | `conformanceConfig()` (`:73,144`) | medium | the divergence set is two-directionally pinned; a config change here would move it |
| `src/pge/engine/whole-graph.test.ts`, `real-workload.test.ts`, `pge-engine.test.ts` | `conformanceConfig()` | medium | leave `conformanceConfig()` alone unless there is a reason |
| `src/cli/commands/run.test.ts`, `src/mcp/run-manager.test.ts` | `PipelineResult.errors` | low-medium | they assert on the `FailClosed` refusal being reported; unchanged as long as the autopilot path is untouched |

### Existing tests that must still pass (non-negotiable)
- `src/pge/nodes/commit.test.ts:173-211` — no approval ⇒ no git object in a real repo. **This is sc-2-2's existing guard; strengthen, never relax.**
- `src/pge/runtime/interrupt.test.ts` "FAIL CLOSED" block (`:247-289`) — blocks both effectful nodes under autopilot, records the block in the audit, marks the span `failClosed`.
- `src/pge/golden/coverage.test.ts:266-283` — every named region anchor, incl. `hitl_commit`, still executed.
- `src/pge/golden/capture.test.ts` byte-comparison of all committed replay cases.
- `src/pge/topology/*.test.ts` — a topology edit would bump `graphVersion`; **this sprint should need none** (`nonGoals`: no new checkpoint ids — that is sprint 3).

### Regression checks the generator MUST run
1. `npx vitest run --exclude '**/.claude/worktrees/**' --exclude '**/node_modules/**'`
2. `npm run typecheck` and `npm run typecheck:tests`
3. `npm run lint`
4. `npm run build`
5. `node scripts/run-golden-regression.mjs` (needs `dist/` — run AFTER build; must exit 0, pass rate strictly > 80)
6. `git status --porcelain` — **must be clean of `.bober/approvals/`**. If any `end-of-pipeline.pending.json` appears in the checkout, the `process.cwd()`-rooted disk instance leaked (§3 caveat).
7. `git log --oneline -1` before and after the suite — identical. No test may create a commit here.
8. Verify on a clean checkout (`git worktree add --detach`), per the contract's environmentNote.

---

## 10. Implementation Sequence

1. **Decide the durability route (§4 table) and write it down** in the sprint doc before coding.
   Verify: the choice survives the question "delete the approval record — is the effect refused again?"
2. **`src/orchestrator/checkpoints/mechanisms/disk.ts`** — only if route B. Add the pre-existing-marker
   path plus a negative control proving a marker from an unrelated prior run is still not honoured.
   Verify: `npx vitest run src/pge/runtime/interrupt.test.ts src/orchestrator/checkpoints` green.
3. **`src/pge/golden/executor.ts`** — add the second pinned config builder beside `goldenConfig()`
   (leave `goldenConfig()` byte-identical), and the per-case selection with an explicit refusal for
   anything not enumerated. Verify: `npx vitest run src/pge/golden/executor.test.ts` — `{autopilot:true}`
   still throws.
4. **`src/pge/golden/capture.ts` / `capture.test.ts`** — thread the same selection through the RECORDED
   run, add the new SCENARIO. Verify: `GOLDEN_CAPTURE=1 npx vitest run src/pge/golden/capture.test.ts`
   emits exactly one new file and leaves the other six byte-identical (`git diff --stat .bober/golden/`).
5. **Read every hunk of the new/changed golden JSON against §7's prediction.** Any diff outside the
   predicted rows is a finding, not a rubber stamp (sc-2-5).
6. **`src/pge/golden/coverage.test.ts`** — delete `"commit"` and `"finalize"` from `NEVER_EXECUTED`
   (`:139-146`) AND delete their prose bullets (`:68-77`), leaving the remaining four bullets and the
   "four are structural / two are missing-scenario" framing corrected. Verify: `npx vitest run
   src/pge/golden/coverage.test.ts` — `44 - 4 === executed.size` and `40/44 > 0.85`.
7. **New tests for sc-2-1/sc-2-2/sc-2-4** — the approved-executes case, the delete-the-record case, and
   a test that fails if the guard at `interrupt.ts:537` or `:523` is removed.
8. **`docs/pge-graph.md`** — `:565` ("The six nodes no case executes"), the table rows for `commit` and
   `finalize` (`:571-573`), the "38 of the 44" figure (`:549`), and the outstanding-work item at
   `:1378-1390`. Every claim added needs a test that fails when it stops being true (definitionOfDone).
9. **Full verification** — the eight checks in §9.

---

## 11. Pitfalls & Warnings

- **`process.cwd()`-rooted `disk`** (`registry.ts:126-132`) — the single highest-risk line in this
  sprint. It writes into the real checkout. Re-root it or replace the instance, and RESTORE it in
  `afterEach` (`interrupt.test.ts:102-107`).
- **A pre-written `.approved.json` is deleted before the first poll** (`disk.ts:80-83`). Read §4.
- **The registered `disk` instance polls every 2000 ms and times out after 24 h** (`disk.ts:23-24`,
  `registry.ts:129-132` passes no options). Three `end-of-pipeline` evaluations per run × 2 s is
  6 s per case minimum — and a mechanism that never gets an answer hangs the suite for a day. The
  `pipeline.approvalTimeoutMs` config key does NOT reach it.
- **`finalizePipelineRun` asks `end-of-pipeline` a third time, after the loop**
  (`finalize.ts:249-260`, reached via `pge-engine.ts:551`). Forgetting it produces a hang at the very
  end of an otherwise-green run.
- **`finalize.ts:220-221` reads `checkpointMechanism` only**, not `checkpointOverrides` — using the
  override alone makes the audit line record `"noop"` while the run used `"disk"`.
- **`commit` returns early with no git call when nothing settled** (`commit.ts:210-220`). A scenario
  with zero `succeeded`/`completed` contracts executes the node (`status: "ok"`) but pins no
  `git.commit` response. That satisfies sc-2-3 but is a weaker sc-2-1 — prefer a run that actually commits.
- **`commit.test.ts:87-96` leaks a stubbed `"disk"` into module state** and never restores it. If a
  new test in the same worker depends on the real disk mechanism, ordering will bite.
- **`ci-gate.test.ts:350-359` greps `executor.ts` as TEXT** for `new PgeEngine(` and
  `createReplayEffectRegistry(`. A refactor that renames or indirects either breaks a gate test.
- **`capture.test.ts:288-296` requires `SCENARIOS` ≡ the committed `replay` ids.** Dropping a
  `replay-*.json` file without editing SCENARIOS, or vice versa, fails.
- **Do not touch `deriveRunSuccess` or the completion marker** (contract nonGoals; `finalize.ts:226`).
  `success` staying `true` for a refused commit is frozen Option A.
- **Do not declare new checkpoint ids** — sprint 3's territory. `assertKnownCheckpointId`
  (`interrupt.ts:313-316`) refuses anything outside the nine in `checkpoints/types.ts:16-26`.
- **`.bober/approvals/` is not gitignored.** Any stray marker shows up in `git status`.
- **ESM/NodeNext:** every relative import needs the `.js` extension; use `import type` for types
  (`consistent-type-imports` is errored). No `fs.readFileSync`. Section headers use
  `// ── Name ─────`.

---

## 12. Relevant Documentation

**Project principles** (handoff): ESM with `.js` extensions; Zod for config; filesystem state under
`.bober/`; tests collocated `*.test.ts`; **no test mocks for the filesystem — use temp directories**;
`import type` (`consistent-type-imports` errored); zero type/lint errors are hard gates; commits
`bober(sprint-N): description`.

**Architecture:**
- `.bober/architecture/arch-20260814-pge-full-convergence-adr-1.md` (sprint 1, THIS spec) — the
  `InterruptInsideFanOut` rule STANDS, and its **Risk** paragraph names this sprint: "If a future
  runtime change gives `Checkpoint.interrupt` a keyed, branch-aware slot and
  `grantScope`/`resumeMessageId` a branch discriminator — **sprint 2's territory, explicitly out of
  this ADR's scope** — option (b) becomes sound and this decision must be revisited." Sprint 1
  changed NO interrupt mechanics.
- `arch-20260805-pge-graph-engineering-adr-6.md` — the HITL/interrupt ADR the design cites throughout.
- `docs/pge-graph.md:540-590` — the "38 of the 44" figure, the `NEVER_EXECUTED` table, the
  two-directional pin. `:1378-1390` — the outstanding-work entry this sprint closes:
  > **A durable checkpoint mechanism for `commit` and `finalize`.** Four mechanisms are registered
  > ... but nothing in this repository ever runs `commit`/`finalize` under a non-`noop` one.
