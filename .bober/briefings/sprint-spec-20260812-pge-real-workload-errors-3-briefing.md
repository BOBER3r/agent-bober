# Sprint Briefing: Size the caps to the corpus, regenerate the artifact, pin both directions

**Contract:** sprint-spec-20260812-pge-real-workload-errors-3
**Generated:** 2026-08-12T00:00:00Z

> **Read section 9 (Pitfalls) FIRST.** Two files that are NOT in `estimatedFiles` will go red
> the moment you change a cap, and one of them is sprint 1's whole deliverable. Section 7
> lists them with line numbers.

---

## 1. Target Files

### `src/pge/topology/coding.graph.ts` (modify)

The contract says "the authored literal at `:113-190`". The precise ranges are:

**`graphVersion` + `defaults` — lines 94-114:**
```ts
  // 1.2.0 — two corrections that made the artifact unrunnable. (1) plan_clarify and
  // hitl_commit named checkpoint ids ("plan-clarify", "hitl-commit") that are not among
  // ... A structural change to a committed artifact moves
  // graphVersion forward; `pge diff --require-version-bump` is the gate that says so.
  graphVersion: "1.2.0",                                  // ← line 103, becomes "1.3.0"
  description: "...",
  provenance: "authored",
  entry: "research_body",
  defaults: {
    supervisorNodeId: "supervisor",
    modelTier: "light",
    concurrency: 1,
    durability: "superstep",
    maxInlineBytes: 4096,                                  // ← line 113. LEAVE THIS ALONE.
  },
```

**The channel array — lines 117-192.** All ten declare `maxInlineBytes: 4096`. The two you move:
```ts
    {                                                      // lines 160-166
      id: "sprintContracts",
      reducerRef: "appendById",
      schemaRef: "SprintContract",
      scope: "public",
      maxInlineBytes: 4096,                                // ← line 165
    },
    {                                                      // lines 167-175
      // Scalar: `replaceIfNewer` makes a second writer a MultipleWritersOnScalarChannel
      // error, which is why only plan_materialize writes it.
      id: "spec",
      reducerRef: "replaceIfNewer",
      schemaRef: "PlanSpec",
      scope: "public",
      maxInlineBytes: 4096,                                // ← line 174
    },
```

**How the JSON is regenerated (lines 1197-1206):**
```ts
/**
 * The shipped coding topology, sealed with the checksum of its own canonical form.
 *
 * `bober pge dump` serializes exactly this value; `bober pge dump --check` fails on
 * any byte difference between it and `.bober/topology/coding.json`.
 */
export const CODING_GRAPH: TopologySpec = {
  ...CODING_GRAPH_UNSEALED,
  checksum: checksumTopology(CODING_GRAPH_UNSEALED),
};
```
The checksum is DERIVED, so you never hand-write a hex string. Editing the literal is the
only supported route: `runPgeDump` writes `.bober/topology/coding.json` from `AUTHORED_GRAPHS`
(`src/cli/commands/pge.ts:722-733`, `src/pge/topology/dump.ts:145`), and `--check` exits
non-zero on any byte difference (`src/cli/commands/pge.ts:209-220`). **Hand-editing the JSON
is caught by `pge dump --check`, which is a blocking CI step (`.github/workflows/ci.yml`,
`pge-graph-gate`).**

**Imports this file uses (lines 1-2):** `type TopologySpec` from `../../contracts/topology.js`,
`checksumTopology` from `./canonical.js`. **Nothing else may be added** — `eslint.config.js:109-243`
forbids `src/pge/topology/**` from importing the runtime, the golden layer, registries, the CLI,
`execa`, dynamic `import()` or `require()` (ADR-2). So the cap numbers in this file are
LITERALS; the derivation from the corpus lives in the test (see §2 / §8).

**Imported by (verified via grep):** `src/pge/topology/coding.graph.test.ts`,
`src/pge/topology/docs.test.ts:16`, `src/pge/topology/render.test.ts:7`,
`src/pge/topology-invariants.test.ts`, `src/cli/commands/pge.ts` (via `AUTHORED_GRAPHS`),
`src/cli/commands/pge.test.ts`.

**Test file:** `src/pge/topology/coding.graph.test.ts` (exists — **it pins the version, see §7**).

---

### `.bober/topology/coding.json` (modify — GENERATED, never hand-edit)

Current state, read from disk:
```
graphVersion 1.2.0
defaults {concurrency: 1, durability: superstep, maxInlineBytes: 4096, modelTier: light, supervisorNodeId: supervisor}
branchStatus 4096 · counters 4096 · evaluations 4096 · ledger 4096 · messages 4096
refs 4096 · spec 4096 · sprintContracts 4096 · testAnchors 4096 · verdict 4096
```
Regenerate with `node dist/cli/index.js pge dump` after `npm run build`.

---

### `.bober/topology/state-audit.json` (modify — GENERATED)

**Does a cap change alter the audit? YES — but only one field.** `generateStateAudit`
(`src/pge/topology/audit.ts:68-97`) emits:
```ts
  return {
    generatedFrom: { graphId: spec.graphId, checksum: checksumTopology(spec) },   // audit.ts:95
    keys,   // one row per channel: { key, writers, readers, reducer } — audit.ts:85-92
  };
```
`keys[]` carries `key / writers / readers / reducer` and **no byte cap**, so every row is
byte-identical after this sprint. `generatedFrom.checksum` is the checksum of the whole
canonical topology, which a `maxInlineBytes` change moves. The committed file currently reads
`"checksum": "sha256:95c40948ffb8d27f1f7bd1846f1efbcb6d8a9c7ff2daa6300558bd1bfe857c80"`
(`.bober/topology/state-audit.json:4`). **Expect a one-line diff.** Regenerate with
`node dist/cli/index.js pge audit-state` in the same commit — the CI step is
`pge audit-state` then `git add -A` then `git diff --cached --exit-code`
(`.github/workflows/ci.yml`, and driven end-to-end by `src/pge/audit-git-gate.test.ts:76-127`).

---

### `docs/pge-graph.md` (modify)

Four places state the 4,096 number and go stale:

| line | text | action |
|---|---|---|
| 22 | ``Graph defaults: `concurrency: 1`, `durability: "superstep"`, `maxInlineBytes: 4096`,`` | still TRUE (defaults unchanged) — leave |
| 441-450 | "**Every one of the ten channels declares the graph default `maxInlineBytes: 4096`** …" | **must be rewritten** — it is now false |
| 716-725 | the corpus table's `declared limit` column, all `4,096` | **must be updated** for `spec` / `sprintContracts` |
| 759-761 | "**Nothing above is fixed either.** No cap in the committed artifact was raised by this corpus; sizing the caps from it is the next sprint's work." | **must be rewritten** — this sprint IS that work |
| 870-874 | `## Changelog` header prose | add the 1.3.0 entry directly under it, above `### 1.2.0` (line 876) |

Lines 662-672 ("**As committed at `graphVersion 1.2.0`, the engine does not execute that
plan.**" + the measurement table) belong to **sprint 4** (sc-4-5) — do not rewrite them here
unless you also regenerate the measurement (see §7).

---

### `src/pge/golden/workload.test.ts` (modify — this is where sc-3-4 and sc-3-5 land)

**Existing harness you extend (lines 41-79):**
```ts
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKLOAD_DIR_ABS = join(REPO_ROOT, WORKLOAD_DIR);
const TOPOLOGY_PATH = join(REPO_ROOT, ".bober", "topology", "coding.json");
const BUILDING = process.env.BUILD_WORKLOAD_CORPUS === "1";

let declaredChannelIds: string[];
let corpus: WorkloadCorpus;

beforeAll(async () => {
  if (BUILDING) await buildWorkloadCorpus();
  const artifact = JSON.parse(await readFile(TOPOLOGY_PATH, "utf-8")) as { channels: { id: string }[] };
  declaredChannelIds = artifact.channels.map((channel) => channel.id).sort();
  corpus = await loadWorkloadCorpus(WORKLOAD_DIR_ABS);
  expect(corpus.errors).toEqual([]);
}, 120_000);
```
`beforeAll` currently narrows the parsed artifact to `{ channels: { id: string }[] }` — widen
it to `{ id: string; maxInlineBytes: number }[]` and keep the parsed channels in a
module-level `let` so the new tests can read the real declared caps.

**The file's two standing rules (its own header, lines 26-39):** the entry set is read from
disk at test time, never listed here; and every positive assertion has a negative control that
breaks the precondition **on a TEMP COPY**. The committed corpus and the committed topology
artifact are never mutated. `copyCorpus()` (lines 66-72) + `afterEach` (74-79) are the existing
temp-copy machinery.

**Test file:** this IS the test file. No separate one.

---

## 2. Patterns to Follow

### The cap scheme: a documented FUNCTION of the corpus, not a literal

**This is the hardest design question in the sprint. It is answered here; do not re-derive it.**

sc-3-4 demands two things that pull apart: *lowering a cap below its corpus maximum FAILS*
**and** *raising a cap with no corpus payload justifying it FAILS*. `generatorNotes` demands
headroom: "a cap that exactly equals today's maximum will fail the day a spec grows one
field." A cap can only be strictly above the corpus max AND unable to be raised arbitrarily
if the cap is a **deterministic function of the corpus max**, and the pin asserts EQUALITY to
that function rather than an inequality.

**The scheme: two-times headroom, rounded up to a power of two, floored at the graph default.**

```ts
/** The headroom multiplier over the measured corpus maximum. */
export const CAP_HEADROOM_FACTOR = 2;

/**
 * The cap a channel whose corpus maximum is `corpusMaxBytes` must declare.
 *
 * Two properties the two-directional pin needs at once. HEADROOM: the result is always at
 * least CAP_HEADROOM_FACTOR times the largest payload this repository has ever committed,
 * so the day a spec grows a field is not the day the engine stops running. STABILITY: the
 * power-of-two bucket makes the cap a STEP function of the corpus, so a corpus rebuild that
 * moves the maximum by a few hundred bytes does not move the artifact — which matters
 * because the `messages`/`evaluations` entries are a sample of a LIVE readdir
 * (workload-build.ts:184,234) and a rerun can shift it.
 *
 * The floor is DEFAULT_MAX_INLINE_BYTES so no channel's cap ever DECREASES from the shipped
 * 4096; a corpus that happens to hold only tiny payloads for a channel must not be an
 * argument for tightening it.
 */
export function capForCorpusMax(corpusMaxBytes: number): number {
  let cap = DEFAULT_MAX_INLINE_BYTES;            // 4096, contracts/topology.ts:165
  while (cap < corpusMaxBytes * CAP_HEADROOM_FACTOR) cap *= 2;
  return cap;
}
```

Applied to the committed corpus — **I recomputed every number independently with the same
`canonicalValue`/`JSON.stringify` algorithm `canonicalJson` uses
(`src/pge/registry/reducers.ts:95-120`), reading all 123 files under `.bober/workload/`:**

| channel | entries | corpus max (canonical bytes) | new cap | headroom | moves? | holds until corpus max exceeds |
|---|---|---|---|---|---|---|
| `spec` | 52 | **48,097** | **131,072** (2^17) | 2.73× | **YES** (from 4,096) | 65,536 |
| `sprintContracts` | 28 | **135,106** | **524,288** (2^19) | 3.88× | **YES** (from 4,096) | 262,144 |
| `messages` | 6 | 1,292 | 4,096 | 3.17× | no | 2,048 |
| `evaluations` | 6 | 1,067 | 4,096 | 3.84× | no | 2,048 |
| `refs` | 7 | 283 | 4,096 | 14.5× | no | 2,048 |
| `ledger` | 12 | 221 | 4,096 | 18.5× | no | 2,048 |
| `testAnchors` | 1 | 114 | 4,096 | 35.9× | no | 2,048 |
| `branchStatus` | 2 | 102 | 4,096 | 40.2× | no | 2,048 |
| `counters` | 8 | 64 | 4,096 | 64.0× | no | 2,048 |
| `verdict` | 1 | 8 | 4,096 | 512× | no | 2,048 |

Those numbers agree exactly with the corpus table already committed at `docs/pge-graph.md:716-725`.
**Only two caps move.** Every other channel's declared 4,096 already IS `capForCorpusMax` of its
corpus maximum — which is what makes it safe to pin ALL TEN channels, not just the two.

Why this satisfies both directions of sc-3-4:
- **Lowering** `spec` to 40,000: `40000 !== capForCorpusMax(48097) === 131072` → FAILS. (And it is
  also below the corpus max, so the weaker inequality fails too.)
- **Raising** `spec` to 1,048,576: `1048576 !== 131072` → FAILS. Nothing in the corpus justifies it.
- **Headroom is justified BY the corpus**, because it is computed from the corpus max. It is not
  a round number someone liked.

**Where `capForCorpusMax` lives:** `src/pge/golden/workload.ts`, exported next to
`maxBytesPerChannel` (workload.ts:179-187). It is pure. It must NOT be imported by
`coding.graph.ts` — `eslint.config.js:116-219` forbids `src/pge/topology/**` from importing
`src/pge/golden/**`, and `workload.ts:3` imports `node:fs/promises`. The graph literal carries
`131072` and `524288` as plain numbers with a comment naming the corpus figure they came from.

### Pattern: the corpus metric is IMPORTED, never reimplemented

**Source:** `src/pge/golden/workload.ts:165-187`
```ts
/**
 * sc-2-2: `byteSize` here is IMPORTED from `../runtime/commit.js` — the exact function the
 * commit boundary's own cap check uses — never reimplemented. …
 * A channel absent from the corpus is absent from the result rather than defaulted to `0`:
 * a `0` would read as "measured and found small," which is a different fact from "not
 * measured at all" (see sc-2-4).
 */
export function maxBytesPerChannel(corpus: WorkloadCorpus): Record<string, number> {
  const max: Record<string, number> = {};
  for (const entry of corpus.entries) {
    const bytes = byteSize(entry.value);
    const current = max[entry.channel];
    if (current === undefined || bytes > current) max[entry.channel] = bytes;
  }
  return max;
}
```
**Rule:** get every byte figure from `maxBytesPerChannel(corpus)` / `byteSize`; a hardcoded
number in the pin fails the spec's own maintainability NFR
(`.bober/specs/spec-20260812-pge-real-workload-errors.json:188-191`).

### Pattern: a positive assertion plus a mutation control, on a COPY

**Source:** `src/pge/golden/workload.test.ts:214-249`
```ts
describe("the corpus covers every channel the artifact declares (sc-2-4)", () => {
  it("holds at least one entry for every channel .bober/topology/coding.json declares", () => {
    const present = new Set(corpus.entries.map((entry) => entry.channel));
    for (const channelId of declaredChannelIds) {
      expect(present.has(channelId), `channel "${channelId}" has no workload corpus entry`).toBe(true);
    }
  });

  it("fails the completeness check when a channel's entries are deleted from a TEMP COPY", async () => {
    const dir = await copyCorpus();
    ...
    // The exact assertion `sc-2-4`'s production test above makes, replayed against the
    // mutated copy — proof this is the check that would have failed had the real corpus
    // been missing that channel.
    const missing = declaredChannelIds.filter((channelId) => !present.has(channelId));
    expect(missing).toContain(target);
  });
});
```
**Rule:** extract the check into a named pure function, assert it returns `[]` for the real
inputs, then feed it a mutated in-memory copy and assert the SAME function reports the
violation. Do not write a second, weaker assertion for the negative control.

Recommended shape for sc-3-4:
```ts
/** Every channel whose declared cap is not exactly what the corpus says it must be. */
function capViolations(
  channels: readonly { id: string; maxInlineBytes: number }[],
  corpusMax: Record<string, number>,
): string[] { /* ... uses capForCorpusMax ... */ }
```
Then three tests: real artifact → `[]`; a cloned channel array with `spec` LOWERED → contains
`"spec"`; a cloned array with `spec` RAISED → contains `"spec"`. Both mutations are on an
in-memory clone, never on `.bober/topology/coding.json`.

### Pattern: a StateBloatError negative control against a real CommitBoundary

**Source:** `src/pge/golden/workload.test.ts:156-209` — this is the exact shape sc-3-5 needs,
and it already reads the cap rather than hardcoding it:
```ts
const base = goldenSpec();
const mutated: TopologySpec = {
  ...base,
  channels: base.channels.map((decl) =>
    decl.id === channel ? { ...decl, maxInlineBytes: (maxBytesForChannel as number) - 1 } : decl,
  ),
};
const graph = compile(mutated, goldenRegistries({ contracts: goldenContracts(1) }));
...
const result = await boundary.commit(graph, goldenInitialState("run-workload-equivalence", root), [update], {...});
expect(result.rejected).toHaveLength(1);
expect(result.rejected[0].bytes).toBe(maxBytesForChannel);
expect(result.rejected[0].channel).toBe(channel);
```
**For sc-3-5, invert it:** set the fixture graph's `spec` channel to the **NEW SHIPPED cap read
off `.bober/topology/coding.json`** (never the literal `131072`), commit a value whose
`byteSize` exceeds it, and assert the rejection AND that the write was dropped.

> **Do NOT try to `compile()` the committed artifact.** `compile` requires a node impl for
> every declared node id (`src/pge/compile/compiler.ts:435-438`), and `goldenRegistries`
> (`src/pge/runtime/__fixtures__/golden-graph.ts:1001-1009`) supplies the fixture's node ids,
> not the shipped 44. Use the fixture graph with the shipped cap injected, exactly as the
> existing test at :173-180 does.

The "the write was dropped" half has its own precedent at `src/pge/runtime/commit.test.ts:219-221`:
```ts
    // The channel was NOT written: a rejected update does not reach the reducer.
    expect(result.writesPerChannel.messages).toBeUndefined();
    expect(result.state.messages).toEqual([]);
```

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `byteSize` | `src/pge/runtime/commit.ts:265` | `(value: unknown) => number` | Canonical-JSON byte length. **The** metric the cap check uses (`commit.ts:366`). Exported by sprint 2 specifically so nothing reimplements it. |
| `maxBytesPerChannel` | `src/pge/golden/workload.ts:179` | `(corpus: WorkloadCorpus) => Record<string, number>` | Per-channel corpus maximum. Omits channels with no entry rather than defaulting to 0. |
| `loadWorkloadCorpus` | `src/pge/golden/workload.ts:103` | `(dir: string) => Promise<WorkloadCorpus>` | Reads every `.bober/workload/*.json`, validates against `WorkloadEntrySchema`, reports errors instead of throwing. |
| `WORKLOAD_DIR` | `src/pge/golden/workload.ts:49` | `string` (`".bober/workload"`) | Corpus location, relative to project root. |
| `DEFAULT_MAX_INLINE_BYTES` | `src/contracts/topology.ts:165` | `4096` | The schema default and the floor for `capForCorpusMax`. |
| `StateBloatError` | `src/pge/runtime/commit.ts:63-88` | `class` w/ `channel, bytes, limit, nodeId, branchKey` | The rejection. Its message ends "Offload the payload to the scratch store and commit a ScratchRef" — that advice is now partly obsolete (D1 rejected scratch offload) but **changing the message is out of scope**. |
| `createCommitBoundary` / `createFixedClock` | `src/pge/runtime/commit.ts` (exported; used at `workload.test.ts:14,184`) | — | Real boundary + deterministic clock for the negative control. |
| `compile` | `src/pge/compile/compiler.ts:413` | `(spec, reg) => CompiledGraph` | Requires a node impl per node id — see the warning in §2. |
| `goldenSpec` / `goldenRegistries` / `goldenContracts` / `goldenInitialState` | `src/pge/runtime/__fixtures__/golden-graph.ts` (imported at `workload.test.ts:16-21`) | — | The fixture graph. Its own `spec` cap is 8192 and `sprintContracts` 65536 (`golden-graph.ts:360,366`) — a deliberate divergence from the shipped artifact. |
| `checksumTopology` / `canonicalize` | `src/pge/topology/canonical.ts` | `(spec) => string` | Re-seals the literal. Never hand-write a checksum. |
| `generateStateAudit` / `stateAuditPath` / `serializeStateAudit` | `src/pge/topology/audit.ts:68,46,101` | — | The state audit. `pge audit-state` is the CLI wrapper. |
| `diffTopology` / `isVersionBumped` | `src/pge/topology/diff.ts:253,231` | — | The version-bump gate's engine. |
| `bumpedVersion` | `src/cli/commands/pge.test.ts:623-626` | `(from?: string) => string` | **Derived** next-minor helper. Precedent for never writing a version literal in a test. Copy the idea into `docs.test.ts` (see §7). |

**Directories reviewed for reusable helpers:** `src/utils/`, `src/pge/topology/`, `src/pge/runtime/`,
`src/pge/golden/`. There is **no** existing cap-derivation helper anywhere —
`grep -arn maxInlineBytes src/` returns only `contracts/topology.ts:205,345`,
`coding.graph.ts`, fixtures, and the one check at `commit.ts:367`. `capForCorpusMax` is genuinely new.

---

## 4. Prior Sprint Output

### Sprint 1 (5190f7d) — the measurement harness
**Created:** `src/pge/engine/real-workload.test.ts`, `src/pge/engine/__fixtures__/real-workload.ts`,
`.bober/topology/measurements/real-workload.json`.
**Exports you may need:** `REAL_SPEC_ID`, `REAL_SPEC_PATH`, `realPlanSpec()`, `realContracts()`,
`realWorkload()`, `realWorkloadBindings()` (`__fixtures__/real-workload.ts:36-60`).
`workload.test.ts:13` already imports `REAL_SPEC_ID, realPlanSpec`.
**Connection:** the measurement is the evidence the caps were wrong. **It is also the single
biggest hazard in this sprint — see §7.**

### Sprint 2 (93469d8) — the committed corpus
**Created:** `.bober/workload/` (123 entries, all ten channels), `src/pge/golden/workload.ts`,
`src/pge/golden/workload.test.ts`, `src/pge/golden/__fixtures__/workload-build.ts`.
**Modified:** `src/pge/runtime/commit.ts` — `byteSize` is now `export`ed (`commit.ts:257-266`).
**Connection:** this sprint reads that corpus at test time and derives every cap from it.
The corpus is COMMITTED on purpose (`workload.ts:26-29`): "a live re-read would let sprint 3's
cap silently drift the next time an unrelated spec file is edited."

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **No synchronous filesystem ops** — `node:fs/promises` only (line 44).
- **`import type`** enforced by `consistent-type-imports` (line 38).
- **ESM with `.js` extensions** on every relative import (line 27).
- **Section comments** using `// ── Section Name ─────` box-drawing headers (line 33) — every
  file you touch already follows this; match it.
- **Zero type errors and zero lint errors are hard gates** (lines 19-20).
- **No filesystem mocks in tests** — temp dirs, cleaned up (line 45). `workload.test.ts:66-79`
  already does this.

### AGENTS.md
- "Confirm every file you touched is listed in the sprint contract's `expectedChanges`. If you
  modified a file not in `expectedChanges`, that is a scope violation. Revert it or **explain the
  deviation**." (AGENTS.md, "If You Are an AI Agent", item 5.) → §7 lists three files outside
  `estimatedFiles` that you cannot avoid. **Explain each one in your completion notes.**
- "Code-reviewer findings without `file:line`" is a listed rejection reason. Every claim you add
  to `docs/pge-graph.md` needs a test behind it (this sprint's `definitionOfDone` says the same).

### Spec decisions that bind this sprint
- `resolvedClarifications` **D1** (`.bober/specs/spec-20260812-pge-real-workload-errors.json:13-18`):
  size the caps to measured reality; MINOR bump; keep `StateBloatError`; pin two-directionally.
  **Scratch offload with `ScratchRef`s was explicitly REJECTED. Do not reopen it.**
- `nonFunctionalRequirements[2]` (`:188-191`): "Channel caps are derived from a committed corpus,
  never hand-picked… The two-directional cap pin reads the corpus at test time; hardcoding a cap
  in the test fails it."
- `nonFunctionalRequirements[0]` (`:177-181`): "No gate may be weakened to make this spec green."

### Architecture
`.bober/architecture/arch-20260805-pge-graph-engineering-architecture.md` — ADR-2 (the committed
artifact is load-bearing; the topology layer is a pure module graph) and ADR-4 (writers/readers
are derived, never stored on `channels[]`) are the two that touch this sprint. Neither is
disturbed by a cap change.

---

## 6. Testing Patterns

**Runner:** vitest (`package.json:17`). **Assertions:** `expect`. **Mocks:** none — real temp
dirs. **Naming:** `*.test.ts`, collocated. **Location:** next to the source.

### Unit test pattern — reading real committed files in `beforeAll`
**Source:** `src/pge/topology/docs.test.ts:216-249`
```ts
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DOC_PATH = join(REPO_ROOT, "docs", "pge-graph.md");
const ARTIFACT_PATH = topologyArtifactPath(REPO_ROOT, "coding");

let committed: TopologySpec;
let shippedDoc = "";

beforeAll(async () => {
  const read = await readTopologyArtifact(ARTIFACT_PATH);
  if (!read.ok) throw new Error(`${ARTIFACT_PATH} is not readable as a topology artifact: ${read.message}`);
  committed = TopologySpecSchema.parse(read.raw);
  shippedDoc = await readFile(DOC_PATH, "utf8");
});
```
Note the file's own hard rule (`docs.test.ts:204-206`): "Neither is ever written to — every
negative control mutates an in-memory FIXTURE spec, never the committed artifact (HARD RULE 5)."

### Mutation-control pattern — clone, break, assert the SAME check fails
**Source:** `src/pge/topology/docs.test.ts:869-884`
```ts
  it("FAILS when a fixture node starts writing a channel it did not write", () => {
    const fixture = withNode(committed, "sprint_review", {
      writes: ["evaluations", "ledger", "messages", "testAnchors"],
    });
    expect(() => {
      assertTableMatches(shippedDoc, DOC_CHANNELS_BEGIN, DOC_CHANNELS_END, expectedChannelRows(fixture), "channel table");
    }).toThrow();
  });
```

### E2E / CLI pattern
Not Playwright. The end-to-end analogue here is `src/pge/audit-git-gate.test.ts:58-107`, which
builds a real git repo in `mkdtemp`, runs `runPgeDump` + `runPgeAuditState` through their
exported functions, and shells out to `git` via `execa`:
```ts
  await git(["init"]);
  expect(await runPgeDump(root, {}, io)).toBe(EXIT_OK);
  expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);
  await git(["add", "-A"]);
  await git(["commit", "-m", "topology and state audit"]);
```
That file lives **one directory above** `src/pge/topology/` because ADR-2's ESLint boundary
forbids `execa` inside the guarded subtree (`audit-git-gate.test.ts:24-26`). You should not need
to touch it — it derives everything and pins nothing version-specific.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### A. `pge diff` classification — MINOR vs MAJOR. **ANSWER: the stop condition cannot fire.**

`diffTopology` has **no MAJOR/MINOR classifier at all.** The only version fact it computes is
`bumped: boolean` (`src/pge/topology/diff.ts:356-370`), via:
```ts
/**
 * True when `to` is strictly greater than `from` under numeric semver comparison.
 * A DOWNGRADE is deliberately not a bump…
 */
export function isVersionBumped(from: string, to: string): boolean {   // diff.ts:231-240
```
and the gate is a single line:
```ts
  if (opts.requireVersionBump && !diff.empty && !diff.graphVersion.bumped) {   // src/cli/commands/pge.ts:494
```
A `maxInlineBytes` change lands in `channelsRemoved` + `channelsAdded` (both listing `"spec"`
and `"sprintContracts"`), because `diffKeyed` reports an id present on both sides whose canonical
form differs as a removal PLUS an addition (`diff.ts:171-192`, and the rationale comment at
`diff.ts:156-165`). So `diff.empty === false` and any forward version move — patch, minor or
major — satisfies the gate. **`pge diff` will NOT report this as MAJOR, because it has no
concept of MAJOR.** The stop condition "`pge diff` reports the change as MAJOR" is unsatisfiable.

The place MAJOR actually matters is the golden dataset, and it agrees:
```ts
/**
 * The version rule is MAJOR-only on purpose. Pinning the exact `graphVersion` would force
 * all two dozen files to be rewritten on every minor bump — which is how a dataset stops
 * being maintained — … A major bump
 * is the repository's own signal that the structure changed, so that is the bump that
 * invalidates a recording.
 */                                          // src/pge/golden/case-schema.ts:348-357
  const caseMajor = majorVersion(goldenCase.graph.graphVersion);
  const graphMajor = majorVersion(facts.graphVersion);
  if (caseMajor !== graphMajor) { violations.push(...) }     // case-schema.ts:371-377
```
All 42 committed cases record `graphVersion: "1.2.0"` (verified by parsing every file in
`.bober/golden/`). `majorVersion("1.3.0") === majorVersion("1.2.0") === 1` → **no case is
invalidated.** `src/pge/golden/dataset.test.ts:40-56,116` is the caller that supplies the facts
from the committed artifact.

**Take `1.3.0`.**

### B. Files That May Break

| File | Depends on | Risk | What breaks |
|---|---|---|---|
| **`src/pge/engine/real-workload.test.ts`** | the committed artifact's caps | **CRITICAL** | seven assertions — see below |
| **`.bober/topology/measurements/real-workload.json`** | the run under those caps | **CRITICAL** | byte-compared at `real-workload.test.ts:379` |
| **`src/pge/topology/coding.graph.test.ts:117`** | `graphVersion` literal | **high** | `expect(parsed.data.graphVersion).toBe("1.2.0")` |
| **`src/pge/topology/docs.test.ts:969-978`** | `graphVersion` + changelog list | **high** | two tests, one of them a negative control keyed on `"1.3.0"` |
| **`src/pge/topology/__fixtures__/coding.mermaid:2`** | `spec.graphVersion` in the header | **high** | byte-pinned at `render.test.ts:118-121` |
| **`src/pge/topology/__fixtures__/coding.dot:2`** | same | **high** | byte-pinned at `render.test.ts:270-273` |
| `.bober/topology/state-audit.json:4` | `checksumTopology(spec)` | medium | one-line diff; regenerate |
| `docs/pge-graph.md:441-450, 716-725, 759-761` | the 4,096 claim | medium | prose goes false; `docs.test.ts` does not check these lines, but `definitionOfDone` does |
| `src/pge/nodes/sprint-correct.ts:14` | comment "Every channel in the coding artifact declares `maxInlineBytes: 4096`" | low | comment-only; the truncation logic targets `messages`, which stays at 4,096. Correcting it is optional and outside `estimatedFiles`. |
| `src/pge/runtime/__fixtures__/engram-graph.ts:76`, `nodes/research.ts:75`, `nodes/supervisor.ts:51`, `nodes/effects.ts:736` | prose mentions of 4096 | low | all about `messages`/`refs`, unchanged |

**`src/pge/engine/real-workload.test.ts` — the exact assertions that go red:**
```
:288-294  for (const channel of topology.channels) expect(channel.maxInlineBytes).toBe(4096);
:321      expect(measurement.rejections.length).toBeGreaterThan(0);
:323      expect(rejection.limit).toBe(4096);
:326-328  expect(rejectedChannels.has("spec")).toBe(true);  / ("sprintContracts")
:333      expect(measurement.specChannelNullAtBoundary).toBe(true);
:342-346  expect(measurement.status).toBe("completed");
          expect(measurement.engineOutcome).toEqual({ kind: "threw", errorClass: "FinalizeWithoutSpecError" });
:363-379  the byte-for-byte compare against .bober/topology/measurements/real-workload.json
:440-474  "raising the spec channel's cap in a LOCAL COPY … removes exactly the spec rejection"
          — its control assertion `expect(rejectedChannels.has("sprintContracts")).toBe(true)`
            (:471) also dies once the real sprintContracts cap is raised.
```
`:351-354` (`corpusHeadroom[...].declaredLimit === 4096` for `messages`/`evaluations`/`refs`)
**survives**, because the scheme leaves those three at 4,096. That is a deliberate benefit of
raising only the two implicated channels.

> **This is the sprint's central tension.** `sc-3-7` demands a green full suite, but
> `estimatedFiles` does not list `real-workload.test.ts` or the measurement — sprint 4 owns them
> (`sprint-…-4.json` `estimatedFiles`, sc-4-1..sc-4-4). You cannot leave the suite red.
> **Recommended resolution, to be stated explicitly in your completion notes:**
> 1. Change `real-workload.test.ts`'s hardcoded `4096`s to read each channel's OWN declared cap
>    off the loaded `topology` (the file's own comment at `:287-288` already says "measured off
>    the loaded artifact, never off a list here" — honour it).
> 2. Restate the rejection assertions as what is now true: for `spec`/`sprintContracts`,
>    `byteSize < declared cap`, so no rejection. Keep them non-vacuous (`plan_materialize` still
>    ran — the span check at `:313-314` is the guard).
> 3. Fix the local-copy control at `:440-474` by **LOWERING** a cap in the temp copy instead of
>    raising it, which is the same proof ("the harness reads each channel's own declared limit")
>    and survives any future cap value.
> 4. Regenerate the measurement:
>    `MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts`.
> 5. **Say in your notes that sprint 4's sc-4-4 diff ("the rejections gone") is now the sprint
>    3 commit's diff**, so sprint 4 reads it from git history rather than producing it again.
> If the regenerated measurement shows something other than "rejections gone" — e.g. the run
> still ends at `graceful_failure`, or `commit.finalize` still throws — **that is sprint 4's and
> sprint 7's territory. Record it and do not chase it here.**

### C. Existing Tests That Must Still Pass

- `src/pge/golden/dataset.test.ts` — reads `.bober/topology/coding.json`, runs
  `checkCaseAgainstGraph` over all 42 cases (`:116`). MAJOR-only → passes at 1.3.0.
- `src/pge/golden/gate.test.ts`, `src/pge/golden/runner.test.ts`, `capture.test.ts` — fixture
  literals `"1.2.0"` (`runner.test.ts:39,338`, `case-schema.test.ts:34,266`) are compared
  major-only; no change needed.
- `src/pge/golden/coverage.test.ts` — reads the artifact for node ids only (`:44`). Unaffected.
- `src/pge/topology/docs.test.ts` node/gate/loop/router/edge/**channel** tables (`:803-812`) —
  the channel table's columns are `channel | scope | reducer | schema | written by`
  (`docs/pge-graph.md:421-433`). **No cap column**, so the table needs no edit.
- `src/pge/audit-git-gate.test.ts` — derives everything in a temp repo. Unaffected.
- `src/pge/topology/ci-gate.test.ts` — audits `.github/workflows/ci.yml` text. Unaffected.
- `src/pge/topology-invariants.test.ts` — HITL checkpoint ids. Unaffected.
- `src/pge/runtime/commit.test.ts:214,275`, `src/pge/runtime/interpreter.test.ts:518,554` —
  all against the golden FIXTURE graph (`golden-graph.ts:355-366`), not the shipped artifact.
  Unaffected.
- `src/orchestrator/workflow/oracle-retention.test.ts` — must stay green and unmodified (spec NFR).
- `src/orchestrator/repo-invariants.test.ts:200` — only asserts the artifact file exists.

### D. Features That Could Be Affected
- **feat-1 (sprints 1-2, DONE)** — shares `.bober/topology/coding.json` and the corpus. The
  measurement artifact is the collision; see B.
- **feat-2 AC5** ("a PgeEngine run … produces zero StateBloatError and leaves `state.spec`
  non-null") is **sprint 4's** sc-4-1/sc-4-2, not yours. Do not build a second harness.
- **feat-4 / sprint 7** adds a `specDraft` scalar channel. Leaving `defaults.maxInlineBytes` at
  4,096 keeps the conservative default for it; sprint 7 will declare its own explicit cap.
  **Do not add `specDraft` here** (nonGoal 3).
- **feat-5 / sprint 8-9** re-captures the five replay cases. A MINOR bump must not force that —
  see sc-3-6 below.

### E. sc-3-6 — why the golden dataset must NOT move, and what it means if it does

A cap raise can only ever **admit** a write that was previously rejected. It cannot change a
write that was already under the cap. The largest `PlanSpec`-shaped object anywhere in the 42
cases is **1,181 bytes** (`docs/pge-graph.md:648-650`, `__fixtures__/real-workload.ts:20`), and
`grep -rn StateBloat .bober/golden/` returns **nothing** — no committed case records a rejection.
The eleven recorded conformance fields are `contracts, history, specs, evalResults, briefings,
reviews, audits, progress, runState, completionMarker, pipelineResult`
(`src/orchestrator/workflow/types.ts:68-80`); none carries a channel cap, a checksum or a
graphVersion. Therefore **every recorded artifact must be byte-identical after this sprint.**

If a golden case DOES move: that means a golden run was silently dropping a write under the old
4,096 cap and nobody noticed — the same class of defect this whole spec exists to fix, one layer
down. **Stop and report it. It is a finding, not a licence to re-capture.** `nonGoals[1]` and the
first `stopCondition` say exactly this.

(One inert curiosity, for your awareness only: `.bober/golden/context-compaction-does-not-change-artifacts.json:17-20`
carries `input.config: { "maxInlineBytes": 4096 }`. It is an `enforcement: "integrity"` case, and
the executor REFUSES any case with `input.config` (`src/pge/golden/executor.ts:286-291`), so it is
never executed and never compared. **Do not edit it.**)

### F. The corpus-sampling instability, and why the bucket scheme absorbs it

The evaluator's carried-forward finding is real and already documented at
`docs/pge-graph.md:748-758`:
> "The `messages`/`evaluations` entries are a six-item representative sample drawn from a **live
> `readdir`** of `.bober/handoffs/` and `.bober/eval-results/` … the listing is not pinned to a
> commit, so regenerating once more run artifacts have accumulated silently swaps committed
> entries for different real ones. The sample always keeps the genuine maximum…"

Confirmed in code: `representativeSample` sorts by size descending and always keeps the top
(`workload-build.ts:78-97`), and the sources are read with `readdir` at build time
(`workload-build.ts:184,234`).

Why this does not destabilise the pin:
1. **The pin reads the COMMITTED corpus** (`workload.test.ts:60`), not the live directories. A
   rerun of the suite cannot move anything. Only a deliberate `BUILD_WORKLOAD_CORPUS=1` can.
2. **The bucket absorbs drift.** `messages` must grow from 1,292 to **above 2,048** canonical
   bytes before `capForCorpusMax` moves it off 4,096 — a 59% jump. `evaluations` has 92% slack.
   `spec` has 36% and `sprintContracts` 94%.
3. **When it does move, it moves LOUDLY and correctly**: the pin fails, the artifact must be
   regenerated, and `pge diff --require-version-bump` forces a version bump plus a changelog
   entry. That is the spec's stated maintainability goal ("a future payload growth is a
   measurable event rather than a surprise"), not a bug.

**Say all three of these in the `capForCorpusMax` doc comment.** That is the justification the
evaluator will look for.

### G. Recommended Regression Checks

Run in this order, from the repo root:
1. `npm run build`
2. `node dist/cli/index.js pge dump --check` → expect `ok .bober/topology/coding.json sha256:…`
3. `node dist/cli/index.js pge validate --mode full` → zero diagnostics. (There is **no**
   cap-related diagnostic — `grep -arn maxInlineBytes src/pge/topology/validate.ts` is empty —
   so this is a regression guard, not a new gate.)
4. `node dist/cli/index.js pge docs --check`
5. `git show HEAD:.bober/topology/coding.json > /tmp/base-coding.json && node dist/cli/index.js pge diff /tmp/base-coding.json .bober/topology/coding.json --require-version-bump`
   → expect `channelsAdded: ["spec","sprintContracts"]`, `channelsRemoved: ["spec","sprintContracts"]`,
   `graphVersion: { from: "1.2.0", to: "1.3.0", bumped: true }`, exit 0.
6. `node dist/cli/index.js pge audit-state && git add -A && git diff --cached --exit-code`
7. `npx vitest run src/pge/golden/ src/pge/topology/ src/pge/engine/ src/pge/audit-git-gate.test.ts`
8. `npx vitest run` (full suite)
9. `npm run typecheck && npm run typecheck:tests && npm run lint`

Plus the two mutation checks the evaluator will perform on you (do them yourself first):
- Lower `spec` to `48096` in the authored literal, `npm run build`, run `workload.test.ts` → must FAIL.
- Raise `spec` to `1048576`, rebuild, run `workload.test.ts` → must FAIL.
- Revert both.

---

## 8. Implementation Sequence

1. **`src/pge/golden/workload.ts`** — add `CAP_HEADROOM_FACTOR` and `capForCorpusMax(corpusMaxBytes)`
   next to `maxBytesPerChannel` (:179). Import `DEFAULT_MAX_INLINE_BYTES` from
   `../../contracts/topology.js`. Document the three stability properties from §7F.
   - *Verify:* `npm run typecheck`. `capForCorpusMax(48097) === 131072`,
     `capForCorpusMax(135106) === 524288`, `capForCorpusMax(1292) === 4096`,
     `capForCorpusMax(0) === 4096`.

2. **`src/pge/topology/coding.graph.ts`** — set `graphVersion: "1.3.0"` (:103) with a `1.3.0 —`
   comment block above it in the style of the existing `1.2.0` block (:94-102); set
   `spec.maxInlineBytes: 131_072` (:174) and `sprintContracts.maxInlineBytes: 524_288` (:165),
   each with an inline comment naming the corpus maximum and the headroom rule. **Leave
   `defaults.maxInlineBytes: 4096` (:113) alone** and say why in the comment (a new channel should
   inherit the conservative default).
   - *Verify:* `npx vitest run src/pge/topology/coding.graph.test.ts` — expect exactly ONE
     failure, the `graphVersion` pin at `:117`.

3. **`src/pge/topology/coding.graph.test.ts:115-117`** — move the pin to `"1.3.0"` and rewrite the
   comment above it to say what 1.3.0 changed.
   - *Verify:* that file is green.

4. **Regenerate `.bober/topology/coding.json`** — `npm run build && node dist/cli/index.js pge dump`,
   then `node dist/cli/index.js pge dump --check`.
   - *Verify:* `git diff .bober/topology/coding.json` shows exactly three changed values —
     `graphVersion`, two `maxInlineBytes` — plus the top-level `checksum`.

5. **Regenerate `.bober/topology/state-audit.json`** — `node dist/cli/index.js pge audit-state`.
   - *Verify:* the diff is one line (`generatedFrom.checksum`); `git add -A && git diff --cached --exit-code`
     is non-zero **before** you commit and zero after.

6. **Regenerate the render fixtures** —
   `node dist/cli/index.js pge render --format mermaid > src/pge/topology/__fixtures__/coding.mermaid`
   and `--format dot > …/coding.dot`. (`runPgeRender` strips the trailing newline and `processIo.out`
   re-adds exactly one — `src/cli/commands/pge.ts:456-458,79` — so redirection reproduces the exact
   bytes `renderTopology` emits.)
   - *Verify:* the diff on each file is line 2 only (`v1.2.0` → `v1.3.0`);
     `npx vitest run src/pge/topology/render.test.ts` green.

7. **`src/pge/golden/workload.test.ts`** — widen the `beforeAll` artifact narrowing to keep
   `maxInlineBytes`, add the `capViolations` helper, then the sc-3-4 trio (real → `[]`; lowered →
   names the channel; raised → names the channel) and the sc-3-5 negative control (fixture graph
   carrying the SHIPPED `spec` cap read off the artifact; a value above it; `rejected[0]` is a
   `StateBloatError` whose `limit` equals the shipped cap; the channel is unwritten).
   - *Verify:* `npx vitest run src/pge/golden/workload.test.ts`, then hand-mutate the authored
     literal in both directions and confirm each mutation reddens it.

8. **`src/pge/engine/real-workload.test.ts` + `.bober/topology/measurements/real-workload.json`** —
   the unavoidable out-of-contract edit (§7B). Replace the hardcoded `4096`s with the loaded
   artifact's own per-channel caps, restate the rejection assertions, flip the local-copy control
   to LOWER a cap, then
   `MEASURE_REAL_WORKLOAD=1 npx vitest run src/pge/engine/real-workload.test.ts`.
   - *Verify:* re-run without the env var — it must reproduce the committed bytes.

9. **`docs/pge-graph.md`** — add `### 1.3.0 — sizing the channel caps to the committed corpus`
   immediately under `## Changelog` (line 870) and above `### 1.2.0` (line 876). It must state,
   per cap, the **measured basis**: e.g. "`spec`: 4,096 → 131,072. Corpus maximum 48,097 canonical
   bytes (`spec-20260628-medical-analysis`, `.bober/workload/`); 2× headroom rounded up to the next
   power of two." Same for `sprintContracts` (135,106 → 524,288, largest entry
   `sprintContracts-spec-20260805-pge-graph-engineering`). Note that the other eight channels
   already satisfy the same rule at 4,096 and are unchanged, and that `defaults.maxInlineBytes`
   stays 4,096. Then fix lines 441-450, 716-725 and 759-761.
   - *Verify:* `node dist/cli/index.js pge docs --check`.

10. **`src/pge/topology/docs.test.ts:969-978`** — the changelog pin. **This test must be moved
    deliberately, not silently.** Current text:
    ```ts
      it("carries a changelog entry for the committed graphVersion", () => {
        expect(committed.graphVersion).toBe("1.2.0");                              // :970
        assertChangelogCoversVersion(committed, shippedDoc);                       // :971
        expect(changelogVersions(shippedDoc)).toEqual(["1.2.0", "1.1.0", "1.0.0"]); // :972
      });

      it("FAILS when the artifact is bumped to a version the changelog does not mention", () => {
        const fixture: TopologySpec = { ...committed, graphVersion: "1.3.0" };     // :976
        expect(() => { assertChangelogCoversVersion(fixture, shippedDoc); }).toThrow();
      });
    ```
    Both change: `:970` → `"1.3.0"`, `:972` → `["1.3.0","1.2.0","1.1.0","1.0.0"]`, and **`:976`'s
    fixture version must move off `"1.3.0"`** — otherwise the negative control silently stops being
    a control the moment 1.3.0 is in the changelog. Derive it instead of writing a literal, in the
    style of `bumpedVersion` (`src/cli/commands/pge.test.ts:618-626`), and say in a comment that a
    literal here rots. (`changelogVersions` is at `:890-895`; `assertChangelogCoversVersion` at
    `:897-902`; it reads `^### (\d+\.\d+\.\d+)\b` headings after `## Changelog`.)
    - *Verify:* `npx vitest run src/pge/topology/docs.test.ts`.

11. **Full verification** — the nine-step list in §7G.

---

## 9. Pitfalls & Warnings

- **`grep` treats several `.ts` files in this repo as binary** (`src/pge/registry/reducers.ts`,
  `src/pge/topology/docs.test.ts` and others contain non-UTF-8 bytes). Plain `grep -rn` reports
  **nothing** for them. **Always use `grep -a`.** I nearly missed the changelog pin because of this.
- **Never hand-edit `.bober/topology/coding.json` or `.bober/topology/state-audit.json`.** Both are
  generated; `pge dump --check` and `pge audit-state` + `git diff --cached --exit-code` are blocking
  CI steps. Editing the JSON and forgetting the literal produces a green local run and a red CI.
- **Never hand-write a checksum.** `CODING_GRAPH` re-seals itself (`coding.graph.ts:1203-1206`).
- **`src/pge/topology/**` cannot import `src/pge/golden/**`** (`eslint.config.js:116-219`, ADR-2).
  The cap numbers in `coding.graph.ts` are literals; the derivation lives in the test.
- **The golden fixture graph is NOT the shipped artifact.** `golden-graph.ts:360,366` already
  declares `spec: 8192` and `sprintContracts: 65536`. Do not "fix" it to match — its divergence is
  deliberate, and `real-workload.test.ts:284-288` exists specifically to guard against confusing
  the two. If you use it for sc-3-5, inject the shipped cap read from the artifact.
- **`compile()` needs a node impl per node id** (`compiler.ts:435-438`). You cannot compile the
  committed 44-node artifact with `goldenRegistries`.
- **Do not touch `StateBloatError`'s message.** It still advises "Offload the payload to the scratch
  store and commit a ScratchRef" (`commit.ts:80`), which D1 rejected as the remedy. Changing it is
  out of scope and would ripple into `interpreter.test.ts:518` and `commit.test.ts`.
- **Do not add the `specDraft` channel** — nonGoal 3, sprint 7's work.
- **Do not edit any golden case.** nonGoal 2 and the first stopCondition. If one fails, stop.
- **Do not change `defaults.maxInlineBytes`.** It is a residual field in the diff
  (`diff.ts:143-154` — `defaults` has no dedicated change list, so it lands in `graphFieldsChanged`),
  it is the safe inherit-value for future channels, and `docs/pge-graph.md:22` states it correctly
  today.
- **`pge diff` exit code is 0 for any diff unless `--require-version-bump` is passed**
  (`src/cli/commands/pge.ts:476-478`). Don't read a bare `pge diff` exit 0 as "no change".
- **The two-directional pin must fail in BOTH directions.** A pin written as
  `expect(cap).toBeGreaterThanOrEqual(corpusMax)` catches only shrinkage and is half a pin — the
  evaluator will mutate upward to check. Assert EQUALITY to `capForCorpusMax(corpusMax)`.
- **The changelog entry must state a MEASURED basis per cap**, not a round number. The evaluator
  checks this explicitly (`evaluatorNotes`). Cite 48,097 and 135,106 and name the rule.
