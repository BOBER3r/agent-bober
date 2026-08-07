# Sprint Briefing: Golden dataset, blocking CI gates, node-level documentation with drift enforcement, and the recorded engine migration disposition

**Contract:** sprint-spec-20260805-pge-graph-engineering-14
**Generated:** 2026-08-07T00:00:00Z
**Curator note:** every claim below was read out of the working tree at the cited path. Numbers in section 5 were extracted programmatically from `.bober/topology/coding.json`, not transcribed.

---

## 0. Reading order for the three implementers

| Agent | Owns | Read first |
|---|---|---|
| **Docs agent** | `docs/pge-graph.md`, `src/pge/topology/docs.test.ts` | §5 (full inventory), §2.1 (the backtick trap), §9 |
| **CI/golden agent** | `.github/workflows/ci.yml`, `src/pge/golden/*`, `.bober/golden/`, `scripts/` | §1, §3, §4, §6, §7 |
| **Disposition agent** | the disposition prose inside `docs/pge-graph.md` | §8, §10, §11 |

Three hard facts that override anything you may assume:

1. **Loop bounds live on NODES, not on edges.** No edge in `.bober/topology/coding.json` carries `counterKey`, `maxIterations` or `onExhausted`; the edge key union is exactly `from,id,kind,label,ports,to`. A drift test that iterates `spec.edges` looking for loop metadata iterates an empty list and passes while asserting nothing. Cross-check against `node.loop` (§5.3).
2. **`pge docs` has a required `<doc>` positional and NO `--check` flag** (`src/cli/commands/pge.ts:760-771`). sc-14-4 asks CI to run `pge docs --check`. Reconcile honestly — see §1.4.
3. **`normalize()` in `src/orchestrator/workflow/conformance.ts:85` is NOT exported.** `generatorNotes` says to reuse it. Today you cannot. See §3 — this is the CI/golden agent's first blocker.

---

## 1. `src/cli/commands/pge.ts` — the exact registration and return contract

**File:** `/Users/bober4ik/agent-bober-workspace/agent-bober/src/cli/commands/pge.ts` (805 lines, action: **modify**)
**Test file:** `src/cli/commands/pge.test.ts` — **exists**, 1000+ lines, 12 `describe` blocks (`pge.test.ts:93,152,213,401,415,503,656,701,828,870,949,1019`).

### 1.1 Exit codes — the three constants every new gate must return

```ts
// src/cli/commands/pge.ts:57-62
/** Everything the requested verb asserted held. */
export const EXIT_OK = 0;
/** The topology is wrong: an error diagnostic, drift, or a stale checksum. */
export const EXIT_FAILED = 1;
/** The command could not run: unknown graph id, unreadable or unparseable file. */
export const EXIT_USAGE = 2;
```

### 1.2 The IO seam and the registration pattern — copy this verbatim

```ts
// src/cli/commands/pge.ts:71-81
export interface PgeIo {
  out(line: string): void;
  err(line: string): void;
}

export function processIo(): PgeIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}
```

```ts
// src/cli/commands/pge.ts:669-672
async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}
```

```ts
// src/cli/commands/pge.ts:773-786  — the audit-state registration, the closest template
  pge
    .command("audit-state")
    .description("Derive .bober/topology/state-audit.json from the committed topology")
    .option("--graph <id>", "Graph id whose committed artifact to audit", CODING_GRAPH_ID)
    .option("--file <path>", "Audit this artifact instead of the committed one")
    .option("--check", "Fail instead of writing when the committed audit has drifted")
    .action(async (cmdOpts: { graph?: string; file?: string; check?: boolean }) => {
      const io = processIo();
      process.exitCode = await runPgeAuditState(
        await resolveRoot(),
        { graphId: cmdOpts.graph, file: cmdOpts.file, check: cmdOpts.check },
        io,
      );
    });
```

**Rule (`pge.ts:66-70`, the doc comment on `PgeIo`):** *"no verb ever calls `process.exit` — each returns an exit code and the Commander action assigns it to `process.exitCode`."* Every `runPge*` is `(projectRoot: string, opts: <T>, io: PgeIo) => Promise<number>`. Do not deviate.

### 1.3 Signatures and the exact non-zero conditions

| Function | Signature (`pge.ts` line) | Returns non-zero when |
|---|---|---|
| `runPgeDump` | `(projectRoot, opts: PgeDumpOptions, io, effects: EffectRegistry = createEffectRegistry()) => Promise<number>` (`:167`) | `EXIT_USAGE` unknown graphId (`:177`) or artifact unreadable (`:201`). `EXIT_FAILED` authored literal fails validation (`:183`), checksum stale (`:195`), and **in `--check` mode only**: artifact missing (`:209`) or byte-differs (`:213`). Without `--check` it WRITES and returns 0. |
| `runPgeValidate` | `(projectRoot, opts: PgeValidateOptions, io) => Promise<number>` (`:258`) | `EXIT_USAGE` artifact unreadable/missing/unparseable (`:267`) or JSON-but-not-topology (`:295`). `EXIT_FAILED` when `reportDiagnostics` counted ≥1 `severity === "error"` (`:309`). `mode` defaults to `"structural"` (`:272`). |
| `runPgeHash` | `(_projectRoot, opts: PgeHashOptions, io) => Promise<number>` (`:332`) | `EXIT_USAGE` unknown graph / unreadable / not TopologySpec. `EXIT_FAILED` only in `[file]` form when the stored `checksum` ≠ recomputed (`:374`). |
| `runPgeRender` | `(projectRoot, opts: PgeRenderOptions, io) => Promise<number>` (`:440`) | `EXIT_USAGE` unknown format (`:447`) or bad artifact. Never `EXIT_FAILED`. |
| `runPgeDiff` | `(_projectRoot, opts: PgeDiffOptions, io) => Promise<number>` (`:479`) | `EXIT_USAGE` either side unloadable. **`EXIT_FAILED` if and only if** `opts.requireVersionBump && !diff.empty && !diff.graphVersion.bumped` (`:493`). |
| `runPgeDocs` | `(projectRoot, opts: PgeDocsOptions, io) => Promise<number>` (`:518`) | `EXIT_USAGE` artifact unloadable or `readFile(opts.doc)` throws (`:529`). `EXIT_FAILED` when `report.drift.length > 0` (`:542`) — drift in EITHER direction. |
| `runPgeAuditState` | `(projectRoot, opts: PgeAuditStateOptions, io) => Promise<number>` (`:567`) | `EXIT_USAGE` artifact unloadable / audit unreadable (`:589`). `EXIT_FAILED` audit invalid (`:580`), and **in `--check` mode only**: audit missing (`:597`) or content-drifted (`:601`). Without `--check` it WRITES. |
| `runPgeOptimize` | `(projectRoot, opts: PgeOptimizeOptions, io) => Promise<number>` (`:637`) | `EXIT_FAILED` when the variant produces error diagnostics (`:660`). |

The verbatim gate branch you must exercise both sides of for sc-14-5:

```ts
// src/cli/commands/pge.ts:493-498
  if (opts.requireVersionBump && !diff.empty && !diff.graphVersion.bumped) {
    io.err(
      `Topology changed but graphVersion did not move forward (${diff.graphVersion.from} -> ${diff.graphVersion.to}).`,
    );
    return EXIT_FAILED;
  }
```

And the docs gate:

```ts
// src/cli/commands/pge.ts:535-547
  const report = docDriftReport(loaded.spec, text);
  for (const id of report.missing) {
    io.err(`error DocDrift: node "${id}" is declared in the topology but absent from ${opts.doc}.`);
  }
  for (const id of report.extra) {
    io.err(`error DocDrift: "${id}" is documented in ${opts.doc} but is not a declared node.`);
  }
  if (report.drift.length > 0) {
    io.err(`${opts.doc}: ${report.drift.length} documentation drift(s).`);
    return EXIT_FAILED;
  }
  io.out(`ok ${opts.doc} (${report.declared.length} nodes documented)`);
```

### 1.4 `pge docs --check` does not exist — the honest reconciliation

`pge docs` is registered with a **required positional** and only `--graph` / `--file`:

```ts
// src/cli/commands/pge.ts:759-771
  pge
    .command("docs <doc>")
    .description("Check a markdown document's pge:nodes block against the committed topology")
    .option("--graph <id>", "Graph id whose committed artifact to check against", CODING_GRAPH_ID)
    .option("--file <path>", "Check against this artifact instead of the committed one")
```

`runPgeDocs` **already fails closed** — it never rewrites the document, so it is a checker in every sense but the flag name. Two honest options, in order of preference:

- **(A) Add `--check` as an explicit alias-with-teeth on a now-OPTIONAL positional:** `.command("docs [doc]")` + `.option("--check", ...)`, defaulting `doc` to `docs/pge-graph.md` when `--check` is passed. This makes `bober pge docs --check` a real invocation whose exit code is `runPgeDocs`'s. Cost: `docs <doc>` becomes `docs [doc]`, and `runPgeDocs` must return `EXIT_USAGE` when neither a positional nor `--check` is given, so the arity change cannot silently pass. **`pge.test.ts:1019 describe("registerPgeCommand")` already asserts the wired command surface — read it before touching the registration.**
- **(B) Keep the CLI as-is and write the workflow step as `node dist/cli/index.js pge docs docs/pge-graph.md`**, then have the sc-14-4 workflow test assert the step *contains* `pge docs` and the doc path. This is honest but sc-14-4's literal wording ("invokes … `pge docs --check`") is then unmet.

**Do NOT do the third thing:** add a `--check` boolean that is read and discarded. That is a fabricated flag and is exactly the decorative gate the evaluator is hunting for.

---

## 2. The topology modules each gate calls

### 2.1 `src/pge/topology/docs.ts` — DO NOT REWRITE (shipped sprint 3)

```ts
// src/pge/topology/docs.ts:31-35
export const DOC_NODES_BEGIN = "<!-- pge:nodes -->";
export const DOC_NODES_END = "<!-- /pge:nodes -->";

/** Inline code spans holding a bare identifier: `` `research_body` ``. */
const CODE_SPAN = /`([A-Za-z_][A-Za-z0-9_]*)`/g;
```

Exports: `DOC_NODES_BEGIN`, `DOC_NODES_END`, `documentedNodeIds(docText): string[]` (`:66`), `DocDriftReport` (`:77`), `docDriftReport(spec, docText): DocDriftReport` (`:91`), `docDrift(spec, docText): string[]` (`:111`), `checkDocDrift(spec, docPath): Promise<string[]>` (`:122`).

```ts
// src/pge/topology/docs.ts:77-88
export interface DocDriftReport {
  documented: string[];   // ids the doc claims, sorted
  declared: string[];     // ids the artifact declares, sorted
  missing: string[];      // declared but not documented
  extra: string[];        // documented but not declared
  drift: string[];        // symmetric difference; empty only when the sets are equal
}
```

> **THE TRAP, and it will bite the docs author.** `CODE_SPAN` matches ANY backticked bare identifier inside a `pge:nodes` region. Writing `` `SprintVerdict` ``, `` `sprintIterations` ``, `` `mockCurationRounds` `` or `` `graceful_failure` `` inside a marked region registers each as a *claimed node id*, so `report.extra` becomes non-empty and `runPgeDocs` returns `EXIT_FAILED`. Note `graceful_failure` IS a node so it is safe; `sprintIterations` is NOT.
>
> Two safe strategies: (i) put the node checklist in a small dedicated `pge:nodes` region containing **only** backticked node ids, and write every gate/loop/schema table OUTSIDE the markers; or (ii) inside the region, write non-node identifiers unbackticked (plain text or bold). The `no-marker-block ⇒ documents nothing` behaviour is deliberate (`docs.ts:24-26`), and multiple regions are concatenated (`docs.ts:44-63`). An **unterminated** region reads to end of document (`docs.ts:52-57`) — a typo in the closing marker silently swallows the entire rest of the file into the node set.
>
> Precedent already in the tests: `src/pge/topology/docs.test.ts:61` — *"ignores code spans outside the block, including schema and field names"*.

Existing helper in the CLI test you can reuse verbatim:

```ts
// src/cli/commands/pge.test.ts:645-654
function docFor(ids: readonly string[]): string {
  return [
    "# PGE graph",
    "",
    DOC_NODES_BEGIN,
    ...ids.map((id) => `- \`${id}\``),
    DOC_NODES_END,
    "",
  ].join("\n");
}
```

### 2.2 `src/pge/topology/diff.ts` — what "structural mode" concretely means (sc-14-6)

**There is no `--mode` flag on `pge diff`.** `diffTopology` is *unconditionally* structural, and that is the whole answer to sc-14-6. Concretely, three facts, each verifiable:

1. `runPgeDiff` loads both sides through `loadArtifactSpec` (`pge.ts:485-488`), which parses with **`TopologySpecSchema.safeParse` only** (`pge.ts:402`). It never calls `validateTopology`.
2. `codingSchemaCatalog()` (`pge.ts:92`) and `promptRefSet()` (`pge.ts:101`) are constructed **only** inside `runPgeValidate` under `mode === "full"` (`pge.ts:277-292`). No other verb touches them.
3. `diffTopology` re-parses each side through `TopologySpecSchema` and canonicalises (`diff.ts:80-90`), then compares canonical JSON. `promptRef` and `schemaRef` are ordinary `string` fields in that JSON — they are **compared for equality, never resolved**.

Therefore a base artifact naming `promptRef: "planner/does-not-exist"` produces **no diagnostic at all**; if head names the same ref the diff is empty and `--require-version-bump` exits 0. The only way such a base can fail the gate is if head *changed* the ref, which is a real structural change deserving a bump. Assert that in the sc-14-6 test: base fixture with an unknown `promptRef`, head identical → `runPgeDiff(root, {a, b, requireVersionBump: true}, io) === EXIT_OK` and `diff.empty === true`.

The `empty` computation, which is what the gate keys off:

```ts
// src/pge/topology/diff.ts:343-354
  const empty =
    graphFieldsChanged.length === 0 &&
    finalNodesAdded.length === 0 && finalNodesRemoved.length === 0 &&
    nodesRenamed.length === 0 && nodesChanged.length === 0 &&
    edges.added.length === 0 && edges.removed.length === 0 &&
    channels.added.length === 0 && channels.removed.length === 0 &&
    routeLabelsAdded.length === 0 && routeLabelsRemoved.length === 0;
```

```ts
// src/pge/topology/diff.ts:231-240 — a DOWNGRADE is not a bump
export function isVersionBumped(from: string, to: string): boolean {
  const a = parseVersion(from); const b = parseVersion(to);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  return false;
}
```

Other exports: `TopologyDiff` (`:35`), `NodeRename` (`:19`), `NodeFieldChange` (`:24`), `RouteLabelChange` (`:31`), `diffTopology(a, b)` (`:253`, **throws `TypeError`** if either side fails the schema), `serializeTopologyDiff(diff)` (`:374`).

### 2.3 `src/pge/topology/dump.ts`

Exports you will need: `TOPOLOGY_DIR = join(".bober","topology")` (`:23`), `topologyArtifactPath(projectRoot, graphId)` (`:26`), `PROMPT_DIR` (`:31`), `readIfPresent(path): Promise<FileRead>` (`:56`), `serializeTopology(spec): string` (`:77` — the exact committed bytes, pretty-printed, trailing newline), `dumpTopology(projectRoot, spec, {check}): Promise<DumpResult>` (`:145`), `readTopologyArtifact(path): Promise<ReadArtifactResult>` (`:210`), `readPromptStore(projectRoot)` (`:250`), `TopologyShapeSchema` (`:302`), `looksLikeTopology(raw)` (`:312`).

`TopologyDrift = "none" | "missing" | "content" | "unreadable" | "stale"` (`:98`).

### 2.4 `src/pge/topology/validate.ts`

`validateTopology(raw, opts?): ValidationReport`. Types: `DIAGNOSTIC_CODES` (`:45`, 32 codes), `DiagnosticCode` (`:80`), `ValidationDiagnostic` (`:84`), `ValidationReport { ok, spec, diagnostics }` (`:93`), `SchemaCatalog` (`:102`), `PromptRefSet` (`:109`), `ValidationMode = "structural" | "full"` (`:113`), `ValidateTopologyOptions { mode?, schemas?, prompts? }` (`:115`).

Relevant to the docs author: **every node must carry a `doc` string** or `UndocumentedNode` fires (`validate.ts:1177-1187`). All 44 already do — §5 reproduces them.

### 2.5 `src/pge/topology/audit.ts`

`StateAuditKeySchema` (`:24`), `StateAuditSchema` (`:32`), `STATE_AUDIT_FILENAME = "state-audit.json"` (`:43`), `stateAuditPath(projectRoot)` (`:46`), `generateStateAudit(spec)` (`:68`), `serializeStateAudit(audit)` (`:101`), `StateAuditDrift = "none"|"missing"|"content"|"invalid"|"unreadable"` (`:112`), `writeStateAudit(projectRoot, spec, {check})` (`:160`).

For the CI step `pge audit-state` + `git diff --exit-code`: `audit-state` **without** `--check` rewrites the file; the subsequent `git diff --exit-code` is what turns a stale audit into a red build. `audit-state --check` is the same assertion without touching the tree — both are legitimate; the contract asks for the former.

---

## 3. The conformance normalisation the golden schema should reuse — **A BLOCKER**

**Fact, verified:** in `/Users/bober4ik/agent-bober-workspace/agent-bober/src/orchestrator/workflow/conformance.ts`, the three functions that implement volatile-key stripping are **module-private**:

- `const VOLATILE_KEYS = new Set([...])` — line **65**, **not exported**
- `function normalize(value: unknown): unknown` — line **85**, **not exported**
- `function canonical(value: unknown): string` — line **105**, **not exported**
- `function redactRoots(value, roots)` — line **125**, **not exported**

What **is** exported from that file: `EngineRunner` (`:37`), `REDACTED_PROJECT_ROOT` (`:110`), `EngineConformanceHarness` (`:465`), `fullyPopulatedFields(report)` (`:598`), `emptyOnAllEnginesFields(report)` (`:605`).

The volatile set itself, verbatim:

```ts
// src/orchestrator/workflow/conformance.ts:65-76
const VOLATILE_KEYS = new Set([
  "createdAt", "updatedAt", "startedAt", "completedAt", "timestamp",
  "duration", "runId", "totalCost", "durationMs", "approverId",
]);
```

```ts
// src/orchestrator/workflow/conformance.ts:85-102
function normalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const obj = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    if (!VOLATILE_KEYS.has(k)) result[k] = normalize(obj[k]);
  }
  return result;
}
```

**Therefore `generatorNotes`' instruction "reuse the existing conformance normalisation" is not satisfiable today without a change.** The correct, minimal, non-weakening move: **add `export` to `normalize` (and `canonical`, if the golden schema wants the canonical bytes) and to `VOLATILE_KEYS`** — a pure visibility widening with no behaviour change. Then `src/pge/golden/case-schema.ts` imports it. The doc comment at `conformance.ts:47-50` sets a deliberately high bar for *adding* a key; exporting the existing function adds nothing and removes nothing.

Do **not** re-implement a second copy of the stripping logic. Two normalisers that can drift is precisely the class of bug this sprint exists to gate against, and a golden expectation normalised by a divergent copy would silently stop matching the harness.

Precedent that this cross-layer import is already sanctioned: `src/pge/runtime/replay.ts:6-10` imports `EngineConformanceHarness`, `emptyOnAllEnginesFields`, `fullyPopulatedFields` from `../../orchestrator/workflow/conformance.js`. Note the ESLint boundary in `eslint.config.js:114-116` covers **`src/pge/topology/**` and `src/contracts/topology.ts` only** — `src/pge/golden/**` is NOT in that fileset, so importing the orchestrator from there is legal. Confirm by reading `eslint.config.js:105-180` before you write the import.

---

## 4. Parsing `.github/workflows/ci.yml` from a test

### 4.1 The file as it stands today

```yaml
# .github/workflows/ci.yml:1-34
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
      - run: npm run lint
      - run: npm run test

  kpi-gate:
    name: KPI Gate (informational — see TODO)
    runs-on: ubuntu-latest
    needs: build-and-test
    # TODO(0.13.0): remove continue-on-error to make this job blocking
    continue-on-error: true       # <-- nonGoal 1 forbids following this precedent
```

(Reproduced with the `with:` block folded for brevity; the real file has it expanded at lines 16-18 and 38-40.)

Two things sc-14-3 depends on that are already true: the workflow triggers on `pull_request` (line 5), and `kpi-gate` sets `continue-on-error: true` (line 34). Your new job must `needs: build-and-test` (generatorNotes) and must not contain that key anywhere.

### 4.2 Is a YAML parser a dependency? **No.**

`package.json` `dependencies` = `@anthropic-ai/sdk, @modelcontextprotocol/sdk, better-sqlite3, chalk, commander, execa, glob, grammy, ora, prompts, sax, semver, zod, zod-to-json-schema`. `devDependencies` = `@eslint/js, @types/better-sqlite3, @types/node, @types/prompts, @types/sax, @types/semver, @typescript-eslint/*, eslint, markdownlint-cli, typescript, vitest`. **No `yaml`, no `js-yaml`, no `@types/js-yaml`.**

`js-yaml@4.1.1` **is** physically present in `node_modules` — but only transitively, `npm ls js-yaml` → `agent-bober@0.19.0 └─┬ markdownlint-cli@0.48.0 └── js-yaml@4.1.1`. Importing it is a **phantom dependency**: it works locally, it has no `@types`, and it breaks the moment markdownlint-cli's tree changes. Do not do it silently.

**The three honest options:**

1. **Add `js-yaml` + `@types/js-yaml` to `devDependencies` explicitly.** Cleanest semantics. Cost: `package.json` + `package-lock.json` churn, and the sandbox may not be able to run `npm install`.
2. **Hand-roll an indentation-aware reader for the two facts you need.** There is direct in-repo precedent: `src/discovery/scanners/ci-checks.ts:1-137`, whose header comment reads *"Extracts 'run:' commands from steps using a simple line-by-line parser. No yaml dependency -- pure string parsing."* Its `parseWorkflowFile` (`:49`) already handles inline `run:` and `run: |` blocks. You need slightly more: locate the job block by its 2-space-indented `<jobname>:` key under `jobs:`, slice to the next 2-space key, then assert (a) the slice contains each required command substring, (b) the slice does **not** match `/^\s*continue-on-error:\s*true/m`. This is ~40 lines and has zero new dependencies. **Recommended.**
3. **Assert on raw text only.** Weakest — `continue-on-error: true` anywhere in the file (i.e. `kpi-gate`'s) would false-positive, so you would have to scope by string offset anyway, which is option 2 with worse ergonomics.

Whichever you pick, the sc-14-3/sc-14-4 test must read the **real** `.github/workflows/ci.yml` (resolve it from `import.meta.url`, mirroring `src/cli/commands/pge.test.ts:46`'s `fileURLToPath(new URL(...))` pattern) — not a fixture copy — and the evaluator will check that adding `continue-on-error: true` to your job makes it fail. Ship that negative control as a test that injects the key into an in-memory copy of the file text and asserts the *parser helper* reports it, so the assertion cannot be satisfied by luck.

**No existing test parses `.github/` today.** The `.github/workflows/ci.yml` hits in `src/discovery/config-generator.test.ts:184,206,…` and `src/orchestrator/security-knowledge/supply-chain-inspector.test.ts:247` are **literal strings inside synthetic fixtures**, not reads of the real file. `src/discovery/scanner.test.ts:214,249,286` writes workflow files into a `tmpDir`. You are the first to read the committed one; `src/discovery/scanner.test.ts:204` even comments *"agent-bober has no .github/workflows"*, which is now stale.

---

## 5. The full node inventory — extracted from `.bober/topology/coding.json`

**Artifact facts (read, not remembered):** `graphId: "coding"`, `graphVersion: "1.2.0"`, `formatVersion: 1`, `entry: "research_body"`, **44 nodes**, **56 edges**, **10 channels**, **2 subgraphs**.
Node kinds: `tool` 7, `llm` 15, `router` 7, `gate` 13, `subgraph` 2.
Top-level keys: `channels, checksum, defaults, description, edges, entry, formatVersion, graphId, graphVersion, nodes, provenance, subgraphs`.
`defaults`: `{ concurrency: 1, durability: "superstep", maxInlineBytes: 4096, modelTier: "light", supervisorNodeId: "supervisor" }`.
Node key union: `cache, doc, effects, gate, hitl, id, inputPorts, kind, loop, modelTier, outputPorts, promptRef, reads, role, subgraph, subgraphRef, targets, title, toolRef, writes`.
Edge key union: `from, id, kind, label, ports, to` — **no loop metadata on any edge**. Edge kinds: `normal` 37, `conditional` 17, `fanout` 2.

> **Derive these lists at test time from the artifact.** The tables below exist so the documentation author is not transcribing from memory; a test that hardcodes them stops testing the moment the graph moves.

### 5.1 Nodes, grouped by subgraph

#### Root graph — 23 nodes

| id | kind | title | one-line doc (first sentence of node.doc) |
|---|---|---|---|
| `commit` | tool | Commit the working tree | Creates the run's commit. |
| `context_compact` | tool | Compact the conversation context | Runs at a superstep boundary when the message window crosses the compression threshold: summarises older messages to scratch and re-injects the digest. |
| `critique` | llm | Critique the failing run | Turns the global evaluation into per-branch rework instructions. |
| `documenter` | llm | Document the run | Writes the sprint documentation and the progress summary for the completed work. |
| `evaluate_global` | llm | Evaluate the whole spec | Grades the run against the spec's acceptance criteria rather than any single contract. |
| `fanout_sprints` | router | Sprint fan-out | Emits one branch per admitted contract. |
| `finalize` | tool | Finalize the run | Emits the terminal artifacts, the pipeline-complete history event and the completion marker. |
| `gate_eval_in` | gate | Evaluation entry gate | Admits the run into global evaluation once every sprint branch has settled. |
| `gate_plan_in` | gate | Plan entry gate | Admits the run into planning only when a research digest exists and the spec is absent or stale. |
| `gate_plan_out` | gate | Plan exit gate | Returns control to the supervisor once the spec and its contracts are on disk; fails closed when persistence did not happen. |
| `graceful_failure` | tool | Fail gracefully | The single failure terminal: records the failure classes per branch and the human-readable reason, then ends the run without a commit. |
| `hitl_commit` | gate | Commit approval | Human-in-the-loop approval guarding the git commit. |
| `plan_clarify` | gate | Plan clarification interrupt | Human-in-the-loop interrupt collecting answers to the planner's open questions. |
| `plan_clarify_check` | router | Clarification check | Routes to the human clarification interrupt while the draft still carries open questions and the clarification budget holds. |
| `plan_draft` | llm | Draft the plan | Produces a PlanSpec draft with sprint contracts and clarification questions from the research digest. |
| `plan_materialize` | tool | Materialize the plan | Persists the PlanSpec and every SprintContract under .bober/. |
| `reduce_sprints` | gate | Sprint fan-in barrier | The single join for the sprint fan-out: every branch leaves its subgraph through gate_sprint_out and converges here. |
| `research_body` | subgraph | Research subgraph call site | Root-level call site for the research subgraph; the graph entry point. |
| `rework_route` | router | Rework router | Re-dispatches the failed branches through the sprint subgraph while the rework budget holds, and fails gracefully once it is spent. |
| `route_after_eval` | router | Post-evaluation router | Chooses between documenting a passing run, synthesising a partial one, reworking failed branches, and failing gracefully. |
| `sprint_body` | subgraph | Sprint subgraph call site | Root-level call site for the sprint subgraph. |
| `supervisor` | router | Supervisor | Dispatches the next phase (plan, sprints, evaluate) and folds each subgraph result back into the run. |
| `synthesize` | llm | Synthesize a partial result | Produces a qualified answer from the branches that did succeed when the run is only partially complete. |

#### Subgraph `research` (entryGate gate_research_in, exitGate gate_research_out, depth 1, persistence inherit) — 7 nodes

| id | kind | title | one-line doc (first sentence of node.doc) |
|---|---|---|---|
| `gate_research_in` | gate | Research entry gate | Boundary gate admitting the feature request into the research subgraph. |
| `gate_research_out` | gate | Research exit gate | Boundary gate returning the research digest to the supervisor; fails closed when no research document was produced. |
| `research_collect` | tool | Collect the research document | Writes the consolidated research document under .bober/research/ and records its scratch ref. |
| `research_critique` | llm | Critique the research findings | Grades the exploration for unanswered questions and unsupported claims. |
| `research_explore` | llm | Explore the codebase | Answers the reflexion questions against the real codebase and offloads oversized findings to scratch refs. |
| `research_reflect` | llm | Reflect on the research question | Turns the feature request into the exploration questions the explorer will answer, and records the reflexion round in counters. |
| `research_route` | router | Research reflexion router | Sends the critique back for another exploration round until the reflexion budget is spent, then collects what exists. |

#### Subgraph `sprint` (entryGate gate_sprint_in, exitGate gate_sprint_out, depth 1, persistence inherit) — 14 nodes

| id | kind | title | one-line doc (first sentence of node.doc) |
|---|---|---|---|
| `gate_anchor_regression` | gate | Anchor regression gate | Re-runs the recorded anchor tests; a regression routes to the corrector regardless of the sprint's own verdict. |
| `gate_mock_coverage` | gate | Mock coverage gate | Rejects a sprint whose declared boundaries are not covered by fixtures, sending it back to the mock curator. |
| `gate_sprint_in` | gate | Sprint entry gate | Boundary gate admitting one contract branch into the sprint subgraph; a non-admissible contract short-circuits to the branch exit. |
| `gate_sprint_out` | gate | Sprint exit gate | Boundary gate releasing ONE settled branch out of the sprint subgraph; the sprint subgraph's declared exit gate. |
| `gate_syntax` | gate | Syntax gate | Runs typecheck and lint under the sandbox policy; any failure routes straight to the corrector without spending an evaluation. |
| `sprint_correct` | llm | Correct the sprint | Applies the evaluator's and the gates' feedback to the working tree, then hands back to the generator for the next attempt. |
| `sprint_curate_explain` | llm | Curate and explain context | Selects the files this contract touches and explains them to the generator. |
| `sprint_curate_mocks` | llm | Curate mock boundaries | Writes the fixtures and boundary mocks the sprint's tests need before any implementation exists. |
| `sprint_evaluate` | llm | Evaluate the sprint | Runs the sprint's evaluation strategies, executing the project test command under the sandbox policy and recording the anchor tests it observed green. |
| `sprint_exit` | tool | Exit the sprint branch | Records the branch verdict and flushes the contract's artifacts; the single per-branch termination point. |
| `sprint_generate` | llm | Generate the sprint | Implements one sprint contract against the curated context, writing source and collocated tests into the working tree. |
| `sprint_review` | llm | Review the sprint diff | Advisory code review of a passing sprint diff against the contract and the anti-pattern catalogue. |
| `sprint_route` | router | Sprint iteration router | Retries the branch through the corrector while the iteration budget holds, passes to review on success, and exits the branch when the budget is spent. |
| `sprint_security` | llm | Security audit the sprint diff | Fail-closed security review of the sprint diff; findings are recorded as evaluations before the terminal evaluator runs. |

### 5.2 The 13 gates — `gate.check`, `gate.onFail`, and the port `schemaRef` sc-14-8 asks about

sc-14-8's *"what schema it validates"* maps to **`node.inputPorts[].schemaRef`**; *"what it routes to on failure"* maps to **`node.gate.onFail`**. Five gates carry no ports at all (`gate_eval_in`, `gate_mock_coverage`, `gate_sprint_out`, `gate_syntax`, `hitl_commit`, `reduce_sprints`) — the doc and the test must handle "no schemaRef" as a legitimate value, not as a hole.

| gate node | subgraph | gate.check | gate.onFail | inputPorts (key:schemaRef) | hitl | loop |
|---|---|---|---|---|---|---|
| `gate_anchor_regression` | sprint | `anchor-tests-still-green` | `sprint_correct` | verdict:SprintVerdict | — | — |
| `gate_eval_in` | root | `all-sprints-settled` | `graceful_failure` | (none) | — | — |
| `gate_mock_coverage` | sprint | `mock-coverage-threshold` | `sprint_curate_mocks` | (none) | — | mockCurationRounds |
| `gate_plan_in` | root | `research-digest-present` | `graceful_failure` | brief:ResearchDigest | — | — |
| `gate_plan_out` | root | `spec-and-contracts-persisted` | `graceful_failure` | contracts:SprintContract | — | — |
| `gate_research_in` | research | `feature-request-present` | `graceful_failure` | request:FeatureRequest | — | — |
| `gate_research_out` | research | `research-document-written` | `graceful_failure` | digest:ResearchDigest | — | — |
| `gate_sprint_in` | sprint | `contract-admissible` | `sprint_exit` | contract:SprintContract | — | — |
| `gate_sprint_out` | sprint | `branch-verdicts-recorded` | `graceful_failure` | (none) | — | — |
| `gate_syntax` | sprint | `typecheck-and-lint` | `sprint_correct` | (none) | — | — |
| `hitl_commit` | root | `human-approval` | `graceful_failure` | (none) | checkpointId=end-of-pipeline, onReject=graceful_failure | — |
| `plan_clarify` | root | `clarifications-answered` | `graceful_failure` | draft:PlanSpec | checkpointId=post-plan, onReject=graceful_failure | — |
| `reduce_sprints` | root | `all-branches-settled` | `fanout_sprints` | (none) | — | fanoutRetries |


### 5.3 The 8 loop bounds — **ON NODES**

| node with loop | kind | counterKey | maxIterations | onExhausted |
|---|---|---|---|---|
| `gate_mock_coverage` | gate | `mockCurationRounds` | 2 | `sprint_exit` |
| `plan_clarify_check` | router | `planClarifyRounds` | 3 | `graceful_failure` |
| `reduce_sprints` | gate | `fanoutRetries` | 2 | `graceful_failure` |
| `research_route` | router | `researchReflexions` | 3 | `research_collect` |
| `rework_route` | router | `reworkRounds` | 2 | `graceful_failure` |
| `sprint_correct` | llm | `sprintIterations` | 3 | `sprint_exit` |
| `sprint_route` | router | `sprintIterations` | 3 | `sprint_exit` |
| `supervisor` | router | `supervisorRounds` | 12 | `graceful_failure` |


**`sprint_correct` and `sprint_route` SHARE the counterKey `sprintIterations`** — the mapping counterKey → node is **1:N, not 1:1**. Do not build a `Map<counterKey, node>` and assume 8 entries; you get 7 keys over 8 nodes. `coding.json`'s own doc for `sprint_correct` states the intent verbatim: *"The counterKey is deliberately the SAME sprintIterations budget the router spends, so a branch gets three correction attempts in total however it got here."* The corresponding `gate_mock_coverage` doc explains why it does NOT share: *"The re-curation retry is a cycle of its own that never reaches sprint_route, so it carries its own bound rather than borrowing one."*

Schema location: `LoopBoundSchema` fields at `src/contracts/topology.ts:182-184` (`counterKey: z.string().min(1)`, `maxIterations: z.number().int().min(1)`, `onExhausted: EndpointSchema`); attached at `topology.ts:253` as `loop: LoopBoundSchema.optional()`. Gate policy: `onFail: EndpointSchema` at `topology.ts:225`, attached at `topology.ts:273` as `gate: GatePolicySchema`. `doc: z.string().min(1).optional()` at `topology.ts:235`.

### 5.4 Routers and their outcome labels

| router | targets (label -> to) |
|---|---|
| `fanout_sprints` | dispatch -> sprint_body; drained -> supervisor |
| `plan_clarify_check` | clarify -> plan_clarify; ok -> plan_materialize |
| `research_route` | done -> research_collect; retry -> research_explore |
| `rework_route` | exhausted -> graceful_failure; rework -> sprint_body |
| `route_after_eval` | exhausted -> graceful_failure; partial -> synthesize; pass -> documenter; rework -> critique |
| `sprint_route` | exhausted -> sprint_exit; pass -> sprint_review; retry -> sprint_correct |
| `supervisor` | compact -> context_compact; evaluate -> gate_eval_in; plan -> gate_plan_in; sprints -> fanout_sprints |


### 5.5 Channels (10)

| channel | scope | reducerRef | schemaRef |
|---|---|---|---|
| `branchStatus` | private | lastWriteWinsByKey | BranchStatus |
| `counters` | public | maxNumber | Counters |
| `evaluations` | public | appendById | SprintVerdict |
| `ledger` | public | mergeLedger | BudgetLedger |
| `messages` | public | appendById | GraphMessage |
| `refs` | public | appendById | ScratchRef |
| `spec` | public | replaceIfNewer | PlanSpec |
| `sprintContracts` | public | appendById | SprintContract |
| `testAnchors` | public | setUnion | TestAnchors |
| `verdict` | public | replaceIfNewer | RunVerdict |

### 5.6 All 56 edges

<details>
<summary>Full edge table (expand)</summary>

| edge id | kind | from -> to | label | ports |
|---|---|---|---|---|
| `e-approval-commit` | normal | hitl_commit -> commit | — | — |
| `e-commit-finalize` | normal | commit -> finalize | — | — |
| `e-compact-supervisor` | normal | context_compact -> supervisor | — | — |
| `e-doc-approval` | normal | documenter -> hitl_commit | — | — |
| `e-eval-critiqued` | normal | critique -> rework_route | — | — |
| `e-eval-exhausted` | conditional | route_after_eval -> graceful_failure | exhausted | — |
| `e-eval-global` | normal | gate_eval_in -> evaluate_global | — | — |
| `e-eval-partial` | conditional | route_after_eval -> synthesize | partial | — |
| `e-eval-pass` | conditional | route_after_eval -> documenter | pass | — |
| `e-eval-rework` | conditional | route_after_eval -> critique | rework | — |
| `e-eval-route` | normal | evaluate_global -> route_after_eval | — | verdict->verdict |
| `e-eval-synthesized` | normal | synthesize -> documenter | — | — |
| `e-failure-end` | normal | graceful_failure -> END | — | — |
| `e-finalize-end` | normal | finalize -> END | — | — |
| `e-plan-check` | normal | plan_draft -> plan_clarify_check | — | draft->draft |
| `e-plan-clarified` | normal | plan_clarify -> plan_draft | — | — |
| `e-plan-clarify` | conditional | plan_clarify_check -> plan_clarify | clarify | — |
| `e-plan-draft` | normal | gate_plan_in -> plan_draft | — | brief->brief |
| `e-plan-exit` | normal | gate_plan_out -> supervisor | — | — |
| `e-plan-materialized` | normal | plan_materialize -> gate_plan_out | — | contracts->contracts |
| `e-plan-ok` | conditional | plan_clarify_check -> plan_materialize | ok | — |
| `e-research-collected` | normal | research_collect -> gate_research_out | — | digest->digest |
| `e-research-critique` | normal | research_explore -> research_critique | — | digest->digest |
| `e-research-done` | conditional | research_route -> research_collect | done | — |
| `e-research-entry` | normal | research_body -> gate_research_in | — | request->request |
| `e-research-exit` | normal | gate_research_out -> supervisor | — | — |
| `e-research-explore` | normal | research_reflect -> research_explore | — | digest->digest |
| `e-research-reflect` | normal | gate_research_in -> research_reflect | — | request->request |
| `e-research-retry` | conditional | research_route -> research_explore | retry | — |
| `e-research-route` | normal | research_critique -> research_route | — | digest->digest |
| `e-rework-dispatch` | fanout | rework_route -> sprint_body | rework | — |
| `e-rework-exhausted` | conditional | rework_route -> graceful_failure | exhausted | — |
| `e-sprint-anchor` | normal | sprint_evaluate -> gate_anchor_regression | — | verdict->verdict |
| `e-sprint-corrected` | normal | sprint_correct -> sprint_generate | — | — |
| `e-sprint-dispatch` | fanout | fanout_sprints -> sprint_body | dispatch | — |
| `e-sprint-drained` | conditional | fanout_sprints -> supervisor | drained | — |
| `e-sprint-entry` | normal | sprint_body -> gate_sprint_in | — | contract->contract |
| `e-sprint-evaluate` | normal | sprint_security -> sprint_evaluate | — | — |
| `e-sprint-exhausted` | conditional | sprint_route -> sprint_exit | exhausted | — |
| `e-sprint-exit` | normal | reduce_sprints -> supervisor | — | — |
| `e-sprint-explain` | normal | gate_sprint_in -> sprint_curate_explain | — | contract->contract |
| `e-sprint-generate` | normal | gate_mock_coverage -> sprint_generate | — | — |
| `e-sprint-mock-gate` | normal | sprint_curate_mocks -> gate_mock_coverage | — | — |
| `e-sprint-mocks` | normal | sprint_curate_explain -> sprint_curate_mocks | — | contract->contract |
| `e-sprint-pass` | conditional | sprint_route -> sprint_review | pass | — |
| `e-sprint-reduce` | normal | sprint_exit -> gate_sprint_out | — | — |
| `e-sprint-released` | normal | gate_sprint_out -> reduce_sprints | — | — |
| `e-sprint-retry` | conditional | sprint_route -> sprint_correct | retry | — |
| `e-sprint-reviewed` | normal | sprint_review -> sprint_exit | — | — |
| `e-sprint-route` | normal | gate_anchor_regression -> sprint_route | — | verdict->verdict |
| `e-sprint-security` | normal | gate_syntax -> sprint_security | — | — |
| `e-sprint-syntax` | normal | sprint_generate -> gate_syntax | — | — |
| `e-supervisor-compact` | conditional | supervisor -> context_compact | compact | — |
| `e-supervisor-evaluate` | conditional | supervisor -> gate_eval_in | evaluate | — |
| `e-supervisor-plan` | conditional | supervisor -> gate_plan_in | plan | — |
| `e-supervisor-sprints` | conditional | supervisor -> fanout_sprints | sprints | — |

</details>

The two `fanout` edges are `e-sprint-dispatch` (`fanout_sprints -> sprint_body`, label `dispatch`) and `e-rework-dispatch` (`rework_route -> sprint_body`, label `rework`). Two edges terminate at the reserved endpoint `END`: `e-failure-end` and `e-finalize-end`.

---
## 6. The golden dataset — where it lives and what a case realistically contains

### 6.1 Location is already reserved

`.gitignore:50-57` ignores `.bober/scratch|traces|cache|archive|logs/` under the header:

```gitignore
# PGE graph-runtime state (sprint 6) — written per run, never version-controlled.
# Only the topology and golden-case artifacts stay tracked; a 40-node run would
# otherwise commit its scratch payloads, per-node archives, spans and cache entries.
```

`.bober/golden/` is **not** ignored — the comment anticipates it. Directory does not exist yet (`ls .bober/` shows: anti-patterns, architecture, briefings, chat, contracts, designs, eval-results, evolve, graph, handoffs, incidents, medical, memory, onboarding, outlines, playbooks, replay, research, specs, topology).

**`tsconfig.json` has `rootDir: "src"`.** You cannot `import` a `.bober/golden/*.json` file from TypeScript (it is outside rootDir), even though `resolveJsonModule: true`. **Read cases at runtime with `readdir`/`readFile`.** sc-14-1 requires reading the directory anyway ("reads the directory rather than a hardcoded list" — `evaluatorNotes`).

### 6.2 What a case realistically contains — reuse the shipped recording format

`src/pge/runtime/replay.ts` already defines exactly the "pinned provider responses + expected artifacts" shape, and its header comment (`replay.ts:33-45`) already states the limitation nonGoal 5 requires you to document:

> *"WHAT A REPLAY REGRESSION-TESTS — The RUNTIME and the ARTIFACT SHAPE, and nothing else. … It says nothing whatsoever about whether those answers were any good — model output quality is not observable here and a replay that 'passed' a bad plan is working exactly as designed."*

Copy that sentence (attributed) into `docs/pge-graph.md`; it satisfies nonGoal 5 and `evaluatorNotes`' "verify the documentation states the golden dataset's limitation explicitly".

```ts
// src/pge/runtime/replay.ts:78-112
export const RECORDING_FORMAT_VERSION = 1;

export const RecordedCallSchema = z.object({
  nodeId: z.string().min(1),
  branchKey: z.string().nullable(),
  effectName: z.string().min(1),
  callIndex: z.number().int().min(0),
  request: z.unknown(),
  response: z.unknown(),
});
export type RecordedCall = z.infer<typeof RecordedCallSchema>;

export const RecordingBundleSchema = z.object({
  formatVersion: z.literal(RECORDING_FORMAT_VERSION),
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  branchKey: z.string().nullable(),
  calls: z.array(RecordedCallSchema),
});
export type RecordingBundle = z.infer<typeof RecordingBundleSchema>;
```

```ts
// src/pge/runtime/replay.ts:115-120
export function recordingKey(input: {
  nodeId: string; branchKey: string | null; callIndex: number;
}): string {
  return `${input.nodeId}@${input.branchKey ?? ""}#${String(input.callIndex)}`;
}
```

```ts
// src/pge/runtime/replay.ts:500-504 — the inputs a replayed run is GIVEN, deliberately not outputs
export const REPLAY_INPUT_PATHS = [
  join(".bober", "topology"),
  join(".bober", "prompts"),
] as const;
```

A realistic `GoldenCase` for `src/pge/golden/case-schema.ts`, all three parts named by sc-14-1:

| sc-14-1 part | Concrete content | Source of truth |
|---|---|---|
| **input** | `caseId`, `graphId` (`"coding"`), the run's feature request / seeded `.bober/` inputs, frozen `now`, fixed `runId`, `specId` | mirrors `ReplayInput` (`replay.ts:567-595`) |
| **pinned provider responses** | `calls: RecordedCall[]` keyed by `recordingKey` | `RecordedCallSchema` (`replay.ts:87`) — **reuse it, do not redeclare** |
| **expected artifacts** | per-`ConformanceArtifactName` normalised payloads, already stripped of `VOLATILE_KEYS` | `ConformanceArtifactName` / `ConformanceField` in `src/orchestrator/workflow/types.ts`; normalisation per §3 |

Other useful `replay.ts` exports: `MissingRecordingError` (`:136`), `createRecording(runId, calls)` (`:299`), `readRecording(...)` (`:321`), `createReplayEffectRegistry(...)` (`:368`), `createRefusingFetch()` (`:444`), `withNetworkDisabled(fn)` (`:466`), `createRefusingSandbox()` (`:481`), `prepareReplayRoot(recordedRoot, replayRoot)` (`:506`), `replayRecordedRun(input): Promise<ReplayOutcome>` (`:622`), `ReplayOutcome` (`:596`).

### 6.3 Threshold runner (sc-14-2)

The 79/80/81-vs-80 tri-point is a **pure arithmetic contract** — keep the pass-rate comparison in a tiny exported pure function (`passRate(passed, total)` + `meetsThreshold(rate, threshold)`) in `src/pge/golden/runner.ts` so `runner.test.ts` can drive all three points without executing 50 cases. `>=` vs `>` is the whole test: **79 → fail, 80 → fail, 81 → pass** means the comparison is strictly `rate > threshold`, NOT `>=`. Read sc-14-2 twice; getting this backwards inverts the middle case.

---

## 7. Where the CI job fits

`generatorNotes`: add the job to the existing `.github/workflows/ci.yml` **alongside** `build-and-test`, with `needs: build-and-test` so it runs on a built tree. Fetch the base artifact with `git show <base>:.bober/topology/coding.json` (works on forks and offline) — note `actions/checkout@v4` defaults to `fetch-depth: 1`, so you must set `fetch-depth: 0` (or explicitly `git fetch origin ${{ github.base_ref }}`) or `git show` will not resolve the base ref.

Six checks + the regression suite, each without `continue-on-error`:
1. `pge dump --check` — stale artifact
2. `pge validate --mode full` — invalid artifact
3. `pge docs …` — undocumented / phantom node (§1.4)
4. `pge diff <base> <head> --require-version-bump` — unversioned structural change
5. `pge audit-state` then `git diff --exit-code` — stale state audit
6. the golden regression runner behind the pass-rate threshold

Build output lives in `dist/` (`tsconfig.json` `outDir: "dist"`), so the invocation is `node dist/cli/index.js pge …`. The `pge` command is registered by `registerPgeCommand(program)` (`src/cli/commands/pge.ts:682`).

**Build/lint/typecheck reality check:**
- `npm run typecheck` = `tsc --noEmit` against `tsconfig.json`, which **excludes `**/*.test.ts`**. Test files are not typechecked there.
- `npm run typecheck:tests` = `tsc --noEmit -p tsconfig.test.json`, whose `include` is **`["src/seo/builder/**/*.ts"]` only**. It will NOT typecheck your new test files. Do not assume it guards you.
- `npm run lint` = `eslint src/` — it does **not** lint `.github/`, `docs/` or `.bober/`. `markdownlint-cli` is a devDependency but is wired into **no** npm script; `.markdownlint.json` disables `MD013` and `MD041`.
- `npm run test` = `vitest` (no `vitest.config.ts` in the repo; defaults apply, CI-detection makes it single-run).

---

## 8. The dormant `src/orchestrator/workflow/` subtree — production-caller evidence

18 modules. "Production caller" = imported from a non-`.test.ts` file. Verified with `grep -rn 'workflow/<m>.js' --include='*.ts' src/ scripts/ | grep -v '\.test\.ts:'` plus the in-subtree `./<m>.js` form.

| Module | Production caller(s) outside `workflow/` | In-subtree importer(s) | Verdict |
|---|---|---|---|
| `budget.ts` | `orchestrator/security-auditor-agent.ts:12`, `orchestrator/generator-agent.ts:10`, `orchestrator/security-verifier-agent.ts:9`, `orchestrator/agentic-loop.ts:13`, `pge/runtime/ledger.ts:1,44` | — | **LIVE** — nonGoal-protected |
| `scheduler.ts` | `fleet/coordinator.ts:3`, `orchestrator/architect-agent.ts:14`, `orchestrator/evaluator-agent.ts:22`, `pge/runtime/interpreter.ts:7`, `pge/engine/pge-engine.ts:12`, 3 pge fixtures | `workflow/interpreter.ts:23` | **LIVE** — `Scheduler`, `mapBounded` |
| `reconciler.ts` | `orchestrator/evaluator-agent.ts:21`, `orchestrator/architect-agent.ts:13` | `workflow/pure-sprint.ts:23` | **LIVE** |
| `synthesizer.ts` | `orchestrator/architect-agent.ts:11`, `pge/runtime/graceful-failure.ts:5` | — | **LIVE** |
| `retry.ts` | `pge/runtime/retry-planner.ts:1,2` | — | **LIVE** |
| `conformance.ts` | `pge/runtime/replay.ts:10` | — | **LIVE** |
| `engine.ts` | `config/schema.ts:6` (`PIPELINE_ENGINE_NAMES`), `mcp/run-manager.ts:16`, `medical/engine.ts:22`, `teams/types.ts:9`, `orchestrator/worktree.ts:16`, `pge/runtime/replay.ts:11`, `pge/engine/pge-engine.ts:11` | 6 in-subtree | **LIVE** — load-bearing enum |
| `ts-engine.ts` | `pge/engine/pge-engine.ts:13` | `workflow/selector.ts:5`, `workflow/workflow-engine.ts:11` | **LIVE — the oracle, must never be removed** |
| `selector.ts` | `teams/registry.ts:11`, `orchestrator/pipeline.ts:1061` | — | **LIVE** — the composition root |
| `types.ts` | `pge/runtime/replay.ts:16` | 6 in-subtree | **LIVE** |
| `workflow-engine.ts` | *none directly* | `workflow/selector.ts:6` | **reachable in production via `selector.ts`** — `selectPipelineEngine`/`selectPipelineEngineForTeam` construct `new WorkflowEngine()` (`selector.ts:69,135`), and `pipeline.ts:1061` calls the latter |
| `eligibility.ts` | — | `workflow/selector.ts:4`, `workflow/workflow-engine.ts:7` | reachable — `resolveEngineName` calls `isWorkflowEligible` (`selector.ts:34`) |
| `args-builder.ts` | — | `workflow/workflow-engine.ts:9` | reachable only through `WorkflowEngine` |
| `flusher.ts` | — | `workflow/workflow-engine.ts:10` | reachable only through `WorkflowEngine` |
| `resume-cursor.ts` | — | `workflow/workflow-engine.ts:8` | reachable only through `WorkflowEngine` |
| `errors.ts` | — | `workflow/args-builder.ts:4`, `workflow/workflow-engine.ts:12` | reachable only through `WorkflowEngine` |
| **`interpreter.ts`** | **NONE** | **NONE** | **TRULY DORMANT** — the only importer anywhere is `workflow/interpreter.test.ts:15` |
| **`pure-sprint.ts`** | **NONE** | `workflow/interpreter.ts:24` (types only) | **TRULY DORMANT** — reachable only from the dormant interpreter |

The dormancy is self-documented at `src/orchestrator/workflow/interpreter.ts:1-2`: *"Workflow interpreter — the live body of the (currently dormant) WorkflowEngine invoke() seam."*

**So the disposition's evidence is:** exactly **two** modules (`interpreter.ts`, `pure-sprint.ts`) are genuinely dormant; the other sixteen have a production caller or are reachable through `selector.ts`, and eight of them are named in nonGoal 2 as permanently retained. Deleting the two dormant ones would delete `interpreter.test.ts` and `pure-sprint.test.ts`, which nonGoal 3 forbids *unless their assertions are first proven green on the graph runtime*. **Recommended disposition: RETAIN both, with the criterion for future retirement written down** — that costs nothing, deletes no test, and is defensible. If you propose deletion you owe a per-assertion mapping to a green PGE-runtime counterpart, and the sprint's stopCondition #5 fires the moment one is missing.

Also relevant to the disposition: `src/orchestrator/workflow/script-helpers.test.ts:1-14` tests exported helpers of `.claude/workflows/bober-pipeline.js` — a **cross-boundary** test outside `src/`. Do not disturb it.

---

## 9. `bober sprint` vs `bober_sprint` vs the full cycle — precisely how each diverges

**Entry point A — CLI `bober sprint`:** registered at `src/cli/index.ts:170-187`:

```ts
  program
    .command("sprint")
    .description("Run the next sprint")
    .option("--continue", "Continue to subsequent sprints after completion")
    .option("--provider <name>", "Override AI provider for all roles (...)")
    .action(async (cmdOpts: { continue?: boolean; provider?: string }) => {
      ...
      await runSprintCommand(projectRoot, { verbose, continue, provider });
    });
```
Body: `src/cli/commands/sprint.ts:73` `runSprintCommand` (341 lines). Its **only** agent invocations are `runGenerator` (`sprint.ts:210`) and `runEvaluatorAgent` (`sprint.ts:277`) — see imports at `sprint.ts:11-12`. It also does `commitAll` (`sprint.ts:20` import) and `updateContractStatus`.

**Entry point B — MCP `bober_sprint`:** `src/mcp/tools/sprint.ts:65-85` (`registerSprintTool`, 315 lines). Same two agents: `runGenerator` (`sprint.ts:18` import), `runEvaluatorAgent` (`:19` import). Advertised in the tool catalogue at `src/mcp/tools/index.ts:47` as *"Execute the next sprint cycle"*. Selects work with `findNextPendingSprint` over `PENDING_STATUSES = {proposed, negotiating, agreed, needs-rework}` (`mcp/tools/sprint.ts:32-41`).

**The full cycle — `src/orchestrator/pipeline.ts` (1093 lines):** additionally runs, in the sprint loop alone:
- `runCurator` → the briefing (`pipeline.ts:238`), behind checkpoint `pre-curator` (`:222-225`)
- checkpoint `pre-generator` (`:349-352`) before `runGenerator` (`:364`)
- checkpoint `pre-evaluator` (`:420-423`) before `runEvaluatorAgent` (`:453`)
- `persistEvalResult` (`:463`)
- checkpoint `pre-code-reviewer` (`:592-595`) then `runCodeReviewer` (`:600`)
- `runDocumenter` (`:639`)
- checkpoint `post-sprint` (`:673-676`)
- `createHandoff` + compaction (`:313`)
and outside the loop: `runResearch` (`:816`), `runArchitect` (`:851`), `runPlanner` (`:889`), checkpoints `post-research` (`:834`), `post-plan` (`:977`), `post-sprint-contract` (`:990`), and the end-of-pipeline finalize block (`:1042`). Every checkpoint goes through `runWithAudit` (`pipeline.ts:53`) with mechanism defaulting to `"noop"` (`:186-188`, `:759-761`). Engine selection happens at `pipeline.ts:1061` via `selectPipelineEngineForTeam`.

**Divergence, stated for the disposition (three bullets, verbatim-usable):**
1. Both `bober sprint` and `bober_sprint` run **generator → evaluator only**. Neither runs the curator, the code reviewer, the documenter, the security auditor, or any checkpoint. Both bypass `runWithAudit` entirely, so **no `ApprovalRecord` is written for either**.
2. Neither is routed through `selectPipelineEngine*`, so **neither is affected by `config.pipeline.engine`** — they cannot run on PGE even when the config asks for it. They are *engine-blind* by construction.
3. `bober sprint` additionally refuses to run against a spec in `needs-clarification` (`cli/commands/sprint.ts:105-125`) and scopes contracts to the latest spec; `bober_sprint` scopes only by pending status.

nonGoal 6 forbids re-pointing them here. **Record them as a deliberate, documented escape hatch** with those three divergences named.

---

## 10. sc-14-9 — the retained-oracle assertions, and where the evidence already lives

```ts
// src/config/schema.ts:365
  engine: z.enum([...PIPELINE_ENGINE_NAMES]).default("ts"),
```
```ts
// src/orchestrator/workflow/engine.ts:23-29
export const PIPELINE_ENGINE_NAMES = [
  "ts", "skill", "workflow", "medical-sop", "pge",
] as const;
```
```ts
// src/orchestrator/workflow/selector.ts:58-82  — TsPipelineEngine is the default AND the fallback
export function selectPipelineEngine(config: BoberConfig): PipelineEngine {
  const name = resolveEngineName(config);
  switch (name) {
    case "ts": return new TsPipelineEngine();
    case "skill": return new TsPipelineEngine();
    case "workflow": return new WorkflowEngine();
    case "medical-sop": return new TsPipelineEngine();
    case "pge": return new PgeEngine();
  }
}
```

Sprint 13's pins live in `src/orchestrator/workflow/conformance.engines.test.ts` — **do not modify it**, cite it:
- `:209-211` — all 11 `CONFORMANCE_FIELDS` present, `report.vacuous === false`
- `:302-308` — the four divergent fields, then `expect(report.equivalent).toBe(false)`
- `:381-383` — `expect(refusal?.feedbackText).toContain("FAIL_CLOSED")`, `.toContain('node "commit"')`, `.toContain("was not executed")`
- `:389-390` — **both** engines report `success: true` despite that refusal
- `:397-398` — `ts` contract `"passed"` vs `pge` contract `"completed"`
- `:416-418` — `ts` completedSprints `["passed"]` vs `pge` `["proposed"]`

Your sc-14-9 test should assert the *default* and the *constructibility* independently of that file (parse an empty config through the schema; construct `new TsPipelineEngine()`), and assert that `conformance.engines.test.ts` still exists and still names `TsPipelineEngine` — i.e. the oracle is provably still exercised. Do not duplicate the engine run; it is expensive and already pinned.

---

## 11. Testing patterns

### 11.1 Unit test template — `src/cli/commands/pge.test.ts`

**Runner:** Vitest 3 (`package.json:115`). **Assertions:** `expect`. **Mocks:** `vi.mock` (hoisted) — see `conformance.engines.test.ts:34-54`. **Naming:** `*.test.ts` collocated next to the source (`.bober/principles.md`, "Quality Standards"). **Filesystem:** real temp dirs, never mocked fs (principles, "Avoid": *"No test mocks for filesystem"*).

```ts
// src/cli/commands/pge.test.ts:46-64
const FIXTURE_DIR = fileURLToPath(new URL("../../pge/topology/__fixtures__/", import.meta.url));

let root = "";
let out: string[] = [];
let err: string[] = [];
let io: PgeIo;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-cli-"));
  out = []; err = [];
  io = { out: (line) => out.push(line), err: (line) => err.push(line) };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
```

```ts
// src/cli/commands/pge.test.ts:607-643 — the three helpers every new gate test needs
async function writeArtifact(name: string, spec: TopologySpec): Promise<string> {
  const path = join(root, `${name}.json`);
  await writeFile(path, serializeTopology(spec), "utf8");
  return path;
}

function reseal(spec: TopologySpec): TopologySpec {
  return { ...spec, checksum: checksumTopology(spec) };
}

/** A version strictly ahead of the shipped graph's, DERIVED rather than written out. */
function bumpedVersion(from: string = CODING_GRAPH.graphVersion): string {
  const [major, minor] = from.split(".").map((part) => Number.parseInt(part, 10));
  return `${major}.${minor + 1}.0`;
}

function extraGate(id: string): NodeSpec { /* :627-642 — a valid gate node for fixtures */ }
```
Plus `clone(spec)` at `pge.test.ts:87-89` (`TopologySpecSchema.parse(JSON.parse(JSON.stringify(spec)))`).

### 11.2 The negative-control pattern already in the repo

```ts
// src/cli/commands/pge.test.ts:162-186 (abridged) — mutate a TEMP copy, assert non-zero, assert NO repair
  it("exits non-zero after a single-character mutation and does not repair the file", async () => {
    const path = topologyArtifactPath(root, "coding");
    const original = await readFile(path, "utf8");
    const marker = '"graphId": "coding"';
    const at = original.indexOf(marker);
    const target = at + marker.length - 2;
    const mutated = `${original.slice(0, target)}G${original.slice(target + 1)}`;
    ...
    const code = await runPgeDump(root, { check: true }, io);
    // expects EXIT_FAILED and that the file on disk is STILL the mutated bytes
  });
```

This is the shape every gate you add must have (HARD RULE 7). Note it operates on `root` — a `mkdtemp` copy — never on the committed `.bober/topology/coding.json`.

```ts
// src/cli/commands/pge.test.ts:841-852 — the doc-drift negative control that already exists
  it("fails and names an undocumented node", async () => {
    await runPgeDump(root, {}, io);
    const doc = join(root, "pge-graph.md");
    await writeFile(doc, docFor(CODING_GRAPH.nodes.map((n) => n.id).filter((id) => id !== "supervisor")), "utf8");
    expect(await runPgeDocs(root, { doc }, io)).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain('node "supervisor" is declared in the topology');
  });
```

sc-14-7's *"adding a node to a fixture artifact without documenting it fails the test"* is the mirror image — use `extraGate("extra_gate")` + `reseal` on a cloned spec, dump into `root`, and point `runPgeDocs` at the REAL `docs/pge-graph.md` (which will not mention `extra_gate`), asserting `EXIT_FAILED`.

### 11.3 Fixtures available

`src/pge/topology/__fixtures__/` holds 32 named-diagnostic artifacts (`UnknownPromptRef.json`, `UndocumentedNode.json`, `ChecksumStale.json`, …) plus `valid.json`, `coding.mermaid`, `coding.dot`. `FULL_MODE_CODES = new Set(["UnknownPromptRef","UnknownSchemaRef"])` (`pge.test.ts:49`) — those two fire only under `mode: "full"`. **`UnknownPromptRef.json` is your ready-made sc-14-6 base fixture**: a topology naming a promptRef nothing resolves, which structural-mode diff must tolerate silently.

### 11.4 No E2E/Playwright

There is no `playwright.config.ts` and no `e2e/` at the repo root; `tests/e2e/four-modes.test.ts` is referenced from `.github/workflows/ci.yml:23` and runs under Vitest. No browser tooling applies to this sprint.

---

## 12. Impact analysis

### Files that may break

| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/cli/commands/pge.test.ts` | `src/cli/commands/pge.ts` — imports 9 symbols (`pge.test.ts:21-36`) | **high** | Changing `docs <doc>` → `docs [doc]` or `PgeDocsOptions.doc` from required to optional breaks `describe("registerPgeCommand")` at `:1019` and the four `describe("bober pge docs")` cases at `:828-869`. Read both before editing. |
| `src/pge/runtime/replay.ts` | `conformance.ts` (`:10`), `workflow/types.ts` (`:16`), `workflow/engine.ts` (`:11`) | **medium** | Exporting `normalize` is additive, but re-ordering/renaming anything in `conformance.ts` breaks replay and `replay.test.ts`. |
| `src/config/schema.ts:6,365` | `workflow/engine.ts` `PIPELINE_ENGINE_NAMES` | **high** | Never touch the `.default("ts")`. HARD RULE 2. |
| `src/orchestrator/pipeline.ts:1061`, `src/teams/registry.ts:11` | `workflow/selector.ts` | **high** | Any change to `selector.ts` changes live engine selection. Out of scope for this sprint — do not touch it. |
| `src/pge/engine/pge-engine.ts:11-13` | `workflow/engine.ts`, `scheduler.ts`, `ts-engine.ts` | **high** | These are the nonGoal-2 permanently-retained modules. |
| `docs/pge-graph.md` (new) | `.bober/topology/coding.json` | **high** | Every future topology change now needs a matching doc edit or CI goes red. Say so in the doc's own preamble. |
| `.github/workflows/ci.yml` | — | **medium** | `build-and-test` must keep its five steps; only ADD a job. |

### Existing tests that must still pass

- `src/cli/commands/pge.test.ts` — the whole CLI verb surface (12 describes); most affected by any `docs` registration change.
- `src/pge/topology/docs.test.ts` — 18 cases pinning marker/code-span behaviour (`:56,111,145,167`). If you change `docs.ts` at all, these break. **Do not change `docs.ts`.**
- `src/pge/topology/diff.test.ts`, `dump.test.ts`, `validate.test.ts`, `audit.test.ts`, `canonical.test.ts`, `render.test.ts`, `optimize.test.ts`, `coding.graph.test.ts` — the topology layer.
- `src/pge/topology-invariants.test.ts`, `src/pge/zero-execution.test.ts`, `src/pge/eslint-boundary.test.ts`, `src/pge/lint-boundary.test.ts` — the ADR-2 boundary guards. A new `src/pge/golden/` module that imports the orchestrator is legal (the boundary fileset is `src/pge/topology/**` + `src/contracts/topology.ts`, `eslint.config.js:116`) — but **run these four before you believe that**.
- `src/orchestrator/workflow/conformance.engines.test.ts`, `conformance.test.ts` — the sprint-13 pins.
- `src/pge/runtime/replay.test.ts` — consumes `conformance.ts`.
- `src/orchestrator/workflow/interpreter.test.ts`, `pure-sprint.test.ts` — the two dormant modules' tests. **They must survive the disposition.**
- `src/orchestrator/repo-invariants.test.ts` — repo-shape assertions; a new top-level file can trip it. Check it.
- `src/discovery/scanner.test.ts:204` — comments that "agent-bober has no .github/workflows"; the assertion itself uses a tmpDir, so it should be unaffected, but verify.

### Regression checks the Generator MUST run

1. `npx vitest run src/cli/commands/pge.test.ts src/pge/topology/ src/pge/golden/` — your own scope.
2. `npx vitest run src/pge/zero-execution.test.ts src/pge/eslint-boundary.test.ts src/pge/lint-boundary.test.ts src/pge/topology-invariants.test.ts` — the boundary guards, if you added `src/pge/golden/`.
3. `npx vitest run src/orchestrator/workflow/` — only if you exported anything from `conformance.ts`.
4. `npm run typecheck && npm run build && npm run lint` — sc-14-11.
5. `git status --porcelain .bober/topology/` must be **empty** — HARD RULE 5; running `pge audit-state` or `pge dump` without `--check` against the repo root rewrites tracked files.
6. Negative controls (HARD RULE 7), each asserting a NON-ZERO exit on a temp copy: stale artifact; undocumented node; unversioned structural change; stale state audit; `continue-on-error` injected into the job text; regression rate below threshold.
7. Do **not** run `npm run test` (full suite) — HARD RULE 8, other agents are editing concurrently.

---

## 13. Implementation sequence

1. **`src/orchestrator/workflow/conformance.ts`** — add `export` to `normalize` (and `VOLATILE_KEYS` / `canonical` if needed). Nothing else. *Verify:* `npx vitest run src/orchestrator/workflow/conformance.test.ts src/pge/runtime/replay.test.ts`.
2. **`src/pge/golden/case-schema.ts`** — `GoldenCaseSchema` reusing `RecordedCallSchema` (`replay.ts:87`) and the now-exported normaliser. *Verify:* `npm run typecheck`.
3. **`.bober/golden/*.json`** — 20–50 cases (low end is explicitly sanctioned by `assumptions[0]`, provided you write the growth plan into `docs/pge-graph.md`). *Verify:* each parses through `GoldenCaseSchema`.
4. **`src/pge/golden/runner.ts`** — pure `passRate` / `meetsThreshold` plus the case-driving runner. *Verify:* `runner.test.ts` drives 79/80/81 vs 80 → fail/fail/pass.
5. **`src/pge/golden/case-schema.test.ts` + `dataset.test.ts`** — sc-14-1: `readdir('.bober/golden')`, count in `[20,50]`, every file validates.
6. **`src/cli/commands/pge.ts`** — the `docs --check` reconciliation from §1.4, if you choose option A. *Verify:* `npx vitest run src/cli/commands/pge.test.ts`.
7. **`docs/pge-graph.md`** — the document: §5's inventory, gates, loops, changelog section (`assumptions[2]`: the changelog lives here, not in a separate file), the golden-dataset limitation (nonGoal 5), and the disposition (§8/§9/§10). *Verify:* `runPgeDocs(repoRoot, { doc: "docs/pge-graph.md" }, io) === EXIT_OK` — the backtick trap in §2.1 is what you will get wrong first.
8. **`src/pge/topology/docs.test.ts`** — sc-14-7 and sc-14-8 against the real `docs/pge-graph.md`, cross-checking `node.gate.{check,onFail}`, `node.inputPorts[].schemaRef` and `node.loop.{counterKey,maxIterations,onExhausted}` derived from the artifact.
9. **`.github/workflows/ci.yml`** — the blocking job, `needs: build-and-test`, `fetch-depth: 0`, six checks, no `continue-on-error`.
10. **`src/cli/commands/pge.test.ts`** (or a new workflow test) — sc-14-3/sc-14-4 parse the real ci.yml; sc-14-5/sc-14-6 drive both diff branches.
11. **Full verification** — `npm run typecheck`, `npm run typecheck:tests`, `npm run build`, `npm run lint`, then your scoped vitest runs.

---

## 14. Pitfalls

- **The backtick trap (§2.1).** The single most likely failure. `` `SprintVerdict` `` inside a `pge:nodes` region = a phantom node = red CI.
- **`docs.ts` is shipped and pinned by 21 tests.** Supply the document and wire the check. Do not touch the checker.
- **Loop bounds are on nodes.** A drift test over `spec.edges` asserts nothing.
- **`sprintIterations` is shared by two nodes.** counterKey → node is 1:N.
- **`tsconfig.test.json` includes only `src/seo/builder/**`.** `npm run typecheck:tests` will not catch type errors in your new tests. Rely on `vitest run`.
- **`rootDir: "src"`** — you cannot `import` `.bober/golden/*.json`. Read it at runtime.
- **`js-yaml` is a phantom dependency.** Present in `node_modules` only via `markdownlint-cli`. Declare it or hand-roll (§4.2).
- **`actions/checkout@v4` defaults to `fetch-depth: 1`.** `git show <base>:…` will fail without `fetch-depth: 0`.
- **`pge audit-state` and `pge dump` WRITE by default.** Only the `--check` form is read-only. Running the write form from the repo root mutates tracked artifacts — HARD RULE 5.
- **`pge diff` exits 0 on any diff unless `--require-version-bump` is set.** A CI step that omits the flag is decorative.
- **A downgrade is not a bump** (`diff.ts:231-240`) — `1.2.0 -> 1.1.0` fails the gate. Use the derived `bumpedVersion()` helper, never a literal.
- **`npm run lint` is `eslint src/` only.** Nothing lints your YAML or Markdown; the workflow-parsing test is the only guard.
- **Do not add `continue-on-error`** anywhere, and do not copy `kpi-gate`'s shape — nonGoal 1 names it explicitly.
- **Never edit `.bober/topology/coding.json` or `state-audit.json`.** Every fixture mutation goes onto a `mkdtemp` copy.
- **`sprint_correct` is `kind: "llm"`, not `"gate"`, yet carries a loop.** Filtering by `kind === "gate"` to find loops finds 2 of 8.
- **Five gates have empty `inputPorts`.** "No schemaRef" is data, not a gap.

---

## 15. Documentation consulted

- `.bober/principles.md` — ESM with `.js` extensions; Zod for validation; filesystem state under `.bober/`; unicode box-drawing section headers (`// ── Section ──`); collocated `*.test.ts`; `import type`; no sync fs; no fs mocks in tests; `_` prefix for unused params.
- `.bober/architecture/arch-20260805-pge-graph-engineering-adr-{1..8}.md` and `…-architecture.md` — present; ADR-2 (module-graph boundary / zero execution during validation) is the one this sprint can violate, and it is enforced by `eslint.config.js:114-180`, not by review.
- `.github/workflows/ci.yml`, `package.json`, `tsconfig.json`, `tsconfig.test.json`, `.gitignore`, `.markdownlint.json` — all read; findings in §4, §7, §6.1.
- No `CONTRIBUTING.md` and no `vitest.config.ts` in the repo.
