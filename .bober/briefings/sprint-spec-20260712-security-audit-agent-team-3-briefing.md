# Sprint Briefing: Wire the fail-closed SecurityAuditGate into the pipeline

**Contract:** sprint-spec-20260712-security-audit-agent-team-3
**Generated:** 2026-07-12

> HIGHEST-RISK sprint: the ONLY non-additive change to `src/orchestrator/pipeline.ts`.
> Keep the diff surgical. When `config.security` is absent the pipeline MUST be byte-identical
> (sc-3-4, proven by a deep-equal paired-run test). Anchors below were RE-LOCATED from the live
> file on 2026-07-12 — line numbers are current, not the (drifted) numbers in the architecture doc.

---

## 1. Target Files

### src/orchestrator/pipeline.ts (modify)

The gate attaches at the TOP of the `if (evaluation.passed)` branch, BEFORE the sprint is marked
passed. This is the exact live anchor (architecture cited `:434-437`; live line is the same):

**Insertion point — `pipeline.ts:434-456` (the pass branch head):**
```ts
    if (evaluation.passed) {                                    // :434  ← gate goes at top of this block
      logger.success(`Sprint ${currentContract.contractId} passed all evaluations!`);

      currentContract = updateContractStatus(currentContract, "passed");   // :437  ← must NOT run on block
      currentContract = {
        ...currentContract,
        evaluatorFeedback: evaluation.summary,
      };
      await updateContract(projectRoot, currentContract);

      await appendHistory(projectRoot, {                        // :444  ← sprint-passed; must NOT run on block
        timestamp: new Date().toISOString(),
        event: "sprint-passed",
        phase: "complete",
        sprintId: currentContract.contractId,
        details: { iteration, feedback: evaluation.summary, ...(costUsd?) },
      });
      void emit(projectRoot, config, "sprint-pass", { ... });   // :458
```

**Code-reviewer stage — `pipeline.ts:465-508` (the Promise.race timeout pattern to MIRROR in the gate):**
```ts
      const reviewEnabled = config.codeReview?.enabled !== false;   // :466
      if (reviewEnabled) {
        ...
        const reviewTimeoutMs = config.codeReview?.timeoutMs ?? 300_000;   // :476
        try {
          const review = await Promise.race([
            runCodeReviewer(currentContract, evaluation, projectRoot, config),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("code-review timeout")), reviewTimeoutMs),
            ),
          ]);                                                     // :478-483
          ...
        } catch (err) { logger.warn(`Code review skipped: ...`); ... }   // advisory: never blocks
      }
```

**Documenter stage — `pipeline.ts:510-547` (must be SKIPPED on a block — ADR-6):**
```ts
      const documenterEnabled = config.documenter?.enabled !== false;   // :513
      if (documenterEnabled) { ... Promise.race([runDocumenter(...), timeout]) ... }   // :517-522
      ...
      return { contract: currentContract, evaluation, generatorResult: lastGeneratorResult };  // :557
```
Because the gate sits BEFORE `:437`, a block does an early `continue`/`return` and control NEVER
reaches `:466` (code-review) or `:513` (documenter) — so ADR-6 needs ZERO explicit skip wiring.

**Evaluation-FAILED tail — `pipeline.ts:560-597` (the block path MUST MIRROR this, per generatorNotes):**
```ts
    // Evaluation failed
    currentContract = { ...currentContract, evaluatorFeedback: evaluation.summary };   // :565
    await updateContract(projectRoot, currentContract);
    await appendHistory(projectRoot, {
      event: "evaluation-failed", phase: "rework",
      details: { iteration, feedback: evaluation.summary },
    });                                                             // :571-577
    if (iteration < maxIterations) {
      void emit(projectRoot, config, "sprint-fail-retry", { ..., retryCount: iteration });   // :579-586
    }
    if (iteration >= maxIterations) {                               // :588  ← the needs-rework tail
      currentContract = updateContractStatus(currentContract, "needs-rework");
      await updateContract(projectRoot, currentContract);
      return { contract: currentContract, evaluation };            // :594
    }
    logger.info("Feeding evaluation feedback into next iteration...");
  }  // end for-loop
```
The blocked path re-implements THIS tail (needs-rework at maxIterations, else `continue`), but from
INSIDE `if (evaluation.passed)`. A `continue`/`return` there is legal — you are inside the `for`
loop that starts at `pipeline.ts:241`.

**Feedback channel — `pipeline.ts:252-288` (where security findings must land for sc-3-3/ADR-5):**
```ts
    const evalFeedbackParts: string[] = [];                        // :252
    if (lastEvaluation) {
      for (const result of lastEvaluation.results) {               // built ONLY from lastEvaluation
        ... evalFeedbackParts.push(`[${status}] ${result.evaluator}...`); ...
      }
    }
    // ...later...
    const completedSummaryHandoff = createHandoff({
      ...,
      issues: evalFeedbackParts.length > 0 ? evalFeedbackParts : [],   // :287  ← this reaches the generator
    });
```
CRITICAL: on a security block `evaluation.passed === true`, so `lastEvaluation.results` is all-PASS
and will NOT carry the findings. To satisfy sc-3-3 ("via the same channel evaluator feedback uses")
you must push `renderSecurityFeedback(verdict)` into `evalFeedbackParts` on the NEXT iteration.
Recommended: a loop-scoped `let pendingSecurityFeedback: string[] = []`, set on block, then near
`:275` do `if (pendingSecurityFeedback.length > 0) { evalFeedbackParts.push(...pendingSecurityFeedback); pendingSecurityFeedback = []; }`.
The generator consumes `handoff.issues` at `src/orchestrator/generator-agent.ts:88`:
```ts
${handoff.issues.length > 0 ? `\n# Previous Issues to Fix\n${handoff.issues.join("\n\n")}` : ""}
```

**Imports pipeline.ts already has (reuse — do NOT re-import):**
- `updateContract`, `appendHistory` from `../state/index.js` (`pipeline.ts:50-56`)
- `updateContractStatus` from `../contracts/sprint-contract.js` (`pipeline.ts:17`)
- `emit` from `../telemetry/emit.js` (`pipeline.ts:49`)
- `type EvaluationRunResult` from `../evaluators/registry.js` (`pipeline.ts:19`)
- `type BoberConfig` from `../config/schema.js` (`pipeline.ts:13`)
NEW import needed: `evaluateSecurityGate` + `renderSecurityFeedback` from `./security-gate.js`.

**Imported by (regression surface — see §7):** `pipeline.guidance.test.ts`, `pipeline.pause.test.ts`,
`pipeline-run-id.test.ts`, `worktree.test.ts`, `cli/commands/run.test.ts`, `mcp/run-manager.test.ts`,
`medical/engine.test.ts`, `contract-materialization.test.ts`, plus the two agent integration tests.

**Test file:** `src/orchestrator/pipeline.test.ts` — DOES NOT EXIST (this sprint creates it).

---

### src/orchestrator/security-gate.ts (create)

**Directory pattern:** `src/orchestrator/*.ts` — kebab-case files, named exports, ESM `.js` imports,
`// ── Section ──` box headers (see principles). No default exports.
**Most similar existing file:** `src/orchestrator/security-auditor-agent.ts` (sprint 2) — mirror its
import block and header style.

**Structure template (skeleton — fill in with the patterns in §2):**
```ts
import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import type { SecurityAuditResult, SecurityFinding } from "./security-audit-types.js";
import { runSecurityAudit } from "./security-auditor-agent.js";
import { saveSecurityAudit } from "../state/security-audit-state.js";
import { logger } from "../utils/logger.js";

export interface SecurityGateInput {
  contract: SprintContract;
  evaluation: EvaluationRunResult;
  projectRoot: string;
  config: BoberConfig;
}
export interface SecurityGateVerdict {
  blocked: boolean;
  reason: "critical-finding" | "timeout" | "audit-error" | "clean" | "disabled";
  result?: SecurityAuditResult;
}

export async function evaluateSecurityGate(input: SecurityGateInput): Promise<SecurityGateVerdict> {
  const { contract, evaluation, projectRoot, config } = input;
  // 1. disabled short-circuit — MUST NOT invoke runSecurityAudit
  if (config.security?.enabled !== true) return { blocked: false, reason: "disabled" };
  const timeoutMs = config.security.timeoutMs;   // schema default 300_000
  // 2. Promise.race time-box (mirror pipeline.ts:478-483). NEVER throws.
  let result: SecurityAuditResult;
  try {
    result = await Promise.race([
      runSecurityAudit(contract, evaluation, projectRoot, config),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("security-audit timeout")), timeoutMs)),
    ]);
  } catch (err) {
    const timedOut = err instanceof Error && err.message === "security-audit timeout";
    return { blocked: true, reason: timedOut ? "timeout" : "audit-error" };
  }
  // 3. parse-failure elevation
  if (result.parsed === false) return { blocked: true, reason: "audit-error", result };
  // 4. store persistence — try/catch, MUST NOT alter verdict (sc-3-6). See PITFALL in §9.
  try { await saveSecurityAudit(projectRoot, contract.contractId, result); }
  catch (e) { logger.warn(`Security audit persistence failed: ${...}`); }
  // 5. verdict from result.verdict (derived: review.critical.length > 0)
  return result.verdict === "blocked"
    ? { blocked: true, reason: "critical-finding", result }
    : { blocked: false, reason: "clean", result };
}

// Pure, exported, phrased for a FIXER (sc-3-3).
export function renderSecurityFeedback(verdict: SecurityGateVerdict): string[] { ... }
```

---

### src/orchestrator/security-gate.test.ts (create)

**Most similar existing file:** `src/orchestrator/security-auditor-agent.test.ts` (17.8 KB, sprint 2)
for unit style; `src/orchestrator/code-reviewer-agent.test.ts` for the vi.mock-heavy-agent pattern.
Table-test all five `reason` values (sc-3-1) + the fake-timer timeout test + the store-throw test (sc-3-6).

---

## 2. Patterns to Follow

### Fail-closed verdict derivation (reuse — do NOT reinvent)
**Source:** `src/orchestrator/security-audit-types.ts:52-54`
```ts
export function deriveVerdict(review: ReviewResult): "pass" | "blocked" {
  return review.critical.length > 0 ? "blocked" : "pass";
}
```
**Rule:** The gate reads the ALREADY-DERIVED `result.verdict` (set by `runSecurityAudit` at
`security-auditor-agent.ts:109`); do not re-derive. `parsed===false` already forced `verdict:'blocked'`
inside runSecurityAudit, but the gate must STILL check `result.parsed===false` explicitly to map it to
reason `'audit-error'` (not `'critical-finding'`), per sc-3-1.

### Promise.race time-box (mirror the code-reviewer)
**Source:** `src/orchestrator/pipeline.ts:478-483`
```ts
const review = await Promise.race([
  runCodeReviewer(currentContract, evaluation, projectRoot, config),
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("code-review timeout")), reviewTimeoutMs)),
]);
```
**Rule:** Use the SAME shape in the gate. Distinguish timeout from audit-error by the rejected
Error's message (a unique sentinel like `"security-audit timeout"`) so a race timeout → `'timeout'`
and any other rejection (provider/network/budget from runSecurityAudit) → `'audit-error'`.

### History append (free-form event kind — no schema migration)
**Source:** `src/state/history.ts:38-45` and `pipeline.ts:444-456`
```ts
export const HistoryEntrySchema = z.object({
  timestamp: z.string().datetime(),
  event: z.string().min(1),            // ← free-form; "security-audit-clean"/"-blocked" need NO enum change
  phase: PhaseSchema,                  // ← MUST be one of the PhaseSchema enum (history.ts:26-36)
  sprintId: z.string().optional(),
  details: z.record(z.string(), z.unknown()),   // ← arbitrary payload OK
});
```
**Rule:** Follow the existing `appendHistory(projectRoot, { timestamp, event, phase, sprintId, details })`
call style (e.g. `pipeline.ts:444`). `phase` is a CLOSED enum — use `"complete"` for `security-audit-clean`
and `"rework"` for `security-audit-blocked` (mirrors `evaluation-failed`'s `phase:"rework"` at `:574`).
Any other string throws (`history.ts:87-93`). Blocked payload: `{ reason, critical: N, findings: [...] }`,
findings CAPPED to ~20 to bound event size.

### Extracting path/line from a finding (ReviewFinding has NO top-level path/line)
**Source:** `src/orchestrator/code-reviewer-agent.ts:17-22`
```ts
export interface ReviewFinding {
  description: string;
  evidence: Array<{ path: string; line: number; snippet: string }>;   // ← path/line live HERE
  antiPattern?: string;
  source?: string;
}
```
**Rule:** For both the blocked history event `findings:[{path,line,vulnClass}]` AND `renderSecurityFeedback`,
read `finding.evidence[0]?.path ?? "unknown"` and `finding.evidence[0]?.line ?? 0`. `vulnClass` is an
optional field on `SecurityFinding` (`security-audit-types.ts:23-25`), present only on findings the auditor
classified — guard with `f.vulnClass` before including it.

### Config gating (opt-in, zero-cost when absent)
**Source:** `src/config/schema.ts:210-229`, `633`
```ts
export const SecuritySectionSchema = z.object({
  enabled: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(300_000),
  ...
});
// BoberConfigSchema:  security: SecuritySectionSchema.optional()   (schema.ts:633)
```
**Rule:** The pipeline call site MUST be exactly `if (config.security?.enabled === true) { ...gate... }`.
`config.security` is `undefined` in every existing config → guard is false → not one gate statement runs
(sc-3-4). Do NOT rely on the schema default (`.optional()` means no defaults are injected when the section
is absent).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `runSecurityAudit` | `src/orchestrator/security-auditor-agent.ts:44` | `(contract, evaluation\|null, projectRoot, config, priors?=[]) => Promise<SecurityAuditResult>` | The audit core (sprint 2). Gate wraps THIS in Promise.race. Throws on provider/network error; resolves `parsed:false` on unparseable output. |
| `deriveVerdict` | `src/orchestrator/security-audit-types.ts:52` | `(review: ReviewResult) => "pass"\|"blocked"` | Pure pass/blocked from `review.critical.length`. Already applied inside runSecurityAudit. |
| `saveSecurityAudit` | `src/state/security-audit-state.ts:29` | `(projectRoot, contractId, result) => Promise<void>` | Persists audit markdown to `.bober/security/`. Wrap in gate try/catch (sc-3-6). See §9 double-save pitfall. |
| `appendHistory` | `src/state/history.ts:80` (via `../state/index.js`) | `(projectRoot, HistoryEntry) => Promise<void>` | Append the clean/blocked history events. Validates phase enum + rotates. |
| `updateContract` | `../state/index.js` (`pipeline.ts:52`) | `(projectRoot, contract) => Promise<void>` | Persist mutated contract (evaluatorFeedback, status). |
| `updateContractStatus` | `src/contracts/sprint-contract.js` (`pipeline.ts:17`) | `(contract, status) => SprintContract` | Set status (`"needs-rework"` on a maxIterations block). |
| `emit` | `src/telemetry/emit.ts:69` (`pipeline.ts:49`) | `(projectRoot, config, event, payload) => Promise<void>` | Fire-and-forget telemetry (`void emit(...)`). Optionally mirror `sprint-fail-retry` on block. |
| `SecurityGateVerdict` / `SecurityAuditResult` / `SecurityFinding` / `VulnClass` | `security-audit-types.ts:9-43` | types | Reuse the sprint-1 types; do NOT redefine. |
| `budgetFromMaxUsd` | `src/orchestrator/workflow/budget.ts:148` | `(maxUsd) => Budget\|undefined` | Already used INSIDE runSecurityAudit — gate does not need it. |

Utilities reviewed in `utils/`, `state/`, `orchestrator/` — the gate needs no new helper beyond the two it
exports (`evaluateSecurityGate`, `renderSecurityFeedback`).

---

## 4. Prior Sprint Output

### Sprint 1 (f76ee2e/fc20eae/4ae188f): types + config + store
**Created:** `src/orchestrator/security-audit-types.ts` — exports `VulnClass`, `SecurityFinding`,
`SecurityAuditResult` (`{ review, stack, scannerRan, parsed, verdict }`), `deriveVerdict`.
**Created:** `src/state/security-audit-state.ts` — exports `saveSecurityAudit`/`readSecurityAudit`/`listSecurityAudits`.
**Modified:** `src/config/schema.ts:210-229` — `SecuritySectionSchema` (opt-in, default-off); wired at `:633`.
**Connection:** The gate imports `SecurityAuditResult`/`SecurityFinding` types, reads `config.security.{enabled,timeoutMs}`, and calls `saveSecurityAudit`.

### Sprint 2 (0990156/ddf27bc/e5cf267/40c1488): the audit core
**Created:** `src/orchestrator/security-auditor-agent.ts` — exports `runSecurityAudit(contract, evaluation|null, projectRoot, config, priors?)` and `parseSecurityAuditResult`. Fail-closed: unparseable → `parsed:false` → forced `verdict:'blocked'` (`:104-117`); provider errors REJECT un-swallowed; internally calls `saveSecurityAudit` at `:119`. Curator-role read-only tools (NO bash).
**Created:** `src/orchestrator/stack-knowledge.ts` — `resolveStackSecurityContext`, `ALL_VULN_CLASSES`.
**Connection:** `evaluateSecurityGate` is a THIN wrapper over `runSecurityAudit` — the gate adds only the time-box, the parse/timeout/error→reason mapping, and the store guard. It does NOT re-run the auditor logic.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- ESM everywhere: all imports use `.js` extensions (NodeNext). No CommonJS.
- `import type { ... }` — ESLint `consistent-type-imports` is enforced (hard gate). Import all types type-only.
- Zero type errors + zero lint errors are HARD gates. `strict` mode with `noUnusedLocals`/`noUnusedParameters` — prefix any unused param with `_`.
- Tests collocated (`*.test.ts` next to source). Vitest. Tests create temp dirs, clean up; no fs mocks for real state (but heavy LLM agents ARE mocked — see §6).
- Filesystem state only; no DB. Section headers `// ── Name ──`.

### Architecture Decisions (`.bober/architecture/`)
- **ADR-2 (fail-closed):** gate blocks on critical finding, timeout, OR audit error. Scope veto to the CRITICAL bucket only — never important (nonGoals[2]). Byte-identical when disabled.
- **ADR-5 (findings feed retry):** thread `SecurityFinding` evidence into `evalFeedbackParts` via `renderSecurityFeedback`, phrased for a fixer: `[CRITICAL] <vulnClass>: <desc> at path:line — remediate by...`.
- **ADR-6 (documenter skip):** placing the gate BEFORE `sprint-passed` means control never reaches the documenter (`pipeline.ts:513`) or code-reviewer (`:466`) on a block — zero explicit skip wiring.
- Data Flow 1b (arch doc:286-298) is the block sequence; 1c (arch doc:300-302) is the disabled no-op.

### Non-goals (contract)
Do NOT touch the advisory code-reviewer stage/time-box/position. Do NOT auto-revert the generator's
auto-commit on block (`pipeline.ts:365-378`). Do NOT block on important findings. Do NOT add CLI/scanners/hub (sprints 4-7).

---

## 6. Testing Patterns

### Unit + pipeline-integration pattern (THE gold template)
**Source:** `src/orchestrator/code-reviewer-agent.test.ts:26-104` (mock block) + `:209-252` (drive runSprintCycle)
```ts
// Mock EVERY heavy dep runSprintCycle pulls in, at module scope:
vi.mock("../graph/pipeline-lifecycle.js", () => ({ graphPipelineLifecycle: {
  engineHealth: vi.fn().mockReturnValue("disabled"),
  getGraphClient: vi.fn().mockReturnValue(null), getGraphDeps: vi.fn().mockReturnValue(null) } }));
vi.mock("../state/index.js", () => ({
  ensureBoberDir: vi.fn().mockResolvedValue(undefined),
  updateContract: vi.fn().mockResolvedValue(undefined),
  appendHistory: vi.fn().mockResolvedValue(undefined),   // ← spy on .mock.calls for the event SEQUENCE
  readDesign: vi.fn().mockRejectedValue(new Error("no design")),
  readOutline: vi.fn().mockRejectedValue(new Error("no outline")),
}));
vi.mock("../utils/git.js", () => ({ commitAll: vi.fn().mockResolvedValue("abc1234"),
  getCurrentBranch: vi.fn().mockResolvedValue("bober/test"),
  getChangedFiles: vi.fn().mockResolvedValue(["src/x.ts"]) }));
vi.mock("./curator-agent.js", () => ({ runCurator: vi.fn().mockResolvedValue({ filesAnalyzed: [], patternsFound: 0, utilsIdentified: 0 }) }));
vi.mock("./generator-agent.js", () => ({ runGenerator: vi.fn().mockResolvedValue({ success: true, notes: "ok", filesChanged: ["src/x.ts"], turnsUsed: 3, toolsCalled: [] }) }));
vi.mock("./evaluator-agent.js", () => ({ runEvaluatorAgent: vi.fn().mockResolvedValue({ passed: true, score: 90, results: [], summary: "All passed.", timestamp: "..." }) }));
vi.mock("./code-reviewer-agent.js", async (io) => ({ ...(await io()), runCodeReviewer: vi.fn().mockResolvedValue({ critical: [], important: [], minor: [], approvedAreas: [] }) }));
vi.mock("./documenter-agent.js", async (io) => ({ ...(await io()), runDocumenter: vi.fn().mockResolvedValue({ sprintDocPath: "d.md", relatedDocsUpdated: [], concerns: [] }) }));
// NEW for this sprint — mock the audit core so no real LLM runs:
vi.mock("./security-auditor-agent.js", () => ({ runSecurityAudit: vi.fn() }));

const { runSprintCycle } = await import("./pipeline.js");
const result = await runSprintCycle({ contract, spec, completedContracts: [], projectRoot: tmpRoot, config, projectContext });
expect(result.contract.status).toBe("passed");
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.mock` module factories +
`vi.mocked(fn)` + `vi.clearAllMocks()` in `beforeEach`. **File naming:** `*.test.ts`, collocated.

**Asserting the history event SEQUENCE (for sc-3-2/sc-3-5/sc-3-4):** since `appendHistory` is a mock,
read its calls:
```ts
const { appendHistory } = await import("../state/index.js");
const events = vi.mocked(appendHistory).mock.calls.map((c) => (c[1] as { event: string }).event);
expect(events).toContain("security-audit-blocked");
expect(events).not.toContain("sprint-passed");
// blocked round: heavy stages never run
expect(vi.mocked(runDocumenter)).not.toHaveBeenCalled();
expect(vi.mocked(runCodeReviewer)).not.toHaveBeenCalled();
```
The "does-not-call" assertion is exactly `documenter-agent.test.ts:309`
(`expect(documenterSpy).not.toHaveBeenCalled();`).

### Byte-identity paired-run (sc-3-4 — the safety net)
**Convention source:** deep-equal no-op tests in `pipeline.guidance.test.ts:78-82` (`expect(result).toEqual(handoff)`),
and the disabled-config skip in `documenter-agent.test.ts:285-310`.
```ts
// Run A: config WITHOUT security.  Run B: config with security:{enabled:false} (or also absent).
// Both must produce deep-equal results AND identical appendHistory event sequences.
const runOnce = async (cfg) => {
  vi.clearAllMocks();
  const res = await runSprintCycle({ contract, spec, completedContracts: [], projectRoot, config: cfg, projectContext });
  const events = vi.mocked(appendHistory).mock.calls.map((c) => (c[1] as { event: string }).event);
  return { status: res.contract.status, events };
};
const a = await runOnce(configNoSecurity);
const b = await runOnce(configSecurityDisabled);
expect(a).toEqual(b);
expect(a.events).not.toContain("security-audit-clean");
expect(a.events).not.toContain("security-audit-blocked");
```
The evaluatorNotes DEMAND deep-equal of BOTH the returned object and the FULL event array — not a
few-field spot check. Also assert `vi.mocked(runSecurityAudit)` has ZERO calls in the disabled run.

### Fake-timer timeout unit test (sc-3-1 reason:'timeout')
**Source:** `src/mcp/external-client.test.ts:197-204`
```ts
vi.useFakeTimers();
vi.mocked(runSecurityAudit).mockReturnValueOnce(new Promise(() => {}));  // never resolves
const p = evaluateSecurityGate({ contract, evaluation, projectRoot, config: withTimeout(50) });
await vi.runAllTimersAsync();               // fires the setTimeout rejection
const verdict = await p;
expect(verdict).toEqual({ blocked: true, reason: "timeout" });
vi.useRealTimers();
```
Assert reason is `'timeout'` (NOT `'audit-error'`) — the evaluatorNotes call this out explicitly.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/pipeline.ts` | (self) | HIGH | Only file with a behavior change. All others below run with `config.security` absent → the `if` guard is false → unaffected IFF the guard is exactly `config.security?.enabled === true`. |
| `src/orchestrator/code-reviewer-agent.test.ts` | `runSprintCycle` | medium | Drives the passed branch; must still see `status:"passed"` + `runCodeReviewer` called once (its config has no `security`). |
| `src/orchestrator/documenter-agent.test.ts` | `runSprintCycle` | medium | Same — documenter still runs on the (non-security) passed path. |
| `src/orchestrator/pipeline.guidance.test.ts` / `pipeline.pause.test.ts` / `pipeline-run-id.test.ts` | pipeline helpers | low | Test extracted helpers, not the gate; unaffected. |
| `src/cli/commands/run.test.ts`, `src/mcp/run-manager.test.ts`, `src/mcp/tools/*.test.ts`, `src/orchestrator/worktree.test.ts`, `src/medical/engine.test.ts`, `src/orchestrator/contract-materialization.test.ts` | `runPipeline`/pipeline module | low | Import the module; none set `config.security` → byte-identical path. Verify they still green. |

### Existing Tests That Must Still Pass
- `src/orchestrator/code-reviewer-agent.test.ts` — verifies runCodeReviewer spawns after eval-pass; the gate sits BEFORE it, so with security absent nothing changes. Its `minimalConfig` (`:160-190`) has NO `security` key — good reference for a clean paired-run baseline.
- `src/orchestrator/documenter-agent.test.ts` — verifies documenter runs/skips; must still run on the clean path.
- Every test in the "Files That May Break" table — the whole suite is the sc-3-7 gate.

### Features That Could Be Affected
- **Advisory code-review (Sprint 5)** — shares the passed branch (`pipeline.ts:465-508`). Verify it still runs on a CLEAN security round and is SKIPPED on a block (control never reaches it).
- **Per-sprint documenter** — shares `pipeline.ts:510-547`. Same clean-runs / block-skips check (ADR-6).
- **Retry loop / maxIterations** — shares the eval-failed tail (`:588-597`). The block path mirrors it; verify a block at `iteration >= maxIterations` returns `needs-rework`, and a block with iterations remaining `continue`s.

### Recommended Regression Checks (after implementation)
1. `npm run build` — clean tsc output (sc-3-7).
2. `npm run typecheck` — zero errors.
3. `npx eslint src/orchestrator/security-gate.ts src/orchestrator/pipeline.ts src/orchestrator/security-gate.test.ts src/orchestrator/pipeline.test.ts` — zero errors (consistent-type-imports, no unused).
4. `npx vitest run src/orchestrator/` — the pipeline + agent-integration tests especially.
5. `npx vitest run` — FULL suite green. Any pipeline-test regression is a HARD STOP (stopConditions).

---

## 8. Implementation Sequence

1. **`src/orchestrator/security-gate.ts`** — depends only on sprint-1/2 types + `runSecurityAudit` + `saveSecurityAudit`. Implement `evaluateSecurityGate` (five reasons, never throws, Promise.race time-box, parsed-false elevation, store try/catch) and pure `renderSecurityFeedback`.
   - Verify: `npm run typecheck` clean; the module exports both symbols.
2. **`src/orchestrator/security-gate.test.ts`** — table-test the five reasons (incl. disabled short-circuit asserting `runSecurityAudit` has ZERO calls); fake-timer timeout test; parsed-false→audit-error; store-throw in BOTH clean and blocked (verdict unchanged, sc-3-6); `renderSecurityFeedback` shape (`[CRITICAL] <vulnClass>: ... at path:line`).
   - Verify: `npx vitest run src/orchestrator/security-gate.test.ts` green.
3. **`src/orchestrator/pipeline.ts`** — add the `./security-gate.js` import; declare loop-scoped `let pendingSecurityFeedback: string[] = []` (near `:182`); inject it into `evalFeedbackParts` at `:275`; insert `if (config.security?.enabled === true) { ...gate... }` at the TOP of `if (evaluation.passed)` (`:434`), BEFORE `updateContractStatus(...,"passed")` at `:437`. On block: append `security-audit-blocked`, set `pendingSecurityFeedback` + `currentContract.evaluatorFeedback`, `updateContract`, then mirror the eval-failed tail (needs-rework return at maxIterations, else optional `emit("sprint-fail-retry")` + `continue`). On clean: append `security-audit-clean`, fall through to the existing passed block.
   - Verify: `npm run build` clean; existing pipeline tests still pass.
4. **`src/orchestrator/pipeline.test.ts`** (create) — using the §6 gold template: sc-3-2 (critical finding blocks: no `sprint-passed`, `security-audit-blocked` present with payload, retry/needs-rework, feedback populated); sc-3-3 (findings in next-round `handoff.issues`); sc-3-4 (deep-equal paired run); sc-3-5 (clean proceeds; block skips documenter + code-reviewer — assert `not.toHaveBeenCalled()`).
   - Verify: `npx vitest run src/orchestrator/pipeline.test.ts` green.
5. **Run full verification** — `npm run build`, `npm run typecheck`, `npx eslint ...`, `npx vitest run` (full suite).

---

## 9. Pitfalls & Warnings

- **STORE DOUBLE-SAVE / sc-3-6 tension (READ THIS).** `runSecurityAudit` ALREADY calls `saveSecurityAudit` internally at `security-auditor-agent.ts:119` (un-caught → it rejects on store failure). sc-3-6 requires the GATE to catch a `saveSecurityAudit` throw WITHOUT changing the verdict. The way to satisfy the unit-tested contract: the gate calls `saveSecurityAudit` itself inside its own try/catch AFTER computing the verdict, and the sc-3-6 test MOCKS `runSecurityAudit` (so its internal save never runs) and makes the gate's `saveSecurityAudit` throw. In production this means the audit is written twice (idempotent overwrite) — an accepted redundancy. Do NOT let a store failure become `audit-error`. Do NOT modify `security-auditor-agent.ts` (out of scope).
- **`parsed:false` maps to `audit-error`, NOT `critical-finding`** (sc-3-1). Check `result.parsed === false` before checking `result.verdict`.
- **`phase` is a CLOSED enum** (`history.ts:26-36`). Use `"complete"` for clean, `"rework"` for blocked. Any other value throws at `history.ts:87-93` and fails the round.
- **`ReviewFinding` has NO top-level `path`/`line`** — read `finding.evidence[0]?.path/.line`. Getting this wrong yields `undefined` in the event payload and breaks sc-3-2's per-finding assertion.
- **Feedback must reach `evalFeedbackParts`, not just `currentContract.evaluatorFeedback`.** The generator reads `handoff.issues` (`generator-agent.ts:88`), sourced from `evalFeedbackParts` (`pipeline.ts:287`) — which is built ONLY from `lastEvaluation.results`. Setting `evaluatorFeedback` alone will NOT surface findings (sc-3-3 will fail). Use the loop-scoped `pendingSecurityFeedback` injection.
- **Byte-identity guard must be exactly `config.security?.enabled === true`.** `if (config.security)` (truthy) would run the gate for a `{enabled:false}` config and break sc-3-4. The `let pendingSecurityFeedback = []` init + always-false injection check are behaviorally invisible (no event, no result change) so they do not violate deep-equal — but keep them minimal.
- **The block path is INSIDE `if (evaluation.passed)`** — a `continue` targets the `for` at `pipeline.ts:241` (correct) and a `return` exits `runSprintCycle` (correct). Do NOT accidentally fall through into the `updateContractStatus(...,"passed")` at `:437`.
- **Timeout leaves the LLM call running in the background** (accepted, same as the code-reviewer race at `:478`; cost bounded by `security.budget.maxUsd`). Do NOT try to cancel it.
- **`vi.mock` factories are hoisted** — declare all mocks at module top (as in `code-reviewer-agent.test.ts:26-104`), and `vi.clearAllMocks()` in `beforeEach`, else the paired-run event counts leak across runs.
- **Fake timers:** wrap ONLY the timeout test in `vi.useFakeTimers()`/`vi.useRealTimers()`; leaking fake timers into async fs tests hangs them (see the deliberate real-timer note in `executor.test.ts:9`).
