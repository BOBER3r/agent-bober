# Sprint Briefing: One settled-status predicate, and the MCP sprint tools work again

**Contract:** sprint-spec-20260812-terminal-vocabulary-1
**Generated:** 2026-08-12T00:00:00Z
**Curator note:** every file:line below was opened and verified against the working tree at the time of writing.

---

## 0. READ THIS FIRST — three findings that change the shape of the sprint

### 0.1 The two sites you are told to "generalise" do NOT mean the same thing

| Site | Word set | Semantics |
|---|---|---|
| `src/contracts/sprint-contract.ts:216-219` | `passed` \| `failed` \| `completed` | **terminal** — the sprint stopped, success or not |
| `src/orchestrator/workflow/resume-cursor.ts:22` | `passed` \| `completed` | **settled successfully** — a sprint you do not need to redo |

All five named readers use the *second* meaning, not the first:
- `mcp/tools/sprint.ts:147` and `mcp/tools/eval.ts:139` build `completedContracts`, fed to `createHandoff({ sprintHistory })` — the *successful* history.
- `cli/commands/sprint.ts:160` and `cli/commands/eval.ts:127` do the same.
- `state/history.ts:193` counts `Passed` **and `:194` separately counts `Failed`** — folding `failed` into `:193` would double-count every failed sprint in `.bober/progress.md`.

**Recommendation:** export **two** predicates from `src/contracts/sprint-contract.ts`, next to `ContractStatusSchema`, sharing one status set so a third word cannot diverge — e.g. `isSettledContractStatus` (succeeded: `passed` \| `completed`, used by the five readers + resume-cursor) and `isTerminalContractStatus` (adds `failed`, used by `updateContractStatus`). sc-1-1 says "a single exported predicate decides whether a status is terminal" — that is satisfied by the terminal one; the settled one is the generalisation of `resume-cursor.ts:22`. If you ship only one predicate, `history.ts:193` will be wrong. Say in the sprint notes which reading you took.

### 0.2 The contract's path for the "leave alone" playwright site is WRONG

The contract/orchestrator says `src/eval/strategies/playwright.ts:530`. **That path does not exist.** The real site is `src/evaluators/builtin/playwright.ts:530`. Do not create the phantom path.

### 0.3 Real corpus numbers (measured, not recalled)

`.bober/contracts/*.json` — **256 files**. Raw `status` field on disk:

| status | count |
|---|---|
| `completed` | 218 |
| `proposed` | 33 |
| `pending` (illegal — not in `ContractStatusSchema`) | 4 |
| `in-progress` | 1 |
| **`passed`** | **0** |

But `listContracts` (`src/state/sprint-state.ts:113-147`) **silently drops every schema-invalid file** (`safeParse` at `:137`, `if (result.success)` at `:138`). Measured by running the built `dist/state/sprint-state.js` against this repo root:

```
listContracts total: 196
{ "completed": 178, "proposed": 17, "in-progress": 1 }
```

**60 of 256 files fail `SprintContractSchema`** (the 4 `pending` ones plus 56 more). So the number sc-1-3 must assert against a settled predicate is **178**, not 218 and not 250. Derive it in the test from `listContracts` rather than hardcoding — but assert `> 0` at minimum, and prefer an exact count so a silent drop is visible.

---

## 1. Target Files

### src/contracts/sprint-contract.ts (modify) — 296 lines

**The enum, lines 38-49 — nonGoal says do NOT change its membership:**
```ts
export const ContractStatusSchema = z.enum([
  "proposed",
  "negotiating",
  "agreed",
  "in-progress",
  "evaluating",
  "passed",
  "failed",
  "needs-rework",
  "completed",
]);
export type ContractStatus = z.infer<typeof ContractStatusSchema>;
```

**The rule to generalise, lines 200-226:**
```ts
/**
 * Return a new contract with an updated status.
 * Automatically sets `startedAt` when moving to "in-progress"
 * and `completedAt` when moving to a terminal status.
 */
export function updateContractStatus(
  contract: SprintContract,
  status: ContractStatus,
): SprintContract {
  const now = new Date().toISOString();
  const updates: Partial<SprintContract> = { status, updatedAt: now };

  if (status === "in-progress" && !contract.startedAt) {
    updates.startedAt = now;
  }

  if (
    (status === "passed" ||
      status === "failed" ||
      status === "completed") &&
    !contract.completedAt
  ) {
    updates.completedAt = now;
  }

  return { ...contract, ...updates };
}
```

**Section header convention in this file** (principles.md requires it): `// ── Enums ───────────────────────────────────────────────────────────`, `// ── Helpers ─────────────────────────────────────────────────────────`, `// ── Quality gate ────────────────────────────────────────────────────`. Put the predicate under a new `// ── Terminal status ─────` header directly after the `ContractStatusSchema` block at line 49, per generatorNotes ("next to ContractStatusSchema").

**Test file:** `src/contracts/sprint-contract.test.ts` — **exists**, 296-line source has a matching describe block at `:159-183`.

**Public API:** `src/index.ts:21-35` re-exports this module's surface. New exported symbols belong there:
```ts
export {
  type SprintContract,
  type SuccessCriterion,
  type ContractStatus,
  ...
  createContract,
  updateContractStatus,
  findPrecisionIssues,
  isContractPrecise,
} from "./contracts/sprint-contract.js";
```

---

### src/mcp/tools/sprint.ts (modify) — line 147

```ts
        const completedContracts = contracts.filter((c) => c.status === "passed");
```
Feeds `createHandoff({ ..., sprintHistory: completedContracts })` at `:174`. Existing imports at `:11-12`:
```ts
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { updateContractStatus } from "../../contracts/sprint-contract.js";
```
**Do NOT touch `:255`** — `updateContractStatus(currentContract, "passed")` is a **writer** (nonGoal 1: writers are sprints 3 and 5).
**Do NOT touch `:32-37`** — `PENDING_STATUSES` is the *non*-terminal set, a different concern:
```ts
const PENDING_STATUSES = new Set([
  "proposed",
  "negotiating",
  "agreed",
  "needs-rework",
]);
```
**Test file:** no `src/mcp/tools/sprint.test.ts`. The only coverage is `src/mcp/tools/tools.test.ts` (registration count = 37, names list).

---

### src/mcp/tools/eval.ts (modify) — line 139

```ts
      const completedContracts = contracts.filter((c) => c.status === "passed");
```
**Do NOT touch `:98-103`** — the active-sprint selector, not a terminal check:
```ts
        targetContract = contracts.find(
          (c) =>
            c.status === "in-progress" ||
            c.status === "evaluating" ||
            c.status === "needs-rework",
        );
```
**Test file:** none.

---

### src/cli/commands/sprint.ts (modify) — lines 159-161

```ts
    const completedContracts = contracts.filter(
      (c) => c.status === "passed",
    );
```
**Do NOT touch `:35-48`** (`findNextPendingSprint`, the pending set) or `:285` (`updateContractStatus(currentContract, "passed")` — writer).
**Test file:** `src/cli/commands/sprint.test.ts` — **exists**.

---

### src/cli/commands/eval.ts (modify) — lines 126-128

```ts
  const completedContracts = contracts.filter(
    (c) => c.status === "passed",
  );
```
**Do NOT touch `:87-90`** — the same active-sprint selector as `mcp/tools/eval.ts:98-103`.
**Test file:** none.

---

### src/state/history.ts (modify) — lines 193-202

```ts
    const passed = contracts.filter((c) => c.status === "passed").length;
    const failed = contracts.filter((c) => c.status === "failed").length;
    const inProgress = contracts.filter(
      (c) => c.status === "in-progress" || c.status === "evaluating",
    ).length;
    const pending = contracts.filter(
      (c) =>
        c.status === "proposed" ||
        c.status === "negotiating" ||
        c.status === "agreed",
    ).length;
```
`:209` renders `| Passed | ${passed} |` into `.bober/progress.md`. `:194` (`failed`), `:195-197` (`inProgress`), `:198-202` (`pending`) are **not** terminal checks — leave them. Also leave `getStatusIcon` at `:250-263` (a display `switch`, and its `case "completed"` falls through to `[PENDING]` today — a separate cosmetic bug, out of scope).

**Test file:** no `src/state/history.test.ts`. `updateProgress` is exercised by `src/orchestrator/workflow/flusher.test.ts`, `conformance.test.ts`, `conformance.engines.test.ts`.

---

### src/orchestrator/workflow/resume-cursor.ts (modify) — 33 lines, line 22

```ts
    const completed = contracts
      .filter((c) => c.status === "passed" || c.status === "completed")
      .map((c) => c.sprintNumber);
```
generatorNotes: "it is the shape to generalise, and it should end up calling the predicate too."
**Test file:** `src/orchestrator/workflow/resume-cursor.test.ts` — **exists**, and `:76` asserts exactly this behaviour with a mixed fixture (`passed`, `completed`, `in-progress`, `failed` → `[1, 2]`). That test must still pass unchanged.

---

## 2. Sites that MUST be left alone (quote them so you can prove you did not touch them)

| Site | Code | Why it is not a contract-terminal check |
|---|---|---|
| `src/mcp/tools/status.ts:69` | `if (state.status === "completed") {` | `state` is `RunState` (`src/mcp/run-manager.ts:39`: `"running" \| "completed" \| "failed" \| "aborted" \| "input-required" \| "paused"`) |
| `src/evaluators/builtin/playwright.ts:530` | `const passed = allTests.filter((t) => t.status === "passed").length;` | `FlatTest.status` (`:16`, `:149`) is a Playwright **test result**: `"passed" \| "failed" \| "timedOut" \| "skipped" \| "interrupted"` |
| `src/fleet/reporter.ts:46` | `if (o.status === "completed") {` | `ChildOutcome.status` is `ChildStatus` (`src/fleet/types.ts:16`: `"completed" \| "failed" \| "other"`) |
| `src/fleet/aggregator.ts:8` | `if (s === "completed") return "completed";` | signature is `mapStatus(s: RunState["status"]): ChildStatus` (`:7`) |
| `src/do-bridge/reconcile.ts:70-71` | `if (state.status === "completed") { const updatedRef: PromotionRef = { ...ref, status: "completed" };` | `state` comes from `readState(ref.runId)` — a run state; `PromotionRef.status` is `"launched" \| "completed" \| "aborted"` (`src/do-bridge/types.ts:48`) |

---

## 3. The sc-1-4 scan WILL find more than five — decide, in writing, about each

These are genuine `SprintContract.status` comparisons in production code that are **not** in the five named readers. A naive "no status literal outside the predicate" scan fails on all of them. Either migrate them or allowlist them **with a stated reason** (stopCondition: "leave it and say so").

| Site | Code | Note |
|---|---|---|
| `src/orchestrator/pipeline.ts:1052` | `if (result.contract.status === "passed") {` | reader — splits completed/failed sprints for the TS pipeline. Strong candidate for the predicate, but it is **not** in `estimatedFiles`. |
| `src/orchestrator/workflow/flusher.ts:76` | `if (contractStatus === "passed") {` | reads a **local** it just computed at `:61-66`, not a contract off disk. Writer-adjacent. |
| `src/pge/runtime/interpreter.ts:728` | `const passed = state.sprintContracts.filter((c) => c.status === "passed").length;` | verdict computation over the channel |
| `src/pge/runtime/commit.ts:531` | `c.status === "passed" \|\| succeededBranches.has(c.contractId);` | has a 20-line header at `:502-522` explaining exactly why it cannot use the contract status alone. Read it before touching. |
| `src/pge/nodes/sprint-curate.ts:254` | `(entry) => entry.status === "completed" && entry.contractId !== contract.contractId` | successful-history filter — same semantics as the five |
| `src/pge/nodes/sprint-generate.ts:133` | `(entry) => entry.contractId !== contract.contractId && entry.status === "completed"` | same |
| `src/pge/nodes/documenter.ts:83` | `return status?.state === "succeeded" \|\| contract.status === "completed";` | same |
| `src/pge/nodes/sprint-review.ts:203` | `status: outcome.settled === "succeeded" ? "completed" : "failed",` | **WRITER** — nonGoal 1 forbids touching it in this sprint |

`src/pge/runtime/__fixtures__/golden-graph.ts:878,925` and `src/pge/compile/__fixtures__/fixture-graph.ts:66` are fixtures — the existing scan pattern already excludes `__fixtures__` (see §5.1).

---

## 4. Patterns to Follow

### 4.1 ESM `.js` import extensions, `import type` for types
**Source:** `src/mcp/tools/sprint.ts:10-12`
```ts
import { configExists, loadConfig } from "../../config/loader.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import { updateContractStatus } from "../../contracts/sprint-contract.js";
```
**Rule:** relative imports always end `.js`; type-only imports use `import type` (`consistent-type-imports` is errored — `.bober/principles.md:38`).

### 4.2 Unicode section headers
**Source:** `src/contracts/sprint-contract.ts:36`, `:70`, `:80`, `:136`, `:228`
```ts
// ── Enums ───────────────────────────────────────────────────────────
```
**Rule:** `.bober/principles.md:34` — "Use unicode box-drawing section headers".

### 4.3 A predicate over an enum, with a `ReadonlySet` of the members
**Source:** `src/pge/golden/__fixtures__/workload-build.ts:112`
```ts
const TERMINAL_SPEC_STATUSES: ReadonlySet<PlanSpecStatus> = new Set(["completed", "abandoned"]);
```
**Rule:** this is the existing spelling for "which members of a status enum mean X" in this repo — mirror it with `ContractStatus`, and export the set as well as the predicate so a test can assert its membership directly.

### 4.4 Doc comments carry the *reason*, not the restatement
**Source:** `src/pge/nodes/sprint-review.ts:33-41` — a header that names the reducer, cites `registry/reducers.ts:182`, and says which test pins the fact.
**Rule:** the DoD requires "every documentation claim added backed by a test that fails when the claim stops being true". Every sentence you add to a doc comment must have a test id or a file:line behind it.

---

## 5. Testing Patterns

**Runner:** vitest (`package.json` `"test": "vitest"`; no `vitest.config.ts` — defaults). **Assertion style:** `expect`. **Location:** co-located `*.test.ts` next to source (`.bober/principles.md:22`). **No fs mocks** — temp dirs (`.bober/principles.md:47`).

### 5.1 Architectural scan of production source (the sc-1-4 template — copy this file's shape)
**Source:** `src/orchestrator/repo-invariants.test.ts:18-62`
```ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");

/** The ONLY production module permitted to spell either wire literal. */
const OWNER = "src/orchestrator/finalize.ts";
const EVENT_LITERAL = /["'`]pipeline-complete["'`]/;

/**
 * Comment heuristic: ... Deliberately conservative — it only ever EXCLUDES lines, so a line
 * it fails to recognise as a comment is reported rather than hidden.
 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

async function collectTsFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      await collectTsFiles(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}
```
and the offender loop plus its **liveness control** (`:69-104`):
```ts
    const files = await collectTsFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(200); // the scan actually walked the tree

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(file);
      if (rel === OWNER) continue;
      const lines = (await readFile(file, "utf-8")).split("\n");
      lines.forEach((line, i) => {
        if (isCommentLine(line)) return;
        if (EVENT_LITERAL.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
```
```ts
  it("the scan is live: finalize.ts itself matches both patterns", async () => {
    const owner = await readFile(join(REPO_ROOT, OWNER), "utf-8");
    const codeLines = owner.split("\n").filter((l) => !isCommentLine(l));
    expect(codeLines.some((l) => EVENT_LITERAL.test(l))).toBe(true);
  });
```
**Rules to carry over:** (a) `expect(files.length).toBeGreaterThan(200)` proves the walk happened; (b) offenders are reported as `path:line: text` so a failure is actionable; (c) `__fixtures__` and `*.test.ts` are excluded; (d) a **positive control** asserts the owner file itself still matches, so the regex cannot rot into matching nothing. evaluatorNotes require the test to **bite by mutation** — add a temp-copy or inline-string negative control the way §5.3 does.

### 5.2 Driving the REAL committed corpus from a test
**Source:** `src/pge/golden/workload.test.ts:40-43, 56-70` — `REPO_ROOT` derived from the test file, real `.bober/` read at test time:
```ts
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKLOAD_DIR_ABS = join(REPO_ROOT, WORKLOAD_DIR);
const TOPOLOGY_PATH = join(REPO_ROOT, ".bober", "topology", "coding.json");
...
beforeAll(async () => {
  ...
  corpus = await loadWorkloadCorpus(WORKLOAD_DIR_ABS);
  expect(corpus.errors).toEqual([]);
}, 120_000);
```
**Source (reading `.bober/contracts/` specifically):** `src/pge/golden/__fixtures__/workload-build.ts:162-163, 199-212`
```ts
  const contractsDir = join(REPO_ROOT, ".bober", "contracts");
...
      const contractPath = join(contractsDir, `${sprintId}.json`);
      let contractRaw: unknown;
      try {
        contractRaw = JSON.parse(await readFile(contractPath, "utf-8"));
      } catch {
        skippedContracts.push(`${sprintId}.json (unreadable from ${spec.specId})`);
        continue;
      }
      const parsedContract = SprintContractSchema.safeParse(contractRaw);
      if (!parsedContract.success) {
        skippedContracts.push(`${sprintId}.json`);
        continue;
      }
      contracts.push(parsedContract.data);
```
**Rule for sc-1-3:** use `listContracts(REPO_ROOT)` from `src/state/sprint-state.ts` — it is the exact function both MCP tools call (`sprint.ts:115`, `eval.ts:80`) — and assert the settled list is non-empty (and, better, `=== 178`, with a `toBeGreaterThan(0)` guard so the exact number can be re-derived rather than guessed).

### 5.3 Negative control on a TEMP COPY, never the committed tree
**Source:** `src/pge/golden/workload.test.ts:176-192`
```ts
      // A graph whose OWN channel set matches the shipped one ... but whose `messages` cap is
      // mutated to `corpusMax - 1` — a COPY, never the committed topology — so the real
      // boundary is guaranteed to reject the corpus's own heaviest payload.
      ...
      const root = await mkdtemp(join(tmpdir(), "workload-equivalence-"));
```
**Rule:** to prove sc-1-4 bites, lint a synthetic source string (or a temp copy) containing `c.status === "passed"` and assert the scan reports it. `src/pge/lint-boundary.test.ts:38-46` shows the same idea with ESLint's `lintText` and a `__boundary_probe__.ts` path that is **never written to disk** — "a crashed run would otherwise leave a file behind that breaks `npm run lint` for everyone" (`:20-23`).

### 5.4 Plain unit test for a sprint-contract helper
**Source:** `src/contracts/sprint-contract.test.ts:159-183`
```ts
describe("updateContractStatus", () => {
  it("sets completedAt for terminal statuses", () => {
    const contract = validContract();
    for (const status of ["passed", "failed", "completed"] as const) {
      const next = updateContractStatus(contract, status);
      expect(next.status).toBe(status);
      expect(next.completedAt).toBeTruthy();
    }
  });
});
```
Reuse the `validContract(overrides)` factory at `:15-45` of that file. For the predicate, iterate **every** member of `ContractStatusSchema.options` and assert the exact true/false partition — that is what makes a future enum addition fail loudly.

---

## 6. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `ContractStatusSchema` | `src/contracts/sprint-contract.ts:38` | `z.ZodEnum<[...9 statuses]>` | The status enum; `.options` gives the exhaustive member list for a partition test |
| `updateContractStatus` | `src/contracts/sprint-contract.ts:205` | `(contract: SprintContract, status: ContractStatus) => SprintContract` | Stamps `startedAt`/`completedAt`; owns the current terminal rule at `:216-219` |
| `listContracts` | `src/state/sprint-state.ts:113` | `(projectRoot: string) => Promise<SprintContract[]>` | Reads `.bober/contracts/*.json`, **silently drops schema-invalid files** |
| `loadContract` | `src/state/sprint-state.ts:70` | `(projectRoot, id) => Promise<SprintContract>` | Single contract, throws on invalid |
| `saveContract` | `src/state/sprint-state.ts:37` | `(projectRoot, contract) => Promise<void>` | Validates + precision gate before writing |
| `updateProgress` | `src/state/history.ts:157` | `(projectRoot, contracts, spec) => Promise<void>` | Rewrites `.bober/progress.md` — contains the `:193` counter |
| `getTool` / `getAllTools` / `registerTool` | `src/mcp/tools/registry.ts:45, 52, 59` | `(name) => BoberToolDefinition \| undefined` | Look up a registered MCP tool and call `.handler(args)` |
| `ensureDir` | `src/state/helpers.ts:6` | `(path) => Promise<void>` | mkdir -p; used by every state writer |
| `logger` | `src/utils/logger.ts` | `logger.error/success/phase/progress/warn` | CLI output; already imported by `cli/commands/sprint.ts:21` |

**Directories reviewed for a pre-existing terminal/settled predicate:** `src/utils/`, `src/state/`, `src/contracts/`, `src/orchestrator/workflow/`, `src/pge/golden/`. **None exists** — `grep -rn '"passed"' src --include='*.ts'` and the `"completed"` equivalent return only the inline comparisons catalogued in §1-§3. Creating the predicate is genuinely new work.

---

## 7. Prior Sprint Output

None. This is sprint 1 of 6 for `spec-20260812-terminal-vocabulary`; `dependsOn` is `[]`.

Context you will need from the spec (`.bober/specs/spec-20260812-terminal-vocabulary.json`, feat-1): the feature is titled **"A shared settled-status predicate"** — the word the spec uses is **settled**, which supports the two-predicate reading in §0.1. Sprints 3 and 5 change writers; sprint 2 migrates the four illegal `pending` contracts. None of that is yours.

---

## 8. Relevant Documentation

### `.bober/principles.md` (48 lines) — the ones that bind here
- `:20` strict TS, zero type errors is a hard gate.
- `:21` ESLint flat config, `consistent-type-imports` enforced, zero lint errors is a hard gate.
- `:22` **"Tests are collocated with source (`*.test.ts` next to `*.ts`). Tests run against the real project when practical (e.g., scanner tests scan agent-bober itself)."** — direct licence for sc-1-3 and sc-1-4.
- `:29` ESM everywhere, `.js` extensions for NodeNext.
- `:32` "Contract-based architecture. PlanSpecs, SprintContracts, and EvalResults ... live in `contracts/`" — reinforces generatorNotes' "put the predicate next to ContractStatusSchema".
- `:34` unicode section headers.
- `:45` "No barrel re-exports for deep internals. `src/index.ts` exports the public API only."
- `:47` "No test mocks for filesystem."

### `AGENTS.md` (183 lines)
- `:70` **file-and-line discipline** — every claim cites `file:line`.
- `:60` "Sprint output touching files outside `expectedChanges`" is a contract violation — if you migrate any of the §3 sites beyond `estimatedFiles`, say so explicitly in completion notes.
- `:78` verification commands: `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`.

### Architecture docs
No ADR in `.bober/architecture/` covers contract status vocabulary. `docs/pge-graph.md` documents the PGE side; `src/pge/nodes/sprint-review.ts:33-49` is the closest thing to a written record of *why* the two words diverged (the `appendById` canonical-order duplicate resolution) — that is sprint 6's subject, not yours.

---

## 9. Impact Analysis

### Files that may break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/index.ts:21-35` | `contracts/sprint-contract.js` | low | Add new exports here; `npm run build` fails if a name is wrong |
| 58 production modules import `contracts/sprint-contract.js` | the module | low | You are **adding** exports, not changing `updateContractStatus`'s observable behaviour. Keep the passed/failed/completed set identical. |
| `src/orchestrator/workflow/flusher.ts:76` | `updateContractStatus` (`:69`) | medium | Writes `passed`/`needs-rework`/`failed` and then splits — a semantic change to `updateContractStatus` would move `completedAt` stamping |
| `src/orchestrator/pipeline.ts:589, 1052` | `updateContractStatus` + status read | medium | The TS pipeline's completed/failed split |
| `.bober/progress.md` shape | `src/state/history.ts:193-215` | **high** | Changing `:193`'s word set changes the `\| Passed \| N \|` row. `flusher.test.ts` / `conformance*.test.ts` call `updateProgress`. |

### Existing tests that must still pass
- `src/contracts/sprint-contract.test.ts` — `:168-175` pins `updateContractStatus` stamping `completedAt` for `passed`/`failed`/`completed`. If your terminal predicate drops `failed`, this fails.
- `src/orchestrator/workflow/resume-cursor.test.ts:76-95` — pins `passed` + `completed` → `[1, 2]`, with `in-progress` and `failed` excluded. Your predicate must reproduce it exactly.
- `src/orchestrator/workflow/flusher.test.ts` (incl. `:349` re-flush contract count) — exercises `updateContractStatus` + `updateProgress`.
- `src/orchestrator/workflow/conformance.test.ts` and `conformance.engines.test.ts` — compare the two engines' `.bober/` artifacts including `progress.md` and `contracts`; `conformance.engines.test.ts:414` already comments on the seeded-`proposed` vs settled-status divergence.
- `src/orchestrator/pipeline.test.ts`, `src/cli/commands/sprint.test.ts`, `src/mcp/tools/tools.test.ts` (37-tool count — do not add or remove a tool).
- `src/orchestrator/repo-invariants.test.ts` — your new scan must not collide with its `OWNER`-style rules.
- `src/pge/golden/workload.test.ts`, `dataset.test.ts`, `coverage.test.ts`, `gate.test.ts` — read the real `.bober/` trees; do not edit any file under `.bober/contracts/`, `.bober/golden/` or `.bober/workload/`.

### Features that could be affected
- **Sprint 6 (rank-aware channel join)** shares `src/pge/runtime/commit.ts` and `src/pge/nodes/sprint-review.ts`. Leave both alone here so sprint 6 gets a clean diff.
- **Sprint 2 (migrating the four illegal `pending` contracts)** shares the `.bober/contracts/` corpus. If your sc-1-3 test hardcodes `196`/`178`, sprint 2 will change those numbers — derive them or note the coupling in a comment.

### Recommended regression checks (run in this order)
1. `npx vitest run src/contracts/sprint-contract.test.ts src/orchestrator/workflow/resume-cursor.test.ts`
2. `npx vitest run src/orchestrator/workflow/flusher.test.ts src/orchestrator/workflow/conformance.test.ts src/orchestrator/workflow/conformance.engines.test.ts`
3. `npm run typecheck && npm run typecheck:tests && npm run lint`
4. `npm test` (full suite — the baseline at `HEAD` is **6902 passed / 2 skipped / 0 failed**, per `docs/sprints/sprint-spec-20260812-pge-real-workload-errors-9.md:118`)
5. `npm run build` **then** `node scripts/run-golden-regression.mjs` — this is the **golden gate** of sc-1-5. It is a shim that loads `dist/pge/golden/gate.js` (`scripts/run-golden-regression.mjs:43`) and is the exact command CI runs (`.github/workflows/ci.yml:106`). **6/6** = the six `replay` cases in `.bober/golden/` (43 files total, 37 `integrity` + 6 `replay`). Build first or the gate cannot load and exits non-zero.
6. `git status --porcelain .bober/` — must be empty. No contract, golden case or workload entry may move.

---

## 10. Implementation Sequence

1. **`src/contracts/sprint-contract.ts`** — add, directly after `ContractStatusSchema` (line 49), a `// ── Terminal status ─────` section: the `ReadonlySet<ContractStatus>` member sets (§4.3 spelling) and the exported predicate(s). Then rewrite `:216-219` to call the terminal predicate. Doc comment must state which readers own which meaning (§0.1).
   - *Verify:* `npx vitest run src/contracts/sprint-contract.test.ts` — `:168-175` still green with no edit to that test.
2. **`src/contracts/sprint-contract.test.ts`** — add a describe block that partitions **all nine** `ContractStatusSchema.options` across the predicate(s), plus a test that `updateContractStatus` and the predicate agree (so `:216-219` cannot drift back).
   - *Verify:* the new tests fail if you flip one member of the set.
3. **`src/index.ts`** — re-export the new symbols in the block at `:21-35`.
   - *Verify:* `npm run build`.
4. **`src/orchestrator/workflow/resume-cursor.ts:22`** — replace the two-word filter with the settled predicate; import with `.js` extension.
   - *Verify:* `npx vitest run src/orchestrator/workflow/resume-cursor.test.ts` — `[1, 2]` unchanged.
5. **`src/state/history.ts:193`** — migrate the `passed` counter only. Leave `:194`, `:195-202`, `:250-263`.
   - *Verify:* `npx vitest run src/orchestrator/workflow/flusher.test.ts src/orchestrator/workflow/conformance.test.ts`.
6. **`src/cli/commands/eval.ts:126-128`**, **`src/cli/commands/sprint.ts:159-161`**, **`src/mcp/tools/eval.ts:139`**, **`src/mcp/tools/sprint.ts:147`** — migrate the four `completedContracts` filters. Touch nothing else in these files.
   - *Verify:* `git diff --stat` shows exactly one changed hunk per file plus the import line.
7. **sc-1-3 test** — new file (suggested `src/mcp/tools/sprint-corpus.test.ts`, co-located per principles). Drive both tools' settled list against `listContracts(REPO_ROOT)` and assert non-empty. **Note:** `bober_sprint`'s handler (`src/mcp/tools/sprint.ts:85-313`) runs real generator/evaluator agents and cannot be invoked end-to-end in a test; the honest pin is to extract the shared filter into a small exported helper (e.g. `settledContracts(contracts)`) that both tools call at `:147` / `:139`, and assert **that** against the real corpus — then a `toContain`/name check proves each tool uses it. State this reasoning in the test header.
   - *Verify:* assertion is `178` (or `> 0` with the derivation shown), and it fails if you revert step 6.
8. **sc-1-4 scan test** — new file (suggested `src/contracts/status-vocabulary.invariant.test.ts`), modelled on `src/orchestrator/repo-invariants.test.ts` (§5.1). Walk `SRC_ROOT`, skip `*.test.ts` / `__fixtures__` / comment lines, flag `status === "passed"` / `status === "completed"` style comparisons, and carry an explicit **allowlist with a one-line reason per entry** covering §2 (non-contract statuses) and whatever you decide about §3. Include a liveness control (`files.length > 200`) and a mutation control proving the scan reports a synthetic offender.
   - *Verify:* paste a `c.status === "passed"` line into a scratch temp copy and confirm the scan reports it; revert.
9. **Full verification** — `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build && npm test && node scripts/run-golden-regression.mjs`.

---

## 11. Pitfalls & Warnings

- **The playwright path in the contract is wrong** — `src/eval/strategies/playwright.ts` does not exist; the site is `src/evaluators/builtin/playwright.ts:530`. Do not create the phantom path or claim you checked it at the wrong location.
- **One predicate is not enough for `history.ts:193`.** `:194` counts `failed` separately. A terminal-including-failed predicate at `:193` double-counts. See §0.1.
- **Do not touch writers.** `mcp/tools/sprint.ts:255`, `cli/commands/sprint.ts:285`, `orchestrator/pipeline.ts:589`, `pge/nodes/sprint-review.ts:203`, `orchestrator/workflow/flusher.ts:61-66` all *write* a status. nonGoal 1 defers those to sprints 3 and 5.
- **Do not touch `ContractStatusSchema`'s membership** (nonGoal 2) and do not migrate the four `pending` contracts (nonGoal 3).
- **`listContracts` swallows 60 of 256 files.** Any corpus assertion built from `readdir` will disagree with any assertion built from `listContracts`. Pick one, say which, and say why.
- **The pending-status sets are not terminal checks.** `mcp/tools/sprint.ts:32-37`, `cli/commands/sprint.ts:39-44`, `mcp/tools/eval.ts:98-103`, `cli/commands/eval.ts:87-90` and `history.ts:195-202` all select *non*-terminal states. A blanket regex replace will eat them.
- **A scan regex that matches nothing passes silently.** `repo-invariants.test.ts:99-104` exists precisely because of this; carry its positive control.
- **`__fixtures__` must be excluded** or `src/pge/runtime/__fixtures__/golden-graph.ts:878,925` and `src/pge/compile/__fixtures__/fixture-graph.ts:66` become false offenders.
- **The golden gate needs `dist/`.** `node scripts/run-golden-regression.mjs` loads `dist/pge/golden/gate.js`; run `npm run build` first or it exits non-zero with "Cannot load the golden gate".
- **`npm run lint` only lints `src/`** (`package.json`), and `tsconfig.json` excludes tests — that is why `npm run typecheck:tests` is a separate required gate in sc-1-5. Run both.
- **`src/mcp/tools/tools.test.ts:11` asserts exactly 37 registered tools.** Do not register anything new.
- **`.bober/` is read by the test suite.** Editing any file under `.bober/contracts/`, `.bober/golden/`, `.bober/workload/` or `.bober/topology/` while implementing will produce confusing failures in `workload.test.ts`, `dataset.test.ts` and `coverage.test.ts`.
