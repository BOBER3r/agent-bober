# Sprint Briefing: Embedded-sprint materialization and eager wiring into plan

**Contract:** sprint-spec-20260623-plan-contracts-materialization-2
**Generated:** 2026-06-23T02:24:00.000Z

---

## 0. TL;DR for the Generator

Two production files to edit, two test files to extend:

1. **`src/orchestrator/contract-materialization.ts`** — add an embedded-sprint branch ABOVE the existing feature loop. Iterate `spec.sprints`, `SprintContractSchema.safeParse` each entry, normalize `status` to `"proposed"`, assign deterministic `sprint-<specId>-NN` ids, and `saveContract` each. If ANY entry fails safeParse OR any `saveContract` throws (precision gate), abandon the embedded set and fall back to the EXISTING feature-derived loop for the whole spec — never a partial mix.
2. **`src/cli/commands/plan.ts`** — in `runPlanCommand`, after `printPlan(spec)` and only when `result.kind !== "needs-clarification"`, clear prior contracts for this `specId` then call `materializeContracts(spec, projectRoot, config)`. Fix `printPlan`'s next-step hint so it matches a command that now works.
3. Stale-clearing: there is NO existing helper. Delete `.bober/contracts/*.json` files whose parsed `specId === spec.specId` before writing.

KEY REALITY CHECK (verified): in every spec currently on disk, `spec.sprints` is an array of **strings** (sprint ids like `"sprint-spec-...-1"`), NOT objects. So `safeParse` will fail on real data today and the **feature-derived fallback is the common path**. The embedded-object branch is for future/external specs whose entries are full contract objects. Make the fallback bulletproof; it is what S2-C3 and S2-C4 exercise.

---

## 1. Target Files

### src/orchestrator/contract-materialization.ts (modify)

This is the Sprint-1 helper. It currently has ONLY the feature-derived loop. Add the embedded branch at the TOP of `materializeContracts` and keep the existing loop intact as the fallback.

**Existing imports (lines 20-26) — you have everything you need; add `SprintContractSchema` import:**
```ts
import type { BoberConfig } from "../config/schema.js";
import type { PlanSpec } from "../contracts/spec.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import { createContract } from "../contracts/sprint-contract.js";
import { generateContractPrecision } from "./planner-agent.js";
import { saveContract } from "../state/index.js";
import { logger } from "../utils/logger.js";
```
You will additionally need `SprintContractSchema` from `../contracts/sprint-contract.js`:
```ts
import { createContract, SprintContractSchema } from "../contracts/sprint-contract.js";
```

**Existing function signature (lines 38-42) — DO NOT change it:**
```ts
export async function materializeContracts(
  spec: PlanSpec,
  projectRoot: string,
  config: BoberConfig,
): Promise<SprintContract[]>
```

**Existing feature-derived loop (lines 43-93) — keep verbatim as the fallback.** The id assignment at line 88 is the canonical id scheme to reuse in the embedded branch:
```ts
// line 88
contract.contractId = `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`;
```

**Where the embedded branch goes (sketch — adapt, do not paste blindly):**
```ts
export async function materializeContracts(spec, projectRoot, config) {
  // ── Embedded branch: prefer valid spec.sprints when present ──
  if (Array.isArray(spec.sprints) && spec.sprints.length > 0) {
    const embedded: SprintContract[] = [];
    let ok = true;
    for (let i = 0; i < spec.sprints.length; i++) {
      const parsed = SprintContractSchema.safeParse(spec.sprints[i]);
      if (!parsed.success) { ok = false; break; }       // any failure ⇒ whole-set fallback
      const contract = parsed.data;
      contract.status = "proposed";                      // normalize
      contract.specId = spec.specId;                     // pin to this spec
      contract.sprintNumber = i + 1;
      contract.contractId = `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`;
      embedded.push(contract);
    }
    if (ok) {
      try {
        for (const c of embedded) await saveContract(projectRoot, c); // precision gate may throw
        return embedded;
      } catch (err) {
        logger.warn(`Embedded sprints failed the precision gate; falling back to feature-derived contracts: ${err instanceof Error ? err.message : String(err)}`);
        // fall through to feature loop
      }
    } else {
      logger.warn("One or more embedded spec.sprints entries failed schema validation; using feature-derived contracts for the whole spec.");
    }
  }

  // ── EXISTING feature-derived loop (current lines 43-93) unchanged ──
  const contracts: SprintContract[] = [];
  for (let i = 0; i < spec.features.length; i++) { /* ... existing body ... */ }
  return contracts;
}
```

**CRITICAL fallback hygiene:** if the embedded branch wrote some files then threw mid-loop, those partial files have ids `sprint-<specId>-NN` — the SAME id scheme the fallback uses, so the fallback's `saveContract` (which overwrites same-id files) will replace 1..features.length. BUT if the embedded set was longer than the feature set, higher-numbered stale files survive. The plan-command stale-clear (Section 1, plan.ts) handles the re-plan case; for safety the embedded catch-branch can also rely on the plan-level pre-clear running first. The unit tests for materializeContracts call it against a fresh tmp dir each time, so a mid-loop partial only matters in S2-C5 (idempotency), which is driven through the plan command path that pre-clears.

**Imported by:**
- `src/orchestrator/pipeline.ts:18` (`import { materializeContracts } from "./contract-materialization.js";`) and called at `pipeline.ts:853`. The embedded branch is ADDITIVE — pipeline behavior is unchanged because real specs have string `sprints` (fall back) and the signature/return type are identical.

**Test file:** `src/orchestrator/contract-materialization.test.ts` (exists — extend it).

---

### src/cli/commands/plan.ts (modify)

**Existing imports (lines 4-17):**
```ts
import { loadConfig } from "../../config/loader.js";
import { getOpenClarifications, resolveClarification, type ClarificationQuestion, type PlanSpec } from "../../contracts/spec.js";
import { runPlanner } from "../../orchestrator/planner-agent.js";
import { ensureBoberDir, loadSpec, saveSpec } from "../../state/index.js";
import { logger } from "../../utils/logger.js";
```
You will need to add: `materializeContracts` from `"../../orchestrator/contract-materialization.js"`, plus `listContracts` from `"../../state/index.js"` (for stale-clearing — see Section 4). The `config` and `projectRoot` are already in scope inside `runPlanCommand`.

**Wiring point — `runPlanCommand` lines 81-99 (current):**
```ts
  try {
    const result = await runPlanner(task, projectRoot, config);
    const spec = result.spec;

    // Branch: clarification needed → display questions and exit
    if (result.kind === "needs-clarification") {
      printClarificationPrompt(spec);
      process.exitCode = 2; // distinct exit code so /loop can detect parking
      return;
    }

    // Display normal plan results
    printPlan(spec);
  } catch (err) {
    logger.error(`Planning failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
```
Add the materialization AFTER `printPlan(spec)` (and inside the same `try`, so failures set `process.exitCode = 1`):
```ts
    // Display normal plan results
    printPlan(spec);

    // Eagerly materialize sprint contracts so `sprint`/`run` find them.
    // (Only reached when result.kind !== "needs-clarification".)
    await clearContractsForSpec(projectRoot, spec.specId);   // see Section 4
    await materializeContracts(spec, projectRoot, config);
```
Note: `runPlanner` already persisted the spec (`planner-agent.ts:275 await saveSpec(projectRoot, spec)`), so do NOT re-save the spec here.

**The next-step hint inconsistency to reconcile:**
- `printPlan` line 170-172 currently prints:
```ts
  console.log(`Next: ${chalk.green("npx agent-bober sprint")} to start the first sprint`);
```
- `runPlanAnswerCommand` line 288-291 prints (when status becomes ready):
```ts
    if (updated.status === "ready") {
      console.log(`Next: ${chalk.green(`npx agent-bober run`)} to execute the plan.`);
    }
```
S2-C6 requires the plan hint to "point to a command which succeeds, consistent with the hint printed by plan answer." Since `plan answer` says `run` and `run`/`sprint` both now have contracts on disk, the safe reconciliation is to make `printPlan`'s hint also say `npx agent-bober run` (or include both). Pick ONE wording and assert it in the test. The contract says "consistent with the hint printed by plan answer", so prefer `run`.

**`printPlan` signature (line 110):** `function printPlan(spec: PlanSpec): void` — purely a console printer; only the final hint line changes.

**Imported by:** `src/cli/index.ts:14` (`runPlanCommand`) and called at `src/cli/index.ts:127` inside the `plan [task]` action. No call-site signature change needed.

**Test file:** `src/cli/commands/plan.test.ts` (exists — currently only tests `runPlanAnswerCommand`; add `runPlanCommand` tests).

---

### src/cli/commands/plan.test.ts (modify — add runPlanCommand tests)

No `runPlanCommand` tests exist yet. You must add `vi.mock("../../orchestrator/planner-agent.js", ...)` to control `runPlanner`'s `PlannerResult`, and (because `materializeContracts` calls `generateContractPrecision`) the mock must export BOTH `runPlanner` and `generateContractPrecision`. See Section 6.

### src/orchestrator/contract-materialization.test.ts (modify — add embedded + fallback cases)

Extend the existing suite (which already mocks `generateContractPrecision`) with: (a) valid embedded sprints used verbatim with normalized status (S2-C2), (b) malformed embedded sprints → feature-derived fallback without throwing (S2-C3), (c) idempotency / no stale higher-numbered files (S2-C5, may live here or in plan.test.ts).

---

## 2. Patterns to Follow

### Pattern: Zod safeParse for a typed-unknown field
**Source:** `src/state/sprint-state.ts`, lines 44-49 and 96-101
```ts
const validation = SprintContractSchema.safeParse(contract);
if (!validation.success) {
  throw new Error(`Invalid contract:\n${formatZodIssues(validation.error)}`);
}
```
**Rule:** Use `SprintContractSchema.safeParse(entry)` and branch on `.success`; read the validated object via `.data`. Never `.parse()` (which throws) inside the embedded loop — you want to detect failure and fall back, not crash.

### Pattern: Deterministic zero-padded contract id
**Source:** `src/orchestrator/contract-materialization.ts`, line 88
```ts
contract.contractId = `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`;
```
**Rule:** Reuse this EXACT id scheme in the embedded branch so the two branches are interchangeable and `listContracts()` lexical order == execution order. width-2 pad covers 1-99.

### Pattern: saveContract enforces schema + precision gate (may throw)
**Source:** `src/state/sprint-state.ts`, lines 38-64
```ts
export async function saveContract(projectRoot, contract): Promise<void> {
  await ensureDir(contractsDir(projectRoot));
  const validation = SprintContractSchema.safeParse(contract);
  if (!validation.success) throw new Error(`Invalid contract:\n...`);
  const precisionIssues = findPrecisionIssues(validation.data);   // banned vague phrases
  if (precisionIssues.length > 0) throw new Error(`Contract "${contract.contractId}" failed precision gate:\n...`);
  await writeFile(contractPath(projectRoot, contract.contractId), JSON.stringify(contract, null, 2), "utf-8");
}
```
**Rule:** `saveContract` is the precision gate. Wrap the embedded-branch `saveContract` calls in try/catch; a throw means "embedded contracts not precise enough" ⇒ fall back to feature-derived. Do NOT call `findPrecisionIssues` yourself; let `saveContract` be the single gate.

### Pattern: Best-effort file deletion (does not throw)
**Source:** `src/state/approval-state.ts`, line 139
```ts
await unlink(pendingPath(projectRoot, id)).catch(() => {});
```
**Rule:** For stale-contract clearing, `unlink(...).catch(() => {})` per file so a missing/locked file never aborts the re-plan.

### Pattern: readdir-with-empty-fallback for a state dir
**Source:** `src/state/sprint-state.ts`, lines 116-124 (`listContracts`)
```ts
let entries: string[];
try { entries = await readdir(dir); } catch { return []; }
const jsonFiles = entries.filter((f) => f.endsWith(".json")).sort();
```
**Rule:** If you scan `.bober/contracts` directly for deletion, guard `readdir` with a try/catch returning early — the dir may not exist on a first plan.

### Pattern: discriminated PlannerResult narrowing
**Source:** `src/orchestrator/planner-agent.ts`, lines 147-149
```ts
export type PlannerResult =
  | { kind: "ready"; spec: PlanSpec }
  | { kind: "needs-clarification"; spec: PlanSpec };
```
**Rule:** `runPlanCommand` already narrows on `result.kind === "needs-clarification"` (plan.ts:86) and returns early. Materialize ONLY on the fall-through (kind === "ready").

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `materializeContracts` | `src/orchestrator/contract-materialization.ts:38` | `(spec: PlanSpec, projectRoot: string, config: BoberConfig) => Promise<SprintContract[]>` | The Sprint-1 helper to EXTEND, not recreate. |
| `SprintContractSchema` | `src/contracts/sprint-contract.ts:82` | Zod object | safeParse each embedded entry against this. |
| `saveContract` | `src/state/sprint-state.ts:38` (re-exported `src/state/index.ts:5`) | `(projectRoot, contract) => Promise<void>` | Validates + precision-gates + writes; throws on failure. Single precision gate. |
| `listContracts` | `src/state/sprint-state.ts:113` (re-exported `src/state/index.ts:7`) | `(projectRoot) => Promise<SprintContract[]>` | Reads all valid contracts (skips bad files). Use to find files whose `specId` matches for stale-clearing. |
| `loadContract` | `src/state/sprint-state.ts:70` (re-exported) | `(projectRoot, id) => Promise<SprintContract>` | Load one by id (throws if missing/invalid). |
| `createContract` | `src/contracts/sprint-contract.ts:148` | `(title, description, criteria, options) => SprintContract` | Used ONLY in the existing feature-derived loop; do not call in embedded branch. |
| `generateContractPrecision` | `src/orchestrator/planner-agent.ts:422` | `(feature, spec, config) => Promise<ContractPrecision \| undefined>` | LLM call inside feature-derived loop; mock it in tests. |
| `findPrecisionIssues` | `src/contracts/sprint-contract.ts:242` | `(contract) => ContractPrecisionIssue[]` | The banned-phrase checker `saveContract` runs internally. Do not call directly. |
| `runPlanner` | `src/orchestrator/planner-agent.ts:160` | `(userPrompt, projectRoot, config, researchDoc?, architectDoc?) => Promise<PlannerResult>` | Persists the spec internally (line 275). Mock in plan.test.ts. |
| `logger` | `src/utils/logger.ts` | `.info/.warn/.error/.debug` | Use `logger.warn(...)` when falling back from embedded to feature-derived. |
| `ensureBoberDir` | `src/state/index.ts:97` | `(projectRoot) => Promise<void>` | Already called in runPlanCommand (plan.ts:78); creates `.bober/contracts/`. |

**There is NO existing contract-deletion helper.** Grep confirmed: `grep -rn "deleteContract\|clearContract\|removeContract" src/` returns nothing. You must add stale-clearing logic (see Section 4). Utilities reviewed: `src/state/` (sprint-state, plan-state, approval-state, etc.), `src/utils/` (logger), `src/contracts/` — listed above.

---

## 4. Stale-Contract Clearing (no existing helper — you build it)

Goal: before writing new contracts in `runPlanCommand`, delete `.bober/contracts/*.json` whose parsed `specId === spec.specId`, leaving OTHER specs' contracts untouched. This makes re-planning idempotent and prevents stale higher-numbered files (S2-C5).

Two clean approaches — pick the one with the simplest test surface:

**Approach A (preferred — reuse `listContracts`, add a small helper):** Add `clearContractsForSpec(projectRoot, specId)` either as a private function in `plan.ts` or (cleaner, more testable) a new exported helper in `src/state/sprint-state.ts` re-exported from `src/state/index.ts`:
```ts
// src/state/sprint-state.ts
import { readFile, writeFile, readdir, unlink } from "node:fs/promises"; // add unlink
export async function clearContractsForSpec(projectRoot: string, specId: string): Promise<void> {
  const dir = contractsDir(projectRoot);
  let entries: string[];
  try { entries = await readdir(dir); } catch { return; }            // dir absent ⇒ nothing to clear
  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    const filePath = join(dir, file);
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf-8")) as { specId?: string };
      if (parsed.specId === specId) await unlink(filePath).catch(() => {});
    } catch { /* skip unreadable/non-JSON files */ }
  }
}
```
Then re-export it from `src/state/index.ts:4-9`:
```ts
export { saveContract, loadContract, listContracts, updateContract, clearContractsForSpec } from "./sprint-state.js";
```
`contractsDir` and `join` are already imported in sprint-state.ts (lines 2, 15). `unlink` must be added to the `node:fs/promises` import (line 1 currently imports `readFile, writeFile, readdir`).

**Why match on `specId` field, not filename prefix:** filenames are sanitized (`contractPath` line 21 replaces non `[a-zA-Z0-9_-]` with `_`), but `specId` is reliably present in the JSON body. Match the body. A filename-prefix match would ALSO work here because ids are `sprint-<specId>-NN`, but body-match is the robust, contract-mandated approach ("files whose parsed specId equals spec.specId").

**Order in runPlanCommand:** clear FIRST, then materialize. The feature-derived fallback overwrites `-01..-NN` for the current feature count; clearing first removes any orphaned `-NN` beyond that count from a previous larger plan.

---

## 5. Prior Sprint Output

### Sprint 1 (DONE, commit 1a7cd2b): Extract feature-derived materialization helper
**Created:** `src/orchestrator/contract-materialization.ts` — exports `materializeContracts(spec, projectRoot, config): Promise<SprintContract[]>` (feature-derived branch only).
**Created:** `src/orchestrator/contract-materialization.test.ts` — S1-C2/C3/C4 tests; already mocks `generateContractPrecision`.
**Modified:** `src/orchestrator/pipeline.ts:18` import, `pipeline.ts:853` call (delegates the old inline loop to the helper).
**Connection to this sprint:** Sprint 2 EXTENDS this helper with the embedded branch (do not recreate or change the signature/return) and adds the FIRST caller in `plan.ts`. The deterministic id scheme at line 88 and the feature-derived loop become the shared fallback. pipeline.ts already calls it; the embedded branch is byte-compatible for pipeline because real specs fall back.

---

## 6. Testing Patterns

### Unit Test Pattern — materialize helper (extend existing suite)
**Source:** `src/orchestrator/contract-materialization.test.ts`, lines 19-72
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpec } from "../contracts/spec.js";
import { listContracts } from "../state/index.js";

vi.mock("./planner-agent.js", () => ({
  generateContractPrecision: vi.fn(async () => ({
    nonGoals: ["Do not implement the settings UI in this sprint"],
    stopConditions: ["npm test passes and the helper exports materializeContracts"],
    definitionOfDone: "The helper materializes one contract per feature and persists each to .bober/contracts.",
    assumptions: ["assumption A"],
    outOfScope: ["deferred work B"],
  })),
}));

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-materialize-")); vi.clearAllMocks(); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.mock("./planner-agent.js", ...)`. **File naming:** colocated `<name>.test.ts`. **Location:** co-located.

**S2-C2 (valid embedded → verbatim, status normalized):** build a fully-valid SprintContract object (status anything, e.g. `"agreed"`) and put it in `spec.sprints`. Because `createSpec` does not accept `sprints`, set it after: `const spec = specWith(2); (spec as any).sprints = [validContract1, validContract2];`. Assert each written file has `status === "proposed"`, the embedded `successCriteria` and precision fields preserved, and `contractId === sprint-<specId>-NN`. A VALID embedded contract needs ALL required fields with no defaults (see Section 8): `contractId`, `specId`, `sprintNumber>=1`, `title`, `description`(>=1 char), `status`, `successCriteria` (>=1, each with `description`>=25 chars, `verificationMethod` in the strict enum, `required:boolean`), `nonGoals`(>=1 non-empty), `stopConditions`(>=1 non-empty), `definitionOfDone`(>=20 chars). Avoid BANNED_VAGUE_PHRASES (Section 8) so `saveContract` doesn't reject.

**S2-C3 (malformed embedded → feature-derived fallback, no throw):** set `spec.sprints = [{ title: "x" }]` (omits status, missing required fields) — OR an entry with `verificationMethod: "does-not-exist"`. Assert `await materializeContracts(...)` resolves (does not throw) and the written contracts are feature-derived (titles == feature titles, `successCriteria[0].verificationMethod === "agent-evaluation"`, count == features.length) and each passes `SprintContractSchema.safeParse`.

**S2-C5 (idempotency / no stale files):** materialize a 3-sprint version then a 2-sprint version of the SAME `specId` THROUGH the clear+materialize path; assert exactly two files remain and no `-03`. If `clearContractsForSpec` lives in state, you can test it directly here against tmpDir; otherwise drive via `runPlanCommand` in plan.test.ts.

### Unit Test Pattern — runPlanCommand (NEW in plan.test.ts)
**Source for tmp-dir + console spy lifecycle:** `src/cli/commands/plan.test.ts`, lines 1-45
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpRoot: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-plan-"));
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = undefined;
});
afterEach(async () => { consoleLogSpy.mockRestore(); await rm(tmpRoot, { recursive: true, force: true }); });
```
**Mocking runPlanner + generateContractPrecision (both live in planner-agent.js):** `runPlanCommand` imports `runPlanner` and (transitively, via materializeContracts feature-fallback) `generateContractPrecision` from the SAME module. Mock both, and mock `loadConfig` so no real config is required:
```ts
vi.mock("../../orchestrator/planner-agent.js", () => ({
  runPlanner: vi.fn(),
  generateContractPrecision: vi.fn(async () => ({
    nonGoals: ["Do not add a CLI command in this sprint"],
    stopConditions: ["The plan command writes one contract per feature to .bober/contracts"],
    definitionOfDone: "The plan command materializes schema-valid contracts after a ready plan.",
    assumptions: [], outOfScope: [],
  })),
}));
vi.mock("../../config/loader.js", () => ({ loadConfig: vi.fn(async () => ({ planner: { model: "x", provider: "anthropic" }, generator: {}, evaluator: {}, sprint: { maxSprints: 10 } })) }));
```
Then in tests, import the mocked `runPlanner` and set its resolved value per case:
```ts
const { runPlanner } = await import("../../orchestrator/planner-agent.js");
(runPlanner as any).mockResolvedValue({ kind: "ready", spec: someReadySpec });
await runPlanCommand("build a thing", tmpRoot, {});
const written = await listContracts(tmpRoot);
expect(written.length).toBe(someReadySpec.features.length);
```

**S2-C4 (ready → contracts; needs-clarification → zero):**
- ready case: `mockResolvedValue({ kind: "ready", spec })` then assert `listContracts(tmpRoot)` is non-empty and every entry passes the schema.
- needs-clarification case: `mockResolvedValue({ kind: "needs-clarification", spec })`; assert `listContracts(tmpRoot)` length === 0 and `process.exitCode === 2`.

**S2-C6 (accurate hint):** capture `consoleLogSpy.mock.calls.flat().join("\n")` after a ready plan and assert it contains the chosen command word (e.g. `agent-bober run`), matching the `plan answer` hint.

No E2E/Playwright applies to this sprint (CLI/state only).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` (imports at :18, calls at :853) | `materializeContracts` | low | Signature/return unchanged; embedded branch is additive. Real specs have string `sprints` ⇒ fall back ⇒ identical behavior. Run `pipeline`-related tests. |
| `src/cli/index.ts:127` (`plan` action) | `runPlanCommand` | low | Signature unchanged; only adds post-print materialization. Verify `plan` command still exits 2 on needs-clarification. |

### Existing Tests That Must Still Pass
- `src/orchestrator/contract-materialization.test.ts` — S1-C2/C3/C4 (feature-derived parity, deterministic ids, lexical order). Your embedded branch must NOT alter feature-derived output when `spec.sprints` is absent/string-typed. S1-C3 builds specs via `specWith()` which has NO `sprints` field, so the embedded branch is skipped — these must stay green unchanged.
- `src/cli/commands/plan.test.ts` — `runPlanAnswerCommand` tests (4 cases). Unaffected unless you change `runPlanAnswerCommand`'s hint; if you keep its `run` hint and align `printPlan` to it, these stay green.
- Any pipeline integration test that calls `materializeContracts` indirectly — verify with the full suite.

### Features That Could Be Affected
- **Sprint 3 (out of scope here)** — will change the `sprint` command's contract selection. Do NOT touch `src/cli/commands/sprint.ts`. The contract explicitly defers this.
- **`run` pipeline** — shares `materializeContracts`. Verify `npx agent-bober run` path still produces the same contracts (covered by S1 tests + build).

### Recommended Regression Checks
1. `npm run build` — zero TS/typecheck errors (S2-C1). The embedded branch's `parsed.data` is typed `SprintContract`; mutating `status`/`specId`/`sprintNumber`/`contractId` is allowed.
2. `npx vitest run src/orchestrator/contract-materialization.test.ts` — all S1 + new S2-C2/C3/C5 cases green.
3. `npx vitest run src/cli/commands/plan.test.ts` — `runPlanAnswerCommand` (existing) + new `runPlanCommand` (S2-C4/C6) green.
4. `npx vitest run src/state` — if you added `clearContractsForSpec` to sprint-state, ensure state tests still pass.
5. Full suite: `npm test` — no regressions across the ~2800-test suite.

---

## 8. SprintContractSchema — Required Fields (for building valid embedded fixtures)

**Source:** `src/contracts/sprint-contract.ts:82-133` + sub-schemas. Fields with NO default that an embedded entry MUST supply to pass `safeParse`:
- `contractId` string min 1 (you overwrite it anyway, but it must be present & non-empty to parse).
- `specId` string min 1.
- `sprintNumber` int >= 1.
- `title` string min 1.
- `description` string min 1.  *(NB: the success-criterion `description` min is 25, not the contract `description`.)*
- `status` ContractStatusSchema enum (`proposed|negotiating|agreed|in-progress|evaluating|passed|failed|needs-rework|completed`) — you normalize to `"proposed"`, but it must be a VALID enum value to parse first. An OMITTED status fails safeParse ⇒ fallback (this is exactly S2-C3's "omit status" case).
- `successCriteria` array min 1; each (`SuccessCriterionSchema` lines 72-77): `criterionId` min 1, `description` **min 25 chars** (`MIN_CRITERION_DESCRIPTION_LENGTH`), `verificationMethod` in the **strict enum** (`manual|typecheck|lint|unit-test|playwright|api-check|build|agent-evaluation`), `required` boolean. An unknown `verificationMethod` fails safeParse ⇒ fallback (S2-C3's other case).
- `nonGoals` array min 1, each string min 1.
- `stopConditions` array min 1, each string min 1.
- `definitionOfDone` string **min 20 chars** (`MIN_DEFINITION_OF_DONE_LENGTH`).

Fields with defaults (safe to omit): `dependsOn`, `features`, `assumptions`, `outOfScope`, `iterationHistory`, timestamps, `generatorNotes`, etc.

**Precision gate (runs in saveContract, NOT in safeParse) — `findPrecisionIssues` (sprint-contract.ts:242-275):** scans `description`, `definitionOfDone`, each `successCriteria[].description`, each `nonGoals[i]`, each `stopConditions[i]` for `BANNED_VAGUE_PHRASES` (sprint-contract.ts:22-34): "works correctly", "works as expected", "looks good", "looks nice", "is reasonable", "behaves properly", "behaves correctly", "is correct", "appears correct", "as needed", "if appropriate". If a valid-schema embedded contract contains any banned phrase, `saveContract` THROWS ⇒ whole-set fallback. Keep test fixtures free of these phrases.

---

## 9. Implementation Sequence

1. **`src/orchestrator/contract-materialization.ts`** — add `SprintContractSchema` to the existing import; prepend the embedded branch to `materializeContracts`; keep the feature loop as fallback.
   - Verify: `npm run build` compiles; embedded branch returns early only when all entries parse AND all `saveContract`s succeed; otherwise falls through to the existing loop. No signature change.
2. **`src/state/sprint-state.ts`** (if using Approach A) — add `unlink` to imports; add `clearContractsForSpec(projectRoot, specId)`; re-export from `src/state/index.ts:4-9`.
   - Verify: `npm run build`; the function returns early when `.bober/contracts` is absent and only unlinks files whose body `specId` matches.
3. **`src/cli/commands/plan.ts`** — import `materializeContracts` (and `clearContractsForSpec`/`listContracts`); after `printPlan(spec)` in the ready branch, call clear-then-materialize inside the existing try; change `printPlan`'s final hint to match `plan answer` (`run`).
   - Verify: `npm run build`; needs-clarification path still returns BEFORE materialization with exitCode 2.
4. **`src/orchestrator/contract-materialization.test.ts`** — add S2-C2 (valid embedded verbatim, status normalized), S2-C3 (malformed → fallback no-throw), optional S2-C5 (direct clear test).
   - Verify: `npx vitest run src/orchestrator/contract-materialization.test.ts` green incl. existing S1 cases.
5. **`src/cli/commands/plan.test.ts`** — add `runPlanCommand` tests: S2-C4 (ready → contracts; needs-clarification → zero + exitCode 2), S2-C5 (re-plan 3→2 leaves 2, no -03), S2-C6 (hint text).
   - Verify: `npx vitest run src/cli/commands/plan.test.ts` green incl. existing answer tests.
6. **Run full verification** — `npm run build` (S2-C1), then `npm test`.

---

## 10. Pitfalls & Warnings

- **Real specs have STRING `sprints`, not objects.** Every spec on disk today stores `sprints` as an array of id strings. `SprintContractSchema.safeParse("sprint-...-1")` fails ⇒ fallback. Your embedded branch is dormant on existing data — that is correct and expected. Do not "fix" it to accept strings.
- **`createSpec` does not accept `sprints`.** To build a fixture with embedded sprints, assign after creation: `(spec as any).sprints = [...]` (the field is `z.array(z.unknown()).optional()` at spec.ts:160).
- **`saveContract` is the ONLY precision gate** — do not duplicate `findPrecisionIssues` in the embedded branch. Let a `saveContract` throw signal "fall back".
- **Whole-set fallback, never partial mix.** If entry N fails safeParse or its `saveContract` throws, abandon the ENTIRE embedded set and use feature-derived for all sprints. The contract's assumption forbids mixing id schemes. Detect via a boolean flag or try/catch around the whole save loop — break/throw out before returning the embedded array.
- **Clear BEFORE materialize, and only for the matching specId.** Other specs' contracts in `.bober/contracts/` must survive (contract assumption). Match on parsed `specId`, not a broad glob.
- **Do NOT re-save the spec in plan.ts.** `runPlanner` already calls `saveSpec` at planner-agent.ts:275. Re-saving would bump `updatedAt` needlessly.
- **Do NOT touch `src/cli/commands/sprint.ts`** — sprint-command selection is Sprint 3 (explicit non-goal/outOfScope).
- **Keep materialization inside the existing `try` in runPlanCommand** so a `materializeContracts`/precision failure sets `process.exitCode = 1` via the existing catch, rather than crashing the CLI.
- **Hint consistency (S2-C6):** `plan answer` says `npx agent-bober run` (plan.ts:290). Make `printPlan` say `run` too (currently `sprint`, plan.ts:171). Assert the exact string you choose in the test so a future divergence fails.
- **`unlink` import:** `src/state/sprint-state.ts:1` currently imports only `readFile, writeFile, readdir` — add `unlink` if you put `clearContractsForSpec` there.
