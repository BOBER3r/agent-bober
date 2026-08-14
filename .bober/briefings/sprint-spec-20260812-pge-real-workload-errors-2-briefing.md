# Sprint Briefing: A committed workload corpus, and the measurement extended to every channel

**Contract:** sprint-spec-20260812-pge-real-workload-errors-2
**Generated:** 2026-08-12T00:00:00Z
**Depends on:** sprint-spec-20260812-pge-real-workload-errors-1 (commit 5190f7d)

---

## 0. The three answers you need before you write a line

**(1) `byteSize` is NOT exported.** `src/pge/runtime/commit.ts:257-259`:

```ts
function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}
```

No `export` keyword. Its only caller is the cap check at `commit.ts:358`. The full export
list of that module (verified by grepping `^export` in `src/pge/runtime/commit.ts`) is:
`StateBloatError` (:63), `UndeclaredChannelError` (:92), `ConflictingControlUpdateError`
(:105), `ImmutableStateKeyError` (:120), `FinalizeWithoutSpecError` (:131), `CONTROL_KEYS`
(:146), `ControlKey` (:147), `IMMUTABLE_KEYS` (:150), `isControlKey` (:156), `ChannelUpdate`
(:162), `CommitResult` (:169), `CommitContext` (:190), `DomainArtifactWriter` (:205),
`createDomainArtifactWriter` (:211), `CommitBoundary` (:218), `createSystemClock` (:237),
`createFixedClock` (:246), `CommitBoundaryOptions` (:285), `createCommitBoundary` (:298).

**The least invasive fix: add `export` to line 257 and a doc comment naming it as the
boundary's own metric.** Nothing pins the export surface of this module — no test enumerates
its exports (grep for `runtime/commit.js` importers returns 6 files, all named-importing
specific symbols: `trace.test.ts:10`, `sprint-harness.ts:19`, `region-harness.ts:20-21`,
`real-workload.test.ts:43`, `pge-engine.test.ts:63`, `pge-engine.ts:23`, `commit.test.ts:68`,
`replay.test.ts:27`, `interpreter.ts:36`). Adding one export breaks none of them.

**(2) Sprint 1 already reimplemented it — go delete that copy.**
`src/pge/engine/real-workload.test.ts:83-86` has a local `byteSize` with the same body. Once
`commit.ts` exports it, sprint 1's local copy must import it instead. sc-2-2 says "not a
reimplementation"; leaving two copies in the tree after this sprint is the exact drift the
criterion is about.

**(3) THE CORPUS DATA MUST NOT LIVE UNDER `.bober/golden/`.** The contract's
`estimatedFiles` names `.bober/golden/workload/`. That path breaks four committed gates —
see §9, Pitfall 1. Put the CODE at `src/pge/golden/workload.ts` (the directory convention
fits: `case-schema.ts`, `runner.ts`, `gate.ts`, `capture.ts`, `executor.ts` all live there)
and the DATA at **`.bober/workload/`**.

---

## 1. Target Files

### `src/pge/runtime/commit.ts` (modify — one line)

**Relevant section (lines 255-259):**
```ts
// ── Helpers ─────────────────────────────────────────────────────────

function byteSize(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}
```

**The call site the corpus must agree with (lines 358-370):**
```ts
        const bytes = byteSize(update.value);
        if (bytes > declared.decl.maxInlineBytes) {
          rejected.push(
            new StateBloatError({ channel: update.channel, bytes,
              limit: declared.decl.maxInlineBytes, nodeId: update.nodeId,
              branchKey: update.branchKey }),
          );
          continue;      // <- the write is DROPPED, not thrown
        }
```

**Imports this file uses:** `Buffer` from `node:buffer` (:1); `canonicalJson` from
`../registry/reducers.js` (:13).
**Imported by:** `interpreter.ts:36`, `pge-engine.ts:23`, `region-harness.ts:20`,
`sprint-harness.ts:19`, plus 5 test files.
**Test file:** `src/pge/runtime/commit.test.ts` — EXISTS (imports a named set at :68-69).

---

### `src/pge/golden/workload.ts` (create)

**Directory pattern:** `src/pge/golden/` uses lower-case single-word module names with a
co-located `<name>.test.ts`: `capture.ts`/`capture.test.ts`, `case-schema.ts`, `coverage.test.ts`,
`executor.ts`, `gate.ts`, `runner.ts`. Every module opens with a long `/** ... */` header
that argues WHY it exists before any code (see `runner.ts:344-349`, `gate.ts:50-69`).

**Most similar existing files:**
- `src/pge/golden/runner.ts:333-406` — reads a committed `.bober/` directory from disk with
  `readdir` + `readFile`, parses each entry through a schema, returns `{ dir, files, cases,
  errors }` and never throws on a bad file. Copy this shape exactly.
- `src/pge/engine/__fixtures__/real-workload.ts:40-73` — sprint 1's loader for the same data.

**Structure template (derived from `runner.ts:333-406`):**
```ts
/** Where the committed corpus lives, relative to the project root. */
export const WORKLOAD_DIR = join(".bober", "workload");        // cf. gate.ts:72 GOLDEN_DIR

export interface WorkloadEntry {
  readonly entryId: string;
  readonly channel: string;        // the channel this exercises
  readonly provenance: { kind: "file"; path: string } | { kind: "observed"; ... };
  readonly value: unknown;         // the value a node writes to that channel
}
export interface WorkloadCorpus {
  readonly dir: string;
  readonly files: readonly string[];   // readdir order, unfiltered — cf. runner.ts:337
  readonly entries: readonly WorkloadEntry[];
  readonly errors: readonly string[];
}
export async function loadWorkloadCorpus(dir: string): Promise<WorkloadCorpus> { /* readdir/readFile/parse */ }
/** sc-2-2: the SAME function the commit boundary uses. */
export function maxBytesPerChannel(corpus: WorkloadCorpus): Record<string, number> {
  // byteSize imported from ../runtime/commit.js — NOT reimplemented
}
```

---

### `src/pge/golden/workload.test.ts` (create)

**Most similar existing file:** `src/pge/golden/dataset.test.ts` — the committed-data-read-
from-disk test, with negative controls on a temp COPY (never on the committed tree). Its
header at :27-36 states the two rules this sprint's test must also obey.

---

### `.bober/workload/` (create — committed, NOT gitignored)

See §9 Pitfall 1 for why not `.bober/golden/workload/`, and §5 for the `.gitignore` /
`repo-invariants.test.ts` interaction (answer: **do nothing to either file**).

---

## 2. Patterns to Follow

### P1 — Read committed data from disk with `readdir`, never a hardcoded manifest
**Source:** `src/pge/golden/runner.ts:344-353`
```ts
/**
 * `readdir` rather than a manifest, deliberately: a hardcoded list of cases is a list that
 * drifts from the directory, and the first thing it hides is a case that was deleted.
 */
export async function loadGoldenDataset(dir: string): Promise<GoldenDataset> {
  let entries: string[];
  try { entries = (await readdir(dir)).sort(); }
  catch (error) { return { dir, files: [], cases: [], errors: [`${dir}: cannot read ...`] }; }
```
**Rule:** the corpus loader takes the directory listing as truth and returns `errors` rather
than throwing; sc-2-5's "read from disk at test time" is satisfied by exactly this shape.

### P2 — Every claim tested from both directions, on a temp copy
**Source:** `src/pge/golden/dataset.test.ts:69-82`
```ts
/** A writable copy of the committed dataset. The committed one is never touched. */
async function copyDataset(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "golden-dataset-"));
  tempDirs.push(dir);
  for (const file of files) await copyFile(join(GOLDEN_DIR, file), join(dir, file));
  return dir;
}
afterEach(async () => { while (tempDirs.length > 0) { const dir = tempDirs.pop();
  if (dir !== undefined) await rm(dir, { recursive: true, force: true }); } });
```
**Rule:** sc-2-4's "deleting a channel's corpus entry makes the test fail" (evaluatorNotes)
is proven by deleting from a TEMP COPY, never from `.bober/workload/`.

### P3 — Completeness pinned against the ARTIFACT, not a list in the test
**Source:** `src/pge/golden/coverage.test.ts:121-125`
```ts
    const artifact: unknown = JSON.parse(await readFile(ARTIFACT, "utf8"));
    declared = ((artifact as { nodes: { id: string }[] }).nodes ?? [])
      .map((node) => node.id)
      .sort();
```
**Rule:** sc-2-4 says "every channel the artifact declares" — read
`.bober/topology/coding.json` `channels[].id` at test time. A literal array of ten channel
ids in the test file is the thing this criterion exists to forbid.

### P4 — The committed measurement is one string, compared byte-for-byte
**Source:** `src/pge/engine/real-workload.test.ts:130-133, 311-327`
```ts
function measurementJson(measurement: Measurement): string {
  return `${JSON.stringify(measurement, null, 2)}\n`;
}
// ...
      const bytes = measurementJson(measurement);
      if (MEASURING) { await writeFile(MEASUREMENT_PATH, bytes, "utf-8"); return; }
      let committed: string | null;
      try { committed = await readFile(MEASUREMENT_PATH, "utf-8"); } catch { committed = null; }
      expect(committed, `${MEASUREMENT_PATH} is not committed; run MEASURE_REAL_WORKLOAD=1 ...`).not.toBeNull();
      expect(bytes).toBe(committed);
```
**Rule:** sc-2-3 extends THIS artifact. Two-space-indented `JSON.stringify` + trailing
newline, an env-var regenerate flag, and an assert-equal-to-committed default path.

### P5 — The guard against reading the WRONG graph
**Source:** `src/pge/engine/real-workload.test.ts:252-257`
```ts
      const topology = await readValidatedTopologySpec(projectRoot, CODING_GRAPH_ID);
      expect(topology.graphId).toBe("coding");
      expect(topology.channels.length).toBeGreaterThan(0);
      for (const channel of topology.channels) {
        expect(channel.maxInlineBytes, `channel "${channel.id}" cap`).toBe(4096);
      }
```
**Rule:** `src/pge/runtime/__fixtures__/golden-graph.ts:360,366` raises `spec` to 8192 and
`sprintContracts` to 65536. Any test that loads a graph must prove it loaded the SHIPPED one.

### P6 — Module header argues before it codes
**Source:** `src/pge/state/overall.ts:8-47`, `src/pge/runtime/commit.ts:17-58`,
`src/pge/engine/__fixtures__/real-workload.ts:12-32`.
**Rule:** open `workload.ts` with a header naming what the corpus is, why it is committed
rather than derived, and what is deliberately NOT in it.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `byteSize` | `src/pge/runtime/commit.ts:257` | `(value: unknown) => number` | **THE metric.** Not exported yet — export it, do not copy it. |
| `canonicalJson` | `src/pge/registry/reducers.ts:119` | `(value: unknown) => string` | Sorted-key deterministic JSON; disagrees with plain `JSON.stringify`. |
| `realPlanSpec` / `realContracts` / `realWorkload` | `src/pge/engine/__fixtures__/real-workload.ts:40, 49, 70` | `() => Promise<PlanSpec>` etc. | Sprint 1's loaders for the PGE spec + its 14 contracts. |
| `REAL_SPEC_ID` / `REAL_SPEC_PATH` | same file :36, :37 | `string` | `spec-20260805-pge-graph-engineering` and its path. |
| `realWorkloadBindings` | same file :85 | `(input, workload) => CodingBindings` | Planner+materialize repointed at the real artifacts. |
| `REPO_ROOT` / `COMMITTED_ARTIFACT` / `CODING_GRAPH_ID` | `src/pge/engine/__fixtures__/whole-graph.ts:71, 72, 73` | `string` | Repo root from `import.meta.url`; do not re-derive. |
| `seedCommittedArtifact` | same file :76 | `(projectRoot) => Promise<void>` | Copies the real `coding.json` + prompts into a temp root. |
| `wholeGraphBindings` / `conformanceConfig` | same file :321, :420 | see file | The full deterministic collaborator set / the pinned config. |
| `loadGoldenDataset` | `src/pge/golden/runner.ts:350` | `(dir) => Promise<GoldenDataset>` | Reference loader shape. **Its dir must stay case-only.** |
| `datasetShapeProblems` | `src/pge/golden/runner.ts:429` | `(dataset, bounds?) => string[]` | Rejects any stray entry in `.bober/golden/`. |
| `GOLDEN_DIR` | `src/pge/golden/gate.ts:72` | `join(".bober","golden")` | Precedent for `WORKLOAD_DIR`. |
| `TOPOLOGY_DIR` / `topologyArtifactPath` | `src/pge/topology/dump.ts:23, 26` | `(projectRoot, graphId) => string` | Path to `.bober/topology/<id>.json`. |
| `readTopologyArtifact` | `src/pge/topology/dump.ts:210` | `(path) => Promise<ReadArtifactResult>` | Three-outcome read (absent vs unreadable). |
| `readValidatedTopologySpec` | `src/pge/engine/pge-engine.ts:303` | `(projectRoot, graphId) => Promise<TopologySpec>` | Checksum-validated artifact read. |
| `TopologySpecSchema` | `src/contracts/topology.ts` | zod | Parse the artifact rather than trusting JSON. |
| `PlanSpecSchema` | `src/contracts/spec.ts:124` | zod | **Not every committed spec parses — see §7.** |
| `SprintContractSchema` | `src/contracts/sprint-contract.ts:82` | zod | **60 of 250 committed contracts do NOT parse — see §7.** |
| `SprintVerdictSchema`, `GraphMessageSchema`, `ScratchRefSchema`, `BranchStatusSchema`, `LedgerEntrySchema`, `BudgetLedgerSchema`, `RunVerdictSchema` | `src/pge/state/overall.ts:108, 84, 63, 144, 160, 179, 185` | zod | The seven non-contract channel schemas. |
| `OverallStateSchema` / `OVERALL_STATE_KEYS` / `initialOverallState` | `src/pge/state/overall.ts:194, 218, 295` | — | Fifteen state keys; ten of them are channels. |
| `sprintVerdict` | `src/pge/nodes/sprint-evaluate.ts:116` | `(args) => SprintVerdict` | Builds the exact value written to `evaluations`. |
| `anchorId` | `src/pge/nodes/anchors.ts:56` | `(evaluator, criterion) => string` | Builds a `testAnchors` member. |
| `boundedExcerpt` / `CORRECTION_EXCERPT_MAX_BYTES` | `src/pge/nodes/sprint-correct.ts:122, 75` | `(text, maxBytes?) => {excerpt,...}` | Why `messages` is already bounded (1024 B). |
| `createScratchStore` / `.put` | `src/pge/runtime/scratch.ts:311, 282` | `put(runId, kind, data) => Promise<ScratchRef>` | The only real way to mint a genuine `ScratchRef`. |
| `withNetworkDisabled` | `src/pge/runtime/replay.ts:466` | `<T>(fn) => Promise<T>` | NFR: no outward calls. |
| `createFixedClock` | `src/pge/runtime/commit.ts:246` | `(iso) => Clock` | Frozen clock seam. |
| `GoldenBindingInvokedError` | `src/pge/golden/executor.ts:86` | `class` | Throwing-collaborator control. |
| `readSpans` / `tracePath` | `src/pge/runtime/trace.ts:328, 198` | — | Non-vacuity: prove a node actually ran. |
| `checksumTopology` / `serializeTopology` | `src/pge/topology/canonical.ts:86`, `dump.ts:77` | — | Re-sign a mutated artifact COPY. |

Directories reviewed for reusable helpers: `src/pge/golden/`, `src/pge/runtime/`,
`src/pge/registry/`, `src/pge/topology/`, `src/pge/state/`, `src/pge/engine/__fixtures__/`,
`src/contracts/`. There is no `src/utils/`, `src/lib/`, `src/helpers/` or `src/shared/` in
this repository.

---

## 4. Prior Sprint Output (sprint 1, commit 5190f7d)

### `src/pge/engine/__fixtures__/real-workload.ts` — the data loader
Exports `REAL_SPEC_ID` (:36), `REAL_SPEC_PATH` (:37), `realPlanSpec()` (:40),
`realContracts(spec)` (:49), `interface Workload` (:65), `realWorkload()` (:70),
`realWorkloadBindings(input, workload)` (:85).
`realContracts` reads `spec.sprints` and loads `.bober/contracts/<id>.json` per id (:55-60),
narrowing with `filter((id): id is string => typeof id === "string")` because
`PlanSpec.sprints` is `z.array(z.unknown()).optional()` (`src/contracts/spec.ts:160`).
**Connection:** the corpus generator reuses these verbatim for the `spec` and
`sprintContracts` channels. Generalising `realContracts` to take a spec path is the natural
extension; do not write a second contract loader.

### `src/pge/engine/real-workload.test.ts` — the harness
- `observeRealWorkload(projectRoot, runId, workload, bindings)` (:142-237) drives a real
  `PgeEngine` and captures the interpreter's own `GraphRunResult` through
  `PgeEngineDeps.interpreterFactory` (:151-163).
- `interface Measurement` (:110-128) is the committed shape; `measurementJson` (:131) writes it.
- `MEASURING = process.env.MEASURE_REAL_WORKLOAD === "1"` (:63).
- Local `byteSize` at :83-86 — **delete and import** once `commit.ts` exports it.
**Connection:** sc-2-3 extends this file's `Measurement` (add a per-channel corpus-max map
and the corpus-sized results for `messages`/`evaluations`/`refs`), or adds a sibling
measurement written the same way. Do not build a parallel measurement path.

### `.bober/topology/measurements/real-workload.json` — the committed measurement
```json
  "workload": { "specCanonicalBytes": 29214, "contractCount": 14, "contractsCanonicalBytes": 135106 },
  "channelLimits": { "branchStatus": 4096, ... "verdict": 4096 },
  "rejections": [ { "channel": "spec", "nodeId": "plan_materialize", "bytes": 29214, "limit": 4096, "superstep": 12 },
                  { "channel": "sprintContracts", ..., "bytes": 135106, ... } ],
  "terminalNodeId": "graceful_failure", "status": "completed", "verdict": "failed",
  "specChannelNullAtBoundary": true,
  "engineOutcome": { "kind": "threw", "errorClass": "FinalizeWithoutSpecError" }
```
(`.bober/topology/measurements/real-workload.json:7-65`.) Line 60's `"verdict": "failed"` is
a real, committed `RunVerdict` instance — usable as the `verdict` channel's corpus provenance.

---

## 5. Relevant Documentation

### `.bober/principles.md` (48 lines)
Quality standards, verbatim: "**Type safety:** TypeScript strict mode with all strict flags
... Zero type errors is a hard gate." / "**Lint compliance:** ESLint flat config with
`consistent-type-imports` enforced ... Zero lint errors". Use `import type` for type-only
imports — sprint 1 does at `real-workload.ts:5,7,8,9`.

### `AGENTS.md`
"**Sprint output touching files outside `expectedChanges`**" is a listed rejection reason —
the contract's `estimatedFiles` are `.bober/golden/workload/`, `src/pge/golden/workload.ts`,
`src/pge/golden/workload.test.ts`, `src/pge/runtime/commit.ts`. Relocating the DATA
directory (§9 Pitfall 1) and editing `src/pge/engine/real-workload.test.ts` (sc-2-3) are
both deviations that must be stated in the completion notes with the reason.

### `docs/pge-graph.md`
- `## Channels` (:413) — the `<!-- pge:channels -->` table is pinned field-for-field against
  the artifact by `src/pge/topology/docs.test.ts:229-230, 283-295`. **This sprint changes no
  cap, so the table must not change.**
- `## The graph engine against a real workload` (:646) — sprint 1's section; the place to
  document the corpus location for sc-2-5, with the regeneration command in the same voice
  as the existing `MEASURE_REAL_WORKLOAD=1 npx vitest run ...` sentence.
- `## Changelog` (:804).
- **`pge docs --check` only reads inline code spans inside `<!-- pge:nodes -->` blocks**
  (`src/pge/topology/docs.ts:31-35, 66-73`). Prose added outside that block cannot cause
  doc drift — including backticked identifiers.

### Architecture
`.bober/architecture/arch-20260805-pge-graph-engineering-architecture.md` — ADR-4 (three-scope
state split) is summarised at `src/pge/state/overall.ts:8-47`, including "Anything above a
channel's `maxInlineBytes` is offloaded to the scratch store and referenced through
`refs` as a `ScratchRef`" (:44-46).

### `.gitignore` — what is tracked under `.bober/`
Ignored `.bober/` directories, in full: `snapshots/`, `medical/`, `chat/`, `scratch/`,
`traces/`, `cache/`, `archive/`, `logs/`, `checkpoints/`, `failures/`, `handoff/` (singular),
plus two file rules (`memory/*.db`, `graph/.hook-queue.jsonl`).
Everything else under `.bober/` is TRACKED. `git ls-files .bober` returns:
`anti-patterns, architecture, briefings, contracts, designs, eval-results, evolve, golden,
graph, handoffs, history.jsonl, incidents, onboarding, outlines, playbooks, principles.md,
progress.md, replay, research, specs, topology`.

### The `repo-invariants` interaction — **answer: do nothing**
`src/orchestrator/repo-invariants.test.ts:132-141` holds `WRITTEN_RUNTIME_DIRS`, and
:160-166 requires an ignore rule for each. The OTHER direction, :168-186, requires that no
`.bober/` directory rule exists beyond that list plus `snapshots|medical|chat`:
```ts
    const boberRules = (await ignoreRules())
      .filter((rule) => rule.startsWith(".bober/"))
      .filter((rule) => rule.endsWith("/"))
      .map((rule) => rule.replace(/\/$/, ""));
    expect(boberRules.filter((rule) => !allowed.has(rule))).toEqual([]);
```
A **committed** corpus directory therefore requires **no `.gitignore` change and no
`WRITTEN_RUNTIME_DIRS` change** — and **adding a `.gitignore` rule for it would FAIL
:168-186**. Precedent: sprint 1 added `.bober/topology/measurements/` (written by
`MEASURE_REAL_WORKLOAD=1`) and touched neither file; `.bober/golden/` is written by
`GOLDEN_CAPTURE=1` and is likewise absent from both. `:197-203` is the positive control that
`.bober/topology` is present and not ignored.

---

## 6. Testing Patterns

**Runner:** vitest (no `vitest.config.ts`; default `**/*.test.ts` discovery).
**Assertion style:** `expect(...)` with a message as the 2nd arg on non-obvious asserts —
`expect(channel.maxInlineBytes, \`channel "${channel.id}" cap\`).toBe(4096)`
(`real-workload.test.ts:256`).
**Mock approach:** none. This subtree substitutes only at the declared collaborator seam
(`CodingBindings`) and injects fakes through constructor deps. No `vi.mock` anywhere in
`src/pge/golden/` or `src/pge/engine/`.
**File naming / location:** co-located `<module>.test.ts`; shared non-test helpers in
`__fixtures__/`.
**Timeouts:** engine-driving tests pass `120_000` as the 3rd `it()` argument
(`real-workload.test.ts:329, 354, 383, 421`).

### Unit test pattern — read committed data, assert against the artifact
**Source:** `src/pge/golden/dataset.test.ts:38-65, 86-95`
```ts
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, ".bober", "golden");
const TOPOLOGY_PATH = join(REPO_ROOT, ".bober", "topology", "coding.json");

beforeAll(async () => {
  const artifact = JSON.parse(await readFile(TOPOLOGY_PATH, "utf-8")) as TopologyArtifact;
  facts = { graphId: artifact.graphId, graphVersion: artifact.graphVersion,
            nodeIds: new Set(artifact.nodes.map((node) => node.id)),
            effectNames: new Set(Object.values(EFFECTS)) };
  files = (await readdir(GOLDEN_DIR)).sort();
  const loaded = await loadGoldenDataset(GOLDEN_DIR);
  expect(loaded.errors).toEqual([]);
  cases = [...loaded.cases];
});

describe("the committed golden dataset", () => {
  it("holds between 20 and 50 files, counted by reading the directory", () => {
    expect(files.length).toBeGreaterThanOrEqual(GOLDEN_DATASET_MIN_CASES);
```
**Rule:** this IS the sc-2-5 pattern — the file count and the entry set come from `readdir`
at test time, not from a literal in the test.

### The sc-2-2 equivalence test the evaluator will run
evaluatorNotes: "construct a value, run it through both the corpus helper and the real
commit boundary, and confirm they agree". Build a `CommitBoundary` with
`createCommitBoundary({ clock: createFixedClock(...) })` (`commit.ts:298`), commit a
`ChannelUpdate` whose value is a corpus entry against a graph whose channel cap is
`corpusMax - 1`, and assert `result.rejected[0].bytes === maxBytesPerChannel(corpus)[channel]`.
`StateBloatError.bytes` (`commit.ts:65`) is the boundary's own number, so equality there is
the proof — not a re-derivation.
`src/pge/nodes/__fixtures__/region-harness.ts:20-21` shows how a test builds a boundary and
inspects `CommitResult`.

### E2E: none. There is no `playwright.config.ts` and no `e2e/` directory.

---

## 7. The ten channels: where a REAL payload comes from (sc-2-4's hard part)

Declared in `.bober/topology/coding.json` (authored at `src/pge/topology/coding.graph.ts:117-192`).
All ten declare `maxInlineBytes: 4096`. Byte figures below were measured with the repo's own
`canonicalJson` via `dist/`; the `sprintContracts` figure reproduces sprint 1's committed
135,106 exactly, which is the cross-check that the method is the boundary's.

| channel | schemaRef | the VALUE a node writes | real source | measured canonical bytes |
|---|---|---|---|---|
| `spec` | PlanSpec | the whole `PlanSpec` (`nodes/plan.ts:420`) | `.bober/specs/*.json` — **52 of 53 parse** | max **48,097** (`spec-20260628-medical-analysis.json`); PGE spec 29,214 |
| `sprintContracts` | SprintContract | the whole `SprintContract[]` (`nodes/plan.ts:421`) | `.bober/contracts/*.json` grouped by `spec.sprints` — **190 of 250 parse**; 187 of those exceed 4096 alone | max **135,106** (the PGE spec's 14 — the largest array in the repo); single-contract max 14,823 |
| `evaluations` | SprintVerdict | `[SprintVerdict]` (`nodes/sprint-evaluate.ts:353-361`) via `sprintVerdict()` | `.bober/eval-results/*.json` `summary` — 225 files, 101–825 chars | ≈1.0 KB — **under 4096** |
| `messages` | GraphMessage | `[GraphMessage]` from `note(ctx, text)` | `.bober/handoffs/gen-report-*.json` `notes` (172 files, 66–1,140 chars, median 339); `.bober/eval-results` summaries; correction text is capped at 1024 B by `CORRECTION_EXCERPT_MAX_BYTES` (`sprint-correct.ts:75,167`) | ≈1.3 KB — **under 4096** |
| `refs` | ScratchRef | `{ [key]: ScratchRef }`, one entry (`plan.ts:422`, `sprint-generate.ts:222`) | **No committed instance** — `.bober/scratch/` is gitignored and no golden case contains `scratch://`. Mint a REAL one: `createScratchStore(tmp).put(runId, "document", JSON.stringify(realSpec))` (`scratch.ts:282`) | ≈200 B |
| `counters` | Counters | `{ [key]: number }` (`plan.ts:328`, `research.ts:463`) | **No committed instance.** Observe from a real run | tens of bytes |
| `branchStatus` | BranchStatus | `{ [branchKey]: {state,attempts,errorClass?} }` (`gates.ts:686`, `sprint-generate.ts:226`) | **No committed instance.** Observe from a real run | ≈100 B |
| `testAnchors` | TestAnchors | `string[]` of `anchorId(evaluator, criterion)` (`sprint-evaluate.ts:364`) | **Derivable from real data:** `.bober/eval-results/*.json` `strategyResults[].strategy` × `criteriaResults[].criterionId` through `anchorId()` (`anchors.ts:56`) | small |
| `ledger` | BudgetLedger | `LedgerEntry[]` (`sprint-evaluate.ts:103-107`, `root.ts:751`) | **No committed token/cost data anywhere under `.bober/`** — grep for `tokensIn` matches only an architecture `.md`. Observe from a real run | small |
| `verdict` | RunVerdict | one of `"pending"｜"success"｜"partial"｜"failed"` (`overall.ts:184-185`), written by `finalize` (`root.ts:756`) | **Committed real instance:** `.bober/topology/measurements/real-workload.json:60` → `"failed"` | ≤ 9 B |

**Two honest conclusions to record rather than engineer around (stopConditions):**
1. Against this repository's committed artifacts, **only `spec` and `sprintContracts`
   exceed 4,096.** `evaluations`, `messages` and the rest are comfortably under. Report that;
   do not inflate a payload to make a channel look implicated. (Note: generatorNotes says
   `GeneratorResult.notes` runs "1,100-1,900 chars" — measured across the 172 committed
   gen-reports it runs 66–1,140, median 339, max 1,140. And `notes` never reaches a channel:
   `sprint-generate.ts:213` puts the whole `GeneratorResult` in scratch and writes only a
   one-line note to `messages`.)
2. `refs`, `counters`, `branchStatus` and `ledger` have **no committed file payload**. Two
   real (non-invented) provenances are available — mint through the real component
   (`ScratchStore.put`) or **observe** from a run. Observation is the cheaper one: sprint 1's
   `recordingInterpreterFactory` already receives the run context, and
   `RunContext.commit: CommitBoundary` (`interpreter.ts:257`) can be wrapped the same way to
   record every `batch: readonly ChannelUpdate[]` — each `ChannelUpdate` carries
   `{channel, nodeId, branchKey, value}` (`commit.ts:162-167`), i.e. the exact per-channel
   value. `GraphRunResult.commits` is `CommitRecord[]` and carries NO values
   (`interpreter.ts:313-319`), so the spy is required; the final `GraphRunResult.state` is
   the merged accumulation, not the individual writes.
   To reach the sprint/evaluate region at all, drive `wholeGraphBindings` +
   `conformanceConfig` (`whole-graph.ts:321, 420`) rather than the real 29 KB workload, which
   dies at superstep 12 in `graceful_failure`.

---

## 8. Impact Analysis

### Files that may break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/pge/runtime/interpreter.ts` (:36) | `commit.ts` types | low | Type-only import; a new export cannot affect it. |
| `src/pge/engine/pge-engine.ts` (:23) | `createCommitBoundary`, `createSystemClock` | low | Unchanged symbols. |
| `src/pge/runtime/commit.test.ts` (:68-69) | named imports from `./commit.js` | low | No export-surface pin exists; verify it still passes. |
| `src/pge/nodes/__fixtures__/region-harness.ts` (:20-21), `sprint-harness.ts` (:19) | `createCommitBoundary` | low | Unchanged. |
| `src/pge/engine/real-workload.test.ts` (:83-86) | its own local `byteSize` | **high** | sc-2-2 requires the single function; edit this file and re-run — the committed measurement bytes must be UNCHANGED. |
| `.bober/golden/**` (42 cases) + `src/pge/golden/{dataset,gate,coverage,executor,capture}.test.ts` | `readdir(GOLDEN_DIR)` | **high** | Only if the corpus is placed under `.bober/golden/` — see Pitfall 1. |
| `src/orchestrator/repo-invariants.test.ts:160-186` | `.gitignore` | medium | Must stay UNTOUCHED; adding an ignore rule fails :168-186. |
| `docs/pge-graph.md` + `src/pge/topology/docs.test.ts` | the `pge:channels` table | medium | No cap changes this sprint, so the table must not move. |
| `.github/workflows/ci.yml:82-87` | `pge audit-state` then `git add -A && git diff --cached --exit-code` | medium | Every new file must be COMMITTED; an uncommitted corpus fails the gate. |

### Existing tests that must still pass
- `src/pge/engine/real-workload.test.ts` — 4 tests; the committed measurement compare (:327).
- `src/pge/runtime/commit.test.ts` — the boundary, including the cap check.
- `src/pge/golden/dataset.test.ts` (`files.every(f => f.endsWith(".json"))` :93, `expect(loaded.errors).toEqual([])` :63), `gate.test.ts` (:72 `copyFile` per entry), `executor.test.ts` (:240, :264 same), `coverage.test.ts` (:78-81 `readFile` per entry), `capture.test.ts` (:271-274 same).
- `src/orchestrator/repo-invariants.test.ts` — the bidirectional `.gitignore` rule.
- `src/pge/topology/docs.test.ts`, `src/pge/topology/ci-gate.test.ts` — unmodified, per the spec's NFR.
- `src/orchestrator/workflow/oracle-retention.test.ts`, `conformance.engines.test.ts` — untouched by this sprint; confirm still green.
- Baseline: **6,860 tests passing** (`.bober/eval-results/eval-sprint-spec-20260812-pge-real-workload-errors-1-1.json`, unit-test strategy output).

### Features that could be affected
- **feat-2 (sprint 3, caps)** consumes this corpus directly. A corpus max that drifts makes
  the two-directional cap pin drift. Prefer FROZEN COPIES of the payload in `.bober/workload/`
  over a manifest of source paths: a manifest re-reads `.bober/specs/` and would silently
  move sprint 3's pins the next time a spec file is edited. Record `sourcePath` alongside the
  copy so the evaluator's spot-check (evaluatorNotes) is a one-line comparison.
- **feat-1 AC4 (regenerable measurement)** — the corpus regenerator and
  `MEASURE_REAL_WORKLOAD=1` must both reproduce byte-identical output.

### Recommended regression checks
1. `npx vitest run src/pge/golden/ src/pge/engine/ src/pge/runtime/commit.test.ts src/orchestrator/repo-invariants.test.ts src/pge/topology/docs.test.ts src/pge/topology/ci-gate.test.ts`
2. `git status --porcelain .bober/golden` → must be EMPTY (no corpus file leaked in).
3. `npx vitest run` (full suite; expect ≥ 6,860 passing, zero failures).
4. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`
5. `node dist/cli/index.js pge validate --mode full && node dist/cli/index.js pge docs --check`
6. `node dist/cli/index.js pge audit-state && git add -A && git diff --cached --exit-code`
7. `git check-ignore -v .bober/workload` → must print NOTHING (the corpus is tracked).
8. Mutation proof of sc-2-4: delete one channel's entry from a TEMP COPY and assert the
   completeness test fails.

---

## 9. Implementation Sequence

1. **`src/pge/runtime/commit.ts`** — add `export` to `byteSize` (:257) with a one-line doc
   comment ("The metric the cap check measures against; exported so a corpus cannot
   reimplement it").
   - Verify: `npm run typecheck && npx vitest run src/pge/runtime/commit.test.ts`.
2. **`src/pge/engine/real-workload.test.ts`** — delete the local `byteSize` (:83-86), import
   it from `../runtime/commit.js`.
   - Verify: `npx vitest run src/pge/engine/real-workload.test.ts` — 4 tests green AND
     `git diff --stat .bober/topology/measurements/` shows NO change.
3. **Build the corpus data at `.bober/workload/`** — one JSON file per entry (or one per
   channel), each carrying `{ entryId, channel, provenance, value }`. Use
   `PlanSpecSchema.safeParse` / `SprintContractSchema.safeParse` and SKIP non-parsing files
   (§7) — a `.parse` over the whole directory throws.
   - Verify: `git check-ignore -v .bober/workload` prints nothing; every `channels[].id` in
     `.bober/topology/coding.json` has at least one entry.
4. **`src/pge/golden/workload.ts`** — `WORKLOAD_DIR`, the entry/corpus types,
   `loadWorkloadCorpus(dir)` (P1), `maxBytesPerChannel(corpus)` built on the imported
   `byteSize` (sc-2-2). No inline data.
   - Verify: `npm run typecheck && npm run lint`.
5. **`src/pge/golden/workload.test.ts`** — sc-2-1 (entries are real: each `file` provenance
   resolves to an existing `.bober/specs/` or `.bober/contracts/` path and equals its parsed
   value), sc-2-2 (equality with the real commit boundary, §6), sc-2-4 (channel set read
   from the artifact, P3, plus the temp-copy deletion mutation, P2), sc-2-5 (`readdir` at
   test time; a test that the corpus dir is non-empty on disk).
   - Verify: `npx vitest run src/pge/golden/workload.test.ts`.
6. **Extend the measurement (sc-2-3)** — add the per-channel corpus maxima and the
   `messages`/`evaluations`/`refs` results to `real-workload.test.ts`'s `Measurement` (P4),
   regenerate with `MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts`,
   then re-run WITHOUT the env var so the compare path proves reproducibility.
   - Verify: the committed JSON diff is readable and every number is explainable.
7. **`docs/pge-graph.md`** — document the corpus location and its regeneration command in
   `## The graph engine against a real workload` (:646), plus a `## Changelog` (:804) entry.
   Do NOT touch the `pge:channels` table and do NOT add anything to a `pge:nodes` block.
   - Verify: `node dist/cli/index.js pge docs --check`; `npx vitest run src/pge/topology/docs.test.ts`.
8. **Full verification** — the eight checks in §8.

---

## 10. Pitfalls & Warnings

1. **`.bober/golden/` accepts golden cases and nothing else.** A subdirectory named
   `workload` (or any extra `.json`) breaks four committed things:
   `runner.ts:435` flags it as a stray → `datasetShapeProblems` → the **blocking** CI golden
   gate; `dataset.test.ts:93` `files.every(f => f.endsWith(".json"))`; `gate.test.ts:72` /
   `executor.test.ts:240,264` `copyFile` on a directory → `EISDIR`; `coverage.test.ts:78-81`
   / `capture.test.ts:271-274` `readFile` on a directory → `EISDIR`. And a corpus FILE named
   `*.json` in there is no better: `loadGoldenDataset` parses it as a `GoldenCase`, fails, and
   `dataset.test.ts:63` `expect(loaded.errors).toEqual([])` goes red.
   **Put the data at `.bober/workload/`.** (Alternative: `.bober/topology/workload/`, which
   has sprint 1's `measurements/` precedent — but `REPLAY_INPUT_PATHS` copies `.bober/topology`
   recursively into every replay root (`replay.ts:500-524`), so the corpus would be copied on
   every replay for no reason.)
2. **Do not add a `.gitignore` rule for the corpus.** `repo-invariants.test.ts:168-186` fails
   on any `.bober/` directory ignore rule outside `WRITTEN_RUNTIME_DIRS ∪ {snapshots, medical,
   chat}`. And do not add the corpus to `WRITTEN_RUNTIME_DIRS`: :160-166 would then demand an
   ignore rule, and the two assertions would deadlock.
3. **60 of the 250 files in `.bober/contracts/` do NOT parse under `SprintContractSchema`**
   (the `spec-20260524-bober-vision-*` era: "contractId: Required | sprintNumber: Required"),
   and 1 of 53 in `.bober/specs/` does not parse under `PlanSpecSchema`
   (`spec-20260714-security-auditor-per-stack-skills.json`: "features.0.description: Required").
   A loader that calls `.parse` across a directory throws on the first one. Use `safeParse`
   and record the skips.
4. **`canonicalJson` ≠ `JSON.stringify`.** Sprint 1's committed 135,106 vs the earlier
   138,284 estimate is exactly this. `canonicalJson` sorts keys at every depth and drops
   `undefined` members (`reducers.ts:96-121`). Never hand-roll it.
5. **The value written to `sprintContracts` is the WHOLE ARRAY, not one contract**
   (`plan.ts:421`; the interpreter turns each `update` key into ONE `ChannelUpdate` carrying
   that whole value, `interpreter.ts:1334-1346`). A corpus of individual contracts would
   under-measure that channel by ~10x.
6. **Do not raise any cap.** nonGoal 1 — sprint 3 does that. `real-workload.test.ts:390-422`
   already demonstrates the safe way to explore a raised cap: mutate a COPY inside a temp
   root and re-sign it with `checksumTopology`, never the committed artifact.
7. **`.bober/topology/measurements/real-workload.json` must not change unless you meant it.**
   If step 2 or 6 moves those bytes, explain each moved number in the commit message.
8. **The whole-graph fixture ≠ the real workload.** `wholeGraphBindings` uses
   `stubPlanSpec`/`stubContracts` (`whole-graph.ts:25-29`); the real spec/contracts come only
   from `realWorkloadBindings` (`real-workload.ts:85-92`). If you drive the whole graph to
   observe the sprint-region channels, label those entries' provenance `observed` and be
   explicit that their SHAPE is real while their CONTENT came from a fixture run.
9. **`src/pge/golden/workload.ts` compiles into `dist/`** (`tsconfig.json` includes `src/**/*`,
   excludes only `**/*.test.ts`). Keep it dependency-light — `node:fs/promises`, `node:path`,
   the schemas and `byteSize`. Do not import `src/pge/registry/index.ts`, the composition root
   that `pge-engine.ts:178-191` deliberately keeps out of load-time graphs.
10. **`import type` for type-only imports** — `consistent-type-imports` is an ESLint error,
    and `npm run lint` must be at zero errors.
